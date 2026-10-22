import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AdminObjectStore, loadAdminObjectStoreConfiguration, parseAdminFileIdentity } from "../dist/admin/object-store.js";

class MemoryCos {
  objects = new Map();
  writes = [];
  failGet = new Set();
  failPut = false;

  getBucket(params, callback) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(params.Prefix)).sort();
    const start = params.Marker ? keys.findIndex((key) => key > params.Marker) : 0;
    const safeStart = start < 0 ? keys.length : start;
    const page = keys.slice(safeStart, safeStart + 2);
    const truncated = safeStart + page.length < keys.length;
    callback(null, {
      Contents: page.map((key) => {
        const item = this.objects.get(key);
        return { Key: key, Size: String(item.body.length), LastModified: item.lastModified };
      }),
      IsTruncated: truncated ? "true" : "false",
      NextMarker: truncated ? page.at(-1) : undefined
    });
  }

  putObject(params, callback) {
    if (this.failPut) return callback(Object.assign(new Error("synthetic_storage_failure"), { statusCode: 500 }));
    this.writes.push(params.Key);
    this.objects.set(params.Key, {
      body: Buffer.from(params.Body),
      contentType: params.ContentType,
      lastModified: new Date().toISOString()
    });
    callback(null, {});
  }

  deleteObject(params, callback) {
    this.objects.delete(params.Key);
    callback(null, {});
  }

  getObject(params, callback) {
    if (this.failGet.has(params.Key)) return callback(new Error("NetworkError"), {});
    const object = this.objects.get(params.Key);
    // The real SDK reports a missing key with a code and a status, not with a
    // bare message. "Absent" must be recognised from those, so the double has
    // to carry them too.
    if (!object) return callback(Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey", statusCode: 404 }), {});
    callback(null, { Body: Buffer.from(object.body) });
  }
}

function fixture() {
  const cos = new MemoryCos();
  const store = new AdminObjectStore({
    bucket: "gongde-download-1460392746",
    region: "ap-shanghai",
    publicBaseUrl: "https://download.gongde.zqscreen.cn",
    secretId: "test-secret-id",
    secretKey: "test-secret-key"
  }, cos);
  return { cos, store };
}

test("admin file identity allows only managed extensions and flat safe names", () => {
  assert.deepEqual(parseAdminFileIdentity("appearance", "lucky-cat.nmgpack"), {
    kind: "appearance",
    name: "lucky-cat.nmgpack"
  });
  assert.deepEqual(parseAdminFileIdentity("installer", "niuma-merit-windows-0.8.0-setup.exe"), {
    kind: "installer",
    name: "niuma-merit-windows-0.8.0-setup.exe"
  });
  assert.throws(() => parseAdminFileIdentity("appearance", "../secret.nmgpack"), /admin_file_name_invalid/u);
  assert.throws(() => parseAdminFileIdentity("appearance", "cat.exe"), /admin_file_name_invalid/u);
  assert.throws(() => parseAdminFileIdentity("installer", "site.zip"), /admin_file_name_invalid/u);
  assert.throws(() => parseAdminFileIdentity("unknown", "file.exe"), /admin_file_kind_invalid/u);
});

test("admin object store prefers dedicated COS credentials without changing shared SMS credentials", () => {
  const configuration = loadAdminObjectStoreConfiguration({
    GONGDE_COS_SECRET_ID: "dedicated-cos-id",
    GONGDE_COS_SECRET_KEY: "dedicated-cos-key",
    TENCENT_CLOUD_SECRET_ID: "shared-sms-id",
    TENCENT_CLOUD_SECRET_KEY: "shared-sms-key"
  });
  assert.equal(configuration?.secretId, "dedicated-cos-id");
  assert.equal(configuration?.secretKey, "dedicated-cos-key");
});

