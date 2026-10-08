import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { GongdeMySqlConfiguration } from "../storage/mysql-store.js";

export type AppearanceSourceKind = "official" | "community";
export interface AppearanceNumberRecord {
  appearanceNumber: string;
  sourceKind: AppearanceSourceKind;
  internalId: string;
}

export class AppearanceNumberError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export function normalizeAppearanceNumber(value: string): string {
  const normalized = value.trim();
  if (!/^[1-9][0-9]{5,8}$/u.test(normalized) || Number(normalized) < 100001) {
    throw new AppearanceNumberError("appearance_number_invalid", 400);
  }
  return normalized;
}

export function appearanceNumberFromSerial(serial: unknown): string {
  if (typeof serial !== "number" && typeof serial !== "string") {
    throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
  }
  try { return normalizeAppearanceNumber(String(serial)); }
  catch { throw new AppearanceNumberError("appearance_numbers_unavailable", 503); }
}

// Only work creation allocates. Reads never mint a number or synthesize a fallback.
// The caller's transaction also inserts the work and rolls both records back on failure.
export async function registerCommunityAppearanceNumber(connection: PoolConnection, workId: string): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT next_serial FROM gongde_appearance_number_allocator WHERE allocator_id = 1 FOR UPDATE");
  const serial = Number(appearanceNumberFromSerial(rows[0]?.next_serial));
  await connection.execute(
    "INSERT INTO gongde_appearance_numbers (appearance_serial, source_kind, internal_id) VALUES (?, 'community', ?)",
    [serial, workId]);
  const [updated] = await connection.execute<ResultSetHeader>(
    "UPDATE gongde_appearance_number_allocator SET next_serial = ? WHERE allocator_id = 1 AND next_serial = ?",
    [serial + 1, serial]);
  if (updated.affectedRows !== 1) throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
}

function record(row: RowDataPacket): AppearanceNumberRecord {
  if (row.source_kind !== "official" && row.source_kind !== "community") {
    throw new AppearanceNumberError("appearance_numbers_unavailable", 503);
  }
  return { appearanceNumber: appearanceNumberFromSerial(row.appearance_serial),
    sourceKind: row.source_kind, internalId: String(row.internal_id) };
}

export class AppearanceNumberRepository {
  readonly #pool: Pool;
  constructor(configuration: GongdeMySqlConfiguration, pool?: Pool) {
    this.#pool = pool ?? createPool({ ...configuration, connectionLimit: 2, waitForConnections: true,
      queueLimit: 16, timezone: "Z", charset: "utf8mb4", multipleStatements: false });
  }

  async find(value: string): Promise<AppearanceNumberRecord | null> {
    const number = normalizeAppearanceNumber(value);
    try {
      const [rows] = await this.#pool.execute<RowDataPacket[]>(
        "SELECT appearance_serial, source_kind, internal_id FROM gongde_appearance_numbers WHERE appearance_serial = ?", [number]);
      return rows[0] ? record(rows[0]) : null;
    } catch { throw new AppearanceNumberError("appearance_numbers_unavailable", 503); }
  }

  async officialNumbers(assetIds: readonly string[]): Promise<Record<string, string>> {
    if (!assetIds.length) return {};
    try {
      const [rows] = await this.#pool.execute<RowDataPacket[]>(
        `SELECT appearance_serial, source_kind, internal_id FROM gongde_appearance_numbers
         WHERE source_kind = 'official' AND internal_id IN (${assetIds.map(() => "?").join(",")})`, [...assetIds]);
      const numbers = Object.fromEntries(rows.map(row => { const item = record(row); return [item.internalId, item.appearanceNumber]; }));
      if (assetIds.some(assetId => !numbers[assetId])) throw new Error("missing_binding");
      return numbers;
    } catch { throw new AppearanceNumberError("appearance_numbers_unavailable", 503); }
  }

  async close(): Promise<void> { await this.#pool.end(); }
}
