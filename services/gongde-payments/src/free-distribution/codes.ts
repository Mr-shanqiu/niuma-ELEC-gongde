import { createHash, createHmac, randomBytes } from "node:crypto";
import { FreeDistributionError, type ClaimItemSnapshot, type CodeFamilyKind } from "./types.js";

export const FREE_DISTRIBUTION_ANCHOR_MS = Date.parse("2026-10-08T00:00:00+08:00");
export const FREE_CODE_CYCLE_MS = 72 * 60 * 60 * 1000;
export const DOWNLOAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DOWNLOAD_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CLAIM_ITEMS = 10;
export const MAX_DELIVERY_BYTES = 16 * 1024 * 1024;
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const DOWNLOAD_COOKIE_OPTIONS = Object.freeze({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: DOWNLOAD_SESSION_MS });

export function assertCodeSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) throw new FreeDistributionError("free_distribution_secret_invalid", 503);
}

export function codeCycle(now: Date | number) {
  const ms = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(ms) || ms < FREE_DISTRIBUTION_ANCHOR_MS) throw new FreeDistributionError("free_distribution_not_started", 503);
  const index = Math.floor((ms - FREE_DISTRIBUTION_ANCHOR_MS) / FREE_CODE_CYCLE_MS);
  const validFrom = new Date(FREE_DISTRIBUTION_ANCHOR_MS + index * FREE_CODE_CYCLE_MS);
  return { index, validFrom, expiresAt: new Date(validFrom.getTime() + FREE_CODE_CYCLE_MS) };
}

export function batchLimit(kind: CodeFamilyKind, activeContributions: number): number {
  if (!Number.isSafeInteger(activeContributions) || activeContributions < 0) throw new FreeDistributionError("contribution_count_invalid", 503);
  if (kind === "GROUP") return MAX_CLAIM_ITEMS;
  if (kind !== "CREATOR") throw new FreeDistributionError("code_family_kind_invalid", 503);
  return Math.min(3 * activeContributions, MAX_CLAIM_ITEMS);
}

export function normalizeCode(input: unknown): string {
  if (typeof input !== "string" || input.length > 128) throw new FreeDistributionError("access_code_invalid", 400);
  const value = input.trim().replace(/[a-z]/g, char => char.toUpperCase());
  const match = /^NM-?([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4})-?([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4})$/.exec(value);
  if (!match) throw new FreeDistributionError("access_code_invalid", 400);
  return `NM-${match[1]}-${match[2]}`;
}

export function deriveCode(secret: Uint8Array, familyId: string, cycleIndex: number, generation: number, nonce: number): string {
  assertCodeSecret(secret);
  if (!/^[a-f0-9]{32}$/.test(familyId) || ![cycleIndex, generation, nonce].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new FreeDistributionError("code_derivation_invalid", 503);
  }
  const bytes = createHmac("sha256", secret).update("gongde-free/code-value/v1\0")
    .update(JSON.stringify([familyId, cycleIndex, generation, nonce])).digest();
  const text = Array.from(bytes.subarray(0, 8), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `NM-${text.slice(0, 4)}-${text.slice(4)}`;
}

export function codeDigest(secret: Uint8Array, input: unknown): string {
  assertCodeSecret(secret);
  return createHmac("sha256", secret).update("gongde-free/code-lookup/v1\0").update(normalizeCode(input)).digest("hex");
}

export function newSessionToken(): string { return randomBytes(32).toString("base64url"); }

export function sessionDigest(token: unknown): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").toString("base64url") !== token) {
    throw new FreeDistributionError("download_session_required", 401);
  }
  return createHash("sha256").update("gongde-free/download-session/v1\0").update(token).digest("hex");
}

export function stableJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, visit(child)]));
    }
    throw new FreeDistributionError("claim_snapshot_invalid", 400);
  };
  return JSON.stringify(visit(value));
}

export function validateClaimItems(items: readonly ClaimItemSnapshot[], limit: number): void {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CLAIM_ITEMS || items.length > limit) {
    throw new FreeDistributionError("claim_limit_exceeded", 400, { limit });
  }
  const numbers = new Set<string>();
  const identities = new Set<string>();
  let bytes = 0;
  for (const item of items) {
    if (!item || !/^[1-9][0-9]{5,8}$/.test(item.appearanceNumber) || Number(item.appearanceNumber) < 100001 ||
      !["official", "community"].includes(item.sourceKind) || !/^[A-Za-z0-9._:-]{1,80}$/.test(item.assetId) ||
      typeof item.versionId !== "string" || !item.versionId || item.versionId.length > 80 ||
      !/^[a-f0-9]{64}$/.test(item.sourceRevision) || typeof item.catalogRevision !== "string" ||
      !item.catalogRevision || item.catalogRevision.length > 160 ||
      (item.sourceKind === "community" && !/^[a-f0-9]{32}$/.test(item.creatorId ?? "")) ||
      (item.sourceKind === "official" && item.creatorId !== null) ||
      !item.metadataSnapshot || Array.isArray(item.metadataSnapshot) || !item.consentSnapshot || Array.isArray(item.consentSnapshot) ||
      !Number.isSafeInteger(item.deliveryBytesUpperBound) || item.deliveryBytesUpperBound < 1) {
      throw new FreeDistributionError("claim_snapshot_invalid", 400);
    }
    const identity = `${item.sourceKind}:${item.assetId}`;
    if (numbers.has(item.appearanceNumber) || identities.has(identity)) throw new FreeDistributionError("claim_duplicate_work", 400);
    numbers.add(item.appearanceNumber); identities.add(identity);
    bytes += item.deliveryBytesUpperBound;
    stableJson(item);
  }
  if (bytes > MAX_DELIVERY_BYTES) throw new FreeDistributionError("claim_file_too_large", 413);
}

export function claimRequestDigest(items: readonly ClaimItemSnapshot[]): string {
  const sorted = [...items].sort((a, b) => Number(a.appearanceNumber) - Number(b.appearanceNumber));
  return createHash("sha256").update("gongde-free/claim-request/v1\0").update(stableJson(sorted)).digest("hex");
}

export function downloadLinkExpiresAt(issuedAt: Date, now: Date): Date {
  const expires = issuedAt.getTime() + DOWNLOAD_WINDOW_MS;
  if (!Number.isFinite(expires) || !Number.isFinite(now.getTime()) || now.getTime() < issuedAt.getTime() || now.getTime() >= expires) {
    throw new FreeDistributionError("claim_download_expired", 410);
  }
  return new Date(Math.min(now.getTime() + 300000, expires));
}

export function creatorPublicNumber(serial: number): string {
  if (!Number.isSafeInteger(serial) || serial < 100001) throw new FreeDistributionError("creator_number_invalid", 503);
  return `C${serial}`;
}
