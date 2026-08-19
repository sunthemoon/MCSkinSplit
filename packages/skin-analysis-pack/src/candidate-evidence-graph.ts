import {
  BODY_PARTS,
  FACES,
  atlasLocalToCanonical,
  getOrientedSize,
  getSkinLayout,
  type ArmType,
  type BodyPart,
  type Face,
  type Layer,
  type Rgba,
  type SkinLayout,
  type SurfaceKey,
} from "@mc-skin-split/skin-core";
import type { CandidateRegion, CandidateRegionDocument } from "./types";

export const CANDIDATE_EVIDENCE_GRAPH_SCHEMA_VERSION = "1.0";
export const CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION =
  "candidate-evidence-graph-v1";
export const SAME_SURFACE_PROXIMITY_DISTANCE = 2;

export type CandidateEvidenceEdgeKind =
  | "same_surface_contact"
  | "same_surface_proximity"
  | "uv_seam"
  | "layer_projection"
  | "bilateral_mirror";

export type CandidateShapeAxis = "balanced" | "horizontal" | "vertical";
export type CandidateColorHueFamily =
  | "neutral"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "violet"
  | "magenta";
export type CandidateColorTone = "dark" | "mid" | "light";
export type CandidateColorChroma = "neutral" | "muted" | "vivid";

export interface CandidateEvidenceGraphNode {
  readonly id: string;
  readonly visualId: string;
  readonly surface: SurfaceKey;
  readonly bodyPart: BodyPart;
  readonly layer: Layer;
  readonly face: Face;
  readonly pixelCount: number;
  readonly atlasBoundingBox: CandidateEvidenceBoundingBox;
  readonly localBoundingBox: CandidateEvidenceBoundingBox;
  readonly area: {
    readonly boundingBoxPixelCount: number;
    readonly fillRatio: number;
  };
  readonly shape: {
    /** Ratio of the longer local bounding-box side to the shorter side. */
    readonly slendernessRatio: number;
    readonly principalAxis: CandidateShapeAxis;
    /** Corners count once for each canonical surface edge they touch. */
    readonly surfaceEdgePixelCounts: Readonly<Record<SurfaceEdge, number>>;
  };
  readonly colorFamily: {
    readonly dominantRgba: Rgba;
    readonly dominantHex: string;
    readonly hue: CandidateColorHueFamily;
    readonly tone: CandidateColorTone;
    readonly chroma: CandidateColorChroma;
    readonly luminance: number;
    readonly chromaAmount: number;
  };
}

export interface CandidateEvidenceBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CandidateEvidenceGraphEdge {
  readonly id: string;
  readonly kind: CandidateEvidenceEdgeKind;
  /** Undirected canonical pair; the lexicographically smaller ID is first. */
  readonly regionIds: readonly [string, string];
  readonly evidence: {
    readonly relation: "undirected";
    readonly matchedTexelPairCount: number;
    /** Euclidean distance between dominant RGB colors; alpha is excluded. */
    readonly dominantColorDistance: number;
    readonly mappingIds: readonly string[];
    readonly minimumLocalManhattanDistance: 1 | 2 | null;
  };
}

export interface CandidateEvidenceGraphDocument {
  readonly schemaVersion: typeof CANDIDATE_EVIDENCE_GRAPH_SCHEMA_VERSION;
  readonly algorithmVersion: typeof CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION;
  readonly candidateRegionAlgorithmVersion: CandidateRegionDocument["algorithmVersion"];
  readonly armType: ArmType;
  readonly visiblePixelCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly nodes: readonly CandidateEvidenceGraphNode[];
  readonly edges: readonly CandidateEvidenceGraphEdge[];
}

export interface CandidateRegionVisualIdEntry {
  readonly regionId: string;
  readonly visualId: string;
}

export interface CandidateEvidenceGraphSummary {
  readonly schemaVersion: "1.0";
  readonly algorithmVersion: typeof CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION;
  readonly armType: ArmType;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly nodeFields: readonly string[];
  readonly nodes: readonly (readonly (string | number)[])[];
  readonly edgeFields: readonly string[];
  readonly edges: readonly (readonly (
    | string
    | number
    | null
    | readonly string[]
  )[])[];
}

type SurfaceEdge = "top" | "right" | "bottom" | "left";

interface EvidenceTexel {
  readonly pixelId: number;
  readonly atlasX: number;
  readonly atlasY: number;
  readonly surface: SurfaceKey;
  readonly bodyPart: BodyPart;
  readonly layer: Layer;
  readonly face: Face;
  readonly localU: number;
  readonly localV: number;
}

