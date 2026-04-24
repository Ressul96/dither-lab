# Product Spec

## Overview

Dither Lab is a local-first desktop video and image-sequence dithering tool built with Tauri.
Users load a video or numbered image sequence, preview the source in real time, apply one of
27+ dithering algorithms with adjustable parameters, compare processed vs original in multiple
modes, trim playback non-destructively, save the session as a project file, recover from
autosaves, and export either video, numbered image sequences, or the current frame.

Inspired by [ditheringstudio.com](https://ditheringstudio.com), but the product should feel
more like a compact desktop editor than a single-purpose filter panel.

Target platforms:
- macOS
- Windows
- Linux

Language rules:
- The app UI is English-only.
- Menu labels, dialogs, controls, status text, code comments, and commit messages stay in English.
- The end user may be Turkish, but the product language does not switch.

## Product Principles

- Local-first: no cloud sync, no accounts, no backend, no telemetry.
- Desktop-editor workflow: top menubar, inspector panels, central stage, persistent project state.
- Single source workflow: no separate video mode vs image mode in the UI.
- Preview and export parity: what the user sees must match what gets exported.
- Non-destructive editing: trim, compare, layers, and preset exploration should be reversible.
- Fast iteration: presets, A/B snapshots, hover audition, favorites, and right-click current-frame export.

## Core Feature Commitments

### Source and session workflow

- Open standard video files.
- Import numbered image sequences by folder or first frame.
- Support EXR sequences, including multilayer EXR metadata and pass selection.
- Save and reopen work as `.ditherlab` project files.
- Autosave recovery drafts without overwriting the last user-saved project file.
- Watch-folder hot reload for image and EXR sequences.

### Editing and inspection workflow

- 27 dithering algorithms across error diffusion, ordered, threshold/noise, and pattern families.
- Palette presets, custom palette editing, and palette extraction from source content.
- Source adjustments, layer compositing, optional glow/noise effect layers, and compare modes.
- Deterministic seed lock for random/noise-driven behavior.
- Optional temporal anti-flicker stabilization.
- Zoom, pan, and pixel inspection on the preview stage.
- A/B state snapshots for fast compare workflows.
- Collapsible scopes: histogram, waveform, and vectorscope-lite.
- Favorites, live preset audition, and a preset preview grid.

### Export workflow

- Export to video files through FFmpeg sidecar.
- Export to numbered image sequences: PNG, JPEG, TIFF.
- Export the current visible frame from the preview via context menu.
- Respect trim range, output target, selected EXR pass, seed lock, temporal behavior, and layer visibility.

## Project Files and Session Recovery

- Native project format: `.ditherlab`
- Serialization format: JSON-based, local-only

Project files store:
- Source references and sequence interpretation
- Current trim, FPS, compare mode, and viewport transform
- Selected EXR layer/pass and EXR preview settings
- Algorithm, palette, seed, temporal settings, layers, and effect parameters
- A/B snapshots and export defaults

Recovery rules:
- Autosave drafts live in the app data directory, not beside the source media.
- Autosave should be debounced.
- Autosave must never silently overwrite the last explicit `Save Project`.
- If a recovery draft exists on launch, the app offers:
  - `Recover`
  - `Discard`
  - `Open Saved Project`

Missing media rules:
- Missing or moved source files should trigger a basic manual relink flow.
- Automatic relink assistance across folders or filename guesses is deferred.

## Supported Inputs

### Video files

- Standard browser-previewable video sources drive the main transport workflow.
- Audio comes from the original file and can be copied or transcoded on export.

### Numbered image sequences

- Accept folder import or selecting the first file in a numbered range.
- Support at least: PNG, JPG/JPEG, WebP, TIFF, EXR.
- Detect patterns like `shot_0001.exr` through `shot_0120.exr`.
- Treat each frame as a frame source for preview, compare, trim, and export.
- Watch-folder mode should detect changed, added, or replaced frames and refresh the sequence safely.

### EXR sequences and Blender outputs

- Support single-layer EXR and multilayer EXR sequences exported from Blender.
- Read EXR layer/pass/channel metadata and expose selectable passes in the UI.
- Prioritize color-like passes first:
  - `Combined`
  - `Diffuse`
  - `Glossy`
  - `Emission`
  - color AOVs
  - alpha
- Non-display data passes such as `Z`, `Normal`, `Vector`, ID, or Cryptomatte are phase 2 unless
  trivial to preview.
- Deep EXR is out of scope for v1.

### Input behavior rules

- Video and image sequence sources must share the same compare, trim, and export UX.
- There is no separate `video mode` or `image mode` in the product UI.
- Importing a sequence must never silently reorder frames; show detected numbering explicitly.
- EXR values are linear/HDR and may exceed `0..1` or go negative, so exposure plus tonemap must
  happen before dithering preview.
- If watch-folder mode is enabled, incoming file changes should debounce and refresh only the
  affected frame window without forcing a full app reset.

## Deferred / Phase 2

- Batch export queue
- Animation and keyframe automation
- Region masks or selective per-area processing
- User-authored custom algorithm sandbox
- Advanced EXR color-management and display-transform controls for raw render look-development
- CLI or headless export unless a real pipeline workflow later demands it
- Frame markers
- Performance mode
- Recent-projects home screen
- Automatic relink assistant
- Render-cache visibility and controls
- Palette usage statistics
- Quick randomize controls
- Palette match inspector

