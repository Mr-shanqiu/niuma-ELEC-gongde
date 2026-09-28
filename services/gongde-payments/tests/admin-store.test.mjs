import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryPaymentStore } from "../dist/domain/store.js";

function order(orderNo, state, amountFen, createdAt) {
  return {
    orderNo, productId: "official-character-pass", productVersion: 1, channel: "wechat",
    purchaseKind: "official-pass", userId: "private-user", assetId: null, assetIds: [], amountFen,
    currency: "CNY", state, buyerTokenDigest: "private-token", providerTransactionId: null,
    createdAt, expiresAt: new Date(createdAt.getTime() + 900000), paidAt: null, fulfilledAt: null
  };
}

test("admin order queries paginate, filter, and summarize without changing orders", async () => {
  const store = new InMemoryPaymentStore();
  await store.insertOrder(order("GD_FIRST", "FULFILLED", 100, new Date("2026-09-28T01:00:00Z")));
  await store.insertOrder(order("GD_SECOND", "PENDING_PAYMENT", 20, new Date("2026-09-28T02:00:00Z")));
  const page = await store.listOrders({ state: "FULFILLED", limit: 10, offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.orders[0].orderNo, "GD_FIRST");
  const effective = await store.listOrders({ effectiveOnly: true, limit: 10, offset: 0 });
  assert.deepEqual(effective.orders.map((item) => item.orderNo), ["GD_FIRST"]);
  const summary = await store.summarizeOrders(new Date("2026-09-28T00:00:00Z"), new Date("2026-09-29T00:00:00Z"));
  assert.deepEqual(summary, { orders: 1, amountFen: 100 });
});
