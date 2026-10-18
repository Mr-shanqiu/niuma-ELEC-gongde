export type AlipayPagePaymentInput = Readonly<{
  orderNo: string;
  subject: string;
  amountFen: number;
  expiresAt: Date;
}>;

export type AlipayPagePayment = Readonly<{
  redirectUrl: string;
  responseDigest: string;
}>;

export type AlipayWapPaymentInput = AlipayPagePaymentInput;
export type AlipayWapPayment = AlipayPagePayment;

export type AlipayOrderState = Readonly<{
  orderNo: string;
  appId: string;
  sellerId: string;
  transactionId: string | null;
  tradeState: string;
  currency: "CNY";
  amountFen: number;
  paidAt: Date | null;
  responseDigest: string;
}>;

export type AlipayRefundInput = Readonly<{
  orderNo: string;
  refundNo: string;
  reason: string;
  refundAmountFen: number;
  totalAmountFen: number;
}>;

export type AlipayRefundState = Readonly<{
  orderNo: string;
  refundNo: string;
  providerRefundId: string;
  status: string;
  currency: "CNY";
  refundAmountFen: number;
  totalAmountFen: number;
  successAt: Date | null;
  responseDigest: string;
}>;

export type AlipayPaymentNotification = Readonly<{
  notificationId: string;
  orderNo: string;
  transactionId: string;
  tradeState: string;
  appId: string;
  sellerId: string;
  currency: "CNY";
  amountFen: number;
  paidAt: Date;
  bodyDigest: string;
}>;

export interface AlipayAdapter {
  readonly enabled: boolean;
  readonly wapEnabled: boolean;
  buildPagePaymentUrl(input: AlipayPagePaymentInput): AlipayPagePayment;
  buildWapPaymentUrl(input: AlipayWapPaymentInput): AlipayWapPayment;
  queryOrder(orderNo: string): Promise<AlipayOrderState>;
  closeOrder(orderNo: string): Promise<void>;
  createRefund(input: AlipayRefundInput): Promise<AlipayRefundState>;
  queryRefund(orderNo: string, refundNo: string): Promise<AlipayRefundState>;
  verifyAndDecodeNotification(rawBody: string): AlipayPaymentNotification;
}

export class AlipayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly responseUnknown = false
  ) {
    super(message);
    this.name = "AlipayError";
  }
}
