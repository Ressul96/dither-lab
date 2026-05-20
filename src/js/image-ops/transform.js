// Affine transform + raster resize nodes: pixelate (GPU + CPU fallback),
// scale (resize within a fixed canvas), transform (translate/rotate/
// scale/flip with optional crop). All three keep the output canvas at
// the input dimensions so downstream nodes see a consistent frame size.
//
// Dependency note: pixelate's GPU path lives in gpu-effects.js; this
// module keeps the CPU fallback close to the orchestration entry point
// so reading either path doesn't require chasing across files.

import { createBuffer, releaseBuffer } from "./buffer-pool.js";
import { clamp, mixByte, smoothstep } from "./pixel-math.js";
import { applyPixelateGpu } from "../gpu-effects.js";

// Pixelate — block-average downsample then nearest-neighbour upsample,
// with optional circular cell mask + edge smoothing for non-grid looks.
// GPU path covers the embarrassingly-parallel default; CPU fallback
// retains feature parity for headless / WebGL2-disabled environments.
export function applyPixelateNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const sizeX = clamp(Math.round(Number(params.size ?? 8)), 1, 256);
  const rawY = Number(params.sizeY ?? 0);
  const sizeY = rawY > 0 ? clamp(Math.round(rawY), 1, 256) : sizeX;
  if (sizeX <= 1 && sizeY <= 1) return input;
  const gpuOutput = applyPixelateGpu(input, params);
  if (gpuOutput) return gpuOutput;
  return applyPixelateCpu(input, params, sizeX, sizeY);
}

function applyPixelateCpu(input, params, sizeX, sizeY) {
  const width = input.width;
  const height = input.height;

  const blockW = Math.max(1, Math.floor(width / sizeX));
  const blockH = Math.max(1, Math.floor(height / sizeY));
  const small = createBuffer(blockW, blockH);
  const smallCtx = small.getContext("2d", { alpha: false, willReadFrequently: false });
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(input, 0, 0, blockW, blockH);

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, blockW, blockH, 0, 0, width, height);
  releaseBuffer(small);

  const shape = String(params.shape ?? "square").toLowerCase();
  const smoothing = clamp(Number(params.smoothing ?? 0) / 100, 0, 1);
  const opacity = clamp(Number(params.opacity ?? 100) / 100, 0, 1);
  if (shape !== "circle" && smoothing <= 0.001 && opacity >= 0.999) {
    return output;
  }

  const srcBuf = createBuffer(width, height);
  const srcCtx = srcBuf.getContext("2d", { alpha: false, willReadFrequently: true });
  srcCtx.drawImage(input, 0, 0);
  const src = srcCtx.getImageData(0, 0, width, height).data;
  releaseBuffer(srcBuf);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      let mask = 1;
      const localX = ((x + 0.5) % sizeX) / sizeX;
      const localY = ((y + 0.5) % sizeY) / sizeY;

      if (shape === "circle") {
        const dist = Math.hypot((localX - 0.5) * 2, (localY - 0.5) * 2);
        const aa = Math.max(smoothing * 0.6 + 0.05, 0.05);
        mask = 1 - smoothstep(1 - aa, 1, dist);
        data[index] *= mask;
        data[index + 1] *= mask;
        data[index + 2] *= mask;
      } else if (smoothing > 0.001) {
        const minEdge = Math.min(localX, 1 - localX, localY, 1 - localY);
        const edgeMask = smoothstep(0, smoothing * 0.5 + 0.001, minEdge);
        data[index] *= 0.6 + edgeMask * 0.4;
        data[index + 1] *= 0.6 + edgeMask * 0.4;
        data[index + 2] *= 0.6 + edgeMask * 0.4;
      }

      data[index] = mixByte(src[index], data[index], opacity);
      data[index + 1] = mixByte(src[index + 1], data[index + 1], opacity);
      data[index + 2] = mixByte(src[index + 2], data[index + 2], opacity);
      data[index + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return output;
}

