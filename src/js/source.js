import { getState, dispatch, subscribe, pushHistory } from "./state.js";
import { ensureBootGraph, setViewerOutputFps } from "./graph.js";
import { serializeCustomPalettes, subscribePalettes } from "./palettes.js";
import {
  clearGraphCache,
  evaluateGraphOutputs,
  graphContainsGpuEffect,
  graphRequiresMainThreadRender,
  isOutputCached,
} from "./graph-runtime.js";
import { canUseNativeRender, evaluateNativeGraphOutputs } from "./native-render.js";
import { acquireBuffer, releaseBuffer } from "./image-ops.js";
import {
  isWorkerAvailable,
  requestWorkerRender,
  clearWorkerCache,
  syncWorkerPalettes,
  workerKnownGpuUnsupported,
} from "./render-adapter.js";
import {
  applyTimelineToGraph,
  snapTimeToFrame,
  timeToFrame,
  timelineFrameRate,
} from "./timeline.js";
import { selectedPath } from "./tauri-compat.js";
import { listenWithDispose } from "./ui/lifecycle.js";
import {
  addSource,
  compositionFromSource,
  compositionDuration,
  createDefaultComposition,
  firstVideoClip,
  getActiveVideoClip,
  getCompositingLayers,
  nextVideoClipAfter,
  normalizeComposition,
  serializeComposition,
  trimClipEnd,
  trimClipStart,
} from "./composition.js";

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
// Multi-source decode pool (Ship 4). Maps a composition sourceId to the
// HTMLVideoElement that decodes it, so the playhead can switch between distinct
// video files without re-loading one shared element. The transport element
// (`video`, the DOM #sourceVideo that also drives play/pause/FPS) is registered
// here under the primary source id, so the single-source path resolves to the
// exact same element it always used — behaviour stays byte-identical until a
// second source actually exists.
const videoPool = new Map(); // sourceId -> { el, path }
// Per-source canvases for graph source nodes bound to a specific media source
// (params.sourceId). Reused across frames; sized to the source's element.
const boundSourceCanvases = new Map(); // sourceId -> canvas
let primarySourceId = null;  // sourceId backed by the transport `video` element
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
// Multi-clip composition playback (Phase B). When set, the play tick is driven
// by `playbackEl` (the element decoding `playbackClip`) instead of the single
// transport video, advancing across clip boundaries. Null for the classic
// single-source path, which is left completely untouched.
let playbackClip = null;
let playbackEl = null;
// While the playhead is traversing an empty stretch between clips, no element
// decodes; the clock advances by wall time and the viewer shows a blank frame.
// { untilTime, next } where `next` is the clip to activate when the gap closes.
let playbackGap = null;
let gapLastWallMs = 0;
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
      if (this.loop) {
        this._currentTime = this.duration > 0 ? this._currentTime % this.duration : 0;
        this.dispatchEvent(new Event("timeupdate"));
        this._tickRaf = requestAnimationFrame(() => this._tick());
        return;
      }
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
  // Composition changes (clip edits, track opacity/blend) change what the stage
  // draws, so re-render the preview when the composition slice updates.
  subscribe("composition", () => scheduleRender());
  syncWorkerPalettes(serializeCustomPalettes());
  subscribePalettes(() => {
    clearGraphCache();
    syncWorkerPalettes(serializeCustomPalettes());
    scheduleRender();
  });
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
    requestRenderCurrentFrame();
  });
}

export async function openSource() {
  const tauri = window.__TAURI__;
  if (!tauri?.dialog?.open) {
    // Browser (no Tauri): load a primary source via a file input + blob URL.
    await loadMediaFromFile(await pickFileViaInput("video/*,image/*"));
    return;
  }

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

  const path = selectedPath(selected);
  if (!path) return;
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

// Ship 4: open the file picker and ADD the chosen media as a new source in the
// composition (without replacing the current one, unlike openSource). Returns
// the new sourceId or null. The Assets panel calls this.
export async function addSourceViaPicker() {
  const tauri = window.__TAURI__;
  if (!tauri?.dialog?.open) {
    // Browser (no Tauri): add a source via a file input + blob URL.
    const file = await pickFileViaInput("video/*,image/*");
    if (!file) return null;
    return addSourceFromSrc(URL.createObjectURL(file), file.name);
  }
  let selected;
  try {
    selected = await tauri.dialog.open({
      title: "Add Media",
      multiple: false,
      directory: false,
      filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
    });
  } catch (err) {
    console.error("[add-source] dialog failed", err);
    return null;
  }
  const path = selectedPath(selected);
  if (!path) return null;
  return addSourceFromPath(path);
}

// Load a media file into the decode pool and register it as a new composition
// source — does NOT touch the current composition's clips or reset playback.
// Video sources get a dedicated hidden <video> in the pool; the metadata
// (duration/dimensions) is read once on loadeddata. Returns the new sourceId.
export async function addSourceFromPath(path) {
  const tauri = window.__TAURI__;
  if (!tauri || !path) return null;
  return addSourceFromSrc(tauri.core.convertFileSrc(path), path);
}

// Core: load a media URL into the decode pool and register it as a new
// composition source. `src` is a ready-to-use URL (a Tauri asset URL, or in a
// plain browser a blob: URL); `path` is the display name. Images use an
// ImageMediaMock so the pool element behaves like a video everywhere
// (videoWidth/height, currentTime, drawable, seeked) — the compositor and
// exporter need no special-casing beyond skipping real seeks. Does NOT touch
// the current composition's clips. Returns the new sourceId.
async function addSourceFromSrc(src, path) {
  const ext = path?.split(".").pop()?.toLowerCase();
  const isImage = ext ? IMAGE_EXTENSIONS.includes(ext) : false;

  let el;
  if (isImage) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    } catch (err) {
      console.error("[add-source] image load failed", err);
      return null;
    }
    el = new ImageMediaMock(img);
  } else {
    el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.src = src;
    el.load();
    try {
      await waitFor(el, "loadeddata");
    } catch (err) {
      console.error("[add-source] media load failed", err);
      try { el.removeAttribute("src"); el.load(); } catch (_) {}
      return null;
    }
  }

  const sourceFps = isImage ? (getState().source.sourceFps || 30) : await detectSourceFps(el);
  const { composition, sourceId } = addSource(getState().composition, {
    path,
    kind: "video",
    duration: el.duration,
    fps: sourceFps,
    width: el.videoWidth,
    height: el.videoHeight,
    hasAudio: false,
  });
  videoPool.set(sourceId, { el, path });
  dispatch("composition", serializeComposition(composition));
  return sourceId;
}

