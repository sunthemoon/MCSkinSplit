import { assertRgbaImage, createRgbaImage } from "../image";
import type { RgbaImage } from "../types";

export function scaleNearest(image: RgbaImage, factor: number): RgbaImage {
  assertRgbaImage(image);
  if (!Number.isInteger(factor) || factor < 1 || factor > 64) {
    throw new RangeError(`Nearest-neighbor scale factor must be an integer from 1 to 64: ${factor}`);
  }

  const result = createRgbaImage(image.width * factor, image.height * factor);

  for (let sourceY = 0; sourceY < image.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < image.width; sourceX += 1) {
      const sourceOffset = (sourceY * image.width + sourceX) * 4;

      for (let dy = 0; dy < factor; dy += 1) {
        const targetY = sourceY * factor + dy;
        for (let dx = 0; dx < factor; dx += 1) {
          const targetX = sourceX * factor + dx;
          const targetOffset = (targetY * result.width + targetX) * 4;
          result.data.set(image.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
        }
      }
    }
  }

  return result;
}
