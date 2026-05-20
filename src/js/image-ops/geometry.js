// Self-contained geometry-only image-ops nodes: invert, crop, flip.
// These three share a useful property — they don't depend on any of the
// numeric helpers (luminance, hue conversion, gradient samplers, etc.)
// that the colour-grading nodes live on, so they make a clean first
// slice of the geometry category without dragging in the rest of
// image-ops.js.
//
// External consumers import these via `../image-ops.js` re-export so
// graph-runtime.js (and any future caller) does not need to know the
// module split exists.

import { createBuffer } from "./buffer-pool.js";

// Local clamp keeps this module dep-free. The same helper exists in
// dither/core.js, but importing it would tie a geometry module to the
// dither catalog for no real reason.
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Invert — color negative across selected channels (RGB by default).
export function applyInvertNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const channels = String(params.channels ?? "rgb").toLowerCase();
  const inv = {
    r: channels.includes("r"),
    g: channels.includes("g"),
    b: channels.includes("b"),
  };
  if (!inv.r && !inv.g && !inv.b) return input;
  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (inv.r) data[i] = 255 - data[i];
    if (inv.g) data[i + 1] = 255 - data[i + 1];
    if (inv.b) data[i + 2] = 255 - data[i + 2];
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Crop — fixed-size frame with optional letterboxing. `mask` mode keeps
// the original aspect (black bars where cropped); `fit` mode stretches
// the kept region to the full output canvas.
export function applyCropNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const left = clamp(Number(params.left ?? 0), 0, 95);
  const right = clamp(Number(params.right ?? 0), 0, 95);
  const top = clamp(Number(params.top ?? 0), 0, 95);
  const bottom = clamp(Number(params.bottom ?? 0), 0, 95);
  const mode = String(params.mode ?? "mask");
  if (left === 0 && right === 0 && top === 0 && bottom === 0) return input;

  const width = input.width;
  const height = input.height;
  const sx = Math.round((left / 100) * width);
  const sy = Math.round((top / 100) * height);
  const sw = Math.max(1, Math.round(width - sx - (right / 100) * width));
  const sh = Math.max(1, Math.round(height - sy - (bottom / 100) * height));

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  if (mode === "fit") {
    ctx.drawImage(input, sx, sy, sw, sh, 0, 0, width, height);
  } else {
    ctx.drawImage(input, sx, sy, sw, sh, sx, sy, sw, sh);
  }
  return output;
}

// Flip — horizontal and/or vertical mirror. No-op when both axes off,
// returning the input directly so the runtime cache treats this node as
// pass-through and avoids the extra canvas allocation.
export function applyFlipNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const horizontal = Boolean(params.horizontal);
  const vertical = Boolean(params.vertical);
  if (!horizontal && !vertical) return input;

  const width = input.width;
  const height = input.height;
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.save();
  ctx.translate(horizontal ? width : 0, vertical ? height : 0);
  ctx.scale(horizontal ? -1 : 1, vertical ? -1 : 1);
  ctx.drawImage(input, 0, 0, width, height);
  ctx.restore();
  return output;
}
