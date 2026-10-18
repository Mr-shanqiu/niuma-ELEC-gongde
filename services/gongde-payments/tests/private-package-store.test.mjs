import assert from "node:assert/strict";
import test from "node:test";
import { PrivatePackageStore } from "../dist/delivery/private-package-store.js";

const configuration = {
  bucket: "gongde-paid-1460392746",
  region: "ap-shanghai",
  secretId: "test-only",
  secretKey: "test-only"
};
const privateAcl = {
  ACL: "private",
  Owner: { ID: "test-owner" },
  Grants: [{ Grantee: { ID: "test-owner" }, Permission: "FULL_CONTROL" }]
};

function fixture({ policyError, policy, bucketAcl = privateAcl, objectAcl = privateAcl } = {}) {
  const calls = { head: 0, sign: 0 };
  const input = {
    orderNo: "test-order",
    identity: "test-batch",
    content: Buffer.from("test-content"),
    filename: "test-batch.nmgpacks",
    count: 5,
    importBefore: new Date(Date.now() + 60 * 60 * 1000)
  };
  const client = {
    async getBucketAcl() { return bucketAcl; },
    async getBucketPolicy() {
      if (policyError) throw policyError;
      return { Policy: policy ?? { Statement: [{ Effect: "Deny" }] } };
    },
    async headObject() {
      calls.head += 1;
      return { headers: { "content-length": String(input.content.length) } };
    },
    async putObject() { throw new Error("unexpected_upload"); },
    async getObjectAcl() { return objectAcl; },
    getObjectUrl(params) {
      calls.sign += 1;
      const now = Math.floor(Date.now() / 1000);
      const url = new URL(`https://${configuration.bucket}.cos.${configuration.region}.myqcloud.com/${params.Key}`);
      url.searchParams.set("q-signature", "test-signature");
      url.searchParams.set("q-sign-time", `${now};${now + params.Expires}`);
      return url.toString();
    }
  };
  return { store: new PrivatePackageStore(configuration, client), input, calls };
}

for (const [label, policyError] of [
  ["legacy absence", { statusCode: 404, error: { Code: "NoSuchBucketPolicy" } }],
  ["COS absence", { statusCode: 404, error: { Code: "NoSuchPolicy" } }],
  ["COS policy-version absence", { statusCode: 404, error: { Code: "NoSuchPolicyVersion" } }],
  ["SDK normalized absence", { statusCode: 404, code: "404", message: "Policy Not found", ErrorStatus: "Policy Not Found" }],
  ["SDK nested absence", { statusCode: 404, code: "404", error: { message: "Policy Not found", ErrorStatus: "Policy Not Found" } }]
]) {
  test(`private bucket permits ${label}`, async () => {
    const { store, input, calls } = fixture({ policyError });
    const url = new URL(await store.downloadUrl(input));
    assert.equal(url.hostname, `${configuration.bucket}.cos.${configuration.region}.myqcloud.com`);
    assert.equal(calls.sign, 1);
  });
}

for (const [label, policyError] of [
  ["access denied", { statusCode: 403, code: "AccessDenied" }],
  ["unknown 404", { statusCode: 404, code: "404" }],
  ["missing bucket", { statusCode: 404, code: "404", message: "Policy Not found", ErrorStatus: "Policy Not Found", error: { Code: "NoSuchBucket" } }],
  ["wrong status", { statusCode: 403, code: "NoSuchPolicy" }],
  ["unrecognized normalized message", { statusCode: 404, code: "404", message: "Not Found", ErrorStatus: "Policy Not Found" }],
  ["SDK unknown error", { statusCode: 500, code: "InternalError" }]
]) {
  test(`private bucket rejects ${label}`, async () => {
    const { store, input, calls } = fixture({ policyError });
    await assert.rejects(() => store.downloadUrl(input), error => error === policyError);
    assert.equal(calls.head, 0);
    assert.equal(calls.sign, 0);
  });
}

test("a public bucket is rejected before policy or object access", async () => {
  const { store, input, calls } = fixture({ bucketAcl: { ...privateAcl, ACL: "public-read" } });
  await assert.rejects(() => store.downloadUrl(input), /private_package_bucket_not_private/);
  assert.equal(calls.head, 0);
  assert.equal(calls.sign, 0);
});

test("Allow bucket policies remain rejected", async () => {
  const { store, input, calls } = fixture({ policy: { Statement: [{ Effect: "Allow" }] } });
  await assert.rejects(() => store.downloadUrl(input), /private_package_bucket_policy_invalid/);
  assert.equal(calls.sign, 0);
});

test("public objects remain rejected", async () => {
  const { store, input, calls } = fixture({ objectAcl: { ...privateAcl, ACL: "public-read" } });
  await assert.rejects(() => store.downloadUrl(input), /private_package_object_not_private/);
  assert.equal(calls.sign, 0);
});
