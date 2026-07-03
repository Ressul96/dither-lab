// Source-side node inspector renderers — Source, Adjust, HSV,
// RGB→BW, Invert. The Source node is the composite "always-on"
// renderer that lifts Adjust + HSV + bwMode + invert into a
// single inspector panel; the four standalone nodes are the
// same building blocks promoted to first-class graph nodes.

import { getSelectedNode } from "../graph.js";
import { getState } from "../state.js";
import {
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import {
  formatSignedStops,
  formatSignedValue,
} from "./graph-inspector-utils.js";

export function renderSourceNode() {
  const node = getSelectedNode();
  const params = node?.params ?? {};
  const bwMode = String(params.bwMode ?? "off");
  const invert = String(params.invert ?? "off");
  const invertChannels = String(params.invertChannels ?? "rgb");
  return `
    ${renderExrSourceSection(params)}
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Adjust</header>
      ${renderRangeField("Brightness", "brightness", params.brightness ?? 0, -100, 100, formatSignedValue(params.brightness ?? 0))}
      ${renderRangeField("Contrast", "contrast", params.contrast ?? 100, 0, 200, `${params.contrast ?? 100}%`)}
      ${renderRangeField("Saturation", "saturation", params.saturation ?? 100, 0, 200, `${params.saturation ?? 100}%`)}
      ${renderRangeField("Gamma", "gamma", params.gamma ?? 100, 10, 400, `${((params.gamma ?? 100) / 100).toFixed(2)}`)}
      ${renderRangeField("Exposure", "exposure", params.exposure ?? 0, -400, 400, formatSignedStops(params.exposure ?? 0))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">HSV</header>
      ${renderRangeField("Hue", "hue", params.hue ?? 0, -180, 180, `${params.hue ?? 0}°`)}
      ${renderRangeField("Saturation", "hsvSaturation", params.hsvSaturation ?? 100, 0, 400, `${params.hsvSaturation ?? 100}%`)}
      ${renderRangeField("Value", "value", params.value ?? 100, 0, 400, `${params.value ?? 100}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Conversion</header>
      ${renderSelectField("Black & White", "bwMode", bwMode, [
        ["off", "Off"],
        ["bt709", "Bt.709 (HD)"],
        ["bt601", "Bt.601 (SD)"],
        ["average", "Average"],
      ])}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Invert Channels", "invertChannels", invertChannels, [
        ["rgb", "RGB"],
        ["r", "Red only"],
        ["g", "Green only"],
        ["b", "Blue only"],
        ["rg", "Red + Green"],
        ["gb", "Green + Blue"],
        ["rb", "Red + Blue"],
      ])}
    </section>
  `;
}

function renderExrSourceSection(params) {
  const { source } = getState();
  const passes = Array.isArray(source.exrPasses) ? source.exrPasses : [];
  if (source.mediaKind !== "exr" || passes.length === 0) return "";

  const selected = passes.some((pass) => pass.id === params.exrPass)
    ? String(params.exrPass)
    : "auto";
  const autoLabel = source.exrSelectedPass?.displayLabel || source.exrSelectedPass?.label || "Detected";
  const options = [
    ["auto", `Auto (${autoLabel})`],
    ...passes.map((pass) => [String(pass.id), String(pass.displayLabel || pass.label || pass.id)]),
  ];

  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">EXR</header>
      ${renderSelectField("Pass", "exrPass", selected, options)}
      ${renderRangeField("Exposure", "exrExposure", params.exrExposure ?? 0, -400, 400, formatSignedStops(params.exrExposure ?? 0))}
      ${renderRangeField("White Point", "exrWhitepoint", params.exrWhitepoint ?? 400, 10, 1600, `${params.exrWhitepoint ?? 400}%`)}
    </section>
  `;
}

export function renderAdjustNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Brightness", "brightness", params.brightness, -100, 100, formatSignedValue(params.brightness))}
      ${renderRangeField("Contrast", "contrast", params.contrast, 0, 200, `${params.contrast}%`)}
      ${renderRangeField("Saturation", "saturation", params.saturation, 0, 200, `${params.saturation}%`)}
      ${renderRangeField("Gamma", "gamma", params.gamma, 10, 400, `${(params.gamma / 100).toFixed(2)}`)}
      ${renderRangeField("Exposure", "exposure", params.exposure, -400, 400, formatSignedStops(params.exposure))}
    </section>
  `;
}

export function renderHsvNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Hue", "hue", params.hue, -180, 180, `${params.hue}°`)}
      ${renderRangeField("Saturation", "saturation", params.saturation, 0, 400, `${params.saturation}%`)}
      ${renderRangeField("Value", "value", params.value, 0, 400, `${params.value}%`)}
    </section>
  `;
}

export function renderInvertNode(node) {
  const params = node.params;
  const channels = String(params.channels ?? "rgb").toLowerCase();
  const options = [
    ["rgb", "RGB"],
    ["r", "Red only"],
    ["g", "Green only"],
    ["b", "Blue only"],
    ["rg", "Red + Green"],
    ["gb", "Green + Blue"],
    ["rb", "Red + Blue"],
  ];
  return `
    <section class="node-panel-section">
      ${renderSelectField("Channels", "channels", channels, options)}
    </section>
  `;
}

export function renderRgbToBwNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "bt709");
  const options = [
    ["bt709", "Bt.709 (HD)"],
    ["bt601", "Bt.601 (SD)"],
    ["average", "Average"],
  ];
  return `
    <section class="node-panel-section">
      ${renderSelectField("Coefficients", "mode", mode, options)}
    </section>
  `;
}
