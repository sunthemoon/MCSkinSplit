import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiAiJobEvent } from "../lib/revisionApi";
import {
  SemanticAiEventLog,
  buildSemanticAiEventRows,
} from "./SemanticAiEventLog";

describe("semantic AI event log", () => {
  it("pairs tool start and completion into one concise row", () => {
    const rows = buildSemanticAiEventRows([
      event(1, "provider_tool", "正在运行本地分析工具", {
        runId: "run_1",
        attempt: 1,
        kind: "tool",
        status: "started",
      }),
      event(2, "provider_tool", "本地分析工具执行完成", {
        runId: "run_1",
        attempt: 1,
        kind: "tool",
        status: "completed",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventIds: [1, 2],
      kind: "tool",
      status: "completed",
      message: "本地分析工具执行完成",
      createdAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:00:02.000Z",
    });
    expect(rows[0]?.detail).toContain("1.0 s");
    expect(rows[0]?.detail).toContain("已合并开始/完成事件");
  });

  it("pairs concurrent tools FIFO within one run and keeps runs isolated", () => {
    const rows = buildSemanticAiEventRows([
      event(1, "provider_tool", "正在运行本地分析工具", tool("started", "run_1")),
      event(2, "provider_tool", "正在运行本地分析工具", tool("started", "run_1")),
      event(3, "provider_tool", "正在运行本地分析工具", tool("started", "run_2")),
      event(4, "provider_tool", "本地分析工具执行完成", tool("completed", "run_1")),
      event(5, "provider_tool", "本地分析工具执行完成", tool("completed", "run_2")),
    ]);

    expect(rows.map((row) => ({ ids: row.eventIds, status: row.status }))).toEqual([
      { ids: [1, 4], status: "completed" },
      { ids: [2], status: "active" },
      { ids: [3, 5], status: "completed" },
    ]);
  });

  it("uses provider identities and visible metadata when they become available", () => {
    const rows = buildSemanticAiEventRows([
      event(1, "provider_tool", "正在运行本地分析工具", {
        ...tool("started", "run_1"),
        itemId: "item_a",
      }),
      event(2, "provider_tool", "正在运行本地分析工具", {
        ...tool("started", "run_1"),
        itemId: "item_b",
      }),
      event(3, "provider_tool", "本地分析工具执行完成", {
        ...tool("completed", "run_1"),
        itemId: "item_b",
        commandSummary: "inspect-job.mjs",
        exitCode: 0,
        durationMs: 125,
      }),
    ]);

    expect(rows[0]).toMatchObject({ eventIds: [1], status: "active" });
    expect(rows[1]).toMatchObject({ eventIds: [2, 3], status: "completed" });
    expect(rows[1]?.detail).toContain("inspect-job.mjs");
    expect(rows[1]?.detail).toContain("EXIT 0");
    expect(rows[1]?.detail).toContain("125 ms");
  });

  it("does not pair a known provider identity with a different pending tool", () => {
    const rows = buildSemanticAiEventRows([
      event(1, "provider_tool", "正在运行本地分析工具", {
        ...tool("started", "run_1"),
        itemId: "item_a",
      }),
      event(2, "provider_tool", "本地分析工具执行完成", {
        ...tool("completed", "run_1"),
        itemId: "item_b",
      }),
    ]);

    expect(rows.map((row) => ({ ids: row.eventIds, status: row.status }))).toEqual([
      { ids: [1], status: "active" },
      { ids: [2], status: "completed" },
    ]);
  });

  it("marks a failed tool as recoverable while reserving terminal style for the job", () => {
    const events = [
      event(1, "provider_tool", "正在运行本地分析工具", tool("started", "run_1")),
      event(2, "provider_tool", "本地分析工具执行完成（失败）", {
        ...tool("failed", "run_1"),
        exitCode: 1,
      }),
      event(3, "provider_output", "候选分类提案已生成", {
        runId: "run_1",
        attempt: 1,
        kind: "output",
        status: "completed",
      }),
      event(4, "failed", "AI 分析失败", {
        error: { code: "AI_TIMEOUT" },
      }),
    ];
    const rows = buildSemanticAiEventRows(events);

    expect(rows[0]).toMatchObject({ kind: "tool", status: "recoverable" });
    expect(rows[0]?.detail).toContain("单次工具失败 · 非 Job 终态");
    expect(rows[1]).toMatchObject({
      kind: "output",
      status: null,
      message: "模型已返回阶段性说明",
    });
    expect(rows[2]).toMatchObject({ kind: "terminal", status: "terminal" });

    const html = renderToStaticMarkup(
      createElement(SemanticAiEventLog, { events, running: false }),
    );
    expect(html.match(/data-status="recoverable"/g)).toHaveLength(1);
    expect(html.match(/data-kind="terminal"/g)).toHaveLength(1);
    expect(html).toContain("非 Job 终态");
    expect(html).toContain("Job 终态");
    expect(html).not.toContain("候选分类提案已生成");
  });

  it("collapses duplicate provider errors without treating them as terminal", () => {
    const rows = buildSemanticAiEventRows([
      event(1, "provider_error", "Codex 报告运行错误", {
        runId: "run_1",
        attempt: 1,
        kind: "error",
        status: "failed",
      }),
      event(2, "provider_error", "Codex 报告运行错误", {
        runId: "run_1",
        attempt: 1,
        kind: "error",
        status: "failed",
      }),
      event(3, "provider_warning", "结构化输出不可用，已切换本地 JSON 校验"),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      eventIds: [1, 2],
      kind: "warning",
      status: "recoverable",
    });
    expect(rows[0]?.detail).toContain("重复 2 次");
    expect(rows[1]).toMatchObject({ kind: "warning", status: null });
  });

  it("projects a recovered structured-output fallback as one completed warning", () => {
    const events = [
      event(1, "provider_error", "Codex 报告运行错误", {
        runId: "run_1",
        attempt: 1,
        kind: "error",
        status: "failed",
      }),
      event(2, "provider_error", "Codex 报告运行错误", {
        runId: "run_1",
        attempt: 1,
        kind: "error",
        status: "failed",
      }),
      event(3, "provider_warning", "结构化输出不可用，已切换本地 JSON 校验"),
      event(4, "provider_session", "Codex 会话已建立", {
        runId: "run_1",
        attempt: 1,
        status: "started",
      }),
    ];
    const rows = buildSemanticAiEventRows(events);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      eventIds: [1, 2, 3],
      eventType: "provider_warning",
      kind: "warning",
      status: "completed",
      message: "已启用兼容 JSON 校验",
      detail: "原生结构化请求失败 · 模型分析已自动继续",
      completedAt: "2026-08-13T00:00:04.000Z",
    });

    const html = renderToStaticMarkup(
      createElement(SemanticAiEventLog, { events, running: true }),
    );
    expect(html).toContain("已启用兼容 JSON 校验");
    expect(html).not.toContain("模型阶段错误");
    expect(html).not.toContain('data-status="recoverable"');
  });

  it("keeps unrelated provider errors visible beside a fallback warning", () => {
    const rows = buildSemanticAiEventRows([
      event(1, "provider_error", "Codex 认证失败", {
        runId: "run_1",
        attempt: 1,
        status: "failed",
      }),
      event(2, "provider_warning", "结构化输出不可用，已切换本地 JSON 校验"),
      event(3, "provider_session", "Codex 会话已建立", {
        runId: "run_1",
        attempt: 1,
        status: "started",
      }),
    ]);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      kind: "warning",
      status: "recoverable",
      message: "Codex 认证失败",
    });
    expect(rows[1]).toMatchObject({ kind: "warning", status: null });
  });

  it("preserves a terminal job failure after a recovered fallback", () => {
    const rows = buildSemanticAiEventRows([
      event(1, "provider_error", "Codex 报告运行错误", {
        runId: "run_1",
        attempt: 1,
        status: "failed",
      }),
      event(2, "provider_warning", "结构化输出不可用，已切换本地 JSON 校验"),
      event(3, "provider_session", "Codex 会话已建立", {
        runId: "run_1",
        attempt: 1,
        status: "started",
      }),
      event(4, "failed", "AI 分析失败", {
        error: { code: "AI_TIMEOUT" },
      }),
    ]);

    expect(rows[0]).toMatchObject({ kind: "warning", status: "completed" });
    expect(rows.at(-1)).toMatchObject({
      kind: "terminal",
      status: "terminal",
      message: "AI 分析失败",
    });
  });
});

function event(
  id: number,
  eventType: string,
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): ApiAiJobEvent {
  return {
    id,
    jobId: "job_semantic_1",
    eventType,
    message,
    data,
    createdAt: `2026-08-13T00:00:${String(id).padStart(2, "0")}.000Z`,
  };
}

function tool(
  status: "started" | "completed" | "failed",
  runId: string,
): Readonly<Record<string, unknown>> {
  return { runId, attempt: 1, kind: "tool", status };
}
