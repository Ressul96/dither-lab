const RGB_CURVE_CHANNELS = ["master", "red", "green", "blue"];
const APPLY_MODES = ["normal", "luma", "color"];

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
  const dx = new Array(n - 1);
  const dy = new Array(n - 1);
  const slope = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    dy[i] = ys[i + 1] - ys[i];
    slope[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
  }

  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }

  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const scale = 3 / Math.sqrt(h);
      tangent[i] = scale * a * slope[i];
      tangent[i + 1] = scale * b * slope[i];
    }
  }

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
    const h = dx[segment];
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

  const unique = [];
  for (const point of cleaned) {
    const last = unique[unique.length - 1];
    if (last && last.x === point.x) {
      last.y = Math.round((last.y + point.y) / 2);
    } else {
      unique.push({ ...point });
    }
  }
  return unique;
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
