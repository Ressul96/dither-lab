export const PALETTE_EXTRACTION_SIZES = Object.freeze([2, 4, 8, 16, 32]);

const DEFAULT_EXTRACTION_SIZE = 4;
const MAX_SAMPLES = 24576;
const MIN_COLOR_DISTANCE_SQ = 108;

export function normalizeExtractionSize(size, fallback = DEFAULT_EXTRACTION_SIZE) {
  const numeric = Number(size);
  if (PALETTE_EXTRACTION_SIZES.includes(numeric)) return numeric;
  return fallback;
}

export function extractPaletteFromImageData(imageData, options = {}) {
  const size = normalizeExtractionSize(options.size);
  const avoidColors = normalizeColors(options.avoidColors);
  const entries = buildHistogram(imageData);
  if (entries.length === 0) return [];

  const palette = [];
  const candidateTarget = Math.min(entries.length, Math.max(size * 3, size));
  const candidates = extractMedianCutColors(entries, candidateTarget);

  for (const color of candidates) {
    if (pushDistinctColor(palette, color, avoidColors)) {
      if (palette.length >= size) return palette;
    }
  }

  const rankedEntries = [...entries].sort(compareEntriesByWeight);
  for (const entry of rankedEntries) {
    if (pushDistinctColor(palette, [entry.r, entry.g, entry.b], avoidColors)) {
      if (palette.length >= size) return palette;
    }
  }

  while (palette.length < size) {
    const fallback = pickFarthestEntry(entries, [...avoidColors, ...palette]);
    if (!fallback) break;
    if (!pushDistinctColor(palette, fallback, avoidColors, 0)) break;
  }

  if (palette.length === 0) {
    palette.push(averageEntries(entries));
  }

  return palette;
}

export function mergePaletteExtraction({ size, currentColors, lockedIndexes, extractedColors }) {
  const nextSize = normalizeExtractionSize(size);
  const safeCurrentColors = normalizeColors(currentColors);
  const safeExtractedColors = normalizeColors(extractedColors);
  const nextColors = Array.from({ length: nextSize }, () => null);
  const lockedByIndex = new Map();

  for (const index of Array.isArray(lockedIndexes) ? lockedIndexes : []) {
    if (index < 0 || index >= nextSize || index >= safeCurrentColors.length) continue;
    lockedByIndex.set(index, safeCurrentColors[index]);
    nextColors[index] = safeCurrentColors[index];
  }

  let extractedIndex = 0;
  for (let i = 0; i < nextColors.length; i++) {
    if (lockedByIndex.has(i)) continue;
    nextColors[i] =
      safeExtractedColors[extractedIndex++] ??
      safeCurrentColors[i] ??
      safeExtractedColors.at(-1) ??
      lockedByIndex.values().next().value ??
      [0, 0, 0];
  }

  return nextColors;
}

function buildHistogram(imageData) {
  if (!imageData?.data?.length || !imageData.width || !imageData.height) return [];

  const { data, width, height } = imageData;
  const totalPixels = width * height;
  const stride = Math.max(1, Math.ceil(Math.sqrt(totalPixels / MAX_SAMPLES)));
  const counts = new Map();

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      if ((data[index + 3] ?? 255) === 0) continue;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const key = r * 65536 + g * 256 + b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()].map(([key, count]) => ({
    r: Math.floor(key / 65536) % 256,
    g: Math.floor(key / 256) % 256,
    b: key % 256,
    count,
  }));
}

function extractMedianCutColors(entries, count) {
  if (entries.length === 0 || count <= 0) return [];

  const boxes = [createColorBox(entries)];
  while (boxes.length < count) {
    let nextIndex = -1;
    let nextScore = -1;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!canSplitBox(box)) continue;
      const score = Math.max(box.rRange, box.gRange, box.bRange) * box.totalCount;
      if (score > nextScore) {
        nextScore = score;
        nextIndex = i;
      }
    }

    if (nextIndex === -1) break;

    const [box] = boxes.splice(nextIndex, 1);
    const split = splitColorBox(box);
    if (!split) {
      boxes.push(box);
      break;
    }
    boxes.push(split[0], split[1]);
  }

  return boxes
    .map((box) => averageEntries(box.entries))
    .sort(compareColorsByLuma);
}

