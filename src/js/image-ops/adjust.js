// Adjust — canonical colour-grade pipeline ordered so each stage feeds
// the next perceptually rather than just clipping. The order matters:
//
//   1. exposure  (linear-ish multiplier — highlights stretch first)
//   2. gamma     (perceptual lift before tonal ops decide on midtones)
//   3. brightness (flat offset, after gamma so the lift isn't undone)
//   4. contrast  (pivot around mid-grey)
//   5. saturation (pull each channel toward / away from BT.709 luma)
//
// The earlier ordering applied exposure last, which multiplied on top
// of an already-clamped image and made highlights blow out abruptly.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01, luminance01 } from "./pixel-math.js";

export function applyAdjustNode(input, params) {
  if (!input?.width || !input?.height) return null;

  const brightness = clamp((params.brightness ?? 0) / 100, -1, 1);
  const contrast = clamp((params.contrast ?? 100) / 100, 0, 2);
  const saturation = clamp((params.saturation ?? 100) / 100, 0, 2);
  const gamma = Math.max(0.1, (params.gamma ?? 100) / 100);
  const exposure = clamp((params.exposure ?? 0) / 100, -4, 4);
  const exposureMultiplier = 2 ** exposure;

  const identity =
    brightness === 0 &&
    contrast === 1 &&
    saturation === 1 &&
    gamma === 1 &&
    exposure === 0;
  if (identity) return input;

  const output = createBuffer(input.width, input.height);
  const context = output.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(input, 0, 0);

  const imageData = context.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  for (let index = 0; index < data.length; index += 4) {
    let r = data[index] / 255;
    let g = data[index + 1] / 255;
    let b = data[index + 2] / 255;

    // 1. Exposure first — multiplies linear-ish values, so highlights stretch
    //    before downstream tonal ops decide what to do with them.
    r *= exposureMultiplier;
    g *= exposureMultiplier;
    b *= exposureMultiplier;

    // 2. Gamma — perceptual lift (gamma > 1 lightens midtones).
    if (gamma !== 1) {
      r = Math.pow(Math.max(0, r), 1 / gamma);
      g = Math.pow(Math.max(0, g), 1 / gamma);
      b = Math.pow(Math.max(0, b), 1 / gamma);
    }

    // 3. Brightness — flat offset.
    r += brightness;
    g += brightness;
    b += brightness;

    // 4. Contrast — pivot around mid-grey.
    if (contrast !== 1) {
      r = (r - 0.5) * contrast + 0.5;
      g = (g - 0.5) * contrast + 0.5;
      b = (b - 0.5) * contrast + 0.5;
    }

    // 5. Saturation — pull each channel toward / away from luma.
    if (saturation !== 1) {
      const luma = luminance01(r, g, b);
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }

    data[index] = Math.round(clamp01(r) * 255);
    data[index + 1] = Math.round(clamp01(g) * 255);
    data[index + 2] = Math.round(clamp01(b) * 255);
  }

  context.putImageData(imageData, 0, 0);
  return output;
}
