import { describe, expect, it } from "vitest";
import {
  defaultRestorationCandidateIds,
  loadRestorationRecommendationSelection,
  normalizeSelectedRestorationCandidateIds,
  parseOpaqueHexColor,
  selectedRestorationCoverage,
  targetComponentIdsForMode,
  toggleRestorationCandidateId,
} from "./compositionRestoration";
import type { ApiCompositionRestorationCandidates } from "./revisionApi";
import type { ApiAiJob, ApiCompositionProject } from "./revisionApi";
import type { SemanticComponent } from "@mc-skin-split/skin-core";

const candidates: ApiCompositionRestorationCandidates = {
  compositionId: "composition_1",
  version: 2,
  candidateSetHash: `sha256:${"a".repeat(64)}`,
  targetComponentIds: ["shirt.main"],
  outer: { pixelCount: 9, candidateId: "candidate.outer" },
  base: {
    pixelCount: 10,
    coveredPixelCount: 8,
    missingPixelCount: 2,
    candidates: [
      {
        id: "candidate.same_surface",
        kind: "current_same_surface",
        targetGroupId: "torso.base",
        label: "Same surface",
        description: "",
        pixelCount: 10,
        coveragePixelCount: 8,
        selectedByDefault: true,
      },
      {
        id: "candidate.manual",
        kind: "manual_rgba",
        targetGroupId: "torso.base",
        label: "Manual",
        description: "",
        pixelCount: 10,
        coveragePixelCount: 10,
        rgba: [220, 170, 140, 255],
      },
    ],
  },
};

const composition = {
  id: "composition_1",
  restorationVersion: 2,
} as Pick<ApiCompositionProject, "id" | "restorationVersion">;

function recommendationJob(
  overrides: Partial<ApiAiJob> = {},
): ApiAiJob {
  return {
    id: "job_1",
    kind: "restoration_recommendation",
    projectId: "project_1",
    inputRevisionId: "revision_1",
    resultRevisionId: null,
    compositionId: "composition_1",
    retryOfJobId: null,
    status: "succeeded",
    provider: "codex-exec",
    model: "codex-config-default",
    skillName: "mc-skin-replacement-planner",
    skillVersion: "1.0.0",
    promptVersion: "1.0.0",
    inputHash: null,
    outputHash: null,
    options: {
      mode: "restoration_recommendation",
      provider: "codex-exec",
      model: "codex-config-default",
      reasoningEffort: "medium",
      userIntent: "优先完整覆盖",
      compositionId: "composition_1",
      compositionVersion: 2,
      candidateSetHash: candidates.candidateSetHash,
      targetComponentIds: ["shirt.main"],
    },
    reviewItems: [],
    proposalSummary: null,
    advisoryResult: {
      schemaVersion: "1.0",
      jobId: "job_1",
      compositionId: "composition_1",
      candidateSetHash: candidates.candidateSetHash,
      decisions: [{
        targetGroupId: "torso.base",
        selectedCandidateId: "candidate.manual",
        rankedCandidateIds: ["candidate.manual", "candidate.same_surface"],
        confidence: 0.91,
        explanation: "完整覆盖 Base。",
      }],
      summary: "推荐手动肤色。",
    },
    cancelRequested: false,
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: "2026-08-12T00:00:01.000Z",
    finishedAt: "2026-08-12T00:00:02.000Z",
    error: null,
    ...overrides,
  };
}

