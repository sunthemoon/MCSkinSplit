import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  composeSkin,
  type CompositionLayerInput as PixelCompositionLayer,
  type CompositionReport,
  type CompositionRestorationPlan as PixelCompositionRestorationPlan,
  type CompositionResult as PixelCompositionResult,
} from "@mc-skin-split/skin-compositor";
import {
  SemanticEditError,
  aggregateKindForCategory,
  analyzePartApplication,
  applyManualSemanticOperation,
  applyPartRepairOperation,
  applyPartPixels,
  assignSemanticPixelsWithProvenance,
  assessArmType,
  createPartMannequinTexture,
  derivePartWriteMask,
  createInitialSemanticState,
  decodeSkinPng,
  encodeSkinPng,
  exportSemanticPart,
  getSkinLayout,
  isAggregateKind,
  isSemanticCategory,
  maskToRgbaImage,
  maskToPixelIds,
  pixelIdsToMask,
  pixelIdsToSpans,
  rgbaImageToMask,
  rebaseSemanticStateImage,
  validateSemanticState,
  canonicalRestorationJson,
  generateRestorationCandidates as generateCoreRestorationCandidates,
  createRestorationPlanFromCandidates as createCoreRestorationPlanFromCandidates,
  type ManualSemanticOperation,
  type AggregateKind,
  type PartManifest,
  type PartRepairOperation,
  type PartRepairState,
  type SegmentationDocument,
  type SemanticState,
  type RestorationCandidatePlan as CoreRestorationCandidatePlan,
  type RestorationCandidateSet as CoreRestorationCandidateSet,
  type RestorationSemanticRevision as CoreRestorationSemanticRevision,
} from "@mc-skin-split/skin-core";
import type Database from "better-sqlite3";
import { openRevisionDatabase } from "./database";
import {
  conflict,
  invalidInput,
  notFound,
  RevisionStoreError,
  snapshotCorrupt,
} from "./errors";
import { canonicalJson, sha256 } from "./hash";
import {
  PART_FILE_NAMES,
  PartStorage,
  type PartFileName,
  type VerifiedPartStorage,
} from "./part-storage";
import {
  PART_EDIT_FILE_NAMES,
  PartEditStorage,
  type PartEditFileName,
  type VerifiedPartEditStorage,
} from "./part-edit-storage";
import {
  SnapshotStorage,
  type VerifiedSnapshot,
} from "./snapshot-storage";
import {
  OPERATION_TYPES,
  type ActorType,
  type AiSegmentationRevisionInput,
  type AddCompositionBundleInput,
  type AddCompositionPartInput,
  type ApplyPartInput,
  type ApplyPartResult,
  type AnalyzedSkinCatalogItem,
  type AnalyzedSkinCatalogQuery,
  type ArchiveAnalyzedSkinInput,
  type BranchFromRevisionInput,
  type ApplyPartEditOperationInput,
  type CommitCompositionInput,
  type CommitCompositionResult,
  type CommitPartEditProjectInput,
  type CommitPartEditProjectResult,
  type ClearCompositionRestorationPlanInput,
  type CompositionDetail,
  type CompositionLayer,
  type CompositionProject,
  type CompositionRestorationCandidates,
  type CompositionRestorationEvent,
  type CreateCompositionInput,
  type CreateProjectInput,
  type CreateProjectResult,
  type CreatePartEditProjectInput,
  type ExportPartInput,
  type ExportPartBundleInput,
  type GenerateCompositionRestorationCandidatesInput,
  type ImportProjectInput,
  type ImportProjectResult,
  type ImportSkinInput,
  type ManualRevisionOperationInput,
  type OperationSnapshot,
  type PartApplicationPreview,
  type PartFileAsset,
  type PartLibraryQuery,
  type PartEditDetail,
  type PartEditOperationType,
  type PartEditProject,
  type PartEditRevision,
  type PartBundle,
  type PartBundleLibraryQuery,
  type PartBundleMember,
  type PersistedCompositionRestorationPlan,
  type RevisionDiff,
  type RevisionIdKind,
  type RevisionMutationResult,
  type RevisionOperationType,
  type RevisionStoreOptions,
  type RevisePartBundleInput,
  type RevisePartBundleResult,
  type RevertRevisionInput,
  type SerializedPartRepairOperation,
  type SemanticAnalysisFollowupStatus,
  type ReorderCompositionLayersInput,
  type ResolveCompositionConflictInput,
  type SetCompositionRestorationPlanInput,
  type SegmentationSnapshot,
  type SkinAsset,
  type SkinBranch,
  type SkinProject,
  type SkinPart,
  type SkinRevision,
} from "./types";

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly default_branch_id: string | null;
  readonly head_revision_id: string | null;
  readonly settings_json: string;
}

interface BranchRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly base_revision_id: string | null;
  readonly head_revision_id: string | null;
  readonly created_at: string;
}

interface RevisionRow {
  readonly id: string;
  readonly project_id: string;
  readonly branch_id: string;
  readonly branch_name: string;
  readonly branch_head_revision_id: string | null;
  readonly parent_revision_id: string | null;
  readonly sequence: number;
  readonly operation_type: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly ai_run_id: string | null;
  readonly summary: string;
  readonly skin_asset_id: string;
  readonly segmentation_asset_id: string;
  readonly operation_asset_id: string;
  readonly source_hash: string;
  readonly result_hash: string;
  readonly created_at: string;
  readonly metadata_json: string;
}

interface AssetRow {
  readonly id: string;
  readonly project_id: string;
  readonly revision_id: string | null;
  readonly asset_type: string;
  readonly storage_path: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly created_at: string;
}

interface RevisionIds {
  readonly revisionId: string;
  readonly skinAssetId: string;
  readonly segmentationAssetId: string;
  readonly operationAssetId: string;
  readonly operationId: string;
}

interface PartRow {
  readonly id: string;
  readonly source_project_id: string;
  readonly source_revision_id: string;
  readonly source_component_id: string;
  readonly source_project_name: string;
  readonly source_branch_name: string;
  readonly source_revision_sequence: number;
  readonly name: string;
  readonly category: string;
  readonly subtype: string | null;
  readonly arm_type: string;
  readonly created_at: string;
  readonly library_status: string;
  readonly retired_at: string | null;
  readonly retired_reason: string | null;
  readonly manifest_json: string;
  readonly metadata_json: string;
  readonly texture_id: string;
  readonly texture_storage_path: string;
  readonly texture_mime_type: string;
  readonly texture_byte_size: number;
  readonly texture_sha256: string;
  readonly mask_id: string;
  readonly mask_storage_path: string;
  readonly mask_mime_type: string;
  readonly mask_byte_size: number;
  readonly mask_sha256: string;
  readonly manifest_id: string;
  readonly manifest_storage_path: string;
  readonly manifest_mime_type: string;
  readonly manifest_byte_size: number;
  readonly manifest_sha256: string;
  readonly preview_id: string;
  readonly preview_storage_path: string;
  readonly preview_mime_type: string;
  readonly preview_byte_size: number;
  readonly preview_sha256: string;
  readonly source_id: string;
  readonly source_storage_path: string;
  readonly source_mime_type: string;
  readonly source_byte_size: number;
  readonly source_sha256: string;
}

interface PartBundleRow {
  readonly id: string;
  readonly source_project_id: string;
  readonly source_revision_id: string;
  readonly source_project_name: string;
  readonly source_branch_name: string;
  readonly source_revision_sequence: number;
  readonly name: string;
  readonly kind: string;
  readonly source_group_key: string | null;
  readonly arm_types_json: string;
  readonly created_at: string;
  readonly library_status: string;
  readonly retired_at: string | null;
  readonly retired_reason: string | null;
  readonly metadata_json: string;
}

interface PartBundleMemberRow {
  readonly bundle_id: string;
  readonly part_id: string;
  readonly position: number;
  readonly created_at: string;
}

interface PartEditProjectRow {
  readonly id: string;
  readonly base_part_id: string;
  readonly name: string;
  readonly status: string;
  readonly head_revision_id: string | null;
  readonly result_part_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly committed_at: string | null;
}

interface PartEditRevisionRow {
  readonly id: string;
  readonly project_id: string;
  readonly parent_revision_id: string | null;
  readonly sequence: number;
  readonly operation_type: string;
  readonly operation_json: string;
  readonly summary: string;
  readonly actor_id: string | null;
  readonly texture_storage_path: string;
  readonly texture_byte_size: number;
  readonly texture_sha256: string;
  readonly mask_storage_path: string;
  readonly mask_byte_size: number;
  readonly mask_sha256: string;
  readonly revision_storage_path: string;
  readonly revision_byte_size: number;
  readonly revision_sha256: string;
  readonly changed_pixel_count: number;
  readonly authored_provenance_json: string;
  readonly created_at: string;
}

interface AnalyzedCatalogRow {
  readonly job_id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly result_revision_id: string;
  readonly provider: string;
  readonly model: string;
  readonly review_items_json: string;
  readonly finished_at: string;
  readonly archived_at: string | null;
  readonly archived_reason: string | null;
  readonly followup_job_id: string | null;
  readonly followup_status: string | null;
  readonly followup_assessment_json: string | null;
  readonly followup_evidence_hash: string | null;
  readonly followup_applied_revision_id: string | null;
}

interface CompositionProjectRow {
  readonly id: string;
  readonly project_id: string;
  readonly base_revision_id: string;
  readonly branch_id: string;
  readonly name: string;
  readonly arm_type: string;
  readonly status: string;
  readonly resolution_mode: string;
  readonly conflict_winners_json: string;
  readonly report_json: string;
  readonly restoration_version: number;
  readonly restoration_plan_json: string | null;
  readonly result_revision_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly committed_at: string | null;
}

interface CompositionRestorationEventRow {
  readonly id: number;
  readonly composition_id: string;
  readonly version: number;
  readonly event_type: string;
  readonly candidate_set_hash: string | null;
  readonly candidate_ids_json: string;
  readonly payload_json: string;
  readonly created_at: string;
}

interface CompositionLayerRow {
  readonly id: string;
  readonly composition_id: string;
  readonly part_id: string;
  readonly position: number;
  readonly created_at: string;
}

const REVISION_SELECT = `
  SELECT
    revision.*,
    branch.name AS branch_name,
    branch.head_revision_id AS branch_head_revision_id
  FROM skin_revision AS revision
  JOIN skin_branch AS branch ON branch.id = revision.branch_id
`;

const PART_SELECT = `
  SELECT
    part.*,
    source_project.name AS source_project_name,
    source_branch.name AS source_branch_name,
    source_revision.sequence AS source_revision_sequence,
    texture.id AS texture_id,
    texture.storage_path AS texture_storage_path,
    texture.mime_type AS texture_mime_type,
    texture.byte_size AS texture_byte_size,
    texture.sha256 AS texture_sha256,
    mask.id AS mask_id,
    mask.storage_path AS mask_storage_path,
    mask.mime_type AS mask_mime_type,
    mask.byte_size AS mask_byte_size,
    mask.sha256 AS mask_sha256,
    manifest.id AS manifest_id,
    manifest.storage_path AS manifest_storage_path,
    manifest.mime_type AS manifest_mime_type,
    manifest.byte_size AS manifest_byte_size,
    manifest.sha256 AS manifest_sha256,
    preview.id AS preview_id,
    preview.storage_path AS preview_storage_path,
    preview.mime_type AS preview_mime_type,
    preview.byte_size AS preview_byte_size,
    preview.sha256 AS preview_sha256,
    source.id AS source_id,
    source.storage_path AS source_storage_path,
    source.mime_type AS source_mime_type,
    source.byte_size AS source_byte_size,
    source.sha256 AS source_sha256
  FROM part_asset AS part
  JOIN skin_project AS source_project ON source_project.id = part.source_project_id
  JOIN skin_revision AS source_revision ON source_revision.id = part.source_revision_id
  JOIN skin_branch AS source_branch ON source_branch.id = source_revision.branch_id
  JOIN part_file_asset AS texture ON texture.id = part.texture_asset_id
  JOIN part_file_asset AS mask ON mask.id = part.mask_asset_id
  JOIN part_file_asset AS manifest ON manifest.id = part.manifest_asset_id
  JOIN part_file_asset AS preview ON preview.id = part.preview_asset_id
  JOIN part_file_asset AS source ON source.id = part.source_asset_id
`;

const PART_BUNDLE_SELECT = `
  SELECT
    bundle.*,
    source_project.name AS source_project_name,
    source_branch.name AS source_branch_name,
    source_revision.sequence AS source_revision_sequence
  FROM part_bundle AS bundle
  JOIN skin_project AS source_project ON source_project.id = bundle.source_project_id
  JOIN skin_revision AS source_revision ON source_revision.id = bundle.source_revision_id
  JOIN skin_branch AS source_branch ON source_branch.id = source_revision.branch_id
`;

