import {
  buildSurfaceTexels,
  pixelIdsToSpans,
  type Rgba,
  type RgbaImage,
  type SkinLayout,
  type SurfaceTexel,
} from "@mc-skin-split/skin-core";
import {
  CANDIDATE_REGION_ALGORITHM_VERSION,
  type CandidateRegion,
  type CandidateRegionDocument,
  type PaletteDocument,
  type PixelMapDocument,
} from "./types";

const MAX_COLOR_DISTANCE_SQUARED = 80 ** 2;

export function createAnalysisDocuments(
  image: RgbaImage,
  layout: SkinLayout,
): {
  readonly candidateRegions: CandidateRegionDocument;
  readonly pixelMap: PixelMapDocument;
  readonly palette: PaletteDocument;
} {
  const texels = buildSurfaceTexels(image, layout);
  const visible = texels.filter((texel) => texel.rgba[3] !== 0);
  const regions = connectedRegions(visible, layout);
  return {
    candidateRegions: {
      schemaVersion: "1.0",
      algorithmVersion: CANDIDATE_REGION_ALGORITHM_VERSION,
      armType: layout.armType,
      visiblePixelCount: visible.length,
      regions,
    },
    pixelMap: {
      schemaVersion: "1.0",
      atlasWidth: 64,
      atlasHeight: 64,
      coordinateOrigin: "top-left",
      armType: layout.armType,
      items: texels,
    },
    palette: createPalette(visible),
  };
}

function connectedRegions(
  texels: readonly SurfaceTexel[],
  layout: SkinLayout,
): CandidateRegion[] {
  const bySurface = new Map<string, SurfaceTexel[]>();
  for (const texel of texels) {
    const values = bySurface.get(texel.surface) ?? [];
    values.push(texel);
    bySurface.set(texel.surface, values);
  }

  const result: CandidateRegion[] = [];
  for (const surface of layout.surfaceOrder) {
    const surfaceTexels = bySurface.get(surface) ?? [];
    const byLocal = new Map(
      surfaceTexels.map((texel) => [`${texel.localU},${texel.localV}`, texel]),
    );
    const visited = new Set<number>();
    const groups: SurfaceTexel[][] = [];

    for (const seed of [...surfaceTexels].sort(comparePixelId)) {
      if (visited.has(seed.pixelId)) continue;
      const group: SurfaceTexel[] = [];
      const queue = [seed];
      visited.add(seed.pixelId);
      while (queue.length > 0) {
        const current = queue.shift()!;
        group.push(current);
        for (const [du, dv] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const neighbor = byLocal.get(
            `${current.localU + du},${current.localV + dv}`,
          );
          if (
            neighbor &&
            !visited.has(neighbor.pixelId) &&
            colorsBelongTogether(seed.rgba, neighbor.rgba)
          ) {
            visited.add(neighbor.pixelId);
            queue.push(neighbor);
          }
        }
      }
      groups.push(group.sort(comparePixelId));
    }

    groups.sort((left, right) => left[0]!.pixelId - right[0]!.pixelId);
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      const pixelIds = group.map((texel) => texel.pixelId);
      const xs = group.map((texel) => texel.atlasX);
      const ys = group.map((texel) => texel.atlasY);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const dominantRgba = findDominantRgba(group);
      result.push({
        id: `region_${surface.replaceAll(".", "_")}_${String(index + 1).padStart(3, "0")}`,
        surface,
        pixelIds,
        pixelCount: pixelIds.length,
        spans: pixelIdsToSpans(pixelIds, layout),
        rgba: dominantRgba,
        dominantColor: rgbaHex(dominantRgba),
        boundingBox: {
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        },
      });
    }
  }
  return result;
}

function createPalette(texels: readonly SurfaceTexel[]): PaletteDocument {
  const colors = new Map<string, { rgba: Rgba; pixelCount: number }>();
  for (const texel of texels) {
    const key = texel.rgba.join(",");
    const existing = colors.get(key);
    if (existing) existing.pixelCount += 1;
    else colors.set(key, { rgba: texel.rgba, pixelCount: 1 });
  }
  return {
    schemaVersion: "1.0",
    visiblePixelCount: texels.length,
    colors: [...colors.values()]
      .sort((left, right) =>
        right.pixelCount === left.pixelCount
          ? rgbaHex(left.rgba).localeCompare(rgbaHex(right.rgba))
          : right.pixelCount - left.pixelCount,
      )
      .map((entry) => ({ ...entry, hex: rgbaHex(entry.rgba) })),
  };
}

function comparePixelId(left: SurfaceTexel, right: SurfaceTexel): number {
  return left.pixelId - right.pixelId;
}

function colorsBelongTogether(left: Rgba, right: Rgba): boolean {
  if (left[3] !== right[3]) return false;
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return red * red + green * green + blue * blue <= MAX_COLOR_DISTANCE_SQUARED;
}

function findDominantRgba(texels: readonly SurfaceTexel[]): Rgba {
  const colors = new Map<string, { readonly rgba: Rgba; count: number }>();
  for (const texel of texels) {
    const key = texel.rgba.join(",");
    const existing = colors.get(key);
    if (existing) existing.count += 1;
    else colors.set(key, { rgba: texel.rgba, count: 1 });
  }
  return [...colors.values()].sort((left, right) =>
    right.count === left.count
      ? rgbaHex(left.rgba).localeCompare(rgbaHex(right.rgba))
      : right.count - left.count,
  )[0]!.rgba;
}

export function rgbaHex(rgba: Rgba): string {
  return `#${rgba.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function createCandidateRegionSummary(
  document: CandidateRegionDocument,
): Readonly<Record<string, unknown>> {
  const surfaces: Record<string, unknown[]> = {};
  for (const region of document.regions) {
    const entries = surfaces[region.surface] ?? [];
    entries.push([
      region.id,
      region.dominantColor,
      region.pixelCount,
      region.boundingBox.x,
      region.boundingBox.y,
      region.boundingBox.width,
      region.boundingBox.height,
    ]);
    surfaces[region.surface] = entries;
  }
  return {
    schemaVersion: "1.0",
    algorithmVersion: document.algorithmVersion,
    armType: document.armType,
    visiblePixelCount: document.visiblePixelCount,
    regionCount: document.regions.length,
    fields: ["id", "dominantColor", "pixelCount", "x", "y", "width", "height"],
    surfaces,
  };
}
