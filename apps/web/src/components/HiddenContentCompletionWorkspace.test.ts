import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ApiCompletionCandidate,
  ApiCompletionProposalDetail,
  ApiPart,
} from "../lib/revisionApi";
import type { CompletionCatalogContext } from "../lib/completionWorkspace";
import {
  CompletionCandidateReview,
  CompletionResultChoice,
  HiddenContentCompletionWorkspace,
} from "./HiddenContentCompletionWorkspace";

describe("hidden-content completion workspace", () => {
  it("renders the exact texture, write-mask, and generated-mask comparison separately", () => {
    const review = completionDetail({
      candidates: [candidate("candidate / 1")],
    });
    const html = renderToStaticMarkup(createElement(CompletionCandidateReview, {
      armType: "slim",
      detail: review,
      sourceSkinUrl: "/api/revisions/source/skin.png",
      selectedCandidateId: "candidate / 1",
      busy: false,
      onSelectCandidate: vi.fn(),
      onAccept: vi.fn(),
      onKeepOriginal: vi.fn(),
      onEdited: vi.fn(),
    }));

    expect(html).toContain('aria-label="所选候选精确纹理与遮罩对照"');
    expect(html).toContain("当前结果纹理");
    expect(html).toContain("候选新增纹理");
    expect(html).toContain("将写入的位置");
    expect(html).toContain("推测生成的位置");
    expect(html).toContain("/texture.png");
    expect(html).toContain("/write-mask.png");
    expect(html).toContain("/generated-mask.png");
    expect(html).toContain("接受后的像素叠加");
  });

  it("keeps AI ranking advisory and never preselects its recommendation", () => {
    const recommended = candidate("candidate_recommended");
    const review = completionDetail({
      candidates: [recommended, candidate("candidate_other")],
      ranking: ranking(recommended.id),
    });
    const html = renderToStaticMarkup(createElement(CompletionCandidateReview, {
      armType: "slim",
      detail: review,
      sourceSkinUrl: "/source.png",
      selectedCandidateId: null,
      busy: false,
      onSelectCandidate: vi.fn(),
      onAccept: vi.fn(),
      onKeepOriginal: vi.fn(),
      onEdited: vi.fn(),
    }));

    expect(html).toContain("AI 仅建议优先查看一个候选");
    expect(html).toContain("界面不会预选，也不会自动接受");
    expect(html).not.toContain('checked=""');
    expect(html).toContain('disabled="">接受所选候选');
    expect(html).not.toContain("所选候选精确纹理与遮罩对照");
  });

  it("treats zero candidates as a reviewable result with keep-original enabled", () => {
    const html = renderToStaticMarkup(createElement(CompletionCandidateReview, {
      armType: "slim",
      detail: completionDetail(),
      sourceSkinUrl: "/source.png",
      selectedCandidateId: null,
      busy: false,
      onSelectCandidate: vi.fn(),
      onAccept: vi.fn(),
      onKeepOriginal: vi.fn(),
      onEdited: vi.fn(),
    }));

    expect(html).toContain("没有证据足够的候选");
    expect(html).toContain("原版本完全不变");
    expect(html).toContain('disabled="">接受所选候选');
    expect(html).toContain(">保留原结果</button>");
  });

  it("exposes original and repaired source variants before generation", () => {
    const context = catalogContext();
    const html = renderToStaticMarkup(createElement(
      HiddenContentCompletionWorkspace,
      {
        sourceRevision: revision("revision_original", 2),
        sourceSkinUrl: "/api/revisions/revision_original/skin.png",
        segmentation: {
          schemaVersion: "1.0",
          revisionId: "revision_original",
          source: {
            width: 64,
            height: 64,
            armType: "slim",
            coordinateOrigin: "top-left",
            sourceHash: "source-hash",
          },
          components: [],
          unknown: { maskFile: null, pixelCount: 0 },
        },
        catalogContext: context,
        onOpenRevision: vi.fn(async () => undefined),
        onDecision: vi.fn(async () => undefined),
      },
    ));

    expect(html).toContain('data-testid="completion-workspace"');
    expect(html).toContain('aria-label="选择隐藏内容检查使用的分析版本"');
    expect(html).toContain("原识别");
    expect(html).toContain("分类修复版");
    expect(html).toContain("组件编号由系统记录");
    expect(html).not.toContain("revision_original</code>");
  });

  it("does not offer a misleading PNG or direct Bundle for an accepted latent Part", () => {
    const detail = completionDetail({
      decision: decision("accept", "candidate_1"),
      result: {
        id: "result_1",
        proposalId: "proposal_1",
        decisionId: "decision_1",
        candidateId: "candidate_1",
        representation: "latent_component",
        sourceRevisionId: "revision_original",
        sourceResultHash: "source-result-hash",
        sourceSkinHash: "source-skin-hash",
        revision: null,
        latentPart: {
          id: "part_latent",
          name: "完成版上衣",
        } as ApiPart,
        resultHash: "result-hash",
        resultSkinHash: "source-skin-hash",
        originHash: "origin-hash",
        publishedAt: null,
        createdAt: "2026-08-19T10:00:00.000Z",
      },
    });
    const html = renderToStaticMarkup(createElement(CompletionResultChoice, {
      detail,
      catalogContext: catalogContext(),
      onOpenRevision: vi.fn(),
    }));

    expect(html).toContain("未发布部件资产");
    expect(html).toContain("可在保存/导出步骤明确发布到部件库");
    expect(html).toContain("保存完整大类 · 需先有对应组合包");
    expect(html).toContain("不能下载成同时包含遮挡物与隐藏像素的单层 PNG");
    expect(html).not.toContain("可表示为 PNG");
  });
});

