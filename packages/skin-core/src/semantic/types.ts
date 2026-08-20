import type { ArmType, Rgba, SurfaceKey } from "../types";
import type { SemanticCategory } from "./taxonomy";

export interface SemanticPixelSpan {
  readonly surface: SurfaceKey;
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
}

export type PixelIntrinsicOrigin =
  | "source_visible"
  | "manual_authored"
  | "generated_completion"
  | "legacy_mixed";

export interface PixelOriginActor {
  readonly type: "user" | "ai" | "system";
  readonly id?: string;
}

export interface SourceVisiblePixelOriginEvidence {
  readonly sourceRevisionId: string;
}

export interface ManualAuthoredPixelOriginEvidence {
  readonly actor: PixelOriginActor;
  readonly operationId: string;
}

export interface GeneratedCompletionPixelOriginEvidence {
  readonly candidateId: string;
  readonly evidenceHash: string;
  readonly decisionId: string;
  readonly actor: PixelOriginActor;
}

export interface LegacyMixedPixelOriginEvidence {
  readonly sourceRevisionId: string;
}

export type PixelOriginSubject =
  | { readonly kind: "revision"; readonly id: string }
  | { readonly kind: "part"; readonly id: string }
  | { readonly kind: "part_edit_revision"; readonly id: string };

export type PixelOriginEntry =
  | {
      readonly intrinsicOrigin: "source_visible";
      readonly evidence: SourceVisiblePixelOriginEvidence;
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly intrinsicOrigin: "manual_authored";
      readonly evidence: ManualAuthoredPixelOriginEvidence;
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly intrinsicOrigin: "generated_completion";
      readonly evidence: GeneratedCompletionPixelOriginEvidence;
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly intrinsicOrigin: "legacy_mixed";
      readonly evidence: LegacyMixedPixelOriginEvidence;
      readonly spans: readonly SemanticPixelSpan[];
    };

export interface PixelCopySource {
  readonly sourceSubject: PixelOriginSubject;
  readonly sourceComponentInstanceId: string | null;
  readonly sourcePixelId: number;
}

export interface PixelCopyLineageEntry {
  readonly pixelId: number;
  readonly derivation: "copied";
  /** Immediate ancestry; older ancestry is followed through the immutable source document. */
  readonly copiedFrom: PixelCopySource;
}

export interface PixelOriginDocument {
  readonly schemaVersion: "1.0";
  readonly subject: PixelOriginSubject;
  readonly source: {
    readonly width: 64;
    readonly height: 64;
    readonly armType: ArmType;
    readonly coordinateOrigin: "top-left";
  };
  readonly entries: readonly PixelOriginEntry[];
  readonly copyLineage: readonly PixelCopyLineageEntry[];
}

export type PixelOriginEvidence = PixelOriginEntry["evidence"];

export interface PixelOriginRecord {
  readonly intrinsicOrigin: PixelIntrinsicOrigin;
  readonly evidence: PixelOriginEvidence;
  readonly copyLineage: PixelCopySource | null;
}

export interface PixelOriginAssignment extends PixelOriginRecord {
  readonly pixelId: number;
}

export interface PixelOriginSummary {
  readonly counts: Readonly<Record<PixelIntrinsicOrigin, number>>;
  readonly containsGeneratedPixels: boolean;
}

export interface ComponentRelations {
  readonly attachedTo: string | null;
  readonly pairedWith: readonly string[];
  readonly sameOutfitGroup: string | null;
  readonly conflictsWith?: readonly string[];
}

export interface ComponentPalette {
  readonly dominant: string;
  readonly colors: readonly string[];
}

export interface CompositionRestorationProvenance {
  readonly kind: "composition_restoration";
  readonly planHash: string;
  readonly candidateIds: readonly string[];
  readonly sourceRevisionIds: readonly string[];
  readonly sourceComponentIds: readonly string[];
}

export interface SemanticComponentProvenance {
  readonly actorType: "user" | "ai" | "system";
  readonly aiRunId?: string;
  /** Compatibility summary: true only when an owned origin is generated_completion. */
  readonly containsGeneratedPixels: boolean;
  /** Derived per-component pixel counts; absent only on readable legacy snapshots. */
  readonly originSummary?: PixelOriginSummary;
  readonly restoration?: CompositionRestorationProvenance;
}

export interface SemanticComponent {
  readonly instanceId: string;
  readonly displayName: string;
  readonly category: SemanticCategory;
  readonly subtype?: string;
  readonly confidence: number;
  readonly reviewState: "confirmed" | "needs_review";
  readonly maskFile: string;
  readonly spans: readonly SemanticPixelSpan[];
  readonly palette: ComponentPalette;
  readonly relations: ComponentRelations;
  readonly provenance: SemanticComponentProvenance;
}

