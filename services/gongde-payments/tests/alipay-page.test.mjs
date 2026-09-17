import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { AlipayPageClient } from "../dist/payments/providers/alipay-page/client.js";
import { parseAlipayRuntimeConfiguration } from "../dist/payments/providers/alipay-page/runtimeConfig.js";
import { AlipayError } from "../dist/payments/providers/alipay-page/types.js";

function fixture(overrides = {}) {
  const app = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const source = {
    ALIPAY_ENABLED: "true",
    ALIPAY_APP_ID: "2021006196626768",
    ALIPAY_SELLER_ID: "2088000000000001",
    ALIPAY_APP_PRIVATE_KEY: app.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ALIPAY_PUBLIC_KEY: platform.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ALIPAY_NOTIFY_URL: "https://api.example.test/api/gongde/payments/alipay/notify",
    ALIPAY_RETURN_URL: "https://www.example.test/open/account",
    ...overrides
  };
  const config = parseAlipayRuntimeConfiguration(source);
  const client = new AlipayPageClient(config, () => new Date("2026-09-09T04:00:00.000Z"));
  return { app, platform, config, client };
}

function canonical(params, notification = false) {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && (!notification || key !== "sign_type") && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function providerSign(privateKey, content) {
  return crypto.sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64");
}

test("disabled config is inert and enabled config requires HTTPS RSA material", () => {
  assert.equal(parseAlipayRuntimeConfiguration({}).enabled, false);
  assert.throws(() => parseAlipayRuntimeConfiguration({ ALIPAY_ENABLED: "true" }), /ALIPAY_APP_ID/u);
  assert.throws(() => fixture({ ALIPAY_NOTIFY_URL: "http://example.test/notify" }), /HTTPS/u);
  assert.throws(() => fixture({ ALIPAY_RETURN_URL: "https://example.test/open?token=secret" }), /query/u);
});

test("page payment URL uses computer-website product, exact amount and RSA2", () => {
  const { app, client } = fixture();
  const payment = client.buildPagePaymentUrl({
    orderNo: "NGD202609090001",
    subject: "牛马电子功德-官方形象通行证",
    amountFen: 5800,
    expiresAt: new Date("2026-09-09T04:15:00.000Z")
  });
  const url = new URL(payment.redirectUrl);
  const params = Object.fromEntries(url.searchParams.entries());
  assert.equal(params.method, "alipay.trade.page.pay");
  assert.equal(params.sign_type, "RSA2");
  assert.equal(params.timestamp, "2026-09-09 12:00:00");
  assert.equal(params.notify_url, "https://api.example.test/api/gongde/payments/alipay/notify");
  const biz = JSON.parse(params.biz_content);
  assert.equal(biz.product_code, "FAST_INSTANT_TRADE_PAY");
  assert.equal(biz.total_amount, "58.00");
  assert.equal(biz.timeout_express, "15m");
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(canonical(params)), app.publicKey, Buffer.from(params.sign, "base64")), true);
  assert.match(payment.responseDigest, /^[a-f0-9]{64}$/u);
});

test("WAP payment is separately gated and uses the mobile-website product", () => {
  assert.throws(() => fixture().client.buildWapPaymentUrl({
    orderNo: "NGD202609090002",
    subject: "牛马电子功德-官方形象通行证",
    amountFen: 5800,
    expiresAt: new Date("2026-09-09T04:15:00.000Z")
  }), (error) => error instanceof AlipayError && error.code === "ALIPAY_WAP_DISABLED");

  const { app, client } = fixture({ ALIPAY_WAP_ENABLED: "true" });
  const payment = client.buildWapPaymentUrl({
    orderNo: "NGD202609090002",
    subject: "牛马电子功德-官方形象通行证",
    amountFen: 5800,
    expiresAt: new Date("2026-09-09T04:15:00.000Z")
  });
  const params = Object.fromEntries(new URL(payment.redirectUrl).searchParams.entries());
  const biz = JSON.parse(params.biz_content);
  assert.equal(params.method, "alipay.trade.wap.pay");
  assert.equal(biz.product_code, "QUICK_WAP_WAY");
  assert.equal(biz.quit_url, "https://www.example.test/open/account");
  assert.equal(biz.total_amount, "58.00");
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(canonical(params)), app.publicKey, Buffer.from(params.sign, "base64")), true);
});

