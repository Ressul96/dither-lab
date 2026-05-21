// Color math helpers for the inspector color picker, extracted
// from graph-shell.js. Pure functions: hex-string parsing and
// normalization, three-channel HSV ↔ RGB conversion, and the
// padded `#rrggbb` writer used by every commit path that round-
// trips through the picker.
//
// `normalizeHex` from ../color.js is the shared source-of-truth
// for canonical six-digit hex parsing; this module wraps it for
// the picker-specific cases (null-on-invalid, HSV pivot).
//
// A local `clamp` is inlined instead of importing from
// image-ops/pixel-math.js so the inspector layer doesn't take a
// dependency on the image processing tree just for `clamp(s, 0, 1)`.

import { normalizeHex } from "../color.js";

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

export function normalizeHexOrNull(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return normalizeHex(`#${raw}`, "#000000");
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return normalizeHex(`#${raw}`, "#000000");
  }
  return null;
}

export function hexToHsvColor(hex) {
  const [r, g, b] = hexToRgb255(normalizeHex(hex, "#ffffff"));
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
  }
  return {
    h: (h * 60 + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

export function hsvColorToHex(color) {
  const hue = (((Number(color.h) || 0) % 360) + 360) % 360;
  const saturation = clamp(Number(color.s), 0, 1);
  const value = clamp(Number(color.v), 0, 1);
  const chroma = value * saturation;
  const huePrime = hue / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (huePrime < 1) {
    r = chroma;
    g = x;
  } else if (huePrime < 2) {
    r = x;
    g = chroma;
  } else if (huePrime < 3) {
    g = chroma;
    b = x;
  } else if (huePrime < 4) {
    g = x;
    b = chroma;
  } else if (huePrime < 5) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }
  const match = value - chroma;
  return rgbChannelsToHex((r + match) * 255, (g + match) * 255, (b + match) * 255);
}

export function rgbChannelsToHex(r, g, b) {
  const toHex = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
    .toString(16)
    .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hexToRgb255(hex) {
  const safe = normalizeHex(hex, "#ffffff").slice(1);
  return [
    parseInt(safe.slice(0, 2), 16),
    parseInt(safe.slice(2, 4), 16),
    parseInt(safe.slice(4, 6), 16),
  ];
}
