import { hexToRgb01, LUMA_BT601, LUMA_BT709, luminanceBt601 } from "./color.js";
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
import {
  applyPixelateNode,
  applyScaleNode,
  applyTransformNode,
} from "./image-ops/transform.js";
import { applyThresholdNode } from "./image-ops/threshold.js";
import { supportsBlurFilter } from "./image-ops/blur-support.js";
import {
  applyMaskApplyNode,
  applyMaskCombineNode,
  applyMixNode,
} from "./image-ops/mix.js";
import { applyBlurNode, blurImage } from "./image-ops/blur.js";
import { applyDitherNode } from "./image-ops/dither.js";
import {
  applyGradientMapNode,
  applyGradientNode,
  applyMeshGradientNode,
} from "./image-ops/gradient.js";
import { applyNoiseNode } from "./image-ops/noise-source.js";
import { sampleBilinearChannel, sampleNearestInto } from "./image-ops/sampling.js";
import { applyChromaticAberrationNode } from "./image-ops/chroma-aberration.js";
import { applyToneMapNode } from "./image-ops/tone-map.js";
import { applyHsvNode } from "./image-ops/hsv.js";
import { applyLayerAdjustmentsNode } from "./image-ops/layer-adjustments.js";
import { applyLensDistortNode } from "./image-ops/lens-distort.js";
import { applyDisplaceNode } from "./image-ops/displace.js";
import { applyRgbToBwNode } from "./image-ops/rgb-to-bw.js";
import { applyPosterizeNode } from "./image-ops/posterize.js";
import { applyAdjustNode } from "./image-ops/adjust.js";
import { applyDuotoneNode } from "./image-ops/duotone.js";
import { applySourceNode } from "./image-ops/source.js";
import { applyLevelsNode } from "./image-ops/levels.js";
import { applyRgbCurvesNode } from "./image-ops/rgb-curves.js";
import { applySceneGradeNode } from "./image-ops/scene-grade.js";
import { applyGlareNode } from "./image-ops/glare.js";
import {
  applyAnalogNode,
  applyAsciiNode,
  applyBloomNode,
  applyCrtNode,
  applyDepthOfFieldNode,
  applyHalationNode,
  applyHalftoneNode,
  applyLedScreenNode,
  applyModulationNode,
  applyPatternDitherNode,
  applyPixelSortingNode,
  applyVhsNode,
} from "./image-ops/stylize-gpu.js";

// Re-export the pool so external consumers (graph-runtime.js, source.js)
// keep importing from "./image-ops.js" unchanged. Internal effect
// functions below use the imported names directly. The mask/mix catalogs
// and the dep-free geometry nodes (invert/crop/flip) flow through here
// too so graph-shell.js + graph-runtime.js's existing import paths hold.
export { acquireBuffer, releaseBuffer };
export { MASK_MODES, MASK_SOURCES, MIX_MODES };
export { applyCropNode, applyFlipNode, applyInvertNode };
export { applyPixelateNode, applyScaleNode, applyTransformNode };
export { applyThresholdNode };
export { applyMaskApplyNode, applyMaskCombineNode, applyMixNode };
export { applyDitherNode };
export { applyGradientMapNode, applyGradientNode, applyMeshGradientNode };
export { applyBlurNode };
export { applyNoiseNode };
export { applyChromaticAberrationNode };
export { applyToneMapNode };
export { applyHsvNode };
export { applyLayerAdjustmentsNode };
export { applyLensDistortNode };
export { applyDisplaceNode };
export { applyRgbToBwNode };
export { applyPosterizeNode };
export { applyAdjustNode };
export { applyDuotoneNode };
export { applySourceNode };
export { applyLevelsNode };
export { applyRgbCurvesNode };
export { applySceneGradeNode };
export { applyGlareNode };
export {
  applyAnalogNode,
  applyAsciiNode,
  applyBloomNode,
  applyCrtNode,
  applyDepthOfFieldNode,
  applyHalationNode,
  applyHalftoneNode,
  applyLedScreenNode,
  applyModulationNode,
  applyPatternDitherNode,
  applyPixelSortingNode,
  applyVhsNode,
};
// Everything below the import block is now re-exports + breadcrumbs.
// curve-lut + gradient-lut imports moved into image-ops/scene-grade.js
// and image-ops/rgb-curves.js. gpu-effects imports moved into the
// matching per-node modules (applyBloomGpu/applyStarGlowGpu → glare.js,
// applyChromaticAberrationGpu → chroma-aberration.js, etc.).
// supportsBlurFilter lives in image-ops/blur-support.js and is shared
// between blur.js + mix.js without a circular import.

