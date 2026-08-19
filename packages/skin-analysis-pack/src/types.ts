import type {
  ArmType,
  Rgba,
  SegmentationDocument,
  SemanticCategory,
  SemanticPixelSpan,
  SurfaceTexel,
} from "@mc-skin-split/skin-core";

export const CANDIDATE_REGION_ALGORITHM_VERSION = "bounded-color80-surface-cc-v2";
export const TAXONOMY_VERSION = "coarse-v2-no-unknown-components";
export const PROMPT_VERSION = "semantic-proposal-v5-bounded-transfers";
export type SemanticAnalysisBaseline = "empty" | "current";
export const ANALYSIS_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type AnalysisReasoningEffort =
  (typeof ANALYSIS_REASONING_EFFORTS)[number];

export interface CandidateRegion {
  readonly id: string;
  readonly surface: SurfaceTexel["surface"];
  readonly pixelIds: readonly number[];
  readonly pixelCount: number;
  readonly spans: readonly SemanticPixelSpan[];
  readonly rgba: Rgba;
  readonly dominantColor: string;
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface CandidateRegionDocument {
  readonly schemaVersion: "1.0";
  readonly algorithmVersion: typeof CANDIDATE_REGION_ALGORITHM_VERSION;
  readonly armType: ArmType;
  readonly visiblePixelCount: number;
  readonly regions: readonly CandidateRegion[];
}

export interface PixelMapDocument {
  readonly schemaVersion: "1.0";
  readonly atlasWidth: 64;
  readonly atlasHeight: 64;
  readonly coordinateOrigin: "top-left";
  readonly armType: ArmType;
  readonly items: readonly SurfaceTexel[];
}

export interface PaletteDocument {
  readonly schemaVersion: "1.0";
  readonly visiblePixelCount: number;
  readonly colors: readonly {
    readonly rgba: Rgba;
    readonly hex: string;
    readonly pixelCount: number;
  }[];
}

export interface AnalysisJobDocument {
  readonly schemaVersion: "1.0";
  readonly jobId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly armType: ArmType;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly semanticBaseline: SemanticAnalysisBaseline;
  readonly mode: "full";
  readonly taxonomyLevel: "coarse";
  readonly focus: readonly SemanticCategory[];
  readonly createRevisionOnSuccess: boolean;
  readonly candidateRegionAlgorithmVersion: typeof CANDIDATE_REGION_ALGORITHM_VERSION;
  readonly taxonomyVersion: typeof TAXONOMY_VERSION;
  readonly skillName: "mc-skin-segmenter";
  readonly skillVersion: string;
  readonly promptVersion: typeof PROMPT_VERSION;
  readonly paths: {
    readonly source: "input/source.png";
    readonly atlas: "input/atlas-16x.png";
    readonly atlasGrid: "input/atlas-grid-16x.png";
    readonly contactSheet: "input/face-contact-sheet.png";
    readonly pixelMap: "input/pixel-map.json";
    readonly palette: "input/palette.json";
    readonly candidateSummary: "input/candidate-summary.json";
    readonly candidateRegions: "input/candidate-regions.json";
    readonly previousSegmentation: "input/previous-segmentation.json";
    readonly outputSchema: "schema/analysis-proposal.schema.json";
    readonly proposal: "output/analysis-proposal.json";
    readonly validatorReport: "logs/validator-report.json";
  };
}

export interface BuildAnalysisPackInput {
  readonly workspaceDirectory: string;
  readonly skillDirectory: string;
  readonly proposalSchema: unknown;
  readonly jobId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly skinPng: Uint8Array;
  readonly armType: ArmType;
  readonly previousSegmentation: SegmentationDocument;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly semanticBaseline: SemanticAnalysisBaseline;
  readonly focus: readonly SemanticCategory[];
  readonly createRevisionOnSuccess: boolean;
  readonly skillVersion: string;
}

export interface AnalysisPack {
  readonly workspaceDirectory: string;
  readonly job: AnalysisJobDocument;
  readonly candidateRegions: CandidateRegionDocument;
  readonly pixelMap: PixelMapDocument;
  readonly palette: PaletteDocument;
  readonly previousSegmentation: SegmentationDocument;
  readonly inputHash: string;
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly imagePaths: readonly string[];
}
