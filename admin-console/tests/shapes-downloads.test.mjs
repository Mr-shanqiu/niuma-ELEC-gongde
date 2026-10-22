import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, isFileEntry, isSafetyEntry, shapes, v2Shapes } from "../src/ui/api.ts";
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
  // `familyId: null` alone is not enough; the rest of the snapshot has to look
  // like the server's real "no family" answer (see the dedicated test below).
  assert.equal(v2Shapes.codeSnapshot(codeSnapshot({ familyId: null, revision: null })), false);
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

const issue = (overrides = {}) => ({
  claimId: "0123456789abcdef0123456789abcdef",
  state: "FAILED",
  error: "pack_signing_failed",
  workNumbers: ["100001", "100002"],
  createdAt: "2026-10-22T01:00:00.000Z",
  waitingSeconds: 5400,
  ...overrides
});

test("F6: operations needs a real asOf and a claims list", () => {
  const body = { asOf: "2026-10-22T02:00:00.000Z", claims: { status: "available", items: [] }, reviews: {}, budget: {} };
  assert.equal(v2Shapes.operations(body), true);
  assert.equal(v2Shapes.operations({ ...body, asOf: undefined }), false);
  assert.equal(v2Shapes.operations({ asOf: body.asOf }), false);
  assert.equal(v2Shapes.operations({ asOf: body.asOf, claims: { status: "available" } }), false);
  assert.equal(v2Shapes.operations({}), false);
});

