# Dither Lab — Code Quality Audit

**Date:** 2026-05-18 (status update appended 2026-05-23)
**Scope:** 52 source files — 35 JS, 10 Rust, 3 CSS, 1 HTML, 3 config
**Method:** 7 parallel review agents covering logical module groups, single shared template per file (role / quality / issues / suggestions).
**Project guardrails respected by suggestions:** vanilla JS only, no build step, preview/export parity, seed determinism, local-first.

> Findings preserved verbatim from each agent's report. The "Top priorities" section at the end consolidates the highest-leverage items across all groups.

---

## 2026-05-23 status update

Several of the audit's headline findings were closed in a Claude + Codex parallel two-agent session. Findings below are **preserved verbatim for historical reference** — they describe the state of the codebase on 2026-05-18, not today. Specifically:

| Audit finding | Status (2026-05-23) |
|---|---|
| `src/js/ui/graph-shell.js` — 7202 lines / ~150 functions | **Resolved (M.1).** Split to 526 lines + 13 new UI modules. 22 atomic commits, final `6aa5552`. |
| `src/js/ui/player.js` — 2930 lines / 6 drag-state singletons | **Resolved (M.2).** Split to 1111 lines + 14 new player-* modules. Codex, final `1c3c3a5`. |
| `src/js/image-ops.js` — 2602 lines | **Resolved (M.3).** Category-based modules under `src/js/image-ops/`. Final `e470021`. |
| `nodesEl.innerHTML = …` / `edgesEl.innerHTML = …` per dispatch (M.4 phase 1) | **Resolved.** 13 non-player sites migrated to the `setInnerHtml(el, html)` helper (`812dc68`); helper uses `Range.createContextualFragment` to keep SVG namespaces correct. |
| Full graph rebuild on every dispatch (M.4 phase 2) | **Resolved.** `renderGraph` does per-node diff via `lastRenderedNodeHtml` cache; unchanged cards keep DOM identity (`b1e4767`). Inspector skips re-render when HTML unchanged (`33b89b0`). |
| **BT.601 vs BT.709 luma drift** — "single biggest correctness smell on the JS side" | **Resolved (V.1).** GPU shaders (18 sites, `b465652`) and 7 CPU image-ops modules (`ea81f17`) now both use BT.709. YIQ rotation matrix intentionally left on BT.601 (NTSC closed system). User-selectable BT.601 option in `rgb-to-bw` kept by design. |
| A.1 keyboard alternatives for gizmo/playhead/bezier | **Resolved 2026-05-21** (Codex working tree). |
| A.2 dispose registry for ResizeObserver / global listeners | **Resolved** (`lifecycle.js`). |
| F22 UI polish backlog (splash / slider redesign / timeline minimise / default pan) | **Resolved 2026-05-23** (Codex: `6018fc5`, `bc14451`, `e43a75e`, `2a09cf9`, `a5b242d`). |
| M.5 deep-clone reduction in `graph.js` | **Resolved** (earlier session). |

Open audit items as of 2026-05-23: Faz D #1/#2 (renderFrame async discipline), S.1 EXR sequence scope decision, F22 tail (group in/out node action, file drag-drop already implemented — manual test pending), M.4 phase 2 bonus (player-tier `innerHTML` → `setInnerHtml` migration).

See [next-phases.md](next-phases.md) for the live "remaining work" tracker and [audit.md](audit.md) Section 0 for the full closure ledger.

---

## Table of contents

