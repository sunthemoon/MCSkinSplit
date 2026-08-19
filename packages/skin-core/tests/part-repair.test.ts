import { describe, expect, it } from "vitest";
import {
  createLegacyMixedPixelOriginDocument,
  createPixelOriginDocument,
  createRgbaImage,
  getPixel,
  getPixelOrigin,
  setPixel,
  summarizePixelOrigins,
} from "../src";
import { getSkinLayout } from "../src/layouts/layout";
import {
  applyPartRepairOperation,
  applyPartRepairOperationWithOrigins,
  createLimbMirrorMappings,
  derivePartWriteMask,
  type OriginAwarePartRepairState,
  type PartRepairState,
} from "../src/semantic/part-repair";
import { buildSurfaceTexels } from "../src/uv/surface-model";
import type { ArmType, Rgba, SurfaceKey } from "../src/types";

describe("deterministic part repair", () => {
  it("paints, erases, and derives the write mask without mutating input", () => {
    const state = emptyState("slim");
    const span = firstSpan("slim", "head.base.front", 2);
    const painted = applyPartRepairOperation(state, {
      type: "paint_color",
      spans: [span],
      rgba: [12, 34, 56, 255],
    });

    expect(painted.changedPixelIds).toHaveLength(2);
    expect(getPixel(state.texture, span.x0, span.y)).toEqual([0, 0, 0, 0]);
    expect(getPixel(painted.texture, span.x0, span.y)).toEqual([12, 34, 56, 255]);
    expect(painted.writeMask[span.y * 64 + span.x0]).toBe(1);

    const erased = applyPartRepairOperation(painted, {
      type: "erase_pixels",
      spans: [{ ...span, x1: span.x0 }],
    });
    expect(getPixel(erased.texture, span.x0, span.y)).toEqual([0, 0, 0, 0]);
    expect(erased.writeMask[span.y * 64 + span.x0]).toBe(0);
    expect(erased.writeMask[span.y * 64 + span.x1]).toBe(1);
  });

  it("replaces only exact RGBA matches in the optional scope", () => {
    let state = emptyState("slim");
    const span = firstSpan("slim", "head.base.front", 3);
    state = applyPartRepairOperation(state, {
      type: "paint_color",
      spans: [span],
      rgba: [10, 20, 30, 255],
    });
    setPixel(state.texture, span.x1, span.y, [10, 20, 31, 255]);
    state = { ...state, writeMask: derivePartWriteMask(state.texture, "slim") };

    const result = applyPartRepairOperation(state, {
      type: "replace_color",
      from: [10, 20, 30, 255],
      to: [90, 80, 70, 128],
      spans: [{ ...span, x1: span.x0 + 1 }],
    });

    expect(result.changedPixelIds).toEqual([
      span.y * 64 + span.x0,
      span.y * 64 + span.x0 + 1,
    ]);
    expect(getPixel(result.texture, span.x0, span.y)).toEqual([90, 80, 70, 128]);
    expect(getPixel(result.texture, span.x1, span.y)).toEqual([10, 20, 31, 255]);
  });

  it("uses erase_pixels for removal and only replaces transparency in a scope", () => {
    const state = emptyState("slim");
    const span = firstSpan("slim", "head.base.front", 1);

    expect(() =>
      applyPartRepairOperation(state, {
        type: "replace_color",
        from: [0, 0, 0, 0],
        to: [1, 2, 3, 255],
      }),
    ).toThrow(/explicit repair selection/i);

    const filled = applyPartRepairOperation(state, {
      type: "replace_color",
      from: [0, 0, 0, 0],
      to: [1, 2, 3, 255],
      spans: [span],
    });
    expect(getPixel(filled.texture, span.x0, span.y)).toEqual([1, 2, 3, 255]);

    expect(() =>
      applyPartRepairOperation(filled, {
        type: "replace_color",
        from: [1, 2, 3, 255],
        to: [0, 0, 0, 0],
        spans: [span],
      }),
    ).toThrow(/use erase_pixels/i);
  });

  it("mirrors a Slim right arm to the left arm in canonical surface space", () => {
    const source = emptyState("slim");
    const sourcePixel = canonicalPixel("slim", "rightArm.base.front", 0, 2);
    setPixel(source.texture, sourcePixel.x, sourcePixel.y, [101, 55, 9, 255]);
    const sourceState = {
      ...source,
      writeMask: derivePartWriteMask(source.texture, "slim"),
    };

    const result = applyPartRepairOperation(emptyState("slim"), {
      type: "copy_surfaces",
      source: sourceState,
      mappings: createLimbMirrorMappings({
        sourceSide: "right",
        limb: "arm",
        layer: "base",
      }),
    });

    const targetPixel = canonicalPixel("slim", "leftArm.base.front", 2, 2);
    expect(getPixel(result.texture, targetPixel.x, targetPixel.y)).toEqual([
      101, 55, 9, 255,
    ]);
    expect(result.writeMask[targetPixel.y * 64 + targetPixel.x]).toBe(1);
    expect(result.changedPixelIds).toEqual([targetPixel.y * 64 + targetPixel.x]);
  });

  it("preserves occupied targets when transparent_only is selected", () => {
    const source = emptyState("slim");
    const target = emptyState("slim");
    const sourcePixel = canonicalPixel("slim", "head.base.front", 0, 0);
    const targetPixel = canonicalPixel("slim", "head.base.back", 0, 0);
    setPixel(source.texture, sourcePixel.x, sourcePixel.y, [1, 2, 3, 255]);
    setPixel(target.texture, targetPixel.x, targetPixel.y, [8, 7, 6, 255]);
    const sourceState = withDerivedMask(source);
    const targetState = withDerivedMask(target);

    const result = applyPartRepairOperation(targetState, {
      type: "copy_surfaces",
      source: sourceState,
      overwrite: "transparent_only",
      mappings: [
        {
          sourceSurface: "head.base.front",
          targetSurface: "head.base.back",
        },
      ],
    });

    expect(getPixel(result.texture, targetPixel.x, targetPixel.y)).toEqual([
      8, 7, 6, 255,
    ]);
    expect(result.changedPixelIds).toEqual([]);
  });

  it("rejects invalid colors, unused UV, duplicate targets, and dimensions", () => {
    const state = emptyState("slim");
    expect(() =>
      applyPartRepairOperation(state, {
        type: "paint_color",
        spans: [firstSpan("slim", "head.base.front", 1)],
        rgba: [1, 2, 3, 0],
      }),
    ).toThrow(/alpha must be nonzero/i);
    expect(() =>
      applyPartRepairOperation(state, {
        type: "paint_color",
        spans: [firstSpan("slim", "head.base.front", 1)],
        rgba: [1, 2, 300, 255] as Rgba,
      }),
    ).toThrow(/four byte values/i);
    expect(() =>
      applyPartRepairOperation(state, {
        type: "paint_color",
        spans: [
          { surface: "head.base.front", y: 0, x0: 0, x1: 0 },
        ],
        rgba: [1, 2, 3, 255],
      }),
    ).toThrow(/outside/i);
    const duplicate = firstSpan("slim", "head.base.front", 1);
    expect(() =>
      applyPartRepairOperation(state, {
        type: "paint_color",
        spans: [duplicate, duplicate],
        rgba: [1, 2, 3, 255],
      }),
    ).toThrow(/duplicates target pixel/i);
    expect(() =>
      applyPartRepairOperation(state, {
        type: "copy_surfaces",
        source: state,
        mappings: [
          {
            sourceSurface: "head.base.front",
            targetSurface: "rightArm.base.front",
          },
        ],
      }),
    ).toThrow(/dimensions are incompatible/i);
  });

  it("rejects duplicate copy destinations and colored unused atlas pixels", () => {
    const source = emptyState("slim");
    expect(() =>
      applyPartRepairOperation(emptyState("slim"), {
        type: "copy_surfaces",
        source,
        mappings: [
          {
            sourceSurface: "head.base.front",
            targetSurface: "head.base.back",
          },
          {
            sourceSurface: "head.outer.front",
            targetSurface: "head.base.back",
          },
        ],
      }),
    ).toThrow(/duplicate target pixel/i);

    setPixel(source.texture, 0, 0, [1, 2, 3, 255]);
    expect(() => derivePartWriteMask(source.texture, "slim")).toThrow(
      /unused UV pixel/i,
    );
  });

  it("persists manual paint/replace and erasure origins per edit Revision", () => {
    const state = originAwareEmptyState("slim", "parteditrev_base");
    const span = firstSpan("slim", "head.base.front", 1);
    const pixelId = span.y * 64 + span.x0;
    const painted = applyPartRepairOperationWithOrigins(
      state,
      { type: "paint_color", spans: [span], rgba: [1, 2, 3, 255] },
      {
        resultSubject: { kind: "part_edit_revision", id: "parteditrev_painted" },
        actor: { type: "user", id: "Player One" },
        operationId: "op_paint",
      },
    );

    expect(getPixelOrigin(painted.originDocument, pixelId)).toMatchObject({
      intrinsicOrigin: "manual_authored",
      evidence: {
        actor: { type: "user", id: "Player One" },
        operationId: "op_paint",
      },
      copyLineage: null,
    });
    expect(summarizePixelOrigins(painted.originDocument)).toMatchObject({
      containsGeneratedPixels: false,
      counts: { manual_authored: 1, generated_completion: 0 },
    });

    const replaced = applyPartRepairOperationWithOrigins(
      painted,
      {
        type: "replace_color",
        from: [1, 2, 3, 255],
        to: [7, 8, 9, 255],
      },
      {
        resultSubject: { kind: "part_edit_revision", id: "parteditrev_replaced" },
        actor: { type: "user" },
        operationId: "op_replace",
      },
    );
    expect(getPixelOrigin(replaced.originDocument, pixelId)).toMatchObject({
      intrinsicOrigin: "manual_authored",
      evidence: { operationId: "op_replace" },
    });

    const erased = applyPartRepairOperationWithOrigins(
      replaced,
      { type: "erase_pixels", spans: [span] },
      {
        resultSubject: { kind: "part_edit_revision", id: "parteditrev_erased" },
        actor: { type: "user" },
        operationId: "op_erase",
      },
    );
    expect(getPixelOrigin(erased.originDocument, pixelId)).toBeUndefined();
    expect(erased.originChangedPixelIds).toEqual([pixelId]);
    expect(summarizePixelOrigins(erased.originDocument).counts.manual_authored).toBe(0);
  });

  it("copies intrinsic origin with exact immediate ancestry, including same-RGBA copies", () => {
    const sourcePixel = canonicalPixel("slim", "head.base.front", 0, 0);
    const targetPixel = canonicalPixel("slim", "head.base.back", 0, 0);
    const sourceTexture = createRgbaImage(64, 64);
    const targetTexture = createRgbaImage(64, 64);
    setPixel(sourceTexture, sourcePixel.x, sourcePixel.y, [3, 4, 5, 255]);
    setPixel(targetTexture, targetPixel.x, targetPixel.y, [3, 4, 5, 255]);
    const source: OriginAwarePartRepairState = {
      armType: "slim",
      texture: sourceTexture,
      writeMask: derivePartWriteMask(sourceTexture, "slim"),
      originDocument: createPixelOriginDocument({
        subject: { kind: "part", id: "part_source" },
        armType: "slim",
        image: sourceTexture,
        intrinsicOrigin: "generated_completion",
        evidence: {
          candidateId: "candidate_test",
          evidenceHash: `sha256:${"b".repeat(64)}`,
          decisionId: "decision_test",
          actor: { type: "system" },
        },
      }),
      sourceComponentInstanceId: "hair.main",
    };
    const target: OriginAwarePartRepairState = {
      armType: "slim",
      texture: targetTexture,
      writeMask: derivePartWriteMask(targetTexture, "slim"),
      originDocument: createLegacyMixedPixelOriginDocument({
        subject: { kind: "part_edit_revision", id: "parteditrev_target" },
        sourceRevisionId: "rev_legacy",
        armType: "slim",
        image: targetTexture,
      }),
      sourceComponentInstanceId: "hair.main",
    };
    const result = applyPartRepairOperationWithOrigins(
      target,
      {
        type: "copy_surfaces",
        source,
        mappings: [
          {
            sourceSurface: "head.base.front",
            targetSurface: "head.base.back",
          },
        ],
      },
      {
        resultSubject: { kind: "part_edit_revision", id: "parteditrev_copied" },
        actor: { type: "user" },
        operationId: "op_copy",
      },
    );
    const targetPixelId = targetPixel.y * 64 + targetPixel.x;

    expect(result.changedPixelIds).toEqual([]);
    expect(result.originChangedPixelIds).toEqual([targetPixelId]);
    expect(getPixelOrigin(result.originDocument, targetPixelId)).toMatchObject({
      intrinsicOrigin: "generated_completion",
      copyLineage: {
        sourceSubject: { kind: "part", id: "part_source" },
        sourceComponentInstanceId: "hair.main",
        sourcePixelId: sourcePixel.y * 64 + sourcePixel.x,
      },
    });
  });
});

