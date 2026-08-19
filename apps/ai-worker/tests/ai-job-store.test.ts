import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_SKILL_NAME,
  AI_SKILL_VERSION,
} from "@mc-skin-split/ai-provider";
import { PROMPT_VERSION } from "@mc-skin-split/skin-analysis-pack";
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
        semanticBaseline: "current",
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

  it("keeps historical v1 followups readable but rejects multiple v2 suggestions", async () => {
    const { revisionStore, jobStore, imported } = await setup();
    const job = jobStore.createJob({
      kind: "semantic_analysis",
      projectId: imported.project.id,
      inputRevisionId: imported.revision.id,
      skillName: "mc-skin-segmenter",
      skillVersion: "1.2.0",
      promptVersion: "semantic-proposal-v4-tool-free",
      options: {
        mode: "full",
        semanticBaseline: "empty",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: true,
      },
    });
    jobStore.transitionJob(job.id, "preparing", "preparing");
    jobStore.transitionJob(job.id, "running", "running", { inputHash: hash });
    const run = jobStore.createRun(job.id, "runs/v2-cardinality", "airun_v2_cardinality");
    jobStore.transitionJob(job.id, "validating", "validating");
    const analyzed = await revisionStore.commitAiSegmentation(imported.revision.id, {
      state: await revisionStore.readRevisionSemanticState(imported.revision.id),
      aiJobId: job.id,
      aiRunId: run.id,
      provider: "provider-a",
      model: "model-a",
      proposalSummary: "cardinality fixture",
      reviewItems: [],
    });
    const suggestions = [
      {
        kind: "cross_body_hair_reclassification" as const,
        id: `followup_${"a".repeat(24)}`,
        label: "长发 A",
        targetComponentId: "hair.cross-body-a",
        sourceComponentIds: ["upper_clothing.main"],
        candidateRegionIds: ["region_torso_base_001"],
        spans: [{ surface: "torso.base.front" as const, y: 20, x0: 20, x1: 20 }],
        pixelCount: 1,
        confidence: 0.9,
        reason: "fixture A",
      },
      {
        kind: "cross_body_hair_reclassification" as const,
        id: `followup_${"b".repeat(24)}`,
        label: "长发 B",
        targetComponentId: "hair.cross-body-b",
        sourceComponentIds: ["upper_clothing.main"],
        candidateRegionIds: ["region_torso_base_002"],
        spans: [{ surface: "torso.base.front" as const, y: 20, x0: 21, x1: 21 }],
        pixelCount: 1,
        confidence: 0.9,
        reason: "fixture B",
      },
    ];
    const notices = [{
      kind: "possible_hidden_clothing" as const,
      suggestionIds: suggestions.map((suggestion) => suggestion.id),
      message: "fixture notice",
    }];

    expect(() => jobStore.createSemanticFollowup({
      jobId: job.id,
      resultRevisionId: analyzed.revision.id,
      assessment: {
        schemaVersion: "1.0",
        algorithmVersion: "cross-body-hair-reclassification-v2",
        evidenceHash: hash,
        suggestions,
        notices,
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_AI_JOB" }));

    const singleNotice = [{
      kind: "possible_hidden_clothing" as const,
      suggestionIds: [suggestions[0]!.id],
      message: "single fixture notice",
    }];
    expect(() => jobStore.createSemanticFollowup({
      jobId: job.id,
      resultRevisionId: analyzed.revision.id,
      assessment: {
        schemaVersion: "1.0",
        algorithmVersion: "cross-body-hair-reclassification-v1",
        evidenceHash: hash,
        suggestions: [{ ...suggestions[0]!, pixelCount: 2 }],
        notices: singleNotice,
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_AI_JOB" }));
    expect(() => jobStore.createSemanticFollowup({
      jobId: job.id,
      resultRevisionId: analyzed.revision.id,
      assessment: {
        schemaVersion: "1.0",
        algorithmVersion: "cross-body-hair-reclassification-v1",
        evidenceHash: hash,
        suggestions: [{
          ...suggestions[0]!,
          spans: [suggestions[0]!.spans[0]!, suggestions[0]!.spans[0]!],
          pixelCount: 2,
        }],
        notices: singleNotice,
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_AI_JOB" }));

    const historical = jobStore.createSemanticFollowup({
      jobId: job.id,
      resultRevisionId: analyzed.revision.id,
      assessment: {
        schemaVersion: "1.0",
        algorithmVersion: "cross-body-hair-reclassification-v1",
        evidenceHash: hash,
        suggestions,
        notices,
      },
    });
    expect(historical.assessment).toMatchObject({
      algorithmVersion: "cross-body-hair-reclassification-v1",
      suggestions: [{ id: suggestions[0]!.id }, { id: suggestions[1]!.id }],
    });
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

describe("AiJobStore historical semantic contracts", () => {
  it("keeps current semantic write fields required", async () => {
    const { jobStore, imported } = await setup();
    const completeOptions = {
      mode: "full",
      semanticBaseline: "empty",
      provider: "provider-a",
      model: "model-a",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: false,
    } as const;
    const invalidOptions = [
      {
        mode: "full",
        semanticBaseline: "empty",
        provider: "provider-a",
        model: "model-a",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: false,
      },
      {
        mode: "full",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: false,
      },
    ] as const;

    for (const options of invalidOptions) {
      expect(() =>
        jobStore.createJob({
          kind: "semantic_analysis",
          projectId: imported.project.id,
          inputRevisionId: imported.revision.id,
          skillName: AI_SKILL_NAME,
          skillVersion: AI_SKILL_VERSION,
          promptVersion: PROMPT_VERSION,
          options: options as typeof completeOptions,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_AI_JOB", statusCode: 400 }),
      );
    }
    expect(jobStore.listJobs({ kind: "semantic_analysis" })).toEqual([]);
  });

  it("reads only the field defaults defined by each pre-M15 contract", async () => {
    const { revisionStore, jobStore, imported } = await setup();
    const database = new Database(revisionStore.databasePath);
    cleanups.push(() => {
      database.close();
    });
    const baseOptions = {
      mode: "full",
      provider: "provider-a",
      model: "model-a",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: false,
    };
    const historical = [
      {
        id: "aijob_historical_v1",
        skillVersion: "1.0.0",
        promptVersion: "semantic-proposal-v1",
        options: baseOptions,
        expectedReasoningEffort: "medium",
      },
      {
        id: "aijob_historical_v2",
        skillVersion: "1.1.0",
        promptVersion: "semantic-proposal-v2",
        options: baseOptions,
        expectedReasoningEffort: "medium",
      },
      {
        id: "aijob_historical_v2_explicit_reasoning",
        skillVersion: "1.1.0",
        promptVersion: "semantic-proposal-v2",
        options: { ...baseOptions, reasoningEffort: "max" },
        expectedReasoningEffort: "max",
      },
      {
        id: "aijob_historical_v3",
        skillVersion: "1.2.0",
        promptVersion: "semantic-proposal-v3-tool-free",
        options: { ...baseOptions, reasoningEffort: "high" },
        expectedReasoningEffort: "high",
      },
    ] as const;

    for (const fixture of historical) {
      insertStoredSemanticJob(database, {
        id: fixture.id,
        projectId: imported.project.id,
        revisionId: imported.revision.id,
        skillVersion: fixture.skillVersion,
        promptVersion: fixture.promptVersion,
        options: fixture.options,
      });
    }

    expect(
      jobStore
        .listJobs({ kind: "semantic_analysis" })
        .map((job) => {
          if (job.kind !== "semantic_analysis") {
            throw new Error("semantic_analysis filter returned another Job kind");
          }
          return {
            id: job.id,
            reasoningEffort: job.options.reasoningEffort,
            semanticBaseline: job.options.semanticBaseline,
          };
        }),
    ).toEqual(
      historical.map((fixture) => ({
        id: fixture.id,
        reasoningEffort: fixture.expectedReasoningEffort,
        semanticBaseline: "current",
      })),
    );
  });

  it("does not apply legacy defaults to current or unknown contracts", async () => {
    const { revisionStore, jobStore, imported } = await setup();
    const database = new Database(revisionStore.databasePath);
    cleanups.push(() => {
      database.close();
    });
    const options = {
      mode: "full",
      provider: "provider-a",
      model: "model-a",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: false,
    };
    insertStoredSemanticJob(database, {
      id: "aijob_v3_missing_reasoning",
      projectId: imported.project.id,
      revisionId: imported.revision.id,
      skillVersion: "1.2.0",
      promptVersion: "semantic-proposal-v3-tool-free",
      options,
    });
    insertStoredSemanticJob(database, {
      id: "aijob_current_missing_reasoning",
      projectId: imported.project.id,
      revisionId: imported.revision.id,
      skillVersion: "1.3.0",
      promptVersion: "semantic-proposal-v5-bounded-transfers",
      options,
    });
    insertStoredSemanticJob(database, {
      id: "aijob_unknown_missing_reasoning",
      projectId: imported.project.id,
      revisionId: imported.revision.id,
      skillVersion: "9.9.9",
      promptVersion: "unknown-prompt",
      options,
    });
    insertStoredSemanticJob(database, {
      id: "aijob_v1_version_with_v2_prompt",
      projectId: imported.project.id,
      revisionId: imported.revision.id,
      skillVersion: "1.0.0",
      promptVersion: "semantic-proposal-v2",
      options,
    });
    insertStoredSemanticJob(database, {
      id: "aijob_v2_version_with_v1_prompt",
      projectId: imported.project.id,
      revisionId: imported.revision.id,
      skillVersion: "1.1.0",
      promptVersion: "semantic-proposal-v1",
      options,
    });
    insertStoredSemanticJob(database, {
      id: "aijob_wrong_skill_with_v2_contract",
      projectId: imported.project.id,
      revisionId: imported.revision.id,
      skillName: "other-skin-segmenter",
      skillVersion: "1.1.0",
      promptVersion: "semantic-proposal-v2",
      options,
    });

    for (const jobId of [
      "aijob_v3_missing_reasoning",
      "aijob_current_missing_reasoning",
      "aijob_unknown_missing_reasoning",
      "aijob_v1_version_with_v2_prompt",
      "aijob_v2_version_with_v1_prompt",
      "aijob_wrong_skill_with_v2_contract",
    ]) {
      expect(() => jobStore.getJob(jobId)).toThrowError(
        expect.objectContaining({ code: "AI_JOB_CORRUPT" }),
      );
    }
  });
});

function insertStoredSemanticJob(
  database: Database.Database,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly revisionId: string;
    readonly skillName?: string;
    readonly skillVersion: string;
    readonly promptVersion: string;
    readonly options: Readonly<Record<string, unknown>>;
    readonly status?: "failed" | "succeeded";
  },
): void {
  database
    .prepare(`
      INSERT INTO ai_job (
        id, job_kind, project_id, input_revision_id, result_revision_id,
        composition_id, retry_of_job_id, status, provider, model, skill_name,
        skill_version, prompt_version, input_hash, output_hash, options_json,
        review_items_json, proposal_summary, advisory_result_json,
        cancel_requested, created_at, started_at, finished_at, error_json
      ) VALUES (?, 'semantic_analysis', ?, ?, NULL, NULL, NULL, ?,
        'provider-a', 'model-a', ?, ?, ?, NULL, NULL, ?,
        '[]', NULL, NULL, 0, ?, NULL, ?, ?)
    `)
    .run(
      input.id,
      input.projectId,
      input.revisionId,
      input.status ?? "failed",
      input.skillName ?? "mc-skin-segmenter",
      input.skillVersion,
      input.promptVersion,
      JSON.stringify(input.options),
      new Date().toISOString(),
      new Date().toISOString(),
      input.status === "succeeded"
        ? null
        : JSON.stringify({ code: "LEGACY_FAILURE", message: "legacy failure" }),
    );
}

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
