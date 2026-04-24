import {
  clamp,
  quantizeBW,
  readLuminance,
  writeValuesMonochrome,
  readRGB,
  writeRGB,
  preAdjustRGB,
  isMonochromePalette,
} from "./core.js";
import { nearestColorInPalette } from "../palettes.js";

const KERNELS = {
  "floyd-steinberg": {
    divisor: 16,
    offsets: [
      { dx: 1, dy: 0, weight: 7 },
      { dx: -1, dy: 1, weight: 3 },
      { dx: 0, dy: 1, weight: 5 },
      { dx: 1, dy: 1, weight: 1 },
    ],
  },
  "false-floyd-steinberg": {
    divisor: 8,
    offsets: [
      { dx: 1, dy: 0, weight: 3 },
      { dx: 0, dy: 1, weight: 3 },
      { dx: 1, dy: 1, weight: 2 },
    ],
  },
  "jarvis-judice-ninke": {
    divisor: 48,
    offsets: [
      { dx: 1, dy: 0, weight: 7 },
      { dx: 2, dy: 0, weight: 5 },
      { dx: -2, dy: 1, weight: 3 },
      { dx: -1, dy: 1, weight: 5 },
      { dx: 0, dy: 1, weight: 7 },
      { dx: 1, dy: 1, weight: 5 },
      { dx: 2, dy: 1, weight: 3 },
      { dx: -2, dy: 2, weight: 1 },
      { dx: -1, dy: 2, weight: 3 },
      { dx: 0, dy: 2, weight: 5 },
      { dx: 1, dy: 2, weight: 3 },
      { dx: 2, dy: 2, weight: 1 },
    ],
  },
  stucki: {
    divisor: 42,
    offsets: [
      { dx: 1, dy: 0, weight: 8 },
      { dx: 2, dy: 0, weight: 4 },
      { dx: -2, dy: 1, weight: 2 },
      { dx: -1, dy: 1, weight: 4 },
      { dx: 0, dy: 1, weight: 8 },
      { dx: 1, dy: 1, weight: 4 },
      { dx: 2, dy: 1, weight: 2 },
      { dx: -2, dy: 2, weight: 1 },
      { dx: -1, dy: 2, weight: 2 },
      { dx: 0, dy: 2, weight: 4 },
      { dx: 1, dy: 2, weight: 2 },
      { dx: 2, dy: 2, weight: 1 },
    ],
  },
  atkinson: {
    divisor: 8,
    offsets: [
      { dx: 1, dy: 0, weight: 1 },
      { dx: 2, dy: 0, weight: 1 },
      { dx: -1, dy: 1, weight: 1 },
      { dx: 0, dy: 1, weight: 1 },
      { dx: 1, dy: 1, weight: 1 },
      { dx: 0, dy: 2, weight: 1 },
    ],
  },
  burkes: {
    divisor: 32,
    offsets: [
      { dx: 1, dy: 0, weight: 8 },
      { dx: 2, dy: 0, weight: 4 },
      { dx: -2, dy: 1, weight: 2 },
      { dx: -1, dy: 1, weight: 4 },
      { dx: 0, dy: 1, weight: 8 },
      { dx: 1, dy: 1, weight: 4 },
      { dx: 2, dy: 1, weight: 2 },
    ],
  },
  sierra: {
    divisor: 32,
    offsets: [
      { dx: 1, dy: 0, weight: 5 },
      { dx: 2, dy: 0, weight: 3 },
      { dx: -2, dy: 1, weight: 2 },
      { dx: -1, dy: 1, weight: 4 },
      { dx: 0, dy: 1, weight: 5 },
      { dx: 1, dy: 1, weight: 4 },
      { dx: 2, dy: 1, weight: 2 },
      { dx: -1, dy: 2, weight: 2 },
      { dx: 0, dy: 2, weight: 3 },
      { dx: 1, dy: 2, weight: 2 },
    ],
  },
  "two-row-sierra": {
    divisor: 16,
    offsets: [
      { dx: 1, dy: 0, weight: 4 },
      { dx: 2, dy: 0, weight: 3 },
      { dx: -2, dy: 1, weight: 1 },
      { dx: -1, dy: 1, weight: 2 },
      { dx: 0, dy: 1, weight: 3 },
      { dx: 1, dy: 1, weight: 2 },
      { dx: 2, dy: 1, weight: 1 },
    ],
  },
  "sierra-lite": {
    divisor: 4,
    offsets: [
      { dx: 1, dy: 0, weight: 2 },
      { dx: -1, dy: 1, weight: 1 },
      { dx: 0, dy: 1, weight: 1 },
    ],
  },
  "stevenson-arce": {
    divisor: 200,
    offsets: [
      { dx: 2, dy: 0, weight: 32 },
      { dx: -3, dy: 1, weight: 12 },
      { dx: -1, dy: 1, weight: 26 },
      { dx: 1, dy: 1, weight: 30 },
      { dx: 3, dy: 1, weight: 16 },
      { dx: -2, dy: 2, weight: 12 },
      { dx: 0, dy: 2, weight: 26 },
      { dx: 2, dy: 2, weight: 12 },
      { dx: -3, dy: 3, weight: 5 },
      { dx: -1, dy: 3, weight: 12 },
      { dx: 1, dy: 3, weight: 12 },
      { dx: 3, dy: 3, weight: 5 },
    ],
  },
};

