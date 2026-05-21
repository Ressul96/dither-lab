import { hexToRgb01, LUMA_BT601, LUMA_BT709, luminanceBt601, luminanceBt709 } from "./color.js";
import { createProcessingCanvas } from "./canvas.js";
import {
  acquireBuffer,
  createBuffer,
  releaseBuffer,
} from "./image-ops/buffer-pool.js";
import {
  MASK_MODES,
  MASK_SOURCES,
  MIX_MODES,
} from "./image-ops/constants.js";
import {
  applyCropNode,
  applyFlipNode,
  applyInvertNode,
} from "./image-ops/geometry.js";
import {
  clamp,
  clamp01,
  luminance01,
  luminance8,
  mixByte,
  smoothstep,
} from "./image-ops/pixel-math.js";
import {
  applyPixelateNode,
  applyScaleNode,
  applyTransformNode,
} from "./image-ops/transform.js";
import { applyThresholdNode } from "./image-ops/threshold.js";
import { supportsBlurFilter } from "./image-ops/blur-support.js";
import {
  applyMaskApplyNode,
  applyMaskCombineNode,
  applyMixNode,
} from "./image-ops/mix.js";
import { applyBlurNode, blurImage } from "./image-ops/blur.js";
import { applyDitherNode } from "./image-ops/dither.js";
import {
  applyGradientMapNode,
  applyGradientNode,
  applyMeshGradientNode,
  sampleGradientLutInto,
} from "./image-ops/gradient.js";
import { applyNoiseNode } from "./image-ops/noise-source.js";
import { sampleBilinearChannel, sampleNearestInto } from "./image-ops/sampling.js";
import { applyChromaticAberrationNode } from "./image-ops/chroma-aberration.js";
import { applyToneMapNode } from "./image-ops/tone-map.js";
import { applyHsvNode } from "./image-ops/hsv.js";
import { applyLayerAdjustmentsNode } from "./image-ops/layer-adjustments.js";
import { applyLensDistortNode } from "./image-ops/lens-distort.js";
import { applyDisplaceNode } from "./image-ops/displace.js";
import { applyRgbToBwNode } from "./image-ops/rgb-to-bw.js";
import { applyPosterizeNode } from "./image-ops/posterize.js";
import { applyAdjustNode } from "./image-ops/adjust.js";
import { applyDuotoneNode } from "./image-ops/duotone.js";
import { applySourceNode } from "./image-ops/source.js";
import { applyLevelsNode } from "./image-ops/levels.js";
import { applyRgbCurvesNode } from "./image-ops/rgb-curves.js";
import {
  applyAnalogNode,
  applyAsciiNode,
  applyBloomNode,
  applyCrtNode,
  applyDepthOfFieldNode,
  applyHalationNode,
  applyHalftoneNode,
  applyLedScreenNode,
  applyModulationNode,
  applyPatternDitherNode,
  applyPixelSortingNode,
  applyVhsNode,
} from "./image-ops/stylize-gpu.js";

// Re-export the pool so external consumers (graph-runtime.js, source.js)
// keep importing from "./image-ops.js" unchanged. Internal effect
// functions below use the imported names directly. The mask/mix catalogs
// and the dep-free geometry nodes (invert/crop/flip) flow through here
// too so graph-shell.js + graph-runtime.js's existing import paths hold.
export { acquireBuffer, releaseBuffer };
export { MASK_MODES, MASK_SOURCES, MIX_MODES };
export { applyCropNode, applyFlipNode, applyInvertNode };
export { applyPixelateNode, applyScaleNode, applyTransformNode };
export { applyThresholdNode };
export { applyMaskApplyNode, applyMaskCombineNode, applyMixNode };
export { applyDitherNode };
export { applyGradientMapNode, applyGradientNode, applyMeshGradientNode };
export { applyBlurNode };
export { applyNoiseNode };
export { applyChromaticAberrationNode };
export { applyToneMapNode };
export { applyHsvNode };
export { applyLayerAdjustmentsNode };
export { applyLensDistortNode };
export { applyDisplaceNode };
export { applyRgbToBwNode };
export { applyPosterizeNode };
export { applyAdjustNode };
export { applyDuotoneNode };
export { applySourceNode };
export { applyLevelsNode };
export { applyRgbCurvesNode };
export {
  applyAnalogNode,
  applyAsciiNode,
  applyBloomNode,
  applyCrtNode,
  applyDepthOfFieldNode,
  applyHalationNode,
  applyHalftoneNode,
  applyLedScreenNode,
  applyModulationNode,
  applyPatternDitherNode,
  applyPixelSortingNode,
  applyVhsNode,
};
import {
  areRgbCurvesIdentity,
  buildFinalRgbCurvesLuts,
  buildRgbCurvesLuts,
} from "./curve-lut.js";
import { buildGradientLut } from "./gl/gradient-lut.js";
import {
  applyBloomGpu,
  applyStarGlowGpu,
} from "./gpu-effects.js";

