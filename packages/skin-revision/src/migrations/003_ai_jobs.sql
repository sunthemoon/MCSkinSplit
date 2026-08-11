CREATE TABLE ai_job (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  input_revision_id TEXT NOT NULL,
  result_revision_id TEXT,
  retry_of_job_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'preparing', 'running', 'validating', 'succeeded', 'failed', 'cancelled')
  ),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  skill_name TEXT NOT NULL CHECK (length(skill_name) BETWEEN 1 AND 80),
  skill_version TEXT NOT NULL CHECK (length(skill_version) BETWEEN 1 AND 40),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 80),
  input_hash TEXT CHECK (
    input_hash IS NULL OR
    (input_hash GLOB 'sha256:[0-9a-f]*' AND length(input_hash) = 71)
  ),
  output_hash TEXT CHECK (
    output_hash IS NULL OR
    (output_hash GLOB 'sha256:[0-9a-f]*' AND length(output_hash) = 71)
  ),
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  review_items_json TEXT NOT NULL CHECK (json_valid(review_items_json)),
  proposal_summary TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (input_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (retry_of_job_id) REFERENCES ai_job(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE ai_run (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  thread_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  workspace_path TEXT NOT NULL UNIQUE,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  FOREIGN KEY (job_id) REFERENCES ai_job(id) ON DELETE RESTRICT,
  UNIQUE (job_id, attempt)
) STRICT;

CREATE TABLE ai_run_asset (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  file_role TEXT NOT NULL CHECK (
    file_role IN ('input_manifest', 'raw_events', 'raw_output', 'validator_report', 'stderr')
  ),
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (
    sha256 GLOB 'sha256:[0-9a-f]*' AND length(sha256) = 71
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES ai_run(id) ON DELETE RESTRICT,
  UNIQUE (run_id, file_role)
) STRICT;

CREATE TABLE ai_job_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES ai_job(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_ai_job_project_created ON ai_job(project_id, created_at);
CREATE INDEX idx_ai_job_revision_created ON ai_job(input_revision_id, created_at);
CREATE INDEX idx_ai_job_status_created ON ai_job(status, created_at);
CREATE INDEX idx_ai_run_job_attempt ON ai_run(job_id, attempt);
CREATE INDEX idx_ai_run_asset_run ON ai_run_asset(run_id, file_role);
CREATE INDEX idx_ai_job_event_job ON ai_job_event(job_id, id);