interface RegionRuntime {
  readonly region: CandidateRegion;
  readonly texels: readonly EvidenceTexel[];
  readonly node: CandidateEvidenceGraphNode;
}

interface EdgeAccumulator {
  readonly kind: CandidateEvidenceEdgeKind;
  readonly regionIds: readonly [string, string];
  readonly texelPairs: Set<string>;
  readonly mappingIds: Set<string>;
  readonly minimumLocalManhattanDistance: 1 | 2 | null;
}

interface SeamMapping {
  readonly id: string;
  readonly firstFace: Face;
  readonly firstEdge: SurfaceEdge;
  readonly secondFace: Face;
  readonly secondEdge: SurfaceEdge;
  readonly reverse: boolean;
}

/*
 * These are the twelve edges of one cuboid in canonical, outside-facing UV
 * coordinates. They are intentionally explicit: Atlas rectangle proximity is
 * never treated as physical adjacency.
 */
const UV_SEAM_MAPPINGS: readonly SeamMapping[] = [
  seam("front.top=top.bottom", "front", "top", "top", "bottom", false),
  seam("back.top=top.top", "back", "top", "top", "top", true),
  seam("front.bottom=bottom.top", "front", "bottom", "bottom", "top", false),
  seam("back.bottom=bottom.bottom", "back", "bottom", "bottom", "bottom", true),
  seam("front.left=left.right", "front", "left", "left", "right", false),
  seam("front.right=right.left", "front", "right", "right", "left", false),
  seam("back.left=right.right", "back", "left", "right", "right", false),
  seam("back.right=left.left", "back", "right", "left", "left", false),
  seam("top.left=left.top", "top", "left", "left", "top", false),
  seam("top.right=right.top", "top", "right", "right", "top", true),
  seam("bottom.left=left.bottom", "bottom", "left", "left", "bottom", true),
  seam("bottom.right=right.bottom", "bottom", "right", "right", "bottom", false),
];

const EDGE_KIND_ORDER: readonly CandidateEvidenceEdgeKind[] = [
  "same_surface_contact",
  "same_surface_proximity",
  "uv_seam",
  "layer_projection",
  "bilateral_mirror",
];

/**
 * Builds a JSON-safe, canonical graph from deterministic CandidateRegions.
 * Every relationship is computed by the host from canonical UV coordinates.
 */
export function buildCandidateEvidenceGraph(
  document: CandidateRegionDocument,
): CandidateEvidenceGraphDocument {
  const layout = getSkinLayout(document.armType);
  const indexes = createLayoutIndexes(layout);
  const runtimes = normalizeRegions(document, layout, indexes.byPixelId);
  const ownerByLocal = new Map<string, string>();
  for (const runtime of runtimes) {
    for (const texel of runtime.texels) {
      ownerByLocal.set(localKey(texel.surface, texel.localU, texel.localV), runtime.region.id);
    }
  }

  const accumulators = new Map<string, EdgeAccumulator>();
  addSameSurfaceEdges(runtimes, accumulators);
  addUvSeamEdges(layout, indexes.byLocal, ownerByLocal, accumulators);
  addLayerProjectionEdges(layout, indexes.byLocal, ownerByLocal, accumulators);
  addBilateralMirrorEdges(
    layout,
    runtimes,
    indexes.byLocal,
    ownerByLocal,
    accumulators,
  );

  const nodes = runtimes.map((runtime) => runtime.node).sort(compareNode);
  const edges = finalizeEdges(
    accumulators,
    new Map(runtimes.map((runtime) => [runtime.region.id, runtime.region] as const)),
  );
  return {
    schemaVersion: CANDIDATE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    algorithmVersion: CANDIDATE_EVIDENCE_GRAPH_ALGORITHM_VERSION,
    candidateRegionAlgorithmVersion: document.algorithmVersion,
    armType: document.armType,
    visiblePixelCount: document.visiblePixelCount,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  };
}

export const createCandidateEvidenceGraph = buildCandidateEvidenceGraph;

/** Zero-based canonical CandidateRegion index to a stable compact visual label. */
export function candidateRegionVisualId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("CandidateRegion visual index must be a non-negative safe integer");
  }
  return `R${String(index + 1).padStart(3, "0")}`;
}

/**
 * Returns the exact Region-to-label manifest shared by visual renderers and
 * prompts. Input array order is deliberately ignored.
 */
