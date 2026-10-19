import { OFFICIAL_APPEARANCE_BATCH, appearanceBatchPriceFen } from "./catalog.js";
import { createHash, randomBytes } from "node:crypto";
import { MAX_ASSETS_PER_DELIVERY, OFFICIAL_ASSET_IDS } from "./catalog.js";
import type { PaymentStore } from "./store.js";
import type { CheckoutResult, GongdeAccessAccount, GongdeEntitlement, GongdeOrder, MarketOrderItemSnapshot, PaymentChannel, PurchaseKind } from "./types.js";

export type MarketCheckoutItem = Omit<MarketOrderItemSnapshot, "amountFen" | "createdAt">;

type CheckoutInput = {
  channel: PaymentChannel;
  purchaseKind: PurchaseKind;
  accessCode?: string | null;
  assetId?: string | null;
  assetIds?: string[];
  amountFen?: number;
  // Resolved by the server from reviewed catalog records, never from HTTP JSON.
  marketItems?: readonly MarketCheckoutItem[];
};

type LiveCheckout = Exclude<CheckoutResult["checkout"], { kind: "mock" }>;

export const GONGDE_ORDER_PREFIX = "GD_";
const GONGDE_ORDER_NUMBER = /^GD_\d{14}[A-F0-9]{10}$/u;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const ACCESS_CODE_PATTERN = /^GD(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){5}$/u;

function normalizeAccessCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/\s+/gu, "");
  if (!ACCESS_CODE_PATTERN.test(normalized)) throw new Error("access_code_invalid");
  return normalized;
}

function orderNumber(now: Date): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14);
  return `${GONGDE_ORDER_PREFIX}${stamp}${randomBytes(5).toString("hex").toUpperCase()}`;
}

function normalizeAssetIds(input: CheckoutInput): string[] {
  const requested = input.assetIds?.length ? input.assetIds : input.assetId ? [input.assetId] : [];
  const assetIds = [...new Set(requested)];
  if (assetIds.length < 1) throw new Error("asset_ids_required");
  if (assetIds.length > MAX_ASSETS_PER_DELIVERY) throw new Error("asset_selection_limit_exceeded");
  if (input.marketItems) {
    if (input.purchaseKind !== "appearance-batch" || input.marketItems.length !== assetIds.length ||
        input.marketItems.some((item, index) => item.assetId !== assetIds[index] || item.unitPriceFen !== 100 ||
          !/^[a-f0-9]{64}$/u.test(item.sourceRevision) ||
          item.sourceKind !== "official" || !OFFICIAL_ASSET_IDS.includes(item.assetId) ||
          item.creatorId !== null || item.workId !== null || item.versionId !== null ||
          item.revenueRuleVersion !== null)) {
      throw new Error("market_catalog_snapshot_invalid");
    }
  } else if (assetIds.some((assetId) => !OFFICIAL_ASSET_IDS.some((officialAssetId) => officialAssetId === assetId))) {
    throw new Error("asset_id_not_available");
  }
  return assetIds;
}

export class GongdeOrderService {
  constructor(
    private readonly store: PaymentStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createPendingOrder(input: CheckoutInput): Promise<{ order: GongdeOrder; buyerToken: string; accessCode: string | null }> {
    const { channel, purchaseKind } = input;
    if (purchaseKind !== "appearance-batch") throw new Error("invalid_purchase_kind");
    if (channel !== "wechat" && channel !== "alipay") throw new Error("invalid_channel");
    if (input.accessCode) throw new Error("access_code_not_supported");
    const marketItems = input.marketItems ? structuredClone(input.marketItems) : undefined;
    const assetIds = normalizeAssetIds({ ...input, marketItems });
    const assetId = assetIds[0];
    const product = OFFICIAL_APPEARANCE_BATCH;
    const amountFen = appearanceBatchPriceFen(assetIds.length);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
    const buyerToken = randomBytes(24).toString("base64url");
    const order: GongdeOrder = {
      orderNo: orderNumber(createdAt),
      productId: product.id,
      productVersion: product.version,
      channel,
      purchaseKind,
      userId: null,
      assetId,
      assetIds,
      amountFen,
      currency: product.currency,
      state: "PENDING_PAYMENT",
      buyerTokenDigest: digest(buyerToken),
      providerTransactionId: null,
      createdAt,
      expiresAt,
      paidAt: null,
      fulfilledAt: null
    };
    const snapshots: MarketOrderItemSnapshot[] = marketItems?.map((item) => ({
      ...item,
      amountFen: 100,
      createdAt
    })) ?? [];
    await this.store.insertOrder(order, snapshots);
    return { order, buyerToken, accessCode: null };
  }

  async createMockCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const { order, buyerToken, accessCode } = await this.createPendingOrder(input);
    return {
      orderNo: order.orderNo,
      buyerToken,
      accessCode,
      amountFen: order.amountFen,
      currency: order.currency,
      expiresAt: order.expiresAt.toISOString(),
      channel: order.channel,
      purchaseKind: order.purchaseKind,
      assetId: order.assetId,
      assetIds: order.assetIds,
      checkout: { kind: "mock", reference: `mock:${order.channel}:${order.orderNo}` }
    };
  }

  async createLiveCheckout(
    input: CheckoutInput,
    prepare: (order: GongdeOrder) => Promise<LiveCheckout>
  ): Promise<CheckoutResult> {
    const { order, buyerToken, accessCode } = await this.createPendingOrder(input);
    const checkout = await prepare(order);
    return {
      orderNo: order.orderNo,
      buyerToken,
      accessCode,
      amountFen: order.amountFen,
      currency: order.currency,
      expiresAt: order.expiresAt.toISOString(),
      channel: order.channel,
      purchaseKind: order.purchaseKind,
      assetId: order.assetId,
      assetIds: order.assetIds,
      checkout
    };
  }

