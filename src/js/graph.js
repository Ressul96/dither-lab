import { getState, dispatch, pushHistory } from "./state.js";
import { normalizeHex, rgbToHex } from "./color.js";

const NODE_SPACING_X = 252;
const NODE_BASE_X = 88;
const NODE_BASE_Y = 84;
const NODE_WIDTH = 220;
const NODE_INSERT_GAP_X = Math.round(NODE_WIDTH * 0.2);

export const ROOT_PARENT_ID = "root";

const NODE_LAYER_DEFAULTS = Object.freeze({
  opacity: 100,
  hue: 0,
  saturation: 100,
});

const NODE_LAYER_BOUNDS = Object.freeze({
  opacity: { min: 0, max: 100 },
  hue: { min: -180, max: 180 },
  saturation: { min: 0, max: 200 },
});

const NODE_DEFINITIONS = Object.freeze({
  source: {
    label: "Video Source",
    family: "Input",
    description: "Resolves the current frame from the active source provider and applies source-level corrections.",
    inputs: [],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      brightness: 0,
      contrast: 100,
      saturation: 100,
      gamma: 100,
      exposure: 0,
      hue: 0,
      hsvSaturation: 100,
      value: 100,
      bwMode: "off",
      invert: "off",
      invertChannels: "rgb",
    },
  },
  "mesh-gradient": {
    label: "Mesh Gradient",
    family: "Input",
    description: "Animated multi-color radial mesh. Each stop is a soft spot at (x, y) with its own radius and color.",
    inputs: [],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      stops: [
        { x: 0.22, y: 0.28, radius: 0.65, color: "#ff0055" },
        { x: 0.78, y: 0.28, radius: 0.65, color: "#00ff99" },
        { x: 0.22, y: 0.72, radius: 0.65, color: "#0055ff" },
        { x: 0.78, y: 0.72, radius: 0.65, color: "#ffcc00" },
      ],
      complexity: 50,
      warp: 35,
      speed: 25,
      zoom: 100,
      width: 1920,
      height: 1080,
    },
  },
  gradient: {
    label: "Gradient",
    family: "Input",
    description: "Procedural linear, radial, or conic gradient source with an editable color ramp.",
    inputs: [],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      mode: "linear",
      stops: [
        { pos: 0, color: "#101827" },
        { pos: 0.52, color: "#4a9eff" },
        { pos: 1, color: "#fff0a8" },
      ],
      angle: 0,
      centerX: 50,
      centerY: 50,
      radius: 75,
      repeat: 1,
      shift: 0,
      width: 1920,
      height: 1080,
    },
  },
  noise: {
    label: "Noise",
    family: "Input",
    description: "Procedural noise source — perlin, simplex, or value, with octave FBM for clouds / turbulence. Seed and animation speed make it usable as a deterministic input or a time-varying base.",
    inputs: [],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      mode: "perlin",
      scale: 4,
      octaves: 4,
      persistence: 50,
      seed: 0,
      animSpeed: 0,
      width: 1920,
      height: 1080,
    },
  },
  adjust: {
    label: "Adjust",
    family: "Color",
    description: "Applies source-level corrections before downstream processing nodes.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      brightness: 0,
      contrast: 100,
      saturation: 100,
      gamma: 100,
      exposure: 0,
    },
  },
  posterize: {
    label: "Posterize",
    family: "Color",
    description: "Quantizes each channel into N discrete levels for hard tonal banding. Optional per-channel step counts, sRGB-aware quantization, and a luma-only mode that preserves chroma direction.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      steps: 8,
      stepsG: 0, // 0 sentinel = link to steps; old saves with only `steps` keep their look
      stepsB: 0,
      gamma: "linear",
      lumaMode: "rgb",
      opacity: 100,
    },
  },
  invert: {
    label: "Invert",
    family: "Color",
    description: "Inverts the selected channels (RGB by default).",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { channels: "rgb" },
  },
  "rgb-to-bw": {
    label: "RGB to BW",
    family: "Color",
    description: "Collapses the image to luminance — useful before 1-bit dither.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { mode: "bt709" },
  },
  "tone-map": {
    label: "Tone Map",
    family: "Color",
    description: "Compresses bright highlights via Reinhard so dither has headroom.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { intensity: 100, whitepoint: 100 },
  },
  levels: {
    label: "Levels",
    family: "Color",
    description: "Remaps input black/white points, gamma, and output range — the technical sibling of Adjust. RGB or luma-only mode; CPU reference path with GPU coming later.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      // Identity: all four endpoints span the full 0-255 byte range and
      // gamma is 1.00, so a fresh node passes the source through untouched.
      inputBlack: 0,
      inputWhite: 255,
      gamma: 100,
      outputBlack: 0,
      outputWhite: 255,
      mode: "rgb", // "rgb" | "luma"
      opacity: 100,
    },
  },
  duotone: {
    label: "Duotone",
    family: "Color",
    description: "Maps image luminance to a two-color gradient between a shadow and a highlight color. Per-channel gamma biases the luma calculation so reds, greens or blues can dominate the mapping.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      // Defaults are an ACTIVE duotone (warm poster look) — unlike Levels,
      // a duotone with neutral params would just collapse to luma. Users
      // bypass via opacity=0 or the node's bypass toggle.
      shadowColor: "#101010",
      highlightColor: "#f4b642",
      redGamma: 100,
      greenGamma: 100,
      blueGamma: 100,
      opacity: 100,
    },
  },
  "gradient-map": {
    label: "Gradient Map",
    family: "Color",
    description: "Maps image luminance to a custom gradient. Repeat and shift can turn the ramp into contour bands or animated color flows.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      stops: [
        { pos: 0, color: "#111111" },
        { pos: 1, color: "#ffffff" },
      ],
      shift: 0,
      repeat: 1,
      mode: "luma",
      opacity: 100,
    },
  },
  hsv: {
    label: "HSV",
    family: "Color",
    description: "Shifts hue, saturation, and value before downstream processing.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { hue: 0, saturation: 100, value: 100 },
  },
  "rgb-curves": {
    label: "RGB Curves",
    family: "Color",
    description: "Remaps master and RGB channels with editable tone curves.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      activeChannel: "master",
      applyMode: "normal",
      masterLow: 0,
      masterMid: 128,
      masterHigh: 255,
      redLow: 0,
      redMid: 128,
      redHigh: 255,
      greenLow: 0,
      greenMid: 128,
      greenHigh: 255,
      blueLow: 0,
      blueMid: 128,
      blueHigh: 255,
      points_master: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    },
  },
  "scene-grade": {
    label: "Scene Grade",
    family: "Color",
    description: "Final scene-wide grade for master/RGB curves, clamp gamma, and an optional color-map LUT.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      activeChannel: "master",
      clampMin: 0,
      clampMax: 100,
      clampGamma: 100,
      colorMapEnabled: false,
      colorMapStops: [
        { pos: 0, color: "#111111" },
        { pos: 1, color: "#ffffff" },
      ],
      points_master: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    },
  },
  pixelate: {
    label: "Pixelate",
    family: "Process",
    description: "Collapses NxN blocks into single colors for chunky low-res looks. Optional non-square aspect (sizeY), circle pixels, edge softness, and a cosmetic cell-edge grid.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      size: 8,
      sizeY: 0, // 0 sentinel = link to size; old saves with only `size` keep their square cells
      shape: "square",
      smoothing: 0,
      // Cosmetic cell-edge darkening (square cells only). Default 0 so old
      // projects look identical. Real LCD/LED panel simulation belongs in
      // led-screen — see pixelation_entegrasyon.md §2.
      gridOpacity: 0,
      opacity: 100,
    },
  },
  scale: {
    label: "Scale",
    family: "Process",
    description: "Resizes the image. Pair with Pixelate for retro upscaled pixel art.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { x: 100, y: 100, filter: "linear" },
  },
  transform: {
    label: "Transform",
    family: "Process",
    description: "Transforms source content in one place: crop, translate, rotate, scale, and flip inside the original frame.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      translateX: 0,
      translateY: 0,
      rotation: 0,
      x: 100,
      y: 100,
      horizontal: false,
      vertical: false,
      cropMode: "mask",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      filter: "linear",
    },
  },
  crop: {
    label: "Crop",
    family: "Process",
    description: "Masks or fits a cropped source rectangle inside the original frame.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { left: 0, right: 0, top: 0, bottom: 0, mode: "mask" },
  },
  flip: {
    label: "Flip",
    family: "Process",
    description: "Flips the image horizontally, vertically, or both.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { horizontal: true, vertical: false },
  },
  dither: {
    label: "Dither",
    family: "Process",
    description: "Converts the incoming image into a dithered monochrome result.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      algorithm: "floyd-steinberg",
      palette: "monochrome",
      threshold: 128,
      invert: false,
      scale: 100,
      blurRadius: 0,
      errorStrength: 100,
      serpentine: true,
    },
  },
  "pattern-dither": {
    label: "Pattern Dither",
    family: "Process",
    description: "GPU-only ordered/noise dither with color-depth quantization. Bayer 2/4/8, blue noise, white noise, optional sRGB-aware quantization. Sibling to the CPU Dither node — palette-less, video-fast.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      opacity: 100,
      saturation: 100,
      pattern: "bayer-4x4",
      scale: 1,
      strength: 100,
      depth: 4,
      gamma: "srgb",
    },
  },
  threshold: {
    label: "Threshold",
    family: "Mask",
    description: "Binary mask from a per-pixel channel comparison. Channel selectable (luma / R / G / B / max), optional soft knee, BW or source-mask output.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      opacity: 100,
      threshold: 50,
      softness: 0,
      channel: "luma",
      invert: "off",
      mode: "bw",
    },
  },
  "mask-combine": {
    label: "Mask Combine",
    family: "Mask",
    description: "Combines two masks via boolean ops (intersect, union, difference, subtract). Reads luma per pixel, supports per-input invert.",
    inputs: [
      { name: "mask_a", label: "Mask A", type: "image" },
      { name: "mask_b", label: "Mask B", type: "image" },
    ],
    outputs: [{ name: "image", label: "Mask", type: "image" }],
    defaultParams: {
      operation: "intersect",
      invertA: "off",
      invertB: "off",
      opacity: 100,
    },
  },
  "mask-apply": {
    label: "Mask Apply",
    family: "Mask",
    description: "Gates the input image by a mask channel. Source picks which mask channel reads (luma / alpha / R / G / B); mode chooses between continuous multiply and hard stencil cutoff.",
    inputs: [
      { name: "image", label: "Image", type: "image" },
      { name: "mask", label: "Mask", type: "image" },
    ],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      source: "luma",
      mode: "multiply",
      invert: "off",
      feather: 0,
      opacity: 100,
    },
  },
  blur: {
    label: "Blur",
    family: "Process",
    description: "Softens the image with a Gaussian-style blur.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { radius: 4 },
  },
  glare: {
    label: "Bloom / Glare",
    family: "Effect",
    description: "Soft glow on bright pixels — GPU bloom, GPU star glow, anamorphic streaks, fog glow, or legacy CPU bloom. Replaces the standalone Bloom node.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      type: "bloom-gpu",
      threshold: 180,
      mix: 100,
      saturation: 100,
      blend: "screen",
      tintAmount: 0,
      tintHue: 30,
      size: 16,
      quality: 1,
      streaks: 4,
      angle: 45,
      iterations: 5,
      fade: 85,
      length: 64,
      falloff: 80,
      alternate: 100,
      colorize: 0,
      knee: 20, // GPU glare soft luminance threshold knee
    },
  },
  analog: {
    label: "Analog",
    family: "Effect",
    description: "Combined VHS and CRT surface with tape noise, scanlines, tube curvature, phosphor glow, and screen mask controls.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      mode: "vhs",
      opacity: 100,
      brightness: 110,
      saturation: 110,
      chroma: 6,
      bleed: 50,
      noise: 35,
      scanlines: 60,
      tracking: 35,
      wave: 4,
      curvature: 25,
      mask: "aperture",
      maskStrength: 35,
      glow: 25,
      vignette: 40,
      rolling: 0,
      // Tape realism (md §4 P2). Identity defaults: tapeResolution 100 = no
      // resolution loss; the rest are 0 = effect off.
      tapeResolution: 100,
      jitter: 0,
      flicker: 0,
      dropouts: 0,
      crease: 0,
    },
  },
  "led-screen": {
    label: "LED Screen",
    family: "Effect",
    description: "Simulates physical LED/LCD subpixels with panel gaps and diode glow.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      cellSize: 6,
      gap: 18,
      subpixelMode: "rgb",
      shape: "round",
      softness: 35,
      glow: 18,
      brightness: 110,
      opacity: 100,
    },
  },
  modulation: {
    label: "Modulation",
    family: "Effect",
    description: "Draws phase-modulated line signals from image luminance or RGB channels.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      frequency: 80,
      sensitivity: 35,
      thickness: 18,
      angle: 0,
      channelMode: "rgb",
      sourceMix: 0,
      invert: "off",
      opacity: 100,
    },
  },
  "pixel-sorting": {
    label: "Pixel Sorting",
    family: "Effect",
    description: "Creates threshold-based glitch-sort streaks along an axis. P1 is a fast single-pass approximation, not true segment sorting.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      mode: "glitch",
      threshold: 50,
      softness: 10,
      angle: 0,
      length: 24,
      iterations: 8,
      channel: "luma",
      direction: "bright",
      opacity: 100,
    },
  },
  "depth-of-field": {
    label: "Depth of Field",
    family: "Effect",
    description: "Blurs areas outside an elliptical focus region with optional debug mask and bokeh shaping.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      centerX: 50,
      centerY: 50,
      radius: 35,
      falloff: 25,
      aspect: 100,
      rotation: 0,
      invert: "off",
      blur: 16,
      samples: 32,
      bokehShape: "round",
      blades: 6,
      anamorphic: 100,
      debug: "off",
      opacity: 100,
    },
  },
  "lens-distort": {
    label: "Lens Distortion",
    family: "Effect",
    description: "Radial barrel/pincushion or horizontal chromatic split, with off-axis center, fit, and vignette.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      type: "radial",
      distortion: 0,
      dispersion: 0,
      centerX: 50,
      centerY: 50,
      vignette: 0,
      fit: false,
    },
  },
  "chromatic-aberration": {
    label: "Chromatic Aberration",
    family: "Effect",
    description: "Splits red and blue samples in a directional or radial offset for RGB fringe effects.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      strength: 4,
      angle: 0,
      mode: "directional",
      centerX: 50,
      centerY: 50,
    },
  },
  vhs: {
    label: "VHS",
    family: "Effect",
    description: "Magnetic-tape look: chroma bleed, RGB shift, scrolling tracking bands, noise, scanlines, vignette. Animation driven by playhead time.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      opacity: 100,
      chroma: 6,
      bleed: 50,
      noise: 35,
      scanlines: 60,
      tracking: 35,
      wave: 4,
      vignette: 40,
      saturation: 110,
      // Tape realism (md §4 P2) — same identity defaults as analog.
      tapeResolution: 100,
      jitter: 0,
      flicker: 0,
      dropouts: 0,
      crease: 0,
    },
  },
  crt: {
    label: "CRT",
    family: "Effect",
    description: "CRT screen: barrel curvature, RGB aperture/slot mask, scanlines, glow, vignette, optional rolling sync band. Time-driven.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      opacity: 100,
      brightness: 110,
      saturation: 110,
      curvature: 25,
      scanlines: 60,
      mask: "aperture",
      maskStrength: 35,
      glow: 25,
      vignette: 35,
      rolling: 0,
    },
  },
  bloom: {
    label: "Bloom",
    family: "Effect",
    description: "Soft glow on bright pixels — luminance threshold with a soft knee, single-pass golden-spiral disk (adaptive 24–96 taps), per-pixel jittered to keep large radii artifact-free; additive add-back at intensity.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      opacity: 100,
      saturation: 100,
      threshold: 70,
      knee: 20,
      intensity: 100,
      radius: 16,
    },
  },
  halation: {
    label: "Halation",
    family: "Effect",
    description: "Tinted glow on bright areas — film/CRT halation. Same disk-blur as Bloom but the halo is monochrome and gets multiplied by an RGB tint (default warm orange).",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      opacity: 100,
      saturation: 100,
      threshold: 70,
      knee: 20,
      intensity: 120,
      radius: 24,
      tintColor: "#ff783c",
    },
  },
  ascii: {
    label: "ASCII",
    family: "Effect",
    description: "Replace cells of the input with characters from a luminance-mapped ramp — uses a cached glyph atlas texture so any cell size renders in a single shader pass.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      opacity: 100,
      cellSize: 8,
      ramp: "standard",
      invert: "off",
      colorMode: "source",
      // Signal shaping (md §2 P1) — identity defaults so old projects look
      // unchanged. signalBlack/signalWhite map raw luma into [0..1]; gamma
      // adjusts the curve; presence* hides cells whose signal sits below
      // the floor.
      signalBlack: 0,
      signalWhite: 100,
      signalGamma: 100,
      presenceThreshold: 0,
      presenceSoftness: 0,
    },
  },
  halftone: {
    label: "Halftone",
    family: "Effect",
    description: "Print-style halftone screen — choose dot/square/diamond shape, mono or CMY/CMYK plates, with hue, saturation, and opacity pre-mix.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      colorMode: "cmyk",
      shape: "circle",
      spacing: 5,
      angle: 15,
      dotScale: 100,
      opacity: 100,
      hue: 0,
      saturation: 100,
    },
  },
  mix: {
    label: "Mix",
    family: "Compose",
    description: "Blends the main chain with a branched image using composite modes.",
    inputs: [
      { name: "image_a", label: "Image A", type: "image" },
      { name: "image_b", label: "Image B", type: "image" },
    ],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { factor: 50, mode: "normal" },
  },
  displace: {
    label: "Displace",
    family: "Effect",
    description: "Offsets pixels with an optional map input or a procedural wave.",
    inputs: [
      { name: "image", label: "Image", type: "image" },
      { name: "map", label: "Map", type: "image" },
    ],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      mode: "wave",
      mapMode: "rg",
      xAmount: 16,
      yAmount: 0,
      strength: 100,
      frequency: 4,
      phase: 0,
      filter: "linear",
      mapFit: "stretch",
      mapScale: 100,
      mapOffsetX: 0,
      mapOffsetY: 0,
      debugMap: "off",
      mapCurve: null,
    },
  },
  value: {
    label: "Value",
    family: "Utility",
    description: "Outputs a scalar value for future parameter wiring.",
    chainable: false,
    inputs: [],
    outputs: [{ name: "value", label: "Value", type: "value" }],
    defaultParams: { value: 0 },
  },
  "audio-level": {
    label: "Audio Level",
    family: "Utility",
    description: "Outputs the source audio's RMS level at the current time, scaled by gain.",
    chainable: false,
    inputs: [],
    outputs: [{ name: "value", label: "Value", type: "value" }],
    defaultParams: { gain: 1 },
  },
  math: {
    label: "Math",
    family: "Utility",
    description: "Computes a scalar value from two numeric inputs.",
    chainable: false,
    inputs: [
      { name: "a", label: "A", type: "value" },
      { name: "b", label: "B", type: "value" },
    ],
    outputs: [{ name: "value", label: "Value", type: "value" }],
    defaultParams: { operation: "add", a: 0, b: 1, clamp: false },
  },
  group: {
    label: "Group",
    family: "Utility",
    description: "Editor-only container; children stay in the flat runtime graph.",
    chainable: false,
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {},
  },
  "viewer-output": {
    label: "Viewer Output",
    family: "Output",
    description: "Terminal graph node used by preview and export.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [],
    defaultParams: { target: "stage", fps: 30 },
  },
});

