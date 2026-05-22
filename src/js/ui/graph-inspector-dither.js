// Dither ecosystem inspector renderers — Dither (error-diffusion),
// Pattern Dither, Threshold, and the palette manager that the
// Dither node uses for swatch editing + frame-based extraction.
//
// The palette manager mutations themselves (rename, duplicate,
// delete, add/remove/edit swatch, lock toggle, extract) live in
// graph-shell's onInspectorClick / onInspectorChange handlers
// because they reach into history + selectedNode + the
// inspector's `paletteExtractionSize` module state. The size is
// injected here as a getter so the extraction <select> can paint
// the right option as selected on every render.

import { escapeHtml } from "./utils.js";
import {
  renderCheckboxField,
  renderRangeField,
  renderSelectField,
  renderSelectFieldGrouped,
} from "./graph-inspector-fields.js";
import { rgbToCss, rgbToHex } from "./graph-color-math.js";
import { getAlgorithmOptions } from "../dither/index.js";
import {
  getPalette,
  getPaletteOptionsGrouped,
  isBuiltInPalette,
} from "../palettes.js";
import { PALETTE_EXTRACTION_SIZES } from "../palette-extraction.js";
import { isSwatchLocked } from "./palette-swatch-locks.js";

let getPaletteExtractionSize = () => 4;

export function initDitherInspector(refs) {
  getPaletteExtractionSize = typeof refs.getPaletteExtractionSize === "function"
    ? refs.getPaletteExtractionSize
    : (() => 4);
}

export function renderDitherNode(node) {
  const params = node.params;
  const paletteId = params.palette ?? "monochrome";
  return `
    <section class="node-panel-section">
      ${renderSelectFieldGrouped("Algorithm", "algorithm", params.algorithm, getAlgorithmOptions())}
      ${renderSelectFieldGrouped("Palette", "palette", paletteId, getPaletteOptionsGrouped())}
      ${renderRangeField("Threshold", "threshold", params.threshold, 0, 255, String(params.threshold))}
      ${renderCheckboxField("Invert", "invert", params.invert)}
      ${renderRangeField("Scale", "scale", params.scale, 10, 100, `${params.scale}%`)}
      ${renderRangeField("Blur Radius", "blurRadius", params.blurRadius, 0, 20, `${params.blurRadius}px`)}
      ${renderRangeField(
        "Error Strength",
        "errorStrength",
        params.errorStrength,
        0,
        100,
        `${params.errorStrength}%`
      )}
      ${renderCheckboxField("Serpentine", "serpentine", params.serpentine)}
    </section>
    ${renderPaletteManager(paletteId)}
  `;
}

