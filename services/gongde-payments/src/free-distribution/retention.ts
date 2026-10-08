import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

export const FREE_RETENTION_BATCH_LIMIT = 20;
export const FREE_RETENTION_TIMEOUT_MS = 30_000;
export const FREE_RETENTION_DELETED_ACTION = "free.retention.deleted";
const KEY = /^free-claims\/v2\/[a-f0-9]{64}\.(nmgpack|nmgpacks)$/;
const LOCK = "CONCAT('gongde-free-retention:v2:', MD5(DATABASE()))";
const MAX_REFERENCES = 50;
let runningInProcess = false;
// A bounded keyset cursor avoids repeatedly selecting the oldest protected 20.
// It is scheduling state only: a restart resets it; deletion truth stays in 008.
const cursors = new WeakMap<Pool, { issuedAt: string; claimId: string }>();

export interface FreeRetentionOptions {
  pool: Pool;
  // Only a successful, actually completed deletion (including already absent)
  // may resolve. Reject errors. Keys must be immutable and must never be reused.
  // This callback cannot cancel an already issued SDK request. A timeout is an
  // UNKNOWN outcome, never success; reconcile that outcome before reusing a key.
  deleteFreeArtifact: (objectKey: string) => Promise<void>;
  now?: Date | (() => Date);
  limit?: number;
  timeoutMs?: number;
}
export interface FreeRetentionResult {
  status: "completed" | "busy" | "partial" | "failed" | "timed_out";
  scanned: number;
  deleted: number;
  protected: number;
  alreadyDeleted: number;
  failed: number;
  elapsedMs: number;
  metadataDeleted: 0;
  outcomes: { claimId: string; status: string; reason?: string }[];
  errorCode?: string;
}
class Deadline extends Error { constructor() { super("free_retention_deadline"); } }
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",");
const safeCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "free_retention_operation_failed";
};

/** One bounded pass, scheduled by the caller, not a timer or bucket enumerator.
 * Uses 008's audit table for durable tombstones; NEVER changes or purges claims,
 * artifacts, items, code records, paid records or creator sources. Metadata is
 * retained indefinitely, exceeding the 180-day minimum.
 * Report writers MUST lock the same affected claims FOR UPDATE before inserting
 * or changing forensic state, and inspect deletion tombstones after acquiring
 * that lock. This worker also uses report next-key locks and rechecks all
 * non-RESOLVED reports immediately before delete. No hold schema is invented.
 */
