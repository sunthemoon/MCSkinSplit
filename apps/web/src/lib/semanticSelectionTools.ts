import {
  buildSurfaceTexels,
  createLimbMirrorMappings,
  getSkinLayout,
  pixelIdsToSpans,
  spansToPixelIds,
  type ArmType,
  type BodyPart,
  type Face,
  type Layer,
  type RgbaImage,
  type SemanticComponent,
  type SurfaceKey,
  type SurfaceTexel,
  type SemanticPixelSpan,
} from "@mc-skin-split/skin-core";

export type SemanticSelectionTool = "brush" | "rectangle" | "magic" | "surface";
export type SemanticCanvasViewMode = "texture" | "ownership" | "category";

export interface SemanticSelectionHistory {
  readonly past: readonly (readonly number[])[];
  readonly present: readonly number[];
  readonly future: readonly (readonly number[])[];
}

export interface SemanticRevisionSnapshot {
  readonly image: RgbaImage;
  readonly armType: ArmType;
  readonly components: readonly SemanticComponent[];
}

export interface SemanticRevisionDiff {
  readonly texturePixelIds: readonly number[];
  readonly ownershipPixelIds: readonly number[];
  readonly categoryPixelIds: readonly number[];
}

export function createSemanticSelectionHistory(
  initial: readonly number[] = [],
): SemanticSelectionHistory {
  return { past: [], present: normalizePixelIds(initial), future: [] };
}

export function commitSemanticSelection(
  history: SemanticSelectionHistory,
  nextPixelIds: readonly number[],
): SemanticSelectionHistory {
  const next = normalizePixelIds(nextPixelIds);
  if (pixelListsEqual(history.present, next)) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: [],
  };
}

export function undoSemanticSelection(
  history: SemanticSelectionHistory,
): SemanticSelectionHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoSemanticSelection(
  history: SemanticSelectionHistory,
): SemanticSelectionHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function applySelectionPixels(
  currentPixelIds: readonly number[],
  candidatePixelIds: readonly number[],
  mode: "add" | "remove",
): readonly number[] {
  const result = new Set(currentPixelIds);
  for (const pixelId of candidatePixelIds) {
    if (mode === "add") result.add(pixelId);
    else result.delete(pixelId);
  }
  return [...result].sort((left, right) => left - right);
}

export function visibleUsedPixelIds(
  image: RgbaImage,
  armType: ArmType,
): readonly number[] {
  return buildSurfaceTexels(image, getSkinLayout(armType))
    .filter((texel) => texel.rgba[3] !== 0)
    .map((texel) => texel.pixelId)
    .sort((left, right) => left - right);
}

export function semanticSelectionSpans(
  pixelIds: readonly number[],
  authoritativeArmType: ArmType,
): readonly SemanticPixelSpan[] {
  return pixelIdsToSpans(pixelIds, getSkinLayout(authoritativeArmType));
}

export function rectangleSelectionPixelIds(
  image: RgbaImage,
  armType: ArmType,
  startPixelId: number,
  endPixelId: number,
): readonly number[] {
  const valid = new Set(visibleUsedPixelIds(image, armType));
  const startX = startPixelId % 64;
  const startY = Math.floor(startPixelId / 64);
  const endX = endPixelId % 64;
  const endY = Math.floor(endPixelId / 64);
  const ids: number[] = [];
  for (let y = Math.min(startY, endY); y <= Math.max(startY, endY); y += 1) {
    for (let x = Math.min(startX, endX); x <= Math.max(startX, endX); x += 1) {
      const pixelId = y * 64 + x;
      if (valid.has(pixelId)) ids.push(pixelId);
    }
  }
  return ids;
}

