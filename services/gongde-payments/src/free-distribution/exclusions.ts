import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { creatorSourceContentFingerprint } from "../creators/content-fingerprint.js";
import { CREATOR_UPLOAD_LIMITS as LIMITS } from "../creators/policy.js";
import { FreeDistributionError } from "./types.js";

// Reserved control row, not a content digest. No migration or weaker content
// hashing scheme: readiness and content rows use the existing exclusion table.
const CONTROL = "0".repeat(64);
const READY = "gongde-free-exclusions-v1:ready:";
const PENDING = "gongde-free-exclusions-v1:pending:";
const TEMPLATE_OWNER = { creatorId: "0".repeat(32), slug: "exclusion-source" };
// One distribution database per service process. A durable receipt from a
// previous process is never sufficient. Even a failed initial DB write closes
// this process's gate; only the latest successful local attempt can reopen it.
let processSeedAttempt = 0;
let processReadyReason: string | null = null;
type Owner = typeof TEMPLATE_OWNER;
type Kind = "SAMPLE" | "SYNTHETIC";

export interface LocalExclusionSource {
  // Explicit server-local path, never obtained from an HTTP request body.
  path: string;
  format: "directory" | "archive" | "guide";
  // Bound creator archives need their original owner; templates do not.
  owner?: Owner;
}
export interface SeedFreeExclusionsInput {
  // Populate from Object.values(signer.officialCatalog()).map(item =>
  // join(signer.sourceRoot(), item.previewDirectory)); catalog values are slugs.
  // No signing key is read here and no production asset root is guessed.
  officialDirectories: readonly string[];
  guideSources: readonly LocalExclusionSource[];
  // Required explicitly. [] declares that no synthetic sources exist in scope;
  // callers must supply all KNOWN VALID acceptance packs, not negative fixtures.
  syntheticSources: readonly LocalExclusionSource[];
  actor: string;
}
export interface FreeExclusionsSeedReceipt {
  seedDigest: string;
  sourceCount: number;
  uniqueFingerprints: number;
  inserted: number;
}
function unavailable(code = "contribution_exclusions_unavailable"): never {
  throw new FreeDistributionError(code, 503);
}
async function select(connection: PoolConnection, sql: string, values: string[] = []): Promise<RowDataPacket[]> {
  return (await connection.execute<RowDataPacket[]>(sql, values))[0];
}

// Caller owns the publication transaction. Shared row lock survives until its
// commit, so seed/manual-exclusion writes cannot race a contribution insertion.
export async function assertFreeExclusionsReady(connection: PoolConnection): Promise<void> {
  const row = (await select(connection,
    "SELECT reason FROM gongde_free_excluded_fingerprints WHERE content_fingerprint = ? FOR SHARE", [CONTROL]))[0];
  if (!processReadyReason || !row || row.reason !== processReadyReason ||
      !new RegExp(`^${READY}[a-f0-9]{64}$`).test(row.reason)) unavailable();
}

// Despite its short integration name, this is a REJECTION guard: it throws
// when content IS excluded. Submit and publication callers share this exact
// check; no title heuristic, no provider call, no contribution/rights mutation.
// Caller owns the transaction and must propagate failure (publication rolls
// back). The fingerprint must come from the real normalized source validator.
export async function assertExcluded(connection: PoolConnection, contentFingerprint: string): Promise<void> {
  if (typeof contentFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(contentFingerprint) || contentFingerprint === CONTROL) {
    throw new FreeDistributionError("contribution_fingerprint_invalid", 400);
  }
  await assertFreeExclusionsReady(connection);
  const excluded = await select(connection,
    "SELECT kind FROM gongde_free_excluded_fingerprints WHERE content_fingerprint = ? FOR SHARE", [contentFingerprint]);
  if (excluded.length) throw new FreeDistributionError("contribution_sample_excluded", 409);
}

// Manual exclusion writes must take the same lock as bulk seeding. Creating a
// control row never marks an empty or manually populated table ready.
export async function lockFreeExclusionControl(connection: PoolConnection): Promise<string> {
  await connection.execute(`INSERT INTO gongde_free_excluded_fingerprints
    (content_fingerprint, kind, reason, created_at) VALUES (?, 'SAMPLE', ?, ?)
    ON DUPLICATE KEY UPDATE content_fingerprint = content_fingerprint`, [CONTROL, PENDING + "unseeded", new Date()]);
  return String((await select(connection,
    "SELECT reason FROM gongde_free_excluded_fingerprints WHERE content_fingerprint = ? FOR UPDATE", [CONTROL]))[0].reason);
}

async function transaction<T>(pool: Pool, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string })?.code !== "ER_LOCK_DEADLOCK" || attempt >= 2) throw error;
    } finally { connection.release(); }
  }
}

async function readLocalFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) unavailable("contribution_exclusion_source_invalid");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) unavailable("contribution_exclusion_source_invalid");
    // Bound the read even if a source is modified after stat. Sources should be
    // immutable release inputs; no directory/archive is ever rewritten here.
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total !== stat.size) unavailable("contribution_exclusion_source_changed");
    return bytes.subarray(0, total);
  } finally { await file.close(); }
}

