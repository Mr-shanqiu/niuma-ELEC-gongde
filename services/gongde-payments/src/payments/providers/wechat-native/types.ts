export type WechatPayNativeOrderInput = Readonly<{
  orderNo: string;
  description: string;
  amountFen: number;
  expiresAt: Date;
}>;

export type WechatPayNativeOrder = Readonly<{
  codeUrl: string;
  responseDigest: string;
}>;

export type WechatPayOrderState = Readonly<{
  orderNo: string;
  appId: string;
  merchantId: string;
  transactionId: string | null;
  tradeState: string;
  currency: string;
  amountFen: number;
  paidAt: Date | null;
  responseDigest: string;
}>;

export type WechatPayRefundInput = Readonly<{
  orderNo: string;
  refundNo: string;
  reason: string;
  refundAmountFen: number;
  totalAmountFen: number;
}>;

export type WechatPayRefundState = Readonly<{
  orderNo: string;
  refundNo: string;
  providerRefundId: string;
  status: string;
  currency: string;
  refundAmountFen: number;
  totalAmountFen: number;
  successAt: Date | null;
  responseDigest: string;
}>;

export type WechatPayNotification = Readonly<{
  notificationId: string;
  eventType: string;
  orderNo: string;
  transactionId: string;
  tradeState: string;
  appId: string;
  merchantId: string;
  currency: string;
  amountFen: number;
  paidAt: Date;
  bodyDigest: string;
}>;

export type WechatPayRefundNotification = Readonly<{
  notificationId: string;
  eventType: string;
  orderNo: string;
  refundNo: string;
  providerRefundId: string;
  status: string;
  merchantId: string;
  currency: string;
  refundAmountFen: number;
  totalAmountFen: number;
  successAt: Date | null;
  bodyDigest: string;
}>;

export type WechatPayNotificationHeaders = Readonly<{
  timestamp: string;
  nonce: string;
  signature: string;
  serial: string;
}>;

export interface WechatPayAdapter {
  readonly enabled: boolean;
  createNativeOrder(input: WechatPayNativeOrderInput): Promise<WechatPayNativeOrder>;
  queryOrder(orderNo: string): Promise<WechatPayOrderState>;
  closeOrder(orderNo: string): Promise<void>;
  createRefund(input: WechatPayRefundInput): Promise<WechatPayRefundState>;
  queryRefund(refundNo: string): Promise<WechatPayRefundState>;
  verifyAndDecodeNotification(
    rawBody: string,
    headers: WechatPayNotificationHeaders
  ): WechatPayNotification;
  verifyAndDecodeRefundNotification(
    rawBody: string,
    headers: WechatPayNotificationHeaders
  ): WechatPayRefundNotification;
}

export class WechatPayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "WechatPayError";
  }
}
