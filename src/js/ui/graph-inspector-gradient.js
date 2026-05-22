// Gradient ecosystem inspector renderers — Gradient, Mesh Gradient,
// Noise, Gradient Map. Plus the mesh-stop row helpers and the two
// mesh-action handlers (commitMeshStopField + handleMeshAction)
// that graph-shell's onInspectorInput / onInspectorClick dispatch
// into.
//
// Mesh stop colour swatches are rendered through the color picker
// (`renderColorPickerControl`), and the position/radius range pair
// has its own dedicated builder because it needs the special
// `data-mesh-stop-*` attributes the event handlers key off.

import { escapeHtml } from "./utils.js";
import { normalizeHex } from "../color.js";
import { MESH_GRADIENT_MAX_STOPS, updateNodeParams } from "../graph.js";
import {
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import { renderColorPickerControl } from "./graph-color-picker.js";
import {
  GRADIENT_RAMP_MAX_STOPS,
  normalizeGradientMapInspectorStops,
  renderGradientRampField,
} from "./graph-gradient-ramp.js";
import { renderXyPadField } from "./graph-xy-pad.js";

let inspectorEl = null;
let cssEscape = (value) => String(value);
const callbacks = {
  renderInspector: () => {},
};

export function initGradientInspector(refs) {
  inspectorEl = refs.inspectorEl ?? null;
  cssEscape = typeof refs.cssEscape === "function"
    ? refs.cssEscape
    : ((value) => String(value));
  callbacks.renderInspector = refs.renderInspector ?? (() => {});
}

export function renderMeshGradientNode(node) {
  const params = node.params;
  const stops = Array.isArray(params.stops) ? params.stops : [];
  const canAdd = stops.length < MESH_GRADIENT_MAX_STOPS;
  const canRemove = stops.length > 1;
  const complexity = Number(params.complexity ?? 50);
  const warp = Number(params.warp ?? 35);
  const speed = Number(params.speed ?? 25);
  const zoom = Number(params.zoom ?? 100);
  const width = Number(params.width ?? 1920);
  const height = Number(params.height ?? 1080);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title mesh-stops-header">
        <span>Color Stops</span>
        ${
          canAdd
            ? `<button class="mesh-stops-add" type="button" data-mesh-action="add-stop" title="Add color stop">+ Add</button>`
            : ""
        }
      </header>
      ${stops.map((stop, i) => renderMeshStopRow(stop, i, canRemove)).join("")}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Shape</header>
      ${renderRangeField("Complexity", "complexity", complexity, 0, 100, `${complexity}%`)}
      ${renderRangeField("Warp", "warp", warp, 0, 100, `${warp}%`)}
      ${renderRangeField("Zoom", "zoom", zoom, 25, 400, `${zoom}%`)}
      ${renderRangeField("Speed", "speed", speed, 0, 100, `${speed}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Width", "width", width, 256, 4096, `${width}px`)}
      ${renderRangeField("Height", "height", height, 256, 4096, `${height}px`)}
    </section>
  `;
}

export function renderNoiseNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "perlin");
  const scale = Number(params.scale ?? 4);
  const octaves = Number(params.octaves ?? 4);
  const persistence = Number(params.persistence ?? 50);
  const seed = Number(params.seed ?? 0);
  const animSpeed = Number(params.animSpeed ?? 0);
  const width = Number(params.width ?? 1920);
  const height = Number(params.height ?? 1080);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Noise</header>
      ${renderSelectField("Type", "mode", mode, [
        ["perlin", "Perlin"],
        ["simplex", "Simplex"],
        ["value", "Value"],
      ])}
      ${renderRangeField("Scale", "scale", scale, 0.1, 64, String(scale))}
      ${renderRangeField("Octaves", "octaves", octaves, 1, 8, String(octaves))}
      ${renderRangeField("Persistence", "persistence", persistence, 0, 100, `${persistence}%`)}
      ${renderRangeField("Seed", "seed", seed, 0, 999, String(seed))}
      ${renderRangeField("Anim Speed", "animSpeed", animSpeed, 0, 200, `${animSpeed}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Width", "width", width, 256, 4096, `${width}px`)}
      ${renderRangeField("Height", "height", height, 256, 4096, `${height}px`)}
    </section>
  `;
}

export function renderGradientNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "linear");
  const angle = Number(params.angle ?? 0);
  const centerX = Number(params.centerX ?? 50);
  const centerY = Number(params.centerY ?? 50);
  const radius = Number(params.radius ?? 75);
  const repeat = Number(params.repeat ?? 1);
  const shift = Number(params.shift ?? 0);
  const width = Number(params.width ?? 1920);
  const height = Number(params.height ?? 1080);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Gradient</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["linear", "Linear"],
        ["radial", "Radial"],
        ["conic", "Conic"],
      ])}
      ${renderGradientRampField("Ramp", "stops", params.stops, { maxStops: GRADIENT_RAMP_MAX_STOPS })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Shape</header>
      ${renderXyPadField("Center", "centerX", "centerY", centerX, centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Angle", "angle", angle, -180, 180, `${angle}deg`)}
      ${mode === "radial" ? renderRangeField("Radius", "radius", radius, 1, 200, `${radius}%`) : ""}
      ${renderRangeField("Repeat", "repeat", repeat, 1, 20, String(repeat))}
      ${renderRangeField("Shift", "shift", shift, -100, 100, `${shift}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Width", "width", width, 256, 4096, `${width}px`)}
      ${renderRangeField("Height", "height", height, 256, 4096, `${height}px`)}
    </section>
  `;
}

export function renderGradientMapNode(node) {
  const params = node.params;
  const stops = normalizeGradientMapInspectorStops(params.stops);
  const repeat = Number(params.repeat ?? 1);
  const shift = Number(params.shift ?? 0);
  const mode = String(params.mode ?? "luma");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Gradient</header>
      ${renderGradientRampField("Ramp", "stops", stops, { maxStops: GRADIENT_RAMP_MAX_STOPS })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mapping</header>
      ${renderSelectField("Signal", "mode", mode, [
        ["luma", "Luma"],
        ["r", "Red"],
        ["g", "Green"],
        ["b", "Blue"],
      ])}
      ${renderRangeField("Repeat", "repeat", repeat, 1, 20, String(repeat))}
      ${renderRangeField("Shift", "shift", shift, -100, 100, `${shift}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

// --- Mesh stop helpers ----------------------------------------------

function renderMeshStopRow(stop, index, canRemove) {
  const idx = String(index);
  const color = normalizeHex(stop?.color, "#ffffff");
  const x = Math.round(Math.max(0, Math.min(1, Number(stop?.x ?? 0.5))) * 100);
  const y = Math.round(Math.max(0, Math.min(1, Number(stop?.y ?? 0.5))) * 100);
  const radiusPct = Math.round(Math.max(0.02, Math.min(2, Number(stop?.radius ?? 0.6))) * 100);
  return `
    <div class="mesh-stop-row" data-mesh-stop-index="${escapeHtml(idx)}">
      <header class="mesh-stop-row-head">
        <span class="mesh-stop-row-title">
          <span class="mesh-stop-swatch-dot" style="background:${escapeHtml(color)};"></span>
          Stop ${index + 1}
        </span>
        ${
          canRemove
            ? `<button class="mesh-stop-row-remove" type="button" data-mesh-action="remove-stop" data-mesh-stop-index="${escapeHtml(idx)}" title="Remove stop" aria-label="Remove stop ${index + 1}">×</button>`
            : ""
        }
      </header>
      ${renderColorPickerControl({
        label: `Stop ${index + 1}`,
        value: color,
        fallback: "#ffffff",
        target: { kind: "mesh-stop", stopIndex: idx },
        inputAttrs: `data-mesh-stop-field="color" data-mesh-stop-index="${escapeHtml(idx)}" data-input-kind="mesh-stop-hex"`,
      })}
      ${renderMeshStopRange("X", "x", index, x, 0, 100, `${x}%`)}
      ${renderMeshStopRange("Y", "y", index, y, 0, 100, `${y}%`)}
      ${renderMeshStopRange("Radius", "radius", index, radiusPct, 1, 200, `${radiusPct}%`)}
    </div>
  `;
}

function renderMeshStopRange(label, field, index, value, min, max, readout) {
  const safeField = escapeHtml(field);
  const safeIdx = String(index);
  return `
    <div class="field range-field">
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
        <span class="field-suffix">${escapeHtml(readout)}</span>
      </label>
      <div class="range-row">
        <input type="range" min="${min}" max="${max}" value="${value}"
          data-mesh-stop-field="${safeField}"
          data-mesh-stop-index="${safeIdx}"
          data-input-kind="mesh-stop-range" />
        <input type="number" class="num-edit" min="${min}" max="${max}" value="${value}"
          data-mesh-stop-field="${safeField}"
          data-mesh-stop-index="${safeIdx}"
          data-input-kind="mesh-stop-number" />
      </div>
    </div>
  `;
}

// --- Event-handler entry points --------------------------------------

export function commitMeshStopField(node, control) {
  const index = Number(control.dataset.meshStopIndex);
  const field = control.dataset.meshStopField;
  if (!Number.isFinite(index) || !field) return;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  if (index < 0 || index >= stops.length) return;
  const kind = control.dataset.inputKind;
  let next;
  if (field === "color") {
    next = normalizeHex(control.value, stops[index].color ?? "#ffffff");
  } else if (field === "radius") {
    const raw = Number(control.value);
    if (!Number.isFinite(raw)) return;
    next = Math.max(1, Math.min(200, raw)) / 100;
  } else {
    const raw = Number(control.value);
    if (!Number.isFinite(raw)) return;
    next = Math.max(0, Math.min(100, raw)) / 100;
  }
  const nextStops = stops.map((s, i) => (i === index ? { ...s, [field]: next } : s));
  updateNodeParams(node.id, { stops: nextStops });
  // Sibling range/number share data-mesh-stop-field+index — keep them in sync
  // without a full re-render so the user's drag does not lose focus.
  if (inspectorEl && (kind === "mesh-stop-range" || kind === "mesh-stop-number")) {
    const siblings = inspectorEl.querySelectorAll(
      `[data-mesh-stop-field="${cssEscape(field)}"][data-mesh-stop-index="${cssEscape(String(index))}"]`
    );
    for (const sib of siblings) {
      if (sib !== control && sib.value !== control.value) sib.value = control.value;
    }
  }
}

export function handleMeshAction(node, control) {
  const action = control.dataset.meshAction;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  if (action === "add-stop") {
    if (stops.length >= MESH_GRADIENT_MAX_STOPS) return;
    const palette = [
      "#ff77aa", "#88ddff", "#ffe066", "#a78bfa",
      "#34d399", "#fb923c", "#60a5fa", "#f472b6",
    ];
    const newStop = {
      x: 0.5,
      y: 0.5,
      radius: 0.45,
      color: palette[stops.length % palette.length],
    };
    updateNodeParams(node.id, { stops: [...stops, newStop] });
    callbacks.renderInspector();
  } else if (action === "remove-stop") {
    if (stops.length <= 1) return;
    const index = Number(control.dataset.meshStopIndex);
    if (!Number.isFinite(index) || index < 0 || index >= stops.length) return;
    const next = stops.filter((_, i) => i !== index);
    updateNodeParams(node.id, { stops: next });
    callbacks.renderInspector();
  }
}
