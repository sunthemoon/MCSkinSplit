import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSkinPng, getPixel } from "@mc-skin-split/skin-core";
import type {
  AnalysisProposal,
  CompletionRankingProposal,
  ProviderAnalysisInput,
  ProviderAnalysisResult,
  ProviderCompletionRankingInput,
  ProviderCompletionRankingResult,
  ProviderReplacementInput,
  ProviderReplacementResult,
  ReplacementPlanProposal,
  SkinSemanticAiProvider,
} from "@mc-skin-split/ai-provider";
import { RevisionStore } from "@mc-skin-split/skin-revision";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  readonly store: RevisionStore;
}> = [];

afterEach(async () => {
  const createdResources = resources.splice(0);
  await Promise.all(createdResources.map(({ app }) => app.close()));
  for (const { store } of createdResources) store.close();
  await Promise.all(
    createdResources.map(({ directory }) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  vi.unstubAllEnvs();
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
        originAssetId: expect.any(String),
      },
      assets: [{}, {}, {}, {}, {}],
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

    const origin = await app.inject({
      method: "GET",
      url: `/api/revisions/${importResult.revisionId}/origin`,
    });
    expect(origin.statusCode).toBe(200);
    const originBody = origin.json<{
      origin: {
        availability: string;
        revisionId: string;
        originAssetId: string | null;
        document: {
          subject: { kind: string; id: string };
          entries: readonly unknown[];
        } | null;
        summary: {
          counts: Record<string, number>;
          containsGeneratedPixels: boolean;
        } | null;
        componentSummaries: Record<string, unknown>;
      };
    }>().origin;
    expect(Object.keys(originBody).sort()).toEqual([
      "availability",
      "componentSummaries",
      "document",
      "originAssetId",
      "revisionId",
      "summary",
    ]);
    expect(originBody).toMatchObject({
      availability: "recorded",
      revisionId: importResult.revisionId,
      originAssetId: expect.any(String),
      document: {
        subject: { kind: "revision", id: importResult.revisionId },
        entries: expect.any(Array),
      },
      summary: {
        counts: {
          manual_authored: 0,
          generated_completion: 0,
          legacy_mixed: 0,
        },
        containsGeneratedPixels: false,
      },
      componentSummaries: {},
    });
    expect(originBody.summary!.counts.source_visible).toBeGreaterThan(0);

    const missingOrigin = await app.inject({
      method: "GET",
      url: "/api/revisions/revision_missing/origin",
    });
    expect(missingOrigin.statusCode).toBe(404);
    expect(missingOrigin.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
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

  it("serializes the legacy-unavailable revision-origin contract", async () => {
    const { app, store } = await createApi();
    const project = await createProject(app, "Legacy origin API");
    const imported = await importSkin(app, project.projectId);
    const getRevision = store.getRevision.bind(store);
    const readOrigin = store.readRevisionOrigin.bind(store);
    store.getRevision = (revisionId) => {
      const revision = getRevision(revisionId);
      return revisionId === imported.revisionId
        ? { ...revision, originAssetId: null }
        : revision;
    };
    store.readRevisionOrigin = async (revisionId) =>
      revisionId === imported.revisionId ? null : readOrigin(revisionId);

    const response = await app.inject({
      method: "GET",
      url: `/api/revisions/${imported.revisionId}/origin`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      origin: {
        availability: "legacy_unavailable",
        revisionId: imported.revisionId,
        originAssetId: null,
        document: null,
        summary: null,
        componentSummaries: {},
      },
    });
  });

  it("generates component IDs and applies directional and symmetric relations", async () => {
    const { app, store } = await createApi();
    const project = await createProject(app, "Generated component API");
    const imported = await importSkin(app, project.projectId);
    const firstResponse = await app.inject({
      method: "POST",
      url: `/api/revisions/${imported.revisionId}/operations`,
      payload: {
        type: "assign_pixels",
        target: { displayName: "Generated hair", category: "hair" },
        spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
      },
    });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json<MutationResponse>();
    expect(first.generatedComponentId).toMatch(/^component_/u);

    const secondResponse = await app.inject({
      method: "POST",
      url: `/api/revisions/${first.revision.id}/operations`,
      payload: {
        type: "assign_pixels",
        target: { displayName: "Generated accessory", category: "head_accessory" },
        spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
      },
    });
    expect(secondResponse.statusCode).toBe(201);
    const second = secondResponse.json<MutationResponse>();
    expect(second.generatedComponentId).toMatch(/^component_/u);
    expect(second.generatedComponentId).not.toBe(first.generatedComponentId);

    const related = await app.inject({
      method: "POST",
      url: `/api/revisions/${second.revision.id}/operations`,
      payload: {
        type: "set_component_relations",
        componentId: first.generatedComponentId,
        relations: {
          attachedTo: second.generatedComponentId,
          pairedWith: [second.generatedComponentId],
          sameOutfitGroup: "generated.outfit",
          conflictsWith: [second.generatedComponentId],
        },
      },
    });
    expect(related.statusCode).toBe(201);
    const state = await store.readRevisionSemanticState(
      related.json<MutationResponse>().revision.id,
    );
    const byId = new Map(
      state.document.components.map((component) => [component.instanceId, component]),
    );
    expect(byId.get(first.generatedComponentId!)!.relations).toEqual({
      attachedTo: second.generatedComponentId,
      pairedWith: [second.generatedComponentId],
      sameOutfitGroup: "generated.outfit",
      conflictsWith: [second.generatedComponentId],
    });
    expect(byId.get(second.generatedComponentId!)!.relations).toMatchObject({
      attachedTo: null,
      pairedWith: [first.generatedComponentId],
      conflictsWith: [first.generatedComponentId],
    });

    const selfRelation = await app.inject({
      method: "POST",
      url: `/api/revisions/${related.json<MutationResponse>().revision.id}/operations`,
      payload: {
        type: "set_component_relations",
        componentId: first.generatedComponentId,
        relations: {
          attachedTo: first.generatedComponentId,
          pairedWith: [],
          sameOutfitGroup: null,
          conflictsWith: [],
        },
      },
    });
    expect(selfRelation.statusCode).toBe(400);
    expect(selfRelation.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("rejects known fields from a different manual-operation branch", async () => {
    const { app } = await createApi();
    const project = await createProject(app, "Strict manual operation API");
    const imported = await importSkin(app, project.projectId);
    const span = { surface: "head.base.front", y: 8, x0: 8, x1: 8 };
    const target = { displayName: "Strict target", category: "hair" };
    const relations = {
      attachedTo: null,
      pairedWith: [],
      sameOutfitGroup: null,
      conflictsWith: [],
    };
    const invalidPayloads = [
      { type: "assign_pixels", target, spans: [span], relations },
      { type: "unassign_pixels", spans: [span], target },
      {
        type: "merge_components",
        componentIds: ["hair.one", "hair.two"],
        target,
        relations,
      },
      {
        type: "split_component",
        sourceComponentId: "hair.one",
        target,
        spans: [span],
        componentIds: ["hair.one", "hair.two"],
      },
      {
        type: "reclassify_component",
        componentId: "hair.one",
        category: "hair",
        spans: [span],
      },
      {
        type: "set_component_relations",
        componentId: "hair.one",
        relations,
        spans: [span],
      },
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: `/api/revisions/${imported.revisionId}/operations`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
    }
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
      parts: [{
        id: part.id,
        name: "API 头发",
        category: "hair",
        libraryStatus: "active",
        sourceProjectName: "Semantic API source",
        sourceBranchName: "main",
      }],
    });
    const retired = await app.inject({
      method: "POST",
      url: `/api/parts/${part.id}/retire`,
      payload: { reason: "识别错误" },
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json()).toMatchObject({
      part: { id: part.id, libraryStatus: "retired", retiredReason: "识别错误" },
    });
    expect((await app.inject({ method: "GET", url: "/api/parts" })).json()).toEqual({ parts: [] });
    const retiredList = await app.inject({
      method: "GET",
      url: `/api/parts?status=retired&q=${encodeURIComponent("Semantic API")}`,
    });
    expect(retiredList.json()).toMatchObject({ parts: [{ id: part.id }] });
    const invalidQuery = await app.inject({ method: "GET", url: "/api/parts?status=deleted" });
    expect(invalidQuery.statusCode).toBe(400);
    const restore = await app.inject({
      method: "POST",
      url: `/api/parts/${part.id}/restore`,
      payload: {},
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({ part: { libraryStatus: "active" } });
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

    const appliedPart = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceRevisionId}/apply-part`,
      payload: {
        partId: committedBody.part.id,
        strategy: "use_part",
      },
    });
    expect(appliedPart.statusCode).toBe(201);
    const appliedRevisionId = appliedPart.json<MutationResponse>().revision.id;
    const authoredOrigin = await app.inject({
      method: "GET",
      url: `/api/revisions/${appliedRevisionId}/origin`,
    });
    expect(authoredOrigin.statusCode).toBe(200);
    const authored = authoredOrigin.json<{
      origin: {
        availability: string;
        summary: { counts: Record<string, number> };
        componentSummaries: Record<
          string,
          { counts: Record<string, number>; containsGeneratedPixels: boolean }
        >;
      };
    }>().origin;
    expect(authored.availability).toBe("recorded");
    expect(authored.summary.counts.manual_authored).toBeGreaterThan(0);
    expect(authored.summary.counts.generated_completion).toBe(0);
    expect(
      authored.componentSummaries[`applied.${committedBody.part.id}`],
    ).toMatchObject({
      counts: { manual_authored: expect.any(Number) },
      containsGeneratedPixels: false,
    });
    expect(
      authored.componentSummaries[`applied.${committedBody.part.id}`]!.counts
        .manual_authored,
    ).toBeGreaterThan(0);

    const originalAfterCommit = await app.inject({
      method: "GET",
      url: `/api/parts/${encodeURIComponent(basePart.id)}/texture.png`,
    });
    expect(originalAfterCommit.rawPayload).toEqual(originalTexture.rawPayload);
    expect(originalAfterCommit.headers.etag).toBe(originalTexture.headers.etag);
  });

  it("creates, resolves, previews, and commits a composition project", async () => {
    const provider = new ApiAiProvider("composition-guard-provider");
    const { app } = await createApi([provider]);
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
    const committedBody = committed.json<{
      revision: {
        id: string;
        parentRevisionId: string;
        operationType: string;
        summary: string;
      };
      composition: { status: string };
    }>();
    expect(committedBody).toMatchObject({
      revision: {
        parentRevisionId: target.revisionId,
        operationType: "compose",
        summary: "API 提交混搭",
      },
      composition: { status: "committed" },
    });

    const reanalysis = await app.inject({
      method: "POST",
      url: `/api/revisions/${committedBody.revision.id}/ai-analysis`,
      payload: {
        mode: "full",
        semanticBaseline: "empty",
        provider: provider.providerName,
        model: "guard-model",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: true,
      },
    });
    expect(reanalysis.statusCode).toBe(202);
    const reanalysisJob = await waitForAiJob(
      app,
      reanalysis.json<{ job: { id: string } }>().job.id,
    );
    expect(reanalysisJob.job).toMatchObject({
      status: "succeeded",
      resultRevisionId: expect.any(String),
    });

    const recordedJobs = await app.inject({
      method: "GET",
      url: `/api/ai-jobs?revisionId=${encodeURIComponent(committedBody.revision.id)}`,
    });
    expect(recordedJobs.statusCode).toBe(200);
    expect(recordedJobs.json()).toMatchObject({
      jobs: [{ id: reanalysisJob.job.id, status: "succeeded" }],
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
        semanticBaseline: "empty",
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
    expect(job.semanticFollowup).toMatchObject({
      status: "no_repair",
      suggestions: [],
    });
    const invalidFollowup = await app.inject({
      method: "POST",
      url: `/api/ai-jobs/${jobId}/semantic-followup/apply`,
      payload: {
        suggestionId: `followup_${"a".repeat(24)}`,
        spans: [],
      },
    });
    expect(invalidFollowup.statusCode).toBe(400);
    const dismissedNoRepair = await app.inject({
      method: "POST",
      url: `/api/ai-jobs/${jobId}/semantic-followup/dismiss`,
      payload: {},
    });
    expect(dismissedNoRepair.statusCode).toBe(200);
    expect(dismissedNoRepair.json()).toMatchObject({
      semanticFollowup: { status: "no_repair" },
    });

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

    const blockedMemberRetire = await app.inject({
      method: "POST",
      url: `/api/parts/${bundle.members[0]!.partId}/retire`,
      payload: {},
    });
    expect(blockedMemberRetire.statusCode).toBe(409);
    expect(blockedMemberRetire.json()).toMatchObject({
      error: { code: "CONFLICT", details: { bundleIds: [bundle.id] } },
    });

    const retiredBundle = await app.inject({
      method: "POST",
      url: `/api/part-bundles/${bundle.id}/retire`,
      payload: { reason: "错误的完整头发" },
    });
    expect(retiredBundle.statusCode).toBe(200);
    expect(retiredBundle.json()).toMatchObject({
      bundle: { libraryStatus: "retired", retiredReason: "错误的完整头发" },
    });
    expect((await app.inject({ method: "GET", url: "/api/part-bundles" })).json())
      .toEqual({ bundles: [] });
    expect((await app.inject({
      method: "GET",
      url: `/api/part-bundles?status=retired&projectId=${sourceProject.projectId}&q=${encodeURIComponent("女仆")}`,
    })).json()).toMatchObject({ bundles: [{ id: bundle.id }] });
    const restoredBundle = await app.inject({
      method: "POST",
      url: `/api/part-bundles/${bundle.id}/restore`,
      payload: {},
    });
    expect(restoredBundle.statusCode).toBe(200);
    expect(restoredBundle.json()).toMatchObject({ bundle: { libraryStatus: "active" } });

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
    await app.inject({
      method: "POST",
      url: `/api/part-bundles/${bundle.id}/retire`,
      payload: { reason: "不再作为导出结果" },
    });
    const catalogAfterRetire = await app.inject({
      method: "GET",
      url: `/api/analyzed-skins/${analyzedRevisionId}`,
    });
    expect(catalogAfterRetire.json()).toMatchObject({
      analyzedSkin: { groups: [{ kind: "hair", exportedBundleId: null }] },
    });
  });

  it("archives duplicate analyzed results while preserving jobs, revisions, and bundles", async () => {
    const provider = new ApiAiProvider("archive-provider");
    const { app } = await createApi([provider]);
    const project = await createProject(app, "Archive catalog fixture");
    const imported = await importSkin(app, project.projectId);
    const analysisPayload = {
      mode: "full",
      provider: "archive-provider",
      model: "archive-model",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: true,
    } as const;
    const firstStarted = await app.inject({
      method: "POST",
      url: `/api/revisions/${imported.revisionId}/ai-analysis`,
      payload: analysisPayload,
    });
    expect(firstStarted.statusCode).toBe(202);
    const firstJobId = firstStarted.json<{ job: { id: string } }>().job.id;
    const firstJob = await waitForAiJob(app, firstJobId);
    expect(firstJob.job.status).toBe("succeeded");
    const firstRevisionId = firstJob.job.resultRevisionId!;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));

    const secondStarted = await app.inject({
      method: "POST",
      url: `/api/revisions/${firstRevisionId}/ai-analysis`,
      payload: analysisPayload,
    });
    expect(secondStarted.statusCode).toBe(202);
    const secondJobId = secondStarted.json<{ job: { id: string } }>().job.id;
    const secondJob = await waitForAiJob(app, secondJobId);
    expect(secondJob.job.status).toBe("succeeded");
    const secondRevisionId = secondJob.job.resultRevisionId!;

    const beforeArchive = await app.inject({
      method: "GET",
      url: "/api/analyzed-skins",
    });
    expect(beforeArchive.statusCode).toBe(200);
    expect(
      beforeArchive.json<{
        analyzedSkins: readonly { revision: { id: string } }[];
      }>().analyzedSkins.map((item) => item.revision.id),
    ).toEqual([secondRevisionId, firstRevisionId]);

    const exported = await app.inject({
      method: "POST",
      url: `/api/revisions/${firstRevisionId}/export-bundle`,
      payload: {
        name: "Archived source hair",
        kind: "hair",
        componentIds: ["hair.main"],
      },
    });
    expect(exported.statusCode).toBe(201);
    const bundleId = exported.json<{ bundle: { id: string } }>().bundle.id;

    const archived = await app.inject({
      method: "POST",
      url: `/api/analyzed-skins/${firstRevisionId}/archive`,
      payload: { reason: "重复分析结果" },
    });
    expect(archived.statusCode).toBe(200);
    const archivedItem = archived.json<{
      analyzedSkin: {
        catalogStatus: string;
        archivedAt: string | null;
        archivedReason: string | null;
      };
    }>().analyzedSkin;
    expect(archivedItem).toMatchObject({
      catalogStatus: "archived",
      archivedReason: "重复分析结果",
    });
    expect(archivedItem.archivedAt).not.toBeNull();

    expect((await app.inject({ method: "GET", url: "/api/analyzed-skins" })).json())
      .toMatchObject({ analyzedSkins: [{ revision: { id: secondRevisionId } }] });
    const archivedList = await app.inject({
      method: "GET",
      url: "/api/analyzed-skins?status=archived",
    });
    expect(archivedList.json()).toMatchObject({
      analyzedSkins: [{ revision: { id: firstRevisionId }, catalogStatus: "archived" }],
    });
    const allList = await app.inject({
      method: "GET",
      url: "/api/analyzed-skins?status=all",
    });
    expect(
      allList.json<{
        analyzedSkins: readonly { revision: { id: string } }[];
      }>().analyzedSkins.map((item) => item.revision.id),
    ).toEqual([secondRevisionId, firstRevisionId]);
    expect((await app.inject({
      method: "GET",
      url: `/api/analyzed-skins/${firstRevisionId}`,
    })).json()).toMatchObject({
      analyzedSkin: { revision: { id: firstRevisionId }, catalogStatus: "archived" },
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/ai-jobs/${firstJobId}`,
    })).json()).toMatchObject({ job: { id: firstJobId, status: "succeeded" } });
    expect((await app.inject({
      method: "GET",
      url: `/api/revisions/${firstRevisionId}`,
    })).json()).toMatchObject({ revision: { id: firstRevisionId, operationType: "ai_segment" } });
    expect((await app.inject({
      method: "GET",
      url: `/api/part-bundles/${bundleId}`,
    })).json()).toMatchObject({
      bundle: { id: bundleId, sourceRevisionId: firstRevisionId, libraryStatus: "active" },
    });

    const archivedAgain = await app.inject({
      method: "POST",
      url: `/api/analyzed-skins/${firstRevisionId}/archive`,
      payload: { reason: "不覆盖原因" },
    });
    expect(archivedAgain.json()).toMatchObject({ analyzedSkin: archivedItem });

    const restored = await app.inject({
      method: "POST",
      url: `/api/analyzed-skins/${firstRevisionId}/restore`,
      payload: {},
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      analyzedSkin: {
        revision: { id: firstRevisionId },
        catalogStatus: "active",
        archivedAt: null,
        archivedReason: null,
      },
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/analyzed-skins/${firstRevisionId}/restore`,
      payload: {},
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "POST",
      url: `/api/analyzed-skins/${imported.revisionId}/archive`,
      payload: {},
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET",
      url: "/api/analyzed-skins?status=deleted",
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: `/api/analyzed-skins/${firstRevisionId}/archive`,
      payload: { reason: "valid", extra: true },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: `/api/analyzed-skins/${firstRevisionId}/archive`,
      payload: { reason: "x".repeat(301) },
    })).statusCode).toBe(400);
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

  it("maps corrupted revision-origin snapshots to a stable 409", async () => {
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
        "origin.json",
      ),
      "{}\n",
      "utf8",
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/revisions/${imported.revisionId}/origin`,
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
      completionRankingProviders: ["provider-a", "provider-b"],
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
        semanticBaseline: "current",
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
      options: { semanticBaseline: "current" },
    });

    const invalidUnknownFocus = await app.inject({
      method: "POST",
      url: `/api/revisions/${imported.revisionId}/ai-analysis`,
      payload: {
        mode: "full",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["unknown"],
        createRevisionOnSuccess: false,
      },
    });
    expect(invalidUnknownFocus.statusCode).toBe(400);
    expect(invalidUnknownFocus.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
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

  it("lists, accepts, rejects, and idempotently replays completion decisions", async () => {
    const provider = new ApiAiProvider("unused-completion-provider");
    const { app } = await createApi([provider]);
    const project = await createProject(app, "Completion API");
    const imported = await importSkin(app, project.projectId);
    const target = await app.inject({
      method: "POST",
      url: `/api/revisions/${imported.revisionId}/operations`,
      payload: {
        type: "assign_pixels",
        target: {
          instanceId: "clothing.completion",
          displayName: "待补全衣服",
          category: "upper_clothing",
        },
        spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
      },
    });
    expect(target.statusCode).toBe(201);
    const occluder = await app.inject({
      method: "POST",
      url: `/api/revisions/${target.json<MutationResponse>().revision.id}/operations`,
      payload: {
        type: "assign_pixels",
        target: {
          instanceId: "hair.occluder",
          displayName: "遮挡头发",
          category: "hair",
        },
        spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
      },
    });
    expect(occluder.statusCode).toBe(201);
    const sourceRevisionId = occluder.json<MutationResponse>().revision.id;

    const invalid = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceRevisionId}/completion-proposals`,
      payload: {
        targetComponentId: "clothing.completion",
        occludingComponentIds: ["hair.occluder"],
        representation: "latent_component",
        generatedMask: [1],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const started = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceRevisionId}/completion-proposals`,
      payload: {
        targetComponentId: "clothing.completion",
        occludingComponentIds: ["hair.occluder"],
        representation: "latent_component",
      },
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json<{ job: { id: string } }>().job.id;
    const job = await waitForAiJob(app, jobId);
    expect(job.job).toMatchObject({
      kind: "completion_proposal",
      status: "succeeded",
      provider: "deterministic_host",
      model: "completion-candidates-v1",
      resultRevisionId: null,
    });
    expect(job.runs).toEqual([]);

    const listed = await app.inject({
      method: "GET",
      url: `/api/completion-proposals?revisionId=${sourceRevisionId}&jobId=${jobId}`,
    });
    expect(listed.statusCode).toBe(200);
    const proposalSummary = listed.json<{
      proposals: readonly {
        proposal: {
          id: string;
          sourceResultHash: string;
          proposalHash: string;
          evidenceHash: string;
          allowedGeneratedPixelCount: number;
        };
      }[];
    }>().proposals[0]!;
    expect(proposalSummary).toMatchObject({
      status: "awaiting_decision",
      candidateCount: expect.any(Number),
      ranking: null,
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${proposalSummary.proposal.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json<{
      proposal: {
        id: string;
        sourceResultHash: string;
        proposalHash: string;
        evidenceHash: string;
        allowedGeneratedPixelCount: number;
        allowedMask: { sha256: string };
      };
      status: string;
      candidateCount: number;
      candidates: readonly {
        id: string;
        baseCandidateId: string | null;
        candidateHash: string;
        reviewRequired: boolean;
        automaticAcceptanceAllowed: boolean;
        document: { sha256: string };
        texture: { sha256: string };
        writeMask: { sha256: string };
        generatedMask: { sha256: string };
      }[];
      decision: null;
      result: null;
      ranking: null;
      document?: unknown;
    }>();
    expect(detail.document).toBeUndefined();
    expect(detail.proposal.allowedGeneratedPixelCount).toBeGreaterThan(0);
    expect(detail.candidates.length).toBeGreaterThan(0);
    const candidate = detail.candidates[0]!;
    expect(candidate).toMatchObject({
      baseCandidateId: null,
      reviewRequired: true,
      automaticAcceptanceAllowed: false,
    });

    const allowedMask = await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${detail.proposal.id}/allowed-mask.png`,
    });
    expect(allowedMask.statusCode).toBe(200);
    expect(allowedMask.headers["content-type"]).toContain("image/png");
    expect(allowedMask.headers.etag).toBe(`"${detail.proposal.allowedMask.sha256}"`);
    expect(allowedMask.headers["cache-control"]).toContain("immutable");
    expect(sha256Bytes(allowedMask.rawPayload)).toBe(
      detail.proposal.allowedMask.sha256,
    );
    const notModified = await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${detail.proposal.id}/allowed-mask.png`,
      headers: { "if-none-match": `W/"${detail.proposal.allowedMask.sha256}"` },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.rawPayload).toHaveLength(0);

    const candidateAssets = [
      ["candidate.json", candidate.document.sha256, "application/json"],
      ["texture.png", candidate.texture.sha256, "image/png"],
      ["write-mask.png", candidate.writeMask.sha256, "image/png"],
      ["generated-mask.png", candidate.generatedMask.sha256, "image/png"],
    ] as const;
    for (const [fileName, expectedHash, expectedMime] of candidateAssets) {
      const asset = await app.inject({
        method: "GET",
        url: `/api/completion-proposals/${detail.proposal.id}/candidates/${candidate.id}/${fileName}`,
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain(expectedMime);
      expect(asset.headers.etag).toBe(`"${expectedHash}"`);
      expect(asset.headers["cache-control"]).toContain("immutable");
      expect(sha256Bytes(asset.rawPayload)).toBe(expectedHash);
    }

    const mismatchedCandidate = await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/completioncandidate_missing/texture.png`,
    });
    expect(mismatchedCandidate.statusCode).toBe(404);
    expect(mismatchedCandidate.json()).toMatchObject({
      error: { code: "COMPLETION_CANDIDATE_NOT_FOUND" },
    });

    const candidateDocument = (await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${candidate.id}/candidate.json`,
    })).json<{
      assignments: readonly { targetPixelId: number; rgba: readonly number[] }[];
    }>();
    const transparentEdit = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${candidate.id}/edits`,
      payload: {
        expectedSourceResultHash: detail.proposal.sourceResultHash,
        expectedProposalHash: detail.proposal.proposalHash,
        expectedEvidenceHash: detail.proposal.evidenceHash,
        expectedCandidateHash: candidate.candidateHash,
        actorId: "api-reviewer",
        edits: [{
          type: "set_pixel",
          pixelId: candidateDocument.assignments[0]!.targetPixelId,
          rgba: [12, 34, 56, 0],
        }],
      },
    });
    expect(transparentEdit.statusCode).toBe(400);
    expect(transparentEdit.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    const edited = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${candidate.id}/edits`,
      payload: {
        expectedSourceResultHash: detail.proposal.sourceResultHash,
        expectedProposalHash: detail.proposal.proposalHash,
        expectedEvidenceHash: detail.proposal.evidenceHash,
        expectedCandidateHash: candidate.candidateHash,
        actorId: "api-reviewer",
        edits: [{
          type: "set_pixel",
          pixelId: candidateDocument.assignments[0]!.targetPixelId,
          rgba: [12, 34, 56, 128],
        }],
      },
    });
    expect(edited.statusCode).toBe(201);
    const editedBody = edited.json<{
      editedCandidateId: string;
      candidates: readonly {
        id: string;
        baseCandidateId: string | null;
        candidateHash: string;
      }[];
    }>();
    const editedCandidate = editedBody.candidates.find(
      (item) => item.id === editedBody.editedCandidateId,
    )!;
    expect(editedCandidate).toMatchObject({ baseCandidateId: candidate.id });
    const editedReplay = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${candidate.id}/edits`,
      payload: {
        expectedSourceResultHash: detail.proposal.sourceResultHash,
        expectedProposalHash: detail.proposal.proposalHash,
        expectedEvidenceHash: detail.proposal.evidenceHash,
        expectedCandidateHash: candidate.candidateHash,
        actorId: "api-reviewer",
        edits: [{
          type: "set_pixel",
          pixelId: candidateDocument.assignments[0]!.targetPixelId,
          rgba: [12, 34, 56, 128],
        }],
      },
    });
    expect(editedReplay.statusCode).toBe(200);
    expect(editedReplay.json()).toMatchObject({
      changed: false,
      editedCandidateId: editedCandidate.id,
    });

    const acceptPayload = {
      expectedSourceResultHash: detail.proposal.sourceResultHash,
      expectedProposalHash: detail.proposal.proposalHash,
      expectedEvidenceHash: detail.proposal.evidenceHash,
      expectedCandidateHash: editedCandidate.candidateHash,
      actorId: "api-reviewer",
      summary: "接受隐藏内容候选",
    };
    const staleAccept = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${editedCandidate.id}/accept`,
      payload: {
        ...acceptPayload,
        expectedProposalHash: `sha256:${"0".repeat(64)}`,
      },
    });
    expect(staleAccept.statusCode).toBe(409);
    expect(staleAccept.json()).toMatchObject({
      error: { code: "CONFLICT" },
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${editedCandidate.id}/accept`,
      payload: acceptPayload,
    });
    expect(accepted.statusCode).toBe(201);
    const acceptedBody = accepted.json<{
      result: {
        id: string;
        resultHash: string;
        latentPart: { id: string };
      };
    }>();
    expect(acceptedBody).toMatchObject({
      changed: true,
      status: "accepted",
      decision: { action: "accept", candidateId: editedCandidate.id },
      result: {
        representation: "latent_component",
        revision: null,
        latentPart: { id: expect.any(String) },
        publishedAt: null,
      },
    });
    const partsAfterAccept = await app.inject({
      method: "GET",
      url: `/api/parts?projectId=${project.projectId}`,
    });
    expect(partsAfterAccept.statusCode).toBe(200);
    expect(
      partsAfterAccept.json<{ parts: readonly { id: string }[] }>().parts.map(
        (part) => part.id,
      ),
    ).not.toContain(acceptedBody.result.latentPart.id);
    const repeatedAccept = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${editedCandidate.id}/accept`,
      payload: acceptPayload,
    });
    expect(repeatedAccept.statusCode).toBe(200);
    expect(repeatedAccept.json()).toMatchObject({ changed: false });

    const stalePublish = await app.inject({
      method: "POST",
      url: `/api/completion-results/${acceptedBody.result.id}/publish`,
      payload: {
        expectedResultHash: `sha256:${"0".repeat(64)}`,
        expectedPartId: acceptedBody.result.latentPart.id,
      },
    });
    expect(stalePublish.statusCode).toBe(409);
    const published = await app.inject({
      method: "POST",
      url: `/api/completion-results/${acceptedBody.result.id}/publish`,
      payload: {
        expectedResultHash: acceptedBody.result.resultHash,
        expectedPartId: acceptedBody.result.latentPart.id,
        actorId: "api-reviewer",
      },
    });
    expect(published.statusCode).toBe(201);
    expect(published.json()).toMatchObject({
      changed: true,
      result: {
        id: acceptedBody.result.id,
        latentPart: { id: acceptedBody.result.latentPart.id },
        publishedAt: expect.any(String),
      },
    });
    const replayedPublish = await app.inject({
      method: "POST",
      url: `/api/completion-results/${acceptedBody.result.id}/publish`,
      payload: {
        expectedResultHash: acceptedBody.result.resultHash,
        expectedPartId: acceptedBody.result.latentPart.id,
        actorId: "api-reviewer",
      },
    });
    expect(replayedPublish.statusCode).toBe(200);
    expect(replayedPublish.json()).toMatchObject({ changed: false });
    expect((await app.inject({
      method: "GET",
      url: `/api/parts?projectId=${project.projectId}`,
    })).json<{ parts: readonly { id: string }[] }>().parts.map((part) => part.id))
      .toContain(acceptedBody.result.latentPart.id);

    const conflictingReject = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${detail.proposal.id}/reject`,
      payload: {
        expectedSourceResultHash: detail.proposal.sourceResultHash,
        expectedProposalHash: detail.proposal.proposalHash,
        expectedEvidenceHash: detail.proposal.evidenceHash,
      },
    });
    expect(conflictingReject.statusCode).toBe(409);

    const succeededRetry = await app.inject({
      method: "POST",
      url: `/api/ai-jobs/${jobId}/retry`,
      payload: {},
    });
    expect(succeededRetry.statusCode).toBe(409);
    expect(succeededRetry.json()).toMatchObject({
      error: { code: "COMPLETION_RETRY_UNSUPPORTED" },
    });

    const rejectStarted = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceRevisionId}/completion-proposals`,
      payload: {
        targetComponentId: "clothing.completion",
        occludingComponentIds: ["hair.occluder"],
        representation: "auto",
      },
    });
    expect(rejectStarted.statusCode).toBe(202);
    const rejectJobId = rejectStarted.json<{ job: { id: string } }>().job.id;
    expect((await waitForAiJob(app, rejectJobId)).job.status).toBe("succeeded");
    const awaiting = await app.inject({
      method: "GET",
      url: `/api/completion-proposals?revisionId=${sourceRevisionId}&status=awaiting_decision`,
    });
    expect(awaiting.statusCode).toBe(200);
    const rejectProposal = awaiting.json<{
      proposals: readonly {
        proposal: {
          id: string;
          sourceResultHash: string;
          proposalHash: string;
          evidenceHash: string;
        };
      }[];
    }>().proposals[0]!.proposal;
    const rejectDetailResponse = await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${rejectProposal.id}`,
    });
    expect(rejectDetailResponse.statusCode).toBe(200);
    const rejectCandidateId = rejectDetailResponse.json<{
      candidates: readonly { id: string }[];
    }>().candidates[0]!.id;
    const crossProposalAsset = await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${detail.proposal.id}/candidates/${rejectCandidateId}/texture.png`,
    });
    expect(crossProposalAsset.statusCode).toBe(404);
    expect(crossProposalAsset.json()).toMatchObject({
      error: { code: "COMPLETION_CANDIDATE_NOT_FOUND" },
    });
    const rejectPayload = {
      expectedSourceResultHash: rejectProposal.sourceResultHash,
      expectedProposalHash: rejectProposal.proposalHash,
      expectedEvidenceHash: rejectProposal.evidenceHash,
      reason: "保留原始内容",
    };
    const rejected = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${rejectProposal.id}/reject`,
      payload: rejectPayload,
    });
    expect(rejected.statusCode).toBe(201);
    expect(rejected.json()).toMatchObject({
      changed: true,
      status: "rejected",
      decision: { action: "reject", candidateId: null },
      result: null,
    });
    const repeatedReject = await app.inject({
      method: "POST",
      url: `/api/completion-proposals/${rejectProposal.id}/reject`,
      payload: rejectPayload,
    });
    expect(repeatedReject.statusCode).toBe(200);
    expect(repeatedReject.json()).toMatchObject({ changed: false });
  });

  it("enables advisory completion ranking only through server configuration", async () => {
    const provider = new ApiAiProvider("api-completion-ranker");
    vi.stubEnv("AI_COMPLETION_RANKING", "true");
    vi.stubEnv("AI_COMPLETION_RANKING_PROVIDER", provider.providerName);
    vi.stubEnv("AI_COMPLETION_RANKING_MODEL", "api-ranking-model");
    vi.stubEnv("AI_COMPLETION_RANKING_REASONING_EFFORT", "high");
    const { app } = await createApi([provider]);
    const { sourceRevisionId } = await createCompletionApiFixture(
      app,
      "Ranked completion API",
    );

    const started = await app.inject({
      method: "POST",
      url: `/api/revisions/${sourceRevisionId}/completion-proposals`,
      payload: {
        targetComponentId: "clothing.completion",
        occludingComponentIds: ["hair.occluder"],
        representation: "latent_component",
      },
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json<{ job: { id: string } }>().job.id;
    const finished = await waitForAiJob(app, jobId);
    expect(finished.job).toMatchObject({
      status: "succeeded",
      provider: provider.providerName,
      model: "api-ranking-model",
      resultRevisionId: null,
      options: { rankingMode: "ai", reasoningEffort: "high" },
    });
    expect(finished.runs).toHaveLength(1);
    expect(finished.runs[0]).toMatchObject({ status: "succeeded" });
    expect(provider.rankingCalls).toBe(1);

    const listed = await app.inject({
      method: "GET",
      url: `/api/completion-proposals?jobId=${jobId}`,
    });
    expect(listed.statusCode).toBe(200);
    const proposal = listed.json<{
      proposals: readonly {
        readonly proposal: { readonly id: string };
      }[];
    }>().proposals[0]!;
    const detail = await app.inject({
      method: "GET",
      url: `/api/completion-proposals/${proposal.proposal.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      status: "awaiting_decision",
      decision: null,
      result: null,
      ranking: {
        provider: provider.providerName,
        model: "api-ranking-model",
        reasoningEffort: "high",
        document: {
          jobId,
          proposalId: proposal.proposal.id,
          recommendation: { status: "recommend" },
        },
      },
    });
  });

  it("validates and completes advisory-only AI restoration recommendations", async () => {
    const provider = new ApiAiProvider("restoration-provider");
    const { app } = await createApi([provider]);
    const project = await createProject(app, "AI restoration API");
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
          instanceId: "clothing.ai-replacement",
          displayName: "AI 待替换衣服",
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
      payload: {
        baseRevisionId,
        name: "AI restoration recommendation",
      },
    });
    expect(created.statusCode).toBe(201);
    const compositionId = created.json<{
      composition: {
        id: string;
        restorationVersion: number;
        restorationPlan: null;
      };
    }>().composition.id;
    const generationInput = {
      targetComponentIds: ["clothing.ai-replacement"],
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
      base: { candidates: readonly { id: string }[] };
    }>();
    expect(candidates.base.candidates.length).toBeGreaterThan(0);

    const providers = await app.inject({
      method: "GET",
      url: "/api/ai/providers",
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toMatchObject({
      restorationRecommendationProviders: ["restoration-provider"],
    });

    const recommendationInput = {
      provider: "restoration-provider",
      model: "restoration-model",
      reasoningEffort: "medium",
      userIntent: "优先采用完整候选，保留现有整体风格",
      compositionVersion: candidates.version,
      candidateSetHash: candidates.candidateSetHash,
      ...generationInput,
    } as const;
    const invalid = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/ai-restoration-recommendation`,
      payload: { ...recommendationInput, rawMask: [1, 2, 3] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const staleHash = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/ai-restoration-recommendation`,
      payload: {
        ...recommendationInput,
        candidateSetHash: `sha256:${"a".repeat(64)}`,
      },
    });
    expect(staleHash.statusCode).toBe(409);
    expect(staleHash.json()).toMatchObject({
      error: { code: "AI_RESTORATION_STALE" },
    });

    const revisionsBefore = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}/revisions`,
    });
    const revisionCountBefore = revisionsBefore.json<{
      revisions: readonly unknown[];
    }>().revisions.length;
    const before = await app.inject({
      method: "GET",
      url: `/api/compositions/${compositionId}`,
    });
    expect(before.json()).toMatchObject({
      composition: {
        restorationVersion: candidates.version,
        restorationPlan: null,
      },
      report: {
        restorationPixelCount: 0,
        restorationMissingPixelCount: 0,
      },
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/compositions/${compositionId}/ai-restoration-recommendation`,
      payload: recommendationInput,
    });
    expect(started.statusCode, JSON.stringify(started.json())).toBe(202);
    const jobId = started.json<{ job: { id: string } }>().job.id;
    const completed = await waitForAiJob(app, jobId);
    expect(completed.job).toMatchObject({
      kind: "restoration_recommendation",
      status: "succeeded",
      compositionId,
      resultRevisionId: null,
      proposalSummary: "已生成换装候选建议",
      advisoryResult: {
        schemaVersion: "1.0",
        jobId,
        compositionId,
        candidateSetHash: candidates.candidateSetHash,
        decisions: [
          {
            targetGroupId: expect.any(String),
            selectedCandidateId: expect.any(String),
            rankedCandidateIds: expect.arrayContaining(
              candidates.base.candidates.map((candidate) => candidate.id),
            ),
            confidence: 0.9,
          },
        ],
      },
    });
    expect(completed.runs).toHaveLength(1);
    expect(completed.runs[0]).toMatchObject({
      status: "succeeded",
      assets: [{}, {}, {}, {}, {}],
    });
    expect(completed.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "provider_session",
        "provider_output",
        "validating",
        "succeeded",
      ]),
    );

    const visibleEvents = await app.inject({
      method: "GET",
      url: `/api/ai-jobs/${jobId}/events`,
    });
    expect(visibleEvents.statusCode).toBe(200);
    expect(
      visibleEvents
        .json<{ events: readonly { eventType: string }[] }>()
        .events.map((event) => event.eventType),
    ).toEqual(expect.arrayContaining(["provider_session", "succeeded"]));
    const listed = await app.inject({
      method: "GET",
      url: `/api/ai-jobs?kind=restoration_recommendation&compositionId=${compositionId}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      jobs: [{ id: jobId, kind: "restoration_recommendation", compositionId }],
    });

    const after = await app.inject({
      method: "GET",
      url: `/api/compositions/${compositionId}`,
    });
    expect(after.json()).toMatchObject({
      composition: {
        restorationVersion: candidates.version,
        restorationPlan: null,
      },
      report: {
        restorationPixelCount: 0,
        restorationMissingPixelCount: 0,
      },
    });
    const revisionsAfter = await app.inject({
      method: "GET",
      url: `/api/projects/${project.projectId}/revisions`,
    });
    expect(
      revisionsAfter.json<{ revisions: readonly unknown[] }>().revisions,
    ).toHaveLength(revisionCountBefore);
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
  readonly generatedComponentId?: string;
  readonly revision: {
    readonly id: string;
    readonly parentRevisionId: string | null;
    readonly operationType: string;
    readonly sequence: number;
  };
}

async function createApi(aiProviders?: readonly SkinSemanticAiProvider[]) {
  const directory = await mkdtemp(join(tmpdir(), "mcskinsplit-api-"));
  const store = new RevisionStore({ dataDirectory: directory });
  const app = buildApi({
    dataDirectory: directory,
    revisionStore: store,
    ...(aiProviders ? { aiProviders } : {}),
  });
  resources.push({ app, directory, store });
  return { app, directory, store };
}

interface AiJobApiDetail {
  readonly job: {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly resultRevisionId: string | null;
    readonly compositionId: string | null;
    readonly retryOfJobId: string | null;
    readonly provider: string;
    readonly model: string;
    readonly proposalSummary: string | null;
    readonly advisoryResult: ReplacementPlanProposal | null;
    readonly options: {
      readonly semanticBaseline?: "empty" | "current";
      readonly rankingMode?: "host_only" | "ai";
      readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  };
  readonly runs: readonly {
    readonly status: string;
    readonly assets: readonly unknown[];
  }[];
  readonly events: readonly { readonly eventType: string }[];
  readonly semanticFollowup: {
    readonly status: string;
    readonly suggestions: readonly unknown[];
    readonly appliedRevisionId: string | null;
  } | null;
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
  rankingCalls = 0;

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

  async recommendReplacement(
    input: ProviderReplacementInput,
  ): Promise<ProviderReplacementResult> {
    input.onProgress?.({
      kind: "session",
      status: "started",
      message: "换装建议会话已建立",
    });
    const candidates = input.pack.candidateCatalog.base.candidates;
    const groups = new Map<
      string,
      Array<(typeof candidates)[number]>
    >();
    for (const candidate of candidates) {
      const group = groups.get(candidate.targetGroupId) ?? [];
      group.push(candidate);
      groups.set(candidate.targetGroupId, group);
    }
    const decisions = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([targetGroupId, groupCandidates]) => {
        const ranked = [...groupCandidates].sort((left, right) => {
          const coverageOrder =
            Number(right.coveragePixelCount === right.pixelCount) -
            Number(left.coveragePixelCount === left.pixelCount);
          return coverageOrder || left.id.localeCompare(right.id);
        });
        const selected = ranked.find(
          (candidate) =>
            candidate.coveragePixelCount === candidate.pixelCount,
        );
        return {
          targetGroupId,
          selectedCandidateId: selected?.id ?? null,
          rankedCandidateIds: ranked.map((candidate) => candidate.id),
          confidence: 0.9,
          explanation: "完整候选优先，且符合用户意图",
        };
      });
    const proposal: ReplacementPlanProposal = {
      schemaVersion: "1.0",
      jobId: input.jobId,
      compositionId: input.pack.candidateCatalog.compositionId,
      candidateSetHash: input.pack.candidateCatalog.candidateSetHash,
      decisions,
      summary: "已生成换装候选建议",
    };
    input.onProgress?.({
      kind: "output",
      status: "completed",
      message: "换装候选建议已生成",
    });
    return {
      proposal,
      rawEvents: `${JSON.stringify({ type: "thread.started", thread_id: `${this.providerName}-replacement-thread` })}\n`,
      stderr: "",
      threadId: `${this.providerName}-replacement-thread`,
      usage: { input_tokens: 16, output_tokens: 8 },
    };
  }

  async rankCompletion(
    input: ProviderCompletionRankingInput,
  ): Promise<ProviderCompletionRankingResult> {
    this.rankingCalls += 1;
    const proposal = apiCompletionRankingProposal(input);
    return {
      proposal,
      rawEvents:
        `${JSON.stringify({ type: "thread.started", thread_id: `${this.providerName}-completion-thread` })}\n`,
      stderr: "",
      threadId: `${this.providerName}-completion-thread`,
      usage: { input_tokens: 18, output_tokens: 9 },
    };
  }
}

function apiProposal(input: ProviderAnalysisInput): AnalysisProposal {
  const regions = input.pack.candidateRegions.regions;
  return {
    schemaVersion: "1.2",
    sourceRevisionId: input.pack.job.sourceRevisionId,
    modelAssessment: {
      armType: input.pack.job.armType,
      confidence: 0.95,
    },
    appearanceInventory: {
      observations: [],
      summary: "API 测试未记录额外外观观察。",
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

function apiCompletionRankingProposal(
  input: ProviderCompletionRankingInput,
): CompletionRankingProposal {
  const candidateIds = input.pack.evidence.candidates.map(
    ({ candidateId }) => candidateId,
  );
  return {
    schemaVersion: "1.0",
    jobId: input.jobId,
    proposalId: input.pack.evidence.proposalId,
    proposalHash: input.pack.evidence.proposalHash,
    sourceRevisionId: input.pack.evidence.sourceRevisionId,
    sourceResultHash: input.pack.evidence.sourceResultHash,
    sourceSkinHash: input.pack.evidence.sourceSkinHash,
    rankings: candidateIds.map((candidateId) => ({
      candidateId,
      confidence: 0.8,
      explanation: "Visible continuity supports this ordering.",
    })),
    recommendation: candidateIds[0]
      ? {
          status: "recommend",
          candidateId: candidateIds[0],
          confidence: 0.8,
          explanation: "The strongest visible continuity evidence is ranked first.",
        }
      : {
          status: "defer",
          candidateId: null,
          confidence: 0.2,
          explanation: "There is not enough visible continuity evidence to recommend one.",
        },
  };
}

async function createCompletionApiFixture(
  app: FastifyInstance,
  name: string,
): Promise<{ readonly sourceRevisionId: string }> {
  const project = await createProject(app, name);
  const imported = await importSkin(app, project.projectId);
  const target = await app.inject({
    method: "POST",
    url: `/api/revisions/${imported.revisionId}/operations`,
    payload: {
      type: "assign_pixels",
      target: {
        instanceId: "clothing.completion",
        displayName: "Completion clothing",
        category: "upper_clothing",
      },
      spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
    },
  });
  expect(target.statusCode).toBe(201);
  const occluder = await app.inject({
    method: "POST",
    url: `/api/revisions/${target.json<MutationResponse>().revision.id}/operations`,
    payload: {
      type: "assign_pixels",
      target: {
        instanceId: "hair.occluder",
        displayName: "Completion occluder",
        category: "hair",
      },
      spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
    },
  });
  expect(occluder.statusCode).toBe(201);
  return {
    sourceRevisionId: occluder.json<MutationResponse>().revision.id,
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
