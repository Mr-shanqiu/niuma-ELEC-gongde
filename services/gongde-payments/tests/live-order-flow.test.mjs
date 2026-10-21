import assert from "node:assert/strict";
import test from "node:test";

import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";

// Live checkout is still the real-provider path; only the retired pass product
// is gone. A batch of two official appearances costs 200 fen.
test("live checkout records provider presentation and fulfills idempotently", async () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const service = new GongdeOrderService(new InMemoryPaymentStore(), () => now);
  const checkout = await service.createLiveCheckout({
    channel: "wechat",
    purchaseKind: "appearance-batch",
    assetIds: ["official.chick-pecking", "official.hamster-wheel"]
  }, async () => ({ kind: "wechat-native", codeUrl: "weixin://wxpay/test", qrDataUrl: "data:image/png;base64,AA==" }));
  assert.equal(checkout.amountFen, 200);
  assert.equal(checkout.checkout.kind, "wechat-native");
  assert.equal(checkout.accessCode, null);

  const payment = {
    orderNo: checkout.orderNo,
    channel: "wechat",
    providerTransactionId: "420000000020260917000000001",
    amountFen: 200,
    paidAt: new Date("2026-09-17T10:01:00.000Z")
  };
  const first = await service.completePayment(payment);
  const second = await service.completePayment(payment);
  assert.equal(first.order.state, "FULFILLED");
  assert.equal(first.entitlements.length, 2);
  assert.deepEqual(first.entitlements.map(item => item.assetId).sort(),
    ["official.chick-pecking", "official.hamster-wheel"]);
  assert.equal(second.entitlements.length, 2);
  // The same order must not be settled twice under a different provider fact.
  await assert.rejects(service.completePayment({ ...payment, amountFen: 100, providerTransactionId: "different" }),
    /provider_transaction_conflict/u);
});