export class RevisionStore {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly storage: SnapshotStorage;
  readonly partStorage: PartStorage;
  readonly partEditStorage: PartEditStorage;
  private readonly database: Database.Database;
  private readonly nowProvider: () => Date | string;
  private readonly idProvider: (kind: RevisionIdKind) => string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RevisionStoreOptions) {
    if (!options.dataDirectory.trim()) {
      throw invalidInput("dataDirectory 不能为空");
    }

    this.dataDirectory = resolve(options.dataDirectory);
    mkdirSync(this.dataDirectory, { recursive: true });
    this.storage = new SnapshotStorage(this.dataDirectory);
    this.partStorage = new PartStorage(this.dataDirectory);
    this.partEditStorage = new PartEditStorage(this.dataDirectory);
    this.databasePath = resolve(
      options.databasePath ?? resolve(this.dataDirectory, "mcskinsplit.sqlite"),
    );
    this.database = openRevisionDatabase(this.databasePath);
    this.nowProvider = options.now ?? (() => new Date());
    this.idProvider = options.createId ?? defaultId;
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  listProjects(): SkinProject[] {
    const rows = this.database
      .prepare("SELECT * FROM skin_project ORDER BY created_at, id")
      .all() as ProjectRow[];
    return rows.map(mapProject);
  }

  getProject(projectId: string): SkinProject {
    const row = this.database
      .prepare("SELECT * FROM skin_project WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) {
      throw notFound("Project", projectId);
    }
    return mapProject(row);
  }

  listBranches(projectId: string): SkinBranch[] {
    this.getProject(projectId);
    const rows = this.database
      .prepare(
        "SELECT * FROM skin_branch WHERE project_id = ? ORDER BY created_at, id",
      )
      .all(projectId) as BranchRow[];
    return rows.map(mapBranch);
  }

  getBranch(branchId: string): SkinBranch {
    const row = this.database
      .prepare("SELECT * FROM skin_branch WHERE id = ?")
      .get(branchId) as BranchRow | undefined;
    if (!row) {
      throw notFound("Branch", branchId);
    }
    return mapBranch(row);
  }

  listRevisions(projectId: string, branchId?: string): SkinRevision[] {
    this.getProject(projectId);
    const filter = branchId ? "AND revision.branch_id = ?" : "";
    const statement = this.database.prepare(`
      ${REVISION_SELECT}
      WHERE revision.project_id = ? ${filter}
      ORDER BY revision.created_at, branch.created_at, revision.sequence, revision.id
    `);
    const rows = (branchId
      ? statement.all(projectId, branchId)
      : statement.all(projectId)) as RevisionRow[];
    return rows.map(mapRevision);
  }

  getRevision(revisionId: string): SkinRevision {
    const row = this.database
      .prepare(`${REVISION_SELECT} WHERE revision.id = ?`)
      .get(revisionId) as RevisionRow | undefined;
    if (!row) {
      throw notFound("Revision", revisionId);
    }
    return mapRevision(row);
  }

  getRevisionAssets(revisionId: string): SkinAsset[] {
    this.getRevision(revisionId);
    const rows = this.database
      .prepare(
        "SELECT * FROM skin_asset WHERE revision_id = ? ORDER BY asset_type, id",
      )
      .all(revisionId) as AssetRow[];
    return rows.map(mapAsset);
  }

  listParts(category?: string): SkinPart[];
  listParts(query?: PartLibraryQuery): SkinPart[];
  listParts(input?: string | PartLibraryQuery): SkinPart[] {
    const query: PartLibraryQuery =
      typeof input === "string" ? { category: input as PartLibraryQuery["category"] } : (input ?? {});
    if (query.category !== undefined && !isSemanticCategory(query.category)) {
      throw invalidInput(`未知部件分类：${query.category}`);
    }
    validateLibraryStatus(query.status);
    const conditions: string[] = [];
    const parameters: string[] = [];
    if ((query.status ?? "active") !== "all") {
      conditions.push("part.library_status = ?");
      parameters.push(query.status ?? "active");
    }
    if (query.category) {
      conditions.push("part.category = ?");
      parameters.push(query.category);
    }
    if (query.projectId) {
      this.getProject(query.projectId);
      conditions.push("part.source_project_id = ?");
      parameters.push(query.projectId);
    }
    if (query.sourceRevisionId) {
      this.getRevision(query.sourceRevisionId);
      conditions.push("part.source_revision_id = ?");
      parameters.push(query.sourceRevisionId);
    }
    if (query.q) {
      const term = `%${escapeLike(validateText("搜索关键词", query.q, 120))}%`;
      conditions.push("(part.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR source_project.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR source_branch.name LIKE ? ESCAPE '\\' COLLATE NOCASE)");
      parameters.push(term, term, term);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`${PART_SELECT}${where} ORDER BY part.created_at, part.id`)
      .all(...parameters) as PartRow[];
    return rows.map(mapPart);
  }

  getPart(partId: string): SkinPart {
    const row = this.database
      .prepare(`${PART_SELECT} WHERE part.id = ?`)
      .get(partId) as PartRow | undefined;
    if (!row) {
      throw notFound("Part", partId);
    }
    return mapPart(row);
  }

  private retirePartUnlocked(partId: string, reason?: string): SkinPart {
    const retire = this.database.transaction(() => {
      const part = this.getPart(partId);
      if (part.libraryStatus === "retired") return;
      const rows = this.database.prepare(`
        SELECT DISTINCT bundle.id
        FROM part_bundle_member AS member
        JOIN part_bundle AS bundle ON bundle.id = member.bundle_id
        WHERE member.part_id = ? AND bundle.library_status = 'active'
        ORDER BY bundle.id
      `).all(partId) as Array<{ id: string }>;
      if (rows.length) {
        throw conflict("部件被启用中的完整大类引用，请先修订或停用部件集", {
          partId,
          bundleIds: rows.map((row) => row.id),
        });
      }
      this.database.prepare(`
        UPDATE part_asset SET library_status = 'retired', retired_at = ?, retired_reason = ?
        WHERE id = ?
      `).run(this.now(), validateRetireReason(reason), partId);
    });
    retire.immediate();
    return this.getPart(partId);
  }

  private restorePartUnlocked(partId: string): SkinPart {
    this.getPart(partId);
    this.database.prepare(`
      UPDATE part_asset SET library_status = 'active', retired_at = NULL, retired_reason = NULL
      WHERE id = ?
    `).run(partId);
    return this.getPart(partId);
  }

  listPartEditProjects(basePartId?: string): PartEditProject[] {
    if (basePartId !== undefined) this.getPart(basePartId);
    const rows = (basePartId === undefined
      ? this.database
          .prepare("SELECT * FROM part_edit_project ORDER BY created_at, id")
          .all()
      : this.database
          .prepare(
            "SELECT * FROM part_edit_project WHERE base_part_id = ? ORDER BY created_at, id",
          )
          .all(basePartId)) as PartEditProjectRow[];
    return rows.map(mapPartEditProject);
  }

  getPartEditProject(projectId: string): PartEditProject {
    const row = this.database
      .prepare("SELECT * FROM part_edit_project WHERE id = ?")
      .get(projectId) as PartEditProjectRow | undefined;
    if (!row) throw notFound("Part edit project", projectId);
    return mapPartEditProject(row);
  }

  listPartEditRevisions(projectId: string): PartEditRevision[] {
    this.getPartEditProject(projectId);
    const rows = this.database
      .prepare(
        "SELECT * FROM part_edit_revision WHERE project_id = ? ORDER BY sequence, id",
      )
      .all(projectId) as PartEditRevisionRow[];
    return rows.map(mapPartEditRevision);
  }

  getPartEditRevision(revisionId: string): PartEditRevision {
    const row = this.database
      .prepare("SELECT * FROM part_edit_revision WHERE id = ?")
      .get(revisionId) as PartEditRevisionRow | undefined;
    if (!row) throw notFound("Part edit revision", revisionId);
    return mapPartEditRevision(row);
  }

  getPartEditDetail(projectId: string): PartEditDetail {
    const project = this.getPartEditProject(projectId);
    return {
      project,
      basePart: this.getPart(project.basePartId),
      headRevision: this.getPartEditRevision(project.headRevisionId),
      revisions: this.listPartEditRevisions(project.id),
      resultPart: project.resultPartId
        ? this.getPart(project.resultPartId)
        : null,
    };
  }

  listPartBundles(kind?: AggregateKind, sourceRevisionId?: string): PartBundle[];
  listPartBundles(query?: PartBundleLibraryQuery): PartBundle[];
  listPartBundles(input?: AggregateKind | PartBundleLibraryQuery, legacySourceRevisionId?: string): PartBundle[] {
    const query = typeof input === "string"
      ? { kind: input, ...(legacySourceRevisionId ? { sourceRevisionId: legacySourceRevisionId } : {}) }
      : (input ?? (legacySourceRevisionId ? { sourceRevisionId: legacySourceRevisionId } : {}));
    const kind = query.kind;
    const sourceRevisionId = query.sourceRevisionId;
    if (kind !== undefined && !isAggregateKind(kind)) {
      throw invalidInput(`未知部件集分类：${kind}`);
    }
    validateLibraryStatus(query.status);
    const conditions: string[] = [];
    const parameters: string[] = [];
    if ((query.status ?? "active") !== "all") {
      conditions.push("bundle.library_status = ?");
      parameters.push(query.status ?? "active");
    }
    if (kind !== undefined) {
      conditions.push("bundle.kind = ?");
      parameters.push(kind);
    }
    if (sourceRevisionId !== undefined) {
      this.getRevision(sourceRevisionId);
      conditions.push("bundle.source_revision_id = ?");
      parameters.push(sourceRevisionId);
    }
    if (query.projectId) {
      this.getProject(query.projectId);
      conditions.push("bundle.source_project_id = ?");
      parameters.push(query.projectId);
    }
    if (query.q) {
      const term = `%${escapeLike(validateText("搜索关键词", query.q, 120))}%`;
      conditions.push("(bundle.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR source_project.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR source_branch.name LIKE ? ESCAPE '\\' COLLATE NOCASE)");
      parameters.push(term, term, term);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`${PART_BUNDLE_SELECT}${where} ORDER BY bundle.created_at, bundle.id`)
      .all(...parameters) as PartBundleRow[];
    return rows.map((row) => this.mapPartBundle(row));
  }

  getPartBundle(bundleId: string): PartBundle {
    const row = this.database
      .prepare(`${PART_BUNDLE_SELECT} WHERE bundle.id = ?`)
      .get(bundleId) as PartBundleRow | undefined;
    if (!row) throw notFound("Part bundle", bundleId);
    return this.mapPartBundle(row);
  }

  private retirePartBundleUnlocked(bundleId: string, reason?: string): PartBundle {
    const bundle = this.getPartBundle(bundleId);
    if (bundle.libraryStatus === "retired") return bundle;
    this.database.prepare(`
      UPDATE part_bundle SET library_status = 'retired', retired_at = ?, retired_reason = ?
      WHERE id = ?
    `).run(this.now(), validateRetireReason(reason), bundleId);
    return this.getPartBundle(bundleId);
  }

  private restorePartBundleUnlocked(bundleId: string): PartBundle {
    const restore = this.database.transaction(() => {
      const bundle = this.getPartBundle(bundleId);
      const retiredMemberIds = bundle.members
        .filter((member) => member.part.libraryStatus === "retired")
        .map((member) => member.partId);
      if (retiredMemberIds.length) {
        throw conflict("部件集包含已停用部件，无法恢复", {
          bundleId,
          partIds: retiredMemberIds,
        });
      }
      this.database.prepare(`
        UPDATE part_bundle SET library_status = 'active', retired_at = NULL, retired_reason = NULL
        WHERE id = ?
      `).run(bundleId);
    });
    restore.immediate();
    return this.getPartBundle(bundleId);
  }

  private mapPartBundle(row: PartBundleRow): PartBundle {
    if (!isAggregateKind(row.kind)) {
      throw snapshotCorrupt(row.id, "部件集分类无效");
    }
    const armTypes = parseArmTypes(row.arm_types_json, row.id);
    const memberRows = this.database
      .prepare(
        "SELECT * FROM part_bundle_member WHERE bundle_id = ? ORDER BY position, part_id",
      )
      .all(row.id) as PartBundleMemberRow[];
    if (memberRows.length === 0 || memberRows.some((member, index) => member.position !== index)) {
      throw snapshotCorrupt(row.id, "部件集成员为空或位置不连续");
    }
    const members: PartBundleMember[] = memberRows.map((member) => ({
      bundleId: row.id,
      partId: member.part_id,
      position: member.position,
      part: this.getPart(member.part_id),
      createdAt: member.created_at,
    }));
    if (
      members.some(
        (member) =>
          member.part.sourceProjectId !== row.source_project_id ||
          member.part.sourceRevisionId !== row.source_revision_id ||
          aggregateKindForCategory(member.part.category) !== row.kind,
      )
    ) {
      throw snapshotCorrupt(row.id, "部件集成员与来源或大类不一致");
    }
    const expectedArmTypes = intersectArmTypes(
      members.map((member) => member.part.manifest.compatibility.armTypes),
    );
    if (canonicalJson(expectedArmTypes) !== canonicalJson(armTypes)) {
      throw snapshotCorrupt(row.id, "部件集手臂模型与成员不一致");
    }
    return {
      id: row.id,
      sourceProjectId: row.source_project_id,
      sourceRevisionId: row.source_revision_id,
      sourceProjectName: row.source_project_name,
      sourceBranchName: row.source_branch_name,
      sourceRevisionSequence: row.source_revision_sequence,
      name: row.name,
      kind: row.kind,
      sourceGroupKey: row.source_group_key,
      armTypes,
      members,
      createdAt: row.created_at,
      libraryStatus: assertLibraryStatus(
        row.library_status,
        row.id,
        row.retired_at,
        row.retired_reason,
      ),
      retiredAt: row.retired_at,
      retiredReason: row.retired_reason,
      metadata: parseObjectJson(row.metadata_json, `Part bundle ${row.id} metadata`),
    };
  }

  listCompositions(baseRevisionId?: string): CompositionProject[] {
    const rows = (baseRevisionId === undefined
      ? this.database
          .prepare("SELECT * FROM composition_project ORDER BY created_at, id")
          .all()
      : this.database
          .prepare(
            "SELECT * FROM composition_project WHERE base_revision_id = ? ORDER BY created_at, id",
          )
          .all(baseRevisionId)) as CompositionProjectRow[];
    return rows.map((row) => mapCompositionProject(row));
  }

  getComposition(compositionId: string): CompositionProject {
    const row = this.database
      .prepare("SELECT * FROM composition_project WHERE id = ?")
      .get(compositionId) as CompositionProjectRow | undefined;
    if (!row) throw notFound("Composition", compositionId);
    return mapCompositionProject(row);
  }

  listCompositionLayers(compositionId: string): CompositionLayer[] {
    this.getComposition(compositionId);
    const rows = this.database
      .prepare(
        "SELECT * FROM composition_layer WHERE composition_id = ? ORDER BY position, id",
      )
      .all(compositionId) as CompositionLayerRow[];
    return rows.map((row) => mapCompositionLayer(row, this.getPart(row.part_id)));
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    return this.withWriteLock(() => this.createProjectUnlocked(input));
  }

  async importProject(input: ImportProjectInput): Promise<ImportProjectResult> {
    return this.withWriteLock(() => this.importProjectUnlocked(input));
  }

  async importIntoProject(
    projectId: string,
    input: ImportSkinInput,
  ): Promise<ImportProjectResult> {
    return this.withWriteLock(() =>
      this.importIntoProjectUnlocked(projectId, input),
    );
  }

  async revertRevision(
    targetRevisionId: string,
    input: RevertRevisionInput = {},
  ): Promise<RevisionMutationResult> {
    return this.withWriteLock(() =>
      this.revertRevisionUnlocked(targetRevisionId, input),
    );
  }

  async branchFromRevision(
    targetRevisionId: string,
    input: BranchFromRevisionInput,
  ): Promise<RevisionMutationResult> {
    return this.withWriteLock(() =>
      this.branchFromRevisionUnlocked(targetRevisionId, input),
    );
  }

  async applyManualOperation(
    sourceRevisionId: string,
    input: ManualRevisionOperationInput,
  ): Promise<RevisionMutationResult> {
    return this.withWriteLock(() =>
      this.applyManualOperationUnlocked(sourceRevisionId, input),
    );
  }

  async commitAiSegmentation(
    sourceRevisionId: string,
    input: AiSegmentationRevisionInput,
  ): Promise<RevisionMutationResult> {
    return this.withWriteLock(() =>
      this.commitAiSegmentationUnlocked(sourceRevisionId, input),
    );
  }

  async exportPart(
    revisionId: string,
    componentId: string,
    input: ExportPartInput = {},
  ): Promise<SkinPart> {
    return this.withWriteLock(() =>
      this.exportPartUnlocked(revisionId, componentId, input),
    );
  }

  async retirePart(partId: string, reason?: string): Promise<SkinPart> {
    return this.withWriteLock(async () => this.retirePartUnlocked(partId, reason));
  }

  async restorePart(partId: string): Promise<SkinPart> {
    return this.withWriteLock(async () => this.restorePartUnlocked(partId));
  }

  async createPartEditProject(
    input: CreatePartEditProjectInput,
  ): Promise<PartEditDetail> {
    return this.withWriteLock(() => this.createPartEditProjectUnlocked(input));
  }

  async applyPartEditOperation(
    projectId: string,
    input: ApplyPartEditOperationInput,
  ): Promise<PartEditDetail> {
    return this.withWriteLock(() =>
      this.applyPartEditOperationUnlocked(projectId, input),
    );
  }

  async commitPartEditProject(
    projectId: string,
    input: CommitPartEditProjectInput,
  ): Promise<CommitPartEditProjectResult> {
    return this.withWriteLock(() =>
      this.commitPartEditProjectUnlocked(projectId, input),
    );
  }

  async exportPartBundle(
    revisionId: string,
    input: ExportPartBundleInput,
  ): Promise<PartBundle> {
    return this.withWriteLock(() =>
      this.exportPartBundleUnlocked(revisionId, input),
    );
  }

  async retirePartBundle(bundleId: string, reason?: string): Promise<PartBundle> {
    return this.withWriteLock(async () => this.retirePartBundleUnlocked(bundleId, reason));
  }

  async restorePartBundle(bundleId: string): Promise<PartBundle> {
    return this.withWriteLock(async () => this.restorePartBundleUnlocked(bundleId));
  }

  async revisePartBundle(
    bundleId: string,
    input: RevisePartBundleInput,
  ): Promise<RevisePartBundleResult> {
    return this.withWriteLock(() => this.revisePartBundleUnlocked(bundleId, input));
  }

  async applyPart(
    revisionId: string,
    input: ApplyPartInput,
  ): Promise<ApplyPartResult> {
    return this.withWriteLock(() => this.applyPartUnlocked(revisionId, input));
  }

  async createComposition(
    input: CreateCompositionInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() => this.createCompositionUnlocked(input));
  }

  async getCompositionDetail(compositionId: string): Promise<CompositionDetail> {
    const composition = this.getComposition(compositionId);
    const layers = this.listCompositionLayers(composition.id);
    const evaluated = await this.evaluateComposition(composition, layers);
    return { composition, layers, report: evaluated.report };
  }

  async generateCompositionRestorationCandidates(
    compositionId: string,
    input: GenerateCompositionRestorationCandidatesInput,
  ): Promise<CompositionRestorationCandidates> {
    return this.generateCompositionRestorationCandidatesUnlocked(
      compositionId,
      input,
    );
  }

  async setCompositionRestorationPlan(
    compositionId: string,
    input: SetCompositionRestorationPlanInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.setCompositionRestorationPlanUnlocked(compositionId, input),
    );
  }

  async clearCompositionRestorationPlan(
    compositionId: string,
    input: ClearCompositionRestorationPlanInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.clearCompositionRestorationPlanUnlocked(compositionId, input),
    );
  }

  listCompositionRestorationEvents(
    compositionId: string,
  ): CompositionRestorationEvent[] {
    this.getComposition(compositionId);
    return (this.database
      .prepare(`
        SELECT * FROM composition_restoration_event
        WHERE composition_id = ?
        ORDER BY version, id
      `)
      .all(compositionId) as CompositionRestorationEventRow[]).map(
      mapCompositionRestorationEvent,
    );
  }

  async listAnalyzedSkins(
    query: AnalyzedSkinCatalogQuery = {},
  ): Promise<AnalyzedSkinCatalogItem[]> {
    validateAnalyzedSkinCatalogStatus(query.status);
    if (query.kind !== undefined && !isAggregateKind(query.kind)) {
      throw invalidInput(`未知已分析目录分类：${query.kind}`);
    }
    if (query.projectId !== undefined) this.getProject(query.projectId);
    const rows = this.database
      .prepare(`
        SELECT
          job.id AS job_id,
          job.project_id,
          project.name AS project_name,
          job.result_revision_id,
          job.provider,
          job.model,
          job.review_items_json,
          job.finished_at,
          archive.archived_at,
          archive.archived_reason,
          followup.job_id AS followup_job_id,
          followup.status AS followup_status,
          followup.assessment_json AS followup_assessment_json,
          followup.evidence_hash AS followup_evidence_hash,
          followup.applied_revision_id AS followup_applied_revision_id
        FROM ai_job AS job
        JOIN skin_project AS project ON project.id = job.project_id
        LEFT JOIN analyzed_skin_catalog_archive AS archive
          ON archive.result_revision_id = job.result_revision_id
        LEFT JOIN semantic_analysis_followup AS followup
          ON followup.result_revision_id = job.result_revision_id
        WHERE job.job_kind = 'semantic_analysis'
          AND job.status = 'succeeded'
          AND job.result_revision_id IS NOT NULL
          AND job.finished_at IS NOT NULL
        ORDER BY job.finished_at DESC, job.id DESC
      `)
      .all() as AnalyzedCatalogRow[];
    const newestByRevision = new Map<string, AnalyzedCatalogRow>();
    for (const row of rows) {
      if (!newestByRevision.has(row.result_revision_id)) {
        newestByRevision.set(row.result_revision_id, row);
      }
    }
    const status = query.status ?? "active";
    const selectedRows = [...newestByRevision.values()].filter((row) =>
      status === "all"
        ? true
        : status === "archived"
          ? row.archived_at !== null
          : row.archived_at === null,
    );
    const items = await Promise.all(
      selectedRows.map((row) => this.analyzedCatalogItem(row)),
    );
    const normalizedQuery = query.query?.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (query.projectId && item.project.id !== query.projectId) return false;
      if (query.kind && !item.groups.some((group) => group.kind === query.kind)) return false;
      if (
        normalizedQuery &&
        !`${item.project.name} ${item.revision.branchName} ${item.groups.map((group) => group.displayName).join(" ")}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ) {
        return false;
      }
      return true;
    });
  }

  async getAnalyzedSkin(revisionId: string): Promise<AnalyzedSkinCatalogItem> {
    const items = await this.listAnalyzedSkins({ status: "all" });
    const item = items.find((candidate) => candidate.revision.id === revisionId);
    if (!item) throw notFound("Analyzed skin", revisionId);
    return item;
  }

  async archiveAnalyzedSkin(
    revisionId: string,
    input: ArchiveAnalyzedSkinInput = {},
  ): Promise<AnalyzedSkinCatalogItem> {
    return this.withWriteLock(async () => {
      const archivedAt = this.now();
      const archivedReason = input.reason === undefined
        ? null
        : validateAnalyzedSkinArchiveReason(input.reason);
      const archive = this.database.transaction(() => {
        this.assertAnalyzedSkinCatalogRevision(revisionId);
        this.database.prepare(`
          INSERT INTO analyzed_skin_catalog_archive (
            result_revision_id, archived_at, archived_reason
          ) VALUES (?, ?, ?)
          ON CONFLICT(result_revision_id) DO NOTHING
        `).run(revisionId, archivedAt, archivedReason);
      });
      archive.immediate();
      return this.getAnalyzedSkin(revisionId);
    });
  }

  async restoreAnalyzedSkin(revisionId: string): Promise<AnalyzedSkinCatalogItem> {
    return this.withWriteLock(async () => {
      const restore = this.database.transaction(() => {
        this.assertAnalyzedSkinCatalogRevision(revisionId);
        this.database.prepare(
          "DELETE FROM analyzed_skin_catalog_archive WHERE result_revision_id = ?",
        ).run(revisionId);
      });
      restore.immediate();
      return this.getAnalyzedSkin(revisionId);
    });
  }

  private assertAnalyzedSkinCatalogRevision(revisionId: string): void {
    const row = this.database.prepare(`
      SELECT job.id
      FROM ai_job AS job
      WHERE job.job_kind = 'semantic_analysis'
        AND job.status = 'succeeded'
        AND job.result_revision_id = ?
        AND job.finished_at IS NOT NULL
      LIMIT 1
    `).get(revisionId) as { readonly id: string } | undefined;
    if (!row) throw notFound("Analyzed skin", revisionId);
  }

  private async analyzedCatalogItem(
    row: AnalyzedCatalogRow,
  ): Promise<AnalyzedSkinCatalogItem> {
    const revision = this.getRevision(row.result_revision_id);
    const catalogLifecycle = assertAnalyzedSkinCatalogLifecycle(row);
    const segmentation = await this.readRevisionSegmentation(revision.id);
    const bundles = this.listPartBundles(undefined, revision.id);
    const groups = aggregateCatalogGroups(segmentation, bundles);
    const followup = parseSemanticAnalysisFollowup(row);
    this.assertSemanticFollowupCatalogIntegrity(row, revision, followup);
    let appliedVariant = null;
    if (followup?.appliedRevisionId) {
      const appliedRevision = this.getRevision(followup.appliedRevisionId);
      this.assertSemanticFollowupAppliedRevision(
        revision,
        appliedRevision,
        followup,
      );
      const appliedSegmentation = await this.readRevisionSegmentation(appliedRevision.id);
      const appliedBundles = this.listPartBundles(undefined, appliedRevision.id);
      appliedVariant = {
        label: "分类修复版" as const,
        revision: {
          id: appliedRevision.id,
          branchId: appliedRevision.branchId,
          branchName: appliedRevision.branchName,
          sequence: appliedRevision.sequence,
          createdAt: appliedRevision.createdAt,
        },
        groups: aggregateCatalogGroups(appliedSegmentation, appliedBundles),
        skinUrl: `/api/revisions/${encodeURIComponent(appliedRevision.id)}/skin.png`,
      };
    }
    return {
      project: { id: row.project_id, name: row.project_name },
      revision: {
        id: revision.id,
        branchId: revision.branchId,
        branchName: revision.branchName,
        sequence: revision.sequence,
        createdAt: revision.createdAt,
      },
      aiJob: {
        id: row.job_id,
        provider: row.provider,
        model: row.model,
        finishedAt: row.finished_at,
      },
      armType: segmentation.source.armType,
      componentCount: segmentation.components.length,
      unknownPixelCount: segmentation.unknown.pixelCount,
      reviewItemCount: parseJsonArray(row.review_items_json, `AI Job ${row.job_id} review items`).length,
      groups,
      skinUrl: `/api/revisions/${encodeURIComponent(revision.id)}/skin.png`,
      semanticFollowup: followup === null
        ? null
        : {
            jobId: followup.jobId,
            status: followup.status,
            evidenceHash: followup.evidenceHash,
            suggestionCount: followup.suggestionCount,
            suggestedPixelCount: followup.suggestedPixelCount,
            notices: followup.notices,
            appliedVariant,
          },
      catalogStatus: catalogLifecycle.status,
      archivedAt: catalogLifecycle.archivedAt,
      archivedReason: catalogLifecycle.archivedReason,
    };
  }

  private assertSemanticFollowupCatalogIntegrity(
    row: AnalyzedCatalogRow,
    revision: SkinRevision,
    followup: ParsedSemanticAnalysisFollowup | null,
  ): void {
    if (!followup) return;
    const provenance = this.database.prepare(`
      SELECT job.input_revision_id, run.job_id AS run_job_id
      FROM ai_job AS job
      JOIN ai_run AS run ON run.job_id = job.id
      WHERE job.id = ? AND run.id = ?
    `).get(followup.jobId, revision.aiRunId ?? null) as {
      readonly input_revision_id: string;
      readonly run_job_id: string;
    } | undefined;
    if (
      followup.jobId !== row.job_id ||
      revision.operationType !== "ai_segment" ||
      revision.actorType !== "ai" ||
      !revision.aiRunId ||
      !provenance ||
      provenance.run_job_id !== followup.jobId ||
      revision.parentRevisionId !== provenance.input_revision_id ||
      revision.metadata.aiJobId !== followup.jobId ||
      revision.metadata.aiRunId !== revision.aiRunId
    ) {
      throw snapshotCorrupt(revision.id, "分析后续结果与 AI Job provenance 不一致");
    }
  }

  private assertSemanticFollowupAppliedRevision(
    resultRevision: SkinRevision,
    appliedRevision: SkinRevision,
    followup: ParsedSemanticAnalysisFollowup,
  ): void {
    const context = isJsonObject(appliedRevision.metadata.semanticFollowup)
      ? appliedRevision.metadata.semanticFollowup
      : null;
    const operation = isJsonObject(appliedRevision.metadata.operation)
      ? appliedRevision.metadata.operation
      : null;
    const target = operation && isJsonObject(operation.target)
      ? operation.target
      : null;
    const suggestionId = typeof context?.suggestionId === "string"
      ? context.suggestionId
      : null;
    const storedSuggestion = suggestionId === null
      ? null
      : followup.suggestions.find((suggestion) => suggestion.id === suggestionId) ?? null;
    if (
      appliedRevision.projectId !== resultRevision.projectId ||
      appliedRevision.operationType !== "manual_edit" ||
      appliedRevision.actorType !== "user" ||
      appliedRevision.actorId !== "semantic-followup" ||
      operation?.type !== "assign_pixels" ||
      target?.category !== "hair" ||
      context?.jobId !== followup.jobId ||
      context?.resultRevisionId !== resultRevision.id ||
      context?.evidenceHash !== followup.evidenceHash ||
      !storedSuggestion ||
      target?.instanceId !== storedSuggestion.targetComponentId ||
      !sameSemanticSpanSet(operation?.spans, storedSuggestion.spans)
    ) {
      throw snapshotCorrupt(resultRevision.id, "分类修复版 provenance 无效");
    }

    const branchRevision = appliedRevision.parentRevisionId
      ? this.getRevision(appliedRevision.parentRevisionId)
      : null;
    if (
      !branchRevision ||
      branchRevision.projectId !== resultRevision.projectId ||
      branchRevision.operationType !== "branch" ||
      branchRevision.actorType !== "user" ||
      branchRevision.actorId !== "semantic-followup" ||
      branchRevision.parentRevisionId !== resultRevision.id ||
      branchRevision.branchId !== appliedRevision.branchId ||
      branchRevision.metadata.baseRevisionId !== resultRevision.id
    ) {
      throw snapshotCorrupt(
        resultRevision.id,
        "分类修复版不是识别结果的确定性修复分支",
      );
    }
  }

  private assertSemanticFollowupOperation(
    context: NonNullable<ManualRevisionOperationInput["semanticFollowup"]>,
    operation: Extract<ManualSemanticOperation, { readonly type: "assign_pixels" }>,
  ): void {
    const evidence = this.database.prepare(`
      SELECT
        json_extract(suggestion.value, '$.targetComponentId') AS target_component_id,
        json_extract(suggestion.value, '$.spans') AS spans_json
      FROM semantic_analysis_followup AS followup,
           json_each(followup.assessment_json, '$.suggestions') AS suggestion
      WHERE followup.job_id = ?
        AND followup.result_revision_id = ?
        AND followup.status = 'awaiting_review'
        AND followup.evidence_hash = ?
        AND json_extract(suggestion.value, '$.id') = ?
      LIMIT 1
    `).get(
      context.jobId,
      context.resultRevisionId,
      context.evidenceHash,
      context.suggestionId,
    ) as {
      readonly target_component_id: unknown;
      readonly spans_json: unknown;
    } | undefined;
    if (!evidence) {
      throw conflict("语义分类修复已被处理或证据已经变化", {
        jobId: context.jobId,
        suggestionId: context.suggestionId,
      });
    }

    let expectedSpans: unknown;
    try {
      expectedSpans = typeof evidence.spans_json === "string"
        ? JSON.parse(evidence.spans_json)
        : null;
    } catch (error) {
      throw snapshotCorrupt(
        context.resultRevisionId,
        "语义分类修复建议的像素证据无效",
        { cause: error },
      );
    }
    if (
      evidence.target_component_id !== operation.target.instanceId ||
      !sameSemanticSpanSet(expectedSpans, operation.spans)
    ) {
      throw conflict("语义分类修复操作与建议证据不一致", {
        jobId: context.jobId,
        suggestionId: context.suggestionId,
      });
    }
  }

  async addCompositionPart(
    compositionId: string,
    input: AddCompositionPartInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.addCompositionPartUnlocked(compositionId, input),
    );
  }

  async addCompositionBundle(
    compositionId: string,
    input: AddCompositionBundleInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.addCompositionBundleUnlocked(compositionId, input),
    );
  }

  async removeCompositionLayer(
    compositionId: string,
    layerId: string,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.removeCompositionLayerUnlocked(compositionId, layerId),
    );
  }

  async reorderCompositionLayers(
    compositionId: string,
    input: ReorderCompositionLayersInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.reorderCompositionLayersUnlocked(compositionId, input),
    );
  }

  async resolveCompositionConflict(
    compositionId: string,
    input: ResolveCompositionConflictInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.resolveCompositionConflictUnlocked(compositionId, input),
    );
  }

  async readCompositionPreviewPng(compositionId: string): Promise<Uint8Array> {
    const composition = this.getComposition(compositionId);
    const layers = this.listCompositionLayers(composition.id);
    const evaluated = await this.evaluateComposition(composition, layers);
    return encodeSkinPng(evaluated.image);
  }

  async commitComposition(
    compositionId: string,
    input: CommitCompositionInput = {},
  ): Promise<CommitCompositionResult> {
    return this.withWriteLock(() =>
      this.commitCompositionUnlocked(compositionId, input),
    );
  }

  async verifyPartStorage(partId: string): Promise<VerifiedPartStorage> {
    const part = this.getPart(partId);
    let stored: VerifiedPartStorage;
    try {
      stored = await this.partStorage.readPart(part.id);
    } catch (error) {
      throw partCorrupt(part.id, "文件缺失", error);
    }
    const expected: Readonly<Record<PartFileName, PartFileAsset>> = {
      "texture.png": part.texture,
      "write-mask.png": part.writeMask,
      "manifest.json": part.manifestFile,
      "preview.png": part.preview,
      "source.json": part.source,
    };
    for (const fileName of PART_FILE_NAMES) {
      const file = stored.files[fileName];
      const asset = expected[fileName];
      if (
        file.storagePath !== asset.storagePath ||
        file.sha256 !== asset.sha256 ||
        file.bytes.byteLength !== asset.byteSize
      ) {
        throw partCorrupt(part.id, `${fileName} 与数据库资产不一致`);
      }
    }
    const storedManifest = parsePartManifest(
      Buffer.from(stored.files["manifest.json"].bytes).toString("utf8"),
      part.id,
    );
    if (canonicalJson(storedManifest) !== canonicalJson(part.manifest)) {
      throw partCorrupt(part.id, "manifest.json 与数据库不一致");
    }
    return stored;
  }

  async readPartTexturePng(partId: string): Promise<Uint8Array> {
    const stored = await this.verifyPartStorage(partId);
    return stored.files["texture.png"].bytes.slice();
  }

  async readPartPreviewPng(partId: string): Promise<Uint8Array> {
    const stored = await this.verifyPartStorage(partId);
    return stored.files["preview.png"].bytes.slice();
  }

  async readPartMannequinPng(
    partId: string,
    armType: "wide" | "slim",
  ): Promise<Uint8Array> {
    const part = this.getPart(partId);
    if (!part.manifest.compatibility.armTypes.includes(armType)) {
      throw invalidInput("部件不兼容请求的白模手臂模型", {
        partId,
        armType,
        supportedArmTypes: part.manifest.compatibility.armTypes,
      });
    }
    const stored = await this.verifyPartStorage(part.id);
    const texture = decodeSkinPng(stored.files["texture.png"].bytes);
    const writeMask = rgbaImageToMask(
      decodeSkinPng(stored.files["write-mask.png"].bytes),
    );
    return encodeSkinPng(
      createPartMannequinTexture(texture, writeMask, armType),
    );
  }

  async verifyPartEditStorage(
    revisionId: string,
  ): Promise<VerifiedPartEditStorage> {
    const revision = this.getPartEditRevision(revisionId);
    let stored: VerifiedPartEditStorage;
    try {
      stored = await this.partEditStorage.readRevision(
        revision.projectId,
        revision.id,
      );
    } catch (error) {
      throw partEditCorrupt(revision.id, "文件缺失", error);
    }
    const expected: Readonly<Record<PartEditFileName, PartFileAsset>> = {
      "texture.png": revision.texture,
      "write-mask.png": revision.writeMask,
      "revision.json": revision.revisionFile,
    };
    for (const fileName of PART_EDIT_FILE_NAMES) {
      const file = stored.files[fileName];
      const asset = expected[fileName];
      if (
        file.storagePath !== asset.storagePath ||
        file.sha256 !== asset.sha256 ||
        file.bytes.byteLength !== asset.byteSize
      ) {
        throw partEditCorrupt(revision.id, `${fileName} 与数据库元数据不一致`);
      }
    }
    const document = parsePartEditDocument(
      stored.files["revision.json"].bytes,
      revision.id,
    );
    if (
      document.id !== revision.id ||
      document.projectId !== revision.projectId ||
      document.parentRevisionId !== revision.parentRevisionId ||
      document.sequence !== revision.sequence ||
      compactCanonicalJson(document.operation) !==
        compactCanonicalJson(revision.operation) ||
      document.summary !== revision.summary ||
      document.actorId !== (revision.actorId ?? null) ||
      document.changedPixelCount !== revision.changedPixelCount ||
      compactCanonicalJson(document.authoredProvenance) !==
        compactCanonicalJson(revision.authoredProvenance) ||
      document.createdAt !== revision.createdAt
    ) {
      throw partEditCorrupt(revision.id, "revision.json 与数据库不一致");
    }
    if (revision.sequence === 1) {
      if (revision.parentRevisionId !== null) {
        throw partEditCorrupt(revision.id, "首个 Revision 不能声明父 Revision");
      }
    } else {
      if (revision.parentRevisionId === null) {
        throw partEditCorrupt(revision.id, "非首个 Revision 缺少父 Revision");
      }
      const parentRow = this.database
        .prepare("SELECT project_id, sequence FROM part_edit_revision WHERE id = ?")
        .get(revision.parentRevisionId) as
        | { readonly project_id: string; readonly sequence: number }
        | undefined;
      if (
        parentRow === undefined ||
        parentRow.project_id !== revision.projectId ||
        parentRow.sequence !== revision.sequence - 1
      ) {
        throw partEditCorrupt(
          revision.id,
          "父 Revision 必须属于同一工程并紧邻当前序号",
        );
      }
    }
    const project = this.getPartEditProject(revision.projectId);
    const basePart = this.getPart(project.basePartId);
    try {
      const texture = decodeSkinPng(stored.files["texture.png"].bytes);
      const writeMask = rgbaImageToMask(
        decodeSkinPng(stored.files["write-mask.png"].bytes),
      );
      const derived = derivePartWriteMask(texture, basePart.armType);
      if (!derived.every((value, index) => value === writeMask[index])) {
        throw new RangeError("写入遮罩与纹理 alpha 不一致");
      }
    } catch (error) {
      throw partEditCorrupt(revision.id, "纹理或遮罩无效", error);
    }
    return stored;
  }

  async readPartEditTexturePng(revisionId: string): Promise<Uint8Array> {
    return (await this.verifyPartEditStorage(revisionId)).files[
      "texture.png"
    ].bytes.slice();
  }

  async readPartEditWriteMaskPng(revisionId: string): Promise<Uint8Array> {
    return (await this.verifyPartEditStorage(revisionId)).files[
      "write-mask.png"
    ].bytes.slice();
  }

  async readPartEditMannequinPng(
    revisionId: string,
    armType: "wide" | "slim",
  ): Promise<Uint8Array> {
    const revision = this.getPartEditRevision(revisionId);
    const project = this.getPartEditProject(revision.projectId);
    const basePart = this.getPart(project.basePartId);
    if (!basePart.manifest.compatibility.armTypes.includes(armType)) {
      throw invalidInput("修补部件不兼容请求的白模手臂模型", {
        revisionId,
        armType,
        supportedArmTypes: basePart.manifest.compatibility.armTypes,
      });
    }
    const state = await this.readPartEditState(revision.id);
    return encodeSkinPng(
      createPartMannequinTexture(state.texture, state.writeMask, armType),
    );
  }

  async readPartBundlePreviewPng(bundleId: string): Promise<Uint8Array> {
    const { texture } = await this.readVerifiedBundleTexture(bundleId);
    return encodeSkinPng(texture);
  }

  async readPartBundleMannequinPng(
    bundleId: string,
    armType: "wide" | "slim",
  ): Promise<Uint8Array> {
    const bundle = this.getPartBundle(bundleId);
    if (!bundle.armTypes.includes(armType)) {
      throw invalidInput("部件集不兼容请求的白模手臂模型", {
        bundleId,
        armType,
        supportedArmTypes: bundle.armTypes,
      });
    }
    const { texture, writeMask } = await this.readVerifiedBundleTexture(bundleId);
    return encodeSkinPng(createPartMannequinTexture(texture, writeMask, armType));
  }

  private async readVerifiedBundleTexture(bundleId: string) {
    const bundle = this.getPartBundle(bundleId);
    return this.validateBundleMemberPixels(
      bundle.members.map((member) => member.part),
      bundle.id,
    );
  }

  private async validateBundleMemberPixels(
    parts: readonly SkinPart[],
    bundleId: string,
    overlapMode: "snapshot" | "proposal" = "snapshot",
  ) {
    const data = new Uint8Array(64 * 64 * 4);
    const written = new Uint8Array(64 * 64);
    for (const part of parts) {
      const stored = await this.verifyPartStorage(part.id);
      const texture = decodeSkinPng(stored.files["texture.png"].bytes);
      const mask = rgbaImageToMask(
        decodeSkinPng(stored.files["write-mask.png"].bytes),
      );
      for (const pixelId of maskToPixelIds(mask)) {
        const offset = pixelId * 4;
        const alpha = texture.data[offset + 3]!;
        if (alpha === 0) {
          throw snapshotCorrupt(bundleId, `部件 ${part.id} 写入了透明像素`);
        }
        if (written[pixelId]) {
          const same = [0, 1, 2, 3].every(
            (channel) => data[offset + channel] === texture.data[offset + channel],
          );
          if (!same) {
            if (overlapMode === "proposal") {
              throw invalidInput("修订后的部件集成员存在不同颜色重叠", {
                bundleId,
                pixelId,
                partId: part.id,
              });
            }
            throw snapshotCorrupt(bundleId, `部件集成员在像素 ${pixelId} 存在不同颜色重叠`);
          }
          continue;
        }
        data.set(texture.data.subarray(offset, offset + 4), offset);
        written[pixelId] = 1;
      }
    }
    return {
      texture: { width: 64 as const, height: 64 as const, data },
      writeMask: written,
    };
  }

  async previewPartApplication(
    revisionId: string,
    partId: string,
  ): Promise<PartApplicationPreview> {
    const revision = this.getRevision(revisionId);
    const part = this.getPart(partId);
    const [snapshot, storedPart] = await Promise.all([
      this.verifyRevisionSnapshot(revision.id),
      this.verifyPartStorage(part.id),
    ]);
    const image = decodeSkinPng(snapshot.files["skin.png"].bytes);
    const texture = decodeSkinPng(storedPart.files["texture.png"].bytes);
    const writeMask = rgbaImageToMask(
      decodeSkinPng(storedPart.files["write-mask.png"].bytes),
    );
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      revision.id,
    );
    return {
      revisionId: revision.id,
      part,
      report: analyzePartApplication(
        image,
        texture,
        writeMask,
        part.manifest,
        segmentation.source.armType,
      ),
    };
  }

  async verifyRevisionSnapshot(revisionId: string): Promise<VerifiedSnapshot> {
    const revision = this.getRevision(revisionId);
    const snapshot = await this.storage.verifySnapshot(
      revision.projectId,
      revision.id,
    );
    const assets = this.getRevisionAssets(revision.id);
    const expectedAssets = Object.values(snapshot.files).map((file) => {
      if (file.name === "skin.png") {
        return {
          file,
          id: revision.skinAssetId,
          assetType: "revision_skin" as const,
          mimeType: "image/png",
        };
      }
      if (file.name === "segmentation.json") {
        return {
          file,
          id: revision.segmentationAssetId,
          assetType: "segmentation_json" as const,
          mimeType: "application/json",
        };
      }
      if (file.name === "operation.json") {
        return {
          file,
          id: revision.operationAssetId,
          assetType: "operation_json" as const,
          mimeType: "application/json",
        };
      }
      return {
        file,
        id: null,
        assetType: "component_mask" as const,
        mimeType: "image/png",
      };
    });

    if (assets.length !== expectedAssets.length) {
      throw snapshotCorrupt(revision.id, "数据库资产数量不正确");
    }

    const assetsByPath = new Map(assets.map((asset) => [asset.storagePath, asset]));
    for (const expected of expectedAssets) {
      const asset = assetsByPath.get(expected.file.storagePath);
      if (
        !asset ||
        (expected.id !== null && asset.id !== expected.id) ||
        asset.assetType !== expected.assetType ||
        asset.projectId !== revision.projectId ||
        asset.revisionId !== revision.id ||
        asset.storagePath !== expected.file.storagePath ||
        asset.mimeType !== expected.mimeType ||
        asset.sha256 !== expected.file.sha256 ||
        asset.byteSize !== expected.file.bytes.byteLength
      ) {
        throw snapshotCorrupt(
          revision.id,
          `数据库资产 ${asset?.id ?? expected.file.name} 与快照不一致`,
        );
      }
    }

    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      revision.id,
    );
    if (
      segmentation.source.sourceHash !== snapshot.files["skin.png"].sha256
    ) {
      throw snapshotCorrupt(revision.id, "segmentation sourceHash 与皮肤不一致");
    }
    const operation = parseOperation(
      snapshot.files["operation.json"].bytes,
      revision.id,
    );
    if (
      operation.type !== revision.operationType ||
      operation.inputRevisionId !== revision.parentRevisionId ||
      operation.actor.type !== revision.actorType ||
      operation.actor.id !== revision.actorId ||
      operation.createdAt !== revision.createdAt ||
      operation.summary !== revision.summary ||
      operation.afterHash !== revision.resultHash
    ) {
      throw snapshotCorrupt(revision.id, "operation.json 与 Revision 元数据不一致");
    }
    const resultHash = computeResultHash(snapshot.files["skin.png"].bytes, segmentation);
    if (resultHash !== revision.resultHash) {
      throw snapshotCorrupt(revision.id, "resultHash 与快照状态不一致");
    }
    semanticStateFromSnapshot(snapshot, segmentation, revision.id);

    return snapshot;
  }

  async readRevisionSkinPng(revisionId: string): Promise<Uint8Array> {
    const snapshot = await this.verifyRevisionSnapshot(revisionId);
    return snapshot.files["skin.png"].bytes.slice();
  }

  async readRevisionSegmentation(
    revisionId: string,
  ): Promise<SegmentationSnapshot> {
    const snapshot = await this.verifyRevisionSnapshot(revisionId);
    return parseSegmentation(snapshot.files["segmentation.json"].bytes, revisionId);
  }

  async readRevisionSemanticState(revisionId: string): Promise<SemanticState> {
    const snapshot = await this.verifyRevisionSnapshot(revisionId);
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      revisionId,
    );
    return semanticStateFromSnapshot(snapshot, segmentation, revisionId);
  }

  async readRevisionOperation(revisionId: string): Promise<OperationSnapshot> {
    const snapshot = await this.verifyRevisionSnapshot(revisionId);
    return parseOperation(snapshot.files["operation.json"].bytes, revisionId);
  }

  async diffRevisions(
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<RevisionDiff> {
    const fromRevision = this.getRevision(fromRevisionId);
    const toRevision = this.getRevision(toRevisionId);
    if (fromRevision.projectId !== toRevision.projectId) {
      throw invalidInput("只能比较同一 Project 内的 Revision");
    }

    const [fromPng, toPng] = await Promise.all([
      this.readRevisionSkinPng(fromRevisionId),
      this.readRevisionSkinPng(toRevisionId),
    ]);
    const fromImage = decodeSkinPng(fromPng);
    const toImage = decodeSkinPng(toPng);
    const changedPixelIds: number[] = [];
    let minX = 64;
    let minY = 64;
    let maxX = -1;
    let maxY = -1;

    for (let pixelId = 0; pixelId < 64 * 64; pixelId += 1) {
      const offset = pixelId * 4;
      if (
        fromImage.data[offset] !== toImage.data[offset] ||
        fromImage.data[offset + 1] !== toImage.data[offset + 1] ||
        fromImage.data[offset + 2] !== toImage.data[offset + 2] ||
        fromImage.data[offset + 3] !== toImage.data[offset + 3]
      ) {
        changedPixelIds.push(pixelId);
        const x = pixelId % 64;
        const y = Math.floor(pixelId / 64);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    return {
      fromRevisionId,
      toRevisionId,
      changedPixelCount: changedPixelIds.length,
      changedPixelIds,
      boundingBox:
        changedPixelIds.length === 0
          ? null
          : {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
    };
  }

  private async createProjectUnlocked(
    input: CreateProjectInput,
  ): Promise<CreateProjectResult> {
    const projectName = validateText("Project 名称", input.name, 120);
    const projectId = this.id("project");
    const branchId = this.id("branch");
    const createdAt = this.now();
    const settings = canonicalJson({
      armType: "slim",
      coordinateOrigin: "top-left",
    }).trim();

    const commit = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO skin_project (
            id, name, created_at, updated_at, default_branch_id,
            head_revision_id, settings_json
          ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
        `)
        .run(projectId, projectName, createdAt, createdAt, settings);
      this.database
        .prepare(`
          INSERT INTO skin_branch (
            id, project_id, name, base_revision_id, head_revision_id, created_at
          ) VALUES (?, ?, 'main', NULL, NULL, ?)
        `)
        .run(branchId, projectId, createdAt);
      this.database
        .prepare(
          "UPDATE skin_project SET default_branch_id = ? WHERE id = ?",
        )
        .run(branchId, projectId);
    });
    commit.immediate();

    return {
      project: this.getProject(projectId),
      branch: this.getBranch(branchId),
    };
  }

  private async importIntoProjectUnlocked(
    projectId: string,
    input: ImportSkinInput,
  ): Promise<ImportProjectResult> {
    const project = this.getProject(projectId);
    const branch = this.getBranch(project.defaultBranchId);
    if (project.headRevisionId || branch.headRevisionId) {
      throw conflict("Project 已经完成首次导入", { projectId });
    }

    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const fileName = validateOptionalText("文件名", input.fileName, 180);
    const sourcePng = Uint8Array.from(input.skinPng);
    const image = decodeSkinPng(sourcePng);
    const assessment = assessArmType(image);
    const armType = input.armType ?? assessment.armType;
    const warnings =
      input.armType && input.armType !== assessment.armType
        ? [`手动模型 ${input.armType} 覆盖自动识别 ${assessment.armType}`]
        : [];
    const canonicalSkinPng = encodeSkinPng(image);
    const canonicalSkinHash = sha256(canonicalSkinPng);
    const sourceHash = sha256(sourcePng);
    const createdAt = this.now();
    const ids = this.revisionIds();
    const summary = validateText(
      "Revision 摘要",
      input.summary ?? `导入 ${fileName ?? "64×64 皮肤"}`,
      300,
    );
    const semanticState = createInitialSemanticState({
      revisionId: ids.revisionId,
      armType,
      sourceHash: canonicalSkinHash,
      image,
    });
    const segmentation = semanticState.document;
    const resultHash = computeResultHash(canonicalSkinPng, segmentation);
    const metadata = {
      armType,
      armTypeInference: assessment,
      originalFileName: fileName,
    };
    const operation = createOperation({
      type: "import",
      inputRevisionId: null,
      outputRevisionId: ids.revisionId,
      actorType: "user",
      actorId,
      createdAt,
      summary,
      beforeHash: null,
      afterHash: resultHash,
      metadata: { fileName, sourceHash },
    });
    const snapshot = await this.storage.writeSnapshot({
      projectId: project.id,
      revisionId: ids.revisionId,
      skinPng: canonicalSkinPng,
      segmentationJson: canonicalJson(segmentation),
      operationJson: canonicalJson(operation),
      additionalFiles: semanticMaskFiles(semanticState),
    });

    try {
      const commit = this.database.transaction(() => {
        const currentBranch = this.database
          .prepare("SELECT head_revision_id FROM skin_branch WHERE id = ?")
          .get(branch.id) as { head_revision_id: string | null } | undefined;
        if (!currentBranch || currentBranch.head_revision_id) {
          throw conflict("Project 已经完成首次导入", { projectId });
        }
        const assetIds = this.insertAssets(project.id, ids, snapshot, createdAt);
        this.insertRevision({
          ids,
          projectId: project.id,
          branchId: branch.id,
          parentRevisionId: null,
          sequence: 1,
          operationType: "import",
          actorType: "user",
          actorId,
          summary,
          sourceHash,
          resultHash,
          createdAt,
          metadata,
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(project.id, ids, "import", summary, createdAt);
        this.database
          .prepare("UPDATE skin_branch SET head_revision_id = ? WHERE id = ?")
          .run(ids.revisionId, branch.id);
        this.database
          .prepare(`
            UPDATE skin_project
            SET head_revision_id = ?, updated_at = ?, settings_json = ?
            WHERE id = ?
          `)
          .run(
            ids.revisionId,
            createdAt,
            canonicalJson({ armType, coordinateOrigin: "top-left" }).trim(),
            project.id,
          );
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(project.id, ids.revisionId);
      throw error;
    }

    return {
      project: this.getProject(project.id),
      branch: this.getBranch(branch.id),
      revision: this.getRevision(ids.revisionId),
      armType,
      warnings,
    };
  }

  private async importProjectUnlocked(
    input: ImportProjectInput,
  ): Promise<ImportProjectResult> {
    const projectName = validateText("Project 名称", input.name, 120);
    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const fileName = validateOptionalText("文件名", input.fileName, 180);
    const sourcePng = Uint8Array.from(input.skinPng);
    const image = decodeSkinPng(sourcePng);
    const assessment = assessArmType(image);
    const armType = input.armType ?? assessment.armType;
    const warnings =
      input.armType && input.armType !== assessment.armType
        ? [`手动模型 ${input.armType} 覆盖自动识别 ${assessment.armType}`]
        : [];
    const canonicalSkinPng = encodeSkinPng(image);
    const canonicalSkinHash = sha256(canonicalSkinPng);
    const sourceHash = sha256(sourcePng);
    const createdAt = this.now();
    const projectId = this.id("project");
    const branchId = this.id("branch");
    const ids = this.revisionIds();
    const summary = validateText(
      "Revision 摘要",
      input.summary ?? `导入 ${fileName ?? "64×64 皮肤"}`,
      300,
    );
    const semanticState = createInitialSemanticState({
      revisionId: ids.revisionId,
      armType,
      sourceHash: canonicalSkinHash,
      image,
    });
    const segmentation = semanticState.document;
    const resultHash = computeResultHash(canonicalSkinPng, segmentation);
    const metadata = {
      armType,
      armTypeInference: assessment,
      originalFileName: fileName,
    };
    const operation = createOperation({
      type: "import",
      inputRevisionId: null,
      outputRevisionId: ids.revisionId,
      actorType: "user",
      actorId,
      createdAt,
      summary,
      beforeHash: null,
      afterHash: resultHash,
      metadata: { fileName, sourceHash },
    });

    const snapshot = await this.storage.writeSnapshot({
      projectId,
      revisionId: ids.revisionId,
      skinPng: canonicalSkinPng,
      segmentationJson: canonicalJson(segmentation),
      operationJson: canonicalJson(operation),
      additionalFiles: semanticMaskFiles(semanticState),
    });

    try {
      const commit = this.database.transaction(() => {
        this.database
          .prepare(`
            INSERT INTO skin_project (
              id, name, created_at, updated_at, default_branch_id,
              head_revision_id, settings_json
            ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
          `)
          .run(
            projectId,
            projectName,
            createdAt,
            createdAt,
            canonicalJson({ armType, coordinateOrigin: "top-left" }).trim(),
          );
        this.database
          .prepare(`
            INSERT INTO skin_branch (
              id, project_id, name, base_revision_id, head_revision_id, created_at
            ) VALUES (?, ?, 'main', NULL, NULL, ?)
          `)
          .run(branchId, projectId, createdAt);
        const assetIds = this.insertAssets(projectId, ids, snapshot, createdAt);
        this.insertRevision({
          ids,
          projectId,
          branchId,
          parentRevisionId: null,
          sequence: 1,
          operationType: "import",
          actorType: "user",
          actorId,
          summary,
          sourceHash,
          resultHash,
          createdAt,
          metadata,
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(projectId, ids, "import", summary, createdAt);
        this.database
          .prepare(
            "UPDATE skin_branch SET head_revision_id = ? WHERE id = ?",
          )
          .run(ids.revisionId, branchId);
        this.database
          .prepare(`
            UPDATE skin_project
            SET default_branch_id = ?, head_revision_id = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(branchId, ids.revisionId, createdAt, projectId);
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(projectId, ids.revisionId);
      throw error;
    }

    return {
      project: this.getProject(projectId),
      branch: this.getBranch(branchId),
      revision: this.getRevision(ids.revisionId),
      armType,
      warnings,
    };
  }

  private async createCompositionUnlocked(
    input: CreateCompositionInput,
  ): Promise<CompositionDetail> {
    const sourceRevision = this.getRevision(input.baseRevisionId);
    const project = this.getProject(sourceRevision.projectId);
    const branch = this.getBranch(input.branchId ?? sourceRevision.branchId);
    if (branch.projectId !== project.id) {
      throw invalidInput("混搭目标 Branch 与基础 Revision 不属于同一 Project");
    }
    if (branch.headRevisionId !== sourceRevision.id) {
      throw conflict("创建混搭工程只能基于所选 Branch 的最新 Revision", {
        baseRevisionId: sourceRevision.id,
        branchId: branch.id,
        branchHeadRevisionId: branch.headRevisionId,
      });
    }
    const snapshot = await this.verifyRevisionSnapshot(sourceRevision.id);
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      sourceRevision.id,
    );
    const compositionId = this.id("composition");
    const createdAt = this.now();
    const name = validateText(
      "混搭工程名称",
      input.name ?? `${project.name} 混搭`,
      120,
    );
    const emptyResult = composeSkin({
      base: decodeSkinPng(snapshot.files["skin.png"].bytes),
      targetArmType: segmentation.source.armType,
      layers: [],
    });
    this.database
      .prepare(`
        INSERT INTO composition_project (
          id, project_id, base_revision_id, branch_id, name, arm_type,
          status, resolution_mode, conflict_winners_json, report_json,
          result_revision_id, created_at, updated_at, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'unresolved', '{}', ?, NULL, ?, ?, NULL)
      `)
      .run(
        compositionId,
        project.id,
        sourceRevision.id,
        branch.id,
        name,
        segmentation.source.armType,
        compactCanonicalJson(emptyResult.report),
        createdAt,
        createdAt,
      );
    const composition = this.getComposition(compositionId);
    return { composition, layers: [], report: emptyResult.report };
  }

  private async addCompositionPartUnlocked(
    compositionId: string,
    input: AddCompositionPartInput,
  ): Promise<CompositionDetail> {
    const composition = this.requireDraftComposition(compositionId);
    const existing = this.listCompositionLayers(composition.id);
    if (existing.some((layer) => layer.partId === input.partId)) {
      throw conflict("同一部件不能在一个混搭工程中重复添加", {
        compositionId,
        partId: input.partId,
      });
    }
    const part = this.getPart(input.partId);
    this.assertActivePart(part, "加入混搭");
    await this.verifyPartStorage(part.id);
    const position = input.position ?? existing.length;
    if (!Number.isInteger(position) || position < 0 || position > existing.length) {
      throw invalidInput("部件图层位置超出范围", {
        position,
        layerCount: existing.length,
      });
    }
    const createdAt = this.now();
    const inserted: CompositionLayer = {
      id: this.id("composition_layer"),
      compositionId: composition.id,
      partId: part.id,
      position,
      part,
      createdAt,
    };
    const layers = [...existing];
    layers.splice(position, 0, inserted);
    const normalized = normalizeCompositionLayers(layers);
    const draft = resetCompositionResolution(composition);
    const evaluated = await this.evaluateComposition(draft, normalized);
    this.persistCompositionDraft(
      composition.id,
      normalized,
      draft.resolutionMode,
      draft.conflictWinners,
      evaluated.report,
      createdAt,
    );
    return {
      composition: this.getComposition(composition.id),
      layers: normalized,
      report: evaluated.report,
    };
  }

  private async addCompositionBundleUnlocked(
    compositionId: string,
    input: AddCompositionBundleInput,
  ): Promise<CompositionDetail> {
    const composition = this.requireDraftComposition(compositionId);
    const bundle = this.getPartBundle(input.bundleId);
    this.assertActiveBundle(bundle, "加入混搭");
    for (const member of bundle.members) {
      this.assertActivePart(member.part, "加入混搭");
    }
    if (!bundle.armTypes.includes(composition.armType)) {
      throw invalidInput("部件集不兼容当前混搭模型", {
        bundleId: bundle.id,
        armType: composition.armType,
      });
    }
    const existing = this.listCompositionLayers(composition.id);
    const existingPartIds = new Set(existing.map((layer) => layer.partId));
    const duplicate = bundle.members.find((member) => existingPartIds.has(member.partId));
    if (duplicate) {
      throw conflict("部件集成员已在混搭工程中", {
        compositionId,
        bundleId: bundle.id,
        partId: duplicate.partId,
      });
    }
    await Promise.all(bundle.members.map((member) => this.verifyPartStorage(member.partId)));
    const position = input.position ?? existing.length;
    if (!Number.isInteger(position) || position < 0 || position > existing.length) {
      throw invalidInput("部件集图层位置超出范围", {
        position,
        layerCount: existing.length,
      });
    }
    const createdAt = this.now();
    const inserted = bundle.members.map((member, memberPosition): CompositionLayer => ({
      id: this.id("composition_layer"),
      compositionId: composition.id,
      partId: member.partId,
      position: position + memberPosition,
      part: member.part,
      createdAt,
    }));
    const layers = [...existing];
    layers.splice(position, 0, ...inserted);
    const normalized = normalizeCompositionLayers(layers);
    const draft = resetCompositionResolution(composition);
    const evaluated = await this.evaluateComposition(draft, normalized);
    this.persistCompositionDraft(
      composition.id,
      normalized,
      draft.resolutionMode,
      draft.conflictWinners,
      evaluated.report,
      createdAt,
    );
    return {
      composition: this.getComposition(composition.id),
      layers: normalized,
      report: evaluated.report,
    };
  }

  private async removeCompositionLayerUnlocked(
    compositionId: string,
    layerId: string,
  ): Promise<CompositionDetail> {
    const composition = this.requireDraftComposition(compositionId);
    assertSafeReferenceId("layerId", layerId);
    const existing = this.listCompositionLayers(composition.id);
    if (!existing.some((layer) => layer.id === layerId)) {
      throw notFound("Composition layer", layerId);
    }
    const layers = normalizeCompositionLayers(
      existing.filter((layer) => layer.id !== layerId),
    );
    const draft = resetCompositionResolution(composition);
    const evaluated = await this.evaluateComposition(draft, layers);
    const updatedAt = this.now();
    this.persistCompositionDraft(
      composition.id,
      layers,
      draft.resolutionMode,
      draft.conflictWinners,
      evaluated.report,
      updatedAt,
    );
    return {
      composition: this.getComposition(composition.id),
      layers,
      report: evaluated.report,
    };
  }

  private async reorderCompositionLayersUnlocked(
    compositionId: string,
    input: ReorderCompositionLayersInput,
  ): Promise<CompositionDetail> {
    const composition = this.requireDraftComposition(compositionId);
    const existing = this.listCompositionLayers(composition.id);
    const requested = [...input.layerIds];
    if (
      requested.length !== existing.length ||
      new Set(requested).size !== requested.length ||
      requested.some((id) => !existing.some((layer) => layer.id === id))
    ) {
      throw invalidInput("图层排序必须完整且不能重复", {
        expectedLayerIds: existing.map((layer) => layer.id),
      });
    }
    const byId = new Map(existing.map((layer) => [layer.id, layer]));
    const layers = requested.map((id, position) => ({
      ...byId.get(id)!,
      position,
    }));
    const draft = resetCompositionResolution(composition);
    const evaluated = await this.evaluateComposition(draft, layers);
    const updatedAt = this.now();
    this.persistCompositionDraft(
      composition.id,
      layers,
      draft.resolutionMode,
      draft.conflictWinners,
      evaluated.report,
      updatedAt,
    );
    return {
      composition: this.getComposition(composition.id),
      layers,
      report: evaluated.report,
    };
  }

  private async resolveCompositionConflictUnlocked(
    compositionId: string,
    input: ResolveCompositionConflictInput,
  ): Promise<CompositionDetail> {
    const composition = this.requireDraftComposition(compositionId);
    const layers = this.listCompositionLayers(composition.id);
    let resolutionMode = composition.resolutionMode;
    let conflictWinners = { ...composition.conflictWinners };

    if (input.strategy === "clear") {
      resolutionMode = "unresolved";
      conflictWinners = {};
    } else if (input.strategy === "layer_order") {
      resolutionMode = "layer_order";
    } else {
      const current = await this.evaluateComposition(composition, layers);
      const target = current.report.conflicts.find(
        (candidate) => candidate.id === input.conflictId,
      );
      if (!target || !("writes" in target)) {
        throw invalidInput("只能为逐像素冲突指定胜出图层", {
          conflictId: input.conflictId,
        });
      }
      if (!target.writes.some((write) => write.layerId === input.winnerLayerId)) {
        throw invalidInput("胜出图层没有写入该冲突像素", {
          conflictId: input.conflictId,
          winnerLayerId: input.winnerLayerId,
        });
      }
      conflictWinners[input.conflictId] = input.winnerLayerId;
    }

    const candidate: CompositionProject = {
      ...composition,
      resolutionMode,
      conflictWinners,
    };
    const evaluated = await this.evaluateComposition(candidate, layers);
    const updatedAt = this.now();
    const update = this.database
      .prepare(`
        UPDATE composition_project
        SET resolution_mode = ?, conflict_winners_json = ?, report_json = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'
      `)
      .run(
        resolutionMode,
        compactCanonicalJson(conflictWinners),
        compactCanonicalJson(evaluated.report),
        updatedAt,
        composition.id,
      );
    if (update.changes !== 1) {
      throw conflict("混搭工程已提交，请重新载入", { compositionId });
    }
    return {
      composition: this.getComposition(composition.id),
      layers,
      report: evaluated.report,
    };
  }

  private async generateCompositionRestorationCandidatesUnlocked(
    compositionId: string,
    input: GenerateCompositionRestorationCandidatesInput,
  ): Promise<CompositionRestorationCandidates> {
    const composition = this.requireDraftComposition(compositionId);
    const candidateSet = await this.buildCompositionRestorationCandidateSet(
      composition,
      input,
    );
    return summarizeCompositionRestorationCandidates(
      composition.id,
      this.compositionRestorationVersion(composition.id),
      candidateSet,
    );
  }

  private async setCompositionRestorationPlanUnlocked(
    compositionId: string,
    input: SetCompositionRestorationPlanInput,
  ): Promise<CompositionDetail> {
    const composition = this.requireDraftComposition(compositionId);
    assertRestorationVersion(input.expectedVersion);
    if (input.expectedVersion !== this.compositionRestorationVersion(composition.id)) {
      throw conflict("还原方案版本已变化，请重新生成候选", {
        compositionId,
        expectedVersion: input.expectedVersion,
        actualVersion: this.compositionRestorationVersion(composition.id),
      });
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(input.candidateSetHash)) {
      throw invalidInput("candidateSetHash 无效");
    }
    const candidateIds = validateUniqueSafeIds(
      "candidateIds",
      input.candidateIds,
      512,
    );
    const generationInput: GenerateCompositionRestorationCandidatesInput = {
      targetComponentIds: input.targetComponentIds,
      ...(input.donorRevisionId ? { donorRevisionId: input.donorRevisionId } : {}),
      ...(input.manualRgba ? { manualRgba: input.manualRgba } : {}),
    };
    const candidateSet = await this.buildCompositionRestorationCandidateSet(
      composition,
      generationInput,
    );
    if (candidateSet.candidateSetHash !== input.candidateSetHash) {
      throw conflict("还原候选已经变化，请重新生成候选", {
        compositionId,
        expectedCandidateSetHash: input.candidateSetHash,
        actualCandidateSetHash: candidateSet.candidateSetHash,
      });
    }
    let candidatePlan: CoreRestorationCandidatePlan;
    try {
      candidatePlan = createCoreRestorationPlanFromCandidates(
        candidateSet,
        candidateIds,
        sha256,
      );
    } catch (error) {
      throw invalidInput("还原候选选择无效", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const nextVersion = input.expectedVersion + 1;
    const persisted = persistableRestorationPlan(
      nextVersion,
      candidateSet,
      candidatePlan,
    );
    const candidateComposition: CompositionProject = {
      ...composition,
      resolutionMode: "unresolved",
      conflictWinners: {},
      restorationPlan: persisted.summary,
    };
    const layers = this.listCompositionLayers(composition.id);
    const evaluated = await this.evaluateComposition(
      candidateComposition,
      layers,
      persisted,
    );
    const createdAt = this.now();
    const persist = this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE composition_project
        SET restoration_version = ?, restoration_plan_json = ?,
            resolution_mode = 'unresolved', conflict_winners_json = '{}',
            report_json = ?, updated_at = ?
        WHERE id = ? AND status = 'draft' AND restoration_version = ?
      `).run(
        nextVersion,
        compactCanonicalJson(persisted),
        compactCanonicalJson(evaluated.report),
        createdAt,
        composition.id,
        input.expectedVersion,
      );
      if (updated.changes !== 1) {
        throw conflict("还原方案版本已变化，请重新载入", { compositionId });
      }
      this.insertCompositionRestorationEvent({
        compositionId: composition.id,
        version: nextVersion,
        eventType: "plan_set",
        candidateSetHash: candidateSet.candidateSetHash,
        candidateIds: persisted.summary.candidateIds,
        payload: {
          planHash: persisted.summary.planHash,
          targetComponentIds: persisted.summary.targetComponentIds,
          outerPixelCount: persisted.summary.outerPixelCount,
          basePixelCount: persisted.summary.basePixelCount,
          coveredPixelCount: persisted.summary.coveredPixelCount,
          missingPixelCount: persisted.summary.missingPixelCount,
        },
        createdAt,
      });
    });
    persist.immediate();
    return {
      composition: this.getComposition(composition.id),
      layers,
      report: evaluated.report,
    };
  }

  private async clearCompositionRestorationPlanUnlocked(
    compositionId: string,
    input: ClearCompositionRestorationPlanInput,
  ): Promise<CompositionDetail> {
    const composition = this.requireDraftComposition(compositionId);
    assertRestorationVersion(input.expectedVersion);
    if (input.expectedVersion !== this.compositionRestorationVersion(composition.id)) {
      throw conflict("还原方案版本已变化，请重新载入", {
        compositionId,
        expectedVersion: input.expectedVersion,
        actualVersion: this.compositionRestorationVersion(composition.id),
      });
    }
    const nextVersion = input.expectedVersion + 1;
    const layers = this.listCompositionLayers(composition.id);
    const evaluated = await this.evaluateComposition(
      {
        ...composition,
        resolutionMode: "unresolved",
        conflictWinners: {},
        restorationPlan: null,
      },
      layers,
      null,
    );
    const createdAt = this.now();
    const previousPlanHash = composition.restorationPlan?.planHash ?? null;
    const persist = this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE composition_project
        SET restoration_version = ?, restoration_plan_json = NULL,
            resolution_mode = 'unresolved', conflict_winners_json = '{}',
            report_json = ?, updated_at = ?
        WHERE id = ? AND status = 'draft' AND restoration_version = ?
      `).run(
        nextVersion,
        compactCanonicalJson(evaluated.report),
        createdAt,
        composition.id,
        input.expectedVersion,
      );
      if (updated.changes !== 1) {
        throw conflict("还原方案版本已变化，请重新载入", { compositionId });
      }
      this.insertCompositionRestorationEvent({
        compositionId: composition.id,
        version: nextVersion,
        eventType: "plan_cleared",
        candidateSetHash: composition.restorationPlan?.candidateSetHash ?? null,
        candidateIds: composition.restorationPlan?.candidateIds ?? [],
        payload: { previousPlanHash },
        createdAt,
      });
    });
    persist.immediate();
    return {
      composition: this.getComposition(composition.id),
      layers,
      report: evaluated.report,
    };
  }

  private async commitCompositionUnlocked(
    compositionId: string,
    input: CommitCompositionInput,
  ): Promise<CommitCompositionResult> {
    const composition = this.requireDraftComposition(compositionId);
    const sourceRevision = this.getRevision(composition.baseRevisionId);
    const project = this.getProject(composition.projectId);
    const branch = this.getBranch(composition.branchId);
    if (branch.headRevisionId !== sourceRevision.id) {
      throw conflict("基础 Branch 已产生新 Revision，请重新创建混搭工程", {
        compositionId,
        baseRevisionId: sourceRevision.id,
        branchHeadRevisionId: branch.headRevisionId,
      });
    }
    const layers = this.listCompositionLayers(composition.id);
    const retiredLayerParts = layers
      .map((layer) => layer.part)
      .filter((part) => part.libraryStatus === "retired");
    if (retiredLayerParts.length > 0) {
      throw conflict("混搭图层引用了已退役部件，不能创建 Revision", {
        compositionId,
        partIds: retiredLayerParts.map((part) => part.id),
      });
    }
    const evaluated = await this.evaluateComposition(composition, layers);
    if (!evaluated.report.committable) {
      throw conflict("混搭仍有未解决冲突，不能创建 Revision", {
        compositionId,
        unresolvedConflictCount: evaluated.report.unresolvedConflictCount,
      });
    }

    const sourceSnapshot = await this.verifyRevisionSnapshot(sourceRevision.id);
    const segmentation = parseSegmentation(
      sourceSnapshot.files["segmentation.json"].bytes,
      sourceRevision.id,
    );
    const sourceState = semanticStateFromSnapshot(
      sourceSnapshot,
      segmentation,
      sourceRevision.id,
    );
    const sourceImage = decodeSkinPng(sourceSnapshot.files["skin.png"].bytes);
    const skinPng = encodeSkinPng(evaluated.image);
    let state = rebaseSemanticStateImage({
      state: sourceState,
      sourceImage,
      resultImage: evaluated.image,
      sourceHash: sha256(skinPng),
    });
    const persistedPlan = this.readPersistedCompositionRestorationPlan(composition.id);
    const affectedComponents: string[] = [];
    const affectedPixelIds = new Set<number>();
    const winningPartPixelIds = new Set(
      Object.values(evaluated.winningPixelIdsByLayer).flat(),
    );
    if (persistedPlan) {
      for (const pixelId of persistedPlan.coveredPixelIds) {
        affectedPixelIds.add(pixelId);
      }
      for (const candidate of persistedPlan.selectedCandidates) {
        const restoredPixelIds = candidate.coveredPixelIds.filter(
          (pixelId) =>
            !winningPartPixelIds.has(pixelId) &&
            evaluated.image.data[pixelId * 4 + 3] !== 0,
        );
        if (restoredPixelIds.length === 0) continue;
        const componentId = restoredCandidateComponentId(candidate.candidateId);
        state = assignSemanticPixelsWithProvenance(
          state,
          {
            target: {
              instanceId: componentId,
              displayName: restorationComponentDisplayName(candidate.kind),
              category: "skin",
            },
            spans: pixelIdsToSpans(
              restoredPixelIds,
              getSkinLayout(composition.armType),
            ),
            provenance: {
              actorType: candidate.kind === "manual_rgba" ? "user" : "system",
              containsGeneratedPixels: candidate.kind === "manual_rgba",
              restoration: {
                kind: "composition_restoration",
                planHash: persistedPlan.summary.planHash,
                candidateIds: [candidate.candidateId],
                sourceRevisionIds: candidate.kind === "manual_rgba"
                  ? []
                  : candidate.sampleRevisionId
                    ? [candidate.sampleRevisionId]
                    : [sourceRevision.id],
                sourceComponentIds: candidate.sourceComponentIds,
              },
            },
          },
          evaluated.image,
        );
        affectedComponents.push(componentId);
        for (const pixelId of restoredPixelIds) affectedPixelIds.add(pixelId);
      }
    }
    for (const layer of layers) {
      const pixelIds = evaluated.winningPixelIdsByLayer[layer.id] ?? [];
      if (pixelIds.length === 0) continue;
      const componentId = composedPartComponentId(layer.id);
      state = applyManualSemanticOperation(
        state,
        {
          type: "assign_pixels",
          target: {
            instanceId: componentId,
            displayName: layer.part.name,
            category: layer.part.category,
            ...(layer.part.subtype ? { subtype: layer.part.subtype } : {}),
          },
          spans: pixelIdsToSpans(pixelIds, getSkinLayout(composition.armType)),
        },
        evaluated.image,
      );
      affectedComponents.push(componentId);
      for (const pixelId of pixelIds) affectedPixelIds.add(pixelId);
    }

    const ids = this.revisionIds();
    state = {
      ...state,
      document: { ...state.document, revisionId: ids.revisionId },
    };
    const createdAt = this.now();
    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const summary = validateText(
      "Revision 摘要",
      input.summary ?? `提交混搭 ${composition.name}`,
      300,
    );
    const resultHash = computeResultHash(skinPng, state.document);
    const metadata = {
      compositionId: composition.id,
      resolutionMode: composition.resolutionMode,
      layers: layers.map((layer) => ({
        layerId: layer.id,
        partId: layer.partId,
        position: layer.position,
      })),
      conflictSummary: compositionConflictSummary(evaluated.report),
      ...(persistedPlan
        ? {
            restoration: {
              version: persistedPlan.summary.version,
              planHash: persistedPlan.summary.planHash,
              candidateSetHash: persistedPlan.summary.candidateSetHash,
              candidateIds: persistedPlan.summary.candidateIds,
              requestedPixelCount: persistedPlan.requestedPixelIds.length,
              coveredPixelCount: persistedPlan.coveredPixelIds.length,
              missingPixelCount: persistedPlan.missingPixelIds.length,
            },
          }
        : {}),
    };
    const operation = createOperation({
      type: "compose",
      inputRevisionId: sourceRevision.id,
      outputRevisionId: ids.revisionId,
      actorType: "user",
      actorId,
      createdAt,
      summary,
      beforeHash: sourceRevision.resultHash,
      afterHash: resultHash,
      affectedComponents,
      affectedSpans: pixelIdsToSpans(
        [...affectedPixelIds],
        getSkinLayout(composition.armType),
      ),
      metadata,
    });
    const snapshot = await this.storage.writeSnapshot({
      projectId: project.id,
      revisionId: ids.revisionId,
      skinPng,
      segmentationJson: canonicalJson(state.document),
      operationJson: canonicalJson(operation),
      additionalFiles: semanticMaskFiles(state),
    });

    try {
      const commit = this.database.transaction(() => {
        const current = this.database
          .prepare(`
            SELECT composition.status, composition.restoration_version,
                   branch.head_revision_id
            FROM composition_project AS composition
            JOIN skin_branch AS branch ON branch.id = composition.branch_id
            WHERE composition.id = ?
          `)
          .get(composition.id) as
          | {
              readonly status: string;
              readonly restoration_version: number;
              readonly head_revision_id: string | null;
            }
          | undefined;
        if (
          current?.status !== "draft" ||
          current.head_revision_id !== sourceRevision.id ||
          current.restoration_version !== composition.restorationVersion
        ) {
          throw conflict("混搭工程或 Branch 已发生变化，请重新载入", {
            compositionId,
          });
        }
        const assetIds = this.insertAssets(
          project.id,
          ids,
          snapshot,
          createdAt,
        );
        this.insertRevision({
          ids,
          projectId: project.id,
          branchId: branch.id,
          parentRevisionId: sourceRevision.id,
          sequence: sourceRevision.sequence + 1,
          operationType: "compose",
          actorType: "user",
          actorId,
          summary,
          sourceHash: sourceRevision.resultHash,
          resultHash,
          createdAt,
          metadata,
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(project.id, ids, "compose", summary, createdAt);
        this.database
          .prepare("UPDATE skin_branch SET head_revision_id = ? WHERE id = ?")
          .run(ids.revisionId, branch.id);
        if (branch.id === project.defaultBranchId) {
          this.database
            .prepare(`
              UPDATE skin_project
              SET head_revision_id = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(ids.revisionId, createdAt, project.id);
        } else {
          this.database
            .prepare("UPDATE skin_project SET updated_at = ? WHERE id = ?")
            .run(createdAt, project.id);
        }
        this.database
          .prepare(`
            UPDATE composition_project
            SET status = 'committed', result_revision_id = ?,
                report_json = ?, updated_at = ?, committed_at = ?
            WHERE id = ? AND status = 'draft' AND restoration_version = ?
          `)
          .run(
            ids.revisionId,
            compactCanonicalJson(evaluated.report),
            createdAt,
            createdAt,
            composition.id,
            composition.restorationVersion,
          );
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(project.id, ids.revisionId);
      throw error;
    }

    return {
      project: this.getProject(project.id),
      branch: this.getBranch(branch.id),
      revision: this.getRevision(ids.revisionId),
      composition: this.getComposition(composition.id),
      report: evaluated.report,
    };
  }

  private requireDraftComposition(compositionId: string): CompositionProject {
    const composition = this.getComposition(compositionId);
    if (composition.status !== "draft") {
      throw conflict("已提交的混搭工程不能继续修改", { compositionId });
    }
    return composition;
  }

  private async evaluateComposition(
    composition: CompositionProject,
    layers: readonly CompositionLayer[],
    persistedPlan: PersistedCompositionRestorationPlan | null =
      this.readPersistedCompositionRestorationPlan(composition.id),
  ): Promise<PixelCompositionResult> {
    const sourceRevision = this.getRevision(composition.baseRevisionId);
    if (sourceRevision.projectId !== composition.projectId) {
      throw snapshotCorrupt(composition.id, "基础 Revision 与 Project 不一致");
    }
    const snapshot = await this.verifyRevisionSnapshot(sourceRevision.id);
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      sourceRevision.id,
    );
    if (segmentation.source.armType !== composition.armType) {
      throw snapshotCorrupt(composition.id, "基础 Revision 手臂模型发生变化");
    }
    const pixelLayers = await Promise.all(
      layers.map(async (layer): Promise<PixelCompositionLayer> => {
        const stored = await this.verifyPartStorage(layer.partId);
        return {
          layerId: layer.id,
          partId: layer.partId,
          position: layer.position,
          texture: decodeSkinPng(stored.files["texture.png"].bytes),
          writeMask: rgbaImageToMask(
            decodeSkinPng(stored.files["write-mask.png"].bytes),
          ),
          manifest: layer.part.manifest,
        };
      }),
    );
    try {
      return composeSkin({
        base: decodeSkinPng(snapshot.files["skin.png"].bytes),
        targetArmType: composition.armType,
        layers: pixelLayers,
        ...(persistedPlan
          ? {
              restorationPlan: materializeCompositionRestorationPlan(persistedPlan),
              restorationAssessment: {
                missingPixelCount: persistedPlan.summary.missingPixelCount,
                issueCount: restorationPlanIssueCount(persistedPlan),
              },
            }
          : {}),
        resolutionMode: composition.resolutionMode,
        conflictWinners: composition.conflictWinners,
      });
    } catch (error) {
      if (error instanceof RevisionStoreError) throw error;
      throw snapshotCorrupt(composition.id, "部件图层或冲突决议无效", {
        cause: error,
      });
    }
  }

  private readPersistedCompositionRestorationPlan(
    compositionId: string,
  ): PersistedCompositionRestorationPlan | null {
    const row = this.database.prepare(`
      SELECT base_revision_id, arm_type, restoration_version, restoration_plan_json
      FROM composition_project
      WHERE id = ?
    `).get(compositionId) as
      | {
          readonly arm_type: string;
          readonly base_revision_id: string;
          readonly restoration_version: number;
          readonly restoration_plan_json: string | null;
        }
      | undefined;
    if (!row) throw notFound("Composition", compositionId);
    if (!isNonNegativeInteger(row.restoration_version)) {
      throw snapshotCorrupt(compositionId, "混搭还原方案版本无效");
    }
    if (!['wide', 'slim'].includes(row.arm_type)) {
      throw snapshotCorrupt(compositionId, "混搭工程手臂模型无效");
    }
    if (row.restoration_plan_json === null) return null;
    const plan = parsePersistedCompositionRestorationPlan(
      row.restoration_plan_json,
      compositionId,
      row.arm_type as "wide" | "slim",
      row.base_revision_id,
    );
    if (plan.summary.version !== row.restoration_version) {
      throw snapshotCorrupt(compositionId, "混搭还原方案版本与工程不一致");
    }
    return plan;
  }

  private compositionRestorationVersion(compositionId: string): number {
    const row = this.database.prepare(`
      SELECT restoration_version FROM composition_project WHERE id = ?
    `).get(compositionId) as { readonly restoration_version: number } | undefined;
    if (!row) throw notFound("Composition", compositionId);
    if (!isNonNegativeInteger(row.restoration_version)) {
      throw snapshotCorrupt(compositionId, "混搭还原方案版本无效");
    }
    return row.restoration_version;
  }

  private async buildCompositionRestorationCandidateSet(
    composition: CompositionProject,
    input: GenerateCompositionRestorationCandidatesInput,
  ): Promise<CoreRestorationCandidateSet> {
    const targetComponentIds = validateUniqueSemanticComponentIds(
      "targetComponentIds",
      input.targetComponentIds,
      256,
    );
    if (targetComponentIds.length === 0) {
      throw invalidInput("targetComponentIds 不能为空");
    }
    const source = await this.restorationSemanticRevision(
      composition.baseRevisionId,
      composition.projectId,
      composition.armType,
    );
    const donorId = input.donorRevisionId;
    const donors = donorId
      ? [await this.restorationSemanticRevision(
          validateReferenceId("donorRevisionId", donorId),
          undefined,
          composition.armType,
        )]
      : undefined;
    const manualColors = input.manualRgba
      ? [[...validateOpaqueRgba("manualRgba", input.manualRgba)] as [number, number, number, number]]
      : undefined;
    try {
      return generateCoreRestorationCandidates({
        source,
        cleanupComponentIds: targetComponentIds,
        ...(donors ? { donors } : {}),
        ...(manualColors ? { manualColors } : {}),
        hashCanonical: sha256,
      });
    } catch (error) {
      if (error instanceof RevisionStoreError) throw error;
      throw invalidInput("无法生成可信还原候选", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async restorationSemanticRevision(
    revisionId: string,
    expectedProjectId: string | undefined,
    expectedArmType: CompositionProject["armType"],
  ): Promise<CoreRestorationSemanticRevision> {
    const revision = this.getRevision(revisionId);
    if (expectedProjectId !== undefined && revision.projectId !== expectedProjectId) {
      throw invalidInput("还原来源 Revision 与混搭 Project 不一致", { revisionId });
    }
    const snapshot = await this.verifyRevisionSnapshot(revision.id);
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      revision.id,
    );
    if (segmentation.source.armType !== expectedArmType) {
      throw invalidInput("还原来源 Revision 手臂模型不兼容", {
        revisionId,
        expectedArmType,
        actualArmType: segmentation.source.armType,
      });
    }
    return {
      revisionId: revision.id,
      image: decodeSkinPng(snapshot.files["skin.png"].bytes),
      semanticState: semanticStateFromSnapshot(snapshot, segmentation, revision.id),
    };
  }

  private insertCompositionRestorationEvent(input: {
    readonly compositionId: string;
    readonly version: number;
    readonly eventType: CompositionRestorationEvent["eventType"];
    readonly candidateSetHash: string | null;
    readonly candidateIds: readonly string[];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  }): void {
    this.database.prepare(`
      INSERT INTO composition_restoration_event (
        composition_id, version, event_type, candidate_set_hash,
        candidate_ids_json, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.compositionId,
      input.version,
      input.eventType,
      input.candidateSetHash,
      compactCanonicalJson(input.candidateIds),
      compactCanonicalJson(input.payload),
      input.createdAt,
    );
  }

  private persistCompositionDraft(
    compositionId: string,
    layers: readonly CompositionLayer[],
    resolutionMode: CompositionProject["resolutionMode"],
    conflictWinners: Readonly<Record<string, string>>,
    report: CompositionReport,
    updatedAt: string,
  ): void {
    const persist = this.database.transaction(() => {
      const current = this.database
        .prepare("SELECT status FROM composition_project WHERE id = ?")
        .get(compositionId) as { readonly status: string } | undefined;
      if (current?.status !== "draft") {
        throw conflict("混搭工程已提交，请重新载入", { compositionId });
      }
      this.database
        .prepare("DELETE FROM composition_layer WHERE composition_id = ?")
        .run(compositionId);
      const insert = this.database.prepare(`
        INSERT INTO composition_layer (
          id, composition_id, part_id, position, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const layer of layers) {
        insert.run(
          layer.id,
          compositionId,
          layer.partId,
          layer.position,
          layer.createdAt,
        );
      }
      this.database
        .prepare(`
          UPDATE composition_project
          SET resolution_mode = ?, conflict_winners_json = ?,
              report_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          resolutionMode,
          compactCanonicalJson(conflictWinners),
          compactCanonicalJson(report),
          updatedAt,
          compositionId,
        );
    });
    persist.immediate();
  }

  private async applyPartUnlocked(
    sourceRevisionId: string,
    input: ApplyPartInput,
  ): Promise<ApplyPartResult> {
    const sourceRevision = this.getRevision(sourceRevisionId);
    const project = this.getProject(sourceRevision.projectId);
    const branch = this.getBranch(input.branchId ?? sourceRevision.branchId);
    if (branch.projectId !== project.id) {
      throw invalidInput("目标 Revision 与 Branch 不属于同一 Project");
    }
    if (branch.headRevisionId !== sourceRevision.id) {
      throw conflict("应用部件只能基于所选 Branch 的最新 Revision", {
        sourceRevisionId,
        branchId: branch.id,
        branchHeadRevisionId: branch.headRevisionId,
      });
    }

    const part = this.getPart(input.partId);
    this.assertActivePart(part, "应用部件");
    const [snapshot, storedPart] = await Promise.all([
      this.verifyRevisionSnapshot(sourceRevision.id),
      this.verifyPartStorage(part.id),
    ]);
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      sourceRevision.id,
    );
    const sourceState = semanticStateFromSnapshot(
      snapshot,
      segmentation,
      sourceRevision.id,
    );
    const sourceImage = decodeSkinPng(snapshot.files["skin.png"].bytes);
    const partTexture = decodeSkinPng(storedPart.files["texture.png"].bytes);
    const writeMask = rgbaImageToMask(
      decodeSkinPng(storedPart.files["write-mask.png"].bytes),
    );
    const report = analyzePartApplication(
      sourceImage,
      partTexture,
      writeMask,
      part.manifest,
      segmentation.source.armType,
    );
    if (report.modelConflict) {
      throw conflict("部件手臂模型与目标 Revision 不兼容", {
        partId: part.id,
        sourceArmType: part.armType,
        targetArmType: segmentation.source.armType,
      });
    }

    const appliedPixelIds = maskToPixelIds(writeMask).filter((pixelId) => {
      if (input.strategy === "use_part") {
        return true;
      }
      return sourceImage.data[pixelId * 4 + 3] === 0;
    });
    if (appliedPixelIds.length === 0) {
      throw invalidInput("所选冲突策略没有可写入像素", {
        partId: part.id,
        strategy: input.strategy,
      });
    }
    const resultImage = applyPartPixels(
      sourceImage,
      partTexture,
      writeMask,
      input.strategy,
    );
    const skinPng = encodeSkinPng(resultImage);
    const rebasedState = rebaseSemanticStateImage({
      state: sourceState,
      sourceImage,
      resultImage,
      sourceHash: sha256(skinPng),
    });
    const affectedSpans = pixelIdsToSpans(
      appliedPixelIds,
      getSkinLayout(segmentation.source.armType),
    );
    const componentId = appliedPartComponentId(part.id);
    const assignedState = applyManualSemanticOperation(
      rebasedState,
      {
        type: "assign_pixels",
        target: {
          instanceId: componentId,
          displayName: part.name,
          category: part.category,
          ...(part.subtype ? { subtype: part.subtype } : {}),
        },
        spans: affectedSpans,
      },
      resultImage,
    );
    const ids = this.revisionIds();
    const createdAt = this.now();
    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const summary = validateText(
      "Revision 摘要",
      input.summary ?? `应用部件 ${part.name}`,
      300,
    );
    const state: SemanticState = {
      ...assignedState,
      document: { ...assignedState.document, revisionId: ids.revisionId },
    };
    const resultHash = computeResultHash(skinPng, state.document);
    const metadata = {
      partId: part.id,
      strategy: input.strategy,
      conflictSummary: {
        hardConflictCount: report.hardConflictCount,
        sameColorOverlapCount: report.sameColorOverlapCount,
        layerConflictCount: report.layerConflictCount,
        unknownConflictCount: report.unknownConflictCount,
      },
    };
    const operation = createOperation({
      type: "apply_part",
      inputRevisionId: sourceRevision.id,
      outputRevisionId: ids.revisionId,
      actorType: "user",
      actorId,
      createdAt,
      summary,
      beforeHash: sourceRevision.resultHash,
      afterHash: resultHash,
      affectedComponents: [componentId],
      affectedSpans,
      metadata,
    });
    const newSnapshot = await this.storage.writeSnapshot({
      projectId: project.id,
      revisionId: ids.revisionId,
      skinPng,
      segmentationJson: canonicalJson(state.document),
      operationJson: canonicalJson(operation),
      additionalFiles: semanticMaskFiles(state),
    });

    try {
      const commit = this.database.transaction(() => {
        const currentBranch = this.database
          .prepare("SELECT head_revision_id FROM skin_branch WHERE id = ?")
          .get(branch.id) as { head_revision_id: string | null } | undefined;
        if (currentBranch?.head_revision_id !== sourceRevision.id) {
          throw conflict("Branch 已产生新的 Revision，请重新载入后再应用部件", {
            branchId: branch.id,
          });
        }
        const assetIds = this.insertAssets(
          project.id,
          ids,
          newSnapshot,
          createdAt,
        );
        this.insertRevision({
          ids,
          projectId: project.id,
          branchId: branch.id,
          parentRevisionId: sourceRevision.id,
          sequence: sourceRevision.sequence + 1,
          operationType: "apply_part",
          actorType: "user",
          actorId,
          summary,
          sourceHash: sourceRevision.resultHash,
          resultHash,
          createdAt,
          metadata,
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(project.id, ids, "apply_part", summary, createdAt);
        this.database
          .prepare("UPDATE skin_branch SET head_revision_id = ? WHERE id = ?")
          .run(ids.revisionId, branch.id);
        if (branch.id === project.defaultBranchId) {
          this.database
            .prepare(`
              UPDATE skin_project
              SET head_revision_id = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(ids.revisionId, createdAt, project.id);
        } else {
          this.database
            .prepare("UPDATE skin_project SET updated_at = ? WHERE id = ?")
            .run(createdAt, project.id);
        }
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(project.id, ids.revisionId);
      throw error;
    }

    return {
      project: this.getProject(project.id),
      branch: this.getBranch(branch.id),
      revision: this.getRevision(ids.revisionId),
      part,
      report,
    };
  }

  private async exportPartUnlocked(
    revisionId: string,
    componentId: string,
    input: ExportPartInput,
  ): Promise<SkinPart> {
    const revision = this.getRevision(revisionId);
    const snapshot = await this.verifyRevisionSnapshot(revision.id);
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      revision.id,
    );
    const state = semanticStateFromSnapshot(snapshot, segmentation, revision.id);
    const component = state.document.components.find(
      (candidate) => candidate.instanceId === componentId,
    );
    if (!component) {
      throw notFound("Component", componentId);
    }
    const name =
      input.name === undefined
        ? component.displayName
        : validateText("部件名称", input.name, 120);
    const partId = this.id("part");
    const createdAt = this.now();
    const image = decodeSkinPng(snapshot.files["skin.png"].bytes);
    const exported = exportSemanticPart({
      id: partId,
      name,
      projectId: revision.projectId,
      revisionId: revision.id,
      armType: segmentation.source.armType,
      createdAt,
      image,
      component,
      componentMask: state.masks[component.instanceId]!,
    });
    const manifestJson = canonicalJson(exported.manifest);
    const sourceJson = canonicalJson({
      schemaVersion: "1.0",
      projectId: revision.projectId,
      revisionId: revision.id,
      componentInstanceId: component.instanceId,
      component,
    });
    const stored = await this.partStorage.writePart({
      partId,
      files: {
        "texture.png": encodeSkinPng(exported.texture),
        "write-mask.png": encodeSkinPng(maskToRgbaImage(exported.writeMask)),
        "manifest.json": Buffer.from(manifestJson, "utf8"),
        "preview.png": encodeSkinPng(exported.preview),
        "source.json": Buffer.from(sourceJson, "utf8"),
      },
    });
    const fileIds = Object.fromEntries(
      PART_FILE_NAMES.map((fileName) => [fileName, this.id("asset")]),
    ) as Record<PartFileName, string>;

    try {
      const commit = this.database.transaction(() => {
        const insertFile = this.database.prepare(`
          INSERT INTO part_file_asset (
            id, part_id, file_role, storage_path, mime_type,
            byte_size, sha256, created_at
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
        `);
        const roles: Readonly<Record<PartFileName, string>> = {
          "texture.png": "texture",
          "write-mask.png": "write_mask",
          "manifest.json": "manifest",
          "preview.png": "preview",
          "source.json": "source",
        };
        for (const fileName of PART_FILE_NAMES) {
          const file = stored.files[fileName];
          insertFile.run(
            fileIds[fileName],
            roles[fileName],
            file.storagePath,
            fileName.endsWith(".png") ? "image/png" : "application/json",
            file.bytes.byteLength,
            file.sha256,
            createdAt,
          );
        }
        this.database
          .prepare(`
            INSERT INTO part_asset (
              id, source_project_id, source_revision_id, source_component_id,
              name, category, subtype, arm_type, texture_asset_id,
              mask_asset_id, manifest_asset_id, preview_asset_id,
              source_asset_id, created_at, manifest_json, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            partId,
            revision.projectId,
            revision.id,
            component.instanceId,
            exported.manifest.name,
            exported.manifest.category,
            exported.manifest.subtype ?? null,
            segmentation.source.armType,
            fileIds["texture.png"],
            fileIds["write-mask.png"],
            fileIds["manifest.json"],
            fileIds["preview.png"],
            fileIds["source.json"],
            createdAt,
            manifestJson.trim(),
            canonicalJson({ maskMode: exported.manifest.maskMode }).trim(),
          );
        const attach = this.database.prepare(
          "UPDATE part_file_asset SET part_id = ? WHERE id = ?",
        );
        for (const fileName of PART_FILE_NAMES) {
          attach.run(partId, fileIds[fileName]);
        }
      });
      commit.immediate();
    } catch (error) {
      await this.partStorage.removeNewPart(partId);
      throw error;
    }
    return this.getPart(partId);
  }

  private async createPartEditProjectUnlocked(
    input: CreatePartEditProjectInput,
  ): Promise<PartEditDetail> {
    const basePart = this.getPart(input.basePartId);
    this.assertActivePart(basePart, "创建部件修补工程");
    const projectId = this.id("part_edit");
    const revisionId = this.id("part_edit_revision");
    const createdAt = this.now();
    const name = validateText(
      "部件修补工程名称",
      input.name ?? `${basePart.name} 修补`,
      120,
    );
    const storedPart = await this.verifyPartStorage(basePart.id);
    const texturePng = storedPart.files["texture.png"].bytes.slice();
    const maskPng = storedPart.files["write-mask.png"].bytes.slice();
    const operation = {
      type: "init",
      basePartId: basePart.id,
    } as const;
    const provenance = {
      source: "manual",
      basePartId: basePart.id,
      authoredOperations: 0,
      containsGeneratedPixels: false,
    } as const;
    const stored = await this.writePartEditRevisionFiles({
      projectId,
      revisionId,
      parentRevisionId: null,
      sequence: 1,
      operation,
      summary: "从不可变部件创建修补草稿",
      actorId: undefined,
      changedPixelCount: 0,
      provenance,
      createdAt,
      texturePng,
      maskPng,
    });
    try {
      const commit = this.database.transaction(() => {
        this.database
          .prepare(`
            INSERT INTO part_edit_project (
              id, base_part_id, name, status, head_revision_id, result_part_id,
              created_at, updated_at, committed_at
            ) VALUES (?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)
          `)
          .run(projectId, basePart.id, name, createdAt, createdAt);
        this.insertPartEditRevision({
          projectId,
          revisionId,
          parentRevisionId: null,
          sequence: 1,
          operation,
          summary: "从不可变部件创建修补草稿",
          actorId: undefined,
          changedPixelCount: 0,
          provenance,
          createdAt,
          stored,
        });
        this.database
          .prepare(
            "UPDATE part_edit_project SET head_revision_id = ? WHERE id = ?",
          )
          .run(revisionId, projectId);
      });
      commit.immediate();
    } catch (error) {
      await this.partEditStorage.removeNewRevision(projectId, revisionId);
      throw error;
    }
    return this.getPartEditDetail(projectId);
  }

  private async applyPartEditOperationUnlocked(
    projectId: string,
    input: ApplyPartEditOperationInput,
  ): Promise<PartEditDetail> {
    const project = this.getPartEditProject(projectId);
    if (project.status !== "draft") {
      throw conflict("已提交的部件修补工程不能继续编辑", { projectId });
    }
    if (project.headRevisionId !== input.headRevisionId) {
      throw conflict("部件修补操作必须基于当前 HEAD", {
        projectId,
        suppliedHeadRevisionId: input.headRevisionId,
        projectHeadRevisionId: project.headRevisionId,
      });
    }
    const head = this.getPartEditRevision(project.headRevisionId);
    const basePart = this.getPart(project.basePartId);
    this.assertActivePart(basePart, "继续部件修补");
    const state = await this.readPartEditState(head.id);
    const operation = await this.resolvePartRepairOperation(
      project.id,
      input.operation,
    );
    let result: ReturnType<typeof applyPartRepairOperation>;
    try {
      result = applyPartRepairOperation(state, operation);
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw invalidInput(error.message);
      }
      throw error;
    }
    const revisionId = this.id("part_edit_revision");
    const sequence = head.sequence + 1;
    const createdAt = this.now();
    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const summary = validateText(
      "修补 Revision 摘要",
      input.summary ?? partEditOperationSummary(input.operation.type),
      300,
    );
    const provenance = {
      source: "manual",
      basePartId: basePart.id,
      parentRevisionId: head.id,
      authoredOperations: sequence - 1,
      containsGeneratedPixels: false,
      changedPixelIds: result.changedPixelIds,
      operation: input.operation,
    } as const;
    const stored = await this.writePartEditRevisionFiles({
      projectId,
      revisionId,
      parentRevisionId: head.id,
      sequence,
      operation: input.operation,
      summary,
      actorId,
      changedPixelCount: result.changedPixelIds.length,
      provenance,
      createdAt,
      texturePng: encodeSkinPng(result.texture),
      maskPng: encodeSkinPng(maskToRgbaImage(result.writeMask)),
    });
    try {
      const commit = this.database.transaction(() => {
        const fresh = this.database
          .prepare("SELECT status, head_revision_id FROM part_edit_project WHERE id = ?")
          .get(project.id) as
          | { readonly status: string; readonly head_revision_id: string | null }
          | undefined;
        if (fresh?.status !== "draft" || fresh.head_revision_id !== head.id) {
          throw conflict("部件修补 HEAD 已变更", {
            projectId,
            suppliedHeadRevisionId: head.id,
            projectHeadRevisionId: fresh?.head_revision_id ?? null,
          });
        }
        this.insertPartEditRevision({
          projectId,
          revisionId,
          parentRevisionId: head.id,
          sequence,
          operation: input.operation,
          summary,
          actorId,
          changedPixelCount: result.changedPixelIds.length,
          provenance,
          createdAt,
          stored,
        });
        this.database
          .prepare(`
            UPDATE part_edit_project
            SET head_revision_id = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(revisionId, createdAt, project.id);
      });
      commit.immediate();
    } catch (error) {
      await this.partEditStorage.removeNewRevision(project.id, revisionId);
      throw error;
    }
    return this.getPartEditDetail(project.id);
  }

  private async commitPartEditProjectUnlocked(
    projectId: string,
    input: CommitPartEditProjectInput,
  ): Promise<CommitPartEditProjectResult> {
    const project = this.getPartEditProject(projectId);
    if (project.status !== "draft") {
      throw conflict("部件修补工程已提交", {
        projectId,
        resultPartId: project.resultPartId,
      });
    }
    if (project.headRevisionId !== input.headRevisionId) {
      throw conflict("提交必须基于当前部件修补 HEAD", {
        projectId,
        suppliedHeadRevisionId: input.headRevisionId,
        projectHeadRevisionId: project.headRevisionId,
      });
    }
    const head = this.getPartEditRevision(project.headRevisionId);
    const basePart = this.getPart(project.basePartId);
    this.assertActivePart(basePart, "提交部件修补");
    const storedEdit = await this.verifyPartEditStorage(head.id);
    const state = await this.readPartEditState(head.id);
    if (maskToPixelIds(state.writeMask).length === 0) {
      throw invalidInput("空的修补部件不能提交", {
        projectId,
        headRevisionId: head.id,
      });
    }
    const createdAt = this.now();
    const name = validateText(
      "修补部件名称",
      input.name ?? `${basePart.name} 修补`,
      120,
    );
    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const summary = validateText(
      "修补提交摘要",
      input.summary ?? `由修补工程 ${project.name} 创建新部件`,
      300,
    );
    const partId = this.id("part");
    const derivation = {
      kind: "part_repair",
      basePartId: basePart.id,
      partEditProjectId: project.id,
      partEditRevisionId: head.id,
      containsGeneratedPixels: false,
    } as const;
    const manifest: PartManifest = {
      ...basePart.manifest,
      schemaVersion: "1.1",
      id: partId,
      name,
      palette: { dominant: dominantHex(state.texture, state.writeMask) },
      derivation,
      createdAt,
    };
    const manifestJson = canonicalJson(manifest);
    const provenance = {
      schemaVersion: "1.1",
      ...derivation,
      actorId: actorId ?? null,
      summary,
    } as const;
    const sourceJson = canonicalJson(provenance);
    const storedPart = await this.partStorage.writePart({
      partId,
      files: {
        "texture.png": storedEdit.files["texture.png"].bytes.slice(),
        "write-mask.png": storedEdit.files["write-mask.png"].bytes.slice(),
        "manifest.json": Buffer.from(manifestJson, "utf8"),
        "preview.png": encodeSkinPng(state.texture),
        "source.json": Buffer.from(sourceJson, "utf8"),
      },
    });
    const fileIds = Object.fromEntries(
      PART_FILE_NAMES.map((fileName) => [fileName, this.id("asset")]),
    ) as Record<PartFileName, string>;
    try {
      const commit = this.database.transaction(() => {
        const fresh = this.database
          .prepare("SELECT status, head_revision_id FROM part_edit_project WHERE id = ?")
          .get(project.id) as
          | { readonly status: string; readonly head_revision_id: string | null }
          | undefined;
        if (fresh?.status !== "draft" || fresh.head_revision_id !== head.id) {
          throw conflict("部件修补 HEAD 已变更", {
            projectId,
            suppliedHeadRevisionId: head.id,
            projectHeadRevisionId: fresh?.head_revision_id ?? null,
          });
        }
        this.insertRepairedPart({
          partId,
          basePart,
          manifest,
          provenance,
          createdAt,
          stored: storedPart,
          fileIds,
        });
        this.database
          .prepare(`
            UPDATE part_edit_project
            SET status = 'committed', result_part_id = ?, updated_at = ?, committed_at = ?
            WHERE id = ?
          `)
          .run(partId, createdAt, createdAt, project.id);
      });
      commit.immediate();
    } catch (error) {
      await this.partStorage.removeNewPart(partId);
      throw error;
    }
    return {
      project: this.getPartEditProject(project.id),
      revision: this.getPartEditRevision(head.id),
      part: this.getPart(partId),
    };
  }

  private async resolvePartRepairOperation(
    targetProjectId: string,
    operation: SerializedPartRepairOperation,
  ): Promise<PartRepairOperation> {
    if (operation.type !== "copy_surfaces") return operation;
    let source: PartRepairState;
    if (operation.source.kind === "part") {
      const part = this.getPart(operation.source.partId);
      this.assertActivePart(part, "复制部件表面");
      const stored = await this.verifyPartStorage(part.id);
      source = {
        armType: part.armType,
        texture: decodeSkinPng(stored.files["texture.png"].bytes),
        writeMask: rgbaImageToMask(
          decodeSkinPng(stored.files["write-mask.png"].bytes),
        ),
      };
    } else {
      const sourceRevision = this.getPartEditRevision(
        operation.source.revisionId,
      );
      if (sourceRevision.projectId !== targetProjectId) {
        throw invalidInput(
          "只能从同一部件修补工程的当前或历史 Revision 复制表面",
          {
            targetProjectId,
            sourceRevisionId: sourceRevision.id,
            sourceProjectId: sourceRevision.projectId,
          },
        );
      }
      source = await this.readPartEditState(sourceRevision.id);
    }
    return {
      type: "copy_surfaces",
      source,
      mappings: operation.mappings,
      ...(operation.overwrite ? { overwrite: operation.overwrite } : {}),
    };
  }

  private async readPartEditState(
    revisionId: string,
  ): Promise<PartRepairState> {
    const revision = this.getPartEditRevision(revisionId);
    const project = this.getPartEditProject(revision.projectId);
    const basePart = this.getPart(project.basePartId);
    const stored = await this.verifyPartEditStorage(revision.id);
    return {
      armType: basePart.armType,
      texture: decodeSkinPng(stored.files["texture.png"].bytes),
      writeMask: rgbaImageToMask(
        decodeSkinPng(stored.files["write-mask.png"].bytes),
      ),
    };
  }

  private async writePartEditRevisionFiles(input: {
    readonly projectId: string;
    readonly revisionId: string;
    readonly parentRevisionId: string | null;
    readonly sequence: number;
    readonly operation: Readonly<Record<string, unknown>>;
    readonly summary: string;
    readonly actorId: string | undefined;
    readonly changedPixelCount: number;
    readonly provenance: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly texturePng: Uint8Array;
    readonly maskPng: Uint8Array;
  }): Promise<VerifiedPartEditStorage> {
    const document = {
      schemaVersion: "1.0",
      id: input.revisionId,
      projectId: input.projectId,
      parentRevisionId: input.parentRevisionId,
      sequence: input.sequence,
      operation: input.operation,
      summary: input.summary,
      actorId: input.actorId ?? null,
      changedPixelCount: input.changedPixelCount,
      authoredProvenance: input.provenance,
      createdAt: input.createdAt,
    } as const;
    return this.partEditStorage.writeRevision({
      projectId: input.projectId,
      revisionId: input.revisionId,
      files: {
        "texture.png": input.texturePng,
        "write-mask.png": input.maskPng,
        "revision.json": Buffer.from(canonicalJson(document), "utf8"),
      },
    });
  }

  private insertPartEditRevision(input: {
    readonly projectId: string;
    readonly revisionId: string;
    readonly parentRevisionId: string | null;
    readonly sequence: number;
    readonly operation: Readonly<Record<string, unknown>>;
    readonly summary: string;
    readonly actorId: string | undefined;
    readonly changedPixelCount: number;
    readonly provenance: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly stored: VerifiedPartEditStorage;
  }): void {
    const texture = input.stored.files["texture.png"];
    const mask = input.stored.files["write-mask.png"];
    const revisionFile = input.stored.files["revision.json"];
    const operationType = input.operation.type;
    if (!isPartEditOperationType(operationType)) {
      throw invalidInput("未知部件修补操作", { operationType });
    }
    this.database
      .prepare(`
        INSERT INTO part_edit_revision (
          id, project_id, parent_revision_id, sequence, operation_type,
          operation_json, summary, actor_id,
          texture_storage_path, texture_byte_size, texture_sha256,
          mask_storage_path, mask_byte_size, mask_sha256,
          revision_storage_path, revision_byte_size, revision_sha256,
          changed_pixel_count, authored_provenance_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.revisionId,
        input.projectId,
        input.parentRevisionId,
        input.sequence,
        operationType,
        compactCanonicalJson(input.operation),
        input.summary,
        input.actorId ?? null,
        texture.storagePath,
        texture.bytes.byteLength,
        texture.sha256,
        mask.storagePath,
        mask.bytes.byteLength,
        mask.sha256,
        revisionFile.storagePath,
        revisionFile.bytes.byteLength,
        revisionFile.sha256,
        input.changedPixelCount,
        compactCanonicalJson(input.provenance),
        input.createdAt,
      );
  }

  private insertRepairedPart(input: {
    readonly partId: string;
    readonly basePart: SkinPart;
    readonly manifest: PartManifest;
    readonly provenance: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly stored: VerifiedPartStorage;
    readonly fileIds: Record<PartFileName, string>;
  }): void {
    const roles: Readonly<Record<PartFileName, string>> = {
      "texture.png": "texture",
      "write-mask.png": "write_mask",
      "manifest.json": "manifest",
      "preview.png": "preview",
      "source.json": "source",
    };
    const insertFile = this.database.prepare(`
      INSERT INTO part_file_asset (
        id, part_id, file_role, storage_path, mime_type, byte_size, sha256, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
    `);
    for (const fileName of PART_FILE_NAMES) {
      const file = input.stored.files[fileName];
      insertFile.run(
        input.fileIds[fileName],
        roles[fileName],
        file.storagePath,
        fileName.endsWith(".png") ? "image/png" : "application/json",
        file.bytes.byteLength,
        file.sha256,
        input.createdAt,
      );
    }
    this.database
      .prepare(`
        INSERT INTO part_asset (
          id, source_project_id, source_revision_id, source_component_id,
          name, category, subtype, arm_type, texture_asset_id, mask_asset_id,
          manifest_asset_id, preview_asset_id, source_asset_id, created_at,
          manifest_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.partId,
        input.basePart.sourceProjectId,
        input.basePart.sourceRevisionId,
        input.basePart.sourceComponentId,
        input.manifest.name,
        input.manifest.category,
        input.manifest.subtype ?? null,
        input.basePart.armType,
        input.fileIds["texture.png"],
        input.fileIds["write-mask.png"],
        input.fileIds["manifest.json"],
        input.fileIds["preview.png"],
        input.fileIds["source.json"],
        input.createdAt,
        canonicalJson(input.manifest).trim(),
        compactCanonicalJson({
          maskMode: input.manifest.maskMode,
          ancestry: input.provenance,
        }),
      );
    const attach = this.database.prepare(
      "UPDATE part_file_asset SET part_id = ? WHERE id = ?",
    );
    for (const fileName of PART_FILE_NAMES) {
      attach.run(input.partId, input.fileIds[fileName]);
    }
  }

  private async exportPartBundleUnlocked(
    revisionId: string,
    input: ExportPartBundleInput,
  ): Promise<PartBundle> {
    if (!isAggregateKind(input.kind)) {
      throw invalidInput(`未知部件集分类：${String(input.kind)}`);
    }
    const componentIds = [...new Set(input.componentIds)];
    if (componentIds.length === 0 || componentIds.length !== input.componentIds.length) {
      throw invalidInput("部件集必须包含至少一个不重复的组件");
    }
    const revision = this.getRevision(revisionId);
    const snapshot = await this.verifyRevisionSnapshot(revision.id);
    const segmentation = parseSegmentation(
      snapshot.files["segmentation.json"].bytes,
      revision.id,
    );
    const state = semanticStateFromSnapshot(snapshot, segmentation, revision.id);
    const components = componentIds.map((componentId) => {
      const component = state.document.components.find(
        (candidate) => candidate.instanceId === componentId,
      );
      if (!component) throw notFound("Component", componentId);
      if (aggregateKindForCategory(component.category) !== input.kind) {
        throw invalidInput(`组件 ${componentId} 不属于 ${input.kind} 大类`);
      }
      if (
        input.sourceGroupKey !== undefined &&
        component.relations.sameOutfitGroup !== input.sourceGroupKey
      ) {
        throw invalidInput(`组件 ${componentId} 不属于指定的语义分组`);
      }
      return component;
    });
    const name = validateText(
      "部件集名称",
      input.name ?? defaultBundleName(input.kind),
      120,
    );
    const sourceGroupKey = validateOptionalText(
      "来源语义分组",
      input.sourceGroupKey,
      100,
    );
    const bundleId = this.id("part_bundle");
    const createdAt = this.now();
    const image = decodeSkinPng(snapshot.files["skin.png"].bytes);
    type PreparedBundleMember = {
      readonly component: (typeof components)[number];
      readonly position: number;
      readonly partId: string;
      readonly exported: ReturnType<typeof exportSemanticPart>;
    };
    const prepared: PreparedBundleMember[] = components.map((component, position) => {
      const partId = this.id("part");
      const exported = exportSemanticPart({
        id: partId,
        name: component.displayName,
        projectId: revision.projectId,
        revisionId: revision.id,
        armType: segmentation.source.armType,
        createdAt,
        image,
        component,
        componentMask: state.masks[component.instanceId]!,
      });
      return { component, position, partId, exported };
    });
    const storedParts: Array<{
      readonly prepared: Extract<PreparedBundleMember, { readonly exported: unknown }>;
      readonly stored: VerifiedPartStorage;
      readonly fileIds: Record<PartFileName, string>;
    }> = [];
    try {
      for (const item of prepared) {
        const exported = item.exported;
        const sourceJson = canonicalJson({
          schemaVersion: "1.0",
          projectId: revision.projectId,
          revisionId: revision.id,
          componentInstanceId: item.component.instanceId,
          component: item.component,
        });
        const stored = await this.partStorage.writePart({
          partId: item.partId,
          files: {
            "texture.png": encodeSkinPng(exported.texture),
            "write-mask.png": encodeSkinPng(maskToRgbaImage(exported.writeMask)),
            "manifest.json": Buffer.from(canonicalJson(exported.manifest), "utf8"),
            "preview.png": encodeSkinPng(exported.preview),
            "source.json": Buffer.from(sourceJson, "utf8"),
          },
        });
        storedParts.push({
          prepared: item,
          stored,
          fileIds: Object.fromEntries(
            PART_FILE_NAMES.map((fileName) => [fileName, this.id("asset")]),
          ) as Record<PartFileName, string>,
        });
      }

      const armTypes = intersectArmTypes(
        prepared.map((item) => item.exported.manifest.compatibility.armTypes),
      );
      if (armTypes.length === 0) {
        throw invalidInput("部件集成员没有共同兼容的手臂模型");
      }
      const commit = this.database.transaction(() => {
        for (const item of storedParts) this.insertPreparedPart(item, revision, createdAt);
        this.database
          .prepare(`
            INSERT INTO part_bundle (
              id, source_project_id, source_revision_id, name, kind,
              source_group_key, arm_types_json, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            bundleId,
            revision.projectId,
            revision.id,
            name,
            input.kind,
            sourceGroupKey ?? null,
            compactCanonicalJson(armTypes),
            createdAt,
            compactCanonicalJson({ componentIds }),
          );
        const insertMember = this.database.prepare(`
          INSERT INTO part_bundle_member (bundle_id, part_id, position, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const item of prepared) {
          insertMember.run(bundleId, item.partId, item.position, createdAt);
        }
      });
      commit.immediate();
    } catch (error) {
      await Promise.all(
        storedParts.map((item) => this.partStorage.removeNewPart(item.prepared.partId)),
      );
      throw error;
    }
    return this.getPartBundle(bundleId);
  }

  private async revisePartBundleUnlocked(
    bundleId: string,
    input: RevisePartBundleInput,
  ): Promise<RevisePartBundleResult> {
    const source = this.getPartBundle(bundleId);
    this.assertActiveBundle(source, "修订部件集");
    if (!Array.isArray(input.replacements) || input.replacements.length === 0) {
      throw invalidInput("部件集修订至少需要一个成员替换");
    }
    const oldIds = input.replacements.map((item) => item.memberPartId);
    const replacementIds = input.replacements.map((item) => item.replacementPartId);
    if (new Set(oldIds).size !== oldIds.length || new Set(replacementIds).size !== replacementIds.length) {
      throw invalidInput("修订项中的原成员和替换部件均不能重复");
    }
    const membersById = new Map(source.members.map((member) => [member.partId, member]));
    for (const memberPartId of oldIds) {
      if (!membersById.has(memberPartId)) {
        throw invalidInput("修订的原部件不是该部件集成员", { bundleId, memberPartId });
      }
    }
    const replacements = new Map<string, SkinPart>();
    for (const item of input.replacements) {
      const part = this.getPart(item.replacementPartId);
      this.assertActivePart(part, "修订部件集");
      if (
        part.sourceProjectId !== source.sourceProjectId ||
        part.sourceRevisionId !== source.sourceRevisionId
      ) {
        throw invalidInput("替换部件必须与原部件集来自同一 Project/Revision", {
          bundleId,
          replacementPartId: part.id,
        });
      }
      if (aggregateKindForCategory(part.category) !== source.kind) {
        throw invalidInput("替换部件与原部件集大类不一致", {
          bundleId,
          replacementPartId: part.id,
          kind: source.kind,
        });
      }
      replacements.set(item.memberPartId, part);
    }
    const resultingParts = source.members.map(
      (member) => replacements.get(member.partId) ?? member.part,
    );
    const resultingIds = resultingParts.map((part) => part.id);
    if (new Set(resultingIds).size !== resultingIds.length) {
      throw invalidInput("修订后的部件集不能包含重复部件", { bundleId });
    }
    const armTypes = intersectArmTypes(
      resultingParts.map((part) => part.manifest.compatibility.armTypes),
    );
    if (armTypes.length === 0) {
      throw invalidInput("修订后的部件集成员没有共同兼容模型");
    }
    await Promise.all(resultingParts.map((part) => this.verifyPartStorage(part.id)));
    await this.validateBundleMemberPixels(resultingParts, source.id, "proposal");
    const revisedBundleId = this.id("part_bundle");
    const createdAt = this.now();
    const name = validateText("部件集名称", input.name ?? source.name, 120);
    const reason = validateRetireReason(input.reason) ?? `由 ${revisedBundleId} 替代`;
    const revise = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO part_bundle (
          id, source_project_id, source_revision_id, name, kind,
          source_group_key, arm_types_json, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisedBundleId,
        source.sourceProjectId,
        source.sourceRevisionId,
        name,
        source.kind,
        source.sourceGroupKey,
        compactCanonicalJson(armTypes),
        createdAt,
        compactCanonicalJson({
          ...source.metadata,
          revisionOfBundleId: source.id,
          replacements: input.replacements,
          reason,
        }),
      );
      const insertMember = this.database.prepare(`
        INSERT INTO part_bundle_member (bundle_id, part_id, position, created_at)
        VALUES (?, ?, ?, ?)
      `);
      resultingParts.forEach((part, position) =>
        insertMember.run(revisedBundleId, part.id, position, createdAt),
      );
      this.database.prepare(`
        UPDATE part_bundle SET library_status = 'retired', retired_at = ?, retired_reason = ?
        WHERE id = ? AND library_status = 'active'
      `).run(createdAt, reason, source.id);
    });
    revise.immediate();
    return {
      bundle: this.getPartBundle(revisedBundleId),
      retiredBundle: this.getPartBundle(source.id),
    };
  }

  private insertPreparedPart(
    item: {
      readonly prepared: {
        readonly partId: string;
        readonly component: SegmentationDocument["components"][number];
        readonly exported: ReturnType<typeof exportSemanticPart>;
      };
      readonly stored: VerifiedPartStorage;
      readonly fileIds: Record<PartFileName, string>;
    },
    revision: SkinRevision,
    createdAt: string,
  ): void {
    const insertFile = this.database.prepare(`
      INSERT INTO part_file_asset (
        id, part_id, file_role, storage_path, mime_type, byte_size, sha256, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
    `);
    const roles: Readonly<Record<PartFileName, string>> = {
      "texture.png": "texture",
      "write-mask.png": "write_mask",
      "manifest.json": "manifest",
      "preview.png": "preview",
      "source.json": "source",
    };
    for (const fileName of PART_FILE_NAMES) {
      const file = item.stored.files[fileName];
      insertFile.run(
        item.fileIds[fileName],
        roles[fileName],
        file.storagePath,
        fileName.endsWith(".png") ? "image/png" : "application/json",
        file.bytes.byteLength,
        file.sha256,
        createdAt,
      );
    }
    const manifest = item.prepared.exported.manifest;
    this.database
      .prepare(`
        INSERT INTO part_asset (
          id, source_project_id, source_revision_id, source_component_id,
          name, category, subtype, arm_type, texture_asset_id, mask_asset_id,
          manifest_asset_id, preview_asset_id, source_asset_id, created_at,
          manifest_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.prepared.partId,
        revision.projectId,
        revision.id,
        item.prepared.component.instanceId,
        manifest.name,
        manifest.category,
        manifest.subtype ?? null,
        manifest.compatibility.armTypes.length === 1
          ? manifest.compatibility.armTypes[0]
          : "slim",
        item.fileIds["texture.png"],
        item.fileIds["write-mask.png"],
        item.fileIds["manifest.json"],
        item.fileIds["preview.png"],
        item.fileIds["source.json"],
        createdAt,
        canonicalJson(manifest).trim(),
        compactCanonicalJson({ maskMode: manifest.maskMode }),
      );
    const attach = this.database.prepare(
      "UPDATE part_file_asset SET part_id = ? WHERE id = ?",
    );
    for (const fileName of PART_FILE_NAMES) {
      attach.run(item.prepared.partId, item.fileIds[fileName]);
    }
  }

  private async applyManualOperationUnlocked(
    sourceRevisionId: string,
    input: ManualRevisionOperationInput,
  ): Promise<RevisionMutationResult> {
    const sourceRevision = this.getRevision(sourceRevisionId);
    const project = this.getProject(sourceRevision.projectId);
    const branch = this.getBranch(input.branchId ?? sourceRevision.branchId);
    if (branch.projectId !== project.id) {
      throw invalidInput("目标 Revision 与 Branch 不属于同一 Project");
    }
    if (branch.headRevisionId !== sourceRevision.id) {
      throw conflict("人工编辑只能基于所选 Branch 的最新 Revision", {
        sourceRevisionId,
        branchId: branch.id,
        branchHeadRevisionId: branch.headRevisionId,
      });
    }

    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const semanticFollowup = input.semanticFollowup
      ? validateSemanticFollowupRevisionContext(input.semanticFollowup)
      : null;
    if (
      semanticFollowup &&
      (
        actorId !== "semantic-followup" ||
        input.operation.type !== "assign_pixels" ||
        input.operation.target.category !== "hair"
      )
    ) {
      throw invalidInput("语义分类修复必须使用专用 actor 将像素分配给头发组件");
    }
    if (semanticFollowup && input.operation.type === "assign_pixels") {
      this.assertSemanticFollowupOperation(semanticFollowup, input.operation);
    }

    const sourceSnapshot = await this.verifyRevisionSnapshot(sourceRevision.id);
    const sourceSegmentation = parseSegmentation(
      sourceSnapshot.files["segmentation.json"].bytes,
      sourceRevision.id,
    );
    const sourceState = semanticStateFromSnapshot(
      sourceSnapshot,
      sourceSegmentation,
      sourceRevision.id,
    );
    const image = decodeSkinPng(sourceSnapshot.files["skin.png"].bytes);
    let editedState: SemanticState;
    try {
      editedState = applyManualSemanticOperation(
        sourceState,
        input.operation,
        image,
      );
    } catch (error) {
      if (error instanceof SemanticEditError || error instanceof RangeError) {
        throw invalidInput(error.message, {
          ...(error instanceof SemanticEditError
            ? { semanticCode: error.code }
            : {}),
        });
      }
      throw error;
    }

    const ids = this.revisionIds();
    const createdAt = this.now();
    const operationType = manualRevisionOperationType(input.operation.type);
    const summary = validateText(
      "Revision 摘要",
      input.summary ?? manualOperationSummary(input.operation.type),
      300,
    );
    const state: SemanticState = {
      ...editedState,
      document: { ...editedState.document, revisionId: ids.revisionId },
    };
    const segmentation = state.document;
    const skinPng = sourceSnapshot.files["skin.png"].bytes;
    const resultHash = computeResultHash(skinPng, segmentation);
    const affectedComponents = manualAffectedComponents(input.operation);
    const affectedSpans =
      "spans" in input.operation ? input.operation.spans : [];
    const metadata = {
      operation: input.operation,
      ...(semanticFollowup ? { semanticFollowup } : {}),
    };
    const operation = createOperation({
      type: operationType,
      inputRevisionId: sourceRevision.id,
      outputRevisionId: ids.revisionId,
      actorType: "user",
      actorId,
      createdAt,
      summary,
      beforeHash: sourceRevision.resultHash,
      afterHash: resultHash,
      affectedComponents,
      affectedSpans,
      metadata,
    });
    const snapshot = await this.storage.writeSnapshot({
      projectId: project.id,
      revisionId: ids.revisionId,
      skinPng,
      segmentationJson: canonicalJson(segmentation),
      operationJson: canonicalJson(operation),
      additionalFiles: semanticMaskFiles(state),
    });

    try {
      const commit = this.database.transaction(() => {
        const currentBranch = this.database
          .prepare("SELECT head_revision_id FROM skin_branch WHERE id = ?")
          .get(branch.id) as { head_revision_id: string | null } | undefined;
        if (currentBranch?.head_revision_id !== sourceRevision.id) {
          throw conflict("Branch 已产生新的 Revision，请重新载入后再编辑", {
            branchId: branch.id,
          });
        }
        const assetIds = this.insertAssets(project.id, ids, snapshot, createdAt);
        this.insertRevision({
          ids,
          projectId: project.id,
          branchId: branch.id,
          parentRevisionId: sourceRevision.id,
          sequence: sourceRevision.sequence + 1,
          operationType,
          actorType: "user",
          actorId,
          summary,
          sourceHash: sourceRevision.resultHash,
          resultHash,
          createdAt,
          metadata,
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(project.id, ids, operationType, summary, createdAt);
        if (semanticFollowup) {
          const transition = this.database.prepare(`
            UPDATE semantic_analysis_followup
            SET status = 'applied', applied_revision_id = ?, updated_at = ?
            WHERE job_id = ?
              AND result_revision_id = ?
              AND status = 'awaiting_review'
              AND evidence_hash = ?
              AND EXISTS (
                SELECT 1
                FROM json_each(assessment_json, '$.suggestions') AS suggestion
                WHERE json_extract(suggestion.value, '$.id') = ?
              )
          `).run(
            ids.revisionId,
            createdAt,
            semanticFollowup.jobId,
            semanticFollowup.resultRevisionId,
            semanticFollowup.evidenceHash,
            semanticFollowup.suggestionId,
          );
          if (transition.changes !== 1) {
            throw conflict("语义分类修复已被处理或证据已经变化", {
              jobId: semanticFollowup.jobId,
              suggestionId: semanticFollowup.suggestionId,
            });
          }
        }
        this.database
          .prepare("UPDATE skin_branch SET head_revision_id = ? WHERE id = ?")
          .run(ids.revisionId, branch.id);
        if (branch.id === project.defaultBranchId) {
          this.database
            .prepare(`
              UPDATE skin_project
              SET head_revision_id = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(ids.revisionId, createdAt, project.id);
        } else {
          this.database
            .prepare("UPDATE skin_project SET updated_at = ? WHERE id = ?")
            .run(createdAt, project.id);
        }
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(project.id, ids.revisionId);
      throw error;
    }

    return {
      project: this.getProject(project.id),
      branch: this.getBranch(branch.id),
      revision: this.getRevision(ids.revisionId),
    };
  }

  private async commitAiSegmentationUnlocked(
    sourceRevisionId: string,
    input: AiSegmentationRevisionInput,
  ): Promise<RevisionMutationResult> {
    const sourceRevision = this.getRevision(sourceRevisionId);
    const project = this.getProject(sourceRevision.projectId);
    const branch = this.getBranch(sourceRevision.branchId);
    if (branch.headRevisionId !== sourceRevision.id) {
      throw conflict("AI 提案只能提交到分析时的 Branch HEAD", {
        sourceRevisionId,
        branchId: branch.id,
        branchHeadRevisionId: branch.headRevisionId,
      });
    }
    assertSafeReferenceId("aiJobId", input.aiJobId);
    assertSafeReferenceId("aiRunId", input.aiRunId);
    const provider = validateText("AI Provider", input.provider, 80);
    const model = validateText("AI Model", input.model, 120);
    const proposalSummary = validateText(
      "AI 提案摘要",
      input.proposalSummary,
      500,
    );

    const sourceSnapshot = await this.verifyRevisionSnapshot(sourceRevision.id);
    const sourceSegmentation = parseSegmentation(
      sourceSnapshot.files["segmentation.json"].bytes,
      sourceRevision.id,
    );
    const image = decodeSkinPng(sourceSnapshot.files["skin.png"].bytes);
    const proposed = input.state;
    if (
      proposed.document.revisionId !== sourceRevision.id ||
      proposed.document.source.armType !== sourceSegmentation.source.armType ||
      proposed.document.source.sourceHash !== sourceSegmentation.source.sourceHash
    ) {
      throw invalidInput("AI 提案来源与待提交 Revision 不一致", {
        sourceRevisionId,
      });
    }
    for (const component of proposed.document.components) {
      if (
        component.provenance.actorType !== "ai" ||
        component.provenance.aiRunId !== input.aiRunId ||
        component.provenance.containsGeneratedPixels
      ) {
        throw invalidInput(`AI 组件来源信息无效：${component.instanceId}`);
      }
    }
    try {
      validateSemanticState(
        proposed,
        image,
        getSkinLayout(sourceSegmentation.source.armType),
      );
    } catch (error) {
      throw invalidInput(
        error instanceof Error ? error.message : "AI 语义状态校验失败",
      );
    }

    const ids = this.revisionIds();
    const createdAt = this.now();
    const summary = validateText(
      "Revision 摘要",
      input.summary ??
        `AI 语义拆分 · ${proposed.document.components.length} 个组件`,
      300,
    );
    const state: SemanticState = {
      ...proposed,
      document: { ...proposed.document, revisionId: ids.revisionId },
    };
    const skinPng = sourceSnapshot.files["skin.png"].bytes;
    const resultHash = computeResultHash(skinPng, state.document);
    const metadata = {
      aiJobId: input.aiJobId,
      aiRunId: input.aiRunId,
      provider,
      model,
      proposalSummary,
      reviewItems: input.reviewItems,
    };
    const operation = createOperation({
      type: "ai_segment",
      inputRevisionId: sourceRevision.id,
      outputRevisionId: ids.revisionId,
      actorType: "ai",
      actorId: provider,
      createdAt,
      summary,
      beforeHash: sourceRevision.resultHash,
      afterHash: resultHash,
      affectedComponents: state.document.components.map(
        (component) => component.instanceId,
      ),
      metadata,
    });
    const snapshot = await this.storage.writeSnapshot({
      projectId: project.id,
      revisionId: ids.revisionId,
      skinPng,
      segmentationJson: canonicalJson(state.document),
      operationJson: canonicalJson(operation),
      additionalFiles: semanticMaskFiles(state),
    });

    try {
      const commit = this.database.transaction(() => {
        const currentBranch = this.database
          .prepare("SELECT head_revision_id FROM skin_branch WHERE id = ?")
          .get(branch.id) as { head_revision_id: string | null } | undefined;
        if (currentBranch?.head_revision_id !== sourceRevision.id) {
          throw conflict("AI 分析期间 Branch 已产生新的 Revision", {
            branchId: branch.id,
          });
        }
        const assetIds = this.insertAssets(project.id, ids, snapshot, createdAt);
        this.insertRevision({
          ids,
          projectId: project.id,
          branchId: branch.id,
          parentRevisionId: sourceRevision.id,
          sequence: sourceRevision.sequence + 1,
          operationType: "ai_segment",
          actorType: "ai",
          actorId: provider,
          aiRunId: input.aiRunId,
          summary,
          sourceHash: sourceRevision.resultHash,
          resultHash,
          createdAt,
          metadata,
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(
          project.id,
          ids,
          "ai_segment",
          summary,
          createdAt,
        );
        this.database
          .prepare("UPDATE skin_branch SET head_revision_id = ? WHERE id = ?")
          .run(ids.revisionId, branch.id);
        if (branch.id === project.defaultBranchId) {
          this.database
            .prepare(`
              UPDATE skin_project
              SET head_revision_id = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(ids.revisionId, createdAt, project.id);
        } else {
          this.database
            .prepare("UPDATE skin_project SET updated_at = ? WHERE id = ?")
            .run(createdAt, project.id);
        }
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(project.id, ids.revisionId);
      throw error;
    }

    return {
      project: this.getProject(project.id),
      branch: this.getBranch(branch.id),
      revision: this.getRevision(ids.revisionId),
    };
  }

  private async revertRevisionUnlocked(
    targetRevisionId: string,
    input: RevertRevisionInput,
  ): Promise<RevisionMutationResult> {
    const target = this.getRevision(targetRevisionId);
    const project = this.getProject(target.projectId);
    const branch = this.getBranch(input.branchId ?? project.defaultBranchId);
    if (branch.projectId !== target.projectId) {
      throw invalidInput("目标 Revision 与 Branch 不属于同一 Project");
    }

    if (!branch.headRevisionId) {
      throw conflict("Branch 尚无可恢复的 Revision", { branchId: branch.id });
    }
    const currentHead = this.getRevision(branch.headRevisionId);
    const targetSnapshot = await this.verifyRevisionSnapshot(target.id);
    const targetSegmentation = parseSegmentation(
      targetSnapshot.files["segmentation.json"].bytes,
      target.id,
    );
    const ids = this.revisionIds();
    const createdAt = this.now();
    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const summary = validateText(
      "Revision 摘要",
      input.summary ?? `恢复到 ${target.branchName} #${target.sequence}`,
      300,
    );
    const segmentation: SegmentationSnapshot = {
      ...structuredClone(targetSegmentation),
      revisionId: ids.revisionId,
    };
    const skinPng = targetSnapshot.files["skin.png"].bytes;
    const resultHash = computeResultHash(skinPng, segmentation);
    if (resultHash !== target.resultHash) {
      throw snapshotCorrupt(target.id, "目标状态哈希无法稳定复用");
    }
    const operation = createOperation({
      type: "revert",
      inputRevisionId: currentHead.id,
      outputRevisionId: ids.revisionId,
      actorType: "user",
      actorId,
      createdAt,
      summary,
      beforeHash: currentHead.resultHash,
      afterHash: resultHash,
      metadata: { targetRevisionId: target.id },
    });
    const snapshot = await this.storage.writeSnapshot({
      projectId: project.id,
      revisionId: ids.revisionId,
      skinPng,
      segmentationJson: canonicalJson(segmentation),
      operationJson: canonicalJson(operation),
      additionalFiles: snapshotAdditionalFiles(targetSnapshot),
    });

    try {
      const commit = this.database.transaction(() => {
        const assetIds = this.insertAssets(project.id, ids, snapshot, createdAt);
        this.insertRevision({
          ids,
          projectId: project.id,
          branchId: branch.id,
          parentRevisionId: currentHead.id,
          sequence: currentHead.sequence + 1,
          operationType: "revert",
          actorType: "user",
          actorId,
          summary,
          sourceHash: currentHead.resultHash,
          resultHash,
          createdAt,
          metadata: { targetRevisionId: target.id },
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(project.id, ids, "revert", summary, createdAt);
        this.database
          .prepare("UPDATE skin_branch SET head_revision_id = ? WHERE id = ?")
          .run(ids.revisionId, branch.id);
        if (branch.id === project.defaultBranchId) {
          this.database
            .prepare(`
              UPDATE skin_project
              SET head_revision_id = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(ids.revisionId, createdAt, project.id);
        } else {
          this.database
            .prepare("UPDATE skin_project SET updated_at = ? WHERE id = ?")
            .run(createdAt, project.id);
        }
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(project.id, ids.revisionId);
      throw error;
    }

    return {
      project: this.getProject(project.id),
      branch: this.getBranch(branch.id),
      revision: this.getRevision(ids.revisionId),
    };
  }

  private async branchFromRevisionUnlocked(
    targetRevisionId: string,
    input: BranchFromRevisionInput,
  ): Promise<RevisionMutationResult> {
    const target = this.getRevision(targetRevisionId);
    const project = this.getProject(target.projectId);
    const branchName = validateText("Branch 名称", input.name, 80);
    const existing = this.database
      .prepare("SELECT id FROM skin_branch WHERE project_id = ? AND name = ?")
      .get(project.id, branchName) as { id: string } | undefined;
    if (existing) {
      throw conflict(`Branch 名称已存在：${branchName}`, {
        projectId: project.id,
        branchId: existing.id,
      });
    }

    const targetSnapshot = await this.verifyRevisionSnapshot(target.id);
    const targetSegmentation = parseSegmentation(
      targetSnapshot.files["segmentation.json"].bytes,
      target.id,
    );
    const branchId = this.id("branch");
    const ids = this.revisionIds();
    const createdAt = this.now();
    const actorId = validateOptionalText("actorId", input.actorId, 120);
    const summary = validateText(
      "Revision 摘要",
      input.summary ?? `从 ${target.branchName} #${target.sequence} 创建分支 ${branchName}`,
      300,
    );
    const segmentation: SegmentationSnapshot = {
      ...structuredClone(targetSegmentation),
      revisionId: ids.revisionId,
    };
    const skinPng = targetSnapshot.files["skin.png"].bytes;
    const resultHash = computeResultHash(skinPng, segmentation);
    if (resultHash !== target.resultHash) {
      throw snapshotCorrupt(target.id, "目标状态哈希无法稳定复用");
    }
    const operation = createOperation({
      type: "branch",
      inputRevisionId: target.id,
      outputRevisionId: ids.revisionId,
      actorType: "user",
      actorId,
      createdAt,
      summary,
      beforeHash: target.resultHash,
      afterHash: resultHash,
      metadata: { baseRevisionId: target.id, branchName },
    });
    const snapshot = await this.storage.writeSnapshot({
      projectId: project.id,
      revisionId: ids.revisionId,
      skinPng,
      segmentationJson: canonicalJson(segmentation),
      operationJson: canonicalJson(operation),
      additionalFiles: snapshotAdditionalFiles(targetSnapshot),
    });

    try {
      const commit = this.database.transaction(() => {
        this.database
          .prepare(`
            INSERT INTO skin_branch (
              id, project_id, name, base_revision_id, head_revision_id, created_at
            ) VALUES (?, ?, ?, ?, NULL, ?)
          `)
          .run(branchId, project.id, branchName, target.id, createdAt);
        const assetIds = this.insertAssets(project.id, ids, snapshot, createdAt);
        this.insertRevision({
          ids,
          projectId: project.id,
          branchId,
          parentRevisionId: target.id,
          sequence: 1,
          operationType: "branch",
          actorType: "user",
          actorId,
          summary,
          sourceHash: target.resultHash,
          resultHash,
          createdAt,
          metadata: { baseRevisionId: target.id, branchName },
        });
        this.attachAssetsToRevision(ids.revisionId, assetIds);
        this.insertOperation(project.id, ids, "branch", summary, createdAt);
        this.database
          .prepare("UPDATE skin_branch SET head_revision_id = ? WHERE id = ?")
          .run(ids.revisionId, branchId);
        this.database
          .prepare("UPDATE skin_project SET updated_at = ? WHERE id = ?")
          .run(createdAt, project.id);
      });
      commit.immediate();
    } catch (error) {
      await this.storage.removeNewSnapshot(project.id, ids.revisionId);
      if (isUniqueConstraint(error)) {
        throw conflict(`Branch 名称已存在：${branchName}`);
      }
      throw error;
    }

    return {
      project: this.getProject(project.id),
      branch: this.getBranch(branchId),
      revision: this.getRevision(ids.revisionId),
    };
  }

  private insertAssets(
    projectId: string,
    ids: RevisionIds,
    snapshot: VerifiedSnapshot,
    createdAt: string,
  ): string[] {
    const insert = this.database.prepare(`
      INSERT INTO skin_asset (
        id, project_id, revision_id, asset_type, storage_path,
        mime_type, byte_size, sha256, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `);
    const assets: Array<{
      readonly id: string;
      readonly type: SkinAsset["assetType"];
      readonly mimeType: string;
      readonly file: VerifiedSnapshot["files"][string];
    }> = [
      {
        id: ids.skinAssetId,
        type: "revision_skin",
        mimeType: "image/png",
        file: snapshot.files["skin.png"],
      },
      {
        id: ids.segmentationAssetId,
        type: "segmentation_json",
        mimeType: "application/json",
        file: snapshot.files["segmentation.json"],
      },
      {
        id: ids.operationAssetId,
        type: "operation_json",
        mimeType: "application/json",
        file: snapshot.files["operation.json"],
      },
    ];
    for (const file of Object.values(snapshot.files)) {
      if (file.name.startsWith("components/")) {
        assets.push({
          id: this.id("asset"),
          type: "component_mask",
          mimeType: "image/png",
          file,
        });
      }
    }

    for (const asset of assets) {
      insert.run(
        asset.id,
        projectId,
        asset.type,
        asset.file.storagePath,
        asset.mimeType,
        asset.file.bytes.byteLength,
        asset.file.sha256,
        createdAt,
      );
    }
    return assets.map((asset) => asset.id);
  }

  private insertRevision(input: {
    readonly ids: RevisionIds;
    readonly projectId: string;
    readonly branchId: string;
    readonly parentRevisionId: string | null;
    readonly sequence: number;
    readonly operationType: RevisionOperationType;
    readonly actorType: ActorType;
    readonly actorId?: string;
    readonly aiRunId?: string;
    readonly summary: string;
    readonly sourceHash: string;
    readonly resultHash: string;
    readonly createdAt: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): void {
    this.database
      .prepare(`
        INSERT INTO skin_revision (
          id, project_id, branch_id, parent_revision_id, sequence,
          operation_type, actor_type, actor_id, ai_run_id, summary,
          skin_asset_id, segmentation_asset_id, operation_asset_id,
          source_hash, result_hash, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.ids.revisionId,
        input.projectId,
        input.branchId,
        input.parentRevisionId,
        input.sequence,
        input.operationType,
        input.actorType,
        input.actorId ?? null,
        input.aiRunId ?? null,
        input.summary,
        input.ids.skinAssetId,
        input.ids.segmentationAssetId,
        input.ids.operationAssetId,
        input.sourceHash,
        input.resultHash,
        input.createdAt,
        canonicalJson(input.metadata).trim(),
      );
  }

  private attachAssetsToRevision(
    revisionId: string,
    assetIds: readonly string[],
  ): void {
    const update = this.database.prepare(
      "UPDATE skin_asset SET revision_id = ? WHERE id = ?",
    );
    for (const assetId of assetIds) {
      update.run(revisionId, assetId);
    }
  }

  private insertOperation(
    projectId: string,
    ids: RevisionIds,
    operationType: RevisionOperationType,
    summary: string,
    createdAt: string,
  ): void {
    this.database
      .prepare(`
        INSERT INTO skin_operation (
          id, project_id, revision_id, operation_type,
          operation_asset_id, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        ids.operationId,
        projectId,
        ids.revisionId,
        operationType,
        ids.operationAssetId,
        summary,
        createdAt,
      );
  }

  private revisionIds(): RevisionIds {
    return {
      revisionId: this.id("revision"),
      skinAssetId: this.id("asset"),
      segmentationAssetId: this.id("asset"),
      operationAssetId: this.id("asset"),
      operationId: this.id("operation"),
    };
  }

  private id(kind: RevisionIdKind): string {
    const id = this.idProvider(kind);
    if (!/^[a-z][a-z0-9_-]{2,100}$/.test(id)) {
      throw invalidInput(`ID provider 返回了不安全的 ${kind} ID`, { id });
    }
    return id;
  }

  private assertActivePart(part: SkinPart, action: string): void {
    if (part.libraryStatus === "retired") {
      throw conflict(`${action}不能引用已停用部件`, {
        partId: part.id,
        libraryStatus: part.libraryStatus,
        retiredAt: part.retiredAt,
        retiredReason: part.retiredReason,
      });
    }
  }

  private assertActiveBundle(bundle: PartBundle, action: string): void {
    if (bundle.libraryStatus === "retired") {
      throw conflict(`${action}不能引用已停用部件集`, {
        bundleId: bundle.id,
        libraryStatus: bundle.libraryStatus,
        retiredAt: bundle.retiredAt,
        retiredReason: bundle.retiredReason,
      });
    }
  }

  private now(): string {
    const value = this.nowProvider();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw invalidInput("Clock 返回了无效时间");
    }
    return date.toISOString();
  }

  private withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(work, work);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function mapPart(row: PartRow): SkinPart {
  if (!isSemanticCategory(row.category) || !["wide", "slim"].includes(row.arm_type)) {
    throw partCorrupt(row.id, "数据库枚举值无效");
  }
  const manifest = parsePartManifest(row.manifest_json, row.id);
  if (
    manifest.source.projectId !== row.source_project_id ||
    manifest.source.revisionId !== row.source_revision_id ||
    manifest.source.componentInstanceId !== row.source_component_id ||
    manifest.name !== row.name ||
    manifest.category !== row.category
  ) {
    throw partCorrupt(row.id, "manifest 与数据库元数据不一致");
  }
  return {
    id: row.id,
    sourceProjectId: row.source_project_id,
    sourceRevisionId: row.source_revision_id,
    sourceComponentId: row.source_component_id,
    sourceProjectName: row.source_project_name,
    sourceBranchName: row.source_branch_name,
    sourceRevisionSequence: row.source_revision_sequence,
    name: row.name,
    category: row.category,
    ...(row.subtype ? { subtype: row.subtype } : {}),
    armType: row.arm_type as "wide" | "slim",
    manifest,
    texture: mapPartFile(
      row.texture_id,
      row.texture_storage_path,
      row.texture_mime_type,
      row.texture_byte_size,
      row.texture_sha256,
    ),
    writeMask: mapPartFile(
      row.mask_id,
      row.mask_storage_path,
      row.mask_mime_type,
      row.mask_byte_size,
      row.mask_sha256,
    ),
    manifestFile: mapPartFile(
      row.manifest_id,
      row.manifest_storage_path,
      row.manifest_mime_type,
      row.manifest_byte_size,
      row.manifest_sha256,
    ),
    preview: mapPartFile(
      row.preview_id,
      row.preview_storage_path,
      row.preview_mime_type,
      row.preview_byte_size,
      row.preview_sha256,
    ),
    source: mapPartFile(
      row.source_id,
      row.source_storage_path,
      row.source_mime_type,
      row.source_byte_size,
      row.source_sha256,
    ),
    createdAt: row.created_at,
    libraryStatus: assertLibraryStatus(
      row.library_status,
      row.id,
      row.retired_at,
      row.retired_reason,
    ),
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    metadata: parseObjectJson(row.metadata_json, `Part ${row.id} metadata`),
  };
}

function mapPartEditProject(row: PartEditProjectRow): PartEditProject {
  if (
    (row.status !== "draft" && row.status !== "committed") ||
    !row.head_revision_id ||
    (row.status === "draft" &&
      (row.result_part_id !== null || row.committed_at !== null)) ||
    (row.status === "committed" &&
      (row.result_part_id === null || row.committed_at === null))
  ) {
    throw partEditCorrupt(row.id, "工程状态与 HEAD/结果部件不一致");
  }
  return {
    id: row.id,
    basePartId: row.base_part_id,
    name: row.name,
    status: row.status,
    headRevisionId: row.head_revision_id,
    resultPartId: row.result_part_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at,
  };
}

function mapPartEditRevision(row: PartEditRevisionRow): PartEditRevision {
  if (
    !isPartEditOperationType(row.operation_type) ||
    !Number.isInteger(row.sequence) ||
    row.sequence < 1 ||
    !Number.isInteger(row.changed_pixel_count) ||
    row.changed_pixel_count < 0
  ) {
    throw partEditCorrupt(row.id, "Revision 枚举或计数无效");
  }
  const operation = parseObjectJson(
    row.operation_json,
    `Part edit revision ${row.id} operation`,
  );
  if (operation.type !== row.operation_type) {
    throw partEditCorrupt(row.id, "operation type 与 JSON 不一致");
  }
  return {
    id: row.id,
    projectId: row.project_id,
    parentRevisionId: row.parent_revision_id,
    sequence: row.sequence,
    operationType: row.operation_type,
    operation,
    summary: row.summary,
    ...(row.actor_id !== null ? { actorId: row.actor_id } : {}),
    texture: mapPartFile(
      `${row.id}_texture`,
      row.texture_storage_path,
      "image/png",
      row.texture_byte_size,
      row.texture_sha256,
    ),
    writeMask: mapPartFile(
      `${row.id}_mask`,
      row.mask_storage_path,
      "image/png",
      row.mask_byte_size,
      row.mask_sha256,
    ),
    revisionFile: mapPartFile(
      `${row.id}_revision`,
      row.revision_storage_path,
      "application/json",
      row.revision_byte_size,
      row.revision_sha256,
    ),
    changedPixelCount: row.changed_pixel_count,
    authoredProvenance: parseObjectJson(
      row.authored_provenance_json,
      `Part edit revision ${row.id} provenance`,
    ),
    createdAt: row.created_at,
  };
}

function mapCompositionProject(row: CompositionProjectRow): CompositionProject {
  if (
    !["wide", "slim"].includes(row.arm_type) ||
    !["draft", "committed"].includes(row.status) ||
    !["unresolved", "layer_order"].includes(row.resolution_mode)
  ) {
    throw snapshotCorrupt(row.id, "混搭工程枚举值无效");
  }
  const rawWinners = parseObjectJson(
    row.conflict_winners_json,
    `Composition ${row.id} conflict winners`,
  );
  if (Object.values(rawWinners).some((value) => typeof value !== "string")) {
    throw snapshotCorrupt(row.id, "混搭冲突决议必须引用图层 ID");
  }
  if (
    (row.status === "draft" && row.result_revision_id !== null) ||
    (row.status === "committed" &&
      (row.result_revision_id === null || row.committed_at === null))
  ) {
    throw snapshotCorrupt(row.id, "混搭提交状态与结果 Revision 不一致");
  }
  if (!isNonNegativeInteger(row.restoration_version)) {
    throw snapshotCorrupt(row.id, "混搭还原方案版本无效");
  }
  const persistedRestorationPlan = row.restoration_plan_json === null
    ? null
    : parsePersistedCompositionRestorationPlan(
        row.restoration_plan_json,
        row.id,
        row.arm_type as "wide" | "slim",
        row.base_revision_id,
      );
  if (
    persistedRestorationPlan !== null &&
    persistedRestorationPlan.summary.version !== row.restoration_version
  ) {
    throw snapshotCorrupt(row.id, "混搭还原方案版本与工程不一致");
  }
  return {
    id: row.id,
    projectId: row.project_id,
    baseRevisionId: row.base_revision_id,
    branchId: row.branch_id,
    name: row.name,
    armType: row.arm_type as "wide" | "slim",
    status: row.status as "draft" | "committed",
    resolutionMode: row.resolution_mode as "unresolved" | "layer_order",
    conflictWinners: rawWinners as Readonly<Record<string, string>>,
    report: parseCompositionReport(row.report_json, row.id),
    restorationVersion: row.restoration_version,
    restorationPlan: persistedRestorationPlan?.summary ?? null,
    resultRevisionId: row.result_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at,
  };
}

function mapCompositionLayer(
  row: CompositionLayerRow,
  part: SkinPart,
): CompositionLayer {
  if (row.position < 0 || !Number.isInteger(row.position)) {
    throw snapshotCorrupt(row.composition_id, "混搭图层位置无效");
  }
  return {
    id: row.id,
    compositionId: row.composition_id,
    partId: row.part_id,
    position: row.position,
    part,
    createdAt: row.created_at,
  };
}

function mapCompositionRestorationEvent(
  row: CompositionRestorationEventRow,
): CompositionRestorationEvent {
  if (
    !isNonNegativeInteger(row.id) ||
    !isNonNegativeInteger(row.version) ||
    !["plan_set", "plan_cleared"].includes(row.event_type) ||
    (row.candidate_set_hash !== null &&
      !/^sha256:[0-9a-f]{64}$/u.test(row.candidate_set_hash))
  ) {
    throw snapshotCorrupt(row.composition_id, "混搭还原审计事件无效");
  }
  const parsedCandidateIds = JSON.parse(row.candidate_ids_json) as unknown;
  const candidateIds = Array.isArray(parsedCandidateIds) &&
    parsedCandidateIds.every((value): value is string => typeof value === "string")
    ? parsedCandidateIds
    : [];
  if (
    new Set(candidateIds).size !== candidateIds.length ||
    candidateIds.some((id) => !isSafeReferenceId(id))
  ) {
    throw snapshotCorrupt(row.composition_id, "混搭还原审计候选 ID 无效");
  }
  return {
    id: row.id,
    compositionId: row.composition_id,
    version: row.version,
    eventType: row.event_type as CompositionRestorationEvent["eventType"],
    candidateSetHash: row.candidate_set_hash,
    candidateIds,
    payload: parseObjectJson(
      row.payload_json,
      `Composition ${row.composition_id} restoration event payload`,
    ),
    createdAt: row.created_at,
  };
}

function summarizeCompositionRestorationCandidates(
  compositionId: string,
  version: number,
  candidateSet: CoreRestorationCandidateSet,
): CompositionRestorationCandidates {
  const outerCandidate = candidateSet.candidates.find(
    (candidate) => candidate.kind === "outer_transparent",
  );
  const outerPixelCount = candidateSet.targetGroups
    .filter((group) => group.layer === "outer")
    .reduce((total, group) => total + group.pixelCount, 0);
  const basePixelCount = candidateSet.targetGroups
    .filter((group) => group.layer === "base")
    .reduce((total, group) => total + group.pixelCount, 0);
  const baseCandidates = candidateSet.candidates.filter(
    (candidate) => candidate.kind !== "outer_transparent",
  );
  const baseCovered = new Set(
    baseCandidates.flatMap((candidate) => candidate.coveredPixelIds),
  );
  return {
    compositionId,
    version,
    candidateSetHash: candidateSet.candidateSetHash,
    targetComponentIds: candidateSet.cleanupComponentIds,
    outer: {
      pixelCount: outerPixelCount,
      candidateId: outerCandidate?.candidateId ?? null,
    },
    base: {
      pixelCount: basePixelCount,
      coveredPixelCount: baseCovered.size,
      missingPixelCount: Math.max(0, basePixelCount - baseCovered.size),
      candidates: baseCandidates.map((candidate) => ({
        id: candidate.candidateId,
        kind: candidate.kind,
        targetGroupId: candidate.targetGroupId,
        label: restorationCandidateLabel(candidate.kind),
        description: restorationCandidateDescription(candidate),
        pixelCount: candidate.requestedPixelCount,
        coveragePixelCount: candidate.coveredPixelCount,
        ...(candidate.sampleRevisionId
          ? { sourceRevisionId: candidate.sampleRevisionId }
          : {}),
        ...(candidate.manualRgba ? { rgba: candidate.manualRgba } : {}),
        ...(candidate.complete ? { selectedByDefault: true } : {}),
      })),
    },
  };
}

function restorationCandidateLabel(
  kind: CompositionRestorationCandidates["base"]["candidates"][number]["kind"],
): string {
  const labels = {
    outer_transparent: "清除外层残留",
    current_same_surface: "当前皮肤同表面",
    current_same_body_part: "当前皮肤同部位",
    mirrored_counterpart: "镜像对应部位",
    donor_revision: "其他皮肤参考",
    manual_rgba: "指定肤色补全",
  } as const;
  return labels[kind];
}

function restorationCandidateDescription(
  candidate: CoreRestorationCandidateSet["candidates"][number],
): string {
  return candidate.complete
    ? `可覆盖 ${candidate.coveredPixelCount} px`
    : `可覆盖 ${candidate.coveredPixelCount} px，缺少 ${candidate.missingPixelCount} px`;
}

function persistableRestorationPlan(
  version: number,
  candidateSet: CoreRestorationCandidateSet,
  plan: CoreRestorationCandidatePlan,
): PersistedCompositionRestorationPlan {
  const selectedById = new Map(
    candidateSet.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const outerPixelCount = candidateSet.targetGroups
    .filter((group) => group.layer === "outer")
    .reduce((total, group) => total + group.pixelCount, 0);
  const basePixelCount = candidateSet.targetGroups
    .filter((group) => group.layer === "base")
    .reduce((total, group) => total + group.pixelCount, 0);
  const body = {
    summary: {
      version,
      candidateSetHash: candidateSet.candidateSetHash,
      targetComponentIds: [...candidateSet.cleanupComponentIds],
      candidateIds: [...plan.selectedCandidateIds],
      outerPixelCount,
      basePixelCount,
      coveredPixelCount: plan.coveredPixelCount,
      missingPixelCount: plan.missingPixelCount,
      planHash: plan.planHash,
    },
    operations: plan.operationDescriptors.map((operation) => ({
      ...operation,
      pixelIds: [...operation.pixelIds],
      ...(operation.mode === "fill_base" ? { rgba: [...operation.rgba] as [number, number, number, number] } : {}),
    })),
    selectedCandidates: plan.selectedCandidateIds.map((candidateId) => {
      const candidate = selectedById.get(candidateId)!;
      return {
        candidateId,
        kind: candidate.kind,
        targetGroupIds: [...candidate.targetGroupIds],
        sampleRevisionId: candidate.sampleRevisionId,
        sourceComponentIds: [...candidate.sourceComponentIds],
        evidenceHash: candidate.evidenceHash,
        coveredPixelIds: [...candidate.coveredPixelIds],
      };
    }),
    requestedPixelIds: [...plan.requestedPixelIds],
    coveredPixelIds: [...plan.coveredPixelIds],
    missingPixelIds: [...plan.missingPixelIds],
  };
  return {
    ...body,
    storageHash: persistedRestorationPlanHash(body),
  };
}

function materializeCompositionRestorationPlan(
  plan: PersistedCompositionRestorationPlan,
): PixelCompositionRestorationPlan {
  return {
    operations: plan.operations.map((operation) =>
      operation.mode === "clear_outer"
        ? {
            operationId: operation.operationId,
            mode: "clear_outer" as const,
            mask: pixelIdsToMask(operation.pixelIds),
          }
        : {
            operationId: operation.operationId,
            mode: "fill_base" as const,
            mask: pixelIdsToMask(operation.pixelIds),
            rgba: [...operation.rgba] as [number, number, number, number],
          },
    ),
  };
}

function restorationPlanIssueCount(
  plan: PersistedCompositionRestorationPlan,
): number {
  return plan.storageHash === persistedRestorationPlanHash(plan) ? 0 : 1;
}

function persistedRestorationPlanHash(
  plan: Omit<PersistedCompositionRestorationPlan, "storageHash"> |
    PersistedCompositionRestorationPlan,
): string {
  const { storageHash: _storageHash, ...body } = plan as PersistedCompositionRestorationPlan;
  return sha256(compactCanonicalJson(body));
}

function parseCompositionReport(
  source: string,
  compositionId: string,
): CompositionReport {
  try {
    const value = JSON.parse(source) as Partial<CompositionReport>;
    if (
      !["wide", "slim"].includes(value.targetArmType ?? "") ||
      !isNonNegativeInteger(value.layerCount) ||
      !isNonNegativeInteger(value.writePixelCount) ||
      !isNonNegativeInteger(value.appliedPixelCount) ||
      !isNonNegativeInteger(value.hardConflictCount) ||
      !isNonNegativeInteger(value.sameColorOverlapCount) ||
      !isNonNegativeInteger(value.layerConflictCount) ||
      !isNonNegativeInteger(value.modelConflictCount) ||
      !isNonNegativeInteger(value.unknownConflictCount) ||
      (value.restorationPixelCount !== undefined &&
        !isNonNegativeInteger(value.restorationPixelCount)) ||
      (value.restoredOuterPixelCount !== undefined &&
        !isNonNegativeInteger(value.restoredOuterPixelCount)) ||
      (value.restoredBasePixelCount !== undefined &&
        !isNonNegativeInteger(value.restoredBasePixelCount)) ||
      (value.restorationMissingPixelCount !== undefined &&
        !isNonNegativeInteger(value.restorationMissingPixelCount)) ||
      (value.restorationIssueCount !== undefined &&
        !isNonNegativeInteger(value.restorationIssueCount)) ||
      !isNonNegativeInteger(value.unresolvedConflictCount) ||
      typeof value.committable !== "boolean" ||
      !Array.isArray(value.conflicts)
    ) {
      throw new TypeError("report 结构无效");
    }
    return {
      ...value,
      restorationPixelCount: value.restorationPixelCount ?? 0,
      restoredOuterPixelCount: value.restoredOuterPixelCount ?? 0,
      restoredBasePixelCount: value.restoredBasePixelCount ?? 0,
      restorationMissingPixelCount: value.restorationMissingPixelCount ?? 0,
      restorationIssueCount: value.restorationIssueCount ?? 0,
    } as CompositionReport;
  } catch (error) {
    throw snapshotCorrupt(compositionId, "混搭冲突报告无效", { cause: error });
  }
}

function parsePersistedCompositionRestorationPlan(
  source: string,
  compositionId: string,
  armType: "wide" | "slim",
  baseRevisionId: string,
): PersistedCompositionRestorationPlan {
  try {
    const value = JSON.parse(source) as Partial<PersistedCompositionRestorationPlan>;
    const summary = value.summary;
    if (
      typeof value.storageHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.storageHash) ||
      summary === undefined ||
      !isNonNegativeInteger(summary.version) ||
      !/^sha256:[0-9a-f]{64}$/u.test(summary.candidateSetHash) ||
      !/^sha256:[0-9a-f]{64}$/u.test(summary.planHash) ||
      !validSemanticComponentIdArray(summary.targetComponentIds, true) ||
      !validPersistedIdArray(summary.candidateIds, false) ||
      !isNonNegativeInteger(summary.outerPixelCount) ||
      !isNonNegativeInteger(summary.basePixelCount) ||
      !isNonNegativeInteger(summary.coveredPixelCount) ||
      !isNonNegativeInteger(summary.missingPixelCount) ||
      !validPixelIdArray(value.requestedPixelIds) ||
      !validPixelIdArray(value.coveredPixelIds) ||
      !validPixelIdArray(value.missingPixelIds) ||
      !Array.isArray(value.operations) ||
      !Array.isArray(value.selectedCandidates)
    ) {
      throw new TypeError("plan 结构无效");
    }
    const plan = value as PersistedCompositionRestorationPlan;
    const pixelTargetGroups = restorationTargetGroupsByPixel(armType);
    const operationIds = plan.operations.map((operation) => operation.operationId);
    const selectedCandidateIds = plan.selectedCandidates.map(
      (candidate) => candidate.candidateId,
    );
    const selectedTargetGroupIds = plan.selectedCandidates.flatMap(
      (candidate) => candidate.targetGroupIds,
    );
    const outerCandidates = plan.selectedCandidates.filter(
      (candidate) => candidate.kind === "outer_transparent",
    );
    const baseCandidates = plan.selectedCandidates.filter(
      (candidate) => candidate.kind !== "outer_transparent",
    );
    const clearOperations = plan.operations.filter(
      (operation) => operation.mode === "clear_outer",
    );
    const fillOperations = plan.operations.filter(
      (operation) => operation.mode === "fill_base",
    );
    const requestedOuterPixelIds = plan.requestedPixelIds.filter(
      (pixelId) => restorationPixelLayer(pixelTargetGroups, pixelId) === "outer",
    );
    const requestedBasePixelIds = plan.requestedPixelIds.filter(
      (pixelId) => restorationPixelLayer(pixelTargetGroups, pixelId) === "base",
    );
    const coveredOuterPixelIds = plan.coveredPixelIds.filter(
      (pixelId) => restorationPixelLayer(pixelTargetGroups, pixelId) === "outer",
    );
    const coveredBasePixelIds = plan.coveredPixelIds.filter(
      (pixelId) => restorationPixelLayer(pixelTargetGroups, pixelId) === "base",
    );
    const missingOuterPixelIds = plan.missingPixelIds.filter(
      (pixelId) => restorationPixelLayer(pixelTargetGroups, pixelId) === "outer",
    );
    const selectedOperationPrefixes = new Set(
      plan.selectedCandidates.map((candidate) =>
        `rest_${candidate.evidenceHash.slice("sha256:".length)}_`
      ),
    );
    const expectedPlanHash = sha256(canonicalRestorationJson({
      schemaVersion: "1.0",
      candidateSetHash: summary.candidateSetHash,
      selectedCandidateIds: summary.candidateIds,
      operationDescriptors: plan.operations,
      requestedPixelIds: plan.requestedPixelIds,
      coveredPixelIds: plan.coveredPixelIds,
      missingPixelIds: plan.missingPixelIds,
      evidence: {
        sourceRevisionId: baseRevisionId,
        candidateEvidenceHashes: plan.selectedCandidates.map(
          (candidate) => candidate.evidenceHash,
        ),
      },
    }));
    if (
      summary.coveredPixelCount !== plan.coveredPixelIds.length ||
      summary.missingPixelCount !== plan.missingPixelIds.length ||
      summary.outerPixelCount + summary.basePixelCount !== plan.requestedPixelIds.length ||
      summary.planHash !== expectedPlanHash ||
      summary.coveredPixelCount + summary.missingPixelCount !== plan.requestedPixelIds.length ||
      summary.outerPixelCount !== requestedOuterPixelIds.length ||
      summary.basePixelCount !== requestedBasePixelIds.length ||
      missingOuterPixelIds.length !== 0 ||
      plan.requestedPixelIds.some((pixelId) => !pixelTargetGroups.has(pixelId)) ||
      !hasExactDisjointPixelUnion(
        plan.requestedPixelIds,
        [plan.coveredPixelIds, plan.missingPixelIds],
      ) ||
      !sameStringArray(summary.candidateIds, selectedCandidateIds) ||
      new Set(selectedCandidateIds).size !== selectedCandidateIds.length ||
      new Set(selectedTargetGroupIds).size !== selectedTargetGroupIds.length ||
      outerCandidates.length !== (summary.outerPixelCount > 0 ? 1 : 0) ||
      new Set(operationIds).size !== operationIds.length ||
      plan.operations.some((operation) =>
        ![...selectedOperationPrefixes].some((prefix) =>
          operation.operationId.startsWith(prefix)
        )
      ) ||
      !hasExactDisjointPixelUnion(
        plan.coveredPixelIds,
        plan.operations.map((operation) => operation.pixelIds),
      ) ||
      !hasExactDisjointPixelUnion(
        plan.coveredPixelIds,
        plan.selectedCandidates.map((candidate) => candidate.coveredPixelIds),
      ) ||
      !hasExactDisjointPixelUnion(
        coveredOuterPixelIds,
        clearOperations.map((operation) => operation.pixelIds),
      ) ||
      !hasExactDisjointPixelUnion(
        coveredBasePixelIds,
        fillOperations.map((operation) => operation.pixelIds),
      ) ||
      !hasExactDisjointPixelUnion(
        coveredOuterPixelIds,
        outerCandidates.map((candidate) => candidate.coveredPixelIds),
      ) ||
      !hasExactDisjointPixelUnion(
        coveredBasePixelIds,
        baseCandidates.map((candidate) => candidate.coveredPixelIds),
      ) ||
      coveredOuterPixelIds.length !== summary.outerPixelCount ||
      plan.operations.some((operation) =>
        !isSafeReferenceId(operation.operationId) ||
        !validPixelIdArray(operation.pixelIds) ||
        operation.pixelIds.length === 0 ||
        (operation.mode !== "clear_outer" && operation.mode !== "fill_base") ||
        (operation.mode === "fill_base" && !isOpaqueRgba(operation.rgba)) ||
        !restorationOperationMatchesUvLayer(operation, pixelTargetGroups)
      ) ||
      plan.selectedCandidates.some((candidate) =>
        !isSafeReferenceId(candidate.candidateId) ||
        !isRestorationCandidateKind(candidate.kind) ||
        !validRestorationTargetGroupIds(candidate.targetGroupIds) ||
        !validSemanticComponentIdArray(candidate.sourceComponentIds, false) ||
        (candidate.sampleRevisionId !== null && !isSafeReferenceId(candidate.sampleRevisionId)) ||
        !/^sha256:[0-9a-f]{64}$/u.test(candidate.evidenceHash) ||
        !validPixelIdArray(candidate.coveredPixelIds) ||
        candidate.coveredPixelIds.length === 0 ||
        !restorationCandidateMatchesTargetGroups(candidate, pixelTargetGroups) ||
        !restorationCandidateSourceIsConsistent(candidate, baseRevisionId) ||
        !restorationCandidateOperationsAreConsistent(candidate, plan.operations)
      )
    ) {
      throw new TypeError("plan 内容或校验值无效");
    }
    if (plan.storageHash !== persistedRestorationPlanHash(plan)) {
      throw new TypeError("plan storageHash 校验失败");
    }
    return plan;
  } catch (error) {
    throw snapshotCorrupt(compositionId, "混搭还原方案无效", { cause: error });
  }
}

function validSemanticComponentIdArray(
  values: readonly string[] | undefined,
  requireOne: boolean,
): values is readonly string[] {
  return (
    Array.isArray(values) &&
    (!requireOne || values.length > 0) &&
    new Set(values).size === values.length &&
    values.every((value) =>
      value !== "unknown" &&
      value.length <= 100 &&
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
    )
  );
}

function validPersistedIdArray(
  values: readonly string[] | undefined,
  requireOne: boolean,
): values is readonly string[] {
  return (
    Array.isArray(values) &&
    (!requireOne || values.length > 0) &&
    new Set(values).size === values.length &&
    values.every(isSafeReferenceId)
  );
}

function validRestorationTargetGroupIds(
  values: readonly string[] | undefined,
): values is readonly string[] {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    new Set(values).size === values.length &&
    values.every((value) =>
      /^(?:head|torso|leftArm|rightArm|leftLeg|rightLeg)_(?:base|outer)$/u.test(
        value,
      ),
    )
  );
}

function validPixelIdArray(
  values: readonly number[] | undefined,
): values is readonly number[] {
  return (
    Array.isArray(values) &&
    new Set(values).size === values.length &&
    values.every((value) => Number.isInteger(value) && value >= 0 && value < 4096) &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

function hasExactDisjointPixelUnion(
  expected: readonly number[],
  groups: readonly (readonly number[])[],
): boolean {
  const combined = groups.flatMap((group) => group);
  return (
    combined.length === expected.length &&
    new Set(combined).size === combined.length &&
    JSON.stringify(expected) === JSON.stringify([...combined].sort((a, b) => a - b))
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restorationTargetGroupsByPixel(
  armType: "wide" | "slim",
): ReadonlyMap<number, string> {
  const layout = getSkinLayout(armType);
  const groups = new Map<number, string>();
  for (const surfaceKey of layout.surfaceOrder) {
    const surface = layout.surfaces[surfaceKey];
    const groupId = `${surface.bodyPart}_${surface.layer}`;
    const { atlasRect } = surface;
    for (let y = atlasRect.y; y < atlasRect.y + atlasRect.height; y += 1) {
      for (let x = atlasRect.x; x < atlasRect.x + atlasRect.width; x += 1) {
        groups.set(y * 64 + x, groupId);
      }
    }
  }
  return groups;
}

function restorationPixelLayer(
  targetGroups: ReadonlyMap<number, string>,
  pixelId: number,
): "base" | "outer" | null {
  const targetGroupId = targetGroups.get(pixelId);
  if (targetGroupId?.endsWith("_base")) return "base";
  if (targetGroupId?.endsWith("_outer")) return "outer";
  return null;
}

function restorationOperationMatchesUvLayer(
  operation: PersistedCompositionRestorationPlan["operations"][number],
  targetGroups: ReadonlyMap<number, string>,
): boolean {
  const expectedSuffix = operation.mode === "clear_outer" ? "_outer" : "_base";
  const operationGroups = operation.pixelIds.map((pixelId) => targetGroups.get(pixelId));
  return (
    operationGroups.every((groupId) => groupId?.endsWith(expectedSuffix)) &&
    new Set(operationGroups).size === 1
  );
}

function restorationCandidateMatchesTargetGroups(
  candidate: PersistedCompositionRestorationPlan["selectedCandidates"][number],
  targetGroups: ReadonlyMap<number, string>,
): boolean {
  const expectedSuffix = candidate.kind === "outer_transparent" ? "_outer" : "_base";
  if (
    candidate.targetGroupIds.some((groupId) => !groupId.endsWith(expectedSuffix)) ||
    (candidate.kind !== "outer_transparent" && candidate.targetGroupIds.length !== 1)
  ) {
    return false;
  }
  const candidateGroups = new Set(candidate.targetGroupIds);
  const coveredGroups = new Set(
    candidate.coveredPixelIds.map((pixelId) => targetGroups.get(pixelId)),
  );
  return (
    coveredGroups.size === candidateGroups.size &&
    [...coveredGroups].every(
      (groupId) => groupId !== undefined && candidateGroups.has(groupId),
    )
  );
}

function isRestorationCandidateKind(
  value: unknown,
): value is PersistedCompositionRestorationPlan["selectedCandidates"][number]["kind"] {
  return [
    "outer_transparent",
    "current_same_surface",
    "current_same_body_part",
    "mirrored_counterpart",
    "donor_revision",
    "manual_rgba",
  ].includes(value as string);
}

function restorationCandidateSourceIsConsistent(
  candidate: PersistedCompositionRestorationPlan["selectedCandidates"][number],
  baseRevisionId: string,
): boolean {
  if (candidate.kind === "outer_transparent" || candidate.kind === "manual_rgba") {
    return candidate.sampleRevisionId === null && candidate.sourceComponentIds.length === 0;
  }
  if (candidate.sampleRevisionId === null || candidate.sourceComponentIds.length === 0) {
    return false;
  }
  return candidate.kind === "donor_revision"
    ? candidate.sampleRevisionId !== baseRevisionId
    : candidate.sampleRevisionId === baseRevisionId;
}

function restorationCandidateOperationsAreConsistent(
  candidate: PersistedCompositionRestorationPlan["selectedCandidates"][number],
  operations: PersistedCompositionRestorationPlan["operations"],
): boolean {
  const token = /^sha256:([0-9a-f]{64})$/u.exec(candidate.evidenceHash)?.[1];
  if (!token || candidate.candidateId !== `restore_${token}`) return false;
  const prefix = `rest_${token}_`;
  if (
    operations.some((operation) =>
      operation.operationId.startsWith("rest_") &&
      !operation.operationId.startsWith(prefix) &&
      candidate.coveredPixelIds.some((pixelId) => operation.pixelIds.includes(pixelId))
    )
  ) {
    return false;
  }
  const candidateOperations = operations.filter((operation) =>
    operation.operationId.startsWith(prefix),
  );
  if (
    candidateOperations.length === 0 ||
    candidateOperations.some((operation, index) =>
      operation.operationId !== `${prefix}${index.toString().padStart(3, "0")}` ||
      (candidate.kind === "outer_transparent"
        ? operation.mode !== "clear_outer"
        : operation.mode !== "fill_base")
    )
  ) {
    return false;
  }
  return hasExactDisjointPixelUnion(
    candidate.coveredPixelIds,
    candidateOperations.map((operation) => operation.pixelIds),
  );
}

function isOpaqueRgba(value: readonly number[] | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255) &&
    value[3] === 255
  );
}

function normalizeCompositionLayers(
  layers: readonly CompositionLayer[],
): CompositionLayer[] {
  return layers.map((layer, position) => ({ ...layer, position }));
}

function resetCompositionResolution(
  composition: CompositionProject,
): CompositionProject {
  return {
    ...composition,
    resolutionMode: "unresolved",
    conflictWinners: {},
  };
}

function compositionConflictSummary(report: CompositionReport) {
  return {
    hardConflictCount: report.hardConflictCount,
    sameColorOverlapCount: report.sameColorOverlapCount,
    layerConflictCount: report.layerConflictCount,
    modelConflictCount: report.modelConflictCount,
    unknownConflictCount: report.unknownConflictCount,
    restorationPixelCount: report.restorationPixelCount,
    restoredOuterPixelCount: report.restoredOuterPixelCount,
    restoredBasePixelCount: report.restoredBasePixelCount,
    restorationMissingPixelCount: report.restorationMissingPixelCount,
    restorationIssueCount: report.restorationIssueCount,
    unresolvedConflictCount: report.unresolvedConflictCount,
  };
}

function compactCanonicalJson(value: unknown): string {
  return canonicalJson(value).trim();
}

function validateLibraryStatus(value: unknown): void {
  if (value !== undefined && value !== "active" && value !== "retired" && value !== "all") {
    throw invalidInput(`未知资产状态：${String(value)}`);
  }
}

function validateAnalyzedSkinCatalogStatus(value: unknown): void {
  if (
    value !== undefined &&
    value !== "active" &&
    value !== "archived" &&
    value !== "all"
  ) {
    throw invalidInput(`未知已分析目录状态：${String(value)}`);
  }
}

function validateAnalyzedSkinArchiveReason(value: string): string {
  if (value.length > 300) {
    throw invalidInput("归档原因必须为 1-300 个可见字符");
  }
  return validateText("归档原因", value, 300);
}

function assertAnalyzedSkinCatalogLifecycle(
  row: AnalyzedCatalogRow,
): {
  readonly status: "active" | "archived";
  readonly archivedAt: string | null;
  readonly archivedReason: string | null;
} {
  if (row.archived_at === null) {
    if (row.archived_reason !== null) {
      throw snapshotCorrupt(row.result_revision_id, "分析目录状态与归档信息不一致");
    }
    return { status: "active", archivedAt: null, archivedReason: null };
  }
  if (Number.isNaN(Date.parse(row.archived_at))) {
    throw snapshotCorrupt(row.result_revision_id, "分析目录归档时间无效");
  }
  if (
    row.archived_reason !== null &&
    (row.archived_reason.trim() !== row.archived_reason ||
      row.archived_reason.length === 0 ||
      row.archived_reason.length > 300 ||
      /[\u0000-\u001f\u007f]/u.test(row.archived_reason))
  ) {
    throw snapshotCorrupt(row.result_revision_id, "分析目录归档原因无效");
  }
  return {
    status: "archived",
    archivedAt: row.archived_at,
    archivedReason: row.archived_reason,
  };
}

interface ParsedSemanticAnalysisFollowup {
  readonly jobId: string;
  readonly status: SemanticAnalysisFollowupStatus;
  readonly evidenceHash: string;
  readonly suggestionCount: number;
  readonly suggestedPixelCount: number;
  readonly suggestionIds: readonly string[];
  readonly suggestions: readonly {
    readonly id: string;
    readonly targetComponentId: string;
    readonly spans: readonly unknown[];
  }[];
  readonly notices: readonly { readonly kind: string; readonly message: string }[];
  readonly appliedRevisionId: string | null;
}

function parseSemanticAnalysisFollowup(
  row: AnalyzedCatalogRow,
): ParsedSemanticAnalysisFollowup | null {
  const required = [
    row.followup_job_id,
    row.followup_status,
    row.followup_assessment_json,
    row.followup_evidence_hash,
  ];
  if (required.every((value) => value === null)) {
    if (row.followup_applied_revision_id !== null) {
      throw snapshotCorrupt(row.result_revision_id, "分析后续状态不完整");
    }
    return null;
  }
  if (required.some((value) => value === null)) {
    throw snapshotCorrupt(row.result_revision_id, "分析后续状态不完整");
  }

  const jobId = row.followup_job_id as string;
  const status = row.followup_status;
  const evidenceHash = row.followup_evidence_hash as string;
  const appliedRevisionId = row.followup_applied_revision_id;
  if (!isSemanticAnalysisFollowupStatus(status)) {
    throw snapshotCorrupt(row.result_revision_id, "分析后续状态无效");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(evidenceHash)) {
    throw snapshotCorrupt(row.result_revision_id, "分析后续证据哈希无效");
  }
  if ((status === "applied") !== (appliedRevisionId !== null)) {
    throw snapshotCorrupt(row.result_revision_id, "分析后续状态与修复 Revision 不一致");
  }

  try {
    const assessment = JSON.parse(row.followup_assessment_json as string) as unknown;
    if (!isJsonObject(assessment)) {
      throw new TypeError("assessment 必须是 JSON object");
    }
    if (
      assessment.schemaVersion !== "1.0" ||
      !isBoundedStoredText(assessment.algorithmVersion, 80) ||
      assessment.evidenceHash !== evidenceHash ||
      !Array.isArray(assessment.suggestions) ||
      !Array.isArray(assessment.notices)
    ) {
      throw new TypeError("assessment 顶层结构无效");
    }
    if (
      assessment.algorithmVersion === "cross-body-hair-reclassification-v2" &&
      assessment.suggestions.length > 1
    ) {
      throw new TypeError("v2 assessment 不能包含多条修复建议");
    }

    let suggestedPixelCount = 0;
    const suggestionIds = new Set<string>();
    const suggestions: {
      readonly id: string;
      readonly targetComponentId: string;
      readonly spans: readonly unknown[];
    }[] = [];
    for (const suggestion of assessment.suggestions) {
      if (!isJsonObject(suggestion)) {
        throw new TypeError("suggestion 必须是 JSON object");
      }
      if (
        !isBoundedStoredText(suggestion.id, 120) ||
        suggestionIds.has(suggestion.id) ||
        !isBoundedStoredText(suggestion.kind, 80) ||
        !isBoundedStoredText(suggestion.label, 160) ||
        !isBoundedStoredText(suggestion.targetComponentId, 120) ||
        !isUniqueStoredTextArray(suggestion.sourceComponentIds, 120) ||
        !isUniqueStoredTextArray(suggestion.candidateRegionIds, 160) ||
        !Array.isArray(suggestion.spans) ||
        suggestion.spans.length === 0 ||
        !Number.isInteger(suggestion.pixelCount) ||
        (suggestion.pixelCount as number) < 1 ||
        typeof suggestion.confidence !== "number" ||
        !Number.isFinite(suggestion.confidence) ||
        suggestion.confidence < 0 ||
        suggestion.confidence > 1 ||
        !isBoundedStoredText(suggestion.reason, 500)
      ) {
        throw new TypeError("suggestion 结构无效");
      }
      suggestionIds.add(suggestion.id);
      let spanPixelCount = 0;
      for (const span of suggestion.spans) {
        if (
          !isJsonObject(span) ||
          typeof span.surface !== "string" ||
          !(span.surface in getSkinLayout("wide").surfaces) ||
          !Number.isInteger(span.y) ||
          !Number.isInteger(span.x0) ||
          !Number.isInteger(span.x1) ||
          (span.y as number) < 0 ||
          (span.y as number) > 63 ||
          (span.x0 as number) < 0 ||
          (span.x1 as number) > 63 ||
          (span.x0 as number) > (span.x1 as number)
        ) {
          throw new TypeError("suggestion span 无效");
        }
        spanPixelCount += (span.x1 as number) - (span.x0 as number) + 1;
      }
      if (spanPixelCount !== suggestion.pixelCount) {
        throw new TypeError("suggestion pixelCount 与 spans 不一致");
      }
      suggestions.push({
        id: suggestion.id,
        targetComponentId: suggestion.targetComponentId,
        spans: suggestion.spans,
      });
      suggestedPixelCount += suggestion.pixelCount;
    }
    if (
      (status === "no_repair" && suggestionIds.size !== 0) ||
      (status !== "no_repair" && suggestionIds.size === 0)
    ) {
      throw new TypeError("分析后续状态与修复建议数量不一致");
    }

    const notices = assessment.notices.map((notice) => {
      if (
        !isJsonObject(notice) ||
        !isBoundedStoredText(notice.kind, 40) ||
        !isBoundedStoredText(notice.message, 300)
      ) {
        throw new TypeError("notice 结构无效");
      }
      return { kind: notice.kind, message: notice.message };
    });

    return {
      jobId,
      status,
      evidenceHash,
      suggestionCount: assessment.suggestions.length,
      suggestedPixelCount,
      suggestionIds: [...suggestionIds],
      suggestions,
      notices,
      appliedRevisionId,
    };
  } catch (error) {
    if (error instanceof RevisionStoreError) throw error;
    throw snapshotCorrupt(row.result_revision_id, "分析后续评估证据无效", { cause: error });
  }
}

function isSemanticAnalysisFollowupStatus(
  value: unknown,
): value is SemanticAnalysisFollowupStatus {
  return value === "no_repair" ||
    value === "awaiting_review" ||
    value === "applied" ||
    value === "dismissed" ||
    value === "assessment_failed";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function sameSemanticSpanSet(left: unknown, right: unknown): boolean {
  const leftKeys = semanticSpanKeys(left);
  const rightKeys = semanticSpanKeys(right);
  return leftKeys !== null &&
    rightKeys !== null &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]);
}

function semanticSpanKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const layout = getSkinLayout("wide");
  const keys: string[] = [];
  for (const span of value) {
    if (
      !isJsonObject(span) ||
      typeof span.surface !== "string" ||
      !(span.surface in layout.surfaces) ||
      !Number.isInteger(span.y) ||
      !Number.isInteger(span.x0) ||
      !Number.isInteger(span.x1) ||
      (span.y as number) < 0 ||
      (span.y as number) > 63 ||
      (span.x0 as number) < 0 ||
      (span.x1 as number) > 63 ||
      (span.x0 as number) > (span.x1 as number)
    ) {
      return null;
    }
    keys.push(JSON.stringify([
      span.surface,
      span.y,
      span.x0,
      span.x1,
    ]));
  }
  return keys.sort();
}

function isBoundedStoredText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isUniqueStoredTextArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => isBoundedStoredText(item, maxLength)) &&
    new Set(value).size === value.length;
}

function assertLibraryStatus(
  value: string,
  id: string,
  retiredAt: string | null,
  retiredReason: string | null,
): "active" | "retired" {
  if (value !== "active" && value !== "retired") {
    throw snapshotCorrupt(id, "部件库状态无效");
  }
  if (
    (value === "active" && (retiredAt !== null || retiredReason !== null)) ||
    (value === "retired" &&
      (retiredAt === null || Number.isNaN(Date.parse(retiredAt))))
  ) {
    throw snapshotCorrupt(id, "部件库状态与停用信息不一致");
  }
  return value;
}

function validateRetireReason(value: string | undefined): string | null {
  return value === undefined ? null : validateText("停用原因", value, 300);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function mapPartFile(
  id: string,
  storagePath: string,
  mimeType: string,
  byteSize: number,
  hash: string,
): PartFileAsset {
  return { id, storagePath, mimeType, byteSize, sha256: hash };
}

function parsePartManifest(source: string, partId: string): PartManifest {
  try {
    const value = JSON.parse(source) as Partial<PartManifest>;
    const compatibility = value.compatibility;
    const placement = value.placement;
    const relations = value.relations;
    const palette = value.palette;
    if (
      (value.schemaVersion !== "1.0" && value.schemaVersion !== "1.1") ||
      value.id !== partId ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      value.name.length > 120 ||
      !isSemanticCategory(value.category) ||
      value.source === undefined ||
      value.source === null ||
      Array.isArray(value.source) ||
      typeof value.source !== "object" ||
      typeof value.source.projectId !== "string" ||
      typeof value.source.revisionId !== "string" ||
      typeof value.source.componentInstanceId !== "string" ||
      compatibility === undefined ||
      compatibility === null ||
      Array.isArray(compatibility) ||
      typeof compatibility !== "object" ||
      compatibility.resolution !== "64x64" ||
      !isUniqueNonEmptyEnumArray(compatibility.armTypes, ["wide", "slim"]) ||
      placement === undefined ||
      placement === null ||
      Array.isArray(placement) ||
      typeof placement !== "object" ||
      !isUniqueNonEmptyEnumArray(placement.preferredLayers, ["base", "outer"]) ||
      !isUniqueStringArray(placement.surfaces, isSurfaceKey, true) ||
      relations === undefined ||
      relations === null ||
      Array.isArray(relations) ||
      typeof relations !== "object" ||
      !isUniqueStringArray(relations.softConflicts, isSafeReferenceId) ||
      !isUniqueStringArray(relations.hardConflicts, isSafeReferenceId) ||
      palette === undefined ||
      palette === null ||
      Array.isArray(palette) ||
      typeof palette !== "object" ||
      typeof palette.dominant !== "string" ||
      !/^#[0-9A-Fa-f]{6}$/.test(palette.dominant) ||
      value.maskMode !== "write-colored-pixels-only" ||
      typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt))
    ) {
      throw new TypeError("manifest 结构无效");
    }
    if (value.schemaVersion === "1.0") {
      if ("derivation" in value) {
        throw new TypeError("manifest 1.0 不能声明 derivation");
      }
    } else {
      const derivation = value.derivation;
      if (
        derivation === null ||
        Array.isArray(derivation) ||
        typeof derivation !== "object" ||
        Object.keys(derivation).sort().join(",") !==
          "basePartId,containsGeneratedPixels,kind,partEditProjectId,partEditRevisionId" ||
        derivation?.kind !== "part_repair" ||
        !isSafeReferenceId(derivation.basePartId) ||
        !isSafeReferenceId(derivation.partEditProjectId) ||
        !isSafeReferenceId(derivation.partEditRevisionId) ||
        derivation.containsGeneratedPixels !== false
      ) {
        throw new TypeError("manifest 1.1 缺少有效的 part_repair derivation");
      }
    }
    return value as PartManifest;
  } catch (error) {
    throw partCorrupt(partId, "manifest.json 无效", error);
  }
}

function isUniqueNonEmptyEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is readonly T[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item): item is T => allowed.includes(item as T)) &&
    new Set(value).size === value.length
  );
}

function isUniqueStringArray(
  value: unknown,
  predicate: (item: unknown) => item is string,
  requireNonEmpty = false,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    (!requireNonEmpty || value.length > 0) &&
    value.every(predicate) &&
    new Set(value).size === value.length
  );
}

function isSurfaceKey(value: unknown): value is PartManifest["placement"]["surfaces"][number] {
  return (
    typeof value === "string" &&
    /^(head|torso|rightArm|leftArm|rightLeg|leftLeg)\.(base|outer)\.(front|back|left|right|top|bottom)$/.test(
      value,
    )
  );
}

function partCorrupt(
  partId: string,
  message: string,
  cause?: unknown,
): RevisionStoreError {
  return new RevisionStoreError(
    "SNAPSHOT_CORRUPT",
    `Part ${partId} 资产损坏：${message}`,
    409,
    { partId },
    cause === undefined ? undefined : { cause },
  );
}

function partEditCorrupt(
  revisionId: string,
  message: string,
  cause?: unknown,
): RevisionStoreError {
  return new RevisionStoreError(
    "SNAPSHOT_CORRUPT",
    `Part edit ${revisionId} 资产损坏：${message}`,
    409,
    { revisionId },
    cause === undefined ? undefined : { cause },
  );
}

function mapProject(row: ProjectRow): SkinProject {
  if (!row.default_branch_id) {
    throw new RevisionStoreError(
      "SNAPSHOT_CORRUPT",
      `Project ${row.id} 缺少默认 Branch`,
      409,
    );
  }
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    defaultBranchId: row.default_branch_id,
    headRevisionId: row.head_revision_id,
    settings: parseObjectJson(row.settings_json, `Project ${row.id} settings`),
  };
}

function mapBranch(row: BranchRow): SkinBranch {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    baseRevisionId: row.base_revision_id,
    headRevisionId: row.head_revision_id,
    createdAt: row.created_at,
  };
}

function mapRevision(row: RevisionRow): SkinRevision {
  if (
    !OPERATION_TYPES.includes(row.operation_type as RevisionOperationType) ||
    !["user", "ai", "system"].includes(row.actor_type)
  ) {
    throw snapshotCorrupt(row.id, "数据库 Revision 枚举值无效");
  }
  return {
    id: row.id,
    projectId: row.project_id,
    parentRevisionId: row.parent_revision_id,
    branchId: row.branch_id,
    branchName: row.branch_name,
    sequence: row.sequence,
    operationType: row.operation_type as RevisionOperationType,
    actorType: row.actor_type as ActorType,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.ai_run_id ? { aiRunId: row.ai_run_id } : {}),
    createdAt: row.created_at,
    summary: row.summary,
    skinAssetId: row.skin_asset_id,
    segmentationAssetId: row.segmentation_asset_id,
    operationAssetId: row.operation_asset_id,
    sourceHash: row.source_hash,
    resultHash: row.result_hash,
    metadata: parseObjectJson(row.metadata_json, `Revision ${row.id} metadata`),
    isBranchHead: row.branch_head_revision_id === row.id,
  };
}

function mapAsset(row: AssetRow): SkinAsset {
  if (
    !row.revision_id ||
    ![
      "revision_skin",
      "segmentation_json",
      "component_mask",
      "operation_json",
    ].includes(
      row.asset_type,
    )
  ) {
    throw snapshotCorrupt(row.revision_id ?? "unknown", "数据库资产类型无效");
  }
  return {
    id: row.id,
    projectId: row.project_id,
    revisionId: row.revision_id,
    assetType: row.asset_type as SkinAsset["assetType"],
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function semanticMaskFiles(
  state: SemanticState,
): Readonly<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {
    [state.document.unknown.maskFile]: encodeSkinPng(
      maskToRgbaImage(state.unknownMask),
    ),
  };
  for (const component of state.document.components) {
    files[component.maskFile] = encodeSkinPng(
      maskToRgbaImage(state.masks[component.instanceId]!),
    );
  }
  return files;
}

function snapshotAdditionalFiles(
  snapshot: VerifiedSnapshot,
): Readonly<Record<string, Uint8Array>> {
  return Object.fromEntries(
    Object.values(snapshot.files)
      .filter((file) => file.name.startsWith("components/"))
      .map((file) => [file.name, file.bytes]),
  );
}

function semanticStateFromSnapshot(
  snapshot: VerifiedSnapshot,
  segmentation: SegmentationSnapshot,
  revisionId: string,
): SemanticState {
  const image = decodeSkinPng(snapshot.files["skin.png"].bytes);
  if (segmentation.unknown.maskFile === null) {
    const additionalFiles = Object.values(snapshot.files).filter((file) =>
      file.name.startsWith("components/"),
    );
    if (segmentation.components.length > 0 || additionalFiles.length > 0) {
      throw snapshotCorrupt(
        revisionId,
        "legacy segmentation 缺少组件遮罩",
      );
    }
    return createInitialSemanticState({
      revisionId,
      armType: segmentation.source.armType,
      sourceHash: segmentation.source.sourceHash,
      image,
    });
  }

  try {
    const expectedMaskFiles = new Set<string>([segmentation.unknown.maskFile]);
    const masks: Record<string, Uint8Array> = {};
    for (const component of segmentation.components) {
      if (expectedMaskFiles.has(component.maskFile)) {
        throw new TypeError(`重复组件遮罩路径：${component.maskFile}`);
      }
      expectedMaskFiles.add(component.maskFile);
      const file = snapshot.files[component.maskFile];
      if (!file) {
        throw new TypeError(`缺少组件遮罩：${component.maskFile}`);
      }
      masks[component.instanceId] = rgbaImageToMask(decodeSkinPng(file.bytes));
    }
    const unknownFile = snapshot.files[segmentation.unknown.maskFile];
    if (!unknownFile) {
      throw new TypeError(`缺少 unknown 遮罩：${segmentation.unknown.maskFile}`);
    }
    const actualMaskFiles = Object.values(snapshot.files)
      .filter((file) => file.name.startsWith("components/"))
      .map((file) => file.name)
      .sort();
    if (
      JSON.stringify(actualMaskFiles) !==
      JSON.stringify([...expectedMaskFiles].sort())
    ) {
      throw new TypeError("组件遮罩文件集合与 segmentation.json 不一致");
    }
    const state: SemanticState = {
      document: segmentation as SegmentationDocument,
      masks,
      unknownMask: rgbaImageToMask(decodeSkinPng(unknownFile.bytes)),
    };
    validateSemanticState(state, image);
    return state;
  } catch (error) {
    if (error instanceof RevisionStoreError) {
      throw error;
    }
    throw snapshotCorrupt(revisionId, "语义遮罩与 segmentation.json 不一致", {
      cause: error,
    });
  }
}

function createOperation(input: {
  readonly type: RevisionOperationType;
  readonly inputRevisionId: string | null;
  readonly outputRevisionId: string;
  readonly actorType: ActorType;
  readonly actorId?: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly beforeHash: string | null;
  readonly afterHash: string;
  readonly affectedComponents?: readonly string[];
  readonly affectedSpans?: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
}): OperationSnapshot {
  return {
    schemaVersion: "1.0",
    type: input.type,
    inputRevisionId: input.inputRevisionId,
    outputRevisionId: input.outputRevisionId,
    actor: {
      type: input.actorType,
      ...(input.actorId ? { id: input.actorId } : {}),
    },
    createdAt: input.createdAt,
    summary: input.summary,
    affectedComponents: input.affectedComponents ?? [],
    affectedSpans: input.affectedSpans ?? [],
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    metadata: input.metadata,
  };
}

function manualRevisionOperationType(
  operationType: ManualSemanticOperation["type"],
): RevisionOperationType {
  switch (operationType) {
    case "assign_pixels":
      return "manual_edit";
    case "unassign_pixels":
      return "manual_edit";
    case "merge_components":
      return "merge_components";
    case "split_component":
      return "split_component";
    case "reclassify_component":
      return "reclassify_component";
  }
}

function manualOperationSummary(
  operationType: ManualSemanticOperation["type"],
): string {
  switch (operationType) {
    case "assign_pixels":
      return "确认语义像素分类";
    case "unassign_pixels":
      return "将语义像素标记为 unknown";
    case "merge_components":
      return "合并语义组件";
    case "split_component":
      return "拆分语义组件";
    case "reclassify_component":
      return "修改组件分类";
  }
}

function manualAffectedComponents(
  operation: ManualSemanticOperation,
): readonly string[] {
  switch (operation.type) {
    case "assign_pixels":
      return [operation.target.instanceId];
    case "unassign_pixels":
      return [];
    case "merge_components":
      return [...new Set([...operation.componentIds, operation.target.instanceId])];
    case "split_component":
      return [operation.sourceComponentId, operation.target.instanceId];
    case "reclassify_component":
      return [operation.componentId];
  }
}

function appliedPartComponentId(partId: string): string {
  return `applied.${partId.slice(0, 90)}`;
}

function composedPartComponentId(layerId: string): string {
  return `composed.${layerId.slice(0, 89)}`;
}

function restoredCandidateComponentId(candidateId: string): string {
  return `restored.${candidateId.slice(0, 90)}`;
}

function restorationComponentDisplayName(
  kind: CompositionRestorationCandidates["base"]["candidates"][number]["kind"],
): string {
  return `${restorationCandidateLabel(kind)} · 还原`;
}

function computeResultHash(
  skinPng: Uint8Array,
  segmentation: SegmentationSnapshot,
): string {
  const normalizedSegmentation = {
    ...segmentation,
    revisionId: "revision_state",
  };
  return sha256(
    canonicalJson({
      skinHash: sha256(skinPng),
      segmentation: normalizedSegmentation,
    }),
  );
}

function parseSegmentation(
  bytes: Uint8Array,
  revisionId: string,
): SegmentationSnapshot {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<SegmentationSnapshot>;
    if (
      value.schemaVersion !== "1.0" ||
      value.revisionId !== revisionId ||
      value.source?.width !== 64 ||
      value.source.height !== 64 ||
      !["wide", "slim"].includes(value.source.armType) ||
      value.source.coordinateOrigin !== "top-left" ||
      !/^sha256:[0-9a-f]{64}$/.test(value.source.sourceHash) ||
      !Array.isArray(value.components) ||
      !(
        value.unknown?.maskFile === null ||
        (typeof value.unknown?.maskFile === "string" &&
          /^components\/[a-z][a-z0-9._-]{0,100}\.mask\.png$/.test(
            value.unknown.maskFile,
          ))
      ) ||
      !Number.isInteger(value.unknown.pixelCount) ||
      value.unknown.pixelCount < 0
    ) {
      throw new TypeError("segmentation.json 结构无效");
    }
    return value as SegmentationSnapshot;
  } catch (error) {
    throw snapshotCorrupt(revisionId, "segmentation.json 无效", { cause: error });
  }
}

function parseOperation(bytes: Uint8Array, revisionId: string): OperationSnapshot {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<OperationSnapshot>;
    if (
      value.schemaVersion !== "1.0" ||
      value.outputRevisionId !== revisionId ||
      !OPERATION_TYPES.includes(value.type as RevisionOperationType) ||
      (value.inputRevisionId !== null &&
        typeof value.inputRevisionId !== "string") ||
      value.actor === undefined ||
      value.actor === null ||
      !["user", "ai", "system"].includes(value.actor.type) ||
      (value.actor.id !== undefined && typeof value.actor.id !== "string") ||
      typeof value.createdAt !== "string" ||
      typeof value.summary !== "string" ||
      value.summary.length === 0 ||
      (value.beforeHash !== null &&
        !/^sha256:[0-9a-f]{64}$/.test(value.beforeHash ?? "")) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.afterHash ?? "") ||
      !Array.isArray(value.affectedComponents) ||
      !Array.isArray(value.affectedSpans)
    ) {
      throw new TypeError("operation.json 结构无效");
    }
    return value as OperationSnapshot;
  } catch (error) {
    throw snapshotCorrupt(revisionId, "operation.json 无效", { cause: error });
  }
}

interface PartEditDocument {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly projectId: string;
  readonly parentRevisionId: string | null;
  readonly sequence: number;
  readonly operation: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly actorId: string | null;
  readonly changedPixelCount: number;
  readonly authoredProvenance: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

function parsePartEditDocument(
  bytes: Uint8Array,
  revisionId: string,
): PartEditDocument {
  try {
    const value = JSON.parse(
      Buffer.from(bytes).toString("utf8"),
    ) as Partial<PartEditDocument>;
    if (
      value.schemaVersion !== "1.0" ||
      value.id !== revisionId ||
      typeof value.projectId !== "string" ||
      (value.parentRevisionId !== null &&
        typeof value.parentRevisionId !== "string") ||
      !Number.isInteger(value.sequence) ||
      (value.sequence ?? 0) < 1 ||
      value.operation === null ||
      Array.isArray(value.operation) ||
      typeof value.operation !== "object" ||
      !isPartEditOperationType(value.operation.type) ||
      typeof value.summary !== "string" ||
      (value.actorId !== null && typeof value.actorId !== "string") ||
      !Number.isInteger(value.changedPixelCount) ||
      (value.changedPixelCount ?? -1) < 0 ||
      value.authoredProvenance === null ||
      Array.isArray(value.authoredProvenance) ||
      typeof value.authoredProvenance !== "object" ||
      typeof value.createdAt !== "string"
    ) {
      throw new TypeError("revision.json 结构无效");
    }
    return value as PartEditDocument;
  } catch (error) {
    if (error instanceof RevisionStoreError) throw error;
    throw partEditCorrupt(revisionId, "revision.json 无效", error);
  }
}

function parseObjectJson(
  source: string,
  label: string,
): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(source) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError(`${label} 必须是 JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseJsonArray(source: string, label: string): readonly unknown[] {
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new TypeError(`${label} 必须是 JSON array`);
  return parsed;
}

function parseArmTypes(source: string, bundleId: string): readonly ("wide" | "slim")[] {
  const parsed = parseJsonArray(source, `Part bundle ${bundleId} armTypes`);
  if (
    parsed.length === 0 ||
    parsed.some((value) => value !== "wide" && value !== "slim") ||
    new Set(parsed).size !== parsed.length
  ) {
    throw snapshotCorrupt(bundleId, "部件集手臂模型无效");
  }
  return parsed as readonly ("wide" | "slim")[];
}

function intersectArmTypes(
  collections: readonly (readonly ("wide" | "slim")[])[],
): readonly ("wide" | "slim")[] {
  return (["wide", "slim"] as const).filter((armType) =>
    collections.every((collection) => collection.includes(armType)),
  );
}

function defaultBundleName(kind: AggregateKind): string {
  return { hair: "完整头发", clothing: "整套服装", accessory: "整组饰品" }[kind];
}

function aggregateCatalogGroups(
  segmentation: SegmentationSnapshot,
  bundles: readonly PartBundle[],
): AnalyzedSkinCatalogItem["groups"] {
  const buckets = new Map<
    string,
    {
      readonly key: string;
      readonly sourceGroupKey: string | null;
      readonly kind: AggregateKind;
      readonly components: Array<SegmentationSnapshot["components"][number]>;
    }
  >();
  for (const component of segmentation.components) {
    const kind = aggregateKindForCategory(component.category);
    if (!kind) continue;
    const sourceGroupKey =
      kind === "clothing" ? component.relations.sameOutfitGroup : null;
    const key =
      sourceGroupKey === null
        ? `aggregate.${kind}`
        : `${kind}:${sourceGroupKey}`;
    const bucket = buckets.get(key) ?? {
      key,
      sourceGroupKey,
      kind,
      components: [],
    };
    bucket.components.push(component);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((bucket) => {
      const componentIds = bucket.components
        .map((component) => component.instanceId)
        .sort();
      const exported = [...bundles]
        .reverse()
        .find(
          (bundle) =>
            bundle.libraryStatus === "active" &&
            bundle.kind === bucket.kind &&
            bundle.sourceGroupKey === bucket.sourceGroupKey &&
            bundle.members.length === componentIds.length &&
            bundle.members.every((member) => componentIds.includes(member.part.sourceComponentId)),
        );
      return {
        key: bucket.key,
        sourceGroupKey: bucket.sourceGroupKey,
        kind: bucket.kind,
        displayName: defaultBundleName(bucket.kind),
        componentIds,
        componentCount: componentIds.length,
        pixelCount: bucket.components.reduce(
          (total, component) =>
            total + component.spans.reduce(
              (subtotal, span) => subtotal + span.x1 - span.x0 + 1,
              0,
            ),
          0,
        ),
        exportedBundleId: exported?.id ?? null,
      };
    });
}

function validateText(label: string, value: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw invalidInput(`${label} 必须为 1-${maxLength} 个可见字符`);
  }
  return normalized;
}

function validateOptionalText(
  label: string,
  value: string | undefined,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : validateText(label, value, maxLength);
}

function validateSemanticFollowupRevisionContext(
  value: NonNullable<ManualRevisionOperationInput["semanticFollowup"]>,
): NonNullable<ManualRevisionOperationInput["semanticFollowup"]> {
  if (
    !isSafeReferenceId(value.jobId) ||
    !isSafeReferenceId(value.resultRevisionId) ||
    !/^followup_[0-9a-f]{24}$/u.test(value.suggestionId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.evidenceHash)
  ) {
    throw invalidInput("语义分类修复上下文无效");
  }
  return {
    jobId: value.jobId,
    resultRevisionId: value.resultRevisionId,
    suggestionId: value.suggestionId,
    evidenceHash: value.evidenceHash,
  };
}

function isPartEditOperationType(value: unknown): value is PartEditOperationType {
  return [
    "init",
    "paint_color",
    "erase_pixels",
    "replace_color",
    "copy_surfaces",
  ].includes(String(value));
}

function partEditOperationSummary(
  operationType: SerializedPartRepairOperation["type"],
): string {
  return {
    paint_color: "修补选中像素",
    erase_pixels: "擦除选中像素",
    replace_color: "精确替换部件颜色",
    copy_surfaces: "复制部件表面",
  }[operationType];
}

function dominantHex(
  texture: { readonly data: Uint8Array },
  writeMask: Uint8Array,
): string {
  const counts = new Map<string, number>();
  for (const pixelId of maskToPixelIds(writeMask)) {
    const offset = pixelId * 4;
    if (texture.data[offset + 3] === 0) continue;
    const color = `#${byteHex(texture.data[offset]!)}${byteHex(texture.data[offset + 1]!)}${byteHex(texture.data[offset + 2]!)}`;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return (
    [...counts].sort(([leftColor, leftCount], [rightColor, rightCount]) =>
      rightCount === leftCount
        ? leftColor.localeCompare(rightColor)
        : rightCount - leftCount,
    )[0]?.[0] ?? "#000000"
  );
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function assertSafeReferenceId(label: string, value: string): void {
  if (!isSafeReferenceId(value)) {
    throw invalidInput(`${label} 不是安全 ID`, { value });
  }
}

function validateReferenceId(label: string, value: string): string {
  assertSafeReferenceId(label, value);
  return value;
}

function validateUniqueSafeIds(
  label: string,
  values: readonly string[],
  maximum: number,
): string[] {
  if (
    !Array.isArray(values) ||
    values.length > maximum ||
    new Set(values).size !== values.length
  ) {
    throw invalidInput(`${label} 必须唯一且不超过 ${maximum} 项`);
  }
  for (const value of values) assertSafeReferenceId(label, value);
  return [...values];
}

function validateUniqueSemanticComponentIds(
  label: string,
  values: readonly string[],
  maximum: number,
): string[] {
  if (
    !Array.isArray(values) ||
    values.length > maximum ||
    new Set(values).size !== values.length ||
    values.some((value) =>
      value === "unknown" ||
      value.length > 100 ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
    )
  ) {
    throw invalidInput(`${label} 包含无效语义组件 ID`);
  }
  return [...values];
}

function validateOpaqueRgba(
  label: string,
  value: readonly number[],
): readonly [number, number, number, number] {
  if (
    value.length !== 4 ||
    value.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255) ||
    value[3] !== 255
  ) {
    throw invalidInput(`${label} 必须是 alpha=255 的 RGBA 字节`);
  }
  return [value[0]!, value[1]!, value[2]!, value[3]!];
}

function assertRestorationVersion(value: number): void {
  if (!isNonNegativeInteger(value)) {
    throw invalidInput("expectedVersion 必须是非负整数");
  }
}

function isSafeReferenceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{2,100}$/.test(value);
}

function defaultId(kind: RevisionIdKind): string {
  const prefix: Record<RevisionIdKind, string> = {
    project: "project",
    branch: "branch",
    revision: "rev",
    asset: "asset",
    operation: "op",
    part: "part",
    part_bundle: "partbundle",
    part_edit: "partedit",
    part_edit_revision: "parteditrev",
    composition: "composition",
    composition_layer: "complayer",
  };
  return `${prefix[kind]}_${randomUUID().replaceAll("-", "")}`;
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as Error & { code: unknown }).code).startsWith(
      "SQLITE_CONSTRAINT_UNIQUE",
    )
  );
}
