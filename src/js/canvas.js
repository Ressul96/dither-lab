// Canvas factory for processing buffers.
//
// `image-ops.js` and `gpu-effects.js` allocate scratch canvases for every
// node output and shader pass; on the main thread those are DOM canvases,
// but on a Worker (F8.4+) they must be OffscreenCanvases. Centralising the
// allocation here lets later phases swap the backing surface without
// touching every caller.
//
// Stage / source / split-overlay canvases are still authored in HTML — they
// stay on the main thread and out of this factory's hands. This helper is
// strictly for processing scratch buffers and the GPU renderer canvas.

export function isWorkerScope() {
  // `document` is only present on the main thread. Worker scopes have `self`
  // and `WorkerGlobalScope` but no `document` — cheapest reliable check.
  return typeof document === "undefined";
}

export function hasOffscreenCanvas() {
  return typeof OffscreenCanvas !== "undefined";
}

export function createProcessingCanvas(width, height) {
  if (isWorkerScope()) {
    // In a Worker context we have no DOM; OffscreenCanvas is the only path.
    // Callers that hit this branch when OffscreenCanvas is missing have
    // bigger problems than a fallback can paper over.
    return new OffscreenCanvas(Math.max(1, width | 0), Math.max(1, height | 0));
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width | 0);
  canvas.height = Math.max(1, height | 0);
  return canvas;
}
