// HSV node — hue rotation + saturation/value scaling in HSV space.
// Re-used by layer-adjustments (hue + saturation slice of the per-node
// layer overrides) so both call the same conversion math.
//
// rgbToHsvInto / hsvToRgbInto write into a caller-supplied target so
// the per-pixel loop can avoid allocating a fresh 3-element array on
// every iteration — the hot path here is ~25M conversions per 4K
// frame, where the allocation cost dominates the math.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01 } from "./pixel-math.js";

export function applyHsvNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const hue = Number(params.hue ?? 0);
  const saturation = clamp(Number(params.saturation ?? 100) / 100, 0, 4);
  const value = clamp(Number(params.value ?? 100) / 100, 0, 4);
  if (hue === 0 && saturation === 1 && value === 1) return input;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  const hsv = [0, 0, 0];

  for (let i = 0; i < data.length; i += 4) {
    rgbToHsvInto(data[i], data[i + 1], data[i + 2], hsv);
    hsvToRgbInto(
      ((hsv[0] + hue / 360) % 1 + 1) % 1,
      clamp01(hsv[1] * saturation),
      clamp01(hsv[2] * value),
      data,
      i
    );
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Convert one 8-bit RGB triple into HSV (h,s,v ∈ [0, 1]) and write the
// result into `target[0..2]`. h=0 when the colour is achromatic so the
// caller can shift hue without introducing a phantom angle.
export function rgbToHsvInto(r8, g8, b8, target) {
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;

  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
    if (h < 0) h += 1;
  }

  target[0] = h;
  target[1] = max === 0 ? 0 : delta / max;
  target[2] = max;
}

// Inverse of rgbToHsvInto. Writes 8-bit RGB into `target[offset..offset+2]`,
// leaving target[offset+3] (alpha) untouched.
export function hsvToRgbInto(h, s, v, target, offset) {
  const c = v * s;
  const sector = h * 6;
  const x = c * (1 - Math.abs((sector % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;

  if (sector < 1) {
    r = c;
    g = x;
  } else if (sector < 2) {
    r = x;
    g = c;
  } else if (sector < 3) {
    g = c;
    b = x;
  } else if (sector < 4) {
    g = x;
    b = c;
  } else if (sector < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  target[offset] = Math.round((r + m) * 255);
  target[offset + 1] = Math.round((g + m) * 255);
  target[offset + 2] = Math.round((b + m) * 255);
}
