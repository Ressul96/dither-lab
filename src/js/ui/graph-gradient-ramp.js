// Gradient ramp UI for the inspector — bar render, draggable
// stops, keyboard nudge, add/remove buttons, and the
// gradient-stop commit path (single source of truth for both
// the ramp's own stop dragging and the color picker's
// gradient-stop writes).
//
// Three callsites in graph-shell's event handlers reach in:
//   * onInspectorClick     → handleGradientRampClick
//   * onInspectorKeyDown   → handleGradientRampKeyDown
//   * onInspectorPointerDown → startGradientRampStopDrag
// Plus the small `commitGradientMapStopColor` /
// `syncGradientStopSiblingControls` pair used by hex inputs in
// gradient-stop color fields outside the ramp.
//
// The color picker module ends up here via callbacks that
// graph-shell wires at boot: `syncGradientRampElements` and
// `commitGradientStopColorTarget`. Doing the wiring through
// graph-shell instead of a direct import avoids a circular
// edge between the picker and the ramp.

import { escapeHtml } from "./utils.js";
import { normalizeHex } from "../color.js";
import { pushHistory } from "../state.js";
import { getSelectedNode, updateNodeParams } from "../graph.js";
import { hexToRgb255, rgbChannelsToHex } from "./graph-color-math.js";
import {
  commitParamValueToTimeline,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import { closeColorPicker, renderColorPickerControl } from "./graph-color-picker.js";

export const GRADIENT_RAMP_MAX_STOPS = 8;
const GRADIENT_RAMP_STOP_GAP = 0.005;

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);
const clamp01 = (value) => clamp(value, 0, 1);

let inspectorEl = null;
let cssEscape = (value) => String(value);
const callbacks = {
  renderInspector: () => {},
  setInspectorEditing: () => {},
};

let gradientRampState = null;

export function initGradientRamp(refs) {
  inspectorEl = refs.inspectorEl ?? null;
  cssEscape = typeof refs.cssEscape === "function"
    ? refs.cssEscape
    : ((value) => String(value));
  callbacks.renderInspector = refs.renderInspector ?? (() => {});
  callbacks.setInspectorEditing = refs.setInspectorEditing ?? (() => {});
}

// --- Type check -------------------------------------------------------

export function isGradientRampNode(node) {
  return Boolean(node && (node.type === "gradient" || node.type === "gradient-map" || node.type === "scene-grade"));
}

// --- Render -----------------------------------------------------------

export function renderGradientRampField(label, paramKey, value, options = {}) {
  const node = getSelectedNode();
  const safeKey = escapeHtml(paramKey);
  const stops = normalizeGradientRampEditableStops(value);
  const maxStops = Math.max(2, Math.round(Number(options.maxStops) || GRADIENT_RAMP_MAX_STOPS));
  const targetId = gradientRampTargetId(node?.id, paramKey);
  const selectedIndex = getGradientRampSelectedIndex(targetId, stops);
  const selectedStop = stops[selectedIndex] ?? stops[0] ?? { pos: 0, color: "#111111" };
  const canAdd = stops.length < maxStops;
  const canDelete = selectedIndex > 0 && selectedIndex < stops.length - 1 && stops.length > 2;
  const readout = `${Math.round(clamp01(selectedStop.pos) * 100)}%`;

  return `
    <div
      class="field gradient-ramp-field"
      data-gradient-ramp-target="${escapeHtml(targetId)}"
      data-gradient-ramp-node="${escapeHtml(node?.id ?? "")}"
      data-gradient-ramp-param="${safeKey}"
      data-gradient-ramp-max-stops="${maxStops}"
    >
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      <div class="gradient-ramp-shell">
        <div
          class="gradient-ramp-bar"
          data-gradient-ramp-bar
          style="background:${escapeHtml(buildGradientRampCss(stops))}"
        >
          ${stops.map((stop, index) => renderGradientRampStop(stop, index, selectedIndex)).join("")}
        </div>
        <div class="gradient-ramp-actions">
          <button
            type="button"
            class="btn gradient-ramp-button"
            data-gradient-ramp-action="add"
            ${canAdd ? "" : "disabled"}
          >Add</button>
          <button
            type="button"
            class="btn gradient-ramp-button"
            data-gradient-ramp-action="delete"
            ${canDelete ? "" : "disabled"}
          >Remove</button>
          <span class="gradient-ramp-readout" data-gradient-ramp-readout>${escapeHtml(readout)}</span>
        </div>
        <div class="gradient-ramp-selected color-field">
          ${renderColorPickerControl({
            label: `${label} stop`,
            value: selectedStop.color,
            fallback: selectedIndex === 0 ? "#111111" : "#ffffff",
            target: {
              kind: "gradient-stop",
              stopIndex: selectedIndex,
              paramKey,
            },
            inputAttrs: `data-gradient-map-stop-color="${selectedIndex}" data-gradient-stop-param="${safeKey}" data-input-kind="gradient-stop-hex"`,
          })}
        </div>
      </div>
    </div>
  `;
}

