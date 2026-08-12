import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isSemanticCategory } from "@mc-skin-split/skin-core";
import Database from "better-sqlite3";
import type {
  AiAnalysisOptions,
  AiJob,
  AiJobError,
  AiJobEvent,
  AiJobKind,
  AiJobListFilters,
  AiJobOptions,
  AiJobStatus,
  AiJobTransitionPatch,
  AiRestorationRecommendationOptions,
  AiRun,
  AiRunAsset,
  AiRunFileRole,
  AiRunStatus,
  CreateAiJobInput,
  CreateRestorationRecommendationAiJobInput,
  CreateSemanticAnalysisAiJobInput,
  RestorationRecommendationAiJob,
  SemanticAnalysisAiJob,
} from "./types";
import { ANALYSIS_REASONING_EFFORTS } from "./types";

interface AiJobRow {
  readonly id: string;
  readonly job_kind: string;
  readonly project_id: string;
  readonly input_revision_id: string;
  readonly result_revision_id: string | null;
  readonly composition_id: string | null;
  readonly retry_of_job_id: string | null;
  readonly status: string;
  readonly provider: string;
  readonly model: string;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly prompt_version: string;
  readonly input_hash: string | null;
  readonly output_hash: string | null;
  readonly options_json: string;
  readonly review_items_json: string;
  readonly proposal_summary: string | null;
  readonly advisory_result_json: string | null;
  readonly cancel_requested: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly error_json: string | null;
}

interface AiRunRow {
  readonly id: string;
  readonly job_id: string;
  readonly provider: string;
  readonly model: string;
  readonly thread_id: string | null;
  readonly attempt: number;
  readonly status: string;
  readonly workspace_path: string;
  readonly usage_json: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly error_json: string | null;
}

interface AiRunAssetRow {
  readonly id: string;
  readonly run_id: string;
  readonly file_role: string;
  readonly storage_path: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly created_at: string;
}

interface AiJobEventRow {
  readonly id: number;
  readonly job_id: string;
  readonly event_type: string;
  readonly message: string;
  readonly data_json: string;
  readonly created_at: string;
}

export class AiJobStoreError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AiJobStoreError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface AiJobStoreOptions {
  readonly databasePath: string;
  readonly now?: () => Date | string;
  readonly createId?: (kind: "job" | "run" | "asset") => string;
}

export class AiJobStore {
  readonly databasePath: string;
  private readonly database: Database.Database;
  private readonly nowProvider: () => Date | string;
  private readonly idProvider: (kind: "job" | "run" | "asset") => string;

