// Main-thread adapter for the render worker.
//
// Lazily creates a single Dedicated Worker, ferries graph snapshots over,
// and resolves the caller with a transferable ImageBitmap (or null when
// the worker isn't available / a newer request supersedes it).
//
// Backpressure policy: the latest request wins. When a new request arrives
// while another is in flight, the older pending promise resolves with null
// and its eventual worker response is discarded. This matches the spec's
// "preview wants low latency + stale discard" intent — the caller never
// commits an out-of-date frame to the viewer canvas.

let worker = null;
let workerFailed = false;
let nextRequestId = 0;
const pending = new Map();
const WORKER_RENDER_FALLBACK = Object.freeze({ fallbackToMainThread: true });

export function isWorkerAvailable() {
  if (workerFailed) return false;
  return typeof Worker !== "undefined";
}

export async function requestWorkerRender({ graph, context, sourceImage }) {
  if (workerFailed) return WORKER_RENDER_FALLBACK;
  ensureWorker();
  if (!worker) return WORKER_RENDER_FALLBACK;

  // Latest-wins: any in-flight request is now stale, even while this request
  // prepares its source bitmap. Resolve the older caller with null so it can
  // skip commit, and let the worker's eventual response be discarded.
  for (const entry of pending.values()) entry.resolve(null);
  pending.clear();

  // Skip preparing a bitmap when there's nothing to send.
  let sourceBitmap = null;
  if (sourceImage) {
    try {
      sourceBitmap = await createImageBitmap(sourceImage);
    } catch (err) {
      console.warn("[render-adapter] source bitmap prepare failed, falling back:", err);
      return WORKER_RENDER_FALLBACK;
    }
  }

  const requestId = ++nextRequestId;
  return new Promise((resolve) => {
    pending.set(requestId, { resolve });
    const transfer = sourceBitmap ? [sourceBitmap] : [];
    try {
      worker.postMessage({ type: "render", requestId, graph, context, sourceBitmap }, transfer);
    } catch (err) {
      pending.delete(requestId);
      if (sourceBitmap) {
        try {
          sourceBitmap.close();
        } catch (_) {}
      }
      console.warn("[render-adapter] worker post failed, falling back:", err);
      resolve(WORKER_RENDER_FALLBACK);
    }
  });
}

function closeResultBitmaps(payload) {
  if (payload?.viewerBitmap) {
    try { payload.viewerBitmap.close(); } catch (_) {}
  }
  if (payload?.ditherBitmap) {
    try { payload.ditherBitmap.close(); } catch (_) {}
  }
}

export function clearWorkerCache() {
  if (!worker) return;
  worker.postMessage({ type: "clearCache" });
}

export function teardownWorker() {
  if (!worker) return;
  try {
    worker.terminate();
  } catch (_) {}
  for (const entry of pending.values()) entry.resolve(null);
  pending.clear();
  worker = null;
  workerFailed = false;
  nextRequestId = 0;
}

function ensureWorker() {
  if (worker || workerFailed) return;
  if (typeof Worker === "undefined") {
    workerFailed = true;
    return;
  }
  try {
    worker = new Worker(new URL("./render-worker.js", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", onWorkerMessage);
    worker.addEventListener("error", onWorkerError);
    worker.addEventListener("messageerror", onWorkerError);
  } catch (err) {
    console.warn("[render-adapter] worker create failed:", err);
    workerFailed = true;
    worker = null;
  }
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (msg?.type !== "result") return;
  const entry = pending.get(msg.requestId);
  const payload = {
    viewerBitmap: msg.viewerBitmap ?? null,
    ditherBitmap: msg.ditherBitmap ?? null,
  };
  if (entry) {
    pending.delete(msg.requestId);
    if (msg.error) {
      closeResultBitmaps(payload);
      console.warn("[render-adapter] worker render failed, falling back:", msg.error);
      entry.resolve(WORKER_RENDER_FALLBACK);
      return;
    }
    entry.resolve(payload);
  } else {
    // Discarded request — close any bitmaps so the host can free the memory.
    closeResultBitmaps(payload);
  }
}

function onWorkerError(err) {
  console.warn("[render-adapter] worker errored, falling back:", err);
  workerFailed = true;
  if (worker) {
    try {
      worker.terminate();
    } catch (_) {}
    worker = null;
  }
  for (const entry of pending.values()) entry.resolve(WORKER_RENDER_FALLBACK);
  pending.clear();
}
