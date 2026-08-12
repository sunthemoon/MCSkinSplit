import { createUsedUvMask, getSkinLayout, type ArmType } from "@mc-skin-split/skin-core";
import { canvasPointToPixelId } from "./semanticCanvasCoordinates";

export function repairCanvasPointToPixelId(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  armType: ArmType,
): number | null {
  const pixelId = canvasPointToPixelId(clientX, clientY, rect);
  if (pixelId === null) {
    return null;
  }
  const validUv = createUsedUvMask(getSkinLayout(armType));
  return validUv[pixelId] === 0 ? null : pixelId;
}
