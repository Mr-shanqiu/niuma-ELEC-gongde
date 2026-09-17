import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { loadRuntimeSecret } from "../../runtime-secret.js";

export type WechatPayRuntimeConfiguration = Readonly<{
  enabled: boolean;
  appId: string;
  merchantId: string;
  merchantSerialNo: string;
  merchantPrivateKey: KeyObject | null;
  wechatPayPublicKeyId: string;
  wechatPayPublicKey: KeyObject | null;
  apiV3Key: Buffer;
  notifyUrl: string;
  refundNotifyUrl: string;
  apiOrigin: string;
}>;

const empty = (): WechatPayRuntimeConfiguration => Object.freeze({
  enabled: false,
  appId: "",
  merchantId: "",
  merchantSerialNo: "",
  merchantPrivateKey: null,
  wechatPayPublicKeyId: "",
  wechatPayPublicKey: null,
  apiV3Key: Buffer.alloc(0),
  notifyUrl: "",
  refundNotifyUrl: "",
  apiOrigin: "https://api.mch.weixin.qq.com"
});

function clean(source: NodeJS.ProcessEnv | Record<string, string | undefined>, name: string) {
  return source[name]?.trim() ?? "";
}

function required(value: string, name: string) {
  if (!value) throw new Error(`${name} is required when WECHAT_PAY_ENABLED=true`);
  return value;
}

function parseHttpsUrl(value: string, name: string, allowPath: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials or fragment`);
  }
  if (!allowPath && (url.pathname !== "/" || url.search)) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  if (allowPath && (url.pathname === "/" || url.search)) {
    throw new Error(`${name} must include a callback path and must not contain query parameters`);
  }
  return url;
}

export function parseWechatPayRuntimeConfiguration(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>
): WechatPayRuntimeConfiguration {
  const enabled = ["1", "true"].includes(clean(source, "WECHAT_PAY_ENABLED").toLowerCase());
  if (!enabled) return empty();

  const appId = required(clean(source, "WECHAT_PAY_APP_ID"), "WECHAT_PAY_APP_ID");
  const merchantId = required(clean(source, "WECHAT_PAY_MCH_ID"), "WECHAT_PAY_MCH_ID");
  const merchantSerialNo = required(clean(source, "WECHAT_PAY_MERCHANT_SERIAL_NO"), "WECHAT_PAY_MERCHANT_SERIAL_NO");
  const merchantPrivateKeyPem = loadRuntimeSecret(source, "WECHAT_PAY_MERCHANT_PRIVATE_KEY", "WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE");
  const wechatPayPublicKeyId = required(clean(source, "WECHAT_PAY_PUBLIC_KEY_ID"), "WECHAT_PAY_PUBLIC_KEY_ID");
  const wechatPayPublicKeyPem = loadRuntimeSecret(source, "WECHAT_PAY_PUBLIC_KEY", "WECHAT_PAY_PUBLIC_KEY_FILE");
  const apiV3KeyText = loadRuntimeSecret(source, "WECHAT_PAY_API_V3_KEY", "WECHAT_PAY_API_V3_KEY_FILE");
  const notifyUrl = parseHttpsUrl(required(clean(source, "WECHAT_PAY_NOTIFY_URL"), "WECHAT_PAY_NOTIFY_URL"), "WECHAT_PAY_NOTIFY_URL", true);
  const refundNotifyUrl = parseHttpsUrl(
    clean(source, "WECHAT_PAY_REFUND_NOTIFY_URL") || `${notifyUrl.origin}${notifyUrl.pathname.replace(/\/notify$/u, "/refund-notify")}`,
    "WECHAT_PAY_REFUND_NOTIFY_URL",
    true
  );
  const apiOrigin = parseHttpsUrl(clean(source, "WECHAT_PAY_API_ORIGIN") || "https://api.mch.weixin.qq.com", "WECHAT_PAY_API_ORIGIN", false);

  if (!/^[A-Za-z0-9_-]{6,64}$/u.test(appId)) throw new Error("WECHAT_PAY_APP_ID has an invalid format");
  if (!/^\d{6,32}$/u.test(merchantId)) throw new Error("WECHAT_PAY_MCH_ID has an invalid format");
  if (!/^[A-Fa-f0-9]{16,64}$/u.test(merchantSerialNo)) throw new Error("WECHAT_PAY_MERCHANT_SERIAL_NO has an invalid format");
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(wechatPayPublicKeyId)) throw new Error("WECHAT_PAY_PUBLIC_KEY_ID has an invalid format");
  if (Buffer.byteLength(apiV3KeyText, "utf8") !== 32) throw new Error("WECHAT_PAY_API_V3_KEY must contain exactly 32 UTF-8 bytes");

  let merchantPrivateKey: KeyObject;
  let wechatPayPublicKey: KeyObject;
  try {
    merchantPrivateKey = createPrivateKey(merchantPrivateKeyPem);
    wechatPayPublicKey = createPublicKey(wechatPayPublicKeyPem);
  } catch {
    throw new Error("WeChat Pay key material is not valid PEM");
  }
  if (merchantPrivateKey.asymmetricKeyType !== "rsa" || wechatPayPublicKey.asymmetricKeyType !== "rsa") {
    throw new Error("WeChat Pay keys must be RSA keys");
  }

  return Object.freeze({
    enabled: true,
    appId,
    merchantId,
    merchantSerialNo: merchantSerialNo.toUpperCase(),
    merchantPrivateKey,
    wechatPayPublicKeyId,
    wechatPayPublicKey,
    apiV3Key: Buffer.from(apiV3KeyText, "utf8"),
    notifyUrl: notifyUrl.toString(),
    refundNotifyUrl: refundNotifyUrl.toString(),
    apiOrigin: apiOrigin.origin
  });
}
