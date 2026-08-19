import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_COMPLETION_ALLOWED_PIXELS,
  MAX_COMPLETION_CANDIDATE_PIXELS,
  MAX_COMPLETION_OCCLUDING_COMPONENTS,
  MAX_COMPLETION_PIXEL_EDITS,
  MAX_COMPLETION_PROPOSAL_CANDIDATES,
  applyCompletionDecision,
  applyCompletionSemanticDelta,
  applyManualSemanticOperation,
  buildSurfaceTexels,
  canonicalCompletionJson,
  completionProposalDocument,
  createCompletionDecision,
  createInitialSemanticState,
  createRgbaImage,
  createSourceVisiblePixelOriginDocument,
  editCompletionCandidate,
  generateCompletionProposalCandidates,
  getPixel,
  getPixelOrigin,
  getSkinLayout,
  materializeCompletionProposalDocument,
  maskToPixelIds,
  pixelIdsToSpans,
  setPixel,
  synchronizeSemanticPixelOriginSummaries,
  validateCompletionCandidate,
  validateCompletionCandidateHashes,
  validateCompletionDecisionHash,
  validateCompletionProposalHashes,
  validateCompletionProposalSource,
  validatePixelOriginDocument,
  validateSemanticState,
  type ArmType,
  type CompletionCandidate,
  type CompletionHashCanonical,
  type CompletionProposal,
  type CompletionSourceSnapshot,
  type Rgba,
  type RgbaImage,
  type SemanticCategory,
  type SemanticState,
  type SurfaceKey,
  type SurfaceTexel,
} from "../src";

