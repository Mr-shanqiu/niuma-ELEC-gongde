import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Publication writes against the real server.
 *
 * COS is an in-memory client here, so what this proves is the server's
 * behaviour: revision fencing, the error a stale write gets, and that a failed
 * write is never reported as success. What it does NOT prove is that a real
 * COS bucket serializes two writers — the lock is the thing that does that,
 * and a real multi-instance race needs a real shared bucket to reproduce.
 */
for (const key of Object.keys(process.env)) if (key.startsWith("GONGDE_")) delete process.env[key];

class MemoryCos {
  objects = new Map();
  writes = [];
  failPut = false;
  /** Makes the publication object unreadable, as a network or permission error would. */
  failRead = false;
  /** Runs before each put resolves, to interleave a competing writer. */
  beforePut = null;

  getBucket(params, callback) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(params.Prefix)).sort();
    callback(null, {
      Contents: keys.map((key) => ({ Key: key, Size: String(this.objects.get(key).length), LastModified: new Date().toISOString() })),
      IsTruncated: "false"
    });
  }

  putObject(params, callback) {
    const write = () => {
      if (this.failPut && params.Key.endsWith("catalog-state.json")) {
        return callback(Object.assign(new Error("synthetic_storage_failure"), { statusCode: 500 }));
      }
      this.writes.push(params.Key);
      this.objects.set(params.Key, Buffer.from(params.Body));
      callback(null, {});
    };
    const hook = this.beforePut;
    if (hook && params.Key.endsWith("catalog-state.json")) {
      this.beforePut = null;
      hook().then(write, () => write());
      return;
    }
    write();
  }

  deleteObject(params, callback) {
    this.objects.delete(params.Key);
    callback(null, {});
  }

  getObject(params, callback) {
    if (this.failRead) return callback(Object.assign(new Error("synthetic_read_failure"), { statusCode: 503 }));
    const body = this.objects.get(params.Key);
    if (!body) return callback(Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey", statusCode: 404 }));
    callback(null, { Body: body });
  }
}

const cos = new MemoryCos();
mock.module("cos-nodejs-sdk-v5", {
  defaultExport: class { constructor() { return cos; } }
});

const acceptanceRoot = fileURLToPath(new URL("../../../.local-work/acceptance/", import.meta.url));
const root = await mkdtemp(join(acceptanceRoot, "publication-write-"));
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyFile = join(root, "pack-key.pem");
const passwordFile = join(root, "admin-password.txt");
const sessionFile = join(root, "admin-session.txt");
const password = "synthetic-local-admin-password";
await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
await writeFile(passwordFile, password, { mode: 0o600 });
await writeFile(sessionFile, "synthetic-local-session-secret-at-least-32-bytes", { mode: 0o600 });

Object.assign(process.env, {
  HOST: "127.0.0.1", PORT: "0",
  GONGDE_PAYMENT_MODE: "mock", GONGDE_PAYMENT_TEST_TOKEN: "local-publication-test-token-0123456789",
  // Memory mode: the publication lock is single-process here by design. The
  // convergence behaviour below is the lock interface, not the MySQL one.
  GONGDE_STORE_MODE: "memory",
  GONGDE_PACK_DELIVERY_MODE: "local",
  GONGDE_PACK_ASSET_ROOT: fileURLToPath(new URL("../../../assets/appearance-packs/", import.meta.url)),
  GONGDE_PACK_SIGNING_KEY_FILE: keyFile,
  GONGDE_ADMIN_USERNAME: "test-admin",
  GONGDE_ADMIN_PASSWORD_FILE: passwordFile,
  GONGDE_ADMIN_SESSION_SECRET_FILE: sessionFile,
  GONGDE_COS_SECRET_ID: "synthetic-id", GONGDE_COS_SECRET_KEY: "synthetic-key"
});

const { server } = await import("../dist/server.js");
if (!server.listening) await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

const STATE_KEY = "appearance-packs/catalog-state.json";

