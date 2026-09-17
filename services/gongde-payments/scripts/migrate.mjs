import { readFile, readdir } from "node:fs/promises";
import mysql from "mysql2/promise";
import { loadGongdeMySqlConfiguration } from "../dist/storage/mysql-store.js";

const configuration = loadGongdeMySqlConfiguration();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en"));
if (migrationFiles.length < 1) throw new Error("gongde_migrations_missing");
const connection = await mysql.createConnection({
  host: configuration.host,
  port: configuration.port,
  database: configuration.database,
  user: configuration.user,
  password: configuration.password,
  timezone: "Z",
  charset: "utf8mb4",
  multipleStatements: false
});
try {
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS gongde_schema_migrations (
      filename VARCHAR(128) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
  );
  let applied = 0;
  let skipped = 0;
  for (const filename of migrationFiles) {
    const [rows] = await connection.execute(
      "SELECT filename FROM gongde_schema_migrations WHERE filename = ? LIMIT 1",
      [filename]
    );
    if (rows.length > 0) {
      skipped += 1;
      continue;
    }
    const sql = await readFile(new URL(filename, migrationsDirectory), "utf8");
    const statements = sql.split(/;\s*(?:\n|$)/u).map((statement) => statement.trim()).filter(Boolean);
    await connection.beginTransaction();
    try {
      for (const statement of statements) await connection.execute(statement);
      await connection.execute(
        "INSERT INTO gongde_schema_migrations (filename, applied_at) VALUES (?, UTC_TIMESTAMP(3))",
        [filename]
      );
      await connection.commit();
      applied += 1;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
  process.stdout.write(`gongde migrations applied=${applied} skipped=${skipped}\n`);
} finally {
  await connection.end();
}
