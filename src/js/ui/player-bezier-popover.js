import { dispatch, getState } from "../state.js";
import {
  TIMELINE_EASING_PRESETS,
  findMatchingEasingPreset,
  getTimelineEasingPreset,
  getTimelineKeyframe,
  normalizeTimeline,
  updateTimelineKeyframe,
} from "../timeline.js";
import { escapeHtml } from "./utils.js";
import {
  clampBezierControlValue,
  formatBezierControlValue,
} from "./player-format.js";
import { createEasingPatch } from "./player-easing.js";

const BEZIER_SVG_WIDTH = 100;
const BEZIER_SVG_HEIGHT = 100;
const BEZIER_HANDLE_Y_MIN = -1.5;
const BEZIER_HANDLE_Y_MAX = 2.5;

const bezierPopover = {
  el: null,
  anchor: null,
  trackId: null,
  keyframeId: null,
  drag: null,
  outsideHandler: null,
  keyHandler: null,
};

export function initPlayerBezierPopover(_deps = {}) {}

export function getBezierPopoverState() {
  return bezierPopover;
}

export function syncBezierPopover() {
  if (bezierPopover.el) renderBezierPopoverContent();
}

export function renderBezierTriggerButton(track, keyframe) {
  const easing = keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const isStep = easing.type === "step";
  const cp = isStep ? [0, 0, 1, 1] : (easing.controlPoints ?? [0, 0, 1, 1]);
  const presetMatch = isStep ? "step" : findMatchingEasingPreset(easing);
  const presetMeta = presetMatch === "step"
    ? { label: "Step" }
    : (presetMatch ? getTimelineEasingPreset(presetMatch) : null);
  const label = presetMeta?.label ?? "Custom";
  const x1 = cp[0] * 100, y1 = (1 - cp[1]) * 100;
  const x2 = cp[2] * 100, y2 = (1 - cp[3]) * 100;
  const curveD = isStep
    ? "M 0 100 L 100 100 L 100 0"
    : `M 0 100 C ${x1.toFixed(2)} ${y1.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}, 100 0`;
  return `
    <button
      type="button"
      class="bezier-trigger"
      data-bezier-trigger
      data-keyframe-track-id="${escapeHtml(track.id)}"
      data-keyframe-id="${escapeHtml(keyframe.id)}"
      aria-haspopup="dialog"
    >
      <svg viewBox="-10 -10 120 120" aria-hidden="true">
        <path d="${curveD}" />
      </svg>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

export function openBezierPopover(anchor, trackId, keyframeId) {
  if (bezierPopover.el && bezierPopover.trackId === trackId && bezierPopover.keyframeId === keyframeId) {
    closeBezierPopover();
    return;
  }
  closeBezierPopover();
  const popover = document.createElement("div");
  popover.className = "player-more-popover bezier-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Easing curve editor");
  popover.addEventListener("pointerdown", onBezierPopoverPointerDown);
  popover.addEventListener("keydown", onBezierPopoverControlKeyDown);
  popover.addEventListener("click", onBezierPopoverClick);

  bezierPopover.el = popover;
  bezierPopover.anchor = anchor;
  bezierPopover.trackId = trackId;
  bezierPopover.keyframeId = keyframeId;
  document.body.appendChild(popover);
  renderBezierPopoverContent();
  positionBezierPopover();

  setTimeout(() => {
    bezierPopover.outsideHandler = onBezierPopoverOutsidePointer;
    bezierPopover.keyHandler = onBezierPopoverKey;
    document.addEventListener("pointerdown", bezierPopover.outsideHandler, true);
    document.addEventListener("keydown", bezierPopover.keyHandler);
  }, 0);
}

function closeBezierPopover() {
  if (!bezierPopover.el) return;
  bezierPopover.el.remove();
  bezierPopover.el = null;
  bezierPopover.anchor = null;
  bezierPopover.trackId = null;
  bezierPopover.keyframeId = null;
  if (bezierPopover.outsideHandler) {
    document.removeEventListener("pointerdown", bezierPopover.outsideHandler, true);
    bezierPopover.outsideHandler = null;
  }
  if (bezierPopover.keyHandler) {
    document.removeEventListener("keydown", bezierPopover.keyHandler);
    bezierPopover.keyHandler = null;
  }
  if (bezierPopover.drag) {
    document.removeEventListener("pointermove", onBezierHandlePointerMove);
    document.removeEventListener("pointerup", onBezierHandlePointerUp);
    document.removeEventListener("pointercancel", onBezierHandlePointerUp);
    bezierPopover.drag = null;
  }
}

function renderBezierPopoverContent() {
  if (!bezierPopover.el) return;
  const { trackId, keyframeId } = bezierPopover;
  const { timeline, source } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const found = getTimelineKeyframe(normalized, trackId, keyframeId);
  if (!found) {
    closeBezierPopover();
    return;
  }
  const focusedHandle = bezierPopover.el.contains(document.activeElement)
    ? document.activeElement?.dataset?.bezierHandle
    : null;
  bezierPopover.el.innerHTML = renderBezierPopoverHTML(found.track, found.keyframe);
  if (focusedHandle) {
    bezierPopover.el.querySelector(`[data-bezier-handle="${focusedHandle}"]`)?.focus();
  }
}

function renderBezierPopoverHTML(track, keyframe) {
  const easing = keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const isStep = easing.type === "step";
  const cp = isStep ? [0, 0, 1, 1] : (easing.controlPoints ?? [0, 0, 1, 1]);
  const x1 = cp[0] * 100, y1 = (1 - cp[1]) * 100;
  const x2 = cp[2] * 100, y2 = (1 - cp[3]) * 100;
  const presetMatch = isStep ? "step" : findMatchingEasingPreset(easing);
  const curveD = isStep
    ? "M 0 100 L 100 100 L 100 0"
    : `M 0 100 C ${x1.toFixed(2)} ${y1.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}, 100 0`;
  const presetChips = TIMELINE_EASING_PRESETS.map((preset) => `
    <button
      type="button"
      class="bezier-preset-chip${preset.name === presetMatch ? " is-active" : ""}"
      data-bezier-preset="${escapeHtml(preset.name)}"
      title="${escapeHtml(preset.label)}"
    >${escapeHtml(preset.label)}</button>
  `).join("");
  return `
    <div class="popover-section bezier-curve-section">
      <svg
        class="bezier-curve"
        viewBox="-15 -65 130 220"
        preserveAspectRatio="xMidYMid meet"
        data-bezier-svg
      >
        <rect x="0" y="0" width="100" height="100" class="bezier-curve-frame" />
        ${!isStep ? `<line x1="0" y1="100" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}" class="bezier-curve-tangent" />` : ""}
        ${!isStep ? `<line x1="100" y1="0" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" class="bezier-curve-tangent" />` : ""}
        <path d="${curveD}" class="bezier-curve-path" />
        <circle cx="0" cy="100" r="3" class="bezier-curve-anchor" />
        <circle cx="100" cy="0" r="3" class="bezier-curve-anchor" />
        ${!isStep ? `<circle cx="${x1.toFixed(2)}" cy="${y1.toFixed(2)}" r="7" class="bezier-curve-handle" data-bezier-handle="p1" tabindex="0" focusable="true" role="slider" aria-label="Bezier control point 1" aria-valuetext="x ${formatBezierControlValue(cp[0])}, y ${formatBezierControlValue(cp[1])}" />` : ""}
        ${!isStep ? `<circle cx="${x2.toFixed(2)}" cy="${y2.toFixed(2)}" r="7" class="bezier-curve-handle" data-bezier-handle="p2" tabindex="0" focusable="true" role="slider" aria-label="Bezier control point 2" aria-valuetext="x ${formatBezierControlValue(cp[2])}, y ${formatBezierControlValue(cp[3])}" />` : ""}
      </svg>
      <div class="bezier-curve-readout">
        ${isStep ? "step" : `cubic-bezier(${cp.map((v) => Number(v).toFixed(2)).join(", ")})`}
      </div>
    </div>
    <div class="popover-section">
      <div class="popover-label">Presets</div>
      <div class="bezier-preset-grid">${presetChips}</div>
    </div>
    <div class="popover-section">
      <button
        type="button"
        class="popover-row bezier-step-toggle${isStep ? " is-active" : ""}"
        data-bezier-step
      >${isStep ? "Step easing · on" : "Step easing · off"}</button>
    </div>
  `;
}

function positionBezierPopover() {
  if (!bezierPopover.el || !bezierPopover.anchor) return;
  const rect = bezierPopover.anchor.getBoundingClientRect();
  const popover = bezierPopover.el;
  const margin = 6;
  popover.style.position = "fixed";
  popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  popover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + margin)}px`;
}

