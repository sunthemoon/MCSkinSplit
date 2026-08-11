import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createRgbaImage,
  decodeSkinPng,
  getSkinLayout,
  pixelIdsToMask,
  type BodyPart,
  type PartManifest,
  type Rgba,
  type RgbaImage,
  type SurfaceKey,
} from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import { composeSkin, type CompositionLayerInput } from "../src";

const fixtureDirectory = resolve(process.cwd(), "../../tests/fixtures/skins");
const layout = getSkinLayout("slim");

describe("pixel-safe skin composition", () => {
  it("requires explicit resolution for different colors and honors a winner", () => {
    const pixelId = 8 * 64 + 8;
    const base = imageWithPixel(pixelId, [200, 0, 0, 255]);
    const lower = layer("layer_lower", "part_lower", 0, pixelId, [0, 200, 0, 255]);
    const upper = layer("layer_upper", "part_upper", 1, pixelId, [0, 0, 200, 255]);

    const unresolved = composeSkin({
      base,
      targetArmType: "slim",
      layers: [upper, lower],
    });
    expect(unresolved.report).toMatchObject({
      hardConflictCount: 1,
      layerConflictCount: 1,
      unresolvedConflictCount: 1,
      committable: false,
    });
    expect(readPixel(unresolved.image, pixelId)).toEqual([0, 0, 200, 255]);

    const resolved = composeSkin({
      base,
      targetArmType: "slim",
      layers: [upper, lower],
      conflictWinners: { [`pixel:${pixelId}`]: "layer_lower" },
    });
    expect(resolved.report.unresolvedConflictCount).toBe(0);
    expect(resolved.report.committable).toBe(true);
    expect(readPixel(resolved.image, pixelId)).toEqual([0, 200, 0, 255]);
    expect(resolved.winningPixelIdsByLayer.layer_lower).toEqual([pixelId]);
  });

  it("treats same-color overlap as non-blocking and model mismatch as blocking", () => {
    const pixelId = 8 * 64 + 8;
    const rgba: Rgba = [25, 50, 75, 255];
    const same = composeSkin({
      base: imageWithPixel(pixelId, rgba),
      targetArmType: "slim",
      layers: [layer("layer_same", "part_same", 0, pixelId, rgba)],
    });
    expect(same.report).toMatchObject({
      sameColorOverlapCount: 1,
      unresolvedConflictCount: 0,
      committable: true,
    });

    const incompatibleLayer = layer(
      "layer_wide",
      "part_wide",
      0,
      pixelId,
      rgba,
      ["wide"],
    );
    const incompatible = composeSkin({
      base: transparentImage(),
      targetArmType: "slim",
      layers: [incompatibleLayer],
      resolutionMode: "layer_order",
    });
    expect(incompatible.report).toMatchObject({
      modelConflictCount: 1,
      unresolvedConflictCount: 1,
      appliedPixelCount: 0,
      committable: false,
    });

    const outsideDeclaredSurface = layer(
      "layer_bounds",
      "part_bounds",
      0,
      pixelId,
      rgba,
      ["slim"],
    );
    const outside = composeSkin({
      base: transparentImage(),
      targetArmType: "slim",
      layers: [
        {
          ...outsideDeclaredSurface,
          manifest: manifestFor(
            outsideDeclaredSurface.partId,
            ["torso.base.front"],
            ["slim"],
          ),
        },
      ],
      resolutionMode: "layer_order",
    });
    expect(outside.report).toMatchObject({
      unknownConflictCount: 1,
      unresolvedConflictCount: 1,
      appliedPixelCount: 0,
      committable: false,
    });
  });

  it("rebuilds the declared Alex mix from all six real skin sources", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(fixtureDirectory, "real-skins.json"), "utf8"),
    ) as RealSkinManifest;
    const sourceImages = new Map<string, RgbaImage>();
    for (const fixture of manifest.skins) {
      sourceImages.set(
        fixture.id,
        decodeSkinPng(await readFile(resolve(fixtureDirectory, fixture.file))),
      );
    }
    const bodyParts = Object.keys(manifest.mix.recipe) as BodyPart[];
    const layers = bodyParts.map((bodyPart, position) =>
      bodyPartLayer(
        bodyPart,
        manifest.mix.recipe[bodyPart],
        sourceImages.get(manifest.mix.recipe[bodyPart])!,
        position,
      ),
    );

    const result = composeSkin({
      base: transparentImage(),
      targetArmType: manifest.defaultArmType,
      layers,
    });
    const expected = decodeSkinPng(
      await readFile(resolve(fixtureDirectory, manifest.mix.file)),
    );

    expect(result.report).toMatchObject({
      targetArmType: "slim",
      layerCount: 6,
      hardConflictCount: 0,
      modelConflictCount: 0,
      unknownConflictCount: 0,
      unresolvedConflictCount: 0,
      committable: true,
    });
    expect(result.image.data).toEqual(expected.data);
    expect(Object.keys(result.winningPixelIdsByLayer)).toHaveLength(6);
  });
});

