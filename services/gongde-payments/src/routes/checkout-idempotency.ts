import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { GongdeMySqlConfiguration } from "../storage/mysql-store.js";

const RECEIPT_HOURS = 48;
const MEMORY_WINDOW_MS = 30 * 60 * 1000;
const MAX_INFLIGHT = 256;
const MAX_MEMORY_RESULTS = 128;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const TABLE = "gongde_checkout_requests";

export class CheckoutRequestError extends Error {
  readonly precreateRejected: boolean;
  constructor(readonly code: string, readonly status: number, precreateRejected = false) {
    super(code);
    // Only explicitly identified validation before the domain create call may
    // authorize the frontend to abandon its current key.
    this.precreateRejected = precreateRejected && [400, 409, 422].includes(status);
  }
}

type Sealed = { ciphertext: Buffer; iv: Buffer; tag: Buffer };
type MemoryReceipt = { fingerprint: string; expiresAt: number } & (
  { state: "READY"; sealed: Sealed } |
  { state: "FAILED"; code: string; status: number; precreateRejected: boolean }
);
type IdempotencyConfiguration = {
  required: true; scope: "mysql" | "process" | "unavailable";
  durable: boolean; ready: boolean; error?: string;
};

function keyDigest(key: string): string {
  return createHash("sha256").update("gongde/checkout/key-digest/v1\0").update(key).digest("hex");
}
function encryptionKey(key: string): Buffer {
  return createHash("sha256").update("gongde/checkout/payload-key/v1\0").update(key).digest();
}
function aad(digest: string, fingerprint: string): Buffer {
  return Buffer.from(`gongde/checkout/payload-aad/v1\0${digest}\0${fingerprint}`, "utf8");
}
function databaseError(error: unknown): CheckoutRequestError {
  const code = (error as { code?: string })?.code;
  return new CheckoutRequestError(
    code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR"
      ? "checkout_idempotency_schema_unavailable" : "checkout_idempotency_unavailable", 503);
}

function canonicalRequestValue(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("checkout_request_depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonicalRequestValue(item, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(name =>
      [name, canonicalRequestValue(record[name], depth + 1)]));
  }
  throw new Error("checkout_request_value");
}

// Parsing/classification here produces a fingerprint, never a safe rejection.
// Only run()'s successfully reserved create callback can mark validation safe.
export function prepareCheckoutRequest(rawBody: string, legacyAccessHeader: boolean, tooLarge = false): {
  body: unknown; invalidBody: boolean; fingerprint: string;
} {
  let body: unknown;
  let invalidBody = tooLarge;
  let parameters: unknown = { kind: tooLarge ? "too-large" : "malformed-json", rawBody };
  try {
    if (!tooLarge) {
      body = JSON.parse(rawBody) as unknown;
      const record = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown> : null;
      const ids = record?.assetIds;
      const expected = record?.previewRevisions;
      // Preserve the already-built fingerprint for ordinary request bodies.
      // Extra fields/header presence must NOT disappear from a changed request.
      if (!legacyAccessHeader && record &&
          Object.keys(record).every(name => ["channel", "purchaseKind", "assetIds", "previewRevisions"].includes(name)) &&
          typeof record.channel === "string" && typeof record.purchaseKind === "string" &&
          Array.isArray(ids) && ids.every(id => typeof id === "string") &&
          expected && typeof expected === "object" && !Array.isArray(expected) &&
          Object.keys(expected).length === ids.length && ids.every(id => Object.hasOwn(expected, id) &&
            typeof (expected as Record<string, unknown>)[id] === "string" &&
            /^[a-f0-9]{64}$/u.test((expected as Record<string, string>)[id]))) {
        const fingerprint = createHash("sha256").update(JSON.stringify({
          channel: record.channel, purchaseKind: record.purchaseKind,
          items: [...ids].sort().map(id => [id, (expected as Record<string, string>)[id]])
        })).digest("hex");
        return { body, invalidBody: false, fingerprint };
      }
      const normalized = record && Array.isArray(ids) && ids.every(id => typeof id === "string")
        ? { ...record, assetIds: [...ids].sort() } : body;
      parameters = { kind: "json", value: canonicalRequestValue(normalized) };
      invalidBody = false;
    }
  } catch { invalidBody = true; }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    format: "checkout-request-v2", legacyAccessHeader, parameters
  })).digest("hex");
  return { body, invalidBody, fingerprint };
}

