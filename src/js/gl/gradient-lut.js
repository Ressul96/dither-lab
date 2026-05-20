// Shared gradient lookup-table builder.
//
// Many effects need to map a 0..1 scalar (luminance, normalized time, ...)
// to a custom multi-stop color gradient. Doing the spline math in the
// fragment shader for every fragment is wasteful; instead we bake the
// gradient once into a 256×1 RGBA texture and let the shader read it with
// a single texture lookup.
//
// This module is the canonical place for that bake. Callers (gradient-map,
// star-glow, future curves preset preview, …) all hand the same shape:
//
//   stops:   [{ pos: 0..1, color: "#rrggbb" }, ...]
//   options: { width = 256 }
//
// and get back:
//
//   { canvas, data, width, stops, key }
//
// `canvas` is a 2D-context canvas (HTMLCanvasElement when available, an
// OffscreenCanvas otherwise) that already has the gradient painted into it
// — handy for inspector swatches without a second bake. `data` is the
// underlying Uint8ClampedArray, ready for gl.texImage2D.

import { hexToRgb01 } from "../color.js";

const DEFAULT_WIDTH = 256;
const MAX_WIDTH = 4096;
const ENDPOINT_FALLBACK = [255, 255, 255]; // white when stops are empty

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function normalizeWidth(width) {
  const numeric = Math.round(Number(width ?? DEFAULT_WIDTH));
  if (!Number.isFinite(numeric)) return DEFAULT_WIDTH;
  return Math.max(2, Math.min(MAX_WIDTH, numeric));
}

function hexToRgb255(hex, fallback = ENDPOINT_FALLBACK) {
  const rgb01 = hexToRgb01(hex, [fallback[0] / 255, fallback[1] / 255, fallback[2] / 255]);
  return [
    Math.round(rgb01[0] * 255),
    Math.round(rgb01[1] * 255),
    Math.round(rgb01[2] * 255),
  ];
}

function normalizeStops(stops) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return [
      { pos: 0, rgb: ENDPOINT_FALLBACK.slice() },
      { pos: 1, rgb: ENDPOINT_FALLBACK.slice() },
    ];
  }

  const out = stops
    .map((stop) => ({
      pos: clamp01(Number(stop?.pos)),
      rgb: hexToRgb255(stop?.color),
    }))
    .sort((a, b) => a.pos - b.pos);

  // Pad endpoints. Without this the texture lookup would clamp to the
  // closest defined stop, which is what we want — so we just synthesise the
  // sentinel pos=0 / pos=1 entries from the existing extremes.
  if (out[0].pos > 0) out.unshift({ pos: 0, rgb: out[0].rgb.slice() });
  if (out[out.length - 1].pos < 1) {
    out.push({ pos: 1, rgb: out[out.length - 1].rgb.slice() });
  }
  return out;
}

function lerpRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Walk the sorted stops once, advancing the segment cursor when the
// current pixel passes its right endpoint. O(width + stops).
function paintLut(width, stops) {
  const data = new Uint8ClampedArray(width * 4);
  let seg = 0;
  for (let i = 0; i < width; i++) {
    const u = width === 1 ? 0 : i / (width - 1);
    while (seg < stops.length - 2 && stops[seg + 1].pos < u) seg++;
    const a = stops[seg];
    const b = stops[seg + 1] ?? a;
    const span = Math.max(1e-6, b.pos - a.pos);
    const t = clamp01((u - a.pos) / span);
    const rgb = lerpRgb(a.rgb, b.rgb, t);
    const idx = i * 4;
    data[idx + 0] = rgb[0];
    data[idx + 1] = rgb[1];
    data[idx + 2] = rgb[2];
    data[idx + 3] = 255;
  }
  return data;
}

function createLutCanvas(width) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, 1);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = 1;
    return canvas;
  }
  return null;
}

export function getGradientLutKey(stops, options = {}) {
  const width = normalizeWidth(options.width);
  const normalized = normalizeStops(stops);
  const parts = normalized.map(
    (s) => `${s.pos.toFixed(4)}:${s.rgb[0]},${s.rgb[1]},${s.rgb[2]}`
  );
  return `w${width}|${parts.join("|")}`;
}

export function buildGradientLut(stops, options = {}) {
  const width = normalizeWidth(options.width);
  const normalized = normalizeStops(stops);
  const data = paintLut(width, normalized);

  const canvas = createLutCanvas(width);
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const image = new ImageData(new Uint8ClampedArray(data), width, 1);
      ctx.putImageData(image, 0, 0);
    }
  }

  return {
    canvas,
    data,
    width,
    stops: normalized,
    key: getGradientLutKey(stops, options),
  };
}

// Upload the LUT as a 1D-style 2D texture. Keeps wrap-S = REPEAT so shaders
// can scroll/shift via UV math (`fract(u + shift)`); wrap-T = CLAMP since
// the height is 1. Pass `existing` to reuse a previous texture handle.
export function uploadGradientLutTexture(gl, lut, existing = null) {
  if (!gl || !lut?.data) return null;
  const tex = existing ?? gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    lut.width,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    lut.data
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
