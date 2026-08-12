import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyManualSemanticOperation,
  buildSurfaceTexels,
  canonicalRestorationJson,
  createInitialSemanticState,
  createRestorationPlanFromCandidates,
  createRgbaImage,
  generateRestorationCandidates,
  getSkinLayout,
  maskToPixelIds,
  pixelIdsToSpans,
  setPixel,
  type ArmType,
  type RestorationCandidate,
  type RestorationHashCanonical,
  type RestorationSemanticRevision,
  type Rgba,
  type RgbaImage,
  type SemanticCategory,
  type SemanticState,
  type SurfaceKey,
  type SurfaceTexel,
} from "../src";

const hashCanonical: RestorationHashCanonical = (canonical) =>
  `sha256:${createHash("sha256").update(canonical).digest("hex")}`;

describe("restoration candidates", () => {
  it("derives body/layer targets and emits one aggregate Outer clear candidate", () => {
    const image = createRgbaImage(64, 64);
    const baseTargets = [
      texel("slim", "head.base.front", 2, 2),
      texel("slim", "head.base.front", 6, 2),
    ];
    const outerTargets = [
      texel("slim", "head.outer.front", 2, 2),
      texel("slim", "torso.outer.front", 1, 1),
    ];
    const leftSample = texel("slim", "head.base.front", 1, 2);
    const rightSample = texel("slim", "head.base.front", 7, 2);
    const nonSkinSample = texel("slim", "head.base.front", 2, 1);
    const translucentSkin = texel("slim", "head.base.front", 2, 3);

    paint(image, [...baseTargets, ...outerTargets], [90, 80, 70, 255]);
    paint(image, [leftSample], [200, 10, 20, 255]);
    paint(image, [rightSample], [10, 40, 220, 255]);
    paint(image, [nonSkinSample], [1, 2, 3, 255]);
    paint(image, [translucentSkin], [4, 5, 6, 128]);
    const source = semanticRevision("rev_source", "slim", image, [
      component("cleanup.main", "upper_clothing", [
        ...baseTargets,
        ...outerTargets,
      ]),
      component("skin.main", "skin", [leftSample, rightSample, translucentSkin]),
      component("face.detail", "face_detail", [nonSkinSample]),
    ]);

    const set = generateRestorationCandidates({
      source,
      cleanupComponentIds: ["cleanup.main"],
      manualColors: [[31, 32, 33, 255]],
      hashCanonical,
    });

    expect(set.cleanupPixelIds).toEqual(
      [...baseTargets, ...outerTargets]
        .map((item) => item.pixelId)
        .sort((left, right) => left - right),
    );
    expect(set.targetGroups.map((group) => group.targetGroupId)).toEqual([
      "head_base",
      "head_outer",
      "torso_outer",
    ]);
    for (const group of set.targetGroups) {
      expect(maskToPixelIds(group.mask)).toEqual(group.pixelIds);
    }

    const outer = set.candidates.filter(
      (candidate) => candidate.kind === "outer_transparent",
    );
    expect(outer).toHaveLength(1);
    expect(outer[0]!.targetGroupId).toBe("outer_all");
    expect(outer[0]!.targetGroupIds).toEqual(["head_outer", "torso_outer"]);
    expect(outer[0]!.operationDescriptors).toHaveLength(2);
    expect(
      outer[0]!.operationDescriptors.map((operation) => operation.mode),
    ).toEqual(["clear_outer", "clear_outer"]);
    expect(outer[0]!.coveredPixelCount).toBe(2);

    const sameSurface = findCandidate(set.candidates, "current_same_surface");
    expect(sameSurface.complete).toBe(true);
    expect(sameSurface.coveredPixelCount).toBe(2);
    expect(sameSurface.evidence.samplePixelIds).toEqual(
      [leftSample.pixelId, rightSample.pixelId].sort((left, right) => left - right),
    );
    expect(sameSurface.evidence.samplePixelIds).not.toContain(
      nonSkinSample.pixelId,
    );
    expect(sameSurface.evidence.samplePixelIds).not.toContain(
      translucentSkin.pixelId,
    );
    expect(sameSurface.sourceComponentIds).toEqual(["skin.main"]);
    expect(outer[0]!.sourceComponentIds).toEqual([]);
    expect(
      findCandidate(set.candidates, "manual_rgba").sourceComponentIds,
    ).toEqual([]);
    expect(sameSurface.operationDescriptors).toHaveLength(2);
    expect(
      sameSurface.operationDescriptors.map((operation) =>
        operation.mode === "fill_base" ? operation.rgba : null,
      ),
    ).toEqual([
      [10, 40, 220, 255],
      [200, 10, 20, 255],
    ]);
  });

  it("uses canonical Manhattan distance and pixel-id tie-breaking", () => {
    const image = createRgbaImage(64, 64);
    const target = texel("slim", "head.base.front", 3, 3);
    const candidates = [
      texel("slim", "head.base.front", 2, 3),
      texel("slim", "head.base.front", 4, 3),
    ];
    paint(image, [target], [80, 80, 80, 255]);
    paint(image, candidates, [22, 44, 66, 255]);
    const source = semanticRevision("rev_tie", "slim", image, [
      component("cleanup.tie", "hair", [target]),
      component("skin.tie", "skin", candidates),
    ]);

    const set = generateRestorationCandidates({
      source,
      cleanupComponentIds: ["cleanup.tie"],
      hashCanonical,
    });
    const sameSurface = findCandidate(set.candidates, "current_same_surface");
    expect(sameSurface.evidence.assignments).toEqual([
      {
        targetPixelId: target.pixelId,
        samplePixelId: Math.min(...candidates.map((item) => item.pixelId)),
        rgba: [22, 44, 66, 255],
      },
    ]);
  });

  it("keeps donor cleanup coordinates eligible and rejects another arm model", () => {
    const sourceImage = createRgbaImage(64, 64);
    const target = texel("slim", "rightArm.base.front", 1, 2);
    paint(sourceImage, [target], [90, 80, 70, 255]);
    const source = semanticRevision("rev_source_donor", "slim", sourceImage, [
      component("cleanup.arm", "sleeve", [target]),
    ]);

    const donorImage = createRgbaImage(64, 64);
    const donorTarget = texel("slim", "rightArm.base.front", 1, 2);
    paint(donorImage, [donorTarget], [17, 27, 37, 255]);
    const donor = semanticRevision("rev_donor", "slim", donorImage, [
      component("skin.donor", "skin", [donorTarget]),
    ]);
    const set = generateRestorationCandidates({
      source,
      cleanupComponentIds: ["cleanup.arm"],
      donors: [donor],
      hashCanonical,
    });
    const donorCandidate = findCandidate(set.candidates, "donor_revision");
    expect(donorCandidate.complete).toBe(true);
    expect(donorCandidate.evidence.assignments).toEqual([
      {
        targetPixelId: target.pixelId,
        samplePixelId: donorTarget.pixelId,
        rgba: [17, 27, 37, 255],
      },
    ]);
    expect(donorCandidate.sourceComponentIds).toEqual(["skin.donor"]);

    const wideImage = createRgbaImage(64, 64);
    const wideSkin = texel("wide", "rightArm.base.front", 1, 2);
    paint(wideImage, [wideSkin], [17, 27, 37, 255]);
    const wrongModel = semanticRevision("rev_wide", "wide", wideImage, [
      component("skin.wide", "skin", [wideSkin]),
    ]);
    expect(() =>
      generateRestorationCandidates({
        source,
        cleanupComponentIds: ["cleanup.arm"],
        donors: [wrongModel],
        hashCanonical,
      }),
    ).toThrow(/different arm model/i);
  });

  it("uses layout width for exact mirrored counterparts when edge skin is absent", () => {
    const image = createRgbaImage(64, 64);
    const target = texel("slim", "rightArm.base.front", 1, 2);
    const mirror = texel("slim", "leftArm.base.front", 1, 2);
    paint(image, [target], [90, 80, 70, 255]);
    paint(image, [mirror], [71, 72, 73, 255]);
    const source = semanticRevision("rev_mirror", "slim", image, [
      component("cleanup.mirror", "sleeve", [target]),
      // Slim arm width is three. Only the middle texel is semantic skin, so
      // available samples cannot be used to infer the surface width.
      component("skin.mirror", "skin", [mirror]),
    ]);
    const set = generateRestorationCandidates({
      source,
      cleanupComponentIds: ["cleanup.mirror"],
      hashCanonical,
    });
    const candidate = findCandidate(set.candidates, "mirrored_counterpart");
    expect(candidate.complete).toBe(true);
    expect(candidate.evidence.assignments[0]).toEqual({
      targetPixelId: target.pixelId,
      samplePixelId: mirror.pixelId,
      rgba: [71, 72, 73, 255],
    });
  });

  it("is order-independent and auto-includes Outer when planning a Base choice", () => {
    const image = createRgbaImage(64, 64);
    const base = texel("slim", "torso.base.front", 2, 2);
    const outerHead = texel("slim", "head.outer.front", 2, 2);
    const outerTorso = texel("slim", "torso.outer.front", 2, 2);
    paint(image, [base, outerHead], [90, 80, 70, 255]);
    paint(image, [outerTorso], [91, 81, 71, 255]);
    const source = semanticRevision("rev_plan", "slim", image, [
      component("cleanup.a", "upper_clothing", [base, outerHead]),
      component("cleanup.b", "body_accessory", [outerTorso]),
    ]);
    const first = generateRestorationCandidates({
      source,
      cleanupComponentIds: ["cleanup.b", "cleanup.a"],
      manualColors: [
        [100, 110, 120, 255],
        [20, 30, 40, 255],
      ],
      hashCanonical,
    });
    const second = generateRestorationCandidates({
      source,
      cleanupComponentIds: ["cleanup.a", "cleanup.b"],
      manualColors: [
        [20, 30, 40, 255],
        [100, 110, 120, 255],
      ],
      hashCanonical,
    });
    expect(first.candidateSetHash).toBe(second.candidateSetHash);
    expect(first.candidates.map((candidate) => candidate.candidateId)).toEqual(
      second.candidates.map((candidate) => candidate.candidateId),
    );
    expect(first.candidates.map((candidate) => candidate.operationDescriptors)).toEqual(
      second.candidates.map((candidate) => candidate.operationDescriptors),
    );

    const manual = first.candidates.find(
      (candidate) =>
        candidate.kind === "manual_rgba" && candidate.manualRgba?.[0] === 20,
    )!;
    const outer = findCandidate(first.candidates, "outer_transparent");
    const plan = createRestorationPlanFromCandidates(
      first,
      [manual.candidateId],
      hashCanonical,
    );
    expect(plan.selectedCandidateIds).toEqual([
      outer.candidateId,
      manual.candidateId,
    ]);
    expect(plan.complete).toBe(true);
    expect(plan.missingPixelCount).toBe(0);
    expect(plan.operationDescriptors.map((operation) => operation.mode)).toEqual([
      "clear_outer",
      "clear_outer",
      "fill_base",
    ]);
    expect(plan.operations.map((operation) => maskToPixelIds(operation.mask))).toEqual(
      plan.operationDescriptors.map((operation) => operation.pixelIds),
    );
  });

  it("rejects transparent manual fills and keeps masks out of canonical evidence", () => {
    const image = createRgbaImage(64, 64);
    const target = texel("slim", "head.base.front", 1, 1);
    paint(image, [target], [90, 80, 70, 255]);
    const source = semanticRevision("rev_manual", "slim", image, [
      component("cleanup.manual", "hair", [target]),
    ]);
    expect(() =>
      generateRestorationCandidates({
        source,
        cleanupComponentIds: ["cleanup.manual"],
        manualColors: [[1, 2, 3, 0]],
        hashCanonical,
      }),
    ).toThrow(/opaque/i);
    expect(canonicalRestorationJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(() => canonicalRestorationJson({ mask: new Uint8Array(64 * 64) })).toThrow(
      /excludes Uint8Array/i,
    );
  });
});

function semanticRevision(
  revisionId: string,
  armType: ArmType,
  image: RgbaImage,
  components: readonly ComponentFixture[],
): RestorationSemanticRevision {
  let semanticState: SemanticState = createInitialSemanticState({
    revisionId,
    armType,
    sourceHash: `sha256:${"1".repeat(64)}`,
    image,
  });
  for (const item of components) {
    semanticState = applyManualSemanticOperation(
      semanticState,
      {
        type: "assign_pixels",
        target: {
          instanceId: item.id,
          displayName: item.id,
          category: item.category,
        },
        spans: pixelIdsToSpans(
          item.texels.map((texel) => texel.pixelId),
          getSkinLayout(armType),
        ),
      },
      image,
    );
  }
  return { revisionId, image, semanticState };
}

interface ComponentFixture {
  readonly id: string;
  readonly category: SemanticCategory;
  readonly texels: readonly SurfaceTexel[];
}

function component(
  id: string,
  category: SemanticCategory,
  texels: readonly SurfaceTexel[],
): ComponentFixture {
  return { id, category, texels };
}

function texel(
  armType: ArmType,
  surface: SurfaceKey,
  localU: number,
  localV: number,
): SurfaceTexel {
  const match = buildSurfaceTexels(
    createRgbaImage(64, 64),
    getSkinLayout(armType),
  ).find(
    (candidate) =>
      candidate.surface === surface &&
      candidate.localU === localU &&
      candidate.localV === localV,
  );
  if (!match) throw new Error(`Missing fixture texel ${surface}:${localU},${localV}`);
  return match;
}

function paint(image: RgbaImage, texels: readonly SurfaceTexel[], rgba: Rgba): void {
  for (const item of texels) setPixel(image, item.atlasX, item.atlasY, rgba);
}

function findCandidate(
  candidates: readonly RestorationCandidate[],
  kind: RestorationCandidate["kind"],
): RestorationCandidate {
  const candidate = candidates.find((item) => item.kind === kind);
  if (!candidate) throw new Error(`Missing candidate kind ${kind}`);
  return candidate;
}
