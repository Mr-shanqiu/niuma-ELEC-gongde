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
  unitPriceFen: 100, revenueRuleVersion: 'creator-paid-distribution-v1'
});
const official = assetId => ({ sourceKind: 'official', assetId, creatorId: null,
  workId: null, versionId: null, versionLabel: '1.0.0', sourceRevision: 'b'.repeat(64),
  titleZh: 'Official appearance', unitPriceFen: 100, revenueRuleVersion: null });
const input = items => ({ channel: 'wechat', purchaseKind: 'appearance-batch',
  assetIds: items.map(item => item.assetId), marketItems: items });

// Current product scope: public checkout sells official appearances only, and
// the server resolves every snapshot itself. docs §2 and §5/F1.
test('community IDs cannot create an order without server-resolved catalog snapshots', async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store, () => at);
  await assert.rejects(service.createPendingOrder({ ...input([community(1)]), marketItems: undefined }), /asset_id_not_available/u);
  assert.equal((await store.listOrders({ limit: 100, offset: 0 })).total, 0);
});

test('an official batch of ten costs 1000 fen and freezes the reviewed revisions', async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store, () => at);
  const ids = ['official.lucky-cat', 'official.hamster-wheel', 'official.sea-lion-belly-pat',
    'official.chick-pecking', 'zqscreen.caishen-ingot', 'zqscreen.redpanda-wave', 'zqscreen.shiba-tilt',
    'zqscreen.orange-cat-wave', 'zqscreen.raccoon-cheer', 'zqscreen.golden-toad-coin'];
  const items = ids.map(assetId => official(assetId));
  const checkout = await service.createMockCheckout({ ...input(items), amountFen: 1 });
  assert.equal(checkout.amountFen, 1000);
  assert.equal(checkout.accessCode, null);
  items[1].sourceRevision = 'f'.repeat(64);
  const snapshots = await store.findMarketOrderItemsByOrder(checkout.orderNo);
  assert.equal(snapshots[1].sourceRevision, 'b'.repeat(64));
  assert.equal(snapshots.reduce((sum, item) => sum + item.amountFen, 0), 1000);
  assert.ok(snapshots.every(item => item.unitPriceFen === 100 && item.amountFen === 100 &&
    item.creatorShareBps === 0 && item.creatorAmountFen === 0));
  assert.equal((await service.getOrder(checkout.orderNo, checkout.buyerToken)).entitlements.length, 0);
  const paid = await service.completeMockPayment(checkout.orderNo);
  assert.equal(paid.order.state, 'FULFILLED');
  assert.equal(paid.entitlements.length, 10);
  assert.ok(paid.entitlements.every(item => item.expiresAt.getTime() - at.getTime() === 86_400_000));
  await service.completeMockPayment(checkout.orderNo);
  assert.equal((await store.findEntitlementsByOrder(checkout.orderNo)).length, 10);
});

test('a community snapshot cannot be purchased even when every field looks valid', async () => {
  const store = new InMemoryPaymentStore();
  const service = new GongdeOrderService(store, () => at);
  // Each of these is a server-side snapshot inconsistency, not a client typo.
  await assert.rejects(service.createPendingOrder({ ...input([community(1)]), assetIds: [community(2).assetId] }), /market_catalog_snapshot_invalid/u);
  await assert.rejects(service.createPendingOrder(input([{ ...community(1), unitPriceFen: 0 }])), /market_catalog_snapshot_invalid/u);
  await assert.rejects(service.createPendingOrder(input([{ ...community(1), creatorId: 'd'.repeat(32) }])), /market_catalog_snapshot_invalid/u);
  await assert.rejects(service.createPendingOrder(input([official('official.lucky-cat'), community(1)])), /market_catalog_snapshot_invalid/u);
  // A retired product kind is still rejected before any snapshot is examined.
  await assert.rejects(service.createPendingOrder({ ...input([official('official.lucky-cat')]), purchaseKind: 'asset-delivery' }), /invalid_purchase_kind/u);
  assert.equal((await store.listOrders({ limit: 100, offset: 0 })).total, 0);
});
