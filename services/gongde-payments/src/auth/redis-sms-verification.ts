import { createHmac, randomBytes, randomInt } from "node:crypto";
import Redis from "ioredis";
import { GONGDE_SMS_PURPOSE } from "./sms-verification.js";
import type { SmsSender, SmsVerificationPort } from "./sms-verification.js";

const CODE_TTL_SECONDS = 300;
const COOLDOWN_SECONDS = 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const IP_HOURLY_LIMIT = 20;
const PHONE_DAILY_LIMIT = 10;
const GLOBAL_DAILY_LIMIT = 1000;

const RESERVE_SEND_SCRIPT = `-- GONGDE_SMS_RESERVE_SEND_V1
if redis.call('EXISTS', KEYS[6]) == 1 then return {5, 0} end
if redis.call('EXISTS', KEYS[2]) == 1 then return {1, 0} end
local ip_count = tonumber(redis.call('GET', KEYS[3]) or '0')
local phone_count = tonumber(redis.call('GET', KEYS[4]) or '0')
local global_count = tonumber(redis.call('GET', KEYS[5]) or '0')
if ip_count >= tonumber(ARGV[5]) then return {2, ip_count} end
if phone_count >= tonumber(ARGV[7]) then return {3, phone_count} end
if global_count >= tonumber(ARGV[8]) then return {4, global_count} end
redis.call('HSET', KEYS[1], 'phone', ARGV[1], 'code', ARGV[2], 'attempts', '0')
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[4])
redis.call('SET', KEYS[6], 'dispatching|' .. ARGV[9])
local next_ip = redis.call('INCR', KEYS[3])
if next_ip == 1 then redis.call('EXPIRE', KEYS[3], ARGV[6]) end
local next_phone = redis.call('INCR', KEYS[4])
if next_phone == 1 then redis.call('EXPIRE', KEYS[4], ARGV[10]) end
local next_global = redis.call('INCR', KEYS[5])
if next_global == 1 then redis.call('EXPIRE', KEYS[5], ARGV[10]) end
return {0, next_phone}
`;

const CLEANUP_SEND_SCRIPT = `-- GONGDE_SMS_CLEANUP_SEND_V1
if redis.call('GET', KEYS[6]) ~= 'dispatching|' .. ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[6])
for index = 3, 5 do
  local count = tonumber(redis.call('GET', KEYS[index]) or '0')
  if count <= 1 then redis.call('DEL', KEYS[index]) else redis.call('DECR', KEYS[index]) end
end
return 1
`;

