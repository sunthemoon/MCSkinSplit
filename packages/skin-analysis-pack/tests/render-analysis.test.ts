import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSurfaceTexels,
  decodeSkinPng,
  getSkinLayout,
} from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import {
  createAnalysisDocuments,
  renderAnalysisImages,
  renderCandidateRegionGrounding,
  type CandidateRegionDocument,
} from "../src/index";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = resolve(
  repositoryRoot,
  "tests/fixtures/skins/ab87de696cfca859.png",
);

describe("CandidateRegion visual grounding", () => {
  it("renders deterministic paired orthographic views and a JSON-safe manifest", async () => {
    const image = decodeSkinPng(await readFile(fixturePath));
    const candidates = createAnalysisDocuments(
      image,
      getSkinLayout("slim"),
    ).candidateRegions;
    const first = renderCandidateRegionGrounding(image, "slim", candidates);
    const reordered: CandidateRegionDocument = {
      ...candidates,
      regions: [...candidates.regions]
        .reverse()
        .map((region) => ({ ...region, pixelIds: [...region.pixelIds].reverse() })),
    };
    const second = renderCandidateRegionGrounding(image, "slim", reordered);

    expect(Object.keys(first.views)).toEqual(["front", "back", "left", "right"]);
    expect(first.manifest.projection).toEqual({
      kind: "orthographic-surface-layout",
      faces: ["front", "back", "left", "right"],
      nativeWidth: 18,
      nativeHeight: 34,
      scale: 8,
      width: 144,
      height: 272,
      layers: ["composite", "base", "outer"],
      contactSheet: {
        columns: 2,
        rows: 2,
        gutter: 16,
        order: ["front", "back", "left", "right"],
        width: 304,
        height: 560,
      },
    });
    expect(JSON.parse(JSON.stringify(first.manifest))).toEqual(first.manifest);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.candidateAtlas).toMatchObject({ width: 1_024, height: 1_024 });
    expectBytesEqual(second.candidateAtlas.data, first.candidateAtlas.data);
    expect(first.allSurfaceContactSheet.cells).toHaveLength(72);
    expect(first.allSurfaceContactSheet.naturalColor).toMatchObject({
      width: 452,
      height: 1_292,
    });
    expect(first.allSurfaceContactSheet.candidateRegions).toMatchObject({
      width: 452,
      height: 1_292,
    });
    expect(first.allSurfacePairedContactSheet).toMatchObject({
      width: 1_008,
      height: 1_332,
    });
    expect(first.manifest.allSurfacePair).toEqual({
      kind: "aligned-natural-candidate-face-grid",
      width: 1_008,
      height: 1_332,
      headerHeight: 40,
      rowLabelWidth: 88,
      panelGap: 16,
      correspondingPixelOffsetX: 468,
      scale: 8,
      padding: 4,
      gutter: 4,
      columns: ["front", "back", "left", "right", "top", "bottom"],
      rows: [
        { bodyPart: "head", layer: "base", label: "HEAD BASE" },
        { bodyPart: "head", layer: "outer", label: "HEAD OUT" },
        { bodyPart: "torso", layer: "base", label: "TORSO BASE" },
        { bodyPart: "torso", layer: "outer", label: "TORSO OUT" },
        { bodyPart: "rightArm", layer: "base", label: "RARM BASE" },
        { bodyPart: "rightArm", layer: "outer", label: "RARM OUT" },
        { bodyPart: "leftArm", layer: "base", label: "LARM BASE" },
        { bodyPart: "leftArm", layer: "outer", label: "LARM OUT" },
        { bodyPart: "rightLeg", layer: "base", label: "RLEG BASE" },
        { bodyPart: "rightLeg", layer: "outer", label: "RLEG OUT" },
        { bodyPart: "leftLeg", layer: "base", label: "LLEG BASE" },
        { bodyPart: "leftLeg", layer: "outer", label: "LLEG OUT" },
      ],
      panels: {
        naturalColor: { x: 88, y: 40, width: 452, height: 1_292 },
        candidateRegions: { x: 556, y: 40, width: 452, height: 1_292 },
      },
    });
    expectBytesEqual(
      second.allSurfacePairedContactSheet.data,
      first.allSurfacePairedContactSheet.data,
    );
    expectEmbeddedImage(
      first.allSurfacePairedContactSheet,
      first.allSurfaceContactSheet.naturalColor,
      first.manifest.allSurfacePair.panels.naturalColor,
    );
    expectEmbeddedImage(
      first.allSurfacePairedContactSheet,
      first.allSurfaceContactSheet.candidateRegions,
      first.manifest.allSurfacePair.panels.candidateRegions,
    );
    expect(hasOpaqueWhitePixel(first.allSurfacePairedContactSheet, 0, 0, 1_008, 40))
      .toBe(true);
    expect(hasOpaqueWhitePixel(first.allSurfacePairedContactSheet, 0, 40, 88, 1_292))
      .toBe(true);
    expect(second.allSurfaceContactSheet.cells).toEqual(
      first.allSurfaceContactSheet.cells,
    );
    expectBytesEqual(
      second.allSurfaceContactSheet.candidateRegions.data,
      first.allSurfaceContactSheet.candidateRegions.data,
    );
    expectBytesEqual(
      first.allSurfaceContactSheet.naturalColor.data,
      renderAnalysisImages(image, "slim").contactSheet.data,
    );

    for (const face of first.manifest.projection.faces) {
      const view = first.views[face];
      expect(view.naturalColor).toMatchObject({ width: 144, height: 272 });
      expect(view.candidateRegions).toMatchObject({ width: 144, height: 272 });
      expectBytesEqual(
        second.views[face].naturalColor.data,
        view.naturalColor.data,
      );
      expectBytesEqual(
        second.views[face].candidateRegions.data,
        view.candidateRegions.data,
      );
      for (const layer of ["base", "outer"] as const) {
        expect(view.layers[layer].naturalColor).toMatchObject({
          width: 144,
          height: 272,
        });
        expectBytesEqual(
          second.views[face].layers[layer].candidateRegions.data,
          view.layers[layer].candidateRegions.data,
        );
      }
    }
    expect(first.contactSheet.naturalColor).toMatchObject({
      width: 304,
      height: 560,
    });
    expectBytesEqual(
      second.contactSheet.naturalColor.data,
      first.contactSheet.naturalColor.data,
    );
    expectBytesEqual(
      second.contactSheet.candidateRegions.data,
      first.contactSheet.candidateRegions.data,
    );
    expectBytesEqual(
      occupancyMask(first.contactSheet.candidateRegions.data),
      occupancyMask(first.contactSheet.naturalColor.data),
    );
    for (const layer of ["base", "outer"] as const) {
      expect(first.layerContactSheets[layer].naturalColor).toMatchObject({
        width: 304,
        height: 560,
      });
      expectBytesEqual(
        occupancyMask(first.layerContactSheets[layer].candidateRegions.data),
        occupancyMask(first.layerContactSheets[layer].naturalColor.data),
      );
    }
    expect(first.legendImage).toMatchObject({
      width: first.manifest.legendImage.width,
      height: first.manifest.legendImage.height,
    });
    expectBytesEqual(second.legendImage.data, first.legendImage.data);
    expect(pixelAt(first.legendImage.data, first.legendImage.width, 3, 3)).toEqual(
      first.manifest.legend[0]!.rgba,
    );
    expect(pixelAt(first.legendImage.data, first.legendImage.width, 20, 4)).toEqual(
      [245, 246, 239, 255],
    );
    expect(first.legendImage.data[3]).toBe(0);
  });

  it("uses one stable unique color per Region and records proven layer identity", async () => {
    const image = decodeSkinPng(await readFile(fixturePath));
    const candidates = createAnalysisDocuments(
      image,
      getSkinLayout("slim"),
    ).candidateRegions;
    const result = renderCandidateRegionGrounding(image, "slim", candidates);
    const colors = result.manifest.legend.map((entry) => entry.color);
    const visualIds = result.manifest.legend.map((entry) => entry.visualId);

    expect(result.manifest.legend).toHaveLength(candidates.regions.length);
    expect(new Set(colors).size).toBe(colors.length);
    expect(new Set(visualIds).size).toBe(visualIds.length);
    expect(visualIds[0]).toBe("R001");
    expect(Object.keys(result.manifest.colorToRegion)).toHaveLength(colors.length);
    expect(Object.keys(result.manifest.visualIdToRegion)).toHaveLength(
      visualIds.length,
    );
    expect(new Set(result.manifest.legend.map((entry) => entry.layer))).toEqual(
      new Set(["base", "outer"]),
    );
    for (const entry of result.manifest.legend) {
      expect(result.manifest.colorToRegion[entry.color]).toEqual({
        candidateRegionId: entry.candidateRegionId,
        visualId: entry.visualId,
        surface: entry.surface,
        layer: entry.layer,
      });
      expect(result.manifest.visualIdToRegion[entry.visualId]).toEqual({
        candidateRegionId: entry.candidateRegionId,
        color: entry.color,
        surface: entry.surface,
        layer: entry.layer,
      });
      expect(entry.surface).toContain(`.${entry.layer}.`);
      expect(entry.rgba[0]).toBeGreaterThanOrEqual(
        entry.layer === "base" ? 32 : 160,
      );
      expect(entry.rgba[0]).toBeLessThanOrEqual(
        entry.layer === "base" ? 95 : 223,
      );
    }
  });

  it("grounds every Region on the Atlas and matching all-surface face contact sheet", async () => {
    const image = decodeSkinPng(await readFile(fixturePath));
    const layout = getSkinLayout("slim");
    const candidates = createAnalysisDocuments(image, layout).candidateRegions;
    const result = renderCandidateRegionGrounding(image, "slim", candidates);
    const manifestByRegion = new Map(
      result.manifest.legend.map((entry) => [entry.candidateRegionId, entry]),
    );
    const texelByPixelId = new Map(
      buildSurfaceTexels(image, layout).map((texel) => [texel.pixelId, texel]),
    );
    const cellBySurface = new Map(
      result.allSurfaceContactSheet.cells.map((cell) => [cell.key, cell]),
    );
    const calibratedFaces = new Set<string>();

    expectBytesEqual(
      occupancyMask(result.allSurfaceContactSheet.candidateRegions.data),
      occupancyMask(result.allSurfaceContactSheet.naturalColor.data),
    );
    for (const region of candidates.regions) {
      const entry = manifestByRegion.get(region.id)!;
      const texel = texelByPixelId.get(region.pixelIds[0]!)!;
      const cell = cellBySurface.get(region.surface)!;
      const atlasSample = pixelAt(
        result.candidateAtlas.data,
        result.candidateAtlas.width,
        texel.atlasX * 16,
        texel.atlasY * 16,
      );
      const contactX = cell.x + texel.localU * 8;
      const contactY = cell.y + texel.localV * 8;

      expect(atlasSample, `${region.id} Atlas`).toEqual(entry.rgba);
      expect(
        pixelAt(
          result.allSurfaceContactSheet.candidateRegions.data,
          result.allSurfaceContactSheet.candidateRegions.width,
          contactX,
          contactY,
        ),
        `${region.id} candidate face contact`,
      ).toEqual(entry.rgba);
      expect(
        pixelAt(
          result.allSurfaceContactSheet.naturalColor.data,
          result.allSurfaceContactSheet.naturalColor.width,
          contactX,
          contactY,
        ),
        `${region.id} natural face contact`,
      ).toEqual(texel.rgba);
      const pairedLayout = result.manifest.allSurfacePair;
      expect(
        pixelAt(
          result.allSurfacePairedContactSheet.data,
          result.allSurfacePairedContactSheet.width,
          pairedLayout.panels.naturalColor.x + contactX,
          pairedLayout.panels.naturalColor.y + contactY,
        ),
        `${region.id} paired natural face contact`,
      ).toEqual(texel.rgba);
      expect(
        pixelAt(
          result.allSurfacePairedContactSheet.data,
          result.allSurfacePairedContactSheet.width,
          pairedLayout.panels.candidateRegions.x + contactX,
          pairedLayout.panels.candidateRegions.y + contactY,
        ),
        `${region.id} paired candidate face contact`,
      ).toEqual(entry.rgba);
      calibratedFaces.add(entry.face);
    }

    expect(calibratedFaces).toEqual(
      new Set(["front", "back", "left", "right", "top", "bottom"]),
    );
    expect(
      result.manifest.legend.filter(
        (entry) => entry.face === "top" || entry.face === "bottom",
      ).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ["wide-basic.png", "wide"],
    ["slim-basic.png", "slim"],
  ] as const)(
    "keeps %s Wide/Slim projection geometry and occupancy aligned",
    async (fixture, armType) => {
      const image = decodeSkinPng(
        await readFile(resolve(repositoryRoot, "tests/fixtures/skins", fixture)),
      );
      const candidates = createAnalysisDocuments(
        image,
        getSkinLayout(armType),
      ).candidateRegions;
      assertAllViewOccupancyMatches(
        renderCandidateRegionGrounding(image, armType, candidates),
      );
    },
  );

  it("keeps pseudo-color occupancy pixel-exact with each natural projection", async () => {
    const image = decodeSkinPng(await readFile(fixturePath));
    const candidates = createAnalysisDocuments(
      image,
      getSkinLayout("slim"),
    ).candidateRegions;
    const result = renderCandidateRegionGrounding(image, "slim", candidates);
    const legacyNaturalViews = renderAnalysisImages(image, "slim").views;
    expect(Object.keys(legacyNaturalViews)).toEqual([
      "front",
      "back",
      "left",
      "right",
      "frontRightContact",
    ]);
    expect("isometric" in legacyNaturalViews).toBe(false);

    for (const face of result.manifest.projection.faces) {
      const natural = result.views[face].naturalColor;
      const overlay = result.views[face].candidateRegions;
      expectBytesEqual(natural.data, legacyNaturalViews[face].data);
      expectBytesEqual(
        occupancyMask(overlay.data),
        occupancyMask(natural.data),
      );
      expect(countOccupied(overlay.data), face).toBeGreaterThan(0);
      expect(overlay.data[3], `${face} top-left background`).toBe(0);
      for (const layer of ["base", "outer"] as const) {
        expectBytesEqual(
          occupancyMask(result.views[face].layers[layer].candidateRegions.data),
          occupancyMask(result.views[face].layers[layer].naturalColor.data),
        );
      }
    }

    expect(countOccupied(result.views.left.candidateRegions.data)).toBeGreaterThan(0);
    expect(countOccupied(result.views.right.candidateRegions.data)).toBeGreaterThan(0);
    expect(
      countOccupied(result.layerContactSheets.base.candidateRegions.data),
    ).toBeGreaterThan(0);
    expect(
      countOccupied(result.layerContactSheets.outer.candidateRegions.data),
    ).toBeGreaterThan(0);
  });

  it("rejects candidate documents that cannot map exactly to source-visible UV", async () => {
    const image = decodeSkinPng(await readFile(fixturePath));
    const candidates = createAnalysisDocuments(
      image,
      getSkinLayout("slim"),
    ).candidateRegions;
    const incomplete: CandidateRegionDocument = {
      ...candidates,
      regions: candidates.regions.slice(1),
    };

    expect(() =>
      renderCandidateRegionGrounding(image, "slim", incomplete),
    ).toThrow("CandidateRegions do not cover every visible UV pixel");
    expect(() =>
      renderCandidateRegionGrounding(image, "wide", candidates),
    ).toThrow("CandidateRegion arm type slim does not match wide");
  });
});