// Adjust — canonical color-grade order: exposure (linear-light) → gamma →
// brightness offset → contrast pivot → saturation around luma. The previous
// order applied exposure last, multiplying on top of an already-clamped
// gamma-corrected value, which made bright pixels saturate immediately and
// felt unresponsive at low exposure values. Each operation only clamps once,
// at the end, so intermediate over-range values can still be brought back
// into [0,1] by a later op (e.g. exposure pushes white past 1 then contrast
// pulls it back rather than clipping mid-chain).
// applyAdjustNode moved to image-ops/adjust.js (canonical
// exposure→gamma→brightness→contrast→saturation pipeline). Re-exported
// at the top of this file so applySourceNode's chain stays unchanged.

// applySourceNode moved to image-ops/source.js — composit chain of
// adjust → hsv → rgb-to-bw → invert. All four sub-nodes live in their
// own modules now, so the source module is just orchestration.

// applyMeshGradientNode + applyGradientNode (+ their CPU bodies and
// gradientSource* helpers, wrap01) moved to image-ops/gradient.js.
// Re-exported at the top of this file. applyNoiseNode stays here for
// now since it's a different category (procedural noise source).

// applyNoiseNode moved to image-ops/noise-source.js — its own module
// because the FBM CPU fallback (today a grey-card stub) will grow
// when real noise generation lands.

// applyBlurNode moved to image-ops/blur.js (sits alongside its
// blurImage CPU fallback). Re-exported at the top of this file.

// applyGlareNode (+ mapGlareBlend + renderMultiOctaveBlur +
// extractBrightPass + hueToRgb01 + renderStreaks helpers) moved to
// image-ops/glare.js. Re-exported at the top of this file.

// Posterize — reduce smooth gradients to N discrete color levels per channel.
// Tries the GPU shader first (supports per-channel steps, gamma, luma mode);
// falls back to the legacy CPU path for old saves on machines without WebGL2.
// applyPosterizeNode + applyPosterizeCpu + toLinear/toSrgb moved to
// image-ops/posterize.js. Re-exported at the top of this file.

// applyInvertNode moved to image-ops/geometry.js and re-exported at the
// top of this file. Kept here only as a breadcrumb for grep/contributors.

// applyRgbToBwNode moved to image-ops/rgb-to-bw.js (luma collapse with
// selectable BT.709/BT.601/average coefficients). Re-exported at the
// top of this file so applySourceNode's bwMode chain + graph-runtime
// stay unchanged.

// applyHsvNode moved to image-ops/hsv.js. Re-exported at the top of
// this file so applyAdjustNode / applySourceNode chains keep working.

// applyRgbCurvesNode moved to image-ops/rgb-curves.js (LUT-based
// channel curves with rgb / luma / color apply modes). The
// scaleRgbToLumaInto helper moved with it (only consumer); the
// thin rgbLuma wrapper was inlined to luminanceBt601 calls. Re-
// exported at the top of this file.

// applySceneGradeNode + sceneGradeColorMapStops moved to
// image-ops/scene-grade.js (RGB curves + clamp/gamma + optional
// luma → gradient colour map). Re-exported at the top of this file.

// applyLayerAdjustmentsNode moved to image-ops/layer-adjustments.js
// (per-node opacity / hue / saturation override pass driven by the
// graph runtime). Re-exported at the top of this file.

// Pixelate — collapse NxN blocks of source pixels into a single color so the
// downstream chain (especially dither) operates on a chunky low-resolution
// version of the image without changing canvas dimensions.
//
// GPU shader is the primary path (supports separate X/Y aspect, circle
// pixels, edge softness). Legacy CPU path stays available as a fallback
// when WebGL2 is missing — it runs canvas downscale + nearest upscale
// which is the cheapest box-average we can do with the 2D API.
// applyPixelateNode + applyScaleNode + applyTransformNode moved to
// image-ops/transform.js and re-exported at the top of this file.
// applyCropNode + applyFlipNode moved to image-ops/geometry.js and
// re-exported at the top of this file.

// Tone Map — extended Reinhard with intensity (pre-exposure) + whitepoint
// (target brightest value). Useful before dither so blown highlights have
// somewhere to go instead of clipping to white.
// applyLevelsNode moved to image-ops/levels.js (input black/white +
// gamma + output range remap with optional luma mode). Re-exported
// at the top of this file.

