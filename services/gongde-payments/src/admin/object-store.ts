import { createHash, randomBytes } from "node:crypto";
import COS from "cos-nodejs-sdk-v5";
import { loadRuntimeSecret } from "../payments/runtime-secret.js";

export type AdminFileKind = "appearance" | "installer";

export interface AdminFileRecord {
  id: string;
  name: string;
  kind: AdminFileKind;
  size: number;
  lastModified: string | null;
  url: string;
}

export interface AdminDownloadSummary {
  total: number;
  period: number;
  byFile: Array<{ fileName: string; total: number; period: number }>;
  /** Per-platform totals. A platform with no counted events reports 0, not null. */
  byPlatform: Record<"macos" | "windows", { total: number; period: number }>;
  /** Earliest counted event, or null when nothing has been counted yet. */
  earliest: string | null;
  /** Events recorded before the counting start, kept but reported separately. */
  legacyCount: number;
  /** Events whose file name is not in the current registry: counted by the store, not attributable. */
  unattributed: number;
}

export interface InstallerManifestSummary {
  version: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

type CosClient = Pick<COS, "getBucket" | "putObject" | "deleteObject"> & {
  getObject(
    params: { Bucket: string; Region: string; Key: string },
    callback: (error: unknown, data: { Body?: Buffer | string }) => void
  ): void;
};

/**
 * Publication state: the whole set of published official appearances.
 *
 * `revision` versions *this object*, not any appearance's material. Material
 * revisions come from the pack signer and do not change when something is
 * published, so they cannot detect a stale publication write.
 */
export interface PublicationState {
  revision: number;
  publishedAssetIds: string[];
  firstPublishedAt: Record<string, string>;
  updatedAt: string | null;
}

/**
 * A cross-process mutex around one read-modify-write of the publication object.
 *
 * COS `PUT` accepts no `If-Match`, so "compare, then overwrite" cannot be made
 * atomic by the storage API alone; two writers that both read before either
 * writes would lose one update. `x-cos-forbid-overwrite` only refuses to create
 * over an existing key, which every write after the first one does. The state
 * therefore carries its own revision and the whole cycle runs under a lock all
 * instances share. An in-process mutex would look identical in a single-process
 * test and be wrong the moment two instances serve traffic, so it is not used.
 */
export type PublicationLock = <T>(operation: () => Promise<T>) => Promise<T>;

/** The write's expected revision was already superseded by another writer. */
export class PublicationConflict extends Error {
  constructor(readonly revision: number) {
    super("publication_revision_conflict");
  }
}
/** Publication state could not be read or written; no partial success. */
export class PublicationUnavailable extends Error {
  constructor(readonly reason: string) {
    super("publication_unavailable");
  }
}
/** The shared lock could not be taken in time; the caller did nothing. */
export class PublicationBusy extends Error {
  constructor() {
    super("publication_busy");
  }
}

interface Configuration {
  bucket: string;
  region: string;
  publicBaseUrl: string;
  secretId: string;
  secretKey: string;
}

const prefixes: Record<AdminFileKind, string> = {
  appearance: "appearance-packs/",
  installer: ""
};
const appearanceCatalogStateKey = `${prefixes.appearance}catalog-state.json`;

function isKind(value: string | null): value is AdminFileKind {
  return value === "appearance" || value === "installer";
}

/**
 * COS reports a missing key as an SDK error, not as an empty body.
 *
 * Only these codes mean "the object does not exist". Any other failure is a
 * read problem and must not be mistaken for a first write.
 */
function isAbsentObject(error: unknown): boolean {
  const value = error as { code?: unknown; statusCode?: unknown; error?: { Code?: unknown; code?: unknown } } | null;
  const code = String(value?.code ?? value?.error?.Code ?? value?.error?.code ?? "");
  if (code === "NoSuchKey" || code === "NotFound") return true;
  return Number(value?.statusCode) === 404;
}

function allowedName(kind: AdminFileKind, name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(name)) return false;
  return kind === "appearance" ? name.endsWith(".nmgpack") : /\.(?:dmg|exe)$/iu.test(name);
}

