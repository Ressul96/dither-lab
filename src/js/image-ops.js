import { runAlgorithm } from "./dither/index.js";
import { getPalette } from "./palettes.js";
import { hexToRgb01 } from "./color.js";
import { buildGradientLut } from "./gl/gradient-lut.js";
import {
  applyAsciiGpu,
  applyBloomGpu,
  applyChromaticAberrationGpu,
  applyCrtGpu,
  applyHalationGpu,
  applyHalftoneGpu,
  applyGradientMapGpu,
  applyMeshGradientGpu,
  applyPatternDitherGpu,
  applyPixelateGpu,
  applyPosterizeGpu,
  applyThresholdGpu,
  applyVhsGpu,
} from "./gpu-effects.js";

let supportsCanvasBlurFilter = null;

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

export function applyMeshGradientNode(params = {}, context = {}) {
  const gpuOutput = applyMeshGradientGpu(params, context);
  if (gpuOutput) return gpuOutput;
  return applyMeshGradientCpu(params, context);
}

function applyMeshGradientCpu(params = {}, context = {}) {
  const width = clamp(Math.round(Number(params.width ?? 1920)), 256, 4096);
  const height = clamp(Math.round(Number(params.height ?? 1080)), 256, 4096);
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  if (!ctx) return null;

  const colorA = params.colorA ?? "#ff0055";
  const colorB = params.colorB ?? "#00ff99";
  const colorC = params.colorC ?? "#0055ff";
  const colorD = params.colorD ?? "#ffcc00";
  const time = Number.isFinite(Number(context?.timeSeconds)) ? Number(context.timeSeconds) : 0;
  const speed = clamp(Number(params.speed ?? 25) / 25, 0, 4);
  const warp = clamp(Number(params.warp ?? 35) / 100, 0, 1);
  const t = time * speed;

  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, colorA);
  base.addColorStop(0.45, colorB);
  base.addColorStop(0.72, colorC);
  base.addColorStop(1, colorD);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "screen";
  paintMeshBlob(ctx, width, height, colorB, 0.22 + Math.sin(t * 0.41) * 0.12, 0.25, 0.58 + warp * 0.2);
  paintMeshBlob(ctx, width, height, colorC, 0.78, 0.3 + Math.cos(t * 0.33) * 0.12, 0.5 + warp * 0.22);
  ctx.globalCompositeOperation = "multiply";
  paintMeshBlob(ctx, width, height, colorD, 0.5 + Math.sin(t * 0.19) * 0.18, 0.78, 0.42 + warp * 0.16);
  ctx.globalCompositeOperation = "source-over";
  return output;
}

function paintMeshBlob(ctx, width, height, color, x, y, radius) {
  const r = Math.max(width, height) * radius;
  const cx = clamp(x, -0.2, 1.2) * width;
  const cy = clamp(y, -0.2, 1.2) * height;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

export function applyBlurNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const radius = Math.max(0, Number(params.radius ?? 0));
  if (radius === 0) return input;
  return blurImage(input, radius);
}

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
      const luma = workR * 0.299 + workG * 0.587 + workB * 0.114;
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
      cr = 0.299;
      cg = 0.587;
      cb = 0.114;
      break;
    case "average":
      cr = cg = cb = 1 / 3;
      break;
    case "bt709":
    default:
      cr = 0.2126;
      cg = 0.7152;
      cb = 0.0722;
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

export function applyHsvNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const hue = Number(params.hue ?? 0);
  const saturation = clamp(Number(params.saturation ?? 100) / 100, 0, 4);
  const value = clamp(Number(params.value ?? 100) / 100, 0, 4);
  if (hue === 0 && saturation === 1 && value === 1) return input;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    const [r, g, b] = hsvToRgb(
      ((h + hue / 360) % 1 + 1) % 1,
      clamp01(s * saturation),
      clamp01(v * value)
    );
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

