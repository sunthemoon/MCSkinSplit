-- Revision history is append-only once a row has been inserted. Snapshot schema
-- migrations that rebuild these tables must drop and recreate these guards in
-- the same migration transaction.
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

CREATE TRIGGER skin_operation_immutable_update
BEFORE UPDATE ON skin_operation
BEGIN
  SELECT RAISE(ABORT, 'skin_operation is immutable');
END;

CREATE TRIGGER skin_operation_immutable_delete
BEFORE DELETE ON skin_operation
BEGIN
  SELECT RAISE(ABORT, 'skin_operation is immutable');
END;

-- Snapshot assets are inserted before their Revision because skin_revision
-- references the three core assets. They may be bound exactly once while the
-- matching Revision has no final skin_operation row. All other fields and the
-- canonical storage location must already be final.
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

-- Part content is immutable. Library lifecycle columns are deliberately
-- excluded and remain governed by the migration-009 lifecycle guards.
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
  OR NEW.manifest_asset_id IS NOT OLD.manifest_asset_id
  OR NEW.preview_asset_id IS NOT OLD.preview_asset_id
  OR NEW.source_asset_id IS NOT OLD.source_asset_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.manifest_json IS NOT OLD.manifest_json
  OR NEW.metadata_json IS NOT OLD.metadata_json
BEGIN
  SELECT RAISE(ABORT, 'part_asset content is immutable');
END;

CREATE TRIGGER part_asset_immutable_delete
BEFORE DELETE ON part_asset
BEGIN
  SELECT RAISE(ABORT, 'part_asset is immutable');
END;

-- Part files are inserted first because part_asset references them. A file may
-- bind once to the Part and role that already references its immutable id.
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

-- Part repair revisions are append-only. The mutable head/status/result fields
-- live on part_edit_project and are intentionally not covered here.
CREATE TRIGGER part_edit_revision_immutable_update
BEFORE UPDATE ON part_edit_revision
BEGIN
  SELECT RAISE(ABORT, 'part_edit_revision is immutable');
END;

CREATE TRIGGER part_edit_revision_immutable_delete
BEFORE DELETE ON part_edit_revision
BEGIN
  SELECT RAISE(ABORT, 'part_edit_revision is immutable');
END;

-- Bundle revisions create a new bundle and soft-retire the old one. Only the
-- library lifecycle fields on part_bundle remain mutable.
CREATE TRIGGER part_bundle_content_immutable_update
BEFORE UPDATE ON part_bundle
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.source_project_id IS NOT OLD.source_project_id
  OR NEW.source_revision_id IS NOT OLD.source_revision_id
  OR NEW.name IS NOT OLD.name
  OR NEW.kind IS NOT OLD.kind
  OR NEW.source_group_key IS NOT OLD.source_group_key
  OR NEW.arm_types_json IS NOT OLD.arm_types_json
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.metadata_json IS NOT OLD.metadata_json
BEGIN
  SELECT RAISE(ABORT, 'part_bundle content is immutable');
END;

CREATE TRIGGER part_bundle_immutable_delete
BEFORE DELETE ON part_bundle
BEGIN
  SELECT RAISE(ABORT, 'part_bundle is immutable');
END;

CREATE TRIGGER part_bundle_member_immutable_update
BEFORE UPDATE ON part_bundle_member
BEGIN
  SELECT RAISE(ABORT, 'part_bundle_member is immutable');
END;

CREATE TRIGGER part_bundle_member_immutable_delete
BEFORE DELETE ON part_bundle_member
BEGIN
  SELECT RAISE(ABORT, 'part_bundle_member is immutable');
END;
