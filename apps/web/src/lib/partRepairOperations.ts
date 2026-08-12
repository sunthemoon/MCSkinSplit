import {
  createLimbMirrorMappings,
  getSkinLayout,
  pixelIdsToSpans,
  type ArmType,
  type Rgba,
  type SurfaceKey,
} from "@mc-skin-split/skin-core";
import type {
  ApiPart,
  ApiPartEditDetail,
  ApiPartEditOperation,
} from "./revisionApi";

export type RepairTool = "paint" | "erase" | "replace" | "mirror" | "donor";

export interface PartRepairOperationInput {
  readonly tool: RepairTool;
  readonly armType: ArmType;
  readonly selectedPixelIds: readonly number[];
  readonly headRevisionId: string;
  readonly paintColor: string;
  readonly paintAlpha: number;
  readonly replaceFrom: string;
  readonly replaceFromAlpha: number;
  readonly replaceTo: string;
  readonly replaceAlpha: number;
  readonly sourceSide: "left" | "right";
  readonly limb: "arm" | "leg";
  readonly layer: "base" | "outer";
  readonly donorPartId: string;
  readonly sourceSurface: SurfaceKey;
  readonly targetSurface: SurfaceKey;
  readonly overwrite: "all" | "transparent_only";
}

export function buildPartRepairOperation(
  input: PartRepairOperationInput,
): ApiPartEditOperation {
  const spans = pixelIdsToSpans(
    input.selectedPixelIds,
    getSkinLayout(input.armType),
  );
  switch (input.tool) {
    case "paint":
      return {
        type: "paint_color",
        spans,
        rgba: colorToRgba(input.paintColor, input.paintAlpha, 1),
      };
    case "erase":
      return { type: "erase_pixels", spans };
    case "replace":
      return {
        type: "replace_color",
        from: colorToRgba(input.replaceFrom, input.replaceFromAlpha),
        to: colorToRgba(input.replaceTo, input.replaceAlpha, 1),
        ...(spans.length ? { spans } : {}),
      };
    case "mirror":
      return {
        type: "copy_surfaces",
        source: {
          kind: "edit_revision",
          revisionId: input.headRevisionId,
        },
        mappings: createLimbMirrorMappings({
          sourceSide: input.sourceSide,
          limb: input.limb,
          layer: input.layer,
        }),
        overwrite: input.overwrite,
      };
    case "donor": {
      if (!input.donorPartId) {
        throw new Error("请选择借色来源组件");
      }
      return {
        type: "copy_surfaces",
        source: { kind: "part", partId: input.donorPartId },
        mappings: [
          {
            sourceSurface: input.sourceSurface,
            targetSurface: input.targetSurface,
          },
        ],
        overwrite: input.overwrite,
      };
    }
  }
}

export function resolveRepairBasePart(
  detail: Pick<ApiPartEditDetail, "basePart"> | null,
  parts: readonly ApiPart[],
  selectedBasePartId: string,
): ApiPart | undefined {
  return detail?.basePart
    ?? parts.find((part) => part.id === selectedBasePartId);
}

function colorToRgba(color: string, alpha: number, minAlpha = 0): Rgba {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error("颜色必须为 #RRGGBB");
  }
  if (!Number.isFinite(alpha)) {
    throw new Error("ALPHA 必须是有限数字");
  }
  const checkedAlpha = Math.max(
    minAlpha,
    Math.min(255, Math.round(alpha)),
  );
  return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
    checkedAlpha,
  ];
}
