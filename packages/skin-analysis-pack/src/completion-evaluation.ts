import { createHash } from "node:crypto";
import {
  applyManualSemanticOperation,
  buildSurfaceTexels,
  COMPLETION_CANDIDATE_ALGORITHM_V1,
  COMPLETION_CANDIDATE_ALGORITHM_V2,
  createInitialSemanticState,
  createRgbaImage,
  createSourceVisiblePixelOriginDocument,
  generateCompletionProposalCandidatesV1,
  generateCompletionProposalCandidatesV2,
  getPixelOrigin,
  getSkinLayout,
  maskToPixelIds,
  pixelIdsToSpans,
  setPixel,
  type ArmType,
  type CompletionCandidate,
  type CompletionCandidateAlgorithmVersion,
  type CompletionCandidateStrategy,
  type CompletionHashCanonical,
  type CompletionProposal,
  type CompletionRequestedRepresentation,
  type CompletionSourceSnapshot,
  type Layer,
  type PixelOriginDocument,
  type Rgba,
  type RgbaImage,
  type SemanticCategory,
  type SemanticState,
  type SurfaceKey,
  type SurfaceTexel,
} from "@mc-skin-split/skin-core";

export const COMPLETION_EVALUATION_SCHEMA_VERSION = "1.0" as const;
export const COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION =
  COMPLETION_CANDIDATE_ALGORITHM_V2;

export const HOST_COMPLETION_STRATEGIES = [
  "opposite_layer_underlay",
  "mirrored_counterpart",
  "same_surface_continuation",
  "opposite_surface_reference",
  "neighbor_reference",
  "pattern_continuation",
] as const satisfies readonly CompletionCandidateStrategy[];

export type HostCompletionStrategy =
  (typeof HOST_COMPLETION_STRATEGIES)[number];

export type CompletionSyntheticTrait =
  | "transparent"
  | "uv_seam"
  | "symmetric"
  | "asymmetric"
  | "whole_surface"
  | "unsupported"
  | "no_evidence";

export type CompletionSyntheticExpectedOutcome =
  | "candidates"
  | "zero_candidates"
  | "unsupported_error";

export interface CompletionSyntheticPixel {
  readonly surface: SurfaceKey;
  readonly localU: number;
  readonly localV: number;
  readonly rgba: Rgba;
}

export interface CompletionSyntheticOcclusion {
  readonly target: Pick<
    CompletionSyntheticPixel,
    "surface" | "localU" | "localV"
  >;
  readonly occluder: Pick<
    CompletionSyntheticPixel,
    "surface" | "localU" | "localV"
  >;
  readonly rgba: Rgba;
}

/**
 * A harness-side fixture definition. Hidden target colors live here and are
 * deliberately not part of CompletionEvaluationInput.
 */
export interface CompletionSyntheticFixture {
  readonly id: string;
  readonly description: string;
  readonly armType: ArmType;
  readonly targetLayer: Layer;
  readonly traits: readonly CompletionSyntheticTrait[];
  readonly targetCategory: SemanticCategory;
  readonly occluderCategory: SemanticCategory;
  readonly representation: CompletionRequestedRepresentation;
  readonly expectedOutcome: CompletionSyntheticExpectedOutcome;
  readonly targetPixels: readonly CompletionSyntheticPixel[];
  readonly occlusions: readonly CompletionSyntheticOcclusion[];
}

/** The sole value passed to a candidate generator during synthetic evaluation. */
export interface CompletionEvaluationInput {
  readonly source: CompletionSourceSnapshot;
  readonly proposalId: string;
  readonly targetComponentId: string;
  readonly occludingComponentIds: readonly string[];
  readonly representation: CompletionRequestedRepresentation;
}

export type CompletionEvaluator = (
  input: CompletionEvaluationInput,
) => CompletionProposal;

export interface CompletionPixelMetricInput {
  readonly generatedPixels: readonly {
    readonly pixelId: number;
    readonly rgba: Rgba;
  }[];
  readonly allowedPixelIds: readonly number[];
  readonly hiddenTruthPixels: readonly {
    readonly pixelId: number;
    readonly rgba: Rgba;
  }[];
}

export interface CompletionPixelMetrics {
  readonly generatedPixelCount: number;
  readonly generatedMaskOutOfBoundPixelCount: number;
  readonly generatedMaskOutOfBoundRate: number;
  readonly hiddenTruthPixelCount: number;
  readonly hiddenPixelCoverageCount: number;
  readonly hiddenPixelRecall: number;
  readonly truePositivePixelCount: number;
  readonly falsePositivePixelCount: number;
  readonly pixelPrecision: number;
  readonly colorComparedPixelCount: number;
  readonly colorComparedChannelCount: number;
  readonly colorAbsoluteErrorTotal: number;
  readonly meanAbsoluteColorError: number | null;
  readonly exactColorMatchPixelCount: number;
  readonly exactColorMatchRate: number | null;
}

export interface CompletionCandidateEvaluation extends CompletionPixelMetrics {
  readonly candidateId: string;
  readonly strategy: HostCompletionStrategy;
  /** Deterministic hidden-truth oracle, never a claim about real users. */
  readonly oracleAcceptable: boolean;
}

