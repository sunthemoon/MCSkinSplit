import { createRgbaImage } from "../image";
import { createUsedUvMask, getSkinLayout } from "../layouts/layout";
import {
  SKIN_HEIGHT,
  SKIN_WIDTH,
  type ArmType,
  type Rgba,
  type RgbaImage,
  type SkinLayout,
  type SurfaceKey,
} from "../types";
import { getOrientedSize } from "../uv/orientation";
import { assertSkinImage, buildSurfaceTexels } from "../uv/surface-model";
import { assertMask } from "./mask";
import type { SemanticPixelSpan } from "./types";

export type PartRepairTransform =
  | "identity"
  | "mirror_u"
  | "mirror_v"
  | "rotate_180";

export type PartRepairOverwriteMode = "all" | "transparent_only";

export interface PartRepairState {
  readonly armType: ArmType;
  readonly texture: RgbaImage;
  readonly writeMask: Uint8Array;
}

export interface PartRepairCopyMapping {
  readonly sourceSurface: SurfaceKey;
  readonly targetSurface: SurfaceKey;
  readonly transform?: PartRepairTransform;
}

export type PartRepairOperation =
  | {
      readonly type: "paint_color";
      readonly spans: readonly SemanticPixelSpan[];
      readonly rgba: Rgba;
    }
  | {
      readonly type: "erase_pixels";
      readonly spans: readonly SemanticPixelSpan[];
    }
  | {
      readonly type: "replace_color";
      readonly from: Rgba;
      readonly to: Rgba;
      readonly spans?: readonly SemanticPixelSpan[];
    }
  | {
      readonly type: "copy_surfaces";
      readonly source: PartRepairState;
      readonly mappings: readonly PartRepairCopyMapping[];
      readonly overwrite?: PartRepairOverwriteMode;
    };

export interface PartRepairResult extends PartRepairState {
  readonly changedPixelIds: readonly number[];
}

/**
 * Applies one exact pixel operation without mutating either input state.
 * The returned mask is always derived from the returned texture alpha.
 */
export function applyPartRepairOperation(
  state: PartRepairState,
  operation: PartRepairOperation,
): PartRepairResult {
  const checked = normalizeState(state, "Part repair target");
  const layout = getSkinLayout(checked.armType);
  const texture = cloneImage(checked.texture);
  const changed = new Set<number>();

  switch (operation.type) {
    case "paint_color": {
      assertRgba("Paint color", operation.rgba, false);
      for (const pixelId of spansToUniquePixelIds(operation.spans, layout)) {
        writeIfChanged(texture, pixelId, operation.rgba, changed);
      }
      break;
    }
    case "erase_pixels": {
      for (const pixelId of spansToUniquePixelIds(operation.spans, layout)) {
        writeIfChanged(texture, pixelId, [0, 0, 0, 0], changed);
      }
      break;
    }
    case "replace_color": {
      assertRgba("Source color", operation.from, true);
      assertRgba("Replacement color", operation.to, false);
      if (operation.from[3] === 0 && !operation.spans) {
        throw new RangeError(
          "Replacing transparent pixels requires an explicit repair selection",
        );
      }
      const pixelIds = operation.spans
        ? spansToUniquePixelIds(operation.spans, layout)
        : nonTransparentUsedPixelIds(texture, layout);
      for (const pixelId of pixelIds) {
        if (rgbaAt(texture, pixelId).every((value, index) => value === operation.from[index])) {
          writeIfChanged(texture, pixelId, operation.to, changed);
        }
      }
      break;
    }
    case "copy_surfaces": {
      applySurfaceCopies(
        texture,
        checked,
        operation.source,
        operation.mappings,
        operation.overwrite ?? "all",
        changed,
      );
      break;
    }
  }

  return {
    armType: checked.armType,
    texture,
    writeMask: derivePartWriteMask(texture, checked.armType),
    changedPixelIds: [...changed].sort((left, right) => left - right),
  };
}

/** Derives the authoritative part mask from exact texture alpha inside valid UV. */
export function derivePartWriteMask(
  texture: RgbaImage,
  armType: ArmType,
): Uint8Array {
  assertSkinImage(texture);
  const usedUv = createUsedUvMask(getSkinLayout(armType));
  const mask = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT);
  for (let pixelId = 0; pixelId < mask.length; pixelId += 1) {
    const alpha = texture.data[pixelId * 4 + 3]!;
    if (usedUv[pixelId] === 0) {
      if (alpha !== 0) {
        throw new RangeError(`Part texture contains colored unused UV pixel ${pixelId}`);
      }
      continue;
    }
    mask[pixelId] = alpha === 0 ? 0 : 1;
  }
  return mask;
}

/**
 * Produces canonical left/right limb surface mappings. The transform mirrors the
 * surface horizontally so outside-facing canonical coordinates stay anatomical.
 */
