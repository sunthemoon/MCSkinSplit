import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canvasPointToPixelId } from "../lib/semanticCanvasCoordinates";
import { SemanticEditorCanvas } from "./SemanticEditorCanvas";

describe("SemanticEditorCanvas coordinates", () => {
  const rect = { left: 10, top: 20, width: 640, height: 640 };

  it("maps scaled client coordinates to exact atlas pixels", () => {
    expect(canvasPointToPixelId(10, 20, rect)).toBe(0);
    expect(canvasPointToPixelId(95, 105, rect)).toBe(8 * 64 + 8);
    expect(canvasPointToPixelId(649.9, 659.9, rect)).toBe(64 * 64 - 1);
  });

  it("rejects points outside the canvas", () => {
    expect(canvasPointToPixelId(9, 20, rect)).toBeNull();
    expect(canvasPointToPixelId(650, 20, rect)).toBeNull();
    expect(canvasPointToPixelId(10, 660, rect)).toBeNull();
    expect(
      canvasPointToPixelId(10, 20, { ...rect, width: 0 }),
    ).toBeNull();
  });

  it("offers a focusable keyboard and touch-capable canvas contract", () => {
    const html = renderToStaticMarkup(createElement(SemanticEditorCanvas, {
      armType: "slim",
      components: [],
      diffPixelIds: [520, 521],
      image: { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) },
      selectedPixelIds: [],
      selectionTool: "magic",
      viewMode: "ownership",
      onSelectionChange: () => undefined,
    }));

    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-selection-tool="magic"');
    expect(html).toContain('data-view-mode="ownership"');
    expect(html).toContain('data-diff-count="2"');
    expect(html).toContain("对父版本高亮 2 个变化像素");
    expect(html).toContain("方向键移动，空格或回车选择");
  });
});
