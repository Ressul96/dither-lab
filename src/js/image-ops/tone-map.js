// Tone Map — extended Reinhard operator with `intensity` (pre-exposure
// multiplier applied before the curve) and `whitepoint` (the target
// brightest value before the curve clips). Useful before a dither
// stage so blown-out highlights have somewhere to roll off instead
// of slamming flat to 255.
//
// Formula per channel (with `i` = intensity, `wp` = whitepoint):
//   x  = (channel / 255) * i
//   y  = x * (1 + x / wp^2) / (1 + x)
//   out = round(clamp01(y) * 255)
//
// At intensity=1 + whitepoint=1 the operation is identity for inputs
// in [0, 1]; the wrapper short-circuits that case to avoid an
// unnecessary canvas allocation.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01 } from "./pixel-math.js";

export function applyToneMapNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const intensity = clamp(Number(params.intensity ?? 100) / 100, 0.1, 10);
  const whitepoint = clamp(Number(params.whitepoint ?? 100) / 100, 0.1, 10);
  if (intensity === 1 && whitepoint === 1) return input;
  const wpSq = whitepoint * whitepoint;
  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = (data[i] / 255) * intensity;
    const g = (data[i + 1] / 255) * intensity;
    const b = (data[i + 2] / 255) * intensity;
    const tr = (r * (1 + r / wpSq)) / (1 + r);
    const tg = (g * (1 + g / wpSq)) / (1 + g);
    const tb = (b * (1 + b / wpSq)) / (1 + b);
    data[i] = Math.round(clamp01(tr) * 255);
    data[i + 1] = Math.round(clamp01(tg) * 255);
    data[i + 2] = Math.round(clamp01(tb) * 255);
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}
