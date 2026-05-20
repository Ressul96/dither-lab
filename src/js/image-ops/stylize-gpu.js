// GPU-only stylize/post-process nodes. Each is a thin wrapper around
// its matching shader in gpu-effects.js; the CPU equivalents would be
// far too slow at preview resolutions (per-pixel multi-tap blurs,
// per-cell glyph rasterization, etc.). The fallback when WebGL2 is
// missing is `?? input` — the graph keeps rendering with the upstream
// frame instead of producing a black canvas.
//
// applyAnalogNode is the one composite in here: it routes between
// VHS, CRT, and the chained VHS+CRT modes depending on `params.mode`,
// and releases the VHS intermediate when the chain runs to completion.

import { releaseBuffer } from "./buffer-pool.js";
import {
  applyAsciiGpu,
  applyBloomGpu,
  applyCrtGpu,
  applyDepthOfFieldGpu,
  applyHalationGpu,
  applyHalftoneGpu,
  applyLedScreenGpu,
  applyModulationGpu,
  applyPatternDitherGpu,
  applyPixelSortingGpu,
  applyVhsGpu,
} from "../gpu-effects.js";

export function applyHalftoneNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Halftone is GPU-only for now; the dot grid math is more expensive
  // per-pixel than the chromatic aberration shader, so a CPU fallback
  // would burn time rather than degrade gracefully.
  const gpuOutput = applyHalftoneGpu(input, params);
  return gpuOutput ?? input;
}

export function applyLedScreenNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // LED Screen is GPU-only: per-pixel diode, subpixel, and glow mask
  // math is exactly what the fullscreen shader path is for. Pass-through
  // keeps the graph usable on WebGL2-disabled browsers.
  const gpuOutput = applyLedScreenGpu(input, params);
  return gpuOutput ?? input;
}

export function applyModulationNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Modulation is GPU-only: phase-modulated line masks are cheap in a
  // shader but not worth a per-pixel CPU fallback during playback.
  const gpuOutput = applyModulationGpu(input, params);
  return gpuOutput ?? input;
}

export function applyPixelSortingNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // P1 Pixel Sorting is a GPU-only glitch-sort approximation. True
  // segment sorting would need a CPU/worker or multi-pass path; out
  // of the live playback route for now.
  const gpuOutput = applyPixelSortingGpu(input, params);
  return gpuOutput ?? input;
}

export function applyDepthOfFieldNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Depth of Field P1 is GPU-only: even 32 round aperture taps per
  // pixel are too expensive for the live CPU path. Pass-through
  // fallback keeps older browsers rendering the graph.
  const gpuOutput = applyDepthOfFieldGpu(input, params);
  return gpuOutput ?? input;
}

export function applyVhsNode(input, params, context) {
  if (!input?.width || !input?.height) return null;
  // VHS is GPU-only — multi-tap chroma blur, scrolling tracking bands,
  // and per-frame noise. CPU port would be unusable in realtime.
  const gpuOutput = applyVhsGpu(input, params, context);
  return gpuOutput ?? input;
}

export function applyCrtNode(input, params, context) {
  if (!input?.width || !input?.height) return null;
  // CRT is GPU-only for the same reason as VHS: barrel distortion plus
  // a 5-tap glow blur per pixel and a per-pixel mask lookup blow up
  // CPU cost very quickly.
  const gpuOutput = applyCrtGpu(input, params, context);
  return gpuOutput ?? input;
}

// Analog — composite of VHS/CRT/VHS+CRT. `vhs-crt` chains both
// shaders; the intermediate VHS canvas is released back to the buffer
// pool when the chain completes (unless it pass-through'd the input,
// in which case it isn't ours to release).
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
  // texture taps per output pixel (golden-spiral sampling), wildly out
  // of reach for a CPU implementation at preview resolutions.
  const gpuOutput = applyBloomGpu(input, params);
  return gpuOutput ?? input;
}

export function applyHalationNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Halation shares Bloom's per-pixel cost profile — same 24-tap
  // golden spiral, so it's GPU-only too.
  const gpuOutput = applyHalationGpu(input, params);
  return gpuOutput ?? input;
}

export function applyAsciiNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // ASCII relies on a glyph atlas texture sampled per output pixel —
  // the CPU equivalent would mean per-cell font rasterization on every
  // frame, which is impractical.
  const gpuOutput = applyAsciiGpu(input, params);
  return gpuOutput ?? input;
}

export function applyPatternDitherNode(input, params) {
  if (!input?.width || !input?.height) return null;
  // Pattern Dither is GPU-only and intentionally lives alongside the
  // CPU Dither node — it covers the embarrassingly-parallel ordered /
  // threshold patterns at full preview speed for video, while the CPU
  // node owns the serial error-diffusion catalog plus discrete palette
  // matching.
  const gpuOutput = applyPatternDitherGpu(input, params);
  return gpuOutput ?? input;
}