// Duotone — luminance-mapped two-color gradient. Per-channel gamma biases
// the luma calculation: a high redGamma makes red areas read as brighter
// (push toward highlight color), low redGamma pushes them toward shadow.
// CPU reference per duotone_entegrasyon.md §3.
// applyDuotoneNode moved to image-ops/duotone.js (per-channel gamma
// LUT + luma → shadow/highlight gradient remap). Re-exported above.

// Gradient Map — maps a scalar signal (luma by default) through the shared
// gradient LUT. GPU owns the hot path; CPU fallback keeps WebGL2-disabled
// environments visually consistent and exercises the same LUT helper.
// applyGradientMapNode (+ CPU body and gradientMap* helpers) moved to
// image-ops/gradient.js. sampleGradientLutInto is re-imported above so
// the scene-grade node (still in this file) can keep using it.

// applyToneMapNode moved to image-ops/tone-map.js (extended Reinhard
// with intensity + whitepoint). Re-exported at the top of this file.

// Lens Distortion — radial barrel/pincushion warp with optional chromatic
// aberration. Replaces the old sine-wave Distort node, which wasn't really
// what "distort" meant in any compositor. Math follows Blender's
// node_composite_lens_distortion: a per-pixel scale factor based on the
// squared distance from center, with a separate scale per RGB channel for
// the dispersion split. Single-tap bilinear samples per channel — no
// multi-step integration since we're targeting moderate user values.
// applyLensDistortNode + applyVignetteInPlace moved to
// image-ops/lens-distort.js. Re-exported at the top of this file.

// 12 trivial GPU-passthrough wrappers (halftone, led-screen, modulation,
// pixel-sorting, depth-of-field, vhs, crt, analog, bloom, halation,
// ascii, pattern-dither) moved to image-ops/stylize-gpu.js and
// re-exported at the top of this file.

// applyThresholdNode + thresholdChannelValue moved to
// image-ops/threshold.js and re-exported at the top of this file.

// applyChromaticAberrationNode + applyChromaticAberrationCpu moved to
// image-ops/chroma-aberration.js. Re-exported at the top of this file.

// applyDisplaceNode (+ createDisplaceMapLayout + sampleDisplaceMapInto
// + mapSamplePositionInto + positiveModulo) moved to image-ops/displace.js.
// Re-exported at the top of this file.

// applyMaskCombineNode + applyMaskApplyNode + sampleMaskChannel moved
// to image-ops/mix.js (mask family alongside applyMixNode + composite
// mapper). Re-exported at the top of this file.

// Smoothly darken pixels as their normalised distance from the lens centre
// approaches 1. `amount` controls the falloff strength — 0 leaves the image
// untouched, 1 fully blacks out the corners.
// applyVignetteInPlace moved alongside applyLensDistortNode into
// image-ops/lens-distort.js (its only consumer).

// rgbToHsvInto moved to image-ops/hsv.js (only consumed by applyHsvNode).

// rgbLuma / scaleRgbToLumaInto moved alongside applyRgbCurvesNode into
// image-ops/rgb-curves.js (the only consumer). rgbLuma was a 1-line
// wrapper around luminanceBt601 and is now inlined at the call site.

// hsvToRgbInto moved to image-ops/hsv.js (only consumed by applyHsvNode).

// sampleBilinearChannel + sampleNearestInto moved to
// image-ops/sampling.js. Imported at the top so the 9 callsites
// inside this file resolve through the shared module.

// applyMixNode + mapCompositeMode moved to image-ops/mix.js. The
// MIX_MODES catalog lives in image-ops/constants.js (re-exported at
// the top of this file so graph-shell.js's import path holds).

// applyDitherNode moved to image-ops/dither.js (CPU palette-aware
// dither orchestrator). Re-exported at the top of this file.

// blurImage + boxBlur (+ blurHorizontal/blurVertical) moved to
// image-ops/blur.js. Imported at the top so the 4 callers in this file
// (blur node, dither node, glare/bloom paths, streaks) resolve through
// the shared module.

// clamp, clamp01, mixByte, smoothstep, luminance8, luminance01 moved to
// image-ops/pixel-math.js. Imported at the top of this file so existing
// callsites inside image-ops resolve unchanged.

// toLinear / toSrgb moved alongside applyPosterizeCpu into
// image-ops/posterize.js (its only consumer).

// thresholdChannelValue moved to image-ops/threshold.js (single
// consumer, no other module needs it).