function renderGradientRampStop(stop, index, selectedIndex) {
  const color = normalizeHex(stop?.color, "#ffffff");
  const position = clamp01(Number(stop?.pos)) * 100;
  const isSelected = index === selectedIndex;
  return `
    <button
      type="button"
      class="gradient-ramp-stop${isSelected ? " is-selected" : ""}${index === 0 || position >= 100 ? " is-endpoint" : ""}"
      data-gradient-ramp-stop="${index}"
      style="left:${position}%; --gradient-stop-color:${escapeHtml(color)}"
      aria-label="Gradient stop ${index + 1}"
      aria-pressed="${isSelected ? "true" : "false"}"
      title="${Math.round(position)}%"
    ></button>
  `;
}

// --- Event handlers ---------------------------------------------------

export function handleGradientRampClick(event, control) {
  const target = resolveGradientRampTarget(control);
  if (!target) return;

  if (control.matches("[data-gradient-ramp-stop]")) {
    selectGradientRampStop(target, Number(control.dataset.gradientRampStop));
    return;
  }

  const action = control.dataset.gradientRampAction;
  if (action === "add") {
    addGradientRampStop(target, findGradientRampInsertPosition(readGradientRampStops(target)));
    return;
  }
  if (action === "delete") {
    removeSelectedGradientRampStop(target);
    return;
  }

  if (control.matches("[data-gradient-ramp-bar]")) {
    addGradientRampStop(target, gradientRampPositionFromEvent(control, event.clientX));
  }
}

export function handleGradientRampKeyDown(event, stop) {
  const target = resolveGradientRampTarget(stop);
  if (!target) return false;
  const index = Number(stop.dataset.gradientRampStop);
  if (!Number.isFinite(index)) return false;

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectGradientRampStop(target, index);
    return true;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    selectGradientRampStop(target, index, { render: false });
    removeSelectedGradientRampStop(target);
    return true;
  }

  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;

  event.preventDefault();
  const stops = readGradientRampStops(target);
  if (index <= 0 || index >= stops.length - 1) {
    selectGradientRampStop(target, index);
    return true;
  }

  const direction = event.key === "ArrowLeft" ? -1 : 1;
  const step = event.shiftKey ? 0.05 : 0.01;
  gradientRampState = { targetId: target.targetId, selectedIndex: index };
  closeColorPicker();
  commitGradientRampStopPosition(target, index, stops[index].pos + direction * step);
  callbacks.renderInspector();
  return true;
}

