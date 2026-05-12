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

export function isWorkerAvailable() {
  if (workerFailed) return false;
  return typeof Worker !== "undefined";
}

export async function requestWorkerRender({ graph, context, sourceImage }) {
  if (workerFailed) return null;
  ensureWorker();
  if (!worker) return null;

  // Skip preparing a bitmap when there's nothing to send.
  let sourceBitmap = null;
  if (sourceImage) {
    try {
      sourceBitmap = await createImageBitmap(sourceImage);
    } catch (_) {
      sourceBitmap = null;
    }
  }

  // Latest-wins: any in-flight request is now stale. Resolve its caller
  // with null so it can skip its commit, and let the worker's eventual
  // result fall on the floor (onMessage closes the bitmap).
  for (const entry of pending.values()) entry.resolve(null);
  pending.clear();

  const requestId = ++nextRequestId;
  return new Promise((resolve) => {
    pending.set(requestId, { resolve });
    const transfer = sourceBitmap ? [sourceBitmap] : [];
    worker.postMessage(
      { type: "render", requestId, graph, context, sourceBitmap },
      transfer,
    );
  });
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
  if (entry) {
    pending.delete(msg.requestId);
    entry.resolve(msg.error ? null : msg.bitmap ?? null);
  } else if (msg.bitmap) {
    // Discarded request — close the bitmap so the host can free the memory.
    msg.bitmap.close();
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
  for (const entry of pending.values()) entry.resolve(null);
  pending.clear();
}
