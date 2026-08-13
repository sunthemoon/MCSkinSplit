import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_SECTIONS,
  WorkflowSectionNav,
  resolveActiveWorkflowSection,
  resolveWorkflowSectionIdFromHash,
} from "./WorkflowSectionNav";

describe("workflow section navigation", () => {
  it("renders the complete ordered workflow as native fragment links", () => {
    const html = renderToStaticMarkup(createElement(WorkflowSectionNav));

    expect(html).toContain('<nav class="workflow-section-nav" aria-label="工作区快速导航">');
    expect(html).toContain("<ol>");
    expect(html).not.toContain("<button");
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
    expect(new Set(WORKFLOW_SECTIONS.map((section) => section.id)).size).toBe(
      WORKFLOW_SECTIONS.length,
    );

    let previousIndex = -1;
    for (const section of WORKFLOW_SECTIONS) {
      const linkIndex = html.indexOf(`href="#${section.id}"`);
      expect(linkIndex).toBeGreaterThan(previousIndex);
      expect(html).toContain(section.label);
      expect(html).toContain(section.detail);
      previousIndex = linkIndex;
    }
  });

  it("selects the last measured section that crossed the activation line", () => {
    const positions = [
      { id: "history", top: -900 },
      { id: "catalog", top: -25 },
      { id: "ai", top: 140 },
      { id: "preview", top: 900 },
    ];

    expect(resolveActiveWorkflowSection(positions, 120)).toBe("catalog");
    expect(resolveActiveWorkflowSection(positions, 140)).toBe("ai");
  });

  it("falls back safely and forces the final section at document end", () => {
    expect(resolveActiveWorkflowSection([
      { id: "history", top: 400 },
      { id: "ai", top: Number.NaN },
      { id: "composition", top: 1600 },
    ], 120)).toBe("history");

    expect(resolveActiveWorkflowSection([
      { id: "history", top: -3200 },
      { id: "composition", top: 520 },
    ], 120, true)).toBe("composition");
    expect(resolveActiveWorkflowSection([], 120)).toBeNull();
  });

  it("accepts only exact known workflow fragments", () => {
    expect(resolveWorkflowSectionIdFromHash("#workspace-repair")).toBe(
      "workspace-repair",
    );
    expect(resolveWorkflowSectionIdFromHash("workspace-repair")).toBeNull();
    expect(resolveWorkflowSectionIdFromHash("#workspace-unknown")).toBeNull();
  });
});
