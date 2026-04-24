export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function luminance8(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function quantizeBW(value, threshold, invert) {
  const mono = value >= threshold ? 255 : 0;
  return invert ? 255 - mono : mono;
}

export function writeMonochrome(data, offset, value) {
  data[offset] = value;
  data[offset + 1] = value;
  data[offset + 2] = value;
  data[offset + 3] = 255;
}

export function readLuminance(data, width, height) {
  const values = new Float32Array(width * height);
  for (let index = 0; index < values.length; index++) {
    const offset = index * 4;
    values[index] = luminance8(data[offset], data[offset + 1], data[offset + 2]);
  }
  return values;
}

export function writeValuesMonochrome(data, values) {
  for (let index = 0; index < values.length; index++) {
    const offset = index * 4;
    writeMonochrome(data, offset, clamp(Math.round(values[index]), 0, 255));
  }
}

export function readRGB(data, width, height) {
  const total = width * height;
  const r = new Float32Array(total);
  const g = new Float32Array(total);
  const b = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const offset = i * 4;
    r[i] = data[offset];
    g[i] = data[offset + 1];
    b[i] = data[offset + 2];
  }
  return { r, g, b };
}

export function writeRGB(data, r, g, b) {
  for (let i = 0; i < r.length; i++) {
    const offset = i * 4;
    data[offset] = clamp(Math.round(r[i]), 0, 255);
    data[offset + 1] = clamp(Math.round(g[i]), 0, 255);
    data[offset + 2] = clamp(Math.round(b[i]), 0, 255);
    data[offset + 3] = 255;
  }
}

export function writePixel(data, offset, r, g, b) {
  data[offset] = r;
  data[offset + 1] = g;
  data[offset + 2] = b;
  data[offset + 3] = 255;
}

export function preAdjustRGB(r, g, b, threshold, invert) {
  const shift = threshold - 128;
  let nr = clamp(r + shift, 0, 255);
  let ng = clamp(g + shift, 0, 255);
  let nb = clamp(b + shift, 0, 255);
  if (invert) {
    nr = 255 - nr;
    ng = 255 - ng;
    nb = 255 - nb;
  }
  return [nr, ng, nb];
}

export function isMonochromePalette(palette) {
  return !palette || palette.id === "monochrome";
}
