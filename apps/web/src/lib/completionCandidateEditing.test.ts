import { describe, expect, it } from "vitest";
import {
  createCompletionEditHistory,
  applyCompletionEditAgainstCandidate,
  hexAndAlphaToRgba,
  redoCompletionEdit,
  undoCompletionEdit,
  upsertCompletionEdit,
} from "./completionCandidateEditing";

describe("Completion candidate edit history", () => {
  it("deduplicates edits by pixel while keeping deterministic order", () => {
    let history = createCompletionEditHistory();
    history = upsertCompletionEdit(history, {
      type: "set_pixel",
      pixelId: 20,
      rgba: [1, 2, 3, 255],
    }).history;
    history = upsertCompletionEdit(history, {
      type: "remove_pixel",
      pixelId: 5,
    }).history;
    history = upsertCompletionEdit(history, {
      type: "set_pixel",
      pixelId: 20,
      rgba: [9, 8, 7, 128],
    }).history;

    expect(history.present).toEqual([
      { type: "remove_pixel", pixelId: 5 },
      { type: "set_pixel", pixelId: 20, rgba: [9, 8, 7, 128] },
    ]);
  });

  it("supports local undo and redo without contacting the server", () => {
    const empty = createCompletionEditHistory();
    const painted = upsertCompletionEdit(empty, {
      type: "set_pixel",
      pixelId: 42,
      rgba: [10, 20, 30, 255],
    }).history;
    expect(undoCompletionEdit(painted).present).toEqual([]);
    expect(redoCompletionEdit(undoCompletionEdit(painted)).present).toEqual(
      painted.present,
    );
  });

  it("caps unique authored pixels at the requested bound", () => {
    let history = createCompletionEditHistory();
    history = upsertCompletionEdit(history, {
      type: "remove_pixel",
      pixelId: 1,
    }, 1).history;
    const blocked = upsertCompletionEdit(history, {
      type: "remove_pixel",
      pixelId: 2,
    }, 1);
    const replacement = upsertCompletionEdit(history, {
      type: "set_pixel",
      pixelId: 1,
      rgba: [4, 5, 6, 255],
    }, 1);

    expect(blocked.limitReached).toBe(true);
    expect(blocked.history).toBe(history);
    expect(replacement.limitReached).toBe(false);
    expect(replacement.history.present).toEqual([
      { type: "set_pixel", pixelId: 1, rgba: [4, 5, 6, 255] },
    ]);
  });

  it("converts player color controls to the exact nontransparent RGBA tuple", () => {
    expect(hexAndAlphaToRgba("#0a80ff", 127)).toEqual([10, 128, 255, 127]);
    expect(() => hexAndAlphaToRgba("transparent", 255)).toThrow(TypeError);
    expect(() => hexAndAlphaToRgba("#ffffff", 0)).toThrow(RangeError);
  });

  it("filters paint-same-color and remove-missing no-ops before submission", () => {
    const document = {
      assignments: [{ targetPixelId: 5, rgba: [10, 20, 30, 255] }],
    } as unknown as import("@mc-skin-split/skin-core").CompletionCandidateDocument;
    const empty = createCompletionEditHistory();

    expect(applyCompletionEditAgainstCandidate(empty, document, {
      type: "set_pixel",
      pixelId: 5,
      rgba: [10, 20, 30, 255],
    })).toMatchObject({ effective: false, history: { present: [] } });
    expect(applyCompletionEditAgainstCandidate(empty, document, {
      type: "remove_pixel",
      pixelId: 6,
    })).toMatchObject({ effective: false, history: { present: [] } });

    const changed = applyCompletionEditAgainstCandidate(empty, document, {
      type: "set_pixel",
      pixelId: 5,
      rgba: [90, 80, 70, 255],
    });
    const restored = applyCompletionEditAgainstCandidate(
      changed.history,
      document,
      { type: "set_pixel", pixelId: 5, rgba: [10, 20, 30, 255] },
    );
    expect(restored.effective).toBe(false);
    expect(restored.history.present).toEqual([]);
  });
});