async function directoryFingerprint(path: string, official: boolean, owner: Owner): Promise<string> {
  if (!isAbsolute(path)) unavailable("contribution_exclusion_source_invalid");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable("contribution_exclusion_source_invalid");
  const directory = await realpath(path);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length < 2 || entries.length > LIMITS.files || entries.some(entry =>
    !entry.isFile() || entry.isSymbolicLink() || (entry.name !== "manifest.json" &&
      !/^[a-z0-9][a-z0-9_-]{0,59}\.png$/.test(entry.name)))) unavailable("contribution_exclusion_source_invalid");
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const data = await readLocalFile(join(directory, entry.name),
      entry.name === "manifest.json" ? LIMITS.manifestBytes : LIMITS.unpackedBytes - total);
    total += data.length;
    if (total > LIMITS.unpackedBytes) unavailable("contribution_exclusion_source_invalid");
    files[entry.name] = data;
  }
  if (!files["manifest.json"]) unavailable("contribution_exclusion_source_invalid");
  if (official) {
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
    if (!manifest || typeof manifest !== "object" || "license" in manifest) unavailable("contribution_exclusion_source_invalid");
    // Only identity/provenance fields change IN MEMORY to pass the creator
    // validator. PNGs, preview, canvas, schema and action geometry are untouched.
    files["manifest.json"] = Buffer.from(JSON.stringify({ ...manifest,
      id: "creator.template", publisher: "community", review_id: "pending" }));
  }
  return creatorSourceContentFingerprint(Buffer.from(zipSync(files,
    { level: 6, mtime: new Date("2020-01-01T00:00:00Z") })), owner);
}

function archiveFingerprint(archive: Buffer, owner: Owner, allowSignedFixture: boolean): string {
  if (!allowSignedFixture) return creatorSourceContentFingerprint(archive, owner);
  let total = 0;
  const names = new Set<string>();
  const files = unzipSync(archive, { filter: file => {
    if (names.has(file.name) || (file.name !== "manifest.json" &&
        !/^[a-z0-9][a-z0-9_-]{0,59}\.png$/.test(file.name))) unavailable("contribution_exclusion_source_invalid");
    names.add(file.name);
    total += file.originalSize;
    if (names.size > LIMITS.files || file.originalSize < 1 ||
        file.originalSize > (file.name === "manifest.json" ? LIMITS.manifestBytes : LIMITS.unpackedBytes) ||
        total > LIMITS.unpackedBytes) unavailable("contribution_exclusion_source_invalid");
    return true;
  } });
  if (!files["manifest.json"]) unavailable("contribution_exclusion_source_invalid");
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  if (!manifest || typeof manifest !== "object") unavailable("contribution_exclusion_source_invalid");
  if (manifest.schema_version !== 2 || !manifest.license) return creatorSourceContentFingerprint(archive, owner);
  // ONLY explicitly inventoried, server-owned synthetic fixtures may use this
  // adapter. It makes no signature-validity claim and never changes an anchor,
  // the source archive, or the ordinary creator upload validator. Schema 2 has
  // the Schema 1 action layout; drop delivery identity/license IN MEMORY.
  const { license: _license, ...source } = manifest;
  files["manifest.json"] = Buffer.from(JSON.stringify({ ...source, schema_version: 1,
    id: "creator.template", publisher: "community", review_id: "pending" }));
  return creatorSourceContentFingerprint(Buffer.from(zipSync(files,
    { level: 6, mtime: new Date("2020-01-01T00:00:00Z") })), TEMPLATE_OWNER);
}

async function sourceFingerprints(source: LocalExclusionSource, allowSignedFixture = false): Promise<string[]> {
  if (!source || typeof source.path !== "string") unavailable("contribution_exclusion_source_invalid");
  const owner = source.owner ?? TEMPLATE_OWNER;
  if (source.format === "directory") return [await directoryFingerprint(source.path, false, owner)];
  if (source.format === "archive") return [archiveFingerprint(await readLocalFile(source.path, LIMITS.archiveBytes), owner, allowSignedFixture)];
  if (source.format !== "guide") unavailable("contribution_exclusion_source_invalid");
  const archive = await readLocalFile(source.path, LIMITS.archiveBytes * 2);
  let total = 0;
  let count = 0;
  // Extract ONLY bounded sample inputs in memory; README/prompt never execute.
  const samples = unzipSync(archive, { filter: file => {
    const needed = file.name === "example.nmgpack" || file.name === "manifest.json" ||
      /^[a-z0-9][a-z0-9_-]{0,59}\.png$/.test(file.name);
    if (!needed) return false;
    total += file.originalSize;
    if (++count > LIMITS.files + 1 || file.originalSize < 1 ||
      file.originalSize > (file.name === "manifest.json" ? LIMITS.manifestBytes : LIMITS.archiveBytes) ||
      total > LIMITS.unpackedBytes + LIMITS.archiveBytes) unavailable("contribution_exclusion_source_invalid");
    return true;
  } });
  if (!samples["example.nmgpack"] || !samples["manifest.json"]) unavailable("contribution_exclusion_source_invalid");
  const example = creatorSourceContentFingerprint(Buffer.from(samples["example.nmgpack"]), owner);
  delete samples["example.nmgpack"];
  return [example, creatorSourceContentFingerprint(Buffer.from(zipSync(samples,
    { level: 6, mtime: new Date("2020-01-01T00:00:00Z") })), owner)];
}

