import { runAlgorithm } from "./dither/index.js";
import { getPalette } from "./palettes.js";

let supportsCanvasBlurFilter = null;

export function applyAdjustNode(input, params) {
  if (!input?.width || !input?.height) return null;

  const output = createBuffer(input.width, input.height);
  const context = output.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(input, 0, 0);

  const imageData = context.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;

  const brightness = clamp((params.brightness ?? 0) / 100, -1, 1);
  const contrast = clamp((params.contrast ?? 100) / 100, 0, 2);
  const saturation = clamp((params.saturation ?? 100) / 100, 0, 2);
  const gamma = Math.max(0.1, (params.gamma ?? 100) / 100);
  const exposure = clamp((params.exposure ?? 0) / 100, -4, 4);
  const exposureMultiplier = 2 ** exposure;

  for (let index = 0; index < data.length; index += 4) {
    let r = data[index] / 255;
    let g = data[index + 1] / 255;
    let b = data[index + 2] / 255;

    r = clamp01(r + brightness);
    g = clamp01(g + brightness);
    b = clamp01(b + brightness);

    r = clamp01((r - 0.5) * contrast + 0.5);
    g = clamp01((g - 0.5) * contrast + 0.5);
    b = clamp01((b - 0.5) * contrast + 0.5);

    const luma = luminance01(r, g, b);
    r = clamp01(luma + (r - luma) * saturation);
    g = clamp01(luma + (g - luma) * saturation);
    b = clamp01(luma + (b - luma) * saturation);

    r = clamp01(Math.pow(r, 1 / gamma) * exposureMultiplier);
    g = clamp01(Math.pow(g, 1 / gamma) * exposureMultiplier);
    b = clamp01(Math.pow(b, 1 / gamma) * exposureMultiplier);

    data[index] = Math.round(r * 255);
    data[index + 1] = Math.round(g * 255);
    data[index + 2] = Math.round(b * 255);
  }

  context.putImageData(imageData, 0, 0);
  return output;
}

export function applyBlurNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const radius = Math.max(0, Number(params.radius ?? 0));
  if (radius === 0) return input;
  return blurImage(input, radius);
}

// Glare — extract bright pixels, transform into bloom / streaks / fog glow,
// screen-blend the result over the source. Replaces the simpler Glow node;
// the Streaks type is the iconic anamorphic flare look that pure threshold-
// blur Glow couldn't produce. Algorithm follows Blender's compositor Glare
// at a high level — Streaks uses iterative power-of-2 displacement blur per
// direction, Bloom and Fog Glow are progressively wider Gaussian blurs.
export function applyGlareNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const type = String(params.type ?? "streaks");
  const threshold = clamp(Math.round(Number(params.threshold ?? 180)), 0, 255);
  const mix = clamp(Number(params.mix ?? 100) / 100, 0, 4);
  const saturation = clamp(Number(params.saturation ?? 100) / 100, 0, 4);
  const size = Math.max(1, Number(params.size ?? 16));

  const width = input.width;
  const height = input.height;

  const bright = extractBrightPass(input, threshold, saturation);

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
      glare = blurImage(bright, Math.min(80, size * 4), 3);
      break;
    }
    case "bloom":
    default: {
      glare = blurImage(bright, size);
      break;
    }
  }

  const output = createBuffer(width, height);
  const outCtx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  outCtx.drawImage(input, 0, 0);
  outCtx.globalAlpha = mix;
  outCtx.globalCompositeOperation = "screen";
  outCtx.drawImage(glare, 0, 0);
  outCtx.globalCompositeOperation = "source-over";
  outCtx.globalAlpha = 1;

  releaseBuffer(bright);
  if (glare !== bright) releaseBuffer(glare);
  return output;
}

