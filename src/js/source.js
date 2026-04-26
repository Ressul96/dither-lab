import { getState, dispatch, subscribe } from "./state.js";
import { ensureBootGraph, setViewerOutputFps } from "./graph.js";
import { evaluateGraphOutputs } from "./graph-runtime.js";
import { canUseNativeRender, evaluateNativeGraphOutputs } from "./native-render.js";

const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "m4v", "mkv", "avi"];
const SIDE_BY_SIDE_GAP = 24;
const PREVIEW_BG = "#0f0f12";
const PLAYBACK_LOOP_EPSILON = 1 / 120;

let video;
let canvas;
let ctx;
let splitCanvas;
let splitCtx;
let sourceCanvas;
let sourceCtx;
let processedCanvas;
let processedCtx;
let ditherCanvas;
let ditherCtx;
let sampleLayout = null;
let rafId = 0;
let eventsWired = false;
let previewSubscriptionsWired = false;
let sourceDropWired = false;
let hasDitherOutput = false;
let playbackSyncSuspended = false;
let pendingPlayPromise = null;
let playRequestToken = 0;
let renderVersion = 0;
let sourceToken = 0;
let nativeRenderInFlight = false;
let exportSessionActive = false;

export function initSource() {
  wireSourceDropTarget();
  if (previewSubscriptionsWired) return;
  previewSubscriptionsWired = true;

  subscribe("view", () => presentPreview());
  subscribe("graph", () => renderCurrentFrame());
}

