// Lens Distortion — radial barrel/pincushion warp with optional
// chromatic dispersion and a vignette pass. Math follows Blender's
// node_composite_lens_distortion: a per-pixel scale factor based on
// the squared distance from the centre, with a separate scale per
// RGB channel for the dispersion split. One bilinear sample per
// channel — no multi-step integration since we're targeting moderate
// user values, not extreme fisheye.
//
// `type === "horizontal"` is a shortcut path: shift R left + B right
// by `dispersion * width * 0.05`, skip the radial field entirely.
// Useful for VHS/CRT bands where the radial warp would fight the
// scanline shaders downstream.
//
// Vignette is applied in-place after the channel resample so the
// darkened corners ride the distorted geometry.

import { createBuffer, releaseBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { sampleBilinearChannel } from "./sampling.js";

export function applyLensDistortNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const type = String(params.type ?? "radial");
  const distortion = clamp(Number(params.distortion ?? 0) / 100, -0.999, 1);
  const dispersion = clamp(Number(params.dispersion ?? 0) / 100, 0, 1);
  const fit = !!params.fit;
  // Center as 0..100 percent of width/height — 50 = image centre.
  const centerXPct = clamp(Number(params.centerX ?? 50) / 100, 0, 1);
  const centerYPct = clamp(Number(params.centerY ?? 50) / 100, 0, 1);
  const vignette = clamp(Number(params.vignette ?? 0) / 100, 0, 1);
  if (
    type === "radial" &&
    distortion === 0 &&
    dispersion === 0 &&
    vignette === 0 &&
    centerXPct === 0.5 &&
    centerYPct === 0.5
  ) {
    return input;
  }

  const width = input.width;
  const height = input.height;

  // Pull source pixels once.
  const srcBuf = createBuffer(width, height);
  const sctx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  sctx.drawImage(input, 0, 0);
  const srcData = sctx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const outData = ctx.createImageData(width, height);
  const out = outData.data;

  // Horizontal type: just shift R left and B right by `dispersion * width`,
  // ignoring the radial distortion field. Useful for VHS/CRT bands.
  if (type === "horizontal") {
    const shift = dispersion * width * 0.05;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        out[i] = sampleBilinearChannel(srcData, width, height, x + shift, y, 0);
        out[i + 1] = srcData[i + 1];
        out[i + 2] = sampleBilinearChannel(srcData, width, height, x - shift, y, 2);
        out[i + 3] = 255;
      }
    }
    if (vignette > 0) applyVignetteInPlace(out, width, height, centerXPct, centerYPct, vignette);
    ctx.putImageData(outData, 0, 0);
    return output;
  }

  // Per-channel distortion scaled to [-1, 1] but clamped above -0.999 (where
  // the sqrt would explode). Dispersion splits R lower / B higher around G.
  const dispScale = 4;
  const dR = clamp(distortion * dispScale - dispersion * dispScale, -0.999 * dispScale, dispScale);
  const dG = clamp(distortion * dispScale, -0.999 * dispScale, dispScale);
  const dB = clamp(distortion * dispScale + dispersion * dispScale, -0.999 * dispScale, dispScale);

  // "Fit" zooms output uv so the worst-case corner still lands inside the
  // input — derived by solving scale_fit * dist_scale_at_corner = 0.5.
  let fitScale = 1;
  if (fit) {
    const dMax = Math.max(dR, dG, dB);
    const denom = 4 + dMax;
    if (denom > 0) fitScale = 4 / denom;
  }

  // Center stays at user-controlled position; UV math normalises against the
  // shorter half-axis from the centre so the distortion stays roughly circular
  // even when the centre is off-axis.
  const cx = centerXPct * width;
  const cy = centerYPct * height;
  const halfX = Math.max(cx, width - cx);
  const halfY = Math.max(cy, height - cy);

  for (let y = 0; y < height; y++) {
    const v = ((y + 0.5 - cy) / halfY) * fitScale;
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5 - cx) / halfX) * fitScale;
      const r2 = u * u + v * v;
      const i = (y * width + x) * 4;

      // If the largest channel distortion would push the source point
      // outside the image even before sampling, write black + transparent.
      if (Math.max(dR, dG, dB) * r2 > 1) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 255;
        continue;
      }

      const sR = 1 / (1 + Math.sqrt(Math.max(0, 1 - dR * r2)));
      const sG = 1 / (1 + Math.sqrt(Math.max(0, 1 - dG * r2)));
      const sB = 1 / (1 + Math.sqrt(Math.max(0, 1 - dB * r2)));

      const xr = (u * sR) * halfX + cx;
      const yr = (v * sR) * halfY + cy;
      const xg = (u * sG) * halfX + cx;
      const yg = (v * sG) * halfY + cy;
      const xb = (u * sB) * halfX + cx;
      const yb = (v * sB) * halfY + cy;

      out[i] = sampleBilinearChannel(srcData, width, height, xr, yr, 0);
      out[i + 1] = sampleBilinearChannel(srcData, width, height, xg, yg, 1);
      out[i + 2] = sampleBilinearChannel(srcData, width, height, xb, yb, 2);
      out[i + 3] = 255;
    }
  }

  if (vignette > 0) applyVignetteInPlace(out, width, height, centerXPct, centerYPct, vignette);
  ctx.putImageData(outData, 0, 0);
  return output;
}

// In-place vignette darken centred at (centerXPct, centerYPct). Smoothstep
// falloff on the normalised distance so the centre stays untouched and the
// roll-off into the corners feels gradual rather than a hard halo.
function applyVignetteInPlace(data, width, height, centerXPct, centerYPct, amount) {
  if (amount <= 0) return;
  const cx = centerXPct * width;
  const cy = centerYPct * height;
  const halfX = Math.max(cx, width - cx);
  const halfY = Math.max(cy, height - cy);
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5 - cy) / halfY;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - cx) / halfX;
      const r = Math.min(1, Math.sqrt(nx * nx + ny * ny));
      // Smoothstep on r for a soft falloff that doesn't crush the centre.
      const fall = r * r * (3 - 2 * r);
      const factor = 1 - amount * fall;
      const i = (y * width + x) * 4;
      data[i] = Math.round(data[i] * factor);
      data[i + 1] = Math.round(data[i + 1] * factor);
      data[i + 2] = Math.round(data[i + 2] * factor);
    }
  }
}
