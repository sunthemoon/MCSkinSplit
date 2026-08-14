import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SemanticFollowupReview } from "./SemanticFollowupReview";

describe("semantic followup review", () => {
  it("shows simple confirmation actions without exposing technical identifiers", () => {
    const html = renderToStaticMarkup(createElement(SemanticFollowupReview, {
      followup: {
        status: "awaiting_review",
        algorithmVersion: "cross-body-hair-reclassification-v2",
        applicable: true,
        evidenceHash: `sha256:${"a".repeat(64)}`,
        suggestions: [{
          id: "internal_suggestion_1",
          label: "疑似跨部位长发",
          pixelCount: 18,
          confidence: 0.86,
          reason: "躯干区域与头部头发颜色一致，建议确认分类",
        }],
        notices: [{ kind: "possible_hidden_clothing", message: "衣服被遮挡部分仍需智能补全确认" }],
        appliedRevisionId: null,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      busy: false,
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    }));

    expect(html).toContain("使用推荐分类修复版");
    expect(html).toContain("保留原识别");
    expect(html).toContain("86%");
    expect(html).toContain("衣服被遮挡部分仍需智能补全确认");
    expect(html).not.toContain("internal_suggestion_1");
    expect(html).not.toContain("sha256:");
  });

  it("keeps an assessment failure separate from semantic success", () => {
    const html = renderToStaticMarkup(createElement(SemanticFollowupReview, {
      followup: {
        status: "assessment_failed",
        algorithmVersion: "cross-body-hair-reclassification-v2",
        applicable: true,
        evidenceHash: `sha256:${"b".repeat(64)}`,
        suggestions: [],
        notices: [],
        appliedRevisionId: null,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      busy: false,
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    }));

    expect(html).toContain("识别结果仍可使用");
  });

  it("does not claim hidden content is complete when no classification repair is suggested", () => {
    const html = renderToStaticMarkup(createElement(SemanticFollowupReview, {
      followup: {
        status: "no_repair",
        algorithmVersion: "cross-body-hair-reclassification-v2",
        applicable: true,
        evidenceHash: `sha256:${"c".repeat(64)}`,
        suggestions: [],
        notices: [],
        appliedRevisionId: null,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      busy: false,
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    }));

    expect(html).toContain("未发现可安全建议的跨部位分类调整");
    expect(html).toContain("隐藏内容仍可能需要后续补全");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("无需修补");
  });

  it("keeps historical suggestions readable without offering an unsafe apply action", () => {
    const html = renderToStaticMarkup(createElement(SemanticFollowupReview, {
      followup: {
        status: "awaiting_review",
        algorithmVersion: "cross-body-hair-reclassification-v1",
        applicable: false,
        evidenceHash: `sha256:${"d".repeat(64)}`,
        suggestions: [{
          id: "followup_legacy",
          label: "历史长发建议",
          pixelCount: 12,
          confidence: 0.8,
          reason: "历史证据",
        }],
        notices: [],
        appliedRevisionId: null,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      busy: false,
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    }));

    expect(html).toContain("请使用当前规则重新分析");
    expect(html).toContain("历史长发建议");
    expect(html).not.toContain("使用推荐分类修复版");
  });
});
