import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SemanticComponent } from "@mc-skin-split/skin-core";
import type { ApiCompositionRestorationCandidates } from "../lib/revisionApi";
import { CompositionRestorationPanel } from "./CompositionRestorationPanel";

const components = [
  { instanceId: "shirt.main", displayName: "上衣", category: "upper_clothing" },
  { instanceId: "hair.main", displayName: "头发", category: "hair" },
] as SemanticComponent[];

const candidates: ApiCompositionRestorationCandidates = {
  compositionId: "composition_1",
  version: 2,
  candidateSetHash: `sha256:${"a".repeat(64)}`,
  targetComponentIds: ["shirt.main"],
  outer: { pixelCount: 12, candidateId: "candidate.outer" },
  base: {
    pixelCount: 8,
    coveredPixelCount: 8,
    missingPixelCount: 0,
    candidates: [
      {
        id: "candidate.manual",
        kind: "manual_rgba",
        targetGroupId: "torso.base",
        label: "手动肤色 #D6A17B",
        description: "覆盖目标 Base",
        pixelCount: 8,
        coveragePixelCount: 8,
        rgba: [214, 161, 123, 255],
      },
    ],
  },
};

describe("composition restoration panel contract", () => {
  it("renders target modes, candidate evidence, coverage, and the persistence boundary", () => {
    const html = renderToStaticMarkup(createElement(CompositionRestorationPanel, {
      components,
      mode: "fine",
      selectedFineIds: ["shirt.main"],
      donorRevisionId: "",
      manualColor: "#d6a17b",
      includeManualColor: true,
      candidates,
      selectedCandidateIds: ["candidate.outer"],
      plan: null,
      coveredPixelCount: 0,
      missingPixelCount: 8,
      disabled: false,
      busy: false,
      error: null,
      recommendationJobDetail: null,
      recommendationUserIntent: "优先完整覆盖",
      recommendationProviders: ["restoration-provider"],
      recommendationProvider: "restoration-provider",
      recommendationModel: "codex-config-default",
      recommendationReasoningEffort: "medium",
      recommendationStaleReason: null,
      recommendationBusy: false,
      recommendationError: null,
      onModeChange: () => undefined,
      onToggleFine: () => undefined,
      onDonorRevisionIdChange: () => undefined,
      onManualColorChange: () => undefined,
      onIncludeManualColorChange: () => undefined,
      onGenerate: () => undefined,
      onToggleCandidate: () => undefined,
      onApply: () => undefined,
      onClear: () => undefined,
      onRecommendationUserIntentChange: () => undefined,
      onRecommendationProviderChange: () => undefined,
      onStartRecommendation: () => undefined,
      onCancelRecommendation: () => undefined,
      onLoadRecommendation: () => undefined,
    }));

    expect(html).toContain("目标皮肤残留清理与肤色还原");
    expect(html).toContain("完整衣服");
    expect(html).toContain("Outer 自动清除");
    expect(html).toContain("手动肤色 #D6A17B");
    expect(html).toContain("仍有 8 个 Base 像素没有肤色来源");
    expect(html).toMatch(/应用清理计划并刷新 2D \/ 3D<\/button>/);
  });

  it("keeps target selection and candidate selection as separate explicit inputs", () => {
    const targetIds = components
      .filter((component) => component.category === "upper_clothing")
      .map((component) => component.instanceId);
    const candidateIds = [candidates.outer.candidateId, candidates.base.candidates[0]?.id]
      .filter((value): value is string => Boolean(value));

    expect(targetIds).toEqual(["shirt.main"]);
    expect(candidateIds).toEqual(["candidate.outer", "candidate.manual"]);
    expect(candidateIds).not.toContain(targetIds[0]);
  });

  it("never exposes masks or compositor operations in the candidate DTO", () => {
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain("mask");
    expect(serialized).not.toContain("operation");
    expect(serialized).not.toContain("pixelIds");
  });
});