// Scale — resize the image content inside a canvas of the original size, so
// the change is actually visible to downstream nodes (the previous version
// resized the output canvas itself and commitProcessedFrame stretched the
// result back, hiding the effect entirely). Scale > 100% crops outwards;
// Scale < 100% leaves a black border around the centred shrunk image. Pair
// it with Pixelate or downstream Dither to get retro pixel-art workflows.
export function applyScaleNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const xPct = clamp(Number(params.x ?? 100), 10, 400) / 100;
  const yPct = clamp(Number(params.y ?? 100), 10, 400) / 100;
  const filter = params.filter === "nearest" ? false : true;
  if (xPct === 1 && yPct === 1) return input;

  const width = input.width;
  const height = input.height;
  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = filter;

  const newW = Math.max(1, Math.round(width * xPct));
  const newH = Math.max(1, Math.round(height * yPct));
  const dx = Math.round((width - newW) / 2);
  const dy = Math.round((height - newH) / 2);
  ctx.drawImage(input, 0, 0, width, height, dx, dy, newW, newH);
  return output;
}

// Transform — translate/rotate/scale/flip with an optional pre-crop step.
// The crop pass uses the same mask/fit semantics as the standalone Crop
// node (image-ops/geometry.js); keeping it inline here avoids an extra
// pass through Crop when a transform-crop combination is the common case.
export function applyTransformNode(input, params) {
  if (!input?.width || !input?.height) return null;
  const translateX = Number(params.translateX ?? 0);
  const translateY = Number(params.translateY ?? 0);
  const rotation = Number(params.rotation ?? 0);
  const scaleParam = params.scale !== undefined ? Number(params.scale) : null;
  const scaleX = clamp(Number(scaleParam ?? params.x ?? 100) / 100, 0.01, 10);
  const scaleY = clamp(Number(scaleParam ?? params.y ?? 100) / 100, 0.01, 10);
  const horizontal = Boolean(params.horizontal);
  const vertical = Boolean(params.vertical);
  const left = clamp(Number(params.left ?? 0), 0, 95);
  const right = clamp(Number(params.right ?? 0), 0, 95);
  const top = clamp(Number(params.top ?? 0), 0, 95);
  const bottom = clamp(Number(params.bottom ?? 0), 0, 95);
  const cropMode = String(params.cropMode ?? params.mode ?? "mask");
  const filter = params.filter === "nearest" ? false : true;
  const hasCrop = left !== 0 || right !== 0 || top !== 0 || bottom !== 0;
  const identity =
    translateX === 0 &&
    translateY === 0 &&
    rotation === 0 &&
    scaleX === 1 &&
    scaleY === 1 &&
    !horizontal &&
    !vertical &&
    !hasCrop;
  if (identity) return input;

  const width = input.width;
  const height = input.height;
  let source = input;
  if (hasCrop) {
    source = createBuffer(width, height);
    const cropCtx = source.getContext("2d", { alpha: false, willReadFrequently: false });
    cropCtx.fillStyle = "#000";
    cropCtx.fillRect(0, 0, width, height);
    const sx = Math.round((left / 100) * width);
    const sy = Math.round((top / 100) * height);
    const sw = Math.max(1, Math.round(width - sx - (right / 100) * width));
    const sh = Math.max(1, Math.round(height - sy - (bottom / 100) * height));
    cropCtx.imageSmoothingEnabled = filter;
    if (cropMode === "fit") {
      cropCtx.drawImage(input, sx, sy, sw, sh, 0, 0, width, height);
    } else {
      cropCtx.drawImage(input, sx, sy, sw, sh, sx, sy, sw, sh);
    }
  }

  const output = createBuffer(width, height);
  const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = filter;
  ctx.save();
  ctx.translate(width / 2 + (translateX / 100) * width, height / 2 + (translateY / 100) * height);
  ctx.rotate((rotation / 180) * Math.PI);
  ctx.scale(horizontal ? -scaleX : scaleX, vertical ? -scaleY : scaleY);
  ctx.drawImage(source, -width / 2, -height / 2, width, height);
  ctx.restore();
  if (source !== input) releaseBuffer(source);
  return output;
}
