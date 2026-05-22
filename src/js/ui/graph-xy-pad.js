// XY pad subsystem — surface render, pointer drag, keyboard
// nudge, and the commit path that mirrors values back into
// number/range siblings + timeline keyframes. Used by Transform
// (translate) and a few stylize nodes that expose 2D coordinates.
//
// Pointer entry happens from graph-shell's onInspectorPointerDown
// via `startXyPadInteraction`. Arrow-key nudge comes through
// `handleXyPadKeyDown` called from onInspectorKeyDown. Render
// helpers (`renderXyPadField`, `formatXyPadReadout`,
// `formatXyPadNumber`) are pure string builders.

import { escapeHtml } from "./utils.js";
import { getSelectedNode, updateNodeParams } from "../graph.js";
import {
  commitParamValueToTimeline,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import { syncTimelineButtons } from "./graph-inspector-fields.js";

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

let inspectorEl = null;
let cssEscape = (value) => String(value);
const callbacks = {
  renderInspector: () => {},
  setInspectorEditing: () => {},
};

export function initXyPad(refs) {
  inspectorEl = refs.inspectorEl ?? null;
  cssEscape = typeof refs.cssEscape === "function"
    ? refs.cssEscape
    : ((value) => String(value));
  callbacks.renderInspector = refs.renderInspector ?? (() => {});
  callbacks.setInspectorEditing = refs.setInspectorEditing ?? (() => {});
}

// --- Render ---------------------------------------------------------

export function renderXyPadField(label, xKey, yKey, xValue, yValue, options = {}) {
  const min = Number.isFinite(Number(options.min)) ? Number(options.min) : -1;
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : 1;
  const step = Number.isFinite(Number(options.step)) && Number(options.step) > 0
    ? Number(options.step)
    : 1;
  const unit = options.unit ?? "";
  const yAxis = options.yAxis === "up" ? "up" : "down";
  const range = Math.max(max - min, Number.EPSILON);
  const x = clamp(roundToStep(Number(xValue), step, min), min, max);
  const y = clamp(roundToStep(Number(yValue), step, min), min, max);
  const xPct = ((x - min) / range) * 100;
  const yPct = yAxis === "down"
    ? ((y - min) / range) * 100
    : (1 - (y - min) / range) * 100;
  return `
    <div class="field xy-pad-field" data-xy-pad-field="${escapeHtml(`${xKey}:${yKey}`)}">
      <div class="xy-pad-header">
        <div class="xy-pad-title">
          <span class="field-label-text">${escapeHtml(label)}</span>
          <span class="xy-pad-chip">X/Y</span>
        </div>
        <span class="xy-pad-readout" data-xy-pad-readout>${escapeHtml(formatXyPadReadout(x, y, unit))}</span>
      </div>
      <button
        type="button"
        class="xy-pad-surface"
        data-xy-pad
        data-xy-pad-x="${escapeHtml(xKey)}"
        data-xy-pad-y="${escapeHtml(yKey)}"
        data-xy-pad-value-x="${x}"
        data-xy-pad-value-y="${y}"
        data-xy-pad-min="${min}"
        data-xy-pad-max="${max}"
        data-xy-pad-step="${step}"
        data-xy-pad-y-axis="${escapeHtml(yAxis)}"
        data-xy-pad-unit="${escapeHtml(unit)}"
        style="--xy-pad-x:${xPct}%; --xy-pad-y:${yPct}%"
        aria-label="${escapeHtml(label)} XY pad"
      >
        <span class="xy-pad-grid"></span>
        <span class="xy-pad-guide xy-pad-guide--x"></span>
        <span class="xy-pad-guide xy-pad-guide--y"></span>
        <span class="xy-pad-handle" aria-hidden="true"><span></span></span>
      </button>
    </div>
  `;
}

function formatXyPadReadout(x, y, unit = "") {
  return `${formatXyPadNumber(x)}${unit}, ${formatXyPadNumber(y)}${unit}`;
}

function formatXyPadNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, "");
}

// --- Pointer drag --------------------------------------------------

export function startXyPadInteraction(event, pad) {
  if (event.button !== 0) return;
  const node = getSelectedNode();
  if (!node || !resolveXyPadKeys(pad)) return;
  event.preventDefault();
  event.stopPropagation();

  callbacks.setInspectorEditing(true);
  document.body.classList.add("dragging-xy-pad");
  pad.focus?.();

  const commitFromPointer = (ev) => {
    const next = readXyPadPointerValue(pad, ev.clientX, ev.clientY);
    commitXyPadValue(pad, next.x, next.y);
  };

  commitFromPointer(event);

  try {
    pad.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    if (ev.buttons !== undefined && !(ev.buttons & 1)) return;
    commitFromPointer(ev);
  };

  const onUp = () => {
    pad.removeEventListener("pointermove", onMove);
    pad.removeEventListener("pointerup", onUp);
    pad.removeEventListener("pointercancel", onUp);
    callbacks.setInspectorEditing(false);
    document.body.classList.remove("dragging-xy-pad");
    try {
      pad.releasePointerCapture(event.pointerId);
    } catch {}
    callbacks.renderInspector();
  };

  pad.addEventListener("pointermove", onMove);
  pad.addEventListener("pointerup", onUp);
  pad.addEventListener("pointercancel", onUp);
}