test("signed notification is decoded only after RSA2, app, seller and amount validation", () => {
  const { platform, client } = fixture();
  const params = {
    app_id: "2021006196626768",
    seller_id: "2088000000000001",
    notify_id: "20260909000000000001",
    out_trade_no: "NGD202609090001",
    trade_no: "2026090922000000000001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "58.00",
    gmt_payment: "2026-09-09 12:01:02",
    sign_type: "RSA2"
  };
  params.sign = providerSign(platform.privateKey, canonical(params, true));
  const raw = new URLSearchParams(params).toString();
  const decoded = client.verifyAndDecodeNotification(raw);
  assert.equal(decoded.amountFen, 5800);
  assert.equal(decoded.paidAt.toISOString(), "2026-09-09T04:01:02.000Z");
  assert.match(decoded.notificationId, /^alipay:/u);

  const tampered = raw.replace("58.00", "0.01");
  assert.throws(() => client.verifyAndDecodeNotification(tampered), (error) => error instanceof AlipayError && error.code === "ALIPAY_SIGNATURE_INVALID");
  const wrongSeller = { ...params, seller_id: "2088000000000002" };
  wrongSeller.sign = providerSign(platform.privateKey, canonical(wrongSeller, true));
  assert.throws(() => client.verifyAndDecodeNotification(new URLSearchParams(wrongSeller).toString()), (error) =>
    error instanceof AlipayError && error.code === "ALIPAY_NOTIFICATION_MISMATCH");
  const wrongApp = { ...params, app_id: "2021006196626769" };
  wrongApp.sign = providerSign(platform.privateKey, canonical(wrongApp, true));
  assert.throws(() => client.verifyAndDecodeNotification(new URLSearchParams(wrongApp).toString()), (error) =>
    error instanceof AlipayError && error.code === "ALIPAY_NOTIFICATION_MISMATCH");
  assert.throws(() => client.verifyAndDecodeNotification(`${raw}&app_id=2021000000000000`), /重复/u);
  assert.throws(() => client.verifyAndDecodeNotification("app_id=%ZZ"), /编码/u);
});

test("query verifies the exact signed response node and maps provider state", async () => {
  const { platform, client } = fixture();
  const responseNode = {
    code: "10000",
    msg: "Success",
    out_trade_no: "NGD202609090001",
    trade_no: "2026090922000000000001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "58.00",
    seller_id: "2088000000000001",
    send_pay_date: "2026-09-09 12:01:02"
  };
  const signedNode = JSON.stringify(responseNode);
  const raw = `{"alipay_trade_query_response":${signedNode},"sign":"${providerSign(platform.privateKey, signedNode)}"}`;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
  try {
    const state = await client.queryOrder("NGD202609090001");
    assert.equal(state.tradeState, "TRADE_SUCCESS");
    assert.equal(state.amountFen, 5800);
    assert.equal(state.transactionId, "2026090922000000000001");
  } finally { globalThis.fetch = previous; }
});

test("tampered signed query fails closed", async () => {
  const { platform, client } = fixture();
  const original = JSON.stringify({ code: "10000", out_trade_no: "NGD202609090001", trade_status: "WAIT_BUYER_PAY", total_amount: "58.00" });
  const raw = `{"alipay_trade_query_response":${original.replace("58.00", "0.01")},"sign":"${providerSign(platform.privateKey, original)}"}`;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(raw, { status: 200 });
  try {
    await assert.rejects(client.queryOrder("NGD202609090001"), (error) => error instanceof AlipayError && error.code === "ALIPAY_SIGNATURE_INVALID");
  } finally { globalThis.fetch = previous; }
});

test("chunked responses are bounded even without a content-length header", async () => {
  const { client } = fixture();
  const previous = globalThis.fetch;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  });
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try {
    await assert.rejects(client.queryOrder("NGD202609090001"), (error) =>
      error instanceof AlipayError && error.code === "ALIPAY_RESPONSE_INVALID");
  } finally { globalThis.fetch = previous; }
});
