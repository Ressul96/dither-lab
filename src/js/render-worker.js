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

function handleRender({ requestId, graph, context, sourceBitmap }) {
  let sourceImage = null;
  if (sourceBitmap) {
    // Copy onto an OffscreenCanvas so the runtime sees the same canvas-like
    // surface it does on the main thread. The bitmap is closed afterwards
    // because evaluateGraphOutputs doesn't need to retain it.
    sourceImage = new OffscreenCanvas(sourceBitmap.width, sourceBitmap.height);
    sourceImage.getContext("2d", { alpha: false }).drawImage(sourceBitmap, 0, 0);
    sourceBitmap.close();
  }

  let bitmap = null;
  let error = null;
  try {
    const { viewerOutput } = evaluateGraphOutputs(graph, {
      ...context,
      sourceImage,
    });
    if (viewerOutput) {
      // Copy the cached output to a throwaway canvas before transferring it.
      // transferToImageBitmap on the cached canvas would detach it from the
      // pool — the worker's nodeCache still holds the reference and would
      // produce a blank frame on the next request.
      const out = new OffscreenCanvas(viewerOutput.width, viewerOutput.height);
      out.getContext("2d", { alpha: false }).drawImage(viewerOutput, 0, 0);
      bitmap = out.transferToImageBitmap();
    }
  } catch (err) {
    error = err?.message ?? String(err);
  }

  const transfer = bitmap ? [bitmap] : [];
  self.postMessage({ type: "result", requestId, bitmap, error }, transfer);
}
