import assert from "node:assert/strict";
import test from "node:test";
import { createPublicationLock } from "../dist/admin/publication-lock.js";

/**
 * The publication lock against a real MySQL server.
 *
 * Two lock handles stand in for two service instances: they hold separate
 * connections to the same database, so this exercises the same `GET_LOCK`
 * contract two processes would use. It proves mutual exclusion between lock
 * holders. It does NOT prove anything about COS, and the in-memory object store
 * from the HTTP test is not a real bucket.
 *
 * Run: GONGDE_PUBLICATION_MYSQL_PASSWORD=<temporary local password> \
 *        node --test tests/publication-lock-mysql.local.test.mjs
 */
const password = process.env.GONGDE_PUBLICATION_MYSQL_PASSWORD;
if (!password) throw new Error("temporary_local_mysql_password_required");
const configuration = {
  host: "127.0.0.1", port: 34891, database: "gongde_pub_acceptance",
  user: "root", password, connectionLimit: 2
};

test("two instances never run inside the lock at the same time", { timeout: 20000 }, async (t) => {
  const first = createPublicationLock(configuration);
  const second = createPublicationLock(configuration);
  t.after(async () => { await first.close(); await second.close(); });

  assert.equal(first.mode, "mysql-named-lock", "memory mode must never be reported as this lock");

  // Which handle gets the lock first is not defined — a lock is mutual
  // exclusion, not a queue. What must hold is that the two critical sections
  // never overlap, so that is what this measures.
  let inside = 0;
  let overlaps = 0;
  let entries = 0;
  const work = async () => {
    inside += 1;
    entries += 1;
    if (inside > 1) overlaps += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    inside -= 1;
  };
  await Promise.all([first.lock(work), second.lock(work), first.lock(work), second.lock(work)]);
  assert.equal(entries, 4, "every queued operation must eventually run");
  assert.equal(overlaps, 0, "two operations observed the lock as free at the same time");
});

test("a lock is released when its operation throws, proven by a different instance", { timeout: 20000 }, async (t) => {
  const failed = createPublicationLock(configuration);
  const witness = createPublicationLock(configuration);
  t.after(async () => { await failed.close(); await witness.close(); });

  await assert.rejects(failed.lock(async () => { throw new Error("writer_failed"); }), /writer_failed/);

  // The witness is a separate pool, so it cannot re-enter the failed handle's
  // session. `GET_LOCK` is re-entrant *per session*: asking the same handle
  // again could succeed by deepening its own count while the name was still
  // held, which would prove nothing about the failure path.
  const started = Date.now();
  const value = await witness.lock(async () => "after_failure");
  assert.equal(value, "after_failure");
  assert.ok(Date.now() - started < 2000, "the lock was still held after a failed operation");
});

test("a busy lock is reported as busy, not as a successful write", { timeout: 20000 }, async (t) => {
  const holder = createPublicationLock(configuration);
  const contender = createPublicationLock(configuration);
  t.after(async () => { await holder.close(); await contender.close(); });

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered = false;
  const holding = holder.lock(async () => {
    try {
      // The contender must wait for the same name. It gives up on its own
      // timeout while the holder is still working, so this is a real "busy".
      await assert.rejects(contender.lock(async () => { entered = true; }), /publication_busy/);
    } finally { release(); }
  });
  release = release; // the holder's operation releases only after the assertion
  await holding;
  assert.equal(entered, false, "a busy lock must not let the operation run");
  assert.ok(held);
});
