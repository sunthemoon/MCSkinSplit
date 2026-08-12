import { describe, expect, it } from "vitest";
import {
  buildPartRepairOperation,
  resolveRepairBasePart,
} from "../lib/partRepairOperations";
import type { ApiPart, ApiPartEditDetail } from "../lib/revisionApi";

const common = {
  armType: "slim" as const,
  selectedPixelIds: [8 * 64 + 8, 8 * 64 + 9],
  headRevisionId: "edit_rev_4",
  paintColor: "#d6a17b",
  paintAlpha: 200,
  replaceFrom: "#000000",
  replaceFromAlpha: 255,
  replaceTo: "#abcdef",
  replaceAlpha: 255,
  sourceSide: "left" as const,
  limb: "arm" as const,
  layer: "outer" as const,
  donorPartId: "part_donor",
  sourceSurface: "torso.outer.front" as const,
  targetSurface: "torso.outer.back" as const,
  overwrite: "transparent_only" as const,
};

describe("component repair operation builder", () => {
  it("serializes transparent-UV paint selections as canonical spans", () => {
    expect(buildPartRepairOperation({ ...common, tool: "paint" })).toEqual({
      type: "paint_color",
      spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 9 }],
      rgba: [214, 161, 123, 200],
    });
  });

  it("references the exact immutable head for a limb mirror", () => {
    const operation = buildPartRepairOperation({
      ...common,
      tool: "mirror",
      selectedPixelIds: [],
    });
    expect(operation).toMatchObject({
      type: "copy_surfaces",
      source: { kind: "edit_revision", revisionId: "edit_rev_4" },
      overwrite: "transparent_only",
    });
    expect(operation.type === "copy_surfaces" && operation.mappings).toHaveLength(6);
  });

  it("omits replace spans to request a global exact-color replacement", () => {
    expect(buildPartRepairOperation({
      ...common,
      tool: "replace",
      selectedPixelIds: [],
    })).toEqual({
      type: "replace_color",
      from: [0, 0, 0, 255],
      to: [171, 205, 239, 255],
    });
  });

  it("keeps replacement output opaque when the numeric input reaches zero", () => {
    expect(buildPartRepairOperation({
      ...common,
      tool: "replace",
      replaceAlpha: 0,
    })).toMatchObject({
      type: "replace_color",
      to: [171, 205, 239, 1],
    });
  });

  it("uses the opened repair detail as the authoritative base part", () => {
    const catalogPart = { id: "part_catalog", armType: "wide" } as ApiPart;
    const openedPart = { id: "part_archived", armType: "slim" } as ApiPart;
    const detail = { basePart: openedPart } as ApiPartEditDetail;

    expect(resolveRepairBasePart(detail, [catalogPart], catalogPart.id)).toBe(openedPart);
    expect(resolveRepairBasePart(null, [catalogPart], catalogPart.id)).toBe(catalogPart);
  });
});
