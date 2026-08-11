import { assertRgbaImage, createRgbaImage } from "../image";
import { getSurfaceDefinition } from "../layouts/layout";
import {
  SKIN_HEIGHT,
  SKIN_WIDTH,
  type RgbaImage,
  type SkinLayout,
  type SurfaceModel,
  type SurfaceTexel,
  type SurfaceTexture,
  type SurfaceKey,
} from "../types";
import { atlasLocalToCanonical, getOrientedSize } from "./orientation";

export function assertSkinImage(image: RgbaImage): void {
  assertRgbaImage(image);
  if (image.width !== SKIN_WIDTH || image.height !== SKIN_HEIGHT) {
    throw new RangeError(
      `Minecraft skin must be 64x64 RGBA, received ${image.width}x${image.height}`,
    );
  }
}

export function atlasToSurfaceModel(
  image: RgbaImage,
  layout: SkinLayout,
): SurfaceModel {
  assertSkinImage(image);
  assertLayoutMatchesImage(layout, image);

  const surfaces: Partial<Record<SurfaceKey, SurfaceTexture>> = {};
  const unusedAtlasData = image.data.slice();

  for (const key of layout.surfaceOrder) {
    const definition = getSurfaceDefinition(layout, key);
    const { atlasRect, orientation } = definition;
    const orientedSize = getOrientedSize(
      atlasRect.width,
      atlasRect.height,
      orientation,
    );
    const surfaceData = new Uint8Array(orientedSize.width * orientedSize.height * 4);

    for (let atlasV = 0; atlasV < atlasRect.height; atlasV += 1) {
      for (let atlasU = 0; atlasU < atlasRect.width; atlasU += 1) {
        const local = atlasLocalToCanonical(
          atlasU,
          atlasV,
          atlasRect.width,
          atlasRect.height,
          orientation,
        );
        const atlasX = atlasRect.x + atlasU;
        const atlasY = atlasRect.y + atlasV;
        const sourceOffset = (atlasY * image.width + atlasX) * 4;
        const targetOffset = (local.y * orientedSize.width + local.x) * 4;

        surfaceData.set(image.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
        unusedAtlasData.fill(0, sourceOffset, sourceOffset + 4);
      }
    }

    surfaces[key] = {
      key,
      width: orientedSize.width,
      height: orientedSize.height,
      data: surfaceData,
    };
  }

  return {
    layoutId: layout.id,
    armType: layout.armType,
    atlasWidth: SKIN_WIDTH,
    atlasHeight: SKIN_HEIGHT,
    surfaces: surfaces as Record<SurfaceKey, SurfaceTexture>,
    unusedAtlasData,
  };
}

export function surfaceModelToAtlas(
  model: SurfaceModel,
  layout: SkinLayout,
): RgbaImage {
  if (model.layoutId !== layout.id || model.armType !== layout.armType) {
    throw new Error(
      `Surface model ${model.layoutId}/${model.armType} does not match layout ${layout.id}/${layout.armType}`,
    );
  }

  if (model.unusedAtlasData.length !== SKIN_WIDTH * SKIN_HEIGHT * 4) {
    throw new RangeError("Surface model unused atlas data must contain 16384 bytes");
  }

  const image = createRgbaImage(
    SKIN_WIDTH,
    SKIN_HEIGHT,
    model.unusedAtlasData.slice(),
  );

  for (const key of layout.surfaceOrder) {
    const definition = getSurfaceDefinition(layout, key);
    const surface = model.surfaces[key];
    const { atlasRect, orientation } = definition;
    const expectedSize = getOrientedSize(
      atlasRect.width,
      atlasRect.height,
      orientation,
    );

    if (
      !surface ||
      surface.width !== expectedSize.width ||
      surface.height !== expectedSize.height ||
      surface.data.length !== expectedSize.width * expectedSize.height * 4
    ) {
      throw new Error(`Surface model has invalid or missing texture ${key}`);
    }

    for (let atlasV = 0; atlasV < atlasRect.height; atlasV += 1) {
      for (let atlasU = 0; atlasU < atlasRect.width; atlasU += 1) {
        const local = atlasLocalToCanonical(
          atlasU,
          atlasV,
          atlasRect.width,
          atlasRect.height,
          orientation,
        );
        const sourceOffset = (local.y * surface.width + local.x) * 4;
        const atlasX = atlasRect.x + atlasU;
        const atlasY = atlasRect.y + atlasV;
        const targetOffset = (atlasY * image.width + atlasX) * 4;
        image.data.set(surface.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }

  return image;
}

export function buildSurfaceTexels(
  image: RgbaImage,
  layout: SkinLayout,
): SurfaceTexel[] {
  assertSkinImage(image);
  const texels: SurfaceTexel[] = [];

  for (const key of layout.surfaceOrder) {
    const definition = getSurfaceDefinition(layout, key);
    const { atlasRect, orientation } = definition;

    for (let atlasV = 0; atlasV < atlasRect.height; atlasV += 1) {
      for (let atlasU = 0; atlasU < atlasRect.width; atlasU += 1) {
        const local = atlasLocalToCanonical(
          atlasU,
          atlasV,
          atlasRect.width,
          atlasRect.height,
          orientation,
        );
        const atlasX = atlasRect.x + atlasU;
        const atlasY = atlasRect.y + atlasV;
        const offset = (atlasY * image.width + atlasX) * 4;

        texels.push({
          pixelId: atlasY * SKIN_WIDTH + atlasX,
          atlasX,
          atlasY,
          rgba: [
            image.data[offset]!,
            image.data[offset + 1]!,
            image.data[offset + 2]!,
            image.data[offset + 3]!,
          ],
          surface: key,
          bodyPart: definition.bodyPart,
          face: definition.face,
          layer: definition.layer,
          localU: local.x,
          localV: local.y,
          isUsedUvPixel: true,
        });
      }
    }
  }

  return texels;
}

function assertLayoutMatchesImage(layout: SkinLayout, image: RgbaImage): void {
  if (layout.width !== image.width || layout.height !== image.height) {
    throw new RangeError(
      `Layout ${layout.id} does not match ${image.width}x${image.height} image`,
    );
  }
}
