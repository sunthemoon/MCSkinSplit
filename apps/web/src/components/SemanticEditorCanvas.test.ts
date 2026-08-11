import { describe, expect, it } from "vitest";
import { canvasPointToPixelId } from "../lib/semanticCanvasCoordinates";

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
});
