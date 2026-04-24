import { initShell } from "./ui/shell.js";
import { initGraphShell } from "./ui/graph-shell.js";
import { initPlayer } from "./ui/player.js";
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
    switch (e.key) {
      case " ":
        // If a button is focused, let its native Space→click fire instead of double-toggling.
        if (t && t.tagName === "BUTTON") return;
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        stepFrame(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        stepFrame(1);
        break;
      case "Home":
        e.preventDefault();
        restart();
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
    }
  });
}