const CONFIRM_SEND_SCRIPT = `-- GONGDE_SMS_CONFIRM_SEND_V1
if redis.call('GET', KEYS[1]) ~= 'dispatching|' .. ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

const VERIFY_AND_SESSION_SCRIPT = `-- GONGDE_SMS_VERIFY_AND_SESSION_V1
if redis.call('EXISTS', KEYS[2]) == 1 then return {-4, 0} end
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1, 0} end
local attempts = tonumber(redis.call('HGET', KEYS[1], 'attempts') or '0')
if attempts >= tonumber(ARGV[5]) then return {-3, 0} end
local expected_phone = redis.call('HGET', KEYS[1], 'phone') or ''
local expected_code = redis.call('HGET', KEYS[1], 'code') or ''
if expected_phone ~= ARGV[1] or expected_code ~= ARGV[2] then
  local next_attempts = attempts + 1
  redis.call('HSET', KEYS[1], 'attempts', next_attempts)
  if next_attempts >= tonumber(ARGV[5]) then redis.call('DEL', KEYS[1]); return {-3, 0} end
  return {-2, tonumber(ARGV[5]) - next_attempts}
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[6])
redis.call('DEL', KEYS[1])
return {1, 0}
`;

const READ_SESSION_SCRIPT = `-- GONGDE_SMS_READ_SESSION_V1
return redis.call('GET', KEYS[1])
`;

export interface SmsRedisClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  close(): Promise<void>;
}

class IoredisSmsClient implements SmsRedisClient {
  readonly #redis: Redis;
  #closed = false;

  constructor(redisUrl: string) {
    this.#redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 5_000,
      retryStrategy: () => null
    });
  }

  async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (this.#closed) throw new Error("sms_state_unavailable");
    if (this.#redis.status === "wait") await this.#redis.connect();
    if (this.#redis.status !== "ready") throw new Error("sms_state_unavailable");
    return await this.#redis.eval(script, numberOfKeys, ...args);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#redis.status === "wait" || this.#redis.status === "end") {
      this.#redis.disconnect(false);
      return;
    }
    try {
      await this.#redis.quit();
    } catch {
      this.#redis.disconnect(false);
    }
  }
}

function normalizeMainlandPhone(value: string): string {
  const phone = value.replace(/[\s-]/gu, "");
  const local = phone.startsWith("+86") ? phone.slice(3) : phone;
  if (!/^1[3-9]\d{9}$/u.test(local)) throw new Error("invalid_phone");
  return `+86${local}`;
}

function secondsUntilNextBeijingDay(now: Date): number {
  const beijing = new Date(now.getTime() + 8 * 60 * 60_000);
  const next = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() + 1) - 8 * 60 * 60_000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function resultArray(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("sms_state_unavailable");
  return value.map(Number);
}

export class RedisSmsVerificationService implements SmsVerificationPort {
  constructor(
    private readonly redis: SmsRedisClient,
    private readonly sender: SmsSender,
    private readonly secret: Buffer,
    private readonly environment = "production",
    private readonly now: () => Date = () => new Date()
  ) {
    if (secret.length < 32) throw new Error("sms_identity_secret_too_short");
  }

  static connect(redisUrl: string, sender: SmsSender, secret: Buffer, environment?: string): RedisSmsVerificationService {
    return new RedisSmsVerificationService(new IoredisSmsClient(redisUrl), sender, secret, environment);
  }

  async requestCode(rawPhone: string, clientKey: string): Promise<{
    challengeId: string; expiresInSeconds: number; retryAfterSeconds: number;
  }> {
    const phone = normalizeMainlandPhone(rawPhone);
    const current = this.now();
    const challengeId = randomBytes(24).toString("base64url");
    const challengeDigest = this.hmac("challenge", challengeId);
    const phoneHmac = this.hmac("phone", phone);
    const ipHmac = this.hmac("ip", clientKey);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHmac = this.hmac("code", `${challengeDigest}\0${phoneHmac}\0${code}`);
    const day = new Date(current.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
    const hourWindow = Math.floor(current.getTime() / 3_600_000);
    const prefix = `gongde:${this.environment}:sms:${GONGDE_SMS_PURPOSE}`;
    const keys = [
      `${prefix}:challenge:${challengeDigest}`,
      `${prefix}:cooldown:${phoneHmac}`,
      `${prefix}:ip:${ipHmac}:${hourWindow}`,
      `${prefix}:phone-day:${phoneHmac}:${day}`,
      `${prefix}:global-day:${day}`,
      `${prefix}:send-outcome:${phoneHmac}`
    ];
    let reservation: number[];
    try {
      reservation = resultArray(await this.redis.eval(
        RESERVE_SEND_SCRIPT,
        keys.length,
        ...keys,
        phoneHmac,
        codeHmac,
        CODE_TTL_SECONDS,
        COOLDOWN_SECONDS,
        IP_HOURLY_LIMIT,
        3600,
        PHONE_DAILY_LIMIT,
        GLOBAL_DAILY_LIMIT,
        challengeDigest,
        secondsUntilNextBeijingDay(current)
      ));
    } catch {
      throw new Error("sms_state_unavailable");
    }
    if (reservation[0] === 1 || reservation[0] === 2) throw new Error("sms_rate_limited");
    if (reservation[0] === 3) throw new Error("sms_phone_daily_limit");
    if (reservation[0] === 4) throw new Error("sms_global_daily_limit");
    if (reservation[0] === 5) throw new Error("sms_send_outcome_unknown");
    if (reservation[0] !== 0) throw new Error("sms_state_unavailable");

    try {
      await this.sender.sendVerificationCode(phone, code, challengeId);
    } catch (error) {
      if (error instanceof Error && error.message === "sms_provider_rejected") {
        try { await this.redis.eval(CLEANUP_SEND_SCRIPT, keys.length, ...keys, challengeDigest); } catch {}
        throw error;
      }
      throw new Error("sms_send_outcome_unknown");
    }
    try {
      const confirmed = Number(await this.redis.eval(CONFIRM_SEND_SCRIPT, 1, keys[5], challengeDigest));
      if (confirmed !== 1) throw new Error("sms_send_outcome_unknown");
    } catch {
      throw new Error("sms_send_outcome_unknown");
    }
    return { challengeId, expiresInSeconds: CODE_TTL_SECONDS, retryAfterSeconds: COOLDOWN_SECONDS };
  }

  async verifyCode(rawPhone: string, challengeId: string, code: string): Promise<{ sessionToken: string; expiresAt: string }> {
    const phone = normalizeMainlandPhone(rawPhone);
    if (!/^[A-Za-z0-9_-]{20,128}$/u.test(challengeId) || !/^\d{6}$/u.test(code)) throw new Error("sms_code_invalid");
    const challengeDigest = this.hmac("challenge", challengeId);
    const phoneHmac = this.hmac("phone", phone);
    const codeHmac = this.hmac("code", `${challengeDigest}\0${phoneHmac}\0${code}`);
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionDigest = this.hmac("session", sessionToken);
    const userId = `phone_${this.hmac("identity", phone).slice(0, 32)}`;
    const prefix = `gongde:${this.environment}:sms:${GONGDE_SMS_PURPOSE}`;
    let result: number[];
    try {
      result = resultArray(await this.redis.eval(
        VERIFY_AND_SESSION_SCRIPT,
        3,
        `${prefix}:challenge:${challengeDigest}`,
        `${prefix}:consumed:${challengeDigest}`,
        `${prefix}:session:${sessionDigest}`,
        phoneHmac,
        codeHmac,
        userId,
        SESSION_TTL_SECONDS,
        MAX_ATTEMPTS,
        CODE_TTL_SECONDS
      ));
    } catch {
      throw new Error("sms_state_unavailable");
    }
    if (result[0] === -1) throw new Error("sms_challenge_invalid");
    if (result[0] === -2) throw new Error("sms_code_invalid");
    if (result[0] === -3) throw new Error("sms_code_locked");
    if (result[0] === -4) throw new Error("sms_code_already_consumed");
    if (result[0] !== 1) throw new Error("sms_state_unavailable");
    const expiresAt = this.now().getTime() + SESSION_TTL_SECONDS * 1000;
    return { sessionToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  async requireSession(sessionToken: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(sessionToken)) throw new Error("phone_session_invalid");
    const prefix = `gongde:${this.environment}:sms:${GONGDE_SMS_PURPOSE}`;
    try {
      const userId = await this.redis.eval(
        READ_SESSION_SCRIPT,
        1,
        `${prefix}:session:${this.hmac("session", sessionToken)}`
      );
      if (typeof userId !== "string" || !/^phone_[a-f0-9]{32}$/u.test(userId)) throw new Error("phone_session_invalid");
      return userId;
    } catch (error) {
      if (error instanceof Error && error.message === "phone_session_invalid") throw error;
      throw new Error("sms_state_unavailable");
    }
  }

  async close(): Promise<void> {
    await this.redis.close();
  }

  async ready(): Promise<boolean> {
    try {
      return await this.redis.eval("return redis.call('PING')", 0) === "PONG";
    } catch {
      return false;
    }
  }

  private hmac(context: string, value: string): string {
    return createHmac("sha256", this.secret).update(GONGDE_SMS_PURPOSE).update("\0").update(context).update("\0").update(value).digest("hex");
  }
}
