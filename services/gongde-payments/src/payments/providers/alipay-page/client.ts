import crypto from "node:crypto";
import type { AlipayRuntimeConfiguration } from "./runtimeConfig.js";
import {
  AlipayError,
  type AlipayAdapter,
  type AlipayOrderState,
  type AlipayPagePaymentInput,
  type AlipayWapPaymentInput,
  type AlipayPaymentNotification,
  type AlipayRefundInput,
  type AlipayRefundState
} from "./types.js";

const ORDER_NO = /^[A-Za-z0-9_-]{6,32}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_NOTIFY_BYTES = 64 * 1024;
const MAX_NOTIFY_FIELDS = 64;
const INVALID_PERCENT = /%(?![0-9A-Fa-f]{2})/u;

function digest(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compactJson(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

function amountText(amountFen: number) {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new AlipayError("ALIPAY_AMOUNT_INVALID", "支付宝金额格式不正确");
  return `${Math.floor(amountFen / 100)}.${String(amountFen % 100).padStart(2, "0")}`;
}

function amountFen(value: unknown) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(text)) throw new AlipayError("ALIPAY_RESPONSE_INVALID", "支付宝金额格式不正确");
  const [yuan, fraction = ""] = text.split(".");
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result < 0) throw new AlipayError("ALIPAY_RESPONSE_INVALID", "支付宝金额超出范围");
  return result;
}

function alipayDate(value: unknown) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)) return null;
  const parsed = new Date(`${text.replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function shanghaiTimestamp(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const take = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${take("year")}-${take("month")}-${take("day")} ${take("hour")}:${take("minute")}:${take("second")}`;
}

function canonical(params: Readonly<Record<string, string>>, notification = false) {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && (!notification || key !== "sign_type") && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function parseNotificationForm(rawBody: string) {
  if (!rawBody || Buffer.byteLength(rawBody, "utf8") > MAX_NOTIFY_BYTES || rawBody.includes("\0")) {
    throw new AlipayError("ALIPAY_NOTIFICATION_INVALID", "支付宝通知格式不正确");
  }
  const fields = rawBody.split("&");
  if (fields.length === 0 || fields.length > MAX_NOTIFY_FIELDS) throw new AlipayError("ALIPAY_NOTIFICATION_INVALID", "支付宝通知字段数量不正确");
  const params: Record<string, string> = {};
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator <= 0) throw new AlipayError("ALIPAY_NOTIFICATION_INVALID", "支付宝通知字段格式不正确");
    const encodedKey = field.slice(0, separator);
    const encodedValue = field.slice(separator + 1);
    if (INVALID_PERCENT.test(encodedKey) || INVALID_PERCENT.test(encodedValue)) throw new AlipayError("ALIPAY_NOTIFICATION_INVALID", "支付宝通知编码不正确");
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(encodedKey.replace(/\+/gu, " "));
      value = decodeURIComponent(encodedValue.replace(/\+/gu, " "));
    } catch {
      throw new AlipayError("ALIPAY_NOTIFICATION_INVALID", "支付宝通知编码不正确");
    }
    if (!key || key in params || key.includes("\0") || value.includes("\0")) throw new AlipayError("ALIPAY_NOTIFICATION_INVALID", "支付宝通知字段重复或为空");
    params[key] = value;
  }
  return params;
}

function responseObjectSlice(raw: string, responseKey: string) {
  const marker = JSON.stringify(responseKey);
  const keyIndex = raw.indexOf(marker);
  if (keyIndex < 0) throw new AlipayError("ALIPAY_RESPONSE_INVALID", "支付宝响应缺少业务节点");
  let cursor = raw.indexOf(":", keyIndex + marker.length) + 1;
  while (/\s/u.test(raw[cursor] ?? "")) cursor += 1;
  if (raw[cursor] !== "{") throw new AlipayError("ALIPAY_RESPONSE_INVALID", "支付宝响应业务节点格式不正确");
  const start = cursor;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (; cursor < raw.length; cursor += 1) {
    const character = raw[cursor]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return raw.slice(start, cursor + 1);
  }
  throw new AlipayError("ALIPAY_RESPONSE_INVALID", "支付宝响应业务节点未闭合");
}