function createColorBox(entries) {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  let totalCount = 0;

  for (const entry of entries) {
    if (entry.r < rMin) rMin = entry.r;
    if (entry.r > rMax) rMax = entry.r;
    if (entry.g < gMin) gMin = entry.g;
    if (entry.g > gMax) gMax = entry.g;
    if (entry.b < bMin) bMin = entry.b;
    if (entry.b > bMax) bMax = entry.b;
    totalCount += entry.count;
  }

  return {
    entries,
    totalCount,
    rRange: rMax - rMin,
    gRange: gMax - gMin,
    bRange: bMax - bMin,
  };
}

function canSplitBox(box) {
  if (!box || box.entries.length < 2) return false;
  return box.rRange > 0 || box.gRange > 0 || box.bRange > 0;
}

function splitColorBox(box) {
  const channel = pickSplitChannel(box);
  const sorted = [...box.entries].sort((a, b) => compareEntriesByChannel(a, b, channel));
  const totalCount = sorted.reduce((sum, entry) => sum + entry.count, 0);
  const midpoint = totalCount / 2;
  let running = 0;
  let splitIndex = -1;

  for (let i = 0; i < sorted.length - 1; i++) {
    running += sorted[i].count;
    if (running >= midpoint) {
      splitIndex = i + 1;
      break;
    }
  }

  if (splitIndex <= 0 || splitIndex >= sorted.length) {
    splitIndex = Math.floor(sorted.length / 2);
  }
  if (splitIndex <= 0 || splitIndex >= sorted.length) return null;

  const left = sorted.slice(0, splitIndex);
  const right = sorted.slice(splitIndex);
  if (left.length === 0 || right.length === 0) return null;
  return [createColorBox(left), createColorBox(right)];
}

function pickSplitChannel(box) {
  if (box.gRange >= box.rRange && box.gRange >= box.bRange) return "g";
  if (box.rRange >= box.bRange) return "r";
  return "b";
}

function compareEntriesByChannel(a, b, channel) {
  const primary = a[channel] - b[channel];
  if (primary !== 0) return primary;
  if (a.r !== b.r) return a.r - b.r;
  if (a.g !== b.g) return a.g - b.g;
  if (a.b !== b.b) return a.b - b.b;
  return b.count - a.count;
}

function compareEntriesByWeight(a, b) {
  if (b.count !== a.count) return b.count - a.count;
  return compareColorsByLuma([a.r, a.g, a.b], [b.r, b.g, b.b]);
}

function compareColorsByLuma(a, b) {
  const lumaDiff = colorLuma(a) - colorLuma(b);
  if (lumaDiff !== 0) return lumaDiff;
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function averageEntries(entries) {
  let totalCount = 0;
  let r = 0;
  let g = 0;
  let b = 0;

  for (const entry of entries) {
    totalCount += entry.count;
    r += entry.r * entry.count;
    g += entry.g * entry.count;
    b += entry.b * entry.count;
  }

  if (totalCount <= 0) return [0, 0, 0];
  return [
    Math.round(r / totalCount),
    Math.round(g / totalCount),
    Math.round(b / totalCount),
  ];
}

function pickFarthestEntry(entries, existingColors) {
  let best = null;
  let bestScore = -1;

  for (const entry of entries) {
    const color = [entry.r, entry.g, entry.b];
    const distance = minDistanceSq(color, existingColors);
    const score = distance * Math.sqrt(entry.count);
    if (score > bestScore) {
      bestScore = score;
      best = color;
    }
  }

  return best;
}

function pushDistinctColor(target, color, avoidColors, minDistance = MIN_COLOR_DISTANCE_SQ) {
  const candidate = normalizeColor(color);
  const existing = [...avoidColors, ...target];
  if (existing.length > 0 && minDistanceSq(candidate, existing) <= minDistance) {
    return false;
  }
  target.push(candidate);
  return true;
}

function minDistanceSq(color, palette) {
  if (!palette.length) return Infinity;
  let best = Infinity;
  for (const existing of palette) {
    const distance = colorDistanceSq(color, existing);
    if (distance < best) best = distance;
  }
  return best;
}

function colorDistanceSq(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function colorLuma(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function normalizeColors(colors) {
  if (!Array.isArray(colors)) return [];
  return colors.map(normalizeColor);
}

function normalizeColor(color) {
  return [
    clampChannel(color?.[0]),
    clampChannel(color?.[1]),
    clampChannel(color?.[2]),
  ];
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}
