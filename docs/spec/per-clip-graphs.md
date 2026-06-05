# Per-Clip Effect Graphs — Design

## What This Is

Today every clip on the timeline is processed by the one global node graph
(`state.graph`). This doc specs **per-clip graphs**: each timeline clip may carry
its own effect graph, so different clips can be graded/dithered differently while
the global graph remains the default. It is the design pass the roadmap calls for
before coding; the build is staged in increments at the end.

Note: "a node graph inside every layer" (caddis feature #1) is already satisfied
for *node groups* (`groupSelectedNodes` + boundary bindings). This doc is about
*timeline clips*, which is a different axis (WHAT plays when vs. HOW a fabric is
organised).

## Data Model

Clips already carry `graphId: null` (see `composition.js normalizeClip`). Define:

- A **clip-graph registry**, `clipGraphs.js`, mirroring `tokens.js` / `palettes.js`:
  a `Map<graphId, serializedGraph>` with CRUD, change-notify (`subscribeClipGraphs`),
  and `serializeClipGraphs()` / `applyClipGraphs(entries)` for persistence.
- `clip.graphId`:
  - `null` → the clip uses the **shared global graph** (`state.graph`). This is the
    default and keeps every existing project byte-identical.
  - a string id → the clip uses `clipGraphs.get(id)`.
- Graphs are stored once and referenced by id, so two clips can share a graph
  (duplicate-clip keeps the same `graphId`; "make unique" clones it).

Why a registry (not inline in the clip): keeps `composition` light, lets clips
share a graph, and reuses the established registry+persistence pattern.

## Render Integration (the parity-critical part)

`renderCurrentFrame` resolves the graph once at a single chokepoint
(`const graph = resolveGraphTokens(ensureBootGraph())`). Extend that to pick the
clip's graph:

- Single-layer path: resolve the active video clip; if `clip.graphId`, evaluate
  `clipGraphs.get(graphId)` instead of the global graph for that frame.
- Compositing path: each layer already resolves its own clip; evaluate **each
  layer through its own clip graph** before blending. (Layers without a graphId use
  the global graph — unchanged.)
- A clip graph still needs a `source` + `viewer-output`; when a clip graph is
  created it is seeded from the current global graph (or a minimal source→viewer)
  so it is immediately valid.

Parity: preview and export both run `renderCurrentFrame`, so resolving the
clip graph at the same chokepoint keeps them identical. The per-clip graph must
be resolved for tokens too (`resolveGraphTokens`) at that point. Determinism is
unchanged (graph selection is a pure function of the active clip).

Worker/GPU: a clip with a non-null graphId forces main-thread render for that
frame initially (like bound sources), since the worker assumes one graph. Lifting
that to send the active clip graph to the worker is a later optimisation.

## Editing UX

- **Enter a clip's graph**: double-click a clip (Clips view) → the node editor
  switches to that clip's graph. A breadcrumb ("Composition › Clip 3 graph")
  shows scope, like the existing group breadcrumb.
- Switching scope swaps which graph `state.graph` mirrors: on enter, load the
  clip graph into the editable slot; on exit, write it back to the registry. (Or
  keep `state.graph` as the global graph and add `state.activeGraphScope` that the
  editor/inspector read — cleaner but a wider change. Pick during build.)
- **Add graph to clip**: a clip with `graphId: null` shows "Add clip graph" →
  clones the global graph into the registry, sets `graphId`. **Remove** reverts to
  `null` (shared). **Make unique** clones a shared graph so edits don't affect
  siblings.
- One atomic history entry per assign/clone/remove (snapshot the composition +
  registry, like `commitCompositionEdit`).

## Persistence

- `project.js buildProjectPayload`: add `clipGraphs: serializeClipGraphs()` next
  to `composition` / `customPalettes` / `tokens`.
- `applyProject`: `applyClipGraphs(project.clipGraphs ?? [])` before composition
  restore. `newProject`: `applyClipGraphs([])`.
- `clip.graphId` already round-trips inside the serialized composition.

## Build Increments (each independently shippable + verifiable)

1. **Model** — `clipGraphs.js` registry + persistence + a `setClipGraph` /
   `clearClipGraph` reducer. `graphId` stays null everywhere → zero behavior
   change. Verify: registry CRUD, persistence round-trip, existing render
   unchanged. (Low risk, purely additive.)
2. **Render** — resolve the clip's graph at the render chokepoint (single-layer
   then compositing), main-thread-guarded. Verify: a clip bound to a distinct
   graph renders differently from a clip on the shared graph; single-source stays
   byte-identical; preview == export.
3. **Editing UI** — Clips-view double-click to enter, breadcrumb, add/remove/make-
   unique actions, atomic history. Verify: scope switch, edits isolated per clip,
   undo/redo.

## Risks

- **Scope-switch refactor** (which graph the editor edits) is the widest change;
  the `activeGraphScope` option is cleaner than swapping `state.graph` in place.
  Prototype both on a branch.
- **Compositing × per-clip graphs** multiplies evaluation cost (N layers × graph
  eval). Memoisation already keys per node; acceptable for small N.
- **Worker** stays main-thread for clip-graph frames until the worker learns to
  accept a per-frame graph.
