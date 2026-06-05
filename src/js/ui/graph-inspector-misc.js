// Small / standalone node inspector renderers — Blur, Posterize
// on the image-ops side; Value, Math on the scalar/expression
// side; Viewer Output (export FPS); and the empty-inspector
// placeholder shown when nothing is selected.
//
// All are simple string builders over the shared field helpers
// — the only outside reach is `renderViewerOutputNode` pulling
// the live source FPS off the playback state, and `renderValueNode`
// asking the graph layer for its connected-output bounds so the
// number input shows the right min/max.

import { getState } from "../state.js";
import { getValueNodeOutputBounds } from "../graph.js";
import {
  renderCheckboxField,
  renderNumberField,
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import { formatFpsReadout } from "./graph-inspector-utils.js";

export function renderBlurNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Radius", "radius", params.radius, 0, 40, `${params.radius}px`)}
    </section>
  `;
}

export function renderPosterizeNode(node) {
  const params = node.params;
  const steps = Number(params.steps ?? 8);
  const stepsG = Number(params.stepsG ?? 0);
  const stepsB = Number(params.stepsB ?? 0);
  const gamma = String(params.gamma ?? "linear");
  const lumaMode = String(params.lumaMode ?? "rgb");
  const opacity = Number(params.opacity ?? 100);
  // 0-step labels surface the "link to R" sentinel so the slider's intent
  // is obvious without a separate toggle.
  const gLabel = stepsG > 0 ? `${stepsG}` : `link (${steps})`;
  const bLabel = stepsB > 0 ? `${stepsB}` : `link (${steps})`;
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Steps</header>
      ${renderRangeField("R", "steps", steps, 2, 64, `${steps}`)}
      ${renderRangeField("G", "stepsG", stepsG, 0, 64, gLabel)}
      ${renderRangeField("B", "stepsB", stepsB, 0, 64, bLabel)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mode</header>
      ${renderSelectField("Color Mode", "lumaMode", lumaMode, [
        ["rgb", "RGB Independent"],
        ["luma", "Luma + Chroma"],
      ])}
      ${renderSelectField("Gamma", "gamma", gamma, [
        ["linear", "Linear"],
        ["srgb", "sRGB-aware"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

export function renderValueNode(node) {
  const params = node.params;
  const bounds = getValueNodeOutputBounds(node.id);
  return `
    <section class="node-panel-section">
      ${renderNumberField("Value", "value", params.value, bounds)}
    </section>
  `;
}

export function renderAudioLevelNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderNumberField("Gain", "gain", params.gain ?? 1, { min: 0, max: 8 })}
    </section>
  `;
}

export function renderFieldProbeNode(node) {
  const params = node.params;
  // Center / sample / radius use the 0..100 (radius 0..200) integer-percent
  // convention shared with gradient / chroma-aberration / lens-distort, so the
  // default-step slider lands on usable values; the runtime divides by 100.
  const radius = Number(params.radius ?? 50);
  return `
    <section class="node-panel-section">
      ${renderSelectField("Shape", "shape", String(params.shape ?? "radial"), [
        ["radial", "Radial"],
        ["linear-x", "Linear X"],
        ["linear-y", "Linear Y"],
      ])}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Center</header>
      ${renderRangeField("X", "centerX", params.centerX ?? 50, 0, 100, `${params.centerX ?? 50}%`)}
      ${renderRangeField("Y", "centerY", params.centerY ?? 50, 0, 100, `${params.centerY ?? 50}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Sample</header>
      ${renderRangeField("X", "sampleX", params.sampleX ?? 50, 0, 100, `${params.sampleX ?? 50}%`)}
      ${renderRangeField("Y", "sampleY", params.sampleY ?? 50, 0, 100, `${params.sampleY ?? 50}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Shaping</header>
      ${renderRangeField("Radius", "radius", radius, 0, 200, `${(radius / 100).toFixed(2)}`)}
      ${renderSelectField("Falloff", "falloff", String(params.falloff ?? "linear"), [
        ["linear", "Linear"],
        ["smooth", "Smooth"],
      ])}
      ${renderCheckboxField("Invert", "invert", Boolean(params.invert))}
      ${renderNumberField("Gain", "gain", params.gain ?? 1, { min: 0, max: 8 })}
    </section>
  `;
}

export function renderFieldMapNode(node) {
  const params = node.params;
  // Same shape vocabulary as field-probe, rendered as a grayscale image.
  // Center / radius use the 0..100 (radius 0..200) integer-percent convention;
  // the runtime divides by 100.
  const radius = Number(params.radius ?? 50);
  const width = Number(params.width ?? 1920);
  const height = Number(params.height ?? 1080);
  return `
    <section class="node-panel-section">
      ${renderSelectField("Shape", "shape", String(params.shape ?? "radial"), [
        ["radial", "Radial"],
        ["linear-x", "Linear X"],
        ["linear-y", "Linear Y"],
      ])}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Center</header>
      ${renderRangeField("X", "centerX", params.centerX ?? 50, 0, 100, `${params.centerX ?? 50}%`)}
      ${renderRangeField("Y", "centerY", params.centerY ?? 50, 0, 100, `${params.centerY ?? 50}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Shaping</header>
      ${renderRangeField("Radius", "radius", radius, 0, 200, `${(radius / 100).toFixed(2)}`)}
      ${renderSelectField("Falloff", "falloff", String(params.falloff ?? "linear"), [
        ["linear", "Linear"],
        ["smooth", "Smooth"],
      ])}
      ${renderCheckboxField("Invert", "invert", Boolean(params.invert))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Width", "width", width, 256, 4096, `${width}px`)}
      ${renderRangeField("Height", "height", height, 256, 4096, `${height}px`)}
    </section>
  `;
}

export function renderMathNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderSelectField("Operation", "operation", params.operation, [
        ["add", "Add"],
        ["subtract", "Subtract"],
        ["multiply", "Multiply"],
        ["divide", "Divide"],
        ["power", "Power"],
        ["min", "Minimum"],
        ["max", "Maximum"],
        ["modulo", "Modulo"],
      ])}
      ${renderRangeField("A", "a", params.a, -1000, 1000, String(params.a))}
      ${renderRangeField("B", "b", params.b, -1000, 1000, String(params.b))}
      ${renderCheckboxField("Clamp 0..1", "clamp", params.clamp)}
      <p class="hint">Math nodes compute scalar values; parameter wiring comes next.</p>
    </section>
  `;
}

export function renderViewerOutputNode(node) {
  const { source } = getState();
  const currentFps = Math.max(
    1,
    Math.round(Number(source.loaded ? source.fps : node?.params?.fps ?? source.fps) || 30)
  );
  const sourceFps = Math.max(
    1,
    Math.round(Number(source.loaded ? source.sourceFps : node?.params?.fps ?? source.sourceFps) || 30)
  );
  const maxFps = Math.max(1, source.loaded ? sourceFps : 120);
  return `
    <section class="node-panel-section">
      ${renderRangeField("Export FPS", "viewer-fps", currentFps, 1, maxFps, formatFpsReadout(currentFps, sourceFps))}
      <p class="hint">Target frame rate for export. Lower than source drops/blends frames in the encode. Preview keeps running at the source frame rate; slow / fast motion is a separate playback control.</p>
    </section>
  `;
}

export function renderEmptyInspector() {
  return `
    <section class="node-panel-section">
      <h3>No node selected</h3>
      <p class="hint">Select a node to edit its parameters.</p>
    </section>
  `;
}
