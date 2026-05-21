// Color picker subsystem for the inspector — popover, drag,
// hex/HSV math (DOM-bound bits), commit dispatch, and the
// post-commit DOM sync that keeps the trigger swatch / hex
// inputs / popover sliders in lockstep.
//
// State (`colorPickerState`, `pickerHexSnapshots`) stays
// private here so the rest of the app can only touch it
// through the small API at the top of this file:
//   * closeColorPicker / isAnyColorPickerOpen / isColorPickerOpenForTarget
//     — Escape key + node-rebuild reset paths
//   * snapshotPickerHexIfNew / popPickerHexSnapshot
//     — F17.3b/c undo for the hex input + eyedropper
//
// The three commit*Color helpers that actually mutate graph
// state (node-param / gradient-stop / mesh-stop writes) are
// injected by graph-shell at boot. The picker stays focused
// on UI concerns; graph-shell owns the write path because
// gradient-stop commits need the gradient-ramp helpers that
// haven't been split out yet.

import { escapeHtml } from "./utils.js";
import { normalizeHex } from "../color.js";
import { pushHistory } from "../state.js";
import { getSelectedNode } from "../graph.js";
import { hexToHsvColor, hsvColorToHex } from "./graph-color-math.js";
import {
  renderParamKeyframeButton,
  renderParamSocketDot,
  syncTimelineButtons,
} from "./graph-inspector-fields.js";

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

let inspectorEl = null;
let cssEscape = (value) => String(value);
const callbacks = {
  renderInspector: () => {},
  setInspectorEditing: () => {},
  commitNodeColorParam: () => {},
  commitGradientStopColor: () => {},
  commitMeshStopColor: () => {},
  syncGradientRampElements: () => {},
};

let colorPickerState = null;
const pickerHexSnapshots = new Map();

export function initColorPicker(refs) {
  inspectorEl = refs.inspectorEl ?? null;
  cssEscape = typeof refs.cssEscape === "function"
    ? refs.cssEscape
    : ((value) => String(value));
  callbacks.renderInspector = refs.renderInspector ?? (() => {});
  callbacks.setInspectorEditing = refs.setInspectorEditing ?? (() => {});
  callbacks.commitNodeColorParam = refs.commitNodeColorParam ?? (() => {});
  callbacks.commitGradientStopColor = refs.commitGradientStopColor ?? (() => {});
  callbacks.commitMeshStopColor = refs.commitMeshStopColor ?? (() => {});
  callbacks.syncGradientRampElements = refs.syncGradientRampElements ?? (() => {});
}

// --- State API ---------------------------------------------------------

export function closeColorPicker() {
  colorPickerState = null;
}

export function isAnyColorPickerOpen() {
  return colorPickerState !== null;
}

export function isColorPickerOpenForTarget(targetId) {
  return colorPickerState?.targetId === targetId;
}

export function snapshotPickerHexIfNew(targetId, hex) {
  if (!targetId) return;
  if (!pickerHexSnapshots.has(targetId)) {
    pickerHexSnapshots.set(targetId, hex);
  }
}

export function popPickerHexSnapshot(targetId) {
  if (!targetId || !pickerHexSnapshots.has(targetId)) return null;
  const value = pickerHexSnapshots.get(targetId);
  pickerHexSnapshots.delete(targetId);
  return value;
}

// --- Render ------------------------------------------------------------

export function renderColorField(label, key, value, options = {}) {
  const safeKey = escapeHtml(key);
  const fallback = options.fallback ?? "#000000";
  const hex = normalizeHex(value, fallback);
  return `
    <div class="field color-field">
      <label>
        <span class="field-label-row">
          ${renderParamSocketDot(safeKey)}
          ${renderParamKeyframeButton(key)}
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      ${renderColorPickerControl({
        label,
        value: hex,
        fallback,
        target: { kind: "node-param", paramKey: key },
        inputAttrs: `data-node-param="${safeKey}" data-input-kind="color-hex"`,
      })}
    </div>
  `;
}

