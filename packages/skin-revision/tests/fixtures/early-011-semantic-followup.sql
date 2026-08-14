CREATE TABLE semantic_analysis_followup (
  job_id TEXT PRIMARY KEY,
  result_revision_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN (
      'no_repair',
      'awaiting_review',
      'applied',
      'dismissed',
      'assessment_failed'
    )
  ),
  assessment_json TEXT NOT NULL CHECK (
    json_valid(assessment_json) AND
    json_type(assessment_json, '$') = 'object' AND
    json_extract(assessment_json, '$.schemaVersion') = '1.0' AND
    json_type(assessment_json, '$.suggestions') = 'array' AND
    json_type(assessment_json, '$.notices') = 'array'
  ),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 71 AND
    substr(evidence_hash, 1, 7) = 'sha256:' AND
    substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*' AND
    json_extract(assessment_json, '$.evidenceHash') = evidence_hash
  ),
  applied_revision_id TEXT UNIQUE,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  CHECK (
    (status = 'applied' AND applied_revision_id IS NOT NULL) OR
    (status <> 'applied' AND applied_revision_id IS NULL)
  ),
  FOREIGN KEY (job_id) REFERENCES ai_job(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (applied_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_semantic_analysis_followup_status
  ON semantic_analysis_followup(status, updated_at, job_id);

CREATE TRIGGER semantic_analysis_followup_insert_guard
BEFORE INSERT ON semantic_analysis_followup
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_job AS job
  WHERE job.id = NEW.job_id
    AND job.job_kind = 'semantic_analysis'
    AND job.status = 'succeeded'
    AND job.result_revision_id = NEW.result_revision_id
    AND job.finished_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid semantic analysis followup target');
END;

CREATE TRIGGER semantic_analysis_followup_update_guard
BEFORE UPDATE ON semantic_analysis_followup
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_job AS job
  WHERE job.id = NEW.job_id
    AND job.job_kind = 'semantic_analysis'
    AND job.status = 'succeeded'
    AND job.result_revision_id = NEW.result_revision_id
    AND job.finished_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid semantic analysis followup target');
END;

CREATE TRIGGER semantic_analysis_followup_applied_revision_insert_guard
BEFORE INSERT ON semantic_analysis_followup
WHEN NEW.applied_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM skin_revision AS applied
  JOIN skin_revision AS result
    ON result.id = NEW.result_revision_id
  WHERE applied.id = NEW.applied_revision_id
    AND applied.project_id = result.project_id
    AND applied.id <> result.id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid semantic analysis applied revision');
END;

CREATE TRIGGER semantic_analysis_followup_applied_revision_update_guard
BEFORE UPDATE OF applied_revision_id ON semantic_analysis_followup
WHEN NEW.applied_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM skin_revision AS applied
  JOIN skin_revision AS result
    ON result.id = NEW.result_revision_id
  WHERE applied.id = NEW.applied_revision_id
    AND applied.project_id = result.project_id
    AND applied.id <> result.id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid semantic analysis applied revision');
END;

CREATE TRIGGER semantic_analysis_followup_identity_immutable
BEFORE UPDATE ON semantic_analysis_followup
WHEN OLD.job_id IS NOT NEW.job_id OR
     OLD.result_revision_id IS NOT NEW.result_revision_id OR
     OLD.assessment_json IS NOT NEW.assessment_json OR
     OLD.evidence_hash IS NOT NEW.evidence_hash OR
     OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'semantic analysis followup evidence is immutable');
END;