// supportsBlurFilter moved to image-ops/blur-support.js so the mix
// module can share the cached feature detect without circular import.

// Adjust — canonical color-grade order: exposure (linear-light) → gamma →
// brightness offset → contrast pivot → saturation around luma. The previous
// order applied exposure last, multiplying on top of an already-clamped
// gamma-corrected value, which made bright pixels saturate immediately and
// felt unresponsive at low exposure values. Each operation only clamps once,
// at the end, so intermediate over-range values can still be brought back
// into [0,1] by a later op (e.g. exposure pushes white past 1 then contrast
// pulls it back rather than clipping mid-chain).
// applyAdjustNode moved to image-ops/adjust.js (canonical
// exposure→gamma→brightness→contrast→saturation pipeline). Re-exported
// at the top of this file so applySourceNode's chain stays unchanged.

// applySourceNode moved to image-ops/source.js — composit chain of
// adjust → hsv → rgb-to-bw → invert. All four sub-nodes live in their
// own modules now, so the source module is just orchestration.

// applyMeshGradientNode + applyGradientNode (+ their CPU bodies and
// gradientSource* helpers, wrap01) moved to image-ops/gradient.js.
// Re-exported at the top of this file. applyNoiseNode stays here for
// now since it's a different category (procedural noise source).

// applyNoiseNode moved to image-ops/noise-source.js — its own module
// because the FBM CPU fallback (today a grey-card stub) will grow
// when real noise generation lands.

// applyBlurNode moved to image-ops/blur.js (sits alongside its
// blurImage CPU fallback). Re-exported at the top of this file.

// Glare — extract bright pixels, transform into bloom / streaks / fog glow,
// blend the result over the source. Replaces the simpler Glow node; the
// Streaks type is the iconic anamorphic flare look that pure threshold-blur
// Glow couldn't produce. Algorithm follows Blender's compositor Glare at a
// high level — Streaks uses iterative power-of-2 displacement blur per
// direction, Bloom and Fog Glow are progressively wider Gaussian blurs with
// optional multi-octave passes for a softer falloff.
export function applyGlareNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const type = String(params.type ?? "streaks");

  // GPU bloom path — replaces the standalone Bloom node. We map Glow's 0-255
  // threshold and 0-400 mix down to the bloom shader's 0-100 / 0-400 ranges
  // so the inspector keeps a single consistent set of sliders across types.
  if (type === "bloom-gpu") {
    return applyBloomGpu(input, {
      opacity: 100,
      saturation: Number(params.saturation ?? 100),
      threshold: clamp(Number(params.threshold ?? 180) / 2.55, 0, 100),
      knee: Number(params.knee ?? 20),
      intensity: Number(params.mix ?? 100),
      radius: clamp(Number(params.size ?? 16), 0, 64),
    });
  }

  // Star Glow is the F4.4 GPU-first glare variant: directional streaks from
  // highlights. If WebGL2 is unavailable or the shader cannot compile, fall
  // back to the existing CPU Streaks type so saved graphs still produce a
  // visible flare instead of silently passing through.
  if (type === "star-gpu") {
    const star = applyStarGlowGpu(input, {
      threshold: clamp(Number(params.threshold ?? 180) / 2.55, 0, 100),
      knee: Number(params.knee ?? 20),
      intensity: Number(params.mix ?? 100),
      saturation: Number(params.saturation ?? 100),
      streaks: Number(params.streaks ?? 4),
      angle: Number(params.angle ?? 0),
      length: Number(params.length ?? 64),
      falloff: Number(params.falloff ?? 80),
      alternate: Number(params.alternate ?? 100),
      colorize: Number(params.colorize ?? 0),
    });
    if (star) return star;
    return applyGlareNode(input, { ...params, type: "streaks" });
  }

  const threshold = clamp(Math.round(Number(params.threshold ?? 180)), 0, 255);
  const mix = clamp(Number(params.mix ?? 100) / 100, 0, 4);
  const saturation = clamp(Number(params.saturation ?? 100) / 100, 0, 4);
  const size = Math.max(1, Number(params.size ?? 16));
  const blendMode = String(params.blend ?? "screen");
  // Tint: hue 0..360, amount 0..100. amount = 0 keeps original highlight
  // colour; amount = 100 fully replaces with the tinted hue.
  const tintAmount = clamp(Number(params.tintAmount ?? 0) / 100, 0, 1);
  const tintHue = ((Number(params.tintHue ?? 0) % 360) + 360) % 360;

  const width = input.width;
  const height = input.height;

  const bright = extractBrightPass(input, threshold, saturation, tintHue, tintAmount);

  let glare;
  switch (type) {
    case "streaks": {
      const streakCount = clamp(Math.round(Number(params.streaks ?? 4)), 1, 16);
      const angleOffset = Number(params.angle ?? 45);
      const iterations = clamp(Math.round(Number(params.iterations ?? 5)), 1, 8);
      const fade = clamp(Number(params.fade ?? 85) / 100, 0, 0.99);
      glare = renderStreaks(bright, streakCount, angleOffset, iterations, fade);
      break;
    }
    case "fog-glow": {
      const fogQuality = clamp(Math.round(Number(params.quality ?? 2)), 1, 4);
      glare = renderMultiOctaveBlur(bright, Math.min(80, size * 4), fogQuality);
      break;
    }
    case "bloom":
    default: {
      const bloomQuality = clamp(Math.round(Number(params.quality ?? 1)), 1, 4);
      glare = bloomQuality > 1 ? renderMultiOctaveBlur(bright, size, bloomQuality) : blurImage(bright, size);
      break;
    }
  }

  const output = createBuffer(width, height);
  const outCtx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  outCtx.drawImage(input, 0, 0);
  outCtx.globalAlpha = mix;
  outCtx.globalCompositeOperation = mapGlareBlend(blendMode);
  outCtx.drawImage(glare, 0, 0);
  outCtx.globalCompositeOperation = "source-over";
  outCtx.globalAlpha = 1;

  releaseBuffer(bright);
  if (glare !== bright) releaseBuffer(glare);
  return output;
}

