import { describe, expect, it } from "vitest";
import {
  aggregateKindForCategory,
  SEMANTIC_CATEGORIES,
  SemanticEditError,
  analyzePartApplication,
  applyManualSemanticOperation,
  assignSemanticPixelsWithProvenance,
  applyPartPixels,
  applyPartPixelsWithOrigins,
  componentMaskFile,
  createInitialSemanticState,
  createGeneratedPixelOriginAssignment,
  createPixelOriginDocument,
  createPartMannequinTexture,
  createRgbaImage,
  createSourceVisiblePixelOriginDocument,
  exportSemanticPart,
  getPixel,
  getPixelOrigin,
  getSkinLayout,
  maskToPixelIds,
  maskToRgbaImage,
  pixelIdsToMask,
  pixelIdsToSpans,
  rgbaImageToMask,
  rebaseSemanticStateImage,
  propagatePixelOriginDocument,
  setPixel,
  spansToPixelIds,
  validateSemanticState,
  summarizePixelOrigins,
  synchronizeSemanticPixelOriginSummaries,
  type ArmType,
  type Rgba,
  type RgbaImage,
  type SemanticCategory,
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

  it("maps precise categories to additive aggregate kinds", () => {
    expect(aggregateKindForCategory("hair")).toBe("hair");
    expect(aggregateKindForCategory("upper_clothing")).toBe("clothing");
    expect(aggregateKindForCategory("glove")).toBe("clothing");
    expect(aggregateKindForCategory("neck_accessory")).toBe("accessory");
    expect(aggregateKindForCategory("skin")).toBeNull();
    expect(SEMANTIC_CATEGORIES).not.toContain("clothing");
    expect(SEMANTIC_CATEGORIES).not.toContain("accessory");
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

  it("records explicit generated and sourced restoration provenance", () => {
    const image = semanticFixture();
    const planHash = `sha256:${"a".repeat(64)}`;
    const classified = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("outfit.old", "Old outfit", "upper_clothing"),
        spans: [headSpan(8, 8)],
      },
      image,
    );
    const sourced = assignSemanticPixelsWithProvenance(
      classified,
      {
        target: {
          instanceId: "skin.restored.copy",
          displayName: "Restored skin",
          category: "skin",
        },
        spans: [headSpan(8, 8)],
        provenance: {
          actorType: "system",
          containsGeneratedPixels: false,
          restoration: {
            kind: "composition_restoration",
            planHash,
            candidateIds: ["candidate_same_surface"],
            sourceRevisionIds: ["revision_source"],
            sourceComponentIds: ["skin.exposed"],
          },
        },
      },
      image,
    );
    const generated = assignSemanticPixelsWithProvenance(
      sourced,
      {
        target: {
          instanceId: "skin.restored.manual",
          displayName: "Authored skin",
          category: "skin",
        },
        spans: [headSpan(9, 9)],
        provenance: {
          actorType: "user",
          containsGeneratedPixels: true,
          restoration: {
            kind: "composition_restoration",
            planHash,
            candidateIds: ["candidate_manual_rgba"],
            sourceRevisionIds: [],
            sourceComponentIds: [],
          },
        },
      },
      image,
    );

    expect(
      generated.document.components.find(
        (item) => item.instanceId === "skin.restored.copy",
      )?.provenance,
    ).toMatchObject({
      actorType: "system",
      containsGeneratedPixels: false,
    });
    expect(
      generated.document.components.find(
        (item) => item.instanceId === "skin.restored.manual",
      )?.provenance,
    ).toMatchObject({ containsGeneratedPixels: true });
    expect(() => validateSemanticState(generated, image)).not.toThrow();
    expect(() =>
      assignSemanticPixelsWithProvenance(
        initialState(image),
        {
          target: {
            instanceId: "skin.invalid",
            displayName: "Invalid",
            category: "skin",
          },
          spans: [headSpan(8, 8)],
          provenance: {
            actorType: "system",
            containsGeneratedPixels: false,
            restoration: {
              kind: "composition_restoration",
              planHash: "invalid",
              candidateIds: ["candidate"],
              sourceRevisionIds: [],
              sourceComponentIds: [],
            },
          },
        },
        image,
      ),
    ).toThrow(/provenance is invalid/u);
  });

  it("preserves generated restoration origin through later semantic edits", () => {
    const image = semanticFixture();
    const planHash = `sha256:${"b".repeat(64)}`;
    const generated = assignSemanticPixelsWithProvenance(
      initialState(image),
      {
        target: {
          instanceId: "skin.restored.manual",
          displayName: "Authored skin",
          category: "skin",
        },
        spans: [headSpan(8, 9)],
        provenance: {
          actorType: "system",
          containsGeneratedPixels: true,
          restoration: {
            kind: "composition_restoration",
            planHash,
            candidateIds: ["candidate_manual"],
            sourceRevisionIds: [],
            sourceComponentIds: [],
          },
        },
      },
      image,
    );
    const split = applyManualSemanticOperation(
      generated,
      {
        type: "split_component",
        sourceComponentId: "skin.restored.manual",
        target: {
          instanceId: "skin.restored.split",
          displayName: "Split authored skin",
          category: "skin",
        },
        spans: [headSpan(9, 9)],
      },
      image,
    );
    const reclassified = applyManualSemanticOperation(
      split,
      {
        type: "reclassify_component",
        componentId: "skin.restored.split",
        category: "face_detail",
      },
      image,
    );
    const merged = applyManualSemanticOperation(
      reclassified,
      {
        type: "merge_components",
        componentIds: ["skin.restored.manual", "skin.restored.split"],
        target: {
          instanceId: "skin.restored.merged",
          displayName: "Merged authored skin",
          category: "skin",
        },
      },
      image,
    );

    expect(
      merged.document.components.find(
        (component) => component.instanceId === "skin.restored.merged",
      )?.provenance,
    ).toMatchObject({
      actorType: "user",
      containsGeneratedPixels: true,
      restoration: {
        planHash,
        candidateIds: ["candidate_manual"],
      },
    });
  });
});

