# Responsive / Auto-Layout — Design

## What This Is

Caddis feature #6: composition elements bind to the composition bounds
(proportionally / by anchor) and reflow when the output aspect changes
(16:9 → 9:16).

**Reality check (verified in code and at two output sizes).** The original
premise of this doc — "the geometry nodes use absolute pixel params" — is wrong.
The `transform` node's `translateX/Y` are a **percentage of the frame measured
from the center** (`ctx.translate(width/2 + (translateX/100)*width, …)` in
`image-ops/transform.js`), and scale (`x`/`y`) and crop insets are percentages
too. So full-frame content **already reflows proportionally** when the output
aspect changes — confirmed by rendering `translateX=50` at 384×216 and 216×384
and seeing the boundary land at frame center in both. The *proportional* half of
this feature already ships. What is genuinely missing is the **anchor** half
(pin to a corner/edge instead of center), and that is only meaningful for
*discrete elements*, not a full-frame transform — which needs an element model
the app does not have yet. The increments below are re-scoped around that.

## What Already Exists

- The viewer/export already know the composition size (`source.videoWidth/Height`,
  the viewer-output target), so the *input* to a layout solve exists.
- `transform` translate (`translateX/Y`, −100..100) is a **percentage of the
  frame from center**, and scale (`x`/`y`) is a percentage — both already reflow
  proportionally when the frame size changes (confirmed at 384×216 vs 216×384).
- `crop` uses percentage insets (`left/right/top/bottom`), also already relative.

So the *proportional* indirection already exists for the transform node. What is
missing is **anchor choice** (measure a param from a corner/edge, not center) and
an optional **px (absolute, non-reflowing) unit** — both of which only pay off
once there is a discrete element model to anchor. Forcing a `{value, unit,
anchor}` layer onto the transform node today would *conflict* with its existing
proportional-from-center semantics and could not honour a "default px =
byte-identical" rule (the default is already pct, not px).

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

Re-scoped after the reality check. The proportional reflow this feature wanted
already ships via the transform node's percentage params, so there is **no
non-speculative increment to build against the current node set** — the remaining
responsive work is gated on a discrete element model (positioned sub-frame
layers). Without it, "anchor to a corner" and "px vs %" have no element to apply
to and would only bolt a conflicting unit layer onto a node whose params are
already proportional.

Deferred until an element model exists:

1. **Anchored element params** — `resolveAnchoredParam(meta, outW, outH, axis)`
   (pure) + `{value, unit, anchor}` on *element* position/size, resolved at the
   render chokepoint (the `resolveGraphTokens` precedent) so both render paths
   and export agree. The default mirrors today's proportional-from-center
   behavior so existing projects stay byte-identical.
2. **Inspector** — px/% toggle + 3×3 anchor grid per element.
3. **Constraint solver** — inter-element relations (A.right = B.left).

Shippable in isolation later (small, non-breaking) if a use case appears: an
explicit `anchor` dropdown on the transform node that moves the translate origin
off center. Left unbuilt here because, for full-frame content, center-anchored
proportional translate already covers the headline reflow and a corner anchor has
no discrete element to pin.

## Risks

- **Scope creep into a constraint solver.** The anchor model (each param resolves
  independently) covers the headline 16:9 → 9:16 reflow without a solver. Resist
  building inter-element constraints until an element model exists.
- **Per-param meta shape** must serialize cleanly in the project payload; keep it a
  plain `{value, unit, anchor}` object so `serializeGraph` handles it for free.
