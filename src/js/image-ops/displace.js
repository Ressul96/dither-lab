// Displace — push every output pixel by an offset read from either a
// procedural sine wave (no map input) or a displacement map image.
// The map's R/G channels are treated as signed offsets in [-1, 1]
// (luma mode falls back to a single shaped curve), scaled by the
// user's xAmount/yAmount + global strength.
//
// Source samples use the shared bilinear / nearest helpers from
// sampling.js. The displacement map is bilinear-sampled internally
// (the per-channel walk in sampleDisplaceMapInto is more specialised
// than the channel-by-channel sampling.js helper).
//
// Map layout = how the map image is positioned over the output canvas:
//   stretch — map fills the output (default; no offset/scale)
//   fit / fill — preserve aspect, letterbox or crop
//   tile     — repeat the map at `mapScale`, with offset wrap-around

import { createBuffer, releaseBuffer } from "./buffer-pool.js";
import { clamp } from "./pixel-math.js";
import { sampleBilinearChannel, sampleNearestInto } from "./sampling.js";
import { luminanceBt601 } from "../color.js";
import { buildCurveLut } from "../curve-lut.js";

export function applyDisplaceNode(input, mapInput, params) {
  if (!input?.width || !input?.height) return null;
  const xAmount = Number(params.xAmount ?? 0);
  const yAmount = Number(params.yAmount ?? 0);
  const strength = clamp(Number(params.strength ?? 100) / 100, 0, 4);
  const mode = String(params.mode ?? "wave");
  const mapMode = String(params.mapMode ?? "rg");
  const debugMap = String(params.debugMap ?? "off");
  const filter = params.filter === "nearest" ? "nearest" : "linear";
  const hasDisplacement = (xAmount !== 0 || yAmount !== 0) && strength !== 0;
  if (mode === "map" && (!mapInput?.width || !mapInput?.height)) return input;
  if (!hasDisplacement && debugMap === "off") return input;

  const width = input.width;
  const height = input.height;
  const srcBuf = createBuffer(width, height);
  const srcCtx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  srcCtx.drawImage(input, 0, 0);
  const src = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  let mapData = null;
  let mapWidth = 0;
  let mapHeight = 0;
  let mapCurve = null;
  if (mode === "map" && mapInput?.width && mapInput?.height) {
    mapWidth = mapInput.width;
    mapHeight = mapInput.height;
    const mapBuf = createBuffer(mapWidth, mapHeight);
    const mapCtx = mapBuf.getContext("2d", { alpha: false, willReadFrequently: true });
    mapCtx.drawImage(mapInput, 0, 0);
    mapData = mapCtx.getImageData(0, 0, mapWidth, mapHeight).data;
    releaseBuffer(mapBuf);
    if (mapMode === "luma") mapCurve = buildCurveLut(params.mapCurve);
  }

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  const frequency = Math.max(0.001, Number(params.frequency ?? 4));
  const phase = (Number(params.phase ?? 0) / 180) * Math.PI;
  const mapLayout = mapData
    ? createDisplaceMapLayout(width, height, mapWidth, mapHeight, params)
    : null;
  const mapSample = [0, 0, 0];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let dx;
      let dy;
      let vectorX = 0;
      let vectorY = 0;
      let hasMapSample = false;
      if (mapData) {
        sampleDisplaceMapInto(mapData, mapWidth, mapHeight, x, y, mapLayout, mapSample);
        hasMapSample = true;
        if (mapMode === "luma") {
          const luma = clamp(Math.round(luminanceBt601(mapSample[0], mapSample[1], mapSample[2])), 0, 255);
          const shaped = mapCurve[luma];
          vectorX = (shaped - 128) / 128;
          vectorY = vectorX;
        } else {
          vectorX = (mapSample[0] - 128) / 128;
          vectorY = (mapSample[1] - 128) / 128;
        }
        dx = vectorX * xAmount * strength;
        dy = vectorY * yAmount * strength;
      } else {
        dx = Math.sin((y / height) * frequency * Math.PI * 2 + phase) * xAmount * strength;
        dy = Math.sin((x / width) * frequency * Math.PI * 2 + phase) * yAmount * strength;
      }

      if (hasMapSample && debugMap !== "off") {
        if (debugMap === "vectors") {
          out[i] = clamp(Math.round(128 + vectorX * 127), 0, 255);
          out[i + 1] = clamp(Math.round(128 + vectorY * 127), 0, 255);
          out[i + 2] = 128;
        } else if (mapMode === "luma") {
          const luma = clamp(Math.round(luminanceBt601(mapSample[0], mapSample[1], mapSample[2])), 0, 255);
          const shaped = mapCurve[luma];
          out[i] = shaped;
          out[i + 1] = shaped;
          out[i + 2] = shaped;
        } else {
          out[i] = mapSample[0];
          out[i + 1] = mapSample[1];
          out[i + 2] = mapSample[2];
        }
        out[i + 3] = 255;
        continue;
      }

      const sx = x - dx;
      const sy = y - dy;
      if (filter === "nearest") {
        sampleNearestInto(src, width, height, sx, sy, out, i);
      } else {
        out[i] = sampleBilinearChannel(src, width, height, sx, sy, 0);
        out[i + 1] = sampleBilinearChannel(src, width, height, sx, sy, 1);
        out[i + 2] = sampleBilinearChannel(src, width, height, sx, sy, 2);
        out[i + 3] = 255;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Computes how to position the map image over the output canvas based
// on the user's `mapFit` choice. Returns a small descriptor consumed
// by mapSamplePositionInto below — one lookup per pixel instead of
// re-deriving the layout for every sample.
function createDisplaceMapLayout(width, height, mapWidth, mapHeight, params) {
  const fit = String(params.mapFit ?? "stretch");
  const offsetX = Number(params.mapOffsetX ?? 0) / 100;
  const offsetY = Number(params.mapOffsetY ?? 0) / 100;
  if (fit === "tile") {
    const mapScale = clamp(Number(params.mapScale ?? 100) / 100, 0.1, 8);
    const tileW = Math.max(1, mapWidth * mapScale);
    const tileH = Math.max(1, mapHeight * mapScale);
    return {
      fit,
      tileW,
      tileH,
      offsetX: offsetX * tileW,
      offsetY: offsetY * tileH,
    };
  }

  if (fit === "fit" || fit === "fill") {
    const scale = fit === "fit"
      ? Math.min(width / Math.max(1, mapWidth), height / Math.max(1, mapHeight))
      : Math.max(width / Math.max(1, mapWidth), height / Math.max(1, mapHeight));
    const drawW = mapWidth * scale;
    const drawH = mapHeight * scale;
    return {
      fit,
      scale,
      offsetX: (width - drawW) / 2 + offsetX * width,
      offsetY: (height - drawH) / 2 + offsetY * height,
    };
  }

  return { fit: "stretch", outputWidth: width, outputHeight: height };
}

// Bilinear-sample the displacement map at (x, y), writing the
// resulting RGB triple into target[0..2]. Walks each channel
// independently because the per-channel inner products differ from
// the single-channel sampling.js helper (which is for diffusing one
// channel through a kernel).
function sampleDisplaceMapInto(data, width, height, x, y, layout, target) {
  mapSamplePositionInto(width, height, x, y, layout, target);
  const x0 = Math.floor(target[0]);
  const y0 = Math.floor(target[1]);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = target[0] - x0;
  const fy = target[1] - y0;

  for (let channel = 0; channel < 3; channel++) {
    const i00 = (y0 * width + x0) * 4 + channel;
    const i10 = (y0 * width + x1) * 4 + channel;
    const i01 = (y1 * width + x0) * 4 + channel;
    const i11 = (y1 * width + x1) * 4 + channel;
    const top = data[i00] * (1 - fx) + data[i10] * fx;
    const bottom = data[i01] * (1 - fx) + data[i11] * fx;
    target[channel] = Math.round(top * (1 - fy) + bottom * fy);
  }
}

// Translate the output-canvas coordinate (x, y) into a map-pixel
// coordinate based on the layout descriptor. Writes target[0..1].
function mapSamplePositionInto(mapWidth, mapHeight, x, y, layout, target) {
  if (layout.fit === "tile") {
    const u = positiveModulo((x - layout.offsetX) / Math.max(1, layout.tileW), 1);
    const v = positiveModulo((y - layout.offsetY) / Math.max(1, layout.tileH), 1);
    target[0] = u * Math.max(0, mapWidth - 1);
    target[1] = v * Math.max(0, mapHeight - 1);
    return;
  }

  if (layout.fit === "fit" || layout.fit === "fill") {
    target[0] = clamp((x - layout.offsetX) / Math.max(0.0001, layout.scale), 0, Math.max(0, mapWidth - 1));
    target[1] = clamp((y - layout.offsetY) / Math.max(0.0001, layout.scale), 0, Math.max(0, mapHeight - 1));
    return;
  }

  target[0] = mapWidth <= 1 ? 0 : (x / Math.max(1, (layout.outputWidth ?? 1) - 1)) * (mapWidth - 1);
  target[1] = mapHeight <= 1 ? 0 : (y / Math.max(1, (layout.outputHeight ?? 1) - 1)) * (mapHeight - 1);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