export function startGradientRampStopDrag(event, stop) {
  if (event.button !== 0) return;
  const target = resolveGradientRampTarget(stop);
  if (!target) return;
  const root = stop.closest("[data-gradient-ramp-target]");
  const index = Number(stop.dataset.gradientRampStop);
  const stops = readGradientRampStops(target);
  if (!Number.isFinite(index) || index < 0 || index >= stops.length) return;

  gradientRampState = { targetId: target.targetId, selectedIndex: index };
  closeColorPicker();
  if (index === 0 || index === stops.length - 1) return;

  event.preventDefault();
  event.stopPropagation();
  callbacks.setInspectorEditing(true);
  document.body.classList.add("dragging-gradient-ramp");

  // F17.3d: snapshot the pre-drag stops so onUp can record a single history
  // entry covering the whole drag rather than one per pointermove commit.
  const undoStopsBefore = stops.map((s) => ({ ...s }));

  const bar = root?.querySelector("[data-gradient-ramp-bar]");
  const commitFromPointer = (ev) => {
    if (!bar) return;
    const nextPosition = gradientRampPositionFromEvent(bar, ev.clientX);
    const nextStops = commitGradientRampStopPosition(target, index, nextPosition);
    if (nextStops) syncGradientRampRoot(root, nextStops, index);
  };

  commitFromPointer(event);

  const onMove = (ev) => {
    if (ev.buttons !== undefined && !(ev.buttons & 1)) return;
    commitFromPointer(ev);
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    callbacks.setInspectorEditing(false);
    document.body.classList.remove("dragging-gradient-ramp");
    // F17.3d flush
    pushGradientRampUndoEntry(target, undoStopsBefore);
    callbacks.renderInspector();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

// --- Selection / add / remove ----------------------------------------

function selectGradientRampStop(target, index, options = {}) {
  const stops = readGradientRampStops(target);
  const selectedIndex = Math.max(0, Math.min(Math.max(0, stops.length - 1), Math.round(index)));
  gradientRampState = { targetId: target.targetId, selectedIndex };
  closeColorPicker();
  if (options.render === false) return;
  callbacks.renderInspector();
}

function addGradientRampStop(target, position) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return;
  const stops = readGradientRampStops(target);
  if (stops.length >= target.maxStops) return;
  // F17.3d: snapshot before so undo restores the pre-add state.
  const stopsBefore = stops.map((s) => ({ ...s }));
  const pos = clamp(Number(position), GRADIENT_RAMP_STOP_GAP, 1 - GRADIENT_RAMP_STOP_GAP);
  const color = sampleGradientRampColor(stops, pos);
  const nextStops = normalizeGradientRampEditableStops([...stops, { pos, color }]);
  const selectedIndex = findClosestGradientRampStopIndex(nextStops, pos, color);
  gradientRampState = { targetId: target.targetId, selectedIndex };
  closeColorPicker();
  commitGradientRampStops(node.id, target.paramKey, nextStops);
  pushGradientRampUndoEntry(target, stopsBefore);
  callbacks.renderInspector();
}

function removeSelectedGradientRampStop(target) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return;
  const stops = readGradientRampStops(target);
  const selectedIndex = getGradientRampSelectedIndex(target.targetId, stops);
  if (selectedIndex <= 0 || selectedIndex >= stops.length - 1 || stops.length <= 2) return;
  // F17.3d: snapshot before remove so undo brings the stop back.
  const stopsBefore = stops.map((s) => ({ ...s }));
  const nextStops = stops.filter((_, index) => index !== selectedIndex);
  const nextSelectedIndex = Math.max(0, selectedIndex - 1);
  gradientRampState = { targetId: target.targetId, selectedIndex: nextSelectedIndex };
  closeColorPicker();
  commitGradientRampStops(node.id, target.paramKey, nextStops);
  pushGradientRampUndoEntry(target, stopsBefore);
  callbacks.renderInspector();
}

// --- Commit -----------------------------------------------------------

function commitGradientRampStopPosition(target, index, position) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return null;
  const stops = readGradientRampStops(target);
  if (index <= 0 || index >= stops.length - 1) return stops;
  const nextStops = stops.map((stop) => ({ ...stop }));
  nextStops[index].pos = constrainGradientRampStopPosition(nextStops, index, position);
  return commitGradientRampStops(node.id, target.paramKey, nextStops);
}

