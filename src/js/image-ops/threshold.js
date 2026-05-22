// Standalone Threshold node. Separate from the Dither node's "Simple
// Threshold" algorithm: this one keeps source colours when its `mode`
// is "source", supports per-channel and luma comparison, and runs as
// either GPU (cheap fullscreen-quad pass) or CPU fallback with the same
// soft-edge semantics.
//
// Luma here uses BT.709 — the project canon, matches the GPU shaders
// and the rest of the CPU image-ops (posterize / levels / duotone /
// gradient-map / rgb-curves). The channel labels (red/green/blue/luma
// /max) map to a single scalar comparison and the default "luma" picks
// these coefficients.

import { createBuffer } from "./buffer-pool.js";
import { clamp, mixByte, smoothstep } from "./pixel-math.js";
import { luminanceBt709 } from "../color.js";
import { applyThresholdGpu } from "../gpu-effects.js";

export function applyThresholdNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // GPU is the default; CPU fallback keeps WebGL2-disabled environments
  // visually consistent rather than dropping the node to a passthrough.
  const gpuOutput = applyThresholdGpu(input, params);
  return gpuOutput ?? applyThresholdCpu(input, params);
}

function applyThresholdCpu(input, params) {
  const threshold = clamp(Number(params.threshold ?? 50) / 100, 0, 1);
  const softness = clamp(Number(params.softness ?? 0) / 100, 0, 0.5);
  const channel = String(params.channel ?? "luma").toLowerCase();
  const invert = String(params.invert ?? "off").toLowerCase() === "on";
  const sourceMode = String(params.mode ?? "bw").toLowerCase() === "source";
  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (opacity <= 0) return input;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  const low = Math.max(threshold - softness, 0);
  const high = threshold + softness + 0.001;

  for (let i = 0; i < data.length; i += 4) {
    const srcR = data[i];
    const srcG = data[i + 1];
    const srcB = data[i + 2];
    const value = thresholdChannelValue(srcR / 255, srcG / 255, srcB / 255, channel);
    let mask = smoothstep(low, high, value);
    if (invert) mask = 1 - mask;

    const outR = sourceMode ? srcR * mask : mask * 255;
    const outG = sourceMode ? srcG * mask : mask * 255;
    const outB = sourceMode ? srcB * mask : mask * 255;
    data[i] = mixByte(srcR, outR, opacity);
    data[i + 1] = mixByte(srcG, outG, opacity);
    data[i + 2] = mixByte(srcB, outB, opacity);
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Select the scalar this node thresholds against. `luma` is the only
// branch that touches color coefficients; the channel branches return
// the raw 0..1 normalised value of the selected component.
function thresholdChannelValue(r, g, b, channel) {
  switch (channel) {
    case "r":
    case "red":
      return r;
    case "g":
    case "green":
      return g;
    case "b":
    case "blue":
      return b;
    case "max":
      return Math.max(r, g, b);
    case "luma":
    default:
      return luminanceBt709(r, g, b);
  }
}