// Open a hidden <input type=file> and resolve with the chosen File. The no-Tauri
// browser fallback for the native file dialog, so media can be loaded when the
// frontend runs outside the desktop shell (e.g. localhost in a browser).
function pickFileViaInput(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        const file = input.files && input.files[0] ? input.files[0] : null;
        input.remove();
        resolve(file);
      },
      { once: true }
    );
    document.body.appendChild(input);
    input.click();
  });
}

// Load a browser File as the primary source via a blob: URL.
async function loadMediaFromFile(file) {
  if (!file) return;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const isImage = ext ? IMAGE_EXTENSIONS.includes(ext) : false;
  await loadMedia(URL.createObjectURL(file), file.name, isImage);
}

function isMediaFile(file) {
  const ext = file?.name?.split(".").pop()?.toLowerCase();
  return Boolean(ext && MEDIA_EXTENSIONS.includes(ext));
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
  // V3: mirror the freshly-loaded source into a single-clip composition so the
  // clip timeline and composition-aware render path have a valid model. Ship 1
  // is single-source, so a new load replaces the composition (matches the
  // pre-v3 "one source at a time" behaviour).
  const migrated = compositionFromSource({
    loaded: true,
    path,
    duration: v.duration,
    sourceFps,
    fps: sourceFps,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
  });
  dispatch("composition", serializeComposition(migrated));
  // Loading a fresh source replaces the composition, so any extra pooled
  // decode elements from a previous project are stale — drop them and bind the
  // transport element to the new primary source id.
  resetVideoPool();
  registerPrimarySource(migrated.sources[0]?.id ?? "source-1");
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
  requestRenderCurrentFrame();
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
  resetVideoPool();

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
  dispatch("composition", createDefaultComposition());
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

  // Window-scoped drag/drop suppression: prevent the browser from
  // navigating to the dropped file when the user releases outside the
  // stage canvas. listenWithDispose keeps cleanup symmetric so a re-init
  // doesn't accumulate duplicate preventDefault handlers.
  listenWithDispose(
    window,
    "dragover",
    (event) => {
      if (!hasFilePayload(event.dataTransfer)) return;
      event.preventDefault();
    },
    { passive: false }
  );

  listenWithDispose(
    window,
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
    const paths = extractDomDropPaths(event.dataTransfer);
    if (paths.length > 0) {
      await loadDroppedPaths(paths);
      return;
    }
    // Browser: filesystem paths aren't exposed on File, so load the dropped
    // File directly via a blob: URL.
    const file = Array.from(event.dataTransfer.files || []).find(isMediaFile);
    if (file) await loadMediaFromFile(file);
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

// ---------- multi-source decode pool (Ship 4) ----------

// Register the transport <video> element as the decoder for `sourceId`. Called
// when a source is loaded into the shared #sourceVideo, so the pool and the
// single-source path point at the same element.
function registerPrimarySource(sourceId) {
  const { video: v } = ensureEls();
  if (!sourceId || !v) return;
  primarySourceId = sourceId;
  videoPool.set(sourceId, { el: v, path: v.src || "" });
}

// Resolve the <video> element that decodes a given sourceId. The primary source
// is the transport element; any other source uses its own pooled element. In
// the single-source case this always returns the transport `video`, so the
// existing render/seek path is unchanged.
function decodeVideoForSourceId(sourceId) {
  if (!sourceId) return ensureEls().video;
  const entry = videoPool.get(sourceId);
  if (entry?.el) return entry.el;
  return ensureEls().video;
}

// Tear down every pooled decode element EXCEPT the transport element (which the
// DOM owns and loadMedia reuses). Non-primary elements get their src released
// so the browser frees the decoder. Called on source load / clearSource.
function resetVideoPool() {
  for (const [sourceId, entry] of videoPool) {
    if (sourceId === primarySourceId) continue;
    if (entry?.el && entry.el !== video) {
      try {
        entry.el.pause();
        entry.el.removeAttribute("src");
        entry.el.load();
      } catch (_) {}
    }
  }
  videoPool.clear();
  primarySourceId = null;
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
    if (!node || node.bypassed || node.visible === false) continue;
    if (node.type === "dither" || node.type === "pattern-dither") return true;
  }
  return false;
}

function normalizePlaybackTime(seconds, fps) {
  const state = getState();
  const grid = fps ?? timelineFrameRate(state.timeline, state.source.fps);
  return snapTimeToFrame(seconds, grid);
}

// Authoritative timeline (composition) time in seconds. The transport video's
// currentTime is capped at the primary source's duration, so it cannot address
// composition times past the first clip; playback.currentTime is the clock of
// record (written by seek and the play tick, mirrored by syncPlaybackState).
// Single-source: the lone clip is start:0/in:0 on the transport, so this equals
// the transport's currentTime and render/seek stay byte-identical.
function currentTimelineTime() {
  return Number(getState().playback.currentTime) || 0;
}

// Full traversable timeline length: the composition extent, but never shorter
// than the source/user-set timeline duration (procedural tails). Used to clamp
// seeks and size the playable range.
function timelineClockDuration() {
  const { composition, source, timeline } = getState();
  return Math.max(
    compositionDuration(composition) || 0,
    Number(source?.duration) || 0,
    Number(timeline?.duration) || 0
  );
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

  if (!isSimpleSingleSource()) {
    // Multi-clip composition: toggle the element-driven playback tick.
    if (isCompositionPlaying()) {
      stopCompositionPlayback();
      dispatchCompositionPlayhead(currentTimelineTime(), false);
    } else {
      startCompositionPlayback();
    }
    return;
  }

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
  if (isCompositionPlaying()) {
    stopCompositionPlayback();
    dispatchCompositionPlayhead(currentTimelineTime(), false);
    return;
  }
  playRequestToken += 1;
  pendingPlayPromise = null;
  v.pause();
  if (isSimpleSingleSource()) {
    syncPlaybackState(v, { playing: false });
  } else {
    // Multi-clip but not actively playing (paused/scrubbing): the transport's
    // currentTime is not the timeline clock, so don't let syncPlaybackState pull
    // it in — just clear the playing flag and keep the composition clock.
    dispatch("playback", { playing: false });
  }
}

// ---------- multi-clip composition playback (Phase B) ----------

// The classic single-source case: zero or one clip, and that clip is backed by
// the primary transport source. These keep the untouched native-playback path;
// any real composition (extra clips, or a single non-primary clip) uses the
// tick below. This gate is what guarantees single-source playback is unchanged.
function isSimpleSingleSource() {
  const clips = (getState().composition?.tracks ?? []).flatMap((t) => t.clips ?? []);
  if (clips.length === 0) return true;
  if (clips.length > 1) return false;
  return clips[0].sourceId === primarySourceId;
}

// Write the composition playhead. Unlike syncPlaybackState (which reads the
// transport's paused/ended), `playing` is explicit because the playing element
// may be a pooled one the transport knows nothing about.
function dispatchCompositionPlayhead(t, playing = true) {
  dispatch("playback", { currentTime: normalizePlaybackTime(t), playing });
}

// Make `clip` the playing clip: pause the previous element if it differs, point
// the new element at `sourceTarget` (in-source seconds) and start it.
function setActiveCompositionClip(clip, sourceTarget) {
  const nextEl = decodeVideoForSourceId(clip.sourceId);
  if (playbackEl && playbackEl !== nextEl) {
    try { playbackEl.pause(); } catch {}
  }
  playbackClip = clip;
  playbackEl = nextEl;
  try { playbackEl.currentTime = Math.max(0, sourceTarget || 0); } catch {}
  try { playbackEl.play(); } catch {}
}

function startCompositionPlayback() {
  const t = currentTimelineTime();
  let active = getActiveVideoClip(getState().composition, t);
  const within = !!active && t >= active.clip.start && t < active.clip.start + active.clip.duration;
  if (!within) {
    // Playhead past the end / in a gap: (re)start from the first clip.
    active = firstVideoClip(getState().composition);
  }
  if (!active) return;
  // Suppress the transport's trim/sync handlers — the tick owns the clock now.
  playbackSyncSuspended = true;
  setActiveCompositionClip(active.clip, within ? active.sourceTime : active.clip.in);
  dispatchCompositionPlayhead(within ? t : active.clip.start);
  if (!rafId) startDrawLoop();
}

function stopCompositionPlayback() {
  if (playbackEl) {
    try { playbackEl.pause(); } catch {}
  }
  playbackClip = null;
  playbackEl = null;
  playbackGap = null;
  playbackSyncSuspended = false;
  stopDrawLoop();
}

// Composition playback is live whenever a clip is playing OR the playhead is
// traversing a gap between clips. Both states own the timeline clock and must be
// stopped before a manual seek / pause and kept ticking by the draw loop.
function isCompositionPlaying() {
  return Boolean(playbackClip || playbackGap);
}

// One frame of composition playback. The playing element's currentTime is the
// clock: timelineTime = clip.start + (el.currentTime - clip.in). At the clip's
// out point we roll to the next clip (or loop / stop at the composition end).
// Returns false when playback should stop. Steppable for tests by setting
// playbackEl.currentTime and calling directly.
function compositionPlaybackTick() {
  // Traversing an empty stretch: the wall clock drives the playhead, not an
  // element. Handled first because no clip/element is active during a gap.
  if (playbackGap) return compositionGapTick();

  const clip = playbackClip;
  const el = playbackEl;
  if (!clip || !el) return false;
  const elTime = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  const clipOut = clip.in + clip.duration;
  if (elTime >= clipOut - PLAYBACK_LOOP_EPSILON || el.ended) {
    const clipEndTime = clip.start + clip.duration;
    const next = nextVideoClipAfter(getState().composition, clip.id);
    if (next) {
      // Sequential clip with empty space before it: traverse the gap in real
      // time (blank frame) instead of jumping straight to the next clip.
      if (next.clip.start > clipEndTime + PLAYBACK_LOOP_EPSILON) {
        enterCompositionGap(clipEndTime, next);
        return true;
      }
      setActiveCompositionClip(next.clip, next.clip.in);
      dispatchCompositionPlayhead(next.clip.start);
      requestRenderCurrentFrame();
      return true;
    }
    if (getState().playback.loopEnabled !== false) {
      const first = firstVideoClip(getState().composition);
      if (first) {
        setActiveCompositionClip(first.clip, first.clip.in);
        dispatchCompositionPlayhead(first.clip.start);
        requestRenderCurrentFrame();
        return true;
      }
    }
    stopCompositionPlayback();
    dispatchCompositionPlayhead(timelineClockDuration(), false);
    return false;
  }
  dispatchCompositionPlayhead(clip.start + (elTime - clip.in));
  requestRenderCurrentFrame();
  return true;
}

// Begin traversing the empty stretch [fromTime, next.clip.start). No element
// decodes; compositionGapTick advances the clock and the renderer shows a blank
// frame until the next clip activates.
function enterCompositionGap(fromTime, next) {
  if (playbackEl) {
    try { playbackEl.pause(); } catch {}
  }
  playbackClip = null;
  playbackEl = null;
  playbackGap = { untilTime: next.clip.start, next };
  gapLastWallMs = performance.now();
  dispatchCompositionPlayhead(fromTime);
  requestRenderCurrentFrame();
}

// One frame while in a gap: advance the playhead by elapsed wall time × the
// transport's playback rate. When it reaches the next clip's start, activate
// that clip and hand the clock back to element-driven playback.
function compositionGapTick() {
  const gap = playbackGap;
  if (!gap) return false;
  const now = performance.now();
  const rate = Math.max(0.1, Number(ensureEls().video?.playbackRate) || 1);
  const dt = Math.max(0, (now - gapLastWallMs) / 1000) * rate;
  gapLastWallMs = now;
  const t = currentTimelineTime() + dt;
  if (t >= gap.untilTime - PLAYBACK_LOOP_EPSILON) {
    playbackGap = null;
    setActiveCompositionClip(gap.next.clip, gap.next.clip.in);
    dispatchCompositionPlayhead(gap.next.clip.start);
    requestRenderCurrentFrame();
    return true;
  }
  dispatchCompositionPlayhead(t);
  requestRenderCurrentFrame();
  return true;
}

export function seek(seconds) {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  // Scrubbing pauses multi-clip playback so the clock follows the pointer.
  if (isCompositionPlaying()) stopCompositionPlayback();
  // `seconds` is composition (timeline) time. Clamp to the full traversable
  // range — the composition extent, not the transport's duration — so the
  // playhead can reach clips past the primary source.
  const timelineTime = normalizePlaybackTime(
    Math.max(0, Math.min(timelineClockDuration(), Number(seconds) || 0))
  );
  // Resolve which clip plays here and which element decodes it.
  const active = getActiveVideoClip(getState().composition, timelineTime);
  const el = active ? decodeVideoForSourceId(active.clip.sourceId) : v;

  // Advance the timeline clock first so the render below reads the new position.
  syncPlaybackState(v, { currentTime: timelineTime });

  if (el === v) {
    // Primary / single-source: seek the transport element directly; its 'seeked'
    // handler renders. With one clip (start:0/in:0) this seeks the transport to
    // `timelineTime`, byte-identical to the pre-composition path.
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const elTarget = normalizePlaybackTime(
      Math.max(0, Math.min(duration, active ? active.sourceTime : timelineTime))
    );
    const before = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    try {
      if (Math.abs(before - elTarget) > 0.0005) v.currentTime = elTarget;
      else requestRenderCurrentFrame();
    } catch {}
  } else {
    // Non-primary clip: renderCurrentFrame's decode sync seeks the pooled element
    // to its in-source time and waits for paint, so just render at the new clock.
    requestRenderCurrentFrame();
  }
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
  clearFrameCache();
}

export function endExportSession() {
  exportSessionActive = false;
  playbackSyncSuspended = false;
  const { video: v } = ensureEls();
  if (v) syncPlaybackState(v);
}

// Seek a <video> to `target` (in-element seconds) and resolve once a fresh
// frame has actually painted. `seeked` alone is not enough: it reports the
// position update, but the <video>'s drawImage source can still hold the
// previous decoded frame. After `seeked` we wait one more paint — via
// requestVideoFrameCallback when available, with a double-rAF fallback because
// some WebViews (notably WKWebView for paused video) don't fire rVFC reliably.
// Resolves true on success, false on decode error / timeout. Shared by the
// export seek and the multi-source preview seek so both wait identically.
function seekVideoAndWaitForPaint(v, target) {
  const supportsVFC =
    typeof v.requestVideoFrameCallback === "function" &&
    v instanceof HTMLVideoElement;

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("error", onError);
      clearTimeout(timer);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      console.warn("[seek-video] failed", {
        reason,
        target,
        readyState: v.readyState,
        videoError: v.error && { code: v.error.code, message: v.error.message },
      });
      resolve(false);
    };

    const waitForPaint = () => {
      if (!supportsVFC) {
        requestAnimationFrame(() => requestAnimationFrame(succeed));
        return;
      }
      let painted = false;
      const onPaint = () => { if (!painted) { painted = true; succeed(); } };
      v.requestVideoFrameCallback(onPaint);
      requestAnimationFrame(() => requestAnimationFrame(onPaint));
    };

    const onSeeked = () => waitForPaint();
    // Tauri's asset protocol can trigger spurious `error` events during seek
    // even when no real decode failure has occurred. Only fail if v.error
    // carries an actual MediaError code; otherwise let seeked/paint resolve.
    const onError = () => {
      if (v.error && v.error.code) fail("video-error");
    };
    const timer = setTimeout(() => fail("timeout"), 5000);

    v.addEventListener("seeked", onSeeked);
    v.addEventListener("error", onError);

    try {
      v.currentTime = target;
    } catch (e) {
      fail("set-currentTime-throw:" + (e?.message || e));
    }
  });
}

