import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Counting redirect and download report, against the real server.
 *
 * COS is replaced by an in-memory client, so nothing here reaches the network,
 * a real bucket or a real installer. Only loopback HTTP is fetched, and the
 * redirect is never followed: its Location is read from the response.
 */
for (const key of Object.keys(process.env)) if (key.startsWith("GONGDE_")) delete process.env[key];

const MAC = "niuma-merit-macos-0.9.4-test.dmg";
const WIN = "niuma-merit-windows-0.9.4-test-setup.exe";
const OLD = "niuma-merit-macos-0.9.3-test.dmg";

class MemoryCos {
  objects = new Map();
  failPut = false;

  getBucket(params, callback) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(params.Prefix)).sort();
    callback(null, {
      Contents: keys.map((key) => ({ Key: key, Size: String(this.objects.get(key).length), LastModified: new Date().toISOString() })),
      IsTruncated: "false"
    });
  }

  putObject(params, callback) {
    if (this.failPut) return callback(new Error("synthetic_storage_failure"));
    this.objects.set(params.Key, Buffer.from(params.Body));
    callback(null, {});
  }

  deleteObject(params, callback) {
    this.objects.delete(params.Key);
    callback(null, {});
  }

  getObject(params, callback) {
    const body = this.objects.get(params.Key);
    if (!body) return callback(new Error("NoSuchKey"), {});
    callback(null, { Body: body });
  }
}

// The installer prefix is the bucket root, so an event key is ".download-events/…".
const EVENTS = ".download-events/";
const cos = new MemoryCos();
mock.module("cos-nodejs-sdk-v5", {
  defaultExport: class {
    constructor() { return cos; }
  }
});

const root = await mkdtemp(join(fileURLToPath(new URL("../../../.local-work/acceptance/", import.meta.url)), "download-counting-"));
const registryFile = join(root, "installers.json");
const passwordFile = join(root, "admin-password.txt");
const sessionFile = join(root, "admin-session.txt");
const password = "synthetic-local-admin-password";

await writeFile(passwordFile, password, { mode: 0o600 });
await writeFile(sessionFile, "synthetic-local-session-secret-at-least-32-bytes", { mode: 0o600 });

const registry = (items) => writeFile(registryFile, JSON.stringify({ schemaVersion: 1, items }));
const entry = (name, platform, version) => ({
  name, platform, version, format: platform === "macos" ? "dmg" : "exe", releaseId: `rel-${name}`,
  bytes: 1024, sha256: "a".repeat(64), perpetualCompatible: true,
  publicDownloadUrl: `https://download.gongde.zqscreen.cn/${name}`
});

await registry([
  entry(MAC, "macos", "0.9.4"),
  entry(WIN, "windows", "0.9.4"),
  entry(OLD, "macos", "0.9.3")
]);

// The counting start is set explicitly: a report with no start cannot claim a
// complete total, and that is a separate state the page has to show.
const countedSince = "2026-10-20T00:00:00.000Z";
Object.assign(process.env, {
  HOST: "127.0.0.1", PORT: "0",
  GONGDE_PAYMENT_MODE: "mock", GONGDE_PAYMENT_TEST_TOKEN: "local-download-test-token-0123456789",
  GONGDE_STORE_MODE: "memory", GONGDE_PACK_DELIVERY_MODE: "disabled",
  GONGDE_ADMIN_USERNAME: "test-admin",
  GONGDE_ADMIN_PASSWORD_FILE: passwordFile,
  GONGDE_ADMIN_SESSION_SECRET_FILE: sessionFile,
  GONGDE_COS_SECRET_ID: "synthetic-id", GONGDE_COS_SECRET_KEY: "synthetic-key",
  GONGDE_FREE_INSTALLERS_FILE: registryFile,
  GONGDE_DOWNLOAD_COUNT_SINCE: countedSince
});

const { server } = await import("../dist/server.js");
if (!server.listening) await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const get = (path, headers = {}) => fetch(origin + path, { redirect: "manual", headers });

