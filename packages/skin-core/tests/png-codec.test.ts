import { describe, expect, it } from "vitest";
import {
  createRgbaImage,
  decodePngRgba,
  decodeSkinPng,
  encodePngRgba,
  encodeSkinPng,
  getPixel,
  SkinPngError,
} from "../src";
import { readFixtureBytes } from "./helpers";

const fixtures = [
  "wide-basic.png",
  "slim-basic.png",
  "rgba-alpha.png",
  "indexed-color.png",
  "uv-calibration.png",
];

describe("PNG RGBA codec", () => {
  it.each(fixtures)("decodes and re-encodes %s without pixel changes", async (fileName) => {
    const decoded = decodeSkinPng(await readFixtureBytes(fileName));
    const redecoded = decodeSkinPng(encodeSkinPng(decoded));

    expect(redecoded.width).toBe(64);
    expect(redecoded.height).toBe(64);
    expect(redecoded.data).toEqual(decoded.data);
  });

  it("normalizes indexed color and tRNS data to RGBA", async () => {
    const decoded = decodeSkinPng(await readFixtureBytes("indexed-color.png"));

    expect(getPixel(decoded, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(getPixel(decoded, 8, 0)).toEqual([216, 162, 125, 255]);
  });

  it("preserves hidden RGB and partial alpha values", async () => {
    const decoded = decodeSkinPng(await readFixtureBytes("rgba-alpha.png"));

    expect(getPixel(decoded, 1, 0)).toEqual([29, 11, 3, 64]);
    expect(getPixel(decoded, 4, 0)).toEqual([116, 44, 12, 0]);
  });

  it("rejects invalid PNG bytes", () => {
    expect(() => decodeSkinPng(new Uint8Array(24))).toThrowError(
      expect.objectContaining<Partial<SkinPngError>>({ code: "INVALID_PNG" }),
    );
  });

  it("rejects decoded dimensions other than 64x64", () => {
    const legacy = createRgbaImage(64, 32);
    const bytes = encodePngRgba(legacy);

    expect(() => decodeSkinPng(bytes)).toThrowError(
      expect.objectContaining<Partial<SkinPngError>>({ code: "INVALID_DIMENSIONS" }),
    );
    expect(() => encodeSkinPng(legacy)).toThrow("仅支持编码 64×64 皮肤");
  });

  it("supports non-skin RGBA assets for derived renders", () => {
    const image = createRgbaImage(2, 3, new Uint8Array(24).fill(127));
    const decoded = decodePngRgba(encodePngRgba(image));
    expect(decoded).toEqual(image);
  });
});