export function applyRgbCurvesNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const master = buildRgbCurveLut(params, "master");
  const red = buildRgbCurveLut(params, "red");
  const green = buildRgbCurveLut(params, "green");
  const blue = buildRgbCurveLut(params, "blue");

  if (isIdentityLut(master) && isIdentityLut(red) && isIdentityLut(green) && isIdentityLut(blue)) {
    return input;
  }

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = red[master[data[i]]];
    data[i + 1] = green[master[data[i + 1]]];
    data[i + 2] = blue[master[data[i + 2]]];
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Pixelate — collapse NxN blocks of source pixels into a single color so the
// downstream chain (especially dither) operates on a chunky low-resolution
// version of the image without changing canvas dimensions.
//
// GPU shader is the primary path (supports separate X/Y aspect, circle
// pixels, edge softness). Legacy CPU path stays available as a fallback
// when WebGL2 is missing — it runs canvas downscale + nearest upscale
// which is the cheapest box-average we can do with the 2D API.
export function applyPixelateNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const sizeX = clamp(Math.round(Number(params.size ?? 8)), 1, 256);
  const rawY = Number(params.sizeY ?? 0);
  const sizeY = rawY > 0 ? clamp(Math.round(rawY), 1, 256) : sizeX;
  if (sizeX <= 1 && sizeY <= 1) return input;
  const gpuOutput = applyPixelateGpu(input, params);
  if (gpuOutput) return gpuOutput;
  return applyPixelateCpu(input, params, sizeX, sizeY);
}

function applyPixelateCpu(input, params, sizeX, sizeY) {
  const width = input.width;
  const height = input.height;

  const blockW = Math.max(1, Math.floor(width / sizeX));
  const blockH = Math.max(1, Math.floor(height / sizeY));
  const small = createBuffer(blockW, blockH);
  const smallCtx = small.getContext("2d", { alpha: false, willReadFrequently: false });
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(input, 0, 0, blockW, blockH);

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, blockW, blockH, 0, 0, width, height);
  releaseBuffer(small);

  const shape = String(params.shape ?? "square").toLowerCase();
  const smoothing = clamp(Number(params.smoothing ?? 0) / 100, 0, 1);
  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (shape !== "circle" && smoothing <= 0.001 && opacity >= 0.999) {
    return output;
  }

  const srcBuf = createBuffer(width, height);
  const srcCtx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  srcCtx.drawImage(input, 0, 0);
  const src = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      let mask = 1;
      const localX = ((x + 0.5) % sizeX) / sizeX;
      const localY = ((y + 0.5) % sizeY) / sizeY;

      if (shape === "circle") {
        const dist = Math.hypot((localX - 0.5) * 2, (localY - 0.5) * 2);
        const aa = Math.max(smoothing * 0.6 + 0.05, 0.05);
        mask = 1 - smoothstep(1 - aa, 1, dist);
        data[index] *= mask;
        data[index + 1] *= mask;
        data[index + 2] *= mask;
      } else if (smoothing > 0.001) {
        const minEdge = Math.min(localX, 1 - localX, localY, 1 - localY);
        const edgeMask = smoothstep(0, smoothing * 0.5 + 0.001, minEdge);
        data[index] *= 0.6 + edgeMask * 0.4;
        data[index + 1] *= 0.6 + edgeMask * 0.4;
        data[index + 2] *= 0.6 + edgeMask * 0.4;
      }

      data[index] = mixByte(src[index], data[index], opacity);
      data[index + 1] = mixByte(src[index + 1], data[index + 1], opacity);
      data[index + 2] = mixByte(src[index + 2], data[index + 2], opacity);
      data[index + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Scale — resize the image content inside a canvas of the original size, so
// the change is actually visible to downstream nodes (the previous version
// resized the output canvas itself and commitProcessedFrame stretched the
// result back, hiding the effect entirely). Scale > 100% crops outwards;
// Scale < 100% leaves a black border around the centred shrunk image. Pair
// it with Pixelate or downstream Dither to get retro pixel-art workflows.
export function applyScaleNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const xPct = clamp(Number(params.x ?? 100), 10, 400) / 100;
  const yPct = clamp(Number(params.y ?? 100), 10, 400) / 100;
  const filter = params.filter === "nearest" ? false : true;
  if (xPct === 1 && yPct === 1) return input;

  const width = input.width;
  const height = input.height;
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = filter;

  const newW = Math.max(1, Math.round(width * xPct));
  const newH = Math.max(1, Math.round(height * yPct));
  const dx = Math.round((width - newW) / 2);
  const dy = Math.round((height - newH) / 2);
  ctx.drawImage(input, 0, 0, width, height, dx, dy, newW, newH);
  return output;
}

