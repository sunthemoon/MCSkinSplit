import { createHash } from "node:crypto";
import { canonicalCompletionJson } from "@mc-skin-split/skin-core";

export const COMPLETION_AI_RANKING_EVIDENCE_SCHEMA_VERSION = "1.0" as const;
export const COMPLETION_BROWSER_EVIDENCE_SCHEMA_VERSION = "1.0" as const;
export const COMPLETION_BROWSER_SUITE_VERSION =
  "completion-player-browser-release-v1" as const;

export const COMPLETION_BROWSER_REQUIRED_TEST_IDS = [
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > keeps Completion absent and makes no Completion request when the flag is off",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > exposes the gated four-step workspace without horizontal overflow",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > supports native hash navigation and keyboard activation",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > runs semantic recognition through the deterministic replay provider",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > supports player semantic selection, Host IDs, overlays, and one relation commit",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > generates and accepts a review-only Completion candidate",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > creates a manual derived candidate, accepts it, and publishes the latent Part",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > shows an explicit zero-candidate result and can keep the source",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > rejects a Completion proposal while retaining the original result",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > releases replaced Blob URLs across upload and Revision switching",
  "tests/e2e/player-workspace.spec.ts::M20 deterministic player browser gate > touch input can choose evidence and start candidate generation",
] as const;

export interface CompletionEvaluationRankingExpectation {
  readonly fixtureId: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly evidenceHash: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly candidateIds: readonly string[];
  readonly candidateHashes: readonly string[];
}

export interface CompletionEvaluationRankingDocument {
  readonly schemaVersion: "1.0";
  readonly jobId: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly rankings: readonly {
    readonly candidateId: string;
    readonly confidence: number;
    readonly explanation: string;
  }[];
  readonly recommendation: {
    readonly status: "recommend" | "defer";
    readonly candidateId: string | null;
    readonly confidence: number;
    readonly explanation: string;
  };
}

export interface CompletionAiRankingEvidenceAttempt {
  readonly attempt: number;
  readonly packInputHash: string;
  readonly packManifestHash: string;
  readonly rawEventsHash: string;
  readonly stderrHash: string;
  readonly validationReportHash: string;
  readonly valid: boolean;
}

export interface CompletionAiRankingEvidenceFixture {
  readonly fixtureId: string;
  readonly jobId: string;
  readonly packInputHash: string;
  readonly packManifestHash: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly evidenceHash: string;
  readonly sourceRevisionId: string;
  readonly sourceResultHash: string;
  readonly sourceSkinHash: string;
  readonly candidateIds: readonly string[];
  readonly candidateHashes: readonly string[];
  readonly document: CompletionEvaluationRankingDocument;
  readonly rankingHash: string;
  readonly attempts: readonly CompletionAiRankingEvidenceAttempt[];
}

export interface CompletionAiRankingEvidenceDocument {
  readonly schemaVersion: typeof COMPLETION_AI_RANKING_EVIDENCE_SCHEMA_VERSION;
  readonly evaluationSchemaVersion: string;
  readonly hostAlgorithmVersion: string;
  readonly matrixHash: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly promptVersion: string;
  readonly validatorVersion: string;
  readonly codexCliVersion: string;
  readonly generatedAt: string;
  readonly fixtures: readonly CompletionAiRankingEvidenceFixture[];
  readonly evidenceHash: string;
}

export interface CompletionBrowserEvidenceTest {
  readonly id: string;
  readonly status: "passed" | "failed" | "skipped" | "timed_out" | "interrupted";
  readonly durationMs: number;
  readonly retries: number;
}

export interface CompletionBrowserEvidenceDocument {
  readonly schemaVersion: typeof COMPLETION_BROWSER_EVIDENCE_SCHEMA_VERSION;
  readonly suiteVersion: typeof COMPLETION_BROWSER_SUITE_VERSION;
  readonly mode: "deterministic-replay";
  readonly browserName: "chromium";
  readonly playwrightVersion: string;
  readonly sourceHash: string;
  readonly sourceFileCount: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: "passed" | "failed";
  readonly tests: readonly CompletionBrowserEvidenceTest[];
  readonly evidenceHash: string;
}

