#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const jobPath = resolve(process.argv[2] ?? "job.json");
const root = dirname(jobPath);
const job = JSON.parse(await readFile(jobPath, "utf8"));
const required = [
  "input/source.png",
  "input/atlas-16x.png",
  "input/atlas-grid-16x.png",
  "input/face-contact-sheet.png",
  "input/pixel-map.json",
  "input/palette.json",
  "input/candidate-summary.json",
  "input/candidate-regions.json",
  "input/previous-segmentation.json",
  "schema/analysis-proposal.schema.json",
];

const missing = [];
for (const relativePath of required) {
  try {
    await access(resolve(root, relativePath));
  } catch {
    missing.push(relativePath);
  }
}

const regions = JSON.parse(
  await readFile(resolve(root, "input/candidate-regions.json"), "utf8"),
);
const report = {
  valid: missing.length === 0,
  jobId: job.jobId,
  sourceRevisionId: job.sourceRevisionId,
  armType: job.armType,
  candidateRegionCount: regions.regions?.length ?? 0,
  missing,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.valid) process.exitCode = 1;
