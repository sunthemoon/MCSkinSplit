import { describe, expect, it } from "vitest";
import {
  atlasToSurfaceModel,
  buildSurfaceTexels,
  getSkinLayout,
  surfaceModelToAtlas,
} from "../src";
import { decodeFixture } from "./helpers";

const cases = [
  ["wide-basic.png", "wide" as const],
  ["slim-basic.png", "slim" as const],
  ["rgba-alpha.png", "wide" as const],
  ["indexed-color.png", "wide" as const],
  ["uv-calibration.png", "wide" as const],
] as const;

describe("Atlas and canonical surface model", () => {
  it.each(cases)("round-trips every RGBA byte in %s", async (fileName, armType) => {
    const image = await decodeFixture(fileName);
    const layout = getSkinLayout(armType);
    const model = atlasToSurfaceModel(image, layout);
    const result = surfaceModelToAtlas(model, layout);

    expect(result.data).toEqual(image.data);
  });

  it.each([
    ["wide-basic.png", "wide" as const, 3264],
    ["slim-basic.png", "slim" as const, 3136],
  ])("builds a unique fixed pixel map for %s", async (fileName, armType, count) => {
    const image = await decodeFixture(fileName);
    const layout = getSkinLayout(armType);
    const texels = buildSurfaceTexels(image, layout);

    expect(texels).toHaveLength(count);
    expect(new Set(texels.map((texel) => texel.pixelId)).size).toBe(count);

    for (const texel of texels) {
      expect(texel.pixelId).toBe(texel.atlasY * 64 + texel.atlasX);
      expect(texel.surface).toBe(
        `${texel.bodyPart}.${texel.layer}.${texel.face}`,
      );
      expect(texel.localU).toBeGreaterThanOrEqual(0);
      expect(texel.localV).toBeGreaterThanOrEqual(0);
    }
  });
});
