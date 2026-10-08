import assert from "node:assert/strict";
import test from "node:test";
import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";
import { OFFICIAL_ASSET_IDS, appearanceBatchPriceFen } from "../dist/domain/catalog.js";
import { PrivatePackageStore } from "../dist/delivery/private-package-store.js";

for (let count = 1; count <= 10; count += 1) {
  test(`anonymous batch of ${count} packs costs ${Math.min(count * 20, 100)} fen`, async () => {
    const store = new InMemoryPaymentStore();
    const service = new GongdeOrderService(store);
    const checkout = await service.createMockCheckout({
      channel: "wechat", purchaseKind: "appearance-batch",
      assetIds: OFFICIAL_ASSET_IDS.slice(0, count), amountFen: 1
    });
    assert.equal(checkout.amountFen, Math.min(count * 20, 100));
    assert.equal(checkout.accessCode, null);
    const before = await service.getOrder(checkout.orderNo, checkout.buyerToken);
    assert.equal(before.order.userId, null);
    assert.equal(before.entitlements.length, 0);
    await assert.rejects(() => service.getOrder(checkout.orderNo, "wrong-token"), /order_access_denied/);
    const paid = await service.completeMockPayment(checkout.orderNo);
    assert.equal(paid.order.state, "FULFILLED");
    assert.equal(paid.entitlements.length, count);
    assert.ok(paid.entitlements.every(item => item.scope === "asset-download"));
    assert.ok(paid.entitlements.every(item => item.userId === `order:${checkout.orderNo}`));
    assert.ok(paid.entitlements.every(item => item.expiresAt.getTime() - paid.order.paidAt.getTime() === 86_400_000));
    const retry = await service.completeMockPayment(checkout.orderNo);
    assert.equal(retry.entitlements.length, count);
    const restored = await service.getOrder(checkout.orderNo, checkout.buyerToken);
    assert.equal(restored.order.amountFen, checkout.amountFen);
    assert.equal(restored.entitlements.length, count);
  });
}

test("the anonymous price rejects invalid counts and more than ten packs", async () => {
  for (const count of [0, -1, 1.5, 11, NaN]) assert.throws(() => appearanceBatchPriceFen(count), /asset_selection_limit_exceeded/);
  const service = new GongdeOrderService(new InMemoryPaymentStore());
  await assert.rejects(() => service.createMockCheckout({ channel: "alipay", purchaseKind: "appearance-batch", assetIds: OFFICIAL_ASSET_IDS.slice(0, 11) }), /asset_selection_limit_exceeded/);
});

test("buying a new batch requires a distinct independently charged order", async () => {
  const service = new GongdeOrderService(new InMemoryPaymentStore());
  const input = { channel: "alipay", purchaseKind: "appearance-batch", assetIds: OFFICIAL_ASSET_IDS.slice(0, 2) };
  const first = await service.createMockCheckout(input);
  await service.completeMockPayment(first.orderNo);
  const next = await service.createMockCheckout(input);
  assert.notEqual(next.orderNo, first.orderNo);
  assert.notEqual(next.buyerToken, first.buyerToken);
  assert.equal(next.amountFen, 40);
  assert.equal((await service.getOrder(next.orderNo, next.buyerToken)).order.state, "PENDING_PAYMENT");
});

test("new pricing cannot reprice or invalidate legacy access-code orders", async () => {
  const service = new GongdeOrderService(new InMemoryPaymentStore());
  const old = await service.createMockCheckout({ channel: "wechat", purchaseKind: "official-pass", assetIds: OFFICIAL_ASSET_IDS.slice(0, 5) });
  await service.completeMockPayment(old.orderNo);
  assert.equal((await service.getAccess(old.accessCode)).ownsOfficialPass, true);
  const legacy = await service.createMockCheckout({ channel: "alipay", purchaseKind: "asset-delivery", accessCode: old.accessCode, assetIds: OFFICIAL_ASSET_IDS.slice(0, 5) });
  assert.equal(legacy.amountFen, 20);
  await assert.rejects(() => service.createMockCheckout({ channel: "alipay", purchaseKind: "asset-delivery", accessCode: old.accessCode, assetIds: OFFICIAL_ASSET_IDS.slice(0, 6) }), /asset_selection_limit_exceeded/);
});

test("private COS supports ten-pack batches without public access or real requests", async () => {
  const bucket = "gongde-paid-1460392746", region = "ap-shanghai";
  const acl = { ACL: "private", Owner: { ID: "test-owner" }, Grants: [{ Grantee: { ID: "test-owner" }, Permission: "FULL_CONTROL" }] };
  const input = { orderNo: "test-pricing-order", identity: "test-pricing-batch", content: Buffer.from("synthetic-only"), filename: "test-pricing.nmgpacks", count: 10, importBefore: new Date(Date.now() + 3_600_000) };
  const client = {
    async getBucketAcl() { return acl; },
    async getBucketPolicy() { return { Policy: { Statement: [{ Effect: "Deny" }] } }; },
    async headObject() { return { headers: { "content-length": String(input.content.length) } }; },
    async putObject() { throw new Error("unexpected_real_upload"); },
    async getObjectAcl() { return acl; },
    getObjectUrl(params) {
      const now = Math.floor(Date.now() / 1000);
      return `https://${bucket}.cos.${region}.myqcloud.com/${params.Key}?q-signature=test&q-sign-time=${now};${now + params.Expires}`;
    }
  };
  const store = new PrivatePackageStore({ bucket, region, secretId: "test-only", secretKey: "test-only" }, client);
  assert.equal(new URL(await store.downloadUrl(input)).hostname, `${bucket}.cos.${region}.myqcloud.com`);
  await assert.rejects(() => store.downloadUrl({ ...input, count: 11 }), /private_package/);
});
