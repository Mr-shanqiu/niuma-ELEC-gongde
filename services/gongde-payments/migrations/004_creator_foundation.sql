-- Additive creator schema only. Applying this migration does not enable any feature.
-- MySQL DDL implicitly commits. The existing migration runner is not an atomic DDL rollback.
-- Do not modify historic official orders, access accounts, entitlements or source assets.
CREATE TABLE IF NOT EXISTS gongde_creators (
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(256) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  biography VARCHAR(1000) NOT NULL DEFAULT '',
  state VARCHAR(24) NOT NULL,
  paid_eligibility VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUESTED',
  accepted_terms_version VARCHAR(64) NULL,
  private_identity_reference VARCHAR(256) NULL,
  payout_account_reference VARCHAR(256) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  email_verified_at DATETIME(3) NULL,
  UNIQUE KEY uq_gongde_creator_email (email),
  KEY idx_gongde_creator_state_created (state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_tokens (
  token_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose VARCHAR(24) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  CONSTRAINT fk_gongde_creator_token_owner FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id),
  KEY idx_gongde_creator_token_owner_purpose (creator_id, purpose),
  KEY idx_gongde_creator_token_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_agreements (
  agreement_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terms_version VARCHAR(64) NOT NULL,
  terms_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  accepted_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_gongde_creator_agreement_owner FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id),
  UNIQUE KEY uq_gongde_creator_agreement_version (creator_id, terms_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_works (
  work_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slug VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title_zh VARCHAR(80) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  tags_json JSON NOT NULL,
  state VARCHAR(24) NOT NULL,
  price_fen INT UNSIGNED NOT NULL DEFAULT 0,
  published_version_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_gongde_creator_work_owner FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id),
  CONSTRAINT ck_gongde_creator_work_price CHECK (price_fen IN (0, 20, 50, 100, 200, 500)),
  UNIQUE KEY uq_gongde_creator_work_slug (creator_id, slug),
  UNIQUE KEY uq_gongde_creator_work_owner (work_id, creator_id),
  KEY idx_gongde_creator_work_publication (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_work_versions (
  version_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  work_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_label VARCHAR(32) NOT NULL,
  source_revision CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_object_key VARCHAR(384) NOT NULL,
  preview_object_key VARCHAR(384) NULL,
  source_manifest_json JSON NOT NULL,
  validation_json JSON NOT NULL,
  state VARCHAR(24) NOT NULL,
  schema_version TINYINT UNSIGNED NOT NULL,
  archive_bytes INT UNSIGNED NOT NULL,
  unpacked_bytes INT UNSIGNED NOT NULL,
  decoded_image_bytes INT UNSIGNED NOT NULL,
  delivery_bytes_upper_bound INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  reviewed_at DATETIME(3) NULL,
  CONSTRAINT fk_gongde_creator_version_work FOREIGN KEY (work_id) REFERENCES gongde_creator_works(work_id),
  UNIQUE KEY uq_gongde_creator_version_revision (work_id, source_revision),
  UNIQUE KEY uq_gongde_creator_work_version (work_id, version_id),
  KEY idx_gongde_creator_version_review (state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_reviews (
  review_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  version_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  review_round INT UNSIGNED NOT NULL,
  state VARCHAR(24) NOT NULL,
  reviewer_reference VARCHAR(64) NULL,
  decision_reason VARCHAR(2000) NULL,
  submitted_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  CONSTRAINT fk_gongde_creator_review_version FOREIGN KEY (version_id) REFERENCES gongde_creator_work_versions(version_id),
  UNIQUE KEY uq_gongde_creator_review_round (version_id, review_round),
  KEY idx_gongde_creator_review_pending (state, submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_market_order_items (
  order_no VARCHAR(48) NOT NULL,
  line_no TINYINT UNSIGNED NOT NULL,
  source_kind VARCHAR(16) NOT NULL,
  asset_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  work_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  version_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  version_label VARCHAR(32) NOT NULL,
  source_revision CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title_zh VARCHAR(80) NOT NULL,
  unit_price_fen INT UNSIGNED NOT NULL,
  amount_fen INT UNSIGNED NOT NULL,
  creator_share_bps SMALLINT UNSIGNED NOT NULL,
  creator_amount_fen INT UNSIGNED NOT NULL,
  platform_amount_fen INT UNSIGNED NOT NULL,
  revenue_rule_version VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (order_no, line_no),
  CONSTRAINT fk_gongde_market_item_order FOREIGN KEY (order_no) REFERENCES gongde_orders(order_no),
  CONSTRAINT fk_gongde_market_item_owner FOREIGN KEY (work_id, creator_id)
    REFERENCES gongde_creator_works(work_id, creator_id),
  CONSTRAINT fk_gongde_market_item_version FOREIGN KEY (work_id, version_id)
    REFERENCES gongde_creator_work_versions(work_id, version_id),
  CONSTRAINT ck_gongde_market_item_split CHECK (
    creator_share_bps <= 10000 AND creator_amount_fen + platform_amount_fen = amount_fen
  ),
  KEY idx_gongde_market_item_creator (creator_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_royalty_ledger (
  entry_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_no VARCHAR(48) NULL,
  line_no TINYINT UNSIGNED NULL,
  entry_kind VARCHAR(24) NOT NULL,
  amount_fen BIGINT NOT NULL,
  idempotency_key VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revenue_rule_version VARCHAR(64) NOT NULL,
  reason_reference VARCHAR(128) NULL,
  occurred_at DATETIME(3) NOT NULL,
  available_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_gongde_creator_ledger_owner FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id),
  CONSTRAINT fk_gongde_creator_ledger_item FOREIGN KEY (order_no, line_no)
    REFERENCES gongde_market_order_items(order_no, line_no),
  UNIQUE KEY uq_gongde_creator_ledger_event (idempotency_key),
  KEY idx_gongde_creator_ledger_available (creator_id, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_settlements (
  settlement_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  statement_period CHAR(7) NOT NULL,
  revision_number INT UNSIGNED NOT NULL,
  state VARCHAR(32) NOT NULL,
  gross_creator_fen BIGINT NOT NULL,
  withholding_fen BIGINT NOT NULL DEFAULT 0,
  net_payout_fen BIGINT NOT NULL,
  payout_account_reference VARCHAR(256) NOT NULL,
  revenue_rule_version VARCHAR(64) NOT NULL,
  statement_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  approved_by VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  approved_at DATETIME(3) NULL,
  paid_at DATETIME(3) NULL,
  CONSTRAINT fk_gongde_creator_settlement_owner FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id),
  CONSTRAINT ck_gongde_creator_settlement_amount CHECK (
    gross_creator_fen > 0 AND withholding_fen >= 0 AND
    net_payout_fen > 0 AND gross_creator_fen - withholding_fen = net_payout_fen
  ),
  UNIQUE KEY uq_gongde_creator_statement_revision (creator_id, statement_period, revision_number),
  KEY idx_gongde_creator_settlement_state (state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_settlement_entries (
  allocation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  settlement_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ledger_entry_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) NOT NULL,
  reserved_entry_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (CASE WHEN state IN ('RESERVED', 'PAID') THEN ledger_entry_id ELSE NULL END) STORED,
  created_at DATETIME(3) NOT NULL,
  released_at DATETIME(3) NULL,
  CONSTRAINT fk_gongde_creator_allocation_statement FOREIGN KEY (settlement_id)
    REFERENCES gongde_creator_settlements(settlement_id),
  CONSTRAINT fk_gongde_creator_allocation_ledger FOREIGN KEY (ledger_entry_id)
    REFERENCES gongde_creator_royalty_ledger(entry_id),
  UNIQUE KEY uq_gongde_creator_active_allocation (reserved_entry_id),
  UNIQUE KEY uq_gongde_creator_statement_entry (settlement_id, ledger_entry_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_payouts (
  payout_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  settlement_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payout_no VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel VARCHAR(32) NOT NULL,
  state VARCHAR(32) NOT NULL,
  amount_fen BIGINT NOT NULL,
  provider_reference VARCHAR(128) NULL,
  failure_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  confirmed_at DATETIME(3) NULL,
  CONSTRAINT fk_gongde_creator_payout_statement FOREIGN KEY (settlement_id)
    REFERENCES gongde_creator_settlements(settlement_id),
  UNIQUE KEY uq_gongde_creator_payout_number (payout_no),
  KEY idx_gongde_creator_payout_query (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_audit (
  audit_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  actor_kind VARCHAR(24) NOT NULL,
  actor_reference VARCHAR(80) NOT NULL,
  action VARCHAR(64) NOT NULL,
  subject_reference VARCHAR(128) NOT NULL,
  detail_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_gongde_creator_audit_subject (subject_reference, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gongde_creator_complaints (
  complaint_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  work_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  state VARCHAR(24) NOT NULL,
  category VARCHAR(32) NOT NULL,
  description VARCHAR(4000) NOT NULL,
  evidence_reference VARCHAR(384) NULL,
  private_contact_reference VARCHAR(256) NULL,
  created_at DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  CONSTRAINT fk_gongde_creator_complaint_work FOREIGN KEY (work_id)
    REFERENCES gongde_creator_works(work_id),
  KEY idx_gongde_creator_complaint_state (state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
