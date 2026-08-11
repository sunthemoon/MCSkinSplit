import { getSurfaceDefinition } from "../layouts/layout";
import {
  SKIN_HEIGHT,
  SKIN_WIDTH,
  type RgbaImage,
  type SkinLayout,
  type SurfaceKey,
} from "../types";
import type { SemanticPixelSpan } from "./types";

export const SKIN_PIXEL_COUNT = SKIN_WIDTH * SKIN_HEIGHT;

export function pixelIdsToMask(pixelIds: Iterable<number>): Uint8Array {
  const mask = new Uint8Array(SKIN_PIXEL_COUNT);
  for (const pixelId of pixelIds) {
    assertPixelId(pixelId);
    mask[pixelId] = 1;
  }
  return mask;
}

export function maskToPixelIds(mask: Uint8Array): number[] {
  assertMask(mask);
  const pixelIds: number[] = [];
  for (let pixelId = 0; pixelId < mask.length; pixelId += 1) {
    if (mask[pixelId] !== 0) {
      pixelIds.push(pixelId);
    }
  }
  return pixelIds;
}

export function pixelIdsToSpans(
  pixelIds: Iterable<number>,
  layout: SkinLayout,
): SemanticPixelSpan[] {
  const mask = pixelIdsToMask(pixelIds);
  const spans: SemanticPixelSpan[] = [];

  for (const surfaceKey of layout.surfaceOrder) {
    const { atlasRect } = getSurfaceDefinition(layout, surfaceKey);
    for (let y = atlasRect.y; y < atlasRect.y + atlasRect.height; y += 1) {
      let x = atlasRect.x;
      while (x < atlasRect.x + atlasRect.width) {
        if (mask[y * SKIN_WIDTH + x] === 0) {
          x += 1;
          continue;
        }
        const x0 = x;
        while (
          x + 1 < atlasRect.x + atlasRect.width &&
          mask[y * SKIN_WIDTH + x + 1] !== 0
        ) {
          x += 1;
        }
        spans.push({ surface: surfaceKey, y, x0, x1: x });
        x += 1;
      }
    }
  }

  const representedCount = spans.reduce(
    (total, span) => total + span.x1 - span.x0 + 1,
    0,
  );
  if (representedCount !== maskToPixelIds(mask).length) {
    throw new RangeError("Pixel selection includes unused UV pixels");
  }
  return spans;
}

export function spansToPixelIds(
  spans: readonly SemanticPixelSpan[],
  layout: SkinLayout,
): number[] {
  const selected = new Set<number>();
  for (const span of spans) {
    assertSpan(span, layout);
    for (let x = span.x0; x <= span.x1; x += 1) {
      const pixelId = span.y * SKIN_WIDTH + x;
      if (selected.has(pixelId)) {
        throw new RangeError(`Semantic spans overlap at pixel ${x},${span.y}`);
      }
      selected.add(pixelId);
    }
  }
  return [...selected].sort((left, right) => left - right);
}

export function maskToRgbaImage(mask: Uint8Array): RgbaImage {
  assertMask(mask);
  const data = new Uint8Array(SKIN_PIXEL_COUNT * 4);
  for (let pixelId = 0; pixelId < mask.length; pixelId += 1) {
    if (mask[pixelId] !== 0) {
      const offset = pixelId * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }
  return { width: SKIN_WIDTH, height: SKIN_HEIGHT, data };
}

export function rgbaImageToMask(image: RgbaImage): Uint8Array {
  if (image.width !== SKIN_WIDTH || image.height !== SKIN_HEIGHT) {
    throw new RangeError(`Mask image must be 64x64, received ${image.width}x${image.height}`);
  }
  const mask = new Uint8Array(SKIN_PIXEL_COUNT);
  for (let pixelId = 0; pixelId < mask.length; pixelId += 1) {
    mask[pixelId] = image.data[pixelId * 4 + 3] === 0 ? 0 : 1;
  }
  return mask;
}

export function assertMask(mask: Uint8Array): void {
  if (mask.length !== SKIN_PIXEL_COUNT) {
    throw new RangeError(`Semantic mask must contain ${SKIN_PIXEL_COUNT} pixels`);
  }
  for (const value of mask) {
    if (value !== 0 && value !== 1) {
      throw new RangeError("Semantic mask values must be 0 or 1");
    }
  }
}

function assertSpan(span: SemanticPixelSpan, layout: SkinLayout): void {
  if (
    !Number.isInteger(span.y) ||
    !Number.isInteger(span.x0) ||
    !Number.isInteger(span.x1) ||
    span.x0 > span.x1
  ) {
    throw new RangeError("Semantic span coordinates must be ordered integers");
  }
  const surface = layout.surfaces[span.surface as SurfaceKey];
  if (!surface) {
    throw new RangeError(`Unknown semantic span surface: ${span.surface}`);
  }
  const rect = surface.atlasRect;
  if (
    span.y < rect.y ||
    span.y >= rect.y + rect.height ||
    span.x0 < rect.x ||
    span.x1 >= rect.x + rect.width
  ) {
    throw new RangeError(
      `Semantic span is outside ${span.surface}: ${span.x0}-${span.x1},${span.y}`,
    );
  }
}

function assertPixelId(pixelId: number): void {
  if (!Number.isInteger(pixelId) || pixelId < 0 || pixelId >= SKIN_PIXEL_COUNT) {
    throw new RangeError(`Pixel id must be an integer from 0 to ${SKIN_PIXEL_COUNT - 1}`);
  }
}
