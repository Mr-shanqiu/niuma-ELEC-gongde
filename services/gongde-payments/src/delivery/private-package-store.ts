import { createHash } from "node:crypto";
import COS from "cos-nodejs-sdk-v5/index.js";
import { loadRuntimeSecret } from "../payments/runtime-secret.js";

export interface PrivatePackageConfiguration {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
}

export interface PrivatePackageInput {
  orderNo: string;
  identity: string;
  content: Buffer;
  filename: string;
  count: number;
  importBefore: Date;
}

export interface FreePackageReference {
  objectKey: string;
  filename: string;
  bytes: number;
  sha256: string;
  downloadExpiresAt: Date;
}

interface StoredPackage {
  key: string;
  bytes: number;
  filename: string;
  importBefore: Date;
}

type PackageCos = Pick<COS, "getBucketAcl" | "getBucketPolicy" | "getObjectAcl" | "headObject" | "putObject" | "getObjectUrl">
  & Partial<Pick<COS, "deleteObject">>;
const MAX_RECORDS = 128;
const MAX_UPLOADS = 2;
const MAX_BYTES = 16 * 1024 * 1024;
const LINK_SECONDS = 120;

export function loadPrivatePackageConfiguration(source: NodeJS.ProcessEnv = process.env): PrivatePackageConfiguration | null {
  const mode = source.GONGDE_PRIVATE_COS_MODE?.trim() || "disabled";
  if (mode === "disabled") return null;
  if (mode !== "enabled") throw new Error("private_package_configuration_invalid");
  const bucket = source.GONGDE_PRIVATE_COS_BUCKET?.trim() || "";
  const region = source.GONGDE_PRIVATE_COS_REGION?.trim() || "ap-shanghai";
  // A new, Gongde-only bucket is required. Never inherit public/shared storage.
  if (!/^gongde-paid-[a-z0-9-]*\d$/u.test(bucket) || !/-\d+$/u.test(bucket)
    || !/^[a-z]+-[a-z]+(?:-[a-z]+)?$/u.test(region)) {
    throw new Error("private_package_configuration_invalid");
  }
  return {
    bucket,
    region,
    secretId: loadRuntimeSecret(source, "GONGDE_PRIVATE_COS_SECRET_ID", "GONGDE_PRIVATE_COS_SECRET_ID_FILE"),
    secretKey: loadRuntimeSecret(source, "GONGDE_PRIVATE_COS_SECRET_KEY", "GONGDE_PRIVATE_COS_SECRET_KEY_FILE")
  };
}

function statusCode(error: unknown): number {
  return Number((error as { statusCode?: number } | null)?.statusCode);
}

function missingBucketPolicy(error: unknown): boolean {
  if (!error || typeof error !== "object" || statusCode(error) !== 404) return false;
  const value = error as {
    code?: unknown;
    message?: unknown;
    ErrorStatus?: unknown;
    error?: { Code?: unknown; message?: unknown; ErrorStatus?: unknown };
  };
  const code = value.error?.Code ?? value.code;
  if (code === "NoSuchBucketPolicy" || code === "NoSuchPolicy" || code === "NoSuchPolicyVersion") return true;
  // SDK 3.x normalizes absent-policy errors to this exact combination.
  return (code === "404" || code === 404)
    && (value.ErrorStatus ?? value.error?.ErrorStatus) === "Policy Not Found"
    && (value.message ?? value.error?.message) === "Policy Not found";
}

function privateAcl(value: COS.GetBucketAclResult | COS.GetObjectAclResult): boolean {
  const owner = value.Owner?.ID;
  return value.ACL === "private" && Boolean(owner) && Array.isArray(value.Grants)
    && value.Grants.every((grant) => "ID" in grant.Grantee && grant.Grantee.ID === owner);
}

function contentLength(value: unknown): number {
  const headers = (value as { headers?: Record<string, unknown> }).headers || {};
  const length = Number(Object.entries(headers).find(([name]) => name.toLowerCase() === "content-length")?.[1]);
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BYTES) {
    throw new Error("private_package_object_invalid");
  }
  return length;
}

export class PrivatePackageStore {
  readonly #cos: PackageCos;
  readonly #stored = new Map<string, StoredPackage>();
  readonly #uploads = new Map<string, Promise<StoredPackage>>();
  #bucketCheck: Promise<void> | null = null;
  #bucketVerifiedUntil = 0;
  #retryAfter = 0;

