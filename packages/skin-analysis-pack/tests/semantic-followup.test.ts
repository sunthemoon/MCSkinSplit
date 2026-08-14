import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyManualSemanticOperation,
  createInitialSemanticState,
  decodeSkinPng,
  getSkinLayout,
  type Rgba,
  type RgbaImage,
  type SemanticPixelSpan,
} from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import {
  assessSemanticFollowup,
  createAnalysisDocuments,
  SEMANTIC_FOLLOWUP_ALGORITHM_VERSION,
} from "../src/index";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDirectory = resolve(repositoryRoot, "tests/fixtures/skins");

describe("semantic follow-up assessment", () => {
  it("suggests exact review-only long-hair pixels separated from a dark outfit", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    fillRect(image, head.x + 2, head.y, 4, 4, [238, 240, 242, 255]);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [22, 23, 26, 255]);
    fillRect(image, torso.x + 3, torso.y, 2, 8, [232, 235, 239, 255]);

    let state = createInitialSemanticState({
      revisionId: "rev_white_hair",
      sourceHash: `sha256:${"a".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.long", displayName: "Long light hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 2, head.x + 5),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: {
          instanceId: "outfit.black",
          displayName: "Black off-shoulder outfit",
          category: "upper_clothing",
        },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: {
          instanceId: "outfit.misclassified_hair",
          displayName: "White torso trim",
          category: "upper_clothing",
        },
        spans: span("torso.base.front", torso.y, torso.y + 7, torso.x + 3, torso.x + 4),
      },
      image,
    );
    const candidateRegions = createAnalysisDocuments(image, layout).candidateRegions;

    const first = assessSemanticFollowup({ state, image, candidateRegions });
    const second = assessSemanticFollowup({ state, image, candidateRegions });

    expect(first).toEqual(second);
    expect(first.algorithmVersion).toBe(SEMANTIC_FOLLOWUP_ALGORITHM_VERSION);
    expect(first.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.suggestions).toHaveLength(1);
    expect(first.suggestions[0]!.id).toMatch(/^followup_[0-9a-f]{24}$/u);
    expect(first.suggestions[0]).toMatchObject({
      kind: "cross_body_hair_reclassification",
      targetComponentId: "hair.long",
      sourceComponentIds: ["outfit.misclassified_hair"],
      pixelCount: 16,
      confidence: 0.95,
    });
    expect(first.suggestions[0]!.candidateRegionIds).toHaveLength(1);
    expect(first.suggestions[0]!.spans).toEqual([
      ...Array.from({ length: 8 }, (_, index) => ({
        surface: "torso.base.front",
        y: torso.y + index,
        x0: torso.x + 3,
        x1: torso.x + 4,
      })),
    ]);
    expect(first.notices).toEqual([expect.objectContaining({
      kind: "possible_hidden_clothing",
      suggestionIds: [first.suggestions[0]!.id],
    })]);
  });

  it("joins fragmented hair shades without absorbing a nearby dark outfit", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    fillRect(image, head.x + 2, head.y, 4, 4, [230, 230, 230, 255]);
    fillRect(image, head.x + 2, head.y, 1, 4, [18, 18, 18, 255]);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [18, 18, 18, 255]);
    fillRect(image, torso.x + 1, torso.y, 1, 3, [212, 212, 212, 255]);
    fillRect(image, torso.x + 1, torso.y + 4, 1, 4, [230, 230, 230, 255]);

    let state = createInitialSemanticState({
      revisionId: "rev_fragmented_hair",
      sourceHash: `sha256:${"c".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.fragmented", displayName: "Fragmented hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 2, head.x + 5),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.dark", displayName: "Dark outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.algorithmVersion).toBe("cross-body-hair-reclassification-v2");
    expect(assessment.suggestions).toHaveLength(1);
    expect(assessment.suggestions[0]).toMatchObject({
      targetComponentId: "hair.fragmented",
      sourceComponentIds: ["outfit.dark"],
      pixelCount: 7,
    });
    expect(assessment.suggestions[0]!.spans).toEqual([
      ...span("torso.base.front", torso.y, torso.y + 2, torso.x + 1, torso.x + 1),
      ...span("torso.base.front", torso.y + 4, torso.y + 7, torso.x + 1, torso.x + 1),
    ]);
  });

  it("keeps a full matching back-hair panel when a narrow cross-surface lock and contrasting outfit corroborate it", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const front = layout.surfaces["torso.base.front"].atlasRect;
    const back = layout.surfaces["torso.base.back"].atlasRect;
    const hair: Rgba = [232, 234, 238, 255];
    fillRect(image, head.x + 2, head.y, 4, 4, hair);
    fillRect(image, front.x, front.y, front.width, front.height, [28, 29, 32, 255]);
    fillRect(image, front.x + 3, front.y, 2, 8, hair);
    fillRect(image, back.x, back.y, back.width, back.height, hair);

    let state = createInitialSemanticState({
      revisionId: "rev_full_back_hair",
      sourceHash: `sha256:${"e".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.long", displayName: "Long hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 2, head.x + 5),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.mixed", displayName: "Outfit", category: "upper_clothing" },
        spans: [
          ...span("torso.base.front", front.y, front.y + front.height - 1, front.x, front.x + front.width - 1),
          ...span("torso.base.back", back.y, back.y + back.height - 1, back.x, back.x + back.width - 1),
        ],
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.suggestions).toHaveLength(1);
    expect(assessment.suggestions[0]).toMatchObject({
      targetComponentId: "hair.long",
      sourceComponentIds: ["outfit.mixed"],
      pixelCount: 112,
    });
  });

  it("does not reinterpret a full same-color garment panel as hair", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    const shared: Rgba = [170, 92, 70, 255];
    fillRect(image, head.x + 2, head.y, 4, 4, shared);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, shared);

    let state = createInitialSemanticState({
      revisionId: "rev_matching_garment",
      sourceHash: `sha256:${"f".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.red", displayName: "Red hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 2, head.x + 5),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.red", displayName: "Red garment", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.suggestions).toEqual([]);
    expect(assessment.notices).toEqual([]);
  });

  it("does not drift through a chain of increasingly distant hair colors", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    const shades = [100, 118, 136, 154, 172, 190] as const;
    for (let index = 0; index < shades.length; index += 1) {
      const value = shades[index]!;
      fillRect(image, head.x + index, head.y, 1, 4, [value, value, value, 255]);
    }
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [20, 20, 22, 255]);
    fillRect(image, torso.x + 3, torso.y, 1, 6, [190, 190, 190, 255]);

    let state = createInitialSemanticState({
      revisionId: "rev_gradient_chain",
      sourceHash: `sha256:${"1".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.gradient", displayName: "Gradient hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x, head.x + shades.length - 1),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.dark", displayName: "Dark outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.suggestions).toEqual([]);
  });

  it("does not reinterpret an off-shoulder exposed-skin fragment as hair", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    const skinTone: Rgba = [224, 184, 164, 255];
    fillRect(image, head.x, head.y, 4, 4, skinTone);
    fillRect(image, head.x + 4, head.y + 6, 4, 2, skinTone);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [26, 27, 30, 255]);
    fillRect(image, torso.x + 3, torso.y, 2, 4, skinTone);

    let state = createInitialSemanticState({
      revisionId: "rev_off_shoulder_skin",
      sourceHash: `sha256:${"2".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.skin-tone", displayName: "Skin-tone hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x, head.x + 3),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "face", displayName: "Face", category: "face" },
        spans: span("head.base.front", head.y + 6, head.y + 7, head.x + 4, head.x + 7),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.dark", displayName: "Dark outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.suggestions).toEqual([]);
  });

  it("rejects weak eye-like head evidence even when its color forms a torso stripe", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    const eyeColor: Rgba = [62, 74, 88, 255];
    fillRect(image, head.x + 1, head.y + 3, 2, 2, eyeColor);
    fillRect(image, head.x + 5, head.y + 3, 2, 2, eyeColor);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [18, 18, 20, 255]);
    fillRect(image, torso.x + 3, torso.y, 1, 6, eyeColor);

    let state = createInitialSemanticState({
      revisionId: "rev_eye_like_hair",
      sourceHash: `sha256:${"3".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.weak", displayName: "Weak hair", category: "hair" },
        spans: [
          ...span("head.base.front", head.y + 3, head.y + 4, head.x + 1, head.x + 2),
          ...span("head.base.front", head.y + 3, head.y + 4, head.x + 5, head.x + 6),
        ],
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.dark", displayName: "Dark outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.suggestions).toEqual([]);
  });

  it("rejects a matching candidate region with mixed clothing and unknown ownership", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    const hair: Rgba = [214, 216, 220, 255];
    fillRect(image, head.x + 2, head.y, 4, 4, hair);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [24, 24, 26, 255]);
    fillRect(image, torso.x + 3, torso.y, 1, 6, hair);

    let state = createInitialSemanticState({
      revisionId: "rev_mixed_unknown",
      sourceHash: `sha256:${"4".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.long", displayName: "Long hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 2, head.x + 5),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.dark", displayName: "Dark outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "unassign_pixels",
        spans: span("torso.base.front", torso.y + 3, torso.y + 3, torso.x + 3, torso.x + 3),
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.suggestions).toEqual([]);
  });

  it("combines multiple hair targets into one player-facing repair suggestion", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    fillRect(image, head.x, head.y, 2, 4, [230, 230, 230, 255]);
    fillRect(image, head.x + 6, head.y, 2, 4, [176, 198, 220, 255]);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [24, 24, 26, 255]);
    fillRect(image, torso.x, torso.y, 1, 6, [230, 230, 230, 255]);
    fillRect(image, torso.x + 7, torso.y, 1, 6, [176, 198, 220, 255]);

    let state = createInitialSemanticState({
      revisionId: "rev_two_tone_hair",
      sourceHash: `sha256:${"d".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.light", displayName: "Light hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x, head.x + 1),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.blue", displayName: "Blue hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 6, head.x + 7),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.two-tone", displayName: "Outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );

    const assessment = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(assessment.suggestions).toHaveLength(1);
    expect(assessment.suggestions[0]).toMatchObject({
      targetComponentId: expect.stringMatching(/^hair\.cross-body-[0-9a-f]{12}$/u),
      sourceComponentIds: ["outfit.two-tone"],
      pixelCount: 12,
    });
  });

  it("uses a deterministic aggregate target when same-color hair components are ambiguous", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    const shared: Rgba = [202, 206, 214, 255];
    fillRect(image, head.x, head.y, 2, 4, shared);
    fillRect(image, head.x + 6, head.y, 2, 4, shared);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [24, 24, 26, 255]);
    fillRect(image, torso.x + 3, torso.y, 1, 6, shared);

    let state = createInitialSemanticState({
      revisionId: "rev_ambiguous_hair",
      sourceHash: `sha256:${"5".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.left", displayName: "Left hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x, head.x + 1),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.right", displayName: "Right hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 6, head.x + 7),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.dark", displayName: "Dark outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );

    const first = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });
    const second = assessSemanticFollowup({
      state,
      image,
      candidateRegions: createAnalysisDocuments(image, layout).candidateRegions,
    });

    expect(first).toEqual(second);
    expect(first.suggestions).toHaveLength(1);
    expect(first.suggestions[0]).toMatchObject({
      targetComponentId: expect.stringMatching(/^hair\.cross-body-[0-9a-f]{12}$/u),
      sourceComponentIds: ["outfit.dark"],
      pixelCount: 6,
    });
  });

  it("rejects candidate pixels that cross their declared Atlas surface boundary", () => {
    const layout = getSkinLayout("slim");
    const image = transparentImage();
    const head = layout.surfaces["head.base.front"].atlasRect;
    const torso = layout.surfaces["torso.base.front"].atlasRect;
    const hair: Rgba = [220, 222, 226, 255];
    fillRect(image, head.x + 2, head.y, 4, 4, hair);
    fillRect(image, torso.x, torso.y, torso.width, torso.height, [24, 24, 26, 255]);
    fillRect(image, torso.x + 3, torso.y, 1, 6, hair);

    let state = createInitialSemanticState({
      revisionId: "rev_atlas_boundary",
      sourceHash: `sha256:${"6".repeat(64)}`,
      armType: "slim",
      image,
    });
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "hair.long", displayName: "Long hair", category: "hair" },
        spans: span("head.base.front", head.y, head.y + 3, head.x + 2, head.x + 5),
      },
      image,
    );
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: { instanceId: "outfit.dark", displayName: "Dark outfit", category: "upper_clothing" },
        spans: span("torso.base.front", torso.y, torso.y + torso.height - 1, torso.x, torso.x + torso.width - 1),
      },
      image,
    );
    const candidateRegions = createAnalysisDocuments(image, layout).candidateRegions;
    const target = candidateRegions.regions.find((region) =>
      region.surface === "torso.base.front" && region.pixelIds.includes(torso.y * 64 + torso.x + 3)
    )!;
    const invalidPixelId = torso.y * 64 + torso.x - 1;
    const corrupted = {
      ...candidateRegions,
      regions: candidateRegions.regions.map((region) =>
        region.id === target.id
          ? { ...region, pixelIds: [invalidPixelId, ...region.pixelIds.slice(1)] }
          : region
      ),
    };

    expect(() => assessSemanticFollowup({ state, image, candidateRegions: corrupted }))
      .toThrow(/outside its declared surface/u);
  });

  it("is deterministic and silent for a real skin with no classified components", async () => {
    const image = decodeSkinPng(
      await readFile(resolve(fixtureDirectory, "354359a2c2f33777.png")),
    );
    const layout = getSkinLayout("slim");
    const state = createInitialSemanticState({
      revisionId: "rev_real",
      sourceHash: `sha256:${"b".repeat(64)}`,
      armType: "slim",
      image,
    });
    const candidateRegions = createAnalysisDocuments(image, layout).candidateRegions;

    const assessment = assessSemanticFollowup({ state, image, candidateRegions });

    expect(assessment.suggestions).toEqual([]);
    expect(assessment.notices).toEqual([]);
    expect(assessment).toEqual(assessSemanticFollowup({ state, image, candidateRegions }));
  });
});

function transparentImage(): RgbaImage {
  return { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) };
}

function fillRect(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
  rgba: Rgba,
): void {
  for (let atlasY = y; atlasY < y + height; atlasY += 1) {
    for (let atlasX = x; atlasX < x + width; atlasX += 1) {
      image.data.set(rgba, (atlasY * 64 + atlasX) * 4);
    }
  }
}

function span(
  surface: SemanticPixelSpan["surface"],
  y0: number,
  y1: number,
  x0: number,
  x1: number,
): SemanticPixelSpan[] {
  return Array.from({ length: y1 - y0 + 1 }, (_, index) => ({
    surface,
    y: y0 + index,
    x0,
    x1,
  }));
}