export function createLimbMirrorMappings(input: {
  readonly sourceSide: "left" | "right";
  readonly limb: "arm" | "leg";
  readonly layer: "base" | "outer";
}): readonly PartRepairCopyMapping[] {
  const sourceBody = `${input.sourceSide}${input.limb === "arm" ? "Arm" : "Leg"}`;
  const targetSide = input.sourceSide === "left" ? "right" : "left";
  const targetBody = `${targetSide}${input.limb === "arm" ? "Arm" : "Leg"}`;
  return ["front", "back", "left", "right", "top", "bottom"].map((face) => ({
    sourceSurface: `${sourceBody}.${input.layer}.${face}` as SurfaceKey,
    targetSurface: `${targetBody}.${input.layer}.${mirrorFace(face)}` as SurfaceKey,
    transform: "mirror_u",
  }));
}

function applySurfaceCopies(
  targetTexture: RgbaImage,
  target: PartRepairState,
  sourceInput: PartRepairState,
  mappings: readonly PartRepairCopyMapping[],
  overwrite: PartRepairOverwriteMode,
  changed: Set<number>,
): void {
  if (mappings.length === 0) {
    throw new RangeError("Surface copy requires at least one mapping");
  }
  if (overwrite !== "all" && overwrite !== "transparent_only") {
    throw new TypeError(`Unknown overwrite mode: ${String(overwrite)}`);
  }
  const source = normalizeState(sourceInput, "Part repair source");
  const sourceLayout = getSkinLayout(source.armType);
  const targetLayout = getSkinLayout(target.armType);
  const sourceTexels = surfaceTexelIndex(source.texture, sourceLayout);
  const targetTexels = surfaceTexelIndex(target.texture, targetLayout);
  const targetIds = new Set<number>();

  for (const mapping of mappings) {
    const sourceSurface = sourceLayout.surfaces[mapping.sourceSurface];
    const targetSurface = targetLayout.surfaces[mapping.targetSurface];
    if (!sourceSurface || !targetSurface) {
      throw new RangeError(
        `Unknown surface mapping ${mapping.sourceSurface} -> ${mapping.targetSurface}`,
      );
    }
    const sourceSize = getOrientedSize(
      sourceSurface.atlasRect.width,
      sourceSurface.atlasRect.height,
      sourceSurface.orientation,
    );
    const targetSize = getOrientedSize(
      targetSurface.atlasRect.width,
      targetSurface.atlasRect.height,
      targetSurface.orientation,
    );
    if (sourceSize.width !== targetSize.width || sourceSize.height !== targetSize.height) {
      throw new RangeError(
        `Surface dimensions are incompatible: ${mapping.sourceSurface} ${sourceSize.width}x${sourceSize.height} -> ${mapping.targetSurface} ${targetSize.width}x${targetSize.height}`,
      );
    }
    const transform = mapping.transform ?? "identity";
    for (let v = 0; v < sourceSize.height; v += 1) {
      for (let u = 0; u < sourceSize.width; u += 1) {
        const destination = transformCoordinate(
          u,
          v,
          sourceSize.width,
          sourceSize.height,
          transform,
        );
        const targetPixelId = requireIndexedTexel(
          targetTexels,
          mapping.targetSurface,
          destination.u,
          destination.v,
        );
        if (targetIds.has(targetPixelId)) {
          throw new RangeError(`Surface mappings duplicate target pixel ${targetPixelId}`);
        }
        targetIds.add(targetPixelId);
      }
    }
  }

  for (const mapping of mappings) {
    const sourceSurface = sourceLayout.surfaces[mapping.sourceSurface];
    const targetSurface = targetLayout.surfaces[mapping.targetSurface];
    if (!sourceSurface || !targetSurface) {
      throw new RangeError(
        `Unknown surface mapping ${mapping.sourceSurface} -> ${mapping.targetSurface}`,
      );
    }
    const sourceSize = getOrientedSize(
      sourceSurface.atlasRect.width,
      sourceSurface.atlasRect.height,
      sourceSurface.orientation,
    );
    const targetSize = getOrientedSize(
      targetSurface.atlasRect.width,
      targetSurface.atlasRect.height,
      targetSurface.orientation,
    );
    if (sourceSize.width !== targetSize.width || sourceSize.height !== targetSize.height) {
      throw new RangeError(
        `Surface dimensions are incompatible: ${mapping.sourceSurface} ${sourceSize.width}x${sourceSize.height} -> ${mapping.targetSurface} ${targetSize.width}x${targetSize.height}`,
      );
    }

    const transform = mapping.transform ?? "identity";
    for (let v = 0; v < sourceSize.height; v += 1) {
      for (let u = 0; u < sourceSize.width; u += 1) {
        const destination = transformCoordinate(
          u,
          v,
          sourceSize.width,
          sourceSize.height,
          transform,
        );
        const sourcePixelId = requireIndexedTexel(
          sourceTexels,
          mapping.sourceSurface,
          u,
          v,
        );
        const targetPixelId = requireIndexedTexel(
          targetTexels,
          mapping.targetSurface,
          destination.u,
          destination.v,
        );
        if (source.writeMask[sourcePixelId] === 0) {
          continue;
        }
        if (
          overwrite === "transparent_only" &&
          targetTexture.data[targetPixelId * 4 + 3] !== 0
        ) {
          continue;
        }
        writeIfChanged(targetTexture, targetPixelId, rgbaAt(source.texture, sourcePixelId), changed);
      }
    }
  }
}

