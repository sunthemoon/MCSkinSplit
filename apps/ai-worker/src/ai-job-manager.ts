import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_SKILL_NAME,
  AI_SKILL_VERSION,
  ANALYSIS_PROPOSAL_SCHEMA,
  AiProviderError,
  COMPLETION_RANKING_SCHEMA,
  REPLACEMENT_PLAN_SCHEMA,
  REPLACEMENT_PLANNER_SKILL_NAME,
  REPLACEMENT_PLANNER_SKILL_VERSION,
  validateAnalysisProposal,
  validateCompletionRankingProposal,
  validateReplacementPlanProposal,
  type CompletionRankingValidationReport,
  type ProposalValidationReport,
  type ProviderProgressEvent,
  type ReplacementPlanValidationReport,
  type SkinSemanticAiProvider,
} from "@mc-skin-split/ai-provider";
import {
  ANALYSIS_REASONING_EFFORTS,
  PROMPT_VERSION,
  COMPLETION_RANKING_PACK_SCHEMA_VERSION,
  COMPLETION_RANKING_PROMPT_VERSION,
  REPLACEMENT_PLANNING_PROMPT_VERSION,
  SEMANTIC_FOLLOWUP_ALGORITHM_VERSION,
  assessSemanticFollowup,
  buildAnalysisPack,
  buildCompletionRankingPack,
  buildReplacementPlanningPack,
  createAnalysisDocuments,
  verifyAnalysisPackIntegrity,
  verifyCompletionRankingPackIntegrity,
  verifyReplacementPlanningPackIntegrity,
  type PublicRestorationCandidateCatalog,
} from "@mc-skin-split/skin-analysis-pack";
import {
  COMPLETION_CANDIDATE_ALGORITHM_VERSION,
  COMPLETION_PROPOSAL_SCHEMA_VERSION,
  MAX_COMPLETION_OCCLUDING_COMPONENTS,
  canonicalCompletionJson,
  decodeSkinPng,
  generateCompletionProposalCandidates,
  getSkinLayout,
  type CompletionSourceSnapshot,
} from "@mc-skin-split/skin-core";
import {
  RevisionStore,
  RevisionStoreError,
  type AcceptCompletionCandidateInput,
  type CompletionProposalDetail,
  type CompletionProposalListQuery,
  type CompletionProposalRankingInput,
  type OperationSnapshot,
  type RejectCompletionProposalInput,
  type SkinPart,
  type SkinRevision,
} from "@mc-skin-split/skin-revision";
import {
  AiJobStore,
  AiJobStoreError,
  isTerminal,
} from "./ai-job-store";
import { AiRunStorage } from "./run-storage";
import type {
  AiAnalysisOptions,
  AiCompletionProposalOptions,
  AiJob,
  AiJobDetail,
  AiJobError,
  AiJobListFilters,
  AiRestorationRecommendationOptions,
  AiRun,
  AiRunFileRole,
  SemanticAnalysisFollowup,
  SemanticAnalysisAiJob,
  CompletionProposalAiJob,
  StartCompletionProposalInput,
  StartAiRestorationRecommendationInput,
  StoredSemanticFollowup,
} from "./types";

export const COMPLETION_JOB_PROVIDER = "deterministic_host" as const;
export const COMPLETION_JOB_SKILL_NAME = "mc-skin-completion-host" as const;
export const COMPLETION_JOB_PROMPT_VERSION = "completion-host-v1" as const;
export const COMPLETION_RANKING_JOB_SKILL_NAME =
  "mc-skin-completion-ranker" as const;
const COMPLETION_RANKING_RUN_FILE_ROLES = [
  "input_manifest",
  "raw_events",
  "raw_output",
  "stderr",
  "validator_report",
] as const satisfies readonly AiRunFileRole[];

export interface CompletionRankingConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AiAnalysisOptions["reasoningEffort"];
}

export interface AiJobManagerOptions {
  readonly revisionStore: RevisionStore;
  readonly providers: readonly SkinSemanticAiProvider[];
  readonly dataDirectory?: string;
  readonly skillDirectory?: string;
  readonly replacementSkillDirectory?: string;
  readonly jobStore?: AiJobStore;
  readonly maxRepairAttempts?: number;
  readonly recoverInterruptedJobs?: boolean;
  readonly semanticFollowupAssessor?: typeof assessSemanticFollowup;
  readonly completionRanking?: CompletionRankingConfiguration;
}

export class AiJobManager {
  readonly revisionStore: RevisionStore;
  readonly jobStore: AiJobStore;
  readonly runStorage: AiRunStorage;
  readonly skillDirectory: string;
  readonly replacementSkillDirectory: string;
  readonly maxRepairAttempts: number;
  private readonly semanticFollowupAssessor: typeof assessSemanticFollowup;
  private readonly completionRanking: CompletionRankingConfiguration | null;
  private readonly providers = new Map<string, SkinSemanticAiProvider>();
  private readonly active = new Map<
    string,
    { readonly controller: AbortController; readonly promise: Promise<void> }
  >();
  private readonly semanticFollowupActions = new Map<
    string,
    {
      readonly actionKey: string;
      readonly promise: Promise<AiJobDetail>;
    }
  >();
  private readonly ownsJobStore: boolean;
  private readonly recoveryPromise: Promise<void>;
  private closed = false;

