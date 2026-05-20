// RGB → BW — collapse the input to luminance with selectable
// coefficient set. BT.709 is the modern default (matches sRGB / HD
// video); BT.601 stays close to legacy NTSC source material;
// `average` gives a perfectly flat 1/3 mix for users who want a
// neutral desaturation without any channel weighting.
//
// Used internally by applySourceNode's optional bwMode pass and
// directly as a graph node when the user wants explicit control over
// the conversion.

import { createBuffer } from "./buffer-pool.js";
import { LUMA_BT601, LUMA_BT709 } from "../color.js";

export function applyRgbToBwNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const mode = String(params.mode ?? "bt709");
  let cr;
  let cg;
  let cb;
  switch (mode) {
    case "bt601":
      cr = LUMA_BT601.r;
      cg = LUMA_BT601.g;
      cb = LUMA_BT601.b;
      break;
    case "average":
      cr = cg = cb = 1 / 3;
      break;
    case "bt709":
    default:
      cr = LUMA_BT709.r;
      cg = LUMA_BT709.g;
      cb = LUMA_BT709.b;
      break;
  }
  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = Math.round(cr * data[i] + cg * data[i + 1] + cb * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = luma;
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}