function runKernelDiffusion(imageData, params, palette, kernel) {
  if (isMonochromePalette(palette)) {
    runKernelDiffusionBW(imageData, params, kernel);
  } else {
    runKernelDiffusionRGB(imageData, params, palette, kernel);
  }
}

function runKernelDiffusionBW(imageData, params, kernel) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const errorStrength = clamp((params.errorStrength ?? 100) / 100, 0, 1);
  const serpentine = params.serpentine !== false;

  const values = readLuminance(data, width, height);

  for (let y = 0; y < height; y++) {
    const reverse = serpentine && y % 2 === 1;
    const start = reverse ? width - 1 : 0;
    const end = reverse ? -1 : width;
    const step = reverse ? -1 : 1;
    const forward = reverse ? -1 : 1;

    for (let x = start; x !== end; x += step) {
      const index = y * width + x;
      const oldValue = values[index];
      const newValue = quantizeBW(oldValue, threshold, invert);
      const error = (oldValue - newValue) * errorStrength;
      values[index] = newValue;

      for (const offset of kernel.offsets) {
        const sx = x + offset.dx * forward;
        const sy = y + offset.dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const targetIndex = sy * width + sx;
        const next = values[targetIndex] + (error * offset.weight) / kernel.divisor;
        values[targetIndex] = clamp(next, 0, 255);
      }
    }
  }

  writeValuesMonochrome(data, values);
}

function runKernelDiffusionRGB(imageData, params, palette, kernel) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const errorStrength = clamp((params.errorStrength ?? 100) / 100, 0, 1);
  const serpentine = params.serpentine !== false;

  const { r, g, b } = readRGB(data, width, height);
  for (let i = 0; i < r.length; i++) {
    const adjusted = preAdjustRGB(r[i], g[i], b[i], threshold, invert);
    r[i] = adjusted[0];
    g[i] = adjusted[1];
    b[i] = adjusted[2];
  }

  for (let y = 0; y < height; y++) {
    const reverse = serpentine && y % 2 === 1;
    const start = reverse ? width - 1 : 0;
    const end = reverse ? -1 : width;
    const step = reverse ? -1 : 1;
    const forward = reverse ? -1 : 1;

    for (let x = start; x !== end; x += step) {
      const index = y * width + x;
      const oldR = r[index];
      const oldG = g[index];
      const oldB = b[index];
      const matched = nearestColorInPalette(oldR, oldG, oldB, palette);
      const newR = matched[0];
      const newG = matched[1];
      const newB = matched[2];
      r[index] = newR;
      g[index] = newG;
      b[index] = newB;

      const errR = (oldR - newR) * errorStrength;
      const errG = (oldG - newG) * errorStrength;
      const errB = (oldB - newB) * errorStrength;

      for (const offset of kernel.offsets) {
        const sx = x + offset.dx * forward;
        const sy = y + offset.dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const targetIndex = sy * width + sx;
        const weight = offset.weight / kernel.divisor;
        r[targetIndex] = clamp(r[targetIndex] + errR * weight, 0, 255);
        g[targetIndex] = clamp(g[targetIndex] + errG * weight, 0, 255);
        b[targetIndex] = clamp(b[targetIndex] + errB * weight, 0, 255);
      }
    }
  }

  writeRGB(data, r, g, b);
}

function runRiemersma(imageData, params, palette) {
  if (isMonochromePalette(palette)) {
    runRiemersmaBW(imageData, params);
  } else {
    runRiemersmaRGB(imageData, params, palette);
  }
}

function runRiemersmaBW(imageData, params) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const errorStrength = clamp((params.errorStrength ?? 100) / 100, 0, 1);

  const values = readLuminance(data, width, height);

  const HISTORY = 16;
  const RATIO = 1 / 16;
  const weights = new Float32Array(HISTORY);
  let weightSum = 0;
  for (let i = 0; i < HISTORY; i++) {
    weights[i] = Math.pow(RATIO, (HISTORY - 1 - i) / (HISTORY - 1));
    weightSum += weights[i];
  }
  const history = new Float32Array(HISTORY);

  const { size } = hilbertExtent(width, height);

  const total = size * size;
  for (let d = 0; d < total; d++) {
    const { x, y } = hilbertD2XY(size, d);
    if (x >= width || y >= height) continue;
    const index = y * width + x;
    let accumulated = 0;
    for (let i = 0; i < HISTORY; i++) {
      accumulated += (history[i] * weights[i]) / weightSum;
    }
    const oldValue = values[index] + accumulated * errorStrength;
    const newValue = quantizeBW(oldValue, threshold, invert);
    const error = oldValue - newValue;
    values[index] = newValue;

    for (let i = 0; i < HISTORY - 1; i++) history[i] = history[i + 1];
    history[HISTORY - 1] = error;
  }

  writeValuesMonochrome(data, values);
}

