import { createHash } from "node:crypto";
import { z } from "zod";
import { RedisSmsVerificationService } from "../auth/redis-sms-verification.js";
import { CREATOR_REMEMBER_SESSION_SECONDS, CREATOR_SHORT_SESSION_SECONDS, creatorPhoneIdentityDigest,
  creatorRememberMe, creatorSessionExpiry, newCreatorId, newCreatorToken, normalizeCreatorPhone } from "./auth.js";
import type { CreatorPhoneAuthConfiguration } from "./configuration.js";
import { FREE_CREATOR_TERMS, FREE_CREATOR_TERMS_VERSION } from "./free-service.js";
import type { CreatorAccountRecord, FreeCreatorRepository } from "./repository.js";
import { CreatorError } from "./types.js";

const proofFields = {
  phone: z.string().min(1).max(32),
  challengeId: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/u),
  code: z.string().regex(/^\d{6}$/u)
};
const proofSchema = z.object(proofFields).strict();
const loginSchema = z.object({ ...proofFields, rememberMe: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/u.test(value)).optional(),
  acceptTerms: z.boolean().optional(), termsVersion: z.string().max(64).optional() }).strict();

export interface CreatorPhoneAuthStatus {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  rememberMeDefault: true;
  rememberDays: 30;
  shortSessionSeconds: number;
}

export function disabledCreatorPhoneAuthStatus(reason = "disabled"): CreatorPhoneAuthStatus {
  return { enabled: false, ready: false, reason, rememberMeDefault: true,
    rememberDays: 30, shortSessionSeconds: CREATOR_SHORT_SESSION_SECONDS };
}

