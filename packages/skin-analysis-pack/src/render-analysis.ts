import {
  atlasToSurfaceModel,
  createRgbaImage,
  getSkinLayout,
  renderFaceContactSheet,
  scaleNearest,
  type ArmType,
  type Face,
  type Rgba,
  type RgbaImage,
  type SurfaceModel,
  type SurfaceTexture,
} from "@mc-skin-split/skin-core";

const SCALE = 16;

export function renderAnalysisImages(
  image: RgbaImage,
  armType: ArmType,
): {
  readonly atlas: RgbaImage;
  readonly atlasGrid: RgbaImage;
  readonly contactSheet: RgbaImage;
  readonly views: Readonly<Record<"front" | "back" | "left" | "right" | "isometric", RgbaImage>>;
} {
  const layout = getSkinLayout(armType);
  const model = atlasToSurfaceModel(image, layout);
  const atlas = scaleNearest(image, SCALE);
  const atlasGrid = cloneImage(atlas);
  drawPixelGrid(atlasGrid);
  drawSurfaceBounds(atlasGrid, layout);
  const front = renderBodyView(model, "front");
  const right = renderBodyView(model, "right");
  return {
    atlas,
    atlasGrid,
    contactSheet: renderFaceContactSheet(model, {
      scale: 8,
      padding: 4,
      gutter: 4,
    }).image,
    views: {
      front,
      back: renderBodyView(model, "back"),
      left: renderBodyView(model, "left"),
      right,
      isometric: combineViews(front, right),
    },
  };
}

function renderBodyView(model: SurfaceModel, face: Face): RgbaImage {
  const native = createRgbaImage(18, 34);
  const armWidth = model.armType === "slim" ? 3 : 4;
  const placements = [
    { bodyPart: "head", x: 5, y: 1 },
    { bodyPart: "torso", x: 5, y: 9 },
    { bodyPart: "rightArm", x: 5 - armWidth, y: 9 },
    { bodyPart: "leftArm", x: 13, y: 9 },
    { bodyPart: "rightLeg", x: 5, y: 21 },
    { bodyPart: "leftLeg", x: 9, y: 21 },
  ] as const;

  for (const placement of placements) {
    const base = model.surfaces[`${placement.bodyPart}.base.${face}`];
    const outer = model.surfaces[`${placement.bodyPart}.outer.${face}`];
    drawTexture(native, base, placement.x, placement.y);
    drawTexture(native, outer, placement.x, placement.y);
  }
  return scaleNearest(native, 8);
}

function drawTexture(
  target: RgbaImage,
  texture: SurfaceTexture,
  targetX: number,
  targetY: number,
): void {
  for (let y = 0; y < texture.height; y += 1) {
    for (let x = 0; x < texture.width; x += 1) {
      const sourceOffset = (y * texture.width + x) * 4;
      const source = texture.data.subarray(sourceOffset, sourceOffset + 4) as unknown as Rgba;
      if (source[3] === 0) continue;
      const offset = ((targetY + y) * target.width + targetX + x) * 4;
      blend(target.data, offset, source);
    }
  }
}

function combineViews(front: RgbaImage, side: RgbaImage): RgbaImage {
  const result = createRgbaImage(front.width + side.width + 16, front.height);
  copyImage(front, result, 0, 0);
  copyImage(side, result, front.width + 16, 0);
  return result;
}

function copyImage(source: RgbaImage, target: RgbaImage, x: number, y: number): void {
  for (let row = 0; row < source.height; row += 1) {
    const sourceOffset = row * source.width * 4;
    const targetOffset = ((y + row) * target.width + x) * 4;
    target.data.set(source.data.subarray(sourceOffset, sourceOffset + source.width * 4), targetOffset);
  }
}

function drawPixelGrid(image: RgbaImage): void {
  for (let coordinate = 0; coordinate <= 64; coordinate += 1) {
    const position = Math.min(coordinate * SCALE, image.width - 1);
    drawLine(image, position, 0, position, image.height - 1, [20, 28, 30, 96]);
    drawLine(image, 0, position, image.width - 1, position, [20, 28, 30, 96]);
  }
}

function drawSurfaceBounds(
  image: RgbaImage,
  layout: ReturnType<typeof getSkinLayout>,
): void {
  for (const key of layout.surfaceOrder) {
    const rect = layout.surfaces[key].atlasRect;
    const x0 = rect.x * SCALE;
    const y0 = rect.y * SCALE;
    const x1 = (rect.x + rect.width) * SCALE - 1;
    const y1 = (rect.y + rect.height) * SCALE - 1;
    const color: Rgba = key.includes(".outer.")
      ? [240, 105, 66, 210]
      : [25, 124, 142, 210];
    drawLine(image, x0, y0, x1, y0, color);
    drawLine(image, x1, y0, x1, y1, color);
    drawLine(image, x1, y1, x0, y1, color);
    drawLine(image, x0, y1, x0, y0, color);
  }
}

function drawLine(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: Rgba,
): void {
  const horizontal = y0 === y1;
  const length = horizontal ? Math.abs(x1 - x0) : Math.abs(y1 - y0);
  for (let step = 0; step <= length; step += 1) {
    const x = horizontal ? Math.min(x0, x1) + step : x0;
    const y = horizontal ? y0 : Math.min(y0, y1) + step;
    blend(image.data, (y * image.width + x) * 4, rgba);
  }
}

function blend(target: Uint8Array, offset: number, source: Rgba): void {
  const sourceAlpha = source[3] / 255;
  const targetAlpha = target[offset + 3]! / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    target[offset + channel] = Math.round(
      (source[channel]! * sourceAlpha +
        target[offset + channel]! * targetAlpha * (1 - sourceAlpha)) /
        outputAlpha,
    );
  }
  target[offset + 3] = Math.round(outputAlpha * 255);
}

function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: image.data.slice() };
}
