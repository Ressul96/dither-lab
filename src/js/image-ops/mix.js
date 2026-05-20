// Compositing nodes: Mix (two-image blend with a `mode` from MIX_MODES)
// plus the mask family — Mask Combine (boolean ops between two masks)
// and Mask Apply (mask multiplied into an image, with optional feather
// and stencil mode).
//
// Dependency note: applyMaskApplyNode's feather uses canvas blur via
// supportsBlurFilter; mix's blend modes ride directly on Canvas 2D
// globalCompositeOperation (mapCompositeMode handles the legacy `add`
// alias). Luma here is BT.709 since masks read perceptual brightness.

import { createBuffer, releaseBuffer } from "./buffer-pool.js";
import { clamp, luminance8 } from "./pixel-math.js";
import { supportsBlurFilter } from "./blur-support.js";

// Combine two masks via boolean op into a new mask. Inputs are read as
// luma; missing inputs pass through the other side so a half-wired
// graph still produces a sensible mask downstream.
export function applyMaskCombineNode(maskA, maskB, params) {
  if (!maskA?.width || !maskA?.height) {
    // No A — pass through B (or null) so downstream nodes still see *something*.
    return maskB ?? null;
  }
  if (!maskB?.width || !maskB?.height) return maskA;

  const width = maskA.width;
  const height = maskA.height;
  const operation = String(params?.operation ?? "intersect").toLowerCase();
  const invertA = String(params?.invertA ?? "off").toLowerCase() === "on";
  const invertB = String(params?.invertB ?? "off").toLowerCase() === "on";
  const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);

  const aBuf = createBuffer(width, height);
  const aCtx = aBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  aCtx.drawImage(maskA, 0, 0);
  const aData = aCtx.getImageData(0, 0, width, height).data;

  const bBuf = createBuffer(width, height);
  const bCtx = bBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  bCtx.drawImage(maskB, 0, 0, width, height);
  const bData = bCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(bBuf);

  const output = createBuffer(width, height);
  const outCtx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = outCtx.createImageData(width, height);
  const out = imageData.data;

  for (let i = 0; i < aData.length; i += 4) {
    let aLuma = luminance8(aData[i], aData[i + 1], aData[i + 2]) / 255;
    let bLuma = luminance8(bData[i], bData[i + 1], bData[i + 2]) / 255;
    if (invertA) aLuma = 1 - aLuma;
    if (invertB) bLuma = 1 - bLuma;
    let combined;
    switch (operation) {
      case "union":
        combined = Math.max(aLuma, bLuma);
        break;
      case "difference":
        combined = Math.abs(aLuma - bLuma);
        break;
      case "subtract":
        combined = Math.max(0, aLuma - bLuma);
        break;
      case "intersect":
      default:
        combined = Math.min(aLuma, bLuma);
        break;
    }
    // Opacity blends back to A's luma so a lower opacity feels like a partial
    // mix into A rather than fading toward black.
    const finalLuma = aLuma + (combined - aLuma) * opacity;
    const byte = clamp(Math.round(finalLuma * 255), 0, 255);
    out[i] = byte;
    out[i + 1] = byte;
    out[i + 2] = byte;
    out[i + 3] = 255;
  }

  releaseBuffer(aBuf);
  outCtx.putImageData(imageData, 0, 0);
  return output;
}

// Sample one channel from a mask pixel into 0..1. Falls through to luma so
// legacy projects without an explicit `source` keep their current look.
// (MASK_SOURCES + MASK_MODES catalogs live in image-ops/constants.js.)
function sampleMaskChannel(data, i, source) {
  switch (source) {
    case "alpha":
      return data[i + 3] / 255;
    case "r":
      return data[i] / 255;
    case "g":
      return data[i + 1] / 255;
    case "b":
      return data[i + 2] / 255;
    case "luma":
    default:
      return luminance8(data[i], data[i + 1], data[i + 2]) / 255;
  }
}

