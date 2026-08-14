import { createHash } from "node:crypto";
import {
  getSkinLayout,
  pixelIdsToSpans,
  validateSemanticState,
  type Rgba,
  type RgbaImage,
  type AtlasRect,
  type SemanticCategory,
  type SemanticPixelSpan,
  type SemanticState,
  type SkinLayout,
} from "@mc-skin-split/skin-core";
import type { CandidateRegion, CandidateRegionDocument } from "./types";

export const SEMANTIC_FOLLOWUP_ALGORITHM_VERSIONS = [
  "cross-body-hair-reclassification-v1",
  "cross-body-hair-reclassification-v2",
] as const;
export type SemanticFollowupAlgorithmVersion =
  (typeof SEMANTIC_FOLLOWUP_ALGORITHM_VERSIONS)[number];
export const SEMANTIC_FOLLOWUP_ALGORITHM_VERSION: SemanticFollowupAlgorithmVersion =
  SEMANTIC_FOLLOWUP_ALGORITHM_VERSIONS.at(-1)!;

export interface SemanticFollowupSuggestion {
  readonly kind: "cross_body_hair_reclassification";
  readonly id: string;
  readonly label: string;
  readonly targetComponentId: string;
  readonly sourceComponentIds: readonly string[];
  readonly candidateRegionIds: readonly string[];
  readonly spans: readonly SemanticPixelSpan[];
  readonly pixelCount: number;
  readonly confidence: number;
  readonly reason: string;
}

export interface SemanticFollowupNotice {
  readonly kind: "possible_hidden_clothing";
  readonly suggestionIds: readonly string[];
  readonly message: string;
}

export interface SemanticFollowupAssessment {
  readonly schemaVersion: "1.0";
  readonly algorithmVersion: SemanticFollowupAlgorithmVersion;
  readonly evidenceHash: string;
  readonly suggestions: readonly SemanticFollowupSuggestion[];
  readonly notices: readonly SemanticFollowupNotice[];
}

export interface AssessSemanticFollowupInput {
  readonly state: SemanticState;
  readonly image: RgbaImage;
  readonly candidateRegions: CandidateRegionDocument;
}

const CLOTHING_CATEGORIES = new Set<SemanticCategory>([
  "upper_clothing",
  "lower_clothing",
  "one_piece_clothing",
  "sleeve",
  "glove",
  "legwear",
  "shoe",
]);
const MIN_HEAD_HAIR_PIXELS = 8;
const MIN_HEAD_HAIR_VERTICAL_SPAN = 4;
const MIN_REGION_PIXELS = 4;
const MIN_DRAPE_HEIGHT = 4;
const MIN_SUPPORTED_FRACTION = 0.9;
const MAX_COLOR_DISTANCE_SQUARED = 32 ** 2;
const MAX_PALETTE_ANCHOR_DISTANCE_SQUARED = 112 ** 2;

interface HeadHairSupport {
  readonly componentId: string;
  readonly colors: readonly Rgba[];
  readonly contrastColors: readonly Rgba[];
}

interface MatchedTorsoRegion {
  readonly region: CandidateRegion;
  readonly sourceComponentIds: readonly string[];
  readonly supportComponentIds: readonly string[];
}

interface DrapeGroup {
  readonly regions: readonly CandidateRegion[];
  readonly sourceComponentIds: readonly string[];
  readonly supportComponentIds: readonly string[];
  readonly isFullPanel: boolean;
}

/**
 * Finds conservative, review-only reclassification candidates. It never changes
 * semantic ownership or authors pixels: every suggested span is the exact union
 * of existing opaque candidate regions.
 */
