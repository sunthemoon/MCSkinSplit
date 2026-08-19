import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSurfaceTexels,
  createRgbaImage,
  decodeSkinPng,
  getSkinLayout,
  pixelIdsToSpans,
  type ArmType,
  type Rgba,
  type SurfaceKey,
  type SurfaceTexel,
} from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import {
  buildCandidateEvidenceGraph,
  candidateRegionVisualId,
  createCandidateEvidenceGraphSummary,
  createCandidateRegionVisualIdEntries,
  type CandidateEvidenceEdgeKind,
} from "../src/candidate-evidence-graph";
import { createAnalysisDocuments } from "../src/candidate-regions";
import {
  CANDIDATE_REGION_ALGORITHM_VERSION,
  type CandidateRegion,
  type CandidateRegionDocument,
} from "../src/types";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDirectory = resolve(repositoryRoot, "tests/fixtures/skins");
const TORSO_SEAM_CASES = [
  ["front.top=top.bottom", "torso.base.front", [2, 0], "torso.base.top", [2, 3]],
  ["back.top=top.top", "torso.base.back", [2, 0], "torso.base.top", [5, 0]],
  ["front.bottom=bottom.top", "torso.base.front", [2, 11], "torso.base.bottom", [2, 0]],
  ["back.bottom=bottom.bottom", "torso.base.back", [2, 11], "torso.base.bottom", [5, 3]],
  ["front.left=left.right", "torso.base.front", [0, 2], "torso.base.left", [3, 2]],
  ["front.right=right.left", "torso.base.front", [7, 2], "torso.base.right", [0, 2]],
  ["back.left=right.right", "torso.base.back", [0, 2], "torso.base.right", [3, 2]],
  ["back.right=left.left", "torso.base.back", [7, 2], "torso.base.left", [0, 2]],
  ["top.left=left.top", "torso.base.top", [0, 1], "torso.base.left", [1, 0]],
  ["top.right=right.top", "torso.base.top", [7, 1], "torso.base.right", [2, 0]],
  ["bottom.left=left.bottom", "torso.base.bottom", [0, 1], "torso.base.left", [2, 11]],
  ["bottom.right=right.bottom", "torso.base.bottom", [7, 1], "torso.base.right", [1, 11]],
] as const satisfies readonly (
  readonly [string, SurfaceKey, readonly [number, number], SurfaceKey, readonly [number, number]]
)[];

