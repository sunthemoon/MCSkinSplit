import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_SKILL_NAME,
  AI_SKILL_VERSION,
  ANALYSIS_PROPOSAL_SCHEMA,
  AiProviderError,
  validateAnalysisProposal,
  type ProposalValidationReport,
  type SkinSemanticAiProvider,
} from "@mc-skin-split/ai-provider";
import {
  PROMPT_VERSION,
  buildAnalysisPack,
  verifyAnalysisPackIntegrity,
} from "@mc-skin-split/skin-analysis-pack";
import { decodeSkinPng } from "@mc-skin-split/skin-core";
import {
  RevisionStore,
  RevisionStoreError,
} from "@mc-skin-split/skin-revision";
import {
  AiJobStore,
  AiJobStoreError,
  isTerminal,
} from "./ai-job-store";
import { AiRunStorage } from "./run-storage";
import type {
  AiAnalysisOptions,
  AiJob,
  AiJobDetail,
  AiJobError,
  AiRun,
} from "./types";

export interface AiJobManagerOptions {
  readonly revisionStore: RevisionStore;
  readonly providers: readonly SkinSemanticAiProvider[];
  readonly dataDirectory?: string;
  readonly skillDirectory?: string;
  readonly jobStore?: AiJobStore;
  readonly maxRepairAttempts?: number;
  readonly recoverInterruptedJobs?: boolean;
}

export class AiJobManager {
  readonly revisionStore: RevisionStore;
  readonly jobStore: AiJobStore;
  readonly runStorage: AiRunStorage;
  readonly skillDirectory: string;
  readonly maxRepairAttempts: number;
  private readonly providers = new Map<string, SkinSemanticAiProvider>();
  private readonly active = new Map<
    string,
    { readonly controller: AbortController; readonly promise: Promise<void> }
  >();
  private readonly ownsJobStore: boolean;
  private closed = false;