const TYPE_ORDER = {
  source: 0,
  "mesh-gradient": 1,
  gradient: 2,
  noise: 2.5,
  adjust: 3,
  posterize: 4,
  invert: 5,
  "rgb-to-bw": 6,
  "tone-map": 7,
  levels: 8,
  duotone: 9,
  "gradient-map": 10,
  hsv: 11,
  "rgb-curves": 12,
  blur: 13,
  pixelate: 14,
  scale: 15,
  transform: 16,
  crop: 17,
  flip: 18,
  dither: 19,
  "pattern-dither": 20,
  threshold: 21,
  "mask-combine": 22,
  "mask-apply": 23,
  glare: 24,
  "lens-distort": 25,
  "chromatic-aberration": 26,
  analog: 27,
  "led-screen": 28,
  modulation: 29,
  "pixel-sorting": 30,
  "depth-of-field": 31,
  vhs: 32,
  crt: 33,
  bloom: 34,
  halation: 35,
  ascii: 36,
  halftone: 37,
  displace: 38,
  mix: 39,
  value: 40,
  math: 41,
  "audio-level": 41.5,
  "scene-grade": 42,
  group: 43,
  "viewer-output": 44,
};

const NODE_PARAM_BOUNDS = Object.freeze({
  source: {
    brightness: { min: -100, max: 100 },
    contrast: { min: 0, max: 200 },
    saturation: { min: 0, max: 200 },
    gamma: { min: 10, max: 400 },
    exposure: { min: -400, max: 400 },
    hue: { min: -180, max: 180 },
    hsvSaturation: { min: 0, max: 400 },
    value: { min: 0, max: 400 },
  },
  "mesh-gradient": {
    complexity: { min: 0, max: 100 },
    warp: { min: 0, max: 100 },
    speed: { min: 0, max: 100 },
    zoom: { min: 25, max: 400 },
    width: { min: 256, max: 4096 },
    height: { min: 256, max: 4096 },
  },
  gradient: {
    angle: { min: -180, max: 180 },
    centerX: { min: 0, max: 100 },
    centerY: { min: 0, max: 100 },
    radius: { min: 1, max: 200 },
    repeat: { min: 1, max: 20 },
    shift: { min: -100, max: 100 },
    width: { min: 256, max: 4096 },
    height: { min: 256, max: 4096 },
  },
  noise: {
    scale: { min: 0.1, max: 64 },
    octaves: { min: 1, max: 8 },
    persistence: { min: 0, max: 100 },
    seed: { min: 0, max: 999 },
    animSpeed: { min: 0, max: 200 },
    width: { min: 256, max: 4096 },
    height: { min: 256, max: 4096 },
  },
  adjust: {
    brightness: { min: -100, max: 100 },
    contrast: { min: 0, max: 200 },
    saturation: { min: 0, max: 200 },
    gamma: { min: 10, max: 400 },
    exposure: { min: -400, max: 400 },
  },
  posterize: {
    steps: { min: 2, max: 64 },
    stepsG: { min: 0, max: 64 }, // 0 sentinel allowed = link to R
    stepsB: { min: 0, max: 64 },
    opacity: { min: 0, max: 100 },
  },
  "rgb-to-bw": {},
  "tone-map": {
    intensity: { min: 10, max: 1000 },
    whitepoint: { min: 10, max: 1000 },
  },
  levels: {
    // levels_entegrasyon.md §2 bounds. inputBlack stays strictly less than
    // inputWhite via the runtime clamp in applyLevelsNode, not the slider.
    inputBlack: { min: 0, max: 254 },
    inputWhite: { min: 1, max: 255 },
    gamma: { min: 10, max: 400 },
    outputBlack: { min: 0, max: 255 },
    outputWhite: { min: 0, max: 255 },
    opacity: { min: 0, max: 100 },
  },
  duotone: {
    // duotone_entegrasyon.md §1 bounds. Color params (shadowColor /
    // highlightColor) are HEX strings — no numeric bounds.
    redGamma: { min: 10, max: 500 },
    greenGamma: { min: 10, max: 500 },
    blueGamma: { min: 10, max: 500 },
    opacity: { min: 0, max: 100 },
  },
  "gradient-map": {
    // gradient_map_entegrasyon.md §1 bounds. The `stops` array carries HEX
    // colors + normalized positions; numeric controls only need these bounds.
    shift: { min: -100, max: 100 },
    repeat: { min: 1, max: 20 },
    opacity: { min: 0, max: 100 },
  },
  hsv: {
    hue: { min: -180, max: 180 },
    saturation: { min: 0, max: 400 },
    value: { min: 0, max: 400 },
  },
  "rgb-curves": {
    masterLow: { min: 0, max: 255 },
    masterMid: { min: 0, max: 255 },
    masterHigh: { min: 0, max: 255 },
    redLow: { min: 0, max: 255 },
    redMid: { min: 0, max: 255 },
    redHigh: { min: 0, max: 255 },
    greenLow: { min: 0, max: 255 },
    greenMid: { min: 0, max: 255 },
    greenHigh: { min: 0, max: 255 },
    blueLow: { min: 0, max: 255 },
    blueMid: { min: 0, max: 255 },
    blueHigh: { min: 0, max: 255 },
  },
  "scene-grade": {
    clampMin: { min: 0, max: 99 },
    clampMax: { min: 1, max: 100 },
    clampGamma: { min: 10, max: 400 },
  },
  pixelate: {
    size: { min: 1, max: 64 },
    sizeY: { min: 0, max: 64 }, // 0 sentinel allowed = link to size
    smoothing: { min: 0, max: 100 },
    gridOpacity: { min: 0, max: 100 },
    opacity: { min: 0, max: 100 },
  },
  scale: {
    x: { min: 10, max: 400 },
    y: { min: 10, max: 400 },
  },
  transform: {
    translateX: { min: -100, max: 100 },
    translateY: { min: -100, max: 100 },
    rotation: { min: -180, max: 180 },
    scale: { min: 1, max: 400 },
    x: { min: 10, max: 400 },
    y: { min: 10, max: 400 },
    left: { min: 0, max: 95 },
    right: { min: 0, max: 95 },
    top: { min: 0, max: 95 },
    bottom: { min: 0, max: 95 },
  },
  crop: {
    left: { min: 0, max: 95 },
    right: { min: 0, max: 95 },
    top: { min: 0, max: 95 },
    bottom: { min: 0, max: 95 },
  },
  dither: {
    threshold: { min: 0, max: 255 },
    scale: { min: 10, max: 100 },
    blurRadius: { min: 0, max: 20 },
    errorStrength: { min: 0, max: 100 },
  },
  "pattern-dither": {
    opacity: { min: 0, max: 100 },
    saturation: { min: 0, max: 200 },
    scale: { min: 1, max: 8 },
    strength: { min: 0, max: 200 },
    depth: { min: 1, max: 8 },
  },
  threshold: {
    opacity: { min: 0, max: 100 },
    threshold: { min: 0, max: 100 },
    softness: { min: 0, max: 50 },
  },
  "mask-combine": {
    opacity: { min: 0, max: 100 },
  },
  "mask-apply": {
    opacity: { min: 0, max: 100 },
    feather: { min: 0, max: 50 },
  },
  blur: { radius: { min: 0, max: 40 } },
  glare: {
    threshold: { min: 0, max: 255 },
    mix: { min: 0, max: 400 },
    saturation: { min: 0, max: 400 },
    streaks: { min: 1, max: 16 },
    angle: { min: 0, max: 180 },
    iterations: { min: 1, max: 8 },
    fade: { min: 0, max: 99 },
    length: { min: 1, max: 192 },
    falloff: { min: 1, max: 100 },
    alternate: { min: 0, max: 100 },
    colorize: { min: 0, max: 100 },
    size: { min: 1, max: 80 },
    quality: { min: 1, max: 4 },
    tintAmount: { min: 0, max: 100 },
    tintHue: { min: 0, max: 360 },
    knee: { min: 0, max: 50 },
  },
  "lens-distort": {
    distortion: { min: -100, max: 100 },
    dispersion: { min: 0, max: 100 },
    centerX: { min: 0, max: 100 },
    centerY: { min: 0, max: 100 },
    vignette: { min: 0, max: 100 },
  },
  "chromatic-aberration": {
    strength: { min: 0, max: 96 },
    angle: { min: -180, max: 180 },
    centerX: { min: 0, max: 100 },
    centerY: { min: 0, max: 100 },
  },
  halftone: {
    spacing: { min: 2, max: 64 },
    angle: { min: -90, max: 90 },
    dotScale: { min: 10, max: 250 },
    opacity: { min: 0, max: 100 },
    hue: { min: -180, max: 180 },
    saturation: { min: 0, max: 200 },
  },
  analog: {
    opacity: { min: 0, max: 100 },
    brightness: { min: 0, max: 300 },
    saturation: { min: 0, max: 200 },
    chroma: { min: 0, max: 32 },
    bleed: { min: 0, max: 100 },
    noise: { min: 0, max: 100 },
    scanlines: { min: 0, max: 100 },
    tracking: { min: 0, max: 100 },
    wave: { min: 0, max: 32 },
    curvature: { min: 0, max: 100 },
    maskStrength: { min: 0, max: 100 },
    glow: { min: 0, max: 100 },
    vignette: { min: 0, max: 100 },
    rolling: { min: 0, max: 100 },
    tapeResolution: { min: 25, max: 200 },
    jitter: { min: 0, max: 100 },
    flicker: { min: 0, max: 100 },
    dropouts: { min: 0, max: 100 },
    crease: { min: 0, max: 100 },
  },
  "led-screen": {
    cellSize: { min: 2, max: 48 },
    gap: { min: 0, max: 80 },
    softness: { min: 0, max: 100 },
    glow: { min: 0, max: 100 },
    brightness: { min: 25, max: 300 },
    opacity: { min: 0, max: 100 },
  },
  modulation: {
    frequency: { min: 4, max: 320 },
    sensitivity: { min: 0, max: 200 },
    thickness: { min: 1, max: 100 },
    angle: { min: -180, max: 180 },
    sourceMix: { min: 0, max: 100 },
    opacity: { min: 0, max: 100 },
  },
  "pixel-sorting": {
    threshold: { min: 0, max: 100 },
    softness: { min: 0, max: 50 },
    angle: { min: -180, max: 180 },
    length: { min: 1, max: 256 },
    iterations: { min: 1, max: 32 },
    opacity: { min: 0, max: 100 },
  },
  "depth-of-field": {
    centerX: { min: 0, max: 100 },
    centerY: { min: 0, max: 100 },
    radius: { min: 0, max: 100 },
    falloff: { min: 0, max: 100 },
    aspect: { min: 25, max: 400 },
    rotation: { min: -180, max: 180 },
    blur: { min: 0, max: 80 },
    samples: { min: 8, max: 64 },
    blades: { min: 3, max: 12 },
    anamorphic: { min: 25, max: 400 },
    opacity: { min: 0, max: 100 },
  },
  vhs: {
    opacity: { min: 0, max: 100 },
    chroma: { min: 0, max: 32 },
    bleed: { min: 0, max: 100 },
    noise: { min: 0, max: 100 },
    scanlines: { min: 0, max: 100 },
    tracking: { min: 0, max: 100 },
    wave: { min: 0, max: 32 },
    vignette: { min: 0, max: 100 },
    saturation: { min: 0, max: 200 },
    tapeResolution: { min: 25, max: 200 },
    jitter: { min: 0, max: 100 },
    flicker: { min: 0, max: 100 },
    dropouts: { min: 0, max: 100 },
    crease: { min: 0, max: 100 },
  },
  crt: {
    opacity: { min: 0, max: 100 },
    brightness: { min: 0, max: 300 },
    saturation: { min: 0, max: 200 },
    curvature: { min: 0, max: 100 },
    scanlines: { min: 0, max: 100 },
    maskStrength: { min: 0, max: 100 },
    glow: { min: 0, max: 100 },
    vignette: { min: 0, max: 100 },
    rolling: { min: 0, max: 100 },
  },
  bloom: {
    opacity: { min: 0, max: 100 },
    saturation: { min: 0, max: 200 },
    threshold: { min: 0, max: 100 },
    knee: { min: 0, max: 50 },
    intensity: { min: 0, max: 400 },
    radius: { min: 0, max: 64 },
  },
  halation: {
    opacity: { min: 0, max: 100 },
    saturation: { min: 0, max: 200 },
    threshold: { min: 0, max: 100 },
    knee: { min: 0, max: 50 },
    intensity: { min: 0, max: 400 },
    radius: { min: 0, max: 96 },
    // tintColor is a HEX string — no numeric bounds.
  },
  ascii: {
    opacity: { min: 0, max: 100 },
    cellSize: { min: 4, max: 32 },
    signalBlack: { min: 0, max: 100 },
    signalWhite: { min: 0, max: 100 },
    signalGamma: { min: 10, max: 400 },
    presenceThreshold: { min: 0, max: 100 },
    presenceSoftness: { min: 0, max: 100 },
  },
  displace: {
    xAmount: { min: -200, max: 200 },
    yAmount: { min: -200, max: 200 },
    strength: { min: 0, max: 400 },
    frequency: { min: 1, max: 32 },
    phase: { min: 0, max: 360 },
    mapScale: { min: 10, max: 800 },
    mapOffsetX: { min: -100, max: 100 },
    mapOffsetY: { min: -100, max: 100 },
  },
  mix: { factor: { min: 0, max: 100 } },
  math: {
    a: { min: -1000, max: 1000 },
    b: { min: -1000, max: 1000 },
  },
  "viewer-output": { "viewer-fps": { min: 1, max: 120 } },
});

