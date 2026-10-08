import type {
  GongdeAccessAccount,
  GongdeEntitlement,
  GongdeOrder,
  MarketOrderItem,
  MarketOrderItemSnapshot,
  OrderState,
  PaymentChannel,
  PurchaseKind
} from "./types.js";

export function validateMarketOrderItemSnapshots(order: GongdeOrder, items: readonly MarketOrderItemSnapshot[]): void {
  if (items.length < 1 || items.length > 10) throw new Error("market_order_items_count_invalid");
  if (order.purchaseKind !== "appearance-batch") throw new Error("market_order_purchase_kind_invalid");
  let totalFen = 0;
  for (const item of items) {
    if (item.sourceKind !== "official" && item.sourceKind !== "community") throw new Error("market_order_item_source_invalid");
    if (!item.assetId || item.assetId.length > 80) throw new Error("market_order_item_asset_invalid");
    if (!item.versionLabel || item.versionLabel.length > 32) throw new Error("market_order_item_version_label_invalid");
    if (!/^[a-f0-9]{64}$/u.test(item.sourceRevision)) throw new Error("market_order_item_revision_invalid");
    if (!item.titleZh || item.titleZh.length > 80) throw new Error("market_order_item_title_invalid");
    if (!Number.isSafeInteger(item.unitPriceFen) || item.unitPriceFen < 0 ||
        !Number.isSafeInteger(item.amountFen) || item.amountFen < 0) {
      throw new Error("market_order_item_amount_invalid");
    }
    if (!(item.createdAt instanceof Date) || Number.isNaN(item.createdAt.getTime())) {
      throw new Error("market_order_item_created_at_invalid");
    }
    if (item.revenueRuleVersion !== null && item.revenueRuleVersion.length > 64) {
      throw new Error("market_order_item_revenue_rule_invalid");
    }
    if (item.sourceKind === "official" && (item.creatorId !== null || item.workId !== null || item.versionId !== null)) {
      throw new Error("market_order_item_official_owner_invalid");
    }
    if (item.sourceKind === "community" && (!item.creatorId || !item.workId || !item.versionId)) {
      throw new Error("market_order_item_community_owner_required");
    }
    totalFen += item.amountFen;
    if (!Number.isSafeInteger(totalFen)) throw new Error("market_order_items_total_invalid");
  }
  if (totalFen !== order.amountFen) throw new Error("market_order_items_total_mismatch");
}

export interface AdminOrderFilter {
  orderNo?: string;
  userId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  channel?: PaymentChannel;
  purchaseKind?: PurchaseKind;
  state?: OrderState;
  effectiveOnly?: boolean;
  limit: number;
  offset: number;
}

export interface AdminOrderPage {
  orders: GongdeOrder[];
  total: number;
}

export interface AdminOrderSummary {
  orders: number;
  amountFen: number;
}

export interface PaymentStore {
  insertAccessAccount(account: GongdeAccessAccount): Promise<void>;
  findAccessAccountByDigest(codeDigest: string): Promise<GongdeAccessAccount | null>;
  findAccessAccountById(id: string): Promise<GongdeAccessAccount | null>;
  updateAccessAccount(account: GongdeAccessAccount): Promise<void>;
  insertOrder(order: GongdeOrder, marketItems?: readonly MarketOrderItemSnapshot[]): Promise<void>;
  findOrder(orderNo: string): Promise<GongdeOrder | null>;
  findMarketOrderItemsByOrder(orderNo: string): Promise<MarketOrderItem[]>;
  updateOrder(order: GongdeOrder): Promise<void>;
  insertEntitlement(entitlement: GongdeEntitlement): Promise<void>;
  findEntitlementsByOrder(orderNo: string): Promise<GongdeEntitlement[]>;
  findActiveEntitlement(userId: string, scope: GongdeEntitlement["scope"], assetId?: string | null): Promise<GongdeEntitlement | null>;
  listOrders(filter: AdminOrderFilter): Promise<AdminOrderPage>;
  summarizeOrders(createdFrom: Date, createdTo: Date): Promise<AdminOrderSummary>;
  runInTransaction<T>(work: (store: PaymentStore) => Promise<T>): Promise<T>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class InMemoryPaymentStore implements PaymentStore {
  readonly #accessAccounts = new Map<string, GongdeAccessAccount>();
  readonly #orders = new Map<string, GongdeOrder>();
  readonly #entitlements = new Map<string, GongdeEntitlement>();
  readonly #marketOrderItems = new Map<string, MarketOrderItem[]>();

  async insertAccessAccount(account: GongdeAccessAccount): Promise<void> {
    if (this.#accessAccounts.has(account.id) || [...this.#accessAccounts.values()].some((item) => item.codeDigest === account.codeDigest)) {
      throw new Error("access_account_conflict");
    }
    this.#accessAccounts.set(account.id, structuredClone(account));
  }

  async findAccessAccountByDigest(codeDigest: string): Promise<GongdeAccessAccount | null> {
    const account = [...this.#accessAccounts.values()].find((item) => item.codeDigest === codeDigest);
    return account ? structuredClone(account) : null;
  }

  async findAccessAccountById(id: string): Promise<GongdeAccessAccount | null> {
    const account = this.#accessAccounts.get(id);
    return account ? structuredClone(account) : null;
  }

  async updateAccessAccount(account: GongdeAccessAccount): Promise<void> {
    if (!this.#accessAccounts.has(account.id)) throw new Error("access_account_not_found");
    this.#accessAccounts.set(account.id, structuredClone(account));
  }

  async insertOrder(order: GongdeOrder, marketItems: readonly MarketOrderItemSnapshot[] = []): Promise<void> {
    if (this.#orders.has(order.orderNo)) throw new Error("order_no_conflict");
    if (marketItems.length > 0) validateMarketOrderItemSnapshots(order, marketItems);
    this.#orders.set(order.orderNo, structuredClone(order));
    if (marketItems.length > 0) {
      this.#marketOrderItems.set(order.orderNo, marketItems.map((item, index) => structuredClone({
        ...item,
        orderNo: order.orderNo,
        lineNo: index + 1,
        creatorShareBps: 0 as const,
        creatorAmountFen: 0 as const,
        platformAmountFen: item.amountFen
      })));
    }
  }

