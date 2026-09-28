import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { GongdeOrderService } from "./domain/order-service.js";
import { InMemoryPaymentStore } from "./domain/store.js";
import type { PaymentStore } from "./domain/store.js";
import { loadGongdeMySqlConfiguration, MySqlPaymentStore } from "./storage/mysql-store.js";
import { AppearancePackSigner, loadPackSignerConfiguration } from "./delivery/pack-signer.js";
import type { PaymentChannel, PurchaseKind } from "./domain/types.js";
import { WechatPayNativeClient } from "./payments/providers/wechat-native/native.js";
import { parseWechatPayRuntimeConfiguration } from "./payments/providers/wechat-native/runtimeConfig.js";
import { WechatPayError } from "./payments/providers/wechat-native/types.js";
import { AlipayPageClient } from "./payments/providers/alipay-page/client.js";
import { parseAlipayRuntimeConfiguration } from "./payments/providers/alipay-page/runtimeConfig.js";
import { AlipayError } from "./payments/providers/alipay-page/types.js";
import { toDataURL } from "qrcode";
import { zipSync } from "fflate";
import { AdminAuthService, loadAdminAuthConfiguration } from "./admin/auth.js";
import { AdminObjectStore, loadAdminObjectStoreConfiguration, parseAdminFileIdentity } from "./admin/object-store.js";
import type { GongdeEntitlement, GongdeOrder, OrderState } from "./domain/types.js";
import { OFFICIAL_ASSET_IDS, OFFICIAL_ASSET_NAMES_ZH } from "./domain/catalog.js";

const mode = process.env.GONGDE_PAYMENT_MODE ?? "disabled";
if (!new Set(["disabled", "mock", "live"]).has(mode)) throw new Error("invalid_payment_mode");
const testToken = process.env.GONGDE_PAYMENT_TEST_TOKEN ?? "";
if (mode === "mock" && testToken.length < 24) throw new Error("mock_mode_requires_strong_test_token");
const packMode = process.env.GONGDE_PACK_DELIVERY_MODE ?? "disabled";
if (packMode !== "disabled" && packMode !== "local") throw new Error("invalid_pack_delivery_mode");

const storeMode = process.env.GONGDE_STORE_MODE ?? "memory";
if (storeMode !== "memory" && storeMode !== "mysql") throw new Error("invalid_store_mode");
if (mode === "live" && storeMode !== "mysql") throw new Error("live_payment_requires_mysql_store");
const store: PaymentStore = storeMode === "mysql"
  ? MySqlPaymentStore.connect(loadGongdeMySqlConfiguration())
  : new InMemoryPaymentStore();
const service = new GongdeOrderService(store);
const wechatPay = mode === "live" ? new WechatPayNativeClient(parseWechatPayRuntimeConfiguration(process.env)) : null;
const alipay = mode === "live" ? new AlipayPageClient(parseAlipayRuntimeConfiguration(process.env)) : null;
if (mode === "live" && !wechatPay?.enabled && !alipay?.enabled) throw new Error("live_payment_requires_provider");
const packSigner = packMode === "local" ? new AppearancePackSigner(loadPackSignerConfiguration()) : null;
const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";
const adminConfiguration = loadAdminAuthConfiguration();
const adminAuth = adminConfiguration ? new AdminAuthService(adminConfiguration) : null;
const adminObjectStoreConfiguration = loadAdminObjectStoreConfiguration();
const adminObjectStore = adminObjectStoreConfiguration ? new AdminObjectStore(adminObjectStoreConfiguration) : null;

