import { describe, expect, it } from "vitest";
import {
  SEMANTIC_CATEGORIES,
  SemanticEditError,
  analyzePartApplication,
  applyManualSemanticOperation,
  applyPartPixels,
  componentMaskFile,
  createInitialSemanticState,
  createPartMannequinTexture,
  createRgbaImage,
  exportSemanticPart,
  getPixel,
  getSkinLayout,
  maskToPixelIds,
  maskToRgbaImage,
  pixelIdsToMask,
  pixelIdsToSpans,
  rgbaImageToMask,
  rebaseSemanticStateImage,
  setPixel,
  spansToPixelIds,
  validateSemanticState,
  type ArmType,
  type Rgba,
  type RgbaImage,
  type SemanticPixelSpan,
  type SemanticState,
  type SurfaceKey,
} from "../src";

const SOURCE_HASH = `sha256:${"0".repeat(64)}`;

describe("semantic taxonomy and masks", () => {
  it("keeps the complete coarse taxonomy stable and unique", () => {
    expect(SEMANTIC_CATEGORIES).toHaveLength(23);
    expect(new Set(SEMANTIC_CATEGORIES).size).toBe(23);
    expect(SEMANTIC_CATEGORIES).toContain("hair");
    expect(SEMANTIC_CATEGORIES).toContain("upper_clothing");
    expect(SEMANTIC_CATEGORIES).toContain("glove");
    expect(SEMANTIC_CATEGORIES).toContain("shoe");
    expect(SEMANTIC_CATEGORIES.at(-1)).toBe("unknown");
  });

  it("round-trips canonical surface spans and a full-size binary mask", () => {
    const layout = getSkinLayout("slim");
    const spans: SemanticPixelSpan[] = [
      { surface: "head.base.front", y: 8, x0: 8, x1: 10 },
      { surface: "head.outer.front", y: 8, x0: 40, x1: 41 },
    ];
    const pixelIds = spansToPixelIds(spans, layout);
    const mask = pixelIdsToMask(pixelIds);

    expect(pixelIdsToSpans(pixelIds, layout)).toEqual(spans);
    expect(rgbaImageToMask(maskToRgbaImage(mask))).toEqual(mask);
    expect(mask).toHaveLength(64 * 64);
    expect(maskToPixelIds(mask)).toEqual(pixelIds);
  });

  it("rejects overlapping spans and pixels outside the Minecraft UV layout", () => {
    const layout = getSkinLayout("slim");
    expect(() =>
      spansToPixelIds(
        [
          { surface: "head.base.front", y: 8, x0: 8, x1: 10 },
          { surface: "head.base.front", y: 8, x0: 10, x1: 11 },
        ],
        layout,
      ),
    ).toThrow(/overlap/i);

    const used = usedPixelIds("slim");
    const unusedPixelId = Array.from({ length: 64 * 64 }, (_, id) => id).find(
      (id) => !used.has(id),
    );
    expect(unusedPixelId).toBeDefined();
    expect(() => pixelIdsToSpans([unusedPixelId!], layout)).toThrow(
      /unused UV/i,
    );
  });
});

