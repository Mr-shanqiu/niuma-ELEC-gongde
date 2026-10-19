import { CreatorError } from "./types.js";

export const CREATOR_PRICE_TIERS_FEN = Object.freeze([20]);
export const CREATOR_UPLOAD_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  unpackedBytes: 12 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  files: 8,
  imageDimension: 2048,
  decodedImageBytes: 64 * 1024 * 1024,
  layers: 6,
  keyframesPerLayer: 8
});
export const MARKET_BATCH_BYTES = 16 * 1024 * 1024;

// First release charges buyers only; creator revenue sharing is disabled.
export const PROPOSED_CREATOR_TERMS = Object.freeze({
  version: "creator-paid-distribution-v1",
  creatorShareBps: 0
});

export interface CreatorFeatureFlags {
  enabled: boolean;
  paidSalesEnabled: boolean;
  settlementsEnabled: boolean;
  paymentScenarioApproved: boolean;
  payoutChannelApproved: boolean;
  taxReportingReady: boolean;
  commercialTermsApproved: boolean;
  clientCompatibilityAccepted: boolean;
}

export function loadCreatorFeatureFlags(
  source: Record<string, string | undefined> = process.env
): CreatorFeatureFlags {
  const flag = (key: string): boolean => {
    const value = source[key]?.trim();
    if (value === undefined || value === "" || value === "false") return false;
    if (value === "true") return true;
    throw new CreatorError("creator_feature_flag_invalid", 503, key);
  };
  return Object.freeze({
    enabled: flag("GONGDE_CREATORS_ENABLED"),
    paidSalesEnabled: flag("GONGDE_CREATOR_PAID_SALES_ENABLED"),
    settlementsEnabled: flag("GONGDE_CREATOR_SETTLEMENTS_ENABLED"),
    paymentScenarioApproved: flag("GONGDE_CREATOR_PAYMENT_SCENARIO_APPROVED"),
    payoutChannelApproved: flag("GONGDE_CREATOR_PAYOUT_CHANNEL_APPROVED"),
    taxReportingReady: flag("GONGDE_CREATOR_TAX_REPORTING_READY"),
    commercialTermsApproved: flag("GONGDE_CREATOR_COMMERCIAL_TERMS_APPROVED"),
    clientCompatibilityAccepted: flag("GONGDE_CREATOR_CLIENT_COMPATIBILITY_ACCEPTED")
  });
}

export function requireCreatorAccess(flags: CreatorFeatureFlags): void {
  if (!flags.enabled) throw new CreatorError("creator_feature_disabled", 503);
}

export function requireCreatorPaidSales(flags: CreatorFeatureFlags): void {
  requireCreatorAccess(flags);
  if (!flags.paidSalesEnabled || !flags.paymentScenarioApproved ||
      !flags.commercialTermsApproved || !flags.clientCompatibilityAccepted) {
    throw new CreatorError("creator_paid_sales_not_ready", 503);
  }
}

export function requireCreatorSettlement(flags: CreatorFeatureFlags): void {
  requireCreatorAccess(flags);
  if (!flags.settlementsEnabled || !flags.payoutChannelApproved ||
      !flags.taxReportingReady || !flags.commercialTermsApproved) {
    throw new CreatorError("creator_settlement_not_ready", 503);
  }
}

export function requireCreatorPrice(priceFen: number): void {
  if (!Number.isSafeInteger(priceFen) || !CREATOR_PRICE_TIERS_FEN.includes(priceFen)) {
    throw new CreatorError("creator_price_tier_invalid");
  }
}
