import {
  MAX_COMPLETION_PROPOSAL_CANDIDATES,
  type CompletionCandidateStrategy,
  type CompletionConfidence,
  type CompletionProposal,
  type CompletionRequestedRepresentation,
  type CompletionSourceSnapshot,
  type CompletionTargetRepresentation,
} from "@mc-skin-split/skin-core";
import type { AnalysisReasoningEffort } from "./types";

export const COMPLETION_RANKING_PACK_SCHEMA_VERSION = "1.0" as const;
export const COMPLETION_RANKING_PROMPT_VERSION =
  "completion-candidate-ranking-v1" as const;
export const COMPLETION_RANKING_PREVIEW_RENDERER_VERSION =
  "completion-candidate-preview-v1" as const;
export const MAX_COMPLETION_RANKING_CANDIDATES =
  MAX_COMPLETION_PROPOSAL_CANDIDATES;

export interface CompletionRankingImageAttachment {
  readonly role: "source_skin" | "candidate_preview";
  readonly path: string;
  readonly candidateId: string | null;
}

export interface CompletionRankingCandidateEvidence {
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly evidenceHash: string;
  readonly strategy: CompletionCandidateStrategy;
  readonly complete: boolean;
  readonly confidence: CompletionConfidence;
  readonly confidenceScore: number | null;
  readonly pixelCount: number;
  readonly missingPixelCount: number;
  readonly previewPath: string;
}

/**
 * Hash-bound, pixel-free evidence exposed as JSON. Exact pixels are available to
 * the model only through deterministic preview attachments.
 */
export interface CompletionRankingEvidenceDocument {
  readonly schemaVersion: typeof COMPLETION_RANKING_PACK_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly proposalEvidenceHash: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly armType: "wide" | "slim";
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly requestedRepresentation: CompletionRequestedRepresentation;
  readonly representation: CompletionTargetRepresentation;
  readonly allowedGeneratedPixelCount: number;
  readonly candidateCount: number;
  readonly candidates: readonly CompletionRankingCandidateEvidence[];
}

export interface CompletionRankingJobDocument {
  readonly schemaVersion: typeof COMPLETION_RANKING_PACK_SCHEMA_VERSION;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly promptVersion: typeof COMPLETION_RANKING_PROMPT_VERSION;
  readonly previewRendererVersion: typeof COMPLETION_RANKING_PREVIEW_RENDERER_VERSION;
  readonly imageAttachments: readonly CompletionRankingImageAttachment[];
}

export interface CompletionRankingPackPaths {
  readonly evidence: "input/completion-ranking-evidence.json";
  readonly manifest: "input/manifest.json";
  readonly sourcePreview: "input/previews/000-source.png";
  readonly outputSchema: "schema/completion-ranking.schema.json";
  readonly proposal: "output/completion-ranking.json";
  readonly validatorReport: "logs/validator-report.json";
  readonly previousValidatorReport: "logs/previous-validator-report.json";
}

export interface CompletionRankingPackManifest {
  readonly schemaVersion: typeof COMPLETION_RANKING_PACK_SCHEMA_VERSION;
  readonly inputHash: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface BuildCompletionRankingPackInput {
  readonly workspaceDirectory: string;
  readonly proposalSchema: unknown;
  readonly jobId: string;
  readonly completionProposal: CompletionProposal;
  readonly source: CompletionSourceSnapshot;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
}

export interface CompletionRankingPack {
  readonly workspaceDirectory: string;
  readonly job: CompletionRankingJobDocument;
  readonly evidence: CompletionRankingEvidenceDocument;
  /** Host-only authoritative value. It is never serialized into the model prompt. */
  readonly completionProposal: CompletionProposal;
  /** Host-only source used by the strict validator. */
  readonly source: CompletionSourceSnapshot;
  readonly inputHash: string;
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly manifestHash: string;
  readonly paths: CompletionRankingPackPaths;
  readonly imageAttachments: readonly CompletionRankingImageAttachment[];
  readonly imagePaths: readonly string[];
}
