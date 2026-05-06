# Shader Ingestion Plan

This is the working intake plan for Shader Lab and Effect.app inspired effects.

## Architecture

- Keep Dither Lab's graph, project format, Tauri shell, and export pipeline as the source of truth.
- Use WebGL2 for fast preview ports where it is the shortest path.
- Promote expensive or export-critical nodes to Rust/wgpu once their behavior is proven.
- Keep Shader Lab's React/WebGPU runtime as a reference harness, not as the default app runtime.

## Timeline

- Timeline data is node-targeted, not layer-targeted.
- Tracks bind to `nodeId + node-param` or `nodeId + node-property`.
- Preview and export both evaluate the same timeline at the current media time.
- Shader Lab style `duration`, `loop`, `tracks`, `binding`, and `keyframes` map into this model.
- UI playback, keyframe positions, stage frame labels, and render evaluation share one frame clock.
- Scrubbing and keyframe movement snap to the active timeline FPS instead of using arbitrary percentage time.
- Shader Lab `layerId` imports map to our `nodeId` during adaptation; the editor UI is rebuilt locally to avoid pulling in React/Three/WebGPU runtime coupling.

## Required Effect Targets

Shader Lab first-pass targets:

- CRT
- Halftone
- ASCII
- Chromatic Aberration
- Bloom
- Dithering
- Pixelation
- Posterize
- Threshold
- Displacement Map
- Fluted Glass

Effect.app must not be forgotten. The `effects` and `distort` categories are required target catalogs:

- VHS
- NTSC
- CRT Screen
- Star Glow
- LED Screen
- RGB Shift
- Modulation
- Stripe
- Reeded Glass
- Elastic Grid
- Ripple
- Swirl
- Pinch
- Glitch
- Perspective
- Cubify

## Port Order

1. Timeline model and keyframe evaluator.
2. Effect target manifests.
3. GPU pass interface.
4. CRT, Halftone, and Bloom/Chromatic Aberration as anchor ports.
5. Effect.app effects/distort gap fill.
6. Rust/wgpu promotion for performance-critical and export-critical nodes.
