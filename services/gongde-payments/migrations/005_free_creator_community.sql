-- Additive free-community phase. No existing orders or entitlements are changed.
-- Creator accounts use username/password plus a one-time disclosed recovery key.
ALTER TABLE gongde_creators
  MODIFY COLUMN email VARCHAR(254) NULL,
  ADD COLUMN username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN recovery_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_gongde_creator_username (username);

ALTER TABLE gongde_creator_works
  ADD COLUMN published_metadata_json JSON NULL;
ALTER TABLE gongde_creator_work_versions
  ADD COLUMN approved_metadata_json JSON NULL;
ALTER TABLE gongde_creator_reviews
  ADD COLUMN metadata_snapshot_json JSON NULL,
  ADD COLUMN checks_json JSON NULL;

CREATE TABLE IF NOT EXISTS gongde_creator_rate_limits (
  bucket_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hits INT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (bucket_digest),
  KEY ix_gongde_creator_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
