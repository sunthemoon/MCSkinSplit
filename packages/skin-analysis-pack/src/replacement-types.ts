import type { AnalysisReasoningEffort } from "./types";

export const REPLACEMENT_PLANNING_PROMPT_VERSION =
  "replacement-candidate-recommendation-v1";

export type PublicRestorationCandidateKind =
  | "current_same_surface"
  | "current_same_body_part"
  | "mirrored_counterpart"
  | "donor_revision"
  | "manual_rgba";

export type PublicRestorationRgba = readonly [number, number, number, 255];

export interface PublicRestorationCandidate {
  readonly id: string;
  readonly kind: PublicRestorationCandidateKind;
  readonly targetGroupId: string;
  readonly label: string;
  readonly description: string;
  readonly pixelCount: number;
  readonly coveragePixelCount: number;
  readonly sourceRevisionId?: string;
  readonly rgba?: PublicRestorationRgba;
  readonly selectedByDefault?: boolean;
}

/** Browser-safe public DTO. It intentionally has no masks, coordinates, or operations. */
export interface PublicRestorationCandidateCatalog {
  readonly compositionId: string;
  readonly version: number;
  readonly candidateSetHash: string;
  readonly targetComponentIds: readonly string[];
  readonly outer: {
    readonly pixelCount: number;
    readonly candidateId: string | null;
  };
  readonly base: {
    readonly pixelCount: number;
    readonly coveredPixelCount: number;
    readonly missingPixelCount: number;
    readonly candidates: readonly PublicRestorationCandidate[];
  };
}

export interface ReplacementPlanningJobDocument {
  readonly schemaVersion: "1.0";
  readonly jobId: string;
  readonly userIntent: string;
}

export interface ReplacementPlanningPackPaths {
  readonly candidateCatalog: "input/restoration-candidates.json";
  readonly manifest: "input/manifest.json";
  readonly outputSchema: "schema/replacement-plan.schema.json";
  readonly proposal: "output/replacement-plan.json";
  readonly validatorReport: "logs/validator-report.json";
  readonly previousValidatorReport: "logs/previous-validator-report.json";
}

export interface ReplacementPlanningPackManifest {
  readonly schemaVersion: "1.0";
  readonly inputHash: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface BuildReplacementPlanningPackInput {
  readonly workspaceDirectory: string;
  readonly skillDirectory: string;
  readonly proposalSchema: unknown;
  readonly jobId: string;
  readonly userIntent: string;
  readonly candidateCatalog: PublicRestorationCandidateCatalog;
  readonly skillVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
}

export interface ReplacementPlanningPack {
  readonly workspaceDirectory: string;
  readonly job: ReplacementPlanningJobDocument;
  readonly candidateCatalog: PublicRestorationCandidateCatalog;
  readonly inputHash: string;
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly manifestHash: string;
  readonly paths: ReplacementPlanningPackPaths;
  readonly imagePaths: readonly [];
}

export interface ReplacementPlanningExecutionOptions {
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
}