const hashCanonical: CompletionHashCanonical = (canonical) =>
  `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
const SOURCE_HASH = `sha256:${"1".repeat(64)}`;
const RESULT_HASH = `sha256:${"2".repeat(64)}`;

describe("hidden-content Completion domain", () => {
  it("resolves auto to safe skin texels and returns a complete semantic/origin delta", () => {
    const fixture = skinTexelFixture();
    const proposal = generate(fixture.source, {
      proposalId: "completionproposal_skin",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
    });

    expect(proposal.requestedRepresentation).toBe("auto");
    expect(proposal.representation).toBe("skin_texel");
    expect(proposal.allowedGeneratedPixelIds).toEqual(
      fixture.hidden.map((item) => item.pixelId).sort(numberCompare),
    );
    expect(maskToPixelIds(proposal.allowedGeneratedMask)).toEqual(
      proposal.allowedGeneratedPixelIds,
    );
    const candidate = findCandidate(proposal, "same_surface_continuation");
    expect(candidate.complete).toBe(true);
    expect(candidate.reviewRequired).toBe(true);
    expect(candidate.automaticAcceptanceAllowed).toBe(false);
    expect(candidate.assignments.every((item) => item.originMode === "generated_completion"))
      .toBe(true);
    expect(maskToPixelIds(candidate.generatedMask)).toEqual(candidate.pixelIds);

    const sourceBytes = fixture.source.image.data.slice();
    const decision = acceptDecision(proposal, candidate);
    const transformed = applyCompletionDecision({
      proposal,
      candidate,
      decision,
      sourceImage: fixture.source.image,
      sourceSemanticState: fixture.source.semanticState,
      sourceOriginDocument: fixture.source.originDocument,
      resultSubject: { kind: "revision", id: "rev_completion_skin" },
    });
    expect(transformed.status).toBe("accepted");
    if (transformed.status !== "accepted" || transformed.result.kind !== "skin_texel") {
      throw new Error("Expected skin_texel result");
    }
    expect(fixture.source.image.data).toEqual(sourceBytes);
    for (const item of fixture.hidden) {
      expect(getPixel(transformed.result.image, item.atlasX, item.atlasY)).toEqual(
        [31, 61, 91, 255],
      );
      expect(getPixelOrigin(transformed.result.originDocument, item.pixelId)).toMatchObject({
        intrinsicOrigin: "generated_completion",
        evidence: {
          candidateId: candidate.candidateId,
          decisionId: decision.decisionId,
        },
      });
    }
    validatePixelOriginDocument(
      transformed.result.originDocument,
      transformed.result.image,
    );

    const semanticState = applyCompletionSemanticDelta({
      sourceState: fixture.source.semanticState,
      sourceImage: fixture.source.image,
      resultImage: transformed.result.image,
      resultRevisionId: "rev_completion_skin",
      resultSkinHash: `sha256:${"3".repeat(64)}`,
      originDocument: transformed.result.originDocument,
      delta: transformed.result.semanticDelta,
    });
    validateSemanticState(
      semanticState,
      transformed.result.image,
      getSkinLayout("slim"),
    );
    expect(maskToPixelIds(semanticState.masks["outfit.main"]!)).toEqual(
      [fixture.visibleTarget.pixelId, ...fixture.hidden.map((item) => item.pixelId)].sort(
        numberCompare,
      ),
    );
    expect(maskToPixelIds(semanticState.masks["hair.long"]!)).toEqual(
      fixture.occluders.map((item) => item.pixelId).sort(numberCompare),
    );
  });

  it("limits latent pixels to target-supported body/layer groups and keeps the full target variant", () => {
    const image = createRgbaImage(64, 64);
    const visibleTarget = texel("slim", "torso.outer.front", 2, 2);
    const hiddenTorso = texel("slim", "torso.outer.back", 2, 2);
    const unrelatedHead = texel("slim", "head.outer.front", 2, 2);
    paint(image, [visibleTarget], [120, 30, 50, 255]);
    paint(image, [hiddenTorso, unrelatedHead], [15, 20, 25, 255]);
    const source = semanticSource("rev_latent", image, [
      component("outfit.outer", "upper_clothing", [visibleTarget]),
      component("hair.long", "hair", [hiddenTorso, unrelatedHead]),
    ]);
    const proposal = generate(source, {
      proposalId: "completionproposal_latent",
      targetComponentId: "outfit.outer",
      occludingComponentIds: ["hair.long"],
      representation: "latent_component",
    });

    expect(proposal.allowedGeneratedPixelIds).toEqual([hiddenTorso.pixelId]);
    expect(proposal.allowedGeneratedPixelIds).not.toContain(unrelatedHead.pixelId);
    const candidate = findCandidate(proposal, "opposite_surface_reference");
    expect(candidate.pixelIds).toEqual([hiddenTorso.pixelId]);
    const decision = acceptDecision(proposal, candidate);
    const sourceBytes = image.data.slice();
    const transformed = applyCompletionDecision({
      proposal,
      candidate,
      decision,
      sourceImage: image,
      sourceSemanticState: source.semanticState,
      sourceOriginDocument: source.originDocument,
      resultSubject: { kind: "part", id: "part_completion_latent" },
    });
    expect(transformed.status).toBe("accepted");
    if (transformed.status !== "accepted" || transformed.result.kind !== "latent_component") {
      throw new Error("Expected latent_component result");
    }
    expect(image.data).toEqual(sourceBytes);
    expect(transformed.sourceSkinChanged).toBe(false);
    expect(transformed.result.pixelIds).toEqual(
      [visibleTarget.pixelId, hiddenTorso.pixelId].sort(numberCompare),
    );
    expect(maskToPixelIds(transformed.result.writeMask)).toEqual(
      transformed.result.pixelIds,
    );
    expect(getPixel(transformed.result.texture, visibleTarget.atlasX, visibleTarget.atlasY))
      .toEqual([120, 30, 50, 255]);
    expect(getPixel(transformed.result.texture, hiddenTorso.atlasX, hiddenTorso.atlasY))
      .toEqual([120, 30, 50, 255]);
    expect(getPixelOrigin(transformed.result.originDocument, visibleTarget.pixelId))
      .toMatchObject({
        intrinsicOrigin: "source_visible",
        copyLineage: {
          sourceSubject: { kind: "revision", id: "rev_latent" },
          sourceComponentInstanceId: "outfit.outer",
          sourcePixelId: visibleTarget.pixelId,
        },
      });
    expect(getPixelOrigin(transformed.result.originDocument, hiddenTorso.pixelId))
      .toMatchObject({ intrinsicOrigin: "generated_completion" });
    expect(maskToPixelIds(transformed.result.generatedMask)).toEqual([
      hiddenTorso.pixelId,
    ]);
    validatePixelOriginDocument(
      transformed.result.originDocument,
      transformed.result.texture,
    );
  });

  it("marks only actual candidate edits manual and preserves generated assignments", () => {
    const fixture = skinTexelFixture();
    const proposal = generate(fixture.source, {
      proposalId: "completionproposal_manual",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "skin_texel",
    });
    const base = findCandidate(proposal, "same_surface_continuation");
    const [changedPixelId, unchangedPixelId] = base.pixelIds;
    const edited = editCompletionCandidate({
      proposal,
      candidateId: base.candidateId,
      edits: [
        { type: "set_pixel", pixelId: changedPixelId!, rgba: [9, 8, 7, 255] },
        {
          type: "set_pixel",
          pixelId: unchangedPixelId!,
          rgba: base.assignments.find((item) => item.targetPixelId === unchangedPixelId)!.rgba,
        },
      ],
      actor: { type: "user", id: "player" },
      operationId: "op_completion_edit",
      hashCanonical,
    });
    expect(edited.confidence).toBe("manual");
    expect(edited.assignments.find((item) => item.targetPixelId === changedPixelId))
      .toMatchObject({ originMode: "manual_authored" });
    expect(edited.assignments.find((item) => item.targetPixelId === unchangedPixelId))
      .toMatchObject({ originMode: "generated_completion" });
    expect(maskToPixelIds(edited.generatedMask)).toEqual([unchangedPixelId]);

    const forgedAiAuthorship = {
      ...edited,
      assignments: edited.assignments.map((assignment) =>
        assignment.originMode === "manual_authored"
          ? { ...assignment, manualActor: { type: "ai" as const } }
          : assignment
      ),
    };
    expect(() =>
      validateCompletionCandidate(proposal, forgedAiAuthorship, fixture.source)
    ).toThrow(/explicit user actor/u);

    const decision = acceptDecision(proposal, edited, true);
    const transformed = applyCompletionDecision({
      proposal,
      candidate: edited,
      decision,
      sourceImage: fixture.source.image,
      sourceSemanticState: fixture.source.semanticState,
      sourceOriginDocument: fixture.source.originDocument,
      resultSubject: { kind: "revision", id: "rev_completion_manual" },
    });
    if (transformed.status !== "accepted") throw new Error("Expected acceptance");
    expect(getPixelOrigin(transformed.result.originDocument, changedPixelId!))
      .toMatchObject({ intrinsicOrigin: "manual_authored" });
    expect(getPixelOrigin(transformed.result.originDocument, unchangedPixelId!))
      .toMatchObject({ intrinsicOrigin: "generated_completion" });
  });

  it("keeps sampled hidden texels generated while recording immediate copy lineage", () => {
    const image = createRgbaImage(64, 64);
    const visibleMirror = texel("slim", "torso.base.front", 6, 2);
    const hidden = texel("slim", "torso.base.front", 1, 2);
    const occluder = texel("slim", "torso.outer.front", 1, 2);
    paint(image, [visibleMirror], [70, 80, 90, 255]);
    paint(image, [occluder], [3, 4, 5, 255]);
    const source = semanticSource("rev_sampled", image, [
      component("outfit.main", "upper_clothing", [visibleMirror]),
      component("hair.long", "hair", [occluder]),
    ]);
    const proposal = generate(source, {
      proposalId: "completionproposal_sampled",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "skin_texel",
    });
    const candidate = findCandidate(proposal, "mirrored_counterpart");
    expect(candidate.assignments[0]).toMatchObject({
      targetPixelId: hidden.pixelId,
      originMode: "generated_completion_with_copy",
      sourcePixelId: visibleMirror.pixelId,
    });
    const decision = acceptDecision(proposal, candidate);
    const transformed = applyCompletionDecision({
      proposal,
      candidate,
      decision,
      sourceImage: image,
      sourceSemanticState: source.semanticState,
      sourceOriginDocument: source.originDocument,
      resultSubject: { kind: "revision", id: "rev_completion_sampled" },
    });
    if (transformed.status !== "accepted") throw new Error("Expected acceptance");
    expect(getPixelOrigin(transformed.result.originDocument, hidden.pixelId)).toMatchObject({
      intrinsicOrigin: "generated_completion",
      copyLineage: {
        sourceSubject: { kind: "revision", id: "rev_sampled" },
        sourceComponentInstanceId: "outfit.main",
        sourcePixelId: visibleMirror.pixelId,
      },
    });
    expect(maskToPixelIds(transformed.result.generatedMask)).toEqual([hidden.pixelId]);
  });

  it("creates a proposal-level deterministic rejection with no candidate transformation", () => {
    const fixture = skinTexelFixture();
    const proposal = generate(fixture.source, {
      proposalId: "completionproposal_reject",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
    });
    const decision = createCompletionDecision({
      proposal,
      action: "reject",
      actor: { type: "user", id: "player" },
      expectedSourceResultHash: proposal.sourceResultHash,
      expectedProposalHash: proposal.proposalHash,
      expectedProposalEvidenceHash: proposal.evidenceHash,
      hashCanonical,
    });
    expect(decision).toMatchObject({
      action: "reject",
      candidateId: null,
      candidateHash: null,
      candidateEvidenceHash: null,
      automatic: false,
    });
    expect(
      createCompletionDecision({
        proposal,
        action: "reject",
        actor: { type: "user", id: "player" },
        expectedSourceResultHash: proposal.sourceResultHash,
        expectedProposalHash: proposal.proposalHash,
        expectedProposalEvidenceHash: proposal.evidenceHash,
        hashCanonical,
      }).decisionId,
    ).toBe(decision.decisionId);
    const sourceBytes = fixture.source.image.data.slice();
    const transformed = applyCompletionDecision({
      proposal,
      decision,
      sourceImage: fixture.source.image,
      sourceSemanticState: fixture.source.semanticState,
      sourceOriginDocument: fixture.source.originDocument,
    });
    expect(transformed).toMatchObject({
      status: "rejected",
      sourceSkinChanged: false,
      result: null,
    });
    expect(fixture.source.image.data).toEqual(sourceBytes);
  });

  it("keeps content hashes reusable while scoping identities to a caller proposal", () => {
    const fixture = skinTexelFixture();
    const first = generate(fixture.source, {
      proposalId: "completionproposal_retry_a",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
    });
    const second = generate(fixture.source, {
      proposalId: "completionproposal_retry_b",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
    });
    expect(first.proposalHash).toBe(second.proposalHash);
    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(first.proposalId).not.toBe(second.proposalId);
    expect(first.candidates.map((item) => item.candidateHash)).toEqual(
      second.candidates.map((item) => item.candidateHash),
    );
    expect(first.candidates.map((item) => item.candidateId)).not.toEqual(
      second.candidates.map((item) => item.candidateId),
    );
  });

  it("round-trips canonical documents without trusting materialized masks", () => {
    const fixture = skinTexelFixture();
    const proposal = generate(fixture.source, {
      proposalId: "completionproposal_document",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
    });
    const parsed = JSON.parse(canonicalCompletionJson(proposal)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("allowedGeneratedMask");
    expect((parsed.candidates as Record<string, unknown>[])[0]).not.toHaveProperty(
      "texture",
    );
    const materialized = materializeCompletionProposalDocument(
      completionProposalDocument(proposal),
    );
    expect(materialized.allowedGeneratedMask).toEqual(proposal.allowedGeneratedMask);
    expect(materialized.candidates[0]!.texture.data).toEqual(
      proposal.candidates[0]!.texture.data,
    );
    validateCompletionProposalSource(materialized, fixture.source);
    validateCompletionProposalHashes(materialized, hashCanonical);
    validateCompletionCandidateHashes(
      materialized,
      materialized.candidates[0]!,
      hashCanonical,
    );
    validateCompletionDecisionHash(
      acceptDecision(materialized, materialized.candidates[0]!),
      hashCanonical,
    );
    const tampered: CompletionCandidate = {
      ...materialized.candidates[0]!,
      assignments: materialized.candidates[0]!.assignments.map((assignment, index) =>
        index === 0 ? { ...assignment, rgba: [1, 1, 1, 255] } : assignment,
      ),
    };
    expect(() =>
      validateCompletionCandidateHashes(materialized, tampered, hashCanonical),
    ).toThrow(/hash/i);
    expect(() => canonicalCompletionJson({ mask: new Uint8Array(4096) })).toThrow(
      /excludes Uint8Array/i,
    );
  });

  it("exports and enforces explicit proposal, candidate, component, and edit caps", () => {
    const fixture = skinTexelFixture();
    expect(() =>
      generate(fixture.source, {
        proposalId: "completionproposal_occluder_overflow",
        targetComponentId: "outfit.main",
        occludingComponentIds: Array.from(
          { length: MAX_COMPLETION_OCCLUDING_COMPONENTS + 1 },
          (_, index) => `hair.fake_${index}`,
        ),
        representation: "auto",
      }),
    ).toThrow(new RegExp(String(MAX_COMPLETION_OCCLUDING_COMPONENTS)));

    const proposal = generate(fixture.source, {
      proposalId: "completionproposal_caps",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
    });
    const candidate = proposal.candidates[0]!;
    expect(() =>
      editCompletionCandidate({
        proposal,
        candidateId: candidate.candidateId,
        edits: Array.from(
          { length: MAX_COMPLETION_PIXEL_EDITS + 1 },
          () => ({ type: "remove_pixel" as const, pixelId: candidate.pixelIds[0]! }),
        ),
        actor: { type: "user" },
        operationId: "op_edit_overflow",
        hashCanonical,
      }),
    ).toThrow(new RegExp(String(MAX_COMPLETION_PIXEL_EDITS)));

    const tooManyCandidates: CompletionProposal = {
      ...proposal,
      candidates: Array.from(
        { length: MAX_COMPLETION_PROPOSAL_CANDIDATES + 1 },
        () => candidate,
      ),
    };
    expect(() => validateCompletionProposalSource(tooManyCandidates, fixture.source))
      .toThrow(new RegExp(String(MAX_COMPLETION_PROPOSAL_CANDIDATES)));

    const tooManyAssignments: CompletionCandidate = {
      ...candidate,
      assignments: Array.from(
        { length: MAX_COMPLETION_CANDIDATE_PIXELS + 1 },
        () => candidate.assignments[0]!,
      ),
    };
    expect(() => validateCompletionCandidate(proposal, tooManyAssignments, fixture.source))
      .toThrow(new RegExp(String(MAX_COMPLETION_CANDIDATE_PIXELS)));

    const tooManyAllowed: CompletionProposal = {
      ...proposal,
      allowedGeneratedPixelCount: MAX_COMPLETION_ALLOWED_PIXELS + 1,
    };
    expect(() => validateCompletionProposalSource(tooManyAllowed, fixture.source))
      .toThrow(new RegExp(String(MAX_COMPLETION_ALLOWED_PIXELS)));
  });

  it("allows a deterministic empty proposal when no body/layer range is justified", () => {
    const image = createRgbaImage(64, 64);
    const target = texel("slim", "torso.base.front", 0, 0);
    const occluder = texel("slim", "head.outer.front", 0, 0);
    paint(image, [target], [1, 2, 3, 255]);
    paint(image, [occluder], [4, 5, 6, 255]);
    const source = semanticSource("rev_empty", image, [
      component("outfit.main", "upper_clothing", [target]),
      component("hair.long", "hair", [occluder]),
    ]);
    const proposal = generate(source, {
      proposalId: "completionproposal_empty",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "skin_texel",
    });
    expect(proposal.allowedGeneratedPixelCount).toBe(0);
    expect(proposal.candidates).toEqual([]);
  });

  it("does not treat an empty Outer texel above a Base occluder as hidden content", () => {
    const image = createRgbaImage(64, 64);
    const visibleOuterTarget = texel("slim", "torso.outer.front", 0, 2);
    const baseOccluder = texel("slim", "torso.base.front", 1, 2);
    paint(image, [visibleOuterTarget], [20, 30, 40, 255]);
    paint(image, [baseOccluder], [50, 60, 70, 255]);
    const source = semanticSource("rev_reverse_layer", image, [
      component("outfit.main", "upper_clothing", [visibleOuterTarget]),
      component("hair.long", "hair", [baseOccluder]),
    ]);

    const proposal = generate(source, {
      proposalId: "completionproposal_reverse_layer",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "skin_texel",
    });

    expect(proposal.allowedGeneratedPixelCount).toBe(0);
    expect(proposal.allowedGeneratedPixelIds).toEqual([]);
    expect(proposal.candidates).toEqual([]);
  });

  it("limits Completion to clothing behind hair/accessories or hair behind accessories", () => {
    const image = createRgbaImage(64, 64);
    const target = texel("slim", "head.base.front", 1, 1);
    const occluder = texel("slim", "head.outer.front", 1, 1);
    paint(image, [target], [20, 30, 40, 255]);
    paint(image, [occluder], [50, 60, 70, 255]);

    const faceSource = semanticSource("rev_face_completion", image, [
      component("eye.left", "eye", [target]),
      component("hair.long", "hair", [occluder]),
    ]);
    expect(() =>
      generate(faceSource, {
        proposalId: "completionproposal_face",
        targetComponentId: "eye.left",
        occludingComponentIds: ["hair.long"],
        representation: "auto",
      }),
    ).toThrow(/limited to hair and clothing/i);

    const hairSource = semanticSource("rev_hair_completion", image, [
      component("hair.long", "hair", [target]),
      component("skin.face", "skin", [occluder]),
    ]);
    expect(() =>
      generate(hairSource, {
        proposalId: "completionproposal_skin_occluder",
        targetComponentId: "hair.long",
        occludingComponentIds: ["skin.face"],
        representation: "auto",
      }),
    ).toThrow(/unsupported completion occlusion/i);
  });

  it("rejects stale hashes and non-user acceptance even for low-confidence candidates", () => {
    const fixture = skinTexelFixture();
    const proposal = generate(fixture.source, {
      proposalId: "completionproposal_stale",
      targetComponentId: "outfit.main",
      occludingComponentIds: ["hair.long"],
      representation: "auto",
    });
    const low = findCandidate(proposal, "neighbor_reference");
    expect(low.confidence).toBe("low");
    expect(() =>
      createCompletionDecision({
        proposal,
        candidateId: low.candidateId,
        action: "accept",
        actor: { type: "system" },
        expectedSourceResultHash: proposal.sourceResultHash,
        expectedProposalHash: proposal.proposalHash,
        expectedProposalEvidenceHash: proposal.evidenceHash,
        expectedCandidateHash: low.candidateHash,
        hashCanonical,
      }),
    ).toThrow(/explicit user/i);
    expect(() =>
      createCompletionDecision({
        proposal,
        candidateId: low.candidateId,
        action: "accept",
        actor: { type: "user" },
        expectedSourceResultHash: `sha256:${"f".repeat(64)}`,
        expectedProposalHash: proposal.proposalHash,
        expectedProposalEvidenceHash: proposal.evidenceHash,
        expectedCandidateHash: low.candidateHash,
        hashCanonical,
      }),
    ).toThrow(/stale/i);
  });
});

function skinTexelFixture(): {
  readonly source: CompletionSourceSnapshot;
  readonly visibleTarget: SurfaceTexel;
  readonly hidden: readonly SurfaceTexel[];
  readonly occluders: readonly SurfaceTexel[];
} {
  const image = createRgbaImage(64, 64);
  const visibleTarget = texel("slim", "torso.base.front", 0, 2);
  const hidden = [
    texel("slim", "torso.base.front", 1, 2),
    texel("slim", "torso.base.front", 2, 2),
  ];
  const occluders = [
    texel("slim", "torso.outer.front", 1, 2),
    texel("slim", "torso.outer.front", 2, 2),
  ];
  paint(image, [visibleTarget], [31, 61, 91, 255]);
  paint(image, occluders, [8, 18, 28, 255]);
  return {
    source: semanticSource("rev_skin", image, [
      component("outfit.main", "upper_clothing", [visibleTarget]),
      component("hair.long", "hair", occluders),
    ]),
    visibleTarget,
    hidden,
    occluders,
  };
}

function semanticSource(
  revisionId: string,
  image: RgbaImage,
  components: readonly ComponentFixture[],
): CompletionSourceSnapshot {
  let semanticState: SemanticState = createInitialSemanticState({
    revisionId,
    armType: "slim",
    sourceHash: SOURCE_HASH,
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
          getSkinLayout("slim"),
        ),
      },
      image,
    );
  }
  const originDocument = createSourceVisiblePixelOriginDocument({
    subject: { kind: "revision", id: revisionId },
    armType: "slim",
    image,
  });
  semanticState = synchronizeSemanticPixelOriginSummaries(
    semanticState,
    originDocument,
    image,
  );
  return {
    sourceRevisionId: revisionId,
    sourceResultHash: RESULT_HASH,
    sourceSkinHash: SOURCE_HASH,
    image,
    semanticState,
    originDocument,
  };
}

function generate(
  source: CompletionSourceSnapshot,
  input: {
    readonly proposalId: string;
    readonly targetComponentId: string;
    readonly occludingComponentIds: readonly string[];
    readonly representation: "auto" | "skin_texel" | "latent_component";
  },
): CompletionProposal {
  return generateCompletionProposalCandidates({
    ...source,
    ...input,
    hashCanonical,
  });
}

function acceptDecision(
  proposal: CompletionProposal,
  candidate: CompletionCandidate,
  detached = false,
) {
  return createCompletionDecision({
    proposal,
    candidateId: candidate.candidateId,
    ...(detached ? { candidate } : {}),
    action: "accept",
    actor: { type: "user", id: "player" },
    expectedSourceResultHash: proposal.sourceResultHash,
    expectedProposalHash: proposal.proposalHash,
    expectedProposalEvidenceHash: proposal.evidenceHash,
    expectedCandidateHash: candidate.candidateHash,
    hashCanonical,
  });
}

function findCandidate(
  proposal: CompletionProposal,
  strategy: CompletionCandidate["strategy"],
): CompletionCandidate {
  const candidate = proposal.candidates.find((item) => item.strategy === strategy);
  if (!candidate) throw new Error(`Missing Completion candidate ${strategy}`);
  return candidate;
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

function numberCompare(left: number, right: number): number {
  return left - right;
}
