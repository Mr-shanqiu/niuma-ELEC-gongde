-- Identity registry only, not a new source of publication, price or package truth.
-- Keep rows permanently, including rejected, unpublished and suspended works.
-- MySQL DDL implicitly commits. Stop creator writes while applying/backfilling.
CREATE TABLE IF NOT EXISTS gongde_appearance_numbers (
  appearance_serial INT UNSIGNED NOT NULL PRIMARY KEY,
  source_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  internal_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_gongde_appearance_identity (source_kind, internal_id),
  CONSTRAINT ck_gongde_appearance_serial CHECK (appearance_serial BETWEEN 100001 AND 999999999),
  CONSTRAINT ck_gongde_appearance_source CHECK (source_kind IN ('official', 'community'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Explicit bindings, never a catalog array position, title, preview slug or SKU renumber.
-- Exact existing pairs are skipped on a partial retry. A conflicting binding fails,
-- rather than being overwritten or silently accepted by INSERT IGNORE.
INSERT INTO gongde_appearance_numbers (appearance_serial, source_kind, internal_id)
SELECT seed.serial, 'official', seed.asset_id FROM (
  SELECT 100001 AS serial, 'official.lucky-cat' AS asset_id
  UNION ALL SELECT 100002, 'official.hamster-wheel'
  UNION ALL SELECT 100003, 'official.sea-lion-belly-pat'
  UNION ALL SELECT 100004, 'official.chick-pecking'
  UNION ALL SELECT 100005, 'zqscreen.caishen-ingot'
  UNION ALL SELECT 100006, 'zqscreen.redpanda-wave'
  UNION ALL SELECT 100007, 'zqscreen.shiba-tilt'
  UNION ALL SELECT 100008, 'zqscreen.orange-cat-wave'
  UNION ALL SELECT 100009, 'zqscreen.raccoon-cheer'
  UNION ALL SELECT 100010, 'zqscreen.golden-toad-coin'
  UNION ALL SELECT 100011, 'zqscreen.little-jiangshi-hop'
  UNION ALL SELECT 100012, 'zqscreen.frog-puff'
  UNION ALL SELECT 100013, 'zqscreen.bee-flap'
  UNION ALL SELECT 100014, 'zqscreen.koi-bubbles'
  UNION ALL SELECT 100015, 'zqscreen.kiss-couple'
  UNION ALL SELECT 100016, 'zqscreen.baodan-charm'
  UNION ALL SELECT 100017, 'zqscreen.woodpecker-peck'
  UNION ALL SELECT 100018, 'zqscreen.zhuan-yun-bead'
  UNION ALL SELECT 100019, 'zqscreen.treasure-basin'
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM gongde_appearance_numbers n WHERE n.appearance_serial = seed.serial
    AND n.source_kind = 'official' AND n.internal_id = seed.asset_id
);

-- All historical work states receive numbers exactly once. Existing rows win.
INSERT INTO gongde_appearance_numbers (appearance_serial, source_kind, internal_id)
SELECT baseline.last_serial + missing.sequence_number, 'community', missing.work_id
FROM (
  SELECT w.work_id, ROW_NUMBER() OVER (ORDER BY w.created_at ASC, w.work_id ASC) AS sequence_number
  FROM gongde_creator_works w
  WHERE NOT EXISTS (
    SELECT 1 FROM gongde_appearance_numbers n WHERE n.source_kind = 'community' AND n.internal_id = w.work_id
  )
) AS missing
CROSS JOIN (
  SELECT COALESCE(MAX(appearance_serial), 100000) AS last_serial FROM gongde_appearance_numbers
) AS baseline;

-- MySQL forbids CHECK constraints on AUTO_INCREMENT columns. Allocate under a
-- singleton row lock in the work-creation transaction instead. The upper bound
-- includes one exhausted-capacity sentinel, which never becomes a public number.
CREATE TABLE IF NOT EXISTS gongde_appearance_number_allocator (
  allocator_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  next_serial INT UNSIGNED NOT NULL,
  CONSTRAINT ck_gongde_appearance_allocator_singleton CHECK (allocator_id = 1),
  CONSTRAINT ck_gongde_appearance_allocator_range CHECK (next_serial BETWEEN 100001 AND 1000000000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A migration retry can advance the watermark, but must never rewind it.
INSERT INTO gongde_appearance_number_allocator (allocator_id, next_serial)
SELECT 1, COALESCE(MAX(appearance_serial), 100000) + 1 FROM gongde_appearance_numbers
ON DUPLICATE KEY UPDATE next_serial = GREATEST(next_serial,
  (SELECT COALESCE(MAX(appearance_serial), 100000) + 1 FROM gongde_appearance_numbers));
