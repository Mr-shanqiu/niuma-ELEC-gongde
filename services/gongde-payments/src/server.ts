import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { MockSmsSender, SmsVerificationService } from "./auth/sms-verification.js";
import type { SmsVerificationPort } from "./auth/sms-verification.js";
import { RedisSmsVerificationService } from "./auth/redis-sms-verification.js";
import { loadTencentSmsRuntime } from "./auth/tencent-cloud-sms.js";
import { GongdeOrderService } from "./domain/order-service.js";
import { InMemoryPaymentStore } from "./domain/store.js";
import type { PaymentStore } from "./domain/store.js";
import { loadGongdeMySqlConfiguration, MySqlPaymentStore } from "./storage/mysql-store.js";
import { AppearancePackSigner, loadPackSignerConfiguration } from "./delivery/pack-signer.js";
import type { PaymentChannel, PurchaseKind } from "./domain/types.js";
import { WechatPayNativeClient } from "./payments/providers/wechat-native/native.js";
import { parseWechatPayRuntimeConfiguration } from "./payments/providers/wechat-native/runtimeConfig.js";
import { WechatPayError } from "./payments/providers/wechat-native/types.js";
import { AlipayPageClient } from "./payments/providers/alipay-page/client.js";
import { parseAlipayRuntimeConfiguration } from "./payments/providers/alipay-page/runtimeConfig.js";
import { AlipayError } from "./payments/providers/alipay-page/types.js";
import { toDataURL } from "qrcode";
import { zipSync } from "fflate";

const mode = process.env.GONGDE_PAYMENT_MODE ?? "disabled";
if (!new Set(["disabled", "mock", "live"]).has(mode)) throw new Error("invalid_payment_mode");
const testToken = process.env.GONGDE_PAYMENT_TEST_TOKEN ?? "";
if (mode === "mock" && testToken.length < 24) throw new Error("mock_mode_requires_strong_test_token");
const smsMode = process.env.GONGDE_SMS_MODE ?? "disabled";
if (!new Set(["disabled", "mock", "live"]).has(smsMode)) throw new Error("invalid_sms_mode");
if (smsMode === "mock" && testToken.length < 24) throw new Error("mock_sms_requires_strong_test_token");
const packMode = process.env.GONGDE_PACK_DELIVERY_MODE ?? "disabled";
if (packMode !== "disabled" && packMode !== "local") throw new Error("invalid_pack_delivery_mode");

const storeMode = process.env.GONGDE_STORE_MODE ?? "memory";
if (storeMode !== "memory" && storeMode !== "mysql") throw new Error("invalid_store_mode");
if (mode === "live" && storeMode !== "mysql") throw new Error("live_payment_requires_mysql_store");
const store: PaymentStore = storeMode === "mysql"
  ? MySqlPaymentStore.connect(loadGongdeMySqlConfiguration())
  : new InMemoryPaymentStore();
const service = new GongdeOrderService(store);
const wechatPay = mode === "live" ? new WechatPayNativeClient(parseWechatPayRuntimeConfiguration(process.env)) : null;
const alipay = mode === "live" ? new AlipayPageClient(parseAlipayRuntimeConfiguration(process.env)) : null;
if (mode === "live" && !wechatPay?.enabled && !alipay?.enabled) throw new Error("live_payment_requires_provider");
const packSigner = packMode === "local" ? new AppearancePackSigner(loadPackSignerConfiguration()) : null;
const liveSms = smsMode === "live" ? loadTencentSmsRuntime() : null;
const sms: SmsVerificationPort = liveSms
  ? RedisSmsVerificationService.connect(
    liveSms.redisUrl,
    liveSms.sender,
    liveSms.identitySecret,
    process.env.NODE_ENV ?? "production"
  )
  : new SmsVerificationService(new MockSmsSender(), randomBytes(32));
const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, maximumBytes = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > maximumBytes) throw new Error("request_too_large");
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse(await readBody(request)) as Record<string, unknown>;
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function paymentDescription(kind: PurchaseKind): string {
  return kind === "official-pass" ? "牛马电子功德-官方形象通行证"
    : kind === "asset-delivery" ? "牛马电子功德-形象包生成"
      : "牛马电子功德-自愿赞赏";
}