export function getNodeDefinition(type) {
  return NODE_DEFINITIONS[type] ?? null;
}

export function getNodeParentId(node) {
  if (!node || isRootLockedType(node.type)) return ROOT_PARENT_ID;
  return normalizeParentId(node.parentId);
}

export function resolveGraphParentId(graph, parentId) {
  const requested = normalizeParentId(parentId);
  if (requested === ROOT_PARENT_ID) return ROOT_PARENT_ID;
  const parent = graph?.nodes?.find((node) => node.id === requested);
  return parent?.type === "group" ? requested : ROOT_PARENT_ID;
}

export function getNodeParamBounds(nodeOrType, paramKey) {
  const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType?.type;
  const configured =
    typeof nodeOrType === "object" ? normalizeBounds(nodeOrType?.exposedParamConfig?.[paramKey]) : null;
  if (configured) return configured;
  return normalizeBounds(NODE_PARAM_BOUNDS[type]?.[paramKey]);
}

export function getValueNodeOutputBounds(nodeId, graph = getState().graph) {
  if (!nodeId) return null;
  let min = -Infinity;
  let max = Infinity;
  let found = false;

  for (const edge of graph.edges ?? []) {
    if (edge.fromNode !== nodeId || !isParamSocketName(edge.toSocket)) continue;
    const target = getNodeById(edge.toNode, graph);
    if (!target) continue;
    const bounds = getNodeParamBounds(target, edge.toSocket.slice("param:".length));
    if (!bounds) continue;
    if (Number.isFinite(bounds.min)) min = Math.max(min, bounds.min);
    if (Number.isFinite(bounds.max)) max = Math.min(max, bounds.max);
    found = true;
  }

  if (!found) return null;
  if (min > max) return { min: max, max };
  return { min, max };
}

export function snapshotGraphForHistory(graph = getState().graph) {
  return clone(graph);
}

export function pushGraphHistoryFromSnapshot(before, label = "Edit graph") {
  if (!before) return false;
  const after = snapshotGraphForHistory();
  if (graphSnapshotsEqual(before, after)) return false;
  pushHistory({
    label,
    undo: () => restoreGraphHistorySnapshot(before),
    redo: () => restoreGraphHistorySnapshot(after),
  });
  return true;
}

function restoreGraphHistorySnapshot(snapshot) {
  const normalized = normalizeGraph(snapshotGraphForHistory(snapshot));
  dispatch("graph", normalized);
  const parentId = getState().graphView.currentParentId;
  const resolvedParentId = resolveGraphParentId(normalized, parentId);
  if (resolvedParentId !== parentId) {
    dispatch("graphView", { currentParentId: resolvedParentId });
  }
}

function graphSnapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createBootGraph() {
  const nodes = [
    createNode("source-1", "source"),
    createNode("viewer-output-1", "viewer-output"),
  ];

  layoutLinearNodes(nodes);

  return {
    nodes,
    edges: buildLinearEdges(nodes),
    selectedNodeId: "viewer-output-1",
    selectedNodeIds: ["viewer-output-1"],
    solo: null,
  };
}

export function ensureBootGraph() {
  const graph = getState().graph;
  if (graph.nodes.length > 0) return graph;

  const bootGraph = createBootGraph();
  dispatch("graph", bootGraph);
  return bootGraph;
}

export function selectNode(nodeId, options = {}) {
  const { graph } = getState();
  if (!nodeId) return;
  if (!graph.nodes.some((node) => node.id === nodeId)) return;
  const current = new Set(getSelectedNodeIds(graph));
  const extend = Boolean(options.extend || options.toggle);

  if (extend) {
    if (options.toggle && current.has(nodeId) && current.size > 1) {
      current.delete(nodeId);
      const nextIds = [...current];
      dispatch("graph", {
        selectedNodeId: nextIds.at(-1) ?? null,
        selectedNodeIds: nextIds,
      });
      return;
    }
    current.add(nodeId);
    dispatch("graph", {
      selectedNodeId: nodeId,
      selectedNodeIds: [...current],
    });
    return;
  }

  if (graph.selectedNodeId === nodeId && getSelectedNodeIds(graph).length === 1) return;
  dispatch("graph", {
    selectedNodeId: nodeId,
    selectedNodeIds: [nodeId],
  });
}

export function selectNodes(nodeIds, primaryNodeId = null) {
  const { graph } = getState();
  const existing = new Set(graph.nodes.map((node) => node.id));
  const ids = [...new Set(Array.isArray(nodeIds) ? nodeIds : [])].filter((nodeId) => existing.has(nodeId));
  const primary = primaryNodeId && ids.includes(primaryNodeId) ? primaryNodeId : ids.at(-1) ?? null;
  dispatch("graph", {
    selectedNodeId: primary,
    selectedNodeIds: ids,
  });
}

export function getSelectedNodeIds(graph = getState().graph) {
  const ids = Array.isArray(graph?.selectedNodeIds) ? graph.selectedNodeIds : [];
  const existing = new Set((graph?.nodes ?? []).map((node) => node.id));
  const selected = [...new Set(ids)].filter((nodeId) => existing.has(nodeId));
  if (selected.length > 0) return selected;
  return graph?.selectedNodeId && existing.has(graph.selectedNodeId) ? [graph.selectedNodeId] : [];
}

export function getViewerOutputNode(graph = getState().graph) {
  if (!graph?.nodes?.length) return null;
  return graph.nodes.find((node) => node.type === "viewer-output") ?? null;
}

export function getViewerOutputFps(graph = getState().graph) {
  const fps = Number(getViewerOutputNode(graph)?.params?.fps);
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps) : null;
}

export function setViewerOutputFps(fps) {
  const nextFps = Number.isFinite(Number(fps)) ? Math.max(1, Math.round(Number(fps))) : null;
  if (!nextFps) return false;

  const { graph } = getState();
  let changed = false;
  const nextNodes = graph.nodes.map((node) => {
    if (node.type !== "viewer-output" || node.params?.fps === nextFps) return node;
    changed = true;
    return {
      ...node,
      params: {
        ...node.params,
        fps: nextFps,
      },
    };
  });

  if (!changed) return false;
  dispatch("graph", { nodes: nextNodes });
  return true;
}

export function addLinearNode(type) {
  const definition = getNodeDefinition(type);
  if (!definition || definition.chainable === false) return null;
  if (type === "source" || type === "viewer-output") return null;
  if (type === "mix") return addMixNode();
  return insertNodeIntoChain(type);
}

