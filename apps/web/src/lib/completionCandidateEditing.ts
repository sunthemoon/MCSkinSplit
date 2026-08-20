import type {
  CompletionCandidateDocument,
  Rgba,
} from "@mc-skin-split/skin-core";
import type { ApiCompletionCandidateEdit } from "./revisionApi";

export const MAX_COMPLETION_CANDIDATE_EDITS = 256;

export interface CompletionEditHistory {
  readonly past: readonly (readonly ApiCompletionCandidateEdit[])[];
  readonly present: readonly ApiCompletionCandidateEdit[];
  readonly future: readonly (readonly ApiCompletionCandidateEdit[])[];
}

export interface CompletionEditUpdate {
  readonly history: CompletionEditHistory;
  readonly limitReached: boolean;
}

export interface CandidateAwareCompletionEditUpdate extends CompletionEditUpdate {
  readonly effective: boolean;
}

export function createCompletionEditHistory(): CompletionEditHistory {
  return { past: [], present: [], future: [] };
}

export function upsertCompletionEdit(
  history: CompletionEditHistory,
  edit: ApiCompletionCandidateEdit,
  limit = MAX_COMPLETION_CANDIDATE_EDITS,
): CompletionEditUpdate {
  const current = history.present.find((item) => item.pixelId === edit.pixelId);
  if (current && completionEditsEqual(current, edit)) {
    return { history, limitReached: false };
  }
  const withoutPixel = history.present.filter(
    (item) => item.pixelId !== edit.pixelId,
  );
  if (!current && withoutPixel.length >= limit) {
    return { history, limitReached: true };
  }
  const present = [...withoutPixel, cloneCompletionEdit(edit)].sort(
    (left, right) => left.pixelId - right.pixelId,
  );
  return {
    history: {
      past: [...history.past, history.present],
      present,
      future: [],
    },
    limitReached: false,
  };
}

export function applyCompletionEditAgainstCandidate(
  history: CompletionEditHistory,
  document: CompletionCandidateDocument,
  edit: ApiCompletionCandidateEdit,
  limit = MAX_COMPLETION_CANDIDATE_EDITS,
): CandidateAwareCompletionEditUpdate {
  const assignment = document.assignments.find(
    (item) => item.targetPixelId === edit.pixelId,
  );
  const changesBase = edit.type === "remove_pixel"
    ? assignment !== undefined
    : !assignment || !assignment.rgba.every(
      (value, index) => value === edit.rgba[index],
    );
  if (changesBase) {
    return { ...upsertCompletionEdit(history, edit, limit), effective: true };
  }
  const present = history.present.filter((item) => item.pixelId !== edit.pixelId);
  if (present.length === history.present.length) {
    return { history, limitReached: false, effective: false };
  }
  return {
    history: {
      past: [...history.past, history.present],
      present,
      future: [],
    },
    limitReached: false,
    effective: false,
  };
}

export function undoCompletionEdit(
  history: CompletionEditHistory,
): CompletionEditHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoCompletionEdit(
  history: CompletionEditHistory,
): CompletionEditHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function completionEditForPixel(
  edits: readonly ApiCompletionCandidateEdit[],
  pixelId: number,
): ApiCompletionCandidateEdit | null {
  return edits.find((edit) => edit.pixelId === pixelId) ?? null;
}

export function hexAndAlphaToRgba(hex: string, alpha: number): Rgba {
  if (!/^#[0-9a-f]{6}$/iu.test(hex)) {
    throw new TypeError(`Invalid RGB color: ${hex}`);
  }
  if (!Number.isInteger(alpha) || alpha < 1 || alpha > 255) {
    throw new RangeError(`Alpha must be an integer from 1 to 255: ${alpha}`);
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    alpha,
  ];
}

function completionEditsEqual(
  left: ApiCompletionCandidateEdit,
  right: ApiCompletionCandidateEdit,
): boolean {
  if (left.type !== right.type || left.pixelId !== right.pixelId) return false;
  if (left.type === "remove_pixel" || right.type === "remove_pixel") return true;
  return left.rgba.every((value, index) => value === right.rgba[index]);
}

function cloneCompletionEdit(
  edit: ApiCompletionCandidateEdit,
): ApiCompletionCandidateEdit {
  return edit.type === "remove_pixel"
    ? { type: "remove_pixel", pixelId: edit.pixelId }
    : { type: "set_pixel", pixelId: edit.pixelId, rgba: [...edit.rgba] as Rgba };
}