export async function seekForExport(seconds) {
  const transport = ensureEls().video;
  // Composite export: when 2+ video layers are active, seek EVERY layer's
  // element to its in-source time so the composite draws the right frames.
  // Preview seeks all layers via renderCurrentFrame's decode sync; export must
  // match for parity. Single-layer / procedural keeps the original path below.
  const layers = getCompositingLayers(getState().composition, seconds);
  if (layers.length >= 2) {
    let allOk = true;
    for (const layer of layers) {
      const el = decodeVideoForSourceId(layer.clip.sourceId);
      if (!el?.src || !(el instanceof HTMLVideoElement)) continue;
      const dur = Number.isFinite(el.duration) ? el.duration : 0;
      const tgt = Math.max(0, dur ? Math.min(dur, layer.sourceTime) : layer.sourceTime);
      const cur = Number.isFinite(el.currentTime) ? el.currentTime : 0;
      if (Math.abs(cur - tgt) <= 0.0005) continue;
      const ok = await seekVideoAndWaitForPaint(el, tgt);
      if (!ok) allOk = false;
    }
    // Keep the transport clock on the timeline for export progress.
    try {
      const tdur = Number.isFinite(transport.duration) ? transport.duration : 0;
      transport.currentTime = Math.max(0, tdur ? Math.min(tdur, Number(seconds) || 0) : Number(seconds) || 0);
    } catch (_) {}
    await renderCurrentFrame({ forExport: true, timeOverride: Number(seconds) || 0 });
    return allOk;
  }
  // `seconds` is composition (timeline) time. Resolve which source plays there
  // and seek THAT element to the clip's in-source time. Single-source: the
  // active clip starts at 0/in 0, so v === transport and sourceTime === seconds
  // (byte-identical to the old single-element seek).
  const active = getActiveVideoClip(getState().composition, seconds);
  const v = active ? decodeVideoForSourceId(active.clip.sourceId) : transport;
  if (!v?.src) return false;
  // Keep the transport element's clock on the timeline so playback UI / export
  // progress stay correct, even when a different element is being decoded.
  if (transport && transport !== v) {
    try { transport.currentTime = Math.max(0, Number(seconds) || 0); } catch (_) {}
  }
  // Image sources (ImageMediaMock) have nothing to seek — render the frame.
  if (!(v instanceof HTMLVideoElement)) {
    await renderCurrentFrame({ forExport: true, timeOverride: Number(seconds) || 0 });
    return true;
  }
  const sourceSeconds = active ? active.sourceTime : Number(seconds) || 0;
  const duration = Number.isFinite(v.duration) ? v.duration : 0;
  const target = Math.max(0, Math.min(duration, sourceSeconds));
  const before = Number.isFinite(v.currentTime) ? v.currentTime : 0;

  if (Math.abs(before - target) <= 0.0005) {
    await renderCurrentFrame({ forExport: true, timeOverride: Number(seconds) || 0 });
    return true;
  }

  const ok = await seekVideoAndWaitForPaint(v, target);
  if (ok) await renderCurrentFrame({ forExport: true, timeOverride: Number(seconds) || 0 });
  return ok;
}

