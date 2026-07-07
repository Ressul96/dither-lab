// Shared per-pixel helpers used across every image-ops module.
//
// These are the smallest, hottest helpers in the effect pipeline —
// inlined in tens of thousands of tight loops per frame. Keeping them
// in a single dep-light module lets the rest of the image-ops split
// (mix, color, dither, gradient) import a known stable surface instead
// of redeclaring the same helpers everywhere.
//
// Luma is BT.709 across the whole pipeline (project canon — see
// color.js for the rationale). The only remaining BT.601 caller is the
// user-selectable RGB-to-BW "BT.601" coefficient set, which imports
// LUMA_BT601 directly when that option is picked.

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
  // A degenerate range (edge0 === edge1) makes the division 0/0 → NaN, which
  // GLSL leaves undefined. Every current caller passes a non-zero spread, so
  // this only hardens the primitive for future ones: collapse to a clean step
  // (0 below the edge, 1 at or above it).
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
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
