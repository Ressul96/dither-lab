// Dedicated Worker entry for off-main-thread graph evaluation.
//
// The worker never touches the DOM or the main-thread state store. Every
// render request carries its own serialised graph snapshot, timeline
// context, and source bitmap. The result comes back as a transferable
// ImageBitmap so the main thread can drawImage it onto the viewer canvas
// in one frame.
//
// GPU shader passes need a WebGL2 renderer in this scope; if unavailable, the
// host reroutes the request to the main thread. ASCII / fonts stay on the main
// thread until the atlas-as-ImageBitmap path lands.

import {
  clearGraphCache,
  evaluateGraphOutputs,
  graphContainsGpuEffect,
  graphRequiresMainThreadRender,
} from "./graph-runtime.js";
import { isGpuRendererAvailable } from "./gpu-effects.js";
import { applyCustomPalettes } from "./palettes.js";

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "render") handleRender(msg);
  else if (msg.type === "clearCache") clearGraphCache();
  else if (msg.type === "syncPalettes") {
    applyCustomPalettes(msg.entries ?? []);
    clearGraphCache();
  }
});

self.addEventListener("messageerror", (event) => {
  console.warn("[render-worker] messageerror", event);
});

function handleRender({ requestId, graph, context, sourceBitmap }) {
  if (graphRequiresMainThreadRender(graph)) {
    if (sourceBitmap) {
      try {
        sourceBitmap.close();
      } catch (_) {}
    }
    self.postMessage({
      type: "result",
      requestId,
      fallbackToMainThread: true,
      fallbackReason: "mainThreadOnly",
    });
    return;
  }

  // A graph with GPU-only stylize nodes needs a WebGL2 renderer. If this worker
  // scope can't create one (no OffscreenCanvas WebGL2 — e.g. some WebViews),
  // those effects would silently pass through and the result wouldn't match a
  // main-thread export. Bail so the host re-renders on the main thread.
  if (graphContainsGpuEffect(graph) && !isGpuRendererAvailable()) {
    if (sourceBitmap) {
      try {
        sourceBitmap.close();
      } catch (_) {}
    }
    self.postMessage({
      type: "result",
      requestId,
      fallbackToMainThread: true,
      fallbackReason: "gpuUnsupported",
    });
    return;
  }

  let sourceImage = null;
  let viewerBitmap = null;
  let ditherBitmap = null;
  let error = null;
  try {
    if (sourceBitmap) {
      // Copy onto an OffscreenCanvas so the runtime sees the same canvas-like
      // surface it does on the main thread.
      sourceImage = new OffscreenCanvas(sourceBitmap.width, sourceBitmap.height);
      const sourceContext = sourceImage.getContext("2d", { alpha: false });
      if (!sourceContext) throw new Error("worker could not create source 2D context");
      sourceContext.drawImage(sourceBitmap, 0, 0);
    }
    const outputs = evaluateGraphOutputs(graph, {
      ...context,
      sourceImage,
    });
    viewerBitmap = transferCanvasOutput(outputs?.viewerOutput);
    ditherBitmap = transferCanvasOutput(outputs?.ditherOutput);
  } catch (err) {
    error = err?.message ?? String(err);
  } finally {
    if (sourceBitmap) {
      try {
        sourceBitmap.close();
      } catch (_) {}
    }
  }

  const transfer = [];
  if (viewerBitmap) transfer.push(viewerBitmap);
  if (ditherBitmap) transfer.push(ditherBitmap);
  self.postMessage(
    { type: "result", requestId, viewerBitmap, ditherBitmap, error },
    transfer
  );
}

// Copy the cached output to a throwaway canvas before transferring it.
// transferToImageBitmap on the cached canvas would detach it from the pool —
// the worker's nodeCache still holds the reference and the next request
// would produce a blank frame.
function transferCanvasOutput(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  out.getContext("2d", { alpha: false }).drawImage(canvas, 0, 0);
  return out.transferToImageBitmap();
}
