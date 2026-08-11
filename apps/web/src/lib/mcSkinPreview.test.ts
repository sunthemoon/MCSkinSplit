import { describe, expect, it, vi } from "vitest";
import {
  applyViewerMotion,
  McSkinPreview,
  type McSkinPreviewState,
  type McSkinResizeObserver,
  type McSkinViewer,
} from "./mcSkinPreview";

class WalkingAnimation {
  speed = 0;
}

class RotatingAnimation {}

describe("McSkinPreview", () => {
  it("initializes and disposes exactly one modern viewer", () => {
    const fixture = createFixture({ modernAnimation: true });

    const first = fixture.preview.initialize();
    const second = fixture.preview.initialize();

    expect(first).toBe(second);
    expect(fixture.createViewer).toHaveBeenCalledOnce();
    expect(fixture.observer.observe).toHaveBeenCalledOnce();
    expect(fixture.viewer).toMatchObject({
      width: 320,
      height: 460,
      zoom: 0.82,
      autoRotate: true,
    });
    expect(fixture.viewer.animation).toBeInstanceOf(WalkingAnimation);
    expect(fixture.viewer.animation?.speed).toBe(0.75);

    fixture.preview.dispose();
    fixture.preview.dispose();
    expect(fixture.observer.disconnect).toHaveBeenCalledOnce();
    expect(fixture.disposeViewer).toHaveBeenCalledOnce();
    expect(() => fixture.preview.initialize()).toThrow("McSkinPreview 已销毁");
  });

  it("uses only the legacy animation collection when modern animation is absent", () => {
    const add = vi.fn();
    const { viewer } = makeViewer({ animations: { add } });

    applyViewerMotion(viewer, {
      WalkingAnimation,
      RotatingAnimation,
    });

    expect(add.mock.calls).toEqual([
      [WalkingAnimation],
      [RotatingAnimation],
    ]);
    expect(viewer.autoRotate).toBeUndefined();
  });

  it("serializes loads so the newest Revision becomes ready", async () => {
    const fixture = createFixture({ modernAnimation: true });
    const firstLoad = deferred<void>();
    const secondLoad = deferred<void>();
    fixture.loadSkin
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => secondLoad.promise);
    fixture.preview.initialize();

    const first = fixture.preview.loadSkin("blob:first", "slim");
    await vi.waitFor(() => expect(fixture.loadSkin).toHaveBeenCalledOnce());
    const second = fixture.preview.loadSkin("blob:second", "wide");
    firstLoad.resolve();
    await first;
    await vi.waitFor(() =>
      expect(fixture.loadSkin).toHaveBeenCalledTimes(2),
    );
    secondLoad.resolve();
    await second;

    expect(fixture.loadSkin.mock.calls).toEqual([
      ["blob:first", { model: "slim" }],
      ["blob:second", { model: "default" }],
    ]);
    expect(fixture.states).toEqual([
      ["loading", undefined],
      ["loading", undefined],
      ["ready", undefined],
    ]);
    expect(fixture.createViewer).toHaveBeenCalledOnce();
  });

  it("reports a texture error without disposing the viewer and can recover", async () => {
    const fixture = createFixture({ modernAnimation: true });
    fixture.loadSkin
      .mockRejectedValueOnce(new Error("texture unavailable"))
      .mockResolvedValueOnce(undefined);
    fixture.preview.initialize();

    await expect(
      fixture.preview.loadSkin("blob:bad", "slim"),
    ).rejects.toThrow("texture unavailable");
    await expect(
      fixture.preview.loadSkin("blob:good", "slim"),
    ).resolves.toBeUndefined();

    expect(fixture.disposeViewer).not.toHaveBeenCalled();
    expect(fixture.states).toEqual([
      ["loading", undefined],
      ["error", "texture unavailable"],
      ["loading", undefined],
      ["ready", undefined],
    ]);
  });

  it("coalesces ResizeObserver updates into one animation frame", () => {
    const fixture = createFixture({ modernAnimation: true });
    fixture.preview.initialize();

    fixture.notifyResize(100, 180);
    fixture.notifyResize(422.4, 511.7);
    expect(fixture.scheduleFrame).toHaveBeenCalledOnce();
    expect(fixture.viewer).toMatchObject({ width: 320, height: 460 });

    fixture.runScheduledFrame();
    expect(fixture.viewer).toMatchObject({ width: 422, height: 512 });

    fixture.notifyResize(500, 620);
    fixture.preview.dispose();
    expect(fixture.cancelFrame).toHaveBeenCalledWith(2);
    expect(fixture.viewer).toMatchObject({ width: 422, height: 512 });
  });
});

function createFixture(options: { readonly modernAnimation: boolean }) {
  const stage = {
    clientWidth: 320,
    clientHeight: 460,
  } as HTMLElement;
  const canvas = {} as HTMLCanvasElement;
  const viewerFixture = makeViewer(
    options.modernAnimation ? { animation: null } : {},
  );
  const viewer = viewerFixture.viewer;
  const createViewer = vi.fn(
    (viewerOptions: { readonly width: number; readonly height: number }) => {
      viewer.width = viewerOptions.width;
      viewer.height = viewerOptions.height;
      return viewer;
    },
  );
  const observe = vi.fn<(target: Element) => void>();
  const disconnect = vi.fn<() => void>();
  const observer: McSkinResizeObserver = {
    observe,
    disconnect,
  };
  let resizeCallback: ResizeObserverCallback | null = null;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const scheduleFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => {
    frames.delete(id);
  });
  const states: Array<[McSkinPreviewState, string | undefined]> = [];
  const preview = new McSkinPreview({
    canvas,
    stage,
    createViewer,
    animations: { WalkingAnimation, RotatingAnimation },
    createResizeObserver: (callback) => {
      resizeCallback = callback;
      return observer;
    },
    scheduleFrame,
    cancelFrame,
    onStateChange: (state, detail) => states.push([state, detail]),
  });

  return {
    preview,
    viewer,
    loadSkin: viewerFixture.loadSkin,
    disposeViewer: viewerFixture.dispose,
    createViewer,
    observer: { observe, disconnect },
    states,
    scheduleFrame,
    cancelFrame,
    notifyResize(width: number, height: number) {
      if (!resizeCallback) {
        throw new Error("ResizeObserver 尚未创建");
      }
      resizeCallback(
        [
          {
            target: stage,
            contentRect: { width, height },
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    },
    runScheduledFrame() {
      const entry = frames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!entry) {
        throw new Error("没有待执行的 animation frame");
      }
      frames.delete(entry[0]);
      entry[1](0);
    },
  };
}

function makeViewer(
  additions: Partial<McSkinViewer> = {},
): {
  readonly viewer: McSkinViewer;
  readonly loadSkin: ReturnType<
    typeof vi.fn<McSkinViewer["loadSkin"]>
  >;
  readonly dispose: ReturnType<typeof vi.fn<() => void>>;
} {
  const loadSkin = vi
    .fn<McSkinViewer["loadSkin"]>()
    .mockResolvedValue(undefined);
  const dispose = vi.fn<() => void>();
  const viewer: McSkinViewer = {
    width: 0,
    height: 0,
    zoom: 0,
    loadSkin,
    dispose,
    ...additions,
  };
  return { viewer, loadSkin, dispose };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
