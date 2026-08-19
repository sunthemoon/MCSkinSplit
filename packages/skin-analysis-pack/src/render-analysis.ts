import {
  BODY_PARTS,
  FACES,
  LAYERS,
  atlasToSurfaceModel,
  buildSurfaceTexels,
  createRgbaImage,
  getSkinLayout,
  renderFaceContactSheet,
  scaleNearest,
  type ArmType,
  type BodyPart,
  type ContactSheetCell,
  type Face,
  type Layer,
  type Rgba,
  type RgbaImage,
  type SurfaceModel,
  type SurfaceKey,
  type SurfaceTexture,
} from "@mc-skin-split/skin-core";
import { createCandidateRegionVisualIdEntries } from "./candidate-evidence-graph";
import type { CandidateRegionDocument } from "./types";

const SCALE = 16;
const FACE_CONTACT_SHEET_OPTIONS = {
  scale: 8,
  padding: 4,
  gutter: 4,
} as const;
const BODY_VIEW_SCALE = 8;
const BODY_VIEW_NATIVE_WIDTH = 18;
const BODY_VIEW_NATIVE_HEIGHT = 34;
const GROUNDING_CONTACT_SHEET_GUTTER = 16;
const GROUNDING_LEGEND_MAX_COLUMNS = 8;
const GROUNDING_LEGEND_CELL_WIDTH = 128;
const GROUNDING_LEGEND_CELL_HEIGHT = 18;
const ALL_SURFACE_PAIR_HEADER_HEIGHT = 40;
const ALL_SURFACE_PAIR_ROW_LABEL_WIDTH = 88;
const ALL_SURFACE_PAIR_PANEL_GAP = 16;
const CANDIDATE_COLOR_PAYLOAD_MASK = 0x3f_ffff;

export const CANDIDATE_GROUNDING_RENDERER_VERSION =
  "orthographic-candidate-regions-v2";

export type CandidateGroundingFace = "front" | "back" | "left" | "right";

export interface CandidateGroundingManifestEntry {
  readonly candidateRegionId: string;
  readonly visualId: string;
  readonly color: string;
  readonly rgba: readonly [number, number, number, 255];
  readonly surface: SurfaceKey;
  readonly bodyPart: BodyPart;
  readonly layer: Layer;
  readonly face: Face;
}

/**
 * This document contains primitives and arrays only, so it can be written as
 * JSON without serializing the render buffers themselves.
 */
export interface CandidateGroundingManifest {
  readonly schemaVersion: "1.0";
  readonly rendererVersion: typeof CANDIDATE_GROUNDING_RENDERER_VERSION;
  readonly armType: ArmType;
  readonly projection: {
    readonly kind: "orthographic-surface-layout";
    readonly faces: readonly CandidateGroundingFace[];
    readonly nativeWidth: number;
    readonly nativeHeight: number;
    readonly scale: number;
    readonly width: number;
    readonly height: number;
    readonly layers: readonly ["composite", "base", "outer"];
    readonly contactSheet: {
      readonly columns: 2;
      readonly rows: 2;
      readonly gutter: number;
      readonly order: readonly CandidateGroundingFace[];
      readonly width: number;
      readonly height: number;
    };
  };
  readonly allSurfacePair: {
    readonly kind: "aligned-natural-candidate-face-grid";
    readonly width: number;
    readonly height: number;
    readonly headerHeight: number;
    readonly rowLabelWidth: number;
    readonly panelGap: number;
    readonly correspondingPixelOffsetX: number;
    readonly scale: number;
    readonly padding: number;
    readonly gutter: number;
    readonly columns: readonly Face[];
    readonly rows: readonly {
      readonly bodyPart: BodyPart;
      readonly layer: Layer;
      readonly label: string;
    }[];
    readonly panels: {
      readonly naturalColor: CandidateGroundingPanel;
      readonly candidateRegions: CandidateGroundingPanel;
    };
  };
  readonly legend: readonly CandidateGroundingManifestEntry[];
  readonly legendImage: {
    readonly kind: "candidate-region-swatch-grid";
    readonly columns: number;
    readonly rows: number;
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly width: number;
    readonly height: number;
  };
  readonly colorToRegion: Readonly<
    Record<
      string,
      {
        readonly candidateRegionId: string;
        readonly visualId: string;
        readonly surface: SurfaceKey;
        readonly layer: Layer;
      }
    >
  >;
  readonly visualIdToRegion: Readonly<
    Record<
      string,
      {
        readonly candidateRegionId: string;
        readonly color: string;
        readonly surface: SurfaceKey;
        readonly layer: Layer;
      }
    >
  >;
}

