import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  COMPLETION_AI_RANKING_EVIDENCE_SCHEMA_VERSION,
  COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION,
  COMPLETION_EVALUATION_SCHEMA_VERSION,
  COMPLETION_RANKING_PROMPT_VERSION,
  DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
  buildCompletionRankingPack,
  canonicalCompletionEvidenceJson,
  completionRankingHash,
  createCompletionEvaluationPublicCase,
  createCompletionRankingMatrixHash,
  finalizeCompletionAiRankingEvidence,
  validateCompletionAiRankingEvidence,
  verifyCompletionRankingPackIntegrity,
  type CompletionAiRankingEvidenceAttempt,
  type CompletionAiRankingEvidenceFixture,
  type CompletionEvaluationPublicCase,
  type CompletionEvaluationRankingExpectation,
} from "@mc-skin-split/skin-analysis-pack";
import {
  COMPLETION_RANKING_SCHEMA,
  COMPLETION_RANKING_VALIDATOR_VERSION,
  CodexExecProvider,
  executeCommand,
  validateCompletionRankingProposal,
  type CompletionRankingValidationReport,
} from "../src/index";
import type { AnalysisReasoningEffort } from "@mc-skin-split/skin-analysis-pack";

const TEMP_PREFIX = "mcskinsplit-m21-ranking-";
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_OUTPUT = "docs/evidence/m21/ai-ranking-evidence.json";

const options = parseArguments(
  process.argv.slice(2).filter((argument) => argument !== "--"),
);
const outputPath = resolve(REPO_ROOT, options.output);
const tempParent = await realpath(resolve(tmpdir()));
const temporaryRoot = await mkdtemp(join(tempParent, TEMP_PREFIX));
const resolvedTemporaryRoot = await realpath(temporaryRoot);
validateTemporaryRoot(resolvedTemporaryRoot, tempParent);

try {
  const provider = new CodexExecProvider({
    command: options.command,
    defaultModel: options.model,
    timeoutMs: options.timeoutMs,
  });
  if (!provider.rankCompletion) {
    throw new Error("Configured provider does not support Completion ranking");
  }
  const codexCliVersion = await readCodexCliVersion(options.command);
  const publicCases = DEFAULT_COMPLETION_SYNTHETIC_FIXTURES
    .filter((fixture) => fixture.expectedOutcome === "candidates")
    .map((fixture) => createCompletionEvaluationPublicCase(fixture))
    .filter((item) => item.proposal.candidates.length > 0);
  const expectations = publicCases.map(completionRankingExpectation);
  const fixtures: CompletionAiRankingEvidenceFixture[] = [];

  for (const [index, publicCase] of publicCases.entries()) {
    process.stdout.write(
      `[${index + 1}/${publicCases.length}] ranking ${publicCase.fixtureId}\n`,
    );
    fixtures.push(await rankFixture({
      index,
      publicCase,
      provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      maximumAttempts: options.maximumAttempts,
      temporaryRoot: resolvedTemporaryRoot,
    }));
  }

  const evidence = finalizeCompletionAiRankingEvidence({
    schemaVersion: COMPLETION_AI_RANKING_EVIDENCE_SCHEMA_VERSION,
    evaluationSchemaVersion: COMPLETION_EVALUATION_SCHEMA_VERSION,
    hostAlgorithmVersion: COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION,
    matrixHash: createCompletionRankingMatrixHash(expectations),
    provider: provider.providerName,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    promptVersion: COMPLETION_RANKING_PROMPT_VERSION,
    validatorVersion: COMPLETION_RANKING_VALIDATOR_VERSION,
    codexCliVersion,
    generatedAt: new Date().toISOString(),
    fixtures,
  });
  validateCompletionAiRankingEvidence({
    evidence,
    evaluationSchemaVersion: COMPLETION_EVALUATION_SCHEMA_VERSION,
    hostAlgorithmVersion: COMPLETION_EVALUATION_HOST_ALGORITHM_VERSION,
    expectations,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    canonicalCompletionEvidenceJson(evidence),
    { encoding: "utf8", flag: options.overwrite ? "w" : "wx" },
  );
  process.stdout.write(
    `Completion ranking evidence: ${outputPath}\n${evidence.evidenceHash}\n`,
  );
} finally {
  validateTemporaryRoot(resolvedTemporaryRoot, tempParent);
  await rm(resolvedTemporaryRoot, { force: true, recursive: true });
}

async function rankFixture(input: {
  readonly index: number;
  readonly publicCase: CompletionEvaluationPublicCase;
  readonly provider: CodexExecProvider;
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly maximumAttempts: number;
  readonly temporaryRoot: string;
}): Promise<CompletionAiRankingEvidenceFixture> {
  const { publicCase } = input;
  const jobId = `m21rank_${publicCase.proposal.proposalHash.slice("sha256:".length, 38)}`;
  const attempts: CompletionAiRankingEvidenceAttempt[] = [];
  let repairReport: CompletionRankingValidationReport | undefined;

  for (let attempt = 1; attempt <= input.maximumAttempts; attempt += 1) {
    const workspaceDirectory = join(
      input.temporaryRoot,
      `${String(input.index + 1).padStart(2, "0")}-${attempt}`,
    );
    const pack = await buildCompletionRankingPack({
      workspaceDirectory,
      proposalSchema: COMPLETION_RANKING_SCHEMA,
      jobId,
      completionProposal: publicCase.proposal,
      source: publicCase.input.source,
      provider: input.provider.providerName,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });
    const providerResult = await input.provider.rankCompletion!({
      jobId,
      attempt,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      pack,
      ...(repairReport ? { repairReport } : {}),
      onProgress: (event) => {
        if (event.kind === "session" || event.kind === "turn" || event.kind === "output") {
          process.stdout.write(`  attempt ${attempt}: ${event.message}\n`);
        }
      },
    });
    await verifyCompletionRankingPackIntegrity(pack);
    const validation = validateCompletionRankingProposal({
      proposal: providerResult.proposal,
      pack,
    });
    const validationReportBytes = utf8(
      canonicalCompletionEvidenceJson(validation.report),
    );
    const attemptEvidence: CompletionAiRankingEvidenceAttempt = {
      attempt,
      packInputHash: pack.inputHash,
      packManifestHash: pack.manifestHash,
      rawEventsHash: sha256(utf8(providerResult.rawEvents)),
      stderrHash: sha256(utf8(providerResult.stderr)),
      validationReportHash: sha256(validationReportBytes),
      valid: validation.report.valid,
    };
    attempts.push(attemptEvidence);
    if (validation.report.valid && validation.proposal) {
      return {
        fixtureId: publicCase.fixtureId,
        jobId,
        packInputHash: pack.inputHash,
        packManifestHash: pack.manifestHash,
        proposalId: publicCase.proposal.proposalId,
        proposalHash: publicCase.proposal.proposalHash,
        evidenceHash: publicCase.proposal.evidenceHash,
        sourceRevisionId: publicCase.input.source.sourceRevisionId,
        sourceResultHash: publicCase.input.source.sourceResultHash,
        sourceSkinHash: publicCase.input.source.sourceSkinHash,
        candidateIds: publicCase.proposal.candidates.map(
          (candidate) => candidate.candidateId,
        ),
        candidateHashes: publicCase.proposal.candidates.map(
          (candidate) => candidate.candidateHash,
        ),
        document: validation.proposal,
        rankingHash: completionRankingHash(validation.proposal),
        attempts,
      };
    }
    repairReport = validation.report;
    process.stdout.write(
      `  attempt ${attempt}: rejected by validator (${validation.report.errors.length} issues)\n`,
    );
  }
  throw new Error(
    `Completion ranking did not validate for ${publicCase.fixtureId} after ${input.maximumAttempts} attempts`,
  );
}

function completionRankingExpectation(
  publicCase: CompletionEvaluationPublicCase,
): CompletionEvaluationRankingExpectation {
  return {
    fixtureId: publicCase.fixtureId,
    proposalId: publicCase.proposal.proposalId,
    proposalHash: publicCase.proposal.proposalHash,
    evidenceHash: publicCase.proposal.evidenceHash,
    sourceRevisionId: publicCase.input.source.sourceRevisionId,
    sourceResultHash: publicCase.input.source.sourceResultHash,
    sourceSkinHash: publicCase.input.source.sourceSkinHash,
    candidateIds: publicCase.proposal.candidates.map((candidate) => candidate.candidateId),
    candidateHashes: publicCase.proposal.candidates.map((candidate) => candidate.candidateHash),
  };
}

async function readCodexCliVersion(command: string): Promise<string> {
  const result = await executeCommand({
    command,
    args: ["--version"],
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
  });
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.exitCode !== 0 || !version || version.includes("\0")) {
    throw new Error(`Unable to read Codex CLI version (exit ${result.exitCode})`);
  }
  return version;
}

