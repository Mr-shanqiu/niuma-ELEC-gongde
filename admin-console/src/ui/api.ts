import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Read state for one API call.
 *
 * The important part is what is *not* here: there is no default value and no
 * `data ?? 0`. A page reads `status` and renders "未读取" for anything that is
 * not `ready`, so a failed request can never be painted as an empty result.
 */
export type ReadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "empty"; data: T }
  | { status: "error"; message: string; unauthorized: boolean };

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * A 401 is a session fact, not a page fact.
 *
 * Every read goes through here, so signing out is registered once instead of
 * being repeated (and eventually forgotten) in each page. A page that also
 * handles 401 for its own writes is harmless: the handler is idempotent.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

/** An endpoint whose documented answer has no `data` key still needs a shape check. */
type Expect = (body: Record<string, unknown>) => boolean;

type Options = {
  /** Treat a "no records" answer as its own state instead of `ready`. */
  isEmpty?: (data: unknown) => boolean;
  /** Skip the request until this is true. */
  enabled?: boolean;
  /** Shape guard for an endpoint that does not answer with a `data` key. */
  expect?: Expect;
};

export function useRead<T>(path: string | null, options: Options = {}) {
  const url = path === null ? null : `/api/gongde/admin${path}`;
  return useApiRead<T>(url, options);
}

/** v2 distribution endpoints answer with `{ data, serverTime, requestId }`. */
export function useDistributionRead<T>(path: string | null, options: { enabled?: boolean; expectData?: (data: unknown) => boolean } = {}) {
  const url = path === null ? null : `/api/gongde/v2/admin${path}`;
  const expectData = options.expectData;
  // The envelope is checked here, once, so no caller can forget `serverTime`
  // and then treat a broken answer as fresh data.
  const expectEnvelope = useCallback((body: Record<string, unknown>) => {
    if (!("data" in body) || !Number.isFinite(Date.parse(String(body.serverTime)))) return false;
    return expectData ? expectData(body.data) : true;
  }, [expectData]);
  return useApiRead<{ data: T; serverTime: string }>(url, { enabled: options.enabled, expect: expectEnvelope });
}

/**
 * One read of one URL.
 *
 * `revision` bumps re-run it; `enabled: false` skips it until the page is ready
 * to ask. Nothing is cached between mounts, because every endpoint here returns
 * order, claim or session state.
 */
export function useApiRead<T>(url: string | null, options: Options = {}) {
  const [state, setState] = useState<ReadState<T>>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const enabled = options.enabled ?? true;
  // The two guards are pure predicates, not state: holding them in refs means a
  // caller that writes them inline cannot restart the read on every render.
  const guards = useRef({ isEmpty: options.isEmpty, expect: options.expect });
  guards.current = { isEmpty: options.isEmpty, expect: options.expect };
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (url === null || !enabled) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    void requestJson<T>(url, { signal: controller.signal }, guards.current.expect)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState(guards.current.isEmpty?.(data) ? { status: "empty", data } : { status: "ready", data });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const error = failure as ApiError;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "读取失败。",
          unauthorized: error?.status === 401
        });
      });
    return () => controller.abort();
  }, [url, enabled, revision]);

  return { state, reload };
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Admin API call.
 *
 * `private, no-store` responses carry order, claim and session state, so they
 * are never cached here either.
 *
 * `expect` names the shape an endpoint is documented to answer with. Anything
 * else is rejected instead of being read field by field, because a missing key
 * and a zero look the same once the value reaches the page.
 */
export async function api<T>(path: string, init: RequestInit = {}, expect?: Expect): Promise<T> {
  return requestJson<T>(`/api/gongde/admin${path}`, init, expect);
}

/**
 * v2 distribution API. Kept separate from `api` because it answers with
 * `{ data, serverTime }` and uses different error shapes.
 */
export async function distributionApi<T>(path: string, init: RequestInit = {}): Promise<{ data: T; serverTime: string }> {
  const body = await rawJson<Record<string, unknown>>(`/api/gongde/v2/admin${path}`, init);
  if (!("data" in body) || !Number.isFinite(Date.parse(String(body.serverTime)))) {
    throw new ApiError("接口响应结构尚未确认，未采用旧数据或推测值。");
  }
  return body as { data: T; serverTime: string };
}

