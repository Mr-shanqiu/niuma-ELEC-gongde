import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { hasCurrentFreeConsent } from "../creators/consent.js";
import { assertExcluded, lockFreeExclusionControl } from "./exclusions.js";
import type { FreeWorkMetadata } from "../creators/repository.js";
import { assertCodeSecret, batchLimit, claimRequestDigest, codeCycle, codeDigest, creatorPublicNumber,
  deriveCode, DOWNLOAD_SESSION_MS, DOWNLOAD_WINDOW_MS, downloadLinkExpiresAt, MAX_DELIVERY_BYTES,
  newSessionToken, sessionDigest, stableJson, validateClaimItems } from "./codes.js";
import { FreeDistributionError, type AuditMutation, type Claim, type ClaimItemSnapshot, type CodeAuthorization,
  type CodeFamily, type Contribution, type DeliveryArtifactInput, type DownloadSession, type FamilyAction,
  type FreeDistributionStats, type ListOptions, type RepositoryOptions } from "./types.js";
import type { AdminClaimSummary, AdminCodeSnapshot, AdminContribution, AdminCreatorPromotion,
  AdminCreatorSummary, AdminQuery, AdminStats, DeliveryArtifact } from "./types.js";

type Executor = Pick<PoolConnection, "execute">;
type Values = NonNullable<Parameters<Pool["execute"]>[1]>;
const id = () => randomBytes(16).toString("hex");
const json = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const iso = (value: unknown): string => new Date(value as string | number | Date).toISOString();
const nullableIso = (value: unknown) => value == null ? null : iso(value);
const hashLease = (token: string) => createHash("sha256").update("gongde-free/worker-lease/v1\0").update(token).digest("hex");
const duplicate = (error: unknown) => (error as { code?: string })?.code === "ER_DUP_ENTRY";

