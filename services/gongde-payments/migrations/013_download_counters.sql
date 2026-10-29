CREATE TABLE IF NOT EXISTS gongde_download_counter_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  phase VARCHAR(16) NOT NULL,
  coverage_since DATETIME(3) NOT NULL,
  initialized_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gongde_download_totals (
  file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  is_legacy TINYINT UNSIGNED NOT NULL,
  platform VARCHAR(16) NULL,
  request_count BIGINT UNSIGNED NOT NULL,
  first_at DATETIME(3) NOT NULL,
  PRIMARY KEY (file_name, is_legacy)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gongde_download_daily (
  day_key DATE NOT NULL,
  file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  request_count BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (day_key, file_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gongde_download_recent (
  event_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  occurred_at DATETIME(3) NOT NULL,
  file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  is_legacy TINYINT UNSIGNED NOT NULL,
  INDEX ix_download_recent_time (occurred_at, is_legacy)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gongde_download_imported_events (
  event_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  occurred_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
