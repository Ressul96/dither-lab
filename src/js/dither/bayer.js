import {
  clamp,
  luminance8,
  quantizeBW,
  writeMonochrome,
  writePixel,
  isMonochromePalette,
} from "./core.js";
import { nearestColorInPalette } from "../palettes.js";

const BAYER_BASE = [0, 2, 3, 1];
const RGB_BIAS_RANGE = 96;

function generateBayer(size) {
  if (size === 2) return [...BAYER_BASE];
  const prev = generateBayer(size / 2);
  const half = size / 2;
  const out = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const qx = x < half ? 0 : 1;
      const qy = y < half ? 0 : 1;
      const lx = x % half;
      const ly = y % half;
      const quadrant = BAYER_BASE[qy * 2 + qx];
      const inner = prev[ly * half + lx];
      out[y * size + x] = 4 * inner + quadrant;
    }
  }
  return out;
}

function generateClusteredDot(size) {
  const center = (size - 1) / 2;
  const cells = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      cells.push({ x, y, dist, jitter: (x * 37 + y * 91) % 7 });
    }
  }
  cells.sort((a, b) => a.dist - b.dist || a.jitter - b.jitter);
  const matrix = new Array(size * size);
  cells.forEach((cell, index) => {
    matrix[cell.y * size + cell.x] = index;
  });
  return matrix;
}

function generateHalftone(size) {
  const tileSize = size / 2;
  const tile = generateClusteredDot(tileSize);
  const matrix = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = x % tileSize;
      const ty = y % tileSize;
      const tileIndex = Math.floor(y / tileSize) * 2 + Math.floor(x / tileSize);
      matrix[y * size + x] = tile[ty * tileSize + tx] + tileIndex * (tileSize * tileSize);
    }
  }
  return matrix;
}

function generateDispersedDot(size) {
  const bayer = generateBayer(size);
  const permuted = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const newX = (x * 3 + y) % size;
      permuted[y * size + newX] = bayer[y * size + x];
    }
  }
  return permuted;
}

const MATRICES = {
  "bayer-2x2": { size: 2, matrix: generateBayer(2) },
  "bayer-4x4": { size: 4, matrix: generateBayer(4) },
  "bayer-8x8": { size: 8, matrix: generateBayer(8) },
  "bayer-16x16": { size: 16, matrix: generateBayer(16) },
  "clustered-dot-4x4": { size: 4, matrix: generateClusteredDot(4) },
  "clustered-dot-8x8": { size: 8, matrix: generateClusteredDot(8) },
  halftone: { size: 8, matrix: generateHalftone(8) },
  "dispersed-dot": { size: 8, matrix: generateDispersedDot(8) },
};

function runOrderedDither(imageData, params, palette, size, matrix) {
  if (isMonochromePalette(palette)) {
    runOrderedBW(imageData, params, size, matrix);
  } else {
    runOrderedRGB(imageData, params, palette, size, matrix);
  }
}

function runOrderedBW(imageData, params, size, matrix) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const matrixMax = size * size;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = luminance8(data[offset], data[offset + 1], data[offset + 2]);
      const matrixValue = matrix[(y % size) * size + (x % size)];
      const localThreshold = clamp(
        threshold + ((matrixValue + 0.5) / matrixMax - 0.5) * 128,
        0,
        255
      );
      const mono = quantizeBW(luma, localThreshold, invert);
      writeMonochrome(data, offset, mono);
    }
  }
}

function runOrderedRGB(imageData, params, palette, size, matrix) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const matrixMax = size * size;
  const shift = threshold - 128;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const matrixValue = matrix[(y % size) * size + (x % size)];
      const bias = ((matrixValue + 0.5) / matrixMax - 0.5) * RGB_BIAS_RANGE;

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

function makeOrderedAlgorithm(id, name, matrixKey) {
  const entry = MATRICES[matrixKey];
  return {
    id,
    name,
    family: "ordered",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: (imageData, params, palette) =>
      runOrderedDither(imageData, params, palette, entry.size, entry.matrix),
  };
}

export const ALGORITHMS = [
  makeOrderedAlgorithm("bayer-2x2", "Bayer 2x2", "bayer-2x2"),
  makeOrderedAlgorithm("bayer-4x4", "Bayer 4x4", "bayer-4x4"),
  makeOrderedAlgorithm("bayer-8x8", "Bayer 8x8", "bayer-8x8"),
  makeOrderedAlgorithm("bayer-16x16", "Bayer 16x16", "bayer-16x16"),
  makeOrderedAlgorithm("clustered-dot-4x4", "Clustered Dot 4x4", "clustered-dot-4x4"),
  makeOrderedAlgorithm("clustered-dot-8x8", "Clustered Dot 8x8", "clustered-dot-8x8"),
  makeOrderedAlgorithm("halftone", "Halftone", "halftone"),
  makeOrderedAlgorithm("dispersed-dot", "Dispersed Dot", "dispersed-dot"),
];

export { runOrderedDither, generateBayer, generateClusteredDot, MATRICES };
