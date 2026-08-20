import {
  getSkinLayout,
  spansToPixelIds,
  type ArmType,
  type RgbaImage,
  type SemanticComponent,
} from "@mc-skin-split/skin-core";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { canvasPointToPixelId } from "../lib/semanticCanvasCoordinates";
import {
  applySelectionPixels,
  connectedExactColorPixelIds,
  rectangleSelectionPixelIds,
  surfaceSelectionPixelIds,
  visibleUsedPixelIds,
  type SemanticCanvasViewMode,
  type SemanticSelectionTool,
} from "../lib/semanticSelectionTools";

const ATLAS_SIZE = 64;
const RENDER_SCALE = 16;

export interface SemanticEditorCanvasProps {
  readonly activeComponentId?: string;
  readonly armType: ArmType;
  readonly components: readonly SemanticComponent[];
  readonly disabled?: boolean;
  readonly diffPixelIds?: readonly number[];
  readonly hiddenComponentIds?: readonly string[];
  readonly image: RgbaImage;
  readonly previewPixelIds?: readonly number[];
  readonly selectedPixelIds: readonly number[];
  readonly selectionTool?: SemanticSelectionTool;
  readonly soloComponentId?: string | null;
  readonly viewMode?: SemanticCanvasViewMode;
  readonly onSelectionChange: (pixelIds: readonly number[]) => void;
}

