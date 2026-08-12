#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { summarizeCatalog, validatePlan } from "./planner-contract.mjs";

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  await validateWorkspace();
}

async function validateWorkspace() {
  const jobPath = resolve(process.argv[2] ?? "job.json");
  const root = dirname(jobPath);
  let report;
  try {
    const [job, catalog, plan] = await Promise.all([
      readJson(jobPath),
      readJson(resolve(root, "input/restoration-candidates.json")),
      readJson(resolve(root, "output/replacement-plan.json")),
    ]);
    const errors = validatePlan(job, catalog, plan);
    report = { valid: errors.length === 0, errorCount: errors.length, errors };
  } catch (error) {
    report = {
      valid: false,
      errorCount: 1,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  await mkdir(resolve(root, "logs"), { recursive: true });
  await writeFile(
    resolve(root, "logs/validator-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 1;
}

function runSelfTest() {
  const id = (character) => `restore_${character.repeat(64)}`;
  const hash = `sha256:${"a".repeat(64)}`;
  const job = {
    schemaVersion: "1.0",
    jobId: "replacement_job_self_test",
    userIntent: "Prefer the complete current-surface candidate.",
  };
  const catalog = {
    compositionId: "composition_self_test",
    version: 2,
    candidateSetHash: hash,
    targetComponentIds: ["outfit.main"],
    outer: { pixelCount: 4, candidateId: id("f") },
    base: {
      pixelCount: 8,
      coveredPixelCount: 8,
      missingPixelCount: 0,
      candidates: [
        {
          id: id("1"),
          kind: "current_same_surface",
          targetGroupId: "torso_base",
          label: "Same surface",
          description: "Semantic skin sampled from the same Base surface.",
          pixelCount: 8,
          coveragePixelCount: 8,
        },
        {
          id: id("2"),
          kind: "current_same_body_part",
          targetGroupId: "torso_base",
          label: "Same body part",
          description: "Semantic skin sampled elsewhere on the same body part.",
          pixelCount: 8,
          coveragePixelCount: 6,
        },
      ],
    },
  };
  const validPlan = {
    schemaVersion: "1.0",
    jobId: job.jobId,
    compositionId: catalog.compositionId,
    candidateSetHash: hash,
    decisions: [
      {
        targetGroupId: "torso_base",
        selectedCandidateId: id("1"),
        rankedCandidateIds: [id("1"), id("2")],
        confidence: 0.92,
        explanation: "Complete local semantic evidence best matches the requested source.",
      },
    ],
    summary: "One complete local candidate is recommended.",
  };
  const invalidPlan = {
    ...validPlan,
    decisions: [
      {
        ...validPlan.decisions[0],
        selectedCandidateId: id("2"),
        rankedCandidateIds: [id("2"), id("9")],
        explanation: "Use RGBA [1, 2, 3, 255] at pixel ID 42.",
      },
    ],
  };
  const positiveErrors = validatePlan(job, catalog, validPlan);
  const negativeErrors = validatePlan(job, catalog, invalidPlan);
  const summary = summarizeCatalog(job, catalog);
  const report = {
    valid:
      summary.valid === true &&
      summary.base.targetGroups.length === 1 &&
      summary.base.targetGroups[0]?.candidates.length === 2 &&
      positiveErrors.length === 0 &&
      negativeErrors.length > 0,
    summary,
    positive: { valid: positiveErrors.length === 0, errors: positiveErrors },
    negative: { valid: negativeErrors.length === 0, errors: negativeErrors },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 1;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
