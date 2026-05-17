# Dither Lab Roadmap

This is the current tickable roadmap.

Use this file as the practical progress tracker.

`TODO.md` stays as the narrative planning document.

Last refresh: `2026-04-23` (Plan B pass)

## Current Snapshot

- [x] `Phase A` complete
- [x] `Phase B` complete
- [x] `Phase C` core feature pass complete
- [ ] `Phase C` final stabilization smoke pass (needs real Tauri dev run)
- [~] `Phase D` started in code, not fully productized yet
- [x] `Phase 6` dither catalog (27/27) — smoke-verified 108/108 combos
- [x] `Phase 7` palette system — built-ins + LUT + editor + frame extraction done
- [~] `Phase 11` export pipeline started in code
- [~] Native render groundwork started
- [ ] Lens Flare native MVP (deferred)

## Phase A - Node Shell Pivot

- [x] Preview + node editor + inspector shell landed
- [x] Boot graph created automatically
- [x] `Source -> Viewer Output` default chain works
- [x] Player/stage workflow preserved during pivot

## Phase B - Graph-Driven Preview

- [x] Preview reads from graph output instead of old layer-first path
- [x] Compare modes moved into preview area
- [x] Pixel inspector samples source and processed buffers separately
- [x] Split divider is viewer-space based

## Phase C - Core Graph Usability

### Graph and Processing

- [x] `Adjust` node
- [x] `Dither` node
- [x] `Blur` node
- [x] `Glow` node
- [x] `Distort` node
- [x] `Mix` node
- [x] Graph evaluator supports all current nodes
- [x] `Dither Only` reads nearest upstream dither result
- [x] Project save/load stores graph, compare state, trim, and graph viewport

### Node Editor

- [x] Palette click-to-add fallback
- [x] Palette drag-and-drop add
- [x] Infinite-style pan/zoom viewport
- [x] Node dragging
- [x] Socket-based rewiring
- [x] Cycle rejection
- [x] Deterministic single-input rewiring
- [x] Delete selected node
- [x] Minimal node visuals with left input / right output sockets

### Inspector

- [x] Single-title inspector layout
- [x] Selected node header
- [x] Param controls for `Adjust`
- [x] Param controls for `Dither`
- [x] Param controls for `Blur`
- [x] Param controls for `Glow`
- [x] Param controls for `Distort`
- [x] Param controls for `Mix`
- [x] `Source Info` collapsed by default

## Phase C Stabilization

### Playback

- [x] Source auto-plays on import
- [x] Loop enabled by default
- [x] Play/pause state synced to real media element
- [x] Restart respects trim start
- [x] Frame step respects trim range
- [x] Trim drag clamps playhead back into valid range
- [ ] Full playback smoke pass after latest fixes (needs Tauri dev)

### Compare Modes

- [x] `Processed`
- [x] `Dither Only`
- [x] `Original`
- [x] `Split`
- [x] `Side by Side`
- [x] Split divider draggable
- [x] Split divider follows viewer zoom/pan space
- [x] Side-by-side layout renders processed left / original right
- [ ] Re-run compare smoke pass on freshly rebuilt app bundle

### UX Polish

- [x] Open source button removed from canvas UI
- [x] Drag-and-drop source import on preview
- [x] Radius cleanup pass
- [x] Edge hide handles moved to outer middle edge
- [x] Right-side `Export` entry added
- [x] Export button wired to menu-equivalent action
- [x] Current-frame PNG export from `Viewer Output`
- [x] Panel widths persist
- [x] Panel hidden states persist
- [x] Preview/node editor split height persists

## Phase D - Compositor Expansion

First-pass support already exists in code.

- [x] `Mix` node exists
- [x] `Blur` node exists
- [x] `Glow` node exists
- [x] `Distort` node exists
- [x] Inspector controls exist for these nodes
- [x] Runtime evaluation exists for these nodes
- [ ] Branched graph workflows need deliberate smoke testing
- [ ] Preview/export parity needs to be hardened beyond still-frame export
- [ ] Phase D should be redefined around robustness, not first implementation

## Phase 6 - Dither Algorithm Catalog

All 27 algorithms registered in `src/js/dither/` and verified by `smoke/algorithms.html`.

### Error Diffusion (11/11)

- [x] Floyd-Steinberg
- [x] False Floyd-Steinberg
- [x] Jarvis-Judice-Ninke
- [x] Stucki
- [x] Atkinson
- [x] Burkes
- [x] Sierra
- [x] Two-Row Sierra
- [x] Sierra Lite
- [x] Stevenson-Arce
- [x] Riemersma (Hilbert-curve)

### Ordered / Bayer (8/8)

- [x] Bayer 2x2
- [x] Bayer 4x4
- [x] Bayer 8x8
- [x] Bayer 16x16
- [x] Clustered Dot 4x4
- [x] Clustered Dot 8x8
- [x] Halftone
- [x] Dispersed Dot

### Threshold / Noise (4/4)

- [x] Simple Threshold
- [x] Random
- [x] Blue Noise
- [x] Interleaved Gradient Noise

### Pattern (4/4)

- [x] Cross-hatch
- [x] Horizontal Lines
- [x] Vertical Lines
- [x] Dot Pattern

### Smoke

- [x] `smoke/algorithms.html` runs 27 × 4 palettes, 108/108 passed (2026-04-23)
- [ ] Param permutation smoke (invert, scale, blurRadius, errorStrength, serpentine off)
- [ ] Seed determinism check (Random)

