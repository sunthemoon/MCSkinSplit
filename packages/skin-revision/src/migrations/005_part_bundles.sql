CREATE TABLE part_bundle (
  id TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('hair', 'clothing', 'accessory')),
  source_group_key TEXT,
  arm_types_json TEXT NOT NULL CHECK (json_valid(arm_types_json)),
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  FOREIGN KEY (source_project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE part_bundle_member (
  bundle_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (bundle_id, part_id),
  UNIQUE (bundle_id, position),
  FOREIGN KEY (bundle_id) REFERENCES part_bundle(id) ON DELETE RESTRICT,
  FOREIGN KEY (part_id) REFERENCES part_asset(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_part_bundle_source
  ON part_bundle(source_revision_id, created_at);
CREATE INDEX idx_part_bundle_kind
  ON part_bundle(kind, created_at);
CREATE INDEX idx_part_bundle_member_position
  ON part_bundle_member(bundle_id, position);
