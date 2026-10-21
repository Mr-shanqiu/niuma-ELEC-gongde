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
  async publishInstallerManifest(version: string, windowsVersion = version): Promise<InstallerManifestSummary> {
    if (!/^\d+\.\d+\.\d+$/u.test(version) || !/^\d+\.\d+\.\d+$/u.test(windowsVersion)) throw new Error("admin_release_version_invalid");
    const definitions = [
      { name: `niuma-merit-macos-${version}.dmg`, type: "application/x-apple-diskimage",
        platform: "macOS", architecture: "universal2-arm64-x86_64", notarization: "unknown", version },
      { name: `niuma-merit-windows-${windowsVersion}-setup.exe`, type: "application/vnd.microsoft.portable-executable",
        platform: "Windows", architecture: "x86_64", notarization: "unknown", version: windowsVersion }
    ] as const;

    // A previous manifest that cannot be read is not a licence to overwrite it
    // with a two-entry list; that would destroy history on a transient error.
    let previousFiles: Array<Record<string, unknown>> = [];
    try {
      const previous = await new Promise<{ Body?: Buffer | string }>((resolve, reject) => {
        this.#cos.getObject({
          Bucket: this.configuration.bucket,
          Region: this.configuration.region,
          Key: "DOWNLOADS.json"
        }, (error, data) => error ? reject(error) : resolve(data));
      });
      const raw = Buffer.isBuffer(previous.Body) ? previous.Body.toString("utf8") : String(previous.Body ?? "");
      const parsed = JSON.parse(raw) as { files?: unknown };
      if (Array.isArray(parsed.files)) previousFiles = parsed.files.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    } catch {
      previousFiles = [];
    }
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

  async publicationStateStrict(defaultIds: readonly string[]): Promise<{ publishedAssetIds: string[]; firstPublishedAt: Record<string, string> }> {
    const result = await new Promise<{ Body?: Buffer | string }>((resolve, reject) => {
      this.#cos.getObject({ Bucket: this.configuration.bucket, Region: this.configuration.region,
        Key: appearanceCatalogStateKey }, (error, data) => error ? reject(error) : resolve(data));
    });
    const raw = Buffer.isBuffer(result.Body) ? result.Body.toString("utf8") : String(result.Body ?? "");
    const parsed: unknown = JSON.parse(raw);
    const ids = (parsed as { publishedAssetIds?: unknown } | null)?.publishedAssetIds;
    if (!Array.isArray(ids) || ids.some(item => typeof item !== "string")) throw new Error("appearance_publication_unavailable");
    const allowed = new Set(defaultIds);
    const publishedAssetIds = [...new Set((ids as string[]).filter(item => allowed.has(item)))];
    const metadata = parsed as { firstPublishedAt?: unknown; updatedAt?: unknown };
    const stored = metadata.firstPublishedAt;
    const firstPublishedAt: Record<string, string> = Object.fromEntries(
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? Object.entries(stored).filter(([id, date]) => allowed.has(id) && typeof date === "string" && Number.isFinite(Date.parse(date)))
        : []);
    // The last legacy publication added only wealth-button. Preserve that real
    // timestamp; do not mark all existing assets as newly published at rollout.
    if (stored === undefined && publishedAssetIds.includes("official.wealth-button") &&
      typeof metadata.updatedAt === "string" && Number.isFinite(Date.parse(metadata.updatedAt))) {
      firstPublishedAt["official.wealth-button"] = metadata.updatedAt;
    }
    return { publishedAssetIds, firstPublishedAt };
  }

  async writePublishedAssetIds(assetIds: readonly string[]): Promise<void> {
    const previous = await this.publicationStateStrict(assetIds);
    const now = new Date().toISOString();
    const firstPublishedAt = { ...previous.firstPublishedAt };
    for (const id of assetIds) {
      if (!previous.publishedAssetIds.includes(id) && !Object.prototype.hasOwnProperty.call(firstPublishedAt, id)) firstPublishedAt[id] = now;
    }
    const body = Buffer.from(JSON.stringify({
      version: 1,
      publishedAssetIds: [...assetIds],
      firstPublishedAt,
      updatedAt: now
    }));
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

  async summarizeDownloads(createdFrom: Date, createdTo: Date): Promise<AdminDownloadSummary> {
    const eventPrefix = `${prefixes.installer}.download-events/`;
    const records = (await this.#listObjects(prefixes.installer)).flatMap((item) => {
      const key = item.Key ?? "";
      if (!key.startsWith(eventPrefix)) return [];
      const match = key.slice(eventPrefix.length).match(/^(\d+)-[a-f0-9]+-(.+)$/u);
      if (!match) return [];
      const downloadedAt = new Date(Number(match[1]));
      if (!Number.isFinite(downloadedAt.getTime())) return [];
      return [{ fileName: match[2], downloadedAt }];
    });
    const names = [...new Set(records.map((item) => item.fileName))].sort();
    return {
      total: records.length,
      period: records.filter((item) => item.downloadedAt >= createdFrom && item.downloadedAt < createdTo).length,
      byFile: names.map((fileName) => {
        const matching = records.filter((item) => item.fileName === fileName);
        return {
          fileName,
          total: matching.length,
          period: matching.filter((item) => item.downloadedAt >= createdFrom && item.downloadedAt < createdTo).length
        };
      })
    };
  }
}