test("F6: an operations issue list with a bad entry is rejected, an empty one is not", () => {
  const body = (items) => ({ asOf: "2026-10-22T02:00:00.000Z", claims: { status: "available", items } });
  assert.equal(v2Shapes.operations(body([])), true, "an empty queue is an answer");
  assert.equal(v2Shapes.operations(body([issue()])), true);
  // The review's case: `[null]` passed `Array.isArray` and then threw on `item.claimId`.
  assert.equal(v2Shapes.operations(body([null])), false);
  assert.equal(v2Shapes.operations(body([{}])), false);
  assert.equal(v2Shapes.operations(body([issue({ claimId: undefined })])), false);
  assert.equal(v2Shapes.operations(body([issue({ workNumbers: null })])), false);
  assert.equal(v2Shapes.operations(body([issue({ workNumbers: [1] })])), false);
  assert.equal(v2Shapes.operations(body([issue({ createdAt: "yesterday" })])), false);
  assert.equal(v2Shapes.operations(body([issue({ waitingSeconds: "5400" })])), false);
  assert.equal(v2Shapes.operations(body([issue({ error: undefined })])), false, "error must be null or a string");
  assert.equal(v2Shapes.operations(body([issue(), issue({ waitingSeconds: null })])), false, "one bad row spoils the list");
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

const file = (overrides = {}) => ({ fileName: "niuma-merit-macos-0.9.4.dmg", total: 6, period: 2, ...overrides });
const registration = (overrides = {}) => ({
  name: "niuma-merit-macos-0.9.4.dmg", platform: "macos", version: "0.9.4",
  releaseId: "niuma-merit-macos-0.9.4", bytes: 1024, sha256: "a".repeat(64),
  countedUrl: "/api/gongde/downloads/niuma-merit-macos-0.9.4.dmg",
  ...overrides
});

test("F6: a download report rejects bad entries in byFile and registry.items", () => {
  // The review's case: `byFile: [null]` passed and InstallersView threw on `entry.fileName`.
  assert.equal(shapes.downloadReport(report({ summary: summary({ byFile: [null] }) })), false);
  assert.equal(shapes.downloadReport(report({ summary: summary({ byFile: [{}] }) })), false);
  assert.equal(shapes.downloadReport(report({ summary: summary({ byFile: [{ fileName: "a", total: 1 }] }) })), false, "period is read too");
  assert.equal(shapes.downloadReport(report({ summary: summary({ byFile: [] }) })), true, "no files yet is a legal answer");

  assert.equal(shapes.downloadReport(report({ registry: { status: "available", items: [null] } })), false);
  assert.equal(shapes.downloadReport(report({ registry: { status: "available", items: [registration()] } })), true);
  assert.equal(shapes.downloadReport(report({ registry: { status: "available", items: [registration({ bytes: undefined })] } })), false);
  assert.equal(shapes.downloadReport(report({ registry: { status: "available", items: [] } })), true);
  assert.equal(shapes.downloadReport(report({ registry: { status: "unavailable", items: [] } })), true);
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

/* ---------------------------------------- v2 page lists (F6, second round) */

const claimItem = (overrides = {}) => ({ number: "100001", title: "招财猫", catalogRevision: "c0ffee2", ...overrides });
const claim = (overrides = {}) => ({
  claimId: "0123456789abcdef0123456789abcdef",
  kind: "GROUP",
  state: "READY",
  codeFamilyId: "group-2026-1",
  items: [claimItem()],
  bytes: 2400000,
  durationMs: 480,
  error: null,
  createdAt: "2026-10-22T01:00:00.000Z",
  issuedAt: "2026-10-22T01:00:05.000Z",
  downloadExpiresAt: "2026-10-29T01:00:05.000Z",
  ...overrides
});
const reportEntry = (overrides = {}) => ({
  id: "ab".repeat(16),
  number: "100001",
  versionId: null,
  state: "OPEN",
  category: "版权归属",
  description: "原始描述",
  evidence: null,
  contact: null,
  createdAt: "2026-10-22T01:00:00.000Z",
  resolvedAt: null,
  resolution: null,
  ...overrides
});

test("F6: a claims page rejects bad rows and bad nested items", () => {
  assert.equal(v2Shapes.claimsPage({ items: [], total: 0 }), true, "an empty day is a legal answer");
  assert.equal(v2Shapes.claimsPage({ items: [claim()], total: 1 }), true);
  assert.equal(v2Shapes.claimsPage({ items: [null], total: 1 }), false);
  assert.equal(v2Shapes.claimsPage({ items: [claim({ claimId: undefined })], total: 1 }), false);
  assert.equal(v2Shapes.claimsPage({ items: [claim({ items: null })], total: 1 }), false, "the drawer table maps items");
  assert.equal(v2Shapes.claimsPage({ items: [claim({ items: [null] })], total: 1 }), false);
  assert.equal(v2Shapes.claimsPage({ items: [claim({ items: [claimItem({ catalogRevision: undefined })] })], total: 1 }), false);
  assert.equal(v2Shapes.claimsPage({ items: [claim({ createdAt: "nope" })], total: 1 }), false);
  assert.equal(v2Shapes.claimsPage({ items: [claim()], total: "1" }), false);
  assert.equal(v2Shapes.claimsPage(null), false);
});

test("F6: a reports page rejects bad rows", () => {
  assert.equal(v2Shapes.reportsPage({ items: [], total: 0 }), true);
  assert.equal(v2Shapes.reportsPage({ items: [reportEntry()], total: 1 }), true);
  assert.equal(v2Shapes.reportsPage({ items: [null], total: 1 }), false);
  assert.equal(v2Shapes.reportsPage({ items: [{ ...reportEntry(), description: undefined }], total: 1 }), false);
  assert.equal(v2Shapes.reportsPage({ items: [{ ...reportEntry(), createdAt: undefined }], total: 1 }), false);
  assert.equal(v2Shapes.reportsPage({ items: [{ ...reportEntry(), resolution: 1 }], total: 1 }), false);
});

test("F6: stats must be numbers or null, not an arbitrary object", () => {
  assert.equal(v2Shapes.stats({ readyClaims: 7, workClaims: 19, verifiedCodes: 24 }), true);
  assert.equal(v2Shapes.stats({ readyClaims: null, workClaims: null, verifiedCodes: null }), true);
  assert.equal(v2Shapes.stats({}), false, "missing counts render as zeros otherwise");
  assert.equal(v2Shapes.stats({ readyClaims: "7", workClaims: 1, verifiedCodes: 1 }), false);
  assert.equal(v2Shapes.stats(null), false);
});

test("F6: a retention snapshot rejects bad registrations", () => {
  const retention = (items) => ({
    asOf: "2026-10-22T02:00:00.000Z", registryStatus: "available", minimumCompatibleVersion: "0.9.0",
    items
  });
  const entry = (overrides = {}) => ({
    platform: "macos", version: "0.9.4", releaseId: "niuma-merit-macos-0.9.4",
    sha256: "a".repeat(64), publicDownloadUrl: "https://download.gongde.zqscreen.cn/a.dmg",
    references: ["distribution-registry"], ...overrides
  });
  assert.equal(v2Shapes.retention(retention([entry()])), true);
  assert.equal(v2Shapes.retention(retention([])), true);
  assert.equal(v2Shapes.retention(retention([null])), false);
  assert.equal(v2Shapes.retention(retention([entry({ references: null })])), false, "the page reads references.length");
  assert.equal(v2Shapes.retention(retention([entry({ sha256: undefined })])), false);
  assert.equal(v2Shapes.retention({ ...retention([]), asOf: "today" }), false);
});

test("F6: a 'no code family' snapshot is only accepted when it looks like one", () => {
  const none = {
    familyId: null, revision: null, kind: "CREATOR", status: "INACTIVE", code: null,
    validFrom: null, expiresAt: null, contributionCount: 0, maxItems: 0, redemptionEnabled: false
  };
  assert.equal(v2Shapes.codeSnapshot(none), true);
  // A truncated response that happens to carry familyId: null is not evidence
  // that no code exists; it is a failed read.
  assert.equal(v2Shapes.codeSnapshot({ familyId: null, revision: null }), false);
  assert.equal(v2Shapes.codeSnapshot({ familyId: null, revision: 3, status: "ACTIVE" }), false);
  assert.equal(v2Shapes.codeSnapshot({ ...none, status: "ACTIVE" }), false);
  assert.equal(v2Shapes.codeSnapshot({ ...none, code: "GD123456" }), false);
  assert.equal(v2Shapes.codeSnapshot({ ...none, maxItems: undefined }), false);
});

/* ------------------------------------------- appearance writes (second batch) */

const appearance = (overrides = {}) => ({
  id: "official.a", assetId: "official.a", appearanceNumber: "100001",
  name: "招财猫", revision: "a".repeat(64), state: "PUBLISHED", ...overrides
});

test("F6: the appearances list needs its rows and the publication revision", () => {
  assert.equal(shapes.appearances({ data: [appearance()], total: 1, publicationRevision: 3 }), true);
  assert.equal(shapes.appearances({ data: [], total: 0, publicationRevision: 0 }), true, "an empty gallery is legal");
  // Without the version the page cannot build a fenced write, so it must not
  // enable one.
  assert.equal(shapes.appearances({ data: [appearance()], total: 1 }), false);
  assert.equal(shapes.appearances({ data: [appearance()], total: 1, publicationRevision: "3" }), false);
  assert.equal(shapes.appearances({ data: [null], total: 1, publicationRevision: 1 }), false);
  assert.equal(shapes.appearances({ data: [appearance({ state: "SOMETHING" })], total: 1, publicationRevision: 1 }), false);
  // A published row with no material revision cannot be acted on.
  assert.equal(shapes.appearances({ data: [appearance({ revision: null })], total: 1, publicationRevision: 1 }), false);
  // ...but MISSING is exactly the state whose revision is null.
  assert.equal(shapes.appearances({ data: [appearance({ state: "MISSING", revision: null })], total: 1, publicationRevision: 1 }), true);
  assert.equal(shapes.appearances({ data: [appearance({ state: "MISSING", revision: "x" })], total: 1, publicationRevision: 1 }), false);
  assert.equal(shapes.appearances({ data: [appearance({ assetId: undefined })], total: 1, publicationRevision: 1 }), false);
});

test("F6: a safety row is rejected when its revision is not a real version", () => {
  const safe = { assetId: "official.a", blocked: false, revision: 0, reason: null, updatedBy: null, updatedAt: null };
  assert.equal(isSafetyEntry(safe), true);
  assert.equal(isSafetyEntry({ ...safe, blocked: "false" }), false);
  assert.equal(isSafetyEntry({ ...safe, revision: "0" }), false);
  assert.equal(isSafetyEntry({ ...safe, revision: -1 }), false);
  assert.equal(isSafetyEntry({ ...safe, updatedAt: "yesterday" }), false);
  assert.equal(isSafetyEntry(null), false);
});

test("F6: a file row is rejected when the delete key is missing", () => {
  const file = { id: "appearance:a.nmgpack", name: "a.nmgpack", kind: "appearance",
    size: 10, lastModified: "2026-10-22T00:00:00.000Z", url: "https://example.invalid/a.nmgpack" };
  assert.equal(isFileEntry(file), true);
  assert.equal(isFileEntry({ ...file, name: undefined }), false);
  assert.equal(isFileEntry({ ...file, kind: "other" }), false);
  assert.equal(isFileEntry({ ...file, size: "10" }), false);
  assert.equal(isFileEntry([file]), false);
});

test("a 409 carries the server's revision so the page can say what changed", () => {
  // Mirrors what `rawJson` reads from a conflict body; the page never guesses
  // the new revision from a local counter.
  const body = { error: "appearance_publication_conflict", publicationRevision: 9 };
  const error = new ApiError("发布状态已被其他会话修改，请重新读取后再确认。", 409, body.error, body.publicationRevision);
  assert.equal(error.status, 409);
  assert.equal(error.code, "appearance_publication_conflict");
  assert.equal(error.revision, 9);
});
