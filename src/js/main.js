import { initShell } from "./ui/shell.js";
import { initGraphShell } from "./ui/graph-shell.js";
import {
  initPlayer,
  goToLastFrame,
  copySelectedKeyframes,
  deleteSelectedKeyframes,
  duplicateSelectedKeyframes,
  nudgeSelectedKeyframes,
  pasteKeyframesAtPlayhead,
} from "./ui/player.js";
import { initStage, resetZoom, togglePixelInspector } from "./ui/stage.js";
import { newProject, openProject, saveProject, saveProjectAs } from "./project.js";
import { initExport, openExport } from "./export.js";
import { initSource, openSource, togglePlay, stepFrame, restart } from "./source.js";
import { undo, redo, syncHistoryButtons } from "./state.js";

initShell();
initSource();
initExport();
initGraphShell();
initPlayer();
initStage();
initProjectButtons();
initHistoryButtons();
initKeyboard();
syncHistoryButtons();

if (window.__TAURI__) {
  window.__TAURI__.event.listen("menu:action", async ({ payload }) => {
    try {
      switch (payload) {
        case "open-source":
          await openSource();
          break;
        case "new-project":
          await newProject();
          break;
        case "open-project":
          await openProject();
          break;
        case "save-project":
          await saveProject();
          break;
        case "save-project-as":
          await saveProjectAs();
          break;
        case "export":
          await openExport();
          break;
        case "undo":
          undo();
          break;
        case "redo":
          redo();
          break;
        case "toggle-pixel-inspector":
          togglePixelInspector();
          break;
        default:
          break;
      }
    } catch (err) {
      console.error("[menu:action failed]", payload, err);
    }
  });
}

function initHistoryButtons() {
  const u = document.querySelector('[data-action="undo"]');
  const r = document.querySelector('[data-action="redo"]');
  if (u) u.addEventListener("click", undo);
  if (r) r.addEventListener("click", redo);
}

function initProjectButtons() {
  bindAction("new-project", () => newProject());
  bindAction("open-project", () => openProject());
  bindAction("save-project", () => saveProject());
  bindAction("save-project-as", () => saveProjectAs());
  bindAction("export", () => openExport());
}

function bindAction(action, handler) {
  for (const el of document.querySelectorAll(`[data-action="${action}"]`)) {
    el.addEventListener("click", handler);
  }
}

function initKeyboard() {
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    // Frame stepping uses 10× when Shift is held — matches AE/Cavalry.
    const FRAME_BIG_STEP = 10;
    switch (e.key) {
      case " ":
        // If a button is focused, let its native Space→click fire instead of double-toggling.
        if (t && t.tagName === "BUTTON") return;
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        // Selection wins: arrows nudge the selected keyframes by 1 frame
        // (Shift = 10). With no selection, fall through to playhead stepping
        // so users without active keyframes still get the AE-style scrub.
        if (!nudgeSelectedKeyframes(-1, e.shiftKey)) {
          stepFrame(e.shiftKey ? -FRAME_BIG_STEP : -1);
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!nudgeSelectedKeyframes(1, e.shiftKey)) {
          stepFrame(e.shiftKey ? FRAME_BIG_STEP : 1);
        }
        break;
      case "Home":
        e.preventDefault();
        restart();
        break;
      case "End":
        e.preventDefault();
        goToLastFrame();
        break;
      case "Delete":
      case "Backspace":
        // Only swallow Delete/Backspace when there is something to delete —
        // otherwise let the browser handle it (e.g. navigation back).
        if (deleteSelectedKeyframes()) {
          e.preventDefault();
        }
        break;
      case "0":
        if (meta) {
          e.preventDefault();
          resetZoom();
        }
        break;
      case "z":
      case "Z":
        if (meta) {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        }
        break;
      case "d":
      case "D":
        // Cmd/Ctrl+D would otherwise bookmark the page in Chrome — always
        // preventDefault when the modifier is held, even if there's no
        // selection to duplicate, so the browser gesture stays neutralised
        // while the user is in the timeline.
        if (meta) {
          e.preventDefault();
          duplicateSelectedKeyframes();
        }
        break;
      case "c":
      case "C":
        // Only swallow Cmd+C when we actually copied keyframes. If nothing
        // is selected, let the browser's native copy handler take over so
        // users can still copy text from labels or the dev console.
        if (meta && !e.shiftKey && !e.altKey && copySelectedKeyframes()) {
          e.preventDefault();
        }
        break;
      case "v":
      case "V":
        if (meta && !e.shiftKey && !e.altKey && pasteKeyframesAtPlayhead()) {
          e.preventDefault();
        }
        break;
    }
  });
}
