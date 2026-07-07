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
let latestRequestToken = 0;
// Set once the worker reports it cannot render a GPU-effect graph (no WebGL2 in
// its scope). The host then keeps GPU-effect graphs on the main thread instead
// of paying a doomed worker round-trip per frame.
let workerGpuUnsupported = false;
let latestCustomPalettes = [];
const pending = new Map();
const WORKER_RENDER_FALLBACK = Object.freeze({ fallbackToMainThread: true });
const WORKER_RENDER_TIMEOUT_MS = 5000;

export function isWorkerAvailable() {
  if (workerFailed) return false;
  return typeof Worker !== "undefined";
}

// True once the worker has reported (via fallbackToMainThread) that it cannot
// build a WebGL2 renderer for GPU effects. Callers route GPU-effect graphs to
// the main thread when this holds, avoiding a wasted worker round-trip.
export function workerKnownGpuUnsupported() {
  return workerGpuUnsupported;
}

export async function requestWorkerRender({ graph, context, sourceImage }) {
  if (workerFailed) return WORKER_RENDER_FALLBACK;
  ensureWorker();
  if (!worker) return WORKER_RENDER_FALLBACK;
  const requestToken = ++latestRequestToken;

  // Latest-wins: any in-flight request is now stale, even while this request
  // prepares its source bitmap. Resolve the older caller with null so it can
  // skip commit, and let the worker's eventual response be discarded.
  for (const entry of pending.values()) resolvePending(entry, null);
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
    if (requestToken !== latestRequestToken) {
      try {
        sourceBitmap.close();
      } catch (_) {}
      return null;
    }
  }

  const requestId = ++nextRequestId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      console.warn("[render-adapter] worker render timed out, falling back");
      resolvePending(entry, WORKER_RENDER_FALLBACK);
      failWorker();
    }, WORKER_RENDER_TIMEOUT_MS);
    pending.set(requestId, { resolve, timer });
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
      resolvePending({ resolve, timer }, WORKER_RENDER_FALLBACK);
    }
  });
}

function resolvePending(entry, value) {
  if (entry?.timer) clearTimeout(entry.timer);
  entry?.resolve(value);
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
  try {
    worker.postMessage({ type: "clearCache" });
  } catch (err) {
    console.warn("[render-adapter] worker cache clear failed:", err);
    failWorker();
  }
}

export function syncWorkerPalettes(entries) {
  latestCustomPalettes = Array.isArray(entries) ? entries : [];
  if (!worker) return;
  try {
    worker.postMessage({ type: "syncPalettes", entries: latestCustomPalettes });
  } catch (err) {
    console.warn("[render-adapter] worker palette sync failed:", err);
    failWorker();
  }
}

export function teardownWorker() {
  if (worker) {
    try {
      worker.terminate();
    } catch (_) {}
  }
  for (const entry of pending.values()) resolvePending(entry, null);
  pending.clear();
  worker = null;
  workerFailed = false;
  workerGpuUnsupported = false;
  nextRequestId = 0;
  latestRequestToken++;
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
    worker.postMessage({ type: "syncPalettes", entries: latestCustomPalettes });
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
    if (msg.fallbackToMainThread) {
      // Keep GPU-effect graphs off the worker only after a real WebGL2 probe
      // failure. Other fallbacks (ASCII/font parity) are per-graph decisions.
      if (msg.fallbackReason === "gpuUnsupported" || !msg.fallbackReason) {
        workerGpuUnsupported = true;
      }
      closeResultBitmaps(payload);
      resolvePending(entry, WORKER_RENDER_FALLBACK);
      return;
    }
    if (msg.error) {
      closeResultBitmaps(payload);
      console.warn("[render-adapter] worker render failed, falling back:", msg.error);
      resolvePending(entry, WORKER_RENDER_FALLBACK);
      return;
    }
    resolvePending(entry, payload);
  } else {
    // Discarded request — close any bitmaps so the host can free the memory.
    closeResultBitmaps(payload);
  }
}

function onWorkerError(err) {
  console.warn("[render-adapter] worker errored, falling back:", err);
  failWorker();
}

function failWorker() {
  workerFailed = true;
  if (worker) {
    try {
      worker.terminate();
    } catch (_) {}
    worker = null;
  }
  for (const entry of pending.values()) resolvePending(entry, WORKER_RENDER_FALLBACK);
  pending.clear();
}
