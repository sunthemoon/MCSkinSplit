import type { Page } from "@playwright/test";

export interface BlobUrlSnapshot {
  readonly created: readonly string[];
  readonly revoked: readonly string[];
  readonly live: readonly string[];
  readonly unknownRevocations: readonly string[];
}

export async function installBlobUrlTracker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    const created: string[] = [];
    const revoked: string[] = [];
    const live = new Set<string>();
    const unknownRevocations: string[] = [];

    Object.defineProperty(window, "__mcSkinSplitBlobUrls", {
      configurable: false,
      enumerable: false,
      value: { created, revoked, live, unknownRevocations },
      writable: false,
    });
    URL.createObjectURL = (object: Blob | MediaSource): string => {
      const url = originalCreate(object);
      created.push(url);
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string): void => {
      if (!live.delete(url)) unknownRevocations.push(url);
      revoked.push(url);
      originalRevoke(url);
    };
  });
}

export async function readBlobUrlSnapshot(page: Page): Promise<BlobUrlSnapshot> {
  return page.evaluate(() => {
    const tracker = (
      window as Window & {
        __mcSkinSplitBlobUrls?: {
          created: string[];
          revoked: string[];
          live: Set<string>;
          unknownRevocations: string[];
        };
      }
    ).__mcSkinSplitBlobUrls;
    if (!tracker) throw new Error("Blob URL tracker was not installed");
    return {
      created: [...tracker.created],
      revoked: [...tracker.revoked],
      live: [...tracker.live],
      unknownRevocations: [...tracker.unknownRevocations],
    };
  });
}