  async completeMockPayment(orderNo: string): Promise<{ order: GongdeOrder; entitlements: GongdeEntitlement[] }> {
    const order = await this.requireOrder(orderNo, this.store);
    return await this.completePayment({
      orderNo,
      channel: order.channel,
      providerTransactionId: `mock-${orderNo}`,
      amountFen: order.amountFen,
      paidAt: this.now()
    });
  }

  async completePayment(input: {
    orderNo: string;
    channel: PaymentChannel;
    providerTransactionId: string;
    amountFen: number;
    paidAt: Date;
  }): Promise<{ order: GongdeOrder; entitlements: GongdeEntitlement[] }> {
    return await this.store.runInTransaction(async (store) => {
      const order = await this.requireOrder(input.orderNo, store);
      if (order.purchaseKind !== "appearance-batch" || order.productVersion !== OFFICIAL_APPEARANCE_BATCH.version) {
        throw new Error("purchase_flow_retired");
      }
      if (order.state === "FULFILLED") {
        if (order.providerTransactionId !== input.providerTransactionId) throw new Error("provider_transaction_conflict");
        return { order, entitlements: await store.findEntitlementsByOrder(input.orderNo) };
      }
      if (order.state !== "PENDING_PAYMENT") throw new Error("order_not_payable");
      if (order.channel !== input.channel) throw new Error("payment_channel_mismatch");
      if (order.amountFen !== input.amountFen) throw new Error("payment_amount_mismatch");
      if (!input.providerTransactionId || !(input.paidAt instanceof Date) || !Number.isFinite(input.paidAt.getTime())) {
        throw new Error("payment_fact_invalid");
      }
      const paidAt = input.paidAt;
      order.state = "FULFILLED";
      order.providerTransactionId = input.providerTransactionId;
      order.paidAt = paidAt;
      order.fulfilledAt = paidAt;
      await store.updateOrder(order);
      const entitlements: GongdeEntitlement[] = [];
      {
        const deliveries = order.assetIds.map((assetId) => ({ scope: "asset-download" as const, assetId }));
        for (const item of deliveries) {
          const entitlement: GongdeEntitlement = {
            id: `ent_${randomBytes(12).toString("hex")}`,
            orderNo: input.orderNo,
            userId: order.userId ?? `order:${order.orderNo}`,
            productId: order.productId,
            scope: item.scope,
            assetId: item.assetId,
            state: "ACTIVE",
            createdAt: paidAt,
            activatedAt: paidAt,
            // Current-transaction cleanup only. Signed files use perpetual licenses;
            // this deadline must never be presented as a local import restriction.
            expiresAt: new Date(paidAt.getTime() + 24 * 60 * 60 * 1000),
            revokedAt: null
          };
          await store.insertEntitlement(entitlement);
          entitlements.push(entitlement);
        }
      }
      return { order, entitlements };
    });
  }

  // Only call after the provider has confirmed closure, never on elapsed time alone.
  async confirmUnpaidClosure(orderNo: string, channel: PaymentChannel): Promise<void> {
    await this.store.runInTransaction(async (store) => {
      const order = await this.requireOrder(orderNo, store);
      if (order.channel !== channel) throw new Error("payment_channel_mismatch");
      // The row lock also protects a callback that completed while we queried.
      if (order.state !== "PENDING_PAYMENT" || order.paidAt || order.providerTransactionId) return;
      order.state = order.expiresAt <= this.now() ? "EXPIRED" : "CANCELED";
      await store.updateOrder(order);
    });
  }

  async getAccess(accessCode: string): Promise<{ accessId: string; codeHint: string; ownsOfficialPass: boolean }> {
    const account = await this.requireAccessAccount(accessCode);
    return {
      accessId: account.id,
      codeHint: account.codeHint,
      ownsOfficialPass: Boolean(await this.store.findActiveEntitlement(account.id, "official-character-pass"))
    };
  }

  async resolveAccessId(accessCode: string): Promise<string> {
    return (await this.requireAccessAccount(accessCode)).id;
  }

  async listAccessOrders(accessCode: string): Promise<{ orders: GongdeOrder[] }> {
    const account = await this.requireAccessAccount(accessCode);
    const page = await this.store.listOrders({ userId: account.id, limit: 100, offset: 0 });
    return { orders: page.orders };
  }

  async getOrderForAccess(orderNo: string, accessCode: string): Promise<{ order: GongdeOrder; entitlements: GongdeEntitlement[] }> {
    const account = await this.requireAccessAccount(accessCode);
    const order = await this.requireOrder(orderNo, this.store);
    if (order.userId !== account.id) throw new Error("order_access_denied");
    return { order, entitlements: await this.store.findEntitlementsByOrder(orderNo) };
  }

  async getOrder(orderNo: string, buyerToken: string): Promise<{ order: GongdeOrder; entitlements: GongdeEntitlement[] }> {
    const order = await this.requireOrder(orderNo, this.store);
    if (digest(buyerToken) !== order.buyerTokenDigest) throw new Error("order_access_denied");
    return { order, entitlements: await this.store.findEntitlementsByOrder(orderNo) };
  }

  private async requireOrder(orderNo: string, store: PaymentStore): Promise<GongdeOrder> {
    if (!GONGDE_ORDER_NUMBER.test(orderNo)) throw new Error("order_not_found");
    const order = await store.findOrder(orderNo);
    if (!order) throw new Error("order_not_found");
    return order;
  }

  private async requireAccessAccount(accessCode: string): Promise<GongdeAccessAccount> {
    const account = await this.store.findAccessAccountByDigest(digest(normalizeAccessCode(accessCode)));
    if (!account || account.state !== "ACTIVE") throw new Error("access_code_invalid");
    return account;
  }
}