1. [Core JS](#1-core-js) — main, state, project, source, export
2. [Rendering JS](#2-rendering-js) — graph, graph-runtime, render-adapter, render-worker, native-render, gpu-effects, canvas
3. [Dither algorithms](#3-dither-algorithms) — dither/*
4. [Utilities](#4-utilities) — color, curve-lut, image-ops, palettes, palette-extraction, effect-catalog, gl/gradient-lut
5. [UI + Timeline](#5-ui--timeline) — ui/*, timeline, timeline-adapter
6. [Rust engine](#6-rust-engine) — src-tauri/src/**/*
7. [HTML / CSS / Config](#7-html--css--config) — index.html, styles/*, package.json, Cargo.toml, tauri.conf.json
8. [Top priorities](#8-top-priorities) — synthesized action list

---

## 1. Core JS

### `src/js/main.js` — 197 lines
**Role:** Entry point: wires up subsystems, Tauri menu bridge, project/history buttons, and global keyboard shortcuts.
**Quality:** ★★★★☆ — Clean orchestration; one minor structural smell.
**Issues:**
- `initSource()` and `initExport()` (lines 19–20) execute before `initGraphShell()`/`initStage()`; ordering is implicit and undocumented — a future reshuffle could break the boot-time graph dependency.
- The keyboard handler (lines 90–197) mixes target-filtering, modifier checks, and shortcut routing in one ~100-line function; the chord registry is inline rather than a small table.
- `bindAction` (line 84) silently no-ops if no matching `[data-action]` element exists, which can mask wiring bugs.

**Suggestions:**
- Extract the keyboard shortcut map to a small `[{ key, meta, shift, handler }]` table to keep the switch readable as shortcuts grow.
- Consider asserting (in dev) that each registered action found at least one DOM target.

### `src/js/state.js` — 127 lines
**Role:** Reactive store (topic-keyed slots), pub/sub, and undo/redo history stack.
**Quality:** ★★★★☆ — Tight and well-scoped, but a few sharp edges around event safety and topic typing.
**Issues:**
- `subscribe` (line 82) invokes `fn(state[topic])` synchronously inside `subscribe`; if a callback throws it will propagate to the caller and prevent registration in some flows.
- `dispatch` (line 89) iterates a live `Set`; a subscriber that calls `subscribe`/`unsubscribe` for the same topic during dispatch mutates the set mid-iteration (unsubscribe is safe via `delete`, but a new `add` during fan-out is observed in the same tick — possibly unintended).
- Returned slot from `getState()` is the mutable internal object — any caller can bypass `dispatch` and skip notifications (already visible in `project.js` reading state).
- `syncHistoryButtons` queries the DOM on every `pushHistory`/`undo`/`redo` (lines 122–127); cheap, but cached refs would be cleaner.
- No history stack cap — long sessions accumulate unbounded undo entries.

**Suggestions:**
- Wrap each subscriber call in try/catch so one bad listener can't break dispatch fan-out.
- Cap `undoStack` length (e.g. 200) by shifting the oldest entry; drop a `MAX_HISTORY` constant near the top.
- Cache the undo/redo button refs once in `syncHistoryButtons`.

### `src/js/project.js` — 218 lines
**Role:** New/open/save/save-as for `.ditherlab` project files plus apply/serialize of all project-scoped state.
**Quality:** ★★★☆☆ — Solid happy path, but several robustness and parity gaps.
**Issues:**
- `applyProject` (line 158) dispatches `graphView` twice (lines 192 and 203); the second only patches `currentParentId`, but the intermediate state briefly broadcasts an unresolved parent id — UI subscribers may render a wrong panel for a frame.
- `writeProjectFile` tmp+rename flow (lines 97–125): if `rename` is undefined AND fallback overwrites `path` directly (line 119), failure mid-write corrupts the existing project — opposite of the atomic intent.
- `openProject` (line 75) does not validate `project.version`; a future schema bump will silently load corrupt data.
- Reading `selected.path` (line 74) assumes Tauri returns an object with `path` — older Tauri 2.x returns plain strings, newer return objects; the ternary handles it but the same logic is duplicated in `source.js`, `export.js`, and elsewhere.
- `suggestedProjectPath` (line 215) reads `state.source.path` without guard; if path is empty it falls back to `"untitled"`, but doesn't include a directory hint.
- `newProject` is declared `async` (line 15) but has no `await` — minor leak of `async` semantics.

**Suggestions:**
- Coalesce graphView updates into a single `dispatch` after `replaceGraph` resolves the parent id.
- Reject loads where `project.version` is missing or unknown with a friendly error, before mutating state.
- Drop `async` from `newProject` since it returns no promise meaningfully.
- Extract a tiny `pickPath(selected)` helper to dedupe the string-or-object normalization across files.

### `src/js/source.js` — 1602 lines
**Role:** Source loading (video/image/dropped paths), playback transport, preview render loop, frame cache, and pixel-sampling layout.
**Quality:** ★★★☆☆ — Functionally rich and reasonably documented, but its size and the number of module-level mutable flags make it the riskiest file for race conditions.
**Issues:**
- 18+ module-level mutable globals (lines 31–58: `video`, `rafId`, `renderVersion`, `sourceToken`, `playRequestToken`, `pendingPlayPromise`, `nativeRenderInFlight`, `exportSessionActive`, `playbackSyncSuspended`, …) all coordinate implicitly; correctness depends on subtle ordering. Hard to reason about and to test.
- `renderCurrentFrame` is `async` (line 966) but called synchronously from many places (`startDrawLoop`, `wireVideoEvents/seeked`, `getCurrentExportFrameCanvas`, etc.) — return promises are discarded; an in-flight worker render can resolve out of order vs. a synchronous JS render started just after it. `currentRenderVersion` guards the native path but not the worker path (line 1046).
- `getCurrentExportFrameCanvas` (line 914) and `hasCurrentDitherFrame` (line 927) call `renderCurrentFrame()` synchronously without `await`; outside an export session this fire-and-forget can return a stale canvas to the caller, despite the comment claiming it's safe.
- `detectSourceFps` (line 542) mutates `playbackSyncSuspended` and starts playback to measure FPS; if the user navigates/closes the source while the 800ms timeout is pending, `playbackSyncSuspended` may be left true (the `finish` path resets it, but only if `settled` flips).
- `ImageMediaMock` `loop` is set but never honoured in `_tick` (line 119) — for static images this is invisible, but the field is dead.
- Drop handlers register both DOM listeners and Tauri listeners (lines 362–428); both can fire for the same gesture on macOS, leading to a second `openSourcePath` call on the same file.
- `seekForExport` listener cleanup (line 793) does not remove `rVFC` callbacks — they keep firing on the underlying `<video>`; harmless but leaks closures.
- `playbackQuality === "auto"` halves resolution during playback (line 1003), which the comment acknowledges; this is a deliberate parity exception but worth a visible UI indicator (not just an internal flag).
- `wireSourceDropTarget` checks `sourceDropWired` AFTER reading DOM elements (lines 340–343), so each call queries the DOM even when wiring is already done.

**Suggestions:**
- Extract the playback transport (play/pause/seek/trim/loop) into its own module — it's ~300 lines that are conceptually distinct from preview rendering.
- Make `renderCurrentFrame` return its promise consistently and gate worker results on `renderVersion`/`sourceToken` the same way `queueNativePreview` does.
- For sync callers (`getCurrentExportFrameCanvas` etc.), separate the read API from the render API: those callers should call a synchronous `getCommittedFrame()` and trust that subscribers schedule re-renders.
- Add an early return at the top of `wireSourceDropTarget` before any DOM work.
- Either honour `ImageMediaMock.loop` or remove the field.

### `src/js/export.js` — 2210 lines
**Role:** Export sheet UI (still/sequence/video), FFmpeg + WebCodecs encoders, format/size/aspect math, and IVF writer.
**Quality:** ★★★☆☆ — Works and is feature-complete, but the file is too large and the two video pipelines duplicate ~120 lines of orchestration.
**Issues:**
- `renderExportSheet` rebuilds the entire panel innerHTML (lines 325–377) on every change including each frame of progress; for long sequences this is ~30–60 reflows/s during encode. Range/number inputs lose focus and selection on each redraw, breaking the JPEG quality slider drag.
- `submitFfmpegVideoExport` (lines 1832–1986) and `submitWebCodecsVideoExport` (lines 1988–2168) duplicate seek-loop, abort handling, finalization, and progress reporting — a single frame-pump helper would halve both.
- HTML is built via string concatenation across hundreds of lines; user-controlled strings flow into `escapeHtml` consistently for most paths, but the `previewPath`/`destinationLabel`/`previewName` rendering relies on `escapeHtml` being called on every interpolation — a future change could miss one (XSS-via-filename risk in the desktop shell is low, but defense-in-depth matters).
- `joinPath` (line 1607) infers separator from whether `dir` already contains a backslash; mixed-separator paths from Tauri (e.g. `C:\Users/me`) get the wrong join.
- `chooseExportDirectory`/`chooseVideoExportPath` write to `exportSheetState` before returning, but also re-render — callers (`submitSequenceExport`) then re-check the dirty state, doubling render work.
- `cancelInFlightExport` aborts the controller but the in-flight `seekForExport` Promise still waits for `seeked`/`error` events; the next frame iteration aborts cleanly, but a long seek can keep the cancel from feeling instant.
- `submitSequenceExport` calls `chooseExportDirectory` (line 1100) without awaiting the resulting `dir` value — it relies on the side effect of state mutation. If the user cancels, the subsequent guard works, but the dataflow is implicit.
- `submitStillExport` (line 1047) calls `getCurrentExportFrameCanvas` via `buildStillExportCanvas` while `exportInFlight` is still false; if the user double-clicks Export, two stills can race for the same path. The function sets `exportInFlight = true` after the canvas read.
- `submitVideoExport` does not `beginExportSession()` around the early probe canvas read (line 1876) — that probe goes through the live-preview path, momentarily disabling the half-res scale that immediately follows in `beginExportSession`. Could cause the first probe and first encoded frame to differ slightly in size if the user later adjusts.
- `writeImage` (line 1384) catches errors and returns `false`, but does not surface the cause to the user — failures silently fall back to browser download.
- `createIvfFile` writes a 32-byte global header but `writeUint64Le` (line 2206) loses precision above 2^53, fine in practice but `Math.floor(n / 0x1_0000_0000)` is non-obvious — a `BigInt` would be clearer.

**Suggestions:**
- Split `renderExportSheet` into a one-time mount and granular per-field updates (or at least skip the full innerHTML rewrite while the progress block ticks — patch just `[data-jpeg-quality-readout]`-style targets).
- Extract `runFrameLoop({ totalFrames, onFrame, signal })` and call it from both video paths; keeps the encoder-specific code on either end of the loop.
- Replace `joinPath` separator inference with an explicit platform check (Tauri exposes the OS via `tauri.os`).
- Set `exportInFlight = true` immediately on submit, before any async work, to prevent double-submit races.
- Surface `writeImage` failures to the user when the browser download fallback is not desirable (sequence/video paths).
- Add `aria-busy` to the panel during encodes so screen readers don't read every progress tick.

### Cross-cutting (Core JS)

- **State ownership is split between modules without an enforced contract.** `source.js` owns 18+ module-level globals, `export.js` owns `exportSheetState`, and `state.js` owns the reactive store — but `export.js` and `project.js` mutate `state.js`'s topics while reading raw slots via `getState()`. This makes "what triggers a re-render?" non-obvious. Consider documenting which topics each module owns vs. observes, and freeze the object returned by `getState()` in development.
- **`async` functions called synchronously.** `renderCurrentFrame`, `seekForExport`, `getCurrentExportFrameCanvas`, and several Tauri listeners are awaited inconsistently. Promises are sometimes discarded (`source.js:920`, `source.js:930`), risking stale reads and out-of-order completions. Pick one model per function and document whether callers must await.
- **Race-prone tokens (renderVersion, sourceToken, playRequestToken) protect only some paths.** The native render path checks them, the worker path doesn't (`source.js:1046`); the export pipeline pauses live rendering but the probe canvas in `submitFfmpegVideoExport` runs outside the export session window. Standardize a single "epoch" token and gate every async commit on it.
- **HTML built by string concatenation with manual escaping.** Both `export.js` and (per the file) likely other UI modules build innerHTML strings. Every interpolation must remember `escapeHtml` — a single missed call becomes an injection vector (low risk in a desktop shell, but compounds with user-named files/paths). A small tagged template helper (`html\`...\``) that escapes interpolated values by default would be safer with no build step.
- **Tauri API duplication and version drift.** `selected.path` normalization, `tauri.fs.rename ?? tauri.fs.renameFile`, `tauri.fs.writeFile`/`writeBinaryFile`, and `tauri.core.invoke ?? tauri.invoke` patterns appear across files. A small `src/js/tauri-compat.js` would centralize these adapters and make a future Tauri upgrade a single-file change.
- **Preview/export parity has implicit exceptions.** `playbackQuality === "auto"` halves preview resolution; `graphContainsDither` promotes dither chains back to full-res; export pauses the worker path. These exceptions are correct but live as scattered conditionals. A short comment block at the top of `source.js` (or in `docs/spec/export.md`) listing the exact rules would prevent future regressions.

---

## 2. Rendering JS

### `src/js/graph.js` — 3099 lines
**Role:** Source-of-truth for the node-graph model: type definitions, default params, bounds, and all mutation helpers (add / remove / group / duplicate / select / serialize / normalize).
**Quality:** ★★★★☆ — Disciplined data layer with very thorough normalization, but the file is monolithic (3.1k lines) and the boilerplate-heavy `clone(...)` pattern hides O(N) full-graph copies on every mutation.
**Issues:**
- Module mass: NODE_DEFINITIONS, NODE_PARAM_BOUNDS, mutation API, layout helpers, group/solo, serialization, and edge sanitization all share one file (graph.js:24–1152 + 1154–3099). Hard to navigate; CLAUDE.md "Simplicity First" pushes back at a single screen of content per concern.
- Every mutation deep-clones the entire `graph.nodes` array via `clone(...)` (e.g. `insertNodeIntoChain` graph.js:1384, `duplicateNodes` 1431, `groupSelectedNodes` 1731, `ungroupNode` 1765, `removeNode` 1874, `toggleNodeSolo` 2031/2068, `removeEdgesById` 2158, `addEdge` 2846, `setParamExposed` 2138, etc.). For a moderate graph this is fine; for a long timeline-bound graph with frequent `dispatch`es it adds avoidable garbage that competes with the 60fps preview budget.
- `mutateNodePosition` (graph.js:1792) directly mutates an object inside `getState().graph.nodes` without dispatching — this is documented behavior for drag perf, but it relies on consumers calling `commitLayout()`. If anyone reads `selectedNodeIds` and compares positions through a memoized state subscriber, they'll see torn writes.
- `topologicalSort` in graph-runtime.js (not here) silently returns a partial order on cycles, but `addEdge` already prevents creating one (1831). However `wouldCreateCycle` is not called when restoring legacy save files in `normalizeGraph` (2269) — a malformed project file could land cyclic edges that then evaluate to a partial frame.

**Suggestions:**
- Split into `graph-definitions.js` (NODE_DEFINITIONS + bounds), `graph-mutations.js` (add/remove/group/etc.), `graph-serialization.js`. Pure data + pure functions; no API change.
- Replace `graph.nodes.map((node) => clone(node))` with `[...graph.nodes]` everywhere the mutation only mutates the target node's reference.
- Add a `wouldCreateCycle` check inside `normalizeGraph` so corrupted save files can't import cyclic edges silently.

### `src/js/graph-runtime.js` — 748 lines
**Role:** Stateless graph evaluator with per-node memoization, cache-key composition, and viewer/dither output resolution; shared by main thread and worker.
**Quality:** ★★★★☆ — Cache invalidation is unusually careful (param-version + input-version + time salt + bypass + layerAdjustments), and pass-through detection is correctly handled.
**Issues:**
- `nodeCache` and `versionCounter` are module-level singletons (graph-runtime.js:54–55). When this module is imported in both the main thread and the worker, each scope has its own cache, but `versionCounter` keys are not cross-scope unique.
- `frameSalt` (graph-runtime.js:390) uses `Math.round(seconds * fps)`. If the export pipeline ever passes `fps = 0` or non-finite, the cache key becomes seconds-as-string — drift between `0.0166` and `0.0167` would re-evaluate every node even when the frame snapped to identical bucket.
- `TIME_AWARE_TYPES` (line 71) is hard-coded to `mesh-gradient`, `analog`, `vhs`, `crt`. **Missing `noise`** — graph.js:1700 advances the noise sample plane by `u_time * u_animSpeed`. With `animSpeed > 0`, scrubbing the playhead won't bust the cache: identical params + identical inputs = stale cached frame. **Likely a real export/preview parity bug for the `noise` source.**
- `releaseIntermediateBuffers` (graph-runtime.js:429) compares by `output === sourceImage`. If a pass-through chain produces `output === results.get(upstreamId)` and that upstream is also pass-through, both share one canvas. The `seen` set guards against double-release but a separate cached entry might still pin the same buffer.
- `applyLayerAdjustments` (line 442) always re-runs unless `cached.paramsHash` matched. Identity opacity/hue/saturation pays full image-ops cost.

**Suggestions:**
- Add `"noise"` to `TIME_AWARE_TYPES` if `params.animSpeed > 0` — otherwise the noise source returns a stale frame after the first eval.
- Guard `frameSalt` against fps=0 / non-finite via an early return.
- Add identity-op short-circuit at the layer-adjustments call site.

### `src/js/render-adapter.js` — 128 lines
**Role:** Main-thread façade to the dedicated render worker with latest-wins backpressure and graceful fallback when Worker creation fails.
**Quality:** ★★★★★ — Tight, well-commented, correct transfer semantics; backpressure policy is explicit.
**Issues:**
- `createImageBitmap(sourceImage)` (line 32) silently swallows errors. If the source canvas is tainted, the fallback is `sourceBitmap = null`, which means the worker renders against no source. The viewer commits a blank frame instead of falling back to main-thread rendering.

**Suggestions:**
- On `createImageBitmap` failure, return `null` from `requestWorkerRender` so the caller can fall back to main-thread evaluation.

### `src/js/render-worker.js` — 67 lines
**Role:** Dedicated worker entry point: receives serialized graph + bitmap, evaluates via `graph-runtime`, returns transferable ImageBitmaps for viewer/dither outputs.
**Quality:** ★★★★★ — Minimal, correct, and documents the OffscreenCanvas-copy rationale.
**Issues:**
- `transferCanvasOutput` (render-worker.js:62) copies the cached output canvas onto a throwaway OffscreenCanvas before `transferToImageBitmap`. ~1–2ms per 1080p frame.
- No handler for `messageerror` from the worker side.

**Suggestions:**
- Only after measuring with `lastEvaluationProfile`, consider a "consumeOutput" path that swaps the cached canvas's buffer instead of copying.

### `src/js/native-render.js` — 114 lines
**Role:** Optional Rust/Tauri GPU fast-path for a small subset of node types. Falls back to the JS runtime when unavailable or unsupported.
**Quality:** ★★★★☆ — Conservative capability checks; correctly bails on exposed-param edges, hidden nodes, and non-identity source params.
**Issues:**
- `canUseNativeRender` (line 20) calls `pruneHiddenGraph(graph)` — fine. But `evaluateNativeGraphOutputs` (line 47) calls it *again* (line 51). Two passes per request.
- `nativeRenderAvailable === false` is sticky for the session (line 16). **Once a single `invoke` rejects, the native path is disabled until reload.** A transient Rust panic or GPU hiccup permanently demotes the user to JS path.
- `frameToCanvas` (line 103) creates a fresh `<canvas>` per response. On a 600-frame timeline this is 600 throwaway canvases.

**Suggestions:**
- Cache the result of `pruneHiddenGraph` in `evaluateNativeGraphOutputs`.
- Add a reset hook so `nativeRenderAvailable` can be re-tested without a reload.

### `src/js/gpu-effects.js` — 3198 lines
**Role:** WebGL2 fullscreen-quad renderer hosting all shader-based effects: programs, ping-pong FBOs, mip chain, and per-effect `apply*Gpu` entry points.
**Quality:** ★★★☆☆ — Renderer architecture is sound, but the file is enormous (3.2k lines, ~30 shaders inline) and has real GPU resource concerns.
**Issues:**
- `renderer` singleton is never disposed. `extraTextures` grows monotonically — every unique `uniformName` ever passed gets a `WebGLTexture` that lives until page unload.
- `mipChain` only grows; `ensureMipChain` resizes existing entries but never frees levels when the requested count drops.
- `programs` map (line 2255) keyed by `fragmentSource`; ~30 distinct shaders hold WebGLProgram + WebGLShader each. No cleanup path on context loss.
- No `webglcontextlost` / `webglcontextrestored` listener. Windows GPU driver swap will leave the renderer dead.
- `gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)` set inside upload paths but never reset — fragile for any future LUT upload with non-trivial vertical layout.
- `texImage2D` re-uploads the same input texture every frame even when input hasn't changed; the cache layer in graph-runtime catches this at node level, but the renderer doesn't track input identity.
- `preserveDrawingBuffer: true` forces extra framebuffer copies — likely unnecessary given the drawImage pattern.
- `applyShaderChain` allocates two full-size ping-pong FBOs even for single-pass chains.

**Suggestions:**
- Add a `disposeRenderer()` export and call from `beforeunload`.
- Move shaders into `src/js/gl/shaders/*.glsl.js`. Cuts gpu-effects.js to ~1k lines.
- Add `webglcontextlost` listener; rebuild on next call.
- Skip FBO allocation when `passes.length === 1`.
- Track input canvas identity; skip `texImage2D` when unchanged.

### `src/js/canvas.js` — 34 lines
**Role:** Tiny factory that picks `OffscreenCanvas` in a worker scope and `<canvas>` on the main thread.
**Quality:** ★★★★★ — Minimal, single responsibility, accurately commented.
**Issues:**
- `hasOffscreenCanvas()` exported but possibly unused in this batch.

**Suggestions:**
- If no external callers, drop the export. Otherwise leave it: floor of acceptable complexity.

### Cross-cutting (Rendering JS)

- **Cache key omission for `noise` time-awareness.** Missing from `TIME_AWARE_TYPES` despite `animSpeed` driving sample-plane offsets. Real preview/export parity bug for animated noise. One-line fix.
- **GPU resource lifetime is open-ended.** `gpu-effects.js` never disposes programs/FBOs/mip chains/extra textures. Multi-hour Tauri sessions accumulate context state across project switches.
- **Deep-clone-the-world mutation pattern.** Most of `graph.js` does `graph.nodes.map(node => clone(node))` even when only one node mutates. Stacks measurable GC pressure during interactive drags.
- **`createImageBitmap` failure path is silent.** Falls through to a worker call with `sourceBitmap = null`, yielding a blank viewer frame instead of main-thread fallback.
- **Native path is one-shot disabled.** Transient GPU/Rust hiccup permanently demotes to JS path until reload.

---

## 3. Dither algorithms

### `src/js/dither/index.js` — 27 lines
**Role:** Barrel module that aggregates per-family algorithm arrays and registers them with the central registry.
**Quality:** ★★★★☆ — Tiny, single-purpose, clear. Side-effectful import (registration on load) is the only smell.
**Issues:**
- Registration happens as an import side effect; importing twice (main + worker) silently re-registers without warning.
- Re-exports `registerAlgorithm` while calling it internally; mixed public/internal surface.

**Suggestions:**
- Log a warning on duplicate IDs.
- Consider a single `bootstrap()` function rather than module side effects.

### `src/js/dither/registry.js` — 51 lines
**Role:** In-memory registry + lookup for algorithms, grouped by family with stable display ordering.
**Quality:** ★★★★☆ — Clean, well-scoped; minor fallback behavior is surprising.
**Issues:**
- `runAlgorithm` **silently falls back to `floyd-steinberg`** when an ID is unknown — preview/export parity bug if a saved project references a missing algo.
- `runAlgorithm` mutates `imageData` in place but also returns it; convention undocumented.

**Suggestions:**
- Throw or warn instead of silently substituting Floyd–Steinberg.
- Document the in-place-mutation contract.

### `src/js/dither/core.js` — 76 lines
**Role:** Shared pixel utilities (luminance, clamp, mono/RGB read+write helpers, palette-monochrome check).
**Quality:** ★★★★☆ — Small, focused, reused everywhere.
**Issues:**
- `readLuminance` / `readRGB` allocate `width*height` Float32Arrays on every frame — for 1080p that is ~25 MB per call. Not pooled.
- `luminance8` uses Rec.709 coefficients on assumed sRGB data without linearization.
- `clamp(value, min, max)` doesn't guard against NaN — `Math.min(max, NaN)` returns NaN, propagating through diffusion buffers.

**Suggestions:**
- Add a buffer pool (one set per image dimension) so typed arrays are reused across frames.
- Note the sRGB assumption in a header comment.

### `src/js/dither/bayer.js` — 181 lines
**Role:** Ordered (Bayer / clustered-dot / halftone / dispersed-dot) matrix dithering, mono + RGB paths.
**Quality:** ★★★★☆ — Recursive Bayer generation is elegant and correct; matrices precomputed at module load.
**Issues:**
- `generateBayer(size)` assumes `size` is a power of two and ≥ 2; passing 1 misbehaves silently.
- `generateHalftone` divides `size/2` without enforcing even input.
- RGB bias is a single scalar applied to all channels — tinted artifacts on saturated colors.
- `(matrixValue + 0.5) / matrixMax - 0.5` recomputed per pixel — `matrixMax` is constant.

**Suggestions:**
- Precompute `bias` lookup tables `[matrixValue] -> bias` once per matrix.
- Validate `size` is power-of-two in `generateBayer`.

### `src/js/dither/error-diffusion.js` — 463 lines
**Role:** Kernel-based error diffusion (Floyd–Steinberg family, Stucki, Atkinson, Burkes, Sierra variants, Stevenson–Arce) + Riemersma Hilbert-curve dither.
**Quality:** ★★★☆☆ — Functionally correct, but hot-loop allocations and serpentine subtlety hurt.
**Issues:**
- `for (const offset of kernel.offsets)` in the inner loop creates an iterator per pixel; on 1080p with Jarvis (12 offsets) that is ~25M iterator allocations.
- Kernel offsets stored as object literals; property access in hot loop instead of typed-array indices.
- `kernel.divisor` is constant per call; `error * offset.weight / kernel.divisor` recomputes the divide per pixel/offset.
- `runRiemersmaBW` and `runRiemersmaRGB` are 90% duplicate.
- `hilbertExtent` rounds image up to next power-of-two square; for non-square images (1920x1080) the loop traverses 4.19M cells and skips ~50%. Wasted work scales quadratically.
- BW path threshold semantics differ from RGB path — toggling palette changes the look.

**Suggestions:**
- Convert kernels to two Int8Arrays (`dx[]`, `dy[]`) and one Float32Array (`weight/divisor`).
- Skip out-of-bounds cells in Riemersma traversal, or use Gilbert curve for non-square images.
- Extract shared Riemersma scaffolding into a helper.

### `src/js/dither/noise.js` — 143 lines
**Role:** Random / pseudo-blue / interleaved-gradient noise threshold dithers, plus the seedable mulberry32 PRNG.
**Quality:** ★★★☆☆ — Determinism preserved for `random`, but conflates "noise" sources misleadingly.
**Issues:**
- `pseudoBlueNoise` is a **golden-ratio low-discrepancy sequence, not blue noise.** UI advertises "Blue Noise" but spectrum is not blue without a precomputed tile.
- `interleavedGradient` and `pseudoBlueNoise` ignore the seed — deterministic by position but not seed-locked.
- `Number("")` returns 0; `NaN | 0` becomes 0 in mulberry32, so seeding silently collapses on bad input with no warning.
- BW path additive luma offset `noise - 128`, RGB path `(noise - 0.5) * 96` — different effective ranges (±128 vs ±48). Toggling palette changes perceived noise strength.

**Suggestions:**
- Rename `pseudoBlueNoise` → `goldenRatioNoise`, or ship a precomputed blue-noise tile PNG (small, deterministic, parity-safe).
- Unify BW vs RGB noise magnitude.
- Coerce `seed` carefully: `Number.isFinite(+params.seed) ? +params.seed : 1337`.

### `src/js/dither/pattern.js` — 206 lines
**Role:** Non-dithering pattern fills (cross-hatch, lines, dot tile) keyed off a luma-bucket level.
**Quality:** ★★★★☆ — Compact and readable; some duplication.
**Issues:**
- `SPACING` has 8 entries indexed by level 0..7; coupling implicit, if `LEVELS` changes silently mis-indexes.
- `runHorizontalLines`/`runVerticalLines`/`runCrossHatch`/`runDotPattern` are near-duplicates (~15 lines × 4).
- `(x - y + width * 2) % spacing` is magic; canonical positive-modulo form clearer.

**Suggestions:**
- Extract a `forEachPixel(imageData, fn)` helper.
- Pair `SPACING` length to `LEVELS` with an assertion.

### `src/js/dither/threshold.js` — 77 lines
**Role:** Simple per-pixel threshold (mono and palette paths).
**Quality:** ★★★★★ — Trivial, correct, no allocations beyond unavoidable nearest-palette lookup.
**Issues:**
- Same `threshold` shift inconsistency vs `error-diffusion.js`: BW thresholds directly; RGB pre-shifts then clamps. Cross-file parity concern.

**Suggestions:**
- None file-local; canonical.

### Cross-cutting (Dither)

- **Threshold semantics differ between BW and RGB.** With non-default `threshold`, toggling between monochrome and color palettes produces qualitatively different shifts — parity hazard.
- **Determinism risks.** No `Math.random()` use — good. But `Number(undefined) | 0 = 0` silently masks seed input bugs; Riemersma/ordered/IGN modes are seed-independent but sit next to seed-locked `random` in UI.
- **Hot-loop allocations.** Every algorithm allocates fresh Float32Arrays; many use `for...of` over plain object arrays. Measurable GC pressure at 30fps video preview.
- **Edge cases on huge images.** `readLuminance` for an 8K frame allocates 128 MB Float32Array. Riemersma's Hilbert traversal of 8192² = 67M cells, ~50% wasted for non-square frames.
- **Naming honesty.** `blue-noise` isn't blue noise. Either rename in UI or ship a precomputed mask.
- **Silent algorithm substitution.** `registry.runAlgorithm` defaulting to Floyd–Steinberg on unknown IDs masks broken project files.

---

## 4. Utilities

### `src/js/color.js` — 37 lines
**Role:** Centralizes HEX parsing/serialization to RGB shared by inspector, graph param migration, and shader uniforms.
**Quality:** ★★★★☆ — Tight, single-purpose, deterministic.
**Issues:**
- `normalizeHex` recurses with `fallback` as both `value` and `fallback`; parameter naming confusing.
- `rgbToHex` accepts negative/NaN silently.
- `hexToRgb01`'s fallback contract documented but not enforced.

**Suggestions:**
- Replace recursion in `normalizeHex` with a direct fallback resolve.
- Inline `HEX_RE` shared parsing into a single helper.

### `src/js/curve-lut.js` — 295 lines
**Role:** Builds 256-entry RGB tone curves (monotone cubic Hermite + legacy 3-point) and composes per-channel + master LUTs.
**Quality:** ★★★★☆ — Solid Fritsch–Carlson monotone interpolation, correct identity short-circuits.
**Issues:**
- Off-by-one risk in `sanitizeCurvePoints` interior filter: excludes legitimate x=3 / x=252 stops.
- `buildCurveLut` linear segment scan inside 256-loop is O(N×256).
- `buildFinalRgbCurvesLuts` allocates a new identity LUT per call.
- `getMonotoneCurveTangents` exported but no consumer visible — possibly dead.
- `clamp(Number(value), 0, 255)` returns `min` on NaN.

**Suggestions:**
- Cache a module-level `IDENTITY_LUT` constant.
- Replace the inner `while` segment search with a monotonic cursor.
- Verify `getMonotoneCurveTangents` is consumed; if not, prune.

### `src/js/image-ops.js` — 2602 lines
**Role:** Catalog of all CPU node operations (adjust/HSV/curves/levels/duotone/gradient map/scene grade/blur/glare/lens/displace/mask/mix/dither) plus the canvas buffer pool and box-blur fallback.
**Quality:** ★★★☆☆ — Functionally rich and well-commented, but a 2.6k-line monolith with luma coefficient drift and per-pixel array allocations.
**Issues:**
- **Luma coefficient inconsistency (parity risk):** `luminance8`/`luminance01`/`rgbToBw bt709`/Scene Grade use BT.709. `applyPosterizeCpu`, `applyLevelsNode` luma path, `applyDuotoneNode`, `applyGradientMapCpu`, `applyThresholdCpu`, `rgbLuma`, `applyDisplaceNode` debug use BT.601. **Single biggest correctness smell in the JS side.**
- Posterize off-by-one risk; chroma branch adds back per-channel delta against R quantization grid.
- Per-pixel allocations: `sampleGradientLut`, `sampleDisplaceMap`, `scaleRgbToLuma`, `hueToRgb01`, `rgbToHsv`/`hsvToRgb` return 3-element arrays inside loops. ~8M allocations/frame at 4K.
- `applyAdjustNode` claims "linear-light exposure" but data is sRGB-encoded — clipping behavior differs from linear.
- `applyHsvNode` clamps s/v in [0,4] then `clamp01(s * saturation)` zeros saturation if input is 0; value-boost above 1 silently clipped.
- `applyLayerAdjustmentsNode` opacity threshold of `<0.999` treats ≥99.9% as fully opaque — parity hazard if export uses different threshold.
- `applyDitherNode` trusts `params.algorithm`/`params.palette` strings unchecked.
- `applyMeshGradientCpu` uses `globalCompositeOperation = "screen"` to approximate the GPU path — won't match per-pixel weighted accumulation.

**Suggestions:**
- Centralize luma in `LUMA_BT709`/`LUMA_BT601` constants; pick one per node and document.
- Replace 3-element array returns with out-parameters or three scalars.
- Split by category (color-ops, geometry-ops, mix, dither, buffer pool).
- Validate `params.algorithm` against the dither index before calling `runAlgorithm`.

### `src/js/palettes.js` — 444 lines
**Role:** Built-in + custom palette registry with serialization, listeners, and a cached 16³ nearest-color LUT.
**Quality:** ★★★★☆ — Clean registry, WeakMap-cached LUT, defensive listener notify.
**Issues:**
- LUT cache keyed by palette **object reference**; mutating `palette.colors` in place would not invalidate.
- 16-step LUT precision: error vs exact search visible on near-boundary colors for 8-color palettes.
- `makeCustomPaletteId` suffix loop is uncapped.
- `registerPalette` accepts arbitrary color counts.
- `getPaletteExtremes` luma uses BT.709 (see cross-cutting).

**Suggestions:**
- Cache LUT by `palette.id` + version, not object identity.
- Cap palette color count in `registerPalette` (e.g. 256).
- Consider raising `LUT_STEP` to 32 (32 KB cost) for higher-fidelity nearest-match.

### `src/js/palette-extraction.js` — 310 lines
**Role:** Extracts an N-color palette from `ImageData` using median-cut over a stride-sampled histogram, with locked-color merge.
**Quality:** ★★★★☆ — Deterministic given fixed input; well-structured median-cut.
**Issues:**
- `MIN_COLOR_DISTANCE_SQ = 108` magic number — comment needed.
- `compareColorsByLuma` uses BT.709 (cross-cutting drift).
- Box score `max(rRange, gRange, bRange) * box.totalCount` doesn't account for variance — can over-prioritize splitting thin boxes.
- No validation `imageData.data.length === width*height*4`.

**Suggestions:**
- Document `MIN_COLOR_DISTANCE_SQ` and `MAX_SAMPLES` rationale.
- Add data-length assertion in `buildHistogram`.

### `src/js/effect-catalog.js` — 61 lines
**Role:** Static catalog of effect targets consumed by UI dropdowns and priority sorting.
**Quality:** ★★★★☆ — Frozen, minimal, no logic.
**Issues:**
- `target(source, id, label, category, priority)` positional API; swapping arguments wouldn't fail.
- `listEffectTargets` rebuilds the merged + sorted array on every call.

**Suggestions:**
- Replace positional `target()` with object literals frozen inline.
- Memoize `listEffectTargets()`.

### `src/js/gl/gradient-lut.js` — 166 lines
**Role:** Bakes multi-stop color gradients into a 256-wide RGBA LUT texture; shared by Gradient Map, Star Glow, Scene Grade, Gradient Source.
**Quality:** ★★★★★ — Clear contract, O(width + stops) paint, deterministic key. Best-written file in the batch.
**Issues:**
- `getGradientLutKey`'s pos precision is `toFixed(4)`; cache thrashes for sub-pixel drift.
- No upper bound on `options.width` — malicious save with `width: 1e9` would OOM.

**Suggestions:**
- Clamp `options.width` to `[2, 4096]`.
- Quantize pos to texel grid (`toFixed(3)`) for tighter cache hits.

### Cross-cutting (Utilities)

- **BT.601 vs BT.709 luma drift (preview/export parity risk).** Define `LUMA_BT709`/`LUMA_BT601` constants in `color.js`, pick a convention per node, document it, and verify GPU shaders match. **Single largest parity hazard across the JS side.**
- **Per-pixel array allocations.** 4K frames see ~8M allocations per node per frame. Convert to out-parameters or three-scalar returns.
- **Boundary validation gaps.** `applyDitherNode` algorithm key, `registerPalette` color count, `buildGradientLut` width, `palette-extraction` ImageData length — all unchecked. Malformed project save could OOM or corrupt state.
- **Magic-number tolerances.** `1e-5`, `1e-6`, `0.001`, `0.999`, `0.0001` used as identity thresholds inconsistently. Pick one project-wide epsilon.
- **`image-ops.js` size + duplication.** 2.6k-line monolith reuses createBuffer/drawImage/getImageData/loop/putImageData in 20+ functions. A `mapImageData(input, perPixelFn)` helper would shave ~600 lines.
- **Cache invalidation by object identity.** Palettes LUT and curve-lut bind to object identity. In-place mutation silently uses stale LUT. Prefer id+version keys.
- **Dead/unverified code.** `getMonotoneCurveTangents` export, CPU fallback paths reachable only when WebGL2 missing — silently diverge from GPU output without headless-GL test.

---

## 5. UI + Timeline

### `src/js/ui/shell.js` — 216 lines
**Role:** Initialises shell-level interactions: accordion sections, scopes drawer, panel resize handles, panel hide toggles, and localStorage persistence.
**Quality:** ★★★★☆ — Small, focused, idempotent, sensible pointer-capture, persistence guarded by try/catch.
**Issues:**
- `startResize` reads `getComputedStyle(...).minWidth` and `parseFloat`s it; same lookup duplicated in `applyStoredWidth`.
- `restoreShellState` silently swallows malformed JSON.
- `initAccordion` wires once on init; dynamically added toggles won't get a listener.

**Suggestions:**
- Extract `readSize(panel)` helper.

### `src/js/ui/player.js` — 2930 lines
**Role:** Transport bar, animation timeline rendering, keyframe interaction (pick/drag/marquee/tangent/bezier popover), playhead drag, render-range popover.
**Quality:** ★★☆☆☆ — Functionality solid but module is a complexity hotspot: 2930 lines, ~40+ render helpers, multiple ad-hoc drag state singletons.
**Issues:**
- File too large; mixed concerns (transport, ruler, lane render, graph editor, popovers, keyframe ops).
- Repeated `document.addEventListener("pointermove"/"pointerup"/"pointercancel")` install/uninstall across 6 drag states. Interleaving drags can leak partial cleanup.
- `subscribe("timeline", …)` re-renders the entire timeline (innerHTML on `propertyList`, `laneHost`, `timeRuler`) on every dispatch. Any change rebuilds hundreds of nodes.
- During keyframe drag, `seek(time)` is called every pointermove → state dispatch → full rebuild → janky drag.
- `setTimeout(() => marqueeJustEnded = false, 0)` is fragile.
- `wireMoreMenu` uses `setTimeout(0)` to defer outside-click listener; rapid open/close can leak handlers.
- `escapeHtml` defined here and in `graph-shell.js` — duplication.
- Playhead handle has no keyboard support (`tabindex`/arrow keys absent).
- `formatSeconds` (line 792) duplicates `formatTime` from `source.js`.
- `style="--curve-color:${options.color}"` interpolation bypasses `escapeHtml`. Today hardcoded palette; risky for future user-derived colors.
- Many module-level mutables (`selectedKeyframes`, `keyframeDrag`, `tangentDrag`, `playheadDrag`, `marqueeDrag`, `bezierPopover`, `timelineKeyframeClipboard`).

**Suggestions:**
- Split into `player-transport.js`, `player-timeline-render.js`, `player-keyframe-drag.js`, `player-bezier-popover.js`.
- Promote drag state into a single "active drag" controller.
- Diff-render lane DOM (per-keyframe nodes that mutate position) instead of `innerHTML =`.
- Add keyboard control for playhead, bezier handles, marquee.

### `src/js/ui/graph-shell.js` — 7202 lines
**Role:** Node graph editor (canvas pan/zoom, marquee, edge cut, palette drag/drop, breadcrumbs), inspector rendering for every node type, keyboard shortcuts.
**Quality:** ★★☆☆☆ — Single largest module in the audit; correctness looks high but scope is a maintainability red flag.
**Issues:**
- **7202 lines, ~150 functions in one module.** Renders for every node type live here.
- `wireKeyboard` registers global window listeners; no dismount path.
- `new ResizeObserver(() => applyGraphViewport())` never disconnected.
- `subscribe("graph", () => { … renderShell() })`: renders entire graph DOM (`nodesEl.innerHTML = ...`, `edgesEl.innerHTML = ...`) on every graph mutation. `inspectorEditing` guard helps only during inspector drags; node-drag and edge-drag still trigger full rebuilds.
- `requestAnimationFrame` fire-and-forget pattern in init and rename — can focus inputs that no longer correspond to the rename target.
- Many drag handlers attach `pointermove/pointerup/pointercancel` to `document` and rely on closures — blur/pagehide mid-drag won't reliably trigger pointercancel.
- `setCurrentGraphParent` dispatches `graphView` then `graph` — two consecutive state writes.
- `space + key` handler uses `stopImmediatePropagation()` on `window` — known shared-keyboard hazard.

**Suggestions:**
- Split per concern: `graph-viewport.js` (pan/zoom/marquee), `graph-render.js` (node/edge DOM), `graph-inspector.js`, `palette-ui.js`, `graph-keyboard.js`.
- Replace `innerHTML =` rebuilds with `replaceChildren` of pre-built DOM nodes.
- Add `pagehide`/`visibilitychange` listener that cancels active marquee/cut/drag.

### `src/js/ui/stage.js` — 515 lines
**Role:** Output canvas viewport: zoom/pan, split divider, pixel inspector, context menu, fit/1:1 toggles, image-rendering policy.
**Quality:** ★★★★☆ — Tight, well-commented, sensible RAF gating.
**Issues:**
- `wireContextMenu`/`wireZoomShortcuts` attach global `document` listeners with no removal — second `initStage` would double-bind. No guard.
- `wireZoomShortcuts` checks `target.tagName === "INPUT"` but misses `contenteditable` — Cmd+0/1 fires inside contenteditable.
- `samplePixel(u, v)` may force a getImageData flush on every mouse move.

**Suggestions:**
- Add an `initialised` guard to prevent double-binding.
- Include `isContentEditable` in `wireZoomShortcuts` early-return.

### `src/js/ui/viewer-gizmos.js` — 1030 lines
**Role:** On-canvas SVG gizmos for selected node parameters (point, angle, ring, mesh-stops, crop-box). Shared drag plumbing with RAF flushed patches and undo snapshots.
**Quality:** ★★★☆☆ — Logic mostly clean; size signals splitting per gizmo kind.
**Issues:**
- ResizeObserver and window resize listener never cleaned up.
- `beginDrag` removes listeners on `onDragEnd`; if the handle leaves the DOM mid-drag, cleanup never runs → `dragState` persists, `dragging-gizmo` body class lingers.
- `gizmoParamsEqual` uses `JSON.stringify` — brittle for non-serializable values.
- A11y: no `role`/`aria-label`, no keyboard alternative for drag. Pixel-precision mouse-only.

**Suggestions:**
- Defensive `onDragEnd` call on `source`/`selection` dispatch when an in-flight drag's target is stale.
- Provide arrow-key nudge for the active gizmo target.

### `src/js/ui/viewer-overlay.js` — 64 lines
**Role:** Hosts the SVG overlay layer inside `.stage-canvas` and exposes coordinate helpers between viewport / source canvas / overlay frames.
**Quality:** ★★★★★ — Tiny, single-purpose, clean coordinate math.
**Issues:**
- `getBoundingClientRect` invoked many times per frame from gizmo sync.

**Suggestions:**
- Cache rects per rAF tick if profiling shows BoundingRect dominating.

### `src/js/timeline.js` — 1341 lines
**Role:** Pure timeline domain logic: schema, normalization, easing/bezier evaluation, keyframe CRUD/move/duplicate/paste, autokey commit path, track lookups.
**Quality:** ★★★★☆ — Pure functions, no DOM, well-tested-looking surface.
**Issues:**
- `normalizeTimeline` is called repeatedly per public function — each call re-normalises every track. `hasTimelineKeyframeAtCurrentTime` and `getTimelineParamValue` each re-normalise.
- `clone(value)` uses `JSON.parse(JSON.stringify(value))`.
- `findKeyframeIndexAtTime` uses linear scan — on a 1000-keyframe track, 1000 ops per call.
- Public API broad (40+ exports). `setParamKeyframe` / `setTimelineKeyframe`, `removeParamKeyframe` / `removeTimelineKeyframe` are thin wrappers — worth consolidating.

**Suggestions:**
- Memoise `normalizeTimeline` by reference.
- Binary-search `findKeyframeIndexAtTime`.
- Deprecate the param-flavoured wrappers in favor of binding-shaped variants.

### `src/js/timeline-adapter.js` — 151 lines
**Role:** Translates between Shader Lab's external timeline JSON and the internal timeline shape.
**Quality:** ★★★★☆ — Tight adapter, pure, well-scoped.
**Issues:**
- `translateEasing` handles a fixed token map; arbitrary `cubic-bezier(...)` strings only round-trip via `normalizeEasing` later.
- `translateKeyframe` falls back to `raw` when not an object — could pass non-object into normalizer.
- `serializeShaderLabBinding` returns `null` for missing binding.

**Suggestions:**
- Either normalise easing fully here, or document the deferral.
- Return an empty binding object instead of `null` if Shader Lab tolerates it.

### Cross-cutting (UI + Timeline)

- **`escapeHtml` duplicated** in player.js and graph-shell.js with different implementations. Shared `ui/utils.js` is safer.
- **Style-attribute interpolations bypass escaping** in player.js (`style="background:${color}"`, `style="--curve-color:${...}"`). Today colors are hard-coded palette entries; risky for future user-derived colors.
- **`innerHTML =` is the dominant render strategy** in player.js + graph-shell.js. Loses focus/scroll, forces re-parse/re-layout, encourages `subscribe(..., fullRender)`. Replace with `replaceChildren` of DocumentFragments.
- **Global keyboard listeners overlap** between stage.js, graph-shell.js, player.js. `stopImmediatePropagation()` in graph-shell can hide bugs from neighbors. A central keyboard router would help.
- **No teardown/dispose API anywhere.** Singleton init is fine for current app lifetime but blocks hot reload, unit tests, multi-window.
- **A11y gaps** concentrated in custom controls (gizmo handles, playhead handle, bezier popover SVG handles). None have keyboard equivalents.
- **`requestAnimationFrame` fire-and-forget** scattered — not cancelled on selection change or unmount.
- **Module sizes bimodal.** `player.js` (2930) and `graph-shell.js` (7202) are far over a healthy maintainability ceiling. Splitting them is the single biggest leverage item.

---

## 6. Rust engine

### `src-tauri/src/main.rs` — 6 lines
**Role:** Binary entry point delegating to the library `run()`.
**Quality:** ★★★★★ — Minimal and idiomatic.

### `src-tauri/src/lib.rs` — 166 lines
**Role:** Tauri builder setup, menu construction, and command registration.
**Quality:** ★★★★☆ — Clean wiring; one stray `expect`.
**Issues:**
- `.expect("error while running tauri application")` panics inside FFI shell on Tauri startup failure.
- `on_menu_event` swallows `emit` errors silently (`let _`).

**Suggestions:**
- Replace top-level `.expect(...)` with a logged `if let Err(e) = ...`.
- Log the `emit` error in debug builds.

### `src-tauri/src/engine/mod.rs` — 7 lines
**Role:** Module re-export hub for the engine subtree.
**Quality:** ★★★★☆ — Trivial; `lens_flare`, `tracker`, `animation`, `node` public but unconsumed.
**Issues:**
- All four typed-scaffold modules will fire `dead_code` warnings.

**Suggestions:**
- Gate unused modules behind `#[cfg(feature = "native-engine")]` or add a top-of-file `#![allow(dead_code)]`.

### `src-tauri/src/engine/animation.rs` — 67 lines
**Role:** Typed serde model for animatable parameters, keyframes, and bezier handles.
**Quality:** ★★★★☆ — Well-shaped DTOs with no logic.
**Issues:**
- 100% dead at runtime.
- `Rgba` and `Vec2` derive `PartialEq` over `f32` — footgun for future HashMap keys.

**Suggestions:**
- Add module-level doc comment: "render-engine groundwork; not yet wired".

### `src-tauri/src/engine/frame.rs` — 872 lines
**Role:** The `native_render_graph` Tauri command — topo-sorts a node graph, dispatches to CPU effect functions (with optional GPU fast path), and returns RGBA bytes.
**Quality:** ★★★☆☆ — Works and is well-tested, but heavy CPU loops, duplicated dispatch logic, and a stringly-typed error API live on the hot path.
**Issues:**
- Returns `Err(String)` — JS can't distinguish "bad input" from "GPU init failed" except by substring.
- GPU triple-pattern `gpu_state.apply_*(...).unwrap_or_else(|_| apply_*(...))` silently swallows GPU error. If wgpu adapter init fails once, CPU fallback runs forever with no telemetry.
- Topological sort drops cycles silently — malformed graph yields a partial render instead of an explicit "cycle detected" error.
- `request.nodes.iter().find(...)` inside the order loop is **O(n²)**.
- Box-blur divide-by-`count` rounds toward zero instead of nearest (visible bias).
- `to_linear`/`to_srgb` use `powf(2.2)` rather than the piecewise sRGB transfer.
- Single-threaded; `apply_pixelate`'s nested loops dominate 4K preview latency.
- `apply_distort` returns garbage (zeros) outside the wrapped region instead of clamping.
- `pub(crate) FrameBuffer` exposes `pixels: Vec<u8>` with no invariants enforced outside `new()`.

**Suggestions:**
- Log (at minimum `eprintln!`) the GPU error before falling back.
- Detect cycles in `topological_sort` and return `RenderError`.
- Build a `HashMap<&str, &NativeGraphNode>` once before the loop.
- Seal `FrameBuffer.pixels` field.

### `src-tauri/src/engine/node.rs` — 59 lines
**Role:** Typed trait + DTOs for a future node-processor abstraction.
**Quality:** ★★★★☆ — Small, sane, unimplemented.
**Issues:**
- 100% dead code.
- `NodeProcessError { message: String }` mirrors `RenderError` in `frame.rs`.

**Suggestions:**
- Collapse `RenderError`/`NodeProcessError` into a single `engine::EngineError` enum once node-graph v2 lands.

### `src-tauri/src/engine/tracker.rs` — 47 lines
**Role:** Typed scaffolding for tracker samples and source bindings.
**Quality:** ★★★★☆ — Pure DTOs.
**Issues:**
- 100% dead code.
- `TrackerData.samples: Vec<TrackerSample>` is unsorted; lookup will need sort-on-load.

### `src-tauri/src/engine/lens_flare.rs` — 163 lines
**Role:** Typed model + passthrough `LensFlareProcessor` for the deferred native lens-flare path.
**Quality:** ★★★☆☆ — Large surface area for zero behavior; risks rot before use.
**Issues:**
- `process` is a passthrough returning the input unchanged.
- `resolve_source` always returns `None` — even calling against valid inputs does nothing.
- No serde round-trip tests for `FlarePreset` despite `version: u32` implying migration.

**Suggestions:**
- Add a single serde round-trip test for `FlarePreset`.
- Move behind `#[cfg(feature = "lens-flare")]` until the GPU render path is real.

### `src-tauri/src/engine/video_export.rs` — 289 lines
**Role:** FFmpeg-sidecar export session: spawn `ffmpeg`, pipe RGBA frames to stdin, finish or cancel.
**Quality:** ★★★☆☆ — Happy path solid, but cancel-race, stderr buffering, and `Drop` are weak.
**Issues:**
- **Stdio::piped stderr deadlock risk**: `stderr` piped but never drained until `wait_with_output()`. Long encode with stderr writes >~64KB will hang ffmpeg waiting on stderr-write.
- **Child process leak on panic**: no `Drop` impl on `ActiveSession`. If Tauri tears down mid-export, ffmpeg becomes an orphan.
- **Cancel race**: `remove_file` after `kill` can hit Windows sharing violation if ffmpeg is still writing.
- **Mutex poisoning**: every handler maps poison to a string — loses the actual cause.
- **Per-frame allocation**: `pixels: Vec<u8>` is allocated on the JS-Tauri boundary per frame at 8 MB.
- **`ffmpeg_binary()` relies on `$PATH`** — spec implies Tauri sidecar packaging.
- **No timeout on `wait_with_output()`** — UI hangs forever if ffmpeg hangs.
- **No validation of `output_path` extension vs codec** — `.mov` with `libx264` fails post-spawn.

**Suggestions:**
- Add `impl Drop for ActiveSession { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }`.
- Spawn a stderr-drain thread in `ffmpeg_start_encode`.
- Wrap mutex in `#[derive(thiserror::Error)] enum` so JS gets typed errors.
- Resolve ffmpeg via `tauri_plugin_shell` sidecar path.

### `src-tauri/src/engine/gpu/mod.rs` — 663 lines
**Role:** Lazy `wgpu` device + pipelines for three effects (pixelate/posterize/threshold), with sync readback to `FrameBuffer`.
**Quality:** ★★★☆☆ — Competent wgpu plumbing but synchronous, per-frame allocation, lock-contended.
**Issues:**
- **Sync `pollster::block_on` on Tauri command thread** in `GpuRenderer::new()` — first-call latency is multi-hundred ms.
- **Per-call allocation of everything**: every effect call creates new input texture, output texture, uniform buffer, readback buffer, bind group. 180 texture creations/sec at 60fps preview.
- **`poll(PollType::Wait { timeout: None })`** unbounded; if GPU hangs the Tauri worker hangs forever.
- **Single `Mutex<Option<GpuRenderer>>`**: all GPU calls serialize through one mutex; three pipeline nodes per frame = three lock/unlock cycles.
- **Stringly-typed errors** — JS can't programmatically detect "no adapter" vs "shader compile failed".
- **Readback path copies twice**.
- **`required_limits: Limits::downlevel_defaults()` caps texture size to 2048** — 4K preview frames fail device requirements and silently fall back to CPU.
- **Tests gate by error-string substring** — couples tests to exact message strings.

**Suggestions:**
- Initialize `GpuRenderer` once at app start on a background thread.
- Cache `(width, height) -> (input_tex, output_tex, readback_buf)`.
- Add a finite `timeout: Some(Duration::from_secs(5))` to `poll`.
- Raise `required_limits` to `Limits::default()`.

### Cross-cutting (Rust)

- **Stringly-typed errors everywhere.** `frame.rs`, `gpu/mod.rs`, `video_export.rs` all surface `Result<_, String>`. Introduce `#[derive(thiserror::Error)] enum EngineError { ... }` with `serde::Serialize` and emit `{ kind, message }` payloads. **Single highest-leverage refactor on the Rust side.**
- **No `Drop` for child processes or GPU state.** Add explicit `Drop` impls — at minimum on `ActiveSession` to kill ffmpeg orphans on quit-during-export.
- **`Stdio::piped` stderr never drained.** Either drain in a thread or null it.
- **GPU fallback silently masks real failures.** Log to stderr in debug builds at minimum.
- **Deferred groundwork is large and unguarded.** ~350 lines of pub types with no consumers; either `#[cfg(feature)]`-gate them or add `#![allow(dead_code)]` + `TODO(v2-node-graph)` markers.
- **Synchronous blocking on Tauri command threads.** `pollster::block_on` in `GpuRenderer::new`, unbounded `wait_with_output` in `ffmpeg_finish_encode`, unbounded `poll(Wait)` in GPU readback. Anything cancellable should accept a cancellation token.
- **No panic boundaries on commands.** Pipeline-creation in `gpu/mod.rs` can panic from inside `pollster::block_on`. Wrap in `catch_unwind` or precompile pipelines inside a `Result`.

---

## 7. HTML / CSS / Config

### `src/index.html` — 411 lines
**Role:** Single-page shell hosting inspector, preview stage, node editor, timeline, and right inspector for the Tauri webview.
**Quality:** ★★★★☆ — Semantic landmarks present; aria attributes used; no inline scripts/styles.
**Issues:**
- No `<meta http-equiv="Content-Security-Policy">` fallback; `tauri.conf.json` sets `csp: null`.
- Glyph-only `<button>`s (`‹`, `›`, `▾`, `▶`, `■`, `↻`, `⋯`, `×`) rely on `title`/`aria-label`; unicode glyphs leak into the accessible name on some SRs without `aria-hidden`.
- No `h1` in the page.
- Drag-and-drop palette items use plain `<div draggable="true">` instead of `<button>` — not keyboard-reachable.
- `aria-pressed="true"` on loop button hardcodes default state.

**Suggestions:**
- Wrap glyph contents in `<span aria-hidden="true">`.
- Add a `<h1 class="sr-only">Dither Lab</h1>` for landmark orientation.
- Move palette item lists into a JS-generated template (drift risk vs `nodeRegistry`).

### `src/styles/reset.css` — 47 lines
**Role:** Minimal CSS reset.
**Quality:** ★★★★★ — Tight, surgical, no surprises.
**Issues:**
- `user-select: none` on `<body>` blocks selection inside inputs unless explicitly re-enabled.

**Suggestions:**
- Scope `user-select: none` to `#app` chrome, or add `input, textarea, [contenteditable] { user-select: text }`.

### `src/styles/main.css` — 4184 lines
**Role:** Design tokens + layout + every component skin.
**Quality:** ★★★☆☆ — Coherent tokens but monolithic, with 24 distinct `z-index` values, 6 `!important` rules, and only two responsive breakpoints.
**Issues:**
- **No dark-mode token alternative.** Fixed dark colors; future light mode requires token rewrite.
- **z-index sprawl.** 1, 2, 4, 5, 6, 10..14, 18, 32, 200, 1200 — no commented scale.
- **px-only spacing** (~686 raw `px`, no `rem`). High-DPI Windows users with OS scaling get a fixed-size UI.
- **Magic radius scale.** `--radius-xs/sm/md/lg/xl/shell/surface/player/handle` — md/lg/xl differ by 1px, shell/lg/handle are all 6px. Aliases obscure rather than clarify.
- **6 `!important` rules.** Plus selector specificity wars: `#app.panel-hidden-left .inspector > *`.
- `@media (max-width: 720px)` block is dead because `tauri.conf.json` sets `minWidth: 1000`.

**Suggestions:**
- Split into `tokens.css`, `layout.css`, `graph.css`, `timeline.css`, `export.css`, `inspector.css`.
- Define a documented z-index scale (`--z-base, --z-toolbar, --z-popover, --z-modal`).
- Collapse the radius tokens to xs/sm/md/lg/xl with distinct values.
- Audit `!important` and selector-ID chains.
- Run an automated unused-selector check.

### `src/styles/controls.css` — 1029 lines
**Role:** Form/control primitives.
**Quality:** ★★★★☆ — Focused, well-commented, sensible token use.
**Issues:**
- Slider thumb/track rules duplicated for `-webkit-` and `-moz-` (unavoidable but bloated).
- Lots of unscoped global selectors: `input[type="range"]`, `input[type="checkbox"]`, `input[type="text"], input[type="number"]`.
- `.range-field .num-edit` and `.number-field .num-edit` duplicate `appearance: textfield` / spinner-hide.
- Inline color literals (`rgba(255,255,255,0.x)`, `rgba(131,196,255,…)`) appear ~30 times — should be tokens.
- `body.dragging-xy-pad`, `body.dragging-gradient-ramp`, `body.dragging-color-picker`, `body.scrubbing-num-edit` are four ad-hoc body-state classes; no convention.
- `::-webkit-color-swatch` is dead if no `<input type="color">` is rendered.

**Suggestions:**
- Promote `--surface-overlay-{1..4}` token set.
- Extract `.num-edit` base.
- Standardise body-state classes as `data-dragging="..."`.

### `package.json` — 14 lines
**Role:** Declares JS package metadata + Tauri CLI dev dependency.
**Quality:** ★★★★★ — Exactly as small as it should be.
**Issues:**
- No `engines.node` pin.
- No `lint`/`format` scripts.
- Missing `repository`, `license`, `author`.

**Suggestions:**
- Add `"engines": { "node": ">=18" }`.
- Add a `"smoke"` script.
- Add `repository`, `license`, `author`.

### `src-tauri/Cargo.toml` — 24 lines
**Role:** Rust crate manifest.
**Quality:** ★★★★☆ — Clean, intentional feature flags.
**Issues:**
- `wgpu` features `metal, vulkan, gles` — dropping dx12 means older Intel iGPUs on Windows fall back to GLES.
- `assetProtocol.scope: ["**"]` exposes filesystem (see tauri.conf.json).
- No `[profile.release]` overrides — `lto = "thin"`, `codegen-units = 1`, `strip = "symbols"` would shave MB.
- `pollster = "0.4"` worth verifying still needed.

**Suggestions:**
- Add release profile section.
- Document why dx12 is off (per recent commit history).

### `src-tauri/tauri.conf.json` — 42 lines
**Role:** Window + bundle + security config.
**Quality:** ★★☆☆☆ — Functional, but `csp: null` + `assetProtocol.scope: ["**"]` is the loosest local-first posture possible.
**Issues:**
- **`security.csp: null`** disables CSP entirely.
- **`assetProtocol.scope: ["**"]`** grants renderer filesystem access. Anyone who XSS-es the renderer can exfiltrate any file.
- `withGlobalTauri: true` widens attack surface when CSP is null.
- No `bundle.shortDescription`, `longDescription`, `copyright`, `category`, `publisher`.
- No `bundle.macOS.minimumSystemVersion` / `bundle.windows.wix`.

**Suggestions:**
- Set strict CSP: `default-src 'self'; img-src 'self' asset: data: blob:; media-src 'self' asset: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost`.
- Tighten `assetProtocol.scope` to user-picked directories at runtime.
- Add `bundle.publisher`, `bundle.copyright`, `bundle.shortDescription` before first public release.

### Cross-cutting (HTML/CSS/Config)

- **Security posture inconsistency.** Local-first promise vs CSP disabled + asset protocol scoped to `**` + plugins at `:default` permission. Pick the minimum each plugin needs.
- **Capabilities not least-privilege.** Tauri 2 supports granular commands (`fs:allow-read-file`, `dialog:allow-open`); current config is closer to v1 allowlist convenience.
- **Design token cohesion.** ~30 magic `rgba()` literals bypass the `:root` token set. Either commit fully to tokens or document the philosophy.
- **A11y baseline.** Glyph-only buttons rely on `aria-label`/`title` without `aria-hidden` on inner spans.
- **Heading-order/landmark cleanup.** `<h1>` absent; only `<h2>` is dynamic node title; lone `<h3>` on timeline.
- **Static markup vs runtime registry.** Node palette is hand-written HTML; a contributor adding to `js/graph/nodeRegistry` will silently forget the HTML row.
- **Responsive coverage.** `minWidth: 1000` makes `@media (max-width: 720px)` dead.
- **No `engines.node`, no lint/format scripts.** Vanilla-JS still benefits from `prettier --check src/**/*.{js,css,html}`.

---

## 8. Top priorities

Synthesized from all seven groups, ranked by leverage × risk. "P0" = preview/export parity or stability; "P1" = security; "P2" = maintainability; "P3" = future-proofing.

### P0 — preview / export parity & stability

1. **BT.601 vs BT.709 luma drift across `image-ops.js`, `palettes.js`, `palette-extraction.js`.** The single biggest correctness smell in the JS side. Define `LUMA_BT709` / `LUMA_BT601` constants in `color.js`, pick a convention per node, document the rationale, and verify GPU shaders match. Touches ~7 nodes in `image-ops.js`.

2. **`noise` source missing from `TIME_AWARE_TYPES` in `graph-runtime.js:71`.** Animated noise (`animSpeed > 0`) won't bust the cache on playhead scrub — same params + same inputs return a stale frame. Real parity bug. One-line fix.

3. **`registry.runAlgorithm` silently substitutes Floyd–Steinberg on unknown IDs.** Masks broken project files; preview will look fine but export silently disagrees with the saved spec name. Throw or warn instead.

4. **Stringly-typed errors across Rust FFI (`frame.rs`, `gpu/mod.rs`, `video_export.rs`).** JS can't branch on error kind without substring matching. Introduce `#[derive(thiserror::Error)] enum EngineError` with `serde::Serialize` and emit `{ kind, message }` payloads. Highest-leverage Rust refactor.

5. **`Stdio::piped` stderr never drained in `video_export.rs`.** ffmpeg can hang on full stderr pipe (~64KB) when warnings emit. Spawn a drain thread.

6. **No `Drop` impl on `ActiveSession` (`video_export.rs`).** ffmpeg orphans accumulate if the user quits mid-export. Add `impl Drop { kill+wait }`.

7. **`native-render.js` one-shot disables itself on any rejection.** Transient GPU/Rust hiccup permanently demotes the user to JS path until reload. Add a reset hook.

8. **`async` functions called synchronously in `source.js`** (`renderCurrentFrame`, `getCurrentExportFrameCanvas`, `hasCurrentDitherFrame`). Outside an export session, fire-and-forget returns stale canvases. Standardize awaiting.

### P1 — security

9. **`tauri.conf.json`: CSP disabled + asset protocol scope `**`.** Loosest local-first posture possible. Set a strict CSP and tighten asset scope to user-picked directories at runtime. The single biggest local-first hygiene gap.

10. **Tauri capabilities not least-privilege.** `shell:default`, `fs:default`, `dialog:default`, `opener:default` — switch to granular permissions (`shell:allow-execute` with exact path for ffmpeg, `fs:allow-read-file`, etc.).

11. **Style-attribute interpolations in `player.js`** (`style="background:${color}"`, `style="--curve-color:${color}"`) bypass escaping. Today colors are hardcoded; risky if any becomes user-derived. Funnel through `normalizeHex`.

### P2 — maintainability

12. **Module size bombs.** `graph-shell.js` (7202), `gpu-effects.js` (3198), `graph.js` (3099), `player.js` (2930), `image-ops.js` (2602), `export.js` (2210), `source.js` (1602). Splitting by concern is the largest one-time maintainability win. Priorities: `graph-shell.js` (highest), `player.js`, `image-ops.js`.

13. **`innerHTML = …` is the dominant render strategy in `player.js` + `graph-shell.js`.** Forces re-parse/re-layout, loses focus/scroll mid-drag. Replace with `replaceChildren` of pre-built DocumentFragments, or per-element diff.

14. **Deep-clone-the-world in `graph.js` mutations.** Every mutation does `graph.nodes.map(node => clone(node))` even when only one node changes. Surgical: replace with `[...graph.nodes]` where applicable.

15. **Per-pixel array allocations in hot loops** (`sampleGradientLut`, `sampleDisplaceMap`, `scaleRgbToLuma`, `rgbToHsv`/`hsvToRgb` in `image-ops.js`; `for...of` over kernel arrays in `error-diffusion.js`). 4K = ~8M allocations per node per frame. Convert to out-parameters or three-scalar returns.

16. **`escapeHtml` duplicated** in `player.js` and `graph-shell.js` with different implementations. Extract to `src/js/ui/utils.js`.

17. **No teardown/dispose API.** `gpu-effects.js` never disposes WebGL programs/FBOs/mip chains/extra textures; `viewer-gizmos.js` ResizeObserver never disconnected; global keyboard listeners never removed. Multi-hour Tauri sessions accumulate state; tests can't tear down.

18. **`pseudoBlueNoise` is not blue noise.** UI advertises "Blue Noise" but it's golden-ratio low-discrepancy. Either rename or ship a precomputed mask.

### P3 — future-proofing

19. **GPU resource lifetime open-ended in `gpu-effects.js`.** Add `disposeRenderer()` + `webglcontextlost` listener.

20. **Tauri API duplication.** `selected.path` normalization, `tauri.fs.rename ?? renameFile`, `tauri.core.invoke ?? tauri.invoke` patterns appear across files. Extract `src/js/tauri-compat.js`.

21. **`subscribe(..., fullRender)` pattern.** Coarse subscribers re-render entire DOM on unrelated state changes. Document which topics each module owns vs observes; freeze `getState()` slots in dev.

22. **Deferred Rust groundwork (`animation.rs`, `node.rs`, `tracker.rs`, `lens_flare.rs`)** is ~350 lines of unused pub types. Either `#[cfg(feature)]`-gate or add `#![allow(dead_code)]` + `TODO(v2-node-graph)` markers.

23. **Inspector / a11y gaps.** Gizmo handles, playhead handle, bezier popover SVG handles have no keyboard alternative. Extend the F23 scrubbable-number pattern.

24. **No `engines.node`, no lint/format scripts, no CI.** Add `"engines": { "node": ">=18" }`, a `prettier --check` script, and a smoke target.

---

*End of audit.*
