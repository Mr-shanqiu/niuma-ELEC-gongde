import { appearanceBatchPriceFen, MAX_ASSETS_PER_DELIVERY, OFFICIAL_ASSET_IDS } from "../domain/catalog.js";
import { CreatorError, creatorWorkId } from "./types.js";
import {
  MARKET_BATCH_BYTES, requireCreatorAccess, requireCreatorPaidSales,
  type CreatorFeatureFlags
} from "./policy.js";

interface CatalogBase {
  assetId: string;
  revision: string;
  versionLabel: string;
  titleZh: string;
  publicationState: "PUBLISHED";
  deliveryBytesUpperBound: number;
}

export type ResolvedMarketItem = CatalogBase & (
  | { source: "official"; creatorId: null; priceFen: 20; versionId: null;
      creatorShareBps: 0; revenueRuleVersion: null }
  | { source: "creator"; creatorId: string; slug: string; priceFen: number; versionId: string;
      creatorShareBps: 0; revenueRuleVersion: "creator-paid-distribution-v1"; creatorState: "ACTIVE" }
);

export interface MarketOrderLine {
  lineNo: number;
  source: "official" | "creator";
  assetId: string;
  creatorId: string | null;
  versionId: string | null;
  versionLabel: string;
  revision: string;
  titleZh: string;
  unitPriceFen: number;
  amountFen: number;
  creatorShareBps: number;
  creatorAmountFen: number;
  platformAmountFen: number;
  revenueRuleVersion: string | null;
}

export function splitAmountFen(
  amountFen: number, creatorShareBps: number
): { creatorAmountFen: number; platformAmountFen: number } {
  if (!Number.isSafeInteger(amountFen) || amountFen < 0 ||
      !Number.isInteger(creatorShareBps) || creatorShareBps < 0 || creatorShareBps > 10000) {
    throw new CreatorError("creator_split_input_invalid");
  }
  const creatorAmountFen = Number(BigInt(amountFen) * BigInt(creatorShareBps) / 10000n);
  return { creatorAmountFen, platformAmountFen: amountFen - creatorAmountFen };
}

// Callers must resolve these snapshots from the authoritative catalog, never a request body.
export function quoteMarketBatch(
  items: readonly ResolvedMarketItem[], flags: CreatorFeatureFlags
): { amountFen: number; currency: "CNY"; deliveryBytesUpperBound: number; lines: MarketOrderLine[] } {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ASSETS_PER_DELIVERY) {
    throw new CreatorError("market_selection_limit_exceeded");
  }
  const seen = new Set<string>();
  let deliveryBytes = 512 + items.length * 256;
  for (const item of items) {
    if (!item || seen.has(item.assetId) || item.publicationState !== "PUBLISHED" ||
        !/^[a-f0-9]{64}$/u.test(item.revision) ||
        !Number.isSafeInteger(item.deliveryBytesUpperBound) || item.deliveryBytesUpperBound < 1) {
      throw new CreatorError("market_catalog_snapshot_invalid", 409);
    }
    seen.add(item.assetId);
    deliveryBytes += item.deliveryBytesUpperBound;
    if (!Number.isSafeInteger(deliveryBytes) || deliveryBytes > MARKET_BATCH_BYTES) {
      throw new CreatorError("market_batch_delivery_too_large", 413);
    }
    if (item.source === "official") {
      if (!OFFICIAL_ASSET_IDS.includes(item.assetId) || item.priceFen !== 20 ||
          item.creatorId !== null || item.creatorShareBps !== 0) {
        throw new CreatorError("market_official_snapshot_invalid", 409);
      }
    } else if (item.source === "creator") {
      requireCreatorAccess(flags);
      if (item.assetId !== creatorWorkId(item.creatorId, item.slug) ||
          !/^[a-f0-9]{32}$/u.test(item.versionId) || item.creatorState !== "ACTIVE" ||
          item.priceFen !== 20 || item.creatorShareBps !== 0 ||
          item.revenueRuleVersion !== "creator-paid-distribution-v1") {
        throw new CreatorError("market_creator_snapshot_invalid", 409);
      }
      requireCreatorPaidSales(flags);
    } else {
      throw new CreatorError("market_source_invalid", 409);
    }
  }

  const batchAmount = appearanceBatchPriceFen(items.length);
  const batchBase = Math.floor(batchAmount / items.length);
  const batchRemainder = batchAmount % items.length;
  const batchAllocations = new Map(items.map((item, index) =>
    [item.assetId, batchBase + (index < batchRemainder ? 1 : 0)] as const));

  const lines: MarketOrderLine[] = items.map((item, index) => {
    const amountFen = batchAllocations.get(item.assetId)!;
    return {
      lineNo: index + 1, source: item.source, assetId: item.assetId,
      creatorId: item.creatorId, versionId: item.versionId,
      versionLabel: item.versionLabel, revision: item.revision, titleZh: item.titleZh,
      unitPriceFen: 20, amountFen, creatorShareBps: 0,
      creatorAmountFen: 0, platformAmountFen: amountFen,
      revenueRuleVersion: item.source === "creator" ? item.revenueRuleVersion : null
    };
  });
  return {
    amountFen: lines.reduce((sum, line) => sum + line.amountFen, 0),
    currency: "CNY", deliveryBytesUpperBound: deliveryBytes, lines
  };
}
