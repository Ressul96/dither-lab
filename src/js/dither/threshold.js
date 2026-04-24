import {
  clamp,
  luminance8,
  quantizeBW,
  writeMonochrome,
  writePixel,
  preAdjustRGB,
  isMonochromePalette,
} from "./core.js";
import { nearestColorInPalette } from "../palettes.js";

function runSimpleThreshold(imageData, params, palette) {
  if (isMonochromePalette(palette)) {
    runThresholdBW(imageData, params);
  } else {
    runThresholdRGB(imageData, params, palette);
  }
}

function runThresholdBW(imageData, params) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const mono = quantizeBW(
        luminance8(data[offset], data[offset + 1], data[offset + 2]),
        threshold,
        invert
      );
      writeMonochrome(data, offset, mono);
    }
  }
}

function runThresholdRGB(imageData, params, palette) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const adjusted = preAdjustRGB(
        data[offset],
        data[offset + 1],
        data[offset + 2],
        threshold,
        invert
      );
      const matched = nearestColorInPalette(adjusted[0], adjusted[1], adjusted[2], palette);
      writePixel(data, offset, matched[0], matched[1], matched[2]);
    }
  }
}

export const ALGORITHMS = [
  {
    id: "threshold",
    name: "Simple Threshold",
    family: "threshold-noise",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: runSimpleThreshold,
  },
];

export { runSimpleThreshold };
