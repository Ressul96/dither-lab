// Shared per-pixel helpers used across every image-ops module.
//
// These are the smallest, hottest helpers in the effect pipeline —
// inlined in tens of thousands of tight loops per frame. Keeping them
// in a single dep-light module lets the rest of the image-ops split
// (mix, color, dither, gradient) import a known stable surface instead
// of redeclaring the same helpers everywhere.
//
// Luma defaults to BT.709 (the project's canonical convention —
// see color.js for the rationale). Nodes that intentionally want BT.601
// (currently posterize / RGB-curves "luma mode", gradient-map's
// rgbLuma scale) import `luminanceBt601` from color.js directly.

import { luminanceBt709 } from "../color.js";

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

// Linear blend of two 0..255 bytes by `amount` in 0..1. Result is
// rounded to the nearest integer so writing back to a Uint8ClampedArray
// doesn't drop fractional precision on subsequent reads.
export function mixByte(a, b, amount) {
  return Math.round(a * (1 - amount) + b * amount);
}

// GLSL-style smoothstep: 0 at value≤edge0, 1 at value≥edge1, cubic
// Hermite interpolation in between. Used by threshold / mask soft edges.
export function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Luma in [0, 255] for an 8-bit RGB pixel. BT.709 by canonical default.
export function luminance8(r, g, b) {
  return luminanceBt709(r, g, b);
}

// Luma in [0, 1] for already-normalised floats. Same coefficients as
// luminance8, separate entry point so callers don't keep dividing by 255.
export function luminance01(r, g, b) {
  return luminanceBt709(r, g, b);
}
