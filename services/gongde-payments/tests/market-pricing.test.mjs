import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteMarketBatch } from '../dist/creators/pricing.js';

// NOTE: quoteMarketBatch currently has no production caller (only royalties.ts
// references it, and royalties.ts is itself unused). These tests describe what
// the module does today; they are not evidence that a live quote path exists.
const creatorId = 'c'.repeat(32);
const flags = {
  enabled: true,
  paidSalesEnabled: true,
  settlementsEnabled: false,
  paymentScenarioApproved: true,
  payoutChannelApproved: false,
  taxReportingReady: false,
  commercialTermsApproved: true,
  clientCompatibilityAccepted: true
};
const creator = index => ({
  source: 'creator', creatorId, slug: `work-${index}`, assetId: `creator.${creatorId}.work-${index}`,
  versionId: index.toString(16).padStart(32, '0'), revision: index.toString(16).padStart(64, '0'),
  versionLabel: '1.0.0', titleZh: `Community work ${index}`, publicationState: 'PUBLISHED',
  deliveryBytesUpperBound: 1024, priceFen: 100, creatorShareBps: 0,
  revenueRuleVersion: 'creator-paid-distribution-v1', creatorState: 'ACTIVE'
});
const official = {
  source: 'official', creatorId: null, assetId: 'official.lucky-cat', versionId: null,
  revision: 'a'.repeat(64), versionLabel: '1.0.0', titleZh: 'Lucky cat',
  publicationState: 'PUBLISHED', deliveryBytesUpperBound: 1024, priceFen: 100,
  creatorShareBps: 0, revenueRuleVersion: null
};

test('market quotes charge 100 fen per item with no creator payout or split-tax setup', () => {
  const result = quoteMarketBatch([official, ...Array.from({ length: 9 }, (_, i) => creator(i + 1))], flags);
  assert.equal(result.amountFen, 1000);
  assert.equal(result.lines.length, 10);
  assert.ok(result.lines.every(line => line.unitPriceFen === 100 && line.creatorShareBps === 0 &&
    line.creatorAmountFen === 0 && line.platformAmountFen === line.amountFen));
});

test('a free legacy declaration cannot be quoted as a paid community item', () => {
  assert.throws(() => quoteMarketBatch([{ ...creator(1), revenueRuleVersion: 'creator-free-sharing-v1' }], flags),
    { code: 'market_creator_snapshot_invalid', status: 409 });
});

// The quote module hard-codes the current 100-fen unit price; an older 20-fen
// snapshot is refused rather than silently repriced.
test('a stale 20-fen snapshot is refused instead of being repriced', () => {
  assert.throws(() => quoteMarketBatch([{ ...official, priceFen: 20 }], flags),
    { code: 'market_official_snapshot_invalid', status: 409 });
  assert.throws(() => quoteMarketBatch([{ ...creator(1), priceFen: 20 }], flags),
    { code: 'market_creator_snapshot_invalid', status: 409 });
});
