import type { Rgba, RgbaImage } from "./types";

export function assertRgbaImage(image: RgbaImage): void {
  if (!Number.isInteger(image.width) || image.width <= 0) {
    throw new RangeError(`Image width must be a positive integer: ${image.width}`);
  }

  if (!Number.isInteger(image.height) || image.height <= 0) {
    throw new RangeError(`Image height must be a positive integer: ${image.height}`);
  }

  const expectedLength = image.width * image.height * 4;
  if (image.data.length !== expectedLength) {
    throw new RangeError(
      `RGBA byte length mismatch: expected ${expectedLength}, received ${image.data.length}`,
    );
  }
}

export function createRgbaImage(
  width: number,
  height: number,
  data = new Uint8Array(width * height * 4),
): RgbaImage {
  const image = { width, height, data };
  assertRgbaImage(image);
  return image;
}

export function getPixel(image: RgbaImage, x: number, y: number): Rgba {
  assertPixelCoordinate(image, x, y);
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

export function setPixel(image: RgbaImage, x: number, y: number, rgba: Rgba): void {
  assertPixelCoordinate(image, x, y);
  const offset = (y * image.width + x) * 4;
  image.data.set(rgba, offset);
}

export function fillImage(image: RgbaImage, rgba: Rgba): void {
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data.set(rgba, offset);
  }
}

function assertPixelCoordinate(image: RgbaImage, x: number, y: number): void {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= image.width ||
    y < 0 ||
    y >= image.height
  ) {
    throw new RangeError(`Pixel coordinate is outside ${image.width}x${image.height}: ${x},${y}`);
  }
}
