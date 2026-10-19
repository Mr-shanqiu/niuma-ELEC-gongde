import type { Pool, RowDataPacket } from "mysql2/promise";

export interface CreatorWorkClaimStats {
  totalClaims: number;
  last7DaysClaims: number;
  previous7DaysClaims: number;
  asOf: string;
}

function count(value: unknown): number {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) throw new Error("claim_count_unavailable");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("claim_count_unavailable");
  return result;
}

// Owner-scoped, read-only projection. A failed/missing aggregate is NOT zero.
// The unique (claim_id, source_kind, asset_id) key counts a work once per batch.
export async function withCreatorClaimStats<T extends { workId: string }>(
  executor: Pick<Pool, "execute">, creatorId: string, works: readonly T[], now = new Date()
): Promise<Array<T & { claimStats: CreatorWorkClaimStats | null }>> {
  if (!works.length) return [];
  try {
    if (works.length > 100 || !Number.isFinite(now.getTime())) throw new Error("claim_stats_input_invalid");
    const asOf = now.toISOString();
    const last7DaysFrom = new Date(now.getTime() - 7 * 86400000);
    const previous7DaysFrom = new Date(now.getTime() - 14 * 86400000);
    const [result] = await executor.execute<RowDataPacket[]>(
      `SELECT w.work_id, COUNT(c.id) AS total_claims,
         COALESCE(SUM(CASE WHEN c.issued_at >= ? THEN 1 ELSE 0 END), 0) AS last_7_days,
         COALESCE(SUM(CASE WHEN c.issued_at >= ? AND c.issued_at < ? THEN 1 ELSE 0 END), 0) AS previous_7_days
       FROM gongde_creator_works w
       LEFT JOIN gongde_free_claim_items i ON i.source_kind = 'community' AND i.asset_id = w.work_id AND i.creator_id = w.creator_id
       LEFT JOIN gongde_free_claims c ON c.id = i.claim_id AND c.issued_at IS NOT NULL AND c.issued_at < ?
       WHERE w.creator_id = ? AND w.work_id IN (${works.map(() => "?").join(",")})
       GROUP BY w.work_id`,
      [last7DaysFrom, previous7DaysFrom, last7DaysFrom, now, creatorId, ...works.map(item => item.workId)]);
    const byWork = new Map(result.map(row => [String(row.work_id), {
      totalClaims: count(row.total_claims), last7DaysClaims: count(row.last_7_days),
      previous7DaysClaims: count(row.previous_7_days), asOf
    }]));
    return works.map(item => ({ ...item, claimStats: byWork.get(item.workId) ?? null }));
  } catch {
    // Keep the existing work list usable if distribution tables/read access are
    // unavailable. No raw SQL, creator identity, codes or private input is logged.
    return works.map(item => ({ ...item, claimStats: null }));
  }
}