export interface CompletionFixtureEvaluation {
  readonly fixtureId: string;
  readonly description: string;
  readonly armType: ArmType;
  readonly targetLayer: Layer;
  readonly traits: readonly CompletionSyntheticTrait[];
  readonly expectedOutcome: CompletionSyntheticExpectedOutcome;
  readonly outcome: "evaluated" | "rejected";
  readonly algorithmVersion: CompletionCandidateAlgorithmVersion | null;
  readonly representation: "skin_texel" | "latent_component" | null;
  readonly allowedGeneratedPixelCount: number;
  readonly hiddenTruthPixelCount: number;
  readonly candidateCount: number;
  readonly candidates: readonly CompletionCandidateEvaluation[];
  readonly emittedStrategies: readonly HostCompletionStrategy[];
  readonly rejectionMessage: string | null;
  readonly expectationMet: boolean;
  readonly oracleCandidateAvailable: boolean;
}

export interface CompletionStrategyAggregate {
  readonly strategy: HostCompletionStrategy;
  readonly fixtureEmissionCount: number;
  readonly candidateCount: number;
  readonly generatedPixelCount: number;
  readonly generatedMaskOutOfBoundPixelCount: number;
  readonly generatedMaskOutOfBoundRate: number;
  readonly hiddenTruthPixelCount: number;
  readonly hiddenPixelCoverageCount: number;
  readonly hiddenPixelRecall: number;
  readonly truePositivePixelCount: number;
  readonly falsePositivePixelCount: number;
  readonly pixelPrecision: number;
  readonly colorComparedPixelCount: number;
  readonly meanAbsoluteColorError: number | null;
  readonly exactColorMatchPixelCount: number;
  readonly exactColorMatchRate: number | null;
  readonly oracleAcceptableCount: number;
  readonly oracleAcceptableRate: number;
}

export interface CompletionOrderingEvaluation {
  readonly fixtureId: string;
  readonly rankedCandidateIds: readonly string[];
  readonly candidateCount: number;
  readonly oracleAcceptableCandidateCount: number;
  readonly top1OracleAcceptable: boolean;
  readonly firstOracleAcceptableRank: number | null;
  readonly reciprocalRank: number;
}

export interface CompletionGateCriterion {
  readonly id: string;
  readonly description: string;
  readonly actual: number | boolean | string | null;
  readonly requirement: string;
  readonly status: "passed" | "failed" | "not_evaluated";
}

export interface CompletionEvaluationReport {
  readonly schemaVersion: typeof COMPLETION_EVALUATION_SCHEMA_VERSION;
  readonly hostAlgorithmVersion: CompletionCandidateAlgorithmVersion | null;
  readonly fixtureCount: number;
  readonly positiveFixtureCount: number;
  readonly negativeFixtureCount: number;
  readonly fixtures: readonly CompletionFixtureEvaluation[];
  readonly strategies: Readonly<Record<
    HostCompletionStrategy,
    CompletionStrategyAggregate
  >>;
  readonly orderings: readonly CompletionOrderingEvaluation[];
  readonly aggregate: {
    readonly candidateCount: number;
    readonly generatedMaskOutOfBoundRate: number;
    readonly positiveFixtureOracleCoverage: number;
    readonly negativeSafetyRate: number;
    readonly aiRankingFixtureCoverage: number;
    readonly aiTop1OracleAcceptableRate: number | null;
    readonly aiMeanReciprocalRank: number | null;
    readonly fixtureMatrixComplete: boolean;
  };
  readonly offlineGateStatus: "pass" | "fail";
  readonly releaseGateStatus: "pass" | "fail";
  readonly criteria: readonly CompletionGateCriterion[];
}

/**
 * Candidate oracle thresholds are intentionally strict and independently
 * visible. They describe synthetic hidden-truth acceptability, not observed
 * user acceptance: no generated-mask escape, at least 95% pixel precision,
 * 75% hidden-pixel recall, 75% exact RGBA matches, and <=16 byte-level MAE.
 *
 * Aggregate release thresholds require complete matrix coverage, zero mask
 * escape, >=80% positive-fixture oracle coverage, 100% negative safety, real
 * ordering evidence for every rankable fixture with >=80% acceptable top-1,
 * and a separately supplied real-browser E2E pass.
 */
export const COMPLETION_EVALUATION_THRESHOLDS = Object.freeze({
  candidateOracle: Object.freeze({
    maximumGeneratedMaskOutOfBoundRate: 0,
    minimumPixelPrecision: 0.95,
    minimumHiddenPixelRecall: 0.75,
    maximumMeanAbsoluteColorError: 16,
    minimumExactColorMatchRate: 0.75,
  }),
  release: Object.freeze({
    maximumGeneratedMaskOutOfBoundRate: 0,
    minimumPositiveFixtureOracleCoverage: 0.8,
    minimumNegativeSafetyRate: 1,
    minimumAiRankingFixtureCoverage: 1,
    minimumAiTop1OracleAcceptableRate: 0.8,
    requireBrowserE2ePass: true,
  }),
});

export interface RunCompletionEvaluationOptions {
  /** Exact Host candidate-ID permutations produced by a real ranking run. */
  readonly rankedCandidateIdsByFixture?: Readonly<
    Record<string, readonly string[]>
  >;
  /** Must refer to the separate real-browser evidence, never a synthetic stub. */
  readonly browserE2ePassed?: boolean;
  readonly evaluator?: CompletionEvaluator;
}

interface PreparedCompletionCase {
  readonly input: CompletionEvaluationInput;
  readonly hiddenTruthPixels: readonly {
    readonly pixelId: number;
    readonly rgba: Rgba;
  }[];
}

const TARGET_COMPONENT_ID = "outfit.eval_target";
const OCCLUDER_COMPONENT_ID = "occluder.eval_visible";
const REQUIRED_MATRIX_TRAITS = [
  "transparent",
  "uv_seam",
  "symmetric",
  "asymmetric",
  "whole_surface",
  "unsupported",
  "no_evidence",
] as const satisfies readonly CompletionSyntheticTrait[];