function onBezierPopoverControlKeyDown(event) {
  const handle = event.target.closest("[data-bezier-handle]");
  if (!handle || !bezierPopover.el?.contains(handle)) return;
  if (!handleBezierPopoverKeyDown(event, handle.dataset.bezierHandle)) return;
}

function handleBezierPopoverKeyDown(event, handleName) {
  if (
    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) ||
    event.metaKey ||
    event.ctrlKey
  ) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();

  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId) return true;
  const { timeline } = getState();
  const found = getTimelineKeyframe(timeline, trackId, keyframeId);
  if (!found) return true;

  const easing = found.keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const cp = easing.type === "step"
    ? [0, 0, 1, 1]
    : [...(easing.controlPoints ?? [0, 0, 1, 1])];
  const step = event.shiftKey ? 0.1 : event.altKey ? 0.001 : 0.01;
  const index = handleName === "p2" ? 2 : 0;
  if (event.key === "ArrowLeft") cp[index] = clampBezierControlValue(cp[index] - step, 0, 1);
  else if (event.key === "ArrowRight") cp[index] = clampBezierControlValue(cp[index] + step, 0, 1);
  else if (event.key === "ArrowUp") cp[index + 1] = clampBezierControlValue(cp[index + 1] + step, BEZIER_HANDLE_Y_MIN, BEZIER_HANDLE_Y_MAX);
  else if (event.key === "ArrowDown") cp[index + 1] = clampBezierControlValue(cp[index + 1] - step, BEZIER_HANDLE_Y_MIN, BEZIER_HANDLE_Y_MAX);

  dispatch(
    "timeline",
    updateTimelineKeyframe(timeline, {
      trackId,
      keyframeId,
      patch: {
        easing: { type: "bezier", controlPoints: cp },
        interpolation: "linear",
        inTangent: null,
        outTangent: null,
      },
    })
  );
  return true;
}

