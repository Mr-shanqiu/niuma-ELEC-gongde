-- Local implementation only: apply with the existing migration runner at authorized rollout.
-- No phone identities, legacy paid authorizations or historical deliveries are rewritten.
ALTER TABLE gongde_creator_works
  ADD COLUMN creator_douyin_number VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN sharing_terms_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN first_published_at DATETIME(3) NULL;

-- Metadata-only updates reuse bytes, not the immutable approved version identity.
ALTER TABLE gongde_creator_work_versions
  DROP INDEX uq_gongde_creator_version_revision,
  ADD KEY ix_gongde_creator_source_revision (work_id, source_revision);

CREATE TABLE IF NOT EXISTS gongde_creator_free_consents (
  consent_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  creator_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  work_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terms_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terms_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ai_terms_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ai_terms_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  public_text_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metadata_snapshot_json JSON NOT NULL,
  review_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_revision CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  accepted_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_gongde_creator_free_consent (version_id, terms_version, ai_terms_version),
  CONSTRAINT fk_gongde_creator_free_consent_owner FOREIGN KEY (work_id, creator_id)
    REFERENCES gongde_creator_works(work_id, creator_id),
  CONSTRAINT fk_gongde_creator_free_consent_version FOREIGN KEY (work_id, version_id)
    REFERENCES gongde_creator_work_versions(work_id, version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Recover ordering from existing approved evidence without granting free consent.
UPDATE gongde_creator_works w
JOIN (SELECT v.work_id, MIN(r.decided_at) AS first_published_at
      FROM gongde_creator_work_versions v JOIN gongde_creator_reviews r ON r.version_id = v.version_id
      WHERE r.state = 'APPROVED' AND r.decided_at IS NOT NULL GROUP BY v.work_id) first_review
  ON first_review.work_id = w.work_id
SET w.first_published_at = first_review.first_published_at
WHERE w.published_version_id IS NOT NULL AND w.first_published_at IS NULL;
