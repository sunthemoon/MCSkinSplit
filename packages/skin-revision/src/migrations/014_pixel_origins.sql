-- M18 adds immutable, checksummed pixel-origin artifacts without rewriting
-- legacy Revision snapshots or Part 1.0/1.1 assets. Existing rows retain NULL
-- references and remain readable; every row inserted after this migration must
-- bind the new artifacts.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER skin_asset_revision_binding_guard;
DROP TRIGGER skin_asset_revision_bound_immutable_update;
DROP TRIGGER skin_asset_revision_bound_immutable_delete;

CREATE TABLE skin_asset_v14 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT,
  asset_type TEXT NOT NULL CHECK (
    asset_type IN (
      'source_skin',
      'revision_skin',
      'segmentation_json',
      'origin_json',
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
  sha256 TEXT NOT NULL CHECK (
    sha256 GLOB 'sha256:[0-9a-f]*' AND length(sha256) = 71
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES skin_project(id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id) REFERENCES skin_revision(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO skin_asset_v14 (
  id, project_id, revision_id, asset_type, storage_path, mime_type,
  byte_size, sha256, created_at
)
SELECT
  id, project_id, revision_id, asset_type, storage_path, mime_type,
  byte_size, sha256, created_at
FROM skin_asset;

DROP TABLE skin_asset;
ALTER TABLE skin_asset_v14 RENAME TO skin_asset;

CREATE INDEX idx_skin_asset_revision
  ON skin_asset(revision_id, asset_type);

ALTER TABLE skin_revision
  ADD COLUMN origin_asset_id TEXT
  REFERENCES skin_asset(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_skin_revision_origin_asset
  ON skin_revision(origin_asset_id)
  WHERE origin_asset_id IS NOT NULL;

CREATE TRIGGER skin_revision_origin_required_insert
BEFORE INSERT ON skin_revision
WHEN NEW.origin_asset_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'new skin_revision requires origin asset');
END;

CREATE TRIGGER skin_asset_revision_binding_guard
BEFORE UPDATE OF revision_id ON skin_asset
WHEN OLD.revision_id IS NULL AND NOT (
  NEW.revision_id IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.project_id IS OLD.project_id
  AND NEW.asset_type IS OLD.asset_type
  AND NEW.storage_path IS OLD.storage_path
  AND NEW.mime_type IS OLD.mime_type
  AND NEW.byte_size IS OLD.byte_size
  AND NEW.sha256 IS OLD.sha256
  AND NEW.created_at IS OLD.created_at
  AND NOT EXISTS (
    SELECT 1
    FROM skin_operation AS operation
    WHERE operation.revision_id = NEW.revision_id
  )
  AND EXISTS (
    SELECT 1
    FROM skin_revision AS revision
    WHERE revision.id = NEW.revision_id
      AND revision.project_id = NEW.project_id
      AND revision.created_at = NEW.created_at
      AND (
        (
          NEW.asset_type = 'revision_skin'
          AND revision.skin_asset_id = NEW.id
          AND NEW.storage_path =
            'projects/' || NEW.project_id || '/revisions/' || NEW.revision_id || '/skin.png'
        )
        OR (
          NEW.asset_type = 'segmentation_json'
          AND revision.segmentation_asset_id = NEW.id
          AND NEW.storage_path =
            'projects/' || NEW.project_id || '/revisions/' || NEW.revision_id || '/segmentation.json'
        )
        OR (
          NEW.asset_type = 'origin_json'
          AND revision.origin_asset_id = NEW.id
          AND NEW.storage_path =
            'projects/' || NEW.project_id || '/revisions/' || NEW.revision_id || '/origin.json'
        )
        OR (
          NEW.asset_type = 'operation_json'
          AND revision.operation_asset_id = NEW.id
          AND NEW.storage_path =
            'projects/' || NEW.project_id || '/revisions/' || NEW.revision_id || '/operation.json'
        )
        OR (
          NEW.asset_type = 'component_mask'
          AND substr(
            NEW.storage_path,
            1,
            length('projects/' || NEW.project_id || '/revisions/' || NEW.revision_id || '/components/')
          ) = 'projects/' || NEW.project_id || '/revisions/' || NEW.revision_id || '/components/'
          AND substr(NEW.storage_path, -9) = '.mask.png'
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid skin_asset revision binding');
END;

CREATE TRIGGER skin_asset_revision_bound_immutable_update
BEFORE UPDATE ON skin_asset
WHEN OLD.revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'revision-bound skin_asset is immutable');
END;

CREATE TRIGGER skin_asset_revision_bound_immutable_delete
BEFORE DELETE ON skin_asset
WHEN OLD.revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'revision-bound skin_asset is immutable');
END;

DROP TRIGGER part_asset_content_immutable_update;
DROP TRIGGER part_file_asset_binding_guard;
DROP TRIGGER part_file_asset_bound_immutable_update;
DROP TRIGGER part_file_asset_bound_immutable_delete;

CREATE TABLE part_file_asset_v14 (
  id TEXT PRIMARY KEY,
  part_id TEXT,
  file_role TEXT NOT NULL CHECK (
    file_role IN (
      'texture',
      'write_mask',
      'origin',
      'generated_mask',
      'manifest',
      'preview',
      'source'
    )
  ),
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (
    sha256 GLOB 'sha256:[0-9a-f]*' AND length(sha256) = 71
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (part_id) REFERENCES part_asset(id) ON DELETE RESTRICT,
  UNIQUE (part_id, file_role)
) STRICT;

INSERT INTO part_file_asset_v14 (
  id, part_id, file_role, storage_path, mime_type, byte_size, sha256, created_at
)
SELECT
  id, part_id, file_role, storage_path, mime_type, byte_size, sha256, created_at
FROM part_file_asset;

DROP TABLE part_file_asset;
ALTER TABLE part_file_asset_v14 RENAME TO part_file_asset;

CREATE INDEX idx_part_file_asset_part
  ON part_file_asset(part_id, file_role);

ALTER TABLE part_asset
  ADD COLUMN origin_asset_id TEXT
  REFERENCES part_file_asset(id) ON DELETE RESTRICT;

ALTER TABLE part_asset
  ADD COLUMN generated_mask_asset_id TEXT
  REFERENCES part_file_asset(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_part_asset_origin_asset
  ON part_asset(origin_asset_id)
  WHERE origin_asset_id IS NOT NULL;

CREATE UNIQUE INDEX idx_part_asset_generated_mask_asset
  ON part_asset(generated_mask_asset_id)
  WHERE generated_mask_asset_id IS NOT NULL;

CREATE TRIGGER part_asset_origin_required_insert
BEFORE INSERT ON part_asset
WHEN NOT (
  NEW.origin_asset_id IS NOT NULL
  AND NEW.generated_mask_asset_id IS NOT NULL
  AND json_extract(NEW.manifest_json, '$.schemaVersion') = '2.0'
)
BEGIN
  SELECT RAISE(ABORT, 'new part_asset requires Part 2.0 origin assets');
END;

-- Part content is immutable. Library lifecycle columns intentionally remain
-- mutable under the migration-009 lifecycle guards.
CREATE TRIGGER part_asset_content_immutable_update
BEFORE UPDATE ON part_asset
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.source_project_id IS NOT OLD.source_project_id
  OR NEW.source_revision_id IS NOT OLD.source_revision_id
  OR NEW.source_component_id IS NOT OLD.source_component_id
  OR NEW.name IS NOT OLD.name
  OR NEW.category IS NOT OLD.category
  OR NEW.subtype IS NOT OLD.subtype
  OR NEW.arm_type IS NOT OLD.arm_type
  OR NEW.texture_asset_id IS NOT OLD.texture_asset_id
  OR NEW.mask_asset_id IS NOT OLD.mask_asset_id
  OR NEW.origin_asset_id IS NOT OLD.origin_asset_id
  OR NEW.generated_mask_asset_id IS NOT OLD.generated_mask_asset_id
  OR NEW.manifest_asset_id IS NOT OLD.manifest_asset_id
  OR NEW.preview_asset_id IS NOT OLD.preview_asset_id
  OR NEW.source_asset_id IS NOT OLD.source_asset_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.manifest_json IS NOT OLD.manifest_json
  OR NEW.metadata_json IS NOT OLD.metadata_json
BEGIN
  SELECT RAISE(ABORT, 'part_asset content is immutable');
END;

-- Part files must be created unbound because part_asset references their ids.
-- The guarded one-time UPDATE below is the only supported binding operation.
CREATE TRIGGER part_file_asset_unbound_insert_guard
BEFORE INSERT ON part_file_asset
WHEN NEW.part_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'part_file_asset must be inserted unbound');
END;

CREATE TRIGGER part_file_asset_binding_guard
BEFORE UPDATE OF part_id ON part_file_asset
WHEN OLD.part_id IS NULL AND NOT (
  NEW.part_id IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.file_role IS OLD.file_role
  AND NEW.storage_path IS OLD.storage_path
  AND NEW.mime_type IS OLD.mime_type
  AND NEW.byte_size IS OLD.byte_size
  AND NEW.sha256 IS OLD.sha256
  AND NEW.created_at IS OLD.created_at
  AND NEW.storage_path =
    'parts/' || NEW.part_id || '/' ||
    CASE NEW.file_role
      WHEN 'texture' THEN 'texture.png'
      WHEN 'write_mask' THEN 'write-mask.png'
      WHEN 'origin' THEN 'origin.json'
      WHEN 'generated_mask' THEN 'generated-mask.png'
      WHEN 'manifest' THEN 'manifest.json'
      WHEN 'preview' THEN 'preview.png'
      WHEN 'source' THEN 'source.json'
    END
  AND EXISTS (
    SELECT 1
    FROM part_asset AS part
    WHERE part.id = NEW.part_id
      AND (
        (NEW.file_role = 'texture' AND part.texture_asset_id = NEW.id)
        OR (NEW.file_role = 'write_mask' AND part.mask_asset_id = NEW.id)
        OR (NEW.file_role = 'origin' AND part.origin_asset_id = NEW.id)
        OR (
          NEW.file_role = 'generated_mask'
          AND part.generated_mask_asset_id = NEW.id
        )
        OR (NEW.file_role = 'manifest' AND part.manifest_asset_id = NEW.id)
        OR (NEW.file_role = 'preview' AND part.preview_asset_id = NEW.id)
        OR (NEW.file_role = 'source' AND part.source_asset_id = NEW.id)
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid part_file_asset part binding');
END;

CREATE TRIGGER part_file_asset_bound_immutable_update
BEFORE UPDATE ON part_file_asset
WHEN OLD.part_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'part-bound part_file_asset is immutable');
END;

CREATE TRIGGER part_file_asset_bound_immutable_delete
BEFORE DELETE ON part_file_asset
WHEN OLD.part_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'part-bound part_file_asset is immutable');
END;

ALTER TABLE part_edit_revision ADD COLUMN origin_storage_path TEXT;
ALTER TABLE part_edit_revision
  ADD COLUMN origin_byte_size INTEGER CHECK (
    origin_byte_size IS NULL OR origin_byte_size >= 0
  );
ALTER TABLE part_edit_revision
  ADD COLUMN origin_sha256 TEXT CHECK (
    origin_sha256 IS NULL OR (
      origin_sha256 GLOB 'sha256:[0-9a-f]*' AND length(origin_sha256) = 71
    )
  );
ALTER TABLE part_edit_revision ADD COLUMN generated_mask_storage_path TEXT;
ALTER TABLE part_edit_revision
  ADD COLUMN generated_mask_byte_size INTEGER CHECK (
    generated_mask_byte_size IS NULL OR generated_mask_byte_size >= 0
  );
ALTER TABLE part_edit_revision
  ADD COLUMN generated_mask_sha256 TEXT CHECK (
    generated_mask_sha256 IS NULL OR (
      generated_mask_sha256 GLOB 'sha256:[0-9a-f]*' AND
      length(generated_mask_sha256) = 71
    )
  );

CREATE UNIQUE INDEX idx_part_edit_revision_origin_path
  ON part_edit_revision(origin_storage_path)
  WHERE origin_storage_path IS NOT NULL;

CREATE UNIQUE INDEX idx_part_edit_revision_generated_mask_path
  ON part_edit_revision(generated_mask_storage_path)
  WHERE generated_mask_storage_path IS NOT NULL;

CREATE TRIGGER part_edit_revision_origin_required_insert
BEFORE INSERT ON part_edit_revision
WHEN NOT (
  NEW.origin_storage_path IS NOT NULL
  AND NEW.origin_byte_size IS NOT NULL
  AND NEW.origin_sha256 IS NOT NULL
  AND NEW.generated_mask_storage_path IS NOT NULL
  AND NEW.generated_mask_byte_size IS NOT NULL
  AND NEW.generated_mask_sha256 IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'new part_edit_revision requires origin artifacts');
END;
