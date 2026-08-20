import {
  buildSurfaceTexels,
  createRgbaImage,
  getPixelOrigin,
  getSkinLayout,
  type Rgba,
} from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
  COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION,
  HOST_COMPLETION_STRATEGIES,
  computeCompletionPixelMetrics,
  evaluateCompletionCandidateOrdering,
  evaluateSyntheticCompletionFixture,
  runCompletionEvaluationSuite,
  runHostCompletionEvaluator,
  runHostCompletionEvaluatorV1,
  type CompletionSyntheticFixture,
} from "../src";

describe("M21 synthetic Completion evaluation", () => {
  it("passes only the occluded snapshot to the evaluator", () => {
    const hiddenSentinel: Rgba = [251, 13, 197, 255];
    const fixture: CompletionSyntheticFixture = {
      id: "privacy_hidden_truth",
      description: "Hidden truth isolation regression",
      armType: "slim",
      targetLayer: "base",
      traits: ["asymmetric"],
      targetCategory: "upper_clothing",
      occluderCategory: "hair",
      representation: "skin_texel",
      expectedOutcome: "candidates",
      targetPixels: [
        {
          surface: "torso.base.front",
          localU: 1,
          localV: 2,
          rgba: [20, 40, 60, 255],
        },
        {
          surface: "torso.base.front",
          localU: 2,
          localV: 2,
          rgba: hiddenSentinel,
        },
      ],
      occlusions: [{
        target: { surface: "torso.base.front", localU: 2, localV: 2 },
        occluder: { surface: "torso.outer.front", localU: 2, localV: 2 },
        rgba: [7, 8, 9, 255],
      }],
    };
    const hiddenTexel = buildSurfaceTexels(
      createRgbaImage(64, 64),
      getSkinLayout("slim"),
    ).find((texel) =>
      texel.surface === "torso.base.front" &&
      texel.localU === 2 &&
      texel.localV === 2
    )!;
    let evaluatorCalled = false;
    const result = evaluateSyntheticCompletionFixture(fixture, (input) => {
      evaluatorCalled = true;
      expect(Object.keys(input).sort()).toEqual([
        "occludingComponentIds",
        "proposalId",
        "representation",
        "source",
        "targetComponentId",
      ]);
      expect(input.proposalId).not.toContain(fixture.id);
      expect(input.source.sourceRevisionId).not.toContain(fixture.id);
      expect(input.source.sourceRevisionId).not.toContain("truth");
      const inputPixels = Array.from({ length: 64 * 64 }, (_, pixelId) => {
        const offset = pixelId * 4;
        return [
          input.source.image.data[offset],
          input.source.image.data[offset + 1],
          input.source.image.data[offset + 2],
          input.source.image.data[offset + 3],
        ];
      });
      expect(inputPixels).not.toContainEqual(hiddenSentinel);
      expect(input.source.image.data.slice(
        hiddenTexel.pixelId * 4,
        hiddenTexel.pixelId * 4 + 4,
      )).toEqual(new Uint8Array([0, 0, 0, 0]));
      expect(input.source.semanticState.masks["outfit.eval_target"]![
        hiddenTexel.pixelId
      ]).toBe(0);
      expect(getPixelOrigin(
        input.source.originDocument,
        hiddenTexel.pixelId,
      )).toBeUndefined();
      const proposal = runHostCompletionEvaluator(input);
      expect(proposal.algorithmVersion).toBe(
        COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION,
      );
      return proposal;
    });

    expect(evaluatorCalled).toBe(true);
    expect(result.outcome).toBe("evaluated");
    expect(result.hiddenTruthPixelCount).toBe(1);
  });

  it("computes mask bounds, coverage, precision and color metrics explicitly", () => {
    const metrics = computeCompletionPixelMetrics({
      allowedPixelIds: [1, 2, 3],
      hiddenTruthPixels: [
        { pixelId: 1, rgba: [10, 10, 10, 255] },
        { pixelId: 2, rgba: [10, 10, 10, 255] },
        { pixelId: 3, rgba: [30, 30, 30, 255] },
      ],
      generatedPixels: [
        { pixelId: 1, rgba: [10, 10, 10, 255] },
        { pixelId: 2, rgba: [20, 20, 20, 255] },
        { pixelId: 4, rgba: [40, 40, 40, 255] },
      ],
    });

    expect(metrics).toEqual({
      generatedPixelCount: 3,
      generatedMaskOutOfBoundPixelCount: 1,
      generatedMaskOutOfBoundRate: 1 / 3,
      hiddenTruthPixelCount: 3,
      hiddenPixelCoverageCount: 2,
      hiddenPixelRecall: 2 / 3,
      truePositivePixelCount: 2,
      falsePositivePixelCount: 1,
      pixelPrecision: 2 / 3,
      colorComparedPixelCount: 2,
      colorComparedChannelCount: 8,
      colorAbsoluteErrorTotal: 30,
      meanAbsoluteColorError: 3.75,
      exactColorMatchPixelCount: 1,
      exactColorMatchRate: 0.5,
    });
  });

  it("produces a deterministic matrix report from strategies the Host emits", () => {
    const first = runCompletionEvaluationSuite(
      DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
    );
    const second = runCompletionEvaluationSuite(
      DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
    );
    const legacy = runCompletionEvaluationSuite(
      DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
      { evaluator: runHostCompletionEvaluatorV1 },
    );

    expect(second).toEqual(first);
    expect(first.hostAlgorithmVersion).toBe("completion-candidates-v2");
    expect(legacy.hostAlgorithmVersion).toBe("completion-candidates-v1");
    expect(legacy.aggregate).toEqual({
      candidateCount: 27,
      generatedMaskOutOfBoundRate: 0,
      positiveFixtureOracleCoverage: 8 / 9,
      negativeSafetyRate: 2 / 3,
      aiRankingFixtureCoverage: 0,
      aiTop1OracleAcceptableRate: null,
      aiMeanReciprocalRank: null,
      fixtureMatrixComplete: true,
    });
    expect(legacy.offlineGateStatus).toBe("fail");
    expect(legacy.criteria.find(
      (criterion) => criterion.id === "host_algorithm_version",
    )).toMatchObject({ status: "failed" });
    expect(first.aggregate.candidateCount).toBe(16);
    expect(first.aggregate.positiveFixtureOracleCoverage).toBe(
      legacy.aggregate.positiveFixtureOracleCoverage,
    );
    expect(first.aggregate.negativeSafetyRate).toBe(1);
    expect(first.offlineGateStatus).toBe("pass");
    expect(first.criteria.find(
      (criterion) => criterion.id === "host_algorithm_version",
    )).toMatchObject({ status: "passed" });
    expect(first.aggregate.fixtureMatrixComplete).toBe(true);
    for (const strategy of HOST_COMPLETION_STRATEGIES) {
      expect(first.strategies[strategy].fixtureEmissionCount).toBeGreaterThan(0);
    }
    expect(first.aggregate.generatedMaskOutOfBoundRate).toBe(0);
    expect(first.releaseGateStatus).toBe("fail");
    expect(first.criteria.find((criterion) => criterion.id === "ai_ranking_coverage"))
      .toMatchObject({ status: "not_evaluated" });
    expect(first.criteria.find((criterion) => criterion.id === "real_browser_e2e"))
      .toMatchObject({ status: "not_evaluated" });
  });

  it("uses visible transparent boundaries conservatively and keeps ambiguity explicit", () => {
    const report = runCompletionEvaluationSuite(
      DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
    );
    const noEvidence = fixtureResult(report, "wide_base_no_evidence");
    expect(noEvidence).toMatchObject({
      outcome: "evaluated",
      candidateCount: 0,
      expectationMet: true,
    });
    const unsupported = fixtureResult(report, "slim_base_unsupported");
    expect(unsupported).toMatchObject({
      outcome: "rejected",
      candidateCount: 0,
      expectationMet: true,
    });
    expect(unsupported.rejectionMessage).toMatch(/Unsupported Completion occlusion/u);

    const transparent = fixtureResult(report, "slim_base_transparent_only");
    expect(transparent).toMatchObject({
      candidateCount: 0,
      expectationMet: true,
    });
    expect(report.aggregate.negativeSafetyRate).toBe(1);

    const mixed = fixtureResult(report, "wide_base_transparent_mixed");
    expect(mixed.candidateCount).toBeGreaterThan(0);
    expect(mixed.oracleCandidateAvailable).toBe(false);

    const unsupportedFixture = DEFAULT_COMPLETION_SYNTHETIC_FIXTURES.find(
      (fixture) => fixture.id === "slim_base_unsupported",
    )!;
    const evaluatorCrash = evaluateSyntheticCompletionFixture(
      unsupportedFixture,
      () => {
        throw new RangeError("unrelated evaluator failure");
      },
    );
    expect(evaluatorCrash).toMatchObject({
      outcome: "rejected",
      expectationMet: false,
    });
  });

  it("scores only exact Host candidate-ID orderings", () => {
    const report = runCompletionEvaluationSuite(
      DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
    );
    const fixture = report.fixtures.find((item) =>
      item.candidates.some((candidate) => candidate.oracleAcceptable)
    )!;
    const rankedCandidateIds = [...fixture.candidates]
      .sort((left, right) =>
        Number(right.oracleAcceptable) - Number(left.oracleAcceptable)
      )
      .map((candidate) => candidate.candidateId);
    const ordering = evaluateCompletionCandidateOrdering({
      fixture,
      rankedCandidateIds,
    });
    expect(ordering).toMatchObject({
      fixtureId: fixture.fixtureId,
      candidateCount: fixture.candidateCount,
      top1OracleAcceptable: true,
      firstOracleAcceptableRank: 1,
      reciprocalRank: 1,
    });
    expect(() => evaluateCompletionCandidateOrdering({
      fixture,
      rankedCandidateIds: [
        ...rankedCandidateIds.slice(0, -1),
        "completioncandidate_not_from_host",
      ],
    })).toThrow(/exact Host candidate-ID permutation/u);
    expect(() => runCompletionEvaluationSuite(
      DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
      { rankedCandidateIdsByFixture: { not_a_fixture: [] } },
    )).toThrow(/not a rankable positive Host fixture/u);
  });
});

function fixtureResult(
  report: ReturnType<typeof runCompletionEvaluationSuite>,
  fixtureId: string,
) {
  const result = report.fixtures.find((fixture) => fixture.fixtureId === fixtureId);
  if (!result) throw new Error(`Missing fixture result ${fixtureId}`);
  return result;
}
