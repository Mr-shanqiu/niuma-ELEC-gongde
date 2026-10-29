import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { AdminDownloadSummary } from "../admin/object-store.js";

const DAY = 86400000;
const OFFSET = 8 * 3600000;
const RECENT_DAYS = 90;
const DAILY_DAYS = 730;
const dayKey = (date: Date) => new Date(date.getTime() + OFFSET).toISOString().slice(0, 10);
const dayStart = (date: Date) => Date.parse(`${dayKey(date)}T00:00:00+08:00`);
const safeCount = (value: unknown) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("download_count_out_of_range");
  return number;
};
export interface LegacyDownloadEvent { key: string; fileName: string; platform: string | null; downloadedAt: Date }

/** Uses the existing application pool. No visitor identity or input content is stored. */
export class MySqlDownloadCounters {
  #checkedAt = -Infinity;
  constructor(private readonly pool: Pool, private readonly coverageSince: Date, private readonly now = () => new Date()) {
    if (!Number.isFinite(coverageSince.getTime())) throw new Error("download_coverage_required");
  }

  async ready(): Promise<void> {
    if (this.now().getTime() - this.#checkedAt < 60000) return;
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT phase, coverage_since FROM gongde_download_counter_state WHERE id=1");
    if (rows.length !== 1 || rows[0].phase !== "ready" || new Date(rows[0].coverage_since).getTime() !== this.coverageSince.getTime()) {
      throw new Error("download_counters_not_initialized");
    }
    this.#checkedAt = this.now().getTime();
  }

  async initializeImport(): Promise<void> {
    await this.pool.execute("INSERT IGNORE INTO gongde_download_counter_state (id,phase,coverage_since,initialized_at) VALUES (1,'importing',?,?)", [this.coverageSince, this.now()]);
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT coverage_since FROM gongde_download_counter_state WHERE id=1");
    if (new Date(rows[0].coverage_since).getTime() !== this.coverageSince.getTime()) throw new Error("download_coverage_changed");
  }

  async finishImport(): Promise<void> {
    await this.pool.execute("UPDATE gongde_download_counter_state SET phase='ready' WHERE id=1 AND coverage_since=?", [this.coverageSince]);
    this.#checkedAt = -Infinity;
    await this.ready();
  }

  async #insert(connection: PoolConnection, id: string, fileName: string, platform: string | null, at: Date): Promise<void> {
    if (typeof fileName !== "string" || !fileName.length || [...fileName].length > 255 || /[\x00-\x1f\x7f/\\]/u.test(fileName) || !Number.isFinite(at.getTime())) throw new Error("download_event_invalid");
    if (platform !== null && platform !== "macos" && platform !== "windows") throw new Error("download_platform_invalid");
    const legacy = at < this.coverageSince ? 1 : 0;
    await connection.execute(
      "INSERT INTO gongde_download_totals (file_name,is_legacy,platform,request_count,first_at) VALUES (?,?,?,1,?) ON DUPLICATE KEY UPDATE request_count=request_count+1,first_at=LEAST(first_at,VALUES(first_at))",
      [fileName, legacy, platform, at]);
    if (!legacy) await connection.execute(
      "INSERT INTO gongde_download_daily (day_key,file_name,request_count) VALUES (?,?,1) ON DUPLICATE KEY UPDATE request_count=request_count+1", [dayKey(at), fileName]);
    if (at.getTime() >= dayStart(new Date(this.now().getTime() - RECENT_DAYS * DAY))) {
      await connection.execute("INSERT INTO gongde_download_recent (event_id,occurred_at,file_name,is_legacy) VALUES (?,?,?,?)", [id, at, fileName, legacy]);
    }
  }

