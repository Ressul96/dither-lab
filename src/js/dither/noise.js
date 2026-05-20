import {
  clamp,
  luminance8,
  quantizeBW,
  writeMonochrome,
  writePixel,
  isMonochromePalette,
} from "./core.js";
import { nearestColorInPalette } from "../palettes.js";

const RGB_BIAS_RANGE = 96;

function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// This is not true blue noise — it's a 2D golden-ratio low-discrepancy
// sequence (Roberts 2018, R2 sequence). Real blue noise needs a
// precomputed mask whose Fourier spectrum is concentrated in high
// frequencies; the R2 sequence is cheaper and visually similar for
// dither thresholds but its spectrum is different. The UI label
// reflects this; the registry id stays "blue-noise" for saved-project
// compatibility.
function pseudoBlueNoise(x, y) {
  const g = 1.32471795724474602596;
  const a1 = 1 / g;
  const a2 = 1 / (g * g);
  const raw = x * a1 + y * a2;
  return raw - Math.floor(raw);
}

function interleavedGradient(x, y) {
  const inner = 0.06711056 * x + 0.00583715 * y;
  const frac = inner - Math.floor(inner);
  const raw = 52.9829189 * frac;
  return raw - Math.floor(raw);
}

function runRandomDither(imageData, params, palette) {
  const seed = Number(params.seed ?? 1337);
  const rng = mulberry32(seed);
  runNoiseDither(imageData, params, palette, () => rng());
}

function runBlueNoise(imageData, params, palette) {
  runNoiseDither(imageData, params, palette, (x, y) => pseudoBlueNoise(x, y));
}

function runInterleavedGradientNoise(imageData, params, palette) {
  runNoiseDither(imageData, params, palette, (x, y) => interleavedGradient(x, y));
}

function runNoiseDither(imageData, params, palette, sampleNoise) {
  if (isMonochromePalette(palette)) {
    runNoiseBW(imageData, params, sampleNoise);
  } else {
    runNoiseRGB(imageData, params, palette, sampleNoise);
  }
}

function runNoiseBW(imageData, params, sampleNoise) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = luminance8(data[offset], data[offset + 1], data[offset + 2]);
      const noise = sampleNoise(x, y) * 255;
      const localThreshold = clamp(threshold + (noise - 128), 0, 255);
      const mono = quantizeBW(luma, localThreshold, invert);
      writeMonochrome(data, offset, mono);
    }
  }
}

function runNoiseRGB(imageData, params, palette, sampleNoise) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const shift = threshold - 128;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const bias = (sampleNoise(x, y) - 0.5) * RGB_BIAS_RANGE;

      let r = data[offset] + shift + bias;
      let g = data[offset + 1] + shift + bias;
      let b = data[offset + 2] + shift + bias;
      if (invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }
      r = clamp(r, 0, 255);
      g = clamp(g, 0, 255);
      b = clamp(b, 0, 255);

      const matched = nearestColorInPalette(r, g, b, palette);
      writePixel(data, offset, matched[0], matched[1], matched[2]);
    }
  }
}

export const ALGORITHMS = [
  {
    id: "random",
    name: "Random",
    family: "threshold-noise",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    supportsSeed: true,
    run: runRandomDither,
  },
  {
    id: "blue-noise",
    name: "Pseudo Blue Noise (R2)",
    family: "threshold-noise",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: runBlueNoise,
  },
  {
    id: "interleaved-gradient-noise",
    name: "Interleaved Gradient Noise",
    family: "threshold-noise",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: runInterleavedGradientNoise,
  },
];

export { runRandomDither, runBlueNoise, runInterleavedGradientNoise, mulberry32 };