  constructor(options: AiJobStoreOptions) {
    this.databasePath = resolve(options.databasePath);
    this.database = new Database(this.databasePath, { timeout: 5_000 });
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("trusted_schema = OFF");
    this.assertSchema();
    this.nowProvider = options.now ?? (() => new Date());
    this.idProvider = options.createId ?? defaultId;
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  createJob(input: CreateSemanticAnalysisAiJobInput): SemanticAnalysisAiJob;
  createJob(
    input: CreateRestorationRecommendationAiJobInput,
  ): RestorationRecommendationAiJob;
  createJob(input: CreateAiJobInput): AiJob;
  createJob(input: CreateAiJobInput): AiJob {
    const id = this.id("job");
    const createdAt = this.now();
    const compositionId = validateCreateJobInput(input);
    const options = validateOptionsForWrite(input.options, input.kind, compositionId);
    const provider = options.provider;
    const model = options.model;
    const insert = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO ai_job (
            id, job_kind, project_id, input_revision_id, result_revision_id,
            composition_id, retry_of_job_id, status, provider, model, skill_name,
            skill_version, prompt_version, input_hash, output_hash,
            options_json, review_items_json, proposal_summary,
            advisory_result_json, cancel_requested, created_at, started_at,
            finished_at, error_json
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'queued', ?, ?, ?, ?, ?, NULL, NULL, ?, '[]', NULL, NULL, 0, ?, NULL, NULL, NULL)
        `)
        .run(
          id,
          input.kind,
          input.projectId,
          input.inputRevisionId,
          compositionId,
          input.retryOfJobId ?? null,
          provider,
          model,
          visibleText("skillName", input.skillName, 80),
          visibleText("skillVersion", input.skillVersion, 40),
          visibleText("promptVersion", input.promptVersion, 80),
          JSON.stringify(options),
          createdAt,
        );
      this.appendEventUnlocked(
        id,
        "queued",
        input.kind === "semantic_analysis"
          ? "AI 分析已进入队列"
          : "AI 换装建议已进入队列",
        {
        kind: input.kind,
        provider,
        model,
        ...(compositionId ? { compositionId } : {}),
        ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
        },
      );
    });
    try {
      insert.immediate();
    } catch (error) {
      throw databaseError(error);
    }
    return this.getJob(id);
  }

  getJob(jobId: string): AiJob {
    const row = this.database
      .prepare("SELECT * FROM ai_job WHERE id = ?")
      .get(jobId) as AiJobRow | undefined;
    if (!row) throw notFound("AI Job", jobId);
    return mapJob(row);
  }

  listJobs(filters: AiJobListFilters = {}): AiJob[] {
    const where: string[] = [];
    const parameters: string[] = [];
    if (filters.inputRevisionId !== undefined) {
      where.push("input_revision_id = ?");
      parameters.push(visibleText("inputRevisionId", filters.inputRevisionId, 120));
    }
    if (filters.kind !== undefined) {
      if (!isAiJobKind(filters.kind)) {
        throw new AiJobStoreError("INVALID_AI_JOB", "AI Job kind 无效", 400);
      }
      where.push("job_kind = ?");
      parameters.push(filters.kind);
    }
    if (filters.compositionId !== undefined) {
      where.push("composition_id = ?");
      parameters.push(visibleText("compositionId", filters.compositionId, 120));
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM ai_job${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`,
      )
      .all(...parameters) as AiJobRow[];
    return rows.map(mapJob);
  }

  transitionJob(
    jobId: string,
    status: AiJobStatus,
    message: string,
    patch: AiJobTransitionPatch = {},
  ): AiJob {
    const current = this.getJob(jobId);
    if (!allowedTransition(current.status, status)) {
      throw conflict(`AI Job 状态不能从 ${current.status} 变为 ${status}`, {
        jobId,
      });
    }
    validateTransitionPatch(current, status, patch);
    const now = this.now();
    const startedAt = current.startedAt ?? (status === "preparing" ? now : null);
    const terminal = isTerminal(status);
    const error = patch.error ?? (terminal && status !== "succeeded" ? current.error : null);
    const update = this.database.transaction(() => {
      this.database
        .prepare(`
          UPDATE ai_job
          SET status = ?, input_hash = ?, output_hash = ?, result_revision_id = ?,
              review_items_json = ?, proposal_summary = ?, started_at = ?,
              finished_at = ?, error_json = ?, advisory_result_json = ?
          WHERE id = ?
        `)
        .run(
          status,
          patch.inputHash ?? current.inputHash,
          patch.outputHash ?? current.outputHash,
          patch.resultRevisionId ?? current.resultRevisionId,
          JSON.stringify(patch.reviewItems ?? current.reviewItems),
          patch.proposalSummary ?? current.proposalSummary,
          startedAt,
          terminal ? now : null,
          error ? JSON.stringify(error) : null,
          patch.advisoryResult
            ? JSON.stringify(patch.advisoryResult)
            : current.advisoryResult
              ? JSON.stringify(current.advisoryResult)
              : null,
          jobId,
        );
      this.appendEventUnlocked(jobId, status, visibleText("event message", message, 500), {
        ...(patch.validatorReport ? { validatorReport: patch.validatorReport } : {}),
        ...(patch.resultRevisionId ? { resultRevisionId: patch.resultRevisionId } : {}),
        ...(patch.advisoryResult
          ? { advisoryDecisionCount: patch.advisoryResult.decisions.length }
          : {}),
        ...(patch.error ? { error: patch.error } : {}),
      });
    });
    try {
      update.immediate();
    } catch (error) {
      throw databaseError(error);
    }
    return this.getJob(jobId);
  }

  updateInputHash(jobId: string, inputHash: string): AiJob {
    assertHash(inputHash);
    this.getJob(jobId);
    this.database
      .prepare("UPDATE ai_job SET input_hash = ? WHERE id = ?")
      .run(inputHash, jobId);
    return this.getJob(jobId);
  }

