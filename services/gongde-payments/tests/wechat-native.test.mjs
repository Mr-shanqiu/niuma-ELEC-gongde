import assert from "node:assert/strict";
import {
  createCipheriv,
  generateKeyPairSync,
  sign as rsaSign
} from "node:crypto";
import test from "node:test";

import {
  parseWechatPayRuntimeConfiguration,
  WechatPayError,
  WechatPayNativeClient
} from "../dist/payments/providers/wechat-native/index.js";

const { privateKey: merchantPrivateKey, publicKey: merchantPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: platformPrivateKey, publicKey: platformPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = new Date("2026-09-08T12:00:00.000Z");
const apiV3Key = "0123456789abcdef0123456789abcdef";

function config(overrides = {}) {
  return parseWechatPayRuntimeConfiguration({
    WECHAT_PAY_ENABLED: "true",
    WECHAT_PAY_APP_ID: "wx-test-app-01",
    WECHAT_PAY_MCH_ID: "1900000001",
    WECHAT_PAY_MERCHANT_SERIAL_NO: "AABBCCDDEEFF0011",
    WECHAT_PAY_MERCHANT_PRIVATE_KEY: merchantPrivateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_011234",
    WECHAT_PAY_PUBLIC_KEY: platformPublicKey.export({ type: "spki", format: "pem" }).toString(),
    WECHAT_PAY_API_V3_KEY: apiV3Key,
    WECHAT_PAY_NOTIFY_URL: "https://api.example.test/api/gongde/payments/wechat/notify",
    ...overrides
  });
}

function signedHeaders(body, timestamp = String(Math.floor(now.getTime() / 1000)), nonce = "notification-nonce") {
  return {
    timestamp,
    nonce,
    serial: "PUB_KEY_ID_011234",
    signature: rsaSign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), platformPrivateKey).toString("base64")
  };
}

function signedResponse(body, status = 200, nonce = "response-nonce") {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return new Response(status === 204 ? null : body, { status, headers: body ? {
    "Wechatpay-Timestamp": timestamp,
    "Wechatpay-Nonce": nonce,
    "Wechatpay-Serial": "PUB_KEY_ID_011234",
    "Wechatpay-Signature": rsaSign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), platformPrivateKey).toString("base64")
  } : {} });
}

function encryptedNotification(transaction) {
  const nonce = "paynonce0012";
  const associatedData = "transaction";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    id: "notification-001",
    event_type: "TRANSACTION.SUCCESS",
    resource: {
      original_type: "transaction",
      algorithm: "AEAD_AES_256_GCM",
      ciphertext: encrypted.toString("base64"),
      associated_data: associatedData,
      nonce
    }
  });
}

function encryptedRefundNotification(refund) {
  const nonce = "refundnonce1";
  const associatedData = "refund";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(refund)), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    id: "refund-notification-001",
    event_type: "REFUND.SUCCESS",
    resource: { original_type: "refund", algorithm: "AEAD_AES_256_GCM", ciphertext: encrypted.toString("base64"), associated_data: associatedData, nonce }
  });
}

test("disabled configuration exposes no key material", () => {
  const parsed = parseWechatPayRuntimeConfiguration({});
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.merchantPrivateKey, null);
  assert.equal(parsed.apiV3Key.length, 0);
});

test("enabled configuration rejects incomplete or unsafe callback settings", () => {
  assert.throws(() => parseWechatPayRuntimeConfiguration({ WECHAT_PAY_ENABLED: "true" }), /WECHAT_PAY_APP_ID/u);
  assert.throws(() => config({ WECHAT_PAY_NOTIFY_URL: "https://api.example.test/callback?secret=value" }), /must not contain query/u);
  assert.throws(() => config({ WECHAT_PAY_API_V3_KEY: "too-short" }), /exactly 32/u);
});

