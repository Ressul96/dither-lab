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
3. **Editing UI** — DONE (built on branch `feat/clip-graph-editing`). Two parts:

   a. **Pin / unpin** — a per-clip **FX badge** in the Clips view
      (`media-clip-fx`) toggles a clip's own graph. Pin = clone the current
      global graph into the registry and point the clip at it
      (`toggleClipGraphById` → `setClipGraphId` reducer, atomic composition
      history); unpin = detach back to the shared graph. The clone is a snapshot,
      so a clip keeps its look while the global graph evolves. Registry entries
      are left on detach so undo/redo restore the reference (pruned at save).

   b. **In-editor editing** — **double-click a clip** opens its graph in the
      node editor (`editClipGraph`: creates the graph if the clip is still on the
      shared graph, then enters the scope); a breadcrumb crumb **"⤺ Composition"**
      exits back to the global graph.

   Architecture chosen: the **swap model**, not the `getEditableGraph`
   indirection the increment-2 note had recommended. The audit showed the render
   path reads the graph only through `ensureBootGraph()` (never the bare
   read-accessors), so the editor can be left *completely unchanged* — entering a
   scope stashes the global graph and loads the clip graph into `state.graph`, so
   the canvas, inspector and undo/redo all operate on it as usual. Render / export
   / save read the global via `getGlobalGraph()` (= `stashedGlobalGraph ??
   ensureBootGraph()`, so byte-identical when no scope is open), and the render
   chokepoint renders the *edited* clip from the live `state.graph` buffer (other
   clips from the registry). History is made scope-aware so cross-scope undo
   routes to the right graph and never corrupts the global. This kept the change
   off the editor core entirely — far less risk than routing ~30 mutation sites.

   Verified: enter/edit/exit, registry persistence on exit, scope-aware undo,
   global-graph integrity across the cycle, the double-click gesture and the
   breadcrumb exit (live DOM), and no console errors. (Render-pixel parity uses
   the proven increment-2 path; a fresh pixel shot was blocked only by flaky
   harness video decode this session.)

## Risks

- **Scope-switch refactor** (which graph the editor edits) — RESOLVED via the
  swap model (see increment 3). Swapping `state.graph` to the clip graph does
  *not* corrupt other clips' render base because render reads the global through
  `getGlobalGraph()` (the stash), and the edited clip renders from the live
  buffer; the earlier worry assumed render read `state.graph` directly, which it
  doesn't (only `ensureBootGraph()`).
- **Compositing × per-clip graphs** multiplies evaluation cost (N layers × graph
  eval). Memoisation already keys per node; acceptable for small N. (Compositing
  still uses the global graph today — see increment 2.)
- **Worker** — resolved: the worker already accepts a full graph per render
  message, so clip-graph frames run on the worker just like the global graph (no
  main-thread force needed). Verified in increment 2.
