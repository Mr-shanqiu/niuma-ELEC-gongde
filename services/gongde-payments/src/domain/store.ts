import type { GongdeEntitlement, GongdeOrder } from "./types.js";

export interface PaymentStore {
  insertOrder(order: GongdeOrder): Promise<void>;
  findOrder(orderNo: string): Promise<GongdeOrder | null>;
  updateOrder(order: GongdeOrder): Promise<void>;
  insertEntitlement(entitlement: GongdeEntitlement): Promise<void>;
  findEntitlementsByOrder(orderNo: string): Promise<GongdeEntitlement[]>;
  findActiveEntitlement(userId: string, scope: GongdeEntitlement["scope"], assetId?: string | null): Promise<GongdeEntitlement | null>;
  runInTransaction<T>(work: (store: PaymentStore) => Promise<T>): Promise<T>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class InMemoryPaymentStore implements PaymentStore {
  readonly #orders = new Map<string, GongdeOrder>();
  readonly #entitlements = new Map<string, GongdeEntitlement>();

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

  async runInTransaction<T>(work: (store: PaymentStore) => Promise<T>): Promise<T> {
    return await work(this);
  }

  async ready(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}
