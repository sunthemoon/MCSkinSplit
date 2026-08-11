import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  composeSkin,
  type CompositionLayerInput as PixelCompositionLayer,
  type CompositionReport,
  type CompositionResult as PixelCompositionResult,
} from "@mc-skin-split/skin-compositor";
import {
  SemanticEditError,
  analyzePartApplication,
  applyManualSemanticOperation,
  applyPartPixels,
  assessArmType,
  createInitialSemanticState,
  decodeSkinPng,
  encodeSkinPng,
  exportSemanticPart,
  getSkinLayout,
  isSemanticCategory,
  maskToRgbaImage,
  maskToPixelIds,
  pixelIdsToSpans,
  rgbaImageToMask,
  rebaseSemanticStateImage,
  validateSemanticState,
  type ManualSemanticOperation,
  type PartManifest,
  type SegmentationDocument,
  type SemanticState,
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
  SnapshotStorage,
  type VerifiedSnapshot,
} from "./snapshot-storage";
import {
  OPERATION_TYPES,
  type ActorType,
  type AiSegmentationRevisionInput,
  type AddCompositionPartInput,
  type ApplyPartInput,
  type ApplyPartResult,
  type BranchFromRevisionInput,
  type CommitCompositionInput,
  type CommitCompositionResult,
  type CompositionDetail,
  type CompositionLayer,
  type CompositionProject,
  type CreateCompositionInput,
  type CreateProjectInput,
  type CreateProjectResult,
  type ExportPartInput,
  type ImportProjectInput,
  type ImportProjectResult,
  type ImportSkinInput,
  type ManualRevisionOperationInput,
  type OperationSnapshot,
  type PartApplicationPreview,
  type PartFileAsset,
  type RevisionDiff,
  type RevisionIdKind,
  type RevisionMutationResult,
  type RevisionOperationType,
  type RevisionStoreOptions,
  type RevertRevisionInput,
  type ReorderCompositionLayersInput,
  type ResolveCompositionConflictInput,
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
  readonly name: string;
  readonly category: string;
  readonly subtype: string | null;
  readonly arm_type: string;
  readonly created_at: string;
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
  readonly result_revision_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly committed_at: string | null;
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
  JOIN part_file_asset AS texture ON texture.id = part.texture_asset_id
  JOIN part_file_asset AS mask ON mask.id = part.mask_asset_id
  JOIN part_file_asset AS manifest ON manifest.id = part.manifest_asset_id
  JOIN part_file_asset AS preview ON preview.id = part.preview_asset_id
  JOIN part_file_asset AS source ON source.id = part.source_asset_id
`;

export class RevisionStore {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly storage: SnapshotStorage;
  readonly partStorage: PartStorage;
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

  listParts(category?: string): SkinPart[] {
    if (category !== undefined && !isSemanticCategory(category)) {
      throw invalidInput(`未知部件分类：${category}`);
    }
    const rows = (category === undefined
      ? this.database
          .prepare(`${PART_SELECT} ORDER BY part.created_at, part.id`)
          .all()
      : this.database
          .prepare(
            `${PART_SELECT} WHERE part.category = ? ORDER BY part.created_at, part.id`,
          )
          .all(category)) as PartRow[];
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
    return rows.map(mapCompositionProject);
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

  async addCompositionPart(
    compositionId: string,
    input: AddCompositionPartInput,
  ): Promise<CompositionDetail> {
    return this.withWriteLock(() =>
      this.addCompositionPartUnlocked(compositionId, input),
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
    const affectedComponents: string[] = [];
    const affectedPixelIds = new Set<number>();
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
            SELECT composition.status, branch.head_revision_id
            FROM composition_project AS composition
            JOIN skin_branch AS branch ON branch.id = composition.branch_id
            WHERE composition.id = ?
          `)
          .get(composition.id) as
          | { readonly status: string; readonly head_revision_id: string | null }
          | undefined;
        if (
          current?.status !== "draft" ||
          current.head_revision_id !== sourceRevision.id
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
            WHERE id = ?
          `)
          .run(
            ids.revisionId,
            compactCanonicalJson(evaluated.report),
            createdAt,
            createdAt,
            composition.id,
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
    const actorId = validateOptionalText("actorId", input.actorId, 120);
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
    const metadata = { operation: input.operation };
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
    metadata: parseObjectJson(row.metadata_json, `Part ${row.id} metadata`),
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
      !isNonNegativeInteger(value.unresolvedConflictCount) ||
      typeof value.committable !== "boolean" ||
      !Array.isArray(value.conflicts)
    ) {
      throw new TypeError("report 结构无效");
    }
    return value as CompositionReport;
  } catch (error) {
    throw snapshotCorrupt(compositionId, "混搭冲突报告无效", { cause: error });
  }
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
    unresolvedConflictCount: report.unresolvedConflictCount,
  };
}

function compactCanonicalJson(value: unknown): string {
  return canonicalJson(value).trim();
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
    if (
      value.schemaVersion !== "1.0" ||
      value.id !== partId ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      !isSemanticCategory(value.category) ||
      value.source === undefined ||
      typeof value.source.projectId !== "string" ||
      typeof value.source.revisionId !== "string" ||
      typeof value.source.componentInstanceId !== "string" ||
      value.compatibility?.resolution !== "64x64" ||
      !Array.isArray(value.compatibility.armTypes) ||
      value.compatibility.armTypes.some(
        (armType) => !["wide", "slim"].includes(armType),
      ) ||
      !Array.isArray(value.placement?.preferredLayers) ||
      !Array.isArray(value.placement.surfaces) ||
      value.maskMode !== "write-colored-pixels-only" ||
      typeof value.createdAt !== "string"
    ) {
      throw new TypeError("manifest 结构无效");
    }
    return value as PartManifest;
  } catch (error) {
    throw partCorrupt(partId, "manifest.json 无效", error);
  }
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

function assertSafeReferenceId(label: string, value: string): void {
  if (!/^[a-z][a-z0-9_-]{2,100}$/.test(value)) {
    throw invalidInput(`${label} 不是安全 ID`, { value });
  }
}

function defaultId(kind: RevisionIdKind): string {
  const prefix: Record<RevisionIdKind, string> = {
    project: "project",
    branch: "branch",
    revision: "rev",
    asset: "asset",
    operation: "op",
    part: "part",
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
