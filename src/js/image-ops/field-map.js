// Field-map procedural source — renders a spatial field (radial / linear) as a
// grayscale influence map. The image counterpart of the field-probe scalar
// node: field-probe samples the field at a single point, field-map renders the
// whole field as an image that can feed displace.map / mask-apply.mask /
// gradient-map. Pure CPU fill (no GPU path yet) so preview and export evaluate
// identically.
//
// The per-pixel field math mirrors fieldProbeValue in graph-runtime.js exactly
// (same normalised 0..1 space, no aspect correction), so a field-map pixel at
// (px, py) equals the probe's scalar with its sample placed at that point.

import { createBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";

export function applyFieldMapNode(params = {}) {
  const width = clamp(Math.round(Number(params?.width ?? 1920)), 256, 4096);
  const height = clamp(Math.round(Number(params?.height ?? 1080)), 256, 4096);
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) return null;

  const shape = String(params?.shape ?? "radial");
  const cx = Number(params?.centerX ?? 50) / 100;
  const cy = Number(params?.centerY ?? 50) / 100;
  const radius = Math.max(1e-4, Number(params?.radius ?? 50) / 100);
  const smooth = String(params?.falloff ?? "linear") === "smooth";
  const invert = Boolean(params?.invert);

  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) / height;
    const dy = py - cy;
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) / width;
      const dx = px - cx;
      let v;
      if (shape === "linear-x") v = dx / radius + 0.5;
      else if (shape === "linear-y") v = dy / radius + 0.5;
      else v = 1 - Math.hypot(dx, dy) / radius;
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      if (smooth) v = v * v * (3 - 2 * v);
      if (invert) v = 1 - v;
      const g = (v * 255 + 0.5) | 0;
      const offset = (y * width + x) * 4;
      data[offset] = g;
      data[offset + 1] = g;
      data[offset + 2] = g;
      data[offset + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}
