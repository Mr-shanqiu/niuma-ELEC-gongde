import assert from "node:assert/strict";
import test from "node:test";

import { RedisSmsVerificationService } from "../dist/auth/redis-sms-verification.js";

class FakeRedis {
  constructor(responses) {
    this.responses = [...responses];
    this.calls = [];
  }

  async eval(script, numberOfKeys, ...args) {
    this.calls.push({ script, numberOfKeys, args });
    if (this.responses.length === 0) throw new Error("unexpected_redis_call");
    return this.responses.shift();
  }

  async close() {}
}

test("Redis SMS flow stores only HMAC identities and creates a recoverable session", async () => {
  const redis = new FakeRedis([[0, 1], 1, [1, 0], "phone_0123456789abcdef0123456789abcdef"]);
  let providerRequest;
  const sender = {
    async sendVerificationCode(phone, code, requestId) {
      providerRequest = { phone, code, requestId };
    }
  };
  const service = new RedisSmsVerificationService(
    redis,
    sender,
    Buffer.alloc(32, 9),
    "test",
    () => new Date("2026-09-17T00:00:00.000Z")
  );
  const challenge = await service.requestCode("13800138000", "127.0.0.1");
  assert.equal(providerRequest.phone, "+8613800138000");
  assert.match(providerRequest.code, /^\d{6}$/u);
  const redisReservation = JSON.stringify(redis.calls[0]);
  assert.equal(redisReservation.includes("13800138000"), false);
  assert.equal(redisReservation.includes(providerRequest.code), false);

  const session = await service.verifyCode("13800138000", challenge.challengeId, providerRequest.code);
  assert.match(session.sessionToken, /^[A-Za-z0-9_-]{32,128}$/u);
  assert.equal(await service.requireSession(session.sessionToken), "phone_0123456789abcdef0123456789abcdef");
});

test("ambiguous provider outcome remains blocked instead of being auto-retried", async () => {
  const redis = new FakeRedis([[0, 1]]);
  const service = new RedisSmsVerificationService(
    redis,
    { async sendVerificationCode() { throw new Error("sms_provider_unknown"); } },
    Buffer.alloc(32, 10),
    "test"
  );
  await assert.rejects(service.requestCode("13900139000", "127.0.0.2"), /send_outcome_unknown/u);
  assert.equal(redis.calls.length, 1);
});
