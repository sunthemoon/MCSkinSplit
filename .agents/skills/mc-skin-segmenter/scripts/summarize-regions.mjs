#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const jobPath = resolve(process.argv[2] ?? "job.json");
const summary = JSON.parse(
  await readFile(resolve(dirname(jobPath), "input/candidate-summary.json"), "utf8"),
);
const regions = Object.entries(summary.surfaces).flatMap(([surface, entries]) =>
  entries.map(([id, dominantColor, pixelCount, x, y, width, height]) => ({
    id,
    surface,
    dominantColor,
    pixelCount,
    boundingBox: { x, y, width, height },
  })),
);

const bySurface = {};
const byLayer = {};
for (const region of regions) {
  bySurface[region.surface] = (bySurface[region.surface] ?? 0) + 1;
  const layer = region.surface.split(".")[1];
  byLayer[layer] = (byLayer[layer] ?? 0) + 1;
}

const largest = [...regions]
  .sort((left, right) => right.pixelCount - left.pixelCount || left.id.localeCompare(right.id))
  .slice(0, 30)
  .map(({ id, surface, pixelCount, dominantColor, boundingBox }) => ({
    id,
    surface,
    pixelCount,
    dominantColor,
    boundingBox,
  }));

process.stdout.write(
  `${JSON.stringify({ regionCount: regions.length, byLayer, bySurface, largest }, null, 2)}\n`,
);
