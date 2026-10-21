-- Preparation only: apply separately through the authorized migration process.
-- Reproduces the already-completed managed operation that bound the two official
-- appearances published after 006 (100024 offwork-button, 100025 wealth-button).
-- This does NOT re-run that operation and does NOT rewrite any existing binding.
--
-- Rules, all fail-closed:
--   * exact binding already present  -> no change
--   * binding absent, serial free    -> insert
--   * serial taken by another identity, or the asset id already bound to another
--     serial                         -> abort the whole migration with a named error
-- No INSERT IGNORE, REPLACE or unconditional UPDATE: a conflict must be visible.
-- Historical community works keep whatever numbers 006 gave them. Nothing is
-- renumbered, migrated or reclassified here.
--
-- The allocator is advanced in the same migration so a later work creation cannot
-- collide with either serial. It only ever moves forward.
--
-- scripts/migrate.mjs sends one statement at a time (multipleStatements is off),
-- so this file must not contain a stored program body.

CREATE TEMPORARY TABLE gongde_official_binding_seed (
  serial INT UNSIGNED NOT NULL PRIMARY KEY,
  asset_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY uq_seed_asset (asset_id)
) ENGINE=InnoDB;

INSERT INTO gongde_official_binding_seed (serial, asset_id) VALUES
  (100024, 'official.offwork-button'),
  (100025, 'official.wealth-button');

-- A serial must not already belong to a different identity.
SELECT COUNT(*) INTO @serial_conflicts
FROM gongde_official_binding_seed s
JOIN gongde_appearance_numbers n ON n.appearance_serial = s.serial
WHERE n.source_kind <> 'official' OR n.internal_id <> s.asset_id;

-- An official asset must not already be bound to a different serial.
SELECT COUNT(*) INTO @identity_conflicts
FROM gongde_official_binding_seed s
JOIN gongde_appearance_numbers n ON n.source_kind = 'official' AND n.internal_id = s.asset_id
WHERE n.appearance_serial <> s.serial;

-- Fail closed. SIGNAL needs a stored program and this runner sends one statement
-- at a time, so each guard is a one-row temporary table whose unique key already
-- holds 0: re-inserting 0 raises ER_DUP_ENTRY, and the key name in the error
-- states which conflict was found. Temporary-table DDL does not implicitly
-- commit, so a failure still rolls the migration back as a whole.
CREATE TEMPORARY TABLE gongde_official_binding_serial_guard (
  marker TINYINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_official_number_100024_100025_already_bound (marker)
) ENGINE=InnoDB;

INSERT INTO gongde_official_binding_serial_guard (marker) VALUES (0);

INSERT INTO gongde_official_binding_serial_guard (marker)
SELECT 0 FROM DUAL WHERE @serial_conflicts > 0;

CREATE TEMPORARY TABLE gongde_official_binding_identity_guard (
  marker TINYINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_official_offwork_wealth_bound_elsewhere (marker)
) ENGINE=InnoDB;

INSERT INTO gongde_official_binding_identity_guard (marker) VALUES (0);

INSERT INTO gongde_official_binding_identity_guard (marker)
SELECT 0 FROM DUAL WHERE @identity_conflicts > 0;

-- Only the missing rows are inserted. Existing exact bindings stay untouched.
INSERT INTO gongde_appearance_numbers (appearance_serial, source_kind, internal_id)
SELECT s.serial, 'official', s.asset_id
FROM gongde_official_binding_seed s
WHERE NOT EXISTS (
  SELECT 1 FROM gongde_appearance_numbers n
  WHERE n.appearance_serial = s.serial AND n.source_kind = 'official' AND n.internal_id = s.asset_id
);

-- Forward-only watermark: at least MAX(serial) + 1, never below the current value.
INSERT INTO gongde_appearance_number_allocator (allocator_id, next_serial)
SELECT 1, COALESCE(MAX(appearance_serial), 100000) + 1 FROM gongde_appearance_numbers
ON DUPLICATE KEY UPDATE next_serial = GREATEST(next_serial,
  (SELECT COALESCE(MAX(appearance_serial), 100000) + 1 FROM gongde_appearance_numbers));

DROP TEMPORARY TABLE gongde_official_binding_identity_guard;

DROP TEMPORARY TABLE gongde_official_binding_serial_guard;

DROP TEMPORARY TABLE gongde_official_binding_seed;
