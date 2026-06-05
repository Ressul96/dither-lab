// Color tokens: a small central registry of named colors. A node color param can
// hold either a literal hex ("#rrggbb") or a reference "token:<id>". References
// are resolved to the token's value at render time (resolveGraphTokens), so a
// color defined once propagates everywhere it is used. Mirrors the palette
// registry (palettes.js): central Map, change-notify, project persistence.
//
// Parity: resolveGraphTokens runs at the single render-graph chokepoint in
// source.js, before both the CPU eval and the GPU bake derive from it, so a
// token reference and its literal value render identically in preview and export.

const REGISTRY = new Map();
const LISTENERS = new Set();
const TOKEN_PREFIX = "token:";

let idCounter = 0;

function normalizeHex(value, fallback = "#000000") {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return fallback;
}

export function listTokens() {
  return [...REGISTRY.values()].map((token) => ({ ...token }));
}

export function getToken(id) {
  const token = REGISTRY.get(id);
  return token ? { ...token } : null;
}

export function makeTokenId(seed) {
  const base =
    String(seed || "token")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "token";
  let id = base;
  while (REGISTRY.has(id)) id = `${base}-${++idCounter}`;
  return id;
}

export function createToken(name, value) {
  const id = makeTokenId(name);
  REGISTRY.set(id, { id, name: name || "Untitled", value: normalizeHex(value) });
  notify();
  return id;
}

export function updateToken(id, patch = {}) {
  const token = REGISTRY.get(id);
  if (!token) return;
  REGISTRY.set(id, {
    id,
    name: patch.name != null ? String(patch.name) : token.name,
    value: patch.value != null ? normalizeHex(patch.value, token.value) : token.value,
  });
  notify();
}

export function removeToken(id) {
  if (REGISTRY.delete(id)) notify();
}

export function isTokenRef(value) {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX);
}

export function tokenRef(id) {
  return `${TOKEN_PREFIX}${id}`;
}

export function tokenIdFromRef(value) {
  return isTokenRef(value) ? value.slice(TOKEN_PREFIX.length) : null;
}

// Resolve one param value: a "token:<id>" reference becomes the token's hex;
// anything else is returned unchanged. An unknown token id keeps the raw ref
// (a missing token must not crash the render).
export function resolveTokenValue(value) {
  if (!isTokenRef(value)) return value;
  const token = REGISTRY.get(value.slice(TOKEN_PREFIX.length));
  return token ? token.value : value;
}

// Return a graph whose node params have every "token:<id>" reference replaced by
// the token's value. When nothing references a token (the common case), the
// input graph is returned unchanged (no clone) so the render hot path stays cheap.
export function resolveGraphTokens(graph) {
  if (!graph?.nodes?.length || REGISTRY.size === 0) return graph;
  let graphTouched = false;
  const nodes = graph.nodes.map((node) => {
    const params = node.params;
    if (!params) return node;
    let nextParams = null;
    for (const key in params) {
      if (isTokenRef(params[key])) {
        if (!nextParams) nextParams = { ...params };
        nextParams[key] = resolveTokenValue(params[key]);
      }
    }
    if (!nextParams) return node;
    graphTouched = true;
    return { ...node, params: nextParams };
  });
  return graphTouched ? { ...graph, nodes } : graph;
}

export function serializeTokens() {
  return listTokens().map((token) => ({ id: token.id, name: token.name, value: token.value }));
}

export function applyTokens(entries) {
  REGISTRY.clear();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry?.id || typeof entry.value !== "string") continue;
      REGISTRY.set(entry.id, {
        id: entry.id,
        name: entry.name || "Untitled",
        value: normalizeHex(entry.value),
      });
    }
  }
  notify();
}

export function subscribeTokens(fn) {
  LISTENERS.add(fn);
  return () => LISTENERS.delete(fn);
}

function notify() {
  for (const fn of LISTENERS) {
    try {
      fn();
    } catch (err) {
      console.error("[tokens] listener error", err);
    }
  }
}
