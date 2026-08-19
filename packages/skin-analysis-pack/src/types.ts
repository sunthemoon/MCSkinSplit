import type {
  ArmType,
  Rgba,
  SegmentationDocument,
  SemanticCategory,
  SemanticPixelSpan,
  SurfaceTexel,
} from "@mc-skin-split/skin-core";
import type {
  CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION,
  CandidateEvidenceGraphSummary,
  CandidateEvidenceGraphDocument,
} from "./candidate-evidence-graph";
import type {
  CANDIDATE_GROUNDING_RENDERER_VERSION,
  CandidateGroundingManifest,
} from "./render-analysis";

export const CANDIDATE_REGION_ALGORITHM_VERSION = "bounded-color80-surface-cc-v2";
export const TAXONOMY_VERSION = "coarse-v2-no-unknown-components";
export const PROMPT_VERSION = "semantic-proposal-v7-all-surface-grounding";
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
  readonly schemaVersion: "1.1";
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
  readonly candidateEvidenceGraphAlgorithmVersion: typeof CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION;
  readonly candidateGroundingRendererVersion: typeof CANDIDATE_GROUNDING_RENDERER_VERSION;
  readonly taxonomyVersion: typeof TAXONOMY_VERSION;
  readonly skillName: "mc-skin-segmenter";
  readonly skillVersion: string;
  readonly promptVersion: typeof PROMPT_VERSION;
  readonly imageAttachments: readonly AnalysisImageAttachment[];
  readonly paths: {
    readonly source: "input/source.png";
    readonly atlas: "input/atlas-16x.png";
    readonly atlasGrid: "input/atlas-grid-16x.png";
    readonly contactSheet: "input/face-contact-sheet.png";
    readonly pixelMap: "input/pixel-map.json";
    readonly palette: "input/palette.json";
    readonly candidateSummary: "input/candidate-summary.json";
    readonly candidateRegions: "input/candidate-regions.json";
    readonly candidateEvidenceGraph: "input/candidate-evidence-graph.json";
    readonly candidateEvidenceSummary: "input/candidate-evidence-summary.json";
    readonly candidateGroundingManifest: "input/candidate-grounding-manifest.json";
    readonly candidateGroundingAtlas: "input/grounding/candidate-atlas-16x.png";
    readonly candidateGroundingFaceContact: "input/grounding/candidate-face-contact-sheet.png";
    readonly candidateGroundingAllSurfacePair: "input/grounding/all-surface-natural-candidate-pair.png";
    readonly candidateGroundingLegend: "input/grounding/legend.png";
    readonly candidateGroundingCompositeNatural: "input/grounding/composite-natural.png";
    readonly candidateGroundingCompositeRegions: "input/grounding/composite-regions.png";
    readonly candidateGroundingBaseNatural: "input/grounding/base-natural.png";
    readonly candidateGroundingBaseRegions: "input/grounding/base-regions.png";
    readonly candidateGroundingOuterNatural: "input/grounding/outer-natural.png";
    readonly candidateGroundingOuterRegions: "input/grounding/outer-regions.png";
    readonly previousSegmentation: "input/previous-segmentation.json";
    readonly outputSchema: "schema/analysis-proposal.schema.json";
    readonly proposal: "output/analysis-proposal.json";
    readonly validatorReport: "logs/validator-report.json";
  };
}

export type AnalysisImageAttachmentRole =
  | "atlas_grid"
  | "candidate_region_atlas"
  | "face_contact"
  | "candidate_region_face_contact"
  | "all_surface_natural_candidate_pair"
  | "orthographic_composite_natural"
  | "orthographic_composite_regions"
  | "orthographic_base_natural"
  | "orthographic_base_regions"
  | "orthographic_outer_natural"
  | "orthographic_outer_regions"
  | "candidate_region_legend";

export interface AnalysisImageAttachment {
  readonly role: AnalysisImageAttachmentRole;
  readonly path: string;
}

export const ANALYSIS_IMAGE_ATTACHMENT_CONTRACT = [
  { role: "atlas_grid", path: "input/atlas-grid-16x.png" },
  {
    role: "candidate_region_atlas",
    path: "input/grounding/candidate-atlas-16x.png",
  },
  {
    role: "all_surface_natural_candidate_pair",
    path: "input/grounding/all-surface-natural-candidate-pair.png",
  },
  {
    role: "orthographic_composite_natural",
    path: "input/grounding/composite-natural.png",
  },
  {
    role: "orthographic_composite_regions",
    path: "input/grounding/composite-regions.png",
  },
  {
    role: "orthographic_base_natural",
    path: "input/grounding/base-natural.png",
  },
  {
    role: "orthographic_base_regions",
    path: "input/grounding/base-regions.png",
  },
  {
    role: "orthographic_outer_natural",
    path: "input/grounding/outer-natural.png",
  },
  {
    role: "orthographic_outer_regions",
    path: "input/grounding/outer-regions.png",
  },
  { role: "candidate_region_legend", path: "input/grounding/legend.png" },
] as const satisfies readonly AnalysisImageAttachment[];

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
  readonly candidateEvidenceGraph: CandidateEvidenceGraphDocument;
  readonly candidateEvidenceSummary: CandidateEvidenceGraphSummary;
  readonly candidateGroundingManifest: CandidateGroundingManifest;
  readonly pixelMap: PixelMapDocument;
  readonly palette: PaletteDocument;
  readonly previousSegmentation: SegmentationDocument;
  readonly inputHash: string;
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly imageAttachments: readonly AnalysisImageAttachment[];
  readonly imagePaths: readonly string[];
}
