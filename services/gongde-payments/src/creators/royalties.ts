import { CreatorError, type PayoutState } from "./types.js";
import { splitAmountFen, type MarketOrderLine } from "./pricing.js";

export interface RoyaltySale {
  creatorId: string;
  orderNo: string;
  lineNo: number;
  amountFen: number;
  idempotencyKey: string;
  availableAt: Date;
  revenueRuleVersion: string;
}

export function saleRoyalty(
  orderNo: string, line: MarketOrderLine, paidAt: Date, holdDays: number
): RoyaltySale | null {
  if (!/^[A-Za-z0-9_-]{1,48}$/u.test(orderNo) ||
      !(paidAt instanceof Date) || !Number.isFinite(paidAt.getTime()) ||
      !Number.isInteger(holdDays) || holdDays < 0 || holdDays > 90 ||
      !Number.isInteger(line.lineNo) || line.lineNo < 1 || line.lineNo > 10) {
    throw new CreatorError("creator_royalty_input_invalid");
  }
  if (line.source === "official" || line.amountFen === 0) return null;
  const expected = splitAmountFen(line.amountFen, line.creatorShareBps);
  if (!line.creatorId || !/^[a-f0-9]{32}$/u.test(line.creatorId) ||
      !line.revenueRuleVersion || line.creatorAmountFen !== expected.creatorAmountFen ||
      line.platformAmountFen !== expected.platformAmountFen) {
    throw new CreatorError("creator_royalty_snapshot_invalid", 409);
  }
  return {
    creatorId: line.creatorId, orderNo, lineNo: line.lineNo,
    amountFen: expected.creatorAmountFen,
    idempotencyKey: "sale:" + orderNo + ":" + line.lineNo,
    availableAt: new Date(paidAt.getTime() + holdDays * 86400000),
    revenueRuleVersion: line.revenueRuleVersion
  };
}

// Use cumulative confirmed refunds, so repeated partial refunds cannot drift by one fen.
export function refundRoyaltyDelta(input: {
  paidFen: number; previousRefundedFen: number; totalRefundedFen: number; creatorShareBps: number;
}): { refundFen: number; creatorReversalFen: number; platformReversalFen: number } {
  const { paidFen, previousRefundedFen, totalRefundedFen, creatorShareBps } = input;
  if (![paidFen, previousRefundedFen, totalRefundedFen].every(Number.isSafeInteger) ||
      paidFen < 0 || previousRefundedFen < 0 || totalRefundedFen < previousRefundedFen ||
      totalRefundedFen > paidFen) {
    throw new CreatorError("creator_refund_amount_invalid");
  }
  const before = splitAmountFen(paidFen - previousRefundedFen, creatorShareBps);
  const after = splitAmountFen(paidFen - totalRefundedFen, creatorShareBps);
  const refundFen = totalRefundedFen - previousRefundedFen;
  const creatorReversalFen = before.creatorAmountFen - after.creatorAmountFen;
  return { refundFen, creatorReversalFen, platformReversalFen: refundFen - creatorReversalFen };
}

const PAYOUT_TRANSITIONS: Readonly<Record<PayoutState, readonly PayoutState[]>> = Object.freeze({
  DRAFT: ["PENDING_APPROVAL", "CANCELED"],
  PENDING_APPROVAL: ["APPROVED", "CANCELED"],
  APPROVED: ["SUBMITTED", "CANCELED"],
  SUBMITTED: ["AWAITING_CONFIRMATION", "UNKNOWN", "SUCCEEDED", "FAILED", "CANCELED"],
  AWAITING_CONFIRMATION: ["UNKNOWN", "SUCCEEDED", "FAILED", "CANCELED"],
  UNKNOWN: ["AWAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "CANCELED"],
  SUCCEEDED: [], FAILED: [], CANCELED: []
});

export function requirePayoutTransition(
  from: PayoutState, to: PayoutState, evidence: "local-approval" | "provider-confirmed"
): void {
  if (!PAYOUT_TRANSITIONS[from]?.includes(to)) {
    throw new CreatorError("creator_payout_transition_invalid", 409);
  }
  const requiresProvider = from === "SUBMITTED" || from === "AWAITING_CONFIRMATION" || from === "UNKNOWN";
  if (requiresProvider && evidence !== "provider-confirmed") {
    throw new CreatorError("creator_payout_provider_evidence_required", 409);
  }
}
