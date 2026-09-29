import assert from "node:assert/strict";
import test from "node:test";

import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";
import { OFFICIAL_ASSET_IDS } from "../dist/domain/catalog.js";

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

test("a new paid batch accepts five appearances and rejects six", async () => {
  const service = new GongdeOrderService(new InMemoryPaymentStore(),
    () => new Date("2026-09-30T00:00:00.000Z"));
  const five = OFFICIAL_ASSET_IDS.slice(0, 5);
  assert.equal(five.length, 5);
  const order = await service.createMockCheckout({
    channel: "wechat",
    purchaseKind: "official-pass",
    assetIds: five
  });
  assert.equal(order.amountFen, 100);
  assert.deepEqual(order.assetIds, five);
  await assert.rejects(
    () => service.createMockCheckout({
      channel: "wechat",
      purchaseKind: "official-pass",
      assetIds: OFFICIAL_ASSET_IDS.slice(0, 6)
    }),
    /asset_selection_limit_exceeded/
  );
});