async function availableAppearanceRevisions(): Promise<Record<string, string>> {
  if (!packSigner) return {};
  const revisions = packSigner.revisions();
  const publishedIds = adminObjectStore ? await adminObjectStore.publishedAssetIds(OFFICIAL_ASSET_IDS) : [...OFFICIAL_ASSET_IDS];
  return Object.fromEntries(publishedIds.flatMap((assetId) => revisions[assetId] ? [[assetId, revisions[assetId]]] : []));
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function parseDate(value: string | null, name: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name}_invalid`);
  return date;
}

function requireAdmin(request: IncomingMessage): string {
  if (!adminAuth) throw new Error("admin_not_enabled");
  return adminAuth.requireSession(header(request, "cookie")).username;
}

function publicAccessReference(userId: string | null): string | null {
  return userId ? createHash("sha256").update(userId).digest("hex").slice(0, 12) : null;
}

function adminOrder(order: GongdeOrder) {
  return {
    id: order.orderNo,
    orderNo: order.orderNo,
    productId: order.productId,
    productVersion: order.productVersion,
    channel: order.channel,
    purchaseKind: order.purchaseKind,
    accessReference: publicAccessReference(order.userId),
    assetId: order.assetId,
    assetIds: order.assetIds,
    amountFen: order.amountFen,
    currency: order.currency,
    state: order.state,
    providerTransactionId: order.providerTransactionId,
    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null
  };
}

function adminEntitlement(entitlement: GongdeEntitlement) {
  return {
    id: entitlement.id,
    scope: entitlement.scope,
    assetId: entitlement.assetId,
    state: entitlement.state,
    createdAt: entitlement.createdAt.toISOString(),
    activatedAt: entitlement.activatedAt?.toISOString() ?? null,
    expiresAt: entitlement.expiresAt?.toISOString() ?? null,
    revokedAt: entitlement.revokedAt?.toISOString() ?? null
  };
}

function audit(event: string, details: Record<string, string | number | null> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), scope: "gongde-admin", event, ...details })}\n`);
}

async function readBody(request: IncomingMessage, maximumBytes = 16 * 1024): Promise<string> {
  return (await readBuffer(request, maximumBytes)).toString("utf8");
}

async function readBuffer(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > maximumBytes) throw new Error("request_too_large");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse(await readBody(request)) as Record<string, unknown>;
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function paymentDescription(kind: PurchaseKind): string {
  return kind === "official-pass" ? "牛马电子功德-官方形象通行证"
    : kind === "asset-delivery" ? "牛马电子功德-形象包生成"
      : "牛马电子功德-自愿赞赏";
}

