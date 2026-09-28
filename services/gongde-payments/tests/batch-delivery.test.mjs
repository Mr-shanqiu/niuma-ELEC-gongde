import assert from "node:assert/strict";
import test from "node:test";

import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";

test("official pass and later delivery price a selected batch, not each asset", async () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const service = new GongdeOrderService(new InMemoryPaymentStore(), () => now);
  const first = await service.createMockCheckout({
    channel: "wechat",
    purchaseKind: "official-pass",
    assetIds: ["official.chick-pecking"]
  });
  assert.equal(first.amountFen, 100);
  assert.deepEqual(first.assetIds, ["official.chick-pecking"]);
  await service.completeMockPayment(first.orderNo);

  const later = await service.createMockCheckout({
    channel: "alipay",
    purchaseKind: "asset-delivery",
    accessCode: first.accessCode,
    assetIds: ["official.chick-pecking"]
  });
  assert.equal(later.amountFen, 20);
  assert.deepEqual(later.assetIds, ["official.chick-pecking"]);
});
