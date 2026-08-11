import { describe, expect, it } from "vitest";
import {
  assessArmType,
  createRgbaImage,
  fillImage,
  inferArmType,
  setPixel,
  type Rgba,
  type RgbaImage,
} from "../src";
import { decodeFixture } from "./helpers";

const markerRegions = [
  { x: 50, y: 16, width: 2, height: 4 },
  { x: 54, y: 20, width: 2, height: 12 },
  { x: 42, y: 48, width: 2, height: 4 },
  { x: 46, y: 52, width: 2, height: 12 },
];

describe("Wide/Slim inference", () => {
  it("recognizes deterministic wide and slim fixtures", async () => {
    await expect(decodeFixture("wide-basic.png").then(inferArmType)).resolves.toBe(
      "wide",
    );
    await expect(decodeFixture("slim-basic.png").then(inferArmType)).resolves.toBe(
      "slim",
    );
  });

  it.each([
    [[0, 0, 0, 255] as Rgba, "black-slim-markers"],
    [[255, 255, 255, 255] as Rgba, "white-slim-markers"],
  ])("recognizes reserved marker color %j", (markerColor, reason) => {
    const image = opaqueImage();
    paintMarkers(image, markerColor);

    expect(assessArmType(image)).toEqual({ armType: "slim", reason });
  });

  it("recognizes transparency in any slim-only marker region", () => {
    const image = opaqueImage();
    setPixel(image, 50, 16, [10, 20, 30, 0]);

    expect(assessArmType(image)).toEqual({
      armType: "slim",
      reason: "transparent-slim-markers",
    });
  });

  it("defaults to wide for opaque non-marker colors", () => {
    expect(assessArmType(opaqueImage())).toEqual({
      armType: "wide",
      reason: "wide-default",
    });
  });
});

function opaqueImage(): RgbaImage {
  const image = createRgbaImage(64, 64);
  fillImage(image, [14, 37, 71, 255]);
  return image;
}

function paintMarkers(image: RgbaImage, rgba: Rgba): void {
  for (const region of markerRegions) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        setPixel(image, x, y, rgba);
      }
    }
  }
}
