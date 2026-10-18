import { lstatSync, readFileSync } from "node:fs";
import { sms } from "tencentcloud-sdk-nodejs-sms";
import type { SmsSender } from "./sms-verification.js";

export const TENCENT_SMS_REGION = "ap-guangzhou";
export const TENCENT_SMS_ENDPOINT = "sms.tencentcloudapi.com";

interface TencentSmsConfiguration {
  secretId: string;
  secretKey: string;
  sdkAppId: string;
  signName: string;
  templateId: string;
}

interface TencentSmsClient {
  SendSms(request: {
    PhoneNumberSet: string[];
    SmsSdkAppId: string;
    TemplateId: string;
    SignName: string;
    TemplateParamSet: string[];
    SessionContext: string;
  }): Promise<{ SendStatusSet?: Array<{ Code?: string }> }>;
}

type TencentSmsClientFactory = (configuration: {
  credential: { secretId: string; secretKey: string };
  region: string;
  profile: {
    signMethod: "TC3-HMAC-SHA256";
    httpProfile: { reqMethod: "POST"; reqTimeout: number; endpoint: string };
  };
}) => TencentSmsClient;

const defaultClientFactory: TencentSmsClientFactory = (configuration) =>
  new sms.v20210111.Client(configuration);

function required(source: Record<string, string | undefined>, names: string[]): string {
  for (const name of names) {
    const value = source[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names[0]}_required`);
}

function readSecretFile(path: string, name: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name}_file_invalid`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${name}_empty`);
  return value;
}

export function loadTencentSmsRuntime(source: Record<string, string | undefined> = process.env): {
  sender: TencentCloudSmsSender;
  identitySecret: Buffer;
  redisUrl: string;
} {
  const secretId = readSecretFile(required(source, ["TENCENT_CLOUD_SECRET_ID_FILE"]), "tencent_secret_id");
  const secretKey = readSecretFile(required(source, ["TENCENT_CLOUD_SECRET_KEY_FILE"]), "tencent_secret_key");
  const identitySecret = Buffer.from(readSecretFile(
    required(source, ["GONGDE_SMS_IDENTITY_SECRET_FILE"]),
    "gongde_sms_identity_secret"
  ), "utf8");
  if (identitySecret.length < 32) throw new Error("gongde_sms_identity_secret_too_short");
  return {
    sender: new TencentCloudSmsSender({
      secretId,
      secretKey,
      sdkAppId: required(source, ["TENCENT_CLOUD_SMS_SDK_APP_ID"]),
      signName: required(source, ["TENCENT_CLOUD_SMS_GONGDE_SIGN_NAME", "TENCENT_CLOUD_SMS_SIGN_NAME"]),
      templateId: required(source, [
        "TENCENT_CLOUD_SMS_GONGDE_LOGIN_TEMPLATE_ID",
        "TENCENT_CLOUD_SMS_MEMBER_BIND_TEMPLATE_ID"
      ])
    }),
    identitySecret,
    redisUrl: readSecretFile(required(source, ["GONGDE_SMS_REDIS_URL_FILE"]), "gongde_sms_redis_url")
  };
}

export class TencentCloudSmsSender implements SmsSender {
  constructor(
    private readonly configuration: TencentSmsConfiguration,
    private readonly clientFactory: TencentSmsClientFactory = defaultClientFactory
  ) {}

  async sendVerificationCode(phone: string, code: string, requestId: string): Promise<void> {
    if (!/^\+861[3-9]\d{9}$/u.test(phone) || !/^\d{6}$/u.test(code) || !requestId || requestId.length > 128) {
      throw new Error("sms_provider_request_invalid");
    }
    try {
      const client = this.clientFactory({
        credential: { secretId: this.configuration.secretId, secretKey: this.configuration.secretKey },
        region: TENCENT_SMS_REGION,
        profile: {
          signMethod: "TC3-HMAC-SHA256",
          httpProfile: { reqMethod: "POST", reqTimeout: 5, endpoint: TENCENT_SMS_ENDPOINT }
        }
      });
      const response = await client.SendSms({
        PhoneNumberSet: [phone],
        SmsSdkAppId: this.configuration.sdkAppId,
        TemplateId: this.configuration.templateId,
        SignName: this.configuration.signName,
        TemplateParamSet: [code, "5"],
        SessionContext: requestId
      });
      const statuses = response.SendStatusSet;
      if (!Array.isArray(statuses) || statuses.length !== 1 || statuses[0]?.Code !== "Ok") {
        throw new Error("sms_provider_rejected");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "sms_provider_rejected") throw error;
      throw new Error("sms_provider_unknown");
    }
  }
}
