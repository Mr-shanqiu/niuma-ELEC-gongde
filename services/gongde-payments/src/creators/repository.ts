import { createHash, randomBytes } from "node:crypto";
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { GongdeMySqlConfiguration } from "../storage/mysql-store.js";
import type { CreatorSourceManifest } from "./pack-validation.js";
import { CreatorError } from "./types.js";
import { appearanceNumberFromSerial, registerCommunityAppearanceNumber } from "../domain/appearance-numbers.js";
import { FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS_SHA256, FREE_CREATOR_AI_TERMS_VERSION,
  FREE_CREATOR_AI_TERMS_SHA256, creatorPublicTextDigest, hasCurrentFreeConsent } from "./consent.js";
import { parseCreatorMetadata } from "./metadata.js";

type Executor = Pool | PoolConnection;
type SqlValues = NonNullable<Parameters<Pool["execute"]>[1]>;
const id = () => randomBytes(16).toString("hex");
const parseJson = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;

export interface FreeWorkMetadata {
  titleZh: string;
  description: string;
  tags: string[];
  creatorName?: string;
  creatorDouyinNumber?: string | null;
  acceptFreeDistribution?: true;
  acceptPaidDistribution?: true;
  acceptAiContentReview?: true;
  sharingTermsSha256?: string;
  aiReviewTermsVersion?: string;
  aiReviewTermsSha256?: string;
  publicTextSha256?: string;
  priceFen: 0 | 20;
  sharingTermsVersion: string;
}

export interface CreatorAccountRecord {
  creatorId: string;
  username: string;
  displayName: string;
  passwordHash: string;
  recoveryDigest: string | null;
  state: string;
  publicNumber?: string | null;
}

export interface FreeWorkRecord {
  workId: string;
  appearanceNumber: string;
  creatorId: string;
  slug: string;
  metadata: FreeWorkMetadata;
  state: string;
  publishedVersionId: string | null;
  publishedMetadata: FreeWorkMetadata | null;
  creatorDouyinNumber: string | null;
  firstPublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FreeVersionRecord {
  versionId: string;
  workId: string;
  creatorId: string;
  slug: string;
  versionLabel: string;
  state: string;
  revision: string;
  archiveSha256: string;
  sourceObjectKey: string;
  previewObjectKey: string;
  manifest: CreatorSourceManifest;
  validation: { imageNames: string[]; archiveBytes: number; unpackedBytes: number; decodedImageBytes: number;
    originalArchiveSha256?: string; normalization?: string; contentFingerprint?: string };
  approvedMetadata: FreeWorkMetadata | null;
  deliveryBytesUpperBound: number;
  createdAt: string;
}

export interface FreeReviewRecord {
  reviewId: string;
  appearanceNumber: string;
  versionId: string;
  workId: string;
  state: string;
  metadata: FreeWorkMetadata;
  reason: string | null;
  submittedAt: string;
  autoReview?: { state: string; attempts: number };
}

function publicAutoReview(value: unknown): FreeReviewRecord["autoReview"] {
  if (!value) return undefined;
  const parsed = parseJson<Record<string, unknown>>(value);
  const auto = parsed.autoReview as { state?: unknown; attempts?: unknown } | undefined;
  return auto && typeof auto.state === "string" &&
    ["queued", "running", "retry_wait", "needs_review", "approved", "rejected"].includes(auto.state) ?
    { state: auto.state, attempts: Number(auto.attempts) || 0 } : undefined;
}

function account(row: RowDataPacket): CreatorAccountRecord {
  return { creatorId: row.creator_id, username: row.username, displayName: row.display_name,
    passwordHash: row.password_hash, recoveryDigest: row.recovery_digest, state: row.state };
}
function work(row: RowDataPacket): FreeWorkRecord {
  const publishedMetadata = row.published_metadata_json ? parseJson<FreeWorkMetadata>(row.published_metadata_json) : null;
  const priceFen = Number(row.price_fen) === 20 ? 20 : 0;
  return {
    workId: row.work_id, appearanceNumber: appearanceNumberFromSerial(row.appearance_serial), creatorId: row.creator_id, slug: row.slug,
    metadata: { titleZh: row.title_zh, description: row.description, tags: parseJson<string[]>(row.tags_json),
      creatorDouyinNumber: row.creator_douyin_number ?? null,
      priceFen, sharingTermsVersion: row.sharing_terms_version ??
        (priceFen === 20 ? "creator-paid-distribution-v1" : "creator-free-sharing-v1") },
    state: row.state, publishedVersionId: row.published_version_id,
    publishedMetadata: publishedMetadata ? { ...publishedMetadata,
      creatorDouyinNumber: publishedMetadata.creatorDouyinNumber ?? null } : null,
    creatorDouyinNumber: row.creator_douyin_number ?? null,
    firstPublishedAt: row.first_published_at ? new Date(row.first_published_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
  };
}
function version(row: RowDataPacket): FreeVersionRecord {
  return {
    versionId: row.version_id, workId: row.work_id, creatorId: row.creator_id, slug: row.slug,
    versionLabel: row.version_label, state: row.state, revision: row.source_revision,
    archiveSha256: row.archive_sha256, sourceObjectKey: row.source_object_key,
    previewObjectKey: row.preview_object_key, manifest: parseJson<CreatorSourceManifest>(row.source_manifest_json),
    validation: parseJson<FreeVersionRecord["validation"]>(row.validation_json),
    approvedMetadata: row.approved_metadata_json ? { ...parseJson<FreeWorkMetadata>(row.approved_metadata_json),
      creatorDouyinNumber: parseJson<FreeWorkMetadata>(row.approved_metadata_json).creatorDouyinNumber ?? null } : null,
    deliveryBytesUpperBound: Number(row.delivery_bytes_upper_bound), createdAt: new Date(row.created_at).toISOString()
  };
}
function review(row: RowDataPacket): FreeReviewRecord {
  return { reviewId: row.review_id, appearanceNumber: appearanceNumberFromSerial(row.appearance_serial), versionId: row.version_id, workId: row.work_id, state: row.state,
    metadata: parseJson<FreeWorkMetadata>(row.metadata_snapshot_json), reason: row.decision_reason,
    submittedAt: new Date(row.submitted_at).toISOString(), autoReview: publicAutoReview(row.checks_json) };
}

export type CreatorPublicationObserver = (connection: PoolConnection, event: {
  creatorId: string; workId: string; versionId: string; reviewId: string; contentFingerprint: string
}) => Promise<void>;

export class FreeCreatorRepository {
  readonly #pool: Pool;
  #lastRateCleanup = 0;
  #publicationObserver: CreatorPublicationObserver | null = null;
  get pool(): Pool { return this.#pool; }

  // The v2 distribution service is the sole contribution owner. Its observer
  // shares this transaction, so a failed contribution write rolls publication back.
  setPublicationObserver(observer: CreatorPublicationObserver): void { this.#publicationObserver = observer; }

  async #publication(connection: PoolConnection, event: Parameters<CreatorPublicationObserver>[1]): Promise<void> {
    if (process.env.GONGDE_FREE_DISTRIBUTION_ENABLED !== "true") return;
    if (!/^[a-f0-9]{64}$/u.test(event.contentFingerprint)) throw new CreatorError("creator_content_fingerprint_required", 503);
    if (!this.#publicationObserver) throw new CreatorError("creator_publication_observer_unavailable", 503);
    try { await this.#publicationObserver(connection, event); }
    catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "contribution_duplicate_content" || code === "contribution_sample_excluded") {
        throw new CreatorError("creator_duplicate_work", 409);
      }
      throw error;
    }
  }

  async #publicNumber(connection: PoolConnection, creatorId: string): Promise<string | null> {
    if (process.env.GONGDE_FREE_DISTRIBUTION_ENABLED !== "true") return null;
    const { ensureFreeCreatorPublicNumber } = await import("../free-distribution/repository.js");
    return ensureFreeCreatorPublicNumber(connection, creatorId);
  }

  async ensureCreatorPublicNumber(creatorId: string): Promise<string | null> {
    if (process.env.GONGDE_FREE_DISTRIBUTION_ENABLED !== "true") return null;
    return this.#transaction(connection => this.#publicNumber(connection, creatorId));
  }

  constructor(configuration: GongdeMySqlConfiguration, pool?: Pool) {
    this.#pool = pool ?? createPool({ ...configuration, connectionLimit: 2,
      waitForConnections: true, queueLimit: 16, timezone: "Z", charset: "utf8mb4", multipleStatements: false });
  }

