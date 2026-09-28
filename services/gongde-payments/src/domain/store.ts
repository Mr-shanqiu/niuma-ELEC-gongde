import type { GongdeAccessAccount, GongdeEntitlement, GongdeOrder, OrderState, PaymentChannel } from "./types.js";

export interface AdminOrderFilter {
  orderNo?: string;
  userId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  channel?: PaymentChannel;
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
  insertOrder(order: GongdeOrder): Promise<void>;
  findOrder(orderNo: string): Promise<GongdeOrder | null>;
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

  async insertOrder(order: GongdeOrder): Promise<void> {
    if (this.#orders.has(order.orderNo)) throw new Error("order_no_conflict");
    this.#orders.set(order.orderNo, structuredClone(order));
  }

  async findOrder(orderNo: string): Promise<GongdeOrder | null> {
    const order = this.#orders.get(orderNo);
    return order ? structuredClone(order) : null;
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