export function connectedExactColorPixelIds(
  image: RgbaImage,
  armType: ArmType,
  startPixelId: number,
): readonly number[] {
  const texels = buildSurfaceTexels(image, getSkinLayout(armType));
  const start = texels.find((texel) => texel.pixelId === startPixelId);
  if (!start || start.rgba[3] === 0) return [];
  const byCoordinate = new Map(
    texels
      .filter((texel) => texel.surface === start.surface && texel.rgba[3] !== 0)
      .map((texel) => [`${texel.localU}:${texel.localV}`, texel] as const),
  );
  const queue = [start];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const texel = queue.shift()!;
    if (visited.has(texel.pixelId) || !rgbaEqual(texel.rgba, start.rgba)) continue;
    visited.add(texel.pixelId);
    for (const [u, v] of [
      [texel.localU - 1, texel.localV],
      [texel.localU + 1, texel.localV],
      [texel.localU, texel.localV - 1],
      [texel.localU, texel.localV + 1],
    ] as const) {
      const neighbor = byCoordinate.get(`${u}:${v}`);
      if (neighbor && !visited.has(neighbor.pixelId)) queue.push(neighbor);
    }
  }
  return [...visited].sort((left, right) => left - right);
}

export function surfaceSelectionPixelIds(
  image: RgbaImage,
  armType: ArmType,
  startPixelId: number,
): readonly number[] {
  const texels = buildSurfaceTexels(image, getSkinLayout(armType));
  const start = texels.find((texel) => texel.pixelId === startPixelId);
  if (!start || start.rgba[3] === 0) return [];
  return texels
    .filter((texel) => texel.surface === start.surface && texel.rgba[3] !== 0)
    .map((texel) => texel.pixelId)
    .sort((left, right) => left - right);
}

export function mirroredSelectionPixelIds(
  image: RgbaImage,
  armType: ArmType,
  sourcePixelIds: readonly number[],
): readonly number[] {
  const layout = getSkinLayout(armType);
  const texels = buildSurfaceTexels(image, layout);
  const byPixel = new Map(texels.map((texel) => [texel.pixelId, texel]));
  const byCoordinate = new Map(
    texels.map((texel) => [texelCoordinateKey(
      texel.surface,
      texel.localU,
      texel.localV,
    ), texel]),
  );
  const widthBySurface = new Map<SurfaceKey, number>();
  for (const texel of texels) {
    widthBySurface.set(
      texel.surface,
      Math.max(widthBySurface.get(texel.surface) ?? 0, texel.localU + 1),
    );
  }
  const targets = new Set<number>();
  for (const pixelId of sourcePixelIds) {
    const source = byPixel.get(pixelId);
    if (!source) continue;
    const targetSurface = mirroredSurface(source);
    if (!layout.surfaces[targetSurface]) continue;
    const width = widthBySurface.get(targetSurface) ?? 0;
    const target = byCoordinate.get(texelCoordinateKey(
      targetSurface,
      width - 1 - source.localU,
      source.localV,
    ));
    if (target && target.rgba[3] !== 0) targets.add(target.pixelId);
  }
  return [...targets].sort((left, right) => left - right);
}

/**
 * Finds real cube-edge neighbors by matching canonical 3D texel edge segments.
 * Atlas proximity is deliberately ignored, so unrelated packed UV islands never
 * become seam neighbors.
 */
export function seamExpansionPixelIds(
  image: RgbaImage,
  armType: ArmType,
  sourcePixelIds: readonly number[],
): readonly number[] {
  const texels = buildSurfaceTexels(image, getSkinLayout(armType));
  const sourceSet = new Set(sourcePixelIds);
  const sourceById = new Map(texels.map((texel) => [texel.pixelId, texel]));
  const dimensions = cuboidDimensions(texels);
  const edgeIndex = new Map<string, SurfaceTexel[]>();
  for (const texel of texels) {
    const size = dimensions.get(`${texel.bodyPart}.${texel.layer}`);
    if (!size) continue;
    for (const edge of texelEdges(texel, size)) {
      const key = edgeKey(texel.bodyPart, texel.layer, edge);
      const list = edgeIndex.get(key) ?? [];
      list.push(texel);
      edgeIndex.set(key, list);
    }
  }
  const expanded = new Set<number>();
  for (const pixelId of sourceSet) {
    const source = sourceById.get(pixelId);
    const size = source
      ? dimensions.get(`${source.bodyPart}.${source.layer}`)
      : null;
    if (!source || !size) continue;
    for (const edge of texelEdges(source, size)) {
      const neighbors = edgeIndex.get(
        edgeKey(source.bodyPart, source.layer, edge),
      ) ?? [];
      for (const neighbor of neighbors) {
        if (
          neighbor.face !== source.face &&
          neighbor.rgba[3] !== 0 &&
          !sourceSet.has(neighbor.pixelId)
        ) {
          expanded.add(neighbor.pixelId);
        }
      }
    }
  }
  return [...expanded].sort((left, right) => left - right);
}

