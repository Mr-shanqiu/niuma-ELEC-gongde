import {
  createDecipheriv,
  createHash,
  randomBytes,
  sign as rsaSign,
  verify as rsaVerify
} from "node:crypto";
import { z } from "zod";
import type { WechatPayRuntimeConfiguration } from "./runtimeConfig.js";
import {
  WechatPayError,
  type WechatPayAdapter,
  type WechatPayNativeOrderInput,
  type WechatPayNotification,
  type WechatPayNotificationHeaders,
  type WechatPayRefundInput,
  type WechatPayRefundNotification
} from "./types.js";

const ORDER_NO = /^[A-Za-z0-9_-]{6,32}$/u;
const responseSchema = z.object({ code_url: z.string().url().max(512) }).passthrough();
const orderStateSchema = z.object({
  appid: z.string().min(1),
  mchid: z.string().min(1),
  out_trade_no: z.string().regex(ORDER_NO),
  transaction_id: z.string().min(1).max(64).optional(),
  trade_state: z.string().min(1).max(32),
  success_time: z.string().datetime({ offset: true }).optional(),
  amount: z.object({ total: z.number().int().positive(), currency: z.string().length(3) }).passthrough()
}).passthrough();
const notificationEnvelopeSchema = z.object({
  id: z.string().min(1).max(64),
  event_type: z.string().min(1).max(64),
  resource: z.object({
    // 微信支付 Native 回调固定带回原始资源类型；保留严格校验，
    // 只接受协议定义的字段，避免把合法回调误判为格式错误。
    original_type: z.string().min(1).max(64),
    algorithm: z.literal("AEAD_AES_256_GCM"),
    ciphertext: z.string().min(1),
    associated_data: z.string().optional().default(""),
    nonce: z.string().min(1)
  }).strict()
}).passthrough();
const transactionSchema = z.object({
  appid: z.string().min(1),
  mchid: z.string().min(1),
  out_trade_no: z.string().regex(ORDER_NO),
  transaction_id: z.string().min(1).max(64),
  trade_state: z.string().min(1).max(32),
  success_time: z.string().datetime({ offset: true }),
  amount: z.object({ total: z.number().int().positive(), currency: z.string().length(3) }).passthrough()
}).passthrough();
const refundStateSchema = z.object({
  refund_id: z.string().min(1).max(64),
  out_refund_no: z.string().regex(ORDER_NO),
  out_trade_no: z.string().regex(ORDER_NO),
  status: z.string().min(1).max(32),
  success_time: z.string().datetime({ offset: true }).optional(),
  amount: z.object({
    total: z.number().int().positive(),
    refund: z.number().int().positive(),
    currency: z.string().length(3)
  }).passthrough()
}).passthrough();
const refundNotificationSchema = z.object({
  mchid: z.string().min(1),
  out_trade_no: z.string().regex(ORDER_NO),
  out_refund_no: z.string().regex(ORDER_NO),
  refund_id: z.string().min(1).max(64),
  refund_status: z.string().min(1).max(32),
  success_time: z.string().datetime({ offset: true }).optional(),
  amount: z.object({
    total: z.number().int().positive(),
    refund: z.number().int().positive(),
    payer_total: z.number().int().positive().optional(),
    payer_refund: z.number().int().positive().optional()
  }).passthrough()
}).passthrough();

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateInput(input: WechatPayNativeOrderInput) {
  if (!ORDER_NO.test(input.orderNo)) throw new WechatPayError("WECHAT_PAY_ORDER_INVALID", "订单号格式不正确");
  if (!input.description.trim() || input.description.length > 127) throw new WechatPayError("WECHAT_PAY_ORDER_INVALID", "订单说明格式不正确");
  if (!Number.isSafeInteger(input.amountFen) || input.amountFen <= 0) throw new WechatPayError("WECHAT_PAY_ORDER_INVALID", "订单金额格式不正确");
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) throw new WechatPayError("WECHAT_PAY_ORDER_INVALID", "订单过期时间格式不正确");
}

