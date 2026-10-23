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
  assert.equal(summary.orders, 1); assert.equal(summary.amountFen,100);
  assert.equal(summary.totalOrders,2);assert.equal(summary.byState.PENDING_PAYMENT,1);
});

test("operations summary separates all states and keeps exclusive upper boundary", async()=>{
  const store=new InMemoryPaymentStore();
  const states=["PENDING_PAYMENT","PAID","FULFILLED","EXPIRED","CANCELED","EXCEPTION","REFUND_PENDING","REFUNDED"];
  for(const state of states) await store.insertOrder(order("GD_"+state,state,100,new Date("2026-10-22T16:00:00Z")));
  await store.insertOrder(order("GD_OUTSIDE","PAID",999,new Date("2026-10-23T16:00:00Z")));
  const summary=await store.summarizeOrders(new Date("2026-10-22T16:00:00Z"),new Date("2026-10-23T16:00:00Z"));
  assert.equal(summary.totalOrders,8);assert.equal(summary.orders,2);assert.equal(summary.amountFen,200);
  for(const state of states) assert.equal(summary.byState[state],1);
  const page=await store.listOrders({createdFrom:new Date("2026-10-22T16:00:00Z"),createdTo:new Date("2026-10-23T16:00:00Z"),limit:25,offset:0});
  assert.equal(page.total,8);assert.equal((await store.listOrders({state:"REFUNDED",limit:25,offset:0})).total,1);
});
