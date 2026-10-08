-- Additive PRD 1.1 distribution storage. This migration enables NO feature,
-- grants NO historical work consent, counts NO historical contributions,
-- and does not modify orders, entitlements, creator ownership or provider data.
-- Apply with the existing migration runner and its normal serialized write gate.
CREATE TABLE IF NOT EXISTS gongde_free_creator_numbers (
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  serial BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_free_creator_serial (serial),
  CONSTRAINT fk_free_creator_number FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id),
  CONSTRAINT ck_free_creator_serial CHECK (serial >= 100001)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO gongde_free_creator_numbers (creator_id, serial, created_at)
SELECT missing.creator_id, baseline.last_serial + missing.ordinal, CURRENT_TIMESTAMP(3)
FROM (SELECT c.creator_id, ROW_NUMBER() OVER (ORDER BY c.created_at, c.creator_id) AS ordinal
      FROM gongde_creators c WHERE NOT EXISTS
      (SELECT 1 FROM gongde_free_creator_numbers n WHERE n.creator_id = c.creator_id)) missing
CROSS JOIN (SELECT COALESCE(MAX(serial), 100000) AS last_serial FROM gongde_free_creator_numbers) baseline;

CREATE TABLE IF NOT EXISTS gongde_free_creator_number_allocator (
  allocator_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  next_serial BIGINT UNSIGNED NOT NULL,
  CONSTRAINT ck_free_number_allocator CHECK (allocator_id = 1 AND next_serial >= 100001)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO gongde_free_creator_number_allocator (allocator_id, next_serial)
SELECT 1, COALESCE(MAX(serial), 100000) + 1 FROM gongde_free_creator_numbers
ON DUPLICATE KEY UPDATE next_serial = GREATEST(next_serial,
  (SELECT COALESCE(MAX(serial), 100000) + 1 FROM gongde_free_creator_numbers));

CREATE TABLE IF NOT EXISTS gongde_free_code_families (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  owner_key VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS
    (CASE WHEN kind = 'GROUP' THEN 'GROUP' ELSE CONCAT('CREATOR:', creator_id) END) STORED,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVE',
  generation INT UNSIGNED NOT NULL DEFAULT 0,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  verification_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_free_family_owner (owner_key),
  CONSTRAINT fk_free_family_creator FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id),
  CONSTRAINT ck_free_family_kind CHECK ((kind = 'GROUP' AND creator_id IS NULL) OR (kind = 'CREATOR' AND creator_id IS NOT NULL)),
  CONSTRAINT ck_free_family_state CHECK (state IN ('ACTIVE', 'PAUSED', 'REVOKED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_code_tokens (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  family_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cycle_index BIGINT UNSIGNED NOT NULL,
  generation INT UNSIGNED NOT NULL,
  nonce INT UNSIGNED NOT NULL,
  code_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  valid_from DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_free_token_period (family_id, cycle_index, generation),
  UNIQUE KEY uq_free_code_digest (code_digest),
  CONSTRAINT fk_free_token_family FOREIGN KEY (family_id) REFERENCES gongde_free_code_families(id),
  KEY ix_free_token_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_excluded_fingerprints (
  content_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT ck_free_exclusion_kind CHECK (kind IN ('SAMPLE', 'SYNTHETIC'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_contributions (
  work_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  earned_version_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  consent_snapshot_json JSON NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVE',
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  earned_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  restored_at DATETIME(3) NULL,
  reason VARCHAR(1000) NULL,
  UNIQUE KEY uq_free_content_fingerprint (content_fingerprint),
  CONSTRAINT fk_free_contribution_owner FOREIGN KEY (work_id, creator_id) REFERENCES gongde_creator_works(work_id, creator_id),
  CONSTRAINT fk_free_contribution_version FOREIGN KEY (work_id, earned_version_id) REFERENCES gongde_creator_work_versions(work_id, version_id),
  CONSTRAINT ck_free_contribution_state CHECK (state IN ('ACTIVE', 'REVOKED')),
  KEY ix_free_contribution_creator (creator_id, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_download_sessions (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  session_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  current_code_token_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_free_session_digest (session_digest),
  CONSTRAINT fk_free_session_token FOREIGN KEY (current_code_token_id) REFERENCES gongde_free_code_tokens(id),
  KEY ix_free_session_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_claims (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  session_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'APPEARANCES',
  family_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_token_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cycle_index BIGINT UNSIGNED NOT NULL,
  limit_snapshot TINYINT UNSIGNED NOT NULL,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PREPARING',
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  issued_at DATETIME(3) NULL,
  download_expires_at DATETIME(3) NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  stage VARCHAR(24) NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  lease_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  generation_started_at DATETIME(3) NULL,
  UNIQUE KEY uq_free_claim_idempotency (session_id, idempotency_key),
  CONSTRAINT fk_free_claim_session FOREIGN KEY (session_id) REFERENCES gongde_free_download_sessions(id),
  CONSTRAINT fk_free_claim_family FOREIGN KEY (family_id) REFERENCES gongde_free_code_families(id),
  CONSTRAINT fk_free_claim_token FOREIGN KEY (code_token_id) REFERENCES gongde_free_code_tokens(id),
  CONSTRAINT ck_free_claim_kind CHECK (kind = 'APPEARANCES'),
  CONSTRAINT ck_free_claim_limit CHECK (limit_snapshot BETWEEN 1 AND 10),
  CONSTRAINT ck_free_claim_state CHECK (state IN ('PREPARING', 'READY', 'FAILED', 'EXPIRED', 'BLOCKED')),
  KEY ix_free_claim_session_created (session_id, created_at),
  KEY ix_free_claim_pending (state, lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_claim_items (
  claim_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  appearance_number INT UNSIGNED NOT NULL,
  source_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  version_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_revision CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  catalog_revision VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metadata_snapshot_json JSON NOT NULL,
  consent_snapshot_json JSON NOT NULL,
  delivery_bytes_upper_bound INT UNSIGNED NOT NULL,
  snapshot_record_json JSON NULL,
  PRIMARY KEY (claim_id, position),
  UNIQUE KEY uq_free_claim_number (claim_id, appearance_number),
  UNIQUE KEY uq_free_claim_work (claim_id, source_kind, asset_id),
  CONSTRAINT fk_free_claim_item FOREIGN KEY (claim_id) REFERENCES gongde_free_claims(id),
  CONSTRAINT ck_free_claim_position CHECK (position BETWEEN 1 AND 10),
  CONSTRAINT ck_free_claim_source CHECK (source_kind IN ('official', 'community')),
  KEY ix_free_claim_work (source_kind, asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_delivery_artifacts (
  claim_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  private_object_key VARCHAR(384) NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  filename VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  format VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  license_mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  signer_version VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_free_artifact_claim FOREIGN KEY (claim_id) REFERENCES gongde_free_claims(id),
  CONSTRAINT ck_free_artifact_size CHECK (bytes BETWEEN 1 AND 16777216),
  CONSTRAINT ck_free_artifact_format CHECK (format IN ('nmgpack', 'nmgpacks')),
  CONSTRAINT ck_free_artifact_license CHECK (license_mode = 'perpetual')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_verification_events (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  family_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_free_verification_family FOREIGN KEY (family_id) REFERENCES gongde_free_code_families(id),
  KEY ix_free_verification_time (occurred_at, family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gongde_free_audit (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  actor VARCHAR(80) NOT NULL,
  action VARCHAR(64) NOT NULL,
  subject VARCHAR(128) NOT NULL,
  before_json JSON NOT NULL,
  after_json JSON NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  request_id VARCHAR(128) NULL,
  occurred_at DATETIME(3) NOT NULL,
  KEY ix_free_audit_subject (subject, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Absence means no official safety/copyright block. Ordinary catalog unlist or
-- updates MUST NOT write these rows. Existing creator safety truth is unchanged.
CREATE TABLE IF NOT EXISTS gongde_free_official_safety (
  asset_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  reason VARCHAR(1000) NOT NULL,
  updated_by VARCHAR(80) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Hashed operation/session/IP buckets, never a per-code quota or a balance.
CREATE TABLE IF NOT EXISTS gongde_free_rate_limits (
  bucket_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  KEY ix_free_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Unified anonymous reports for official and community appearance identities.
-- Private evidence/contact fields are never projected into public catalog APIs.
CREATE TABLE IF NOT EXISTS gongde_free_reports (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  appearance_number INT UNSIGNED NOT NULL,
  version_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  category VARCHAR(32) NOT NULL,
  description TEXT NOT NULL,
  evidence VARCHAR(2048) NULL,
  contact VARCHAR(256) NULL,
  state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'OPEN',
  created_at DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  resolution VARCHAR(1000) NULL,
  CONSTRAINT fk_free_report_appearance FOREIGN KEY (appearance_number) REFERENCES gongde_appearance_numbers(appearance_serial),
  CONSTRAINT ck_free_report_state CHECK (state IN ('OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED')),
  KEY ix_free_report_state_created (state, created_at),
  KEY ix_free_report_appearance (appearance_number, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