describe("reusable semantic parts", () => {
  it("derives component generated summaries without treating manual pixels as generated", () => {
    const image = createRgbaImage(64, 64);
    setPixel(image, 8, 8, [1, 2, 3, 255]);
    const state = applyManualSemanticOperation(
      initialState(image),
      {
        type: "assign_pixels",
        target: component("hair.main", "Hair", "hair"),
        spans: [headSpan(8, 8)],
      },
      image,
    );
    const origins = createPixelOriginDocument({
      subject: { kind: "revision", id: "revision_test" },
      armType: "slim",
      image,
      intrinsicOrigin: "manual_authored",
      evidence: {
        actor: { type: "user", id: "Player One" },
        operationId: "op_paint",
      },
    });
    const synchronized = synchronizeSemanticPixelOriginSummaries(
      state,
      origins,
      image,
    );

    expect(synchronized.document.components[0]!.provenance).toMatchObject({
      containsGeneratedPixels: false,
      originSummary: {
        containsGeneratedPixels: false,
        counts: { manual_authored: 1, generated_completion: 0 },
      },
    });
    expect(() => validateSemanticState(synchronized, image)).not.toThrow();
    expect(() =>
      synchronizeSemanticPixelOriginSummaries(
        state,
        { ...origins, entries: [] },
        image,
      ),
    ).toThrow("cover every non-transparent used UV pixel exactly");
  });

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
      originDocument: createSourceVisiblePixelOriginDocument({
        subject: { kind: "revision", id: "revision_test" },
        armType: "slim",
        image,
      }),
    });

    expect(part.texture).toMatchObject({ width: 64, height: 64 });
    expect(part.writeMask).toHaveLength(64 * 64);
    expect(maskToPixelIds(part.writeMask)).toEqual([8 * 64 + 8, 8 * 64 + 9]);
    expect(getPixel(part.texture, 8, 8)).toEqual(getPixel(image, 8, 8));
    expect(getPixel(part.texture, 10, 8)).toEqual([0, 0, 0, 0]);
    expect(part.manifest).toMatchObject({
      schemaVersion: "2.0",
      origin: {
        file: "origin.json",
        generatedMaskFile: "generated-mask.png",
        containsGeneratedPixels: false,
      },
    });
    expect("derivation" in part.manifest).toBe(false);
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
      originDocument: createSourceVisiblePixelOriginDocument({
        subject: { kind: "revision", id: "revision_test" },
        armType: "slim",
        image,
      }),
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
      originDocument: createSourceVisiblePixelOriginDocument({
        subject: { kind: "revision", id: "revision_test" },
        armType: "slim",
        image,
      }),
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

  it("round-trips generated origin through Part 2.0 and part application", () => {
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
    const sourceOrigins = createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "revision_test" },
      armType: "slim",
      image,
    });
    const generatedOrigins = propagatePixelOriginDocument({
      sourceDocument: sourceOrigins,
      sourceImage: image,
      resultImage: image,
      resultSubject: { kind: "revision", id: "revision_generated" },
      assignments: [
        createGeneratedPixelOriginAssignment({
          pixelId: 8 * 64 + 8,
          evidence: {
            candidateId: "candidate_test",
            evidenceHash: `sha256:${"c".repeat(64)}`,
            decisionId: "decision_test",
            actor: { type: "user", id: "Player One" },
          },
        }),
      ],
    });
    const generatedState: SemanticState = {
      ...state,
      document: { ...state.document, revisionId: "revision_generated" },
    };
    const part = exportSemanticPart({
      id: "part_generated",
      projectId: "project_test",
      revisionId: "revision_generated",
      armType: "slim",
      createdAt: "2026-08-19T00:00:00.000Z",
      image,
      component: generatedState.document.components[0]!,
      componentMask: generatedState.masks["hair.main"]!,
      originDocument: generatedOrigins,
    });

    expect(part.generatedMask[8 * 64 + 8]).toBe(1);
    expect(part.manifest.origin).toMatchObject({
      containsGeneratedPixels: true,
      summary: {
        containsGeneratedPixels: true,
        counts: { generated_completion: 1 },
      },
    });
    const base = createRgbaImage(64, 64);
    const baseOrigins = createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "revision_target" },
      armType: "slim",
      image: base,
    });
    const applied = applyPartPixelsWithOrigins({
      base,
      baseOriginDocument: baseOrigins,
      partTexture: part.texture,
      writeMask: part.writeMask,
      partOriginDocument: part.originDocument,
      manifest: part.manifest,
      targetSubject: { kind: "revision", id: "revision_applied" },
      strategy: "use_part",
    });

    expect(summarizePixelOrigins(applied.originDocument)).toMatchObject({
      containsGeneratedPixels: true,
      counts: { generated_completion: 1 },
    });
    expect(getPixelOrigin(applied.originDocument, 8 * 64 + 8)).toMatchObject({
      intrinsicOrigin: "generated_completion",
      evidence: { candidateId: "candidate_test" },
      copyLineage: {
        sourceSubject: { kind: "part", id: "part_generated" },
        sourceComponentInstanceId: "hair.main",
        sourcePixelId: 8 * 64 + 8,
      },
    });
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
  category: SemanticCategory,
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