export function assessSemanticFollowup(
  input: AssessSemanticFollowupInput,
): SemanticFollowupAssessment {
  const layout = getSkinLayout(input.state.document.source.armType);
  validateSemanticState(input.state, input.image, layout);
  assertCandidateDocument(input.candidateRegions, layout);

  const componentById = new Map(
    input.state.document.components.map((component) => [component.instanceId, component]),
  );
  const ownerByPixel = createOwnerIndex(input.state);
  const hairComponents = input.state.document.components
    .filter((component) => component.category === "hair")
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const headHairSupport: HeadHairSupport[] = [];
  const headRegions = input.candidateRegions.regions
    .filter((region) => region.surface.startsWith("head."));
  for (const component of hairComponents) {
    const evidence = collectOwnedHeadHairEvidence(
      headRegions,
      component.instanceId,
      ownerByPixel,
      input.image,
      layout,
    );
    if (evidence !== null) {
      headHairSupport.push({
        componentId: component.instanceId,
        colors: dominantAnchoredColors(evidence, true),
        contrastColors: dominantAnchoredColors(evidence, false),
      });
    }
  }

  const exposedSkinColors = collectCategoryColors(
    input.candidateRegions.regions,
    new Set<SemanticCategory>(["face", "skin"]),
    ownerByPixel,
    componentById,
    input.image,
  );

  const torsoRegions = input.candidateRegions.regions
    .filter(isTorsoSideRegion)
    .sort((left, right) => left.id.localeCompare(right.id));
  const matched: MatchedTorsoRegion[] = [];
  for (const region of torsoRegions) {
    const sourceComponentIds = ownedClothingComponentIds(
      region,
      ownerByPixel,
      componentById,
    );
    if (sourceComponentIds === null) continue;
    const colors = region.pixelIds.map((pixelId) => readRgba(input.image, pixelId));
    if (colors.some((rgba) => rgba[3] === 0)) continue;

    const matches = headHairSupport
      .map((support) => ({
        componentId: support.componentId,
        supportedFraction: supportedFraction(colors, support.colors),
      }))
      .filter((match) => match.supportedFraction >= MIN_SUPPORTED_FRACTION)
      .sort((left, right) => left.componentId.localeCompare(right.componentId));
    if (matches.length === 0) continue;
    if (isLikelyExposedSkinFragment(region, colors, exposedSkinColors, layout)) continue;
    matched.push({
      region,
      sourceComponentIds,
      supportComponentIds: matches.map((match) => match.componentId),
    });
  }

  const metadataByRegionId = new Map(
    matched.map((entry) => [entry.region.id, entry]),
  );
  const drapeGroups = matched
    .reduce<Map<string, CandidateRegion[]>>((bySurface, entry) => {
        const group = bySurface.get(entry.region.surface) ?? [];
        group.push(entry.region);
        bySurface.set(entry.region.surface, group);
        return bySurface;
      }, new Map())
    .values();
  const candidates = [...drapeGroups]
    .flatMap((surfaceRegions) => connectedRegionGroups(surfaceRegions, layout))
    .map((regions) => createDrapeGroup(regions, metadataByRegionId, layout))
    .filter((group): group is DrapeGroup => group !== null);
  const anchors = candidates.filter((group) => !group.isFullPanel);
  const eligibleGroups = candidates.filter((group) => {
    if (!group.isFullPanel) return true;
    const supportColors = group.supportComponentIds.flatMap((componentId) =>
      headHairSupport.find((support) => support.componentId === componentId)!.contrastColors
    );
    const hasCrossSurfaceAnchor = anchors.some((anchor) =>
      anchor.regions[0]!.surface !== group.regions[0]!.surface
      && setsIntersect(anchor.supportComponentIds, group.supportComponentIds)
    );
    const sourceRetainsContrastingClothing = group.sourceComponentIds.some((componentId) =>
      sourceComponentHasContrast(
        componentId,
        ownerByPixel,
        input.image,
        supportColors,
        layout,
      )
    );
    const surface = group.regions[0]!.surface;
    const isCanonicalHairPanel = /\.(?:back|left|right)$/u.test(surface);
    return sourceRetainsContrastingClothing
      && (hasCrossSurfaceAnchor || isCanonicalHairPanel);
  });
  const regions = [...new Map(
    eligibleGroups
      .flatMap((group) => group.regions)
      .map((region) => [region.id, region] as const),
  ).values()].sort((left, right) => left.id.localeCompare(right.id));
  const supportComponentIds = [...new Set(
    eligibleGroups.flatMap((group) => group.supportComponentIds),
  )].sort();

  const suggestions = regions.length === 0 || supportComponentIds.length === 0
    ? []
    : [createSuggestion({
        regions,
        supportComponentIds,
        targetComponentId: supportComponentIds.length === 1
          ? supportComponentIds[0]!
          : crossBodyHairComponentId(supportComponentIds),
        ownerByPixel,
        image: input.image,
        layout,
        headHairSupport,
      })];
  const notices: SemanticFollowupNotice[] = suggestions.length === 0
    ? []
    : [{
        kind: "possible_hidden_clothing",
        suggestionIds: suggestions.map((suggestion) => suggestion.id),
        message: "长发可能遮挡了部分服装；重新分类后仍需检查服装是否需要补全。",
      }];
  const evidence = {
    schemaVersion: "1.0",
    algorithmVersion: SEMANTIC_FOLLOWUP_ALGORITHM_VERSION,
    sourceHash: input.state.document.source.sourceHash,
    imageHash: hashBytes(input.image.data),
    semanticDocumentHash: hashCanonical(input.state.document),
    candidateRegionsHash: hashCanonical(input.candidateRegions),
    suggestions,
    notices,
  };
  return {
    schemaVersion: "1.0",
    algorithmVersion: SEMANTIC_FOLLOWUP_ALGORITHM_VERSION,
    evidenceHash: hashCanonical(evidence),
    suggestions,
    notices,
  };
}