export function createCandidateRegionVisualIdEntries(
  document: CandidateRegionDocument,
): readonly CandidateRegionVisualIdEntry[] {
  const layout = getSkinLayout(document.armType);
  const ids = new Set<string>();
  return canonicalCandidateRegions(document, layout).map((region, index) => {
    if (!region.id || ids.has(region.id)) {
      throw new TypeError(`CandidateRegion has an invalid or duplicate ID: ${region.id}`);
    }
    ids.add(region.id);
    return {
      regionId: region.id,
      visualId: candidateRegionVisualId(index),
    };
  });
}

/** Compact, exact-ID-preserving transport for model prompts and audit logs. */
export function createCandidateEvidenceGraphSummary(
  graph: CandidateEvidenceGraphDocument,
): CandidateEvidenceGraphSummary {
  const visualIdByRegionId = new Map(
    graph.nodes.map((node) => [node.id, node.visualId] as const),
  );
  return {
    schemaVersion: "1.0",
    algorithmVersion: graph.algorithmVersion,
    armType: graph.armType,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    nodeFields: [
      "visualId",
      "regionId",
      "surface",
      "pixelCount",
      "dominantColor",
      "atlasX",
      "atlasY",
      "atlasWidth",
      "atlasHeight",
      "localX",
      "localY",
      "localWidth",
      "localHeight",
      "fillRatio",
      "slendernessRatio",
      "hue",
      "tone",
      "chroma",
      "edgeTop",
      "edgeRight",
      "edgeBottom",
      "edgeLeft",
    ],
    nodes: graph.nodes.map((node) => [
      node.visualId,
      node.id,
      node.surface,
      node.pixelCount,
      node.colorFamily.dominantHex,
      node.atlasBoundingBox.x,
      node.atlasBoundingBox.y,
      node.atlasBoundingBox.width,
      node.atlasBoundingBox.height,
      node.localBoundingBox.x,
      node.localBoundingBox.y,
      node.localBoundingBox.width,
      node.localBoundingBox.height,
      node.area.fillRatio,
      node.shape.slendernessRatio,
      node.colorFamily.hue,
      node.colorFamily.tone,
      node.colorFamily.chroma,
      node.shape.surfaceEdgePixelCounts.top,
      node.shape.surfaceEdgePixelCounts.right,
      node.shape.surfaceEdgePixelCounts.bottom,
      node.shape.surfaceEdgePixelCounts.left,
    ]),
    edgeFields: [
      "kind",
      "firstVisualId",
      "secondVisualId",
      "matchedTexelPairCount",
      "dominantColorDistance",
      "minimumLocalManhattanDistance",
      "mappingIds",
    ],
    edges: graph.edges.map((edge) => {
      const visualIds = canonicalPair(
        requireVisualId(visualIdByRegionId, edge.regionIds[0]),
        requireVisualId(visualIdByRegionId, edge.regionIds[1]),
      );
      return [
        edge.kind,
        visualIds[0],
        visualIds[1],
        edge.evidence.matchedTexelPairCount,
        edge.evidence.dominantColorDistance,
        edge.evidence.minimumLocalManhattanDistance,
        edge.evidence.mappingIds,
      ];
    }),
  };
}

