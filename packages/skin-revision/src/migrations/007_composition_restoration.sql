ALTER TABLE composition_project
  ADD COLUMN restoration_version INTEGER NOT NULL DEFAULT 0
  CHECK (restoration_version >= 0);

ALTER TABLE composition_project
  ADD COLUMN restoration_plan_json TEXT
  CHECK (
    restoration_plan_json IS NULL OR
    json_valid(restoration_plan_json)
  );

CREATE TABLE composition_restoration_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  composition_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('plan_set', 'plan_cleared')
  ),
  candidate_set_hash TEXT,
  candidate_ids_json TEXT NOT NULL CHECK (json_valid(candidate_ids_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (composition_id) REFERENCES composition_project(id) ON DELETE RESTRICT,
  UNIQUE (composition_id, version)
) STRICT;

CREATE INDEX idx_composition_restoration_event_project
  ON composition_restoration_event(composition_id, id);

CREATE TRIGGER composition_restoration_event_no_update
BEFORE UPDATE ON composition_restoration_event
BEGIN
  SELECT RAISE(ABORT, 'composition restoration events are append-only');
END;

CREATE TRIGGER composition_restoration_event_no_delete
BEFORE DELETE ON composition_restoration_event
BEGIN
  SELECT RAISE(ABORT, 'composition restoration events are append-only');
END;
