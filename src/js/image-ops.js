import { runAlgorithm } from "./dither/index.js";
import { getPalette } from "./palettes.js";
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

// Re-export the pool so external consumers (graph-runtime.js, source.js)
// keep importing from "./image-ops.js" unchanged. Internal effect
// functions below use the imported names directly. The mask/mix catalogs
// and the dep-free geometry nodes (invert/crop/flip) flow through here
// too so graph-shell.js + graph-runtime.js's existing import paths hold.
export { acquireBuffer, releaseBuffer };
export { MASK_MODES, MASK_SOURCES, MIX_MODES };
export { applyCropNode, applyFlipNode, applyInvertNode };
import {
  areRgbCurvesIdentity,
  buildCurveLut,
  buildFinalRgbCurvesLuts,
  buildRgbCurvesLuts,
  normalizeCurveApplyMode,
} from "./curve-lut.js";
import { buildGradientLut } from "./gl/gradient-lut.js";
import {
  applyAsciiGpu,
  applyBloomGpu,
  applyBlurGpu,
  applyChromaticAberrationGpu,
  applyCrtGpu,
  applyDepthOfFieldGpu,
  applyHalationGpu,
  applyHalftoneGpu,
  applyGradientSourceGpu,
  applyGradientMapGpu,
  applyLedScreenGpu,
  applyMeshGradientGpu,
  applyModulationGpu,
  applyNoiseSourceGpu,
  applyPatternDitherGpu,
  applyPixelateGpu,
  applyPixelSortingGpu,
  applyPosterizeGpu,
  applyStarGlowGpu,
  applyThresholdGpu,
  applyVhsGpu,
  GAUSSIAN_BLUR_MAX_RADIUS,
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

export function applyGradientNode(params = {}, context = {}) {
  const gpuOutput = applyGradientSourceGpu(params, context);
  if (gpuOutput) return gpuOutput;
  return applyGradientCpu(params);
}

// F18.2 procedural noise source. GPU-only for now; if WebGL2 setup fails we
// return a solid grey canvas at the requested size so the rest of the graph
// still has an image to operate on. A CPU FBM fallback could be added later
// for headless environments without WebGL2.
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

function applyMeshGradientCpu(params = {}, context = {}) {
  const width = clamp(Math.round(Number(params.width ?? 1920)), 256, 4096);
  const height = clamp(Math.round(Number(params.height ?? 1080)), 256, 4096);
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  if (!ctx) return null;

  const stops = Array.isArray(params.stops) ? params.stops : [];
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  if (stops.length === 0) return output;

  const time = Number.isFinite(Number(context?.timeSeconds)) ? Number(context.timeSeconds) : 0;
  const speed = clamp(Number(params.speed ?? 25) / 25, 0, 4);
  const warp = clamp(Number(params.warp ?? 35) / 100, 0, 1);
  const t = time * speed;

  // Screen-blend a soft radial blob per stop. Cheaper than per-pixel weighted
  // accumulation (which the GPU path does) but visually close enough for the
  // CPU fallback — and orders of magnitude faster than a JS pixel loop.
  ctx.globalCompositeOperation = "screen";
  const baseR = Math.max(width, height);
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const phase = i * 1.27;
    const wobbleX = Math.sin(t * 0.41 + phase) * warp * 0.06;
    const wobbleY = Math.cos(t * 0.33 + phase) * warp * 0.06;
    const cx = clamp(Number(s.x ?? 0.5) + wobbleX, -0.2, 1.2) * width;
    const cy = clamp(Number(s.y ?? 0.5) + wobbleY, -0.2, 1.2) * height;
    const r = Math.max(0.02, Math.min(2, Number(s.radius ?? 0.6))) * baseR;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    gradient.addColorStop(0, s.color ?? "#ffffff");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalCompositeOperation = "source-over";
  return output;
}

function applyGradientCpu(params = {}) {
  const width = gradientSourceDimension(params.width, 1920);
  const height = gradientSourceDimension(params.height, 1080);
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) return null;

  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  const lut = buildGradientLut(gradientMapStops(params));
  const center = gradientSourceCenter(params);
  const mode = gradientSourceMode(params.mode);
  const angle = (Number(params.angle ?? 0) / 180) * Math.PI;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const radius = clamp(Number(params.radius ?? 75) / 100, 0.01, 2);
  const repeat = clamp(Number(params.repeat ?? 1), 1, 20);
  const shift = clamp(Number(params.shift ?? 0) / 100, -1, 1);
  const minSide = Math.max(1, Math.min(width, height));
  const aspectX = width / minSide;
  const aspectY = height / minSide;

  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) / width;
      const raw = gradientSourceCoordinate(
        mode,
        px,
        py,
        center,
        dirX,
        dirY,
        angle,
        radius,
        aspectX,
        aspectY
      );
      const t = gradientMapCoordinate(raw, repeat, shift);
      const offset = (y * width + x) * 4;
      sampleGradientLutInto(lut.data, lut.width, t, data, offset);
      data[offset + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

function gradientSourceDimension(value, fallback) {
  return clamp(Math.round(Number(value ?? fallback)), 256, 4096);
}

function gradientSourceCenter(params = {}) {
  return {
    x: clamp(Number(params.centerX ?? 50) / 100, 0, 1),
    y: clamp(Number(params.centerY ?? 50) / 100, 0, 1),
  };
}

function gradientSourceMode(value) {
  const mode = String(value ?? "linear").toLowerCase();
  if (mode === "radial" || mode === "conic") return mode;
  return "linear";
}

function gradientSourceCoordinate(mode, px, py, center, dirX, dirY, angle, radius, aspectX, aspectY) {
  const dx = px - center.x;
  const dy = py - center.y;
  if (mode === "radial") {
    return Math.hypot(dx * aspectX, dy * aspectY) / radius;
  }
  if (mode === "conic") {
    return wrap01((Math.atan2(dy, dx) - angle) / (Math.PI * 2));
  }
  return 0.5 + dx * dirX + dy * dirY;
}

function wrap01(value) {
  return value - Math.floor(value);
}

export function applyBlurNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const radius = Math.max(0, Number(params.radius ?? 0));
  if (radius === 0) return input;
  // GPU separable Gaussian: ~10x faster than ctx.filter for moderate radii.
  // Falls through to blurImage for wider radii or when WebGL2 is unavailable.
  if (radius <= GAUSSIAN_BLUR_MAX_RADIUS) {
    const gpuOutput = applyBlurGpu(input, { radius });
    if (gpuOutput) return gpuOutput;
  }
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
  const hsv = [0, 0, 0];

  for (let i = 0; i < data.length; i += 4) {
    rgbToHsvInto(data[i], data[i + 1], data[i + 2], hsv);
    hsvToRgbInto(
      ((hsv[0] + hue / 360) % 1 + 1) % 1,
      clamp01(hsv[1] * saturation),
      clamp01(hsv[2] * value),
      data,
      i
    );
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

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
  const mapped = [0, 0, 0];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const signal = gradientMapSignal(r, g, b, mode);
    const t = gradientMapCoordinate(signal, repeat, shift);
    sampleGradientLutInto(lutData, lutWidth, t, mapped, 0);
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
  return luminanceBt601(r, g, b);
}

function gradientMapCoordinate(signal, repeat, shift) {
  const raw = signal * repeat + shift;
  if (Math.abs(shift) < 1e-5 && Math.abs(repeat - 1) < 1e-5) {
    return clamp01(raw);
  }
  return raw - Math.floor(raw);
}

function sampleGradientLutInto(data, width, t, target, offset = 0) {
  const x = clamp01(t) * (width - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(width - 1, i0 + 1);
  const f = x - i0;
  const a = i0 * 4;
  const b = i1 * 4;
  target[offset] = data[a] + (data[b] - data[a]) * f;
  target[offset + 1] = data[a + 1] + (data[b + 1] - data[a + 1]) * f;
  target[offset + 2] = data[a + 2] + (data[b + 2] - data[a + 2]) * f;
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

export function applyLedScreenNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // LED Screen is GPU-only: the per-pixel diode, subpixel and glow mask math
  // is exactly what the fullscreen shader path is for. Pass-through keeps the
  // graph usable on WebGL2-disabled browsers.
  const gpuOutput = applyLedScreenGpu(input, params);
  return gpuOutput ?? input;
}

export function applyModulationNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Modulation is GPU-only: phase-modulated line masks are cheap in a shader
  // but not worth a per-pixel CPU fallback during video playback.
  const gpuOutput = applyModulationGpu(input, params);
  return gpuOutput ?? input;
}

export function applyPixelSortingNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // P1 Pixel Sorting is a GPU-only glitch-sort approximation. True segment
  // sorting would need a CPU/worker or multi-pass path and stays out of the
  // live playback route for now.
  const gpuOutput = applyPixelSortingGpu(input, params);
  return gpuOutput ?? input;
}