export function SemanticEditorCanvas({
  activeComponentId,
  armType,
  components,
  disabled = false,
  diffPixelIds = [],
  hiddenComponentIds = [],
  image,
  previewPixelIds = [],
  selectedPixelIds,
  selectionTool = "brush",
  soloComponentId = null,
  viewMode = "texture",
  onSelectionChange,
}: SemanticEditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionRef = useRef(new Set(selectedPixelIds));
  const dragModeRef = useRef<"add" | "remove">("add");
  const rectangleStartRef = useRef<number | null>(null);
  const [rectangleEndPixelId, setRectangleEndPixelId] = useState<number | null>(null);
  const [cursorPixelId, setCursorPixelId] = useState<number | null>(null);
  const usedPixelIds = useMemo(
    () => new Set(visibleUsedPixelIds(image, armType)),
    [armType, image],
  );
  const hiddenSet = useMemo(
    () => new Set(hiddenComponentIds),
    [hiddenComponentIds],
  );
  const rectanglePreviewPixelIds = useMemo(() => {
    const start = rectangleStartRef.current;
    return start === null || rectangleEndPixelId === null
      ? []
      : rectangleSelectionPixelIds(image, armType, start, rectangleEndPixelId);
  }, [armType, image, rectangleEndPixelId]);

  useEffect(() => {
    selectionRef.current = new Set(selectedPixelIds);
  }, [selectedPixelIds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = ATLAS_SIZE * RENDER_SCALE;
    canvas.height = ATLAS_SIZE * RENDER_SCALE;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (viewMode === "texture") {
      drawTexture(context, image);
    } else {
      context.fillStyle = "#d8d4c9";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgba(24, 33, 38, 0.16)";
      for (const pixelId of usedPixelIds) fillPixel(context, pixelId);
    }

    for (const [index, component] of components.entries()) {
      if (
        hiddenSet.has(component.instanceId) ||
        (soloComponentId && component.instanceId !== soloComponentId)
      ) {
        continue;
      }
      context.fillStyle = viewMode === "category"
        ? categoryColor(component.category)
        : componentColor(component.instanceId, index);
      context.globalAlpha = viewMode === "texture"
        ? (component.instanceId === activeComponentId ? 0.55 : 0.28)
        : (component.instanceId === activeComponentId ? 0.92 : 0.72);
      for (const pixelId of spansToPixelIds(
        component.spans,
        getSkinLayout(armType),
      )) {
        fillPixel(context, pixelId);
      }
    }

    context.globalAlpha = 0.42;
    context.fillStyle = "#ffd447";
    for (const pixelId of diffPixelIds) fillPixel(context, pixelId);
    context.globalAlpha = 1;
    context.strokeStyle = "#8f3d15";
    context.lineWidth = 2;
    for (const pixelId of diffPixelIds) strokePixel(context, pixelId);

    context.globalAlpha = 0.68;
    context.fillStyle = "#24c3c2";
    for (const pixelId of selectedPixelIds) fillPixel(context, pixelId);

    context.globalAlpha = 0.56;
    context.fillStyle = "#e36c3d";
    for (const pixelId of [...previewPixelIds, ...rectanglePreviewPixelIds]) {
      fillPixel(context, pixelId);
    }
    context.globalAlpha = 1;

    drawGrid(context, canvas.width, canvas.height);
    if (cursorPixelId !== null) {
      context.strokeStyle = usedPixelIds.has(cursorPixelId) ? "#ffffff" : "#e36c3d";
      context.lineWidth = 3;
      strokePixel(context, cursorPixelId);
    }
  }, [
    activeComponentId,
    armType,
    components,
    cursorPixelId,
    diffPixelIds,
    hiddenSet,
    image,
    previewPixelIds,
    rectanglePreviewPixelIds,
    selectedPixelIds,
    soloComponentId,
    usedPixelIds,
    viewMode,
  ]);

  const selectPixel = (
    pixelId: number | null,
    forceMode?: "add" | "remove",
  ) => {
    if (disabled || pixelId === null || !usedPixelIds.has(pixelId)) return;
    const mode = forceMode ?? (
      selectionRef.current.has(pixelId) ? "remove" : "add"
    );
    let candidates: readonly number[];
    switch (selectionTool) {
      case "magic":
        candidates = connectedExactColorPixelIds(image, armType, pixelId);
        break;
      case "surface":
        candidates = surfaceSelectionPixelIds(image, armType, pixelId);
        break;
      default:
        candidates = [pixelId];
        break;
    }
    const next = applySelectionPixels(
      [...selectionRef.current],
      candidates,
      mode,
    );
    selectionRef.current = new Set(next);
    onSelectionChange(next);
  };

  const pixelFromPointer = (event: ReactPointerEvent<HTMLCanvasElement>) =>
    canvasPointToPixelId(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );

  const beginPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    event.preventDefault();
    const pixelId = pixelFromPointer(event);
    setCursorPixelId(pixelId);
    if (pixelId === null || !usedPixelIds.has(pixelId)) return;
    dragModeRef.current = selectionRef.current.has(pixelId) ? "remove" : "add";
    if (selectionTool === "rectangle") {
      rectangleStartRef.current = pixelId;
      setRectangleEndPixelId(pixelId);
    } else {
      selectPixel(pixelId, dragModeRef.current);
    }
    if (selectionTool === "brush" || selectionTool === "rectangle") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const movePointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    const pixelId = pixelFromPointer(event);
    setCursorPixelId(pixelId);
    if (selectionTool === "rectangle") {
      setRectangleEndPixelId(pixelId);
    } else if (selectionTool === "brush") {
      selectPixel(pixelId, dragModeRef.current);
    }
  };

  const finishPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (selectionTool === "rectangle") {
      const start = rectangleStartRef.current;
      const end = pixelFromPointer(event) ?? rectangleEndPixelId;
      if (start !== null && end !== null) {
        const next = applySelectionPixels(
          [...selectionRef.current],
          rectangleSelectionPixelIds(image, armType, start, end),
          dragModeRef.current,
        );
        selectionRef.current = new Set(next);
        onSelectionChange(next);
      }
      rectangleStartRef.current = null;
      setRectangleEndPixelId(null);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyboard = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const fallback = [...usedPixelIds].sort((left, right) => left - right)[0] ?? null;
    const current = cursorPixelId ?? fallback;
    if (current === null) return;
    const deltas: Readonly<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -ATLAS_SIZE,
      ArrowDown: ATLAS_SIZE,
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      const x = current % ATLAS_SIZE;
      if ((delta === -1 && x === 0) || (delta === 1 && x === 63)) return;
      const next = current + delta;
      if (next >= 0 && next < ATLAS_SIZE * ATLAS_SIZE) setCursorPixelId(next);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      selectPixel(current);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="semantic-canvas"
      aria-label={`语义像素编辑器，${selectionToolLabel(selectionTool)}，已选择 ${selectedPixelIds.length} 个像素，对父版本高亮 ${diffPixelIds.length} 个变化像素；方向键移动，空格或回车选择`}
      data-disabled={disabled}
      data-diff-count={diffPixelIds.length}
      data-selection-tool={selectionTool}
      data-view-mode={viewMode}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={handleKeyboard}
      onPointerDown={beginPointer}
      onPointerMove={movePointer}
      onPointerUp={finishPointer}
      onPointerCancel={(event) => {
        rectangleStartRef.current = null;
        setRectangleEndPixelId(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    />
  );
}

function drawTexture(
  context: CanvasRenderingContext2D,
  image: RgbaImage,
): void {
  const source = document.createElement("canvas");
  source.width = ATLAS_SIZE;
  source.height = ATLAS_SIZE;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) return;
  sourceContext.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), ATLAS_SIZE, ATLAS_SIZE),
    0,
    0,
  );
  context.drawImage(source, 0, 0, ATLAS_SIZE * RENDER_SCALE, ATLAS_SIZE * RENDER_SCALE);
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  context.strokeStyle = "rgba(244, 240, 228, 0.16)";
  context.lineWidth = 1;
  context.beginPath();
  for (let coordinate = RENDER_SCALE; coordinate < width; coordinate += RENDER_SCALE) {
    context.moveTo(coordinate + 0.5, 0);
    context.lineTo(coordinate + 0.5, height);
    context.moveTo(0, coordinate + 0.5);
    context.lineTo(width, coordinate + 0.5);
  }
  context.stroke();
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

function strokePixel(context: CanvasRenderingContext2D, pixelId: number): void {
  context.strokeRect(
    (pixelId % ATLAS_SIZE) * RENDER_SCALE + 1.5,
    Math.floor(pixelId / ATLAS_SIZE) * RENDER_SCALE + 1.5,
    RENDER_SCALE - 3,
    RENDER_SCALE - 3,
  );
}

function componentColor(instanceId: string, index: number): string {
  return stableColor(instanceId, index * 47);
}

function categoryColor(category: string): string {
  return stableColor(category, 97);
}

function stableColor(value: string, seed: number): string {
  let hash = seed;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 360;
  }
  return `hsl(${hash} 72% 46%)`;
}

function selectionToolLabel(tool: SemanticSelectionTool): string {
  return {
    brush: "画笔",
    rectangle: "矩形",
    magic: "同色连通选择",
    surface: "UV 表面选择",
  }[tool];
}