/** A write whose success the page must not assume. */
export async function post<T>(path: string, body: unknown, base = "/api/gongde/admin"): Promise<T> {
  return rawJson<T>(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
}

export async function requestJson<T>(url: string, init: RequestInit = {}, expect?: Expect): Promise<T> {
  const body = await rawJson<T>(url, init);
  if (expect && !expect(body as unknown as Record<string, unknown>)) {
    // A 200 whose shape is not the documented one is not usable data.
    throw new ApiError("接口返回结构未确认，未采用推测值。");
  }
  if (!expect && !("data" in (body as object)) && !("periods" in (body as object)) && !("username" in (body as object))) {
    throw new ApiError("接口返回结构未确认，未采用推测值。");
  }
  return body;
}

async function rawJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const body = await readBody(response);
  if (!response.ok) {
    if (response.status === 401) onUnauthorized?.();
    throw new ApiError(errorMessage(body, response.status), response.status);
  }
  return body as T;
}

function errorMessage(body: Record<string, unknown>, status: number): string {
  if (typeof body.message === "string" && body.message.length > 0) return body.message;
  if (status === 401) return "管理员会话已过期，请重新登录。";
  if (status === 409) return "记录已变更，请刷新后重新确认操作和原因。";
  if (typeof body.error === "string") return chineseError(body.error);
  return "接口暂时不可用，请稍后重试。";
}

/**
 * Documented-shape guards for the endpoints the console reads.
 *
 * These check the fields the pages actually consume, not just that a top-level
 * key exists. `{periods:{},services:{},recent:[],downloads:{}}` is a 200 and
 * passes a truthiness check, then throws inside render — which is the bug these
 * guards exist to keep out of the page. A guard returning false lands the read
 * in `error`, so the page says "未读取" instead of showing zero.
 */
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCounts = (value: unknown): boolean =>
  Boolean(value) && isCount((value as { orders?: unknown }).orders) && isCount((value as { amountFen?: unknown }).amountFen);
const isPlatformCounts = (value: unknown): boolean =>
  Boolean(value) &&
  isCount((value as { total?: unknown }).total) && isCount((value as { period?: unknown }).period);

/**
 * Item-level guards.
 *
 * `Array.isArray(items)` says nothing about what is inside: `[null]` passes it
 * and then throws on the first property read. Every list the pages map over is
 * checked entry by entry, against the fields those rows actually read. A list
 * that is genuinely empty still passes — empty is an answer, a null row is not.
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === "string";
const isStamp = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
const isStampOrNull = (value: unknown): boolean => value === null || isStamp(value);
const every = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);

/** A per-file row of the download summary. */
const isDownloadFile = (entry: unknown): boolean =>
  isObject(entry) && isText(entry.fileName) && isCount(entry.total) && isCount(entry.period);

/** One registry entry, as the installer table renders it. */
const isRegistryItem = (entry: unknown): boolean =>
  isObject(entry) && isText(entry.name) && isText(entry.platform) && isText(entry.version) && isCount(entry.bytes);

/** One row of the "needs attention" list on 今日运营. */
const isIssueEntry = (entry: unknown): boolean =>
  isObject(entry) && isText(entry.claimId) && isText(entry.state) && isTextOrNull(entry.error) &&
  every(entry.workNumbers, isText) && isStamp(entry.createdAt) && isCount(entry.waitingSeconds);

/** One appearance inside a claim; the drawer table uses all three fields. */
const isClaimItem = (entry: unknown): boolean =>
  isObject(entry) && isText(entry.number) && isText(entry.title) && isText(entry.catalogRevision);

/** One claim row, covering the table columns and the drawer it opens. */
const isClaimEntry = (entry: unknown): boolean =>
  isObject(entry) && isText(entry.claimId) && isText(entry.kind) && isText(entry.state) &&
  isText(entry.codeFamilyId) && isStamp(entry.createdAt) &&
  every(entry.items, isClaimItem) &&
  (entry.bytes === null || isCount(entry.bytes)) &&
  (entry.durationMs === null || isCount(entry.durationMs)) &&
  isTextOrNull(entry.error) && isStampOrNull(entry.issuedAt) && isStampOrNull(entry.downloadExpiresAt);

