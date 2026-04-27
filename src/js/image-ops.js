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

export function applyGlowNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const threshold = clamp(Math.round(params.threshold ?? 180), 0, 255);
  const radius = Math.max(0, Number(params.radius ?? 12));
  const strength = clamp((params.strength ?? 100) / 100, 0, 4);

  const width = input.width;
  const height = input.height;

  const base = createBuffer(width, height);
  const baseCtx = base.getContext("2d", { alpha: false, willReadFrequently: true });
  baseCtx.drawImage(input, 0, 0);
  const baseData = baseCtx.getImageData(0, 0, width, height);

  const bright = createBuffer(width, height);
  const brightCtx = bright.getContext("2d", { willReadFrequently: true });
  const brightData = brightCtx.createImageData(width, height);
  for (let i = 0; i < baseData.data.length; i += 4) {
    const luma = luminance8(baseData.data[i], baseData.data[i + 1], baseData.data[i + 2]);
    if (luma >= threshold) {
      const glowAlpha = Math.round(((luma - threshold) / Math.max(1, 255 - threshold)) * 255);
      brightData.data[i] = baseData.data[i];
      brightData.data[i + 1] = baseData.data[i + 1];
      brightData.data[i + 2] = baseData.data[i + 2];
      brightData.data[i + 3] = glowAlpha;
    } else {
      brightData.data[i + 3] = 0;
    }
  }
  brightCtx.putImageData(brightData, 0, 0);

  const blurred = radius > 0 ? blurImage(bright, radius) : bright;

  const output = createBuffer(width, height);
  const outCtx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  outCtx.drawImage(base, 0, 0);
  outCtx.globalAlpha = strength;
  outCtx.globalCompositeOperation = "screen";
  outCtx.drawImage(blurred, 0, 0);
  outCtx.globalCompositeOperation = "source-over";
  outCtx.globalAlpha = 1;
  releaseBuffer(base);
  if (blurred !== bright) releaseBuffer(bright);
  releaseBuffer(blurred);
  return output;
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

export function applyDistortNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const amplitude = Math.max(0, Number(params.amplitude ?? 0));
  const frequency = Math.max(0, Number(params.frequency ?? 0));
  const phase = Number(params.phase ?? 0);
  if (amplitude === 0 || frequency === 0) return input;

  const width = input.width;
  const height = input.height;
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  const phaseRad = (phase / 180) * Math.PI;
  const cyclesPerHeight = frequency * Math.PI * 2;
  for (let y = 0; y < height; y++) {
    const shift = Math.sin((y / height) * cyclesPerHeight + phaseRad) * amplitude;
    ctx.drawImage(input, 0, y, width, 1, shift, y, width, 1);
  }
  return output;
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