test("admin object store uploads, paginates, lists and deletes only managed files", async () => {
  const { cos, store } = fixture();
  await store.put("appearance", "lucky-cat.nmgpack", Buffer.from("cat"), "application/zip");
  await store.put("appearance", "chick-pecking.nmgpack", Buffer.from("chick"), "application/zip");
  await store.put("appearance", "sea-lion.nmgpack", Buffer.from("sea-lion"), "application/zip");
  cos.objects.set("appearance-packs/private-note.txt", {
    body: Buffer.from("hidden"), contentType: "text/plain", lastModified: new Date().toISOString()
  });

  const files = await store.list("appearance");
  assert.deepEqual(files.map((file) => file.name), ["chick-pecking.nmgpack", "lucky-cat.nmgpack", "sea-lion.nmgpack"]);
  assert.equal(files[0].url, "https://download.gongde.zqscreen.cn/appearance-packs/chick-pecking.nmgpack");
  assert.equal(files[0].size, 5);

  await store.delete("appearance", "lucky-cat.nmgpack");
  assert.equal(cos.objects.has("appearance-packs/lucky-cat.nmgpack"), false);
  assert.equal(cos.objects.has("appearance-packs/private-note.txt"), true);
});

test("download events remain hidden from installer listings and summarize by time and file", async () => {
  const { cos, store } = fixture();
  await store.put("installer", "niuma-merit-macos-0.8.0.dmg", Buffer.from("mac"), "application/x-apple-diskimage");
  await store.put("installer", "niuma-merit-windows-0.8.0-setup.exe", Buffer.from("win"), "application/vnd.microsoft.portable-executable");
  cos.objects.set("DOWNLOADS.json", {
    body: Buffer.from("{}"), contentType: "application/json", lastModified: new Date().toISOString()
  });
  cos.objects.set("appearance-packs/lucky-cat.nmgpack", {
    body: Buffer.from("cat"), contentType: "application/zip", lastModified: new Date().toISOString()
  });

  await store.recordDownload("niuma-merit-macos-0.8.0.dmg", "macos", new Date("2026-09-28T23:59:59.000Z"));
  await store.recordDownload("niuma-merit-macos-0.8.0.dmg", "macos", new Date("2026-09-29T08:00:00.000Z"));
  await store.recordDownload("niuma-merit-windows-0.8.0-setup.exe", "windows", new Date("2026-09-29T09:00:00.000Z"));

  const files = await store.list("installer");
  assert.deepEqual(files.map((file) => file.name), ["niuma-merit-macos-0.8.0.dmg", "niuma-merit-windows-0.8.0-setup.exe"]);
  assert.equal(files[0].url, "https://download.gongde.zqscreen.cn/niuma-merit-macos-0.8.0.dmg");

  const summary = await store.summarizeDownloads(
    new Date("2026-09-29T00:00:00.000Z"),
    new Date("2026-09-30T00:00:00.000Z")
  );
  assert.equal(summary.total, 3);
  assert.equal(summary.period, 2);
  assert.deepEqual(summary.byFile, [
    { fileName: "niuma-merit-macos-0.8.0.dmg", total: 2, period: 1 },
    { fileName: "niuma-merit-windows-0.8.0-setup.exe", total: 1, period: 1 }
  ]);
});

test("release manifest is calculated from two existing installers, never supplied hashes", async () => {
  const { cos, store } = fixture();
  const macName = "niuma-merit-macos-0.8.2.dmg";
  const winName = "niuma-merit-windows-0.8.2-setup.exe";
  const mac = Buffer.from("mac-installer");
  const win = Buffer.from("windows-installer");
  await store.put("installer", macName, mac, "application/x-apple-diskimage");
  // Publishing now requires a readable published list; an explicitly empty one
  // is valid, so the missing Windows installer is what rejects here.
  cos.objects.set("DOWNLOADS.json", { body: Buffer.from(JSON.stringify({ files: [] })),
    contentType: "application/json", lastModified: new Date().toISOString() });
  await assert.rejects(() => store.publishInstallerManifest("0.8.2"), /NoSuchKey/u);
  assert.equal(cos.objects.has("SHA256SUMS.txt"), false);
  await store.put("installer", winName, win, "application/vnd.microsoft.portable-executable");
  await assert.rejects(() => store.publishInstallerManifest("../0.8.2"), /admin_release_version_invalid/u);
  const summary = await store.publishInstallerManifest("0.8.2");
  const macSha = createHash("sha256").update(mac).digest("hex");
  const winSha = createHash("sha256").update(win).digest("hex");
  assert.deepEqual(summary.files, [
    { name: macName, bytes: mac.length, sha256: macSha },
    { name: winName, bytes: win.length, sha256: winSha }
  ]);
  const manifest = JSON.parse(cos.objects.get("DOWNLOADS.json").body.toString());
  assert.deepEqual(manifest.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })), summary.files);
  assert.equal(cos.objects.get("SHA256SUMS.txt").body.toString(),
    `${macSha}  ${macName}\n${winSha}  ${winName}\n`);
  assert.equal(cos.objects.get("DOWNLOADS.json").contentType, "application/json; charset=utf-8");
});

