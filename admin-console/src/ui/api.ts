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

/** v2 distribution endpoints answer with `{ data, serverTime }`. */
export function useDistributionRead<T>(path: string | null, options: { enabled?: boolean } = {}) {
  const url = path === null ? null : `/api/gongde/v2/admin${path}`;
  return useApiRead<{ data: T; serverTime: string }>(url, { enabled: options.enabled });
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

/** Documented-shape guards for the endpoints the console reads. */
export const shapes = {
  session: (body: Record<string, unknown>) => typeof body.username === "string" && body.username.length > 0,
  list: (body: Record<string, unknown>) =>
    Array.isArray(body.data) && Number.isSafeInteger(body.total) && (body.total as number) >= 0,
  page: (body: Record<string, unknown>) =>
    Boolean(body.data) && Array.isArray((body.data as Record<string, unknown>).items) &&
    Number.isSafeInteger((body.data as Record<string, unknown>).total),
  overview: (body: Record<string, unknown>) =>
    Boolean(body.periods) && Boolean(body.services) && Array.isArray(body.recent) && Boolean(body.downloads),
  downloadReport: (body: Record<string, unknown>) =>
    Boolean(body.coverage) && Boolean(body.registry) && typeof body.status === "string",
  operations: (body: Record<string, unknown>) =>
    Boolean(body.claims) && Boolean(body.asOf) && Number.isFinite(Date.parse(String(body.asOf))),
  paymentConfig: (body: Record<string, unknown>) =>
    Number.isSafeInteger(body.unitPriceFen) && Number.isSafeInteger(body.maxItems) && typeof body.mode === "string",
  orderDetail: (body: Record<string, unknown>) =>
    Boolean(body.data) && Array.isArray((body.data as Record<string, unknown>).marketItems)
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
