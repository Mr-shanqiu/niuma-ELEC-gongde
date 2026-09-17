import { lstatSync, readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { PaymentStore } from "../domain/store.js";
import type { GongdeEntitlement, GongdeOrder } from "../domain/types.js";

export interface GongdeMySqlConfiguration {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
}

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/u.test(value)) throw new Error(`${name}_invalid`);
  return value;
}

function readSecret(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("GONGDE_MYSQL_PASSWORD_FILE_invalid");
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error("GONGDE_MYSQL_PASSWORD_FILE_empty");
  return value;
}

export function loadGongdeMySqlConfiguration(
  source: Record<string, string | undefined> = process.env
): GongdeMySqlConfiguration {
  const port = Number(source.GONGDE_MYSQL_PORT ?? "3306");
  const connectionLimit = Number(source.GONGDE_MYSQL_CONNECTION_LIMIT ?? "4");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GONGDE_MYSQL_PORT_invalid");
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 16) {
    throw new Error("GONGDE_MYSQL_CONNECTION_LIMIT_invalid");
  }
  return {
    host: required(source, "GONGDE_MYSQL_HOST"),
    port,
    database: identifier(required(source, "GONGDE_MYSQL_DATABASE"), "GONGDE_MYSQL_DATABASE"),
    user: identifier(required(source, "GONGDE_MYSQL_USER"), "GONGDE_MYSQL_USER"),
    password: readSecret(required(source, "GONGDE_MYSQL_PASSWORD_FILE")),
    connectionLimit
  };
}

type Executor = Pool | PoolConnection;

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("mysql_invalid_date");
  return date;
}

function mapAssetIds(row: RowDataPacket): string[] {
  const raw = row.asset_ids_json;
  try {
    const parsed = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {}
  return row.asset_id === null ? [] : [String(row.asset_id)];
}

function mapOrder(row: RowDataPacket): GongdeOrder {
  return {
    orderNo: String(row.order_no),
    productId: String(row.product_id),
    productVersion: Number(row.product_version),
    channel: row.channel,
    purchaseKind: row.purchase_kind,
    userId: row.user_id === null ? null : String(row.user_id),
    assetId: row.asset_id === null ? null : String(row.asset_id),
    assetIds: mapAssetIds(row),
    amountFen: Number(row.amount_fen),
    currency: "CNY",
    state: row.state,
    buyerTokenDigest: String(row.buyer_token_digest),
    providerTransactionId: row.provider_transaction_id === null ? null : String(row.provider_transaction_id),
    createdAt: asDate(row.created_at)!,
    expiresAt: asDate(row.expires_at)!,
    paidAt: asDate(row.paid_at),
    fulfilledAt: asDate(row.fulfilled_at)
  };
}

function mapEntitlement(row: RowDataPacket): GongdeEntitlement {
  return {
    id: String(row.id),
    orderNo: String(row.order_no),
    userId: String(row.user_id),
    productId: String(row.product_id),
    scope: row.scope,
    assetId: row.asset_id === null ? null : String(row.asset_id),
    state: row.state,
    createdAt: asDate(row.created_at)!,
    activatedAt: asDate(row.activated_at),
    expiresAt: asDate(row.expires_at),
    revokedAt: asDate(row.revoked_at)
  };
}

export class MySqlPaymentStore implements PaymentStore {
  constructor(
    private readonly executor: Executor,
    private readonly pool: Pool | null = null,
    private readonly transactional = false
  ) {}

  static connect(configuration: GongdeMySqlConfiguration): MySqlPaymentStore {
    const pool = mysql.createPool({
      host: configuration.host,
      port: configuration.port,
      database: configuration.database,
      user: configuration.user,
      password: configuration.password,
      connectionLimit: configuration.connectionLimit,
      waitForConnections: true,
      queueLimit: 32,
      timezone: "Z",
      charset: "utf8mb4",
      multipleStatements: false
    });
    return new MySqlPaymentStore(pool, pool);
  }

  async insertOrder(order: GongdeOrder): Promise<void> {
    await this.executor.execute(
      `INSERT INTO gongde_orders
       (order_no, product_id, product_version, channel, purchase_kind, user_id, asset_id, asset_ids_json, amount_fen, currency, state,
        buyer_token_digest, provider_transaction_id, created_at, expires_at, paid_at, fulfilled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [order.orderNo, order.productId, order.productVersion, order.channel, order.purchaseKind, order.userId, order.assetId,
        JSON.stringify(order.assetIds), order.amountFen, order.currency, order.state, order.buyerTokenDigest, order.providerTransactionId,
        order.createdAt, order.expiresAt, order.paidAt, order.fulfilledAt]
    );
  }

  async findOrder(orderNo: string): Promise<GongdeOrder | null> {
    const [rows] = await this.executor.execute<RowDataPacket[]>(
      `SELECT * FROM gongde_orders WHERE order_no = ? LIMIT 1${this.transactional ? " FOR UPDATE" : ""}`,
      [orderNo]
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async updateOrder(order: GongdeOrder): Promise<void> {
    await this.executor.execute(
      `UPDATE gongde_orders SET state = ?, provider_transaction_id = ?, paid_at = ?, fulfilled_at = ?
       WHERE order_no = ?`,
      [order.state, order.providerTransactionId, order.paidAt, order.fulfilledAt, order.orderNo]
    );
  }

  async insertEntitlement(entitlement: GongdeEntitlement): Promise<void> {
    await this.executor.execute(
      `INSERT INTO gongde_entitlements
       (id, order_no, user_id, product_id, scope, asset_id, entitlement_key, state, created_at, activated_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entitlement.id, entitlement.orderNo, entitlement.userId, entitlement.productId, entitlement.scope,
        entitlement.assetId,
        entitlement.scope === "official-character-pass" ? "pass" : `${entitlement.assetId}:${entitlement.orderNo}`,
        entitlement.state, entitlement.createdAt,
        entitlement.activatedAt, entitlement.expiresAt, entitlement.revokedAt]
    );
  }

  async findEntitlementsByOrder(orderNo: string): Promise<GongdeEntitlement[]> {
    const [rows] = await this.executor.execute<RowDataPacket[]>(
      "SELECT * FROM gongde_entitlements WHERE order_no = ? ORDER BY created_at, id",
      [orderNo]
    );
    return rows.map(mapEntitlement);
  }

  async findActiveEntitlement(
    userId: string,
    scope: GongdeEntitlement["scope"],
    assetId: string | null = null
  ): Promise<GongdeEntitlement | null> {
    const [rows] = await this.executor.execute<RowDataPacket[]>(
      `SELECT * FROM gongde_entitlements
       WHERE user_id = ? AND scope = ? AND asset_id <=> ? AND state = 'ACTIVE'
       AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
       ORDER BY created_at DESC LIMIT 1`,
      [userId, scope, assetId]
    );
    return rows[0] ? mapEntitlement(rows[0]) : null;
  }

  async runInTransaction<T>(work: (store: PaymentStore) => Promise<T>): Promise<T> {
    if (!this.pool) return await work(this);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(new MySqlPaymentStore(connection, null, true));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async ready(): Promise<boolean> {
    try {
      await this.executor.execute("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}
