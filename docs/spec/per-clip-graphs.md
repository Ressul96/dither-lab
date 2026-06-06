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

1. **Model** — DONE (`clip-graphs.js` registry + persistence). Registry CRUD,
   change-notify, `serialize/applyClipGraphs`, project round-trip; `graphId`
   stays null everywhere so existing projects are unchanged.
2. **Render** — DONE (single-layer path). The render chokepoint reassigns the
   resolved `graph` to the active clip's registered graph (`source.js`
   `renderCurrentFrame`), so every downstream path — worker, CPU eval, native
   GPU preview, bound sources, export — reads one binding. No main-thread force
   was needed: the worker already receives the full graph per frame, so a clip
   graph flows through it correctly. Verified on a real video: a clip with a
   distinct graph (brightness +100) renders white while the shared-graph frame is
   unchanged, on both the main-thread/export path and the worker; `graphId: null`
   round-trips byte-identically. Compositing (2+ layers) still uses the global
   graph — per-layer clip graphs in the composite are a later step (each layer
   would evaluate its own clip graph before blending, restructuring
   `drawCompositeFrame`).
3. **Editing UI** — PARTIAL. The low-risk half is shipped: a per-clip **FX
   badge** in the Clips view (`media-clip-fx`) toggles a clip's own graph. Pin =
   clone the current global graph into the registry and point the clip at it
   (`toggleClipGraphById` → `setClipGraphId` reducer, atomic composition
   history); unpin = detach back to the shared graph. The clone is a snapshot
   (verified: mutating the global graph after pinning does not change the clip's
   graph), so a clip keeps its look while the global graph evolves. The registry
   entry is intentionally left on detach so undo/redo restore the reference.
   Verified end to end: pin → edit the clip's graph → only that clip renders the
   change; unpin → back to the shared look; undo/redo round-trip; markup badge
   reflects state.

   The remaining half — **editing a clip's graph in place in the node editor**
   (double-click to enter, breadcrumb, make-unique) — is NOT built. It is the
   widest change and turns on the architecture decision below; the pin/unpin
   slice covers the headline "give clips distinct looks" workflow without it (set
   the global look, pin; repeat), so the in-editor scope-switch can be done
   deliberately on its own branch.

   Finding from the increment-2 work: the editor's existing "scope" is
   `graphView.currentParentId`, which only *filters nodes by parentId within the
   single `state.graph`* (group navigation) — it is **not** a graph switch, and
   the breadcrumb is tied to it. So clip-graph editing needs a genuinely new
   graph-switch scope; it does not piggyback on the group scope.

   Recommended architecture (over swapping `state.graph` in place): add
   `state.graphView.clipGraphId` (null = editing the global graph). Keep
   `state.graph` *always* the global graph so the render base is never disturbed
   — the increment-2 selection already overrides per-clip at the chokepoint, and
   if the editor swapped `state.graph` to a clip graph, frames on *other* clips
   (graphId null) would wrongly use the edited clip graph as their base. The
   editor (graph.js central accessors + the ~7 UI files that read
   `getState().graph`: node-drag, socket-drag, render, actions, inspector,
   shell, view-scope) must route through a `getEditableGraph()` /
   `mutateEditableGraph()` indirection that targets the clip graph (writing back
   via `setClipGraph`) when `clipGraphId` is set. That routing is the wide,
   regression-prone part — it touches the core editor, so it warrants its own
   focused branch + the existing graph-editor regression pass before landing.

   Verify (when built): scope switch enters/exits, edits isolate per clip,
   undo/redo across scope, project save while in clip scope, and — critically —
   editing clip A's graph never changes what clip B (shared graph) renders.

## Risks

- **Scope-switch refactor** (which graph the editor edits) is the widest change
  and the one open item (see increment 3). The `activeGraphScope`
  (`graphView.clipGraphId` + `getEditableGraph`) option is cleaner than swapping
  `state.graph` in place — swapping corrupts the render base for other clips.
- **Compositing × per-clip graphs** multiplies evaluation cost (N layers × graph
  eval). Memoisation already keys per node; acceptable for small N. (Compositing
  still uses the global graph today — see increment 2.)
- **Worker** — resolved: the worker already accepts a full graph per render
  message, so clip-graph frames run on the worker just like the global graph (no
  main-thread force needed). Verified in increment 2.
