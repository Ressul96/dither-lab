# Lens Flare Node

## Goal

Design a future `Lens Flare` node that fits Dither Lab's node-based compositor direction while
keeping the real rendering work on the native Rust side.

This is not intended to be an Optical Flares clone. The target is:
- same creative class
- modern architecture
- modular preset system
- native GPU-friendly processing
- future-ready animation and tracking model

## Integration Strategy

### Current reality

The current app still evaluates preview nodes in the frontend. That is fine for:
- `Adjust`
- `Dither`
- early graph UX
- short-term stabilization

### Target direction

The future `Lens Flare` node should not be implemented as frontend-only canvas logic.

Instead:
- the node editor stays in the frontend
- the inspector stays in the frontend
- preset browsing and asset browsing stay in the frontend
- frame processing moves into a native Rust render engine
- the frontend sends graph state, node params, time, and tracker bindings to Rust
- Rust resolves, renders, and composites the flare result

### Practical migration path

1. Stabilize the current app and finish the current graph UX.
2. Add a Rust-side render-engine crate/module boundary inside `src-tauri/src/engine`.
3. Move advanced effect nodes to the Rust engine one family at a time.
4. Keep simple nodes in the frontend temporarily if needed.
5. Converge preview and export onto the same Rust processor path for advanced nodes.

For lens flare specifically:
- preview can initially call a Rust processor per visible frame
- export should reuse the same processor path
- the node API should be stable even if the internal renderer evolves from CPU fallback to wgpu

## Node Contract

Suggested node:

- name: `Lens Flare`
- input:
  - `VideoFrame`
  - `SourcePosition` or `TrackerData`
  - optional `Mask`
  - optional `Time`
- output:
  - `VideoFrame`

Evaluation flow:

1. resolve current time
2. resolve source position from manual animation or tracker data
3. resolve preset
4. evaluate animated parameters for that frame
5. render flare objects in order
6. composite result over the input frame
7. return final frame

## Engine Split

### Frontend responsibilities

- node graph editing
- inspector editing
- preset browser
- asset browser
- timeline and keyframe UI
- tracker reference selection
- graph serialization

### Rust responsibilities

- frame texture ownership
- asset upload and caching
- flare object evaluation
- animated parameter evaluation at frame time
- tracker sample lookup and fallback logic
- render passes and compositing
- preview and export parity

## Data Model

Core types:

- `FlarePreset`
- `FlareObject`
- `FlareObjectKind`
- `TextureAssetRef`
- `GlassOverlay`
- `AnimationMod`
- `KeyframeTrack<T>`
- `AnimatedParameter<T>`
- `TrackerData`
- `SourceBinding`
- `BlendMode`

### Object kinds

MVP object kinds:
- `Glow`
- `Halo`
- `Ring`
- `Streak`
- `Ghost`
- `Orb`
- `Iris`
- `Caustic`
- `Smoke`
- `Secondary`
- `EdgeFlash`
- `GlassOverlay`

### Blend modes

Initial blend modes:
- `Add`
- `Screen`
- `Lighten`
- `SoftAdd`

### Animation mods

Initial animation mods:
- `Pulse`
- `Drift`
- `Flicker`
- `Rotate`
- `ScaleBreath`
- `Parallax`

## Rust Struct Direction

High-level Rust ownership split:

```text
engine/
├── node.rs
├── animation.rs
├── tracker.rs
└── lens_flare.rs
```

- `node.rs`: processor traits, frame handles, render context
- `animation.rs`: generic keyframe and animated parameter types
- `tracker.rs`: tracker samples, fallback, source binding
- `lens_flare.rs`: flare-specific preset, object, and processor structs

## Example Rust Shapes

```rust
pub struct LensFlareNode {
    pub node_id: String,
    pub enabled: bool,
    pub preset: FlarePreset,
    pub source_binding: SourceBinding,
    pub composite_mode: BlendMode,
    pub mask_input: Option<String>,
    pub tracker_input: Option<String>,
}

pub struct LensFlareInputs {
    pub frame: FrameTextureHandle,
    pub mask: Option<FrameTextureHandle>,
    pub tracker: Option<TrackerData>,
    pub time_override_seconds: Option<f64>,
}
```

The actual implementation should eventually separate:
- serializable node config
- runtime-resolved state
- GPU pipeline resources

## Preset Format

Recommended format:
- JSON first
- serde-deserializable
- artist-friendly
- explicit object list

Why JSON first:
- easiest to inspect and diff
- easy to edit manually while building the system
- easy to migrate to TOML or a custom preset editor later

### Example preset JSON

```json
{
  "version": 1,
  "id": "cinematic_blue_streak",
  "name": "Cinematic Blue Streak",
  "author": "Dither Lab",
  "global_intensity": 1.0,
  "objects": [
    {
      "id": "primary_glow",
      "kind": "glow",
      "enabled": true,
      "blend_mode": "screen",
      "opacity": 0.85,
      "scale": 1.2,
      "rotation_deg": 0.0,
      "axis_position": 0.0,
      "depth_factor": 0.0,
      "color": { "r": 0.85, "g": 0.92, "b": 1.0, "a": 1.0 }
    },
    {
      "id": "main_streak",
      "kind": "streak",
      "enabled": true,
      "blend_mode": "add",
      "opacity": 0.7,
      "scale": 1.6,
      "rotation_deg": 0.0,
      "axis_position": 0.0,
      "depth_factor": 0.15,
      "color": { "r": 0.5, "g": 0.75, "b": 1.0, "a": 1.0 },
      "animation_mods": [
        { "kind": "pulse", "amount": 0.12, "speed": 0.8, "phase": 0.0 }
      ]
    },
    {
      "id": "ghost_a",
      "kind": "ghost",
      "enabled": true,
      "blend_mode": "soft_add",
      "opacity": 0.45,
      "scale": 0.7,
      "rotation_deg": 12.0,
      "axis_position": -0.45,
      "depth_factor": 0.55,
      "color": { "r": 1.0, "g": 0.8, "b": 0.55, "a": 1.0 },
      "texture_ref": {
        "group": "elements",
        "path": "ghosts/soft_disc_01.png"
      }
    },
    {
      "id": "glass_overlay",
      "kind": "glass_overlay",
      "enabled": true,
      "blend_mode": "screen",
      "opacity": 0.22,
      "scale": 1.0,
      "rotation_deg": 0.0,
      "axis_position": 0.0,
      "depth_factor": 1.0,
      "texture_ref": {
        "group": "glass",
        "path": "grime/grime_01.png"
      }
    }
  ]
}
```

