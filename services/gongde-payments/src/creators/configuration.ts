import { loadRuntimeSecret } from "../payments/runtime-secret.js";
import type { GongdeMySqlConfiguration } from "../storage/mysql-store.js";
import { loadCreatorFeatureFlags } from "./policy.js";
import { CreatorError } from "./types.js";
import { parseCreatorTrustedProxies } from "./client-key.js";
import { loadTencentSmsRuntime } from "../auth/tencent-cloud-sms.js";

export interface CreatorPhoneAuthConfiguration {
  enabled: boolean;
  reason: "disabled" | "configuration_unavailable" | null;
  runtime: ReturnType<typeof loadTencentSmsRuntime> | null;
  environment: "production" | "development";
}

export function loadCreatorPhoneAuthConfiguration(source: NodeJS.ProcessEnv = process.env): CreatorPhoneAuthConfiguration {
  const environment = source.NODE_ENV === "production" ? "production" : "development";
  const flag = source.GONGDE_CREATOR_PHONE_AUTH_ENABLED?.trim();
  if (flag === undefined || flag === "" || flag === "false") {
    return { enabled: false, reason: "disabled", runtime: null, environment };
  }
  if (flag !== "true") return { enabled: false, reason: "configuration_unavailable", runtime: null, environment };
  try {
    return { enabled: true, reason: null, runtime: loadTencentSmsRuntime(source), environment };
  } catch {
    // Do not expose SDK configuration, file paths or credential failure details.
    return { enabled: false, reason: "configuration_unavailable", runtime: null, environment };
  }
}

export interface CreatorStorageConfiguration {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
}

export interface FreeCreatorConfiguration {
  publicOrigin: string;
  secureCookie: boolean;
  freeDownloadsEnabled: boolean;
  paidDownloadsEnabled: boolean;
  trustedProxyAddresses: string[];
  database: GongdeMySqlConfiguration;
  storage: CreatorStorageConfiguration;
}

export function loadFreeCreatorConfiguration(source: NodeJS.ProcessEnv = process.env): FreeCreatorConfiguration | null {
  const flags = loadCreatorFeatureFlags(source);
  if (!flags.enabled) return null;
  if (flags.settlementsEnabled) throw new CreatorError("creator_settlement_disabled", 503);
  const freeDownloadsEnabled = false;
  const paidDownloadsEnabled = flags.paidSalesEnabled && flags.paymentScenarioApproved &&
    flags.commercialTermsApproved && flags.clientCompatibilityAccepted;
  const publicOrigin = source.GONGDE_CREATOR_PUBLIC_ORIGIN?.trim() ?? "";
  let origin: URL;
  try { origin = new URL(publicOrigin); } catch { throw new CreatorError("creator_origin_invalid", 503); }
  const local = source.NODE_ENV !== "production" &&
    origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if ((!local && origin.protocol !== "https:") || origin.origin !== publicOrigin || origin.username || origin.password) {
    throw new CreatorError("creator_origin_invalid", 503);
  }
  const host = source.GONGDE_MYSQL_HOST?.trim() ?? "";
  const database = source.GONGDE_MYSQL_DATABASE?.trim() ?? "";
  const user = source.GONGDE_MYSQL_USER?.trim() ?? "";
  const port = Number(source.GONGDE_MYSQL_PORT ?? "3306");
  if (!/^[a-zA-Z0-9._:-]+$/u.test(host) || !/^[a-zA-Z0-9_]+$/u.test(database) ||
      !/^[a-zA-Z0-9_]+$/u.test(user) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      source.GONGDE_STORE_MODE !== "mysql") throw new CreatorError("creator_database_required", 503);
  const bucket = source.GONGDE_CREATOR_COS_BUCKET?.trim() ?? "";
  const region = source.GONGDE_CREATOR_COS_REGION?.trim() ?? "";
  if (!/^gongde-paid-[a-z0-9-]*\d+$/u.test(bucket) || !/^ap-[a-z0-9-]+$/u.test(region)) {
    throw new CreatorError("creator_private_storage_required", 503);
  }
  return {
    publicOrigin,
    secureCookie: !local,
    freeDownloadsEnabled,
    paidDownloadsEnabled,
    trustedProxyAddresses: parseCreatorTrustedProxies(source.GONGDE_CREATOR_TRUSTED_PROXY_ADDRESSES),
    database: {
      host, port, database, user, connectionLimit: 2,
      password: loadRuntimeSecret(source, "GONGDE_MYSQL_PASSWORD", "GONGDE_MYSQL_PASSWORD_FILE")
    },
    storage: {
      bucket, region,
      secretId: loadRuntimeSecret(source, "GONGDE_CREATOR_COS_SECRET_ID", "GONGDE_CREATOR_COS_SECRET_ID_FILE"),
      secretKey: loadRuntimeSecret(source, "GONGDE_CREATOR_COS_SECRET_KEY", "GONGDE_CREATOR_COS_SECRET_KEY_FILE")
    }
  };
}