test("native order signs request and verifies the signed response", async () => {
  let captured;
  const request = async (url, init) => {
    captured = { url, init };
    const body = JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=test-value" });
    return new Response(body, { status: 200, headers: {
      "Wechatpay-Timestamp": String(Math.floor(now.getTime() / 1000)),
      "Wechatpay-Nonce": "response-nonce",
      "Wechatpay-Serial": "PUB_KEY_ID_011234",
      "Wechatpay-Signature": rsaSign(
        "RSA-SHA256",
        Buffer.from(`${Math.floor(now.getTime() / 1000)}\nresponse-nonce\n${body}\n`),
        platformPrivateKey
      ).toString("base64")
    } });
  };
  const client = new WechatPayNativeClient(config(), request, () => now);
  const result = await client.createNativeOrder({
    orderNo: "NGD202609080000000001",
    description: "牛马电子功德季度广告支持版",
    amountFen: 5800,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000)
  });
  assert.match(result.codeUrl, /^weixin:\/\/wxpay\//u);
  assert.equal(captured.url, "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
  assert.match(captured.init.headers.Authorization, /^WECHATPAY2-SHA256-RSA2048 /u);
  assert.equal(captured.init.headers["Wechatpay-Serial"], "PUB_KEY_ID_011234");
  const requestBody = JSON.parse(captured.init.body);
  assert.equal(requestBody.amount.total, 5800);
  assert.equal(requestBody.amount.currency, "CNY");
  assert.equal(requestBody.out_trade_no, "NGD202609080000000001");
  assert.equal(requestBody.notify_url, "https://api.example.test/api/gongde/payments/wechat/notify");
  assert.ok(merchantPublicKey);
});

test("response uncertainty never fabricates a replacement payment code", async () => {
  const client = new WechatPayNativeClient(config(), async () => { throw new Error("timeout"); }, () => now);
  await assert.rejects(
    client.createNativeOrder({ orderNo: "NGD202609080000000002", description: "牛马电子功德", amountFen: 18800, expiresAt: new Date(now.getTime() + 900_000) }),
    (error) => error instanceof WechatPayError && error.code === "WECHAT_PAY_RESPONSE_UNKNOWN" && error.retryable
  );
});

test("original-order query uses the merchant-bound path and verifies the signed payment fact", async () => {
  let captured;
  const body = JSON.stringify({
    appid: "wx-test-app-01",
    mchid: "1900000001",
    out_trade_no: "NGD202609080000000005",
    transaction_id: "420000000020260908000000005",
    trade_state: "SUCCESS",
    success_time: "2026-09-08T20:00:00+08:00",
    amount: { total: 18800, currency: "CNY" }
  });
  const client = new WechatPayNativeClient(config(), async (url, init) => {
    captured = { url, init };
    return signedResponse(body);
  }, () => now);
  const result = await client.queryOrder("NGD202609080000000005");
  assert.equal(captured.url, "https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/NGD202609080000000005?mchid=1900000001");
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.body, undefined);
  assert.equal(captured.init.headers["Wechatpay-Serial"], "PUB_KEY_ID_011234");
  assert.equal(result.tradeState, "SUCCESS");
  assert.equal(result.appId, "wx-test-app-01");
  assert.equal(result.merchantId, "1900000001");
  assert.equal(result.amountFen, 18800);
  assert.equal(result.paidAt.toISOString(), "2026-09-08T12:00:00.000Z");
});

test("close order signs the exact original-order endpoint and sends only the merchant id", async () => {
  let captured;
  const client = new WechatPayNativeClient(config(), async (url, init) => {
    captured = { url, init };
    return signedResponse("", 204);
  }, () => now);
  await client.closeOrder("NGD202609080000000006");
  assert.equal(captured.url, "https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/NGD202609080000000006/close");
  assert.equal(captured.init.method, "POST");
  assert.deepEqual(JSON.parse(captured.init.body), { mchid: "1900000001" });
});

test("valid callback is verified, decrypted and projected", () => {
  const transaction = {
    appid: "wx-test-app-01",
    mchid: "1900000001",
    out_trade_no: "NGD202609080000000003",
    transaction_id: "420000000020260908000000001",
    trade_state: "SUCCESS",
    success_time: "2026-09-08T20:00:00+08:00",
    amount: { total: 58800, currency: "CNY" }
  };
  const body = encryptedNotification(transaction);
  const result = new WechatPayNativeClient(config(), fetch, () => now).verifyAndDecodeNotification(body, signedHeaders(body));
  assert.equal(result.notificationId, "notification-001");
  assert.equal(result.orderNo, transaction.out_trade_no);
  assert.equal(result.amountFen, 58800);
  assert.equal(result.currency, "CNY");
  assert.equal(result.paidAt.toISOString(), "2026-09-08T12:00:00.000Z");
});