// Arrow-key nudge. Returns true when the key was handled so the
// caller (onInspectorKeyDown) can skip its remaining branches.
export function handleXyPadKeyDown(event, pad) {
  let dx = 0;
  let dy = 0;
  switch (event.key) {
    case "ArrowLeft":
      dx = -1;
      break;
    case "ArrowRight":
      dx = 1;
      break;
    case "ArrowUp":
      dy = resolveXyPadYAxis(pad) === "down" ? -1 : 1;
      break;
    case "ArrowDown":
      dy = resolveXyPadYAxis(pad) === "down" ? 1 : -1;
      break;
    default:
      return false;
  }

  event.preventDefault();
  event.stopPropagation();

  const step = resolveXyPadStep(pad) * (event.shiftKey ? 10 : 1);
  const current = readXyPadCurrentValue(pad);
  callbacks.setInspectorEditing(true);
  commitXyPadValue(pad, current.x + dx * step, current.y + dy * step);
  callbacks.setInspectorEditing(false);
  return true;
}

// --- Resolve / read helpers ----------------------------------------

function resolveXyPadKeys(pad) {
  const xKey = pad?.dataset?.xyPadX;
  const yKey = pad?.dataset?.xyPadY;
  if (!xKey || !yKey) return null;
  return { xKey, yKey };
}

function resolveXyPadBounds(pad) {
  const min = Number(pad?.dataset?.xyPadMin ?? -1);
  const max = Number(pad?.dataset?.xyPadMax ?? 1);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { min: -1, max: 1 };
  }
  return min < max ? { min, max } : { min: max, max: min };
}

function resolveXyPadStep(pad) {
  const step = Number(pad?.dataset?.xyPadStep ?? 1);
  return Number.isFinite(step) && step > 0 ? step : 1;
}

function resolveXyPadYAxis(pad) {
  return pad?.dataset?.xyPadYAxis === "up" ? "up" : "down";
}

function readXyPadPointerValue(pad, clientX, clientY) {
  const rect = pad.getBoundingClientRect();
  const { min, max } = resolveXyPadBounds(pad);
  const range = Math.max(max - min, Number.EPSILON);
  const normalizedX = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const normalizedY = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  return {
    x: min + normalizedX * range,
    y: resolveXyPadYAxis(pad) === "down"
      ? min + normalizedY * range
      : min + (1 - normalizedY) * range,
  };
}

function readXyPadCurrentValue(pad) {
  return {
    x: Number(pad?.dataset?.xyPadValueX ?? 0),
    y: Number(pad?.dataset?.xyPadValueY ?? 0),
  };
}

// --- Commit + sync -------------------------------------------------

function commitXyPadValue(pad, x, y) {
  const node = getSelectedNode();
  const keys = resolveXyPadKeys(pad);
  if (!node || !keys) return null;

  const next = normalizeXyPadValue(pad, x, y);
  updateNodeParams(node.id, {
    [keys.xKey]: next.x,
    [keys.yKey]: next.y,
  });
  commitParamPairToTimeline(node.id, keys.xKey, keys.yKey, next.x, next.y);
  syncXyPadSurface(pad, next.x, next.y);
  syncParamControlsByKey(keys.xKey, next.x);
  syncParamControlsByKey(keys.yKey, next.y);
  syncTimelineButtons();
  return next;
}

function normalizeXyPadValue(pad, x, y) {
  const { min, max } = resolveXyPadBounds(pad);
  const step = resolveXyPadStep(pad);
  return {
    x: clamp(roundToStep(x, step, min), min, max),
    y: clamp(roundToStep(y, step, min), min, max),
  };
}

function commitParamPairToTimeline(nodeId, xKey, yKey, xValue, yValue) {
  if (!commitParamValueToTimeline(nodeId, xKey, xValue)) {
    updateParamKeyframeAtCurrentTime(nodeId, xKey, xValue);
  }
  if (!commitParamValueToTimeline(nodeId, yKey, yValue)) {
    updateParamKeyframeAtCurrentTime(nodeId, yKey, yValue);
  }
}

function syncXyPadSurface(pad, x, y) {
  if (!pad) return;
  const { min, max } = resolveXyPadBounds(pad);
  const range = Math.max(max - min, Number.EPSILON);
  const clampedX = clamp(Number(x), min, max);
  const clampedY = clamp(Number(y), min, max);
  const xPct = ((clampedX - min) / range) * 100;
  const yPct = resolveXyPadYAxis(pad) === "down"
    ? ((clampedY - min) / range) * 100
    : (1 - (clampedY - min) / range) * 100;
  pad.dataset.xyPadValueX = String(clampedX);
  pad.dataset.xyPadValueY = String(clampedY);
  pad.style.setProperty("--xy-pad-x", `${xPct}%`);
  pad.style.setProperty("--xy-pad-y", `${yPct}%`);
  const field = pad.closest("[data-xy-pad-field]");
  const readout = field?.querySelector("[data-xy-pad-readout]");
  if (readout) readout.textContent = formatXyPadReadout(clampedX, clampedY, pad.dataset.xyPadUnit);
}

function syncParamControlsByKey(paramKey, value) {
  if (!paramKey || !inspectorEl) return;
  const normalized = String(value);
  const controls = inspectorEl.querySelectorAll(`[data-node-param="${cssEscape(paramKey)}"]`);
  for (const control of controls) {
    if (control.type === "checkbox") continue;
    if (control.value !== normalized) control.value = normalized;
  }
}

function roundToStep(value, step, min = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  if (!Number.isFinite(step) || step <= 0) return numeric;
  const rounded = Math.round((numeric - min) / step) * step + min;
  const decimals = stepDecimals(step);
  return Number(rounded.toFixed(decimals));
}

function stepDecimals(step) {
  const text = String(step);
  if (!text.includes(".")) return 0;
  return Math.min(6, text.split(".")[1].length);
}