function runRiemersmaRGB(imageData, params, palette) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const errorStrength = clamp((params.errorStrength ?? 100) / 100, 0, 1);

  const { r, g, b } = readRGB(data, width, height);
  for (let i = 0; i < r.length; i++) {
    const adjusted = preAdjustRGB(r[i], g[i], b[i], threshold, invert);
    r[i] = adjusted[0];
    g[i] = adjusted[1];
    b[i] = adjusted[2];
  }

  const HISTORY = 16;
  const RATIO = 1 / 16;
  const weights = new Float32Array(HISTORY);
  let weightSum = 0;
  for (let i = 0; i < HISTORY; i++) {
    weights[i] = Math.pow(RATIO, (HISTORY - 1 - i) / (HISTORY - 1));
    weightSum += weights[i];
  }
  const historyR = new Float32Array(HISTORY);
  const historyG = new Float32Array(HISTORY);
  const historyB = new Float32Array(HISTORY);

  const { size } = hilbertExtent(width, height);

  const total = size * size;
  for (let d = 0; d < total; d++) {
    const { x, y } = hilbertD2XY(size, d);
    if (x >= width || y >= height) continue;
    const index = y * width + x;

    let accR = 0;
    let accG = 0;
    let accB = 0;
    for (let i = 0; i < HISTORY; i++) {
      const w = weights[i] / weightSum;
      accR += historyR[i] * w;
      accG += historyG[i] * w;
      accB += historyB[i] * w;
    }

    const oldR = clamp(r[index] + accR * errorStrength, 0, 255);
    const oldG = clamp(g[index] + accG * errorStrength, 0, 255);
    const oldB = clamp(b[index] + accB * errorStrength, 0, 255);
    const matched = nearestColorInPalette(oldR, oldG, oldB, palette);
    r[index] = matched[0];
    g[index] = matched[1];
    b[index] = matched[2];

    const errR = oldR - matched[0];
    const errG = oldG - matched[1];
    const errB = oldB - matched[2];

    for (let i = 0; i < HISTORY - 1; i++) {
      historyR[i] = historyR[i + 1];
      historyG[i] = historyG[i + 1];
      historyB[i] = historyB[i + 1];
    }
    historyR[HISTORY - 1] = errR;
    historyG[HISTORY - 1] = errG;
    historyB[HISTORY - 1] = errB;
  }

  writeRGB(data, r, g, b);
}

function hilbertExtent(width, height) {
  let order = 0;
  let size = 1;
  const extent = Math.max(width, height);
  while (size < extent) {
    size *= 2;
    order++;
  }
  if (order === 0) order = 1;
  if (size < 2) size = 2;
  return { size, order };
}

function hilbertD2XY(n, d) {
  let rx;
  let ry;
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    rx = 1 & (Math.floor(t / 2));
    ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return { x, y };
}

function makeKernelAlgorithm(id, name, kernelKey) {
  return {
    id,
    name,
    family: "error-diffusion",
    type: "cpu",
    supportsSerpentine: true,
    supportsErrorStrength: true,
    run: (imageData, params, palette) =>
      runKernelDiffusion(imageData, params, palette, KERNELS[kernelKey]),
  };
}

export const ALGORITHMS = [
  makeKernelAlgorithm("floyd-steinberg", "Floyd-Steinberg", "floyd-steinberg"),
  makeKernelAlgorithm("false-floyd-steinberg", "False Floyd-Steinberg", "false-floyd-steinberg"),
  makeKernelAlgorithm("jarvis-judice-ninke", "Jarvis-Judice-Ninke", "jarvis-judice-ninke"),
  makeKernelAlgorithm("stucki", "Stucki", "stucki"),
  makeKernelAlgorithm("atkinson", "Atkinson", "atkinson"),
  makeKernelAlgorithm("burkes", "Burkes", "burkes"),
  makeKernelAlgorithm("sierra", "Sierra", "sierra"),
  makeKernelAlgorithm("two-row-sierra", "Two-Row Sierra", "two-row-sierra"),
  makeKernelAlgorithm("sierra-lite", "Sierra Lite", "sierra-lite"),
  makeKernelAlgorithm("stevenson-arce", "Stevenson-Arce", "stevenson-arce"),
  {
    id: "riemersma",
    name: "Riemersma",
    family: "error-diffusion",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: true,
    run: runRiemersma,
  },
];

export { runKernelDiffusion, runRiemersma, KERNELS };