  constructor(private readonly configuration: PrivatePackageConfiguration, client?: PackageCos) {
    this.#cos = client ?? new COS({
      SecretId: configuration.secretId,
      SecretKey: configuration.secretKey,
      Timeout: 15_000
    });
  }

  #bucket() {
    return { Bucket: this.configuration.bucket, Region: this.configuration.region };
  }

  async checkFreeReady(): Promise<void> { await this.#requirePrivateBucket(); }

  async deleteFreeArtifact(objectKey: string): Promise<void> {
    // Retention may remove only a referenced, generated free-delivery object.
    // Never accept paid orders, source archives, or arbitrary bucket prefixes.
    if (!/^free-claims\/v2\/[a-f0-9]{64}\.(?:nmgpack|nmgpacks)$/u.test(objectKey)) {
      throw new Error("free_retention_object_key_invalid");
    }
    if (!this.#cos.deleteObject) throw new Error("free_retention_transport_unavailable");
    await this.#requirePrivateBucket();
    await this.#cos.deleteObject({ ...this.#bucket(), Key: objectKey });
  }

  async #requirePrivateBucket(): Promise<void> {
    if (Date.now() < this.#retryAfter) throw new Error("private_package_unavailable");
    if (Date.now() < this.#bucketVerifiedUntil) return;
    if (!this.#bucketCheck) {
      this.#bucketCheck = (async () => {
        const acl = await this.#cos.getBucketAcl(this.#bucket());
        if (!privateAcl(acl)) throw new Error("private_package_bucket_not_private");
        try {
          const result = await this.#cos.getBucketPolicy(this.#bucket());
          const policy: Record<string, unknown> = typeof result.Policy === "string"
            ? JSON.parse(result.Policy) : result.Policy;
          const statements = policy?.Statement ?? policy?.statement;
          // Use CAM for the dedicated runtime identity, not bucket-policy grants.
          // All Allow policies are rejected, including conditional public grants.
          if (!Array.isArray(statements) || statements.some((statement) =>
            !statement || typeof statement !== "object"
            || String(statement.Effect ?? statement.effect).toLowerCase() !== "deny")) {
            throw new Error("private_package_bucket_policy_invalid");
          }
        } catch (error) {
          if (!missingBucketPolicy(error)) throw error;
        }
        this.#bucketVerifiedUntil = Date.now() + 5_000;
      })().finally(() => { this.#bucketCheck = null; });
    }
    await this.#bucketCheck;
  }

  #key(input: PrivatePackageInput): string {
    const identity = createHash("sha256").update(`${input.orderNo}\0${input.identity}`).digest("hex");
    return `paid-batches/v1/${identity}.${input.count > 1 ? "nmgpacks" : "nmgpack"}`;
  }

  async prepare(input: PrivatePackageInput): Promise<StoredPackage> {
    if (input.importBefore.getTime() <= Date.now()) throw new Error("pack_delivery_expired_or_missing");
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 10
      || input.content.length < 1 || input.content.length > MAX_BYTES
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(?:nmgpack|nmgpacks)$/u.test(input.filename)) {
      throw new Error("private_package_input_invalid");
    }
    const key = this.#key(input);
    for (const [id, stored] of this.#stored) {
      if (stored.importBefore.getTime() <= Date.now()) this.#stored.delete(id);
    }
    const cached = this.#stored.get(key);
    if (cached) return cached;
    const existing = this.#uploads.get(key);
    if (existing) return existing;
    if (Date.now() < this.#retryAfter) throw new Error("private_package_unavailable");
    if (this.#uploads.size >= MAX_UPLOADS) throw new Error("private_package_busy");
    const operation = this.#prepare(input, key).catch((error) => {
      this.#retryAfter = Date.now() + 30_000;
      throw error;
    }).finally(() => { this.#uploads.delete(key); });
    this.#uploads.set(key, operation);
    return operation;
  }

  async #prepare(input: PrivatePackageInput, key: string): Promise<StoredPackage> {
    // Check the bucket before uploading any actual paid content.
    await this.#requirePrivateBucket();
    const object = { ...this.#bucket(), Key: key };
    let bytes: number;
    try {
      bytes = contentLength(await this.#cos.headObject(object));
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
      const upload: COS.PutObjectParams & { ContentMD5: string } = {
        ...object,
        Body: input.content,
        ContentLength: input.content.length,
        ContentMD5: createHash("md5").update(input.content).digest("base64"),
        ContentType: "application/octet-stream",
        ContentDisposition: `attachment; filename="${input.filename}"`,
        CacheControl: "private, no-store",
        ACL: "private"
      };
      await this.#cos.putObject(upload);
      bytes = contentLength(await this.#cos.headObject(object));
      if (bytes !== input.content.length) throw new Error("private_package_object_invalid");
    }
    if (!privateAcl(await this.#cos.getObjectAcl(object))) throw new Error("private_package_object_not_private");
    if (input.importBefore.getTime() <= Date.now()) throw new Error("pack_delivery_expired_or_missing");
    const stored = { key, bytes, filename: input.filename, importBefore: input.importBefore };
    while (this.#stored.size >= MAX_RECORDS) this.#stored.delete(this.#stored.keys().next().value!);
    this.#stored.set(key, stored);
    return stored;
  }

  async downloadUrl(input: PrivatePackageInput): Promise<string> {
    const stored = await this.prepare(input);
    await this.#requirePrivateBucket();
    if (!privateAcl(await this.#cos.getObjectAcl({ ...this.#bucket(), Key: stored.key }))) {
      this.#stored.delete(stored.key);
      throw new Error("private_package_object_not_private");
    }
    const remaining = Math.floor((stored.importBefore.getTime() - Date.now()) / 1000) - 1;
    if (remaining < 1) throw new Error("pack_delivery_expired_or_missing");
    const signed = new URL(this.#cos.getObjectUrl({
      ...this.#bucket(),
      Key: stored.key,
      Protocol: "https:",
      Method: "GET",
      Sign: true,
      Expires: Math.min(LINK_SECONDS, remaining),
      Query: {
        "response-content-disposition": `attachment; filename="${stored.filename}"`,
        "response-content-type": "application/octet-stream",
        "response-cache-control": "private, no-store"
      }
    }));
    const expectedHost = `${this.configuration.bucket}.cos.${this.configuration.region}.myqcloud.com`;
    const expiry = Number(signed.searchParams.get("q-sign-time")?.split(";")[1]);
    if (signed.protocol !== "https:" || signed.hostname !== expectedHost
      || !signed.searchParams.get("q-signature") || !Number.isSafeInteger(expiry)
      || expiry * 1000 > stored.importBefore.getTime() || expiry * 1000 <= Date.now()) {
      throw new Error("private_package_link_invalid");
    }
    return signed.toString();
  }

  // Website retention is independent of the permanent license inside the file.
  // A separate prefix avoids the legacy paid-batch two-day lifecycle.
  async prepareFree(input: {
    claimId: string; content: Buffer; filename: string; downloadExpiresAt: Date;
  }): Promise<FreePackageReference> {
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(input.claimId) || input.content.length < 1 ||
        input.content.length > MAX_BYTES || !/^niuma-appearances?-[A-Za-z0-9_-]+\.nmgpacks?$/u.test(input.filename) ||
        !Number.isFinite(input.downloadExpiresAt.getTime()) || input.downloadExpiresAt.getTime() <= Date.now()) {
      throw new Error("private_package_input_invalid");
    }
    await this.#requirePrivateBucket();
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const identity = createHash("sha256").update(`${input.claimId}\0${sha256}`).digest("hex");
    const objectKey = `free-claims/v2/${identity}.${input.filename.endsWith(".nmgpacks") ? "nmgpacks" : "nmgpack"}`;
    const object = { ...this.#bucket(), Key: objectKey };
    try {
      const existing = await this.#cos.headObject(object);
      if (contentLength(existing) !== input.content.length) throw new Error("private_package_object_invalid");
      const headers = existing.headers as Record<string, unknown>;
      if (headers["x-cos-meta-sha256"] !== sha256) throw new Error("private_package_object_invalid");
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
      await this.#cos.putObject({ ...object, Body: input.content, ContentLength: input.content.length,
        ContentType: "application/octet-stream",
        ContentDisposition: `attachment; filename="${input.filename}"`, CacheControl: "private, no-store",
        ACL: "private", Headers: { "x-cos-meta-sha256": sha256,
          "Content-MD5": createHash("md5").update(input.content).digest("base64") } });
    }
    const reference = { objectKey, filename: input.filename, bytes: input.content.length, sha256,
      downloadExpiresAt: input.downloadExpiresAt };
    await this.#verifyFree(reference);
    return reference;
  }

  async #verifyFree(input: FreePackageReference): Promise<void> {
    if (!/^free-claims\/v2\/[a-f0-9]{64}\.nmgpacks?$/u.test(input.objectKey) ||
        !/^niuma-appearances?-[A-Za-z0-9_-]+\.nmgpacks?$/u.test(input.filename) ||
        !/^[a-f0-9]{64}$/u.test(input.sha256) || !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1 || input.bytes > MAX_BYTES || input.downloadExpiresAt.getTime() <= Date.now()) {
      throw new Error("private_package_input_invalid");
    }
    await this.#requirePrivateBucket();
    const object = { ...this.#bucket(), Key: input.objectKey };
    const metadata = await this.#cos.headObject(object);
    if (contentLength(metadata) !== input.bytes || metadata.headers?.["x-cos-meta-sha256"] !== input.sha256 ||
        !privateAcl(await this.#cos.getObjectAcl(object))) throw new Error("private_package_object_invalid");
  }

  async downloadFree(input: FreePackageReference): Promise<{ url: string; expiresAt: string }> {
    await this.#verifyFree(input);
    const remaining = Math.floor((input.downloadExpiresAt.getTime() - Date.now()) / 1000) - 1;
    if (remaining < 1) throw new Error("claim_download_expired");
    const signed = new URL(this.#cos.getObjectUrl({ ...this.#bucket(), Key: input.objectKey,
      Protocol: "https:", Method: "GET", Sign: true, Expires: Math.min(300, remaining),
      Query: { "response-content-disposition": `attachment; filename="${input.filename}"`,
        "response-content-type": "application/octet-stream", "response-cache-control": "private, no-store" } }));
    const expiry = Number(signed.searchParams.get("q-sign-time")?.split(";")[1]);
    if (signed.protocol !== "https:" || signed.hostname !== `${this.configuration.bucket}.cos.${this.configuration.region}.myqcloud.com` ||
        !signed.searchParams.get("q-signature") || !Number.isSafeInteger(expiry) || expiry * 1000 > input.downloadExpiresAt.getTime() ||
        expiry * 1000 <= Date.now()) throw new Error("private_package_link_invalid");
    return { url: signed.toString(), expiresAt: new Date(expiry * 1000).toISOString() };
  }
}
