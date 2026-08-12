import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ApiAiJobDetail,
  ApiAiJobEvent,
  ApiAiJobStatus,
} from "../lib/revisionApi";
import {
  SemanticAiJobProgress,
  buildSemanticAiProgress,
} from "./SemanticAiJobProgress";

describe("semantic AI job progress", () => {
  it("shows the complete outline before any job starts", () => {
    const html = renderToStaticMarkup(
      createElement(SemanticAiJobProgress, { detail: null }),
    );

    expect(html).toContain("尚未开始");
    expect(html).toContain("任务排队");
    expect(html).toContain("隔离输入");
    expect(html).toContain("Codex 分类");
    expect(html).toContain("确定性校验");
    expect(html).toContain("修复与复检");
    expect(html).toContain("自动流程 0 / 5");
    expect(html).not.toContain('aria-current="step"');
  });

  it.each([
    ["queued", "任务排队", 0],
    ["preparing", "隔离输入", 20],
    ["running", "Codex 分类", 40],
    ["validating", "确定性校验", 60],
  ] as const)("maps %s to a visible current step", (status, label, percent) => {
    const model = buildSemanticAiProgress(jobDetail(status));
    expect(model.headline).toBe(label);
    expect(model.progressPercent).toBe(percent);
    expect(model.steps.filter((step) => step.state === "current")).toHaveLength(1);
    expect(model.steps.find((step) => step.state === "current")?.label).toBe(label);
  });

  it("keeps progress monotonic during the validation repair loop", () => {
    const detail = jobDetail("running", {
      runs: [run(1, "failed"), run(2, "running")],
      events: [
        event(1, "validating"),
        event(2, "run_started", { attempt: 2 }),
        event(3, "running"),
      ],
    });
    const model = buildSemanticAiProgress(detail);

    expect(model.headline).toBe("自动修复中 · 第 2 次模型调用");
    expect(model.progressPercent).toBe(80);
    expect(model.steps[3]).toMatchObject({ label: "确定性校验", state: "completed" });
    expect(model.steps[4]).toMatchObject({ label: "修复与复检", state: "current" });
    expect(model.handoffDetail).toContain("首轮提案未通过");
  });

  it("separates machine success from required human review", () => {
    const withReview = buildSemanticAiProgress(jobDetail("succeeded", {
      reviewItemCount: 2,
      resultRevisionId: "revision_result",
    }));
    expect(withReview.progressPercent).toBe(100);
    expect(withReview.steps[4]?.state).toBe("skipped");
    expect(withReview.handoffState).toBe("ready");
    expect(withReview.handoffTitle).toContain("等待人工确认");
    expect(withReview.handoffDetail).toContain("2 项重点审核问题");

    const withoutRevision = buildSemanticAiProgress(jobDetail("succeeded"));
    expect(withoutRevision.handoffState).toBe("unavailable");
    expect(withoutRevision.handoffTitle).toContain("仅保留为审计记录");
    expect(withoutRevision.handoffDetail).toContain("Branch HEAD");
    expect(withoutRevision.handoffDetail).not.toContain("语义编辑器中逐项确认");

    const withoutReviewItems = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
    }));
    expect(withoutReviewItems.handoffDetail).toContain("不等于审核完成");
  });

  it.each(["failed", "cancelled"] as const)(
    "stops at the evidenced phase when the job is %s",
    (status) => {
      const model = buildSemanticAiProgress(jobDetail(status, {
        events: [event(1, "preparing"), event(2, "running")],
        runs: [run(1, status)],
      }));

      expect(model.progressPercent).toBe(40);
      expect(model.steps[2]?.state).toBe(status);
      expect(model.steps[3]?.state).toBe("pending");
      expect(model.handoffState).toBe("unavailable");
    },
  );

  it("marks cancellation in progress without changing the current phase", () => {
    const detail = jobDetail("validating", { cancelRequested: true });
    const html = renderToStaticMarkup(
      createElement(SemanticAiJobProgress, { detail }),
    );

    expect(html).toContain("正在取消");
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="60"');
  });
});

interface JobDetailOverrides {
  readonly runs?: ApiAiJobDetail["runs"];
  readonly events?: readonly ApiAiJobEvent[];
  readonly reviewItemCount?: number;
  readonly resultRevisionId?: string | null;
  readonly cancelRequested?: boolean;
}

function jobDetail(
  status: ApiAiJobStatus,
  overrides: JobDetailOverrides = {},
): ApiAiJobDetail {
  const reviewItems = Array.from({ length: overrides.reviewItemCount ?? 0 }, (_, index) => ({
    type: "low_confidence" as const,
    candidateRegionIds: [`candidate_${index}`],
    question: `审核问题 ${index + 1}`,
    suggestedCategories: ["hair" as const],
    confidence: 0.5,
  }));
  return {
    job: {
      id: "job_semantic_1",
      kind: "semantic_analysis",
      projectId: "project_1",
      inputRevisionId: "revision_1",
      resultRevisionId: overrides.resultRevisionId ?? null,
      compositionId: null,
      retryOfJobId: null,
      status,
      provider: "codex-exec",
      model: "codex-config-default",
      skillName: "mc-skin-segmenter",
      skillVersion: "1.1.0",
      promptVersion: "1.0.0",
      inputHash: null,
      outputHash: null,
      options: {
        mode: "full",
        provider: "codex-exec",
        model: "codex-config-default",
        reasoningEffort: "medium",
        taxonomyLevel: "coarse",
        focus: ["hair"],
        createRevisionOnSuccess: true,
      },
      reviewItems,
      proposalSummary: null,
      advisoryResult: null,
      cancelRequested: overrides.cancelRequested ?? false,
      createdAt: "2026-08-13T00:00:00.000Z",
      startedAt: status === "queued" ? null : "2026-08-13T00:00:01.000Z",
      finishedAt: ["succeeded", "failed", "cancelled"].includes(status)
        ? "2026-08-13T00:00:02.000Z"
        : null,
      error: status === "failed"
        ? { code: "AI_FAILED", message: "识别失败" }
        : null,
    },
    runs: overrides.runs ?? (status === "queued" || status === "preparing"
      ? []
      : [run(1, ["succeeded", "failed", "cancelled"].includes(status)
        ? status as "succeeded" | "failed" | "cancelled"
        : "running")]),
    events: overrides.events ?? [event(1, status)],
  };
}

function run(
  attempt: number,
  status: "running" | "succeeded" | "failed" | "cancelled",
): ApiAiJobDetail["runs"][number] {
  return {
    id: `run_${attempt}`,
    jobId: "job_semantic_1",
    provider: "codex-exec",
    model: "codex-config-default",
    threadId: null,
    attempt,
    status,
    workspacePath: `data/run_${attempt}`,
    usage: null,
    startedAt: "2026-08-13T00:00:01.000Z",
    finishedAt: status === "running" ? null : "2026-08-13T00:00:02.000Z",
    error: null,
    assets: [],
  };
}

function event(
  id: number,
  eventType: string,
  data: Readonly<Record<string, unknown>> = {},
): ApiAiJobEvent {
  return {
    id,
    jobId: "job_semantic_1",
    eventType,
    message: eventType,
    data,
    createdAt: `2026-08-13T00:00:${String(id).padStart(2, "0")}.000Z`,
  };
}
