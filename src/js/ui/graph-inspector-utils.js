// Inspector small-utility helpers — pure value reads, sibling
// control sync (slider ↔ number-edit), inline readout fill, and
// the format helpers node renderers use for their readout text.
//
// `syncSiblingControls` and `syncLayerPropertySiblingControls`
// need the live inspector root to walk the matching DOM nodes;
// graph-shell injects it via `initInspectorUtils` at boot.

import { normalizeHex } from "../color.js";

let inspectorEl = null;
let cssEscape = (value) => String(value);

export function initInspectorUtils(refs) {
  inspectorEl = refs.inspectorEl ?? null;
  cssEscape = typeof refs.cssEscape === "function"
    ? refs.cssEscape
    : ((value) => String(value));
}

export function readControlValue(control) {
  if (control.type === "checkbox") return control.checked;
  if (control.tagName === "SELECT") return control.value;
  if (
    control.dataset.inputKind === "color-swatch" ||
    control.dataset.inputKind === "color-hex"
  ) {
    return normalizeHex(control.value, "#000000");
  }
  return Number(control.value);
}

// Slider and number input share the same data-node-param key — when one
// moves the other has to follow without going through a full re-render
// (re-render would steal focus / blow away the user's typed digits).
export function syncSiblingControls(control) {
  const key = control.dataset.nodeParam;
  if (!key || !inspectorEl) return;
  const value = control.value;
  const siblings = inspectorEl.querySelectorAll(`[data-node-param="${cssEscape(key)}"]`);
  for (const el of siblings) {
    if (el === control) continue;
    if (el.value !== value) el.value = value;
  }
}

export function syncLayerPropertySiblingControls(control) {
  const key = control.dataset.nodeProperty;
  if (!key || !inspectorEl) return;
  const value = control.value;
  const siblings = inspectorEl.querySelectorAll(`[data-node-property="${cssEscape(key)}"]`);
  for (const el of siblings) {
    if (el === control) continue;
    if (el.value !== value) el.value = value;
  }
}

export function getLayerPropertyDefaultValue(key) {
  switch (key) {
    case "opacity":
      return 100;
    case "hue":
      return 0;
    case "saturation":
      return 100;
    default:
      return 0;
  }
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function updateInlineReadout(control) {
  // F23 AE-style fill: write --slider-fill on the range input so the CSS
  // `linear-gradient` track shows the filled portion up to the thumb.
  if (!control || control.type !== "range") return;
  const min = Number(control.min);
  const max = Number(control.max);
  const value = Number(control.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(value) || max === min) return;
  const pct = clamp((value - min) / (max - min), 0, 1) * 100;
  control.style.setProperty("--slider-fill", `${pct}%`);
}

export function formatSignedValue(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

export function formatSignedStops(value) {
  const stops = (value / 100).toFixed(2);
  return value > 0 ? `+${stops}` : stops;
}

export function formatFpsReadout(value, sourceFps) {
  const numeric = Math.max(1, Math.round(Number(value) || 0));
  const sourceNumeric = Math.max(1, Math.round(Number(sourceFps) || 0));
  return numeric === sourceNumeric ? `Source (${sourceNumeric})` : String(numeric);
}