## Phase 7 - Palette System

### Built-ins (14/14)

- [x] Monochrome
- [x] Grayscale 2-bit
- [x] Grayscale 4-bit
- [x] Gameboy DMG
- [x] Gameboy Pocket
- [x] CGA Mode 4 Palette 1
- [x] CGA Mode 5
- [x] NES
- [x] Commodore 64
- [x] Mac Plus
- [x] ZX Spectrum
- [x] Teletext
- [x] Pico-8
- [x] Apple II Lo-Res

### Mechanics

- [x] Palette registry
- [x] Precomputed RGB LUT (16^3)
- [x] `nearestColorInPalette` matching
- [x] Inspector palette dropdown
- [x] Custom palette editor (name, swatches, add/remove/edit)
- [x] Palette extraction from current frame (size picker, locked swatches)
- [x] Project save/load for custom palettes
- [x] Palette manager section in inspector

## Export Track (Phase 11)

- [x] `Viewer Output` is the export source of truth
- [x] Export sheet/modal
- [x] Current-frame still export routed through the sheet
- [ ] Video export pipeline (FFmpeg sidecar)
- [ ] Image-sequence export pipeline
- [ ] Progress UI
- [ ] Cancel/reveal flow
- [ ] Preview/export color + seed parity harness

## Native Render Track

- [x] Rust engine boundary added under `src-tauri/src/engine`
- [x] Rust-side frame/node/animation/tracker contracts added
- [x] Lens flare architecture spec written
- [ ] Serializable preset format
- [ ] Graph-level `Lens Flare` node contract
- [ ] Native preview path for advanced nodes
- [ ] wgpu pipeline

## Lens Flare Track (deferred)

- [x] Future architecture/design spec
- [ ] Manual source placement MVP
- [ ] Keyframed source animation model
- [ ] Single-source native processor
- [ ] Preset loader
- [ ] Texture asset ingestion from `Optical Flares Textures`
- [ ] Procedural objects
- [ ] Texture-backed objects
- [ ] Blend pipeline
- [ ] Tracker input binding

## V3 Timeline Editing Track

Spec: [docs/spec/v3-timeline-editing.md](docs/spec/v3-timeline-editing.md). OpenCut-inspired
clip-based multi-track editor on top of the V2 node graph. Two "track" namespaces stay separated:
existing `state.timeline.tracks` = Parameter Tracks (keyframes); new `state.composition.tracks` =
Media Tracks (clips).

### Phase A - Composition State

- [ ] Add `state.composition` slice (version, fps, duration, tracks, sources)
- [ ] Composition reducer + dispatch path (single chokepoint for edit ops)
- [ ] Project save/load: read/write `composition` key with schema version bump
- [ ] Backward-compat migration: legacy project with single source → one video track, one clip
- [ ] Autosave covers composition state
- [ ] Resolve four open questions from the spec (inspector mode, composition node, schema number,
      panel persist scope)

### Phase B - Read-Only Timeline

- [ ] Timeline panel container in the player card area (resizable, persistent height)
- [ ] Ruler + playhead driven by composition time
- [ ] Single Media Track lane rendering clip rectangles
- [ ] Preview pulls active clip's source frame into the existing graph at time `t`
- [ ] Export walks `composition.duration * fps`; reuses Phase 11 ffmpeg pipeline
- [ ] Parameter Tracks render under the same time axis (collapsed by default)

### Phase C - Core Edit Operations

- [ ] Drag media from source list onto track (insert clip with snap)
- [ ] Trim head/tail (clamps to source extents and neighbor edges)
- [ ] Split at playhead (`S`)
- [ ] Move clip with snap (playhead, neighbors, ruler ticks)
- [ ] Ripple delete (`Shift+Delete`)
- [ ] Per-clip enable toggle
- [ ] Undo/redo via existing F17 atomic-drag pattern
- [ ] Selection model (single clip → inspector shows clip props)

### Phase D - Multi-Track + Audio

- [ ] Second video track with top-wins resolver
- [ ] Video element pool (LRU, N=2–3 warm decoders)
- [ ] Audio Media Track type
- [ ] Web Audio preview (mute/solo per track)
- [ ] FFmpeg `-filter_complex` plan for audio export
- [ ] Source-id namespacing in frame cache (avoid collisions between clips sharing a source)

### Phase E - Polish

- [ ] Slip (`Alt+drag` body)
- [ ] Slide (`Cmd+drag` body)
- [ ] Ripple trim (`Alt+drag` edge)
- [ ] Zoomable ruler (mouse wheel + pinch)
- [ ] Magnet snap toggle (`N`)
- [ ] Marker support
- [ ] Export sheet: Range becomes Full Composition / In-Out / Selected Clip

### Deferred to V4

- [ ] Transitions (cross-fade, dip-to-black) — needs a render-time blend pass
- [ ] Per-clip independent node graphs
- [ ] Nested compositions / sub-sequences
- [ ] Adjustment-layer effect tracks
- [ ] Speed ramps, time remapping, reverse
- [ ] Multi-camera angles
- [ ] Title / text / sticker tools

## Recommended Next Ticks (Plan B order)

- [ ] Phase C stabilization smoke on real Tauri dev (playback + compare + branched graph)
- [ ] Phase 11: video export via FFmpeg sidecar
- [ ] Phase 11: sequence export
- [ ] Phase 11: progress + cancel + reveal
- [ ] V3 Phase A: composition state slice + project schema bump
