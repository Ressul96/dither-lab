import { initShell } from "./ui/shell.js";
import { initGraphShell } from "./ui/graph-shell.js";
import { initSplash } from "./ui/splash.js";
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
import { initAssetPanel } from "./ui/asset-panel.js";
import { initTokenPanel } from "./ui/token-panel.js";
import {
  getRecentProjects,
  initDirtyTracking,
  isProjectDirty,
  newProject,
  openProject,
  openRecentProject,
  saveProject,
  saveProjectAs,
} from "./project.js";
import { initExport, openExport } from "./export.js";
import { initSource, openSource, togglePlay, stepFrame, restart } from "./source.js";
import { undo, redo, syncHistoryButtons } from "./state.js";
import { disposeAll } from "./ui/lifecycle.js";
import { showErrorToast } from "./ui/toast.js";
import { initAutosave, readRecoveryDraft, applyRecoveryDraft } from "./autosave.js";

initShell();
initSource();
initExport();
initGraphShell();
initPlayer();
initStage();
initAssetPanel();
initTokenPanel();
initProjectButtons();
initHistoryButtons();
initKeyboard();
initDirtyTracking();
initAutosave();
// Reading the recovery draft is async (Tauri fs); resolve it before the splash
// renders so it can offer to restore. Null without a draft or outside Tauri.
(async () => {
  const recoveryDraft = await readRecoveryDraft().catch(() => null);
  initSplash({
    getRecentProjects,
    newProject,
    openProject,
    openRecentProject,
    recoveryDraft,
    recoverDraft: async () => {
      if (recoveryDraft) await applyRecoveryDraft(recoveryDraft);
    },
  });
})();
syncHistoryButtons();

// Tear down registered listeners + observers before the window unloads.
// Disposers registered via ui/lifecycle.js are LIFO-popped here so the
// process exits without orphaned handlers (matters mostly for hot reload
// and tests; production exit is process-terminated anyway).
window.addEventListener("beforeunload", disposeAll);

if (window.__TAURI__) {
  // Closing the window with unsaved changes silently discards them; ask first.
  try {
    window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (event) => {
      if (!isProjectDirty()) return;
      const leave = await window.__TAURI__.dialog.ask(
        "You have unsaved changes. Quit anyway?",
        { title: "Unsaved Changes", kind: "warning" }
      );
      if (!leave) event.preventDefault();
    });
  } catch (err) {
    console.error("[main] close guard unavailable", err);
  }

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
      showErrorToast(err?.message || `Action failed: ${payload}`);
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
  bindAction("new-project", guarded(() => newProject()));
  bindAction("open-project", guarded(() => openProject()));
  bindAction("save-project", guarded(() => saveProject()));
  bindAction("save-project-as", guarded(() => saveProjectAs()));
  bindAction("export", guarded(() => openExport()));
}

// Click handlers swallow promise rejections (a corrupt project file throws out
// of openProject); surface them instead of failing silently.
function guarded(fn) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      console.error("[action failed]", err);
      showErrorToast(err?.message || "Operation failed.");
    }
  };
}

function bindAction(action, handler) {
  for (const el of document.querySelectorAll(`[data-action="${action}"]`)) {
    el.addEventListener("click", handler);
  }
}

function initKeyboard() {
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    // F17.4: text-editable controls keep their native shortcuts (typing,
    // selection, native undo); selects keep arrow-key dropdown navigation.
    // Range / checkbox style inputs keep their native arrow / space handling
    // (they have meaningful keyboard semantics) but document-level undo /
    // redo still wins — that's what makes Cmd+Z atomic over a slider drag
    // when the slider still has focus after a release.
    if (t) {
      const isTextEditable =
        t.isContentEditable ||
        t.tagName === "TEXTAREA" ||
        (t.tagName === "INPUT" &&
          ["text", "number", "search", "url", "email", "tel", "password"].includes(t.type));
      if (isTextEditable) return;
      if (t.tagName === "SELECT") return;
      if (t.tagName === "INPUT") {
        const isUndoCombo =
          (e.metaKey || e.ctrlKey) &&
          (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y");
        if (!isUndoCombo) return;
      }
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