export function renderGradientStopColorField(label, stopIndex, value, options = {}) {
  const safeIndex = String(Math.max(0, Number(stopIndex) || 0));
  const fallback = options.fallback ?? "#000000";
  const hex = normalizeHex(value, fallback);
  const stopParamAttr = options.paramKey
    ? ` data-gradient-stop-param="${escapeHtml(options.paramKey)}"`
    : "";
  return `
    <div class="field color-field">
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      ${renderColorPickerControl({
        label,
        value: hex,
        fallback,
        target: {
          kind: "gradient-stop",
          stopIndex: safeIndex,
          paramKey: options.paramKey || "stops",
        },
        inputAttrs: `data-gradient-map-stop-color="${safeIndex}" ${stopParamAttr} data-input-kind="gradient-stop-hex"`,
      })}
    </div>
  `;
}

export function renderColorPickerControl({ label, value, fallback, target, inputAttrs }) {
  const hex = normalizeHex(value, fallback ?? "#000000");
  const targetId = colorPickerTargetId(target);
  const open = colorPickerState?.targetId === targetId;
  const attrs = renderColorPickerTargetAttrs(target, targetId, fallback ?? "#000000");
  return `
    <div class="color-row color-picker-root" ${attrs}>
      <button
        type="button"
        class="color-picker-trigger"
        data-color-picker-trigger
        aria-label="${escapeHtml(label)} color"
        aria-expanded="${open ? "true" : "false"}"
      >
        <span class="color-picker-trigger-swatch" style="background:${escapeHtml(hex)}"></span>
        <span class="color-picker-trigger-value">${escapeHtml(hex.toUpperCase())}</span>
      </button>
      <input
        type="text"
        class="color-hex"
        value="${escapeHtml(hex)}"
        ${inputAttrs}
        maxlength="7"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
      />
      ${open ? renderColorPickerPopover(hex, target, fallback ?? "#000000") : ""}
    </div>
  `;
}

function renderColorPickerPopover(hex, target, fallback = "#000000") {
  const safeHex = normalizeHex(hex, fallback);
  const hsv = hexToHsvColor(safeHex);
  const hueColor = hsvColorToHex({ h: hsv.h, s: 1, v: 1 });
  const targetId = colorPickerTargetId(target);
  return `
    <div class="color-picker-popover" data-color-picker-popover data-color-current="${escapeHtml(safeHex)}" data-color-picker-target-id="${escapeHtml(targetId)}" style="--color-picker-hue:${escapeHtml(hueColor)}; --color-picker-s:${hsv.s * 100}%; --color-picker-v:${(1 - hsv.v) * 100}%; --color-picker-h:${(hsv.h / 360) * 100}%">
      <div class="color-picker-surface" data-color-picker-surface>
        <span class="color-picker-surface-white"></span>
        <span class="color-picker-surface-black"></span>
        <span class="color-picker-surface-handle"></span>
      </div>
      <div class="color-picker-hue" data-color-picker-hue>
        <span class="color-picker-hue-handle"></span>
      </div>
      <div class="color-picker-popover-row">
        <input
          type="text"
          class="color-hex"
          value="${escapeHtml(safeHex)}"
          data-color-picker-hex-input
          maxlength="7"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
        />
        <button type="button" class="color-picker-eyedropper" data-color-picker-eyedropper title="Pick color from screen" aria-label="Pick color from screen">Pick</button>
      </div>
    </div>
  `;
}

function renderColorPickerTargetAttrs(target, targetId, fallback) {
  const attrs = [
    `data-color-picker-target="${escapeHtml(targetId)}"`,
    `data-color-picker-kind="${escapeHtml(target.kind)}"`,
    `data-color-picker-fallback="${escapeHtml(fallback)}"`,
  ];
  if (target.kind === "node-param") {
    attrs.push(`data-color-picker-param="${escapeHtml(target.paramKey)}"`);
  } else if (target.kind === "gradient-stop") {
    attrs.push(`data-color-picker-stop-index="${escapeHtml(String(target.stopIndex))}"`);
    attrs.push(`data-color-picker-param="${escapeHtml(target.paramKey || "stops")}"`);
  } else if (target.kind === "mesh-stop") {
    attrs.push(`data-color-picker-stop-index="${escapeHtml(String(target.stopIndex))}"`);
  }
  return attrs.join(" ");
}

function colorPickerTargetId(target) {
  if (!target) return "";
  switch (target.kind) {
    case "node-param":
      return `node:${target.paramKey}`;
    case "gradient-stop":
      return `gradient:${target.paramKey || "stops"}:${target.stopIndex}`;
    case "mesh-stop":
      return `mesh:${target.stopIndex}`;
    default:
      return "";
  }
}