function normalizeRegions(
  document: CandidateRegionDocument,
  layout: SkinLayout,
  texelByPixelId: ReadonlyMap<number, EvidenceTexel>,
): RegionRuntime[] {
  if (
    document.schemaVersion !== "1.0" ||
    document.algorithmVersion !== "bounded-color80-surface-cc-v2" ||
    !Number.isInteger(document.visiblePixelCount) ||
    document.visiblePixelCount < 0 ||
    !Array.isArray(document.regions)
  ) {
    throw new TypeError("CandidateRegion document has an unsupported contract");
  }

  const regionIds = new Set<string>();
  const claimedPixels = new Set<number>();
  const runtimes: RegionRuntime[] = [];
  const regions: readonly CandidateRegion[] = canonicalCandidateRegions(document, layout);
  for (const [regionIndex, region] of regions.entries()) {
    if (!region.id || regionIds.has(region.id)) {
      throw new TypeError(`CandidateRegion has an invalid or duplicate ID: ${region.id}`);
    }
    regionIds.add(region.id);
    const definition = layout.surfaces[region.surface];
    if (!definition || !Array.isArray(region.pixelIds) || region.pixelIds.length === 0) {
      throw new TypeError(`CandidateRegion ${region.id} has no valid declared surface pixels`);
    }
    if (region.pixelCount !== region.pixelIds.length) {
      throw new TypeError(`CandidateRegion ${region.id} pixelCount does not match pixelIds`);
    }
    assertRgba(region.rgba, region.id);
    if (region.dominantColor.toLowerCase() !== rgbaHex(region.rgba)) {
      throw new TypeError(`CandidateRegion ${region.id} dominant color is inconsistent`);
    }

    const localPixels = new Set<number>();
    const texels = [...region.pixelIds]
      .sort((left, right) => left - right)
      .map((pixelId) => {
        if (!Number.isInteger(pixelId) || localPixels.has(pixelId) || claimedPixels.has(pixelId)) {
          throw new TypeError(`CandidateRegion ${region.id} contains a duplicate pixel`);
        }
        localPixels.add(pixelId);
        claimedPixels.add(pixelId);
        const texel = texelByPixelId.get(pixelId);
        if (!texel || texel.surface !== region.surface) {
          throw new TypeError(
            `CandidateRegion ${region.id} pixel ${pixelId} is outside ${region.surface}`,
          );
        }
        return texel;
      });
    runtimes.push({
      region,
      texels,
      node: createNode(region, candidateRegionVisualId(regionIndex), texels, layout),
    });
  }
  if (claimedPixels.size !== document.visiblePixelCount) {
    throw new TypeError("CandidateRegion visible pixel coverage is inconsistent");
  }
  return runtimes;
}

function createNode(
  region: CandidateRegion,
  visualId: string,
  texels: readonly EvidenceTexel[],
  layout: SkinLayout,
): CandidateEvidenceGraphNode {
  const definition = layout.surfaces[region.surface]!;
  const size = surfaceSize(layout, region.surface);
  const atlasBoundingBox = boundingBox(
    texels.map((texel) => ({ x: texel.atlasX, y: texel.atlasY })),
  );
  const localBoundingBox = boundingBox(
    texels.map((texel) => ({ x: texel.localU, y: texel.localV })),
  );
  const boundingBoxPixelCount = localBoundingBox.width * localBoundingBox.height;
  const longerSide = Math.max(localBoundingBox.width, localBoundingBox.height);
  const shorterSide = Math.min(localBoundingBox.width, localBoundingBox.height);
  const edgeCounts: Record<SurfaceEdge, number> = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  for (const texel of texels) {
    if (texel.localV === 0) edgeCounts.top += 1;
    if (texel.localU === size.width - 1) edgeCounts.right += 1;
    if (texel.localV === size.height - 1) edgeCounts.bottom += 1;
    if (texel.localU === 0) edgeCounts.left += 1;
  }
  return {
    id: region.id,
    visualId,
    surface: region.surface,
    bodyPart: definition.bodyPart,
    layer: definition.layer,
    face: definition.face,
    pixelCount: texels.length,
    atlasBoundingBox,
    localBoundingBox,
    area: {
      boundingBoxPixelCount,
      fillRatio: roundEvidence(texels.length / boundingBoxPixelCount),
    },
    shape: {
      slendernessRatio: roundEvidence(longerSide / shorterSide),
      principalAxis:
        localBoundingBox.width === localBoundingBox.height
          ? "balanced"
          : localBoundingBox.width > localBoundingBox.height
            ? "horizontal"
            : "vertical",
      surfaceEdgePixelCounts: edgeCounts,
    },
    colorFamily: describeColor(region.rgba),
  };
}

