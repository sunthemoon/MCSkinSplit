CREATE TABLE part_edit_project (
  id TEXT PRIMARY KEY,
  base_part_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('draft', 'committed')),
  head_revision_id TEXT,
  result_part_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  FOREIGN KEY (base_part_id) REFERENCES part_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (head_revision_id) REFERENCES part_edit_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_part_id) REFERENCES part_asset(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'draft' AND result_part_id IS NULL AND committed_at IS NULL) OR
    (status = 'committed' AND result_part_id IS NOT NULL AND committed_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE part_edit_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_revision_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  operation_type TEXT NOT NULL CHECK (
    operation_type IN (
      'init',
      'paint_color',
      'erase_pixels',
      'replace_color',
      'copy_surfaces'
    )
  ),
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  actor_id TEXT,
  texture_storage_path TEXT NOT NULL UNIQUE,
  texture_byte_size INTEGER NOT NULL CHECK (texture_byte_size >= 0),
  texture_sha256 TEXT NOT NULL CHECK (
    texture_sha256 GLOB 'sha256:[0-9a-f]*' AND length(texture_sha256) = 71
  ),
  mask_storage_path TEXT NOT NULL UNIQUE,
  mask_byte_size INTEGER NOT NULL CHECK (mask_byte_size >= 0),
  mask_sha256 TEXT NOT NULL CHECK (
    mask_sha256 GLOB 'sha256:[0-9a-f]*' AND length(mask_sha256) = 71
  ),
  revision_storage_path TEXT NOT NULL UNIQUE,
  revision_byte_size INTEGER NOT NULL CHECK (revision_byte_size >= 0),
  revision_sha256 TEXT NOT NULL CHECK (
    revision_sha256 GLOB 'sha256:[0-9a-f]*' AND length(revision_sha256) = 71
  ),
  changed_pixel_count INTEGER NOT NULL CHECK (changed_pixel_count >= 0),
  authored_provenance_json TEXT NOT NULL CHECK (json_valid(authored_provenance_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES part_edit_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_revision_id) REFERENCES part_edit_revision(id) ON DELETE RESTRICT,
  UNIQUE (project_id, sequence)
) STRICT;

CREATE INDEX idx_part_edit_project_base
  ON part_edit_project(base_part_id, created_at);
CREATE INDEX idx_part_edit_project_status
  ON part_edit_project(status, updated_at);
CREATE INDEX idx_part_edit_revision_project
  ON part_edit_revision(project_id, sequence);
