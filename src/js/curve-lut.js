const RGB_CURVE_CHANNELS = ["master", "red", "green", "blue"];
const APPLY_MODES = ["normal", "luma", "color"];
export const MIN_CURVE_POINT_GAP = 3;

export function identityCurvePoints() {
  return [{ x: 0, y: 0 }, { x: 255, y: 255 }];
}

export function normalizeCurveApplyMode(value) {
  const mode = String(value ?? "normal").toLowerCase();
  return APPLY_MODES.includes(mode) ? mode : "normal";
}

export function readRgbCurvePoints(params, prefix) {
  const channel = RGB_CURVE_CHANNELS.includes(prefix) ? prefix : "master";
  const raw = params?.[`points_${channel}`];
  if (Array.isArray(raw) && raw.length >= 2) {
    const points = sanitizeCurvePoints(raw);
    return points.length >= 2 ? points : identityCurvePoints();
  }
  const low = Number(params?.[`${channel}Low`] ?? 0);
  const mid = Number(params?.[`${channel}Mid`] ?? 128);
  const high = Number(params?.[`${channel}High`] ?? 255);
  return [
    { x: 0, y: clamp(Math.round(low), 0, 255) },
    { x: 128, y: clamp(Math.round(mid), 0, 255) },
    { x: 255, y: clamp(Math.round(high), 0, 255) },
  ];
}

export function buildRgbCurvesLuts(params) {
  return {
    master: buildRgbCurveLut(params, "master"),
    red: buildRgbCurveLut(params, "red"),
    green: buildRgbCurveLut(params, "green"),
    blue: buildRgbCurveLut(params, "blue"),
  };
}

export function buildRgbCurveLut(params, prefix) {
  const channel = RGB_CURVE_CHANNELS.includes(prefix) ? prefix : "master";
  const points = params?.[`points_${channel}`];
  if (Array.isArray(points) && points.length >= 2) {
    return buildCurveLut(points);
  }
  return buildLegacyCurveLut(
    params?.[`${channel}Low`],
    params?.[`${channel}Mid`],
    params?.[`${channel}High`]
  );
}

export function buildCurveLut(rawPoints) {
  const lut = new Uint8ClampedArray(256);
  const points = sanitizeCurvePoints(rawPoints);
  if (points.length < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  const n = points.length;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const tangent = computeMonotoneCurveTangents(points);

  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) {
      lut[x] = clamp(Math.round(ys[0]), 0, 255);
      continue;
    }
    if (x >= xs[n - 1]) {
      lut[x] = clamp(Math.round(ys[n - 1]), 0, 255);
      continue;
    }
    let segment = 0;
    while (segment < n - 1 && x > xs[segment + 1]) segment++;
    const h = Math.max(xs[segment + 1] - xs[segment], Number.EPSILON);
    const t = (x - xs[segment]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * ys[segment] +
      (t3 - 2 * t2 + t) * h * tangent[segment] +
      (-2 * t3 + 3 * t2) * ys[segment + 1] +
      (t3 - t2) * h * tangent[segment + 1];
    lut[x] = clamp(Math.round(y), 0, 255);
  }
  return lut;
}

export function getMonotoneCurveTangents(rawPoints) {
  return computeMonotoneCurveTangents(sanitizeCurvePoints(rawPoints));
}

function computeMonotoneCurveTangents(points) {
  const pointCount = points.length;
  if (pointCount === 0) return [];
  if (pointCount === 1) return [0];

  const segmentWidths = new Array(pointCount - 1);
  const slopes = new Array(pointCount - 1);

  for (let index = 0; index < pointCount - 1; index++) {
    const pointA = points[index];
    const pointB = points[index + 1];
    const width = Math.max(pointB.x - pointA.x, Number.EPSILON);
    segmentWidths[index] = width;
    slopes[index] = (pointB.y - pointA.y) / width;
  }

  if (pointCount === 2) return [slopes[0] ?? 0, slopes[0] ?? 0];

  const tangents = new Array(pointCount).fill(0);
  const startWidth = segmentWidths[0];
  const nextWidth = segmentWidths[1];
  const startSlope = slopes[0];
  const nextSlope = slopes[1];
  tangents[0] =
    ((2 * startWidth + nextWidth) * startSlope - startWidth * nextSlope) /
    (startWidth + nextWidth);

  if (tangents[0] * startSlope <= 0) {
    tangents[0] = 0;
  } else if (
    startSlope * nextSlope < 0 &&
    Math.abs(tangents[0]) > Math.abs(startSlope * 3)
  ) {
    tangents[0] = startSlope * 3;
  }

  for (let index = 1; index < pointCount - 1; index++) {
    const previousSlope = slopes[index - 1];
    const nextSegmentSlope = slopes[index];
    if (previousSlope === 0 || nextSegmentSlope === 0) {
      tangents[index] = 0;
      continue;
    }
    if (previousSlope * nextSegmentSlope < 0) {
      tangents[index] = 0;
      continue;
    }

    const previousWidth = segmentWidths[index - 1];
    const nextSegmentWidth = segmentWidths[index];
    const weightA = 2 * nextSegmentWidth + previousWidth;
    const weightB = nextSegmentWidth + 2 * previousWidth;
    tangents[index] =
      (weightA + weightB) /
      (weightA / previousSlope + weightB / nextSegmentSlope);
  }

  const previousWidth = segmentWidths[pointCount - 3];
  const endWidth = segmentWidths[pointCount - 2];
  const previousSlope = slopes[pointCount - 3];
  const endSlope = slopes[pointCount - 2];
  tangents[pointCount - 1] =
    ((2 * endWidth + previousWidth) * endSlope - endWidth * previousSlope) /
    (endWidth + previousWidth);

  const endTangent = tangents[pointCount - 1] ?? 0;
  if (endTangent * endSlope <= 0) {
    tangents[pointCount - 1] = 0;
  } else if (
    endSlope * previousSlope < 0 &&
    Math.abs(endTangent) > Math.abs(endSlope * 3)
  ) {
    tangents[pointCount - 1] = endSlope * 3;
  }

  return tangents;
}