function addSameSurfaceEdges(
  runtimes: readonly RegionRuntime[],
  accumulators: Map<string, EdgeAccumulator>,
): void {
  const bySurface = new Map<SurfaceKey, RegionRuntime[]>();
  for (const runtime of runtimes) {
    const entries = bySurface.get(runtime.region.surface) ?? [];
    entries.push(runtime);
    bySurface.set(runtime.region.surface, entries);
  }
  for (const surfaceRuntimes of bySurface.values()) {
    const ownerByCoordinate = new Map<string, { readonly id: string; readonly pixelId: number }>();
    for (const runtime of surfaceRuntimes) {
      for (const texel of runtime.texels) {
        ownerByCoordinate.set(`${texel.localU},${texel.localV}`, {
          id: runtime.region.id,
          pixelId: texel.pixelId,
        });
      }
    }
    for (const runtime of surfaceRuntimes) {
      for (const texel of runtime.texels) {
        for (const [du, dv] of [
          [1, 0],
          [0, 1],
        ] as const) {
          const neighbor = ownerByCoordinate.get(`${texel.localU + du},${texel.localV + dv}`);
          if (neighbor && neighbor.id !== runtime.region.id) {
            addEdgeEvidence(accumulators, {
              kind: "same_surface_contact",
              firstRegionId: runtime.region.id,
              secondRegionId: neighbor.id,
              firstPixelId: texel.pixelId,
              secondPixelId: neighbor.pixelId,
              mappingId: "canonical-orthogonal-contact",
              minimumLocalManhattanDistance: 1,
            });
          }
        }
        for (const [du, dv] of [
          [2, 0],
          [1, 1],
          [0, 2],
          [-1, 1],
        ] as const) {
          const neighbor = ownerByCoordinate.get(`${texel.localU + du},${texel.localV + dv}`);
          if (neighbor && neighbor.id !== runtime.region.id) {
            addEdgeEvidence(accumulators, {
              kind: "same_surface_proximity",
              firstRegionId: runtime.region.id,
              secondRegionId: neighbor.id,
              firstPixelId: texel.pixelId,
              secondPixelId: neighbor.pixelId,
              mappingId: "canonical-manhattan-distance-2",
              minimumLocalManhattanDistance: SAME_SURFACE_PROXIMITY_DISTANCE,
            });
          }
        }
      }
    }
  }
}

function addUvSeamEdges(
  layout: SkinLayout,
  texelByLocal: ReadonlyMap<string, EvidenceTexel>,
  ownerByLocal: ReadonlyMap<string, string>,
  accumulators: Map<string, EdgeAccumulator>,
): void {
  for (const bodyPart of BODY_PARTS) {
    for (const layer of ["base", "outer"] as const) {
      for (const mapping of UV_SEAM_MAPPINGS) {
        const firstSurface = `${bodyPart}.${layer}.${mapping.firstFace}` as SurfaceKey;
        const secondSurface = `${bodyPart}.${layer}.${mapping.secondFace}` as SurfaceKey;
        const firstSize = surfaceSize(layout, firstSurface);
        const secondSize = surfaceSize(layout, secondSurface);
        const firstLength = boundaryLength(firstSize, mapping.firstEdge);
        const secondLength = boundaryLength(secondSize, mapping.secondEdge);
        if (firstLength !== secondLength) continue;
        for (let index = 0; index < firstLength; index += 1) {
          const firstPoint = boundaryPoint(firstSize, mapping.firstEdge, index);
          const secondPoint = boundaryPoint(
            secondSize,
            mapping.secondEdge,
            mapping.reverse ? secondLength - 1 - index : index,
          );
          addMappedEdge(
            "uv_seam",
            `canonical-seam:${mapping.id}`,
            firstSurface,
            firstPoint,
            secondSurface,
            secondPoint,
            texelByLocal,
            ownerByLocal,
            accumulators,
          );
        }
      }
    }
  }
}

function addLayerProjectionEdges(
  layout: SkinLayout,
  texelByLocal: ReadonlyMap<string, EvidenceTexel>,
  ownerByLocal: ReadonlyMap<string, string>,
  accumulators: Map<string, EdgeAccumulator>,
): void {
  for (const bodyPart of BODY_PARTS) {
    for (const face of FACES) {
      const baseSurface = `${bodyPart}.base.${face}` as SurfaceKey;
      const outerSurface = `${bodyPart}.outer.${face}` as SurfaceKey;
      const baseSize = surfaceSize(layout, baseSurface);
      const outerSize = surfaceSize(layout, outerSurface);
      if (baseSize.width !== outerSize.width || baseSize.height !== outerSize.height) continue;
      for (let v = 0; v < baseSize.height; v += 1) {
        for (let u = 0; u < baseSize.width; u += 1) {
          addMappedEdge(
            "layer_projection",
            `same-texel:${bodyPart}.${face}:base=outer`,
            baseSurface,
            { u, v },
            outerSurface,
            { u, v },
            texelByLocal,
            ownerByLocal,
            accumulators,
          );
        }
      }
    }
  }
}

