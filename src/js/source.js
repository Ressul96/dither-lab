import { getState, dispatch, subscribe } from "./state.js";
import { ensureBootGraph, setViewerOutputFps } from "./graph.js";
import { clearGraphCache, evaluateGraphOutputs, isOutputCached } from "./graph-runtime.js";
import { canUseNativeRender, evaluateNativeGraphOutputs } from "./native-render.js";
import { acquireBuffer, releaseBuffer } from "./image-ops.js";
import {
  isWorkerAvailable,
  requestWorkerRender,
  clearWorkerCache,
} from "./render-adapter.js";
import {
  applyTimelineToGraph,
  snapTimeToFrame,
  timeToFrame,
  timelineFrameRate,
} from "./timeline.js";

const FRAME_CACHE_TARGET_BYTES = 150_000_000;
const FRAME_CACHE_MIN = 8;
const frameCache = new Map();
let frameCacheCap = FRAME_CACHE_MIN;
let frameCacheStamp = 0;

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "m4v", "mkv", "avi"];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];
const PREVIEW_BG = "#0f0f12";
const PLAYBACK_LOOP_EPSILON = 1 / 120;
const COMPARE_MODES = new Set(["processed", "split", "side-by-side"]);

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
let previewSubscriptionsWired = false;
let sourceDropWired = false;
let hasDitherOutput = false;
let playbackSyncSuspended = false;
let pendingPlayPromise = null;
let playRequestToken = 0;
let renderVersion = 0;
let sourceToken = 0;
let nativeRenderInFlight = false;
let nativeRenderStatus = "js";
let exportSessionActive = false;
let renderQueued = false;
let previewSourceCanvas = null;
let previewSourceCtx = null;
const PLAYBACK_PREVIEW_SCALE = 0.5;

class ImageMediaMock extends EventTarget {
  constructor(img) {
    super();
    this.img = img;
    this.videoWidth = img.naturalWidth;
    this.videoHeight = img.naturalHeight;
    this.duration = 10;
    this._currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.playbackRate = 1;
    this.readyState = 4;
    this._lastTickTime = 0;
    this._tickRaf = 0;
    this.muted = true;
    this.loop = false;
  }
  
  get currentTime() { return this._currentTime; }
  set currentTime(val) {
    this._currentTime = val;
    this.dispatchEvent(new Event("seeked"));
  }
  
  get drawable() { return this.img; }
  
  get src() { return this.img.src; }
  set src(val) { this.img.src = val; }

  play() {
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    this.ended = false;
    this._lastTickTime = performance.now();
    this.dispatchEvent(new Event("play"));
    this._tick();
    return Promise.resolve();
  }
  
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
    if (this._tickRaf) {
      cancelAnimationFrame(this._tickRaf);
      this._tickRaf = 0;
    }
  }

  load() {}
  removeAttribute() {}
  
  _tick() {
    if (this.paused) return;
    const now = performance.now();
    const dt = (now - this._lastTickTime) / 1000;
    this._lastTickTime = now;
    
    this._currentTime += dt * this.playbackRate;
    if (this._currentTime >= this.duration) {
      this._currentTime = this.duration;
      this.ended = true;
      this.paused = true;
      this.dispatchEvent(new Event("timeupdate"));
      this.dispatchEvent(new Event("ended"));
      return;
    }
    this.dispatchEvent(new Event("timeupdate"));
    this._tickRaf = requestAnimationFrame(() => this._tick());
  }
}

export function initSource() {
  wireSourceDropTarget();
  if (previewSubscriptionsWired) return;
  previewSubscriptionsWired = true;

  subscribe("view", () => presentPreview());
  subscribe("graph", () => scheduleRender());
  subscribe("timeline", () => scheduleRender());
}

// Coalesce multiple render requests within the same animation frame. Slider
// drags and event handlers can fire several dispatches per frame; without this
// each one would re-evaluate the whole graph synchronously.
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    if (!renderQueued) return;
    renderQueued = false;
    renderCurrentFrame();
  });
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
      filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
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
  
  const ext = path.split(".").pop()?.toLowerCase();
  const isImage = ext ? IMAGE_EXTENSIONS.includes(ext) : false;

  await loadMedia(src, path, isImage, options);
}