describe("manual semantic transactions", () => {
  it("starts with every visible UV pixel in the independent unknown mask", () => {
    const image = semanticFixture();
    const state = initialState(image);

    expect(state.document.components).toEqual([]);
    expect(state.document.unknown).toEqual({
      maskFile: "components/unknown.mask.png",
      pixelCount: 5,
    });
    expect(maskToPixelIds(state.unknownMask)).toHaveLength(5);
    expect(() => validateSemanticState(state, image)).not.toThrow();
  });

  it("moves selected pixels between components without overlap", () => {
    const image = semanticFixture();
    const assignedHair = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("hair.main", "Hair", "hair"),
        spans: [headSpan(8, 9)],
      },
      image,
    );
    const reassigned = applyManualSemanticOperation(
      assignedHair,
      {
        type: "assign_pixels",
        target: component("face.eye", "Eye", "eye"),
        spans: [headSpan(9, 9)],
      },
      image,
    );

    expect(reassigned.document.components.map((item) => item.instanceId)).toEqual([
      "face.eye",
      "hair.main",
    ]);
    expect(maskToPixelIds(reassigned.masks["hair.main"]!)).toEqual([8 * 64 + 8]);
    expect(maskToPixelIds(reassigned.masks["face.eye"]!)).toEqual([8 * 64 + 9]);
    expect(reassigned.document.unknown.pixelCount).toBe(3);
    expect(() => validateSemanticState(reassigned, image)).not.toThrow();
  });

  it("merges, splits, and reclassifies components deterministically", () => {
    const image = semanticFixture();
    let state = initialState(image);
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: component("hair.left", "Left hair", "hair"),
        spans: [headSpan(8, 8)],
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: component("hair.right", "Right hair", "hair"),
        spans: [headSpan(9, 9)],
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "merge_components",
        componentIds: ["hair.left", "hair.right"],
        target: component("hair.main", "Main hair", "hair"),
      },
      image,
    );

    expect(maskToPixelIds(state.masks["hair.main"]!)).toEqual([
      8 * 64 + 8,
      8 * 64 + 9,
    ]);

    state = applyManualSemanticOperation(
      state,
      {
        type: "split_component",
        sourceComponentId: "hair.main",
        target: component("hair.bangs", "Bangs", "hair"),
        spans: [headSpan(9, 9)],
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "reclassify_component",
        componentId: "hair.bangs",
        category: "head_accessory",
        subtype: "clip",
      },
      image,
    );

    expect(
      state.document.components.find((item) => item.instanceId === "hair.bangs"),
    ).toMatchObject({ category: "head_accessory", subtype: "clip" });
    expect(maskToPixelIds(state.masks["hair.main"]!)).toEqual([8 * 64 + 8]);
    expect(() => validateSemanticState(state, image)).not.toThrow();
  });

  it("rejects transparent selections and inconsistent overlapping state", () => {
    const image = semanticFixture();
    expect(() =>
      applyManualSemanticOperation(
        initialState(image),
        {
          type: "assign_pixels",
          target: component("hair.main", "Hair", "hair"),
          spans: [headSpan(13, 13)],
        },
        image,
      ),
    ).toThrow(SemanticEditError);

    const valid = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("hair.main", "Hair", "hair"),
        spans: [headSpan(8, 8)],
      },
      image,
    );
    const source = valid.document.components[0]!;
    const invalid: SemanticState = {
      document: {
        ...valid.document,
        components: [
          source,
          {
            ...source,
            instanceId: "face.eye",
            displayName: "Eye",
            category: "eye",
            maskFile: componentMaskFile("face.eye"),
          },
        ],
      },
      masks: {
        "hair.main": valid.masks["hair.main"]!,
        "face.eye": valid.masks["hair.main"]!,
      },
      unknownMask: valid.unknownMask,
    };

    expect(() => validateSemanticState(invalid, image)).toThrow(
      /overlap at pixel/i,
    );
  });

  it("moves confirmed component pixels back to unknown", () => {
    const image = semanticFixture();
    const assigned = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("hair.main", "Hair", "hair"),
        spans: [headSpan(8, 9)],
      },
      image,
    );
    const unassigned = applyManualSemanticOperation(
      assigned,
      { type: "unassign_pixels", spans: [headSpan(9, 9)] },
      image,
    );

    expect(maskToPixelIds(unassigned.masks["hair.main"]!)).toEqual([8 * 64 + 8]);
    expect(maskToPixelIds(unassigned.unknownMask)).toContain(8 * 64 + 9);
    expect(() => validateSemanticState(unassigned, image)).not.toThrow();
  });

  it("rebases palettes and unknown coverage after deterministic pixel changes", () => {
    const image = semanticFixture();
    const assigned = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("hair.main", "Hair", "hair"),
        spans: [headSpan(8, 8)],
      },
      image,
    );
    const resultImage = createRgbaImage(64, 64, image.data.slice());
    setPixel(resultImage, 8, 8, [1, 2, 3, 255]);
    setPixel(resultImage, 13, 8, [9, 8, 7, 255]);
    const rebased = rebaseSemanticStateImage({
      state: assigned,
      sourceImage: image,
      resultImage,
      sourceHash: `sha256:${"1".repeat(64)}`,
    });

    expect(rebased.document.source.sourceHash).toBe(`sha256:${"1".repeat(64)}`);
    expect(rebased.document.components[0]!.palette).toEqual({
      dominant: "#010203",
      colors: ["#010203"],
    });
    expect(maskToPixelIds(rebased.unknownMask)).toContain(8 * 64 + 13);
    expect(() => validateSemanticState(rebased, resultImage)).not.toThrow();
  });
});

