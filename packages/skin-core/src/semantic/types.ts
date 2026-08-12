import type { ArmType, Rgba, SurfaceKey } from "../types";
import type { SemanticCategory } from "./taxonomy";

export interface SemanticPixelSpan {
  readonly surface: SurfaceKey;
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
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
  readonly provenance: {
    readonly actorType: "user" | "ai" | "system";
    readonly aiRunId?: string;
    readonly containsGeneratedPixels: false;
  };
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
    };

export interface PartRepairDerivation {
  readonly kind: "part_repair";
  readonly basePartId: string;
  readonly partEditProjectId: string;
  readonly partEditRevisionId: string;
  readonly containsGeneratedPixels: false;
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

/**
 * Immutable reusable-part metadata. Version 1.1 is reserved for deterministic
 * part-repair outputs and therefore requires repair ancestry; ordinary semantic
 * exports remain version 1.0 and cannot claim a derivation.
 */
export type PartManifest = PartManifestV1 | PartRepairManifestV1_1;

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
