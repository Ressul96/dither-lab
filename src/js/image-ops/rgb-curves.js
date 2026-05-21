// RGB Curves — bake per-channel + master curves into 256-entry LUTs
// (curve-lut.js does the heavy lifting), then look them up per pixel.
// Three apply modes:
//
//   rgb    — write the curved RGB directly (default; channel-wise).
//   luma   — keep the source RGB direction but rescale to the BT.601
//            luma of the *curved* triple. Lets curves act as a tonal
//            shaper without recolouring saturated hues.
//   color  — apply the curve as a chroma move: BT.601 luma of the
//            *source* is preserved, RGB is rescaled to the curved
//            colour. Useful for tinted grades that shouldn't push
//            shadows or highlights.

import { createBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { luminanceBt601 } from "../color.js";
import {
  areRgbCurvesIdentity,
  buildFinalRgbCurvesLuts,
  buildRgbCurvesLuts,
  normalizeCurveApplyMode,
} from "../curve-lut.js";

export function applyRgbCurvesNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const luts = buildRgbCurvesLuts(params);
  const applyMode = normalizeCurveApplyMode(params?.applyMode);

  if (areRgbCurvesIdentity(luts)) {
    return input;
  }
  const finalLuts = buildFinalRgbCurvesLuts(luts);

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const srcR = data[i];
    const srcG = data[i + 1];
    const srcB = data[i + 2];
    const curvedR = finalLuts.red[srcR];
    const curvedG = finalLuts.green[srcG];
    const curvedB = finalLuts.blue[srcB];

    if (applyMode === "luma") {
      scaleRgbToLumaInto(srcR, srcG, srcB, luminanceBt601(curvedR, curvedG, curvedB), data, i);
    } else if (applyMode === "color") {
      scaleRgbToLumaInto(curvedR, curvedG, curvedB, luminanceBt601(srcR, srcG, srcB), data, i);
    } else {
      data[i] = curvedR;
      data[i + 1] = curvedG;
      data[i + 2] = curvedB;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Rescale an RGB triple so its BT.601 luma matches `targetLuma`, then
// write into `target[offset..offset+2]`. Falls back to a flat grey at
// the requested luma when the input is effectively black — preserves
// the perceived brightness without dividing by ~0 and exploding the
// channels.
function scaleRgbToLumaInto(r, g, b, targetLuma, target, offset) {
  const currentLuma = luminanceBt601(r, g, b);
  if (currentLuma <= 0.001) {
    const neutral = clamp(Math.round(targetLuma), 0, 255);
    target[offset] = neutral;
    target[offset + 1] = neutral;
    target[offset + 2] = neutral;
    return;
  }
  const scale = targetLuma / currentLuma;
  target[offset] = clamp(Math.round(r * scale), 0, 255);
  target[offset + 1] = clamp(Math.round(g * scale), 0, 255);
  target[offset + 2] = clamp(Math.round(b * scale), 0, 255);
}
