# Caddis Feature Roadmap — Feasibility Map

## What This Is

A reference tool, "Caddis", was described with 8 headline features. This document maps each one
against Dither Lab's **actual current code** and estimates feasibility, effort, and the concrete
files involved. It is a planning document — no code changes are implied by writing it.

The headline conclusion: Dither Lab already shares Caddis's architectural DNA. The processing
model **is** a node graph; preview and export already evaluate the same graph; node grouping with
boundary bindings exists; a keyframe timeline with bezier easing exists; a GPU path (WebGL2 +
worker) exists. Several "Caddis" features are therefore extensions of working systems, not
greenfield builds.

Two hard constraints from `CLAUDE.md` shape everything below and must be honored or explicitly
revisited with the owner:
- No React/Vue/Svelte, no JS build step.
- WebGL 2 + Canvas/CPU is the rendering stack. **WebGPU is not currently sanctioned.**
- Preview/export parity and seed-locked determinism are non-negotiable.

## Effort Legend

- **S** — days, isolated, low risk, builds on existing infra
- **M** — 1–2 weeks, new state slice or node type, moderate surface
- **L** — multi-week, new subsystem or cross-cutting concern
- **XL** — months / conflicts with a current non-negotiable; needs an owner decision first

---

## 1. Node graph inside every layer — **ALREADY EXISTS**

Caddis: each layer opens into its own node graph.

Dither Lab: the whole pipeline already *is* a node graph (`graph.js`, `graph-runtime.js`), and
**Groups** (`groupSelectedNodes` / `ungroupNode`, with `inputBindings` / `outputBindings` boundary
metadata) are exactly "a layer that contains a sub-fabric." Descending into a group already shows
group I/O proxy cards (`graph-render.js renderGroupProxies`).

Gap: presentation only — if we want the literal "layer row that you double-click to dive in" UX,
that is a timeline/graph-view affordance, not new engine work. Effort: **S** (UX framing) on top of
existing engine.

---

## 2. Parametric data patching (audio → param, field → param) — **PARTIAL**

Caddis: any output (audio, field, position) wires into any parameter; modular-synth style.

Dither Lab today: the patching *mechanism* exists. `value` and `math` nodes produce scalar outputs;
`exposedParams` + `param:<key>` input sockets + `applyParamEdges` (`graph-runtime.js`) already let a
node's parameter be driven by an upstream value edge. So "connect an output to a parameter input"
works **now** for scalar sources.

What's missing is *interesting sources*:
- **Audio-reactive** (M–L): an `audio-source` node that decodes the loaded media's audio track and
  exposes amplitude / band-energy as a per-frame scalar. Determinism is the watch-point — the value
  must be a pure function of timeline time, not wall-clock, to keep preview/export parity. Decode
  can reuse the FFmpeg sidecar already wired in `export.js`; analysis (FFT/RMS) is new.
- **Fields** (L): a spatial "field" node (magnetic/radial/noise field) whose influence at a point
  drives a param. This is a genuinely new node category (per-pixel/per-point sampling feeding a
  scalar) and needs a design pass — closest existing analog is the procedural `noise`/`gradient`
  source nodes.

Files: `graph.js` (node defs), `graph-runtime.js` (eval + `applyParamEdges`), `image-ops/` (new
source node), inspector modules.

---

## 3. Timeline + dope sheet + easing graph editor — **PARTIAL, SPEC EXISTS**

Caddis: clip timeline + keyframes + easing curves.

Dither Lab today: parameter keyframes with full cubic-bezier easing already exist (`timeline.js`:
`evaluateCubicBezier`, auto-tangents, hold/step, per-keyframe easing). The multi-track clip editor
is **specced but not built** — see [v3-timeline-editing.md](v3-timeline-editing.md), which already
defines the Media Track vs Parameter Track split and a `state.composition` slice.

Gap: implement the v3 spec (clip tracks, trim/split/ripple). Effort: **M–L**, but de-risked because
the design and the OpenCut reference are already documented. A literal "dope sheet" (all keyframes
across nodes in one grid) is a **M** view on top of existing `state.timeline.tracks`.

---

## 4. Color tokens (global color variables) — **NOT YET, GOOD FIT**

Caddis: colors are central tokens; change once, propagate everywhere.

Dither Lab today: colors are stored inline in node params (e.g. gradient stops, duotone colors).
There is no indirection layer. But the **palette system** (`palettes.js`) already proves the
pattern: a central registry, serialize/deserialize, a `subscribePalettes` change-notify, and
project persistence (`serializeCustomPalettes`).

Plan (M):
- New `state.tokens` slice: `{ id, name, value }[]` color tokens, mirroring the palette registry's
  shape and change-notify.
- Node color params can hold either a literal hex or a `token:<id>` reference; resolve at eval time
  in `graph-runtime.js` / color-reading nodes.
- A tokens panel (reuse palette-ui patterns).
- Persist in the project payload (`project.js buildProjectPayload`) next to `customPalettes`.