export function applyTransformNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const translateX = Number(params.translateX ?? 0);
  const translateY = Number(params.translateY ?? 0);
  const rotation = Number(params.rotation ?? 0);
  const scaleParam = params.scale !== undefined ? Number(params.scale) : null;
  const scaleX = clamp(Number(scaleParam ?? params.x ?? 100) / 100, 0.01, 10);
  const scaleY = clamp(Number(scaleParam ?? params.y ?? 100) / 100, 0.01, 10);
  const horizontal = Boolean(params.horizontal);
  const vertical = Boolean(params.vertical);
  const left = clamp(Number(params.left ?? 0), 0, 95);
  const right = clamp(Number(params.right ?? 0), 0, 95);
  const top = clamp(Number(params.top ?? 0), 0, 95);
  const bottom = clamp(Number(params.bottom ?? 0), 0, 95);
  const cropMode = String(params.cropMode ?? params.mode ?? "mask");
  const filter = params.filter === "nearest" ? false : true;
  const hasCrop = left !== 0 || right !== 0 || top !== 0 || bottom !== 0;
  const identity =
    translateX === 0 &&
    translateY === 0 &&
    rotation === 0 &&
    scaleX === 1 &&
    scaleY === 1 &&
    !horizontal &&
    !vertical &&
    !hasCrop;
  if (identity) return input;

  const width = input.width;
  const height = input.height;
  let source = input;
  if (hasCrop) {
    source = createBuffer(width, height);
    const cropCtx = source.getContext("2d", { alpha: false, willReadFrequently: false });
    cropCtx.fillStyle = "#000";
    cropCtx.fillRect(0, 0, width, height);
    const sx = Math.round((left / 100) * width);
    const sy = Math.round((top / 100) * height);
    const sw = Math.max(1, Math.round(width - sx - (right / 100) * width));
    const sh = Math.max(1, Math.round(height - sy - (bottom / 100) * height));
    cropCtx.imageSmoothingEnabled = filter;
    if (cropMode === "fit") {
      cropCtx.drawImage(input, sx, sy, sw, sh, 0, 0, width, height);
    } else {
      cropCtx.drawImage(input, sx, sy, sw, sh, sx, sy, sw, sh);
    }
  }

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = filter;
  ctx.save();
  ctx.translate(width / 2 + (translateX / 100) * width, height / 2 + (translateY / 100) * height);
  ctx.rotate((rotation / 180) * Math.PI);
  ctx.scale(horizontal ? -scaleX : scaleX, vertical ? -scaleY : scaleY);
  ctx.drawImage(source, -width / 2, -height / 2, width, height);
  ctx.restore();
  if (source !== input) releaseBuffer(source);
  return output;
}

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
      const oldLuma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
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
    const luma = r * 0.299 + g * 0.587 + b * 0.114;
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
export function applyGradientMapNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const gpuOutput = applyGradientMapGpu(input, params);
  if (gpuOutput) return gpuOutput;
  return applyGradientMapCpu(input, params);
}