export function parseAdminFileIdentity(kindValue: string | null, nameValue: string | null): { kind: AdminFileKind; name: string } {
  if (!isKind(kindValue)) throw new Error("admin_file_kind_invalid");
  const name = nameValue?.trim() ?? "";
  if (!allowedName(kindValue, name)) throw new Error("admin_file_name_invalid");
  return { kind: kindValue, name };
}

export function loadAdminObjectStoreConfiguration(source: NodeJS.ProcessEnv = process.env): Configuration | null {
  const enabled = Boolean(
    source.GONGDE_COS_SECRET_ID || source.GONGDE_COS_SECRET_ID_FILE ||
    source.GONGDE_COS_SECRET_KEY || source.GONGDE_COS_SECRET_KEY_FILE ||
    source.TENCENT_CLOUD_SECRET_ID || source.TENCENT_CLOUD_SECRET_ID_FILE ||
    source.TENCENT_CLOUD_SECRET_KEY || source.TENCENT_CLOUD_SECRET_KEY_FILE
  );
  if (!enabled) return null;
  const bucket = source.GONGDE_COS_BUCKET?.trim() || "gongde-download-1460392746";
  const region = source.GONGDE_COS_REGION?.trim() || "ap-shanghai";
  const publicBaseUrl = (source.GONGDE_COS_PUBLIC_BASE_URL?.trim() || "https://download.gongde.zqscreen.cn").replace(/\/+$/u, "");
  if (!/^[a-z0-9-]+-\d+$/u.test(bucket) || !/^[a-z0-9-]+$/u.test(region) || !/^https:\/\//u.test(publicBaseUrl)) {
    throw new Error("admin_object_store_configuration_invalid");
  }
  return {
    bucket,
    region,
    publicBaseUrl,
    secretId: loadRuntimeSecret(
      source,
      source.GONGDE_COS_SECRET_ID || source.GONGDE_COS_SECRET_ID_FILE ? "GONGDE_COS_SECRET_ID" : "TENCENT_CLOUD_SECRET_ID",
      source.GONGDE_COS_SECRET_ID || source.GONGDE_COS_SECRET_ID_FILE ? "GONGDE_COS_SECRET_ID_FILE" : "TENCENT_CLOUD_SECRET_ID_FILE"
    ),
    secretKey: loadRuntimeSecret(
      source,
      source.GONGDE_COS_SECRET_KEY || source.GONGDE_COS_SECRET_KEY_FILE ? "GONGDE_COS_SECRET_KEY" : "TENCENT_CLOUD_SECRET_KEY",
      source.GONGDE_COS_SECRET_KEY || source.GONGDE_COS_SECRET_KEY_FILE ? "GONGDE_COS_SECRET_KEY_FILE" : "TENCENT_CLOUD_SECRET_KEY_FILE"
    )
  };
}

export class AdminObjectStore {
  readonly #cos: CosClient;

  constructor(private readonly configuration: Configuration, client?: CosClient) {
    this.#cos = client ?? new COS({ SecretId: configuration.secretId, SecretKey: configuration.secretKey }) as unknown as CosClient;
  }

