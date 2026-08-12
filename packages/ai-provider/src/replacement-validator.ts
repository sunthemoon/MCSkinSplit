import type {
  PublicRestorationCandidate,
  ReplacementPlanningPack,
} from "@mc-skin-split/skin-analysis-pack";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import {
  REPLACEMENT_PLAN_SCHEMA,
  REPLACEMENT_PLAN_VALIDATOR_VERSION,
} from "./schema";
import type {
  ReplacementPlanProposal,
  ReplacementPlanValidationIssue,
  ReplacementPlanValidationReport,
  ReplacementPlanValidationResult,
} from "./types";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});
const validateSchema = ajv.compile(REPLACEMENT_PLAN_SCHEMA);
const FORBIDDEN_EVIDENCE_PATTERNS = [
  /\bmask\b/iu,
  /\bpixel\s*ids?\b/iu,
  /\bcoordinates?\b/iu,
  /\brgba?\b/iu,
  /\bpng\b/iu,
  /像素\s*(?:id|编号)/iu,
  /坐标/iu,
  /遮罩/iu,
  /\[[ ]*\d{1,3}(?:[ ]*,[ ]*\d{1,3}){3}[ ]*\]/u,
  /#[0-9a-f]{6,8}\b/iu,
];

export function validateReplacementPlanProposal(input: {
  readonly proposal: unknown;
  readonly pack: ReplacementPlanningPack;
}): ReplacementPlanValidationResult {
  const errors: ReplacementPlanValidationIssue[] = [];
  const candidates = input.pack.candidateCatalog.base.candidates;
  const groups = groupCandidates(candidates);
  const emptyStats = stats(groups.size, 0, candidates.length, 0);
  if (!validateSchema(input.proposal)) {
    errors.push(...schemaIssues(validateSchema.errors ?? []));
    return invalidResult(null, errors, emptyStats);
  }
  const proposal = input.proposal as unknown as ReplacementPlanProposal;
  if (proposal.jobId !== input.pack.job.jobId) {
    errors.push(issue("JOB_ID_MISMATCH", "/jobId", "提案 Job 与任务不一致"));
  }
  if (proposal.compositionId !== input.pack.candidateCatalog.compositionId) {
    errors.push(
      issue(
        "COMPOSITION_ID_MISMATCH",
        "/compositionId",
        "提案 Composition 与候选目录不一致",
      ),
    );
  }
  if (
    proposal.candidateSetHash !== input.pack.candidateCatalog.candidateSetHash
  ) {
    errors.push(
      issue(
        "CANDIDATE_SET_HASH_MISMATCH",
        "/candidateSetHash",
        "提案候选集哈希与任务不一致",
      ),
    );
  }
  rejectForbiddenEvidence(proposal.summary, "/summary", errors);

  const seenGroups = new Set<string>();
  const seenCandidateIds = new Set<string>();
  let previousGroupId: string | null = null;
  for (const [index, decision] of proposal.decisions.entries()) {
    const path = `/decisions/${index}`;
    const groupCandidatesList = groups.get(decision.targetGroupId);
    if (!groupCandidatesList) {
      errors.push(
        issue(
          "UNKNOWN_TARGET_GROUP",
          `${path}/targetGroupId`,
          `候选目录没有 Base 目标组：${decision.targetGroupId}`,
        ),
      );
    }
    if (seenGroups.has(decision.targetGroupId)) {
      errors.push(
        issue(
          "DUPLICATE_TARGET_GROUP",
          `${path}/targetGroupId`,
          `Base 目标组重复：${decision.targetGroupId}`,
        ),
      );
    }
    seenGroups.add(decision.targetGroupId);
    if (
      previousGroupId !== null &&
      compareString(previousGroupId, decision.targetGroupId) >= 0
    ) {
      errors.push(
        issue(
          "TARGET_GROUP_ORDER_INVALID",
          path,
          "Base 目标组决策必须按 targetGroupId 严格升序排列",
        ),
      );
    }
    previousGroupId = decision.targetGroupId;

    const expectedIds = groupCandidatesList?.map((candidate) => candidate.id) ?? [];
    if (!sameExactSet(decision.rankedCandidateIds, expectedIds)) {
      errors.push(
        issue(
          "RANKING_NOT_EXACT_PERMUTATION",
          `${path}/rankedCandidateIds`,
          "候选排序必须恰好包含该 Base 组的全部候选 ID",
        ),
      );
    }
    for (const candidateId of decision.rankedCandidateIds) {
      if (!expectedIds.includes(candidateId)) {
        errors.push(
          issue(
            "UNKNOWN_CANDIDATE_ID",
            `${path}/rankedCandidateIds`,
            `候选 ID 不属于该 Base 组：${candidateId}`,
          ),
        );
      }
      if (candidateId === input.pack.candidateCatalog.outer.candidateId) {
        errors.push(
          issue(
            "OUTER_CANDIDATE_FORBIDDEN",
            `${path}/rankedCandidateIds`,
            "Outer 清理候选由 Host 自动管理，不得进入 Base 决策",
          ),
        );
      }
      if (seenCandidateIds.has(candidateId)) {
        errors.push(
          issue(
            "CANDIDATE_MULTIPLE_GROUPS",
            `${path}/rankedCandidateIds`,
            `候选 ID 出现在多个 Base 组：${candidateId}`,
          ),
        );
      }
      seenCandidateIds.add(candidateId);
    }
    if (decision.selectedCandidateId !== null) {
      if (decision.rankedCandidateIds[0] !== decision.selectedCandidateId) {
        errors.push(
          issue(
            "SELECTION_NOT_FIRST",
            `${path}/selectedCandidateId`,
            "选中候选必须位于排序首位",
          ),
        );
      }
      const selected = groupCandidatesList?.find(
        (candidate) => candidate.id === decision.selectedCandidateId,
      );
      if (!selected) {
        errors.push(
          issue(
            "UNKNOWN_SELECTED_CANDIDATE",
            `${path}/selectedCandidateId`,
            "选中候选不属于该 Base 组",
          ),
        );
      } else if (selected.coveragePixelCount !== selected.pixelCount) {
        errors.push(
          issue(
            "INCOMPLETE_SELECTED_CANDIDATE",
            `${path}/selectedCandidateId`,
            "选中候选不能完整覆盖该 Base 组",
          ),
        );
      }
    }
    rejectForbiddenEvidence(decision.explanation, `${path}/explanation`, errors);
  }
  for (const groupId of groups.keys()) {
    if (!seenGroups.has(groupId)) {
      errors.push(
        issue(
          "MISSING_TARGET_GROUP",
          "/decisions",
          `缺少 Base 目标组决策：${groupId}`,
        ),
      );
    }
  }

  const selectedCount = proposal.decisions.filter(
    (decision) => decision.selectedCandidateId !== null,
  ).length;
  const reportStats = stats(
    groups.size,
    proposal.decisions.length,
    candidates.length,
    selectedCount,
  );
  if (errors.length > 0) return invalidResult(proposal, errors, reportStats);
  return {
    proposal,
    report: reportOf(true, [], reportStats) as ReplacementPlanValidationReport & {
      valid: true;
    },
  };
}

