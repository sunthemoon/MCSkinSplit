import { createHash } from "node:crypto";
import {
  validateCompletionProposalHashes,
  validateCompletionProposalSource,
  type CompletionHashCanonical,
} from "@mc-skin-split/skin-core";
import type { CompletionRankingPack } from "@mc-skin-split/skin-analysis-pack";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import {
  COMPLETION_RANKING_SCHEMA,
  COMPLETION_RANKING_VALIDATOR_VERSION,
} from "./schema";
import type {
  CompletionRankingProposal,
  CompletionRankingValidationIssue,
  CompletionRankingValidationReport,
  CompletionRankingValidationResult,
} from "./types";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});
const validateSchema = ajv.compile(COMPLETION_RANKING_SCHEMA);
const hashCanonical: CompletionHashCanonical = (canonicalJson) =>
  `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
const FORBIDDEN_OUTPUT_PATTERNS = [
  /\bpixels?\b/iu,
  /像素/iu,
  /\bmasks?\b/iu,
  /遮罩/iu,
  /\bspans?\b/iu,
  /坐标/iu,
  /\brgba?\b/iu,
  /#[0-9a-f]{6,8}\b/iu,
  /\b(?:skin_texel|latent_component|representation)\b/iu,
  /\b(?:accept|accepted|acceptance)\b/iu,
  /(?:接受|采纳|自动应用)/u,
  /sha256:[0-9a-f]{64}/iu,
  /\b[0-9a-f]{64}\b/iu,
];

export function validateCompletionRankingProposal(input: {
  readonly proposal: unknown;
  readonly pack: CompletionRankingPack;
}): CompletionRankingValidationResult {
  const errors: CompletionRankingValidationIssue[] = [];
  validatePackBinding(input.pack, errors);
  const candidateIds = input.pack.completionProposal.candidates.map(
    (candidate) => candidate.candidateId,
  );
  const emptyStats = stats(candidateIds.length, 0, null);
  if (!validateSchema(input.proposal)) {
    errors.push(...schemaIssues(validateSchema.errors ?? []));
    return invalidResult(null, errors, emptyStats);
  }

  const proposal = input.proposal as unknown as CompletionRankingProposal;
  if (proposal.jobId !== input.pack.job.jobId) {
    errors.push(issue("JOB_ID_MISMATCH", "/jobId", "Completion ranking Job 不一致"));
  }
  if (proposal.proposalId !== input.pack.evidence.proposalId) {
    errors.push(
      issue(
        "PROPOSAL_ID_MISMATCH",
        "/proposalId",
        "Completion ranking Proposal 不一致",
      ),
    );
  }
  if (proposal.proposalHash !== input.pack.evidence.proposalHash) {
    errors.push(
      issue(
        "PROPOSAL_HASH_MISMATCH",
        "/proposalHash",
        "Completion ranking Proposal hash 不一致",
      ),
    );
  }
  if (proposal.sourceRevisionId !== input.pack.evidence.sourceRevisionId) {
    errors.push(
      issue(
        "SOURCE_REVISION_MISMATCH",
        "/sourceRevisionId",
        "Completion ranking 来源 Revision 不一致",
      ),
    );
  }
  if (proposal.sourceResultHash !== input.pack.evidence.sourceResultHash) {
    errors.push(
      issue(
        "SOURCE_RESULT_HASH_MISMATCH",
        "/sourceResultHash",
        "Completion ranking 来源 Result hash 不一致",
      ),
    );
  }
  if (proposal.sourceSkinHash !== input.pack.evidence.sourceSkinHash) {
    errors.push(
      issue(
        "SOURCE_SKIN_HASH_MISMATCH",
        "/sourceSkinHash",
        "Completion ranking 来源 Skin hash 不一致",
      ),
    );
  }

  const seenCandidateIds = new Set<string>();
  for (const [index, ranking] of proposal.rankings.entries()) {
    const path = `/rankings/${index}`;
    if (!candidateIds.includes(ranking.candidateId)) {
      errors.push(
        issue(
          "UNKNOWN_CANDIDATE_ID",
          `${path}/candidateId`,
          `Completion ranking 包含未知候选：${ranking.candidateId}`,
        ),
      );
    }
    if (seenCandidateIds.has(ranking.candidateId)) {
      errors.push(
        issue(
          "DUPLICATE_CANDIDATE_ID",
          `${path}/candidateId`,
          `Completion ranking 重复候选：${ranking.candidateId}`,
        ),
      );
    }
    seenCandidateIds.add(ranking.candidateId);
    validateExplanation(ranking.explanation, `${path}/explanation`, errors);
  }
  if (!sameExactSet(proposal.rankings.map((ranking) => ranking.candidateId), candidateIds)) {
    errors.push(
      issue(
        "RANKING_NOT_EXACT_PERMUTATION",
        "/rankings",
        "Completion ranking 必须恰好排序全部 Host 候选",
      ),
    );
  }

  const recommendation = proposal.recommendation;
  validateExplanation(
    recommendation.explanation,
    "/recommendation/explanation",
    errors,
  );
  if (recommendation.status === "defer") {
    if (recommendation.candidateId !== null) {
      errors.push(
        issue(
          "DEFER_CANDIDATE_NOT_NULL",
          "/recommendation/candidateId",
          "defer recommendation 必须使用 null candidateId",
        ),
      );
    }
  } else {
    if (recommendation.candidateId === null) {
      errors.push(
        issue(
          "RECOMMEND_CANDIDATE_REQUIRED",
          "/recommendation/candidateId",
          "recommend recommendation 必须引用一个 Host 候选",
        ),
      );
    } else if (!candidateIds.includes(recommendation.candidateId)) {
      errors.push(
        issue(
          "UNKNOWN_RECOMMENDED_CANDIDATE",
          "/recommendation/candidateId",
          "recommendation 引用了未知候选",
        ),
      );
    } else if (proposal.rankings[0]?.candidateId !== recommendation.candidateId) {
      errors.push(
        issue(
          "RECOMMENDATION_NOT_FIRST",
          "/recommendation/candidateId",
          "推荐候选必须位于排序首位",
        ),
      );
    }
  }

  const reportStats = stats(
    candidateIds.length,
    proposal.rankings.length,
    recommendation,
  );
  if (errors.length > 0) return invalidResult(proposal, errors, reportStats);
  return {
    proposal,
    report: reportOf(true, [], reportStats) as CompletionRankingValidationReport & {
      readonly valid: true;
    },
  };
}

function validatePackBinding(
  pack: CompletionRankingPack,
  errors: CompletionRankingValidationIssue[],
): void {
  const jobHash = pack.fileHashes["job.json"];
  if (jobHash !== hashJson(pack.job)) {
    errors.push(
      issue(
        "PACK_JOB_HASH_INVALID",
        "/",
        "Completion ranking Job 与分析包文件 hash 不一致",
      ),
    );
  }
  const evidenceHash = pack.fileHashes[pack.paths.evidence];
  if (evidenceHash !== hashJson(pack.evidence)) {
    errors.push(
      issue(
        "PACK_EVIDENCE_HASH_INVALID",
        "/",
        "Completion ranking evidence 与分析包文件 hash 不一致",
      ),
    );
  }
  try {
    validateCompletionProposalSource(pack.completionProposal, pack.source);
  } catch (error) {
    errors.push(
      issue(
        "PACK_SOURCE_INVALID",
        "/",
        error instanceof Error ? error.message : "Completion ranking 来源无效",
      ),
    );
  }
  try {
    validateCompletionProposalHashes(pack.completionProposal, hashCanonical);
  } catch (error) {
    errors.push(
      issue(
        "PACK_PROPOSAL_HASH_INVALID",
        "/",
        error instanceof Error ? error.message : "Completion ranking hash 无效",
      ),
    );
  }

  const proposal = pack.completionProposal;
  const evidence = pack.evidence;
  if (
    evidence.proposalId !== proposal.proposalId ||
    evidence.proposalHash !== proposal.proposalHash ||
    evidence.proposalEvidenceHash !== proposal.evidenceHash ||
    evidence.sourceRevisionId !== proposal.sourceRevisionId ||
    evidence.sourceResultHash !== proposal.sourceResultHash ||
    evidence.sourceSkinHash !== proposal.sourceSkinHash ||
    evidence.armType !== proposal.armType ||
    evidence.targetComponentId !== proposal.targetComponentId ||
    !stringArraysEqual(evidence.occludingComponentIds, proposal.occludingComponentIds) ||
    evidence.requestedRepresentation !== proposal.requestedRepresentation ||
    evidence.representation !== proposal.representation ||
    evidence.allowedGeneratedPixelCount !== proposal.allowedGeneratedPixelCount ||
    evidence.candidateCount !== proposal.candidates.length ||
    evidence.candidates.length !== proposal.candidates.length
  ) {
    errors.push(
      issue(
        "PACK_EVIDENCE_MISMATCH",
        "/",
        "Completion ranking evidence 与 Host Proposal 不一致",
      ),
    );
  }
  for (const [index, candidate] of proposal.candidates.entries()) {
    const item = evidence.candidates[index];
    if (
      !item ||
      item.candidateId !== candidate.candidateId ||
      item.candidateHash !== candidate.candidateHash ||
      item.evidenceHash !== candidate.evidenceHash ||
      item.strategy !== candidate.strategy ||
      item.complete !== candidate.complete ||
      item.confidence !== candidate.confidence ||
      item.confidenceScore !== candidate.confidenceScore ||
      item.pixelCount !== candidate.pixelCount ||
      item.missingPixelCount !== candidate.missingPixelCount
    ) {
      errors.push(
        issue(
          "PACK_CANDIDATE_EVIDENCE_MISMATCH",
          `/evidence/candidates/${index}`,
          "Completion ranking candidate evidence 与 Host 候选不一致",
        ),
      );
    }
  }

  const expectedAttachments = [
    {
      role: "source_skin" as const,
      path: pack.paths.sourcePreview,
      candidateId: null,
    },
    ...evidence.candidates.map((candidate) => ({
      role: "candidate_preview" as const,
      path: candidate.previewPath,
      candidateId: candidate.candidateId,
    })),
  ];
  if (
    !attachmentsEqual(pack.imageAttachments, expectedAttachments) ||
    !attachmentsEqual(pack.job.imageAttachments, expectedAttachments) ||
    !stringArraysEqual(
      pack.imagePaths,
      expectedAttachments.map((attachment) => attachment.path),
    )
  ) {
    errors.push(
      issue(
        "PACK_ATTACHMENT_MISMATCH",
        "/",
        "Completion ranking preview attachment 顺序或候选绑定无效",
      ),
    );
  }
}

function validateExplanation(
  value: string,
  path: string,
  errors: CompletionRankingValidationIssue[],
): void {
  if (!value.trim()) {
    errors.push(issue("EXPLANATION_BLANK", path, "Completion ranking 解释不能为空"));
  }
  if (value.includes("\0")) {
    errors.push(
      issue("EXPLANATION_INVALID", path, "Completion ranking 解释包含无效字符"),
    );
  }
  if (FORBIDDEN_OUTPUT_PATTERNS.some((pattern) => pattern.test(value))) {
    errors.push(
      issue(
        "FORBIDDEN_COMPLETION_OUTPUT",
        path,
        "解释不得输出像素、遮罩、span、表示形式、hash 或接受操作",
      ),
    );
  }
}

function schemaIssues(
  errors: readonly ErrorObject[],
): CompletionRankingValidationIssue[] {
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
  proposal: CompletionRankingProposal | null,
  errors: readonly CompletionRankingValidationIssue[],
  reportStats: CompletionRankingValidationReport["stats"],
): CompletionRankingValidationResult {
  return {
    proposal,
    report: reportOf(false, errors, reportStats) as CompletionRankingValidationReport & {
      readonly valid: false;
    },
  };
}

function reportOf(
  valid: boolean,
  errors: readonly CompletionRankingValidationIssue[],
  reportStats: CompletionRankingValidationReport["stats"],
): CompletionRankingValidationReport {
  return {
    schemaVersion: "1.0",
    validatorVersion: COMPLETION_RANKING_VALIDATOR_VERSION,
    valid,
    errors,
    stats: reportStats,
  };
}

function stats(
  candidateCount: number,
  rankingCount: number,
  recommendation: CompletionRankingProposal["recommendation"] | null,
): CompletionRankingValidationReport["stats"] {
  return {
    candidateCount,
    rankingCount,
    recommendationCount:
      recommendation?.status === "recommend" && recommendation.candidateId !== null
        ? 1
        : 0,
    deferred: recommendation?.status === "defer",
  };
}

function issue(
  code: string,
  path: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CompletionRankingValidationIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}

function sameExactSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((item) => right.includes(item))
  );
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function attachmentsEqual(
  left: CompletionRankingPack["imageAttachments"],
  right: CompletionRankingPack["imageAttachments"],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.role === right[index]?.role &&
        item.path === right[index]?.path &&
        item.candidateId === right[index]?.candidateId,
    )
  );
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
