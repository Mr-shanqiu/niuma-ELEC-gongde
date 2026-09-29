import { randomBytes } from "node:crypto";
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
    await new Promise<void>((resolve, reject) => {
      this.#cos.deleteObject({
        Bucket: this.configuration.bucket,
        Region: this.configuration.region,
        Key: `${prefixes[kind]}${name}`
      }, (error) => error ? reject(error) : resolve());
    });
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

  async writePublishedAssetIds(assetIds: readonly string[]): Promise<void> {
    const body = Buffer.from(JSON.stringify({
      version: 1,
      publishedAssetIds: [...assetIds],
      updatedAt: new Date().toISOString()
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
