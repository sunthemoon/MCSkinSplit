import type { Ref } from "react";
import type { ApiAiJobEvent } from "../lib/revisionApi";

export type SemanticAiEventRowKind =
  | "stage"
  | "tool"
  | "output"
  | "warning"
  | "terminal";

export type SemanticAiEventRowStatus =
  | "active"
  | "completed"
  | "recoverable"
  | "terminal"
  | null;

export interface SemanticAiEventRow {
  readonly key: string;
  readonly eventIds: readonly number[];
  readonly eventType: string;
  readonly kind: SemanticAiEventRowKind;
  readonly status: SemanticAiEventRowStatus;
  readonly message: string;
  readonly detail: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface ProjectedEventRow extends SemanticAiEventRow {
  readonly toolScope: string | null;
  readonly toolIdentity: string | null;
  readonly toolOperation: string | null;
}

interface RecoveredStructuredOutputFallback {
  readonly events: readonly ApiAiJobEvent[];
  readonly warning: ApiAiJobEvent;
  readonly recoveredBy: ApiAiJobEvent;
}

export interface SemanticAiEventLogProps {
  readonly events: readonly ApiAiJobEvent[];
  readonly running: boolean;
  readonly logRef?: Ref<HTMLOListElement>;
}

export function SemanticAiEventLog({
  events,
  running,
  logRef,
}: SemanticAiEventLogProps) {
  const rows = buildSemanticAiEventRows(events);

  return (
    <>
      <div className="ai-live-stream-heading">
        <span>LIVE PROCESS</span>
        <small>{running ? "实时刷新 · 自动跟随" : "运行记录"}</small>
      </div>
      <ol
        className="ai-event-log"
        ref={logRef}
        aria-label="AI 识别实时过程"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {rows.map((row) => (
          <li
            key={row.key}
            data-kind={row.kind}
            {...(row.status ? { "data-status": row.status } : {})}
          >
            <time dateTime={row.createdAt}>{formatEventTime(row.createdAt)}</time>
            <i aria-hidden="true" />
            <span className="ai-event-copy">
              <span>{row.message}</span>
              {row.detail && <small>{row.detail}</small>}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

export function buildSemanticAiEventRows(
  events: readonly ApiAiJobEvent[],
): readonly SemanticAiEventRow[] {
  const rows: ProjectedEventRow[] = [];
  const recoveredFallbacks = findRecoveredStructuredOutputFallbacks(events);
  const recoveredFallbackEvents = new Set(
    [...recoveredFallbacks.values()].flatMap((fallback) => [
      ...fallback.events.map((event) => event.id),
      fallback.warning.id,
    ]),
  );

  for (const event of events) {
    const recoveredFallback = recoveredFallbacks.get(event.id);
    if (recoveredFallback) {
      rows.push(projectRecoveredStructuredOutputFallback(recoveredFallback));
      continue;
    }
    if (recoveredFallbackEvents.has(event.id)) continue;

    if (event.eventType === "provider_tool") {
      projectToolEvent(rows, event);
      continue;
    }

    if (event.eventType === "provider_error") {
      const previous = rows.at(-1);
      if (
        previous?.eventType === event.eventType &&
        previous.message === event.message &&
        eventScope(event) === eventScopeFromRow(previous)
      ) {
        const repeatCount = previous.eventIds.length + 1;
        rows[rows.length - 1] = {
          ...previous,
          eventIds: [...previous.eventIds, event.id],
          completedAt: event.createdAt,
          detail: `模型阶段错误 · 重复 ${repeatCount} 次 · 非 Job 终态`,
        };
        continue;
      }
    }

    rows.push(projectStandaloneEvent(event));
  }

  return rows.map(({ toolScope: _scope, toolIdentity: _identity, toolOperation: _operation, ...row }) => row);
}

function findRecoveredStructuredOutputFallbacks(
  events: readonly ApiAiJobEvent[],
): ReadonlyMap<number, RecoveredStructuredOutputFallback> {
  const fallbacks = new Map<number, RecoveredStructuredOutputFallback>();

  for (let warningIndex = 0; warningIndex < events.length; warningIndex += 1) {
    const warning = events[warningIndex]!;
    if (!isStructuredOutputFallbackWarning(warning)) continue;

    const providerErrors: ApiAiJobEvent[] = [];
    for (let errorIndex = warningIndex - 1; errorIndex >= 0; errorIndex -= 1) {
      const candidate = events[errorIndex]!;
      if (candidate.eventType !== "provider_error") break;
      if (!isStructuredOutputCapabilityError(candidate)) break;
      if (
        providerErrors.length > 0 &&
        eventScope(candidate) !== eventScope(providerErrors[0]!)
      ) {
        break;
      }
      providerErrors.unshift(candidate);
    }
    if (providerErrors.length === 0) continue;

    const recoveredBy = findFallbackRecoveryEvent(
      events,
      warningIndex + 1,
      providerErrors[0]!,
    );
    if (!recoveredBy) continue;

    const fallback = {
      events: providerErrors,
      warning,
      recoveredBy,
    } satisfies RecoveredStructuredOutputFallback;
    fallbacks.set(providerErrors[0]!.id, fallback);
  }

  return fallbacks;
}

function projectRecoveredStructuredOutputFallback(
  fallback: RecoveredStructuredOutputFallback,
): ProjectedEventRow {
  const firstError = fallback.events[0]!;
  return {
    key: `ai-event-${firstError.id}`,
    eventIds: [
      ...fallback.events.map((event) => event.id),
      fallback.warning.id,
    ],
    eventType: fallback.warning.eventType,
    kind: "warning",
    status: "completed",
    message: "已启用兼容 JSON 校验",
    detail: "原生结构化请求失败 · 模型分析已自动继续",
    createdAt: firstError.createdAt,
    completedAt: fallback.recoveredBy.createdAt,
    toolScope: eventScope(firstError),
    toolIdentity: null,
    toolOperation: null,
  };
}

function isStructuredOutputFallbackWarning(event: ApiAiJobEvent): boolean {
  return event.eventType === "provider_warning" &&
    /(?:结构化输出|原生结构化请求).*(?:本地\s*JSON\s*校验|兼容)/i.test(event.message);
}

function isStructuredOutputCapabilityError(event: ApiAiJobEvent): boolean {
  if (event.message === "Codex 报告运行错误") return true;

  const evidence = [event.message, ...dataStringValues(event.data)].join(" ");
  return /(?:structured[_ -]?output|response[_ -]?format|json[_ -]?schema|结构化输出)/i.test(
    evidence,
  );
}

function findFallbackRecoveryEvent(
  events: readonly ApiAiJobEvent[],
  startIndex: number,
  providerError: ApiAiJobEvent,
): ApiAiJobEvent | null {
  for (let index = startIndex; index < events.length; index += 1) {
    const candidate = events[index]!;
    if (candidate.eventType === "failed" || candidate.eventType === "cancelled") {
      return null;
    }
    if (
      candidate.eventType === "provider_error" ||
      candidate.eventType === "provider_warning" ||
      providerEventStatus(candidate) === "failed"
    ) {
      continue;
    }
    if (!eventsShareProviderScope(providerError, candidate)) continue;
    return candidate;
  }
  return null;
}

function eventsShareProviderScope(
  providerError: ApiAiJobEvent,
  candidate: ApiAiJobEvent,
): boolean {
  const errorRunId = visibleDataString(providerError.data.runId);
  const candidateRunId = visibleDataString(candidate.data.runId);
  if (errorRunId && candidateRunId && errorRunId !== candidateRunId) return false;

  const errorAttempt = visibleDataNumber(providerError.data.attempt);
  const candidateAttempt = visibleDataNumber(candidate.data.attempt);
  return errorAttempt === null || candidateAttempt === null || errorAttempt === candidateAttempt;
}

function dataStringValues(data: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.values(data).flatMap((value) => {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object") return [];
    return Object.values(value).filter((nested): nested is string => typeof nested === "string");
  });
}

function projectToolEvent(rows: ProjectedEventRow[], event: ApiAiJobEvent): void {
  const providerStatus = providerEventStatus(event);
  const scope = eventScope(event);
  const identity = toolIdentity(event);
  const operation = toolOperation(event);

  if (providerStatus === "started") {
    rows.push({
      key: `ai-event-${event.id}`,
      eventIds: [event.id],
      eventType: event.eventType,
      kind: "tool",
      status: "active",
      message: event.message,
      detail: toolDetail(event, "active", null),
      createdAt: event.createdAt,
      completedAt: null,
      toolScope: scope,
      toolIdentity: identity,
      toolOperation: operation,
    });
    return;
  }

  const pairedIndex = findPendingTool(rows, scope, identity, operation);
  const rowStatus = providerStatus === "failed" ? "recoverable" : "completed";
  if (pairedIndex >= 0) {
    const started = rows[pairedIndex]!;
    rows[pairedIndex] = {
      ...started,
      eventIds: [...started.eventIds, event.id],
      status: rowStatus,
      message: event.message,
      detail: toolDetail(event, rowStatus, elapsedMilliseconds(started.createdAt, event.createdAt)),
      completedAt: event.createdAt,
    };
    return;
  }

  rows.push({
    key: `ai-event-${event.id}`,
    eventIds: [event.id],
    eventType: event.eventType,
    kind: "tool",
    status: rowStatus,
    message: event.message,
    detail: toolDetail(event, rowStatus, null),
    createdAt: event.createdAt,
    completedAt: event.createdAt,
    toolScope: scope,
    toolIdentity: identity,
    toolOperation: operation,
  });
}

function findPendingTool(
  rows: readonly ProjectedEventRow[],
  scope: string,
  identity: string | null,
  operation: string,
): number {
  const pendingInScope = (row: ProjectedEventRow) =>
    row.eventType === "provider_tool" &&
    row.status === "active" &&
    row.toolScope === scope;

  if (identity) {
    const exact = rows.findIndex(
      (row) => pendingInScope(row) && row.toolIdentity === identity,
    );
    return exact;
  }

  const sameOperation = rows.findIndex(
    (row) => pendingInScope(row) && row.toolOperation === operation,
  );
  if (sameOperation >= 0) return sameOperation;
  return rows.findIndex(pendingInScope);
}

function projectStandaloneEvent(event: ApiAiJobEvent): ProjectedEventRow {
  const terminal = event.eventType === "failed" || event.eventType === "cancelled";
  const providerError = event.eventType === "provider_error";
  const warning = providerError || event.eventType === "provider_warning";
  const output = event.eventType === "provider_output" || event.eventType === "provider_usage";

  return {
    key: `ai-event-${event.id}`,
    eventIds: [event.id],
    eventType: event.eventType,
    kind: terminal ? "terminal" : warning ? "warning" : output ? "output" : "stage",
    status: terminal ? "terminal" : providerError ? "recoverable" : null,
    message: normalizeEventMessage(event),
    detail: terminal
      ? "Job 终态"
      : providerError
        ? "模型阶段错误 · 非 Job 终态"
        : null,
    createdAt: event.createdAt,
    completedAt: event.createdAt,
    toolScope: providerError ? eventScope(event) : null,
    toolIdentity: null,
    toolOperation: null,
  };
}

function normalizeEventMessage(event: ApiAiJobEvent): string {
  if (
    event.eventType === "provider_output" &&
    event.message === "候选分类提案已生成"
  ) {
    return "模型已返回阶段性说明";
  }
  return event.message;
}

function providerEventStatus(
  event: ApiAiJobEvent,
): "started" | "completed" | "failed" | null {
  const status = event.data.status;
  return status === "started" || status === "completed" || status === "failed"
    ? status
    : null;
}

function eventScope(event: ApiAiJobEvent): string {
  const runId = visibleDataString(event.data.runId) ?? event.jobId;
  const attempt = visibleDataNumber(event.data.attempt);
  return `${runId}:${attempt ?? "unknown"}`;
}

function eventScopeFromRow(row: ProjectedEventRow): string {
  return row.toolScope ?? row.key;
}

function toolIdentity(event: ApiAiJobEvent): string | null {
  for (const key of ["toolCallId", "itemId", "callId", "operationId"] as const) {
    const value = visibleDataString(event.data[key]);
    if (value) return `${key}:${value}`;
  }
  return null;
}

function toolOperation(event: ApiAiJobEvent): string {
  for (const key of ["toolType", "itemType", "operationType"] as const) {
    const value = visibleDataString(event.data[key]);
    if (value) return value;
  }

  const message = event.message;
  if (message.includes("本地分析工具")) return "local-command";
  if (message.includes("调用分析工具") || message.includes("工具调用")) return "tool-call";
  if (message.includes("检索辅助资料")) return "web-search";
  if (message.includes("分析文件")) return "file-change";
  if (message.includes("分析步骤")) return "plan";
  return "generic-tool";
}

function toolDetail(
  event: ApiAiJobEvent,
  status: Exclude<SemanticAiEventRowStatus, "terminal" | null>,
  derivedDurationMs: number | null,
): string {
  const details: string[] = [];
  const label = visibleDataString(event.data.commandSummary)
    ?? visibleDataString(event.data.toolLabel);
  if (label) details.push(label);

  const exitCode = visibleDataNumber(event.data.exitCode);
  if (exitCode !== null) details.push(`EXIT ${exitCode}`);

  const durationMs = visibleDataNumber(event.data.durationMs) ?? derivedDurationMs;
  if (durationMs !== null && durationMs >= 0) details.push(formatDuration(durationMs));

  if (status === "active") details.push("执行中");
  if (status === "completed") details.push("已合并开始/完成事件");
  if (status === "recoverable") details.push("单次工具失败 · 非 Job 终态");
  return details.join(" · ");
}

function elapsedMilliseconds(startedAt: string, completedAt: string): number | null {
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return null;
  }
  return completed - started;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.round(durationMs / 1_000)} s`;
}

function visibleDataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function visibleDataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
