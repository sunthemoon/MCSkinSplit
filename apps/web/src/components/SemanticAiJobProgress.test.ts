import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ApiAiJobDetail,
  ApiAiJobEvent,
  ApiAiJobStatus,
  ApiSemanticFollowup,
} from "../lib/revisionApi";
import {
  SemanticAiJobProgress,
  buildSemanticAiProgress,
} from "./SemanticAiJobProgress";

describe("semantic AI job progress", () => {
  it("shows the player-first six-stage outline before a job starts", () => {
    const html = renderToStaticMarkup(
      createElement(SemanticAiJobProgress, { detail: null }),
    );

    expect(html).toContain("准备识别");
    expect(html).toContain("识别皮肤部件");
    expect(html).toContain("校验识别结果");
    expect(html).toContain("复核跨部位分类");
    expect(html).toContain("确认分类修复");
    expect(html).toContain("准备分析目录");
    expect(html).toContain("智能流程 0 / 6");
  });

  it.each([
    ["queued", "准备识别", 0],
    ["preparing", "准备识别", 0],
    ["running", "识别皮肤部件", 17],
    ["validating", "校验识别结果", 33],
  ] as const)("maps %s to one honest current stage", (status, label, percent) => {
    const model = buildSemanticAiProgress(jobDetail(status));
    expect(model.headline).toBe(label);
    expect(model.progressPercent).toBe(percent);
    expect(model.steps.find((step) => step.state === "current")?.label).toBe(label);
  });

  it("describes repeated JSON proposal attempts as classification correction", () => {
    const model = buildSemanticAiProgress(jobDetail("running", {
      runs: [run(1, "failed"), run(2, "running")],
    }));

    expect(model.headline).toBe("正在纠正识别结果");
    expect(model.steps[1]).toMatchObject({ label: "识别皮肤部件", state: "current" });
    expect(model.steps[4]).toMatchObject({ label: "确认分类修复", state: "pending" });
    expect(model.handoffDetail).toContain("不会把这一步当作像素修补");
  });

  it("pauses below 100 percent while a repair suggestion awaits review", () => {
    const model = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      semanticFollowup: followup("awaiting_review"),
    }));

    expect(model.progressPercent).toBe(67);
    expect(model.steps[4]).toMatchObject({ state: "current" });
    expect(model.steps[5]).toMatchObject({ state: "pending" });
    expect(model.handoffTitle).toContain("请选择");
  });

  it("marks historical suggestions as read-only and asks for a fresh analysis", () => {
    const legacy = {
      ...followup("awaiting_review"),
      algorithmVersion: "cross-body-hair-reclassification-v1",
      applicable: false,
    };
    const model = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      semanticFollowup: legacy,
    }));

    expect(model.headline).toBe("旧版分类建议仅供对照");
    expect(model.steps[4]).toMatchObject({ state: "skipped" });
    expect(model.handoffTitle).toBe("请重新运行智能分析");
  });

  it("maps persisted occlusion events without claiming a repair early", () => {
    const assessing = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      events: [event(1, "occlusion_assessing")],
    }));
    expect(assessing.steps[3]).toMatchObject({ state: "current" });

    const assessed = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      events: [event(1, "occlusion_assessed")],
    }));
    expect(assessed.steps[3]).toMatchObject({ state: "completed" });
    expect(assessed.steps[4]).toMatchObject({ state: "current" });
    expect(assessed.progressPercent).toBeLessThan(100);
  });

  it("finishes with an applied or skipped classification repair backed by persisted state", () => {
    const applied = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      semanticFollowup: followup("applied"),
      events: [event(1, "catalog_ready")],
    }));
    expect(applied.progressPercent).toBe(100);
    expect(applied.headline).toBe("分类修复版已准备入库");

    const noRepair = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      semanticFollowup: followup("no_repair"),
    }));
    expect(noRepair.progressPercent).toBe(100);
    expect(noRepair.steps[4]?.state).toBe("skipped");
    expect(noRepair.headline).toBe("跨部位分类复核完成");
    expect(noRepair.handoffDetail).toContain("隐藏内容仍可能需要后续补全");

    const eventOnly = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      events: [
        event(1, "occlusion_assessed"),
        event(2, "repair_review_skipped"),
        event(3, "catalog_ready"),
      ],
    }));
    expect(eventOnly.steps[4]?.state).toBe("skipped");
    expect(eventOnly.headline).toBe("跨部位分类复核完成");
  });

  it("marks unavailable followup stages as skipped for a proposal-only success", () => {
    const model = buildSemanticAiProgress(jobDetail("succeeded"));

    expect(model.progressPercent).toBe(100);
    expect(model.steps.slice(3)).toEqual([
      expect.objectContaining({ state: "skipped" }),
      expect.objectContaining({ state: "skipped" }),
      expect.objectContaining({ state: "skipped" }),
    ]);
  });

  it("keeps a successful semantic result usable when assessment fails", () => {
    const model = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      semanticFollowup: followup("assessment_failed"),
    }));

    expect(model.steps[3]?.state).toBe("failed");
    expect(model.handoffState).toBe("ready");
    expect(model.handoffTitle).toBe("原识别仍可使用");

    const eventOnly = buildSemanticAiProgress(jobDetail("succeeded", {
      resultRevisionId: "revision_result",
      events: [
        event(1, "occlusion_assessing"),
        event(2, "occlusion_assessment_failed"),
        event(3, "catalog_ready"),
      ],
    }));
    expect(eventOnly.steps[3]?.state).toBe("failed");
    expect(eventOnly.handoffTitle).toBe("原识别仍可使用");
  });
});

