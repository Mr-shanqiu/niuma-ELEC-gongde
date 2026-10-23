import { ORDER_STATES } from "./domain/store.js";
import { createFreeCreatorRuntime } from "./creators/runtime.js";
import { createFreeDistributionRuntime } from "./free-distribution/runtime.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { GongdeOrderService, type MarketCheckoutItem } from "./domain/order-service.js";
import { CreatorError } from "./creators/types.js";
import { MARKET_BATCH_BYTES } from "./creators/policy.js";
import { InMemoryPaymentStore } from "./domain/store.js";
import type { PaymentStore } from "./domain/store.js";
import { loadGongdeMySqlConfiguration, MySqlPaymentStore } from "./storage/mysql-store.js";
import { AppearancePackSigner, loadPackSignerConfiguration } from "./delivery/pack-signer.js";
import { PrivatePackageStore, loadPrivatePackageConfiguration, appearanceDownloadFilename, downloadDisposition } from "./delivery/private-package-store.js";
import type { MarketOrderItem, PaymentChannel, PurchaseKind } from "./domain/types.js";
import { WechatPayNativeClient } from "./payments/providers/wechat-native/native.js";
import { parseWechatPayRuntimeConfiguration } from "./payments/providers/wechat-native/runtimeConfig.js";
import { WechatPayError } from "./payments/providers/wechat-native/types.js";
import { AlipayPageClient } from "./payments/providers/alipay-page/client.js";
import { parseAlipayRuntimeConfiguration } from "./payments/providers/alipay-page/runtimeConfig.js";
import { AlipayError } from "./payments/providers/alipay-page/types.js";
import { toDataURL } from "qrcode";
import { zipSync } from "fflate";
import { AdminAuthService, loadAdminAuthConfiguration } from "./admin/auth.js";
import { AdminObjectStore, PublicationBusy, PublicationConflict, PublicationUnavailable, loadAdminObjectStoreConfiguration, parseAdminFileIdentity } from "./admin/object-store.js";
import { createPublicationLock } from "./admin/publication-lock.js";
import { loadDownloadCoverage, loadInstallerRegistry } from "./downloads/installer-registry.js";
import type { GongdeEntitlement, GongdeOrder, OrderState } from "./domain/types.js";
import { MAX_ASSETS_PER_DELIVERY, OFFICIAL_ASSET_IDS, OFFICIAL_ASSET_NAMES_ZH } from "./domain/catalog.js";
import { AppearanceNumberError, AppearanceNumberRepository } from "./domain/appearance-numbers.js";
import { queryAppearanceNumber, type OfficialAppearanceState } from "./domain/appearance-number-query.js";
import { GROUP_BENEFIT_PERIOD_DAYS, GROUP_BENEFIT_TIME_ZONE, loadGroupBenefitCodeService } from "./domain/group-benefit-code.js";
import { CheckoutIdempotency, CheckoutRequestError, prepareCheckoutRequest } from "./routes/checkout-idempotency.js";

const mode = process.env.GONGDE_PAYMENT_MODE ?? "disabled";
if (!new Set(["disabled", "mock", "live"]).has(mode)) throw new Error("invalid_payment_mode");
const testToken = process.env.GONGDE_PAYMENT_TEST_TOKEN ?? "";
if (mode === "mock" && testToken.length < 24) throw new Error("mock_mode_requires_strong_test_token");
const packMode = process.env.GONGDE_PACK_DELIVERY_MODE ?? "disabled";
if (packMode !== "disabled" && packMode !== "local") throw new Error("invalid_pack_delivery_mode");

const storeMode = process.env.GONGDE_STORE_MODE ?? "memory";
if (storeMode !== "memory" && storeMode !== "mysql") throw new Error("invalid_store_mode");
if (mode === "live" && storeMode !== "mysql") throw new Error("live_payment_requires_mysql_store");
const mysqlConfiguration = storeMode === "mysql" ? loadGongdeMySqlConfiguration() : null;
const appearanceNumbers = mysqlConfiguration ? new AppearanceNumberRepository(mysqlConfiguration) : null;
const store: PaymentStore = mysqlConfiguration
  ? MySqlPaymentStore.connect(mysqlConfiguration)
  : new InMemoryPaymentStore();
const service = new GongdeOrderService(store);
const checkoutRequests = new CheckoutIdempotency<Omit<Awaited<ReturnType<GongdeOrderService["createMockCheckout"]>>, "accessCode">>({
  database: mysqlConfiguration, allowMemory: mode === "mock" && storeMode === "memory"
});
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
// The publication object is the only place where two administrators can lose
// each other's write, so its lock exists whenever the object store does.
const publicationLockHandle = adminObjectStoreConfiguration
  ? createPublicationLock(mysqlConfiguration)
  : null;
const publicationLock = publicationLockHandle?.lock ?? null;
const privatePackageConfiguration = loadPrivatePackageConfiguration();
const privatePackageStore = privatePackageConfiguration ? new PrivatePackageStore(privatePackageConfiguration) : null;
if (packSigner) setImmediate(() => {
  try { packSigner.prepareAssets(); }
  catch { audit("pack_source_prepare_failed"); }
});

const MAX_PACKAGE_CACHE_BYTES = 64 * 1024 * 1024;
const packageCache = new Map<string, {
  key: string;
  content: Buffer;
  count: number;
  singleFilename: string;
  importBefore: Date;
}>();
const scheduledPackages = new Set<string>();
let packageCacheBytes = 0;
const nativeDownloads = new Map<string, {
  orderNo: string;
  buyerToken: string;
  expiresAt: number;
}>();
const NATIVE_DOWNLOAD_TTL_MS = 120_000;
const MAX_NATIVE_DOWNLOADS = 256;

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

