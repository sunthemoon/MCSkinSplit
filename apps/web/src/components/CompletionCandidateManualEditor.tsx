import {
  getSkinLayout,
  spansToPixelIds,
  type ArmType,
  type CompletionCandidateDocument,
} from "@mc-skin-split/skin-core";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  completionCandidateTextureUrl,
  editCompletionCandidate,
  loadCompletionCandidateDocument,
  type ApiCompletionCandidate,
  type ApiCompletionCandidateEdit,
  type ApiCompletionCandidateEditOutcome,
  type ApiCompletionProposalDetail,
} from "../lib/revisionApi";
import {
  MAX_COMPLETION_CANDIDATE_EDITS,
  applyCompletionEditAgainstCandidate,
  createCompletionEditHistory,
  hexAndAlphaToRgba,
  redoCompletionEdit,
  undoCompletionEdit,
} from "../lib/completionCandidateEditing";
import { canvasPointToPixelId } from "../lib/semanticCanvasCoordinates";

const ATLAS_SIZE = 64;
const RENDER_SCALE = 8;

export interface CompletionCandidateManualEditorProps {
  readonly armType: ArmType;
  readonly detail: ApiCompletionProposalDetail;
  readonly candidate: ApiCompletionCandidate;
  readonly disabled?: boolean;
  readonly onEdited: (outcome: ApiCompletionCandidateEditOutcome) => void;
  readonly onPendingChange?: (hasPendingEdits: boolean) => void;
}