function mapGlareBlend(mode) {
  switch (mode) {
    case "add":
      return "lighter";
    case "lighten":
      return "lighten";
    case "overlay":
      return "overlay";
    case "screen":
    default:
      return "screen";
  }
}

// Multi-octave Gaussian: blur at the requested radius, again at half the
// radius, again at a quarter, and add them together. Cheap, smooth, and
// gives bloom a richer falloff than a single radius pass.
function renderMultiOctaveBlur(bright, radius, octaves) {
  const out = createBuffer(bright.width, bright.height);
  const ctx = out.getContext("2d", { willReadFrequently: false });
  ctx.clearRect(0, 0, out.width, out.height);
  let working = radius;
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < octaves && working >= 1; i++) {
    const passed = blurImage(bright, Math.max(1, Math.round(working)));
    ctx.globalAlpha = 1 / octaves;
    ctx.drawImage(passed, 0, 0);
    if (passed !== bright) releaseBuffer(passed);
    working *= 0.5;
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return out;
}

// Pull pixels above the luma threshold into a transparent canvas, weighting
// alpha by how far above the threshold each pixel sits. Saturation can boost
// (or kill) the chroma so coloured highlights flare with their own hue, and
// a tint colour can mix in toward the user-chosen hue (amount = 1 fully
// replaces the source colour with a luma-preserving tinted version).
function extractBrightPass(input, threshold, saturation, tintHue, tintAmount) {
  const width = input.width;
  const height = input.height;
  const base = createBuffer(width, height);
  const baseCtx = base.getContext("2d", { alpha: false, willReadFrequently: true });
  baseCtx.drawImage(input, 0, 0);
  const baseData = baseCtx.getImageData(0, 0, width, height);
  const sourceData = baseData.data;

  const bright = createBuffer(width, height);
  const brightCtx = bright.getContext("2d", { willReadFrequently: true });
  const brightImage = brightCtx.createImageData(width, height);
  const brightData = brightImage.data;

  const denom = Math.max(1, 255 - threshold);
  const useTint = tintAmount > 0;
  let tintR = 1;
  let tintG = 1;
  let tintB = 1;
  if (useTint) {
    const [tr, tg, tb] = hueToRgb01(tintHue);
    tintR = tr;
    tintG = tg;
    tintB = tb;
  }
  for (let i = 0; i < sourceData.length; i += 4) {
    const r = sourceData[i];
    const g = sourceData[i + 1];
    const b = sourceData[i + 2];
    const luma = luminance8(r, g, b);
    if (luma < threshold) {
      brightData[i + 3] = 0;
      continue;
    }
    const alpha = Math.round(((luma - threshold) / denom) * 255);
    let outR;
    let outG;
    let outB;
    if (saturation === 1) {
      outR = r;
      outG = g;
      outB = b;
    } else {
      outR = clamp(luma + (r - luma) * saturation, 0, 255);
      outG = clamp(luma + (g - luma) * saturation, 0, 255);
      outB = clamp(luma + (b - luma) * saturation, 0, 255);
    }
    if (useTint) {
      // Tinted target: luma-matched pure-hue colour, then mix.
      const tR = tintR * luma;
      const tG = tintG * luma;
      const tB = tintB * luma;
      outR = outR * (1 - tintAmount) + tR * tintAmount;
      outG = outG * (1 - tintAmount) + tG * tintAmount;
      outB = outB * (1 - tintAmount) + tB * tintAmount;
    }
    brightData[i] = Math.round(outR);
    brightData[i + 1] = Math.round(outG);
    brightData[i + 2] = Math.round(outB);
    brightData[i + 3] = alpha;
  }
  brightCtx.putImageData(brightImage, 0, 0);
  releaseBuffer(base);
  return bright;
}