export interface CompletionAiRankingEvidenceSummary {
  readonly evidenceHash: string;
  readonly matrixHash: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: CompletionAiRankingEvidenceDocument["reasoningEffort"];
  readonly promptVersion: string;
  readonly validatorVersion: string;
  readonly codexCliVersion: string;
  readonly generatedAt: string;
  readonly fixtureCount: number;
}

export interface CompletionBrowserEvidenceSummary {
  readonly evidenceHash: string;
  readonly sourceHash: string;
  readonly sourceFileCount: number;
  readonly playwrightVersion: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly testCount: number;
}

export function createCompletionRankingMatrixHash(
  expectations: readonly CompletionEvaluationRankingExpectation[],
): string {
  const ordered = [...expectations]
    .sort((left, right) => compareString(left.fixtureId, right.fixtureId))
    .map((expectation) => ({
      fixtureId: expectation.fixtureId,
      proposalId: expectation.proposalId,
      proposalHash: expectation.proposalHash,
      evidenceHash: expectation.evidenceHash,
      sourceRevisionId: expectation.sourceRevisionId,
      sourceResultHash: expectation.sourceResultHash,
      sourceSkinHash: expectation.sourceSkinHash,
      candidateIds: [...expectation.candidateIds],
      candidateHashes: [...expectation.candidateHashes],
    }));
  return hashCanonical({
    schemaVersion: COMPLETION_AI_RANKING_EVIDENCE_SCHEMA_VERSION,
    fixtures: ordered,
  });
}

export function finalizeCompletionAiRankingEvidence(
  input: Omit<CompletionAiRankingEvidenceDocument, "evidenceHash">,
): CompletionAiRankingEvidenceDocument {
  const clone = structuredClone(input);
  return { ...clone, evidenceHash: hashCanonical(clone) };
}

export function finalizeCompletionBrowserEvidence(
  input: Omit<CompletionBrowserEvidenceDocument, "evidenceHash">,
): CompletionBrowserEvidenceDocument {
  const clone = structuredClone(input);
  return { ...clone, evidenceHash: hashCanonical(clone) };
}

