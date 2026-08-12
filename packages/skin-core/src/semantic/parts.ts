import { createRgbaImage } from "../image";
import { getSkinLayout } from "../layouts/layout";
import type { ArmType, Rgba, RgbaImage } from "../types";
import { assertMask, maskToPixelIds, pixelIdsToMask } from "./mask";
import type {
  PartApplicationReport,
  PartManifest,
  PartPixelConflict,
  SemanticComponent,
} from "./types";

export interface ExportedPart {
  readonly manifest: PartManifest;
  readonly texture: RgbaImage;
  readonly writeMask: Uint8Array;
  readonly preview: RgbaImage;
}

const MANNEQUIN_BASE: Rgba = [226, 229, 224, 255];
const MANNEQUIN_SHADOW: Rgba = [194, 201, 197, 255];
const MANNEQUIN_TOP: Rgba = [242, 244, 240, 255];

/**
 * Builds a complete neutral skin for inspecting a sparse reusable part in 3D.
 * The part's write mask remains authoritative; transparent texture pixels never
 * erase the mannequin.
 */
export function createPartMannequinTexture(
  partTexture: RgbaImage,
  writeMask: Uint8Array,
  armType: ArmType,
): RgbaImage {
  if (partTexture.width !== 64 || partTexture.height !== 64) {
    throw new RangeError("Part mannequin requires a 64x64 texture");
  }
  assertMask(writeMask);
  const result = createRgbaImage(64, 64);
  const layout = getSkinLayout(armType);

  for (const surfaceKey of layout.surfaceOrder) {
    const surface = layout.surfaces[surfaceKey];
    if (surface.layer !== "base") continue;
    const color =
      surface.face === "top"
        ? MANNEQUIN_TOP
        : surface.face === "back" || surface.face === "bottom"
          ? MANNEQUIN_SHADOW
          : MANNEQUIN_BASE;
    const rect = surface.atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        result.data.set(color, (y * 64 + x) * 4);
      }
    }
  }

  for (const pixelId of maskToPixelIds(writeMask)) {
    const offset = pixelId * 4;
    if (partTexture.data[offset + 3] !== 0) {
      result.data.set(partTexture.data.subarray(offset, offset + 4), offset);
    }
  }
  return result;
}

export function exportSemanticPart(input: {
  readonly id: string;
  readonly name?: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly armType: ArmType;
  readonly createdAt: string;
  readonly image: RgbaImage;
  readonly component: SemanticComponent;
  readonly componentMask: Uint8Array;
}): ExportedPart {
  assertMask(input.componentMask);
  const textureData = new Uint8Array(input.image.data.length);
  const coloredPixelIds: number[] = [];
  for (const pixelId of maskToPixelIds(input.componentMask)) {
    const offset = pixelId * 4;
    if (input.image.data[offset + 3] === 0) {
      continue;
    }
    textureData.set(input.image.data.subarray(offset, offset + 4), offset);
    coloredPixelIds.push(pixelId);
  }
  const writeMask = pixelIdsToMask(coloredPixelIds);
  const texture = createRgbaImage(64, 64, textureData);
  const surfaces = [...new Set(input.component.spans.map((span) => span.surface))];
  const preferredLayers = [
    ...new Set(surfaces.map((surface) => surface.split(".")[1] as "base" | "outer")),
  ];
  const touchesArm = surfaces.some(
    (surface) => surface.startsWith("leftArm.") || surface.startsWith("rightArm."),
  );
  const manifest: PartManifest = {
    schemaVersion: "1.0",
    id: input.id,
    name: input.name?.trim() || input.component.displayName,
    category: input.component.category,
    ...(input.component.subtype ? { subtype: input.component.subtype } : {}),
    source: {
      projectId: input.projectId,
      revisionId: input.revisionId,
      componentInstanceId: input.component.instanceId,
    },
    compatibility: {
      resolution: "64x64",
      armTypes: touchesArm ? [input.armType] : ["wide", "slim"],
    },
    placement: { preferredLayers, surfaces },
    relations: { softConflicts: [], hardConflicts: [] },
    palette: { dominant: input.component.palette.dominant },
    maskMode: "write-colored-pixels-only",
    createdAt: input.createdAt,
  };
  return { manifest, texture, writeMask, preview: texture };
}

export function analyzePartApplication(
  base: RgbaImage,
  partTexture: RgbaImage,
  writeMask: Uint8Array,
  manifest: PartManifest,
  targetArmType: ArmType,
): PartApplicationReport {
  assertCompatibleImages(base, partTexture);
  assertMask(writeMask);
  const conflicts: PartPixelConflict[] = [];
  let hardConflictCount = 0;
  let sameColorOverlapCount = 0;

  for (const pixelId of maskToPixelIds(writeMask)) {
    const baseRgba = readRgba(base, pixelId);
    const partRgba = readRgba(partTexture, pixelId);
    if (baseRgba[3] === 0) {
      continue;
    }
    if (rgbaEqual(baseRgba, partRgba)) {
      sameColorOverlapCount += 1;
      conflicts.push({
        type: "same_color_overlap",
        pixelId,
        x: pixelId % 64,
        y: Math.floor(pixelId / 64),
        baseRgba,
        partRgba,
      });
    } else {
      hardConflictCount += 1;
      conflicts.push({
        type: "hard_conflict",
        pixelId,
        x: pixelId % 64,
        y: Math.floor(pixelId / 64),
        baseRgba,
        partRgba,
      });
    }
  }
  const modelConflict = !manifest.compatibility.armTypes.includes(targetArmType);
  return {
    compatible: !modelConflict,
    modelConflict,
    writePixelCount: maskToPixelIds(writeMask).length,
    hardConflictCount,
    sameColorOverlapCount,
    layerConflictCount: 0,
    unknownConflictCount: 0,
    conflicts,
  };
}

export function applyPartPixels(
  base: RgbaImage,
  partTexture: RgbaImage,
  writeMask: Uint8Array,
  strategy: "use_part" | "keep_base",
): RgbaImage {
  assertCompatibleImages(base, partTexture);
  assertMask(writeMask);
  const data = base.data.slice();
  for (const pixelId of maskToPixelIds(writeMask)) {
    const offset = pixelId * 4;
    if (strategy === "keep_base" && base.data[offset + 3] !== 0) {
      continue;
    }
    data.set(partTexture.data.subarray(offset, offset + 4), offset);
  }
  return createRgbaImage(64, 64, data);
}

function assertCompatibleImages(left: RgbaImage, right: RgbaImage): void {
  if (
    left.width !== 64 ||
    left.height !== 64 ||
    right.width !== 64 ||
    right.height !== 64
  ) {
    throw new RangeError("Part composition requires two 64x64 images");
  }
}

function readRgba(image: RgbaImage, pixelId: number): Rgba {
  const offset = pixelId * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

function rgbaEqual(left: Rgba, right: Rgba): boolean {
  return left.every((value, index) => value === right[index]);
}
