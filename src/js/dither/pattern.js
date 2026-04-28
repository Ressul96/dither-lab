import {
  clamp,
  luminance8,
  writeMonochrome,
  writePixel,
  isMonochromePalette,
} from "./core.js";
import { getPaletteExtremes } from "../palettes.js";

const LEVELS = 8;
const SPACING = [1, 2, 3, 4, 5, 7, 12, Number.POSITIVE_INFINITY];
const DOT_TILE_SIZE = 8;
const DOT_MASKS = buildDotMasks(DOT_TILE_SIZE);

function levelFromLuma(luma, threshold) {
  const shifted = clamp(luma - (threshold - 128), 0, 255);
  return Math.min(LEVELS - 1, Math.floor((shifted / 256) * LEVELS));
}

function resolveMono(isDark, invert) {
  if (invert) return isDark ? 255 : 0;
  return isDark ? 0 : 255;
}

function resolveDarkLight(invert, palette) {
  if (isMonochromePalette(palette)) {
    return {
      fg: invert ? [255, 255, 255] : [0, 0, 0],
      bg: invert ? [0, 0, 0] : [255, 255, 255],
    };
  }
  const { darkest, lightest } = getPaletteExtremes(palette);
  return {
    fg: invert ? lightest : darkest,
    bg: invert ? darkest : lightest,
  };
}

function writePatternPixel(data, offset, isDark, palette, fg, bg, invert) {
  if (isMonochromePalette(palette)) {
    writeMonochrome(data, offset, resolveMono(isDark, invert));
    return;
  }
  const color = isDark ? fg : bg;
  writePixel(data, offset, color[0], color[1], color[2]);
}

function buildDotMasks(tileSize) {
  const masks = new Uint8Array(LEVELS * tileSize * tileSize);
  const tileCenter = tileSize / 2;
  const maxRadius = tileCenter * Math.SQRT2;

  for (let level = 0; level < LEVELS; level++) {
    const radius = maxRadius * (1 - level / LEVELS);
    const radiusSq = radius * radius;
    for (let ty = 0; ty < tileSize; ty++) {
      for (let tx = 0; tx < tileSize; tx++) {
        const dx = tx - tileCenter + 0.5;
        const dy = ty - tileCenter + 0.5;
        const isDark = level <= 0 || (level < LEVELS - 1 && dx * dx + dy * dy <= radiusSq);
        masks[(level * tileSize + ty) * tileSize + tx] = isDark ? 1 : 0;
      }
    }
  }

  return masks;
}

function runHorizontalLines(imageData, params, palette) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const { fg, bg } = resolveDarkLight(invert, palette);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = luminance8(data[offset], data[offset + 1], data[offset + 2]);
      const level = levelFromLuma(luma, threshold);
      const spacing = SPACING[level];
      const isDark = Number.isFinite(spacing) && y % spacing === 0;
      writePatternPixel(data, offset, isDark, palette, fg, bg, invert);
    }
  }
}

function runVerticalLines(imageData, params, palette) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const { fg, bg } = resolveDarkLight(invert, palette);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = luminance8(data[offset], data[offset + 1], data[offset + 2]);
      const level = levelFromLuma(luma, threshold);
      const spacing = SPACING[level];
      const isDark = Number.isFinite(spacing) && x % spacing === 0;
      writePatternPixel(data, offset, isDark, palette, fg, bg, invert);
    }
  }
}

function runCrossHatch(imageData, params, palette) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const { fg, bg } = resolveDarkLight(invert, palette);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = luminance8(data[offset], data[offset + 1], data[offset + 2]);
      const level = levelFromLuma(luma, threshold);

      let isDark;
      if (level >= LEVELS - 1) {
        isDark = false;
      } else if (level <= 0) {
        isDark = true;
      } else {
        const spacing = SPACING[level];
        const diag1 = (x + y) % spacing === 0;
        const diag2 = (x - y + width * 2) % spacing === 0;
        const horiz = y % spacing === 0;
        const vert = x % spacing === 0;
        if (level <= 2) isDark = diag1 || diag2 || horiz || vert;
        else if (level <= 4) isDark = diag1 || horiz;
        else isDark = diag1;
      }

      writePatternPixel(data, offset, isDark, palette, fg, bg, invert);
    }
  }
}

function runDotPattern(imageData, params, palette) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const threshold = clamp(Math.round(params.threshold ?? 128), 0, 255);
  const invert = Boolean(params.invert);
  const { fg, bg } = resolveDarkLight(invert, palette);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = luminance8(data[offset], data[offset + 1], data[offset + 2]);
      const level = levelFromLuma(luma, threshold);
      const tx = x % DOT_TILE_SIZE;
      const ty = y % DOT_TILE_SIZE;
      const isDark = DOT_MASKS[(level * DOT_TILE_SIZE + ty) * DOT_TILE_SIZE + tx] === 1;

      writePatternPixel(data, offset, isDark, palette, fg, bg, invert);
    }
  }
}

export const ALGORITHMS = [
  {
    id: "cross-hatch",
    name: "Cross-hatch",
    family: "pattern",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: runCrossHatch,
  },
  {
    id: "horizontal-lines",
    name: "Horizontal Lines",
    family: "pattern",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: runHorizontalLines,
  },
  {
    id: "vertical-lines",
    name: "Vertical Lines",
    family: "pattern",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: runVerticalLines,
  },
  {
    id: "dot-pattern",
    name: "Dot Pattern",
    family: "pattern",
    type: "cpu",
    supportsSerpentine: false,
    supportsErrorStrength: false,
    run: runDotPattern,
  },
];

export { runHorizontalLines, runVerticalLines, runCrossHatch, runDotPattern };