/** One report row; the detail pane formats every field it shows. */
const isReportEntry = (entry: unknown): boolean =>
  isObject(entry) && isText(entry.id) && isText(entry.number) && isText(entry.state) &&
  isText(entry.category) && isText(entry.description) && isStamp(entry.createdAt) &&
  isTextOrNull(entry.versionId) && isTextOrNull(entry.evidence) && isTextOrNull(entry.contact) &&
  isStampOrNull(entry.resolvedAt) && isTextOrNull(entry.resolution);

/** One retention registration; `references.length` is read directly. */
const isRetentionEntry = (entry: unknown): boolean =>
  isObject(entry) && isText(entry.platform) && isText(entry.version) && isText(entry.releaseId) &&
  isText(entry.sha256) && isText(entry.publicDownloadUrl) && every(entry.references, isText);

const isDownloadSummary = (value: unknown): boolean => {
  if (!isObject(value)) return false;
  const summary = value;
  const byPlatform = summary.byPlatform as Record<string, unknown> | undefined;
  return isCount(summary.total) && isCount(summary.period) && every(summary.byFile, isDownloadFile) &&
    Boolean(byPlatform) && isPlatformCounts(byPlatform!.macos) && isPlatformCounts(byPlatform!.windows) &&
    isCount(summary.legacyCount) && isCount(summary.unattributed);
};

export const shapes = {
  session: (body: Record<string, unknown>) => typeof body.username === "string" && body.username.length > 0,
  list: (body: Record<string, unknown>) =>
    Array.isArray(body.data) && Number.isSafeInteger(body.total) && (body.total as number) >= 0,
  page: (body: Record<string, unknown>) =>
    Boolean(body.data) && Array.isArray((body.data as Record<string, unknown>).items) &&
    Number.isSafeInteger((body.data as Record<string, unknown>).total),
  overview: (body: Record<string, unknown>) => {
    const periods = body.periods as Record<string, unknown> | undefined;
    const services = body.services as Record<string, unknown> | undefined;
    const downloads = body.downloads as Record<string, unknown> | undefined;
    if (!periods || !services || !downloads || !Array.isArray(body.recent)) return false;
    if (!isCounts(periods.selectedDay) || !isCounts(periods.allTime)) return false;
    if (typeof services !== "object" || typeof downloads.status !== "string") return false;
    return downloads.status === "available" ? isDownloadSummary(downloads.summary) : downloads.summary === null;
  },
  downloadReport: (body: Record<string, unknown>) => {
    const coverage = body.coverage as Record<string, unknown> | undefined;
    const registry = body.registry as Record<string, unknown> | undefined;
    const range = body.range as Record<string, unknown> | undefined;
    return isObject(coverage) && (coverage.status === "configured" || coverage.status === "unconfigured") &&
      isText(coverage.scopeNote) &&
      isObject(registry) && every(registry.items, isRegistryItem) &&
      isText(body.status) &&
      isObject(range) && isStamp(range.from) && isStamp(range.to) &&
      (body.status === "available" ? isDownloadSummary(body.summary) : body.summary === null);
  },
  operations: (body: Record<string, unknown>) => {
    const claims = body.claims as Record<string, unknown> | undefined;
    return isStamp(body.asOf) && isObject(claims) &&
      isText(claims.status) && every(claims.items, isIssueEntry);
  },
  paymentConfig: (body: Record<string, unknown>) =>
    Number.isSafeInteger(body.unitPriceFen) && Number.isSafeInteger(body.maxItems) && typeof body.mode === "string",
  orderDetail: (body: Record<string, unknown>) =>
    Boolean(body.data) && Array.isArray((body.data as Record<string, unknown>).marketItems)
};

/**
 * v2 data guards, for the payloads where a missing field would otherwise read
 * as a usable value. `revision: undefined` satisfies `revision !== null`, which
 * is enough to enable a destructive button on a response that never carried a
 * revision at all.
 */
