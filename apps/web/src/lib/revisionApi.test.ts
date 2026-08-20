import { describe, expect, it, vi } from "vitest";
import type {
  ApiCompletionCandidate,
  ApiCompletionProposal,
  ApiCompletionResult,
  ApiPart,
} from "./revisionApi";
import {
  acceptCompletionCandidate,
  addCompositionPart,
  applyCompositionBundle,
  applyPartEditOperation,
  applySemanticOperation,
  applySemanticFollowup,
  archiveAnalyzedSkin,
  commitComposition,
  clearCompositionRestorationPlan,
  commitRevisionPart,
  compositionPreviewUrl,
  completionAllowedMaskUrl,
  completionCandidateDocumentUrl,
  completionCandidateGeneratedMaskUrl,
  completionCandidateTextureUrl,
  completionCandidateWriteMaskUrl,
  commitPartEdit,
  createComposition,
  dismissSemanticFollowup,
  editCompletionCandidate,
  createPartEdit,
  exportRevisionPart,
  exportRevisionBundle,
  generateCompositionRestorationCandidates,
  getAnalyzedSkin,
  importProjectSkin,
  listAnalyzedSkins,
  listAiJobs,
  listAiProviders,
  listCompletionProposals,
  listPartBundles,
  listParts,
  loadRevisionOrigin,
  loadCompletionCandidateDocument,
  loadRevisionSegmentation,
  loadRevisionSkin,
  partMannequinUrl,
  partTextureUrl,
  partEditMannequinUrl,
  partEditTextureUrl,
  partEditWriteMaskUrl,
  partBundleMannequinUrl,
  partBundlePreviewUrl,
  retirePart,
  restorePart,
  retirePartBundle,
  restoreAnalyzedSkin,
  restorePartBundle,
  rejectCompletionProposal,
  publishCompletionResult,
  revisionSkinUrl,
  revisePartBundle,
  retryAiJob,
  removeCompositionLayer,
  reorderCompositionLayers,
  resolveCompositionConflicts,
  setCompositionRestorationPlan,
  startAiRestorationRecommendation,
  RevisionApiError,
  startAiAnalysis,
  startCompletionProposal,
} from "./revisionApi";

