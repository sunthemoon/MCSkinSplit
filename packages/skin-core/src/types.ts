export const SKIN_WIDTH = 64;
export const SKIN_HEIGHT = 64;

export const BODY_PARTS = [
  "head",
  "torso",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
] as const;

export const LAYERS = ["base", "outer"] as const;
export const FACES = ["front", "back", "left", "right", "top", "bottom"] as const;

export type ArmType = "wide" | "slim";
export type BodyPart = (typeof BODY_PARTS)[number];
export type Layer = (typeof LAYERS)[number];
export type Face = (typeof FACES)[number];
export type CuboidKey = `${BodyPart}.${Layer}`;
export type SurfaceKey = `${BodyPart}.${Layer}.${Face}`;
export type Rotation = 0 | 90 | 180 | 270;
export type Rgba = [number, number, number, number];

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface AtlasRect extends Point {
  readonly width: number;
  readonly height: number;
}

export interface SurfaceOrientation {
  readonly rotate: Rotation;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

export interface CuboidDefinition {
  readonly origin: Point;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export interface LayoutSource {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly armType: ArmType;
  readonly faceOrientations: Readonly<Record<Face, SurfaceOrientation>>;
  readonly cuboids: Readonly<Record<CuboidKey, CuboidDefinition>>;
}

export interface SurfaceDefinition {
  readonly key: SurfaceKey;
  readonly bodyPart: BodyPart;
  readonly layer: Layer;
  readonly face: Face;
  readonly atlasRect: AtlasRect;
  readonly orientation: SurfaceOrientation;
}

export interface SkinLayout {
  readonly id: string;
  readonly width: 64;
  readonly height: 64;
  readonly armType: ArmType;
  readonly surfaces: Readonly<Record<SurfaceKey, SurfaceDefinition>>;
  readonly surfaceOrder: readonly SurfaceKey[];
  readonly usedPixelCount: number;
}

export interface SurfaceTexture {
  readonly key: SurfaceKey;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface SurfaceModel {
  readonly layoutId: string;
  readonly armType: ArmType;
  readonly atlasWidth: 64;
  readonly atlasHeight: 64;
  readonly surfaces: Readonly<Record<SurfaceKey, SurfaceTexture>>;
  readonly unusedAtlasData: Uint8Array;
}

export interface SurfaceTexel {
  readonly pixelId: number;
  readonly atlasX: number;
  readonly atlasY: number;
  readonly rgba: Rgba;
  readonly surface: SurfaceKey;
  readonly bodyPart: BodyPart;
  readonly face: Face;
  readonly layer: Layer;
  readonly localU: number;
  readonly localV: number;
  readonly isUsedUvPixel: true;
}