function countOccupied(data: Uint8Array): number {
  let count = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] !== 0) count += 1;
  }
  return count;
}

function occupancyMask(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length / 4);
  for (let offset = 3; offset < data.length; offset += 4) {
    result[(offset - 3) / 4] = data[offset] === 0 ? 0 : 1;
  }
  return result;
}

function assertAllViewOccupancyMatches(
  result: ReturnType<typeof renderCandidateRegionGrounding>,
): void {
  for (const face of result.manifest.projection.faces) {
    const { naturalColor, candidateRegions } = result.views[face];
    expect(candidateRegions).toMatchObject({ width: 144, height: 272 });
    expectBytesEqual(
      occupancyMask(candidateRegions.data),
      occupancyMask(naturalColor.data),
    );
    for (const layer of ["base", "outer"] as const) {
      expectBytesEqual(
        occupancyMask(result.views[face].layers[layer].candidateRegions.data),
        occupancyMask(result.views[face].layers[layer].naturalColor.data),
      );
    }
  }
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

function expectEmbeddedImage(
  target: { readonly width: number; readonly data: Uint8Array },
  source: { readonly width: number; readonly height: number; readonly data: Uint8Array },
  panel: { readonly x: number; readonly y: number },
): void {
  for (let row = 0; row < source.height; row += 1) {
    const sourceStart = row * source.width * 4;
    const targetStart = ((panel.y + row) * target.width + panel.x) * 4;
    expectBytesEqual(
      target.data.subarray(targetStart, targetStart + source.width * 4),
      source.data.subarray(sourceStart, sourceStart + source.width * 4),
    );
  }
}

function hasOpaqueWhitePixel(
  image: { readonly width: number; readonly data: Uint8Array },
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * image.width + column) * 4;
      if (
        image.data[offset] === 245 &&
        image.data[offset + 1] === 246 &&
        image.data[offset + 2] === 239 &&
        image.data[offset + 3] === 255
      ) {
        return true;
      }
    }
  }
  return false;
}

function pixelAt(
  data: Uint8Array,
  width: number,
  x: number,
  y: number,
): readonly number[] {
  const offset = (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}