  constructor(options: AiJobManagerOptions) {
    this.revisionStore = options.revisionStore;
    const dataDirectory = resolve(
      options.dataDirectory ?? options.revisionStore.dataDirectory,
    );
    this.jobStore =
      options.jobStore ??
      new AiJobStore({ databasePath: options.revisionStore.databasePath });
    this.ownsJobStore = !options.jobStore;
    this.runStorage = new AiRunStorage(dataDirectory);
    this.skillDirectory = resolve(
      options.skillDirectory ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../../.agents/skills/mc-skin-segmenter",
        ),
    );
    this.replacementSkillDirectory = resolve(
      options.replacementSkillDirectory ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../../.agents/skills/mc-skin-replacement-planner",
        ),
    );
    this.maxRepairAttempts = options.maxRepairAttempts ?? 1;
    this.semanticFollowupAssessor =
      options.semanticFollowupAssessor ?? assessSemanticFollowup;
    this.completionRanking = options.completionRanking
      ? normalizeCompletionRankingConfiguration(options.completionRanking)
      : null;
    if (
      !Number.isInteger(this.maxRepairAttempts) ||
      this.maxRepairAttempts < 0 ||
      this.maxRepairAttempts > 3
    ) {
      throw new TypeError("maxRepairAttempts must be an integer from 0 to 3");
    }
    for (const provider of options.providers) {
      if (this.providers.has(provider.providerName)) {
        throw new TypeError(`Duplicate AI provider: ${provider.providerName}`);
      }
      this.providers.set(provider.providerName, provider);
    }
    if (this.providers.size === 0) throw new TypeError("At least one AI provider is required");
    if (this.completionRanking) {
      this.requireCompletionRankingProvider(this.completionRanking.provider);
    }
    this.recoveryPromise = options.recoverInterruptedJobs ?? true
      ? this.recoverInterruptedJobs()
      : Promise.resolve();
  }

  listProviders(): readonly string[] {
    return [...this.providers.keys()].sort();
  }

  listRestorationRecommendationProviders(): readonly string[] {
    return [...this.providers.values()]
      .filter((provider) => typeof provider.recommendReplacement === "function")
      .map((provider) => provider.providerName)
      .sort();
  }

  listCompletionRankingProviders(): readonly string[] {
    return [...this.providers.values()]
      .filter((provider) => typeof provider.rankCompletion === "function")
      .map((provider) => provider.providerName)
      .sort();
  }

  async startAnalysis(
    sourceRevisionId: string,
    options: AiAnalysisOptions,
  ): Promise<AiJob> {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    this.requireProvider(options.provider);
    const revision = this.revisionStore.getRevision(sourceRevisionId);
    if (options.createRevisionOnSuccess) {
      let branch = this.revisionStore.getBranch(revision.branchId);
      if (branch.headRevisionId !== revision.id) {
        throw new AiJobStoreError(
          "AI_JOB_CONFLICT",
          "只能分析并提交所选 Branch 的最新 Revision",
          409,
          { sourceRevisionId, branchHeadRevisionId: branch.headRevisionId },
        );
      }
      await this.assertSemanticAnalysisSourceEligible(revision.id);
      branch = this.revisionStore.getBranch(revision.branchId);
      if (branch.headRevisionId !== revision.id) {
        throw new AiJobStoreError(
          "AI_JOB_CONFLICT",
          "只能分析并提交所选 Branch 的最新 Revision",
          409,
          { sourceRevisionId, branchHeadRevisionId: branch.headRevisionId },
        );
      }
    }
    const job = this.jobStore.createJob({
      kind: "semantic_analysis",
      projectId: revision.projectId,
      inputRevisionId: revision.id,
      options: normalizeOptions(options),
      skillName: AI_SKILL_NAME,
      skillVersion: AI_SKILL_VERSION,
      promptVersion: PROMPT_VERSION,
    });
    this.schedule(job.id);
    return job;
  }

  async startRestorationRecommendation(
    compositionId: string,
    input: StartAiRestorationRecommendationInput,
  ): Promise<AiJob> {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    this.requireReplacementProvider(input.provider);
    const composition = this.revisionStore.getComposition(compositionId);
    if (composition.status !== "draft") {
      throw new AiJobStoreError(
        "AI_RESTORATION_CONFLICT",
        "只能为可编辑的混搭工程生成 AI 建议",
        409,
        { compositionId },
      );
    }
    const options = normalizeRestorationRecommendationOptions({
      ...input,
      mode: "restoration_recommendation",
      compositionId,
    });
    const candidates = await this.regenerateRestorationCandidates(options);
    const currentComposition = this.revisionStore.getComposition(compositionId);
    if (
      currentComposition.status !== "draft" ||
      currentComposition.restorationVersion !== options.compositionVersion ||
      candidates.version !== options.compositionVersion ||
      candidates.candidateSetHash !== options.candidateSetHash
    ) {
      throw staleRestorationRecommendation(options, {
        version: candidates.version,
        candidateSetHash: candidates.candidateSetHash,
      });
    }
    const job = this.jobStore.createJob({
      kind: "restoration_recommendation",
      projectId: currentComposition.projectId,
      inputRevisionId: currentComposition.baseRevisionId,
      compositionId: currentComposition.id,
      options,
      skillName: REPLACEMENT_PLANNER_SKILL_NAME,
      skillVersion: REPLACEMENT_PLANNER_SKILL_VERSION,
      promptVersion: REPLACEMENT_PLANNING_PROMPT_VERSION,
    });
    this.schedule(job.id);
    return job;
  }

  async startCompletionProposal(
    sourceRevisionId: string,
    input: StartCompletionProposalInput,
  ): Promise<CompletionProposalAiJob> {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    const options = normalizeCompletionProposalOptions(
      input,
      this.completionRanking,
    );
    const revision = this.revisionStore.getRevision(sourceRevisionId);
    const [state, originDocument] = await Promise.all([
      this.revisionStore.readRevisionSemanticState(revision.id),
      this.revisionStore.readRevisionOrigin(revision.id),
    ]);
    if (!originDocument) {
      throw new AiJobStoreError(
        "COMPLETION_SOURCE_ORIGIN_REQUIRED",
        "隐藏内容候选需要带逐像素来源的 Revision",
        409,
        { sourceRevisionId: revision.id },
      );
    }
    const componentIds = new Set(
      state.document.components.map((component) => component.instanceId),
    );
    if (!componentIds.has(options.targetComponentId)) {
      throw new AiJobStoreError(
        "INVALID_COMPLETION_PROPOSAL",
        "目标组件不属于来源 Revision",
        400,
        { targetComponentId: options.targetComponentId },
      );
    }
    const missingOccluders = options.occludingComponentIds.filter(
      (componentId) => !componentIds.has(componentId),
    );
    if (missingOccluders.length > 0) {
      throw new AiJobStoreError(
        "INVALID_COMPLETION_PROPOSAL",
        "遮挡组件不属于来源 Revision",
        400,
        { occludingComponentIds: missingOccluders },
      );
    }
    const job = this.jobStore.createJob({
      kind: "completion_proposal",
      projectId: revision.projectId,
      inputRevisionId: revision.id,
      options,
      skillName: options.rankingMode === "ai"
        ? COMPLETION_RANKING_JOB_SKILL_NAME
        : COMPLETION_JOB_SKILL_NAME,
      skillVersion: options.rankingMode === "ai"
        ? COMPLETION_RANKING_PACK_SCHEMA_VERSION
        : COMPLETION_PROPOSAL_SCHEMA_VERSION,
      promptVersion: options.rankingMode === "ai"
        ? COMPLETION_RANKING_PROMPT_VERSION
        : COMPLETION_JOB_PROMPT_VERSION,
    });
    this.schedule(job.id);
    return job;
  }

  async retryJob(
    jobId: string,
    overrides: Partial<
      Pick<
        AiAnalysisOptions,
        | "provider"
        | "model"
        | "reasoningEffort"
        | "createRevisionOnSuccess"
        | "semanticBaseline"
      >
    > = {},
  ): Promise<AiJob> {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    const source = this.jobStore.getJob(jobId);
    if (!isTerminal(source.status)) {
      throw new AiJobStoreError(
        "AI_JOB_CONFLICT",
        "运行中的 AI Job 不能创建重试",
        409,
      );
    }
    if (source.kind === "completion_proposal") {
      if (source.status === "succeeded") {
        throw new AiJobStoreError(
          "COMPLETION_RETRY_UNSUPPORTED",
          "已完成的隐藏内容候选具有不可变提案，请直接使用现有结果",
          409,
          {
            jobId: source.id,
            sourceRevisionId: source.inputRevisionId,
            requiredAction: "use_existing_proposal",
          },
        );
      }
      if (Object.values(overrides).some((value) => value !== undefined)) {
        throw new AiJobStoreError(
          "INVALID_AI_JOB",
          "确定性隐藏内容候选重试不接受 AI 分析选项",
          400,
        );
      }
      const currentContract = source.options.rankingMode === "host_only"
        ? source.skillName === COMPLETION_JOB_SKILL_NAME &&
          source.skillVersion === COMPLETION_PROPOSAL_SCHEMA_VERSION &&
          source.promptVersion === COMPLETION_JOB_PROMPT_VERSION &&
          source.provider === COMPLETION_JOB_PROVIDER &&
          source.model === COMPLETION_CANDIDATE_ALGORITHM_VERSION
        : source.skillName === COMPLETION_RANKING_JOB_SKILL_NAME &&
          source.skillVersion === COMPLETION_RANKING_PACK_SCHEMA_VERSION &&
          source.promptVersion === COMPLETION_RANKING_PROMPT_VERSION;
      if (!currentContract) {
        throw new AiJobStoreError(
          "COMPLETION_RETRY_CONTRACT_STALE",
          "历史隐藏内容候选合同已变化，请从来源 Revision 新建候选",
          409,
          {
            jobId: source.id,
            sourceRevisionId: source.inputRevisionId,
            requiredAction: "start_fresh_completion_proposal",
          },
        );
      }
      if (source.options.rankingMode === "ai") {
        this.requireCompletionRankingProvider(source.provider);
      }
      const retry = this.jobStore.createJob({
        kind: "completion_proposal",
        projectId: source.projectId,
        inputRevisionId: source.inputRevisionId,
        options: source.options,
        skillName: source.skillName,
        skillVersion: source.skillVersion,
        promptVersion: source.promptVersion,
        retryOfJobId: source.id,
      });
      this.schedule(retry.id);
      return retry;
    }
    if (source.kind === "restoration_recommendation") {
      if (
        overrides.createRevisionOnSuccess !== undefined ||
        overrides.semanticBaseline !== undefined
      ) {
        throw new AiJobStoreError(
          "INVALID_AI_JOB",
          "AI 换装建议不接受语义识别选项",
          400,
        );
      }
      const options = normalizeRestorationRecommendationOptions({
        ...source.options,
        ...(overrides.provider ? { provider: overrides.provider } : {}),
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(overrides.reasoningEffort
          ? { reasoningEffort: overrides.reasoningEffort }
          : {}),
      });
      this.requireReplacementProvider(options.provider);
      await this.assertRestorationRecommendationFresh(options);
      const retry = this.jobStore.createJob({
        kind: "restoration_recommendation",
        projectId: source.projectId,
        inputRevisionId: source.inputRevisionId,
        compositionId: options.compositionId,
        options,
        skillName: REPLACEMENT_PLANNER_SKILL_NAME,
        skillVersion: REPLACEMENT_PLANNER_SKILL_VERSION,
        promptVersion: REPLACEMENT_PLANNING_PROMPT_VERSION,
        retryOfJobId: source.id,
      });
      this.schedule(retry.id);
      return retry;
    }
    if (
      source.skillName !== AI_SKILL_NAME ||
      source.skillVersion !== AI_SKILL_VERSION ||
      source.promptVersion !== PROMPT_VERSION
    ) {
      throw staleSemanticAnalysisRetryContract(source);
    }
    const options = normalizeOptions({
      ...source.options,
      ...(overrides.provider ? { provider: overrides.provider } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
      ...(overrides.reasoningEffort
        ? { reasoningEffort: overrides.reasoningEffort }
        : {}),
      ...(overrides.createRevisionOnSuccess !== undefined
        ? { createRevisionOnSuccess: overrides.createRevisionOnSuccess }
        : {}),
      ...(overrides.semanticBaseline
        ? { semanticBaseline: overrides.semanticBaseline }
        : {}),
    });
    this.requireProvider(options.provider);
    const revision = this.revisionStore.getRevision(source.inputRevisionId);
    if (options.createRevisionOnSuccess) {
      let branch = this.revisionStore.getBranch(revision.branchId);
      if (branch.headRevisionId !== revision.id) {
        throw new AiJobStoreError(
          "AI_JOB_CONFLICT",
          "来源 Revision 已不是 Branch HEAD，请在最新 Revision 新建分析",
          409,
        );
      }
      await this.assertSemanticAnalysisSourceEligible(revision.id);
      branch = this.revisionStore.getBranch(revision.branchId);
      if (branch.headRevisionId !== revision.id) {
        throw new AiJobStoreError(
          "AI_JOB_CONFLICT",
          "来源 Revision 已不是 Branch HEAD，请在最新 Revision 新建分析",
          409,
        );
      }
    }
    const retry = this.jobStore.createJob({
      kind: "semantic_analysis",
      projectId: source.projectId,
      inputRevisionId: source.inputRevisionId,
      options,
      skillName: AI_SKILL_NAME,
      skillVersion: AI_SKILL_VERSION,
      promptVersion: PROMPT_VERSION,
      retryOfJobId: source.id,
    });
    this.schedule(retry.id);
    return retry;
  }

  cancelJob(jobId: string): AiJob {
    const job = this.jobStore.requestCancellation(jobId);
    this.active.get(jobId)?.controller.abort();
    if (!this.active.has(jobId) && !isTerminal(job.status)) {
      const taskName = aiTaskName(job);
      return this.jobStore.transitionJob(job.id, "cancelled", `${taskName}已取消`, {
        error: { code: "AI_CANCELLED", message: `用户取消了${taskName}` },
      });
    }
    return this.jobStore.getJob(jobId);
  }

  getJobDetail(jobId: string): AiJobDetail {
    const job = this.jobStore.getJob(jobId);
    const runs = this.jobStore.listRuns(job.id).map((run) => ({
      ...run,
      assets: this.jobStore.listRunAssets(run.id),
    }));
    return {
      job,
      runs,
      events: this.jobStore.listEvents(job.id),
      semanticFollowup:
        job.kind === "semantic_analysis"
          ? publicSemanticFollowup(this.jobStore.getSemanticFollowup(job.id))
          : null,
    };
  }

  async listCompletionProposals(query: CompletionProposalListQuery = {}) {
    await this.recoveryPromise;
    const proposals = await this.revisionStore.listCompletionProposals(query);
    return proposals.filter((summary) => {
      const job = this.jobStore.getJob(summary.proposal.jobId);
      return job.kind === "completion_proposal" &&
        job.status === "succeeded" &&
        job.outputHash === summary.proposal.proposalHash;
    });
  }

  async getCompletionProposalDetail(proposalId: string) {
    await this.recoveryPromise;
    const detail = await this.revisionStore.getCompletionProposalDetail(proposalId);
    const job = this.jobStore.getJob(detail.proposal.jobId);
    if (
      job.kind !== "completion_proposal" ||
      job.status !== "succeeded" ||
      job.outputHash !== detail.proposal.proposalHash
    ) {
      throw new AiJobStoreError(
        "COMPLETION_PROPOSAL_NOT_FOUND",
        `隐藏内容候选提案不存在：${proposalId}`,
        404,
      );
    }
    return detail;
  }

  async acceptCompletionCandidate(
    proposalId: string,
    input: Omit<AcceptCompletionCandidateInput, "action">,
  ) {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    const outcome = await this.revisionStore.acceptCompletionCandidate(
      proposalId,
      input,
    );
    if (outcome.changed) {
      this.jobStore.appendEvent(
        outcome.detail.proposal.jobId,
        "completion_candidate_accepted",
        "隐藏内容候选已由用户接受",
        {
          proposalId,
          candidateId: input.candidateId,
          representation: outcome.detail.proposal.representation,
        },
      );
    }
    return outcome;
  }

  async rejectCompletionProposal(
    proposalId: string,
    input: Omit<RejectCompletionProposalInput, "action">,
  ) {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    const outcome = await this.revisionStore.rejectCompletionProposal(
      proposalId,
      input,
    );
    if (outcome.changed) {
      this.jobStore.appendEvent(
        outcome.detail.proposal.jobId,
        "completion_proposal_rejected",
        "隐藏内容候选提案已由用户拒绝",
        { proposalId },
      );
    }
    return outcome;
  }

  async applySemanticFollowup(
    jobId: string,
    suggestionId: string,
  ): Promise<AiJobDetail> {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    const normalizedSuggestionId = suggestionId.trim();
    return this.runSemanticFollowupAction(
      jobId,
      `apply:${normalizedSuggestionId}`,
      async () => {
        const job = requireSemanticAnalysisJob(this.jobStore.getJob(jobId));
        if (job.status !== "succeeded" || !job.resultRevisionId) {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_CONFLICT",
            "语义识别完成后才能应用修复建议",
            409,
          );
        }
        const followup = this.jobStore.getSemanticFollowup(job.id);
        if (!followup) {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_NOT_FOUND",
            "此识别结果没有修复建议",
            404,
          );
        }
        if (followup.status === "applied") {
          if (this.isAppliedSemanticFollowupSuggestion(followup, normalizedSuggestionId)) {
            return this.getJobDetail(job.id);
          }
          throw new AiJobStoreError(
            "AI_FOLLOWUP_CONFLICT",
            "此识别结果已应用另一项修复建议",
            409,
          );
        }
        if (followup.status !== "awaiting_review") {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_CONFLICT",
            "此修复建议已经处理",
            409,
            { status: followup.status },
          );
        }
        if (
          followup.assessment.algorithmVersion !==
            SEMANTIC_FOLLOWUP_ALGORITHM_VERSION
        ) {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_STALE",
            "历史分类修复建议需要使用当前算法重新分析",
            409,
            {
              storedAlgorithmVersion: followup.assessment.algorithmVersion,
              currentAlgorithmVersion: SEMANTIC_FOLLOWUP_ALGORITHM_VERSION,
            },
          );
        }
        const storedSuggestion = followup.assessment.suggestions.find(
          (suggestion) => suggestion.id === normalizedSuggestionId,
        );
        if (!storedSuggestion) {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_INVALID",
            "修复建议 ID 不属于此识别结果",
            400,
          );
        }
        const skinPng = await this.revisionStore.readRevisionSkinPng(
          followup.resultRevisionId,
        );
        const image = decodeSkinPng(skinPng);
        const state = await this.revisionStore.readRevisionSemanticState(
          followup.resultRevisionId,
        );
        const reassessed = this.semanticFollowupAssessor({
          state,
          image,
          candidateRegions: createAnalysisDocuments(
            image,
            getSkinLayout(state.document.source.armType),
          ).candidateRegions,
        });
        if (reassessed.evidenceHash !== followup.evidenceHash) {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_STALE",
            "皮肤或识别证据已经变化，请重新运行分析",
            409,
          );
        }
        const suggestion = reassessed.suggestions.find(
          (candidate) => candidate.id === normalizedSuggestionId,
        );
        if (!suggestion) {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_STALE",
            "修复建议已不再适用，请重新运行分析",
            409,
          );
        }
        const target = state.document.components.find(
          (component) => component.instanceId === suggestion.targetComponentId,
        );
        if (target && target.category !== "hair") {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_STALE",
            "建议引用的目标组件已不是头发",
            409,
          );
        }
        const operationTarget = target
          ? {
              instanceId: target.instanceId,
              displayName: target.displayName,
              category: "hair" as const,
              ...(target.subtype ? { subtype: target.subtype } : {}),
            }
          : {
              instanceId: suggestion.targetComponentId,
              displayName: "跨部位长发",
              category: "hair" as const,
            };
        const editableRevision = await this.semanticFollowupEditableRevision(
          followup.resultRevisionId,
          job.id,
          suggestion.id,
        );
        if (!editableRevision) return this.getJobDetail(job.id);
        let applied;
        try {
          applied = await this.revisionStore.applyManualOperation(
            editableRevision.id,
            {
              operation: {
                type: "assign_pixels",
                target: operationTarget,
                spans: suggestion.spans,
              },
              actorId: "semantic-followup",
              summary: `应用推荐分类修复：${suggestion.label}`,
              semanticFollowup: {
                jobId: job.id,
                resultRevisionId: followup.resultRevisionId,
                suggestionId: suggestion.id,
                evidenceHash: followup.evidenceHash,
              },
            },
          );
        } catch (error) {
          const concurrent = this.jobStore.getSemanticFollowup(job.id);
          if (concurrent?.status === "applied" && concurrent.appliedRevisionId) {
            if (this.isAppliedSemanticFollowupSuggestion(
              concurrent,
              normalizedSuggestionId,
            )) {
              return this.getJobDetail(job.id);
            }
            throw new AiJobStoreError(
              "AI_FOLLOWUP_CONFLICT",
              "此识别结果已应用另一项修复建议",
              409,
            );
          }
          throw error;
        }
        const persisted = this.jobStore.getSemanticFollowup(job.id);
        if (
          persisted?.status !== "applied" ||
          persisted.appliedRevisionId !== applied.revision.id
        ) {
          throw new AiJobStoreError(
            "AI_FOLLOWUP_CONFLICT",
            "分类修复 Revision 与持久化状态不一致",
            409,
          );
        }
        this.jobStore.appendEvent(
          job.id,
          "semantic_repair_applied",
          "推荐分类修复已创建为新 Revision",
          {
            suggestionId: suggestion.id,
            resultRevisionId: applied.revision.id,
            pixelCount: suggestion.pixelCount,
          },
        );
        this.jobStore.appendEvent(
          job.id,
          "catalog_ready",
          "分类修复版已加入分析目录",
          { resultRevisionId: applied.revision.id, variant: "semantic_repair" },
        );
        return this.getJobDetail(job.id);
      },
    );
  }

  async dismissSemanticFollowup(jobId: string): Promise<AiJobDetail> {
    this.assertOpen();
    await this.recoveryPromise;
    this.assertOpen();
    return this.runSemanticFollowupAction(jobId, "dismiss", async () => {
      const job = requireSemanticAnalysisJob(this.jobStore.getJob(jobId));
      const followup = this.jobStore.getSemanticFollowup(job.id);
      if (!followup) return this.getJobDetail(job.id);
      if (followup.status === "dismissed" || followup.status === "no_repair") {
        return this.getJobDetail(job.id);
      }
      if (followup.status !== "awaiting_review") {
        throw new AiJobStoreError(
          "AI_FOLLOWUP_CONFLICT",
          "已应用的修复版不能改为保留原识别",
          409,
        );
      }
      const transition = this.jobStore.transitionSemanticFollowup(job.id, "dismissed");
      if (!transition.changed) return this.getJobDetail(job.id);
      this.jobStore.appendEvent(
        job.id,
        "semantic_repair_dismissed",
        "已保留原识别结果",
        {},
      );
      this.jobStore.appendEvent(
        job.id,
        "catalog_ready",
        "原识别结果已保留在分析目录",
        { resultRevisionId: followup.resultRevisionId },
      );
      return this.getJobDetail(job.id);
    });
  }

  listJobs(filtersOrRevisionId?: AiJobListFilters | string): AiJob[] {
    return this.jobStore.listJobs(
      typeof filtersOrRevisionId === "string"
        ? { inputRevisionId: filtersOrRevisionId }
        : filtersOrRevisionId,
    );
  }

  async waitForJob(jobId: string): Promise<AiJob> {
    await this.recoveryPromise;
    await this.active.get(jobId)?.promise;
    return this.jobStore.getJob(jobId);
  }

  private runSemanticFollowupAction(
    jobId: string,
    actionKey: string,
    action: () => Promise<AiJobDetail>,
  ): Promise<AiJobDetail> {
    const existing = this.semanticFollowupActions.get(jobId);
    if (existing) {
      if (existing.actionKey === actionKey) return existing.promise;
      const retry = () => {
        this.assertOpen();
        return this.runSemanticFollowupAction(jobId, actionKey, action);
      };
      return existing.promise.then(retry, retry);
    }
    const promise = action().finally(() => {
      if (this.semanticFollowupActions.get(jobId)?.promise === promise) {
        this.semanticFollowupActions.delete(jobId);
      }
    });
    this.semanticFollowupActions.set(jobId, { actionKey, promise });
    return promise;
  }

  private async semanticFollowupEditableRevision(
    resultRevisionId: string,
    jobId: string,
    suggestionId: string,
  ) {
    const resultRevision = this.revisionStore.getRevision(resultRevisionId);
    const branchName = semanticFollowupBranchName(jobId, suggestionId);
    let branch = this.revisionStore
      .listBranches(resultRevision.projectId)
      .find((candidate) => candidate.name === branchName);
    if (!branch) {
      try {
        const created = await this.revisionStore.branchFromRevision(
          resultRevision.id,
          {
            name: branchName,
            actorId: "semantic-followup",
            summary: "从识别结果创建分类修复分支",
          },
        );
        return created.revision;
      } catch (error) {
        branch = this.revisionStore
          .listBranches(resultRevision.projectId)
          .find((candidate) => candidate.name === branchName);
        if (
          !branch ||
          !(error instanceof RevisionStoreError) ||
          error.code !== "CONFLICT"
        ) {
          throw error;
        }
      }
    }
    if (
      branch.baseRevisionId !== resultRevision.id ||
      !branch.headRevisionId
    ) {
      throw new AiJobStoreError(
        "AI_FOLLOWUP_CONFLICT",
        "分类修复分支与识别结果不一致",
        409,
      );
    }
    const head = this.revisionStore.getRevision(branch.headRevisionId);
    const persisted = this.jobStore.getSemanticFollowup(jobId);
    if (
      persisted?.status === "applied" &&
      persisted.appliedRevisionId === head.id
    ) {
      return null;
    }
    if (
      head.operationType !== "branch" ||
      head.parentRevisionId !== resultRevision.id
    ) {
      throw new AiJobStoreError(
        "AI_FOLLOWUP_CONFLICT",
        "分类修复分支已包含其他修改",
        409,
      );
    }
    return head;
  }

  private isAppliedSemanticFollowupSuggestion(
    followup: StoredSemanticFollowup,
    suggestionId: string,
  ): boolean {
    if (!followup.appliedRevisionId) return false;
    const revision = this.revisionStore.getRevision(followup.appliedRevisionId);
    const context = objectRecord(revision.metadata.semanticFollowup);
    return context?.jobId === followup.jobId &&
      context.resultRevisionId === followup.resultRevisionId &&
      context.evidenceHash === followup.evidenceHash &&
      context.suggestionId === suggestionId;
  }

  private recoverInterruptedJobs(): Promise<void> {
    const candidates = this.jobStore
      .listJobs({ kind: "completion_proposal" })
      .filter(
        (job): job is CompletionProposalAiJob =>
          job.kind === "completion_proposal" && job.status === "validating",
      );
    this.jobStore.failInterruptedJobs(candidates.map((job) => job.id));
    return Promise.all(
      candidates.map((job) => this.recoverInterruptedCompletionJob(job)),
    ).then(() => undefined);
  }

  private async recoverInterruptedCompletionJob(
    interruptedJob: CompletionProposalAiJob,
  ): Promise<void> {
    try {
      if (interruptedJob.cancelRequested) {
        this.cancelInterruptedCompletionJob(interruptedJob.id);
        return;
      }
      const detail = await this.revisionStore.getCompletionProposalByJobId(
        interruptedJob.id,
      );
      if (!detail) throw new Error("Completion proposal was not persisted");
      assertCompletionRecoveryContract(interruptedJob, detail);

      const current = requireCompletionProposalJob(
        this.jobStore.getJob(interruptedJob.id),
      );
      if (current.status !== "validating") return;
      if (current.cancelRequested) {
        this.cancelInterruptedCompletionJob(current.id);
        return;
      }
      this.recoverCompletionRun(current);
      this.jobStore.appendEvent(
        current.id,
        "completion_recovery_verified",
        "已验证中断前保存的隐藏内容候选",
        {
          proposalId: detail.proposal.id,
          proposalHash: detail.proposal.proposalHash,
          rankingMode: current.options.rankingMode,
        },
      );
      this.jobStore.transitionJob(
        current.id,
        "succeeded",
        "已从完整持久化候选恢复任务",
        {
          outputHash: detail.proposal.proposalHash,
          proposalSummary: detail.candidateCount > 0
            ? `已恢复 ${detail.candidateCount} 个仅供审核的隐藏内容候选`
            : "已恢复候选检查结果；没有可支持的补全候选",
        },
      );
    } catch {
      const current = requireCompletionProposalJob(
        this.jobStore.getJob(interruptedJob.id),
      );
      if (!isTerminal(current.status)) {
        if (current.cancelRequested) {
          this.cancelInterruptedCompletionJob(current.id);
        } else {
          this.jobStore.failInterruptedJob(current.id);
        }
      }
    }
  }

  private cancelInterruptedCompletionJob(jobId: string): void {
    const current = requireCompletionProposalJob(this.jobStore.getJob(jobId));
    if (isTerminal(current.status)) return;
    const error: AiJobError = {
      code: "AI_CANCELLED",
      message: "用户取消了隐藏内容候选生成",
    };
    for (const run of this.jobStore.listRuns(current.id)) {
      if (run.status === "running") {
        this.jobStore.finishRun({
          runId: run.id,
          status: "cancelled",
          error,
        });
      }
    }
    this.jobStore.transitionJob(
      current.id,
      "cancelled",
      "隐藏内容候选生成已取消",
      { error },
    );
  }

  private recoverCompletionRun(job: CompletionProposalAiJob): void {
    const runs = this.jobStore.listRuns(job.id);
    if (job.options.rankingMode === "host_only") {
      if (runs.length !== 0) {
        throw new Error("Host-only completion recovery has unexpected AI Runs");
      }
      return;
    }
    const latest = runs.at(-1);
    if (
      !latest ||
      (latest.status !== "running" && latest.status !== "succeeded") ||
      runs.slice(0, -1).some((run) => run.status !== "failed")
    ) {
      throw new Error("AI completion recovery Run history is incomplete");
    }
    const roles = this.jobStore
      .listRunAssets(latest.id)
      .map((asset) => asset.fileRole)
      .sort();
    if (!sameStrings(roles, [...COMPLETION_RANKING_RUN_FILE_ROLES].sort())) {
      throw new Error("AI completion recovery Run assets are incomplete");
    }
    if (latest.status === "running") {
      this.jobStore.finishRun({ runId: latest.id, status: "succeeded" });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([this.recoveryPromise]);
    await Promise.allSettled(
      [...this.active.values()].map((active) => active.promise),
    );
    await Promise.allSettled(
      [...this.semanticFollowupActions.values()].map((action) => action.promise),
    );
    if (this.ownsJobStore) this.jobStore.close();
  }

  private schedule(jobId: string): void {
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.executeJob(jobId, controller.signal))
      .finally(() => this.active.delete(jobId));
    this.active.set(jobId, { controller, promise });
  }

  private async executeJob(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.jobStore.getJob(jobId);
    if (job.kind === "completion_proposal") {
      await this.executeCompletionProposalJob(jobId, signal);
      return;
    }
    if (job.kind === "restoration_recommendation") {
      await this.executeRestorationRecommendationJob(jobId, signal);
      return;
    }
    await this.executeSemanticAnalysisJob(jobId, signal);
  }

  private async executeCompletionProposalJob(
    jobId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let currentRun: AiRun | null = null;
    try {
      this.assertNotCancelled(jobId, signal);
      let job = requireCompletionProposalJob(
        this.jobStore.transitionJob(
          jobId,
          "preparing",
          "正在读取来源像素、语义组件与逐像素来源",
        ),
      );
      const sourceRevision = this.revisionStore.getRevision(
        job.inputRevisionId,
      );
      const [skinPng, semanticState, originDocument] = await Promise.all([
        this.revisionStore.readRevisionSkinPng(sourceRevision.id),
        this.revisionStore.readRevisionSemanticState(sourceRevision.id),
        this.revisionStore.readRevisionOrigin(sourceRevision.id),
      ]);
      if (!originDocument) {
        throw new AiJobStoreError(
          "COMPLETION_SOURCE_ORIGIN_REQUIRED",
          "隐藏内容候选需要带逐像素来源的 Revision",
          409,
          { sourceRevisionId: sourceRevision.id },
        );
      }
      const source: CompletionSourceSnapshot = {
        sourceRevisionId: sourceRevision.id,
        sourceResultHash: sourceRevision.resultHash,
        sourceSkinHash: semanticState.document.source.sourceHash,
        image: decodeSkinPng(skinPng),
        semanticState,
        originDocument,
      };
      this.assertNotCancelled(jobId, signal);
      job = requireCompletionProposalJob(
        this.jobStore.transitionJob(
          job.id,
          "running",
          "正在生成确定性隐藏内容候选",
        ),
      );
      this.jobStore.appendEvent(
        job.id,
        "candidate_generation_started",
        "Host 已开始生成受限像素候选",
        {
          targetComponentId: job.options.targetComponentId,
          occludingComponentIds: job.options.occludingComponentIds,
          requestedRepresentation: job.options.representation,
        },
      );
      const proposal = generateCompletionProposalCandidates({
        proposalId: `completion_${cryptoRandomSuffix()}`,
        ...source,
        targetComponentId: job.options.targetComponentId,
        occludingComponentIds: job.options.occludingComponentIds,
        representation: job.options.representation,
        hashCanonical: completionHash,
      });
      this.jobStore.appendEvent(
        job.id,
        "completion_candidates_generated",
        proposal.candidates.length > 0
          ? "确定性隐藏内容候选已生成"
          : "没有足够证据生成隐藏内容候选",
        {
          proposalId: proposal.proposalId,
          candidateCount: proposal.candidates.length,
          representation: proposal.representation,
          allowedGeneratedPixelCount: proposal.allowedGeneratedPixelCount,
          reviewOnly: true,
        },
      );
      this.assertNotCancelled(jobId, signal);
      job = requireCompletionProposalJob(
        this.jobStore.transitionJob(
          job.id,
          "validating",
          job.options.rankingMode === "ai"
            ? "确定性候选已锁定；正在准备 AI 排序"
            : "正在校验并保存候选证据",
        ),
      );

      let ranking: CompletionProposalRankingInput | undefined;
      let successfulProviderResult:
        | {
            readonly threadId?: string;
            readonly usage?: Readonly<Record<string, unknown>>;
          }
        | undefined;

      if (job.options.rankingMode === "host_only") {
        job = requireCompletionProposalJob(
          this.jobStore.updateInputHash(job.id, proposal.evidenceHash),
        );
      } else {
        const rankingOptions = job.options;
        const provider = this.requireCompletionRankingProvider(job.provider);
        let repairReport: CompletionRankingValidationReport | undefined;
        const maximumAttempts = this.maxRepairAttempts + 1;

        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
          this.assertNotCancelled(jobId, signal);
          const provisionalRunId = `airun_${cryptoRandomSuffix()}`;
          const provisionalWorkspace =
            this.runStorage.workspaceDirectory(provisionalRunId);
          currentRun = this.jobStore.createRun(
            job.id,
            provisionalWorkspace,
            provisionalRunId,
          );
          const workspace = await this.runStorage.createWorkspace(currentRun.id);
          if (workspace !== currentRun.workspacePath) {
            throw new Error("AI Run workspace identity mismatch");
          }
          const pack = await buildCompletionRankingPack({
            workspaceDirectory: workspace,
            proposalSchema: COMPLETION_RANKING_SCHEMA,
            jobId: job.id,
            completionProposal: proposal,
            source,
            provider: job.provider,
            model: job.model,
            reasoningEffort: rankingOptions.reasoningEffort,
          });
          if (attempt === 1) {
            job = requireCompletionProposalJob(
              this.jobStore.updateInputHash(job.id, pack.inputHash),
            );
          } else if (job.inputHash !== pack.inputHash) {
            throw new Error(
              "Repair completion ranking pack changed its deterministic input hash",
            );
          }
          if (repairReport) {
            await this.runStorage.writeJson(
              currentRun.id,
              pack.paths.previousValidatorReport,
              repairReport,
            );
          }
          job = requireCompletionProposalJob(
            this.jobStore.transitionJob(
              job.id,
              "running",
              attempt === 1
                ? "AI 正在对确定性候选排序"
                : "AI 正在修复无效候选排序",
            ),
          );
          const progressRun = currentRun;
          const providerResult = await provider.rankCompletion({
            jobId: job.id,
            attempt,
            model: job.model,
            reasoningEffort: rankingOptions.reasoningEffort,
            pack,
            ...(repairReport ? { repairReport } : {}),
            signal,
            onProgress: (event) => {
              try {
                this.jobStore.appendEvent(
                  jobId,
                  `provider_${event.kind}`,
                  event.message,
                  providerProgressEventData(progressRun.id, attempt, event),
                );
              } catch {
                // Progress telemetry must never decide the ranking result.
              }
            },
          });
          await verifyCompletionRankingPackIntegrity(pack);
          await Promise.all([
            this.runStorage.writeJson(
              currentRun.id,
              pack.paths.proposal,
              providerResult.proposal,
            ),
            this.runStorage.writeText(
              currentRun.id,
              "logs/codex-events.jsonl",
              providerResult.rawEvents,
            ),
            this.runStorage.writeText(
              currentRun.id,
              "logs/codex-stderr.log",
              providerResult.stderr,
            ),
          ]);
          job = requireCompletionProposalJob(
            this.jobStore.transitionJob(
              job.id,
              "validating",
              "正在校验候选排序与来源绑定",
            ),
          );
          const validation = validateCompletionRankingProposal({
            proposal: providerResult.proposal,
            pack,
          });
          await this.runStorage.writeJson(
            currentRun.id,
            pack.paths.validatorReport,
            validation.report,
          );
          const assets = await this.inspectRecommendationRunAssets(
            currentRun.id,
            pack.paths,
          );
          for (const asset of assets) {
            this.jobStore.recordRunAsset({
              runId: currentRun.id,
              fileRole: asset.fileRole,
              storagePath: asset.storagePath,
              mimeType: asset.mimeType,
              byteSize: asset.byteSize,
              sha256: asset.sha256,
            });
          }

          if (validation.report.valid && validation.proposal) {
            const validatedProposal = validation.proposal;
            ranking = {
              provider: job.provider,
              model: job.model,
              reasoningEffort: rankingOptions.reasoningEffort,
              document: validatedProposal,
              rankingHash: completionHash(
                canonicalCompletionJson(validatedProposal),
              ),
            };
            successfulProviderResult = providerResult;
            break;
          }

          const validationError: AiJobError = {
            code: "AI_COMPLETION_RANKING_INVALID",
            message:
              `AI 候选排序未通过校验（${validation.report.errors.length} 项）`,
            details: { validatorReport: validation.report },
          };
          this.jobStore.finishRun({
            runId: currentRun.id,
            status: "failed",
            ...(providerResult.threadId
              ? { threadId: providerResult.threadId }
              : {}),
            ...(providerResult.usage ? { usage: providerResult.usage } : {}),
            error: validationError,
          });
          currentRun = null;
          repairReport = validation.report;
          if (attempt < maximumAttempts) continue;
          throw new AiJobStoreError(
            validationError.code,
            validationError.message,
            422,
            validationError.details,
          );
        }
        if (!ranking || !currentRun || !successfulProviderResult) {
          throw new Error("Validated completion ranking result is missing");
        }
      }

      this.assertNotCancelled(jobId, signal);
      const detail = await this.revisionStore.createCompletionProposal({
        jobId: job.id,
        proposal,
        ...(ranking ? { ranking } : {}),
      });
      this.assertNotCancelled(jobId, signal);
      if (
        detail.proposal.jobId !== job.id ||
        detail.proposal.proposalHash !== proposal.proposalHash ||
        detail.proposal.sourceRevisionId !== job.inputRevisionId ||
        (ranking !== undefined) !== (detail.ranking !== null) ||
        (ranking &&
          detail.ranking &&
          (detail.ranking.rankingHash !== ranking.rankingHash ||
            detail.ranking.provider !== ranking.provider ||
            detail.ranking.model !== ranking.model ||
            detail.ranking.reasoningEffort !== ranking.reasoningEffort))
      ) {
        throw new AiJobStoreError(
          "COMPLETION_PROPOSAL_CORRUPT",
          "持久化候选与 Worker 生成结果不一致",
          500,
          { proposalId: proposal.proposalId },
        );
      }
      if (currentRun && successfulProviderResult) {
        this.jobStore.finishRun({
          runId: currentRun.id,
          status: "succeeded",
          ...(successfulProviderResult.threadId
            ? { threadId: successfulProviderResult.threadId }
            : {}),
          ...(successfulProviderResult.usage
            ? { usage: successfulProviderResult.usage }
            : {}),
        });
        currentRun = null;
      }
      this.jobStore.transitionJob(
        job.id,
        "succeeded",
        proposal.candidates.length === 0
          ? "候选检查已完成；没有可支持的补全候选"
          : ranking
            ? "隐藏内容候选及 AI 排序已验证；等待用户审核"
            : "隐藏内容候选已验证；等待用户审核",
        {
          outputHash: proposal.proposalHash,
          proposalSummary:
            proposal.candidates.length > 0
              ? `已生成 ${proposal.candidates.length} 个仅供审核的隐藏内容候选`
              : "没有足够的可见证据生成隐藏内容候选",
        },
      );
    } catch (error) {
      const failure = errorToJobError(error);
      if (currentRun?.status === "running") {
        if (
          error instanceof AiProviderError &&
          failure.code !== "AI_CANCELLED"
        ) {
          await this.persistProviderFailureAssets(currentRun.id, error);
        }
        this.jobStore.finishRun({
          runId: currentRun.id,
          status: failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          error: failure,
        });
      }
      const job = this.jobStore.getJob(jobId);
      if (!isTerminal(job.status)) {
        this.jobStore.transitionJob(
          job.id,
          failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          failure.code === "AI_CANCELLED"
            ? "隐藏内容候选生成已取消"
            : "隐藏内容候选生成失败",
          { error: failure },
        );
      }
    }
  }

  private async executeSemanticAnalysisJob(
    jobId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let currentRun: AiRun | null = null;
    try {
      this.assertNotCancelled(jobId, signal);
      let job = requireSemanticAnalysisJob(
        this.jobStore.transitionJob(
          jobId,
          "preparing",
          "正在生成只读分析包",
        ),
      );
      const provider = this.requireProvider(job.provider);
      if (job.options.createRevisionOnSuccess) {
        await this.assertSemanticAnalysisSourceEligible(job.inputRevisionId);
        this.assertNotCancelled(jobId, signal);
      }
      const skinPng = await this.revisionStore.readRevisionSkinPng(
        job.inputRevisionId,
      );
      const image = decodeSkinPng(skinPng);
      const previousSegmentation = (
        await this.revisionStore.readRevisionSemanticState(
        job.inputRevisionId,
        )
      ).document;
      const sourceRevision = this.revisionStore.getRevision(job.inputRevisionId);
      let repairReport: ProposalValidationReport | undefined;
      const maximumAttempts = this.maxRepairAttempts + 1;

      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        this.assertNotCancelled(jobId, signal);
        const provisionalRunId = `airun_${cryptoRandomSuffix()}`;
        const provisionalWorkspace = this.runStorage.workspaceDirectory(provisionalRunId);
        currentRun = this.jobStore.createRun(
          jobId,
          provisionalWorkspace,
          provisionalRunId,
        );
        const workspace = await this.runStorage.createWorkspace(currentRun.id);
        if (workspace !== currentRun.workspacePath) {
          throw new Error("AI Run workspace identity mismatch");
        }
        const pack = await buildAnalysisPack({
          workspaceDirectory: workspace,
          skillDirectory: this.skillDirectory,
          proposalSchema: ANALYSIS_PROPOSAL_SCHEMA,
          jobId,
          runId: currentRun.id,
          projectId: job.projectId,
          sourceRevisionId: job.inputRevisionId,
          sourceResultHash: sourceRevision.resultHash,
          skinPng,
          armType: previousSegmentation.source.armType,
          previousSegmentation,
          provider: job.provider,
          model: job.model,
          reasoningEffort: job.options.reasoningEffort,
          semanticBaseline: job.options.semanticBaseline ?? "current",
          focus: job.options.focus,
          createRevisionOnSuccess: job.options.createRevisionOnSuccess,
          skillVersion: job.skillVersion,
        });
        if (attempt === 1) {
          job = requireSemanticAnalysisJob(
            this.jobStore.updateInputHash(job.id, pack.inputHash),
          );
        }
        else if (job.inputHash !== pack.inputHash) {
          throw new Error("Repair analysis pack changed its deterministic input hash");
        }
        if (repairReport) {
          await this.runStorage.writeJson(
            currentRun.id,
            "logs/previous-validator-report.json",
            repairReport,
          );
        }
        job = requireSemanticAnalysisJob(
          this.jobStore.transitionJob(
            job.id,
            "running",
            attempt === 1 ? "Codex 正在分析皮肤" : "Codex 正在修复无效提案",
          ),
        );
        this.assertNotCancelled(jobId, signal);
        if (job.options.createRevisionOnSuccess) {
          await this.assertSemanticAnalysisSourceEligible(job.inputRevisionId);
          this.assertNotCancelled(jobId, signal);
        }
        const progressRun = currentRun;
        const providerResult = await provider.analyze({
          jobId,
          runId: currentRun.id,
          attempt,
          model: job.model,
          pack,
          ...(repairReport ? { repairReport } : {}),
          signal,
          onProgress: (event) => {
            try {
              this.jobStore.appendEvent(
                jobId,
                `provider_${event.kind}`,
                event.message,
                providerProgressEventData(progressRun.id, attempt, event),
              );
            } catch {
              // Progress telemetry must never decide the analysis result.
            }
          },
        });
        await verifyAnalysisPackIntegrity(pack);
        await Promise.all([
          this.runStorage.writeJson(
            currentRun.id,
            "output/analysis-proposal.json",
            providerResult.proposal,
          ),
          this.runStorage.writeText(
            currentRun.id,
            "logs/codex-events.jsonl",
            providerResult.rawEvents,
          ),
          this.runStorage.writeText(
            currentRun.id,
            "logs/codex-stderr.log",
            providerResult.stderr,
          ),
        ]);
        job = requireSemanticAnalysisJob(
          this.jobStore.transitionJob(
            job.id,
            "validating",
            "正在校验 AI 提案与像素归属",
          ),
        );
        const validation = validateAnalysisProposal({
          proposal: providerResult.proposal,
          pack,
          image,
          aiRunId: currentRun.id,
        });
        await this.runStorage.writeJson(
          currentRun.id,
          "logs/validator-report.json",
          validation.report,
        );
        const assets = await this.inspectRunAssets(currentRun.id);
        for (const asset of assets) {
          this.jobStore.recordRunAsset({
            runId: currentRun.id,
            fileRole: asset.fileRole,
            storagePath: asset.storagePath,
            mimeType: asset.mimeType,
            byteSize: asset.byteSize,
            sha256: asset.sha256,
          });
        }
        const outputHash = assets.find(
          (asset) => asset.fileRole === "raw_output",
        )!.sha256;

        if (validation.report.valid && validation.state) {
          this.assertNotCancelled(jobId, signal);
          let resultRevisionId: string | undefined;
          if (job.options.createRevisionOnSuccess) {
            await this.assertSemanticAnalysisSourceEligible(job.inputRevisionId);
            this.assertNotCancelled(jobId, signal);
            const committed = await this.revisionStore.commitAiSegmentation(
              job.inputRevisionId,
              {
                state: validation.state,
                aiJobId: job.id,
                aiRunId: currentRun.id,
                provider: job.provider,
                model: job.model,
                proposalSummary: validation.proposal.summary,
                reviewItems: validation.proposal.reviewItems,
              },
            );
            resultRevisionId = committed.revision.id;
          }
          if (resultRevisionId) {
            this.jobStore.appendEvent(
              job.id,
              "occlusion_assessing",
              "正在检查跨部位遮挡与可疑分类",
              { resultRevisionId },
            );
            try {
              const assessment = this.semanticFollowupAssessor({
                state: validation.state,
                image,
                candidateRegions: pack.candidateRegions,
              });
              const followup = this.jobStore.createSemanticFollowup({
                jobId: job.id,
                resultRevisionId,
                assessment,
              });
              this.jobStore.appendEvent(
                job.id,
                "occlusion_assessed",
                assessment.suggestions.length > 0
                  ? `发现 ${assessment.suggestions.length} 项建议确认的跨部位分类`
                  : "未发现可安全建议的跨部位分类修复",
                {
                  resultRevisionId,
                  status: followup.status,
                  suggestionCount: assessment.suggestions.length,
                  suggestedPixelCount: assessment.suggestions.reduce(
                    (sum, suggestion) => sum + suggestion.pixelCount,
                    0,
                  ),
                  evidenceHash: assessment.evidenceHash,
                },
              );
              this.jobStore.appendEvent(
                job.id,
                assessment.suggestions.length > 0
                  ? "repair_review_ready"
                  : "repair_review_skipped",
                assessment.suggestions.length > 0
                  ? "修复建议已准备，等待用户确认"
                  : "未生成分类修复建议",
                { status: followup.status },
              );
            } catch (error) {
              this.jobStore.appendEvent(
                job.id,
                "occlusion_assessment_failed",
                "遮挡检查未完成；语义识别结果仍然可用",
                { message: safeFollowupErrorMessage(error) },
              );
            }
            this.jobStore.appendEvent(
              job.id,
              "catalog_ready",
              "识别结果已进入已分析皮肤目录",
              { resultRevisionId },
            );
          }
          this.jobStore.finishRun({
            runId: currentRun.id,
            status: "succeeded",
            ...(providerResult.threadId
              ? { threadId: providerResult.threadId }
              : {}),
            ...(providerResult.usage ? { usage: providerResult.usage } : {}),
          });
          currentRun = null;
          this.jobStore.transitionJob(job.id, "succeeded", "AI 提案已验证并完成", {
            outputHash,
            ...(resultRevisionId ? { resultRevisionId } : {}),
            reviewItems: validation.proposal.reviewItems,
            proposalSummary: validation.proposal.summary,
            validatorReport: validation.report,
          });
          return;
        }

        const validationError: AiJobError = {
          code: "AI_PROPOSAL_INVALID",
          message: `AI 提案未通过校验（${validation.report.errors.length} 项）`,
          details: { validatorReport: validation.report },
        };
        this.jobStore.finishRun({
          runId: currentRun.id,
          status: "failed",
          ...(providerResult.threadId ? { threadId: providerResult.threadId } : {}),
          ...(providerResult.usage ? { usage: providerResult.usage } : {}),
          error: validationError,
        });
        currentRun = null;
        repairReport = validation.report;
        if (attempt < maximumAttempts) continue;
        throw new AiJobStoreError(
          validationError.code,
          validationError.message,
          422,
          validationError.details,
        );
      }
    } catch (error) {
      const failure = errorToJobError(error);
      if (currentRun?.status === "running") {
        if (error instanceof AiProviderError) {
          await this.persistProviderFailureAssets(currentRun.id, error);
        }
        this.jobStore.finishRun({
          runId: currentRun.id,
          status:
            failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          error: failure,
        });
      }
      const job = this.jobStore.getJob(jobId);
      if (!isTerminal(job.status)) {
        this.jobStore.transitionJob(
          job.id,
          failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          failure.code === "AI_CANCELLED" ? "AI 分析已取消" : "AI 分析失败",
          { error: failure },
        );
      }
    }
  }

  private async executeRestorationRecommendationJob(
    jobId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let currentRun: AiRun | null = null;
    try {
      this.assertNotCancelled(jobId, signal);
      let job = this.jobStore.transitionJob(
        jobId,
        "preparing",
        "正在生成只读换装建议包",
      );
      if (job.kind !== "restoration_recommendation") {
        throw new Error("Restoration recommendation job identity changed");
      }
      const provider = this.requireReplacementProvider(job.provider);
      let repairReport: ReplacementPlanValidationReport | undefined;
      const maximumAttempts = this.maxRepairAttempts + 1;

      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        this.assertNotCancelled(jobId, signal);
        const candidates = await this.assertRestorationRecommendationFresh(job.options);
        const provisionalRunId = `airun_${cryptoRandomSuffix()}`;
        const provisionalWorkspace = this.runStorage.workspaceDirectory(provisionalRunId);
        currentRun = this.jobStore.createRun(
          jobId,
          provisionalWorkspace,
          provisionalRunId,
        );
        const workspace = await this.runStorage.createWorkspace(currentRun.id);
        if (workspace !== currentRun.workspacePath) {
          throw new Error("AI Run workspace identity mismatch");
        }
        const pack = await buildReplacementPlanningPack({
          workspaceDirectory: workspace,
          skillDirectory: this.replacementSkillDirectory,
          proposalSchema: REPLACEMENT_PLAN_SCHEMA,
          jobId: job.id,
          userIntent: job.options.userIntent,
          candidateCatalog: toPublicRestorationCandidateCatalog(candidates),
          skillVersion: job.skillVersion,
          provider: job.provider,
          model: job.model,
          reasoningEffort: job.options.reasoningEffort,
        });
        if (attempt === 1) job = this.jobStore.updateInputHash(job.id, pack.inputHash);
        else if (job.inputHash !== pack.inputHash) {
          throw new Error("Repair recommendation pack changed its deterministic input hash");
        }
        if (repairReport) {
          await this.runStorage.writeJson(
            currentRun.id,
            pack.paths.previousValidatorReport,
            repairReport,
          );
        }
        job = this.jobStore.transitionJob(
          job.id,
          "running",
          attempt === 1
            ? "Codex 正在比较确定性候选"
            : "Codex 正在修复无效换装建议",
        );
        if (job.kind !== "restoration_recommendation") {
          throw new Error("Restoration recommendation job identity changed");
        }
        const progressRun = currentRun;
        const providerResult = await provider.recommendReplacement!({
          jobId,
          attempt,
          model: job.model,
          reasoningEffort: job.options.reasoningEffort,
          pack,
          ...(repairReport ? { repairReport } : {}),
          signal,
          onProgress: (event) => {
            try {
              this.jobStore.appendEvent(
                jobId,
                `provider_${event.kind}`,
                event.message,
                providerProgressEventData(progressRun.id, attempt, event),
              );
            } catch {
              // Progress telemetry must never decide the recommendation result.
            }
          },
        });
        await verifyReplacementPlanningPackIntegrity(pack);
        await Promise.all([
          this.runStorage.writeJson(
            currentRun.id,
            pack.paths.proposal,
            providerResult.proposal,
          ),
          this.runStorage.writeText(
            currentRun.id,
            "logs/codex-events.jsonl",
            providerResult.rawEvents,
          ),
          this.runStorage.writeText(
            currentRun.id,
            "logs/codex-stderr.log",
            providerResult.stderr,
          ),
        ]);
        job = this.jobStore.transitionJob(
          job.id,
          "validating",
          "正在校验候选 ID、分组与任务版本",
        );
        if (job.kind !== "restoration_recommendation") {
          throw new Error("Restoration recommendation job identity changed");
        }
        const validation = validateReplacementPlanProposal({
          proposal: providerResult.proposal,
          pack,
        });
        await this.runStorage.writeJson(
          currentRun.id,
          pack.paths.validatorReport,
          validation.report,
        );
        const assets = await this.inspectRecommendationRunAssets(
          currentRun.id,
          pack.paths,
        );
        for (const asset of assets) {
          this.jobStore.recordRunAsset({
            runId: currentRun.id,
            fileRole: asset.fileRole,
            storagePath: asset.storagePath,
            mimeType: asset.mimeType,
            byteSize: asset.byteSize,
            sha256: asset.sha256,
          });
        }
        const outputHash = assets.find(
          (asset) => asset.fileRole === "raw_output",
        )!.sha256;

        if (validation.report.valid && validation.proposal) {
          this.assertNotCancelled(jobId, signal);
          await this.assertRestorationRecommendationFresh(job.options);
          this.assertNotCancelled(jobId, signal);
          this.jobStore.finishRun({
            runId: currentRun.id,
            status: "succeeded",
            ...(providerResult.threadId
              ? { threadId: providerResult.threadId }
              : {}),
            ...(providerResult.usage ? { usage: providerResult.usage } : {}),
          });
          currentRun = null;
          this.jobStore.transitionJob(
            job.id,
            "succeeded",
            "AI 换装建议已验证；等待用户载入",
            {
              outputHash,
              advisoryResult: validation.proposal,
              proposalSummary: validation.proposal.summary,
              validatorReport: validation.report,
            },
          );
          return;
        }

        const validationError: AiJobError = {
          code: "AI_RECOMMENDATION_INVALID",
          message: `AI 换装建议未通过校验（${validation.report.errors.length} 项）`,
          details: { validatorReport: validation.report },
        };
        this.jobStore.finishRun({
          runId: currentRun.id,
          status: "failed",
          ...(providerResult.threadId ? { threadId: providerResult.threadId } : {}),
          ...(providerResult.usage ? { usage: providerResult.usage } : {}),
          error: validationError,
        });
        currentRun = null;
        repairReport = validation.report;
        if (attempt < maximumAttempts) continue;
        throw new AiJobStoreError(
          validationError.code,
          validationError.message,
          422,
          validationError.details,
        );
      }
    } catch (error) {
      const failure = errorToJobError(error);
      if (currentRun?.status === "running") {
        if (error instanceof AiProviderError) {
          await this.persistProviderFailureAssets(currentRun.id, error);
        }
        this.jobStore.finishRun({
          runId: currentRun.id,
          status: failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          error: failure,
        });
      }
      const job = this.jobStore.getJob(jobId);
      if (!isTerminal(job.status)) {
        this.jobStore.transitionJob(
          job.id,
          failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          failure.code === "AI_CANCELLED"
            ? "AI 换装建议已取消"
            : "AI 换装建议失败",
          { error: failure },
        );
      }
    }
  }

  private async assertRestorationRecommendationFresh(
    options: AiRestorationRecommendationOptions,
  ) {
    const candidates = await this.regenerateRestorationCandidates(options);
    const composition = this.revisionStore.getComposition(options.compositionId);
    if (
      composition.status !== "draft" ||
      composition.restorationVersion !== options.compositionVersion ||
      candidates.version !== options.compositionVersion ||
      candidates.candidateSetHash !== options.candidateSetHash
    ) {
      throw staleRestorationRecommendation(options, {
        version: candidates.version,
        candidateSetHash: candidates.candidateSetHash,
      });
    }
    return candidates;
  }

  private async regenerateRestorationCandidates(
    options: AiRestorationRecommendationOptions,
  ) {
    return await this.revisionStore.generateCompositionRestorationCandidates(
      options.compositionId,
      {
        targetComponentIds: options.targetComponentIds,
        ...(options.donorRevisionId
          ? { donorRevisionId: options.donorRevisionId }
          : {}),
        ...(options.manualRgba ? { manualRgba: options.manualRgba } : {}),
      },
    );
  }

  private async inspectRunAssets(runId: string) {
    return await Promise.all([
      this.runStorage.inspectFile(
        runId,
        "input_manifest",
        "input/manifest.json",
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "raw_events",
        "logs/codex-events.jsonl",
        "application/x-ndjson",
      ),
      this.runStorage.inspectFile(
        runId,
        "raw_output",
        "output/analysis-proposal.json",
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "validator_report",
        "logs/validator-report.json",
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "stderr",
        "logs/codex-stderr.log",
        "text/plain",
      ),
    ]);
  }

  private async inspectRecommendationRunAssets(
    runId: string,
    paths: {
      readonly manifest: string;
      readonly proposal: string;
      readonly validatorReport: string;
    },
  ) {
    return await Promise.all([
      this.runStorage.inspectFile(
        runId,
        "input_manifest",
        paths.manifest,
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "raw_events",
        "logs/codex-events.jsonl",
        "application/x-ndjson",
      ),
      this.runStorage.inspectFile(
        runId,
        "raw_output",
        paths.proposal,
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "validator_report",
        paths.validatorReport,
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "stderr",
        "logs/codex-stderr.log",
        "text/plain",
      ),
    ]);
  }

  private async persistProviderFailureAssets(
    runId: string,
    error: AiProviderError,
  ): Promise<void> {
    try {
      await Promise.all([
        this.runStorage.writeText(
          runId,
          "logs/codex-events.jsonl",
          error.rawEvents ?? "",
        ),
        this.runStorage.writeText(
          runId,
          "logs/codex-stderr.log",
          error.stderr ?? "",
        ),
      ]);
      const assets = await Promise.all([
        this.runStorage.inspectFile(
          runId,
          "input_manifest",
          "input/manifest.json",
          "application/json",
        ),
        this.runStorage.inspectFile(
          runId,
          "raw_events",
          "logs/codex-events.jsonl",
          "application/x-ndjson",
        ),
        this.runStorage.inspectFile(
          runId,
          "stderr",
          "logs/codex-stderr.log",
          "text/plain",
        ),
      ]);
      for (const asset of assets) {
        this.jobStore.recordRunAsset({
          runId,
          fileRole: asset.fileRole,
          storagePath: asset.storagePath,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
        });
      }
    } catch {
      // Preserve the original provider failure even if diagnostic persistence fails.
    }
  }

  private assertNotCancelled(jobId: string, signal: AbortSignal): void {
    const job = this.jobStore.getJob(jobId);
    if (signal.aborted || job.cancelRequested) {
      throw new AiProviderError("AI_CANCELLED", `用户取消了${aiTaskName(job)}`);
    }
  }

  private requireProvider(providerName: string): SkinSemanticAiProvider {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new AiJobStoreError(
        "AI_PROVIDER_UNAVAILABLE",
        `AI Provider 不可用：${providerName}`,
        400,
        { availableProviders: this.listProviders() },
      );
    }
    return provider;
  }

  private async assertSemanticAnalysisSourceEligible(
    sourceRevisionId: string,
  ): Promise<void> {
    const sourceRevision = this.revisionStore.getRevision(sourceRevisionId);
    // M18 snapshots carry authoritative per-pixel origin evidence. Reading it
    // also verifies the immutable snapshot, so a recorded document can be
    // preserved by commitAiSegmentation without relying on provider summaries.
    // Only pre-M18 snapshots need the conservative M16 ancestry fallback.
    if (await this.revisionStore.readRevisionOrigin(sourceRevision.id)) return;

    const sourceState = await this.revisionStore.readRevisionSemanticState(
      sourceRevision.id,
    );
    const generatedComponentIds = sourceState.document.components
      .filter((component) => component.provenance.containsGeneratedPixels)
      .map((component) => component.instanceId)
      .sort();
    if (generatedComponentIds.length > 0) {
      throw semanticAnalysisSourceProvenanceConflict(sourceRevision.id, {
        reason: "generated_semantic_pixels",
        evidenceRevisionId: sourceRevision.id,
        componentIds: generatedComponentIds,
      });
    }

    const visited = new Set<string>();
    let contentRevision: SkinRevision | null = sourceRevision;
    while (contentRevision) {
      if (visited.has(contentRevision.id)) {
        throw semanticAnalysisSourceProvenanceConflict(sourceRevision.id, {
          reason: "invalid_content_ancestry",
          evidenceRevisionId: contentRevision.id,
        });
      }
      visited.add(contentRevision.id);
      if (contentRevision.projectId !== sourceRevision.projectId) {
        throw semanticAnalysisSourceProvenanceConflict(sourceRevision.id, {
          reason: "invalid_content_ancestry",
          evidenceRevisionId: contentRevision.id,
        });
      }

      const operation = await this.revisionStore.readRevisionOperation(
        contentRevision.id,
      );
      if (isPixelAuthoringOperation(operation.type)) {
        const partEvidence = await this.inspectOperationPartEvidence(operation);
        const reason = partEvidence.generatedPartIds.length > 0
          ? "generated_part_ancestry"
          : partEvidence.repairedPartIds.length > 0
            ? "repaired_part_ancestry"
            : "pixel_authoring_operation";
        throw semanticAnalysisSourceProvenanceConflict(sourceRevision.id, {
          reason,
          evidenceRevisionId: contentRevision.id,
          operationType: operation.type,
          ...(partEvidence.partIds.length > 0
            ? { partIds: partEvidence.partIds }
            : {}),
          ...(partEvidence.repairedPartIds.length > 0
            ? { repairedPartIds: partEvidence.repairedPartIds }
            : {}),
          ...(partEvidence.generatedPartIds.length > 0
            ? { generatedPartIds: partEvidence.generatedPartIds }
            : {}),
        });
      }

      if (operation.type === "revert") {
        const targetRevisionId = stringMetadata(
          operation.metadata,
          "targetRevisionId",
        );
        if (!targetRevisionId) {
          throw semanticAnalysisSourceProvenanceConflict(sourceRevision.id, {
            reason: "invalid_content_ancestry",
            evidenceRevisionId: contentRevision.id,
          });
        }
        contentRevision = this.revisionStore.getRevision(targetRevisionId);
        continue;
      }
      contentRevision = contentRevision.parentRevisionId
        ? this.revisionStore.getRevision(contentRevision.parentRevisionId)
        : null;
    }
  }

  private async inspectOperationPartEvidence(
    operation: OperationSnapshot,
  ): Promise<{
    readonly partIds: readonly string[];
    readonly repairedPartIds: readonly string[];
    readonly generatedPartIds: readonly string[];
  }> {
    const partIds = operationPartIds(operation);
    const repairedPartIds: string[] = [];
    const generatedPartIds: string[] = [];
    for (const partId of partIds) {
      try {
        const part = this.revisionStore.getPart(partId);
        const derivation = partDerivation(part);
        if (derivation?.kind === "part_repair") repairedPartIds.push(part.id);
        if (derivation?.containsGeneratedPixels === true) {
          generatedPartIds.push(part.id);
          continue;
        }
        const sourceState = await this.revisionStore.readRevisionSemanticState(
          part.sourceRevisionId,
        );
        const sourceComponent = sourceState.document.components.find(
          (component) => component.instanceId === part.sourceComponentId,
        );
        if (sourceComponent?.provenance.containsGeneratedPixels) {
          generatedPartIds.push(part.id);
        }
      } catch {
        // The operation itself is already sufficient evidence. Optional ancestry
        // enrichment must not turn a stable provenance conflict into another error.
      }
    }
    return {
      partIds,
      repairedPartIds: repairedPartIds.sort(),
      generatedPartIds: generatedPartIds.sort(),
    };
  }

  private requireReplacementProvider(
    providerName: string,
  ): SkinSemanticAiProvider & Required<Pick<SkinSemanticAiProvider, "recommendReplacement">> {
    const provider = this.requireProvider(providerName);
    if (!provider.recommendReplacement) {
      throw new AiJobStoreError(
        "AI_PROVIDER_CAPABILITY_UNAVAILABLE",
        `AI Provider 不支持换装建议：${providerName}`,
        400,
        { provider: providerName },
      );
    }
    return provider as SkinSemanticAiProvider &
      Required<Pick<SkinSemanticAiProvider, "recommendReplacement">>;
  }

  private requireCompletionRankingProvider(
    providerName: string,
  ): SkinSemanticAiProvider & Required<Pick<SkinSemanticAiProvider, "rankCompletion">> {
    const provider = this.requireProvider(providerName);
    if (!provider.rankCompletion) {
      throw new AiJobStoreError(
        "AI_PROVIDER_CAPABILITY_UNAVAILABLE",
        `AI Provider 不支持隐藏内容候选排序：${providerName}`,
        400,
        { provider: providerName },
      );
    }
    return provider as SkinSemanticAiProvider &
      Required<Pick<SkinSemanticAiProvider, "rankCompletion">>;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AiJobStoreError("AI_WORKER_CLOSED", "AI Worker 已关闭", 503);
    }
  }
}

