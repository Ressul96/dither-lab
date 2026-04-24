/* Shell-level interactions for the app shell. */

const SHELL_STORAGE_KEY = "dither-lab.shell.v1";

export function initShell() {
  restoreShellState();
  initAccordion();
  initScopesDrawer();
  initPanelResize();
  initPanelToggles();
}

function initAccordion() {
  for (const toggle of document.querySelectorAll(".section-toggle")) {
    toggle.addEventListener("click", () => {
      const section = toggle.closest(".section");
      const collapsed = section.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  }
}

function initScopesDrawer() {
  const drawer = document.getElementById("scopesDrawer");
  const toggle = document.getElementById("scopesToggle");
  const close = document.getElementById("scopesClose");
  const workspace = document.getElementById("workspace");
  if (!drawer || !toggle || !workspace) return;

  const setOpen = (open) => {
    drawer.classList.toggle("open", open);
    workspace.classList.toggle("scopes-open", open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    toggle.setAttribute("aria-pressed", open ? "true" : "false");
    toggle.classList.toggle("scopes-active", open);
  };

  toggle.addEventListener("click", () => {
    setOpen(!drawer.classList.contains("open"));
  });
  close?.addEventListener("click", () => setOpen(false));
}

function initPanelResize() {
  for (const handle of document.querySelectorAll(".resize-handle")) {
    handle.addEventListener("pointerdown", (e) => startResize(e, handle));
  }
}

function startResize(e, handle) {
  if (handle.dataset.target === "workspace-rows") {
    startWorkspaceResize(e, handle);
    return;
  }

  const targetId = handle.dataset.target === "inspector" ? "inspector" : "rightPanel";
  const target = document.getElementById(targetId);
  const growRight = handle.dataset.side === "right";
  const startX = e.clientX;
  const startW = target.getBoundingClientRect().width;
  const minW = parseFloat(getComputedStyle(target).minWidth) || 240;
  const maxW = parseFloat(getComputedStyle(target).maxWidth) || 600;

  handle.classList.add("dragging");
  document.body.classList.add("resizing-x");
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const next = growRight ? startW + dx : startW - dx;
    target.style.width = clamp(next, minW, maxW) + "px";
  };
  const onUp = () => {
    handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing-x");
    persistShellState();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

function startWorkspaceResize(e, handle) {
  const workspace = document.getElementById("workspace");
  const nodeEditor = document.querySelector(".node-editor-shell");
  const scopesDrawer = document.getElementById("scopesDrawer");
  const playerCard = document.getElementById("playerCard");
  if (!workspace || !nodeEditor) return;

  const startY = e.clientY;
  const startH = nodeEditor.getBoundingClientRect().height;
  const workspaceRect = workspace.getBoundingClientRect();
  const playerHeight = playerCard?.getBoundingClientRect().height ?? 0;
  const scopesHeight = scopesDrawer?.classList.contains("open")
    ? scopesDrawer.getBoundingClientRect().height
    : 0;
  const minH = 220;
  const maxH = Math.max(minH, workspaceRect.height - playerHeight - scopesHeight - 180);

  handle.classList.add("dragging");
  document.body.classList.add("resizing-y");
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const next = clamp(startH + (ev.clientY - startY), minH, maxH);
    workspace.style.setProperty("--node-editor-h", `${next}px`);
  };

  const onUp = () => {
    handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing-y");
    persistShellState();
  };

  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

function initPanelToggles() {
  for (const button of document.querySelectorAll("[data-panel-toggle]")) {
    button.addEventListener("click", () => togglePanel(button.dataset.panelToggle));
  }
}

function togglePanel(side) {
  if (side !== "left" && side !== "right") return;
  const app = document.getElementById("app");
  if (!app) return;

  const className = side === "left" ? "panel-hidden-left" : "panel-hidden-right";
  const hidden = app.classList.toggle(className);
  syncPanelToggleLabels(side, hidden);
  persistShellState();
}

function syncPanelToggleLabels(side, hidden) {
  const label = hidden ? `Show ${side} panel` : `Hide ${side} panel`;
  for (const button of document.querySelectorAll(`[data-panel-toggle="${side}"]`)) {
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }
}

function restoreShellState() {
  const app = document.getElementById("app");
  const workspace = document.getElementById("workspace");
  const inspector = document.getElementById("inspector");
  const rightPanel = document.getElementById("rightPanel");
  const saved = loadShellState();
  if (!app || !saved) return;

  if (saved.leftHidden) app.classList.add("panel-hidden-left");
  if (saved.rightHidden) app.classList.add("panel-hidden-right");

  applyStoredWidth(inspector, saved.leftWidth);
  applyStoredWidth(rightPanel, saved.rightWidth);

  if (workspace && Number.isFinite(saved.nodeEditorHeight) && saved.nodeEditorHeight >= 220) {
    workspace.style.setProperty("--node-editor-h", `${saved.nodeEditorHeight}px`);
  }

  syncPanelToggleLabels("left", app.classList.contains("panel-hidden-left"));
  syncPanelToggleLabels("right", app.classList.contains("panel-hidden-right"));
}

function persistShellState() {
  const app = document.getElementById("app");
  const workspace = document.getElementById("workspace");
  const inspector = document.getElementById("inspector");
  const rightPanel = document.getElementById("rightPanel");
  if (!app || !workspace || !inspector || !rightPanel || !window.localStorage) return;

  const next = {
    leftHidden: app.classList.contains("panel-hidden-left"),
    rightHidden: app.classList.contains("panel-hidden-right"),
    leftWidth: Math.round(inspector.getBoundingClientRect().width),
    rightWidth: Math.round(rightPanel.getBoundingClientRect().width),
    nodeEditorHeight: readNodeEditorHeight(workspace),
  };

  try {
    window.localStorage.setItem(SHELL_STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

function loadShellState() {
  if (!window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(SHELL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function applyStoredWidth(panel, width) {
  if (!panel || !Number.isFinite(width)) return;
  const styles = getComputedStyle(panel);
  const minW = parseFloat(styles.minWidth) || 240;
  const maxW = parseFloat(styles.maxWidth) || 600;
  panel.style.width = `${clamp(width, minW, maxW)}px`;
}

function readNodeEditorHeight(workspace) {
  const value = getComputedStyle(workspace).getPropertyValue("--node-editor-h").trim();
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
