/* Central reactive store and history stack. Topics are keys on the state object. */

export const DEFAULT_GRAPH_VIEW = Object.freeze({
  zoom: 1,
  panX: -7820,
  panY: -7904,
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
  },
  playback: {
    playing: false,
    currentTime: 0,
    trimStart: 0,
    trimEnd: 0,
    loopEnabled: true,
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
  },
  graph: {
    nodes: [],
    edges: [],
    selectedNodeId: null,
  },
  graphView: { ...DEFAULT_GRAPH_VIEW },
  ab: { a: null, b: null },
};

const listeners = new Map();

export function getState() {
  return state;
}

export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  fn(state[topic]);
  return () => listeners.get(topic)?.delete(fn);
}

export function dispatch(topic, patch) {
  const slot = state[topic];
  if (!slot) return;
  Object.assign(slot, patch);
  const subs = listeners.get(topic);
  if (subs) for (const fn of subs) fn(slot);
}

const undoStack = [];
const redoStack = [];

export function pushHistory(entry) {
  undoStack.push(entry);
  redoStack.length = 0;
  syncHistoryButtons();
}

export function undo() {
  const e = undoStack.pop();
  if (!e) return;
  e.undo();
  redoStack.push(e);
  syncHistoryButtons();
}

export function redo() {
  const e = redoStack.pop();
  if (!e) return;
  e.redo();
  undoStack.push(e);
  syncHistoryButtons();
}

export function syncHistoryButtons() {
  const u = document.querySelector('[data-action="undo"]');
  const r = document.querySelector('[data-action="redo"]');
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}
