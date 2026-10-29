import assert from "node:assert/strict";
import test from "node:test";

import { AdminAuthService } from "../dist/admin/auth.js";

test("admin session is signed, expires, and clears without exposing the password", () => {
  let now = Date.parse("2026-09-28T08:00:00.000Z");
  const auth = new AdminAuthService({
    username: "admin",
    password: "correct horse battery staple",
    sessionSecret: "0123456789abcdef0123456789abcdef",
    secureCookie: true
  }, () => now);
  const token = auth.login("admin", "correct horse battery staple", "local");
  assert.equal(auth.requireSession(`gongde_admin_session=${token}`).username, "admin");
  assert.doesNotMatch(token, /correct horse/u);
  assert.match(auth.sessionCookie(token), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/u);
  now += 8 * 60 * 60 * 1000 + 1;
  assert.throws(() => auth.requireSession(`gongde_admin_session=${token}`), /admin_auth_required/u);
});

test("admin login rate limits repeated failures", () => {
  const auth = new AdminAuthService({
    username: "admin",
    password: "correct horse battery staple",
    sessionSecret: "0123456789abcdef0123456789abcdef",
    secureCookie: false
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => auth.login("admin", "wrong-password", "client"), /admin_invalid_credentials/u);
  }
  assert.throws(() => auth.login("admin", "correct horse battery staple", "client"), /admin_login_rate_limited/u);
});

test("trusted proxy keeps separate clients in separate login buckets", async () => {
  const { creatorClientKey } = await import("../dist/creators/client-key.js");
  const request = ip => ({ socket: { remoteAddress: "172.21.0.2" }, headers: { "x-real-ip": ip }, rawHeaders: ["x-real-ip", ip] });
  const proxy = ["172.21.0.2"];
  const first = creatorClientKey(request("192.0.2.10"), proxy);
  const second = creatorClientKey(request("192.0.2.11"), proxy);
  assert.notEqual(first, second);
  const auth = new AdminAuthService({ username: "admin", password: "test-password", sessionSecret: "0123456789abcdef0123456789abcdef", secureCookie: false });
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login("admin", "wrong", first), /admin_invalid_credentials/u);
  assert.throws(() => auth.login("admin", "test-password", first), /admin_login_rate_limited/u);
  assert.ok(auth.login("admin", "test-password", second));
  assert.throws(() => creatorClientKey({ ...request("192.0.2.10"), socket: { remoteAddress: "192.0.2.99" } }, proxy), /creator_proxy_peer_untrusted/u);
});