function adminDateRange(url: URL, defaults: true): {from: Date; to: Date};
function adminDateRange(url: URL, defaults: false): {from?: Date; to?: Date};
function adminDateRange(url: URL, defaults: boolean) {
  const from = parseDate(url.searchParams.get("from"), "from"), to = parseDate(url.searchParams.get("to"), "to");
  if (Boolean(from) !== Boolean(to) || (from && to && (from >= to || to.getTime() - from.getTime() > 366 * 86400000))) {
    throw new Error("invalid_date_range");
  }
  return defaults ? {from: from ?? new Date(Date.now()-86400000), to: to ?? new Date()} : {from, to};
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
    : kind === "appearance-batch" ? "牛马电子功德-本次形象包"
      : kind === "asset-delivery" ? "牛马电子功德-形象包生成"
      : "牛马电子功德-自愿赞赏";
}

async function paymentConfiguration() {
  const signerReady = packSigner !== null;
  const idempotency = await checkoutRequests.configuration();
  const paymentChannels = {
    wechat: idempotency.ready && signerReady && (mode === "mock" || (mode === "live" && Boolean(wechatPay?.enabled))),
    alipay: idempotency.ready && signerReady && (mode === "mock" || (mode === "live" && Boolean(alipay?.enabled)))
  };
  return { mode, unitPriceFen: 100, maxItems: 10, purchaseKind: "appearance-batch",
    enabled: paymentChannels.wechat || paymentChannels.alipay, paymentChannels, signerReady,
    licenseMode: "perpetual", importExpiresAt: null,
    idempotency };
}

function currentBuyerToken(request: IncomingMessage): string {
  if (Object.hasOwn(request.headers, "x-gongde-access-code")) {
    throw new CheckoutRequestError("legacy_access_not_supported", 400);
  }
  const token = bearer(request);
  if (!token) throw new CheckoutRequestError("buyer_token_required", 401);
  return token;
}

async function currentOrder(orderNo: string, buyerToken: string) {
  if (!buyerToken) throw new CheckoutRequestError("buyer_token_required", 401);
  const result = await service.getOrder(orderNo, buyerToken);
  if (result.order.productVersion !== 2 || result.order.purchaseKind !== "appearance-batch" ||
      result.order.assetIds.some(id => !OFFICIAL_ASSET_IDS.includes(id as typeof OFFICIAL_ASSET_IDS[number]))) {
    throw new CheckoutRequestError("legacy_order_retired", 410);
  }
  return result;
}

function publicCurrentOrder(result: Awaited<ReturnType<typeof currentOrder>>) {
  const order = result.order;
  return { order: {
    orderNo: order.orderNo, productId: order.productId, productVersion: order.productVersion,
    channel: order.channel, purchaseKind: order.purchaseKind, assetId: order.assetId,
    assetIds: order.assetIds, amountFen: order.amountFen, currency: order.currency, state: order.state,
    createdAt: order.createdAt.toISOString(), expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null, fulfilledAt: order.fulfilledAt?.toISOString() ?? null
  }, entitlements: result.entitlements.map(item => ({
    id: item.id, scope: item.scope, assetId: item.assetId, state: item.state,
    activatedAt: item.activatedAt?.toISOString() ?? null, expiresAt: item.expiresAt?.toISOString() ?? null
  })), licenseMode: "perpetual", importExpiresAt: null };
}

function activePackDeliveries(entitlements: GongdeEntitlement[], now = new Date()): GongdeEntitlement[] {
  return entitlements.filter((item) => item.scope === "asset-download" && item.state === "ACTIVE"
    && item.assetId && item.activatedAt && item.expiresAt && item.expiresAt > now);
}

async function paidMarketItems(orderNo: string, deliveries: GongdeEntitlement[]): Promise<MarketOrderItem[]> {
  const items = await store.findMarketOrderItemsByOrder(orderNo);
  // Historical official orders predate market snapshots; new official-only
  // batches must use their frozen snapshots just like mixed batches.
  if (items.length === 0 && !deliveries.some(item => item.assetId?.startsWith("creator."))) return [];
  if (items.length !== deliveries.length || new Set(items.map(item => item.assetId)).size !== items.length ||
      items.some(item => !deliveries.some(delivery => delivery.assetId === item.assetId))) {
    throw new CreatorError("market_order_snapshot_missing", 503);
  }
  const communityItems = items.filter(item => item.sourceKind === "community");
  if (communityItems.length > 0) await creatorRuntime.authorizePaidItems(communityItems);
  return items;
}

