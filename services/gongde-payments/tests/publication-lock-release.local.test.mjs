import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { mock } from "node:test";

/**
 * The publication lock's cleanup path, against a fault-injected pool.
 *
 * A real MySQL server cannot be asked to fail `RELEASE_LOCK` on demand, so the
 * connection here is a double. What it proves is the branch this service takes:
 * a session whose release is unconfirmed is destroyed instead of returned to
 * the pool. It does NOT prove MySQL behaviour, and the real mutual-exclusion
 * proof lives in `publication-lock-mysql.local.test.mjs`.
 *
 * The pool is mocked before the module under test is imported, because the lock
 * builds its pool at construction time.
 */
const require = createRequire(import.meta.url);

function pooledConnection(behaviour) {
  const calls = { execute: 0, query: 0, release: 0, destroy: 0 };
  const connection = {
    async execute() {
      calls.execute += 1;
      return behaviour.acquire();
    },
    async query() {
      calls.query += 1;
      return behaviour.release();
    },
    release() { calls.release += 1; },
    destroy() { calls.destroy += 1; }
  };
  return { connection, calls };
}

async function loadLock() {
  return (await import("../dist/admin/publication-lock.js?fresh=" + Math.random())).createPublicationLock;
}

const configuration = {
  host: "synthetic", port: 3306, database: "synthetic",
  user: "synthetic", password: "synthetic", connectionLimit: 2
};

test("a release the server refuses destroys the connection instead of pooling it", async () => {
  const { connection, calls } = pooledConnection({
    acquire: () => [[{ acquired: 1 }]],
    release: () => { throw Object.assign(new Error("synthetic nonfatal failure"), { code: "ER_QUERY_INTERRUPTED" }); }
  });
  mock.module(require.resolve("mysql2/promise"), {
    defaultExport: { createPool: () => ({ async getConnection() { return connection; }, async end() {} }) }
  });
  const createPublicationLock = await loadLock();
  const handle = createPublicationLock(configuration);
  assert.equal(handle.mode, "mysql-named-lock");

  assert.equal(await handle.lock(async () => "written"), "written",
    "a completed operation is still reported as completed");
  assert.equal(calls.destroy, 1, "an unconfirmed release must not return the session to the pool");
  assert.equal(calls.release, 0);
  await handle.close();
  mock.restoreAll();
});

test("a release that does not report success also destroys the connection", async () => {
  const { connection, calls } = pooledConnection({
    acquire: () => [[{ acquired: 1 }]],
    // `RELEASE_LOCK` returns NULL when this session does not hold the name.
    release: () => [[{ released: null }]]
  });
  mock.module(require.resolve("mysql2/promise"), {
    defaultExport: { createPool: () => ({ async getConnection() { return connection; }, async end() {} }) }
  });
  const createPublicationLock = await loadLock();
  const handle = createPublicationLock(configuration);

  await handle.lock(async () => 1);
  assert.equal(calls.destroy, 1, "a release that did not confirm must not be assumed to have worked");
  assert.equal(calls.release, 0);
  await handle.close();
  mock.restoreAll();
});

test("a confirmed release returns the connection, and a failed operation keeps its own error", async () => {
  const { connection, calls } = pooledConnection({
    acquire: () => [[{ acquired: 1 }]],
    release: () => [[{ released: 1 }]]
  });
  mock.module(require.resolve("mysql2/promise"), {
    defaultExport: { createPool: () => ({ async getConnection() { return connection; }, async end() {} }) }
  });
  const createPublicationLock = await loadLock();
  const handle = createPublicationLock(configuration);

  await assert.rejects(handle.lock(async () => { throw new Error("operation_failed"); }), /operation_failed/);
  assert.equal(calls.release, 1);
  assert.equal(calls.destroy, 0);
  await handle.close();
  mock.restoreAll();
});

test("a session that never acquired the lock is neither released nor destroyed", async () => {
  const { connection, calls } = pooledConnection({
    acquire: () => [[{ acquired: 0 }]],
    release: () => [[{ released: 1 }]]
  });
  mock.module(require.resolve("mysql2/promise"), {
    defaultExport: { createPool: () => ({ async getConnection() { return connection; }, async end() {} }) }
  });
  const createPublicationLock = await loadLock();
  const handle = createPublicationLock(configuration);

  await assert.rejects(handle.lock(async () => "never"), /publication_busy/);
  assert.equal(calls.query, 0, "there was nothing to release");
  assert.equal(calls.release, 1, "an untouched session is safe to reuse");
  assert.equal(calls.destroy, 0);
  await handle.close();
  mock.restoreAll();
});

test("an unreadable acquisition result destroys the session", async () => {
  const { connection, calls } = pooledConnection({
    acquire: () => { throw new Error("lost_reply"); },
    release: () => [[{ released: 1 }]]
  });
  mock.module(require.resolve("mysql2/promise"), {
    defaultExport: { createPool: () => ({ async getConnection() { return connection; }, async end() {} }) }
  });
  const createPublicationLock = await loadLock();
  const handle = createPublicationLock(configuration);

  await assert.rejects(handle.lock(async () => "never"), /lost_reply/);
  assert.equal(calls.destroy, 1, "the server may have granted the lock before the reply was lost");
  assert.equal(calls.release, 0);
  await handle.close();
  mock.restoreAll();
});
