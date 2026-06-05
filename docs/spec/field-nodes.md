# Field Nodes — Design

## What This Is

Caddis feature #2 ("parametric data patching") wants **fields**: spatial
influence sources (radial / linear / noise) whose value at a point drives a
parameter, modular-synth style. The scalar-patching half already works (`value`,
`math`, `audio-level` → `param:<key>` edges via `applyParamEdges`). This doc
designs the field half. It is the design pass the roadmap requires before code.

## The Core Question: What Point?

A field's value depends on *where* it is sampled. Two distinct uses, two node
shapes — keep them separate rather than overloading one node:

1. **Field → scalar (probe)** — sample the field at a single configurable point
   and output a scalar. Plugs into the existing value/param-edge system with zero
   new runtime surface (it is "just another scalar source", like `audio-level`).
   This is the cheap, deterministic, immediately-useful version. **Build first.**
2. **Field → image (map)** — render the field as a grayscale image (a per-pixel
   influence map) that feeds the existing image inputs (`displace.map`,
   `mask-apply.mask`, `gradient-map`). This reuses the procedural-source pattern
   (`gradient` / `noise` already output images) — no new socket category.

Per-pixel-drives-a-scalar (sampling a field at *every element's* position to drive
*its* param) is the ambitious third form; it needs the element/transform model
that does not exist yet, so it is explicitly out of scope here.

## Node 1: `field-probe` (scalar)

- Family Utility, `inputs: []`, `outputs: [{ name:"value", type:"value" }]`.
- Params: `shape` ("radial" | "linear-x" | "linear-y"), `centerX`, `centerY`
  (0..1), `sampleX`, `sampleY` (0..1), `radius` (0..2), `falloff` ("linear" |
  "smooth"), `invert` (bool), `gain`.
- Output (pure): radial → `v = clamp(1 - dist(sample, center)/radius, 0, 1)`;
  linear-x → ramp across X; smooth falloff → smoothstep. `invert` → `1 - v`;
  `× gain`. No `timeSeconds` dependency → not time-aware (animate via keyframes on
  the params, like any other node).
- Runtime: a `case "field-probe"` in `computeNodeOutput` returning the scalar.
  Mirrors `value` / `audio-level` exactly. Inspector: the params as range fields.

## Node 2: `field-map` (image) — second increment

- Family Input (procedural source, like `gradient` / `noise`).
  `inputs: []`, `outputs: [{ name:"image", type:"image" }]`.
- Params: `shape`, `centerX/Y`, `radius`, `angle`, `falloff`, `invert`, plus the
  output is sized to the composition like other procedural sources.
- Implementation: a CPU fill in `image-ops/` writing a grayscale gradient (radial
  / linear / noise) — closest analog is the existing `gradient` / `noise` nodes;
  copy that structure. A GPU path can follow where parity allows.

## Determinism / Parity

Both nodes are pure functions of their params (+ composition size for the map);
no wall-clock, no playback state. Preview and export evaluate the same graph →
identical. Field-probe is a scalar through the proven param-edge path; field-map
is an image through the proven procedural-source path. No new parity surface.

## Build Increments

1. **`field-probe`** — node def + runtime scalar case + inspector. Verify: the
   probe drives a param end-to-end (like the audio-level test: field value →
   `adjust.brightness` → output changes with `sampleX`/`radius`); determinism.
2. **`field-map`** — procedural image node + CPU fill + inspector. Verify: output
   pixels match the field math; feeds `displace`/`mask-apply`; preview == export.
3. **GPU `field-map`** (optional) — port the fill to the WebGL2 path with a
   CPU/GPU parity check.

## Why This Order

#1 is small, self-contained, and reuses the audio-level pattern verified this
cycle, so it ships value immediately. #2 reuses the gradient/noise procedural
pattern. The per-element form is deferred until an element model exists.