test("invalid, stale or unknown-key callback signatures are rejected before decryption", () => {
  const body = encryptedNotification({
    appid: "wx-test-app-01", mchid: "1900000001", out_trade_no: "NGD202609080000000004",
    transaction_id: "420000000020260908000000002", trade_state: "SUCCESS",
    success_time: "2026-09-08T20:00:00+08:00", amount: { total: 5800, currency: "CNY" }
  });
  const client = new WechatPayNativeClient(config(), fetch, () => now);
  assert.throws(() => client.verifyAndDecodeNotification(`${body} `, signedHeaders(body)), /签名校验失败/u);
  assert.throws(() => client.verifyAndDecodeNotification(body, signedHeaders(body, "1788800000")), /签名时间无效/u);
  assert.throws(() => client.verifyAndDecodeNotification(body, { ...signedHeaders(body), serial: "PUB_KEY_ID_UNKNOWN" }), /验签密钥不匹配/u);
});

test("refund submission uses the original order and preserves provider processing state", async () => {
  let captured;
  const responseBody = JSON.stringify({
    refund_id: "50000000382019052709732678859",
    out_refund_no: "NGR202609080000000001",
    out_trade_no: "NGD202609080000000001",
    status: "PROCESSING",
    amount: { refund: 3093, total: 5800, currency: "CNY" }
  });
  const client = new WechatPayNativeClient(config(), async (url, init) => {
    captured = { url, init };
    return signedResponse(responseBody);
  }, () => now);
  const result = await client.createRefund({
    orderNo: "NGD202609080000000001",
    refundNo: "NGR202609080000000001",
    reason: "形象包交付失败",
    refundAmountFen: 3093,
    totalAmountFen: 5800
  });
  assert.equal(captured.url, "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.out_trade_no, "NGD202609080000000001");
  assert.equal(body.out_refund_no, "NGR202609080000000001");
  assert.equal(body.notify_url, "https://api.example.test/api/gongde/payments/wechat/refund-notify");
  assert.deepEqual(body.amount, { refund: 3093, total: 5800, currency: "CNY" });
  assert.equal(result.status, "PROCESSING");
});

test("refund query and signed success notification stay distinct from provider acceptance", async () => {
  const responseBody = JSON.stringify({
    refund_id: "50000000382019052709732678859",
    out_refund_no: "NGR202609080000000002",
    out_trade_no: "NGD202609080000000002",
    status: "SUCCESS",
    success_time: "2026-09-08T20:00:00+08:00",
    amount: { refund: 15040, total: 18800, currency: "CNY" }
  });
  let requestedUrl = "";
  const client = new WechatPayNativeClient(config(), async (url) => {
    requestedUrl = String(url);
    return signedResponse(responseBody);
  }, () => now);
  const queried = await client.queryRefund("NGR202609080000000002");
  assert.equal(requestedUrl, "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/NGR202609080000000002");
  assert.equal(queried.status, "SUCCESS");
  assert.equal(queried.successAt.toISOString(), "2026-09-08T12:00:00.000Z");

  const notificationBody = encryptedRefundNotification({
    mchid: "1900000001",
    out_trade_no: "NGD202609080000000002",
    out_refund_no: "NGR202609080000000002",
    refund_id: "50000000382019052709732678859",
    refund_status: "SUCCESS",
    success_time: "2026-09-08T20:00:00+08:00",
    amount: { total: 18800, refund: 15040, payer_total: 18800, payer_refund: 15040 }
  });
  const decoded = client.verifyAndDecodeRefundNotification(notificationBody, signedHeaders(notificationBody));
  assert.equal(decoded.eventType, "REFUND.SUCCESS");
  assert.equal(decoded.refundAmountFen, 15040);
  assert.equal(decoded.successAt.toISOString(), "2026-09-08T12:00:00.000Z");
});
