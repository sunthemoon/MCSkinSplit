import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
  canonicalCompletionEvidenceJson,
  runCompletionEvaluationSuite,
} from "@mc-skin-split/skin-analysis-pack";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const defaults = {
  ai: "docs/evidence/m21/ai-ranking-evidence.json",
  browser: "docs/evidence/m21/browser-evidence.json",
  output: "docs/evidence/m21/completion-release-report.json",
} as const;

const options = parseArguments(process.argv.slice(2));
const aiEvidence = await readOptionalEvidence(
  resolve(REPO_ROOT, options.ai),
  options.allowMissingAi,
);
const browserEvidence = JSON.parse(
  await readFile(resolve(REPO_ROOT, options.browser), "utf8"),
) as unknown;
const fingerprint = await currentBrowserSourceFingerprint();
const evaluation = runCompletionEvaluationSuite(
  DEFAULT_COMPLETION_SYNTHETIC_FIXTURES,
  {
    ...(aiEvidence === null ? {} : { aiRankingEvidence: aiEvidence }),
    browserEvidence,
    expectedBrowserSourceHash: fingerprint.sourceHash,
  },
);
if (
  !evaluation.evidence.browser ||
  (!options.allowMissingAi && !evaluation.evidence.aiRanking)
) {
  throw new Error("Completion release evaluation did not retain required evidence summaries");
}
if (evaluation.evidence.browser.sourceFileCount !== fingerprint.sourceFileCount) {
  throw new Error("Completion browser evidence source file count is stale");
}
const evaluatedAt = latestIsoTimestamp([
  ...(evaluation.evidence.aiRanking
    ? [evaluation.evidence.aiRanking.generatedAt]
    : []),
  evaluation.evidence.browser.startedAt,
]);
const body = {
  schemaVersion: "1.0" as const,
  evaluatedAt,
  sourceHash: fingerprint.sourceHash,
  sourceFileCount: fingerprint.sourceFileCount,
  evidenceGaps: evaluation.evidence.aiRanking === null
    ? ["ai_ranking"] as const
    : [] as const,
  decision: evaluation.releaseGateStatus === "pass"
    ? "enable_default" as const
    : "keep_experimental" as const,
  evaluation,
};
const report = {
  ...body,
  reportHash: sha256(canonicalCompletionEvidenceJson(body)),
};
const serialized = canonicalCompletionEvidenceJson(report);
const outputPath = resolve(REPO_ROOT, options.output);

if (options.check) {
  const existing = await readFile(outputPath, "utf8");
  if (existing !== serialized) {
    throw new Error(`Completion release report is stale: ${outputPath}`);
  }
  process.stdout.write(`Completion release report is current: ${outputPath}\n`);
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(
    `Completion release report: ${outputPath}\n` +
      `decision=${report.decision} release=${evaluation.releaseGateStatus}\n` +
      `${report.reportHash}\n`,
  );
}

async function currentBrowserSourceFingerprint(): Promise<{
  readonly sourceHash: string;
  readonly sourceFileCount: number;
}> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(REPO_ROOT, "scripts/completion-browser-source.mjs")],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as unknown;
  if (
    !isRecord(parsed) ||
    typeof parsed.sourceHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(parsed.sourceHash) ||
    !Number.isInteger(parsed.sourceFileCount) ||
    Number(parsed.sourceFileCount) < 1
  ) {
    throw new Error("Browser source fingerprint output is invalid");
  }
  return {
    sourceHash: parsed.sourceHash,
    sourceFileCount: Number(parsed.sourceFileCount),
  };
}

function parseArguments(args: readonly string[]): {
  readonly ai: string;
  readonly browser: string;
  readonly output: string;
  readonly check: boolean;
  readonly allowMissingAi: boolean;
} {
  const values = new Map<string, string>();
  let check = false;
  let allowMissingAi = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--allow-missing-ai") {
      allowMissingAi = true;
      continue;
    }
    if (!argument.startsWith("--") || index === args.length - 1) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, args[index + 1]!);
    index += 1;
  }
  for (const key of values.keys()) {
    if (!["--ai", "--browser", "--output"].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return {
    ai: validPath(values.get("--ai") ?? defaults.ai, "--ai"),
    browser: validPath(values.get("--browser") ?? defaults.browser, "--browser"),
    output: validPath(values.get("--output") ?? defaults.output, "--output"),
    check,
    allowMissingAi,
  };
}

async function readOptionalEvidence(
  path: string,
  allowMissing: boolean,
): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (
      allowMissing &&
      isRecord(error) &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function validPath(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) throw new Error(`${label} is invalid`);
  return value;
}

function latestIsoTimestamp(values: readonly string[]): string {
  const timestamps = values.map((value) => Date.parse(value));
  if (timestamps.some((value) => !Number.isFinite(value))) {
    throw new Error("Completion evidence timestamp is invalid");
  }
  return new Date(Math.max(...timestamps)).toISOString();
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
