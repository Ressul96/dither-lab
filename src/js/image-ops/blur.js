// Shared blur utility: applies a Gaussian-style blur to a canvas, using
// the host Canvas 2D `filter` property when available (rides the
// browser's GPU compositor) and falling back to a separable box blur
// when not.
//
// Public surface is a single function — `blurImage(input, radius,
// passes?)` — consumed by the dither node's pre-blur step, the blur
// node's GPU fallback, and several glare/streak helpers. Keeping it
// here lets each consumer share the same CPU fallback instead of each
// rolling its own.

import { acquireBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { supportsBlurFilter } from "./blur-support.js";
import { createProcessingCanvas } from "../canvas.js";
import { applyBlurGpu, GAUSSIAN_BLUR_MAX_RADIUS } from "../gpu-effects.js";

// Blur node — preview/export uses the WebGL separable Gaussian path for
// any radius the GPU supports (≤ GAUSSIAN_BLUR_MAX_RADIUS), then falls
// through to blurImage's CPU box-blur fallback for wider radii or
// WebGL2-disabled hosts. The native render path explicitly excludes
// `blur` (see native-render.js) so preview always agrees with export
// pixel-for-pixel on this Gaussian implementation.
export function applyBlurNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const radius = Math.max(0, Number(params.radius ?? 0));
  if (radius === 0) return input;
  if (radius <= GAUSSIAN_BLUR_MAX_RADIUS) {
    const gpuOutput = applyBlurGpu(input, { radius });
    if (gpuOutput) return gpuOutput;
  }
  return blurImage(input, radius);
}

export function blurImage(input, radius, passes = 2) {
  const normalizedRadius = Math.max(0, Math.round(Number(radius) || 0));
  if (!input?.width || !input?.height || normalizedRadius <= 0) return input;

  if (supportsBlurFilter()) {
    // Allocate fresh instead of going through acquireBuffer: pooled
    // buffers were created with `willReadFrequently: true` for the
    // getImageData-heavy nodes, which forces a CPU backing — ctx.filter
    // blur then runs on CPU and is the actual perf cliff the user hit.
    // A new canvas with a default-options context stays GPU-friendly,
    // so the filter rides hardware compositing.
    const output = createProcessingCanvas(input.width, input.height);
    const ctx = output.getContext("2d");
    ctx.filter = `blur(${normalizedRadius}px)`;
    ctx.drawImage(input, 0, 0);
    ctx.filter = "none";
    return output;
  }

  const output = acquireBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(input, 0, 0);

  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  imageData.data.set(boxBlur(imageData.data, output.width, output.height, normalizedRadius, passes));
  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Separable box blur on a raw RGBA byte array. Two passes approximate
// a Gaussian closely enough for the perceptual targets here (dither
// pre-blur, glare halo) without paying for a real Gaussian kernel.
function boxBlur(source, width, height, radius, passes) {
  let input = new Uint8ClampedArray(source);
  let horizontal = new Uint8ClampedArray(source.length);
  let output = new Uint8ClampedArray(source.length);

  for (let pass = 0; pass < passes; pass += 1) {
    blurHorizontal(input, horizontal, width, height, radius);
    blurVertical(horizontal, output, width, height, radius);
    if (pass < passes - 1) {
      const nextInput = output;
      output = input;
      input = nextInput;
    }
  }

  return output;
}

function blurHorizontal(source, target, width, height, radius) {
  for (let y = 0; y < height; y += 1) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    let count = 0;

    for (let offset = -radius; offset <= radius; offset += 1) {
      const x = clamp(offset, 0, width - 1);
      const index = (y * width + x) * 4;
      sumR += source[index];
      sumG += source[index + 1];
      sumB += source[index + 2];
      sumA += source[index + 3];
      count += 1;
    }

    for (let x = 0; x < width; x += 1) {
      const targetIndex = (y * width + x) * 4;
      target[targetIndex] = Math.round(sumR / count);
      target[targetIndex + 1] = Math.round(sumG / count);
      target[targetIndex + 2] = Math.round(sumB / count);
      target[targetIndex + 3] = Math.round(sumA / count);

      const removeX = clamp(x - radius, 0, width - 1);
      const addX = clamp(x + radius + 1, 0, width - 1);
      const removeIndex = (y * width + removeX) * 4;
      const addIndex = (y * width + addX) * 4;

      sumR += source[addIndex] - source[removeIndex];
      sumG += source[addIndex + 1] - source[removeIndex + 1];
      sumB += source[addIndex + 2] - source[removeIndex + 2];
      sumA += source[addIndex + 3] - source[removeIndex + 3];
    }
  }
}

function blurVertical(source, target, width, height, radius) {
  for (let x = 0; x < width; x += 1) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    let count = 0;

    for (let offset = -radius; offset <= radius; offset += 1) {
      const y = clamp(offset, 0, height - 1);
      const index = (y * width + x) * 4;
      sumR += source[index];
      sumG += source[index + 1];
      sumB += source[index + 2];
      sumA += source[index + 3];
      count += 1;
    }

    for (let y = 0; y < height; y += 1) {
      const targetIndex = (y * width + x) * 4;
      target[targetIndex] = Math.round(sumR / count);
      target[targetIndex + 1] = Math.round(sumG / count);
      target[targetIndex + 2] = Math.round(sumB / count);
      target[targetIndex + 3] = Math.round(sumA / count);

      const removeY = clamp(y - radius, 0, height - 1);
      const addY = clamp(y + radius + 1, 0, height - 1);
      const removeIndex = (removeY * width + x) * 4;
      const addIndex = (addY * width + x) * 4;

      sumR += source[addIndex] - source[removeIndex];
      sumG += source[addIndex + 1] - source[removeIndex + 1];
      sumB += source[addIndex + 2] - source[removeIndex + 2];
      sumA += source[addIndex + 3] - source[removeIndex + 3];
    }
  }
}