export async function openSource() {
  const tauri = window.__TAURI__;
  if (!tauri) return;

  let selected;
  try {
    selected = await tauri.dialog.open({
      title: "Open Source",
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
  } catch (err) {
    console.error("[open-source] dialog failed", err);
    return;
  }
  if (!selected) return;

  const path = typeof selected === "string" ? selected : selected.path;
  await openSourcePath(path);
}

export async function openSourcePath(path, options = {}) {
  const tauri = window.__TAURI__;
  if (!tauri || !path) return;
  const src = tauri.core.convertFileSrc(path);
  await loadVideo(src, path, options);
}

async function loadVideo(src, path, options = {}) {
  const { autoplay = false } = options;
  const { video: v, canvas: outputCanvas, splitCanvas: outputSplitCanvas } = ensureEls();
  stopDrawLoop();
  disablePlayerControls();
  sourceToken += 1;
  try {
    v.pause();
  } catch {}

  v.loop = false;
  v.src = src;
  v.load();

  try {
    await waitFor(v, "loadeddata");
  } catch (err) {
    console.error("[open-source] video load failed", err);
    clearSource();
    return;
  }

  ensureFrameBuffers(v.videoWidth, v.videoHeight);
  outputCanvas?.classList.remove("hidden");
  outputSplitCanvas?.classList.remove("hidden");
  document.getElementById("emptyState")?.classList.add("hidden");

  populateReadout(v, path);
  wireVideoEvents(v);
  ensureBootGraph();

  const sourceFps = await detectSourceFps(v);
  dispatch("source", {
    loaded: true,
    path,
    duration: v.duration,
    sourceFps,
    fps: sourceFps,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
  });
  syncVideoPlaybackRate(v, sourceFps, sourceFps);
  setViewerOutputFps(sourceFps);
  dispatch("playback", {
    playing: false,
    currentTime: 0,
    trimStart: 0,
    trimEnd: v.duration,
    loopEnabled: true,
  });

  enablePlayerControls();
  syncPlaybackState(v, {
    playing: false,
    currentTime: 0,
    trimStart: 0,
    trimEnd: v.duration,
    loopEnabled: true,
  });
  renderCurrentFrame();
  if (autoplay) {
    await startPlayback(v, { forceRestart: true });
  }
}

export function clearSource() {
  const {
    video: v,
    canvas: outputCanvas,
    splitCanvas: outputSplitCanvas,
    sourceCanvas: sourceBuffer,
    processedCanvas: processedBuffer,
    ditherCanvas: ditherBuffer,
  } = ensureEls();

  stopDrawLoop();
  renderVersion += 1;
  sourceToken += 1;
  playRequestToken += 1;
  pendingPlayPromise = null;
  hasDitherOutput = false;
  sampleLayout = null;

  if (v) {
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch {}
  }

  for (const buffer of [sourceBuffer, processedBuffer, ditherBuffer]) {
    if (!buffer) continue;
    buffer.width = 0;
    buffer.height = 0;
  }

  clearCanvas(ctx, outputCanvas);
  clearSplitCanvas();
  outputCanvas?.classList.add("hidden");
  outputSplitCanvas?.classList.add("hidden");
  document.getElementById("emptyState")?.classList.remove("hidden");
  document.title = "Dither Lab";

  dispatch("source", {
    loaded: false,
    path: "",
    duration: 0,
    sourceFps: 30,
    fps: 30,
    videoWidth: 0,
    videoHeight: 0,
  });
  dispatch("playback", {
    playing: false,
    currentTime: 0,
    trimStart: 0,
    trimEnd: 0,
    loopEnabled: true,
  });
  disablePlayerControls();
}

function wireSourceDropTarget() {
  if (sourceDropWired) return;

  const stageCanvas = document.querySelector(".stage-canvas");
  const dropzone = document.getElementById("stageDropzone");
  if (!stageCanvas || !dropzone) return;
  sourceDropWired = true;

  const showDropzone = (on) => dropzone.classList.toggle("hidden", !on);
  const isInsideStage = (position) => {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return true;
    const rect = stageCanvas.getBoundingClientRect();
    return (
      position.x >= rect.left &&
      position.x <= rect.right &&
      position.y >= rect.top &&
      position.y <= rect.bottom
    );
  };
  const loadDroppedPaths = async (paths) => {
    const nextPath = pickSupportedVideoPath(paths);
    if (!nextPath) return;
    await openSourcePath(nextPath);
  };

  window.addEventListener(
    "dragover",
    (event) => {
      if (!hasFilePayload(event.dataTransfer)) return;
      event.preventDefault();
    },
    { passive: false }
  );

  window.addEventListener(
    "drop",
    (event) => {
      if (!hasFilePayload(event.dataTransfer)) return;
      event.preventDefault();
      showDropzone(false);
    },
    { passive: false }
  );

  stageCanvas.addEventListener("dragenter", (event) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    showDropzone(true);
  });

  stageCanvas.addEventListener("dragover", (event) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    showDropzone(true);
  });

  stageCanvas.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && stageCanvas.contains(event.relatedTarget)) return;
    showDropzone(false);
  });

  stageCanvas.addEventListener("drop", async (event) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    showDropzone(false);
    await loadDroppedPaths(extractDomDropPaths(event.dataTransfer));
  });

  const tauriEvent = window.__TAURI__?.event;
  if (!tauriEvent?.listen) return;

  void Promise.all([
    tauriEvent.listen("tauri://drag-enter", ({ payload }) => {
      const paths = normalizeDroppedPaths(payload?.paths);
      showDropzone(isInsideStage(payload?.position) && paths.length > 0);
    }),
    tauriEvent.listen("tauri://drag-over", ({ payload }) => {
      showDropzone(isInsideStage(payload?.position));
    }),
    tauriEvent.listen("tauri://drag-leave", () => {
      showDropzone(false);
    }),
    tauriEvent.listen("tauri://drag-drop", async ({ payload }) => {
      showDropzone(false);
      if (!isInsideStage(payload?.position)) return;
      await loadDroppedPaths(normalizeDroppedPaths(payload?.paths));
    }),
  ]).catch((error) => {
    console.error("[source-drop] native drag listeners failed", error);
  });
}

function ensureEls() {
  if (!video) {
    video = document.getElementById("sourceVideo");
    canvas = document.getElementById("output");
    ctx = canvas?.getContext("2d", { alpha: false, willReadFrequently: true }) ?? null;
    splitCanvas = document.getElementById("outputSplitOverlay");
    splitCtx = splitCanvas?.getContext("2d", { alpha: false, willReadFrequently: true }) ?? null;
  }

  if (!sourceCanvas) {
    sourceCanvas = document.createElement("canvas");
    sourceCtx = sourceCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }

  if (!processedCanvas) {
    processedCanvas = document.createElement("canvas");
    processedCtx = processedCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }

  if (!ditherCanvas) {
    ditherCanvas = document.createElement("canvas");
    ditherCtx = ditherCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }

  return {
    video,
    canvas,
    ctx,
    splitCanvas,
    splitCtx,
    sourceCanvas,
    sourceCtx,
    processedCanvas,
    processedCtx,
    ditherCanvas,
    ditherCtx,
  };
}

