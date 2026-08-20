import slimLayoutJson from "./slim-64.json" with { type: "json" };
import wideLayoutJson from "./wide-64.json" with { type: "json" };
import {
  BODY_PARTS,
  FACES,
  LAYERS,
  SKIN_HEIGHT,
  SKIN_WIDTH,
  type ArmType,
  type AtlasRect,
  type CuboidDefinition,
  type CuboidKey,
  type Face,
  type LayoutSource,
  type SkinLayout,
  type SurfaceDefinition,
  type SurfaceKey,
} from "../types";

function cuboidFaceRects(cuboid: CuboidDefinition): Record<Face, AtlasRect> {
  const { x, y } = cuboid.origin;
  const { width, height, depth } = cuboid;

  return {
    top: { x: x + depth, y, width, height: depth },
    bottom: { x: x + depth + width, y, width, height: depth },
    left: { x, y: y + depth, width: depth, height },
    front: { x: x + depth, y: y + depth, width, height },
    right: { x: x + depth + width, y: y + depth, width: depth, height },
    back: { x: x + depth * 2 + width, y: y + depth, width, height },
  };
}

function expandLayout(source: LayoutSource): SkinLayout {
  if (source.width !== SKIN_WIDTH || source.height !== SKIN_HEIGHT) {
    throw new Error(`Layout ${source.id} must describe a 64x64 atlas`);
  }

  const surfaces: Partial<Record<SurfaceKey, SurfaceDefinition>> = {};
  const surfaceOrder: SurfaceKey[] = [];
  const occupancy = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT);
  let usedPixelCount = 0;

  for (const bodyPart of BODY_PARTS) {
    for (const layer of LAYERS) {
      const cuboidKey: CuboidKey = `${bodyPart}.${layer}`;
      const cuboid = source.cuboids[cuboidKey];

      if (!cuboid) {
        throw new Error(`Layout ${source.id} is missing cuboid ${cuboidKey}`);
      }

      const faceRects = cuboidFaceRects(cuboid);

      for (const face of FACES) {
        const key: SurfaceKey = `${bodyPart}.${layer}.${face}`;
        const atlasRect = faceRects[face];
        const orientation = source.faceOrientations[face];

        assertRectInsideAtlas(source.id, key, atlasRect);

        for (let y = atlasRect.y; y < atlasRect.y + atlasRect.height; y += 1) {
          for (let x = atlasRect.x; x < atlasRect.x + atlasRect.width; x += 1) {
            const index = y * SKIN_WIDTH + x;
            if (occupancy[index] !== 0) {
              throw new Error(`Layout ${source.id} overlaps at atlas pixel ${x},${y}`);
            }
            occupancy[index] = 1;
            usedPixelCount += 1;
          }
        }

        surfaces[key] = {
          key,
          bodyPart,
          layer,
          face,
          atlasRect,
          orientation,
        };
        surfaceOrder.push(key);
      }
    }
  }

  if (surfaceOrder.length !== 72) {
    throw new Error(`Layout ${source.id} must expose 72 surfaces`);
  }

  return {
    id: source.id,
    width: SKIN_WIDTH,
    height: SKIN_HEIGHT,
    armType: source.armType,
    surfaces: surfaces as Record<SurfaceKey, SurfaceDefinition>,
    surfaceOrder,
    usedPixelCount,
  };
}

function assertRectInsideAtlas(
  layoutId: string,
  key: SurfaceKey,
  rect: AtlasRect,
): void {
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > SKIN_WIDTH ||
    rect.y + rect.height > SKIN_HEIGHT
  ) {
    throw new RangeError(
      `Layout ${layoutId} surface ${key} is outside the 64x64 atlas`,
    );
  }
}

const wideLayout = expandLayout(wideLayoutJson as LayoutSource);
const slimLayout = expandLayout(slimLayoutJson as LayoutSource);

export function getSkinLayout(armType: ArmType): SkinLayout {
  return armType === "wide" ? wideLayout : slimLayout;
}

export function getSurfaceDefinition(
  layout: SkinLayout,
  key: SurfaceKey,
): SurfaceDefinition {
  const surface = layout.surfaces[key];
  if (!surface) {
    throw new Error(`Unknown surface ${key} in layout ${layout.id}`);
  }
  return surface;
}

export function createUsedUvMask(layout: SkinLayout): Uint8Array {
  const mask = new Uint8Array(layout.width * layout.height);

  for (const key of layout.surfaceOrder) {
    const { atlasRect } = getSurfaceDefinition(layout, key);
    for (let y = atlasRect.y; y < atlasRect.y + atlasRect.height; y += 1) {
      const rowOffset = y * layout.width;
      mask.fill(1, rowOffset + atlasRect.x, rowOffset + atlasRect.x + atlasRect.width);
    }
  }

  return mask;
}
