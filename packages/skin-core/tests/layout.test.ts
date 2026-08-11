import { describe, expect, it } from "vitest";
import {
  createUsedUvMask,
  FACES,
  getSkinLayout,
  type AtlasRect,
  type BodyPart,
  type Layer,
  type SurfaceKey,
} from "../src";

interface ExpectedCuboid {
  readonly bodyPart: BodyPart;
  readonly layer: Layer;
  readonly x: number;
  readonly y: number;
  readonly wideWidth: number;
  readonly slimWidth: number;
  readonly height: number;
  readonly depth: number;
}

const expectedCuboids: readonly ExpectedCuboid[] = [
  { bodyPart: "head", layer: "base", x: 0, y: 0, wideWidth: 8, slimWidth: 8, height: 8, depth: 8 },
  { bodyPart: "head", layer: "outer", x: 32, y: 0, wideWidth: 8, slimWidth: 8, height: 8, depth: 8 },
  { bodyPart: "torso", layer: "base", x: 16, y: 16, wideWidth: 8, slimWidth: 8, height: 12, depth: 4 },
  { bodyPart: "torso", layer: "outer", x: 16, y: 32, wideWidth: 8, slimWidth: 8, height: 12, depth: 4 },
  { bodyPart: "rightArm", layer: "base", x: 40, y: 16, wideWidth: 4, slimWidth: 3, height: 12, depth: 4 },
  { bodyPart: "rightArm", layer: "outer", x: 40, y: 32, wideWidth: 4, slimWidth: 3, height: 12, depth: 4 },
  { bodyPart: "leftArm", layer: "base", x: 32, y: 48, wideWidth: 4, slimWidth: 3, height: 12, depth: 4 },
  { bodyPart: "leftArm", layer: "outer", x: 48, y: 48, wideWidth: 4, slimWidth: 3, height: 12, depth: 4 },
  { bodyPart: "rightLeg", layer: "base", x: 0, y: 16, wideWidth: 4, slimWidth: 4, height: 12, depth: 4 },
  { bodyPart: "rightLeg", layer: "outer", x: 0, y: 32, wideWidth: 4, slimWidth: 4, height: 12, depth: 4 },
  { bodyPart: "leftLeg", layer: "base", x: 16, y: 48, wideWidth: 4, slimWidth: 4, height: 12, depth: 4 },
  { bodyPart: "leftLeg", layer: "outer", x: 0, y: 48, wideWidth: 4, slimWidth: 4, height: 12, depth: 4 },
];

describe.each([
  ["wide" as const, 3264],
  ["slim" as const, 3136],
])("%s layout", (armType, expectedUsedPixels) => {
  const layout = getSkinLayout(armType);

  it("defines all 72 non-overlapping surfaces", () => {
    expect(layout.surfaceOrder).toHaveLength(72);
    expect(new Set(layout.surfaceOrder).size).toBe(72);
    expect(layout.usedPixelCount).toBe(expectedUsedPixels);
    expect(createUsedUvMask(layout).reduce((sum, value) => sum + value, 0)).toBe(
      expectedUsedPixels,
    );
  });

  it("matches the official cuboid atlas rectangles", () => {
    for (const cuboid of expectedCuboids) {
      const width = armType === "wide" ? cuboid.wideWidth : cuboid.slimWidth;
      const expected = faceRects(cuboid.x, cuboid.y, width, cuboid.height, cuboid.depth);

      for (const face of FACES) {
        const key: SurfaceKey = `${cuboid.bodyPart}.${cuboid.layer}.${face}`;
        expect(layout.surfaces[key].atlasRect, key).toEqual(expected[face]);
      }
    }
  });

  it("normalizes only bottom faces with a vertical flip", () => {
    for (const key of layout.surfaceOrder) {
      const surface = layout.surfaces[key];
      expect(surface.orientation).toEqual({
        rotate: 0,
        flipX: false,
        flipY: surface.face === "bottom",
      });
    }
  });
});

function faceRects(
  x: number,
  y: number,
  width: number,
  height: number,
  depth: number,
): Record<(typeof FACES)[number], AtlasRect> {
  return {
    top: { x: x + depth, y, width, height: depth },
    bottom: { x: x + depth + width, y, width, height: depth },
    left: { x, y: y + depth, width: depth, height },
    front: { x: x + depth, y: y + depth, width, height },
    right: { x: x + depth + width, y: y + depth, width: depth, height },
    back: { x: x + depth * 2 + width, y: y + depth, width, height },
  };
}
