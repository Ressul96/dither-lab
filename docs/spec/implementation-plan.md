# Implementation Plan

## Build Phases

Work through these in order. Commit after each phase.

### Phase 1 - Scaffolding

- `npm create tauri-app@latest` with vanilla JS template
- Configure `tauri.conf.json`:
  - window `1400x900`
  - resizable
  - allowlist/capabilities for dialog, fs, and shell as needed
- Create the application menubar skeleton:
  - `File`
  - `Edit`
  - `View`
  - `Window`
  - `About`
- Include `New/Open/Save Project` placeholders from day one
- Create folder structure per architecture spec
- Wire up dev script
- Confirm `npm run tauri dev` launches an empty window

### Phase 2 - UI Shell

- Build left inspector with all controls as non-functional shells
- Build main stage with empty-state drop prompt
- Add floating player card shell
- Add compact floating history card for `Undo` and `Redo`
- Add compare mode controls and trim rail to the player card
- Add right-side utility tab shells:
  - `Layers`
  - `EXR`
  - `Adjust`
- Add shells for:
  - scopes toggle
  - A/B snapshot controls
  - pixel inspector HUD
- Remove dependence on large top-of-canvas action buttons
- Ensure all visible UI copy is English-only
- Apply CSS tokens and component styling from the UI spec

### Phase 3 - Playback Foundation

- `File > Open Source...` and related menu actions via Tauri APIs
- Load a video into a hidden `<video>` and draw passthrough frames to the canvas
- Auto-create `Original Layer` and `Dither Layer` when a source is loaded
- Wire history card to the same `Undo` and `Redo` actions as the menu
- Wire timeline scrubber, play/pause, frame step, FPS slider, compare toggles
- Implement zoom/pan stage controls and pixel inspector overlay
- Add stage right-click context menu with `Export Current Frame...`
- Implement A/B snapshot capture and restore
- Wire right-panel `Adjust` tab controls for preview-only source corrections
- Implement non-destructive trim state and draggable handles
- Keyboard shortcuts:
  - `Space` = play/pause
  - `Left/Right` = frame step
  - `Home` = restart
- Basic history for `Edit > Undo` and `Redo`

### Phase 4 - Sequences and EXR Ingest

- Build a source-provider abstraction so video and image sequences share one playback API
- Detect numbered image sequences and compute frame range
- Add folder or first-frame import flow for numbered sequences
- Add watch-folder and hot-reload support for numbered sequences
- Read EXR metadata and expose layer/pass list for EXR sources
- Support EXR exposure and tonemap preview controls
- Draw current sequence or EXR frame to output canvas in passthrough mode

### Phase 5 - Render Loop and First 3 Algorithms

- `renderer.js` main loop with `requestAnimationFrame`
- Implement:
  - Threshold
  - Floyd-Steinberg
  - Bayer 4x4
- Wire luminance threshold, invert, scale, and source-adjust stack
- Add deterministic seed plumbing for random/noise-based algorithms and layers
- Implement base-source plus dither-overlay compositing with:
  - opacity
  - `Normal`
  - `Multiply`
  - `Overlay`
- Implement layer visibility so hidden layers are excluded from preview and export
- Implement layer duplication in the `Layers` tab
- Validate `30fps` on `1080p @ 50% scale`

### Phase 6 - Complete Algorithm Catalog

- Implement the remaining 24 algorithms
- Keep each in the appropriate `dither/*.js` module
- Test each against:
  - video
  - standard image sequences
  - EXR sequences where applicable
- Ensure `serpentine` and `errorStrength` work across the relevant algorithm family

### Phase 7 - Palettes

- Define all built-in palettes
- Generate palette LUTs
- Build palette dropdown and swatch display
- Implement custom palette editor
- Add palette extraction from current frame and trim-sampled ranges

### Phase 8 - Advanced Controls

- Highlights, compression, blur radius
- Error strength and serpentine
- Seed lock UI and randomize control
- Temporal anti-flicker controls and history management
- Add `Glow Layer` and `Noise Layer` creation flows plus per-layer parameter editing
- Add collapsible scopes:
  - histogram
  - waveform
  - vectorscope-lite