async function preparedPackage(orderNo: string, deliveries: GongdeEntitlement[]) {
  if (!packSigner || deliveries.length < 1) throw new Error("pack_delivery_expired_or_missing");
  const marketItems = await paidMarketItems(orderNo, deliveries);
  const byAsset = new Map(marketItems.map(item => [item.assetId, item]));
  const revisions = packSigner.revisions();
  const key = "perpetual-v2|" + deliveries.map((item) => `${item.id}:${item.assetId}:${byAsset.get(item.assetId!)?.sourceRevision ?? revisions[item.assetId!] ?? "missing"}:${item.activatedAt!.toISOString()}:${item.expiresAt!.toISOString()}`).sort().join("|");
  const cached = packageCache.get(orderNo);
  if (cached?.key === key) {
    packageCache.delete(orderNo);
    packageCache.set(orderNo, cached);
    return cached;
  }
  if (cached) {
    packageCache.delete(orderNo);
    packageCacheBytes -= cached.content.length;
  }
  const packs: ReturnType<AppearancePackSigner["build"]>[] = [];
  for (const delivery of deliveries) {
    const item = byAsset.get(delivery.assetId!);
    if (item?.sourceKind === "community") {
      packs.push(await creatorRuntime.buildPaidPack(item, delivery, packSigner));
    } else {
      if (item && revisions[item.assetId] !== item.sourceRevision) {
        throw new CreatorError("market_order_source_unavailable", 503);
      }
      packs.push(packSigner.build({ licenseMode: "perpetual", assetId: delivery.assetId!, downloadId: delivery.id,
        issuedAt: delivery.activatedAt!, expiresAt: delivery.expiresAt! }));
    }
  }
  const content = packs.length > 1
    ? Buffer.from(zipSync(Object.fromEntries(packs.map((pack) => [pack.filename, pack.content])), { level: 0 }))
    : packs[0].content;
  if (marketItems.length > 0) {
    if (content.length > MARKET_BATCH_BYTES) throw new CreatorError("market_batch_delivery_too_large", 413);
    const communityItems = marketItems.filter(item => item.sourceKind === "community");
    if (communityItems.length > 0) await creatorRuntime.authorizePaidItems(communityItems);
  }
  // Internal storage/cache deadline only; never a local perpetual-license deadline.
  const importBefore = deliveries.reduce((earliest, item) => item.expiresAt! < earliest ? item.expiresAt! : earliest, deliveries[0].expiresAt!);
  const prepared = { key, content, count: packs.length, singleFilename: packs[0].filename, importBefore };
  if (content.length <= MAX_PACKAGE_CACHE_BYTES) {
    // Another async request may have completed the same order while COS was read.
    const previous = packageCache.get(orderNo);
    if (previous) {
      packageCache.delete(orderNo);
      packageCacheBytes -= previous.content.length;
    }
    while (packageCacheBytes + content.length > MAX_PACKAGE_CACHE_BYTES) {
      const oldestKey = packageCache.keys().next().value;
      if (!oldestKey) break;
      packageCacheBytes -= packageCache.get(oldestKey)!.content.length;
      packageCache.delete(oldestKey);
    }
    packageCache.set(orderNo, prepared);
    packageCacheBytes += content.length;
  }
  return prepared;
}

function privatePackageInput(orderNo: string, prepared: Awaited<ReturnType<typeof preparedPackage>>) {
  return {
    orderNo,
    identity: prepared.key,
    content: prepared.content,
    filename: prepared.count > 1 ? `niuma-appearance-packs-${orderNo}.nmgpacks` : prepared.singleFilename,
    count: prepared.count,
    importBefore: prepared.importBefore
  };
}

function schedulePackagePreparation(orderNo: string, entitlements: GongdeEntitlement[]): void {
  if (!packSigner || scheduledPackages.has(orderNo)) return;
  const deliveries = activePackDeliveries(entitlements);
  if (deliveries.length < 1) return;
  scheduledPackages.add(orderNo);
  setImmediate(async () => {
    try {
      const prepared = await preparedPackage(orderNo, deliveries);
      if (privatePackageStore) await privatePackageStore.prepare(privatePackageInput(orderNo, prepared));
    }
    catch { audit("package_prepare_failed", { orderNo }); }
    finally { scheduledPackages.delete(orderNo); }
  });
}

async function refreshPaidOrder(orderNo: string, buyerToken: string) {
  let result = await currentOrder(orderNo, buyerToken);
  if (mode !== "live" || result.order.state !== "PENDING_PAYMENT") {
    if (result.order.state === "FULFILLED") schedulePackagePreparation(result.order.orderNo, result.entitlements);
    return result;
  }
  try {
    if (result.order.channel === "wechat" && wechatPay?.enabled) {
      const queryWechat = async () => {
        const state = await wechatPay.queryOrder(orderNo);
        if (state.appId !== wechatPay.config.appId || state.merchantId !== wechatPay.config.merchantId ||
            state.amountFen !== result.order.amountFen || state.currency !== result.order.currency)
          throw new CheckoutRequestError("payment_status_unconfirmed", 503);
        return state;
      };
      let state = await queryWechat();
      if (state.tradeState === "NOTPAY" && result.order.expiresAt.getTime() <= Date.now()) {
        try { await wechatPay.closeOrder(orderNo); }
        catch (error) { if (!(error instanceof WechatPayError)) throw error; }
        // A close timeout or concurrent payment is not evidence of closure.
        state = await queryWechat();
      }
      if (state.tradeState === "SUCCESS" && state.transactionId && state.paidAt) {
        await service.completePayment({ orderNo, channel: "wechat", providerTransactionId: state.transactionId, amountFen: state.amountFen, paidAt: state.paidAt });
      } else if (state.tradeState === "CLOSED") {
        await service.confirmUnpaidClosure(orderNo, "wechat");
      }
    } else if (result.order.channel === "alipay" && alipay?.enabled) {
      const queryAlipay = async () => {
        const state = await alipay.queryOrder(orderNo);
        if (state.appId !== alipay.config.appId || state.sellerId !== alipay.config.sellerId ||
            state.currency !== result.order.currency ||
            (state.tradeState !== "NOT_EXIST" && state.amountFen !== result.order.amountFen))
          throw new CheckoutRequestError("payment_status_unconfirmed", 503);
        return state;
      };
      let state = await queryAlipay();
      if (state.tradeState === "WAIT_BUYER_PAY" && result.order.expiresAt.getTime() <= Date.now()) {
        try { await alipay.closeOrder(orderNo); }
        catch (error) { if (!(error instanceof AlipayError)) throw error; }
        state = await queryAlipay();
      }
      if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(state.tradeState) && state.transactionId && state.paidAt) {
        await service.completePayment({ orderNo, channel: "alipay", providerTransactionId: state.transactionId, amountFen: state.amountFen, paidAt: state.paidAt });
      } else if (state.tradeState === "TRADE_CLOSED") {
        await service.confirmUnpaidClosure(orderNo, "alipay");
      }
      // NOT_EXIST is not a confirmed closure of a signed page-payment URL.
    } else {
      throw new CheckoutRequestError("payment_status_unconfirmed", 503);
    }
    result = await currentOrder(orderNo, buyerToken);
    if (result.order.state === "FULFILLED") schedulePackagePreparation(result.order.orderNo, result.entitlements);
  } catch (error) {
    if (!(error instanceof WechatPayError) && !(error instanceof AlipayError)) throw error;
    throw new CheckoutRequestError("payment_status_unconfirmed", 503);
  }
  return result;
}

