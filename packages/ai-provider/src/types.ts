import type {
  ArmType,
  SemanticCategory,
  SemanticState,
} from "@mc-skin-split/skin-core";
import type {
  AnalysisPack,
  AnalysisReasoningEffort,
  ReplacementPlanningPack,
} from "@mc-skin-split/skin-analysis-pack";

export type ReviewItemType =
  | "ambiguous_region"
  | "low_confidence"
  | "coverage_gap"
  | "model_mismatch";

export interface ProposalPixelSpan {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
}

export type AnalysisProposalCategory = Exclude<SemanticCategory, "unknown">;

export interface AnalysisProposalComponent {
  readonly instanceId: string;
  readonly displayName: string;
  readonly category: AnalysisProposalCategory;
  readonly subtype: string | null;
  readonly confidence: number;
  readonly candidateRegionIds: readonly string[];
  readonly pixelOverrides: {
    readonly add: readonly ProposalPixelSpan[];
    readonly remove: readonly ProposalPixelSpan[];
  };
  readonly relations: {
    readonly attachedTo: string | null;
    readonly pairedWith: readonly string[];
    readonly sameOutfitGroup: string | null;
  };
  readonly notes: string;
}

export interface AnalysisReviewItem {
  readonly type: ReviewItemType;
  readonly candidateRegionIds: readonly string[];
  readonly question: string;
  readonly suggestedCategories: readonly AnalysisProposalCategory[];
  readonly confidence: number;
}

interface AnalysisProposalBase {
  readonly sourceRevisionId: string;
  readonly modelAssessment: {
    readonly armType: ArmType;
    readonly confidence: number;
  };
  readonly unassignedCandidateRegionIds: readonly string[];
  readonly summary: string;
}

export interface AnalysisProposalV1_1 extends AnalysisProposalBase {
  readonly schemaVersion: "1.1";
  readonly components: readonly AnalysisProposalComponent[];
  readonly reviewItems: readonly AnalysisReviewItem[];
}

/**
 * Read compatibility for proposals captured before the bounded-transfer contract.
 * New providers must emit AnalysisProposalV1_1.
 */
export interface AnalysisProposalV1 extends AnalysisProposalBase {
  readonly schemaVersion: "1.0";
  readonly components: readonly LegacyAnalysisProposalComponent[];
  readonly reviewItems: readonly LegacyAnalysisReviewItem[];
}

export type LegacyAnalysisProposalComponent = Omit<
  AnalysisProposalComponent,
  "category"
> & {
  readonly category: SemanticCategory;
};

export type LegacyAnalysisReviewItem = Omit<
  AnalysisReviewItem,
  "suggestedCategories"
> & {
  readonly suggestedCategories: readonly SemanticCategory[];
};

export type AnalysisProposal = AnalysisProposalV1 | AnalysisProposalV1_1;

export interface ProposalValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ProposalValidationReport {
  readonly schemaVersion: "1.0";
  readonly validatorVersion:
    | "semantic-proposal-validator-v1"
    | "semantic-proposal-validator-v2";
  readonly valid: boolean;
  readonly errors: readonly ProposalValidationIssue[];
  readonly warnings: readonly ProposalValidationIssue[];
  readonly stats: {
    readonly candidateRegionCount: number;
    readonly visiblePixelCount: number;
    readonly componentCount: number;
    readonly assignedPixelCount: number;
    readonly unknownPixelCount: number;
    readonly needsReviewComponentCount: number;
    readonly reviewItemCount: number;
    /** Present on validator v2 reports; optional only for stored v1 report compatibility. */
    readonly overrideUniquePixelCount?: number;
    /** Present on validator v2 reports; optional only for stored v1 report compatibility. */
    readonly overrideSpanCount?: number;
  };
}

export interface ValidatedAnalysisProposal {
  readonly proposal: AnalysisProposalV1_1;
  readonly state: SemanticState;
  readonly report: ProposalValidationReport & { readonly valid: true };
}

export type ProposalValidationResult =
  | ValidatedAnalysisProposal
  | {
      readonly proposal: AnalysisProposal | null;
      readonly state: null;
      readonly report: ProposalValidationReport & { readonly valid: false };
    };

export interface ProviderAnalysisInput {
  readonly jobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly model: string;
  readonly pack: AnalysisPack;
  readonly repairReport?: ProposalValidationReport;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProviderProgressEvent) => void;
}

export type ProviderProgressKind =
  | "session"
  | "turn"
  | "tool"
  | "output"
  | "usage"
  | "warning"
  | "error";

export interface ProviderProgressEvent {
  readonly kind: ProviderProgressKind;
  readonly message: string;
  readonly status?: "started" | "completed" | "failed";
  /** Sanitized correlation metadata; never contains tool output or reasoning. */
  readonly itemId?: string;
  readonly commandSummary?: string;
  readonly exitCode?: number;
}

export interface ProviderAnalysisResult {
  readonly proposal: unknown;
  readonly rawEvents: string;
  readonly stderr: string;
  readonly threadId?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
}

export interface SkinSemanticAiProvider {
  readonly providerName: string;
  analyze(input: ProviderAnalysisInput): Promise<ProviderAnalysisResult>;
  recommendReplacement?(
    input: ProviderReplacementInput,
  ): Promise<ProviderReplacementResult>;
}

export interface ReplacementPlanDecision {
  readonly targetGroupId: string;
  readonly selectedCandidateId: string | null;
  readonly rankedCandidateIds: readonly string[];
  readonly confidence: number;
  readonly explanation: string;
}

export interface ReplacementPlanProposal {
  readonly schemaVersion: "1.0";
  readonly jobId: string;
  readonly compositionId: string;
  readonly candidateSetHash: string;
  readonly decisions: readonly ReplacementPlanDecision[];
  readonly summary: string;
}

export interface ReplacementPlanValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ReplacementPlanValidationReport {
  readonly schemaVersion: "1.0";
  readonly validatorVersion: "replacement-plan-validator-v1";
  readonly valid: boolean;
  readonly errors: readonly ReplacementPlanValidationIssue[];
  readonly stats: {
    readonly targetGroupCount: number;
    readonly decisionCount: number;
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly deferredCount: number;
  };
}

export type ReplacementPlanValidationResult =
  | {
      readonly proposal: ReplacementPlanProposal;
      readonly report: ReplacementPlanValidationReport & { readonly valid: true };
    }
  | {
      readonly proposal: ReplacementPlanProposal | null;
      readonly report: ReplacementPlanValidationReport & { readonly valid: false };
    };

export interface ProviderReplacementInput {
  readonly jobId: string;
  readonly attempt: number;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly pack: ReplacementPlanningPack;
  readonly repairReport?: ReplacementPlanValidationReport;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProviderProgressEvent) => void;
}

export interface ProviderReplacementResult {
  readonly proposal: unknown;
  readonly rawEvents: string;
  readonly stderr: string;
  readonly threadId?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
}

export interface ProviderAvailability {
  readonly available: boolean;
  readonly provider: string;
  readonly version?: string;
  readonly message: string;
}
