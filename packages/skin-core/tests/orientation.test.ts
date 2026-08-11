import { describe, expect, it } from "vitest";
import {
  atlasLocalToCanonical,
  atlasToSurfaceModel,
  canonicalToAtlasLocal,
  getPixel,
  getSkinLayout,
  type Rotation,
  type SurfaceOrientation,
} from "../src";
import { decodeFixture } from "./helpers";

const rotations: readonly Rotation[] = [0, 90, 180, 270];
const canonicalCorners = {
  topLeft: [255, 23, 79, 255],
  topRight: [77, 255, 115, 255],
  bottomLeft: [53, 103, 255, 255],
  bottomRight: [255, 213, 47, 255],
};

describe("surface orientation transforms", () => {
  it("round-trips every rotation and flip combination", () => {
    for (const rotate of rotations) {
      for (const flipX of [false, true]) {
        for (const flipY of [false, true]) {
          const orientation: SurfaceOrientation = { rotate, flipX, flipY };
          for (let y = 0; y < 4; y += 1) {
            for (let x = 0; x < 3; x += 1) {
              const canonical = atlasLocalToCanonical(x, y, 3, 4, orientation);
              expect(
                canonicalToAtlasLocal(canonical.x, canonical.y, 3, 4, orientation),
              ).toEqual({ x, y });
            }
          }
        }
      }
    }
  });

  it("normalizes every calibration face to the same outside-facing corners", async () => {
    const image = await decodeFixture("uv-calibration.png");
    const model = atlasToSurfaceModel(image, getSkinLayout("wide"));
    const centers = new Set<string>();

    for (const surface of Object.values(model.surfaces)) {
      expect(getPixel(surface, 0, 0), `${surface.key} top-left`).toEqual(
        canonicalCorners.topLeft,
      );
      expect(
        getPixel(surface, surface.width - 1, 0),
        `${surface.key} top-right`,
      ).toEqual(canonicalCorners.topRight);
      expect(
        getPixel(surface, 0, surface.height - 1),
        `${surface.key} bottom-left`,
      ).toEqual(canonicalCorners.bottomLeft);
      expect(
        getPixel(surface, surface.width - 1, surface.height - 1),
        `${surface.key} bottom-right`,
      ).toEqual(canonicalCorners.bottomRight);

      centers.add(
        getPixel(
          surface,
          Math.floor(surface.width / 2),
          Math.floor(surface.height / 2),
        ).join(","),
      );
    }

    expect(centers.size).toBe(72);
  });
});
