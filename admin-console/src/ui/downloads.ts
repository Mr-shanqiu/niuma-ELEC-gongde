import type { ReadState } from "./api";

export type PlatformCounts = { total: number; period: number };
export type DownloadSummary = {
  total: number;
  period: number;
  byFile: Array<{ fileName: string; total: number; period: number }>;
  byPlatform: { macos: PlatformCounts; windows: PlatformCounts };
  earliest: string | null;
  legacyCount: number;
  unattributed: number;
};
export type DownloadReport = {
  status: "available" | "error" | "unavailable";
  coverage: { status: "configured" | "unconfigured"; startedAt: string | null; entries: string[]; scopeNote: string };
  registry: { status: "available" | "unavailable"; items: Array<{ name: string; platform: string; version: string; releaseId: string; bytes: number; sha256: string; countedUrl: string }> };
  range: { from: string; to: string };
  summary: DownloadSummary | null;
};

/**
 * What a download report actually says, in the four cases that must not merge.
 *
 *   http-failure  the request failed             → 未读取   (retry; never 0)
 *   read-failure  200, but the store read failed → 未读取   (the server said so)
 *   unconfigured  counting exists, no start time → 未接入 + history listed apart
 *   ready         counting is configured         → numbers, including a real 0
 *
 * "unconfigured" is a configuration fact the server reports. A failed read is
 * not that fact, so the two get different sentences and different retry paths.
 */
export type DownloadCell =
  | { note: "loading" }
  | { note: "unread"; reason: "http" | "read"; message?: string; unauthorized?: boolean }
  /** `store` = counting storage is not enabled; `coverage` = storage works, start time unset. */
  | { note: "unconfigured"; reason: "store" | "coverage"; report: DownloadReport }
  | { note: "ready"; report: DownloadReport; summary: DownloadSummary };

export function classifyDownloads(state: ReadState<DownloadReport>): DownloadCell {
  if (state.status === "loading") return { note: "loading" };
  if (state.status === "error") {
    return { note: "unread", reason: "http", message: state.message, unauthorized: state.unauthorized };
  }
  const report = state.data;
  // `status: "error"` is an HTTP 200 whose summary could not be read — a failed
  // read, not a missing configuration.
  if (report.status === "error" || (report.status === "available" && !report.summary)) {
    return { note: "unread", reason: "read" };
  }
  if (report.status === "unavailable") return { note: "unconfigured", reason: "store", report };
  if (!report.summary) return { note: "unconfigured", reason: "store", report };
  const configured = report.coverage.status === "configured" && Boolean(report.coverage.startedAt);
  // A total that starts nowhere is not a cumulative total. Without a start the
  // server's numbers are all previously recorded events, so they are shown as
  // history and kept out of the cumulative column.
  return configured
    ? { note: "ready", report, summary: report.summary }
    : { note: "unconfigured", reason: "coverage", report };
}

/**
 * The events recorded before the counting start.
 *
 * With no start, every event the server has is a history event: nothing can be
 * called a cumulative total, so the number is presented as history instead.
 */
export function historicalRequests(cell: DownloadCell): number | null {
  if (cell.note === "unconfigured") return cell.report.summary?.total ?? null;
  return cell.note === "ready" && cell.summary.legacyCount > 0 ? cell.summary.legacyCount : null;
}