function ensureFrameBuffers(width, height) {
  const {
    sourceCanvas: sourceBuffer,
    processedCanvas: processedBuffer,
    ditherCanvas: ditherBuffer,
    splitCanvas: splitOutputCanvas,
  } = ensureEls();
  if (!width || !height) return;

  if (sourceBuffer.width !== width || sourceBuffer.height !== height) {
    sourceBuffer.width = width;
    sourceBuffer.height = height;
  }

  if (processedBuffer.width !== width || processedBuffer.height !== height) {
    processedBuffer.width = width;
    processedBuffer.height = height;
  }

  if (ditherBuffer.width !== width || ditherBuffer.height !== height) {
    ditherBuffer.width = width;
    ditherBuffer.height = height;
  }

  if (splitOutputCanvas && (splitOutputCanvas.width !== width || splitOutputCanvas.height !== height)) {
    splitOutputCanvas.width = width;
    splitOutputCanvas.height = height;
  }
}

function wireVideoEvents(v) {
  if (eventsWired) return;
  eventsWired = true;

  v.addEventListener("timeupdate", () => {
    if (playbackSyncSuspended) return;
    if (enforceTrimPlayback(v)) return;
    syncPlaybackState(v);
  });

  v.addEventListener("play", () => {
    if (playbackSyncSuspended) return;
    syncPlaybackState(v);
    if (!rafId) startDrawLoop();
  });

  v.addEventListener("pause", () => {
    if (playbackSyncSuspended) return;
    syncPlaybackState(v, { playing: false });
  });

  v.addEventListener("seeked", () => {
    if (playbackSyncSuspended) return;
    syncPlaybackState(v);
    renderCurrentFrame();
  });

  v.addEventListener("ended", () => {
    if (playbackSyncSuspended) return;
    syncPlaybackState(v, { playing: false });
  });
}

// Detect native FPS via requestVideoFrameCallback. Falls back to 30 if unsupported.
async function detectSourceFps(v) {
  if (typeof v.requestVideoFrameCallback !== "function") return 30;
  return new Promise((resolve) => {
    let frames = 0;
    let first = 0;
    let last = 0;
    let settled = false;
    const wasMuted = v.muted;
    playbackSyncSuspended = true;
    v.muted = true;

    const finish = (fps) => {
      if (settled) return;
      settled = true;
      v.pause();
      try {
        v.currentTime = 0;
      } catch {}
      v.muted = wasMuted;
      playbackSyncSuspended = false;
      resolve(clampFps(fps));
    };

    const cb = (_now, meta) => {
      frames++;
      if (frames === 1) first = meta.mediaTime;
      last = meta.mediaTime;
      if (frames >= 10) {
        const dt = last - first;
        if (dt > 0) return finish((frames - 1) / dt);
      }
      if (!settled) v.requestVideoFrameCallback(cb);
    };

    v.requestVideoFrameCallback(cb);
    v.play().catch(() => finish(30));
    setTimeout(() => {
      if (frames > 1) {
        const dt = last - first;
        finish(dt > 0 ? (frames - 1) / dt : 30);
      } else {
        finish(30);
      }
    }, 800);
  });
}

function clampFps(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return 30;
  return Math.min(120, Math.max(1, Math.round(fps)));
}

function syncPlaybackState(v, patch = {}) {
  dispatch("playback", {
    playing: !v.paused && !v.ended,
    currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
    ...patch,
  });
}

function syncVideoPlaybackRate(v, fps = getState().source.fps, sourceFps = getState().source.sourceFps) {
  if (!v) return;
  const baseFps = Math.max(1, clampFps(sourceFps || fps || 30));
  const targetFps = Math.max(1, clampFps(fps || baseFps));
  v.playbackRate = clamp(targetFps / baseFps, 0.1, 4);
}

async function startPlayback(v, options = {}) {
  const { forceRestart = false } = options;
  const { playback } = getState();
  const requestToken = ++playRequestToken;
  const trimStart = playback.trimStart || 0;
  const trimEnd = playback.trimEnd || v.duration || 0;
  const currentTime = v.currentTime || 0;
  const outsideTrim =
    currentTime < trimStart - PLAYBACK_LOOP_EPSILON ||
    currentTime >= trimEnd - PLAYBACK_LOOP_EPSILON;

  if (forceRestart || outsideTrim) {
    try {
      v.currentTime = trimStart;
    } catch {}
  }

  let playPromise = null;
  try {
    playPromise = Promise.resolve(v.play());
    pendingPlayPromise = playPromise;
    syncPlaybackState(v, { playing: true });
    if (!rafId) startDrawLoop();
    await playPromise;
    syncPlaybackState(v, { playing: true });
    if (requestToken !== playRequestToken) {
      v.pause();
      syncPlaybackState(v, { playing: false });
    }
  } catch (error) {
    console.error("[playback] play failed", error);
    syncPlaybackState(v, { playing: false });
  } finally {
    if (pendingPlayPromise === playPromise) {
      pendingPlayPromise = null;
    }
  }
}

