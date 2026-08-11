import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessArmType,
  atlasToSurfaceModel,
  decodeSkinPng,
  encodeSkinPng,
  getSkinLayout,
  surfaceModelToAtlas,
  type BodyPart,
  type SurfaceKey,
} from "../src";

interface RealSkinEntry {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  readonly sha256: string;
  readonly expectedArmType: "slim";
}

interface RealSkinManifest {
  readonly defaultArmType: "slim";
  readonly skins: readonly RealSkinEntry[];
  readonly mix: {
    readonly file: string;
    readonly armType: "slim";
    readonly recipe: Readonly<Record<BodyPart, string>>;
  };
}

const fixtureDirectory = resolve(process.cwd(), "../../tests/fixtures/skins");
const manifest = JSON.parse(
  await readFile(resolve(fixtureDirectory, "real-skins.json"), "utf8"),
) as RealSkinManifest;
const slimLayout = getSkinLayout("slim");

describe("user-provided real skin fixtures", () => {
  it("declares six Slim/Alex source fixtures", () => {
    expect(manifest.defaultArmType).toBe("slim");
    expect(manifest.skins).toHaveLength(6);
    expect(manifest.skins.every((skin) => skin.expectedArmType === "slim")).toBe(
      true,
    );
  });

  it.each(manifest.skins)(
    "pins and losslessly recognizes $id ($file)",
    async (fixture) => {
      const bytes = await readFile(resolve(fixtureDirectory, fixture.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);

      const image = decodeSkinPng(bytes);
      expect(assessArmType(image)).toEqual({
        armType: fixture.expectedArmType,
        reason: "transparent-slim-markers",
      });

      const model = atlasToSurfaceModel(image, slimLayout);
      expect(surfaceModelToAtlas(model, slimLayout).data).toEqual(image.data);
      expect(decodeSkinPng(encodeSkinPng(image)).data).toEqual(image.data);
    },
  );

  it("builds the mixed skin from the declared source for every body surface", async () => {
    expect(manifest.mix.armType).toBe("slim");

    const sourceModels = new Map<string, ReturnType<typeof atlasToSurfaceModel>>();
    for (const fixture of manifest.skins) {
      const image = decodeSkinPng(
        await readFile(resolve(fixtureDirectory, fixture.file)),
      );
      sourceModels.set(fixture.id, atlasToSurfaceModel(image, slimLayout));
    }

    const mixedImage = decodeSkinPng(
      await readFile(resolve(fixtureDirectory, manifest.mix.file)),
    );
    expect(assessArmType(mixedImage)).toEqual({
      armType: "slim",
      reason: "transparent-slim-markers",
    });

    const mixedModel = atlasToSurfaceModel(mixedImage, slimLayout);
    for (const key of slimLayout.surfaceOrder) {
      const bodyPart = key.split(".", 1)[0] as BodyPart;
      const sourceId = manifest.mix.recipe[bodyPart];
      const sourceModel = sourceModels.get(sourceId);
      expect(sourceModel, `${bodyPart} source ${sourceId}`).toBeDefined();
      expect(mixedModel.surfaces[key].data, key).toEqual(
        sourceModel!.surfaces[key as SurfaceKey].data,
      );
    }

    expect(mixedModel.unusedAtlasData.every((value) => value === 0)).toBe(true);
    expect(surfaceModelToAtlas(mixedModel, slimLayout).data).toEqual(
      mixedImage.data,
    );
  });
});
