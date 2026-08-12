import type {
  AnalysisReviewItem,
  ProposalValidationReport,
  ReplacementPlanProposal,
  ReplacementPlanValidationReport,
} from "@mc-skin-split/ai-provider";
import type { AnalysisReasoningEffort } from "@mc-skin-split/skin-analysis-pack";
export { ANALYSIS_REASONING_EFFORTS } from "@mc-skin-split/skin-analysis-pack";
export type { AnalysisReasoningEffort } from "@mc-skin-split/skin-analysis-pack";
import type { SemanticCategory } from "@mc-skin-split/skin-core";

export const AI_JOB_STATUSES = [
  "queued",
  "preparing",
  "running",
  "validating",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];
export type AiJobKind = "semantic_analysis" | "restoration_recommendation";
export type AiRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type AiRunFileRole =
  | "input_manifest"
  | "raw_events"
  | "raw_output"
  | "validator_report"
  | "stderr";

export interface AiAnalysisOptions {
  readonly mode: "full";
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly taxonomyLevel: "coarse";
  readonly focus: readonly SemanticCategory[];
  readonly createRevisionOnSuccess: boolean;
}

export interface AiRestorationRecommendationOptions {
  readonly mode: "restoration_recommendation";
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly userIntent: string;
  readonly compositionId: string;
  readonly compositionVersion: number;
  readonly candidateSetHash: string;
  readonly targetComponentIds: readonly string[];
  readonly donorRevisionId?: string;
  readonly manualRgba?: readonly [number, number, number, number];
}

export type StartAiRestorationRecommendationInput = Omit<
  AiRestorationRecommendationOptions,
  "mode" | "compositionId"
>;

export type AiJobOptions =
  | AiAnalysisOptions
  | AiRestorationRecommendationOptions;

export interface AiJobError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface AiJobBase {
  readonly id: string;
  readonly kind: AiJobKind;
  readonly projectId: string;
  readonly inputRevisionId: string;
  readonly resultRevisionId: string | null;
  readonly compositionId: string | null;
  readonly retryOfJobId: string | null;
  readonly status: AiJobStatus;
  readonly provider: string;
  readonly model: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly promptVersion: string;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
  readonly options: AiJobOptions;
  readonly reviewItems: readonly AnalysisReviewItem[];
  readonly proposalSummary: string | null;
  readonly advisoryResult: ReplacementPlanProposal | null;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: AiJobError | null;
}

export interface SemanticAnalysisAiJob extends AiJobBase {
  readonly kind: "semantic_analysis";
  readonly compositionId: null;
  readonly options: AiAnalysisOptions;
  readonly advisoryResult: null;
}

export interface RestorationRecommendationAiJob extends AiJobBase {
  readonly kind: "restoration_recommendation";
  readonly resultRevisionId: null;
  readonly compositionId: string;
  readonly options: AiRestorationRecommendationOptions;
  readonly reviewItems: readonly [];
  readonly advisoryResult: ReplacementPlanProposal | null;
}

export type AiJob = SemanticAnalysisAiJob | RestorationRecommendationAiJob;

export interface AiRun {
  readonly id: string;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
  readonly threadId: string | null;
  readonly attempt: number;
  readonly status: AiRunStatus;
  readonly workspacePath: string;
  readonly usage: Readonly<Record<string, unknown>> | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: AiJobError | null;
}

export interface AiRunAsset {
  readonly id: string;
  readonly runId: string;
  readonly fileRole: AiRunFileRole;
  readonly storagePath: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface AiJobEvent {
  readonly id: number;
  readonly jobId: string;
  readonly eventType: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AiJobDetail {
  readonly job: AiJob;
  readonly runs: readonly (AiRun & { readonly assets: readonly AiRunAsset[] })[];
  readonly events: readonly AiJobEvent[];
}

interface CreateAiJobInputBase {
  readonly projectId: string;
  readonly inputRevisionId: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly promptVersion: string;
  readonly retryOfJobId?: string;
}

export interface CreateSemanticAnalysisAiJobInput extends CreateAiJobInputBase {
  readonly kind: "semantic_analysis";
  readonly compositionId?: never;
  readonly options: AiAnalysisOptions;
}

export interface CreateRestorationRecommendationAiJobInput
  extends CreateAiJobInputBase {
  readonly kind: "restoration_recommendation";
  readonly compositionId: string;
  readonly options: AiRestorationRecommendationOptions;
}

export type CreateAiJobInput =
  | CreateSemanticAnalysisAiJobInput
  | CreateRestorationRecommendationAiJobInput;

export interface AiJobListFilters {
  readonly inputRevisionId?: string;
  readonly kind?: AiJobKind;
  readonly compositionId?: string;
}

export interface AiJobTransitionPatch {
  readonly inputHash?: string;
  readonly outputHash?: string;
  readonly resultRevisionId?: string;
  readonly reviewItems?: readonly AnalysisReviewItem[];
  readonly proposalSummary?: string;
  readonly advisoryResult?: ReplacementPlanProposal;
  readonly error?: AiJobError;
  readonly validatorReport?:
    | ProposalValidationReport
    | ReplacementPlanValidationReport;
}