export function stepFrame(direction) {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  const { source, playback, timeline } = getState();
  const fps = timelineFrameRate(timeline, source.fps);
  pausePlayback();
  if (isSimpleSingleSource()) {
    // Single-source: step over the transport clock within the trim range
    // (byte-identical to the pre-composition behaviour).
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const currentFrame = timeToFrame(v.currentTime || 0, fps);
    const next = clamp(
      (currentFrame + direction) / fps,
      playback.trimStart,
      Math.max(playback.trimStart, (playback.trimEnd || duration) - 1 / fps)
    );
    seek(next);
    return;
  }
  // Multi-clip: step over the composition clock across the full timeline.
  const currentFrame = timeToFrame(currentTimelineTime(), fps);
  const limit = Math.max(0, timelineClockDuration() - 1 / fps);
  seek(clamp((currentFrame + direction) / fps, 0, limit));
}

// Apply one composition edit as a single undo/redo entry. Lives here, not in the
// pure composition.js, because history touches state. Mirrors the snapshot pattern
// in player-media-clip-drag.js. Returns true when the edit changed something.
function commitCompositionEdit(reducer, label) {
  const before = serializeComposition(getState().composition);
  dispatch("composition", reducer(getState().composition));
  const after = serializeComposition(getState().composition);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  pushHistory({
    label,
    undo: () => dispatch("composition", serializeComposition(normalizeComposition(before))),
    redo: () => dispatch("composition", serializeComposition(normalizeComposition(after))),
  });
  return true;
}

