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
  buildCurveLut,
  buildFinalRgbCurvesLuts,
  buildRgbCurvesLuts,
  normalizeCurveApplyMode,
} from "./curve-lut.js";
import { buildGradientLut } from "./gl/gradient-lut.js";
import {
  applyBloomGpu,
  applyPosterizeGpu,
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

export function applySourceNode(input, params = {}) {
  if (!input?.width || !input?.height) return null;

  let output = input;
  const pushStep = (next) => {
    if (!next || next === output) return;
    if (output !== input) releaseBuffer(output);
    output = next;
  };

  pushStep(applyAdjustNode(output, params));
  pushStep(applyHsvNode(output, {
    hue: params.hue ?? 0,
    saturation: params.hsvSaturation ?? 100,
    value: params.value ?? 100,
  }));

  const bwMode = String(params.bwMode ?? "off");
  if (bwMode !== "off") {
    pushStep(applyRgbToBwNode(output, { mode: bwMode }));
  }

  const invert = String(params.invert ?? "off") === "on";
  if (invert) {
    pushStep(applyInvertNode(output, { channels: params.invertChannels ?? "rgb" }));
  }

  return output;
}

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
      const luma = luminanceBt601(workR, workG, workB);
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

// applyInvertNode moved to image-ops/geometry.js and re-exported at the
// top of this file. Kept here only as a breadcrumb for grep/contributors.

// RGB → BW — collapse to luminance using the user-selected coefficients.
// Bt.709 is the modern default; Bt.601 stays close to legacy NTSC source.
export function applyRgbToBwNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const mode = String(params.mode ?? "bt709");
  let cr;
  let cg;
  let cb;
  switch (mode) {
    case "bt601":
      cr = LUMA_BT601.r;
      cg = LUMA_BT601.g;
      cb = LUMA_BT601.b;
      break;
    case "average":
      cr = cg = cb = 1 / 3;
      break;
    case "bt709":
    default:
      cr = LUMA_BT709.r;
      cg = LUMA_BT709.g;
      cb = LUMA_BT709.b;
      break;
  }
  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = Math.round(cr * data[i] + cg * data[i + 1] + cb * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = luma;
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}

// applyHsvNode moved to image-ops/hsv.js. Re-exported at the top of
// this file so applyAdjustNode / applySourceNode chains keep working.

export function applyRgbCurvesNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const luts = buildRgbCurvesLuts(params);
  const applyMode = normalizeCurveApplyMode(params?.applyMode);

  if (areRgbCurvesIdentity(luts)) {
    return input;
  }
  const finalLuts = buildFinalRgbCurvesLuts(luts);

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const srcR = data[i];
    const srcG = data[i + 1];
    const srcB = data[i + 2];
    const curvedR = finalLuts.red[srcR];
    const curvedG = finalLuts.green[srcG];
    const curvedB = finalLuts.blue[srcB];

    if (applyMode === "luma") {
      scaleRgbToLumaInto(srcR, srcG, srcB, rgbLuma(curvedR, curvedG, curvedB), data, i);
    } else if (applyMode === "color") {
      scaleRgbToLumaInto(curvedR, curvedG, curvedB, rgbLuma(srcR, srcG, srcB), data, i);
    } else {
      data[i] = curvedR;
      data[i + 1] = curvedG;
      data[i + 2] = curvedB;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

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
// Levels — input black/white + gamma + output range remap. CPU reference
// per levels_entegrasyon.md §5. RGB mode runs the curve on each channel
// independently; luma mode runs it on the source luminance and rescales
// the original RGB so chroma direction is preserved (avoids tinting).
export function applyLevelsNode(input, params) {
  if (!input?.width || !input?.height) return null;

  // Slider bounds let the user temporarily cross input black/white; the
  // runtime guards against zero/negative spans here so the curve is always
  // well-defined. Input white is forced at least one byte above black.
  const inBlackByte = clamp(Number(params.inputBlack ?? 0), 0, 254);
  const inWhiteByte = Math.max(inBlackByte + 1, clamp(Number(params.inputWhite ?? 255), 1, 255));
  const inBlack = inBlackByte / 255;
  const inWhite = inWhiteByte / 255;
  const span = inWhite - inBlack;

  const gamma = clamp(Number(params.gamma ?? 100) / 100, 0.1, 4);
  const invGamma = 1 / gamma;
  const outBlack = clamp(Number(params.outputBlack ?? 0), 0, 255) / 255;
  const outWhite = clamp(Number(params.outputWhite ?? 255), 0, 255) / 255;
  const outSpan = outWhite - outBlack;
  const lumaMode = String(params.mode ?? "rgb").toLowerCase() === "luma";
  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (opacity <= 0) return input;

  // Identity short-circuit: full input range, gamma 1, full output range.
  // Skip the per-pixel work and the canvas alloc.
  const isIdentity =
    inBlackByte === 0 &&
    inWhiteByte === 255 &&
    gamma === 1 &&
    outBlack === 0 &&
    outWhite === 1 &&
    opacity === 1 &&
    !lumaMode;
  if (isIdentity) return input;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  // Build a 256-entry LUT for the channel curve once and look it up per
  // pixel — way cheaper than pow() per channel per pixel for a 4K frame.
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const normalized = clamp01((v - inBlack) / Math.max(span, 1e-6));
    const corrected = Math.pow(normalized, invGamma);
    lut[i] = outBlack + outSpan * corrected;
  }

  if (lumaMode) {
    // luma path: shape oldLuma -> newLuma via the same LUT, then rescale
    // RGB so colours don't drift. Guard against oldLuma ≈ 0 (pure black
    // pixels stay black no matter what the curve does).
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const oldLuma = luminanceBt601(r, g, b) / 255;
      // Sample the LUT at the integer luma byte (round) so the result
      // matches the RGB-mode pre-bake above.
      const lumaIndex = Math.max(0, Math.min(255, Math.round(oldLuma * 255)));
      const newLuma = lut[lumaIndex];
      const ratio = oldLuma > 1e-4 ? newLuma / oldLuma : 1;
      const rOut = Math.round(clamp01((r / 255) * ratio) * 255);
      const gOut = Math.round(clamp01((g / 255) * ratio) * 255);
      const bOut = Math.round(clamp01((b / 255) * ratio) * 255);
      if (opacity < 1) {
        data[i] = Math.round(r + (rOut - r) * opacity);
        data[i + 1] = Math.round(g + (gOut - g) * opacity);
        data[i + 2] = Math.round(b + (bOut - b) * opacity);
      } else {
        data[i] = rOut;
        data[i + 1] = gOut;
        data[i + 2] = bOut;
      }
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      const rOut = Math.round(clamp01(lut[data[i]]) * 255);
      const gOut = Math.round(clamp01(lut[data[i + 1]]) * 255);
      const bOut = Math.round(clamp01(lut[data[i + 2]]) * 255);
      if (opacity < 1) {
        data[i] = Math.round(data[i] + (rOut - data[i]) * opacity);
        data[i + 1] = Math.round(data[i + 1] + (gOut - data[i + 1]) * opacity);
        data[i + 2] = Math.round(data[i + 2] + (bOut - data[i + 2]) * opacity);
      } else {
        data[i] = rOut;
        data[i + 1] = gOut;
        data[i + 2] = bOut;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Duotone — luminance-mapped two-color gradient. Per-channel gamma biases
// the luma calculation: a high redGamma makes red areas read as brighter
// (push toward highlight color), low redGamma pushes them toward shadow.
// CPU reference per duotone_entegrasyon.md §3.
export function applyDuotoneNode(input, params) {
  if (!input?.width || !input?.height) return null;

  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (opacity <= 0) return input;

  const shadow = hexToRgb01(params.shadowColor ?? "#101010", [0.063, 0.063, 0.063]);
  const highlight = hexToRgb01(params.highlightColor ?? "#f4b642", [0.957, 0.714, 0.259]);
  const invR = 1 / clamp(Number(params.redGamma ?? 100) / 100, 0.1, 5);
  const invG = 1 / clamp(Number(params.greenGamma ?? 100) / 100, 0.1, 5);
  const invB = 1 / clamp(Number(params.blueGamma ?? 100) / 100, 0.1, 5);

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  // Pre-bake per-channel gamma curves into 256-entry LUTs so the inner
  // loop is just three array reads + a luma dot + a 3-channel mix.
  const lutR = new Float32Array(256);
  const lutG = new Float32Array(256);
  const lutB = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lutR[i] = Math.pow(v, invR);
    lutG[i] = Math.pow(v, invG);
    lutB[i] = Math.pow(v, invB);
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = lutR[data[i]];
    const g = lutG[data[i + 1]];
    const b = lutB[data[i + 2]];
    const luma = luminanceBt601(r, g, b);
    const mappedR = shadow[0] + (highlight[0] - shadow[0]) * luma;
    const mappedG = shadow[1] + (highlight[1] - shadow[1]) * luma;
    const mappedB = shadow[2] + (highlight[2] - shadow[2]) * luma;
    const outR = Math.round(clamp01(mappedR) * 255);
    const outG = Math.round(clamp01(mappedG) * 255);
    const outB = Math.round(clamp01(mappedB) * 255);
    if (opacity < 1) {
      data[i] = Math.round(data[i] + (outR - data[i]) * opacity);
      data[i + 1] = Math.round(data[i + 1] + (outG - data[i + 1]) * opacity);
      data[i + 2] = Math.round(data[i + 2] + (outB - data[i + 2]) * opacity);
    } else {
      data[i] = outR;
      data[i + 1] = outG;
      data[i + 2] = outB;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

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

export function applyDisplaceNode(input, mapInput, params) {
  if (!input?.width || !input?.height) return null;
  const xAmount = Number(params.xAmount ?? 0);
  const yAmount = Number(params.yAmount ?? 0);
  const strength = clamp(Number(params.strength ?? 100) / 100, 0, 4);
  const mode = String(params.mode ?? "wave");
  const mapMode = String(params.mapMode ?? "rg");
  const debugMap = String(params.debugMap ?? "off");
  const filter = params.filter === "nearest" ? "nearest" : "linear";
  const hasDisplacement = (xAmount !== 0 || yAmount !== 0) && strength !== 0;
  if (mode === "map" && (!mapInput?.width || !mapInput?.height)) return input;
  if (!hasDisplacement && debugMap === "off") return input;

  const width = input.width;
  const height = input.height;
  const srcBuf = createBuffer(width, height);
  const srcCtx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  srcCtx.drawImage(input, 0, 0);
  const src = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  let mapData = null;
  let mapWidth = 0;
  let mapHeight = 0;
  let mapCurve = null;
  if (mode === "map" && mapInput?.width && mapInput?.height) {
    mapWidth = mapInput.width;
    mapHeight = mapInput.height;
    const mapBuf = createBuffer(mapWidth, mapHeight);
    const mapCtx = mapBuf.getContext("2d", { alpha: false, willReadFrequently: true });
    mapCtx.drawImage(mapInput, 0, 0);
    mapData = mapCtx.getImageData(0, 0, mapWidth, mapHeight).data;
    releaseBuffer(mapBuf);
    if (mapMode === "luma") mapCurve = buildCurveLut(params.mapCurve);
  }

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  const frequency = Math.max(0.001, Number(params.frequency ?? 4));
  const phase = (Number(params.phase ?? 0) / 180) * Math.PI;
  const mapLayout = mapData
    ? createDisplaceMapLayout(width, height, mapWidth, mapHeight, params)
    : null;
  const mapSample = [0, 0, 0];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let dx;
      let dy;
      let vectorX = 0;
      let vectorY = 0;
      let hasMapSample = false;
      if (mapData) {
        sampleDisplaceMapInto(mapData, mapWidth, mapHeight, x, y, mapLayout, mapSample);
        hasMapSample = true;
        if (mapMode === "luma") {
          const luma = clamp(Math.round(rgbLuma(mapSample[0], mapSample[1], mapSample[2])), 0, 255);
          const shaped = mapCurve[luma];
          vectorX = (shaped - 128) / 128;
          vectorY = vectorX;
        } else {
          vectorX = (mapSample[0] - 128) / 128;
          vectorY = (mapSample[1] - 128) / 128;
        }
        dx = vectorX * xAmount * strength;
        dy = vectorY * yAmount * strength;
      } else {
        dx = Math.sin((y / height) * frequency * Math.PI * 2 + phase) * xAmount * strength;
        dy = Math.sin((x / width) * frequency * Math.PI * 2 + phase) * yAmount * strength;
      }

      if (hasMapSample && debugMap !== "off") {
        if (debugMap === "vectors") {
          out[i] = clamp(Math.round(128 + vectorX * 127), 0, 255);
          out[i + 1] = clamp(Math.round(128 + vectorY * 127), 0, 255);
          out[i + 2] = 128;
        } else if (mapMode === "luma") {
          const luma = clamp(Math.round(rgbLuma(mapSample[0], mapSample[1], mapSample[2])), 0, 255);
          const shaped = mapCurve[luma];
          out[i] = shaped;
          out[i + 1] = shaped;
          out[i + 2] = shaped;
        } else {
          out[i] = mapSample[0];
          out[i + 1] = mapSample[1];
          out[i + 2] = mapSample[2];
        }
        out[i + 3] = 255;
        continue;
      }

      const sx = x - dx;
      const sy = y - dy;
      if (filter === "nearest") {
        sampleNearestInto(src, width, height, sx, sy, out, i);
      } else {
        out[i] = sampleBilinearChannel(src, width, height, sx, sy, 0);
        out[i + 1] = sampleBilinearChannel(src, width, height, sx, sy, 1);
        out[i + 2] = sampleBilinearChannel(src, width, height, sx, sy, 2);
        out[i + 3] = 255;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

function createDisplaceMapLayout(width, height, mapWidth, mapHeight, params) {
  const fit = String(params.mapFit ?? "stretch");
  const offsetX = Number(params.mapOffsetX ?? 0) / 100;
  const offsetY = Number(params.mapOffsetY ?? 0) / 100;
  if (fit === "tile") {
    const mapScale = clamp(Number(params.mapScale ?? 100) / 100, 0.1, 8);
    const tileW = Math.max(1, mapWidth * mapScale);
    const tileH = Math.max(1, mapHeight * mapScale);
    return {
      fit,
      tileW,
      tileH,
      offsetX: offsetX * tileW,
      offsetY: offsetY * tileH,
    };
  }

  if (fit === "fit" || fit === "fill") {
    const scale = fit === "fit"
      ? Math.min(width / Math.max(1, mapWidth), height / Math.max(1, mapHeight))
      : Math.max(width / Math.max(1, mapWidth), height / Math.max(1, mapHeight));
    const drawW = mapWidth * scale;
    const drawH = mapHeight * scale;
    return {
      fit,
      scale,
      offsetX: (width - drawW) / 2 + offsetX * width,
      offsetY: (height - drawH) / 2 + offsetY * height,
    };
  }

  return { fit: "stretch", outputWidth: width, outputHeight: height };
}

function sampleDisplaceMapInto(data, width, height, x, y, layout, target) {
  mapSamplePositionInto(width, height, x, y, layout, target);
  const x0 = Math.floor(target[0]);
  const y0 = Math.floor(target[1]);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = target[0] - x0;
  const fy = target[1] - y0;

  for (let channel = 0; channel < 3; channel++) {
    const i00 = (y0 * width + x0) * 4 + channel;
    const i10 = (y0 * width + x1) * 4 + channel;
    const i01 = (y1 * width + x0) * 4 + channel;
    const i11 = (y1 * width + x1) * 4 + channel;
    const top = data[i00] * (1 - fx) + data[i10] * fx;
    const bottom = data[i01] * (1 - fx) + data[i11] * fx;
    target[channel] = Math.round(top * (1 - fy) + bottom * fy);
  }
}

function mapSamplePositionInto(mapWidth, mapHeight, x, y, layout, target) {
  if (layout.fit === "tile") {
    const u = positiveModulo((x - layout.offsetX) / Math.max(1, layout.tileW), 1);
    const v = positiveModulo((y - layout.offsetY) / Math.max(1, layout.tileH), 1);
    target[0] = u * Math.max(0, mapWidth - 1);
    target[1] = v * Math.max(0, mapHeight - 1);
    return;
  }

  if (layout.fit === "fit" || layout.fit === "fill") {
    target[0] = clamp((x - layout.offsetX) / Math.max(0.0001, layout.scale), 0, Math.max(0, mapWidth - 1));
    target[1] = clamp((y - layout.offsetY) / Math.max(0.0001, layout.scale), 0, Math.max(0, mapHeight - 1));
    return;
  }

  target[0] = mapWidth <= 1 ? 0 : (x / Math.max(1, (layout.outputWidth ?? 1) - 1)) * (mapWidth - 1);
  target[1] = mapHeight <= 1 ? 0 : (y / Math.max(1, (layout.outputHeight ?? 1) - 1)) * (mapHeight - 1);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

// Combines two masks (read as luma) via boolean ops. Output is a grayscale
// mask — opacity blends back toward maskA so partial intensity feels natural
// when the user wires this into an Apply downstream.
// applyMaskCombineNode + applyMaskApplyNode + sampleMaskChannel moved
// to image-ops/mix.js (mask family alongside applyMixNode + composite
// mapper). Re-exported at the top of this file.

// Smoothly darken pixels as their normalised distance from the lens centre
// approaches 1. `amount` controls the falloff strength — 0 leaves the image
// untouched, 1 fully blacks out the corners.
// applyVignetteInPlace moved alongside applyLensDistortNode into
// image-ops/lens-distort.js (its only consumer).

// rgbToHsvInto moved to image-ops/hsv.js (only consumed by applyHsvNode).

function rgbLuma(r, g, b) {
  return luminanceBt601(r, g, b);
}

function scaleRgbToLumaInto(r, g, b, targetLuma, target, offset) {
  const currentLuma = rgbLuma(r, g, b);
  if (currentLuma <= 0.001) {
    const neutral = clamp(Math.round(targetLuma), 0, 255);
    target[offset] = neutral;
    target[offset + 1] = neutral;
    target[offset + 2] = neutral;
    return;
  }
  const scale = targetLuma / currentLuma;
  target[offset] = clamp(Math.round(r * scale), 0, 255);
  target[offset + 1] = clamp(Math.round(g * scale), 0, 255);
  target[offset + 2] = clamp(Math.round(b * scale), 0, 255);
}

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

function toLinear(value) {
  return Math.pow(clamp01(value), 2.2);
}

function toSrgb(value) {
  return Math.pow(clamp01(value), 1 / 2.2);
}

// thresholdChannelValue moved to image-ops/threshold.js (single
// consumer, no other module needs it).