function normalizeState(state: PartRepairState, name: string): PartRepairState {
  if (state.armType !== "wide" && state.armType !== "slim") {
    throw new TypeError(`${name} has invalid arm type: ${String(state.armType)}`);
  }
  assertSkinImage(state.texture);
  assertMask(state.writeMask);
  const derived = derivePartWriteMask(state.texture, state.armType);
  if (!derived.every((value, pixelId) => value === state.writeMask[pixelId])) {
    throw new RangeError(`${name} write mask does not match texture alpha`);
  }
  return state;
}

function spansToUniquePixelIds(
  spans: readonly SemanticPixelSpan[],
  layout: SkinLayout,
): number[] {
  if (spans.length === 0) {
    throw new RangeError("Part repair selection cannot be empty");
  }
  const selected = new Set<number>();
  for (const span of spans) {
    const surface = layout.surfaces[span.surface];
    if (
      !surface ||
      !Number.isInteger(span.y) ||
      !Number.isInteger(span.x0) ||
      !Number.isInteger(span.x1) ||
      span.x0 > span.x1
    ) {
      throw new RangeError(`Invalid repair span on ${span.surface}`);
    }
    const rect = surface.atlasRect;
    if (
      span.y < rect.y ||
      span.y >= rect.y + rect.height ||
      span.x0 < rect.x ||
      span.x1 >= rect.x + rect.width
    ) {
      throw new RangeError(`Repair span is outside ${span.surface}`);
    }
    for (let x = span.x0; x <= span.x1; x += 1) {
      const pixelId = span.y * SKIN_WIDTH + x;
      if (selected.has(pixelId)) {
        throw new RangeError(`Repair selection duplicates target pixel ${pixelId}`);
      }
      selected.add(pixelId);
    }
  }
  return [...selected].sort((left, right) => left - right);
}

function nonTransparentUsedPixelIds(image: RgbaImage, layout: SkinLayout): number[] {
  const usedUv = createUsedUvMask(layout);
  const pixelIds: number[] = [];
  for (let pixelId = 0; pixelId < SKIN_WIDTH * SKIN_HEIGHT; pixelId += 1) {
    if (usedUv[pixelId] !== 0 && image.data[pixelId * 4 + 3] !== 0) {
      pixelIds.push(pixelId);
    }
  }
  return pixelIds;
}

function surfaceTexelIndex(
  image: RgbaImage,
  layout: SkinLayout,
): ReadonlyMap<string, number> {
  return new Map(
    buildSurfaceTexels(image, layout).map((texel) => [
      `${texel.surface}:${texel.localU},${texel.localV}`,
      texel.pixelId,
    ]),
  );
}

function requireIndexedTexel(
  index: ReadonlyMap<string, number>,
  surface: SurfaceKey,
  u: number,
  v: number,
): number {
  const pixelId = index.get(`${surface}:${u},${v}`);
  if (pixelId === undefined) {
    throw new RangeError(`Canonical coordinate is outside ${surface}: ${u},${v}`);
  }
  return pixelId;
}

function transformCoordinate(
  u: number,
  v: number,
  width: number,
  height: number,
  transform: PartRepairTransform,
): { readonly u: number; readonly v: number } {
  switch (transform) {
    case "identity":
      return { u, v };
    case "mirror_u":
      return { u: width - 1 - u, v };
    case "mirror_v":
      return { u, v: height - 1 - v };
    case "rotate_180":
      return { u: width - 1 - u, v: height - 1 - v };
    default:
      throw new TypeError(`Unknown surface transform: ${String(transform)}`);
  }
}

function mirrorFace(face: string): string {
  if (face === "left") return "right";
  if (face === "right") return "left";
  return face;
}

function assertRgba(name: string, rgba: Rgba, allowTransparent: boolean): void {
  if (
    !Array.isArray(rgba) ||
    rgba.length !== 4 ||
    rgba.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    throw new RangeError(`${name} must contain four byte values`);
  }
  if (!allowTransparent && rgba[3] === 0) {
    throw new RangeError(`${name} alpha must be nonzero; use erase_pixels to remove pixels`);
  }
}

function rgbaAt(image: RgbaImage, pixelId: number): Rgba {
  const offset = pixelId * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

function writeIfChanged(
  image: RgbaImage,
  pixelId: number,
  rgba: Rgba,
  changed: Set<number>,
): void {
  const current = rgbaAt(image, pixelId);
  if (current.every((value, index) => value === rgba[index])) {
    return;
  }
  image.data.set(rgba, pixelId * 4);
  changed.add(pixelId);
}

function cloneImage(image: RgbaImage): RgbaImage {
  return createRgbaImage(SKIN_WIDTH, SKIN_HEIGHT, image.data.slice());
}