const creatorRuntime = createFreeCreatorRuntime(requireAdmin, mode !== "disabled" && packSigner !== null);

async function numberedOfficialStates(): Promise<Record<string, OfficialAppearanceState>> {
  if (!packSigner || !adminObjectStore) throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
  try {
    const publication = await adminObjectStore.publicationStateStrict(OFFICIAL_ASSET_IDS);
    const published = new Set(publication.publishedAssetIds);
    const revisions = packSigner.revisions();
    return Object.fromEntries(OFFICIAL_ASSET_IDS.map(assetId => [assetId, {
      revision: revisions[assetId] ?? null,
      firstPublishedAt: publication.firstPublishedAt[assetId] ?? null,
      state: !revisions[assetId] ? "MISSING" : published.has(assetId) ? "PUBLISHED" : "UNPUBLISHED"
    }]));
  } catch { throw new AppearanceNumberError("appearance_numbers_unavailable", 503); }
}

async function optionalOfficialNumbers(): Promise<Record<string, string>> {
  try { return appearanceNumbers ? await appearanceNumbers.officialNumbers(OFFICIAL_ASSET_IDS) : {}; }
  catch { return {}; } // No fabricated number, and no new dependency for existing purchases/publication.
}

const freeDistributionRuntime = createFreeDistributionRuntime({ database: mysqlConfiguration,
  signer: packSigner, packages: privatePackageStore, creators: creatorRuntime,
  numbers: appearanceNumbers, officialStates: numberedOfficialStates, requireAdmin });