function addBilateralMirrorEdges(
  layout: SkinLayout,
  runtimes: readonly RegionRuntime[],
  texelByLocal: ReadonlyMap<string, EvidenceTexel>,
  ownerByLocal: ReadonlyMap<string, string>,
  accumulators: Map<string, EdgeAccumulator>,
): void {
  for (const runtime of runtimes) {
    for (const texel of runtime.texels) {
      const targetBodyPart = mirroredBodyPart(texel.bodyPart);
      const targetFace = mirroredFace(texel.face);
      const targetSurface = `${targetBodyPart}.${texel.layer}.${targetFace}` as SurfaceKey;
      const sourceSize = surfaceSize(layout, texel.surface);
      const targetSize = surfaceSize(layout, targetSurface);
      if (sourceSize.width !== targetSize.width || sourceSize.height !== targetSize.height) {
        continue;
      }
      addMappedEdge(
        "bilateral_mirror",
        "canonical-bilateral-mirror-u-v1",
        texel.surface,
        { u: texel.localU, v: texel.localV },
        targetSurface,
        { u: targetSize.width - 1 - texel.localU, v: texel.localV },
        texelByLocal,
        ownerByLocal,
        accumulators,
      );
    }
  }
}

function addMappedEdge(
  kind: "uv_seam" | "layer_projection" | "bilateral_mirror",
  mappingId: string,
  firstSurface: SurfaceKey,
  firstPoint: { readonly u: number; readonly v: number },
  secondSurface: SurfaceKey,
  secondPoint: { readonly u: number; readonly v: number },
  texelByLocal: ReadonlyMap<string, EvidenceTexel>,
  ownerByLocal: ReadonlyMap<string, string>,
  accumulators: Map<string, EdgeAccumulator>,
): void {
  const firstKey = localKey(firstSurface, firstPoint.u, firstPoint.v);
  const secondKey = localKey(secondSurface, secondPoint.u, secondPoint.v);
  const firstRegionId = ownerByLocal.get(firstKey);
  const secondRegionId = ownerByLocal.get(secondKey);
  const firstTexel = texelByLocal.get(firstKey);
  const secondTexel = texelByLocal.get(secondKey);
  if (
    firstRegionId === undefined ||
    secondRegionId === undefined ||
    firstRegionId === secondRegionId ||
    firstTexel === undefined ||
    secondTexel === undefined
  ) {
    return;
  }
  addEdgeEvidence(accumulators, {
    kind,
    firstRegionId,
    secondRegionId,
    firstPixelId: firstTexel.pixelId,
    secondPixelId: secondTexel.pixelId,
    mappingId,
    minimumLocalManhattanDistance: null,
  });
}

function addEdgeEvidence(
  accumulators: Map<string, EdgeAccumulator>,
  input: {
    readonly kind: CandidateEvidenceEdgeKind;
    readonly firstRegionId: string;
    readonly secondRegionId: string;
    readonly firstPixelId: number;
    readonly secondPixelId: number;
    readonly mappingId: string;
    readonly minimumLocalManhattanDistance: 1 | 2 | null;
  },
): void {
  if (input.firstRegionId === input.secondRegionId) return;
  const regionIds = canonicalPair(input.firstRegionId, input.secondRegionId);
  const key = accumulatorKey(input.kind, regionIds);
  const accumulator = accumulators.get(key) ?? {
    kind: input.kind,
    regionIds,
    texelPairs: new Set<string>(),
    mappingIds: new Set<string>(),
    minimumLocalManhattanDistance: input.minimumLocalManhattanDistance,
  };
  accumulator.texelPairs.add(pixelPairKey(input.firstPixelId, input.secondPixelId));
  accumulator.mappingIds.add(input.mappingId);
  accumulators.set(key, accumulator);
}

function finalizeEdges(
  accumulators: ReadonlyMap<string, EdgeAccumulator>,
  regionById: ReadonlyMap<string, CandidateRegion>,
): CandidateEvidenceGraphEdge[] {
  const edges: CandidateEvidenceGraphEdge[] = [];
  for (const accumulator of accumulators.values()) {
    if (
      accumulator.kind === "same_surface_proximity" &&
      accumulators.has(
        accumulatorKey("same_surface_contact", accumulator.regionIds),
      )
    ) {
      continue;
    }
    edges.push({
      id: `edge:${accumulator.kind}:${encodeURIComponent(accumulator.regionIds[0])}:${encodeURIComponent(accumulator.regionIds[1])}`,
      kind: accumulator.kind,
      regionIds: accumulator.regionIds,
      evidence: {
        relation: "undirected",
        matchedTexelPairCount: accumulator.texelPairs.size,
        dominantColorDistance: colorDistance(
          requireRegion(regionById, accumulator.regionIds[0]).rgba,
          requireRegion(regionById, accumulator.regionIds[1]).rgba,
        ),
        mappingIds: [...accumulator.mappingIds].sort(compareString),
        minimumLocalManhattanDistance: accumulator.minimumLocalManhattanDistance,
      },
    });
  }
  return edges.sort(compareEdge);
}