function crossBodyHairComponentId(componentIds: readonly string[]): string {
  const suffix = hashCanonical({
    kind: "cross_body_hair_component",
    componentIds: [...componentIds].sort(),
  }).slice("sha256:".length, "sha256:".length + 12);
  return `hair.cross-body-${suffix}`;
}

function createSuggestion(input: {
  readonly regions: readonly CandidateRegion[];
  readonly supportComponentIds: readonly string[];
  readonly targetComponentId: string;
  readonly ownerByPixel: readonly (string | null)[];
  readonly image: RgbaImage;
  readonly layout: SkinLayout;
  readonly headHairSupport: readonly HeadHairSupport[];
}): SemanticFollowupSuggestion {
  const candidateRegionIds = input.regions.map((region) => region.id).sort();
  const pixelIds = [...new Set(
    input.regions.flatMap((region) => [...region.pixelIds]),
  )].sort((left, right) => left - right);
  const sourceComponentIds = [...new Set(
    pixelIds
      .map((pixelId) => input.ownerByPixel[pixelId])
      .filter((componentId): componentId is string => componentId !== null),
  )].sort();
  const supportColors = input.supportComponentIds.flatMap((componentId) =>
    input.headHairSupport.find((support) => support.componentId === componentId)!.colors
  );
  const confidence = roundConfidence(
    0.75 + 0.2 * supportedFraction(
      pixelIds.map((pixelId) => readRgba(input.image, pixelId)),
      supportColors,
    ),
  );
  const idEvidence = {
    kind: "cross_body_hair_reclassification",
    targetComponentId: input.targetComponentId,
    sourceComponentIds,
    candidateRegionIds,
    pixelIds,
  };
  return {
    kind: "cross_body_hair_reclassification",
    id: `followup_${hashCanonical(idEvidence).slice(
      "sha256:".length,
      "sha256:".length + 24,
    )}`,
    label: "疑似跨部位长发",
    targetComponentId: input.targetComponentId,
    sourceComponentIds,
    candidateRegionIds,
    spans: pixelIdsToSpans(pixelIds, input.layout),
    pixelCount: pixelIds.length,
    confidence,
    reason: "躯干顶部的纵向区域与头部头发颜色一致，但目前归属于服装；建议人工确认后重新分类。",
  };
}

function assertCandidateDocument(
  document: CandidateRegionDocument,
  layout: SkinLayout,
): void {
  if (document.schemaVersion !== "1.0" || document.armType !== layout.armType) {
    throw new TypeError("Candidate regions do not match the semantic state");
  }
  const regionIds = new Set<string>();
  for (const region of document.regions) {
    const surface = layout.surfaces[region.surface];
    const pixelIds = new Set(region.pixelIds);
    if (
      regionIds.has(region.id)
      || surface === undefined
      || region.pixelIds.length === 0
      || region.pixelCount !== region.pixelIds.length
      || pixelIds.size !== region.pixelIds.length
      || region.pixelIds.some((pixelId) =>
        !Number.isInteger(pixelId)
        || pixelId < 0
        || pixelId >= layout.width * layout.height
        || !pixelInsideRect(pixelId, surface.atlasRect)
      )
    ) {
      throw new TypeError(`Candidate region ${region.id} is outside its declared surface`);
    }
    regionIds.add(region.id);
  }
}