export function validateCompletionAiRankingEvidence(input: {
  readonly evidence: unknown;
  readonly evaluationSchemaVersion: string;
  readonly hostAlgorithmVersion: string;
  readonly expectations: readonly CompletionEvaluationRankingExpectation[];
}): {
  readonly rankingsByFixture: Readonly<Record<string, readonly string[]>>;
  readonly summary: CompletionAiRankingEvidenceSummary;
} {
  assertAiRankingEvidenceShape(input.evidence);
  const evidence = input.evidence;
  if (evidence.evidenceHash !== hashCanonical(withoutEvidenceHash(evidence))) {
    throw new RangeError("Completion AI ranking evidence hash is invalid");
  }
  if (evidence.evaluationSchemaVersion !== input.evaluationSchemaVersion) {
    throw new RangeError("Completion AI ranking evidence uses a stale evaluator schema");
  }
  if (evidence.hostAlgorithmVersion !== input.hostAlgorithmVersion) {
    throw new RangeError("Completion AI ranking evidence uses a stale Host algorithm");
  }
  const expectedMatrixHash = createCompletionRankingMatrixHash(input.expectations);
  if (evidence.matrixHash !== expectedMatrixHash) {
    throw new RangeError("Completion AI ranking evidence does not match the fixture matrix");
  }
  if (!Number.isFinite(Date.parse(evidence.generatedAt))) {
    throw new RangeError("Completion AI ranking evidence generatedAt is invalid");
  }
  assertUniqueStrings(
    evidence.fixtures.map((fixture) => fixture.fixtureId),
    "Completion AI ranking fixture",
  );
  const expectedById = new Map(
    input.expectations.map((expectation) => [expectation.fixtureId, expectation]),
  );
  if (
    evidence.fixtures.length !== input.expectations.length ||
    evidence.fixtures.some((fixture) => !expectedById.has(fixture.fixtureId))
  ) {
    throw new RangeError("Completion AI ranking evidence does not cover every rankable fixture");
  }

  const rankingsByFixture: Record<string, readonly string[]> = {};
  for (const fixture of evidence.fixtures) {
    const expected = expectedById.get(fixture.fixtureId)!;
    assertFixtureBinding(fixture, expected);
    assertRankingDocument(fixture);
    if (fixture.rankingHash !== completionRankingHash(fixture.document)) {
      throw new RangeError(
        `Completion AI ranking hash is invalid for ${fixture.fixtureId}`,
      );
    }
    if (
      fixture.attempts.length === 0 ||
      fixture.attempts.length > 4 ||
      !fixture.attempts.at(-1)?.valid ||
      fixture.attempts.slice(0, -1).some((attempt) => attempt.valid)
    ) {
      throw new RangeError(
        `Completion AI ranking attempt history is invalid for ${fixture.fixtureId}`,
      );
    }
    for (const [index, attempt] of fixture.attempts.entries()) {
      if (attempt.attempt !== index + 1) {
        throw new RangeError(
          `Completion AI ranking attempts are not contiguous for ${fixture.fixtureId}`,
        );
      }
      assertHash(attempt.packInputHash, "pack input hash");
      assertHash(attempt.packManifestHash, "pack manifest hash");
      assertHash(attempt.rawEventsHash, "raw events hash");
      assertHash(attempt.stderrHash, "stderr hash");
      assertHash(attempt.validationReportHash, "validation report hash");
    }
    const terminal = fixture.attempts.at(-1)!;
    if (
      fixture.packInputHash !== terminal.packInputHash ||
      fixture.packManifestHash !== terminal.packManifestHash
    ) {
      throw new RangeError(
        `Completion AI ranking terminal pack does not match ${fixture.fixtureId}`,
      );
    }
    rankingsByFixture[fixture.fixtureId] = fixture.document.rankings.map(
      (ranking) => ranking.candidateId,
    );
  }

  return {
    rankingsByFixture,
    summary: {
      evidenceHash: evidence.evidenceHash,
      matrixHash: evidence.matrixHash,
      provider: evidence.provider,
      model: evidence.model,
      reasoningEffort: evidence.reasoningEffort,
      promptVersion: evidence.promptVersion,
      validatorVersion: evidence.validatorVersion,
      codexCliVersion: evidence.codexCliVersion,
      generatedAt: evidence.generatedAt,
      fixtureCount: evidence.fixtures.length,
    },
  };
}

export function validateCompletionBrowserEvidence(input: {
  readonly evidence: unknown;
  readonly expectedSourceHash: string;
}): CompletionBrowserEvidenceSummary {
  assertBrowserEvidenceShape(input.evidence);
  const evidence = input.evidence;
  if (evidence.evidenceHash !== hashCanonical(withoutEvidenceHash(evidence))) {
    throw new RangeError("Completion browser evidence hash is invalid");
  }
  if (evidence.sourceHash !== input.expectedSourceHash) {
    throw new RangeError("Completion browser evidence does not match current sources");
  }
  if (!Number.isFinite(Date.parse(evidence.startedAt))) {
    throw new RangeError("Completion browser evidence startedAt is invalid");
  }
  const actualIds = evidence.tests.map((test) => test.id);
  assertUniqueStrings(actualIds, "Completion browser test");
  if (!sameExactSet(actualIds, COMPLETION_BROWSER_REQUIRED_TEST_IDS)) {
    throw new RangeError("Completion browser evidence did not run the complete release suite");
  }
  if (
    evidence.status !== "passed" ||
    evidence.tests.some((test) => test.status !== "passed" || test.retries !== 0)
  ) {
    throw new RangeError("Completion browser release suite did not pass cleanly");
  }
  return {
    evidenceHash: evidence.evidenceHash,
    sourceHash: evidence.sourceHash,
    sourceFileCount: evidence.sourceFileCount,
    playwrightVersion: evidence.playwrightVersion,
    startedAt: evidence.startedAt,
    durationMs: evidence.durationMs,
    testCount: evidence.tests.length,
  };
}

