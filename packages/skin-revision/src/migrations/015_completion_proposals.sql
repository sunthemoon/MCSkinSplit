-- M19 stores hidden-content completion as its own immutable workflow. It does
-- not reuse semantic follow-up, composition restoration, or PartEdit state.
-- The migration rebuilds two closed-enum tables, so the host disables foreign
-- keys around this still-atomic migration and runs foreign_key_check before
-- committing it.
PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

DROP TRIGGER IF EXISTS skin_revision_immutable_update;
DROP TRIGGER IF EXISTS skin_revision_immutable_delete;
DROP TRIGGER IF EXISTS skin_revision_origin_required_insert;

ALTER TABLE skin_revision RENAME TO skin_revision_v14;

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
      'branch',
      'completion_accept'
    )
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'system')),
  actor_id TEXT,
  ai_run_id TEXT,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  skin_asset_id TEXT NOT NULL,
  segmentation_asset_id TEXT NOT NULL,
  operation_asset_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (
    length(source_hash) = 71 AND
    substr(source_hash, 1, 7) = 'sha256:' AND
    substr(source_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  result_hash TEXT NOT NULL CHECK (
    length(result_hash) = 71 AND
    substr(result_hash, 1, 7) = 'sha256:' AND
    substr(result_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  origin_asset_id TEXT,
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id) REFERENCES skin_branch(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (skin_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (segmentation_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_asset_id) REFERENCES skin_asset(id) ON DELETE RESTRICT,
  UNIQUE (branch_id, sequence)
) STRICT;

INSERT INTO skin_revision (
  id, project_id, branch_id, parent_revision_id, sequence, operation_type,
  actor_type, actor_id, ai_run_id, summary, skin_asset_id,
  segmentation_asset_id, operation_asset_id, source_hash, result_hash,
  created_at, metadata_json, origin_asset_id
)
SELECT
  id, project_id, branch_id, parent_revision_id, sequence, operation_type,
  actor_type, actor_id, ai_run_id, summary, skin_asset_id,
  segmentation_asset_id, operation_asset_id, source_hash, result_hash,
  created_at, metadata_json, origin_asset_id
FROM skin_revision_v14;

DROP TABLE skin_revision_v14;

CREATE INDEX idx_skin_revision_project
  ON skin_revision(project_id, created_at);
CREATE INDEX idx_skin_revision_branch_sequence
  ON skin_revision(branch_id, sequence);
CREATE UNIQUE INDEX idx_skin_revision_origin_asset
  ON skin_revision(origin_asset_id)
  WHERE origin_asset_id IS NOT NULL;

CREATE TRIGGER skin_revision_origin_required_insert
BEFORE INSERT ON skin_revision
WHEN NEW.origin_asset_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'new skin_revision requires origin asset');
END;

CREATE TRIGGER skin_revision_immutable_update
BEFORE UPDATE ON skin_revision
BEGIN
  SELECT RAISE(ABORT, 'skin_revision is immutable');
END;

CREATE TRIGGER skin_revision_immutable_delete
BEFORE DELETE ON skin_revision
BEGIN
  SELECT RAISE(ABORT, 'skin_revision is immutable');
END;

DROP TRIGGER IF EXISTS ai_job_kind_shape_insert;
DROP TRIGGER IF EXISTS ai_job_kind_shape_update;
DROP TRIGGER IF EXISTS ai_job_identity_immutable;
DROP TRIGGER IF EXISTS ai_job_advisory_result_immutable;

ALTER TABLE ai_job RENAME TO ai_job_v14;

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
    input_hash IS NULL OR (
      length(input_hash) = 71 AND
      substr(input_hash, 1, 7) = 'sha256:' AND
      substr(input_hash, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  output_hash TEXT CHECK (
    output_hash IS NULL OR (
      length(output_hash) = 71 AND
      substr(output_hash, 1, 7) = 'sha256:' AND
      substr(output_hash, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  review_items_json TEXT NOT NULL CHECK (json_valid(review_items_json)),
  proposal_summary TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  job_kind TEXT NOT NULL DEFAULT 'semantic_analysis' CHECK (
    job_kind IN (
      'semantic_analysis',
      'restoration_recommendation',
      'completion_proposal'
    )
  ),
  composition_id TEXT,
  advisory_result_json TEXT CHECK (
    advisory_result_json IS NULL OR json_valid(advisory_result_json)
  ),
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (input_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (retry_of_job_id) REFERENCES ai_job(id) ON DELETE RESTRICT,
  FOREIGN KEY (composition_id) REFERENCES composition_project(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO ai_job (
  id, project_id, input_revision_id, result_revision_id, retry_of_job_id,
  status, provider, model, skill_name, skill_version, prompt_version,
  input_hash, output_hash, options_json, review_items_json, proposal_summary,
  cancel_requested, created_at, started_at, finished_at, error_json,
  job_kind, composition_id, advisory_result_json
)
SELECT
  id, project_id, input_revision_id, result_revision_id, retry_of_job_id,
  status, provider, model, skill_name, skill_version, prompt_version,
  input_hash, output_hash, options_json, review_items_json, proposal_summary,
  cancel_requested, created_at, started_at, finished_at, error_json,
  job_kind, composition_id, advisory_result_json
FROM ai_job_v14;

DROP TABLE ai_job_v14;

CREATE INDEX idx_ai_job_project_created ON ai_job(project_id, created_at);
CREATE INDEX idx_ai_job_revision_created ON ai_job(input_revision_id, created_at);
CREATE INDEX idx_ai_job_status_created ON ai_job(status, created_at);
CREATE INDEX idx_ai_job_kind_created ON ai_job(job_kind, created_at);
CREATE INDEX idx_ai_job_composition_created ON ai_job(composition_id, created_at);

-- This guard belongs to ai_job and is therefore removed with the old table.
-- External M10/M12 triggers keep their canonical table references because the
-- rebuild runs with legacy_alter_table enabled.
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

PRAGMA legacy_alter_table = OFF;

CREATE TABLE completion_proposal (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  source_result_hash TEXT NOT NULL CHECK (
    length(source_result_hash) = 71 AND
    substr(source_result_hash, 1, 7) = 'sha256:' AND
    substr(source_result_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  source_skin_hash TEXT NOT NULL CHECK (
    length(source_skin_hash) = 71 AND
    substr(source_skin_hash, 1, 7) = 'sha256:' AND
    substr(source_skin_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  target_component_id TEXT NOT NULL CHECK (length(target_component_id) BETWEEN 1 AND 120),
  occluding_component_ids_json TEXT NOT NULL CHECK (
    json_valid(occluding_component_ids_json) AND
    json_type(occluding_component_ids_json, '$') = 'array' AND
    json_array_length(occluding_component_ids_json) > 0
  ),
  representation TEXT NOT NULL CHECK (
    representation IN ('skin_texel', 'latent_component')
  ),
  allowed_spans_json TEXT NOT NULL CHECK (
    json_valid(allowed_spans_json) AND
    json_type(allowed_spans_json, '$') = 'array'
  ),
  evidence_json TEXT NOT NULL CHECK (
    json_valid(evidence_json) AND json_type(evidence_json, '$') = 'object'
  ),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 71 AND
    substr(evidence_hash, 1, 7) = 'sha256:' AND
    substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  proposal_json TEXT NOT NULL CHECK (
    json_valid(proposal_json) AND json_type(proposal_json, '$') = 'object'
  ),
  proposal_hash TEXT NOT NULL CHECK (
    length(proposal_hash) = 71 AND
    substr(proposal_hash, 1, 7) = 'sha256:' AND
    substr(proposal_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  document_storage_path TEXT NOT NULL UNIQUE,
  document_byte_size INTEGER NOT NULL CHECK (document_byte_size >= 0),
  document_sha256 TEXT NOT NULL CHECK (
    length(document_sha256) = 71 AND
    substr(document_sha256, 1, 7) = 'sha256:' AND
    substr(document_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  allowed_mask_storage_path TEXT NOT NULL UNIQUE,
  allowed_mask_byte_size INTEGER NOT NULL CHECK (allowed_mask_byte_size >= 0),
  allowed_mask_sha256 TEXT NOT NULL CHECK (
    length(allowed_mask_sha256) = 71 AND
    substr(allowed_mask_sha256, 1, 7) = 'sha256:' AND
    substr(allowed_mask_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  FOREIGN KEY (job_id) REFERENCES ai_job(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE completion_candidate (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  representation TEXT NOT NULL CHECK (
    representation IN ('skin_texel', 'latent_component')
  ),
  strategy TEXT NOT NULL CHECK (
    strategy IN (
      'opposite_layer_underlay',
      'mirrored_counterpart',
      'same_surface_continuation',
      'opposite_surface_reference',
      'neighbor_reference',
      'pattern_continuation',
      'manual_edit'
    )
  ),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'manual')),
  origin_mode TEXT NOT NULL CHECK (
    origin_mode IN (
      'generated_completion',
      'generated_completion_with_copy',
      'manual_authored',
      'mixed'
    )
  ),
  pixel_count INTEGER NOT NULL CHECK (pixel_count > 0),
  generated_pixel_count INTEGER NOT NULL CHECK (
    generated_pixel_count >= 0 AND generated_pixel_count <= pixel_count
  ),
  candidate_json TEXT NOT NULL CHECK (
    json_valid(candidate_json) AND json_type(candidate_json, '$') = 'object'
  ),
  candidate_hash TEXT NOT NULL CHECK (
    length(candidate_hash) = 71 AND
    substr(candidate_hash, 1, 7) = 'sha256:' AND
    substr(candidate_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 71 AND
    substr(evidence_hash, 1, 7) = 'sha256:' AND
    substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  document_storage_path TEXT NOT NULL UNIQUE,
  document_byte_size INTEGER NOT NULL CHECK (document_byte_size >= 0),
  document_sha256 TEXT NOT NULL CHECK (
    length(document_sha256) = 71 AND
    substr(document_sha256, 1, 7) = 'sha256:' AND
    substr(document_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  texture_storage_path TEXT NOT NULL UNIQUE,
  texture_byte_size INTEGER NOT NULL CHECK (texture_byte_size >= 0),
  texture_sha256 TEXT NOT NULL CHECK (
    length(texture_sha256) = 71 AND
    substr(texture_sha256, 1, 7) = 'sha256:' AND
    substr(texture_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  write_mask_storage_path TEXT NOT NULL UNIQUE,
  write_mask_byte_size INTEGER NOT NULL CHECK (write_mask_byte_size >= 0),
  write_mask_sha256 TEXT NOT NULL CHECK (
    length(write_mask_sha256) = 71 AND
    substr(write_mask_sha256, 1, 7) = 'sha256:' AND
    substr(write_mask_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  generated_mask_storage_path TEXT NOT NULL UNIQUE,
  generated_mask_byte_size INTEGER NOT NULL CHECK (generated_mask_byte_size >= 0),
  generated_mask_sha256 TEXT NOT NULL CHECK (
    length(generated_mask_sha256) = 71 AND
    substr(generated_mask_sha256, 1, 7) = 'sha256:' AND
    substr(generated_mask_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  FOREIGN KEY (proposal_id) REFERENCES completion_proposal(id) ON DELETE RESTRICT,
  UNIQUE (proposal_id, id)
) STRICT;

-- Optional AI ranking is an immutable attachment. It can order/recommend only
-- existing candidate ids; candidate bytes, hashes, and decision checks remain
-- authoritative and independent from this advisory row.
CREATE TABLE completion_proposal_ranking (
  proposal_id TEXT NOT NULL,
  job_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  reasoning_effort TEXT NOT NULL CHECK (
    reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')
  ),
  ranking_json TEXT NOT NULL CHECK (
    json_valid(ranking_json) AND
    json_type(ranking_json, '$') = 'object' AND
    json_type(ranking_json, '$.rankings') = 'array' AND
    json_type(ranking_json, '$.recommendation') = 'object'
  ),
  ranking_hash TEXT NOT NULL CHECK (
    length(ranking_hash) = 71 AND
    substr(ranking_hash, 1, 7) = 'sha256:' AND
    substr(ranking_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  FOREIGN KEY (proposal_id) REFERENCES completion_proposal(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES ai_job(id) ON DELETE RESTRICT,
  UNIQUE (proposal_id, job_id)
) STRICT;

CREATE TABLE completion_decision (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('accept', 'reject')),
  expected_source_result_hash TEXT NOT NULL CHECK (
    length(expected_source_result_hash) = 71 AND
    substr(expected_source_result_hash, 1, 7) = 'sha256:' AND
    substr(expected_source_result_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  expected_proposal_hash TEXT NOT NULL CHECK (
    length(expected_proposal_hash) = 71 AND
    substr(expected_proposal_hash, 1, 7) = 'sha256:' AND
    substr(expected_proposal_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  expected_evidence_hash TEXT NOT NULL CHECK (
    length(expected_evidence_hash) = 71 AND
    substr(expected_evidence_hash, 1, 7) = 'sha256:' AND
    substr(expected_evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  expected_candidate_hash TEXT CHECK (
    expected_candidate_hash IS NULL OR (
      length(expected_candidate_hash) = 71 AND
      substr(expected_candidate_hash, 1, 7) = 'sha256:' AND
      substr(expected_candidate_hash, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT,
  reason TEXT,
  decision_json TEXT NOT NULL CHECK (
    json_valid(decision_json) AND json_type(decision_json, '$') = 'object'
  ),
  decision_hash TEXT NOT NULL UNIQUE CHECK (
    length(decision_hash) = 71 AND
    substr(decision_hash, 1, 7) = 'sha256:' AND
    substr(decision_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK (
    (action = 'accept' AND candidate_id IS NOT NULL AND expected_candidate_hash IS NOT NULL) OR
    (action = 'reject' AND candidate_id IS NULL AND expected_candidate_hash IS NULL)
  ),
  FOREIGN KEY (proposal_id) REFERENCES completion_proposal(id) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_id) REFERENCES completion_candidate(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE completion_result (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  decision_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL UNIQUE,
  representation TEXT NOT NULL CHECK (
    representation IN ('skin_texel', 'latent_component')
  ),
  source_revision_id TEXT NOT NULL,
  source_result_hash TEXT NOT NULL CHECK (
    length(source_result_hash) = 71 AND
    substr(source_result_hash, 1, 7) = 'sha256:' AND
    substr(source_result_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  source_skin_hash TEXT NOT NULL CHECK (
    length(source_skin_hash) = 71 AND
    substr(source_skin_hash, 1, 7) = 'sha256:' AND
    substr(source_skin_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  revision_id TEXT UNIQUE,
  latent_part_id TEXT UNIQUE,
  result_hash TEXT NOT NULL CHECK (
    length(result_hash) = 71 AND
    substr(result_hash, 1, 7) = 'sha256:' AND
    substr(result_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  result_skin_hash TEXT NOT NULL CHECK (
    length(result_skin_hash) = 71 AND
    substr(result_skin_hash, 1, 7) = 'sha256:' AND
    substr(result_skin_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  origin_hash TEXT NOT NULL CHECK (
    length(origin_hash) = 71 AND
    substr(origin_hash, 1, 7) = 'sha256:' AND
    substr(origin_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK (
    (representation = 'skin_texel' AND revision_id IS NOT NULL AND latent_part_id IS NULL) OR
    (representation = 'latent_component' AND revision_id IS NULL AND latent_part_id IS NOT NULL)
  ),
  FOREIGN KEY (proposal_id) REFERENCES completion_proposal(id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_id) REFERENCES completion_decision(id) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_id) REFERENCES completion_candidate(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT,
  FOREIGN KEY (latent_part_id) REFERENCES part_asset(id) ON DELETE RESTRICT
) STRICT;

-- A latent accept is an immutable result, not an implicit library publication.
-- Publication is an independent append-only action and is deliberately absent
-- from the M19 public API.
CREATE TABLE completion_result_publication (
  result_id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL UNIQUE,
  actor_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  FOREIGN KEY (result_id) REFERENCES completion_result(id) ON DELETE RESTRICT,
  FOREIGN KEY (part_id) REFERENCES part_asset(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_completion_proposal_source
  ON completion_proposal(source_revision_id, created_at, id);
CREATE INDEX idx_completion_proposal_project
  ON completion_proposal(project_id, created_at, id);
CREATE INDEX idx_completion_candidate_proposal
  ON completion_candidate(proposal_id, created_at, id);
CREATE INDEX idx_completion_result_source
  ON completion_result(source_revision_id, created_at, id);

CREATE TRIGGER completion_proposal_insert_guard
BEFORE INSERT ON completion_proposal
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_job AS job
  JOIN skin_revision AS source ON source.id = NEW.source_revision_id
  JOIN skin_asset AS skin ON skin.id = source.skin_asset_id
  WHERE job.id = NEW.job_id
    AND job.job_kind = 'completion_proposal'
    AND job.status = 'validating'
    AND job.project_id = NEW.project_id
    AND job.input_revision_id = NEW.source_revision_id
    AND source.project_id = NEW.project_id
    AND source.result_hash = NEW.source_result_hash
    AND skin.sha256 = NEW.source_skin_hash
    AND json_extract(job.options_json, '$.targetComponentId') = NEW.target_component_id
    AND json_extract(job.options_json, '$.representation') =
      json_extract(NEW.proposal_json, '$.requestedRepresentation')
    AND json_extract(NEW.proposal_json, '$.schemaVersion') = '1.0'
    AND json_extract(NEW.proposal_json, '$.algorithmVersion') = 'completion-candidates-v1'
    AND json_extract(NEW.proposal_json, '$.proposalId') = NEW.id
    AND json_extract(NEW.proposal_json, '$.sourceRevisionId') = NEW.source_revision_id
    AND json_extract(NEW.proposal_json, '$.sourceResultHash') = NEW.source_result_hash
    AND json_extract(NEW.proposal_json, '$.sourceSkinHash') = NEW.source_skin_hash
    AND json_extract(NEW.proposal_json, '$.targetComponentId') = NEW.target_component_id
    AND json_extract(NEW.proposal_json, '$.representation') = NEW.representation
    AND json_extract(NEW.proposal_json, '$.evidenceHash') = NEW.evidence_hash
    AND json_extract(NEW.proposal_json, '$.proposalHash') = NEW.proposal_hash
    AND NOT EXISTS (
      SELECT value, count(*)
      FROM json_each(job.options_json, '$.occludingComponentIds')
      GROUP BY value
      EXCEPT
      SELECT value, count(*)
      FROM json_each(NEW.proposal_json, '$.occludingComponentIds')
      GROUP BY value
    )
    AND NOT EXISTS (
      SELECT value, count(*)
      FROM json_each(NEW.proposal_json, '$.occludingComponentIds')
      GROUP BY value
      EXCEPT
      SELECT value, count(*)
      FROM json_each(job.options_json, '$.occludingComponentIds')
      GROUP BY value
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion proposal source binding');
END;

CREATE TRIGGER completion_candidate_insert_guard
BEFORE INSERT ON completion_candidate
WHEN NOT EXISTS (
  SELECT 1
  FROM completion_proposal AS proposal
  JOIN ai_job AS job ON job.id = proposal.job_id
  WHERE proposal.id = NEW.proposal_id
    AND job.status = 'validating'
    AND NOT EXISTS (
      SELECT 1 FROM completion_proposal_ranking AS ranking
      WHERE ranking.proposal_id = proposal.id
    )
    AND proposal.representation = NEW.representation
    AND json_extract(NEW.candidate_json, '$.schemaVersion') = '1.0'
    AND json_extract(NEW.candidate_json, '$.algorithmVersion') = 'completion-candidates-v1'
    AND json_extract(NEW.candidate_json, '$.candidateId') = NEW.id
    AND json_extract(NEW.candidate_json, '$.representation') = NEW.representation
    AND json_extract(NEW.candidate_json, '$.strategy') = NEW.strategy
    AND json_extract(NEW.candidate_json, '$.confidence') = NEW.confidence
    AND json_extract(NEW.candidate_json, '$.pixelCount') = NEW.pixel_count
    AND json_extract(NEW.candidate_json, '$.candidateHash') = NEW.candidate_hash
    AND json_extract(NEW.candidate_json, '$.evidenceHash') = NEW.evidence_hash
    AND json_extract(NEW.candidate_json, '$.evidence.proposalEvidenceHash') =
      proposal.evidence_hash
    AND json_extract(NEW.candidate_json, '$.sourceRevisionId') IS NULL
    AND json_extract(NEW.candidate_json, '$.targetComponentId') =
      proposal.target_component_id
    AND EXISTS (
      SELECT 1
      FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
      WHERE embedded.type = 'object'
        AND json_extract(embedded.value, '$.candidateId') = NEW.id
        AND json_extract(embedded.value, '$.candidateHash') = NEW.candidate_hash
        AND json_extract(embedded.value, '$.evidenceHash') = NEW.evidence_hash
        AND json(embedded.value) = json(NEW.candidate_json)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion candidate binding');
END;

CREATE TRIGGER completion_proposal_ranking_insert_guard
BEFORE INSERT ON completion_proposal_ranking
WHEN NOT EXISTS (
  SELECT 1
  FROM completion_proposal AS proposal
  JOIN ai_job AS job ON job.id = proposal.job_id
  WHERE proposal.id = NEW.proposal_id
    AND proposal.job_id = NEW.job_id
    AND job.job_kind = 'completion_proposal'
    AND job.status = 'validating'
    AND json_extract(job.options_json, '$.rankingMode') = 'ai'
    AND job.provider = NEW.provider
    AND job.model = NEW.model
    AND json_extract(job.options_json, '$.reasoningEffort') = NEW.reasoning_effort
    AND json_extract(NEW.ranking_json, '$.schemaVersion') = '1.0'
    AND json_extract(NEW.ranking_json, '$.jobId') = NEW.job_id
    AND json_extract(NEW.ranking_json, '$.proposalId') = proposal.id
    AND json_extract(NEW.ranking_json, '$.proposalHash') = proposal.proposal_hash
    AND json_extract(NEW.ranking_json, '$.sourceRevisionId') =
      proposal.source_revision_id
    AND json_extract(NEW.ranking_json, '$.sourceResultHash') =
      proposal.source_result_hash
    AND json_extract(NEW.ranking_json, '$.sourceSkinHash') =
      proposal.source_skin_hash
    AND json_array_length(NEW.ranking_json, '$.rankings') = (
      SELECT count(*) FROM completion_candidate AS candidate
      WHERE candidate.proposal_id = proposal.id
    )
    AND json_array_length(NEW.ranking_json, '$.rankings') = (
      SELECT count(DISTINCT json_extract(ranked.value, '$.candidateId'))
      FROM json_each(NEW.ranking_json, '$.rankings') AS ranked
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.ranking_json, '$.rankings') AS ranked
      WHERE ranked.type <> 'object'
        OR NOT EXISTS (
          SELECT 1 FROM completion_candidate AS candidate
          WHERE candidate.proposal_id = proposal.id
            AND candidate.id = json_extract(ranked.value, '$.candidateId')
        )
    )
    AND (
      (
        json_extract(NEW.ranking_json, '$.recommendation.status') = 'defer'
        AND json_type(NEW.ranking_json, '$.recommendation.candidateId') = 'null'
      )
      OR (
        json_extract(NEW.ranking_json, '$.recommendation.status') = 'recommend'
        AND json_extract(NEW.ranking_json, '$.recommendation.candidateId') =
          json_extract(NEW.ranking_json, '$.rankings[0].candidateId')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion proposal ranking binding');
END;

CREATE TRIGGER completion_decision_insert_guard
BEFORE INSERT ON completion_decision
WHEN NOT EXISTS (
  SELECT 1
  FROM completion_proposal AS proposal
  JOIN ai_job AS job ON job.id = proposal.job_id
  JOIN skin_revision AS source ON source.id = proposal.source_revision_id
  JOIN skin_asset AS source_skin ON source_skin.id = source.skin_asset_id
  WHERE proposal.id = NEW.proposal_id
    AND job.status = 'succeeded'
    AND proposal.source_result_hash = NEW.expected_source_result_hash
    AND proposal.proposal_hash = NEW.expected_proposal_hash
    AND proposal.evidence_hash = NEW.expected_evidence_hash
    AND source.result_hash = NEW.expected_source_result_hash
    AND source_skin.sha256 = proposal.source_skin_hash
    AND json_extract(NEW.decision_json, '$.schemaVersion') = '1.0'
    AND json_extract(NEW.decision_json, '$.decisionId') = NEW.id
    AND json_extract(NEW.decision_json, '$.proposalId') = proposal.id
    AND json_extract(NEW.decision_json, '$.proposalHash') = proposal.proposal_hash
    AND json_extract(NEW.decision_json, '$.sourceRevisionId') = proposal.source_revision_id
    AND json_extract(NEW.decision_json, '$.sourceResultHash') = proposal.source_result_hash
    AND json_extract(NEW.decision_json, '$.sourceSkinHash') = proposal.source_skin_hash
    AND json_extract(NEW.decision_json, '$.action') = NEW.action
    AND json_extract(NEW.decision_json, '$.candidateId') IS NEW.candidate_id
    AND json_extract(NEW.decision_json, '$.candidateHash') IS NEW.expected_candidate_hash
    AND json_extract(NEW.decision_json, '$.actor.type') = 'user'
    AND json_extract(NEW.decision_json, '$.actor.id') IS NEW.actor_id
    AND json_extract(NEW.decision_json, '$.automatic') = 0
    AND json_extract(NEW.decision_json, '$.decisionHash') = NEW.decision_hash
    AND (
      (
        NEW.action = 'reject'
        AND json_type(NEW.decision_json, '$.candidateEvidenceHash') = 'null'
      )
      OR EXISTS (
        SELECT 1
        FROM completion_candidate AS candidate
        JOIN skin_branch AS branch ON branch.id = source.branch_id
        WHERE candidate.id = NEW.candidate_id
          AND candidate.proposal_id = proposal.id
          AND candidate.candidate_hash = NEW.expected_candidate_hash
          AND json_extract(NEW.decision_json, '$.candidateEvidenceHash') =
            candidate.evidence_hash
          AND branch.head_revision_id = source.id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'stale or invalid completion decision binding');
END;

CREATE TRIGGER completion_result_insert_guard
BEFORE INSERT ON completion_result
WHEN NOT EXISTS (
  SELECT 1
  FROM completion_proposal AS proposal
  JOIN completion_decision AS decision
    ON decision.id = NEW.decision_id
  JOIN completion_candidate AS candidate
    ON candidate.id = NEW.candidate_id
  JOIN skin_revision AS source
    ON source.id = proposal.source_revision_id
  JOIN skin_branch AS source_branch
    ON source_branch.id = source.branch_id
  WHERE proposal.id = NEW.proposal_id
    AND decision.proposal_id = proposal.id
    AND decision.action = 'accept'
    AND decision.candidate_id = candidate.id
    AND candidate.proposal_id = proposal.id
    AND candidate.representation = NEW.representation
    AND proposal.source_revision_id = NEW.source_revision_id
    AND proposal.source_result_hash = NEW.source_result_hash
    AND proposal.source_skin_hash = NEW.source_skin_hash
    AND (
      (
        NEW.representation = 'skin_texel'
        AND EXISTS (
          SELECT 1
          FROM skin_revision AS result
          JOIN skin_asset AS result_skin ON result_skin.id = result.skin_asset_id
          JOIN skin_asset AS result_origin ON result_origin.id = result.origin_asset_id
          WHERE result.id = NEW.revision_id
            AND result.parent_revision_id = proposal.source_revision_id
            AND result.project_id = proposal.project_id
            AND result.branch_id = source.branch_id
            AND result.sequence = source.sequence + 1
            AND result.operation_type = 'completion_accept'
            AND result.source_hash = proposal.source_result_hash
            AND result.actor_type = decision.actor_type
            AND result.actor_id IS decision.actor_id
            AND result.result_hash = NEW.result_hash
            AND result_skin.sha256 = NEW.result_skin_hash
            AND result_origin.sha256 = NEW.origin_hash
            AND json_extract(result.metadata_json, '$.completion.proposalId') = proposal.id
            AND json_extract(result.metadata_json, '$.completion.proposalHash') =
              proposal.proposal_hash
            AND json_extract(result.metadata_json, '$.completion.evidenceHash') =
              proposal.evidence_hash
            AND json_extract(result.metadata_json, '$.completion.candidateId') = candidate.id
            AND json_extract(result.metadata_json, '$.completion.candidateHash') =
              candidate.candidate_hash
            AND json_extract(result.metadata_json, '$.completion.decisionId') = decision.id
            AND json_extract(result.metadata_json, '$.completion.decisionHash') =
              decision.decision_hash
            AND json_extract(result.metadata_json, '$.completion.resultId') = NEW.id
            AND json_extract(result.metadata_json, '$.completion.representation') =
              NEW.representation
            AND source_branch.head_revision_id = result.id
        )
      )
      OR (
        NEW.representation = 'latent_component'
        AND NEW.result_skin_hash = NEW.source_skin_hash
        AND EXISTS (
          SELECT 1
          FROM part_asset AS part
          JOIN part_file_asset AS part_origin ON part_origin.id = part.origin_asset_id
          WHERE part.id = NEW.latent_part_id
            AND part.source_project_id = proposal.project_id
            AND part.source_revision_id = proposal.source_revision_id
            AND part.source_component_id = proposal.target_component_id
            AND json_extract(part.metadata_json, '$.completion.schemaVersion') = '1.0'
            AND json_extract(part.metadata_json, '$.completion.kind') = 'completion_result'
            AND json_extract(part.metadata_json, '$.completion.sourceRevisionId') =
              proposal.source_revision_id
            AND json_extract(part.metadata_json, '$.completion.sourceResultHash') =
              proposal.source_result_hash
            AND json_extract(part.metadata_json, '$.completion.sourceSkinHash') =
              proposal.source_skin_hash
            AND json_extract(part.metadata_json, '$.completion.proposalId') = proposal.id
            AND json_extract(part.metadata_json, '$.completion.proposalHash') =
              proposal.proposal_hash
            AND json_extract(part.metadata_json, '$.completion.evidenceHash') =
              proposal.evidence_hash
            AND json_extract(part.metadata_json, '$.completion.candidateId') = candidate.id
            AND json_extract(part.metadata_json, '$.completion.candidateHash') =
              candidate.candidate_hash
            AND json_extract(part.metadata_json, '$.completion.decisionId') = decision.id
            AND json_extract(part.metadata_json, '$.completion.decisionHash') =
              decision.decision_hash
            AND json_extract(part.metadata_json, '$.completion.resultId') = NEW.id
            AND json_extract(part.metadata_json, '$.completion.representation') =
              NEW.representation
            AND json_extract(part.metadata_json, '$.completion.actorId') IS
              decision.actor_id
            AND part_origin.sha256 = NEW.origin_hash
            AND source_branch.head_revision_id = proposal.source_revision_id
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion result binding');
END;

CREATE TRIGGER completion_result_publication_insert_guard
BEFORE INSERT ON completion_result_publication
WHEN NOT EXISTS (
  SELECT 1
  FROM completion_result AS result
  WHERE result.id = NEW.result_id
    AND result.representation = 'latent_component'
    AND result.latent_part_id = NEW.part_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion result publication');
END;

CREATE TRIGGER completion_proposal_immutable_update
BEFORE UPDATE ON completion_proposal
BEGIN
  SELECT RAISE(ABORT, 'completion_proposal is immutable');
END;
CREATE TRIGGER completion_proposal_immutable_delete
BEFORE DELETE ON completion_proposal
BEGIN
  SELECT RAISE(ABORT, 'completion_proposal is immutable');
END;
CREATE TRIGGER completion_candidate_immutable_update
BEFORE UPDATE ON completion_candidate
BEGIN
  SELECT RAISE(ABORT, 'completion_candidate is immutable');
END;
CREATE TRIGGER completion_candidate_immutable_delete
BEFORE DELETE ON completion_candidate
BEGIN
  SELECT RAISE(ABORT, 'completion_candidate is immutable');
END;
CREATE TRIGGER completion_proposal_ranking_immutable_update
BEFORE UPDATE ON completion_proposal_ranking
BEGIN
  SELECT RAISE(ABORT, 'completion_proposal_ranking is immutable');
END;
CREATE TRIGGER completion_proposal_ranking_immutable_delete
BEFORE DELETE ON completion_proposal_ranking
BEGIN
  SELECT RAISE(ABORT, 'completion_proposal_ranking is immutable');
END;
CREATE TRIGGER completion_decision_immutable_update
BEFORE UPDATE ON completion_decision
BEGIN
  SELECT RAISE(ABORT, 'completion_decision is immutable');
END;
CREATE TRIGGER completion_decision_immutable_delete
BEFORE DELETE ON completion_decision
BEGIN
  SELECT RAISE(ABORT, 'completion_decision is immutable');
END;
CREATE TRIGGER completion_result_immutable_update
BEFORE UPDATE ON completion_result
BEGIN
  SELECT RAISE(ABORT, 'completion_result is immutable');
END;
CREATE TRIGGER completion_result_immutable_delete
BEFORE DELETE ON completion_result
BEGIN
  SELECT RAISE(ABORT, 'completion_result is immutable');
END;
CREATE TRIGGER completion_result_publication_immutable_update
BEFORE UPDATE ON completion_result_publication
BEGIN
  SELECT RAISE(ABORT, 'completion_result_publication is immutable');
END;
CREATE TRIGGER completion_result_publication_immutable_delete
BEFORE DELETE ON completion_result_publication
BEGIN
  SELECT RAISE(ABORT, 'completion_result_publication is immutable');
END;

CREATE TRIGGER ai_job_kind_shape_insert
BEFORE INSERT ON ai_job
WHEN (
  (
    (
      NEW.job_kind = 'semantic_analysis'
      AND NEW.composition_id IS NULL
      AND NEW.advisory_result_json IS NULL
      AND json_type(NEW.options_json, '$') = 'object'
      AND json_extract(NEW.options_json, '$.mode') = 'full'
    )
    OR (
      NEW.job_kind = 'restoration_recommendation'
      AND NEW.composition_id IS NOT NULL
      AND NEW.result_revision_id IS NULL
      AND json_type(NEW.options_json, '$') = 'object'
      AND json_extract(NEW.options_json, '$.mode') = 'restoration_recommendation'
      AND json_extract(NEW.options_json, '$.compositionId') = NEW.composition_id
      AND json_type(NEW.review_items_json, '$') = 'array'
      AND json_array_length(NEW.review_items_json) = 0
      AND (
        (NEW.status = 'succeeded' AND NEW.advisory_result_json IS NOT NULL)
        OR (NEW.status <> 'succeeded' AND NEW.advisory_result_json IS NULL)
      )
      AND EXISTS (
        SELECT 1 FROM composition_project
        WHERE id = NEW.composition_id
          AND project_id = NEW.project_id
          AND base_revision_id = NEW.input_revision_id
      )
    )
    OR (
      NEW.job_kind = 'completion_proposal'
      AND NEW.composition_id IS NULL
      AND NEW.result_revision_id IS NULL
      AND NEW.advisory_result_json IS NULL
      AND json_type(NEW.options_json, '$') = 'object'
      AND json_extract(NEW.options_json, '$.mode') = 'completion_proposal'
      AND json_extract(NEW.options_json, '$.provider') = NEW.provider
      AND json_extract(NEW.options_json, '$.model') = NEW.model
      AND json_extract(NEW.options_json, '$.rankingMode') IN ('host_only', 'ai')
      AND (
        (
          json_extract(NEW.options_json, '$.rankingMode') = 'host_only'
          AND json_type(NEW.options_json, '$.reasoningEffort') IS NULL
        )
        OR (
          json_extract(NEW.options_json, '$.rankingMode') = 'ai'
          AND json_extract(NEW.options_json, '$.reasoningEffort') IN (
            'low', 'medium', 'high', 'xhigh', 'max'
          )
        )
      )
      AND json_type(NEW.options_json, '$.targetComponentId') = 'text'
      AND length(json_extract(NEW.options_json, '$.targetComponentId')) BETWEEN 1 AND 120
      AND json_type(NEW.options_json, '$.occludingComponentIds') = 'array'
      AND json_array_length(NEW.options_json, '$.occludingComponentIds') > 0
      AND json_extract(NEW.options_json, '$.representation') IN (
        'auto', 'skin_texel', 'latent_component'
      )
      AND json_type(NEW.review_items_json, '$') = 'array'
      AND json_array_length(NEW.review_items_json) = 0
      AND (
        NEW.status <> 'succeeded'
        OR (
          NEW.output_hash IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM completion_proposal AS proposal
            WHERE proposal.job_id = NEW.id
              AND proposal.source_revision_id = NEW.input_revision_id
              AND proposal.proposal_hash = NEW.output_hash
              AND json_type(proposal.proposal_json, '$.candidates') = 'array'
              AND json_array_length(proposal.proposal_json, '$.candidates') = (
                SELECT count(*) FROM completion_candidate AS candidate
                WHERE candidate.proposal_id = proposal.id
              )
              AND json_array_length(proposal.proposal_json, '$.candidates') = (
                SELECT count(DISTINCT json_extract(embedded.value, '$.candidateId'))
                FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
              )
              AND NOT EXISTS (
                SELECT
                  json_extract(embedded.value, '$.candidateId'),
                  json_extract(embedded.value, '$.candidateHash')
                FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
                EXCEPT
                SELECT candidate.id, candidate.candidate_hash
                FROM completion_candidate AS candidate
                WHERE candidate.proposal_id = proposal.id
              )
              AND NOT EXISTS (
                SELECT candidate.id, candidate.candidate_hash
                FROM completion_candidate AS candidate
                WHERE candidate.proposal_id = proposal.id
                EXCEPT
                SELECT
                  json_extract(embedded.value, '$.candidateId'),
                  json_extract(embedded.value, '$.candidateHash')
                FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
              )
              AND (
                (
                  json_extract(NEW.options_json, '$.rankingMode') = 'host_only'
                  AND NOT EXISTS (
                    SELECT 1 FROM completion_proposal_ranking AS ranking
                    WHERE ranking.proposal_id = proposal.id
                  )
                )
                OR (
                  json_extract(NEW.options_json, '$.rankingMode') = 'ai'
                  AND EXISTS (
                    SELECT 1
                    FROM completion_proposal_ranking AS ranking
                    WHERE ranking.proposal_id = proposal.id
                      AND ranking.job_id = NEW.id
                      AND json_array_length(ranking.ranking_json, '$.rankings') = (
                        SELECT count(*) FROM completion_candidate AS candidate
                        WHERE candidate.proposal_id = proposal.id
                      )
                      AND json_array_length(ranking.ranking_json, '$.rankings') = (
                        SELECT count(DISTINCT json_extract(ranked.value, '$.candidateId'))
                        FROM json_each(ranking.ranking_json, '$.rankings') AS ranked
                      )
                      AND NOT EXISTS (
                        SELECT json_extract(ranked.value, '$.candidateId')
                        FROM json_each(ranking.ranking_json, '$.rankings') AS ranked
                        EXCEPT
                        SELECT candidate.id FROM completion_candidate AS candidate
                        WHERE candidate.proposal_id = proposal.id
                      )
                      AND NOT EXISTS (
                        SELECT candidate.id FROM completion_candidate AS candidate
                        WHERE candidate.proposal_id = proposal.id
                        EXCEPT
                        SELECT json_extract(ranked.value, '$.candidateId')
                        FROM json_each(ranking.ranking_json, '$.rankings') AS ranked
                      )
                  )
                )
              )
          )
        )
      )
    )
  )
  AND (
    NEW.retry_of_job_id IS NULL
    OR EXISTS (
      SELECT 1 FROM ai_job AS retried_job
      WHERE retried_job.id = NEW.retry_of_job_id
        AND retried_job.job_kind = NEW.job_kind
        AND retried_job.project_id = NEW.project_id
        AND retried_job.input_revision_id = NEW.input_revision_id
        AND retried_job.composition_id IS NEW.composition_id
        AND (
          (
            NEW.job_kind = 'completion_proposal'
            AND retried_job.status IN ('failed', 'cancelled')
          )
          OR (
            NEW.job_kind <> 'completion_proposal'
            AND retried_job.status IN ('succeeded', 'failed', 'cancelled')
          )
        )
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
      NEW.job_kind = 'semantic_analysis'
      AND NEW.composition_id IS NULL
      AND NEW.advisory_result_json IS NULL
      AND json_type(NEW.options_json, '$') = 'object'
      AND json_extract(NEW.options_json, '$.mode') = 'full'
    )
    OR (
      NEW.job_kind = 'restoration_recommendation'
      AND NEW.composition_id IS NOT NULL
      AND NEW.result_revision_id IS NULL
      AND json_type(NEW.options_json, '$') = 'object'
      AND json_extract(NEW.options_json, '$.mode') = 'restoration_recommendation'
      AND json_extract(NEW.options_json, '$.compositionId') = NEW.composition_id
      AND json_type(NEW.review_items_json, '$') = 'array'
      AND json_array_length(NEW.review_items_json) = 0
      AND (
        (NEW.status = 'succeeded' AND NEW.advisory_result_json IS NOT NULL)
        OR (NEW.status <> 'succeeded' AND NEW.advisory_result_json IS NULL)
      )
      AND EXISTS (
        SELECT 1 FROM composition_project
        WHERE id = NEW.composition_id
          AND project_id = NEW.project_id
          AND base_revision_id = NEW.input_revision_id
      )
    )
    OR (
      NEW.job_kind = 'completion_proposal'
      AND NEW.composition_id IS NULL
      AND NEW.result_revision_id IS NULL
      AND NEW.advisory_result_json IS NULL
      AND json_type(NEW.options_json, '$') = 'object'
      AND json_extract(NEW.options_json, '$.mode') = 'completion_proposal'
      AND json_extract(NEW.options_json, '$.provider') = NEW.provider
      AND json_extract(NEW.options_json, '$.model') = NEW.model
      AND json_extract(NEW.options_json, '$.rankingMode') IN ('host_only', 'ai')
      AND (
        (
          json_extract(NEW.options_json, '$.rankingMode') = 'host_only'
          AND json_type(NEW.options_json, '$.reasoningEffort') IS NULL
        )
        OR (
          json_extract(NEW.options_json, '$.rankingMode') = 'ai'
          AND json_extract(NEW.options_json, '$.reasoningEffort') IN (
            'low', 'medium', 'high', 'xhigh', 'max'
          )
        )
      )
      AND json_type(NEW.options_json, '$.targetComponentId') = 'text'
      AND length(json_extract(NEW.options_json, '$.targetComponentId')) BETWEEN 1 AND 120
      AND json_type(NEW.options_json, '$.occludingComponentIds') = 'array'
      AND json_array_length(NEW.options_json, '$.occludingComponentIds') > 0
      AND json_extract(NEW.options_json, '$.representation') IN (
        'auto', 'skin_texel', 'latent_component'
      )
      AND json_type(NEW.review_items_json, '$') = 'array'
      AND json_array_length(NEW.review_items_json) = 0
      AND (
        NEW.status <> 'succeeded'
        OR (
          NEW.output_hash IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM completion_proposal AS proposal
            WHERE proposal.job_id = NEW.id
              AND proposal.source_revision_id = NEW.input_revision_id
              AND proposal.proposal_hash = NEW.output_hash
              AND json_type(proposal.proposal_json, '$.candidates') = 'array'
              AND json_array_length(proposal.proposal_json, '$.candidates') = (
                SELECT count(*) FROM completion_candidate AS candidate
                WHERE candidate.proposal_id = proposal.id
              )
              AND json_array_length(proposal.proposal_json, '$.candidates') = (
                SELECT count(DISTINCT json_extract(embedded.value, '$.candidateId'))
                FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
              )
              AND NOT EXISTS (
                SELECT
                  json_extract(embedded.value, '$.candidateId'),
                  json_extract(embedded.value, '$.candidateHash')
                FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
                EXCEPT
                SELECT candidate.id, candidate.candidate_hash
                FROM completion_candidate AS candidate
                WHERE candidate.proposal_id = proposal.id
              )
              AND NOT EXISTS (
                SELECT candidate.id, candidate.candidate_hash
                FROM completion_candidate AS candidate
                WHERE candidate.proposal_id = proposal.id
                EXCEPT
                SELECT
                  json_extract(embedded.value, '$.candidateId'),
                  json_extract(embedded.value, '$.candidateHash')
                FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
              )
              AND (
                (
                  json_extract(NEW.options_json, '$.rankingMode') = 'host_only'
                  AND NOT EXISTS (
                    SELECT 1 FROM completion_proposal_ranking AS ranking
                    WHERE ranking.proposal_id = proposal.id
                  )
                )
                OR (
                  json_extract(NEW.options_json, '$.rankingMode') = 'ai'
                  AND EXISTS (
                    SELECT 1
                    FROM completion_proposal_ranking AS ranking
                    WHERE ranking.proposal_id = proposal.id
                      AND ranking.job_id = NEW.id
                      AND json_array_length(ranking.ranking_json, '$.rankings') = (
                        SELECT count(*) FROM completion_candidate AS candidate
                        WHERE candidate.proposal_id = proposal.id
                      )
                      AND json_array_length(ranking.ranking_json, '$.rankings') = (
                        SELECT count(DISTINCT json_extract(ranked.value, '$.candidateId'))
                        FROM json_each(ranking.ranking_json, '$.rankings') AS ranked
                      )
                      AND NOT EXISTS (
                        SELECT json_extract(ranked.value, '$.candidateId')
                        FROM json_each(ranking.ranking_json, '$.rankings') AS ranked
                        EXCEPT
                        SELECT candidate.id FROM completion_candidate AS candidate
                        WHERE candidate.proposal_id = proposal.id
                      )
                      AND NOT EXISTS (
                        SELECT candidate.id FROM completion_candidate AS candidate
                        WHERE candidate.proposal_id = proposal.id
                        EXCEPT
                        SELECT json_extract(ranked.value, '$.candidateId')
                        FROM json_each(ranking.ranking_json, '$.rankings') AS ranked
                      )
                  )
                )
              )
          )
        )
      )
    )
  )
  AND (
    NEW.retry_of_job_id IS NULL
    OR EXISTS (
      SELECT 1 FROM ai_job AS retried_job
      WHERE retried_job.id = NEW.retry_of_job_id
        AND retried_job.job_kind = NEW.job_kind
        AND retried_job.project_id = NEW.project_id
        AND retried_job.input_revision_id = NEW.input_revision_id
        AND retried_job.composition_id IS NEW.composition_id
        AND (
          (
            NEW.job_kind = 'completion_proposal'
            AND retried_job.status IN ('failed', 'cancelled')
          )
          OR (
            NEW.job_kind <> 'completion_proposal'
            AND retried_job.status IN ('succeeded', 'failed', 'cancelled')
          )
        )
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
