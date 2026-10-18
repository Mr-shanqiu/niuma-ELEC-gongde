import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { creatorTokenDigest, hashCreatorPassword, newCreatorId, newCreatorToken, verifyCreatorPassword } from "./auth.js";
import { validateCreatorSourcePack } from "./pack-validation.js";
import { normalizeCreatorSourceArchive } from "./source-normalization.js";
import { CreatorAutoReviewer } from "./auto-review.js";
import { CreatorSourceStore } from "./object-store.js";
import { FreeCreatorRepository, type CreatorAccountRecord, type FreeWorkMetadata, type FreeVersionRecord } from "./repository.js";
import { creatorWorkId, CreatorError } from "./types.js";
import { randomBytes } from "node:crypto";
import type { AppearancePackSigner } from "../delivery/pack-signer.js";
import type { GongdeEntitlement, MarketOrderItem } from "../domain/types.js";
import { FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS, FREE_CREATOR_AI_TERMS_VERSION,
  LEGACY_PAID_CREATOR_TERMS_VERSION, hasCurrentFreeConsent } from "./consent.js";
import { parseCreatorMetadata } from "./metadata.js";
import type { FreeBatchSelection } from "./free-batch-delivery.js";
import { creatorContentFingerprint, creatorSourceContentFingerprint } from "./content-fingerprint.js";
import { assertExcluded } from "../free-distribution/exclusions.js";

export { FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_TERMS, FREE_CREATOR_AI_TERMS_VERSION,
  FREE_CREATOR_AI_TERMS, FREE_CREATOR_TERMS_SHA256, FREE_CREATOR_AI_TERMS_SHA256 } from "./consent.js";

const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/u);
const labelSchema = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const identifier = z.string().regex(/^[a-f0-9]{32}$/u);
const workIdentifier = z.string().regex(/^creator\.[a-f0-9]{32}\.[a-z0-9][a-z0-9-]{0,31}$/u);
const publicAccount = (account: CreatorAccountRecord) => ({
  creatorId: account.creatorId, publicNumber: account.publicNumber ?? null,
  username: account.passwordHash === "phone-only-v1" ? undefined : account.username,
  displayName: account.publicNumber ? "作者 " + account.publicNumber :
    account.passwordHash === "phone-only-v1" ? "作者" : account.displayName
});

function preview(version: FreeVersionRecord, audience: "creator" | "admin" | "public") {
  const base = audience === "admin" ? "/api/gongde/admin/creators" :
    audience === "creator" ? "/api/gongde/creators" : "/api/gongde/community";
  return {
    versionId: version.versionId, workId: version.workId, versionLabel: version.versionLabel,
    draftVersionId: version.versionId,
    state: version.state, revision: version.revision, archiveSha256: version.archiveSha256,
    manifest: version.manifest,
    images: Object.fromEntries(version.validation.imageNames.map(name =>
      [name, `${base}/versions/${version.versionId}/images/${encodeURIComponent(name)}`])),
    createdAt: version.createdAt, deliveryBytesUpperBound: version.deliveryBytesUpperBound
  };
}

export class FreeCreatorService {
  #automaticReview: CreatorAutoReviewer | null = null;