const hashCanonical: CompletionHashCanonical = (canonicalJson) =>
  sha256(Buffer.from(canonicalJson, "utf8"));

export function runHostCompletionEvaluator(
  input: CompletionEvaluationInput,
): CompletionProposal {
  return runHostCompletionEvaluatorV2(input);
}

export function runHostCompletionEvaluatorV1(
  input: CompletionEvaluationInput,
): CompletionProposal {
  const proposal = generateCompletionProposalCandidatesV1({
    ...input.source,
    proposalId: input.proposalId,
    targetComponentId: input.targetComponentId,
    occludingComponentIds: input.occludingComponentIds,
    representation: input.representation,
    hashCanonical,
  });
  if (proposal.algorithmVersion !== COMPLETION_CANDIDATE_ALGORITHM_V1) {
    throw new RangeError("Completion v1 evaluator returned a different algorithm");
  }
  return proposal;
}

export function runHostCompletionEvaluatorV2(
  input: CompletionEvaluationInput,
): CompletionProposal {
  const proposal = generateCompletionProposalCandidatesV2({
    ...input.source,
    proposalId: input.proposalId,
    targetComponentId: input.targetComponentId,
    occludingComponentIds: input.occludingComponentIds,
    representation: input.representation,
    hashCanonical,
  });
  if (proposal.algorithmVersion !== COMPLETION_CANDIDATE_ALGORITHM_V2) {
    throw new RangeError("Completion v2 evaluator returned a different algorithm");
  }
  return proposal;
}

export function computeCompletionPixelMetrics(
  input: CompletionPixelMetricInput,
): CompletionPixelMetrics {
  const generated = uniquePixelMap(input.generatedPixels, "generatedPixels");
  const truth = uniquePixelMap(input.hiddenTruthPixels, "hiddenTruthPixels");
  const allowed = new Set(assertUniquePixelIds(input.allowedPixelIds, "allowedPixelIds"));
  let outOfBound = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let absoluteError = 0;
  let exactColorMatches = 0;
  for (const [pixelId, rgba] of generated) {
    if (!allowed.has(pixelId)) outOfBound += 1;
    const expected = truth.get(pixelId);
    if (!expected) {
      falsePositive += 1;
      continue;
    }
    truePositive += 1;
    let exact = true;
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = Math.abs(rgba[channel]! - expected[channel]!);
      absoluteError += difference;
      if (difference !== 0) exact = false;
    }
    if (exact) exactColorMatches += 1;
  }
  const generatedCount = generated.size;
  const truthCount = truth.size;
  const comparedChannels = truePositive * 4;
  return {
    generatedPixelCount: generatedCount,
    generatedMaskOutOfBoundPixelCount: outOfBound,
    generatedMaskOutOfBoundRate: ratio(outOfBound, generatedCount, 0),
    hiddenTruthPixelCount: truthCount,
    hiddenPixelCoverageCount: truePositive,
    hiddenPixelRecall: ratio(truePositive, truthCount, 1),
    truePositivePixelCount: truePositive,
    falsePositivePixelCount: falsePositive,
    pixelPrecision: ratio(truePositive, generatedCount, 1),
    colorComparedPixelCount: truePositive,
    colorComparedChannelCount: comparedChannels,
    colorAbsoluteErrorTotal: absoluteError,
    meanAbsoluteColorError:
      comparedChannels === 0 ? null : absoluteError / comparedChannels,
    exactColorMatchPixelCount: exactColorMatches,
    exactColorMatchRate:
      truePositive === 0 ? null : exactColorMatches / truePositive,
  };
}