  async findOrder(orderNo: string): Promise<GongdeOrder | null> {
    const order = this.#orders.get(orderNo);
    return order ? structuredClone(order) : null;
  }

  async findMarketOrderItemsByOrder(orderNo: string): Promise<MarketOrderItem[]> {
    return structuredClone(this.#marketOrderItems.get(orderNo) ?? []);
  }

  async updateOrder(order: GongdeOrder): Promise<void> {
    if (!this.#orders.has(order.orderNo)) throw new Error("order_not_found");
    this.#orders.set(order.orderNo, structuredClone(order));
  }

  async insertEntitlement(entitlement: GongdeEntitlement): Promise<void> {
    if (this.#entitlements.has(entitlement.id)) throw new Error("entitlement_conflict");
    this.#entitlements.set(entitlement.id, structuredClone(entitlement));
  }

  async findEntitlementsByOrder(orderNo: string): Promise<GongdeEntitlement[]> {
    return [...this.#entitlements.values()]
      .filter((entitlement) => entitlement.orderNo === orderNo)
      .map((entitlement) => structuredClone(entitlement));
  }

  async findActiveEntitlement(userId: string, scope: GongdeEntitlement["scope"], assetId: string | null = null): Promise<GongdeEntitlement | null> {
    const entitlement = [...this.#entitlements.values()].find((item) =>
      item.userId === userId && item.scope === scope && item.assetId === assetId && item.state === "ACTIVE"
    );
    return entitlement ? structuredClone(entitlement) : null;
  }

  async listOrders(filter: AdminOrderFilter): Promise<AdminOrderPage> {
    const orderNo = filter.orderNo?.toUpperCase();
    const matching = [...this.#orders.values()]
      .filter((order) => !orderNo || order.orderNo.includes(orderNo))
      .filter((order) => !filter.userId || order.userId === filter.userId)
      .filter((order) => !filter.createdFrom || order.createdAt >= filter.createdFrom)
      .filter((order) => !filter.createdTo || order.createdAt < filter.createdTo)
      .filter((order) => !filter.channel || order.channel === filter.channel)
      .filter((order) => !filter.purchaseKind || order.purchaseKind === filter.purchaseKind)
      .filter((order) => !filter.state || order.state === filter.state)
      .filter((order) => !filter.effectiveOnly || order.state === "PAID" || order.state === "FULFILLED")
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.orderNo.localeCompare(left.orderNo));
    return {
      total: matching.length,
      orders: matching.slice(filter.offset, filter.offset + filter.limit).map((order) => structuredClone(order))
    };
  }

  async summarizeOrders(createdFrom: Date, createdTo: Date): Promise<AdminOrderSummary> {
    const orders = [...this.#orders.values()].filter((order) => order.createdAt >= createdFrom && order.createdAt < createdTo);
    const settled = orders.filter((order) => order.state === "PAID" || order.state === "FULFILLED");
    return {
      orders: settled.length,
      amountFen: settled.reduce((sum, order) => sum + order.amountFen, 0)
    };
  }

  async runInTransaction<T>(work: (store: PaymentStore) => Promise<T>): Promise<T> {
    return await work(this);
  }

  async ready(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}
