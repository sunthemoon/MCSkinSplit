import type { ArmType } from "@mc-skin-split/skin-core";

export type McSkinPreviewState = "loading" | "ready" | "error";

export interface McSkinAnimation {
  speed?: number;
}

export interface McSkinAnimationConstructor {
  new (): McSkinAnimation;
}

export interface McSkinAnimationLibrary {
  readonly WalkingAnimation: McSkinAnimationConstructor;
  readonly RotatingAnimation?: unknown;
}

export interface McSkinViewer {
  width: number;
  height: number;
  zoom: number;
  autoRotate?: boolean;
  animation?: McSkinAnimation | null;
  animations?: {
    add(animation: unknown): unknown;
  };
  loadSkin(
    source: string,
    options: { readonly model: "default" | "slim" },
  ): Promise<unknown>;
  dispose(): void;
}

export interface McSkinViewerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
}

export interface McSkinResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

export interface McSkinPreviewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly stage: HTMLElement;
  readonly createViewer: (options: McSkinViewerOptions) => McSkinViewer;
  readonly animations: McSkinAnimationLibrary;
  readonly createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => McSkinResizeObserver;
  readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly onStateChange?: (
    state: McSkinPreviewState,
    detail?: string,
  ) => void;
}

const MIN_WIDTH = 150;
const MIN_HEIGHT = 200;

export class McSkinPreview {
  private readonly options: McSkinPreviewOptions;
  private viewer: McSkinViewer | null = null;
  private resizeObserver: McSkinResizeObserver | null = null;
  private resizeFrame: number | null = null;
  private pendingSize: { readonly width: number; readonly height: number } | null =
    null;
  private loadGeneration = 0;
  private loadQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: McSkinPreviewOptions) {
    this.options = options;
  }

  initialize(): McSkinViewer {
    if (this.disposed) {
      throw new Error("McSkinPreview 已销毁");
    }
    if (this.viewer) {
      return this.viewer;
    }

    const size = measureStage(this.options.stage);
    const viewer = this.options.createViewer({
      canvas: this.options.canvas,
      width: size.width,
      height: size.height,
    });
    this.viewer = viewer;
    viewer.zoom = 0.82;
    applyViewerMotion(viewer, this.options.animations);

    const createObserver =
      this.options.createResizeObserver ??
      ((callback: ResizeObserverCallback) => new ResizeObserver(callback));
    this.resizeObserver = createObserver((entries) => this.queueResize(entries));
    this.resizeObserver.observe(this.options.stage);
    return viewer;
  }

  getViewer(): McSkinViewer | null {
    return this.viewer;
  }

  loadSkin(source: string, armType: ArmType): Promise<void> {
    const viewer = this.viewer;
    if (!viewer || this.disposed) {
      return Promise.reject(new Error("McSkinPreview 尚未初始化"));
    }

    const generation = ++this.loadGeneration;
    this.options.onStateChange?.("loading");
    const run = async () => {
      if (this.disposed || generation !== this.loadGeneration) {
        return;
      }

      try {
        await viewer.loadSkin(source, {
          model: armType === "wide" ? "default" : "slim",
        });
        if (!this.disposed && generation === this.loadGeneration) {
          this.options.onStateChange?.("ready");
        }
      } catch (error) {
        if (!this.disposed && generation === this.loadGeneration) {
          const detail = error instanceof Error ? error.message : String(error);
          this.options.onStateChange?.("error", detail);
        }
        throw error;
      }
    };

    const scheduled = this.loadQueue.catch(() => undefined).then(run);
    this.loadQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.loadGeneration += 1;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.resizeFrame !== null) {
      this.cancelFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    this.pendingSize = null;

    this.viewer?.dispose();
    this.viewer = null;
  }

  private queueResize(entries: readonly ResizeObserverEntry[]): void {
    if (this.disposed || !this.viewer) {
      return;
    }

    const observedEntry = entries.find(
      (entry) => entry.target === this.options.stage,
    );
    const width = observedEntry?.contentRect.width ?? this.options.stage.clientWidth;
    const height =
      observedEntry?.contentRect.height ?? this.options.stage.clientHeight;
    this.pendingSize = normalizeSize(width, height);

    if (this.resizeFrame !== null) {
      return;
    }
    this.resizeFrame = this.scheduleFrame(() => {
      this.resizeFrame = null;
      const size = this.pendingSize;
      this.pendingSize = null;
      const viewer = this.viewer;
      if (!size || !viewer || this.disposed) {
        return;
      }
      if (viewer.width !== size.width) {
        viewer.width = size.width;
      }
      if (viewer.height !== size.height) {
        viewer.height = size.height;
      }
    });
  }

  private scheduleFrame(callback: FrameRequestCallback): number {
    return (this.options.scheduleFrame ?? requestAnimationFrame)(callback);
  }

  private cancelFrame(handle: number): void {
    (this.options.cancelFrame ?? cancelAnimationFrame)(handle);
  }
}

export function applyViewerMotion(
  viewer: McSkinViewer,
  animations: McSkinAnimationLibrary,
): void {
  if ("animation" in viewer) {
    const walking = new animations.WalkingAnimation();
    walking.speed = 0.75;
    viewer.animation = walking;
    viewer.autoRotate = true;
    return;
  }

  if (viewer.animations?.add) {
    viewer.animations.add(animations.WalkingAnimation);
    if (animations.RotatingAnimation) {
      viewer.animations.add(animations.RotatingAnimation);
    }
  }
}

function measureStage(stage: HTMLElement): {
  readonly width: number;
  readonly height: number;
} {
  return normalizeSize(stage.clientWidth, stage.clientHeight);
}

function normalizeSize(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } {
  return {
    width: Math.max(MIN_WIDTH, Math.round(width)),
    height: Math.max(MIN_HEIGHT, Math.round(height)),
  };
}
