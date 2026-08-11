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
  readonly unresolvedConflictCount: number;
  readonly committable: boolean;
  readonly conflicts: readonly CompositionConflict[];
}

export interface CompositionResult {
  readonly image: RgbaImage;
  readonly report: CompositionReport;
  readonly winningPixelIdsByLayer: Readonly<Record<string, readonly number[]>>;
}

export interface ComposeSkinInput {
  readonly base: RgbaImage;
  readonly targetArmType: ArmType;
  readonly layers: readonly CompositionLayerInput[];
  readonly resolutionMode?: CompositionResolutionMode;
  readonly conflictWinners?: Readonly<Record<string, string>>;
}