function applyGradientMapCpu(input, params = {}) {
  const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
  if (opacity <= 0) return input;

  const repeat = clamp(Number(params?.repeat ?? 1), 1, 20);
  const shift = clamp(Number(params?.shift ?? 0) / 100, -1, 1);
  const mode = String(params?.mode ?? "luma").toLowerCase();
  const lut = buildGradientLut(gradientMapStops(params));
  const lutData = lut.data;
  const lutWidth = lut.width;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const signal = gradientMapSignal(r, g, b, mode);
    const t = gradientMapCoordinate(signal, repeat, shift);
    const mapped = sampleGradientLut(lutData, lutWidth, t);
    data[i] = mixByte(data[i], mapped[0], opacity);
    data[i + 1] = mixByte(data[i + 1], mapped[1], opacity);
    data[i + 2] = mixByte(data[i + 2], mapped[2], opacity);
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

function gradientMapStops(params) {
  if (Array.isArray(params?.stops) && params.stops.length > 0) {
    return params.stops;
  }
  return [
    { pos: 0, color: params?.shadowColor ?? "#111111" },
    { pos: 1, color: params?.highlightColor ?? "#ffffff" },
  ];
}

function gradientMapSignal(r, g, b, mode) {
  if (mode === "r" || mode === "red") return r;
  if (mode === "g" || mode === "green") return g;
  if (mode === "b" || mode === "blue") return b;
  return r * 0.299 + g * 0.587 + b * 0.114;
}

function gradientMapCoordinate(signal, repeat, shift) {
  const raw = signal * repeat + shift;
  if (Math.abs(shift) < 1e-5 && Math.abs(repeat - 1) < 1e-5) {
    return clamp01(raw);
  }
  return raw - Math.floor(raw);
}

function sampleGradientLut(data, width, t) {
  const x = clamp01(t) * (width - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(width - 1, i0 + 1);
  const f = x - i0;
  const a = i0 * 4;
  const b = i1 * 4;
  return [
    data[a] + (data[b] - data[a]) * f,
    data[a + 1] + (data[b + 1] - data[a + 1]) * f,
    data[a + 2] + (data[b + 2] - data[a + 2]) * f,
  ];
}

export function applyToneMapNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const intensity = clamp(Number(params.intensity ?? 100) / 100, 0.1, 10);
  const whitepoint = clamp(Number(params.whitepoint ?? 100) / 100, 0.1, 10);
  if (intensity === 1 && whitepoint === 1) return input;
  const wpSq = whitepoint * whitepoint;
  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = (data[i] / 255) * intensity;
    const g = (data[i + 1] / 255) * intensity;
    const b = (data[i + 2] / 255) * intensity;
    const tr = (r * (1 + r / wpSq)) / (1 + r);
    const tg = (g * (1 + g / wpSq)) / (1 + g);
    const tb = (b * (1 + b / wpSq)) / (1 + b);
    data[i] = Math.round(clamp01(tr) * 255);
    data[i + 1] = Math.round(clamp01(tg) * 255);
    data[i + 2] = Math.round(clamp01(tb) * 255);
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Lens Distortion — radial barrel/pincushion warp with optional chromatic
// aberration. Replaces the old sine-wave Distort node, which wasn't really
// what "distort" meant in any compositor. Math follows Blender's
// node_composite_lens_distortion: a per-pixel scale factor based on the
// squared distance from center, with a separate scale per RGB channel for
// the dispersion split. Single-tap bilinear samples per channel — no
// multi-step integration since we're targeting moderate user values.
export function applyLensDistortNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const type = String(params.type ?? "radial");
  const distortion = clamp(Number(params.distortion ?? 0) / 100, -0.999, 1);
  const dispersion = clamp(Number(params.dispersion ?? 0) / 100, 0, 1);
  const fit = !!params.fit;
  // Center as 0..100 percent of width/height — 50 = image centre.
  const centerXPct = clamp(Number(params.centerX ?? 50) / 100, 0, 1);
  const centerYPct = clamp(Number(params.centerY ?? 50) / 100, 0, 1);
  const vignette = clamp(Number(params.vignette ?? 0) / 100, 0, 1);
  if (
    type === "radial" &&
    distortion === 0 &&
    dispersion === 0 &&
    vignette === 0 &&
    centerXPct === 0.5 &&
    centerYPct === 0.5
  ) {
    return input;
  }

  const width = input.width;
  const height = input.height;

  // Pull source pixels once.
  const srcBuf = createBuffer(width, height);
  const sctx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  sctx.drawImage(input, 0, 0);
  const srcData = sctx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const outData = ctx.createImageData(width, height);
  const out = outData.data;

  // Horizontal type: just shift R left and B right by `dispersion * width`,
  // ignoring the radial distortion field. Useful for VHS/CRT bands.
  if (type === "horizontal") {
    const shift = dispersion * width * 0.05;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        out[i] = sampleBilinearChannel(srcData, width, height, x + shift, y, 0);
        out[i + 1] = srcData[i + 1];
        out[i + 2] = sampleBilinearChannel(srcData, width, height, x - shift, y, 2);
        out[i + 3] = 255;
      }
    }
    if (vignette > 0) applyVignetteInPlace(out, width, height, centerXPct, centerYPct, vignette);
    ctx.putImageData(outData, 0, 0);
    return output;
  }

  // Per-channel distortion scaled to [-1, 1] but clamped above -0.999 (where
  // the sqrt would explode). Dispersion splits R lower / B higher around G.
  const dispScale = 4;
  const dR = clamp(distortion * dispScale - dispersion * dispScale, -0.999 * dispScale, dispScale);
  const dG = clamp(distortion * dispScale, -0.999 * dispScale, dispScale);
  const dB = clamp(distortion * dispScale + dispersion * dispScale, -0.999 * dispScale, dispScale);

  // "Fit" zooms output uv so the worst-case corner still lands inside the
  // input — derived by solving scale_fit * dist_scale_at_corner = 0.5.
  let fitScale = 1;
  if (fit) {
    const dMax = Math.max(dR, dG, dB);
    const denom = 4 + dMax;
    if (denom > 0) fitScale = 4 / denom;
  }

  // Center stays at user-controlled position; UV math normalises against the
  // shorter half-axis from the centre so the distortion stays roughly circular
  // even when the centre is off-axis.
  const cx = centerXPct * width;
  const cy = centerYPct * height;
  const halfX = Math.max(cx, width - cx);
  const halfY = Math.max(cy, height - cy);

  for (let y = 0; y < height; y++) {
    const v = ((y + 0.5 - cy) / halfY) * fitScale;
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5 - cx) / halfX) * fitScale;
      const r2 = u * u + v * v;
      const i = (y * width + x) * 4;

      // If the largest channel distortion would push the source point
      // outside the image even before sampling, write black + transparent.
      if (Math.max(dR, dG, dB) * r2 > 1) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 255;
        continue;
      }

      const sR = 1 / (1 + Math.sqrt(Math.max(0, 1 - dR * r2)));
      const sG = 1 / (1 + Math.sqrt(Math.max(0, 1 - dG * r2)));
      const sB = 1 / (1 + Math.sqrt(Math.max(0, 1 - dB * r2)));

      const xr = (u * sR) * halfX + cx;
      const yr = (v * sR) * halfY + cy;
      const xg = (u * sG) * halfX + cx;
      const yg = (v * sG) * halfY + cy;
      const xb = (u * sB) * halfX + cx;
      const yb = (v * sB) * halfY + cy;

      out[i] = sampleBilinearChannel(srcData, width, height, xr, yr, 0);
      out[i + 1] = sampleBilinearChannel(srcData, width, height, xg, yg, 1);
      out[i + 2] = sampleBilinearChannel(srcData, width, height, xb, yb, 2);
      out[i + 3] = 255;
    }
  }

  if (vignette > 0) applyVignetteInPlace(out, width, height, centerXPct, centerYPct, vignette);
  ctx.putImageData(outData, 0, 0);
  return output;
}

