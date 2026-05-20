// CPU dither node — orchestrates the dither/* algorithm registry
// against a palette over an input image, with optional pre-scale and
// pre-blur. The algorithms themselves (Floyd–Steinberg + family,
// ordered Bayer/halftone, threshold/noise patterns) live in
// src/js/dither/; this module just wires them into the effect pipeline.
//
// Pattern Dither (GPU-only) lives elsewhere — it covers the
// embarrassingly-parallel ordered/threshold patterns at full preview
// speed for video, while this CPU node owns the serial error-diffusion
// catalog plus discrete palette matching.

import { createBuffer, releaseBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { blurImage } from "./blur.js";
import { getPalette } from "../palettes.js";
import { runAlgorithm } from "../dither/index.js";

export function applyDitherNode(input, params) {
  if (!input?.width || !input?.height) return null;

  // Optional pre-scale: dither at a smaller resolution then upscale with
  // nearest-neighbour for a chunky pixel-art look. The runtime cache
  // keys on params, so changing scale invalidates correctly.
  const scale = clamp((params.scale ?? 100) / 100, 0.1, 1);
  const workWidth = Math.max(1, Math.round(input.width * scale));
  const workHeight = Math.max(1, Math.round(input.height * scale));
  const work = createBuffer(workWidth, workHeight);
  const workContext = work.getContext("2d", { alpha: false, willReadFrequently: true });
  workContext.imageSmoothingEnabled = true;
  workContext.drawImage(input, 0, 0, workWidth, workHeight);

  // Optional pre-blur: smooth the working canvas before the algorithm
  // runs so error-diffusion patterns avoid amplifying high-frequency
  // noise. blurRadius=0 short-circuits in blurImage.
  const blurredWork =
    (params.blurRadius ?? 0) > 0 ? blurImage(work, Number(params.blurRadius ?? 0)) : work;

  const blurredContext = blurredWork.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = blurredContext.getImageData(0, 0, workWidth, workHeight);
  const palette = getPalette(params.palette ?? "monochrome");
  runAlgorithm(params.algorithm ?? "floyd-steinberg", imageData, params, palette);
  blurredContext.putImageData(imageData, 0, 0);

  // Skip the upscale step in the common scale=1 case — return the
  // dithered canvas directly. Either workCanvas or blurredCanvas owns
  // the pooled buffer, so release whichever is the spare one.
  if (workWidth === input.width && workHeight === input.height) {
    if (blurredWork !== work) releaseBuffer(work);
    return blurredWork;
  }

  const output = createBuffer(input.width, input.height);
  const outputContext = output.getContext("2d", { alpha: false, willReadFrequently: true });
  // Nearest-neighbour preserves the dithered pixel pattern; smoothing
  // here would defeat the entire point of the pre-scale.
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