test("publication writes are fenced by the publication revision", { timeout: 20000 }, async (t) => {
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
  const call = (path, init = {}) => fetch(origin + path, {
    ...init, headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) }
  });
  const list = async () => (await (await call("/api/gongde/admin/appearances")).json());

  // Seed a real publication object: with none, the historic behaviour is "all
  // official appearances are published", which leaves no unpublished row to
  // exercise. This is the shape the previous release wrote.
  const seed = (ids, revision) => cos.objects.set(STATE_KEY, Buffer.from(JSON.stringify({
    version: 1, revision, publishedAssetIds: ids, firstPublishedAt: {}, updatedAt: new Date().toISOString()
  })));

  /* ---- an unreadable publication object is a failure, not "all published at 0" ---- */
  // Before any seed there is genuinely no object, and the documented first-write
  // default applies. Then make the read fail: the same list must stop answering
  // 200, because a page that showed "published, revision 0" here would enable a
  // write whose only possible outcome is a 503.
  const noObject = await list();
  assert.equal(noObject.publicationRevision, 0);
  assert.ok(noObject.data.every((item) => item.state !== "UNPUBLISHED"),
    "with no object the documented default is that everything is published");
  cos.failRead = true;
  const unreadable = await call("/api/gongde/admin/appearances");
  assert.equal(unreadable.status, 503);
  assert.equal((await unreadable.json()).error, "appearance_publication_unavailable");
  cos.failRead = false;
  assert.equal((await list()).publicationRevision, 0, "a failed read must not have changed anything");

  const initial = await list();
  const withMaterial = initial.data.filter((item) => item.revision);
  assert.ok(withMaterial.length >= 2, "fixture needs two appearances that have material");
  seed([withMaterial[0].assetId, ...withMaterial.slice(3, 5).map((item) => item.assetId)], 7);

  const before = await list();
  assert.equal(Array.isArray(before.data), true);
  assert.equal(before.publicationRevision, 7, "the list must carry the version to echo back");
  const startRevision = before.publicationRevision;
  const published = before.data.find((item) => item.state === "PUBLISHED" && item.revision);
  const unpublished = before.data.find((item) => item.state === "UNPUBLISHED" && item.revision);
  const missing = before.data.find((item) => item.state === "MISSING");
  assert.ok(published && unpublished, "fixture needs one published and one unpublished appearance with material");

  /* ---- an unversioned write is refused, not applied ---- */
  const unversioned = await call(`/api/gongde/admin/appearances/${encodeURIComponent(unpublished.assetId)}`, {
    method: "PATCH", body: JSON.stringify({ published: true })
  });
  assert.equal(unversioned.status, 400);
  assert.equal((await unversioned.json()).error, "appearance_publication_revision_required");
  assert.equal((await list()).publicationRevision, startRevision, "a refused write must not move the version");

  /* ---- a write with the current revision succeeds and moves it by one ---- */
  const first = await call(`/api/gongde/admin/appearances/${encodeURIComponent(unpublished.assetId)}`, {
    method: "PATCH", body: JSON.stringify({ published: true, publicationRevision: startRevision })
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.data.state, "PUBLISHED");
  assert.equal(firstBody.publicationRevision, startRevision + 1);
  assert.equal((await list()).publicationRevision, startRevision + 1);

  /* ---- the same revision again is a conflict, and says which is current ---- */
  const stale = await call(`/api/gongde/admin/appearances/${encodeURIComponent(unpublished.assetId)}`, {
    method: "PATCH", body: JSON.stringify({ published: false, publicationRevision: startRevision })
  });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.error, "appearance_publication_conflict");
  assert.equal(staleBody.publicationRevision, startRevision + 1);
  const afterStale = await list();
  assert.equal(afterStale.data.find((item) => item.assetId === unpublished.assetId).state, "PUBLISHED",
    "a rejected stale write must not have changed anything");

  /* ---- a MISSING appearance cannot be published at all ---- */
  if (missing) {
    const refused = await call(`/api/gongde/admin/appearances/${encodeURIComponent(missing.assetId)}`, {
      method: "PATCH", body: JSON.stringify({ published: true, publicationRevision: afterStale.publicationRevision })
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, "appearance_resource_missing");
  }

  /* ---- a failed storage write is not success, and leaves the version alone ---- */
  const current = (await list()).publicationRevision;
  cos.failPut = true;
  const failed = await call(`/api/gongde/admin/appearances/${encodeURIComponent(published.assetId)}`, {
    method: "PATCH", body: JSON.stringify({ published: false, publicationRevision: current })
  });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, "appearance_publication_unavailable");
  cos.failPut = false;
  assert.equal((await list()).publicationRevision, current, "a failed write must not appear to have happened");
  assert.equal((await list()).data.find((item) => item.assetId === published.assetId).state, "PUBLISHED");

  /* ---- two edits of DIFFERENT appearances from the same version: one wins ---- */
  const at = await list();
  const rev = at.publicationRevision;
  const currentlyPublished = at.data.find((item) => item.state === "PUBLISHED" && item.revision);
  const currentlyUnpublished = at.data.find((item) => item.state === "UNPUBLISHED" && item.revision);
  assert.ok(currentlyPublished && currentlyUnpublished, "concurrency case needs one row of each state");
  // Widen the read-to-write window so an unserialized pair would genuinely
  // overlap. Without this, two requests can happen to run one after the other
  // even when nothing protects them, and the test would pass for the wrong
  // reason.
  cos.beforePut = () => new Promise((resolve) => setTimeout(resolve, 40));
  const [left, right] = await Promise.all([
    call(`/api/gongde/admin/appearances/${encodeURIComponent(currentlyPublished.assetId)}`, {
      method: "PATCH", body: JSON.stringify({ published: false, publicationRevision: rev })
    }),
    call(`/api/gongde/admin/appearances/${encodeURIComponent(currentlyUnpublished.assetId)}`, {
      method: "PATCH", body: JSON.stringify({ published: true, publicationRevision: rev })
    })
  ]);
  cos.beforePut = null;
  assert.deepEqual([left.status, right.status].sort(), [200, 409],
    "editing different appearances still touches one object, so one must conflict");
  const settled = await list();
  assert.equal(settled.publicationRevision, rev + 1, "only one write may have been applied");
  const stateOf = (assetId) => settled.data.find((item) => item.assetId === assetId).state;
  if (left.status === 200) {
    assert.equal(stateOf(currentlyPublished.assetId), "UNPUBLISHED");
    assert.equal(stateOf(currentlyUnpublished.assetId), "UNPUBLISHED", "the losing write must not have been applied");
  } else {
    assert.equal(stateOf(currentlyUnpublished.assetId), "PUBLISHED");
    assert.equal(stateOf(currentlyPublished.assetId), "PUBLISHED", "the losing write must not have been applied");
  }
});
