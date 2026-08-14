CREATE TABLE analyzed_skin_catalog_archive (
  result_revision_id TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL,
  archived_reason TEXT CHECK (
    archived_reason IS NULL OR
    (
      length(archived_reason) BETWEEN 1 AND 300 AND
      archived_reason = trim(archived_reason)
    )
  ),
  FOREIGN KEY (result_revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_analyzed_skin_catalog_archive_time
  ON analyzed_skin_catalog_archive(archived_at, result_revision_id);

CREATE TRIGGER analyzed_skin_catalog_archive_insert_guard
BEFORE INSERT ON analyzed_skin_catalog_archive
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_job
  WHERE job_kind = 'semantic_analysis'
    AND status = 'succeeded'
    AND result_revision_id = NEW.result_revision_id
    AND finished_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid analyzed skin catalog archive target');
END;

CREATE TRIGGER analyzed_skin_catalog_archive_identity_immutable
BEFORE UPDATE OF result_revision_id ON analyzed_skin_catalog_archive
WHEN OLD.result_revision_id IS NOT NEW.result_revision_id
BEGIN
  SELECT RAISE(ABORT, 'analyzed skin catalog archive identity is immutable');
END;
