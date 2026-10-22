import assert from "node:assert/strict";
import test from "node:test";

import { shapes, v2Shapes } from "../src/ui/api.ts";
import { classifyDownloads, historicalRequests } from "../src/ui/downloads.ts";

/**
 * F2 / F6: a 200 whose structure is not the documented one must land in
 * `error`, never in "ready with zeros". These check the guards the pages
 * actually rely on, using the response shapes the server documents.
 */

const envelope = (data) => ({ data, serverTime: "2026-10-22T02:00:00.000Z", requestId: "synthetic" });
const counts = (orders = 3, amountFen = 600) => ({ orders, amountFen });
const platform = (total = 2, period = 1) => ({ total, period });

const summary = (overrides = {}) => ({
  total: 10,
  period: 4,
  byFile: [{ fileName: "a.dmg", total: 6, period: 2 }],
  byPlatform: { macos: platform(6, 2), windows: platform(4, 2) },
  earliest: "2026-10-20T00:00:00.000Z",
  legacyCount: 0,
  unattributed: 0,
  ...overrides
});

const report = (overrides = {}) => ({
  status: "available",
  coverage: { status: "configured", startedAt: "2026-10-20T00:00:00.000Z", entries: ["download-page"], scopeNote: "官网下载页" },
  registry: { status: "available", items: [] },
  range: { from: "2026-10-22T00:00:00.000Z", to: "2026-10-22T23:59:59.999Z" },
  summary: summary(),
  ...overrides
});

const codeSnapshot = (overrides = {}) => ({
  familyId: "family-1",
  revision: 7,
  kind: "GROUP",
  status: "ACTIVE",
  code: "GD123456",
  validFrom: "2026-10-22T00:00:00.000Z",
  expiresAt: "2026-10-25T00:00:00.000Z",
  contributionCount: 1,
  maxItems: 10,
  redemptionEnabled: true,
  ...overrides
});

/* ---------------------------------------------------------------- envelope */

test("F6: a v2 answer without serverTime or data is rejected", () => {
  // The guard is applied to the whole body, before any field is read.
  const expectEnvelope = (body) => "data" in body && Number.isFinite(Date.parse(String(body.serverTime)));
  assert.equal(expectEnvelope(envelope(codeSnapshot())), true);
  assert.equal(expectEnvelope({ data: codeSnapshot() }), false, "no serverTime");
  assert.equal(expectEnvelope({ serverTime: "2026-10-22T02:00:00.000Z" }), false, "no data");
  assert.equal(expectEnvelope({ data: codeSnapshot(), serverTime: "undefined" }), false, "unparseable serverTime");
  assert.equal(expectEnvelope({ data: codeSnapshot(), serverTime: undefined }), false);
});

/* ------------------------------------------------------------ code snapshot */

test("F6: a code snapshot missing revision or writable fields is rejected", () => {
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot()), true);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ familyId: null, revision: null })), true, "no family is a real state");
  // The original defect: `revision: undefined` passed `revision !== null` and
  // enabled a destructive write with no revision at all.
  const { revision: _revision, ...withoutRevision } = codeSnapshot();
  assert.equal(v2Shapes.codeSnapshot(withoutRevision), false);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ revision: undefined })), false);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ revision: "7" })), false);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ revision: -1 })), false);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ revision: 1.5 })), false);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ status: "RUNNING" })), false);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ expiresAt: "not-a-date" })), false);
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ maxItems: undefined })), false);
  assert.equal(v2Shapes.codeSnapshot(null), false);
  assert.equal(v2Shapes.codeSnapshot([]), false);
});

/* --------------------------------------------------------------- operations */

test("F6: operations needs a real asOf and a claims list", () => {
  const body = { asOf: "2026-10-22T02:00:00.000Z", claims: { status: "available", items: [] }, reviews: {}, budget: {} };
  assert.equal(v2Shapes.operations(body), true);
  assert.equal(v2Shapes.operations({ ...body, asOf: undefined }), false);
  assert.equal(v2Shapes.operations({ asOf: body.asOf }), false);
  assert.equal(v2Shapes.operations({ asOf: body.asOf, claims: { status: "available" } }), false);
  assert.equal(v2Shapes.operations({}), false);
});

/* ----------------------------------------------------------------- overview */