  async recordDownload(fileName: string, platform: string, at: Date): Promise<void> {
    await this.ready();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const id = createHash("sha256").update(`runtime:${randomBytes(24).toString("hex")}`).digest("hex");
      await this.#insert(connection, id, fileName, platform, at);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  /** Permanent deduplication applies only to the finite legacy COS snapshot. */
  async importLegacy(events: readonly LegacyDownloadEvent[]): Promise<number> {
    let imported = 0;
    for (const event of events) {
      const id = createHash("sha256").update(`cos:${event.key}`).digest("hex");
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute<ResultSetHeader>("INSERT IGNORE INTO gongde_download_imported_events (event_id,occurred_at) VALUES (?,?)", [id, event.downloadedAt]);
        if (result.affectedRows === 1) { await this.#insert(connection, id, event.fileName, event.platform, event.downloadedAt); imported++; }
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    }
    return imported;
  }

  async summarizeDownloads(from: Date, to: Date, options: { countedSince?: Date | null; registeredNames?: readonly string[] } = {}): Promise<AdminDownloadSummary> {
    await this.ready();
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to || (options.countedSince && options.countedSince.getTime() !== this.coverageSince.getTime())) throw new Error("download_range_invalid");
    const recentStart = dayStart(new Date(this.now().getTime() - RECENT_DAYS * DAY));
    const dailyStart = dayStart(new Date(this.now().getTime() - DAILY_DAYS * DAY));
    if (from.getTime() < dailyStart) throw new Error("download_range_not_retained");
    const useDaily = from.getTime() < recentStart;
    if (useDaily && (from.getTime() !== dayStart(from) || to.getTime() !== dayStart(to))) throw new Error("download_historical_range_requires_whole_days");
    const [totals] = await this.pool.execute<RowDataPacket[]>("SELECT file_name,is_legacy,platform,request_count,first_at FROM gongde_download_totals");
    const [periods] = await this.pool.execute<RowDataPacket[]>(useDaily
      ? "SELECT file_name,SUM(request_count) AS request_count FROM gongde_download_daily WHERE day_key>=? AND day_key<? GROUP BY file_name"
      : "SELECT file_name,COUNT(*) AS request_count FROM gongde_download_recent WHERE occurred_at>=? AND occurred_at<? AND is_legacy=0 GROUP BY file_name", useDaily ? [dayKey(from), dayKey(to)] : [from, to]);
    const byPeriod = new Map(periods.map(row => [String(row.file_name), safeCount(row.request_count)]));
    const counted = totals.filter(row => Number(row.is_legacy) === 0);
    const registered = options.registeredNames ? new Set(options.registeredNames) : null;
    const sum = (rows: RowDataPacket[]) => safeCount(rows.reduce((value, row) => value + safeCount(row.request_count), 0));
    const platform = (name: string) => { const rows = counted.filter(row => row.platform === name); return { total: sum(rows), period: safeCount(rows.reduce((value, row) => value + (byPeriod.get(String(row.file_name)) ?? 0), 0)) }; };
    return {
      total: sum(counted), period: safeCount([...byPeriod.values()].reduce((a, b) => a + b, 0)),
      byFile: counted.map(row => ({ fileName: String(row.file_name), total: safeCount(row.request_count), period: byPeriod.get(String(row.file_name)) ?? 0 })).sort((a, b) => a.fileName.localeCompare(b.fileName)),
      byPlatform: { macos: platform("macos"), windows: platform("windows") },
      earliest: counted.reduce<string | null>((first, row) => { const at = new Date(row.first_at).toISOString(); return first === null || at < first ? at : first; }, null),
      legacyCount: sum(totals.filter(row => Number(row.is_legacy) === 1)),
      unattributed: registered ? sum(counted.filter(row => !registered.has(String(row.file_name)))) : 0
    };
  }

  /** File administration historically includes events from before coverage began. */
  async cumulativeFileTotals(): Promise<Array<{fileName: string; total: number}>> {
    await this.ready();
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT file_name,SUM(request_count) AS request_count FROM gongde_download_totals GROUP BY file_name");
    return rows.map(row => ({fileName: String(row.file_name), total: safeCount(row.request_count)}));
  }

  /** Bounded batches; never delete COS history or the cumulative totals/import receipts. */
  async prune(): Promise<{ recent: number; daily: number }> {
    await this.ready();
    const [recent] = await this.pool.execute<ResultSetHeader>("DELETE FROM gongde_download_recent WHERE occurred_at<? LIMIT 20000", [new Date(dayStart(new Date(this.now().getTime() - RECENT_DAYS * DAY)))]);
    const [daily] = await this.pool.execute<ResultSetHeader>("DELETE FROM gongde_download_daily WHERE day_key<? LIMIT 1000", [dayKey(new Date(this.now().getTime() - DAILY_DAYS * DAY))]);
    return { recent: recent.affectedRows, daily: daily.affectedRows };
  }
}
