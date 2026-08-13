import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalysisProposal,
  ProviderAnalysisInput,
  ProviderAnalysisResult,
  ProviderReplacementInput,
  ProviderReplacementResult,
  ReplacementPlanProposal,
  SkinSemanticAiProvider,
} from "@mc-skin-split/ai-provider";
import { AiProviderError } from "@mc-skin-split/ai-provider";
import {
  RevisionStore,
  type ImportProjectResult,
} from "@mc-skin-split/skin-revision";
import { afterEach, describe, expect, it } from "vitest";
import { AiJobManager } from "../src/ai-job-manager";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = resolve(
  repositoryRoot,
  "tests/fixtures/skins/ab87de696cfca859.png",
);
const skillDirectory = resolve(
  repositoryRoot,
  ".agents/skills/mc-skin-segmenter",
);
const restorationManualRgba: [number, number, number, number] = [
  210, 170, 140, 255,
];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("AiJobManager", () => {
  it("commits one validated ai_segment Revision with auditable assets", async () => {
    const provider = new ScriptedProvider("provider-a", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, store, imported } = await setup([provider]);

    const queued = manager.startAnalysis(imported.revision.id, {
      mode: "full",
      provider: provider.providerName,
      model: "model-a",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair", "face", "upper_clothing", "shoe"],
      createRevisionOnSuccess: true,
    });
    const finished = await manager.waitForJob(queued.id);
    const detail = manager.getJobDetail(finished.id);

    expect(finished.status).toBe("succeeded");
    expect(finished.resultRevisionId).not.toBeNull();
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(detail.runs[0]!.assets).toHaveLength(5);
    expect(detail.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "queued",
        "preparing",
        "run_started",
        "running",
        "provider_session",
        "provider_output",
        "validating",
        "succeeded",
      ]),
    );
    const sessionEvent = detail.events.find(
      (event) => event.eventType === "provider_session",
    );
    expect(sessionEvent?.data).toMatchObject({
      commandSummary: "[REDACTED] run",
    });
    expect(JSON.stringify(sessionEvent?.data)).not.toContain("sk-provider-secret");
    const revision = store.getRevision(finished.resultRevisionId!);
    expect(revision).toMatchObject({
      operationType: "ai_segment",
      actorType: "ai",
      actorId: "provider-a",
      parentRevisionId: imported.revision.id,
      aiRunId: detail.runs[0]!.id,
    });
    const semantic = await store.readRevisionSemanticState(revision.id);
    expect(semantic.document.components[0]).toMatchObject({
      instanceId: "hair.main",
      reviewState: "needs_review",
      provenance: {
        actorType: "ai",
        aiRunId: detail.runs[0]!.id,
        containsGeneratedPixels: false,
      },
    });
    expect((await store.readRevisionSkinPng(imported.revision.id))).toEqual(
      await store.readRevisionSkinPng(revision.id),
    );
  });

  it("repairs once in a new Run and never commits the invalid attempt", async () => {
    const provider = new ScriptedProvider("repair-provider", ({ pack, attempt, repairReport }) => {
      if (attempt === 1) {
        const proposal = validProposal(
          pack.job.sourceRevisionId,
          pack.candidateRegions.regions,
        );
        return {
          ...proposal,
          components: [
            {
              ...proposal.components[0]!,
              candidateRegionIds: ["region_missing_001"],
            },
          ],
        };
      }
      expect(repairReport?.valid).toBe(false);
      return validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions);
    });
    const { manager, store, imported } = await setup([provider]);
    const job = manager.startAnalysis(imported.revision.id, {
      mode: "full",
      provider: provider.providerName,
      model: "model-repair",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: true,
    });
    const finished = await manager.waitForJob(job.id);
    const detail = manager.getJobDetail(job.id);

    expect(finished.status).toBe("succeeded");
    expect(detail.runs.map((run) => run.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(detail.runs.map((run) => run.attempt)).toEqual([1, 2]);
    expect(provider.calls).toBe(2);
    expect(store.listRevisions(imported.project.id)).toHaveLength(2);
    expect(store.getRevision(finished.resultRevisionId!).aiRunId).toBe(
      detail.runs[1]!.id,
    );
  });

  it("keeps the source untouched when both proposals fail validation", async () => {
    const provider = new ScriptedProvider("invalid-provider", ({ pack }) => {
      const proposal = validProposal(
        pack.job.sourceRevisionId,
        pack.candidateRegions.regions,
      );
      return {
        ...proposal,
        components: [
          {
            ...proposal.components[0]!,
            candidateRegionIds: ["region_missing_001"],
          },
        ],
      };
    });
    const { manager, store, imported } = await setup([provider]);
    const sourceBytes = await store.readRevisionSkinPng(imported.revision.id);
    const job = manager.startAnalysis(imported.revision.id, {
      mode: "full",
      provider: provider.providerName,
      model: "model-invalid",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: true,
    });
    const finished = await manager.waitForJob(job.id);

    expect(finished).toMatchObject({
      status: "failed",
      resultRevisionId: null,
      error: { code: "AI_PROPOSAL_INVALID" },
    });
    expect(manager.getJobDetail(job.id).runs.map((run) => run.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(store.listRevisions(imported.project.id)).toHaveLength(1);
    expect(await store.readRevisionSkinPng(imported.revision.id)).toEqual(
      sourceBytes,
    );
  });

  it("persists provider failure events and stderr without creating a Revision", async () => {
    const provider: SkinSemanticAiProvider = {
      providerName: "failing-provider",
      analyze: async () => {
        throw new AiProviderError(
          "CODEX_EXEC_FAILED",
          "provider failed",
          { exitCode: 1 },
          {
            rawEvents: `${JSON.stringify({ type: "turn.failed" })}\n`,
            stderr: "diagnostic stderr\n",
          },
        );
      },
    };
    const { manager, store, imported } = await setup([provider]);
    const job = manager.startAnalysis(imported.revision.id, {
      mode: "full",
      provider: provider.providerName,
      model: "model-failure",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: true,
    });
    const finished = await manager.waitForJob(job.id);
    const detail = manager.getJobDetail(job.id);

    expect(finished).toMatchObject({
      status: "failed",
      resultRevisionId: null,
      error: { code: "CODEX_EXEC_FAILED" },
    });
    expect(detail.runs[0]?.assets.map((asset) => asset.fileRole).sort()).toEqual([
      "input_manifest",
      "raw_events",
      "stderr",
    ]);
    expect(store.listRevisions(imported.project.id)).toHaveLength(1);
  });

  it("reruns the same input with another provider and model without a Revision side effect", async () => {
    const providerA = new ScriptedProvider("provider-a", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const providerB = new ScriptedProvider("provider-b", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, store, imported } = await setup([providerA, providerB]);
    const first = manager.startAnalysis(imported.revision.id, {
      mode: "full",
      provider: providerA.providerName,
      model: "model-a",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: false,
    });
    await manager.waitForJob(first.id);
    const retry = await manager.retryJob(first.id, {
      provider: providerB.providerName,
      model: "model-b",
      reasoningEffort: "high",
      createRevisionOnSuccess: false,
    });
    const finishedRetry = await manager.waitForJob(retry.id);

    expect(manager.getJobDetail(first.id).job).toMatchObject({
      status: "succeeded",
      resultRevisionId: null,
      provider: "provider-a",
      model: "model-a",
    });
    expect(finishedRetry).toMatchObject({
      status: "succeeded",
      resultRevisionId: null,
      retryOfJobId: first.id,
      provider: "provider-b",
      model: "model-b",
    });
    expect(finishedRetry.inputHash).not.toBe(
      manager.getJobDetail(first.id).job.inputHash,
    );
    expect(store.listRevisions(imported.project.id)).toHaveLength(1);
  });

  it("records the installed Skill and prompt versions when retrying a legacy job", async () => {
    const provider = new ScriptedProvider("provider-current", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, imported } = await setup([provider]);
    const legacy = manager.jobStore.createJob({
      kind: "semantic_analysis",
      projectId: imported.project.id,
      inputRevisionId: imported.revision.id,
      options: {
        mode: "full",
        provider: provider.providerName,
        model: "model-current",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: false,
      },
      skillName: "mc-skin-segmenter",
      skillVersion: "0.9.0",
      promptVersion: "legacy-prompt",
    });
    manager.jobStore.transitionJob(legacy.id, "failed", "legacy failure", {
      error: { code: "LEGACY_FAILURE", message: "legacy failure" },
    });

    const retry = await manager.retryJob(legacy.id, {
      createRevisionOnSuccess: false,
    });

    expect(retry).toMatchObject({
      skillVersion: "1.2.0",
      promptVersion: "semantic-proposal-v3-tool-free",
    });
    await manager.waitForJob(retry.id);
  });

  it("persists a validated restoration recommendation as advisory evidence only", async () => {
    const provider = new ScriptedReplacementProvider(
      "replacement-provider",
      ({ pack }) => validReplacementProposal(pack),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates } = await createRestorationFixture(
      store,
      imported,
    );
    const revisionCount = store.listRevisions(imported.project.id).length;

    const queued = await manager.startRestorationRecommendation(
      composition.composition.id,
      restorationRecommendationInput(provider.providerName, candidates),
    );
    const finished = await manager.waitForJob(queued.id);
    const detail = manager.getJobDetail(queued.id);

    expect(finished).toMatchObject({
      kind: "restoration_recommendation",
      status: "succeeded",
      compositionId: composition.composition.id,
      resultRevisionId: null,
      proposalSummary: "已按目标组给出完整候选排序。",
      advisoryResult: {
        schemaVersion: "1.0",
        jobId: queued.id,
        compositionId: composition.composition.id,
        candidateSetHash: candidates.candidateSetHash,
      },
    });
    expect(finished.advisoryResult?.decisions).not.toHaveLength(0);
    expect(provider.replacementCalls).toBe(1);
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(detail.runs[0]!.assets.map((asset) => asset.fileRole).sort()).toEqual([
      "input_manifest",
      "raw_events",
      "raw_output",
      "stderr",
      "validator_report",
    ]);
    expect(detail.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "queued",
        "preparing",
        "run_started",
        "running",
        "provider_session",
        "provider_output",
        "validating",
        "succeeded",
      ]),
    );

    expect(store.listRevisions(imported.project.id)).toHaveLength(revisionCount);
    expect(store.getComposition(composition.composition.id)).toMatchObject({
      restorationVersion: 0,
      restorationPlan: null,
      resultRevisionId: null,
    });
    expect(
      store.listCompositionRestorationEvents(composition.composition.id),
    ).toEqual([]);
  });

  it("honors cancellation while the final restoration freshness check is pending", async () => {
    const provider = new ScriptedReplacementProvider(
      "cancellable-replacement-provider",
      ({ pack }) => validReplacementProposal(pack),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates } = await createRestorationFixture(
      store,
      imported,
    );
    const generateCandidates =
      store.generateCompositionRestorationCandidates.bind(store);
    let regenerationCalls = 0;
    let notifyFinalRegenerationStarted!: () => void;
    let releaseFinalRegeneration!: () => void;
    const finalRegenerationStarted = new Promise<void>((resolve) => {
      notifyFinalRegenerationStarted = resolve;
    });
    const finalRegenerationRelease = new Promise<void>((resolve) => {
      releaseFinalRegeneration = resolve;
    });
    store.generateCompositionRestorationCandidates = async (
      compositionId,
      input,
    ) => {
      regenerationCalls += 1;
      const regenerated = await generateCandidates(compositionId, input);
      if (regenerationCalls === 3) {
        notifyFinalRegenerationStarted();
        await finalRegenerationRelease;
      }
      return regenerated;
    };

    const queued = await manager.startRestorationRecommendation(
      composition.composition.id,
      restorationRecommendationInput(provider.providerName, candidates),
    );
    await finalRegenerationStarted;

    expect(manager.cancelJob(queued.id)).toMatchObject({
      status: "validating",
      cancelRequested: true,
      advisoryResult: null,
    });
    releaseFinalRegeneration();

    const finished = await manager.waitForJob(queued.id);
    const detail = manager.getJobDetail(queued.id);
    expect(finished).toMatchObject({
      kind: "restoration_recommendation",
      status: "cancelled",
      resultRevisionId: null,
      advisoryResult: null,
      error: { code: "AI_CANCELLED" },
    });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: "cancelled", attempt: 1 });
    expect(detail.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["cancel_requested", "cancelled"]),
    );
    expect(detail.events.map((event) => event.eventType)).not.toContain(
      "succeeded",
    );
  });

  it("does not queue a restoration recommendation committed during start regeneration", async () => {
    const provider = new ScriptedReplacementProvider(
      "start-race-replacement-provider",
      ({ pack }) => validReplacementProposal(pack),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates: initialCandidates } = await createRestorationFixture(
      store,
      imported,
    );
    const candidates = await makeRestorationFixtureCommittable(
      store,
      composition.composition.id,
      initialCandidates,
    );
    const generateCandidates =
      store.generateCompositionRestorationCandidates.bind(store);
    let notifyRegenerationStarted!: () => void;
    let releaseRegeneration!: () => void;
    const regenerationStarted = new Promise<void>((resolve) => {
      notifyRegenerationStarted = resolve;
    });
    const regenerationRelease = new Promise<void>((resolve) => {
      releaseRegeneration = resolve;
    });
    store.generateCompositionRestorationCandidates = async (
      compositionId,
      input,
    ) => {
      const regenerated = await generateCandidates(compositionId, input);
      notifyRegenerationStarted();
      await regenerationRelease;
      return regenerated;
    };

    const start = manager.startRestorationRecommendation(
      composition.composition.id,
      restorationRecommendationInput(provider.providerName, candidates),
    );
    await regenerationStarted;
    try {
      await store.commitComposition(composition.composition.id);
    } finally {
      releaseRegeneration();
    }

    await expect(start).rejects.toMatchObject({
      code: "AI_RESTORATION_STALE",
      statusCode: 409,
    });
    expect(provider.replacementCalls).toBe(0);
    expect(
      manager.listJobs({
        kind: "restoration_recommendation",
        compositionId: composition.composition.id,
      }),
    ).toEqual([]);
  });

  it("fails a restoration recommendation committed during final regeneration", async () => {
    const provider = new ScriptedReplacementProvider(
      "final-race-replacement-provider",
      ({ pack }) => validReplacementProposal(pack),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates: initialCandidates } = await createRestorationFixture(
      store,
      imported,
    );
    const candidates = await makeRestorationFixtureCommittable(
      store,
      composition.composition.id,
      initialCandidates,
    );
    const generateCandidates =
      store.generateCompositionRestorationCandidates.bind(store);
    let regenerationCalls = 0;
    let notifyFinalRegenerationStarted!: () => void;
    let releaseFinalRegeneration!: () => void;
    const finalRegenerationStarted = new Promise<void>((resolve) => {
      notifyFinalRegenerationStarted = resolve;
    });
    const finalRegenerationRelease = new Promise<void>((resolve) => {
      releaseFinalRegeneration = resolve;
    });
    store.generateCompositionRestorationCandidates = async (
      compositionId,
      input,
    ) => {
      regenerationCalls += 1;
      const regenerated = await generateCandidates(compositionId, input);
      if (regenerationCalls === 3) {
        notifyFinalRegenerationStarted();
        await finalRegenerationRelease;
      }
      return regenerated;
    };

    const queued = await manager.startRestorationRecommendation(
      composition.composition.id,
      restorationRecommendationInput(provider.providerName, candidates),
    );
    await finalRegenerationStarted;
    try {
      await store.commitComposition(composition.composition.id);
    } finally {
      releaseFinalRegeneration();
    }

    const finished = await manager.waitForJob(queued.id);
    const detail = manager.getJobDetail(queued.id);
    expect(finished).toMatchObject({
      kind: "restoration_recommendation",
      status: "failed",
      resultRevisionId: null,
      advisoryResult: null,
      error: { code: "AI_RESTORATION_STALE" },
    });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: "failed", attempt: 1 });
    expect(detail.events.map((event) => event.eventType)).not.toContain(
      "succeeded",
    );
  });

  it("rejects a stale restoration candidate hash before creating a Job or calling the provider", async () => {
    const provider = new ScriptedReplacementProvider(
      "stale-provider",
      ({ pack }) => validReplacementProposal(pack),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates } = await createRestorationFixture(
      store,
      imported,
    );

    await expect(
      manager.startRestorationRecommendation(composition.composition.id, {
        ...restorationRecommendationInput(provider.providerName, candidates),
        candidateSetHash: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "AI_RESTORATION_STALE", statusCode: 409 });

    expect(provider.replacementCalls).toBe(0);
    expect(
      manager.listJobs({
        kind: "restoration_recommendation",
        compositionId: composition.composition.id,
      }),
    ).toEqual([]);
    expect(store.getComposition(composition.composition.id)).toMatchObject({
      restorationVersion: 0,
      restorationPlan: null,
    });
  });

  it("keeps restoration retries advisory-only and rechecks candidate freshness", async () => {
    const provider = new ScriptedReplacementProvider(
      "retry-replacement-provider",
      ({ pack }) => validReplacementProposal(pack),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates } = await createRestorationFixture(
      store,
      imported,
    );
    const first = await manager.startRestorationRecommendation(
      composition.composition.id,
      restorationRecommendationInput(provider.providerName, candidates),
    );
    expect((await manager.waitForJob(first.id)).status).toBe("succeeded");

    await expect(
      manager.retryJob(first.id, { createRevisionOnSuccess: true }),
    ).rejects.toMatchObject({ code: "INVALID_AI_JOB", statusCode: 400 });
    expect(provider.replacementCalls).toBe(1);

    await store.setCompositionRestorationPlan(composition.composition.id, {
      expectedVersion: candidates.version,
      candidateSetHash: candidates.candidateSetHash,
      candidateIds: [],
      targetComponentIds: candidates.targetComponentIds,
      manualRgba: restorationManualRgba,
    });
    await expect(manager.retryJob(first.id)).rejects.toMatchObject({
      code: "AI_RESTORATION_STALE",
      statusCode: 409,
    });

    expect(provider.replacementCalls).toBe(1);
    expect(
      manager.listJobs({
        kind: "restoration_recommendation",
        compositionId: composition.composition.id,
      }),
    ).toHaveLength(1);
    expect(store.listRevisions(imported.project.id)).toHaveLength(2);
  });
});