type SemanticAnalysisSourceConflictReason =
  | "generated_semantic_pixels"
  | "generated_part_ancestry"
  | "repaired_part_ancestry"
  | "pixel_authoring_operation"
  | "invalid_content_ancestry";

function semanticAnalysisSourceProvenanceConflict(
  sourceRevisionId: string,
  evidence: {
    readonly reason: SemanticAnalysisSourceConflictReason;
    readonly evidenceRevisionId: string;
    readonly componentIds?: readonly string[];
    readonly operationType?: OperationSnapshot["type"];
    readonly partIds?: readonly string[];
    readonly repairedPartIds?: readonly string[];
    readonly generatedPartIds?: readonly string[];
  },
): AiJobStoreError {
  return new AiJobStoreError(
    "AI_ANALYSIS_SOURCE_PROVENANCE_CONFLICT",
    "来源 Revision 包含补绘或像素创作内容，当前 AI 重新识别会丢失来源标记",
    409,
    { sourceRevisionId, ...evidence },
  );
}

function isPixelAuthoringOperation(
  operationType: OperationSnapshot["type"],
): boolean {
  return operationType === "apply_part" ||
    operationType === "compose" ||
    operationType === "palette_change";
}

function operationPartIds(operation: OperationSnapshot): readonly string[] {
  const partIds: string[] = [];
  if (operation.type === "apply_part") {
    const partId = stringMetadata(operation.metadata, "partId");
    if (partId) partIds.push(partId);
  }
  if (operation.type === "compose") {
    const layers = operation.metadata.layers;
    for (const layer of Array.isArray(layers) ? layers : []) {
      if (!isRecord(layer)) continue;
      const partId = typeof layer.partId === "string" ? layer.partId : null;
      if (partId) partIds.push(partId);
    }
  }
  return [...new Set(partIds)].sort();
}