test("publishing a release keeps the other published entries and their trust state", async () => {
  const { cos, store } = fixture();
  // A published list like the live one: current signed builds, an older build
  // of the same version, and a previous release kept for fallback.
  const notarized = "niuma-merit-macos-0.9.4-90414-notarized-68b0aeee.dmg";
  const adhoc = "niuma-merit-macos-0.9.4-90412-1ed7c4ed8bd8.dmg";
  const old = "niuma-merit-macos-0.9.3.dmg";
  const published = {
    baseUrl: "https://download.gongde.zqscreen.cn/",
    generatedAt: "2026-10-20T18:56:35.761Z",
    files: [
      { name: notarized, bytes: 1, sha256: "a".repeat(64), platform: "macOS", signature: "Developer ID Application", notarization: "notarized", version: "0.9.4" },
      { name: adhoc, bytes: 1, sha256: "b".repeat(64), platform: "macOS", signature: "ad-hoc", notarization: "not-notarized", version: "0.9.4" },
      { name: old, bytes: 1, sha256: "c".repeat(64), platform: "macOS", signature: "apple-development", notarization: "not-notarized", version: "0.9.3" }
    ]
  };
  cos.objects.set("DOWNLOADS.json", { body: Buffer.from(JSON.stringify(published)), contentType: "application/json", lastModified: new Date().toISOString() });

  const macName = "niuma-merit-macos-0.9.4.dmg";
  const winName = "niuma-merit-windows-0.9.4-setup.exe";
  await store.put("installer", macName, Buffer.from("mac"), "application/x-apple-diskimage");
  await store.put("installer", winName, Buffer.from("win"), "application/vnd.microsoft.portable-executable");
  await store.publishInstallerManifest("0.9.4");

  const manifest = JSON.parse(cos.objects.get("DOWNLOADS.json").body.toString());
  const names = manifest.files.map((file) => file.name);
  // Nothing that was published disappears.
  for (const name of [notarized, adhoc, old, macName, winName]) assert.ok(names.includes(name), `${name} must survive`);
  assert.equal(manifest.files.length, 5);

  // A file with no recorded state is not described as unsigned.
  const macEntry = manifest.files.find((file) => file.name === macName);
  assert.equal(macEntry.signature, "unknown");
  assert.equal(macEntry.notarization, "unknown");

  // Untouched entries keep the state that was recorded for them.
  const untouched = manifest.files.find((file) => file.name === notarized);
  assert.equal(untouched.signature, "Developer ID Application");
  assert.equal(untouched.notarization, "notarized");

  // The checksum file describes the same set, not just the two regenerated files.
  const sums = cos.objects.get("SHA256SUMS.txt").body.toString().trim().split("\n");
  assert.equal(sums.length, 5);
});

test("a re-published file keeps the trust state already recorded for it", async () => {
  const { cos, store } = fixture();
  const macName = "niuma-merit-macos-0.9.4.dmg";
  cos.objects.set("DOWNLOADS.json", {
    body: Buffer.from(JSON.stringify({ files: [
      { name: macName, bytes: 3, sha256: "a".repeat(64), signature: "Developer ID Application", notarization: "notarized", version: "0.9.4" }
    ] })),
    contentType: "application/json",
    lastModified: new Date().toISOString()
  });
  await store.put("installer", macName, Buffer.from("mac"), "application/x-apple-diskimage");
  await store.put("installer", "niuma-merit-windows-0.9.4-setup.exe", Buffer.from("win"), "application/vnd.microsoft.portable-executable");
  await store.publishInstallerManifest("0.9.4");

  const manifest = JSON.parse(cos.objects.get("DOWNLOADS.json").body.toString());
  const macEntry = manifest.files.find((file) => file.name === macName);
  // The bytes changed, so the recorded state is about the old file; the new
  // one must not inherit "notarized" from it.
  assert.equal(macEntry.signature, "unknown");
  assert.equal(macEntry.notarization, "unknown");
});

