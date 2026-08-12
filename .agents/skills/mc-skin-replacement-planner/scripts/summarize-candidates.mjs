#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { summarizeCatalog } from "./planner-contract.mjs";

const jobPath = resolve(process.argv[2] ?? "job.json");
const root = dirname(jobPath);

try {
  const [job, catalog] = await Promise.all([
    readJson(jobPath),
    readJson(resolve(root, "input/restoration-candidates.json")),
  ]);
  const summary = summarizeCatalog(job, catalog);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