function partDerivation(part: SkinPart): {
  readonly kind?: unknown;
  readonly containsGeneratedPixels?: unknown;
} | null {
  const manifest = part.manifest as unknown;
  if (!isRecord(manifest) || !isRecord(manifest.derivation)) return null;
  return manifest.derivation;
}

function stringMetadata(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptions(options: AiAnalysisOptions): AiAnalysisOptions {
  return {
    mode: "full",
    semanticBaseline: options.semanticBaseline ?? "empty",
    provider: options.provider.trim(),
    model: options.model.trim(),
    reasoningEffort: options.reasoningEffort,
    taxonomyLevel: "coarse",
    focus: [...new Set(options.focus)].sort(),
    createRevisionOnSuccess: options.createRevisionOnSuccess,
  };
}

function normalizeCompletionProposalOptions(
  input: StartCompletionProposalInput,
  ranking: CompletionRankingConfiguration | null,
): AiCompletionProposalOptions {
  const targetComponentId = normalizeCompletionComponentId(
    input.targetComponentId,
    "targetComponentId",
  );
  if (!Array.isArray(input.occludingComponentIds)) {
    throw new AiJobStoreError(
      "INVALID_COMPLETION_PROPOSAL",
      "occludingComponentIds 必须是数组",
      400,
    );
  }
  const normalizedOccludingComponentIds = input.occludingComponentIds.map(
    (componentId) =>
      normalizeCompletionComponentId(componentId, "occludingComponentIds"),
  );
  const occludingComponentIds = [...normalizedOccludingComponentIds].sort();
  if (
    occludingComponentIds.length < 1 ||
    occludingComponentIds.length > MAX_COMPLETION_OCCLUDING_COMPONENTS ||
    new Set(occludingComponentIds).size !== occludingComponentIds.length ||
    occludingComponentIds.includes(targetComponentId)
  ) {
    throw new AiJobStoreError(
      "INVALID_COMPLETION_PROPOSAL",
      `遮挡组件必须包含 1-${MAX_COMPLETION_OCCLUDING_COMPONENTS} 个不同于目标的组件`,
      400,
    );
  }
  const representation = input.representation ?? "auto";
  if (
    representation !== "auto" &&
    representation !== "skin_texel" &&
    representation !== "latent_component"
  ) {
    throw new AiJobStoreError(
      "INVALID_COMPLETION_PROPOSAL",
      "隐藏内容表示类型无效",
      400,
    );
  }
  const common = {
    mode: "completion_proposal",
    targetComponentId,
    occludingComponentIds,
    representation,
  } as const;
  return ranking
    ? { ...common, ...ranking, rankingMode: "ai" }
    : {
        ...common,
        provider: COMPLETION_JOB_PROVIDER,
        model: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
        rankingMode: "host_only",
      };
}

function normalizeCompletionRankingConfiguration(
  value: CompletionRankingConfiguration,
): CompletionRankingConfiguration {
  const provider = value.provider.trim();
  const model = value.model.trim();
  if (!provider || provider.length > 80) {
    throw new TypeError("completionRanking.provider must contain 1-80 characters");
  }
  if (!model || model.length > 120) {
    throw new TypeError("completionRanking.model must contain 1-120 characters");
  }
  if (!ANALYSIS_REASONING_EFFORTS.includes(value.reasoningEffort)) {
    throw new TypeError("completionRanking.reasoningEffort is invalid");
  }
  return { provider, model, reasoningEffort: value.reasoningEffort };
}

function normalizeCompletionComponentId(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new AiJobStoreError(
      "INVALID_COMPLETION_PROPOSAL",
      `${label} 包含无效组件 ID`,
      400,
    );
  }
  const normalized = value.trim();
  if (
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(normalized) ||
    normalized === "unknown" ||
    normalized.length > 100
  ) {
    throw new AiJobStoreError(
      "INVALID_COMPLETION_PROPOSAL",
      `${label} 包含无效组件 ID`,
      400,
    );
  }
  return normalized;
}