export interface CandidateGroundingView {
  readonly naturalColor: RgbaImage;
  readonly candidateRegions: RgbaImage;
}

export interface CandidateGroundingPanel {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CandidateGroundingProjectionView
  extends CandidateGroundingView {
  readonly layers: Readonly<Record<Layer, CandidateGroundingView>>;
}

export interface CandidateGroundingAllSurfaceContactSheet
  extends CandidateGroundingView {
  /** Shared natural/pseudo-color layout returned by renderFaceContactSheet. */
  readonly cells: readonly ContactSheetCell[];
}

export interface CandidateGroundingRenderResult {
  readonly manifest: CandidateGroundingManifest;
  readonly candidateAtlas: RgbaImage;
  readonly allSurfaceContactSheet: CandidateGroundingAllSurfaceContactSheet;
  readonly allSurfacePairedContactSheet: RgbaImage;
  readonly views: Readonly<
    Record<CandidateGroundingFace, CandidateGroundingProjectionView>
  >;
  readonly contactSheet: CandidateGroundingView;
  readonly layerContactSheets: Readonly<Record<Layer, CandidateGroundingView>>;
  readonly legendImage: RgbaImage;
}

export function renderAnalysisImages(
  image: RgbaImage,
  armType: ArmType,
): {
  readonly atlas: RgbaImage;
  readonly atlasGrid: RgbaImage;
  readonly contactSheet: RgbaImage;
  readonly views: Readonly<
    Record<
      "front" | "back" | "left" | "right" | "frontRightContact",
      RgbaImage
    >
  >;
} {
  const layout = getSkinLayout(armType);
  const model = atlasToSurfaceModel(image, layout);
  const atlas = scaleNearest(image, SCALE);
  const atlasGrid = cloneImage(atlas);
  drawPixelGrid(atlasGrid);
  drawSurfaceBounds(atlasGrid, layout);
  const front = renderBodyView(model, "front");
  const right = renderBodyView(model, "right");
  return {
    atlas,
    atlasGrid,
    contactSheet: renderAllSurfaceFaceContactSheet(model).image,
    views: {
      front,
      back: renderBodyView(model, "back"),
      left: renderBodyView(model, "left"),
      right,
      frontRightContact: combineFrontRightContact(front, right),
    },
  };
}

/**
 * Renders natural-color and CandidateRegion pseudo-color images through the
 * same deterministic orthographic projection. The pseudo-color image is never
 * semantic output: its colors are stable IDs described by the JSON-safe
 * manifest. Layer identity is retained only where the UV layout proves it.
 */
export function renderCandidateRegionGrounding(
  image: RgbaImage,
  armType: ArmType,
  candidateRegions: CandidateRegionDocument,
): CandidateGroundingRenderResult {
  const layout = getSkinLayout(armType);
  if (candidateRegions.armType !== armType) {
    throw new Error(
      `CandidateRegion arm type ${candidateRegions.armType} does not match ${armType}`,
    );
  }

  const naturalModel = atlasToSurfaceModel(image, layout);
  const pseudoColorAtlas = createRgbaImage(image.width, image.height);
  const texels = buildSurfaceTexels(image, layout);
  const texelByPixelId = new Map(texels.map((texel) => [texel.pixelId, texel]));
  const visiblePixelIds = new Set(
    texels
      .filter((texel) => texel.rgba[3] !== 0)
      .map((texel) => texel.pixelId),
  );
  if (candidateRegions.visiblePixelCount !== visiblePixelIds.size) {
    throw new Error(
      `CandidateRegion visible pixel count ${candidateRegions.visiblePixelCount} does not match source ${visiblePixelIds.size}`,
    );
  }

  const regionById = new Map(
    candidateRegions.regions.map((region) => [region.id, region] as const),
  );
  const visualIdEntries = createCandidateRegionVisualIdEntries(candidateRegions);
  const sortedRegions = visualIdEntries.map((entry) => {
    const region = regionById.get(entry.regionId);
    if (!region) {
      throw new Error(`CandidateRegion visual ID references ${entry.regionId}`);
    }
    return { region, visualId: entry.visualId };
  });
  const assignedPixelIds = new Set<number>();
  const regionIds = new Set<string>();
  const usedColors = new Set<number>();
  const manifestEntries: CandidateGroundingManifestEntry[] = [];

  for (const { region, visualId } of sortedRegions) {
    if (regionIds.has(region.id)) {
      throw new Error(`Duplicate CandidateRegion ID: ${region.id}`);
    }
    regionIds.add(region.id);
    if (region.pixelCount !== region.pixelIds.length) {
      throw new Error(
        `CandidateRegion ${region.id} pixel count does not match its pixel IDs`,
      );
    }

    const definition = layout.surfaces[region.surface];
    if (!definition) {
      throw new Error(`CandidateRegion ${region.id} has unknown surface ${region.surface}`);
    }
    const rgba = candidateColor(region.id, definition.layer, usedColors);
    const color = rgbaHex(rgba);
    manifestEntries.push({
      candidateRegionId: region.id,
      visualId,
      color,
      rgba,
      surface: region.surface,
      bodyPart: definition.bodyPart,
      layer: definition.layer,
      face: definition.face,
    });

    for (const pixelId of region.pixelIds) {
      if (!Number.isInteger(pixelId) || pixelId < 0 || pixelId >= 64 * 64) {
        throw new RangeError(
          `CandidateRegion ${region.id} contains invalid pixel ${pixelId}`,
        );
      }
      const texel = texelByPixelId.get(pixelId);
      if (!texel || texel.rgba[3] === 0) {
        throw new Error(
          `CandidateRegion ${region.id} contains non-visible UV pixel ${pixelId}`,
        );
      }
      if (texel.surface !== region.surface) {
        throw new Error(
          `CandidateRegion ${region.id} pixel ${pixelId} belongs to ${texel.surface}`,
        );
      }
      if (assignedPixelIds.has(pixelId)) {
        throw new Error(`CandidateRegion pixel ${pixelId} is assigned more than once`);
      }
      assignedPixelIds.add(pixelId);
      pseudoColorAtlas.data.set(rgba, pixelId * 4);
    }
  }

  if (assignedPixelIds.size !== visiblePixelIds.size) {
    const missingPixelId = [...visiblePixelIds].find(
      (pixelId) => !assignedPixelIds.has(pixelId),
    );
    throw new Error(
      `CandidateRegions do not cover every visible UV pixel${
        missingPixelId === undefined ? "" : `; first missing pixel is ${missingPixelId}`
      }`,
    );
  }

  const pseudoColorModel = atlasToSurfaceModel(pseudoColorAtlas, layout);
  const naturalFaceContactSheet = renderAllSurfaceFaceContactSheet(naturalModel);
  const candidateFaceContactSheet = renderAllSurfaceFaceContactSheet(
    pseudoColorModel,
  );
  const allSurfacePair = renderAllSurfacePairedContactSheet(
    naturalFaceContactSheet.image,
    candidateFaceContactSheet.image,
  );
  const renderPair = (
    face: CandidateGroundingFace,
    layer?: Layer,
  ): CandidateGroundingView => ({
    naturalColor: renderBodyView(naturalModel, face, layer),
    candidateRegions: renderBodyView(pseudoColorModel, face, layer),
  });
  const renderProjection = (
    face: CandidateGroundingFace,
  ): CandidateGroundingProjectionView => ({
    ...renderPair(face),
    layers: {
      base: renderPair(face, "base"),
      outer: renderPair(face, "outer"),
    },
  });
  const colorToRegion = Object.fromEntries(
    manifestEntries.map((entry) => [
      entry.color,
      {
        candidateRegionId: entry.candidateRegionId,
        visualId: entry.visualId,
        surface: entry.surface,
        layer: entry.layer,
      },
    ]),
  );
  const visualIdToRegion = Object.fromEntries(
    manifestEntries.map((entry) => [
      entry.visualId,
      {
        candidateRegionId: entry.candidateRegionId,
        color: entry.color,
        surface: entry.surface,
        layer: entry.layer,
      },
    ]),
  );

  const views = {
    front: renderProjection("front"),
    back: renderProjection("back"),
    left: renderProjection("left"),
    right: renderProjection("right"),
  };
  const contactSheetOrder = ["front", "back", "left", "right"] as const;
  const contactSheet = {
    naturalColor: combineGroundingContactSheet(
      [
        views.front.naturalColor,
        views.back.naturalColor,
        views.left.naturalColor,
        views.right.naturalColor,
      ],
    ),
    candidateRegions: combineGroundingContactSheet(
      [
        views.front.candidateRegions,
        views.back.candidateRegions,
        views.left.candidateRegions,
        views.right.candidateRegions,
      ],
    ),
  };
  const layerContactSheets = {
    base: {
      naturalColor: combineGroundingContactSheet([
        views.front.layers.base.naturalColor,
        views.back.layers.base.naturalColor,
        views.left.layers.base.naturalColor,
        views.right.layers.base.naturalColor,
      ]),
      candidateRegions: combineGroundingContactSheet([
        views.front.layers.base.candidateRegions,
        views.back.layers.base.candidateRegions,
        views.left.layers.base.candidateRegions,
        views.right.layers.base.candidateRegions,
      ]),
    },
    outer: {
      naturalColor: combineGroundingContactSheet([
        views.front.layers.outer.naturalColor,
        views.back.layers.outer.naturalColor,
        views.left.layers.outer.naturalColor,
        views.right.layers.outer.naturalColor,
      ]),
      candidateRegions: combineGroundingContactSheet([
        views.front.layers.outer.candidateRegions,
        views.back.layers.outer.candidateRegions,
        views.left.layers.outer.candidateRegions,
        views.right.layers.outer.candidateRegions,
      ]),
    },
  };
  const legendImage = renderCandidateLegend(manifestEntries);
  const legendColumns = Math.min(
    GROUNDING_LEGEND_MAX_COLUMNS,
    Math.max(1, manifestEntries.length),
  );
  const legendRows = Math.max(
    1,
    Math.ceil(manifestEntries.length / legendColumns),
  );

  return {
    manifest: {
      schemaVersion: "1.0",
      rendererVersion: CANDIDATE_GROUNDING_RENDERER_VERSION,
      armType,
      projection: {
        kind: "orthographic-surface-layout",
        faces: ["front", "back", "left", "right"],
        nativeWidth: BODY_VIEW_NATIVE_WIDTH,
        nativeHeight: BODY_VIEW_NATIVE_HEIGHT,
        scale: BODY_VIEW_SCALE,
        width: BODY_VIEW_NATIVE_WIDTH * BODY_VIEW_SCALE,
        height: BODY_VIEW_NATIVE_HEIGHT * BODY_VIEW_SCALE,
        layers: ["composite", "base", "outer"],
        contactSheet: {
          columns: 2,
          rows: 2,
          gutter: GROUNDING_CONTACT_SHEET_GUTTER,
          order: contactSheetOrder,
          width: contactSheet.naturalColor.width,
          height: contactSheet.naturalColor.height,
        },
      },
      allSurfacePair: allSurfacePair.layout,
      legend: manifestEntries,
      legendImage: {
        kind: "candidate-region-swatch-grid",
        columns: legendColumns,
        rows: legendRows,
        cellWidth: GROUNDING_LEGEND_CELL_WIDTH,
        cellHeight: GROUNDING_LEGEND_CELL_HEIGHT,
        width: legendImage.width,
        height: legendImage.height,
      },
      colorToRegion,
      visualIdToRegion,
    },
    candidateAtlas: scaleNearest(pseudoColorAtlas, SCALE),
    allSurfaceContactSheet: {
      naturalColor: naturalFaceContactSheet.image,
      candidateRegions: candidateFaceContactSheet.image,
      cells: candidateFaceContactSheet.cells,
    },
    allSurfacePairedContactSheet: allSurfacePair.image,
    views,
    contactSheet,
    layerContactSheets,
    legendImage,
  };
}

function renderAllSurfaceFaceContactSheet(model: SurfaceModel) {
  return renderFaceContactSheet(model, FACE_CONTACT_SHEET_OPTIONS);
}

function renderAllSurfacePairedContactSheet(
  naturalColor: RgbaImage,
  candidateRegions: RgbaImage,
): {
  readonly image: RgbaImage;
  readonly layout: CandidateGroundingManifest["allSurfacePair"];
} {
  if (
    naturalColor.width !== candidateRegions.width ||
    naturalColor.height !== candidateRegions.height
  ) {
    throw new Error("Natural and candidate all-surface sheets must have matching dimensions");
  }

  const naturalPanel: CandidateGroundingPanel = {
    x: ALL_SURFACE_PAIR_ROW_LABEL_WIDTH,
    y: ALL_SURFACE_PAIR_HEADER_HEIGHT,
    width: naturalColor.width,
    height: naturalColor.height,
  };
  const candidatePanel: CandidateGroundingPanel = {
    x: naturalPanel.x + naturalPanel.width + ALL_SURFACE_PAIR_PANEL_GAP,
    y: naturalPanel.y,
    width: candidateRegions.width,
    height: candidateRegions.height,
  };
  const width = candidatePanel.x + candidatePanel.width;
  const height = ALL_SURFACE_PAIR_HEADER_HEIGHT + naturalColor.height;
  const image = createRgbaImage(width, height);
  const labelBackground: Rgba = [20, 28, 30, 255];
  const labelForeground: Rgba = [245, 246, 239, 255];
  fillRectangle(image, 0, 0, width, ALL_SURFACE_PAIR_HEADER_HEIGHT, labelBackground);
  fillRectangle(
    image,
    0,
    ALL_SURFACE_PAIR_HEADER_HEIGHT,
    ALL_SURFACE_PAIR_ROW_LABEL_WIDTH,
    naturalColor.height,
    labelBackground,
  );
  fillRectangle(
    image,
    naturalPanel.x + naturalPanel.width,
    ALL_SURFACE_PAIR_HEADER_HEIGHT,
    ALL_SURFACE_PAIR_PANEL_GAP,
    naturalColor.height,
    labelBackground,
  );
  copyImage(naturalColor, image, naturalPanel.x, naturalPanel.y);
  copyImage(candidateRegions, image, candidatePanel.x, candidatePanel.y);

  drawCenteredBitmapText(
    image,
    "NATURAL",
    naturalPanel.x,
    naturalPanel.width,
    3,
    labelForeground,
  );
  drawCenteredBitmapText(
    image,
    "REGIONS",
    candidatePanel.x,
    candidatePanel.width,
    3,
    labelForeground,
  );

  const columnWidth =
    (naturalColor.width - (FACES.length - 1) * FACE_CONTACT_SHEET_OPTIONS.gutter) /
    FACES.length;
  FACES.forEach((face, index) => {
    const offset = index * (columnWidth + FACE_CONTACT_SHEET_OPTIONS.gutter);
    const label = face.toUpperCase();
    drawCenteredBitmapText(
      image,
      label,
      naturalPanel.x + offset,
      columnWidth,
      22,
      labelForeground,
    );
    drawCenteredBitmapText(
      image,
      label,
      candidatePanel.x + offset,
      columnWidth,
      22,
      labelForeground,
    );
  });

  const rows = BODY_PARTS.flatMap((bodyPart) =>
    LAYERS.map((layer) => ({
      bodyPart,
      layer,
      label: allSurfaceRowLabel(bodyPart, layer),
    })),
  );
  const rowHeight =
    (naturalColor.height - (rows.length - 1) * FACE_CONTACT_SHEET_OPTIONS.gutter) /
    rows.length;
  rows.forEach((row, index) => {
    const offset = index * (rowHeight + FACE_CONTACT_SHEET_OPTIONS.gutter);
    drawCenteredBitmapText(
      image,
      row.label,
      0,
      ALL_SURFACE_PAIR_ROW_LABEL_WIDTH,
      ALL_SURFACE_PAIR_HEADER_HEIGHT + offset + Math.floor((rowHeight - 10) / 2),
      labelForeground,
    );
  });

  return {
    image,
    layout: {
      kind: "aligned-natural-candidate-face-grid",
      width,
      height,
      headerHeight: ALL_SURFACE_PAIR_HEADER_HEIGHT,
      rowLabelWidth: ALL_SURFACE_PAIR_ROW_LABEL_WIDTH,
      panelGap: ALL_SURFACE_PAIR_PANEL_GAP,
      correspondingPixelOffsetX: candidatePanel.x - naturalPanel.x,
      scale: FACE_CONTACT_SHEET_OPTIONS.scale,
      padding: FACE_CONTACT_SHEET_OPTIONS.padding,
      gutter: FACE_CONTACT_SHEET_OPTIONS.gutter,
      columns: [...FACES],
      rows,
      panels: {
        naturalColor: naturalPanel,
        candidateRegions: candidatePanel,
      },
    },
  };
}

function allSurfaceRowLabel(bodyPart: BodyPart, layer: Layer): string {
  const bodyPartLabel: Readonly<Record<BodyPart, string>> = {
    head: "HEAD",
    torso: "TORSO",
    rightArm: "RARM",
    leftArm: "LARM",
    rightLeg: "RLEG",
    leftLeg: "LLEG",
  };
  return `${bodyPartLabel[bodyPart]} ${layer === "base" ? "BASE" : "OUT"}`;
}

function renderBodyView(
  model: SurfaceModel,
  face: Face,
  layer?: Layer,
): RgbaImage {
  const native = createRgbaImage(
    BODY_VIEW_NATIVE_WIDTH,
    BODY_VIEW_NATIVE_HEIGHT,
  );
  const armWidth = model.armType === "slim" ? 3 : 4;
  const placements = [
    { bodyPart: "head", x: 5, y: 1 },
    { bodyPart: "torso", x: 5, y: 9 },
    { bodyPart: "rightArm", x: 5 - armWidth, y: 9 },
    { bodyPart: "leftArm", x: 13, y: 9 },
    { bodyPart: "rightLeg", x: 5, y: 21 },
    { bodyPart: "leftLeg", x: 9, y: 21 },
  ] as const;

  for (const placement of placements) {
    if (layer === undefined || layer === "base") {
      const base = model.surfaces[`${placement.bodyPart}.base.${face}`];
      drawTexture(native, base, placement.x, placement.y);
    }
    if (layer === undefined || layer === "outer") {
      const outer = model.surfaces[`${placement.bodyPart}.outer.${face}`];
      drawTexture(native, outer, placement.x, placement.y);
    }
  }
  return scaleNearest(native, BODY_VIEW_SCALE);
}

function candidateColor(
  candidateRegionId: string,
  layer: Layer,
  usedColors: Set<number>,
): readonly [number, number, number, 255] {
  let payload = hashString(candidateRegionId) & CANDIDATE_COLOR_PAYLOAD_MASK;
  for (let attempt = 0; attempt <= CANDIDATE_COLOR_PAYLOAD_MASK; attempt += 1) {
    const redBand = layer === "base" ? 32 : 160;
    const red = redBand + ((payload >>> 16) & 0x3f);
    const green = (payload >>> 8) & 0xff;
    const blue = payload & 0xff;
    const packed = (red << 16) | (green << 8) | blue;
    if (!usedColors.has(packed)) {
      usedColors.add(packed);
      return [red, green, blue, 255];
    }
    payload = (payload + 1) & CANDIDATE_COLOR_PAYLOAD_MASK;
  }
  throw new Error("CandidateRegion pseudo-color space is exhausted");
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function rgbaHex(rgba: readonly [number, number, number, 255]): string {
  return `#${rgba
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function drawTexture(
  target: RgbaImage,
  texture: SurfaceTexture,
  targetX: number,
  targetY: number,
): void {
  for (let y = 0; y < texture.height; y += 1) {
    for (let x = 0; x < texture.width; x += 1) {
      const sourceOffset = (y * texture.width + x) * 4;
      const source = texture.data.subarray(sourceOffset, sourceOffset + 4) as unknown as Rgba;
      if (source[3] === 0) continue;
      const offset = ((targetY + y) * target.width + targetX + x) * 4;
      blend(target.data, offset, source);
    }
  }
}

function combineFrontRightContact(
  front: RgbaImage,
  side: RgbaImage,
): RgbaImage {
  const result = createRgbaImage(front.width + side.width + 16, front.height);
  copyImage(front, result, 0, 0);
  copyImage(side, result, front.width + 16, 0);
  return result;
}

function combineGroundingContactSheet(
  images: readonly [RgbaImage, RgbaImage, RgbaImage, RgbaImage],
): RgbaImage {
  const width = images[0].width * 2 + GROUNDING_CONTACT_SHEET_GUTTER;
  const height = images[0].height * 2 + GROUNDING_CONTACT_SHEET_GUTTER;
  const result = createRgbaImage(width, height);
  copyImage(images[0], result, 0, 0);
  copyImage(
    images[1],
    result,
    images[0].width + GROUNDING_CONTACT_SHEET_GUTTER,
    0,
  );
  copyImage(
    images[2],
    result,
    0,
    images[0].height + GROUNDING_CONTACT_SHEET_GUTTER,
  );
  copyImage(
    images[3],
    result,
    images[0].width + GROUNDING_CONTACT_SHEET_GUTTER,
    images[0].height + GROUNDING_CONTACT_SHEET_GUTTER,
  );
  return result;
}

function renderCandidateLegend(
  entries: readonly CandidateGroundingManifestEntry[],
): RgbaImage {
  const columns = Math.min(
    GROUNDING_LEGEND_MAX_COLUMNS,
    Math.max(1, entries.length),
  );
  const rows = Math.max(1, Math.ceil(entries.length / columns));
  const image = createRgbaImage(
    columns * GROUNDING_LEGEND_CELL_WIDTH,
    rows * GROUNDING_LEGEND_CELL_HEIGHT,
  );
  entries.forEach((entry, index) => {
    const x = (index % columns) * GROUNDING_LEGEND_CELL_WIDTH;
    const y = Math.floor(index / columns) * GROUNDING_LEGEND_CELL_HEIGHT;
    fillRectangle(
      image,
      x + 1,
      y + 1,
      GROUNDING_LEGEND_CELL_WIDTH - 2,
      GROUNDING_LEGEND_CELL_HEIGHT - 2,
      [20, 28, 30, 255],
    );
    fillRectangle(image, x + 3, y + 3, 12, 12, entry.rgba);
    drawBitmapText(image, entry.visualId, x + 20, y + 4, [245, 246, 239, 255]);
    drawBitmapText(
      image,
      entry.layer === "base" ? "B" : "O",
      x + 114,
      y + 4,
      [245, 246, 239, 255],
    );
  });
  return image;
}

const BITMAP_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  G: ["111", "100", "101", "101", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  J: ["001", "001", "001", "101", "111"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  O: ["111", "101", "101", "101", "111"],
  P: ["110", "101", "110", "100", "100"],
  Q: ["111", "101", "101", "111", "001"],
  R: ["110", "101", "110", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"],
  W: ["101", "101", "111", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
  Z: ["111", "001", "010", "100", "111"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

function drawCenteredBitmapText(
  image: RgbaImage,
  value: string,
  x: number,
  width: number,
  y: number,
  rgba: Rgba,
): void {
  const textWidth = value.length * 8;
  drawBitmapText(
    image,
    value,
    x + Math.max(0, Math.floor((width - textWidth) / 2)),
    y,
    rgba,
  );
}

function drawBitmapText(
  image: RgbaImage,
  value: string,
  x: number,
  y: number,
  rgba: Rgba,
): void {
  const scale = 2;
  let cursor = x;
  for (const character of value) {
    const glyph = BITMAP_GLYPHS[character];
    if (glyph) {
      glyph.forEach((row, rowIndex) => {
        [...row].forEach((pixel, columnIndex) => {
          if (pixel === "1") {
            fillRectangle(
              image,
              cursor + columnIndex * scale,
              y + rowIndex * scale,
              scale,
              scale,
              rgba,
            );
          }
        });
      });
    }
    cursor += 4 * scale;
  }
}

function fillRectangle(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      image.data.set(rgba, (row * image.width + column) * 4);
    }
  }
}

function copyImage(source: RgbaImage, target: RgbaImage, x: number, y: number): void {
  for (let row = 0; row < source.height; row += 1) {
    const sourceOffset = row * source.width * 4;
    const targetOffset = ((y + row) * target.width + x) * 4;
    target.data.set(source.data.subarray(sourceOffset, sourceOffset + source.width * 4), targetOffset);
  }
}

function drawPixelGrid(image: RgbaImage): void {
  for (let coordinate = 0; coordinate <= 64; coordinate += 1) {
    const position = Math.min(coordinate * SCALE, image.width - 1);
    drawLine(image, position, 0, position, image.height - 1, [20, 28, 30, 96]);
    drawLine(image, 0, position, image.width - 1, position, [20, 28, 30, 96]);
  }
}

function drawSurfaceBounds(
  image: RgbaImage,
  layout: ReturnType<typeof getSkinLayout>,
): void {
  for (const key of layout.surfaceOrder) {
    const rect = layout.surfaces[key].atlasRect;
    const x0 = rect.x * SCALE;
    const y0 = rect.y * SCALE;
    const x1 = (rect.x + rect.width) * SCALE - 1;
    const y1 = (rect.y + rect.height) * SCALE - 1;
    const color: Rgba = key.includes(".outer.")
      ? [240, 105, 66, 210]
      : [25, 124, 142, 210];
    drawLine(image, x0, y0, x1, y0, color);
    drawLine(image, x1, y0, x1, y1, color);
    drawLine(image, x1, y1, x0, y1, color);
    drawLine(image, x0, y1, x0, y0, color);
  }
}

function drawLine(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: Rgba,
): void {
  const horizontal = y0 === y1;
  const length = horizontal ? Math.abs(x1 - x0) : Math.abs(y1 - y0);
  for (let step = 0; step <= length; step += 1) {
    const x = horizontal ? Math.min(x0, x1) + step : x0;
    const y = horizontal ? y0 : Math.min(y0, y1) + step;
    blend(image.data, (y * image.width + x) * 4, rgba);
  }
}

function blend(target: Uint8Array, offset: number, source: Rgba): void {
  const sourceAlpha = source[3] / 255;
  const targetAlpha = target[offset + 3]! / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    target[offset + channel] = Math.round(
      (source[channel]! * sourceAlpha +
        target[offset + channel]! * targetAlpha * (1 - sourceAlpha)) /
        outputAlpha,
    );
  }
  target[offset + 3] = Math.round(outputAlpha * 255);
}

function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: image.data.slice() };
}