export function completionRankingHash(
  document: CompletionEvaluationRankingDocument,
): string {
  return sha256(new TextEncoder().encode(canonicalCompletionJson(document)));
}

export function canonicalCompletionEvidenceJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function assertFixtureBinding(
  fixture: CompletionAiRankingEvidenceFixture,
  expected: CompletionEvaluationRankingExpectation,
): void {
  const scalarMatches =
    fixture.proposalId === expected.proposalId &&
    fixture.proposalHash === expected.proposalHash &&
    fixture.evidenceHash === expected.evidenceHash &&
    fixture.sourceRevisionId === expected.sourceRevisionId &&
    fixture.sourceResultHash === expected.sourceResultHash &&
    fixture.sourceSkinHash === expected.sourceSkinHash;
  if (
    !scalarMatches ||
    !stringArraysEqual(fixture.candidateIds, expected.candidateIds) ||
    !stringArraysEqual(fixture.candidateHashes, expected.candidateHashes)
  ) {
    throw new RangeError(
      `Completion AI ranking fixture binding is invalid for ${fixture.fixtureId}`,
    );
  }
}

function assertRankingDocument(fixture: CompletionAiRankingEvidenceFixture): void {
  const document = fixture.document;
  if (
    document.schemaVersion !== "1.0" ||
    document.jobId !== fixture.jobId ||
    document.proposalId !== fixture.proposalId ||
    document.proposalHash !== fixture.proposalHash ||
    document.sourceRevisionId !== fixture.sourceRevisionId ||
    document.sourceResultHash !== fixture.sourceResultHash ||
    document.sourceSkinHash !== fixture.sourceSkinHash
  ) {
    throw new RangeError(
      `Completion AI ranking document identity is invalid for ${fixture.fixtureId}`,
    );
  }
  const rankedIds = document.rankings.map((ranking) => ranking.candidateId);
  if (!sameExactSet(rankedIds, fixture.candidateIds)) {
    throw new RangeError(
      `Completion AI ranking is not an exact Host permutation for ${fixture.fixtureId}`,
    );
  }
  for (const ranking of document.rankings) {
    if (
      !Number.isFinite(ranking.confidence) ||
      ranking.confidence < 0 ||
      ranking.confidence > 1 ||
      !ranking.explanation.trim()
    ) {
      throw new RangeError(
        `Completion AI ranking item is invalid for ${fixture.fixtureId}`,
      );
    }
  }
  const recommendation = document.recommendation;
  const validRecommendation = recommendation.status === "defer"
    ? recommendation.candidateId === null
    : recommendation.candidateId !== null &&
      recommendation.candidateId === rankedIds[0];
  if (
    !validRecommendation ||
    !Number.isFinite(recommendation.confidence) ||
    recommendation.confidence < 0 ||
    recommendation.confidence > 1 ||
    !recommendation.explanation.trim()
  ) {
    throw new RangeError(
      `Completion AI recommendation is invalid for ${fixture.fixtureId}`,
    );
  }
}

function assertAiRankingEvidenceShape(
  value: unknown,
): asserts value is CompletionAiRankingEvidenceDocument {
  if (!isRecord(value)) throw new TypeError("Completion AI ranking evidence must be an object");
  assertExactKeys(value, [
    "schemaVersion",
    "evaluationSchemaVersion",
    "hostAlgorithmVersion",
    "matrixHash",
    "provider",
    "model",
    "reasoningEffort",
    "promptVersion",
    "validatorVersion",
    "codexCliVersion",
    "generatedAt",
    "fixtures",
    "evidenceHash",
  ], "Completion AI ranking evidence");
  if (value.schemaVersion !== COMPLETION_AI_RANKING_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError("Completion AI ranking evidence schema is unsupported");
  }
  for (const key of [
    "evaluationSchemaVersion",
    "hostAlgorithmVersion",
    "provider",
    "model",
    "promptVersion",
    "validatorVersion",
    "codexCliVersion",
    "generatedAt",
  ] as const) {
    assertText(value[key], key);
  }
  assertHash(value.matrixHash, "matrix hash");
  assertHash(value.evidenceHash, "evidence hash");
  if (!["low", "medium", "high", "xhigh", "max"].includes(String(value.reasoningEffort))) {
    throw new TypeError("Completion AI ranking reasoning effort is invalid");
  }
  if (!Array.isArray(value.fixtures)) {
    throw new TypeError("Completion AI ranking fixtures must be an array");
  }
  for (const fixture of value.fixtures) assertAiFixtureShape(fixture);
}

