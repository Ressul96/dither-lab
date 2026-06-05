# Responsive / Auto-Layout — Design

## What This Is

Caddis feature #6: composition elements bind to the composition bounds
(proportionally / by anchor) and reflow when the output aspect changes
(16:9 → 9:16). Today the geometry nodes (`transform`, `crop`, `scale`) use
absolute pixel params, so changing the output size does not reposition anything.
This doc designs the anchor/constraint layer. It is the design pass the roadmap
requires before code; no code is implied by writing it.

## What Already Exists

- The viewer/export already know the composition size (`source.videoWidth/Height`,
  the viewer-output target), so the *input* to a layout solve exists.
- Geometry nodes (`transform` = translate/rotate/scale, `crop`, `scale`) consume
  absolute params at eval time in `image-ops/` via `graph-runtime`.

What is missing is the *indirection*: a way to express a param as a fraction of
the output, plus an anchor, resolved against the current dimensions.

## Model: Anchored Params

Add optional **anchor/units metadata** to geometry-producing node params, resolved
at eval time against the current output size:

- A position/size param may be `{ value, unit, anchor }`:
  - `unit`: `"px"` (today's behavior, default) | `"pct"` (fraction of the relevant
    output dimension).
  - `anchor`: `"top-left" | "center" | "top-right" | …` — the origin the value is
    measured from (so a "16px from the right edge" element stays pinned on reflow).
- Resolution (pure): `resolveAnchoredParam(meta, outputW, outputH, axis)` →
  absolute px. Runs in `graph-runtime` just before a geometry node evaluates,
  exactly like `resolveGraphTokens` resolves color refs at the render chokepoint —
  so both render paths and export see the same resolved geometry.

Backward compatibility: a bare number stays `px` from the existing origin →
existing projects are byte-identical. Only params that opt into `{unit:"pct",
anchor}` reflow.

## Reflow

"Reflow on aspect change" then falls out for free: changing the viewer-output
size re-runs the render; anchored params resolve against the new dimensions, so
elements reposition proportionally. No separate layout-solve pass is needed for
the anchor model (each param resolves independently). A true constraint solver
(element A right-edge = element B left-edge) is a later, larger step and needs the
element model fields/`per-clip-graphs` would also want.

## UI

- Geometry inspectors gain a small unit toggle (px / %) and an anchor picker per
  position/size param (a 3×3 anchor grid, like design tools).
- Default stays px/top-left so the controls are opt-in and unobtrusive.

## Determinism / Parity

`resolveAnchoredParam` is a pure function of the param meta + output size. Preview
and export use the same output size and the same resolver → identical geometry.
No wall-clock, no playback state.

## Build Increments

1. **Resolver + model** — `resolveAnchoredParam` (pure) + accept `{value, unit,
   anchor}` on `transform` translate/scale params; resolve at the render
   chokepoint. Default px → zero behavior change. Verify: pct/anchor resolves
   correctly at two output sizes; bare numbers unchanged; preview == export.
2. **Inspector** — px/% toggle + anchor grid on the transform node. Verify: toggle
   round-trips, reflow on output-size change.
3. **More geometry nodes** — extend to `crop` / `scale`; later a constraint solver
   (needs an element model — deferred).

## Risks

- **Scope creep into a constraint solver.** The anchor model (each param resolves
  independently) covers the headline 16:9 → 9:16 reflow without a solver. Resist
  building inter-element constraints until an element model exists.
- **Per-param meta shape** must serialize cleanly in the project payload; keep it a
  plain `{value, unit, anchor}` object so `serializeGraph` handles it for free.
