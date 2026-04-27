import { getState, dispatch, subscribe } from "../state.js";
import { openExport } from "../export.js";
import { samplePixel } from "../source.js";

export function initStage() {
  const stage = document.getElementById("stage");
  const canvas = document.getElementById("output");
  const splitCanvas = document.getElementById("outputSplitOverlay");
  const stageCanvas = document.querySelector(".stage-canvas");
  const splitOverlay = document.getElementById("splitOverlay");
  const splitDivider = document.getElementById("splitDivider");
  const zoomToggle = document.getElementById("zoomToggle");
  if (!stage || !canvas || !stageCanvas || !splitOverlay || !splitDivider) return;

  const outputs = [canvas, splitCanvas].filter(Boolean);

  wireZoom(stage, outputs);
  wirePan(canvas, outputs);
  wirePixelInspector(canvas);
  wireSplitDivider(stageCanvas, splitDivider);
  wireContextMenu(stage);
  wireZoomToggle(zoomToggle, outputs);
  wireZoomShortcuts(outputs);

  const sync = () =>
    syncStagePresentation(stageCanvas, canvas, splitCanvas, splitOverlay, splitDivider, outputs, zoomToggle);

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(sync);
    observer.observe(stageCanvas);
    observer.observe(canvas);
  }

  window.addEventListener("resize", sync);
  subscribe("view", sync);
  subscribe("source", sync);
  // Playback transitions also flip the badge between "1:1 export-accurate"
  // and "playback · half-res", so re-sync when video starts/stops.
  subscribe("playback", sync);
}

function wireZoom(stage, outputs) {
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.002;
      const { view } = getState();
      const next = clamp(view.zoom * Math.exp(delta), 0.25, 8);
      dispatch("view", { zoom: next, fit: false });
      applyTransform(outputs);
    },
    { passive: false }
  );
}

function wirePan(canvas, outputs) {
  let dragging = false;
  let sx = 0, sy = 0, px = 0, py = 0;
  canvas.addEventListener("pointerdown", (e) => {
    const { view } = getState();
    if (view.fit) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    px = view.panX;
    py = view.panY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dispatch("view", { panX: px + (e.clientX - sx), panY: py + (e.clientY - sy) });
    applyTransform(outputs);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

function wireSplitDivider(stageCanvas, splitDivider) {
  splitDivider.addEventListener("pointerdown", (e) => {
    if (getState().view.compare !== "split") return;
    e.preventDefault();
    splitDivider.setPointerCapture(e.pointerId);

    // Driver coordinates are read from the unscaled stage so the divider
    // tracks the visible window, not the (possibly zoomed/panned) image.
    const move = (ev) => {
      const rect = stageCanvas.getBoundingClientRect();
      if (!rect.width) return;
      dispatch("view", {
        splitPosition: clamp((ev.clientX - rect.left) / rect.width, 0, 1),
      });
    };

    const end = () => {
      try {
        splitDivider.releasePointerCapture(e.pointerId);
      } catch {}
      splitDivider.removeEventListener("pointermove", move);
      splitDivider.removeEventListener("pointerup", end);
      splitDivider.removeEventListener("pointercancel", end);
    };

    move(e);
    splitDivider.addEventListener("pointermove", move);
    splitDivider.addEventListener("pointerup", end);
    splitDivider.addEventListener("pointercancel", end);
  });
}

function applyTransform(outputs) {
  const { view } = getState();
  for (const canvas of outputs) {
    if (!canvas) continue;
    if (view.fit) {
      canvas.style.transform = "";
      canvas.style.maxWidth = "";
      canvas.style.maxHeight = "";
    } else {
      canvas.style.maxWidth = "none";
      canvas.style.maxHeight = "none";
      canvas.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
    }
  }
  applyImageRendering(outputs);
}

// Switch between pixelated (sharp pixels at >=100% zoom) and auto/bilinear
// (less misleading downscale of dither patterns under 100%). The dither output
// itself is always rendered at source resolution; image-rendering only affects
// how the displayed canvas is sampled at the current display size.
function applyImageRendering(outputs) {
  const { view } = getState();
  for (const canvas of outputs) {
    if (!canvas || !canvas.width || !canvas.height) continue;
    let effectiveScale;
    if (view.fit) {
      const rect = canvas.getBoundingClientRect();
      effectiveScale = canvas.width > 0 ? rect.width / canvas.width : 1;
    } else {
      effectiveScale = view.zoom;
    }
    canvas.style.imageRendering = effectiveScale >= 0.999 ? "pixelated" : "auto";
  }
}

export function resetZoom() {
  dispatch("view", { zoom: 1, fit: true, panX: 0, panY: 0 });
  applyTransform([
    document.getElementById("output"),
    document.getElementById("outputSplitOverlay"),
  ]);
}

function setActualPixels(outputs) {
  dispatch("view", { zoom: 1, fit: false, panX: 0, panY: 0 });
  applyTransform(outputs);
}

function wireZoomToggle(zoomToggle, outputs) {
  if (!zoomToggle) return;
  zoomToggle.addEventListener("click", () => {
    const { view } = getState();
    // 1:1 → Fit → 1:1 ...
    if (!view.fit && Math.abs(view.zoom - 1) < 0.001) {
      dispatch("view", { zoom: 1, fit: true, panX: 0, panY: 0 });
    } else {
      dispatch("view", { zoom: 1, fit: false, panX: 0, panY: 0 });
    }
    applyTransform(outputs);
  });
}

function wireZoomShortcuts(outputs) {
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      dispatch("view", { zoom: 1, fit: true, panX: 0, panY: 0 });
      applyTransform(outputs);
    } else if (e.key === "1") {
      e.preventDefault();
      setActualPixels(outputs);
    }
  });
}

