import mysql from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { GongdeMySqlConfiguration } from "../storage/mysql-store.js";
import { PublicationBusy, type PublicationLock } from "./object-store.js";

/**
 * Serializes read-modify-write of the publication object across instances.
 *
 * The object lives in COS, whose `PUT` accepts no `If-Match`, so the storage
 * itself cannot reject a write built on a stale read. The lock is what makes
 * "read the revision, decide, write" safe: every instance takes the same MySQL
 * named lock, so no second writer can read between our read and our write.
 *
 * `GET_LOCK` is connection-scoped, so acquire, work and release all run on one
 * connection that is never used for anything else while held.
 */
const LOCK_NAME = "gongde:appearance-publication:v1";
const LOCK_TIMEOUT_SECONDS = 5;
// Sent verbatim rather than prepared: a release is one statement with a fixed
// name, and a statement that cannot be lost to a prepare/drain interaction is
// one fewer way to leave the lock held. The alias names the column, because a
// result we cannot read is indistinguishable from a release we cannot confirm.
const RELEASE_SQL = `SELECT RELEASE_LOCK('${LOCK_NAME}') AS released`;

export interface PublicationLockHandle {
  lock: PublicationLock;
  close(): Promise<void>;
  /** How the lock is enforced, for the admin page and the release notes. */
  mode: "mysql-named-lock" | "single-process";
}

export function createPublicationLock(
  configuration: GongdeMySqlConfiguration | null
): PublicationLockHandle {
  if (!configuration) {
    // `GONGDE_STORE_MODE=memory` is documented as local-test-only, and in that
    // mode there is exactly one process. This is NOT a multi-instance lock and
    // must never be reported as one: with a shared COS bucket and two
    // instances, this chain would allow a lost update.
    return { lock: processLock(), close: async () => {}, mode: "single-process" };
  }

  const pool: Pool = mysql.createPool({
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password: configuration.password,
    // Two connections is enough: one to hold the lock, one spare, and the
    // payment pool keeps its own budget.
    connectionLimit: 2,
    waitForConnections: true,
    queueLimit: 8,
    timezone: "Z",
    charset: "utf8mb4",
    multipleStatements: false
  });

  const lock: PublicationLock = async (operation) => {
    const connection = await pool.getConnection();
    // `GET_LOCK` is re-entrant per session and only `RELEASE_LOCK` (or the
    // session ending) drops it. A connection whose lock state is unknown must
    // therefore never go back into the pool: it would keep the name held while
    // looking idle, and the next `GET_LOCK` on it would merely deepen its own
    // count while every other instance waited out the timeout.
    let destroy = false;
    // Only a session that actually acquired the lock has anything to release.
    let acquired = false;
    try {
      let rows: RowDataPacket[];
      try {
        [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT GET_LOCK(?, ?) AS acquired`,
          [LOCK_NAME, LOCK_TIMEOUT_SECONDS]
        );
      } catch (error) {
        // The server may have granted the lock before the reply was lost, so
        // this session might hold it.
        destroy = true;
        throw error;
      }
      // 1 means acquired; 0 is the wait timeout and NULL reports an error. In
      // neither of the latter two does this session hold the lock.
      if (Number(rows[0]?.acquired) !== 1) throw new PublicationBusy();
      acquired = true;
      return await operation();
    } finally {
      // The operation's own result, or its own error, stands. A cleanup failure
      // is recorded only as "do not reuse this connection"; it never turns a
      // completed write into a failure or the other way round.
      if (!destroy && acquired) destroy = !(await releaseLock(connection));
      if (destroy) connection.destroy(); else connection.release();
    }
  };

  return {
    lock,
    mode: "mysql-named-lock",
    close: async () => { await pool.end().catch(() => {}); }
  };
}

/** True only when the server confirmed this session no longer holds the lock. */
async function releaseLock(connection: PoolConnection): Promise<boolean> {
  try {
    const [rows] = await connection.query<RowDataPacket[]>(RELEASE_SQL);
    return Number(rows[0]?.released) === 1;
  } catch {
    return false;
  }
}

/**
 * Single-process serialization, for memory mode only.
 *
 * A failed operation must not wedge the chain, so the tail is reset on failure
 * rather than letting one rejection poison every later caller.
 */
function processLock(): PublicationLock {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  };
}
