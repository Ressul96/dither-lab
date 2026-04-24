# Dither Lab TODO

Short-term source of truth for the next execution order. Tickable mirror lives in
`ROADMAP.md`. Background specs:
- `docs/spec/v2-node-graph.md`
- `docs/spec/implementation-plan.md`
- `docs/spec/ui-and-ux.md`
- `docs/spec/algorithms-and-color.md`

## Current Status (2026-04-23)

- Phases A / B / C / D first-pass: landed in code.
- Phase 6 (27-algorithm catalog): landed. Verified by `smoke/algorithms.html`
  (27 × 4 palettes = 108/108 passed).
- Phase 7 core (14 built-in palettes + LUT + dropdown): landed.
- Phase 7 custom palette editor: landed.
- Phase 7 palette extraction from frame: landed.
- Phase 11 (export pipeline): current-frame still export now flows through the
  export sheet; video, sequence, progress, cancel are still open.
- Native render / Lens Flare: deferred until app is stable.

The working plan is **Plan B**: finish feature depth before export hardening.

## Execution Order

### 1. Phase 7 — Custom Palette Editor

Goal: let the user build and name a custom palette without leaving the app.

- Add a `Palette Manager` section to the inspector.
- Support adding, editing, removing, and reordering swatches.
- Name field + save-as action registers into the palette registry.
- Custom palettes persist in project save/load.
- New dropdown entries show both built-in and user palettes.

Acceptance:
- A user can create a 5-color custom palette, apply it on a `Dither` node,
  and reopen the project with the same palette selected.

Status:
- Landed on `2026-04-23`.
- Custom palettes can be created, duplicated, renamed, edited, deleted, and
  saved/loaded with the project.

### 2. Phase 7 — Palette Extraction from Frame

Goal: sample the current viewer frame and drop the result into the editor.

- User picks target palette size (2, 4, 8, 16, 32).
- Extraction runs on the current viewer frame (respects compare mode semantics:
  use the original source, not the processed result).
- Algorithm: median cut or K-means; must be deterministic for a given frame.
- Locked swatches are preserved when re-extracting.
- Result lands in the custom palette editor for further edits.

Acceptance:
- Extracting from a Gameboy-era screenshot yields a believable 4-color palette.
- Re-running extraction with one swatch locked keeps that swatch intact.

Status:
- Landed on `2026-04-23`.
- Uses the current source frame, not the processed preview.
- Supports `2 / 4 / 8 / 16 / 32` color extraction and locked-swatch re-extract.

### 3. Phase C Stabilization Smoke (real Tauri dev)

Needs an actual `npm run tauri dev` session, not the static smoke harness.

- Playback: autoplay, loop, restart, frame step, scrubber, trim, loop + trim
  interaction.
- Compare modes: `Processed`, `Dither Only`, `Original`, `Split`, `Side by Side`
  under zoom + pan + playback.
- Branched graph: build `Source -> Adjust -> Dither -> Mix <- Glow -> Viewer`
  and confirm live preview + still-frame export match.

Acceptance:
- No compare mode desyncs under zoom, pan, or scrubbing.
- Branched graph renders the same pixels in preview and in PNG export.

### 4. Phase 11 — Export Sheet / Modal

- Triggered by the existing `Export` entry point.
- Modes: current frame PNG, video, image sequence.
- Output path picker (native file dialog via Tauri).
- Format + codec selector for video mode.
- Frame-range picker for sequence mode (default: full trim range).

Acceptance:
- Sheet opens from the export button and from the menu action.
- Current-frame PNG export flows through the sheet without regressing the
  existing direct-export path.

Status:
- Landed on `2026-04-23`.
- Current-frame still export now uses the sheet with target/format/resolution
  controls.
- Video and image-sequence modes stay scaffolded for the next export tick.

### 5. Phase 11 — Video Export Pipeline (FFmpeg Sidecar)

- Bundle FFmpeg as a Tauri sidecar (per target platform).
- Stream rendered frames into FFmpeg stdin (ppm or rawvideo).
- Export node graph must evaluate identically to preview for every frame.
- Seed-locked algorithms must be deterministic between preview and export.

Acceptance:
- A 5-second source exports as MP4 at the source frame rate.
- Preview parity check passes on at least one error-diffusion and one noise
  algorithm.

### 6. Phase 11 — Image Sequence Export

- Numbered PNG or EXR output per frame.
- Naming template (`name_00001.png`, configurable start index and padding).
- Honors frame-range picker.

Acceptance:
- 100-frame sequence exports with zero-padded names and matches preview.

### 7. Phase 11 — Progress + Cancel + Reveal

- Progress bar with frames rendered / total.
- Cancel button aborts the FFmpeg child cleanly.
- On success, a `Reveal in Finder / Explorer` button.

Acceptance:
- Cancelling mid-export leaves no zombie FFmpeg process.
- Reveal opens the output location on all three platforms.

## Deferred

- Native render track beyond the current engine boundary.
- Lens Flare MVP, preset format, wgpu pipeline.
- Any WebGL acceleration of Bayer / ordered algorithms (nice-to-have once
  export is solid).

## Smoke Harness

`smoke/algorithms.html` runs every registered dither algorithm against four
reference palettes on a synthetic test image. Served by the `smoke` config in
`.claude/launch.json` on port `5177`. Rerun after any edit under
`src/js/dither/` or `src/js/palettes.js`.