export const v2Shapes = {
  /**
   * A code snapshot is actionable only when every writable field is present.
   *
   * `familyId: null` is a real "no code family" state, but it is only trusted
   * once the rest of the snapshot also looks like one: the server sends
   * `revision: null`, `status: "INACTIVE"`, no code and no window. Returning
   * true for a bare `{familyId: null}` would accept a truncated response as a
   * confirmed "not enabled".
   */
  codeSnapshot: (data: unknown): boolean => {
    if (!isObject(data)) return false;
    const snapshot = data;
    if (!("familyId" in snapshot) || !("revision" in snapshot)) return false;
    if (!["ACTIVE", "PAUSED", "INACTIVE"].includes(String(snapshot.status))) return false;
    if (snapshot.code !== null && !isText(snapshot.code)) return false;
    if (!isStampOrNull(snapshot.expiresAt) || !isStampOrNull(snapshot.validFrom)) return false;
    if (!isCount(snapshot.maxItems) || !isCount(snapshot.contributionCount)) return false;
    if (snapshot.familyId === null) {
      return snapshot.revision === null && snapshot.status === "INACTIVE" &&
        snapshot.code === null && snapshot.validFrom === null && snapshot.expiresAt === null;
    }
    if (!isText(snapshot.familyId) || snapshot.familyId.length === 0) return false;
    return Number.isSafeInteger(snapshot.revision) && (snapshot.revision as number) >= 0;
  },
  /** `/operations` answers `{ asOf, claims, reviews, budget }`; claims is the part the page counts. */
  operations: (data: unknown): boolean => {
    if (!isObject(data)) return false;
    const claims = data.claims as Record<string, unknown> | undefined;
    return isStamp(data.asOf) && isObject(claims) &&
      isText(claims.status) && every(claims.items, isIssueEntry);
  },
  claimsPage: (data: unknown): boolean => isObject(data) && every(data.items, isClaimEntry) &&
    isCount(data.total),
  stats: (data: unknown): boolean => isObject(data) &&
    (data.readyClaims === null || isCount(data.readyClaims)) &&
    (data.workClaims === null || isCount(data.workClaims)) &&
    (data.verifiedCodes === null || isCount(data.verifiedCodes)),
  reportsPage: (data: unknown): boolean => isObject(data) && every(data.items, isReportEntry) &&
    isCount(data.total),
  /** `/installer-retention`; the page reads `references.length` and the stamp. */
  retention: (data: unknown): boolean => isObject(data) && isStamp(data.asOf) &&
    isText(data.registryStatus) && isText(data.minimumCompatibleVersion) &&
    every(data.items, isRetentionEntry)
};

/** A code the page cannot explain in the operator's language is still a code, not a guess. */
function chineseError(code: string): string {
  const known: Record<string, string> = {
    admin_not_enabled: "管理登录未启用。",
    admin_auth_required: "管理员会话已过期，请重新登录。",
    invalid_login_request: "登录请求无效。",
    pack_delivery_not_enabled: "形象包交付未启用。",
    admin_object_store_not_enabled: "文件存储未启用。",
    download_store_not_enabled: "下载统计未启用。",
    download_registry_unavailable: "安装包登记不可读。",
    download_not_found: "这个安装包不在当前登记中。",
    download_summary_unavailable: "下载统计读取失败。",
    invalid_pagination: "分页参数无效。",
    invalid_channel: "支付渠道筛选值无效。",
    invalid_state: "订单状态筛选值无效。",
    invalid_order_no: "订单号格式无效。",
    order_not_found: "订单不存在或不是有效支付记录。",
    appearance_not_found: "形象不存在。",
    appearance_number_invalid: "请输入完整的 6 至 9 位形象编号。",
    appearance_numbers_unavailable: "形象编号服务不可用。",
    group_benefit_code_unavailable: "群码读取失败。",
    service_unavailable: "服务暂时不可用。",
    request_invalid: "请求参数无效。",
    revision_conflict: "记录已变更，请刷新后重新确认操作和原因。",
    not_found: "记录不存在。"
  };
  return known[code] ?? "请求失败。";
}
