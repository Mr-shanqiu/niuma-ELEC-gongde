import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import COS from "cos-nodejs-sdk-v5";
import type { CreatorStorageConfiguration } from "./configuration.js";
import type { ValidatedCreatorPack } from "./pack-validation.js";
import { CREATOR_UPLOAD_LIMITS } from "./policy.js";
import { CreatorError } from "./types.js";

const prefix = "creator-submissions/v1/";
const identity = /^[a-f0-9]{32}$/u;
const hash = /^[a-f0-9]{64}$/u;
const pngName = /^[a-z0-9][a-z0-9_-]{0,59}\.png$/u;

export interface StoredCreatorSource {
  sourceObjectKey: string;
  previewObjectKey: string;
  imageNames: string[];
}

export class CreatorSourceStore {
  readonly #cos: COS;
  #operations = 0;

  constructor(private readonly configuration: CreatorStorageConfiguration, client?: COS) {
    this.#cos = client ?? new COS({
      SecretId: configuration.secretId, SecretKey: configuration.secretKey,
      Timeout: 15000, ChunkRetryTimes: 0
    });
  }

  async #bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#operations >= 2) throw new CreatorError("creator_storage_busy", 503);
    this.#operations += 1;
    try { return await operation(); } finally { this.#operations -= 1; }
  }

  async #requirePrivateBucket(): Promise<void> {
    const { bucket: Bucket, region: Region } = this.configuration;
    const acl = await new Promise<COS.GetBucketAclResult>((resolve, reject) => {
      this.#cos.getBucketAcl({ Bucket, Region }, (error, data) => error ? reject(error) : resolve(data));
    });
    if (acl.ACL !== "private" || !acl.Owner?.ID ||
        acl.Grants.some(grant => !("ID" in grant.Grantee) ||
          grant.Grantee.ID !== acl.Owner.ID || "URI" in grant.Grantee)) {
      throw new CreatorError("creator_storage_not_private", 503);
    }
    const policy = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
      this.#cos.getBucketPolicy({ Bucket, Region }, (error, data) => {
        if (error) {
          const failure = error as {
            code?: string; statusCode?: number; ErrorStatus?: string;
            error?: { Code?: string; code?: string; ErrorStatus?: string };
          };
          // SDK 3.x explicitly marks absent policies; a bare 404 is not enough.
          const missingPolicy =
            failure.code !== "NoSuchBucket" &&
            failure.error?.Code !== "NoSuchBucket" &&
            failure.error?.code !== "NoSuchBucket" && (
            (failure.code === "NoSuchBucketPolicy" &&
              (failure.statusCode === undefined || failure.statusCode === 404)) ||
            (failure.statusCode === 404 &&
              (failure.code ?? failure.error?.code) === "404" &&
              (failure.ErrorStatus ?? failure.error?.ErrorStatus) === "Policy Not Found"));
          if (missingPolicy) resolve(null);
          else reject(error);
        } else resolve(data.Policy as Record<string, unknown>);
      });
    });
    if (policy !== null) {
      const statements = policy.Statement ?? policy.statement;
      if (!Array.isArray(statements) || statements.some(statement => {
        if (!statement || typeof statement !== "object") return true;
        const entry = statement as Record<string, unknown>;
        return String(entry.Effect ?? entry.effect).toLowerCase() !== "deny";
      })) throw new CreatorError("creator_storage_not_private", 503);
    }
  }

  async #put(Key: string, body: Buffer, ContentType: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#cos.putObject({
        Bucket: this.configuration.bucket, Region: this.configuration.region,
        Key, Body: body, ContentLength: body.length, ContentType,
        ACL: "private", CacheControl: "private, no-store"
      }, error => error ? reject(error) : resolve());
    });
  }

  async putSource(creatorId: string, archive: Buffer, pack: ValidatedCreatorPack): Promise<StoredCreatorSource> {
    if (!identity.test(creatorId) || !hash.test(pack.archiveSha256) ||
        createHash("sha256").update(archive).digest("hex") !== pack.archiveSha256) {
      throw new CreatorError("creator_source_identity_invalid");
    }
    return this.#bounded(async () => {
      await this.#requirePrivateBucket();
      const base = `${prefix}${creatorId}/${pack.archiveSha256}`;
      const sourceObjectKey = `${base}/source.nmgpack`;
      const imageNames = [...pack.files.keys()].filter(name => pngName.test(name)).sort();
      const previewName = pack.manifest.preview;
      if (!pngName.test(previewName) || !imageNames.includes(previewName)) {
        throw new CreatorError("creator_preview_missing");
      }
      await this.#put(sourceObjectKey, archive, "application/octet-stream");
      for (const name of imageNames) await this.#put(`${base}/images/${name}`, pack.files.get(name)!, "image/png");
      // Database publication occurs only after every private object is durable.
      return { sourceObjectKey, previewObjectKey: `${base}/images/${previewName}`, imageNames };
    });
  }

  async image(creatorId: string, archiveSha256: string, name: string): Promise<Buffer> {
    if (!identity.test(creatorId) || !hash.test(archiveSha256) || !pngName.test(name)) {
      throw new CreatorError("creator_image_invalid");
    }
    // Images are unpacked members, not the compressed source archive.
    return this.#read(`${prefix}${creatorId}/${archiveSha256}/images/${name}`, CREATOR_UPLOAD_LIMITS.unpackedBytes);
  }

  async source(creatorId: string, archiveSha256: string): Promise<Buffer> {
    if (!identity.test(creatorId) || !hash.test(archiveSha256)) throw new CreatorError("creator_source_identity_invalid");
    const body = await this.#read(`${prefix}${creatorId}/${archiveSha256}/source.nmgpack`, CREATOR_UPLOAD_LIMITS.archiveBytes);
    if (createHash("sha256").update(body).digest("hex") !== archiveSha256) {
      throw new CreatorError("creator_source_integrity_failed", 503);
    }
    return body;
  }

  async #read(Key: string, maximum: number): Promise<Buffer> {
    return this.#bounded(async () => {
      await this.#requirePrivateBucket();
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const output = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > maximum) { callback(new CreatorError("creator_object_too_large", 503)); return; }
            chunks.push(Buffer.from(chunk));
            callback();
          }
        });
        output.on("error", reject);
        this.#cos.getObject({
          Bucket: this.configuration.bucket, Region: this.configuration.region, Key, Output: output
        }, error => {
          if (error) reject(error);
          else if (size === 0) reject(new CreatorError("creator_object_empty", 503));
          else resolve(Buffer.concat(chunks, size));
        });
      });
    });
  }
}