describe("candidate evidence graph", () => {
  it.each([
    ["wide" as const, "wide-basic.png"],
    ["slim" as const, "slim-basic.png"],
  ])("covers every %s CandidateRegion with finite host features", async (armType, fixture) => {
    const image = decodeSkinPng(await readFile(resolve(fixtureDirectory, fixture)));
    const candidates = createAnalysisDocuments(image, getSkinLayout(armType)).candidateRegions;
    const graph = buildCandidateEvidenceGraph(candidates);

    expect(graph.nodeCount).toBe(candidates.regions.length);
    expect(graph.nodes.map((node) => node.id)).toEqual(
      createCandidateRegionVisualIdEntries(candidates).map((entry) => entry.regionId),
    );
    expect(graph.nodes.map((node) => node.visualId)).toEqual(
      graph.nodes.map((_, index) => candidateRegionVisualId(index)),
    );
    expect(graph.visiblePixelCount).toBe(candidates.visiblePixelCount);
    expect(graph.edgeCount).toBe(graph.edges.length);
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
    const summary = createCandidateEvidenceGraphSummary(graph);
    const atlasFieldIndexes = ["atlasX", "atlasY", "atlasWidth", "atlasHeight"].map(
      (field) => summary.nodeFields.indexOf(field),
    );
    expect(atlasFieldIndexes.every((index) => index >= 0)).toBe(true);
    for (const [index, node] of graph.nodes.entries()) {
      const source = candidates.regions.find((region) => region.id === node.id)!;
      const summaryRow = summary.nodes[index]!;
      expect(node.pixelCount).toBe(source.pixelCount);
      expect(node.surface).toBe(source.surface);
      expect(node.surface).toBe(`${node.bodyPart}.${node.layer}.${node.face}`);
      expect(node.area.boundingBoxPixelCount).toBeGreaterThanOrEqual(node.pixelCount);
      expect(node.area.fillRatio).toBeGreaterThan(0);
      expect(node.area.fillRatio).toBeLessThanOrEqual(1);
      expect(Number.isFinite(node.shape.slendernessRatio)).toBe(true);
      expect(Number.isFinite(node.colorFamily.luminance)).toBe(true);
      expect(Number.isFinite(node.colorFamily.chromaAmount)).toBe(true);
      expect(atlasFieldIndexes.map((fieldIndex) => summaryRow[fieldIndex])).toEqual([
        node.atlasBoundingBox.x,
        node.atlasBoundingBox.y,
        node.atlasBoundingBox.width,
        node.atlasBoundingBox.height,
      ]);
    }
  });

  it("is insensitive to CandidateRegion and pixel ordering", async () => {
    const image = decodeSkinPng(await readFile(resolve(fixtureDirectory, "slim-basic.png")));
    const original = createAnalysisDocuments(image, getSkinLayout("slim")).candidateRegions;
    const permuted: CandidateRegionDocument = {
      ...original,
      regions: [...original.regions].reverse().map((region) => ({
        ...region,
        pixelIds: [...region.pixelIds].reverse(),
        spans: [...region.spans].reverse(),
      })),
    };

    expect(buildCandidateEvidenceGraph(permuted)).toEqual(
      buildCandidateEvidenceGraph(original),
    );
    expect(createCandidateRegionVisualIdEntries(permuted)).toEqual(
      createCandidateRegionVisualIdEntries(original),
    );
  });

  it("emits one canonical undirected edge per kind and region pair", () => {
    const armType = "wide" as const;
    const regions = [
      candidate(armType, "zeta", "torso.base.front", [[0, 2], [0, 3]], [255, 0, 0, 255]),
      candidate(armType, "alpha", "torso.base.front", [[1, 2], [1, 3]], [0, 255, 0, 255]),
      candidate(armType, "near", "torso.base.front", [[3, 2]], [0, 0, 255, 255]),
    ];
    const graph = buildCandidateEvidenceGraph(document(armType, regions));
    const keys = graph.edges.map((edge) => `${edge.kind}:${edge.regionIds.join(":")}`);

    expect(new Set(keys).size).toBe(keys.length);
    for (const edge of graph.edges) {
      expect(edge.regionIds[0] < edge.regionIds[1]).toBe(true);
      expect(edge.evidence.relation).toBe("undirected");
      expect(edge.evidence.matchedTexelPairCount).toBeGreaterThan(0);
    }
    expect(findEdge(graph.edges, "same_surface_contact", "alpha", "zeta")).toMatchObject({
      regionIds: ["alpha", "zeta"],
      evidence: {
        matchedTexelPairCount: 2,
        dominantColorDistance: 360.6245,
        minimumLocalManhattanDistance: 1,
      },
    });
    expect(findEdge(graph.edges, "same_surface_proximity", "alpha", "near")).toMatchObject({
      evidence: { minimumLocalManhattanDistance: 2 },
    });
    expect(findEdge(graph.edges, "same_surface_proximity", "alpha", "zeta")).toBeUndefined();

    const summary = createCandidateEvidenceGraphSummary(graph);
    expect(summary.nodes.map((node) => node.slice(0, 2))).toEqual([
      ["R001", "zeta"],
      ["R002", "alpha"],
      ["R003", "near"],
    ]);
    expect(summary.edgeFields).toContain("dominantColorDistance");
    expect(summary.nodeFields).toContain("dominantColor");
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it.each(["wide", "slim"] as const)(
    "verifies all twelve canonical cuboid seams for %s",
    (armType) => {
      for (const [mappingId, firstSurface, firstPoint, secondSurface, secondPoint] of TORSO_SEAM_CASES) {
        const first = candidate(
          armType,
          "first",
          firstSurface,
          [firstPoint],
          [50, 60, 70, 255],
        );
        const second = candidate(
          armType,
          "second",
          secondSurface,
          [secondPoint],
          [80, 90, 100, 255],
        );
        const graph = buildCandidateEvidenceGraph(document(armType, [second, first]));
        expect(
          graph.edges.filter((edge) => edge.kind === "uv_seam"),
          mappingId,
        ).toEqual([
          expect.objectContaining({
            regionIds: ["first", "second"],
            evidence: expect.objectContaining({
              mappingIds: [`canonical-seam:${mappingId}`],
              matchedTexelPairCount: 1,
            }),
          }),
        ]);
      }
    },
  );

  it.each(["wide", "slim"] as const)(
    "connects only the proven canonical seams for %s",
    (armType) => {
      const front = candidate(
        armType,
        "front-top",
        "torso.base.front",
        [[2, 0]],
        [100, 10, 10, 255],
      );
      const top = candidate(
        armType,
        "top-front",
        "torso.base.top",
        [[2, surfaceHeight(armType, "torso.base.top") - 1]],
        [10, 100, 10, 255],
      );
      const wrong = candidate(
        armType,
        "top-wrong-column",
        "torso.base.top",
        [[4, surfaceHeight(armType, "torso.base.top") - 1]],
        [10, 10, 100, 255],
      );
      const graph = buildCandidateEvidenceGraph(document(armType, [wrong, top, front]));

      expect(findEdge(graph.edges, "uv_seam", "front-top", "top-front")).toMatchObject({
        evidence: { mappingIds: ["canonical-seam:front.top=top.bottom"] },
      });
      expect(findEdge(graph.edges, "uv_seam", "front-top", "top-wrong-column")).toBeUndefined();
    },
  );

  it.each(["wide", "slim"] as const)(
    "projects exact Base/Outer texels and bilateral limb mirrors for %s",
    (armType) => {
      const armWidth = surfaceWidth(armType, "rightArm.base.front");
      const regions = [
        candidate(armType, "base", "rightArm.base.front", [[0, 2]], [30, 30, 30, 255]),
        candidate(armType, "outer", "rightArm.outer.front", [[0, 2]], [60, 60, 60, 255]),
        candidate(
          armType,
          "mirror",
          "leftArm.base.front",
          [[armWidth - 1, 2]],
          [90, 90, 90, 255],
        ),
        candidate(armType, "not-projected", "rightArm.outer.front", [[1, 5]], [120, 120, 120, 255]),
      ];
      const graph = buildCandidateEvidenceGraph(document(armType, regions));

      expect(findEdge(graph.edges, "layer_projection", "base", "outer")).toBeDefined();
      expect(findEdge(graph.edges, "layer_projection", "base", "not-projected")).toBeUndefined();
      expect(findEdge(graph.edges, "bilateral_mirror", "base", "mirror")).toMatchObject({
        evidence: { mappingIds: ["canonical-bilateral-mirror-u-v1"] },
      });
    },
  );

  it.each(["wide", "slim"] as const)(
    "does not turn Atlas row wrapping into cross-surface adjacency for %s",
    (armType) => {
      const beforeWrap = candidateFromAtlas(
        armType,
        "before-wrap",
        "head.outer.back",
        63,
        8,
        [200, 10, 10, 255],
      );
      const afterWrap = candidateFromAtlas(
        armType,
        "after-wrap",
        "head.base.left",
        0,
        9,
        [10, 200, 10, 255],
      );
      expect(beforeWrap.pixelIds[0]! + 1).toBe(afterWrap.pixelIds[0]);

      const graph = buildCandidateEvidenceGraph(document(armType, [beforeWrap, afterWrap]));
      expect(graph.edges).toEqual([]);
    },
  );
});

function candidate(
  armType: ArmType,
  id: string,
  surface: SurfaceKey,
  coordinates: readonly (readonly [number, number])[],
  rgba: Rgba,
): CandidateRegion {
  const texels = texelIndex(armType);
  const selected = coordinates.map(([u, v]) => {
    const texel = texels.byLocal.get(`${surface}:${u},${v}`);
    if (!texel) throw new Error(`Missing ${armType} texel ${surface}:${u},${v}`);
    return texel;
  });
  return candidateFromTexels(armType, id, surface, selected, rgba);
}

function candidateFromAtlas(
  armType: ArmType,
  id: string,
  surface: SurfaceKey,
  atlasX: number,
  atlasY: number,
  rgba: Rgba,
): CandidateRegion {
  const texel = texelIndex(armType).byPixelId.get(atlasY * 64 + atlasX);
  if (!texel || texel.surface !== surface) {
    throw new Error(`Atlas ${atlasX},${atlasY} is not ${surface} in ${armType}`);
  }
  return candidateFromTexels(armType, id, surface, [texel], rgba);
}

function candidateFromTexels(
  armType: ArmType,
  id: string,
  surface: SurfaceKey,
  texels: readonly SurfaceTexel[],
  rgba: Rgba,
): CandidateRegion {
  const pixelIds = texels.map((texel) => texel.pixelId).sort((left, right) => left - right);
  const xs = texels.map((texel) => texel.atlasX);
  const ys = texels.map((texel) => texel.atlasY);
  return {
    id,
    surface,
    pixelIds,
    pixelCount: pixelIds.length,
    spans: pixelIdsToSpans(pixelIds, getSkinLayout(armType)),
    rgba,
    dominantColor: rgbaHex(rgba),
    boundingBox: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs) + 1,
      height: Math.max(...ys) - Math.min(...ys) + 1,
    },
  };
}

