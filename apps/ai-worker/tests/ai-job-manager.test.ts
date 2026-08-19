import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalysisProposal,
  CompletionRankingProposal,
  ProviderAnalysisInput,
  ProviderAnalysisResult,
  ProviderCompletionRankingInput,
  ProviderCompletionRankingResult,
  ProviderReplacementInput,
  ProviderReplacementResult,
  ReplacementPlanProposal,
  SkinSemanticAiProvider,
} from "@mc-skin-split/ai-provider";
import {
  AI_SKILL_NAME,
  AI_SKILL_VERSION,
  AiProviderError,
} from "@mc-skin-split/ai-provider";
import {
  COMPLETION_RANKING_PACK_SCHEMA_VERSION,
  COMPLETION_RANKING_PROMPT_VERSION,
  PROMPT_VERSION,
} from "@mc-skin-split/skin-analysis-pack";
import {
  COMPLETION_CANDIDATE_ALGORITHM_VERSION,
  COMPLETION_PROPOSAL_SCHEMA_VERSION,
  canonicalCompletionJson,
  decodeSkinPng,
  generateCompletionProposalCandidates,
  summarizePixelOrigins,
  summarizePixelOriginsForMask,
} from "@mc-skin-split/skin-core";
import {
  RevisionStore,
  RevisionStoreError,
  type ImportProjectResult,
} from "@mc-skin-split/skin-revision";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AiJobManager,
  COMPLETION_JOB_PROMPT_VERSION,
  COMPLETION_JOB_PROVIDER,
  COMPLETION_JOB_SKILL_NAME,
  COMPLETION_RANKING_JOB_SKILL_NAME,
  type AiJobManagerOptions,
} from "../src/ai-job-manager";

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

    const queued = await manager.startAnalysis(imported.revision.id, {
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
    expect(detail.semanticFollowup).toMatchObject({
      status: "no_repair",
      algorithmVersion: "cross-body-hair-reclassification-v2",
      applicable: true,
      suggestions: [],
    });
    expect(detail.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "occlusion_assessing",
        "occlusion_assessed",
        "repair_review_skipped",
        "catalog_ready",
      ]),
    );
  });

  it("persists and applies one review-only cross-body semantic repair", async () => {
    let suggestionRegion: ProviderAnalysisInput["pack"]["candidateRegions"]["regions"][number] | null = null;
    const provider = new ScriptedProvider("followup-provider", ({ pack }) => {
      const [hairRegion, clothingRegion, ...remaining] =
        pack.candidateRegions.regions;
      suggestionRegion = clothingRegion!;
      return {
        schemaVersion: "1.2",
        sourceRevisionId: pack.job.sourceRevisionId,
        modelAssessment: { armType: "slim", confidence: 0.9 },
        appearanceInventory: {
          observations: [
            {
              subject: "hair",
              cue: "shape_continuity",
              candidateRegionIds: [hairRegion!.id, clothingRegion!.id],
              confidence: 0.9,
              description: "头部与躯干候选呈连续长发形态。",
            },
          ],
          summary: "头发跨越头部与躯干，服装保持独立。",
        },
        components: [
          {
            instanceId: "hair.main",
            displayName: "主头发",
            category: "hair",
            subtype: null,
            confidence: 0.9,
            candidateRegionIds: [hairRegion!.id],
            pixelOverrides: { add: [], remove: [] },
            relations: {
              attachedTo: null,
              pairedWith: [],
              sameOutfitGroup: null,
            },
            notes: "",
          },
          {
            instanceId: "outfit.main",
            displayName: "上装",
            category: "upper_clothing",
            subtype: null,
            confidence: 0.8,
            candidateRegionIds: [clothingRegion!.id],
            pixelOverrides: { add: [], remove: [] },
            relations: {
              attachedTo: null,
              pairedWith: [],
              sameOutfitGroup: "outfit.main",
            },
            notes: "",
          },
        ],
        unassignedCandidateRegionIds: remaining.map((region) => region.id),
        reviewItems: [],
        summary: "测试跨部位分类修复",
      } satisfies AnalysisProposal;
    });
    const evidenceHash = `sha256:${"e".repeat(64)}`;
    const { manager, store, imported } = await setup([provider], {
      semanticFollowupAssessor: () => ({
        schemaVersion: "1.0",
        algorithmVersion: "cross-body-hair-reclassification-v2",
        evidenceHash,
        suggestions: [
          {
            kind: "cross_body_hair_reclassification",
            id: `followup_${"a".repeat(24)}`,
            label: "疑似跨部位长发",
            targetComponentId: "hair.cross-body-abcdef123456",
            sourceComponentIds: ["outfit.main"],
            candidateRegionIds: [suggestionRegion!.id],
            spans: suggestionRegion!.spans,
            pixelCount: suggestionRegion!.pixelCount,
            confidence: 0.92,
            reason: "测试建议",
          },
        ],
        notices: [
          {
            kind: "possible_hidden_clothing",
            suggestionIds: [`followup_${"a".repeat(24)}`],
            message: "长发后方的衣服仍需补全确认。",
          },
        ],
      }),
    });
    const queued = await manager.startAnalysis(imported.revision.id, {
      mode: "full",
      semanticBaseline: "empty",
      provider: provider.providerName,
      model: "followup-model",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair", "upper_clothing"],
      createRevisionOnSuccess: true,
    });
    await manager.waitForJob(queued.id);
    const pending = manager.getJobDetail(queued.id);
    expect(pending.semanticFollowup).toMatchObject({
      status: "awaiting_review",
      algorithmVersion: "cross-body-hair-reclassification-v2",
      applicable: true,
      evidenceHash,
      suggestions: [
        {
          id: `followup_${"a".repeat(24)}`,
          pixelCount: suggestionRegion!.pixelCount,
        },
      ],
    });
    expect(pending.semanticFollowup).not.toHaveProperty(
      "suggestions.0.spans",
    );

    const applied = await manager.applySemanticFollowup(
      queued.id,
      `followup_${"a".repeat(24)}`,
    );
    expect(applied.semanticFollowup).toMatchObject({
      status: "applied",
      appliedRevisionId: expect.any(String),
    });
    expect(store.listRevisions(imported.project.id)).toHaveLength(4);
    const repairBranch = store.listBranches(imported.project.id).find(
      (branch) => branch.name.startsWith("semantic-repair-"),
    );
    expect(repairBranch).toMatchObject({
      baseRevisionId: pending.job.resultRevisionId,
      headRevisionId: applied.semanticFollowup!.appliedRevisionId,
    });
    const repaired = await store.readRevisionSemanticState(
      applied.semanticFollowup!.appliedRevisionId!,
    );
    expect(
      suggestionRegion!.pixelIds.every(
        (pixelId) =>
          repaired.masks["hair.cross-body-abcdef123456"]![pixelId] === 1,
      ),
    ).toBe(true);
    expect(
      repaired.document.components.find(
        (component) => component.instanceId === "hair.cross-body-abcdef123456",
      ),
    ).toMatchObject({ displayName: "跨部位长发", category: "hair" });
    expect(applied.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "repair_review_ready",
        "semantic_repair_applied",
        "catalog_ready",
      ]),
    );

    const revisionCountAfterApply = store.listRevisions(imported.project.id).length;
    const branchCountAfterApply = store.listBranches(imported.project.id).length;
    const appliedAgain = await manager.applySemanticFollowup(
      queued.id,
      `followup_${"a".repeat(24)}`,
    );
    expect(appliedAgain.semanticFollowup?.appliedRevisionId).toBe(
      applied.semanticFollowup!.appliedRevisionId,
    );
    expect(store.listRevisions(imported.project.id)).toHaveLength(
      revisionCountAfterApply,
    );
    expect(store.listBranches(imported.project.id)).toHaveLength(
      branchCountAfterApply,
    );
    expect(
      appliedAgain.events.filter(
        (event) => event.eventType === "semantic_repair_applied",
      ),
    ).toHaveLength(1);
    await expect(
      manager.applySemanticFollowup(queued.id, `followup_${"b".repeat(24)}`),
    ).rejects.toMatchObject({ code: "AI_FOLLOWUP_CONFLICT", statusCode: 409 });
    expect(store.listRevisions(imported.project.id)).toHaveLength(
      revisionCountAfterApply,
    );
    expect(store.listBranches(imported.project.id)).toHaveLength(
      branchCountAfterApply,
    );
  });

  it("keeps a historical v1 followup readable but requires fresh v2 analysis before apply", async () => {
    let suggestionRegion: ProviderAnalysisInput["pack"]["candidateRegions"]["regions"][number] | null = null;
    const provider = new ScriptedProvider("historical-followup-provider", ({ pack }) => {
      suggestionRegion = pack.candidateRegions.regions[0]!;
      return validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions);
    });
    const evidenceHash = `sha256:${"d".repeat(64)}`;
    const suggestionId = `followup_${"c".repeat(24)}`;
    const { manager, store, imported } = await setup([provider], {
      semanticFollowupAssessor: () => ({
        schemaVersion: "1.0",
        algorithmVersion: "cross-body-hair-reclassification-v1",
        evidenceHash,
        suggestions: [{
          kind: "cross_body_hair_reclassification",
          id: suggestionId,
          label: "历史长发建议",
          targetComponentId: "hair.cross-body-historical",
          sourceComponentIds: ["hair.main"],
          candidateRegionIds: [suggestionRegion!.id],
          spans: suggestionRegion!.spans,
          pixelCount: suggestionRegion!.pixelCount,
          confidence: 0.9,
          reason: "v1 fixture",
        }],
        notices: [{
          kind: "possible_hidden_clothing",
          suggestionIds: [suggestionId],
          message: "historical fixture",
        }],
      }),
    });
    const queued = await manager.startAnalysis(imported.revision.id, {
      mode: "full",
      semanticBaseline: "empty",
      provider: provider.providerName,
      model: "historical-followup-model",
      reasoningEffort: "medium",
      taxonomyLevel: "coarse",
      focus: ["hair"],
      createRevisionOnSuccess: true,
    });
    await manager.waitForJob(queued.id);

    expect(manager.jobStore.getSemanticFollowup(queued.id)?.assessment)
      .toMatchObject({
        algorithmVersion: "cross-body-hair-reclassification-v1",
        suggestions: [{ id: suggestionId }],
      });
    expect(manager.getJobDetail(queued.id).semanticFollowup).toMatchObject({
      status: "awaiting_review",
      algorithmVersion: "cross-body-hair-reclassification-v1",
      applicable: false,
    });
    const revisionCount = store.listRevisions(imported.project.id).length;
    const branchCount = store.listBranches(imported.project.id).length;
    await expect(manager.applySemanticFollowup(queued.id, suggestionId))
      .rejects.toMatchObject({
        code: "AI_FOLLOWUP_STALE",
        statusCode: 409,
        details: {
          storedAlgorithmVersion: "cross-body-hair-reclassification-v1",
          currentAlgorithmVersion: "cross-body-hair-reclassification-v2",
        },
      });
    expect(store.listRevisions(imported.project.id)).toHaveLength(revisionCount);
    expect(store.listBranches(imported.project.id)).toHaveLength(branchCount);
    expect(
      manager.getJobDetail(queued.id).events.some(
        (event) => event.eventType === "semantic_repair_applied",
      ),
    ).toBe(false);

    const resultRevisionId = manager.getJobDetail(queued.id).job.resultRevisionId!;
    const historicalBranch = await store.branchFromRevision(resultRevisionId, {
      name: "historical-semantic-repair-fixture",
      actorId: "semantic-followup",
    });
    const durableHistoricalApply = await store.applyManualOperation(
      historicalBranch.revision.id,
      {
        operation: {
          type: "assign_pixels",
          target: {
            instanceId: "hair.cross-body-historical",
            displayName: "历史跨部位长发",
            category: "hair",
          },
          spans: suggestionRegion!.spans,
        },
        actorId: "semantic-followup",
        semanticFollowup: {
          jobId: queued.id,
          resultRevisionId,
          suggestionId,
          evidenceHash,
        },
      },
    );
    const durableRevisionCount = store.listRevisions(imported.project.id).length;
    const durableBranchCount = store.listBranches(imported.project.id).length;
    const historicalAppliedAgain = await manager.applySemanticFollowup(
      queued.id,
      suggestionId,
    );
    expect(historicalAppliedAgain.semanticFollowup).toMatchObject({
      status: "applied",
      algorithmVersion: "cross-body-hair-reclassification-v1",
      applicable: false,
      appliedRevisionId: durableHistoricalApply.revision.id,
    });
    expect(store.listRevisions(imported.project.id)).toHaveLength(
      durableRevisionCount,
    );
    expect(store.listBranches(imported.project.id)).toHaveLength(
      durableBranchCount,
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
    const job = await manager.startAnalysis(imported.revision.id, {
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
    const job = await manager.startAnalysis(imported.revision.id, {
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
    const job = await manager.startAnalysis(imported.revision.id, {
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
    const first = await manager.startAnalysis(imported.revision.id, {
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
      semanticBaseline: "current",
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
      options: { semanticBaseline: "current" },
    });
    expect(finishedRetry.inputHash).not.toBe(
      manager.getJobDetail(first.id).job.inputHash,
    );
    expect(store.listRevisions(imported.project.id)).toHaveLength(1);
  });

  it("rejects semantic retries whose stored Skill or prompt contract is stale", async () => {
    const provider = new ScriptedProvider("provider-current", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, imported } = await setup([provider]);
    const staleContracts = [
      {
        skillName: "legacy-skin-segmenter",
        skillVersion: AI_SKILL_VERSION,
        promptVersion: PROMPT_VERSION,
      },
      {
        skillName: AI_SKILL_NAME,
        skillVersion: "0.9.0",
        promptVersion: PROMPT_VERSION,
      },
      {
        skillName: AI_SKILL_NAME,
        skillVersion: AI_SKILL_VERSION,
        promptVersion: "legacy-prompt",
      },
    ] as const;

    for (const contract of staleContracts) {
      const legacy = manager.jobStore.createJob({
        kind: "semantic_analysis",
        projectId: imported.project.id,
        inputRevisionId: imported.revision.id,
        options: semanticAnalysisOptions(provider.providerName, false),
        ...contract,
      });
      manager.jobStore.transitionJob(legacy.id, "failed", "legacy failure", {
        error: { code: "LEGACY_FAILURE", message: "legacy failure" },
      });
      const jobCount = manager.listJobs().length;

      await expect(manager.retryJob(legacy.id)).rejects.toMatchObject({
        code: "AI_ANALYSIS_RETRY_CONTRACT_STALE",
        statusCode: 409,
        details: {
          jobId: legacy.id,
          sourceRevisionId: imported.revision.id,
          storedContract: contract,
          currentContract: {
            skillName: AI_SKILL_NAME,
            skillVersion: AI_SKILL_VERSION,
            promptVersion: PROMPT_VERSION,
          },
          requiredAction: "start_fresh_analysis",
        },
      });
      expect(manager.listJobs()).toHaveLength(jobCount);
    }
    expect(provider.calls).toBe(0);
  });

  it("rejects a legacy retry contract before checking its removed provider", async () => {
    const provider = new ScriptedProvider("provider-current", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, imported } = await setup([provider]);
    const removedProvider = "provider-removed";
    const database = new Database(manager.jobStore.databasePath);
    try {
      database
        .prepare(`
          INSERT INTO ai_job (
            id, job_kind, project_id, input_revision_id, result_revision_id,
            composition_id, retry_of_job_id, status, provider, model,
            skill_name, skill_version, prompt_version, input_hash, output_hash,
            options_json, review_items_json, proposal_summary,
            advisory_result_json, cancel_requested, created_at, started_at,
            finished_at, error_json
          ) VALUES (?, 'semantic_analysis', ?, ?, NULL, NULL, NULL, 'failed',
            ?, 'legacy-model', 'mc-skin-segmenter', '1.0.0',
            'semantic-proposal-v1', NULL, NULL, ?, '[]', NULL, NULL, 0, ?,
            NULL, ?, ?)
        `)
        .run(
          "aijob_legacy_retry_contract",
          imported.project.id,
          imported.revision.id,
          removedProvider,
          JSON.stringify({
            mode: "full",
            provider: removedProvider,
            model: "legacy-model",
            taxonomyLevel: "coarse",
            focus: ["hair"],
            createRevisionOnSuccess: false,
          }),
          new Date().toISOString(),
          new Date().toISOString(),
          JSON.stringify({ code: "LEGACY_FAILURE", message: "legacy failure" }),
        );
    } finally {
      database.close();
    }
    const legacyJob = manager.jobStore.getJob("aijob_legacy_retry_contract");
    expect(legacyJob.options).toMatchObject({
      provider: removedProvider,
      reasoningEffort: "medium",
      semanticBaseline: "current",
    });
    expect(manager.listProviders()).not.toContain(removedProvider);
    const jobCount = manager.listJobs().length;
    await expect(manager.retryJob(legacyJob.id)).rejects.toMatchObject({
      code: "AI_ANALYSIS_RETRY_CONTRACT_STALE",
      statusCode: 409,
      details: {
        jobId: legacyJob.id,
        storedContract: {
          skillName: "mc-skin-segmenter",
          skillVersion: "1.0.0",
          promptVersion: "semantic-proposal-v1",
        },
        requiredAction: "start_fresh_analysis",
      },
    });
    expect(manager.listJobs()).toHaveLength(jobCount);
    expect(provider.calls).toBe(0);
  });

  it("preserves recorded authored origins across semantic reanalysis", async () => {
    const provider = new ScriptedProvider("generated-source-provider", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates: initialCandidates } =
      await createRestorationFixture(store, imported);
    await makeRestorationFixtureCommittable(
      store,
      composition.composition.id,
      initialCandidates,
    );
    const committed = await store.commitComposition(composition.composition.id);
    const sourceOrigin = await store.readRevisionOrigin(committed.revision.id);
    expect(sourceOrigin).not.toBeNull();
    expect(summarizePixelOrigins(sourceOrigin!).counts).toMatchObject({
      manual_authored: expect.any(Number),
      generated_completion: 0,
    });
    expect(
      summarizePixelOrigins(sourceOrigin!).counts.manual_authored,
    ).toBeGreaterThan(0);

    const queued = await manager.startAnalysis(
      committed.revision.id,
      semanticAnalysisOptions(provider.providerName),
    );
    const finished = await manager.waitForJob(queued.id);

    expect(finished).toMatchObject({
      status: "succeeded",
      inputRevisionId: committed.revision.id,
      resultRevisionId: expect.any(String),
    });
    const resultRevisionId = finished.resultRevisionId!;
    const resultOrigin = await store.readRevisionOrigin(resultRevisionId);
    expect(resultOrigin).toEqual({
      ...sourceOrigin!,
      subject: { kind: "revision", id: resultRevisionId },
    });

    const resultState = await store.readRevisionSemanticState(resultRevisionId);
    for (const component of resultState.document.components) {
      const originSummary = summarizePixelOriginsForMask(
        resultOrigin!,
        resultState.masks[component.instanceId]!,
      );
      expect(component.provenance).toMatchObject({
        containsGeneratedPixels: originSummary.containsGeneratedPixels,
        originSummary,
      });
    }
    expect(provider.calls).toBe(1);
  });

  it("allows authored composition sources for read-only start and retry", async () => {
    const provider = new ScriptedProvider("read-only-generated-provider", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, store, imported } = await setup([provider]);
    const { composition, candidates: initialCandidates } =
      await createRestorationFixture(store, imported);
    await makeRestorationFixtureCommittable(
      store,
      composition.composition.id,
      initialCandidates,
    );
    const committed = await store.commitComposition(composition.composition.id);
    const revisionCount = store.listRevisions(imported.project.id).length;

    const first = await manager.startAnalysis(
      committed.revision.id,
      semanticAnalysisOptions(provider.providerName, false),
    );
    const finishedFirst = await manager.waitForJob(first.id);
    const retry = await manager.retryJob(first.id);
    const finishedRetry = await manager.waitForJob(retry.id);

    expect(finishedFirst).toMatchObject({
      status: "succeeded",
      inputRevisionId: committed.revision.id,
      resultRevisionId: null,
      options: { createRevisionOnSuccess: false },
    });
    expect(finishedRetry).toMatchObject({
      status: "succeeded",
      inputRevisionId: committed.revision.id,
      resultRevisionId: null,
      retryOfJobId: first.id,
      options: { createRevisionOnSuccess: false },
    });
    expect(provider.calls).toBe(2);
    expect(
      manager.listJobs({ inputRevisionId: committed.revision.id }),
    ).toHaveLength(2);
    expect(store.listRevisions(imported.project.id)).toHaveLength(revisionCount);
  });

  it("rejects retrying effective ancestry that applied a repaired Part", async () => {
    const provider = new ScriptedProvider("repaired-source-provider", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, store, imported } = await setup([provider]);
    const segmented = await classifyHeadPixel(store, imported);
    const basePart = await store.exportPart(segmented.revision.id, "hair.authored");
    const repair = await store.createPartEditProject({ basePartId: basePart.id });
    const edited = await store.applyPartEditOperation(repair.project.id, {
      headRevisionId: repair.headRevision.id,
      operation: {
        type: "paint_color",
        spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
        rgba: [17, 34, 51, 255],
      },
    });
    const repairedPart = (
      await store.commitPartEditProject(repair.project.id, {
        headRevisionId: edited.headRevision.id,
        name: "Authored repaired hair",
      })
    ).part;
    const applied = await store.applyPart(segmented.revision.id, {
      partId: repairedPart.id,
      strategy: "use_part",
    });
    const semanticChild = await store.applyManualOperation(applied.revision.id, {
      operation: {
        type: "reclassify_component",
        componentId: `applied.${repairedPart.id}`,
        category: "head_accessory",
      },
    });
    const legacy = manager.jobStore.createJob({
      kind: "semantic_analysis",
      projectId: imported.project.id,
      inputRevisionId: semanticChild.revision.id,
      options: semanticAnalysisOptions(provider.providerName),
      skillName: AI_SKILL_NAME,
      skillVersion: AI_SKILL_VERSION,
      promptVersion: PROMPT_VERSION,
    });
    manager.jobStore.transitionJob(legacy.id, "failed", "legacy failure", {
      error: { code: "LEGACY_FAILURE", message: "legacy failure" },
    });
    const readOrigin = store.readRevisionOrigin.bind(store);
    store.readRevisionOrigin = async (revisionId) =>
      revisionId === semanticChild.revision.id ? null : readOrigin(revisionId);

    await expect(manager.retryJob(legacy.id)).rejects.toMatchObject({
      code: "AI_ANALYSIS_SOURCE_PROVENANCE_CONFLICT",
      statusCode: 409,
      details: {
        sourceRevisionId: semanticChild.revision.id,
        evidenceRevisionId: applied.revision.id,
        reason: "repaired_part_ancestry",
        operationType: "apply_part",
        partIds: [repairedPart.id],
        repairedPartIds: [repairedPart.id],
      },
    });
    expect(
      manager.listJobs({ inputRevisionId: semanticChild.revision.id }),
    ).toEqual([expect.objectContaining({ id: legacy.id, status: "failed" })]);
    expect(provider.calls).toBe(0);
  });

  it("keeps a Revision reverted to clean imported content eligible", async () => {
    const provider = new ScriptedProvider("clean-revert-provider", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, store, imported } = await setup([provider]);
    const segmented = await classifyHeadPixel(store, imported);
    const part = await store.exportPart(segmented.revision.id, "hair.authored");
    await store.applyPart(segmented.revision.id, {
      partId: part.id,
      strategy: "use_part",
    });
    const reverted = await store.revertRevision(imported.revision.id);

    const queued = await manager.startAnalysis(
      reverted.revision.id,
      semanticAnalysisOptions(provider.providerName),
    );
    const finished = await manager.waitForJob(queued.id);

    expect(finished).toMatchObject({
      status: "succeeded",
      inputRevisionId: reverted.revision.id,
      resultRevisionId: expect.any(String),
    });
    expect(provider.calls).toBe(1);
  });

  it("rechecks the recorded origin immediately before provider execution", async () => {
    const provider = new ScriptedProvider("provider-boundary-guard", ({ pack }) =>
      validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions),
    );
    const { manager, store, imported } = await setup([provider]);
    const segmented = await classifyHeadPixel(store, imported);
    const readOrigin = store.readRevisionOrigin.bind(store);
    const readSkinPng = store.readRevisionSkinPng.bind(store);
    let exposeOriginCorruption = false;
    let notifySkinReadStarted!: () => void;
    let releaseSkinRead!: () => void;
    const skinReadStarted = new Promise<void>((resolve) => {
      notifySkinReadStarted = resolve;
    });
    const skinReadRelease = new Promise<void>((resolve) => {
      releaseSkinRead = resolve;
    });
    store.readRevisionOrigin = async (revisionId) => {
      if (exposeOriginCorruption) {
        throw new RevisionStoreError(
          "SNAPSHOT_CORRUPT",
          `Revision ${revisionId} origin snapshot changed`,
          409,
          { revisionId },
        );
      }
      return readOrigin(revisionId);
    };
    store.readRevisionSkinPng = async (revisionId) => {
      notifySkinReadStarted();
      await skinReadRelease;
      return readSkinPng(revisionId);
    };

    const queued = await manager.startAnalysis(
      segmented.revision.id,
      semanticAnalysisOptions(provider.providerName),
    );
    await skinReadStarted;
    exposeOriginCorruption = true;
    releaseSkinRead();
    const finished = await manager.waitForJob(queued.id);

    expect(finished).toMatchObject({
      status: "failed",
      resultRevisionId: null,
      error: {
        code: "SNAPSHOT_CORRUPT",
        details: { revisionId: segmented.revision.id },
      },
    });
    expect(provider.calls).toBe(0);
    expect(store.listRevisions(imported.project.id)).toHaveLength(2);
  });

  it("rechecks the recorded origin immediately before the AI Revision commit", async () => {
    let exposeOriginCorruption = false;
    const provider = new ScriptedProvider("commit-boundary-guard", ({ pack }) => {
      exposeOriginCorruption = true;
      return validProposal(pack.job.sourceRevisionId, pack.candidateRegions.regions);
    });
    const { manager, store, imported } = await setup([provider]);
    const segmented = await classifyHeadPixel(store, imported);
    const readOrigin = store.readRevisionOrigin.bind(store);
    store.readRevisionOrigin = async (revisionId) => {
      if (exposeOriginCorruption) {
        throw new RevisionStoreError(
          "SNAPSHOT_CORRUPT",
          `Revision ${revisionId} origin snapshot changed`,
          409,
          { revisionId },
        );
      }
      return readOrigin(revisionId);
    };

    const queued = await manager.startAnalysis(
      segmented.revision.id,
      semanticAnalysisOptions(provider.providerName),
    );
    const finished = await manager.waitForJob(queued.id);

    expect(finished).toMatchObject({
      status: "failed",
      resultRevisionId: null,
      error: {
        code: "SNAPSHOT_CORRUPT",
        details: { revisionId: segmented.revision.id },
      },
    });
    expect(provider.calls).toBe(1);
    expect(store.listRevisions(imported.project.id)).toHaveLength(2);
  });

  it("generates review-only completion candidates and accepts one idempotently", async () => {
    const provider = new ScriptedProvider("unused-completion-provider", () => {
      throw new Error("Completion host flow must not invoke the semantic provider");
    });
    const { manager, store, imported } = await setup([provider]);
    const source = await createCompletionFixture(store, imported);
    const revisionCount = store.listRevisions(imported.project.id).length;

    await expect(manager.startCompletionProposal(source.revision.id, {
      targetComponentId: "clothing.completion",
      occludingComponentIds: ["hair.occluder", "hair.occluder"],
    })).rejects.toMatchObject({
      code: "INVALID_COMPLETION_PROPOSAL",
      statusCode: 400,
    });

    const queued = await manager.startCompletionProposal(source.revision.id, {
      targetComponentId: "clothing.completion",
      occludingComponentIds: ["hair.occluder"],
      representation: "latent_component",
    });
    const finished = await manager.waitForJob(queued.id);

    expect(finished).toMatchObject({
      kind: "completion_proposal",
      status: "succeeded",
      resultRevisionId: null,
      compositionId: null,
      options: {
        rankingMode: "host_only",
        representation: "latent_component",
      },
    });
    expect(provider.calls).toBe(0);
    expect(manager.getJobDetail(queued.id).runs).toEqual([]);
    expect(manager.getJobDetail(queued.id).events.map((event) => event.eventType))
      .toEqual(expect.arrayContaining([
        "candidate_generation_started",
        "completion_candidates_generated",
        "validating",
        "succeeded",
      ]));

    const listed = await manager.listCompletionProposals({
      sourceRevisionId: source.revision.id,
    });
    expect(listed).toHaveLength(1);
    const detail = await manager.getCompletionProposalDetail(
      listed[0]!.proposal.id,
    );
    expect(detail).toMatchObject({
      status: "awaiting_decision",
      proposal: {
        jobId: queued.id,
        representation: "latent_component",
      },
      ranking: null,
      decision: null,
      result: null,
    });
    expect(detail.candidates.length).toBeGreaterThan(0);
    expect(
      detail.candidates.every((candidate) =>
        candidate.representation === "latent_component"),
    ).toBe(true);
    const candidate = detail.candidates[0]!;
    const decisionInput = {
      candidateId: candidate.id,
      expectedSourceResultHash: detail.proposal.sourceResultHash,
      expectedProposalHash: detail.proposal.proposalHash,
      expectedEvidenceHash: detail.proposal.evidenceHash,
      expectedCandidateHash: candidate.candidateHash,
      actorId: "completion-reviewer",
      summary: "接受测试候选",
    } as const;
    const accepted = await manager.acceptCompletionCandidate(
      detail.proposal.id,
      decisionInput,
    );
    expect(accepted).toMatchObject({
      changed: true,
      detail: {
        status: "accepted",
        decision: { action: "accept", candidateId: candidate.id },
        result: {
          representation: "latent_component",
          revision: null,
          latentPart: { id: expect.any(String) },
          publishedAt: null,
        },
      },
    });
    expect(store.listRevisions(imported.project.id)).toHaveLength(revisionCount);

    const repeated = await manager.acceptCompletionCandidate(
      detail.proposal.id,
      decisionInput,
    );
    expect(repeated.changed).toBe(false);
    expect(repeated.detail.decision?.id).toBe(accepted.detail.decision?.id);
    expect(
      manager.getJobDetail(queued.id).events.filter(
        (event) => event.eventType === "completion_candidate_accepted",
      ),
    ).toHaveLength(1);
    await expect(manager.retryJob(queued.id)).rejects.toMatchObject({
      code: "COMPLETION_RETRY_UNSUPPORTED",
      statusCode: 409,
    });
  });

  it("persists validated AI candidate ordering without accepting a candidate", async () => {
    const provider = new ScriptedCompletionRankingProvider(
      "completion-ranker",
      validCompletionRankingProposal,
    );
    const { manager, store, imported } = await setup([provider], {
      completionRanking: {
        provider: provider.providerName,
        model: "completion-ranking-model",
        reasoningEffort: "high",
      },
    });
    const source = await createCompletionFixture(store, imported);
    const revisionCount = store.listRevisions(imported.project.id).length;

    const queued = await manager.startCompletionProposal(source.revision.id, {
      targetComponentId: "clothing.completion",
      occludingComponentIds: ["hair.occluder"],
      representation: "latent_component",
    });
    const finished = await manager.waitForJob(queued.id);
    const jobDetail = manager.getJobDetail(queued.id);

    expect(finished.error).toBeNull();
    expect(finished).toMatchObject({
      kind: "completion_proposal",
      status: "succeeded",
      provider: provider.providerName,
      model: "completion-ranking-model",
      resultRevisionId: null,
      advisoryResult: null,
      reviewItems: [],
      options: {
        rankingMode: "ai",
        reasoningEffort: "high",
      },
    });
    expect(provider.rankingCalls).toBe(1);
    expect(jobDetail.runs).toHaveLength(1);
    expect(jobDetail.runs[0]).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(jobDetail.runs[0]!.assets.map((asset) => asset.fileRole).sort()).toEqual([
      "input_manifest",
      "raw_events",
      "raw_output",
      "stderr",
      "validator_report",
    ]);

    const proposals = await manager.listCompletionProposals({ jobId: queued.id });
    expect(proposals).toHaveLength(1);
    const detail = await manager.getCompletionProposalDetail(
      proposals[0]!.proposal.id,
    );
    expect(detail).toMatchObject({
      status: "awaiting_decision",
      decision: null,
      result: null,
      ranking: {
        provider: provider.providerName,
        model: "completion-ranking-model",
        reasoningEffort: "high",
        document: {
          jobId: queued.id,
          proposalId: detail.proposal.id,
          proposalHash: detail.proposal.proposalHash,
          recommendation: { status: "recommend" },
        },
      },
    });
    expect(detail.ranking?.orderedCandidateIds).toEqual(
      detail.ranking?.document.rankings.map(({ candidateId }) => candidateId),
    );
    expect(new Set(detail.ranking?.orderedCandidateIds)).toEqual(
      new Set(detail.candidates.map((candidate) => candidate.id)),
    );
    expect(store.listRevisions(imported.project.id)).toHaveLength(revisionCount);
    expect(detail.ranking?.recommendation.candidateId).toBe(
      detail.ranking?.orderedCandidateIds[0],
    );
  });

  it("fails invalid AI ranking without a proposal and retries with stored config", async () => {
    const observedPacks: ProviderCompletionRankingInput["pack"][] = [];
    let calls = 0;
    const provider = new ScriptedCompletionRankingProvider(
      "completion-retry-ranker",
      (input) => {
        calls += 1;
        observedPacks.push(input.pack);
        const valid = validCompletionRankingProposal(input);
        return calls === 1 ? { ...valid, jobId: "wrong_job" } : valid;
      },
    );
    const { manager, store, imported } = await setup([provider], {
      completionRanking: {
        provider: provider.providerName,
        model: "immutable-ranking-model",
        reasoningEffort: "xhigh",
      },
      maxRepairAttempts: 0,
    });
    const source = await createCompletionFixture(store, imported);

    const first = await manager.startCompletionProposal(source.revision.id, {
      targetComponentId: "clothing.completion",
      occludingComponentIds: ["hair.occluder"],
      representation: "latent_component",
    });
    const failed = await manager.waitForJob(first.id);

    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "AI_COMPLETION_RANKING_INVALID" },
      options: {
        rankingMode: "ai",
        provider: provider.providerName,
        model: "immutable-ranking-model",
        reasoningEffort: "xhigh",
      },
    });
    expect(await store.getCompletionProposalByJobId(first.id)).toBeNull();
    expect(await manager.listCompletionProposals({ jobId: first.id })).toEqual([]);
    expect(manager.getJobDetail(first.id).runs[0]).toMatchObject({
      status: "failed",
      attempt: 1,
    });

    const retry = await manager.retryJob(first.id);
    const succeeded = await manager.waitForJob(retry.id);
    expect(succeeded.error).toBeNull();
    expect(succeeded).toMatchObject({
      status: "succeeded",
      retryOfJobId: first.id,
      provider: provider.providerName,
      model: "immutable-ranking-model",
      options: { rankingMode: "ai", reasoningEffort: "xhigh" },
    });
    expect(provider.rankingCalls).toBe(2);
    expect(observedPacks).toHaveLength(2);
    expect(observedPacks[1]!.evidence.proposalId).not.toBe(
      observedPacks[0]!.evidence.proposalId,
    );
    expect(observedPacks[1]!.evidence.proposalHash).toBe(
      observedPacks[0]!.evidence.proposalHash,
    );
    expect(
      observedPacks[1]!.completionProposal.candidates.map(
        (candidate) => candidate.candidateHash,
      ),
    ).toEqual(
      observedPacks[0]!.completionProposal.candidates.map(
        (candidate) => candidate.candidateHash,
      ),
    );
    expect(
      observedPacks[1]!.completionProposal.candidates.map(
        (candidate) => candidate.candidateId,
      ),
    ).not.toEqual(
      observedPacks[0]!.completionProposal.candidates.map(
        (candidate) => candidate.candidateId,
      ),
    );
    expect(await manager.listCompletionProposals({ jobId: retry.id }))
      .toHaveLength(1);
  });

  it("keeps provider failure diagnostics without exposing a completion proposal", async () => {
    const provider = new ScriptedCompletionRankingProvider(
      "failing-completion-ranker",
      () => {
        throw new AiProviderError(
          "COMPLETION_PROVIDER_FAILED",
          "Completion provider failed",
          { exitCode: 17 },
          {
            rawEvents: `${JSON.stringify({ type: "provider.failure" })}\n`,
            stderr: "ranking provider stderr",
          },
        );
      },
    );
    const { manager, store, imported } = await setup([provider], {
      completionRanking: {
        provider: provider.providerName,
        model: "failing-ranking-model",
        reasoningEffort: "medium",
      },
      maxRepairAttempts: 0,
    });
    const source = await createCompletionFixture(store, imported);

    const queued = await manager.startCompletionProposal(source.revision.id, {
      targetComponentId: "clothing.completion",
      occludingComponentIds: ["hair.occluder"],
      representation: "latent_component",
    });
    const failed = await manager.waitForJob(queued.id);
    const detail = manager.getJobDetail(queued.id);

    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "COMPLETION_PROVIDER_FAILED",
        details: { exitCode: 17 },
      },
    });
    expect(await store.getCompletionProposalByJobId(queued.id)).toBeNull();
    expect(await manager.listCompletionProposals({ jobId: queued.id })).toEqual([]);
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({
      status: "failed",
      error: { code: "COMPLETION_PROVIDER_FAILED" },
    });
    expect(detail.runs[0]!.assets.map((asset) => asset.fileRole).sort()).toEqual([
      "input_manifest",
      "raw_events",
      "stderr",
    ]);
  });

  it("keeps a post-persist cancellation hidden and retryable", async () => {
    const provider = new ScriptedCompletionRankingProvider(
      "post-persist-cancel-ranker",
      validCompletionRankingProposal,
    );
    const { manager, store, imported } = await setup([provider], {
      completionRanking: {
        provider: provider.providerName,
        model: "post-persist-cancel-model",
        reasoningEffort: "high",
      },
    });
    const source = await createCompletionFixture(store, imported);
    const createProposal = store.createCompletionProposal.bind(store);
    let notifyProposalPersisted!: () => void;
    let releaseProposalReturn!: () => void;
    let persistedProposalId = "";
    const proposalPersisted = new Promise<void>((resolve) => {
      notifyProposalPersisted = resolve;
    });
    const proposalReturnRelease = new Promise<void>((resolve) => {
      releaseProposalReturn = resolve;
    });
    store.createCompletionProposal = async (input) => {
      const detail = await createProposal(input);
      persistedProposalId = detail.proposal.id;
      notifyProposalPersisted();
      await proposalReturnRelease;
      return detail;
    };
    cleanups.push(() => {
      store.createCompletionProposal = createProposal;
      releaseProposalReturn();
    });

    const queued = await manager.startCompletionProposal(source.revision.id, {
      targetComponentId: "clothing.completion",
      occludingComponentIds: ["hair.occluder"],
      representation: "latent_component",
    });
    await proposalPersisted;
    expect(persistedProposalId).not.toBe("");
    expect(manager.cancelJob(queued.id)).toMatchObject({
      status: "validating",
      cancelRequested: true,
      outputHash: null,
    });
    releaseProposalReturn();

    const cancelled = await manager.waitForJob(queued.id);
    store.createCompletionProposal = createProposal;
    const cancelledDetail = manager.getJobDetail(queued.id);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      outputHash: null,
      error: { code: "AI_CANCELLED" },
    });
    expect(cancelledDetail.runs).toHaveLength(1);
    expect(cancelledDetail.runs[0]).toMatchObject({
      status: "cancelled",
      error: { code: "AI_CANCELLED" },
    });
    expect(cancelledDetail.events.map((event) => event.eventType)).not.toContain(
      "succeeded",
    );
    const hidden = await store.getCompletionProposalByJobId(queued.id);
    expect(hidden).toMatchObject({
      jobStatus: "cancelled",
      visible: false,
      ranking: {
        provider: provider.providerName,
        model: "post-persist-cancel-model",
        reasoningEffort: "high",
      },
    });
    expect(await manager.listCompletionProposals({ jobId: queued.id })).toEqual([]);
    await expect(manager.getCompletionProposalDetail(persistedProposalId)).rejects
      .toMatchObject({ code: "COMPLETION_PROPOSAL_NOT_FOUND" });

    const retry = await manager.retryJob(queued.id);
    const retried = await manager.waitForJob(retry.id);
    expect(retried).toMatchObject({
      status: "succeeded",
      retryOfJobId: queued.id,
      options: { rankingMode: "ai", reasoningEffort: "high" },
    });
    expect(provider.rankingCalls).toBe(2);
    expect(await manager.listCompletionProposals({ jobId: retry.id })).toHaveLength(1);
    expect(await manager.listCompletionProposals({ jobId: queued.id })).toEqual([]);
  });

  it("recovers only complete host proposals after a post-persist restart", async () => {
    const provider = new ScriptedProvider("recovery-host-provider", () => {
      throw new Error("Recovery must not invoke the semantic provider");
    });
    const { manager, store, imported } = await setup([provider]);
    const source = await createCompletionFixture(store, imported);
    const complete = await createInterruptedCompletionFixture(
      manager,
      store,
      source.revision.id,
      "host_only",
    );
    const corrupt = await createInterruptedCompletionFixture(
      manager,
      store,
      source.revision.id,
      "host_only",
    );
    const incomplete = await createInterruptedCompletionFixture(
      manager,
      store,
      source.revision.id,
      "host_only",
      false,
    );
    await writeFile(
      resolve(
        store.dataDirectory,
        corrupt.detail!.proposal.allowedMask.storagePath,
      ),
      new Uint8Array([0]),
    );
    await manager.close();

    const recoveredManager = restartManager(store, [provider]);
    const recovered = await recoveredManager.waitForJob(complete.job.id);

    expect(recovered).toMatchObject({
      status: "succeeded",
      outputHash: complete.proposal!.proposalHash,
      resultRevisionId: null,
      error: null,
    });
    expect(recoveredManager.getJobDetail(complete.job.id).events.map(
      (event) => event.eventType,
    )).toEqual(expect.arrayContaining([
      "completion_recovery_verified",
      "succeeded",
    ]));
    expect(await recoveredManager.listCompletionProposals({
      jobId: complete.job.id,
    })).toHaveLength(1);
    expect(recoveredManager.getJobDetail(complete.job.id).runs).toEqual([]);
    expect(recoveredManager.getJobDetail(corrupt.job.id).job).toMatchObject({
      status: "failed",
      outputHash: null,
      error: { code: "WORKER_RESTARTED" },
    });
    expect(recoveredManager.getJobDetail(incomplete.job.id).job).toMatchObject({
      status: "failed",
      outputHash: null,
      error: { code: "WORKER_RESTARTED" },
    });
  });

  it("recovers a complete AI-ranked proposal and its interrupted Run", async () => {
    const provider = new ScriptedCompletionRankingProvider(
      "recovery-ranking-provider",
      validCompletionRankingProposal,
    );
    const { manager, store, imported } = await setup([provider]);
    const source = await createCompletionFixture(store, imported);
    const interrupted = await createInterruptedCompletionFixture(
      manager,
      store,
      source.revision.id,
      "ai",
    );
    await manager.close();

    const recoveredManager = restartManager(store, [provider]);
    const recovered = await recoveredManager.waitForJob(interrupted.job.id);
    const detail = recoveredManager.getJobDetail(interrupted.job.id);

    expect(recovered).toMatchObject({
      status: "succeeded",
      provider: provider.providerName,
      model: "recovery-ranking-model",
      outputHash: interrupted.proposal!.proposalHash,
      options: { rankingMode: "ai", reasoningEffort: "high" },
      error: null,
    });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({
      status: "succeeded",
      attempt: 1,
      error: null,
    });
    expect(provider.rankingCalls).toBe(0);
    const proposal = await recoveredManager.getCompletionProposalDetail(
      interrupted.proposal!.proposalId,
    );
    expect(proposal).toMatchObject({
      visible: true,
      status: "awaiting_decision",
      ranking: {
        provider: provider.providerName,
        model: "recovery-ranking-model",
        reasoningEffort: "high",
      },
      decision: null,
      result: null,
    });
  });

  it("honors a persisted cancellation instead of recovering success", async () => {
    const provider = new ScriptedCompletionRankingProvider(
      "recovery-cancel-ranker",
      validCompletionRankingProposal,
    );
    const { manager, store, imported } = await setup([provider]);
    const source = await createCompletionFixture(store, imported);
    const interrupted = await createInterruptedCompletionFixture(
      manager,
      store,
      source.revision.id,
      "ai",
    );
    expect(manager.jobStore.requestCancellation(interrupted.job.id)).toMatchObject({
      status: "validating",
      cancelRequested: true,
    });
    await manager.close();

    const recoveredManager = restartManager(store, [provider]);
    const cancelled = await recoveredManager.waitForJob(interrupted.job.id);
    const detail = recoveredManager.getJobDetail(interrupted.job.id);

    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      outputHash: null,
      error: { code: "AI_CANCELLED" },
    });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({
      status: "cancelled",
      error: { code: "AI_CANCELLED" },
    });
    expect(detail.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["cancel_requested", "cancelled"]),
    );
    expect(detail.events.map((event) => event.eventType)).not.toContain(
      "completion_recovery_verified",
    );
    expect(detail.events.map((event) => event.eventType)).not.toContain(
      "succeeded",
    );
    expect(provider.rankingCalls).toBe(0);
    const hidden = await store.getCompletionProposalByJobId(interrupted.job.id);
    expect(hidden).toMatchObject({
      jobStatus: "cancelled",
      visible: false,
      ranking: {
        provider: provider.providerName,
        model: "recovery-ranking-model",
        reasoningEffort: "high",
      },
    });
    expect(await recoveredManager.listCompletionProposals({
      jobId: interrupted.job.id,
    })).toEqual([]);
    await expect(recoveredManager.getCompletionProposalDetail(
      interrupted.proposal.proposalId,
    )).rejects.toMatchObject({ code: "COMPLETION_PROPOSAL_NOT_FOUND" });
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
  }, 15_000);

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
    await expect(
      manager.retryJob(first.id, { semanticBaseline: "empty" }),
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

class ScriptedCompletionRankingProvider implements SkinSemanticAiProvider {
  rankingCalls = 0;

  constructor(
    readonly providerName: string,
    private readonly response: (
      input: ProviderCompletionRankingInput,
    ) => unknown | Promise<unknown>,
  ) {}

  async analyze(): Promise<ProviderAnalysisResult> {
    throw new Error("Semantic analysis was not expected in this test");
  }

  async rankCompletion(
    input: ProviderCompletionRankingInput,
  ): Promise<ProviderCompletionRankingResult> {
    this.rankingCalls += 1;
    input.onProgress?.({
      kind: "session",
      status: "started",
      message: "Completion ranking session started",
    });
    input.onProgress?.({
      kind: "output",
      status: "completed",
      message: "Completion ranking output generated",
    });
    return {
      proposal: await this.response(input),
      rawEvents:
        `${JSON.stringify({ type: "thread.started", thread_id: `completion_thread_${this.rankingCalls}` })}\n`,
      stderr: "",
      threadId: `completion_thread_${this.rankingCalls}`,
      usage: { input_tokens: 14 * this.rankingCalls, output_tokens: 7 },
    };
  }
}

async function setup(
  providers: readonly SkinSemanticAiProvider[],
  options: Pick<
    AiJobManagerOptions,
    "completionRanking" | "maxRepairAttempts" | "semanticFollowupAssessor"
  > = {},
): Promise<{
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
    ...options,
  });
  cleanups.push(async () => {
    await manager.close();
    store.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { manager, store, imported };
}

function restartManager(
  store: RevisionStore,
  providers: readonly SkinSemanticAiProvider[],
): AiJobManager {
  const manager = new AiJobManager({
    revisionStore: store,
    providers,
    dataDirectory: store.dataDirectory,
    skillDirectory,
  });
  cleanups.push(async () => await manager.close());
  return manager;
}

async function createInterruptedCompletionFixture(
  manager: AiJobManager,
  store: RevisionStore,
  sourceRevisionId: string,
  rankingMode: "host_only" | "ai",
  persist = true,
) {
  const revision = store.getRevision(sourceRevisionId);
  const [skinPng, semanticState, originDocument] = await Promise.all([
    store.readRevisionSkinPng(revision.id),
    store.readRevisionSemanticState(revision.id),
    store.readRevisionOrigin(revision.id),
  ]);
  if (!originDocument) throw new Error("Completion recovery fixture needs origin");
  const rankingProvider = manager.listCompletionRankingProviders()[0];
  if (rankingMode === "ai" && !rankingProvider) {
    throw new Error("Completion recovery fixture needs a ranking provider");
  }
  const options = rankingMode === "ai"
    ? {
        mode: "completion_proposal" as const,
        provider: rankingProvider!,
        model: "recovery-ranking-model",
        reasoningEffort: "high" as const,
        rankingMode: "ai" as const,
        targetComponentId: "clothing.completion",
        occludingComponentIds: ["hair.occluder"],
        representation: "latent_component" as const,
      }
    : {
        mode: "completion_proposal" as const,
        provider: COMPLETION_JOB_PROVIDER,
        model: COMPLETION_CANDIDATE_ALGORITHM_VERSION,
        rankingMode: "host_only" as const,
        targetComponentId: "clothing.completion",
        occludingComponentIds: ["hair.occluder"],
        representation: "latent_component" as const,
      };
  const job = manager.jobStore.createJob({
    kind: "completion_proposal",
    projectId: revision.projectId,
    inputRevisionId: revision.id,
    options,
    skillName: rankingMode === "ai"
      ? COMPLETION_RANKING_JOB_SKILL_NAME
      : COMPLETION_JOB_SKILL_NAME,
    skillVersion: rankingMode === "ai"
      ? COMPLETION_RANKING_PACK_SCHEMA_VERSION
      : COMPLETION_PROPOSAL_SCHEMA_VERSION,
    promptVersion: rankingMode === "ai"
      ? COMPLETION_RANKING_PROMPT_VERSION
      : COMPLETION_JOB_PROMPT_VERSION,
  });
  manager.jobStore.transitionJob(job.id, "preparing", "Preparing fixture");
  manager.jobStore.transitionJob(job.id, "running", "Generating fixture");
  const proposal = generateCompletionProposalCandidates({
    proposalId: `completion_${job.id.slice("aijob_".length)}`,
    sourceRevisionId: revision.id,
    sourceResultHash: revision.resultHash,
    sourceSkinHash: semanticState.document.source.sourceHash,
    image: decodeSkinPng(skinPng),
    semanticState,
    originDocument,
    targetComponentId: options.targetComponentId,
    occludingComponentIds: options.occludingComponentIds,
    representation: options.representation,
    hashCanonical: completionTestHash,
  });
  manager.jobStore.updateInputHash(
    job.id,
    rankingMode === "ai"
      ? completionTestHash(`recovery-pack:${job.id}`)
      : proposal.evidenceHash,
  );
  manager.jobStore.transitionJob(job.id, "validating", "Persisting fixture");

  let run = null;
  let ranking:
    | {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort: "high";
        readonly document: CompletionRankingProposal;
        readonly rankingHash: string;
      }
    | undefined;
  if (rankingMode === "ai") {
    const runId = `airun_${job.id.slice("aijob_".length)}`;
    run = manager.jobStore.createRun(
      job.id,
      manager.runStorage.workspaceDirectory(runId),
      runId,
    );
    for (const fileRole of [
      "input_manifest",
      "raw_events",
      "raw_output",
      "stderr",
      "validator_report",
    ] as const) {
      manager.jobStore.recordRunAsset({
        runId: run.id,
        fileRole,
        storagePath: `runs/${run.id}/${fileRole}`,
        mimeType: fileRole === "stderr" ? "text/plain" : "application/json",
        byteSize: 1,
        sha256: completionTestHash(fileRole),
      });
    }
    const candidateIds = proposal.candidates.map(
      (candidate) => candidate.candidateId,
    );
    const document: CompletionRankingProposal = {
      schemaVersion: "1.0",
      jobId: job.id,
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      sourceRevisionId: proposal.sourceRevisionId,
      sourceResultHash: proposal.sourceResultHash,
      sourceSkinHash: proposal.sourceSkinHash,
      rankings: candidateIds.map((candidateId) => ({
        candidateId,
        confidence: 0.8,
        explanation: "Visible continuity supports this order.",
      })),
      recommendation: candidateIds[0]
        ? {
            status: "recommend",
            candidateId: candidateIds[0],
            confidence: 0.8,
            explanation: "Visible continuity is strongest for the first item.",
          }
        : {
            status: "defer",
            candidateId: null,
            confidence: 0.2,
            explanation: "Evidence is insufficient for a recommendation.",
          },
    };
    ranking = {
      provider: options.provider,
      model: options.model,
      reasoningEffort: "high",
      document,
      rankingHash: completionTestHash(canonicalCompletionJson(document)),
    };
  }
  const detail = persist
    ? await store.createCompletionProposal({
        jobId: job.id,
        proposal,
        ...(ranking ? { ranking } : {}),
      })
    : null;
  return {
    job: manager.jobStore.getJob(job.id),
    proposal,
    detail,
    run,
  };
}

function completionTestHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validProposal(
  sourceRevisionId: string,
  regions: ProviderAnalysisInput["pack"]["candidateRegions"]["regions"],
): AnalysisProposal {
  const first = regions[0]!;
  return {
    schemaVersion: "1.2",
    sourceRevisionId,
    modelAssessment: { armType: "slim", confidence: 0.98 },
    appearanceInventory: {
      observations: [],
      summary: "未记录额外外观观察。",
    },
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

function semanticAnalysisOptions(
  provider: string,
  createRevisionOnSuccess = true,
) {
  return {
    mode: "full" as const,
    semanticBaseline: "empty" as const,
    provider,
    model: "provenance-guard-model",
    reasoningEffort: "medium" as const,
    taxonomyLevel: "coarse" as const,
    focus: ["hair"] as const,
    createRevisionOnSuccess,
  };
}

function validCompletionRankingProposal(
  input: ProviderCompletionRankingInput,
): CompletionRankingProposal {
  const candidateIds = input.pack.evidence.candidates
    .map(({ candidateId }) => candidateId)
    .reverse();
  return {
    schemaVersion: "1.0",
    jobId: input.jobId,
    proposalId: input.pack.evidence.proposalId,
    proposalHash: input.pack.evidence.proposalHash,
    sourceRevisionId: input.pack.evidence.sourceRevisionId,
    sourceResultHash: input.pack.evidence.sourceResultHash,
    sourceSkinHash: input.pack.evidence.sourceSkinHash,
    rankings: candidateIds.map((candidateId, index) => ({
      candidateId,
      confidence: Math.max(0.5, 0.9 - index * 0.1),
      explanation: "Visible continuity supports this relative position.",
    })),
    recommendation: candidateIds[0]
      ? {
          status: "recommend",
          candidateId: candidateIds[0],
          confidence: 0.85,
          explanation: "The strongest visible continuity evidence is ranked first.",
        }
      : {
          status: "defer",
          candidateId: null,
          confidence: 0.2,
          explanation: "There is not enough visible continuity evidence to recommend one.",
        },
  };
}

async function classifyHeadPixel(
  store: RevisionStore,
  imported: ImportProjectResult,
) {
  return store.applyManualOperation(imported.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: "hair.authored",
        displayName: "Authored hair",
        category: "hair",
      },
      spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
    },
  });
}

async function createCompletionFixture(
  store: RevisionStore,
  imported: ImportProjectResult,
) {
  const target = await store.applyManualOperation(imported.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: "clothing.completion",
        displayName: "Completion clothing",
        category: "upper_clothing",
      },
      spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
    },
  });
  return await store.applyManualOperation(target.revision.id, {
    operation: {
      type: "assign_pixels",
      target: {
        instanceId: "hair.occluder",
        displayName: "Completion occluder",
        category: "hair",
      },
      spans: [{ surface: "head.base.front", y: 8, x0: 9, x1: 9 }],
    },
  });
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