function groupCandidates(
  candidates: readonly PublicRestorationCandidate[],
): Map<string, readonly PublicRestorationCandidate[]> {
  const groups = new Map<string, PublicRestorationCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.targetGroupId) ?? [];
    group.push(candidate);
    groups.set(candidate.targetGroupId, group);
  }
  return new Map(
    [...groups.entries()].sort(([left], [right]) => compareString(left, right)),
  );
}

function rejectForbiddenEvidence(
  value: string,
  path: string,
  errors: ReplacementPlanValidationIssue[],
): void {
  if (FORBIDDEN_EVIDENCE_PATTERNS.some((pattern) => pattern.test(value))) {
    errors.push(
      issue(
        "FORBIDDEN_PRIVATE_EVIDENCE",
        path,
        "解释不得包含像素、颜色、遮罩、坐标或图像证据",
      ),
    );
  }
}

function schemaIssues(
  errors: readonly ErrorObject[],
): ReplacementPlanValidationIssue[] {
  return errors.map((error) =>
    issue(
      "SCHEMA_INVALID",
      error.instancePath || "/",
      error.message ?? "JSON Schema 校验失败",
      { keyword: error.keyword, params: error.params },
    ),
  );
}

function invalidResult(
  proposal: ReplacementPlanProposal | null,
  errors: readonly ReplacementPlanValidationIssue[],
  reportStats: ReplacementPlanValidationReport["stats"],
): ReplacementPlanValidationResult {
  return {
    proposal,
    report: reportOf(false, errors, reportStats) as ReplacementPlanValidationReport & {
      valid: false;
    },
  };
}

function reportOf(
  valid: boolean,
  errors: readonly ReplacementPlanValidationIssue[],
  reportStats: ReplacementPlanValidationReport["stats"],
): ReplacementPlanValidationReport {
  return {
    schemaVersion: "1.0",
    validatorVersion: REPLACEMENT_PLAN_VALIDATOR_VERSION,
    valid,
    errors,
    stats: reportStats,
  };
}

function stats(
  targetGroupCount: number,
  decisionCount: number,
  candidateCount: number,
  selectedCount: number,
): ReplacementPlanValidationReport["stats"] {
  return {
    targetGroupCount,
    decisionCount,
    candidateCount,
    selectedCount,
    deferredCount: Math.max(0, decisionCount - selectedCount),
  };
}

function issue(
  code: string,
  path: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ReplacementPlanValidationIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}

function sameExactSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((item) => right.includes(item))
  );
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
