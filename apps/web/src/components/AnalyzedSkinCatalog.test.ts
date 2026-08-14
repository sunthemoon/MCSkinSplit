import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiAnalyzedSkin } from "../lib/revisionApi";
import {
  AnalyzedSkinCatalog,
  analyzedSkinArchiveDescription,
  filterAnalyzedSkinCatalog,
} from "./AnalyzedSkinCatalog";

describe("analyzed skin catalog", () => {
  it("filters active and archived results independently from aggregate kinds", () => {
    const active = analyzedSkin();
    const archived = analyzedSkin({
      revision: {
        ...active.revision,
        id: "revision_archived",
        sequence: 3,
      },
      catalogStatus: "archived",
      archivedAt: "2026-08-14T09:30:00.000Z",
      archivedReason: "重复分析",
      groups: [{
        ...active.groups[0]!,
        key: "aggregate.clothing",
        kind: "clothing",
        displayName: "完整衣服",
      }],
    });

    expect(filterAnalyzedSkinCatalog([active, archived], {
      kind: "all",
      status: "active",
      query: "",
    })).toEqual([active]);
    expect(filterAnalyzedSkinCatalog([active, archived], {
      kind: "clothing",
      status: "archived",
      query: "重复",
    })).toEqual([archived]);
    expect(filterAnalyzedSkinCatalog([active, archived], {
      kind: "hair",
      status: "all",
      query: "",
    })).toEqual([active]);
  });

  it("defaults to the current catalog and exposes a reversible archive action", () => {
    const item = analyzedSkin();
    const html = renderToStaticMarkup(createElement(AnalyzedSkinCatalog, {
      items: [item],
      busyGroupKey: null,
      busyRevisionIds: new Set<string>(),
      loading: false,
      error: null,
      selectedRevisionId: item.revision.id,
      onActivate: vi.fn(),
      onActivateRevision: vi.fn(),
      onExportGroup: vi.fn(),
      onExportVariantGroup: vi.fn(),
      onArchive: vi.fn(async () => true),
      onRestore: vi.fn(async () => true),
    }));

    expect(html).toContain('aria-label="目录状态筛选"');
    expect(html).toContain('aria-pressed="true">当前目录 1');
    expect(html).toContain("归档此结果…");
    expect(html).toContain("Revision、AI 记录和已入库资产保持不变");
    expect(html).not.toContain("恢复到目录");
  });

  it("keeps archived entries readable, restorable, and visibly busy", () => {
    const item = analyzedSkin({
      catalogStatus: "archived",
      archivedAt: "2026-08-14T09:30:00.000Z",
      archivedReason: "重复分析",
    });
    const html = renderToStaticMarkup(createElement(AnalyzedSkinCatalog, {
      items: [item],
      busyGroupKey: null,
      busyRevisionIds: new Set([item.revision.id]),
      loading: false,
      error: "目录暂时不可用",
      selectedRevisionId: null,
      initialStatusFilter: "archived",
      onActivate: vi.fn(),
      onActivateRevision: vi.fn(),
      onExportGroup: vi.fn(),
      onExportVariantGroup: vi.fn(),
      onArchive: vi.fn(async () => true),
      onRestore: vi.fn(async () => true),
    }));

    expect(html).toContain('data-catalog-status="archived"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("已归档");
    expect(html).toContain("重复分析");
    expect(html).toContain("恢复中…");
    expect(html).toContain('aria-label="载入历史 Red skin main #2"');
    expect(html).toContain('<p class="catalog-error" role="alert">目录暂时不可用</p>');
  });

  it("states that catalog cleanup does not delete immutable evidence or library assets", () => {
    expect(analyzedSkinArchiveDescription(analyzedSkin())).toBe(
      "归档后默认目录会隐藏“Red skin · main #2”。Revision、AI 运行记录以及已入库组件/完整大类不会删除。",
    );
  });

  it("nests an applied repair version under the original result", () => {
    const item = analyzedSkin({
      semanticFollowup: {
        jobId: "job_1",
        status: "applied",
        evidenceHash: `sha256:${"a".repeat(64)}`,
        suggestionCount: 1,
        suggestedPixelCount: 12,
        notices: [],
        appliedVariant: {
          revision: {
            id: "revision_repaired",
            branchId: "branch_main",
            branchName: "main",
            sequence: 3,
            createdAt: "2026-08-14T09:05:00.000Z",
          },
          groups: [],
          skinUrl: "/api/revisions/revision_repaired/skin.png",
          label: "分类修复版",
        },
      },
    });
    const html = renderToStaticMarkup(createElement(AnalyzedSkinCatalog, {
      items: [item],
      busyGroupKey: null,
      busyRevisionIds: new Set<string>(),
      loading: false,
      error: null,
      selectedRevisionId: "revision_repaired",
      onActivate: vi.fn(),
      onActivateRevision: vi.fn(),
      onExportGroup: vi.fn(),
      onExportVariantGroup: vi.fn(),
      onArchive: vi.fn(async () => true),
      onRestore: vi.fn(async () => true),
    }));

    expect(html).toContain("已生成分类修复版");
    expect(html).toContain("分类调整后的版本");
    expect(html).toContain('data-active="true"');
    expect(html).not.toContain(`sha256:${"a".repeat(64)}`);
  });

  it("filters and searches original and applied-variant groups together", () => {
    const item = analyzedSkin({
      semanticFollowup: {
        jobId: "job_1",
        status: "applied",
        evidenceHash: `sha256:${"b".repeat(64)}`,
        suggestionCount: 1,
        suggestedPixelCount: 12,
        notices: [],
        appliedVariant: {
          revision: {
            id: "revision_repaired",
            branchId: "branch_main",
            branchName: "main",
            sequence: 3,
            createdAt: "2026-08-14T09:05:00.000Z",
          },
          groups: [
            {
              ...analyzedSkin().groups[0]!,
              key: "aggregate.clothing",
              kind: "clothing",
              displayName: "修复衣服",
              componentIds: ["clothing.repaired"],
            },
            {
              ...analyzedSkin().groups[0]!,
              key: "aggregate.accessory",
              kind: "accessory",
              displayName: "修复饰品",
              componentIds: ["accessory.repaired"],
            },
          ],
          skinUrl: "/api/revisions/revision_repaired/skin.png",
          label: "分类修复版",
        },
      },
    });

    const results = filterAnalyzedSkinCatalog([item], {
      kind: "clothing",
      status: "active",
      query: "修复衣服",
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.groups).toEqual([]);
    expect(results[0]?.semanticFollowup?.appliedVariant?.groups).toEqual([
      expect.objectContaining({ kind: "clothing", displayName: "修复衣服" }),
    ]);
    expect(item.semanticFollowup?.appliedVariant?.groups).toHaveLength(2);

    const html = renderToStaticMarkup(createElement(AnalyzedSkinCatalog, {
      items: results,
      busyGroupKey: null,
      busyRevisionIds: new Set<string>(),
      loading: false,
      error: null,
      selectedRevisionId: null,
      onActivate: vi.fn(),
      onActivateRevision: vi.fn(),
      onExportGroup: vi.fn(),
      onExportVariantGroup: vi.fn(),
      onArchive: vi.fn(async () => true),
      onRestore: vi.fn(async () => true),
    }));
    expect(html).toContain("修复衣服入库");
    expect(html).not.toContain("修复饰品入库");
  });

  it("does not label a no-suggestion result as fully repaired", () => {
    const item = analyzedSkin({
      semanticFollowup: {
        jobId: "job_1",
        status: "no_repair",
        evidenceHash: `sha256:${"c".repeat(64)}`,
        suggestionCount: 0,
        suggestedPixelCount: 0,
        notices: [],
        appliedVariant: null,
      },
    });
    const html = renderToStaticMarkup(createElement(AnalyzedSkinCatalog, {
      items: [item],
      busyGroupKey: null,
      busyRevisionIds: new Set<string>(),
      loading: false,
      error: null,
      selectedRevisionId: null,
      onActivate: vi.fn(),
      onActivateRevision: vi.fn(),
      onExportGroup: vi.fn(),
      onExportVariantGroup: vi.fn(),
      onArchive: vi.fn(async () => true),
      onRestore: vi.fn(async () => true),
    }));

    expect(html).toContain("未发现跨部位分类建议");
    expect(html).toContain("隐藏内容仍可能需补全");
    expect(html).not.toContain("无需修补");
  });
});

function analyzedSkin(overrides: Partial<ApiAnalyzedSkin> = {}): ApiAnalyzedSkin {
  return {
    project: { id: "project_1", name: "Red skin" },
    revision: {
      id: "revision_active",
      branchId: "branch_main",
      branchName: "main",
      sequence: 2,
      createdAt: "2026-08-14T09:00:00.000Z",
    },
    aiJob: {
      id: "job_1",
      provider: "codex-exec",
      model: "codex-config-default",
      finishedAt: "2026-08-14T09:01:00.000Z",
    },
    armType: "slim",
    componentCount: 11,
    unknownPixelCount: 0,
    reviewItemCount: 0,
    catalogStatus: "active",
    archivedAt: null,
    archivedReason: null,
    semanticFollowup: null,
    groups: [{
      key: "aggregate.hair",
      sourceGroupKey: null,
      kind: "hair",
      displayName: "完整头发",
      componentIds: ["hair.main"],
      componentCount: 1,
      pixelCount: 403,
      exportedBundleId: null,
    }],
    skinUrl: "/api/revisions/revision_active/skin.png",
    ...overrides,
  };
}