export function buildLegacyCurveLut(lowValue, midValue, highValue) {
  const low = clamp(Number(lowValue ?? 0), 0, 255);
  const mid = clamp(Number(midValue ?? 128), 0, 255);
  const high = clamp(Number(highValue ?? 255), 0, 255);
  const lut = new Uint8ClampedArray(256);

  for (let i = 0; i < 256; i++) {
    const value = i <= 128
      ? low + (mid - low) * (i / 128)
      : mid + (high - mid) * ((i - 128) / 127);
    lut[i] = Math.round(clamp(value, 0, 255));
  }

  return lut;
}

export function sanitizeCurvePoints(rawPoints) {
  const cleaned = [];
  for (const point of Array.isArray(rawPoints) ? rawPoints : []) {
    const x = Math.round(Number(point?.x));
    const y = Math.round(Number(point?.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    cleaned.push({ x: clamp(x, 0, 255), y: clamp(y, 0, 255) });
  }
  cleaned.sort((a, b) => a.x - b.x);

  if (cleaned.length === 0) return identityCurvePoints();

  const merged = [];
  for (const point of cleaned) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.x - point.x) < MIN_CURVE_POINT_GAP) {
      last.y = point.y;
    } else {
      merged.push({ ...point });
    }
  }

  const start = merged[0];
  const end = merged[merged.length - 1];
  const interior = merged
    .filter((point) => point.x > MIN_CURVE_POINT_GAP && point.x < 255 - MIN_CURVE_POINT_GAP)
    .map((point) => ({ ...point }));

  const normalized = [
    {
      x: 0,
      y: start && start.x === 0 ? start.y : 0,
    },
  ];

  for (let index = 0; index < interior.length; index++) {
    const point = interior[index];
    const previousX = normalized[normalized.length - 1].x;
    const nextX = interior[index + 1]?.x ?? 255;
    const x = clamp(point.x, previousX + MIN_CURVE_POINT_GAP, nextX - MIN_CURVE_POINT_GAP);
    if (x > MIN_CURVE_POINT_GAP && x < 255 - MIN_CURVE_POINT_GAP) {
      normalized.push({ x: Math.round(x), y: point.y });
    }
  }

  normalized.push({
    x: 255,
    y: end && end.x === 255 ? end.y : 255,
  });

  return normalized;
}

export function isIdentityCurveLut(lut) {
  for (let i = 0; i < 256; i++) {
    if (lut?.[i] !== i) return false;
  }
  return true;
}

export function areRgbCurvesIdentity(luts) {
  return (
    isIdentityCurveLut(luts?.master) &&
    isIdentityCurveLut(luts?.red) &&
    isIdentityCurveLut(luts?.green) &&
    isIdentityCurveLut(luts?.blue)
  );
}

export function buildFinalRgbCurvesLuts(luts) {
  const identity = buildCurveLut(identityCurvePoints());
  const master = luts?.master ?? identity;
  const red = luts?.red ?? identity;
  const green = luts?.green ?? identity;
  const blue = luts?.blue ?? identity;
  const finalRed = new Uint8ClampedArray(256);
  const finalGreen = new Uint8ClampedArray(256);
  const finalBlue = new Uint8ClampedArray(256);

  for (let i = 0; i < 256; i++) {
    finalRed[i] = red[master[i]];
    finalGreen[i] = green[master[i]];
    finalBlue[i] = blue[master[i]];
  }

  return { red: finalRed, green: finalGreen, blue: finalBlue };
}

export function buildRgbCurvesTextureData(paramsOrLuts) {
  const luts = paramsOrLuts?.master ? paramsOrLuts : buildRgbCurvesLuts(paramsOrLuts);
  const finalLuts = buildFinalRgbCurvesLuts(luts);
  const data = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const offset = i * 4;
    data[offset] = finalLuts.red[i];
    data[offset + 1] = finalLuts.green[i];
    data[offset + 2] = finalLuts.blue[i];
    data[offset + 3] = 255;
  }
  return data;
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}
