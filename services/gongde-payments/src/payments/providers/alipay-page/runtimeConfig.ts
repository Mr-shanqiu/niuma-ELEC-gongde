import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { loadRuntimeSecret } from "../../runtime-secret.js";

export type AlipayRuntimeConfiguration = Readonly<{
  enabled: boolean;
  wapEnabled: boolean;
  appId: string;
  sellerId: string;
  appPrivateKey: KeyObject | null;
  alipayPublicKey: KeyObject | null;
  notifyUrl: string;
  returnUrl: string;
  gatewayUrl: string;
}>;

const disabled = (): AlipayRuntimeConfiguration => Object.freeze({
  enabled: false,
  wapEnabled: false,
  appId: "",
  sellerId: "",
  appPrivateKey: null,
  alipayPublicKey: null,
  notifyUrl: "",
  returnUrl: "",
  gatewayUrl: "https://openapi.alipay.com/gateway.do"
});

function clean(source: NodeJS.ProcessEnv | Record<string, string | undefined>, name: string) {
  return source[name]?.trim() ?? "";
}

function required(value: string, name: string) {
  if (!value) throw new Error(`${name} is required when ALIPAY_ENABLED=true`);
  return value;
}

function httpsUrl(value: string, name: string, pathRequired: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials or fragment`);
  }
  if (pathRequired && url.pathname === "/") throw new Error(`${name} must include a path`);
  if (url.search) throw new Error(`${name} must not contain query parameters`);
  return url;
}

export function parseAlipayRuntimeConfiguration(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>
): AlipayRuntimeConfiguration {
  const enabled = ["1", "true"].includes(clean(source, "ALIPAY_ENABLED").toLowerCase());
  if (!enabled) return disabled();
  const wapEnabled = ["1", "true"].includes(clean(source, "ALIPAY_WAP_ENABLED").toLowerCase());
  const appId = required(clean(source, "ALIPAY_APP_ID"), "ALIPAY_APP_ID");
  const sellerId = clean(source, "ALIPAY_SELLER_ID");
  const appPrivateKeyPem = loadRuntimeSecret(source, "ALIPAY_APP_PRIVATE_KEY", "ALIPAY_APP_PRIVATE_KEY_FILE");
  const alipayPublicKeyPem = loadRuntimeSecret(source, "ALIPAY_PUBLIC_KEY", "ALIPAY_PUBLIC_KEY_FILE");
  const notifyUrl = httpsUrl(required(clean(source, "ALIPAY_NOTIFY_URL"), "ALIPAY_NOTIFY_URL"), "ALIPAY_NOTIFY_URL", true);
  const returnUrl = httpsUrl(required(clean(source, "ALIPAY_RETURN_URL"), "ALIPAY_RETURN_URL"), "ALIPAY_RETURN_URL", true);
  const gatewayUrl = httpsUrl(clean(source, "ALIPAY_GATEWAY_URL") || "https://openapi.alipay.com/gateway.do", "ALIPAY_GATEWAY_URL", true);
  if (!/^\d{16,32}$/u.test(appId)) throw new Error("ALIPAY_APP_ID has an invalid format");
  if (sellerId && !/^\d{16,32}$/u.test(sellerId)) throw new Error("ALIPAY_SELLER_ID has an invalid format");
  let appPrivateKey: KeyObject;
  let alipayPublicKey: KeyObject;
  try {
    appPrivateKey = createPrivateKey(appPrivateKeyPem);
    alipayPublicKey = createPublicKey(alipayPublicKeyPem);
  } catch {
    throw new Error("Alipay key material is not valid PEM");
  }
  if (appPrivateKey.asymmetricKeyType !== "rsa" || alipayPublicKey.asymmetricKeyType !== "rsa") {
    throw new Error("Alipay keys must be RSA keys");
  }
  return Object.freeze({
    enabled: true,
    wapEnabled,
    appId,
    sellerId,
    appPrivateKey,
    alipayPublicKey,
    notifyUrl: notifyUrl.toString(),
    returnUrl: returnUrl.toString(),
    gatewayUrl: gatewayUrl.toString()
  });
}
