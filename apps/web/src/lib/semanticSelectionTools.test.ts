import {
  buildSurfaceTexels,
  getSkinLayout,
  type RgbaImage,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import { describe, expect, it } from "vitest";
import {
  applySelectionPixels,
  compareSemanticRevisionSnapshots,
  commitSemanticSelection,
  connectedExactColorPixelIds,
  createSemanticSelectionHistory,
  mirroredSelectionPixelIds,
  rectangleSelectionPixelIds,
  redoSemanticSelection,
  seamExpansionPixelIds,
  semanticSelectionSpans,
  semanticRevisionDiffLabel,
  semanticRevisionDiffPixelIds,
  surfaceSelectionPixelIds,
  undoSemanticSelection,
} from "./semanticSelectionTools";

describe("semantic player selection tools", () => {
  it("filters rectangle selection to visible used UV pixels", () => {
    const image = transparentImage();
    setPixel(image, 8, 8, [1, 2, 3, 255]);
    setPixel(image, 9, 8, [1, 2, 3, 255]);
    setPixel(image, 1, 1, [1, 2, 3, 255]);
    expect(rectangleSelectionPixelIds(image, "slim", 0, 10 * 64 + 10))
      .toEqual([8 * 64 + 8, 8 * 64 + 9]);
  });

  it("selects only the connected exact-color island on one canonical surface", () => {
    const image = transparentImage();
    setPixel(image, 8, 8, [10, 20, 30, 255]);
    setPixel(image, 9, 8, [10, 20, 30, 255]);
    setPixel(image, 11, 8, [10, 20, 30, 255]);
    expect(connectedExactColorPixelIds(image, "slim", 8 * 64 + 8))
      .toEqual([8 * 64 + 8, 8 * 64 + 9]);
  });

  it("selects an exact surface and mirrors via canonical skin-core mapping", () => {
    const image = opaqueImage();
    const texels = buildSurfaceTexels(image, getSkinLayout("slim"));
    const source = texels.find((texel) =>
      texel.surface === "rightArm.base.front" &&
      texel.localU === 0 && texel.localV === 0)!;
    const expected = texels.find((texel) =>
      texel.surface === "leftArm.base.front" &&
      texel.localU === 2 && texel.localV === 0)!;

    expect(surfaceSelectionPixelIds(image, "slim", source.pixelId)).toHaveLength(36);
    expect(mirroredSelectionPixelIds(image, "slim", [source.pixelId]))
      .toEqual([expected.pixelId]);
  });

  it("expands only over a real 3D cube seam, not nearby atlas cells", () => {
    const image = opaqueImage();
    const texels = buildSurfaceTexels(image, getSkinLayout("slim"));
    const source = texels.find((texel) =>
      texel.surface === "torso.base.front" &&
      texel.localU === 2 && texel.localV === 0)!;
    const expected = texels.find((texel) =>
      texel.surface === "torso.base.top" &&
      texel.localU === 2 && texel.localV === 3)!;
    const expansion = seamExpansionPixelIds(image, "slim", [source.pixelId]);

    expect(expansion).toContain(expected.pixelId);
    expect(expansion).toHaveLength(1);
  });

  it("keeps draft history local and clears redo after a new choice", () => {
    let history = createSemanticSelectionHistory();
    history = commitSemanticSelection(history, [4, 2]);
    history = commitSemanticSelection(history, applySelectionPixels(
      history.present,
      [3],
      "add",
    ));
    expect(history.present).toEqual([2, 3, 4]);
    history = undoSemanticSelection(history);
    expect(history.present).toEqual([2, 4]);
    history = redoSemanticSelection(history);
    expect(history.present).toEqual([2, 3, 4]);
    history = undoSemanticSelection(history);
    history = commitSemanticSelection(history, [9]);
    expect(history.future).toEqual([]);
  });

  it("computes real RGBA, ownership, and category masks against the parent", () => {
    const parentImage = opaqueImage();
    const currentImage = opaqueImage();
    const texel = buildSurfaceTexels(parentImage, getSkinLayout("slim")).find(
      (item) => item.surface === "torso.base.front",
    )!;
    const span = [{
      surface: texel.surface,
      y: texel.atlasY,
      x0: texel.atlasX,
      x1: texel.atlasX,
    }];
    currentImage.data[texel.pixelId * 4] = 99;
    const diff = compareSemanticRevisionSnapshots(
      {
        image: parentImage,
        armType: "slim",
        components: [semanticComponent("shirt.main", "upper_clothing", span)],
      },
      {
        image: currentImage,
        armType: "slim",
        components: [semanticComponent("shirt.repaired", "hair", span)],
      },
    );

    expect(diff.texturePixelIds).toEqual([texel.pixelId]);
    expect(diff.ownershipPixelIds).toEqual([texel.pixelId]);
    expect(diff.categoryPixelIds).toEqual([texel.pixelId]);
    expect(semanticRevisionDiffPixelIds(diff, "ownership"))
      .toEqual([texel.pixelId]);
  });

  it("proves classification-only changes as RGBA zero and semantic nonzero", () => {
    const image = opaqueImage();
    const texel = buildSurfaceTexels(image, getSkinLayout("slim")).find(
      (item) => item.surface === "torso.base.front",
    )!;
    const span = [{
      surface: texel.surface,
      y: texel.atlasY,
      x0: texel.atlasX,
      x1: texel.atlasX,
    }];
    const diff = compareSemanticRevisionSnapshots(
      {
        image,
        armType: "slim",
        components: [semanticComponent("shirt.main", "upper_clothing", span)],
      },
      {
        image: { ...image, data: new Uint8Array(image.data) },
        armType: "slim",
        components: [semanticComponent("shirt.main", "hair", span)],
      },
    );

    expect(diff.texturePixelIds).toEqual([]);
    expect(diff.ownershipPixelIds).toEqual([]);
    expect(diff.categoryPixelIds).toEqual([texel.pixelId]);
    expect(semanticRevisionDiffLabel(diff)).toContain("纹理 RGBA 未变化");
    expect(semanticRevisionDiffLabel(diff)).toContain("分类 1 px");
  });

  it("encodes semantic spans with the Revision arm type, not a preview override", () => {
    const image = opaqueImage();
    const slimByPixel = new Map(buildSurfaceTexels(
      image,
      getSkinLayout("slim"),
    ).map((texel) => [texel.pixelId, texel]));
    const wideByPixel = new Map(buildSurfaceTexels(
      image,
      getSkinLayout("wide"),
    ).map((texel) => [texel.pixelId, texel]));
    const mismatch = [...slimByPixel.values()].find((slim) => {
      const wide = wideByPixel.get(slim.pixelId);
      return wide && (
        wide.surface !== slim.surface ||
        wide.localU !== slim.localU ||
        wide.localV !== slim.localV
      );
    });
    expect(mismatch).toBeDefined();
    const span = semanticSelectionSpans([mismatch!.pixelId], "slim")[0]!;

    expect(span.surface).toBe(mismatch!.surface);
    expect(span.y).toBe(mismatch!.atlasY);
    expect(span.x0).toBe(mismatch!.atlasX);
    expect(span.x1).toBe(mismatch!.atlasX);
  });
});

function transparentImage(): RgbaImage {
  return { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) };
}

function opaqueImage(): RgbaImage {
  const image = transparentImage();
  for (let pixelId = 0; pixelId < 64 * 64; pixelId += 1) {
    image.data[pixelId * 4 + 3] = 255;
  }
  return image;
}

function setPixel(
  image: RgbaImage,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
): void {
  image.data.set(rgba, (y * 64 + x) * 4);
}

function semanticComponent(
  instanceId: string,
  category: SemanticComponent["category"],
  spans: SemanticComponent["spans"],
): SemanticComponent {
  return {
    instanceId,
    displayName: instanceId,
    category,
    confidence: 1,
    reviewState: "confirmed",
    maskFile: `${instanceId}.png`,
    spans,
    palette: { dominant: "#ffffff", colors: ["#ffffff"] },
    relations: {
      attachedTo: null,
      pairedWith: [],
      sameOutfitGroup: null,
      conflictsWith: [],
    },
    provenance: { actorType: "user", containsGeneratedPixels: false },
  };
}
