DROP TRIGGER IF EXISTS semantic_analysis_followup_assessment_insert_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_assessment_update_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_insert_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_job_success_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_update_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_status_transition_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_applied_revision_insert_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_applied_revision_update_guard;
DROP TRIGGER IF EXISTS semantic_analysis_followup_identity_immutable;
DROP INDEX IF EXISTS idx_semantic_analysis_followup_status;

ALTER TABLE semantic_analysis_followup
  RENAME TO semantic_analysis_followup_v11;

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
    json_type(assessment_json, '$') IS 'object' AND
    json_extract(assessment_json, '$.schemaVersion') IS '1.0' AND
    json_type(assessment_json, '$.algorithmVersion') IS 'text' AND
    length(json_extract(assessment_json, '$.algorithmVersion')) BETWEEN 1 AND 80 AND
    json_type(assessment_json, '$.suggestions') IS 'array' AND
    json_type(assessment_json, '$.notices') IS 'array' AND
    (
      json_extract(assessment_json, '$.algorithmVersion') <>
        'cross-body-hair-reclassification-v2' OR
      json_array_length(assessment_json, '$.suggestions') <= 1
    )
  ),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 71 AND
    substr(evidence_hash, 1, 7) = 'sha256:' AND
    substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*' AND
    json_extract(assessment_json, '$.evidenceHash') IS evidence_hash
  ),
  applied_revision_id TEXT UNIQUE,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  CHECK (
    (status = 'applied' AND applied_revision_id IS NOT NULL) OR
    (status <> 'applied' AND applied_revision_id IS NULL)
  ),
  CHECK (
    (status = 'no_repair' AND json_array_length(assessment_json, '$.suggestions') = 0) OR
    (status <> 'no_repair' AND json_array_length(assessment_json, '$.suggestions') > 0)
  ),
  FOREIGN KEY (job_id) REFERENCES ai_job(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (applied_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER semantic_analysis_followup_insert_guard
BEFORE INSERT ON semantic_analysis_followup
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_job AS job
  JOIN skin_revision AS result
    ON result.id = NEW.result_revision_id
  JOIN ai_run AS run
    ON run.id = result.ai_run_id
   AND run.job_id = job.id
  WHERE job.id = NEW.job_id
    AND job.job_kind = 'semantic_analysis'
    AND job.status IN ('validating', 'succeeded')
    AND result.project_id = job.project_id
    AND result.operation_type = 'ai_segment'
    AND result.actor_type = 'ai'
    AND result.ai_run_id = run.id
    AND result.parent_revision_id = job.input_revision_id
    AND json_extract(result.metadata_json, '$.aiJobId') = job.id
    AND json_extract(result.metadata_json, '$.aiRunId') = run.id
    AND json_extract(result.metadata_json, '$.provider') = job.provider
    AND json_extract(result.metadata_json, '$.model') = job.model
    AND (
      job.status <> 'succeeded' OR
      (
        job.result_revision_id = NEW.result_revision_id AND
        job.finished_at IS NOT NULL
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid semantic analysis followup target');
END;

CREATE TRIGGER semantic_analysis_followup_job_success_guard
BEFORE UPDATE OF status, result_revision_id ON ai_job
WHEN NEW.status = 'succeeded' AND EXISTS (
  SELECT 1
  FROM semantic_analysis_followup AS followup
  WHERE followup.job_id = NEW.id
    AND followup.result_revision_id IS NOT NEW.result_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'semantic analysis followup result mismatch');
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

CREATE TRIGGER semantic_analysis_followup_status_transition_guard
BEFORE UPDATE OF status, applied_revision_id ON semantic_analysis_followup
WHEN NOT (
  (
    OLD.status = 'awaiting_review' AND
    NEW.status IN ('applied', 'dismissed', 'assessment_failed')
  ) OR
  (
    OLD.status IS NEW.status AND
    OLD.applied_revision_id IS NEW.applied_revision_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid semantic analysis followup status transition');
END;

CREATE TRIGGER semantic_analysis_followup_applied_revision_insert_guard
BEFORE INSERT ON semantic_analysis_followup
WHEN NEW.applied_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM skin_revision AS applied
  JOIN skin_revision AS result
    ON result.id = NEW.result_revision_id
  JOIN skin_revision AS parent
    ON parent.id = applied.parent_revision_id
  WHERE applied.id = NEW.applied_revision_id
    AND applied.project_id = result.project_id
    AND applied.id <> result.id
    AND applied.operation_type = 'manual_edit'
    AND applied.actor_type = 'user'
    AND applied.actor_id = 'semantic-followup'
    AND parent.project_id = result.project_id
    AND parent.branch_id = applied.branch_id
    AND parent.operation_type = 'branch'
    AND parent.actor_type = 'user'
    AND parent.actor_id = 'semantic-followup'
    AND parent.parent_revision_id = result.id
    AND json_extract(parent.metadata_json, '$.baseRevisionId') = result.id
    AND json_extract(applied.metadata_json, '$.operation.type') = 'assign_pixels'
    AND json_extract(applied.metadata_json, '$.operation.target.category') = 'hair'
    AND json_extract(applied.metadata_json, '$.semanticFollowup.jobId') = NEW.job_id
    AND json_extract(applied.metadata_json, '$.semanticFollowup.resultRevisionId') = NEW.result_revision_id
    AND json_extract(applied.metadata_json, '$.semanticFollowup.evidenceHash') = NEW.evidence_hash
    AND EXISTS (
      SELECT 1
      FROM json_each(NEW.assessment_json, '$.suggestions') AS suggestion
      WHERE json_extract(suggestion.value, '$.id') =
        json_extract(applied.metadata_json, '$.semanticFollowup.suggestionId')
        AND json_extract(suggestion.value, '$.targetComponentId') =
          json_extract(applied.metadata_json, '$.operation.target.instanceId')
        AND json_array_length(suggestion.value, '$.spans') =
          json_array_length(applied.metadata_json, '$.operation.spans')
        AND NOT EXISTS (
          SELECT
            json_extract(expected.value, '$.surface'),
            json_extract(expected.value, '$.y'),
            json_extract(expected.value, '$.x0'),
            json_extract(expected.value, '$.x1'),
            count(*)
          FROM json_each(suggestion.value, '$.spans') AS expected
          GROUP BY 1, 2, 3, 4
          EXCEPT
          SELECT
            json_extract(actual.value, '$.surface'),
            json_extract(actual.value, '$.y'),
            json_extract(actual.value, '$.x0'),
            json_extract(actual.value, '$.x1'),
            count(*)
          FROM json_each(applied.metadata_json, '$.operation.spans') AS actual
          GROUP BY 1, 2, 3, 4
        )
        AND NOT EXISTS (
          SELECT
            json_extract(actual.value, '$.surface'),
            json_extract(actual.value, '$.y'),
            json_extract(actual.value, '$.x0'),
            json_extract(actual.value, '$.x1'),
            count(*)
          FROM json_each(applied.metadata_json, '$.operation.spans') AS actual
          GROUP BY 1, 2, 3, 4
          EXCEPT
          SELECT
            json_extract(expected.value, '$.surface'),
            json_extract(expected.value, '$.y'),
            json_extract(expected.value, '$.x0'),
            json_extract(expected.value, '$.x1'),
            count(*)
          FROM json_each(suggestion.value, '$.spans') AS expected
          GROUP BY 1, 2, 3, 4
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid semantic analysis applied revision');
END;

INSERT INTO semantic_analysis_followup (
  job_id,
  result_revision_id,
  status,
  assessment_json,
  evidence_hash,
  applied_revision_id,
  created_at,
  updated_at
)
SELECT
  job_id,
  result_revision_id,
  status,
  assessment_json,
  evidence_hash,
  applied_revision_id,
  created_at,
  updated_at
FROM semantic_analysis_followup_v11;

DROP TABLE semantic_analysis_followup_v11;

CREATE INDEX idx_semantic_analysis_followup_status
  ON semantic_analysis_followup(status, updated_at, job_id);

CREATE TRIGGER semantic_analysis_followup_applied_revision_update_guard
BEFORE UPDATE OF applied_revision_id ON semantic_analysis_followup
WHEN NEW.applied_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM skin_revision AS applied
  JOIN skin_revision AS result
    ON result.id = NEW.result_revision_id
  JOIN skin_revision AS parent
    ON parent.id = applied.parent_revision_id
  WHERE applied.id = NEW.applied_revision_id
    AND applied.project_id = result.project_id
    AND applied.id <> result.id
    AND applied.operation_type = 'manual_edit'
    AND applied.actor_type = 'user'
    AND applied.actor_id = 'semantic-followup'
    AND parent.project_id = result.project_id
    AND parent.branch_id = applied.branch_id
    AND parent.operation_type = 'branch'
    AND parent.actor_type = 'user'
    AND parent.actor_id = 'semantic-followup'
    AND parent.parent_revision_id = result.id
    AND json_extract(parent.metadata_json, '$.baseRevisionId') = result.id
    AND json_extract(applied.metadata_json, '$.operation.type') = 'assign_pixels'
    AND json_extract(applied.metadata_json, '$.operation.target.category') = 'hair'
    AND json_extract(applied.metadata_json, '$.semanticFollowup.jobId') = NEW.job_id
    AND json_extract(applied.metadata_json, '$.semanticFollowup.resultRevisionId') = NEW.result_revision_id
    AND json_extract(applied.metadata_json, '$.semanticFollowup.evidenceHash') = NEW.evidence_hash
    AND EXISTS (
      SELECT 1
      FROM json_each(NEW.assessment_json, '$.suggestions') AS suggestion
      WHERE json_extract(suggestion.value, '$.id') =
        json_extract(applied.metadata_json, '$.semanticFollowup.suggestionId')
        AND json_extract(suggestion.value, '$.targetComponentId') =
          json_extract(applied.metadata_json, '$.operation.target.instanceId')
        AND json_array_length(suggestion.value, '$.spans') =
          json_array_length(applied.metadata_json, '$.operation.spans')
        AND NOT EXISTS (
          SELECT
            json_extract(expected.value, '$.surface'),
            json_extract(expected.value, '$.y'),
            json_extract(expected.value, '$.x0'),
            json_extract(expected.value, '$.x1'),
            count(*)
          FROM json_each(suggestion.value, '$.spans') AS expected
          GROUP BY 1, 2, 3, 4
          EXCEPT
          SELECT
            json_extract(actual.value, '$.surface'),
            json_extract(actual.value, '$.y'),
            json_extract(actual.value, '$.x0'),
            json_extract(actual.value, '$.x1'),
            count(*)
          FROM json_each(applied.metadata_json, '$.operation.spans') AS actual
          GROUP BY 1, 2, 3, 4
        )
        AND NOT EXISTS (
          SELECT
            json_extract(actual.value, '$.surface'),
            json_extract(actual.value, '$.y'),
            json_extract(actual.value, '$.x0'),
            json_extract(actual.value, '$.x1'),
            count(*)
          FROM json_each(applied.metadata_json, '$.operation.spans') AS actual
          GROUP BY 1, 2, 3, 4
          EXCEPT
          SELECT
            json_extract(expected.value, '$.surface'),
            json_extract(expected.value, '$.y'),
            json_extract(expected.value, '$.x0'),
            json_extract(expected.value, '$.x1'),
            count(*)
          FROM json_each(suggestion.value, '$.spans') AS expected
          GROUP BY 1, 2, 3, 4
        )
    )
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
