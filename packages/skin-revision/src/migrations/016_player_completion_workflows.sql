-- M20 keeps the immutable M19 proposal/ranking document intact. Manual edits
-- are append-only derived candidates with their exact replay input beside them.

CREATE TEMP TABLE completion_candidate_edit_migration_guard (
  value INTEGER NOT NULL CHECK (value = 0)
) STRICT;

INSERT INTO completion_candidate_edit_migration_guard (value)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM completion_proposal AS proposal
  WHERE json_array_length(proposal.proposal_json, '$.candidates') <>
    (SELECT count(*) FROM completion_candidate AS candidate
     WHERE candidate.proposal_id = proposal.id)
    OR EXISTS (
      SELECT json_extract(embedded.value, '$.candidateId')
      FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
      EXCEPT
      SELECT candidate.id FROM completion_candidate AS candidate
      WHERE candidate.proposal_id = proposal.id
    )
    OR EXISTS (
      SELECT candidate.id FROM completion_candidate AS candidate
      WHERE candidate.proposal_id = proposal.id
      EXCEPT
      SELECT json_extract(embedded.value, '$.candidateId')
      FROM json_each(proposal.proposal_json, '$.candidates') AS embedded
    )
)
OR EXISTS (
  SELECT 1 FROM completion_candidate WHERE strategy = 'manual_edit'
);

DROP TABLE completion_candidate_edit_migration_guard;