export const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (/^\/api\/gongde\/(?:access(?:\/|$)|entitlements?(?:\/|$)|history(?:\/|$)|support(?:\/|$)|orders\/?$)/u.test(url.pathname) ||
        /^\/api\/gongde\/orders\/[^/]+\/package\/?$/u.test(url.pathname)) {
      return json(response, 410, { error: "legacy_public_flow_retired" });
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/payment-config") {
      return json(response, 200, await paymentConfiguration());
    }
    if (await freeDistributionRuntime.handle(request, response, url)) return;
    if (await creatorRuntime.handle(request, response, url)) return;
    if (request.method === "GET" && (url.pathname === "/api/gongde/appearance-numbers" ||
        url.pathname === "/api/gongde/admin/appearance-numbers")) {
      const admin = url.pathname.startsWith("/api/gongde/admin/");
      if (admin) requireAdmin(request);
      if (!appearanceNumbers) throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
      const number = url.searchParams.get("number");
      if (number !== null) {
        const item = await queryAppearanceNumber(number, {
          find: value => appearanceNumbers.find(value),
          officialState: async assetId => (await numberedOfficialStates())[assetId],
          communityWork: (workId, allowedAdmin) => creatorRuntime.numberWork(workId, allowedAdmin)
        }, admin);
        return json(response, 200, { appearance: item });
      }
      if (admin) throw new AppearanceNumberError("appearance_number_invalid", 400);
      const states = await numberedOfficialStates();
      const publishedIds = OFFICIAL_ASSET_IDS.filter(assetId => states[assetId].state === "PUBLISHED");
      const numbers = await appearanceNumbers.officialNumbers(publishedIds);
      return json(response, 200, { appearances: publishedIds.map(internalId => ({
        appearanceNumber: numbers[internalId], sourceKind: "official", internalId,
        titleZh: OFFICIAL_ASSET_NAMES_ZH[internalId], state: "PUBLISHED",
        sharePath: `/index.html?number=${numbers[internalId]}#characters`
      })) });
    }
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
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/group-benefit-code") {
      requireAdmin(request);
      const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };
      try {
        const groupCodes = loadGroupBenefitCodeService();
        if (!groupCodes) return json(response, 200, {
          status: "disabled", code: null, periodDays: GROUP_BENEFIT_PERIOD_DAYS,
          timeZone: GROUP_BENEFIT_TIME_ZONE, serverTime: new Date().toISOString(),
          redemptionEnabled: false,
        }, headers);
        // Generation is ready independently of redemption. Do not claim that
        // a code unlocks downloads before the separate grant flow is connected.
        return json(response, 200, { ...groupCodes.current(), redemptionEnabled: false }, headers);
      } catch {
        return json(response, 503, { error: "group_benefit_code_unavailable" }, headers);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/download-report") {
      requireAdmin(request);
      const { from, to } = adminDateRange(url, true);
      const registry = loadInstallerRegistry();
      const coverage = loadDownloadCoverage();
      const countedSince = coverage.startedAt ? new Date(coverage.startedAt) : null;
      const base = {
        coverage: {
          status: coverage.status,
          startedAt: coverage.startedAt,
          entries: coverage.entries,
          // Static configuration describes intent only; it is not evidence that
          // collection is working. The status below is the evidence.
          scopeNote: "只统计官网下载页入口的请求；CDN 直链、GitHub 与转发安装包不在范围内。"
        },
        registry: {
          status: registry.status,
          items: registry.items.map((item) => ({
            name: item.name, platform: item.platform, version: item.version, releaseId: item.releaseId,
            bytes: item.bytes, sha256: item.sha256, countedUrl: `/api/gongde/downloads/${encodeURIComponent(item.name)}`
          }))
        },
        range: { from: from.toISOString(), to: to.toISOString() }
      };
      if (!adminObjectStore) {
        // Not counting is a distinct state from counting zero. Saying "0" here
        // would read as "nobody downloaded".
        return json(response, 200, { ...base, status: "unavailable", error: "download_store_not_enabled", summary: null }, { "cache-control": "private, no-store" });
      }
      try {
        const summary = await adminObjectStore.summarizeDownloads(from, to, {
          countedSince,
          registeredNames: registry.items.map((item) => item.name)
        });
        return json(response, 200, { ...base, status: "available", summary }, { "cache-control": "private, no-store" });
      } catch {
        // A read failure is not an empty period.
        return json(response, 200, { ...base, status: "error", error: "download_summary_unavailable", summary: null }, { "cache-control": "private, no-store" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/overview") {
      requireAdmin(request);
      const { from, to } = adminDateRange(url, true);
      const [selectedDay, allTime, downloads, recent, storeReady] = await Promise.all([
        store.summarizeOrders(from, to),
        store.summarizeOrders(new Date(0), new Date()),
        // Never substitute a zero object here: a missing store or a failed read
        // must reach the page as "unavailable", not as "nobody downloaded".
        adminObjectStore
          ? adminObjectStore.summarizeDownloads(from, to, {
              countedSince: (() => { const startedAt = loadDownloadCoverage().startedAt; return startedAt ? new Date(startedAt) : null; })(),
              registeredNames: loadInstallerRegistry().items.map((item) => item.name)
            }).then((summary) => ({ status: "available" as const, summary }))
              .catch(() => ({ status: "error" as const, summary: null }))
          : Promise.resolve({ status: "unconfigured" as const, summary: null }),
        store.listOrders({ createdFrom: from, createdTo: to, limit: 6, offset: 0 }),
        store.ready()
      ]);
      return json(response, 200, {
        periods: { selectedDay, allTime },
        range: { from: from.toISOString(), to: to.toISOString() },
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
      const validStates = new Set<OrderState>(ORDER_STATES);
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
      const effective = url.searchParams.get("effectiveOnly");
      if (effective !== null && effective !== "true" && effective !== "false") return json(response, 400, { error: "invalid_state" });
      const dateRange = adminDateRange(url, false);
      const result = await store.listOrders({
        orderNo: orderNo || undefined,
        userId: accessId,
        createdFrom: dateRange.from,
        createdTo: dateRange.to,
        channel: channel as "wechat" | "alipay" | undefined,
        state: state as OrderState | undefined,
        effectiveOnly: effective === "true",
        limit: perPage,
        offset: (page - 1) * perPage
      });
      return json(response, 200, { data: result.orders.map(adminOrder), total: result.total });
    }
    const adminOrderMatch = url.pathname.match(/^\/api\/gongde\/admin\/orders\/([A-Z0-9_]+)$/u);
    if (request.method === "GET" && adminOrderMatch) {
      requireAdmin(request);
      const order = await store.findOrder(adminOrderMatch[1]);
      if (!order) return json(response, 404, { error: "order_not_found" });
      const [entitlements, marketItems] = await Promise.all([
        store.findEntitlementsByOrder(order.orderNo),
        store.findMarketOrderItemsByOrder(order.orderNo)
      ]);
      audit("order_viewed", { orderNo: order.orderNo });
      return json(response, 200, { data: { ...adminOrder(order), entitlements: entitlements.map(adminEntitlement), marketItems } });
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/admin/appearances") {
      requireAdmin(request);
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      const revisions = packSigner.revisions();
      // A read failure must reach the page as a failure. The historic purchase
      // path keeps its "fall back to the default list" behaviour, but this list
      // also hands the page a version to write with: reporting revision 0 and
      // everything published would show state nobody read and enable an action
      // whose only possible outcome is a 503.
      let publication;
      try {
        publication = adminObjectStore
          ? await adminObjectStore.publicationStateForAdmin(OFFICIAL_ASSET_IDS)
          : { revision: 0, publishedAssetIds: [...OFFICIAL_ASSET_IDS], firstPublishedAt: {}, updatedAt: null };
      } catch (error) {
        if (error instanceof PublicationUnavailable) {
          return json(response, 503, { error: "appearance_publication_unavailable" });
        }
        throw error;
      }
      const publishedIds = new Set(publication.publishedAssetIds);
      const numbers = await optionalOfficialNumbers();
      const data = OFFICIAL_ASSET_IDS.map((assetId) => ({
        id: assetId,
        assetId,
        appearanceNumber: numbers[assetId] ?? null,
        name: OFFICIAL_ASSET_NAMES_ZH[assetId] ?? assetId,
        revision: revisions[assetId] ?? null,
        state: !revisions[assetId] ? "MISSING" : publishedIds.has(assetId) ? "PUBLISHED" : "UNPUBLISHED"
      }));
      // `publicationRevision` versions the whole published set. Every write must
      // send it back; it is deliberately not named `revision`, which already
      // means the material version on each row.
      return json(response, 200, { data, total: data.length, publicationRevision: publication.revision });
    }
    const adminAppearanceMatch = url.pathname.match(/^\/api\/gongde\/admin\/appearances\/([A-Za-z0-9._-]+)$/u);
    if (request.method === "PATCH" && adminAppearanceMatch) {
      requireAdmin(request);
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      if (!adminObjectStore) return json(response, 503, { error: "admin_object_store_not_enabled" });
      if (!publicationLock) return json(response, 503, { error: "appearance_publication_unavailable" });
      const assetId = adminAppearanceMatch[1];
      if (!OFFICIAL_ASSET_IDS.includes(assetId as typeof OFFICIAL_ASSET_IDS[number])) return json(response, 404, { error: "appearance_not_found" });
      const body = await readJson(request);
      if (typeof body.published !== "boolean") return json(response, 400, { error: "invalid_appearance_state" });
      if (!Number.isSafeInteger(body.publicationRevision) || (body.publicationRevision as number) < 0) {
        // Refusing an unversioned write is the point: without it the write would
        // silently overwrite whatever another session changed in the meantime.
        return json(response, 400, { error: "appearance_publication_revision_required" });
      }
      const revisions = packSigner.revisions();
      if (!revisions[assetId]) return json(response, 409, { error: "appearance_resource_missing" });
      let next;
      try {
        next = await adminObjectStore.setPublished(
          OFFICIAL_ASSET_IDS, assetId, body.published, body.publicationRevision as number, publicationLock
        );
      } catch (error) {
        if (error instanceof PublicationConflict) {
          return json(response, 409, { error: "appearance_publication_conflict", publicationRevision: error.revision });
        }
        if (error instanceof PublicationBusy) return json(response, 409, { error: "appearance_publication_busy" });
        if (error instanceof PublicationUnavailable) {
          return json(response, 503, { error: "appearance_publication_unavailable" });
        }
        throw error;
      }
      const numbers = await optionalOfficialNumbers();
      audit(body.published ? "appearance_published" : "appearance_unpublished", { assetId, revision: next.revision });
      return json(response, 200, { data: {
        id: assetId,
        assetId,
        appearanceNumber: numbers[assetId] ?? null,
        name: OFFICIAL_ASSET_NAMES_ZH[assetId] ?? assetId,
        revision: revisions[assetId],
        state: body.published ? "PUBLISHED" : "UNPUBLISHED"
      }, publicationRevision: next.revision });
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
        // Retain installers even when the free-distribution router is disabled.
        if (identity.kind === "installer") {
          response.setHeader("Cache-Control", "private, no-store");
          return json(response, 409, { error: "installer_retention_required" });
        }
        await adminObjectStore.delete(identity.kind, identity.name);
        audit("file_deleted", { kind: identity.kind, name: identity.name });
        return json(response, 200, { data: { id: `${identity.kind}:${identity.name}` } });
      }
      return json(response, 405, { error: "method_not_allowed" });
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/admin/download-manifest") {
      requireAdmin(request);
      if (!adminObjectStore) return json(response, 503, { error: "admin_object_store_not_enabled" });
      const version = url.searchParams.get("version") ?? "";
      const windowsVersion = url.searchParams.get("windowsVersion") ?? version;
      if (!/^\d+\.\d+\.\d+$/u.test(version) || !/^\d+\.\d+\.\d+$/u.test(windowsVersion)) return json(response, 400, { error: "admin_release_version_invalid" });
      const data = await adminObjectStore.publishInstallerManifest(version, windowsVersion);
      audit("download_manifest_published", { version, windowsVersion });
      return json(response, 200, { data });
    }
    const publicDownloadMatch = url.pathname.match(/^\/api\/gongde\/downloads\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/u);
    if (request.method === "GET" && publicDownloadMatch) {
      if (!adminObjectStore) return json(response, 503, { error: "download_store_not_enabled" });
      const name = publicDownloadMatch[1];
      // Only a file that is currently registered can be counted or forwarded.
      // The old check accepted any .dmg/.exe name, so an unregistered file was
      // counted and then redirected to the CDN, where it 404s. The target now
      // comes from the registry entry, never from the request path.
      const registry = loadInstallerRegistry();
      if (registry.status !== "available") return json(response, 503, { error: "download_registry_unavailable" }, { "cache-control": "no-store" });
      const entry = registry.items.find((item) => item.name === name);
      if (!entry) return json(response, 404, { error: "download_not_found" }, { "cache-control": "no-store" });
      let counted = true;
      try { await adminObjectStore.recordDownload(entry.name, entry.platform, new Date()); }
      catch (error) { counted = false; audit("download_count_failed", { name: entry.name }); }
      // A counting failure must not block the download itself. The redirect is
      // no-store in both cases so no cache can skip the next count.
      response.writeHead(302, {
        location: entry.publicDownloadUrl,
        "cache-control": "no-store",
        ...(counted ? {} : { "x-gongde-count": "failed" })
      });
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/checkout") {
      const legacyAccessHeader = Object.hasOwn(request.headers, "x-gongde-access-code");
      let rawBody = "";
      let tooLarge = false;
      try { rawBody = await readBody(request); }
      catch (error) {
        if (error instanceof Error && error.message === "request_too_large") tooLarge = true;
        else throw new CheckoutRequestError("checkout_request_unreadable", 400);
      }
      const preparedRequest = prepareCheckoutRequest(rawBody, legacyAccessHeader, tooLarge);
      const checkout = await checkoutRequests.run(header(request, "idempotency-key"), preparedRequest.fingerprint, async () => {
        // No safe validation rejection can bypass the durable reservation or
        // replay/conflict gate, including malformed JSON and legacy headers.
        if (tooLarge) throw new CheckoutRequestError("request_too_large", 413);
        if (legacyAccessHeader) throw new CheckoutRequestError("legacy_access_not_supported", 400, true);
        const raw = preparedRequest.body;
        if (preparedRequest.invalidBody || !raw || typeof raw !== "object" || Array.isArray(raw) ||
            Object.keys(raw).some(key => !["channel", "purchaseKind", "assetIds", "previewRevisions"].includes(key))) {
          throw new CheckoutRequestError("invalid_checkout_request", 400, true);
        }
        const body = raw as Record<string, unknown>;
        const channel = body.channel;
        const purchaseKind = body.purchaseKind;
        if (channel !== "wechat" && channel !== "alipay") throw new CheckoutRequestError("invalid_channel", 400, true);
        if (purchaseKind !== "appearance-batch") throw new CheckoutRequestError("invalid_purchase_kind", 400, true);
        const ids = Array.isArray(body.assetIds) ? body.assetIds : [];
        if (ids.length < 1 || ids.length > Math.min(10, MAX_ASSETS_PER_DELIVERY) || new Set(ids).size !== ids.length ||
            ids.some(id => typeof id !== "string" || !OFFICIAL_ASSET_IDS.includes(id as typeof OFFICIAL_ASSET_IDS[number]))) {
          throw new CheckoutRequestError("official_asset_selection_invalid", 400, true);
        }
        const expected = body.previewRevisions;
        if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
            Object.keys(expected).length !== ids.length || ids.some(id =>
              !Object.hasOwn(expected, id) || typeof (expected as Record<string, unknown>)[id] !== "string" ||
              !/^[a-f0-9]{64}$/u.test((expected as Record<string, string>)[id]))) {
          throw new CheckoutRequestError("preview_revisions_required", 400, true);
        }
        const configuration = await paymentConfiguration();
        if (!configuration.idempotency.ready) {
          throw new CheckoutRequestError(configuration.idempotency.error ?? "checkout_idempotency_unavailable", 503);
        }
        if (!configuration.enabled) throw new CheckoutRequestError("payment_not_enabled", 503);
        if (!configuration.paymentChannels[channel]) throw new CheckoutRequestError("payment_channel_not_enabled", 503);
        const revisions = await availableAppearanceRevisions();
        if (ids.some(id => !Object.hasOwn(revisions, id) || (expected as Record<string, string>)[id] !== revisions[id])) {
          throw new CheckoutRequestError("appearance_preview_outdated", 409, true);
        }
        let deliveryBytes = 512 + ids.length * 256;
        const sources = packSigner!.officialCatalog();
        const marketItems: MarketCheckoutItem[] = ids.map((id: string) => {
          const source = sources[id];
          if (!source || source.revision !== revisions[id]) throw new CheckoutRequestError("appearance_preview_outdated", 409, true);
          deliveryBytes += source.deliveryBytesUpperBound;
          return { sourceKind: "official", assetId: id, creatorId: null, workId: null,
            versionId: null, versionLabel: source.version, sourceRevision: source.revision,
            titleZh: OFFICIAL_ASSET_NAMES_ZH[id], unitPriceFen: 100, revenueRuleVersion: null };
        });
        if (!Number.isSafeInteger(deliveryBytes) || deliveryBytes > MARKET_BATCH_BYTES) {
          throw new CheckoutRequestError("market_batch_delivery_too_large", 413);
        }
        const input = { channel: channel as PaymentChannel, purchaseKind: "appearance-batch" as const,
          assetIds: ids as string[], marketItems };
        const result = mode === "mock" ? await service.createMockCheckout(input)
          : await service.createLiveCheckout(input, async order => {
            if (channel === "wechat") {
              if (!wechatPay?.enabled) throw new Error("wechat_payment_not_enabled");
              const prepared = await wechatPay.createNativeOrder({ orderNo: order.orderNo,
                description: paymentDescription(order.purchaseKind), amountFen: order.amountFen, expiresAt: order.expiresAt });
              return { kind: "wechat-native", codeUrl: prepared.codeUrl,
                qrDataUrl: await toDataURL(prepared.codeUrl, { width: 260, margin: 1, errorCorrectionLevel: "M" }) };
            }
            if (!alipay?.enabled) throw new Error("alipay_not_enabled");
            const prepared = alipay.buildPagePaymentUrl({ orderNo: order.orderNo,
              subject: paymentDescription(order.purchaseKind), amountFen: order.amountFen, expiresAt: order.expiresAt });
            return { kind: "alipay-page", redirectUrl: prepared.redirectUrl };
          });
        const { accessCode: _accessCode, ...publicCheckout } = result;
        return publicCheckout;
      });
      return json(response, 201, checkout);
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
      const completed = await service.completePayment({ orderNo: fact.orderNo, channel: "wechat", providerTransactionId: fact.transactionId, amountFen: fact.amountFen, paidAt: fact.paidAt });
      schedulePackagePreparation(completed.order.orderNo, completed.entitlements);
      return json(response, 200, { code: "SUCCESS", message: "成功" });
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/payments/alipay/notify") {
      if (!alipay?.enabled) return json(response, 503, { error: "alipay_not_enabled" });
      const fact = alipay.verifyAndDecodeNotification(await readBody(request, 64 * 1024));
      if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(fact.tradeState)) {
        const completed = await service.completePayment({ orderNo: fact.orderNo, channel: "alipay", providerTransactionId: fact.transactionId, amountFen: fact.amountFen, paidAt: fact.paidAt });
        schedulePackagePreparation(completed.order.orderNo, completed.entitlements);
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("success");
      return;
    }
    const payMatch = url.pathname.match(/^\/api\/gongde\/test\/orders\/([A-Z0-9_]+)\/pay$/u);
    if (request.method === "POST" && payMatch) {
      if (mode !== "mock" || request.headers["x-gongde-test-token"] !== testToken) {
        return json(response, 404, { error: "not_found" });
      }
      const completed = await service.completeMockPayment(payMatch[1]);
      schedulePackagePreparation(completed.order.orderNo, completed.entitlements);
      return json(response, 200, completed);
    }
    const orderMatch = url.pathname.match(/^\/api\/gongde\/orders\/([A-Z0-9_]+)$/u);
    if (request.method === "GET" && orderMatch) {
      const buyerToken = currentBuyerToken(request);
      const result = await refreshPaidOrder(orderMatch[1], buyerToken);
      const key = header(request, "x-gongde-checkout-key");
      let checkout: Awaited<ReturnType<typeof checkoutRequests.recover>>["checkout"] | undefined;
      if (key && result.order.state === "PENDING_PAYMENT" && result.order.expiresAt.getTime() > Date.now()) {
        try {
          const receipt = await checkoutRequests.recover(key);
          if (receipt.orderNo === result.order.orderNo && receipt.buyerToken === buyerToken &&
              receipt.channel === result.order.channel && receipt.amountFen === result.order.amountFen &&
              receipt.currency === result.order.currency) checkout = receipt.checkout;
        } catch (error) {
          if (!(error instanceof CheckoutRequestError)) throw error;
          // Keep the order query available even when its original entry cannot be recovered.
        }
      }
      return json(response, 200, { ...publicCurrentOrder(result), ...(checkout ? { checkout } : {}) });
    }
    const packageLinkMatch = url.pathname.match(/^\/api\/gongde\/orders\/([A-Z0-9_]+)\/package-link$/u);
    if (request.method === "POST" && packageLinkMatch) {
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      const startedAt = performance.now();
      const buyerToken = currentBuyerToken(request);
      const result = await currentOrder(packageLinkMatch[1], buyerToken);
      const deliveries = activePackDeliveries(result.entitlements);
      if (deliveries.length < 1) return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      const authorizedAt = performance.now();
      const prepared = await preparedPackage(packageLinkMatch[1], deliveries);
      let bytes = prepared.content.length;
      let storage = "server";
      if (privatePackageStore) {
        try {
          bytes = (await privatePackageStore.prepare(privatePackageInput(packageLinkMatch[1], prepared))).bytes;
          storage = "private-cos";
        } catch { audit("private_package_prepare_fallback", { orderNo: packageLinkMatch[1] }); }
      }
      // Storage work may outlive a revocation or moderation action.
      const current = await currentOrder(packageLinkMatch[1], buyerToken);
      const currentDeliveries = activePackDeliveries(current.entitlements);
      if (currentDeliveries.length !== deliveries.length || currentDeliveries.some((item) =>
        !deliveries.some((original) => original.id === item.id && original.expiresAt?.getTime() === item.expiresAt?.getTime()))) {
        return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      }
      await paidMarketItems(packageLinkMatch[1], currentDeliveries);
      const now = Date.now();
      if (prepared.importBefore.getTime() <= now) return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      for (const [ticket, entry] of nativeDownloads) {
        if (entry.expiresAt <= now) nativeDownloads.delete(ticket);
      }
      while (nativeDownloads.size >= MAX_NATIVE_DOWNLOADS) {
        nativeDownloads.delete(nativeDownloads.keys().next().value!);
      }
      const ticket = randomBytes(32).toString("hex");
      const expiresAt = Math.min(now + NATIVE_DOWNLOAD_TTL_MS, prepared.importBefore.getTime());
      nativeDownloads.set(ticket, { orderNo: packageLinkMatch[1], buyerToken, expiresAt });
      return json(response, 200, {
        downloadUrl: `/api/gongde/package-download/${ticket}`,
        filename: appearanceDownloadFilename(prepared.count > 1 ? `niuma-appearance-packs-${packageLinkMatch[1]}.nmgpacks` : prepared.singleFilename, prepared.count),
        bytes,
        count: prepared.count,
        storage,
        expiresAt: new Date(expiresAt).toISOString(), licenseMode: "perpetual", importExpiresAt: null
      }, {
        "referrer-policy": "no-referrer",
        "server-timing": `auth;dur=${(authorizedAt - startedAt).toFixed(1)}, package;dur=${(performance.now() - authorizedAt).toFixed(1)}`
      });
    }
    const nativeMatch = url.pathname.match(/^\/api\/gongde\/package-download\/([a-f0-9]{64})$/u);
    if ((request.method === "GET" || request.method === "HEAD") && nativeMatch) {
      if (Object.hasOwn(request.headers, "x-gongde-access-code")) throw new CheckoutRequestError("legacy_access_not_supported", 400);
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      const ticket = nativeDownloads.get(nativeMatch[1]);
      if (!ticket || ticket.expiresAt <= Date.now()) {
        nativeDownloads.delete(nativeMatch[1]);
        return json(response, 410, { error: "download_link_expired" });
      }
      const orderNo = ticket.orderNo;
      const token = ticket.buyerToken;
      const result = await currentOrder(orderNo, token);
      const deliveries = activePackDeliveries(result.entitlements);
      if (deliveries.length < 1) {
        return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      }
      const prepared = await preparedPackage(orderNo, deliveries);
      const multiple = prepared.count > 1;
      const content = prepared.content;
      const filename = multiple
        ? `niuma-appearance-packs-${orderNo}.nmgpacks`
        : prepared.singleFilename;
      let location: string | undefined;
      if (request.method === "GET" && privatePackageStore) {
        try {
          location = await privatePackageStore.downloadUrl(privatePackageInput(orderNo, prepared));
        } catch { audit("private_package_download_fallback", { orderNo }); }
        // Reauthorize after cloud work for both direct delivery and server fallback.
        // Authorization failures must never be treated as storage failures.
      }
      const current = await currentOrder(orderNo, token);
      const currentDeliveries = activePackDeliveries(current.entitlements);
      if (currentDeliveries.length !== deliveries.length || currentDeliveries.some(item =>
        !deliveries.some(original => original.id === item.id && original.expiresAt?.getTime() === item.expiresAt?.getTime()))) {
        return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      }
      await paidMarketItems(orderNo, currentDeliveries);
      if (ticket.expiresAt <= Date.now()) return json(response, 410, { error: "download_link_expired" });
      if (prepared.importBefore.getTime() <= Date.now()) return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      if (location) {
        response.writeHead(302, { location, "cache-control": "private, no-store", "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff", "content-length": "0" });
        response.end(); return;
      }
      response.writeHead(200, {
        "content-type": multiple ? "application/zip" : "application/octet-stream",
        "content-disposition": downloadDisposition(filename, prepared.count),
        "content-length": String(content.length),
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-gongde-license-mode": "perpetual",
        "x-gongde-pack-count": String(prepared.count)
      });
      response.end(request.method === "HEAD" ? undefined : content);
      return;
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof CheckoutRequestError) return json(response, error.status, { error: error.code,
      ...(error.precreateRejected ? { checkoutCreated: false } : {}) });
    if (error instanceof CreatorError) return json(response, error.status, { error: error.code });
    if (/^ER_/u.test((error as { code?: string })?.code ?? "")) {
      return json(response, 503, { error: "order_service_unavailable" });
    }
    if (error instanceof AppearanceNumberError) return json(response, error.status, { error: error.code });
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

server.on("close", () => {
  void checkoutRequests.close(); void freeDistributionRuntime.close(); void creatorRuntime.close(); void store.close(); void appearanceNumbers?.close(); void publicationLockHandle?.close(); });