export function applyHalftoneNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Halftone is GPU-only for now; if WebGL2 is unavailable we'd rather
  // pass-through the source than burn CPU time on a slow software fallback
  // (the dot grid math is significantly more expensive per-pixel than the
  // chromatic aberration shader).
  const gpuOutput = applyHalftoneGpu(input, params);
  return gpuOutput ?? input;
}

export function applyVhsNode(input, params, context) {
  if (!input?.width || !input?.height) return null;
  // VHS is GPU-only — the shader does multi-tap chroma blur, scrolling
  // tracking bands, and per-frame noise; a CPU port would be unusable in
  // realtime. Fall through to the input frame when WebGL2 is missing so
  // the rest of the chain still renders.
  const gpuOutput = applyVhsGpu(input, params, context);
  return gpuOutput ?? input;
}

export function applyCrtNode(input, params, context) {
  if (!input?.width || !input?.height) return null;
  // CRT is GPU-only for the same reason as VHS: barrel distortion plus a
  // 5-tap glow blur per pixel and a per-pixel mask lookup blow up CPU cost
  // very quickly. Pass-through to the input frame when WebGL2 is missing.
  const gpuOutput = applyCrtGpu(input, params, context);
  return gpuOutput ?? input;
}

export function applyAnalogNode(input, params, context) {
  if (!input?.width || !input?.height) return null;
  const mode = String(params?.mode ?? "vhs");
  if (mode === "crt") {
    return applyCrtNode(input, params, context);
  }
  if (mode === "vhs-crt") {
    const vhs = applyVhsNode(input, params, context);
    const crt = applyCrtNode(vhs, params, context);
    if (vhs && vhs !== input && vhs !== crt) releaseBuffer(vhs);
    return crt;
  }
  return applyVhsNode(input, params, context);
}

export function applyBloomNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Bloom is GPU-only — the single-pass shader does 24 disk-distributed
  // texture taps per output pixel (golden-spiral sampling), which is wildly
  // out of reach for a CPU implementation at preview resolutions. Fall
  // through to the input frame when WebGL2 is missing.
  const gpuOutput = applyBloomGpu(input, params);
  return gpuOutput ?? input;
}

export function applyHalationNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Halation shares Bloom's per-pixel cost profile — same 24-tap golden
  // spiral, so it's GPU-only too. Pass-through fallback when WebGL2 is
  // missing keeps the graph rendering rather than producing a black frame.
  const gpuOutput = applyHalationGpu(input, params);
  return gpuOutput ?? input;
}

export function applyAsciiNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // ASCII relies on a glyph atlas texture sampled per output pixel — the
  // CPU equivalent would mean per-cell font rasterization on every frame,
  // which is impractical. GPU-only with input pass-through when WebGL2 is
  // missing.
  const gpuOutput = applyAsciiGpu(input, params);
  return gpuOutput ?? input;
}