async function boundedResponseText(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AlipayError("ALIPAY_RESPONSE_TOO_LARGE", "支付宝响应过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

export class AlipayPageClient implements AlipayAdapter {
  readonly enabled: boolean;
  readonly wapEnabled: boolean;
  constructor(readonly config: AlipayRuntimeConfiguration, readonly now = () => new Date()) {
    this.enabled = config.enabled;
    this.wapEnabled = config.enabled && config.wapEnabled;
  }

  private requireReady() {
    if (!this.enabled || !this.config.appPrivateKey || !this.config.alipayPublicKey) {
      throw new AlipayError("ALIPAY_DISABLED", "支付宝支付暂未开放");
    }
  }

  private sign(content: string) {
    this.requireReady();
    return crypto.sign("RSA-SHA256", Buffer.from(content, "utf8"), this.config.appPrivateKey!).toString("base64");
  }

  private verify(content: string, signature: string) {
    this.requireReady();
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(signature)) {
      throw new AlipayError("ALIPAY_SIGNATURE_INVALID", "支付宝签名格式不正确");
    }
    const bytes = Buffer.from(signature, "base64");
    if (!signature || bytes.length === 0 || !crypto.verify("RSA-SHA256", Buffer.from(content, "utf8"), this.config.alipayPublicKey!, bytes)) {
      throw new AlipayError("ALIPAY_SIGNATURE_INVALID", "支付宝签名校验失败");
    }
  }

  private common(method: string, bizContent: Record<string, unknown>, includeCallbacks = false) {
    const params: Record<string, string> = {
      app_id: this.config.appId,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: shanghaiTimestamp(this.now()),
      version: "1.0",
      biz_content: compactJson(bizContent)
    };
    if (includeCallbacks) {
      params.notify_url = this.config.notifyUrl;
      params.return_url = this.config.returnUrl;
    }
    params.sign = this.sign(canonical(params));
    return params;
  }

  buildPagePaymentUrl(input: AlipayPagePaymentInput) {
    if (!ORDER_NO.test(input.orderNo) || !input.subject.trim() || input.subject.length > 256 || !(input.expiresAt instanceof Date)) {
      throw new AlipayError("ALIPAY_ORDER_INVALID", "支付宝订单格式不正确");
    }
    const params = this.common("alipay.trade.page.pay", {
      out_trade_no: input.orderNo,
      product_code: "FAST_INSTANT_TRADE_PAY",
      subject: input.subject,
      total_amount: amountText(input.amountFen),
      timeout_express: "15m"
    }, true);
    const search = new URLSearchParams(params).toString();
    const redirectUrl = `${this.config.gatewayUrl}?${search}`;
    return { redirectUrl, responseDigest: digest(redirectUrl) };
  }

  buildWapPaymentUrl(input: AlipayWapPaymentInput) {
    if (!this.wapEnabled) throw new AlipayError("ALIPAY_WAP_DISABLED", "支付宝手机网站支付暂未开放");
    if (!ORDER_NO.test(input.orderNo) || !input.subject.trim() || input.subject.length > 256 || !(input.expiresAt instanceof Date)) {
      throw new AlipayError("ALIPAY_ORDER_INVALID", "支付宝订单格式不正确");
    }
    const params = this.common("alipay.trade.wap.pay", {
      out_trade_no: input.orderNo,
      product_code: "QUICK_WAP_WAY",
      subject: input.subject,
      total_amount: amountText(input.amountFen),
      timeout_express: "15m",
      quit_url: this.config.returnUrl
    }, true);
    const redirectUrl = `${this.config.gatewayUrl}?${new URLSearchParams(params).toString()}`;
    return { redirectUrl, responseDigest: digest(redirectUrl) };
  }

  private async request(method: string, bizContent: Record<string, unknown>, mutating = false) {
    this.requireReady();
    let response: Response;
    try {
      response = await fetch(this.config.gatewayUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8", accept: "application/json" },
        body: new URLSearchParams(this.common(method, bizContent)).toString(),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new AlipayError(mutating ? "ALIPAY_RESPONSE_UNKNOWN" : "ALIPAY_REQUEST_FAILED", "支付宝接口暂时不可用", mutating);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (!response.ok || declaredLength > MAX_RESPONSE_BYTES) {
      throw new AlipayError(mutating ? "ALIPAY_RESPONSE_UNKNOWN" : "ALIPAY_REQUEST_FAILED", "支付宝接口响应异常", mutating);
    }
    let raw: string;
    try {
      raw = await boundedResponseText(response);
    } catch {
      throw new AlipayError(mutating ? "ALIPAY_RESPONSE_UNKNOWN" : "ALIPAY_RESPONSE_INVALID", "支付宝响应过大", mutating);
    }
    const key = `${method.replace(/\./gu, "_")}_response`;
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(raw) as Record<string, unknown>; } catch { throw new AlipayError(mutating ? "ALIPAY_RESPONSE_UNKNOWN" : "ALIPAY_RESPONSE_INVALID", "支付宝响应格式不正确", mutating); }
    const responseNode = envelope[key];
    const signature = String(envelope.sign ?? "");
    if (!responseNode || typeof responseNode !== "object" || Array.isArray(responseNode) || !signature) {
      throw new AlipayError(mutating ? "ALIPAY_RESPONSE_UNKNOWN" : "ALIPAY_RESPONSE_INVALID", "支付宝响应签名节点缺失", mutating);
    }
    try { this.verify(responseObjectSlice(raw, key), signature); } catch (error) {
      if (mutating) throw new AlipayError("ALIPAY_RESPONSE_UNKNOWN", "支付宝写入结果无法确认", true);
      throw error;
    }
    const node = responseNode as Record<string, unknown>;
    if (String(node.code ?? "") !== "10000") throw new AlipayError(`ALIPAY_API_${String(node.sub_code ?? node.code ?? "UNKNOWN")}`, "支付宝未接受本次请求");
    return { node, responseDigest: digest(raw) };
  }

  async queryOrder(orderNo: string): Promise<AlipayOrderState> {
    if (!ORDER_NO.test(orderNo)) throw new AlipayError("ALIPAY_ORDER_INVALID", "支付宝订单号格式不正确");
    let queried: { node: Record<string, unknown>; responseDigest: string };
    try {
      queried = await this.request("alipay.trade.query", { out_trade_no: orderNo });
    } catch (error) {
      if (error instanceof AlipayError && error.code.includes("TRADE_NOT_EXIST")) {
        return {
          orderNo, appId: this.config.appId, sellerId: this.config.sellerId,
          transactionId: null, tradeState: "NOT_EXIST", currency: "CNY",
          amountFen: 0, paidAt: null, responseDigest: digest(error.code)
        };
      }
      throw error;
    }
    const { node, responseDigest } = queried;
    if (String(node.out_trade_no ?? "") !== orderNo) throw new AlipayError("ALIPAY_RESPONSE_INVALID", "支付宝查单结果与原订单不一致");
    const tradeState = String(node.trade_status ?? "");
    return {
      orderNo,
      appId: this.config.appId,
      sellerId: String(node.seller_id ?? this.config.sellerId),
      transactionId: node.trade_no ? String(node.trade_no) : null,
      tradeState,
      currency: "CNY",
      amountFen: amountFen(node.total_amount),
      paidAt: ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(tradeState) ? alipayDate(node.send_pay_date) : null,
      responseDigest
    };
  }

  async closeOrder(orderNo: string) {
    if (!ORDER_NO.test(orderNo)) throw new AlipayError("ALIPAY_ORDER_INVALID", "支付宝订单号格式不正确");
    const { node } = await this.request("alipay.trade.close", { out_trade_no: orderNo }, true);
    if (String(node.out_trade_no ?? orderNo) !== orderNo) throw new AlipayError("ALIPAY_RESPONSE_UNKNOWN", "支付宝关单结果无法确认", true);
  }

  async createRefund(input: AlipayRefundInput): Promise<AlipayRefundState> {
    if (!ORDER_NO.test(input.orderNo) || !ORDER_NO.test(input.refundNo)) throw new AlipayError("ALIPAY_REFUND_INVALID", "支付宝退款单号格式不正确");
    const { node, responseDigest } = await this.request("alipay.trade.refund", {
      out_trade_no: input.orderNo,
      out_request_no: input.refundNo,
      refund_amount: amountText(input.refundAmountFen),
      refund_reason: input.reason.slice(0, 256)
    }, true);
    if (String(node.out_trade_no ?? "") !== input.orderNo || amountFen(node.refund_fee) !== input.refundAmountFen) {
      throw new AlipayError("ALIPAY_RESPONSE_UNKNOWN", "支付宝退款结果与原申请不一致", true);
    }
    return {
      orderNo: input.orderNo,
      refundNo: input.refundNo,
      providerRefundId: String(node.trade_no ?? input.refundNo),
      status: String(node.fund_change ?? "N") === "Y" ? "SUCCESS" : "PROCESSING",
      currency: "CNY",
      refundAmountFen: input.refundAmountFen,
      totalAmountFen: input.totalAmountFen,
      successAt: String(node.fund_change ?? "N") === "Y" ? this.now() : null,
      responseDigest
    };
  }

  async queryRefund(orderNo: string, refundNo: string): Promise<AlipayRefundState> {
    if (!ORDER_NO.test(orderNo) || !ORDER_NO.test(refundNo)) throw new AlipayError("ALIPAY_REFUND_INVALID", "支付宝退款单号格式不正确");
    const { node, responseDigest } = await this.request("alipay.trade.fastpay.refund.query", { out_trade_no: orderNo, out_request_no: refundNo });
    if (String(node.out_trade_no ?? "") !== orderNo || String(node.out_request_no ?? "") !== refundNo) {
      throw new AlipayError("ALIPAY_RESPONSE_INVALID", "支付宝退款查询结果与原申请不一致");
    }
    const refunded = amountFen(node.refund_amount);
    return {
      orderNo,
      refundNo,
      providerRefundId: String(node.trade_no ?? refundNo),
      status: refunded > 0 ? "SUCCESS" : "PROCESSING",
      currency: "CNY",
      refundAmountFen: refunded,
      totalAmountFen: amountFen(node.total_amount),
      successAt: refunded > 0 ? alipayDate(node.gmt_refund_pay) ?? this.now() : null,
      responseDigest
    };
  }

  verifyAndDecodeNotification(rawBody: string): AlipayPaymentNotification {
    const params = parseNotificationForm(rawBody);
    if (params.sign_type !== "RSA2" || !params.sign) throw new AlipayError("ALIPAY_SIGNATURE_INVALID", "支付宝通知签名类型不正确");
    this.verify(canonical(params, true), params.sign);
    if (params.app_id !== this.config.appId || (this.config.sellerId && params.seller_id !== this.config.sellerId)) {
      throw new AlipayError("ALIPAY_NOTIFICATION_MISMATCH", "支付宝通知商户信息不匹配");
    }
    const paidAt = alipayDate(params.gmt_payment);
    if (!ORDER_NO.test(params.out_trade_no ?? "") || !params.trade_no || !params.trade_status || !paidAt) {
      throw new AlipayError("ALIPAY_NOTIFICATION_INVALID", "支付宝付款通知字段不完整");
    }
    const providerNotificationId = params.notify_id || `${params.trade_no}:${params.trade_status}`;
    return {
      notificationId: providerNotificationId.length <= 56
        ? `alipay:${providerNotificationId}`
        : `alipay:${digest(providerNotificationId).slice(0, 57)}`,
      orderNo: params.out_trade_no!,
      transactionId: params.trade_no,
      tradeState: params.trade_status,
      appId: params.app_id,
      sellerId: params.seller_id ?? "",
      currency: "CNY",
      amountFen: amountFen(params.total_amount),
      paidAt,
      bodyDigest: digest(rawBody)
    };
  }
}
