#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = "1.1";
const MAX_OVERRIDE_PIXELS = 64;
const MAX_OVERRIDE_SPANS = 32;
const COMPONENT_CATEGORIES = new Set([
  "skin", "face", "eye", "mouth", "face_detail", "hair",
  "head_accessory", "face_accessory", "upper_clothing", "lower_clothing",
  "one_piece_clothing", "sleeve", "glove", "legwear", "shoe",
  "neck_accessory", "body_accessory", "waist_accessory", "arm_accessory",
  "leg_accessory", "back_accessory", "other_accessory",
]);

const jobPath = resolve(process.argv[2] ?? "job.json");
const root = dirname(jobPath);
const [job, candidateDocument, proposal] = await Promise.all([
  readJson(jobPath),
  readJson(resolve(root, "input/candidate-regions.json")),
  readJson(resolve(root, "output/analysis-proposal.json")),
]);
const regionById = new Map(candidateDocument.regions.map((region) => [region.id, region]));
const regionIdByPixel = new Map();
for (const region of candidateDocument.regions) {
  for (const pixelId of region.pixelIds) regionIdByPixel.set(pixelId, region.id);
}
const seen = new Map();
const errors = [];

if (proposal.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
if (proposal.sourceRevisionId !== job.sourceRevisionId) {
  errors.push("sourceRevisionId does not match job.json");
}
if (proposal.modelAssessment?.armType !== job.armType) {
  errors.push("modelAssessment.armType does not match job.json");
}

for (const component of proposal.components ?? []) {
  if (!COMPONENT_CATEGORIES.has(component.category)) {
    errors.push(`${component.instanceId} has unsupported component category: ${component.category}`);
  }
  for (const id of component.candidateRegionIds ?? []) claim(id, `component:${component.instanceId}`);
}
for (const id of proposal.unassignedCandidateRegionIds ?? []) claim(id, "unassigned");
for (const [index, item] of (proposal.reviewItems ?? []).entries()) {
  for (const id of item.candidateRegionIds ?? []) claim(id, `review:${index}`);
}
for (const id of regionById.keys()) {
  if (!seen.has(id)) errors.push(`candidate region is not covered: ${id}`);
}

const uniqueOverridePixels = new Set();
const removedByPixel = new Map();
const addedByPixel = new Map();
let overrideSpanCount = 0;
for (const component of proposal.components ?? []) {
  const removeSpans = component.pixelOverrides?.remove ?? [];
  const addSpans = component.pixelOverrides?.add ?? [];
  overrideSpanCount += removeSpans.length + addSpans.length;
  const removePixels = spanPixels(removeSpans, component.instanceId, "remove");
  const addPixels = spanPixels(addSpans, component.instanceId, "add");

  for (const pixelId of removePixels) {
    uniqueOverridePixels.add(pixelId);
    const regionId = regionIdByPixel.get(pixelId);
    const owner = regionId ? seen.get(regionId) : undefined;
    if (owner !== `component:${component.instanceId}`) {
      errors.push(`${component.instanceId} removes pixel ${pixelId} outside its owned candidate regions`);
    } else if (removedByPixel.has(pixelId)) {
      errors.push(`pixel ${pixelId} is removed more than once`);
    } else {
      removedByPixel.set(pixelId, component.instanceId);
    }
  }
  for (const pixelId of addPixels) {
    uniqueOverridePixels.add(pixelId);
    const regionId = regionIdByPixel.get(pixelId);
    const owner = regionId ? seen.get(regionId) : undefined;
    if (!owner?.startsWith("component:")) {
      errors.push(`${component.instanceId} adds pixel ${pixelId} from an unassigned or review region`);
    } else if (owner === `component:${component.instanceId}`) {
      errors.push(`${component.instanceId} adds pixel ${pixelId} from its own candidate region`);
    }
    if (addedByPixel.has(pixelId)) {
      errors.push(`pixel ${pixelId} is added to more than one component`);
    } else {
      addedByPixel.set(pixelId, component.instanceId);
    }
  }
}
if (overrideSpanCount > MAX_OVERRIDE_SPANS) {
  errors.push(`pixelOverrides use ${overrideSpanCount} spans; maximum is ${MAX_OVERRIDE_SPANS}`);
}
if (uniqueOverridePixels.size > MAX_OVERRIDE_PIXELS) {
  errors.push(`pixelOverrides touch ${uniqueOverridePixels.size} unique pixels; maximum is ${MAX_OVERRIDE_PIXELS}`);
}
for (const [pixelId, destination] of addedByPixel) {
  if (!removedByPixel.has(pixelId)) {
    errors.push(`${destination} adds pixel ${pixelId} without a matching source-component removal`);
  }
}

const report = {
  schemaVersion: SCHEMA_VERSION,
  validatorVersion: "skill-proposal-validator-v2",
  valid: errors.length === 0,
  errorCount: errors.length,
  overrideUniquePixelCount: uniqueOverridePixels.size,
  overrideSpanCount,
  errors,
};
await mkdir(resolve(root, "logs"), { recursive: true });
await writeFile(
  resolve(root, "logs/validator-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { encoding: "utf8" },
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.valid) process.exitCode = 1;

function claim(id, owner) {
  if (!regionById.has(id)) {
    errors.push(`unknown candidate region: ${id}`);
    return;
  }
  const previous = seen.get(id);
  if (previous) {
    errors.push(`candidate region has multiple owners: ${id} (${previous}, ${owner})`);
  } else {
    seen.set(id, owner);
  }
}

function spanPixels(spans, componentId, mode) {
  const result = new Set();
  for (const span of spans) {
    if (!integers(span.y, span.x0, span.x1) || span.y < 0 || span.y > 63 || span.x0 < 0 || span.x1 > 63 || span.x0 > span.x1) {
      errors.push(`${componentId} has invalid ${mode} span`);
      continue;
    }
    for (let x = span.x0; x <= span.x1; x += 1) {
      const pixelId = span.y * 64 + x;
      if (!regionIdByPixel.has(pixelId)) {
        errors.push(`${componentId} ${mode} points outside visible candidate pixels: ${x},${span.y}`);
      } else if (result.has(pixelId)) {
        errors.push(`${componentId} ${mode} repeats pixel ${pixelId}`);
      } else {
        result.add(pixelId);
      }
    }
  }
  return result;
}

function integers(...values) {
  return values.every(Number.isInteger);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