export interface SegmentationDocument {
  readonly schemaVersion: "1.0";
  readonly revisionId: string;
  readonly source: {
    readonly width: 64;
    readonly height: 64;
    readonly armType: ArmType;
    readonly coordinateOrigin: "top-left";
    readonly sourceHash: string;
  };
  readonly components: readonly SemanticComponent[];
  readonly unknown: {
    readonly maskFile: string;
    readonly pixelCount: number;
  };
}

export interface SemanticState {
  readonly document: SegmentationDocument;
  readonly masks: Readonly<Record<string, Uint8Array>>;
  readonly unknownMask: Uint8Array;
}

export interface SemanticComponentInput {
  readonly instanceId: string;
  readonly displayName: string;
  readonly category: SemanticCategory;
  readonly subtype?: string;
}

export interface ProvenanceSemanticAssignment {
  readonly target: SemanticComponentInput;
  readonly spans: readonly SemanticPixelSpan[];
  readonly provenance: SemanticComponentProvenance;
}

export type ManualSemanticOperation =
  | {
      readonly type: "assign_pixels";
      readonly target: SemanticComponentInput;
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly type: "unassign_pixels";
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly type: "merge_components";
      readonly componentIds: readonly string[];
      readonly target: SemanticComponentInput;
    }
  | {
      readonly type: "split_component";
      readonly sourceComponentId: string;
      readonly target: SemanticComponentInput;
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly type: "reclassify_component";
      readonly componentId: string;
      readonly category: SemanticCategory;
      readonly subtype?: string;
    }
  | {
      readonly type: "set_component_relations";
      readonly componentId: string;
      readonly relations: {
        readonly attachedTo: string | null;
        readonly pairedWith: readonly string[];
        readonly sameOutfitGroup: string | null;
        readonly conflictsWith: readonly string[];
      };
    };

export interface PartRepairDerivation {
  readonly kind: "part_repair";
  readonly basePartId: string;
  readonly partEditProjectId: string;
  readonly partEditRevisionId: string;
  readonly containsGeneratedPixels: false;
}

export interface PartRepairDerivationV2 {
  readonly kind: "part_repair";
  readonly basePartId: string;
  readonly partEditProjectId: string;
  readonly partEditRevisionId: string;
  /** Summary only; origin.json remains authoritative. */
  readonly containsGeneratedPixels: boolean;
}

export interface PartOriginArtifacts {
  readonly schemaVersion: "1.0";
  readonly file: "origin.json";
  readonly generatedMaskFile: "generated-mask.png";
  /** Deterministically derived from origin.json. */
  readonly summary: PixelOriginSummary;
  /** Compatibility summary; must equal summary.containsGeneratedPixels. */
  readonly containsGeneratedPixels: boolean;
}

interface PartManifestBase {
  readonly id: string;
  readonly name: string;
  readonly category: SemanticCategory;
  readonly subtype?: string;
  readonly source: {
    readonly projectId: string;
    readonly revisionId: string;
    readonly componentInstanceId: string;
  };
  readonly compatibility: {
    readonly resolution: "64x64";
    readonly armTypes: readonly ArmType[];
  };
  readonly placement: {
    readonly preferredLayers: readonly ("base" | "outer")[];
    readonly surfaces: readonly SurfaceKey[];
  };
  readonly relations: {
    readonly softConflicts: readonly string[];
    readonly hardConflicts: readonly string[];
  };
  readonly palette: {
    readonly dominant: string;
  };
  readonly maskMode: "write-colored-pixels-only";
  readonly createdAt: string;
}

export interface PartManifestV1 extends PartManifestBase {
  readonly schemaVersion: "1.0";
  readonly derivation?: never;
}

export interface PartRepairManifestV1_1 extends PartManifestBase {
  readonly schemaVersion: "1.1";
  readonly derivation: PartRepairDerivation;
}

export interface PartManifestV2 extends PartManifestBase {
  readonly schemaVersion: "2.0";
  readonly origin: PartOriginArtifacts;
  readonly derivation?: PartRepairDerivationV2;
}

/**
 * Immutable reusable-part metadata. Versions 1.0/1.1 remain readable legacy
 * shapes. New exports use 2.0 with exact origin artifacts; 2.0 repair outputs
 * retain their immutable repair ancestry.
 */
export type PartManifest = PartManifestV1 | PartRepairManifestV1_1 | PartManifestV2;

export type PartConflictType =
  | "hard_conflict"
  | "same_color_overlap"
  | "layer_conflict"
  | "model_conflict"
  | "unknown_conflict";

export interface PartPixelConflict {
  readonly type: Exclude<PartConflictType, "model_conflict">;
  readonly pixelId: number;
  readonly x: number;
  readonly y: number;
  readonly baseRgba: Rgba;
  readonly partRgba: Rgba;
}

export interface PartApplicationReport {
  readonly compatible: boolean;
  readonly modelConflict: boolean;
  readonly writePixelCount: number;
  readonly hardConflictCount: number;
  readonly sameColorOverlapCount: number;
  readonly layerConflictCount: number;
  readonly unknownConflictCount: number;
  readonly conflicts: readonly PartPixelConflict[];
}
