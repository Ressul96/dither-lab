// Effects inspector renderers — Glare, Lens Distort, Displace,
// Chromatic Aberration, Bloom, and Halation. Glare/Bloom/Halation
// share the "extract bright → blur → composite" lineage; Lens
// Distort and Chromatic Aberration warp coordinates; Displace
// can do either wave-driven or map-input displacement (the only
// renderer in this set that touches the curve editor, for its
// luma height map).

import { getState } from "../state.js";
import { identityCurvePoints as createIdentityCurvePoints } from "../curve-lut.js";
import {
  renderCheckboxField,
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import { renderColorField } from "./graph-color-picker.js";
import { renderXyPadField } from "./graph-xy-pad.js";
import { renderCurveField } from "./graph-curve-editor.js";

export function renderGlareNode(node) {
  const params = node.params;
  const type = String(params.type ?? "bloom-gpu");
  // Glow merges the old Bloom node into Glare: GPU variants are the fast
  // modern paths; CPU types remain for back-compat and WebGL fallback.
  const typeOptions = [
    ["bloom-gpu", "Bloom (GPU, fast)"],
    ["star-gpu", "Star Glow (GPU)"],
    ["streaks", "Streaks (CPU)"],
    ["bloom", "Bloom (CPU, legacy)"],
    ["fog-glow", "Fog Glow (CPU)"],
  ];
  const blend = String(params.blend ?? "screen");
  const blendOptions = [
    ["screen", "Screen (default)"],
    ["add", "Add (lighter)"],
    ["lighten", "Lighten"],
    ["overlay", "Overlay"],
  ];

  // Common knobs first so the most-tweaked sliders sit at the top, then
  // per-type extras, then tint at the bottom (most users keep tint at zero).
  // GPU types composite inside their shaders; CPU legacy types still expose
  // the blend selector used by the canvas compositor below.
  const isGpu = type === "bloom-gpu" || type === "star-gpu";
  const common = `
    ${renderSelectField("Type", "type", type, typeOptions)}
    ${isGpu ? "" : renderSelectField("Blend", "blend", blend, blendOptions)}
    ${renderRangeField("Threshold", "threshold", params.threshold, 0, 255, String(params.threshold))}
    ${renderRangeField("Mix", "mix", params.mix, 0, 400, `${params.mix}%`)}
    ${renderRangeField("Saturation", "saturation", params.saturation, 0, 400, `${(params.saturation / 100).toFixed(2)}x`)}
  `;

  let typeFields = "";
  if (type === "bloom-gpu") {
    const knee = Number(params.knee ?? 20);
    typeFields = `
      ${renderRangeField("Size", "size", params.size, 1, 80, `${params.size}px`)}
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
    `;
  } else if (type === "star-gpu") {
    const knee = Number(params.knee ?? 20);
    const streaks = Number(params.streaks ?? 4);
    const angle = Number(params.angle ?? 0);
    const length = Number(params.length ?? 64);
    const falloff = Number(params.falloff ?? 80);
    const alternate = Number(params.alternate ?? 100);
    const colorize = Number(params.colorize ?? 0);
    typeFields = `
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
      ${renderRangeField("Streaks", "streaks", streaks, 1, 8, String(streaks))}
      ${renderRangeField("Angle", "angle", angle, 0, 180, `${angle}°`)}
      ${renderRangeField("Length", "length", length, 1, 192, `${length}px`)}
      ${renderRangeField("Falloff", "falloff", falloff, 1, 100, `${falloff}%`)}
      ${renderRangeField("Alternate", "alternate", alternate, 0, 100, `${alternate}%`)}
      ${renderRangeField("Colorize", "colorize", colorize, 0, 100, `${colorize}%`)}
    `;
  } else if (type === "streaks") {
    typeFields = `
      ${renderRangeField("Streaks", "streaks", params.streaks, 1, 16, String(params.streaks))}
      ${renderRangeField("Angle", "angle", params.angle, 0, 180, `${params.angle}°`)}
      ${renderRangeField("Reach", "iterations", params.iterations, 1, 8, `${Math.pow(2, params.iterations)}px`)}
      ${renderRangeField("Fade", "fade", params.fade, 0, 99, `${params.fade}%`)}
    `;
  } else {
    typeFields = `
      ${renderRangeField("Size", "size", params.size, 1, 80, `${params.size}px`)}
      ${renderRangeField("Quality", "quality", params.quality, 1, 4, `${params.quality} octave${params.quality === 1 ? "" : "s"}`)}
    `;
  }

  // Tint params are CPU-only — the GPU bloom path doesn't sample per-pixel
  // hue, so hiding them avoids a slider that does nothing.
  const tintFields = isGpu
    ? ""
    : `
      ${renderRangeField("Tint Amount", "tintAmount", params.tintAmount, 0, 100, `${params.tintAmount}%`)}
      ${renderRangeField("Tint Hue", "tintHue", params.tintHue, 0, 360, `${params.tintHue}°`)}
    `;

  return `
    <section class="node-panel-section">
      ${common}
      ${typeFields}
      ${tintFields}
    </section>
  `;
}

export function renderLensDistortNode(node) {
  const params = node.params;
  const type = String(params.type ?? "radial");
  const distortLabel =
    params.distortion === 0
      ? "0 (none)"
      : params.distortion > 0
        ? `${params.distortion}% barrel`
        : `${Math.abs(params.distortion)}% pincushion`;
  const radialFields =
    type === "radial"
      ? `
        ${renderRangeField("Distortion", "distortion", params.distortion, -100, 100, distortLabel)}
        ${renderCheckboxField("Fit to frame", "fit", params.fit)}
      `
      : "";
  return `
    <section class="node-panel-section">
      ${renderSelectField("Type", "type", type, [
        ["radial", "Radial (barrel / pincushion)"],
        ["horizontal", "Horizontal (chromatic shift)"],
      ])}
      ${radialFields}
      ${renderRangeField("Dispersion", "dispersion", params.dispersion, 0, 100, `${params.dispersion}%`)}
      ${renderXyPadField("Center", "centerX", "centerY", params.centerX, params.centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Center X", "centerX", params.centerX, 0, 100, `${params.centerX}%`)}
      ${renderRangeField("Center Y", "centerY", params.centerY, 0, 100, `${params.centerY}%`)}
      ${renderRangeField("Vignette", "vignette", params.vignette, 0, 100, `${params.vignette}%`)}
    </section>
  `;
}

export function renderDisplaceNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "wave");
  const mapMode = String(params.mapMode ?? "rg");
  const mapFit = String(params.mapFit ?? "stretch");
  const debugMap = String(params.debugMap ?? "off");
  const filter = params.filter ?? "linear";
  const xAmount = Number(params.xAmount ?? 16);
  const yAmount = Number(params.yAmount ?? 0);
  const strength = Number(params.strength ?? 100);
  const frequency = Number(params.frequency ?? 4);
  const phase = Number(params.phase ?? 0);
  const mapScale = Number(params.mapScale ?? 100);
  const mapOffsetX = Number(params.mapOffsetX ?? 0);
  const mapOffsetY = Number(params.mapOffsetY ?? 0);
  const hasMapInput = (getState().graph?.edges ?? []).some(
    (edge) => edge.toNode === node.id && edge.toSocket === "map"
  );
  const waveFields = mode === "wave"
    ? `
      <section class="node-panel-section node-panel-section--titled">
        <header class="node-panel-section-title">Wave</header>
        ${renderRangeField("Frequency", "frequency", frequency, 1, 32, `${frequency}x`)}
        ${renderRangeField("Phase", "phase", phase, 0, 360, `${phase}°`)}
      </section>
    `
    : `
      <section class="node-panel-section node-panel-section--titled">
        <header class="node-panel-section-title">Map</header>
        ${renderSelectField("Map Mode", "mapMode", mapMode, [
          ["rg", "RG Vector"],
          ["luma", "Luma Height"],
        ])}
        ${renderSelectField("Map Fit", "mapFit", mapFit, [
          ["stretch", "Stretch"],
          ["fit", "Fit"],
          ["fill", "Fill"],
          ["tile", "Tile"],
        ])}
        ${mapFit === "tile" ? renderRangeField("Texture Scale", "mapScale", mapScale, 10, 800, `${mapScale}%`) : ""}
        ${mapFit === "stretch" ? "" : renderXyPadField("Offset", "mapOffsetX", "mapOffsetY", mapOffsetX, mapOffsetY, {
          min: -100,
          max: 100,
          step: 1,
          unit: "%",
        })}
        ${mapFit === "stretch" ? "" : renderRangeField("Offset X", "mapOffsetX", mapOffsetX, -100, 100, `${mapOffsetX}%`)}
        ${mapFit === "stretch" ? "" : renderRangeField("Offset Y", "mapOffsetY", mapOffsetY, -100, 100, `${mapOffsetY}%`)}
        ${renderSelectField("Debug", "debugMap", debugMap, [
          ["off", "Off"],
          ["map", "Map"],
          ["vectors", "Vectors"],
        ])}
        ${mapMode === "luma"
          ? renderCurveField("Map Curve", "mapCurve", params.mapCurve ?? createIdentityCurvePoints(), {
              tone: "master",
              hint: "Shape luma before it becomes displacement height.",
            })
          : ""}
        ${hasMapInput ? "" : `<p class="hint">Connect an image to the Map input.</p>`}
      </section>
    `;
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["wave", "Wave"],
        ["map", "Map input"],
      ])}
      ${renderXyPadField("Amount", "xAmount", "yAmount", xAmount, yAmount, {
        min: -200,
        max: 200,
        step: 1,
        unit: "px",
      })}
      ${renderRangeField("X Amount", "xAmount", xAmount, -200, 200, `${xAmount}px`)}
      ${renderRangeField("Y Amount", "yAmount", yAmount, -200, 200, `${yAmount}px`)}
      ${renderRangeField("Strength", "strength", strength, 0, 400, `${strength}%`)}
      ${renderSelectField("Filter", "filter", filter, [
        ["linear", "Linear"],
        ["nearest", "Nearest"],
      ])}
    </section>
    ${waveFields}
  `;
}

export function renderChromaticAberrationNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderSelectField("Mode", "mode", params.mode, [
        ["directional", "Directional"],
        ["radial", "Radial"],
      ])}
      ${renderRangeField("Strength", "strength", params.strength, 0, 96, `${params.strength}px`)}
      ${renderRangeField("Angle", "angle", params.angle, -180, 180, `${params.angle}deg`)}
      ${renderXyPadField("Center", "centerX", "centerY", params.centerX, params.centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Center X", "centerX", params.centerX, 0, 100, `${params.centerX}%`)}
      ${renderRangeField("Center Y", "centerY", params.centerY, 0, 100, `${params.centerY}%`)}
    </section>
  `;
}

export function renderBloomNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 100);
  const threshold = Number(params.threshold ?? 70);
  const knee = Number(params.knee ?? 20);
  const intensity = Number(params.intensity ?? 100);
  const radius = Number(params.radius ?? 16);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Bloom</header>
      ${renderRangeField("Threshold", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
      ${renderRangeField("Intensity", "intensity", intensity, 0, 400, `${intensity}%`)}
      ${renderRangeField("Radius", "radius", radius, 0, 64, `${radius}px`)}
    </section>
  `;
}

export function renderHalationNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 100);
  const threshold = Number(params.threshold ?? 70);
  const knee = Number(params.knee ?? 20);
  const intensity = Number(params.intensity ?? 120);
  const radius = Number(params.radius ?? 24);
  const tintColor = params.tintColor ?? "#ff783c";
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Halation</header>
      ${renderRangeField("Threshold", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
      ${renderRangeField("Intensity", "intensity", intensity, 0, 400, `${intensity}%`)}
      ${renderRangeField("Radius", "radius", radius, 0, 96, `${radius}px`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tint</header>
      ${renderColorField("Tint Color", "tintColor", tintColor, { fallback: "#ff783c" })}
    </section>
  `;
}