function hasFilePayload(dataTransfer) {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

function extractDomDropPaths(dataTransfer) {
  if (!dataTransfer?.files?.length) return [];
  return Array.from(dataTransfer.files)
    .map((file) => file.path)
    .filter(Boolean);
}

function normalizeDroppedPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.filter((path) => typeof path === "string" && path.length > 0);
}

function pickSupportedVideoPath(paths) {
  return normalizeDroppedPaths(paths).find(isVideoPath) ?? null;
}

function isVideoPath(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return Boolean(ext && VIDEO_EXTENSIONS.includes(ext));
}

// Transport API ----------------------------------------------------

export async function togglePlay() {
  const { video: v } = ensureEls();
  if (!v?.src) return;

  if (pendingPlayPromise || (!v.paused && !v.ended)) {
    playRequestToken += 1;
    pendingPlayPromise = null;
    v.pause();
    syncPlaybackState(v, { playing: false });
    return;
  }

  await startPlayback(v);
}

export function restart() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const { playback } = getState();
  seek(playback.trimStart || 0);
}

export function pausePlayback() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  playRequestToken += 1;
  pendingPlayPromise = null;
  v.pause();
  syncPlaybackState(v, { playing: false });
}

export function seek(seconds) {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  const target = Math.max(0, Math.min(duration, Number(seconds) || 0));
  const before = Number.isFinite(v.currentTime) ? v.currentTime : 0;
  try {
    if (Math.abs(before - target) > 0.0005) {
      v.currentTime = target;
    } else {
      renderCurrentFrame();
    }
  } catch {}
  syncPlaybackState(v, { currentTime: target });
}

export function beginExportSession() {
  const { video: v } = ensureEls();
  if (v) {
    playRequestToken += 1;
    pendingPlayPromise = null;
    try { v.pause(); } catch {}
    syncPlaybackState(v, { playing: false });
  }
  exportSessionActive = true;
  playbackSyncSuspended = true;
}

export function endExportSession() {
  exportSessionActive = false;
  playbackSyncSuspended = false;
  const { video: v } = ensureEls();
  if (v) syncPlaybackState(v);
}

export async function seekForExport(seconds) {
  const { video: v } = ensureEls();
  if (!v?.src) return false;
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  const target = Math.max(0, Math.min(duration, Number(seconds) || 0));
  const before = Number.isFinite(v.currentTime) ? v.currentTime : 0;

  if (Math.abs(before - target) <= 0.0005) {
    renderCurrentFrame();
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finalize = (ok) => {
      if (settled) return;
      settled = true;
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("error", onError);
      clearTimeout(timer);
      if (ok) renderCurrentFrame();
      resolve(ok);
    };
    const onSeeked = () => finalize(true);
    const onError = () => finalize(false);
    const timer = setTimeout(() => finalize(false), 5000);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("error", onError);
    try {
      v.currentTime = target;
    } catch {
      finalize(false);
    }
  });
}

export function stepFrame(direction) {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const { source, playback } = getState();
  const fps = source.fps || 30;
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  pausePlayback();
  const next = clamp(
    (v.currentTime || 0) + direction / fps,
    playback.trimStart,
    Math.max(playback.trimStart, (playback.trimEnd || duration) - 1 / fps)
  );
  seek(next);
}

export function snapPlayhead() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const { playback } = getState();
  const t = v.currentTime || 0;
  const nearStart = Math.abs(t - playback.trimStart) < Math.abs(t - playback.trimEnd);
  seek(nearStart ? playback.trimStart : playback.trimEnd);
}

export function setIn() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const { playback } = getState();
  const next = Math.min(v.currentTime || 0, playback.trimEnd - 0.01);
  const trimStart = Math.max(0, next);
  dispatch("playback", { trimStart });
  if ((v.currentTime || 0) < trimStart) seek(trimStart);
}

