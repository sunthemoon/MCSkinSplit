import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  AiJob,
  AiJobError,
  AiJobEvent,
  AiJobStatus,
  AiJobTransitionPatch,
  AiRun,
  AiRunAsset,
  AiRunFileRole,
  AiRunStatus,
  CreateAiJobInput,
} from "./types";

interface AiJobRow {
  readonly id: string;
  readonly project_id: string;
  readonly input_revision_id: string;
  readonly result_revision_id: string | null;
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

  createJob(input: CreateAiJobInput): AiJob {
    const id = this.id("job");
    const createdAt = this.now();
    const provider = visibleText("provider", input.options.provider, 80);
    const model = visibleText("model", input.options.model, 120);
    const insert = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO ai_job (
            id, project_id, input_revision_id, result_revision_id,
            retry_of_job_id, status, provider, model, skill_name,
            skill_version, prompt_version, input_hash, output_hash,
            options_json, review_items_json, proposal_summary,
            cancel_requested, created_at, started_at, finished_at, error_json
          ) VALUES (?, ?, ?, NULL, ?, 'queued', ?, ?, ?, ?, ?, NULL, NULL, ?, '[]', NULL, 0, ?, NULL, NULL, NULL)
        `)
        .run(
          id,
          input.projectId,
          input.inputRevisionId,
          input.retryOfJobId ?? null,
          provider,
          model,
          visibleText("skillName", input.skillName, 80),
          visibleText("skillVersion", input.skillVersion, 40),
          visibleText("promptVersion", input.promptVersion, 80),
          JSON.stringify(input.options),
          createdAt,
        );
      this.appendEventUnlocked(id, "queued", "AI 分析已进入队列", {
        provider,
        model,
        ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
      });
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

  listJobs(inputRevisionId?: string): AiJob[] {
    const rows = (inputRevisionId
      ? this.database
          .prepare("SELECT * FROM ai_job WHERE input_revision_id = ? ORDER BY created_at, id")
          .all(inputRevisionId)
      : this.database
          .prepare("SELECT * FROM ai_job ORDER BY created_at, id")
          .all()) as AiJobRow[];
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
              finished_at = ?, error_json = ?
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
          jobId,
        );
      this.appendEventUnlocked(jobId, status, visibleText("event message", message, 500), {
        ...(patch.validatorReport ? { validatorReport: patch.validatorReport } : {}),
        ...(patch.resultRevisionId ? { resultRevisionId: patch.resultRevisionId } : {}),
        ...(patch.error ? { error: patch.error } : {}),
      });
    });
    update.immediate();
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
      this.appendEventUnlocked(jobId, "cancel_requested", "已请求取消 AI 分析", {});
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
      this.transitionJob(job.id, "failed", "服务重启中断了 AI 分析", {
        error: { code: "WORKER_RESTARTED", message: "服务重启中断了 AI 分析，可创建重试任务" },
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
  return {
    id: row.id,
    projectId: row.project_id,
    inputRevisionId: row.input_revision_id,
    resultRevisionId: row.result_revision_id,
    retryOfJobId: row.retry_of_job_id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    skillName: row.skill_name,
    skillVersion: row.skill_version,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    options: parseJson(row.options_json),
    reviewItems: parseJson(row.review_items_json),
    proposalSummary: row.proposal_summary,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error_json ? parseJson(row.error_json) : null,
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
    usage: row.usage_json ? parseJson(row.usage_json) : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error_json ? parseJson(row.error_json) : null,
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
    data: parseJson(row.data_json),
    createdAt: row.created_at,
  };
}

function isAiJobStatus(value: string): value is AiJobStatus {
  return ["queued", "preparing", "running", "validating", "succeeded", "failed", "cancelled"].includes(value);
}

function isAiRunStatus(value: string): value is AiRunStatus {
  return ["running", "succeeded", "failed", "cancelled"].includes(value);
}

function isFileRole(value: string): value is AiRunFileRole {
  return ["input_manifest", "raw_events", "raw_output", "validator_report", "stderr"].includes(value);
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw corrupt("AI Job JSON 字段损坏", error);
  }
}

function visibleText(label: string, value: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AiJobStoreError("INVALID_AI_JOB", `${label} 必须为 1-${maxLength} 个可见字符`, 400);
  }
  return normalized;
}

function assertHash(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new AiJobStoreError("INVALID_AI_JOB", "AI hash 格式无效", 400);
  }
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
