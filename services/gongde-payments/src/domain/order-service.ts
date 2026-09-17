import { createHash, randomBytes } from "node:crypto";
import { MAX_ASSETS_PER_DELIVERY, OFFICIAL_ASSET_IDS, OFFICIAL_ASSET_DELIVERY, OFFICIAL_CHARACTER_PASS, PROJECT_SUPPORT } from "./catalog.js";
import type { PaymentStore } from "./store.js";
import type { CheckoutResult, GongdeEntitlement, GongdeOrder, PaymentChannel, PurchaseKind } from "./types.js";

type CheckoutInput = {
  channel: PaymentChannel;
  purchaseKind: PurchaseKind;
  userId?: string | null;
  assetId?: string | null;
  assetIds?: string[];
  amountFen?: number;
};

type LiveCheckout = Exclude<CheckoutResult["checkout"], { kind: "mock" }>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function orderNumber(now: Date): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14);
  return `NGD${stamp}${randomBytes(5).toString("hex").toUpperCase()}`;
}

function normalizeAssetIds(input: CheckoutInput): string[] {
  const requested = input.assetIds?.length ? input.assetIds : input.assetId ? [input.assetId] : [];
  const assetIds = [...new Set(requested)];
  if (assetIds.length < 1) throw new Error("asset_ids_required");
  if (assetIds.length > MAX_ASSETS_PER_DELIVERY) throw new Error("asset_selection_limit_exceeded");
  if (assetIds.some((assetId) => !OFFICIAL_ASSET_IDS.some((officialAssetId) => officialAssetId === assetId))) {
    throw new Error("asset_id_not_available");
  }
  return assetIds;
}

export class GongdeOrderService {
  constructor(
    private readonly store: PaymentStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createPendingOrder(input: CheckoutInput): Promise<{ order: GongdeOrder; buyerToken: string }> {
    const { channel, purchaseKind } = input;
    const userId = input.userId ?? null;
    const assetIds = purchaseKind === "support" ? [] : normalizeAssetIds(input);
    const assetId = assetIds[0] ?? null;
    if (purchaseKind !== "support" && !userId) throw new Error("phone_verification_required");
    if (purchaseKind === "support" && userId) throw new Error("support_order_must_not_bind_user");
    if (purchaseKind === "asset-delivery") {
      if (!await this.store.findActiveEntitlement(userId!, "official-character-pass")) throw new Error("official_pass_required");
    }
    if (purchaseKind === "official-pass" && await this.store.findActiveEntitlement(userId!, "official-character-pass")) {
      throw new Error("official_pass_already_owned");
    }
    const product = purchaseKind === "official-pass"
      ? OFFICIAL_CHARACTER_PASS
      : purchaseKind === "asset-delivery"
        ? OFFICIAL_ASSET_DELIVERY
        : PROJECT_SUPPORT;
    const amountFen = purchaseKind === "support" ? input.amountFen : "amountFen" in product ? product.amountFen : undefined;
    if (!amountFen || (purchaseKind === "support" && !PROJECT_SUPPORT.allowedAmountsFen.includes(amountFen))) {
      throw new Error("invalid_amount");
    }
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
    const buyerToken = randomBytes(24).toString("base64url");
    const order: GongdeOrder = {
      orderNo: orderNumber(createdAt),
      productId: product.id,
      productVersion: product.version,
      channel,
      purchaseKind,
      userId,
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
    await this.store.insertOrder(order);
    return { order, buyerToken };
  }

  async createMockCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const { order, buyerToken } = await this.createPendingOrder(input);
    return {
      orderNo: order.orderNo,
      buyerToken,
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
    const { order, buyerToken } = await this.createPendingOrder(input);
    const checkout = await prepare(order);
    return {
      orderNo: order.orderNo,
      buyerToken,
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
      if (order.purchaseKind !== "support") {
        const deliveries = order.assetIds.map((assetId) => ({ scope: "asset-download" as const, assetId }));
        const scopes: Array<{ scope: GongdeEntitlement["scope"]; assetId: string | null }> = order.purchaseKind === "official-pass"
          ? [{ scope: "official-character-pass", assetId: null }, ...deliveries]
          : deliveries;
        for (const item of scopes) {
          const entitlement: GongdeEntitlement = {
            id: `ent_${randomBytes(12).toString("hex")}`,
            orderNo: input.orderNo,
            userId: order.userId!,
            productId: order.productId,
            scope: item.scope,
            assetId: item.assetId,
            state: "ACTIVE",
            createdAt: paidAt,
            activatedAt: paidAt,
            expiresAt: item.scope === "asset-download" ? new Date(paidAt.getTime() + 24 * 60 * 60 * 1000) : null,
            revokedAt: null
          };
          await store.insertEntitlement(entitlement);
          entitlements.push(entitlement);
        }
      }
      return { order, entitlements };
    });
  }

  async getAccount(userId: string): Promise<{ ownsOfficialPass: boolean }> {
    return { ownsOfficialPass: Boolean(await this.store.findActiveEntitlement(userId, "official-character-pass")) };
  }

  async getOrder(orderNo: string, buyerToken: string): Promise<{ order: GongdeOrder; entitlements: GongdeEntitlement[] }> {
    const order = await this.requireOrder(orderNo, this.store);
    if (digest(buyerToken) !== order.buyerTokenDigest) throw new Error("order_access_denied");
    return { order, entitlements: await this.store.findEntitlementsByOrder(orderNo) };
  }

  private async requireOrder(orderNo: string, store: PaymentStore): Promise<GongdeOrder> {
    const order = await store.findOrder(orderNo);
    if (!order) throw new Error("order_not_found");
    return order;
  }
}
