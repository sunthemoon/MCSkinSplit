import {
  aggregateKindForCategory,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import type {
  ApiAnalyzedSkin,
  ApiAiJob,
  ApiAiJobStatus,
  ApiCompletionCandidate,
  ApiCompletionProposalDetail,
  ApiCompletionProposalSummary,
} from "./revisionApi";

export type CompletionWorkspaceStep = 1 | 2 | 3 | 4;

export interface CompletionSourceChoice {
  readonly kind: "original" | "repaired";
  readonly revisionId: string;
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
}

export interface CompletionCatalogContext {
  readonly item: ApiAnalyzedSkin;
  readonly sourceKind: CompletionSourceChoice["kind"];
  readonly choices: readonly CompletionSourceChoice[];
}

export interface CompletionHydrationSelection {
  readonly job: ApiAiJob | null;
  readonly proposal: ApiCompletionProposalSummary | null;
}

export async function hydrateSucceededCompletionJob(
  jobId: string,
  list: (jobId: string) => Promise<readonly ApiCompletionProposalSummary[]>,
  load: (proposalId: string) => Promise<ApiCompletionProposalDetail>,
): Promise<ApiCompletionProposalDetail | null> {
  const proposals = (await list(jobId)).filter((item) =>
    item.visible && item.proposal.jobId === jobId);
  const latest = proposals.toSorted((left, right) =>
    Date.parse(left.proposal.createdAt) -
      Date.parse(right.proposal.createdAt)).at(-1);
  if (!latest) return null;
  const detail = await load(latest.proposal.id);
  if (
    detail.proposal.id !== latest.proposal.id ||
    detail.proposal.jobId !== jobId
  ) {
    throw new Error("补全详情与已完成任务不匹配");
  }
  return detail;
}

export function isCompletionWorkspaceEnabled(value: unknown): boolean {
  return value === "true";
}

export function completionTargetComponents(
  components: readonly SemanticComponent[],
): readonly SemanticComponent[] {
  return components.filter((component) => {
    const kind = aggregateKindForCategory(component.category);
    return (kind === "hair" || kind === "clothing") &&
      componentPixelCount(component) > 0;
  });
}

export function completionOccludingComponents(
  components: readonly SemanticComponent[],
  targetComponentId: string | null,
): readonly SemanticComponent[] {
  const target = components.find(
    (component) => component.instanceId === targetComponentId,
  );
  if (!target) return [];
  const targetKind = aggregateKindForCategory(target.category);
  return components.filter((component) => {
    if (
      component.instanceId === target.instanceId ||
      componentPixelCount(component) === 0
    ) {
      return false;
    }
    const kind = aggregateKindForCategory(component.category);
    return targetKind === "hair"
      ? kind === "accessory"
      : targetKind === "clothing" &&
          (kind === "hair" || kind === "accessory");
  });
}

export function completionWorkspaceStep(input: {
  readonly jobStatus: ApiAiJobStatus | null;
  readonly detail: ApiCompletionProposalDetail | null;
}): CompletionWorkspaceStep {
  if (input.detail?.decision) return 4;
  if (input.detail) return 3;
  if (input.jobStatus) return 2;
  return 1;
}

export function orderedCompletionCandidates(
  detail: ApiCompletionProposalDetail,
): readonly ApiCompletionCandidate[] {
  const byId = new Map(
    detail.candidates.map((candidate) => [candidate.id, candidate] as const),
  );
  const ordered = (detail.ranking?.orderedCandidateIds ?? [])
    .map((candidateId) => byId.get(candidateId))
    .filter((candidate): candidate is ApiCompletionCandidate => Boolean(candidate));
  const included = new Set(ordered.map((candidate) => candidate.id));
  return [
    ...ordered,
    ...detail.candidates.filter((candidate) => !included.has(candidate.id)),
  ];
}

export function selectCompletionHydrationState(
  jobs: readonly ApiAiJob[],
  proposals: readonly ApiCompletionProposalSummary[],
): CompletionHydrationSelection {
  const job = jobs.toSorted((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt)).at(-1) ?? null;
  const matching = job
    ? proposals.filter((item) =>
        item.visible && item.proposal.jobId === job.id)
    : proposals.filter((item) => item.visible);
  const proposal = matching.toSorted((left, right) =>
    Date.parse(left.proposal.createdAt) -
      Date.parse(right.proposal.createdAt)).at(-1) ?? null;
  return { job, proposal };
}

export function findCompletionCatalogContext(
  analyzedSkins: readonly ApiAnalyzedSkin[],
  selectedRevisionId: string | null,
): CompletionCatalogContext | null {
  if (!selectedRevisionId) return null;
  for (const item of analyzedSkins) {
    const repaired = item.semanticFollowup?.appliedVariant?.revision ?? null;
    const sourceKind = item.revision.id === selectedRevisionId
      ? "original"
      : repaired?.id === selectedRevisionId
        ? "repaired"
        : null;
    if (!sourceKind) continue;
    const choices: CompletionSourceChoice[] = [
      {
        kind: "original",
        revisionId: item.revision.id,
        label: "原识别",
        detail: `${item.revision.branchName} #${item.revision.sequence}`,
        selected: sourceKind === "original",
      },
    ];
    if (repaired) {
      choices.push({
        kind: "repaired",
        revisionId: repaired.id,
        label: "分类修复版",
        detail: `${repaired.branchName} #${repaired.sequence}`,
        selected: sourceKind === "repaired",
      });
    }
    return { item, sourceKind, choices };
  }
  return null;
}

export function completionResultAppliesToRevision(
  detail: ApiCompletionProposalDetail,
  catalogContext: CompletionCatalogContext,
  revisionId: string | null,
): boolean {
  if (!revisionId) return false;
  if (catalogContext.choices.some((choice) =>
    choice.revisionId === revisionId)) {
    return true;
  }
  return detail.decision?.action === "accept" &&
    detail.result?.representation === "skin_texel" &&
    detail.result.revision?.id === revisionId;
}

export function componentPixelCount(component: SemanticComponent): number {
  return component.spans.reduce(
    (total, span) => total + span.x1 - span.x0 + 1,
    0,
  );
}

export const COMPLETION_STRATEGY_LABELS = {
  opposite_layer_underlay: "对层可见纹理延续",
  mirrored_counterpart: "左右镜像参考",
  same_surface_continuation: "同表面连续纹理",
  opposite_surface_reference: "对面纹理参考",
  neighbor_reference: "相邻区域参考",
  pattern_continuation: "图案规律延续",
  manual_edit: "玩家调整候选",
} as const;

export const COMPLETION_CONFIDENCE_LABELS = {
  high: "较强证据",
  medium: "中等证据",
  low: "有限证据",
  manual: "玩家调整",
} as const;