export function addMixNode() {
  return insertNodeIntoChain("mix", (newNode, graph) => {
    const source = graph.nodes.find((node) => node.type === "source");
    if (!source) return [];
    return [
      {
        id: createEdgeId(source.id, "image", newNode.id, "image_b"),
        fromNode: source.id,
        fromSocket: "image",
        toNode: newNode.id,
        toSocket: "image_b",
      },
    ];
  });
}

function insertNodeIntoChain(type, extraEdgeFactory = null) {
  const definition = getNodeDefinition(type);
  if (!definition || definition.chainable === false) return null;

  const graph = ensureBootGraph();
  const before = snapshotGraphForHistory(graph);
  const chain = getMainChain(graph);
  const insertIndex = getInsertionIndex(chain, type);
  const prevNode = chain[insertIndex - 1];
  const nextNode = chain[insertIndex];
  if (!prevNode || !nextNode) return null;

  const nodeId = nextNodeId(type, graph);
  const newNode = createNode(nodeId, type);
  const nextPrimarySocket = getPrimaryInputSocket(nextNode);
  const inputSocket = getPrimaryInputSocket(newNode);
  const outputSocket = getPrimaryOutputSocket(newNode);
  if (!isImageSocket(newNode, "input", inputSocket) || !isImageSocket(newNode, "output", outputSocket)) {
    return null;
  }

  const nextEdges = graph.edges
    .filter(
      (edge) =>
        !(
          edge.fromNode === prevNode.id &&
          edge.toNode === nextNode.id &&
          edge.toSocket === nextPrimarySocket
        )
    )
    .map((edge) => ({ ...edge }));

  nextEdges.push({
    id: createEdgeId(prevNode.id, "image", nodeId, inputSocket),
    fromNode: prevNode.id,
    fromSocket: "image",
    toNode: nodeId,
    toSocket: inputSocket,
  });
  nextEdges.push({
    id: createEdgeId(nodeId, outputSocket, nextNode.id, nextPrimarySocket),
    fromNode: nodeId,
    fromSocket: outputSocket,
    toNode: nextNode.id,
    toSocket: nextPrimarySocket,
  });

  if (extraEdgeFactory) {
    const extras = extraEdgeFactory(newNode, graph);
    if (Array.isArray(extras)) nextEdges.push(...extras);
  }

  const nextNodes = [...graph.nodes.map((node) => clone(node)), newNode];
  layoutMainChain(nextNodes, nextEdges);

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId: nodeId,
    selectedNodeIds: [nodeId],
  });
  pushGraphHistoryFromSnapshot(before, "Add node");

  return nodeId;
}

// Create a new "source" node bound to a media source (params.sourceId) at
// `position` (graph world coords). Unlike createFreeNode this allows the
// otherwise-singleton source type — multiple bound video inputs are the point.
// Dragging an asset onto the node canvas calls this. One history entry.
export function createBoundSourceNode(sourceId, position, label) {
  if (!sourceId) return null;
  const graph = ensureBootGraph();
  const before = snapshotGraphForHistory(graph);
  const nodeId = nextNodeId("source", graph);
  const newNode = createNode(nodeId, "source", {
    x: position?.x ?? NODE_BASE_X,
    y: position?.y ?? NODE_BASE_Y,
    label,
    params: { sourceId },
  });
  dispatch("graph", {
    nodes: [...graph.nodes, newNode],
    selectedNodeId: nodeId,
    selectedNodeIds: [nodeId],
  });
  pushGraphHistoryFromSnapshot(before, "Add video input");
  return nodeId;
}

// Rebind the source node feeding the viewer output to `sourceId` (drag an asset
// onto the preview). Returns the rebound node id, or null when no source node is
// upstream of the viewer. One history entry.
export function rebindOutputSource(sourceId) {
  if (!sourceId) return null;
  const graph = ensureBootGraph();
  const targetId = findOutputSourceNodeId(graph);
  if (!targetId) return null;
  const before = snapshotGraphForHistory(graph);
  updateNodeParams(targetId, { sourceId });
  pushGraphHistoryFromSnapshot(before, "Set video input source");
  return targetId;
}

// Walk back from the viewer-output through input edges to the nearest source
// node — the "video input connected to the output".
function findOutputSourceNodeId(graph) {
  const viewer = graph.nodes.find((node) => node.type === "viewer-output");
  if (!viewer) return null;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const visited = new Set();
  const stack = [viewer.id];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (node && node.type === "source") return id;
    for (const edge of graph.edges ?? []) {
      if (edge.toNode === id && !visited.has(edge.fromNode)) stack.push(edge.fromNode);
    }
  }
  return null;
}

export function createFreeNode(type, position, parentId = ROOT_PARENT_ID) {
  const definition = getNodeDefinition(type);
  if (!definition || type === "source" || type === "viewer-output") return null;

  const graph = ensureBootGraph();
  const before = snapshotGraphForHistory(graph);
  const nodeId = nextNodeId(type, graph);
  const newNode = createNode(nodeId, type, {
    x: position?.x ?? NODE_BASE_X,
    y: position?.y ?? NODE_BASE_Y,
    parentId,
  });

  dispatch("graph", {
    // Shallow copy — existing nodes are unchanged here, only `newNode` is
    // appended. Deep-cloning every node would burn ~O(N) on a hot path
    // that's reached on every node insertion.
    nodes: [...graph.nodes, newNode],
    selectedNodeId: nodeId,
    selectedNodeIds: [nodeId],
  });
  pushGraphHistoryFromSnapshot(before, "Add node");

  return nodeId;
}

export function duplicateNode(nodeId, options = {}) {
  return duplicateNodes([nodeId], options)[0] ?? null;
}

export function duplicateNodes(nodeIds, options = {}) {
  const graph = ensureBootGraph();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const selectedIds = [...new Set(Array.isArray(nodeIds) ? nodeIds : [])];
  const sources = selectedIds
    .map((nodeId) => getNodeById(nodeId, graph))
    .filter((node) => node && node.type !== "source" && node.type !== "viewer-output" && node.type !== "group");
  if (sources.length === 0) return [];

  const offset = Number.isFinite(Number(options.offset)) ? Number(options.offset) : 36;
  // Shallow copy: existing nodes are not mutated below — only freshly
  // created `createNode(...)` entries (already independent objects with
  // their own cloned params) are pushed onto the array.
  const nextNodes = [...graph.nodes];
  const duplicatedIds = [];
  const idMap = new Map();

  for (const source of sources) {
    const nextId = nextNodeId(source.type, { ...graph, nodes: nextNodes });
    idMap.set(source.id, nextId);
    duplicatedIds.push(nextId);
    nextNodes.push(
      createNode(nextId, source.type, {
        parentId: getNodeParentId(source),
        label: createDuplicateLabel(source.label),
        x: source.x + offset,
        y: source.y + offset,
        params: clone(source.params),
        opacity: source.opacity,
        hue: source.hue,
        saturation: source.saturation,
        exposedParams: clone(source.exposedParams),
        exposedParamConfig: clone(source.exposedParamConfig),
        bypassed: source.bypassed,
      })
    );
  }

  const nextEdges = graph.edges.map((edge) => ({ ...edge }));
  for (const edge of graph.edges) {
    const fromNode = idMap.get(edge.fromNode);
    const toNode = idMap.get(edge.toNode);
    if (!fromNode || !toNode) continue;
    nextEdges.push({
      id: createEdgeId(fromNode, edge.fromSocket, toNode, edge.toSocket),
      fromNode,
      fromSocket: edge.fromSocket,
      toNode,
      toSocket: edge.toSocket,
    });
  }

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId: duplicatedIds.at(-1) ?? null,
    selectedNodeIds: duplicatedIds,
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Duplicate node");

  return duplicatedIds;
}

// ---------- recipes (portable node sub-graphs) ----------
//
// A recipe is a serialized selection of effect nodes plus the edges fully
// inside that selection — a reusable sub-chain saved to / loaded from a file.
// Source / viewer-output / group nodes are excluded (a recipe is an effect
// fabric, not a whole graph). Import mirrors duplicateNodes: fresh ids, internal
// edges remapped, positions translated to a target point.

export const RECIPE_KIND = "dither-recipe";
export const RECIPE_VERSION = 1;

function isRecipableNode(node) {
  return node && node.type !== "source" && node.type !== "viewer-output" && node.type !== "group";
}

// Build a portable recipe object from a node selection. Returns null when the
// selection has no recipable nodes.
export function serializeRecipe(nodeIds, graph = getState().graph) {
  const ids = new Set(Array.isArray(nodeIds) ? nodeIds : []);
  const nodes = graph.nodes.filter((node) => ids.has(node.id) && isRecipableNode(node));
  if (nodes.length === 0) return null;
  const keep = new Set(nodes.map((node) => node.id));
  const serializedNodes = nodes.map((node) => {
    const definition = getNodeDefinition(node.type);
    const payload = {
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      params: clone(node.params),
      exposedParams: Array.isArray(node.exposedParams) ? [...node.exposedParams] : [],
      exposedParamConfig: clone(node.exposedParamConfig),
      bypassed: Boolean(node.bypassed),
    };
    if (node.label && node.label !== definition?.label) payload.label = node.label;
    if (isLayerAdjustableType(node.type)) {
      payload.opacity = node.opacity;
      payload.hue = node.hue;
      payload.saturation = node.saturation;
    }
    return payload;
  });
  const edges = getPersistableGraphEdges(graph)
    .filter((edge) => keep.has(edge.fromNode) && keep.has(edge.toNode))
    .map((edge) => ({
      fromNode: edge.fromNode,
      fromSocket: edge.fromSocket,
      toNode: edge.toNode,
      toSocket: edge.toSocket,
    }));
  return { kind: RECIPE_KIND, version: RECIPE_VERSION, nodes: serializedNodes, edges };
}

export function isRecipe(value) {
  return Boolean(value && value.kind === RECIPE_KIND && Array.isArray(value.nodes) && value.nodes.length > 0);
}

// Splice a recipe into the current graph. `options.position` (world coords)
// places the recipe's top-left corner; `options.parentId` sets the graph scope.
// Returns the new node ids (selected), or [] when nothing recipable imported.
export function importRecipe(recipe, options = {}) {
  if (!isRecipe(recipe)) return [];
  const graph = ensureBootGraph();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const parentId = options.parentId ?? null;
  const position = options.position && Number.isFinite(Number(options.position.x))
    ? { x: Number(options.position.x), y: Number(options.position.y) }
    : { x: 0, y: 0 };
  const recipable = recipe.nodes.filter((node) => getNodeDefinition(node.type) && isRecipableNode(node));
  if (recipable.length === 0) return [];
  // Translate so the recipe's top-left corner lands at `position`.
  const minX = Math.min(...recipable.map((node) => Number(node.x) || 0));
  const minY = Math.min(...recipable.map((node) => Number(node.y) || 0));

  const nextNodes = [...graph.nodes];
  const idMap = new Map();
  const newIds = [];
  for (const node of recipable) {
    const nextId = nextNodeId(node.type, { ...graph, nodes: nextNodes });
    idMap.set(node.id, nextId);
    newIds.push(nextId);
    nextNodes.push(
      createNode(nextId, node.type, {
        parentId,
        label: node.label,
        x: position.x + ((Number(node.x) || 0) - minX),
        y: position.y + ((Number(node.y) || 0) - minY),
        params: clone(node.params),
        opacity: node.opacity,
        hue: node.hue,
        saturation: node.saturation,
        exposedParams: clone(node.exposedParams),
        exposedParamConfig: clone(node.exposedParamConfig),
        bypassed: node.bypassed,
      })
    );
  }

  const nextEdges = graph.edges.map((edge) => ({ ...edge }));
  for (const edge of recipe.edges ?? []) {
    const fromNode = idMap.get(edge.fromNode);
    const toNode = idMap.get(edge.toNode);
    if (!fromNode || !toNode) continue;
    nextEdges.push({
      id: createEdgeId(fromNode, edge.fromSocket, toNode, edge.toSocket),
      fromNode,
      fromSocket: edge.fromSocket,
      toNode,
      toSocket: edge.toSocket,
    });
  }

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId: newIds.at(-1) ?? null,
    selectedNodeIds: newIds,
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Import recipe");
  return newIds;
}

