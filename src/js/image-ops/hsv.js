// HSV node — hue rotation + saturation/value scaling in HSV space.
// Re-used by layer-adjustments (hue + saturation slice of the per-node
// layer overrides), which calls applyHsvNode directly.
//
// The RGB->HSV->RGB conversion is inlined into the per-pixel loop below:
// at ~2M+ pixels/frame the function-call and shared-array overhead of a
// helper-based version dominated the actual math.

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
  const hueShift = hue / 360;

  // Inlined RGB->HSV->RGB round trip. A helper-based version paid two function
  // calls plus a shared hsv[] array read/write per pixel, which dominated this
  // 2M+ pixel/frame loop. Keeping every value on the stack is ~1.3x faster; the
  // arithmetic — branch order and Math.round included — is unchanged, so
  // preview/export output is byte-for-byte identical.
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const delta = max - min;

    let h = 0;
    if (delta > 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    const s = max === 0 ? 0 : delta / max;

    h = ((h + hueShift) % 1 + 1) % 1;
    const outS = clamp01(s * saturation);
    const outV = clamp01(max * value);

    const c = outV * outS;
    const sector = h * 6;
    const x = c * (1 - Math.abs((sector % 2) - 1));
    const m = outV - c;
    let nr = 0;
    let ng = 0;
    let nb = 0;
    if (sector < 1) { nr = c; ng = x; }
    else if (sector < 2) { nr = x; ng = c; }
    else if (sector < 3) { ng = c; nb = x; }
    else if (sector < 4) { ng = x; nb = c; }
    else if (sector < 5) { nr = x; nb = c; }
    else { nr = c; nb = x; }

    data[i] = Math.round((nr + m) * 255);
    data[i + 1] = Math.round((ng + m) * 255);
    data[i + 2] = Math.round((nb + m) * 255);
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}