describe("revisionApi", () => {
  it("encodes reusable-library discovery and lifecycle requests", async () => {
    const part = { id: "part / 1" };
    const bundle = { id: "bundle / 1" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ parts: [part] }, 200))
      .mockResolvedValueOnce(jsonResponse({ bundles: [bundle] }, 200))
      .mockResolvedValueOnce(jsonResponse({ part }, 200))
      .mockResolvedValueOnce(jsonResponse({ part }, 200))
      .mockResolvedValueOnce(jsonResponse({ bundle }, 200))
      .mockResolvedValueOnce(jsonResponse({ bundle }, 200))
      .mockResolvedValueOnce(jsonResponse({ bundle, retiredBundle: bundle }, 201));

    await listParts({
      category: "hair",
      status: "all",
      projectId: "project / 1",
      sourceRevisionId: "revision / 2",
      query: "brown hair",
    }, fetcher);
    await listPartBundles({
      kind: "hair",
      status: "retired",
      projectId: "project / 1",
      sourceRevisionId: "revision / 2",
      query: "brown hair",
    }, fetcher);
    await retirePart("part / 1", "wrong eyes", fetcher);
    await restorePart("part / 1", fetcher);
    await retirePartBundle("bundle / 1", "superseded", fetcher);
    await restorePartBundle("bundle / 1", fetcher);
    await revisePartBundle("bundle / 1", {
      name: "Brown hair v2",
      replacements: [{ memberPartId: "part / 1", replacementPartId: "part / 2" }],
      reason: "fixed eyes",
    }, fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/parts?category=hair&status=all&projectId=project+%2F+1&sourceRevisionId=revision+%2F+2&q=brown+hair",
      "/api/part-bundles?kind=hair&status=retired&projectId=project+%2F+1&sourceRevisionId=revision+%2F+2&q=brown+hair",
      "/api/parts/part%20%2F%201/retire",
      "/api/parts/part%20%2F%201/restore",
      "/api/part-bundles/bundle%20%2F%201/retire",
      "/api/part-bundles/bundle%20%2F%201/restore",
      "/api/part-bundles/bundle%20%2F%201/revise",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ reason: "wrong eyes" });
    expect(JSON.parse(String(fetcher.mock.calls[6]?.[1]?.body))).toEqual({
      name: "Brown hair v2",
      replacements: [{ memberPartId: "part / 1", replacementPartId: "part / 2" }],
      reason: "fixed eyes",
    });
  });

  it("preserves recommendation-capable providers separately from semantic providers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        providers: ["semantic-provider", "restoration-provider"],
        restorationRecommendationProviders: ["restoration-provider"],
        defaultModel: "codex-config-default",
        defaultReasoningEffort: "medium",
      }, 200),
    );

    await expect(listAiProviders(fetcher)).resolves.toMatchObject({
      providers: ["semantic-provider", "restoration-provider"],
      restorationRecommendationProviders: ["restoration-provider"],
    });
  });

  it("uploads PNG bytes with encoded import metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          projectId: "project_1",
          branchId: "branch_1",
          revisionId: "revision_1",
          armType: "slim",
          warnings: [],
        },
        201,
      ),
    );
    const bytes = Uint8Array.from([137, 80, 78, 71]);

    const result = await importProjectSkin(
      "project / 1",
      bytes,
      { fileName: "猫 skin.png", armType: "slim" },
      fetcher,
    );

    expect(result.revisionId).toBe("revision_1");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "/api/projects/project%20%2F%201/import?fileName=%E7%8C%AB+skin.png&armType=slim",
    );
    expect(init?.headers).toEqual({ "content-type": "image/png" });
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(bytes);
  });

  it("loads only image/png revision responses", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(bytes, { headers: { "content-type": "image/png" } }),
      );

    await expect(loadRevisionSkin("rev / 1", fetcher)).resolves.toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith("/api/revisions/rev%20%2F%201/skin.png");
  });

  it("loads the stored arm model from revision segmentation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          segmentation: {
            schemaVersion: "1.0",
            revisionId: "rev_wide",
            source: {
              width: 64,
              height: 64,
              armType: "wide",
              coordinateOrigin: "top-left",
              sourceHash: `sha256:${"a".repeat(64)}`,
            },
          },
        },
        200,
      ),
    );

    await expect(loadRevisionSegmentation("rev_wide", fetcher)).resolves.toMatchObject(
      { source: { armType: "wide" } },
    );
  });

  it("loads a revision pixel-origin document from the encoded endpoint", async () => {
    const recorded = {
      availability: "recorded" as const,
      revisionId: "rev_origin",
      originAssetId: "asset_origin",
      document: {
        schemaVersion: "1.0" as const,
        subject: { kind: "revision" as const, id: "rev_origin" },
        source: {
          width: 64 as const,
          height: 64 as const,
          armType: "wide" as const,
          coordinateOrigin: "top-left" as const,
        },
        entries: [],
        copyLineage: [],
      },
      summary: {
        counts: {
          source_visible: 0,
          manual_authored: 0,
          generated_completion: 0,
          legacy_mixed: 0,
        },
        containsGeneratedPixels: false,
      },
      componentSummaries: {},
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ origin: recorded }, 200),
    );

    await expect(loadRevisionOrigin("rev / origin", fetcher)).resolves.toEqual(
      recorded,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/revisions/rev%20%2F%20origin/origin",
      undefined,
    );
  });

  it("preserves structured API errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { code: "SNAPSHOT_CORRUPT", message: "snapshot failed" } },
        409,
      ),
    );

    const error = await loadRevisionSkin("rev_1", fetcher).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RevisionApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "SNAPSHOT_CORRUPT",
      message: "snapshot failed",
    });
  });

  it("serializes semantic operations and encoded component routes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ revision: { id: "rev_2" } }, 201))
      .mockResolvedValueOnce(
        jsonResponse({ part: { id: "part_1", name: "Hair" } }, 201),
      );

    await applySemanticOperation(
      "rev / 1",
      {
        type: "assign_pixels",
        target: {
          instanceId: "hair.main",
          displayName: "Hair",
          category: "hair",
        },
        spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 9 }],
      },
      { summary: "Assign hair" },
      fetcher,
    );
    await exportRevisionPart("rev / 2", "hair/main", undefined, fetcher);

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/revisions/rev%20%2F%201/operations",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: "assign_pixels",
      summary: "Assign hair",
      target: { instanceId: "hair.main" },
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/revisions/rev%20%2F%202/components/hair%2Fmain/export-part",
    );
    expect(partMannequinUrl("part / 1", "slim")).toBe(
      "/api/parts/part%20%2F%201/mannequin.png?armType=slim",
    );
    expect(partTextureUrl("part / 1")).toBe(
      "/api/parts/part%20%2F%201/texture.png",
    );
  });

  it("lets the Revision Host generate new component IDs at the public boundary", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        project: { id: "project_1" },
        branch: { id: "branch_1" },
        revision: { id: "revision_2" },
        generatedComponentId: "component_host_1",
      }, 201),
    );

    const result = await applySemanticOperation("revision_1", {
      type: "assign_pixels",
      target: {
        displayName: "上衣",
        category: "upper_clothing",
      },
      spans: [{ surface: "torso.base.front", y: 20, x0: 20, x1: 21 }],
    }, { branchId: "branch_1" }, fetcher);

    expect(result.generatedComponentId).toBe("component_host_1");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      type: "assign_pixels",
      target: {
        displayName: "上衣",
        category: "upper_clothing",
      },
      spans: [{ surface: "torso.base.front", y: 20, x0: 20, x1: 21 }],
      branchId: "branch_1",
    });
  });

  it("sends all component relations in one Revision operation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        project: { id: "project_1" },
        branch: { id: "branch_1" },
        revision: { id: "revision_2" },
      }, 201),
    );

    await applySemanticOperation("revision_1", {
      type: "set_component_relations",
      componentId: "shirt.main",
      relations: {
        attachedTo: "torso.base",
        pairedWith: ["sleeve.left", "sleeve.right"],
        sameOutfitGroup: "school_uniform",
        conflictsWith: ["jacket.main"],
      },
    }, { branchId: "branch_1", summary: "Update component relations" }, fetcher);

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      type: "set_component_relations",
      componentId: "shirt.main",
      relations: {
        attachedTo: "torso.base",
        pairedWith: ["sleeve.left", "sleeve.right"],
        sameOutfitGroup: "school_uniform",
        conflictsWith: ["jacket.main"],
      },
      branchId: "branch_1",
      summary: "Update component relations",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("commits a part only with an explicit strategy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          committed: true,
          revision: { id: "rev_2" },
          part: { id: "part_1" },
          report: { hardConflictCount: 2 },
        },
        201,
      ),
    );

    await commitRevisionPart("rev_1", "part_1", "use_part", fetcher);

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      partId: "part_1",
      strategy: "use_part",
    });
  });

  it("serializes immutable part repair routes and explicit head revisions", async () => {
    const partEdit = {
      project: { id: "edit / 1", headRevisionId: "edit_rev_1" },
      headRevision: { id: "edit_rev_1", sequence: 1 },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ partEdit }, 201))
      .mockResolvedValueOnce(jsonResponse({ partEdit }, 201))
      .mockResolvedValueOnce(
        jsonResponse({ partEdit, part: { id: "part_repaired" } }, 201),
      );

    await createPartEdit({ basePartId: "part / 1", name: "Repair" }, fetcher);
    await applyPartEditOperation(
      "edit / 1",
      {
        headRevisionId: "edit_rev_1",
        operation: {
          type: "paint_color",
          spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
          rgba: [210, 160, 120, 255],
        },
      },
      fetcher,
    );
    await commitPartEdit(
      "edit / 1",
      { headRevisionId: "edit_rev_2", name: "Repaired" },
      fetcher,
    );

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/part-edits",
      "/api/part-edits/edit%20%2F%201/operations",
      "/api/part-edits/edit%20%2F%201/commit",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      headRevisionId: "edit_rev_1",
      operation: { type: "paint_color", rgba: [210, 160, 120, 255] },
    });
    expect(partEditTextureUrl("rev / 2")).toBe(
      "/api/part-edit-revisions/rev%20%2F%202/texture.png",
    );
    expect(partEditWriteMaskUrl("rev / 2")).toBe(
      "/api/part-edit-revisions/rev%20%2F%202/write-mask.png",
    );
    expect(partEditMannequinUrl("rev / 2", "slim")).toBe(
      "/api/part-edit-revisions/rev%20%2F%202/mannequin.png?armType=slim",
    );
  });

  it("serializes the complete composition workflow with encoded ids", async () => {
    const detail = {
      composition: { id: "composition_1", status: "draft" },
      layers: [],
      report: { committable: false },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(detail, 201))
      .mockResolvedValueOnce(jsonResponse(detail, 201))
      .mockResolvedValueOnce(jsonResponse(detail, 200))
      .mockResolvedValueOnce(jsonResponse(detail, 200))
      .mockResolvedValueOnce(jsonResponse(detail, 200))
      .mockResolvedValueOnce(
        jsonResponse(
          { ...detail, revision: { id: "rev_2", operationType: "compose" } },
          201,
        ),
      );

    await createComposition("rev / 1", "Real mix", fetcher);
    await addCompositionPart("composition / 1", "part / 1", 0, fetcher);
    await reorderCompositionLayers(
      "composition / 1",
      ["layer / 2", "layer / 1"],
      fetcher,
    );
    await resolveCompositionConflicts(
      "composition / 1",
      { strategy: "layer_order" },
      fetcher,
    );
    await removeCompositionLayer("composition / 1", "layer / 2", fetcher);
    await commitComposition("composition / 1", "Commit mix", fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/compositions",
      "/api/compositions/composition%20%2F%201/apply-part",
      "/api/compositions/composition%20%2F%201/reorder",
      "/api/compositions/composition%20%2F%201/resolve-conflict",
      "/api/compositions/composition%20%2F%201/layers/layer%20%2F%202",
      "/api/compositions/composition%20%2F%201/commit",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      baseRevisionId: "rev / 1",
      name: "Real mix",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      partId: "part / 1",
      position: 0,
    });
    expect(fetcher.mock.calls[4]?.[1]?.method).toBe("DELETE");
    expect(compositionPreviewUrl("composition / 1", "2026-08-11T00:00:00Z")).toBe(
      "/api/compositions/composition%20%2F%201/preview.png?v=2026-08-11T00%3A00%3A00Z",
    );
  });

  it("uses candidate IDs only and repeats trusted generation inputs when setting restoration", async () => {
    const candidates = {
      compositionId: "composition / 1",
      version: 4,
      candidateSetHash: `sha256:${"a".repeat(64)}`,
      targetComponentIds: ["shirt/main"],
      outer: { pixelCount: 12, candidateId: "candidate.outer" },
      base: { pixelCount: 8, coveredPixelCount: 8, missingPixelCount: 0, candidates: [] },
    };
    const detail = {
      composition: { id: "composition / 1", status: "draft" },
      layers: [],
      report: { committable: true },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(candidates, 200))
      .mockResolvedValueOnce(jsonResponse(detail, 200))
      .mockResolvedValueOnce(jsonResponse(detail, 200));

    const input = {
      targetComponentIds: ["shirt/main"],
      donorRevisionId: "revision / donor",
      manualRgba: [220, 169, 140, 255] as [number, number, number, number],
    };
    await generateCompositionRestorationCandidates("composition / 1", input, fetcher);
    await setCompositionRestorationPlan(
      "composition / 1",
      {
        ...input,
        expectedVersion: 4,
        candidateSetHash: candidates.candidateSetHash,
        candidateIds: ["candidate.outer", "candidate.manual"],
      },
      fetcher,
    );
    await clearCompositionRestorationPlan("composition / 1", 5, fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/compositions/composition%20%2F%201/restoration-candidates",
      "/api/compositions/composition%20%2F%201/restoration-plan",
      "/api/compositions/composition%20%2F%201/restoration-plan",
    ]);
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual([
      "POST",
      "PUT",
      "DELETE",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      targetComponentIds: ["shirt/main"],
      donorRevisionId: "revision / donor",
      manualRgba: [220, 169, 140, 255],
      expectedVersion: 4,
      candidateSetHash: candidates.candidateSetHash,
      candidateIds: ["candidate.outer", "candidate.manual"],
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      expectedVersion: 5,
    });
  });

  it("loads analyzed skins and persists aggregate bundles without flattening members", async () => {
    const analyzedSkin = {
      project: { id: "project_1", name: "Red skin" },
      revision: { id: "rev / 2", branchName: "main", sequence: 2 },
      groups: [
        {
          key: "clothing:outfit-a",
          sourceGroupKey: "outfit-a",
          kind: "clothing",
          componentIds: ["shirt/main", "shoe/main"],
        },
      ],
    };
    const bundle = {
      id: "bundle / 1",
      name: "完整服装",
      kind: "clothing",
      members: [{ partId: "part_1", position: 0 }],
    };
    const detail = {
      composition: { id: "composition_1", status: "draft" },
      layers: [{ partId: "part_1" }],
      report: { committable: false },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ analyzedSkins: [analyzedSkin] }, 200))
      .mockResolvedValueOnce(jsonResponse({ analyzedSkin }, 200))
      .mockResolvedValueOnce(jsonResponse({ bundle }, 201))
      .mockResolvedValueOnce(jsonResponse({ bundles: [bundle] }, 200))
      .mockResolvedValueOnce(jsonResponse(detail, 201));

    await listAnalyzedSkins(
      { projectId: "project / 1", kind: "clothing", query: "red skin" },
      fetcher,
    );
    await getAnalyzedSkin("rev / 2", fetcher);
    await exportRevisionBundle(
      "rev / 2",
      {
        name: "完整服装",
        kind: "clothing",
        componentIds: ["shirt/main", "shoe/main"],
        sourceGroupKey: "clothing:outfit-a",
      },
      fetcher,
    );
    await listPartBundles(
      { kind: "clothing", sourceRevisionId: "rev / 2" },
      fetcher,
    );
    await applyCompositionBundle(
      "composition / 1",
      "bundle / 1",
      2,
      fetcher,
    );

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/analyzed-skins?projectId=project+%2F+1&kind=clothing&q=red+skin",
      "/api/analyzed-skins/rev%20%2F%202",
      "/api/revisions/rev%20%2F%202/export-bundle",
      "/api/part-bundles?kind=clothing&sourceRevisionId=rev+%2F+2",
      "/api/compositions/composition%20%2F%201/apply-bundle",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      name: "完整服装",
      kind: "clothing",
      componentIds: ["shirt/main", "shoe/main"],
      sourceGroupKey: "clothing:outfit-a",
    });
    expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toEqual({
      bundleId: "bundle / 1",
      position: 2,
    });
    expect(partBundlePreviewUrl("bundle / 1")).toBe(
      "/api/part-bundles/bundle%20%2F%201/preview.png",
    );
    expect(partBundleMannequinUrl("bundle / 1", "slim")).toBe(
      "/api/part-bundles/bundle%20%2F%201/mannequin.png?armType=slim",
    );
  });

  it("serializes analyzed-catalog status filters and reversible archive requests", async () => {
    const analyzedSkin = {
      revision: { id: "revision / 2" },
      catalogStatus: "archived",
      archivedAt: "2026-08-14T09:30:00.000Z",
      archivedReason: "重复分析",
    };
    const restoredSkin = {
      ...analyzedSkin,
      catalogStatus: "active",
      archivedAt: null,
      archivedReason: null,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ analyzedSkins: [analyzedSkin] }, 200))
      .mockResolvedValueOnce(jsonResponse({ analyzedSkin }, 200))
      .mockResolvedValueOnce(jsonResponse({ analyzedSkin: restoredSkin }, 200));

    await listAnalyzedSkins({
      projectId: "project / 1",
      kind: "hair",
      status: "archived",
      query: "red skin",
    }, fetcher);
    await archiveAnalyzedSkin("revision / 2", "  重复分析  ", fetcher);
    await restoreAnalyzedSkin("revision / 2", fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/analyzed-skins?projectId=project+%2F+1&kind=hair&status=archived&q=red+skin",
      "/api/analyzed-skins/revision%20%2F%202/archive",
      "/api/analyzed-skins/revision%20%2F%202/restore",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      reason: "重复分析",
    });
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe("{}");
  });

  it("starts, lists, and retries AI jobs with explicit provider options", async () => {
    const job = {
      id: "job_1",
      status: "queued",
      provider: "codex-exec",
      model: "codex-config-default",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ job }, 202))
      .mockResolvedValueOnce(jsonResponse({ jobs: [job] }, 200))
      .mockResolvedValueOnce(jsonResponse({ job: { ...job, id: "job_2" } }, 202));

    await startAiAnalysis(
      "rev / 1",
      {
        mode: "full",
        provider: "codex-exec",
        model: "codex-config-default",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair", "shoe"],
        createRevisionOnSuccess: true,
        semanticBaseline: "empty",
      },
      fetcher,
    );
    await listAiJobs("rev / 1", fetcher);
    await retryAiJob(
      "job / 1",
      {
        provider: "codex-exec",
        model: "gpt-5.6",
        reasoningEffort: "high",
        createRevisionOnSuccess: false,
        semanticBaseline: "current",
      },
      fetcher,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/revisions/rev%20%2F%201/ai-analysis",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      provider: "codex-exec",
      focus: ["hair", "shoe"],
      createRevisionOnSuccess: true,
      semanticBaseline: "empty",
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/ai-jobs?revisionId=rev%20%2F%201",
    );
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "/api/ai-jobs/job%20%2F%201/retry",
    );
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      provider: "codex-exec",
      model: "gpt-5.6",
      reasoningEffort: "high",
      createRevisionOnSuccess: false,
      semanticBaseline: "current",
    });
  });

  it("applies or dismisses only persisted semantic followup suggestion ids", async () => {
    const detail = { job: { id: "job / 1" }, runs: [], events: [], semanticFollowup: null };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(detail, 200))
      .mockResolvedValueOnce(jsonResponse(detail, 200));

    await applySemanticFollowup("job / 1", "suggestion / 2", fetcher);
    await dismissSemanticFollowup("job / 1", fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/ai-jobs/job%20%2F%201/semantic-followup/apply",
      "/api/ai-jobs/job%20%2F%201/semantic-followup/dismiss",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      suggestionId: "suggestion / 2",
    });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe("{}");
  });

  it("starts and filters restoration recommendation jobs without exposing pixel operations", async () => {
    const job = {
      id: "job_1",
      kind: "restoration_recommendation",
      status: "queued",
      compositionId: "composition / 1",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ job }, 202))
      .mockResolvedValueOnce(jsonResponse({ jobs: [job] }, 200));
    const input = {
      provider: "codex-exec",
      model: "codex-config-default",
      reasoningEffort: "high" as const,
      userIntent: "优先使用完整覆盖的候选",
      compositionVersion: 4,
      candidateSetHash: `sha256:${"a".repeat(64)}`,
      targetComponentIds: ["shirt.main"],
      donorRevisionId: "revision / donor",
      manualRgba: [220, 169, 140, 255] as [number, number, number, number],
    };

    await startAiRestorationRecommendation("composition / 1", input, fetcher);
    await listAiJobs(
      {
        kind: "restoration_recommendation",
        compositionId: "composition / 1",
      },
      fetcher,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/compositions/composition%20%2F%201/ai-restoration-recommendation",
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual(input);
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("compositionId");
    expect(JSON.stringify(body)).not.toMatch(/mask|pixelIds|operations/);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/ai-jobs?kind=restoration_recommendation&compositionId=composition%20%2F%201",
    );
  });

  it("starts and filters Completion proposals with encoded M19 routes", async () => {
    const job = { id: "job_1", kind: "completion_proposal", status: "queued" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ job }, 202))
      .mockResolvedValueOnce(jsonResponse({ proposals: [] }, 200));

    await startCompletionProposal("revision / 1", {
      targetComponentId: "shirt / main",
      occludingComponentIds: ["hair / main", "hat.main"],
      representation: "auto",
    }, fetcher);
    await listCompletionProposals({
      projectId: "project / 1",
      revisionId: "revision / 1",
      jobId: "job / 1",
      representation: "skin_texel",
      status: "all",
    }, fetcher);

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/revisions/revision%20%2F%201/completion-proposals",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      targetComponentId: "shirt / main",
      occludingComponentIds: ["hair / main", "hat.main"],
      representation: "auto",
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/completion-proposals?projectId=project+%2F+1&revisionId=revision+%2F+1&jobId=job+%2F+1&representation=skin_texel&status=all",
    );
  });

  it("keeps Completion texture and both mask asset URLs unambiguous", () => {
    expect(revisionSkinUrl("revision / 1")).toBe(
      "/api/revisions/revision%20%2F%201/skin.png",
    );
    expect(completionAllowedMaskUrl("proposal / 1")).toBe(
      "/api/completion-proposals/proposal%20%2F%201/allowed-mask.png",
    );
    expect(completionCandidateDocumentUrl("proposal / 1", "candidate / 2"))
      .toBe("/api/completion-proposals/proposal%20%2F%201/candidates/candidate%20%2F%202/candidate.json");
    expect(completionCandidateTextureUrl("proposal / 1", "candidate / 2"))
      .toBe("/api/completion-proposals/proposal%20%2F%201/candidates/candidate%20%2F%202/texture.png");
    expect(completionCandidateWriteMaskUrl("proposal / 1", "candidate / 2"))
      .toBe("/api/completion-proposals/proposal%20%2F%201/candidates/candidate%20%2F%202/write-mask.png");
    expect(completionCandidateGeneratedMaskUrl("proposal / 1", "candidate / 2"))
      .toBe("/api/completion-proposals/proposal%20%2F%201/candidates/candidate%20%2F%202/generated-mask.png");
  });

  it("binds accept and reject decisions to the exact persisted hashes", async () => {
    const proposal = completionProposal();
    const candidate = completionCandidate();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ changed: true }, 201))
      .mockResolvedValueOnce(jsonResponse({ changed: true }, 201));

    await acceptCompletionCandidate(proposal, candidate, {
      actorId: "local-player",
      summary: "accepted after exact review",
    }, fetcher);
    await rejectCompletionProposal(proposal, {
      actorId: "local-player",
      reason: "keep original",
    }, fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/completion-proposals/proposal%20%2F%201/candidates/candidate%20%2F%202/accept",
      "/api/completion-proposals/proposal%20%2F%201/reject",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      expectedSourceResultHash: "source-result-hash",
      expectedProposalHash: "proposal-hash",
      expectedEvidenceHash: "evidence-hash",
      expectedCandidateHash: "candidate-hash",
      actorId: "local-player",
      summary: "accepted after exact review",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      expectedSourceResultHash: "source-result-hash",
      expectedProposalHash: "proposal-hash",
      expectedEvidenceHash: "evidence-hash",
      actorId: "local-player",
      reason: "keep original",
    });
  });

  it("binds manual candidate edits and latent publication to immutable hashes", async () => {
    const proposal = completionProposal();
    const candidate = completionCandidate();
    const document = {
      schemaVersion: "1.0",
      candidateId: candidate.id,
      assignments: [],
    };
    const result: ApiCompletionResult = {
      id: "result / 1",
      proposalId: proposal.id,
      decisionId: "decision_1",
      candidateId: candidate.id,
      representation: "latent_component",
      sourceRevisionId: proposal.sourceRevisionId,
      sourceResultHash: proposal.sourceResultHash,
      sourceSkinHash: proposal.sourceSkinHash,
      revision: null,
      latentPart: { id: "part / latent" } as ApiPart,
      resultHash: "result-hash",
      resultSkinHash: proposal.sourceSkinHash,
      originHash: "origin-hash",
      publishedAt: null,
      createdAt: "2026-08-19T09:05:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(document, 200))
      .mockResolvedValueOnce(jsonResponse({
        changed: true,
        editedCandidateId: "candidate_manual",
      }, 201))
      .mockResolvedValueOnce(jsonResponse({ changed: true, result }, 201));

    expect(await loadCompletionCandidateDocument(
      proposal.id,
      candidate.id,
      fetcher,
    )).toMatchObject({ candidateId: candidate.id });
    await editCompletionCandidate(proposal, candidate, [
      { type: "set_pixel", pixelId: 64, rgba: [12, 34, 56, 255] },
      { type: "remove_pixel", pixelId: 65 },
    ], {}, fetcher);
    await publishCompletionResult(result, {}, fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/completion-proposals/proposal%20%2F%201/candidates/candidate%20%2F%202/candidate.json",
      "/api/completion-proposals/proposal%20%2F%201/candidates/candidate%20%2F%202/edits",
      "/api/completion-results/result%20%2F%201/publish",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      expectedSourceResultHash: "source-result-hash",
      expectedProposalHash: "proposal-hash",
      expectedEvidenceHash: "evidence-hash",
      expectedCandidateHash: "candidate-hash",
      edits: [
        { type: "set_pixel", pixelId: 64, rgba: [12, 34, 56, 255] },
        { type: "remove_pixel", pixelId: 65 },
      ],
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      expectedResultHash: "result-hash",
      expectedPartId: "part / latent",
    });
  });

  it("preserves a stale Completion decision as a 409 with no fallback request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        error: {
          code: "COMPLETION_STALE",
          message: "candidate hash changed",
        },
      }, 409),
    );

    const error = await acceptCompletionCandidate(
      completionProposal(),
      completionCandidate(),
      {},
      fetcher,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 409,
      code: "COMPLETION_STALE",
      message: "candidate hash changed",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

function completionProposal(): ApiCompletionProposal {
  return {
    id: "proposal / 1",
    jobId: "job_1",
    projectId: "project_1",
    sourceRevisionId: "revision_1",
    sourceResultHash: "source-result-hash",
    sourceSkinHash: "source-skin-hash",
    targetComponentId: "shirt.main",
    occludingComponentIds: ["hair.main"],
    representation: "skin_texel",
    allowedSpans: [],
    allowedGeneratedPixelCount: 2,
    evidence: {},
    evidenceHash: "evidence-hash",
    proposalHash: "proposal-hash",
    document: completionStoredFile("application/json"),
    allowedMask: completionStoredFile("image/png"),
    createdAt: "2026-08-19T09:00:00.000Z",
  };
}

function completionCandidate(): ApiCompletionCandidate {
  return {
    id: "candidate / 2",
    proposalId: "proposal / 1",
    representation: "skin_texel",
    strategy: "same_surface_continuation",
    confidence: "medium",
    originMode: "generated_completion",
    pixelCount: 2,
    generatedPixelCount: 2,
    candidateHash: "candidate-hash",
    evidenceHash: "evidence-hash",
    document: completionStoredFile("application/json"),
    texture: completionStoredFile("image/png"),
    writeMask: completionStoredFile("image/png"),
    generatedMask: completionStoredFile("image/png"),
    reviewRequired: true,
    automaticAcceptanceAllowed: false,
    createdAt: "2026-08-19T09:01:00.000Z",
  };
}

function completionStoredFile(
  mimeType: "application/json" | "image/png",
) {
  return {
    storagePath: "asset",
    mimeType,
    byteSize: 1,
    sha256: "asset-hash",
  } as const;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
