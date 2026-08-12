ALTER TABLE ai_job
  ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'semantic_analysis'
  CHECK (job_kind IN ('semantic_analysis', 'restoration_recommendation'));

ALTER TABLE ai_job
  ADD COLUMN composition_id TEXT
  REFERENCES composition_project(id) ON DELETE RESTRICT;

ALTER TABLE ai_job
  ADD COLUMN advisory_result_json TEXT
  CHECK (
    advisory_result_json IS NULL OR
    json_valid(advisory_result_json)
  );

CREATE INDEX idx_ai_job_kind_created
  ON ai_job(job_kind, created_at);

CREATE INDEX idx_ai_job_composition_created
  ON ai_job(composition_id, created_at);

CREATE TRIGGER ai_job_kind_shape_insert
BEFORE INSERT ON ai_job
WHEN (
  (
    (
    NEW.job_kind = 'semantic_analysis' AND
    NEW.composition_id IS NULL AND
    NEW.advisory_result_json IS NULL AND
    json_type(NEW.options_json, '$') = 'object' AND
    json_extract(NEW.options_json, '$.mode') = 'full'
    ) OR
    (
    NEW.job_kind = 'restoration_recommendation' AND
    NEW.composition_id IS NOT NULL AND
    NEW.result_revision_id IS NULL AND
    json_type(NEW.options_json, '$') = 'object' AND
    json_extract(NEW.options_json, '$.mode') = 'restoration_recommendation' AND
    json_extract(NEW.options_json, '$.compositionId') = NEW.composition_id AND
    json_type(NEW.review_items_json, '$') = 'array' AND
    json_array_length(NEW.review_items_json) = 0 AND
    (
      (NEW.status = 'succeeded' AND NEW.advisory_result_json IS NOT NULL) OR
      (NEW.status <> 'succeeded' AND NEW.advisory_result_json IS NULL)
    ) AND
    EXISTS (
      SELECT 1
      FROM composition_project
      WHERE id = NEW.composition_id
        AND project_id = NEW.project_id
        AND base_revision_id = NEW.input_revision_id
    )
    )
  ) AND
  (
    NEW.retry_of_job_id IS NULL OR
    EXISTS (
      SELECT 1
      FROM ai_job AS retried_job
      WHERE retried_job.id = NEW.retry_of_job_id
        AND retried_job.job_kind = NEW.job_kind
        AND retried_job.project_id = NEW.project_id
        AND retried_job.input_revision_id = NEW.input_revision_id
        AND retried_job.composition_id IS NEW.composition_id
        AND retried_job.status IN ('succeeded', 'failed', 'cancelled')
    )
  )
) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'invalid AI job kind shape');
END;

CREATE TRIGGER ai_job_kind_shape_update
BEFORE UPDATE ON ai_job
WHEN (
  (
    (
    NEW.job_kind = 'semantic_analysis' AND
    NEW.composition_id IS NULL AND
    NEW.advisory_result_json IS NULL AND
    json_type(NEW.options_json, '$') = 'object' AND
    json_extract(NEW.options_json, '$.mode') = 'full'
    ) OR
    (
    NEW.job_kind = 'restoration_recommendation' AND
    NEW.composition_id IS NOT NULL AND
    NEW.result_revision_id IS NULL AND
    json_type(NEW.options_json, '$') = 'object' AND
    json_extract(NEW.options_json, '$.mode') = 'restoration_recommendation' AND
    json_extract(NEW.options_json, '$.compositionId') = NEW.composition_id AND
    json_type(NEW.review_items_json, '$') = 'array' AND
    json_array_length(NEW.review_items_json) = 0 AND
    (
      (NEW.status = 'succeeded' AND NEW.advisory_result_json IS NOT NULL) OR
      (NEW.status <> 'succeeded' AND NEW.advisory_result_json IS NULL)
    ) AND
    EXISTS (
      SELECT 1
      FROM composition_project
      WHERE id = NEW.composition_id
        AND project_id = NEW.project_id
        AND base_revision_id = NEW.input_revision_id
    )
    )
  ) AND
  (
    NEW.retry_of_job_id IS NULL OR
    EXISTS (
      SELECT 1
      FROM ai_job AS retried_job
      WHERE retried_job.id = NEW.retry_of_job_id
        AND retried_job.job_kind = NEW.job_kind
        AND retried_job.project_id = NEW.project_id
        AND retried_job.input_revision_id = NEW.input_revision_id
        AND retried_job.composition_id IS NEW.composition_id
        AND retried_job.status IN ('succeeded', 'failed', 'cancelled')
    )
  )
) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'invalid AI job kind shape');
END;

CREATE TRIGGER ai_job_identity_immutable
BEFORE UPDATE ON ai_job
WHEN OLD.job_kind IS NOT NEW.job_kind OR
     OLD.project_id IS NOT NEW.project_id OR
     OLD.input_revision_id IS NOT NEW.input_revision_id OR
     OLD.composition_id IS NOT NEW.composition_id OR
     OLD.retry_of_job_id IS NOT NEW.retry_of_job_id OR
     OLD.provider IS NOT NEW.provider OR
     OLD.model IS NOT NEW.model OR
     OLD.skill_name IS NOT NEW.skill_name OR
     OLD.skill_version IS NOT NEW.skill_version OR
     OLD.prompt_version IS NOT NEW.prompt_version OR
     OLD.options_json IS NOT NEW.options_json
BEGIN
  SELECT RAISE(ABORT, 'AI job identity is immutable');
END;

CREATE TRIGGER ai_job_advisory_result_immutable
BEFORE UPDATE ON ai_job
WHEN OLD.advisory_result_json IS NOT NULL AND
     OLD.advisory_result_json IS NOT NEW.advisory_result_json
BEGIN
  SELECT RAISE(ABORT, 'AI job advisory result is immutable');
END;