function document(
  armType: ArmType,
  regions: readonly CandidateRegion[],
): CandidateRegionDocument {
  return {
    schemaVersion: "1.0",
    algorithmVersion: CANDIDATE_REGION_ALGORITHM_VERSION,
    armType,
    visiblePixelCount: regions.reduce((total, region) => total + region.pixelCount, 0),
    regions,
  };
}

function findEdge(
  edges: readonly {
    readonly kind: CandidateEvidenceEdgeKind;
    readonly regionIds: readonly [string, string];
  }[],
  kind: CandidateEvidenceEdgeKind,
  firstId: string,
  secondId: string,
) {
  const ids = [firstId, secondId].sort();
  return edges.find(
    (edge) => edge.kind === kind && edge.regionIds[0] === ids[0] && edge.regionIds[1] === ids[1],
  );
}

function surfaceWidth(armType: ArmType, surface: SurfaceKey): number {
  const values = [...texelIndex(armType).byLocal.values()].filter(
    (texel) => texel.surface === surface,
  );
  return Math.max(...values.map((texel) => texel.localU)) + 1;
}

function surfaceHeight(armType: ArmType, surface: SurfaceKey): number {
  const values = [...texelIndex(armType).byLocal.values()].filter(
    (texel) => texel.surface === surface,
  );
  return Math.max(...values.map((texel) => texel.localV)) + 1;
}

const texelIndexes = new Map<ArmType, ReturnType<typeof createTexelIndex>>();

function texelIndex(armType: ArmType): ReturnType<typeof createTexelIndex> {
  const existing = texelIndexes.get(armType);
  if (existing) return existing;
  const created = createTexelIndex(armType);
  texelIndexes.set(armType, created);
  return created;
}

function createTexelIndex(armType: ArmType) {
  const texels = buildSurfaceTexels(createRgbaImage(64, 64), getSkinLayout(armType));
  return {
    byPixelId: new Map(texels.map((texel) => [texel.pixelId, texel])),
    byLocal: new Map(
      texels.map((texel) => [
        `${texel.surface}:${texel.localU},${texel.localV}`,
        texel,
      ]),
    ),
  };
}

function rgbaHex(rgba: Rgba): string {
  return `#${rgba.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
