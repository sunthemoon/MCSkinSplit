const ATLAS_SIZE = 64;

export function canvasPointToPixelId(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
): number | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = Math.floor(((clientX - rect.left) / rect.width) * ATLAS_SIZE);
  const y = Math.floor(((clientY - rect.top) / rect.height) * ATLAS_SIZE);
  if (x < 0 || x >= ATLAS_SIZE || y < 0 || y >= ATLAS_SIZE) {
    return null;
  }
  return y * ATLAS_SIZE + x;
}
