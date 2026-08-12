import type {
  ArmType,
  SemanticCategory,
  SemanticState,
} from "@mc-skin-split/skin-core";
import type { AnalysisPack } from "@mc-skin-split/skin-analysis-pack";

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

export interface AnalysisProposalComponent {
  readonly instanceId: string;
  readonly displayName: string;
  readonly category: SemanticCategory;
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
  readonly suggestedCategories: readonly SemanticCategory[];
  readonly confidence: number;
}

export interface AnalysisProposal {
  readonly schemaVersion: "1.0";
  readonly sourceRevisionId: string;
  readonly modelAssessment: {
    readonly armType: ArmType;
    readonly confidence: number;
  };
  readonly components: readonly AnalysisProposalComponent[];
  readonly unassignedCandidateRegionIds: readonly string[];
  readonly reviewItems: readonly AnalysisReviewItem[];
  readonly summary: string;
}

export interface ProposalValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ProposalValidationReport {
  readonly schemaVersion: "1.0";
  readonly validatorVersion: "semantic-proposal-validator-v1";
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
  };
}

export interface ValidatedAnalysisProposal {
  readonly proposal: AnalysisProposal;
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
}

export interface ProviderAvailability {
  readonly available: boolean;
  readonly provider: string;
  readonly version?: string;
  readonly message: string;
}
