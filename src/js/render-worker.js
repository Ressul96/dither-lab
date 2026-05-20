// Dedicated Worker entry for off-main-thread graph evaluation.
//
// The worker never touches the DOM or the main-thread state store. Every
// render request carries its own serialised graph snapshot, timeline
// context, and source bitmap. The result comes back as a transferable
// ImageBitmap so the main thread can drawImage it onto the viewer canvas
// in one frame.
//
// GPU shader passes still fall back to CPU here because gpu-effects.js
// short-circuits when `typeof document === "undefined"` (F8.3 guard); a
// later phase will swap the WebGL2 renderer for an OffscreenCanvas one
// and lift that guard. ASCII / fonts also stay on the main thread until
// the atlas-as-ImageBitmap path lands.

import { clearGraphCache, evaluateGraphOutputs } from "./graph-runtime.js";

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "render") handleRender(msg);
  else if (msg.type === "clearCache") clearGraphCache();
});

self.addEventListener("messageerror", (event) => {
  console.warn("[render-worker] messageerror", event);
});

function handleRender({ requestId, graph, context, sourceBitmap }) {
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
