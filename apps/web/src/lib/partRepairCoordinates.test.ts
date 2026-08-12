import { describe, expect, it } from "vitest";
import { repairCanvasPointToPixelId } from "./partRepairCoordinates";

describe("part repair canvas coordinates", () => {
  const rect = { left: 10, top: 20, width: 640, height: 640 };

  it("accepts valid UV coordinates without inspecting texture alpha", () => {
    expect(repairCanvasPointToPixelId(95, 105, rect, "slim")).toBe(8 * 64 + 8);
    expect(repairCanvasPointToPixelId(415, 425, rect, "slim")).toBe(40 * 64 + 40);
  });

  it("rejects atlas padding and out-of-bounds coordinates", () => {
    expect(repairCanvasPointToPixelId(15, 25, rect, "slim")).toBeNull();
    expect(repairCanvasPointToPixelId(650, 20, rect, "slim")).toBeNull();
  });
});
