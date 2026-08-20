import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("player semantic review shell", () => {
  it("renders component, 2D/3D canvas, and classification columns with expert tools collapsed", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('aria-label="检查并修正组件分类"');
    expect(html).toContain('data-testid="semantic-component-column"');
    expect(html).toContain('data-testid="semantic-canvas-column"');
    expect(html).toContain('data-testid="semantic-classification-column"');
    expect(html).toContain('aria-label="像素选择工具"');
    expect(html).toContain("画笔");
    expect(html).toContain("矩形");
    expect(html).toContain("同色魔棒");
    expect(html).toContain("整面");
    expect(html).toContain("更多选区与语义对照");
    expect(html).toContain("组件关系（可选）");
    expect(html).toContain("确认后由系统生成组件编号");
    expect(html).not.toContain('class="semantic-raw-id" open=""');
    expect(html).not.toContain('data-testid="completion-workspace"');
  });
});
