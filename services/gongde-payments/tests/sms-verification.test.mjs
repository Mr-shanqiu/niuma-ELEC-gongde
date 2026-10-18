import assert from "node:assert/strict";
import test from "node:test";

import { MockSmsSender, SmsVerificationService } from "../dist/auth/sms-verification.js";

test("SMS challenge verifies a phone without retaining it in the session identity", async () => {
  let now = 1_000;
  const service = new SmsVerificationService(new MockSmsSender(), Buffer.alloc(32, 7), () => now);
  const challenge = await service.requestCode("138 0013 8000", "client-1", true);
  assert.match(challenge.debugCode, /^\d{6}$/u);
  const session = await service.verifyCode("+8613800138000", challenge.challengeId, challenge.debugCode);
  assert.match(await service.requireSession(session.sessionToken), /^phone_[a-f0-9]{32}$/u);
  await assert.rejects(service.verifyCode("13800138000", challenge.challengeId, challenge.debugCode), /challenge_invalid/u);
  now += 31 * 24 * 60 * 60_000;
  await assert.rejects(service.requireSession(session.sessionToken), /session_invalid/u);
});

test("SMS requests are rate-limited and codes have five attempts", async () => {
  const service = new SmsVerificationService(new MockSmsSender(), Buffer.alloc(32, 8), () => 10_000);
  const challenge = await service.requestCode("13900139000", "client-2", true);
  await assert.rejects(service.requestCode("13900139000", "client-2", true), /rate_limited/u);
  const wrongCode = challenge.debugCode === "000000" ? "000001" : "000000";
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(service.verifyCode("13900139000", challenge.challengeId, wrongCode), /code_invalid/u);
  }
  await assert.rejects(service.verifyCode("13900139000", challenge.challengeId, challenge.debugCode), /challenge_invalid/u);
});
