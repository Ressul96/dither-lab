// Geometry node inspector renderers — Pixelate, Scale, Transform,
// Crop, and Flip. Pure string builders over the shared field
// helpers; Transform is the only one that reaches outside the
// field set, into the xy-pad module's `renderXyPadField` for the
// translate pad.

import {
  renderCheckboxField,
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import { renderXyPadField } from "./graph-xy-pad.js";

export function renderPixelateNode(node) {
  const params = node.params;
  const size = Number(params.size ?? 8);
  const sizeY = Number(params.sizeY ?? 0);
  const shape = String(params.shape ?? "square");
  const smoothing = Number(params.smoothing ?? 0);
  const gridOpacity = Number(params.gridOpacity ?? 0);
  const opacity = Number(params.opacity ?? 100);
  const sizeYLabel = sizeY > 0 ? `${sizeY}px` : `link (${size}px)`;
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Cell</header>
      ${renderRangeField("Block X", "size", size, 1, 64, `${size}px`)}
      ${renderRangeField("Block Y", "sizeY", sizeY, 0, 64, sizeYLabel)}
      ${renderSelectField("Shape", "shape", shape, [
        ["square", "Square"],
        ["circle", "Circle"],
      ])}
      ${renderRangeField("Smoothing", "smoothing", smoothing, 0, 100, `${smoothing}%`)}
      ${renderRangeField("Grid Opacity", "gridOpacity", gridOpacity, 0, 100, `${gridOpacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

export function renderScaleNode(node) {
  const params = node.params;
  const filter = params.filter ?? "linear";
  return `
    <section class="node-panel-section">
      ${renderRangeField("Width", "x", params.x, 10, 400, `${params.x}%`)}
      ${renderRangeField("Height", "y", params.y, 10, 400, `${params.y}%`)}
      ${renderSelectField("Filter", "filter", filter, [
        ["linear", "Linear (smooth)"],
        ["nearest", "Nearest (pixelated)"],
      ])}
    </section>
  `;
}

export function renderTransformNode(node) {
  const params = node.params;
  const filter = params.filter ?? "linear";
  const x = Number(params.x ?? params.scale ?? 100);
  const y = Number(params.y ?? params.scale ?? 100);
  const cropMode = String(params.cropMode ?? params.mode ?? "mask");
  const left = Number(params.left ?? 0);
  const right = Number(params.right ?? 0);
  const top = Number(params.top ?? 0);
  const bottom = Number(params.bottom ?? 0);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Position</header>
      ${renderXyPadField("Translate", "translateX", "translateY", params.translateX, params.translateY, {
        min: -100,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Translate X", "translateX", params.translateX, -100, 100, `${params.translateX}%`)}
      ${renderRangeField("Translate Y", "translateY", params.translateY, -100, 100, `${params.translateY}%`)}
      ${renderRangeField("Rotation", "rotation", params.rotation, -180, 180, `${params.rotation}°`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Scale</header>
      ${renderRangeField("Width", "x", x, 10, 400, `${x}%`)}
      ${renderRangeField("Height", "y", y, 10, 400, `${y}%`)}
      ${renderSelectField("Filter", "filter", filter, [
        ["linear", "Linear (smooth)"],
        ["nearest", "Nearest (pixelated)"],
      ])}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Flip</header>
      ${renderCheckboxField("Horizontal", "horizontal", params.horizontal)}
      ${renderCheckboxField("Vertical", "vertical", params.vertical)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Crop</header>
      ${renderSelectField("Mode", "cropMode", cropMode, [
        ["mask", "Mask outside crop"],
        ["fit", "Fit crop to frame"],
      ])}
      ${renderRangeField("Left", "left", left, 0, 95, `${left}%`)}
      ${renderRangeField("Right", "right", right, 0, 95, `${right}%`)}
      ${renderRangeField("Top", "top", top, 0, 95, `${top}%`)}
      ${renderRangeField("Bottom", "bottom", bottom, 0, 95, `${bottom}%`)}
    </section>
  `;
}

export function renderCropNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "mask");
  return `
    <section class="node-panel-section">
      ${renderSelectField("Mode", "mode", mode, [
        ["mask", "Mask outside crop"],
        ["fit", "Fit crop to frame"],
      ])}
      ${renderRangeField("Left", "left", params.left, 0, 95, `${params.left}%`)}
      ${renderRangeField("Right", "right", params.right, 0, 95, `${params.right}%`)}
      ${renderRangeField("Top", "top", params.top, 0, 95, `${params.top}%`)}
      ${renderRangeField("Bottom", "bottom", params.bottom, 0, 95, `${params.bottom}%`)}
    </section>
  `;
}

export function renderFlipNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderCheckboxField("Horizontal", "horizontal", params.horizontal)}
      ${renderCheckboxField("Vertical", "vertical", params.vertical)}
    </section>
  `;
}