async function rows(connection: Executor, sql: string, values: Values = []): Promise<RowDataPacket[]> {
  const [result] = await connection.execute<RowDataPacket[]>(sql, values);
  return result;
}
async function write(connection: Executor, sql: string, values: Values = []): Promise<ResultSetHeader> {
  const [result] = await connection.execute<ResultSetHeader>(sql, values);
  return result;
}
function identifier(value: string, max = 128): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value) || value.length > max) throw new FreeDistributionError("free_distribution_input_invalid", 400);
}
function fingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new FreeDistributionError("contribution_fingerprint_invalid", 400);
}
function mutationInput(input: AuditMutation): void {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
    typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 80 ||
    typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.length > 1000 ||
    (input.requestId !== undefined && (typeof input.requestId !== "string" || input.requestId.length > 128))) {
    throw new FreeDistributionError("admin_reason_revision_required", 400);
  }
}
async function audit(connection: Executor, input: { actor: string; action: string; subject: string; before: unknown;
  after: unknown; reason: string; requestId?: string }, now: Date): Promise<void> {
  await write(connection, `INSERT INTO gongde_free_audit
    (id, actor, action, subject, before_json, after_json, reason, request_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id(), input.actor, input.action, input.subject, stableJson(input.before), stableJson(input.after), input.reason, input.requestId ?? null, now]);
}
function contribution(row: RowDataPacket): Contribution {
  return { workId: row.work_id, creatorId: row.creator_id, contentFingerprint: row.content_fingerprint,
    state: row.state, revision: Number(row.revision), earnedAt: iso(row.earned_at), revokedAt: nullableIso(row.revoked_at),
    restoredAt: nullableIso(row.restored_at), reason: row.reason ?? null };
}

// Caller owns the transaction; this function NEVER commits, rolls back or releases.
export async function ensureFreeCreatorPublicNumber(connection: PoolConnection, creatorId: string): Promise<string> {
  identifier(creatorId, 32);
  const owners = await rows(connection, "SELECT creator_id FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [creatorId]);
  if (!owners[0]) throw new FreeDistributionError("creator_not_found", 404);
  const existing = await rows(connection, "SELECT serial FROM gongde_free_creator_numbers WHERE creator_id = ?", [creatorId]);
  if (existing[0]) return creatorPublicNumber(Number(existing[0].serial));
  const allocators = await rows(connection, "SELECT next_serial FROM gongde_free_creator_number_allocator WHERE allocator_id = 1 FOR UPDATE");
  if (!allocators[0]) throw new FreeDistributionError("creator_number_allocator_missing", 503);
  const serial = Number(allocators[0].next_serial);
  const number = creatorPublicNumber(serial);
  if (!Number.isSafeInteger(serial + 1)) throw new FreeDistributionError("creator_number_exhausted", 503);
  await write(connection, "INSERT INTO gongde_free_creator_numbers (creator_id, serial, created_at) VALUES (?, ?, ?)", [creatorId, serial, new Date()]);
  await write(connection, "UPDATE gongde_free_creator_number_allocator SET next_serial = ? WHERE allocator_id = 1", [serial + 1]);
  return number;
}

async function ensureCreatorFamily(connection: PoolConnection, creatorId: string, now: Date): Promise<RowDataPacket> {
  const existing = await rows(connection, "SELECT * FROM gongde_free_code_families WHERE creator_id = ? FOR UPDATE", [creatorId]);
  if (existing[0]) return existing[0];
  const familyId = id();
  await write(connection, `INSERT INTO gongde_free_code_families
    (id, kind, creator_id, state, generation, revision, created_at, updated_at) VALUES (?, 'CREATOR', ?, 'ACTIVE', 0, 1, ?, ?)`,
  [familyId, creatorId, now, now]);
  return (await rows(connection, "SELECT * FROM gongde_free_code_families WHERE id = ? FOR UPDATE", [familyId]))[0];
}

export async function recordFreeContribution(connection: PoolConnection, input: {
  workId: string; creatorId: string; contentFingerprint: string;
}): Promise<{ contribution: Contribution; created: boolean; familyId: string }> {
  identifier(input.workId, 80); identifier(input.creatorId, 32); fingerprint(input.contentFingerprint);
  const owner = (await rows(connection, "SELECT creator_id, state FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [input.creatorId]))[0];
  if (!owner || owner.state !== "ACTIVE") throw new FreeDistributionError("creator_paused", 403);
  const now = new Date();
  await ensureFreeCreatorPublicNumber(connection, input.creatorId);
  const existing = (await rows(connection, "SELECT * FROM gongde_free_contributions WHERE work_id = ? FOR UPDATE", [input.workId]))[0];
  if (existing) {
    if (existing.creator_id !== input.creatorId) throw new FreeDistributionError("contribution_owner_conflict", 409);
    const family = await ensureCreatorFamily(connection, input.creatorId, now);
    return { contribution: contribution(existing), created: false, familyId: family.id };
  }
  // Eligibility is proven from the published version and its matching approved
  // review, never from old paid authorization or an upload's current draft.
  await assertExcluded(connection, input.contentFingerprint);
  const work = (await rows(connection, `SELECT w.work_id, w.state, w.published_version_id, w.published_metadata_json,
    v.state AS version_state, v.approved_metadata_json, v.validation_json, v.source_manifest_json
    FROM gongde_creator_works w JOIN gongde_creator_work_versions v ON v.work_id = w.work_id AND v.version_id = w.published_version_id
    WHERE w.work_id = ? AND w.creator_id = ? FOR UPDATE`, [input.workId, input.creatorId]))[0];
  if (!work || work.state !== "PUBLISHED" || work.version_state !== "APPROVED") throw new FreeDistributionError("contribution_publication_required", 409);
  const published = json<FreeWorkMetadata>(work.published_metadata_json);
  const approved = json<FreeWorkMetadata>(work.approved_metadata_json);
  if (!hasCurrentFreeConsent(published) || !hasCurrentFreeConsent(approved) || stableJson(published) !== stableJson(approved)) {
    throw new FreeDistributionError("contribution_free_consent_required", 409);
  }
  const reviews = await rows(connection, `SELECT metadata_snapshot_json FROM gongde_creator_reviews
    WHERE version_id = ? AND state = 'APPROVED' FOR UPDATE`, [work.published_version_id]);
  if (!reviews.some(row => { const metadata = json<FreeWorkMetadata>(row.metadata_snapshot_json);
    return hasCurrentFreeConsent(metadata) && stableJson(metadata) === stableJson(approved); })) {
    throw new FreeDistributionError("contribution_review_mismatch", 409);
  }
  const validation = json<Record<string, unknown>>(work.validation_json) ?? {};
  const manifest = json<Record<string, unknown>>(work.source_manifest_json) ?? {};
  if ([validation, manifest].some(value => ["synthetic", "isSynthetic", "sample", "isSample", "fixture", "isFixture"].some(key => value[key] === true))) {
    throw new FreeDistributionError("contribution_sample_excluded", 409);
  }
  const family = await ensureCreatorFamily(connection, input.creatorId, now);
  try {
    await write(connection, `INSERT INTO gongde_free_contributions
      (work_id, creator_id, content_fingerprint, earned_version_id, consent_snapshot_json, state, revision, earned_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, ?)`,
    [input.workId, input.creatorId, input.contentFingerprint, work.published_version_id, stableJson(approved), now]);
  } catch (error) {
    if (duplicate(error)) throw new FreeDistributionError("contribution_duplicate_content", 409);
    throw error;
  }
  await write(connection, "UPDATE gongde_free_code_families SET revision = revision + 1, updated_at = ? WHERE id = ?", [now, family.id]);
  await audit(connection, { actor: "publication", action: "contribution.earned", subject: input.workId, before: null,
    after: { creatorId: input.creatorId, versionId: work.published_version_id, contentFingerprint: input.contentFingerprint, revision: 1 },
    reason: "approved_publication_with_current_free_consent" }, now);
  return { contribution: contribution((await rows(connection, "SELECT * FROM gongde_free_contributions WHERE work_id = ?", [input.workId]))[0]),
    created: true, familyId: family.id };
}

export class FreeDistributionRepository {
  readonly #pool: Pool;
  readonly #options: RepositoryOptions;
  readonly #secret: Buffer;
  constructor(pool: Pool, options: RepositoryOptions) {
    assertCodeSecret(options.codeSecret);
    this.#pool = pool; this.#options = { ...options, enabled: options.enabled === true }; this.#secret = Buffer.from(options.codeSecret);
  }
  #now(): Date { return new Date((this.#options.now?.() ?? new Date()).getTime()); }
  #enabled(): void { if (!this.#options.enabled) throw new FreeDistributionError("free_distribution_disabled", 503); }
  async #transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const connection = await this.#pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        // Transactions contain only database operations, no signing/upload/provider
        // effects. InnoDB deadlock retry is bounded and safe here.
        if ((error as { code?: string })?.code !== "ER_LOCK_DEADLOCK" || attempt >= 2) throw error;
      } finally { connection.release(); }
    }
  }
  async #lockFamily(connection: PoolConnection, familyId: string): Promise<{ family: RowDataPacket; owner: RowDataPacket | null }> {
    const initial = (await rows(connection, "SELECT creator_id FROM gongde_free_code_families WHERE id = ?", [familyId]))[0];
    if (!initial) throw new FreeDistributionError("code_family_not_found", 404);
    const owner = initial.creator_id ? (await rows(connection, "SELECT creator_id, state FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [initial.creator_id]))[0] : null;
    const family = (await rows(connection, "SELECT * FROM gongde_free_code_families WHERE id = ? FOR UPDATE", [familyId]))[0];
    return { family, owner };
  }
  async #family(connection: Executor, row: RowDataPacket, owner?: RowDataPacket | null): Promise<CodeFamily> {
    // InnoDB locking reads see the latest committed state AFTER waiting for the
    // creator/family lock, unlike a repeatable-read consistent COUNT snapshot.
    const count = row.creator_id ? (await rows(connection, "SELECT work_id FROM gongde_free_contributions WHERE creator_id = ? AND state = 'ACTIVE' FOR SHARE", [row.creator_id])).length : 0;
    const numbers = row.creator_id ? await rows(connection, "SELECT serial FROM gongde_free_creator_numbers WHERE creator_id = ?", [row.creator_id]) : [];
    const state = row.state;
    const creatorState = owner ? owner.state : row.creator_state;
    return { id: row.id, kind: row.kind, creatorId: row.creator_id ?? null,
      publicNumber: numbers[0] ? creatorPublicNumber(Number(numbers[0].serial)) : null,
      state, generation: Number(row.generation), revision: Number(row.revision), activeContributions: count,
      limit: state === "ACTIVE" && (!row.creator_id || creatorState === "ACTIVE") ? batchLimit(row.kind, count) : 0,
      createdAt: iso(row.created_at) };
  }
  async ensureGroupFamily(): Promise<CodeFamily> {
    return this.#transaction(async connection => {
      const now = this.#now();
      await write(connection, `INSERT INTO gongde_free_code_families
        (id, kind, creator_id, state, generation, revision, created_at, updated_at)
        VALUES (?, 'GROUP', NULL, 'ACTIVE', 0, 1, ?, ?) ON DUPLICATE KEY UPDATE id = id`, [id(), now, now]);
      return this.#family(connection, (await rows(connection, "SELECT * FROM gongde_free_code_families WHERE kind = 'GROUP' FOR UPDATE"))[0]);
    });
  }
  async getCreatorFamily(creatorId: string): Promise<CodeFamily | null> {
    identifier(creatorId, 32);
    return this.#transaction(async connection => {
      const result = await rows(connection, "SELECT id FROM gongde_free_code_families WHERE creator_id = ?", [creatorId]);
      if (!result[0]) return null;
      const { family, owner } = await this.#lockFamily(connection, result[0].id);
      return this.#family(connection, family, owner);
    });
  }
  async ensureCreatorPublicNumber(creatorId: string): Promise<string> {
    return this.#transaction(connection => ensureFreeCreatorPublicNumber(connection, creatorId));
  }
  async #ensureToken(connection: PoolConnection, family: RowDataPacket, now: Date): Promise<RowDataPacket> {
    const cycle = codeCycle(now);
    const existing = (await rows(connection, `SELECT * FROM gongde_free_code_tokens
      WHERE family_id = ? AND cycle_index = ? AND generation = ? FOR UPDATE`, [family.id, cycle.index, family.generation]))[0];
    if (existing) return existing;
    for (let nonce = 0; nonce < 128; nonce += 1) {
      const value = deriveCode(this.#secret, family.id, cycle.index, Number(family.generation), nonce);
      const tokenId = id();
      try {
        await write(connection, `INSERT INTO gongde_free_code_tokens
          (id, family_id, cycle_index, generation, nonce, code_digest, valid_from, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tokenId, family.id, cycle.index, family.generation, nonce, codeDigest(this.#secret, value), cycle.validFrom, cycle.expiresAt, now]);
        return (await rows(connection, "SELECT * FROM gongde_free_code_tokens WHERE id = ?", [tokenId]))[0];
      } catch (error) {
        if (!duplicate(error)) throw error;
        // Period uniqueness is authoritative even with a competing allocator.
        const winner = (await rows(connection, `SELECT * FROM gongde_free_code_tokens
          WHERE family_id = ? AND cycle_index = ? AND generation = ? FOR UPDATE`, [family.id, cycle.index, family.generation]))[0];
        if (winner) return winner;
      }
    }
    throw new FreeDistributionError("code_collision_retry_exhausted", 503);
  }
  async #authorize(connection: PoolConnection, tokenId: string): Promise<CodeAuthorization> {
    const initial = (await rows(connection, "SELECT family_id FROM gongde_free_code_tokens WHERE id = ?", [tokenId]))[0];
    if (!initial) throw new FreeDistributionError("access_code_invalid", 400);
    const { family, owner } = await this.#lockFamily(connection, initial.family_id);
    const token = (await rows(connection, "SELECT * FROM gongde_free_code_tokens WHERE id = ? FOR UPDATE", [tokenId]))[0];
    const now = this.#now();
    const cycle = codeCycle(now);
    if (family.state !== "ACTIVE" || (family.creator_id && owner?.state !== "ACTIVE")) throw new FreeDistributionError("access_code_paused", 403);
    if (token.revoked_at || Number(token.generation) !== Number(family.generation) || Number(token.cycle_index) !== cycle.index ||
      now.getTime() < new Date(token.valid_from).getTime() || now.getTime() >= new Date(token.expires_at).getTime()) {
      throw new FreeDistributionError("access_code_expired", 410);
    }
    const projected = await this.#family(connection, family, owner);
    if (projected.limit === 0) throw new FreeDistributionError("creator_promotion_inactive", 403);
    return { codeFamilyId: family.id, codeTokenId: token.id, kind: family.kind, publicNumber: projected.publicNumber,
      cycleIndex: cycle.index, generation: Number(family.generation), revision: Number(family.revision), limit: projected.limit,
      serverNow: now.toISOString(), expiresAt: iso(token.expires_at) };
  }
  // Authentication/ownership of this privileged plaintext read belongs to HTTP.
  async getCurrentCode(familyId: string): Promise<{ code: string; authorization: CodeAuthorization }> {
    identifier(familyId, 32);
    return this.#transaction(async connection => {
      const { family, owner } = await this.#lockFamily(connection, familyId);
      const projected = await this.#family(connection, family, owner);
      if (!projected.limit) throw new FreeDistributionError("access_code_paused", 403);
      const token = await this.#ensureToken(connection, family, this.#now());
      const authorization = await this.#authorize(connection, token.id);
      return { code: deriveCode(this.#secret, family.id, Number(token.cycle_index), Number(token.generation), Number(token.nonce)), authorization };
    });
  }
  async #session(connection: PoolConnection, token: string, notFound = false): Promise<RowDataPacket> {
    let digest: string;
    try { digest = sessionDigest(token); } catch (error) {
      if (notFound) throw new FreeDistributionError("claim_not_found", 404);
      throw error;
    }
    const session = (await rows(connection, "SELECT * FROM gongde_free_download_sessions WHERE session_digest = ? FOR UPDATE", [digest]))[0];
    if (!session || this.#now().getTime() >= new Date(session.expires_at).getTime()) {
      throw new FreeDistributionError(notFound ? "claim_not_found" : "download_session_required", notFound ? 404 : 401);
    }
    return session;
  }
  async verifyCode(input: { code: unknown; sessionToken?: string }): Promise<{ sessionToken: string; session: DownloadSession }> {
    this.#enabled();
    const digest = codeDigest(this.#secret, input.code);
    return this.#transaction(async connection => {
      // Lock an existing browser session before changing its authorization.
      let session: RowDataPacket | undefined;
      if (input.sessionToken) {
        try { session = await this.#session(connection, input.sessionToken); }
        catch (error) { if (!(error instanceof FreeDistributionError) || error.code !== "download_session_required") throw error; }
      }
      const token = (await rows(connection, "SELECT id FROM gongde_free_code_tokens WHERE code_digest = ?", [digest]))[0];
      if (!token) throw new FreeDistributionError("access_code_invalid", 400);
      const authorization = await this.#authorize(connection, token.id);
      const now = this.#now();
      const sessionToken = session ? input.sessionToken! : newSessionToken();
      if (session) {
        await write(connection, "UPDATE gongde_free_download_sessions SET current_code_token_id = ? WHERE id = ?", [token.id, session.id]);
      } else {
        const sessionId = id();
        await write(connection, `INSERT INTO gongde_free_download_sessions
          (id, session_digest, current_code_token_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [sessionId, sessionDigest(sessionToken), token.id, now, new Date(now.getTime() + DOWNLOAD_SESSION_MS)]);
        session = { id: sessionId, created_at: now, expires_at: new Date(now.getTime() + DOWNLOAD_SESSION_MS) } as RowDataPacket;
      }
      await write(connection, "UPDATE gongde_free_code_families SET verification_count = verification_count + 1 WHERE id = ?", [authorization.codeFamilyId]);
      await write(connection, "INSERT INTO gongde_free_verification_events (id, family_id, occurred_at) VALUES (?, ?, ?)", [id(), authorization.codeFamilyId, now]);
      return { sessionToken, session: { id: session.id, createdAt: iso(session.created_at), expiresAt: iso(session.expires_at), authorization } };
    });
  }
  async getSession(sessionToken: string): Promise<DownloadSession> {
    return this.#transaction(async connection => {
      const session = await this.#session(connection, sessionToken);
      let authorization: CodeAuthorization | null = null;
      if (session.current_code_token_id && this.#options.enabled) {
        try { authorization = await this.#authorize(connection, session.current_code_token_id); }
        catch (error) { if (!(error instanceof FreeDistributionError) || ![400, 403, 410].includes(error.status)) throw error; }
      }
      return { id: session.id, createdAt: iso(session.created_at), expiresAt: iso(session.expires_at), authorization };
    });
  }
  async clearAccess(sessionToken: string): Promise<void> {
    await this.#transaction(async connection => {
      const session = await this.#session(connection, sessionToken);
      await write(connection, "UPDATE gongde_free_download_sessions SET current_code_token_id = NULL WHERE id = ?", [session.id]);
    });
  }
  async #claim(connection: Executor, row: RowDataPacket): Promise<Claim> {
    const items = (await rows(connection, "SELECT * FROM gongde_free_claim_items WHERE claim_id = ? ORDER BY position", [row.id])).map(item => ({
      appearanceNumber: String(item.appearance_number), sourceKind: item.source_kind, assetId: item.asset_id,
      creatorId: item.creator_id ?? null, versionId: item.version_id, sourceRevision: item.source_revision,
      catalogRevision: item.catalog_revision, metadataSnapshot: json<Record<string, unknown>>(item.metadata_snapshot_json),
      consentSnapshot: json<Record<string, unknown>>(item.consent_snapshot_json), deliveryBytesUpperBound: Number(item.delivery_bytes_upper_bound),
      ...(item.snapshot_record_json == null ? {} : { snapshotRecord: json<Record<string, unknown>>(item.snapshot_record_json) })
    } as ClaimItemSnapshot));
    const artifact = (await rows(connection, "SELECT * FROM gongde_free_delivery_artifacts WHERE claim_id = ?", [row.id]))[0];
    const state = row.state === "READY" && this.#now().getTime() >= new Date(row.download_expires_at).getTime() ? "EXPIRED" : row.state;
    const deliverArtifact: DeliveryArtifact | null = artifact ? { privateObjectKey: artifact.private_object_key,
      sha256: artifact.sha256, bytes: Number(artifact.bytes), filename: artifact.filename, format: artifact.format,
      licenseMode: "perpetual", signerVersion: artifact.signer_version, createdAt: iso(artifact.created_at) } : null;
    return { id: row.id, kind: "APPEARANCES", codeFamilyId: row.family_id, codeTokenId: row.code_token_id,
      cycleIndex: Number(row.cycle_index), limitSnapshot: Number(row.limit_snapshot), state, revision: Number(row.revision),
      createdAt: iso(row.created_at), issuedAt: nullableIso(row.issued_at), downloadExpiresAt: nullableIso(row.download_expires_at),
      licenseMode: "perpetual", importExpiresAt: null, errorCode: row.error_code ?? null, retryable: !!row.retryable,
      stage: row.stage, attempts: Number(row.attempts), items,
      artifact: deliverArtifact, deliverArtifact };
  }
  async createClaim(input: { sessionToken: string; idempotencyKey: string; items: readonly ClaimItemSnapshot[] }): Promise<{ claim: Claim; created: boolean }> {
    identifier(input.idempotencyKey);
    // Deep-copy before awaiting; a caller cannot mutate a frozen request mid-tx.
    const items = json<ClaimItemSnapshot[]>(stableJson(input.items));
    validateClaimItems(items, 10);
    const digest = claimRequestDigest(items);
    return this.#transaction(async connection => {
      const session = await this.#session(connection, input.sessionToken);
      const existing = (await rows(connection, "SELECT * FROM gongde_free_claims WHERE session_id = ? AND idempotency_key = ? FOR UPDATE", [session.id, input.idempotencyKey]))[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new FreeDistributionError("claim_idempotency_conflict", 409);
        return { claim: await this.#claim(connection, existing), created: false };
      }
      this.#enabled();
      if (!session.current_code_token_id) throw new FreeDistributionError("access_code_required", 403);
      const authorization = await this.#authorize(connection, session.current_code_token_id);
      validateClaimItems(items, authorization.limit);
      if (!this.#options.validateItems) throw new FreeDistributionError("claim_catalog_validator_missing", 503);
      await this.#options.validateItems(connection, items);
      // The validator may wait on publication locks. Recheck the cycle *after*
      // the wait as well; generation/contribution locks remain held throughout.
      const current = await this.#authorize(connection, session.current_code_token_id);
      validateClaimItems(items, current.limit);
      const claimId = id();
      const now = this.#now();
      await write(connection, `INSERT INTO gongde_free_claims
        (id, session_id, kind, family_id, code_token_id, cycle_index, limit_snapshot, request_digest, idempotency_key, created_at)
        VALUES (?, ?, 'APPEARANCES', ?, ?, ?, ?, ?, ?, ?)`,
      [claimId, session.id, current.codeFamilyId, current.codeTokenId, current.cycleIndex, current.limit, digest, input.idempotencyKey, now]);
      const sorted = [...items].sort((a, b) => Number(a.appearanceNumber) - Number(b.appearanceNumber));
      for (const [index, item] of sorted.entries()) {
        await write(connection, `INSERT INTO gongde_free_claim_items
          (claim_id, position, appearance_number, source_kind, asset_id, creator_id, version_id, source_revision,
           catalog_revision, metadata_snapshot_json, consent_snapshot_json, delivery_bytes_upper_bound, snapshot_record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [claimId, index + 1, Number(item.appearanceNumber), item.sourceKind, item.assetId, item.creatorId, item.versionId,
          item.sourceRevision, item.catalogRevision, stableJson(item.metadataSnapshot), stableJson(item.consentSnapshot), item.deliveryBytesUpperBound,
          item.snapshotRecord ? stableJson(item.snapshotRecord) : null]);
      }
      return { claim: await this.#claim(connection, (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ?", [claimId]))[0]), created: true };
    });
  }
  // Recovery BEFORE current catalog resolution: HTTP compares the original
  // submitted number/catalogRevision pairs with these frozen items. A miss alone
  // permits fresh resolution/authorization. Never resolve a newer version first.
  async findClaimByKey(input: { sessionToken: string; idempotencyKey: string }): Promise<Claim | null> {
    identifier(input.idempotencyKey);
    return this.#transaction(async connection => {
      const session = await this.#session(connection, input.sessionToken);
      const row = (await rows(connection, "SELECT * FROM gongde_free_claims WHERE session_id = ? AND idempotency_key = ? FOR UPDATE", [session.id, input.idempotencyKey]))[0];
      return row ? this.#claim(connection, row) : null;
    });
  }
  async #ownedClaim(connection: PoolConnection, input: { sessionToken: string; claimId: string }): Promise<RowDataPacket> {
    const session = await this.#session(connection, input.sessionToken, true);
    if (!/^[a-f0-9]{32}$/.test(input.claimId)) throw new FreeDistributionError("claim_not_found", 404);
    const claim = (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ? AND session_id = ? FOR UPDATE", [input.claimId, session.id]))[0];
    if (!claim) throw new FreeDistributionError("claim_not_found", 404);
    return claim;
  }
  async #safety(connection: PoolConnection, row: RowDataPacket): Promise<boolean> {
    if (row.state === "BLOCKED") return false;
    if (!this.#options.checkSafety) throw new FreeDistributionError("claim_safety_validator_missing", 503);
    const claim = await this.#claim(connection, row);
    if (await this.#options.checkSafety(connection, claim.items)) return true;
    await write(connection, `UPDATE gongde_free_claims SET state = 'BLOCKED', error_code = 'claim_blocked',
      retryable = FALSE, lease_digest = NULL, lease_expires_at = NULL, revision = revision + 1 WHERE id = ?`, [row.id]);
    row.state = "BLOCKED"; row.error_code = "claim_blocked"; row.retryable = false; row.revision = Number(row.revision) + 1;
    await audit(connection, { actor: "safety", action: "claim.blocked", subject: row.id, before: { revision: Number(row.revision) - 1 },
      after: { revision: Number(row.revision), state: "BLOCKED" }, reason: "safety_or_copyright_distribution_stop" }, this.#now());
    return false;
  }
  async getClaim(input: { sessionToken: string; claimId: string }): Promise<Claim> {
    return this.#transaction(async connection => {
      const row = await this.#ownedClaim(connection, input);
      await this.#safety(connection, row);
      return this.#claim(connection, row);
    });
  }
  // A trusted signer calls this AFTER uploading a private artifact. No external
  // I/O occurs here. Its lease fences all stale workers and READY statistics.
  async acquirePreparation(claimId: string): Promise<{ claim: Claim; leaseToken: string; leaseExpiresAt: string } | null> {
    identifier(claimId, 32);
    return this.#transaction(async connection => {
      const initial = (await rows(connection, "SELECT session_id FROM gongde_free_claims WHERE id = ?", [claimId]))[0];
      if (!initial) return null;
      // Serialize per-browser acquisitions BEFORE counting concurrent leases.
      // All public claim operations already take session -> claim in this order.
      await rows(connection, "SELECT id FROM gongde_free_download_sessions WHERE id = ? FOR UPDATE", [initial.session_id]);
      const row = (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ? FOR UPDATE", [claimId]))[0];
      if (!row || row.state !== "PREPARING") return null;
      const now = this.#now();
      if (row.lease_expires_at && now.getTime() < new Date(row.lease_expires_at).getTime()) return null;
      if (!await this.#safety(connection, row)) return null;
      const started = row.generation_started_at ? new Date(row.generation_started_at) : now;
      if (now.getTime() >= started.getTime() + 120000 || Number(row.attempts) >= 3) {
        await write(connection, `UPDATE gongde_free_claims SET state = 'FAILED', error_code = 'claim_generation_failed',
          retryable = TRUE, lease_digest = NULL, lease_expires_at = NULL, revision = revision + 1 WHERE id = ?`, [claimId]);
        return null;
      }
      const other = (await rows(connection, `SELECT COUNT(*) AS n FROM gongde_free_claims
        WHERE session_id = ? AND state = 'PREPARING' AND lease_expires_at > ? AND id <> ? FOR UPDATE`, [row.session_id, now, claimId]))[0];
      if (Number(other.n) >= 2) return null;
      const leaseToken = newSessionToken();
      const leaseExpiresAt = new Date(Math.min(now.getTime() + 30000, started.getTime() + 120000));
      await write(connection, `UPDATE gongde_free_claims SET lease_digest = ?, lease_expires_at = ?, generation_started_at = ?,
        attempts = attempts + 1, stage = 'preparing_resources', revision = revision + 1 WHERE id = ?`,
      [hashLease(leaseToken), leaseExpiresAt, started, claimId]);
      return { claim: await this.#claim(connection, (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ?", [claimId]))[0]),
        leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString() };
    });
  }
  async #leasedClaim(connection: PoolConnection, claimId: string, leaseToken: string): Promise<RowDataPacket> {
    const row = (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ? FOR UPDATE", [claimId]))[0];
    if (!row || row.state !== "PREPARING" || row.lease_digest !== hashLease(leaseToken) ||
      this.#now().getTime() >= new Date(row.lease_expires_at).getTime()) throw new FreeDistributionError("claim_lease_lost", 409);
    return row;
  }
  async setPreparationStage(input: { claimId: string; leaseToken: string; stage: "preparing_resources" | "generating_file" }): Promise<void> {
    if (!["preparing_resources", "generating_file"].includes(input.stage)) throw new FreeDistributionError("claim_stage_invalid", 400);
    await this.#transaction(async connection => {
      await this.#leasedClaim(connection, input.claimId, input.leaseToken);
      await write(connection, "UPDATE gongde_free_claims SET stage = ?, revision = revision + 1 WHERE id = ?", [input.stage, input.claimId]);
    });
  }
  async markReady(input: { claimId: string; leaseToken: string; artifact: DeliveryArtifactInput; issuedAt?: string }): Promise<Claim> {
    const artifact = input.artifact;
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > MAX_DELIVERY_BYTES) throw new FreeDistributionError("claim_file_too_large", 413);
    if (artifact.licenseMode !== "perpetual" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      typeof artifact.privateObjectKey !== "string" || !artifact.privateObjectKey || artifact.privateObjectKey.length > 384 ||
      /^(?:https?:|\/)/i.test(artifact.privateObjectKey) || typeof artifact.signerVersion !== "string" ||
      !artifact.signerVersion || artifact.signerVersion.length > 64 ||
      artifact.filename !== (artifact.format === "nmgpack" ? `niuma-appearance-${input.claimId}.nmgpack` : `niuma-appearances-${input.claimId}.nmgpacks`)) throw new FreeDistributionError("claim_artifact_invalid", 400);
    return this.#transaction(async connection => {
      const row = await this.#leasedClaim(connection, input.claimId, input.leaseToken);
      if (!await this.#safety(connection, row)) return this.#claim(connection, row);
      const claim = await this.#claim(connection, row);
      if (artifact.format !== (claim.items.length === 1 ? "nmgpack" : "nmgpacks")) throw new FreeDistributionError("claim_artifact_invalid", 400);
      // Safety checks may block on catalog rows; fence the lease again afterwards.
      await this.#leasedClaim(connection, input.claimId, input.leaseToken);
      const now = this.#now();
      const issuedAt = input.issuedAt === undefined ? now : new Date(input.issuedAt);
      if (input.issuedAt !== undefined && (typeof input.issuedAt !== "string" ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.issuedAt) || !Number.isFinite(issuedAt.getTime()) ||
        issuedAt.getTime() < new Date(row.generation_started_at).getTime() || issuedAt.getTime() > now.getTime())) {
        throw new FreeDistributionError("claim_issued_at_invalid", 400);
      }
      await write(connection, `INSERT INTO gongde_free_delivery_artifacts
        (claim_id, private_object_key, sha256, bytes, filename, format, license_mode, signer_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'perpetual', ?, ?)`,
      [input.claimId, artifact.privateObjectKey, artifact.sha256, artifact.bytes, artifact.filename, artifact.format, artifact.signerVersion, issuedAt]);
      await write(connection, `UPDATE gongde_free_claims SET state = 'READY', issued_at = ?, download_expires_at = ?,
        error_code = NULL, retryable = FALSE, lease_digest = NULL, lease_expires_at = NULL, revision = revision + 1 WHERE id = ?`,
      [issuedAt, new Date(issuedAt.getTime() + DOWNLOAD_WINDOW_MS), input.claimId]);
      return this.#claim(connection, (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ?", [input.claimId]))[0]);
    });
  }
  async markFailed(input: { claimId: string; leaseToken: string; errorCode: string; retryable: boolean }): Promise<Claim> {
    // Restrict errors to safe machine identifiers, never raw caught exceptions.
    if (!/^claim_[a-z0-9_]{1,56}$/.test(input.errorCode)) throw new FreeDistributionError("claim_error_code_invalid", 400);
    const terminal = ["claim_signature_invalid", "claim_source_digest_mismatch", "claim_consent_missing", "claim_file_too_large"];
    return this.#transaction(async connection => {
      const row = await this.#leasedClaim(connection, input.claimId, input.leaseToken);
      const retryable = input.retryable === true && !terminal.includes(input.errorCode);
      await write(connection, `UPDATE gongde_free_claims SET state = 'FAILED', error_code = ?, retryable = ?,
        lease_digest = NULL, lease_expires_at = NULL, revision = revision + 1 WHERE id = ?`, [input.errorCode, retryable, row.id]);
      return this.#claim(connection, (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ?", [row.id]))[0]);
    });
  }
  async retryClaim(input: { sessionToken: string; claimId: string }): Promise<Claim> {
    return this.#transaction(async connection => {
      const row = await this.#ownedClaim(connection, input);
      if (row.state === "PREPARING") return this.#claim(connection, row);
      if (row.state !== "FAILED" || !row.retryable) throw new FreeDistributionError("claim_retry_not_allowed", 409);
      if (!await this.#safety(connection, row)) return this.#claim(connection, row);
      await write(connection, `UPDATE gongde_free_claims SET state = 'PREPARING', stage = 'queued', attempts = 0,
        generation_started_at = NULL, error_code = NULL, retryable = FALSE, lease_digest = NULL, lease_expires_at = NULL,
        revision = revision + 1 WHERE id = ?`, [row.id]);
      return this.#claim(connection, (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ?", [row.id]))[0]);
    });
  }
  // Trusted runtime only. It owns the 5s/15s scheduler; this transition preserves
  // the original run start and attempt counter, unlike an explicit user retry.
  async retrySystemClaim(claimId: string): Promise<Claim | null> {
    identifier(claimId, 32);
    return this.#transaction(async connection => {
      const initial = (await rows(connection, "SELECT session_id FROM gongde_free_claims WHERE id = ?", [claimId]))[0];
      if (!initial) return null;
      await rows(connection, "SELECT id FROM gongde_free_download_sessions WHERE id = ? FOR UPDATE", [initial.session_id]);
      const row = (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ? FOR UPDATE", [claimId]))[0];
      if (!row || row.state !== "FAILED" || !row.retryable || Number(row.attempts) >= 3 || !row.generation_started_at) return null;
      if (row.lease_expires_at && this.#now().getTime() < new Date(row.lease_expires_at).getTime()) return null;
      if (!await this.#safety(connection, row)) return null;
      if (this.#now().getTime() >= new Date(row.generation_started_at).getTime() + 120000) return null;
      await write(connection, `UPDATE gongde_free_claims SET state = 'PREPARING', stage = 'queued',
        error_code = NULL, retryable = FALSE, lease_digest = NULL, lease_expires_at = NULL,
        revision = revision + 1 WHERE id = ?`, [claimId]);
      return this.#claim(connection, (await rows(connection, "SELECT * FROM gongde_free_claims WHERE id = ?", [claimId]))[0]);
    });
  }
  async getDownloadAuthorization(input: { sessionToken: string; claimId: string }): Promise<{ claim: Claim; linkExpiresAt: string }> {
    const result = await this.#transaction(async connection => {
      const row = await this.#ownedClaim(connection, input);
      if (!await this.#safety(connection, row)) return { claim: await this.#claim(connection, row), linkExpiresAt: null };
      const claim = await this.#claim(connection, row);
      if (claim.state === "EXPIRED") throw new FreeDistributionError("claim_download_expired", 410);
      if (claim.state !== "READY" || !claim.issuedAt || !claim.artifact) throw new FreeDistributionError("claim_not_ready", 409);
      return { claim, linkExpiresAt: downloadLinkExpiresAt(new Date(claim.issuedAt), this.#now()).toISOString() };
    });
    // Throw AFTER commit, so a discovered safety block remains durable.
    if (result.linkExpiresAt === null) throw new FreeDistributionError("claim_blocked", 403);
    return result as { claim: Claim; linkExpiresAt: string };
  }
  async mutateFamily(input: AuditMutation & { familyId: string; action: FamilyAction }): Promise<AdminCodeSnapshot> {
    mutationInput(input); identifier(input.familyId, 32);
    if (!["pause", "resume", "rotate", "revoke", "restore"].includes(input.action)) throw new FreeDistributionError("admin_action_invalid", 400);
    return this.#transaction(async connection => {
      const { family, owner } = await this.#lockFamily(connection, input.familyId);
      if (Number(family.revision) !== input.expectedRevision) throw new FreeDistributionError("admin_revision_conflict", 409);
      const before = { state: family.state, generation: Number(family.generation), revision: Number(family.revision) };
      const target = { pause: "PAUSED", resume: "ACTIVE", rotate: family.state, revoke: "REVOKED", restore: "ACTIVE" }[input.action];
      if ((input.action === "resume" && family.state !== "PAUSED") || (input.action === "restore" && family.state !== "REVOKED") ||
        (input.action === "pause" && family.state !== "ACTIVE") || (input.action === "revoke" && family.state === "REVOKED")) {
        throw new FreeDistributionError("admin_state_conflict", 409);
      }
      const now = this.#now();
      const generation = Number(family.generation) + (input.action === "rotate" || input.action === "revoke" ? 1 : 0);
      if (generation > 4294967295) throw new FreeDistributionError("code_generation_exhausted", 503);
      await write(connection, "UPDATE gongde_free_code_families SET state = ?, generation = ?, revision = revision + 1, updated_at = ? WHERE id = ?", [target, generation, now, family.id]);
      if (generation !== Number(family.generation)) await write(connection, "UPDATE gongde_free_code_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ? AND revoked_at IS NULL", [now, family.id]);
      await audit(connection, { ...input, subject: family.id, action: `family.${input.action}`, before,
        after: { state: target, generation, revision: input.expectedRevision + 1 } }, now);
      return this.#adminCode(connection, (await rows(connection, "SELECT * FROM gongde_free_code_families WHERE id = ?", [family.id]))[0], owner, false);
    });
  }
  async mutateContribution(input: AuditMutation & { workId: string; action: "revoke" | "restore" }): Promise<AdminContribution> {
    mutationInput(input); identifier(input.workId, 80);
    if (!["revoke", "restore"].includes(input.action)) throw new FreeDistributionError("admin_action_invalid", 400);
    return this.#transaction(async connection => {
      const initial = (await rows(connection, "SELECT creator_id FROM gongde_free_contributions WHERE work_id = ?", [input.workId]))[0];
      if (!initial) throw new FreeDistributionError("contribution_not_found", 404);
      await rows(connection, "SELECT creator_id FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [initial.creator_id]);
      const family = (await rows(connection, "SELECT * FROM gongde_free_code_families WHERE creator_id = ? FOR UPDATE", [initial.creator_id]))[0];
      const row = (await rows(connection, "SELECT * FROM gongde_free_contributions WHERE work_id = ? FOR UPDATE", [input.workId]))[0];
      if (Number(row.revision) !== input.expectedRevision) throw new FreeDistributionError("admin_revision_conflict", 409);
      const target = input.action === "revoke" ? "REVOKED" : "ACTIVE";
      if (row.state === target) throw new FreeDistributionError("admin_state_conflict", 409);
      const now = this.#now();
      const column = input.action === "revoke" ? "revoked_at" : "restored_at";
      await write(connection, `UPDATE gongde_free_contributions SET state = ?, ${column} = ?, reason = ?, revision = revision + 1 WHERE work_id = ?`, [target, now, input.reason, input.workId]);
      await write(connection, "UPDATE gongde_free_code_families SET revision = revision + 1, updated_at = ? WHERE id = ?", [now, family.id]);
      await audit(connection, { ...input, subject: input.workId, action: `contribution.${input.action}`,
        before: { state: row.state, revision: Number(row.revision) }, after: { state: target, revision: input.expectedRevision + 1 } }, now);
      return this.#adminContribution(connection, (await rows(connection, "SELECT * FROM gongde_free_contributions WHERE work_id = ?", [input.workId]))[0]);
    });
  }
  async registerExcludedFingerprint(input: { contentFingerprint: string; kind: "SAMPLE" | "SYNTHETIC"; actor: string; reason: string }): Promise<void> {
    fingerprint(input.contentFingerprint); mutationInput({ ...input, expectedRevision: 1 });
    if (!["SAMPLE", "SYNTHETIC"].includes(input.kind)) throw new FreeDistributionError("contribution_exclusion_invalid", 400);
    await this.#transaction(async connection => {
      await lockFreeExclusionControl(connection);
      const used = await rows(connection, "SELECT work_id FROM gongde_free_contributions WHERE content_fingerprint = ? FOR UPDATE", [input.contentFingerprint]);
      if (used[0]) throw new FreeDistributionError("contribution_exclusion_requires_revocation", 409);
      await write(connection, `INSERT INTO gongde_free_excluded_fingerprints
        (content_fingerprint, kind, reason, created_at) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE content_fingerprint = content_fingerprint`, [input.contentFingerprint, input.kind, input.reason, this.#now()]);
      await audit(connection, { actor: input.actor, action: "fingerprint.exclude", subject: input.contentFingerprint,
        before: null, after: { kind: input.kind }, reason: input.reason }, this.#now());
    });
  }
  #page(options: ListOptions): [number, number] {
    const limit = options.limit ?? 20; const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new FreeDistributionError("pagination_invalid", 400);
    return [limit, offset];
  }
  async listFamilies(options: ListOptions = {}): Promise<CodeFamily[]> {
    const [limit, offset] = this.#page(options);
    const selected = await rows(this.#pool, `SELECT f.*, c.state AS creator_state FROM gongde_free_code_families f
      LEFT JOIN gongde_creators c ON c.creator_id = f.creator_id
      WHERE (? IS NULL OR f.creator_id = ?) AND (? IS NULL OR f.state = ?) ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit} OFFSET ${offset}`,
    [options.creatorId ?? null, options.creatorId ?? null, options.state ?? null, options.state ?? null]);
    const result: CodeFamily[] = [];
    for (const row of selected) result.push(await this.#family(this.#pool, row));
    return result;
  }
  async listContributions(options: ListOptions = {}): Promise<AdminContribution[]> {
    const [limit, offset] = this.#page(options);
    const selected = await rows(this.#pool, `SELECT * FROM gongde_free_contributions
      WHERE (? IS NULL OR creator_id = ?) AND (? IS NULL OR state = ?) ORDER BY earned_at DESC, work_id DESC LIMIT ${limit} OFFSET ${offset}`,
    [options.creatorId ?? null, options.creatorId ?? null, options.state ?? null, options.state ?? null]);
    const result: AdminContribution[] = [];
    for (const row of selected) result.push(await this.#adminContribution(this.#pool, row));
    return result;
  }
  // sessionToken set => public caller's records only; absent => privileged admin
  // method, which MUST be gated by existing admin authentication in HTTP.
  async listSessionClaims(options: ListOptions & { sessionToken: string }): Promise<Claim[]> {
    const [limit, offset] = this.#page(options);
    return this.#transaction(async connection => {
      const session = await this.#session(connection, options.sessionToken);
      const selected = await rows(connection, `SELECT * FROM gongde_free_claims
        WHERE (? IS NULL OR session_id = ?) AND (? IS NULL OR family_id = ?) AND (? IS NULL OR state = ?)
        AND (? IS NULL OR created_at >= ?) ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      [session?.id ?? null, session?.id ?? null, options.familyId ?? null, options.familyId ?? null, options.state ?? null, options.state ?? null,
        session?.id ?? null, new Date(this.#now().getTime() - DOWNLOAD_SESSION_MS)]);
      const result: Claim[] = [];
      for (const row of selected) result.push(await this.#claim(connection, row));
      return result;
    });
  }
  async getInternalStats(options: { familyId?: string } = {}): Promise<FreeDistributionStats> {
    return this.#transaction(async connection => {
      const family = options.familyId ?? null;
      const verifications = (await rows(connection, "SELECT COALESCE(SUM(verification_count), 0) AS n FROM gongde_free_code_families WHERE (? IS NULL OR id = ?)", [family, family]))[0];
      // issued_at remains a first-READY receipt even if later blocked/expired.
      const ready = (await rows(connection, "SELECT COUNT(*) AS n FROM gongde_free_claims WHERE issued_at IS NOT NULL AND (? IS NULL OR family_id = ?)", [family, family]))[0];
      const items = (await rows(connection, `SELECT COUNT(*) AS n FROM gongde_free_claim_items i
        JOIN gongde_free_claims c ON c.id = i.claim_id WHERE c.issued_at IS NOT NULL AND (? IS NULL OR c.family_id = ?)`, [family, family]))[0];
      const contributions = (await rows(connection, `SELECT COUNT(*) AS n FROM gongde_free_contributions x
        WHERE x.state = 'ACTIVE' AND (? IS NULL OR x.creator_id = (SELECT creator_id FROM gongde_free_code_families WHERE id = ?))`, [family, family]))[0];
      const states = await rows(connection, `SELECT CASE WHEN state = 'READY' AND download_expires_at <= ? THEN 'EXPIRED' ELSE state END AS projected_state,
        COUNT(*) AS n FROM gongde_free_claims WHERE (? IS NULL OR family_id = ?) GROUP BY projected_state`, [this.#now(), family, family]);
      return { successfulVerifications: Number(verifications.n), readyClaims: Number(ready.n), readyAppearanceItems: Number(items.n),
        activeContributions: Number(contributions.n), claimsByState: Object.fromEntries(states.map(row => [row.projected_state, Number(row.n)])), clientFileRequests: null };
    });
  }

  async #adminContribution(connection: Executor, row: RowDataPacket): Promise<AdminContribution> {
    const details = (await rows(connection, `SELECT w.title_zh, n.appearance_serial FROM gongde_creator_works w
      LEFT JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id WHERE w.work_id = ?`, [row.work_id]))[0];
    return { workId: row.work_id, revision: Number(row.revision), state: row.state,
      ...(details?.title_zh ? { title: details.title_zh } : {}),
      ...(details?.appearance_serial ? { number: String(details.appearance_serial) } : {}),
      grantedAt: iso(row.earned_at), revokedAt: nullableIso(row.revoked_at), restoredAt: nullableIso(row.restored_at), reason: row.reason ?? null };
  }
  async #adminCode(connection: PoolConnection, family: RowDataPacket | null, owner: RowDataPacket | null, viewAudit: boolean): Promise<AdminCodeSnapshot> {
    if (!family) return { familyId: null, revision: null, kind: "CREATOR", status: "INACTIVE", code: null,
      validFrom: null, expiresAt: null, contributionCount: 0, maxItems: 0, redemptionEnabled: false };
    const projected = await this.#family(connection, family, owner);
    const inactive = family.kind === "CREATOR" && projected.activeContributions === 0;
    const paused = family.state !== "ACTIVE" || (!!family.creator_id && owner?.state !== "ACTIVE");
    const status = inactive ? "INACTIVE" : paused ? "PAUSED" : "ACTIVE";
    const token = status === "ACTIVE" ? await this.#ensureToken(connection, family, this.#now()) : null;
    if (viewAudit) await audit(connection, { actor: "authenticated_code_reader", action: "code.view", subject: family.id,
      before: null, after: { generation: Number(family.generation), revision: Number(family.revision), status },
      reason: "explicit_privileged_current_code_read" }, this.#now());
    return { familyId: family.id, revision: Number(family.revision), kind: family.kind, status,
      code: token ? deriveCode(this.#secret, family.id, Number(token.cycle_index), Number(token.generation), Number(token.nonce)) : null,
      validFrom: token ? iso(token.valid_from) : null, expiresAt: token ? iso(token.expires_at) : null,
      contributionCount: projected.activeContributions, maxItems: batchLimit(family.kind, projected.activeContributions),
      redemptionEnabled: status === "ACTIVE" && this.#options.enabled === true && this.#options.deliveryReady?.() === true };
  }
  async getGroupCode(): Promise<AdminCodeSnapshot> {
    const group = await this.ensureGroupFamily();
    return this.#transaction(async connection => {
      const { family, owner } = await this.#lockFamily(connection, group.id);
      return this.#adminCode(connection, family, owner, true);
    });
  }
  async getCreatorPromotion(creatorId: string): Promise<AdminCreatorPromotion> {
    identifier(creatorId, 32);
    return this.#transaction(async connection => {
      const owner = (await rows(connection, "SELECT creator_id, state FROM gongde_creators WHERE creator_id = ? FOR UPDATE", [creatorId]))[0];
      if (!owner) throw new FreeDistributionError("creator_not_found", 404);
      const authorPublicNumber = await ensureFreeCreatorPublicNumber(connection, creatorId);
      const family = (await rows(connection, "SELECT * FROM gongde_free_code_families WHERE creator_id = ? FOR UPDATE", [creatorId]))[0] ?? null;
      const workCount = Number((await rows(connection, "SELECT COUNT(*) AS n FROM gongde_creator_works WHERE creator_id = ?", [creatorId]))[0].n);
      const selected = await rows(connection, "SELECT * FROM gongde_free_contributions WHERE creator_id = ? ORDER BY earned_at, work_id FOR SHARE", [creatorId]);
      const contributions: AdminContribution[] = [];
      for (const row of selected) contributions.push(await this.#adminContribution(connection, row));
      return { ...await this.#adminCode(connection, family, owner, true), creatorId, authorPublicNumber,
        accountState: owner.state, workCount, contributions };
    });
  }
  #adminPage(options: { page?: number; perPage?: number }): [number, number] {
    const page = options.page ?? 1; const perPage = options.perPage ?? 25;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 ||
      !Number.isSafeInteger((page - 1) * perPage)) throw new FreeDistributionError("pagination_invalid", 400);
    return [perPage, (page - 1) * perPage];
  }
  #dateRange(options: { from?: string; to?: string }): [Date, Date] {
    const parse = (value: string): Date => {
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
      const ms = Date.parse(value);
      if (!match || !Number.isFinite(ms)) throw new FreeDistributionError("admin_date_range_invalid", 400);
      const offset = match[2].toUpperCase() === "Z" ? 0 : (Number(match[2].slice(1, 3)) * 60 + Number(match[2].slice(4))) * (match[2][0] === "+" ? 1 : -1);
      if (new Date(ms + offset * 60000).toISOString().slice(0, 19) !== match[1]) throw new FreeDistributionError("admin_date_range_invalid", 400);
      return new Date(ms);
    };
    if ((options.from === undefined) !== (options.to === undefined)) throw new FreeDistributionError("admin_date_range_invalid", 400);
    const to = options.to === undefined ? this.#now() : parse(options.to);
    const from = options.from === undefined ? new Date(to.getTime() - DOWNLOAD_SESSION_MS) : parse(options.from);
    if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > 90 * 86400000) throw new FreeDistributionError("admin_date_range_invalid", 400);
    return [from, to];
  }
  async listCreators(options: { page?: number; perPage?: number; q?: string; state?: string } = {}): Promise<{ items: AdminCreatorSummary[]; total: number }> {
    const [limit, offset] = this.#adminPage(options);
    if (options.q !== undefined && (typeof options.q !== "string" || options.q.length > 80)) throw new FreeDistributionError("admin_query_invalid", 400);
    return this.#transaction(async connection => {
      const q = options.q?.trim() || null;
      const filter = "(? IS NULL OR c.creator_id = ? OR CONCAT('C', n.serial) = ?) AND (? IS NULL OR c.state = ?)";
      const values = [q, q, q, options.state ?? null, options.state ?? null];
      const total = Number((await rows(connection, `SELECT COUNT(*) AS n FROM gongde_creators c
        LEFT JOIN gongde_free_creator_numbers n ON n.creator_id = c.creator_id WHERE ${filter}`, values))[0].n);
      const selected = await rows(connection, `SELECT c.creator_id, c.state FROM gongde_creators c
        LEFT JOIN gongde_free_creator_numbers n ON n.creator_id = c.creator_id WHERE ${filter}
        ORDER BY c.created_at DESC, c.creator_id DESC LIMIT ${limit} OFFSET ${offset}`, values);
      const items: AdminCreatorSummary[] = [];
      for (const creator of selected) {
        const authorPublicNumber = await ensureFreeCreatorPublicNumber(connection, creator.creator_id);
        const family = (await rows(connection, "SELECT * FROM gongde_free_code_families WHERE creator_id = ? FOR UPDATE", [creator.creator_id]))[0] ?? null;
        const contributionCount = (await rows(connection, "SELECT work_id FROM gongde_free_contributions WHERE creator_id = ? AND state = 'ACTIVE' FOR SHARE", [creator.creator_id])).length;
        const workCount = Number((await rows(connection, "SELECT COUNT(*) AS n FROM gongde_creator_works WHERE creator_id = ?", [creator.creator_id]))[0].n);
        items.push({ creatorId: creator.creator_id, authorPublicNumber, accountState: creator.state, workCount, contributionCount,
          maxItems: batchLimit("CREATOR", contributionCount), codeStatus: contributionCount === 0 ? "INACTIVE" :
            creator.state !== "ACTIVE" || family?.state !== "ACTIVE" ? "PAUSED" : "ACTIVE",
          familyId: family?.id ?? null, revision: family ? Number(family.revision) : null });
      }
      return { items, total };
    });
  }
  async listClaims(options: AdminQuery = {}): Promise<{ items: AdminClaimSummary[]; total: number }> {
    const [limit, offset] = this.#adminPage(options); const [from, to] = this.#dateRange(options);
    if (options.state !== undefined && !["PREPARING", "READY", "FAILED", "BLOCKED", "EXPIRED"].includes(options.state)) throw new FreeDistributionError("admin_claim_state_invalid", 400);
    return this.#transaction(async connection => {
      const now = this.#now();
      const filter = `created_at >= ? AND created_at < ? AND (? IS NULL OR family_id = ?) AND
        (? IS NULL OR (CASE WHEN state = 'READY' AND download_expires_at <= ? THEN 'EXPIRED' ELSE state END) = ?)`;
      const values = [from, to, options.familyId ?? null, options.familyId ?? null, options.state ?? null, now, options.state ?? null];
      const total = Number((await rows(connection, `SELECT COUNT(*) AS n FROM gongde_free_claims WHERE ${filter}`, values))[0].n);
      const selected = await rows(connection, `SELECT * FROM gongde_free_claims WHERE ${filter} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, values);
      const items: AdminClaimSummary[] = [];
      for (const row of selected) {
        const claim = await this.#claim(connection, row);
        const family = (await rows(connection, "SELECT kind, creator_id FROM gongde_free_code_families WHERE id = ?", [row.family_id]))[0];
        const number = family.creator_id ? (await rows(connection, "SELECT serial FROM gongde_free_creator_numbers WHERE creator_id = ?", [family.creator_id]))[0] : null;
        items.push({ claimId: claim.id, kind: family.kind, authorPublicNumber: number ? creatorPublicNumber(Number(number.serial)) : null,
          codeFamilyId: claim.codeFamilyId, state: claim.state, items: claim.items.map(item => ({ number: item.appearanceNumber,
            title: typeof item.metadataSnapshot.title === "string" ? item.metadataSnapshot.title : typeof item.metadataSnapshot.titleZh === "string" ? item.metadataSnapshot.titleZh : "",
            catalogRevision: item.catalogRevision })), bytes: claim.artifact?.bytes ?? null,
          durationMs: claim.issuedAt && row.generation_started_at ? Math.max(0, new Date(claim.issuedAt).getTime() - new Date(row.generation_started_at).getTime()) : null,
          createdAt: claim.createdAt, issuedAt: claim.issuedAt, downloadExpiresAt: claim.downloadExpiresAt, error: claim.errorCode });
      }
      return { items, total };
    });
  }
  async getStats(options: { from?: string; to?: string; familyId?: string } = {}): Promise<AdminStats> {
    const [from, to] = this.#dateRange(options); const family = options.familyId ?? null;
    return this.#transaction(async connection => {
      const ready = (await rows(connection, `SELECT COUNT(*) AS n FROM gongde_free_claims
        WHERE issued_at >= ? AND issued_at < ? AND (? IS NULL OR family_id = ?)`, [from, to, family, family]))[0];
      const works = (await rows(connection, `SELECT COUNT(*) AS n FROM gongde_free_claim_items i JOIN gongde_free_claims c ON c.id = i.claim_id
        WHERE c.issued_at >= ? AND c.issued_at < ? AND (? IS NULL OR c.family_id = ?)`, [from, to, family, family]))[0];
      const verified = (await rows(connection, `SELECT COUNT(*) AS n FROM gongde_free_verification_events
        WHERE occurred_at >= ? AND occurred_at < ? AND (? IS NULL OR family_id = ?)`, [from, to, family, family]))[0];
      return { readyClaims: Number(ready.n), workClaims: Number(works.n), verifiedCodes: Number(verified.n), installerRequests: null };
    });
  }
  async consumeLimit(input: { key: string; limit: number; windowMs: number }): Promise<{ allowed: boolean; retryAfterSeconds: number; remaining: number }> {
    if (typeof input.key !== "string" || !input.key || input.key.length > 1024 || !Number.isSafeInteger(input.limit) ||
      input.limit < 1 || input.limit > 1000000 || !Number.isSafeInteger(input.windowMs) || input.windowMs < 1000 || input.windowMs > 86400000) {
      throw new FreeDistributionError("rate_limit_configuration_invalid", 400);
    }
    const digest = createHmac("sha256", this.#secret).update("gongde-free/rate-bucket/v1\0").update(input.key).digest("hex");
    return this.#transaction(async connection => {
      const now = this.#now();
      await write(connection, `INSERT INTO gongde_free_rate_limits (bucket_digest, hits, expires_at)
        VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE bucket_digest = bucket_digest`, [digest, new Date(now.getTime() + input.windowMs)]);
      const row = (await rows(connection, "SELECT hits, expires_at FROM gongde_free_rate_limits WHERE bucket_digest = ? FOR UPDATE", [digest]))[0];
      const expired = now.getTime() >= new Date(row.expires_at).getTime();
      const hits = expired ? 0 : Number(row.hits);
      if (hits >= input.limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / 1000)), remaining: 0 };
      await write(connection, "UPDATE gongde_free_rate_limits SET hits = ?, expires_at = ? WHERE bucket_digest = ?",
      [hits + 1, expired ? new Date(now.getTime() + input.windowMs) : new Date(row.expires_at), digest]);
      return { allowed: true, retryAfterSeconds: 0, remaining: input.limit - hits - 1 };
    });
  }
}