export function setOut() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const { playback } = getState();
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  const next = Math.max(v.currentTime || 0, playback.trimStart + 0.01);
  const trimEnd = Math.min(duration, next);
  dispatch("playback", { trimEnd });
  if ((v.currentTime || 0) > trimEnd) seek(trimEnd);
}

export function resetTrim() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  dispatch("playback", { trimStart: 0, trimEnd: Number.isFinite(v.duration) ? v.duration : 0 });
}

export function setFps(fps) {
  const nextFps = clampFps(fps);
  const { video: v } = ensureEls();
  syncVideoPlaybackRate(v, nextFps, getState().source.sourceFps);
  dispatch("source", { fps: nextFps });
  setViewerOutputFps(nextFps);
}

export function getCurrentExportFrameCanvas(target = "viewer-output") {
  const { video: v } = ensureEls();
  if (!v || v.readyState < 2) return null;
  renderCurrentFrame();
  if (target === "dither-only") {
    return hasDitherOutput ? ditherCanvas ?? null : null;
  }
  return processedCanvas ?? null;
}

export function hasCurrentDitherFrame() {
  const { video: v } = ensureEls();
  if (!v || v.readyState < 2) return false;
  renderCurrentFrame();
  return hasDitherOutput && Boolean(ditherCanvas?.width && ditherCanvas?.height);
}

export function getCurrentSourceFrameCanvas() {
  const { video: v } = ensureEls();
  if (!v || v.readyState < 2) return null;
  renderCurrentFrame();
  return sourceCanvas ?? null;
}

// Pixel inspector sampling -----------------------------------------

export function samplePixel(u, vCoord) {
  if (!sampleLayout || !sourceCtx || !processedCtx) return null;
  if (!Number.isFinite(u) || !Number.isFinite(vCoord)) return null;

  const displayX = Math.floor(u * sampleLayout.displayWidth);
  const displayY = Math.floor(vCoord * sampleLayout.displayHeight);
  const point = mapDisplayPointToImage(displayX, displayY, sampleLayout);
  if (!point) return null;

  const source = readPixel(sourceCtx, point.x, point.y);
  const processed = readPixel(processedCtx, point.x, point.y);
  if (!source || !processed) return null;

  return {
    x: point.x,
    y: point.y,
    source,
    processed,
  };
}

// Internals --------------------------------------------------------

function renderCurrentFrame() {
  const { video: v } = ensureEls();
  if (!v || v.readyState < 2 || !canvas || !ctx) return;

  const currentRenderVersion = ++renderVersion;
  const currentSourceToken = sourceToken;
  ensureFrameBuffers(v.videoWidth, v.videoHeight);
  drawSourceFrame(v);

  const graph = ensureBootGraph();
  const graphOutputs = evaluateGraphOutputs(graph, {
    sourceImage: sourceCanvas,
  }) ?? { viewerOutput: null, ditherOutput: null };
  const graphOutput = graphOutputs.viewerOutput;

  commitProcessedFrame(graphOutput);
  commitDitherFrame(graphOutputs.ditherOutput);
  presentPreview();
  queueNativePreview(graph, currentRenderVersion, currentSourceToken);
}

function drawSourceFrame(v) {
  if (!sourceCtx || !sourceCanvas) return;
  sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  sourceCtx.drawImage(v, 0, 0, sourceCanvas.width, sourceCanvas.height);
}

function commitProcessedFrame(image) {
  if (!processedCtx || !processedCanvas) return;
  processedCtx.clearRect(0, 0, processedCanvas.width, processedCanvas.height);
  if (!image) return;
  processedCtx.drawImage(image, 0, 0, processedCanvas.width, processedCanvas.height);
}

function commitDitherFrame(image) {
  if (!ditherCtx || !ditherCanvas) return;
  hasDitherOutput = Boolean(image);
  ditherCtx.clearRect(0, 0, ditherCanvas.width, ditherCanvas.height);
  if (!image) return;
  ditherCtx.drawImage(image, 0, 0, ditherCanvas.width, ditherCanvas.height);
}

function queueNativePreview(graph, currentRenderVersion, currentSourceToken) {
  if (exportSessionActive) return;
  if (nativeRenderInFlight || !canUseNativeRender(graph)) return;
  nativeRenderInFlight = true;

  void evaluateNativeGraphOutputs(graph, sourceCanvas)
    .then((nativeOutputs) => {
      if (!nativeOutputs) return;
      if (currentRenderVersion !== renderVersion) return;
      if (currentSourceToken !== sourceToken) return;
      commitProcessedFrame(nativeOutputs.viewerOutput);
      commitDitherFrame(nativeOutputs.ditherOutput);
      presentPreview();
    })
    .finally(() => {
      nativeRenderInFlight = false;
    });
}