export function snapPlayhead() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  if (isSimpleSingleSource()) {
    const { playback } = getState();
    const t = v.currentTime || 0;
    const nearStart = Math.abs(t - playback.trimStart) < Math.abs(t - playback.trimEnd);
    seek(nearStart ? playback.trimStart : playback.trimEnd);
    return;
  }
  // Multi-clip: snap to the nearer edge of the active clip at the playhead.
  const t = currentTimelineTime();
  const active = getActiveVideoClip(getState().composition, t);
  if (!active) return;
  const clipStart = active.clip.start;
  const clipEnd = active.clip.start + active.clip.duration;
  const nearStart = Math.abs(t - clipStart) < Math.abs(t - clipEnd);
  seek(nearStart ? clipStart : clipEnd);
}

export function setIn() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  if (isSimpleSingleSource()) {
    const { playback } = getState();
    const next = Math.min(normalizePlaybackTime(v.currentTime || 0), playback.trimEnd - 0.01);
    const trimStart = Math.max(0, next);
    dispatch("playback", { trimStart });
    if ((v.currentTime || 0) < trimStart) seek(trimStart);
    return;
  }
  // Multi-clip: move the active clip's head (left edge) to the playhead. The same
  // source frame stays under the playhead; the clip just starts here now.
  const t = currentTimelineTime();
  const active = getActiveVideoClip(getState().composition, t);
  if (!active) return;
  const changed = commitCompositionEdit(
    (c) => trimClipStart(c, { trackId: active.track.id, clipId: active.clip.id, start: t }),
    "Trim clip in"
  );
  if (changed) requestRenderCurrentFrame();
}

