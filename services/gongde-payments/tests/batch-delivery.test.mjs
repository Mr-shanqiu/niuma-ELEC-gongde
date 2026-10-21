import assert from "node:assert/strict";
import test from "node:test";

import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";
import { OFFICIAL_ASSET_IDS, MAX_ASSETS_PER_DELIVERY } from "../dist/domain/catalog.js";

// Current rule: one batch, one price, one file. 1-10 appearances at 100 fen
// each with no bundle discount and no total cap, and no separate "delivery"
// purchase after a pass. docs/WORK_PLAN_BASIC_FREE_PAID_PACKS.zh-CN.md §2-§3.
test("a batch prices every selected appearance at 100 fen, not the batch as a whole", async () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const service = new GongdeOrderService(new InMemoryPaymentStore(), () => now);
  const selected = ["official.chick-pecking", "official.hamster-wheel", "official.lucky-cat"];
  const checkout = await service.createMockCheckout({
    channel: "wechat", purchaseKind: "appearance-batch", assetIds: selected
  });
  assert.equal(checkout.amountFen, selected.length * 100);
  assert.deepEqual(checkout.assetIds, selected);
  // The batch itself is the delivery: paying it grants one entitlement per asset.
  const paid = await service.completeMockPayment(checkout.orderNo);
  assert.equal(paid.entitlements.length, selected.length);
  assert.deepEqual(paid.entitlements.map(item => item.assetId).sort(), [...selected].sort());
  assert.ok(paid.entitlements.every(item => item.scope === "asset-download"));
});

test("a batch accepts ten appearances and rejects eleven", async () => {
  const service = new GongdeOrderService(new InMemoryPaymentStore(),
    () => new Date("2026-09-30T00:00:00.000Z"));
  const ten = OFFICIAL_ASSET_IDS.slice(0, MAX_ASSETS_PER_DELIVERY);
  assert.equal(ten.length, 10);
  const order = await service.createMockCheckout({
    channel: "wechat", purchaseKind: "appearance-batch", assetIds: ten
  });
  assert.equal(order.amountFen, 1000);
  assert.deepEqual(order.assetIds, ten);
  await assert.rejects(
    () => service.createMockCheckout({
      channel: "wechat", purchaseKind: "appearance-batch",
      assetIds: OFFICIAL_ASSET_IDS.slice(0, MAX_ASSETS_PER_DELIVERY + 1)
    }),
    /asset_selection_limit_exceeded/
  );
  // Duplicate ids collapse before the limit is applied, so they cannot pad a batch.
  const duplicated = await service.createMockCheckout({
    channel: "wechat", purchaseKind: "appearance-batch",
    assetIds: [ten[0], ten[0], ten[1]]
  });
  assert.equal(duplicated.amountFen, 200);
  assert.deepEqual(duplicated.assetIds, [ten[0], ten[1]]);
});