function validateRefundInput(input: WechatPayRefundInput) {
  if (!ORDER_NO.test(input.orderNo) || !ORDER_NO.test(input.refundNo)) throw new WechatPayError("WECHAT_PAY_REFUND_INVALID", "退款单号格式不正确");
  if (!input.reason.trim() || Buffer.byteLength(input.reason.trim(), "utf8") > 80) throw new WechatPayError("WECHAT_PAY_REFUND_INVALID", "退款原因格式不正确");
  if (!Number.isSafeInteger(input.refundAmountFen) || input.refundAmountFen <= 0
    || !Number.isSafeInteger(input.totalAmountFen) || input.totalAmountFen <= 0
    || input.refundAmountFen > input.totalAmountFen) {
    throw new WechatPayError("WECHAT_PAY_REFUND_INVALID", "退款金额格式不正确");
  }
}

function signatureMessage(timestamp: string, nonce: string, body: string) {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

function responseHeaders(headers: Headers): WechatPayNotificationHeaders {
  return {
    timestamp: headers.get("wechatpay-timestamp") ?? "",
    nonce: headers.get("wechatpay-nonce") ?? "",
    signature: headers.get("wechatpay-signature") ?? "",
    serial: headers.get("wechatpay-serial") ?? ""
  };
}

export class WechatPayNativeClient implements WechatPayAdapter {
  readonly enabled: boolean;

  constructor(
    readonly config: WechatPayRuntimeConfiguration,
    readonly request: typeof fetch = fetch,
    readonly now: () => Date = () => new Date()
  ) {
    this.enabled = config.enabled;
  }

  private ensureEnabled() {
    if (!this.enabled || !this.config.merchantPrivateKey || !this.config.wechatPayPublicKey) {
      throw new WechatPayError("WECHAT_PAY_DISABLED", "微信支付暂未开放");
    }
  }

  private verifySignature(rawBody: string, headers: WechatPayNotificationHeaders) {
    this.ensureEnabled();
    if (!/^\d{10}$/u.test(headers.timestamp) || !headers.nonce || !headers.signature || !headers.serial) {
      throw new WechatPayError("WECHAT_PAY_SIGNATURE_INVALID", "微信支付签名头不完整");
    }
    const timestamp = Number(headers.timestamp);
    const skew = Math.abs(Math.floor(this.now().getTime() / 1000) - timestamp);
    if (!Number.isFinite(timestamp) || skew > 300) {
      throw new WechatPayError("WECHAT_PAY_SIGNATURE_EXPIRED", "微信支付签名时间无效");
    }
    if (headers.serial !== this.config.wechatPayPublicKeyId) {
      throw new WechatPayError("WECHAT_PAY_SIGNATURE_KEY_UNKNOWN", "微信支付验签密钥不匹配");
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(headers.signature, "base64");
    } catch {
      throw new WechatPayError("WECHAT_PAY_SIGNATURE_INVALID", "微信支付签名格式不正确");
    }
    const valid = rsaVerify("RSA-SHA256", Buffer.from(signatureMessage(headers.timestamp, headers.nonce, rawBody)), this.config.wechatPayPublicKey!, signature);
    if (!valid) throw new WechatPayError("WECHAT_PAY_SIGNATURE_INVALID", "微信支付签名校验失败");
  }

  private authorization(method: string, canonicalUrl: string, body: string) {
    this.ensureEnabled();
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const canonical = `${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = rsaSign("RSA-SHA256", Buffer.from(canonical), this.config.merchantPrivateKey!).toString("base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.merchantId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.config.merchantSerialNo}"`;
  }

  private async signedRequest(method: "GET" | "POST", canonicalUrl: string, body = "") {
    let response: Response;
    try {
      response = await this.request(`${this.config.apiOrigin}${canonicalUrl}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: this.authorization(method, canonicalUrl, body),
          "Wechatpay-Serial": this.config.wechatPayPublicKeyId,
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new WechatPayError("WECHAT_PAY_RESPONSE_UNKNOWN", "微信支付请求结果暂不确定，请查询原订单", true);
    }
    const rawResponse = await response.text();
    if (!response.ok) {
      throw new WechatPayError("WECHAT_PAY_REQUEST_REJECTED", "微信支付暂时无法完成请求", response.status >= 500);
    }
    if (rawResponse) this.verifySignature(rawResponse, responseHeaders(response.headers));
    return rawResponse;
  }

  async createNativeOrder(input: WechatPayNativeOrderInput) {
    this.ensureEnabled();
    validateInput(input);
    const pathname = "/v3/pay/transactions/native";
    const body = JSON.stringify({
      appid: this.config.appId,
      mchid: this.config.merchantId,
      description: input.description.trim(),
      out_trade_no: input.orderNo,
      time_expire: input.expiresAt.toISOString(),
      notify_url: this.config.notifyUrl,
      amount: { total: input.amountFen, currency: "CNY" }
    });
    const rawResponse = await this.signedRequest("POST", pathname, body);
    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(rawResponse));
    } catch {
      throw new WechatPayError("WECHAT_PAY_RESPONSE_INVALID", "微信支付响应格式不正确");
    }
    if (!parsed.code_url.startsWith("weixin://wxpay/")) {
      throw new WechatPayError("WECHAT_PAY_RESPONSE_INVALID", "微信支付付款码格式不正确");
    }
    return Object.freeze({ codeUrl: parsed.code_url, responseDigest: digest(rawResponse) });
  }

  async queryOrder(orderNo: string) {
    this.ensureEnabled();
    if (!ORDER_NO.test(orderNo)) throw new WechatPayError("WECHAT_PAY_ORDER_INVALID", "订单号格式不正确");
    const canonicalUrl = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(this.config.merchantId)}`;
    const rawResponse = await this.signedRequest("GET", canonicalUrl);
    let state: z.infer<typeof orderStateSchema>;
    try {
      state = orderStateSchema.parse(JSON.parse(rawResponse));
    } catch {
      throw new WechatPayError("WECHAT_PAY_RESPONSE_INVALID", "微信支付查单响应格式不正确");
    }
    if (state.out_trade_no !== orderNo || (state.trade_state === "SUCCESS" && (!state.transaction_id || !state.success_time))) {
      throw new WechatPayError("WECHAT_PAY_RESPONSE_INVALID", "微信支付查单结果与原订单不一致");
    }
    return Object.freeze({
      orderNo,
      appId: state.appid,
      merchantId: state.mchid,
      transactionId: state.transaction_id ?? null,
      tradeState: state.trade_state,
      currency: state.amount.currency,
      amountFen: state.amount.total,
      paidAt: state.success_time ? new Date(state.success_time) : null,
      responseDigest: digest(rawResponse)
    });
  }

  async closeOrder(orderNo: string) {
    this.ensureEnabled();
    if (!ORDER_NO.test(orderNo)) throw new WechatPayError("WECHAT_PAY_ORDER_INVALID", "订单号格式不正确");
    const canonicalUrl = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`;
    await this.signedRequest("POST", canonicalUrl, JSON.stringify({ mchid: this.config.merchantId }));
  }

  private projectRefund(rawResponse: string, expected: { orderNo?: string; refundNo: string }) {
    let state: z.infer<typeof refundStateSchema>;
    try {
      state = refundStateSchema.parse(JSON.parse(rawResponse));
    } catch {
      throw new WechatPayError("WECHAT_PAY_RESPONSE_INVALID", "微信退款响应格式不正确");
    }
    if (state.out_refund_no !== expected.refundNo || (expected.orderNo && state.out_trade_no !== expected.orderNo)) {
      throw new WechatPayError("WECHAT_PAY_RESPONSE_INVALID", "微信退款结果与原退款单不一致");
    }
    return Object.freeze({
      orderNo: state.out_trade_no,
      refundNo: state.out_refund_no,
      providerRefundId: state.refund_id,
      status: state.status,
      currency: state.amount.currency,
      refundAmountFen: state.amount.refund,
      totalAmountFen: state.amount.total,
      successAt: state.success_time ? new Date(state.success_time) : null,
      responseDigest: digest(rawResponse)
    });
  }

  async createRefund(input: WechatPayRefundInput) {
    this.ensureEnabled();
    validateRefundInput(input);
    const pathname = "/v3/refund/domestic/refunds";
    const body = JSON.stringify({
      out_trade_no: input.orderNo,
      out_refund_no: input.refundNo,
      reason: input.reason.trim(),
      notify_url: this.config.refundNotifyUrl,
      amount: { refund: input.refundAmountFen, total: input.totalAmountFen, currency: "CNY" }
    });
    const rawResponse = await this.signedRequest("POST", pathname, body);
    return this.projectRefund(rawResponse, { orderNo: input.orderNo, refundNo: input.refundNo });
  }

  async queryRefund(refundNo: string) {
    this.ensureEnabled();
    if (!ORDER_NO.test(refundNo)) throw new WechatPayError("WECHAT_PAY_REFUND_INVALID", "退款单号格式不正确");
    const pathname = `/v3/refund/domestic/refunds/${encodeURIComponent(refundNo)}`;
    const rawResponse = await this.signedRequest("GET", pathname);
    return this.projectRefund(rawResponse, { refundNo });
  }

  verifyAndDecodeNotification(rawBody: string, headers: WechatPayNotificationHeaders): WechatPayNotification {
    this.verifySignature(rawBody, headers);
    let envelope: z.infer<typeof notificationEnvelopeSchema>;
    try {
      envelope = notificationEnvelopeSchema.parse(JSON.parse(rawBody));
    } catch {
      throw new WechatPayError("WECHAT_PAY_NOTIFICATION_INVALID", "微信支付通知格式不正确");
    }
    const ciphertextAndTag = Buffer.from(envelope.resource.ciphertext, "base64");
    if (ciphertextAndTag.length <= 16) throw new WechatPayError("WECHAT_PAY_NOTIFICATION_INVALID", "微信支付通知密文不正确");
    const ciphertext = ciphertextAndTag.subarray(0, -16);
    const tag = ciphertextAndTag.subarray(-16);
    let plain: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.config.apiV3Key, Buffer.from(envelope.resource.nonce, "utf8"));
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(envelope.resource.associated_data, "utf8"));
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new WechatPayError("WECHAT_PAY_NOTIFICATION_DECRYPT_FAILED", "微信支付通知解密失败");
    }
    let transaction: z.infer<typeof transactionSchema>;
    try {
      transaction = transactionSchema.parse(JSON.parse(plain));
    } catch {
      throw new WechatPayError("WECHAT_PAY_NOTIFICATION_INVALID", "微信支付交易数据格式不正确");
    }
    return Object.freeze({
      notificationId: envelope.id,
      eventType: envelope.event_type,
      orderNo: transaction.out_trade_no,
      transactionId: transaction.transaction_id,
      tradeState: transaction.trade_state,
      appId: transaction.appid,
      merchantId: transaction.mchid,
      currency: transaction.amount.currency,
      amountFen: transaction.amount.total,
      paidAt: new Date(transaction.success_time),
      bodyDigest: digest(rawBody)
    });
  }

  verifyAndDecodeRefundNotification(rawBody: string, headers: WechatPayNotificationHeaders): WechatPayRefundNotification {
    this.verifySignature(rawBody, headers);
    let envelope: z.infer<typeof notificationEnvelopeSchema>;
    try {
      envelope = notificationEnvelopeSchema.parse(JSON.parse(rawBody));
    } catch {
      throw new WechatPayError("WECHAT_PAY_NOTIFICATION_INVALID", "微信退款通知格式不正确");
    }
    const ciphertextAndTag = Buffer.from(envelope.resource.ciphertext, "base64");
    if (ciphertextAndTag.length <= 16) throw new WechatPayError("WECHAT_PAY_NOTIFICATION_INVALID", "微信退款通知密文不正确");
    let plain: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.config.apiV3Key, Buffer.from(envelope.resource.nonce, "utf8"));
      decipher.setAuthTag(ciphertextAndTag.subarray(-16));
      decipher.setAAD(Buffer.from(envelope.resource.associated_data, "utf8"));
      plain = Buffer.concat([decipher.update(ciphertextAndTag.subarray(0, -16)), decipher.final()]).toString("utf8");
    } catch {
      throw new WechatPayError("WECHAT_PAY_NOTIFICATION_DECRYPT_FAILED", "微信退款通知解密失败");
    }
    let refund: z.infer<typeof refundNotificationSchema>;
    try {
      refund = refundNotificationSchema.parse(JSON.parse(plain));
    } catch {
      throw new WechatPayError("WECHAT_PAY_NOTIFICATION_INVALID", "微信退款数据格式不正确");
    }
    return Object.freeze({
      notificationId: envelope.id,
      eventType: envelope.event_type,
      orderNo: refund.out_trade_no,
      refundNo: refund.out_refund_no,
      providerRefundId: refund.refund_id,
      status: refund.refund_status,
      merchantId: refund.mchid,
      currency: "CNY",
      refundAmountFen: refund.amount.refund,
      totalAmountFen: refund.amount.total,
      successAt: refund.success_time ? new Date(refund.success_time) : null,
      bodyDigest: digest(rawBody)
    });
  }
}
