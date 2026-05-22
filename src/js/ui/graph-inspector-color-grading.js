// Color grading inspector renderers — Tone Map, Levels, Duotone,
// RGB Curves, and Scene Grade. The two curve-driven nodes
// (RGB Curves + Scene Grade) compose against the curve editor
// module; Scene Grade also pulls the gradient ramp for its
// optional colour map LUT; Duotone leans on the color picker
// for its shadow/highlight pickers.

import { buildRgbCurveLut } from "../curve-lut.js";
import {
  renderCheckboxField,
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import { renderColorField } from "./graph-color-picker.js";
import {
  GRADIENT_RAMP_MAX_STOPS,
  normalizeGradientMapInspectorStops,
  renderGradientRampField,
} from "./graph-gradient-ramp.js";
import {
  curveChannelLabel,
  readCurvePoints,
  renderCurveChannelStrip,
  renderCurveField,
} from "./graph-curve-editor.js";

export function renderToneMapNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Intensity", "intensity", params.intensity, 10, 1000, `${(params.intensity / 100).toFixed(2)}x`)}
      ${renderRangeField("Whitepoint", "whitepoint", params.whitepoint, 10, 1000, `${(params.whitepoint / 100).toFixed(2)}`)}
    </section>
  `;
}

export function renderLevelsNode(node) {
  const params = node.params;
  const inputBlack = Number(params.inputBlack ?? 0);
  const inputWhite = Number(params.inputWhite ?? 255);
  const gamma = Number(params.gamma ?? 100);
  const outputBlack = Number(params.outputBlack ?? 0);
  const outputWhite = Number(params.outputWhite ?? 255);
  const mode = String(params.mode ?? "rgb");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Input</header>
      ${renderRangeField("Black", "inputBlack", inputBlack, 0, 254, String(inputBlack))}
      ${renderRangeField("White", "inputWhite", inputWhite, 1, 255, String(inputWhite))}
      ${renderRangeField("Gamma", "gamma", gamma, 10, 400, (gamma / 100).toFixed(2))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Black", "outputBlack", outputBlack, 0, 255, String(outputBlack))}
      ${renderRangeField("White", "outputWhite", outputWhite, 0, 255, String(outputWhite))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mode</header>
      ${renderSelectField("Apply", "mode", mode, [
        ["rgb", "RGB"],
        ["luma", "Luma only"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

export function renderDuotoneNode(node) {
  const params = node.params;
  const shadowColor = params.shadowColor ?? "#101010";
  const highlightColor = params.highlightColor ?? "#f4b642";
  const redGamma = Number(params.redGamma ?? 100);
  const greenGamma = Number(params.greenGamma ?? 100);
  const blueGamma = Number(params.blueGamma ?? 100);
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Colors</header>
      ${renderColorField("Shadow", "shadowColor", shadowColor, { fallback: "#101010" })}
      ${renderColorField("Highlight", "highlightColor", highlightColor, { fallback: "#f4b642" })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Channel Gamma</header>
      ${renderRangeField("Red", "redGamma", redGamma, 10, 500, (redGamma / 100).toFixed(2))}
      ${renderRangeField("Green", "greenGamma", greenGamma, 10, 500, (greenGamma / 100).toFixed(2))}
      ${renderRangeField("Blue", "blueGamma", blueGamma, 10, 500, (blueGamma / 100).toFixed(2))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

export function renderRgbCurvesNode(node) {
  const params = node.params;
  const active = String(params.activeChannel ?? "master");
  const prefix = active === "red" || active === "green" || active === "blue" ? active : "master";
  const points = readCurvePoints(node, prefix);
  const lut = buildRgbCurveLut(params, prefix);
  const overlays = ["master", "red", "green", "blue"]
    .filter((channel) => channel !== prefix)
    .map((channel) => ({
      tone: channel,
      lut: buildRgbCurveLut(params, channel),
    }));
  const applyMode = String(params.applyMode ?? "normal");
  return `
    <section class="node-panel-section curves-panel">
      ${renderCurveChannelStrip(node, prefix)}
      ${renderSelectField("Apply Mode", "applyMode", applyMode, [
        ["normal", "Normal"],
        ["luma", "Luma"],
        ["color", "Color"],
      ])}
      ${renderCurveField(`${curveChannelLabel(prefix)} Curve`, `points_${prefix}`, points, {
        tone: prefix,
        lut,
        overlays,
        legacyChannel: prefix,
        hint: "Click curve to add a point. Drag points to remap tones. Right-click a point to delete.",
      })}
    </section>
  `;
}

export function renderSceneGradeNode(node) {
  const params = node.params;
  const active = String(params.activeChannel ?? "master");
  const prefix = active === "red" || active === "green" || active === "blue" ? active : "master";
  const points = readCurvePoints(node, prefix);
  const lut = buildRgbCurveLut(params, prefix);
  const overlays = ["master", "red", "green", "blue"]
    .filter((channel) => channel !== prefix)
    .map((channel) => ({
      tone: channel,
      lut: buildRgbCurveLut(params, channel),
    }));
  const clampMin = Number(params.clampMin ?? 0);
  const clampMax = Number(params.clampMax ?? 100);
  const clampGamma = Number(params.clampGamma ?? 100);
  const colorMapFlag = String(params.colorMapEnabled ?? "off").toLowerCase();
  const colorMapEnabled =
    params.colorMapEnabled === true || colorMapFlag === "on" || colorMapFlag === "true";
  const stops = normalizeGradientMapInspectorStops(params.colorMapStops);

  return `
    <section class="node-panel-section curves-panel">
      ${renderCurveChannelStrip(node, prefix)}
      ${renderCurveField(`${curveChannelLabel(prefix)} Curve`, `points_${prefix}`, points, {
        tone: prefix,
        lut,
        overlays,
        legacyChannel: prefix,
        hint: "Scene-wide curve is applied after the graph chain and before export.",
      })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Clamp Gamma</header>
      ${renderRangeField("Min", "clampMin", clampMin, 0, 99, `${clampMin}%`)}
      ${renderRangeField("Max", "clampMax", clampMax, 1, 100, `${clampMax}%`)}
      ${renderRangeField("Gamma", "clampGamma", clampGamma, 10, 400, (clampGamma / 100).toFixed(2))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Color Map LUT</header>
      ${renderCheckboxField("Enable Color Map", "colorMapEnabled", colorMapEnabled)}
      ${colorMapEnabled ? `
        ${renderGradientRampField("Color Map", "colorMapStops", stops, {
          maxStops: GRADIENT_RAMP_MAX_STOPS,
        })}
      ` : ""}
    </section>
  `;
}