  async #rows(executor: Executor, sql: string, values: SqlValues = []): Promise<RowDataPacket[]> {
    const [rows] = await executor.execute<RowDataPacket[]>(sql, values);
    return rows;
  }

  async #write(executor: Executor, sql: string, values: SqlValues = []): Promise<ResultSetHeader> {
    const [result] = await executor.execute<ResultSetHeader>(sql, values);
    return result;
  }

  async #transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async #audit(connection: PoolConnection, actorKind: "creator" | "admin", actorReference: string,
    action: string, subject: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.#write(connection,
      `INSERT INTO gongde_creator_audit
       (audit_id, actor_kind, actor_reference, action, subject_reference, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id(), actorKind, actorReference, action, subject, JSON.stringify(detail), new Date()]);
  }

  async #ownedWork(connection: PoolConnection, creatorId: string, workId: string): Promise<FreeWorkRecord> {
    const rows = await this.#rows(connection,
      `SELECT w.*, n.appearance_serial FROM gongde_creator_works w
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
       WHERE w.work_id = ? AND w.creator_id = ? FOR UPDATE`, [workId, creatorId]);
    if (!rows[0]) throw new CreatorError("creator_work_not_found", 404);
    if (![0, 20].includes(Number(rows[0].price_fen))) throw new CreatorError("creator_work_unavailable", 409);
    return work(rows[0]);
  }

  async #requireEditable(connection: PoolConnection, workId: string): Promise<void> {
    const pending = await this.#rows(connection,
      "SELECT version_id FROM gongde_creator_work_versions WHERE work_id = ? AND state = 'PENDING_REVIEW' LIMIT 1", [workId]);
    if (pending.length) throw new CreatorError("creator_review_pending", 409);
  }

  async #withdrawPending(connection: PoolConnection, workId: string): Promise<void> {
    const pending = await this.#rows(connection,
      "SELECT version_id FROM gongde_creator_work_versions WHERE work_id = ? AND state = 'PENDING_REVIEW' FOR UPDATE", [workId]);
    for (const row of pending) {
      await this.#write(connection,
        `UPDATE gongde_creator_reviews SET state = 'REJECTED', decision_reason = ?,
         checks_json = JSON_SET(COALESCE(checks_json, JSON_OBJECT()), '$.withdrawn', true), decided_at = ?
         WHERE version_id = ? AND state = 'PENDING'`, ["作者已撤回发布意图，本轮结果不再生效。", new Date(), row.version_id]);
      await this.#write(connection,
        "UPDATE gongde_creator_work_versions SET state = 'REJECTED' WHERE version_id = ? AND state = 'PENDING_REVIEW'", [row.version_id]);
    }
  }

  async withdrawReview(creatorId: string, workId: string): Promise<void> {
    await this.#transaction(async connection => {
      await this.#ownedWork(connection, creatorId, workId);
      await this.#withdrawPending(connection, workId);
      await this.#audit(connection, "creator", creatorId, "review.withdraw", workId);
    });
  }

  async consumeLimit(scope: string, key: string, limit: number, windowSeconds: number, now = new Date(), utcOffsetSeconds = 0): Promise<void> {
    const offset = utcOffsetSeconds * 1000;
    const bucket = Math.floor((now.getTime() + offset) / (windowSeconds * 1000));
    const digest = createHash("sha256").update(`${scope}\0${key}\0${bucket}`).digest("hex");
    const expiresAt = new Date((bucket + 1) * windowSeconds * 1000 - offset);
    await this.#transaction(async connection => {
      await this.#write(connection,
        "INSERT IGNORE INTO gongde_creator_rate_limits (bucket_digest, hits, expires_at) VALUES (?, 0, ?)", [digest, expiresAt]);
      const rows = await this.#rows(connection,
        "SELECT hits FROM gongde_creator_rate_limits WHERE bucket_digest = ? FOR UPDATE", [digest]);
      if (Number(rows[0]?.hits) >= limit) throw new CreatorError("creator_rate_limited", 429);
      await this.#write(connection, "UPDATE gongde_creator_rate_limits SET hits = hits + 1 WHERE bucket_digest = ?", [digest]);
    });
    if (now.getTime() - this.#lastRateCleanup > 300000) {
      this.#lastRateCleanup = now.getTime();
      await this.#write(this.#pool, "DELETE FROM gongde_creator_rate_limits WHERE expires_at < ? LIMIT 1000", [now]);
    }
  }

  async findAccount(username: string): Promise<CreatorAccountRecord | null> {
    const rows = await this.#rows(this.#pool, "SELECT * FROM gongde_creators WHERE username = ?", [username]);
    return rows[0] ? account(rows[0]) : null;
  }

  async createAccount(input: CreatorAccountRecord, termsVersion: string, termsSha256: string): Promise<void> {
    await this.#transaction(async connection => {
      await this.#write(connection,
        `INSERT INTO gongde_creators
         (creator_id, email, username, password_hash, recovery_digest, display_name, biography,
          state, paid_eligibility, accepted_terms_version, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, '', 'ACTIVE', 'NOT_REQUESTED', ?, ?, ?)`,
        [input.creatorId, input.username, input.passwordHash, input.recoveryDigest, input.displayName, termsVersion, new Date(), new Date()]);
      await this.#write(connection,
        `INSERT INTO gongde_creator_agreements
         (agreement_id, creator_id, terms_version, terms_sha256, accepted_at) VALUES (?, ?, ?, ?, ?)`,
        [id(), input.creatorId, termsVersion, termsSha256, new Date()]);
      await this.#audit(connection, "creator", input.creatorId, "account.create", input.creatorId);
    });
  }

  async createSession(creatorId: string, expectedPasswordHash: string, digest: string, expiresAt: Date): Promise<void> {
    await this.#transaction(async connection => {
      const rows = await this.#rows(connection, "SELECT * FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [creatorId]);
      if (rows[0]?.state !== "ACTIVE" || rows[0].password_hash !== expectedPasswordHash) {
        throw new CreatorError("creator_login_failed", 401);
      }
      await this.#saveSession(connection, creatorId, digest, expiresAt);
    });
  }

  async #saveSession(connection: PoolConnection, creatorId: string, digest: string, expiresAt: Date): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(digest) || !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) {
      throw new CreatorError("creator_session_invalid", 503);
    }
    await this.#write(connection,
      "DELETE FROM gongde_creator_tokens WHERE creator_id = ? AND purpose = 'session' AND expires_at <= ?", [creatorId, new Date()]);
    const sessions = await this.#rows(connection,
      "SELECT token_digest FROM gongde_creator_tokens WHERE creator_id = ? AND purpose = 'session' ORDER BY created_at DESC", [creatorId]);
    for (const old of sessions.slice(4)) await this.#write(connection,
      "DELETE FROM gongde_creator_tokens WHERE token_digest = ?", [old.token_digest]);
    await this.#write(connection,
      `INSERT INTO gongde_creator_tokens
       (token_digest, creator_id, purpose, created_at, expires_at, consumed_at) VALUES (?, ?, 'session', ?, ?, NULL)`,
      [digest, creatorId, new Date(), expiresAt]);
  }

  // Used only after the existing password/register path has issued its token.
  // A revoked or expired token cannot be extended or resurrected.
  async setSessionExpiry(digest: string, expiresAt: Date): Promise<void> {
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() ||
        expiresAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) throw new CreatorError("creator_session_invalid", 503);
    await this.#transaction(async connection => {
      const rows = await this.#rows(connection,
        `SELECT t.token_digest FROM gongde_creators c JOIN gongde_creator_tokens t ON t.creator_id = c.creator_id
         WHERE t.token_digest = ? AND t.purpose = 'session' AND t.consumed_at IS NULL
           AND t.expires_at > ? AND c.state = 'ACTIVE' FOR UPDATE`, [digest, new Date()]);
      if (!rows[0]) throw new CreatorError("creator_auth_required", 401);
      await this.#write(connection,
        "UPDATE gongde_creator_tokens SET expires_at = ? WHERE token_digest = ? AND purpose = 'session'", [expiresAt, digest]);
    });
  }

  async phoneAuthReady(): Promise<boolean> {
    try {
      await this.#rows(this.#pool, "SELECT phone_identity_digest, creator_id FROM gongde_creator_phone_identities LIMIT 0");
      return true;
    } catch { return false; }
  }

  async findPhoneAccount(phoneIdentityDigest: string): Promise<CreatorAccountRecord | null> {
    if (!/^[a-f0-9]{64}$/u.test(phoneIdentityDigest)) throw new CreatorError("creator_phone_auth_unavailable", 503);
    const rows = await this.#rows(this.#pool,
      `SELECT c.* FROM gongde_creator_phone_identities p JOIN gongde_creators c ON c.creator_id = p.creator_id
       WHERE p.phone_identity_digest = ?`, [phoneIdentityDigest]);
    return rows[0] ? account(rows[0]) : null;
  }

  async loginPhone(phoneIdentityDigest: string, registration: CreatorAccountRecord | null,
    termsVersion: string, termsSha256: string, sessionDigest: string, expiresAt: Date
  ): Promise<{ account: CreatorAccountRecord; created: boolean }> {
    if (!/^[a-f0-9]{64}$/u.test(phoneIdentityDigest)) throw new CreatorError("creator_phone_auth_unavailable", 503);
    return this.#transaction(async connection => {
      const rows = await this.#rows(connection,
        `SELECT c.* FROM gongde_creator_phone_identities p JOIN gongde_creators c ON c.creator_id = p.creator_id
         WHERE p.phone_identity_digest = ? FOR UPDATE`, [phoneIdentityDigest]);
      let current: CreatorAccountRecord;
      const created = !rows[0];
      if (rows[0]) {
        current = account(rows[0]);
        if (current.state !== "ACTIVE") throw new CreatorError("creator_auth_required", 401);
      } else {
        if (!registration) throw new CreatorError("creator_terms_acceptance_required", 428);
        // '~' cannot be registered through the legacy username validator.
        if (!/^~phone_[a-f0-9]{24}$/u.test(registration.username) ||
            registration.passwordHash !== "phone-only-v1" || registration.recoveryDigest !== null ||
            termsVersion !== FREE_CREATOR_TERMS_VERSION || !/^[a-f0-9]{64}$/u.test(termsSha256)) {
          throw new CreatorError("creator_registration_invalid");
        }
        current = registration;
        await this.#write(connection,
          `INSERT INTO gongde_creators
           (creator_id, email, username, password_hash, recovery_digest, display_name, biography,
            state, paid_eligibility, accepted_terms_version, created_at, updated_at)
           VALUES (?, NULL, ?, ?, NULL, ?, '', 'ACTIVE', 'NOT_REQUESTED', ?, ?, ?)`,
          [current.creatorId, current.username, current.passwordHash, current.displayName, termsVersion, new Date(), new Date()]);
        await this.#write(connection,
          `INSERT INTO gongde_creator_phone_identities (phone_identity_digest, creator_id, created_at)
           VALUES (?, ?, ?)`, [phoneIdentityDigest, current.creatorId, new Date()]);
        await this.#write(connection,
          `INSERT INTO gongde_creator_agreements
           (agreement_id, creator_id, terms_version, terms_sha256, accepted_at) VALUES (?, ?, ?, ?, ?)`,
          [id(), current.creatorId, termsVersion, termsSha256, new Date()]);
        await this.#audit(connection, "creator", current.creatorId, "account.phone.create", current.creatorId);
      }
      await this.#saveSession(connection, current.creatorId, sessionDigest, expiresAt);
      current.publicNumber = await this.#publicNumber(connection, current.creatorId);
      return { account: current, created };
    });
  }

  async bindPhone(creatorId: string, sessionDigest: string, phoneIdentityDigest: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(phoneIdentityDigest)) throw new CreatorError("creator_phone_auth_unavailable", 503);
    await this.#transaction(async connection => {
      // Revalidate the actual caller's revocable session after SMS verification.
      const owners = await this.#rows(connection,
        `SELECT c.creator_id FROM gongde_creators c JOIN gongde_creator_tokens t ON t.creator_id = c.creator_id
         WHERE c.creator_id = ? AND c.state = 'ACTIVE' AND t.token_digest = ? AND t.purpose = 'session'
           AND t.consumed_at IS NULL AND t.expires_at > ? FOR UPDATE`, [creatorId, sessionDigest, new Date()]);
      if (!owners[0]) throw new CreatorError("creator_auth_required", 401);
      const bindings = await this.#rows(connection,
        `SELECT phone_identity_digest, creator_id FROM gongde_creator_phone_identities
         WHERE phone_identity_digest = ? OR creator_id = ? FOR UPDATE`, [phoneIdentityDigest, creatorId]);
      if (bindings.some(row => row.creator_id !== creatorId || row.phone_identity_digest !== phoneIdentityDigest)) {
        throw new CreatorError("creator_phone_already_bound", 409);
      }
      if (bindings.length) return;
      await this.#write(connection,
        "INSERT INTO gongde_creator_phone_identities (phone_identity_digest, creator_id, created_at) VALUES (?, ?, ?)",
        [phoneIdentityDigest, creatorId, new Date()]);
      await this.#audit(connection, "creator", creatorId, "account.phone.bind", creatorId);
    });
  }

  async session(digest: string): Promise<CreatorAccountRecord | null> {
    const rows = await this.#rows(this.#pool,
      `SELECT c.* FROM gongde_creators c JOIN gongde_creator_tokens t ON t.creator_id = c.creator_id
       WHERE t.token_digest = ? AND t.purpose = 'session' AND t.consumed_at IS NULL
         AND t.expires_at > ? AND c.state = 'ACTIVE'`, [digest, new Date()]);
    if (!rows[0]) return null;
    const current = account(rows[0]);
    current.publicNumber = await this.ensureCreatorPublicNumber(current.creatorId);
    return current;
  }

  async phoneBound(creatorId: string): Promise<boolean> {
    const rows = await this.#rows(this.#pool,
      "SELECT creator_id FROM gongde_creator_phone_identities WHERE creator_id = ? LIMIT 1", [creatorId]);
    return rows.length > 0;
  }

  async deleteSession(digest: string): Promise<void> {
    await this.#write(this.#pool, "DELETE FROM gongde_creator_tokens WHERE token_digest = ? AND purpose = 'session'", [digest]);
  }

  async recoverAccount(creatorId: string, expectedRecoveryDigest: string, passwordHash: string, recoveryDigest: string): Promise<void> {
    await this.#transaction(async connection => {
      const rows = await this.#rows(connection, "SELECT * FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [creatorId]);
      if (rows[0]?.state !== "ACTIVE" || rows[0].recovery_digest !== expectedRecoveryDigest) {
        throw new CreatorError("creator_recovery_failed", 401);
      }
      await this.#write(connection,
        "UPDATE gongde_creators SET password_hash = ?, recovery_digest = ?, updated_at = ? WHERE creator_id = ?",
        [passwordHash, recoveryDigest, new Date(), creatorId]);
      await this.#write(connection, "DELETE FROM gongde_creator_tokens WHERE creator_id = ? AND purpose = 'session'", [creatorId]);
      await this.#audit(connection, "creator", creatorId, "account.recover", creatorId);
    });
  }

  async createWork(creatorId: string, workId: string, slug: string, metadata: FreeWorkMetadata): Promise<void> {
    await this.#transaction(async connection => {
      const rows = await this.#rows(connection, "SELECT state FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [creatorId]);
      if (rows[0]?.state !== "ACTIVE") throw new CreatorError("creator_auth_required", 401);
      const count = await this.#rows(connection, "SELECT COUNT(*) AS total FROM gongde_creator_works WHERE creator_id = ?", [creatorId]);
      if (Number(count[0]?.total) >= 100) throw new CreatorError("creator_work_limit", 409);
      await registerCommunityAppearanceNumber(connection, workId);
      await this.#write(connection,
        `INSERT INTO gongde_creator_works
         (work_id, creator_id, slug, title_zh, description, tags_json, creator_douyin_number, sharing_terms_version,
          state, price_fen, published_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 0, NULL, ?, ?)`,
        [workId, creatorId, slug, metadata.titleZh, metadata.description, JSON.stringify(metadata.tags),
          metadata.creatorDouyinNumber ?? null, FREE_CREATOR_TERMS_VERSION, new Date(), new Date()]);
      await this.#audit(connection, "creator", creatorId, "work.create", workId);
    });
  }

  async updateWork(creatorId: string, workId: string, metadata: FreeWorkMetadata): Promise<void> {
    await this.#transaction(async connection => {
      const current = await this.#ownedWork(connection, creatorId, workId);
      if (current.state === "SUSPENDED") throw new CreatorError("creator_work_suspended", 409);
      await this.#requireEditable(connection, workId);
      await this.#write(connection,
        `UPDATE gongde_creator_works SET title_zh = ?, description = ?, tags_json = ?,
         creator_douyin_number = ?, sharing_terms_version = ?, price_fen = 0, updated_at = ? WHERE work_id = ?`,
        [metadata.titleZh, metadata.description, JSON.stringify(metadata.tags), metadata.creatorDouyinNumber ?? null,
          FREE_CREATOR_TERMS_VERSION, new Date(), workId]);
      await this.#audit(connection, "creator", creatorId, "work.edit_draft", workId);
    });
  }

  async ownedWork(creatorId: string, workId: string): Promise<FreeWorkRecord> {
    const rows = await this.#rows(this.#pool,
      `SELECT w.*, n.appearance_serial FROM gongde_creator_works w
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
       WHERE w.work_id = ? AND w.creator_id = ?`, [workId, creatorId]);
    if (!rows[0]) throw new CreatorError("creator_work_not_found", 404);
    return work(rows[0]);
  }

  async ownedWorks(creatorId: string): Promise<FreeWorkRecord[]> {
    return (await this.#rows(this.#pool,
      `SELECT w.*, n.appearance_serial FROM gongde_creator_works w
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
       WHERE w.creator_id = ? ORDER BY w.updated_at DESC LIMIT 100`, [creatorId])).map(work);
  }

  async versions(creatorId: string, workId: string): Promise<FreeVersionRecord[]> {
    await this.ownedWork(creatorId, workId);
    return (await this.#rows(this.#pool,
      `SELECT v.*, w.creator_id, w.slug FROM gongde_creator_work_versions v
       JOIN gongde_creator_works w ON w.work_id = v.work_id
       WHERE v.work_id = ? AND w.creator_id = ? ORDER BY v.created_at DESC LIMIT 20`, [workId, creatorId])).map(version);
  }

  async getVersion(versionId: string): Promise<FreeVersionRecord> {
    const rows = await this.#rows(this.#pool,
      `SELECT v.*, w.creator_id, w.slug FROM gongde_creator_work_versions v
       JOIN gongde_creator_works w ON w.work_id = v.work_id WHERE v.version_id = ?`, [versionId]);
    if (!rows[0]) throw new CreatorError("creator_version_not_found", 404);
    return version(rows[0]);
  }

  async saveVersion(creatorId: string, input: FreeVersionRecord): Promise<void> {
    await this.#transaction(async connection => {
      const current = await this.#ownedWork(connection, creatorId, input.workId);
      if (current.state === "SUSPENDED") throw new CreatorError("creator_work_suspended", 409);
      await this.#requireEditable(connection, input.workId);
      const count = await this.#rows(connection, "SELECT COUNT(*) AS total FROM gongde_creator_work_versions WHERE work_id = ?", [input.workId]);
      if (Number(count[0]?.total) >= 20) throw new CreatorError("creator_version_limit", 409);
      await this.#write(connection,
        `INSERT INTO gongde_creator_work_versions
         (version_id, work_id, version_label, source_revision, archive_sha256, source_object_key, preview_object_key,
          source_manifest_json, validation_json, state, schema_version, archive_bytes, unpacked_bytes,
          decoded_image_bytes, delivery_bytes_upper_bound, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?)`,
        [input.versionId, input.workId, input.versionLabel, input.revision, input.archiveSha256,
          input.sourceObjectKey, input.previewObjectKey, JSON.stringify(input.manifest), JSON.stringify(input.validation),
          input.manifest.schema_version, input.validation.archiveBytes, input.validation.unpackedBytes,
          input.validation.decodedImageBytes, input.deliveryBytesUpperBound, new Date()]);
      await this.#audit(connection, "creator", creatorId, "version.upload", input.versionId,
        { revision: input.revision, archiveSha256: input.archiveSha256 });
    });
  }

  async #cloneDraft(connection: PoolConnection, workId: string, originalVersionId: string): Promise<string> {
    const count = await this.#rows(connection, "SELECT COUNT(*) AS total FROM gongde_creator_work_versions WHERE work_id = ?", [workId]);
    if (Number(count[0]?.total) >= 20) throw new CreatorError("creator_version_limit", 409);
    const freshVersionId = id();
    await this.#write(connection,
      `INSERT INTO gongde_creator_work_versions
       (version_id, work_id, version_label, source_revision, archive_sha256, source_object_key, preview_object_key,
        source_manifest_json, validation_json, state, schema_version, archive_bytes, unpacked_bytes,
        decoded_image_bytes, delivery_bytes_upper_bound, created_at)
       SELECT ?, work_id, version_label, source_revision, archive_sha256, source_object_key, preview_object_key,
         source_manifest_json, validation_json, 'READY', schema_version, archive_bytes, unpacked_bytes,
         decoded_image_bytes, delivery_bytes_upper_bound, ? FROM gongde_creator_work_versions WHERE version_id = ?`,
      [freshVersionId, new Date(), originalVersionId]);
    return freshVersionId;
  }

  async prepareDraftVersion(creatorId: string, workId: string): Promise<string | null> {
    return this.#transaction(async connection => {
      const current = await this.#ownedWork(connection, creatorId, workId);
      if (current.state === "SUSPENDED") throw new CreatorError("creator_work_suspended", 409);
      await this.#requireEditable(connection, workId);
      const ready = await this.#rows(connection,
        "SELECT version_id FROM gongde_creator_work_versions WHERE work_id = ? AND state = 'READY' ORDER BY created_at DESC LIMIT 1", [workId]);
      if (ready[0]) return String(ready[0].version_id);
      if (!current.publishedVersionId) return null;
      const published = await this.#rows(connection,
        "SELECT state FROM gongde_creator_work_versions WHERE version_id = ? AND work_id = ? FOR UPDATE", [current.publishedVersionId, workId]);
      if (published[0]?.state !== "APPROVED") throw new CreatorError("creator_version_not_ready", 409);
      return this.#cloneDraft(connection, workId, current.publishedVersionId);
    });
  }

  async submit(creatorId: string, workId: string, versionId: string, acceptAiContentReview = false): Promise<string> {
    return this.#transaction(async connection => {
      const current = await this.#ownedWork(connection, creatorId, workId);
      if (current.state === "SUSPENDED") throw new CreatorError("creator_work_suspended", 409);
      if (!acceptAiContentReview || current.metadata.priceFen !== 0 || current.metadata.sharingTermsVersion !== FREE_CREATOR_TERMS_VERSION) {
        throw new CreatorError("creator_free_terms_required", 409);
      }
      await this.#requireEditable(connection, workId);
      const validated = parseCreatorMetadata({ titleZh: current.metadata.titleZh, description: current.metadata.description,
        tags: current.metadata.tags, creatorDouyinNumber: current.metadata.creatorDouyinNumber });
      const versions = await this.#rows(connection,
        "SELECT * FROM gongde_creator_work_versions WHERE version_id = ? AND work_id = ? FOR UPDATE", [versionId, workId]);
      if (!versions[0] || !["READY", "REJECTED", "APPROVED"].includes(versions[0].state)) throw new CreatorError("creator_version_not_ready", 409);
      // Any reviewed identity stays immutable, even for a text-only update.
      if (versions[0].state !== "READY") {
        const count = await this.#rows(connection,
          "SELECT COUNT(*) AS total FROM gongde_creator_work_versions WHERE work_id = ?", [workId]);
        if (Number(count[0]?.total) >= 20) throw new CreatorError("creator_version_limit", 409);
        const freshVersionId = id();
        await this.#write(connection,
          `INSERT INTO gongde_creator_work_versions
           (version_id, work_id, version_label, source_revision, archive_sha256, source_object_key, preview_object_key,
            source_manifest_json, validation_json, state, schema_version, archive_bytes, unpacked_bytes,
            decoded_image_bytes, delivery_bytes_upper_bound, created_at)
           SELECT ?, work_id, version_label, source_revision, archive_sha256, source_object_key, preview_object_key,
             source_manifest_json, validation_json, 'READY', schema_version, archive_bytes, unpacked_bytes,
             decoded_image_bytes, delivery_bytes_upper_bound, ? FROM gongde_creator_work_versions WHERE version_id = ?`,
          [freshVersionId, new Date(), versionId]);
        versionId = freshVersionId;
      }
      const previous = await this.#rows(connection, "SELECT COALESCE(MAX(review_round), 0) AS round FROM gongde_creator_reviews WHERE version_id = ?", [versionId]);
      if (Number(previous[0]?.round) >= 20) throw new CreatorError("creator_review_limit", 409);
      const creator = await this.#rows(connection, "SELECT display_name, state FROM gongde_creators WHERE creator_id = ?", [creatorId]);
      if (creator[0]?.state !== "ACTIVE") throw new CreatorError("creator_auth_required", 401);
      const publicNumber = await this.#publicNumber(connection, creatorId);
      const snapshot: FreeWorkMetadata = { ...validated, acceptFreeDistribution: true,
        acceptAiContentReview: true, sharingTermsSha256: FREE_CREATOR_TERMS_SHA256,
        aiReviewTermsVersion: FREE_CREATOR_AI_TERMS_VERSION, aiReviewTermsSha256: FREE_CREATOR_AI_TERMS_SHA256,
        publicTextSha256: creatorPublicTextDigest(validated),
        creatorName: publicNumber ? "作者 " + publicNumber : String(creator[0].display_name) };
      const reviewId = id();
      await this.#write(connection,
        `INSERT INTO gongde_creator_free_consents
         (consent_id, creator_id, work_id, version_id, terms_version, terms_sha256, ai_terms_version,
          ai_terms_sha256, public_text_sha256, metadata_snapshot_json, review_id, source_revision, archive_sha256, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), creatorId, workId, versionId, FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS_SHA256,
          FREE_CREATOR_AI_TERMS_VERSION, FREE_CREATOR_AI_TERMS_SHA256, snapshot.publicTextSha256!, JSON.stringify(snapshot),
          reviewId, versions[0].source_revision, versions[0].archive_sha256, new Date()]);
      await this.#write(connection,
        `INSERT INTO gongde_creator_reviews
         (review_id, version_id, review_round, state, metadata_snapshot_json, submitted_at)
         VALUES (?, ?, ?, 'PENDING', ?, ?)`,
        [reviewId, versionId, Number(previous[0]?.round) + 1, JSON.stringify(snapshot), new Date()]);
      await this.#write(connection, "UPDATE gongde_creator_work_versions SET state = 'PENDING_REVIEW' WHERE version_id = ?", [versionId]);
      await this.#audit(connection, "creator", creatorId, "review.submit", reviewId, { versionId });
      return reviewId;
    });
  }

  async reviews(state = "PENDING", offset = 0): Promise<FreeReviewRecord[]> {
    return (await this.#rows(this.#pool,
      `SELECT r.*, v.work_id, n.appearance_serial FROM gongde_creator_reviews r JOIN gongde_creator_work_versions v ON v.version_id = r.version_id
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = v.work_id
       WHERE r.state = ? ORDER BY r.submitted_at ASC LIMIT 50 OFFSET ${offset}`, [state])).map(review);
  }

  // A free projection is separate from the immutable original approval, including
  // legacy paid approvals. All bytes/text/evidence bindings are rechecked here.
  async #freeEvidence(executor: Executor, uploaded: FreeVersionRecord): Promise<{ metadata: FreeWorkMetadata; reviewId: string } | null> {
    const consents = await this.#rows(executor,
      `SELECT * FROM gongde_creator_free_consents WHERE version_id = ? AND creator_id = ? AND work_id = ?
       AND terms_version = ? AND terms_sha256 = ? AND ai_terms_version = ? AND ai_terms_sha256 = ? LIMIT 1`,
      [uploaded.versionId, uploaded.creatorId, uploaded.workId, FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS_SHA256,
        FREE_CREATOR_AI_TERMS_VERSION, FREE_CREATOR_AI_TERMS_SHA256]);
    const consent = consents[0];
    if (!consent?.metadata_snapshot_json || consent.source_revision !== uploaded.revision ||
        consent.archive_sha256 !== uploaded.archiveSha256 || !uploaded.approvedMetadata) return null;
    const metadata = parseJson<FreeWorkMetadata>(consent.metadata_snapshot_json);
    if (!hasCurrentFreeConsent(metadata) || metadata.publicTextSha256 !== consent.public_text_sha256 ||
        creatorPublicTextDigest(uploaded.approvedMetadata) !== metadata.publicTextSha256) return null;
    const reviews = await this.#rows(executor,
      `SELECT metadata_snapshot_json, checks_json FROM gongde_creator_reviews
       WHERE review_id = ? AND version_id = ? AND state = 'APPROVED'`, [consent.review_id, uploaded.versionId]);
    if (!reviews[0]?.metadata_snapshot_json) return null;
    const original = parseJson<FreeWorkMetadata>(reviews[0].metadata_snapshot_json);
    const checks = reviews[0].checks_json ? parseJson<Record<string, unknown>>(reviews[0].checks_json) : {};
    if (creatorPublicTextDigest(original) !== metadata.publicTextSha256 ||
        ["dataOnly", "realPreview", "contentAcceptable", "rightsDeclaration"].some(key => checks[key] !== true)) return null;
    return { metadata, reviewId: String(consent.review_id) };
  }

  async grantFreeConsent(creatorId: string, workId: string, versionId: string, expectedRevision: string,
    expectedArchiveSha256: string, contentFingerprint: string): Promise<void> {
    await this.#transaction(async connection => {
      const current = await this.#ownedWork(connection, creatorId, workId);
      if (current.state === "SUSPENDED" || current.publishedVersionId !== versionId || !current.publishedMetadata) {
        throw new CreatorError("creator_free_consent_requires_review", 409);
      }
      await this.#requireEditable(connection, workId);
      const owners = await this.#rows(connection, "SELECT state FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [creatorId]);
      if (owners[0]?.state !== "ACTIVE") throw new CreatorError("creator_auth_required", 401);
      const versions = await this.#rows(connection,
        "SELECT * FROM gongde_creator_work_versions WHERE version_id = ? AND work_id = ? FOR UPDATE", [versionId, workId]);
      const row = versions[0];
      if (!row || row.state !== "APPROVED" || row.source_revision !== expectedRevision || row.archive_sha256 !== expectedArchiveSha256 ||
          !row.approved_metadata_json) throw new CreatorError("creator_free_consent_requires_review", 409);
      const original = parseJson<FreeWorkMetadata>(row.approved_metadata_json);
      const draft = parseCreatorMetadata({ titleZh: current.metadata.titleZh, description: current.metadata.description,
        tags: current.metadata.tags, creatorDouyinNumber: current.metadata.creatorDouyinNumber });
      const textDigest = creatorPublicTextDigest(original);
      if (creatorPublicTextDigest(draft) !== textDigest || creatorPublicTextDigest(current.publishedMetadata) !== textDigest) {
        throw new CreatorError("creator_free_consent_requires_review", 409);
      }
      const uploaded = version({ ...row, creator_id: creatorId, slug: current.slug } as RowDataPacket);
      const existing = await this.#freeEvidence(connection, uploaded);
      if (existing && hasCurrentFreeConsent(current.publishedMetadata)) return;
      const reviews = await this.#rows(connection,
        "SELECT * FROM gongde_creator_reviews WHERE version_id = ? AND state = 'APPROVED' ORDER BY review_round DESC LIMIT 1 FOR UPDATE", [versionId]);
      const reviewed = reviews[0];
      const checks = reviewed?.checks_json ? parseJson<Record<string, unknown>>(reviewed.checks_json) : {};
      if (!reviewed?.metadata_snapshot_json || creatorPublicTextDigest(parseJson<FreeWorkMetadata>(reviewed.metadata_snapshot_json)) !== textDigest ||
          ["dataOnly", "realPreview", "contentAcceptable", "rightsDeclaration"].some(key => checks[key] !== true)) {
        throw new CreatorError("creator_free_consent_requires_review", 409);
      }
      const publicNumber = await this.#publicNumber(connection, creatorId);
      const snapshot: FreeWorkMetadata = { ...draft, creatorName: publicNumber ? "作者 " + publicNumber : original.creatorName,
        acceptFreeDistribution: true, acceptAiContentReview: true, sharingTermsSha256: FREE_CREATOR_TERMS_SHA256,
        aiReviewTermsVersion: FREE_CREATOR_AI_TERMS_VERSION, aiReviewTermsSha256: FREE_CREATOR_AI_TERMS_SHA256,
        publicTextSha256: textDigest };
      await this.#write(connection,
        `INSERT INTO gongde_creator_free_consents
         (consent_id, creator_id, work_id, version_id, terms_version, terms_sha256, ai_terms_version,
          ai_terms_sha256, public_text_sha256, metadata_snapshot_json, review_id, source_revision, archive_sha256, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), creatorId, workId, versionId, FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS_SHA256,
          FREE_CREATOR_AI_TERMS_VERSION, FREE_CREATOR_AI_TERMS_SHA256, textDigest, JSON.stringify(snapshot),
          reviewed.review_id, expectedRevision, expectedArchiveSha256, new Date()]);
      await this.#write(connection,
        `UPDATE gongde_creator_works SET published_metadata_json = ?, price_fen = 0, sharing_terms_version = ?, updated_at = ? WHERE work_id = ?`,
        [JSON.stringify(snapshot), FREE_CREATOR_TERMS_VERSION, new Date(), workId]);
      if (current.state === "PUBLISHED") await this.#publication(connection,
        { creatorId, workId, versionId, reviewId: String(reviewed.review_id), contentFingerprint });
      await this.#audit(connection, "creator", creatorId, "work.free_consent", workId,
        { versionId, reviewId: reviewed.review_id, sourceRevision: expectedRevision, publicTextSha256: textDigest,
          sharingTermsVersion: FREE_CREATOR_TERMS_VERSION, aiReviewTermsVersion: FREE_CREATOR_AI_TERMS_VERSION });
    });
  }

  async decide(admin: string, reviewId: string, decision: "APPROVED" | "REJECTED", reason: string,
    checks: Record<string, boolean>, automatic?: { leaseId: string; versionId: string; revision: string;
      archiveSha256: string; contentFingerprint?: string; evidence: Record<string, unknown> }, verifiedContentFingerprint?: string): Promise<void> {
    const pointers = await this.#rows(this.#pool,
      `SELECT r.version_id, v.work_id FROM gongde_creator_reviews r
       JOIN gongde_creator_work_versions v ON v.version_id = r.version_id WHERE r.review_id = ?`, [reviewId]);
    if (!pointers[0]) throw new CreatorError("creator_review_not_found", 404);
    await this.#transaction(async connection => {
      const works = await this.#rows(connection, "SELECT * FROM gongde_creator_works WHERE work_id = ? FOR UPDATE", [pointers[0].work_id]);
      const versions = await this.#rows(connection, "SELECT * FROM gongde_creator_work_versions WHERE version_id = ? FOR UPDATE", [pointers[0].version_id]);
      const reviews = await this.#rows(connection, "SELECT * FROM gongde_creator_reviews WHERE review_id = ? FOR UPDATE", [reviewId]);
      const current = works[0], submitted = reviews[0], uploaded = versions[0];
      if (!current || !uploaded || submitted?.state !== "PENDING" || uploaded.state !== "PENDING_REVIEW") {
        throw new CreatorError("creator_review_changed", 409);
      }
      if (current.state === "SUSPENDED" || Number(current.price_fen) !== 0) throw new CreatorError("creator_work_unavailable", 409);
      const previousChecks = submitted.checks_json ? parseJson<Record<string, unknown>>(submitted.checks_json) : {};
      const auto = previousChecks.autoReview as Record<string, unknown> | undefined;
      if (automatic) {
        if (auto?.state !== "running" || auto.leaseId !== automatic.leaseId || Number(auto.leaseUntil) <= Date.now() ||
            uploaded.version_id !== automatic.versionId || uploaded.source_revision !== automatic.revision ||
            uploaded.archive_sha256 !== automatic.archiveSha256) throw new CreatorError("creator_review_changed", 409);
      }
      const creators = await this.#rows(connection, "SELECT state FROM gongde_creators WHERE creator_id = ?", [current.creator_id]);
      if (creators[0]?.state !== "ACTIVE") throw new CreatorError("creator_work_unavailable", 409);
      const metadata = parseJson<FreeWorkMetadata>(submitted.metadata_snapshot_json);
      if (!hasCurrentFreeConsent(metadata)) {
        throw new CreatorError("creator_free_terms_required", 409);
      }
      const draft: FreeWorkMetadata = { titleZh: current.title_zh, description: current.description,
        tags: parseJson<string[]>(current.tags_json), creatorDouyinNumber: current.creator_douyin_number ?? null,
        priceFen: 0, sharingTermsVersion: current.sharing_terms_version };
      if (creatorPublicTextDigest(draft) !== metadata.publicTextSha256) throw new CreatorError("creator_review_superseded", 409);
      const consents = await this.#rows(connection,
        `SELECT consent_id FROM gongde_creator_free_consents WHERE version_id = ? AND creator_id = ? AND work_id = ?
         AND terms_version = ? AND terms_sha256 = ? AND ai_terms_version = ? AND ai_terms_sha256 = ? AND public_text_sha256 = ?`,
        [uploaded.version_id, current.creator_id, current.work_id, FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS_SHA256,
          FREE_CREATOR_AI_TERMS_VERSION, FREE_CREATOR_AI_TERMS_SHA256, metadata.publicTextSha256!]);
      if (!consents.length) throw new CreatorError("creator_free_terms_required", 409);
      if (automatic && metadata.acceptAiContentReview !== true) {
        throw new CreatorError("creator_ai_review_acceptance_required", 409);
      }
      const decidedChecks = automatic ? { ...previousChecks, ...checks, autoReview: { state: decision.toLowerCase(),
        attempts: Number(auto?.attempts) || 1, evidence: automatic.evidence } } :
        { ...previousChecks, ...checks, manualReview: { actor: admin, reason } };
      await this.#write(connection,
        "UPDATE gongde_creator_reviews SET state = ?, reviewer_reference = ?, decision_reason = ?, checks_json = ?, decided_at = ? WHERE review_id = ?",
        [decision, admin, reason || null, JSON.stringify(decidedChecks), new Date(), reviewId]);
      await this.#write(connection,
        "UPDATE gongde_creator_work_versions SET state = ?, reviewed_at = ?, approved_metadata_json = ? WHERE version_id = ?",
        [decision, new Date(), decision === "APPROVED" ? JSON.stringify(metadata) : null, uploaded.version_id]);
      if (decision === "APPROVED") await this.#write(connection,
        `UPDATE gongde_creator_works SET state = 'PUBLISHED', price_fen = 0,
         published_version_id = ?, published_metadata_json = ?, first_published_at = COALESCE(first_published_at, ?),
         updated_at = ? WHERE work_id = ?`,
        [uploaded.version_id, JSON.stringify(metadata), new Date(), new Date(), current.work_id]);
      if (decision === "APPROVED") await this.#publication(connection,
        { creatorId: current.creator_id, workId: current.work_id, versionId: uploaded.version_id, reviewId,
          contentFingerprint: automatic?.contentFingerprint ?? verifiedContentFingerprint ?? "" });
      await this.#audit(connection, "admin", admin, `review.${decision.toLowerCase()}`, reviewId,
        { versionId: uploaded.version_id, archiveSha256: uploaded.archive_sha256, reason, checks: decidedChecks });
    });
  }

  async grantPendingAiReviewConsent(creatorId: string, workId: string, versionId: string): Promise<string | null> {
    return this.#transaction(async connection => {
      const current = await this.#ownedWork(connection, creatorId, workId);
      if (current.state === "SUSPENDED") throw new CreatorError("creator_work_suspended", 409);
      const creators = await this.#rows(connection, "SELECT state FROM gongde_creators WHERE creator_id = ?", [creatorId]);
      if (creators[0]?.state !== "ACTIVE") throw new CreatorError("creator_auth_required", 401);
      const versions = await this.#rows(connection,
        "SELECT state FROM gongde_creator_work_versions WHERE version_id = ? AND work_id = ? FOR UPDATE", [versionId, workId]);
      if (!versions[0]) throw new CreatorError("creator_version_not_found", 404);
      if (versions[0].state !== "PENDING_REVIEW") return null;
      const rows = await this.#rows(connection,
        "SELECT * FROM gongde_creator_reviews WHERE version_id = ? AND state = 'PENDING' ORDER BY review_round DESC LIMIT 1 FOR UPDATE", [versionId]);
      const submitted = rows[0];
      if (!submitted) throw new CreatorError("creator_review_changed", 409);
      const metadata = parseJson<FreeWorkMetadata>(submitted.metadata_snapshot_json);
      // Idempotent only for an already-authorized immutable v2 snapshot.
      // Legacy pending snapshots must be withdrawn; never upgrade them in place.
      if (!hasCurrentFreeConsent(metadata)) throw new CreatorError("creator_free_terms_required", 409);
      return String(submitted.review_id);
    });
  }

  async getReview(reviewId: string): Promise<FreeReviewRecord> {
    const rows = await this.#rows(this.#pool,
      `SELECT r.*, v.work_id, n.appearance_serial FROM gongde_creator_reviews r
       JOIN gongde_creator_work_versions v ON v.version_id = r.version_id
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = v.work_id
       WHERE r.review_id = ?`, [reviewId]);
    if (!rows[0]) throw new CreatorError("creator_review_not_found", 404);
    return review(rows[0]);
  }

  async pendingAutomaticReviewIds(): Promise<string[]> {
    const rows = await this.#rows(this.#pool,
      `SELECT r.review_id FROM gongde_creator_reviews r
       JOIN gongde_creator_work_versions v ON v.version_id = r.version_id
       JOIN gongde_creator_works w ON w.work_id = v.work_id
       WHERE r.state = 'PENDING' AND v.state = 'PENDING_REVIEW' AND w.state <> 'SUSPENDED'
         AND JSON_UNQUOTE(JSON_EXTRACT(r.metadata_snapshot_json, '$.acceptAiContentReview')) = 'true'
         AND JSON_UNQUOTE(JSON_EXTRACT(r.metadata_snapshot_json, '$.sharingTermsVersion')) = 'creator-free-distribution-v2-20261008'
         AND JSON_UNQUOTE(JSON_EXTRACT(r.metadata_snapshot_json, '$.aiReviewTermsVersion')) = 'creator-ai-review-v2-20261008'
         AND (JSON_EXTRACT(r.checks_json, '$.autoReview.state') IS NULL OR
           JSON_UNQUOTE(JSON_EXTRACT(r.checks_json, '$.autoReview.state')) IN ('queued', 'running', 'retry_wait'))
       ORDER BY r.submitted_at ASC LIMIT 30`);
    return rows.map(row => String(row.review_id));
  }

  async claimAutomaticReview(reviewId: string): Promise<{ leaseId: string; attempts: number } | null> {
    return this.#transaction(async connection => {
      const rows = await this.#rows(connection, "SELECT * FROM gongde_creator_reviews WHERE review_id = ? FOR UPDATE", [reviewId]);
      const submitted = rows[0];
      if (submitted?.state !== "PENDING") return null;
      if (!hasCurrentFreeConsent(parseJson<FreeWorkMetadata>(submitted.metadata_snapshot_json))) return null;
      const checks = submitted.checks_json ? parseJson<Record<string, unknown>>(submitted.checks_json) : {};
      const auto = (checks.autoReview ?? {}) as Record<string, unknown>;
      if (["needs_review", "approved", "rejected"].includes(String(auto.state)) ||
          Number(auto.leaseUntil) > Date.now() || Number(auto.nextAttemptAt) > Date.now()) return null;
      const attempts = (Number(auto.attempts) || 0) + 1;
      if (attempts > 3) {
        await this.#write(connection, "UPDATE gongde_creator_reviews SET checks_json = ?, decision_reason = ? WHERE review_id = ?",
          [JSON.stringify({ ...checks, autoReview: { state: "needs_review", attempts: 3 } }),
            "自动审核重试已结束，作品保留待复核，尚未上架。", reviewId]);
        return null;
      }
      const leaseId = id();
      await this.#write(connection, "UPDATE gongde_creator_reviews SET checks_json = ?, decision_reason = ? WHERE review_id = ?",
        [JSON.stringify({ ...checks, autoReview: { state: "running", attempts, leaseId, leaseUntil: Date.now() + 60000 } }),
          "程序复核与 AI 内容审核正在处理中，尚未上架。", reviewId]);
      await this.#audit(connection, "admin", "automation:deepseek", "review.auto_started", reviewId, { attempts });
      return { leaseId, attempts };
    });
  }

  async renewAutomaticReview(reviewId: string, leaseId: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.#write(this.#pool,
      `UPDATE gongde_creator_reviews SET checks_json = JSON_SET(checks_json, '$.autoReview.leaseUntil', ?)
       WHERE review_id = ? AND state = 'PENDING'
         AND JSON_UNQUOTE(JSON_EXTRACT(checks_json, '$.autoReview.leaseId')) = ?
         AND JSON_UNQUOTE(JSON_EXTRACT(checks_json, '$.autoReview.state')) = 'running'
         AND CAST(JSON_UNQUOTE(JSON_EXTRACT(checks_json, '$.autoReview.leaseUntil')) AS UNSIGNED) > ?`,
      [now + 60000, reviewId, leaseId, now]);
    return result.affectedRows === 1;
  }

  async deferAutomaticReview(reviewId: string, leaseId: string, state: "retry_wait" | "needs_review",
    reason: string, nextAttemptAt: number | null, evidence: Record<string, unknown>): Promise<void> {
    await this.#transaction(async connection => {
      const rows = await this.#rows(connection, "SELECT state, checks_json FROM gongde_creator_reviews WHERE review_id = ? FOR UPDATE", [reviewId]);
      if (rows[0]?.state !== "PENDING") return;
      const checks = rows[0].checks_json ? parseJson<Record<string, unknown>>(rows[0].checks_json) : {};
      const auto = checks.autoReview as Record<string, unknown> | undefined;
      if (auto?.leaseId !== leaseId || auto.state !== "running") return;
      await this.#write(connection, "UPDATE gongde_creator_reviews SET checks_json = ?, decision_reason = ? WHERE review_id = ?",
        [JSON.stringify({ ...checks, autoReview: { state, attempts: Number(auto.attempts) || 1, nextAttemptAt, evidence } }),
          reason.slice(0, 1000), reviewId]);
      await this.#audit(connection, "admin", "automation:deepseek", "review.auto_deferred", reviewId,
        { state, reason: reason.slice(0, 1000), nextAttemptAt, evidence });
    });
  }

  async unpublish(workId: string, actorKind: "creator" | "admin", actor: string, suspend = false, reason = ""): Promise<void> {
    await this.#transaction(async connection => {
      const rows = await this.#rows(connection, "SELECT * FROM gongde_creator_works WHERE work_id = ? FOR UPDATE", [workId]);
      if (!rows[0] || (actorKind === "creator" && rows[0].creator_id !== actor)) throw new CreatorError("creator_work_not_found", 404);
      if (actorKind === "creator" && (suspend || rows[0].state === "SUSPENDED")) throw new CreatorError("creator_work_suspended", 409);
      await this.#withdrawPending(connection, workId);
      await this.#write(connection, "UPDATE gongde_creator_works SET state = ?, updated_at = ? WHERE work_id = ?",
        [suspend ? "SUSPENDED" : "UNPUBLISHED", new Date(), workId]);
      await this.#audit(connection, actorKind, actor, suspend ? "work.suspend" : "work.unpublish", workId, { reason });
    });
  }

  async republishWork(creatorId: string, workId: string, expectedVersionId: string, expectedRevision: string,
    expectedArchiveSha256: string, contentFingerprint = ""): Promise<void> {
    await this.#transaction(async connection => {
      const current = await this.#ownedWork(connection, creatorId, workId);
      if (current.state !== "UNPUBLISHED" || current.publishedVersionId !== expectedVersionId || !current.publishedMetadata) {
        throw new CreatorError("creator_republish_not_available", 409);
      }
      const creators = await this.#rows(connection, "SELECT state FROM gongde_creators WHERE creator_id = ?", [creatorId]);
      if (creators[0]?.state !== "ACTIVE") throw new CreatorError("creator_auth_required", 401);
      const versions = await this.#rows(connection,
        "SELECT * FROM gongde_creator_work_versions WHERE version_id = ? AND work_id = ? FOR UPDATE", [expectedVersionId, workId]);
      const uploaded = versions[0];
      if (uploaded?.state !== "APPROVED" || !uploaded.approved_metadata_json ||
          uploaded.source_revision !== expectedRevision || uploaded.archive_sha256 !== expectedArchiveSha256) {
        throw new CreatorError("creator_republish_not_available", 409);
      }
      const evidence = await this.#freeEvidence(connection, version({ ...uploaded, creator_id: creatorId, slug: current.slug } as RowDataPacket));
      if (!evidence) {
        throw new CreatorError("creator_free_terms_required", 409);
      }
      // Reuse the immutable approved version and its published text. Draft edits
      // remain draft edits; this operation cannot clear a moderation suspension.
      await this.#write(connection,
        "UPDATE gongde_creator_works SET state = 'PUBLISHED', updated_at = ? WHERE work_id = ?", [new Date(), workId]);
      await this.#publication(connection, { creatorId, workId, versionId: expectedVersionId,
        reviewId: evidence.reviewId, contentFingerprint });
      await this.#audit(connection, "creator", creatorId, "work.republish_approved", workId,
        { versionId: expectedVersionId, revision: expectedRevision });
    });
  }

  async publicWorks(offset = 0): Promise<Array<{ work: FreeWorkRecord; version: FreeVersionRecord }>> {
    const rows = await this.#rows(this.#pool,
      `SELECT w.*, n.appearance_serial, v.version_id AS selected_version_id FROM gongde_creator_works w
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
       JOIN gongde_creator_work_versions v ON v.work_id = w.work_id AND v.version_id = w.published_version_id
       JOIN gongde_creators c ON c.creator_id = w.creator_id
       WHERE w.state = 'PUBLISHED' AND v.state = 'APPROVED' AND c.state = 'ACTIVE'
         AND w.published_metadata_json IS NOT NULL
         AND JSON_UNQUOTE(JSON_EXTRACT(w.published_metadata_json, '$.acceptFreeDistribution')) = 'true'
         AND JSON_UNQUOTE(JSON_EXTRACT(w.published_metadata_json, '$.sharingTermsVersion')) = 'creator-free-distribution-v2-20261008'
         ORDER BY w.first_published_at DESC, n.appearance_serial DESC LIMIT 24 OFFSET ${offset}`);
    const results: Array<{ work: FreeWorkRecord; version: FreeVersionRecord }> = [];
    for (const row of rows) {
      const uploaded = await this.getVersion(row.selected_version_id);
      const evidence = await this.#freeEvidence(this.#pool, uploaded);
      if (evidence) results.push({ work: work(row), version: { ...uploaded, approvedMetadata: evidence.metadata } });
    }
    return results;
  }

  async published(workId: string, versionId?: string): Promise<{ work: FreeWorkRecord; version: FreeVersionRecord }> {
    const rows = await this.#rows(this.#pool,
      `SELECT w.*, n.appearance_serial FROM gongde_creator_works w JOIN gongde_creators c ON c.creator_id = w.creator_id
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
       WHERE w.work_id = ? AND w.state = 'PUBLISHED'
         AND w.published_metadata_json IS NOT NULL AND c.state = 'ACTIVE'`, [workId]);
    if (!rows[0]) throw new CreatorError("creator_work_not_found", 404);
    const current = work(rows[0]);
    if (versionId && versionId !== current.publishedVersionId) throw new CreatorError("creator_version_changed", 409);
    const uploaded = await this.getVersion(current.publishedVersionId!);
    const evidence = uploaded.state === "APPROVED" ? await this.#freeEvidence(this.#pool, uploaded) : null;
    if (!evidence || !hasCurrentFreeConsent(current.publishedMetadata) ||
        current.publishedMetadata!.publicTextSha256 !== evidence.metadata.publicTextSha256) {
      throw new CreatorError("creator_work_not_found", 404);
    }
    return { work: current, version: { ...uploaded, approvedMetadata: evidence.metadata } };
  }

  async report(workId: string, versionId: string, category: string, description: string): Promise<string> {
    await this.published(workId, versionId);
    const complaintId = id();
    await this.#write(this.#pool,
      `INSERT INTO gongde_creator_complaints
       (complaint_id, work_id, version_id, state, category, description, created_at)
       VALUES (?, ?, ?, 'OPEN', ?, ?, ?)`, [complaintId, workId, versionId, category, description, new Date()]);
    return complaintId;
  }

  async reviewHistory(creatorId: string, workId: string) {
    await this.ownedWork(creatorId, workId);
    return (await this.#rows(this.#pool,
      `SELECT r.review_id, r.version_id, r.state, r.decision_reason, r.checks_json, r.metadata_snapshot_json, r.submitted_at, r.decided_at
       FROM gongde_creator_reviews r JOIN gongde_creator_work_versions v ON v.version_id = r.version_id
       JOIN gongde_creator_works w ON w.work_id = v.work_id
       WHERE w.work_id = ? AND w.creator_id = ? ORDER BY r.submitted_at DESC, r.review_round DESC LIMIT 400`, [workId, creatorId]))
      .map(row => ({ reviewId: row.review_id, versionId: row.version_id, state: row.state, reason: row.decision_reason,
        submittedAt: new Date(row.submitted_at).toISOString(), decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
        autoReview: publicAutoReview(row.checks_json),
        acceptAiContentReview: parseJson<FreeWorkMetadata>(row.metadata_snapshot_json).acceptAiContentReview === true }));
  }

  async approvedReviewId(versionId: string): Promise<string> {
    const rows = await this.#rows(this.#pool,
      "SELECT review_id FROM gongde_creator_reviews WHERE version_id = ? AND state = 'APPROVED' ORDER BY review_round DESC LIMIT 1", [versionId]);
    if (!rows[0]) throw new CreatorError("creator_approved_review_missing", 503);
    return String(rows[0].review_id);
  }

  async authorizePaidVersion(creatorId: string, workId: string, versionId: string, revision: string): Promise<string> {
    const rows = await this.#rows(this.#pool,
      `SELECT w.state AS work_state, c.state AS creator_state
       FROM gongde_creator_works w JOIN gongde_creators c ON c.creator_id = w.creator_id
       WHERE w.work_id = ? AND w.creator_id = ?`, [workId, creatorId]);
    if (!rows[0] || rows[0].creator_state !== "ACTIVE" || rows[0].work_state === "SUSPENDED") {
      throw new CreatorError("creator_paid_delivery_unavailable", 409);
    }
    const uploaded = await this.getVersion(versionId);
    if (uploaded.creatorId !== creatorId || uploaded.workId !== workId || uploaded.state !== "APPROVED" ||
        uploaded.revision !== revision || !uploaded.approvedMetadata || uploaded.approvedMetadata.priceFen !== 20 ||
        uploaded.approvedMetadata.sharingTermsVersion !== "creator-paid-distribution-v1") {
      throw new CreatorError("creator_paid_delivery_unavailable", 409);
    }
    const reviewId = await this.approvedReviewId(versionId);
    const reviews = await this.#rows(this.#pool,
      "SELECT metadata_snapshot_json FROM gongde_creator_reviews WHERE review_id = ? AND version_id = ? AND state = 'APPROVED'",
      [reviewId, versionId]);
    const snapshot = reviews[0] ? parseJson<FreeWorkMetadata>(reviews[0].metadata_snapshot_json) : null;
    if (!snapshot || snapshot.acceptPaidDistribution !== true || snapshot.priceFen !== 20 ||
        snapshot.sharingTermsVersion !== "creator-paid-distribution-v1") {
      throw new CreatorError("creator_paid_delivery_unavailable", 409);
    }
    return reviewId;
  }

  // Frozen legitimate claims survive normal unlisting, newer publication and
  // author-code suspension. Safety/copyright suspension of the work still blocks.
  async authorizeFreeVersion(creatorId: string, workId: string, versionId: string, revision: string): Promise<string> {
    const works = await this.#rows(this.#pool,
      "SELECT state FROM gongde_creator_works WHERE work_id = ? AND creator_id = ?", [workId, creatorId]);
    if (!works[0] || works[0].state === "SUSPENDED") throw new CreatorError("creator_free_delivery_unavailable", 409);
    const uploaded = await this.getVersion(versionId);
    if (uploaded.creatorId !== creatorId || uploaded.workId !== workId || uploaded.state !== "APPROVED" ||
        uploaded.revision !== revision) {
      throw new CreatorError("creator_free_delivery_unavailable", 409);
    }
    const evidence = await this.#freeEvidence(this.#pool, uploaded);
    if (!evidence) throw new CreatorError("creator_free_delivery_unavailable", 409);
    return evidence.reviewId;
  }

  async adminWorks(state: string, offset = 0): Promise<FreeWorkRecord[]> {
    return (await this.#rows(this.#pool,
      `SELECT w.*, n.appearance_serial FROM gongde_creator_works w
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
       WHERE w.state = ?
       ORDER BY w.updated_at DESC, w.work_id ASC LIMIT 50 OFFSET ${offset}`, [state])).map(work);
  }

  async adminNumberWork(workId: string): Promise<FreeWorkRecord> {
    const rows = await this.#rows(this.#pool,
      `SELECT w.*, n.appearance_serial FROM gongde_creator_works w
       JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
       WHERE w.work_id = ?`, [workId]);
    if (!rows[0]) throw new CreatorError("creator_work_not_found", 404);
    return work(rows[0]);
  }

  async complaints(state: string, offset = 0) {
    return (await this.#rows(this.#pool,
      `SELECT c.complaint_id, c.work_id, c.version_id, c.state, c.category, c.description, c.created_at,
              a.detail_json AS decision_detail_json, a.created_at AS decided_at
       FROM gongde_creator_complaints c
       LEFT JOIN gongde_creator_audit a ON a.subject_reference = c.complaint_id AND a.actor_kind = 'admin'
         AND a.action = CASE c.state WHEN 'RESOLVED' THEN 'complaint.suspend'
                                    WHEN 'DISMISSED' THEN 'complaint.dismiss' ELSE NULL END
       WHERE c.state = ? ORDER BY c.created_at ASC LIMIT 50 OFFSET ${offset}`, [state]))
      .map(row => {
        const detail = row.decision_detail_json ? parseJson<unknown>(row.decision_detail_json) : null;
        const reason = detail && typeof detail === "object" && "reason" in detail && typeof detail.reason === "string"
          ? detail.reason : null;
        return { complaintId: row.complaint_id, workId: row.work_id, versionId: row.version_id,
          state: row.state, category: row.category, description: row.description,
          createdAt: new Date(row.created_at).toISOString(), reason,
          decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null };
      });
  }

  async decideComplaint(admin: string, complaintId: string, outcome: "SUSPEND" | "DISMISS", reason: string): Promise<void> {
    const pointers = await this.#rows(this.#pool,
      "SELECT work_id FROM gongde_creator_complaints WHERE complaint_id = ?", [complaintId]);
    if (!pointers[0]) throw new CreatorError("creator_complaint_not_found", 404);
    await this.#transaction(async connection => {
      const works = await this.#rows(connection, "SELECT work_id FROM gongde_creator_works WHERE work_id = ? FOR UPDATE", [pointers[0].work_id]);
      const complaints = await this.#rows(connection, "SELECT * FROM gongde_creator_complaints WHERE complaint_id = ? FOR UPDATE", [complaintId]);
      if (!works[0] || complaints[0]?.state !== "OPEN") throw new CreatorError("creator_complaint_changed", 409);
      if (outcome === "SUSPEND") await this.#write(connection,
        "UPDATE gongde_creator_works SET state = 'SUSPENDED', updated_at = ? WHERE work_id = ?", [new Date(), works[0].work_id]);
      await this.#write(connection, "UPDATE gongde_creator_complaints SET state = ? WHERE complaint_id = ?",
        [outcome === "SUSPEND" ? "RESOLVED" : "DISMISSED", complaintId]);
      await this.#audit(connection, "admin", admin, `complaint.${outcome.toLowerCase()}`, complaintId,
        { workId: works[0].work_id, reason });
    });
  }

  async ready(): Promise<boolean> {
    try {
      await this.#rows(this.#pool, "SELECT username, recovery_digest FROM gongde_creators LIMIT 0");
      await this.#rows(this.#pool, "SELECT published_metadata_json, creator_douyin_number, sharing_terms_version, first_published_at FROM gongde_creator_works LIMIT 0");
      await this.#rows(this.#pool, "SELECT consent_id, metadata_snapshot_json, review_id, source_revision, archive_sha256 FROM gongde_creator_free_consents LIMIT 0");
      await this.#rows(this.#pool, "SELECT bucket_digest FROM gongde_creator_rate_limits LIMIT 0");
      await this.#rows(this.#pool, "SELECT appearance_serial, source_kind, internal_id FROM gongde_appearance_numbers LIMIT 0");
      return true;
    } catch { return false; }
  }

  async close(): Promise<void> { await this.#pool.end(); }
}
