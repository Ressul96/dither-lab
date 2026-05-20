// Shared sampling helpers for nodes that read from an RGBA byte array
// at sub-pixel coordinates: chromatic aberration, lens distort, and
// displace all need bilinear taps; displace's per-pixel layout also
// uses a nearest-neighbour read for the no-interpolation mode.
//
// These are tight inner-loop helpers — kept here so the consuming
// modules import a stable surface instead of redeclaring the same
// math or paying for cross-module circular re-exports.

// Bilinear sample of one channel (0=R, 1=G, 2=B, 3=A) from an RGBA
// byte buffer at (x, y). Returns 0 outside bounds — callers that need
// a clamped read pass the clamped coordinate themselves.
export function sampleBilinearChannel(data, width, height, x, y, channel) {
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

// Nearest-neighbour RGBA read into a target buffer. Out-of-bounds reads
// write opaque black so consumers can rely on a fully populated pixel
// without a separate bounds branch. Alpha is always written as 255 —
// displace and friends produce fully-opaque outputs.
export function sampleNearestInto(data, width, height, x, y, target, offset) {
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
