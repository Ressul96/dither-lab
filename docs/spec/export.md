# Export Spec

## Export Modes

The product supports three export targets:

1. Video file export
2. Numbered image-sequence export
3. Current-frame still export

All exports must respect:
- the current source interpretation
- selected EXR layer/pass
- layer visibility and solo state
- output target (`Dither only` vs `Composited stack`)
- trim range when applicable
- seed lock
- temporal anti-flicker behavior

## Export UI Contract

### Main export sheet

Triggered by the `Export` button in the left inspector or equivalent menu command.

Output target:
- `Dither only`
- `Composited stack`

Output mode:
- `Video File`
- `Image Sequence`

Resolution mode:
- `Source`
- `Half`
- `Custom`

FPS:
- `Source`
- custom numeric value

Range:
- `Full video`
- `Trimmed range`

Switching back to full range must be one click.

### Video export formats

- `MP4 (H.264)`
- `MOV (ProRes or H.264)`
- `WebM (VP9)` if supported by the bundled FFmpeg build

Video quality controls:
- `Bitrate`
- `CRF / Quality`
- `Preset` (`ultrafast` through `veryslow`)

Audio controls:
- `Copy original` where compatible
- `AAC`
- `Opus`
- `Mute`

### Image-sequence export formats

- `PNG sequence`
- `JPEG sequence`
- `TIFF sequence`

Sequence export rules:
- Output files are numbered in order
- Respect current trim if `Trimmed range` is selected
- Respect chosen FPS for timing-derived frame count when exporting from video
- Respect sequence frame boundaries when exporting from existing image sequences

### Current-frame export

Triggered by right-clicking the preview stage and choosing `Export Current Frame...`

Current-frame export opens a modal with:
- format:
  - `PNG`
  - `JPEG`
  - `TIFF`
- output target:
  - `Dither only`
  - `Composited stack`
- resolution:
  - `Source`
  - `Custom`
- filename preview based on source name plus frame/time

Current-frame export rules:
- Uses the exact frame visible at the current playhead position
- Excludes UI overlays such as inspector chrome, guides, hover chrome, and trim handles
- Should be fast enough to feel like a natural inspection tool, not a heavyweight render pipeline

## Export Pipeline

### Video and image-sequence pipeline

1. User opens export sheet.
2. User chooses output path, mode, format, quality, range, and output target.
3. Frontend pauses playback and seeks to export start:
   - `0` for full export
   - `trim.start` for trimmed export
4. Tauri spawns FFmpeg sidecar or equivalent writer pipeline.
5. Frontend steps through frames until export end:
   - For video:
     - `video.currentTime = exportStart + (n / fps)`
   - For sequences:
     - resolve `frameIndex = exportStartFrame + n`
   - Wait for `seeked`, `requestVideoFrameCallback`, or sequence decode completion
   - Render selected output stack to canvas
   - Send frame bytes to Rust/FFmpeg pipeline
6. Progress updates per frame and per time range.
7. On completion, show `Reveal in Finder/Explorer`.

### Still-frame pipeline

1. User right-clicks the stage.
2. User chooses `Export Current Frame...`
3. Modal collects format, target, output size, and destination
4. App renders the currently visible frame using the same preview/export pipeline rules
5. App writes the still image to disk

Still export may use browser/native encoding directly instead of FFmpeg if that keeps the
implementation simpler and consistent.

## Export Edge Cases

- Video without audio: drop optional audio mapping
- Image sequences and EXR sequences usually have no audio: default to mute
- User cancel: kill FFmpeg process and delete partial output
- Invalid codec/container combinations should be disabled in the UI rather than failing late
- Trim is non-destructive and never overwrites source duration metadata
- EXR layer selection must affect both preview and export; export cannot silently fall back to a different pass
- Seed lock and temporal anti-flicker must match preview behavior during export

## Preview and Export Parity

- Preview and export must share the same layer stack rules.
- Hidden layers must be excluded from both preview and export.
- Noise and seed-driven behavior must stay deterministic when seed lock is enabled.
- If a feature cannot match preview in export, it should not ship as finished.

