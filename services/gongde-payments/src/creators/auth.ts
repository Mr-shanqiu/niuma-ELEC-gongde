import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { CreatorError } from "./types.js";

const SCRYPT_PARAMETERS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const DUMMY_SALT = Buffer.from("a88fc265f02ba408ce690a571ea93671", "hex");
const HASH_FORMAT = /^scrypt-v1\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/u;

export const CREATOR_REMEMBER_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const CREATOR_SHORT_SESSION_SECONDS = 8 * 60 * 60;

export function creatorRememberMe(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new CreatorError("creator_remember_me_invalid");
  return value;
}

export function creatorSessionExpiry(rememberMe: boolean): Date {
  return new Date(Date.now() + (rememberMe ? CREATOR_REMEMBER_SESSION_SECONDS : CREATOR_SHORT_SESSION_SECONDS) * 1000);
}

export function normalizeCreatorPhone(value: string): string {
  if (typeof value !== "string" || value.length > 32) throw new CreatorError("creator_phone_invalid");
  const compact = value.replace(/[\s-]/gu, "");
  const local = compact.startsWith("+86") ? compact.slice(3) : compact;
  if (!/^1[3-9]\d{9}$/u.test(local)) throw new CreatorError("creator_phone_invalid");
  return "+86" + local;
}

// A stable, creator-only identity. Never use a raw phone or a public username as its key.
export function creatorPhoneIdentityDigest(phone: string, secret: Buffer): string {
  if (secret.length < 32) throw new CreatorError("creator_phone_auth_unavailable", 503);
  return createHmac("sha256", secret).update("gongde_creator_phone_identity_v1\0", "utf8")
    .update(normalizeCreatorPhone(phone), "utf8").digest("hex");
}

function passwordBytes(password: string): Buffer {
  if (typeof password !== "string" || password.length < 12 || password.length > 128 ||
      Buffer.byteLength(password, "utf8") > 512) {
    throw new CreatorError("creator_password_length_invalid");
  }
  return Buffer.from(password, "utf8");
}

function derive(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_PARAMETERS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function newCreatorId(): string {
  return randomBytes(16).toString("hex");
}

export async function hashCreatorPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(passwordBytes(password), salt);
  return "scrypt-v1$16384$8$1$" + salt.toString("hex") + "$" + key.toString("hex");
}

export async function verifyCreatorPassword(
  password: string, storedHash: string | null
): Promise<boolean> {
  const match = typeof storedHash === "string" ? HASH_FORMAT.exec(storedHash) : null;
  const validInput = typeof password === "string" && password.length >= 12 &&
    password.length <= 128 && Buffer.byteLength(password, "utf8") <= 512;
  const salt = match ? Buffer.from(match[1], "hex") : DUMMY_SALT;
  const key = await derive(validInput ? Buffer.from(password, "utf8") : Buffer.from("invalid-input"), salt);
  const expected = match ? Buffer.from(match[2], "hex") : Buffer.alloc(64);
  const same = timingSafeEqual(key, expected);
  return validInput && match !== null && same;
}

export function newCreatorToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString("hex");
  return { token, digest: creatorTokenDigest(token) };
}

export function creatorTokenDigest(token: string): string {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new CreatorError("creator_token_invalid", 401);
  }
  return createHash("sha256").update(token, "ascii").digest("hex");
}

export function normalizeCreatorEmail(email: string): string {
  if (typeof email !== "string") throw new CreatorError("creator_email_invalid");
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 ||
      !/^[a-z0-9.!#$%&'*+/=?^_{}|~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/u.test(normalized) ||
      normalized.includes("..")) {
    throw new CreatorError("creator_email_invalid");
  }
  return normalized;
}