export function commitGradientRampStops(nodeId, paramKey, stops) {
  const normalized = normalizeGradientRampEditableStops(stops);
  updateNodeParams(nodeId, { [paramKey]: normalized });
  if (!commitParamValueToTimeline(nodeId, paramKey, normalized)) {
    updateParamKeyframeAtCurrentTime(nodeId, paramKey, normalized);
  }
  return normalized;
}

// Color picker's gradient-stop write path. graph-shell wires this in as the
// `commitGradientStopColor` callback of initColorPicker so the picker
// doesn't depend on this module directly.
export function commitGradientStopColorTarget(target, hex) {
  const node = getSelectedNode();
  if (!isGradientRampNode(node)) return;
  const paramKey = target.paramKey || "stops";
  const stops = normalizeGradientMapInspectorStops(node.params?.[paramKey]);
  const index = Math.max(
    0,
    Math.min(stops.length - 1, Number.isFinite(target.stopIndex) ? target.stopIndex : 0)
  );
  const nextStops = stops.map((stop) => ({ ...stop }));
  nextStops[index] = {
    ...nextStops[index],
    pos: index === 0 ? 0 : index === nextStops.length - 1 ? 1 : nextStops[index].pos,
    color: hex,
  };
  commitGradientRampStops(node.id, paramKey, nextStops);
}

// Hex input commit for gradient-stop color fields that live outside the
// ramp (e.g. legacy gradient-map per-stop hex inputs). Called from
// graph-shell's onInspectorInput / onInspectorChange handlers.
export function commitGradientMapStopColor(node, control) {
  const paramKey = control.dataset.gradientStopParam || "stops";
  const stops = normalizeGradientMapInspectorStops(node.params?.[paramKey]);
  const rawIndex = Number(control.dataset.gradientMapStopColor);
  const index = Math.max(0, Math.min(stops.length - 1, Number.isFinite(rawIndex) ? rawIndex : 0));
  const fallback = index === 0 ? "#111111" : "#ffffff";
  const color = normalizeHex(control.value, fallback);
  const nextStops = stops.map((stop) => ({ ...stop }));
  nextStops[index] = {
    ...nextStops[index],
    pos: index === 0 ? 0 : index === nextStops.length - 1 ? 1 : nextStops[index].pos,
    color,
  };
  control.value = color;
  commitGradientRampStops(node.id, paramKey, nextStops);
  return color;
}

// --- Undo -------------------------------------------------------------

function pushGradientRampUndoEntry(target, stopsBefore) {
  const stopsAfter = readGradientRampStops(target);
  if (gradientRampStopsEqual(stopsBefore, stopsAfter)) return;
  const beforeCopy = stopsBefore.map((s) => ({ ...s }));
  const afterCopy = stopsAfter.map((s) => ({ ...s }));
  pushHistory({
    undo: () => commitGradientRampStops(target.nodeId, target.paramKey, beforeCopy),
    redo: () => commitGradientRampStops(target.nodeId, target.paramKey, afterCopy),
  });
}

function gradientRampStopsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pos !== b[i].pos || a[i].color !== b[i].color) return false;
  }
  return true;
}

// --- Resolve / target helpers ----------------------------------------

function resolveGradientRampTarget(element) {
  const root = element?.closest?.("[data-gradient-ramp-target]");
  if (!root) return null;
  const paramKey = root.dataset.gradientRampParam || "stops";
  const targetId = root.dataset.gradientRampTarget || gradientRampTargetId(root.dataset.gradientRampNode, paramKey);
  return {
    nodeId: root.dataset.gradientRampNode || getSelectedNode()?.id || "",
    paramKey,
    targetId,
    maxStops: Math.max(
      2,
      Math.round(Number(root.dataset.gradientRampMaxStops) || GRADIENT_RAMP_MAX_STOPS)
    ),
  };
}

