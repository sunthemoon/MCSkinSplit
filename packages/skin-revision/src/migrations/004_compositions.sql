CREATE TABLE composition_project (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  arm_type TEXT NOT NULL CHECK (arm_type IN ('wide', 'slim')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'committed')),
  resolution_mode TEXT NOT NULL CHECK (
    resolution_mode IN ('unresolved', 'layer_order')
  ),
  conflict_winners_json TEXT NOT NULL CHECK (json_valid(conflict_winners_json)),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  result_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (base_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id) REFERENCES skin_branch(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE composition_layer (
  id TEXT PRIMARY KEY,
  composition_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (composition_id) REFERENCES composition_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (part_id) REFERENCES part_asset(id) ON DELETE RESTRICT,
  UNIQUE (composition_id, part_id),
  UNIQUE (composition_id, position)
) STRICT;

CREATE INDEX idx_composition_project_base
  ON composition_project(base_revision_id, created_at);
CREATE INDEX idx_composition_project_project
  ON composition_project(project_id, created_at);
CREATE INDEX idx_composition_layer_project
  ON composition_layer(composition_id, position);
