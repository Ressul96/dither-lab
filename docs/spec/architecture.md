# Architecture Spec

## Tech Stack

| Layer | Technology |
| --- | --- |
| Shell | Tauri 2.x (Rust) |
| Frontend | Vanilla HTML/CSS/JS |
| Rendering | Current: WebGL 2 + Canvas 2D in the frontend. Target for advanced nodes: native Rust render engine with wgpu |
| Source decoding | HTML5 `<video>` for video, JS sequence loader, Rust EXR decoder |
| Export | FFmpeg sidecar for video and sequence output |

Why hybrid rendering:
- Ordered algorithms such as Bayer and halftone map well to GPU shaders.
- Error-diffusion algorithms depend on previous pixels, so CPU is the correct default.

## Rendering Direction Update

The current app still renders preview work in the frontend. That remains acceptable for the
present stabilization and core-node phases.

However, any heavier cinematic node family should target a native render path in Rust:
- advanced flare, glare, bloom, and optical effects should not be authored as WebView-only logic
- GPU resources should stay resident on the Rust side where practical
- the frontend should remain responsible for graph editing, inspector UI, preset browsing, and asset management
- the Rust side should become the source of truth for advanced frame processors

This matters especially for a future `Lens Flare` or `Optical Flare` node. That node should be
implemented against a native Rust render engine and only surfaced through the existing node UI.

See also:
- `docs/spec/lens-flare-node.md`

## Target Project Structure

```text
dither-lab/
├── CLAUDE.md
├── README.md
├── docs/
│   └── spec/
│       ├── product.md
│       ├── ui-and-ux.md
│       ├── algorithms-and-color.md
│       ├── architecture.md
│       ├── export.md
│       ├── lens-flare-node.md
│       └── implementation-plan.md
├── package.json
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── binaries/
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── engine/
│       │   ├── mod.rs
│       │   ├── node.rs
│       │   ├── animation.rs
│       │   ├── tracker.rs
│       │   └── lens_flare.rs
│       ├── commands.rs
│       ├── exr.rs
│       └── ffmpeg.rs
└── src/
    ├── index.html
    ├── styles/
    │   ├── main.css
    │   ├── reset.css
    │   └── controls.css
    ├── js/
    │   ├── main.js
    │   ├── state.js
    │   ├── source.js
    │   ├── project.js
    │   ├── sequence.js
    │   ├── watcher.js
    │   ├── renderer.js
    │   ├── temporal.js
    │   ├── scopes.js
    │   ├── palettes.js
    │   ├── export.js
    │   ├── gl/
    │   ├── dither/
    │   └── ui/
    │       ├── controls.js
    │       ├── context-menu.js
    │       ├── preset-browser.js
    │       ├── stage.js
    │       ├── presets.js
    │       ├── snapshots.js
    │       └── palette-editor.js
    └── assets/
        └── blue-noise-512.png
```

For the future native flare pipeline, the asset side should eventually normalize around:

```text
assets/
└── lens-flares/
    ├── presets/
    ├── elements/
    └── glass/
```

The current user-provided texture source folder already follows that conceptual split:
- `Optical Flares Textures/Elements`
- `Optical Flares Textures/Glass`

## Core Rendering Pipeline

```text
Source frame provider
   ├─ hidden <video> element for video files
   └─ decoded bitmap / EXR frame for image sequences
   │
   ▼
Decode or fetch current source frame
   │
   ▼
If EXR: apply exposure + tonemap + alpha interpretation
   │
   ▼
Apply source adjustments: brightness -> contrast -> saturation -> gamma -> exposure
   │
   ▼
Create adjusted source base layer
   │
   ▼
Draw frame to working canvas at (source.width * scale) x (source.height * scale)
   │
   ▼
Apply dither prep adjustments: blur -> highlights -> compression
   │
   ▼
Branch on algorithm.type:
   ├─ 'gl'  -> upload ImageData to WebGL texture, run fragment shader
   └─ 'cpu' -> iterate pixels in JS, apply dither
   │
   ▼
Map to active palette
   │
   ▼
If invert: swap
   │
   ▼
If temporal anti-flicker enabled: stabilize against a short history buffer
   │
   ▼
If compositing enabled:
   1. Build visible layer stack bottom to top
   2. Skip hidden layers
   3. Render glow/noise/effect layers using each layer's own parameters
   4. Composite using blend mode and opacity
   5. Respect solo and visibility toggles
   │
   ▼
Scale up with image-rendering: pixelated to full-size output canvas
```

## Performance Targets

- 1080p video at scale `50%`: at least `30fps`
- 1080p at scale `25%`: `60fps`
- 4K at scale `25%`: at least `24fps`
- 1080p with glow enabled at scale `50%`: at least `24fps` by rendering glow in a half-resolution buffer

## Optimization Rules

- Reuse `ImageData` buffers; do not allocate per frame
- Precompute palette LUT (`16x16x16` RGB cube to nearest palette index)
- Load blue-noise texture once and tile it
- Precompute Bayer matrices as `Float32Array`
- Use `Int16Array` for error buffers where practical
- Skip rerender if nothing changed and playback is paused
- Reuse temporal history buffers and reset them only when required
- Run glow in a separate low-resolution framebuffer, then upscale and composite
- Use separable blur passes for glow
- Noise layer must stay deterministic enough for preview/export parity
- Scopes should analyze a representative downsampled buffer if performance requires it
- Zoom/pan/pixel inspector interactions must not trigger source re-decode unless the frame changed
- Watch-folder refreshes should debounce filesystem bursts and only invalidate affected cached frames
- Autosave should be debounced so slider drags do not spam disk writes
- Preset preview grid should render from a cached single-frame snapshot instead of recomputing every card during playback
- Hover-auditioned presets must not dirty the project until explicitly applied
- Never decode an entire EXR sequence into memory up front
- Parse EXR metadata once per sequence and lazily decode only the selected layer/pass
- Missing or corrupt frames must surface a visible warning instead of failing silently

