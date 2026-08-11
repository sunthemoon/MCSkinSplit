#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const jobPath = resolve(process.argv[2] ?? "job.json");
const root = dirname(jobPath);
const [job, candidateDocument, proposal] = await Promise.all([
  readJson(jobPath),
  readJson(resolve(root, "input/candidate-regions.json")),
  readJson(resolve(root, "output/analysis-proposal.json")),
]);
const known = new Set(candidateDocument.regions.map((region) => region.id));
const seen = new Map();
const errors = [];

if (proposal.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
if (proposal.sourceRevisionId !== job.sourceRevisionId) {
  errors.push("sourceRevisionId does not match job.json");
}
if (proposal.modelAssessment?.armType !== job.armType) {
  errors.push("modelAssessment.armType does not match job.json");
}

for (const component of proposal.components ?? []) {
  for (const id of component.candidateRegionIds ?? []) claim(id, `component:${component.instanceId}`);
  for (const mode of ["add", "remove"]) {
    for (const span of component.pixelOverrides?.[mode] ?? []) {
      if (!integers(span.y, span.x0, span.x1) || span.y < 0 || span.y > 63 || span.x0 < 0 || span.x1 > 63 || span.x0 > span.x1) {
        errors.push(`${component.instanceId} has invalid ${mode} span`);
      }
    }
  }
}
for (const id of proposal.unassignedCandidateRegionIds ?? []) claim(id, "unassigned");
for (const item of proposal.reviewItems ?? []) {
  for (const id of item.candidateRegionIds ?? []) claim(id, `review:${item.type}`, true);
}
for (const id of known) {
  if (!seen.has(id)) errors.push(`candidate region is not covered: ${id}`);
}

const report = { valid: errors.length === 0, errorCount: errors.length, errors };
await mkdir(resolve(root, "logs"), { recursive: true });
await writeFile(
  resolve(root, "logs/validator-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { encoding: "utf8" },
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.valid) process.exitCode = 1;

function claim(id, owner, allowReviewOverlap = false) {
  if (!known.has(id)) {
    errors.push(`unknown candidate region: ${id}`);
    return;
  }
  const previous = seen.get(id);
  if (previous && !(allowReviewOverlap && previous.startsWith("review:"))) {
    errors.push(`candidate region has multiple owners: ${id} (${previous}, ${owner})`);
  } else if (!previous) {
    seen.set(id, owner);
  }
}

function integers(...values) {
  return values.every(Number.isInteger);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
