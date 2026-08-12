import {
  applyPartRepairOperation,
  createPartMannequinTexture,
  decodeSkinPng,
  derivePartWriteMask,
  encodeSkinPng,
  type ArmType,
  type PartRepairOperation,
  type PartRepairState,
  type RgbaImage,
} from "@mc-skin-split/skin-core";
import type { ApiPartEditOperation } from "./revisionApi";

export interface PartRepairPreviewSource {
  readonly armType: ArmType;
  readonly texture: RgbaImage;
}

export interface PartRepairPreviewResult {
  readonly changedPixelIds: readonly number[];
  readonly mannequinTexture: RgbaImage;
  readonly texture: RgbaImage;
}

export interface PartRepairPreviewUrls {
  readonly changedPixelIds: readonly number[];
  readonly mannequinUrl: string;
  readonly textureUrl: string;
}

export type PartRepairDraftPreviewState =
  | "committed"
  | "loading"
  | "ready"
  | "error";

export interface PartRepairCommitGuard {
  readonly blocked: boolean;
  readonly hasPendingPixelChange: boolean;
  readonly message: string | null;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ObjectUrlApi {
  createObjectURL(object: Blob): string;
  revokeObjectURL(url: string): void;
}

export type LatestPartRepairPreviewResult<T> =
  | { readonly status: "current"; readonly value: T }
  | { readonly status: "stale" };

/** Discards completed work when a newer draft configuration has taken over. */
export class LatestPartRepairPreviewTask {
  #generation = 0;

  async run<T>(
    task: () => Promise<T>,
  ): Promise<LatestPartRepairPreviewResult<T>> {
    const generation = ++this.#generation;
    try {
      const value = await task();
      return generation === this.#generation
        ? { status: "current", value }
        : { status: "stale" };
    } catch (error) {
      if (generation !== this.#generation) {
        return { status: "stale" };
      }
      throw error;
    }
  }

  invalidate(): void {
    this.#generation += 1;
  }
}

/**
 * Prevents committing the persisted head while the visible local draft is
 * different or has not yet been proven to be a zero-change operation.
 */
export function derivePartRepairCommitGuard(input: {
  readonly hasConfiguredOperation: boolean;
  readonly previewState: PartRepairDraftPreviewState;
  readonly changedPixelCount?: number;
}): PartRepairCommitGuard {
  if (!input.hasConfiguredOperation) {
    return { blocked: false, hasPendingPixelChange: false, message: null };
  }
  if (input.previewState === "ready" && input.changedPixelCount === 0) {
    return { blocked: false, hasPendingPixelChange: false, message: null };
  }
  if (
    input.previewState === "ready"
    && input.changedPixelCount !== undefined
    && input.changedPixelCount > 0
  ) {
    return {
      blocked: true,
      hasPendingPixelChange: true,
      message: `有 ${input.changedPixelCount} px 尚未写入 Revision；请先应用为新 Revision。`,
    };
  }
  return {
    blocked: true,
    hasPendingPixelChange: false,
    message: input.previewState === "error"
      ? "草稿预览未确认；请先修正并应用为新 Revision。"
      : "草稿尚未写入 Revision；请先应用为新 Revision。",
  };
}

/**
 * Applies the configured repair operation to in-memory pixels only. API source
 * references are resolved by the caller from immutable texture URLs.
 */
export function createPartRepairPreview(
  target: PartRepairPreviewSource,
  operation: ApiPartEditOperation,
  donor?: PartRepairPreviewSource,
): PartRepairPreviewResult {
  const targetState = createRepairState(target);
  const resolvedOperation: PartRepairOperation = operation.type === "copy_surfaces"
    ? {
        type: "copy_surfaces",
        source: operation.source.kind === "edit_revision"
          ? targetState
          : createRepairState(requireDonor(donor)),
        mappings: operation.mappings,
        ...(operation.overwrite ? { overwrite: operation.overwrite } : {}),
      }
    : operation;
  const result = applyPartRepairOperation(targetState, resolvedOperation);
  return {
    texture: result.texture,
    mannequinTexture: createPartMannequinTexture(
      result.texture,
      result.writeMask,
      result.armType,
    ),
    changedPixelIds: result.changedPixelIds,
  };
}

/** Caches decoded immutable part/revision textures and retries failed reads. */
export class ImmutablePartTextureCache {
  readonly #entries = new Map<string, Promise<RgbaImage>>();
  readonly #fetcher: Fetcher;

  constructor(
    fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
  ) {
    this.#fetcher = fetcher;
  }

  load(url: string): Promise<RgbaImage> {
    const cached = this.#entries.get(url);
    if (cached) return cached;

    const pending = this.#fetcher(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`组件预览纹理读取失败：HTTP ${response.status}`);
        }
        return decodeSkinPng(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        if (this.#entries.get(url) === pending) {
          this.#entries.delete(url);
        }
        throw error;
      });
    this.#entries.set(url, pending);
    return pending;
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Owns both generated URLs so stale preview blobs are always revoked together. */
export class PartRepairPreviewUrlStore {
  readonly #urlApi: ObjectUrlApi;
  #current: PartRepairPreviewUrls | null = null;

  constructor(urlApi: ObjectUrlApi = URL) {
    this.#urlApi = urlApi;
  }

  replace(result: PartRepairPreviewResult): PartRepairPreviewUrls {
    const next = {
      textureUrl: this.#createPngUrl(result.texture),
      mannequinUrl: this.#createPngUrl(result.mannequinTexture),
      changedPixelIds: result.changedPixelIds,
    };
    const previous = this.#current;
    this.#current = next;
    if (previous) this.#revoke(previous);
    return next;
  }

  clear(): void {
    if (!this.#current) return;
    this.#revoke(this.#current);
    this.#current = null;
  }

  #createPngUrl(image: RgbaImage): string {
    const encoded = encodeSkinPng(image);
    const bytes = new Uint8Array(encoded.byteLength);
    bytes.set(encoded);
    return this.#urlApi.createObjectURL(
      new Blob([bytes.buffer], { type: "image/png" }),
    );
  }

  #revoke(urls: PartRepairPreviewUrls): void {
    this.#urlApi.revokeObjectURL(urls.textureUrl);
    this.#urlApi.revokeObjectURL(urls.mannequinUrl);
  }
}

function createRepairState(source: PartRepairPreviewSource): PartRepairState {
  return {
    armType: source.armType,
    texture: source.texture,
    writeMask: derivePartWriteMask(source.texture, source.armType),
  };
}

function requireDonor(
  source: PartRepairPreviewSource | undefined,
): PartRepairPreviewSource {
  if (!source) {
    throw new Error("组件借色预览缺少来源纹理");
  }
  return source;
}