## State Management

Single global store, Proxy-wrapped or equivalent lightweight reactive pattern:

```js
const state = createStore({
  project: {
    path: null,
    dirty: false,
    autosaveEnabled: true,
    lastSavedAt: null,
    recoveryDraftAvailable: false
  },
  source: {
    kind: 'video', // 'video' | 'image-sequence' | 'exr-sequence'
    file: null,
    directory: null,
    duration: 0,
    currentTime: 0,
    playing: false,
    fps: 30,
    sourceFps: 30,
    frameCount: 0,
    trimStart: 0,
    trimEnd: 0,
    sequencePattern: null,
    missingFrames: [],
    watchFolder: false,
    watchStatus: 'idle', // 'idle' | 'watching' | 'refreshing' | 'error'
    sourceChangedOnDisk: false
  },
  exr: {
    availableLayers: [],
    selectedLayer: null,
    exposure: 0,
    tonemap: 'aces',
    alphaMode: 'premultiplied'
  },
  adjust: {
    brightness: 0,
    contrast: 1,
    saturation: 1,
    gamma: 1,
    exposure: 0
  },
  composite: {
    enabled: true,
    rightPanelTab: 'layers', // 'layers' | 'exr' | 'adjust'
    layers: [
      {
        id: 'original-layer',
        kind: 'source',
        name: 'Original Layer',
        visible: true,
        blendMode: 'normal',
        opacity: 1,
        params: {}
      },
      {
        id: 'dither-layer',
        kind: 'dither',
        name: 'Dither Layer',
        visible: true,
        blendMode: 'normal',
        opacity: 1,
        params: {}
      }
    ],
    soloMode: 'none',
    exportTarget: 'composited', // 'dither-only' | 'composited'
    duplicateBehavior: 'snapshot-current-settings'
  },
  layerTemplates: {
    glow: {
      kind: 'effect-glow',
      name: 'Glow Layer',
      visible: true,
      blendMode: 'screen',
      opacity: 1,
      params: {
        intensity: 0.6,
        radius: 12,
        threshold: 180,
        softness: 0.35,
        saturation: 1,
        tint: '#ffffff',
        brightOnly: true
      }
    },
    noise: {
      kind: 'effect-noise',
      name: 'Noise Layer',
      visible: true,
      blendMode: 'overlay',
      opacity: 0.35,
      params: {
        amount: 0.15,
        scale: 1,
        monochrome: true,
        animated: true,
        luminanceResponse: 0.5
      }
    }
  },
  algorithm: {
    id: 'floyd-steinberg',
    luminanceThreshold: 128,
    invert: false,
    seedLocked: true,
    seed: 1337
  },
  compare: {
    mode: 'processed', // 'processed' | 'dither-only' | 'original' | 'split' | 'side-by-side'
    splitPosition: 0.5,
    holdToPreviewOriginal: false
  },
  viewport: {
    zoom: 1,
    panX: 0,
    panY: 0,
    fitMode: 'contain', // 'contain' | 'custom'
    pixelInspectorVisible: false,
    hoveredPixel: null
  },
  scopes: {
    visible: false,
    target: 'processed', // 'processed' | 'original' | 'dither-only'
    histogram: true,
    waveform: true,
    vectorscopeLite: true
  },
  snapshots: {
    a: null,
    b: null,
    active: 'a' // 'a' | 'b'
  },
  temporal: {
    antiFlickerEnabled: false,
    strength: 0.35
  },
  main: {
    scale: 1.0,
    highlights: 0,
    compression: 0,
    blurRadius: 0,
    glowIntensity: 0,
    glowRadius: 12,
    glowThreshold: 180,
    glowSoftness: 0.35,
    glowSaturation: 1.0,
    glowBlend: 0.5,
    glowTint: '#ffffff',
    glowBrightOnly: true,
    errorStrength: 1.0,
    serpentine: true
  },
  palette: {
    id: 'monochrome',
    custom: [],
    extractionMode: 'current-frame', // 'current-frame' | 'trim-sample'
    extractionColorCount: 4,
    lockedColors: []
  },
  preset: {
    current: null,
    saved: [],
    favorites: [],
    auditioning: null,
    previewGridVisible: false
  },
  export: {
    inProgress: false,
    progress: 0,
    mode: 'video', // 'video' | 'image-sequence' | 'still-frame'
    format: 'mp4',
    imageSequenceFormat: 'png', // 'png' | 'jpeg' | 'tiff'
    stillFrameFormat: 'png', // 'png' | 'jpeg' | 'tiff'
    videoCodec: 'libx264',
    audioCodec: 'aac',
    qualityMode: 'crf',
    crf: 18,
    bitrateMbps: 8,
    preset: 'medium',
    useSourceFps: true,
    customFps: 30,
    rangeMode: 'trimmed' // 'full' | 'trimmed'
  }
});
```

Subscribers rerender on state changes. Debounce slider updates to roughly one frame (`16ms`).
