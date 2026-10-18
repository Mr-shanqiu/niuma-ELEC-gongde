import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { unzipSync, zipSync } from "fflate";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GongdeMySqlConfiguration } from "../storage/mysql-store.js";
import { AppearancePackSigner, loadPackSignerConfiguration } from "../delivery/pack-signer.js";
import type { PrivatePackageStore } from "../delivery/private-package-store.js";
import type { createFreeCreatorRuntime } from "../creators/runtime.js";
import { hasCurrentFreeConsent } from "../creators/consent.js";
import { CREATOR_UPLOAD_LIMITS } from "../creators/policy.js";
import { creatorClientKey, parseCreatorTrustedProxies } from "../creators/client-key.js";
import { FreeDistributionRepository, recordFreeContribution } from "./repository.js";
import { assertExcluded, assertFreeExclusionsReady, seedFreeDistributionExclusions } from "./exclusions.js";
import { FREE_RETENTION_DELETED_ACTION, runFreeRetention } from "./retention.js";
import { stableJson, MAX_DELIVERY_BYTES, DOWNLOAD_WINDOW_MS } from "./codes.js";
import { FreeDistributionError, type Claim, type ClaimItemSnapshot } from "./types.js";
import type { OfficialAppearanceState } from "../domain/appearance-number-query.js";
import type { AppearanceNumberRepository } from "../domain/appearance-numbers.js";
import { OFFICIAL_ASSET_NAMES_ZH } from "../domain/catalog.js";

type CreatorRuntime = ReturnType<typeof createFreeCreatorRuntime>;
type Snapshot = ClaimItemSnapshot & { snapshotRecord?: Record<string, unknown> };
type CatalogItem = { number: string; title: string; description: string; authorPublicNumber: string | null;
  authorDisplayName: string; creatorDouyinNumber: string | null; tags: string[]; previewUrl: string;
  preview?: Record<string, unknown>; firstPublishedAt: string | null; catalogRevision: string;
  deliveryBytesUpperBound: number; canClaim: boolean; snapshot: Snapshot; popularity: number };
interface Installer { platform: "windows" | "macos"; format: string; releaseId: string; version: string;
  bytes: number; sha256: string; publicDownloadUrl: string; perpetualCompatible: boolean; }
export interface DistributionDependencies {
  database: GongdeMySqlConfiguration | null; signer: AppearancePackSigner | null; packages: PrivatePackageStore | null;
  creators: CreatorRuntime; numbers: AppearanceNumberRepository | null;
  officialStates: () => Promise<Record<string, OfficialAppearanceState>>;
  requireAdmin: (request: IncomingMessage) => string;
}
const COOKIE = "gongde_download_session";
const prefix = "/api/gongde/v2";
const getHeader = (r: IncomingMessage, k: string) => typeof r.headers[k] === "string" ? r.headers[k] as string : "";
const token = (r: IncomingMessage) => getHeader(r, "cookie").split(";").map(p => p.trim())
  .find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
const decode = <T>(v: unknown): T => typeof v === "string" ? JSON.parse(v) as T : v as T;
const digest = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");
const parseNumber = (v: string | null, fallback: number, max: number) => {
  if (v === null) return fallback;
  if (!/^\d{1,8}$/u.test(v) || Number(v) > max) throw new FreeDistributionError("page_invalid", 400);
  return Number(v);
};
function installers(): Installer[] {
  const path = process.env.GONGDE_FREE_INSTALLERS_FILE;
  try {
    const raw = JSON.parse(path ? readFileSync(path, "utf8") :
      readFileSync(new URL("../../src/free-distribution/installers.json", import.meta.url), "utf8"));
    if (!Array.isArray(raw.items) || raw.items.length > 12) throw new Error();
    return raw.items.map((entry: Installer) => {
      const url = new URL(entry.publicDownloadUrl);
      if (!["windows", "macos"].includes(entry.platform) || !/^[A-Za-z0-9._-]{1,128}$/u.test(entry.releaseId) ||
          !/^\d+\.\d+\.\d+$/u.test(entry.version) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
          !/^[a-f0-9]{64}$/u.test(entry.sha256) || url.protocol !== "https:" || url.username || url.password ||
          !["download.gongde.zqscreen.cn", "github.com", "gongde-download-1460392746.cos.ap-shanghai.myqcloud.com"].includes(url.hostname) ||
          typeof entry.perpetualCompatible !== "boolean") throw new Error();
      return entry;
    });
  } catch { return []; }
}
function safeCard({ snapshot: _snapshot, popularity: _popularity, ...card }: CatalogItem) { return card; }
async function woodfishExclusionArchive(): Promise<Buffer> {
  const path = fileURLToPath(new URL("../../src/free-distribution/woodfish-sample.nmgpack", import.meta.url));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > CREATOR_UPLOAD_LIMITS.archiveBytes) throw new Error("woodfish_source_invalid");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > CREATOR_UPLOAD_LIMITS.archiveBytes) throw new Error("woodfish_source_invalid");
      chunks.push(Buffer.from(chunk));
    }
    if (bytes !== stat.size) throw new Error("woodfish_source_changed");
  } finally { await file.close(); }
  const names = new Set<string>();
  let unpackedBytes = 0;
  const files = unzipSync(Buffer.concat(chunks), { filter: entry => {
    if (names.has(entry.name) || (entry.name !== "manifest.json" && !/^[a-z0-9][a-z0-9_-]{0,59}\.png$/.test(entry.name))) {
      throw new Error("woodfish_source_invalid");
    }
    names.add(entry.name); unpackedBytes += entry.originalSize;
    if (names.size > CREATOR_UPLOAD_LIMITS.files || entry.originalSize < 1 ||
        entry.originalSize > (entry.name === "manifest.json" ? CREATOR_UPLOAD_LIMITS.manifestBytes : CREATOR_UPLOAD_LIMITS.unpackedBytes) ||
        unpackedBytes > CREATOR_UPLOAD_LIMITS.unpackedBytes) throw new Error("woodfish_source_invalid");
    return true;
  } });
  if (!files["manifest.json"]) throw new Error("woodfish_source_invalid");
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  if (!manifest || manifest.schema_version !== 1 || manifest.id !== "official.woodfish-sample" || "license" in manifest) {
    throw new Error("woodfish_source_invalid");
  }
  // Adapt ONLY this API-owned official source's provenance in memory. The
  // existing exclusion validator still validates PNGs/layout and fingerprints.
  files["manifest.json"] = Buffer.from(JSON.stringify({ ...manifest,
    id: "creator.template", publisher: "community", review_id: "pending" }));
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") }));
}
function safeClaim(c: Claim) {
  return { claimId: c.id, id: c.id, state: c.state, stage: c.stage, limitSnapshot: c.limitSnapshot,
    createdAt: c.createdAt, issuedAt: c.issuedAt, downloadExpiresAt: c.downloadExpiresAt,
    licenseMode: "perpetual", importExpiresAt: null, recoverable: c.retryable,
    error: c.errorCode, errorCode: c.errorCode,
    items: c.items.map(i => ({ number: i.appearanceNumber, catalogRevision: i.catalogRevision,
      title: i.metadataSnapshot.title, description: i.metadataSnapshot.description,
      creatorDouyinNumber: i.metadataSnapshot.creatorDouyinNumber ?? null })),
    bytes: c.artifact?.bytes ?? null, sha256: c.artifact?.sha256 ?? null,
    filename: c.items.length === 1 ? `niuma-appearance-${c.id}.nmgpack` : `niuma-appearances-${c.id}.nmgpacks` };
}
export async function readDistributionBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (getHeader(request, "content-type").split(";")[0].trim() !== "application/json") throw new FreeDistributionError("json_required", 415);
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const data = Buffer.from(chunk); bytes += data.length;
    if (bytes > 16384) throw new FreeDistributionError("request_too_large", 413);
    chunks.push(data);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(); return v;
  } catch { throw new FreeDistributionError("request_invalid", 400); }
}

