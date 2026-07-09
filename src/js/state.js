/* Central reactive store and history stack. Topics are keys on the state object. */

export const DEFAULT_GRAPH_VIEW = Object.freeze({
  zoom: 1,
  panX: -7820,
  panY: -7904,
  currentParentId: "root",
  // Per-clip graph editing scope. null = editing the shared global graph (the
  // default). When set, the node editor is editing a clip's own graph: `state.graph`
  // holds that clip graph and the global graph is stashed (graph.js). Transient —
  // not persisted, so a freshly loaded project always starts on the global graph.
  clipGraphId: null,
  clipScopeClipId: null,
});

const state = {
  source: {
    loaded: false,
    path: "",
    duration: 0,
    sourceFps: 30,
    fps: 30,
    videoWidth: 0,
    videoHeight: 0,
    mediaKind: null,
    exrLayers: [],
    exrPasses: [],
    exrSelectedPass: null,
    exrPattern: null,
  },
  playback: {
    playing: false,
    currentTime: 0,
    trimStart: 0,
    trimEnd: 0,
    loopEnabled: true,
    // Independent slow/fast-motion control. Decoupled from viewer-output.fps,
    // which is now strictly an export target. Range 0.1 – 4.0; 1.0 = realtime.
    speed: 1,
  },
  view: {
    zoom: 1,
    fit: true,
    panX: 0,
    panY: 0,
    pixelInspector: false,
    compare: "processed",
    splitPosition: 0.5,
    // "auto" runs the effect chain at half-res during playback for speed and
    // jumps back to full-res when paused; "full" always processes at source
    // resolution so the live preview matches the export pixel-for-pixel.
    playbackQuality: "auto",
    renderBackend: "js",
    // F8 worker track. "auto" (default) routes live video playback to the
    // worker — that is where main-thread jank is most visible — and keeps
    // paused frames, image sources, and procedural sources on the main
    // thread so parameter tweaks reflect with zero adapter overhead. "on"
    // forces the worker for every preview render; "off" disables it.
    workerRender: "auto",
  },
  graph: {
    nodes: [],
    edges: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    solo: null,
  },
  timeline: {
    version: 1,
    duration: 0,
    fps: 30,
    loop: true,
    autokey: false,
    tracks: [],
    // 1B-i UI state. Not wired to the DOM yet; 1B-ii hooks the layout reform
    // up to these fields. Persisted across project save/load via timeline.js.
    viewMode: "layers",         // "layers" | "graph"
    durationUnit: "frame",      // "frame" | "second"
    zoom: 1,                    // ruler zoom multiplier (0.25 – 8)
    panelOpen: false,           // unified floating overlay body expanded; default collapsed so the canvas isn't covered on first launch
    selectedPropertyId: null,   // string | null — active property in the left panel
    expandedTrackIds: [],       // collapsed-by-default; user opens a lane explicitly
  },
  graphView: { ...DEFAULT_GRAPH_VIEW },
  ab: { a: null, b: null },
  // V3 multi-track clip timeline. Structurally separate from `timeline` (which
  // is parameter keyframes): `composition` models WHAT source content exists at
  // a given time. Populated by a single-clip migration on source load; the full
  // model + queries live in composition.js. Empty until a source is loaded.
  composition: {
    version: 1,
    fps: 30,
    duration: 0,
    tracks: [],
    sources: [],
  },
};

const listeners = new Map();
const MAX_HISTORY_ENTRIES = 200;

export function getState() {
  return state;
}

export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  notifySubscriber(topic, fn, state[topic]);
  return () => listeners.get(topic)?.delete(fn);
}

export function dispatch(topic, patch) {
  const slot = state[topic];
  if (!slot) {
    console.warn(`[state] dispatch to unknown topic "${topic}" ignored`, patch);
    return;
  }
  state[topic] = { ...slot, ...patch };
  const subs = listeners.get(topic);
  if (subs) {
    for (const fn of [...subs]) notifySubscriber(topic, fn, state[topic]);
  }
}

const undoStack = [];
const redoStack = [];

// History-activity hook: fires on every push/undo/redo. Used by project.js to
// track unsaved changes without a state.js -> project.js import cycle.
const historyListeners = new Set();

export function subscribeHistory(fn) {
  historyListeners.add(fn);
  return () => historyListeners.delete(fn);
}

function notifyHistoryListeners() {
  for (const fn of [...historyListeners]) {
    try {
      fn();
    } catch (error) {
      console.error("[state] history listener failed", error);
    }
  }
}

export function pushHistory(entry) {
  undoStack.push(entry);
  if (undoStack.length > MAX_HISTORY_ENTRIES) undoStack.shift();
  redoStack.length = 0;
  syncHistoryButtons();
  notifyHistoryListeners();
}

export function undo() {
  const e = undoStack.pop();
  if (!e) return;
  e.undo();
  redoStack.push(e);
  syncHistoryButtons();
  notifyHistoryListeners();
}

export function redo() {
  const e = redoStack.pop();
  if (!e) return;
  e.redo();
  undoStack.push(e);
  syncHistoryButtons();
  notifyHistoryListeners();
}

export function syncHistoryButtons() {
  if (typeof document === "undefined") return;
  const u = document.querySelector('[data-action="undo"]');
  const r = document.querySelector('[data-action="redo"]');
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}

function notifySubscriber(topic, fn, slot) {
  try {
    fn(slot);
  } catch (error) {
    console.error(`[state] subscriber for "${topic}" failed`, error);
  }
}