function assertAiFixtureShape(
  value: unknown,
): asserts value is CompletionAiRankingEvidenceFixture {
  if (!isRecord(value)) throw new TypeError("Completion AI ranking fixture must be an object");
  assertExactKeys(value, [
    "fixtureId",
    "jobId",
    "packInputHash",
    "packManifestHash",
    "proposalId",
    "proposalHash",
    "evidenceHash",
    "sourceRevisionId",
    "sourceResultHash",
    "sourceSkinHash",
    "candidateIds",
    "candidateHashes",
    "document",
    "rankingHash",
    "attempts",
  ], "Completion AI ranking fixture");
  for (const key of ["fixtureId", "jobId", "proposalId", "sourceRevisionId"] as const) {
    assertText(value[key], key);
  }
  for (const key of [
    "packInputHash",
    "packManifestHash",
    "proposalHash",
    "evidenceHash",
    "sourceResultHash",
    "sourceSkinHash",
    "rankingHash",
  ] as const) {
    assertHash(value[key], key);
  }
  assertStringArray(value.candidateIds, "candidateIds");
  assertStringArray(value.candidateHashes, "candidateHashes");
  value.candidateHashes.forEach((hash) => assertHash(hash, "candidate hash"));
  assertRankingDocumentShape(value.document);
  if (!Array.isArray(value.attempts)) {
    throw new TypeError("Completion AI ranking attempts must be an array");
  }
  for (const attempt of value.attempts) assertAttemptShape(attempt);
}

function assertRankingDocumentShape(
  value: unknown,
): asserts value is CompletionEvaluationRankingDocument {
  if (!isRecord(value)) throw new TypeError("Completion ranking document must be an object");
  assertExactKeys(value, [
    "schemaVersion",
    "jobId",
    "proposalId",
    "proposalHash",
    "sourceRevisionId",
    "sourceResultHash",
    "sourceSkinHash",
    "rankings",
    "recommendation",
  ], "Completion ranking document");
  if (value.schemaVersion !== "1.0") throw new TypeError("Completion ranking document schema is invalid");
  for (const key of ["jobId", "proposalId", "sourceRevisionId"] as const) {
    assertText(value[key], key);
  }
  for (const key of ["proposalHash", "sourceResultHash", "sourceSkinHash"] as const) {
    assertHash(value[key], key);
  }
  if (!Array.isArray(value.rankings)) throw new TypeError("Completion rankings must be an array");
  for (const ranking of value.rankings) {
    if (!isRecord(ranking)) throw new TypeError("Completion ranking item must be an object");
    assertExactKeys(ranking, ["candidateId", "confidence", "explanation"], "Completion ranking item");
    assertText(ranking.candidateId, "candidateId");
    assertFiniteNumber(ranking.confidence, "confidence");
    assertText(ranking.explanation, "explanation");
  }
  if (!isRecord(value.recommendation)) throw new TypeError("Completion recommendation must be an object");
  assertExactKeys(value.recommendation, ["status", "candidateId", "confidence", "explanation"], "Completion recommendation");
  if (!(["recommend", "defer"] as const).includes(value.recommendation.status as "recommend" | "defer")) {
    throw new TypeError("Completion recommendation status is invalid");
  }
  if (value.recommendation.candidateId !== null) {
    assertText(value.recommendation.candidateId, "recommendation candidateId");
  }
  assertFiniteNumber(value.recommendation.confidence, "recommendation confidence");
  assertText(value.recommendation.explanation, "recommendation explanation");
}

