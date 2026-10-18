import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const GROUP_BENEFIT_PERIOD_DAYS = 3;
export const GROUP_BENEFIT_TIME_ZONE = "Asia/Shanghai";
const PERIOD_MS = GROUP_BENEFIT_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_START_AT = "2026-10-08T00:00:00+08:00";
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface GroupBenefitCodeSnapshot {
  status: "ready" | "scheduled";
  code: string | null;
  cycleId: string | null;
  periodDays: number;
  timeZone: string;
  validFrom: string;
  expiresAt: string;
  nextChangesAt: string;
  serverTime: string;
}

export class GroupBenefitCodeService {
  private readonly key: Buffer;
  private readonly startsAt: number;

  constructor(key: Buffer, startsAt: string = DEFAULT_START_AT) {
    if (key.length !== 32) throw new Error("group_benefit_key_invalid");
    // The activation anchor is explicit and persistent, not process start time.
    // Restrict it to Beijing midnight so all three-day windows use one calendar.
    if (!/^\d{4}-\d{2}-\d{2}T00:00:00\+08:00$/u.test(startsAt)) {
      throw new Error("group_benefit_start_invalid");
    }
    const timestamp = Date.parse(startsAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== startsAt.slice(0, 10)) {
      throw new Error("group_benefit_start_invalid");
    }
    this.key = Buffer.from(key);
    this.startsAt = timestamp;
  }

  current(now: Date = new Date()): GroupBenefitCodeSnapshot {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("group_benefit_time_invalid");
    const common = {
      periodDays: GROUP_BENEFIT_PERIOD_DAYS,
      timeZone: GROUP_BENEFIT_TIME_ZONE,
      serverTime: now.toISOString(),
    };
    if (timestamp < this.startsAt) {
      return {
        ...common, status: "scheduled", code: null, cycleId: null,
        validFrom: new Date(this.startsAt).toISOString(),
        expiresAt: new Date(this.startsAt + PERIOD_MS).toISOString(),
        nextChangesAt: new Date(this.startsAt).toISOString(),
      };
    }
    const cycle = Math.floor((timestamp - this.startsAt) / PERIOD_MS);
    const validFrom = new Date(this.startsAt + cycle * PERIOD_MS).toISOString();
    const expiresAt = new Date(this.startsAt + (cycle + 1) * PERIOD_MS).toISOString();
    const digest = createHmac("sha256", this.key)
      .update(`gongde:group-benefit:v1:${this.startsAt}:${cycle}`)
      .digest();
    const characters = Array.from(digest.subarray(0, 8), value => ALPHABET[value & 31]).join("");
    return {
      ...common, status: "ready", cycleId: `group-v1-${validFrom}`,
      code: `NM-${characters.slice(0, 4)}-${characters.slice(4)}`,
      validFrom, expiresAt, nextChangesAt: expiresAt,
    };
  }

  matches(code: unknown, now: Date = new Date()): boolean {
    if (typeof code !== "string" || code.length > 32) return false;
    const normalized = code.trim().toUpperCase();
    if (!/^NM-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u.test(normalized)) return false;
    const current = this.current(now).code;
    if (!current) return false;
    return timingSafeEqual(Buffer.from(normalized, "ascii"), Buffer.from(current, "ascii"));
  }
}

export function loadGroupBenefitCodeService(
  source: NodeJS.ProcessEnv = process.env,
): GroupBenefitCodeService | null {
  if (source.GONGDE_GROUP_BENEFIT_CODES_ENABLED !== "true") return null;
  const path = source.GONGDE_GROUP_BENEFIT_SECRET_FILE;
  if (!path) throw new Error("group_benefit_key_missing");
  // Independent 32-byte random secret, encoded as 64 hexadecimal characters.
  // Never derive the group code from a date alone, passwords, or payment keys.
  const secret = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/iu.test(secret)) throw new Error("group_benefit_key_invalid");
  return new GroupBenefitCodeService(Buffer.from(secret, "hex"), source.GONGDE_GROUP_BENEFIT_START_AT ?? DEFAULT_START_AT);
}
