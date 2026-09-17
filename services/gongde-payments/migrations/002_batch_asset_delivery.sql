ALTER TABLE gongde_orders
  ADD COLUMN asset_ids_json JSON NULL AFTER asset_id;

UPDATE gongde_orders
SET asset_ids_json = JSON_ARRAY(asset_id)
WHERE asset_ids_json IS NULL AND asset_id IS NOT NULL;
