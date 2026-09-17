import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const GONGDE_SMS_PURPOSE = "gongde_login";

export interface SmsSender {
  sendVerificationCode(phone: string, code: string, requestId: string): Promise<void>;
}

export interface SmsVerificationPort {
  requestCode(rawPhone: string, clientKey: string, exposeDebugCode?: boolean): Promise<{
    challengeId: string;
    expiresInSeconds: number;
    retryAfterSeconds: number;
    debugCode?: string;
  }>;
  verifyCode(rawPhone: string, challengeId: string, code: string): Promise<{ sessionToken: string; expiresAt: string }>;
  requireSession(sessionToken: string): Promise<string>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

interface Challenge {
  phone: string;
  codeDigest: Buffer;
  expiresAt: number;
  attemptsRemaining: number;
}

interface Session {
  userId: string;
  expiresAt: number;
}

export class MockSmsSender implements SmsSender {
  async sendVerificationCode(): Promise<void> {}
}

function normalizeMainlandPhone(value: string): string {
  const phone = value.replace(/[\s-]/gu, "");
  const local = phone.startsWith("+86") ? phone.slice(3) : phone;
  if (!/^1[3-9]\d{9}$/u.test(local)) throw new Error("invalid_phone");
  return `+86${local}`;
}

export class SmsVerificationService implements SmsVerificationPort {
  readonly #challenges = new Map<string, Challenge>();
  readonly #sessions = new Map<string, Session>();
  readonly #lastSentAt = new Map<string, number>();
  readonly #dailyPhoneRequests = new Map<string, number>();
  readonly #hourlyClientRequests = new Map<string, number[]>();
  readonly #dailyGlobalRequests = new Map<string, number>();

  constructor(
    private readonly sender: SmsSender,
    private readonly secret: Buffer,
    private readonly now: () => number = Date.now
  ) {
    if (secret.length < 32) throw new Error("sms_identity_secret_too_short");
  }

  async requestCode(rawPhone: string, clientKey: string, exposeDebugCode = false): Promise<{
    challengeId: string;
    expiresInSeconds: number;
    retryAfterSeconds: number;
    debugCode?: string;
  }> {
    const phone = normalizeMainlandPhone(rawPhone);
    const phoneKey = this.hmac(`phone:${phone}`).toString("hex");
    const current = this.now();
    const beijingDay = new Date(current + 8 * 60 * 60_000).toISOString().slice(0, 10);
    const lastSentAt = this.#lastSentAt.get(phoneKey);
    if (lastSentAt !== undefined && current - lastSentAt < 60_000) throw new Error("sms_rate_limited");
    const recent = (this.#hourlyClientRequests.get(clientKey) ?? []).filter((time) => current - time < 3_600_000);
    if (recent.length >= 20) throw new Error("sms_client_rate_limited");
    const phoneDailyKey = `${beijingDay}:${phoneKey}`;
    const phoneDaily = this.#dailyPhoneRequests.get(phoneDailyKey) ?? 0;
    const globalDaily = this.#dailyGlobalRequests.get(beijingDay) ?? 0;
    if (phoneDaily >= 10) throw new Error("sms_phone_daily_limit");
    if (globalDaily >= 1000) throw new Error("sms_global_daily_limit");
    recent.push(current);
    this.#hourlyClientRequests.set(clientKey, recent);
    this.#dailyPhoneRequests.set(phoneDailyKey, phoneDaily + 1);
    this.#dailyGlobalRequests.set(beijingDay, globalDaily + 1);

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const challengeId = randomBytes(24).toString("base64url");
    this.#challenges.set(challengeId, {
      phone,
      codeDigest: this.hmac(`code:${challengeId}:${code}`),
      expiresAt: current + 5 * 60_000,
      attemptsRemaining: 5
    });
    this.#lastSentAt.set(phoneKey, current);
    await this.sender.sendVerificationCode(phone, code, challengeId);
    return {
      challengeId,
      expiresInSeconds: 300,
      retryAfterSeconds: 60,
      ...(exposeDebugCode ? { debugCode: code } : {})
    };
  }

  async verifyCode(rawPhone: string, challengeId: string, code: string): Promise<{ sessionToken: string; expiresAt: string }> {
    const challenge = this.#challenges.get(challengeId);
    const current = this.now();
    if (!challenge || challenge.expiresAt < current) {
      this.#challenges.delete(challengeId);
      throw new Error("sms_challenge_invalid");
    }
    if (challenge.phone !== normalizeMainlandPhone(rawPhone)) throw new Error("sms_challenge_invalid");
    if (!/^\d{6}$/u.test(code)) throw new Error("sms_code_invalid");
    const actual = this.hmac(`code:${challengeId}:${code}`);
    if (!timingSafeEqual(actual, challenge.codeDigest)) {
      challenge.attemptsRemaining -= 1;
      if (challenge.attemptsRemaining <= 0) this.#challenges.delete(challengeId);
      throw new Error("sms_code_invalid");
    }
    this.#challenges.delete(challengeId);
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = current + 30 * 24 * 60 * 60_000;
    this.#sessions.set(this.hmac(`${GONGDE_SMS_PURPOSE}:session:${sessionToken}`).toString("hex"), {
      userId: `phone_${this.hmac(`${GONGDE_SMS_PURPOSE}:identity:${challenge.phone}`).toString("hex").slice(0, 32)}`,
      expiresAt
    });
    return { sessionToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  async requireSession(sessionToken: string): Promise<string> {
    if (!sessionToken) throw new Error("phone_verification_required");
    const key = this.hmac(`${GONGDE_SMS_PURPOSE}:session:${sessionToken}`).toString("hex");
    const session = this.#sessions.get(key);
    if (!session || session.expiresAt < this.now()) {
      this.#sessions.delete(key);
      throw new Error("phone_session_invalid");
    }
    return session.userId;
  }

  async close(): Promise<void> {}
  async ready(): Promise<boolean> { return true; }

  private hmac(value: string): Buffer {
    return createHmac("sha256", this.secret).update(value).digest();
  }
}
