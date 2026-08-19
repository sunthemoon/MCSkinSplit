import { describe, expect, it, vi } from "vitest";
import {
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
  commitPartEdit,
  createComposition,
  dismissSemanticFollowup,
  createPartEdit,
  exportRevisionPart,
  exportRevisionBundle,
  generateCompositionRestorationCandidates,
  getAnalyzedSkin,
  importProjectSkin,
  listAnalyzedSkins,
  listAiJobs,
  listAiProviders,
  listPartBundles,
  listParts,
  loadRevisionOrigin,
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
  revisePartBundle,
  retryAiJob,
  removeCompositionLayer,
  reorderCompositionLayers,
  resolveCompositionConflicts,
  setCompositionRestorationPlan,
  startAiRestorationRecommendation,
  RevisionApiError,
  startAiAnalysis,
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
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
