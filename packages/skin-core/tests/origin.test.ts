import { describe, expect, it } from "vitest";
import {
  MAX_PIXEL_ORIGIN_ENTRIES,
  canonicalizePixelOriginDocument,
  createCopiedPixelOriginAssignments,
  createGeneratedPixelOriginAssignment,
  createLegacyMixedPixelOriginDocument,
  createManualPixelOriginAssignment,
  createRgbaImage,
  createSourceVisiblePixelOriginDocument,
  deriveGeneratedPixelMask,
  getPixelOrigin,
  getSkinLayout,
  pixelIdsToMask,
  propagatePixelOriginDocument,
  selectPixelOriginDocument,
  setPixel,
  summarizePixelOrigins,
  summarizePixelOriginsForMask,
  validatePixelOriginDocument,
  type ArmType,
  type PixelOriginDocument,
  type RgbaImage,
} from "../src";

const EVIDENCE_HASH = `sha256:${"a".repeat(64)}`;

describe("pixel origin documents", () => {
  it("creates exact source-visible coverage and deterministic summaries", () => {
    const image = twoPixelImage();
    const document = createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "rev_source" },
      armType: "slim",
      image,
    });

    expect(document).toMatchObject({
      schemaVersion: "1.0",
      subject: { kind: "revision", id: "rev_source" },
      entries: [
        {
          intrinsicOrigin: "source_visible",
          evidence: { sourceRevisionId: "rev_source" },
        },
      ],
      copyLineage: [],
    });
    expect(summarizePixelOrigins(document)).toEqual({
      counts: {
        source_visible: 2,
        manual_authored: 0,
        generated_completion: 0,
        legacy_mixed: 0,
      },
      containsGeneratedPixels: false,
    });
    expect([...deriveGeneratedPixelMask(document)]).not.toContain(1);
    expect(() => validatePixelOriginDocument(document, image)).not.toThrow();
  });

  it("requires explicit origins for changed pixels and drops erased pixels", () => {
    const sourceImage = twoPixelImage();
    const sourceDocument = createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "rev_source" },
      armType: "slim",
      image: sourceImage,
    });
    const resultImage = cloneImage(sourceImage);
    setPixel(resultImage, 8, 8, [9, 8, 7, 255]);
    setPixel(resultImage, 9, 8, [0, 0, 0, 0]);

    expect(() =>
      propagatePixelOriginDocument({
        sourceDocument,
        sourceImage,
        resultImage,
        resultSubject: { kind: "revision", id: "rev_result" },
      }),
    ).toThrow(/explicit origin assignment/i);

    const result = propagatePixelOriginDocument({
      sourceDocument,
      sourceImage,
      resultImage,
      resultSubject: { kind: "revision", id: "rev_result" },
      assignments: [
        createManualPixelOriginAssignment({
          pixelId: 8 * 64 + 8,
          actor: { type: "user", id: "Player One <player@example.test>" },
          operationId: "op_manual",
        }),
      ],
    });

    expect(getPixelOrigin(result, 8 * 64 + 8)).toMatchObject({
      intrinsicOrigin: "manual_authored",
      evidence: {
        actor: { type: "user", id: "Player One <player@example.test>" },
        operationId: "op_manual",
      },
      copyLineage: null,
    });
    expect(getPixelOrigin(result, 8 * 64 + 9)).toBeUndefined();
    expect(summarizePixelOrigins(result).counts.manual_authored).toBe(1);
  });

  it("keeps generated origin separate from immediate copied-from lineage", () => {
    const image = onePixelImage();
    const sourceVisible = createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "rev_source" },
      armType: "slim",
      image,
    });
    const generated = propagatePixelOriginDocument({
      sourceDocument: sourceVisible,
      sourceImage: image,
      resultImage: image,
      resultSubject: { kind: "revision", id: "rev_generated" },
      assignments: [
        createGeneratedPixelOriginAssignment({
          pixelId: 8 * 64 + 8,
          evidence: {
            candidateId: "candidate_test",
            evidenceHash: EVIDENCE_HASH,
            decisionId: "decision_test",
            actor: { type: "user", id: "player@example.test" },
          },
        }),
      ],
    });
    const part = propagatePixelOriginDocument({
      sourceDocument: generated,
      sourceImage: image,
      resultImage: image,
      resultSubject: { kind: "part", id: "part_test" },
      assignments: createCopiedPixelOriginAssignments({
        sourceDocument: generated,
        mappings: [{ sourcePixelId: 520, targetPixelId: 520 }],
        sourceComponentInstanceId: "hair.main",
      }),
    });
    const applied = createCopiedPixelOriginAssignments({
      sourceDocument: part,
      mappings: [{ sourcePixelId: 520, targetPixelId: 521 }],
      sourceComponentInstanceId: "hair.main",
    })[0]!;

    expect(getPixelOrigin(part, 520)).toMatchObject({
      intrinsicOrigin: "generated_completion",
      copyLineage: {
        sourceSubject: { kind: "revision", id: "rev_generated" },
        sourceComponentInstanceId: "hair.main",
        sourcePixelId: 520,
      },
    });
    expect(applied).toMatchObject({
      intrinsicOrigin: "generated_completion",
      copyLineage: {
        sourceSubject: { kind: "part", id: "part_test" },
        sourcePixelId: 520,
      },
    });
    expect(deriveGeneratedPixelMask(part)[520]).toBe(1);
  });

  it("selects and rebinds exact subsets without guessing missing coverage", () => {
    const image = twoPixelImage();
    const source = createLegacyMixedPixelOriginDocument({
      subject: { kind: "revision", id: "rev_legacy_child" },
      sourceRevisionId: "rev_legacy",
      armType: "slim",
      image,
    });
    const selected = selectPixelOriginDocument({
      document: source,
      pixelIds: [520],
      subject: { kind: "part", id: "part_legacy" },
    });
    const selectedImage = onePixelImage();

    expect(() => validatePixelOriginDocument(selected, selectedImage)).not.toThrow();
    expect(summarizePixelOriginsForMask(selected, pixelIdsToMask([520]))).toEqual({
      counts: {
        source_visible: 0,
        manual_authored: 0,
        generated_completion: 0,
        legacy_mixed: 1,
      },
      containsGeneratedPixels: false,
    });
    expect(() => validatePixelOriginDocument(selected, image)).toThrow(/cover every/i);
    expect(() =>
      selectPixelOriginDocument({
        document: source,
        pixelIds: [522],
        subject: { kind: "part", id: "part_invalid" },
      }),
    ).toThrow(/has no source/i);
  });

  it("rejects overlaps, non-canonical ordering, unsafe references, and oversize input", () => {
    const image = twoPixelImage();
    const source = createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "rev_source" },
      armType: "slim",
      image,
    });
    const overlap = {
      ...source,
      entries: [source.entries[0]!, source.entries[0]!],
    } as PixelOriginDocument;
    expect(() => canonicalizePixelOriginDocument(overlap)).toThrow(/overlap/i);

    const mixedImage = cloneImage(image);
    setPixel(mixedImage, 8, 8, [7, 7, 7, 255]);
    const mixed = propagatePixelOriginDocument({
      sourceDocument: source,
      sourceImage: image,
      resultImage: mixedImage,
      resultSubject: { kind: "revision", id: "rev_mixed" },
      assignments: [
        createManualPixelOriginAssignment({
          pixelId: 520,
          actor: { type: "system" },
          operationId: "op_test",
        }),
      ],
    });
    expect(mixed.entries).toHaveLength(2);
    const reversed = {
      ...mixed,
      entries: [...mixed.entries].reverse(),
    } as PixelOriginDocument;
    expect(() => validatePixelOriginDocument(reversed)).toThrow(/not canonical/i);

    expect(() =>
      createLegacyMixedPixelOriginDocument({
        subject: { kind: "revision", id: "../unsafe" },
        sourceRevisionId: "rev_source",
        armType: "slim",
        image,
      }),
    ).toThrow(/path-safe/i);

    const oversized = {
      ...source,
      entries: Array.from(
        { length: MAX_PIXEL_ORIGIN_ENTRIES + 1 },
        () => source.entries[0]!,
      ),
    } as PixelOriginDocument;
    expect(() => canonicalizePixelOriginDocument(oversized)).toThrow(/must not exceed/i);
  });

  it("builds a full used-UV batch with one bounded source expansion", () => {
    const image = fullUsedUvImage("slim");
    const source = createSourceVisiblePixelOriginDocument({
      subject: { kind: "revision", id: "rev_full" },
      armType: "slim",
      image,
    });
    const pixelIds = originPixelIds(source);
    const assignments = createCopiedPixelOriginAssignments({
      sourceDocument: source,
      mappings: pixelIds.map((pixelId) => ({ sourcePixelId: pixelId, targetPixelId: pixelId })),
      sourceComponentInstanceId: null,
    });

    expect(assignments).toHaveLength(pixelIds.length);
    expect(assignments.every((assignment) => assignment.copyLineage !== null)).toBe(true);
  });
});

function onePixelImage(): RgbaImage {
  const image = createRgbaImage(64, 64);
  setPixel(image, 8, 8, [1, 2, 3, 255]);
  return image;
}

function twoPixelImage(): RgbaImage {
  const image = onePixelImage();
  setPixel(image, 9, 8, [4, 5, 6, 255]);
  return image;
}

function cloneImage(image: RgbaImage): RgbaImage {
  return createRgbaImage(image.width, image.height, image.data.slice());
}

function fullUsedUvImage(armType: ArmType): RgbaImage {
  const image = createRgbaImage(64, 64);
  for (const surface of Object.values(getSkinLayout(armType).surfaces)) {
    const rect = surface.atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        setPixel(image, x, y, [x, y, (x + y) % 256, 255]);
      }
    }
  }
  return image;
}

function originPixelIds(document: PixelOriginDocument): number[] {
  return document.entries
    .flatMap((entry) =>
      entry.spans.flatMap((span) =>
        Array.from(
          { length: span.x1 - span.x0 + 1 },
          (_, index) => span.y * 64 + span.x0 + index,
        ),
      ),
    )
    .sort((left, right) => left - right);
}