  requestCancellation(jobId: string): AiJob {
    const current = this.getJob(jobId);
    if (isTerminal(current.status) || current.cancelRequested) return current;
    const update = this.database.transaction(() => {
      this.database
        .prepare("UPDATE ai_job SET cancel_requested = 1 WHERE id = ?")
        .run(jobId);
      this.appendEventUnlocked(
        jobId,
        "cancel_requested",
        current.kind === "restoration_recommendation"
          ? "已请求取消 AI 换装建议"
          : "已请求取消 AI 分析",
        {},
      );
    });
    update.immediate();
    return this.getJob(jobId);
  }

  createRun(jobId: string, workspacePath: string, runId?: string): AiRun {
    const job = this.getJob(jobId);
    if (isTerminal(job.status)) throw conflict("终态 AI Job 不能创建 Run", { jobId });
    const attemptRow = this.database
      .prepare("SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM ai_run WHERE job_id = ?")
      .get(jobId) as { attempt: number };
    const id = runId ?? this.id("run");
    if (runId && !/^[a-z][a-z0-9_-]{2,100}$/.test(runId)) {
      throw new AiJobStoreError("INVALID_ID", "AI Run ID 不安全", 500);
    }
    const startedAt = this.now();
    const insert = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO ai_run (
            id, job_id, provider, model, thread_id, attempt, status,
            workspace_path, usage_json, started_at, finished_at, error_json
          ) VALUES (?, ?, ?, ?, NULL, ?, 'running', ?, NULL, ?, NULL, NULL)
        `)
        .run(
          id,
          job.id,
          job.provider,
          job.model,
          attemptRow.attempt,
          workspacePath,
          startedAt,
        );
      this.appendEventUnlocked(jobId, "run_started", `开始第 ${attemptRow.attempt} 次模型调用`, {
        runId: id,
        attempt: attemptRow.attempt,
      });
    });
    insert.immediate();
    return this.getRun(id);
  }

  getRun(runId: string): AiRun {
    const row = this.database
      .prepare("SELECT * FROM ai_run WHERE id = ?")
      .get(runId) as AiRunRow | undefined;
    if (!row) throw notFound("AI Run", runId);
    return mapRun(row);
  }

  listRuns(jobId: string): AiRun[] {
    this.getJob(jobId);
    return (
      this.database
        .prepare("SELECT * FROM ai_run WHERE job_id = ? ORDER BY attempt, id")
        .all(jobId) as AiRunRow[]
    ).map(mapRun);
  }

  finishRun(input: {
    readonly runId: string;
    readonly status: Exclude<AiRunStatus, "running">;
    readonly threadId?: string;
    readonly usage?: Readonly<Record<string, unknown>>;
    readonly error?: AiJobError;
  }): AiRun {
    const run = this.getRun(input.runId);
    if (run.status !== "running") {
      throw conflict("AI Run 已经结束", { runId: run.id });
    }
    const finishedAt = this.now();
    this.database
      .prepare(`
        UPDATE ai_run
        SET status = ?, thread_id = ?, usage_json = ?, finished_at = ?, error_json = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        input.threadId ?? null,
        input.usage ? JSON.stringify(input.usage) : null,
        finishedAt,
        input.error ? JSON.stringify(input.error) : null,
        run.id,
      );
    return this.getRun(run.id);
  }

  recordRunAsset(input: {
    readonly runId: string;
    readonly fileRole: AiRunFileRole;
    readonly storagePath: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly sha256: string;
  }): AiRunAsset {
    this.getRun(input.runId);
    assertHash(input.sha256);
    const id = this.id("asset");
    const createdAt = this.now();
    this.database
      .prepare(`
        INSERT INTO ai_run_asset (
          id, run_id, file_role, storage_path, mime_type,
          byte_size, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.runId,
        input.fileRole,
        input.storagePath,
        input.mimeType,
        input.byteSize,
        input.sha256,
        createdAt,
      );
    return this.getRunAsset(id);
  }

  listRunAssets(runId: string): AiRunAsset[] {
    this.getRun(runId);
    return (
      this.database
        .prepare("SELECT * FROM ai_run_asset WHERE run_id = ? ORDER BY file_role, id")
        .all(runId) as AiRunAssetRow[]
    ).map(mapRunAsset);
  }

  listEvents(jobId: string): AiJobEvent[] {
    this.getJob(jobId);
    return (
      this.database
        .prepare("SELECT * FROM ai_job_event WHERE job_id = ? ORDER BY id")
        .all(jobId) as AiJobEventRow[]
    ).map(mapEvent);
  }

  appendEvent(
    jobId: string,
    eventType: string,
    message: string,
    data: Readonly<Record<string, unknown>> = {},
  ): void {
    this.getJob(jobId);
    if (!/^[a-z][a-z0-9_]{1,60}$/u.test(eventType)) {
      throw new AiJobStoreError("INVALID_AI_JOB", "AI event type 格式无效", 500);
    }
    this.appendEventUnlocked(
      jobId,
      eventType,
      visibleText("event message", message, 500),
      data,
    );
  }

  failInterruptedJobs(): number {
    const rows = this.database
      .prepare("SELECT id FROM ai_job WHERE status IN ('queued', 'preparing', 'running', 'validating')")
      .all() as { id: string }[];
    for (const row of rows) {
      const job = this.getJob(row.id);
      const taskName = job.kind === "restoration_recommendation"
        ? "AI 换装建议"
        : "AI 分析";
      this.transitionJob(job.id, "failed", `服务重启中断了${taskName}`, {
        error: {
          code: "WORKER_RESTARTED",
          message: `服务重启中断了${taskName}，可创建重试任务`,
        },
      });
      this.database
        .prepare(`
          UPDATE ai_run
          SET status = 'failed', finished_at = ?, error_json = ?
          WHERE job_id = ? AND status = 'running'
        `)
        .run(
          this.now(),
          JSON.stringify({ code: "WORKER_RESTARTED", message: "服务重启中断了模型调用" }),
          job.id,
        );
    }
    return rows.length;
  }

  private getRunAsset(assetId: string): AiRunAsset {
    const row = this.database
      .prepare("SELECT * FROM ai_run_asset WHERE id = ?")
      .get(assetId) as AiRunAssetRow | undefined;
    if (!row) throw notFound("AI Run Asset", assetId);
    return mapRunAsset(row);
  }

  private appendEventUnlocked(
    jobId: string,
    eventType: string,
    message: string,
    data: Readonly<Record<string, unknown>>,
  ): void {
    this.database
      .prepare(`
        INSERT INTO ai_job_event (job_id, event_type, message, data_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(jobId, eventType, message, JSON.stringify(data), this.now());
  }

  private id(kind: "job" | "run" | "asset"): string {
    const value = this.idProvider(kind);
    if (!/^[a-z][a-z0-9_-]{2,100}$/.test(value)) {
      throw new AiJobStoreError("INVALID_ID", `ID provider 返回了不安全的 ${kind} ID`, 500);
    }
    return value;
  }

  private now(): string {
    const value = this.nowProvider();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new AiJobStoreError("INVALID_CLOCK", "AI Job clock 返回无效时间", 500);
    }
    return date.toISOString();
  }

  private assertSchema(): void {
    const row = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_job'")
      .get() as { name: string } | undefined;
    if (!row) {
      this.database.close();
      throw new AiJobStoreError("AI_SCHEMA_MISSING", "AI Job 数据库迁移尚未执行", 500);
    }
  }
}

