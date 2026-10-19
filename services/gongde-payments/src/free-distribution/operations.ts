import { createHash } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

type Executor = Pick<Pool, "execute">;
const DAY = 86400000;
const QUEUE_LIMIT = 25;
const rows = async (db: Executor, sql: string, values: unknown[] = []) =>
  (await db.execute<RowDataPacket[]>(sql, values as never))[0];
const iso = (value: unknown) => new Date(value as string | number | Date).toISOString();
const age = (value: unknown, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso(value))) / 1000));
function count(value: unknown): number {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) throw new Error("operations_count_unavailable");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("operations_count_unavailable");
  return result;
}
function code(value: unknown): string | null {
  return typeof value === "string" && /^(?:claim|creator)_[a-z_]{1,55}$/.test(value) ? value : null;
}

export function reviewBudgetWindow(now: Date) {
  const bucket = Math.floor((now.getTime() + 8 * 3600000) / DAY);
  return {
    bucketDigest: createHash("sha256").update(`auto-review-provider\0project\0${bucket}`).digest("hex"),
    startsAt: new Date(bucket * DAY - 8 * 3600000).toISOString(),
    resetsAt: new Date((bucket + 1) * DAY - 8 * 3600000).toISOString()
  };
}

// No worker startup, AI request, limits consumption, new events or DB writes.
// Sections fail independently; an unavailable section must never look empty.
export async function readOperationsOverview(db: Executor, settings: {
  reviewMode: "automatic" | "disabled" | "unavailable";
  dailyLimit: number | null;
  now?: Date;
}) {
  const now = settings.now ?? new Date();
  const preparingBefore = new Date(now.getTime() - 5 * 60000);
  const reviewBefore = new Date(now.getTime() - DAY);
  const readClaims = async () => {
    try {
      const totals = (await rows(db, `SELECT
        COALESCE(SUM(state = 'FAILED'), 0) AS failed,
        COALESCE(SUM(state = 'BLOCKED'), 0) AS blocked,
        COALESCE(SUM(state = 'PREPARING' AND COALESCE(generation_started_at, created_at) <= ?), 0) AS preparing_long
        FROM gongde_free_claims WHERE state IN ('FAILED', 'BLOCKED', 'PREPARING') AND created_at <= ?`, [preparingBefore, now]))[0];
      const selected = await rows(db, `SELECT c.id, c.state, c.stage, c.error_code, c.retryable, c.created_at,
        COALESCE(c.generation_started_at, c.created_at) AS preparation_started_at,
        f.kind AS source_kind, f.creator_id, n.serial AS creator_serial,
        (SELECT GROUP_CONCAT(i.appearance_number ORDER BY i.position SEPARATOR ',')
         FROM gongde_free_claim_items i WHERE i.claim_id = c.id) AS work_numbers
        FROM gongde_free_claims c LEFT JOIN gongde_free_code_families f ON f.id = c.family_id
        LEFT JOIN gongde_free_creator_numbers n ON n.creator_id = f.creator_id
        WHERE c.created_at <= ? AND (c.state IN ('FAILED', 'BLOCKED') OR
          (c.state = 'PREPARING' AND COALESCE(c.generation_started_at, c.created_at) <= ?))
        ORDER BY c.created_at ASC, c.id ASC LIMIT ${QUEUE_LIMIT + 1}`, [now, preparingBefore]);
      return { status: "available" as const, failed: count(totals.failed), blocked: count(totals.blocked),
        preparingTooLong: count(totals.preparing_long), hasMore: selected.length > QUEUE_LIMIT,
        items: selected.slice(0, QUEUE_LIMIT).map(row => ({
          claimId: String(row.id), state: String(row.state), stage: String(row.stage), error: code(row.error_code),
          retryable: row.retryable === true || row.retryable === 1,
          sourceKind: row.source_kind === "GROUP" || row.source_kind === "CREATOR" ? row.source_kind : null,
          authorPublicNumber: row.creator_serial == null ? null : `C${row.creator_serial}`,
          creatorId: row.creator_id == null ? null : String(row.creator_id),
          workNumbers: typeof row.work_numbers === "string" ? row.work_numbers.split(",").filter(value => /^[1-9][0-9]{5,8}$/.test(value)) : [],
          createdAt: iso(row.created_at), waitingSeconds: age(row.preparation_started_at, now)
        })) };
    } catch {
      return { status: "unavailable" as const, failed: null, blocked: null, preparingTooLong: null, hasMore: null, items: [] };
    }
  };
  const autoState = "JSON_UNQUOTE(JSON_EXTRACT(r.checks_json, '$.autoReview.state'))";
  const evidenceCode = "JSON_UNQUOTE(JSON_EXTRACT(r.checks_json, '$.autoReview.evidence.code'))";
  const readReviews = async () => {
    try {
      const totals = (await rows(db, `SELECT COUNT(*) AS pending,
        COALESCE(SUM(r.submitted_at <= ?), 0) AS waiting_long,
        COALESCE(SUM(${autoState} = 'needs_review'), 0) AS needs_review,
        COALESCE(SUM(${evidenceCode} = 'creator_rate_limited'), 0) AS budget_held
        FROM gongde_creator_reviews r WHERE r.state = 'PENDING' AND r.submitted_at <= ?`, [reviewBefore, now]))[0];
      const selected = await rows(db, `SELECT r.review_id, r.version_id, v.work_id, w.creator_id,
        n.appearance_serial, p.serial AS creator_serial, r.submitted_at,
        JSON_UNQUOTE(JSON_EXTRACT(r.metadata_snapshot_json, '$.titleZh')) AS submitted_title,
        ${autoState} AS auto_state, ${evidenceCode} AS evidence_code,
        JSON_EXTRACT(r.checks_json, '$.autoReview.attempts') AS attempts
        FROM gongde_creator_reviews r JOIN gongde_creator_work_versions v ON v.version_id = r.version_id
        JOIN gongde_creator_works w ON w.work_id = v.work_id
        LEFT JOIN gongde_appearance_numbers n ON n.source_kind = 'community' AND n.internal_id = w.work_id
        LEFT JOIN gongde_free_creator_numbers p ON p.creator_id = w.creator_id
        WHERE r.state = 'PENDING' AND r.submitted_at <= ? AND
          (r.submitted_at <= ? OR ${autoState} IN ('needs_review', 'retry_wait'))
        ORDER BY r.submitted_at ASC, r.review_id ASC LIMIT ${QUEUE_LIMIT + 1}`, [now, reviewBefore]);
      return { status: "available" as const, pending: count(totals.pending), waitingTooLong: count(totals.waiting_long),
        needsReview: count(totals.needs_review), budgetHeld: count(totals.budget_held), hasMore: selected.length > QUEUE_LIMIT,
        items: selected.slice(0, QUEUE_LIMIT).map(row => ({
          reviewId: String(row.review_id), versionId: String(row.version_id), workId: String(row.work_id),
          number: row.appearance_serial == null ? null : String(row.appearance_serial),
          creatorId: String(row.creator_id), authorPublicNumber: row.creator_serial == null ? null : `C${row.creator_serial}`,
          title: typeof row.submitted_title === "string" ? row.submitted_title.slice(0, 80) : null,
          submittedAt: iso(row.submitted_at), waitingSeconds: age(row.submitted_at, now),
          autoState: ["queued", "running", "retry_wait", "needs_review"].includes(row.auto_state) ? String(row.auto_state) : null,
          attempts: row.attempts == null ? null : count(row.attempts), reasonCode: code(row.evidence_code)
        })) };
    } catch {
      return { status: "unavailable" as const, pending: null, waitingTooLong: null, needsReview: null,
        budgetHeld: null, hasMore: null, items: [] };
    }
  };
  const readBudget = async () => {
    const window = reviewBudgetWindow(now);
    const dailyLimit = Number.isSafeInteger(settings.dailyLimit) && settings.dailyLimit! >= 1 && settings.dailyLimit! <= 1000 ? settings.dailyLimit : null;
    const base = { mode: settings.reviewMode, dailyLimit, startsAt: window.startsAt, resetsAt: window.resetsAt };
    try {
      const result = await rows(db, "SELECT hits FROM gongde_creator_rate_limits WHERE bucket_digest = ?", [window.bucketDigest]);
      const used = result.length ? count(result[0].hits) : 0;
      return { ...base, status: "available" as const, used,
        remaining: dailyLimit === null ? null : Math.max(0, dailyLimit - used) };
    } catch { return { ...base, status: "unavailable" as const, used: null, remaining: null }; }
  };
  return { asOf: now.toISOString(), thresholds: { claimPreparingMinutes: 5, reviewWaitingHours: 24 },
    claims: await readClaims(), reviews: await readReviews(), budget: await readBudget() };
}

export interface InstallerRegistration {
  platform: "windows" | "macos"; format: string; releaseId: string; version: string;
  bytes: number; sha256: string; publicDownloadUrl: string; perpetualCompatible: boolean;
}
export function installerRetentionSnapshot(registered: readonly InstallerRegistration[], now = new Date()) {
  return { asOf: now.toISOString(), registryStatus: registered.length ? "available" : "unavailable",
    minimumCompatibleVersion: "0.9.0", rollbackRegistryStatus: "unrecorded", retentionPolicyStatus: "unrecorded",
    deletionAllowed: false,
    items: registered.map(item => ({ ...item, references: ["distribution-registry",
      ...(item.version === "0.9.0" && item.perpetualCompatible ? ["minimum-compatibility"] : [])],
      rollbackReference: null, retainUntil: null, deletionAllowed: false })) };
}

export function isProtectedInstallerDeletion(url: URL, method?: string): boolean {
  return method === "DELETE" && url.pathname === "/api/gongde/admin/files" && url.searchParams.get("kind") === "installer";
}