function gradientRampTargetId(nodeId, paramKey) {
  return `gradient-ramp:${nodeId || "none"}:${paramKey || "stops"}`;
}

function getGradientRampSelectedIndex(targetId, stops) {
  const rawIndex = gradientRampState?.targetId === targetId
    ? Number(gradientRampState.selectedIndex)
    : 0;
  const index = Number.isFinite(rawIndex) ? Math.round(rawIndex) : 0;
  return Math.max(0, Math.min(Math.max(0, stops.length - 1), index));
}

// --- DOM sync --------------------------------------------------------

function syncGradientRampRoot(root, stops, selectedIndex = null) {
  if (!root) return;
  const normalized = normalizeGradientRampEditableStops(stops);
  const activeIndex = selectedIndex === null
    ? getGradientRampSelectedIndex(root.dataset.gradientRampTarget, normalized)
    : Math.max(0, Math.min(normalized.length - 1, Math.round(selectedIndex)));
  const bar = root.querySelector("[data-gradient-ramp-bar]");
  if (bar) bar.style.background = buildGradientRampCss(normalized);
  const buttons = Array.from(root.querySelectorAll("[data-gradient-ramp-stop]"));
  buttons.forEach((button, index) => {
    const stop = normalized[index];
    if (!stop) return;
    const color = normalizeHex(stop.color, "#ffffff");
    const position = clamp01(stop.pos) * 100;
    button.dataset.gradientRampStop = String(index);
    button.style.left = `${position}%`;
    button.style.setProperty("--gradient-stop-color", color);
    button.classList.toggle("is-selected", index === activeIndex);
    button.classList.toggle("is-endpoint", index === 0 || index === normalized.length - 1);
    button.setAttribute("aria-pressed", index === activeIndex ? "true" : "false");
    button.setAttribute("title", `${Math.round(position)}%`);
  });
  const readout = root.querySelector("[data-gradient-ramp-readout]");
  const selectedStop = normalized[activeIndex];
  if (readout && selectedStop) readout.textContent = `${Math.round(clamp01(selectedStop.pos) * 100)}%`;
}

export function syncGradientRampElements(target) {
  if (!inspectorEl || target?.kind !== "gradient-stop") return;
  const node = getSelectedNode();
  const paramKey = target.paramKey || "stops";
  if (!node) return;
  const root = inspectorEl.querySelector(
    `[data-gradient-ramp-node="${cssEscape(node.id)}"][data-gradient-ramp-param="${cssEscape(paramKey)}"]`
  );
  if (!root) return;
  const stops = normalizeGradientRampEditableStops(node.params?.[paramKey]);
  syncGradientRampRoot(root, stops, target.stopIndex);
}

export function syncGradientStopSiblingControls(control) {
  const key = control.dataset.gradientMapStopColor;
  if (!key || !inspectorEl) return;
  const value = normalizeHex(control.value, "#000000");
  const paramKey = control.dataset.gradientStopParam || "";
  const siblings = inspectorEl.querySelectorAll(
    `[data-gradient-map-stop-color="${cssEscape(key)}"]`
  );
  for (const el of siblings) {
    if (el === control) continue;
    if ((el.dataset.gradientStopParam || "") !== paramKey) continue;
    if (el.value !== value) el.value = value;
  }
}

// --- Read / math helpers ---------------------------------------------

function readGradientRampStops(target) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return [];
  return normalizeGradientRampEditableStops(node.params?.[target.paramKey]);
}

