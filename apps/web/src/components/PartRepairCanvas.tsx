import {
  createUsedUvMask,
  getSkinLayout,
  type ArmType,
} from "@mc-skin-split/skin-core";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { repairCanvasPointToPixelId } from "../lib/partRepairCoordinates";

const ATLAS_SIZE = 64;
const RENDER_SCALE = 16;

interface PartRepairCanvasProps {
  readonly armType: ArmType;
  readonly disabled?: boolean;
  readonly selectedPixelIds: readonly number[];
  readonly textureUrl: string;
  readonly onSelectionChange: (pixelIds: readonly number[]) => void;
}

export function PartRepairCanvas({
  armType,
  disabled = false,
  selectedPixelIds,
  textureUrl,
  onSelectionChange,
}: PartRepairCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionRef = useRef(new Set(selectedPixelIds));
  const dragModeRef = useRef<"add" | "remove">("add");
  const validUv = useMemo(
    () => createUsedUvMask(getSkinLayout(armType)),
    [armType],
  );

  useEffect(() => {
    selectionRef.current = new Set(selectedPixelIds);
  }, [selectedPixelIds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.width = ATLAS_SIZE * RENDER_SCALE;
    canvas.height = ATLAS_SIZE * RENDER_SCALE;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    let cancelled = false;
    const image = new Image();
    const draw = () => {
      if (cancelled) return;
      context.imageSmoothingEnabled = false;
      drawCheckerboard(context);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      context.fillStyle = "rgba(36, 195, 194, 0.1)";
      for (let pixelId = 0; pixelId < validUv.length; pixelId += 1) {
        if (validUv[pixelId] !== 0) fillPixel(context, pixelId);
      }

      context.fillStyle = "rgba(227, 108, 61, 0.72)";
      for (const pixelId of selectedPixelIds) fillPixel(context, pixelId);

      drawGrid(context);
    };
    image.onload = draw;
    image.onerror = () => {
      if (cancelled) return;
      drawCheckerboard(context);
      drawGrid(context);
    };
    image.src = textureUrl;
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [selectedPixelIds, textureUrl, validUv]);

  const updateFromPointer = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    forceMode?: "add" | "remove",
  ) => {
    if (disabled) return;
    const pixelId = repairCanvasPointToPixelId(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      armType,
    );
    if (pixelId === null) return;
    const selection = new Set(selectionRef.current);
    if ((forceMode ?? dragModeRef.current) === "add") {
      selection.add(pixelId);
    } else {
      selection.delete(pixelId);
    }
    selectionRef.current = selection;
    onSelectionChange([...selection].sort((left, right) => left - right));
  };

  return (
    <canvas
      ref={canvasRef}
      className="part-repair-canvas"
      aria-label={`部件修补像素画布，已选择 ${selectedPixelIds.length} 个有效 UV 像素`}
      data-disabled={disabled}
      onPointerDown={(event) => {
        if (disabled) return;
        const pixelId = repairCanvasPointToPixelId(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
          armType,
        );
        dragModeRef.current =
          pixelId !== null && selectionRef.current.has(pixelId)
            ? "remove"
            : "add";
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event, dragModeRef.current);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          updateFromPointer(event);
        }
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    />
  );
}

function drawCheckerboard(context: CanvasRenderingContext2D): void {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  for (let y = 0; y < ATLAS_SIZE; y += 1) {
    for (let x = 0; x < ATLAS_SIZE; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? "#252f34" : "#303d42";
      context.fillRect(
        x * RENDER_SCALE,
        y * RENDER_SCALE,
        RENDER_SCALE,
        RENDER_SCALE,
      );
    }
  }
}

function drawGrid(context: CanvasRenderingContext2D): void {
  context.strokeStyle = "rgba(244, 240, 228, 0.14)";
  context.lineWidth = 1;
  context.beginPath();
  for (
    let coordinate = RENDER_SCALE;
    coordinate < context.canvas.width;
    coordinate += RENDER_SCALE
  ) {
    context.moveTo(coordinate + 0.5, 0);
    context.lineTo(coordinate + 0.5, context.canvas.height);
    context.moveTo(0, coordinate + 0.5);
    context.lineTo(context.canvas.width, coordinate + 0.5);
  }
  context.stroke();
}

function fillPixel(context: CanvasRenderingContext2D, pixelId: number): void {
  context.fillRect(
    (pixelId % ATLAS_SIZE) * RENDER_SCALE,
    Math.floor(pixelId / ATLAS_SIZE) * RENDER_SCALE,
    RENDER_SCALE,
    RENDER_SCALE,
  );
}