function wirePixelInspector(canvas) {
  const hud = document.getElementById("pixelInspector");
  canvas.addEventListener("mousemove", (e) => {
    if (!getState().view.pixelInspector || !hud) return;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    const sample = samplePixel(u, v);
    if (!sample) return;
    const rows = hud.querySelectorAll(".row .value");
    if (rows.length >= 3) {
      rows[0].textContent = `${sample.x}, ${sample.y}`;
      rows[1].textContent = `rgb(${sample.source.join(", ")})`;
      rows[2].textContent = `rgb(${sample.processed.join(", ")})`;
    }
  });
}

export function togglePixelInspector() {
  const next = !getState().view.pixelInspector;
  dispatch("view", { pixelInspector: next });
  const hud = document.getElementById("pixelInspector");
  if (hud) hud.classList.toggle("hidden", !next);
}

function syncStagePresentation(stageCanvas, canvas, splitCanvas, splitOverlay, splitDivider, outputs, zoomToggle) {
  applyTransform(outputs);
  syncZoomToggle(zoomToggle, canvas);

  const { source, view } = getState();
  const compare = source.loaded ? view.compare : "processed";
  const overlayActive = source.loaded && (compare === "split" || compare === "side-by-side");
  const dividerActive = source.loaded && compare === "split";

  // Drive CSS clip-paths via attributes / variables on the stage so layout
  // happens in screen space (the wrappers don't carry the canvas transform).
  stageCanvas.dataset.compare = compare;
  stageCanvas.style.setProperty("--split-position", String(clamp(view.splitPosition, 0, 1)));

  splitOverlay.classList.toggle("hidden", !overlayActive);
  if (splitCanvas) splitCanvas.classList.toggle("hidden", !overlayActive);
  splitDivider.classList.toggle("hidden", !dividerActive);

  if (!dividerActive) {
    splitDivider.style.left = "";
    splitDivider.style.top = "";
    splitDivider.style.height = "";
    splitDivider.style.bottom = "";
    return;
  }

  // Divider rides on the stage rect, not the canvas rect — pan/zoom move the
  // image but the comparison line stays anchored to the visible window.
  const stageRect = stageCanvas.getBoundingClientRect();
  const splitX = Math.round(clamp(view.splitPosition, 0, 1) * stageRect.width);
  splitDivider.style.left = `${splitX}px`;
  splitDivider.style.top = "0";
  splitDivider.style.bottom = "0";
  splitDivider.style.height = "";
}

function syncZoomToggle(zoomToggle, canvas) {
  if (!zoomToggle) return;
  const label = zoomToggle.querySelector(".zoom-label");
  const accuracy = zoomToggle.querySelector(".zoom-accuracy");
  if (!label || !accuracy) return;

  const { view } = getState();
  let effectiveScale;
  let displayPercent;
  if (view.fit) {
    if (canvas?.width && canvas?.height) {
      const rect = canvas.getBoundingClientRect();
      effectiveScale = rect.width > 0 ? rect.width / canvas.width : 1;
    } else {
      effectiveScale = 1;
    }
    displayPercent = Math.round(effectiveScale * 100);
    label.textContent = displayPercent === 100 ? "Fit · 1:1" : `Fit · ${displayPercent}%`;
  } else {
    effectiveScale = view.zoom;
    displayPercent = Math.round(view.zoom * 100);
    label.textContent = `${displayPercent}%`;
  }

  // 1:1 (or zoomed in) on a sharp dither canvas = the user is looking at the
  // exact pixels that will be exported. Anything below that is a downscale
  // approximation. During playback the effect chain itself runs at half
  // resolution to keep up, so even a 1:1 zoom shows an approximation —
  // the badge has to call that out so the user knows pause = truth.
  const video = document.getElementById("sourceVideo");
  const playing = video && !video.paused && !video.ended && video.readyState >= 2;
  const zoomExact = effectiveScale >= 0.999;
  if (playing) {
    accuracy.dataset.state = "approx";
    accuracy.textContent = "playback · half-res";
  } else if (zoomExact) {
    accuracy.dataset.state = "exact";
    accuracy.textContent = "1:1 export-accurate";
  } else {
    accuracy.dataset.state = "approx";
    accuracy.textContent = "approx · downscaled";
  }
}

// Right-click context menu ----------------------------------------

function wireContextMenu(stage) {
  const menu = buildContextMenu();
  document.body.appendChild(menu);

  stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    syncContextMenu(menu);
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    menu.classList.remove("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target)) menu.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.classList.add("hidden");
  });
}

function buildContextMenu() {
  const menu = document.createElement("div");
  menu.className = "context-menu floating-card hidden";
  menu.innerHTML = `
    <button data-mitem="export-frame">Export Current Frame…</button>
    <button data-mitem="reset-zoom">Reset Zoom</button>
    <button data-mitem="toggle-inspector">Toggle Pixel Inspector</button>
  `;
  menu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-mitem]");
    if (!btn || btn.disabled) return;
    switch (btn.dataset.mitem) {
      case "export-frame":
        await openExport();
        break;
      case "reset-zoom":
        resetZoom();
        break;
      case "toggle-inspector":
        togglePixelInspector();
        break;
    }
    menu.classList.add("hidden");
  });
  return menu;
}

function syncContextMenu(menu) {
  const exportFrameButton = menu.querySelector('[data-mitem="export-frame"]');
  if (exportFrameButton) {
    exportFrameButton.disabled = !getState().source.loaded;
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