export function createFreeDistributionRuntime(deps: DistributionDependencies) {
  const enabled = process.env.GONGDE_FREE_DISTRIBUTION_ENABLED === "true";
  const origin = process.env.GONGDE_CREATOR_PUBLIC_ORIGIN || "https://gongde.zqscreen.cn";
  const secure = origin.startsWith("https:");
  const trusted = parseCreatorTrustedProxies(process.env.GONGDE_CREATOR_TRUSTED_PROXY_ADDRESSES);
  const pool: Pool | null = deps.database ? createPool({ ...deps.database, connectionLimit: 4, queueLimit: 32,
    waitForConnections: true, timezone: "Z", charset: "utf8mb4", multipleStatements: false }) : null;
  let repository: FreeDistributionRepository | null = null;
  let seeded = false;
  let closing = false;
  let startup: Promise<void> = Promise.resolve();
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let retentionTask: Promise<void> | null = null;
  let readyCache = { until: 0, value: false };
  const rows = async (executor: Pool | PoolConnection, sql: string, values: unknown[] = []) =>
    (await executor.execute<RowDataPacket[]>(sql, values as never))[0];
  const checkSafety = async (connection: PoolConnection, items: readonly ClaimItemSnapshot[]) => {
    await assertFreeExclusionsReady(connection);
    for (const item of items) {
      if (item.sourceKind === "community") {
        const found = await rows(connection, `SELECT w.state AS work_state, c.state AS author_state, v.state AS version_state,
          v.source_revision, v.approved_metadata_json FROM gongde_creator_works w
          JOIN gongde_creators c ON c.creator_id=w.creator_id JOIN gongde_creator_work_versions v ON v.work_id=w.work_id
          WHERE w.work_id=? AND w.creator_id=? AND v.version_id=? FOR SHARE`, [item.assetId, item.creatorId, item.versionId]);
        if (!found[0] || found[0].work_state === "SUSPENDED" || found[0].author_state !== "ACTIVE" ||
            found[0].version_state !== "APPROVED" || found[0].source_revision !== item.sourceRevision ||
            !hasCurrentFreeConsent(decode(found[0].approved_metadata_json))) return false;
      } else {
        const blocked = await rows(connection, "SELECT blocked FROM gongde_free_official_safety WHERE asset_id=? FOR SHARE", [item.assetId]);
        if (blocked[0]?.blocked) return false;
      }
    }
    return true;
  };
  const validateItems = async (connection: PoolConnection, items: readonly ClaimItemSnapshot[]) => {
    await assertFreeExclusionsReady(connection);
    for (const item of items) {
      const registry = await rows(connection, `SELECT appearance_serial FROM gongde_appearance_numbers
        WHERE source_kind=? AND internal_id=? FOR SHARE`, [item.sourceKind, item.assetId]);
      if (String(registry[0]?.appearance_serial) !== item.appearanceNumber) throw new FreeDistributionError("catalog_revision_changed", 409);
      if (item.sourceKind === "community") {
        const found = await rows(connection, `SELECT w.state, w.published_version_id, c.state AS author_state,
          v.source_revision,v.approved_metadata_json FROM gongde_creator_works w JOIN gongde_creators c ON c.creator_id=w.creator_id
          JOIN gongde_creator_work_versions v ON v.work_id=w.work_id AND v.version_id=w.published_version_id
          WHERE w.work_id=? AND w.creator_id=? AND v.state='APPROVED' FOR SHARE`, [item.assetId,item.creatorId]);
        const record = found[0];
        if (!record || record.state !== "PUBLISHED" || record.author_state !== "ACTIVE" ||
            record.published_version_id !== item.versionId || record.source_revision !== item.sourceRevision ||
            !hasCurrentFreeConsent(decode(record.approved_metadata_json)) ||
            digest([item.versionId, record.source_revision, decode(record.approved_metadata_json)]) !== item.catalogRevision) {
          throw new FreeDistributionError("catalog_revision_changed", 409);
        }
      } else if (!deps.signer || deps.signer.revisions()[item.assetId] !== item.sourceRevision) {
        throw new FreeDistributionError("catalog_revision_changed", 409);
      }
    }
    if (!await checkSafety(connection, items)) throw new FreeDistributionError("appearance_unavailable", 403);
  };
  const retain = () => {
    if (closing || !seeded || !pool || !deps.packages || retentionTask) return;
    retentionTask = runFreeRetention({ pool, deleteFreeArtifact: key => deps.packages!.deleteFreeArtifact(key) })
      .then(result => {
        if (result.status === "timed_out" && retentionTimer) {
          // An external deletion may have an unknown outcome. Stop scheduling
          // until the owner reconciles it; do not blindly repeat that effect.
          clearInterval(retentionTimer); retentionTimer = undefined;
        }
        if (result.scanned || !["completed", "busy"].includes(result.status)) {
          process.stderr.write(JSON.stringify({ scope: "gongde-free", event: "retention_pass",
            status: result.status, scanned: result.scanned, deleted: result.deleted,
            protected: result.protected, failed: result.failed }) + "\n");
        }
      }).catch(() => {
        process.stderr.write(JSON.stringify({ scope: "gongde-free", event: "retention_unavailable" }) + "\n");
      }).finally(() => { retentionTask = null; });
  };
  if (pool && enabled) {
    try {
      const path = process.env.GONGDE_FREE_DISTRIBUTION_SECRET_FILE || process.env.GONGDE_GROUP_BENEFIT_SECRET_FILE;
      const key = path ? readFileSync(path, "utf8").trim() : "";
      if (!/^[a-f0-9]{64}$/iu.test(key)) throw new Error();
      repository = new FreeDistributionRepository(pool, { codeSecret: Buffer.from(key, "hex"), enabled,
        validateItems, checkSafety, deliveryReady: () => readyCache.value });
      startup = (async () => {
        if (!deps.signer) throw new FreeDistributionError("contribution_exclusions_unavailable", 503);
        const root = deps.signer.sourceRoot();
        // The deployed official root contains only the 19 catalog directories.
        // Woodfish is a REQUIRED API archive, never an optional root fallback.
        const woodfish = await woodfishExclusionArchive();
        const temporary = await mkdtemp(join(tmpdir(), "gongde-woodfish-exclusion-"));
        let receipt;
        try {
          const archive = join(temporary, "woodfish-sample.nmgpack");
          await writeFile(archive, woodfish, { mode: 0o600, flag: "wx" });
          receipt = await seedFreeDistributionExclusions(pool, {
          officialDirectories: Object.values(deps.signer.officialCatalog()).map(item => join(root, item.previewDirectory)),
          guideSources: [
            { path: fileURLToPath(new URL("../../src/free-distribution/creator-guide.zip", import.meta.url)), format: "guide" },
            { path: archive, format: "archive" }
          ],
          syntheticSources: [{ path: fileURLToPath(new URL("../../src/free-distribution/ci-owned-exclusion.nmgpack", import.meta.url)), format: "archive" }],
          actor: "startup:free-exclusions"
          });
        } finally { await rm(temporary, { recursive: true, force: true }); }
        if (closing) return;
        seeded = true;
        process.stderr.write(JSON.stringify({ scope: "gongde-free", event: "exclusions_ready",
          sourceCount: receipt.sourceCount, uniqueFingerprints: receipt.uniqueFingerprints }) + "\n");
        if (deps.packages) {
          retentionTimer = setInterval(retain, 15 * 60 * 1000);
          retentionTimer.unref(); retain();
        }
      })().catch(() => {
        seeded = false;
        process.stderr.write(JSON.stringify({ scope: "gongde-free", event: "exclusions_unavailable" }) + "\n");
      });
      deps.creators.setFreeDistributionReadiness?.(async () => { await startup; return seeded && !closing; });
      if (deps.creators.service) deps.creators.setPublicationObserver(async (connection, publication) => {
        await startup;
        if (!seeded || closing) throw new FreeDistributionError("contribution_exclusions_unavailable", 503);
        // Check every publication, including updates/republication whose
        // contribution row already exists. Caller owns this SAME transaction.
        await assertExcluded(connection, publication.contentFingerprint);
        await recordFreeContribution(connection, { workId: publication.workId, creatorId: publication.creatorId,
          contentFingerprint: publication.contentFingerprint });
      });
    } catch { process.stderr.write(JSON.stringify({ scope: "gongde-free", event: "configuration_unavailable" }) + "\n"); }
  }
  const repo = () => { if (!repository) throw new FreeDistributionError("access_service_unavailable", 503); return repository; };
  const ready = async () => {
    await startup;
    if (!seeded || closing) return false;
    if (Date.now() < readyCache.until) return readyCache.value;
    let value = false;
    const published = installers();
    if (repository && deps.signer && deps.packages && ["windows", "macos"].every(platform =>
      published.some(item => item.platform === platform && item.version === "0.9.0" && item.perpetualCompatible))) {
      try { await pool!.query("SELECT id FROM gongde_free_claims LIMIT 0");
        await deps.packages.checkFreeReady(); value = true; } catch { value = false; }
    }
    readyCache = { until: Date.now() + 5000, value }; return value;
  };
  const catalog = async (): Promise<CatalogItem[]> => {
    if (!pool || !deps.signer || !deps.numbers) throw new FreeDistributionError("catalog_unavailable", 503);
    const states = await deps.officialStates();
    const source = deps.signer.officialCatalog();
    const blockedOfficial = new Set((await rows(pool, "SELECT asset_id FROM gongde_free_official_safety WHERE blocked=TRUE"))
      .map(row => String(row.asset_id)));
    const numbers = await deps.numbers.officialNumbers(Object.keys(source));
    const output: CatalogItem[] = [];
    let popularity = new Map<string, number>();
    if (repository) {
      const counts = await rows(pool, `SELECT i.appearance_number, COUNT(*) AS n FROM gongde_free_claim_items i
        JOIN gongde_free_claims c ON c.id=i.claim_id WHERE c.issued_at >= UTC_TIMESTAMP(3) - INTERVAL 7 DAY
        GROUP BY i.appearance_number`);
      popularity = new Map(counts.map(row => [String(row.appearance_number), Number(row.n)]));
    }
    for (const [assetId, item] of Object.entries(source)) {
      if (states[assetId]?.state !== "PUBLISHED" || !numbers[assetId] || blockedOfficial.has(assetId)) continue;
      const number = numbers[assetId];
      const title = OFFICIAL_ASSET_NAMES_ZH[assetId] || String(item.manifest.name || item.manifest.title || assetId);
      const manifest = item.manifest;
      const images = Object.fromEntries([manifest.preview, ...manifest.layers.map(l => l.image)].map(name =>
        [name, `/assets/previews/packs/${item.previewDirectory}/${encodeURIComponent(String(name))}`]));
      const catalogRevision = digest([assetId,item.version,item.revision]);
      const metadata = { title, description: String(manifest.description || "敲一下，让桌面的小伙伴陪你积攒功德。").slice(0,40),
        creatorDouyinNumber: "1872941388" };
      output.push({ number, ...metadata, authorPublicNumber: null, authorDisplayName: "山丘", tags: [],
        previewUrl: String(images[manifest.preview]), preview: { manifest, images }, firstPublishedAt: null,
        catalogRevision, deliveryBytesUpperBound: item.deliveryBytesUpperBound, canClaim: true,
        popularity: popularity.get(number) || 0,
        snapshot: { appearanceNumber:number, sourceKind:"official", assetId, creatorId:null, versionId:item.version,
          sourceRevision:item.revision,catalogRevision,metadataSnapshot:metadata,
          consentSnapshot:{kind:"developer-authorized",revision:item.revision},
          snapshotRecord:{assetRoot:deps.signer.sourceRoot()}, deliveryBytesUpperBound:item.deliveryBytesUpperBound } });
    }
    const works = await rows(pool, `SELECT w.work_id,w.creator_id,w.slug,w.first_published_at,w.published_version_id,
      v.version_label,v.source_revision,v.archive_sha256,v.source_manifest_json,v.validation_json,v.approved_metadata_json,
      v.delivery_bytes_upper_bound,n.appearance_serial,p.serial AS creator_serial,
      (SELECT r.review_id FROM gongde_creator_reviews r WHERE r.version_id=v.version_id AND r.state='APPROVED'
       ORDER BY r.decided_at DESC LIMIT 1) AS review_id
      FROM gongde_creator_works w JOIN gongde_creators c ON c.creator_id=w.creator_id
      JOIN gongde_creator_work_versions v ON v.version_id=w.published_version_id AND v.work_id=w.work_id
      JOIN gongde_appearance_numbers n ON n.source_kind='community' AND n.internal_id=w.work_id
      JOIN gongde_free_creator_numbers p ON p.creator_id=w.creator_id
      WHERE w.state='PUBLISHED' AND c.state='ACTIVE' AND v.state='APPROVED' AND w.published_metadata_json IS NOT NULL
      LIMIT 10000`);
    for (const row of works) {
      const metadata = decode<Record<string, unknown>>(row.approved_metadata_json);
      if (!hasCurrentFreeConsent(metadata as never) || !row.review_id) continue;
      const manifest = decode<{ preview:string; layers:Array<{image:string}> }>(row.source_manifest_json);
      const validation = decode<{ imageNames:string[] }>(row.validation_json);
      const images = Object.fromEntries(validation.imageNames.map(name => [name,
        `/api/gongde/community/versions/${row.published_version_id}/images/${encodeURIComponent(name)}`]));
      const number = String(row.appearance_serial);
      const cardMetadata = { title: String(metadata.titleZh),description:String(metadata.description),
        creatorDouyinNumber:typeof metadata.creatorDouyinNumber === "string" ? metadata.creatorDouyinNumber : null };
      const catalogRevision = digest([row.published_version_id,row.source_revision,metadata]);
      output.push({ number,...cardMetadata, authorPublicNumber:`C${row.creator_serial}`,authorDisplayName:`C${row.creator_serial}`,
        tags: metadata.tags as string[],previewUrl:images[manifest.preview],preview:{manifest,images},
        firstPublishedAt:row.first_published_at ? new Date(row.first_published_at).toISOString() : null,
        catalogRevision,deliveryBytesUpperBound:Number(row.delivery_bytes_upper_bound),canClaim:true,
        popularity:popularity.get(number)||0,
        snapshot:{appearanceNumber:number,sourceKind:"community",assetId:row.work_id,creatorId:row.creator_id,
          versionId:row.published_version_id,sourceRevision:row.source_revision,catalogRevision,
          metadataSnapshot:cardMetadata,consentSnapshot:metadata,
          snapshotRecord:{workId:row.work_id,creatorId:row.creator_id,slug:row.slug,versionId:row.published_version_id,
            revision:row.source_revision,archiveSha256:row.archive_sha256,reviewId:row.review_id},
          deliveryBytesUpperBound:Number(row.delivery_bytes_upper_bound)} });
    }
    return output;
  };
  const queued = new Set<string>();
  let active = 0;
  const schedule = (claimId: string) => {
    if (closing || !seeded || queued.has(claimId) || active >= 2 || !repository) return;
    queued.add(claimId); active++;
    void (async () => {
      try {
        for (let attempt=0;attempt<3;attempt++) {
          if (closing) return;
          const lease = await repo().acquirePreparation(claimId);
          if (!lease) return;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([(async () => {
              if (!deps.signer || !deps.packages) throw new FreeDistributionError("claim_generation_failed",503);
              await repo().setPreparationStage({claimId,leaseToken:lease.leaseToken,stage:"preparing_resources"});
              const issuedAt=new Date();
              const packs: Buffer[]=[];
              for (const item of lease.claim.items as Snapshot[]) {
                if (item.sourceKind === "community") {
                  const selected = item.snapshotRecord as unknown as Parameters<CreatorRuntime["loadFrozenSource"]>[0];
                  const archive=await deps.creators.loadFrozenSource(selected);
                  packs.push(deps.signer.buildCommunity({...selected,archive,downloadId:claimId,issuedAt,licenseMode:"perpetual"}).content);
                } else {
                  const cfg=loadPackSignerConfiguration();
                  const frozen=new AppearancePackSigner({...cfg,assetRoot:String(item.snapshotRecord?.assetRoot || "")});
                  if (frozen.revisions()[item.assetId] !== item.sourceRevision) throw new FreeDistributionError("claim_source_unavailable",503);
                  packs.push(frozen.build({assetId:item.assetId,downloadId:claimId,issuedAt,licenseMode:"perpetual"}).content);
                }
              }
              await repo().setPreparationStage({claimId,leaseToken:lease.leaseToken,stage:"generating_file"});
              const content=packs.length===1 ? packs[0] : Buffer.from(zipSync(Object.fromEntries(packs.map((body,i)=>
                [`appearance-${String(i+1).padStart(2,"0")}.nmgpack`,body])),{level:0,mtime:new Date("2020-01-01T00:00:00Z")}));
              if(content.length>MAX_DELIVERY_BYTES) throw new FreeDistributionError("batch_too_large",413);
              const filename=packs.length===1 ? `niuma-appearance-${claimId}.nmgpack` : `niuma-appearances-${claimId}.nmgpacks`;
              const stored=await deps.packages.prepareFree({claimId,content,filename,
                downloadExpiresAt:new Date(issuedAt.getTime()+DOWNLOAD_WINDOW_MS)});
              await repo().markReady({claimId,leaseToken:lease.leaseToken,issuedAt:issuedAt.toISOString(),artifact:{
                privateObjectKey:stored.objectKey,sha256:stored.sha256,bytes:stored.bytes,filename,
                format:packs.length===1?"nmgpack":"nmgpacks",licenseMode:"perpetual",signerVersion:"license-v2-0.9.0"}});
            })(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new FreeDistributionError("claim_generation_timeout",503)),28000);})]);
            return;
          } catch(error) {
            const code=error instanceof FreeDistributionError ? error.code : "claim_generation_failed";
            const retryable=!/(?:invalid|integrity|signature|too_large|unavailable|suspended|terms|snapshot|revision)/u.test(code);
            try { await repo().markFailed({claimId,leaseToken:lease.leaseToken,errorCode:code,retryable}); } catch { return; }
            if(!retryable || attempt===2) return;
            await new Promise(resolve=>setTimeout(resolve,attempt===0?5000:15000));
            // Automatic retry retains the same claim, never consumes a code permission.
            const claim=await repo().retrySystemClaim(claimId);
            if(claim?.state!=="PREPARING") return;
          } finally { if(timeout) clearTimeout(timeout); }
        }
      } catch { process.stderr.write(JSON.stringify({scope:"gongde-free",event:"preparation_stopped",claimId})+"\n"); }
      finally { queued.delete(claimId);active--; }
    })();
  };
  const consume = async (request:IncomingMessage, operation:string,maximum:number,seconds:number) => {
    const clientKey=creatorClientKey(request,trusted);
    const ipLimit = await repo().consumeLimit({ key: `${operation}:ip:${clientKey}`, limit: maximum, windowMs: seconds*1000 });
    if (!ipLimit.allowed) throw new FreeDistributionError("rate_limited",429,{ retryAfterSeconds:ipLimit.retryAfterSeconds });
    const session=token(request);
    if(session && ["verify","claim","link","report"].includes(operation)) {
      const result = await repo().consumeLimit({ key: `${operation}:session:${session}`,
        limit: operation==="verify" || operation==="claim" ? 10 : operation==="report" ? 5 : 30, windowMs:seconds*1000 });
      if (!result.allowed) throw new FreeDistributionError("rate_limited",429,{ retryAfterSeconds:result.retryAfterSeconds });
    }
  };
  const lockReportClaims = async (connection: PoolConnection, number: string) => {
    // Match retention's claims-before-reports discipline. Locking audit reads
    // after waiting see committed deletion, not an old RR snapshot. No matching
    // tombstone means UNKNOWN existence, never proof that an object survives.
    const related = await rows(connection, `SELECT c.id FROM gongde_free_claims c
      JOIN gongde_free_claim_items i ON i.claim_id=c.id WHERE i.appearance_number=? ORDER BY c.id FOR UPDATE`, [number]);
    const ids = [...new Set(related.map(row => String(row.id)))].sort();
    const deleted = await rows(connection, `SELECT x.id FROM gongde_free_audit x
      JOIN gongde_free_delivery_artifacts a ON a.claim_id=x.subject
      JOIN gongde_free_claim_items i ON i.claim_id=a.claim_id
      WHERE i.appearance_number=? AND x.action=?
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.before_json,'$.privateObjectKey'))=BINARY a.private_object_key
      AND JSON_UNQUOTE(JSON_EXTRACT(x.before_json,'$.sha256'))=a.sha256
      AND JSON_EXTRACT(x.after_json,'$.deleted')=TRUE
      AND JSON_EXTRACT(x.after_json,'$.metadataRetained')=TRUE LIMIT 1 FOR SHARE`,
    [number, FREE_RETENTION_DELETED_ACTION]);
    return { relatedClaims: ids.length, artifactPreviouslyDeleted: deleted.length > 0,
      artifactExistence: deleted.length ? "recorded_deleted" : "unconfirmed" };
  };
  return {
    enabled,
    repository,
    async close(){
      closing = true;
      if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = undefined; }
      await startup;
      await retentionTask;
      await pool?.end();
    },
    async handle(request:IncomingMessage,response:ServerResponse,url:URL):Promise<boolean> {
      if(!url.pathname.startsWith(prefix+"/"))return false;
      const requestId=randomUUID();
      const send=(data:unknown,status=200,extra:Record<string,string>={})=>{
        response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"private, no-store",
          "x-content-type-options":"nosniff",...extra});
        response.end(JSON.stringify({data,serverTime:new Date().toISOString(),requestId}));return true;
      };
      try {
        const path=url.pathname.slice(prefix.length),method=request.method;
        if(!["GET","POST","PATCH","DELETE"].includes(method||""))throw new FreeDistributionError("method_not_allowed",405);
        if(method!=="GET"&&(getHeader(request,"origin")!==origin||getHeader(request,"sec-fetch-site")==="cross-site")) {
          throw new FreeDistributionError("origin_required",403);
        }
        if(path==="/installers"&&method==="GET")return send({items:installers()});
        if(path==="/config"&&method==="GET")return send({enabled,ready:await ready(),maxItems:10,maxBatchBytes:MAX_DELIVERY_BYTES,
          downloadRetentionSeconds:604800,licenseMode:"perpetual",importExpiresAt:null,minPerpetualClientVersion:"0.9.0",
          installers:installers(),developerDouyinNumber:"1872941388",developerDouyinCodeUrl:"/assets/developer-douyin.png"});
        if (enabled) {
          await startup;
          if (!seeded || closing) throw new FreeDistributionError("contribution_exclusions_unavailable", 503);
        }
        if(path==="/appearances"&&method==="GET") {
          if(pool) await consume(request,"public-query",120,60);
          const q=(url.searchParams.get("q")||"").trim().normalize("NFC");
          if(Array.from(q).length>80)throw new FreeDistributionError("search_invalid",400);
          const author=url.searchParams.get("author"),tag=url.searchParams.get("tag");
          const items=(await catalog()).filter(i=>(!q||i.number===q||i.title.includes(q)||i.description.includes(q))&&
            (!author||i.authorPublicNumber===author)&&(!tag||i.tags.includes(tag)));
          const sort=url.searchParams.get("sort")||"newest";
          if(!["newest","popular7d"].includes(sort))throw new FreeDistributionError("sort_invalid",400);
          items.sort((a,b)=>(sort==="popular7d"?b.popularity-a.popularity:0)||
            (Date.parse(b.firstPublishedAt||"")||0)-(Date.parse(a.firstPublishedAt||"")||0)||Number(b.number)-Number(a.number));
          const offset=parseNumber(url.searchParams.get("cursor"),0,100000);
          return send({items:items.slice(offset,offset+24).map(safeCard),nextCursor:offset+24<items.length?String(offset+24):null});
        }
        const numberMatch=/^\/appearances\/(\d{6,9})$/u.exec(path);
        if(numberMatch&&method==="GET") {
          if(pool)await consume(request,"public-query",120,60);
          const item=(await catalog()).find(i=>i.number===numberMatch[1]);
          if(!item)throw new FreeDistributionError("appearance_unavailable",404);return send(safeCard(item));
        }
        if(path==="/access"&&method==="GET") {
          if(!token(request))return send({valid:false,authorized:false});
          let session;
          try { session=await repo().getSession(token(request)); }
          catch(error) {
            if(error instanceof FreeDistributionError && [401,404,410].includes(error.status))return send({valid:false,authorized:false});
            throw error;
          }
          return send({valid:!!session.authorization,authorized:!!session.authorization,...(session.authorization?{
            kind:session.authorization.kind,authorPublicNumber:session.authorization.publicNumber,
            maxItems:session.authorization.limit,expiresAt:session.authorization.expiresAt}:{})});
        }
        if(path==="/access/verify"&&method==="POST") {
          if(!await ready())throw new FreeDistributionError("access_service_unavailable",503);
          await consume(request,"verify",30,600);
          const body=await readDistributionBody(request);
          if(Object.keys(body).some(k=>k!=="code"))throw new FreeDistributionError("request_invalid",400);
          await repo().ensureGroupFamily();
          const result=await repo().verifyCode({code:body.code,sessionToken:token(request)||undefined});
          const a=result.session.authorization!;
          return send({valid:true,authorized:true,kind:a.kind,authorPublicNumber:a.publicNumber,maxItems:a.limit,expiresAt:a.expiresAt},200,
            {"set-cookie":`${COOKIE}=${result.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure?"; Secure":""}`});
        }
        if(path==="/access"&&method==="DELETE") {if(token(request))await repo().clearAccess(token(request));return send({ok:true});}
        if(path==="/claims/appearances"&&method==="POST") {
          const body=await readDistributionBody(request);
          const selected=body.items;
          if(Object.keys(body).some(k=>k!=="items")||!Array.isArray(selected)||selected.length<1||selected.length>10||
            selected.some(i=>!i||typeof i!=="object"||Object.keys(i).some(k=>!["number","catalogRevision"].includes(k))||
              typeof i.number!=="string"||!/^\d{6,9}$/u.test(i.number)||typeof i.catalogRevision!=="string")) {
            throw new FreeDistributionError("selection_empty_or_duplicate",400);
          }
          const key=getHeader(request,"idempotency-key");
          if(!/^[A-Za-z0-9_-]{16,128}$/u.test(key))throw new FreeDistributionError("idempotency_key_invalid",400);
          const existing=await repo().findClaimByKey({sessionToken:token(request),idempotencyKey:key});
          if(existing) {
            const given=selected.map(i=>[i.number,i.catalogRevision]).sort();
            const frozen=existing.items.map(i=>[i.appearanceNumber,i.catalogRevision]).sort();
            if(stableJson(given)!==stableJson(frozen))throw new FreeDistributionError("idempotency_conflict",409);
            if(existing.state==="PREPARING")schedule(existing.id);return send(safeClaim(existing));
          }
          if(!await ready())throw new FreeDistributionError("access_service_unavailable",503);
          await consume(request,"claim",120,60);
          const available=await catalog();
          const snapshots=selected.map(i=>{
            const current=available.find(c=>c.number===i.number);
            if(!current)throw new FreeDistributionError("appearance_unavailable",409);
            if(current.catalogRevision!==i.catalogRevision)throw new FreeDistributionError("catalog_revision_changed",409,
              {items:[{number:i.number,title:current.title}]});return current.snapshot;
          });
          const result=await repo().createClaim({sessionToken:token(request),idempotencyKey:key,items:snapshots});
          schedule(result.claim.id);return send(safeClaim(result.claim),result.created?202:200);
        }
        if(path==="/claims"&&method==="GET")return send({items:(await repo().listSessionClaims({sessionToken:token(request),
          limit:20,offset:parseNumber(url.searchParams.get("cursor"),0,100000)})).map(safeClaim)});
        const claimMatch=/^\/claims\/([A-Za-z0-9_-]{16,128})(?:\/(retry|download-link))?$/u.exec(path);
        if(claimMatch) {
          const claimId=claimMatch[1],action=claimMatch[2];
          if(!action&&method==="GET") {
            const claim=await repo().getClaim({sessionToken:token(request),claimId});
            if(claim.state==="PREPARING")schedule(claimId);return send(safeClaim(claim));
          }
          if(action==="retry"&&method==="POST") {
            const claim=await repo().retryClaim({sessionToken:token(request),claimId});schedule(claimId);return send(safeClaim(claim),202);
          }
          if(action==="download-link"&&method==="POST") {
            await consume(request,"link",240,60);
            // A prior safety refusal durably marks the batch BLOCKED. Restore
            // only an owned, previously signed official batch whose EVERY frozen
            // item is now safe; do not reset its version, issue time or deadline.
            const candidate=await repo().getClaim({sessionToken:token(request),claimId});
            if(pool&&candidate.state==="BLOCKED"&&candidate.errorCode==="claim_blocked"&&candidate.artifact&&
              candidate.items.some(item=>item.sourceKind==="official")) {
              const connection=await pool.getConnection();
              try {
                await connection.beginTransaction();
                const owner=await rows(connection,"SELECT session_id FROM gongde_free_claims WHERE id=?",[claimId]);
                if(owner[0])await rows(connection,"SELECT id FROM gongde_free_download_sessions WHERE id=? FOR UPDATE",[owner[0].session_id]);
                const locked=await rows(connection,"SELECT state,error_code,revision,download_expires_at FROM gongde_free_claims WHERE id=? FOR UPDATE",[claimId]);
                const current=locked[0];
                if(current?.state==="BLOCKED"&&current.error_code==="claim_blocked"&&current.download_expires_at&&
                  new Date(current.download_expires_at).getTime()>Date.now()&&await checkSafety(connection,candidate.items)) {
                  await connection.execute("UPDATE gongde_free_claims SET state='READY',revision=revision+1,error_code=NULL,retryable=FALSE WHERE id=? AND state='BLOCKED'",[claimId]);
                  await connection.execute(`INSERT INTO gongde_free_audit(id,actor,action,subject,before_json,after_json,reason,request_id,occurred_at)
                    VALUES(?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[randomUUID().replaceAll("-",""),"delivery","official-safety.claim-restored",claimId,
                    JSON.stringify({state:"BLOCKED",revision:Number(current.revision)}),JSON.stringify({state:"READY",revision:Number(current.revision)+1}),
                    "全部冻结条目的安全状态已恢复，保留原签发时间、版本与服务器重下载期限",requestId]);
                }
                await connection.commit();
              } catch(error){await connection.rollback();throw error;}finally{connection.release();}
            }
            const {claim}=await repo().getDownloadAuthorization({sessionToken:token(request),claimId});
            const artifact=claim.artifact!;
            if(!deps.packages)throw new FreeDistributionError("claim_generation_failed",503);
            const filename=claim.items.length===1?`niuma-appearance-${claim.id}.nmgpack`:`niuma-appearances-${claim.id}.nmgpacks`;
            const link=await deps.packages.downloadFree({objectKey:artifact.privateObjectKey,filename,bytes:artifact.bytes,
              sha256:artifact.sha256,downloadExpiresAt:new Date(claim.downloadExpiresAt!)});return send(link);
          }
        }
        if((path==="/creator/promotion"||path==="/creator/stats")&&method==="GET") {
          const account=await deps.creators.requireAccount(request);
          if(path.endsWith("promotion"))return send(await repo().getCreatorPromotion(account.creatorId));
          const family=await repo().getCreatorFamily(account.creatorId);
          return send(family?await repo().getStats({familyId:family.id}):{readyClaims:0,workClaims:0,verifiedCodes:0,installerRequests:null});
        }
        if(path==="/reports"&&method==="POST") {
          await consume(request,"report",5,3600);
          const body=await readDistributionBody(request);
          if(!["copyright","harmful","malicious","other"].includes(String(body.category))||
            typeof body.description!=="string"||Array.from(body.description.trim().normalize("NFC")).length<10||
            Array.from(body.description.trim().normalize("NFC")).length>1000||
            (body.evidenceText!==undefined&&(typeof body.evidenceText!=="string"||Array.from(body.evidenceText).length>1000))||
            (body.contact!==undefined&&(typeof body.contact!=="string"||Array.from(body.contact).length>120))) {
            throw new FreeDistributionError("report_invalid",400);
          }
          const item=(await catalog()).find(i=>i.number===body.number);
          if(!item)throw new FreeDistributionError("appearance_unavailable",404);
          const id=randomUUID().replaceAll("-","");
          const connection=await pool!.getConnection();
          try {
            await connection.beginTransaction();
            const forensic=await lockReportClaims(connection,item.number);
            await connection.execute(`INSERT INTO gongde_free_reports(id,appearance_number,version_id,category,description,
              evidence,contact,state,created_at) VALUES(?,?,?,?,?,?,?,'OPEN',UTC_TIMESTAMP(3))`,
              [id,item.number,item.snapshot.versionId,String(body.category),String(body.description).trim().normalize("NFC"),
                typeof body.evidenceText==="string"?body.evidenceText.trim().normalize("NFC"):null,
                typeof body.contact==="string"?body.contact.trim().normalize("NFC"):null]);
            await connection.execute(`INSERT INTO gongde_free_audit(id,actor,action,subject,before_json,after_json,reason,request_id,occurred_at)
              VALUES(?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[randomUUID().replaceAll("-",""),"public-report","report-created",id,
              "null",JSON.stringify({state:"OPEN",...forensic}),
              forensic.artifactPreviouslyDeleted?"Report received after recorded artifact deletion; no preservation claim":"Report received under related claim locks",requestId]);
            await connection.commit();
          } catch(error){await connection.rollback();throw error;}finally{connection.release();}
          return send({reportId:id},201);
        }
        if(path.startsWith("/admin/")) {
          const actor=deps.requireAdmin(request);
          const safetyRecord=(assetId:string,row?:RowDataPacket)=>({assetId,blocked:Boolean(row?.blocked),
            revision:row?Number(row.revision):0,reason:row?.reason??null,updatedBy:row?.updated_by??null,
            updatedAt:row?.updated_at?new Date(row.updated_at).toISOString():null});
          if(path==="/admin/official-safety"&&method==="GET") {
            if(!pool||!deps.signer)throw new FreeDistributionError("service_unavailable",503);
            const states=await rows(pool,"SELECT asset_id,blocked,revision,reason,updated_by,updated_at FROM gongde_free_official_safety");
            const byAsset=new Map(states.map(row=>[String(row.asset_id),row]));
            const items=Object.keys(deps.signer.revisions()).sort().map(assetId=>safetyRecord(assetId,byAsset.get(assetId)));
            return send({items,total:items.length});
          }
          const safetyMatch=/^\/admin\/official-safety\/([A-Za-z0-9._-]{1,80})\/(block|unblock)$/u.exec(path);
          if(safetyMatch&&method==="POST") {
            if(!pool||!deps.signer)throw new FreeDistributionError("service_unavailable",503);
            const assetId=safetyMatch[1],blocked=safetyMatch[2]==="block";
            if(!deps.signer.revisions()[assetId])throw new FreeDistributionError("not_found",404);
            const body=await readDistributionBody(request);
            const reason=typeof body.reason==="string"?body.reason.trim().normalize("NFC"):"";
            if(Object.keys(body).some(key=>!["requireCurrentRevision","reason"].includes(key))||
              !Number.isSafeInteger(body.requireCurrentRevision)||(body.requireCurrentRevision as number)<0||
              Array.from(reason).length<5||Array.from(reason).length>1000)throw new FreeDistributionError("request_invalid",400);
            const connection=await pool.getConnection();
            try {
              await connection.beginTransaction();
              // Serialize first-write absence with a unique-key insert before
              // locking: concurrent revision-0 writes must not both succeed.
              await connection.execute(`INSERT INTO gongde_free_official_safety(asset_id,blocked,revision,reason,updated_by,updated_at)
                VALUES(?,FALSE,0,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE asset_id=asset_id`,[assetId,reason,actor]);
              const state=(await rows(connection,"SELECT asset_id,blocked,revision,reason,updated_by,updated_at FROM gongde_free_official_safety WHERE asset_id=? FOR UPDATE",[assetId]))[0];
              if(Number(state.revision)!==body.requireCurrentRevision||Boolean(state.blocked)===blocked)throw new FreeDistributionError("revision_conflict",409);
              const before=safetyRecord(assetId,state);
              await connection.execute("UPDATE gongde_free_official_safety SET blocked=?,revision=revision+1,reason=?,updated_by=?,updated_at=UTC_TIMESTAMP(3) WHERE asset_id=?",[blocked,reason,actor,assetId]);
              const after=safetyRecord(assetId,(await rows(connection,"SELECT asset_id,blocked,revision,reason,updated_by,updated_at FROM gongde_free_official_safety WHERE asset_id=?",[assetId]))[0]);
              await connection.execute(`INSERT INTO gongde_free_audit(id,actor,action,subject,before_json,after_json,reason,request_id,occurred_at)
                VALUES(?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[randomUUID().replaceAll("-",""),actor,blocked?"official-safety.block":"official-safety.unblock",assetId,
                  JSON.stringify(before),JSON.stringify(after),reason,requestId]);
              await connection.commit();return send(after);
            } catch(error){await connection.rollback();throw error;}finally{connection.release();}
          }
          if(path==="/admin/reports"&&method==="GET") {
            const page=Math.max(1,parseNumber(url.searchParams.get("page"),1,100000));
            const perPage=Math.max(1,parseNumber(url.searchParams.get("perPage"),25,100));
            const state=url.searchParams.get("state")||"OPEN";
            if(!["OPEN","INVESTIGATING","RESOLVED","DISMISSED"].includes(state))throw new FreeDistributionError("request_invalid",400);
            if(!pool)throw new FreeDistributionError("service_unavailable",503);
            const result=await rows(pool,`SELECT * FROM gongde_free_reports WHERE state=? ORDER BY created_at DESC,id DESC LIMIT ${perPage} OFFSET ${(page-1)*perPage}`,[state]);
            const total=await rows(pool,"SELECT COUNT(*) AS n FROM gongde_free_reports WHERE state=?",[state]);
            return send({items:result.map(r=>({id:r.id,number:String(r.appearance_number),versionId:r.version_id,
              category:r.category,description:r.description,evidence:r.evidence,contact:r.contact,state:r.state,
              createdAt:new Date(r.created_at).toISOString(),resolvedAt:r.resolved_at?new Date(r.resolved_at).toISOString():null,
              resolution:r.resolution})),total:Number(total[0].n)});
          }
          const resolveMatch=/^\/admin\/reports\/([a-f0-9]{32})\/resolve$/u.exec(path);
          if(resolveMatch&&method==="POST") {
            const body=await readDistributionBody(request);
            const reason=typeof body.reason==="string"?body.reason.trim().normalize("NFC"):"";
            if(Array.from(reason).length<5||Array.from(reason).length>1000||Object.keys(body).some(k=>k!=="reason"))throw new FreeDistributionError("request_invalid",400);
            if(!pool)throw new FreeDistributionError("service_unavailable",503);
            const connection=await pool.getConnection();
            try {
              await connection.beginTransaction();
              const identity=await rows(connection,"SELECT appearance_number FROM gongde_free_reports WHERE id=?",[resolveMatch[1]]);
              if(!identity[0])throw new FreeDistributionError("not_found",404);
              const forensic=await lockReportClaims(connection,String(identity[0].appearance_number));
              const report=await rows(connection,"SELECT id,state FROM gongde_free_reports WHERE id=? FOR UPDATE",[resolveMatch[1]]);
              if(!report[0])throw new FreeDistributionError("not_found",404);
              if(report[0].state==="RESOLVED")throw new FreeDistributionError("revision_conflict",409);
              await connection.execute("UPDATE gongde_free_reports SET state='RESOLVED',resolution=?,resolved_at=UTC_TIMESTAMP(3) WHERE id=?",[reason,resolveMatch[1]]);
              await connection.execute(`INSERT INTO gongde_free_audit(id,actor,action,subject,before_json,after_json,reason,request_id,occurred_at)
                VALUES(?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[randomUUID().replaceAll("-",""),actor,"report-resolve",resolveMatch[1],
                  JSON.stringify({state:report[0].state}),JSON.stringify({state:"RESOLVED",...forensic}),reason,requestId]);
              await connection.commit();return send({ok:true});
            } catch(error){await connection.rollback();throw error;}finally{connection.release();}
          }
          if(path==="/admin/group-code"&&method==="GET") {await ready();return send(await repo().getGroupCode());}
          if(path==="/admin/creators"&&method==="GET")return send(await repo().listCreators({page:parseNumber(url.searchParams.get("page"),1,100000),perPage:25}));
          if(path==="/admin/claims"&&method==="GET")return send(await repo().listClaims({from:url.searchParams.get("from")||undefined,
            to:url.searchParams.get("to")||undefined,state:url.searchParams.get("state")||undefined,
            page:parseNumber(url.searchParams.get("page"),1,100000),perPage:parseNumber(url.searchParams.get("perPage"),25,100)}));
          if(path==="/admin/stats"&&method==="GET")return send(await repo().getStats({from:url.searchParams.get("from")||undefined,to:url.searchParams.get("to")||undefined}));
          const creatorMatch=/^\/admin\/creators\/([a-f0-9]{32})\/promotion$/u.exec(path);
          if(creatorMatch&&method==="GET")return send(await repo().getCreatorPromotion(creatorMatch[1]));
          const mutation=/^\/admin\/(code-families|contributions)\/([A-Za-z0-9._-]{1,80})\/(pause|resume|rotate|revoke|restore)$/u.exec(path);
          if(mutation&&method==="POST") {
            const body=await readDistributionBody(request);
            if(Object.keys(body).some(k=>!["revision","reason"].includes(k)))throw new FreeDistributionError("request_invalid",400);
            const options={expectedRevision:body.revision as number,reason:body.reason as string,actor,requestId};
            if(mutation[1]==="code-families")return send(await repo().mutateFamily({...options,familyId:mutation[2],action:mutation[3] as never}));
            if(!["revoke","restore"].includes(mutation[3]))throw new FreeDistributionError("request_invalid",400);
            return send(await repo().mutateContribution({...options,workId:mutation[2],action:mutation[3] as "revoke"|"restore"}));
          }
        }
        throw new FreeDistributionError("not_found",404);
      } catch(error) {
        const code=error instanceof FreeDistributionError?error.code:
          typeof (error as {code?:unknown})?.code==="string" && /^(?:creator|access|claim)_[a-z_]+$/u.test(String((error as {code:string}).code)) ?
          (error as {code:string}).code:"service_unavailable";
        const status=error instanceof FreeDistributionError?error.status:
          typeof (error as {status?:unknown})?.status==="number"?(error as {status:number}).status:503;
        const details=error instanceof FreeDistributionError?error.details||{}:{};
        response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"private, no-store",
          ...(status===429?{"retry-after":String(details.retryAfterSeconds||60)}:{})});
        const messages:Record<string,string>={
          access_code_invalid:"领取码不正确，请检查后重试。",
          access_code_expired:"领取码已更新，请获取最新码。",
          access_code_paused:"此领取码暂不可用，请使用其他有效码。",
          access_required:"请先输入有效领取码。",
          rate_limited:"操作过于频繁，请稍后重试；权限没有被消费。",
          selection_limit_exceeded:"当前码的权限不足，请调整所选形象。",
          selection_empty_or_duplicate:"请选择一至十个不同形象。",
          catalog_revision_changed:"形象版本已更新，请重新预览后确认。",
          appearance_unavailable:"该形象暂不可领取，请重新选择。",
          claim_blocked:"此批包含暂不可分发的作品，无法下载。",
          claim_expired:"本批的服务器重下载入口已到期，已下载文件仍可永久使用。",
          claim_not_found:"该领取记录不存在或无法访问，请在原浏览器打开。",
          claim_not_ready:"形象包正在准备，请稍后再试。",
          idempotency_conflict:"本次确认的选择发生变化，请重新确认。",
          revision_conflict:"状态已发生变化，请刷新后再操作。",
          report_invalid:"请检查问题类型及说明字数。",
          request_invalid:"请求内容不完整，请刷新后重试。",
          origin_required:"请从本站页面提交此操作。"
        };
        response.end(JSON.stringify({error:code,message:messages[code]||"服务暂不可用，请稍后重试；选择及已有领取记录仍保留。",details,requestId}));return true;
      }
    }
  };
}