export function applyPatternDitherNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Pattern Dither is GPU-only and intentionally lives alongside the CPU
  // Dither node — it covers the embarrassingly-parallel ordered/threshold
  // patterns at full preview speed for video, while the CPU node owns the
  // serial error-diffusion catalog plus discrete palette matching.
  const gpuOutput = applyPatternDitherGpu(input, params);
  return gpuOutput ?? input;
}

export function applyThresholdNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Threshold is a brand-new standalone node (the existing Dither node
  // exposes a "Simple Threshold" algorithm but only as part of its larger
  // palette/error-diffusion config). GPU-only with input pass-through —
  // a single-channel mask comparison is cheap enough that the CPU fallback
  // can keep WebGL2-disabled browsers visually consistent.
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

      out[index] = sampleBilinearChannel(src, width, height, x + dx, y + dy, 0);
      out[index + 1] = src[index + 1];
      out[index + 2] = sampleBilinearChannel(src, width, height, x - dx, y - dy, 2);
      out[index + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

export function applyDisplaceNode(input, mapInput, params) {
  if (!input?.width || !input?.height) return null;
  const xAmount = Number(params.xAmount ?? 0);
  const yAmount = Number(params.yAmount ?? 0);
  const strength = clamp(Number(params.strength ?? 100) / 100, 0, 4);
  const mode = String(params.mode ?? "wave");
  const filter = params.filter === "nearest" ? "nearest" : "linear";
  if ((xAmount === 0 && yAmount === 0) || strength === 0) return input;

  const width = input.width;
  const height = input.height;
  const srcBuf = createBuffer(width, height);
  const srcCtx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  srcCtx.drawImage(input, 0, 0);
  const src = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  let map = null;
  if (mode === "map" && mapInput?.width && mapInput?.height) {
    const mapBuf = createBuffer(width, height);
    const mapCtx = mapBuf.getContext("2d", { alpha: false, willReadFrequently: true });
    mapCtx.drawImage(mapInput, 0, 0, width, height);
    map = mapCtx.getImageData(0, 0, width, height).data;
    releaseBuffer(mapBuf);
  }

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  const frequency = Math.max(0.001, Number(params.frequency ?? 4));
  const phase = (Number(params.phase ?? 0) / 180) * Math.PI;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let dx;
      let dy;
      if (map) {
        dx = ((map[i] - 128) / 128) * xAmount * strength;
        dy = ((map[i + 1] - 128) / 128) * yAmount * strength;
      } else {
        dx = Math.sin((y / height) * frequency * Math.PI * 2 + phase) * xAmount * strength;
        dy = Math.sin((x / width) * frequency * Math.PI * 2 + phase) * yAmount * strength;
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

// Combines two masks (read as luma) via boolean ops. Output is a grayscale
// mask — opacity blends back toward maskA so partial intensity feels natural
// when the user wires this into an Apply downstream.
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

// Multiplies the input image by a mask (read as luma) so dark mask regions
// black out the image. Optional feather softens the mask edges via a cheap
// box blur. Opacity blends back to the original image.
export function applyMaskApplyNode(input, mask, params) {
  if (!input?.width || !input?.height) return null;
  if (!mask?.width || !mask?.height) return input;

  const width = input.width;
  const height = input.height;
  const invert = String(params?.invert ?? "off").toLowerCase() === "on";
  const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
  const feather = Math.max(0, Math.round(Number(params?.feather ?? 0)));

  const srcBuf = createBuffer(width, height);
  const srcCtx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  srcCtx.drawImage(input, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  const maskBuf = createBuffer(width, height);
  const maskCtx = maskBuf.getContext("2d", { alpha: false, willReadFrequently: true });
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
    let m = luminance8(maskData[i], maskData[i + 1], maskData[i + 2]) / 255;
    if (invert) m = 1 - m;
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

// Smoothly darken pixels as their normalised distance from the lens centre
// approaches 1. `amount` controls the falloff strength — 0 leaves the image
// untouched, 1 fully blacks out the corners.
function applyVignetteInPlace(data, width, height, centerXPct, centerYPct, amount) {
  if (amount <= 0) return;
  const cx = centerXPct * width;
  const cy = centerYPct * height;
  const halfX = Math.max(cx, width - cx);
  const halfY = Math.max(cy, height - cy);
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5 - cy) / halfY;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - cx) / halfX;
      const r = Math.min(1, Math.sqrt(nx * nx + ny * ny));
      // Smoothstep on r for a soft falloff that doesn't crush the centre.
      const fall = r * r * (3 - 2 * r);
      const factor = 1 - amount * fall;
      const i = (y * width + x) * 4;
      data[i] = Math.round(data[i] * factor);
      data[i + 1] = Math.round(data[i + 1] * factor);
      data[i + 2] = Math.round(data[i + 2] * factor);
    }
  }
}

function rgbToHsv(r8, g8, b8) {
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;

  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
    if (h < 0) h += 1;
  }

  return [h, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const sector = h * 6;
  const x = c * (1 - Math.abs((sector % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;

  if (sector < 1) {
    r = c;
    g = x;
  } else if (sector < 2) {
    r = x;
    g = c;
  } else if (sector < 3) {
    g = c;
    b = x;
  } else if (sector < 4) {
    g = x;
    b = c;
  } else if (sector < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function buildRgbCurveLut(params, prefix) {
  const points = params?.[`points_${prefix}`];
  if (Array.isArray(points) && points.length >= 2) {
    return buildCurvePointLut(points);
  }
  return buildLegacyCurveLut(
    params?.[`${prefix}Low`],
    params?.[`${prefix}Mid`],
    params?.[`${prefix}High`]
  );
}

function buildLegacyCurveLut(lowValue, midValue, highValue) {
  const low = clamp(Number(lowValue ?? 0), 0, 255);
  const mid = clamp(Number(midValue ?? 128), 0, 255);
  const high = clamp(Number(highValue ?? 255), 0, 255);
  const lut = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    const value = i <= 128
      ? low + (mid - low) * (i / 128)
      : mid + (high - mid) * ((i - 128) / 127);
    lut[i] = Math.round(clamp(value, 0, 255));
  }

  return lut;
}

function buildCurvePointLut(rawPoints) {
  const lut = new Uint8ClampedArray(256);
  const points = sanitizeCurvePoints(rawPoints);
  if (points.length < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  const n = points.length;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const dx = new Array(n - 1);
  const dy = new Array(n - 1);
  const slope = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    dy[i] = ys[i + 1] - ys[i];
    slope[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
  }

  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }

  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const scale = 3 / Math.sqrt(h);
      tangent[i] = scale * a * slope[i];
      tangent[i + 1] = scale * b * slope[i];
    }
  }

  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) {
      lut[x] = clamp(Math.round(ys[0]), 0, 255);
      continue;
    }
    if (x >= xs[n - 1]) {
      lut[x] = clamp(Math.round(ys[n - 1]), 0, 255);
      continue;
    }
    let segment = 0;
    while (segment < n - 1 && x > xs[segment + 1]) segment++;
    const h = dx[segment];
    const t = (x - xs[segment]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * ys[segment] +
      (t3 - 2 * t2 + t) * h * tangent[segment] +
      (-2 * t3 + 3 * t2) * ys[segment + 1] +
      (t3 - t2) * h * tangent[segment + 1];
    lut[x] = clamp(Math.round(y), 0, 255);
  }
  return lut;
}

function sanitizeCurvePoints(rawPoints) {
  const cleaned = [];
  for (const point of Array.isArray(rawPoints) ? rawPoints : []) {
    const x = Math.round(Number(point?.x));
    const y = Math.round(Number(point?.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    cleaned.push({ x: clamp(x, 0, 255), y: clamp(y, 0, 255) });
  }
  cleaned.sort((a, b) => a.x - b.x);

  const unique = [];
  for (const point of cleaned) {
    const last = unique[unique.length - 1];
    if (last && last.x === point.x) {
      last.y = Math.round((last.y + point.y) / 2);
    } else {
      unique.push({ ...point });
    }
  }
  return unique;
}

function isIdentityLut(lut) {
  for (let i = 0; i < 256; i++) {
    if (lut[i] !== i) return false;
  }
  return true;
}

function sampleNearestInto(data, width, height, x, y, target, offset) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= width || iy < 0 || iy >= height) {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 255;
    return;
  }
  const src = (iy * width + ix) * 4;
  target[offset] = data[src];
  target[offset + 1] = data[src + 1];
  target[offset + 2] = data[src + 2];
  target[offset + 3] = 255;
}

function sampleBilinearChannel(data, width, height, x, y, channel) {
  if (x < 0 || x >= width || y < 0 || y >= height) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * width + x0) * 4 + channel;
  const i10 = (y0 * width + x1) * 4 + channel;
  const i01 = (y1 * width + x0) * 4 + channel;
  const i11 = (y1 * width + x1) * 4 + channel;
  const top = data[i00] * (1 - fx) + data[i10] * fx;
  const bot = data[i01] * (1 - fx) + data[i11] * fx;
  return Math.round(top * (1 - fy) + bot * fy);
}

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
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "difference":
      return "difference";
    case "normal":
    default:
      return "source-over";
  }
}

