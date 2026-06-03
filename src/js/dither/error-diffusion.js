import {
  clamp,
  quantizeBW,
  readLuminance,
  writeValuesMonochrome,
  readRGB,
  writeRGB,
  isMonochromePalette,
} from "./core.js";
import { createPaletteQuantizer } from "../palettes.js";

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

// Pre-flatten a kernel's offsets into typed arrays so the per-pixel diffusion
// loop avoids object-property reads, a function call, and a per-neighbour
// divide. Two weight forms keep each path's exact float order (so output stays
// pixel-identical):
//   * weight (int)      — BW path computes (error * weight) / divisor
//   * weightDiv (float) — RGB path computes err * (weight / divisor)
function compileKernel(kernel) {
  const count = kernel.offsets.length;
  const dx = new Int32Array(count);
  const dy = new Int32Array(count);
  const weight = new Int32Array(count);
  const weightDiv = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const offset = kernel.offsets[i];
    dx[i] = offset.dx;
    dy[i] = offset.dy;
    weight[i] = offset.weight;
    weightDiv[i] = offset.weight / kernel.divisor;
  }
  return { dx, dy, weight, weightDiv, divisor: kernel.divisor, count };
}

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
  const { dx, dy, weight, divisor, count } = kernel;

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

      for (let k = 0; k < count; k++) {
        const sx = x + dx[k] * forward;
        const sy = y + dy[k];
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const targetIndex = sy * width + sx;
        const next = values[targetIndex] + (error * weight[k]) / divisor;
        values[targetIndex] = next < 0 ? 0 : next > 255 ? 255 : next;
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
  const shift = threshold - 128;
  const { dx, dy, weightDiv, count } = kernel;

  const { r, g, b } = readRGB(data, width, height);
  for (let i = 0; i < r.length; i++) {
    let nr = clamp(r[i] + shift, 0, 255);
    let ng = clamp(g[i] + shift, 0, 255);
    let nb = clamp(b[i] + shift, 0, 255);
    if (invert) {
      nr = 255 - nr;
      ng = 255 - ng;
      nb = 255 - nb;
    }
    r[i] = nr;
    g[i] = ng;
    b[i] = nb;
  }

  const quantize = createPaletteQuantizer(palette);

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
      const matched = quantize(oldR, oldG, oldB);
      const newR = matched[0];
      const newG = matched[1];
      const newB = matched[2];
      r[index] = newR;
      g[index] = newG;
      b[index] = newB;

      const errR = (oldR - newR) * errorStrength;
      const errG = (oldG - newG) * errorStrength;
      const errB = (oldB - newB) * errorStrength;

      for (let k = 0; k < count; k++) {
        const sx = x + dx[k] * forward;
        const sy = y + dy[k];
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const targetIndex = sy * width + sx;
        const w = weightDiv[k];
        let v;
        v = r[targetIndex] + errR * w; r[targetIndex] = v < 0 ? 0 : v > 255 ? 255 : v;
        v = g[targetIndex] + errG * w; g[targetIndex] = v < 0 ? 0 : v > 255 ? 255 : v;
        v = b[targetIndex] + errB * w; b[targetIndex] = v < 0 ? 0 : v > 255 ? 255 : v;
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
  // Ring buffer: `head` is the oldest slot. history[(head+i) % HISTORY] is the
  // i-th oldest error, pairing with weights[i] exactly as the old shift-down
  // array did — so the weighted sum (and output) is bit-identical, but each
  // pixel skips the 16-element array shift the previous version paid.
  let head = 0;

  const order = hilbertOrder(width, height);
  const orderLen = order.length;

  for (let p = 0; p < orderLen; p++) {
    const index = order[p];
    let accumulated = 0;
    for (let i = 0; i < HISTORY; i++) {
      accumulated += (history[(head + i) % HISTORY] * weights[i]) / weightSum;
    }
    const oldValue = values[index] + accumulated * errorStrength;
    const newValue = quantizeBW(oldValue, threshold, invert);
    const error = oldValue - newValue;
    values[index] = newValue;

    history[head] = error;
    head = (head + 1) % HISTORY;
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
  const shift = threshold - 128;

  const { r, g, b } = readRGB(data, width, height);
  for (let i = 0; i < r.length; i++) {
    let nr = clamp(r[i] + shift, 0, 255);
    let ng = clamp(g[i] + shift, 0, 255);
    let nb = clamp(b[i] + shift, 0, 255);
    if (invert) {
      nr = 255 - nr;
      ng = 255 - ng;
      nb = 255 - nb;
    }
    r[i] = nr;
    g[i] = ng;
    b[i] = nb;
  }

  const HISTORY = 16;
  const RATIO = 1 / 16;
  const weights = new Float32Array(HISTORY);
  let weightSum = 0;
  for (let i = 0; i < HISTORY; i++) {
    weights[i] = Math.pow(RATIO, (HISTORY - 1 - i) / (HISTORY - 1));
    weightSum += weights[i];
  }
  // Pre-divide the weights once. Float64 keeps the exact value the per-pixel
  // loop produced (weights[i] / weightSum), so output is identical — the RGB
  // path already used this `history * (weight / sum)` form, we just hoist the
  // divide out of the 48-iterations-per-pixel inner loop.
  const normWeights = new Float64Array(HISTORY);
  for (let i = 0; i < HISTORY; i++) normWeights[i] = weights[i] / weightSum;

  const historyR = new Float32Array(HISTORY);
  const historyG = new Float32Array(HISTORY);
  const historyB = new Float32Array(HISTORY);
  const quantize = createPaletteQuantizer(palette);
  // Ring buffer (see runRiemersmaBW): history[(head+i) % HISTORY] is the i-th
  // oldest error, pairing with normWeights[i] just like the old shift-down
  // array — output is identical, but each pixel skips three 16-element shifts.
  let head = 0;

  const order = hilbertOrder(width, height);
  const orderLen = order.length;

  for (let p = 0; p < orderLen; p++) {
    const index = order[p];

    let accR = 0;
    let accG = 0;
    let accB = 0;
    for (let i = 0; i < HISTORY; i++) {
      const slot = (head + i) % HISTORY;
      const w = normWeights[i];
      accR += historyR[slot] * w;
      accG += historyG[slot] * w;
      accB += historyB[slot] * w;
    }

    const oldR = clamp(r[index] + accR * errorStrength, 0, 255);
    const oldG = clamp(g[index] + accG * errorStrength, 0, 255);
    const oldB = clamp(b[index] + accB * errorStrength, 0, 255);
    const matched = quantize(oldR, oldG, oldB);
    r[index] = matched[0];
    g[index] = matched[1];
    b[index] = matched[2];

    historyR[head] = oldR - matched[0];
    historyG[head] = oldG - matched[1];
    historyB[head] = oldB - matched[2];
    head = (head + 1) % HISTORY;
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

function hilbertD2XY(n, d, out) {
  let rx;
  let ry;
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    // d < size*size <= 2^30 for any realistic frame, so t stays well within the
    // 32-bit range where >> 1 / >> 2 equal Math.floor(t / 2) / Math.floor(t / 4)
    // — same result, no Math.floor call per step.
    rx = 1 & (t >> 1);
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
    t = t >> 2;
  }
  out[0] = x;
  out[1] = y;
}

// Riemersma walks pixels along a Hilbert curve. The curve only depends on the
// frame size, so the visit order (in-bounds pixel indices, in curve sequence)
// is computed once per size and cached — during video playback every frame
// after the first skips the ~size² hilbertD2XY calls entirely. Bounded LRU so a
// few distinct sizes (source + export) can coexist without unbounded growth.
const HILBERT_ORDER_CACHE = new Map();
const HILBERT_ORDER_CACHE_LIMIT = 4;

function hilbertOrder(width, height) {
  const key = `${width}x${height}`;
  const cached = HILBERT_ORDER_CACHE.get(key);
  if (cached) return cached;

  const { size } = hilbertExtent(width, height);
  const total = size * size;
  const order = new Int32Array(width * height);
  const point = new Int32Array(2);
  let n = 0;
  for (let d = 0; d < total; d++) {
    hilbertD2XY(size, d, point);
    const x = point[0];
    const y = point[1];
    if (x >= width || y >= height) continue;
    order[n++] = y * width + x;
  }

  if (HILBERT_ORDER_CACHE.size >= HILBERT_ORDER_CACHE_LIMIT) {
    HILBERT_ORDER_CACHE.delete(HILBERT_ORDER_CACHE.keys().next().value);
  }
  HILBERT_ORDER_CACHE.set(key, order);
  return order;
}

function makeKernelAlgorithm(id, name, kernelKey) {
  const compiled = compileKernel(KERNELS[kernelKey]);
  return {
    id,
    name,
    family: "error-diffusion",
    type: "cpu",
    supportsSerpentine: true,
    supportsErrorStrength: true,
    run: (imageData, params, palette) =>
      runKernelDiffusion(imageData, params, palette, compiled),
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
