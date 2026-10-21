import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GongdeOrderService } from "../dist/domain/order-service.js";
import { InMemoryPaymentStore } from "../dist/domain/store.js";
import { OFFICIAL_ASSET_IDS, appearanceBatchPriceFen } from "../dist/domain/catalog.js";
import { PrivatePackageStore } from "../dist/delivery/private-package-store.js";

// Current rule: every appearance costs 100 fen, no bundle discount and no
// total cap, 1-10 per batch. docs/WORK_PLAN_BASIC_FREE_PAID_PACKS.zh-CN.md §2.
for (let count = 1; count <= 10; count += 1) {
  test(`anonymous batch of ${count} packs costs ${count * 100} fen`, async () => {
    const store = new InMemoryPaymentStore();
    const service = new GongdeOrderService(store);
    const checkout = await service.createMockCheckout({
      channel: "wechat", purchaseKind: "appearance-batch",
      assetIds: OFFICIAL_ASSET_IDS.slice(0, count), amountFen: 1
    });
    assert.equal(checkout.amountFen, count * 100);
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
  assert.equal(next.amountFen, 200);
  assert.equal((await service.getOrder(next.orderNo, next.buyerToken)).order.state, "PENDING_PAYMENT");
});

// Legacy products (official-pass, asset-delivery) can no longer be ordered:
// createPendingOrder only accepts "appearance-batch". Historical orders are
// still honoured at the amount they were saved with, so this loads one
// directly into the store instead of opening the old product up again.
const LEGACY_CODE = "GD-2222-3333-4444-5555-6666";
const LEGACY_CODE_DIGEST = createHash("sha256").update(LEGACY_CODE).digest("hex");

function legacyOrder(overrides = {}) {
  return {
    orderNo: "GD_20260101120000AABBCCDDEE",
    productId: "official-pass",
    productVersion: 1,
    purchaseKind: "official-pass",
    channel: "wechat",
    amountFen: 20,
    state: "FULFILLED",
    userId: null,
    accessId: "legacy-access-id",
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    paidAt: new Date("2026-01-01T12:01:00.000Z"),
    ...overrides
  };
}

test("a historical order keeps its saved amount and is never repriced", async () => {
  const store = new InMemoryPaymentStore();
  await store.insertAccessAccount({
    id: "legacy-access-id", codeDigest: LEGACY_CODE_DIGEST, codeHint: "GD-…6666",
    state: "ACTIVE", createdAt: new Date("2026-01-01T11:00:00.000Z"), activatedAt: new Date("2026-01-01T12:01:00.000Z")
  });
  await store.insertOrder(legacyOrder(), []);
  await store.insertEntitlement({
    id: "legacy-pass-entitlement", orderNo: "GD_20260101120000AABBCCDDEE", userId: "legacy-access-id",
    productId: "official-pass", scope: "official-character-pass", assetId: null,
    state: "ACTIVE", createdAt: new Date("2026-01-01T12:01:00.000Z"),
    activatedAt: new Date("2026-01-01T12:01:00.000Z"), expiresAt: null, revokedAt: null
  });

  const service = new GongdeOrderService(store);
  const access = await service.getAccess(LEGACY_CODE);
  assert.equal(access.ownsOfficialPass, true);
  // Reading it back must not apply the current 100-fen rule.
  const stored = await store.findOrder("GD_20260101120000AABBCCDDEE");
  assert.equal(stored.amountFen, 20);
});

test("the retired products cannot be ordered again", async () => {
  const service = new GongdeOrderService(new InMemoryPaymentStore());
  for (const purchaseKind of ["official-pass", "asset-delivery"]) {
    await assert.rejects(
      () => service.createMockCheckout({ channel: "wechat", purchaseKind, assetIds: OFFICIAL_ASSET_IDS.slice(0, 5) }),
      /invalid_purchase_kind/
    );
  }
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
