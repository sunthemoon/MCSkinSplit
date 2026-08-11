CREATE TABLE skin_project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  default_branch_id TEXT,
  head_revision_id TEXT,
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  FOREIGN KEY (default_branch_id) REFERENCES skin_branch(id) ON DELETE RESTRICT,
  FOREIGN KEY (head_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE skin_branch (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  base_revision_id TEXT,
  head_revision_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (base_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (head_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  UNIQUE (project_id, name)
) STRICT;

CREATE TABLE skin_asset (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT,
  asset_type TEXT NOT NULL CHECK (
    asset_type IN (
      'source_skin',
      'revision_skin',
      'segmentation_json',
      'component_mask',
      'operation_json',
      'preview',
      'ai_input',
      'ai_output'
    )
  ),
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 GLOB 'sha256:[0-9a-f]*' AND length(sha256) = 71),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE skin_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_revision_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  operation_type TEXT NOT NULL CHECK (
    operation_type IN (
      'import',
      'ai_segment',
      'manual_edit',
      'merge_components',
      'split_component',
      'reclassify_component',
      'apply_part',
      'compose',
      'palette_change',
      'revert',
      'branch'
    )
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'system')),
  actor_id TEXT,
  ai_run_id TEXT,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  skin_asset_id TEXT NOT NULL,
  segmentation_asset_id TEXT NOT NULL,
  operation_asset_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash GLOB 'sha256:[0-9a-f]*' AND length(source_hash) = 71),
  result_hash TEXT NOT NULL CHECK (result_hash GLOB 'sha256:[0-9a-f]*' AND length(result_hash) = 71),
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id) REFERENCES skin_branch(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (skin_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (segmentation_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT,
  UNIQUE (branch_id, sequence)
) STRICT;

CREATE TABLE skin_operation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL,
  operation_asset_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_skin_branch_project ON skin_branch(project_id, created_at);
CREATE INDEX idx_skin_revision_project ON skin_revision(project_id, created_at);
CREATE INDEX idx_skin_revision_branch_sequence ON skin_revision(branch_id, sequence);
CREATE INDEX idx_skin_asset_revision ON skin_asset(revision_id, asset_type);