class ScriptedProvider implements SkinSemanticAiProvider {
  calls = 0;

  constructor(
    readonly providerName: string,
    private readonly response: (
      input: ProviderAnalysisInput,
    ) => unknown | Promise<unknown>,
  ) {}

  async analyze(input: ProviderAnalysisInput): Promise<ProviderAnalysisResult> {
    this.calls += 1;
    input.onProgress?.({
      kind: "session",
      status: "started",
      message: "Codex 会话已建立",
      commandSummary: "OPENAI_API_KEY=sk-provider-secret run",
    });
    input.onProgress?.({
      kind: "output",
      status: "completed",
      message: "候选分类提案已生成",
    });
    return {
      proposal: await this.response(input),
      rawEvents: `${JSON.stringify({ type: "thread.started", thread_id: `thread_${this.calls}` })}\n`,
      stderr: "",
      threadId: `thread_${this.calls}`,
      usage: { input_tokens: 10 * this.calls, output_tokens: 5 },
    };
  }
}

class ScriptedReplacementProvider implements SkinSemanticAiProvider {
  replacementCalls = 0;

  constructor(
    readonly providerName: string,
    private readonly response: (
      input: ProviderReplacementInput,
    ) => unknown | Promise<unknown>,
  ) {}

  async analyze(): Promise<ProviderAnalysisResult> {
    throw new Error("Semantic analysis was not expected in this test");
  }

