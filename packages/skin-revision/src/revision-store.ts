import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assessArmType,
  decodeSkinPng,
  encodeSkinPng,
  type ArmType,
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
  SnapshotStorage,
  type VerifiedSnapshot,
} from "./snapshot-storage";
import {
  OPERATION_TYPES,
  type ActorType,
  type BranchFromRevisionInput,
  type CreateProjectInput,
  type CreateProjectResult,
  type ImportProjectInput,
  type ImportProjectResult,
  type ImportSkinInput,
  type OperationSnapshot,
  type RevisionDiff,
  type RevisionIdKind,
  type RevisionMutationResult,
  type RevisionOperationType,
  type RevisionStoreOptions,
  type RevertRevisionInput,
  type SegmentationSnapshot,
  type SkinAsset,
  type SkinBranch,
  type SkinProject,
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

const REVISION_SELECT = `
  SELECT
    revision.*,
    branch.name AS branch_name,
    branch.head_revision_id AS branch_head_revision_id
  FROM skin_revision AS revision
  JOIN skin_branch AS branch ON branch.id = revision.branch_id
`;

export class RevisionStore {
  readonly dataDirectory: string;
  readonly storage: SnapshotStorage;
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
    this.database = openRevisionDatabase(
      options.databasePath ?? resolve(this.dataDirectory, "mcskinsplit.sqlite"),
    );
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

  async verifyRevisionSnapshot(revisionId: string): Promise<VerifiedSnapshot> {
    const revision = this.getRevision(revisionId);
    const snapshot = await this.storage.verifySnapshot(
      revision.projectId,
      revision.id,
    );
    const assets = this.getRevisionAssets(revision.id);
    const expectedAssets = new Map<SkinAsset["assetType"], {
      readonly file: VerifiedSnapshot["files"][keyof VerifiedSnapshot["files"]];
      readonly id: string;
      readonly mimeType: string;
    }>([
      [
        "revision_skin",
        {
          file: snapshot.files["skin.png"],
          id: revision.skinAssetId,
          mimeType: "image/png",
        },
      ],
      [
        "segmentation_json",
        {
          file: snapshot.files["segmentation.json"],
          id: revision.segmentationAssetId,
          mimeType: "application/json",
        },
      ],
      [
        "operation_json",
        {
          file: snapshot.files["operation.json"],
          id: revision.operationAssetId,
          mimeType: "application/json",
        },
      ],
    ]);

    if (assets.length !== expectedAssets.size) {
      throw snapshotCorrupt(revision.id, "数据库资产数量不正确");
    }

    const seenAssetTypes = new Set<SkinAsset["assetType"]>();
    for (const asset of assets) {
      const expected = expectedAssets.get(asset.assetType);
      if (
        !expected ||
        seenAssetTypes.has(asset.assetType) ||
        asset.id !== expected.id ||
        asset.projectId !== revision.projectId ||
        asset.revisionId !== revision.id ||
        asset.storagePath !== expected.file.storagePath ||
        asset.mimeType !== expected.mimeType ||
        asset.sha256 !== expected.file.sha256 ||
        asset.byteSize !== expected.file.bytes.byteLength
      ) {
        throw snapshotCorrupt(
          revision.id,
          `数据库资产 ${asset.id} 与快照不一致`,
        );
      }
      seenAssetTypes.add(asset.assetType);
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
    const segmentation = createEmptySegmentation(
      ids.revisionId,
      armType,
      canonicalSkinHash,
    );
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
    });

    try {
      const commit = this.database.transaction(() => {
        const currentBranch = this.database
          .prepare("SELECT head_revision_id FROM skin_branch WHERE id = ?")
          .get(branch.id) as { head_revision_id: string | null } | undefined;
        if (!currentBranch || currentBranch.head_revision_id) {
          throw conflict("Project 已经完成首次导入", { projectId });
        }
        this.insertAssets(project.id, ids, snapshot, createdAt);
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
        this.attachAssetsToRevision(ids);
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
    const segmentation = createEmptySegmentation(
      ids.revisionId,
      armType,
      canonicalSkinHash,
    );
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
        this.insertAssets(projectId, ids, snapshot, createdAt);
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
        this.attachAssetsToRevision(ids);
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
    });

    try {
      const commit = this.database.transaction(() => {
        this.insertAssets(project.id, ids, snapshot, createdAt);
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
        this.attachAssetsToRevision(ids);
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
        this.insertAssets(project.id, ids, snapshot, createdAt);
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
        this.attachAssetsToRevision(ids);
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
  ): void {
    const insert = this.database.prepare(`
      INSERT INTO skin_asset (
        id, project_id, revision_id, asset_type, storage_path,
        mime_type, byte_size, sha256, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `);
    const assets = [
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
    ] as const;

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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
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

  private attachAssetsToRevision(ids: RevisionIds): void {
    this.database
      .prepare(`
        UPDATE skin_asset SET revision_id = ?
        WHERE id IN (?, ?, ?)
      `)
      .run(
        ids.revisionId,
        ids.skinAssetId,
        ids.segmentationAssetId,
        ids.operationAssetId,
      );
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
    !["revision_skin", "segmentation_json", "operation_json"].includes(
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

function createEmptySegmentation(
  revisionId: string,
  armType: ArmType,
  canonicalSkinHash: string,
): SegmentationSnapshot {
  return {
    schemaVersion: "1.0",
    revisionId,
    source: {
      width: 64,
      height: 64,
      armType,
      coordinateOrigin: "top-left",
      sourceHash: canonicalSkinHash,
    },
    components: [],
    unknown: { maskFile: null, pixelCount: 0 },
  };
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
    affectedComponents: [],
    affectedSpans: [],
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    metadata: input.metadata,
  };
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
      value.unknown?.maskFile !== null ||
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

function defaultId(kind: RevisionIdKind): string {
  const prefix: Record<RevisionIdKind, string> = {
    project: "project",
    branch: "branch",
    revision: "rev",
    asset: "asset",
    operation: "op",
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