/** Await at startup BEFORE attaching the publication observer/accepting uploads.
 * Owns its DB transactions; never invoke inside a caller-owned transaction.
 * Every attempt first durably closes the gate, including a failed refresh. A
 * crashed attempt remains pending. Competing attempts cannot publish stale
 * receipts: only the latest token can atomically install the ready marker.
 * Existing content exclusions are additive; no historical rights are revoked.
 */
export async function seedFreeDistributionExclusions(pool: Pool, input: SeedFreeExclusionsInput): Promise<FreeExclusionsSeedReceipt> {
  const attempt = ++processSeedAttempt;
  processReadyReason = null;
  const token = PENDING + randomBytes(16).toString("hex");
  try {
    await transaction(pool, async connection => {
      await lockFreeExclusionControl(connection);
      await connection.execute("UPDATE gongde_free_excluded_fingerprints SET reason = ? WHERE content_fingerprint = ?", [token, CONTROL]);
    });
    if (!input || typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 80 ||
      !Array.isArray(input.officialDirectories) || input.officialDirectories.length < 1 ||
      !Array.isArray(input.guideSources) || input.guideSources.length < 1 || !Array.isArray(input.syntheticSources) ||
      input.officialDirectories.length + input.guideSources.length + input.syntheticSources.length > 256) unavailable("contribution_exclusion_configuration_invalid");
    const fingerprints = new Map<string, { kind: Kind; reason: string }>();
    const add = (value: string, kind: Kind, reason: string) => {
      if (!/^[a-f0-9]{64}$/.test(value) || value === CONTROL) unavailable("contribution_exclusion_source_invalid");
      // Receipt/audit reasons contain no local paths or raw manifest metadata.
      if (!fingerprints.has(value)) fingerprints.set(value, { kind, reason });
    };
    for (const directory of input.officialDirectories) add(await directoryFingerprint(directory, true, TEMPLATE_OWNER), "SAMPLE", "official_asset_not_creator_contribution");
    for (const source of input.guideSources) for (const value of await sourceFingerprints(source)) add(value, "SAMPLE", "guide_example_not_creator_contribution");
    for (const source of input.syntheticSources) for (const value of await sourceFingerprints(source, true)) add(value, "SYNTHETIC", "synthetic_acceptance_not_creator_contribution");
    const ordered = [...fingerprints.entries()].sort(([a], [b]) => a.localeCompare(b));
    const seedDigest = createHash("sha256").update("gongde-free-exclusion-seed-v1\0")
      .update(JSON.stringify(ordered)).digest("hex");
    const receipt = await transaction(pool, async connection => {
      if (await lockFreeExclusionControl(connection) !== token) unavailable("contribution_exclusion_seed_superseded");
      let inserted = 0;
      const now = new Date();
      for (const [value, entry] of ordered) {
        // Includes revoked rows: exclusions do not silently migrate/rewrite
        // historical rights. Main owner must resolve historical conflicts.
        const used = await select(connection,
          "SELECT work_id FROM gongde_free_contributions WHERE content_fingerprint = ? FOR UPDATE", [value]);
        if (used.length) throw new FreeDistributionError("contribution_exclusion_requires_revocation", 409);
        const existing = await select(connection,
          "SELECT kind FROM gongde_free_excluded_fingerprints WHERE content_fingerprint = ? FOR UPDATE", [value]);
        if (existing.length) continue;
        await connection.execute(`INSERT INTO gongde_free_excluded_fingerprints
          (content_fingerprint, kind, reason, created_at) VALUES (?, ?, ?, ?)`, [value, entry.kind, entry.reason, now]);
        await connection.execute(`INSERT INTO gongde_free_audit
          (id, actor, action, subject, before_json, after_json, reason, request_id, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomBytes(16).toString("hex"), input.actor,
          "fingerprint.exclude", value, "null", JSON.stringify(entry), entry.reason, null, now]);
        inserted += 1;
      }
      await connection.execute("UPDATE gongde_free_excluded_fingerprints SET reason = ? WHERE content_fingerprint = ?", [READY + seedDigest, CONTROL]);
      return { seedDigest, sourceCount: input.officialDirectories.length + input.guideSources.length + input.syntheticSources.length,
        uniqueFingerprints: ordered.length, inserted };
    });
    if (attempt !== processSeedAttempt) unavailable("contribution_exclusion_seed_superseded");
    processReadyReason = READY + seedDigest;
    return receipt;
  } catch (error) {
    if (error instanceof FreeDistributionError) throw error;
    // No raw paths, source text or SQL/provider details escape the boundary.
    unavailable();
  }
}