  async recommendReplacement(
    input: ProviderReplacementInput,
  ): Promise<ProviderReplacementResult> {
    this.replacementCalls += 1;
    input.onProgress?.({
      kind: "session",
      status: "started",
      message: "Codex 会话已建立",
    });
    input.onProgress?.({
      kind: "output",
      status: "completed",
      message: "换装候选建议已生成",
    });
    return {
      proposal: await this.response(input),
      rawEvents: `${JSON.stringify({ type: "thread.started", thread_id: `replacement_thread_${this.replacementCalls}` })}\n`,
      stderr: "",
      threadId: `replacement_thread_${this.replacementCalls}`,
      usage: { input_tokens: 12 * this.replacementCalls, output_tokens: 6 },
    };
  }
}

async function setup(providers: readonly SkinSemanticAiProvider[]): Promise<{
  readonly manager: AiJobManager;
  readonly store: RevisionStore;
  readonly imported: ImportProjectResult;
}> {
  const dataDirectory = await mkdtemp(resolve(tmpdir(), "mcskinsplit-ai-worker-"));
  const store = new RevisionStore({ dataDirectory });
  const imported = await store.importProject({
    name: "AI real skin",
    skinPng: new Uint8Array(await readFile(fixturePath)),
    fileName: "ab87de696cfca859.png",
    armType: "slim",
  });
  const manager = new AiJobManager({
    revisionStore: store,
    providers,
    dataDirectory,
    skillDirectory,
    recoverInterruptedJobs: false,
  });
  cleanups.push(async () => {
    await manager.close();
    store.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { manager, store, imported };
}

function validProposal(
  sourceRevisionId: string,
  regions: ProviderAnalysisInput["pack"]["candidateRegions"]["regions"],
): AnalysisProposal {
  const first = regions[0]!;
  return {
    schemaVersion: "1.0",
    sourceRevisionId,
    modelAssessment: { armType: "slim", confidence: 0.98 },
    components: [
      {
        instanceId: "hair.main",
        displayName: "AI 主头发",
        category: "hair",
        subtype: null,
        confidence: 0.55,
        candidateRegionIds: [first.id],
        pixelOverrides: { add: [], remove: [] },
        relations: {
          attachedTo: null,
          pairedWith: [],
          sameOutfitGroup: null,
        },
        notes: "",
      },
    ],
    unassignedCandidateRegionIds: regions.slice(1).map((region) => region.id),
    reviewItems: [
      {
        type: "low_confidence",
        candidateRegionIds: [],
        question: "请人工确认低置信度组件。",
        suggestedCategories: ["hair", "head_accessory"],
        confidence: 0.55,
      },
    ],
    summary: "识别出一个低置信度头发组件，其余区域保留待分类。",
  };
}

async function createRestorationFixture(
  store: RevisionStore,
  imported: ImportProjectResult,
) {
  const segmented = await store.applyManualOperation(imported.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: "outfit.cleanup",
        displayName: "旧衣服",
        category: "upper_clothing",
      },
      spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
    },
  });
  const composition = await store.createComposition({
    baseRevisionId: segmented.revision.id,
  });
  const candidates = await store.generateCompositionRestorationCandidates(
    composition.composition.id,
    {
      targetComponentIds: ["outfit.cleanup"],
      manualRgba: restorationManualRgba,
    },
  );
  expect(candidates.base.candidates).not.toHaveLength(0);
  return { composition, candidates };
}