export function renderPatternDitherNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 100);
  const pattern = String(params.pattern ?? "bayer-4x4");
  const scale = Number(params.scale ?? 1);
  const strength = Number(params.strength ?? 100);
  const depth = Number(params.depth ?? 4);
  const gamma = String(params.gamma ?? "srgb");
  const colorCount = 2 ** Math.round(depth);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Pattern</header>
      ${renderSelectField("Type", "pattern", pattern, [
        ["none", "None"],
        ["bayer-2x2", "Bayer 2x2"],
        ["bayer-4x4", "Bayer 4x4"],
        ["bayer-8x8", "Bayer 8x8"],
        ["blue-noise", "Blue Noise"],
        ["white-noise", "White Noise"],
      ])}
      ${renderRangeField("Cell Scale", "scale", scale, 1, 8, `${scale}px`)}
      ${renderRangeField("Strength", "strength", strength, 0, 200, `${strength}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Quantization</header>
      ${renderRangeField("Color Depth", "depth", depth, 1, 8, `${depth}-bit · ${colorCount}/ch`)}
      ${renderSelectField("Gamma", "gamma", gamma, [
        ["linear", "Linear"],
        ["srgb", "sRGB-aware"],
      ])}
    </section>
  `;
}

export function renderThresholdNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const threshold = Number(params.threshold ?? 50);
  const softness = Number(params.softness ?? 0);
  const channel = String(params.channel ?? "luma");
  const invert = String(params.invert ?? "off");
  const mode = String(params.mode ?? "bw");
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Threshold</header>
      ${renderRangeField("Cutoff", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Softness", "softness", softness, 0, 50, `${softness}%`)}
      ${renderSelectField("Channel", "channel", channel, [
        ["luma", "Luma"],
        ["r", "Red"],
        ["g", "Green"],
        ["b", "Blue"],
        ["max", "Max RGB"],
      ])}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Output", "mode", mode, [
        ["bw", "Black / White"],
        ["source", "Source Mask"],
      ])}
    </section>
  `;
}

// --- Palette manager --------------------------------------------------

export function renderPaletteManager(selectedId) {
  const palette = getPalette(selectedId);
  if (!palette) return "";
  const isCustom = !isBuiltInPalette(palette.id);
  return `
    <section class="node-panel-section palette-manager">
      <header class="palette-manager__header">
        <h4>Palette Manager</h4>
        <div class="palette-manager__actions">
          <button type="button" data-palette-action="new">New</button>
          <button type="button" data-palette-action="duplicate">Duplicate</button>
          ${
            isCustom
              ? `<button type="button" data-palette-action="delete" class="palette-manager__danger">Delete</button>`
              : ""
          }
        </div>
      </header>
      ${renderPaletteManagerBody(palette, isCustom)}
    </section>
  `;
}

function renderPaletteManagerBody(palette, isCustom) {
  const extractButtonLabel = isCustom ? "Extract" : "Extract to New";
  if (!isCustom) {
    return `
      ${renderPaletteExtractionControls(extractButtonLabel)}
      <p class="hint">Built-in palette · ${palette.colors.length} colors · duplicate to edit.</p>
      <div class="palette-manager__swatches palette-manager__swatches--readonly">
        ${palette.colors
          .map(
            (c) => `<span class="palette-manager__swatch-chip" style="background:${rgbToCss(c)}"></span>`
          )
          .join("")}
      </div>
    `;
  }
  const swatches = palette.colors
    .map((color, index) =>
      renderPaletteSwatch(color, index, palette.id, palette.colors.length)
    )
    .join("");
  return `
    ${renderPaletteExtractionControls(extractButtonLabel)}
    <div class="field">
      <label>Name</label>
      <input
        type="text"
        class="palette-manager__name"
        data-palette-action="rename"
        value="${escapeHtml(palette.name)}"
      />
    </div>
    <div class="palette-manager__swatches">
      ${swatches}
      <button
        type="button"
        data-palette-action="add-swatch"
        class="palette-manager__add"
        aria-label="Add swatch"
      >+</button>
    </div>
    <p class="hint">${palette.colors.length} color${palette.colors.length === 1 ? "" : "s"}</p>
  `;
}

function renderPaletteExtractionControls(buttonLabel) {
  const selectedSize = getPaletteExtractionSize();
  return `
    <div class="field">
      <label>Extract From Current Frame</label>
      <div class="palette-manager__extract-controls">
        <div class="dropdown palette-manager__extract-size">
          <select data-palette-action="extract-size">
            ${PALETTE_EXTRACTION_SIZES
              .map(
                (size) => `
                  <option value="${size}" ${size === selectedSize ? "selected" : ""}>${size} colors</option>
                `
              )
              .join("")}
          </select>
        </div>
        <button type="button" data-palette-action="extract">${buttonLabel}</button>
      </div>
      <p class="hint">Uses the current source frame. Locked swatches stay fixed during re-extract.</p>
    </div>
  `;
}

function renderPaletteSwatch(color, index, paletteId, total) {
  const hex = rgbToHex(color);
  const canRemove = total > 1;
  const locked = isSwatchLocked(paletteId, index, total);
  return `
    <div class="palette-manager__swatch">
      <input
        type="color"
        value="${hex}"
        data-palette-action="edit-swatch"
        data-swatch-index="${index}"
        aria-label="Swatch ${index + 1}"
      />
      <button
        type="button"
        class="palette-manager__swatch-lock${locked ? " is-locked" : ""}"
        data-palette-action="toggle-lock"
        data-swatch-index="${index}"
        aria-label="${locked ? "Unlock" : "Lock"} swatch ${index + 1}"
        title="${locked ? "Unlock" : "Lock"} swatch"
      >L</button>
      ${
        canRemove
          ? `<button type="button" class="palette-manager__swatch-remove" data-palette-action="remove-swatch" data-swatch-index="${index}" aria-label="Remove swatch">×</button>`
          : ""
      }
    </div>
  `;
}