function createLayoutIndexes(layout: SkinLayout): {
  readonly byPixelId: ReadonlyMap<number, EvidenceTexel>;
  readonly byLocal: ReadonlyMap<string, EvidenceTexel>;
} {
  const byPixelId = new Map<number, EvidenceTexel>();
  const byLocal = new Map<string, EvidenceTexel>();
  for (const surface of layout.surfaceOrder) {
    const definition = layout.surfaces[surface]!;
    const { atlasRect, orientation } = definition;
    for (let atlasV = 0; atlasV < atlasRect.height; atlasV += 1) {
      for (let atlasU = 0; atlasU < atlasRect.width; atlasU += 1) {
        const local = atlasLocalToCanonical(
          atlasU,
          atlasV,
          atlasRect.width,
          atlasRect.height,
          orientation,
        );
        const atlasX = atlasRect.x + atlasU;
        const atlasY = atlasRect.y + atlasV;
        const texel: EvidenceTexel = {
          pixelId: atlasY * layout.width + atlasX,
          atlasX,
          atlasY,
          surface,
          bodyPart: definition.bodyPart,
          layer: definition.layer,
          face: definition.face,
          localU: local.x,
          localV: local.y,
        };
        byPixelId.set(texel.pixelId, texel);
        byLocal.set(localKey(surface, texel.localU, texel.localV), texel);
      }
    }
  }
  return { byPixelId, byLocal };
}

function describeColor(rgba: Rgba): CandidateEvidenceGraphNode["colorFamily"] {
  const [red, green, blue, alpha] = rgba;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const difference = maximum - minimum;
  const chromaAmount = difference / 255;
  const luminance = (red * 2_126 + green * 7_152 + blue * 722) / 10_000 / 255;
  let degrees = 0;
  if (difference !== 0) {
    if (maximum === red) degrees = 60 * (((green - blue) / difference) % 6);
    else if (maximum === green) degrees = 60 * ((blue - red) / difference + 2);
    else degrees = 60 * ((red - green) / difference + 4);
  }
  if (degrees < 0) degrees += 360;
  return {
    dominantRgba: [red, green, blue, alpha],
    dominantHex: rgbaHex(rgba),
    hue: hueFamily(degrees, chromaAmount),
    tone: luminance < 0.28 ? "dark" : luminance >= 0.72 ? "light" : "mid",
    chroma: chromaAmount < 0.08 ? "neutral" : chromaAmount < 0.28 ? "muted" : "vivid",
    luminance: roundEvidence(luminance),
    chromaAmount: roundEvidence(chromaAmount),
  };
}

function colorDistance(left: Rgba, right: Rgba): number {
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return roundEvidence(Math.sqrt(red * red + green * green + blue * blue));
}

function hueFamily(degrees: number, chroma: number): CandidateColorHueFamily {
  if (chroma < 0.08) return "neutral";
  if (degrees < 15 || degrees >= 345) return "red";
  if (degrees < 45) return "orange";
  if (degrees < 75) return "yellow";
  if (degrees < 165) return "green";
  if (degrees < 195) return "cyan";
  if (degrees < 255) return "blue";
  if (degrees < 285) return "violet";
  return "magenta";
}

function seam(
  id: string,
  firstFace: Face,
  firstEdge: SurfaceEdge,
  secondFace: Face,
  secondEdge: SurfaceEdge,
  reverse: boolean,
): SeamMapping {
  return { id, firstFace, firstEdge, secondFace, secondEdge, reverse };
}

function surfaceSize(
  layout: SkinLayout,
  surface: SurfaceKey,
): { readonly width: number; readonly height: number } {
  const definition = layout.surfaces[surface];
  if (!definition) throw new TypeError(`Layout ${layout.id} is missing ${surface}`);
  return getOrientedSize(
    definition.atlasRect.width,
    definition.atlasRect.height,
    definition.orientation,
  );
}

function boundaryLength(
  size: { readonly width: number; readonly height: number },
  edge: SurfaceEdge,
): number {
  return edge === "top" || edge === "bottom" ? size.width : size.height;
}

function boundaryPoint(
  size: { readonly width: number; readonly height: number },
  edge: SurfaceEdge,
  index: number,
): { readonly u: number; readonly v: number } {
  switch (edge) {
    case "top":
      return { u: index, v: 0 };
    case "right":
      return { u: size.width - 1, v: index };
    case "bottom":
      return { u: index, v: size.height - 1 };
    case "left":
      return { u: 0, v: index };
  }
}

