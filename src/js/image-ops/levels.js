// Levels — input black/white + gamma + output range remap. CPU
// reference per levels_entegrasyon.md §5.
//
// Two modes:
//   * rgb (default) — run the same curve on each RGB channel
//     independently. The fast path: bake the curve into a 256-entry
//     LUT once, then per pixel it's just three array reads + an
//     optional opacity blend.
//   * luma — shape the BT.601 luma via the same LUT, then scale the
//     original RGB by the new/old ratio so chroma direction is
//     preserved (avoids the tinting that channel-wise application
//     introduces on saturated colours).
//
// Identity short-circuit returns the input untouched when every
// control is at its default, skipping the canvas allocation entirely.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01 } from "./pixel-math.js";
import { luminanceBt601 } from "../color.js";

export function applyLevelsNode(input, params) {
  if (!input?.width || !input?.height) return null;

  // Slider bounds let the user temporarily cross input black/white; the
  // runtime guards against zero/negative spans here so the curve is always
  // well-defined. Input white is forced at least one byte above black.
  const inBlackByte = clamp(Number(params.inputBlack ?? 0), 0, 254);
  const inWhiteByte = Math.max(inBlackByte + 1, clamp(Number(params.inputWhite ?? 255), 1, 255));
  const inBlack = inBlackByte / 255;
  const inWhite = inWhiteByte / 255;
  const span = inWhite - inBlack;

  const gamma = clamp(Number(params.gamma ?? 100) / 100, 0.1, 4);
  const invGamma = 1 / gamma;
  const outBlack = clamp(Number(params.outputBlack ?? 0), 0, 255) / 255;
  const outWhite = clamp(Number(params.outputWhite ?? 255), 0, 255) / 255;
  const outSpan = outWhite - outBlack;
  const lumaMode = String(params.mode ?? "rgb").toLowerCase() === "luma";
  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (opacity <= 0) return input;

  // Identity short-circuit: full input range, gamma 1, full output range.
  // Skip the per-pixel work and the canvas alloc.
  const isIdentity =
    inBlackByte === 0 &&
    inWhiteByte === 255 &&
    gamma === 1 &&
    outBlack === 0 &&
    outWhite === 1 &&
    opacity === 1 &&
    !lumaMode;
  if (isIdentity) return input;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  // Build a 256-entry LUT for the channel curve once and look it up per
  // pixel — way cheaper than pow() per channel per pixel for a 4K frame.
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const normalized = clamp01((v - inBlack) / Math.max(span, 1e-6));
    const corrected = Math.pow(normalized, invGamma);
    lut[i] = outBlack + outSpan * corrected;
  }

  if (lumaMode) {
    // luma path: shape oldLuma -> newLuma via the same LUT, then rescale
    // RGB so colours don't drift. Guard against oldLuma ≈ 0 (pure black
    // pixels stay black no matter what the curve does).
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const oldLuma = luminanceBt601(r, g, b) / 255;
      // Sample the LUT at the integer luma byte (round) so the result
      // matches the RGB-mode pre-bake above.
      const lumaIndex = Math.max(0, Math.min(255, Math.round(oldLuma * 255)));
      const newLuma = lut[lumaIndex];
      const ratio = oldLuma > 1e-4 ? newLuma / oldLuma : 1;
      const rOut = Math.round(clamp01((r / 255) * ratio) * 255);
      const gOut = Math.round(clamp01((g / 255) * ratio) * 255);
      const bOut = Math.round(clamp01((b / 255) * ratio) * 255);
      if (opacity < 1) {
        data[i] = Math.round(r + (rOut - r) * opacity);
        data[i + 1] = Math.round(g + (gOut - g) * opacity);
        data[i + 2] = Math.round(b + (bOut - b) * opacity);
      } else {
        data[i] = rOut;
        data[i + 1] = gOut;
        data[i + 2] = bOut;
      }
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      const rOut = Math.round(clamp01(lut[data[i]]) * 255);
      const gOut = Math.round(clamp01(lut[data[i + 1]]) * 255);
      const bOut = Math.round(clamp01(lut[data[i + 2]]) * 255);
      if (opacity < 1) {
        data[i] = Math.round(data[i] + (rOut - data[i]) * opacity);
        data[i + 1] = Math.round(data[i + 1] + (gOut - data[i + 1]) * opacity);
        data[i + 2] = Math.round(data[i + 2] + (bOut - data[i + 2]) * opacity);
      } else {
        data[i] = rOut;
        data[i + 1] = gOut;
        data[i + 2] = bOut;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}
