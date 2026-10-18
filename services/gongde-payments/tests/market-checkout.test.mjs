import assert from 'node:assert/strict';
import test from 'node:test';
import { GongdeOrderService } from '../dist/domain/order-service.js';
import { InMemoryPaymentStore } from '../dist/domain/store.js';

const creatorId = 'c'.repeat(32);
const at = new Date('2026-10-07T00:00:00Z');
const community = n => ({
  sourceKind: 'community', assetId: `creator.${creatorId}.work-${n}`,
  creatorId, workId: `creator.${creatorId}.work-${n}`, versionId: n.toString(16).padStart(32, '0'),
  versionLabel: '1.0.0', sourceRevision: 'a'.repeat(64), titleZh: `Work ${n}`,
  unitPriceFen: 20, revenueRuleVersion: 'creator-paid-distribution-v1'
});
const official = { sourceKind: 'official', assetId: 'official.lucky-cat', creatorId: null,
  workId: null, versionId: null, versionLabel: '1.0.0', sourceRevision: 'b'.repeat(64),
  titleZh: 'Lucky cat', unitPriceFen: 20, revenueRuleVersion: null };
const input = items => ({ channel: 'wechat', purchaseKind: 'appearance-batch',
  assetIds: items.map(item => item.assetId), marketItems: items });

test('community IDs cannot create an order without server-resolved catalog snapshots', async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store, () => at);
  await assert.rejects(service.createPendingOrder({ ...input([community(1)]), marketItems: undefined }), /asset_id_not_available/u);
  assert.equal((await store.listOrders({ limit: 100, offset: 0 })).total, 0);
});

test('mixed official/community batch pays one shared amount and freezes the reviewed versions', async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store, () => at);
  const items = [official, ...Array.from({ length: 9 }, (_, i) => community(i + 1))];
  const checkout = await service.createMockCheckout({ ...input(items), amountFen: 1 });
  assert.equal(checkout.amountFen, 100);
  assert.equal(checkout.accessCode, null);
  items[1].versionId = 'f'.repeat(32);
  const snapshots = await store.findMarketOrderItemsByOrder(checkout.orderNo);
  assert.equal(snapshots[1].versionId, '1'.padStart(32, '0'));
  assert.equal(snapshots.reduce((sum, item) => sum + item.amountFen, 0), 100);
  assert.ok(snapshots.every(item => item.unitPriceFen === 20 && item.amountFen === 10 &&
    item.creatorShareBps === 0 && item.creatorAmountFen === 0));
  assert.equal((await service.getOrder(checkout.orderNo, checkout.buyerToken)).entitlements.length, 0);
  const paid = await service.completeMockPayment(checkout.orderNo);
  assert.equal(paid.order.state, 'FULFILLED');
  assert.equal(paid.entitlements.length, 10);
  assert.ok(paid.entitlements.every(item => item.expiresAt.getTime() - at.getTime() === 86_400_000));
  await service.completeMockPayment(checkout.orderNo);
  assert.equal((await store.findEntitlementsByOrder(checkout.orderNo)).length, 10);
});

test('a community singleton is 20 fen; six appearances still cap at 100 fen with exact line allocation', async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store, () => at);
  assert.equal((await service.createMockCheckout(input([community(1)]))).amountFen, 20);
  const batch = await service.createMockCheckout(input(Array.from({ length: 6 }, (_, i) => community(i + 1))));
  assert.equal(batch.amountFen, 100);
  assert.deepEqual((await store.findMarketOrderItemsByOrder(batch.orderNo)).map(item => item.amountFen), [17, 17, 17, 17, 16, 16]);
});

test('snapshot mismatches and legacy access-code requests cannot grant community delivery', async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store, () => at);
  await assert.rejects(service.createPendingOrder({ ...input([community(1)]), assetIds: [community(2).assetId] }), /market_catalog_snapshot_invalid/u);
  await assert.rejects(service.createPendingOrder(input([{ ...community(1), unitPriceFen: 0 }])), /market_catalog_snapshot_invalid/u);
  await assert.rejects(service.createPendingOrder(input([{ ...community(1), creatorId: 'd'.repeat(32) }])), /market_catalog_snapshot_invalid/u);
  await assert.rejects(service.createPendingOrder({ ...input([community(1)]), purchaseKind: 'asset-delivery' }), /market_purchase_kind_invalid/u);
  assert.equal((await store.listOrders({ limit: 100, offset: 0 })).total, 0);
});