async function loadMedia(src, path, isImage, options = {}) {
  const { autoplay = false } = options;
  
  if (isImage) {
    if (video && video instanceof HTMLVideoElement) {
      try { video.pause(); } catch {}
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    video = new ImageMediaMock(img);
  } else {
    if (video && !(video instanceof HTMLVideoElement)) {
      video.pause();
      video = document.getElementById("sourceVideo");
    }
  }

  const { video: v, canvas: outputCanvas, splitCanvas: outputSplitCanvas } = ensureEls();
  stopDrawLoop();
  disablePlayerControls();
  sourceToken += 1;
  clearFrameCache();
  try {
    v.pause();
  } catch {}

  v.loop = false;
  if (!isImage) {
    v.src = src;
    v.load();

    try {
      await waitFor(v, "loadeddata");
    } catch (err) {
      console.error("[open-source] media load failed", err);
      clearSource();
      return;
    }
  }

  ensureFrameBuffers(v.videoWidth, v.videoHeight);
  outputCanvas?.classList.remove("hidden");
  outputSplitCanvas?.classList.remove("hidden");
  document.getElementById("emptyState")?.classList.add("hidden");

  populateReadout(v, path, isImage);
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
  dispatch("timeline", { duration: v.duration, fps: sourceFps });
  applyPlaybackSpeed(v);
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
  clearFrameCache();

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
  dispatch("timeline", { duration: 0, fps: 30 });
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
    const nextPath = pickSupportedMediaPath(paths);
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

  const maxDim = 4096;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  if (sourceBuffer.width !== width || sourceBuffer.height !== height) {
    sourceBuffer.width = width;
    sourceBuffer.height = height;
    clearFrameCache();
  }
  recomputeFrameCacheCap(width, height);

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
  if (v._eventsWired) return;
  v._eventsWired = true;

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
    scheduleRender();
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

// Treat both the CPU dither catalogue and the GPU pattern-dither pass as
// "dither chains" — both produce resolution-dependent output that differs
// between half-res and full-res evaluation.
export function graphContainsDither(graph) {
  if (!graph?.nodes?.length) return false;
  for (const node of graph.nodes) {
    if (!node || node.bypassed) continue;
    if (node.type === "dither" || node.type === "pattern-dither") return true;
  }
  return false;
}

function normalizePlaybackTime(seconds, fps) {
  const state = getState();
  const grid = fps ?? timelineFrameRate(state.timeline, state.source.fps);
  return snapTimeToFrame(seconds, grid);
}

function syncPlaybackState(v, patch = {}) {
  const time = normalizePlaybackTime(Number.isFinite(v.currentTime) ? v.currentTime : 0);
  dispatch("playback", {
    playing: !v.paused && !v.ended,
    currentTime: time,
    ...patch,
  });
}

function applyPlaybackSpeed(v, speed = getState().playback.speed) {
  if (!v) return;
  const numeric = Number.isFinite(Number(speed)) ? Number(speed) : 1;
  v.playbackRate = clamp(numeric, 0.1, 4);
}

export function setPlaybackSpeed(speed) {
  const numeric = clamp(Number(speed) || 1, 0.1, 4);
  const { video: v } = ensureEls();
  applyPlaybackSpeed(v, numeric);
  dispatch("playback", { speed: numeric });
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

function pickSupportedMediaPath(paths) {
  return normalizeDroppedPaths(paths).find(isMediaPath) ?? null;
}

function isMediaPath(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return Boolean(ext && MEDIA_EXTENSIONS.includes(ext));
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
  const target = normalizePlaybackTime(Math.max(0, Math.min(duration, Number(seconds) || 0)));
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
  const { source, playback, timeline } = getState();
  const fps = timelineFrameRate(timeline, source.fps);
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  pausePlayback();
  const currentFrame = timeToFrame(v.currentTime || 0, fps);
  const next = clamp(
    (currentFrame + direction) / fps,
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
  const next = Math.min(normalizePlaybackTime(v.currentTime || 0), playback.trimEnd - 0.01);
  const trimStart = Math.max(0, next);
  dispatch("playback", { trimStart });
  if ((v.currentTime || 0) < trimStart) seek(trimStart);
}

export function setOut() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const { playback } = getState();
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  const next = Math.max(normalizePlaybackTime(v.currentTime || 0), playback.trimStart + 0.01);
  const trimEnd = Math.min(duration, next);
  dispatch("playback", { trimEnd });
  if ((v.currentTime || 0) > trimEnd) seek(trimEnd);
}

export function resetTrim() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  dispatch("playback", { trimStart: 0, trimEnd: Number.isFinite(v.duration) ? v.duration : 0 });
}

// viewer-output.fps is now strictly an export target. Changing it no longer
// retunes the live <video> playback rate (that's setPlaybackSpeed's job).
// We still mirror the value into source.fps so legacy reads keep working,
// but the live preview keeps running at sourceFps.
export function setFps(fps) {
  const nextFps = clampFps(fps);
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

async function renderCurrentFrame() {
  const { video: v } = ensureEls();
  const graph = ensureBootGraph();
  const proceduralSource = findViewerProceduralSource(graph);
  if (proceduralSource) {
    renderProceduralFrame(graph, proceduralSource);
    return;
  }
  if (!v || v.readyState < 2 || !canvas || !ctx) {
    if (!renderProceduralFrame(graph)) {
      clearCanvas(ctx, canvas);
      clearSplitCanvas();
      canvas?.classList.add("hidden");
      splitCanvas?.classList.add("hidden");
      document.getElementById("emptyState")?.classList.remove("hidden");
      dispatch("view", {});
    }
    return;
  }

  const currentRenderVersion = ++renderVersion;
  const currentSourceToken = sourceToken;
  ensureFrameBuffers(v.videoWidth, v.videoHeight);
  drawSourceFrame(v);

  // sourceVersion is the cache identity of the current source frame. It only
  // changes when the painted contents change (new frame, new source), so the
  // node memo cache can hit on paused-video param tweaks.
  const baseSourceVersion = sourceFrameKey(v) ?? `live-${currentRenderVersion}`;

  // During playback, evaluate the effect chain on a downscaled copy of the
  // source. The processed/dither commits already scale the result back up to
  // full resolution so the displayed preview lines up with the export-sized
  // canvases — only the per-pixel CPU loops shrink. Paused/scrubbing frames
  // and export both stay at full resolution. The user can opt out via
  // view.playbackQuality === "full" when they want pixel-accurate live
  // playback at the cost of frame rate.
  const playbackQuality = getState().view.playbackQuality ?? "auto";
  // Dither output is resolution-dependent: error-diffusion error walks the
  // grid pixel-by-pixel and ordered patterns are tied to the cell size,
  // so half-res playback produces a visibly different image than the 1:1
  // paused/export render. Auto-promote dither chains to full-res evaluation
  // so the same frame the user is looking at during playback matches what
  // export will write — at the cost of fewer frames per second.
  const hasDither = graphContainsDither(graph);
  const usePlaybackScale =
    playbackQuality !== "full" &&
    !v.paused &&
    !v.ended &&
    !exportSessionActive &&
    !hasDither;
  const sourceForEval = usePlaybackScale
    ? buildPreviewSource(sourceCanvas)
    : sourceCanvas;
  const sourceVersion = usePlaybackScale
    ? `${baseSourceVersion}@${PLAYBACK_PREVIEW_SCALE}`
    : baseSourceVersion;

  const timelineContext = createTimelineRenderContext(v);
  const nativeRenderGraph = applyTimelineToGraph(
    graph,
    timelineContext.timeline,
    timelineContext.timeSeconds,
    {
      duration: timelineContext.durationSeconds,
      fps: timelineContext.fps,
    }
  );

  // F8.5 preview/export split. Export must stay synchronous and
  // deterministic on the main thread — the encoder waits for a fully-
  // committed frame before stepping to the next. Preview honours
  // `view.workerRender`: "on" always uses the worker, "auto" only switches
  // for live video playback (where jank is most visible), "off" disables it.
  const useWorker =
    !exportSessionActive &&
    shouldUseWorkerForPreview(getState().view?.workerRender, v) &&
    isWorkerAvailable();

  if (useWorker) {
    const result = await requestWorkerRender({
      graph,
      context: {
        sourceVersion,
        ...timelineContext,
      },
      sourceImage: sourceForEval,
    });
    if (!result) return; // stale or worker failed — leave the last good frame on screen
    commitProcessedFrame(result.viewerBitmap);
    commitDitherFrame(result.ditherBitmap);
    if (result.viewerBitmap) result.viewerBitmap.close();
    if (result.ditherBitmap) result.ditherBitmap.close();
    presentPreview();
    return;
  }

  const graphOutputs = evaluateGraphOutputs(graph, {
    sourceImage: sourceForEval,
    sourceVersion,
    ...timelineContext,
  }) ?? { viewerOutput: null, ditherOutput: null };
  const graphOutput = graphOutputs.viewerOutput;

  commitProcessedFrame(graphOutput);
  commitDitherFrame(graphOutputs.ditherOutput);
  recyclePreviewOutput(graphOutput);
  recyclePreviewOutput(graphOutputs.ditherOutput);
  presentPreview();
  queueNativePreview(nativeRenderGraph, currentRenderVersion, currentSourceToken);
}

function shouldUseWorkerForPreview(mode, video) {
  const resolved = mode ?? "auto";
  if (resolved === "off") return false;
  if (resolved === "on") return true;
  // "auto": live video playback is where the main thread chokes — each frame
  // is a fresh decode that re-runs the entire graph. Image, procedural, and
  // paused-video frames stay on the main thread so parameter tweaks reflect
  // without a worker round-trip.
  return video instanceof HTMLVideoElement && !video.paused && !video.ended;
}

function renderProceduralFrame(graph = ensureBootGraph(), sourceNode = findViewerProceduralSource(graph)) {
  if (!sourceNode || !canvas || !ctx) return false;

  renderVersion += 1;
  const { width, height } = proceduralSourceSize(sourceNode);
  ensureFrameBuffers(width, height);

  const timelineContext = createProceduralTimelineRenderContext();
  const graphOutputs = evaluateGraphOutputs(graph, {
    sourceImage: null,
    sourceVersion: "procedural",
    ...timelineContext,
  }) ?? { viewerOutput: null, ditherOutput: null };

  const graphOutput = graphOutputs.viewerOutput;
  if (!graphOutput?.width || !graphOutput?.height) return false;

  sourceCtx?.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  sourceCtx?.drawImage(graphOutput, 0, 0, sourceCanvas.width, sourceCanvas.height);
  canvas?.classList.remove("hidden");
  splitCanvas?.classList.remove("hidden");
  document.getElementById("emptyState")?.classList.add("hidden");

  commitProcessedFrame(graphOutput);
  commitDitherFrame(graphOutputs.ditherOutput);
  recyclePreviewOutput(graphOutput);
  recyclePreviewOutput(graphOutputs.ditherOutput);
  setNativeRenderStatus("js");
  presentPreview();
  dispatch("view", {});

  return true;
}

function findViewerProceduralSource(graph) {
  const viewer = graph?.nodes?.find((node) => node.type === "viewer-output");
  if (!viewer) return null;

  const nodeById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const incomingBySocket = new Map();
  for (const edge of graph.edges ?? []) {
    incomingBySocket.set(`${edge.toNode}\u0000${edge.toSocket}`, edge);
  }

  const queue = [viewer.id];
  const visited = new Set();
  while (queue.length) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeById.get(nodeId);
    if (isProceduralSourceNode(node)) return node;

    const primarySocket = primaryImageInputSocket(node);
    if (!primarySocket) continue;
    const edge = incomingBySocket.get(`${nodeId}\u0000${primarySocket}`);
    if (edge) queue.push(edge.fromNode);
  }

  return null;
}

function primaryImageInputSocket(node) {
  switch (node?.type) {
    case "mix":
      return "image_a";
    case "mask-combine":
      return "mask_a";
    case "math":
    case "value":
    case "gradient":
    case "mesh-gradient":
    case "noise":
    case "source":
      return null;
    default:
      return node?.inputs?.[0]?.name ?? null;
  }
}

function proceduralSourceSize(node) {
  return {
    width: clamp(Math.round(Number(node?.params?.width ?? 1920)), 256, 4096),
    height: clamp(Math.round(Number(node?.params?.height ?? 1080)), 256, 4096),
  };
}

function isProceduralSourceNode(node) {
  return node?.type === "gradient" || node?.type === "mesh-gradient" || node?.type === "noise";
}

function recyclePreviewOutput(image) {
  if (!image || image === sourceCanvas) return;
  // The previewSourceCanvas is a long-lived scratch buffer reused every play
  // tick; never let the buffer pool reclaim it.
  if (image === previewSourceCanvas) return;
  // The graph cache may pin this buffer for reuse on the next eval; only
  // recycle when nothing in the cache references it.
  if (isOutputCached(image)) return;
  releaseBuffer(image);
}

function buildPreviewSource(fullSource) {
  if (!fullSource?.width || !fullSource?.height) return fullSource;
  const w = Math.max(1, Math.round(fullSource.width * PLAYBACK_PREVIEW_SCALE));
  const h = Math.max(1, Math.round(fullSource.height * PLAYBACK_PREVIEW_SCALE));
  if (!previewSourceCanvas) {
    previewSourceCanvas = document.createElement("canvas");
  }
  if (previewSourceCanvas.width !== w || previewSourceCanvas.height !== h) {
    previewSourceCanvas.width = w;
    previewSourceCanvas.height = h;
    previewSourceCtx = previewSourceCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: false,
    });
  } else if (!previewSourceCtx) {
    previewSourceCtx = previewSourceCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: false,
    });
  }
  if (!previewSourceCtx) return fullSource;
  // Browser does the downscale in native code — much cheaper than re-running
  // every effect at the larger resolution would have been.
  previewSourceCtx.imageSmoothingEnabled = true;
  previewSourceCtx.drawImage(fullSource, 0, 0, w, h);
  return previewSourceCanvas;
}

