// Canvas buffer pool for the image-ops effect pipeline.
//
// Effect nodes allocate intermediate canvases on every evaluate — without
// pooling, a single playback frame can burn through dozens of throwaway
// OffscreenCanvases and trip a measurable GC pause. The pool keeps a
// small per-shape (width × height) stack of canvases so a follow-up
// frame at the same resolution reuses them.
//
// `acquireBuffer` returns a freshly cleared canvas; `releaseBuffer`
// hands it back to the pool with a per-shape cap so an unbounded sequence
// of dimension changes (e.g. user resizes during playback) cannot grow
// memory without bound. `createBuffer` is the internal alias used by
// effect implementations that want a writable buffer without thinking
// about the pool.
//
// External consumers import these symbols from `../image-ops.js` for
// backward compatibility (see the re-export at the top of that file).

import { createProcessingCanvas } from "../canvas.js";

const bufferPool = new Map();
const POOL_LIMIT_PER_SHAPE = 8;

export function acquireBuffer(width, height) {
  const key = `${width}x${height}`;
  const stack = bufferPool.get(key);
  if (stack && stack.length > 0) {
    const reused = stack.pop();
    const ctx = reused.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      // OffscreenCanvas 2D context exposes the same drawing surface API, but
      // `filter` is not in the spec — guard the assignment so a Worker host
      // that doesn't implement it doesn't throw.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if ("filter" in ctx) ctx.filter = "none";
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, width, height);
    }
    return reused;
  }
  // Route fresh allocations through the canvas factory so a future Worker
  // host transparently gets OffscreenCanvas; on the main thread this still
  // returns a DOM canvas, identical to the old `document.createElement` path.
  return createProcessingCanvas(width, height);
}

export function releaseBuffer(canvas) {
  if (!canvas?.width || !canvas?.height) return;
  const key = `${canvas.width}x${canvas.height}`;
  let stack = bufferPool.get(key);
  if (!stack) {
    stack = [];
    bufferPool.set(key, stack);
  }
  if (stack.length < POOL_LIMIT_PER_SHAPE) stack.push(canvas);
}

// Internal alias kept for call-site readability inside image-ops modules:
// `createBuffer(w, h)` reads as "I need a fresh writable canvas" whereas
// `acquireBuffer` carries the implementation detail that there's a pool.
export function createBuffer(width, height) {
  return acquireBuffer(width, height);
}