async function makeRestorationFixtureCommittable(
  store: RevisionStore,
  compositionId: string,
  candidates: Awaited<
    ReturnType<RevisionStore["generateCompositionRestorationCandidates"]>
  >,
) {
  const manualCandidate = candidates.base.candidates.find(
    (candidate) => candidate.kind === "manual_rgba",
  );
  expect(manualCandidate).toBeDefined();
  await store.setCompositionRestorationPlan(compositionId, {
    expectedVersion: candidates.version,
    candidateSetHash: candidates.candidateSetHash,
    candidateIds: [manualCandidate!.id],
    targetComponentIds: candidates.targetComponentIds,
    manualRgba: restorationManualRgba,
  });
  return await store.generateCompositionRestorationCandidates(compositionId, {
    targetComponentIds: candidates.targetComponentIds,
    manualRgba: restorationManualRgba,
  });
}

function restorationRecommendationInput(
  provider: string,
  candidates: Awaited<ReturnType<RevisionStore["generateCompositionRestorationCandidates"]>>,
) {
  return {
    provider,
    model: "replacement-model",
    reasoningEffort: "medium" as const,
    userIntent: "优先保留当前配色，选择完整覆盖的候选。",
    compositionVersion: candidates.version,
    candidateSetHash: candidates.candidateSetHash,
    targetComponentIds: candidates.targetComponentIds,
    manualRgba: restorationManualRgba,
  };
}