function onBezierPopoverPointerDown(event) {
  const handle = event.target.closest("[data-bezier-handle]");
  if (!handle) return;
  const svg = handle.closest("[data-bezier-svg]");
  if (!svg) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  bezierPopover.drag = {
    handle: handle.dataset.bezierHandle === "p2" ? "p2" : "p1",
    rect,
    viewBox: { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height },
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch (_) {
    /* Some pointer types reject capture — drag still works via document listeners. */
  }
  document.addEventListener("pointermove", onBezierHandlePointerMove);
  document.addEventListener("pointerup", onBezierHandlePointerUp);
  document.addEventListener("pointercancel", onBezierHandlePointerUp);
}

function onBezierHandlePointerMove(event) {
  const drag = bezierPopover.drag;
  if (!drag) return;
  const { rect, viewBox, handle } = drag;
  const u = (event.clientX - rect.left) / rect.width;
  const v = (event.clientY - rect.top) / rect.height;
  const svgX = viewBox.x + u * viewBox.width;
  const svgY = viewBox.y + v * viewBox.height;
  const cpX = Math.max(0, Math.min(1, svgX / BEZIER_SVG_WIDTH));
  const cpY = Math.max(
    BEZIER_HANDLE_Y_MIN,
    Math.min(BEZIER_HANDLE_Y_MAX, (BEZIER_SVG_HEIGHT - svgY) / BEZIER_SVG_HEIGHT)
  );

  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId) return;
  const { timeline } = getState();
  const found = getTimelineKeyframe(timeline, trackId, keyframeId);
  if (!found) return;
  const easing = found.keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const base = easing.type === "step"
    ? [0, 0, 1, 1]
    : [...(easing.controlPoints ?? [0, 0, 1, 1])];
  if (handle === "p2") {
    base[2] = cpX;
    base[3] = cpY;
  } else {
    base[0] = cpX;
    base[1] = cpY;
  }
  dispatch(
    "timeline",
    updateTimelineKeyframe(timeline, {
      trackId,
      keyframeId,
      patch: {
        easing: { type: "bezier", controlPoints: base },
        interpolation: "linear",
        inTangent: null,
        outTangent: null,
      },
    })
  );
}

function onBezierHandlePointerUp() {
  if (!bezierPopover.drag) return;
  bezierPopover.drag = null;
  document.removeEventListener("pointermove", onBezierHandlePointerMove);
  document.removeEventListener("pointerup", onBezierHandlePointerUp);
  document.removeEventListener("pointercancel", onBezierHandlePointerUp);
}

function onBezierPopoverClick(event) {
  const preset = event.target.closest("[data-bezier-preset]");
  if (preset) {
    event.preventDefault();
    event.stopPropagation();
    applyBezierPopoverPreset(preset.dataset.bezierPreset);
    return;
  }
  const step = event.target.closest("[data-bezier-step]");
  if (step) {
    event.preventDefault();
    event.stopPropagation();
    toggleBezierPopoverStep();
  }
}

function applyBezierPopoverPreset(name) {
  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId || !name) return;
  const patch = createEasingPatch(name);
  dispatch("timeline", updateTimelineKeyframe(getState().timeline, { trackId, keyframeId, patch }));
}

function toggleBezierPopoverStep() {
  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId) return;
  const found = getTimelineKeyframe(getState().timeline, trackId, keyframeId);
  if (!found) return;
  const isStep = found.keyframe.easing?.type === "step";
  const patch = isStep ? createEasingPatch("smooth") : createEasingPatch("step");
  dispatch("timeline", updateTimelineKeyframe(getState().timeline, { trackId, keyframeId, patch }));
}

function onBezierPopoverOutsidePointer(event) {
  if (!bezierPopover.el) return;
  if (bezierPopover.el.contains(event.target)) return;
  if (event.target.closest?.("[data-bezier-trigger]")) return;
  closeBezierPopover();
}

function onBezierPopoverKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeBezierPopover();
  }
}
