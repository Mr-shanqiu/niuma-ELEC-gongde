CREATE TABLE IF NOT EXISTS gongde_access_accounts (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  code_digest CHAR(64) NOT NULL,
  code_hint CHAR(4) NOT NULL,
  state VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  activated_at DATETIME(3) NULL,
  UNIQUE KEY uq_gongde_access_code_digest (code_digest),
  KEY idx_gongde_access_state_created (state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
