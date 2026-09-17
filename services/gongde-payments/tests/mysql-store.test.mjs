import assert from "node:assert/strict";
import test from "node:test";

import { MySqlPaymentStore } from "../dist/storage/mysql-store.js";

class FakeExecutor {
  constructor(results = []) {
    this.results = [...results];
    this.calls = [];
  }

  async execute(sql, params = []) {
    this.calls.push({ sql, params });
    return this.results.shift() ?? [[], []];
  }
}

function entitlement(overrides = {}) {
  return {
    id: "ent_test",
    orderNo: "NGDTESTORDER",
    userId: "phone_0123456789abcdef0123456789abcdef",
    productId: "official-asset-delivery",
    scope: "asset-download",
    assetId: "official.chick-pecking",
    state: "ACTIVE",
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    activatedAt: new Date("2026-09-17T00:00:00.000Z"),
    expiresAt: new Date("2026-09-18T00:00:00.000Z"),
    revokedAt: null,
    ...overrides
  };
}

test("MySQL delivery uniqueness is per order while the official pass remains unique per user", async () => {
  const executor = new FakeExecutor();
  const store = new MySqlPaymentStore(executor);
  await store.insertEntitlement(entitlement());
  await store.insertEntitlement(entitlement({
    id: "ent_pass",
    scope: "official-character-pass",
    assetId: null,
    productId: "official-character-pass"
  }));
  assert.equal(executor.calls[0].params[6], "official.chick-pecking:NGDTESTORDER");
  assert.equal(executor.calls[1].params[6], "pass");
});

test("transactional MySQL reads lock the order row before idempotent fulfillment", async () => {
  const executor = new FakeExecutor();
  const store = new MySqlPaymentStore(executor, null, true);
  await store.findOrder("NGDTESTORDER");
  assert.match(executor.calls[0].sql, /FOR UPDATE$/u);
});