export function compareSemanticRevisionSnapshots(
  parent: SemanticRevisionSnapshot,
  current: SemanticRevisionSnapshot,
): SemanticRevisionDiff {
  if (
    parent.image.width !== current.image.width ||
    parent.image.height !== current.image.height ||
    parent.image.data.length !== current.image.data.length
  ) {
    throw new TypeError("Semantic Revision diff requires equal-size RGBA images");
  }
  const texturePixelIds: number[] = [];
  const pixelCount = current.image.width * current.image.height;
  for (let pixelId = 0; pixelId < pixelCount; pixelId += 1) {
    const offset = pixelId * 4;
    if (
      parent.image.data[offset] !== current.image.data[offset] ||
      parent.image.data[offset + 1] !== current.image.data[offset + 1] ||
      parent.image.data[offset + 2] !== current.image.data[offset + 2] ||
      parent.image.data[offset + 3] !== current.image.data[offset + 3]
    ) {
      texturePixelIds.push(pixelId);
    }
  }

  const parentSemantics = semanticPixelMaps(parent);
  const currentSemantics = semanticPixelMaps(current);
  const semanticPixelIds = new Set([
    ...parentSemantics.ownership.keys(),
    ...currentSemantics.ownership.keys(),
  ]);
  const ownershipPixelIds: number[] = [];
  const categoryPixelIds: number[] = [];
  for (const pixelId of semanticPixelIds) {
    if (
      (parentSemantics.ownership.get(pixelId) ?? null) !==
      (currentSemantics.ownership.get(pixelId) ?? null)
    ) {
      ownershipPixelIds.push(pixelId);
    }
    if (
      (parentSemantics.category.get(pixelId) ?? null) !==
      (currentSemantics.category.get(pixelId) ?? null)
    ) {
      categoryPixelIds.push(pixelId);
    }
  }
  return {
    texturePixelIds,
    ownershipPixelIds: ownershipPixelIds.sort((left, right) => left - right),
    categoryPixelIds: categoryPixelIds.sort((left, right) => left - right),
  };
}

export function semanticRevisionDiffPixelIds(
  diff: SemanticRevisionDiff,
  mode: SemanticCanvasViewMode,
): readonly number[] {
  if (mode === "texture") return diff.texturePixelIds;
  if (mode === "ownership") return diff.ownershipPixelIds;
  return diff.categoryPixelIds;
}

export function semanticRevisionDiffLabel(
  diff: SemanticRevisionDiff,
): string {
  const counts = `与父版本相比：纹理 RGBA ${diff.texturePixelIds.length} px · 像素归属 ${diff.ownershipPixelIds.length} px · 分类 ${diff.categoryPixelIds.length} px`;
  if (
    diff.texturePixelIds.length === 0 &&
    (diff.ownershipPixelIds.length > 0 || diff.categoryPixelIds.length > 0)
  ) {
    return `${counts}。纹理 RGBA 未变化；高亮只表示语义蒙版变化。`;
  }
  return `${counts}。高亮显示当前对照模式中真正变化的像素。`;
}

function semanticPixelMaps(snapshot: SemanticRevisionSnapshot): {
  readonly ownership: ReadonlyMap<number, string>;
  readonly category: ReadonlyMap<number, string>;
} {
  const layout = getSkinLayout(snapshot.armType);
  const ownership = new Map<number, string>();
  const category = new Map<number, string>();
  for (const component of snapshot.components) {
    for (const pixelId of spansToPixelIds(component.spans, layout)) {
      ownership.set(pixelId, component.instanceId);
      category.set(pixelId, component.category);
    }
  }
  return { ownership, category };
}

