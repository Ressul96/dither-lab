// Scene Grade — final scene-wide colour pass intended to sit
// immediately before Viewer Output. Three stacked passes, applied in
// order so each feeds the next:
//
//   1. RGB curves — same LUT path as the standalone RGB Curves node
//      (curve-lut.js). Identity short-circuits when no point has
//      moved.
//   2. Clamp / gamma — input black/white window + post-gamma. Lets
//      the user lift shadows or compress highlights against a known
//      output range without writing curves by hand.
//   3. Optional colour map — sample the BT.709 luma through a
//      multi-stop gradient LUT (shared with the Gradient Map node).
//      Useful for "shadow → highlight" colour grading without
//      touching the per-channel curves.
//
// All three passes share one per-pixel loop so we only pay the
// canvas + getImageData allocation cost once.

import { createBuffer } from "./buffer-pool.js";
import { clamp, clamp01 } from "./pixel-math.js";
import { luminanceBt709 } from "../color.js";
import { buildGradientLut } from "../gl/gradient-lut.js";
import {
  areRgbCurvesIdentity,
  buildFinalRgbCurvesLuts,
  buildRgbCurvesLuts,
} from "../curve-lut.js";
import { sampleGradientLutInto } from "./gradient.js";

export function applySceneGradeNode(input, params = {}) {
  if (!input?.width || !input?.height) return null;

  const luts = buildRgbCurvesLuts(params);
  const hasCurves = !areRgbCurvesIdentity(luts);
  const clampMin = clamp(Number(params.clampMin ?? 0) / 100, 0, 1);
  const rawClampMax = clamp(Number(params.clampMax ?? 100) / 100, 0, 1);
  const clampMax = Math.max(rawClampMax, clampMin + 0.001);
  const clampGamma = clamp(Number(params.clampGamma ?? 100) / 100, 0.01, 4);
  const hasClamp =
    Math.abs(clampMin) > 1e-6 ||
    Math.abs(clampMax - 1) > 1e-6 ||
    Math.abs(clampGamma - 1) > 1e-6;
  const colorMapFlag = String(params.colorMapEnabled ?? "off").toLowerCase();
  const colorMapEnabled =
    params.colorMapEnabled === true || colorMapFlag === "on" || colorMapFlag === "true";

  if (!hasCurves && !hasClamp && !colorMapEnabled) return input;

  const finalLuts = hasCurves ? buildFinalRgbCurvesLuts(luts) : null;
  const colorMapLut = colorMapEnabled
    ? buildGradientLut(sceneGradeColorMapStops(params))
    : null;
  const colorMapData = colorMapLut?.data ?? null;
  const colorMapWidth = colorMapLut?.width ?? 0;
  const range = clampMax - clampMin;
  const inverseGamma = 1 / clampGamma;

  const output = createBuffer(input.width, input.height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.drawImage(input, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const data = imageData.data;
  const mapped = [0, 0, 0];

  for (let i = 0; i < data.length; i += 4) {
    let r = hasCurves ? finalLuts.red[data[i]] : data[i];
    let g = hasCurves ? finalLuts.green[data[i + 1]] : data[i + 1];
    let b = hasCurves ? finalLuts.blue[data[i + 2]] : data[i + 2];

    let rf = r / 255;
    let gf = g / 255;
    let bf = b / 255;

    if (hasClamp) {
      rf = Math.pow(clamp01((rf - clampMin) / range), inverseGamma);
      gf = Math.pow(clamp01((gf - clampMin) / range), inverseGamma);
      bf = Math.pow(clamp01((bf - clampMin) / range), inverseGamma);
    }

    if (colorMapData) {
      const luma = luminanceBt709(rf, gf, bf);
      sampleGradientLutInto(colorMapData, colorMapWidth, luma, mapped, 0);
      rf = mapped[0] / 255;
      gf = mapped[1] / 255;
      bf = mapped[2] / 255;
    }

    data[i] = Math.round(clamp01(rf) * 255);
    data[i + 1] = Math.round(clamp01(gf) * 255);
    data[i + 2] = Math.round(clamp01(bf) * 255);
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Default colour-map stops fall back to a two-stop shadow→highlight
// gradient when the user hasn't supplied explicit stops. Lets a
// freshly-added Scene Grade with colour map enabled render something
// visible immediately.
function sceneGradeColorMapStops(params) {
  if (Array.isArray(params?.colorMapStops) && params.colorMapStops.length > 0) {
    return params.colorMapStops;
  }
  return [
    { pos: 0, color: params?.colorMapShadow ?? "#111111" },
    { pos: 1, color: params?.colorMapHighlight ?? "#ffffff" },
  ];
}
