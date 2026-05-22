// Duotone — remap an image's luma onto a two-colour gradient between
// the user's shadow and highlight picks. Per-channel pre-gamma lets
// the user shape how luma distributes across the gradient (a high
// redGamma compresses shadows on the red channel, etc.).
//
// Implementation: bake the per-channel gamma curves into 256-entry
// LUTs once, then the inner loop is just three array reads + a BT.709
// luma dot + a 3-channel linear interpolation. Opacity blends the
// duotone result against the original RGB at the end.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01 } from "./pixel-math.js";
import { hexToRgb01, luminanceBt709 } from "../color.js";

export function applyDuotoneNode(input, params) {
  if (!input?.width || !input?.height) return null;

  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (opacity <= 0) return input;

  const shadow = hexToRgb01(params.shadowColor ?? "#101010", [0.063, 0.063, 0.063]);
  const highlight = hexToRgb01(params.highlightColor ?? "#f4b642", [0.957, 0.714, 0.259]);
  const invR = 1 / clamp(Number(params.redGamma ?? 100) / 100, 0.1, 5);
  const invG = 1 / clamp(Number(params.greenGamma ?? 100) / 100, 0.1, 5);
  const invB = 1 / clamp(Number(params.blueGamma ?? 100) / 100, 0.1, 5);

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  // Pre-bake per-channel gamma curves into 256-entry LUTs so the inner
  // loop is just three array reads + a luma dot + a 3-channel mix.
  const lutR = new Float32Array(256);
  const lutG = new Float32Array(256);
  const lutB = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lutR[i] = Math.pow(v, invR);
    lutG[i] = Math.pow(v, invG);
    lutB[i] = Math.pow(v, invB);
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = lutR[data[i]];
    const g = lutG[data[i + 1]];
    const b = lutB[data[i + 2]];
    const luma = luminanceBt709(r, g, b);
    const mappedR = shadow[0] + (highlight[0] - shadow[0]) * luma;
    const mappedG = shadow[1] + (highlight[1] - shadow[1]) * luma;
    const mappedB = shadow[2] + (highlight[2] - shadow[2]) * luma;
    const outR = Math.round(clamp01(mappedR) * 255);
    const outG = Math.round(clamp01(mappedG) * 255);
    const outB = Math.round(clamp01(mappedB) * 255);
    if (opacity < 1) {
      data[i] = Math.round(data[i] + (outR - data[i]) * opacity);
      data[i + 1] = Math.round(data[i + 1] + (outG - data[i + 1]) * opacity);
      data[i + 2] = Math.round(data[i + 2] + (outB - data[i + 2]) * opacity);
    } else {
      data[i] = outR;
      data[i + 1] = outG;
      data[i + 2] = outB;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}