interface RealSkinManifest {
  readonly defaultArmType: "slim";
  readonly skins: readonly {
    readonly id: string;
    readonly file: string;
  }[];
  readonly mix: {
    readonly file: string;
    readonly recipe: Readonly<Record<BodyPart, string>>;
  };
}

function bodyPartLayer(
  bodyPart: BodyPart,
  sourceId: string,
  source: RgbaImage,
  position: number,
): CompositionLayerInput {
  const surfaces = layout.surfaceOrder.filter((key) => key.startsWith(`${bodyPart}.`));
  const pixelIds: number[] = [];
  const textureData = new Uint8Array(64 * 64 * 4);
  for (const key of surfaces) {
    const rect = layout.surfaces[key].atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const pixelId = y * 64 + x;
        const offset = pixelId * 4;
        textureData.set(source.data.subarray(offset, offset + 4), offset);
        if (source.data[offset + 3] !== 0) pixelIds.push(pixelId);
      }
    }
  }
  const partId = `part_${sourceId.replaceAll("-", "_")}_${bodyPart.toLowerCase()}`;
  return {
    layerId: `layer_${position}_${bodyPart.toLowerCase()}`,
    partId,
    position,
    texture: createRgbaImage(64, 64, textureData),
    writeMask: pixelIdsToMask(pixelIds),
    manifest: manifestFor(partId, surfaces, ["slim"]),
  };
}

function layer(
  layerId: string,
  partId: string,
  position: number,
  pixelId: number,
  rgba: Rgba,
  armTypes: readonly ("wide" | "slim")[] = ["wide", "slim"],
): CompositionLayerInput {
  return {
    layerId,
    partId,
    position,
    texture: imageWithPixel(pixelId, rgba),
    writeMask: pixelIdsToMask([pixelId]),
    manifest: manifestFor(partId, ["head.base.front"], armTypes),
  };
}

function manifestFor(
  partId: string,
  surfaces: readonly SurfaceKey[],
  armTypes: readonly ("wide" | "slim")[],
): PartManifest {
  return {
    schemaVersion: "1.0",
    id: partId,
    name: partId,
    category: "other_accessory",
    source: {
      projectId: "project_source",
      revisionId: "revision_source",
      componentInstanceId: "component.source",
    },
    compatibility: { resolution: "64x64", armTypes },
    placement: { preferredLayers: ["base"], surfaces },
    relations: { softConflicts: [], hardConflicts: [] },
    palette: { dominant: "#000000" },
    maskMode: "write-colored-pixels-only",
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function transparentImage(): RgbaImage {
  return createRgbaImage(64, 64);
}

function imageWithPixel(pixelId: number, rgba: Rgba): RgbaImage {
  const image = transparentImage();
  image.data.set(rgba, pixelId * 4);
  return image;
}

function readPixel(image: RgbaImage, pixelId: number): Rgba {
  const offset = pixelId * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}