function parseArguments(args: readonly string[]): {
  readonly model: string;
  readonly reasoningEffort: AnalysisReasoningEffort;
  readonly maximumAttempts: number;
  readonly timeoutMs: number;
  readonly command: string;
  readonly output: string;
  readonly overwrite: boolean;
} {
  const values = new Map<string, string>();
  let overwrite = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (!argument.startsWith("--") || index === args.length - 1) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, args[index + 1]!);
    index += 1;
  }
  const allowed = new Set([
    "--model",
    "--reasoning",
    "--maximum-attempts",
    "--timeout-seconds",
    "--command",
    "--output",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`);
  }
  const model = values.get("--model")?.trim();
  if (!model || model.includes("\0")) throw new Error("--model is required");
  const reasoningEffort = values.get("--reasoning") ?? "medium";
  if (!["low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)) {
    throw new Error("--reasoning must be low, medium, high, xhigh, or max");
  }
  const maximumAttempts = Number(values.get("--maximum-attempts") ?? 2);
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 4) {
    throw new Error("--maximum-attempts must be an integer from 1 to 4");
  }
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 600);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1_800) {
    throw new Error("--timeout-seconds must be an integer from 10 to 1800");
  }
  const output = values.get("--output") ?? DEFAULT_OUTPUT;
  if (!output.trim() || output.includes("\0")) throw new Error("--output is invalid");
  const command = values.get("--command")?.trim() ||
    (process.platform === "win32" ? "codex.cmd" : "codex");
  return {
    model,
    reasoningEffort: reasoningEffort as AnalysisReasoningEffort,
    maximumAttempts,
    timeoutMs: timeoutSeconds * 1_000,
    command,
    output,
    overwrite,
  };
}

function validateTemporaryRoot(target: string, expectedParent: string): void {
  if (
    !isAbsolute(target) ||
    dirname(target) !== expectedParent ||
    !basename(target).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Refusing to remove unexpected ranking path: ${target}`);
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