async function refreshPaidOrder(orderNo: string, buyerToken: string) {
  let result = await service.getOrder(orderNo, buyerToken);
  if (mode !== "live" || result.order.state !== "PENDING_PAYMENT") return result;
  try {
    if (result.order.channel === "wechat" && wechatPay?.enabled) {
      const state = await wechatPay.queryOrder(orderNo);
      if (state.tradeState === "SUCCESS" && state.transactionId && state.paidAt) {
        await service.completePayment({ orderNo, channel: "wechat", providerTransactionId: state.transactionId, amountFen: state.amountFen, paidAt: state.paidAt });
      }
    } else if (result.order.channel === "alipay" && alipay?.enabled) {
      const state = await alipay.queryOrder(orderNo);
      if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(state.tradeState) && state.transactionId && state.paidAt) {
        await service.completePayment({ orderNo, channel: "alipay", providerTransactionId: state.transactionId, amountFen: state.amountFen, paidAt: state.paidAt });
      }
    }
    result = await service.getOrder(orderNo, buyerToken);
  } catch (error) {
    if (!(error instanceof WechatPayError) && !(error instanceof AlipayError)) throw error;
  }
  return result;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { ok: true, mode, smsMode, storeMode, packMode });
    }
    if (request.method === "GET" && url.pathname === "/api/live") {
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/ready") {
      const [storeReady, smsReady] = await Promise.all([store.ready(), sms.ready()]);
      const paymentReady = mode !== "live" || Boolean(wechatPay?.enabled || alipay?.enabled);
      return json(response, storeReady && smsReady && paymentReady ? 200 : 503, { ok: storeReady && smsReady && paymentReady, storeReady, smsReady, paymentReady });
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/auth/sms/request") {
      if (smsMode === "disabled") return json(response, 503, { error: "sms_not_enabled" });
      const body = await readJson(request);
      if (typeof body.phone !== "string") return json(response, 400, { error: "invalid_phone" });
      const exposeCode = smsMode === "mock" && request.headers["x-gongde-test-token"] === testToken;
      return json(response, 201, await sms.requestCode(body.phone, request.socket.remoteAddress ?? "unknown", exposeCode));
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/auth/sms/verify") {
      if (smsMode === "disabled") return json(response, 503, { error: "sms_not_enabled" });
      const body = await readJson(request);
      if (typeof body.phone !== "string" || typeof body.challengeId !== "string" || typeof body.code !== "string") {
        return json(response, 400, { error: "invalid_verification_request" });
      }
      return json(response, 200, await sms.verifyCode(body.phone, body.challengeId, body.code));
    }
    if (request.method === "GET" && url.pathname === "/api/gongde/account") {
      const sessionHeader = request.headers["x-gongde-phone-session"];
      if (Array.isArray(sessionHeader)) return json(response, 400, { error: "invalid_phone_session" });
      return json(response, 200, await service.getAccount(await sms.requireSession(sessionHeader ?? "")));
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/checkout") {
      if (mode === "disabled") return json(response, 503, { error: "payment_not_enabled" });
      const body = await readJson(request);
      const channel = body.channel;
      const purchaseKind = body.purchaseKind;
      if (channel !== "wechat" && channel !== "alipay") return json(response, 400, { error: "invalid_channel" });
      if (purchaseKind !== "official-pass" && purchaseKind !== "asset-delivery" && purchaseKind !== "support") {
        return json(response, 400, { error: "invalid_purchase_kind" });
      }
      const sessionHeader = request.headers["x-gongde-phone-session"];
      if (Array.isArray(sessionHeader)) return json(response, 400, { error: "invalid_phone_session" });
      const userId = purchaseKind === "support" ? null : await sms.requireSession(sessionHeader ?? "");
      const input = {
        channel: channel as PaymentChannel,
        purchaseKind: purchaseKind as PurchaseKind,
        userId,
        assetId: typeof body.assetId === "string" ? body.assetId : null,
        assetIds: Array.isArray(body.assetIds) ? body.assetIds.filter((item): item is string => typeof item === "string") : undefined,
        amountFen: typeof body.amountFen === "number" ? body.amountFen : undefined
      };
      if (mode === "mock") return json(response, 201, await service.createMockCheckout(input));
      return json(response, 201, await service.createLiveCheckout(input, async (order) => {
        if (channel === "wechat") {
          if (!wechatPay?.enabled) throw new Error("wechat_payment_not_enabled");
          const checkout = await wechatPay.createNativeOrder({ orderNo: order.orderNo, description: paymentDescription(order.purchaseKind), amountFen: order.amountFen, expiresAt: order.expiresAt });
          return { kind: "wechat-native", codeUrl: checkout.codeUrl, qrDataUrl: await toDataURL(checkout.codeUrl, { width: 260, margin: 1, errorCorrectionLevel: "M" }) };
        }
        if (!alipay?.enabled) throw new Error("alipay_not_enabled");
        const checkout = alipay.buildPagePaymentUrl({ orderNo: order.orderNo, subject: paymentDescription(order.purchaseKind), amountFen: order.amountFen, expiresAt: order.expiresAt });
        return { kind: "alipay-page", redirectUrl: checkout.redirectUrl };
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/payments/wechat/notify") {
      if (!wechatPay?.enabled) return json(response, 503, { code: "FAIL", message: "未启用" });
      const raw = await readBody(request, 1024 * 1024);
      const fact = wechatPay.verifyAndDecodeNotification(raw, {
        timestamp: header(request, "wechatpay-timestamp"), nonce: header(request, "wechatpay-nonce"),
        signature: header(request, "wechatpay-signature"), serial: header(request, "wechatpay-serial")
      });
      if (fact.tradeState !== "SUCCESS") throw new Error("wechat_payment_not_successful");
      if (fact.appId !== wechatPay.config.appId || fact.merchantId !== wechatPay.config.merchantId) {
        throw new Error("wechat_payment_identity_mismatch");
      }
      await service.completePayment({ orderNo: fact.orderNo, channel: "wechat", providerTransactionId: fact.transactionId, amountFen: fact.amountFen, paidAt: fact.paidAt });
      return json(response, 200, { code: "SUCCESS", message: "成功" });
    }
    if (request.method === "POST" && url.pathname === "/api/gongde/payments/alipay/notify") {
      if (!alipay?.enabled) return json(response, 503, { error: "alipay_not_enabled" });
      const fact = alipay.verifyAndDecodeNotification(await readBody(request, 64 * 1024));
      if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(fact.tradeState)) {
        await service.completePayment({ orderNo: fact.orderNo, channel: "alipay", providerTransactionId: fact.transactionId, amountFen: fact.amountFen, paidAt: fact.paidAt });
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("success");
      return;
    }
    const payMatch = url.pathname.match(/^\/api\/gongde\/test\/orders\/([A-Z0-9]+)\/pay$/u);
    if (request.method === "POST" && payMatch) {
      if (mode !== "mock" || request.headers["x-gongde-test-token"] !== testToken) {
        return json(response, 404, { error: "not_found" });
      }
      return json(response, 200, await service.completeMockPayment(payMatch[1]));
    }
    const orderMatch = url.pathname.match(/^\/api\/gongde\/orders\/([A-Z0-9]+)$/u);
    if (request.method === "GET" && orderMatch) {
      return json(response, 200, await refreshPaidOrder(orderMatch[1], bearer(request)));
    }
    const packMatch = url.pathname.match(/^\/api\/gongde\/orders\/([A-Z0-9]+)\/package$/u);
    if (request.method === "GET" && packMatch) {
      if (!packSigner) return json(response, 503, { error: "pack_delivery_not_enabled" });
      const result = await service.getOrder(packMatch[1], bearer(request));
      const now = new Date();
      const deliveries = result.entitlements.filter((item) =>
        item.scope === "asset-download" && item.state === "ACTIVE" && item.assetId && item.activatedAt && item.expiresAt && item.expiresAt > now
      );
      if (deliveries.length < 1) {
        return json(response, 410, { error: "pack_delivery_expired_or_missing" });
      }
      const packs = deliveries.map((delivery) => packSigner.build({
        assetId: delivery.assetId!,
        downloadId: delivery.id,
        issuedAt: delivery.activatedAt!,
        expiresAt: delivery.expiresAt!
      }));
      const multiple = packs.length > 1;
      const content = multiple
        ? Buffer.from(zipSync(Object.fromEntries(packs.map((pack) => [pack.filename, pack.content])), { level: 0 }))
        : packs[0].content;
      const filename = multiple ? `niuma-appearance-packs-${packMatch[1]}.zip` : packs[0].filename;
      const importBefore = deliveries.reduce((earliest, item) => item.expiresAt! < earliest ? item.expiresAt! : earliest, deliveries[0].expiresAt!);
      response.writeHead(200, {
        "content-type": multiple ? "application/zip" : "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(content.length),
        "cache-control": "private, no-store",
        "x-gongde-import-before": importBefore.toISOString(),
        "x-gongde-pack-count": String(packs.length)
      });
      response.end(content);
      return;
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message === "order_access_denied" ? 403
      : message === "order_not_found" ? 404
        : message.includes("not_enabled") ? 503
          : error instanceof WechatPayError || error instanceof AlipayError ? 502
            : 400;
    const publicMessage = error instanceof WechatPayError || error instanceof AlipayError ? error.code : message;
    return json(response, status, { error: publicMessage });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`gongde-payments listening on ${host}:${port} mode=${mode}\n`);
});

server.on("close", () => { void Promise.allSettled([sms.close(), store.close()]); });
