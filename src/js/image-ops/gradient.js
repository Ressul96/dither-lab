// Gradient-flavoured nodes: parametric gradient and mesh-gradient
// sources, plus the gradient-map mapper that remaps an input's
// luma/channel signal through a multi-stop colour LUT.
//
// Gradient and mesh-gradient have a GPU fast path (gpu-effects.js)
// with a CPU fallback here for headless / WebGL2-disabled environments;
// gradient-map does the same. sampleGradientLutInto is re-exported so
// the scene-grade node (still in image-ops.js) can share the LUT
// sampling code instead of forking it.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01, mixByte } from "./pixel-math.js";
import { luminanceBt601 } from "../color.js";
import { buildGradientLut } from "../gl/gradient-lut.js";
import {
  applyGradientMapGpu,
  applyGradientSourceGpu,
  applyMeshGradientGpu,
} from "../gpu-effects.js";

// ---------------------------------------------------------------------------
// Mesh gradient source — soft radial blob per stop, screen-blended on
// the CPU fallback. Cheaper than the GPU's per-pixel weighted accumulate
// but visually close enough for headless preview / export.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parametric gradient source — linear / radial / conic with per-pixel
// LUT sampling. Used as a procedural input (no upstream image) for
// gradient backdrops or mask sources.
// ---------------------------------------------------------------------------

export function applyGradientNode(params = {}, context = {}) {
  const gpuOutput = applyGradientSourceGpu(params, context);
  if (gpuOutput) return gpuOutput;
  return applyGradientCpu(params);
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

// ---------------------------------------------------------------------------
// Gradient map — remap an input image's luma (or single channel) through
// a multi-stop colour LUT. Shares the stops + coordinate helpers with
// the source nodes since the LUT shape is identical.
// ---------------------------------------------------------------------------

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

// Default stops fall back to a two-stop shadow→highlight when the
// caller hasn't supplied an explicit gradient. Lets a freshly added
// gradient-map node render something visible immediately.
function gradientMapStops(params) {
  if (Array.isArray(params?.stops) && params.stops.length > 0) {
    return params.stops;
  }
  return [
    { pos: 0, color: params?.shadowColor ?? "#111111" },
    { pos: 1, color: params?.highlightColor ?? "#ffffff" },
  ];
}

// Single-channel scalar the LUT is indexed by. `luma` uses BT.601 to
// match the established gradient-map look; per-channel modes return
// the raw 0..1 normalised component.
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

// Bilinear sample of a 1D LUT (Uint8 RGBA flat array of `width` texels)
// at normalised `t` in [0, 1]. Writes the interpolated RGB triple into
// `target[offset..offset+2]` — the alpha channel is left for the caller
// to set since downstream nodes may want either 255 or premultiplied.
// Re-exported from image-ops.js so the scene-grade node can share the
// sampling code.
export function sampleGradientLutInto(data, width, t, target, offset = 0) {
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