function completionDetail(overrides: {
  readonly candidates?: readonly ApiCompletionCandidate[];
  readonly ranking?: ApiCompletionProposalDetail["ranking"];
  readonly decision?: ApiCompletionProposalDetail["decision"];
  readonly result?: ApiCompletionProposalDetail["result"];
} = {}): ApiCompletionProposalDetail {
  const candidates = overrides.candidates ?? [];
  return {
    proposal: {
      id: "proposal_1",
      jobId: "job_1",
      projectId: "project_1",
      sourceRevisionId: "revision_original",
      sourceResultHash: "source-result-hash",
      sourceSkinHash: "source-skin-hash",
      targetComponentId: "shirt.main",
      occludingComponentIds: ["hair.main"],
      representation: "skin_texel",
      allowedSpans: [],
      allowedGeneratedPixelCount: 4,
      evidence: {},
      evidenceHash: "evidence-hash",
      proposalHash: "proposal-hash",
      document: storedFile("application/json"),
      allowedMask: storedFile("image/png"),
      createdAt: "2026-08-19T09:00:00.000Z",
    },
    jobStatus: "succeeded",
    visible: true,
    status: overrides.decision?.action === "accept"
      ? "accepted"
      : overrides.decision?.action === "reject"
        ? "rejected"
        : "awaiting_decision",
    candidateCount: candidates.length,
    candidates,
    ranking: overrides.ranking ?? null,
    decision: overrides.decision ?? null,
    result: overrides.result ?? null,
  };
}

function candidate(id: string): ApiCompletionCandidate {
  return {
    id,
    proposalId: "proposal_1",
    representation: "skin_texel",
    strategy: "same_surface_continuation",
    confidence: "medium",
    originMode: "generated_completion",
    pixelCount: 4,
    generatedPixelCount: 4,
    candidateHash: "candidate-hash",
    evidenceHash: "evidence-hash",
    document: storedFile("application/json"),
    texture: storedFile("image/png"),
    writeMask: storedFile("image/png"),
    generatedMask: storedFile("image/png"),
    reviewRequired: true,
    automaticAcceptanceAllowed: false,
    createdAt: "2026-08-19T09:01:00.000Z",
  };
}

function ranking(candidateId: string): NonNullable<ApiCompletionProposalDetail["ranking"]> {
  return {
    proposalId: "proposal_1",
    jobId: "job_1",
    provider: "codex-exec",
    model: "codex-config-default",
    reasoningEffort: "medium",
    document: {
      schemaVersion: "1.0",
      jobId: "job_1",
      proposalId: "proposal_1",
      proposalHash: "proposal-hash",
      sourceRevisionId: "revision_original",
      sourceResultHash: "source-result-hash",
      sourceSkinHash: "source-skin-hash",
      rankings: [{ candidateId, confidence: 0.8, explanation: "先检查连续纹理" }],
      recommendation: {
        status: "recommend",
        candidateId,
        confidence: 0.8,
        explanation: "先检查连续纹理",
      },
    },
    orderedCandidateIds: [candidateId],
    recommendation: {
      status: "recommend",
      candidateId,
      confidence: 0.8,
      explanation: "先检查连续纹理",
    },
    rankingHash: "ranking-hash",
    createdAt: "2026-08-19T09:02:00.000Z",
  };
}

function decision(
  action: "accept" | "reject",
  candidateId: string | null,
): NonNullable<ApiCompletionProposalDetail["decision"]> {
  return {
    id: "decision_1",
    proposalId: "proposal_1",
    candidateId,
    action,
    expectedSourceResultHash: "source-result-hash",
    expectedProposalHash: "proposal-hash",
    expectedEvidenceHash: "evidence-hash",
    expectedCandidateHash: candidateId ? "candidate-hash" : null,
    actorType: "user",
    actorId: "local-player",
    reason: null,
    decisionHash: "decision-hash",
    createdAt: "2026-08-19T09:03:00.000Z",
  };
}

function catalogContext(): CompletionCatalogContext {
  return {
    item: {
      project: { id: "project_1", name: "Red skin" },
      revision: {
        id: "revision_original",
        branchId: "branch_main",
        branchName: "main",
        sequence: 2,
        createdAt: "2026-08-19T08:00:00.000Z",
      },
      aiJob: {
        id: "job_analysis",
        provider: "host",
        model: "deterministic",
        finishedAt: "2026-08-19T08:01:00.000Z",
      },
      armType: "slim",
      componentCount: 2,
      unknownPixelCount: 0,
      reviewItemCount: 0,
      catalogStatus: "active",
      archivedAt: null,
      archivedReason: null,
      groups: [],
      skinUrl: "/source.png",
      semanticFollowup: null,
    },
    sourceKind: "original",
    choices: [
      {
        kind: "original",
        revisionId: "revision_original",
        label: "原识别",
        detail: "main #2",
        selected: true,
      },
      {
        kind: "repaired",
        revisionId: "revision_repaired",
        label: "分类修复版",
        detail: "main #3",
        selected: false,
      },
    ],
  };
}

function revision(id: string, sequence: number) {
  return {
    id,
    projectId: "project_1",
    parentRevisionId: null,
    branchId: "branch_main",
    branchName: "main",
    sequence,
    operationType: "ai_segment",
    actorType: "ai" as const,
    createdAt: "2026-08-19T08:00:00.000Z",
    summary: "analysis",
    resultHash: "result-hash",
    isBranchHead: true,
  };
}

function storedFile(mimeType: "application/json" | "image/png") {
  return {
    storagePath: "asset",
    mimeType,
    byteSize: 1,
    sha256: "asset-hash",
  } as const;
}