function validReplacementProposal(
  pack: ProviderReplacementInput["pack"],
): ReplacementPlanProposal {
  const groups = new Map<
    string,
    Array<(typeof pack.candidateCatalog.base.candidates)[number]>
  >();
  for (const candidate of pack.candidateCatalog.base.candidates) {
    const group = groups.get(candidate.targetGroupId) ?? [];
    group.push(candidate);
    groups.set(candidate.targetGroupId, group);
  }
  return {
    schemaVersion: "1.0",
    jobId: pack.job.jobId,
    compositionId: pack.candidateCatalog.compositionId,
    candidateSetHash: pack.candidateCatalog.candidateSetHash,
    decisions: [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([targetGroupId, candidates]) => {
        const selected = candidates.find(
          (candidate) =>
            candidate.coveragePixelCount === candidate.pixelCount,
        );
        const ranked = selected
          ? [selected, ...candidates.filter((candidate) => candidate !== selected)]
          : candidates;
        return {
          targetGroupId,
          selectedCandidateId: selected?.id ?? null,
          rankedCandidateIds: ranked.map((candidate) => candidate.id),
          confidence: selected ? 0.9 : 0.4,
          explanation: selected
            ? "候选覆盖完整，符合用户意图。"
            : "尚无完整候选，建议保留人工决策。",
        };
      }),
    summary: "已按目标组给出完整候选排序。",
  };
}