function drawSourceFrame(v) {
  if (!sourceCtx || !sourceCanvas) return;
  const key = sourceFrameKey(v);
  if (key !== null) {
    const cached = frameCache.get(key);
    if (cached) {
      frameCache.delete(key);
      frameCache.set(key, cached);
      sourceCtx.drawImage(cached, 0, 0, sourceCanvas.width, sourceCanvas.height);
      return;
    }
  }
  sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  sourceCtx.drawImage(v.drawable || v, 0, 0, sourceCanvas.width, sourceCanvas.height);
  if (key !== null) cacheCurrentFrame(key);
}

function sourceFrameKey(v) {
  if (!v?.src || !Number.isFinite(v.currentTime)) return null;
  const fps = getState().source.sourceFps || 30;
  if (!fps) return null;
  return `${frameCacheStamp}|${timeToFrame(v.currentTime, fps)}`;
}

function cacheCurrentFrame(key) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return;
  const snapshot = acquireBuffer(sourceCanvas.width, sourceCanvas.height);
  const ctx = snapshot.getContext("2d", { alpha: false });
  if (!ctx) {
    releaseBuffer(snapshot);
    return;
  }
  ctx.drawImage(sourceCanvas, 0, 0);
  frameCache.set(key, snapshot);
  while (frameCache.size > frameCacheCap) {
    const oldestKey = frameCache.keys().next().value;
    const old = frameCache.get(oldestKey);
    frameCache.delete(oldestKey);
    if (old) releaseBuffer(old);
  }
}

