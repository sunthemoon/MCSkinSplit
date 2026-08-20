import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SemanticComponent } from "@mc-skin-split/skin-core";
import type {
  ApiCompletionProposalDetail,
  ApiPart,
  ApiRevision,
} from "../lib/revisionApi";
import type { CompletionCatalogContext } from "../lib/completionWorkspace";
import {
  PlayerResultWorkspace,
  type PlayerCompletionResultSnapshot,
} from "./PlayerResultWorkspace";

describe("player result workspace", () => {
  it("provides only legal PNG, selected-Part, and complete-category actions", () => {
    const html = renderToStaticMarkup(createElement(PlayerResultWorkspace, {
      revision: revision("revision_1", "ai_segment"),
      projectName: "Red skin",
      completion: null,
      selection: "current",
      components: [component()],
      activeComponentId: "shirt.main",
      busy: false,
      onSelectResult: vi.fn(),
      onSelectComponent: vi.fn(),
      onDownloadPng: vi.fn(),
      onSavePart: vi.fn(),
      onSaveBundle: vi.fn(),
      onPublishLatentPart: vi.fn(),
    }));

    expect(html).toContain('id="workspace-result"');
    expect(html).toContain('data-testid="player-result-workspace"');
    expect(html).toContain("下载所选结果 PNG");
    expect(html).toContain("保存所选组件为部件资产");
    expect(html).toContain("完整衣服 · 1");
    expect(html).toContain("高级信息 · 精确来源 ID");
  });

  it("keeps an accepted latent result as an unpublished Part with no PNG action", () => {
    const html = renderToStaticMarkup(createElement(PlayerResultWorkspace, {
      revision: revision("revision_original", "ai_segment"),
      projectName: "Red skin",
      completion: snapshot("latent_component"),
      selection: "latent",
      components: [component()],
      activeComponentId: "shirt.main",
      busy: false,
      onSelectResult: vi.fn(),
      onSelectComponent: vi.fn(),
      onDownloadPng: vi.fn(),
      onSavePart: vi.fn(),
      onSaveBundle: vi.fn(),
      onPublishLatentPart: vi.fn(),
    }));

    expect(html).toContain("已接受完成版组件 · 未发布");
    expect(html).toContain("未发布部件资产");
    expect(html).toContain('data-testid="publish-latent-part"');
    expect(html).toContain("发布完成版组件到部件库");
    expect(html).toContain("完整大类组合包 · 尚未找到可验证的兼容项");
    expect(html).toContain("并非原作者不可见像素的真实恢复");
    expect(html).not.toContain("下载所选结果 PNG");
  });

  it("binds a representable completion download to its exact loaded Revision", () => {
    const html = renderToStaticMarkup(createElement(PlayerResultWorkspace, {
      revision: revision("revision_completed", "completion_accept"),
      projectName: "Red skin",
      completion: snapshot("skin_texel"),
      selection: "completed",
      components: [component()],
      activeComponentId: "shirt.main",
      busy: false,
      onSelectResult: vi.fn(),
      onSelectComponent: vi.fn(),
      onDownloadPng: vi.fn(),
      onSavePart: vi.fn(),
      onSaveBundle: vi.fn(),
      onPublishLatentPart: vi.fn(),
    }));

    expect(html).toContain('aria-label="选择要保存的结果版本"');
    expect(html).toContain("原识别");
    expect(html).toContain("分类修复版");
    expect(html).toContain("已接受补全版");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toMatch(/<button type="button">下载所选结果 PNG<\/button>/);
    expect(html).toContain("包含推测生成内容");
  });

  it("shows an idempotently published latent Part without enabling PNG or Bundle", () => {
    const unpublished = snapshot("latent_component");
    const completion: PlayerCompletionResultSnapshot = {
      ...unpublished,
      detail: {
        ...unpublished.detail,
        result: {
          ...unpublished.detail.result!,
          publishedAt: "2026-08-19T10:00:00.000Z",
        },
      },
    };
    const html = renderToStaticMarkup(createElement(PlayerResultWorkspace, {
      revision: revision("revision_original", "ai_segment"),
      projectName: "Red skin",
      completion,
      selection: "latent",
      components: [component()],
      activeComponentId: "shirt.main",
      busy: false,
      onSelectResult: vi.fn(),
      onSelectComponent: vi.fn(),
      onDownloadPng: vi.fn(),
      onSavePart: vi.fn(),
      onSaveBundle: vi.fn(),
      onPublishLatentPart: vi.fn(),
    }));

    expect(html).toContain("已接受完成版组件 · 已发布");
    expect(html).toContain('disabled="">已发布到部件库');
    expect(html).toContain("完整大类组合包 · 尚未找到可验证的兼容项");
    expect(html).not.toContain("下载所选结果 PNG");
  });
});

function snapshot(
  representation: "skin_texel" | "latent_component",
): PlayerCompletionResultSnapshot {
  const context: CompletionCatalogContext = {
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
      componentCount: 1,
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
  const result = {
    id: "result_1",
    proposalId: "proposal_1",
    decisionId: "decision_1",
    candidateId: "candidate_1",
    representation,
    sourceRevisionId: "revision_original",
    sourceResultHash: "source-result-hash",
    sourceSkinHash: "source-skin-hash",
    revision: representation === "skin_texel"
      ? revision("revision_completed", "completion_accept")
      : null,
    latentPart: representation === "latent_component"
      ? ({ id: "part_latent", name: "完成版上衣" } as ApiPart)
      : null,
    resultHash: "result-hash",
    resultSkinHash: "result-skin-hash",
    originHash: "origin-hash",
    publishedAt: null,
    createdAt: "2026-08-19T09:05:00.000Z",
  } as const;
  const detail = {
    proposal: {
      id: "proposal_1",
      projectId: "project_1",
      sourceRevisionId: "revision_original",
    },
    decision: { action: "accept" },
    result,
  } as ApiCompletionProposalDetail;
  return { detail, catalogContext: context };
}

function revision(id: string, operationType: string): ApiRevision {
  return {
    id,
    projectId: "project_1",
    parentRevisionId: null,
    branchId: "branch_main",
    branchName: "main",
    sequence: operationType === "completion_accept" ? 4 : 2,
    operationType,
    actorType: operationType === "completion_accept" ? "user" : "ai",
    createdAt: "2026-08-19T08:00:00.000Z",
    summary: operationType,
    resultHash: `${id}-hash`,
    isBranchHead: true,
  };
}

function component(): SemanticComponent {
  return {
    instanceId: "shirt.main",
    displayName: "上衣",
    category: "upper_clothing",
    confidence: 1,
    reviewState: "confirmed",
    maskFile: "shirt.png",
    spans: [{ surface: "torso.base.front", y: 20, x0: 20, x1: 22 }],
    palette: { dominant: "#ffffff", colors: ["#ffffff"] },
    relations: {
      attachedTo: null,
      pairedWith: [],
      sameOutfitGroup: null,
      conflictsWith: [],
    },
    provenance: { actorType: "ai", containsGeneratedPixels: false },
  };
}
