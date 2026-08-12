import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ApiAiJobDetail,
  ApiCompositionRestorationCandidates,
} from "../lib/revisionApi";
import { RestorationRecommendationPanel } from "./RestorationRecommendationPanel";

const candidates: ApiCompositionRestorationCandidates = {
  compositionId: "composition_1",
  version: 2,
  candidateSetHash: `sha256:${"a".repeat(64)}`,
  targetComponentIds: ["shirt.main"],
  outer: { pixelCount: 9, candidateId: "candidate.outer" },
  base: {
    pixelCount: 8,
    coveredPixelCount: 8,
    missingPixelCount: 0,
    candidates: [{
      id: "candidate.manual",
      kind: "manual_rgba",
      targetGroupId: "torso_base",
      label: "手动肤色 #D6A17B",
      description: "完整覆盖",
      pixelCount: 8,
      coveragePixelCount: 8,
      rgba: [214, 161, 123, 255],
    }],
  },
};

const detail: ApiAiJobDetail = {
  job: {
    id: "job_1",
    kind: "restoration_recommendation",
    projectId: "project_1",
    inputRevisionId: "revision_1",
    resultRevisionId: null,
    compositionId: "composition_1",
    retryOfJobId: null,
    status: "succeeded",
    provider: "codex-exec",
    model: "codex-config-default",
    skillName: "mc-skin-replacement-planner",
    skillVersion: "1.0.0",
    promptVersion: "1.0.0",
    inputHash: null,
    outputHash: null,
    options: {
      mode: "restoration_recommendation",
      provider: "codex-exec",
      model: "codex-config-default",
      reasoningEffort: "medium",
      userIntent: "完整覆盖",
      compositionId: "composition_1",
      compositionVersion: 2,
      candidateSetHash: candidates.candidateSetHash,
      targetComponentIds: ["shirt.main"],
    },
    reviewItems: [],
    proposalSummary: null,
    advisoryResult: {
      schemaVersion: "1.0",
      jobId: "job_1",
      compositionId: "composition_1",
      candidateSetHash: candidates.candidateSetHash,
      decisions: [{
        targetGroupId: "torso_base",
        selectedCandidateId: "candidate.manual",
        rankedCandidateIds: ["candidate.manual"],
        confidence: 0.87,
        explanation: "这个候选能够完整覆盖目标 Base。",
      }],
      summary: "推荐使用完整覆盖候选。",
    },
    cancelRequested: false,
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: "2026-08-12T00:00:01.000Z",
    finishedAt: "2026-08-12T00:00:02.000Z",
    error: null,
  },
  runs: [],
  events: [{
    id: 1,
    jobId: "job_1",
    eventType: "recommendation_completed",
    message: "候选建议已校验",
    data: {},
    createdAt: "2026-08-12T00:00:02.000Z",
  }],
};

const baseProps = {
  candidates,
  jobDetail: detail,
  userIntent: "完整覆盖",
  providers: ["codex-exec"],
  provider: "codex-exec",
  model: "codex-config-default",
  reasoningEffort: "medium" as const,
  staleReason: null,
  disabled: false,
  busy: false,
  error: null,
  onUserIntentChange: () => undefined,
  onProviderChange: () => undefined,
  onStart: () => undefined,
  onCancel: () => undefined,
  onLoad: () => undefined,
};

describe("restoration recommendation panel", () => {
  it("requires deterministic candidates before starting", () => {
    const html = renderToStaticMarkup(createElement(
      RestorationRecommendationPanel,
      { ...baseProps, candidates: null, jobDetail: null },
    ));
    expect(html).toContain("请先生成确定性清理候选");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>生成 AI 候选建议<\/button>/);
  });

  it("disables recommendation when no capable provider is available", () => {
    const html = renderToStaticMarkup(createElement(
      RestorationRecommendationPanel,
      { ...baseProps, providers: [], provider: "", jobDetail: null },
    ));
    expect(html).toContain("无可用推荐 Provider");
    expect(html).toContain("当前没有支持修补候选推荐的 AI Provider");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>生成 AI 候选建议<\/button>/);
  });

  it("shows live events, per-group confidence and explanation", () => {
    const html = renderToStaticMarkup(createElement(
      RestorationRecommendationPanel,
      baseProps,
    ));
    expect(html).toContain("候选建议已校验");
    expect(html).toContain("torso_base");
    expect(html).toContain("87%");
    expect(html).toContain("这个候选能够完整覆盖目标 Base");
    expect(html).toContain("载入建议到本地候选选择");
    expect(html).toContain("载入不会应用计划");
  });

  it("shows queued job events without enabling recommendation loading", () => {
    const html = renderToStaticMarkup(createElement(
      RestorationRecommendationPanel,
      {
        ...baseProps,
        jobDetail: {
          ...detail,
          job: { ...detail.job, status: "running", advisoryResult: null },
        },
      },
    ));
    expect(html).toContain("正在推荐");
    expect(html).toContain("候选建议已校验");
    expect(html).not.toContain("载入建议到本地候选选择");
  });

  it("disables loading and explains a stale result", () => {
    const html = renderToStaticMarkup(createElement(
      RestorationRecommendationPanel,
      { ...baseProps, staleReason: "候选集合已经变化" },
    ));
    expect(html).toContain("推荐已过期：候选集合已经变化");
    expect(html).toMatch(/<button[^>]*class="restoration-ai-load"[^>]*disabled=""/);
  });
});
