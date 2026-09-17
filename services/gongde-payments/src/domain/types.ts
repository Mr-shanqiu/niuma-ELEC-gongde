export type PaymentChannel = "wechat" | "alipay";
export type PurchaseKind = "official-pass" | "asset-delivery" | "support";
export type OrderState =
  | "PENDING_PAYMENT"
  | "PAID"
  | "FULFILLED"
  | "EXPIRED"
  | "CANCELED"
  | "EXCEPTION"
  | "REFUND_PENDING"
  | "REFUNDED";
export type EntitlementState = "PENDING" | "ACTIVE" | "REVOKE_PENDING" | "REVOKED";

export interface GongdeOrder {
  orderNo: string;
  productId: string;
  productVersion: number;
  channel: PaymentChannel;
  purchaseKind: PurchaseKind;
  userId: string | null;
  assetId: string | null;
  assetIds: string[];
  amountFen: number;
  currency: "CNY";
  state: OrderState;
  buyerTokenDigest: string;
  providerTransactionId: string | null;
  createdAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
}

export interface GongdeEntitlement {
  id: string;
  orderNo: string;
  userId: string;
  productId: string;
  scope: "official-character-pass" | "asset-download";
  assetId: string | null;
  state: EntitlementState;
  createdAt: Date;
  activatedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface CheckoutResult {
  orderNo: string;
  buyerToken: string;
  amountFen: number;
  currency: "CNY";
  expiresAt: string;
  channel: PaymentChannel;
  purchaseKind: PurchaseKind;
  assetId: string | null;
  assetIds: string[];
  checkout:
    | { kind: "mock"; reference: string }
    | { kind: "wechat-native"; codeUrl: string; qrDataUrl: string }
    | { kind: "alipay-page"; redirectUrl: string };
}
