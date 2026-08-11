import {
  getSkinLayout,
  spansToPixelIds,
  type ArmType,
  type RgbaImage,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { canvasPointToPixelId } from "../lib/semanticCanvasCoordinates";

const ATLAS_SIZE = 64;
const RENDER_SCALE = 16;

interface SemanticEditorCanvasProps {
  readonly activeComponentId?: string;
  readonly armType: ArmType;
  readonly components: readonly SemanticComponent[];
  readonly disabled?: boolean;
  readonly image: RgbaImage;
  readonly selectedPixelIds: readonly number[];
  readonly onSelectionChange: (pixelIds: readonly number[]) => void;
}

export function SemanticEditorCanvas({
  activeComponentId,
  armType,
  components,
  disabled = false,
  image,
  selectedPixelIds,
  onSelectionChange,
}: SemanticEditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionRef = useRef(new Set(selectedPixelIds));
  const dragModeRef = useRef<"add" | "remove">("add");
  const usedPixelIds = useMemo(() => usedPixelSet(armType), [armType]);

  useEffect(() => {
    selectionRef.current = new Set(selectedPixelIds);
  }, [selectedPixelIds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.width = ATLAS_SIZE * RENDER_SCALE;
    canvas.height = ATLAS_SIZE * RENDER_SCALE;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const source = document.createElement("canvas");
    source.width = ATLAS_SIZE;
    source.height = ATLAS_SIZE;
    const sourceContext = source.getContext("2d");
    if (!sourceContext) {
      return;
    }
    sourceContext.putImageData(
      new ImageData(new Uint8ClampedArray(image.data), ATLAS_SIZE, ATLAS_SIZE),
      0,
      0,
    );
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    for (const [index, component] of components.entries()) {
      const color = componentColor(component.instanceId, index);
      context.fillStyle = color;
      context.globalAlpha =
        component.instanceId === activeComponentId ? 0.55 : 0.28;
      for (const pixelId of spansToPixelIds(
        component.spans,
        getSkinLayout(armType),
      )) {
        fillPixel(context, pixelId);
      }
    }

    context.globalAlpha = 0.68;
    context.fillStyle = "#24c3c2";
    for (const pixelId of selectedPixelIds) {
      fillPixel(context, pixelId);
    }
    context.globalAlpha = 1;

    context.strokeStyle = "rgba(244, 240, 228, 0.16)";
    context.lineWidth = 1;
    context.beginPath();
    for (let coordinate = RENDER_SCALE; coordinate < canvas.width; coordinate += RENDER_SCALE) {
      context.moveTo(coordinate + 0.5, 0);
      context.lineTo(coordinate + 0.5, canvas.height);
      context.moveTo(0, coordinate + 0.5);
      context.lineTo(canvas.width, coordinate + 0.5);
    }
    context.stroke();
  }, [activeComponentId, armType, components, image, selectedPixelIds]);

  const updateFromPointer = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    forceMode?: "add" | "remove",
  ) => {
    if (disabled) {
      return;
    }
    const pixelId = canvasPointToPixelId(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    if (
      pixelId === null ||
      !usedPixelIds.has(pixelId) ||
      image.data[pixelId * 4 + 3] === 0
    ) {
      return;
    }
    const selection = new Set(selectionRef.current);
    const mode = forceMode ?? dragModeRef.current;
    if (mode === "add") {
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
      className="semantic-canvas"
      aria-label={`语义像素编辑器，已选择 ${selectedPixelIds.length} 个像素`}
      data-disabled={disabled}
      onPointerDown={(event) => {
        if (disabled) {
          return;
        }
        const pixelId = canvasPointToPixelId(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
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

function fillPixel(context: CanvasRenderingContext2D, pixelId: number): void {
  const x = pixelId % ATLAS_SIZE;
  const y = Math.floor(pixelId / ATLAS_SIZE);
  context.fillRect(
    x * RENDER_SCALE,
    y * RENDER_SCALE,
    RENDER_SCALE,
    RENDER_SCALE,
  );
}

function usedPixelSet(armType: ArmType): ReadonlySet<number> {
  const layout = getSkinLayout(armType);
  const pixelIds = new Set<number>();
  for (const surface of Object.values(layout.surfaces)) {
    const rect = surface.atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        pixelIds.add(y * ATLAS_SIZE + x);
      }
    }
  }
  return pixelIds;
}

function componentColor(instanceId: string, index: number): string {
  let hash = index * 47;
  for (const character of instanceId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 360;
  }
  return `hsl(${hash} 72% 52%)`;
}