function createOwnerIndex(state: SemanticState): (string | null)[] {
  const result = Array<string | null>(64 * 64).fill(null);
  for (const component of state.document.components) {
    const mask = state.masks[component.instanceId]!;
    for (let pixelId = 0; pixelId < mask.length; pixelId += 1) {
      if (mask[pixelId] !== 0) result[pixelId] = component.instanceId;
    }
  }
  return result;
}

function collectOwnedHeadHairEvidence(
  regions: readonly CandidateRegion[],
  ownerId: string,
  ownerByPixel: readonly (string | null)[],
  image: RgbaImage,
  layout: SkinLayout,
): Rgba[] | null {
  const pixelIds = [...new Set(
    regions
      .flatMap((region) => [...region.pixelIds])
      .filter((pixelId) =>
        ownerByPixel[pixelId] === ownerId && readRgba(image, pixelId)[3] !== 0
      ),
  )].sort((left, right) => left - right);
  if (pixelIds.length < MIN_HEAD_HAIR_PIXELS) return null;

  const bySurface = new Map<CandidateRegion["surface"], number[]>();
  for (const region of regions) {
    const owned = region.pixelIds.filter((pixelId) => ownerByPixel[pixelId] === ownerId);
    if (owned.length === 0) continue;
    const values = bySurface.get(region.surface) ?? [];
    values.push(...owned);
    bySurface.set(region.surface, values);
  }
  const strongSurfaces = [...bySurface].filter(([surface, ids]) => {
    const rect = layout.surfaces[surface]!.atlasRect;
    const local = [...new Set(ids)].map((pixelId) => localPoint(pixelId, rect));
    const verticalSpan = Math.max(...local.map((point) => point.v))
      - Math.min(...local.map((point) => point.v)) + 1;
    return verticalSpan >= MIN_HEAD_HAIR_VERTICAL_SPAN;
  });
  if (strongSurfaces.length === 0) return null;
  if (
    pixelIds.length < 12
    && !strongSurfaces.some(([surface, ids]) => {
      const rect = layout.surfaces[surface]!.atlasRect;
      return ids.some((pixelId) => {
        const point = localPoint(pixelId, rect);
        return point.v <= 1 || point.u === 0 || point.u === rect.width - 1;
      });
    })
  ) {
    return null;
  }
  return pixelIds.map((pixelId) => readRgba(image, pixelId));
}

function isTorsoSideRegion(region: CandidateRegion): boolean {
  return /^torso\.(?:base|outer)\.(?:front|back|left|right)$/u.test(region.surface);
}

function sourceComponentHasContrast(
  componentId: string,
  ownerByPixel: readonly (string | null)[],
  image: RgbaImage,
  supportColors: readonly Rgba[],
  layout: SkinLayout,
): boolean {
  const colors: Rgba[] = [];
  for (const surface of layout.surfaceOrder) {
    if (!/^torso\.(?:base|outer)\.(?:front|back|left|right)$/u.test(surface)) {
      continue;
    }
    const rect = layout.surfaces[surface].atlasRect;
    for (let v = 0; v < rect.height; v += 1) {
      for (let u = 0; u < rect.width; u += 1) {
        const pixelId = (rect.y + v) * layout.width + rect.x + u;
        if (ownerByPixel[pixelId] !== componentId) continue;
        const rgba = readRgba(image, pixelId);
        if (rgba[3] !== 0) colors.push(rgba);
      }
    }
  }
  if (colors.length === 0) return false;
  const unsupportedCount = colors.filter(
    (color) => !isColorSupported(color, supportColors),
  ).length;
  return unsupportedCount >= 8 && unsupportedCount / colors.length >= 0.15;
}