  constructor(options: AiJobManagerOptions) {
    this.revisionStore = options.revisionStore;
    const dataDirectory = resolve(
      options.dataDirectory ?? options.revisionStore.dataDirectory,
    );
    this.jobStore =
      options.jobStore ??
      new AiJobStore({ databasePath: options.revisionStore.databasePath });
    this.ownsJobStore = !options.jobStore;
    this.runStorage = new AiRunStorage(dataDirectory);
    this.skillDirectory = resolve(
      options.skillDirectory ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../../.agents/skills/mc-skin-segmenter",
        ),
    );
    this.maxRepairAttempts = options.maxRepairAttempts ?? 1;
    if (
      !Number.isInteger(this.maxRepairAttempts) ||
      this.maxRepairAttempts < 0 ||
      this.maxRepairAttempts > 3
    ) {
      throw new TypeError("maxRepairAttempts must be an integer from 0 to 3");
    }
    for (const provider of options.providers) {
      if (this.providers.has(provider.providerName)) {
        throw new TypeError(`Duplicate AI provider: ${provider.providerName}`);
      }
      this.providers.set(provider.providerName, provider);
    }
    if (this.providers.size === 0) throw new TypeError("At least one AI provider is required");
    if (options.recoverInterruptedJobs ?? true) this.jobStore.failInterruptedJobs();
  }

  listProviders(): readonly string[] {
    return [...this.providers.keys()].sort();
  }

  startAnalysis(
    sourceRevisionId: string,
    options: AiAnalysisOptions,
  ): AiJob {
    this.assertOpen();
    this.requireProvider(options.provider);
    const revision = this.revisionStore.getRevision(sourceRevisionId);
    const branch = this.revisionStore.getBranch(revision.branchId);
    if (
      options.createRevisionOnSuccess &&
      branch.headRevisionId !== revision.id
    ) {
      throw new AiJobStoreError(
        "AI_JOB_CONFLICT",
        "只能分析并提交所选 Branch 的最新 Revision",
        409,
        { sourceRevisionId, branchHeadRevisionId: branch.headRevisionId },
      );
    }
    const job = this.jobStore.createJob({
      projectId: revision.projectId,
      inputRevisionId: revision.id,
      options: normalizeOptions(options),
      skillName: AI_SKILL_NAME,
      skillVersion: AI_SKILL_VERSION,
      promptVersion: PROMPT_VERSION,
    });
    this.schedule(job.id);
    return job;
  }

  retryJob(
    jobId: string,
    overrides: Partial<
      Pick<
        AiAnalysisOptions,
        "provider" | "model" | "reasoningEffort" | "createRevisionOnSuccess"
      >
    > = {},
  ): AiJob {
    this.assertOpen();
    const source = this.jobStore.getJob(jobId);
    if (!isTerminal(source.status)) {
      throw new AiJobStoreError(
        "AI_JOB_CONFLICT",
        "运行中的 AI Job 不能创建重试",
        409,
      );
    }
    const options = normalizeOptions({
      ...source.options,
      ...(overrides.provider ? { provider: overrides.provider } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
      ...(overrides.reasoningEffort
        ? { reasoningEffort: overrides.reasoningEffort }
        : {}),
      ...(overrides.createRevisionOnSuccess !== undefined
        ? { createRevisionOnSuccess: overrides.createRevisionOnSuccess }
        : {}),
    });
    this.requireProvider(options.provider);
    const revision = this.revisionStore.getRevision(source.inputRevisionId);
    const branch = this.revisionStore.getBranch(revision.branchId);
    if (
      options.createRevisionOnSuccess &&
      branch.headRevisionId !== revision.id
    ) {
      throw new AiJobStoreError(
        "AI_JOB_CONFLICT",
        "来源 Revision 已不是 Branch HEAD，请在最新 Revision 新建分析",
        409,
      );
    }
    const retry = this.jobStore.createJob({
      projectId: source.projectId,
      inputRevisionId: source.inputRevisionId,
      options,
      skillName: AI_SKILL_NAME,
      skillVersion: AI_SKILL_VERSION,
      promptVersion: PROMPT_VERSION,
      retryOfJobId: source.id,
    });
    this.schedule(retry.id);
    return retry;
  }

  cancelJob(jobId: string): AiJob {
    const job = this.jobStore.requestCancellation(jobId);
    this.active.get(jobId)?.controller.abort();
    if (!this.active.has(jobId) && !isTerminal(job.status)) {
      return this.jobStore.transitionJob(job.id, "cancelled", "AI 分析已取消", {
        error: { code: "AI_CANCELLED", message: "用户取消了 AI 分析" },
      });
    }
    return this.jobStore.getJob(jobId);
  }

  getJobDetail(jobId: string): AiJobDetail {
    const job = this.jobStore.getJob(jobId);
    const runs = this.jobStore.listRuns(job.id).map((run) => ({
      ...run,
      assets: this.jobStore.listRunAssets(run.id),
    }));
    return { job, runs, events: this.jobStore.listEvents(job.id) };
  }

  listJobs(inputRevisionId?: string): AiJob[] {
    return this.jobStore.listJobs(inputRevisionId);
  }

  async waitForJob(jobId: string): Promise<AiJob> {
    await this.active.get(jobId)?.promise;
    return this.jobStore.getJob(jobId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((active) => active.promise),
    );
    if (this.ownsJobStore) this.jobStore.close();
  }

  private schedule(jobId: string): void {
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.executeJob(jobId, controller.signal))
      .finally(() => this.active.delete(jobId));
    this.active.set(jobId, { controller, promise });
  }

  private async executeJob(jobId: string, signal: AbortSignal): Promise<void> {
    let currentRun: AiRun | null = null;
    try {
      this.assertNotCancelled(jobId, signal);
      let job = this.jobStore.transitionJob(
        jobId,
        "preparing",
        "正在生成只读分析包",
      );
      const provider = this.requireProvider(job.provider);
      const skinPng = await this.revisionStore.readRevisionSkinPng(
        job.inputRevisionId,
      );
      const image = decodeSkinPng(skinPng);
      const previousSegmentation = (
        await this.revisionStore.readRevisionSemanticState(
        job.inputRevisionId,
        )
      ).document;
      const sourceRevision = this.revisionStore.getRevision(job.inputRevisionId);
      let repairReport: ProposalValidationReport | undefined;
      const maximumAttempts = this.maxRepairAttempts + 1;

      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        this.assertNotCancelled(jobId, signal);
        const provisionalRunId = `airun_${cryptoRandomSuffix()}`;
        const provisionalWorkspace = this.runStorage.workspaceDirectory(provisionalRunId);
        currentRun = this.jobStore.createRun(
          jobId,
          provisionalWorkspace,
          provisionalRunId,
        );
        const workspace = await this.runStorage.createWorkspace(currentRun.id);
        if (workspace !== currentRun.workspacePath) {
          throw new Error("AI Run workspace identity mismatch");
        }
        const pack = await buildAnalysisPack({
          workspaceDirectory: workspace,
          skillDirectory: this.skillDirectory,
          proposalSchema: ANALYSIS_PROPOSAL_SCHEMA,
          jobId,
          runId: currentRun.id,
          projectId: job.projectId,
          sourceRevisionId: job.inputRevisionId,
          sourceResultHash: sourceRevision.resultHash,
          skinPng,
          armType: previousSegmentation.source.armType,
          previousSegmentation,
          provider: job.provider,
          model: job.model,
          reasoningEffort: job.options.reasoningEffort,
          focus: job.options.focus,
          createRevisionOnSuccess: job.options.createRevisionOnSuccess,
          skillVersion: job.skillVersion,
        });
        if (attempt === 1) job = this.jobStore.updateInputHash(job.id, pack.inputHash);
        else if (job.inputHash !== pack.inputHash) {
          throw new Error("Repair analysis pack changed its deterministic input hash");
        }
        if (repairReport) {
          await this.runStorage.writeJson(
            currentRun.id,
            "logs/previous-validator-report.json",
            repairReport,
          );
        }
        job = this.jobStore.transitionJob(
          job.id,
          "running",
          attempt === 1 ? "Codex 正在分析皮肤" : "Codex 正在修复无效提案",
        );
        this.assertNotCancelled(jobId, signal);
        const providerResult = await provider.analyze({
          jobId,
          runId: currentRun.id,
          attempt,
          model: job.model,
          pack,
          ...(repairReport ? { repairReport } : {}),
          signal,
        });
        await verifyAnalysisPackIntegrity(pack);
        await Promise.all([
          this.runStorage.writeJson(
            currentRun.id,
            "output/analysis-proposal.json",
            providerResult.proposal,
          ),
          this.runStorage.writeText(
            currentRun.id,
            "logs/codex-events.jsonl",
            providerResult.rawEvents,
          ),
          this.runStorage.writeText(
            currentRun.id,
            "logs/codex-stderr.log",
            providerResult.stderr,
          ),
        ]);
        job = this.jobStore.transitionJob(
          job.id,
          "validating",
          "正在校验 AI 提案与像素归属",
        );
        const validation = validateAnalysisProposal({
          proposal: providerResult.proposal,
          pack,
          image,
          aiRunId: currentRun.id,
        });
        await this.runStorage.writeJson(
          currentRun.id,
          "logs/validator-report.json",
          validation.report,
        );
        const assets = await this.inspectRunAssets(currentRun.id);
        for (const asset of assets) {
          this.jobStore.recordRunAsset({
            runId: currentRun.id,
            fileRole: asset.fileRole,
            storagePath: asset.storagePath,
            mimeType: asset.mimeType,
            byteSize: asset.byteSize,
            sha256: asset.sha256,
          });
        }
        const outputHash = assets.find(
          (asset) => asset.fileRole === "raw_output",
        )!.sha256;

        if (validation.report.valid && validation.state) {
          this.assertNotCancelled(jobId, signal);
          let resultRevisionId: string | undefined;
          if (job.options.createRevisionOnSuccess) {
            const committed = await this.revisionStore.commitAiSegmentation(
              job.inputRevisionId,
              {
                state: validation.state,
                aiJobId: job.id,
                aiRunId: currentRun.id,
                provider: job.provider,
                model: job.model,
                proposalSummary: validation.proposal.summary,
                reviewItems: validation.proposal.reviewItems,
              },
            );
            resultRevisionId = committed.revision.id;
          }
          this.jobStore.finishRun({
            runId: currentRun.id,
            status: "succeeded",
            ...(providerResult.threadId
              ? { threadId: providerResult.threadId }
              : {}),
            ...(providerResult.usage ? { usage: providerResult.usage } : {}),
          });
          currentRun = null;
          this.jobStore.transitionJob(job.id, "succeeded", "AI 提案已验证并完成", {
            outputHash,
            ...(resultRevisionId ? { resultRevisionId } : {}),
            reviewItems: validation.proposal.reviewItems,
            proposalSummary: validation.proposal.summary,
            validatorReport: validation.report,
          });
          return;
        }

        const validationError: AiJobError = {
          code: "AI_PROPOSAL_INVALID",
          message: `AI 提案未通过校验（${validation.report.errors.length} 项）`,
          details: { validatorReport: validation.report },
        };
        this.jobStore.finishRun({
          runId: currentRun.id,
          status: "failed",
          ...(providerResult.threadId ? { threadId: providerResult.threadId } : {}),
          ...(providerResult.usage ? { usage: providerResult.usage } : {}),
          error: validationError,
        });
        currentRun = null;
        repairReport = validation.report;
        if (attempt < maximumAttempts) continue;
        throw new AiJobStoreError(
          validationError.code,
          validationError.message,
          422,
          validationError.details,
        );
      }
    } catch (error) {
      const failure = errorToJobError(error);
      if (currentRun?.status === "running") {
        if (error instanceof AiProviderError) {
          await this.persistProviderFailureAssets(currentRun.id, error);
        }
        this.jobStore.finishRun({
          runId: currentRun.id,
          status:
            failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          error: failure,
        });
      }
      const job = this.jobStore.getJob(jobId);
      if (!isTerminal(job.status)) {
        this.jobStore.transitionJob(
          job.id,
          failure.code === "AI_CANCELLED" ? "cancelled" : "failed",
          failure.code === "AI_CANCELLED" ? "AI 分析已取消" : "AI 分析失败",
          { error: failure },
        );
      }
    }
  }

  private async inspectRunAssets(runId: string) {
    return await Promise.all([
      this.runStorage.inspectFile(
        runId,
        "input_manifest",
        "input/manifest.json",
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "raw_events",
        "logs/codex-events.jsonl",
        "application/x-ndjson",
      ),
      this.runStorage.inspectFile(
        runId,
        "raw_output",
        "output/analysis-proposal.json",
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "validator_report",
        "logs/validator-report.json",
        "application/json",
      ),
      this.runStorage.inspectFile(
        runId,
        "stderr",
        "logs/codex-stderr.log",
        "text/plain",
      ),
    ]);
  }

  private async persistProviderFailureAssets(
    runId: string,
    error: AiProviderError,
  ): Promise<void> {
    try {
      await Promise.all([
        this.runStorage.writeText(
          runId,
          "logs/codex-events.jsonl",
          error.rawEvents ?? "",
        ),
        this.runStorage.writeText(
          runId,
          "logs/codex-stderr.log",
          error.stderr ?? "",
        ),
      ]);
      const assets = await Promise.all([
        this.runStorage.inspectFile(
          runId,
          "input_manifest",
          "input/manifest.json",
          "application/json",
        ),
        this.runStorage.inspectFile(
          runId,
          "raw_events",
          "logs/codex-events.jsonl",
          "application/x-ndjson",
        ),
        this.runStorage.inspectFile(
          runId,
          "stderr",
          "logs/codex-stderr.log",
          "text/plain",
        ),
      ]);
      for (const asset of assets) {
        this.jobStore.recordRunAsset({
          runId,
          fileRole: asset.fileRole,
          storagePath: asset.storagePath,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
        });
      }
    } catch {
      // Preserve the original provider failure even if diagnostic persistence fails.
    }
  }

  private assertNotCancelled(jobId: string, signal: AbortSignal): void {
    const job = this.jobStore.getJob(jobId);
    if (signal.aborted || job.cancelRequested) {
      throw new AiProviderError("AI_CANCELLED", "用户取消了 AI 分析");
    }
  }

  private requireProvider(providerName: string): SkinSemanticAiProvider {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new AiJobStoreError(
        "AI_PROVIDER_UNAVAILABLE",
        `AI Provider 不可用：${providerName}`,
        400,
        { availableProviders: this.listProviders() },
      );
    }
    return provider;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AiJobStoreError("AI_WORKER_CLOSED", "AI Worker 已关闭", 503);
    }
  }
}

function normalizeOptions(options: AiAnalysisOptions): AiAnalysisOptions {
  return {
    mode: "full",
    provider: options.provider.trim(),
    model: options.model.trim(),
    reasoningEffort: options.reasoningEffort,
    taxonomyLevel: "coarse",
    focus: [...new Set(options.focus)].sort(),
    createRevisionOnSuccess: options.createRevisionOnSuccess,
  };
}

function errorToJobError(error: unknown): AiJobError {
  if (error instanceof AiProviderError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof AiJobStoreError || error instanceof RevisionStoreError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    code: "AI_WORKER_FAILED",
    message: error instanceof Error ? error.message : "AI Worker 无法完成任务",
  };
}

function cryptoRandomSuffix(): string {
  return randomUUID().replaceAll("-", "");
}
