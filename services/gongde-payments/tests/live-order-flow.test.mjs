import assert from "node:assert/strict";
import test from "node:test";

import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";

test("live checkout records provider presentation and fulfills idempotently", async () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  const service = new GongdeOrderService(new InMemoryPaymentStore(), () => now);
  const checkout = await service.createLiveCheckout({
    channel: "wechat",
    purchaseKind: "official-pass",
    userId: "phone_live_001",
    assetIds: ["official.chick-pecking"]
  }, async () => ({ kind: "wechat-native", codeUrl: "weixin://wxpay/test", qrDataUrl: "data:image/png;base64,AA==" }));
  assert.equal(checkout.amountFen, 100);
  assert.equal(checkout.checkout.kind, "wechat-native");

  const payment = {
    orderNo: checkout.orderNo,
    channel: "wechat",
    providerTransactionId: "420000000020260917000000001",
    amountFen: 100,
    paidAt: new Date("2026-09-17T10:01:00.000Z")
  };
  const first = await service.completePayment(payment);
  const second = await service.completePayment(payment);
  assert.equal(first.order.state, "FULFILLED");
  assert.equal(first.entitlements.length, 2);
  assert.equal(second.entitlements.length, 2);
  assert.equal((await service.getAccount("phone_live_001")).ownsOfficialPass, true);
  await assert.rejects(service.completePayment({ ...payment, amountFen: 20, providerTransactionId: "different" }), /provider_transaction_conflict/u);
});