// A published list that cannot be read in full is not an empty list. Every one
// of these states must stop before writing, because continuing would replace the
// published history with the two files being regenerated.
test("an unreadable published manifest aborts without writing anything", async () => {
  const published = JSON.stringify({
    baseUrl: "https://download.gongde.zqscreen.cn/",
    generatedAt: "2026-10-20T18:56:35.761Z",
    files: [
      { name: "niuma-merit-macos-0.9.4-90414-notarized-68b0aeee.dmg", bytes: 1, sha256: "a".repeat(64), version: "0.9.4" },
      { name: "niuma-merit-macos-0.9.3.dmg", bytes: 1, sha256: "c".repeat(64), version: "0.9.3" }
    ]
  });
  const macName = "niuma-merit-macos-0.9.4.dmg";
  const winName = "niuma-merit-windows-0.9.4-setup.exe";
  // Each case starts from a published two-entry list and breaks it one way.
  const cases = [
    ["transient network failure", { failGet: "DOWNLOADS.json" }, /admin_manifest_unavailable/u],
    ["the manifest object is missing", { remove: true }, /admin_manifest_unavailable/u],
    ["corrupt JSON", { body: "not json" }, /admin_manifest_invalid/u],
    ["top level is an array", { body: "[]" }, /admin_manifest_invalid/u],
    ["files is not an array", { body: JSON.stringify({ files: {} }) }, /admin_manifest_invalid/u],
    ["an entry is null", { body: JSON.stringify({ files: [null] }) }, /admin_manifest_invalid/u],
    ["an entry has no usable sha256", { body: JSON.stringify({ files: [{ name: "x.dmg", sha256: "short" }] }) },
      /admin_manifest_invalid/u],
    ["an entry has no name", { body: JSON.stringify({ files: [{ sha256: "a".repeat(64) }] }) }, /admin_manifest_invalid/u],
    ["two entries share a name", { body: JSON.stringify({ files: [
      { name: "x.dmg", sha256: "a".repeat(64) }, { name: "x.dmg", sha256: "b".repeat(64) }] }) },
      /admin_manifest_invalid/u]
  ];
  for (const [label, change, expected] of cases) {
    const { cos, store } = fixture();
    if (change.remove !== true) {
      cos.objects.set("DOWNLOADS.json", { body: Buffer.from(change.body ?? published),
        contentType: "application/json", lastModified: new Date().toISOString() });
    }
    if (change.failGet) cos.failGet.add(change.failGet);
    const before = cos.objects.get("DOWNLOADS.json")?.body.toString();
    await store.put("installer", macName, Buffer.from("mac"), "application/x-apple-diskimage");
    await store.put("installer", winName, Buffer.from("win"), "application/vnd.microsoft.portable-executable");
    cos.writes = [];
    await assert.rejects(() => store.publishInstallerManifest("0.9.4"), expected, label);
    assert.deepEqual(cos.writes, [], `${label}: nothing may be written`);
    assert.equal(cos.objects.get("DOWNLOADS.json")?.body.toString(), before, `${label}: manifest must be unchanged`);
    assert.equal(cos.objects.has("SHA256SUMS.txt"), false, `${label}: no checksum may be written`);
  }
});

// An explicitly empty published list is a real state, not a read failure: it
// means "nothing to carry over", and publishing the pair is correct.
test("an explicitly empty published list still publishes the pair", async () => {
  const { cos, store } = fixture();
  cos.objects.set("DOWNLOADS.json", { body: Buffer.from(JSON.stringify({ files: [] })),
    contentType: "application/json", lastModified: new Date().toISOString() });
  await store.put("installer", "niuma-merit-macos-0.9.4.dmg", Buffer.from("mac"), "application/x-apple-diskimage");
  await store.put("installer", "niuma-merit-windows-0.9.4-setup.exe", Buffer.from("win"),
    "application/vnd.microsoft.portable-executable");
  await store.publishInstallerManifest("0.9.4");
  const manifest = JSON.parse(cos.objects.get("DOWNLOADS.json").body.toString());
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].signature, "unknown");
});

/* ------------------------------------------------- publication state object */