test("download counting and report", { timeout: 20000 }, async (t) => {
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  });

  const login = await fetch(origin + "/api/gongde/admin/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "test-admin", password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  /* ---- an unregistered name is not counted and is not forwarded ---- */
  const unknown = await get("/api/gongde/downloads/niuma-merit-macos-9.9.9.dmg");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "download_not_found");
  assert.equal(cos.objects.size, 0, "an unregistered request must not be counted");

  /* ---- a registered name is counted once and forwards to the registry URL ---- */
  const first = await get(`/api/gongde/downloads/${MAC}`);
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("location"), `https://download.gongde.zqscreen.cn/${MAC}`);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("x-gongde-count"), null, "a successful count adds no failure header");
  const eventKeys = [...cos.objects.keys()].filter((key) => key.startsWith(EVENTS));
  assert.equal(eventKeys.length, 1);

  /* ---- a counting failure still delivers the file, and says so ---- */
  cos.failPut = true;
  const degraded = await get(`/api/gongde/downloads/${WIN}`);
  assert.equal(degraded.status, 302, "a broken counter must not block the download");
  assert.equal(degraded.headers.get("location"), `https://download.gongde.zqscreen.cn/${WIN}`);
  assert.equal(degraded.headers.get("x-gongde-count"), "failed");
  cos.failPut = false;

  /* ---- the redirect target is never taken from the request ---- */
  const traversal = await get("/api/gongde/downloads/..%2F..%2Fetc%2Fpasswd");
  assert.equal(traversal.status, 404);

  /* ---- the published list is the shipped registry file, entry for entry ---- */
  // The site renders `systemRequirements` when an entry carries one, so the
  // public list must be the registry with nothing dropped and nothing added.
  // Checked without the override, the way production reads it.
  delete process.env.GONGDE_FREE_INSTALLERS_FILE;
  try {
    const body = await (await get("/api/gongde/v2/installers")).json();
    const shipped = JSON.parse(await readFile(
      new URL("../src/free-distribution/installers.json", import.meta.url), "utf8"));
    assert.deepEqual(body.data.items, shipped.items,
      "the public installer list must equal the registry file, optional note included");
    const annotated = shipped.items.filter((item) => "systemRequirements" in item);
    const plain = shipped.items.filter((item) => !("systemRequirements" in item));
    // The comparison only proves both directions while the file has both kinds.
    assert.ok(annotated.length > 0 && plain.length > 0,
      "the shipped registry must keep entries with and without a note");
    assert.ok(annotated.every((item) => typeof item.systemRequirements === "string"),
      "notes must be strings in the shipped registry");
  } finally {
    process.env.GONGDE_FREE_INSTALLERS_FILE = registryFile;
  }

  /* ---- seed events on both sides of the counting start and of a day boundary ---- */
  cos.objects.clear();
  const seed = (name, iso) => cos.objects.set(
    `${EVENTS}${Date.parse(iso)}-${Math.random().toString(16).slice(2, 14)}-${name}`,
    Buffer.from("{}")
  );
  seed(MAC, "2026-10-19T12:00:00.000Z"); // before the counting start: legacy
  seed(MAC, "2026-10-21T23:30:00.000Z"); // inside the selected Beijing day
  seed(WIN, "2026-10-22T01:00:00.000Z"); // inside
  seed(OLD, "2026-10-21T10:00:00.000Z"); // registered, but not the current version
  seed("niuma-merit-macos-0.7.0-retired.dmg", "2026-10-21T11:00:00.000Z"); // no longer registered

  const unauthorized = await get("/api/gongde/admin/download-report");
  assert.equal(unauthorized.status, 401);

  // Beijing 2026-10-22 is 2026-10-21T16:00Z .. 2026-10-22T16:00Z.
  const report = await get(
    "/api/gongde/admin/download-report?from=2026-10-21T16:00:00.000Z&to=2026-10-22T16:00:00.000Z",
    { cookie }
  );
  assert.equal(report.status, 200);
  assert.equal(report.headers.get("cache-control"), "private, no-store");
  const body = await report.json();
  assert.equal(body.status, "available");
  assert.equal(body.coverage.status, "configured");
  assert.equal(body.coverage.startedAt, countedSince);
  assert.equal(body.registry.status, "available");
  // The console labels the numbers with this window rather than the browser
  // clock, so the echoed range is part of the contract.
  assert.deepEqual(body.range, { from: "2026-10-21T16:00:00.000Z", to: "2026-10-22T16:00:00.000Z" });
  assert.deepEqual(body.registry.items.map((item) => item.name).sort(), [MAC, OLD, WIN].sort());
  // The counted URL is a path, not the CDN address: the page shows the entry
  // the site actually uses.
  assert.equal(body.registry.items.find((item) => item.name === MAC).countedUrl, `/api/gongde/downloads/${encodeURIComponent(MAC)}`);

  const summary = body.summary;
  assert.equal(summary.legacyCount, 1, "the pre-start event is kept apart, not added to the total");
  assert.equal(summary.total, 4, "counted events: MAC, WIN, OLD and the retired name");
  // In-range means the selected Beijing day only: the two events after 16:00Z.
  assert.equal(summary.period, 2, "the older same-day events are counted but outside the selected day");
  assert.equal(summary.unattributed, 1, "the retired name is counted but not attributable to a platform");
  // Platform comes from the file extension, so a retired .dmg still lands in the
  // macOS row while also being counted as unattributed. The two numbers answer
  // different questions and are deliberately not exclusive.
  assert.deepEqual(summary.byPlatform.macos, { total: 3, period: 1 });
  assert.deepEqual(summary.byPlatform.windows, { total: 1, period: 1 });
  assert.equal(summary.earliest, "2026-10-21T10:00:00.000Z");

  /* ---- no start configured is a different state, not a zero ---- */
  delete process.env.GONGDE_DOWNLOAD_COUNT_SINCE;
  const unconfigured = await (await get("/api/gongde/admin/download-report", { cookie })).json();
  assert.equal(unconfigured.coverage.status, "unconfigured");
  assert.equal(unconfigured.coverage.startedAt, null);
  // Without a start there is no "legacy" split, so nothing is hidden as legacy.
  assert.equal(unconfigured.summary.legacyCount, 0);
  process.env.GONGDE_DOWNLOAD_COUNT_SINCE = countedSince;

  /* ---- an unreadable registry fails closed instead of counting anything ---- */
  await writeFile(registryFile, "{ not json");
  const brokenRegistry = await get(`/api/gongde/downloads/${MAC}`);
  assert.equal(brokenRegistry.status, 503);
  assert.equal((await brokenRegistry.json()).error, "download_registry_unavailable");
  const brokenReport = await (await get("/api/gongde/admin/download-report", { cookie })).json();
  assert.equal(brokenReport.registry.status, "unavailable");
  assert.equal(brokenReport.status, "available", "the counts still read; only the registry is unknown");

  await registry([entry(MAC, "macos", "0.9.4")]);
  const restored = await get(`/api/gongde/downloads/${MAC}`);
  assert.equal(restored.status, 302);
});
