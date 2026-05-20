// Layer adjustments — per-node opacity / hue / saturation overrides
// that the graph runtime applies on top of every effect node's output.
// Lives outside the node catalog (graph-runtime.js drives it) so
// pre/post passes share the same compose semantics.
//
// Pipeline:
//   1. If hue/saturation differ from identity, run HSV on the node
//      output (value=100 means no V scale here — V is reserved for
//      explicit HSV nodes in the chain).
//   2. If opacity is below ~1, alpha-blend the adjusted result onto
//      the base input (the layer's source frame). Below the 0.999
//      threshold to avoid an unnecessary blend pass when the user
//      effectively means "fully opaque".

import { createBuffer, releaseBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { applyHsvNode } from "./hsv.js";

export function applyLayerAdjustmentsNode(baseInput, output, layer = {}) {
  if (!output?.width || !output?.height) return output ?? null;

  const opacity = clamp(Number(layer.opacity ?? 100) / 100, 0, 1);
  const hue = Number(layer.hue ?? 0);
  const saturation = clamp(Number(layer.saturation ?? 100) / 100, 0, 2);
  const hasColorAdjust = hue !== 0 || saturation !== 1;
  const hasOpacityAdjust = opacity < 0.999;
  if (!hasColorAdjust && !hasOpacityAdjust) return output;

  let adjusted = output;
  if (hasColorAdjust) {
    adjusted = applyHsvNode(output, {
      hue,
      saturation: saturation * 100,
      value: 100,
    });
  }

  if (!hasOpacityAdjust) return adjusted;

  const blended = createBuffer(output.width, output.height);
  const ctx = blended.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, blended.width, blended.height);
  if (baseInput?.width && baseInput?.height) {
    ctx.drawImage(baseInput, 0, 0, blended.width, blended.height);
  }
  ctx.globalAlpha = opacity;
  ctx.drawImage(adjusted, 0, 0, blended.width, blended.height);
  ctx.globalAlpha = 1;

  if (adjusted !== output) releaseBuffer(adjusted);
  return blended;
}
