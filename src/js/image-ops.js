// Barrel module for the image-ops effect pipeline.
//
// Every effect node now lives in its own src/js/image-ops/* module
// (see M.3 commits in git history for the slice-by-slice refactor).
// This file just re-exports them under the existing import path so
// graph-runtime.js, source.js, graph-shell.js, and any future caller
// can keep doing `from "./image-ops.js"` without caring about the
// internal layout.
//
// Foundation: buffer-pool, pixel-math, blur-support, sampling.
// Utility:    blur, gradient, hsv.
// Catalog:    constants (mask/mix dropdown options).
// Nodes:      adjust, blur, chroma-aberration, dither, displace,
//             duotone, geometry (invert/crop/flip), glare, gradient
//             (gradient / mesh / map), hsv, layer-adjustments,
//             lens-distort, levels, mix (mix/mask-combine/mask-apply),
//             noise-source, posterize, rgb-curves, rgb-to-bw,
//             scene-grade, source, stylize-gpu (12 wrappers),
//             threshold, tone-map, transform (pixelate/scale/transform).

export { acquireBuffer, releaseBuffer } from "./image-ops/buffer-pool.js";
export { MASK_MODES, MASK_SOURCES, MIX_MODES } from "./image-ops/constants.js";

export { applyAdjustNode } from "./image-ops/adjust.js";
export { applyBlurNode } from "./image-ops/blur.js";
export { applyChromaticAberrationNode } from "./image-ops/chroma-aberration.js";
export { applyDisplaceNode } from "./image-ops/displace.js";
export { applyDitherNode } from "./image-ops/dither.js";
export { applyDuotoneNode } from "./image-ops/duotone.js";
export { applyCropNode, applyFlipNode, applyInvertNode } from "./image-ops/geometry.js";
export { applyGlareNode } from "./image-ops/glare.js";
export {
  applyGradientMapNode,
  applyGradientNode,
  applyMeshGradientNode,
} from "./image-ops/gradient.js";
export { applyHsvNode } from "./image-ops/hsv.js";
export { applyLayerAdjustmentsNode } from "./image-ops/layer-adjustments.js";
export { applyLensDistortNode } from "./image-ops/lens-distort.js";
export { applyLevelsNode } from "./image-ops/levels.js";
export {
  applyMaskApplyNode,
  applyMaskCombineNode,
  applyMixNode,
} from "./image-ops/mix.js";
export { applyNoiseNode } from "./image-ops/noise-source.js";
export { applyPosterizeNode } from "./image-ops/posterize.js";
export { applyRgbCurvesNode } from "./image-ops/rgb-curves.js";
export { applyRgbToBwNode } from "./image-ops/rgb-to-bw.js";
export { applySceneGradeNode } from "./image-ops/scene-grade.js";
export { applySourceNode } from "./image-ops/source.js";
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
} from "./image-ops/stylize-gpu.js";
export { applyThresholdNode } from "./image-ops/threshold.js";
export { applyToneMapNode } from "./image-ops/tone-map.js";
export {
  applyPixelateNode,
  applyScaleNode,
  applyTransformNode,
} from "./image-ops/transform.js";