function publicSemanticFollowup(
  followup: ReturnType<AiJobStore["getSemanticFollowup"]>,
): SemanticAnalysisFollowup | null {
  if (!followup) return null;
  return {
    jobId: followup.jobId,
    resultRevisionId: followup.resultRevisionId,
    status: followup.status,
    algorithmVersion: followup.assessment.algorithmVersion,
    applicable:
      followup.assessment.algorithmVersion ===
        SEMANTIC_FOLLOWUP_ALGORITHM_VERSION,
    evidenceHash: followup.evidenceHash,
    suggestions: followup.assessment.suggestions.map((suggestion) => ({
      id: suggestion.id,
      kind: suggestion.kind,
      label: suggestion.label,
      pixelCount: suggestion.pixelCount,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
    })),
    notices: followup.assessment.notices.map((notice) => ({
      kind: notice.kind,
      message: notice.message,
    })),
    appliedRevisionId: followup.appliedRevisionId,
    createdAt: followup.createdAt,
    updatedAt: followup.updatedAt,
  };
}

function safeFollowupErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized.slice(0, 300) || "未知错误";
}

function normalizeRestorationRecommendationOptions(
  options: AiRestorationRecommendationOptions,
): AiRestorationRecommendationOptions {
  const userIntent = options.userIntent.trim();
  if (!userIntent || userIntent.length > 1_000) {
    throw new AiJobStoreError(
      "INVALID_AI_JOB",
      "换装意图必须为 1-1000 个可见字符",
      400,
    );
  }
  if (
    !Number.isInteger(options.compositionVersion) ||
    options.compositionVersion < 0
  ) {
    throw new AiJobStoreError(
      "INVALID_AI_JOB",
      "compositionVersion 必须为非负整数",
      400,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.candidateSetHash)) {
    throw new AiJobStoreError(
      "INVALID_AI_JOB",
      "candidateSetHash 无效",
      400,
    );
  }
  return {
    mode: "restoration_recommendation",
    provider: options.provider.trim(),
    model: options.model.trim(),
    reasoningEffort: options.reasoningEffort,
    userIntent,
    compositionId: options.compositionId,
    compositionVersion: options.compositionVersion,
    candidateSetHash: options.candidateSetHash,
    targetComponentIds: [...new Set(options.targetComponentIds)].sort(),
    ...(options.donorRevisionId?.trim()
      ? { donorRevisionId: options.donorRevisionId.trim() }
      : {}),
    ...(options.manualRgba ? { manualRgba: options.manualRgba } : {}),
  };
}