function assertAttemptShape(
  value: unknown,
): asserts value is CompletionAiRankingEvidenceAttempt {
  if (!isRecord(value)) throw new TypeError("Completion ranking attempt must be an object");
  assertExactKeys(value, [
    "attempt",
    "packInputHash",
    "packManifestHash",
    "rawEventsHash",
    "stderrHash",
    "validationReportHash",
    "valid",
  ], "Completion ranking attempt");
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 1) {
    throw new TypeError("Completion ranking attempt number is invalid");
  }
  for (const key of [
    "packInputHash",
    "packManifestHash",
    "rawEventsHash",
    "stderrHash",
    "validationReportHash",
  ] as const) {
    assertHash(value[key], key);
  }
  if (typeof value.valid !== "boolean") throw new TypeError("Completion ranking attempt validity is invalid");
}

function assertBrowserEvidenceShape(
  value: unknown,
): asserts value is CompletionBrowserEvidenceDocument {
  if (!isRecord(value)) throw new TypeError("Completion browser evidence must be an object");
  assertExactKeys(value, [
    "schemaVersion",
    "suiteVersion",
    "mode",
    "browserName",
    "playwrightVersion",
    "sourceHash",
    "sourceFileCount",
    "startedAt",
    "durationMs",
    "status",
    "tests",
    "evidenceHash",
  ], "Completion browser evidence");
  if (
    value.schemaVersion !== COMPLETION_BROWSER_EVIDENCE_SCHEMA_VERSION ||
    value.suiteVersion !== COMPLETION_BROWSER_SUITE_VERSION ||
    value.mode !== "deterministic-replay" ||
    value.browserName !== "chromium"
  ) {
    throw new TypeError("Completion browser evidence contract is unsupported");
  }
  assertText(value.playwrightVersion, "playwrightVersion");
  assertHash(value.sourceHash, "browser source hash");
  assertHash(value.evidenceHash, "browser evidence hash");
  assertText(value.startedAt, "startedAt");
  assertNonNegativeInteger(value.sourceFileCount, "sourceFileCount", false);
  assertNonNegativeInteger(value.durationMs, "durationMs", true);
  if (value.status !== "passed" && value.status !== "failed") {
    throw new TypeError("Completion browser evidence status is invalid");
  }
  if (!Array.isArray(value.tests)) throw new TypeError("Completion browser tests must be an array");
  for (const test of value.tests) {
    if (!isRecord(test)) throw new TypeError("Completion browser test must be an object");
    assertExactKeys(test, ["id", "status", "durationMs", "retries"], "Completion browser test");
    assertText(test.id, "browser test id");
    if (![
      "passed",
      "failed",
      "skipped",
      "timed_out",
      "interrupted",
    ].includes(String(test.status))) {
      throw new TypeError("Completion browser test status is invalid");
    }
    assertNonNegativeInteger(test.durationMs, "browser test duration", true);
    assertNonNegativeInteger(test.retries, "browser test retries", true);
  }
}

function withoutEvidenceHash<T extends { readonly evidenceHash: string }>(
  value: T,
): Omit<T, "evidenceHash"> {
  const { evidenceHash: _evidenceHash, ...rest } = value;
  return rest;
}

function hashCanonical(value: unknown): string {
  return sha256(new TextEncoder().encode(canonicalCompletionEvidenceJson(value)));
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareString(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareString);
  const expected = [...keys].sort(compareString);
  if (!stringArraysEqual(actual, expected)) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be non-empty text`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 value`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be a string array`);
  }
  assertUniqueStrings(value, label);
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new RangeError(`${label} contains duplicate values`);
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
  allowZero: boolean,
): asserts value is number {
  if (
    !Number.isInteger(value) ||
    Number(value) < (allowZero ? 0 : 1)
  ) {
    throw new TypeError(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
}

function sameExactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((item) => right.includes(item));
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((item, index) => item === right[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
