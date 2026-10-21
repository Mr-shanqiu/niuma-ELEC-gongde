import assert from "node:assert/strict";
import test from "node:test";

import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";

// Current rule: the only sellable product is an appearance batch of 1-10 items
// at 100 fen each, with no pass, no follow-up delivery and no support product.
// docs/WORK_PLAN_BASIC_FREE_PAID_PACKS.zh-CN.md §2 and §5/F2.
test("anonymous batch checkout fulfils once and stays idempotent", async () => {
  const now = new Date("2026-09-16T14:00:00.000Z");
  const service = new GongdeOrderService(new InMemoryPaymentStore(), () => now);
  const checkout = await service.createMockCheckout({
    channel: "wechat", purchaseKind: "appearance-batch", assetIds: ["official.chick-pecking"]
  });
  assert.equal(checkout.amountFen, 100);
  assert.equal(checkout.currency, "CNY");
  assert.equal(checkout.accessCode, null);
  assert.match(checkout.orderNo, /^GD_\d{14}[A-F0-9]{10}$/u);

  const first = await service.completeMockPayment(checkout.orderNo);
  const second = await service.completeMockPayment(checkout.orderNo);
  assert.equal(first.order.state, "FULFILLED");
  assert.equal(first.entitlements.length, 1);
  assert.equal(first.entitlements[0].scope, "asset-download");
  assert.equal(first.entitlements[0].assetId, "official.chick-pecking");
  // Internal cleanup deadline for this transaction, never a local import limit.
  assert.equal(first.entitlements[0].expiresAt.toISOString(), "2026-09-17T14:00:00.000Z");
  assert.equal(second.entitlements[0].id, first.entitlements[0].id);

  const visible = await service.getOrder(checkout.orderNo, checkout.buyerToken);
  assert.equal(visible.entitlements[0]?.assetId, "official.chick-pecking");
  await assert.rejects(service.getOrder(checkout.orderNo, "wrong-token"), /order_access_denied/u);
});

// Retired products stay rejected: no pass, no paid follow-up delivery and no
// support product. None of them may create an order or grant an entitlement.
test("the retired products cannot be ordered and no access code is accepted", async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store);
  for (const purchaseKind of ["official-pass", "asset-delivery", "support"]) {
    await assert.rejects(
      service.createMockCheckout({ channel: "wechat", purchaseKind, assetIds: ["official.chick-pecking"] }),
      /invalid_purchase_kind/u
    );
  }
  await assert.rejects(service.createMockCheckout({ channel: "wechat", purchaseKind: "appearance-batch",
    accessCode: "GD-2222-2222-2222-2222-2222", assetIds: ["official.chick-pecking"] }), /access_code_not_supported/u);
  assert.equal((await store.listOrders({ limit: 100, offset: 0 })).total, 0);
});