const TRANSITIONS: Readonly<Record<AiJobStatus, readonly AiJobStatus[]>> = {
  queued: ["preparing", "cancelled", "failed"],
  preparing: ["running", "cancelled", "failed"],
  running: ["validating", "cancelled", "failed"],
  validating: ["running", "succeeded", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

function allowedTransition(from: AiJobStatus, to: AiJobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: AiJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function mapJob(row: AiJobRow): AiJob {
  if (!isAiJobStatus(row.status)) throw corrupt(`未知 AI Job 状态：${row.status}`);
  if (!isAiJobKind(row.job_kind)) {
    throw corrupt(`未知 AI Job 类型：${row.job_kind}`);
  }
  const options = parseJobOptions(row);
  if (options.provider !== row.provider || options.model !== row.model) {
    throw corrupt("AI Job options 与 provider/model 列不一致");
  }
  const reviewItems = parseJsonArray(row.review_items_json, "review_items_json");
  const advisoryResult = row.advisory_result_json
    ? parseAdvisoryResult(row.advisory_result_json, row, options)
    : null;
  const common = {
    id: row.id,
    kind: row.job_kind,
    projectId: row.project_id,
    inputRevisionId: row.input_revision_id,
    resultRevisionId: row.result_revision_id,
    compositionId: row.composition_id,
    retryOfJobId: row.retry_of_job_id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    skillName: row.skill_name,
    skillVersion: row.skill_version,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    options,
    reviewItems,
    proposalSummary: row.proposal_summary,
    advisoryResult,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error_json ? parseJobError(row.error_json) : null,
  };
  if (row.job_kind === "semantic_analysis") {
    if (
      row.composition_id !== null ||
      row.advisory_result_json !== null ||
      options.mode !== "full"
    ) {
      throw corrupt("semantic_analysis Job 存储结构无效");
    }
    return {
      ...common,
      kind: "semantic_analysis",
      compositionId: null,
      options,
      advisoryResult: null,
      reviewItems: reviewItems as SemanticAnalysisAiJob["reviewItems"],
    };
  }
  if (
    row.composition_id === null ||
    row.result_revision_id !== null ||
    options.mode !== "restoration_recommendation" ||
    reviewItems.length !== 0 ||
    (row.status === "succeeded") !== (advisoryResult !== null)
  ) {
    throw corrupt("restoration_recommendation Job 存储结构无效");
  }
  return {
    ...common,
    kind: "restoration_recommendation",
    resultRevisionId: null,
    compositionId: row.composition_id,
    options,
    reviewItems: [],
    advisoryResult,
  };
}

function mapRun(row: AiRunRow): AiRun {
  if (!isAiRunStatus(row.status)) throw corrupt(`未知 AI Run 状态：${row.status}`);
  return {
    id: row.id,
    jobId: row.job_id,
    provider: row.provider,
    model: row.model,
    threadId: row.thread_id,
    attempt: row.attempt,
    status: row.status,
    workspacePath: row.workspace_path,
    usage: row.usage_json ? parseJsonRecord(row.usage_json, "usage_json") : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error_json ? parseJobError(row.error_json) : null,
  };
}

function mapRunAsset(row: AiRunAssetRow): AiRunAsset {
  if (!isFileRole(row.file_role)) throw corrupt(`未知 AI Run 文件角色：${row.file_role}`);
  return {
    id: row.id,
    runId: row.run_id,
    fileRole: row.file_role,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function mapEvent(row: AiJobEventRow): AiJobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    eventType: row.event_type,
    message: row.message,
    data: parseJsonRecord(row.data_json, "data_json"),
    createdAt: row.created_at,
  };
}

function isAiJobStatus(value: string): value is AiJobStatus {
  return ["queued", "preparing", "running", "validating", "succeeded", "failed", "cancelled"].includes(value);
}

function isAiJobKind(value: string): value is AiJobKind {
  return value === "semantic_analysis" || value === "restoration_recommendation";
}

function isAiRunStatus(value: string): value is AiRunStatus {
  return ["running", "succeeded", "failed", "cancelled"].includes(value);
}

function isFileRole(value: string): value is AiRunFileRole {
  return ["input_manifest", "raw_events", "raw_output", "validator_report", "stderr"].includes(value);
}

function parseJsonUnknown(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw corrupt(`AI Job ${field} JSON 损坏`, error);
  }
}

function parseJsonArray(value: string, field: string): unknown[] {
  const parsed = parseJsonUnknown(value, field);
  if (!Array.isArray(parsed)) throw corrupt(`AI Job ${field} 必须是数组`);
  return parsed;
}

function parseJsonRecord(
  value: string,
  field: string,
): Readonly<Record<string, unknown>> {
  const parsed = parseJsonUnknown(value, field);
  if (!isRecord(parsed)) throw corrupt(`AI Job ${field} 必须是对象`);
  return parsed;
}

function validateCreateJobInput(input: CreateAiJobInput): string | null {
  visibleText("projectId", input.projectId, 120);
  visibleText("inputRevisionId", input.inputRevisionId, 120);
  if (input.retryOfJobId !== undefined) {
    visibleText("retryOfJobId", input.retryOfJobId, 120);
  }
  if (input.kind === "semantic_analysis") return null;
  const compositionId = visibleText("compositionId", input.compositionId, 120);
  if (input.options.compositionId.trim() !== compositionId) {
    throw invalid("compositionId 与 options.compositionId 不一致");
  }
  return compositionId;
}

function validateOptionsForWrite(
  value: AiJobOptions,
  kind: AiJobKind,
  compositionId: string | null,
): AiJobOptions {
  const parsed = validateJobOptions(value, kind, compositionId, invalid);
  return parsed;
}

function parseJobOptions(row: AiJobRow): AiJobOptions {
  return validateJobOptions(
    parseJsonUnknown(row.options_json, "options_json"),
    row.job_kind as AiJobKind,
    row.composition_id,
    (message) => corrupt(message),
  );
}

function validateJobOptions(
  value: unknown,
  kind: AiJobKind,
  compositionId: string | null,
  failure: (message: string) => AiJobStoreError,
): AiJobOptions {
  if (!isRecord(value)) throw failure("AI Job options 必须是对象");
  if (kind === "semantic_analysis") {
    assertExactKeys(
      value,
      [
        "mode",
        "provider",
        "model",
        "reasoningEffort",
        "taxonomyLevel",
        "focus",
        "createRevisionOnSuccess",
      ],
      "semantic_analysis options",
      failure,
    );
    if (
      value.mode !== "full" ||
      value.taxonomyLevel !== "coarse" ||
      !isReasoningEffort(value.reasoningEffort) ||
      !Array.isArray(value.focus) ||
      !value.focus.every(isSemanticCategory) ||
      new Set(value.focus).size !== value.focus.length ||
      typeof value.createRevisionOnSuccess !== "boolean"
    ) {
      throw failure("semantic_analysis options 无效");
    }
    return {
      mode: "full",
      provider: validateTextValue(value.provider, "provider", 80, failure),
      model: validateTextValue(value.model, "model", 120, failure),
      reasoningEffort: value.reasoningEffort,
      taxonomyLevel: "coarse",
      focus: value.focus,
      createRevisionOnSuccess: value.createRevisionOnSuccess,
    } satisfies AiAnalysisOptions;
  }

  assertExactKeys(
    value,
    [
      "mode",
      "provider",
      "model",
      "reasoningEffort",
      "userIntent",
      "compositionId",
      "compositionVersion",
      "candidateSetHash",
      "targetComponentIds",
    ],
    "restoration_recommendation options",
    failure,
    ["donorRevisionId", "manualRgba"],
  );
  if (
    value.mode !== "restoration_recommendation" ||
    !isReasoningEffort(value.reasoningEffort) ||
    !Number.isInteger(value.compositionVersion) ||
    (value.compositionVersion as number) < 0 ||
    typeof value.candidateSetHash !== "string" ||
    !isHash(value.candidateSetHash) ||
    !Array.isArray(value.targetComponentIds) ||
    value.targetComponentIds.length < 1 ||
    value.targetComponentIds.length > 256 ||
    new Set(value.targetComponentIds).size !== value.targetComponentIds.length ||
    !value.targetComponentIds.every(isComponentId) ||
    (value.donorRevisionId !== undefined &&
      !validTextValue(value.donorRevisionId, 120)) ||
    (value.manualRgba !== undefined && !isOpaqueRgba(value.manualRgba))
  ) {
    throw failure("restoration_recommendation options 无效");
  }
  const storedCompositionId = validateTextValue(
    value.compositionId,
    "compositionId",
    120,
    failure,
  );
  if (compositionId === null || storedCompositionId !== compositionId) {
    throw failure("restoration_recommendation compositionId 绑定无效");
  }
  return {
    mode: "restoration_recommendation",
    provider: validateTextValue(value.provider, "provider", 80, failure),
    model: validateTextValue(value.model, "model", 120, failure),
    reasoningEffort: value.reasoningEffort,
    userIntent: validateTextValue(value.userIntent, "userIntent", 1_000, failure),
    compositionId: storedCompositionId,
    compositionVersion: value.compositionVersion as number,
    candidateSetHash: value.candidateSetHash,
    targetComponentIds: value.targetComponentIds as string[],
    ...(value.donorRevisionId !== undefined
      ? { donorRevisionId: (value.donorRevisionId as string).trim() }
      : {}),
    ...(value.manualRgba !== undefined
      ? { manualRgba: value.manualRgba as [number, number, number, number] }
      : {}),
  } satisfies AiRestorationRecommendationOptions;
}

function parseAdvisoryResult(
  value: string,
  row: AiJobRow,
  options: AiJobOptions,
): NonNullable<AiJob["advisoryResult"]> {
  const parsed = parseJsonUnknown(value, "advisory_result_json");
  if (!isRecord(parsed)) throw corrupt("AI advisory result 必须是对象");
  assertExactKeys(
    parsed,
    ["schemaVersion", "jobId", "compositionId", "candidateSetHash", "decisions", "summary"],
    "AI advisory result",
    (message) => corrupt(message),
  );
  if (
    options.mode !== "restoration_recommendation" ||
    parsed.schemaVersion !== "1.0" ||
    parsed.jobId !== row.id ||
    parsed.compositionId !== row.composition_id ||
    parsed.candidateSetHash !== options.candidateSetHash ||
    !Array.isArray(parsed.decisions) ||
    parsed.decisions.length > 6 ||
    !validTextValue(parsed.summary, 300)
  ) {
    throw corrupt("AI advisory result 任务绑定或结构无效");
  }
  let previousGroup: string | null = null;
  const seenGroups = new Set<string>();
  for (const decision of parsed.decisions) {
    if (!isRecord(decision)) throw corrupt("AI advisory decision 必须是对象");
    assertExactKeys(
      decision,
      ["targetGroupId", "selectedCandidateId", "rankedCandidateIds", "confidence", "explanation"],
      "AI advisory decision",
      (message) => corrupt(message),
    );
    if (
      typeof decision.targetGroupId !== "string" ||
      !TARGET_GROUP_PATTERN.test(decision.targetGroupId) ||
      seenGroups.has(decision.targetGroupId) ||
      (previousGroup !== null && previousGroup >= decision.targetGroupId) ||
      !Array.isArray(decision.rankedCandidateIds) ||
      decision.rankedCandidateIds.length < 1 ||
      new Set(decision.rankedCandidateIds).size !== decision.rankedCandidateIds.length ||
      !decision.rankedCandidateIds.every(isCandidateId) ||
      (decision.selectedCandidateId !== null &&
        !isCandidateId(decision.selectedCandidateId)) ||
      (decision.selectedCandidateId !== null &&
        decision.rankedCandidateIds[0] !== decision.selectedCandidateId) ||
      typeof decision.confidence !== "number" ||
      !Number.isFinite(decision.confidence) ||
      decision.confidence < 0 ||
      decision.confidence > 1 ||
      !validTextValue(decision.explanation, 240)
    ) {
      throw corrupt("AI advisory decision 无效");
    }
    previousGroup = decision.targetGroupId;
    seenGroups.add(decision.targetGroupId);
  }
  return parsed as unknown as NonNullable<AiJob["advisoryResult"]>;
}

function parseJobError(value: string): AiJobError {
  const parsed = parseJsonUnknown(value, "error_json");
  if (!isRecord(parsed)) throw corrupt("AI Job error 必须是对象");
  assertExactKeys(parsed, ["code", "message"], "AI Job error", (message) => corrupt(message), ["details"]);
  if (
    !validTextValue(parsed.code, 120) ||
    !validTextValue(parsed.message, 1_000) ||
    (parsed.details !== undefined && !isRecord(parsed.details))
  ) {
    throw corrupt("AI Job error 无效");
  }
  return parsed as unknown as AiJobError;
}

function validateTransitionPatch(
  job: AiJob,
  status: AiJobStatus,
  patch: AiJobTransitionPatch,
): void {
  if (patch.inputHash !== undefined) assertHash(patch.inputHash);
  if (patch.outputHash !== undefined) assertHash(patch.outputHash);
  if (job.kind === "semantic_analysis") {
    if (patch.advisoryResult !== undefined) {
      throw invalid("semantic_analysis Job 不能保存 advisory result");
    }
    return;
  }
  if (patch.resultRevisionId !== undefined) {
    throw invalid("restoration_recommendation Job 不能生成 Revision");
  }
  if (patch.reviewItems !== undefined && patch.reviewItems.length !== 0) {
    throw invalid("restoration_recommendation reviewItems 必须为空");
  }
  if (status === "succeeded") {
    if (!patch.advisoryResult) {
      throw invalid("restoration_recommendation 成功时必须提供 advisory result");
    }
    validateAdvisoryResultForWrite(patch.advisoryResult, job);
  } else if (patch.advisoryResult !== undefined) {
    throw invalid("advisory result 只能在 Job 成功时保存");
  }
}

function validateAdvisoryResultForWrite(
  proposal: NonNullable<AiJob["advisoryResult"]>,
  job: RestorationRecommendationAiJob,
): void {
  const syntheticRow = {
    id: job.id,
    composition_id: job.compositionId,
  } as AiJobRow;
  parseAdvisoryResult(JSON.stringify(proposal), syntheticRow, job.options);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  label: string,
  failure: (message: string) => AiJobStoreError,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw failure(`${label} 字段集无效`);
  }
}

function validateTextValue(
  value: unknown,
  label: string,
  maxLength: number,
  failure: (message: string) => AiJobStoreError,
): string {
  if (!validTextValue(value, maxLength)) {
    throw failure(`${label} 必须为 1-${maxLength} 个可见字符`);
  }
  return value.trim();
}

function validTextValue(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isReasoningEffort(value: unknown): value is AiAnalysisOptions["reasoningEffort"] {
  return ANALYSIS_REASONING_EFFORTS.includes(value as AiAnalysisOptions["reasoningEffort"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComponentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "unknown" &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value) &&
    value.length <= 100
  );
}

function isOpaqueRgba(value: unknown): value is readonly [number, number, number, 255] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255) &&
    value[3] === 255
  );
}

function isHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isCandidateId(value: unknown): value is string {
  return typeof value === "string" && /^restore_[0-9a-f]{64}$/u.test(value);
}

const TARGET_GROUP_PATTERN = /^(?:head|torso|leftArm|rightArm|leftLeg|rightLeg)_base$/u;

function visibleText(label: string, value: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AiJobStoreError("INVALID_AI_JOB", `${label} 必须为 1-${maxLength} 个可见字符`, 400);
  }
  return normalized;
}

function assertHash(value: string): void {
  if (!isHash(value)) {
    throw new AiJobStoreError("INVALID_AI_JOB", "AI hash 格式无效", 400);
  }
}

function invalid(message: string): AiJobStoreError {
  return new AiJobStoreError("INVALID_AI_JOB", message, 400);
}

function defaultId(kind: "job" | "run" | "asset"): string {
  const prefix = kind === "job" ? "aijob" : kind === "run" ? "airun" : "aiasset";
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function notFound(kind: string, id: string): AiJobStoreError {
  return new AiJobStoreError("AI_NOT_FOUND", `${kind} 不存在：${id}`, 404);
}

function conflict(message: string, details?: Readonly<Record<string, unknown>>): AiJobStoreError {
  return new AiJobStoreError("AI_JOB_CONFLICT", message, 409, details);
}

function corrupt(message: string, cause?: unknown): AiJobStoreError {
  return new AiJobStoreError("AI_JOB_CORRUPT", message, 500, {
    ...(cause instanceof Error ? { cause: cause.message } : {}),
  });
}

function databaseError(error: unknown): AiJobStoreError {
  if (error instanceof AiJobStoreError) return error;
  if (error instanceof Error && "code" in error && String((error as Error & { code: unknown }).code).includes("FOREIGNKEY")) {
    return new AiJobStoreError("INVALID_AI_JOB", "AI Job 引用了不存在的 Project、Revision 或重试任务", 400);
  }
  return corrupt("AI Job 数据库写入失败", error);
}
