import { assertSkinImage } from "../uv/surface-model";
import type { ArmType, RgbaImage } from "../types";

interface MarkerRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const SLIM_MARKER_REGIONS: readonly MarkerRegion[] = [
  { x: 50, y: 16, width: 2, height: 4 },
  { x: 54, y: 20, width: 2, height: 12 },
  { x: 42, y: 48, width: 2, height: 4 },
  { x: 46, y: 52, width: 2, height: 12 },
];

export type ArmTypeInferenceReason =
  | "transparent-slim-markers"
  | "black-slim-markers"
  | "white-slim-markers"
  | "wide-default";

export interface ArmTypeAssessment {
  readonly armType: ArmType;
  readonly reason: ArmTypeInferenceReason;
}

export function assessArmType(image: RgbaImage): ArmTypeAssessment {
  assertSkinImage(image);

  if (SLIM_MARKER_REGIONS.some((region) => areaHasTransparency(image, region))) {
    return { armType: "slim", reason: "transparent-slim-markers" };
  }

  if (SLIM_MARKER_REGIONS.every((region) => areaIsColor(image, region, 0))) {
    return { armType: "slim", reason: "black-slim-markers" };
  }

  if (SLIM_MARKER_REGIONS.every((region) => areaIsColor(image, region, 255))) {
    return { armType: "slim", reason: "white-slim-markers" };
  }

  return { armType: "wide", reason: "wide-default" };
}

export function inferArmType(image: RgbaImage): ArmType {
  return assessArmType(image).armType;
}

function areaHasTransparency(image: RgbaImage, region: MarkerRegion): boolean {
  return areaSome(image, region, (offset) => image.data[offset + 3]! < 255);
}

function areaIsColor(image: RgbaImage, region: MarkerRegion, value: number): boolean {
  return areaEvery(
    image,
    region,
    (offset) =>
      image.data[offset] === value &&
      image.data[offset + 1] === value &&
      image.data[offset + 2] === value &&
      image.data[offset + 3] === 255,
  );
}

function areaSome(
  image: RgbaImage,
  region: MarkerRegion,
  predicate: (offset: number) => boolean,
): boolean {
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      if (predicate((y * image.width + x) * 4)) {
        return true;
      }
    }
  }
  return false;
}

function areaEvery(
  image: RgbaImage,
  region: MarkerRegion,
  predicate: (offset: number) => boolean,
): boolean {
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      if (!predicate((y * image.width + x) * 4)) {
        return false;
      }
    }
  }
  return true;
}