function emptyState(armType: ArmType): PartRepairState {
  const texture = createRgbaImage(64, 64);
  return { armType, texture, writeMask: derivePartWriteMask(texture, armType) };
}

function withDerivedMask(state: PartRepairState): PartRepairState {
  return {
    ...state,
    writeMask: derivePartWriteMask(state.texture, state.armType),
  };
}

function originAwareEmptyState(
  armType: ArmType,
  subjectId: string,
): OriginAwarePartRepairState {
  const state = emptyState(armType);
  return {
    ...state,
    originDocument: createLegacyMixedPixelOriginDocument({
      subject: { kind: "part_edit_revision", id: subjectId },
      sourceRevisionId: "rev_legacy",
      armType,
      image: state.texture,
    }),
    sourceComponentInstanceId: "hair.main",
  };
}

function firstSpan(
  armType: ArmType,
  surface: SurfaceKey,
  width: number,
) {
  const rect = getSkinLayout(armType).surfaces[surface].atlasRect;
  return {
    surface,
    y: rect.y,
    x0: rect.x,
    x1: rect.x + width - 1,
  } as const;
}

function canonicalPixel(
  armType: ArmType,
  surface: SurfaceKey,
  localU: number,
  localV: number,
): { readonly x: number; readonly y: number } {
  const texture = createRgbaImage(64, 64);
  const texel = buildSurfaceTexels(texture, getSkinLayout(armType)).find(
    (candidate) =>
      candidate.surface === surface &&
      candidate.localU === localU &&
      candidate.localV === localV,
  );
  if (!texel) throw new Error(`Missing canonical texel ${surface}:${localU},${localV}`);
  return { x: texel.atlasX, y: texel.atlasY };
}
