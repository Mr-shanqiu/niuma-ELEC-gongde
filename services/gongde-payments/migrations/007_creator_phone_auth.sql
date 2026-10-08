-- Additive creator-only phone authentication. No account/work ownership migration.
-- Apply through the existing migration mechanism; this file enables no feature.
-- Only a domain-separated server HMAC is stored, never a plaintext phone number.
CREATE TABLE IF NOT EXISTS gongde_creator_phone_identities (
  phone_identity_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (phone_identity_digest),
  UNIQUE KEY uq_gongde_creator_phone_owner (creator_id),
  CONSTRAINT fk_gongde_creator_phone_owner FOREIGN KEY (creator_id) REFERENCES gongde_creators(creator_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
