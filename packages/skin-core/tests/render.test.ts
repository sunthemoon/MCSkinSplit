import { describe, expect, it } from "vitest";
import {
  atlasToSurfaceModel,
  createRgbaImage,
  getPixel,
  getSkinLayout,
  renderFaceContactSheet,
  scaleNearest,
  setPixel,
} from "../src";
import { decodeFixture } from "./helpers";

describe("deterministic derived renders", () => {
  it("scales only by nearest-neighbor pixel replication", () => {
    const source = createRgbaImage(2, 1);
    setPixel(source, 0, 0, [1, 2, 3, 4]);
    setPixel(source, 1, 0, [5, 6, 7, 8]);

    const result = scaleNearest(source, 3);
    expect(result.width).toBe(6);
    expect(result.height).toBe(3);
    for (let y = 0; y < 3; y += 1) {
      expect(getPixel(result, 0, y)).toEqual([1, 2, 3, 4]);
      expect(getPixel(result, 2, y)).toEqual([1, 2, 3, 4]);
      expect(getPixel(result, 3, y)).toEqual([5, 6, 7, 8]);
      expect(getPixel(result, 5, y)).toEqual([5, 6, 7, 8]);
    }
  });

  it("creates a 1024x1024 16x atlas", async () => {
    const source = await decodeFixture("wide-basic.png");
    const result = scaleNearest(source, 16);
    expect([result.width, result.height]).toEqual([1024, 1024]);
    expect(getPixel(result, 160, 192)).toEqual(getPixel(source, 10, 12));
  });

  it("renders all 72 faces in semantic contact-sheet order", async () => {
    const image = await decodeFixture("uv-calibration.png");
    const model = atlasToSurfaceModel(image, getSkinLayout("wide"));
    const sheet = renderFaceContactSheet(model, { scale: 3, padding: 1, gutter: 1 });

    expect(sheet.cells).toHaveLength(72);
    expect(sheet.cells.slice(0, 7).map((cell) => cell.key)).toEqual([
      "head.base.front",
      "head.base.back",
      "head.base.left",
      "head.base.right",
      "head.base.top",
      "head.base.bottom",
      "head.outer.front",
    ]);

    for (const cell of sheet.cells) {
      const source = model.surfaces[cell.key];
      expect(getPixel(sheet.image, cell.x, cell.y)).toEqual(getPixel(source, 0, 0));
      expect(getPixel(sheet.image, cell.x + 2, cell.y + 2)).toEqual(
        getPixel(source, 0, 0),
      );
    }
  });
});
