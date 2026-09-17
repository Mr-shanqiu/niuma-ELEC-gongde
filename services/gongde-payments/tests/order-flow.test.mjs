import assert from "node:assert/strict";
import test from "node:test";

import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";

test("verified-phone one-yuan checkout grants a pass and the first delivery", async () => {
  const now = new Date("2026-09-16T14:00:00.000Z");
  const service = new GongdeOrderService(new InMemoryPaymentStore(), () => now);
  const checkout = await service.createMockCheckout({
    channel: "wechat", purchaseKind: "official-pass", userId: "phone_test_001", assetIds: ["official.chick-pecking"]
  });
  assert.equal(checkout.amountFen, 100);
  assert.equal(checkout.currency, "CNY");
  assert.match(checkout.orderNo, /^NGD[A-Z0-9]+$/u);

  const first = await service.completeMockPayment(checkout.orderNo);
  const second = await service.completeMockPayment(checkout.orderNo);
  assert.equal(first.order.state, "FULFILLED");
  assert.equal(first.entitlements.length, 2);
  assert.equal(first.entitlements.find((item) => item.scope === "official-character-pass").expiresAt, null);
  assert.equal(first.entitlements.find((item) => item.scope === "asset-download").expiresAt.toISOString(), "2026-09-17T14:00:00.000Z");
  assert.equal(second.entitlements[0].id, first.entitlements[0].id);

  const visible = await service.getOrder(checkout.orderNo, checkout.buyerToken);
  assert.equal(visible.entitlements[0]?.productId, "official-character-pass");
  assert.equal(visible.entitlements[0]?.scope, "official-character-pass");
  await assert.rejects(service.getOrder(checkout.orderNo, "wrong-token"), /order_access_denied/u);
});

test("20-fen delivery requires an existing official pass", async () => {
  const service = new GongdeOrderService(new InMemoryPaymentStore());
  await assert.rejects(service.createMockCheckout({
    channel: "alipay", purchaseKind: "asset-delivery", userId: "phone_test_002", assetId: "official.chick-pecking"
  }), /official_pass_required/u);
  const pass = await service.createMockCheckout({
    channel: "wechat", purchaseKind: "official-pass", userId: "phone_test_002", assetIds: ["official.chick-pecking"]
  });
  await service.completeMockPayment(pass.orderNo);
  const delivery = await service.createMockCheckout({
    channel: "alipay", purchaseKind: "asset-delivery", userId: "phone_test_002", assetId: "official.chick-pecking"
  });
  assert.equal(delivery.amountFen, 20);
  assert.equal((await service.completeMockPayment(delivery.orderNo)).entitlements[0].scope, "asset-download");
});

test("support is separate and grants no entitlement", async () => {
  const service = new GongdeOrderService(new InMemoryPaymentStore());
  const support = await service.createMockCheckout({ channel: "wechat", purchaseKind: "support", amountFen: 500 });
  assert.equal(support.amountFen, 500);
  assert.deepEqual((await service.completeMockPayment(support.orderNo)).entitlements, []);
  await assert.rejects(service.createMockCheckout({ channel: "wechat", purchaseKind: "support", amountFen: 200 }), /invalid_amount/u);
});