export function evaluateCompletionCandidateOrdering(input: {
  readonly fixture: CompletionFixtureEvaluation;
  readonly rankedCandidateIds: readonly string[];
}): CompletionOrderingEvaluation {
  if (input.fixture.outcome !== "evaluated") {
    throw new RangeError(`Fixture ${input.fixture.fixtureId} has no Host candidates`);
  }
  const byId = new Map(
    input.fixture.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const ranked = [...input.rankedCandidateIds];
  if (
    ranked.length !== byId.size ||
    new Set(ranked).size !== ranked.length ||
    ranked.some((candidateId) => !byId.has(candidateId))
  ) {
    throw new RangeError(
      `Ranking for ${input.fixture.fixtureId} must be an exact Host candidate-ID permutation`,
    );
  }
  const firstOracleIndex = ranked.findIndex(
    (candidateId) => byId.get(candidateId)!.oracleAcceptable,
  );
  return {
    fixtureId: input.fixture.fixtureId,
    rankedCandidateIds: ranked,
    candidateCount: ranked.length,
    oracleAcceptableCandidateCount: input.fixture.candidates.filter(
      (candidate) => candidate.oracleAcceptable,
    ).length,
    top1OracleAcceptable:
      ranked.length > 0 && byId.get(ranked[0]!)!.oracleAcceptable,
    firstOracleAcceptableRank:
      firstOracleIndex < 0 ? null : firstOracleIndex + 1,
    reciprocalRank: firstOracleIndex < 0 ? 0 : 1 / (firstOracleIndex + 1),
  };
}

export function evaluateSyntheticCompletionFixture(
  fixture: CompletionSyntheticFixture,
  evaluator: CompletionEvaluator = runHostCompletionEvaluator,
): CompletionFixtureEvaluation {
  const prepared = prepareSyntheticCompletionCase(fixture);
  let proposal: CompletionProposal;
  try {
    proposal = evaluator(cloneEvaluationInput(prepared.input));
  } catch (error) {
    const rejectionMessage = error instanceof Error ? error.message : String(error);
    return {
      fixtureId: fixture.id,
      description: fixture.description,
      armType: fixture.armType,
      targetLayer: fixture.targetLayer,
      traits: [...fixture.traits],
      expectedOutcome: fixture.expectedOutcome,
      outcome: "rejected",
      algorithmVersion: null,
      representation: null,
      allowedGeneratedPixelCount: 0,
      hiddenTruthPixelCount: prepared.hiddenTruthPixels.length,
      candidateCount: 0,
      candidates: [],
      emittedStrategies: [],
      rejectionMessage,
      expectationMet:
        fixture.expectedOutcome === "unsupported_error" &&
        isUnsupportedCompletionError(error),
      oracleCandidateAvailable: false,
    };
  }
  const candidates = proposal.candidates.map((candidate) =>
    evaluateCandidate(candidate, proposal, prepared.hiddenTruthPixels)
  );
  const expectedCandidateState = fixture.expectedOutcome === "candidates"
    ? candidates.length > 0
    : fixture.expectedOutcome === "zero_candidates"
      ? candidates.length === 0
      : false;
  return {
    fixtureId: fixture.id,
    description: fixture.description,
    armType: fixture.armType,
    targetLayer: fixture.targetLayer,
    traits: [...fixture.traits],
    expectedOutcome: fixture.expectedOutcome,
    outcome: "evaluated",
    algorithmVersion: proposal.algorithmVersion,
    representation: proposal.representation,
    allowedGeneratedPixelCount: proposal.allowedGeneratedPixelCount,
    hiddenTruthPixelCount: prepared.hiddenTruthPixels.length,
    candidateCount: candidates.length,
    candidates,
    emittedStrategies: candidates.map((candidate) => candidate.strategy),
    rejectionMessage: null,
    expectationMet: expectedCandidateState,
    oracleCandidateAvailable: candidates.some(
      (candidate) => candidate.oracleAcceptable,
    ),
  };
}

export function runCompletionEvaluationSuite(
  fixtures: readonly CompletionSyntheticFixture[],
  options: RunCompletionEvaluationOptions = {},
): CompletionEvaluationReport {
  assertUniqueFixtureIds(fixtures);
  const evaluator = options.evaluator ?? runHostCompletionEvaluator;
  const fixtureResults = fixtures.map((fixture) =>
    evaluateSyntheticCompletionFixture(fixture, evaluator)
  );
  const evaluatedAlgorithmVersions = new Set(
    fixtureResults.flatMap((fixture) =>
      fixture.algorithmVersion === null ? [] : [fixture.algorithmVersion]
    ),
  );
  if (evaluatedAlgorithmVersions.size > 1) {
    throw new RangeError("Completion evaluation cannot mix Host algorithm versions");
  }
  const positive = fixtureResults.filter(
    (fixture) => fixture.expectedOutcome === "candidates",
  );
  const negative = fixtureResults.filter(
    (fixture) => fixture.expectedOutcome !== "candidates",
  );
  const strategies = Object.fromEntries(
    HOST_COMPLETION_STRATEGIES.map((strategy) => [
      strategy,
      aggregateStrategy(strategy, fixtureResults),
    ]),
  ) as Readonly<Record<HostCompletionStrategy, CompletionStrategyAggregate>>;
  const rankedByFixture = options.rankedCandidateIdsByFixture ?? {};
  const rankable = positive.filter((fixture) => fixture.candidateCount > 0);
  const rankableIds = new Set(rankable.map((fixture) => fixture.fixtureId));
  for (const fixtureId of Object.keys(rankedByFixture)) {
    if (!rankableIds.has(fixtureId)) {
      throw new RangeError(
        `AI ranking fixture ${fixtureId} is not a rankable positive Host fixture`,
      );
    }
  }
  const orderings = rankable.flatMap((fixture) => {
    const ranking = rankedByFixture[fixture.fixtureId];
    return ranking !== undefined
      ? [evaluateCompletionCandidateOrdering({ fixture, rankedCandidateIds: ranking })]
      : [];
  });
  const candidateEvaluations = fixtureResults.flatMap(
    (fixture) => fixture.candidates,
  );
  const totalGenerated = sum(candidateEvaluations, "generatedPixelCount");
  const totalOutOfBound = sum(
    candidateEvaluations,
    "generatedMaskOutOfBoundPixelCount",
  );
  const aggregate = {
    candidateCount: candidateEvaluations.length,
    generatedMaskOutOfBoundRate: ratio(totalOutOfBound, totalGenerated, 0),
    positiveFixtureOracleCoverage: ratio(
      positive.filter((fixture) => fixture.oracleCandidateAvailable).length,
      positive.length,
      0,
    ),
    negativeSafetyRate: ratio(
      negative.filter((fixture) => fixture.expectationMet).length,
      negative.length,
      0,
    ),
    aiRankingFixtureCoverage: ratio(orderings.length, rankable.length, 0),
    aiTop1OracleAcceptableRate: orderings.length === 0
      ? null
      : orderings.filter((ordering) => ordering.top1OracleAcceptable).length /
        orderings.length,
    aiMeanReciprocalRank: orderings.length === 0
      ? null
      : orderings.reduce((total, ordering) => total + ordering.reciprocalRank, 0) /
        orderings.length,
    fixtureMatrixComplete: matrixIsComplete(fixtures),
  };
  const criteria = gateCriteria(
    evaluatedAlgorithmVersions.values().next().value ?? null,
    aggregate,
    strategies,
    options.browserE2ePassed,
  );
  const offlineCriterionIds = new Set([
    "host_algorithm_version",
    "fixture_matrix",
    "required_strategy_emission",
    "generated_mask_bounds",
    "positive_oracle_coverage",
    "negative_safety",
  ]);
  return {
    schemaVersion: COMPLETION_EVALUATION_SCHEMA_VERSION,
    hostAlgorithmVersion:
      evaluatedAlgorithmVersions.values().next().value ?? null,
    fixtureCount: fixtureResults.length,
    positiveFixtureCount: positive.length,
    negativeFixtureCount: negative.length,
    fixtures: fixtureResults,
    strategies,
    orderings,
    aggregate,
    offlineGateStatus: criteria
      .filter((criterion) => offlineCriterionIds.has(criterion.id))
      .every((criterion) => criterion.status === "passed")
      ? "pass"
      : "fail",
    releaseGateStatus: criteria.every((criterion) => criterion.status === "passed")
      ? "pass"
      : "fail",
    criteria,
  };
}

function prepareSyntheticCompletionCase(
  fixture: CompletionSyntheticFixture,
): PreparedCompletionCase {
  assertSafeId(fixture.id, "fixture id");
  if (fixture.traits.length !== new Set(fixture.traits).size) {
    throw new RangeError(`Fixture ${fixture.id} has duplicate traits`);
  }
  const layout = getSkinLayout(fixture.armType);
  const texels = buildSurfaceTexels(createRgbaImage(64, 64), layout);
  const byCoordinate = new Map(
    texels.map((texel) => [coordinateKey(texel.surface, texel.localU, texel.localV), texel]),
  );
  const targetByPixel = new Map<number, Rgba>();
  const completeTexture = createRgbaImage(64, 64);
  for (const pixel of fixture.targetPixels) {
    const texel = fixtureTexel(pixel, byCoordinate, fixture.id);
    if (targetByPixel.has(texel.pixelId)) {
      throw new RangeError(`Fixture ${fixture.id} duplicates target pixel ${texel.pixelId}`);
    }
    const rgba = validatedRgba(pixel.rgba, `${fixture.id} target rgba`, true);
    targetByPixel.set(texel.pixelId, rgba);
    setPixel(completeTexture, texel.atlasX, texel.atlasY, rgba);
  }
  const hiddenTargetIds = new Set<number>();
  const occluderByPixel = new Map<number, Rgba>();
  for (const occlusion of fixture.occlusions) {
    const target = fixtureTexel(occlusion.target, byCoordinate, fixture.id);
    if (target.layer !== fixture.targetLayer) {
      throw new RangeError(
        `Fixture ${fixture.id} hidden target ${target.surface} is not on ${fixture.targetLayer}`,
      );
    }
    if (!targetByPixel.has(target.pixelId)) {
      throw new RangeError(
        `Fixture ${fixture.id} occludes undefined target pixel ${target.pixelId}`,
      );
    }
    hiddenTargetIds.add(target.pixelId);
    const occluder = fixtureTexel(occlusion.occluder, byCoordinate, fixture.id);
    if (occluderByPixel.has(occluder.pixelId)) {
      throw new RangeError(
        `Fixture ${fixture.id} duplicates occluder pixel ${occluder.pixelId}`,
      );
    }
    occluderByPixel.set(
      occluder.pixelId,
      validatedRgba(occlusion.rgba, `${fixture.id} occluder rgba`, false),
    );
  }
  const completeRevisionId = `truth_${fixture.id}`;
  const completeHash = sha256(completeTexture.data);
  const completeSemanticState = semanticState(
    completeRevisionId,
    fixture.armType,
    completeHash,
    completeTexture,
    [{
      id: TARGET_COMPONENT_ID,
      category: fixture.targetCategory,
      pixelIds: [...targetByPixel]
        .filter(([, rgba]) => rgba[3] > 0)
        .map(([pixelId]) => pixelId),
    }],
  );
  const completeOriginDocument = createSourceVisiblePixelOriginDocument({
    subject: { kind: "revision", id: completeRevisionId },
    armType: fixture.armType,
    image: completeTexture,
  });

  const occludedTexture = createRgbaImage(
    64,
    64,
    completeTexture.data.slice(),
  );
  for (const pixelId of hiddenTargetIds) {
    const texel = texels.find((candidate) => candidate.pixelId === pixelId)!;
    setPixel(occludedTexture, texel.atlasX, texel.atlasY, [0, 0, 0, 0]);
  }
  for (const [pixelId, rgba] of occluderByPixel) {
    const texel = texels.find((candidate) => candidate.pixelId === pixelId)!;
    setPixel(occludedTexture, texel.atlasX, texel.atlasY, rgba);
  }
  const sourceSkinHash = sha256(occludedTexture.data);
  const visibleTargetIds = [...targetByPixel]
    .filter(([pixelId, rgba]) => rgba[3] > 0 && !hiddenTargetIds.has(pixelId))
    .map(([pixelId]) => pixelId);
  const publicCaseToken = sha256(
    Buffer.from(JSON.stringify({
      schema: COMPLETION_EVALUATION_SCHEMA_VERSION,
      armType: fixture.armType,
      targetCategory: fixture.targetCategory,
      occluderCategory: fixture.occluderCategory,
      representation: fixture.representation,
      sourceSkinHash,
      visibleTargetIds: [...visibleTargetIds].sort((left, right) => left - right),
      occluderPixelIds: [...occluderByPixel.keys()].sort((left, right) => left - right),
    }), "utf8"),
  ).slice("sha256:".length, "sha256:".length + 24);
  const opaqueSourceRevisionId = `revision_eval_${publicCaseToken}`;
  const sourceSemanticState = semanticState(
    opaqueSourceRevisionId,
    fixture.armType,
    sourceSkinHash,
    occludedTexture,
    [
      ...(visibleTargetIds.length > 0
        ? [{
            id: TARGET_COMPONENT_ID,
            category: fixture.targetCategory,
            pixelIds: visibleTargetIds,
          }]
        : []),
      {
        id: OCCLUDER_COMPONENT_ID,
        category: fixture.occluderCategory,
        pixelIds: [...occluderByPixel.keys()],
      },
    ],
  );
  const source: CompletionSourceSnapshot = {
    sourceRevisionId: opaqueSourceRevisionId,
    sourceResultHash: sha256(Buffer.from(
      `completion-evaluation\0${publicCaseToken}\0${sourceSkinHash}`,
      "utf8",
    )),
    sourceSkinHash,
    image: occludedTexture,
    semanticState: sourceSemanticState,
    originDocument: createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: opaqueSourceRevisionId },
      armType: fixture.armType,
      image: occludedTexture,
    }),
  };
  const hiddenTruthPixels = hiddenTruthFromGroundTruth({
    fixtureId: fixture.id,
    hiddenTargetIds,
    completeTexture,
    completeSemanticState,
    completeOriginDocument,
  });
  return {
    input: {
      source,
      proposalId: `completioneval_${publicCaseToken}`,
      targetComponentId: TARGET_COMPONENT_ID,
      occludingComponentIds: [OCCLUDER_COMPONENT_ID],
      representation: fixture.representation,
    },
    hiddenTruthPixels,
  };
}