function createDrapeGroup(
  regions: readonly CandidateRegion[],
  metadataByRegionId: ReadonlyMap<string, MatchedTorsoRegion>,
  layout: SkinLayout,
): DrapeGroup | null {
  const pixelIds = [...new Set(regions.flatMap((region) => [...region.pixelIds]))];
  if (pixelIds.length < MIN_REGION_PIXELS) return null;
  const rect = layout.surfaces[regions[0]!.surface]!.atlasRect;
  const local = pixelIds.map((pixelId) => localPoint(pixelId, rect));
  const minU = Math.min(...local.map((point) => point.u));
  const maxU = Math.max(...local.map((point) => point.u));
  const minV = Math.min(...local.map((point) => point.v));
  const maxV = Math.max(...local.map((point) => point.v));
  const width = maxU - minU + 1;
  const height = maxV - minV + 1;
  if (minV > 2 || height < MIN_DRAPE_HEIGHT || height < width) return null;

  const metadata = regions.map((region) => metadataByRegionId.get(region.id)!);
  const density = pixelIds.length / (width * height);
  return {
    regions: [...regions].sort((left, right) => left.id.localeCompare(right.id)),
    sourceComponentIds: [...new Set(
      metadata.flatMap((entry) => entry.sourceComponentIds),
    )].sort(),
    supportComponentIds: [...new Set(
      metadata.flatMap((entry) => entry.supportComponentIds),
    )].sort(),
    isFullPanel:
      width >= Math.ceil(rect.width * 0.75)
      && height >= Math.ceil(rect.height * 0.75)
      && density >= 0.7,
  };
}

function connectedRegionGroups(
  regions: readonly CandidateRegion[],
  layout: SkinLayout,
): CandidateRegion[][] {
  const remaining = new Set(regions);
  const groups: CandidateRegion[][] = [];
  while (remaining.size > 0) {
    const first = [...remaining].sort((left, right) => left.id.localeCompare(right.id))[0]!;
    remaining.delete(first);
    const group = [first];
    for (let index = 0; index < group.length; index += 1) {
      const current = group[index]!;
      for (const candidate of [...remaining]) {
        if (!regionsTouch(current, candidate, layout)) continue;
        remaining.delete(candidate);
        group.push(candidate);
      }
    }
    groups.push(group.sort((left, right) => left.id.localeCompare(right.id)));
  }
  return groups;
}

function regionsTouch(
  left: CandidateRegion,
  right: CandidateRegion,
  layout: SkinLayout,
): boolean {
  if (left.surface !== right.surface) return false;
  const rect = layout.surfaces[left.surface]!.atlasRect;
  const rightPixels = new Set(
    right.pixelIds.map((pixelId) => {
      const point = localPoint(pixelId, rect);
      return `${point.u},${point.v}`;
    }),
  );
  return left.pixelIds.some((pixelId) => {
    const point = localPoint(pixelId, rect);
    for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
      for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
        const u = point.u + offsetX;
        const v = point.v + offsetY;
        if (
          u >= 0
          && u < rect.width
          && v >= 0
          && v < rect.height
          && rightPixels.has(`${u},${v}`)
        ) {
          return true;
        }
      }
    }
    return false;
  });
}

function setsIntersect(left: readonly string[], right: readonly string[]): boolean {
  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
}

function localPoint(pixelId: number, rect: AtlasRect): { readonly u: number; readonly v: number } {
  return {
    u: pixelId % 64 - rect.x,
    v: Math.floor(pixelId / 64) - rect.y,
  };
}

function pixelInsideRect(pixelId: number, rect: AtlasRect): boolean {
  const point = localPoint(pixelId, rect);
  return point.u >= 0
    && point.u < rect.width
    && point.v >= 0
    && point.v < rect.height;
}

function collectCategoryColors(
  regions: readonly CandidateRegion[],
  categories: ReadonlySet<SemanticCategory>,
  ownerByPixel: readonly (string | null)[],
  componentById: ReadonlyMap<string, SemanticState["document"]["components"][number]>,
  image: RgbaImage,
): Rgba[] {
  return regions
    .flatMap((region) => [...region.pixelIds])
    .filter((pixelId) => {
      const ownerId = ownerByPixel[pixelId];
      return typeof ownerId === "string"
        && categories.has(componentById.get(ownerId)!.category);
    })
    .map((pixelId) => readRgba(image, pixelId))
    .filter((rgba) => rgba[3] !== 0);
}

