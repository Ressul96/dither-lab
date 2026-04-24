# UI and UX Spec

## Layout

The app should not feel locked to the reference layout. Keep the overall dark modern aesthetic,
but use a more editor-like composition:

- Top application menubar like a desktop creative tool
- Left inspector for algorithm, palette, dither controls, post FX, preset tools, and export settings
- Large center stage for source preview
- Right-side tabbed utility panel for layers/compositing, EXR passes, and source adjustments
- A collapsible scopes drawer or panel for histogram, waveform, and vectorscope-lite
- A small floating history card for quick `Undo` and `Redo`
- A floating or bottom-docked player card centered under the preview for transport, FPS,
  compare controls, and trim handles

The player card is the interaction hub. The user should be able to stay near the image while
scrubbing, comparing, changing FPS, and trimming, while the right panel handles deeper compositing
and source-level controls.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ File  Edit  View  Window  About                                           │
├──────────────────────┬──────────────────────────────────┬─────────────────┤
│ ─ INSPECTOR ──────── │ [Undo][Redo]  [ SOURCE STAGE ]  │ [Tabs]          │
│ Algorithm            │    processed / compare / trim   │ Layers          │
│ Dither Settings      │                                  │ EXR             │
│ Palette              │                                  │ Adjust          │
│ Post FX              │                                  │                 │
│ Presets              │                                  │ active tab      │
│ Export Settings      │                                  │ content lives   │
│                      │  ┌────────────────────────────┐  │ here            │
│                      │  │ timeline / transport / fps │  │                 │
│                      │  │ compare modes / trim       │  │                 │
│                      │  └────────────────────────────┘  │                 │
└──────────────────────┴──────────────────────────────────┴─────────────────┘
```

## Control Inventory

### Application menu

- The app should expose a desktop-style top menubar rather than large in-canvas source buttons.
- Primary structure:
  - `File`
  - `Edit`
  - `View`
  - `Window`
  - `About`
- Suggested menu contents:
  - `File`
    - `New Project`
    - `Open Project...`
    - `Save Project`
    - `Save Project As...`
    - `Open Source...`
    - `Open Recent`
    - `Import Sequence...`
    - `Export...`
    - `Close Source`
  - `Edit`
    - `Undo`
    - `Redo`
    - `Duplicate Layer`
    - `Reset Selected Controls`
    - `Reset Project`
  - `View`
    - `Show Left Inspector`
    - `Show Right Panel`
    - `Toggle Scopes`
    - `Reset Zoom`
    - `Toggle Fullscreen`
    - compare view entries
  - `Window`
    - standard desktop window actions
  - `About`
    - app info
    - shortcuts
    - version

### History card

- Small floating card near the top of the stage
- Mirrors the `Edit` menu actions rather than inventing a separate history system
- Compact, reachable, and visually secondary to the canvas
- Disabled states must be obvious when nothing can be undone or redone

### Player card

- Timeline scrubber with current and total time
- Transport:
  - restart
  - previous frame
  - play/pause
  - next frame
- FPS slider:
  - `1` to `60`
  - rightmost position = `Source`
- Compare mode segmented control:
  - `Processed`
  - `Dither Only`
  - `Original`
  - `Split Slider`
  - `Side by Side`
- Compare slider handle for wipe comparison
- Side-by-side layout toggle with synced zoom and pan
- Quick A/B button to temporarily show original while pressed
- `Capture A`
- `Capture B`
- `Swap A/B`
- Trim bar with draggable `In` and `Out` handles
- `Set In`
- `Set Out`
- `Reset Trim`
- `Snap Playhead to Handle`

Trim must stay non-destructive and visually obvious. Resetting to full duration must be one action.

### Stage interaction

- Single-button mouse drag pans the stage when zoomed in
- Trackpad pinch or two-finger zoom gestures control preview zoom
- `Reset Zoom` returns the stage to fit-to-view in one action
- Pixel inspector can be toggled on and shows:
  - image coordinates
  - source color
  - processed color
- Right-click on the preview opens a stage context menu with `Export Current Frame...`
- Side-by-side and split compare modes should keep viewport transforms aligned so comparisons stay meaningful

### Source section

- Source type readout:
  - `Video`
  - `Image Sequence`
  - `EXR Sequence`
- Sequence summary:
  - detected frame range
  - missing frames
  - image resolution
- Sequence FPS field for still-image sequences with no embedded timing
- `Interpret as sequence` when the user selects the first file in a numbered set
- Missing-frame policy:
  - `Hold Previous`
  - `Skip`
  - `Stop with warning`
- `Watch folder` toggle for image and EXR sequences
- Hot reload should show a small, non-blocking status when source frames changed on disk

## Right Utility Tabs

### Layers tab

- Every newly loaded source auto-creates at least two visible layers:
  - `Original Layer`
  - `Dither Layer`
- `Original Layer` starts at the bottom of the stack
- `Dither Layer` starts above it and is the live processed result
- Users can add effect or adjustment-style layers:
  - `Glow Layer`
  - `Noise Layer`
- Users can duplicate layers when they want alternate blend or opacity setups
- Duplicating a layer copies its current settings as a new independent layer
- Layer visibility is authoritative:
  - hidden layer does not appear in preview
  - hidden layer does not participate in export
- If every layer is hidden, preview should show an empty-state warning and export should be disabled
- Blend mode options for dither, glow, noise, or duplicated overlay layers:
  - `Normal`
  - `Multiply`
  - `Screen`
  - `Overlay`
  - `Soft Light`
  - `Add`
- Overlay opacity slider per layer
- Visibility toggle per layer
- Selected layer shows its own editable parameters in the right panel
- Suggested quick actions:
  - `Duplicate Layer`
  - `Add Glow Layer`
  - `Add Noise Layer`
  - `Solo Dither`
  - `Solo Source`
- Output toggle:
  - `Export dither only`
  - `Export composited stack`

Glow layer parameters:
- `Intensity`
- `Radius`
- `Threshold`
- `Softness`
- `Saturation`
- `Tint`
- `Bright Colors Only`

Noise layer parameters:
- `Amount`
- `Scale`
- `Monochrome` or `Color`
- `Animated` or `Static`
- `Response to luminance`

### EXR tab

- Layer or pass dropdown populated from EXR metadata
- Default to `Combined` or beauty-style output when available
- Show channel group info for Blender-style passes and AOVs
- Exposure control for HDR EXR input before dithering
- Tonemap control:
  - `Linear`
  - `Reinhard`
  - `ACES-like`
- Alpha handling toggle:
  - `Premultiplied`
  - `Straight`
- v1 scope: regular flat EXR and multilayer EXR
- Phase 2: broader EXR color-management and display-transform controls for raw render look-development

### Adjust tab

Basic source-edit controls before dithering:
- `Brightness`
- `Contrast`
- `Saturation`
- `Gamma`
- `Exposure`

Optional extras if cheap:
- `Hue`
- `Temperature`
- `Tint`

## Left Inspector Sections

### Algorithm section

- Dropdown with 27 algorithms grouped by family
- `Luminance Threshold` (`0..255`, default `128`)
- `Invert`

### Dither settings section

- `Scale` (`10%..100%`, default `100%`)
- `Highlights` (`-1..+1`, default `0`)
- `Compression` (`0..1`, default `0`)
- `Blur Radius` (`0..20 px`, default `0`)
- `Error Strength` (`0..1`, default `1`)
- `Serpentine` (default on)
- `Seed Lock`
- Seed value input
- Randomize seed button

When seed lock is enabled, preview and export must match exactly.

### Temporal section

- `Temporal Anti-Flicker`
- Strength slider

Temporal anti-flicker:
- is optional
- defaults off
- must behave identically in preview and export
- resets temporal history when:
  - the playhead jumps
  - trim bounds change
  - the source changes
  - the algorithm family changes

### Imperfection FX section

Nice-to-have only, not core v1. All effects default off.

Candidate controls:
- `Scanlines`
- `RGB Offset / Chroma Drift`
- `Gate Weave / Jitter`
- `Noise / Grain`
- `Dropout / Dust`
- `Interlace Softness`
- `Horizontal Smear`

If performance or implementation complexity is not acceptable, skip this section in v1.

### Palette section

- Dropdown with presets plus `Custom`
- Visual swatches of the active palette
- Custom palette editor:
  - add color
  - remove color
  - hex input

### Palette extraction

- Extract palette from:
  - `Current Frame`
  - a sampled range inside the current trim
- User chooses target palette size before extraction
- Extracted result lands in the custom palette editor for cleanup
- Locked swatches remain preserved when re-extracting into the same custom palette

### Presets section

- Save current settings as a named preset
- Load preset from list
- Built-in presets:
  - Gameboy
  - Newspaper
  - 80s Terminal
  - CGA Mode 4
  - C64
  - NES
  - Mac Plus
- Presets can be starred as favorites
- Hovering a preset temporarily auditions it on the main preview without committing it
- Clicking a preset applies it and creates a normal undoable state change
- `Preset Preview Grid` shows multiple preset thumbnails rendered from the current paused frame
  or a snapshot of the current playhead frame
- The grid should prefer favorites and relevant presets first instead of dumping the full library
- Hover audition must revert cleanly when the pointer leaves
- Hover audition must not spam undo history

### Scopes

- Collapsible scopes drawer or panel that can be shown and hidden without leaving the main stage
- Include:
  - `Histogram`
  - `Waveform`
  - `Vectorscope-lite`
- Scope target can switch between:
  - `Processed`
  - `Original`
  - `Dither Only`
- Scope rendering may use a downsampled analysis buffer for performance, but it must stay representative

### Export section

The left inspector includes export controls, but the detailed export contract lives in
[export.md](./export.md).

At the UI level:
- `Export` opens an export sheet or modal, not an immediate file write
- The export UI must clearly separate:
  - `Video File`
  - `Image Sequence`
- Still-frame export is separate and is triggered from the preview context menu via
  `Export Current Frame...`

## Aesthetic Direction

Clean, dark, modern. Think Arc browser settings panel plus Linear.

Do not make it:
- brutalist
- terminal-retro
- generic template UI

### Design tokens

```css
:root {
  --bg-canvas: #0b0b0d;
  --bg-surface: #141418;
  --bg-elevated: #1c1c22;
  --bg-input: #0f0f12;

  --border-subtle: #24242b;
  --border-strong: #2f2f38;

  --text-primary: #f0f0f2;
  --text-secondary: #9a9aa3;
  --text-muted: #5a5a63;

  --accent: #4a9eff;
  --accent-hover: #6ab0ff;
  --accent-dim: #2a5a99;

  --success: #4ade80;
  --warn: #fbbf24;
  --error: #f87171;
}
```

### Typography

- UI font: Inter variable, weights `400`, `500`, `600`
- Numeric labels use tabular figures
- Font sizing:
  - base `13px`
  - labels `11px`
  - section headers `10px` with letter spacing

### Component rules

- Sliders: thin track (`3px`), circular thumb (`12px`), accent color
- Section headers: uppercase, muted, small, thin underline rule
- Dropdowns: custom styled, chevron icon, no browser default
- Buttons: `1px` border, `6px` radius, `36px` height for primary, `28px` for compact
- Hover: subtle background lift
- Active: accent border

### Layout sizing

- Left inspector: `320..360px`, internally scrollable
- Stage: fills remaining space, centers canvas, subtle radial background
- Right utility panel: `280..340px`
- History card: small floating elevated surface near upper stage area
- Player card: anchored center-bottom, slightly floating, elevated
- Compare modes must feel native to the player card
- Trim handles must be easy to drag and easy to reset
- Canvas wrapper: `1px` subtle border with faint accent glow on focus