export async function runFreeRetention(options: FreeRetentionOptions): Promise<FreeRetentionResult> {
  const limit = options.limit ?? FREE_RETENTION_BATCH_LIMIT;
  const timeoutMs = options.timeoutMs ?? FREE_RETENTION_TIMEOUT_MS;
  if (!options.pool || typeof options.deleteFreeArtifact !== "function" ||
      !Number.isInteger(limit) || limit < 1 || limit > FREE_RETENTION_BATCH_LIMIT ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > FREE_RETENTION_TIMEOUT_MS) {
    throw new Error("free_retention_options_invalid");
  }
  const suppliedNow = typeof options.now === "function" ? options.now() : options.now;
  if (suppliedNow !== undefined && (!(suppliedNow instanceof Date) || !Number.isFinite(suppliedNow.getTime()))) {
    throw new Error("free_retention_now_invalid");
  }
  const started = performance.now();
  const result: FreeRetentionResult = { status: "completed", scanned: 0, deleted: 0,
    protected: 0, alreadyDeleted: 0, failed: 0, elapsedMs: 0, metadataDeleted: 0, outcomes: [] };
  if (runningInProcess) { result.status = "busy"; return result; }
  runningInProcess = true;
  let connection: PoolConnection | undefined;
  let expired = false, locked = false, inTransaction = false;
  let rejectDeadline!: (reason: Deadline) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    expired = true;
    // Never return a connection with an outstanding query/transaction to a pool.
    connection?.destroy();
    rejectDeadline(new Deadline());
  }, timeoutMs);
  const remaining = () => Math.max(1, Math.ceil(timeoutMs - (performance.now() - started)));
  const within = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline]);
  const query = async (sql: string, values: unknown[] = []): Promise<RowDataPacket[]> => {
    if (expired || performance.now() - started >= timeoutMs) throw new Deadline();
    const [rows] = await within(connection!.query<RowDataPacket[]>({ sql, timeout: remaining() }, values));
    return rows;
  };
  const marked = (audit: RowDataPacket, artifact: RowDataPacket): boolean => {
    if (audit.action !== FREE_RETENTION_DELETED_ACTION) return false;
    const before = typeof audit.before_json === "string" ? JSON.parse(audit.before_json) : audit.before_json;
    return before?.privateObjectKey === artifact.private_object_key && before?.sha256 === artifact.sha256;
  };
  const protect = async (references: RowDataPacket[]): Promise<string | null> => {
    if (references.length > MAX_REFERENCES) return "reference_bound_exceeded";
    if (references.some(row => !Number(row.age_ok) || !["READY", "EXPIRED"].includes(row.state))) return "live_or_unissued_reference";
    const artifact = references[0];
    if (!KEY.test(artifact.private_object_key) || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        references.some(row => row.sha256 !== artifact.sha256 || !["nmgpack", "nmgpacks"].includes(row.format) ||
          !row.private_object_key.endsWith("." + row.format) || row.license_mode !== "perpetual")) return "artifact_identity_invalid";
    const ids = references.map(row => row.id);
    const items = await query(`SELECT * FROM gongde_free_claim_items WHERE claim_id IN (${placeholders(ids)})
      ORDER BY claim_id, position FOR SHARE`, ids);
    if (references.some(row => {
      const count = items.filter(item => item.claim_id === row.id).length;
      return count < 1 || count > 10;
    })) return "claim_items_unresolved";
    if (items.some(item => !["official", "community"].includes(item.source_kind))) return "claim_source_unresolved";
    for (const item of items) {
      const snapshot = typeof item.snapshot_record_json === "string" ? JSON.parse(item.snapshot_record_json) : item.snapshot_record_json;
      if (snapshot?.sourceObjectKey === artifact.private_object_key || snapshot?.previewObjectKey === artifact.private_object_key) {
        return "source_object_alias";
      }
    }
    const identities = [...new Map(items.map(item => [item.asset_id + ":" + item.version_id, item])).values()];
    const active = await query(`SELECT c.id FROM gongde_free_claim_items i JOIN gongde_free_claims c ON c.id=i.claim_id
      WHERE (${identities.map(() => "(i.asset_id=? AND i.version_id=?)").join(" OR ")})
      AND (c.download_expires_at > ? OR c.state='PREPARING') LIMIT 1 FOR SHARE`,
    [...identities.flatMap(item => [item.asset_id, item.version_id]), now]);
    if (active.length) return "unexpired_version_reference";
    const numbers = [...new Set(items.map(item => Number(item.appearance_number)))].sort((a, b) => a - b);
    // Do not filter by report state in SQL: lock existing rows AND insertion gaps
    // for these identities, including state transitions from RESOLVED/DISMISSED.
    const reports = await query(`SELECT id,state FROM gongde_free_reports
      WHERE appearance_number IN (${placeholders(numbers)}) FOR SHARE`, numbers);
    if (reports.some(row => row.state !== "RESOLVED")) return "report_preservation";
    return null;
  };
  let now: string;
  try {
    const acquisition = options.pool.getConnection();
    void acquisition.then(value => { if (expired) value.destroy(); }, () => {});
    connection = await within(acquisition);
    const lock = await query(`SELECT GET_LOCK(${LOCK},0) AS acquired`);
    if (Number(lock[0]?.acquired) !== 1) { result.status = "busy"; return result; }
    locked = true;
    now = suppliedNow ? suppliedNow.toISOString().slice(0, 23).replace("T", " ") :
      (await query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%d %H:%i:%s.%f') AS utc_now"))[0].utc_now;
    const candidateSql = `SELECT a.claim_id,a.private_object_key,a.sha256,
      DATE_FORMAT(c.issued_at,'%Y-%m-%d %H:%i:%s.%f') AS issued_order FROM gongde_free_delivery_artifacts a
      JOIN gongde_free_claims c ON c.id=a.claim_id
      WHERE a.private_object_key LIKE 'free-claims/v2/%' AND c.state IN ('READY','EXPIRED')
      AND c.issued_at <= DATE_SUB(?,INTERVAL 14 DAY) AND a.created_at <= DATE_SUB(?,INTERVAL 14 DAY)
      AND c.download_expires_at <= DATE_SUB(?,INTERVAL 7 DAY)
      AND NOT EXISTS (SELECT 1 FROM gongde_free_audit x WHERE x.subject=c.id AND x.action=?
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.before_json,'$.privateObjectKey'))=BINARY a.private_object_key
        AND JSON_UNQUOTE(JSON_EXTRACT(x.before_json,'$.sha256'))=a.sha256)
      `;
    const cursor = cursors.get(options.pool);
    const values = [now, now, now, FREE_RETENTION_DELETED_ACTION];
    let candidates = await query(candidateSql + (cursor ?
      " AND (c.issued_at > ? OR (c.issued_at = ? AND c.id > ?))" : "") +
      ` ORDER BY c.issued_at,c.id LIMIT ${limit}`,
    cursor ? [...values, cursor.issuedAt, cursor.issuedAt, cursor.claimId] : values);
    if (!candidates.length && cursor) {
      cursors.delete(options.pool);
      candidates = await query(candidateSql + ` ORDER BY c.issued_at,c.id LIMIT ${limit}`, values);
    }
    const visited = new Set<string>();
    for (const candidate of candidates) {
      cursors.set(options.pool, { issuedAt: candidate.issued_order, claimId: candidate.claim_id });
      if (visited.has(candidate.private_object_key)) continue;
      visited.add(candidate.private_object_key); result.scanned++;
      const outcome: FreeRetentionResult["outcomes"][number] = { claimId: candidate.claim_id, status: "pending" };
      result.outcomes.push(outcome);
      try {
        if (!KEY.test(candidate.private_object_key)) {
          result.protected++; outcome.status = "protected"; outcome.reason = "outside_exact_free_artifact_namespace"; continue;
        }
        // Next-key locks are essential for concurrent new references/reports.
        // SET TRANSACTION only affects this transaction, not a caller's pool defaults.
        await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await within(connection.beginTransaction()); inTransaction = true;
        const references = await query(`SELECT c.id,c.state,a.private_object_key,a.sha256,a.format,a.license_mode,
          (c.issued_at IS NOT NULL AND c.download_expires_at IS NOT NULL
           AND c.issued_at <= DATE_SUB(?,INTERVAL 14 DAY) AND a.created_at <= DATE_SUB(?,INTERVAL 14 DAY)
           AND c.download_expires_at <= DATE_SUB(?,INTERVAL 7 DAY)) AS age_ok
          FROM gongde_free_delivery_artifacts a JOIN gongde_free_claims c ON c.id=a.claim_id
          WHERE BINARY a.private_object_key=BINARY ? ORDER BY c.id LIMIT ${MAX_REFERENCES + 1} FOR UPDATE`,
        [now, now, now, candidate.private_object_key]);
        if (!references.length || !references.some(row => row.id === candidate.claim_id && row.sha256 === candidate.sha256)) {
          result.protected++; outcome.status = "protected"; outcome.reason = "claim_binding_changed";
        } else {
          const ids = references.map(row => row.id);
          const audits = await query(`SELECT action,before_json FROM gongde_free_audit
            WHERE subject IN (${placeholders(ids)}) AND action=? FOR SHARE`,
          [...ids, FREE_RETENTION_DELETED_ACTION]);
          const reason = await protect(references);
          if (reason) { result.protected++; outcome.status = "protected"; outcome.reason = reason; }
          else if (audits.some(row => marked(row, references[0]))) {
            result.alreadyDeleted++; outcome.status = "already_deleted";
          } else {
            const forensic = await query(`SELECT r.id,r.state FROM gongde_free_reports r
              JOIN gongde_free_claim_items i ON i.appearance_number=r.appearance_number
              WHERE i.claim_id IN (${placeholders(ids)}) FOR SHARE`, ids);
            if (forensic.some(row => row.state !== "RESOLVED")) {
              result.protected++; outcome.status = "protected"; outcome.reason = "report_preservation_recheck";
              await within(connection.rollback()); inTransaction = false;
              continue;
            }
            // All protection locks remain held while the deletion is outstanding.
            // No listing API, source deletion, upload or URL-fetch callback exists.
            await within(Promise.resolve().then(() => options.deleteFreeArtifact(candidate.private_object_key)));
            for (const reference of references) {
              await query(`INSERT INTO gongde_free_audit
                (id,actor,action,subject,before_json,after_json,reason,request_id,occurred_at)
                VALUES (?,'worker:free-retention',?,?,?,?, 'Expired formal free artifact; metadata retained',NULL,UTC_TIMESTAMP(3))`,
              [randomBytes(16).toString("hex"), FREE_RETENTION_DELETED_ACTION, reference.id,
                JSON.stringify({ privateObjectKey: reference.private_object_key, sha256: reference.sha256 }),
                JSON.stringify({ deleted: true, metadataRetained: true })]);
            }
            await within(connection.commit()); inTransaction = false;
            result.deleted++; outcome.status = "deleted";
          }
        }
        if (inTransaction) { await within(connection.rollback()); inTransaction = false; }
      } catch (error) {
        outcome.status = error instanceof Deadline || expired ? "unknown" : "failed";
        outcome.reason = error instanceof Deadline || expired ? "deadline_outcome_not_confirmed" : safeCode(error);
        result.failed++;
        if (error instanceof Deadline || expired) throw error;
        if (inTransaction) { await within(connection.rollback()); inTransaction = false; }
        // Fail closed on database faults. Ordinary delete failures may be retried
        // in a later scheduled pass; they do not create a successful tombstone.
        if ((error as { code?: string })?.code?.startsWith("ER_") ||
            (error as { code?: string })?.code?.startsWith("PROTOCOL_")) throw error;
      }
    }
    if (result.failed) result.status = "partial";
  } catch (error) {
    result.status = error instanceof Deadline || expired ? "timed_out" : "failed";
    result.errorCode = error instanceof Deadline || expired ? "free_retention_deadline" : safeCode(error);
  } finally {
    if (connection && !expired) {
      try {
        if (inTransaction) await within(connection.rollback());
        if (locked) await query(`SELECT RELEASE_LOCK(${LOCK}) AS released`);
      } catch (error) {
        connection.destroy();
        result.status = error instanceof Deadline || expired ? "timed_out" : "failed";
        result.errorCode = error instanceof Deadline || expired ? "free_retention_deadline" : safeCode(error);
      }
      if (!expired) connection.release();
    }
    clearTimeout(timer);
    runningInProcess = false;
    result.elapsedMs = Math.ceil(performance.now() - started);
  }
  return result;
}
