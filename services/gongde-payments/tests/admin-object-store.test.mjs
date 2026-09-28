import assert from "node:assert/strict";
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
  const { store } = fixture();
  await store.put("installer", "niuma-merit-macos-0.8.0.dmg", Buffer.from("mac"), "application/x-apple-diskimage");
  await store.put("installer", "niuma-merit-windows-0.8.0-setup.exe", Buffer.from("win"), "application/vnd.microsoft.portable-executable");

  await store.recordDownload("niuma-merit-macos-0.8.0.dmg", "macos", new Date("2026-09-28T23:59:59.000Z"));
  await store.recordDownload("niuma-merit-macos-0.8.0.dmg", "macos", new Date("2026-09-29T08:00:00.000Z"));
  await store.recordDownload("niuma-merit-windows-0.8.0-setup.exe", "windows", new Date("2026-09-29T09:00:00.000Z"));

  const files = await store.list("installer");
  assert.deepEqual(files.map((file) => file.name), ["niuma-merit-macos-0.8.0.dmg", "niuma-merit-windows-0.8.0-setup.exe"]);

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