// --- Resolve / toggle --------------------------------------------------

export function resolveColorPickerTarget(element) {
  const root = element?.closest?.("[data-color-picker-target]");
  if (!root) return null;
  const kind = root.dataset.colorPickerKind;
  const target = {
    kind,
    targetId: root.dataset.colorPickerTarget,
    fallback: root.dataset.colorPickerFallback || "#000000",
  };
  if (kind === "node-param") {
    target.paramKey = root.dataset.colorPickerParam;
  } else if (kind === "gradient-stop") {
    target.paramKey = root.dataset.colorPickerParam || "stops";
    target.stopIndex = Number(root.dataset.colorPickerStopIndex);
  } else if (kind === "mesh-stop") {
    target.stopIndex = Number(root.dataset.colorPickerStopIndex);
  }
  if (!target.targetId || !target.kind) return null;
  return target;
}

export function toggleColorPicker(trigger) {
  const target = resolveColorPickerTarget(trigger);
  if (!target) return;
  colorPickerState = colorPickerState?.targetId === target.targetId
    ? null
    : { targetId: target.targetId };
  callbacks.renderInspector();
}

// --- Drag --------------------------------------------------------------

export function startColorPickerDrag(event, control, mode) {
  if (event.button !== 0) return;
  const target = resolveColorPickerTarget(control);
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();

  callbacks.setInspectorEditing(true);
  document.body.classList.add("dragging-color-picker");

  // F17.3b: snapshot the pre-drag color so onUp can record a single undo
  // entry covering the whole SV-surface / hue-rail drag instead of one per
  // pointermove commit.
  const pickerUndoSnapshot = readColorPickerCurrentHex(target);

  const commitFromPointer = (ev) => {
    const current = hexToHsvColor(readColorPickerCurrentHex(target));
    const next = mode === "hue"
      ? hsvFromHuePointer(control, current, ev.clientX)
      : hsvFromSurfacePointer(control, current, ev.clientX, ev.clientY);
    commitColorPickerValue(control, hsvColorToHex(next));
  };

  commitFromPointer(event);

  try {
    control.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    if (ev.buttons !== undefined && !(ev.buttons & 1)) return;
    commitFromPointer(ev);
  };

  const onUp = () => {
    control.removeEventListener("pointermove", onMove);
    control.removeEventListener("pointerup", onUp);
    control.removeEventListener("pointercancel", onUp);
    callbacks.setInspectorEditing(false);
    document.body.classList.remove("dragging-color-picker");
    try {
      control.releasePointerCapture(event.pointerId);
    } catch {}
    // F17.3b flush: if the drag changed the color, record one history entry.
    const finalHex = readColorPickerCurrentHex(target);
    if (finalHex && pickerUndoSnapshot && finalHex !== pickerUndoSnapshot) {
      pushHistory({
        undo: () => applyColorPickerHex(target, pickerUndoSnapshot),
        redo: () => applyColorPickerHex(target, finalHex),
      });
    }
  };

  control.addEventListener("pointermove", onMove);
  control.addEventListener("pointerup", onUp);
  control.addEventListener("pointercancel", onUp);
}

function hsvFromSurfacePointer(surface, current, clientX, clientY) {
  const rect = surface.getBoundingClientRect();
  return {
    h: current.h,
    s: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    v: 1 - clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1),
  };
}

function hsvFromHuePointer(hueControl, current, clientX) {
  const rect = hueControl.getBoundingClientRect();
  return {
    ...current,
    h: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * 360,
  };
}

// --- Commit dispatcher -------------------------------------------------

export function applyColorPickerHex(target, hex) {
  // Same dispatcher commitColorPickerValue uses, but takes a target object
  // directly so undo callbacks don't need to look one up from a DOM element
  // that may have been re-rendered since the history entry was pushed.
  switch (target.kind) {
    case "node-param":
      callbacks.commitNodeColorParam(target.paramKey, hex);
      return;
    case "gradient-stop":
      callbacks.commitGradientStopColor(target, hex);
      return;
    case "mesh-stop":
      callbacks.commitMeshStopColor(target, hex);
      return;
  }
}

