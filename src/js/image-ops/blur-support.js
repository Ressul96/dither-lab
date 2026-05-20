// Feature detect: does the host's Canvas 2D context honour the `filter`
// property with a blur(...) value? Required by the mask-apply node's
// feather option and the blur node's GPU fallback — both are pure JS
// raster ops that need a way to ask "can I trust ctx.filter, or should
// I run the slower box-blur path?".
//
// Detection runs once per process and caches the result. Costs one tiny
// canvas pair (16×16) on first call, then constant-time afterwards.

import { acquireBuffer, releaseBuffer } from "./buffer-pool.js";

let cached = null;

export function supportsBlurFilter() {
  if (cached != null) return cached;

  const source = acquireBuffer(16, 16);
  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  sourceCtx.fillStyle = "#000";
  sourceCtx.fillRect(0, 0, 16, 16);
  sourceCtx.fillStyle = "#fff";
  sourceCtx.fillRect(7, 7, 2, 2);

  const output = acquireBuffer(16, 16);
  const outputCtx = output.getContext("2d", { willReadFrequently: true });
  outputCtx.filter = "blur(3px)";
  outputCtx.drawImage(source, 0, 0);
  outputCtx.filter = "none";

  // Single bright pixel at the centre of `source` should bleed outwards
  // when blur is applied. If `outer` is brighter than 0 and dimmer than
  // `center`, the filter is doing real Gaussian-ish work.
  const center = outputCtx.getImageData(8, 8, 1, 1).data[0];
  const outer = outputCtx.getImageData(3, 8, 1, 1).data[0];
  cached = center > outer && outer > 0;
  releaseBuffer(source);
  releaseBuffer(output);
  return cached;
}