interface JobDetailOverrides {
  readonly runs?: ApiAiJobDetail["runs"];
  readonly events?: readonly ApiAiJobEvent[];
  readonly resultRevisionId?: string | null;
  readonly semanticFollowup?: ApiSemanticFollowup | null;
}

function jobDetail(
  status: ApiAiJobStatus,
  overrides: JobDetailOverrides = {},
): ApiAiJobDetail {
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
        semanticBaseline: "empty",
      },
      reviewItems: [],
      proposalSummary: null,
      advisoryResult: null,
      cancelRequested: false,
      createdAt: "2026-08-13T00:00:00.000Z",
      startedAt: status === "queued" ? null : "2026-08-13T00:00:01.000Z",
      finishedAt: ["succeeded", "failed", "cancelled"].includes(status)
        ? "2026-08-13T00:00:02.000Z"
        : null,
      error: status === "failed" ? { code: "AI_FAILED", message: "识别失败" } : null,
    },
    runs: overrides.runs ?? (status === "queued" || status === "preparing"
      ? []
      : [run(1, ["succeeded", "failed", "cancelled"].includes(status)
        ? status as "succeeded" | "failed" | "cancelled"
        : "running")]),
    events: overrides.events ?? [event(1, status)],
    semanticFollowup: overrides.semanticFollowup ?? null,
  };
}

function followup(status: ApiSemanticFollowup["status"]): ApiSemanticFollowup {
  return {
    status,
    algorithmVersion: "cross-body-hair-reclassification-v2",
    applicable: true,
    evidenceHash: `sha256:${"a".repeat(64)}`,
    suggestions: status === "awaiting_review"
      ? [{ id: "suggestion_1", label: "将疑似长发从衣服改为头发", pixelCount: 24, confidence: 0.88, reason: "跨部位区域可核对" }]
      : [],
    notices: [],
    appliedRevisionId: status === "applied" ? "rev_repaired_1" : null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
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

function event(id: number, eventType: string): ApiAiJobEvent {
  return {
    id,
    jobId: "job_semantic_1",
    eventType,
    message: eventType,
    data: {},
    createdAt: `2026-08-13T00:00:${String(id).padStart(2, "0")}.000Z`,
  };
}
