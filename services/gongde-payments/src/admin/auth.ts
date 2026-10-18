import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

export interface AdminAuthConfiguration {
  username: string;
  password: string;
  sessionSecret: string;
  secureCookie: boolean;
}

interface SessionPayload {
  username: string;
  expiresAt: number;
  nonce: string;
}

interface AttemptState {
  failures: number;
  blockedUntil: number;
}

const COOKIE_NAME = "gongde_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function readSecret(path: string, name: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name}_invalid`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${name}_empty`);
  return value;
}

export function loadAdminAuthConfiguration(
  source: Record<string, string | undefined> = process.env
): AdminAuthConfiguration | null {
  const username = source.GONGDE_ADMIN_USERNAME?.trim() ?? "";
  const passwordFile = source.GONGDE_ADMIN_PASSWORD_FILE?.trim() ?? "";
  const sessionSecretFile = source.GONGDE_ADMIN_SESSION_SECRET_FILE?.trim() ?? "";
  if (!username && !passwordFile && !sessionSecretFile) return null;
  if (!/^[A-Za-z0-9_.-]{3,64}$/u.test(username) || !passwordFile || !sessionSecretFile) {
    throw new Error("admin_configuration_incomplete");
  }
  const password = readSecret(passwordFile, "GONGDE_ADMIN_PASSWORD_FILE");
  const sessionSecret = readSecret(sessionSecretFile, "GONGDE_ADMIN_SESSION_SECRET_FILE");
  if (password.length < 12) throw new Error("GONGDE_ADMIN_PASSWORD_FILE_too_short");
  if (Buffer.byteLength(sessionSecret) < 32) throw new Error("GONGDE_ADMIN_SESSION_SECRET_FILE_too_short");
  return {
    username,
    password,
    sessionSecret,
    secureCookie: source.GONGDE_ADMIN_COOKIE_SECURE !== "false" && source.NODE_ENV === "production"
  };
}

function safeEqual(left: string, right: string, secret: string): boolean {
  const leftDigest = createHmac("sha256", secret).update(left).digest();
  const rightDigest = createHmac("sha256", secret).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function cookies(value: string | undefined): Record<string, string> {
  return Object.fromEntries((value ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

export class AdminAuthService {
  readonly #attempts = new Map<string, AttemptState>();

  constructor(private readonly configuration: AdminAuthConfiguration, private readonly now = () => Date.now()) {}

  login(username: string, password: string, clientKey: string): string {
    const current = this.now();
    const attempt = this.#attempts.get(clientKey);
    if (attempt && attempt.blockedUntil > current) throw new Error("admin_login_rate_limited");
    const valid = safeEqual(username, this.configuration.username, this.configuration.sessionSecret) &&
      safeEqual(password, this.configuration.password, this.configuration.sessionSecret);
    if (!valid) {
      const failures = attempt && current - attempt.blockedUntil < ATTEMPT_WINDOW_MS ? attempt.failures + 1 : 1;
      this.#attempts.set(clientKey, {
        failures,
        blockedUntil: failures >= MAX_FAILURES ? current + ATTEMPT_WINDOW_MS : current
      });
      throw new Error("admin_invalid_credentials");
    }
    this.#attempts.delete(clientKey);
    const payload: SessionPayload = {
      username: this.configuration.username,
      expiresAt: current + SESSION_SECONDS * 1000,
      nonce: randomBytes(16).toString("base64url")
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.configuration.sessionSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  requireSession(cookieHeader: string | undefined): SessionPayload {
    const token = cookies(cookieHeader)[COOKIE_NAME] ?? "";
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) throw new Error("admin_auth_required");
    const expected = createHmac("sha256", this.configuration.sessionSecret).update(encoded).digest("base64url");
    if (!safeEqual(signature, expected, this.configuration.sessionSecret)) throw new Error("admin_auth_required");
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    } catch {
      throw new Error("admin_auth_required");
    }
    if (payload.username !== this.configuration.username || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= this.now()) {
      throw new Error("admin_auth_required");
    }
    return payload;
  }

  sessionCookie(token: string): string {
    const secure = this.configuration.secureCookie ? "; Secure" : "";
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`;
  }

  clearCookie(): string {
    const secure = this.configuration.secureCookie ? "; Secure" : "";
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }
}
