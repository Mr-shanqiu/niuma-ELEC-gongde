-- Preparation only: apply separately through the authorized migration process.
-- No plaintext Idempotency-Key, buyer token, checkout URL, or new secret.
-- READY payload uses client-key-derived AES-256-GCM; AAD binds digest/fingerprint.
-- NEVER delete or recycle key_digest rows, including FAILED/STARTED/EXPIRED.
-- Expiry clears replay payload on access and preserves the unique tombstone.
CREATE TABLE IF NOT EXISTS gongde_checkout_requests (
  key_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('STARTED', 'READY', 'FAILED', 'EXPIRED') NOT NULL,
  payload_ciphertext MEDIUMBLOB NULL,
  payload_iv BINARY(12) NULL,
  payload_tag BINARY(16) NULL,
  error_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_status SMALLINT UNSIGNED NULL,
  precreate_rejected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (key_digest),
  KEY idx_checkout_requests_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