function normalizeGradientRampEditableStops(value) {
  const stops = normalizeGradientMapInspectorStops(value).map((stop) => ({
    pos: clamp01(Number(stop.pos)),
    color: normalizeHex(stop.color, "#ffffff"),
  }));
  if (stops.length <= 1) return stops;

  stops.sort((a, b) => a.pos - b.pos);
  stops[0].pos = 0;
  stops[stops.length - 1].pos = 1;
  for (let index = 1; index < stops.length - 1; index++) {
    stops[index].pos = clamp(stops[index].pos, GRADIENT_RAMP_STOP_GAP, 1 - GRADIENT_RAMP_STOP_GAP);
  }
  for (let index = 1; index < stops.length - 1; index++) {
    stops[index].pos = Math.max(stops[index].pos, stops[index - 1].pos + GRADIENT_RAMP_STOP_GAP);
  }
  for (let index = stops.length - 2; index > 0; index--) {
    stops[index].pos = Math.min(stops[index].pos, stops[index + 1].pos - GRADIENT_RAMP_STOP_GAP);
  }
  return stops;
}

export function normalizeGradientMapInspectorStops(value) {
  const fallback = [
    { pos: 0, color: "#111111" },
    { pos: 1, color: "#ffffff" },
  ];
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const stops = source
    .map((stop) => ({
      pos: clamp01(Number(stop?.pos)),
      color: normalizeHex(stop?.color, "#ffffff"),
    }))
    .sort((a, b) => a.pos - b.pos);

  if (!stops.length) return fallback;
  if (stops.length === 1) {
    return [
      { pos: 0, color: stops[0].color },
      { pos: 1, color: stops[0].color },
    ];
  }
  if (stops[0].pos > 0) {
    stops.unshift({ pos: 0, color: stops[0].color });
  }
  if (stops.at(-1).pos < 1) {
    stops.push({ pos: 1, color: stops.at(-1).color });
  }
  return stops;
}

function constrainGradientRampStopPosition(stops, index, position) {
  const min = stops[index - 1].pos + GRADIENT_RAMP_STOP_GAP;
  const max = stops[index + 1].pos - GRADIENT_RAMP_STOP_GAP;
  return clamp(Number(position), min, max);
}

function findGradientRampInsertPosition(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return 0.5;
  let bestPosition = 0.5;
  let bestGap = 0;
  for (let index = 0; index < stops.length - 1; index++) {
    const start = clamp01(stops[index].pos);
    const end = clamp01(stops[index + 1].pos);
    const gap = end - start;
    if (gap > bestGap) {
      bestGap = gap;
      bestPosition = start + gap / 2;
    }
  }
  return clamp(bestPosition, GRADIENT_RAMP_STOP_GAP, 1 - GRADIENT_RAMP_STOP_GAP);
}

function gradientRampPositionFromEvent(bar, clientX) {
  const rect = bar.getBoundingClientRect();
  return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
}

function findClosestGradientRampStopIndex(stops, position, color) {
  const targetColor = normalizeHex(color, "#ffffff");
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  stops.forEach((stop, index) => {
    const colorDistance = normalizeHex(stop.color, "#ffffff") === targetColor ? 0 : 1;
    const distance = Math.abs(clamp01(stop.pos) - clamp01(position)) + colorDistance;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function sampleGradientRampColor(stops, position) {
  const normalized = normalizeGradientRampEditableStops(stops);
  const pos = clamp01(position);
  if (normalized.length === 0) return "#808080";
  if (pos <= normalized[0].pos) return normalized[0].color;
  for (let index = 0; index < normalized.length - 1; index++) {
    const left = normalized[index];
    const right = normalized[index + 1];
    if (pos > right.pos) continue;
    const span = Math.max(0.0001, right.pos - left.pos);
    const amount = clamp01((pos - left.pos) / span);
    const [lr, lg, lb] = hexToRgb255(left.color);
    const [rr, rg, rb] = hexToRgb255(right.color);
    return rgbChannelsToHex(
      lr + (rr - lr) * amount,
      lg + (rg - lg) * amount,
      lb + (rb - lb) * amount
    );
  }
  return normalized.at(-1).color;
}

function buildGradientRampCss(stops) {
  const normalized = normalizeGradientRampEditableStops(stops);
  const stopsCss = normalized
    .map((stop) => `${normalizeHex(stop.color, "#ffffff")} ${Math.round(clamp01(stop.pos) * 10000) / 100}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stopsCss})`;
}
