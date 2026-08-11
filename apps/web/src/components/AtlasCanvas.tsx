import {
  atlasToSurfaceModel,
  getSkinLayout,
  renderFaceContactSheet,
  scaleNearest,
  type ArmType,
  type RgbaImage,
} from "@mc-skin-split/skin-core";
import { useEffect, useMemo, useRef } from "react";

export type PixelView = "atlas" | "faces";

interface AtlasCanvasProps {
  readonly armType: ArmType;
  readonly image: RgbaImage;
  readonly skinName: string;
  readonly view: PixelView;
}

export function AtlasCanvas({
  armType,
  image,
  skinName,
  view,
}: AtlasCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendered = useMemo(() => {
    if (view === "atlas") {
      return scaleNearest(image, 16);
    }

    return renderFaceContactSheet(atlasToSurfaceModel(image, getSkinLayout(armType)), {
      scale: 4,
      padding: 2,
      gutter: 2,
    }).image;
  }, [armType, image, view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });

    if (!canvas || !context) {
      return;
    }

    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, rendered.width, rendered.height);
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(rendered.data),
        rendered.width,
        rendered.height,
      ),
      0,
      0,
    );
  }, [rendered]);

  const label =
    view === "atlas"
      ? `${skinName} 的 16 倍最近邻 UV Atlas`
      : `${skinName} 的 72 面语义 Contact Sheet`;

  return (
    <canvas
      ref={canvasRef}
      width={rendered.width}
      height={rendered.height}
      aria-label={label}
      data-pixel-view={view}
    />
  );
}