## Animation System

The keyframe system should be reusable outside lens flare.

Requirements:
- static values and animated values use one API
- support `linear`, `bezier`, and `hold`
- support normalized timeline and frame-based timeline
- support scalar, vector, and color values

Suggested model:

```text
AnimatedParameter<T>
├── Static(T)
└── Track(KeyframeTrack<T>)

KeyframeTrack<T>
├── timeline_domain
├── keyframes[]
└── fallback
```

Recommended domains:
- `Normalized`
- `Frames`
- `Seconds`

This lets the same system work for:
- editor timeline animation
- source-relative animation
- future reusable animation in other nodes

## Tracker Binding

Tracker should be treated as a data source, not hard-coded node internals.

Recommended binding modes:
- manual only
- tracker only
- hybrid tracker plus manual fallback

Suggested tracker model:
- `tracker_id`
- time-indexed samples
- normalized screen position
- confidence
- visibility or validity flag
- fallback behavior

Fallback options:
- hold last valid sample
- blend to manual animated source
- snap to manual source
- hide flare when tracking confidence collapses

This keeps the system open for:
- point tracking
- bright spot tracking
- planar tracking
- future timeline links

## Render Pipeline

### MVP render flow

1. get input frame texture
2. resolve source position
3. allocate or reuse flare accumulation target
4. render each flare object into the flare target
5. composite flare target over the frame
6. return output texture

### Important performance rules

- avoid CPU readback during preview
- keep frame surfaces on GPU where possible
- cache uploaded flare textures
- group object rendering by pipeline shape where practical
- reuse intermediate textures
- separate low-frequency overlays from per-object hot passes

## wgpu Organization

Recommended pipeline split:

### 1. Object generation pipelines

Procedural object families:
- glow
- halo
- ring
- streak
- orb
- edge flash

These can use:
- simple fullscreen or quad draw pipelines
- object uniforms
- source-position uniforms
- preset and animation uniforms

### 2. Texture-backed object pipelines

Texture-backed families:
- ghost
- iris
- caustic
- smoke
- glass overlay

These can use:
- quad rendering
- texture sampling
- per-object transform
- blend-state variants

### 3. Composite pipeline

One compositing pass to apply:
- additive-like modes
- screen
- soften or lighten variants
- optional mask influence

### 4. Optional helper passes

Later:
- threshold extraction
- occlusion mask
- blur pyramid
- dirt and grime accumulation
- HDR-aware highlight extraction

### Shader file direction

```text
src-tauri/src/engine/shaders/
├── flare_common.wgsl
├── flare_procedural.wgsl
├── flare_textured.wgsl
├── flare_composite.wgsl
└── flare_overlay.wgsl
```

## Asset Strategy

Current texture source folder:
- `Optical Flares Textures/Elements`
- `Optical Flares Textures/Glass`

Recommended future normalization:
- import or mirror those into an internal asset registry
- expose stable logical paths in presets
- decouple artist-facing preset references from raw absolute filesystem paths

Suggested logical groups:
- `elements`
- `glass`
- later:
  - `dirt`
  - `caustics`
  - `smoke`
  - `custom`

## MVP Scope

The first implementation should stay intentionally small.

### MVP goals

- one `Lens Flare` node
- one manual source
- one preset at a time
- no custom preset editor yet
- no multi-source
- no true occlusion
- no HDR-only path yet
- no planar tracking yet

### MVP object support

- `Glow`
- `Halo`
- `Ring`
- `Streak`
- `Ghost`
- `GlassOverlay`

### MVP animation support

- static parameters
- linear keyframes
- hold keyframes
- manual source animation
- tracker input with fallback to manual

## Later Features

Natural follow-ups after MVP:
- multi-source support
- threshold-based auto source detection
- bright spot tracker node
- point tracker node integration
- preset editor UI
- custom asset browser
- HDR and tone-aware flare intensity
- occlusion and luminance masking
- chromatic aberration per object
- depth or parallax layers
- timeline-driven modulation tracks
- reusable animation system for other advanced nodes

## Recommended Execution Order

1. finish current stabilization work
2. finish current core node UX and `Phase D`
3. introduce Rust-side render engine boundary
4. define serializable preset and animation types
5. build texture asset registry
6. add no-op or passthrough `Lens Flare` node config to the graph
7. implement manual-source MVP flare in Rust
8. connect preview to native processor
9. connect export to the same processor
10. add tracker binding

## Summary

The key architectural decision is simple:

- lens flare should be a normal graph node in the UI
- lens flare should be a native Rust processor in the engine
- animation and tracking should be modeled generally enough to reuse later
- preview and export should evaluate the same native effect path
