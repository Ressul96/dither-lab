// Posterize — quantize each RGB channel (or shared luma) into a small
// number of steps for hard banding. GPU shader handles the common case
// at preview speed; CPU fallback covers WebGL2-disabled hosts and
// supports the same gamma + luma modes for parity.
//
// Gamma toggle does the quantize in linear light (toLinear → quantize
// → toSrgb) so the banding lines fall at perceptually-uniform luma
// steps instead of bunching up in the highlights.
//
// Luma mode quantizes the BT.709 luma and rescales the original RGB
// triple so the hue stays put — useful when the user wants posterized
// bands without losing colour identity within each band.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01, mixByte } from "./pixel-math.js";
import { luminanceBt709 } from "../color.js";
import { applyPosterizeGpu } from "../gpu-effects.js";

export function applyPosterizeNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const gpuOutput = applyPosterizeGpu(input, params);
  if (gpuOutput) return gpuOutput;
  return applyPosterizeCpu(input, params);
}

function applyPosterizeCpu(input, params) {
  const stepsR = clamp(Math.round(Number(params.steps ?? 8)), 2, 64);
  const rawG = Number(params.stepsG ?? 0);
  const rawB = Number(params.stepsB ?? 0);
  const stepsG = rawG > 0 ? clamp(Math.round(rawG), 2, 64) : stepsR;
  const stepsB = rawB > 0 ? clamp(Math.round(rawB), 2, 64) : stepsR;
  const gamma = String(params.gamma ?? "linear").toLowerCase() === "srgb";
  const lumaMode = String(params.lumaMode ?? "rgb").toLowerCase() === "luma";
  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (opacity <= 0) return input;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  const levelR = stepsR - 1;
  const levelG = stepsG - 1;
  const levelB = stepsB - 1;
  for (let i = 0; i < data.length; i += 4) {
    const srcR = data[i] / 255;
    const srcG = data[i + 1] / 255;
    const srcB = data[i + 2] / 255;
    const workR = gamma ? toLinear(srcR) : srcR;
    const workG = gamma ? toLinear(srcG) : srcG;
    const workB = gamma ? toLinear(srcB) : srcB;

    let outR;
    let outG;
    let outB;
    if (lumaMode) {
      const luma = luminanceBt709(workR, workG, workB);
      const quantizedLuma = Math.floor(luma * levelR + 0.5) / levelR;
      outR = quantizedLuma + (workR - luma);
      outG = quantizedLuma + (workG - luma);
      outB = quantizedLuma + (workB - luma);
    } else {
      outR = Math.floor(clamp01(workR) * levelR + 0.5) / levelR;
      outG = Math.floor(clamp01(workG) * levelG + 0.5) / levelG;
      outB = Math.floor(clamp01(workB) * levelB + 0.5) / levelB;
    }

    const finalR = gamma ? toSrgb(clamp01(outR)) : clamp01(outR);
    const finalG = gamma ? toSrgb(clamp01(outG)) : clamp01(outG);
    const finalB = gamma ? toSrgb(clamp01(outB)) : clamp01(outB);
    data[i] = mixByte(data[i], finalR * 255, opacity);
    data[i + 1] = mixByte(data[i + 1], finalG * 255, opacity);
    data[i + 2] = mixByte(data[i + 2], finalB * 255, opacity);
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Approximate sRGB ↔ linear transfer. Using a 2.2 gamma here is fine
// for posterize's purpose — picking quantization boundaries — even
// though the real sRGB curve is the piecewise definition. The
// difference shows up only on the deepest shadows and the user is
// already coarse-quantizing the result.
function toLinear(value) {
  return Math.pow(clamp01(value), 2.2);
}

function toSrgb(value) {
  return Math.pow(clamp01(value), 1 / 2.2);
}
