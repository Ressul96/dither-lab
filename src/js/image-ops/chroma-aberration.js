// Chromatic aberration — shift the red and blue channels apart along
// a direction (linear) or radially from a centre point, leaving green
// in place. GPU path covers the common case; CPU fallback uses two
// bilinear taps per pixel for sub-pixel accuracy on small offsets.

import { createBuffer, releaseBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { sampleBilinearChannel } from "./sampling.js";
import { applyChromaticAberrationGpu } from "../gpu-effects.js";

export function applyChromaticAberrationNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const strength = clamp(Number(params.strength ?? 4), 0, 96);
  if (strength === 0) return input;

  const gpuOutput = applyChromaticAberrationGpu(input, {
    ...params,
    strength,
  });
  if (gpuOutput) return gpuOutput;

  return applyChromaticAberrationCpu(input, {
    ...params,
    strength,
  });
}

function applyChromaticAberrationCpu(input, params) {
  const width = input.width;
  const height = input.height;
  const strength = clamp(Number(params.strength ?? 4), 0, 96);
  const angle = (Number(params.angle ?? 0) / 180) * Math.PI;
  const radial = String(params.mode ?? "directional") === "radial";
  const centerX = clamp(Number(params.centerX ?? 50) / 100, 0, 1) * width;
  const centerY = clamp(Number(params.centerY ?? 50) / 100, 0, 1) * height;
  const linearDx = Math.cos(angle) * strength;
  const linearDy = Math.sin(angle) * strength;

  const srcBuf = createBuffer(width, height);
  const srcCtx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  srcCtx.drawImage(input, 0, 0);
  const src = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      let dx = linearDx;
      let dy = linearDy;
      if (radial) {
        const vx = x + 0.5 - centerX;
        const vy = y + 0.5 - centerY;
        const length = Math.max(0.0001, Math.hypot(vx, vy));
        dx = (vx / length) * strength;
        dy = (vy / length) * strength;
      }

      // Red shifted forward along the axis, blue shifted back; green
      // stays put so the eye reads the result as a fringe rather than
      // a hue rotation.
      out[index] = sampleBilinearChannel(src, width, height, x + dx, y + dy, 0);
      out[index + 1] = src[index + 1];
      out[index + 2] = sampleBilinearChannel(src, width, height, x - dx, y - dy, 2);
      out[index + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}
