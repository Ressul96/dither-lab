# Blender Compositor Nodes — Port Plan for Dither Lab

Reference clone (sparse-checkout, 3.6 MB):
- `/tmp/blender-nodes/source/blender/nodes/composite/nodes/`
- 87 node `.cc` files, each self-contained: declares sockets + CPU/GPU impl.

Each Blender node tends to follow this shape, which maps cleanly onto our
`src/js/image-ops.js` / graph-runtime model:

```cpp
// 1. socket declaration: defines params + default/min/max
static void node_declare(NodeDeclarationBuilder &b) {
  b.add_input<decl::Color>("Image");
  b.add_input<decl::Float>("Steps").default_value(8.0f).min(2.0f).max(1024.0f);
  b.add_output<decl::Color>("Image");
}

// 2. CPU function: usually one math expression per pixel
static float4 posterize(const float4 &color, const float steps) {
  return float4(math::floor(color.xyz() * steps) / steps, color.w);
}
```

So a port = read the math, translate to a per-pixel JS loop in
`image-ops.js`, expose params via `src/js/inspector.js` UI, register the node
type in `src/js/graph.js` and `src/js/graph-runtime.js`.

---

## Tier 1 — Cheap wins (1 math line each, port in < 1 hr per node)

These are pure per-pixel functions with no kernels. Drop them straight into
`image-ops.js` next to `applyAdjustNode`.

| Node | Math | Use for dithering |
|---|---|---|
| **Posterize** | `floor(c * steps) / steps` | Color quantization before dither — defines the palette steps without a custom palette. |
| **Exposure** | `c * 2^stops` | Photographic exposure compensation; pairs with tone-map. |
| **Invert** | `1 - c` | Inversion before/after dither for negative looks. |
| **RGB to BW** | `luminance = 0.2126*r + 0.7152*g + 0.0722*b` | Force greyscale before 1-bit dither. |
| **Set Alpha** | `vec4(rgb, alpha)` | Mask compositing. |
| **Alpha Convert** | premultiplied ↔ straight | Required for clean compositing. |

**Where to add:** [src/js/image-ops.js](../../src/js/image-ops.js) — new
`applyXNode(image, params)` returning a buffer-pool canvas; mirror existing
`applyAdjustNode` shape so caching/buffer pool plug in for free.

---

## Tier 2 — Medium effort (separable kernels or stateful CPU loops)

These need a bounded-size loop or a separable filter. Still pure CPU, no GPU
needed.

| Node | Description | Why we want it |
|---|---|---|
| **Pixelate** | block-quantize positions: `texel/N * N` | Chunky pre-processing for retro looks. |
| **Brightness/Contrast** | `(c - 0.5) * contrast + 0.5 + brightness` | Already partially in adjust, but Blender's ranges and semantics are nicer. |
| **Hue/Saturation/Value** | RGB ↔ HSV ↔ RGB with three offsets | Color grading control before dither. |
| **Tone Map** | Reinhard `c / (c + 1)` or photographic | HDR → LDR before dither makes huge gradients dither-friendly. |
| **Lens Distortion** | barrel/pincushion via radial polynomial | Distort node currently has limited modes. |
| **Filter (sharpen/soften/edge)** | 3x3 convolution with preset kernels | Edge enhancement before dither preserves line art. |
| **RGB Curves** | per-channel piecewise-linear LUT | Most flexible color tool. Inspector UI is the work, not the math. |
| **Color Balance** | lift/gamma/gain three-way grade | Industry-standard grading; replaces a chain of adjusts. |
| **Bilateral Blur** | edge-preserving Gaussian variant | Smooths flat areas without losing edges — classic preprocessing for art-style dither. |

**Where to add:** still `image-ops.js` for the math; new inspector blocks for
the more parametric ones (Curves, Color Balance need bezier/wheel widgets).

---

## Tier 3 — Heavy lift but very high payoff for stylized output

These are real algorithms, not one-liners. Each is a 200-700 line file in
Blender. Worth it for a small set of these once we're past phase B.

| Node | What it does | Effort | Payoff |
|---|---|---|---|
| **Glare** | bloom + ghosts + streaks + fog glow | ~600 lines, separable + Fourier paths | Replaces our basic `glow` with cinematic bloom. |
| **Kuwahara** (anisotropic) | painterly edge-preserving filter | ~500 lines, structure-tensor + summed area tables | Stylized painterly look, pairs beautifully with palette dither. |
| **Defocus** | depth-of-field bokeh blur | ~400 lines, hexagonal bokeh kernel | Selective focus — blocked unless we add a depth source though. |
| **Vector Blur** | motion blur from velocity field | ~700 lines, needs motion vectors | Same — needs a depth/motion source. |
| **Denoise** | OIDN integration | external dep | Cleans noisy footage before dither. |
| **Anti-aliasing** | SMAA-style | ~300 lines | Quality preservation through scaling. |
| **Inpaint** | hole filling | ~400 lines | Mask → fill workflows. |
| **Despeckle** | salt/pepper noise removal | ~150 lines | Cleanup pass. |

**Decision:** start with Glare and Kuwahara — these directly affect the
stylized look the dithering targets.

---

## Tier 4 — Probably not worth porting (3D pipeline-specific)

These exist in Blender to handle render-engine output that we don't have:

- Render Layers, Image Info, Strip Info, Cryptomatte, Track Position,
  Plane Track Deform, Stabilize 2D, Switch View, Movie Distortion
- Channel/Chroma/Color/Difference/Distance/Luminance Key — keying nodes
  built around render passes; we can keep our own simpler Mix node.

---

## Suggested next-session order

1. **Posterize** — 30 min, immediately useful next to dither.
2. **Exposure** + **RGB to BW** — 30 min combined, finish the Tier 1 cluster.
3. **Pixelate** — 1 hr, gives chunky retro pre-processing.
4. **HSV** — 1-2 hr including inspector UI for hue wheel.
5. **Tone Map** — 1 hr.
6. Decide: Curves vs Color Balance next based on what the user reaches for
   while grading.
7. **Glare** — half-day, replaces Glow with the real thing.
8. **Kuwahara classic** — half-day, painterly look.

Each port lands as a separate small commit so we can revert without losing
the rest. Buffer pool + memoization + adaptive playback already cover
performance for these new nodes — no per-node perf work needed.

---

## Notes on translation

- Blender uses linear-light float colors; our pipeline uses 8-bit sRGB
  ImageData. For per-pixel ops the math is identical; for color grading
  (Color Balance, Curves, HSV) we should consider whether to convert to
  linear, do the op, convert back. For a first pass keep it sRGB-domain
  since the user's reference is the sRGB displayed image.
- Blender's `parallel_for(size, [&](int2 texel) { ... })` is just a row/col
  loop; our `Uint8ClampedArray` indexed by `(y * w + x) * 4` is the JS
  equivalent.
- Ignore the `execute_gpu` / `node_gpu_material` paths — those are GLSL
  compositor shaders that we'd only need if we add a WebGL backend later
  (and at that point they're also a great reference).