// Pull pixels above the luma threshold into a transparent canvas, weighting
// alpha by how far above the threshold each pixel sits. Saturation can boost
// (or kill) the chroma so coloured highlights flare with their own hue.
function extractBrightPass(input, threshold, saturation) {
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
    if (saturation === 1) {
      brightData[i] = r;
      brightData[i + 1] = g;
      brightData[i + 2] = b;
    } else {
      const cr = clamp(luma + (r - luma) * saturation, 0, 255);
      const cg = clamp(luma + (g - luma) * saturation, 0, 255);
      const cb = clamp(luma + (b - luma) * saturation, 0, 255);
      brightData[i] = Math.round(cr);
      brightData[i + 1] = Math.round(cg);
      brightData[i + 2] = Math.round(cb);
    }
    brightData[i + 3] = alpha;
  }
  brightCtx.putImageData(brightImage, 0, 0);
  releaseBuffer(base);
  return bright;
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
      const offset = Math.pow(2, i);
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
// Even-distributed across [0, 255] so highlights still reach white.
export function applyPosterizeNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const steps = clamp(Math.round(Number(params.steps ?? 8)), 2, 64);
  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  const denom = steps - 1;
  const lutScale = denom / 255;
  const lutBack = 255 / denom;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(Math.round(data[i] * lutScale) * lutBack);
    data[i + 1] = Math.round(Math.round(data[i + 1] * lutScale) * lutBack);
    data[i + 2] = Math.round(Math.round(data[i + 2] * lutScale) * lutBack);
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

// Pixelate — collapse NxN blocks of source pixels into a single color so the
// downstream chain (especially dither) operates on a chunky low-resolution
// version of the image without changing canvas dimensions.
export function applyPixelateNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const size = clamp(Math.round(Number(params.size ?? 8)), 1, 256);
  if (size <= 1) return input;
  const width = input.width;
  const height = input.height;

  // Two-step downscale + nearest-neighbor upscale via the canvas API is much
  // faster than walking the pixel grid and averaging in JS, and gives the
  // same visual result for an integer block size.
  const blockW = Math.max(1, Math.floor(width / size));
  const blockH = Math.max(1, Math.floor(height / size));
  const small = createBuffer(blockW, blockH);
  const smallCtx = small.getContext("2d", { alpha: false, willReadFrequently: false });
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(input, 0, 0, blockW, blockH);

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, blockW, blockH, 0, 0, width, height);
  releaseBuffer(small);
  return output;
}

// Scale — explicit resize node. width/height factors are stored as percentage
// integers (100 = identity) so the inspector slider format stays consistent
// with the rest of the chain. Output canvas matches the new dimensions, which
// downstream nodes adapt to via their existing width/height handling.
export function applyScaleNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const xPct = clamp(Number(params.x ?? 100), 1, 1000);
  const yPct = clamp(Number(params.y ?? 100), 1, 1000);
  const filter = params.filter === "nearest" ? false : true;
  if (xPct === 100 && yPct === 100) return input;

  const w = Math.max(1, Math.round((input.width * xPct) / 100));
  const h = Math.max(1, Math.round((input.height * yPct) / 100));
  const output = createBuffer(w, h);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.imageSmoothingEnabled = filter;
  ctx.drawImage(input, 0, 0, input.width, input.height, 0, 0, w, h);
  return output;
}

// Tone Map — extended Reinhard with intensity (pre-exposure) + whitepoint
// (target brightest value). Useful before dither so blown highlights have
// somewhere to go instead of clipping to white.
export function applyToneMapNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const intensity = clamp(Number(params.intensity ?? 100) / 100, 0.1, 10);
  const whitepoint = clamp(Number(params.whitepoint ?? 100) / 100, 0.1, 10);
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
  const distortion = clamp(Number(params.distortion ?? 0) / 100, -0.999, 1);
  const dispersion = clamp(Number(params.dispersion ?? 0) / 100, 0, 1);
  const fit = !!params.fit;
  if (distortion === 0 && dispersion === 0) return input;

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

  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    const v = ((y + 0.5 - cy) / cy) * fitScale;
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5 - cx) / cx) * fitScale;
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

      const xr = (u * sR + 0.5) * width;
      const yr = (v * sR + 0.5) * height;
      const xg = (u * sG + 0.5) * width;
      const yg = (v * sG + 0.5) * height;
      const xb = (u * sB + 0.5) * width;
      const yb = (v * sB + 0.5) * height;

      out[i] = sampleBilinearChannel(srcData, width, height, xr, yr, 0);
      out[i + 1] = sampleBilinearChannel(srcData, width, height, xg, yg, 1);
      out[i + 2] = sampleBilinearChannel(srcData, width, height, xb, yb, 2);
      out[i + 3] = 255;
    }
  }

  ctx.putImageData(outData, 0, 0);
  return output;
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