function staleSemanticAnalysisRetryContract(
  job: SemanticAnalysisAiJob,
): AiJobStoreError {
  return new AiJobStoreError(
    "AI_ANALYSIS_RETRY_CONTRACT_STALE",
    "旧版语义分析的 Skill 或提示词合同已变化，请从来源 Revision 新建分析",
    409,
    {
      jobId: job.id,
      sourceRevisionId: job.inputRevisionId,
      storedContract: {
        skillName: job.skillName,
        skillVersion: job.skillVersion,
        promptVersion: job.promptVersion,
      },
      currentContract: {
        skillName: AI_SKILL_NAME,
        skillVersion: AI_SKILL_VERSION,
        promptVersion: PROMPT_VERSION,
      },
      requiredAction: "start_fresh_analysis",
    },
  );
}

function staleRestorationRecommendation(
  options: AiRestorationRecommendationOptions,
  actual: { readonly version: number; readonly candidateSetHash: string | null },
): AiJobStoreError {
  return new AiJobStoreError(
    "AI_RESTORATION_STALE",
    "混搭还原候选已经变化，请重新生成候选后再请求 AI 建议",
    409,
    {
      compositionId: options.compositionId,
      expectedVersion: options.compositionVersion,
      actualVersion: actual.version,
      expectedCandidateSetHash: options.candidateSetHash,
      actualCandidateSetHash: actual.candidateSetHash,
    },
  );
}