  publicUrl(kind: AdminFileKind, name: string): string {
    const key = `${prefixes[kind]}${name}`;
    return `${this.configuration.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async #listObjects(prefix: string): Promise<Array<{ Key?: string; Size?: string; LastModified?: string }>> {
    const contents: Array<{ Key?: string; Size?: string; LastModified?: string }> = [];
    let marker: string | undefined;
    do {
      const result = await new Promise<{ Contents?: Array<{ Key?: string; Size?: string; LastModified?: string }>; IsTruncated?: string | boolean; NextMarker?: string }>((resolve, reject) => {
        this.#cos.getBucket({ Bucket: this.configuration.bucket, Region: this.configuration.region, Prefix: prefix, Marker: marker, MaxKeys: 1000 }, (error, data) => error ? reject(error) : resolve(data));
      });
      contents.push(...(result.Contents ?? []));
      marker = result.IsTruncated === true || result.IsTruncated === "true" ? result.NextMarker : undefined;
    } while (marker);
    return contents;
  }

  async list(kind: AdminFileKind): Promise<AdminFileRecord[]> {
    const prefix = prefixes[kind];
    return (await this.#listObjects(prefix)).flatMap((item) => {
      const key = item.Key ?? "";
      if (!key.startsWith(prefix) || key === prefix) return [];
      const name = key.slice(prefix.length);
      if (!allowedName(kind, name)) return [];
      return [{
        id: `${kind}:${name}`,
        name,
        kind,
        size: Number(item.Size ?? "0"),
        lastModified: item.LastModified ?? null,
        url: this.publicUrl(kind, name)
      }];
    });
  }

  async put(kind: AdminFileKind, name: string, body: Buffer, contentType: string): Promise<AdminFileRecord> {
    const key = `${prefixes[kind]}${name}`;
    await new Promise<void>((resolve, reject) => {
      this.#cos.putObject({
        Bucket: this.configuration.bucket,
        Region: this.configuration.region,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType
      }, (error) => error ? reject(error) : resolve());
    });
    return {
      id: `${kind}:${name}`,
      name,
      kind,
      size: body.length,
      lastModified: new Date().toISOString(),
      url: this.publicUrl(kind, name)
    };
  }

  async delete(kind: AdminFileKind, name: string): Promise<void> {
    // Missing reference/retention records never establish that an installer is
    // unused. Keep compatibility, release, rollback, and historical artifacts.
    // Enforce this before any COS request, including for non-HTTP callers.
    if (kind === "installer") throw new Error("installer_retention_required");
    await new Promise<void>((resolve, reject) => {
      this.#cos.deleteObject({
        Bucket: this.configuration.bucket,
        Region: this.configuration.region,
        Key: `${prefixes[kind]}${name}`
      }, (error) => error ? reject(error) : resolve());
    });
  }

  // Regenerate DOWNLOADS.json for one release pair.
  //
  // Two things this must not do. It must not invent a trust state: the old
  // version stamped every file "unsigned" without looking at it, which was
  // wrong for the Developer ID + notarized macOS build and for the Authenticode
  // Windows build. It also must not replace the published list with just these
  // two entries: the live manifest carries historical releases and earlier
  // builds of the current one, and silently dropping them removes the fallback
  // downloads people are still pointed at.
  //
  // So the existing manifest is read first, entries for these two names are
  // replaced in place, and everything else is carried over untouched. The
  // signature and notarization of a file are properties of the file, so they
  // come from the existing entry when there is one; a file with no recorded
  // state is published as "unknown" rather than being guessed at.

  // Read the currently published manifest, completely, before anything is
  // written.
  //
  // This must not degrade to "no known entries". A transient COS error, corrupt
  // JSON, or an unexpected shape says nothing about whether history exists, and
  // continuing from an empty list is exactly how the published list gets
  // replaced by the two files being regenerated. So every failure here aborts
  // before any write, and an entry that cannot be carried over faithfully is a
  // failure rather than something to filter out silently.
  async #readPublishedManifest(): Promise<Array<Record<string, unknown>>> {
    let previous: { Body?: Buffer | string };
    try {
      previous = await new Promise<{ Body?: Buffer | string }>((resolve, reject) => {
        this.#cos.getObject({
          Bucket: this.configuration.bucket,
          Region: this.configuration.region,
          Key: "DOWNLOADS.json"
        }, (error, data) => error ? reject(error) : resolve(data));
      });
    } catch {
      throw new Error("admin_manifest_unavailable");
    }
    const raw = Buffer.isBuffer(previous.Body) ? previous.Body.toString("utf8") : String(previous.Body ?? "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("admin_manifest_invalid");
    }
    if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { files?: unknown }).files)) {
      throw new Error("admin_manifest_invalid");
    }
    const files = (parsed as { files: unknown[] }).files;
    const seen = new Set<string>();
    for (const file of files) {
      // An entry is carried over verbatim, so it has to be something the merged
      // manifest and the checksum file can both describe.
      if (file === null || typeof file !== "object") throw new Error("admin_manifest_invalid");
      const entry = file as Record<string, unknown>;
      if (typeof entry.name !== "string" || entry.name.length === 0) throw new Error("admin_manifest_invalid");
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error("admin_manifest_invalid");
      // Two entries under one name would make the merged list ambiguous and
      // would let one of them be overwritten without saying so.
      if (seen.has(entry.name)) throw new Error("admin_manifest_invalid");
      seen.add(entry.name);
    }
    return files as Array<Record<string, unknown>>;
  }

  async publishInstallerManifest(version: string, windowsVersion = version): Promise<InstallerManifestSummary> {
    if (!/^\d+\.\d+\.\d+$/u.test(version) || !/^\d+\.\d+\.\d+$/u.test(windowsVersion)) throw new Error("admin_release_version_invalid");
    const definitions = [
      { name: `niuma-merit-macos-${version}.dmg`, type: "application/x-apple-diskimage",
        platform: "macOS", architecture: "universal2-arm64-x86_64", notarization: "unknown", version },
      { name: `niuma-merit-windows-${windowsVersion}-setup.exe`, type: "application/vnd.microsoft.portable-executable",
        platform: "Windows", architecture: "x86_64", notarization: "unknown", version: windowsVersion }
    ] as const;

    // Fails closed: no manifest or checksum is written unless the previous
    // published list was read in full.
    const previousFiles = await this.#readPublishedManifest();
    const previousByName = new Map(previousFiles.map((file) => [String(file.name), file]));

    const files = await Promise.all(definitions.map(async (definition) => {
      const object = await new Promise<{ Body?: Buffer | string }>((resolve, reject) => {
        this.#cos.getObject({
          Bucket: this.configuration.bucket,
          Region: this.configuration.region,
          Key: definition.name
        }, (error, data) => error ? reject(error) : resolve(data));
      });
      const body = Buffer.isBuffer(object.Body) ? object.Body : Buffer.from(object.Body ?? "");
      if (body.length === 0 || body.length > 80 * 1024 * 1024) throw new Error("admin_installer_invalid");
      const digest = createHash("sha256").update(body).digest("hex");
      const previous = previousByName.get(definition.name);
      // Trust state describes the bytes. Only carry a recorded state over when
      // the recorded digest is the same bytes we just read; a rebuilt file
      // under the same name is a different artifact and must not inherit
      // "notarized" from its predecessor.
      const sameBytes = previous !== undefined && previous.sha256 === digest;
      return {
        ...definition,
        signature: sameBytes && typeof previous.signature === "string" ? previous.signature : "unknown",
        notarization: sameBytes && typeof previous.notarization === "string" ? previous.notarization : "unknown",
        bytes: body.length,
        sha256: digest,
        url: this.publicUrl("installer", definition.name)
      };
    }));

    const replaced = new Set<string>(files.map((file) => file.name));
    const merged = [
      ...files,
      ...previousFiles.filter((file) => !replaced.has(String(file.name)))
    ];
    const checksum = Buffer.from(merged
      .filter((file) => typeof file.sha256 === "string" && typeof file.name === "string")
      .map((file) => `${String(file.sha256)}  ${String(file.name)}`).join("\n") + "\n");
    const manifest = Buffer.from(JSON.stringify({
      baseUrl: `${this.configuration.publicBaseUrl}/`,
      generatedAt: new Date().toISOString(),
      files: merged
    }, null, 2) + "\n");
    const putMetadata = (name: string, body: Buffer, contentType: string) => new Promise<void>((resolve, reject) => {
      this.#cos.putObject({
        Bucket: this.configuration.bucket,
        Region: this.configuration.region,
        Key: name,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType
      }, (error) => error ? reject(error) : resolve());
    });
    await putMetadata("SHA256SUMS.txt", checksum, "text/plain; charset=utf-8");
    await putMetadata("DOWNLOADS.json", manifest, "application/json; charset=utf-8");
    return { version, files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) };
  }

  async publishedAssetIds(defaultIds: readonly string[]): Promise<string[]> {
    try {
      const result = await new Promise<{ Body?: Buffer | string }>((resolve, reject) => {
        this.#cos.getObject({
          Bucket: this.configuration.bucket,
          Region: this.configuration.region,
          Key: appearanceCatalogStateKey
        }, (error: unknown, data: { Body?: Buffer | string }) => error ? reject(error) : resolve(data));
      });
      const raw = Buffer.isBuffer(result.Body) ? result.Body.toString("utf8") : String(result.Body ?? "");
      const parsed = JSON.parse(raw) as { publishedAssetIds?: unknown };
      if (!Array.isArray(parsed.publishedAssetIds)) return [...defaultIds];
      const allowed = new Set(defaultIds);
      return [...new Set(parsed.publishedAssetIds.filter((item): item is string => typeof item === "string" && allowed.has(item)))];
    } catch {
      return [...defaultIds];
    }
  }

  // Number lookup must never interpret a missing/invalid publication object as
  // "all published". Keep the historic purchase API behavior separate.
  async publishedAssetIdsStrict(defaultIds: readonly string[]): Promise<string[]> {
    return (await this.publicationStateStrict(defaultIds)).publishedAssetIds;
  }

  async publicationStateStrict(defaultIds: readonly string[]): Promise<PublicationState> {
    let state: PublicationState | null;
    try {
      state = await this.readPublication();
    } catch {
      throw new Error("appearance_publication_unavailable");
    }
    if (!state) throw new Error("appearance_publication_unavailable");
    const allowed = new Set(defaultIds);
    // The legacy object had no `firstPublishedAt`; the one real publication it
    // recorded was wealth-button, timestamped by its `updatedAt`. Keep that fact
    // instead of backdating every asset to the rollout.
    const firstPublishedAt = { ...state.firstPublishedAt };
    if (Object.keys(state.firstPublishedAt).length === 0 && state.updatedAt &&
      state.publishedAssetIds.includes("official.wealth-button")) {
      firstPublishedAt["official.wealth-button"] = state.updatedAt;
    }
    return {
      ...state,
      publishedAssetIds: state.publishedAssetIds.filter((id) => allowed.has(id)),
      firstPublishedAt: Object.fromEntries(
        Object.entries(firstPublishedAt).filter(([id, date]) => allowed.has(id) && Number.isFinite(Date.parse(date))))
    };
  }

  /**
   * Read the publication object, or `null` when it has never been written.
   *
   * Only a genuine "absent" result is `null`. A network error, a permission
   * failure or a corrupt body throws, because treating any of those as "no
   * publication object" would silently republish the default list.
   */
  async readPublication(): Promise<PublicationState | null> {
    let raw: string;
    try {
      const result = await new Promise<{ Body?: Buffer | string }>((resolve, reject) => {
        this.#cos.getObject({ Bucket: this.configuration.bucket, Region: this.configuration.region,
          Key: appearanceCatalogStateKey }, (error, data) => error ? reject(error) : resolve(data));
      });
      raw = Buffer.isBuffer(result.Body) ? result.Body.toString("utf8") : String(result.Body ?? "");
    } catch (error) {
      if (isAbsentObject(error)) return null;
      throw new PublicationUnavailable("publication_read_failed");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new PublicationUnavailable("publication_corrupt"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PublicationUnavailable("publication_corrupt");
    }
    const value = parsed as Record<string, unknown>;
    const ids = value.publishedAssetIds;
    if (!Array.isArray(ids) || ids.some((item) => typeof item !== "string")) {
      throw new PublicationUnavailable("publication_corrupt");
    }
    const revision = value.revision;
    // An object written before this field existed carries no version. It is
    // accepted as revision 0 so the first locked write can upgrade it, but a
    // non-integer revision is corruption, not "old".
    if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
      throw new PublicationUnavailable("publication_corrupt");
    }
    const firstPublishedAt: Record<string, string> = {};
    const stored = value.firstPublishedAt;
    if (stored !== undefined) {
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
        throw new PublicationUnavailable("publication_corrupt");
      }
      for (const [id, date] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) {
          throw new PublicationUnavailable("publication_corrupt");
        }
        firstPublishedAt[id] = date;
      }
    }
    return {
      revision: typeof revision === "number" ? revision : 0,
      publishedAssetIds: [...new Set(ids as string[])],
      firstPublishedAt,
      updatedAt: typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : null
    };
  }

  async #writePublication(expectedRevision: number, next: Omit<PublicationState, "revision">): Promise<PublicationState> {
    const state: PublicationState = { revision: expectedRevision + 1, ...next };
    const body = Buffer.from(JSON.stringify({
      version: 1,
      revision: state.revision,
      publishedAssetIds: state.publishedAssetIds,
      firstPublishedAt: state.firstPublishedAt,
      updatedAt: state.updatedAt
    }));
    try {
      await new Promise<void>((resolve, reject) => {
        this.#cos.putObject({
          Bucket: this.configuration.bucket,
          Region: this.configuration.region,
          Key: appearanceCatalogStateKey,
          Body: body,
          ContentLength: body.length,
          ContentType: "application/json"
        }, (error) => error ? reject(error) : resolve());
      });
    } catch {
      // A failed write is not a success and not a conflict: the caller cannot
      // claim the new state, and must re-read before trying again.
      throw new PublicationUnavailable("publication_write_failed");
    }
    return state;
  }

  /**
   * Publish or un-publish one appearance as one atomic read-modify-write.
   *
   * `expectedRevision` is the publication revision the operator saw. A stale
   * value is a conflict, never a silent overwrite — including when the two
   * writes target *different* appearances, because both change the same object.
   *
   * The revision check happens inside `lock`, and the invariant that makes it
   * sufficient is: the only writer of this object is this method, and it never
   * writes without holding the lock. Nothing may re-introduce an unlocked
   * write, whatever its API looks like.
   */
  async setPublished(
    assetIds: readonly string[],
    assetId: string,
    published: boolean,
    expectedRevision: number,
    lock: PublicationLock
  ): Promise<PublicationState> {
    return lock(async () => {
      const current = await this.readPublication();
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) throw new PublicationConflict(revision);
      // With no object yet, the effective state is the documented read
      // fallback: the default list is published. Seeding from it keeps the
      // write consistent with what the operator was just shown; seeding from
      // an empty set would un-publish everything else as a side effect.
      const set = new Set(current?.publishedAssetIds ?? assetIds);
      if (published) set.add(assetId); else set.delete(assetId);
      const ordered = assetIds.filter((id) => set.has(id));
      const firstPublishedAt = { ...(current?.firstPublishedAt ?? {}) };
      const now = new Date().toISOString();
      if (published && !Object.prototype.hasOwnProperty.call(firstPublishedAt, assetId)) {
        firstPublishedAt[assetId] = now;
      }
      return this.#writePublication(revision, {
        publishedAssetIds: ordered,
        firstPublishedAt,
        updatedAt: now
      });
    });
  }

  /** Publication state for callers that accept the documented default list. */
  async publicationState(defaultIds: readonly string[]): Promise<PublicationState> {
    return (await this.readPublicationFor(defaultIds)) ?? {
      revision: 0, publishedAssetIds: [...defaultIds], firstPublishedAt: {}, updatedAt: null
    };
  }

  /**
   * Read the publication object for a caller that has a default list.
   *
   * Unlike `readPublication`, a corrupt or unreadable object yields `null`
   * here: the historic purchase and catalogue paths keep their documented
   * "fall back to the default list" behaviour. Publication writes use
   * `readPublication`, which fails closed instead.
   */
  async readPublicationFor(defaultIds: readonly string[]): Promise<PublicationState | null> {
    try {
      const state = await this.readPublication();
      const allowed = new Set(defaultIds);
      if (!state) return null;
      // The legacy object had no `firstPublishedAt`; the one real publication
      // it recorded was wealth-button, timestamped by its `updatedAt`. Keep that
      // fact instead of backdating every asset to the rollout.
      const firstPublishedAt = { ...state.firstPublishedAt };
      if (Object.keys(state.firstPublishedAt).length === 0 && state.updatedAt &&
        state.publishedAssetIds.includes("official.wealth-button")) {
        firstPublishedAt["official.wealth-button"] = state.updatedAt;
      }
      return {
        ...state,
        firstPublishedAt: Object.fromEntries(
          Object.entries(firstPublishedAt).filter(([id, date]) =>
            allowed.has(id) && Number.isFinite(Date.parse(date)))
        ),
        publishedAssetIds: state.publishedAssetIds.filter((id) => allowed.has(id))
      };
    } catch {
      return null;
    }
  }


  async recordDownload(name: string, platform: string, downloadedAt: Date): Promise<void> {
    const key = `${prefixes.installer}.download-events/${downloadedAt.getTime()}-${randomBytes(6).toString("hex")}-${name}`;
    const body = Buffer.from(JSON.stringify({ name, platform, downloadedAt: downloadedAt.toISOString() }));
    await new Promise<void>((resolve, reject) => {
      this.#cos.putObject({
        Bucket: this.configuration.bucket,
        Region: this.configuration.region,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: "application/json"
      }, (error) => error ? reject(error) : resolve());
    });
  }

  async summarizeDownloads(
    createdFrom: Date,
    createdTo: Date,
    options: { countedSince?: Date | null; registeredNames?: readonly string[] } = {}
  ): Promise<AdminDownloadSummary> {
    const eventPrefix = `${prefixes.installer}.download-events/`;
    // Only the events prefix is listed. Every download writes one object that is
    // never deleted, so this listing grows with traffic forever; the page caches
    // the result briefly rather than repeating it on each tab switch. A daily
    // rollup object is the next step if the listing becomes slow, but that needs
    // an atomic counter this store does not have, so it is not done here.
    const records = (await this.#listObjects(eventPrefix)).flatMap((item) => {
      const key = item.Key ?? "";
      if (!key.startsWith(eventPrefix)) return [];
      const match = key.slice(eventPrefix.length).match(/^(\d+)-[a-f0-9]+-(.+)$/u);
      if (!match) return [];
      const downloadedAt = new Date(Number(match[1]));
      if (!Number.isFinite(downloadedAt.getTime())) return [];
      // The platform comes from the registered object name, which is what the
      // counting endpoint verified before recording. Reading every event body
      // to repeat that would multiply the cost of an already linear scan.
      const platform = /\.dmg$/iu.test(match[2]) ? "macos" : /\.exe$/iu.test(match[2]) ? "windows" : null;
      return [{ fileName: match[2], downloadedAt, platform }];
    });
    const countedSince = options.countedSince ?? null;
    const registered = options.registeredNames ? new Set(options.registeredNames) : null;
    const inPeriod = (item: { downloadedAt: Date }) => item.downloadedAt >= createdFrom && item.downloadedAt < createdTo;
    const counted = countedSince === null ? records : records.filter((item) => item.downloadedAt >= countedSince);
    const legacy = countedSince === null ? [] : records.filter((item) => item.downloadedAt < countedSince);
    const names = [...new Set(counted.map((item) => item.fileName))].sort();
    const totalFor = (list: typeof records) => list.length;
    return {
      total: totalFor(counted),
      period: counted.filter(inPeriod).length,
      byFile: names.map((fileName) => {
        const matching = counted.filter((item) => item.fileName === fileName);
        return { fileName, total: matching.length, period: matching.filter(inPeriod).length };
      }),
      byPlatform: {
        macos: {
          total: counted.filter((item) => item.platform === "macos").length,
          period: counted.filter((item) => item.platform === "macos" && inPeriod(item)).length
        },
        windows: {
          total: counted.filter((item) => item.platform === "windows").length,
          period: counted.filter((item) => item.platform === "windows" && inPeriod(item)).length
        }
      },
      earliest: counted.reduce<string | null>((soonest, item) => {
        const iso = item.downloadedAt.toISOString();
        return soonest === null || iso < soonest ? iso : soonest;
      }, null),
      legacyCount: legacy.length,
      // An event for a name the registry no longer lists is still a real request,
      // so it stays in the totals; it just cannot be attributed to a platform.
      unattributed: registered === null ? 0 : counted.filter((item) => !registered.has(item.fileName)).length
    };
  }
}
