import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RevisionStore } from "@mc-skin-split/skin-revision";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AiJobStore } from "../src/ai-job-store";

const fixturePath = fileURLToPath(
  new URL("../../../tests/fixtures/skins/ab87de696cfca859.png", import.meta.url),
);
const cleanups: Array<() => Promise<void> | void> = [];
const hash = `sha256:${"a".repeat(64)}`;
const candidateId = `restore_${"b".repeat(64)}`;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("AiJobStore restoration recommendations", () => {
  it("persists a strict advisory result and supports kind/composition filters", async () => {
    const { revisionStore, jobStore, imported } = await setup();
    const composition = await revisionStore.createComposition({
      baseRevisionId: imported.revision.id,
    });
    const job = jobStore.createJob({
      kind: "restoration_recommendation",
      projectId: imported.project.id,
      inputRevisionId: imported.revision.id,
      compositionId: composition.composition.id,
      skillName: "mc-skin-replacement-planner",
      skillVersion: "1.0.0",
      promptVersion: "replacement-candidate-recommendation-v1",
      options: {
        mode: "restoration_recommendation",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "medium",
        userIntent: "优先恢复上衣",
        compositionId: composition.composition.id,
        compositionVersion: 0,
        candidateSetHash: hash,
        targetComponentIds: ["upper_clothing.main"],
      },
    });

    jobStore.transitionJob(job.id, "preparing", "preparing");
    jobStore.transitionJob(job.id, "running", "running", { inputHash: hash });
    jobStore.transitionJob(job.id, "validating", "validating");
    const succeeded = jobStore.transitionJob(job.id, "succeeded", "succeeded", {
      outputHash: hash,
      proposalSummary: "建议恢复躯干底层",
      advisoryResult: {
        schemaVersion: "1.0",
        jobId: job.id,
        compositionId: composition.composition.id,
        candidateSetHash: hash,
        decisions: [
          {
            targetGroupId: "torso_base",
            selectedCandidateId: candidateId,
            rankedCandidateIds: [candidateId],
            confidence: 0.9,
            explanation: "最符合优先恢复上衣的意图",
          },
        ],
        summary: "建议恢复躯干底层",
      },
    });

    expect(succeeded).toMatchObject({
      kind: "restoration_recommendation",
      resultRevisionId: null,
      reviewItems: [],
      advisoryResult: { candidateSetHash: hash },
    });
    expect(
      jobStore.listJobs({
        kind: "restoration_recommendation",
        compositionId: composition.composition.id,
      }),
    ).toEqual([succeeded]);
    expect(jobStore.listJobs({ kind: "semantic_analysis" })).toEqual([]);
  });

  it("rejects cross-kind output fields and malformed planning options", async () => {
    const { revisionStore, jobStore, imported } = await setup();
    const composition = await revisionStore.createComposition({
      baseRevisionId: imported.revision.id,
    });
    const semantic = jobStore.createJob({
      kind: "semantic_analysis",
      projectId: imported.project.id,
      inputRevisionId: imported.revision.id,
      skillName: "mc-skin-segmenter",
      skillVersion: "1.1.0",
      promptVersion: "semantic-proposal-v2",
      options: {
        mode: "full",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: false,
      },
    });
    expect(() =>
      jobStore.transitionJob(semantic.id, "failed", "failed", {
        advisoryResult: {
          schemaVersion: "1.0",
          jobId: semantic.id,
          compositionId: composition.composition.id,
          candidateSetHash: hash,
          decisions: [],
          summary: "invalid",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_AI_JOB" }));

    expect(() =>
      jobStore.createJob({
        kind: "restoration_recommendation",
        projectId: imported.project.id,
        inputRevisionId: imported.revision.id,
        compositionId: composition.composition.id,
        skillName: "mc-skin-replacement-planner",
        skillVersion: "1.0.0",
        promptVersion: "replacement-candidate-recommendation-v1",
        options: {
          mode: "restoration_recommendation",
          provider: "provider-a",
          model: "model-a",
          reasoningEffort: "medium",
          userIntent: "restore",
          compositionId: composition.composition.id,
          compositionVersion: 0,
          candidateSetHash: hash,
          targetComponentIds: [],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_AI_JOB" }));
  });

  it("enforces the persisted kind/composition shape in migration 008", async () => {
    const { revisionStore, imported } = await setup();
    const composition = await revisionStore.createComposition({
      baseRevisionId: imported.revision.id,
    });
    const database = new Database(revisionStore.databasePath);
    cleanups.push(() => {
      database.close();
    });
    expect(
      database
        .prepare("SELECT version FROM schema_migration WHERE version = 8")
        .get(),
    ).toEqual({ version: 8 });
    expect(() =>
      database
        .prepare(`
          INSERT INTO ai_job (
            id, job_kind, project_id, input_revision_id, composition_id,
            retry_of_job_id, status, provider, model, skill_name, skill_version,
            prompt_version, options_json, review_items_json, cancel_requested,
            created_at
          ) VALUES (?, 'restoration_recommendation', ?, ?, NULL, NULL, 'queued',
            'provider-a', 'model-a', 'mc-skin-replacement-planner', '1.0.0',
            'replacement-candidate-recommendation-v1', ?, '[]', 0, ?)
        `)
        .run(
          "aijob_invalid_shape",
          imported.project.id,
          imported.revision.id,
          JSON.stringify({
            mode: "restoration_recommendation",
            compositionId: composition.composition.id,
          }),
          new Date().toISOString(),
        ),
    ).toThrow(/invalid AI job kind shape/u);
  });
});

async function setup() {
  const dataDirectory = await mkdtemp(resolve(tmpdir(), "mcskinsplit-ai-store-"));
  const revisionStore = new RevisionStore({ dataDirectory });
  const imported = await revisionStore.importProject({
    name: "AI store fixture",
    skinPng: new Uint8Array(await readFile(fixturePath)),
    armType: "slim",
  });
  const jobStore = new AiJobStore({ databasePath: revisionStore.databasePath });
  cleanups.push(async () => {
    jobStore.close();
    revisionStore.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { revisionStore, jobStore, imported };
}