function hiddenTruthFromGroundTruth(input: {
  readonly fixtureId: string;
  readonly hiddenTargetIds: ReadonlySet<number>;
  readonly completeTexture: RgbaImage;
  readonly completeSemanticState: SemanticState;
  readonly completeOriginDocument: PixelOriginDocument;
}): Array<{ readonly pixelId: number; readonly rgba: Rgba }> {
  const targetMask = input.completeSemanticState.masks[TARGET_COMPONENT_ID];
  if (!targetMask) {
    throw new RangeError(`Fixture ${input.fixtureId} has no complete target truth`);
  }
  return [...input.hiddenTargetIds]
    .sort((left, right) => left - right)
    .flatMap((pixelId) => {
      const rgba = rgbaAt(input.completeTexture, pixelId);
      if (rgba[3] === 0) return [];
      if (targetMask[pixelId] !== 1) {
        throw new RangeError(
          `Fixture ${input.fixtureId} hidden pixel ${pixelId} is absent from semantic truth`,
        );
      }
      const origin = getPixelOrigin(input.completeOriginDocument, pixelId);
      if (origin?.intrinsicOrigin !== "source_visible") {
        throw new RangeError(
          `Fixture ${input.fixtureId} hidden pixel ${pixelId} is absent from origin truth`,
        );
      }
      return [{ pixelId, rgba }];
    });
}

