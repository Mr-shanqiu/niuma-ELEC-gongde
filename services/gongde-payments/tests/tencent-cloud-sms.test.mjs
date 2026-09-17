import assert from "node:assert/strict";
import test from "node:test";

import { TencentCloudSmsSender } from "../dist/auth/tencent-cloud-sms.js";

test("Tencent sender reuses the approved Zhijia sign and generic five-minute template", async () => {
  let clientConfiguration;
  let request;
  const sender = new TencentCloudSmsSender({
    secretId: "secret-id",
    secretKey: "secret-key",
    sdkAppId: "1400000000",
    signName: "智家",
    templateId: "123456"
  }, (configuration) => {
    clientConfiguration = configuration;
    return {
      async SendSms(value) {
        request = value;
        return { SendStatusSet: [{ Code: "Ok" }] };
      }
    };
  });
  await sender.sendVerificationCode("+8613800138000", "654321", "request-1");
  assert.equal(clientConfiguration.region, "ap-guangzhou");
  assert.equal(request.SignName, "智家");
  assert.deepEqual(request.TemplateParamSet, ["654321", "5"]);
  assert.equal(request.SessionContext, "request-1");
});

test("Tencent sender fails closed for ambiguous or rejected responses", async () => {
  const configuration = {
    secretId: "secret-id", secretKey: "secret-key", sdkAppId: "1400000000", signName: "智家", templateId: "123456"
  };
  const rejected = new TencentCloudSmsSender(configuration, () => ({
    async SendSms() { return { SendStatusSet: [{ Code: "FailedOperation" }] }; }
  }));
  await assert.rejects(rejected.sendVerificationCode("+8613800138000", "654321", "request-2"), /provider_rejected/u);
  const unknown = new TencentCloudSmsSender(configuration, () => ({
    async SendSms() { throw new Error("transport detail must not escape"); }
  }));
  await assert.rejects(unknown.sendVerificationCode("+8613800138000", "654321", "request-3"), /provider_unknown/u);
});
