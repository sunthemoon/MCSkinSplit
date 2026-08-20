import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  buildSurfaceTexels,
  canonicalCompletionJson,
  decodeSkinPng,
  createRgbaImage,
  encodeSkinPng,
  getPixelOrigin,
  getSkinLayout,
  getPixel,
  generateCompletionProposalCandidates,
  maskToPixelIds,
  pixelIdsToSpans,
  rgbaImageToMask,
  setPixel,
  type BodyPart,
  type CompletionProposal,
  type PixelOriginDocument,
  type SurfaceKey,
  type SurfaceTexel,
} from "@mc-skin-split/skin-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  RevisionStore,
  RevisionStoreError,
  canonicalJson,
  sha256,
  type RevisionIdKind,
} from "../src";

const REAL_SKIN_PATH = fileURLToPath(
  new URL(
    "../../../tests/fixtures/skins/ab87de696cfca859.png",
    import.meta.url,
  ),
);
const TARGET_SKIN_PATH = fileURLToPath(
  new URL(
    "../../../tests/fixtures/skins/354359a2c2f33777.png",
    import.meta.url,
  ),
);
const REAL_SKIN_DIRECTORY = fileURLToPath(
  new URL("../../../tests/fixtures/skins/", import.meta.url),
);
const EARLY_V11_SEMANTIC_FOLLOWUP_SQL = readFileSync(
  new URL("./fixtures/early-011-semantic-followup.sql", import.meta.url),
  "utf8",
);
const SEMANTIC_FOLLOWUP_HARDENING_SQL = readFileSync(
  new URL("../src/migrations/012_semantic_followup_hardening.sql", import.meta.url),
  "utf8",
);
const COMPLETION_PROPOSALS_V15_SQL = readFileSync(
  new URL("../src/migrations/015_completion_proposals.sql", import.meta.url),
  "utf8",
);
const IMMUTABLE_HISTORY_TRIGGER_NAMES = [
  "skin_revision_immutable_update",
  "skin_revision_immutable_delete",
  "skin_revision_origin_required_insert",
  "skin_operation_immutable_update",
  "skin_operation_immutable_delete",
  "skin_asset_revision_binding_guard",
  "skin_asset_revision_bound_immutable_update",
  "skin_asset_revision_bound_immutable_delete",
  "part_asset_content_immutable_update",
  "part_asset_immutable_delete",
  "part_asset_origin_required_insert",
  "part_file_asset_unbound_insert_guard",
  "part_file_asset_binding_guard",
  "part_file_asset_bound_immutable_update",
  "part_file_asset_bound_immutable_delete",
  "part_edit_revision_immutable_update",
  "part_edit_revision_immutable_delete",
  "part_edit_revision_origin_required_insert",
  "part_bundle_content_immutable_update",
  "part_bundle_immutable_delete",
  "part_bundle_member_immutable_update",
  "part_bundle_member_immutable_delete",
] as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("RevisionStore", () => {
  it("creates an empty Slim project and imports its first revision exactly once", async () => {
    const { store } = await createStore();

    try {
      const created = await store.createProject({ name: "Two-stage import" });
      expect(created.project).toMatchObject({
        headRevisionId: null,
        settings: { armType: "slim", coordinateOrigin: "top-left" },
      });
      expect(created.branch).toMatchObject({
        name: "main",
        headRevisionId: null,
      });
      expect(store.listRevisions(created.project.id)).toEqual([]);

      const imported = await store.importIntoProject(created.project.id, {
        fileName: "ab87de696cfca859.png",
        skinPng: await readFile(REAL_SKIN_PATH),
      });
      expect(imported.project.headRevisionId).toBe(imported.revision.id);
      expect(imported.branch.headRevisionId).toBe(imported.revision.id);
      expect(imported.revision).toMatchObject({
        parentRevisionId: null,
        sequence: 1,
        operationType: "import",
      });

      await expect(
        store.importIntoProject(created.project.id, {
          skinPng: await readFile(REAL_SKIN_PATH),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.listRevisions(created.project.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("imports a real Slim skin into a complete immutable snapshot", async () => {
    const { directory, store } = await createStore();

    try {
      const skinPng = await readFile(REAL_SKIN_PATH);
      const result = await store.importProject({
        name: "Real skin",
        fileName: "ab87de696cfca859.png",
        skinPng,
      });

      expect(result.armType).toBe("slim");
      expect(result.warnings).toEqual([]);
      expect(result.project.defaultBranchId).toBe(result.branch.id);
      expect(result.project.headRevisionId).toBe(result.revision.id);
      expect(result.branch.name).toBe("main");
      expect(result.branch.baseRevisionId).toBeNull();
      expect(result.branch.headRevisionId).toBe(result.revision.id);
      expect(result.revision).toMatchObject({
        parentRevisionId: null,
        sequence: 1,
        operationType: "import",
        isBranchHead: true,
      });

      const revisionDirectory = join(
        directory,
        "projects",
        result.project.id,
        "revisions",
        result.revision.id,
      );
      expect((await readdir(revisionDirectory)).sort()).toEqual([
        "checksum.json",
        "components",
        "operation.json",
        "origin.json",
        "segmentation.json",
        "skin.png",
      ]);

      const snapshot = await store.verifyRevisionSnapshot(result.revision.id);
      expect(snapshot.checksum.schemaVersion).toBe("2.0");
      expect(snapshot.checksum.revisionId).toBe(result.revision.id);
      expect(Object.keys(snapshot.checksum.files).sort()).toEqual([
        "components/unknown.mask.png",
        "operation.json",
        "origin.json",
        "segmentation.json",
        "skin.png",
      ]);
      expect(store.getRevisionAssets(result.revision.id)).toHaveLength(5);
      expect(result.revision.originAssetId).not.toBeNull();
      const origin = await store.readRevisionOrigin(result.revision.id);
      expect(origin).toMatchObject({
        schemaVersion: "1.0",
        subject: { kind: "revision", id: result.revision.id },
        entries: [
          {
            intrinsicOrigin: "source_visible",
            evidence: { sourceRevisionId: result.revision.id },
          },
        ],
      });

      const segmentation = await store.readRevisionSegmentation(
        result.revision.id,
      );
      expect(segmentation).toMatchObject({
        schemaVersion: "1.0",
        revisionId: result.revision.id,
        source: {
          width: 64,
          height: 64,
          armType: "slim",
        },
        components: [],
        unknown: {
          maskFile: "components/unknown.mask.png",
        },
      });
      const semanticState = await store.readRevisionSemanticState(
        result.revision.id,
      );
      expect(semanticState.masks).toEqual({});
      expect(semanticState.document.unknown.pixelCount).toBeGreaterThan(0);
      const operation = await store.readRevisionOperation(result.revision.id);
      expect(operation).toMatchObject({
        schemaVersion: "1.0",
        type: "import",
        inputRevisionId: null,
        outputRevisionId: result.revision.id,
        beforeHash: null,
        afterHash: result.revision.resultHash,
      });
      expect(await store.readRevisionSkinPng(result.revision.id)).toEqual(
        snapshot.files["skin.png"].bytes,
      );
    } finally {
      store.close();
    }
  });

  it("persists a manual arm-model override in the revision snapshot", async () => {
    const { store } = await createStore();

    try {
      const result = await store.importProject({
        name: "Wide override",
        fileName: "ab87de696cfca859.png",
        skinPng: await readFile(REAL_SKIN_PATH),
        armType: "wide",
      });

      expect(result.armType).toBe("wide");
      expect(result.warnings).toEqual([
        "手动模型 wide 覆盖自动识别 slim",
      ]);
      expect(await store.readRevisionSegmentation(result.revision.id)).toMatchObject(
        { source: { armType: "wide" } },
      );
    } finally {
      store.close();
    }
  });

  it("creates append-only part repair revisions and commits a new immutable part", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const originalTexture = await store.readPartTexturePng(part.id);
      const created = await store.createPartEditProject({
        basePartId: part.id,
        name: "Hair repair",
      });
      expect(created.project).toMatchObject({
        basePartId: part.id,
        status: "draft",
      });
      expect(created.headRevision).toMatchObject({
        sequence: 1,
        operationType: "init",
        changedPixelCount: 0,
      });
      const initialTexture = await store.readPartEditTexturePng(
        created.headRevision.id,
      );
      expect(initialTexture).toEqual(originalTexture);
      expect(
        decodeSkinPng(
          await store.readPartEditMannequinPng(created.headRevision.id, "slim"),
        ),
      ).toMatchObject({ width: 64, height: 64 });

      const edited = await store.applyPartEditOperation(created.project.id, {
        headRevisionId: created.headRevision.id,
        actorId: "tester",
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          rgba: [17, 34, 51, 255],
        },
      });
      expect(edited.revisions).toHaveLength(2);
      expect(edited.headRevision).toMatchObject({
        parentRevisionId: created.headRevision.id,
        sequence: 2,
        operationType: "paint_color",
        changedPixelCount: 1,
        authoredProvenance: {
          source: "manual",
          containsGeneratedPixels: false,
        },
      });
      expect(
        getPixel(
          decodeSkinPng(
            await store.readPartEditTexturePng(edited.headRevision.id),
          ),
          9,
          8,
        ),
      ).toEqual([17, 34, 51, 255]);
      const editedStorage = await store.verifyPartEditStorage(
        edited.headRevision.id,
      );
      const editedOrigin = JSON.parse(
        Buffer.from(editedStorage.files["origin.json"]!.bytes).toString("utf8"),
      ) as PixelOriginDocument;
      expect(getPixelOrigin(editedOrigin, 8 * 64 + 9)).toMatchObject({
        intrinsicOrigin: "manual_authored",
        evidence: {
          actor: { type: "user", id: "tester" },
          operationId: edited.headRevision.id,
        },
        copyLineage: null,
      });
      expect(await store.readPartEditTexturePng(created.headRevision.id)).toEqual(
        initialTexture,
      );

      await expect(
        store.applyPartEditOperation(created.project.id, {
          headRevisionId: created.headRevision.id,
          operation: {
            type: "erase_pixels",
            spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const committed = await store.commitPartEditProject(created.project.id, {
        headRevisionId: edited.headRevision.id,
        name: "Repaired hair",
      });
      expect(committed.project).toMatchObject({
        status: "committed",
        resultPartId: committed.part.id,
      });
      expect(committed.part.id).not.toBe(part.id);
      expect(committed.part.manifest).toMatchObject({
        schemaVersion: "2.0",
        derivation: {
          kind: "part_repair",
          basePartId: part.id,
          partEditProjectId: created.project.id,
          partEditRevisionId: edited.headRevision.id,
          containsGeneratedPixels: false,
        },
      });
      expect(committed.part.metadata).toMatchObject({
        ancestry: {
          schemaVersion: "2.0",
          kind: "part_repair",
          basePartId: part.id,
          partEditProjectId: created.project.id,
          partEditRevisionId: edited.headRevision.id,
          containsGeneratedPixels: false,
        },
      });
      expect(await store.readPartTexturePng(part.id)).toEqual(originalTexture);
      expect(
        getPixel(decodeSkinPng(await store.readPartTexturePng(committed.part.id)), 9, 8),
      ).toEqual([17, 34, 51, 255]);
      const committedStorage = await store.verifyPartStorage(committed.part.id);
      const committedOrigin = JSON.parse(
        Buffer.from(committedStorage.files["origin.json"]!.bytes).toString("utf8"),
      ) as PixelOriginDocument;
      expect(getPixelOrigin(committedOrigin, 8 * 64 + 9)).toMatchObject({
        intrinsicOrigin: "manual_authored",
        copyLineage: {
          sourceSubject: {
            kind: "part_edit_revision",
            id: edited.headRevision.id,
          },
          sourcePixelId: 8 * 64 + 9,
        },
      });
      expect(
        await readdir(join(directory, "part-edits", created.project.id, "revisions")),
      ).toHaveLength(2);
      await expect(
        store.applyPartEditOperation(created.project.id, {
          headRevisionId: edited.headRevision.id,
          operation: {
            type: "erase_pixels",
            spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      store.close();
    }
  });

  it("resolves a serialized donor part for deterministic surface copying", async () => {
    const { store } = await createStore();

    try {
      const target = await exportHeadPixelPart(store);
      const donor = await exportHeadPixelPart(store, [99, 88, 77, 255]);
      const repair = await store.createPartEditProject({ basePartId: target.id });
      const copied = await store.applyPartEditOperation(repair.project.id, {
        headRevisionId: repair.headRevision.id,
        operation: {
          type: "copy_surfaces",
          source: { kind: "part", partId: donor.id },
          mappings: [
            {
              sourceSurface: "head.base.front",
              targetSurface: "head.base.back",
              transform: "identity",
            },
          ],
          overwrite: "all",
        },
      });
      expect(copied.headRevision.operation).toMatchObject({
        source: { kind: "part", partId: donor.id },
      });
      expect(copied.headRevision.operation).not.toHaveProperty(
        "source.texture",
      );
    } finally {
      store.close();
    }
  });

  it("round-trips same-RGBA PartEdit copy lineage without a visual diff", async () => {
    const created = await createStore();
    const { store, directory } = created;
    try {
      const image = createRgbaImage(64, 64);
      const sourcePixelId = 8 * 64 + 8;
      const targetPixelId = 8 * 64 + 24;
      image.data.set([44, 55, 66, 255], sourcePixelId * 4);
      image.data.set([44, 55, 66, 255], targetPixelId * 4);
      const imported = await store.importProject({
        name: "Same RGBA copy fixture",
        skinPng: encodeSkinPng(image),
        armType: "slim",
      });
      const segmented = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.same_rgba",
            displayName: "Same RGBA hair",
            category: "hair",
          },
          spans: pixelIdsToSpans(
            [sourcePixelId, targetPixelId],
            getSkinLayout("slim"),
          ),
        },
      });
      const part = await store.exportPart(
        segmented.revision.id,
        "hair.same_rgba",
      );
      const repair = await store.createPartEditProject({ basePartId: part.id });
      const beforeTexture = await store.readPartEditTexturePng(
        repair.headRevision.id,
      );
      const copied = await store.applyPartEditOperation(repair.project.id, {
        headRevisionId: repair.headRevision.id,
        operation: {
          type: "copy_surfaces",
          source: { kind: "part", partId: part.id },
          mappings: [
            {
              sourceSurface: "head.base.front",
              targetSurface: "head.base.back",
              transform: "identity",
            },
          ],
          overwrite: "all",
        },
      });
      expect(copied.headRevision).toMatchObject({
        changedPixelCount: 0,
        authoredProvenance: {
          changedPixelIds: [],
          originChangedPixelIds: [targetPixelId],
        },
      });
      expect(await store.readPartEditTexturePng(copied.headRevision.id)).toEqual(
        beforeTexture,
      );
      const stored = await store.verifyPartEditStorage(copied.headRevision.id);
      const origin = JSON.parse(
        Buffer.from(stored.files["origin.json"]!.bytes).toString("utf8"),
      ) as PixelOriginDocument;
      expect(getPixelOrigin(origin, targetPixelId)).toMatchObject({
        intrinsicOrigin: "source_visible",
        copyLineage: {
          sourceSubject: { kind: "part", id: part.id },
          sourceComponentInstanceId: part.sourceComponentId,
          sourcePixelId,
        },
      });
      store.close();

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        const persisted = await reopened.verifyPartEditStorage(
          copied.headRevision.id,
        );
        const persistedOrigin = JSON.parse(
          Buffer.from(persisted.files["origin.json"]!.bytes).toString("utf8"),
        ) as PixelOriginDocument;
        expect(getPixelOrigin(persistedOrigin, targetPixelId)?.copyLineage)
          .toMatchObject({
            sourceSubject: { kind: "part", id: part.id },
            sourcePixelId,
          });
        expect(reopened.getPartEditRevision(copied.headRevision.id))
          .toMatchObject({
            authoredProvenance: { originChangedPixelIds: [targetPixelId] },
          });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before the persistence reopen.
      }
    }
  });

  it("isolates repair Revision donors to the target repair project", async () => {
    const { store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const first = await store.createPartEditProject({ basePartId: part.id });
      const firstEdited = await store.applyPartEditOperation(first.project.id, {
        headRevisionId: first.headRevision.id,
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          rgba: [101, 102, 103, 255],
        },
      });
      const second = await store.createPartEditProject({ basePartId: part.id });

      await expect(
        store.applyPartEditOperation(second.project.id, {
          headRevisionId: second.headRevision.id,
          operation: {
            type: "copy_surfaces",
            source: {
              kind: "edit_revision",
              revisionId: firstEdited.headRevision.id,
            },
            mappings: [
              {
                sourceSurface: "head.base.front",
                targetSurface: "head.base.back",
                transform: "identity",
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", statusCode: 400 });

      await expect(
        store.applyPartEditOperation(first.project.id, {
          headRevisionId: firstEdited.headRevision.id,
          operation: {
            type: "copy_surfaces",
            source: {
              kind: "edit_revision",
              revisionId: first.headRevision.id,
            },
            mappings: [
              {
                sourceSurface: "head.base.front",
                targetSurface: "head.base.back",
                transform: "identity",
              },
            ],
          },
        }),
      ).resolves.toMatchObject({ headRevision: { sequence: 3 } });
    } finally {
      store.close();
    }
  });

  it("allows repairing an empty draft but rejects committing an empty part", async () => {
    const { store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const created = await store.createPartEditProject({ basePartId: part.id });
      const erased = await store.applyPartEditOperation(created.project.id, {
        headRevisionId: created.headRevision.id,
        operation: {
          type: "erase_pixels",
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      await expect(
        store.commitPartEditProject(created.project.id, {
          headRevisionId: erased.headRevision.id,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });

      const repainted = await store.applyPartEditOperation(created.project.id, {
        headRevisionId: erased.headRevision.id,
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          rgba: [12, 23, 34, 255],
        },
      });
      await expect(
        store.commitPartEditProject(created.project.id, {
          headRevisionId: repainted.headRevision.id,
        }),
      ).resolves.toMatchObject({ project: { status: "committed" } });
    } finally {
      store.close();
    }
  });

  it("blocks an open repair draft after its base part is retired", async () => {
    const { store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const created = await store.createPartEditProject({ basePartId: part.id });
      const edited = await store.applyPartEditOperation(created.project.id, {
        headRevisionId: created.headRevision.id,
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          rgba: [17, 34, 51, 255],
        },
      });
      await store.retirePart(part.id, "停止从旧部件发布新版");

      await expect(
        store.applyPartEditOperation(created.project.id, {
          headRevisionId: edited.headRevision.id,
          operation: {
            type: "paint_color",
            spans: [{ surface: "head.base.front", y: 8, x0: 10, x1: 10 }],
            rgba: [68, 85, 102, 255],
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      await expect(
        store.commitPartEditProject(created.project.id, {
          headRevisionId: edited.headRevision.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      expect(store.getPartEditProject(created.project.id).status).toBe("draft");
    } finally {
      store.close();
    }
  });

  it("detects tampering in immutable part repair files", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const created = await store.createPartEditProject({ basePartId: part.id });
      await writeFile(
        join(directory, created.headRevision.texture.storagePath),
        Uint8Array.of(1, 2, 3),
      );
      await expect(
        store.readPartEditTexturePng(created.headRevision.id),
      ).rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT" });
    } finally {
      store.close();
    }
  });

  it("rejects tampered Revision, Part, and PartEdit origin artifacts", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const revisionOriginAsset = store
        .getRevisionAssets(imported.revision.id)
        .find((asset) => asset.assetType === "origin_json")!;
      const revisionOriginPath = join(directory, revisionOriginAsset.storagePath);
      const revisionOriginBytes = await readFile(revisionOriginPath);
      await writeFile(revisionOriginPath, "{}\n", "utf8");
      await expect(store.verifyRevisionSnapshot(imported.revision.id)).rejects
        .toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
      await writeFile(revisionOriginPath, revisionOriginBytes);

      const part = await exportHeadPixelPart(store);
      const partOriginPath = join(directory, part.origin!.storagePath);
      const partOriginBytes = await readFile(partOriginPath);
      await writeFile(partOriginPath, "{}\n", "utf8");
      await expect(store.verifyPartStorage(part.id)).rejects.toMatchObject({
        code: "SNAPSHOT_CORRUPT",
        statusCode: 409,
      });
      await writeFile(partOriginPath, partOriginBytes);

      const generatedMaskPath = join(directory, part.generatedMask!.storagePath);
      const generatedMaskBytes = await readFile(generatedMaskPath);
      await writeFile(generatedMaskPath, Uint8Array.of(1, 2, 3));
      await expect(store.verifyPartStorage(part.id)).rejects.toMatchObject({
        code: "SNAPSHOT_CORRUPT",
        statusCode: 409,
      });
      await writeFile(generatedMaskPath, generatedMaskBytes);

      const edit = await store.createPartEditProject({ basePartId: part.id });
      const editOriginPath = join(
        directory,
        edit.headRevision.origin!.storagePath,
      );
      await writeFile(editOriginPath, "{}\n", "utf8");
      await expect(store.verifyPartEditStorage(edit.headRevision.id)).rejects
        .toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });

  it("maps partial PartEdit origin metadata to snapshot corruption", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const originEdit = await store.createPartEditProject({ basePartId: part.id });
      const generatedMaskEdit = await store.createPartEditProject({
        basePartId: part.id,
      });
      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec("DROP TRIGGER part_edit_revision_immutable_update");
        database.prepare(`
          UPDATE part_edit_revision SET origin_byte_size = NULL WHERE id = ?
        `).run(originEdit.headRevision.id);
        database.prepare(`
          UPDATE part_edit_revision SET generated_mask_sha256 = NULL WHERE id = ?
        `).run(generatedMaskEdit.headRevision.id);
      } finally {
        database.close();
      }

      await expect(store.verifyPartEditStorage(originEdit.headRevision.id)).rejects
        .toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
      await expect(
        store.verifyPartEditStorage(generatedMaskEdit.headRevision.id),
      ).rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });

  it("rejects rehashed Part and PartEdit origins with a divergent arm model", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const edit = await store.createPartEditProject({ basePartId: part.id });
      const partOriginPath = join(directory, part.origin!.storagePath);
      const editOriginPath = join(directory, edit.headRevision.origin!.storagePath);
      const partOrigin = JSON.parse(
        await readFile(partOriginPath, "utf8"),
      ) as PixelOriginDocument;
      const editOrigin = JSON.parse(
        await readFile(editOriginPath, "utf8"),
      ) as PixelOriginDocument;
      const tamperedPartOrigin = Buffer.from(
        canonicalJson({
          ...partOrigin,
          source: { ...partOrigin.source, armType: "wide" },
        }),
        "utf8",
      );
      const tamperedEditOrigin = Buffer.from(
        canonicalJson({
          ...editOrigin,
          source: { ...editOrigin.source, armType: "wide" },
        }),
        "utf8",
      );
      await writeFile(partOriginPath, tamperedPartOrigin);
      await writeFile(editOriginPath, tamperedEditOrigin);
      store.close();

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec(`
          DROP TRIGGER part_file_asset_bound_immutable_update;
          DROP TRIGGER part_edit_revision_immutable_update;
        `);
        database.prepare(`
          UPDATE part_file_asset SET byte_size = ?, sha256 = ? WHERE id = ?
        `).run(
          tamperedPartOrigin.byteLength,
          sha256(tamperedPartOrigin),
          part.origin!.id,
        );
        database.prepare(`
          UPDATE part_edit_revision
          SET origin_byte_size = ?, origin_sha256 = ?
          WHERE id = ?
        `).run(
          tamperedEditOrigin.byteLength,
          sha256(tamperedEditOrigin),
          edit.headRevision.id,
        );
      } finally {
        database.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        await expect(reopened.verifyPartStorage(part.id)).rejects.toMatchObject({
          code: "SNAPSHOT_CORRUPT",
          statusCode: 409,
        });
        await expect(reopened.verifyPartEditStorage(edit.headRevision.id)).rejects
          .toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before direct corruption.
      }
    }
  });

  it("rejects tampered Part file-role and owner bindings", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      store.close();
      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec("DROP TRIGGER part_file_asset_bound_immutable_update");
        database.prepare(`
          UPDATE part_file_asset SET part_id = NULL WHERE id = ?
        `).run(part.origin!.id);
        database.prepare(`
          UPDATE part_file_asset
          SET part_id = NULL, file_role = 'texture'
          WHERE id = ?
        `).run(part.generatedMask!.id);
      } finally {
        database.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        await expect(reopened.verifyPartStorage(part.id)).rejects.toMatchObject({
          code: "SNAPSHOT_CORRUPT",
          statusCode: 409,
        });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before direct corruption.
      }
    }
  });

  it("rejects a rehashed Revision origin whose provenance no longer matches resultHash", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const snapshotDirectory = join(
        directory,
        "projects",
        imported.project.id,
        "revisions",
        imported.revision.id,
      );
      const originPath = join(snapshotDirectory, "origin.json");
      const checksumPath = join(snapshotDirectory, "checksum.json");
      const origin = JSON.parse(
        await readFile(originPath, "utf8"),
      ) as PixelOriginDocument;
      const tamperedOrigin = Buffer.from(
        canonicalJson({
          ...origin,
          entries: origin.entries.map((entry) => ({
            ...entry,
            evidence: { sourceRevisionId: "revision_tampered_provenance" },
          })),
        }),
        "utf8",
      );
      await writeFile(originPath, tamperedOrigin);
      const checksum = JSON.parse(await readFile(checksumPath, "utf8")) as {
        schemaVersion: "2.0";
        revisionId: string;
        files: Record<string, string>;
      };
      checksum.files["origin.json"] = sha256(tamperedOrigin);
      await writeFile(checksumPath, canonicalJson(checksum), "utf8");
      store.close();

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec("DROP TRIGGER skin_asset_revision_bound_immutable_update");
        database.prepare(`
          UPDATE skin_asset SET byte_size = ?, sha256 = ? WHERE id = ?
        `).run(
          tamperedOrigin.byteLength,
          sha256(tamperedOrigin),
          imported.revision.originAssetId,
        );
      } finally {
        database.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        const error = await reopened
          .verifyRevisionSnapshot(imported.revision.id)
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
        expect(String(error)).toContain("resultHash");
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before direct corruption.
      }
    }
  });

  it("detects database metadata that diverges from immutable repair JSON", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const created = await store.createPartEditProject({ basePartId: part.id });
      store.close();
      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec("DROP TRIGGER part_edit_revision_immutable_update");
        database
          .prepare("UPDATE part_edit_revision SET summary = ? WHERE id = ?")
          .run("Tampered database summary", created.headRevision.id);
      } finally {
        database.close();
      }
      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        await expect(
          reopened.verifyPartEditStorage(created.headRevision.id),
        ).rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before direct corruption.
      }
    }
  });

  it("rejects invalid nested metadata in a repaired part manifest", async () => {
    const { directory, store } = await createStore();

    try {
      const basePart = await exportHeadPixelPart(store);
      const repair = await store.createPartEditProject({ basePartId: basePart.id });
      const committed = await store.commitPartEditProject(repair.project.id, {
        headRevisionId: repair.headRevision.id,
      });
      expect(committed.part.manifest.schemaVersion).toBe("2.0");
      store.close();

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec("DROP TRIGGER part_asset_content_immutable_update");
        const row = database
          .prepare("SELECT manifest_json FROM part_asset WHERE id = ?")
          .get(committed.part.id) as { readonly manifest_json: string };
        const manifest = JSON.parse(row.manifest_json) as {
          compatibility: { armTypes: string[] };
        };
        manifest.compatibility.armTypes = [];
        database
          .prepare("UPDATE part_asset SET manifest_json = ? WHERE id = ?")
          .run(JSON.stringify(manifest), committed.part.id);
      } finally {
        database.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        expect(() => reopened.getPart(committed.part.id)).toThrow(
          expect.objectContaining({ code: "SNAPSHOT_CORRUPT", statusCode: 409 }),
        );
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before direct corruption.
      }
    }
  });

  it("rejects a rehashed Part 2.0 repair derivation summary mismatch", async () => {
    const { directory, store } = await createStore();

    try {
      const basePart = await exportHeadPixelPart(store);
      const repair = await store.createPartEditProject({ basePartId: basePart.id });
      const committed = await store.commitPartEditProject(repair.project.id, {
        headRevisionId: repair.headRevision.id,
      });
      const manifestPath = join(directory, committed.part.manifestFile.storagePath);
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as {
        derivation: { containsGeneratedPixels: boolean };
      };
      manifest.derivation.containsGeneratedPixels = true;
      const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
      await writeFile(manifestPath, manifestBytes);
      store.close();

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec(`
          DROP TRIGGER part_asset_content_immutable_update;
          DROP TRIGGER part_file_asset_bound_immutable_update;
        `);
        database.prepare(`
          UPDATE part_asset SET manifest_json = ? WHERE id = ?
        `).run(canonicalJson(manifest).trim(), committed.part.id);
        database.prepare(`
          UPDATE part_file_asset
          SET byte_size = ?, sha256 = ?
          WHERE id = ?
        `).run(
          manifestBytes.byteLength,
          sha256(manifestBytes),
          committed.part.manifestFile.id,
        );
      } finally {
        database.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        await expect(reopened.verifyPartStorage(committed.part.id)).rejects
          .toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before direct corruption.
      }
    }
  });

  it("round-trips a valid generated Part origin through repair artifacts", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const originPath = join(directory, part.origin!.storagePath);
      const generatedMaskPath = join(directory, part.generatedMask!.storagePath);
      const manifestPath = join(directory, part.manifestFile.storagePath);
      const origin = JSON.parse(
        await readFile(originPath, "utf8"),
      ) as PixelOriginDocument;
      const generatedOrigin: PixelOriginDocument = {
        ...origin,
        entries: origin.entries.map((entry) => ({
          intrinsicOrigin: "generated_completion" as const,
          evidence: {
            candidateId: "candidate_generated_fixture",
            evidenceHash: `sha256:${"a".repeat(64)}`,
            decisionId: "decision_generated_fixture",
            actor: { type: "system" as const },
          },
          spans: entry.spans,
        })),
        copyLineage: [],
      };
      const originBytes = Buffer.from(canonicalJson(generatedOrigin), "utf8");
      const generatedMaskBytes = await readFile(
        join(directory, part.writeMask.storagePath),
      );
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as {
        origin: {
          summary: {
            counts: Record<string, number>;
            containsGeneratedPixels: boolean;
          };
          containsGeneratedPixels: boolean;
        };
      };
      manifest.origin.summary = {
        counts: {
          source_visible: 0,
          manual_authored: 0,
          generated_completion: 1,
          legacy_mixed: 0,
        },
        containsGeneratedPixels: true,
      };
      manifest.origin.containsGeneratedPixels = true;
      const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
      await writeFile(originPath, originBytes);
      await writeFile(generatedMaskPath, generatedMaskBytes);
      await writeFile(manifestPath, manifestBytes);
      store.close();

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        database.exec(`
          DROP TRIGGER part_asset_content_immutable_update;
          DROP TRIGGER part_file_asset_bound_immutable_update;
        `);
        database.prepare(
          "UPDATE part_asset SET manifest_json = ? WHERE id = ?",
        ).run(canonicalJson(manifest).trim(), part.id);
        const updateFile = database.prepare(`
          UPDATE part_file_asset SET byte_size = ?, sha256 = ? WHERE id = ?
        `);
        updateFile.run(originBytes.byteLength, sha256(originBytes), part.origin!.id);
        updateFile.run(
          generatedMaskBytes.byteLength,
          sha256(generatedMaskBytes),
          part.generatedMask!.id,
        );
        updateFile.run(
          manifestBytes.byteLength,
          sha256(manifestBytes),
          part.manifestFile.id,
        );
      } finally {
        database.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        await expect(reopened.verifyPartStorage(part.id)).resolves
          .toMatchObject({ files: { "generated-mask.png": expect.any(Object) } });
        const repair = await reopened.createPartEditProject({ basePartId: part.id });
        expect(repair.headRevision.authoredProvenance).toMatchObject({
          containsGeneratedPixels: true,
          originSummary: {
            counts: { generated_completion: 1 },
          },
        });
        const editStorage = await reopened.verifyPartEditStorage(
          repair.headRevision.id,
        );
        const editOrigin = JSON.parse(
          Buffer.from(editStorage.files["origin.json"]!.bytes).toString("utf8"),
        ) as PixelOriginDocument;
        expect(getPixelOrigin(editOrigin, 8 * 64 + 8)).toMatchObject({
          intrinsicOrigin: "generated_completion",
          copyLineage: {
            sourceSubject: { kind: "part", id: part.id },
          },
        });
        const committed = await reopened.commitPartEditProject(repair.project.id, {
          headRevisionId: repair.headRevision.id,
        });
        expect(committed.part.manifest).toMatchObject({
          schemaVersion: "2.0",
          derivation: { containsGeneratedPixels: true },
          origin: { containsGeneratedPixels: true },
        });
        await expect(reopened.verifyPartStorage(committed.part.id)).resolves
          .toMatchObject({ files: { "generated-mask.png": expect.any(Object) } });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before constructing the fixture.
      }
    }
  });

  it("commits a confirmed semantic edit as a new immutable revision", async () => {
    const { store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const edited = await store.applyManualOperation(imported.revision.id, {
        summary: "标记头发测试区域",
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.main",
            displayName: "主头发",
            category: "hair",
          },
          spans: [
            { surface: "head.base.front", y: 8, x0: 8, x1: 9 },
          ],
        },
      });

      expect(edited.revision).toMatchObject({
        parentRevisionId: imported.revision.id,
        sequence: 2,
        operationType: "manual_edit",
        summary: "标记头发测试区域",
      });
      expect(store.getRevisionAssets(edited.revision.id)).toHaveLength(6);
      const state = await store.readRevisionSemanticState(edited.revision.id);
      expect(state.document.components).toMatchObject([
        {
          instanceId: "hair.main",
          category: "hair",
          maskFile: "components/hair.main.mask.png",
          spans: [
            { surface: "head.base.front", y: 8, x0: 8, x1: 9 },
          ],
        },
      ]);
      expect(state.document.unknown.pixelCount).toBeGreaterThan(0);
      const operation = await store.readRevisionOperation(edited.revision.id);
      expect(operation).toMatchObject({
        type: "manual_edit",
        inputRevisionId: imported.revision.id,
        affectedComponents: ["hair.main"],
      });

      await expect(
        store.applyManualOperation(imported.revision.id, {
          operation: {
            type: "reclassify_component",
            componentId: "hair.main",
            category: "head_accessory",
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      store.close();
    }
  });

  it("materializes host component IDs before persistence and commits symmetric relations once", async () => {
    const { store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const first = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { displayName: "Host hair", category: "hair" },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      expect(first.generatedComponentId).toMatch(/^component_/u);
      const firstOperation = await store.readRevisionOperation(first.revision.id);
      expect(firstOperation.metadata).toMatchObject({
        operation: {
          type: "assign_pixels",
          target: { instanceId: first.generatedComponentId },
        },
      });
      const second = await store.applyManualOperation(first.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { displayName: "Host accessory", category: "head_accessory" },
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
        },
      });
      expect(second.generatedComponentId).not.toBe(first.generatedComponentId);
      const third = await store.applyManualOperation(second.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { displayName: "Host third", category: "head_accessory" },
          spans: [{ surface: "head.base.front", y: 8, x0: 10, x1: 10 }],
        },
      });
      expect(third.generatedComponentId).toMatch(/^component_/u);

      const related = await store.applyManualOperation(third.revision.id, {
        operation: {
          type: "set_component_relations",
          componentId: first.generatedComponentId!,
          relations: {
            attachedTo: second.generatedComponentId!,
            pairedWith: [second.generatedComponentId!],
            sameOutfitGroup: "outfit.host",
            conflictsWith: [second.generatedComponentId!],
          },
        },
      });
      const state = await store.readRevisionSemanticState(related.revision.id);
      const byId = new Map(
        state.document.components.map((component) => [component.instanceId, component]),
      );
      expect(byId.get(first.generatedComponentId!)!.relations).toEqual({
        attachedTo: second.generatedComponentId,
        pairedWith: [second.generatedComponentId],
        sameOutfitGroup: "outfit.host",
        conflictsWith: [second.generatedComponentId],
      });
      expect(byId.get(second.generatedComponentId!)!.relations).toMatchObject({
        attachedTo: null,
        pairedWith: [first.generatedComponentId],
        conflictsWith: [first.generatedComponentId],
      });
      expect((await store.readRevisionOperation(related.revision.id)).affectedComponents)
        .toEqual([
          first.generatedComponentId!,
          second.generatedComponentId!,
        ].sort());

      const replaced = await store.applyManualOperation(related.revision.id, {
        operation: {
          type: "set_component_relations",
          componentId: first.generatedComponentId!,
          relations: {
            attachedTo: third.generatedComponentId!,
            pairedWith: [third.generatedComponentId!],
            sameOutfitGroup: "outfit.replaced",
            conflictsWith: [third.generatedComponentId!],
          },
        },
      });
      const replacedState = await store.readRevisionSemanticState(
        replaced.revision.id,
      );
      const replacedById = new Map(
        replacedState.document.components.map((component) => [
          component.instanceId,
          component,
        ]),
      );
      expect(replacedById.get(second.generatedComponentId!)!.relations)
        .toMatchObject({ pairedWith: [], conflictsWith: [] });
      expect(replacedById.get(third.generatedComponentId!)!.relations)
        .toMatchObject({
          pairedWith: [first.generatedComponentId],
          conflictsWith: [first.generatedComponentId],
        });
      const replacedOperation = await store.readRevisionOperation(
        replaced.revision.id,
      );
      expect(replacedOperation.affectedComponents).toEqual([
        first.generatedComponentId!,
        second.generatedComponentId!,
        third.generatedComponentId!,
      ].sort());
      expect(new Set(replacedOperation.affectedComponents).size).toBe(
        replacedOperation.affectedComponents.length,
      );

      await expect(store.applyManualOperation(replaced.revision.id, {
        operation: {
          type: "set_component_relations",
          componentId: first.generatedComponentId!,
          relations: {
            attachedTo: third.generatedComponentId!,
            pairedWith: [third.generatedComponentId!],
            sameOutfitGroup: "outfit.replaced",
            conflictsWith: [third.generatedComponentId!],
          },
        },
      })).rejects.toMatchObject({ code: "INVALID_INPUT", statusCode: 400 });
    } finally {
      store.close();
    }
  });

  it("exports and reloads a reusable 64x64 semantic part", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const edited = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.main",
            displayName: "主头发",
            category: "hair",
          },
          spans: [
            { surface: "head.base.front", y: 8, x0: 8, x1: 9 },
          ],
        },
      });
      const part = await store.exportPart(
        edited.revision.id,
        "hair.main",
        { name: "可复用头发" },
      );

      expect(part).toMatchObject({
        sourceProjectId: imported.project.id,
        sourceRevisionId: edited.revision.id,
        sourceComponentId: "hair.main",
        name: "可复用头发",
        category: "hair",
        armType: "slim",
        manifest: {
          compatibility: { armTypes: ["wide", "slim"] },
          maskMode: "write-colored-pixels-only",
        },
      });
      expect(store.listParts()).toEqual([part]);
      expect(store.listParts("hair")).toEqual([part]);
      expect(store.listParts("shoe")).toEqual([]);
      expect((await readdir(join(directory, "parts", part.id))).sort()).toEqual([
        "generated-mask.png",
        "manifest.json",
        "origin.json",
        "preview.png",
        "source.json",
        "texture.png",
        "write-mask.png",
      ]);

      const texture = decodeSkinPng(await store.readPartTexturePng(part.id));
      const writeMask = rgbaImageToMask(
        decodeSkinPng(
          (await store.verifyPartStorage(part.id)).files["write-mask.png"].bytes,
        ),
      );
      const partOrigin = JSON.parse(
        Buffer.from(
          (await store.verifyPartStorage(part.id)).files["origin.json"]!.bytes,
        ).toString("utf8"),
      ) as PixelOriginDocument;
      expect(partOrigin.subject).toEqual({ kind: "part", id: part.id });
      expect(getPixelOrigin(partOrigin, 8 * 64 + 8)).toMatchObject({
        intrinsicOrigin: "source_visible",
        copyLineage: {
          sourceSubject: { kind: "revision", id: edited.revision.id },
          sourceComponentInstanceId: "hair.main",
          sourcePixelId: 8 * 64 + 8,
        },
      });
      const sourceSkin = decodeSkinPng(
        await store.readRevisionSkinPng(edited.revision.id),
      );
      expect(maskToPixelIds(writeMask)).toEqual([8 * 64 + 8, 8 * 64 + 9]);
      expect(getPixel(texture, 8, 8)).toEqual(getPixel(sourceSkin, 8, 8));
      expect(getPixel(texture, 10, 8)).toEqual([0, 0, 0, 0]);
      const mannequin = decodeSkinPng(
        await store.readPartMannequinPng(part.id, "slim"),
      );
      expect(getPixel(mannequin, 8, 8)).toEqual(getPixel(sourceSkin, 8, 8));
      expect(getPixel(mannequin, 10, 8)).toEqual([226, 229, 224, 255]);

      const preview = await store.previewPartApplication(
        edited.revision.id,
        part.id,
      );
      expect(preview.report).toMatchObject({
        compatible: true,
        hardConflictCount: 0,
        sameColorOverlapCount: 2,
        writePixelCount: 2,
      });
    } finally {
      store.close();
    }
  });

  it("exports fine components as one immutable aggregate bundle", async () => {
    const { store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const first = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "outfit.top",
            displayName: "上装",
            category: "upper_clothing",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      const second = await store.applyManualOperation(first.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "outfit.glove",
            displayName: "手套",
            category: "glove",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
        },
      });
      const bundle = await store.exportPartBundle(second.revision.id, {
        name: "整套服装",
        kind: "clothing",
        componentIds: ["outfit.top", "outfit.glove"],
      });

      expect(bundle).toMatchObject({
        name: "整套服装",
        kind: "clothing",
        sourceRevisionId: second.revision.id,
        sourceGroupKey: null,
        armTypes: ["wide", "slim"],
      });
      expect(bundle.members.map((member) => member.part.sourceComponentId)).toEqual([
        "outfit.top",
        "outfit.glove",
      ]);
      expect(store.listPartBundles("clothing", second.revision.id)).toEqual([bundle]);
      expect(decodeSkinPng(await store.readPartBundlePreviewPng(bundle.id))).toMatchObject({
        width: 64,
        height: 64,
      });
      expect(getPixel(decodeSkinPng(await store.readPartBundleMannequinPng(bundle.id, "slim")), 10, 8)).toEqual([
        226, 229, 224, 255,
      ]);

      const target = await store.importProject({
        name: "Bundle target",
        skinPng: encodeSkinPng(createRgbaImage(64, 64)),
        armType: "slim",
      });
      const composition = await store.createComposition({
        baseRevisionId: target.revision.id,
      });
      const detail = await store.addCompositionBundle(composition.composition.id, {
        bundleId: bundle.id,
      });
      expect(detail.layers.map((layer) => layer.partId)).toEqual(
        bundle.members.map((member) => member.partId),
      );
      expect(detail.layers.map((layer) => layer.position)).toEqual([0, 1]);
    } finally {
      store.close();
    }
  });

  it("preserves Wide origin ownership for a model-neutral Bundle member and repair", async () => {
    const { store } = await createStore();
    try {
      const image = createRgbaImage(64, 64);
      image.data.set([45, 67, 89, 255], (8 * 64 + 8) * 4);
      const imported = await store.importProject({
        name: "Wide neutral bundle",
        skinPng: encodeSkinPng(image),
        armType: "wide",
      });
      const segmented = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.wide_neutral",
            displayName: "Wide neutral hair",
            category: "hair",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      const bundle = await store.exportPartBundle(segmented.revision.id, {
        kind: "hair",
        componentIds: ["hair.wide_neutral"],
      });
      const part = bundle.members[0]!.part;
      expect(part).toMatchObject({
        armType: "wide",
        manifest: { compatibility: { armTypes: ["wide", "slim"] } },
      });
      const storedPart = await store.verifyPartStorage(part.id);
      const partOrigin = JSON.parse(
        Buffer.from(storedPart.files["origin.json"]!.bytes).toString("utf8"),
      ) as PixelOriginDocument;
      expect(partOrigin.source.armType).toBe("wide");

      const repair = await store.createPartEditProject({ basePartId: part.id });
      const edited = await store.applyPartEditOperation(repair.project.id, {
        headRevisionId: repair.headRevision.id,
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          rgba: [12, 34, 56, 255],
        },
      });
      const committed = await store.commitPartEditProject(repair.project.id, {
        headRevisionId: edited.headRevision.id,
      });
      expect(committed.part.armType).toBe("wide");
      await expect(store.verifyPartStorage(committed.part.id)).resolves
        .toMatchObject({ files: { "origin.json": expect.any(Object) } });
    } finally {
      store.close();
    }
  });

  it("rejects an invalid aggregate export without leaving atomic parts", async () => {
    const { store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const edited = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { instanceId: "hair.main", displayName: "头发", category: "hair" },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      await expect(
        store.exportPartBundle(edited.revision.id, {
          kind: "clothing",
          componentIds: ["hair.main"],
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(store.listParts()).toEqual([]);
      expect(store.listPartBundles()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("soft-retires library assets, filters provenance, and preserves immutable reads", async () => {
    const { store } = await createStore();
    try {
      const part = await exportHeadPixelPart(store);
      expect(part).toMatchObject({
        libraryStatus: "active",
        retiredAt: null,
        retiredReason: null,
        sourceProjectName: expect.stringContaining("Repair fixture"),
        sourceBranchName: "main",
        sourceRevisionSequence: 2,
      });
      expect(store.listParts({ q: "Repair fixture", status: "all" })).toEqual([part]);
      const retired = await store.retirePart(part.id, "识别错误");
      expect(retired).toMatchObject({ libraryStatus: "retired", retiredReason: "识别错误" });
      expect(retired.retiredAt).not.toBeNull();
      expect(store.listParts()).toEqual([]);
      expect(store.listParts({ status: "retired", projectId: part.sourceProjectId })).toEqual([retired]);
      expect(await store.readPartTexturePng(part.id)).toEqual(await store.readPartTexturePng(retired.id));
      await expect(store.createPartEditProject({ basePartId: part.id })).rejects.toMatchObject({
        code: "CONFLICT",
        statusCode: 409,
      });
      expect(await store.restorePart(part.id)).toMatchObject({ libraryStatus: "active", retiredAt: null });
    } finally {
      store.close();
    }
  });

  it("migrates existing assets to active lifecycle defaults and guards invalid state", async () => {
    const { directory, store } = await createStore();
    try {
      const part = await exportHeadPixelPart(store);
      store.close();
      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        expect(database.prepare("SELECT MAX(version) AS version FROM schema_migration").get())
          .toEqual({ version: 16 });
        expect(database.prepare("SELECT library_status, retired_at, retired_reason FROM part_asset WHERE id = ?").get(part.id))
          .toEqual({ library_status: "active", retired_at: null, retired_reason: null });
        expect(() => database.prepare(
          "UPDATE part_asset SET retired_reason = 'tampered' WHERE id = ?",
        ).run(part.id)).toThrow(/invalid part_asset lifecycle state/);
      } finally {
        database.close();
      }
      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        expect(reopened.getPart(part.id)).toMatchObject({ libraryStatus: "active" });
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("binds snapshot assets once and freezes finalized revision history", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const revision = imported.revision;
      const assets = store.getRevisionAssets(revision.id);
      expect(assets.length).toBeGreaterThanOrEqual(3);
      expect(assets.every((asset) => asset.revisionId === revision.id)).toBe(true);

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        const operation = database.prepare(
          "SELECT id FROM skin_operation WHERE revision_id = ?",
        ).get(revision.id) as { readonly id: string };
        const assetId = assets[0]!.id;

        expect(() => database.prepare(
          "UPDATE skin_revision SET summary = 'tampered' WHERE id = ?",
        ).run(revision.id)).toThrow(/skin_revision is immutable/u);
        expect(() => database.prepare(
          "DELETE FROM skin_revision WHERE id = ?",
        ).run(revision.id)).toThrow(/skin_revision is immutable/u);
        expect(() => database.prepare(
          "UPDATE skin_operation SET summary = 'tampered' WHERE id = ?",
        ).run(operation.id)).toThrow(/skin_operation is immutable/u);
        expect(() => database.prepare(
          "DELETE FROM skin_operation WHERE id = ?",
        ).run(operation.id)).toThrow(/skin_operation is immutable/u);
        expect(() => database.prepare(
          `UPDATE skin_asset
           SET sha256 = ?
           WHERE id = ?`,
        ).run(`sha256:${"f".repeat(64)}`, assetId)).toThrow(
          /revision-bound skin_asset is immutable/u,
        );
        expect(() => database.prepare(
          "DELETE FROM skin_asset WHERE id = ?",
        ).run(assetId)).toThrow(/revision-bound skin_asset is immutable/u);

        const orphanId = "asset_orphan_binding";
        database.prepare(`
          INSERT INTO skin_asset (
            id, project_id, revision_id, asset_type, storage_path,
            mime_type, byte_size, sha256, created_at
          ) VALUES (?, ?, NULL, 'component_mask', ?, 'image/png', 0, ?, ?)
        `).run(
          orphanId,
          imported.project.id,
          `projects/${imported.project.id}/revisions/${revision.id}/components/orphan.mask.png`,
          `sha256:${"0".repeat(64)}`,
          revision.createdAt,
        );
        expect(() => database.prepare(
          "UPDATE skin_asset SET revision_id = ? WHERE id = ?",
        ).run(revision.id, orphanId)).toThrow(/invalid skin_asset revision binding/u);
        expect(database.prepare("DELETE FROM skin_asset WHERE id = ?").run(orphanId).changes)
          .toBe(1);

        expect(database.prepare(
          "UPDATE skin_project SET updated_at = updated_at WHERE id = ?",
        ).run(imported.project.id).changes).toBe(1);
        expect(database.prepare(
          "UPDATE skin_branch SET head_revision_id = head_revision_id WHERE id = ?",
        ).run(imported.branch.id).changes).toBe(1);
      } finally {
        database.close();
      }

      expect(store.getRevision(revision.id)).toMatchObject({
        id: revision.id,
        summary: revision.summary,
      });
    } finally {
      store.close();
    }
  });

  it("freezes Part content while preserving lifecycle and repair-head workflows", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const repair = await store.createPartEditProject({ basePartId: part.id });
      const bundle = await store.exportPartBundle(part.sourceRevisionId, {
        name: "Immutable hair bundle",
        kind: "hair",
        componentIds: [part.sourceComponentId],
      });

      expect(await store.retirePart(part.id, "immutability lifecycle test"))
        .toMatchObject({ libraryStatus: "retired" });
      expect(await store.restorePart(part.id)).toMatchObject({ libraryStatus: "active" });
      expect(await store.retirePartBundle(bundle.id, "immutability lifecycle test"))
        .toMatchObject({ libraryStatus: "retired" });
      expect(await store.restorePartBundle(bundle.id)).toMatchObject({ libraryStatus: "active" });

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        const fileRows = database.prepare(
          "SELECT id, part_id FROM part_file_asset WHERE part_id = ? ORDER BY file_role",
        ).all(part.id) as Array<{ readonly id: string; readonly part_id: string }>;
        expect(fileRows).toHaveLength(7);
        expect(fileRows.every((row) => row.part_id === part.id)).toBe(true);

        expect(() => database.prepare(
          "UPDATE part_asset SET name = 'tampered' WHERE id = ?",
        ).run(part.id)).toThrow(/part_asset content is immutable/u);
        expect(() => database.prepare(
          "DELETE FROM part_asset WHERE id = ?",
        ).run(part.id)).toThrow(/part_asset is immutable/u);
        expect(() => database.prepare(
          "UPDATE part_file_asset SET byte_size = byte_size + 1 WHERE id = ?",
        ).run(fileRows[0]!.id)).toThrow(/part-bound part_file_asset is immutable/u);
        expect(() => database.prepare(
          "DELETE FROM part_file_asset WHERE id = ?",
        ).run(fileRows[0]!.id)).toThrow(/part-bound part_file_asset is immutable/u);
        expect(() => database.prepare(
          "UPDATE part_edit_revision SET summary = 'tampered' WHERE id = ?",
        ).run(repair.headRevision.id)).toThrow(/part_edit_revision is immutable/u);
        expect(() => database.prepare(
          "DELETE FROM part_edit_revision WHERE id = ?",
        ).run(repair.headRevision.id)).toThrow(/part_edit_revision is immutable/u);
        expect(() => database.prepare(
          "UPDATE part_bundle SET name = 'tampered' WHERE id = ?",
        ).run(bundle.id)).toThrow(/part_bundle content is immutable/u);
        expect(() => database.prepare(
          "DELETE FROM part_bundle WHERE id = ?",
        ).run(bundle.id)).toThrow(/part_bundle is immutable/u);
        expect(() => database.prepare(
          "UPDATE part_bundle_member SET position = position + 1 WHERE bundle_id = ?",
        ).run(bundle.id)).toThrow(/part_bundle_member is immutable/u);
        expect(() => database.prepare(
          "DELETE FROM part_bundle_member WHERE bundle_id = ?",
        ).run(bundle.id)).toThrow(/part_bundle_member is immutable/u);

        expect(database.prepare(
          "UPDATE part_edit_project SET updated_at = updated_at WHERE id = ?",
        ).run(repair.project.id).changes).toBe(1);
      } finally {
        database.close();
      }

      expect(store.getPart(part.id)).toMatchObject({ id: part.id, name: part.name });
      expect(store.getPartBundle(bundle.id)).toMatchObject({ id: bundle.id, name: bundle.name });
    } finally {
      store.close();
    }
  });

  it("upgrades populated v15 Completion proposals without rewriting their candidate set", async () => {
    const fixture = await createPopulatedV15CompletionFixture();
    const legacy = new Database(join(fixture.directory, "mcskinsplit.sqlite"));
    try {
      expect(legacy.prepare(
        "SELECT MAX(version) AS version FROM schema_migration",
      ).get()).toEqual({ version: 15 });
      expect(legacy.prepare(`
        SELECT count(*) AS count FROM completion_candidate
        WHERE proposal_id = ?
      `).get(fixture.proposal.proposalId)).toEqual({
        count: fixture.proposal.candidates.length,
      });
      expect(legacy.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'completion_candidate_edit'
      `).get()).toBeUndefined();
    } finally {
      legacy.close();
    }

    const upgraded = new RevisionStore({ dataDirectory: fixture.directory });
    try {
      const detail = await upgraded.getCompletionProposalDetail(
        fixture.proposal.proposalId,
      );
      expect(detail).toMatchObject({
        status: "awaiting_decision",
        candidateCount: fixture.proposal.candidates.length,
      });
      expect(detail.candidates.every(
        (candidate) => candidate.baseCandidateId === null,
      )).toBe(true);
      const database = new Database(upgraded.databasePath);
      try {
        expect(database.prepare(
          "SELECT MAX(version) AS version FROM schema_migration",
        ).get()).toEqual({ version: 16 });
        expect(database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'completion_candidate_edit'
        `).get()).toEqual({ name: "completion_candidate_edit" });
        const candidateGuard = database.prepare(`
          SELECT sql FROM sqlite_master
          WHERE type = 'trigger' AND name = 'completion_candidate_insert_guard'
        `).get() as { readonly sql: string };
        expect(candidateGuard.sql).toContain("NEW.strategy <> 'manual_edit'");
        expect(candidateGuard.sql).toContain(
          "json_type(NEW.candidate_json, '$.baseCandidateId') = 'null'",
        );
        expect(database.pragma("foreign_key_check")).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("rolls migration 16 back atomically when a populated v15 candidate set is incomplete", async () => {
    const fixture = await createPopulatedV15CompletionFixture();
    const databasePath = join(fixture.directory, "mcskinsplit.sqlite");
    const corrupt = new Database(databasePath);
    try {
      corrupt.exec("DROP TRIGGER completion_candidate_immutable_delete");
      expect(corrupt.prepare(
        "DELETE FROM completion_candidate WHERE id = ?",
      ).run(fixture.proposal.candidates[0]!.candidateId).changes).toBe(1);
    } finally {
      corrupt.close();
    }

    expect(() => new RevisionStore({ dataDirectory: fixture.directory }))
      .toThrow(/CHECK constraint failed/u);

    const rolledBack = new Database(databasePath);
    try {
      expect(rolledBack.prepare(
        "SELECT MAX(version) AS version FROM schema_migration",
      ).get()).toEqual({ version: 15 });
      expect(rolledBack.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'completion_candidate_edit'
      `).get()).toBeUndefined();
      const candidateGuard = rolledBack.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'completion_candidate_insert_guard'
      `).get() as { readonly sql: string };
      expect(candidateGuard.sql).toContain("job.status = 'validating'");
      expect(candidateGuard.sql).not.toContain("completion_candidate_edit");
    } finally {
      rolledBack.close();
    }
  });

  it("upgrades populated v13 Revisions and Part 1.0/1.1 rows without inventing origin", async () => {
    const fixture = await createPopulatedV13Fixture();
    const store = new RevisionStore({ dataDirectory: fixture.directory });

    try {
      const database = new Database(store.databasePath);
      try {
        expect(database.prepare(
          "SELECT MAX(version) AS version FROM schema_migration",
        ).get()).toEqual({ version: 16 });
        expect(database.prepare(
          "SELECT origin_asset_id FROM skin_revision WHERE id = ?",
        ).get(fixture.revisionId)).toEqual({ origin_asset_id: null });
        expect(database.prepare(`
          SELECT origin_asset_id, generated_mask_asset_id
          FROM part_asset WHERE id = ?
        `).get(fixture.partV1Id)).toEqual({
          origin_asset_id: null,
          generated_mask_asset_id: null,
        });
        const revisionSql = database.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skin_revision'",
        ).get() as { readonly sql: string };
        const jobSql = database.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_job'",
        ).get() as { readonly sql: string };
        expect(revisionSql.sql).toContain("completion_accept");
        expect(jobSql.sql).toContain("completion_proposal");
        expect(database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'completion_%'
          ORDER BY name
        `).all()).toEqual([
          { name: "completion_candidate" },
          { name: "completion_candidate_edit" },
          { name: "completion_decision" },
          { name: "completion_proposal" },
          { name: "completion_proposal_ranking" },
          { name: "completion_result" },
          { name: "completion_result_publication" },
        ]);
        expect(database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name IN (
            'skin_asset_revision_binding_guard',
            'semantic_analysis_followup_insert_guard',
            'semantic_analysis_followup_applied_revision_insert_guard',
            'semantic_analysis_followup_applied_revision_update_guard',
            'semantic_analysis_followup_job_success_guard'
          ) ORDER BY name
        `).all()).toHaveLength(5);
        expect(database.pragma("foreign_key_check")).toEqual([]);
      } finally {
        database.close();
      }

      expect(store.getRevision(fixture.revisionId).originAssetId).toBeNull();
      expect(await store.readRevisionOrigin(fixture.revisionId)).toBeNull();
      await expect(store.verifyRevisionSnapshot(fixture.revisionId)).resolves
        .toMatchObject({ checksum: { schemaVersion: "1.0" } });
      expect(store.getPart(fixture.partV1Id)).toMatchObject({
        manifest: { schemaVersion: "1.0" },
        origin: null,
        generatedMask: null,
      });
      expect(store.getPart(fixture.partV1_1Id)).toMatchObject({
        manifest: { schemaVersion: "1.1" },
        origin: null,
        generatedMask: null,
      });
      expect((await store.verifyPartStorage(fixture.partV1Id)).files)
        .not.toHaveProperty("origin.json");
      expect((await store.verifyPartStorage(fixture.partV1_1Id)).files)
        .not.toHaveProperty("generated-mask.png");
      expect(store.getPartEditProject(fixture.partEditProjectId)).toMatchObject({
        headRevisionId: fixture.partEditRevisionId,
        basePartId: fixture.partV1Id,
      });
      expect(store.getPartEditRevision(fixture.partEditRevisionId)).toMatchObject({
        origin: null,
        generatedMask: null,
      });
      const migratedLegacyEdit = await store.verifyPartEditStorage(
        fixture.partEditRevisionId,
      );
      expect(Object.keys(migratedLegacyEdit.files).sort()).toEqual([
        "revision.json",
        "texture.png",
        "write-mask.png",
      ]);
      const continuedLegacyEdit = await store.applyPartEditOperation(
        fixture.partEditProjectId,
        {
          headRevisionId: fixture.partEditRevisionId,
          operation: {
            type: "paint_color",
            spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
            rgba: [9, 8, 7, 255],
          },
        },
      );
      expect(continuedLegacyEdit.headRevision.origin).not.toBeNull();
      expect(continuedLegacyEdit.headRevision.generatedMask).not.toBeNull();
      expect(Object.keys((await store.verifyPartEditStorage(
        continuedLegacyEdit.headRevision.id,
      )).files).sort()).toEqual([
        "generated-mask.png",
        "origin.json",
        "revision.json",
        "texture.png",
        "write-mask.png",
      ]);

      const legacyRepair = await store.createPartEditProject({
        basePartId: fixture.partV1Id,
      });
      const legacyEditStorage = await store.verifyPartEditStorage(
        legacyRepair.headRevision.id,
      );
      const legacyEditOrigin = JSON.parse(
        Buffer.from(legacyEditStorage.files["origin.json"]!.bytes).toString("utf8"),
      ) as PixelOriginDocument;
      expect(getPixelOrigin(legacyEditOrigin, fixture.pixelId)).toMatchObject({
        intrinsicOrigin: "legacy_mixed",
        evidence: { sourceRevisionId: fixture.revisionId },
        copyLineage: {
          sourceSubject: { kind: "part", id: fixture.partV1Id },
          sourcePixelId: fixture.pixelId,
        },
      });

      const applied = await store.applyPart(fixture.revisionId, {
        partId: fixture.partV1Id,
        strategy: "use_part",
      });
      expect(applied.revision.originAssetId).not.toBeNull();
      const appliedOrigin = await store.readRevisionOrigin(applied.revision.id);
      expect(getPixelOrigin(appliedOrigin!, fixture.pixelId)).toMatchObject({
        intrinsicOrigin: "legacy_mixed",
        evidence: { sourceRevisionId: fixture.revisionId },
        copyLineage: {
          sourceSubject: { kind: "part", id: fixture.partV1Id },
          sourcePixelId: fixture.pixelId,
        },
      });
      expect(
        await store.diffRevisions(fixture.revisionId, applied.revision.id),
      ).toMatchObject({
        changedPixelCount: 0,
        changedPixelIds: [],
        originChangedPixelCount: 1,
        originChangedPixelIds: [fixture.pixelId],
        boundingBox: null,
      });
      expect(applied.revision.resultHash).not.toBe(
        store.getRevision(fixture.revisionId).resultHash,
      );
      const reopened = new RevisionStore({ dataDirectory: fixture.directory });
      try {
        await expect(reopened.verifyRevisionSnapshot(applied.revision.id)).resolves
          .toMatchObject({ checksum: { schemaVersion: "2.0" } });
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("rejects rogue file bindings added to a migrated legacy Part", async () => {
    const fixture = await createPopulatedV13Fixture();
    const store = new RevisionStore({ dataDirectory: fixture.directory });
    const rogueBytes = Buffer.from("{}", "utf8");
    const insertRogue = `
      INSERT INTO part_file_asset (
        id, part_id, file_role, storage_path, mime_type,
        byte_size, sha256, created_at
      ) VALUES (?, ?, 'origin', ?, 'application/json', ?, ?, ?)
    `;

    try {
      await expect(store.verifyPartStorage(fixture.partV1Id)).resolves.toBeDefined();
      const database = new Database(store.databasePath);
      try {
        expect(() => database.prepare(insertRogue).run(
          "asset_legacy_rogue_origin",
          fixture.partV1Id,
          `parts/${fixture.partV1Id}/rogue-origin.json`,
          rogueBytes.byteLength,
          sha256(rogueBytes),
          new Date(0).toISOString(),
        )).toThrow(/part_file_asset must be inserted unbound/u);

        database.exec("DROP TRIGGER part_file_asset_unbound_insert_guard");
        database.prepare(insertRogue).run(
          "asset_legacy_rogue_origin",
          fixture.partV1Id,
          `parts/${fixture.partV1Id}/rogue-origin.json`,
          rogueBytes.byteLength,
          sha256(rogueBytes),
          new Date(0).toISOString(),
        );
      } finally {
        database.close();
      }

      await expect(store.verifyPartStorage(fixture.partV1Id)).rejects.toMatchObject({
        code: "SNAPSHOT_CORRUPT",
        statusCode: 409,
      });
    } finally {
      store.close();
    }
  });

  it("rolls migration 14 back atomically when legacy foreign keys are corrupt", async () => {
    const fixture = await createPopulatedV13Fixture();
    const databasePath = join(fixture.directory, "mcskinsplit.sqlite");
    const corruptDatabase = new Database(databasePath);
    try {
      corruptDatabase.pragma("foreign_keys = OFF");
      const trigger = corruptDatabase.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'part_asset_content_immutable_update'
      `).get() as { readonly sql: string };
      corruptDatabase.exec("DROP TRIGGER part_asset_content_immutable_update");
      corruptDatabase.prepare(`
        UPDATE part_asset SET source_revision_id = 'revision_missing'
        WHERE id = ?
      `).run(fixture.partV1Id);
      corruptDatabase.exec(trigger.sql);
    } finally {
      corruptDatabase.close();
    }

    expect(() => new RevisionStore({ dataDirectory: fixture.directory }))
      .toThrow(/pixel-origin migration produced foreign key violations/u);

    const rolledBack = new Database(databasePath);
    try {
      expect(rolledBack.prepare(
        "SELECT MAX(version) AS version FROM schema_migration",
      ).get()).toEqual({ version: 13 });
      expect(rolledBack.prepare(
        "SELECT source_revision_id FROM part_asset WHERE id = ?",
      ).get(fixture.partV1Id)).toEqual({ source_revision_id: "revision_missing" });
      const revisionColumns = rolledBack.prepare(
        "PRAGMA table_info(skin_revision)",
      ).all() as Array<{ readonly name: string }>;
      const partColumns = rolledBack.prepare(
        "PRAGMA table_info(part_asset)",
      ).all() as Array<{ readonly name: string }>;
      expect(revisionColumns.map((column) => column.name)).not.toContain(
        "origin_asset_id",
      );
      expect(partColumns.map((column) => column.name)).not.toContain(
        "origin_asset_id",
      );
      expect(rolledBack.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('skin_asset_v14', 'part_file_asset_v14')
      `).all()).toEqual([]);
      expect(rolledBack.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'skin_revision_origin_required_insert'
      `).get()).toBeUndefined();
      expect(rolledBack.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'part_asset_content_immutable_update'
      `).get()).toEqual({ name: "part_asset_content_immutable_update" });
    } finally {
      rolledBack.close();
    }
  });

  it("requires origin artifacts on every post-v14 immutable row", async () => {
    const { directory, store } = await createStore();

    try {
      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        expect(() => database.prepare(
          "INSERT INTO skin_revision (id) VALUES ('revision_missing_origin')",
        ).run()).toThrow(/new skin_revision requires origin asset/u);
        expect(() => database.prepare(
          "INSERT INTO part_asset (id) VALUES ('part_missing_origin')",
        ).run()).toThrow(/new part_asset requires Part 2\.0 origin assets/u);
        expect(() => database.prepare(
          "INSERT INTO part_edit_revision (id) VALUES ('part_edit_revision_missing_origin')",
        ).run()).toThrow(/new part_edit_revision requires origin artifacts/u);
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });

  it("preserves immutable-history guards on a populated v14 reopen", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      store.close();

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        const upgraded = new Database(reopened.databasePath);
        try {
          expect(upgraded.prepare(
            "SELECT MAX(version) AS version FROM schema_migration",
          ).get()).toEqual({ version: 16 });
          const triggers = upgraded.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'trigger' AND name IN (${IMMUTABLE_HISTORY_TRIGGER_NAMES.map(() => "?").join(", ")})
            ORDER BY name
          `).all(...IMMUTABLE_HISTORY_TRIGGER_NAMES) as Array<{ readonly name: string }>;
          expect(triggers.map((row) => row.name).sort()).toEqual(
            [...IMMUTABLE_HISTORY_TRIGGER_NAMES].sort(),
          );
          expect(() => upgraded.prepare(
            "UPDATE skin_revision SET summary = 'tampered' WHERE id = ?",
          ).run(imported.revision.id)).toThrow(/skin_revision is immutable/u);
        } finally {
          upgraded.close();
        }
        expect(reopened.getRevision(imported.revision.id).id).toBe(imported.revision.id);
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is intentionally closed before reopening the populated database.
      }
    }
  });

  it("upgrades an early v11 followup schema without losing rows and permits validating inserts", async () => {
    const { directory, store } = await createStore();
    try {
      const preservedImport = await importRealSkin(store);
      const preservedResult = await store.commitAiSegmentation(
        preservedImport.revision.id,
        {
          state: await store.readRevisionSemanticState(preservedImport.revision.id),
          aiJobId: "aijob_v11_preserved",
          aiRunId: "airun_v11_preserved",
          provider: "catalog-provider",
          model: "catalog-model",
          proposalSummary: "v11 preserved fixture",
          reviewItems: [],
        },
      );
      insertSucceededSemanticJob(store, {
        jobId: "aijob_v11_preserved",
        projectId: preservedImport.project.id,
        inputRevisionId: preservedImport.revision.id,
        resultRevisionId: preservedResult.revision.id,
      });
      const preservedAssessment = semanticFollowupAssessment("7", {
        suggestions: [],
        notices: [],
      });
      const beforeDowngrade = new Database(store.databasePath);
      try {
        insertSemanticFollowupFixture(beforeDowngrade, {
          jobId: "aijob_v11_preserved",
          resultRevisionId: preservedResult.revision.id,
          status: "no_repair",
          assessment: preservedAssessment,
        });
      } finally {
        beforeDowngrade.close();
      }

      const validatingImport = await importRealSkin(store);
      const validatingResult = await store.commitAiSegmentation(
        validatingImport.revision.id,
        {
          state: await store.readRevisionSemanticState(validatingImport.revision.id),
          aiJobId: "aijob_v11_validating",
          aiRunId: "airun_v11_validating",
          provider: "catalog-provider",
          model: "catalog-model",
          proposalSummary: "v11 validating fixture",
          reviewItems: [],
        },
      );
      insertValidatingSemanticJob(store, {
        jobId: "aijob_v11_validating",
        projectId: validatingImport.project.id,
        inputRevisionId: validatingImport.revision.id,
        resultRevisionId: validatingResult.revision.id,
      });
      store.close();

      const legacy = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        downgradeSemanticFollowupToEarlyV11(legacy);
        expect(legacy.prepare(
          "SELECT MAX(version) AS version FROM schema_migration",
        ).get()).toEqual({ version: 16 });
        const legacyInsertSql = legacy.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'semantic_analysis_followup_insert_guard'",
        ).get() as { readonly sql: string };
        expect(legacyInsertSql.sql).not.toContain("validating");
        upgradeSemanticFollowupFromEarlyV11(legacy);
      } finally {
        legacy.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        const upgraded = new Database(reopened.databasePath);
        try {
          expect(upgraded.prepare(
            "SELECT MAX(version) AS version FROM schema_migration",
          ).get()).toEqual({ version: 16 });
          expect(upgraded.prepare(`
            SELECT job_id, result_revision_id, status, assessment_json,
                   evidence_hash, applied_revision_id
            FROM semantic_analysis_followup
            WHERE job_id = ?
          `).get("aijob_v11_preserved")).toEqual({
            job_id: "aijob_v11_preserved",
            result_revision_id: preservedResult.revision.id,
            status: "no_repair",
            assessment_json: JSON.stringify(preservedAssessment),
            evidence_hash: preservedAssessment.evidenceHash,
            applied_revision_id: null,
          });
          const tableSql = upgraded.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'semantic_analysis_followup'",
          ).get() as { readonly sql: string };
          expect(tableSql.sql).toContain("$.algorithmVersion");
          expect(tableSql.sql).toContain("cross-body-hair-reclassification-v2");
          const insertSql = upgraded.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'semantic_analysis_followup_insert_guard'",
          ).get() as { readonly sql: string };
          expect(insertSql.sql).toContain("'validating', 'succeeded'");
          expect(upgraded.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name IN (
                'semantic_analysis_followup_v11',
                'semantic_analysis_followup_v12'
              )
            ORDER BY name
          `).all()).toEqual([]);
          expect(upgraded.prepare(`
            SELECT name, tbl_name
            FROM sqlite_master
            WHERE type = 'index'
              AND name = 'idx_semantic_analysis_followup_status'
          `).get()).toEqual({
            name: "idx_semantic_analysis_followup_status",
            tbl_name: "semantic_analysis_followup",
          });
          const statusIndexColumns = upgraded.prepare(
            "PRAGMA index_info('idx_semantic_analysis_followup_status')",
          ).all() as readonly { readonly name: string }[];
          expect(statusIndexColumns.map(({ name }) => name)).toEqual([
            "status",
            "updated_at",
            "job_id",
          ]);
          expect(upgraded.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'trigger'
              AND name GLOB 'semantic_analysis_followup_*'
            ORDER BY name
          `).all()).toEqual([
            { name: "semantic_analysis_followup_applied_revision_insert_guard" },
            { name: "semantic_analysis_followup_applied_revision_update_guard" },
            { name: "semantic_analysis_followup_identity_immutable" },
            { name: "semantic_analysis_followup_insert_guard" },
            { name: "semantic_analysis_followup_job_success_guard" },
            { name: "semantic_analysis_followup_status_transition_guard" },
            { name: "semantic_analysis_followup_update_guard" },
          ]);

          const validatingAssessment = semanticFollowupAssessment("8", {
            suggestions: [],
            notices: [],
          });
          insertSemanticFollowupFixture(upgraded, {
            jobId: "aijob_v11_validating",
            resultRevisionId: validatingResult.revision.id,
            status: "no_repair",
            assessment: validatingAssessment,
          });
          expect(upgraded.prepare(`
            SELECT status FROM semantic_analysis_followup WHERE job_id = ?
          `).get("aijob_v11_validating")).toEqual({ status: "no_repair" });
          upgraded.prepare(`
            UPDATE ai_job
            SET status = 'succeeded', result_revision_id = ?, finished_at = ?
            WHERE id = ?
          `).run(
            validatingResult.revision.id,
            TEST_CREATED_AT,
            "aijob_v11_validating",
          );
        } finally {
          upgraded.close();
        }
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("preserves a valid early-v11 applied followup through strong provenance validation", async () => {
    const { directory, store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const analyzed = await store.commitAiSegmentation(imported.revision.id, {
        state: await store.readRevisionSemanticState(imported.revision.id),
        aiJobId: "aijob_v11_valid_applied",
        aiRunId: "airun_v11_valid_applied",
        provider: "catalog-provider",
        model: "catalog-model",
        proposalSummary: "v11 valid applied fixture",
        reviewItems: [],
      });
      expect(
        await store.diffRevisions(imported.revision.id, analyzed.revision.id),
      ).toMatchObject({
        changedPixelCount: 0,
        originChangedPixelCount: 0,
        originChangedPixelIds: [],
      });
      expect(analyzed.revision.resultHash).toBe(imported.revision.resultHash);
      insertSucceededSemanticJob(store, {
        jobId: "aijob_v11_valid_applied",
        projectId: imported.project.id,
        inputRevisionId: imported.revision.id,
        resultRevisionId: analyzed.revision.id,
      });
      const suggestionId = `followup_${"6".repeat(24)}`;
      const assessment = semanticFollowupAssessment("6", {
        suggestions: [{
          id: suggestionId,
          kind: "cross_surface_reclassification",
          label: "长发跨部位修正",
          targetComponentId: "hair.main",
          sourceComponentIds: ["outfit.mistaken"],
          candidateRegionIds: ["region_torso_base_001"],
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          pixelCount: 1,
          confidence: 0.91,
          reason: "跨部位外观连续",
        }],
        notices: [],
      });
      const beforeApply = new Database(store.databasePath);
      try {
        insertSemanticFollowupFixture(beforeApply, {
          jobId: "aijob_v11_valid_applied",
          resultRevisionId: analyzed.revision.id,
          status: "awaiting_review",
          assessment,
        });
      } finally {
        beforeApply.close();
      }
      const repairBranch = await store.branchFromRevision(analyzed.revision.id, {
        name: "semantic-repair-v11-valid",
        actorId: "semantic-followup",
      });
      const applied = await store.applyManualOperation(repairBranch.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.main",
            displayName: "长发",
            category: "hair",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
        actorId: "semantic-followup",
        semanticFollowup: {
          jobId: "aijob_v11_valid_applied",
          resultRevisionId: analyzed.revision.id,
          suggestionId,
          evidenceHash: assessment.evidenceHash,
        },
      });
      store.close();

      const legacy = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        downgradeSemanticFollowupToEarlyV11(legacy);
        expect(legacy.prepare(`
          SELECT status, assessment_json, applied_revision_id
          FROM semantic_analysis_followup
          WHERE job_id = ?
        `).get("aijob_v11_valid_applied")).toEqual({
          status: "applied",
          assessment_json: JSON.stringify(assessment),
          applied_revision_id: applied.revision.id,
        });
        upgradeSemanticFollowupFromEarlyV11(legacy);
      } finally {
        legacy.close();
      }

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        const upgraded = new Database(reopened.databasePath);
        try {
          expect(upgraded.prepare(
            "SELECT MAX(version) AS version FROM schema_migration",
          ).get()).toEqual({ version: 16 });
          expect(upgraded.prepare(`
            SELECT result_revision_id, status, assessment_json,
                   evidence_hash, applied_revision_id
            FROM semantic_analysis_followup
            WHERE job_id = ?
          `).get("aijob_v11_valid_applied")).toEqual({
            result_revision_id: analyzed.revision.id,
            status: "applied",
            assessment_json: JSON.stringify(assessment),
            evidence_hash: assessment.evidenceHash,
            applied_revision_id: applied.revision.id,
          });
        } finally {
          upgraded.close();
        }
        expect(
          (await reopened.getAnalyzedSkin(analyzed.revision.id))
            .semanticFollowup?.appliedVariant?.revision.id,
        ).toBe(applied.revision.id);
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("rolls back v12 atomically when an early v11 row violates final checks", async () => {
    const { directory, store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const analyzed = await store.commitAiSegmentation(imported.revision.id, {
        state: await store.readRevisionSemanticState(imported.revision.id),
        aiJobId: "aijob_v11_invalid",
        aiRunId: "airun_v11_invalid",
        provider: "catalog-provider",
        model: "catalog-model",
        proposalSummary: "v11 invalid fixture",
        reviewItems: [],
      });
      insertSucceededSemanticJob(store, {
        jobId: "aijob_v11_invalid",
        projectId: imported.project.id,
        inputRevisionId: imported.revision.id,
        resultRevisionId: analyzed.revision.id,
      });
      store.close();

      const legacy = new Database(join(directory, "mcskinsplit.sqlite"));
      const invalidEvidenceHash = `sha256:${"9".repeat(64)}`;
      try {
        downgradeSemanticFollowupToEarlyV11(legacy);
        insertSemanticFollowupFixture(legacy, {
          jobId: "aijob_v11_invalid",
          resultRevisionId: analyzed.revision.id,
          status: "no_repair",
          assessment: {
            schemaVersion: "1.0",
            evidenceHash: invalidEvidenceHash,
            suggestions: [],
            notices: [],
          },
        });
        expect(() => upgradeSemanticFollowupFromEarlyV11(legacy)).toThrow();
      } finally {
        legacy.close();
      }

      const afterFailure = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        expect(afterFailure.prepare(
          "SELECT MAX(version) AS version FROM schema_migration",
        ).get()).toEqual({ version: 16 });
        expect(afterFailure.prepare(
          "SELECT COUNT(*) AS count FROM semantic_analysis_followup WHERE job_id = ?",
        ).get("aijob_v11_invalid")).toEqual({ count: 1 });
        expect(afterFailure.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_analysis_followup_v11'",
        ).get()).toBeUndefined();
        const tableSql = afterFailure.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'semantic_analysis_followup'",
        ).get() as { readonly sql: string };
        expect(tableSql.sql).not.toContain("$.algorithmVersion");
        const insertSql = afterFailure.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'semantic_analysis_followup_insert_guard'",
        ).get() as { readonly sql: string };
        expect(insertSql.sql).not.toContain("validating");
      } finally {
        afterFailure.close();
      }
    } finally {
      store.close();
    }
  });

  it("rejects weak early-v11 applied provenance without partially upgrading", async () => {
    const { directory, store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const analyzed = await store.commitAiSegmentation(imported.revision.id, {
        state: await store.readRevisionSemanticState(imported.revision.id),
        aiJobId: "aijob_v11_weak_applied",
        aiRunId: "airun_v11_weak_applied",
        provider: "catalog-provider",
        model: "catalog-model",
        proposalSummary: "v11 weak applied fixture",
        reviewItems: [],
      });
      insertSucceededSemanticJob(store, {
        jobId: "aijob_v11_weak_applied",
        projectId: imported.project.id,
        inputRevisionId: imported.revision.id,
        resultRevisionId: analyzed.revision.id,
      });
      const unrelated = await store.applyManualOperation(analyzed.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.unrelated",
            displayName: "Unrelated hair",
            category: "hair",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      store.close();

      const legacy = new Database(join(directory, "mcskinsplit.sqlite"));
      const assessment = semanticFollowupAssessment("e", {
        suggestions: [{
          id: `followup_${"e".repeat(24)}`,
          kind: "cross_surface_reclassification",
          label: "长发跨部位修正",
          targetComponentId: "hair.main",
          sourceComponentIds: ["outfit.mistaken"],
          candidateRegionIds: ["region_torso_base_001"],
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          pixelCount: 1,
          confidence: 0.91,
          reason: "跨部位外观连续",
        }],
        notices: [],
      });
      try {
        downgradeSemanticFollowupToEarlyV11(legacy);
        insertSemanticFollowupFixture(legacy, {
          jobId: "aijob_v11_weak_applied",
          resultRevisionId: analyzed.revision.id,
          status: "applied",
          assessment,
          appliedRevisionId: unrelated.revision.id,
        });
        expect(() => upgradeSemanticFollowupFromEarlyV11(legacy)).toThrow(
          /invalid semantic analysis applied revision/u,
        );
      } finally {
        legacy.close();
      }

      const afterFailure = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        expect(afterFailure.prepare(
          "SELECT MAX(version) AS version FROM schema_migration",
        ).get()).toEqual({ version: 16 });
        expect(afterFailure.prepare(`
          SELECT status, applied_revision_id
          FROM semantic_analysis_followup
          WHERE job_id = ?
        `).get("aijob_v11_weak_applied")).toEqual({
          status: "applied",
          applied_revision_id: unrelated.revision.id,
        });
        expect(afterFailure.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_analysis_followup_v11'",
        ).get()).toBeUndefined();
      } finally {
        afterFailure.close();
      }
    } finally {
      store.close();
    }
  });

  it("archives analyzed catalog entries without mutating immutable evidence", async () => {
    const { store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const analyzed = await store.commitAiSegmentation(imported.revision.id, {
        state: await store.readRevisionSemanticState(imported.revision.id),
        aiJobId: "aijob_catalog_fixture",
        aiRunId: "airun_catalog_fixture",
        provider: "catalog-provider",
        model: "catalog-model",
        proposalSummary: "Catalog fixture",
        reviewItems: [],
      });
      const database = new Database(store.databasePath);
      try {
        const createdAt = "2026-08-11T01:00:00.000Z";
        database.prepare(`
          INSERT INTO ai_job (
            id, job_kind, project_id, input_revision_id, result_revision_id,
            retry_of_job_id, status, provider, model, skill_name, skill_version,
            prompt_version, options_json, review_items_json, proposal_summary,
            cancel_requested, created_at, started_at, finished_at
          ) VALUES (?, 'semantic_analysis', ?, ?, ?, NULL, 'succeeded', ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?, ?)
        `).run(
          "aijob_catalog_fixture",
          imported.project.id,
          imported.revision.id,
          analyzed.revision.id,
          "catalog-provider",
          "catalog-model",
          "mc-skin-segmenter",
          "1.2.0",
          "catalog-test-v1",
          JSON.stringify({
            mode: "full",
            provider: "catalog-provider",
            model: "catalog-model",
            reasoningEffort: "medium",
            taxonomyLevel: "coarse",
            focus: ["hair"],
            createRevisionOnSuccess: true,
          }),
          "Catalog fixture",
          createdAt,
          createdAt,
          createdAt,
        );
        expect(() => database.prepare(`
          INSERT INTO analyzed_skin_catalog_archive (
            result_revision_id, archived_at, archived_reason
          ) VALUES (?, ?, NULL)
        `).run(imported.revision.id, createdAt)).toThrow(
          /invalid analyzed skin catalog archive target/u,
        );
      } finally {
        database.close();
      }

      expect((await store.listAnalyzedSkins()).map((item) => item.revision.id))
        .toEqual([analyzed.revision.id]);
      const revisionBefore = store.getRevision(analyzed.revision.id);
      await expect(store.archiveAnalyzedSkin(analyzed.revision.id, {
        reason: `${" ".repeat(300)}x`,
      })).rejects.toMatchObject({ code: "INVALID_INPUT", statusCode: 400 });
      const archived = await store.archiveAnalyzedSkin(analyzed.revision.id, {
        reason: "重复分析结果",
      });
      expect(archived).toMatchObject({
        catalogStatus: "archived",
        archivedReason: "重复分析结果",
      });
      expect(archived.archivedAt).not.toBeNull();
      expect(await store.listAnalyzedSkins()).toEqual([]);
      expect(await store.listAnalyzedSkins({ status: "archived" })).toEqual([archived]);
      expect(await store.getAnalyzedSkin(analyzed.revision.id)).toEqual(archived);

      const corruptDatabase = new Database(store.databasePath);
      try {
        corruptDatabase.prepare(`
          UPDATE analyzed_skin_catalog_archive
          SET archived_at = 'not-a-timestamp'
          WHERE result_revision_id = ?
        `).run(analyzed.revision.id);
        await expect(
          store.listAnalyzedSkins({ status: "all" }),
        ).rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
        corruptDatabase.prepare(`
          UPDATE analyzed_skin_catalog_archive
          SET archived_at = ?
          WHERE result_revision_id = ?
        `).run(archived.archivedAt, analyzed.revision.id);
      } finally {
        corruptDatabase.close();
      }

      const archivedAgain = await store.archiveAnalyzedSkin(analyzed.revision.id, {
        reason: "不应覆盖原因",
      });
      expect(archivedAgain).toEqual(archived);
      expect(store.getRevision(analyzed.revision.id)).toEqual(revisionBefore);

      const restored = await store.restoreAnalyzedSkin(analyzed.revision.id);
      expect(restored).toMatchObject({
        catalogStatus: "active",
        archivedAt: null,
        archivedReason: null,
      });
      expect(await store.restoreAnalyzedSkin(analyzed.revision.id)).toEqual(restored);
      expect(await store.listAnalyzedSkins({ status: "all" })).toEqual([restored]);
      expect(store.getRevision(analyzed.revision.id)).toEqual(revisionBefore);
      await expect(
        store.archiveAnalyzedSkin(imported.revision.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    } finally {
      store.close();
    }
  });

  it("persists semantic followup summaries and integrity-loads an applied catalog variant", async () => {
    const { store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const analyzed = await store.commitAiSegmentation(imported.revision.id, {
        state: await store.readRevisionSemanticState(imported.revision.id),
        aiJobId: "aijob_followup_applied",
        aiRunId: "airun_followup_applied",
        provider: "catalog-provider",
        model: "catalog-model",
        proposalSummary: "Followup fixture",
        reviewItems: [],
      });
      insertSucceededSemanticJob(store, {
        jobId: "aijob_followup_applied",
        projectId: imported.project.id,
        inputRevisionId: imported.revision.id,
        resultRevisionId: analyzed.revision.id,
      });
      const assessment = semanticFollowupAssessment("a", {
        suggestions: [{
          id: `followup_${"a".repeat(24)}`,
          kind: "cross_surface_reclassification",
          label: "长发跨部位修正",
          targetComponentId: "hair.main",
          sourceComponentIds: ["outfit.mistaken"],
          candidateRegionIds: ["region_torso_base_001"],
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          pixelCount: 1,
          confidence: 0.91,
          reason: "跨部位外观连续",
        }],
        notices: [{ kind: "inferred", message: "需用户确认分类修正" }],
      });
      const database = new Database(store.databasePath);
      try {
        database.prepare(`
          INSERT INTO ai_job (
            id, job_kind, project_id, input_revision_id, result_revision_id,
            retry_of_job_id, status, provider, model, skill_name, skill_version,
            prompt_version, options_json, review_items_json, proposal_summary,
            cancel_requested, created_at, started_at, finished_at
          ) VALUES (?, 'semantic_analysis', ?, ?, ?, NULL, 'succeeded', ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?, ?)
        `).run(
          "aijob_followup_wrong_owner",
          imported.project.id,
          imported.revision.id,
          analyzed.revision.id,
          "catalog-provider",
          "catalog-model",
          "mc-skin-segmenter",
          "1.2.0",
          "catalog-test-v1",
          JSON.stringify({
            mode: "full",
            provider: "catalog-provider",
            model: "catalog-model",
            reasoningEffort: "medium",
            taxonomyLevel: "coarse",
            focus: ["hair"],
            createRevisionOnSuccess: true,
          }),
          "Wrong followup owner fixture",
          TEST_CREATED_AT,
          TEST_CREATED_AT,
          TEST_CREATED_AT,
        );
        expect(() => database.prepare(`
          INSERT INTO semantic_analysis_followup (
            job_id, result_revision_id, status, assessment_json,
            evidence_hash, applied_revision_id, created_at, updated_at
          ) VALUES (?, ?, 'awaiting_review', ?, ?, NULL, ?, ?)
        `).run(
          "aijob_followup_wrong_owner",
          analyzed.revision.id,
          JSON.stringify(assessment),
          assessment.evidenceHash,
          TEST_CREATED_AT,
          TEST_CREATED_AT,
        )).toThrow(/invalid semantic analysis followup target/u);
        database.prepare("DELETE FROM ai_job WHERE id = ?").run(
          "aijob_followup_wrong_owner",
        );
        const invalidV2Assessment = {
          ...assessment,
          algorithmVersion: "cross-body-hair-reclassification-v2",
          suggestions: [
            assessment.suggestions[0],
            {
              ...assessment.suggestions[0],
              id: `followup_${"b".repeat(24)}`,
            },
          ],
        };
        expect(() => database.prepare(`
          INSERT INTO semantic_analysis_followup (
            job_id, result_revision_id, status, assessment_json,
            evidence_hash, applied_revision_id, created_at, updated_at
          ) VALUES (?, ?, 'awaiting_review', ?, ?, NULL, ?, ?)
        `).run(
          "aijob_followup_applied",
          analyzed.revision.id,
          JSON.stringify(invalidV2Assessment),
          assessment.evidenceHash,
          TEST_CREATED_AT,
          TEST_CREATED_AT,
        )).toThrow();
        database.prepare(`
          INSERT INTO semantic_analysis_followup (
            job_id, result_revision_id, status, assessment_json,
            evidence_hash, applied_revision_id, created_at, updated_at
          ) VALUES (?, ?, 'awaiting_review', ?, ?, NULL, ?, ?)
        `).run(
          "aijob_followup_applied",
          analyzed.revision.id,
          JSON.stringify(assessment),
          assessment.evidenceHash,
          TEST_CREATED_AT,
          TEST_CREATED_AT,
        );
      } finally {
        database.close();
      }

      expect((await store.getAnalyzedSkin(analyzed.revision.id)).semanticFollowup)
        .toEqual({
          jobId: "aijob_followup_applied",
          status: "awaiting_review",
          evidenceHash: assessment.evidenceHash,
          suggestionCount: 1,
          suggestedPixelCount: 1,
          notices: [{ kind: "inferred", message: "需用户确认分类修正" }],
          appliedVariant: null,
        });

      const repairBranch = await store.branchFromRevision(analyzed.revision.id, {
        name: "semantic-repair-test",
        actorId: "semantic-followup",
      });
      const revisionCountBeforeRejectedApply = store.listRevisions(
        imported.project.id,
      ).length;
      await expect(
        store.applyManualOperation(repairBranch.revision.id, {
          operation: {
            type: "assign_pixels",
            target: { instanceId: "hair.main", displayName: "长发", category: "hair" },
            spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          },
          actorId: "semantic-followup",
          semanticFollowup: {
            jobId: "aijob_followup_applied",
            resultRevisionId: analyzed.revision.id,
            suggestionId: `followup_${"a".repeat(24)}`,
            evidenceHash: assessment.evidenceHash,
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      expect(store.listRevisions(imported.project.id)).toHaveLength(
        revisionCountBeforeRejectedApply,
      );
      expect(store.getBranch(repairBranch.branch.id).headRevisionId).toBe(
        repairBranch.revision.id,
      );

      await expect(
        store.applyManualOperation(repairBranch.revision.id, {
          operation: {
            type: "assign_pixels",
            target: { instanceId: "hair.main", displayName: "长发", category: "hair" },
            spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          },
          actorId: "semantic-followup",
          semanticFollowup: {
            jobId: "aijob_followup_applied",
            resultRevisionId: analyzed.revision.id,
            suggestionId: `followup_${"a".repeat(24)}`,
            evidenceHash: `sha256:${"f".repeat(64)}`,
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      expect(store.listRevisions(imported.project.id)).toHaveLength(
        revisionCountBeforeRejectedApply,
      );
      expect(store.getBranch(repairBranch.branch.id).headRevisionId).toBe(
        repairBranch.revision.id,
      );

      const applied = await store.applyManualOperation(repairBranch.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { instanceId: "hair.main", displayName: "长发", category: "hair" },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
        actorId: "semantic-followup",
        semanticFollowup: {
          jobId: "aijob_followup_applied",
          resultRevisionId: analyzed.revision.id,
          suggestionId: `followup_${"a".repeat(24)}`,
          evidenceHash: assessment.evidenceHash,
        },
      });
      const updateDatabase = new Database(store.databasePath);
      try {
        expect(() => updateDatabase.prepare(`
          UPDATE semantic_analysis_followup
          SET applied_revision_id = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(TEST_CREATED_AT, "aijob_followup_applied")).toThrow();
        expect(() => updateDatabase.prepare(`
          UPDATE semantic_analysis_followup
          SET status = 'awaiting_review', applied_revision_id = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(TEST_CREATED_AT, "aijob_followup_applied"))
          .toThrow(/invalid semantic analysis followup status transition/u);
        expect(() => updateDatabase.prepare(`
          UPDATE semantic_analysis_followup
          SET evidence_hash = ?
          WHERE job_id = ?
        `).run(`sha256:${"b".repeat(64)}`, "aijob_followup_applied"))
          .toThrow(/semantic analysis followup evidence is immutable/u);
      } finally {
        updateDatabase.close();
      }

      const catalogItem = await store.getAnalyzedSkin(analyzed.revision.id);
      expect(catalogItem.semanticFollowup).toMatchObject({
        status: "applied",
        appliedVariant: {
          label: "分类修复版",
          revision: {
            id: applied.revision.id,
            branchId: applied.revision.branchId,
            branchName: "semantic-repair-test",
            sequence: applied.revision.sequence,
          },
          skinUrl: `/api/revisions/${applied.revision.id}/skin.png`,
        },
      });
      expect(catalogItem.semanticFollowup?.appliedVariant?.groups).toEqual([
        expect.objectContaining({
          key: "aggregate.hair",
          kind: "hair",
          componentIds: ["hair.main"],
          componentCount: 1,
          pixelCount: 1,
        }),
      ]);

      const unrelatedBranch = await store.branchFromRevision(analyzed.revision.id, {
        name: "unrelated-followup-test",
      });
      const unrelated = await store.applyManualOperation(
        unrelatedBranch.revision.id,
        {
          operation: {
            type: "assign_pixels",
            target: { instanceId: "hair.other", displayName: "其他头发", category: "hair" },
            spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          },
        },
      );
      const guardDatabase = new Database(store.databasePath);
      try {
        expect(() => guardDatabase.prepare(`
          UPDATE skin_revision
          SET actor_id = 'semantic-followup'
          WHERE id IN (?, ?)
        `).run(unrelatedBranch.revision.id, unrelated.revision.id)).toThrow(
          /skin_revision is immutable/u,
        );
        expect(() => guardDatabase.prepare(`
          UPDATE semantic_analysis_followup
          SET applied_revision_id = ?, updated_at = ?
          WHERE job_id = ?
        `).run(
          unrelated.revision.id,
          TEST_CREATED_AT,
          "aijob_followup_applied",
        )).toThrow(/invalid semantic analysis applied revision/u);
      } finally {
        guardDatabase.close();
      }
      expect(
        (await store.getAnalyzedSkin(analyzed.revision.id))
          .semanticFollowup?.appliedVariant?.revision.id,
      ).toBe(applied.revision.id);

      const archived = await store.archiveAnalyzedSkin(analyzed.revision.id, {
        reason: "保留修复证据",
      });
      expect(archived).toMatchObject({
        catalogStatus: "archived",
        semanticFollowup: {
          status: "applied",
          appliedVariant: { revision: { id: applied.revision.id } },
        },
      });
      expect(await store.listAnalyzedSkins()).toEqual([]);
      expect((await store.listAnalyzedSkins({ status: "archived" }))[0]?.semanticFollowup)
        .toEqual(archived.semanticFollowup);
    } finally {
      store.close();
    }
  });

  it("exposes no-repair followup without inventing a catalog variant", async () => {
    const { store } = await createStore();
    try {
      const imported = await importRealSkin(store);
      const analyzed = await store.commitAiSegmentation(imported.revision.id, {
        state: await store.readRevisionSemanticState(imported.revision.id),
        aiJobId: "aijob_followup_none",
        aiRunId: "airun_followup_none",
        provider: "catalog-provider",
        model: "catalog-model",
        proposalSummary: "No repair fixture",
        reviewItems: [],
      });
      insertSucceededSemanticJob(store, {
        jobId: "aijob_followup_none",
        projectId: imported.project.id,
        inputRevisionId: imported.revision.id,
        resultRevisionId: analyzed.revision.id,
      });
      const assessment = semanticFollowupAssessment("c", {
        suggestions: [],
        notices: [{ kind: "complete", message: "未发现需要分类修正的像素" }],
      });
      const database = new Database(store.databasePath);
      try {
        database.prepare(`
          INSERT INTO semantic_analysis_followup (
            job_id, result_revision_id, status, assessment_json,
            evidence_hash, applied_revision_id, created_at, updated_at
          ) VALUES (?, ?, 'no_repair', ?, ?, NULL, ?, ?)
        `).run(
          "aijob_followup_none",
          analyzed.revision.id,
          JSON.stringify(assessment),
          assessment.evidenceHash,
          TEST_CREATED_AT,
          TEST_CREATED_AT,
        );
      } finally {
        database.close();
      }

      expect((await store.getAnalyzedSkin(analyzed.revision.id)).semanticFollowup)
        .toEqual({
          jobId: "aijob_followup_none",
          status: "no_repair",
          evidenceHash: assessment.evidenceHash,
          suggestionCount: 0,
          suggestedPixelCount: 0,
          notices: [{ kind: "complete", message: "未发现需要分类修正的像素" }],
          appliedVariant: null,
        });
    } finally {
      store.close();
    }
  });

  it("rejects corrupted semantic followup evidence after reopening", async () => {
    const created = await createStore();
    const imported = await importRealSkin(created.store);
    const analyzed = await created.store.commitAiSegmentation(imported.revision.id, {
      state: await created.store.readRevisionSemanticState(imported.revision.id),
      aiJobId: "aijob_followup_corrupt",
      aiRunId: "airun_followup_corrupt",
      provider: "catalog-provider",
      model: "catalog-model",
      proposalSummary: "Corruption fixture",
      reviewItems: [],
    });
    insertSucceededSemanticJob(created.store, {
      jobId: "aijob_followup_corrupt",
      projectId: imported.project.id,
      inputRevisionId: imported.revision.id,
      resultRevisionId: analyzed.revision.id,
    });
    const assessment = semanticFollowupAssessment("d", {
      suggestions: [],
      notices: [],
    });
    const database = new Database(created.store.databasePath);
    database.prepare(`
      INSERT INTO semantic_analysis_followup (
        job_id, result_revision_id, status, assessment_json,
        evidence_hash, applied_revision_id, created_at, updated_at
      ) VALUES (?, ?, 'no_repair', ?, ?, NULL, ?, ?)
    `).run(
      "aijob_followup_corrupt",
      analyzed.revision.id,
      JSON.stringify(assessment),
      assessment.evidenceHash,
      TEST_CREATED_AT,
      TEST_CREATED_AT,
    );
    database.close();
    created.store.close();

    const reopened = new RevisionStore({ dataDirectory: created.directory });
    await expect(reopened.getAnalyzedSkin(analyzed.revision.id)).resolves.toMatchObject({
      semanticFollowup: { status: "no_repair" },
    });
    reopened.close();

    const corruptDatabase = new Database(join(created.directory, "mcskinsplit.sqlite"));
    corruptDatabase.exec(`
      DROP TRIGGER semantic_analysis_followup_identity_immutable;
      PRAGMA ignore_check_constraints = ON;
    `);
    corruptDatabase.prepare(`
      UPDATE semantic_analysis_followup
      SET assessment_json = ?
      WHERE job_id = ?
    `).run(JSON.stringify({
      schemaVersion: "1.0",
      evidenceHash: assessment.evidenceHash,
      suggestions: [],
      notices: [],
    }), "aijob_followup_corrupt");
    corruptDatabase.close();

    const corrupted = new RevisionStore({ dataDirectory: created.directory });
    try {
      await expect(corrupted.getAnalyzedSkin(analyzed.revision.id))
        .rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      corrupted.close();
    }
  });

  it("blocks active bundle members from retirement and revises a bundle atomically", async () => {
    const { store } = await createStore();
    try {
      const image = createRgbaImage(64, 64);
      image.data.set([32, 48, 64, 255], (8 * 64 + 8) * 4);
      image.data.set([96, 80, 64, 255], (8 * 64 + 9) * 4);
      const imported = await store.importProject({
        name: "Bundle revision source",
        skinPng: encodeSkinPng(image),
        armType: "slim",
      });
      const hairRevision = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { instanceId: "hair.bundle", displayName: "Hair", category: "hair" },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      const finalRevision = await store.applyManualOperation(hairRevision.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { instanceId: "face.bundle", displayName: "Face", category: "face" },
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
        },
      });
      const base = await store.exportPart(finalRevision.revision.id, "hair.bundle");
      const wrongCategory = await store.exportPart(finalRevision.revision.id, "face.bundle");
      const repair = await store.createPartEditProject({ basePartId: base.id });
      const edited = await store.applyPartEditOperation(repair.project.id, {
        headRevisionId: repair.headRevision.id,
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          rgba: [44, 55, 66, 255],
        },
      });
      const replacement = (await store.commitPartEditProject(repair.project.id, {
        headRevisionId: edited.headRevision.id,
        name: "Repaired hair",
      })).part;
      const bundle = await store.exportPartBundle(finalRevision.revision.id, {
        kind: "hair",
        componentIds: [base.sourceComponentId],
      });
      const member = bundle.members[0]!.part;
      await expect(store.retirePart(member.id)).rejects.toMatchObject({
        code: "CONFLICT",
        details: { bundleIds: [bundle.id] },
      });
      const wrongSource = await exportHeadPixelPart(store, [11, 22, 33, 255]);
      await expect(store.revisePartBundle(bundle.id, {
        replacements: [{ memberPartId: member.id, replacementPartId: wrongSource.id }],
      })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await store.retirePart(wrongCategory.id, "不作为替换件");
      await expect(store.revisePartBundle(bundle.id, {
        replacements: [{ memberPartId: member.id, replacementPartId: wrongCategory.id }],
      })).rejects.toMatchObject({ code: "CONFLICT" });
      await store.restorePart(wrongCategory.id);
      await expect(store.revisePartBundle(bundle.id, {
        replacements: [{ memberPartId: member.id, replacementPartId: wrongCategory.id }],
      })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(store.getPartBundle(bundle.id).libraryStatus).toBe("active");
      expect(store.listPartBundles({ sourceRevisionId: finalRevision.revision.id })).toEqual([bundle]);
      const result = await store.revisePartBundle(bundle.id, {
        replacements: [{ memberPartId: member.id, replacementPartId: replacement.id }],
        reason: "用修补版替换",
      });
      expect(result.bundle).toMatchObject({
        libraryStatus: "active",
        metadata: {
          revisionOfBundleId: bundle.id,
          replacements: [{ memberPartId: member.id, replacementPartId: replacement.id }],
        },
      });
      expect(result.bundle.members.map((item) => item.partId)).toEqual([replacement.id]);
      expect(result.retiredBundle).toMatchObject({
        libraryStatus: "retired",
        retiredReason: "用修补版替换",
      });
      expect(store.listPartBundles()).toEqual([result.bundle]);
      expect(store.getPartBundle(bundle.id).libraryStatus).toBe("retired");
      expect(decodeSkinPng(await store.readPartBundlePreviewPng(bundle.id))).toMatchObject({ width: 64 });
      const target = await store.importProject({
        name: "Retired reference target",
        skinPng: encodeSkinPng(createRgbaImage(64, 64)),
        armType: "slim",
      });
      const composition = await store.createComposition({ baseRevisionId: target.revision.id });
      await expect(store.addCompositionBundle(composition.composition.id, { bundleId: bundle.id }))
        .rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      store.close();
    }
  });

  it("reports incompatible proposed bundle overlap as invalid input", async () => {
    const { store } = await createStore();
    try {
      const image = createRgbaImage(64, 64);
      image.data.set([32, 48, 64, 255], (8 * 64 + 8) * 4);
      image.data.set([96, 80, 64, 255], (8 * 64 + 9) * 4);
      const imported = await store.importProject({
        name: "Bundle overlap proposal",
        skinPng: encodeSkinPng(image),
        armType: "slim",
      });
      const first = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { instanceId: "hair.left", displayName: "Left hair", category: "hair" },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      const second = await store.applyManualOperation(first.revision.id, {
        operation: {
          type: "assign_pixels",
          target: { instanceId: "hair.right", displayName: "Right hair", category: "hair" },
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
        },
      });
      const bundle = await store.exportPartBundle(second.revision.id, {
        kind: "hair",
        componentIds: ["hair.left", "hair.right"],
      });
      const left = bundle.members.find(
        (member) => member.part.sourceComponentId === "hair.left",
      )!;
      const repair = await store.createPartEditProject({ basePartId: left.partId });
      const edited = await store.applyPartEditOperation(repair.project.id, {
        headRevisionId: repair.headRevision.id,
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
          rgba: [1, 2, 3, 255],
        },
      });
      const replacement = (await store.commitPartEditProject(repair.project.id, {
        headRevisionId: edited.headRevision.id,
        name: "Overlapping repaired hair",
      })).part;

      await expect(store.revisePartBundle(bundle.id, {
        replacements: [{ memberPartId: left.partId, replacementPartId: replacement.id }],
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        statusCode: 400,
        details: { bundleId: bundle.id, pixelId: 521, partId: expect.any(String) },
      });
      expect(store.getPartBundle(bundle.id).libraryStatus).toBe("active");
      expect(store.listPartBundles()).toEqual([bundle]);
    } finally {
      store.close();
    }
  });

  it("previews conflicts before applying a part to a new skin revision", async () => {
    const { store } = await createStore();

    try {
      const source = await importRealSkin(store);
      const segmented = await store.applyManualOperation(source.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.main",
            displayName: "主头发",
            category: "hair",
          },
          spans: [
            { surface: "head.base.front", y: 8, x0: 8, x1: 9 },
          ],
        },
      });
      const part = await store.exportPart(segmented.revision.id, "hair.main");
      const target = await store.importProject({
        name: "Part target",
        fileName: "354359a2c2f33777.png",
        skinPng: await readFile(TARGET_SKIN_PATH),
      });
      const targetRevisionCount = store.listRevisions(target.project.id).length;

      const preview = await store.previewPartApplication(
        target.revision.id,
        part.id,
      );
      expect(preview.report.writePixelCount).toBe(2);
      expect(
        preview.report.hardConflictCount +
          preview.report.sameColorOverlapCount,
      ).toBe(2);
      expect(store.listRevisions(target.project.id)).toHaveLength(
        targetRevisionCount,
      );

      const applied = await store.applyPart(target.revision.id, {
        partId: part.id,
        strategy: "use_part",
        summary: "混搭来源头发",
      });
      expect(applied.revision).toMatchObject({
        parentRevisionId: target.revision.id,
        operationType: "apply_part",
        sequence: 2,
        summary: "混搭来源头发",
      });
      const appliedSkin = decodeSkinPng(
        await store.readRevisionSkinPng(applied.revision.id),
      );
      const partTexture = decodeSkinPng(await store.readPartTexturePng(part.id));
      expect(getPixel(appliedSkin, 8, 8)).toEqual(getPixel(partTexture, 8, 8));
      expect(getPixel(appliedSkin, 9, 8)).toEqual(getPixel(partTexture, 9, 8));
      const appliedState = await store.readRevisionSemanticState(
        applied.revision.id,
      );
      expect(appliedState.document.components).toContainEqual(
        expect.objectContaining({
          instanceId: `applied.${part.id}`,
          category: "hair",
        }),
      );
      expect(
        await store.diffRevisions(target.revision.id, applied.revision.id),
      ).toMatchObject({ changedPixelCount: preview.report.hardConflictCount });
      const appliedOrigin = await store.readRevisionOrigin(applied.revision.id);
      expect(appliedOrigin).not.toBeNull();
      expect(getPixelOrigin(appliedOrigin!, 8 * 64 + 8)).toMatchObject({
        intrinsicOrigin: "source_visible",
        evidence: { sourceRevisionId: source.revision.id },
        copyLineage: {
          sourceSubject: { kind: "part", id: part.id },
          sourceComponentInstanceId: "hair.main",
          sourcePixelId: 8 * 64 + 8,
        },
      });
      expect(
        decodeSkinPng(await store.readRevisionSkinPng(target.revision.id)),
      ).toEqual(decodeSkinPng(await readFile(TARGET_SKIN_PATH)));
    } finally {
      store.close();
    }
  });

  it("persists explicit conflict resolution before committing a composition", async () => {
    const { store } = await createStore();

    try {
      const source = await importRealSkin(store);
      const segmented = await store.applyManualOperation(source.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.main",
            displayName: "主头发",
            category: "hair",
          },
          spans: [
            { surface: "head.base.front", y: 8, x0: 8, x1: 9 },
          ],
        },
      });
      const part = await store.exportPart(segmented.revision.id, "hair.main");
      const target = await store.importProject({
        name: "Composition target",
        skinPng: await readFile(TARGET_SKIN_PATH),
      });
      const created = await store.createComposition({
        baseRevisionId: target.revision.id,
        name: "冲突测试",
      });
      const layered = await store.addCompositionPart(created.composition.id, {
        partId: part.id,
      });

      expect(layered.report.hardConflictCount).toBeGreaterThan(0);
      expect(layered.report.committable).toBe(false);
      await expect(
        store.commitComposition(created.composition.id),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const resolved = await store.resolveCompositionConflict(
        created.composition.id,
        { strategy: "layer_order" },
      );
      expect(resolved.composition.resolutionMode).toBe("layer_order");
      expect(resolved.report).toMatchObject({
        unresolvedConflictCount: 0,
        committable: true,
      });

      const committed = await store.commitComposition(created.composition.id, {
        summary: "提交显式冲突决议",
      });
      expect(committed.revision).toMatchObject({
        parentRevisionId: target.revision.id,
        operationType: "compose",
        sequence: 2,
      });
      expect(committed.composition).toMatchObject({
        status: "committed",
        resultRevisionId: committed.revision.id,
      });
      await expect(
        store.addCompositionPart(created.composition.id, { partId: part.id }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      store.close();
    }
  });

  it("blocks a composition commit after one of its layered parts is retired", async () => {
    const { store } = await createStore();

    try {
      const source = await importRealSkin(store);
      const segmented = await store.applyManualOperation(source.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.main",
            displayName: "主头发",
            category: "hair",
          },
          spans: [
            { surface: "head.base.front", y: 8, x0: 8, x1: 9 },
          ],
        },
      });
      const part = await store.exportPart(segmented.revision.id, "hair.main");
      const target = await store.importProject({
        name: "Retired layer target",
        skinPng: await readFile(TARGET_SKIN_PATH),
      });
      const created = await store.createComposition({
        baseRevisionId: target.revision.id,
        name: "退役图层测试",
      });
      await store.addCompositionPart(created.composition.id, { partId: part.id });
      await store.resolveCompositionConflict(created.composition.id, {
        strategy: "layer_order",
      });
      await store.retirePart(part.id, "图层来源已退役");

      await expect(
        store.commitComposition(created.composition.id),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        statusCode: 409,
        details: { partIds: [part.id] },
      });
      expect(store.getComposition(created.composition.id).status).toBe("draft");
    } finally {
      store.close();
    }
  });

  it("mixes saved body parts from all six real Slim skins into the expected PNG", async () => {
    const { store } = await createStore();

    try {
      const manifest = JSON.parse(
        await readFile(join(REAL_SKIN_DIRECTORY, "real-skins.json"), "utf8"),
      ) as RealSkinManifest;
      const entries = new Map(manifest.skins.map((entry) => [entry.id, entry]));
      const parts = new Map<BodyPart, Awaited<ReturnType<typeof exportBodyPart>>>();
      for (const [bodyPart, sourceId] of Object.entries(manifest.mix.recipe) as [
        BodyPart,
        string,
      ][]) {
        const fixture = entries.get(sourceId)!;
        parts.set(
          bodyPart,
          await exportBodyPart(
            store,
            bodyPart,
            fixture.file,
            await readFile(join(REAL_SKIN_DIRECTORY, fixture.file)),
          ),
        );
      }
      expect(new Set([...parts.values()].map((part) => part.sourceProjectId))).toHaveLength(
        6,
      );

      const base = await store.importProject({
        name: "Transparent Slim composition base",
        armType: "slim",
        skinPng: encodeSkinPng(createRgbaImage(64, 64)),
      });
      const created = await store.createComposition({
        baseRevisionId: base.revision.id,
        name: "六皮肤 Slim 混搭",
      });
      let detail = created;
      for (const bodyPart of Object.keys(manifest.mix.recipe) as BodyPart[]) {
        detail = await store.addCompositionPart(created.composition.id, {
          partId: parts.get(bodyPart)!.id,
        });
      }
      expect(detail.report).toMatchObject({
        targetArmType: "slim",
        layerCount: 6,
        hardConflictCount: 0,
        modelConflictCount: 0,
        unknownConflictCount: 0,
        unresolvedConflictCount: 0,
        committable: true,
      });

      const expected = decodeSkinPng(
        await readFile(join(REAL_SKIN_DIRECTORY, manifest.mix.file)),
      );
      expect(
        decodeSkinPng(
          await store.readCompositionPreviewPng(created.composition.id),
        ).data,
      ).toEqual(expected.data);

      const committed = await store.commitComposition(created.composition.id);
      expect(
        decodeSkinPng(await store.readRevisionSkinPng(committed.revision.id)).data,
      ).toEqual(expected.data);
      const state = await store.readRevisionSemanticState(committed.revision.id);
      expect(state.document.source.armType).toBe("slim");
      expect(state.document.components).toHaveLength(6);
      expect(state.document.unknown.pixelCount).toBe(0);
      const compositionOrigin = await store.readRevisionOrigin(
        committed.revision.id,
      );
      expect(compositionOrigin?.copyLineage.length).toBeGreaterThan(0);
      expect(
        compositionOrigin?.copyLineage.every(
          (entry) => entry.copiedFrom.sourceSubject.kind === "part",
        ),
      ).toBe(true);
      expect(await store.readRevisionOperation(committed.revision.id)).toMatchObject({
        type: "compose",
        inputRevisionId: base.revision.id,
        affectedComponents: expect.arrayContaining([
          expect.stringMatching(/^composed\./),
        ]),
      });
    } finally {
      store.close();
    }
  });

  it("persists versioned restoration plans, blocks partial coverage, and commits honest provenance", async () => {
    const created = await createStore();
    const { store, directory } = created;
    try {
      const image = createRgbaImage(64, 64);
      const layout = getSkinLayout("slim");
      const basePixelId = 20 * 64 + 20;
      const outerPixelId = 36 * 64 + 44;
      image.data.set([90, 80, 70, 255], basePixelId * 4);
      image.data.set([40, 50, 60, 255], outerPixelId * 4);
      const imported = await store.importProject({
        name: "Restoration source",
        armType: "slim",
        skinPng: encodeSkinPng(image),
      });
      const segmented = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "outfit.cleanup",
            displayName: "旧衣服",
            category: "upper_clothing",
          },
          spans: pixelIdsToSpans([basePixelId, outerPixelId], layout),
        },
      });
      const composition = await store.createComposition({
        baseRevisionId: segmented.revision.id,
      });
      const generated = await store.generateCompositionRestorationCandidates(
        composition.composition.id,
        {
          targetComponentIds: ["outfit.cleanup"],
          manualRgba: [210, 170, 140, 255],
        },
      );
      expect(generated).toMatchObject({
        version: 0,
        targetComponentIds: ["outfit.cleanup"],
        outer: { pixelCount: 1 },
        base: { pixelCount: 1 },
      });
      expect(store.listCompositionRestorationEvents(composition.composition.id)).toEqual([]);
      const manual = generated.base.candidates.find(
        (candidate) => candidate.kind === "manual_rgba",
      )!;
      const partial = await store.setCompositionRestorationPlan(
        composition.composition.id,
        {
          expectedVersion: 0,
          candidateSetHash: generated.candidateSetHash,
          candidateIds: [],
          targetComponentIds: ["outfit.cleanup"],
          manualRgba: [210, 170, 140, 255],
        },
      );
      expect(partial.composition.restorationVersion).toBe(1);
      expect(partial.report).toMatchObject({
        restorationMissingPixelCount: 1,
        committable: false,
      });
      await expect(store.commitComposition(composition.composition.id)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      const cleared = await store.clearCompositionRestorationPlan(
        composition.composition.id,
        { expectedVersion: 1 },
      );
      expect(cleared.composition).toMatchObject({
        restorationVersion: 2,
        restorationPlan: null,
      });
      const regenerated = await store.generateCompositionRestorationCandidates(
        composition.composition.id,
        {
          targetComponentIds: ["outfit.cleanup"],
          manualRgba: [210, 170, 140, 255],
        },
      );
      expect(regenerated.version).toBe(2);
      expect(regenerated.candidateSetHash).toBe(generated.candidateSetHash);
      const ready = await store.setCompositionRestorationPlan(
        composition.composition.id,
        {
          expectedVersion: 2,
          candidateSetHash: regenerated.candidateSetHash,
          candidateIds: [manual.id],
          targetComponentIds: ["outfit.cleanup"],
          manualRgba: [210, 170, 140, 255],
        },
      );
      expect(ready.report).toMatchObject({
        restorationMissingPixelCount: 0,
        restorationIssueCount: 0,
        restoredOuterPixelCount: 1,
        restoredBasePixelCount: 1,
        committable: true,
      });
      expect(JSON.stringify(ready.composition)).not.toContain("pixelIds");
      expect(store.listCompositionRestorationEvents(composition.composition.id)).toMatchObject([
        { version: 1, eventType: "plan_set" },
        { version: 2, eventType: "plan_cleared" },
        {
          version: 3,
          eventType: "plan_set",
          candidateIds: expect.arrayContaining([
            generated.outer.candidateId,
            manual.id,
          ]),
        },
      ]);
      store.close();

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        const reopenedDetail = await reopened.getCompositionDetail(composition.composition.id);
        expect(reopenedDetail.report.restorationIssueCount).toBe(0);
        const committed = await reopened.commitComposition(composition.composition.id);
        const result = decodeSkinPng(await reopened.readRevisionSkinPng(committed.revision.id));
        expect(getPixel(result, 20, 20)).toEqual([210, 170, 140, 255]);
        expect(getPixel(result, 44, 36)).toEqual([0, 0, 0, 0]);
        const state = await reopened.readRevisionSemanticState(committed.revision.id);
        const restored = state.document.components.find((component) =>
          component.instanceId.startsWith("restored."),
        );
        expect(restored?.provenance).toMatchObject({
          actorType: "user",
          containsGeneratedPixels: false,
          originSummary: {
            counts: {
              source_visible: 0,
              manual_authored: 1,
              generated_completion: 0,
              legacy_mixed: 0,
            },
          },
          restoration: {
            candidateIds: [manual.id],
            sourceRevisionIds: [],
            sourceComponentIds: [],
          },
        });
        const origin = await reopened.readRevisionOrigin(committed.revision.id);
        expect(getPixelOrigin(origin!, basePixelId)).toMatchObject({
          intrinsicOrigin: "manual_authored",
          evidence: { actor: { type: "user" }, operationId: committed.revision.id },
          copyLineage: null,
        });
        expect(getPixelOrigin(origin!, outerPixelId)).toBeUndefined();
        expect(await reopened.readRevisionOperation(committed.revision.id)).toMatchObject({
          affectedSpans: pixelIdsToSpans([basePixelId, outerPixelId], layout),
        });
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("rejects a rehashed restoration plan with inconsistent representations", async () => {
    const { directory, store } = await createStore();
    try {
      const image = createRgbaImage(64, 64);
      image.data.set([80, 70, 60, 255], (8 * 64 + 8) * 4);
      const imported = await store.importProject({
        name: "Restoration integrity source",
        armType: "slim",
        skinPng: encodeSkinPng(image),
      });
      const segmented = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "outfit.integrity",
            displayName: "Integrity outfit",
            category: "upper_clothing",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      const composition = await store.createComposition({
        baseRevisionId: segmented.revision.id,
      });
      const candidates = await store.generateCompositionRestorationCandidates(
        composition.composition.id,
        {
          targetComponentIds: ["outfit.integrity"],
          manualRgba: [200, 160, 120, 255],
        },
      );
      const manual = candidates.base.candidates.find(
        (candidate) => candidate.kind === "manual_rgba",
      )!;
      await store.setCompositionRestorationPlan(composition.composition.id, {
        expectedVersion: 0,
        candidateSetHash: candidates.candidateSetHash,
        candidateIds: [manual.id],
        targetComponentIds: ["outfit.integrity"],
        manualRgba: [200, 160, 120, 255],
      });
      store.close();

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
        const row = database
          .prepare("SELECT restoration_plan_json FROM composition_project WHERE id = ?")
          .get(composition.composition.id) as { readonly restoration_plan_json: string };
        const originalPlan = JSON.parse(row.restoration_plan_json) as {
          storageHash: string;
          summary: { candidateIds: string[] };
        };
        for (const mutate of [
          (plan: typeof originalPlan) => {
            plan.summary.candidateIds = [];
          },
          (plan: typeof originalPlan & { selectedCandidates: Array<{ kind: string }> }) => {
            plan.selectedCandidates[0]!.kind = "invalid_kind";
          },
          (plan: typeof originalPlan & {
            operations: Array<{ pixelIds: number[] }>;
          }) => {
            plan.operations[0]!.pixelIds = [];
          },
        ]) {
          const plan = structuredClone(originalPlan) as typeof originalPlan & {
            selectedCandidates: Array<{ kind: string }>;
            operations: Array<{ pixelIds: number[] }>;
          };
          mutate(plan);
          const { storageHash: _storageHash, ...body } = plan;
          plan.storageHash = sha256(canonicalJson(body).trim());
          database
            .prepare("UPDATE composition_project SET restoration_plan_json = ? WHERE id = ?")
            .run(JSON.stringify(plan), composition.composition.id);
          const corrupted = new RevisionStore({ dataDirectory: directory });
          try {
            expect(() => corrupted.getComposition(composition.composition.id)).toThrow(
              expect.objectContaining({ code: "SNAPSHOT_CORRUPT", statusCode: 409 }),
            );
          } finally {
            corrupted.close();
          }
        }
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });

  it("round-trips a Base-only incomplete restoration plan with no selected candidate", async () => {
    const { directory, store } = await createStore();
    try {
      const image = createRgbaImage(64, 64);
      const basePixelId = 8 * 64 + 8;
      image.data.set([80, 70, 60, 255], basePixelId * 4);
      const imported = await store.importProject({
        name: "Base-only incomplete restoration",
        armType: "slim",
        skinPng: encodeSkinPng(image),
      });
      const segmented = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "outfit.base_only",
            displayName: "Base-only outfit",
            category: "upper_clothing",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      const composition = await store.createComposition({
        baseRevisionId: segmented.revision.id,
      });
      const generated = await store.generateCompositionRestorationCandidates(
        composition.composition.id,
        { targetComponentIds: ["outfit.base_only"] },
      );
      expect(generated).toMatchObject({
        outer: { pixelCount: 0, candidateId: null },
        base: { pixelCount: 1 },
      });

      const incomplete = await store.setCompositionRestorationPlan(
        composition.composition.id,
        {
          expectedVersion: 0,
          candidateSetHash: generated.candidateSetHash,
          candidateIds: [],
          targetComponentIds: ["outfit.base_only"],
        },
      );
      expect(incomplete.composition.restorationPlan).toMatchObject({
        version: 1,
        candidateIds: [],
        coveredPixelCount: 0,
        missingPixelCount: 1,
      });
      expect(incomplete.report).toMatchObject({
        restorationPixelCount: 0,
        restorationMissingPixelCount: 1,
        committable: false,
      });
      await expect(store.commitComposition(composition.composition.id)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      store.close();

      const reopened = new RevisionStore({ dataDirectory: directory });
      try {
        const detail = await reopened.getCompositionDetail(composition.composition.id);
        expect(detail.composition.restorationPlan).toMatchObject({
          version: 1,
          candidateIds: [],
          coveredPixelCount: 0,
          missingPixelCount: 1,
        });
        expect(detail.report).toMatchObject({
          restorationPixelCount: 0,
          restorationMissingPixelCount: 1,
          committable: false,
        });
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("does not retain a restoration component fully covered by a winning part", async () => {
    const { store } = await createStore();
    try {
      const pixelId = 8 * 64 + 8;
      const image = createRgbaImage(64, 64);
      image.data.set([80, 70, 60, 255], pixelId * 4);
      const imported = await store.importProject({
        name: "Covered restoration source",
        armType: "slim",
        skinPng: encodeSkinPng(image),
      });
      const segmented = await store.applyManualOperation(imported.revision.id, {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "outfit.covered",
            displayName: "Covered outfit",
            category: "upper_clothing",
          },
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        },
      });
      const composition = await store.createComposition({
        baseRevisionId: segmented.revision.id,
      });
      const part = await exportHeadPixelPart(store, [12, 34, 56, 255]);
      await store.addCompositionPart(composition.composition.id, { partId: part.id });
      const candidates = await store.generateCompositionRestorationCandidates(
        composition.composition.id,
        {
          targetComponentIds: ["outfit.covered"],
          manualRgba: [200, 160, 120, 255],
        },
      );
      const manual = candidates.base.candidates.find(
        (candidate) => candidate.kind === "manual_rgba",
      )!;
      await store.setCompositionRestorationPlan(composition.composition.id, {
        expectedVersion: 0,
        candidateSetHash: candidates.candidateSetHash,
        candidateIds: [manual.id],
        targetComponentIds: ["outfit.covered"],
        manualRgba: [200, 160, 120, 255],
      });
      const resolved = await store.resolveCompositionConflict(composition.composition.id, {
        strategy: "layer_order",
      });
      expect(resolved.report.committable).toBe(true);

      const committed = await store.commitComposition(composition.composition.id);
      const state = await store.readRevisionSemanticState(committed.revision.id);
      expect(
        state.document.components.some((component) =>
          component.instanceId.startsWith("restored."),
        ),
      ).toBe(false);
      expect(
        state.document.components.some((component) =>
          component.instanceId.startsWith("composed."),
        ),
      ).toBe(true);
      const operation = await store.readRevisionOperation(committed.revision.id);
      expect(operation.affectedComponents).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^restored\./u)]),
      );
      expect(operation.affectedSpans).toEqual([
        { surface: "head.base.front", y: 8, x0: 8, x1: 8 },
      ]);
    } finally {
      store.close();
    }
  });

  it("creates new revert and branch nodes without mutating historical snapshots", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const originalDirectory = join(
        directory,
        "projects",
        imported.project.id,
        "revisions",
        imported.revision.id,
      );
      const originalFiles = await readSnapshotFiles(originalDirectory);

      const firstRevert = await store.revertRevision(imported.revision.id);
      const secondRevert = await store.revertRevision(imported.revision.id);
      const branchResult = await store.branchFromRevision(imported.revision.id, {
        name: "historical-mix",
      });

      expect(firstRevert.revision).toMatchObject({
        parentRevisionId: imported.revision.id,
        sequence: 2,
        operationType: "revert",
      });
      expect(secondRevert.revision).toMatchObject({
        parentRevisionId: firstRevert.revision.id,
        sequence: 3,
        operationType: "revert",
      });
      expect(branchResult.branch).toMatchObject({
        name: "historical-mix",
        baseRevisionId: imported.revision.id,
        headRevisionId: branchResult.revision.id,
      });
      expect(branchResult.revision).toMatchObject({
        parentRevisionId: imported.revision.id,
        sequence: 1,
        operationType: "branch",
        isBranchHead: true,
      });

      const mainBranch = store.getBranch(imported.branch.id);
      expect(mainBranch.headRevisionId).toBe(secondRevert.revision.id);
      expect(store.getProject(imported.project.id).headRevisionId).toBe(
        secondRevert.revision.id,
      );
      expect(store.listRevisions(imported.project.id)).toHaveLength(4);

      for (const revision of store.listRevisions(imported.project.id)) {
        await expect(store.readRevisionSkinPng(revision.id)).resolves.toBeInstanceOf(
          Uint8Array,
        );
      }
      expect(
        await store.diffRevisions(
          imported.revision.id,
          branchResult.revision.id,
        ),
      ).toMatchObject({
        changedPixelCount: 0,
        changedPixelIds: [],
        boundingBox: null,
      });
      expect(await readSnapshotFiles(originalDirectory)).toEqual(originalFiles);
    } finally {
      store.close();
    }
  });

  it("serializes concurrent writes into a stable parent chain", async () => {
    const { store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const [first, second] = await Promise.all([
        store.revertRevision(imported.revision.id),
        store.revertRevision(imported.revision.id),
      ]);

      expect(first.revision.sequence).toBe(2);
      expect(first.revision.parentRevisionId).toBe(imported.revision.id);
      expect(second.revision.sequence).toBe(3);
      expect(second.revision.parentRevisionId).toBe(first.revision.id);
      expect(store.getBranch(imported.branch.id).headRevisionId).toBe(
        second.revision.id,
      );
    } finally {
      store.close();
    }
  });

  it("loads every revision after reopening the SQLite database", async () => {
    const created = await createStore();
    const imported = await importRealSkin(created.store);
    const reverted = await created.store.revertRevision(imported.revision.id);
    const branched = await created.store.branchFromRevision(imported.revision.id, {
      name: "reopen-check",
    });
    created.store.close();

    const reopened = new RevisionStore({ dataDirectory: created.directory });
    try {
      expect(reopened.listProjects()).toHaveLength(1);
      expect(reopened.listBranches(imported.project.id)).toHaveLength(2);
      for (const revisionId of [
        imported.revision.id,
        reverted.revision.id,
        branched.revision.id,
      ]) {
        expect(reopened.getRevision(revisionId).id).toBe(revisionId);
        await expect(reopened.verifyRevisionSnapshot(revisionId)).resolves.toMatchObject(
          { checksum: { revisionId } },
        );
      }
    } finally {
      reopened.close();
    }
  });

  it("rejects duplicate branch names without creating another revision", async () => {
    const { store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      await store.branchFromRevision(imported.revision.id, { name: "variant" });
      const revisionsBefore = store.listRevisions(imported.project.id);

      await expect(
        store.branchFromRevision(imported.revision.id, { name: "variant" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.listRevisions(imported.project.id)).toEqual(revisionsBefore);
    } finally {
      store.close();
    }
  });

  it("refuses to load a revision whose checksum manifest was corrupted", async () => {
    const { directory, store } = await createStore();

    try {
      const imported = await importRealSkin(store);
      const checksumPath = join(
        directory,
        "projects",
        imported.project.id,
        "revisions",
        imported.revision.id,
        "checksum.json",
      );
      await writeFile(checksumPath, "{\"schemaVersion\":\"tampered\"}\n", "utf8");

      const error = await store
        .verifyRevisionSnapshot(imported.revision.id)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RevisionStoreError);
      expect(error).toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });

  it("round-trips a skin-texel Completion accept with semantic ownership and exact idempotency", async () => {
    const { store } = await createStore();
    try {
      const fixture = await createCompletionFixture(store, "skin_texel");
      const pending = await store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      expect(pending).toMatchObject({
        visible: false,
        jobStatus: "validating",
        ranking: null,
        decision: null,
      });
      expect(sha256(await store.readCompletionAllowedMaskPng(
        fixture.proposal.proposalId,
      ))).toBe(pending.proposal.allowedMask.sha256);
      await expect(store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      })).resolves.toMatchObject({
        proposal: { id: fixture.proposal.proposalId },
        visible: false,
      });
      await expect(store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: {
          ...fixture.proposal,
          proposalId: `${fixture.proposal.proposalId}_other`,
        },
      })).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      finishCompletionJob(store, fixture.jobId, fixture.proposal.proposalHash);
      expect(await store.listCompletionProposals({
        jobId: fixture.jobId,
      })).toHaveLength(1);

      const candidate = fixture.proposal.candidates.find(
        (item) => item.strategy === "same_surface_continuation",
      ) ?? fixture.proposal.candidates[0]!;
      const decisionInput = {
        candidateId: candidate.candidateId,
        expectedSourceResultHash: fixture.proposal.sourceResultHash,
        expectedProposalHash: fixture.proposal.proposalHash,
        expectedEvidenceHash: fixture.proposal.evidenceHash,
        expectedCandidateHash: candidate.candidateHash,
        actorId: "completion-reviewer",
      } as const;
      const accepted = await store.acceptCompletionCandidate(
        fixture.proposal.proposalId,
        decisionInput,
      );
      expect(accepted.changed).toBe(true);
      expect(accepted.detail.result).toMatchObject({
        representation: "skin_texel",
        sourceRevisionId: fixture.sourceRevisionId,
        latentPart: null,
        revision: {
          parentRevisionId: fixture.sourceRevisionId,
          branchId: fixture.branchId,
          operationType: "completion_accept",
          actorType: "user",
          actorId: "completion-reviewer",
        },
      });
      const resultRevision = accepted.detail.result!.revision!;
      expect(store.getBranch(fixture.branchId).headRevisionId).toBe(
        resultRevision.id,
      );
      expect(accepted.detail.result!.resultSkinHash).not.toBe(
        fixture.proposal.sourceSkinHash,
      );
      expect(accepted.detail.result!.resultHash).toBe(resultRevision.resultHash);

      const sourceState = await store.readRevisionSemanticState(
        fixture.sourceRevisionId,
      );
      const resultState = await store.readRevisionSemanticState(resultRevision.id);
      expect(maskToPixelIds(resultState.masks[fixture.targetComponentId]!)).toEqual(
        [...new Set([
          ...maskToPixelIds(sourceState.masks[fixture.targetComponentId]!),
          ...candidate.pixelIds,
        ])].sort((left, right) => left - right),
      );
      expect(maskToPixelIds(resultState.masks[fixture.occludingComponentId]!))
        .toEqual(maskToPixelIds(sourceState.masks[fixture.occludingComponentId]!));
      expect(maskToPixelIds(resultState.unknownMask)).toEqual(
        maskToPixelIds(sourceState.unknownMask),
      );
      const resultSnapshot = await store.verifyRevisionSnapshot(resultRevision.id);
      const resultOrigin = JSON.parse(
        Buffer.from(resultSnapshot.files["origin.json"]!.bytes).toString("utf8"),
      ) as PixelOriginDocument;
      for (const pixelId of candidate.pixelIds) {
        expect(getPixelOrigin(resultOrigin, pixelId)).toMatchObject({
          intrinsicOrigin: "generated_completion",
          evidence: {
            candidateId: candidate.candidateId,
            decisionId: accepted.detail.decision!.id,
          },
        });
      }

      await expect(store.acceptCompletionCandidate(
        fixture.proposal.proposalId,
        decisionInput,
      )).resolves.toMatchObject({ changed: false });
      await expect(store.rejectCompletionProposal(
        fixture.proposal.proposalId,
        {
          expectedSourceResultHash: fixture.proposal.sourceResultHash,
          expectedProposalHash: fixture.proposal.proposalHash,
          expectedEvidenceHash: fixture.proposal.evidenceHash,
          actorId: "completion-reviewer",
        },
      )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });

      const database = new Database(store.databasePath);
      try {
        expect(() => database.prepare(`
          UPDATE completion_result SET result_skin_hash = ? WHERE proposal_id = ?
        `).run(`sha256:${"f".repeat(64)}`, fixture.proposal.proposalId))
          .toThrow(/immutable/u);
        database.exec("DROP TRIGGER completion_result_immutable_update");
        database.prepare(`
          UPDATE completion_result SET result_skin_hash = ? WHERE proposal_id = ?
        `).run(`sha256:${"f".repeat(64)}`, fixture.proposal.proposalId);
      } finally {
        database.close();
      }
      await expect(store.getCompletionProposalDetail(fixture.proposal.proposalId))
        .rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });

  it("persists and deterministically replays a bounded manual Completion candidate", async () => {
    const created = await createStore();
    let activeStore: RevisionStore = created.store;
    try {
      const fixture = await createCompletionFixture(activeStore, "skin_texel");
      await activeStore.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(activeStore, fixture.jobId, fixture.proposal.proposalHash);
      const base = fixture.proposal.candidates[0]!;
      const pixelId = base.pixelIds[0]!;
      const input = {
        expectedSourceResultHash: fixture.proposal.sourceResultHash,
        expectedProposalHash: fixture.proposal.proposalHash,
        expectedEvidenceHash: fixture.proposal.evidenceHash,
        expectedCandidateHash: base.candidateHash,
        actorId: "manual-candidate-editor",
        edits: [{
          type: "set_pixel" as const,
          pixelId,
          rgba: [9, 8, 7, 128] as [number, number, number, number],
        }],
      };

      const edited = await activeStore.editCompletionCandidate(
        fixture.proposal.proposalId,
        base.candidateId,
        input,
      );
      expect(edited.changed).toBe(true);
      expect(edited.detail.document.candidates).toHaveLength(
        fixture.proposal.candidates.length,
      );
      expect(edited.detail.candidateCount).toBe(fixture.proposal.candidates.length + 1);
      const storedCandidate = edited.detail.candidates.find(
        (candidate) => candidate.id === edited.editedCandidateId,
      )!;
      expect(storedCandidate).toMatchObject({
        strategy: "manual_edit",
        confidence: "manual",
        baseCandidateId: base.candidateId,
      });
      await expect(activeStore.editCompletionCandidate(
        fixture.proposal.proposalId,
        base.candidateId,
        input,
      )).resolves.toMatchObject({
        changed: false,
        editedCandidateId: edited.editedCandidateId,
      });
      await expect(activeStore.editCompletionCandidate(
        fixture.proposal.proposalId,
        base.candidateId,
        { ...input, edits: [{ type: "remove_pixel", pixelId: 0 }] },
      )).rejects.toMatchObject({ code: "INVALID_INPUT", statusCode: 400 });

      activeStore.close();
      activeStore = new RevisionStore({ dataDirectory: created.directory });
      const roundTrip = await activeStore.getCompletionProposalDetail(
        fixture.proposal.proposalId,
      );
      expect(roundTrip.candidates.find(
        (candidate) => candidate.id === edited.editedCandidateId,
      )).toMatchObject({ baseCandidateId: base.candidateId });
      await expect(activeStore.acceptCompletionCandidate(
        fixture.proposal.proposalId,
        {
          candidateId: edited.editedCandidateId,
          expectedSourceResultHash: fixture.proposal.sourceResultHash,
          expectedProposalHash: fixture.proposal.proposalHash,
          expectedEvidenceHash: fixture.proposal.evidenceHash,
          expectedCandidateHash: base.candidateHash,
          actorId: "manual-candidate-editor",
        },
      )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      const accepted = await activeStore.acceptCompletionCandidate(
        fixture.proposal.proposalId,
        {
          candidateId: edited.editedCandidateId,
          expectedSourceResultHash: fixture.proposal.sourceResultHash,
          expectedProposalHash: fixture.proposal.proposalHash,
          expectedEvidenceHash: fixture.proposal.evidenceHash,
          expectedCandidateHash: storedCandidate.candidateHash,
          actorId: "manual-candidate-editor",
        },
      );
      const origin = await activeStore.readRevisionOrigin(
        accepted.detail.result!.revision!.id,
      );
      expect(getPixelOrigin(origin!, pixelId)).toMatchObject({
        intrinsicOrigin: "manual_authored",
        evidence: {
          actor: { type: "user", id: "manual-candidate-editor" },
        },
      });
    } finally {
      activeStore.close();
    }
  });

  it("rejects tampered derived Completion assignments and freezes edit evidence", async () => {
    const { store } = await createStore();
    try {
      const fixture = await createCompletionFixture(store, "skin_texel");
      await store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(store, fixture.jobId, fixture.proposal.proposalHash);
      const base = fixture.proposal.candidates[0]!;
      const requestedPixelId = base.pixelIds[0]!;
      const edited = await store.editCompletionCandidate(
        fixture.proposal.proposalId,
        base.candidateId,
        {
          expectedSourceResultHash: fixture.proposal.sourceResultHash,
          expectedProposalHash: fixture.proposal.proposalHash,
          expectedEvidenceHash: fixture.proposal.evidenceHash,
          expectedCandidateHash: base.candidateHash,
          actorId: "tamper-test-editor",
          edits: [{
            type: "set_pixel",
            pixelId: requestedPixelId,
            rgba: [10, 20, 30, 64],
          }],
        },
      );

      const database = new Database(store.databasePath);
      try {
        expect(() => database.prepare(`
          UPDATE completion_candidate_edit
          SET actor_id = 'tampered'
          WHERE candidate_id = ?
        `).run(edited.editedCandidateId)).toThrow(
          /completion_candidate_edit is immutable/u,
        );
        expect(() => database.prepare(`
          DELETE FROM completion_candidate_edit WHERE candidate_id = ?
        `).run(edited.editedCandidateId)).toThrow(
          /completion_candidate_edit is immutable/u,
        );

        expect(() => insertTamperedDerivedCompletionCandidate(
          database,
          edited.editedCandidateId,
          "extra",
          (document) => {
            const unedited = document.assignments.find(
              (assignment) => assignment.targetPixelId !== requestedPixelId,
            );
            if (!unedited) throw new Error("Expected one unedited assignment");
            document.assignments.push({ ...unedited, targetPixelId: 0 });
          },
        )).toThrow(/invalid completion candidate binding/u);

        expect(() => insertTamperedDerivedCompletionCandidate(
          database,
          edited.editedCandidateId,
          "missing",
          (document) => {
            document.assignments = document.assignments.filter(
              (assignment) => assignment.targetPixelId === requestedPixelId,
            );
          },
        )).toThrow(/invalid completion candidate binding/u);

        expect(() => insertTamperedDerivedCompletionCandidate(
          database,
          edited.editedCandidateId,
          "empty",
          (document) => {
            document.assignments = [];
          },
          {
            edits: base.assignments.map((assignment) => ({
              type: "remove_pixel",
              pixelId: assignment.targetPixelId,
            })),
            hashCharacter: "5",
          },
        )).toThrow(/invalid completion candidate binding/u);

        const baseAssignment = base.assignments.find(
          (assignment) => assignment.targetPixelId === requestedPixelId,
        )!;
        expect(() => insertTamperedDerivedCompletionCandidate(
          database,
          edited.editedCandidateId,
          "same_rgba",
          (document) => {
            const assignment = document.assignments.find(
              (item) => item.targetPixelId === requestedPixelId,
            )!;
            assignment.rgba = [...baseAssignment.rgba];
          },
          {
            edits: [{
              type: "set_pixel",
              pixelId: requestedPixelId,
              rgba: [...baseAssignment.rgba],
            }],
            hashCharacter: "6",
          },
        )).toThrow(/invalid completion candidate binding/u);

        expect(() => insertTamperedDerivedCompletionCandidate(
          database,
          edited.editedCandidateId,
          "extra_assignment_key",
          (document) => {
            const assignment = document.assignments.find(
              (item) => item.targetPixelId === requestedPixelId,
            )!;
            assignment.unexpected = true;
          },
          { hashCharacter: "7" },
        )).toThrow(/invalid completion candidate binding/u);

        expect(() => insertTamperedDerivedCompletionCandidate(
          database,
          edited.editedCandidateId,
          "extra_actor_key",
          (document) => {
            const assignment = document.assignments.find(
              (item) => item.targetPixelId === requestedPixelId,
            )!;
            assignment.manualActor = {
              type: "user",
              id: "tamper-test-editor",
              unexpected: true,
            };
          },
          { hashCharacter: "8" },
        )).toThrow(/invalid completion candidate binding/u);
        expect(database.prepare(`
          SELECT count(*) AS count FROM completion_candidate_edit
          WHERE proposal_id = ?
        `).get(fixture.proposal.proposalId)).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });

  it("fails closed for malformed or self-referential Completion edit rows", async () => {
    const { store } = await createStore();
    try {
      const fixture = await createCompletionFixture(store, "skin_texel");
      await store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(store, fixture.jobId, fixture.proposal.proposalHash);
      const base = fixture.proposal.candidates[0]!;
      const database = new Database(store.databasePath);
      try {
        const insertEdit = database.prepare(`
          INSERT INTO completion_candidate_edit (
            candidate_id,
            proposal_id,
            base_candidate_id,
            expected_source_result_hash,
            expected_proposal_hash,
            expected_evidence_hash,
            expected_candidate_hash,
            actor_type,
            actor_id,
            operation_id,
            edits_json,
            edit_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'sql-guard-test', ?, ?, ?, ?)
        `);
        const attempt = (
          suffix: string,
          edits: readonly unknown[],
          hashCharacter: string,
          candidateId = `candidate_sql_guard_${suffix}`,
        ) => insertEdit.run(
          candidateId,
          fixture.proposal.proposalId,
          base.candidateId,
          fixture.proposal.sourceResultHash,
          fixture.proposal.proposalHash,
          fixture.proposal.evidenceHash,
          base.candidateHash,
          `edit_sql_guard_${suffix}`,
          JSON.stringify(edits),
          `sha256:${hashCharacter.repeat(64)}`,
          "2026-08-19T12:00:00.000Z",
        );

        expect(() => attempt(
          "missing_type",
          [{ pixelId: base.pixelIds[0]! }],
          "1",
        )).toThrow(/invalid completion candidate edit binding/u);
        expect(() => attempt(
          "missing_rgba",
          [{ type: "set_pixel", pixelId: base.pixelIds[0]! }],
          "2",
        )).toThrow(/invalid completion candidate edit binding/u);
        expect(() => attempt(
          "extra_field",
          [{
            type: "remove_pixel",
            pixelId: base.pixelIds[0]!,
            unexpected: true,
          }],
          "3",
        )).toThrow(/invalid completion candidate edit binding/u);
        expect(() => attempt(
          "self_reference",
          [{ type: "remove_pixel", pixelId: base.pixelIds[0]! }],
          "4",
          base.candidateId,
        )).toThrow(/CHECK constraint failed|invalid completion candidate edit binding/u);

        expect(database.prepare(`
          SELECT count(*) AS count FROM completion_candidate_edit
          WHERE proposal_id = ?
        `).get(fixture.proposal.proposalId)).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });

  it("deduplicates the same manual Completion edit across two stores without deleting files", async () => {
    const created = await createStore();
    const primary = created.store;
    let secondary: RevisionStore | null = null;
    try {
      const fixture = await createCompletionFixture(primary, "skin_texel");
      await primary.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(primary, fixture.jobId, fixture.proposal.proposalHash);
      secondary = new RevisionStore({ dataDirectory: created.directory });
      const base = fixture.proposal.candidates[0]!;
      const input = {
        expectedSourceResultHash: fixture.proposal.sourceResultHash,
        expectedProposalHash: fixture.proposal.proposalHash,
        expectedEvidenceHash: fixture.proposal.evidenceHash,
        expectedCandidateHash: base.candidateHash,
        actorId: "concurrent-editor",
        edits: [{
          type: "set_pixel" as const,
          pixelId: base.pixelIds[0]!,
          rgba: [70, 80, 90, 200] as [number, number, number, number],
        }],
      };
      const outcomes = await Promise.all([
        primary.editCompletionCandidate(
          fixture.proposal.proposalId,
          base.candidateId,
          input,
        ),
        secondary.editCompletionCandidate(
          fixture.proposal.proposalId,
          base.candidateId,
          input,
        ),
      ]);
      expect(outcomes.map((outcome) => outcome.changed).sort()).toEqual([false, true]);
      expect(new Set(outcomes.map((outcome) => outcome.editedCandidateId)).size).toBe(1);
      const candidateId = outcomes[0]!.editedCandidateId;
      await expect(primary.verifyCompletionCandidateStorage(candidateId)).resolves
        .toMatchObject({ candidateId });
      expect((await primary.getCompletionProposalDetail(
        fixture.proposal.proposalId,
      )).candidates.filter((candidate) => candidate.id === candidateId)).toHaveLength(1);
    } finally {
      secondary?.close();
      primary.close();
    }
  });

  it("persists a latent Completion as an unpublished immutable Part without moving HEAD", async () => {
    const created = await createStore();
    let activeStore: RevisionStore = created.store;
    try {
      const fixture = await createCompletionFixture(activeStore, "latent_component");
      await activeStore.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(
        activeStore,
        fixture.jobId,
        fixture.proposal.proposalHash,
      );
      const candidate = fixture.proposal.candidates.find(
        (item) => item.strategy === "opposite_surface_reference",
      ) ?? fixture.proposal.candidates[0]!;
      const revisionsBefore = activeStore.listRevisions(fixture.projectId);
      const sourceSkin = await activeStore.readRevisionSkinPng(
        fixture.sourceRevisionId,
      );
      const accepted = await activeStore.acceptCompletionCandidate(
        fixture.proposal.proposalId,
        {
          candidateId: candidate.candidateId,
          expectedSourceResultHash: fixture.proposal.sourceResultHash,
          expectedProposalHash: fixture.proposal.proposalHash,
          expectedEvidenceHash: fixture.proposal.evidenceHash,
          expectedCandidateHash: candidate.candidateHash,
          actorId: "completion-reviewer",
        },
      );
      const result = accepted.detail.result!;
      const part = result.latentPart!;
      expect(result).toMatchObject({
        representation: "latent_component",
        revision: null,
        resultSkinHash: fixture.proposal.sourceSkinHash,
        publishedAt: null,
      });
      expect(activeStore.listRevisions(fixture.projectId)).toEqual(revisionsBefore);
      expect(activeStore.getBranch(fixture.branchId).headRevisionId).toBe(
        fixture.sourceRevisionId,
      );
      expect(await activeStore.readRevisionSkinPng(fixture.sourceRevisionId))
        .toEqual(sourceSkin);
      expect(activeStore.getPart(part.id).id).toBe(part.id);
      expect(activeStore.listParts({ projectId: fixture.projectId })).toEqual([]);
      const storedPart = await activeStore.verifyPartStorage(part.id);
      const origin = JSON.parse(
        Buffer.from(storedPart.files["origin.json"]!.bytes).toString("utf8"),
      ) as PixelOriginDocument;
      expect(getPixelOrigin(origin, fixture.visibleTarget.pixelId)).toMatchObject({
        intrinsicOrigin: "source_visible",
        copyLineage: {
          sourceSubject: { kind: "revision", id: fixture.sourceRevisionId },
          sourceComponentInstanceId: fixture.targetComponentId,
          sourcePixelId: fixture.visibleTarget.pixelId,
        },
      });
      for (const pixelId of candidate.pixelIds) {
        expect(getPixelOrigin(origin, pixelId)).toMatchObject({
          intrinsicOrigin: "generated_completion",
        });
      }

      activeStore.close();
      activeStore = new RevisionStore({ dataDirectory: created.directory });
      const roundTrip = await activeStore.getCompletionProposalDetail(
        fixture.proposal.proposalId,
      );
      expect(roundTrip.result).toMatchObject({
        id: result.id,
        publishedAt: null,
        latentPart: { id: part.id },
      });
      expect(activeStore.listParts({ projectId: fixture.projectId })).toEqual([]);
      const published = await activeStore.publishCompletionResult(result.id, {
        actorId: "library-curator",
      });
      expect(published.publishedAt).not.toBeNull();
      expect(activeStore.listParts({ projectId: fixture.projectId }))
        .toMatchObject([{ id: part.id }]);

      const database = new Database(activeStore.databasePath);
      try {
        expect(() => database.prepare(`
          UPDATE completion_result SET result_hash = ? WHERE id = ?
        `).run(`sha256:${"f".repeat(64)}`, result.id)).toThrow(/immutable/u);
        database.exec("DROP TRIGGER completion_result_immutable_update");
        database.prepare(`
          UPDATE completion_result SET result_hash = ? WHERE id = ?
        `).run(`sha256:${"f".repeat(64)}`, result.id);
      } finally {
        database.close();
      }
      await expect(activeStore.getCompletionProposalDetail(
        fixture.proposal.proposalId,
      )).rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      activeStore.close();
    }
  });

  it("rejects Completion proposals idempotently without creating a Revision", async () => {
    const { store } = await createStore();
    try {
      const fixture = await createCompletionFixture(store, "skin_texel");
      await store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(store, fixture.jobId, fixture.proposal.proposalHash);
      const revisionsBefore = store.listRevisions(fixture.projectId);
      const input = {
        expectedSourceResultHash: fixture.proposal.sourceResultHash,
        expectedProposalHash: fixture.proposal.proposalHash,
        expectedEvidenceHash: fixture.proposal.evidenceHash,
        actorId: "completion-reviewer",
        reason: "Evidence is insufficient",
      } as const;
      await expect(store.rejectCompletionProposal(
        fixture.proposal.proposalId,
        { ...input, expectedProposalHash: `sha256:${"f".repeat(64)}` },
      )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      const rejected = await store.rejectCompletionProposal(
        fixture.proposal.proposalId,
        input,
      );
      expect(rejected).toMatchObject({
        changed: true,
        detail: {
          status: "rejected",
          decision: { action: "reject", candidateId: null },
          result: null,
        },
      });
      expect(store.listRevisions(fixture.projectId)).toEqual(revisionsBefore);
      await expect(store.rejectCompletionProposal(
        fixture.proposal.proposalId,
        input,
      )).resolves.toMatchObject({ changed: false });
      await expect(store.rejectCompletionProposal(
        fixture.proposal.proposalId,
        { ...input, reason: "Different terminal reason" },
      )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });

      const database = new Database(store.databasePath);
      try {
        const row = database.prepare(`
          SELECT decision_json FROM completion_decision WHERE proposal_id = ?
        `).get(fixture.proposal.proposalId) as { readonly decision_json: string };
        const tampered = canonicalCompletionJson({
          ...(JSON.parse(row.decision_json) as Record<string, unknown>),
          actor: { type: "user", id: "tampered-reviewer" },
        });
        expect(() => database.prepare(`
          UPDATE completion_decision SET decision_json = ? WHERE proposal_id = ?
        `).run(tampered, fixture.proposal.proposalId)).toThrow(/immutable/u);
        database.exec("DROP TRIGGER completion_decision_immutable_update");
        database.prepare(`
          UPDATE completion_decision SET decision_json = ? WHERE proposal_id = ?
        `).run(tampered, fixture.proposal.proposalId);
      } finally {
        database.close();
      }
      await expect(store.getCompletionProposalDetail(fixture.proposal.proposalId))
        .rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });

  it("rejects a stale Completion accept after the source Branch HEAD moves", async () => {
    const { store } = await createStore();
    try {
      const fixture = await createCompletionFixture(store, "skin_texel");
      await store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(store, fixture.jobId, fixture.proposal.proposalHash);
      await store.revertRevision(fixture.sourceRevisionId);
      const candidate = fixture.proposal.candidates[0]!;
      await expect(store.acceptCompletionCandidate(
        fixture.proposal.proposalId,
        {
          candidateId: candidate.candidateId,
          expectedSourceResultHash: fixture.proposal.sourceResultHash,
          expectedProposalHash: fixture.proposal.proposalHash,
          expectedEvidenceHash: fixture.proposal.evidenceHash,
          expectedCandidateHash: candidate.candidateHash,
          actorId: "completion-reviewer",
        },
      )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      expect((await store.getCompletionProposalDetail(
        fixture.proposal.proposalId,
      )).decision).toBeNull();
    } finally {
      store.close();
    }
  });

  it("returns one exact result for concurrent Completion accepts across stores", async () => {
    const created = await createStore();
    const primary = created.store;
    let secondary: RevisionStore | null = null;
    try {
      const fixture = await createCompletionFixture(primary, "skin_texel");
      await primary.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(primary, fixture.jobId, fixture.proposal.proposalHash);
      secondary = new RevisionStore({ dataDirectory: created.directory });
      const candidate = fixture.proposal.candidates[0]!;
      const input = {
        candidateId: candidate.candidateId,
        expectedSourceResultHash: fixture.proposal.sourceResultHash,
        expectedProposalHash: fixture.proposal.proposalHash,
        expectedEvidenceHash: fixture.proposal.evidenceHash,
        expectedCandidateHash: candidate.candidateHash,
        actorId: "concurrent-reviewer",
      } as const;
      const revisionCount = primary.listRevisions(fixture.projectId).length;
      const outcomes = await Promise.all([
        primary.acceptCompletionCandidate(fixture.proposal.proposalId, input),
        secondary.acceptCompletionCandidate(fixture.proposal.proposalId, input),
      ]);

      expect(outcomes.map((outcome) => outcome.changed).sort()).toEqual([
        false,
        true,
      ]);
      expect(new Set(outcomes.map((outcome) => outcome.detail.result!.id)).size)
        .toBe(1);
      expect(primary.listRevisions(fixture.projectId)).toHaveLength(
        revisionCount + 1,
      );
    } finally {
      secondary?.close();
      primary.close();
    }
  });

  it("normalizes concurrent different Completion decisions to an explicit conflict", async () => {
    const created = await createStore();
    const primary = created.store;
    let secondary: RevisionStore | null = null;
    try {
      const fixture = await createCompletionFixture(primary, "skin_texel");
      await primary.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      finishCompletionJob(primary, fixture.jobId, fixture.proposal.proposalHash);
      secondary = new RevisionStore({ dataDirectory: created.directory });
      const common = {
        expectedSourceResultHash: fixture.proposal.sourceResultHash,
        expectedProposalHash: fixture.proposal.proposalHash,
        expectedEvidenceHash: fixture.proposal.evidenceHash,
        actorId: "concurrent-reviewer",
      } as const;
      const outcomes = await Promise.allSettled([
        primary.rejectCompletionProposal(fixture.proposal.proposalId, {
          ...common,
          reason: "first concurrent reason",
        }),
        secondary.rejectCompletionProposal(fixture.proposal.proposalId, {
          ...common,
          reason: "second concurrent reason",
        }),
      ]);
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<
          ReturnType<RevisionStore["rejectCompletionProposal"]>
        >> => outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]!.value.changed).toBe(true);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({
        code: "CONFLICT",
        statusCode: 409,
      });
    } finally {
      secondary?.close();
      primary.close();
    }
  });

  it("freezes the exact Completion candidate set and AI ranking before Job success", async () => {
    const { store } = await createStore();
    try {
      const host = await createCompletionFixture(store, "skin_texel");
      await store.createCompletionProposal({
        jobId: host.jobId,
        proposal: host.proposal,
      });
      const database = new Database(store.databasePath);
      try {
        const sourceCandidateId = host.proposal.candidates[0]!.candidateId;
        expect(() => database.prepare(`
          INSERT INTO completion_candidate (
            id, proposal_id, representation, strategy, confidence, origin_mode,
            pixel_count, generated_pixel_count, candidate_json, candidate_hash,
            evidence_hash, document_storage_path, document_byte_size,
            document_sha256, texture_storage_path, texture_byte_size,
            texture_sha256, write_mask_storage_path, write_mask_byte_size,
            write_mask_sha256, generated_mask_storage_path,
            generated_mask_byte_size, generated_mask_sha256, created_at
          )
          SELECT ?, proposal_id, representation, strategy, confidence, origin_mode,
            pixel_count, generated_pixel_count,
            json_set(candidate_json, '$.candidateId', ?), candidate_hash,
            evidence_hash, document_storage_path || '-extra', document_byte_size,
            document_sha256, texture_storage_path || '-extra', texture_byte_size,
            texture_sha256, write_mask_storage_path || '-extra', write_mask_byte_size,
            write_mask_sha256, generated_mask_storage_path || '-extra',
            generated_mask_byte_size, generated_mask_sha256, created_at
          FROM completion_candidate WHERE id = ?
        `).run(
          "completioncandidate_extra",
          "completioncandidate_extra",
          sourceCandidateId,
        )).toThrow(/invalid completion candidate binding/u);
      } finally {
        database.close();
      }

      const ai = await createCompletionFixture(store, "skin_texel", "ai");
      expect(ai.proposal.candidates.length).toBeGreaterThan(1);
      const rankings = ai.proposal.candidates.map((candidate, index) => ({
        candidateId: candidate.candidateId,
        confidence: Math.max(0, 1 - index / ai.proposal.candidates.length),
        explanation: `Candidate-set guard ranking ${index + 1}`,
      }));
      const document = {
        schemaVersion: "1.0",
        jobId: ai.jobId,
        proposalId: ai.proposal.proposalId,
        proposalHash: ai.proposal.proposalHash,
        sourceRevisionId: ai.proposal.sourceRevisionId,
        sourceResultHash: ai.proposal.sourceResultHash,
        sourceSkinHash: ai.proposal.sourceSkinHash,
        rankings,
        recommendation: {
          status: "recommend",
          candidateId: rankings[0]!.candidateId,
          confidence: rankings[0]!.confidence,
          explanation: "The first candidate leads the guarded ranking",
        },
      } as const;
      await store.createCompletionProposal({
        jobId: ai.jobId,
        proposal: ai.proposal,
        ranking: {
          provider: "codex",
          model: "completion-ranking-model",
          reasoningEffort: "medium",
          document,
          rankingHash: sha256(canonicalCompletionJson(document)),
        },
      });

      const aiDatabase = new Database(store.databasePath);
      try {
        const rankingRow = aiDatabase.prepare(`
          SELECT ranking_json FROM completion_proposal_ranking
          WHERE proposal_id = ?
        `).get(ai.proposal.proposalId) as { readonly ranking_json: string };
        aiDatabase.exec("DROP TRIGGER completion_proposal_ranking_immutable_update");
        aiDatabase.prepare(`
          UPDATE completion_proposal_ranking
          SET ranking_json = json_set(
            ranking_json,
            '$.rankings[1].candidateId',
            json_extract(ranking_json, '$.rankings[0].candidateId')
          )
          WHERE proposal_id = ?
        `).run(ai.proposal.proposalId);
        expect(() => finishCompletionJob(
          store,
          ai.jobId,
          ai.proposal.proposalHash,
        )).toThrow(/invalid AI job kind shape/u);
        aiDatabase.prepare(`
          UPDATE completion_proposal_ranking SET ranking_json = ?
          WHERE proposal_id = ?
        `).run(rankingRow.ranking_json, ai.proposal.proposalId);

        const removedCandidateId = ai.proposal.candidates[0]!.candidateId;
        aiDatabase.exec(`
          CREATE TEMP TABLE removed_completion_candidate AS
          SELECT * FROM completion_candidate WHERE 0;
          DROP TRIGGER completion_candidate_immutable_delete;
        `);
        aiDatabase.prepare(`
          INSERT INTO removed_completion_candidate
          SELECT * FROM completion_candidate WHERE id = ?
        `).run(removedCandidateId);
        expect(aiDatabase.prepare(
          "DELETE FROM completion_candidate WHERE id = ?",
        ).run(removedCandidateId).changes).toBe(1);
        expect(() => aiDatabase.exec(`
          INSERT INTO completion_candidate
          SELECT * FROM removed_completion_candidate;
        `)).toThrow(/invalid completion candidate binding/u);
        expect(() => finishCompletionJob(
          store,
          ai.jobId,
          ai.proposal.proposalHash,
        )).toThrow(/invalid AI job kind shape/u);
      } finally {
        aiDatabase.close();
      }
    } finally {
      store.close();
    }
  });

  it("persists a bound AI ranking while keeping a non-recommended user decision authoritative", async () => {
    const { store } = await createStore();
    try {
      const fixture = await createCompletionFixture(store, "skin_texel", "ai");
      expect(fixture.proposal.candidates.length).toBeGreaterThan(1);
      const rankings = fixture.proposal.candidates.map((candidate, index) => ({
        candidateId: candidate.candidateId,
        confidence: Math.max(0, 1 - index / fixture.proposal.candidates.length),
        explanation: `Host-bound ranking ${index + 1}`,
      }));
      const document = {
        schemaVersion: "1.0",
        jobId: fixture.jobId,
        proposalId: fixture.proposal.proposalId,
        proposalHash: fixture.proposal.proposalHash,
        sourceRevisionId: fixture.proposal.sourceRevisionId,
        sourceResultHash: fixture.proposal.sourceResultHash,
        sourceSkinHash: fixture.proposal.sourceSkinHash,
        rankings,
        recommendation: {
          status: "recommend",
          candidateId: rankings[0]!.candidateId,
          confidence: rankings[0]!.confidence,
          explanation: "The first candidate has the strongest visible evidence",
        },
      } as const;
      const rankingHash = sha256(canonicalCompletionJson(document));
      const pending = await store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
        ranking: {
          provider: "codex",
          model: "completion-ranking-model",
          reasoningEffort: "medium",
          document,
          rankingHash,
        },
      });
      await expect(store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
        ranking: {
          provider: "codex",
          model: "completion-ranking-model",
          reasoningEffort: "medium",
          document,
          rankingHash,
        },
      })).resolves.toMatchObject({
        proposal: { id: fixture.proposal.proposalId },
        ranking: { rankingHash },
      });
      await expect(store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
        ranking: {
          provider: "codex",
          model: "completion-ranking-model",
          reasoningEffort: "medium",
          document: {
            ...document,
            recommendation: {
              ...document.recommendation,
              explanation: "A different replay payload",
            },
          },
          rankingHash,
        },
      })).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
      expect(pending.ranking).toMatchObject({
        provider: "codex",
        model: "completion-ranking-model",
        reasoningEffort: "medium",
        document,
        orderedCandidateIds: rankings.map((ranking) => ranking.candidateId),
        recommendation: document.recommendation,
        rankingHash,
      });
      finishCompletionJob(store, fixture.jobId, fixture.proposal.proposalHash);

      const selected = fixture.proposal.candidates.at(-1)!;
      expect(selected.candidateId).not.toBe(document.recommendation.candidateId);
      await expect(store.acceptCompletionCandidate(
        fixture.proposal.proposalId,
        {
          candidateId: selected.candidateId,
          expectedSourceResultHash: fixture.proposal.sourceResultHash,
          expectedProposalHash: fixture.proposal.proposalHash,
          expectedEvidenceHash: fixture.proposal.evidenceHash,
          expectedCandidateHash: selected.candidateHash,
          actorId: "ranking-reviewer",
        },
      )).resolves.toMatchObject({
        changed: true,
        detail: { decision: { candidateId: selected.candidateId } },
      });

      const database = new Database(store.databasePath);
      try {
        expect(() => database.prepare(`
          UPDATE completion_proposal_ranking
          SET ranking_json = ? WHERE proposal_id = ?
        `).run(canonicalCompletionJson({
          ...document,
          recommendation: {
            ...document.recommendation,
            explanation: "Tampered explanation",
          },
        }), fixture.proposal.proposalId)).toThrow(/immutable/u);
        database.exec("DROP TRIGGER completion_proposal_ranking_immutable_update");
        database.prepare(`
          UPDATE completion_proposal_ranking
          SET ranking_json = ? WHERE proposal_id = ?
        `).run(canonicalCompletionJson({
          ...document,
          recommendation: {
            ...document.recommendation,
            explanation: "Tampered explanation",
          },
        }), fixture.proposal.proposalId);
      } finally {
        database.close();
      }
      await expect(store.getCompletionProposalDetail(fixture.proposal.proposalId))
        .rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });

  it("detects Completion candidate file tampering and protects immutable rows", async () => {
    const { directory, store } = await createStore();
    try {
      const fixture = await createCompletionFixture(store, "skin_texel");
      const detail = await store.createCompletionProposal({
        jobId: fixture.jobId,
        proposal: fixture.proposal,
      });
      const database = new Database(store.databasePath);
      try {
        expect(() => database.prepare(`
          UPDATE completion_proposal SET proposal_hash = ? WHERE id = ?
        `).run(`sha256:${"0".repeat(64)}`, fixture.proposal.proposalId))
          .toThrow(/immutable/u);
      } finally {
        database.close();
      }
      await writeFile(
        join(directory, detail.candidates[0]!.texture.storagePath),
        "tampered candidate texture",
        "utf8",
      );
      await expect(store.getCompletionProposalDetail(fixture.proposal.proposalId))
        .rejects.toMatchObject({ code: "SNAPSHOT_CORRUPT", statusCode: 409 });
    } finally {
      store.close();
    }
  });
});

const TEST_CREATED_AT = "2026-08-11T01:00:00.000Z";

interface CompletionFixture {
  readonly jobId: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly sourceRevisionId: string;
  readonly targetComponentId: string;
  readonly occludingComponentId: string;
  readonly visibleTarget: SurfaceTexel;
  readonly proposal: CompletionProposal;
}

async function createPopulatedV15CompletionFixture(): Promise<{
  readonly directory: string;
  readonly proposal: CompletionProposal;
}> {
  const { directory, store } = await createStore();
  let fixture: CompletionFixture;
  try {
    fixture = await createCompletionFixture(store, "skin_texel");
    await store.createCompletionProposal({
      jobId: fixture.jobId,
      proposal: fixture.proposal,
    });
    finishCompletionJob(store, fixture.jobId, fixture.proposal.proposalHash);
  } finally {
    store.close();
  }

  const database = new Database(join(directory, "mcskinsplit.sqlite"));
  try {
    downgradePlayerCompletionWorkflowsToV15(database);
  } finally {
    database.close();
  }
  return { directory, proposal: fixture!.proposal };
}

function downgradePlayerCompletionWorkflowsToV15(
  database: Database.Database,
): void {
  const start = COMPLETION_PROPOSALS_V15_SQL.indexOf(
    "CREATE TRIGGER completion_candidate_insert_guard",
  );
  const end = COMPLETION_PROPOSALS_V15_SQL.indexOf(
    "CREATE TRIGGER completion_proposal_ranking_insert_guard",
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error("Unable to recover the v15 Completion candidate guard");
  }
  const v15CandidateGuard = COMPLETION_PROPOSALS_V15_SQL.slice(start, end);
  const downgrade = database.transaction(() => {
    database.exec(`
      DROP TRIGGER completion_candidate_edit_immutable_delete;
      DROP TRIGGER completion_candidate_edit_immutable_update;
      DROP TRIGGER completion_candidate_edit_insert_guard;
      DROP TRIGGER completion_candidate_insert_guard;
      DROP TABLE completion_candidate_edit;
    `);
    database.exec(v15CandidateGuard);
    database.prepare(
      "DELETE FROM schema_migration WHERE version = 16",
    ).run();
  });
  downgrade.immediate();
}

async function createCompletionFixture(
  store: RevisionStore,
  representation: "skin_texel" | "latent_component",
  rankingMode: "host_only" | "ai" = "host_only",
): Promise<CompletionFixture> {
  const targetComponentId = representation === "skin_texel"
    ? "outfit.completion.base"
    : "outfit.completion.outer";
  const occludingComponentId = "hair.completion.occluder";
  const image = createRgbaImage(64, 64);
  const visibleTarget = completionTexel(
    representation === "skin_texel"
      ? "torso.base.front"
      : "torso.outer.front",
    0,
    2,
  );
  const hidden = representation === "skin_texel"
    ? [
        completionTexel("torso.base.front", 1, 2),
        completionTexel("torso.base.front", 2, 2),
      ]
    : [completionTexel("torso.outer.back", 2, 2)];
  const occluders = representation === "skin_texel"
    ? [
        completionTexel("torso.outer.front", 1, 2),
        completionTexel("torso.outer.front", 2, 2),
      ]
    : hidden;
  setPixel(
    image,
    visibleTarget.atlasX,
    visibleTarget.atlasY,
    [31, 61, 91, 255],
  );
  for (const texel of occluders) {
    setPixel(image, texel.atlasX, texel.atlasY, [8, 18, 28, 255]);
  }
  const imported = await store.importProject({
    name: `Completion ${representation}`,
    skinPng: encodeSkinPng(image),
    armType: "slim",
  });
  const targetRevision = await store.applyManualOperation(imported.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: targetComponentId,
        displayName: "Completion target",
        category: "upper_clothing",
      },
      spans: pixelIdsToSpans(
        [visibleTarget.pixelId],
        getSkinLayout("slim"),
      ),
    },
  });
  const source = await store.applyManualOperation(targetRevision.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: occludingComponentId,
        displayName: "Completion occluder",
        category: "hair",
      },
      spans: pixelIdsToSpans(
        occluders.map((texel) => texel.pixelId),
        getSkinLayout("slim"),
      ),
    },
  });
  const snapshot = await store.verifyRevisionSnapshot(source.revision.id);
  const sourceImage = decodeSkinPng(snapshot.files["skin.png"].bytes);
  const semanticState = await store.readRevisionSemanticState(source.revision.id);
  const originDocument = JSON.parse(
    Buffer.from(snapshot.files["origin.json"]!.bytes).toString("utf8"),
  ) as PixelOriginDocument;
  const proposalId = `completionproposal_${representation}_${rankingMode}`;
  const proposal = generateCompletionProposalCandidates({
    proposalId,
    sourceRevisionId: source.revision.id,
    sourceResultHash: source.revision.resultHash,
    sourceSkinHash: snapshot.files["skin.png"].sha256,
    image: sourceImage,
    semanticState,
    originDocument,
    targetComponentId,
    occludingComponentIds: [occludingComponentId],
    representation,
    hashCanonical: sha256,
  });
  if (proposal.candidates.length === 0) {
    throw new Error(`Completion fixture ${representation} produced no candidates`);
  }
  const jobId = `aijob_completion_${representation}_${rankingMode}`;
  insertCompletionJob(store, {
    jobId,
    projectId: imported.project.id,
    sourceRevisionId: source.revision.id,
    targetComponentId,
    occludingComponentIds: [occludingComponentId],
    representation,
    rankingMode,
  });
  return {
    jobId,
    projectId: imported.project.id,
    branchId: imported.branch.id,
    sourceRevisionId: source.revision.id,
    targetComponentId,
    occludingComponentId,
    visibleTarget,
    proposal,
  };
}

function completionTexel(
  surface: SurfaceKey,
  localU: number,
  localV: number,
): SurfaceTexel {
  const texel = buildSurfaceTexels(
    createRgbaImage(64, 64),
    getSkinLayout("slim"),
  ).find(
    (candidate) =>
      candidate.surface === surface &&
      candidate.localU === localU &&
      candidate.localV === localV,
  );
  if (!texel) throw new Error(`Missing Completion texel ${surface}`);
  return texel;
}

function insertCompletionJob(
  store: RevisionStore,
  input: {
    readonly jobId: string;
    readonly projectId: string;
    readonly sourceRevisionId: string;
    readonly targetComponentId: string;
    readonly occludingComponentIds: readonly string[];
    readonly representation: "skin_texel" | "latent_component";
    readonly rankingMode: "host_only" | "ai";
  },
): void {
  const database = new Database(store.databasePath);
  try {
    const provider = input.rankingMode === "ai" ? "codex" : "host";
    const model = input.rankingMode === "ai"
      ? "completion-ranking-model"
      : "completion-candidates-v1";
    database.prepare(`
      INSERT INTO ai_job (
        id, job_kind, project_id, input_revision_id, result_revision_id,
        retry_of_job_id, status, provider, model, skill_name, skill_version,
        prompt_version, input_hash, output_hash, options_json,
        review_items_json, proposal_summary, cancel_requested, created_at,
        started_at, finished_at, error_json, composition_id,
        advisory_result_json
      ) VALUES (
        ?, 'completion_proposal', ?, ?, NULL, NULL, 'validating',
        ?, ?, 'completion-candidates', '1.0',
        'completion-candidates-v1', NULL, NULL, ?, '[]', NULL, 0, ?, ?,
        NULL, NULL, NULL, NULL
      )
    `).run(
      input.jobId,
      input.projectId,
      input.sourceRevisionId,
      provider,
      model,
      JSON.stringify({
        mode: "completion_proposal",
        provider,
        model,
        rankingMode: input.rankingMode,
        ...(input.rankingMode === "ai" ? { reasoningEffort: "medium" } : {}),
        targetComponentId: input.targetComponentId,
        occludingComponentIds: input.occludingComponentIds,
        representation: input.representation,
      }),
      TEST_CREATED_AT,
      TEST_CREATED_AT,
    );
  } finally {
    database.close();
  }
}

function finishCompletionJob(
  store: RevisionStore,
  jobId: string,
  proposalHash: string,
): void {
  const database = new Database(store.databasePath);
  try {
    database.prepare(`
      UPDATE ai_job
      SET status = 'succeeded', output_hash = ?, finished_at = ?
      WHERE id = ?
    `).run(proposalHash, TEST_CREATED_AT, jobId);
  } finally {
    database.close();
  }
}

interface MutableCompletionAssignment {
  targetPixelId: number;
  originMode: string;
  manualOperationId?: string;
  rgba?: number[];
  manualActor?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MutableCompletionCandidateDocument {
  candidateId: string;
  assignments: MutableCompletionAssignment[];
  readonly [key: string]: unknown;
}

function insertTamperedDerivedCompletionCandidate(
  database: Database.Database,
  sourceCandidateId: string,
  suffix: string,
  mutate: (document: MutableCompletionCandidateDocument) => void,
  options: {
    readonly edits?: readonly unknown[];
    readonly hashCharacter?: string;
  } = {},
): void {
  const candidate = database.prepare(`
    SELECT candidate_json FROM completion_candidate WHERE id = ?
  `).get(sourceCandidateId) as { readonly candidate_json: string };
  const edit = database.prepare(`
    SELECT proposal_id, base_candidate_id,
           expected_source_result_hash, expected_proposal_hash,
           expected_evidence_hash, expected_candidate_hash,
           actor_type, actor_id, edits_json, created_at
    FROM completion_candidate_edit WHERE candidate_id = ?
  `).get(sourceCandidateId) as {
    readonly proposal_id: string;
    readonly base_candidate_id: string;
    readonly expected_source_result_hash: string;
    readonly expected_proposal_hash: string;
    readonly expected_evidence_hash: string;
    readonly expected_candidate_hash: string;
    readonly actor_type: "user";
    readonly actor_id: string | null;
    readonly edits_json: string;
    readonly created_at: string;
  };
  const document = JSON.parse(
    candidate.candidate_json,
  ) as MutableCompletionCandidateDocument;
  const candidateId = `completioncandidate_tampered_${suffix}`;
  const operationId = `completionedit_tampered_${suffix}`;
  const hashCharacter = options.hashCharacter ??
    (suffix === "extra" ? "a" : suffix === "missing" ? "b" : "c");
  const editHash = `sha256:${hashCharacter.repeat(64)}`;
  document.candidateId = candidateId;
  for (const assignment of document.assignments) {
    if (assignment.originMode === "manual_authored") {
      assignment.manualOperationId = operationId;
    }
  }
  mutate(document);

  const insert = database.transaction(() => {
    database.prepare(`
      INSERT INTO completion_candidate_edit (
        candidate_id, proposal_id, base_candidate_id,
        expected_source_result_hash, expected_proposal_hash,
        expected_evidence_hash, expected_candidate_hash,
        actor_type, actor_id, operation_id, edits_json, edit_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      edit.proposal_id,
      edit.base_candidate_id,
      edit.expected_source_result_hash,
      edit.expected_proposal_hash,
      edit.expected_evidence_hash,
      edit.expected_candidate_hash,
      edit.actor_type,
      edit.actor_id,
      operationId,
      options.edits === undefined
        ? edit.edits_json
        : JSON.stringify(options.edits),
      editHash,
      edit.created_at,
    );
    database.prepare(`
      INSERT INTO completion_candidate (
        id, proposal_id, representation, strategy, confidence, origin_mode,
        pixel_count, generated_pixel_count, candidate_json, candidate_hash,
        evidence_hash, document_storage_path, document_byte_size,
        document_sha256, texture_storage_path, texture_byte_size,
        texture_sha256, write_mask_storage_path, write_mask_byte_size,
        write_mask_sha256, generated_mask_storage_path,
        generated_mask_byte_size, generated_mask_sha256, created_at
      )
      SELECT ?, proposal_id, representation, strategy, confidence, origin_mode,
        pixel_count, generated_pixel_count, ?, candidate_hash,
        evidence_hash, document_storage_path || ?, document_byte_size,
        document_sha256, texture_storage_path || ?, texture_byte_size,
        texture_sha256, write_mask_storage_path || ?, write_mask_byte_size,
        write_mask_sha256, generated_mask_storage_path || ?,
        generated_mask_byte_size, generated_mask_sha256, created_at
      FROM completion_candidate WHERE id = ?
    `).run(
      candidateId,
      JSON.stringify(document),
      `-${suffix}`,
      `-${suffix}`,
      `-${suffix}`,
      `-${suffix}`,
      sourceCandidateId,
    );
  });
  insert.immediate();
}

interface SemanticFollowupSuggestionFixture {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly targetComponentId: string;
  readonly sourceComponentIds: readonly string[];
  readonly candidateRegionIds: readonly string[];
  readonly spans: readonly {
    readonly surface: string;
    readonly y: number;
    readonly x0: number;
    readonly x1: number;
  }[];
  readonly pixelCount: number;
  readonly confidence: number;
  readonly reason: string;
}

function semanticFollowupAssessment(
  hashCharacter: string,
  input: {
    readonly suggestions: readonly SemanticFollowupSuggestionFixture[];
    readonly notices: readonly { readonly kind: string; readonly message: string }[];
  },
) {
  return {
    schemaVersion: "1.0",
    algorithmVersion: "semantic-followup-test-v1",
    evidenceHash: `sha256:${hashCharacter.repeat(64)}`,
    suggestions: input.suggestions,
    notices: input.notices,
  } as const;
}

function insertSemanticFollowupFixture<
  TAssessment extends { readonly evidenceHash: string },
>(
  database: Database.Database,
  input: {
    readonly jobId: string;
    readonly resultRevisionId: string;
    readonly status:
      | "no_repair"
      | "awaiting_review"
      | "applied"
      | "dismissed"
      | "assessment_failed";
    readonly assessment: TAssessment;
    readonly appliedRevisionId?: string | null;
  },
): void {
  database.prepare(`
    INSERT INTO semantic_analysis_followup (
      job_id, result_revision_id, status, assessment_json,
      evidence_hash, applied_revision_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.jobId,
    input.resultRevisionId,
    input.status,
    JSON.stringify(input.assessment),
    input.assessment.evidenceHash,
    input.appliedRevisionId ?? null,
    TEST_CREATED_AT,
    TEST_CREATED_AT,
  );
}

function insertValidatingSemanticJob(
  store: RevisionStore,
  input: {
    readonly jobId: string;
    readonly projectId: string;
    readonly inputRevisionId: string;
    readonly resultRevisionId: string;
  },
): void {
  const database = new Database(store.databasePath);
  try {
    const runId = store.getRevision(input.resultRevisionId).aiRunId;
    if (!runId) throw new Error("semantic result fixture requires aiRunId");
    database.prepare(`
      INSERT INTO ai_job (
        id, job_kind, project_id, input_revision_id, result_revision_id,
        retry_of_job_id, status, provider, model, skill_name, skill_version,
        prompt_version, options_json, review_items_json, proposal_summary,
        cancel_requested, created_at, started_at, finished_at
      ) VALUES (?, 'semantic_analysis', ?, ?, NULL, NULL, 'validating', ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?, NULL)
    `).run(
      input.jobId,
      input.projectId,
      input.inputRevisionId,
      "catalog-provider",
      "catalog-model",
      "mc-skin-segmenter",
      "1.2.0",
      "catalog-test-v1",
      JSON.stringify({
        mode: "full",
        provider: "catalog-provider",
        model: "catalog-model",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: true,
      }),
      "Followup validating fixture",
      TEST_CREATED_AT,
      TEST_CREATED_AT,
    );
    database.prepare(`
      INSERT INTO ai_run (
        id, job_id, provider, model, thread_id, attempt, status,
        workspace_path, usage_json, started_at, finished_at, error_json
      ) VALUES (?, ?, ?, ?, NULL, 1, 'running', ?, NULL, ?, NULL, NULL)
    `).run(
      runId,
      input.jobId,
      "catalog-provider",
      "catalog-model",
      `data/ai-runs/${runId}`,
      TEST_CREATED_AT,
    );
  } finally {
    database.close();
  }
}

function downgradeSemanticFollowupToEarlyV11(
  database: Database.Database,
): void {
  const downgrade = database.transaction(() => {
    database.exec(`
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
        RENAME TO semantic_analysis_followup_v12;
    `);
    database.exec(EARLY_V11_SEMANTIC_FOLLOWUP_SQL);
    database.exec(`
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
      FROM semantic_analysis_followup_v12;

      DROP TABLE semantic_analysis_followup_v12;
    `);
  });
  downgrade.immediate();
}

function upgradeSemanticFollowupFromEarlyV11(
  database: Database.Database,
): void {
  const upgrade = database.transaction(() => {
    database.exec(SEMANTIC_FOLLOWUP_HARDENING_SQL);
  });
  upgrade.immediate();
}

function insertSucceededSemanticJob(
  store: RevisionStore,
  input: {
    readonly jobId: string;
    readonly projectId: string;
    readonly inputRevisionId: string;
    readonly resultRevisionId: string;
  },
): void {
  const database = new Database(store.databasePath);
  try {
    const runId = store.getRevision(input.resultRevisionId).aiRunId;
    if (!runId) throw new Error("semantic result fixture requires aiRunId");
    database.prepare(`
      INSERT INTO ai_job (
        id, job_kind, project_id, input_revision_id, result_revision_id,
        retry_of_job_id, status, provider, model, skill_name, skill_version,
        prompt_version, options_json, review_items_json, proposal_summary,
        cancel_requested, created_at, started_at, finished_at
      ) VALUES (?, 'semantic_analysis', ?, ?, ?, NULL, 'succeeded', ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?, ?)
    `).run(
      input.jobId,
      input.projectId,
      input.inputRevisionId,
      input.resultRevisionId,
      "catalog-provider",
      "catalog-model",
      "mc-skin-segmenter",
      "1.2.0",
      "catalog-test-v1",
      JSON.stringify({
        mode: "full",
        provider: "catalog-provider",
        model: "catalog-model",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: true,
      }),
      "Followup fixture",
      TEST_CREATED_AT,
      TEST_CREATED_AT,
      TEST_CREATED_AT,
    );
    database.prepare(`
      INSERT INTO ai_run (
        id, job_id, provider, model, thread_id, attempt, status,
        workspace_path, usage_json, started_at, finished_at, error_json
      ) VALUES (?, ?, ?, ?, NULL, 1, 'succeeded', ?, NULL, ?, ?, NULL)
    `).run(
      runId,
      input.jobId,
      "catalog-provider",
      "catalog-model",
      `data/ai-runs/${runId}`,
      TEST_CREATED_AT,
      TEST_CREATED_AT,
    );
  } finally {
    database.close();
  }
}

interface RealSkinManifest {
  readonly skins: readonly { readonly id: string; readonly file: string }[];
  readonly mix: {
    readonly file: string;
    readonly recipe: Readonly<Record<BodyPart, string>>;
  };
}

async function exportBodyPart(
  store: RevisionStore,
  bodyPart: BodyPart,
  fileName: string,
  skinPng: Uint8Array,
) {
  const imported = await store.importProject({
    name: `${bodyPart} source`,
    fileName,
    skinPng,
  });
  const image = decodeSkinPng(skinPng);
  const layout = getSkinLayout("slim");
  const pixelIds: number[] = [];
  for (const key of layout.surfaceOrder.filter((surface) =>
    surface.startsWith(`${bodyPart}.`),
  )) {
    const rect = layout.surfaces[key].atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const pixelId = y * 64 + x;
        if (image.data[pixelId * 4 + 3] !== 0) pixelIds.push(pixelId);
      }
    }
  }
  const componentId = `fixture.${bodyPart.toLowerCase()}`;
  const segmented = await store.applyManualOperation(imported.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: componentId,
        displayName: `${bodyPart} / ${fileName}`,
        category: categoryForBodyPart(bodyPart),
      },
      spans: pixelIdsToSpans(pixelIds, layout),
    },
  });
  return await store.exportPart(segmented.revision.id, componentId, {
    name: `${bodyPart} / ${fileName}`,
  });
}

async function exportHeadPixelPart(
  store: RevisionStore,
  rgba: readonly [number, number, number, number] = [32, 48, 64, 255],
) {
  const image = createRgbaImage(64, 64);
  image.data.set(rgba, (8 * 64 + 8) * 4);
  const imported = await store.importProject({
    name: `Repair fixture ${rgba.join("-")}`,
    skinPng: encodeSkinPng(image),
    armType: "slim",
  });
  const componentId = "hair.repair";
  const segmented = await store.applyManualOperation(imported.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: componentId,
        displayName: "Repair hair",
        category: "hair",
      },
      spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
    },
  });
  return store.exportPart(segmented.revision.id, componentId);
}

async function createPopulatedV13Fixture(): Promise<{
  readonly directory: string;
  readonly revisionId: string;
  readonly partV1Id: string;
  readonly partV1_1Id: string;
  readonly partEditProjectId: string;
  readonly partEditRevisionId: string;
  readonly pixelId: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mcskinsplit-v13-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "mcskinsplit.sqlite");
  const database = new Database(databasePath);
  const createdAt = "2026-08-10T00:00:00.000Z";
  const projectId = "project_legacy_v13";
  const branchId = "branch_legacy_v13";
  const revisionId = "revision_legacy_v13";
  const partV1Id = "part_legacy_v1";
  const partV1_1Id = "part_legacy_v11";
  const partEditProjectId = "part_edit_legacy_v13";
  const partEditRevisionId = "part_edit_revision_legacy_v13";
  const pixelId = 8 * 64 + 8;

  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const migrationDirectory = fileURLToPath(
      new URL("../src/migrations/", import.meta.url),
    );
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((fileName) => /^0(?:0[1-9]|1[0-3])_.*\.sql$/u.test(fileName))
      .sort();
    expect(migrationFiles).toHaveLength(13);
    for (const [index, fileName] of migrationFiles.entries()) {
      const version = index + 1;
      const migrate = database.transaction(() => {
        database.exec(readFileSync(join(migrationDirectory, fileName), "utf8"));
        database.prepare(`
          INSERT INTO schema_migration (version, name, applied_at)
          VALUES (?, ?, ?)
        `).run(version, fileName, createdAt);
      });
      migrate.immediate();
    }

    const image = createRgbaImage(64, 64);
    image.data.set([32, 48, 64, 255], pixelId * 4);
    const skinPng = encodeSkinPng(image);
    const maskImage = createRgbaImage(64, 64);
    maskImage.data.set([255, 255, 255, 255], pixelId * 4);
    const maskPng = encodeSkinPng(maskImage);
    const segmentation = {
      schemaVersion: "1.0",
      revisionId,
      source: {
        width: 64,
        height: 64,
        armType: "slim",
        coordinateOrigin: "top-left",
        sourceHash: sha256(skinPng),
      },
      components: [],
      unknown: {
        maskFile: "components/unknown.mask.png",
        pixelCount: 1,
      },
    } as const;
    const resultHash = sha256(
      canonicalJson({
        skinHash: sha256(skinPng),
        segmentation: { ...segmentation, revisionId: "revision_state" },
      }),
    );
    const operation = {
      schemaVersion: "1.0",
      type: "import",
      inputRevisionId: null,
      outputRevisionId: revisionId,
      actor: { type: "user" },
      createdAt,
      summary: "Legacy v13 import",
      affectedComponents: [],
      affectedSpans: [],
      beforeHash: null,
      afterHash: resultHash,
      metadata: { armType: "slim" },
    } as const;
    const snapshotFiles: Readonly<Record<string, Uint8Array>> = {
      "skin.png": skinPng,
      "segmentation.json": Buffer.from(canonicalJson(segmentation), "utf8"),
      "operation.json": Buffer.from(canonicalJson(operation), "utf8"),
      "components/unknown.mask.png": maskPng,
    };
    const revisionDirectory = join(
      directory,
      "projects",
      projectId,
      "revisions",
      revisionId,
    );
    for (const [fileName, bytes] of Object.entries(snapshotFiles)) {
      const path = join(revisionDirectory, fileName);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    await writeFile(
      join(revisionDirectory, "checksum.json"),
      canonicalJson({
        schemaVersion: "1.0",
        revisionId,
        files: Object.fromEntries(
          Object.entries(snapshotFiles).map(([fileName, bytes]) => [
            fileName,
            sha256(bytes),
          ]),
        ),
      }),
      "utf8",
    );

    const partManifests = [
      {
        partId: partV1Id,
        componentId: "hair.legacy",
        manifest: {
          schemaVersion: "1.0",
          id: partV1Id,
          name: "Legacy Part 1.0",
          category: "hair",
          source: {
            projectId,
            revisionId,
            componentInstanceId: "hair.legacy",
          },
          compatibility: { resolution: "64x64", armTypes: ["slim"] },
          placement: {
            preferredLayers: ["base"],
            surfaces: ["head.base.front"],
          },
          relations: { softConflicts: [], hardConflicts: [] },
          palette: { dominant: "#203040" },
          maskMode: "write-colored-pixels-only",
          createdAt,
        },
      },
      {
        partId: partV1_1Id,
        componentId: "hair.legacy_repair",
        manifest: {
          schemaVersion: "1.1",
          id: partV1_1Id,
          name: "Legacy Part 1.1",
          category: "hair",
          source: {
            projectId,
            revisionId,
            componentInstanceId: "hair.legacy_repair",
          },
          compatibility: { resolution: "64x64", armTypes: ["slim"] },
          placement: {
            preferredLayers: ["base"],
            surfaces: ["head.base.front"],
          },
          relations: { softConflicts: [], hardConflicts: [] },
          palette: { dominant: "#203040" },
          maskMode: "write-colored-pixels-only",
          derivation: {
            kind: "part_repair",
            basePartId: partV1Id,
            partEditProjectId: "part_edit_legacy_v11",
            partEditRevisionId: "part_edit_revision_legacy_v11",
            containsGeneratedPixels: false,
          },
          createdAt,
        },
      },
    ] as const;
    const partFilesById = new Map<string, Readonly<Record<string, Uint8Array>>>();
    for (const item of partManifests) {
      const files: Readonly<Record<string, Uint8Array>> = {
        "texture.png": skinPng,
        "write-mask.png": maskPng,
        "manifest.json": Buffer.from(canonicalJson(item.manifest), "utf8"),
        "preview.png": skinPng,
        "source.json": Buffer.from(canonicalJson({ schemaVersion: "1.0" }), "utf8"),
      };
      partFilesById.set(item.partId, files);
      for (const [fileName, bytes] of Object.entries(files)) {
        const path = join(directory, "parts", item.partId, fileName);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
    }
    const partEditOperation = { type: "init", basePartId: partV1Id } as const;
    const partEditProvenance = {
      source: "manual",
      basePartId: partV1Id,
      authoredOperations: 0,
      containsGeneratedPixels: false,
    } as const;
    const partEditFiles: Readonly<Record<string, Uint8Array>> = {
      "texture.png": skinPng,
      "write-mask.png": maskPng,
      "revision.json": Buffer.from(canonicalJson({
        schemaVersion: "1.0",
        id: partEditRevisionId,
        projectId: partEditProjectId,
        parentRevisionId: null,
        sequence: 1,
        operation: partEditOperation,
        summary: "Legacy v13 PartEdit init",
        actorId: null,
        changedPixelCount: 0,
        authoredProvenance: partEditProvenance,
        createdAt,
      }), "utf8"),
    };
    for (const [fileName, bytes] of Object.entries(partEditFiles)) {
      const path = join(
        directory,
        "part-edits",
        partEditProjectId,
        "revisions",
        partEditRevisionId,
        fileName,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    const populate = database.transaction(() => {
      database.prepare(`
        INSERT INTO skin_project (
          id, name, created_at, updated_at, default_branch_id,
          head_revision_id, settings_json
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        projectId,
        "Legacy v13 fixture",
        createdAt,
        createdAt,
        JSON.stringify({ armType: "slim", coordinateOrigin: "top-left" }),
      );
      database.prepare(`
        INSERT INTO skin_branch (
          id, project_id, name, base_revision_id, head_revision_id, created_at
        ) VALUES (?, ?, 'main', NULL, NULL, ?)
      `).run(branchId, projectId, createdAt);
      const insertSkinAsset = database.prepare(`
        INSERT INTO skin_asset (
          id, project_id, revision_id, asset_type, storage_path,
          mime_type, byte_size, sha256, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `);
      const snapshotAssetRows = [
        ["asset_legacy_skin", "revision_skin", "skin.png", "image/png"],
        ["asset_legacy_segmentation", "segmentation_json", "segmentation.json", "application/json"],
        ["asset_legacy_operation", "operation_json", "operation.json", "application/json"],
        ["asset_legacy_unknown", "component_mask", "components/unknown.mask.png", "image/png"],
      ] as const;
      for (const [assetId, assetType, fileName, mimeType] of snapshotAssetRows) {
        const bytes = snapshotFiles[fileName]!;
        insertSkinAsset.run(
          assetId,
          projectId,
          assetType,
          `projects/${projectId}/revisions/${revisionId}/${fileName}`,
          mimeType,
          bytes.byteLength,
          sha256(bytes),
          createdAt,
        );
      }
      database.prepare(`
        INSERT INTO skin_revision (
          id, project_id, branch_id, parent_revision_id, sequence,
          operation_type, actor_type, actor_id, ai_run_id, summary,
          skin_asset_id, segmentation_asset_id, operation_asset_id,
          source_hash, result_hash, created_at, metadata_json
        ) VALUES (?, ?, ?, NULL, 1, 'import', 'user', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        projectId,
        branchId,
        operation.summary,
        "asset_legacy_skin",
        "asset_legacy_segmentation",
        "asset_legacy_operation",
        sha256(skinPng),
        resultHash,
        createdAt,
        JSON.stringify({ armType: "slim" }),
      );
      database.prepare(
        "UPDATE skin_asset SET revision_id = ? WHERE project_id = ?",
      ).run(revisionId, projectId);
      database.prepare(`
        INSERT INTO skin_operation (
          id, project_id, revision_id, operation_type,
          operation_asset_id, summary, created_at
        ) VALUES (?, ?, ?, 'import', ?, ?, ?)
      `).run(
        "operation_legacy_v13",
        projectId,
        revisionId,
        "asset_legacy_operation",
        operation.summary,
        createdAt,
      );
      database.prepare(`
        UPDATE skin_project
        SET default_branch_id = ?, head_revision_id = ? WHERE id = ?
      `).run(branchId, revisionId, projectId);
      database.prepare(
        "UPDATE skin_branch SET head_revision_id = ? WHERE id = ?",
      ).run(revisionId, branchId);

      const insertPartFile = database.prepare(`
        INSERT INTO part_file_asset (
          id, part_id, file_role, storage_path, mime_type,
          byte_size, sha256, created_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
      `);
      for (const [partIndex, item] of partManifests.entries()) {
        const files = partFilesById.get(item.partId)!;
        const fileIds: Record<string, string> = {};
        const roles = {
          "texture.png": "texture",
          "write-mask.png": "write_mask",
          "manifest.json": "manifest",
          "preview.png": "preview",
          "source.json": "source",
        } as const;
        for (const [fileName, role] of Object.entries(roles)) {
          const bytes = files[fileName]!;
          const fileId = `asset_legacy_part_${partIndex}_${role}`;
          fileIds[fileName] = fileId;
          insertPartFile.run(
            fileId,
            role,
            `parts/${item.partId}/${fileName}`,
            fileName.endsWith(".png") ? "image/png" : "application/json",
            bytes.byteLength,
            sha256(bytes),
            createdAt,
          );
        }
        database.prepare(`
          INSERT INTO part_asset (
            id, source_project_id, source_revision_id, source_component_id,
            name, category, subtype, arm_type, texture_asset_id, mask_asset_id,
            manifest_asset_id, preview_asset_id, source_asset_id, created_at,
            manifest_json, metadata_json
          ) VALUES (?, ?, ?, ?, ?, 'hair', NULL, 'slim', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.partId,
          projectId,
          revisionId,
          item.componentId,
          item.manifest.name,
          fileIds["texture.png"],
          fileIds["write-mask.png"],
          fileIds["manifest.json"],
          fileIds["preview.png"],
          fileIds["source.json"],
          createdAt,
          canonicalJson(item.manifest).trim(),
          JSON.stringify({ maskMode: "write-colored-pixels-only" }),
        );
        database.prepare(
          "UPDATE part_file_asset SET part_id = ? WHERE storage_path LIKE ?",
        ).run(item.partId, `parts/${item.partId}/%`);
      }
      database.prepare(`
        INSERT INTO part_edit_project (
          id, base_part_id, name, status, head_revision_id, result_part_id,
          created_at, updated_at, committed_at
        ) VALUES (?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)
      `).run(
        partEditProjectId,
        partV1Id,
        "Legacy v13 PartEdit",
        createdAt,
        createdAt,
      );
      database.prepare(`
        INSERT INTO part_edit_revision (
          id, project_id, parent_revision_id, sequence, operation_type,
          operation_json, summary, actor_id,
          texture_storage_path, texture_byte_size, texture_sha256,
          mask_storage_path, mask_byte_size, mask_sha256,
          revision_storage_path, revision_byte_size, revision_sha256,
          changed_pixel_count, authored_provenance_json, created_at
        ) VALUES (
          ?, ?, NULL, 1, 'init', ?, ?, NULL,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
        )
      `).run(
        partEditRevisionId,
        partEditProjectId,
        canonicalJson(partEditOperation).trim(),
        "Legacy v13 PartEdit init",
        `part-edits/${partEditProjectId}/revisions/${partEditRevisionId}/texture.png`,
        skinPng.byteLength,
        sha256(skinPng),
        `part-edits/${partEditProjectId}/revisions/${partEditRevisionId}/write-mask.png`,
        maskPng.byteLength,
        sha256(maskPng),
        `part-edits/${partEditProjectId}/revisions/${partEditRevisionId}/revision.json`,
        partEditFiles["revision.json"]!.byteLength,
        sha256(partEditFiles["revision.json"]!),
        canonicalJson(partEditProvenance).trim(),
        createdAt,
      );
      database.prepare(`
        UPDATE part_edit_project SET head_revision_id = ? WHERE id = ?
      `).run(partEditRevisionId, partEditProjectId);
    });
    populate.immediate();
    expect(database.pragma("foreign_key_check")).toEqual([]);
  } finally {
    database.close();
  }

  return {
    directory,
    revisionId,
    partV1Id,
    partV1_1Id,
    partEditProjectId,
    partEditRevisionId,
    pixelId,
  };
}

function categoryForBodyPart(bodyPart: BodyPart) {
  switch (bodyPart) {
    case "head":
      return "head_accessory" as const;
    case "torso":
      return "one_piece_clothing" as const;
    case "leftArm":
    case "rightArm":
      return "sleeve" as const;
    case "leftLeg":
    case "rightLeg":
      return "legwear" as const;
  }
}

async function createStore(): Promise<{
  readonly directory: string;
  readonly store: RevisionStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mcskinsplit-revision-"));
  temporaryDirectories.push(directory);
  let idCounter = 0;
  let timeCounter = 0;
  const store = new RevisionStore({
    dataDirectory: directory,
    createId: (kind: RevisionIdKind) =>
      `${kind}_${String(++idCounter).padStart(4, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 11, 0, 0, timeCounter++)),
  });
  return { directory, store };
}

async function importRealSkin(store: RevisionStore) {
  return store.importProject({
    name: "Actual Alex fixture",
    fileName: "ab87de696cfca859.png",
    skinPng: await readFile(REAL_SKIN_PATH),
  });
}

async function readSnapshotFiles(
  directory: string,
): Promise<Readonly<Record<string, Uint8Array>>> {
  const fileNames = await listFiles(directory);
  return Object.fromEntries(
    await Promise.all(
      fileNames.map(async (fileName) => [
        fileName,
        Uint8Array.from(await readFile(join(directory, fileName))),
      ]),
    ),
  );
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}
