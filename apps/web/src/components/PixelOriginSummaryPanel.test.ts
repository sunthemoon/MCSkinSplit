import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PixelOriginSummaryPanel,
  compactPixelOriginSummary,
  partOriginDetailLabel,
  partOriginStatusLabel,
} from "./PixelOriginSummaryPanel";

describe("PixelOriginSummaryPanel", () => {
  it("renders a clear legacy boundary without zero-count guessing", () => {
    const markup = renderToStaticMarkup(
      createElement(PixelOriginSummaryPanel, {
        activeComponentId: null,
        origin: {
          availability: "legacy_unavailable",
          revisionId: "rev_legacy",
          originAssetId: null,
          document: null,
          summary: null,
          componentSummaries: {},
        },
      }),
    );

    expect(markup).toContain("旧版本没有逐像素来源记录");
    expect(markup).toContain("不会冒充原图");
    expect(markup).not.toContain("原图</dt><dd>0 px");
  });

  it("shows revision and selected-component counts with copy lineage separated", () => {
    const summary = {
      counts: {
        source_visible: 10,
        manual_authored: 2,
        generated_completion: 3,
        legacy_mixed: 4,
      },
      containsGeneratedPixels: true,
    } as const;
    const markup = renderToStaticMarkup(
      createElement(PixelOriginSummaryPanel, {
        activeComponentId: "hair.main",
        origin: {
          availability: "recorded",
          revisionId: "rev_origin",
          originAssetId: "asset_origin",
          document: {
            schemaVersion: "1.0",
            subject: { kind: "revision", id: "rev_origin" },
            source: {
              width: 64,
              height: 64,
              armType: "slim",
              coordinateOrigin: "top-left",
            },
            entries: [],
            copyLineage: [
              {
                pixelId: 1,
                derivation: "copied",
                copiedFrom: {
                  sourceSubject: { kind: "part", id: "part_source" },
                  sourceComponentInstanceId: "hair.main",
                  sourcePixelId: 1,
                },
              },
            ],
          },
          summary,
          componentSummaries: { "hair.main": summary },
        },
      }),
    );

    expect(markup).toContain("像素来源已记录");
    expect(markup).toContain("1 px 含复制关系");
    expect(markup).toContain("所选组件 · 原图 10 px");
    expect(markup).toContain("推测补全</dt><dd>3 px");
    expect(markup).toContain("复制只记录来自哪里");
  });

  it("formats the same four player-facing origin groups in stable order", () => {
    expect(
      compactPixelOriginSummary({
        counts: {
          source_visible: 5,
          manual_authored: 4,
          generated_completion: 3,
          legacy_mixed: 2,
        },
        containsGeneratedPixels: true,
      }),
    ).toBe("原图 5 px · 手动修改 4 px · 推测补全 3 px · 历史来源不明 2 px");
  });

  it("keeps legacy Parts distinct from recorded Part 2.0 summaries", () => {
    const base = {
      id: "part_test",
      name: "Test",
      category: "hair" as const,
      source: {
        projectId: "project_test",
        revisionId: "revision_test",
        componentInstanceId: "hair.main",
      },
      compatibility: { resolution: "64x64" as const, armTypes: ["slim" as const] },
      placement: { preferredLayers: ["base" as const], surfaces: ["head.base.front" as const] },
      relations: { softConflicts: [], hardConflicts: [] },
      palette: { dominant: "#010203" },
      maskMode: "write-colored-pixels-only" as const,
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    expect(partOriginStatusLabel({ ...base, schemaVersion: "1.0" })).toBe(
      "旧资产 · 来源未逐像素记录",
    );
    const current = {
      ...base,
      schemaVersion: "2.0" as const,
      origin: {
        schemaVersion: "1.0" as const,
        file: "origin.json" as const,
        generatedMaskFile: "generated-mask.png" as const,
        summary: {
          counts: {
            source_visible: 7,
            manual_authored: 1,
            generated_completion: 2,
            legacy_mixed: 0,
          },
          containsGeneratedPixels: true,
        },
        containsGeneratedPixels: true,
      },
    };
    expect(partOriginStatusLabel(current)).toBe("含推测补全 2 px");
    expect(partOriginDetailLabel(current)).toContain("原图 7 px");
    expect(partOriginDetailLabel(current)).toContain("推测补全 2 px");
    expect(
      partOriginStatusLabel({
        ...current,
        origin: {
          ...current.origin,
          summary: {
            ...current.origin.summary,
            counts: {
              ...current.origin.summary.counts,
              legacy_mixed: 3,
            },
          },
        },
      }),
    ).toBe("历史来源不明 3 px");
  });
});
