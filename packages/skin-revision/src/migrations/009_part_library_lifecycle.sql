ALTER TABLE part_asset
  ADD COLUMN library_status TEXT NOT NULL DEFAULT 'active'
  CHECK (library_status IN ('active', 'retired'));

ALTER TABLE part_asset ADD COLUMN retired_at TEXT;
ALTER TABLE part_asset ADD COLUMN retired_reason TEXT;

ALTER TABLE part_bundle
  ADD COLUMN library_status TEXT NOT NULL DEFAULT 'active'
  CHECK (library_status IN ('active', 'retired'));

ALTER TABLE part_bundle ADD COLUMN retired_at TEXT;
ALTER TABLE part_bundle ADD COLUMN retired_reason TEXT;

CREATE INDEX idx_part_asset_library_status
  ON part_asset(library_status, created_at, id);
CREATE INDEX idx_part_bundle_library_status
  ON part_bundle(library_status, created_at, id);

CREATE TRIGGER part_asset_lifecycle_insert_guard
BEFORE INSERT ON part_asset
WHEN NOT (
  (NEW.library_status = 'active' AND NEW.retired_at IS NULL AND NEW.retired_reason IS NULL)
  OR (NEW.library_status = 'retired' AND NEW.retired_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid part_asset lifecycle state');
END;

CREATE TRIGGER part_asset_lifecycle_update_guard
BEFORE UPDATE OF library_status, retired_at, retired_reason ON part_asset
WHEN NOT (
  (NEW.library_status = 'active' AND NEW.retired_at IS NULL AND NEW.retired_reason IS NULL)
  OR (NEW.library_status = 'retired' AND NEW.retired_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid part_asset lifecycle state');
END;

CREATE TRIGGER part_bundle_lifecycle_insert_guard
BEFORE INSERT ON part_bundle
WHEN NOT (
  (NEW.library_status = 'active' AND NEW.retired_at IS NULL AND NEW.retired_reason IS NULL)
  OR (NEW.library_status = 'retired' AND NEW.retired_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid part_bundle lifecycle state');
END;

CREATE TRIGGER part_bundle_lifecycle_update_guard
BEFORE UPDATE OF library_status, retired_at, retired_reason ON part_bundle
WHEN NOT (
  (NEW.library_status = 'active' AND NEW.retired_at IS NULL AND NEW.retired_reason IS NULL)
  OR (NEW.library_status = 'retired' AND NEW.retired_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid part_bundle lifecycle state');
END;