export function insertNodeOnEdge(edgeId, type, options = {}) {
  const definition = getNodeDefinition(type);
  if (!definition || definition.chainable === false || type === "source" || type === "viewer-output") return null;

  const graph = ensureBootGraph();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) return null;

  const fromNode = getNodeById(edge.fromNode, graph);
  const toNode = getNodeById(edge.toNode, graph);
  if (!fromNode || !toNode) return null;

  const nodeId = nextNodeId(type, graph);
  const hasExplicitPosition = Boolean(options.position);
  const parentId = options.parentId ?? commonNodeParentId(fromNode, toNode);
  const newNode = createNode(nodeId, type, {
    x: options.position?.x ?? midpoint(fromNode.x, toNode.x),
    y: options.position?.y ?? midpoint(fromNode.y, toNode.y),
    parentId,
  });
  const inputSocket = getPrimaryInputSocket(newNode);
  const outputSocket = newNode.outputs?.[0]?.name;
  if (!outputSocket) return null;
  if (!inputSocket) {
    if (!socketsCompatible(newNode, outputSocket, toNode, edge.toSocket)) return null;

    const nextEdges = graph.edges
      .filter((item) => item.id !== edgeId)
      .map((item) => ({ ...item }));

    nextEdges.push({
      id: createEdgeId(nodeId, outputSocket, edge.toNode, edge.toSocket),
      fromNode: nodeId,
      fromSocket: outputSocket,
      toNode: edge.toNode,
      toSocket: edge.toSocket,
    });

    const nextNodes = [...graph.nodes.map((node) => clone(node)), newNode];
    if (isPrimaryChainEdge(edge, graph)) {
      spacePrimaryChainAroundNode(nextNodes, nextEdges, edge.fromNode, nodeId, edge.toNode, {
        preserveInserted: hasExplicitPosition,
      });
    }
    dispatch("graph", {
      nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
      edges: nextEdges,
      selectedNodeId: nodeId,
      selectedNodeIds: [nodeId],
    });
    if (before) pushGraphHistoryFromSnapshot(before, "Insert node");

    return nodeId;
  }
  if (!socketsCompatible(fromNode, edge.fromSocket, newNode, inputSocket)) return null;
  if (!socketsCompatible(newNode, outputSocket, toNode, edge.toSocket)) return null;

  const nextEdges = graph.edges
    .filter((item) => item.id !== edgeId)
    .map((item) => ({ ...item }));

  nextEdges.push({
    id: createEdgeId(edge.fromNode, edge.fromSocket, nodeId, inputSocket),
    fromNode: edge.fromNode,
    fromSocket: edge.fromSocket,
    toNode: nodeId,
    toSocket: inputSocket,
  });
  nextEdges.push({
    id: createEdgeId(nodeId, outputSocket, edge.toNode, edge.toSocket),
    fromNode: nodeId,
    fromSocket: outputSocket,
    toNode: edge.toNode,
    toSocket: edge.toSocket,
  });

  if (type === "mix") {
    const source = graph.nodes.find((node) => node.type === "source");
    if (source) {
      nextEdges.push({
        id: createEdgeId(source.id, "image", nodeId, "image_b"),
        fromNode: source.id,
        fromSocket: "image",
        toNode: nodeId,
        toSocket: "image_b",
      });
    }
  }

  const nextNodes = [...graph.nodes.map((node) => clone(node)), newNode];
  if (isPrimaryChainEdge(edge, graph)) {
    spacePrimaryChainAroundNode(nextNodes, nextEdges, edge.fromNode, nodeId, edge.toNode, {
      preserveInserted: hasExplicitPosition,
    });
  }
  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId: nodeId,
    selectedNodeIds: [nodeId],
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Insert node");

  return nodeId;
}

export function insertExistingNodeOnEdge(nodeId, edgeId, options = {}) {
  if (!nodeId || !edgeId) return false;

  const graph = ensureBootGraph();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge || edge.fromNode === nodeId || edge.toNode === nodeId) return false;

  const node = getNodeById(nodeId, graph);
  const fromNode = getNodeById(edge.fromNode, graph);
  const toNode = getNodeById(edge.toNode, graph);
  if (!node || !fromNode || !toNode) return false;
  if (node.type === "source" || node.type === "viewer-output") return false;

  const definition = getNodeDefinition(node.type);
  if (!definition || definition.chainable === false) return false;

  const inputSocket = getPrimaryInputSocket(node);
  const outputSocket = getPrimaryOutputSocket(node);
  if (!outputSocket) return false;
  if (!inputSocket) {
    if (!socketsCompatible(node, outputSocket, toNode, edge.toSocket)) return false;

    const nextNodes = graph.nodes.map((item) => clone(item));
    const inserted = nextNodes.find((item) => item.id === nodeId);
    if (!inserted) return false;
    inserted.parentId = commonNodeParentId(fromNode, toNode);
    if (options.position) {
      inserted.x = options.position.x;
      inserted.y = options.position.y;
    }

    const nextEdges = graph.edges
      .filter((item) => item.id !== edgeId)
      .filter((item) => !(item.fromNode === nodeId && item.fromSocket === outputSocket))
      .map((item) => ({ ...item }));

    if (wouldCreateCycle(nodeId, edge.toNode, nextEdges)) return false;
    nextEdges.push({
      id: createEdgeId(nodeId, outputSocket, edge.toNode, edge.toSocket),
      fromNode: nodeId,
      fromSocket: outputSocket,
      toNode: edge.toNode,
      toSocket: edge.toSocket,
    });

    if (isPrimaryChainEdge(edge, graph)) {
      spacePrimaryChainAroundNode(nextNodes, nextEdges, edge.fromNode, nodeId, edge.toNode, {
        preserveInserted: true,
      });
    }

    dispatch("graph", {
      nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
      edges: nextEdges,
      selectedNodeId: nodeId,
      selectedNodeIds: [nodeId],
    });
    if (before) pushGraphHistoryFromSnapshot(before, "Insert node");

    return true;
  }
  if (!socketsCompatible(fromNode, edge.fromSocket, node, inputSocket)) return false;
  if (!socketsCompatible(node, outputSocket, toNode, edge.toSocket)) return false;

  const nextNodes = graph.nodes.map((item) => clone(item));
  const inserted = nextNodes.find((item) => item.id === nodeId);
  if (!inserted) return false;
  inserted.parentId = commonNodeParentId(fromNode, toNode);
  if (options.position) {
    inserted.x = options.position.x;
    inserted.y = options.position.y;
  }

  const nextEdges = graph.edges
    .filter((item) => item.id !== edgeId)
    .filter((item) => !(item.toNode === nodeId && item.toSocket === inputSocket))
    .filter((item) => !(item.fromNode === nodeId && item.fromSocket === outputSocket))
    .map((item) => ({ ...item }));

  if (wouldCreateCycle(edge.fromNode, nodeId, nextEdges)) return false;
  nextEdges.push({
    id: createEdgeId(edge.fromNode, edge.fromSocket, nodeId, inputSocket),
    fromNode: edge.fromNode,
    fromSocket: edge.fromSocket,
    toNode: nodeId,
    toSocket: inputSocket,
  });

  if (wouldCreateCycle(nodeId, edge.toNode, nextEdges)) return false;
  nextEdges.push({
    id: createEdgeId(nodeId, outputSocket, edge.toNode, edge.toSocket),
    fromNode: nodeId,
    fromSocket: outputSocket,
    toNode: edge.toNode,
    toSocket: edge.toSocket,
  });

  if (node.type === "mix" && !nextEdges.some((item) => item.toNode === nodeId && item.toSocket === "image_b")) {
    const source = graph.nodes.find((item) => item.type === "source");
    if (source && socketsCompatible(source, "image", node, "image_b")) {
      nextEdges.push({
        id: createEdgeId(source.id, "image", nodeId, "image_b"),
        fromNode: source.id,
        fromSocket: "image",
        toNode: nodeId,
        toSocket: "image_b",
      });
    }
  }

  if (isPrimaryChainEdge(edge, graph)) {
    spacePrimaryChainAroundNode(nextNodes, nextEdges, edge.fromNode, nodeId, edge.toNode, {
      preserveInserted: true,
    });
  }

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId: nodeId,
    selectedNodeIds: [nodeId],
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Insert node");

  return true;
}

export function groupSelectedNodes(options = {}) {
  const graph = ensureBootGraph();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const selectedNodes = getGroupableSelectedNodes(graph, options.nodeIds);
  if (selectedNodes.length === 0) return null;

  const parentId = getNodeParentId(selectedNodes[0]);
  if (!selectedNodes.every((node) => getNodeParentId(node) === parentId)) {
    return null;
  }

  const groupId = nextNodeId("group", graph);
  const childIds = new Set(selectedNodes.map((node) => node.id));
  const bounds = getNodesBounds(selectedNodes);
  const groupNode = createNode(groupId, "group", {
    parentId,
    label: options.label ?? defaultGroupLabel(groupId),
    x: Math.round(bounds.minX - 34),
    y: Math.round(bounds.minY - 86),
    group: analyzeGroupBoundary(graph, childIds),
  });

  const nextNodes = [
    ...graph.nodes.map((node) => {
      const next = clone(node);
      if (childIds.has(next.id)) next.parentId = groupId;
      return next;
    }),
    groupNode,
  ];
  normalizeNodeParents(nextNodes);

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, graph.edges),
    edges: graph.edges.map((edge) => ({ ...edge })),
    selectedNodeId: groupId,
    selectedNodeIds: [groupId],
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Group nodes");

  return groupId;
}

export function ungroupNode(groupId, options = {}) {
  if (!groupId) return false;
  const graph = ensureBootGraph();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const group = getNodeById(groupId, graph);
  if (!group || group.type !== "group") return false;

  const parentId = getNodeParentId(group);
  const childIds = graph.nodes
    .filter((node) => getNodeParentId(node) === groupId)
    .map((node) => node.id);
  const childSet = new Set(childIds);

  const nextNodes = graph.nodes
    .filter((node) => node.id !== groupId)
    .map((node) => {
      const next = clone(node);
      if (childSet.has(next.id) || getNodeParentId(next) === groupId) {
        next.parentId = parentId;
      }
      return next;
    });
  normalizeNodeParents(nextNodes);

  const nextEdges = graph.edges
    .filter((edge) => edge.fromNode !== groupId && edge.toNode !== groupId)
    .map((edge) => ({ ...edge }));
  const nextSelection = childIds.filter((nodeId) => nextNodes.some((node) => node.id === nodeId));

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId: nextSelection.at(-1) ?? null,
    selectedNodeIds: nextSelection,
  });

  if (getState().graphView.currentParentId === groupId) {
    dispatch("graphView", { currentParentId: parentId });
  }
  if (before) pushGraphHistoryFromSnapshot(before, "Ungroup nodes");

  return true;
}

export function mutateNodePosition(nodeId, x, y) {
  const { graph } = getState();
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  node.x = x;
  node.y = y;
  return true;
}

export function commitLayout() {
  dispatch("graph", {});
}

export function addEdge(fromNode, fromSocket, toNode, toSocket, options = {}) {
  if (!fromNode || !toNode || fromNode === toNode) return false;

  const graph = getState().graph;
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const fromDef = graph.nodes.find((node) => node.id === fromNode);
  const toDef = graph.nodes.find((node) => node.id === toNode);
  if (!fromDef || !toDef) return false;

  const hasOutput = fromDef.outputs.some((socket) => socket.name === fromSocket);
  const hasInput = hasInputSocket(toDef, toSocket);
  if (!hasOutput || !hasInput) return false;
  if (!socketsCompatible(fromDef, fromSocket, toDef, toSocket)) return false;

  const duplicate = graph.edges.some(
    (edge) =>
      edge.fromNode === fromNode &&
      edge.fromSocket === fromSocket &&
      edge.toNode === toNode &&
      edge.toSocket === toSocket
  );
  if (duplicate) return false;

  const nextEdges = graph.edges
    .filter((edge) => !(edge.toNode === toNode && edge.toSocket === toSocket))
    .map((edge) => ({ ...edge }));

  if (wouldCreateCycle(fromNode, toNode, nextEdges)) return false;

  nextEdges.push({
    id: createEdgeId(fromNode, fromSocket, toNode, toSocket),
    fromNode,
    fromSocket,
    toNode,
    toSocket,
  });

  const nextNodes =
    fromDef.type === "value" && isParamSocketName(toSocket)
      ? clampValueNodeForEdges(graph.nodes, nextEdges, fromNode)
      : graph.nodes;
  // refreshGroupMetadataForNodes always returns a new array via .map(...)
  // and never mutates its input, so passing graph.nodes directly is safe
  // and avoids an O(N) JSON deep-clone on the edge-add hot path.
  const refreshedNodes = refreshGroupMetadataForNodes(nextNodes, nextEdges);

  dispatch("graph", { nodes: refreshedNodes, edges: nextEdges });
  if (before) pushGraphHistoryFromSnapshot(before, "Connect nodes");
  return true;
}

export function removeNode(nodeId, options = {}) {
  if (!nodeId) return false;

  const graph = getState().graph;
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node || node.type === "source" || node.type === "viewer-output") return false;

  const primaryInput = getPrimaryInputSocket(node);
  const primaryOutput = getPrimaryOutputSocket(node);
  const incomingPrimary = primaryInput
    ? graph.edges.find((edge) => edge.toNode === nodeId && edge.toSocket === primaryInput)
    : null;
  const outgoingPrimary = primaryOutput
    ? graph.edges.find((edge) => edge.fromNode === nodeId && edge.fromSocket === primaryOutput)
    : null;

  const fallbackParentId = getNodeParentId(node);
  const nextNodes = graph.nodes
    .filter((item) => item.id !== nodeId)
    .map((item) => {
      const next = clone(item);
      if (getNodeParentId(next) === nodeId) {
        next.parentId = fallbackParentId;
      }
      return next;
    });
  normalizeNodeParents(nextNodes);
  const nextEdges = graph.edges
    .filter((edge) => edge.fromNode !== nodeId && edge.toNode !== nodeId)
    .map((edge) => ({ ...edge }));

  if (incomingPrimary && outgoingPrimary) {
    const targetNode = nextNodes.find((item) => item.id === outgoingPrimary.toNode);
    const targetSocket = outgoingPrimary.toSocket;
    const targetSocketStillFree = !nextEdges.some(
      (edge) => edge.toNode === outgoingPrimary.toNode && edge.toSocket === targetSocket
    );
    const selfEdge = incomingPrimary.fromNode === outgoingPrimary.toNode;
    const socketExists = targetNode?.inputs?.some((socket) => socket.name === targetSocket);

    if (
      targetSocketStillFree &&
      !selfEdge &&
      socketExists &&
      !wouldCreateCycle(incomingPrimary.fromNode, outgoingPrimary.toNode, nextEdges)
    ) {
      nextEdges.push({
        id: createEdgeId(
          incomingPrimary.fromNode,
          incomingPrimary.fromSocket,
          outgoingPrimary.toNode,
          targetSocket
        ),
        fromNode: incomingPrimary.fromNode,
        fromSocket: incomingPrimary.fromSocket,
        toNode: outgoingPrimary.toNode,
        toSocket: targetSocket,
      });
    }
  }

  const fallbackSelection =
    graph.selectedNodeId === nodeId
      ? nextNodes.find((item) => item.type === "viewer-output")?.id ?? nextNodes.at(-1)?.id ?? null
      : graph.selectedNodeId;
  const existingAfterRemove = new Set(nextNodes.map((item) => item.id));
  let nextSelectedIds = getSelectedNodeIds(graph).filter((id) => id !== nodeId && existingAfterRemove.has(id));
  if (nextSelectedIds.length === 0 && fallbackSelection && existingAfterRemove.has(fallbackSelection)) {
    nextSelectedIds = [fallbackSelection];
  }

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId: fallbackSelection,
    selectedNodeIds: nextSelectedIds,
  });
  if (getState().graphView.currentParentId === nodeId) {
    dispatch("graphView", { currentParentId: fallbackParentId });
  }
  if (before) pushGraphHistoryFromSnapshot(before, "Delete node");
  return true;
}