export function setOut() {
  const { video: v } = ensureEls();
  if (!v?.src) return;
  if (isSimpleSingleSource()) {
    const { playback } = getState();
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const next = Math.max(normalizePlaybackTime(v.currentTime || 0), playback.trimStart + 0.01);
    const trimEnd = Math.min(duration, next);
    dispatch("playback", { trimEnd });
    if ((v.currentTime || 0) > trimEnd) seek(trimEnd);
    return;
  }
  // Multi-clip: set the active clip's tail (right edge) one frame past the
  // playhead so the current frame is the last one included (inclusive out point).
  const t = currentTimelineTime();
  const { composition, source, timeline } = getState();
  const active = getActiveVideoClip(composition, t);
  if (!active) return;
  const step = 1 / timelineFrameRate(timeline, source.fps);
  const changed = commitCompositionEdit(
    (c) => trimClipEnd(c, { trackId: active.track.id, clipId: active.clip.id, end: t + step }),
    "Trim clip out"
  );
  if (changed) requestRenderCurrentFrame();
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

// Sync read API for the most recently committed canvas. Earlier
// versions of these three accessors used to fire-and-forget a
// `requestRenderCurrentFrame()` to "freshen" the canvas before
// returning, but that side-effect was always a lie: the new render
// resolves asynchronously, so the sync return value never reflected
// it — callers always got the same canvas they would have gotten
// without the trigger. Dropping the side-effect makes the contract
// honest (saf sync read; caller is responsible for awaiting a render
// dispatch if it wants fresh pixels) and avoids the race the audit
// flagged where the fire-and-forget could land between an export
// pipeline's `await seekForExport()` and the encoder's
// `getCurrentExportFrameCanvas()` read.
//
// Today's callers (export.js still + video + sequence pipelines,
// graph-palette-actions.js palette extraction) all either run
// after an awaited `seekForExport` or read the canvas the user is
// currently looking at — both paths already have the desired
// freshness without the trigger.

export function getCurrentExportFrameCanvas(target = "viewer-output") {
  const { video: v } = ensureEls();
  if (!v || v.readyState < 2) return null;
  if (target === "dither-only") {
    return hasDitherOutput ? ditherCanvas ?? null : null;
  }
  return processedCanvas ?? null;
}

export function hasCurrentDitherFrame() {
  const { video: v } = ensureEls();
  if (!v || v.readyState < 2) return false;
  return hasDitherOutput && Boolean(ditherCanvas?.width && ditherCanvas?.height);
}

export function getCurrentSourceFrameCanvas() {
  const { video: v } = ensureEls();
  if (!v || v.readyState < 2) return null;
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

async function renderCurrentFrame(options = {}) {
  // While an export session is active, only seekForExport's awaited calls are
  // allowed to commit to processedCanvas/ditherCanvas — concurrent preview
  // renders (param changes, resize, timeline scrub, listener dispatches) can
  // race the export pipeline's await points and overwrite the canvases the
  // encoder is about to read, leaking preview frames into the exported video.
  // The forExport flag is the export pipeline's opt-in to bypass this guard.
  if (exportSessionActive && !options.forExport) return;
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
  // Authoritative composition time for this render. Preview reads the timeline
  // clock (playback.currentTime); export passes the exact frame time through
  // options.timeOverride (seekForExport doesn't write playback state). Single-
  // source: playback.currentTime === transport currentTime, byte-identical to
  // the old v.currentTime path.
  const timelineTime = options.timeOverride != null
    ? Number(options.timeOverride) || 0
    : currentTimelineTime();
  // Resolve the active video clips bottom-to-top. With 0 or 1 layer this runs
  // the original single-element path verbatim (byte-identical); with 2+ layers
  // it composites them with per-track blend/opacity. Both paths write
  // sourceCanvas + a frame-cache key, so everything downstream (graph, worker,
  // export) is unchanged and preview/export stay in parity.
  const layers = getCompositingLayers(getState().composition, timelineTime);
  let frameKey;
  if (layers.length >= 2) {
    // --- multi-layer compositing ---
    // The bottom layer's element sizes the canvas; upper layers scale to fit.
    const baseEl = decodeVideoForSourceId(layers[0].clip.sourceId) || v;
    ensureFrameBuffers(baseEl.videoWidth || v.videoWidth, baseEl.videoHeight || v.videoHeight);
    frameKey = compositeFrameKey(timelineTime, layers);
    if (!exportSessionActive && frameKey !== null && !frameCache.has(frameKey)) {
      // Seek every pooled (non-transport) layer to its in-source time and wait
      // for paint before compositing. The primary layer rides the transport
      // clock and needs no seek.
      for (const layer of layers) {
        const el = decodeVideoForSourceId(layer.clip.sourceId);
        if (!el || el === v || el.readyState < 1 || !(el instanceof HTMLVideoElement)) continue;
        const dur = Number.isFinite(el.duration) ? el.duration : 0;
        const target = Math.max(0, dur ? Math.min(dur, layer.sourceTime) : layer.sourceTime);
        if (Math.abs((el.currentTime || 0) - target) > 0.001) {
          const ok = await seekVideoAndWaitForPaint(el, target);
          if (!ok || isStaleRender(currentRenderVersion, currentSourceToken)) return;
        }
      }
    }
    drawCompositeFrame(layers, frameKey);
  } else {
    // --- single-layer path (verbatim pre-compositing behaviour) ---
    // Decode element for the clip under the playhead. With one source this is
    // the transport element `v` itself (byte-identical to the old path); with
    // several sources it's the pooled element for the active clip's file.
    const activeEntry = getActiveVideoClip(getState().composition, timelineTime);
    // Multi-clip gap: the playhead sits in an empty stretch (no clip on any
    // track). Show a blank frame instead of the stale transport element, run
    // through the normal chain so preview and export match. Single-source /
    // empty compositions keep the transport fallback (byte-identical).
    const isGap = !activeEntry && !isSimpleSingleSource();
    const decodeVideo = (activeEntry ? decodeVideoForSourceId(activeEntry.clip.sourceId) : v) || v;
    const decodeWidth = decodeVideo.videoWidth || v.videoWidth;
    const decodeHeight = decodeVideo.videoHeight || v.videoHeight;
    ensureFrameBuffers(decodeWidth, decodeHeight);
    // Cache key is derived from the TIMELINE clock + the active clip's source id,
    // never from the decode element's own currentTime (which is the clip's in-
    // source time and would collide across clips of one file). Gaps share one
    // stable key so the blank frame is memoised once.
    frameKey = isGap ? `${frameCacheStamp}|gap` : compositionFrameKey(timelineTime, activeEntry?.clip.sourceId);
    // Multi-source preview: a clip backed by a pooled (non-transport) element
    // isn't driven by the transport clock, so its element sits at whatever time
    // it was last left on. Seek it to the clip's in-source time and wait for the
    // frame to paint before drawing — but only when that frame isn't already
    // cached and the element has actually moved. Single-source / primary-source
    // clips keep decodeVideo === v and skip this entirely (byte-identical to the
    // pre-multi-source path). During live playback this seeks the secondary clip
    // per frame (lower fps, still correct); primary playback is untouched.
    if (
      decodeVideo !== v &&
      activeEntry &&
      !exportSessionActive &&
      decodeVideo instanceof HTMLVideoElement &&
      decodeVideo.readyState >= 1 &&
      frameKey !== null &&
      !frameCache.has(frameKey)
    ) {
      const dur = Number.isFinite(decodeVideo.duration) ? decodeVideo.duration : 0;
      const target = Math.max(0, dur ? Math.min(dur, activeEntry.sourceTime) : activeEntry.sourceTime);
      if (Math.abs((decodeVideo.currentTime || 0) - target) > 0.001) {
        const ok = await seekVideoAndWaitForPaint(decodeVideo, target);
        if (!ok || isStaleRender(currentRenderVersion, currentSourceToken)) return;
      }
    }
    if (isGap) drawBlankSourceFrame(frameKey);
    else drawSourceFrame(decodeVideo, frameKey);
  }

  // sourceVersion is the cache identity of the current source frame. It only
  // changes when the painted contents change (new frame, new source), so the
  // node memo cache can hit on paused-video param tweaks.
  const baseSourceVersion = frameKey ?? `live-${currentRenderVersion}`;

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

  const timelineContext = createTimelineRenderContext(v, timelineTime);
  // Decode any source nodes bound to a specific media source (params.sourceId)
  // at the timeline time, so the graph can read them independently of the clips.
  const sourceFrames = await resolveBoundSourceFrames(
    graph, timelineContext.timeSeconds, currentRenderVersion, currentSourceToken
  );
  if (isStaleRender(currentRenderVersion, currentSourceToken)) return;
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
    !graphRequiresMainThreadRender(graph) &&
    // GPU-effect graphs are sent to the worker optimistically; once it reports
    // it can't build a WebGL2 renderer, they stay on the main thread (parity).
    (!graphContainsGpuEffect(graph) || !workerKnownGpuUnsupported()) &&
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
    if (!result) return; // stale request — leave the last good frame on screen
    if (isStaleRender(currentRenderVersion, currentSourceToken)) {
      closeWorkerRenderResult(result);
      return;
    }
    if (!result.fallbackToMainThread) {
      commitProcessedFrame(result.viewerBitmap);
      commitDitherFrame(result.ditherBitmap);
      closeWorkerRenderResult(result);
      presentPreview();
      return;
    }
  }

  const graphOutputs = evaluateGraphOutputs(graph, {
    sourceImage: sourceForEval,
    sourceVersion,
    ...timelineContext,
    sourceFrames,
  }) ?? { viewerOutput: null, ditherOutput: null };
  const graphOutput = graphOutputs.viewerOutput;

  commitProcessedFrame(graphOutput);
  commitDitherFrame(graphOutputs.ditherOutput);
  recyclePreviewOutput(graphOutput);
  recyclePreviewOutput(graphOutputs.ditherOutput);
  presentPreview();
  queueNativePreview(nativeRenderGraph, currentRenderVersion, currentSourceToken);
}

function requestRenderCurrentFrame() {
  void renderCurrentFrame().catch((error) => {
    console.error("[source] render failed", error);
  });
}

function isStaleRender(currentRenderVersion, currentSourceToken) {
  return currentRenderVersion !== renderVersion || currentSourceToken !== sourceToken;
}

function closeWorkerRenderResult(result) {
  if (!result) return;
  if (result.viewerBitmap) {
    try {
      result.viewerBitmap.close();
    } catch {}
  }
  if (result.ditherBitmap) {
    try {
      result.ditherBitmap.close();
    } catch {}
  }
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

function drawSourceFrame(v, key = null) {
  if (!sourceCtx || !sourceCanvas) return;
  // Export drives back-to-back seeks where `<video>.drawImage` can briefly
  // read the previous decoded frame. Caching those pixels under the new
  // frame's key would poison subsequent reads, so always draw fresh while
  // the export session is active.
  if (exportSessionActive) {
    sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    sourceCtx.drawImage(v.drawable || v, 0, 0, sourceCanvas.width, sourceCanvas.height);
    return;
  }
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

// Paint a blank (black) source frame for a timeline gap. The 2D contexts use
// alpha:false, so clearRect yields opaque black. Mirrors drawSourceFrame's
// cache + export-fresh behaviour so the gap frame flows through the normal
// chain and preview/export stay in parity.
function drawBlankSourceFrame(key = null) {
  if (!sourceCtx || !sourceCanvas) return;
  if (exportSessionActive) {
    sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    return;
  }
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
  if (key !== null) cacheCurrentFrame(key);
}

// Frame-cache identity for composition time `timelineTime`. Keyed by the active
// clip's source id + the frame index, so frames from different source files
// can't collide. Single-source resolves to a constant source id, matching the
// pre-multi-source behaviour.
function compositionFrameKey(timelineTime, sourceId) {
  if (!Number.isFinite(timelineTime)) return null;
  const fps = getState().source.sourceFps || 30;
  if (!fps) return null;
  return `${frameCacheStamp}|${sourceId ?? "live"}|${timeToFrame(timelineTime, fps)}`;
}

// Frame-cache identity for a composited stack: every layer's source id + frame
// index + opacity + blend mode, in paint order. Distinct from the single-clip
// key so composited and un-composited frames never collide in the cache.
function compositeFrameKey(timelineTime, layers) {
  if (!Number.isFinite(timelineTime) || !layers?.length) return null;
  const fps = getState().source.sourceFps || 30;
  if (!fps) return null;
  const parts = layers.map((l) => {
    const frame = timeToFrame(l.sourceTime, fps);
    const op = Math.round(l.track.opacity ?? 100);
    const blend = l.track.blendMode || "normal";
    return `${l.clip.sourceId}:${frame}:${op}:${blend}`;
  });
  return `${frameCacheStamp}|comp|${parts.join("|")}`;
}

// Canvas2D globalCompositeOperation names that double as composition blend
// modes (they share names with CSS mix-blend-mode). "normal" and anything
// unknown fall back to source-over.
const CANVAS_BLEND_MODES = new Set([
  "multiply", "screen", "overlay", "darken", "lighten", "color-dodge",
  "color-burn", "hard-light", "soft-light", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity",
]);
function blendModeToCanvas(mode) {
  return CANVAS_BLEND_MODES.has(mode) ? mode : "source-over";
}

// Composite `layers` (bottom-to-top) into sourceCanvas with per-track opacity
// (globalAlpha) and blend mode (globalCompositeOperation). The base layer always
// paints source-over; upper layers use their track's blend mode. Mirrors
// drawSourceFrame's cache + export-fresh behaviour so preview and export match.
function drawCompositeFrame(layers, key = null) {
  if (!sourceCtx || !sourceCanvas) return;
  if (!exportSessionActive && key !== null) {
    const cached = frameCache.get(key);
    if (cached) {
      frameCache.delete(key);
      frameCache.set(key, cached);
      sourceCtx.drawImage(cached, 0, 0, sourceCanvas.width, sourceCanvas.height);
      return;
    }
  }
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  sourceCtx.clearRect(0, 0, w, h);
  sourceCtx.save();
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const el = decodeVideoForSourceId(layer.clip.sourceId);
    if (!el) continue;
    sourceCtx.globalAlpha = clamp((layer.track.opacity ?? 100) / 100, 0, 1);
    sourceCtx.globalCompositeOperation = i === 0 ? "source-over" : blendModeToCanvas(layer.track.blendMode);
    sourceCtx.drawImage(el.drawable || el, 0, 0, w, h);
  }
  sourceCtx.restore();
  if (!exportSessionActive && key !== null) cacheCurrentFrame(key);
}

// Build the per-source frame map for graph source nodes bound to a media source
// (params.sourceId). Each bound source is decoded at the current timeline time,
// clamped to its own duration (it plays along, then holds on its last frame).
// Video elements seek + wait for paint; image mocks are static. Returns null
// when nothing is bound. Forces main-thread render (graphRequiresMainThreadRender),
// and unlike clip layers nothing else seeks these elements, so it seeks during
// export too (parity).
async function resolveBoundSourceFrames(graph, timelineTime, renderVer, srcToken) {
  const ids = new Set();
  for (const node of graph?.nodes ?? []) {
    if (node?.type === "source" && node.params?.sourceId && !node.bypassed && node.visible !== false) {
      ids.add(node.params.sourceId);
    }
  }
  if (ids.size === 0) return null;

  const fps = getState().source.sourceFps || 30;
  const sources = getState().composition?.sources ?? [];
  const frames = {};
  for (const sourceId of ids) {
    const el = decodeVideoForSourceId(sourceId);
    if (!el) continue;
    const meta = sources.find((s) => s.id === sourceId);
    const dur = Number(meta?.duration) || (Number.isFinite(el.duration) ? el.duration : 0);
    const target = Math.max(0, dur ? Math.min(dur, timelineTime) : timelineTime);
    if (el instanceof HTMLVideoElement) {
      if (el.readyState >= 1 && Math.abs((el.currentTime || 0) - target) > 0.001) {
        const ok = await seekVideoAndWaitForPaint(el, target);
        if (!ok) continue;
        if (isStaleRender(renderVer, srcToken)) return null;
      }
    } else {
      // ImageMediaMock and friends: static frame, no real seek.
      try { el.currentTime = target; } catch (_) {}
    }
    const w = el.videoWidth || el.naturalWidth || 0;
    const h = el.videoHeight || el.naturalHeight || 0;
    if (!w || !h) continue;
    let canvas = boundSourceCanvases.get(sourceId);
    if (!canvas) {
      canvas = document.createElement("canvas");
      boundSourceCanvases.set(sourceId, canvas);
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const cx = canvas.getContext("2d", { alpha: false });
    cx.drawImage(el.drawable || el, 0, 0, w, h);
    frames[sourceId] = {
      canvas,
      version: `${frameCacheStamp}|bound|${sourceId}|${timeToFrame(target, fps)}`,
    };
  }
  return Object.keys(frames).length ? frames : null;
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

function createTimelineRenderContext(v, timelineTime) {
  const state = getState();
  const fps = state.source.fps || 30;
  const rawTime = timelineTime != null
    ? timelineTime
    : (Number.isFinite(v?.currentTime) ? v.currentTime : state.playback.currentTime);
  const timeSeconds = normalizePlaybackTime(rawTime, fps);
  // V3: resolve the active media clip at this composition time. Ship 1 is
  // single-source (the load-time migration makes one clip at start=0/in=0, so
  // its sourceTime === timeSeconds and the existing single-<video> render path
  // stays pixel-identical). The resolved clip is attached to the context so the
  // clip-cache key and later multi-source/compositing phases can consume it
  // without changing this call site. Both preview and export go through here,
  // keeping them in parity.
  const activeClip = getActiveVideoClip(state.composition, timeSeconds);
  return {
    timeline: state.timeline,
    timeSeconds,
    durationSeconds: state.source.duration || v?.duration || 0,
    fps,
    activeClip,
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
  // The native GL preview only has the clip composite (sourceCanvas), so it
  // can't render bound source nodes — skip it for main-thread-only graphs and
  // let the JS eval's correct result stand.
  if (!canUseNativeRender(renderGraph) || graphRequiresMainThreadRender(renderGraph)) {
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
    // Multi-clip composition playback drives its own clock and clip boundaries.
    // Single-source leaves playbackClip null and runs the untouched body below.
    if (isCompositionPlaying()) {
      rafId = compositionPlaybackTick() ? requestAnimationFrame(tick) : 0;
      return;
    }
    if (!playbackSyncSuspended) {
      if (!enforceTrimPlayback(v)) {
        syncPlaybackState(v);
        // Clear the scheduler flag so any queued render in this frame is
        // suppressed — tick already covered this paint.
        renderQueued = false;
        requestRenderCurrentFrame();
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
    requestRenderCurrentFrame();
    return true;
  }

  try {
    v.currentTime = trimEnd;
  } catch {}
  v.pause();
  syncPlaybackState(v, { currentTime: trimEnd, playing: false });
  requestRenderCurrentFrame();
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
