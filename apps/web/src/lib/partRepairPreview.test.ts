import {
  createRgbaImage,
  encodeSkinPng,
  type RgbaImage,
} from "@mc-skin-split/skin-core";
import { describe, expect, it, vi } from "vitest";
import {
  createPartRepairPreview,
  derivePartRepairCommitGuard,
  ImmutablePartTextureCache,
  LatestPartRepairPreviewTask,
  PartRepairPreviewUrlStore,
} from "./partRepairPreview";

describe("component repair commit guard", () => {
  it("blocks unresolved and changed drafts but permits no operation or verified zero changes", () => {
    expect(derivePartRepairCommitGuard({
      hasConfiguredOperation: false,
      previewState: "committed",
    })).toEqual({
      blocked: false,
      hasPendingPixelChange: false,
      message: null,
    });
    expect(derivePartRepairCommitGuard({
      hasConfiguredOperation: true,
      previewState: "loading",
    })).toMatchObject({ blocked: true, hasPendingPixelChange: false });
    expect(derivePartRepairCommitGuard({
      hasConfiguredOperation: true,
      previewState: "error",
    })).toMatchObject({ blocked: true, hasPendingPixelChange: false });
    expect(derivePartRepairCommitGuard({
      hasConfiguredOperation: true,
      previewState: "ready",
      changedPixelCount: 3,
    })).toMatchObject({ blocked: true, hasPendingPixelChange: true });
    expect(derivePartRepairCommitGuard({
      hasConfiguredOperation: true,
      previewState: "ready",
      changedPixelCount: 0,
    })).toEqual({
      blocked: false,
      hasPendingPixelChange: false,
      message: null,
    });
  });
});

describe("component repair local preview", () => {
  it("applies a configured paint operation without mutating the revision texture", () => {
    const texture = emptyTexture();
    const result = createPartRepairPreview(
      { armType: "slim", texture },
      {
        type: "paint_color",
        spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 8 }],
        rgba: [214, 161, 123, 255],
      },
    );
    const pixelId = 8 * 64 + 8;

    expect(result.changedPixelIds).toEqual([pixelId]);
    expect(rgbaAt(result.texture, pixelId)).toEqual([214, 161, 123, 255]);
    expect(rgbaAt(result.mannequinTexture, pixelId)).toEqual([214, 161, 123, 255]);
    expect(rgbaAt(texture, pixelId)).toEqual([0, 0, 0, 0]);
  });

  it("resolves donor part references from the provided immutable source", () => {
    const donor = emptyTexture();
    donor.data.set([20, 40, 60, 255], (8 * 64 + 8) * 4);

    const result = createPartRepairPreview(
      { armType: "wide", texture: emptyTexture() },
      {
        type: "copy_surfaces",
        source: { kind: "part", partId: "part_donor" },
        mappings: [{
          sourceSurface: "head.base.front",
          targetSurface: "head.base.back",
        }],
      },
      { armType: "wide", texture: donor },
    );

    expect(result.changedPixelIds).toContain(8 * 64 + 24);
    expect(rgbaAt(result.texture, 8 * 64 + 24)).toEqual([20, 40, 60, 255]);
  });
});

describe("immutable preview texture cache", () => {
  it("calls the browser fetch API with its required global receiver", async () => {
    const encoded = encodeSkinPng(emptyTexture());
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(new Response(copyBuffer(encoded)));
    });
    vi.stubGlobal("fetch", browserFetch);

    try {
      const cache = new ImmutablePartTextureCache();
      await expect(cache.load("/browser-bound.png")).resolves.toMatchObject({
        width: 64,
        height: 64,
      });
      expect(browserFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches and decodes each immutable URL once", async () => {
    const encoded = encodeSkinPng(emptyTexture());
    const fetcher = vi.fn(async () => new Response(copyBuffer(encoded)));
    const cache = new ImmutablePartTextureCache(fetcher);

    const [first, second] = await Promise.all([
      cache.load("/revision-a.png"),
      cache.load("/revision-a.png"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("evicts rejected reads so a later attempt can retry", async () => {
    const encoded = encodeSkinPng(emptyTexture());
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(copyBuffer(encoded)));
    const cache = new ImmutablePartTextureCache(fetcher);

    await expect(cache.load("/retry.png")).rejects.toThrow("HTTP 503");
    await expect(cache.load("/retry.png")).resolves.toMatchObject({ width: 64, height: 64 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("preview request and URL lifetime", () => {
  it("marks an older async result stale after a newer configuration starts", async () => {
    const tasks = new LatestPartRepairPreviewTask();
    const first = deferred<number>();
    const second = deferred<number>();
    const firstResult = tasks.run(() => first.promise);
    const secondResult = tasks.run(() => second.promise);

    first.resolve(1);
    second.resolve(2);

    await expect(firstResult).resolves.toEqual({ status: "stale" });
    await expect(secondResult).resolves.toEqual({ status: "current", value: 2 });
  });

  it("revokes both prior preview blobs on replacement and unmount cleanup", () => {
    const revoked: string[] = [];
    let sequence = 0;
    const urls = new PartRepairPreviewUrlStore({
      createObjectURL: () => `blob:preview-${++sequence}`,
      revokeObjectURL: (url) => revoked.push(url),
    });
    const result = {
      texture: emptyTexture(),
      mannequinTexture: emptyTexture(),
      changedPixelIds: [1],
    };

    const first = urls.replace(result);
    const second = urls.replace(result);
    expect(revoked).toEqual([first.textureUrl, first.mannequinUrl]);

    urls.clear();
    expect(revoked).toEqual([
      first.textureUrl,
      first.mannequinUrl,
      second.textureUrl,
      second.mannequinUrl,
    ]);
  });
});

function emptyTexture(): RgbaImage {
  return createRgbaImage(64, 64);
}

function rgbaAt(image: RgbaImage, pixelId: number): readonly number[] {
  return [...image.data.subarray(pixelId * 4, pixelId * 4 + 4)];
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