export function updateNodeParams(nodeId, patch) {
  const { graph } = getState();
  const nextNodes = graph.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    let nextParams = {
      ...node.params,
      ...patch,
    };
    if (node.type === "value" && Object.prototype.hasOwnProperty.call(patch, "value")) {
      nextParams = {
        ...nextParams,
        value: clampToBounds(Number(nextParams.value), getValueNodeOutputBounds(nodeId, graph)),
      };
    }
    return {
      ...node,
      params: nextParams,
    };
  });

  dispatch("graph", { nodes: nextNodes });
}

export function updateNodeLayerProperties(nodeId, patch) {
  const { graph } = getState();
  const nextNodes = graph.nodes.map((node) => {
    if (node.id !== nodeId || !isLayerAdjustableType(node.type)) return node;
    return {
      ...node,
      opacity: Object.prototype.hasOwnProperty.call(patch, "opacity")
        ? normalizeLayerProperty("opacity", patch.opacity)
        : node.opacity,
      hue: Object.prototype.hasOwnProperty.call(patch, "hue")
        ? normalizeLayerProperty("hue", patch.hue)
        : node.hue,
      saturation: Object.prototype.hasOwnProperty.call(patch, "saturation")
        ? normalizeLayerProperty("saturation", patch.saturation)
        : node.saturation,
    };
  });

  dispatch("graph", { nodes: nextNodes });
}

