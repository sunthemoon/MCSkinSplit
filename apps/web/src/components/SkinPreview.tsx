import { useEffect, useRef } from "react";
import { SkinViewer, WalkingAnimation } from "skinview3d";
import type { ArmType } from "@mc-skin-split/skin-core";

export type PreviewState = "loading" | "ready" | "error";

interface SkinPreviewProps {
  armType: ArmType;
  skinUrl: string;
  onStateChange: (state: PreviewState, detail?: string) => void;
}

export function SkinPreview({ armType, skinUrl, onStateChange }: SkinPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const stateCallbackRef = useRef(onStateChange);

  useEffect(() => {
    stateCallbackRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;

    if (!canvas || !stage) {
      return undefined;
    }

    const viewer = new SkinViewer({
      canvas,
      width: Math.max(240, Math.round(stage.clientWidth)),
      height: Math.max(360, Math.round(stage.clientHeight)),
    });

    viewer.zoom = 0.82;
    viewer.autoRotate = true;
    viewer.animation = new WalkingAnimation();
    viewer.animation.speed = 0.75;
    viewerRef.current = viewer;

    const resize = () => {
      viewer.width = Math.max(240, Math.round(stage.clientWidth));
      viewer.height = Math.max(360, Math.round(stage.clientHeight));
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);

    return () => {
      resizeObserver.disconnect();
      viewerRef.current = null;
      viewer.dispose();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;

    if (!viewer) {
      return undefined;
    }

    let cancelled = false;
    stateCallbackRef.current("loading");

    void viewer
      .loadSkin(skinUrl, { model: armType === "wide" ? "default" : "slim" })
      .then(() => {
        if (!cancelled) {
          stateCallbackRef.current("ready");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const detail = error instanceof Error ? error.message : String(error);
          stateCallbackRef.current("error", detail);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [armType, skinUrl]);

  return (
    <div className="skin-stage" ref={stageRef}>
      <canvas ref={canvasRef} aria-label="Minecraft 皮肤三维预览" />
    </div>
  );
}