function mirroredSurface(texel: SurfaceTexel): SurfaceKey {
  if (
    texel.bodyPart === "leftArm" ||
    texel.bodyPart === "rightArm" ||
    texel.bodyPart === "leftLeg" ||
    texel.bodyPart === "rightLeg"
  ) {
    const sourceSide = texel.bodyPart.startsWith("left") ? "left" : "right";
    const limb = texel.bodyPart.endsWith("Arm") ? "arm" : "leg";
    return createLimbMirrorMappings({
      sourceSide,
      limb,
      layer: texel.layer,
    }).find((mapping) => mapping.sourceSurface === texel.surface)!.targetSurface;
  }
  return `${texel.bodyPart}.${texel.layer}.${mirrorFace(texel.face)}`;
}

function mirrorFace(face: Face): Face {
  if (face === "left") return "right";
  if (face === "right") return "left";
  return face;
}

interface CuboidSize {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

type Point3 = readonly [number, number, number];
type Edge3 = readonly [Point3, Point3];

function cuboidDimensions(
  texels: readonly SurfaceTexel[],
): ReadonlyMap<string, CuboidSize> {
  const result = new Map<string, CuboidSize>();
  for (const texel of texels) {
    const key = `${texel.bodyPart}.${texel.layer}`;
    const current = result.get(key) ?? { width: 0, height: 0, depth: 0 };
    result.set(key, {
      width: texel.face === "front" || texel.face === "back"
        ? Math.max(current.width, texel.localU + 1)
        : current.width,
      height: texel.face !== "top" && texel.face !== "bottom"
        ? Math.max(current.height, texel.localV + 1)
        : current.height,
      depth: texel.face === "left" || texel.face === "right"
        ? Math.max(current.depth, texel.localU + 1)
        : current.depth,
    });
  }
  return result;
}

function texelEdges(texel: SurfaceTexel, size: CuboidSize): readonly Edge3[] {
  const { localU: u, localV: v } = texel;
  let corners: readonly [Point3, Point3, Point3, Point3];
  switch (texel.face) {
    case "front":
      corners = [[u, v, size.depth], [u + 1, v, size.depth], [u + 1, v + 1, size.depth], [u, v + 1, size.depth]];
      break;
    case "back": {
      const x = size.width - u;
      corners = [[x, v, 0], [x - 1, v, 0], [x - 1, v + 1, 0], [x, v + 1, 0]];
      break;
    }
    case "left":
      corners = [[0, v, u], [0, v, u + 1], [0, v + 1, u + 1], [0, v + 1, u]];
      break;
    case "right": {
      const z = size.depth - u;
      corners = [[size.width, v, z], [size.width, v, z - 1], [size.width, v + 1, z - 1], [size.width, v + 1, z]];
      break;
    }
    case "top":
      corners = [[u, 0, v], [u + 1, 0, v], [u + 1, 0, v + 1], [u, 0, v + 1]];
      break;
    case "bottom": {
      const z = size.depth - v;
      corners = [[u, size.height, z], [u + 1, size.height, z], [u + 1, size.height, z - 1], [u, size.height, z - 1]];
      break;
    }
  }
  return [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
}

function edgeKey(
  bodyPart: BodyPart,
  layer: Layer,
  edge: Edge3,
): string {
  const points = [pointKey(edge[0]), pointKey(edge[1])].sort();
  return `${bodyPart}.${layer}:${points[0]}|${points[1]}`;
}

function pointKey(point: Point3): string {
  return point.join(",");
}

function texelCoordinateKey(
  surface: SurfaceKey,
  u: number,
  v: number,
): string {
  return `${surface}:${u}:${v}`;
}

function rgbaEqual(
  left: SurfaceTexel["rgba"],
  right: SurfaceTexel["rgba"],
): boolean {
  return left.every((value, index) => value === right[index]);
}

function normalizePixelIds(pixelIds: readonly number[]): readonly number[] {
  return [...new Set(pixelIds)].sort((left, right) => left - right);
}

function pixelListsEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((pixelId, index) => pixelId === right[index]);
}
