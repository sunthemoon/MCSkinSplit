import { describe, expect, it } from "vitest";
import {
  defaultRestorationCandidateIds,
  normalizeSelectedRestorationCandidateIds,
  parseOpaqueHexColor,
  selectedRestorationCoverage,
  targetComponentIdsForMode,
  toggleRestorationCandidateId,
} from "./compositionRestoration";
import type { ApiCompositionRestorationCandidates } from "./revisionApi";
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
        pixelCount: 8,
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
});