export class CheckoutIdempotency<T> {
  private readonly pool: Pool | null;
  private readonly allowMemory: boolean;
  private readonly memoryDeadline = Date.now() + MEMORY_WINDOW_MS;
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<T> }>();
  private readonly memory = new Map<string, MemoryReceipt>();
  // Eviction removes only replay payloads, never the evidence that a key was used.
  // These digest-only tombstones live for the isolated mock process/window.
  private readonly memoryTombstones = new Set<string>();
  private schemaUntil = 0;
  private schemaError: CheckoutRequestError | null = null;
  private schemaCheck: Promise<void> | null = null;
  private closing = false;

  constructor(options: { database: GongdeMySqlConfiguration | null; allowMemory?: boolean }) {
    this.allowMemory = options.allowMemory === true;
    this.pool = options.database ? createPool({ ...options.database,
      connectionLimit: Math.min(4, options.database.connectionLimit), connectTimeout: 5000,
      waitForConnections: true, queueLimit: MAX_INFLIGHT, timezone: "Z",
      charset: "utf8mb4", multipleStatements: false }) : null;
  }

  private async requireSchema(): Promise<void> {
    if (!this.pool || this.closing) throw new CheckoutRequestError("checkout_idempotency_unavailable", 503);
    if (Date.now() < this.schemaUntil) {
      if (this.schemaError) throw this.schemaError;
      return;
    }
    if (!this.schemaCheck) {
      this.schemaCheck = (async () => {
        try {
          await this.pool!.query({ sql: `SELECT key_digest, request_fingerprint, state,
            payload_ciphertext, payload_iv, payload_tag, error_code, error_status,
            precreate_rejected, expires_at FROM ${TABLE} LIMIT 0`, timeout: 5000 });
          this.schemaError = null;
        } catch (error) { this.schemaError = databaseError(error); }
        this.schemaUntil = Date.now() + 5000;
        if (this.schemaError) throw this.schemaError;
      })().finally(() => { this.schemaCheck = null; });
    }
    await this.schemaCheck;
  }

  async configuration(): Promise<IdempotencyConfiguration> {
    if (this.pool) {
      try {
        await this.requireSchema();
        return { required: true, scope: "mysql", durable: true, ready: true };
      } catch (error) {
        return { required: true, scope: "mysql", durable: false, ready: false,
          error: error instanceof CheckoutRequestError ? error.code : "checkout_idempotency_unavailable" };
      }
    }
    const ready = this.allowMemory && !this.closing && Date.now() < this.memoryDeadline;
    return { required: true, scope: this.allowMemory ? "process" : "unavailable", durable: false, ready,
      ...(!ready ? { error: this.allowMemory ? "checkout_mock_window_closed" : "checkout_idempotency_unavailable" } : {}) };
  }

  private seal(key: string, digest: string, fingerprint: string, value: T): Sealed {
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    if (plaintext.length > MAX_PAYLOAD_BYTES) throw new CheckoutRequestError("checkout_idempotency_result_unavailable", 503);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
    cipher.setAAD(aad(digest, fingerprint));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  private open(key: string, digest: string, fingerprint: string, sealed: Sealed): T {
    try {
      if (sealed.ciphertext.length > MAX_PAYLOAD_BYTES || sealed.iv.length !== 12 || sealed.tag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(key), sealed.iv);
      decipher.setAAD(aad(digest, fingerprint));
      decipher.setAuthTag(sealed.tag);
      return JSON.parse(Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8")) as T;
    } catch { throw new CheckoutRequestError("checkout_idempotency_result_unavailable", 503); }
  }

  // Read an existing receipt only. Missing/expired receipts must never create orders.
  async recover(key: string): Promise<T> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(key) &&
        !/^[A-Za-z0-9_-]{32,128}$/u.test(key)) throw new CheckoutRequestError("idempotency_key_invalid", 400);
    if (this.closing) throw new CheckoutRequestError("checkout_idempotency_unavailable", 503);
    const digest = keyDigest(key);
    if (this.pool) {
      await this.requireSchema();
      let row: RowDataPacket | undefined;
      try {
        row = (await this.pool.execute<RowDataPacket[]>(`SELECT *, expires_at <= UTC_TIMESTAMP(3) AS expired
          FROM ${TABLE} WHERE key_digest = ?`, [digest]))[0][0];
      } catch (error) { throw databaseError(error); }
      if (!row || row.expired || row.state !== "READY")
        throw new CheckoutRequestError("checkout_idempotency_result_unavailable", 503);
      return this.open(key, digest, String(row.request_fingerprint), {
        ciphertext: Buffer.from(row.payload_ciphertext), iv: Buffer.from(row.payload_iv), tag: Buffer.from(row.payload_tag)
      });
    }
    const receipt = this.memory.get(digest);
    if (!this.allowMemory || !receipt || receipt.state !== "READY" || receipt.expiresAt <= Date.now())
      throw new CheckoutRequestError("checkout_idempotency_result_unavailable", 503);
    return this.open(key, digest, receipt.fingerprint, receipt.sealed);
  }

  run(key: string, fingerprint: string, create: () => Promise<T>): Promise<T> {
    // UUID v4 carries 122 random bits. Other clients must provide at least 32
    // URL-safe random characters. The key is a client-held decryption capability.
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(key) &&
        !/^[A-Za-z0-9_-]{32,128}$/u.test(key)) {
      // An unusable/missing header cannot establish the absence of a previous
      // client transaction, so it must never authorize abandoning that key.
      throw new CheckoutRequestError("idempotency_key_invalid", 400);
    }
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new CheckoutRequestError("invalid_checkout_request", 400);
    if (this.closing) throw new CheckoutRequestError("checkout_idempotency_unavailable", 503);
    const digest = keyDigest(key);
    const existing = this.requests.get(digest);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CheckoutRequestError("idempotency_conflict", 409);
      return existing.result;
    }
    if (this.requests.size >= MAX_INFLIGHT) throw new CheckoutRequestError("checkout_idempotency_busy", 503);
    const result = Promise.resolve().then(() => this.pool
      ? this.runMySql(key, digest, fingerprint, create)
      : this.runMemory(key, digest, fingerprint, create))
      .finally(() => { this.requests.delete(digest); });
    this.requests.set(digest, { fingerprint, result });
    return result;
  }

  private async execute(sql: string, values: unknown[]): Promise<ResultSetHeader> {
    try { return (await this.pool!.execute<ResultSetHeader>(sql, values as never))[0]; }
    catch (error) { throw databaseError(error); }
  }

  private async replayMySql(key: string, digest: string, fingerprint: string): Promise<T> {
    let row: RowDataPacket | undefined;
    try {
      row = (await this.pool!.execute<RowDataPacket[]>(`SELECT *, expires_at <= UTC_TIMESTAMP(3) AS expired
        FROM ${TABLE} WHERE key_digest = ?`, [digest]))[0][0];
    } catch (error) { throw databaseError(error); }
    if (!row) throw new CheckoutRequestError("checkout_idempotency_unavailable", 503);
    if (row.request_fingerprint !== fingerprint) throw new CheckoutRequestError("idempotency_conflict", 409);
    if (row.expired || row.state === "EXPIRED") {
      await this.execute(`UPDATE ${TABLE} SET state='EXPIRED', payload_ciphertext=NULL,
        payload_iv=NULL, payload_tag=NULL, precreate_rejected=FALSE WHERE key_digest=?`, [digest]);
      throw new CheckoutRequestError("checkout_idempotency_expired", 410);
    }
    if (row.state === "READY") {
      try {
        return this.open(key, digest, fingerprint, { ciphertext: Buffer.from(row.payload_ciphertext),
          iv: Buffer.from(row.payload_iv), tag: Buffer.from(row.payload_tag) });
      } catch { throw new CheckoutRequestError("checkout_idempotency_result_unavailable", 503); }
    }
    if (row.state === "FAILED") {
      const knownPrecreate = row.precreate_rejected === 1 || row.precreate_rejected === true;
      const status = Number(row.error_status);
      const code = typeof row.error_code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(row.error_code)
        ? row.error_code : "checkout_idempotency_failed";
      throw new CheckoutRequestError(knownPrecreate ? code : "checkout_idempotency_failed",
        knownPrecreate && [400, 409, 422].includes(status) ? status : 503, knownPrecreate);
    }
    // STARTED may mean the order/provider call succeeded before a crash or an
    // acknowledgement was lost. Never attempt create again, on any worker.
    throw new CheckoutRequestError("checkout_idempotency_started", 503);
  }

  private async runMySql(key: string, digest: string, fingerprint: string, create: () => Promise<T>): Promise<T> {
    await this.requireSchema();
    try {
      await this.pool!.execute(`INSERT INTO ${TABLE}
        (key_digest,request_fingerprint,state,expires_at)
        VALUES (?,?,'STARTED',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${RECEIPT_HOURS} HOUR))`, [digest, fingerprint]);
    } catch (error) {
      if ((error as { code?: string })?.code === "ER_DUP_ENTRY") return this.replayMySql(key, digest, fingerprint);
      // Even an unknown INSERT outcome cannot authorize a domain create call.
      throw databaseError(error);
    }
    let value: T;
    try { value = await create(); }
    catch (error) {
      const precreate = error instanceof CheckoutRequestError && error.precreateRejected;
      const saved = await this.execute(`UPDATE ${TABLE} SET state='FAILED', error_code=?,
        error_status=?, precreate_rejected=? WHERE key_digest=? AND request_fingerprint=? AND state='STARTED'`,
      [precreate ? error.code : "checkout_idempotency_failed", precreate ? error.status : 503,
        precreate, digest, fingerprint]);
      if (saved.affectedRows !== 1) throw new CheckoutRequestError("checkout_idempotency_unavailable", 503);
      throw error;
    }
    // A result is not returned until its encrypted replay receipt is durable.
    // Failed serialization/write acknowledgements leave STARTED fail-closed.
    let sealed: Sealed;
    try { sealed = this.seal(key, digest, fingerprint, value); }
    catch { throw new CheckoutRequestError("checkout_idempotency_result_unavailable", 503); }
    const saved = await this.execute(`UPDATE ${TABLE} SET state='READY', payload_ciphertext=?,
      payload_iv=?, payload_tag=?, error_code=NULL, error_status=NULL, precreate_rejected=FALSE
      WHERE key_digest=? AND request_fingerprint=? AND state='STARTED' AND expires_at>UTC_TIMESTAMP(3)`,
    [sealed.ciphertext, sealed.iv, sealed.tag, digest, fingerprint]);
    if (saved.affectedRows !== 1) throw new CheckoutRequestError("checkout_idempotency_unavailable", 503);
    return value;
  }

  private rememberMemory(digest: string, receipt: MemoryReceipt): void {
    this.memory.set(digest, receipt);
    while (this.memory.size > MAX_MEMORY_RESULTS) {
      const oldest = this.memory.keys().next().value!;
      this.memory.delete(oldest);
      this.memoryTombstones.add(oldest);
    }
  }

  private async runMemory(key: string, digest: string, fingerprint: string, create: () => Promise<T>): Promise<T> {
    if (!this.allowMemory) throw new CheckoutRequestError("checkout_idempotency_unavailable", 503);
    if (this.memoryTombstones.has(digest)) throw new CheckoutRequestError("checkout_idempotency_expired", 410);
    if (Date.now() >= this.memoryDeadline) throw new CheckoutRequestError("checkout_mock_window_closed", 503);
    const existing = this.memory.get(digest);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CheckoutRequestError("idempotency_conflict", 409);
      if (existing.expiresAt <= Date.now()) {
        this.memory.delete(digest); this.memoryTombstones.add(digest);
        throw new CheckoutRequestError("checkout_idempotency_expired", 410);
      }
      if (existing.state === "FAILED") throw new CheckoutRequestError(existing.code, existing.status, existing.precreateRejected);
      this.memory.delete(digest); this.memory.set(digest, existing);
      return this.open(key, digest, fingerprint, existing.sealed);
    }
    try {
      const value = await create();
      this.rememberMemory(digest, { fingerprint, state: "READY", expiresAt: this.memoryDeadline,
        sealed: this.seal(key, digest, fingerprint, value) });
      return value;
    } catch (error) {
      const precreate = error instanceof CheckoutRequestError && error.precreateRejected;
      this.rememberMemory(digest, { fingerprint, state: "FAILED", expiresAt: this.memoryDeadline,
        code: precreate ? error.code : "checkout_idempotency_failed", status: precreate ? error.status : 503,
        precreateRejected: precreate });
      throw error;
    }
  }

  async close(): Promise<void> { this.closing = true; await this.pool?.end(); }
}