const STATE = "appearance-packs/catalog-state.json";
const IDS = ["official.a", "official.b", "official.c"];
const directLock = (operation) => operation();

test("publication state: absent means null, corruption throws, and they are different", async () => {
  const { cos, store } = fixture();
  assert.equal(await store.readPublication(), null, "no object is not an error");

  for (const payload of ["{broken", "[]", "null", '{"publishedAssetIds":[42]}',
    '{"publishedAssetIds":[],"revision":-1}', '{"publishedAssetIds":[],"revision":1.5}',
    '{"publishedAssetIds":[],"firstPublishedAt":{"official.a":"today"}}']) {
    cos.objects.set(STATE, { body: Buffer.from(payload), contentType: "application/json", lastModified: new Date().toISOString() });
    await assert.rejects(store.readPublication(), (error) => error.message === "publication_unavailable",
      `${payload} must not read as a usable state`);
  }
  cos.objects.delete(STATE);
});

test("publication state: a failed read is not treated as a first write", async () => {
  const { cos, store } = fixture();
  cos.getObject = (_params, callback) => callback(Object.assign(new Error("NetworkError"), { statusCode: 500 }));
  await assert.rejects(store.readPublication(), /publication_unavailable/);
  // The lenient reader keeps its documented fallback; the writer's reader must not.
  assert.equal(await store.readPublicationFor(IDS), null);
});

test("publication write: the expected revision is required and is advanced by one", async () => {
  const { store } = fixture();
  // No object yet: the effective state is the documented fallback, where the
  // whole default list counts as published. The first write must not silently
  // un-publish the other two as a side effect of touching one.
  await store.setPublished(IDS, "official.a", true, 0, directLock);
  const afterFirst = await store.readPublication();
  assert.equal(afterFirst.revision, 1);
  assert.deepEqual(afterFirst.publishedAssetIds, IDS);

  const removed = await store.setPublished(IDS, "official.a", false, 1, directLock);
  assert.deepEqual(removed.publishedAssetIds, ["official.b", "official.c"]);

  await assert.rejects(store.setPublished(IDS, "official.b", true, 1, directLock),
    (error) => error.message === "publication_revision_conflict" && error.revision === 2,
    "a stale revision must conflict and report the current one");
  assert.equal((await store.readPublication()).revision, 2, "a conflicting write must change nothing");
});

test("publication write: a failed put is unavailable, never success", async () => {
  const { cos, store } = fixture();
  await store.setPublished(IDS, "official.a", true, 0, directLock);
  cos.failPut = true;
  await assert.rejects(store.setPublished(IDS, "official.b", true, 1, directLock), /publication_unavailable/);
  cos.failPut = false;
  const state = await store.readPublication();
  assert.equal(state.revision, 1, "the version must not move when the write failed");
  assert.deepEqual(state.publishedAssetIds, IDS, "the state is exactly what the last successful write left");
});

test("publication write: unpublishing removes only that id and keeps the rest", async () => {
  const { store } = fixture();
  // Start from an explicit empty set, so the assertion is about removal and not
  // about the fallback that treats the default list as published.
  await store.setPublished([], "", false, 0, directLock);
  await store.setPublished(IDS, "official.a", true, 1, directLock);
  await store.setPublished(IDS, "official.b", true, 2, directLock);
  const removed = await store.setPublished(IDS, "official.a", false, 3, directLock);
  assert.deepEqual(removed.publishedAssetIds, ["official.b"]);
  assert.deepEqual(Object.keys(removed.firstPublishedAt), ["official.a", "official.b"],
    "firstPublishedAt records history; un-publishing must not erase it");
});

test("publication write: a legacy object with no revision upgrades from 0", async () => {
  const { cos, store } = fixture();
  cos.objects.set(STATE, { body: Buffer.from(JSON.stringify({
    version: 1, publishedAssetIds: ["official.a"], updatedAt: "2026-10-01T00:00:00.000Z"
  })), contentType: "application/json", lastModified: new Date().toISOString() });
  const state = await store.readPublication();
  assert.equal(state.revision, 0);
  assert.deepEqual(state.firstPublishedAt, {}, "a legacy object carries no per-asset timestamp");
  const next = await store.setPublished(IDS, "official.b", true, 0, directLock);
  assert.equal(next.revision, 1);
  assert.equal(next.firstPublishedAt["official.b"] !== undefined, true);
});