function semanticState(
  revisionId: string,
  armType: ArmType,
  sourceHash: string,
  image: RgbaImage,
  components: readonly {
    readonly id: string;
    readonly category: SemanticCategory;
    readonly pixelIds: readonly number[];
  }[],
): SemanticState {
  let state = createInitialSemanticState({
    revisionId,
    armType,
    sourceHash,
    image,
  });
  for (const component of components) {
    if (component.pixelIds.length === 0) continue;
    state = applyManualSemanticOperation(
      state,
      {
        type: "assign_pixels",
        target: {
          instanceId: component.id,
          displayName: component.id,
          category: component.category,
        },
        spans: pixelIdsToSpans(component.pixelIds, getSkinLayout(armType)),
      },
      image,
    );
  }
  return state;
}

function cloneEvaluationInput(input: CompletionEvaluationInput): CompletionEvaluationInput {
  return {
    proposalId: input.proposalId,
    targetComponentId: input.targetComponentId,
    occludingComponentIds: [...input.occludingComponentIds],
    representation: input.representation,
    source: {
      sourceRevisionId: input.source.sourceRevisionId,
      sourceResultHash: input.source.sourceResultHash,
      sourceSkinHash: input.source.sourceSkinHash,
      image: createRgbaImage(64, 64, input.source.image.data.slice()),
      semanticState: {
        document: structuredClone(input.source.semanticState.document),
        masks: Object.fromEntries(
          Object.entries(input.source.semanticState.masks).map(([id, mask]) => [
            id,
            mask.slice(),
          ]),
        ),
        unknownMask: input.source.semanticState.unknownMask.slice(),
      },
      originDocument: structuredClone(input.source.originDocument),
    },
  };
}

function evaluateCandidate(
  candidate: CompletionCandidate,
  proposal: CompletionProposal,
  hiddenTruthPixels: CompletionPixelMetricInput["hiddenTruthPixels"],
): CompletionCandidateEvaluation {
  if (!isHostStrategy(candidate.strategy)) {
    throw new TypeError(`Synthetic Host evaluation excludes ${candidate.strategy}`);
  }
  const generatedPixels = maskToPixelIds(candidate.generatedMask).map((pixelId) => ({
    pixelId,
    rgba: rgbaAt(candidate.texture, pixelId),
  }));
  const metrics = computeCompletionPixelMetrics({
    generatedPixels,
    allowedPixelIds: proposal.allowedGeneratedPixelIds,
    hiddenTruthPixels,
  });
  return {
    candidateId: candidate.candidateId,
    strategy: candidate.strategy,
    ...metrics,
    oracleAcceptable: oracleAcceptable(metrics),
  };
}

