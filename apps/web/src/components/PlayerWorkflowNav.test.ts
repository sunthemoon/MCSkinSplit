import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PLAYER_STEPS,
  PLAYER_WORKFLOW_HASHES,
  PlayerWorkflowNav,
  resolvePlayerWorkflowStepFromHash,
} from "./PlayerWorkflowNav";

describe("player workflow navigation", () => {
  it("renders exactly four ordinary-player steps in task order", () => {
    const html = renderToStaticMarkup(createElement(PlayerWorkflowNav, {
      mode: "player",
      step: "review",
      onSelectStep: vi.fn(),
      onChangeMode: vi.fn(),
    }));

    expect(html).toContain('aria-label="玩家四步工作流"');
    expect(html).toContain('data-testid="player-workflow-nav"');
    expect(html.match(/data-step=/g)).toHaveLength(4);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    let previous = -1;
    for (const step of PLAYER_STEPS) {
      const position = html.indexOf(`data-step="${step.id}"`);
      expect(position).toBeGreaterThan(previous);
      expect(html).toContain(step.label);
      previous = position;
    }
    expect(html).toContain("高级工作室 / 资产管理");
    expect(html).not.toContain("Provider");
    expect(html).not.toContain("Hash");
  });

  it("uses exact restorable hashes for player steps", () => {
    expect(PLAYER_WORKFLOW_HASHES).toEqual({
      import: "#player-import",
      analyze: "#player-analyze",
      review: "#player-review",
      save: "#player-save",
    });
    expect(resolvePlayerWorkflowStepFromHash("#player-save")).toBe("save");
    expect(resolvePlayerWorkflowStepFromHash("player-save")).toBeNull();
    expect(resolvePlayerWorkflowStepFromHash("#workspace-preview")).toBeNull();
  });

  it("keeps the advanced studio reachable without mixing its sections into the four steps", () => {
    const html = renderToStaticMarkup(createElement(PlayerWorkflowNav, {
      mode: "advanced",
      step: "import",
      onSelectStep: vi.fn(),
      onChangeMode: vi.fn(),
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("返回玩家四步");
    expect(html).not.toContain('aria-current="step"');
  });
});