// HSV → RGB at saturation = 1, value = 1, returned in [0,1] floats.
function hueToRgb01(hue) {
  const h = (hue % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

// Iterative directional blur per streak axis: each iteration doubles the
// displacement and reduces alpha by `fade`, so a small constant number of
// drawImage calls covers a streak that would otherwise need a long line
// kernel. All streak directions are added with the lighter blend mode so
// a 4-streak setting at angle 45° produces the classic X flare.
function renderStreaks(brightCanvas, streakCount, angleOffset, iterations, fade) {
  const width = brightCanvas.width;
  const height = brightCanvas.height;
  const accum = createBuffer(width, height);
  const aCtx = accum.getContext("2d", { willReadFrequently: false });
  aCtx.clearRect(0, 0, width, height);

  for (let s = 0; s < streakCount; s++) {
    const angleDeg = angleOffset + (s * 360) / streakCount;
    const angle = (angleDeg / 180) * Math.PI;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    let prev = createBuffer(width, height);
    const pCtx = prev.getContext("2d", { willReadFrequently: false });
    pCtx.clearRect(0, 0, width, height);
    pCtx.drawImage(brightCanvas, 0, 0);

    for (let i = 0; i < iterations; i++) {
      const offset = 1 << i;
      const next = createBuffer(width, height);
      const nCtx = next.getContext("2d", { willReadFrequently: false });
      nCtx.clearRect(0, 0, width, height);
      nCtx.drawImage(prev, 0, 0);
      nCtx.globalAlpha = fade;
      nCtx.drawImage(prev, dirX * offset, dirY * offset);
      nCtx.globalAlpha = 1;
      releaseBuffer(prev);
      prev = next;
    }

    aCtx.globalCompositeOperation = "lighter";
    aCtx.drawImage(prev, 0, 0);
    aCtx.globalCompositeOperation = "source-over";
    releaseBuffer(prev);
  }

  return accum;
}

// Posterize — reduce smooth gradients to N discrete color levels per channel.
// Tries the GPU shader first (supports per-channel steps, gamma, luma mode);
// falls back to the legacy CPU path for old saves on machines without WebGL2.
// applyPosterizeNode + applyPosterizeCpu + toLinear/toSrgb moved to
// image-ops/posterize.js. Re-exported at the top of this file.

// applyInvertNode moved to image-ops/geometry.js and re-exported at the
// top of this file. Kept here only as a breadcrumb for grep/contributors.

// applyRgbToBwNode moved to image-ops/rgb-to-bw.js (luma collapse with
// selectable BT.709/BT.601/average coefficients). Re-exported at the
// top of this file so applySourceNode's bwMode chain + graph-runtime
// stay unchanged.

// applyHsvNode moved to image-ops/hsv.js. Re-exported at the top of
// this file so applyAdjustNode / applySourceNode chains keep working.

// applyRgbCurvesNode moved to image-ops/rgb-curves.js (LUT-based
// channel curves with rgb / luma / color apply modes). The
// scaleRgbToLumaInto helper moved with it (only consumer); the
// thin rgbLuma wrapper was inlined to luminanceBt601 calls. Re-
// exported at the top of this file.

// Scene Grade — final scene-wide color pass intended to sit immediately before
// Viewer Output. It reuses the RGB curves LUT path, then performs clamp/gamma
// remapping, and can optionally map the final luma through the shared gradient
// LUT helper.
export function applySceneGradeNode(input, params = {}) {
  if (!input?.width || !input?.height) return null;

  const luts = buildRgbCurvesLuts(params);
  const hasCurves = !areRgbCurvesIdentity(luts);
  const clampMin = clamp(Number(params.clampMin ?? 0) / 100, 0, 1);
  const rawClampMax = clamp(Number(params.clampMax ?? 100) / 100, 0, 1);
  const clampMax = Math.max(rawClampMax, clampMin + 0.001);
  const clampGamma = clamp(Number(params.clampGamma ?? 100) / 100, 0.01, 4);
  const hasClamp =
    Math.abs(clampMin) > 1e-6 ||
    Math.abs(clampMax - 1) > 1e-6 ||
    Math.abs(clampGamma - 1) > 1e-6;
  const colorMapFlag = String(params.colorMapEnabled ?? "off").toLowerCase();
  const colorMapEnabled =
    params.colorMapEnabled === true || colorMapFlag === "on" || colorMapFlag === "true";

  if (!hasCurves && !hasClamp && !colorMapEnabled) return input;

  const finalLuts = hasCurves ? buildFinalRgbCurvesLuts(luts) : null;
  const colorMapLut = colorMapEnabled
    ? buildGradientLut(sceneGradeColorMapStops(params))
    : null;
  const colorMapData = colorMapLut?.data ?? null;
  const colorMapWidth = colorMapLut?.width ?? 0;
  const range = clampMax - clampMin;
  const inverseGamma = 1 / clampGamma;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  const mapped = [0, 0, 0];

  for (let i = 0; i < data.length; i += 4) {
    let r = hasCurves ? finalLuts.red[data[i]] : data[i];
    let g = hasCurves ? finalLuts.green[data[i + 1]] : data[i + 1];
    let b = hasCurves ? finalLuts.blue[data[i + 2]] : data[i + 2];

    let rf = r / 255;
    let gf = g / 255;
    let bf = b / 255;

    if (hasClamp) {
      rf = Math.pow(clamp01((rf - clampMin) / range), inverseGamma);
      gf = Math.pow(clamp01((gf - clampMin) / range), inverseGamma);
      bf = Math.pow(clamp01((bf - clampMin) / range), inverseGamma);
    }

    if (colorMapData) {
      const luma = luminanceBt709(rf, gf, bf);
      sampleGradientLutInto(colorMapData, colorMapWidth, luma, mapped, 0);
      rf = mapped[0] / 255;
      gf = mapped[1] / 255;
      bf = mapped[2] / 255;
    }

    data[i] = Math.round(clamp01(rf) * 255);
    data[i + 1] = Math.round(clamp01(gf) * 255);
    data[i + 2] = Math.round(clamp01(bf) * 255);
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

function sceneGradeColorMapStops(params) {
  if (Array.isArray(params?.colorMapStops) && params.colorMapStops.length > 0) {
    return params.colorMapStops;
  }
  return [
    { pos: 0, color: params?.colorMapShadow ?? "#111111" },
    { pos: 1, color: params?.colorMapHighlight ?? "#ffffff" },
  ];
}

// applyLayerAdjustmentsNode moved to image-ops/layer-adjustments.js
// (per-node opacity / hue / saturation override pass driven by the
// graph runtime). Re-exported at the top of this file.

// Pixelate — collapse NxN blocks of source pixels into a single color so the
// downstream chain (especially dither) operates on a chunky low-resolution
// version of the image without changing canvas dimensions.
//
// GPU shader is the primary path (supports separate X/Y aspect, circle
// pixels, edge softness). Legacy CPU path stays available as a fallback
// when WebGL2 is missing — it runs canvas downscale + nearest upscale
// which is the cheapest box-average we can do with the 2D API.
// applyPixelateNode + applyScaleNode + applyTransformNode moved to
// image-ops/transform.js and re-exported at the top of this file.
// applyCropNode + applyFlipNode moved to image-ops/geometry.js and
// re-exported at the top of this file.

// Tone Map — extended Reinhard with intensity (pre-exposure) + whitepoint
// (target brightest value). Useful before dither so blown highlights have
// somewhere to go instead of clipping to white.
// applyLevelsNode moved to image-ops/levels.js (input black/white +
// gamma + output range remap with optional luma mode). Re-exported
// at the top of this file.

// Duotone — luminance-mapped two-color gradient. Per-channel gamma biases
// the luma calculation: a high redGamma makes red areas read as brighter
// (push toward highlight color), low redGamma pushes them toward shadow.
// CPU reference per duotone_entegrasyon.md §3.
// applyDuotoneNode moved to image-ops/duotone.js (per-channel gamma
// LUT + luma → shadow/highlight gradient remap). Re-exported above.

// Gradient Map — maps a scalar signal (luma by default) through the shared
// gradient LUT. GPU owns the hot path; CPU fallback keeps WebGL2-disabled
// environments visually consistent and exercises the same LUT helper.
// applyGradientMapNode (+ CPU body and gradientMap* helpers) moved to
// image-ops/gradient.js. sampleGradientLutInto is re-imported above so
// the scene-grade node (still in this file) can keep using it.

// applyToneMapNode moved to image-ops/tone-map.js (extended Reinhard
// with intensity + whitepoint). Re-exported at the top of this file.

// Lens Distortion — radial barrel/pincushion warp with optional chromatic
// aberration. Replaces the old sine-wave Distort node, which wasn't really
// what "distort" meant in any compositor. Math follows Blender's
// node_composite_lens_distortion: a per-pixel scale factor based on the
// squared distance from center, with a separate scale per RGB channel for
// the dispersion split. Single-tap bilinear samples per channel — no
// multi-step integration since we're targeting moderate user values.
// applyLensDistortNode + applyVignetteInPlace moved to
// image-ops/lens-distort.js. Re-exported at the top of this file.

// 12 trivial GPU-passthrough wrappers (halftone, led-screen, modulation,
// pixel-sorting, depth-of-field, vhs, crt, analog, bloom, halation,
// ascii, pattern-dither) moved to image-ops/stylize-gpu.js and
// re-exported at the top of this file.

// applyThresholdNode + thresholdChannelValue moved to
// image-ops/threshold.js and re-exported at the top of this file.

// applyChromaticAberrationNode + applyChromaticAberrationCpu moved to
// image-ops/chroma-aberration.js. Re-exported at the top of this file.

// applyDisplaceNode (+ createDisplaceMapLayout + sampleDisplaceMapInto
// + mapSamplePositionInto + positiveModulo) moved to image-ops/displace.js.
// Re-exported at the top of this file.

// applyMaskCombineNode + applyMaskApplyNode + sampleMaskChannel moved
// to image-ops/mix.js (mask family alongside applyMixNode + composite
// mapper). Re-exported at the top of this file.

// Smoothly darken pixels as their normalised distance from the lens centre
// approaches 1. `amount` controls the falloff strength — 0 leaves the image
// untouched, 1 fully blacks out the corners.
// applyVignetteInPlace moved alongside applyLensDistortNode into
// image-ops/lens-distort.js (its only consumer).

// rgbToHsvInto moved to image-ops/hsv.js (only consumed by applyHsvNode).

// rgbLuma / scaleRgbToLumaInto moved alongside applyRgbCurvesNode into
// image-ops/rgb-curves.js (the only consumer). rgbLuma was a 1-line
// wrapper around luminanceBt601 and is now inlined at the call site.

// hsvToRgbInto moved to image-ops/hsv.js (only consumed by applyHsvNode).

// sampleBilinearChannel + sampleNearestInto moved to
// image-ops/sampling.js. Imported at the top so the 9 callsites
// inside this file resolve through the shared module.

// applyMixNode + mapCompositeMode moved to image-ops/mix.js. The
// MIX_MODES catalog lives in image-ops/constants.js (re-exported at
// the top of this file so graph-shell.js's import path holds).

// applyDitherNode moved to image-ops/dither.js (CPU palette-aware
// dither orchestrator). Re-exported at the top of this file.

// blurImage + boxBlur (+ blurHorizontal/blurVertical) moved to
// image-ops/blur.js. Imported at the top so the 4 callers in this file
// (blur node, dither node, glare/bloom paths, streaks) resolve through
// the shared module.

// clamp, clamp01, mixByte, smoothstep, luminance8, luminance01 moved to
// image-ops/pixel-math.js. Imported at the top of this file so existing
// callsites inside image-ops resolve unchanged.

// toLinear / toSrgb moved alongside applyPosterizeCpu into
// image-ops/posterize.js (its only consumer).

// thresholdChannelValue moved to image-ops/threshold.js (single
// consumer, no other module needs it).