- Expand layer blend modes and polish right-panel UX

### Phase 9 - Presets and Project Files

- Ship built-in presets
- User save/load via Tauri store plugin or equivalent local persistence
- Preset includes:
  - algorithm
  - main settings
  - glow
  - palette
- Add favorites, hover audition, and preset preview grid driven by a current-frame snapshot
- Add `.ditherlab` project save/open
- Add dirty-state tracking
- Add manual relink flow
- Add autosave and crash recovery

### Phase 10 - WebGL Acceleration

- Port Bayer, Halftone, Threshold, and Pattern algorithms to fragment shaders
- Add shader cache
- Switch `type: 'gl'` algorithms to GPU path
- Benchmark before and after

### Phase 11 - Export

- Bundle FFmpeg binaries per platform in `src-tauri/binaries/`
- Tauri commands:
  - `start_export`
  - `write_frame`
  - `finalize_export`
  - `cancel_export`
- Frame-by-frame video seek or sequence iteration plus pipe to FFmpeg
- Export sheet with format, codec, bitrate, FPS, audio, and range controls
- Add image-sequence export:
  - PNG
  - JPEG
  - TIFF
- Add still-frame export modal for the current playhead frame
- Respect output target:
  - `Dither only`
  - `Composited stack`
- Add progress UI and cancel button
- Add audio pass-through or transcode options

### Phase 12 - Polish

- Drag-and-drop video, folders, or first frame of a sequence onto the window
- Optional imperfection FX only if performance budget remains healthy
- Keep optional pack limited to lightweight effects:
  - scanlines
  - RGB drift
  - jitter
  - grain
  - dropouts
- Do not block release on full VHS/VCR simulation
- Add `Reveal in Finder/Explorer` after export
- About dialog with version and license
- Icons:
  - 512
  - 256
  - 128
  - 64
  - 32
  - 16
- Dev shortcuts:
  - `Cmd/Ctrl+R` reset
  - `Cmd/Ctrl+E` export

### Phase 13 - Distribution

- Build for:
  - macOS universal
  - Windows x64
  - Linux x64
- Leave code-signing configuration as placeholder
- `npm run tauri build` should produce installers
- Write README install instructions

## Coding Conventions

- No frameworks; use vanilla JS with ES modules
- No JS build step unless genuinely needed
- CSS split by concern and imported from `main.css`
- camelCase for JS
- kebab-case for CSS classes and file names
- Comments only where intent is non-obvious
- Wrap every Tauri invoke in `try/catch` with user-facing failure handling
- No telemetry and no network calls

## What Not to Do

- Do not add webpack, Vite, or another build system unless genuinely required
- Do not use React, Vue, or Svelte
- Do not use canvas abstraction libraries like Fabric or Konva
- Do not lazy-load algorithm modules
- Do not implement audio waveform display
- Do not load a whole EXR sequence into RAM up front
- Do not promise deep EXR, Cryptomatte tooling, or full compositing-grade pass visualization in v1
- Do not block the core app on a full VHS/VCR analog-emulation stack
- Do not spend v1 time on:
  - batch export
  - keyframe automation
  - mask-based regional processing
  - custom algorithm authoring
  - difference view
  - preflight diagnostics
  - sequence-health dashboards
- Do not add cloud sync, accounts, or any backend

## References

- Dithering algorithms: https://en.wikipedia.org/wiki/Dither
- Bisqwit color quantization articles
- Riemersma dither: https://www.compuphase.com/riemer.htm
- Blue noise texture: https://momentsingraphics.de/BlueNoise.html
- Tauri sidecar docs: https://tauri.app/v1/guides/building/sidecar/
- FFmpeg image2pipe: https://ffmpeg.org/ffmpeg-formats.html#image2pipe
- Blender render passes: https://docs.blender.org/manual/en/latest/render/layers/passes.html
- Blender render layers node workflow:
  https://docs.blender.org/manual/en/latest/compositing/types/input/scene/render_layers.html
- OpenEXR technical introduction: https://openexr.com/en/latest/TechnicalIntroduction.html
- Rust `exr` crate docs: https://docs.rs/exr/latest/exr/image/
