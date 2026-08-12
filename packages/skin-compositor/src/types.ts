import type {
  ArmType,
  PartManifest,
  Rgba,
  RgbaImage,
} from "@mc-skin-split/skin-core";

export const COMPOSITION_BASE_LAYER_ID = "base";

export type CompositionResolutionMode = "unresolved" | "layer_order";

export interface CompositionLayerInput {
  readonly layerId: string;
  readonly partId: string;
  readonly position: number;
  readonly texture: RgbaImage;
  readonly writeMask: Uint8Array;
  readonly manifest: PartManifest;
}

/**
 * Deterministic pixels that replace selected pixels of the fixed base before
 * ordinary part layers are evaluated. A transparent result is only valid on an
 * Outer UV surface; Base UV surfaces must always receive an opaque RGBA fill.
 */
export interface CompositionRestorationPlan {
  readonly operations: readonly CompositionRestorationOperation[];
}

export type CompositionRestorationOperation =
  | {
      readonly operationId: string;
      readonly mode: "clear_outer";
      readonly mask: Uint8Array;
    }
  | {
      readonly operationId: string;
      readonly mode: "fill_base";
      readonly mask: Uint8Array;
      readonly rgba: Rgba;
    };

export interface CompositionPixelWrite {
  readonly layerId: string;
  readonly partId: string | null;
  readonly position: number;
  readonly rgba: Rgba;
}

export interface CompositionPixelConflict {
  readonly id: string;
  readonly type: "hard_conflict" | "same_color_overlap";
  readonly blocking: boolean;
  readonly resolved: boolean;
  readonly pixelId: number;
  readonly x: number;
  readonly y: number;
  readonly writes: readonly CompositionPixelWrite[];
  readonly defaultWinnerLayerId: string;
  readonly winnerLayerId: string;
}

export interface CompositionModelConflict {
  readonly id: string;
  readonly type: "model_conflict";
  readonly blocking: true;
  readonly resolved: false;
  readonly layerId: string;
  readonly partId: string;
  readonly targetArmType: ArmType;
  readonly supportedArmTypes: readonly ArmType[];
}

export interface CompositionUnknownConflict {
  readonly id: string;
  readonly type: "unknown_conflict";
  readonly blocking: true;
  readonly resolved: false;
  readonly layerId: string;
  readonly partId: string;
  readonly pixelIds: readonly number[];
}

export type CompositionConflict =
  | CompositionPixelConflict
  | CompositionModelConflict
  | CompositionUnknownConflict;

export interface CompositionReport {
  readonly targetArmType: ArmType;
  readonly layerCount: number;
  readonly writePixelCount: number;
  readonly appliedPixelCount: number;
  readonly hardConflictCount: number;
  readonly sameColorOverlapCount: number;
  readonly layerConflictCount: number;
  readonly modelConflictCount: number;
  readonly unknownConflictCount: number;
  readonly restorationPixelCount: number;
  readonly restoredOuterPixelCount: number;
  readonly restoredBasePixelCount: number;
  /** Requested cleanup pixels not covered by the materialized restoration plan. */
  readonly restorationMissingPixelCount: number;
  /** Non-conflict restoration validation or coverage issues. */
  readonly restorationIssueCount: number;
  readonly unresolvedConflictCount: number;
  readonly committable: boolean;
  readonly conflicts: readonly CompositionConflict[];
}

export interface CompositionResult {
  readonly image: RgbaImage;
  readonly report: CompositionReport;
  readonly winningPixelIdsByLayer: Readonly<Record<string, readonly number[]>>;
  readonly restoredPixelIdsByOperation: Readonly<Record<string, readonly number[]>>;
}

export interface ComposeSkinInput {
  readonly base: RgbaImage;
  readonly targetArmType: ArmType;
  readonly layers: readonly CompositionLayerInput[];
  readonly restorationPlan?: CompositionRestorationPlan;
  readonly restorationAssessment?: {
    readonly missingPixelCount: number;
    readonly issueCount: number;
  };
  readonly resolutionMode?: CompositionResolutionMode;
  readonly conflictWinners?: Readonly<Record<string, string>>;
}