function clearFrameCache() {
  for (const canvas of frameCache.values()) releaseBuffer(canvas);
  frameCache.clear();
  frameCacheStamp += 1;
  // Decoded frames are gone, so the per-node memoization that pinned the old
  // intermediate canvases is also stale — drop it now instead of letting next
  // eval discover the mismatch.
  clearGraphCache();
  // Mirror the wipe in the render worker; it has its own per-instance cache
  // that would otherwise keep serving stale outputs after a source swap.
  clearWorkerCache();
}

function recomputeFrameCacheCap(width, height) {
  if (!width || !height) {
    frameCacheCap = FRAME_CACHE_MIN;
    return;
  }
  const bytesPerFrame = width * height * 4;
  const cap = Math.max(FRAME_CACHE_MIN, Math.floor(FRAME_CACHE_TARGET_BYTES / bytesPerFrame));
  if (cap === frameCacheCap) return;
  frameCacheCap = cap;
  while (frameCache.size > frameCacheCap) {
    const oldestKey = frameCache.keys().next().value;
    const old = frameCache.get(oldestKey);
    frameCache.delete(oldestKey);
    if (old) releaseBuffer(old);
  }
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

function createTimelineRenderContext(v) {
  const state = getState();
  const fps = state.source.fps || 30;
  return {
    timeline: state.timeline,
    timeSeconds: normalizePlaybackTime(
      Number.isFinite(v?.currentTime) ? v.currentTime : state.playback.currentTime,
      fps
    ),
    durationSeconds: state.source.duration || v?.duration || 0,
    fps,
  };
}

function createProceduralTimelineRenderContext() {
  const state = getState();
  const fps = state.timeline.fps || state.source.fps || 30;
  return {
    timeline: state.timeline,
    timeSeconds: normalizePlaybackTime(state.playback.currentTime || 0, fps),
    durationSeconds: state.timeline.duration || state.source.duration || 0,
    fps,
  };
}

function queueNativePreview(renderGraph, currentRenderVersion, currentSourceToken) {
  if (exportSessionActive) return;
  if (!canUseNativeRender(renderGraph)) {
    setNativeRenderStatus("js");
    return;
  }
  if (nativeRenderInFlight) return;
  setNativeRenderStatus("native-pending");
  nativeRenderInFlight = true;

  void evaluateNativeGraphOutputs(renderGraph, sourceCanvas)
    .then((nativeOutputs) => {
      if (!nativeOutputs) {
        setNativeRenderStatus("native-disabled");
        return;
      }
      if (currentRenderVersion !== renderVersion) {
        setNativeRenderStatus(canUseNativeRender(renderGraph) ? "native" : "js");
        return;
      }
      if (currentSourceToken !== sourceToken) {
        setNativeRenderStatus("js");
        return;
      }
      commitProcessedFrame(nativeOutputs.viewerOutput);
      commitDitherFrame(nativeOutputs.ditherOutput);
      recyclePreviewOutput(nativeOutputs.viewerOutput);
      recyclePreviewOutput(nativeOutputs.ditherOutput);
      setNativeRenderStatus("native");
      presentPreview();
    })
    .finally(() => {
      nativeRenderInFlight = false;
    });
}

function setNativeRenderStatus(status) {
  if (nativeRenderStatus === status) return;
  nativeRenderStatus = status;
  dispatch("view", { renderBackend: status });
}

function presentPreview() {
  if (!canvas || !ctx || !sourceCanvas || !processedCanvas) return;

  const { view } = getState();
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;

  if (!width || !height) return;

  // Both canvases are sized to the source resolution and drawn in full;
  // screen-space comparison clipping (split, side-by-side) is applied by
  // CSS on the wrapper elements so zoom/pan move both layers together.
  resizeCanvasElement(canvas, width, height);
  resizeCanvasElement(splitCanvas, width, height);
  clearCanvas(ctx, canvas);

  const compare = normalizeCompareMode(view.compare);
  const overlayActive = compare === "split" || compare === "side-by-side";

  switch (compare) {
    case "split":
    case "side-by-side":
      ctx.drawImage(processedCanvas, 0, 0);
      paintOverlaySource();
      break;
    case "processed":
    default:
      ctx.drawImage(processedCanvas, 0, 0);
      break;
  }

  if (!overlayActive) clearSplitCanvas();
  sampleLayout = createSingleImageLayout(width, height);
}

function paintOverlaySource() {
  if (!splitCtx || !splitCanvas || !sourceCanvas) return;
  splitCtx.clearRect(0, 0, splitCanvas.width, splitCanvas.height);
  splitCtx.drawImage(sourceCanvas, 0, 0);
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

function startDrawLoop() {
  const { video: v } = ensureEls();
  const tick = () => {
    if (!playbackSyncSuspended) {
      if (!enforceTrimPlayback(v)) {
        syncPlaybackState(v);
        // Clear the scheduler flag so any queued render in this frame is
        // suppressed — tick already covered this paint.
        renderQueued = false;
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
    const persistentAction = el.matches(
      '[data-action="toggle-timeline-panel"], [data-action="more"], [data-action="toggle-autokey"], [data-action="toggle-loop"]'
    );
    if (persistentAction) {
      el.disabled = false;
      return;
    }
    el.disabled = !enabled;
  });
}

function populateReadout(v, path, isImage = false) {
  setReadout("type", isImage ? "Image" : "Video");
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

function mapDisplayPointToImage(displayX, displayY, layout) {
  if (
    displayX < 0 ||
    displayY < 0 ||
    displayX >= layout.displayWidth ||
    displayY >= layout.displayHeight
  ) {
    return null;
  }

  return {
    x: clamp(displayX, 0, layout.imageWidth - 1),
    y: clamp(displayY, 0, layout.imageHeight - 1),
  };
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

function normalizeCompareMode(value) {
  return COMPARE_MODES.has(value) ? value : "processed";
}