export function CompletionCandidateManualEditor({
  armType,
  detail,
  candidate,
  disabled = false,
  onEdited,
  onPendingChange,
}: CompletionCandidateManualEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const [document, setDocument] =
    useState<CompletionCandidateDocument | null>(null);
  const [history, setHistory] = useState(createCompletionEditHistory);
  const [tool, setTool] = useState<"paint" | "remove">("paint");
  const [color, setColor] = useState("#d6a17b");
  const [alpha, setAlpha] = useState(255);
  const [cursorPixelId, setCursorPixelId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const candidateImageRef = useRef<HTMLImageElement | null>(null);
  const dragPixelRef = useRef<number | null>(null);
  const allowedPixelIds = useMemo(
    () => new Set(spansToPixelIds(
      detail.proposal.allowedSpans,
      getSkinLayout(armType),
    )),
    [armType, detail.proposal.allowedSpans],
  );

  useEffect(() => {
    setDocument(null);
    setHistory(createCompletionEditHistory());
    setCursorPixelId([...allowedPixelIds].sort((a, b) => a - b)[0] ?? null);
    setMessage(null);
    setError(null);
  }, [candidate.id, allowedPixelIds]);

  useEffect(() => {
    onPendingChange?.(history.present.length > 0);
    return () => onPendingChange?.(false);
  }, [history.present.length, onPendingChange]);

  useEffect(() => {
    if (!expanded || document || loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadCompletionCandidateDocument(detail.proposal.id, candidate.id)
      .then((loaded) => {
        if (!cancelled) setDocument(loaded);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate.id, detail.proposal.id, document, expanded]);

  useEffect(() => {
    if (!expanded || typeof Image === "undefined") return;
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      candidateImageRef.current = image;
      drawEditorCanvas(
        canvasRef.current,
        image,
        allowedPixelIds,
        document,
        history.present,
        cursorPixelId,
      );
    };
    image.onerror = () => {
      if (!cancelled) setError("候选纹理读取失败，未提交任何改动");
    };
    image.src = completionCandidateTextureUrl(detail.proposal.id, candidate.id);
    return () => {
      cancelled = true;
      candidateImageRef.current = null;
    };
  }, [candidate.id, detail.proposal.id, expanded]);

  useEffect(() => {
    drawEditorCanvas(
      canvasRef.current,
      candidateImageRef.current,
      allowedPixelIds,
      document,
      history.present,
      cursorPixelId,
    );
  }, [allowedPixelIds, cursorPixelId, document, history.present]);

  const applyPixel = (pixelId: number | null) => {
    if (disabled || submitting || pixelId === null) return;
    if (!document) {
      setMessage("候选来源尚未读取完成，请稍候再微调");
      return;
    }
    if (!allowedPixelIds.has(pixelId)) {
      setMessage("这个像素不在系统允许的微调范围内");
      return;
    }
    const edit: ApiCompletionCandidateEdit = tool === "remove"
      ? { type: "remove_pixel", pixelId }
      : {
          type: "set_pixel",
          pixelId,
          rgba: hexAndAlphaToRgba(color, alpha),
        };
    setHistory((current) => {
      const updated = applyCompletionEditAgainstCandidate(
        current,
        document,
        edit,
      );
      setMessage(updated.limitReached
        ? `一次最多手工修改 ${MAX_COMPLETION_CANDIDATE_EDITS} 个像素`
        : !updated.effective
          ? "这个像素与候选原值相同，不需要提交"
          : null);
      return updated.history;
    });
  };

  const pixelFromPointer = (event: ReactPointerEvent<HTMLCanvasElement>) =>
    canvasPointToPixelId(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );

  const submit = async () => {
    if (history.present.length === 0 || submitting || disabled) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await editCompletionCandidate(
        detail.proposal,
        candidate,
        history.present,
      );
      onEdited(outcome);
      setMessage(outcome.changed
        ? "已创建手工微调候选，并切换到这张派生候选"
        : "这组微调已经存在，已切换到同一张派生候选");
      setHistory(createCompletionEditHistory());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const moveKeyboardCursor = (
    event: ReactKeyboardEvent<HTMLCanvasElement>,
  ) => {
    if (disabled || cursorPixelId === null) return;
    const deltas: Readonly<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -ATLAS_SIZE,
      ArrowDown: ATLAS_SIZE,
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      const x = cursorPixelId % ATLAS_SIZE;
      if ((delta === -1 && x === 0) || (delta === 1 && x === 63)) return;
      const next = cursorPixelId + delta;
      if (next >= 0 && next < ATLAS_SIZE * ATLAS_SIZE) {
        setCursorPixelId(next);
      }
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      applyPixel(cursorPixelId);
    }
  };

  const authoredCount = document?.assignments.filter(
    (assignment) => assignment.manualActor !== null,
  ).length ?? 0;

  return (
    <details
      className="completion-manual-editor"
      data-testid="completion-manual-editor"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>候选不太对？微调</summary>
      <div className="completion-manual-editor-body">
        <header>
          <div>
            <strong>只改点到的像素</strong>
            <p>
              未触碰像素继续保留系统候选；提交后的手工像素会明确记录为玩家创作，仍需再按“接受所选候选”。
            </p>
          </div>
          <span>{history.present.length} / {MAX_COMPLETION_CANDIDATE_EDITS}</span>
        </header>

        <div className="completion-manual-tools" role="toolbar" aria-label="候选像素微调工具">
          <button
            type="button"
            aria-pressed={tool === "paint"}
            disabled={disabled || submitting}
            onClick={() => setTool("paint")}
          >
            上色
          </button>
          <button
            type="button"
            aria-pressed={tool === "remove"}
            disabled={disabled || submitting}
            onClick={() => setTool("remove")}
          >
            移除候选像素
          </button>
          <label>
            <span>颜色</span>
            <input
              type="color"
              aria-label="手工像素颜色"
              value={color}
              disabled={disabled || submitting || tool !== "paint"}
              onChange={(event) => setColor(event.target.value)}
            />
          </label>
          <label>
            <span>不透明度 {alpha}</span>
            <input
              type="range"
              aria-label="手工像素不透明度"
              min="1"
              max="255"
              value={alpha}
              disabled={disabled || submitting || tool !== "paint"}
              onChange={(event) => setAlpha(Number(event.target.value))}
            />
          </label>
        </div>

        <canvas
          ref={canvasRef}
          className="completion-manual-canvas"
          width={ATLAS_SIZE * RENDER_SCALE}
          height={ATLAS_SIZE * RENDER_SCALE}
          tabIndex={disabled ? -1 : 0}
          aria-label="64×64 候选微调画布；方向键移动，空格或回车应用当前工具"
          data-tool={tool}
          data-disabled={disabled || submitting}
          onKeyDown={moveKeyboardCursor}
          onPointerDown={(event) => {
            if (disabled || submitting) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const pixelId = pixelFromPointer(event);
            dragPixelRef.current = pixelId;
            setCursorPixelId(pixelId);
            applyPixel(pixelId);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const pixelId = pixelFromPointer(event);
            if (pixelId === dragPixelRef.current) return;
            dragPixelRef.current = pixelId;
            setCursorPixelId(pixelId);
            applyPixel(pixelId);
          }}
          onPointerUp={(event) => {
            dragPixelRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            dragPixelRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
        />

        <p className="completion-manual-legend">
          黄色格是允许微调范围；青色格是待提交手工像素；叉号表示移除。
          {document ? ` 当前候选已有 ${authoredCount} 个已记录手工像素。` : ""}
        </p>
        {loading && <p role="status">正在读取候选像素来源…</p>}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}

        <div className="completion-manual-actions">
          <button
            type="button"
            disabled={disabled || submitting || history.past.length === 0}
            onClick={() => setHistory(undoCompletionEdit)}
          >
            撤销
          </button>
          <button
            type="button"
            disabled={disabled || submitting || history.future.length === 0}
            onClick={() => setHistory(redoCompletionEdit)}
          >
            重做
          </button>
          <button
            type="button"
            disabled={disabled || submitting || history.present.length === 0}
            onClick={() => {
              setHistory(createCompletionEditHistory());
              setMessage("已取消尚未提交的微调");
            }}
          >
            取消微调
          </button>
          <button
            className="completion-manual-submit"
            type="button"
            disabled={disabled || submitting || history.present.length === 0}
            onClick={() => void submit()}
          >
            {submitting ? "正在生成派生候选…" : "应用微调并生成候选"}
          </button>
        </div>
      </div>
    </details>
  );
}

function drawEditorCanvas(
  canvas: HTMLCanvasElement | null,
  image: HTMLImageElement | null,
  allowedPixelIds: ReadonlySet<number>,
  document: CompletionCandidateDocument | null,
  edits: readonly ApiCompletionCandidateEdit[],
  cursorPixelId: number | null,
): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawCheckerboard(context, canvas.width, canvas.height);
  if (image) context.drawImage(image, 0, 0, canvas.width, canvas.height);

  context.lineWidth = 1;
  context.strokeStyle = "rgba(255, 210, 92, 0.72)";
  for (const pixelId of allowedPixelIds) strokePixel(context, pixelId);

  context.strokeStyle = "rgba(255, 255, 255, 0.76)";
  context.lineWidth = 2;
  for (const assignment of document?.assignments ?? []) {
    if (assignment.manualActor !== null) strokePixel(context, assignment.targetPixelId);
  }

  for (const edit of edits) {
    const x = (edit.pixelId % ATLAS_SIZE) * RENDER_SCALE;
    const y = Math.floor(edit.pixelId / ATLAS_SIZE) * RENDER_SCALE;
    if (edit.type === "set_pixel") {
      context.fillStyle = `rgba(${edit.rgba[0]}, ${edit.rgba[1]}, ${edit.rgba[2]}, ${edit.rgba[3] / 255})`;
      context.fillRect(x, y, RENDER_SCALE, RENDER_SCALE);
      context.strokeStyle = "#24c3c2";
      context.lineWidth = 2;
      strokePixel(context, edit.pixelId);
    } else {
      context.fillStyle = "rgba(18, 18, 18, 0.82)";
      context.fillRect(x, y, RENDER_SCALE, RENDER_SCALE);
      context.strokeStyle = "#ef785f";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x + 1, y + 1);
      context.lineTo(x + RENDER_SCALE - 1, y + RENDER_SCALE - 1);
      context.moveTo(x + RENDER_SCALE - 1, y + 1);
      context.lineTo(x + 1, y + RENDER_SCALE - 1);
      context.stroke();
    }
  }

  if (cursorPixelId !== null) {
    context.strokeStyle = allowedPixelIds.has(cursorPixelId) ? "#ffffff" : "#ef785f";
    context.lineWidth = 3;
    strokePixel(context, cursorPixelId);
  }
}

function drawCheckerboard(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y += RENDER_SCALE) {
    for (let x = 0; x < width; x += RENDER_SCALE) {
      context.fillStyle = ((x + y) / RENDER_SCALE) % 2 === 0
        ? "#242625"
        : "#303331";
      context.fillRect(x, y, RENDER_SCALE, RENDER_SCALE);
    }
  }
}

function strokePixel(context: CanvasRenderingContext2D, pixelId: number): void {
  context.strokeRect(
    (pixelId % ATLAS_SIZE) * RENDER_SCALE + 0.5,
    Math.floor(pixelId / ATLAS_SIZE) * RENDER_SCALE + 0.5,
    RENDER_SCALE - 1,
    RENDER_SCALE - 1,
  );
}
