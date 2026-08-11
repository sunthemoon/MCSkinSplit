CREATE TABLE part_file_asset (
  id TEXT PRIMARY KEY,
  part_id TEXT,
  file_role TEXT NOT NULL CHECK (
    file_role IN ('texture', 'write_mask', 'manifest', 'preview', 'source')
  ),
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (
    sha256 GLOB 'sha256:[0-9a-f]*' AND length(sha256) = 71
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (part_id) REFERENCES part_asset(id) ON DELETE RESTRICT,
  UNIQUE (part_id, file_role)
) STRICT;

CREATE TABLE part_asset (
  id TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  source_component_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category TEXT NOT NULL,
  subtype TEXT,
  arm_type TEXT NOT NULL CHECK (arm_type IN ('wide', 'slim')),
  texture_asset_id TEXT NOT NULL UNIQUE,
  mask_asset_id TEXT NOT NULL UNIQUE,
  manifest_asset_id TEXT NOT NULL UNIQUE,
  preview_asset_id TEXT NOT NULL UNIQUE,
  source_asset_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  FOREIGN KEY (source_project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (texture_asset_id) REFERENCES part_file_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (mask_asset_id) REFERENCES part_file_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (manifest_asset_id) REFERENCES part_file_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (preview_asset_id) REFERENCES part_file_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_asset_id) REFERENCES part_file_asset(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_part_asset_source ON part_asset(source_project_id, created_at);
CREATE INDEX idx_part_asset_category ON part_asset(category, created_at);
CREATE INDEX idx_part_file_asset_part ON part_file_asset(part_id, file_role);
