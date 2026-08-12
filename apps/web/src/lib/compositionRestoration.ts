import {
  aggregateKindForCategory,
  type AggregateKind,
  type Rgba,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import type {
  ApiAiJob,
  ApiCompositionRestorationCandidates,
  ApiCompositionProject,
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

export type RestorationRecommendationLoadResult =
  | { readonly ok: true; readonly candidateIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function restorationRecommendationStaleReason(
  composition: Pick<ApiCompositionProject, "id" | "restorationVersion"> | null,
  candidates: ApiCompositionRestorationCandidates | null,
  job: ApiAiJob,
): string | null {
  if (!composition || !candidates) {
    return "确定性候选已经失效，请重新生成候选后再启动 AI 推荐";
  }
  if (
    job.kind !== "restoration_recommendation" ||
    job.options.mode !== "restoration_recommendation"
  ) {
    return "该 AI Job 不是修补候选推荐任务";
  }
  if (!job.advisoryResult) {
    return "AI Job 尚未生成可载入的推荐结果";
  }
  if (job.status !== "succeeded") {
    return "AI Job 尚未成功完成，不能载入推荐结果";
  }

  const { options, advisoryResult } = job;
  if (
    job.compositionId !== composition.id ||
    options.compositionId !== composition.id ||
    advisoryResult.compositionId !== composition.id ||
    candidates.compositionId !== composition.id
  ) {
    return "推荐结果属于另一个混搭工程";
  }
  if (
    composition.restorationVersion !== options.compositionVersion ||
    candidates.version !== options.compositionVersion
  ) {
    return "混搭还原版本已经变化，请重新生成候选并获取推荐";
  }
  if (
    options.candidateSetHash !== candidates.candidateSetHash ||
    advisoryResult.candidateSetHash !== candidates.candidateSetHash
  ) {
    return "候选集合已经变化，请重新获取 AI 推荐";
  }
  if (advisoryResult.jobId !== job.id) {
    return "AI 推荐结果与 Job 标识不一致";
  }
  if (!sameStringSet(options.targetComponentIds, candidates.targetComponentIds)) {
    return "AI 推荐目标与当前候选目标不一致";
  }
  return null;
}

export function loadRestorationRecommendationSelection(
  composition: Pick<ApiCompositionProject, "id" | "restorationVersion"> | null,
  candidates: ApiCompositionRestorationCandidates | null,
  job: ApiAiJob,
): RestorationRecommendationLoadResult {
  const staleReason = restorationRecommendationStaleReason(
    composition,
    candidates,
    job,
  );
  if (staleReason || !candidates || !job.advisoryResult) {
    return { ok: false, reason: staleReason ?? "AI 推荐结果不可用" };
  }

  const byId = new Map(
    candidates.base.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const catalogByGroup = new Map<string, ApiRestorationCandidate[]>();
  for (const candidate of candidates.base.candidates) {
    const group = catalogByGroup.get(candidate.targetGroupId) ?? [];
    group.push(candidate);
    catalogByGroup.set(candidate.targetGroupId, group);
  }
  const seenGroups = new Set<string>();
  const selectedIds: string[] = [];

  for (const decision of job.advisoryResult.decisions) {
    if (seenGroups.has(decision.targetGroupId)) {
      return { ok: false, reason: "AI 推荐包含重复的目标分组" };
    }
    seenGroups.add(decision.targetGroupId);
    if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
      return { ok: false, reason: "AI 推荐置信度无效" };
    }
    if (new Set(decision.rankedCandidateIds).size !== decision.rankedCandidateIds.length) {
      return { ok: false, reason: "AI 推荐候选排序包含重复项" };
    }
    const groupCatalog = catalogByGroup.get(decision.targetGroupId);
    if (
      !groupCatalog ||
      !sameStringSet(
        decision.rankedCandidateIds,
        groupCatalog.map((candidate) => candidate.id),
      )
    ) {
      return { ok: false, reason: "AI 推荐没有完整排列目标分组的候选" };
    }
    for (const candidateId of decision.rankedCandidateIds) {
      const candidate = byId.get(candidateId);
      if (!candidate || candidate.targetGroupId !== decision.targetGroupId) {
        return { ok: false, reason: "AI 推荐引用了未知候选或错误分组" };
      }
    }
    if (decision.selectedCandidateId !== null) {
      const selected = byId.get(decision.selectedCandidateId);
      if (
        !selected ||
        selected.targetGroupId !== decision.targetGroupId ||
        decision.rankedCandidateIds[0] !== decision.selectedCandidateId
      ) {
        return { ok: false, reason: "AI 推荐选择必须是该目标分组的首位候选" };
      }
      if (selected.coveragePixelCount !== selected.pixelCount) {
        return { ok: false, reason: "AI 推荐选择没有完整覆盖目标分组" };
      }
      selectedIds.push(selected.id);
    }
  }

  if (!sameStringSet([...seenGroups], [...catalogByGroup.keys()])) {
    return { ok: false, reason: "AI 推荐没有覆盖全部 Base 目标分组" };
  }

  return {
    ok: true,
    candidateIds: normalizeSelectedRestorationCandidateIds(candidates, selectedIds),
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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value));
}