describe("reusable semantic parts", () => {
  it("exports exact 64x64 texture/mask assets and model compatibility", () => {
    const image = semanticFixture();
    const state = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("hair.main", "Hair", "hair"),
        spans: [headSpan(8, 9)],
      },
      image,
    );
    const part = exportSemanticPart({
      id: "part_hair",
      projectId: "project_test",
      revisionId: "revision_test",
      armType: "slim",
      createdAt: "2026-08-11T00:00:00.000Z",
      image,
      component: state.document.components[0]!,
      componentMask: state.masks["hair.main"]!,
    });

    expect(part.texture).toMatchObject({ width: 64, height: 64 });
    expect(part.writeMask).toHaveLength(64 * 64);
    expect(maskToPixelIds(part.writeMask)).toEqual([8 * 64 + 8, 8 * 64 + 9]);
    expect(getPixel(part.texture, 8, 8)).toEqual(getPixel(image, 8, 8));
    expect(getPixel(part.texture, 10, 8)).toEqual([0, 0, 0, 0]);
    expect(part.manifest.compatibility.armTypes).toEqual(["wide", "slim"]);
    expect(part.manifest.placement.surfaces).toEqual(["head.base.front"]);

    const mannequin = createPartMannequinTexture(
      part.texture,
      part.writeMask,
      "slim",
    );
    expect(getPixel(mannequin, 8, 8)).toEqual(getPixel(image, 8, 8));
    expect(getPixel(mannequin, 10, 8)).toEqual([226, 229, 224, 255]);
    expect(getPixel(mannequin, 8, 0)).toEqual([242, 244, 240, 255]);
    expect(getPixel(mannequin, 24, 8)).toEqual([194, 201, 197, 255]);
  });

  it("limits arm parts to their source model", () => {
    const image = createRgbaImage(64, 64);
    const span = firstPixelSpan("slim", "rightArm.base.front");
    setPixel(image, span.x0, span.y, [10, 20, 30, 255]);
    const state = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("glove.right", "Right glove", "glove"),
        spans: [span],
      },
      image,
    );
    const part = exportSemanticPart({
      id: "part_glove",
      projectId: "project_test",
      revisionId: "revision_test",
      armType: "slim",
      createdAt: "2026-08-11T00:00:00.000Z",
      image,
      component: state.document.components[0]!,
      componentMask: state.masks["glove.right"]!,
    });

    expect(part.manifest.compatibility.armTypes).toEqual(["slim"]);
    expect(
      analyzePartApplication(
        createRgbaImage(64, 64),
        part.texture,
        part.writeMask,
        part.manifest,
        "wide",
      ),
    ).toMatchObject({ compatible: false, modelConflict: true });
  });

  it("reports overlaps before applying an explicit deterministic strategy", () => {
    const image = semanticFixture();
    const state = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("hair.main", "Hair", "hair"),
        spans: [headSpan(8, 8)],
      },
      image,
    );
    const part = exportSemanticPart({
      id: "part_hair",
      projectId: "project_test",
      revisionId: "revision_test",
      armType: "slim",
      createdAt: "2026-08-11T00:00:00.000Z",
      image,
      component: state.document.components[0]!,
      componentMask: state.masks["hair.main"]!,
    });
    const sameBase = createRgbaImage(64, 64);
    setPixel(sameBase, 8, 8, getPixel(image, 8, 8));
    expect(
      analyzePartApplication(
        sameBase,
        part.texture,
        part.writeMask,
        part.manifest,
        "slim",
      ),
    ).toMatchObject({
      hardConflictCount: 0,
      sameColorOverlapCount: 1,
      writePixelCount: 1,
    });

    const differentBase = createRgbaImage(64, 64);
    setPixel(differentBase, 8, 8, [1, 2, 3, 255]);
    const report = analyzePartApplication(
      differentBase,
      part.texture,
      part.writeMask,
      part.manifest,
      "slim",
    );
    expect(report).toMatchObject({
      hardConflictCount: 1,
      sameColorOverlapCount: 0,
      conflicts: [{ type: "hard_conflict", x: 8, y: 8 }],
    });
    expect(getPixel(applyPartPixels(differentBase, part.texture, part.writeMask, "keep_base"), 8, 8)).toEqual([
      1, 2, 3, 255,
    ]);
    expect(getPixel(applyPartPixels(differentBase, part.texture, part.writeMask, "use_part"), 8, 8)).toEqual(
      getPixel(image, 8, 8),
    );
  });
});

function semanticFixture(): RgbaImage {
  const image = createRgbaImage(64, 64);
  const colors: readonly Rgba[] = [
    [180, 20, 30, 255],
    [180, 20, 30, 255],
    [40, 80, 220, 255],
    [30, 180, 70, 255],
  ];
  colors.forEach((color, index) => setPixel(image, 8 + index, 8, color));
  const arm = firstPixelSpan("slim", "rightArm.base.front");
  setPixel(image, arm.x0, arm.y, [80, 40, 20, 255]);
  return image;
}

function initialState(image: RgbaImage, armType: ArmType = "slim"): SemanticState {
  return createInitialSemanticState({
    revisionId: "revision_test",
    armType,
    sourceHash: SOURCE_HASH,
    image,
  });
}

function component(
  instanceId: string,
  displayName: string,
  category: "hair" | "eye" | "glove",
) {
  return { instanceId, displayName, category } as const;
}

function headSpan(x0: number, x1: number): SemanticPixelSpan {
  return { surface: "head.base.front", y: 8, x0, x1 };
}

function firstPixelSpan(
  armType: ArmType,
  surface: SurfaceKey,
): SemanticPixelSpan {
  const rect = getSkinLayout(armType).surfaces[surface].atlasRect;
  return { surface, y: rect.y, x0: rect.x, x1: rect.x };
}

function usedPixelIds(armType: ArmType): Set<number> {
  const layout = getSkinLayout(armType);
  const result = new Set<number>();
  for (const surface of Object.values(layout.surfaces)) {
    const rect = surface.atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        result.add(y * 64 + x);
      }
    }
  }
  return result;
}
