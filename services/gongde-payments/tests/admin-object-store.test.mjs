import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AdminObjectStore, loadAdminObjectStoreConfiguration, parseAdminFileIdentity } from "../dist/admin/object-store.js";

class MemoryCos {
  objects = new Map();

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
    const object = this.objects.get(params.Key);
    if (!object) return callback(new Error("NoSuchKey"), {});
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
  await assert.rejects(() => store.publishInstallerManifest("0.8.2"), /NoSuchKey/u);
  assert.equal(cos.objects.has("DOWNLOADS.json"), false);
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

test("an unreadable published manifest is not replaced by a two-entry list", async () => {
  const { cos, store } = fixture();
  cos.objects.set("DOWNLOADS.json", { body: Buffer.from("not json"), contentType: "application/json", lastModified: new Date().toISOString() });
  await store.put("installer", "niuma-merit-macos-0.9.4.dmg", Buffer.from("mac"), "application/x-apple-diskimage");
  await store.put("installer", "niuma-merit-windows-0.9.4-setup.exe", Buffer.from("win"), "application/vnd.microsoft.portable-executable");
  await store.publishInstallerManifest("0.9.4");
  const manifest = JSON.parse(cos.objects.get("DOWNLOADS.json").body.toString());
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].signature, "unknown");
});
