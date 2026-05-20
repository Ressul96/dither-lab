// F18.2 procedural noise source. Companion to the gradient sources but
// kept in its own module because the underlying signal is different
// (per-pixel FBM noise rather than parametric coordinate→LUT lookup)
// and the CPU fallback is intentionally a no-op grey card until a
// real FBM port lands.
//
// GPU is the only real path today. If WebGL2 setup fails, the fallback
// returns a solid 50% grey canvas at the requested dimensions so the
// rest of the graph still has something to operate on instead of a
// null that would cascade into "nothing renders" downstream.

import { createBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { applyNoiseSourceGpu } from "../gpu-effects.js";

export function applyNoiseNode(params = {}, context = {}) {
  const gpuOutput = applyNoiseSourceGpu(params, context);
  if (gpuOutput) return gpuOutput;
  const width = clamp(Math.round(Number(params?.width ?? 1920)), 256, 4096);
  const height = clamp(Math.round(Number(params?.height ?? 1080)), 256, 4096);
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, width, height);
  return output;
}