export function updateNodeLabel(nodeId, label, options = {}) {
  const { graph } = getState();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const node = getNodeById(nodeId, graph);
  const definition = getNodeDefinition(node?.type);
  if (!node || !definition) return false;

  const nextLabel = normalizeNodeLabel(label, definition.label);
  if (node.label === nextLabel) return false;

  dispatch("graph", {
    nodes: graph.nodes.map((item) =>
      item.id === nodeId
        ? {
            ...item,
            label: nextLabel,
          }
        : item
    ),
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Rename node");
  return true;
}

export function toggleNodeBypass(nodeId, options = {}) {
  const { graph } = getState();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  let changed = false;
  const nextNodes = graph.nodes.map((node) => {
    if (node.id !== nodeId || node.type === "source" || node.type === "viewer-output" || node.type === "group") {
      return node;
    }
    changed = true;
    return {
      ...node,
      bypassed: !node.bypassed,
    };
  });

  if (!changed) return false;
  dispatch("graph", { nodes: nextNodes });
  if (before) pushGraphHistoryFromSnapshot(before, "Toggle bypass");
  return true;
}

export function toggleNodeSolo(nodeId, options = {}) {
  if (!nodeId) return false;

  let graph = ensureBootGraph();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const activeSolo = normalizeSoloState(graph.solo);
  if (activeSolo) {
    const restoredEdges = restoreSoloEdges(graph, activeSolo);
    if (activeSolo.nodeId === nodeId) {
      dispatch("graph", {
        // refreshGroupMetadataForNodes returns a fresh array; passing
        // graph.nodes directly skips a JSON deep-clone of every node.
        nodes: refreshGroupMetadataForNodes(graph.nodes, restoredEdges),
        edges: restoredEdges,
        solo: null,
      });
      if (before) pushGraphHistoryFromSnapshot(before, "Toggle solo");
      return true;
    }
    graph = { ...graph, edges: restoredEdges, solo: null };
  }

  const node = getNodeById(nodeId, graph);
  const viewer = graph.nodes.find((item) => item.type === "viewer-output");
  if (!node || !viewer || node.id === viewer.id || node.type === "group") return false;

  const outputSocket = getPrimaryOutputSocket(node);
  const viewerInput = getPrimaryInputSocket(viewer);
  if (!outputSocket || !viewerInput) return false;
  if (!socketsCompatible(node, outputSocket, viewer, viewerInput)) return false;

  const previousEdges = graph.edges.filter(
    (edge) => edge.toNode === viewer.id && edge.toSocket === viewerInput
  );
  const baseEdges = graph.edges.filter(
    (edge) => !(edge.toNode === viewer.id && edge.toSocket === viewerInput)
  );
  if (wouldCreateCycle(node.id, viewer.id, baseEdges)) return false;

  const soloEdge = {
    id: createEdgeId(node.id, outputSocket, viewer.id, viewerInput),
    fromNode: node.id,
    fromSocket: outputSocket,
    toNode: viewer.id,
    toSocket: viewerInput,
  };
  const nextEdges = sanitizeEdges([...baseEdges, soloEdge], graph.nodes);
  if (!nextEdges.some((edge) => edge.id === soloEdge.id)) return false;

  dispatch("graph", {
    // See addEdge: refreshGroupMetadataForNodes is pure, no deep-clone needed.
    nodes: refreshGroupMetadataForNodes(graph.nodes, nextEdges),
    edges: nextEdges,
    solo: {
      nodeId: node.id,
      viewerNodeId: viewer.id,
      viewerInput,
      previousEdges: previousEdges.map((edge) => ({ ...edge })),
      soloEdgeId: soloEdge.id,
    },
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Toggle solo");
  return true;
}

export function getSoloNodeId(graph = getState().graph) {
  return normalizeSoloState(graph?.solo)?.nodeId ?? null;
}

export function setParamExposed(nodeId, paramKey, exposed, config = null, options = {}) {
  if (!nodeId || !paramKey) return false;
  const { graph } = getState();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  let changed = false;
  let removedSocket = false;

  const nextNodes = graph.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    // Refuse to expose a param that already has an explicit input socket on the
    // node — the existing socket is the real input, and exposing the param too
    // would render a second pin on the canvas.
    if (
      exposed &&
      Array.isArray(node.inputs) &&
      node.inputs.some((socket) => socket.name === paramKey)
    ) {
      return node;
    }
    const list = Array.isArray(node.exposedParams) ? [...node.exposedParams] : [];
    const nextConfig = { ...(node.exposedParamConfig ?? {}) };
    const has = list.includes(paramKey);
    if (exposed && !has) {
      list.push(paramKey);
      const bounds = normalizeBounds(config) ?? getNodeParamBounds(node, paramKey);
      if (bounds) nextConfig[paramKey] = bounds;
      changed = true;
    } else if (!exposed && has) {
      list.splice(list.indexOf(paramKey), 1);
      delete nextConfig[paramKey];
      changed = true;
      removedSocket = true;
    } else if (exposed && has) {
      const bounds = normalizeBounds(config);
      if (!bounds) return node;
      const current = normalizeBounds(nextConfig[paramKey]);
      if (current && current.min === bounds.min && current.max === bounds.max) return node;
      nextConfig[paramKey] = bounds;
      changed = true;
    } else {
      return node;
    }
    return { ...node, exposedParams: list, exposedParamConfig: nextConfig };
  });

  if (!changed) return false;

  const nextEdges = removedSocket
    ? graph.edges.filter(
        (edge) => !(edge.toNode === nodeId && edge.toSocket === paramSocketName(paramKey))
      )
    : graph.edges;

  dispatch("graph", {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Edit node sockets");
  return true;
}

export function toggleParamExposed(nodeId, paramKey, config = null) {
  const node = getNodeById(nodeId);
  if (!node) return false;
  const exposed = Array.isArray(node.exposedParams) && node.exposedParams.includes(paramKey);
  return setParamExposed(nodeId, paramKey, !exposed, config);
}

export function removeEdgesById(edgeIds, options = {}) {
  if (!Array.isArray(edgeIds) || edgeIds.length === 0) return false;
  const ids = new Set(edgeIds);
  const { graph } = getState();
  const before = options.history === false ? null : snapshotGraphForHistory(graph);
  const nextEdges = graph.edges.filter((edge) => !ids.has(edge.id));
  if (nextEdges.length === graph.edges.length) return false;
  dispatch("graph", {
    // See addEdge: refreshGroupMetadataForNodes is pure, no deep-clone needed.
    nodes: refreshGroupMetadataForNodes(graph.nodes, nextEdges),
    edges: nextEdges,
  });
  if (before) pushGraphHistoryFromSnapshot(before, "Disconnect nodes");
  return true;
}

export function replacePaletteUsages(removingId, fallbackId) {
  if (!removingId || !fallbackId || removingId === fallbackId) return false;

  const { graph } = getState();
  let changed = false;
  const nextNodes = graph.nodes.map((node) => {
    if (node.type !== "dither" || node.params?.palette !== removingId) return node;
    changed = true;
    return {
      ...node,
      params: {
        ...node.params,
        palette: fallbackId,
      },
    };
  });

  if (!changed) return false;
  dispatch("graph", { nodes: nextNodes });
  return true;
}

export function replaceGraph(nextGraph) {
  const normalized = normalizeGraph(nextGraph);
  dispatch("graph", normalized);
  return normalized;
}

export function serializeGraph(graph = getState().graph) {
  const persistedEdges = getPersistableGraphEdges(graph);
  const nodes = refreshGroupMetadataForNodes(graph.nodes, persistedEdges);
  return {
    nodes: nodes.map((node) => {
      const definition = getNodeDefinition(node.type);
      const payload = {
        id: node.id,
        type: node.type,
        parentId: getNodeParentId(node),
        x: node.x,
        y: node.y,
        params: clone(node.params),
        exposedParams: Array.isArray(node.exposedParams) ? [...node.exposedParams] : [],
        exposedParamConfig: clone(node.exposedParamConfig),
        bypassed: Boolean(node.bypassed),
      };
      if (isLayerAdjustableType(node.type)) {
        if (Number(node.opacity ?? NODE_LAYER_DEFAULTS.opacity) !== NODE_LAYER_DEFAULTS.opacity) {
          payload.opacity = normalizeLayerProperty("opacity", node.opacity);
        }
        if (Number(node.hue ?? NODE_LAYER_DEFAULTS.hue) !== NODE_LAYER_DEFAULTS.hue) {
          payload.hue = normalizeLayerProperty("hue", node.hue);
        }
        if (Number(node.saturation ?? NODE_LAYER_DEFAULTS.saturation) !== NODE_LAYER_DEFAULTS.saturation) {
          payload.saturation = normalizeLayerProperty("saturation", node.saturation);
        }
      }
      if (node.label && node.label !== definition?.label) payload.label = node.label;
      if (node.type === "group") payload.group = normalizeGroupMetadata(node.group);
      return payload;
    }),
    edges: persistedEdges.map((edge) => ({ ...edge })),
    selectedNodeId: graph.selectedNodeId,
    selectedNodeIds: getSelectedNodeIds(graph),
  };
}

export function getNodeById(nodeId, graph = getState().graph) {
  return graph.nodes.find((node) => node.id === nodeId) ?? null;
}

export function getSelectedNode(graph = getState().graph) {
  if (!graph.selectedNodeId) return null;
  return getNodeById(graph.selectedNodeId, graph);
}

export function getNodeConnections(nodeId, graph = getState().graph) {
  const inputs = graph.edges
    .filter((edge) => edge.toNode === nodeId)
    .map((edge) => {
      const fromNode = getNodeById(edge.fromNode, graph);
      return {
        edgeId: edge.id,
        socket: edge.toSocket,
        fromNodeId: edge.fromNode,
        fromNodeLabel: fromNode?.label ?? edge.fromNode,
        fromSocket: edge.fromSocket,
      };
    });

  const outputs = graph.edges
    .filter((edge) => edge.fromNode === nodeId)
    .map((edge) => {
      const toNode = getNodeById(edge.toNode, graph);
      return {
        edgeId: edge.id,
        socket: edge.fromSocket,
        toNodeId: edge.toNode,
        toNodeLabel: toNode?.label ?? edge.toNode,
        toSocket: edge.toSocket,
      };
    });

  return { inputs, outputs };
}

function normalizeGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return createBootGraph();
  }

  const nextNodes = graph.nodes
    .map((node) => {
      const definition = getNodeDefinition(node.type);
      if (!definition) return null;
      return createNode(node.id, node.type, {
        x: node.x,
        y: node.y,
        parentId: node.parentId,
        label: node.label,
        group: node.group,
        params: node.params,
        exposedParams: node.exposedParams,
        exposedParamConfig: node.exposedParamConfig,
        bypassed: node.bypassed,
        opacity: node.opacity,
        hue: node.hue,
        saturation: node.saturation,
      });
    })
    .filter(Boolean);

  if (!nextNodes.some((node) => node.type === "source")) {
    nextNodes.unshift(createNode("source-1", "source"));
  }
  if (!nextNodes.some((node) => node.type === "viewer-output")) {
    nextNodes.push(createNode("viewer-output-1", "viewer-output"));
  }
  normalizeNodeParents(nextNodes);

  const hasSerializedEdges = Array.isArray(graph.edges);
  const nextEdges = sanitizeEdges(graph.edges, nextNodes);
  const selectedNodeId = nextNodes.some((node) => node.id === graph.selectedNodeId)
    ? graph.selectedNodeId
    : nextNodes.at(-1)?.id ?? null;
  const selectedNodeIds = normalizeSelectedNodeIds(graph.selectedNodeIds, nextNodes, selectedNodeId);

  if (nextEdges.length === 0 && !hasSerializedEdges) {
    const chain = getLinearChain({ nodes: nextNodes, edges: [] });
    layoutLinearNodes(chain);
    const fallbackSelection = graph.selectedNodeId ?? chain.at(-1)?.id ?? null;
    return {
      nodes: chain,
      edges: buildLinearEdges(chain),
      selectedNodeId: fallbackSelection,
      selectedNodeIds: normalizeSelectedNodeIds(graph.selectedNodeIds, chain, fallbackSelection),
      solo: null,
    };
  }

  return {
    nodes: refreshGroupMetadataForNodes(nextNodes, nextEdges),
    edges: nextEdges,
    selectedNodeId,
    selectedNodeIds,
    solo: normalizeSoloState(graph.solo),
  };
}

function normalizeSelectedNodeIds(selectedNodeIds, nodes, fallbackId = null) {
  const existing = new Set(nodes.map((node) => node.id));
  const ids = Array.isArray(selectedNodeIds)
    ? [...new Set(selectedNodeIds)].filter((nodeId) => existing.has(nodeId))
    : [];
  if (ids.length > 0) return ids;
  return fallbackId && existing.has(fallbackId) ? [fallbackId] : [];
}

function getPersistableGraphEdges(graph) {
  const activeSolo = normalizeSoloState(graph?.solo);
  if (!activeSolo) return graph.edges.map((edge) => ({ ...edge }));
  return restoreSoloEdges(graph, activeSolo);
}

function restoreSoloEdges(graph, solo) {
  const viewerNodeId = solo.viewerNodeId;
  const viewerInput = solo.viewerInput;
  const baseEdges = graph.edges
    .filter((edge) => edge.id !== solo.soloEdgeId)
    .filter((edge) => !(edge.toNode === viewerNodeId && edge.toSocket === viewerInput))
    .map((edge) => ({ ...edge }));
  const restoredEdges = [...baseEdges, ...solo.previousEdges.map((edge) => ({ ...edge }))];
  return sanitizeEdges(restoredEdges, graph.nodes);
}

function normalizeSoloState(solo) {
  if (!solo || typeof solo !== "object") return null;
  const nodeId = typeof solo.nodeId === "string" ? solo.nodeId : "";
  const viewerNodeId = typeof solo.viewerNodeId === "string" ? solo.viewerNodeId : "";
  const viewerInput = typeof solo.viewerInput === "string" ? solo.viewerInput : "";
  const soloEdgeId = typeof solo.soloEdgeId === "string" ? solo.soloEdgeId : "";
  if (!nodeId || !viewerNodeId || !viewerInput || !soloEdgeId) return null;
  return {
    nodeId,
    viewerNodeId,
    viewerInput,
    soloEdgeId,
    previousEdges: Array.isArray(solo.previousEdges) ? solo.previousEdges.map((edge) => ({ ...edge })) : [],
  };
}

function normalizeNodeParents(nodes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    node.parentId = normalizeNodeParent(node, nodeById);
  }
}

function normalizeNodeParent(node, nodeById) {
  if (!node || isRootLockedType(node.type)) return ROOT_PARENT_ID;
  const parentId = normalizeParentId(node.parentId);
  if (parentId === ROOT_PARENT_ID) return ROOT_PARENT_ID;
  const parent = nodeById.get(parentId);
  if (!parent || parent.type !== "group" || parent.id === node.id) return ROOT_PARENT_ID;
  if (parentChainContainsNode(parentId, node.id, nodeById)) return ROOT_PARENT_ID;
  return parentId;
}

function parentChainContainsNode(parentId, nodeId, nodeById) {
  let current = parentId;
  const visited = new Set();
  while (current && current !== ROOT_PARENT_ID) {
    if (current === nodeId || visited.has(current)) return true;
    visited.add(current);
    const parent = nodeById.get(current);
    if (!parent) return false;
    current = normalizeParentId(parent.parentId);
  }
  return false;
}

function getGroupableSelectedNodes(graph, nodeIds = null) {
  const requested = Array.isArray(nodeIds) ? nodeIds : getSelectedNodeIds(graph);
  const seen = new Set();
  return requested
    .map((nodeId) => getNodeById(nodeId, graph))
    .filter((node) => {
      if (!node || seen.has(node.id) || isRootLockedType(node.type)) return false;
      seen.add(node.id);
      return true;
    });
}

function getNodesBounds(nodes) {
  return nodes.reduce(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      minY: Math.min(acc.minY, node.y),
      maxX: Math.max(acc.maxX, node.x + NODE_WIDTH),
      maxY: Math.max(acc.maxY, node.y + 108),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
}

function defaultGroupLabel(groupId) {
  const suffix = String(groupId).match(/(\d+)$/)?.[1];
  return suffix ? `Group ${suffix}` : "Group";
}

function refreshGroupMetadataForNodes(nodes, edges) {
  const graph = { nodes, edges };
  return nodes.map((node) => {
    if (node.type !== "group") return node;
    return {
      ...node,
      group: analyzeGroupBoundary(
        graph,
        new Set(nodes.filter((child) => getNodeParentId(child) === node.id).map((child) => child.id))
      ),
    };
  });
}

function analyzeGroupBoundary(graph, childIds) {
  const inputBindings = [];
  const outputBindings = [];
  const internalEdgeIds = [];

  for (const edge of graph.edges ?? []) {
    const fromInside = childIds.has(edge.fromNode);
    const toInside = childIds.has(edge.toNode);
    if (fromInside && toInside) {
      internalEdgeIds.push(edge.id);
    } else if (!fromInside && toInside) {
      inputBindings.push(createBoundaryBinding(edge));
    } else if (fromInside && !toInside) {
      outputBindings.push(createBoundaryBinding(edge));
    }
  }

  return normalizeGroupMetadata({ inputBindings, outputBindings, internalEdgeIds });
}

function createBoundaryBinding(edge) {
  return {
    edgeId: edge.id,
    fromNode: edge.fromNode,
    fromSocket: edge.fromSocket,
    toNode: edge.toNode,
    toSocket: edge.toSocket,
  };
}

function createNode(id, type, options = {}) {
  const definition = getNodeDefinition(type);
  if (!definition) throw new Error(`Unknown node type: ${type}`);
  const explicitInputs = new Set(definition.inputs.map((socket) => socket.name));
  const node = {
    id,
    type,
    parentId: isRootLockedType(type) ? ROOT_PARENT_ID : normalizeParentId(options.parentId),
    label: normalizeNodeLabel(options.label, definition.label),
    x: options.x ?? NODE_BASE_X,
    y: options.y ?? NODE_BASE_Y,
    inputs: definition.inputs.map((socket) => ({ ...socket })),
    outputs: definition.outputs.map((socket) => ({ ...socket })),
    params: normalizeNodeParams(type, definition.defaultParams, options.params),
    opacity: normalizeLayerProperty("opacity", options.opacity),
    hue: normalizeLayerProperty("hue", options.hue),
    saturation: normalizeLayerProperty("saturation", options.saturation),
    exposedParams: Array.isArray(options.exposedParams)
      ? options.exposedParams.filter((paramKey) => !explicitInputs.has(paramKey))
      : [],
    exposedParamConfig: clone(options.exposedParamConfig),
    bypassed: Boolean(options.bypassed),
  };

  if (type === "group") {
    node.group = normalizeGroupMetadata(options.group);
  }

  return node;
}

function isLayerAdjustableType(type) {
  return type !== "source" && type !== "viewer-output" && type !== "group";
}

function normalizeLayerProperty(key, value) {
  const bounds = NODE_LAYER_BOUNDS[key];
  const fallback = NODE_LAYER_DEFAULTS[key] ?? 0;
  const numeric = Number(value);
  const next = Number.isFinite(numeric) ? numeric : fallback;
  if (!bounds) return next;
  return Math.max(bounds.min, Math.min(bounds.max, next));
}

function normalizeNodeLabel(value, fallback) {
  const label = typeof value === "string" ? value.trim() : "";
  return label || fallback;
}

function createDuplicateLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  return label ? `${label} Copy` : "Node Copy";
}

function normalizeGroupMetadata(group) {
  return {
    inputBindings: normalizeGroupBindings(group?.inputBindings),
    outputBindings: normalizeGroupBindings(group?.outputBindings),
    internalEdgeIds: normalizeStringList(group?.internalEdgeIds),
  };
}

function normalizeGroupBindings(bindings) {
  if (!Array.isArray(bindings)) return [];
  return bindings
    .filter((binding) => binding && typeof binding === "object" && !Array.isArray(binding))
    .map((binding) => clone(binding));
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizeNodeParams(type, defaultParams, incomingParams) {
  const incoming = clone(incomingParams);
  if (type === "transform" && incoming && incoming.scale !== undefined) {
    if (incoming.x === undefined) incoming.x = incoming.scale;
    if (incoming.y === undefined) incoming.y = incoming.scale;
    delete incoming.scale;
  }
  // Halation: legacy projects stored tint as three 0–255 components
  // (tintR/tintG/tintB). The current model uses a single HEX string
  // (tintColor). Synthesise it from the legacy fields when no HEX is
  // present, then drop the old keys so they don't shadow the new one.
  if (type === "halation" && incoming) {
    const hasLegacy =
      incoming.tintR !== undefined ||
      incoming.tintG !== undefined ||
      incoming.tintB !== undefined;
    if (hasLegacy && incoming.tintColor === undefined) {
      incoming.tintColor = rgbToHex(
        incoming.tintR ?? 255,
        incoming.tintG ?? 120,
        incoming.tintB ?? 60
      );
    }
    if (incoming.tintColor !== undefined) {
      incoming.tintColor = normalizeHex(incoming.tintColor, "#ff783c");
    }
    delete incoming.tintR;
    delete incoming.tintG;
    delete incoming.tintB;
  }
  if (type === "gradient-map") {
    incoming.stops = normalizeGradientMapStops(
      incoming.stops,
      defaultParams.stops,
      incoming.shadowColor,
      incoming.highlightColor
    );
    delete incoming.shadowColor;
    delete incoming.highlightColor;
  }
  if (type === "gradient") {
    incoming.stops = normalizeGradientMapStops(incoming.stops, defaultParams.stops);
  }
  if (type === "scene-grade") {
    incoming.colorMapStops = normalizeGradientMapStops(
      incoming.colorMapStops,
      defaultParams.colorMapStops,
      incoming.colorMapShadow,
      incoming.colorMapHighlight
    );
    delete incoming.colorMapShadow;
    delete incoming.colorMapHighlight;
  }
  if (type === "mesh-gradient") {
    incoming.stops = normalizeMeshGradientStops(
      incoming.stops,
      defaultParams.stops,
      {
        colorA: incoming.colorA,
        colorB: incoming.colorB,
        colorC: incoming.colorC,
        colorD: incoming.colorD,
      }
    );
    delete incoming.colorA;
    delete incoming.colorB;
    delete incoming.colorC;
    delete incoming.colorD;
  }
  return {
    ...clone(defaultParams),
    ...incoming,
  };
}

function normalizeGradientMapStops(stops, fallbackStops, legacyShadow, legacyHighlight) {
  let source = stops;
  if (!Array.isArray(source) || source.length === 0) {
    source = [
      { pos: 0, color: legacyShadow ?? fallbackStops?.[0]?.color ?? "#111111" },
      { pos: 1, color: legacyHighlight ?? fallbackStops?.at?.(-1)?.color ?? "#ffffff" },
    ];
  }

  const normalized = source
    .map((stop) => ({
      pos: clamp01(Number(stop?.pos)),
      color: normalizeHex(stop?.color, "#ffffff"),
    }))
    .sort((a, b) => a.pos - b.pos);

  if (!normalized.length) {
    return clone(fallbackStops);
  }
  if (normalized.length === 1) {
    return [
      { pos: 0, color: normalized[0].color },
      { pos: 1, color: normalized[0].color },
    ];
  }
  if (normalized[0].pos > 0) {
    normalized.unshift({ pos: 0, color: normalized[0].color });
  }
  if (normalized.at(-1).pos < 1) {
    normalized.push({ pos: 1, color: normalized.at(-1).color });
  }
  return normalized;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export const MESH_GRADIENT_MAX_STOPS = 8;
const MESH_LEGACY_POS = [
  { x: 0.22, y: 0.28 },
  { x: 0.78, y: 0.28 },
  { x: 0.22, y: 0.72 },
  { x: 0.78, y: 0.72 },
];

function normalizeMeshGradientStops(rawStops, fallbackStops, legacyColors) {
  const fallback = Array.isArray(fallbackStops) && fallbackStops.length > 0
    ? fallbackStops
    : [{ x: 0.5, y: 0.5, radius: 0.6, color: "#ffffff" }];

  // Older projects stored four hex strings (colorA…D) instead of a stops
  // array. Synthesise the canonical 4-corner layout from them so existing
  // graphs keep their look after the schema swap.
  if (!Array.isArray(rawStops) || rawStops.length === 0) {
    const legacyHexes = [
      legacyColors?.colorA,
      legacyColors?.colorB,
      legacyColors?.colorC,
      legacyColors?.colorD,
    ];
    const hasLegacy = legacyHexes.some((h) => typeof h === "string" && h.length > 0);
    if (hasLegacy) {
      return legacyHexes.map((hex, i) => ({
        x: MESH_LEGACY_POS[i].x,
        y: MESH_LEGACY_POS[i].y,
        radius: 0.65,
        color: normalizeHex(hex, fallback[i % fallback.length]?.color ?? "#ffffff"),
      }));
    }
    return clone(fallback);
  }

  return rawStops
    .slice(0, MESH_GRADIENT_MAX_STOPS)
    .map((stop, i) => {
      const ref = fallback[i % fallback.length] ?? fallback[0];
      return {
        x: clamp01(Number(stop?.x)),
        y: clamp01(Number(stop?.y)),
        radius: Math.max(0.02, Math.min(2, Number(stop?.radius ?? ref.radius ?? 0.6))),
        color: normalizeHex(stop?.color, ref.color ?? "#ffffff"),
      };
    });
}

function getLinearChain(graph) {
  const source = graph.nodes.find((node) => node.type === "source");
  if (!source) return graph.nodes.map((node) => clone(node));

  const outgoing = new Map();
  for (const edge of graph.edges) {
    outgoing.set(edge.fromNode, edge.toNode);
  }

  const ordered = [];
  const visited = new Set();
  let current = source;

  while (current && !visited.has(current.id)) {
    ordered.push(clone(current));
    visited.add(current.id);
    const nextNodeId = outgoing.get(current.id);
    current = nextNodeId ? getNodeById(nextNodeId, graph) : null;
  }

  for (const node of graph.nodes) {
    if (!visited.has(node.id)) ordered.push(clone(node));
  }

  return ordered;
}

function getInsertionIndex(chain, type) {
  const newOrder = TYPE_ORDER[type] ?? Infinity;
  for (let index = 0; index < chain.length; index++) {
    const existingOrder = TYPE_ORDER[chain[index].type] ?? Infinity;
    if (existingOrder > newOrder) return index;
  }
  return chain.length;
}

function getMainChain(graph) {
  const viewer = graph.nodes.find((node) => node.type === "viewer-output");
  if (!viewer) return graph.nodes.map((node) => clone(node));

  const chain = [clone(viewer)];
  const visited = new Set([viewer.id]);
  let current = viewer;

  while (current) {
    const primary = getPrimaryInputSocket(current);
    if (!primary) break;
    const edge = graph.edges.find(
      (item) => item.toNode === current.id && item.toSocket === primary
    );
    if (!edge) break;
    const prev = getNodeById(edge.fromNode, graph);
    if (!prev || visited.has(prev.id)) break;
    chain.unshift(clone(prev));
    visited.add(prev.id);
    current = prev;
  }

  return chain;
}

function getPrimaryInputSocket(node) {
  return node.inputs?.[0]?.name ?? null;
}

function getPrimaryOutputSocket(node) {
  return node.outputs?.[0]?.name ?? null;
}

function normalizeParentId(parentId) {
  const value = typeof parentId === "string" ? parentId.trim() : "";
  return value || ROOT_PARENT_ID;
}

function isRootLockedType(type) {
  return type === "source" || type === "viewer-output";
}

function commonNodeParentId(a, b) {
  const parentA = getNodeParentId(a);
  const parentB = getNodeParentId(b);
  return parentA === parentB ? parentA : ROOT_PARENT_ID;
}

function getSocket(node, kind, socketName) {
  if (kind === "input" && isParamSocketName(socketName)) {
    return hasParamSocket(node, socketName)
      ? { name: socketName, label: socketName.slice("param:".length), type: "value" }
      : null;
  }
  const sockets = kind === "output" ? node?.outputs : node?.inputs;
  return sockets?.find((socket) => socket.name === socketName) ?? null;
}

function hasInputSocket(node, socketName) {
  if (isParamSocketName(socketName)) return hasParamSocket(node, socketName);
  return node.inputs.some((socket) => socket.name === socketName);
}

function isParamSocketName(socketName) {
  return typeof socketName === "string" && socketName.startsWith("param:");
}

function hasParamSocket(node, socketName) {
  if (!node || !isParamSocketName(socketName)) return false;
  const paramKey = socketName.slice("param:".length);
  return Array.isArray(node.exposedParams) && node.exposedParams.includes(paramKey);
}

function paramSocketName(paramKey) {
  return `param:${paramKey}`;
}

function socketType(socket) {
  return socket?.type ?? "image";
}

function isImageSocket(node, kind, socketName) {
  const socket = getSocket(node, kind, socketName);
  return Boolean(socket) && socketType(socket) === "image";
}

function socketsCompatible(fromNode, fromSocket, toNode, toSocket) {
  const from = getSocket(fromNode, "output", fromSocket);
  const to = getSocket(toNode, "input", toSocket);
  if (!from || !to) return false;
  const fromType = socketType(from);
  const toType = socketType(to);
  return fromType === toType;
}

function layoutMainChain(nodes, edges) {
  const chain = getMainChain({ nodes, edges });
  const chainIds = new Set(chain.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  chain.forEach((chainNode, index) => {
    const real = nodeById.get(chainNode.id);
    if (real) {
      real.x = NODE_BASE_X + index * NODE_SPACING_X;
      real.y = NODE_BASE_Y;
    }
  });

  let offChainIndex = 0;
  for (const node of nodes) {
    if (chainIds.has(node.id)) continue;
    node.x = NODE_BASE_X + offChainIndex * NODE_SPACING_X;
    node.y = NODE_BASE_Y + 160;
    offChainIndex += 1;
  }
}

function buildLinearEdges(nodes) {
  const edges = [];

  for (let index = 0; index < nodes.length - 1; index++) {
    const fromNode = nodes[index];
    const toNode = nodes[index + 1];
    if (!fromNode.outputs[0] || !toNode.inputs[0]) continue;
    if (!socketsCompatible(fromNode, fromNode.outputs[0].name, toNode, toNode.inputs[0].name)) {
      continue;
    }

    edges.push({
      id: createEdgeId(fromNode.id, fromNode.outputs[0].name, toNode.id, toNode.inputs[0].name),
      fromNode: fromNode.id,
      fromSocket: fromNode.outputs[0].name,
      toNode: toNode.id,
      toSocket: toNode.inputs[0].name,
    });
  }

  return edges;
}

function sanitizeEdges(edges, nodes) {
  if (!Array.isArray(edges)) return [];

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nextEdges = [];
  const occupiedInputs = new Set();

  for (const edge of edges) {
    const fromNode = nodeById.get(edge?.fromNode);
    const toNode = nodeById.get(edge?.toNode);
    if (!fromNode || !toNode || fromNode.id === toNode.id) continue;

    const fromSocket = edge.fromSocket;
    const toSocket = edge.toSocket;
    const hasOutput = fromNode.outputs.some((socket) => socket.name === fromSocket);
    const hasInput = hasInputSocket(toNode, toSocket);
    if (!hasOutput || !hasInput) continue;
    if (!socketsCompatible(fromNode, fromSocket, toNode, toSocket)) continue;

    const inputKey = `${toNode.id}:${toSocket}`;
    if (occupiedInputs.has(inputKey)) continue;
    if (wouldCreateCycle(fromNode.id, toNode.id, nextEdges)) continue;

    occupiedInputs.add(inputKey);
    nextEdges.push({
      id: edge.id || createEdgeId(fromNode.id, fromSocket, toNode.id, toSocket),
      fromNode: fromNode.id,
      fromSocket,
      toNode: toNode.id,
      toSocket,
    });
  }

  return nextEdges;
}

function layoutLinearNodes(nodes) {
  nodes.forEach((node, index) => {
    node.x = NODE_BASE_X + index * NODE_SPACING_X;
    node.y = NODE_BASE_Y;
  });
}

function nextNodeId(type, graph) {
  const prefix = type;
  let index = 1;
  while (graph.nodes.some((node) => node.id === `${prefix}-${index}`)) {
    index++;
  }
  return `${prefix}-${index}`;
}

function createEdgeId(fromNode, fromSocket, toNode, toSocket) {
  return `edge-${fromNode}-${fromSocket}-${toNode}-${toSocket}`;
}

function wouldCreateCycle(fromNodeId, toNodeId, edges) {
  const visited = new Set();
  const stack = [toNodeId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === fromNodeId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    for (const edge of edges) {
      if (edge.fromNode === currentId) {
        stack.push(edge.toNode);
      }
    }
  }

  return false;
}

function isPrimaryChainEdge(edge, graph) {
  if (!edge) return false;
  const fromNode = getNodeById(edge.fromNode, graph);
  const toNode = getNodeById(edge.toNode, graph);
  if (!fromNode || !toNode) return false;
  return (
    edge.fromSocket === getPrimaryOutputSocket(fromNode) &&
    edge.toSocket === getPrimaryInputSocket(toNode)
  );
}

function shiftPrimaryChainFromNode(nodes, edges, startNodeId, deltaX) {
  if (!startNodeId || !deltaX) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set();
  let current = nodeById.get(startNodeId);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    current.x += deltaX;

    const primaryOutput = getPrimaryOutputSocket(current);
    if (!primaryOutput) break;

    const nextEdge = edges.find((edge) => {
      const target = nodeById.get(edge.toNode);
      return (
        edge.fromNode === current.id &&
        edge.fromSocket === primaryOutput &&
        edge.toSocket === getPrimaryInputSocket(target)
      );
    });

    current = nextEdge ? nodeById.get(nextEdge.toNode) : null;
  }
}

function shiftPrimaryChainToNode(nodes, edges, startNodeId, deltaX) {
  if (!startNodeId || !deltaX) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set();
  let current = nodeById.get(startNodeId);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    current.x += deltaX;

    const primaryInput = getPrimaryInputSocket(current);
    if (!primaryInput) break;

    const prevEdge = edges.find((edge) => {
      const source = nodeById.get(edge.fromNode);
      return (
        edge.toNode === current.id &&
        edge.toSocket === primaryInput &&
        edge.fromSocket === getPrimaryOutputSocket(source)
      );
    });

    current = prevEdge ? nodeById.get(prevEdge.fromNode) : null;
  }
}

function spacePrimaryChainAroundNode(nodes, edges, leftNodeId, insertedNodeId, rightNodeId, options = {}) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const leftNode = nodeById.get(leftNodeId);
  const insertedNode = nodeById.get(insertedNodeId);
  const rightNode = nodeById.get(rightNodeId);
  if (!leftNode || !insertedNode || !rightNode) return;

  if (!options.preserveInserted) {
    insertedNode.x = midpoint(leftNode.x, rightNode.x);
    insertedNode.y = midpoint(leftNode.y, rightNode.y);
  }

  const desiredLeftX = insertedNode.x - NODE_WIDTH - NODE_INSERT_GAP_X;
  const leftOverlap = leftNode.x - desiredLeftX;
  if (leftOverlap > 0) {
    shiftPrimaryChainToNode(nodes, edges, leftNode.id, -leftOverlap);
  }

  const desiredRightX = insertedNode.x + NODE_WIDTH + NODE_INSERT_GAP_X;
  const rightOverlap = desiredRightX - rightNode.x;
  if (rightOverlap > 0) {
    shiftPrimaryChainFromNode(nodes, edges, rightNode.id, rightOverlap);
  }
}

function midpoint(a, b) {
  return (Number(a) + Number(b)) / 2;
}

function clampValueNodeForEdges(nodes, edges, valueNodeId) {
  const graph = { nodes, edges };
  const bounds = getValueNodeOutputBounds(valueNodeId, graph);
  if (!bounds) return nodes;

  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.id !== valueNodeId || node.type !== "value") return node;
    const nextValue = clampToBounds(Number(node.params?.value ?? 0), bounds);
    if (Object.is(nextValue, node.params?.value)) return node;
    changed = true;
    return {
      ...node,
      params: {
        ...node.params,
        value: nextValue,
      },
    };
  });

  return changed ? nextNodes : nodes;
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const min = Number(bounds.min);
  const max = Number(bounds.max);
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  if (!hasMin && !hasMax) return null;
  return {
    min: hasMin ? min : -Infinity,
    max: hasMax ? max : Infinity,
  };
}

function clampToBounds(value, bounds) {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (!bounds) return numeric;
  return Math.max(bounds.min, Math.min(bounds.max, numeric));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}