export function applyDepthOfFieldNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Depth of Field P1 is GPU-only: even 32 round aperture taps per pixel are
  // too expensive for the live CPU path. Pass-through fallback keeps older
  // browsers rendering the graph rather than producing a blank frame.
  const gpuOutput = applyDepthOfFieldGpu(input, params);
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
// Public catalog of mask channel sources. UI dropdown reads from this so the
// runtime sampler below and the inspector stay in lockstep.
// Sample one channel from a mask pixel into 0..1. Falls through to luma so
// legacy projects without an explicit `source` keep their current look.
// (MASK_SOURCES + MASK_MODES catalogs live in image-ops/constants.js and
// are re-exported above.)
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

function rgbToHsvInto(r8, g8, b8, target) {
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

  target[0] = h;
  target[1] = max === 0 ? 0 : delta / max;
  target[2] = max;
}

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

function hsvToRgbInto(h, s, v, target, offset) {
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

  target[offset] = Math.round((r + m) * 255);
  target[offset + 1] = Math.round((g + m) * 255);
  target[offset + 2] = Math.round((b + m) * 255);
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

// Public catalog of blend modes for the mix node. UI dropdowns read this so
// the labels stay in sync with the runtime mapper below. Order matches the
// shader-lab pass-node grouping (Photoshop-style: normal → darken → lighten →
// contrast → comparative → component) so the dropdown reads naturally.
//
// `add` is kept as the only non-PS alias because legacy projects already store
// it; the mapper folds it into the Canvas `lighter` op. Everything else maps
// directly onto Canvas 2D globalCompositeOperation, which is GPU-composited by
// the browser — no separate WebGL pair needed.
// MIX_MODES catalog lives in image-ops/constants.js and is re-exported at
// the top of this file so graph-shell.js's existing import path holds.

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
    // Allocate fresh instead of going through acquireBuffer: pooled buffers
    // were created with `willReadFrequently: true` for the getImageData-
    // heavy nodes, which forces a CPU backing — ctx.filter blur then runs
    // on CPU and is the actual perf cliff the user hit. A new canvas with
    // a default-options context stays GPU-friendly, so the filter rides
    // hardware compositing.
    const output = createProcessingCanvas(input.width, input.height);
    const ctx = output.getContext("2d");
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

// clamp, clamp01, mixByte, smoothstep, luminance8, luminance01 moved to
// image-ops/pixel-math.js. Imported at the top of this file so existing
// callsites inside image-ops resolve unchanged.

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
      return luminanceBt601(r, g, b);
  }
}
