import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalysisProposal,
  ProviderAnalysisInput,
  ProviderAnalysisResult,
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
    const retry = manager.retryJob(first.id, {
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

    const retry = manager.retryJob(legacy.id, {
      createRevisionOnSuccess: false,
    });

    expect(retry).toMatchObject({
      skillVersion: "1.1.0",
      promptVersion: "semantic-proposal-v2",
    });
    await manager.waitForJob(retry.id);
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
