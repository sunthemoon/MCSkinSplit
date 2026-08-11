import type { ArmType } from "@mc-skin-split/skin-core";
import { useEffect, useRef, useState } from "react";
import {
  McSkinPreview,
  type McSkinPreviewState,
  type McSkinViewer,
} from "../lib/mcSkinPreview";

export type PreviewState = McSkinPreviewState;

interface SkinPreviewProps {
  armType: ArmType;
  skinUrl: string;
  onStateChange: (state: PreviewState, detail?: string) => void;
}

export function SkinPreview({ armType, skinUrl, onStateChange }: SkinPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<McSkinPreview | null>(null);
  const stateCallbackRef = useRef(onStateChange);
  const latestSkinRef = useRef({ armType, skinUrl });
  const [previewState, setPreviewState] = useState<PreviewState>("loading");

  useEffect(() => {
    stateCallbackRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;

    if (!canvas || !stage) {
      return undefined;
    }

    let cancelled = false;
    let localPreview: McSkinPreview | null = null;
    const reportState = (state: PreviewState, detail?: string) => {
      if (!cancelled) {
        setPreviewState(state);
        stateCallbackRef.current(state, detail);
      }
    };

    reportState("loading");
    void import("skinview3d")
      .then((skinview3d) => {
        if (cancelled) {
          return;
        }
        const compatibleAnimations = skinview3d as typeof skinview3d & {
          readonly RotatingAnimation?: unknown;
        };
        const preview = new McSkinPreview({
          canvas,
          stage,
          createViewer: (options) =>
            new skinview3d.SkinViewer(options) as unknown as McSkinViewer,
          animations: {
            WalkingAnimation: skinview3d.WalkingAnimation,
            RotatingAnimation: compatibleAnimations.RotatingAnimation,
          },
          onStateChange: reportState,
        });
        localPreview = preview;
        previewRef.current = preview;
        preview.initialize();
        const latest = latestSkinRef.current;
        return preview
          .loadSkin(latest.skinUrl, latest.armType)
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          localPreview?.dispose();
          if (previewRef.current === localPreview) {
            previewRef.current = null;
          }
          const detail = error instanceof Error ? error.message : String(error);
          reportState("error", detail);
        }
      });

    return () => {
      cancelled = true;
      if (previewRef.current === localPreview) {
        previewRef.current = null;
      }
      localPreview?.dispose();
    };
  }, []);

  useEffect(() => {
    latestSkinRef.current = { armType, skinUrl };
    void previewRef.current?.loadSkin(skinUrl, armType).catch(() => undefined);
  }, [armType, skinUrl]);

  return (
    <div
      className="skin-stage"
      ref={stageRef}
      data-state={previewState}
      aria-busy={previewState === "loading"}
    >
      <canvas ref={canvasRef} aria-label="Minecraft 皮肤三维预览" />
    </div>
  );
}