export class CreatorPhoneAuth {
  readonly #sms: RedisSmsVerificationService | null;
  constructor(readonly configuration: CreatorPhoneAuthConfiguration, readonly repository: FreeCreatorRepository) {
    const runtime = configuration.runtime;
    this.#sms = configuration.enabled && runtime ? RedisSmsVerificationService.connect(
      runtime.redisUrl, runtime.sender, runtime.identitySecret, configuration.environment, "gongde_creator_login"
    ) : null;
  }

  async status(): Promise<CreatorPhoneAuthStatus> {
    if (!this.#sms) return disabledCreatorPhoneAuthStatus(this.configuration.reason ?? "configuration_unavailable");
    const schemaReady = await this.repository.phoneAuthReady();
    const ready = schemaReady && await this.#sms.ready();
    return { enabled: true, ready, reason: ready ? null : schemaReady ? "state_unavailable" : "schema_unavailable",
      rememberMeDefault: true, rememberDays: 30, shortSessionSeconds: CREATOR_SHORT_SESSION_SECONDS };
  }

  async #requireReady(): Promise<RedisSmsVerificationService> {
    if (!this.#sms || !(await this.status()).ready) throw new CreatorError("creator_phone_auth_unavailable", 503);
    return this.#sms;
  }

  async #smsOperation<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      const failures: Record<string, [string, number]> = {
        invalid_phone: ["creator_phone_invalid", 400],
        sms_code_invalid: ["creator_sms_code_invalid", 401],
        sms_code_locked: ["creator_sms_code_locked", 401],
        sms_challenge_invalid: ["creator_sms_challenge_invalid", 401],
        sms_code_already_consumed: ["creator_sms_code_already_consumed", 401],
        phone_session_invalid: ["creator_sms_challenge_invalid", 401],
        sms_rate_limited: ["creator_sms_rate_limited", 429],
        sms_phone_daily_limit: ["creator_sms_rate_limited", 429],
        sms_global_daily_limit: ["creator_sms_rate_limited", 429],
        sms_send_outcome_unknown: ["creator_sms_send_outcome_unknown", 503],
        sms_provider_rejected: ["creator_sms_provider_unavailable", 503],
        sms_provider_unknown: ["creator_sms_provider_unavailable", 503]
      };
      const [safeCode, status] = failures[code] ?? ["creator_phone_auth_unavailable", 503];
      throw new CreatorError(safeCode, status);
    }
  }

  async requestCode(raw: Record<string, unknown>, clientKey: string) {
    const parsed = z.object({ phone: proofFields.phone }).strict().safeParse(raw);
    if (!parsed.success) throw new CreatorError("creator_phone_invalid");
    const phone = normalizeCreatorPhone(parsed.data.phone);
    const sms = await this.#requireReady();
    // Redis retains only HMAC identities and code digests; never expose debug codes.
    const result = await this.#smsOperation(() => sms.requestCode(phone, clientKey));
    return { challengeId: result.challengeId, expiresInSeconds: result.expiresInSeconds,
      retryAfterSeconds: result.retryAfterSeconds };
  }

  async #verify(phone: string, challengeId: string, code: string, clientKey: string): Promise<void> {
    const sms = await this.#requireReady();
    await this.repository.consumeLimit("phone-verify-ip", clientKey, 20, 900);
    await this.#smsOperation(async () => {
      // Keep the existing one-shot Redis verification/consumption contract.
      // Its proof token stays internal; it is not a creator or buyer session.
      const proof = await sms.verifyCode(phone, challengeId, code);
      const identity = await sms.requireSession(proof.sessionToken);
      if (!/^phone_[a-f0-9]{32}$/u.test(identity)) throw new Error("phone_session_invalid");
    });
  }

  async login(raw: Record<string, unknown>, clientKey: string) {
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) throw new CreatorError("creator_phone_login_invalid");
    const input = parsed.data, phone = normalizeCreatorPhone(input.phone);
    const rememberMe = creatorRememberMe(input.rememberMe);
    // Product acceptance errors must not consume a one-shot SMS challenge.
    if (input.acceptTerms !== true || input.termsVersion !== FREE_CREATOR_TERMS_VERSION) {
      throw new CreatorError("creator_terms_acceptance_required", 428);
    }
    await this.#verify(phone, input.challengeId, input.code, clientKey);
    const digest = creatorPhoneIdentityDigest(phone, this.configuration.runtime!.identitySecret);
    const existing = await this.repository.findPhoneAccount(digest);
    let registration: CreatorAccountRecord | null = null;
    if (!existing) {
      if (input.acceptTerms !== true || input.termsVersion !== FREE_CREATOR_TERMS_VERSION) {
        throw new CreatorError("creator_terms_acceptance_required", 428);
      }
      await this.repository.consumeLimit("phone-register", clientKey, 3, 3600);
      const creatorId = newCreatorId();
      registration = { creatorId, username: "~phone_" + creatorId.slice(0, 24), displayName: "\u4f5c\u8005 C" + creatorId.toUpperCase(),
        passwordHash: "phone-only-v1", recoveryDigest: null, state: "ACTIVE" };
    }
    const session = newCreatorToken();
    const expiresAt = creatorSessionExpiry(rememberMe);
    try {
      const result = await this.repository.loginPhone(digest, registration, FREE_CREATOR_TERMS_VERSION,
        createHash("sha256").update(FREE_CREATOR_TERMS).digest("hex"), session.digest, expiresAt);
      return { ...result, sessionToken: session.token, expiresAt: expiresAt.toISOString(), rememberMe };
    } catch (error) {
      if ((error as { code?: string })?.code === "ER_DUP_ENTRY") throw new CreatorError("creator_phone_already_bound", 409);
      throw error;
    }
  }

  async bind(creatorId: string, sessionDigest: string, raw: Record<string, unknown>, clientKey: string) {
    const parsed = proofSchema.safeParse(raw);
    if (!parsed.success) throw new CreatorError("creator_phone_login_invalid");
    const input = parsed.data, phone = normalizeCreatorPhone(input.phone);
    await this.repository.consumeLimit("phone-bind", creatorId, 5, 900);
    await this.#verify(phone, input.challengeId, input.code, clientKey);
    const digest = creatorPhoneIdentityDigest(phone, this.configuration.runtime!.identitySecret);
    try { await this.repository.bindPhone(creatorId, sessionDigest, digest); }
    catch (error) {
      if ((error as { code?: string })?.code === "ER_DUP_ENTRY") throw new CreatorError("creator_phone_already_bound", 409);
      throw error;
    }
    return { ok: true, phoneBound: true };
  }

  async close(): Promise<void> { await this.#sms?.close(); }
}

export { CREATOR_REMEMBER_SESSION_SECONDS };
