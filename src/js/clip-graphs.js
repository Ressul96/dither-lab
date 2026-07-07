// Per-clip effect graph registry. A timeline clip's `graphId` references an
// entry here; `null` means the clip uses the shared global graph (the default,
// so existing projects are unchanged). Storing graphs by id (not inline on the
// clip) keeps the composition light and lets clips share one graph. Mirrors the
// token / palette registries: central Map, change-notify, project persistence.
//
// This is increment 1 of per-clip-graphs (see docs/spec/per-clip-graphs.md): the
// storage model only. The render integration and editing UI build on it.

const REGISTRY = new Map();
const LISTENERS = new Set();
let idCounter = 0;

export function listClipGraphs() {
  return [...REGISTRY.entries()].map(([id, graph]) => ({ id, graph }));
}

export function getClipGraph(id) {
  return id != null && REGISTRY.has(id) ? REGISTRY.get(id) : null;
}

export function hasClipGraph(id) {
  return id != null && REGISTRY.has(id);
}

export function makeClipGraphId() {
  let id;
  do {
    id = `clipgraph-${++idCounter}`;
  } while (REGISTRY.has(id));
  return id;
}

// Register (or replace) a clip graph. Returns the id (generated when omitted).
export function setClipGraph(id, graph) {
  const key = id ?? makeClipGraphId();
  REGISTRY.set(key, graph);
  notify();
  return key;
}

export function removeClipGraph(id) {
  if (REGISTRY.delete(id)) notify();
}

// Drop registry entries no longer referenced by any clip (call with the set of
// graphIds still in use after a composition edit / project load).
export function pruneClipGraphs(referencedIds) {
  const keep = referencedIds instanceof Set ? referencedIds : new Set(referencedIds ?? []);
  let changed = false;
  for (const id of [...REGISTRY.keys()]) {
    if (!keep.has(id)) {
      REGISTRY.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}

export function serializeClipGraphs() {
  return listClipGraphs();
}

export function applyClipGraphs(entries) {
  REGISTRY.clear();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry?.id && entry.graph) REGISTRY.set(entry.id, entry.graph);
    }
  }
  notify();
}

export function subscribeClipGraphs(fn) {
  LISTENERS.add(fn);
  return () => LISTENERS.delete(fn);
}

function notify() {
  for (const fn of LISTENERS) {
    try {
      fn();
    } catch (err) {
      console.error("[clip-graphs] listener error", err);
    }
  }
}