function requireSemanticAnalysisJob(job: AiJob): SemanticAnalysisAiJob {
  if (job.kind !== "semantic_analysis") {
    throw new Error("Semantic analysis job identity changed");
  }
  return job;
}

function requireCompletionProposalJob(job: AiJob): CompletionProposalAiJob {
  if (job.kind !== "completion_proposal") {
    throw new Error("Completion proposal job identity changed");
  }
  return job;
}

function assertCompletionRecoveryContract(
  job: CompletionProposalAiJob,
  detail: CompletionProposalDetail,
): void {
  const proposal = detail.proposal;
  const document = detail.document;
  if (
    job.status !== "validating" ||
    job.outputHash !== null ||
    detail.jobStatus !== "validating" ||
    detail.visible ||
    detail.status !== "awaiting_decision" ||
    detail.decision !== null ||
    detail.result !== null ||
    proposal.jobId !== job.id ||
    proposal.projectId !== job.projectId ||
    proposal.sourceRevisionId !== job.inputRevisionId ||
    proposal.id !== document.proposalId ||
    proposal.sourceRevisionId !== document.sourceRevisionId ||
    proposal.sourceResultHash !== document.sourceResultHash ||
    proposal.sourceSkinHash !== document.sourceSkinHash ||
    proposal.targetComponentId !== document.targetComponentId ||
    proposal.representation !== document.representation ||
    proposal.evidenceHash !== document.evidenceHash ||
    proposal.proposalHash !== document.proposalHash ||
    job.options.targetComponentId !== document.targetComponentId ||
    job.options.representation !== document.requestedRepresentation ||
    !sameStrings(
      [...job.options.occludingComponentIds].sort(),
      [...document.occludingComponentIds].sort(),
    ) ||
    detail.candidateCount !== document.candidates.length ||
    detail.candidateCount !== detail.candidates.length ||
    !sameStrings(
      detail.candidates.map((candidate) => candidate.id).sort(),
      document.candidates.map((candidate) => candidate.candidateId).sort(),
    )
  ) {
    throw new Error("Completion recovery Proposal contract mismatch");
  }
  const documentCandidates = new Map(
    document.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  if (
    detail.candidates.some((candidate) => {
      const source = documentCandidates.get(candidate.id);
      return !source ||
        source.candidateHash !== candidate.candidateHash ||
        source.evidenceHash !== candidate.evidenceHash ||
        source.representation !== candidate.representation;
    })
  ) {
    throw new Error("Completion recovery Candidate contract mismatch");
  }

  if (job.options.rankingMode === "host_only") {
    if (
      detail.ranking !== null ||
      job.provider !== COMPLETION_JOB_PROVIDER ||
      job.model !== COMPLETION_CANDIDATE_ALGORITHM_VERSION ||
      job.skillName !== COMPLETION_JOB_SKILL_NAME ||
      job.skillVersion !== COMPLETION_PROPOSAL_SCHEMA_VERSION ||
      job.promptVersion !== COMPLETION_JOB_PROMPT_VERSION ||
      job.inputHash !== document.evidenceHash
    ) {
      throw new Error("Completion recovery host contract mismatch");
    }
    return;
  }

  const ranking = detail.ranking;
  if (
    !ranking ||
    !isSha256(job.inputHash) ||
    job.skillName !== COMPLETION_RANKING_JOB_SKILL_NAME ||
    job.skillVersion !== COMPLETION_RANKING_PACK_SCHEMA_VERSION ||
    job.promptVersion !== COMPLETION_RANKING_PROMPT_VERSION ||
    ranking.jobId !== job.id ||
    ranking.proposalId !== proposal.id ||
    ranking.provider !== job.provider ||
    ranking.model !== job.model ||
    ranking.reasoningEffort !== job.options.reasoningEffort ||
    ranking.document.jobId !== job.id ||
    ranking.document.proposalId !== proposal.id ||
    ranking.document.proposalHash !== proposal.proposalHash ||
    ranking.document.sourceRevisionId !== proposal.sourceRevisionId ||
    ranking.document.sourceResultHash !== proposal.sourceResultHash ||
    ranking.document.sourceSkinHash !== proposal.sourceSkinHash ||
    !sameStrings(
      [...ranking.orderedCandidateIds].sort(),
      detail.candidates.map((candidate) => candidate.id).sort(),
    )
  ) {
    throw new Error("Completion recovery AI ranking contract mismatch");
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isSha256(value: string | null): value is string {
  return value !== null && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function aiTaskName(job: Pick<AiJob, "kind">): string {
  if (job.kind === "restoration_recommendation") return "AI 换装建议";
  if (job.kind === "completion_proposal") return "隐藏内容候选生成";
  return "AI 分析";
}

function toPublicRestorationCandidateCatalog(
  candidates: Awaited<
    ReturnType<RevisionStore["generateCompositionRestorationCandidates"]>
  >,
): PublicRestorationCandidateCatalog {
  return {
    compositionId: candidates.compositionId,
    version: candidates.version,
    candidateSetHash: candidates.candidateSetHash,
    targetComponentIds: candidates.targetComponentIds,
    outer: candidates.outer,
    base: {
      pixelCount: candidates.base.pixelCount,
      coveredPixelCount: candidates.base.coveredPixelCount,
      missingPixelCount: candidates.base.missingPixelCount,
      candidates: candidates.base.candidates.map((candidate) => {
        if (candidate.kind === "outer_transparent") {
          throw new Error("Public Base catalog contains an Outer candidate");
        }
        return {
          id: candidate.id,
          kind: candidate.kind,
          targetGroupId: candidate.targetGroupId,
          label: candidate.label,
          description: candidate.description,
          pixelCount: candidate.pixelCount,
          coveragePixelCount: candidate.coveragePixelCount,
          ...(candidate.sourceRevisionId
            ? { sourceRevisionId: candidate.sourceRevisionId }
            : {}),
          ...(candidate.rgba ? { rgba: candidate.rgba as readonly [number, number, number, 255] } : {}),
          ...(candidate.selectedByDefault !== undefined
            ? { selectedByDefault: candidate.selectedByDefault }
            : {}),
        };
      }),
    },
  };
}

function errorToJobError(error: unknown): AiJobError {
  if (error instanceof AiProviderError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof AiJobStoreError || error instanceof RevisionStoreError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    code: "AI_WORKER_FAILED",
    message: error instanceof Error ? error.message : "AI Worker 无法完成任务",
  };
}

function providerProgressEventData(
  runId: string,
  attempt: number,
  event: ProviderProgressEvent,
): Readonly<Record<string, unknown>> {
  const commandSummary = sanitizeProviderCommandSummary(event.commandSummary);
  return {
    runId,
    attempt,
    kind: event.kind,
    ...(event.status ? { status: event.status } : {}),
    ...(event.itemId && /^[a-zA-Z0-9._:-]{1,128}$/u.test(event.itemId)
      ? { itemId: event.itemId }
      : {}),
    ...(commandSummary ? { commandSummary } : {}),
    ...(event.exitCode !== undefined && Number.isInteger(event.exitCode)
      ? { exitCode: event.exitCode }
      : {}),
  };
}

function sanitizeProviderCommandSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\b(?:[a-z][a-z0-9]*_)*(?:api_?key|access_?token|auth_?token|password|secret)\s*=\s*\S+/giu, "[REDACTED]")
    .replace(/(--?(?:api[-_]?key|token|password|secret)|authorization)\s*(?::|=|\s)\s*(?:bearer\s+)?\S+/giu, "$1 [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@")
    .trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function cryptoRandomSuffix(): string {
  return randomUUID().replaceAll("-", "");
}

function completionHash(canonicalJson: string): string {
  return `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function semanticFollowupBranchName(jobId: string, suggestionId: string): string {
  const identity = createHash("sha256")
    .update(jobId)
    .update("\0")
    .update(suggestionId)
    .digest("hex")
    .slice(0, 32);
  return `semantic-repair-${identity}`;
}
