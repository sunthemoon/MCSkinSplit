import {
  aggregateKindForCategory,
  type AggregateKind,
  type Rgba,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import type {
  ApiCompositionRestorationCandidates,
  ApiRestorationCandidate,
} from "./revisionApi";

export type RestorationTargetMode = "fine" | AggregateKind;

export function componentMatchesRestorationMode(
  component: Pick<SemanticComponent, "category">,
  mode: RestorationTargetMode,
): boolean {
  return mode === "fine" || aggregateKindForCategory(component.category) === mode;
}

export function targetComponentIdsForMode(
  components: readonly SemanticComponent[],
  mode: RestorationTargetMode,
  selectedFineIds: readonly string[],
): readonly string[] {
  const available = components.filter((component) =>
    componentMatchesRestorationMode(component, mode),
  );
  return mode === "fine"
    ? available
        .filter((component) => selectedFineIds.includes(component.instanceId))
        .map((component) => component.instanceId)
    : available.map((component) => component.instanceId);
}

export function defaultRestorationCandidateIds(
  candidates: ApiCompositionRestorationCandidates,
): readonly string[] {
  const ids: string[] = [];
  if (candidates.outer.candidateId) ids.unshift(candidates.outer.candidateId);
  return unique(ids);
}

export function toggleRestorationCandidateId(
  candidates: ApiCompositionRestorationCandidates,
  selectedIds: readonly string[],
  candidateId: string,
): readonly string[] {
  const candidate = candidates.base.candidates.find((item) => item.id === candidateId);
  if (!candidate) return normalizeSelectedRestorationCandidateIds(candidates, selectedIds);
  const next = selectedIds.includes(candidateId)
    ? selectedIds.filter((id) => id !== candidateId)
    : [
        ...selectedIds.filter((id) =>
          candidates.base.candidates.find((item) => item.id === id)?.targetGroupId !==
          candidate.targetGroupId,
        ),
        candidateId,
      ];
  return normalizeSelectedRestorationCandidateIds(candidates, next);
}

export function normalizeSelectedRestorationCandidateIds(
  candidates: ApiCompositionRestorationCandidates,
  selectedIds: readonly string[],
): readonly string[] {
  const valid = new Set([
    ...(candidates.outer.candidateId ? [candidates.outer.candidateId] : []),
    ...candidates.base.candidates.map((candidate) => candidate.id),
  ]);
  const ids = selectedIds.filter((id) => valid.has(id));
  if (candidates.outer.candidateId && !ids.includes(candidates.outer.candidateId)) {
    ids.unshift(candidates.outer.candidateId);
  }
  return unique(ids);
}

export function selectedRestorationCoverage(
  candidates: ApiCompositionRestorationCandidates,
  selectedIds: readonly string[],
): { readonly coveredPixelCount: number; readonly missingPixelCount: number } {
  const selected = new Set(selectedIds);
  const selectedCandidates = candidates.base.candidates.filter((candidate) =>
    selected.has(candidate.id),
  );
  const coveredPixelCount = Math.min(
    candidates.base.pixelCount,
    selectedCandidates.reduce(
      (total, candidate) => total + candidate.coveragePixelCount,
      0,
    ),
  );
  return {
    coveredPixelCount,
    missingPixelCount: Math.max(0, candidates.base.pixelCount - coveredPixelCount),
  };
}

export function parseOpaqueHexColor(value: string): Rgba {
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error("肤色候选必须为 #RRGGBB");
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
    255,
  ];
}

export function restorationCandidateKindLabel(
  candidate: Pick<ApiRestorationCandidate, "kind">,
): string {
  const labels: Readonly<Record<ApiRestorationCandidate["kind"], string>> = {
    outer_transparent: "Outer 自动清除",
    current_same_surface: "当前皮肤 · 同表面",
    current_same_body_part: "当前皮肤 · 同身体部位",
    mirrored_counterpart: "左右镜像参考",
    donor_revision: "历史 Revision 供色",
    manual_rgba: "手动肤色",
  };
  return labels[candidate.kind];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
