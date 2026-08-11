import type { Point, SurfaceOrientation } from "../types";

export interface OrientedSize {
  readonly width: number;
  readonly height: number;
}

export function getOrientedSize(
  width: number,
  height: number,
  orientation: SurfaceOrientation,
): OrientedSize {
  return orientation.rotate === 90 || orientation.rotate === 270
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Maps a pixel inside an atlas rectangle to the canonical outside-facing surface.
 * Rotation is clockwise and applied before canonical-space flips.
 */
export function atlasLocalToCanonical(
  atlasU: number,
  atlasV: number,
  width: number,
  height: number,
  orientation: SurfaceOrientation,
): Point {
  assertLocalCoordinate(atlasU, atlasV, width, height);

  let rotatedU: number;
  let rotatedV: number;

  switch (orientation.rotate) {
    case 0:
      rotatedU = atlasU;
      rotatedV = atlasV;
      break;
    case 90:
      rotatedU = height - 1 - atlasV;
      rotatedV = atlasU;
      break;
    case 180:
      rotatedU = width - 1 - atlasU;
      rotatedV = height - 1 - atlasV;
      break;
    case 270:
      rotatedU = atlasV;
      rotatedV = width - 1 - atlasU;
      break;
  }

  const orientedSize = getOrientedSize(width, height, orientation);
  return {
    x: orientation.flipX ? orientedSize.width - 1 - rotatedU : rotatedU,
    y: orientation.flipY ? orientedSize.height - 1 - rotatedV : rotatedV,
  };
}

export function canonicalToAtlasLocal(
  localU: number,
  localV: number,
  width: number,
  height: number,
  orientation: SurfaceOrientation,
): Point {
  const orientedSize = getOrientedSize(width, height, orientation);
  assertLocalCoordinate(localU, localV, orientedSize.width, orientedSize.height);

  const rotatedU = orientation.flipX
    ? orientedSize.width - 1 - localU
    : localU;
  const rotatedV = orientation.flipY
    ? orientedSize.height - 1 - localV
    : localV;

  switch (orientation.rotate) {
    case 0:
      return { x: rotatedU, y: rotatedV };
    case 90:
      return { x: rotatedV, y: height - 1 - rotatedU };
    case 180:
      return { x: width - 1 - rotatedU, y: height - 1 - rotatedV };
    case 270:
      return { x: width - 1 - rotatedV, y: rotatedU };
  }
}

function assertLocalCoordinate(x: number, y: number, width: number, height: number): void {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= width ||
    y >= height
  ) {
    throw new RangeError(`Local coordinate is outside ${width}x${height}: ${x},${y}`);
  }
}
