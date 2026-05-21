import { getSelectedNodeIds } from "../graph.js";
import { listenWithDispose } from "./lifecycle.js";

let editorEl = null;
let keyboardWired = false;
let graphSpacePanActive = false;
let graphCutCursorActive = false;
let graphMarqueeModifierActive = false;
let graphPointerInsideEditor = false;
let graphKeyboardActive = false;

export function initGraphKeyboard(deps) {
  editorEl = deps.editorEl;
  if (keyboardWired) return;
  keyboardWired = true;

  // Window-scoped keyboard shortcuts: graph-shell supplies action callbacks
  // for Cmd+D (duplicate), G (group), M (bypass), X/Delete (remove),
  // A (select all), F (frame), T (solo), R (rename), Space (pan),
  // Escape (cancel marquee), plus modifier cursor toggles.
  listenWithDispose(window, "keydown", (event) => {
    const target = event.target;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }

    if (event.key === "Alt" && shouldUseGraphCutCursor()) {
      graphCutCursorActive = true;
      syncGraphInteractionModeClasses();
      return;
    }

    // Cmd / Ctrl: arm marquee-ready cursor when the pointer is over the
    // editor. Don't preventDefault -- regular Cmd shortcuts still fire below.
    if ((event.key === "Meta" || event.key === "Control") && shouldUseGraphMarqueeCursor()) {
      graphMarqueeModifierActive = true;
      syncGraphInteractionModeClasses();
    }

    if (isSpaceKey(event) && shouldUseGraphSpacePan()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      graphSpacePanActive = true;
      syncGraphInteractionModeClasses();
      return;
    }

    if (event.key === "Escape") {
      const handled = deps.cancelActiveGraphMarquee() || deps.clearGraphSelection();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    const commandKey = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (commandKey && key === "d" && !event.shiftKey && !event.altKey) {
      if (deps.duplicateSelectedGraphNodes()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (key === "g" && !event.altKey && shouldHandleGraphShortcut()) {
      const handled = event.shiftKey ? deps.ungroupCurrentSelection() : deps.groupCurrentSelection();
      if (handled) event.preventDefault();
      return;
    }

    if (key === "m" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (deps.toggleBypassForSelectedNodes()) event.preventDefault();
      return;
    }

    if ((key === "x" || event.key === "Delete" || event.key === "Backspace") && shouldHandleGraphShortcut()) {
      if (deps.removeSelectedGraphNodes()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (key === "a" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (deps.selectAllVisibleGraphNodes()) event.preventDefault();
      return;
    }

    if (key === "f" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (deps.frameSelectedGraphNodes()) event.preventDefault();
      return;
    }

    if (key === "t" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (deps.toggleSoloForSelectedNode()) event.preventDefault();
      return;
    }

    if (key === "r" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (deps.startRenamingSelectedNode()) event.preventDefault();
    }
  });

  listenWithDispose(window, "keyup", (event) => {
    if (event.key === "Alt" && graphCutCursorActive) {
      graphCutCursorActive = false;
      syncGraphInteractionModeClasses();
      return;
    }

    if ((event.key === "Meta" || event.key === "Control") && graphMarqueeModifierActive) {
      graphMarqueeModifierActive = false;
      syncGraphInteractionModeClasses();
    }

    if (isSpaceKey(event) && graphSpacePanActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      graphSpacePanActive = false;
      syncGraphInteractionModeClasses();
    }
  });

  listenWithDispose(window, "blur", () => {
    graphSpacePanActive = false;
    graphCutCursorActive = false;
    syncGraphInteractionModeClasses();
    deps.cancelActiveGraphMarquee();
  });
}

export function markGraphKeyboardActive() {
  graphKeyboardActive = true;
}

export function setGraphPointerInsideEditor(value, event = null) {
  graphPointerInsideEditor = Boolean(value);
  if (event) syncGraphCutCursorFromPointer(event);
  syncGraphInteractionModeClasses();
}

export function syncGraphCutCursorFromPointer(event) {
  const nextCutCursorActive = Boolean(event.altKey);
  if (graphCutCursorActive === nextCutCursorActive) return;
  graphCutCursorActive = nextCutCursorActive;
}

export function syncGraphInteractionModeClasses() {
  editorEl?.classList.toggle("space-panning", graphSpacePanActive && shouldUseGraphSpacePan());
  editorEl?.classList.toggle("cut-ready", graphCutCursorActive && shouldUseGraphCutCursor());
  editorEl?.classList.toggle("marquee-ready", graphMarqueeModifierActive && shouldUseGraphMarqueeCursor());
}

function isSpaceKey(event) {
  return event.key === " " || event.code === "Space";
}

function shouldUseGraphSpacePan() {
  return graphPointerInsideEditor || editorEl?.matches?.(":hover") || graphSpacePanActive;
}

function shouldUseGraphCutCursor() {
  return graphPointerInsideEditor || editorEl?.matches?.(":hover") || graphCutCursorActive;
}

function shouldUseGraphMarqueeCursor() {
  return graphPointerInsideEditor || editorEl?.matches?.(":hover") || graphMarqueeModifierActive;
}

function shouldHandleGraphShortcut() {
  return (
    graphKeyboardActive ||
    graphPointerInsideEditor ||
    editorEl?.matches?.(":hover") ||
    getSelectedNodeIds().length > 0
  );
}
