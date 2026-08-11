import { createRgbaImage } from "../image";
import {
  BODY_PARTS,
  FACES,
  LAYERS,
  type RgbaImage,
  type SurfaceModel,
  type SurfaceKey,
} from "../types";

export interface ContactSheetCell {
  readonly key: SurfaceKey;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ContactSheet {
  readonly image: RgbaImage;
  readonly cells: readonly ContactSheetCell[];
}

export interface ContactSheetOptions {
  readonly scale?: number;
  readonly padding?: number;
  readonly gutter?: number;
}

export function renderFaceContactSheet(
  model: SurfaceModel,
  options: ContactSheetOptions = {},
): ContactSheet {
  const scale = options.scale ?? 4;
  const padding = options.padding ?? 2;
  const gutter = options.gutter ?? 2;

  assertNonNegativeInteger("padding", padding);
  assertNonNegativeInteger("gutter", gutter);
  if (!Number.isInteger(scale) || scale < 1 || scale > 32) {
    throw new RangeError(`Contact sheet scale must be an integer from 1 to 32: ${scale}`);
  }

  const textures = Object.values(model.surfaces);
  const maxWidth = Math.max(...textures.map((surface) => surface.width));
  const maxHeight = Math.max(...textures.map((surface) => surface.height));
  const cellWidth = maxWidth * scale + padding * 2;
  const cellHeight = maxHeight * scale + padding * 2;
  const rowCount = BODY_PARTS.length * LAYERS.length;
  const sheetWidth = FACES.length * cellWidth + (FACES.length - 1) * gutter;
  const sheetHeight = rowCount * cellHeight + (rowCount - 1) * gutter;
  const image = createRgbaImage(sheetWidth, sheetHeight);
  const cells: ContactSheetCell[] = [];

  let row = 0;
  for (const bodyPart of BODY_PARTS) {
    for (const layer of LAYERS) {
      for (let column = 0; column < FACES.length; column += 1) {
        const face = FACES[column]!;
        const key: SurfaceKey = `${bodyPart}.${layer}.${face}`;
        const surface = model.surfaces[key];
        if (!surface) {
          throw new Error(`Contact sheet is missing surface ${key}`);
        }

        const x =
          column * (cellWidth + gutter) +
          padding +
          Math.floor(((maxWidth - surface.width) * scale) / 2);
        const y =
          row * (cellHeight + gutter) +
          padding +
          Math.floor(((maxHeight - surface.height) * scale) / 2);

        copyScaledSurface(image, surface, x, y, scale);
        cells.push({
          key,
          x,
          y,
          width: surface.width * scale,
          height: surface.height * scale,
        });
      }
      row += 1;
    }
  }

  return { image, cells };
}

function copyScaledSurface(
  target: RgbaImage,
  surface: SurfaceModel["surfaces"][SurfaceKey],
  targetX: number,
  targetY: number,
  scale: number,
): void {
  for (let sourceY = 0; sourceY < surface.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < surface.width; sourceX += 1) {
      const sourceOffset = (sourceY * surface.width + sourceX) * 4;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = targetX + sourceX * scale + dx;
          const y = targetY + sourceY * scale + dy;
          const targetOffset = (y * target.width + x) * 4;
          target.data.set(
            surface.data.subarray(sourceOffset, sourceOffset + 4),
            targetOffset,
          );
        }
      }
    }
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer: ${value}`);
  }
}