async function refreshPaidOrder(orderNo: string, buyerToken: string) {
  let result = await service.getOrder(orderNo, buyerToken);
  if (mode !== "live" || result.order.state !== "PENDING_PAYMENT") return result;
  try {
    if (result.order.channel === "wechat" && wechatPay?.enabled) {
      const state = await wechatPay.queryOrder(orderNo);
      if (state.tradeState === "SUCCESS" && state.transactionId && state.paidAt) {
        await service.completePayment({ orderNo, channel: "wechat", providerTransactionId: state.transactionId, amountFen: state.amountFen, paidAt: state.paidAt });
      }
    } else if (result.order.channel === "alipay" && alipay?.enabled) {
      const state = await alipay.queryOrder(orderNo);
      if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(state.tradeState) && state.transactionId && state.paidAt) {
        await service.completePayment({ orderNo, channel: "alipay", providerTransactionId: state.transactionId, amountFen: state.amountFen, paidAt: state.paidAt });
      }
    }
    result = await service.getOrder(orderNo, buyerToken);
  } catch (error) {
    if (!(error instanceof WechatPayError) && !(error instanceof AlipayError)) throw error;
  }
  return result;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { ok: true, mode, storeMode, packMode });
    }
    if (request.method === "GET" && url.pathname === "/api/live") {
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/appearance-revisions") {
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      return json(response, 200, { revisions: await availableAppearanceRevisions() });
    }
    if (request.method === "GET" && url.pathname === "/api/ready") {
      const storeReady = await store.ready();
      const paymentReady = mode !== "live" || Boolean(wechatPay?.enabled || alipay?.enabled);
      return json(response, storeReady && paymentReady ? 200 : 503, { ok: storeReady && paymentReady, storeReady, paymentReady });
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/admin/login") {
      if (!adminAuth) return json(response, 503, { error: "admin_not_enabled" });
      const body = await readJson(request);
      if (typeof body.username !== "string" || typeof body.password !== "string") {
        return json(response, 400, { error: "invalid_login_request" });
      }
      try {
        const token = adminAuth.login(body.username, body.password, request.socket.remoteAddress ?? "unknown");
        audit("login_succeeded");
        return json(response, 200, { username: adminConfiguration!.username }, { "set-cookie": adminAuth.sessionCookie(token) });
      } catch (error) {
        audit("login_failed");
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/admin/logout") {
      const clear = adminAuth?.clearCookie() ?? "gongde_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
      return json(response, 200, { ok: true }, { "set-cookie": clear });
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/session") {
      const username = requireAdmin(request);
      return json(response, 200, { username });
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/overview") {
      requireAdmin(request);
      const from = parseDate(url.searchParams.get("from"), "from") ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = parseDate(url.searchParams.get("to"), "to") ?? new Date();
      const [selectedDay, allTime, downloads, recent, storeReady] = await Promise.all([
        store.summarizeOrders(from, to),
        store.summarizeOrders(new Date(0), new Date()),
        adminObjectStore ? adminObjectStore.summarizeDownloads(from, to) : Promise.resolve({ total: 0, period: 0, byFile: [] }),
        store.listOrders({ effectiveOnly: true, limit: 6, offset: 0 }),
        store.ready()
      ]);
      return json(response, 200, {
        periods: { selectedDay, allTime },
        downloads,
        recent: recent.orders.map(adminOrder),
        services: {
          database: storeReady ? "healthy" : "error",
          wechat: mode === "live" && wechatPay?.enabled ? "healthy" : "disabled",
          alipay: mode === "live" && alipay?.enabled ? "healthy" : "disabled",
          appearanceDelivery: packSigner ? "healthy" : "disabled"
        }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/orders") {
      requireAdmin(request);
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("perPage") ?? "25");
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
        return json(response, 400, { error: "invalid_pagination" });
      }
      const channel = url.searchParams.get("channel");
      const state = url.searchParams.get("state");
      const validStates = new Set<OrderState>(["PAID", "FULFILLED"]);
      if (channel && channel !== "wechat" && channel !== "alipay") return json(response, 400, { error: "invalid_channel" });
      if (state && !validStates.has(state as OrderState)) return json(response, 400, { error: "invalid_state" });
      const orderNo = url.searchParams.get("orderNo")?.trim();
      if (orderNo && !/^[A-Za-z0-9_]{1,48}$/u.test(orderNo)) return json(response, 400, { error: "invalid_order_no" });
      const accessCode = url.searchParams.get("accessCode")?.trim();
      let accessId: string | undefined;
      if (accessCode) {
        try { accessId = await service.resolveAccessId(accessCode); }
        catch { return json(response, 200, { data: [], total: 0 }); }
      }
      const result = await store.listOrders({
        orderNo: orderNo || undefined,
        userId: accessId,
        createdFrom: parseDate(url.searchParams.get("from"), "from"),
        createdTo: parseDate(url.searchParams.get("to"), "to"),
        channel: channel as "wechat" | "alipay" | undefined,
        state: state as OrderState | undefined,
        effectiveOnly: true,
        limit: perPage,
        offset: (page - 1) * perPage
      });
      return json(response, 200, { data: result.orders.map(adminOrder), total: result.total });
    }
    const adminOrderMatch = url.pathname.match(/^\/api\/gongde\/admin\/orders\/([A-Z0-9_]+)$/u);
    if (request.method === "GET" && adminOrderMatch) {
      requireAdmin(request);
      const order = await store.findOrder(adminOrderMatch[1]);
      if (!order || (order.state !== "PAID" && order.state !== "FULFILLED")) return json(response, 404, { error: "order_not_found" });
      const entitlements = await store.findEntitlementsByOrder(order.orderNo);
      audit("order_viewed", { orderNo: order.orderNo });
      return json(response, 200, { data: { ...adminOrder(order), entitlements: entitlements.map(adminEntitlement) } });
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/appearances") {
      requireAdmin(request);
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      const revisions = packSigner.revisions();
      const publishedIds = new Set(adminObjectStore ? await adminObjectStore.publishedAssetIds(OFFICIAL_ASSET_IDS) : OFFICIAL_ASSET_IDS);
      const data = OFFICIAL_ASSET_IDS.map((assetId) => ({
        id: assetId,
        assetId,
        name: OFFICIAL_ASSET_NAMES_ZH[assetId] ?? assetId,
        revision: revisions[assetId] ?? null,
        state: !revisions[assetId] ? "MISSING" : publishedIds.has(assetId) ? "PUBLISHED" : "UNPUBLISHED"
      }));
      return json(response, 200, { data, total: data.length });
    }
    const adminAppearanceMatch = url.pathname.match(/^\/api\/gongde\/admin\/appearances\/([A-Za-z0-9._-]+)$/u);
    if (request.method === "PATCH" && adminAppearanceMatch) {
      requireAdmin(request);
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      if (!adminObjectStore) return json(response, 503, { error: "admin_object_store_not_enabled" });
      const assetId = adminAppearanceMatch[1];
      if (!OFFICIAL_ASSET_IDS.includes(assetId as typeof OFFICIAL_ASSET_IDS[number])) return json(response, 404, { error: "appearance_not_found" });
      const body = await readJson(request);
      if (typeof body.published !== "boolean") return json(response, 400, { error: "invalid_appearance_state" });
      const revisions = packSigner.revisions();
      if (!revisions[assetId]) return json(response, 409, { error: "appearance_resource_missing" });
      const publishedIds = new Set(await adminObjectStore.publishedAssetIds(OFFICIAL_ASSET_IDS));
      if (body.published) publishedIds.add(assetId); else publishedIds.delete(assetId);
      const orderedIds = OFFICIAL_ASSET_IDS.filter((id) => publishedIds.has(id));
      await adminObjectStore.writePublishedAssetIds(orderedIds);
      audit(body.published ? "appearance_published" : "appearance_unpublished", { assetId });
      return json(response, 200, { data: {
        id: assetId,
        assetId,
        name: OFFICIAL_ASSET_NAMES_ZH[assetId] ?? assetId,
        revision: revisions[assetId],
        state: body.published ? "PUBLISHED" : "UNPUBLISHED"
      } });
    }
    if (url.pathname === "/api/gongde/admin/files") {
      requireAdmin(request);
      if (!adminObjectStore) return json(response, 503, { error: "admin_object_store_not_enabled" });
      if (request.method === "GET") {
        const kind = url.searchParams.get("kind");
        if (kind !== "appearance" && kind !== "installer") return json(response, 400, { error: "admin_file_kind_invalid" });
        const [files, downloads] = await Promise.all([
          adminObjectStore.list(kind),
          adminObjectStore.summarizeDownloads(new Date(0), new Date())
        ]);
        const countByName = new Map(downloads.byFile.map((item) => [item.fileName, item.total]));
        const data = files.map((file) => ({ ...file, downloads: countByName.get(file.name) ?? 0 }));
        return json(response, 200, { data, total: data.length });
      }
      const identity = parseAdminFileIdentity(url.searchParams.get("kind"), url.searchParams.get("name"));
      if (request.method === "POST") {
        const maximum = identity.kind === "appearance" ? 20 * 1024 * 1024 : 80 * 1024 * 1024;
        const body = await readBuffer(request, maximum);
        if (body.length === 0) return json(response, 400, { error: "admin_file_empty" });
        const contentType = identity.kind === "appearance" ? "application/zip"
          : identity.name.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/vnd.microsoft.portable-executable";
        const file = await adminObjectStore.put(identity.kind, identity.name, body, contentType);
        audit("file_uploaded", { kind: identity.kind, name: identity.name, bytes: body.length });
        return json(response, 201, { data: file });
      }
      if (request.method === "DELETE") {
        await adminObjectStore.delete(identity.kind, identity.name);
        audit("file_deleted", { kind: identity.kind, name: identity.name });
        return json(response, 200, { data: { id: `${identity.kind}:${identity.name}` } });
      }
      return json(response, 405, { error: "method_not_allowed" });
    }
    const publicDownloadMatch = url.pathname.match(/^\/api\/gongde\/downloads\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/u);
    if (request.method === "GET" && publicDownloadMatch) {
      if (!adminObjectStore) return json(response, 503, { error: "download_store_not_enabled" });
      const name = publicDownloadMatch[1];
      if (!/\.(?:dmg|exe)$/iu.test(name)) return json(response, 404, { error: "download_not_found" });
      const platform = name.endsWith(".dmg") ? "macos" : "windows";
      try { await adminObjectStore.recordDownload(name, platform, new Date()); }
      catch (error) { audit("download_count_failed", { name }); }
      response.writeHead(302, { location: adminObjectStore.publicUrl("installer", name), "cache-control": "no-store" });
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/access") {
      return json(response, 200, await service.getAccess(header(request, "x-gongde-access-code")));
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/access/orders") {
      const result = await service.listAccessOrders(header(request, "x-gongde-access-code"));
      return json(response, 200, { orders: result.orders.map(adminOrder) });
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/checkout") {
      if (mode === "disabled") return json(response, 503, { error: "payment_not_enabled" });
      const body = await readJson(request);
      const channel = body.channel;
      const purchaseKind = body.purchaseKind;
      if (mode === "live" && purchaseKind !== "support") {
        if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
        const ids = Array.isArray(body.assetIds) ? body.assetIds : [];
        const expected = body.previewRevisions;
        const revisions = await availableAppearanceRevisions();
        if (ids.length < 1 || ids.length > 10 || !expected || typeof expected !== "object" ||
            ids.some((id) => typeof id !== "string" || !revisions[id] ||
              (expected as Record<string, unknown>)[id] !== revisions[id])) {
          return json(response, 409, { error: "appearance_preview_outdated" });
        }
      }
      if (channel !== "wechat" && channel !== "alipay") return json(response, 400, { error: "invalid_channel" });
      if (purchaseKind !== "official-pass" && purchaseKind !== "asset-delivery" && purchaseKind !== "support") {
        return json(response, 400, { error: "invalid_purchase_kind" });
      }
      const input = {
        channel: channel as PaymentChannel,
        purchaseKind: purchaseKind as PurchaseKind,
        accessCode: purchaseKind === "asset-delivery" ? header(request, "x-gongde-access-code") : null,
        assetId: typeof body.assetId === "string" ? body.assetId : null,
        assetIds: Array.isArray(body.assetIds) ? body.assetIds.filter((item): item is string => typeof item === "string") : undefined,
        amountFen: typeof body.amountFen === "number" ? body.amountFen : undefined
      };
      if (mode === "mock") return json(response, 201, await service.createMockCheckout(input));
      return json(response, 201, await service.createLiveCheckout(input, async (order) => {
        if (channel === "wechat") {
          if (!wechatPay?.enabled) throw new Error("wechat_payment_not_enabled");
          const checkout = await wechatPay.createNativeOrder({ orderNo: order.orderNo, description: paymentDescription(order.purchaseKind), amountFen: order.amountFen, expiresAt: order.expiresAt });
          return { kind: "wechat-native", codeUrl: checkout.codeUrl, qrDataUrl: await toDataURL(checkout.codeUrl, { width: 260, margin: 1, errorCorrectionLevel: "M" }) };
        }
        if (!alipay?.enabled) throw new Error("alipay_not_enabled");
        const checkout = alipay.buildPagePaymentUrl({ orderNo: order.orderNo, subject: paymentDescription(order.purchaseKind), amountFen: order.amountFen, expiresAt: order.expiresAt });
        return { kind: "alipay-page", redirectUrl: checkout.redirectUrl };
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/payments/wechat/notify") {
      if (!wechatPay?.enabled) return json(response, 503, { code: "FAIL", message: "未启用" });
      const raw = await readBody(request, 1024 * 1024);
      const fact = wechatPay.verifyAndDecodeNotification(raw, {
        timestamp: header(request, "wechatpay-timestamp"), nonce: header(request, "wechatpay-nonce"),
        signature: header(request, "wechatpay-signature"), serial: header(request, "wechatpay-serial")
      });
      if (fact.tradeState !== "SUCCESS") throw new Error("wechat_payment_not_successful");
      if (fact.appId !== wechatPay.config.appId || fact.merchantId !== wechatPay.config.merchantId) {
        throw new Error("wechat_payment_identity_mismatch");
      }
      await service.completePayment({ orderNo: fact.orderNo, channel: "wechat", providerTransactionId: fact.transactionId, amountFen: fact.amountFen, paidAt: fact.paidAt });
      return json(response, 200, { code: "SUCCESS", message: "成功" });
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/payments/alipay/notify") {
      if (!alipay?.enabled) return json(response, 503, { error: "alipay_not_enabled" });
      const fact = alipay.verifyAndDecodeNotification(await readBody(request, 64 * 1024));
      if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(fact.tradeState)) {
        await service.completePayment({ orderNo: fact.orderNo, channel: "alipay", providerTransactionId: fact.transactionId, amountFen: fact.amountFen, paidAt: fact.paidAt });
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("success");
      return;
    }
    const payMatch = url.pathname.match(/^\/api\/gongde\/test\/orders\/([A-Z0-9]+)\/pay$/u);
    if (request.method === "POST" && payMatch) {
      if (mode !== "mock" || request.headers["x-gongde-test-token"] !== testToken) {
        return json(response, 404, { error: "not_found" });
      }
      return json(response, 200, await service.completeMockPayment(payMatch[1]));
    }
    const orderMatch = url.pathname.match(/^\/api\/gongde\/orders\/([A-Z0-9]+)$/u);
    if (request.method === "GET" && orderMatch) {
      return json(response, 200, await refreshPaidOrder(orderMatch[1], bearer(request)));
    }
    const packMatch = url.pathname.match(/^\/api\/gongde\/orders\/([A-Z0-9]+)\/package$/u);
    if (request.method === "GET" && packMatch) {
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      const token = bearer(request);
      const result = token
        ? await service.getOrder(packMatch[1], token)
        : await service.getOrderForAccess(packMatch[1], header(request, "x-gongde-access-code"));
      const now = new Date();
      const deliveries = result.entitlements.filter((item) =>
        item.scope === "asset-download" && item.state === "ACTIVE" && item.assetId && item.activatedAt && item.expiresAt && item.expiresAt > now
      );
      if (deliveries.length < 1) {
        return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      }
      const packs = deliveries.map((delivery) => packSigner.build({
        assetId: delivery.assetId!,
        downloadId: delivery.id,
        issuedAt: delivery.activatedAt!,
        expiresAt: delivery.expiresAt!
      }));
      const multiple = packs.length > 1;
      const content = multiple
        ? Buffer.from(zipSync(Object.fromEntries(packs.map((pack) => [pack.filename, pack.content])), { level: 0 }))
        : packs[0].content;
      const filename = multiple ? `niuma-appearance-packs-${packMatch[1]}.zip` : packs[0].filename;
      const importBefore = deliveries.reduce((earliest, item) => item.expiresAt! < earliest ? item.expiresAt! : earliest, deliveries[0].expiresAt!);
      response.writeHead(200, {
        "content-type": multiple ? "application/zip" : "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(content.length),
        "cache-control": "private, no-store",
        "x-gongde-import-before": importBefore.toISOString(),
        "x-gongde-pack-count": String(packs.length)
      });
      response.end(content);
      return;
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message === "admin_auth_required" || message === "admin_invalid_credentials" ? 401
      : message === "admin_login_rate_limited" ? 429
      : message === "admin_not_enabled" ? 503
      : message === "order_access_denied" ? 403
      : message === "access_code_invalid" ? 401
      : message === "order_not_found" ? 404
        : message.includes("not_enabled") ? 503
          : error instanceof WechatPayError || error instanceof AlipayError ? 502
            : 400;
    const publicMessage = error instanceof WechatPayError || error instanceof AlipayError ? error.code : message;
    return json(response, status, { error: publicMessage });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`gongde-payments listening on ${host}:${port} mode=${mode}\n`);
});

server.on("close", () => { void store.close(); });