// Multiplies the input image by a mask (read per `source` channel) so
// dark mask regions black out the image. Optional feather softens the
// mask edges via the native canvas blur (falls back to a no-op when
// supportsBlurFilter is false). Opacity blends back to the original.
export function applyMaskApplyNode(input, mask, params) {
  if (!input?.width || !input?.height) return null;
  if (!mask?.width || !mask?.height) return input;

  const width = input.width;
  const height = input.height;
  const invert = String(params?.invert ?? "off").toLowerCase() === "on";
  const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
  const feather = Math.max(0, Math.round(Number(params?.feather ?? 0)));
  const source = String(params?.source ?? "luma").toLowerCase();
  const mode = String(params?.mode ?? "multiply").toLowerCase() === "stencil"
    ? "stencil"
    : "multiply";

  const srcBuf = createBuffer(width, height);
  // Alpha channel must survive so the `source: "alpha"` path can read it. The
  // legacy `{ alpha: false }` context flag forced premultiplied opacity to 255
  // for every pixel — fine when we only read luma, but wrong for an alpha
  // mask. Render into a transparent buffer instead.
  const srcCtx = srcBuf.getContext("2d", { willReadFrequently: true });
  srcCtx.clearRect(0, 0, width, height);
  srcCtx.drawImage(input, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  const maskBuf = createBuffer(width, height);
  const maskCtx = maskBuf.getContext("2d", { willReadFrequently: true });
  maskCtx.clearRect(0, 0, width, height);
  // Native canvas blur for feather — falls back to a no-op if unsupported,
  // which is fine: feather=0 is the most common case anyway.
  if (feather > 0 && supportsBlurFilter()) {
    maskCtx.filter = `blur(${feather}px)`;
  }
  maskCtx.drawImage(mask, 0, 0, width, height);
  maskCtx.filter = "none";
  const maskData = maskCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(maskBuf);

  const output = createBuffer(width, height);
  const outCtx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = outCtx.createImageData(width, height);
  const out = imageData.data;

  for (let i = 0; i < srcData.length; i += 4) {
    let m = sampleMaskChannel(maskData, i, source);
    if (invert) m = 1 - m;
    // Stencil hard-clips: anything below 0.5 reads as zero, anything above
    // reads as one. Multiply keeps the continuous luma fade.
    if (mode === "stencil") m = m >= 0.5 ? 1 : 0;
    // Multiplied output: where mask=0 → black, mask=1 → source.
    // Opacity blends from full source (opacity=0) to fully masked (opacity=1).
    const r = srcData[i];
    const g = srcData[i + 1];
    const b = srcData[i + 2];
    const masked = (channel) => channel * m;
    out[i] = clamp(Math.round(r + (masked(r) - r) * opacity), 0, 255);
    out[i + 1] = clamp(Math.round(g + (masked(g) - g) * opacity), 0, 255);
    out[i + 2] = clamp(Math.round(b + (masked(b) - b) * opacity), 0, 255);
    out[i + 3] = 255;
  }

  outCtx.putImageData(imageData, 0, 0);
  return output;
}

// Mix — two-image blend by `factor` (0..1) through a Canvas 2D composite
// op. `add` is the only non-Photoshop alias kept for legacy project
// compatibility; everything else maps directly onto Canvas 2D's
// globalCompositeOperation, which the browser GPU-composites natively.
export function applyMixNode(inputA, inputB, params) {
  const primary = inputA ?? inputB;
  if (!primary?.width || !primary?.height) return null;

  const width = primary.width;
  const height = primary.height;
  const factor = clamp((params.factor ?? 50) / 100, 0, 1);
  const mode = params.mode ?? "normal";
  if (!inputB) return inputA ?? null;
  if (factor === 0 && inputA) return inputA;

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  if (inputA) ctx.drawImage(inputA, 0, 0, width, height);
  if (inputB) {
    ctx.globalAlpha = factor;
    ctx.globalCompositeOperation = mapCompositeMode(mode);
    ctx.drawImage(inputB, 0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }
  return output;
}

function mapCompositeMode(mode) {
  switch (mode) {
    case "add":
      return "lighter";
    case "multiply":
    case "screen":
    case "overlay":
    case "darken":
    case "lighten":
    case "color-dodge":
    case "color-burn":
    case "hard-light":
    case "soft-light":
    case "difference":
    case "exclusion":
    case "hue":
    case "saturation":
    case "color":
    case "luminosity":
      return mode;
    case "normal":
    default:
      return "source-over";
  }
}