function isLikelyExposedSkinFragment(
  region: CandidateRegion,
  colors: readonly Rgba[],
  exposedSkinColors: readonly Rgba[],
  layout: SkinLayout,
): boolean {
  if (
    !region.surface.startsWith("torso.base.")
    || supportedFraction(colors, exposedSkinColors) < MIN_SUPPORTED_FRACTION
  ) {
    return false;
  }
  const rect = layout.surfaces[region.surface]!.atlasRect;
  const points = region.pixelIds.map((pixelId) => localPoint(pixelId, rect));
  const minU = Math.min(...points.map((point) => point.u));
  const maxU = Math.max(...points.map((point) => point.u));
  const minV = Math.min(...points.map((point) => point.v));
  const maxV = Math.max(...points.map((point) => point.v));
  const width = maxU - minU + 1;
  const height = maxV - minV + 1;
  return (minV <= 2 && height <= 4) || (height <= 2 && width > height);
}

function ownedClothingComponentIds(
  region: CandidateRegion,
  ownerByPixel: readonly (string | null)[],
  componentById: ReadonlyMap<string, SemanticState["document"]["components"][number]>,
): string[] | null {
  const owners = [...new Set(region.pixelIds.map((pixelId) => ownerByPixel[pixelId]))];
  if (owners.length === 0 || owners.some((owner) => owner === null)) return null;
  const ids = owners as string[];
  return ids.every((id) => CLOTHING_CATEGORIES.has(componentById.get(id)!.category))
    ? ids.sort()
    : null;
}

function supportedFraction(colors: readonly Rgba[], supportColors: readonly Rgba[]): number {
  if (colors.length === 0 || supportColors.length === 0) return 0;
  return colors.filter((color) => isColorSupported(color, supportColors)).length / colors.length;
}

function dominantAnchoredColors(
  colors: readonly Rgba[],
  restrictColorFamily: boolean,
): Rgba[] {
  const counts = new Map<string, { rgba: Rgba; count: number }>();
  for (const rgba of colors) {
    const key = rgba.join(",");
    const entry = counts.get(key);
    counts.set(key, entry
      ? { rgba: entry.rgba, count: entry.count + 1 }
      : { rgba, count: 1 });
  }
  const palette = [...counts.values()].sort((left, right) =>
    right.count === left.count
      ? left.rgba.join(",").localeCompare(right.rgba.join(","))
      : right.count - left.count,
  );
  const anchor = palette[0]!.rgba;
  return palette
    .filter((entry) =>
      entry.rgba[3] === anchor[3]
      && entry.rgba[3] !== 0
      && colorDistanceSquared(entry.rgba, anchor)
        <= MAX_PALETTE_ANCHOR_DISTANCE_SQUARED
      && (!restrictColorFamily || belongsToAnchorColorFamily(entry.rgba, anchor))
    )
    .map((entry) => entry.rgba);
}

function isColorSupported(color: Rgba, supportColors: readonly Rgba[]): boolean {
  return supportColors.some((support) => {
    if (color[3] !== support[3] || color[3] === 0) return false;
    return colorDistanceSquared(color, support) <= MAX_COLOR_DISTANCE_SQUARED;
  });
}

function colorDistanceSquared(left: Rgba, right: Rgba): number {
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return red * red + green * green + blue * blue;
}

function belongsToAnchorColorFamily(color: Rgba, anchor: Rgba): boolean {
  const anchorChroma = Math.max(anchor[0], anchor[1], anchor[2])
    - Math.min(anchor[0], anchor[1], anchor[2]);
  const colorChroma = Math.max(color[0], color[1], color[2])
    - Math.min(color[0], color[1], color[2]);
  if (anchorChroma <= 12) return colorChroma <= 20;
  if (colorChroma <= 20) return true;
  return dominantChannel(color) === dominantChannel(anchor);
}

function dominantChannel(color: Rgba): 0 | 1 | 2 {
  if (color[0] >= color[1] && color[0] >= color[2]) return 0;
  return color[1] >= color[2] ? 1 : 2;
}

function readRgba(image: RgbaImage, pixelId: number): Rgba {
  const offset = pixelId * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

function roundConfidence(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000) / 1_000;
}

function hashCanonical(value: unknown): string {
  const canonical = JSON.stringify(sortJson(value));
  return hashBytes(new TextEncoder().encode(canonical));
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