  get reviewMode() { return this.#automaticReview?.mode ?? "disabled"; }

  enableAutomaticReview(): void {
    if (this.#automaticReview) return;
    this.#automaticReview = new CreatorAutoReviewer(this.repository, this.objects);
    this.#automaticReview.start();
  }

  async close(): Promise<void> {
    await this.#automaticReview?.close();
    await this.repository.close();
  }
  #passwordOperations = 0;
  #uploads = 0;
  constructor(readonly repository: FreeCreatorRepository, readonly objects: CreatorSourceStore) {
  }

  async #assertExclusions(contentFingerprint: string): Promise<void> {
    if (process.env.GONGDE_FREE_DISTRIBUTION_ENABLED !== "true") return;
    const connection = await this.repository.pool.getConnection();
    try {
      await connection.beginTransaction();
      await assertExcluded(connection, contentFingerprint);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string })?.code === "contribution_sample_excluded") {
        throw new CreatorError("creator_duplicate_work", 409);
      }
      throw new CreatorError("creator_exclusions_unavailable", 503);
    } finally { connection.release(); }
  }

  async #password<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#passwordOperations >= 2) throw new CreatorError("creator_auth_busy", 503);
    this.#passwordOperations += 1;
    try { return await operation(); } finally { this.#passwordOperations -= 1; }
  }

  async register(raw: Record<string, unknown>, clientKey: string) {
    await this.repository.consumeLimit("register", clientKey, 3, 3600);
    const parsed = z.object({ username: usernameSchema, displayName: labelSchema,
      password: z.string(), termsVersion: z.literal(FREE_CREATOR_TERMS_VERSION), acceptTerms: z.literal(true) }).strict().safeParse(raw);
    if (!parsed.success) throw new CreatorError("creator_registration_invalid");
    const recovery = newCreatorToken();
    const account: CreatorAccountRecord = {
      creatorId: newCreatorId(), username: parsed.data.username, displayName: parsed.data.displayName,
      passwordHash: await this.#password(() => hashCreatorPassword(parsed.data.password)),
      recoveryDigest: recovery.digest, state: "ACTIVE"
    };
    await this.repository.createAccount(account, FREE_CREATOR_TERMS_VERSION,
      createHash("sha256").update(FREE_CREATOR_TERMS).digest("hex"));
    account.publicNumber = await this.repository.ensureCreatorPublicNumber(account.creatorId);
    const session = await this.#session(account);
    return { account: publicAccount(account), recoveryKey: recovery.token, ...session };
  }

  async login(raw: Record<string, unknown>, clientKey: string) {
    await this.repository.consumeLimit("login-ip", clientKey, 20, 900);
    const parsed = z.object({ username: usernameSchema, password: z.string().max(512) }).strict().safeParse(raw);
    if (!parsed.success) throw new CreatorError("creator_login_failed", 401);
    await this.repository.consumeLimit("login-account", parsed.data.username, 10, 900);
    const account = await this.repository.findAccount(parsed.data.username);
    const valid = await this.#password(() => verifyCreatorPassword(parsed.data.password, account?.passwordHash ?? null));
    if (!valid || account?.state !== "ACTIVE") throw new CreatorError("creator_login_failed", 401);
    account.publicNumber = await this.repository.ensureCreatorPublicNumber(account.creatorId);
    return { account: publicAccount(account), ...await this.#session(account) };
  }

  async #session(account: CreatorAccountRecord) {
    const session = newCreatorToken();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await this.repository.createSession(account.creatorId, account.passwordHash, session.digest, expiresAt);
    return { sessionToken: session.token, expiresAt: expiresAt.toISOString() };
  }

  async recover(raw: Record<string, unknown>, clientKey: string) {
    await this.repository.consumeLimit("recover-ip", clientKey, 5, 3600);
    const parsed = z.object({ username: usernameSchema, recoveryKey: z.string().regex(/^[a-f0-9]{64}$/u),
      password: z.string() }).strict().safeParse(raw);
    if (!parsed.success) throw new CreatorError("creator_recovery_failed", 401);
    await this.repository.consumeLimit("recover-account", parsed.data.username, 5, 3600);
    const account = await this.repository.findAccount(parsed.data.username);
    const supplied = creatorTokenDigest(parsed.data.recoveryKey);
    const expected = account?.recoveryDigest ?? "0".repeat(64);
    const valid = timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
    if (!valid || account?.state !== "ACTIVE") throw new CreatorError("creator_recovery_failed", 401);
    const recovery = newCreatorToken();
    const passwordHash = await this.#password(() => hashCreatorPassword(parsed.data.password));
    await this.repository.recoverAccount(account.creatorId, supplied, passwordHash, recovery.digest);
    return { recoveryKey: recovery.token };
  }

  async requireAccount(token: string): Promise<CreatorAccountRecord> {
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new CreatorError("creator_auth_required", 401);
    const account = await this.repository.session(creatorTokenDigest(token));
    if (!account) throw new CreatorError("creator_auth_required", 401);
    return account;
  }

  async logout(token: string): Promise<void> {
    if (/^[a-f0-9]{64}$/u.test(token)) await this.repository.deleteSession(creatorTokenDigest(token));
  }

  account(account: CreatorAccountRecord) { return publicAccount(account); }

  async createWork(account: CreatorAccountRecord, raw: Record<string, unknown>) {
    const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u)
      .safeParse(raw.slug === undefined || raw.slug === "" ? newCreatorId() : raw.slug);
    if (!slug.success) throw new CreatorError("creator_slug_invalid");
    const { slug: _slug, ...fields } = raw;
    const data = parseCreatorMetadata(fields);
    await this.repository.consumeLimit("work-create", account.creatorId, 20, 86400);
    const workId = creatorWorkId(account.creatorId, slug.data);
    await this.repository.createWork(account.creatorId, workId, slug.data, data);
    return { ...await this.repository.ownedWork(account.creatorId, workId), draftVersionId: null };
  }

  async updateWork(account: CreatorAccountRecord, workId: string, raw: Record<string, unknown>) {
    if (!workIdentifier.safeParse(workId).success) throw new CreatorError("creator_work_not_found", 404);
    const current = await this.repository.ownedWork(account.creatorId, workId);
    await this.repository.updateWork(account.creatorId, workId, parseCreatorMetadata(raw, current.metadata));
    const draftVersionId = await this.repository.prepareDraftVersion(account.creatorId, workId);
    return { ...await this.repository.ownedWork(account.creatorId, workId), draftVersionId };
  }

  async upload(account: CreatorAccountRecord, workId: string, archive: Buffer) {
    await this.repository.consumeLimit("upload", account.creatorId, 20, 86400);
    const work = await this.repository.ownedWork(account.creatorId, workId);
    if (work.state === "SUSPENDED") throw new CreatorError("creator_work_suspended", 409);
    if (this.#uploads >= 2) throw new CreatorError("creator_upload_busy", 503);
    this.#uploads += 1;
    try {
      const normalized = normalizeCreatorSourceArchive(archive, { creatorId: account.creatorId, slug: work.slug });
      const pack = normalized.pack;
      await this.#assertExclusions(creatorContentFingerprint(pack));
      const existing = await this.repository.versions(account.creatorId, workId);
      const duplicate = existing.find(version => version.revision === pack.revision);
      if (duplicate) return preview(duplicate, "creator");
      if (existing.length >= 20) throw new CreatorError("creator_version_limit", 409);
      const stored = await this.objects.putSource(account.creatorId, normalized.archive, pack);
      const version: FreeVersionRecord = {
        versionId: newCreatorId(), workId, creatorId: account.creatorId, slug: work.slug,
        versionLabel: pack.manifest.version, state: "READY", revision: pack.revision,
        archiveSha256: pack.archiveSha256, sourceObjectKey: stored.sourceObjectKey,
        previewObjectKey: stored.previewObjectKey, manifest: pack.manifest,
        validation: { imageNames: stored.imageNames, archiveBytes: normalized.archive.length,
          unpackedBytes: pack.unpackedBytes, decodedImageBytes: pack.decodedImageBytes,
          originalArchiveSha256: normalized.originalArchiveSha256, normalization: "png-data-only-v1",
          contentFingerprint: creatorContentFingerprint(pack) },
        approvedMetadata: null, deliveryBytesUpperBound: pack.deliveryBytesUpperBound, createdAt: new Date().toISOString()
      };
      await this.repository.saveVersion(account.creatorId, version);
      return preview(version, "creator");
    } finally { this.#uploads -= 1; }
  }

  async versions(account: CreatorAccountRecord, workId: string) {
    const versions = await this.repository.versions(account.creatorId, workId);
    const reviews = await this.repository.reviewHistory(account.creatorId, workId);
    return versions.map(version => ({ ...preview(version, "creator"),
      review: reviews.find(review => review.versionId === version.versionId) ?? null }));
  }

  async submit(account: CreatorAccountRecord, workId: string, versionId: string, raw: Record<string, unknown>) {
    const freeVersion = raw.acceptedFreeTermsVersion ?? raw.sharingTermsVersion;
    const aiVersion = raw.acceptedAiTermsVersion ?? raw.aiReviewTermsVersion;
    if (!identifier.safeParse(versionId).success || freeVersion !== FREE_CREATOR_TERMS_VERSION ||
        (raw.acceptFreeDistribution !== true && raw.acceptedFreeTermsVersion !== FREE_CREATOR_TERMS_VERSION)) {
      throw new CreatorError("creator_sharing_acceptance_required", 400, "acceptFreeDistribution");
    }
    if (aiVersion !== FREE_CREATOR_AI_TERMS_VERSION ||
        (raw.acceptAiContentReview !== true && raw.acceptedAiTermsVersion !== FREE_CREATOR_AI_TERMS_VERSION)) {
      throw new CreatorError("creator_ai_review_acceptance_required", 400, "acceptAiContentReview");
    }
    const version = await this.repository.getVersion(versionId);
    if (version.creatorId !== account.creatorId || version.workId !== workId) throw new CreatorError("creator_version_not_found", 404);
    if (raw.previewRevision !== version.revision) throw new CreatorError("creator_preview_outdated", 409, "previewRevision");
    // Never trust a stored validation fingerprint or caller metadata. Read the
    // exact owned source, prove its revision/archive binding, then normalize and
    // fingerprint with the same implementation as review/publication/seeding.
    const archive = await this.objects.source(version.creatorId, version.archiveSha256);
    const pack = validateCreatorSourcePack(archive, { creatorId: version.creatorId, slug: version.slug });
    if (pack.revision !== version.revision || pack.archiveSha256 !== version.archiveSha256) {
      throw new CreatorError("creator_source_integrity_failed", 503);
    }
    await this.#assertExclusions(creatorSourceContentFingerprint(archive, { creatorId: version.creatorId, slug: version.slug }));
    await this.repository.consumeLimit("submit", account.creatorId, 20, 86400);
    const pendingReviewId = await this.repository.grantPendingAiReviewConsent(account.creatorId, workId, versionId);
    const reviewId = pendingReviewId ?? await this.repository.submit(account.creatorId, workId, versionId, true);
    this.#automaticReview?.wake();
    const submittedVersionId = (await this.repository.getReview(reviewId)).versionId;
    return { reviewId, versionId: submittedVersionId, draftVersionId: submittedVersionId, reviewMode: this.reviewMode };
  }

  async withdraw(account: CreatorAccountRecord, workId: string): Promise<void> {
    await this.repository.withdrawReview(account.creatorId, workId);
  }

  async reviewPreview(versionId: string) {
    if (!identifier.safeParse(versionId).success) throw new CreatorError("creator_version_not_found", 404);
    return preview(await this.repository.getVersion(versionId), "admin");
  }

  async preview(versionId: string, access: { audience: "public" | "admin" | "creator"; creatorId?: string }) {
    if (!identifier.safeParse(versionId).success) throw new CreatorError("creator_version_not_found", 404);
    const version = await this.repository.getVersion(versionId);
    if (access.audience === "creator" && version.creatorId !== access.creatorId) throw new CreatorError("creator_version_not_found", 404);
    if (access.audience === "public") await this.repository.published(version.workId, versionId);
    return preview(version, access.audience);
  }

  async decide(admin: string, reviewId: string, raw: Record<string, unknown>): Promise<void> {
    const parsed = z.object({ decision: z.enum(["APPROVED", "REJECTED"]),
      reason: z.string().trim().max(1000), checks: z.object({ dataOnly: z.boolean(), realPreview: z.boolean(),
        contentAcceptable: z.boolean(), rightsDeclaration: z.boolean() }).strict() }).strict().safeParse(raw);
    if (!parsed.success || !identifier.safeParse(reviewId).success) throw new CreatorError("creator_review_invalid");
    const { decision, reason, checks } = parsed.data;
    if (decision === "APPROVED" && Object.values(checks).some(value => !value)) throw new CreatorError("creator_review_checks_required");
    if (decision === "REJECTED" && reason.length < 5) throw new CreatorError("creator_review_reason_required");
    let contentFingerprint: string | undefined;
    if (decision === "APPROVED") {
      const review = await this.repository.getReview(reviewId);
      const version = await this.repository.getVersion(review.versionId);
      const archive = await this.objects.source(version.creatorId, version.archiveSha256);
      const pack = validateCreatorSourcePack(archive, { creatorId: version.creatorId, slug: version.slug });
      if (pack.revision !== version.revision || pack.archiveSha256 !== version.archiveSha256) {
        throw new CreatorError("creator_source_integrity_failed", 503);
      }
      contentFingerprint = creatorSourceContentFingerprint(archive, { creatorId: version.creatorId, slug: version.slug });
    }
    await this.repository.decide(admin, reviewId, decision, reason, checks, undefined, contentFingerprint);
  }

  async grantFreeConsent(account: CreatorAccountRecord, workId: string, raw: Record<string, unknown>) {
    if (raw.acceptedFreeTermsVersion !== FREE_CREATOR_TERMS_VERSION || raw.acceptedAiTermsVersion !== FREE_CREATOR_AI_TERMS_VERSION) {
      throw new CreatorError("creator_sharing_acceptance_required", 400, "acceptedFreeTermsVersion");
    }
    if (!identifier.safeParse(raw.versionId).success) throw new CreatorError("creator_version_not_found", 404);
    const version = await this.repository.getVersion(raw.versionId as string);
    if (version.creatorId !== account.creatorId || version.workId !== workId) throw new CreatorError("creator_version_not_found", 404);
    if (raw.previewRevision !== version.revision) throw new CreatorError("creator_preview_outdated", 409, "previewRevision");
    const archive = await this.objects.source(version.creatorId, version.archiveSha256);
    const pack = validateCreatorSourcePack(archive, { creatorId: version.creatorId, slug: version.slug });
    if (pack.revision !== version.revision || pack.archiveSha256 !== version.archiveSha256) {
      throw new CreatorError("creator_source_integrity_failed", 503);
    }
    await this.repository.grantFreeConsent(account.creatorId, workId, version.versionId, version.revision,
      version.archiveSha256, creatorSourceContentFingerprint(archive, { creatorId: version.creatorId, slug: version.slug }));
    return { versionId: version.versionId, draftVersionId: version.versionId, evidenceReused: true };
  }

  async image(versionId: string, name: string, access: { audience: "public" | "admin" | "creator"; creatorId?: string }): Promise<Buffer> {
    if (!identifier.safeParse(versionId).success) throw new CreatorError("creator_version_not_found", 404);
    const version = await this.repository.getVersion(versionId);
    if (access.audience === "creator" && version.creatorId !== access.creatorId) throw new CreatorError("creator_version_not_found", 404);
    if (access.audience === "public") await this.repository.published(version.workId, versionId);
    if (!version.validation.imageNames.includes(name)) throw new CreatorError("creator_image_not_found", 404);
    return this.objects.image(version.creatorId, version.archiveSha256, name);
  }

  async republish(account: CreatorAccountRecord, workId: string): Promise<void> {
    await this.repository.consumeLimit("republish", account.creatorId, 20, 86400);
    const current = await this.repository.ownedWork(account.creatorId, workId);
    if (current.state !== "UNPUBLISHED" || !current.publishedVersionId || !current.publishedMetadata) {
      throw new CreatorError("creator_republish_not_available", 409);
    }
    const version = await this.repository.getVersion(current.publishedVersionId);
    if (version.workId !== workId || version.creatorId !== account.creatorId || version.state !== "APPROVED" || !version.approvedMetadata) {
      throw new CreatorError("creator_republish_not_available", 409);
    }
    await this.repository.approvedReviewId(version.versionId);
    const archive = await this.objects.source(account.creatorId, version.archiveSha256);
    const pack = validateCreatorSourcePack(archive, { creatorId: account.creatorId, slug: current.slug });
    if (pack.revision !== version.revision) throw new CreatorError("creator_source_integrity_failed", 503);
    await this.repository.republishWork(account.creatorId, workId, version.versionId, version.revision, version.archiveSha256,
      creatorSourceContentFingerprint(archive, { creatorId: account.creatorId, slug: current.slug }));
  }

  async freeBatch(_raw: Record<string, unknown>, _clientKey: string): Promise<never> {
    throw new CreatorError("creator_free_delivery_retired", 410);
  }

  async resolvePaidWorks(ids: readonly string[], previewRevisions: Record<string, unknown>) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || new Set(ids).size !== ids.length) {
      throw new CreatorError("market_selection_limit_exceeded");
    }
    const output = [];
    for (const assetId of ids) {
      const match = /^creator\.([a-f0-9]{32})\.([a-z0-9][a-z0-9-]{0,31})$/u.exec(assetId);
      if (!match || typeof previewRevisions[assetId] !== "string") throw new CreatorError("market_catalog_snapshot_invalid", 409);
      const workId = assetId;
      const { work, version } = await this.repository.published(workId);
      const approved = version.approvedMetadata;
      if (version.revision !== previewRevisions[assetId]) throw new CreatorError("appearance_preview_outdated", 409);
      if (work.creatorId !== match[1] || work.slug !== match[2] ||
          !approved || approved.acceptPaidDistribution !== true || approved.priceFen !== 20 ||
          approved.sharingTermsVersion !== LEGACY_PAID_CREATOR_TERMS_VERSION) {
        throw new CreatorError("market_catalog_snapshot_invalid", 409);
      }
      await this.repository.authorizePaidVersion(work.creatorId, workId, version.versionId, version.revision);
      output.push({ assetId, creatorId: work.creatorId, workId, versionId: version.versionId,
        versionLabel: version.versionLabel, sourceRevision: version.revision, titleZh: approved.titleZh,
        unitPriceFen: 20 as const, revenueRuleVersion: LEGACY_PAID_CREATOR_TERMS_VERSION,
        deliveryBytesUpperBound: version.deliveryBytesUpperBound });
    }
    return output;
  }

  async authorizePaidItems(items: readonly MarketOrderItem[]): Promise<void> {
    for (const item of items) {
      if (item.sourceKind !== "community") continue;
      if (!item.creatorId || !item.workId || !item.versionId || item.assetId !== item.workId ||
          item.unitPriceFen !== 20 || item.creatorShareBps !== 0 || item.creatorAmountFen !== 0 ||
          item.platformAmountFen !== item.amountFen || item.revenueRuleVersion !== LEGACY_PAID_CREATOR_TERMS_VERSION ||
          !/^[a-f0-9]{64}$/u.test(item.sourceRevision)) throw new CreatorError("creator_paid_order_invalid", 409);
      await this.repository.authorizePaidVersion(item.creatorId, item.workId, item.versionId, item.sourceRevision);
    }
  }

  async buildPaidPack(item: MarketOrderItem, delivery: GongdeEntitlement, signer: AppearancePackSigner) {
    await this.authorizePaidItems([item]);
    if (item.sourceKind !== "community" || delivery.scope !== "asset-download" ||
        delivery.orderNo !== item.orderNo || delivery.assetId !== item.assetId || delivery.state !== "ACTIVE" ||
        !delivery.activatedAt || !delivery.expiresAt || delivery.expiresAt.getTime() <= Date.now()) {
      throw new CreatorError("creator_paid_delivery_unavailable", 409);
    }
    const version = await this.repository.getVersion(item.versionId!);
    const work = await this.repository.ownedWork(item.creatorId!, item.workId!);
    const reviewId = await this.repository.authorizePaidVersion(item.creatorId!, item.workId!, item.versionId!, item.sourceRevision);
    const archive = await this.objects.source(version.creatorId, version.archiveSha256);
    const pack = signer.buildCommunity({ archive, creatorId: work.creatorId, slug: work.slug, reviewId,
      revision: item.sourceRevision, archiveSha256: version.archiveSha256,
      downloadId: randomBytes(24).toString("base64url"), issuedAt: new Date(), expiresAt: delivery.expiresAt });
    return { filename: pack.filename, content: pack.content, importBefore: pack.importBefore };
  }

  async publicWorks(offset: number) {
    return (await this.repository.publicWorks(offset)).map(({ work, version }) => ({
      workId: work.workId, appearanceNumber: work.appearanceNumber, metadata: work.publishedMetadata,
      creatorDouyinNumber: work.publishedMetadata?.creatorDouyinNumber ?? null,
      creatorId: work.creatorId, firstPublishedAt: work.firstPublishedAt,
      canClaim: hasCurrentFreeConsent(version.approvedMetadata),
      priceFen: work.publishedMetadata?.priceFen ?? 0,
      purchasable: work.publishedMetadata?.acceptPaidDistribution === true && work.publishedMetadata.priceFen === 20 &&
        work.publishedMetadata.sharingTermsVersion === LEGACY_PAID_CREATOR_TERMS_VERSION,
      sharePath: `/appearance.html?number=${work.appearanceNumber}`,
      preview: preview(version, "public")
    }));
  }

  async publicWork(workId: string) {
    const { work, version } = await this.repository.published(workId);
    return { workId: work.workId, appearanceNumber: work.appearanceNumber, metadata: work.publishedMetadata,
      creatorDouyinNumber: work.publishedMetadata?.creatorDouyinNumber ?? null,
      creatorId: work.creatorId, firstPublishedAt: work.firstPublishedAt,
      canClaim: hasCurrentFreeConsent(version.approvedMetadata),
      priceFen: work.publishedMetadata?.priceFen ?? 0,
      purchasable: work.publishedMetadata?.acceptPaidDistribution === true && work.publishedMetadata.priceFen === 20 &&
        work.publishedMetadata.sharingTermsVersion === LEGACY_PAID_CREATOR_TERMS_VERSION,
      sharePath: `/appearance.html?number=${work.appearanceNumber}`, preview: preview(version, "public") };
  }

  // Internal v2 integration. The caller owns access-code/claim authorization.
  async resolveFreeWorks(ids: readonly string[], previewRevisions?: Record<string, unknown>) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || new Set(ids).size !== ids.length) {
      throw new CreatorError("creator_free_batch_count_invalid");
    }
    const output = [];
    for (const workId of ids) {
      const { work, version } = await this.repository.published(workId);
      if (previewRevisions && previewRevisions[workId] !== version.revision) {
        throw new CreatorError("appearance_preview_outdated", 409);
      }
      const reviewId = await this.repository.authorizeFreeVersion(work.creatorId, workId, version.versionId, version.revision);
      output.push({ sourceKind: "community" as const, assetId: workId, workId, creatorId: work.creatorId,
        slug: work.slug, appearanceNumber: work.appearanceNumber, versionId: version.versionId,
        versionLabel: version.versionLabel, sourceRevision: version.revision, revision: version.revision,
        archiveSha256: version.archiveSha256, reviewId,
        metadata: structuredClone(version.approvedMetadata!),
        deliveryBytesUpperBound: version.deliveryBytesUpperBound });
    }
    return output;
  }

  async loadFrozenSource(selection: FreeBatchSelection): Promise<Buffer> {
    const frozen = { ...selection };
    const reviewId = await this.repository.authorizeFreeVersion(frozen.creatorId, frozen.workId, frozen.versionId, frozen.revision);
    const version = await this.repository.getVersion(frozen.versionId);
    if (reviewId !== frozen.reviewId || version.archiveSha256 !== frozen.archiveSha256 || version.slug !== frozen.slug) {
      throw new CreatorError("creator_free_snapshot_changed", 409);
    }
    const archive = await this.objects.source(frozen.creatorId, frozen.archiveSha256);
    const pack = validateCreatorSourcePack(archive, { creatorId: frozen.creatorId, slug: frozen.slug });
    if (pack.revision !== frozen.revision || pack.archiveSha256 !== frozen.archiveSha256) {
      throw new CreatorError("creator_source_integrity_failed", 503);
    }
    // A safety suspension racing the storage read must still stop signing.
    await this.repository.authorizeFreeVersion(frozen.creatorId, frozen.workId, frozen.versionId, frozen.revision);
    return archive;
  }

  async report(workId: string, raw: Record<string, unknown>, clientKey: string) {
    await this.repository.consumeLimit("report", clientKey, 5, 3600);
    const parsed = z.object({ versionId: identifier, category: z.enum(["copyright", "unsafe", "personal-data", "other"]),
      description: z.string().trim().min(10).max(2000) }).strict().safeParse(raw);
    if (!parsed.success) throw new CreatorError("creator_report_invalid");
    return { complaintId: await this.repository.report(workId, parsed.data.versionId, parsed.data.category, parsed.data.description) };
  }
}
