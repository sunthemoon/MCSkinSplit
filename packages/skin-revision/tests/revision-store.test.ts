import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  decodeSkinPng,
  createRgbaImage,
  encodeSkinPng,
  getSkinLayout,
  getPixel,
  maskToPixelIds,
  pixelIdsToSpans,
  rgbaImageToMask,
  type BodyPart,
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
        "segmentation.json",
        "skin.png",
      ]);

      const snapshot = await store.verifyRevisionSnapshot(result.revision.id);
      expect(snapshot.checksum.revisionId).toBe(result.revision.id);
      expect(Object.keys(snapshot.checksum.files).sort()).toEqual([
        "components/unknown.mask.png",
        "operation.json",
        "segmentation.json",
        "skin.png",
      ]);
      expect(store.getRevisionAssets(result.revision.id)).toHaveLength(4);

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
        schemaVersion: "1.1",
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
          schemaVersion: "1.1",
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

  it("detects database metadata that diverges from immutable repair JSON", async () => {
    const { directory, store } = await createStore();

    try {
      const part = await exportHeadPixelPart(store);
      const created = await store.createPartEditProject({ basePartId: part.id });
      store.close();
      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
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
      expect(committed.part.manifest.schemaVersion).toBe("1.1");
      store.close();

      const database = new Database(join(directory, "mcskinsplit.sqlite"));
      try {
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
      expect(store.getRevisionAssets(edited.revision.id)).toHaveLength(5);
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
        "manifest.json",
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
          .toEqual({ version: 10 });
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
          containsGeneratedPixels: true,
          restoration: {
            candidateIds: [manual.id],
            sourceRevisionIds: [],
            sourceComponentIds: [],
          },
        });
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
});

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