describe("composition restoration UI helpers", () => {
  it("keeps fine selection explicit and expands an aggregate target", () => {
    const components = [
      { instanceId: "shirt.main", category: "upper_clothing" },
      { instanceId: "shoe.main", category: "shoe" },
      { instanceId: "hair.main", category: "hair" },
    ] as SemanticComponent[];
    expect(targetComponentIdsForMode(components, "fine", ["shoe.main"])).toEqual([
      "shoe.main",
    ]);
    expect(targetComponentIdsForMode(components, "clothing", [])).toEqual([
      "shirt.main",
      "shoe.main",
    ]);
  });

  it("always retains the server-issued Outer clear candidate", () => {
    expect(defaultRestorationCandidateIds(candidates)).toEqual([
      "candidate.outer",
    ]);
    expect(
      normalizeSelectedRestorationCandidateIds(candidates, [
        "candidate.manual",
        "untrusted.raw.operation",
      ]),
    ).toEqual(["candidate.outer", "candidate.manual"]);
  });

  it("reports candidate coverage and creates an opaque manual color", () => {
    expect(
      selectedRestorationCoverage(candidates, ["candidate.outer", "candidate.manual"]),
    ).toEqual({ coveredPixelCount: 10, missingPixelCount: 0 });
    expect(parseOpaqueHexColor("#dca98c")).toEqual([220, 169, 140, 255]);
  });

  it("selects at most one Base candidate for each target group", () => {
    expect(
      toggleRestorationCandidateId(
        candidates,
        ["candidate.outer", "candidate.same_surface"],
        "candidate.manual",
      ),
    ).toEqual(["candidate.outer", "candidate.manual"]);
  });

  it("atomically loads a fresh recommendation and retains the forced Outer candidate", () => {
    expect(
      loadRestorationRecommendationSelection(
        composition,
        candidates,
        recommendationJob(),
      ),
    ).toEqual({
      ok: true,
      candidateIds: ["candidate.outer", "candidate.manual"],
    });
  });

  it("rejects stale composition versions and candidate hashes", () => {
    expect(
      loadRestorationRecommendationSelection(
        { ...composition, restorationVersion: 3 },
        candidates,
        recommendationJob(),
      ),
    ).toMatchObject({ ok: false });
    expect(
      loadRestorationRecommendationSelection(
        composition,
        { ...candidates, candidateSetHash: `sha256:${"b".repeat(64)}` },
        recommendationJob(),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects a non-terminal recommendation even if it carries provisional output", () => {
    expect(
      loadRestorationRecommendationSelection(
        composition,
        candidates,
        recommendationJob({ status: "validating" }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects unknown, cross-group, duplicate, and incomplete rankings without partial load", () => {
    const baseJob = recommendationJob();
    if (!baseJob.advisoryResult) throw new Error("fixture result missing");
    const decision = baseJob.advisoryResult.decisions[0];
    if (!decision) throw new Error("fixture decision missing");
    const invalidDecisions = [
      [],
      [{ ...decision, rankedCandidateIds: ["candidate.unknown", "candidate.same_surface"] }],
      [{ ...decision, rankedCandidateIds: ["candidate.manual", "candidate.manual"] }],
      [{ ...decision, rankedCandidateIds: ["candidate.manual"] }],
      [decision, { ...decision }],
      [{ ...decision, targetGroupId: "opaque.other" }],
    ];

    for (const decisions of invalidDecisions) {
      const result = loadRestorationRecommendationSelection(
        composition,
        candidates,
        recommendationJob({
          advisoryResult: { ...baseJob.advisoryResult, decisions },
        }),
      );
      expect(result).toMatchObject({ ok: false });
    }
  });

  it("rejects a selected candidate that is not ranked first or does not fully cover its group", () => {
    const baseJob = recommendationJob();
    if (!baseJob.advisoryResult) throw new Error("fixture result missing");
    const decision = baseJob.advisoryResult.decisions[0];
    if (!decision) throw new Error("fixture decision missing");

    expect(
      loadRestorationRecommendationSelection(
        composition,
        candidates,
        recommendationJob({
          advisoryResult: {
            ...baseJob.advisoryResult,
            decisions: [{
              ...decision,
              selectedCandidateId: "candidate.manual",
              rankedCandidateIds: ["candidate.same_surface", "candidate.manual"],
            }],
          },
        }),
      ),
    ).toMatchObject({ ok: false });

    expect(
      loadRestorationRecommendationSelection(
        composition,
        candidates,
        recommendationJob({
          advisoryResult: {
            ...baseJob.advisoryResult,
            decisions: [{
              ...decision,
              selectedCandidateId: "candidate.same_surface",
              rankedCandidateIds: ["candidate.same_surface", "candidate.manual"],
            }],
          },
        }),
      ),
    ).toMatchObject({ ok: false });
  });
});