export function applyDitherNode(input, params) {
  if (!input?.width || !input?.height) return null;

  const scale = clamp((params.scale ?? 100) / 100, 0.1, 1);
  const workWidth = Math.max(1, Math.round(input.width * scale));
  const workHeight = Math.max(1, Math.round(input.height * scale));
  const work = createBuffer(workWidth, workHeight);
  const workContext = work.getContext("2d", { alpha: false, willReadFrequently: true });
  workContext.imageSmoothingEnabled = true;
  workContext.drawImage(input, 0, 0, workWidth, workHeight);
  const blurredWork =
    (params.blurRadius ?? 0) > 0 ? blurImage(work, Number(params.blurRadius ?? 0)) : work;

  const blurredContext = blurredWork.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = blurredContext.getImageData(0, 0, workWidth, workHeight);
  const palette = getPalette(params.palette ?? "monochrome");
  runAlgorithm(params.algorithm ?? "floyd-steinberg", imageData, params, palette);
  blurredContext.putImageData(imageData, 0, 0);

  if (workWidth === input.width && workHeight === input.height) {
    if (blurredWork !== work) releaseBuffer(work);
    return blurredWork;
  }

  const output = createBuffer(input.width, input.height);
  const outputContext = output.getContext("2d", { alpha: false, willReadFrequently: true });
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(
    blurredWork,
    0,
    0,
    workWidth,
    workHeight,
    0,
    0,
    output.width,
    output.height
  );
  if (blurredWork !== work) releaseBuffer(work);
  releaseBuffer(blurredWork);
  return output;
}

