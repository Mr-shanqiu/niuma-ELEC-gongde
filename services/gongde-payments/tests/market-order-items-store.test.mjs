import assert from "node:assert/strict";
import test from "node:test";

import { MySqlPaymentStore } from "../dist/storage/mysql-store.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";

const at = new Date("2026-10-07T00:00:00.000Z");
const revision = "a".repeat(64);

function order(overrides = {}) {
  return {
    orderNo: "GD_MARKET_SNAPSHOT_TEST",
    productId: "official-appearance-batch",
    productVersion: 1,
    channel: "wechat",
    purchaseKind: "appearance-batch",
    userId: null,
    assetId: null,
    assetIds: ["official.lucky-cat", "creator.work.one"],
    amountFen: 40,
    currency: "CNY",
    state: "PENDING_PAYMENT",
    buyerTokenDigest: "b".repeat(64),
    providerTransactionId: null,
    createdAt: at,
    expiresAt: new Date("2026-10-07T00:15:00.000Z"),
    paidAt: null,
    fulfilledAt: null,
    ...overrides
  };
}

function item(overrides = {}) {
  return {
    sourceKind: "official",
    assetId: "official.lucky-cat",
    creatorId: null,
    workId: null,
    versionId: null,
    versionLabel: "1.0.0",
    sourceRevision: revision,
    titleZh: "招财猫",
    unitPriceFen: 20,
    amountFen: 20,
    revenueRuleVersion: null,
    createdAt: at,
    ...overrides
  };
}

class FakeConnection {
  calls = [];
  events = [];
  failOnMarketInsert = false;

  async beginTransaction() { this.events.push("begin"); }
  async commit() { this.events.push("commit"); }
  async rollback() { this.events.push("rollback"); }
  release() { this.events.push("release"); }

  async execute(sql, params = []) {
    this.calls.push({ sql, params });
    assert.equal((sql.match(/\?/gu) ?? []).length, params.length, 'SQL placeholder count must match bound values');
    if (this.failOnMarketInsert && /INSERT INTO gongde_market_order_items/u.test(sql)) {
      throw new Error("synthetic_market_item_insert_failure");
    }
    return [[], []];
  }
}

class FakePool extends FakeConnection {
  connection = new FakeConnection();
  async getConnection() { return this.connection; }
  async end() {}
}

test("market snapshots persist with the order in one transaction and freeze zero creator share", async () => {
  const pool = new FakePool();
  const store = new MySqlPaymentStore(pool, pool);
  const community = item({
    sourceKind: "community",
    assetId: "creator.work.one",
    creatorId: "c".repeat(32),
    workId: "creator.work.one",
    versionId: "d".repeat(32),
    titleZh: "社区作品"
  });

  await store.insertOrder(order(), [item(), community]);

  assert.deepEqual(pool.connection.events, ["begin", "commit", "release"]);
  assert.equal(pool.connection.calls.length, 2);
  assert.match(pool.connection.calls[0].sql, /INSERT INTO gongde_orders/u);
  assert.match(pool.connection.calls[1].sql, /INSERT INTO gongde_market_order_items/u);
  const marketParams = pool.connection.calls[1].params;
  assert.deepEqual(marketParams.slice(0, 15), [
    "GD_MARKET_SNAPSHOT_TEST", 1, "official", "official.lucky-cat", null, null, null,
    "1.0.0", revision, "招财猫", 20, 20, 20, null, at
  ]);
  assert.deepEqual(marketParams.slice(15), [
    "GD_MARKET_SNAPSHOT_TEST", 2, "community", "creator.work.one", "c".repeat(32),
    "creator.work.one", "d".repeat(32), "1.0.0", revision, "社区作品", 20, 20, 20, null, at
  ]);
});

test("a market snapshot insert failure rolls back the parent order", async () => {
  const pool = new FakePool();
  pool.connection.failOnMarketInsert = true;
  const store = new MySqlPaymentStore(pool, pool);

  await assert.rejects(store.insertOrder(order(), [item(), item({
    assetId: "official.chick-pecking", titleZh: "小鸡啄米"
  })]), /synthetic_market_item_insert_failure/u);

  assert.deepEqual(pool.connection.events, ["begin", "rollback", "release"]);
});

test("legacy order inserts remain unchanged when no market snapshots are provided", async () => {
  const pool = new FakePool();
  const store = new MySqlPaymentStore(pool, pool);
  await store.insertOrder(order({ purchaseKind: "asset-delivery", amountFen: 20, assetIds: ["official.lucky-cat"] }));
  assert.deepEqual(pool.connection.events, []);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /INSERT INTO gongde_orders/u);
});

test("in-memory market item snapshots are immutable copies with stable line numbers", async () => {
  const store = new InMemoryPaymentStore();
  const snapshots = [item(), item({ assetId: "official.chick-pecking", titleZh: "小鸡啄米" })];
  await store.insertOrder(order(), snapshots);
  snapshots[0].titleZh = "mutated after insert";
  const stored = await store.findMarketOrderItemsByOrder("GD_MARKET_SNAPSHOT_TEST");
  assert.deepEqual(stored.map(({ lineNo, titleZh, creatorShareBps, creatorAmountFen, platformAmountFen }) =>
    ({ lineNo, titleZh, creatorShareBps, creatorAmountFen, platformAmountFen })), [
    { lineNo: 1, titleZh: "招财猫", creatorShareBps: 0, creatorAmountFen: 0, platformAmountFen: 20 },
    { lineNo: 2, titleZh: "小鸡啄米", creatorShareBps: 0, creatorAmountFen: 0, platformAmountFen: 20 }
  ]);
});

test("MySQL reads persisted market item snapshots in line order", async () => {
  const executor = new FakeConnection();
  executor.execute = async (sql, params = []) => {
    executor.calls.push({ sql, params });
    return [[{
      order_no: "GD_MARKET_SNAPSHOT_TEST", line_no: 1, source_kind: "community",
      asset_id: "creator.work.one", creator_id: "c".repeat(32), work_id: "creator.work.one",
      version_id: "d".repeat(32), version_label: "1.0.0", source_revision: revision,
      title_zh: "社区作品", unit_price_fen: 20, amount_fen: 20, creator_share_bps: 0,
      creator_amount_fen: 0, platform_amount_fen: 20, revenue_rule_version: null, created_at: at
    }], []];
  };
  const store = new MySqlPaymentStore(executor);
  const result = await store.findMarketOrderItemsByOrder("GD_MARKET_SNAPSHOT_TEST");
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceKind, "community");
  assert.equal(result[0].versionId, "d".repeat(32));
  assert.equal(result[0].creatorShareBps, 0);
  assert.equal(result[0].creatorAmountFen, 0);
  assert.equal(result[0].platformAmountFen, 20);
  assert.match(executor.calls[0].sql, /ORDER BY line_no$/u);
});

test("market snapshots reject totals that disagree with the order", async () => {
  const store = new InMemoryPaymentStore();
  await assert.rejects(store.insertOrder(order({ amountFen: 21 }), [item()]), /market_order_items_total_mismatch/u);
  assert.equal(await store.findOrder("GD_MARKET_SNAPSHOT_TEST"), null);
});
