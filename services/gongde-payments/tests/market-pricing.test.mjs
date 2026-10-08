import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteMarketBatch } from '../dist/creators/pricing.js';

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
  deliveryBytesUpperBound: 1024, priceFen: 20, creatorShareBps: 0,
  revenueRuleVersion: 'creator-paid-distribution-v1', creatorState: 'ACTIVE'
});
const official = {
  source: 'official', creatorId: null, assetId: 'official.lucky-cat', versionId: null,
  revision: 'a'.repeat(64), versionLabel: '1.0.0', titleZh: 'Lucky cat',
  publicationState: 'PUBLISHED', deliveryBytesUpperBound: 1024, priceFen: 20,
  creatorShareBps: 0, revenueRuleVersion: null
};

test('community market quotes need no creator payout or split-tax setup', () => {
  const result = quoteMarketBatch([official, ...Array.from({ length: 9 }, (_, i) => creator(i + 1))], flags);
  assert.equal(result.amountFen, 100);
  assert.equal(result.lines.length, 10);
  assert.ok(result.lines.every(line => line.unitPriceFen === 20 && line.creatorShareBps === 0 &&
    line.creatorAmountFen === 0 && line.platformAmountFen === line.amountFen));
});

test('a free legacy declaration cannot be quoted as a paid community item', () => {
  assert.throws(() => quoteMarketBatch([{ ...creator(1), revenueRuleVersion: 'creator-free-sharing-v1' }], flags),
    { code: 'market_creator_snapshot_invalid', status: 409 });
});