function oracleAcceptable(metrics: CompletionPixelMetrics): boolean {
  const thresholds = COMPLETION_EVALUATION_THRESHOLDS.candidateOracle;
  if (metrics.hiddenTruthPixelCount === 0) {
    return metrics.generatedPixelCount === 0;
  }
  return (
    metrics.generatedMaskOutOfBoundRate <=
      thresholds.maximumGeneratedMaskOutOfBoundRate &&
    metrics.pixelPrecision >= thresholds.minimumPixelPrecision &&
    metrics.hiddenPixelRecall >= thresholds.minimumHiddenPixelRecall &&
    metrics.meanAbsoluteColorError !== null &&
    metrics.meanAbsoluteColorError <= thresholds.maximumMeanAbsoluteColorError &&
    metrics.exactColorMatchRate !== null &&
    metrics.exactColorMatchRate >= thresholds.minimumExactColorMatchRate
  );
}

function aggregateStrategy(
  strategy: HostCompletionStrategy,
  fixtures: readonly CompletionFixtureEvaluation[],
): CompletionStrategyAggregate {
  const candidates = fixtures.flatMap((fixture) =>
    fixture.candidates.filter((candidate) => candidate.strategy === strategy)
  );
  const fixtureEmissionCount = fixtures.filter((fixture) =>
    fixture.candidates.some((candidate) => candidate.strategy === strategy)
  ).length;
  const generated = sum(candidates, "generatedPixelCount");
  const outOfBound = sum(candidates, "generatedMaskOutOfBoundPixelCount");
  const truth = sum(candidates, "hiddenTruthPixelCount");
  const covered = sum(candidates, "hiddenPixelCoverageCount");
  const truePositive = sum(candidates, "truePositivePixelCount");
  const falsePositive = sum(candidates, "falsePositivePixelCount");
  const compared = sum(candidates, "colorComparedPixelCount");
  const comparedChannels = sum(candidates, "colorComparedChannelCount");
  const absoluteError = sum(candidates, "colorAbsoluteErrorTotal");
  const exact = sum(candidates, "exactColorMatchPixelCount");
  const oracleCount = candidates.filter((candidate) => candidate.oracleAcceptable).length;
  return {
    strategy,
    fixtureEmissionCount,
    candidateCount: candidates.length,
    generatedPixelCount: generated,
    generatedMaskOutOfBoundPixelCount: outOfBound,
    generatedMaskOutOfBoundRate: ratio(outOfBound, generated, 0),
    hiddenTruthPixelCount: truth,
    hiddenPixelCoverageCount: covered,
    hiddenPixelRecall: ratio(covered, truth, 1),
    truePositivePixelCount: truePositive,
    falsePositivePixelCount: falsePositive,
    pixelPrecision: ratio(truePositive, truePositive + falsePositive, 1),
    colorComparedPixelCount: compared,
    meanAbsoluteColorError:
      comparedChannels === 0 ? null : absoluteError / comparedChannels,
    exactColorMatchPixelCount: exact,
    exactColorMatchRate: compared === 0 ? null : exact / compared,
    oracleAcceptableCount: oracleCount,
    oracleAcceptableRate: ratio(oracleCount, candidates.length, 0),
  };
}

function gateCriteria(
  hostAlgorithmVersion: CompletionCandidateAlgorithmVersion | null,
  aggregate: CompletionEvaluationReport["aggregate"],
  strategies: CompletionEvaluationReport["strategies"],
  browserE2ePassed: boolean | undefined,
): CompletionGateCriterion[] {
  const release = COMPLETION_EVALUATION_THRESHOLDS.release;
  const requiredStrategiesEmitted = HOST_COMPLETION_STRATEGIES.every(
    (strategy) => strategies[strategy].fixtureEmissionCount > 0,
  );
  return [
    criterion(
      "host_algorithm_version",
      "The release evaluation uses the conservative side-by-side Host algorithm",
      hostAlgorithmVersion,
      COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION,
      hostAlgorithmVersion === COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION,
      hostAlgorithmVersion === null,
    ),
    criterion(
      "fixture_matrix",
      "Wide/Slim, Base/Outer and all required positive/negative traits are represented",
      aggregate.fixtureMatrixComplete,
      "true",
      aggregate.fixtureMatrixComplete,
    ),
    criterion(
      "required_strategy_emission",
      "Every current Host strategy is emitted from real fixture evidence",
      requiredStrategiesEmitted,
      "true",
      requiredStrategiesEmitted,
    ),
    criterion(
      "generated_mask_bounds",
      "Aggregate generated-mask pixels remain inside the Host allowed mask",
      aggregate.generatedMaskOutOfBoundRate,
      `<= ${release.maximumGeneratedMaskOutOfBoundRate}`,
      aggregate.generatedMaskOutOfBoundRate <=
        release.maximumGeneratedMaskOutOfBoundRate,
    ),
    criterion(
      "positive_oracle_coverage",
      "Positive fixtures expose at least one synthetically oracle-acceptable Host candidate",
      aggregate.positiveFixtureOracleCoverage,
      `>= ${release.minimumPositiveFixtureOracleCoverage}`,
      aggregate.positiveFixtureOracleCoverage >=
        release.minimumPositiveFixtureOracleCoverage,
    ),
    criterion(
      "negative_safety",
      "Negative fixtures produce the expected zero-candidate or rejection outcome",
      aggregate.negativeSafetyRate,
      `>= ${release.minimumNegativeSafetyRate}`,
      aggregate.negativeSafetyRate >= release.minimumNegativeSafetyRate,
    ),
    criterion(
      "ai_ranking_coverage",
      "Recorded AI rankings cover every rankable fixture using exact Host candidate IDs",
      aggregate.aiRankingFixtureCoverage,
      `>= ${release.minimumAiRankingFixtureCoverage}`,
      aggregate.aiRankingFixtureCoverage >= release.minimumAiRankingFixtureCoverage,
      aggregate.aiRankingFixtureCoverage === 0,
    ),
    criterion(
      "ai_top1_oracle",
      "Recorded AI top-ranked Host candidates meet the synthetic oracle threshold",
      aggregate.aiTop1OracleAcceptableRate,
      `>= ${release.minimumAiTop1OracleAcceptableRate}`,
      aggregate.aiTop1OracleAcceptableRate !== null &&
        aggregate.aiTop1OracleAcceptableRate >=
          release.minimumAiTop1OracleAcceptableRate,
      aggregate.aiTop1OracleAcceptableRate === null,
    ),
    criterion(
      "real_browser_e2e",
      "The separate real-browser player Completion E2E gate passed",
      browserE2ePassed ?? null,
      "true",
      browserE2ePassed === true,
      browserE2ePassed === undefined,
    ),
  ];
}