test("admin list read: only a genuinely absent object gets the first-write default", async () => {
  const { cos, store } = fixture();
  // Absent: the documented first-write default, and there is nothing else to go on.
  assert.deepEqual(await store.publicationStateForAdmin(IDS), {
    revision: 0, publishedAssetIds: IDS, firstPublishedAt: {}, updatedAt: null
  });

  // A storage failure is not absence. The lenient reader used by the historic
  // purchase path still falls back, and that behaviour is deliberately kept;
  // the admin list must not, because it hands the page a version to write with.
  cos.getObject = (_params, callback) => callback(Object.assign(new Error("NetworkError"), { statusCode: 503 }));
  await assert.rejects(store.publicationStateForAdmin(IDS), /publication_unavailable/);
  assert.deepEqual((await store.publicationState(IDS)).publishedAssetIds, IDS,
    "the historic fallback is unchanged");

  // A corrupt body is not absence either.
  cos.getObject = (params, callback) => callback(null, { Body: Buffer.from('{"publishedAssetIds":"all"}') });
  await assert.rejects(store.publicationStateForAdmin(IDS), /publication_unavailable/);

  // A present object is reported as itself, filtered to the known ids.
  cos.getObject = (params, callback) => callback(null, { Body: Buffer.from(JSON.stringify({
    version: 1, revision: 4, publishedAssetIds: ["official.b", "official.zzz"],
    firstPublishedAt: { "official.b": "2026-10-02T00:00:00.000Z" }, updatedAt: "2026-10-03T00:00:00.000Z"
  })) });
  const read = await store.publicationStateForAdmin(IDS);
  assert.equal(read.revision, 4);
  assert.deepEqual(read.publishedAssetIds, ["official.b"]);
});

test("legacy history survives a write to a different appearance", async () => {
  const { cos, store } = fixture();
  const LEGACY = ["official.a", "official.wealth-button"];
  const oldDate = "2026-10-16T00:00:00.000Z";
  const seedLegacy = () => cos.objects.set(STATE, { body: Buffer.from(JSON.stringify({
    version: 1, publishedAssetIds: LEGACY, updatedAt: oldDate
  })), contentType: "application/json", lastModified: new Date().toISOString() });

  // The object predates `firstPublishedAt`. Its one recorded publication was
  // wealth-button, and the read paths reconstruct that from `updatedAt`.
  seedLegacy();
  assert.equal((await store.publicationStateStrict(LEGACY)).firstPublishedAt["official.wealth-button"], oldDate);

  // Un-publishing the *other* appearance must not move it: the inferred history
  // is carried into the write, not re-derived from the new `updatedAt`.
  await store.setPublished(LEGACY, "official.a", false, 0, directLock);
  assert.equal((await store.publicationStateStrict(LEGACY)).firstPublishedAt["official.wealth-button"], oldDate,
    "unpublishing another appearance moved the recorded first publication");

  // Same for publishing the other one, which also adds a new timestamp.
  seedLegacy();
  await store.setPublished(LEGACY, "official.a", true, 0, directLock);
  const published = await store.publicationStateStrict(LEGACY);
  assert.equal(published.firstPublishedAt["official.wealth-button"], oldDate,
    "publishing another appearance moved the recorded first publication");
  assert.deepEqual(Object.keys(published.firstPublishedAt).sort(), ["official.a", "official.wealth-button"],
    "the appearance just published gets its own time; nothing is invented for others");
  assert.notEqual(published.firstPublishedAt["official.a"], oldDate,
    "a newly published appearance must not inherit the legacy date");

  // An object that explicitly carries an empty map has already answered the
  // question, so `updatedAt` must not be promoted into a first publication.
  cos.objects.set(STATE, { body: Buffer.from(JSON.stringify({
    version: 1, revision: 3, publishedAssetIds: LEGACY, firstPublishedAt: {}, updatedAt: oldDate
  })), contentType: "application/json", lastModified: new Date().toISOString() });
  assert.deepEqual((await store.publicationStateStrict(LEGACY)).firstPublishedAt, {},
    "an explicit empty map is not the same as a missing one");
});