Watch-point: parity — a token must resolve to the same value in preview and export (it will, since
both evaluate the same graph + same token state).

---

## 5. Recipes / Subgraphs (save & share node groups) — **CLOSEST WIN**

Caddis: package a node group, save it, reuse/share as a file.

Dither Lab today: the hard part is **done**. `groupSelectedNodes` packages a selection into a group
node with boundary bindings; `ungroupNode` reverses it; `serializeGraph` already produces a clean,
id-stable JSON for nodes/edges/group metadata; `project.js` already does atomic file write via the
Tauri fs API.

Plan (S–M) — a "Recipe" is just a serialized subgraph file:
- **Export recipe**: take a selected group (or selection), run the existing serialize path on that
  sub-slice, write a `.recipe.json` via the same Tauri save dialog `project.js` uses.
- **Import recipe**: read the file, re-id the nodes (collision-safe, `nextNodeId` already exists),
  splice into the current graph as a group, offset position.
- Optional: a local "recipe library" panel listing saved recipes.

This reuses serialize + group + file-IO that already exist and pass tests. Lowest risk, most
concrete payoff. **Recommended first build.**

Files: `graph.js` (serialize a sub-slice + re-id import), new `recipes.js`, a left-panel UI hook,
reuse `project.js` file helpers.

---

## 6. Responsive / auto-layout (reflow on aspect change) — **NOT YET**

Caddis: elements bind to composition bounds (proportional), reflow when 16:9 → 9:16.

Dither Lab today: geometry nodes (`transform`, `crop`, `scale`) use absolute params; there is no
proportional-anchor concept. The viewer/export already know the composition size, so the input
exists, but the layout-solve does not.

Plan (L): introduce anchor/constraint metadata on geometry-producing nodes (anchor to
top/center/edges as a fraction of composition size) and resolve positions against the current
output dimensions at eval time. This is a new layout concept and needs its own design doc before
code. Effort: **L**.

---

## 7. Native GPU pipeline (WebGPU, zero legacy) — **CONFLICTS WITH CONSTRAINTS (XL)**

Caddis: written ground-up for the GPU, no web/legacy baggage, WebGPU-class.

Dither Lab today: WebGL 2 fragment-shader pipeline (`gpu-effects.js`) with multi-pass ping-pong,
mip chains, and an OffscreenCanvas worker path (added this session). This is already a real GPU
pipeline — just WebGL 2, not WebGPU.

Reality: a WebGPU rewrite is **XL** and directly conflicts with the `CLAUDE.md` non-negotiable that
fixes the stack at WebGL 2. This is not a "go implement" item — it is an **owner strategy decision**
about whether to change the project's foundational stack. Incremental wins that do *not* require
that decision (and are worth doing first):
- Finish lifting the worker WebGL2 guard so GPU effects run off-main-thread everywhere (the
  scaffolding landed this session — `isGpuRendererAvailable`, worker fallback).
- Move more CPU effect nodes to the existing GPU path where parity allows.

---

## 8. Hybrid media + native formats (ProRes/EXR/audio-as-data) — **PARTIAL**

Caddis: vector, pixels, video frames, audio, text on one timeline; native ProRes/MP4/WebM/GIF/PNG.

Dither Lab today: video (MP4/WebM via `<video>`), image sequences, and EXR sequences are inputs;
export covers PNG, MP4 (FFmpeg sidecar), VP9 (WebCodecs), and image sequences, with **audio
passthrough already implemented** (`export.js`: `-map 1:a:0?`, AAC 192k). FFmpeg is already a wired
sidecar.

Gaps:
- **ProRes export** (S–M): a new codec entry in `VIDEO_CODECS` + the matching FFmpeg flags
  (`-c:v prores_ks`). The encode plumbing already exists; this is mostly config + UI.
- **Audio as a data signal** (overlaps #2): decoding audio for *analysis* (not just passthrough) is
  the new part — see feature 2.
- **Unified vector/text-as-first-class** (L): text exists via the ASCII/text shader paths; true
  vector primitives on the same graph would be a new node family.

---

## Recommended Sequence

1. **Recipes / Subgraphs (#5)** — highest payoff per effort; reuses serialize + groups + file IO
   that already pass tests. Start here.
2. **Color Tokens (#4)** — clean M-sized feature; palette system is a proven template.
3. **ProRes export (#8 slice)** — small, self-contained, high user value; FFmpeg already wired.
4. **v3 clip timeline (#3)** — spec already written; unlocks the "timeline" half of Caddis.
5. **Audio-reactive patching (#2 slice)** — patching mechanism exists; add an audio-source node.
6. **Fields (#2), Responsive (#6)** — each needs its own design doc first.
7. **WebGPU (#7)** — owner decision required; conflicts with current non-negotiables.

## Notes On Determinism (applies to every item)

Anything that drives a parameter over time (audio, fields, tokens, animation) must be a pure
function of timeline time + seed, never wall-clock or external state, or it breaks the
preview/export parity guarantee that the whole product rests on. The existing `value`/`math`/
keyframe systems already follow this rule and are the template to copy.