function criterion(
  id: string,
  description: string,
  actual: number | boolean | string | null,
  requirement: string,
  passed: boolean,
  notEvaluated = false,
): CompletionGateCriterion {
  return {
    id,
    description,
    actual,
    requirement,
    status: notEvaluated ? "not_evaluated" : passed ? "passed" : "failed",
  };
}

function matrixIsComplete(fixtures: readonly CompletionSyntheticFixture[]): boolean {
  const armTypes = new Set(fixtures.map((fixture) => fixture.armType));
  const targetLayers = new Set(fixtures.map((fixture) => fixture.targetLayer));
  const traits = new Set(fixtures.flatMap((fixture) => fixture.traits));
  const hasPositive = fixtures.some((fixture) => fixture.expectedOutcome === "candidates");
  const hasNegative = fixtures.some((fixture) => fixture.expectedOutcome !== "candidates");
  return (
    armTypes.has("wide") &&
    armTypes.has("slim") &&
    targetLayers.has("base") &&
    targetLayers.has("outer") &&
    REQUIRED_MATRIX_TRAITS.every((trait) => traits.has(trait)) &&
    hasPositive &&
    hasNegative
  );
}

function uniquePixelMap(
  values: CompletionPixelMetricInput["generatedPixels"],
  label: string,
): Map<number, Rgba> {
  const result = new Map<number, Rgba>();
  for (const value of values) {
    assertPixelId(value.pixelId, label);
    if (result.has(value.pixelId)) {
      throw new RangeError(`${label} contains duplicate pixel ${value.pixelId}`);
    }
    result.set(value.pixelId, validatedRgba(value.rgba, label, false));
  }
  return result;
}

function assertUniquePixelIds(values: readonly number[], label: string): number[] {
  const result = [...values];
  const unique = new Set<number>();
  for (const pixelId of result) {
    assertPixelId(pixelId, label);
    if (unique.has(pixelId)) {
      throw new RangeError(`${label} contains duplicate pixel ${pixelId}`);
    }
    unique.add(pixelId);
  }
  return result;
}

function assertUniqueFixtureIds(fixtures: readonly CompletionSyntheticFixture[]): void {
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    assertSafeId(fixture.id, "fixture id");
    if (ids.has(fixture.id)) {
      throw new RangeError(`Duplicate Completion evaluation fixture ${fixture.id}`);
    }
    ids.add(fixture.id);
  }
}

function fixtureTexel(
  pixel: Pick<CompletionSyntheticPixel, "surface" | "localU" | "localV">,
  byCoordinate: ReadonlyMap<string, SurfaceTexel>,
  fixtureId: string,
): SurfaceTexel {
  const texel = byCoordinate.get(
    coordinateKey(pixel.surface, pixel.localU, pixel.localV),
  );
  if (!texel) {
    throw new RangeError(
      `Fixture ${fixtureId} references invalid texel ${coordinateKey(
        pixel.surface,
        pixel.localU,
        pixel.localV,
      )}`,
    );
  }
  return texel;
}

function validatedRgba(value: Rgba, label: string, allowTransparent: boolean): Rgba {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((channel) =>
      !Number.isInteger(channel) || channel < 0 || channel > 255
    ) ||
    (!allowTransparent && value[3] === 0)
  ) {
    throw new RangeError(`${label} must contain four valid RGBA bytes`);
  }
  return [value[0], value[1], value[2], value[3]];
}

function rgbaAt(image: RgbaImage, pixelId: number): Rgba {
  const offset = pixelId * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

function isHostStrategy(
  strategy: CompletionCandidateStrategy,
): strategy is HostCompletionStrategy {
  return HOST_COMPLETION_STRATEGIES.includes(strategy as HostCompletionStrategy);
}

function isUnsupportedCompletionError(error: unknown): boolean {
  return error instanceof RangeError &&
    /^Unsupported Completion occlusion:/u.test(error.message);
}

function coordinateKey(surface: SurfaceKey, localU: number, localV: number): string {
  return `${surface}:${localU}:${localV}`;
}

function assertSafeId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]{2,80}$/u.test(value)) {
    throw new RangeError(`${label} is not a safe deterministic ID: ${value}`);
  }
}

function assertPixelId(pixelId: number, label: string): void {
  if (!Number.isInteger(pixelId) || pixelId < 0 || pixelId >= 64 * 64) {
    throw new RangeError(`${label} contains invalid pixel ${pixelId}`);
  }
}

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator === 0 ? empty : numerator / denominator;
}

function sum<T extends object, Key extends keyof T>(
  values: readonly T[],
  key: Key,
): number {
  return values.reduce((total, value) => total + Number(value[key]), 0);
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