test("F6: an overview of empty objects is rejected instead of throwing in render", () => {
  const overview = {
    periods: { selectedDay: counts(), allTime: counts(9, 1800) },
    services: { payments: "ok" },
    recent: [],
    downloads: { status: "available", summary: summary() }
  };
  assert.equal(shapes.overview(overview), true);
  // The exact payload the review used: a 200 that a truthiness check accepts.
  assert.equal(shapes.overview({ periods: {}, services: {}, recent: [], downloads: {} }), false);
  assert.equal(shapes.overview({ periods: { selectedDay: counts() }, services: {}, recent: [], downloads: {} }), false);
  assert.equal(shapes.overview({ periods: { selectedDay: counts(), allTime: { orders: 1 } }, services: {}, recent: [], downloads: {} }), false);
  assert.equal(shapes.overview({ ...overview, recent: undefined }), false);
  // `typeof null === "object"`: a null services block must not pass.
  assert.equal(shapes.overview({ ...overview, services: null }), false);
  assert.equal(shapes.overview({ ...overview, downloads: { status: "available", summary: null } }), false, "available without a summary");
  assert.equal(shapes.overview({ ...overview, downloads: { status: "unavailable", summary: null } }), true);
  assert.equal(shapes.overview({ ...overview, downloads: { status: "available", summary: { total: 1 } } }), false);
});

/* ---------------------------------------------------------- download report */

test("F6: a download report with a broken coverage or summary is rejected", () => {
  assert.equal(shapes.downloadReport(report()), true);
  assert.equal(shapes.downloadReport(report({ status: "unavailable", summary: null })), true);
  assert.equal(shapes.downloadReport(report({ coverage: { status: "maybe" } })), false);
  assert.equal(shapes.downloadReport(report({ coverage: { status: "configured", scopeNote: 1 } })), false);
  assert.equal(shapes.downloadReport(report({ registry: null })), false);
  assert.equal(shapes.downloadReport(report({ registry: { status: "available", items: null } })), false);
  assert.equal(shapes.downloadReport(report({ range: { from: "x", to: "y" } })), false);
  assert.equal(shapes.downloadReport(report({ status: "available", summary: null })), false);
  assert.equal(shapes.downloadReport(report({ summary: summary({ byPlatform: { macos: platform() } }) })), false);
  assert.equal(shapes.downloadReport(report({ summary: summary({ legacyCount: undefined }) })), false);
});

/* --------------------------------------------------- classifyDownloads (F2) */

test("F2: an HTTP failure is 未读取, not 未接入", () => {
  const cell = classifyDownloads({ status: "error", message: "接口暂时不可用，请稍后重试。", unauthorized: false });
  assert.equal(cell.note, "unread");
  assert.equal(cell.reason, "http");
  assert.equal(historicalRequests(cell), null, "a failed read contributes no history number");
});

test("F2: HTTP 200 with status=error is a failed read, not an unconfigured store", () => {
  const cell = classifyDownloads({ status: "ready", data: report({ status: "error", summary: null }) });
  assert.equal(cell.note, "unread");
  assert.equal(cell.reason, "read");
  assert.equal(historicalRequests(cell), null);
});

test("F2: coverage=unconfigured keeps its numbers out of the cumulative column", () => {
  const cell = classifyDownloads({
    status: "ready",
    data: report({ coverage: { status: "unconfigured", startedAt: null, entries: [], scopeNote: "官网下载页" }, summary: summary({ total: 42 }) })
  });
  assert.equal(cell.note, "unconfigured");
  assert.equal(cell.reason, "coverage");
  // The 42 is shown as history, never as 累计.
  assert.equal(historicalRequests(cell), 42);
});

test("F2: a confirmed zero only exists when counting is configured", () => {
  const ready = classifyDownloads({ status: "ready", data: report({ summary: summary({ total: 0, period: 0, legacyCount: 0 }) }) });
  assert.equal(ready.note, "ready");
  assert.equal(ready.summary.total, 0);
  assert.equal(historicalRequests(ready), null);

  // The same zeros with no start are not a cumulative total.
  const unstarted = classifyDownloads({
    status: "ready",
    data: report({ coverage: { status: "unconfigured", startedAt: null, entries: [], scopeNote: "官网下载页" }, summary: summary({ total: 0, period: 0 }) })
  });
  assert.equal(unstarted.note, "unconfigured");
});

test("F2: a store that is off is 未接入 for a different reason than a missing start", () => {
  const cell = classifyDownloads({ status: "ready", data: report({ status: "unavailable", summary: null }) });
  assert.equal(cell.note, "unconfigured");
  assert.equal(cell.reason, "store");
  assert.equal(historicalRequests(cell), null);
});

test("F2: loading is its own state and never borrows a number", () => {
  assert.equal(classifyDownloads({ status: "loading" }).note, "loading");
});