function mirroredBodyPart(bodyPart: BodyPart): BodyPart {
  switch (bodyPart) {
    case "rightArm":
      return "leftArm";
    case "leftArm":
      return "rightArm";
    case "rightLeg":
      return "leftLeg";
    case "leftLeg":
      return "rightLeg";
    default:
      return bodyPart;
  }
}

function mirroredFace(face: Face): Face {
  if (face === "left") return "right";
  if (face === "right") return "left";
  return face;
}

function boundingBox(
  points: readonly { readonly x: number; readonly y: number }[],
): CandidateEvidenceBoundingBox {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  };
}

function canonicalCandidateRegions(
  document: CandidateRegionDocument,
  layout: SkinLayout,
): CandidateRegion[] {
  const surfaceIndex = new Map(
    layout.surfaceOrder.map((surface, index) => [surface, index] as const),
  );
  const regions: CandidateRegion[] = [...document.regions];
  return regions.sort((left, right) => {
    const surfaceDifference =
      requireSurfaceIndex(surfaceIndex, left.surface) -
      requireSurfaceIndex(surfaceIndex, right.surface);
    if (surfaceDifference !== 0) return surfaceDifference;
    const pixelDifference = minimumPixelId(left) - minimumPixelId(right);
    return pixelDifference !== 0 ? pixelDifference : compareString(left.id, right.id);
  });
}

function minimumPixelId(region: CandidateRegion): number {
  if (
    !Array.isArray(region.pixelIds) ||
    region.pixelIds.length === 0 ||
    region.pixelIds.some((pixelId) => !Number.isInteger(pixelId) || pixelId < 0)
  ) {
    throw new TypeError(`CandidateRegion ${region.id} has invalid pixel IDs`);
  }
  return Math.min(...region.pixelIds);
}

function requireSurfaceIndex(
  indexes: ReadonlyMap<SurfaceKey, number>,
  surface: SurfaceKey,
): number {
  const index = indexes.get(surface);
  if (index === undefined) throw new TypeError(`Unknown CandidateRegion surface: ${surface}`);
  return index;
}

function requireVisualId(
  visualIds: ReadonlyMap<string, string>,
  regionId: string,
): string {
  const visualId = visualIds.get(regionId);
  if (visualId === undefined) {
    throw new TypeError(`Candidate evidence edge references an unknown Region: ${regionId}`);
  }
  return visualId;
}

function requireRegion(
  regions: ReadonlyMap<string, CandidateRegion>,
  regionId: string,
): CandidateRegion {
  const region = regions.get(regionId);
  if (region === undefined) {
    throw new TypeError(`Candidate evidence edge references an unknown Region: ${regionId}`);
  }
  return region;
}

function assertRgba(rgba: Rgba, regionId: string): void {
  if (
    !Array.isArray(rgba) ||
    rgba.length !== 4 ||
    rgba.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255) ||
    rgba[3] === 0
  ) {
    throw new TypeError(`CandidateRegion ${regionId} has invalid visible RGBA`);
  }
}

function rgbaHex(rgba: Rgba): string {
  return `#${rgba.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function localKey(surface: SurfaceKey, u: number, v: number): string {
  return `${surface}:${u},${v}`;
}

function canonicalPair(left: string, right: string): readonly [string, string] {
  return compareString(left, right) <= 0 ? [left, right] : [right, left];
}

function accumulatorKey(
  kind: CandidateEvidenceEdgeKind,
  regionIds: readonly [string, string],
): string {
  return JSON.stringify([kind, regionIds[0], regionIds[1]]);
}

function pixelPairKey(left: number, right: number): string {
  return left <= right ? `${left}:${right}` : `${right}:${left}`;
}

function roundEvidence(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function compareNode(
  left: CandidateEvidenceGraphNode,
  right: CandidateEvidenceGraphNode,
): number {
  return compareString(left.visualId, right.visualId);
}

function compareEdge(
  left: CandidateEvidenceGraphEdge,
  right: CandidateEvidenceGraphEdge,
): number {
  const kindDifference = EDGE_KIND_ORDER.indexOf(left.kind) - EDGE_KIND_ORDER.indexOf(right.kind);
  if (kindDifference !== 0) return kindDifference;
  const firstDifference = compareString(left.regionIds[0], right.regionIds[0]);
  return firstDifference !== 0
    ? firstDifference
    : compareString(left.regionIds[1], right.regionIds[1]);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