export function commitColorPickerValue(element, rawHex) {
  const target = resolveColorPickerTarget(element);
  if (!target) return null;
  const hex = normalizeHex(rawHex, target.fallback);
  applyColorPickerHex(target, hex);
  syncColorPickerElements(target, hex);
  return hex;
}

// --- DOM read / state read --------------------------------------------

// Read the picker's value from node state rather than the DOM input. The DOM
// can be a beat ahead during typing (input event fires after the user pressed
// a key, so input.value already reflects the in-progress edit), but the node
// state still holds the pre-edit color until commitColorPickerValue runs.
// Drag handlers can keep using readColorPickerCurrentHex since their
// snapshots happen at pointerdown, before any DOM mutation.
export function readPickerValueFromState(target) {
  if (!target) return null;
  const node = getSelectedNode();
  if (!node) return null;
  switch (target.kind) {
    case "node-param":
      return node.params?.[target.paramKey];
    case "gradient-stop": {
      const stops = node.params?.[target.paramKey || "stops"];
      return Array.isArray(stops) ? stops[target.stopIndex]?.color : null;
    }
    case "mesh-stop":
      return node.params?.stops?.[target.stopIndex]?.color;
  }
  return null;
}

export function readColorPickerCurrentHex(target) {
  if (!target?.targetId || !inspectorEl) return normalizeHex(target?.fallback, "#000000");
  const row = inspectorEl.querySelector(`[data-color-picker-target="${cssEscape(target.targetId)}"]`);
  const hexInput = row?.querySelector(".color-hex");
  return normalizeHex(hexInput?.value, target.fallback || "#000000");
}

export function syncColorPickerElements(target, hex) {
  if (!target?.targetId || !inspectorEl) return;
  const safeHex = normalizeHex(hex, target.fallback || "#000000");
  const hsv = hexToHsvColor(safeHex);
  const hueColor = hsvColorToHex({ h: hsv.h, s: 1, v: 1 });
  const rows = inspectorEl.querySelectorAll(`[data-color-picker-target="${cssEscape(target.targetId)}"]`);
  for (const row of rows) {
    const triggerSwatch = row.querySelector(".color-picker-trigger-swatch");
    const triggerValue = row.querySelector(".color-picker-trigger-value");
    const hexInputs = row.querySelectorAll(".color-hex");
    if (triggerSwatch) triggerSwatch.style.background = safeHex;
    if (triggerValue) triggerValue.textContent = safeHex.toUpperCase();
    for (const input of hexInputs) {
      input.classList.remove("is-invalid");
      if (input.value !== safeHex) input.value = safeHex;
    }
    const meshDot = row.closest(".mesh-stop-row")?.querySelector(".mesh-stop-swatch-dot");
    if (meshDot) meshDot.style.background = safeHex;
    const popover = row.querySelector("[data-color-picker-popover]");
    if (popover) {
      popover.dataset.colorCurrent = safeHex;
      popover.style.setProperty("--color-picker-hue", hueColor);
      popover.style.setProperty("--color-picker-s", `${hsv.s * 100}%`);
      popover.style.setProperty("--color-picker-v", `${(1 - hsv.v) * 100}%`);
      popover.style.setProperty("--color-picker-h", `${(hsv.h / 360) * 100}%`);
    }
  }
  if (target.kind === "gradient-stop") {
    callbacks.syncGradientRampElements(target);
  }
  syncTimelineButtons();
}

// --- Eyedropper --------------------------------------------------------

export async function handleColorPickerEyedropper(control) {
  if (typeof window === "undefined" || typeof window.EyeDropper !== "function") return;
  try {
    const result = await new window.EyeDropper().open();
    if (!result?.sRGBHex) return;
    // F17.3b eyedropper: single commit, snapshot before / push after.
    const target = resolveColorPickerTarget(control);
    const before = target ? readColorPickerCurrentHex(target) : null;
    commitColorPickerValue(control, result.sRGBHex);
    if (target && before) {
      const after = readColorPickerCurrentHex(target);
      if (after && before !== after) {
        pushHistory({
          undo: () => applyColorPickerHex(target, before),
          redo: () => applyColorPickerHex(target, after),
        });
      }
    }
  } catch {
    // User cancelled the picker; keep the current color.
  }
}
