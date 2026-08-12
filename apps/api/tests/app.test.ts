import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSkinPng, getPixel } from "@mc-skin-split/skin-core";
import type {
  AnalysisProposal,
  ProviderAnalysisInput,
  ProviderAnalysisResult,
  SkinSemanticAiProvider,
} from "@mc-skin-split/ai-provider";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/app";

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

const resources: Array<{
  readonly app: FastifyInstance;
  readonly directory: string;
}> = [];

afterEach(async () => {
  const createdResources = resources.splice(0);
  await Promise.all(createdResources.map(({ app }) => app.close()));
  await Promise.all(
    createdResources.map(({ directory }) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("revision API", () => {
  it("creates an empty project with a Slim default", async () => {
    const { app } = await createApi();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "API project" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      project: {
        name: "API project",
        headRevisionId: null,
        settings: { armType: "slim", coordinateOrigin: "top-left" },
      },
      branch: { name: "main", headRevisionId: null },
    });

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ projects: unknown[] }>().projects).toHaveLength(1);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "", extra: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("imports, reads, reverts, branches, and diffs a real skin", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "History API");
    const sourceSkin = await readFile(REAL_SKIN_PATH);
    const imported = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/import?fileName=actual.png`,
      headers: { "content-type": "image/png" },
      payload: sourceSkin,
    });

    expect(imported.statusCode).toBe(201);
    const importResult = imported.json<ImportResponse>();
    expect(importResult).toMatchObject({
      projectId: project.projectId,
      branchId: project.branchId,
      armType: "slim",
      warnings: [],
    });

    const revisionDetail = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}`,
    });
    expect(revisionDetail.statusCode).toBe(200);
    expect(revisionDetail.json()).toMatchObject({
      revision: {
        id: importResult.revisionId,
        sequence: 1,
        operationType: "import",
      },
      assets: [{}, {}, {}, {}],
    });

    const skin = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}/skin.png`,
    });
    expect(skin.statusCode).toBe(200);
    expect(skin.headers["content-type"]).toContain("image/png");
    expect(skin.headers["cache-control"]).toContain("immutable");
    expect(decodeSkinPng(skin.rawPayload)).toEqual(decodeSkinPng(sourceSkin));

    const segmentation = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}/segmentation`,
    });
    expect(segmentation.statusCode).toBe(200);
    expect(segmentation.json()).toMatchObject({
      segmentation: {
        revisionId: importResult.revisionId,
        source: { armType: "slim", width: 64, height: 64 },
      },
    });

    const branch = await app.inject({
      method: "POST",
      url: `/api/revisions/${importResult.revisionId}/branch`,
      payload: { name: "api-experiment" },
    });
    expect(branch.statusCode).toBe(201);
    const branchResult = branch.json<MutationResponse>();
    expect(branchResult.revision).toMatchObject({
      parentRevisionId: importResult.revisionId,
      operationType: "branch",
      sequence: 1,
    });

    const projectAfterBranch = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}`,
    });
    expect(projectAfterBranch.json()).toMatchObject({
      project: { headRevisionId: importResult.revisionId },
    });

    const reverted = await app.inject({
      method: "POST",
      url: `/api/revisions/${importResult.revisionId}/revert`,
      payload: {},
    });
    expect(reverted.statusCode).toBe(201);
    const revertResult = reverted.json<MutationResponse>();
    expect(revertResult.revision).toMatchObject({
      parentRevisionId: importResult.revisionId,
      operationType: "revert",
      sequence: 2,
    });

    const revisions = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}/revisions`,
    });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json<{ revisions: unknown[] }>().revisions).toHaveLength(3);

    const branches = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}/branches`,
    });
    expect(branches.statusCode).toBe(200);
    expect(branches.json<{ branches: unknown[] }>().branches).toHaveLength(2);

    const diff = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}/diff/${branchResult.revision.id}`,
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({
      diff: { changedPixelCount: 0, changedPixelIds: [], boundingBox: null },
    });
  });

  it("exposes the project-scoped branch endpoint", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "Project branch endpoint");
    const imported = await importSkin(app, project.projectId);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/branches`,
      payload: {
        revisionId: imported.revisionId,
        name: "project-route-branch",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      branch: {
        name: "project-route-branch",
        baseRevisionId: imported.revisionId,
      },
    });
  });

  it("supports semantic edit, part export, conflict preview, and explicit apply", async () => {
    const { app } = await createApi();
    const sourceProject = await createProject(app, "Semantic API source");
    const sourceImport = await importSkin(app, sourceProject.projectId);
    const edited = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceImport.revisionId}/operations`,
      payload: {
        type: "assign_pixels",
        summary: "标记来源头发",
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
    expect(edited.statusCode).toBe(201);
    const editedRevisionId = edited.json<MutationResponse>().revision.id;

    const exported = await app.inject({
      method: "POST",
      url: `/api/revisions/${editedRevisionId}/components/hair.main/export-part`,
      payload: { name: "API 头发" },
    });
    expect(exported.statusCode).toBe(201);
    const part = exported.json<{ part: { id: string } }>().part;

    const listed = await app.inject({ method: "GET", url: "/api/parts?category=hair" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      parts: [{ id: part.id, name: "API 头发", category: "hair" }],
    });
    const texture = await app.inject({
      method: "GET",
      url: `/api/parts/${part.id}/texture.png`,
    });
    expect(texture.statusCode).toBe(200);
    expect(texture.headers["content-type"]).toContain("image/png");
    expect(decodeSkinPng(texture.rawPayload)).toMatchObject({
      width: 64,
      height: 64,
    });
    const mannequin = await app.inject({
      method: "GET",
      url: `/api/parts/${part.id}/mannequin.png?armType=slim`,
    });
    expect(mannequin.statusCode).toBe(200);
    expect(mannequin.headers["content-type"]).toContain("image/png");
    const mannequinTexture = decodeSkinPng(mannequin.rawPayload);
    expect(getPixel(mannequinTexture, 10, 8)).toEqual([226, 229, 224, 255]);

    const invalidMannequin = await app.inject({
      method: "GET",
      url: `/api/parts/${part.id}/mannequin.png?armType=invalid`,
    });
    expect(invalidMannequin.statusCode).toBe(400);

    const targetProject = await createProject(app, "Semantic API target");
    const targetImport = await importSkinFromPath(
      app,
      targetProject.projectId,
      TARGET_SKIN_PATH,
    );
    const preview = await app.inject({
      method: "POST",
      url: `/api/revisions/${targetImport.revisionId}/apply-part`,
      payload: { partId: part.id },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      committed: false,
      revisionId: targetImport.revisionId,
      report: { compatible: true, writePixelCount: 2 },
    });
    const beforeCommit = await app.inject({
      method: "GET",
      url: `/api/projects/${targetProject.projectId}/revisions`,
    });
    expect(beforeCommit.json<{ revisions: unknown[] }>().revisions).toHaveLength(1);

    const applied = await app.inject({
      method: "POST",
      url: `/api/revisions/${targetImport.revisionId}/apply-part`,
      payload: {
        partId: part.id,
        strategy: "use_part",
        summary: "API 混搭头发",
      },
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json()).toMatchObject({
      committed: true,
      revision: {
        parentRevisionId: targetImport.revisionId,
        operationType: "apply_part",
        summary: "API 混搭头发",
      },
    });

    const invalidOperation = await app.inject({
      method: "POST",
      url: `/api/revisions/${editedRevisionId}/operations`,
      payload: {
        type: "assign_pixels",
        target: {
          instanceId: "bad",
          displayName: "Bad",
          category: "hair",
        },
        spans: [{ surface: "invalid", y: 0, x0: 0, x1: 0 }],
      },
    });
    expect(invalidOperation.statusCode).toBe(400);
    expect(invalidOperation.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("edits a part through immutable repair revisions and commits a new part", async () => {
    const { app } = await createApi();
    const sourceProject = await createProject(app, "Repair API source");
    const sourceImport = await importSkin(app, sourceProject.projectId);
    const edited = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceImport.revisionId}/operations`,
      payload: {
        type: "assign_pixels",
        target: {
          instanceId: "clothing.repair",
          displayName: "待修补衣服",
          category: "upper_clothing",
        },
        spans: [{ surface: "torso.base.front", y: 20, x0: 20, x1: 21 }],
      },
    });
    expect(edited.statusCode).toBe(201);
    const sourceRevisionId = edited.json<MutationResponse>().revision.id;
    const exported = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceRevisionId}/components/clothing.repair/export-part`,
      payload: { name: "待修补衣服" },
    });
    expect(exported.statusCode).toBe(201);
    const basePart = exported.json<{
      part: { id: string; texture: { sha256: string } };
    }>().part;
    const originalTexture = await app.inject({
      method: "GET",
      url: `/api/parts/${encodeURIComponent(basePart.id)}/texture.png`,
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/part-edits",
      payload: { basePartId: basePart.id, name: "衣服缺口修补" },
    });
    expect(created.statusCode).toBe(201);
    const initial = created.json<{
      partEdit: {
        project: { id: string; status: string; headRevisionId: string };
        headRevision: { id: string; sequence: number };
      };
    }>().partEdit;
    expect(initial).toMatchObject({
      project: { status: "draft" },
      headRevision: { sequence: 1 },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/part-edits?basePartId=${encodeURIComponent(basePart.id)}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      partEdits: [{ id: initial.project.id, basePartId: basePart.id }],
    });

    const applied = await app.inject({
      method: "POST",
      url: `/api/part-edits/${encodeURIComponent(initial.project.id)}/operations`,
      payload: {
        headRevisionId: initial.headRevision.id,
        summary: "补一个像素",
        operation: {
          type: "paint_color",
          spans: [{ surface: "torso.base.front", y: 20, x0: 22, x1: 22 }],
          rgba: [122, 81, 64, 255],
        },
      },
    });
    expect(applied.statusCode).toBe(201);
    const repaired = applied.json<{
      partEdit: {
        project: { id: string; headRevisionId: string };
        headRevision: {
          id: string;
          sequence: number;
          changedPixelCount: number;
          texture: { sha256: string };
          writeMask: { sha256: string };
        };
      };
    }>().partEdit;
    expect(repaired.headRevision).toMatchObject({
      sequence: 2,
      changedPixelCount: 1,
    });
    expect(repaired.headRevision.id).not.toBe(initial.headRevision.id);

    const stale = await app.inject({
      method: "POST",
      url: `/api/part-edits/${encodeURIComponent(initial.project.id)}/operations`,
      payload: {
        headRevisionId: initial.headRevision.id,
        operation: {
          type: "erase_pixels",
          spans: [{ surface: "torso.base.front", y: 20, x0: 20, x1: 20 }],
        },
      },
    });
    expect(stale.statusCode).toBe(409);

    const invalidTransparentPaint = await app.inject({
      method: "POST",
      url: `/api/part-edits/${encodeURIComponent(initial.project.id)}/operations`,
      payload: {
        headRevisionId: repaired.headRevision.id,
        operation: {
          type: "paint_color",
          spans: [{ surface: "torso.base.front", y: 20, x0: 23, x1: 23 }],
          rgba: [1, 2, 3, 0],
        },
      },
    });
    expect(invalidTransparentPaint.statusCode).toBe(400);
    expect(invalidTransparentPaint.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const invalidTransparentReplacement = await app.inject({
      method: "POST",
      url: `/api/part-edits/${encodeURIComponent(initial.project.id)}/operations`,
      payload: {
        headRevisionId: repaired.headRevision.id,
        operation: {
          type: "replace_color",
          from: [122, 81, 64, 255],
          to: [0, 0, 0, 0],
        },
      },
    });
    expect(invalidTransparentReplacement.statusCode).toBe(400);
    expect(invalidTransparentReplacement.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const crossVariant = await app.inject({
      method: "POST",
      url: `/api/part-edits/${encodeURIComponent(initial.project.id)}/operations`,
      payload: {
        headRevisionId: repaired.headRevision.id,
        operation: {
          type: "erase_pixels",
          spans: [{ surface: "torso.base.front", y: 20, x0: 23, x1: 23 }],
          rgba: [1, 2, 3, 255],
        },
      },
    });
    expect(crossVariant.statusCode).toBe(400);

    for (const fileName of ["texture.png", "write-mask.png"] as const) {
      const asset = await app.inject({
        method: "GET",
        url: `/api/part-edit-revisions/${encodeURIComponent(repaired.headRevision.id)}/${fileName}`,
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("image/png");
      expect(asset.headers["cache-control"]).toContain("immutable");
      expect(asset.headers.etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);
      expect(decodeSkinPng(asset.rawPayload)).toMatchObject({ width: 64, height: 64 });
    }
    const mannequin = await app.inject({
      method: "GET",
      url: `/api/part-edit-revisions/${encodeURIComponent(repaired.headRevision.id)}/mannequin.png?armType=slim`,
    });
    expect(mannequin.statusCode).toBe(200);
    expect(mannequin.headers["cache-control"]).toContain("immutable");
    expect(mannequin.headers.etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);

    const committed = await app.inject({
      method: "POST",
      url: `/api/part-edits/${encodeURIComponent(initial.project.id)}/commit`,
      payload: {
        headRevisionId: repaired.headRevision.id,
        name: "完整修补衣服",
        summary: "确认修补",
      },
    });
    expect(committed.statusCode).toBe(201);
    const committedBody = committed.json<{
      partEdit: { project: { status: string; resultPartId: string } };
      part: { id: string; name: string };
    }>();
    expect(committedBody).toMatchObject({
      partEdit: { project: { status: "committed" } },
      part: { name: "完整修补衣服" },
    });
    expect(committedBody.part.id).not.toBe(basePart.id);

    const originalAfterCommit = await app.inject({
      method: "GET",
      url: `/api/parts/${encodeURIComponent(basePart.id)}/texture.png`,
    });
    expect(originalAfterCommit.rawPayload).toEqual(originalTexture.rawPayload);
    expect(originalAfterCommit.headers.etag).toBe(originalTexture.headers.etag);
  });

  it("creates, resolves, previews, and commits a composition project", async () => {
    const { app } = await createApi();
    const sourceProject = await createProject(app, "Composer source");
    const sourceImport = await importSkin(app, sourceProject.projectId);
    const edited = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceImport.revisionId}/operations`,
      payload: {
        type: "assign_pixels",
        target: {
          instanceId: "hair.compose",
          displayName: "混搭头发",
          category: "hair",
        },
        spans: [
          { surface: "head.base.front", y: 8, x0: 8, x1: 9 },
        ],
      },
    });
    const sourceRevisionId = edited.json<MutationResponse>().revision.id;
    const exported = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceRevisionId}/components/hair.compose/export-part`,
      payload: { name: "Composition hair" },
    });
    const partId = exported.json<{ part: { id: string } }>().part.id;

    const targetProject = await createProject(app, "Composer target");
    const target = await importSkinFromPath(
      app,
      targetProject.projectId,
      TARGET_SKIN_PATH,
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/compositions",
      payload: {
        baseRevisionId: target.revisionId,
        name: "API composition",
      },
    });
    expect(created.statusCode).toBe(201);
    const compositionId = created.json<{
      composition: { id: string; status: string; armType: string };
    }>().composition.id;
    expect(created.json()).toMatchObject({
      composition: { status: "draft", armType: "slim" },
      layers: [],
      report: { layerCount: 0, committable: false },
    });

    for (const alpha of [0, 128]) {
      const translucentRestoration = await app.inject({
        method: "POST",
        url: `/api/compositions/${compositionId}/restoration-candidates`,
        payload: {
          targetComponentIds: ["shirt.main"],
          manualRgba: [220, 170, 140, alpha],
        },
      });
      expect(translucentRestoration.statusCode).toBe(400);
      expect(translucentRestoration.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
      const translucentPlan = await app.inject({
        method: "PUT",
        url: `/api/compositions/${compositionId}/restoration-plan`,
        payload: {
          expectedVersion: 0,
          candidateSetHash: `sha256:${"a".repeat(64)}`,
          candidateIds: ["candidate_outer"],
          targetComponentIds: ["shirt.main"],
          manualRgba: [220, 170, 140, alpha],
        },
      });
      expect(translucentPlan.statusCode).toBe(400);
      expect(translucentPlan.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
    }

    const rawMaskRestoration = await app.inject({
      method: "PUT",
      url: `/api/compositions/${compositionId}/restoration-plan`,
      payload: {
        expectedVersion: 0,
        candidateSetHash: `sha256:${"a".repeat(64)}`,
        candidateIds: ["candidate.outer"],
        targetComponentIds: ["shirt.main"],
        rawMask: [1, 2, 3],
      },
    });
    expect(rawMaskRestoration.statusCode).toBe(400);
    expect(rawMaskRestoration.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const missingRegenerationInput = await app.inject({
      method: "PUT",
      url: `/api/compositions/${compositionId}/restoration-plan`,
      payload: {
        expectedVersion: 0,
        candidateSetHash: `sha256:${"a".repeat(64)}`,
        candidateIds: ["candidate.outer"],
      },
    });
    expect(missingRegenerationInput.statusCode).toBe(400);

    const added = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/apply-part`,
      payload: { partId },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      layers: [{ partId, position: 0 }],
      report: {
        layerCount: 1,
        hardConflictCount: expect.any(Number),
        committable: false,
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/compositions?revisionId=${target.revisionId}`,
    });
    expect(listed.json()).toMatchObject({
      compositions: [{ id: compositionId, status: "draft" }],
    });
    const preview = await app.inject({
      method: "GET",
      url: `/api/compositions/${compositionId}/preview.png`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toContain("no-store");
    expect(decodeSkinPng(preview.rawPayload)).toMatchObject({
      width: 64,
      height: 64,
    });

    const unresolvedCommit = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/commit`,
      payload: {},
    });
    expect(unresolvedCommit.statusCode).toBe(409);

    const invalidResolution = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/resolve-conflict`,
      payload: { strategy: "clear", conflictId: "pixel:1" },
    });
    expect(invalidResolution.statusCode).toBe(400);
    expect(invalidResolution.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const resolved = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/resolve-conflict`,
      payload: { strategy: "layer_order" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      composition: { resolutionMode: "layer_order" },
      report: { unresolvedConflictCount: 0, committable: true },
    });

    const committed = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/commit`,
      payload: { summary: "API 提交混搭" },
    });
    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toMatchObject({
      revision: {
        parentRevisionId: target.revisionId,
        operationType: "compose",
        summary: "API 提交混搭",
      },
      composition: { status: "committed" },
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/compositions",
      payload: { baseRevisionId: target.revisionId, unexpected: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("generates restoration candidates without mutation and persists only a recomputed plan", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "Restoration API target");
    const imported = await importSkinFromPath(
      app,
      project.projectId,
      TARGET_SKIN_PATH,
    );
    const segmented = await app.inject({
      method: "POST",
      url: `/api/revisions/${imported.revisionId}/operations`,
      payload: {
        type: "assign_pixels",
        target: {
          instanceId: "clothing.cleanup",
          displayName: "待替换衣服",
          category: "upper_clothing",
        },
        spans: [
          { surface: "torso.base.front", y: 20, x0: 20, x1: 20 },
          { surface: "torso.outer.front", y: 37, x0: 21, x1: 21 },
        ],
      },
    });
    expect(segmented.statusCode).toBe(201);
    const baseRevisionId = segmented.json<MutationResponse>().revision.id;
    const created = await app.inject({
      method: "POST",
      url: "/api/compositions",
      payload: { baseRevisionId, name: "Restoration API composition" },
    });
    expect(created.statusCode).toBe(201);
    const compositionId = created.json<{
      composition: { id: string; restorationPlan: null };
    }>().composition.id;

    const generationInput = {
      targetComponentIds: ["clothing.cleanup"],
      manualRgba: [220, 170, 140, 255] as const,
    };
    const generated = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/restoration-candidates`,
      payload: generationInput,
    });
    expect(generated.statusCode).toBe(200);
    const candidates = generated.json<{
      version: number;
      candidateSetHash: string;
      targetComponentIds: string[];
      outer: { pixelCount: number; candidateId: string | null };
      base: {
        pixelCount: number;
        coveredPixelCount: number;
        missingPixelCount: number;
        candidates: Array<{
          id: string;
          kind: string;
          targetGroupId: string;
          coveragePixelCount: number;
          rgba?: readonly number[];
        }>;
      };
    }>();
    expect(candidates).toMatchObject({
      version: 0,
      candidateSetHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      targetComponentIds: ["clothing.cleanup"],
      outer: {
        pixelCount: 1,
        candidateId: expect.any(String),
      },
      base: {
        pixelCount: 1,
        coveredPixelCount: 1,
        missingPixelCount: 0,
      },
    });
    const manualCandidate = candidates.base.candidates.find(
      (candidate) => candidate.kind === "manual_rgba",
    );
    expect(manualCandidate).toMatchObject({
      targetGroupId: expect.any(String),
      coveragePixelCount: 1,
      rgba: generationInput.manualRgba,
    });

    const generatedAgain = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/restoration-candidates`,
      payload: generationInput,
    });
    expect(generatedAgain.statusCode).toBe(200);
    expect(generatedAgain.json()).toEqual(candidates);
    const beforeSet = await app.inject({
      method: "GET",
      url: `/api/compositions/${compositionId}`,
    });
    expect(beforeSet.json()).toMatchObject({
      composition: { restorationPlan: null },
      report: {
        restorationPixelCount: 0,
        restorationMissingPixelCount: 0,
        restorationIssueCount: 0,
      },
    });
    const revisionList = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}/revisions`,
    });
    expect(revisionList.json<{ revisions: unknown[] }>().revisions).toHaveLength(2);

    const candidateIds = [candidates.outer.candidateId!, manualCandidate!.id];
    const mismatchedRegeneration = await app.inject({
      method: "PUT",
      url: `/api/compositions/${compositionId}/restoration-plan`,
      payload: {
        expectedVersion: candidates.version,
        candidateSetHash: candidates.candidateSetHash,
        candidateIds,
        targetComponentIds: generationInput.targetComponentIds,
        manualRgba: [221, 170, 140, 255],
      },
    });
    expect(mismatchedRegeneration.statusCode).toBe(409);
    expect(mismatchedRegeneration.json()).toMatchObject({
      error: { code: "CONFLICT" },
    });

    const applied = await app.inject({
      method: "PUT",
      url: `/api/compositions/${compositionId}/restoration-plan`,
      payload: {
        expectedVersion: candidates.version,
        candidateSetHash: candidates.candidateSetHash,
        candidateIds,
        ...generationInput,
      },
    });
    expect(applied.statusCode, JSON.stringify(applied.json())).toBe(200);
    expect(applied.json()).toMatchObject({
      composition: {
        restorationPlan: {
          version: 1,
          candidateSetHash: candidates.candidateSetHash,
          targetComponentIds: generationInput.targetComponentIds,
          candidateIds,
          outerPixelCount: 1,
          basePixelCount: 1,
          coveredPixelCount: 2,
          missingPixelCount: 0,
          planHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      },
      report: {
        restorationPixelCount: 2,
        restoredOuterPixelCount: 1,
        restoredBasePixelCount: 1,
        restorationMissingPixelCount: 0,
        restorationIssueCount: 0,
        committable: true,
      },
    });
    const preview = await app.inject({
      method: "GET",
      url: `/api/compositions/${compositionId}/preview.png`,
    });
    const previewImage = decodeSkinPng(preview.rawPayload);
    expect(getPixel(previewImage, 20, 20)).toEqual(generationInput.manualRgba);
    expect(getPixel(previewImage, 21, 37)[3]).toBe(0);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/compositions/${compositionId}/restoration-plan`,
      payload: { expectedVersion: 1 },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      composition: { restorationPlan: null },
      report: {
        restorationPixelCount: 0,
        restorationMissingPixelCount: 0,
        restorationIssueCount: 0,
        committable: false,
      },
    });
    const staleClear = await app.inject({
      method: "DELETE",
      url: `/api/compositions/${compositionId}/restoration-plan`,
      payload: { expectedVersion: 1 },
    });
    expect(staleClear.statusCode).toBe(409);
    const regeneratedAfterClear = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/restoration-candidates`,
      payload: generationInput,
    });
    expect(regeneratedAfterClear.json()).toMatchObject({ version: 2 });
  });

  it("serves analyzed skins and applies immutable aggregate bundles atomically", async () => {
    const provider = new ApiAiProvider("catalog-provider");
    const { app } = await createApi([provider]);
    const sourceProject = await createProject(app, "Catalog / 女仆皮肤");
    const sourceImport = await importSkin(app, sourceProject.projectId);
    const started = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceImport.revisionId}/ai-analysis`,
      payload: {
        mode: "full",
        provider: "catalog-provider",
        model: "catalog-model",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: true,
      },
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json<{ job: { id: string } }>().job.id;
    const job = await waitForAiJob(app, jobId);
    const analyzedRevisionId = job.job.resultRevisionId!;

    const listed = await app.inject({
      method: "GET",
      url: `/api/analyzed-skins?projectId=${sourceProject.projectId}&kind=hair&q=${encodeURIComponent("女仆")}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      analyzedSkins: [
        {
          project: { id: sourceProject.projectId, name: "Catalog / 女仆皮肤" },
          revision: { id: analyzedRevisionId },
          aiJob: { id: jobId, provider: "catalog-provider", model: "catalog-model" },
          armType: "slim",
          componentCount: 1,
          groups: [
            {
              key: "aggregate.hair",
              kind: "hair",
              componentIds: ["hair.main"],
              exportedBundleId: null,
            },
          ],
        },
      ],
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/analyzed-skins/${encodeURIComponent(analyzedRevisionId)}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      analyzedSkin: { revision: { id: analyzedRevisionId } },
    });

    const invalidKind = await app.inject({
      method: "POST",
      url: `/api/revisions/${analyzedRevisionId}/export-bundle`,
      payload: { kind: "face", componentIds: ["hair.main"] },
    });
    expect(invalidKind.statusCode).toBe(400);
    expect(invalidKind.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    const invalidGroup = await app.inject({
      method: "POST",
      url: `/api/revisions/${analyzedRevisionId}/export-bundle`,
      payload: {
        kind: "hair",
        componentIds: ["hair.main"],
        sourceGroupKey: "outfit.other",
      },
    });
    expect(invalidGroup.statusCode).toBe(400);
    expect(invalidGroup.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });

    const exported = await app.inject({
      method: "POST",
      url: `/api/revisions/${analyzedRevisionId}/export-bundle`,
      payload: {
        name: "AI 完整头发",
        kind: "hair",
        componentIds: ["hair.main"],
      },
    });
    expect(exported.statusCode).toBe(201);
    const bundle = exported.json<{
      bundle: { id: string; members: readonly { partId: string }[] };
    }>().bundle;
    expect(bundle.members).toHaveLength(1);

    const filteredBundles = await app.inject({
      method: "GET",
      url: `/api/part-bundles?kind=hair&sourceRevisionId=${analyzedRevisionId}`,
    });
    expect(filteredBundles.statusCode).toBe(200);
    expect(filteredBundles.json()).toMatchObject({
      bundles: [{ id: bundle.id, name: "AI 完整头发", kind: "hair" }],
    });
    const bundleDetail = await app.inject({
      method: "GET",
      url: `/api/part-bundles/${encodeURIComponent(bundle.id)}`,
    });
    expect(bundleDetail.statusCode).toBe(200);
    expect(bundleDetail.json()).toMatchObject({ bundle: { id: bundle.id } });

    const preview = await app.inject({
      method: "GET",
      url: `/api/part-bundles/${bundle.id}/preview.png`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toContain("immutable");
    expect(preview.headers.etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    expect(decodeSkinPng(preview.rawPayload)).toMatchObject({ width: 64, height: 64 });
    const mannequin = await app.inject({
      method: "GET",
      url: `/api/part-bundles/${bundle.id}/mannequin.png?armType=slim`,
    });
    expect(mannequin.statusCode).toBe(200);
    expect(mannequin.headers["cache-control"]).toContain("immutable");
    expect(mannequin.headers.etag).not.toBe(preview.headers.etag);
    expect(decodeSkinPng(mannequin.rawPayload)).toMatchObject({ width: 64, height: 64 });

    const targetProject = await createProject(app, "Bundle target");
    const target = await importSkinFromPath(
      app,
      targetProject.projectId,
      TARGET_SKIN_PATH,
    );
    const compositionResponse = await app.inject({
      method: "POST",
      url: "/api/compositions",
      payload: { baseRevisionId: target.revisionId },
    });
    const compositionId = compositionResponse.json<{
      composition: { id: string };
    }>().composition.id;
    const applied = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/apply-bundle`,
      payload: { bundleId: bundle.id },
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json()).toMatchObject({
      layers: [{ partId: bundle.members[0]!.partId, position: 0 }],
      report: { layerCount: 1 },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/apply-bundle`,
      payload: { bundleId: bundle.id },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "CONFLICT" } });
    const afterFailure = await app.inject({
      method: "GET",
      url: `/api/compositions/${compositionId}`,
    });
    expect(afterFailure.json()).toMatchObject({
      layers: [{ partId: bundle.members[0]!.partId, position: 0 }],
      report: { layerCount: 1 },
    });

    const refreshedCatalog = await app.inject({
      method: "GET",
      url: `/api/analyzed-skins/${analyzedRevisionId}`,
    });
    expect(refreshedCatalog.json()).toMatchObject({
      analyzedSkin: {
        groups: [{ kind: "hair", exportedBundleId: bundle.id }],
      },
    });
  });

  it("returns stable client errors for bad PNG data and duplicate imports", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "Error handling");

    const invalidPng = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/import`,
      headers: { "content-type": "image/png" },
      payload: Buffer.from("not a png"),
    });
    expect(invalidPng.statusCode).toBe(400);
    expect(invalidPng.json()).toMatchObject({ error: { code: "INVALID_PNG" } });

    await importSkin(app, project.projectId);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/projects/${project.projectId}/import`,
      headers: { "content-type": "image/png" },
      payload: await readFile(REAL_SKIN_PATH),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("rejects API reads after checksum corruption", async () => {
    const { app, directory } = await createApi();
    const project = await createProject(app, "Corrupt API snapshot");
    const imported = await importSkin(app, project.projectId);
    await writeFile(
      join(
        directory,
        "projects",
        project.projectId,
        "revisions",
        imported.revisionId,
        "checksum.json",
      ),
      "{}\n",
      "utf8",
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/revisions/${imported.revisionId}/skin.png`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "SNAPSHOT_CORRUPT" },
    });
  });

  it("runs, audits, and retries AI analysis through the HTTP boundary", async () => {
    const providerA = new ApiAiProvider("provider-a");
    const providerB = new ApiAiProvider("provider-b");
    const { app } = await createApi([providerA, providerB]);
    const project = await createProject(app, "AI API");
    const imported = await importSkin(app, project.projectId);

    const providers = await app.inject({
      method: "GET",
      url: "/api/ai/providers",
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toMatchObject({
      providers: ["provider-a", "provider-b"],
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/revisions/${imported.revisionId}/ai-analysis`,
      payload: {
        mode: "full",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair", "face", "upper_clothing", "shoe"],
        createRevisionOnSuccess: true,
      },
    });
    expect(started.statusCode).toBe(202);
    const firstJobId = started.json<{ job: { id: string } }>().job.id;
    const first = await waitForAiJob(app, firstJobId);
    expect(first.job).toMatchObject({
      status: "succeeded",
      provider: "provider-a",
      model: "model-a",
      proposalSummary: "API AI 提案",
    });
    expect(first.job.resultRevisionId).toEqual(expect.any(String));
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({
      status: "succeeded",
      assets: [{}, {}, {}, {}, {}],
    });
    expect(first.events.some((event) => event.eventType === "validating")).toBe(
      true,
    );
    expect(first.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["provider_session", "provider_output"]),
    );

    const aiRevision = await app.inject({
      method: "GET",
      url: `/api/revisions/${first.job.resultRevisionId}`,
    });
    expect(aiRevision.statusCode).toBe(200);
    expect(aiRevision.json()).toMatchObject({
      revision: {
        operationType: "ai_segment",
        actorType: "ai",
        parentRevisionId: imported.revisionId,
      },
    });

    const eventResponse = await app.inject({
      method: "GET",
      url: `/api/ai-jobs/${firstJobId}/events`,
    });
    expect(eventResponse.statusCode).toBe(200);
    const eventTypes = eventResponse
      .json<{ events: { eventType: string }[] }>()
      .events.map((event) => event.eventType);
    expect(eventTypes.length).toBeGreaterThan(4);
    expect(eventTypes).toEqual(
      expect.arrayContaining(["provider_session", "provider_output"]),
    );

    const retried = await app.inject({
      method: "POST",
      url: `/api/ai-jobs/${firstJobId}/retry`,
      payload: {
        provider: "provider-b",
        model: "model-b",
        reasoningEffort: "high",
        createRevisionOnSuccess: false,
      },
    });
    expect(retried.statusCode).toBe(202);
    const retryJobId = retried.json<{ job: { id: string } }>().job.id;
    const retry = await waitForAiJob(app, retryJobId);
    expect(retry.job).toMatchObject({
      status: "succeeded",
      resultRevisionId: null,
      retryOfJobId: firstJobId,
      provider: "provider-b",
      model: "model-b",
    });

    const invalid = await app.inject({
      method: "POST",
      url: `/api/revisions/${imported.revisionId}/ai-analysis`,
      payload: {
        mode: "full",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: false,
        extra: true,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });
});

interface CreatedProject {
  readonly projectId: string;
  readonly branchId: string;
}

interface ImportResponse {
  readonly projectId: string;
  readonly branchId: string;
  readonly revisionId: string;
  readonly armType: "wide" | "slim";
  readonly warnings: readonly string[];
}

interface MutationResponse {
  readonly revision: {
    readonly id: string;
    readonly parentRevisionId: string | null;
    readonly operationType: string;
    readonly sequence: number;
  };
}

async function createApi(aiProviders?: readonly SkinSemanticAiProvider[]) {
  const directory = await mkdtemp(join(tmpdir(), "mcskinsplit-api-"));
  const app = buildApi({
    dataDirectory: directory,
    ...(aiProviders ? { aiProviders } : {}),
  });
  resources.push({ app, directory });
  return { app, directory };
}

interface AiJobApiDetail {
  readonly job: {
    readonly id: string;
    readonly status: string;
    readonly resultRevisionId: string | null;
    readonly retryOfJobId: string | null;
    readonly provider: string;
    readonly model: string;
    readonly proposalSummary: string | null;
  };
  readonly runs: readonly {
    readonly status: string;
    readonly assets: readonly unknown[];
  }[];
  readonly events: readonly { readonly eventType: string }[];
}

async function waitForAiJob(
  app: FastifyInstance,
  jobId: string,
): Promise<AiJobApiDetail> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/ai-jobs/${jobId}`,
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json<AiJobApiDetail>();
    if (["succeeded", "failed", "cancelled"].includes(detail.job.status)) {
      return detail;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`AI Job did not finish: ${jobId}`);
}

class ApiAiProvider implements SkinSemanticAiProvider {
  constructor(readonly providerName: string) {}

  async analyze(input: ProviderAnalysisInput): Promise<ProviderAnalysisResult> {
    input.onProgress?.({
      kind: "session",
      status: "started",
      message: "Codex 会话已建立",
    });
    input.onProgress?.({
      kind: "output",
      status: "completed",
      message: "候选组件提案已生成",
    });
    return {
      proposal: apiProposal(input),
      rawEvents: `${JSON.stringify({ type: "thread.started", thread_id: `${this.providerName}-thread` })}\n`,
      stderr: "",
      threadId: `${this.providerName}-thread`,
      usage: { input_tokens: 20, output_tokens: 10 },
    };
  }
}

function apiProposal(input: ProviderAnalysisInput): AnalysisProposal {
  const regions = input.pack.candidateRegions.regions;
  return {
    schemaVersion: "1.0",
    sourceRevisionId: input.pack.job.sourceRevisionId,
    modelAssessment: {
      armType: input.pack.job.armType,
      confidence: 0.95,
    },
    components: [
      {
        instanceId: "hair.main",
        displayName: "AI 主头发",
        category: "hair",
        subtype: null,
        confidence: 0.72,
        candidateRegionIds: [regions[0]!.id],
        pixelOverrides: { add: [], remove: [] },
        relations: {
          attachedTo: null,
          pairedWith: [],
          sameOutfitGroup: null,
        },
        notes: "",
      },
    ],
    unassignedCandidateRegionIds: regions.slice(1).map((region) => region.id),
    reviewItems: [],
    summary: "API AI 提案",
  };
}

async function createProject(
  app: FastifyInstance,
  name: string,
): Promise<CreatedProject> {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{
    project: { id: string };
    branch: { id: string };
  }>();
  return { projectId: body.project.id, branchId: body.branch.id };
}

async function importSkin(
  app: FastifyInstance,
  projectId: string,
): Promise<ImportResponse> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/import`,
    headers: { "content-type": "image/png" },
    payload: await readFile(REAL_SKIN_PATH),
  });
  expect(response.statusCode).toBe(201);
  return response.json<ImportResponse>();
}

async function importSkinFromPath(
  app: FastifyInstance,
  projectId: string,
  path: string,
): Promise<ImportResponse> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/import`,
    headers: { "content-type": "image/png" },
    payload: await readFile(path),
  });
  expect(response.statusCode).toBe(201);
  return response.json<ImportResponse>();
}