function presentPreview() {
  if (!canvas || !ctx || !sourceCanvas || !processedCanvas) return;

  const { view } = getState();
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;

  if (!width || !height) return;

  switch (view.compare) {
    case "original":
      resizeCanvasElement(canvas, width, height);
      clearCanvas(ctx, canvas);
      ctx.drawImage(sourceCanvas, 0, 0);
      clearSplitCanvas();
      sampleLayout = createSingleImageLayout(width, height);
      break;
    case "split":
      resizeCanvasElement(canvas, width, height);
      clearCanvas(ctx, canvas);
      ctx.drawImage(processedCanvas, 0, 0);
      drawSourceSplit(ctx, sourceCanvas, width, height, view.splitPosition);
      clearSplitCanvas();
      sampleLayout = createSingleImageLayout(width, height);
      break;
    case "side-by-side":
      resizeCanvasElement(canvas, width, height);
      clearCanvas(ctx, canvas);
      sampleLayout = createSideBySideLayout(width, height);
      drawSideBySidePreview(ctx, sourceCanvas, processedCanvas, sampleLayout);
      clearSplitCanvas();
      break;
    case "dither-only":
      resizeCanvasElement(canvas, width, height);
      clearCanvas(ctx, canvas);
      ctx.drawImage(hasDitherOutput ? ditherCanvas : processedCanvas, 0, 0);
      clearSplitCanvas();
      sampleLayout = createSingleImageLayout(width, height);
      break;
    case "processed":
    default:
      resizeCanvasElement(canvas, width, height);
      clearCanvas(ctx, canvas);
      ctx.drawImage(processedCanvas, 0, 0);
      clearSplitCanvas();
      sampleLayout = createSingleImageLayout(width, height);
      break;
  }
}

function resizeCanvasElement(targetCanvas, width, height) {
  if (!targetCanvas) return;
  if (targetCanvas.width !== width) targetCanvas.width = width;
  if (targetCanvas.height !== height) targetCanvas.height = height;
}

function clearCanvas(targetCtx, targetCanvas) {
  if (!targetCtx || !targetCanvas) return;
  targetCtx.save();
  targetCtx.fillStyle = PREVIEW_BG;
  targetCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  targetCtx.restore();
}

function clearSplitCanvas() {
  if (!splitCtx || !splitCanvas) return;
  clearCanvas(splitCtx, splitCanvas);
}

function drawSourceSplit(targetCtx, sourceImage, width, height, splitPosition) {
  const splitX = Math.round(clamp(splitPosition, 0, 1) * width);
  if (splitX <= 0) return;

  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.rect(0, 0, splitX, height);
  targetCtx.clip();
  targetCtx.drawImage(sourceImage, 0, 0);
  targetCtx.restore();
}

function drawSideBySidePreview(targetCtx, sourceImage, processedImage, layout) {
  targetCtx.save();
  targetCtx.imageSmoothingEnabled = false;
  targetCtx.fillStyle = PREVIEW_BG;
  targetCtx.fillRect(layout.leftPane.x + layout.leftPane.width, 0, layout.gap, layout.displayHeight);
  drawFittedImage(targetCtx, sourceImage, layout.leftImage);
  drawFittedImage(targetCtx, processedImage, layout.rightImage);
  targetCtx.restore();
}

function drawFittedImage(targetCtx, image, rect) {
  targetCtx.drawImage(
    image,
    0,
    0,
    image.width,
    image.height,
    rect.x,
    rect.y,
    rect.width,
    rect.height
  );
}

function startDrawLoop() {
  const { video: v } = ensureEls();
  const tick = () => {
    if (!playbackSyncSuspended) {
      if (!enforceTrimPlayback(v)) {
        syncPlaybackState(v);
        renderCurrentFrame();
      }
    }
    if (!v.paused && !v.ended) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = 0;
    }
  };
  rafId = requestAnimationFrame(tick);
}

function stopDrawLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function enforceTrimPlayback(v) {
  const { playback } = getState();
  const trimStart = playback.trimStart || 0;
  const trimEnd = playback.trimEnd || v.duration || 0;
  if (!trimEnd || v.currentTime < trimEnd - PLAYBACK_LOOP_EPSILON) return false;

  if (playback.loopEnabled !== false && trimEnd - trimStart > PLAYBACK_LOOP_EPSILON) {
    try {
      v.currentTime = trimStart;
    } catch {}
    syncPlaybackState(v, { currentTime: trimStart, playing: true });
    renderCurrentFrame();
    return true;
  }

  try {
    v.currentTime = trimEnd;
  } catch {}
  v.pause();
  syncPlaybackState(v, { currentTime: trimEnd, playing: false });
  renderCurrentFrame();
  return true;
}

function enablePlayerControls() {
  setPlayerControlsEnabled(true);
}

function disablePlayerControls() {
  setPlayerControlsEnabled(false);
}

function setPlayerControlsEnabled(enabled) {
  document.querySelectorAll(".player-card button, .player-card input").forEach((el) => {
    el.disabled = !enabled;
  });
}

function populateReadout(v, path) {
  setReadout("type", "Video");
  setReadout("resolution", `${v.videoWidth}×${v.videoHeight}`);
  setReadout("duration", formatTime(v.duration));
  setReadout("missing", "—");
  const name = path.split(/[/\\]/).pop();
  if (name) document.title = `${name} — Dither Lab`;
}

function setReadout(key, value) {
  const el = document.querySelector(`[data-readout="${key}"]`);
  if (el) el.textContent = value;
}

function readPixel(context, x, y) {
  try {
    const data = context.getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2]];
  } catch {
    return null;
  }
}

function createSingleImageLayout(width, height) {
  return {
    mode: "single",
    displayWidth: width,
    displayHeight: height,
    imageWidth: width,
    imageHeight: height,
  };
}

function createSideBySideLayout(width, height) {
  const gap = Math.min(SIDE_BY_SIDE_GAP, Math.max(0, Math.floor(width * 0.04)));
  const paneWidth = Math.max(1, Math.floor((width - gap) / 2));
  const leftPane = {
    x: 0,
    y: 0,
    width: paneWidth,
    height,
  };
  const rightPane = {
    x: paneWidth + gap,
    y: 0,
    width: Math.max(1, width - paneWidth - gap),
    height,
  };

  return {
    mode: "side-by-side",
    displayWidth: width,
    displayHeight: height,
    imageWidth: width,
    imageHeight: height,
    gap,
    leftPane,
    rightPane,
    leftImage: fitImageRect(leftPane, width, height),
    rightImage: fitImageRect(rightPane, width, height),
  };
}

function fitImageRect(container, imageWidth, imageHeight) {
  const scale = Math.min(container.width / imageWidth, container.height / imageHeight);
  const width = Math.max(1, Math.round(imageWidth * scale));
  const height = Math.max(1, Math.round(imageHeight * scale));
  return {
    x: Math.round(container.x + (container.width - width) / 2),
    y: Math.round(container.y + (container.height - height) / 2),
    width,
    height,
  };
}

function mapDisplayPointToImage(displayX, displayY, layout) {
  if (
    displayX < 0 ||
    displayY < 0 ||
    displayX >= layout.displayWidth ||
    displayY >= layout.displayHeight
  ) {
    return null;
  }

  if (layout.mode === "side-by-side") {
    return mapSideBySidePoint(displayX, displayY, layout);
  }

  return {
    x: clamp(displayX, 0, layout.imageWidth - 1),
    y: clamp(displayY, 0, layout.imageHeight - 1),
  };
}

function mapSideBySidePoint(displayX, displayY, layout) {
  for (const rect of [layout.leftImage, layout.rightImage]) {
    if (
      displayX < rect.x ||
      displayY < rect.y ||
      displayX >= rect.x + rect.width ||
      displayY >= rect.y + rect.height
    ) {
      continue;
    }

    return {
      x: clamp(
        Math.floor(((displayX - rect.x) / rect.width) * layout.imageWidth),
        0,
        layout.imageWidth - 1
      ),
      y: clamp(
        Math.floor(((displayY - rect.y) / rect.height) * layout.imageHeight),
        0,
        layout.imageHeight - 1
      ),
    };
  }

  return null;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n) {
  return n.toString().padStart(2, "0");
}

function waitFor(target, eventName) {
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(`${eventName} failed`));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, ok);
      target.removeEventListener("error", fail);
    };
    target.addEventListener(eventName, ok, { once: true });
    target.addEventListener("error", fail, { once: true });
  });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