CREATE TABLE completion_candidate_edit (
  candidate_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  base_candidate_id TEXT NOT NULL,
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
  expected_candidate_hash TEXT NOT NULL CHECK (
    length(expected_candidate_hash) = 71 AND
    substr(expected_candidate_hash, 1, 7) = 'sha256:' AND
    substr(expected_candidate_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  actor_type TEXT NOT NULL CHECK (actor_type = 'user'),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 120),
  operation_id TEXT NOT NULL UNIQUE CHECK (
    length(operation_id) BETWEEN 3 AND 100 AND
    operation_id GLOB '[a-z]*' AND
    operation_id NOT GLOB '*[^a-z0-9_-]*'
  ),
  edits_json TEXT NOT NULL CHECK (
    json_valid(edits_json) AND
    json_type(edits_json, '$') = 'array' AND
    json_array_length(edits_json) BETWEEN 1 AND 256
  ),
  edit_hash TEXT NOT NULL UNIQUE CHECK (
    length(edit_hash) = 71 AND
    substr(edit_hash, 1, 7) = 'sha256:' AND
    substr(edit_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK (candidate_id <> base_candidate_id),
  UNIQUE (proposal_id, edit_hash),
  FOREIGN KEY (candidate_id) REFERENCES completion_candidate(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (proposal_id) REFERENCES completion_proposal(id) ON DELETE RESTRICT,
  FOREIGN KEY (base_candidate_id) REFERENCES completion_candidate(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_completion_candidate_edit_proposal
  ON completion_candidate_edit(proposal_id, created_at, candidate_id);

CREATE TRIGGER completion_candidate_edit_insert_guard
BEFORE INSERT ON completion_candidate_edit
WHEN NOT EXISTS (
  SELECT 1
  FROM completion_proposal AS proposal
  JOIN ai_job AS job ON job.id = proposal.job_id
  JOIN skin_revision AS source ON source.id = proposal.source_revision_id
  JOIN skin_asset AS source_skin ON source_skin.id = source.skin_asset_id
  JOIN skin_branch AS branch ON branch.id = source.branch_id
  JOIN completion_candidate AS base
    ON base.id = NEW.base_candidate_id AND base.proposal_id = proposal.id
  WHERE proposal.id = NEW.proposal_id
    AND job.status = 'succeeded'
    AND NOT EXISTS (
      SELECT 1 FROM completion_decision AS decision
      WHERE decision.proposal_id = proposal.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM completion_candidate_edit AS derived_base
      WHERE derived_base.candidate_id = base.id
    )
    AND source.result_hash = proposal.source_result_hash
    AND source_skin.sha256 = proposal.source_skin_hash
    AND branch.head_revision_id = source.id
    AND NEW.expected_source_result_hash = proposal.source_result_hash
    AND NEW.expected_proposal_hash = proposal.proposal_hash
    AND NEW.expected_evidence_hash = proposal.evidence_hash
    AND NEW.expected_candidate_hash = base.candidate_hash
    AND NEW.candidate_id <> base.id
    AND NOT EXISTS (
      SELECT 1 FROM completion_candidate AS existing_candidate
      WHERE existing_candidate.id = NEW.candidate_id
    )
    AND NEW.actor_type = 'user'
    AND json_array_length(NEW.edits_json) = (
      SELECT count(DISTINCT json_extract(edit.value, '$.pixelId'))
      FROM json_each(NEW.edits_json) AS edit
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.edits_json) AS edit
      WHERE edit.type <> 'object'
        OR COALESCE(json_type(edit.value, '$.type') <> 'text', 1)
        OR COALESCE(
          json_extract(edit.value, '$.type') NOT IN ('set_pixel', 'remove_pixel'),
          1
        )
        OR COALESCE(json_type(edit.value, '$.pixelId') <> 'integer', 1)
        OR COALESCE(
          json_extract(edit.value, '$.pixelId') NOT BETWEEN 0 AND 4095,
          1
        )
        OR NOT EXISTS (
          SELECT 1
          FROM json_each(proposal.proposal_json, '$.allowedGeneratedPixelIds') AS allowed
          WHERE allowed.value = json_extract(edit.value, '$.pixelId')
        )
        OR (
          json_extract(edit.value, '$.type') = 'set_pixel'
          AND (
            (SELECT count(*) FROM json_each(edit.value)) <> 3
            OR COALESCE(json_type(edit.value, '$.rgba') <> 'array', 1)
            OR COALESCE(json_array_length(edit.value, '$.rgba') <> 4, 1)
            OR EXISTS (
              SELECT 1 FROM json_each(edit.value, '$.rgba') AS channel
              WHERE channel.type <> 'integer' OR channel.value NOT BETWEEN 0 AND 255
            )
            OR COALESCE(json_extract(edit.value, '$.rgba[3]') = 0, 1)
          )
        )
        OR (
          json_extract(edit.value, '$.type') = 'remove_pixel'
          AND (
            (SELECT count(*) FROM json_each(edit.value)) <> 2
            OR json_type(edit.value, '$.rgba') IS NOT NULL
          )
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion candidate edit binding');
END;

DROP TRIGGER completion_candidate_insert_guard;

CREATE TRIGGER completion_candidate_insert_guard
BEFORE INSERT ON completion_candidate
WHEN NOT (
  EXISTS (
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
      AND NEW.strategy <> 'manual_edit'
      AND json_type(NEW.candidate_json, '$.baseCandidateId') = 'null'
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
  OR EXISTS (
    SELECT 1
    FROM completion_candidate_edit AS edit
    JOIN completion_proposal AS proposal ON proposal.id = edit.proposal_id
    JOIN ai_job AS job ON job.id = proposal.job_id
    JOIN skin_revision AS source ON source.id = proposal.source_revision_id
    JOIN skin_asset AS source_skin ON source_skin.id = source.skin_asset_id
    JOIN skin_branch AS branch ON branch.id = source.branch_id
    JOIN completion_candidate AS base
      ON base.id = edit.base_candidate_id AND base.proposal_id = proposal.id
    WHERE edit.candidate_id = NEW.id
      AND edit.proposal_id = NEW.proposal_id
      AND job.status = 'succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM completion_decision AS decision
        WHERE decision.proposal_id = proposal.id
      )
      AND source.result_hash = proposal.source_result_hash
      AND source_skin.sha256 = proposal.source_skin_hash
      AND branch.head_revision_id = source.id
      AND edit.expected_source_result_hash = proposal.source_result_hash
      AND edit.expected_proposal_hash = proposal.proposal_hash
      AND edit.expected_evidence_hash = proposal.evidence_hash
      AND edit.expected_candidate_hash = base.candidate_hash
      AND NEW.representation = proposal.representation
      AND NEW.strategy = 'manual_edit'
      AND NEW.confidence = 'manual'
      AND json_extract(NEW.candidate_json, '$.schemaVersion') = '1.0'
      AND json_extract(NEW.candidate_json, '$.algorithmVersion') = 'completion-candidates-v1'
      AND json_extract(NEW.candidate_json, '$.candidateId') = NEW.id
      AND json_extract(NEW.candidate_json, '$.representation') = NEW.representation
      AND json_extract(NEW.candidate_json, '$.strategy') = 'manual_edit'
      AND json_extract(NEW.candidate_json, '$.confidence') = 'manual'
      AND json_extract(NEW.candidate_json, '$.baseCandidateId') = base.id
      AND json_extract(NEW.candidate_json, '$.pixelCount') = NEW.pixel_count
      AND json_extract(NEW.candidate_json, '$.candidateHash') = NEW.candidate_hash
      AND json_extract(NEW.candidate_json, '$.evidenceHash') = NEW.evidence_hash
      AND json_extract(NEW.candidate_json, '$.evidence.proposalEvidenceHash') =
        proposal.evidence_hash
      AND json_extract(NEW.candidate_json, '$.evidence.sourceRevisionId') =
        proposal.source_revision_id
      AND json_extract(NEW.candidate_json, '$.evidence.sourceResultHash') =
        proposal.source_result_hash
      AND json_extract(NEW.candidate_json, '$.evidence.sourceSkinHash') =
        proposal.source_skin_hash
      AND json_extract(NEW.candidate_json, '$.evidence.baseCandidateId') = base.id
      AND json_extract(NEW.candidate_json, '$.targetComponentId') =
        proposal.target_component_id
      AND json_type(NEW.candidate_json, '$.assignments') = 'array'
      AND json_array_length(NEW.candidate_json, '$.assignments') BETWEEN 1 AND 1024
      AND json_array_length(NEW.candidate_json, '$.assignments') = NEW.pixel_count
      AND json_array_length(NEW.candidate_json, '$.assignments') = (
        SELECT count(DISTINCT json_extract(assignment.value, '$.targetPixelId'))
        FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
        WHERE assignment.type <> 'object'
          OR COALESCE(
            json_type(assignment.value, '$.targetPixelId') <> 'integer',
            1
          )
          OR COALESCE(
            json_extract(assignment.value, '$.targetPixelId') NOT BETWEEN 0 AND 4095,
            1
          )
          OR (SELECT count(*) FROM json_each(assignment.value)) <> 8
      )
      AND EXISTS (
        SELECT 1
        FROM json_each(edit.edits_json) AS requested
        WHERE (
          json_extract(requested.value, '$.type') = 'remove_pixel'
          AND EXISTS (
            SELECT 1
            FROM json_each(base.candidate_json, '$.assignments') AS base_assignment
            WHERE json_extract(base_assignment.value, '$.targetPixelId') =
              json_extract(requested.value, '$.pixelId')
          )
        ) OR (
          json_extract(requested.value, '$.type') = 'set_pixel'
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(base.candidate_json, '$.assignments') AS base_assignment
            WHERE json_extract(base_assignment.value, '$.targetPixelId') =
                json_extract(requested.value, '$.pixelId')
              AND json_extract(base_assignment.value, '$.rgba') =
                json_extract(requested.value, '$.rgba')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(edit.edits_json) AS requested
        WHERE (
          json_extract(requested.value, '$.type') = 'remove_pixel'
          AND EXISTS (
            SELECT 1 FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
            WHERE json_extract(assignment.value, '$.targetPixelId') =
              json_extract(requested.value, '$.pixelId')
          )
        ) OR (
          json_extract(requested.value, '$.type') = 'set_pixel'
          AND (
            (
              EXISTS (
                SELECT 1
                FROM json_each(base.candidate_json, '$.assignments') AS base_assignment
                WHERE json_extract(base_assignment.value, '$.targetPixelId') =
                    json_extract(requested.value, '$.pixelId')
                  AND json_extract(base_assignment.value, '$.rgba') =
                    json_extract(requested.value, '$.rgba')
              )
              AND NOT EXISTS (
                SELECT 1
                FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
                JOIN json_each(base.candidate_json, '$.assignments') AS base_assignment
                  ON json_extract(base_assignment.value, '$.targetPixelId') =
                    json_extract(assignment.value, '$.targetPixelId')
                WHERE json_extract(assignment.value, '$.targetPixelId') =
                    json_extract(requested.value, '$.pixelId')
                  AND json(assignment.value) = json(base_assignment.value)
              )
            ) OR (
              NOT EXISTS (
                SELECT 1
                FROM json_each(base.candidate_json, '$.assignments') AS base_assignment
                WHERE json_extract(base_assignment.value, '$.targetPixelId') =
                    json_extract(requested.value, '$.pixelId')
                  AND json_extract(base_assignment.value, '$.rgba') =
                    json_extract(requested.value, '$.rgba')
              )
              AND NOT EXISTS (
                SELECT 1 FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
                WHERE json_extract(assignment.value, '$.targetPixelId') =
                    json_extract(requested.value, '$.pixelId')
                  AND json_extract(assignment.value, '$.originMode') = 'manual_authored'
                  AND json_type(assignment.value, '$.manualActor') = 'object'
                  AND json_extract(assignment.value, '$.manualActor.type') = 'user'
                  AND json_extract(assignment.value, '$.manualActor.id') IS edit.actor_id
                  AND (
                    (edit.actor_id IS NULL AND (
                      SELECT count(*)
                      FROM json_each(assignment.value, '$.manualActor')
                    ) = 1) OR
                    (edit.actor_id IS NOT NULL AND (
                      SELECT count(*)
                      FROM json_each(assignment.value, '$.manualActor')
                    ) = 2)
                  )
                  AND json_extract(assignment.value, '$.manualOperationId') = edit.operation_id
                  AND json_extract(assignment.value, '$.rgba') =
                    json_extract(requested.value, '$.rgba')
                  AND json_type(assignment.value, '$.samplePixelIds') = 'array'
                  AND json_array_length(assignment.value, '$.samplePixelIds') = 0
                  AND json_type(assignment.value, '$.sourcePixelId') = 'null'
                  AND json_type(
                    assignment.value,
                    '$.sourceComponentInstanceId'
                  ) = 'null'
              )
            )
          )
        )
      )
      AND NOT EXISTS (
        SELECT json_extract(assignment.value, '$.targetPixelId')
        FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
        EXCEPT
        SELECT expected.pixel_id
        FROM (
          SELECT json_extract(base_assignment.value, '$.targetPixelId') AS pixel_id
          FROM json_each(base.candidate_json, '$.assignments') AS base_assignment
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(edit.edits_json) AS requested
            WHERE json_extract(requested.value, '$.pixelId') =
              json_extract(base_assignment.value, '$.targetPixelId')
          )
          UNION
          SELECT json_extract(requested.value, '$.pixelId')
          FROM json_each(edit.edits_json) AS requested
          WHERE json_extract(requested.value, '$.type') = 'set_pixel'
        ) AS expected
      )
      AND NOT EXISTS (
        SELECT expected.pixel_id
        FROM (
          SELECT json_extract(base_assignment.value, '$.targetPixelId') AS pixel_id
          FROM json_each(base.candidate_json, '$.assignments') AS base_assignment
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(edit.edits_json) AS requested
            WHERE json_extract(requested.value, '$.pixelId') =
              json_extract(base_assignment.value, '$.targetPixelId')
          )
          UNION
          SELECT json_extract(requested.value, '$.pixelId')
          FROM json_each(edit.edits_json) AS requested
          WHERE json_extract(requested.value, '$.type') = 'set_pixel'
        ) AS expected
        EXCEPT
        SELECT json_extract(assignment.value, '$.targetPixelId')
        FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.candidate_json, '$.assignments') AS assignment
        JOIN json_each(base.candidate_json, '$.assignments') AS base_assignment
          ON json_extract(base_assignment.value, '$.targetPixelId') =
            json_extract(assignment.value, '$.targetPixelId')
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(edit.edits_json) AS requested
          WHERE json_extract(requested.value, '$.pixelId') =
            json_extract(assignment.value, '$.targetPixelId')
        )
          AND json(assignment.value) <> json(base_assignment.value)
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid completion candidate binding');
END;

CREATE TRIGGER completion_candidate_edit_immutable_update
BEFORE UPDATE ON completion_candidate_edit
BEGIN
  SELECT RAISE(ABORT, 'completion_candidate_edit is immutable');
END;

CREATE TRIGGER completion_candidate_edit_immutable_delete
BEFORE DELETE ON completion_candidate_edit
BEGIN
  SELECT RAISE(ABORT, 'completion_candidate_edit is immutable');
END;