function blurImage(input, radius, passes = 2) {
  const normalizedRadius = Math.max(0, Math.round(Number(radius) || 0));
  if (!input?.width || !input?.height || normalizedRadius <= 0) return input;

  if (supportsBlurFilter()) {
    const output = createBuffer(input.width, input.height);
    const ctx = output.getContext("2d", { willReadFrequently: true });
    ctx.filter = `blur(${normalizedRadius}px)`;
    ctx.drawImage(input, 0, 0);
    ctx.filter = "none";
    return output;
  }

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(input, 0, 0);

  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  imageData.data.set(boxBlur(imageData.data, output.width, output.height, normalizedRadius, passes));
  ctx.putImageData(imageData, 0, 0);
  return output;
}

function supportsBlurFilter() {
  if (supportsCanvasBlurFilter != null) return supportsCanvasBlurFilter;

  const source = createBuffer(16, 16);
  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  sourceCtx.fillStyle = "#000";
  sourceCtx.fillRect(0, 0, 16, 16);
  sourceCtx.fillStyle = "#fff";
  sourceCtx.fillRect(7, 7, 2, 2);

  const output = createBuffer(16, 16);
  const outputCtx = output.getContext("2d", { willReadFrequently: true });
  outputCtx.filter = "blur(3px)";
  outputCtx.drawImage(source, 0, 0);
  outputCtx.filter = "none";

  const center = outputCtx.getImageData(8, 8, 1, 1).data[0];
  const outer = outputCtx.getImageData(3, 8, 1, 1).data[0];
  supportsCanvasBlurFilter = center > outer && outer > 0;
  releaseBuffer(source);
  releaseBuffer(output);
  return supportsCanvasBlurFilter;
}

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

const bufferPool = new Map();
const POOL_LIMIT_PER_SHAPE = 8;

function createBuffer(width, height) {
  return acquireBuffer(width, height);
}

export function acquireBuffer(width, height) {
  const key = `${width}x${height}`;
  const stack = bufferPool.get(key);
  if (stack && stack.length > 0) {
    const reused = stack.pop();
    const ctx = reused.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, width, height);
    }
    return reused;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function releaseBuffer(canvas) {
  if (!canvas?.width || !canvas?.height) return;
  const key = `${canvas.width}x${canvas.height}`;
  let stack = bufferPool.get(key);
  if (!stack) {
    stack = [];
    bufferPool.set(key, stack);
  }
  if (stack.length < POOL_LIMIT_PER_SHAPE) stack.push(canvas);
}

function luminance8(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function luminance01(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mixByte(a, b, amount) {
  return Math.round(a * (1 - amount) + b * amount);
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function toLinear(value) {
  return Math.pow(clamp01(value), 2.2);
}

function toSrgb(value) {
  return Math.pow(clamp01(value), 1 / 2.2);
}

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
      return r * 0.299 + g * 0.587 + b * 0.114;
  }
}
