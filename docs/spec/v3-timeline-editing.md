# V3 Timeline Editing

## Goal

V3 adds a clip-based, multi-track timeline editor on top of the V2 node graph. The product gains
non-linear editing — multiple sources arranged in time, cut and rearranged like a small NLE — while
keeping Dither Lab's identity as a graph-driven dither and compositor tool.

This is not Premiere. It is the minimum cut/arrange surface needed so a user can:
- drop several video clips on a track
- trim, split, and ripple-delete them
- arrange audio alongside video
- export the resulting cut with the same dither/effect graph applied

The node graph and the existing parameter-animation system stay intact. V3 extends the surface
sideways; it does not replace what already works.

## Inspiration

OpenCut (https://github.com/opencut-app/opencut, MIT) is the reference for timeline UX and edit
operations. We read its source freely but do not port its stack — OpenCut is Next.js + TypeScript
+ Bun + GPUI (desktop); we stay on vanilla JS + Tauri + Canvas/WebGL as required by the project's
non-negotiables. Concepts (track, clip, ripple, slip, magnet) port; code does not.

## Naming — Two Kinds of "Track"

The codebase already uses `track` for keyframe parameter animation in [timeline.js](../../src/js/timeline.js).
V3 introduces a second, structurally different kind of track. They must not be confused.

- **Parameter Track** — existing. A list of keyframes bound to a node param or node property
  (`node-param`, `node-property`). Drives animation of dither/effect parameters over time. Stays in
  `state.timeline.tracks`.
- **Media Track** — new in V3. Holds an ordered list of media clips on a single lane (one video
  lane, one audio lane, etc.). Drives **what source content exists** at a given time. Lives in a
  new `state.composition` slice.

When the spec or UI says "track" without qualifier, it means Media Track. Parameter tracks are
referenced explicitly.

## Scope For First Ship

In-scope:
- multi-track clip arrangement: one or more video Media Tracks, one or more audio Media Tracks
- per-clip in-point and out-point (non-destructive trim within a source)
- razor / split at playhead
- ripple delete and ripple trim
- drag to reorder clips on a track
- magnetic snap to clip edges, playhead, and ruler ticks
- ruler with zoom in/out
- preview composites the active clip(s) at the playhead through the existing node graph
- export walks the full composition timeline frame-by-frame through the same graph
- per-clip enable/disable
- one undoable history with the existing F17 atomic-drag pattern

Explicitly deferred (Non-Goals):
- transitions (cross-fade, dip-to-black) — needs a render-time blend pass; revisit after MVP works
- per-clip independent node graphs (each clip carrying its own effect chain)
- nested compositions / sub-sequences
- adjustment-layer style "effect tracks" that apply to ranges instead of clips
- audio waveform analysis, level meters, sample-accurate audio editing
- speed ramps, time remapping, reverse
- multi-camera angles
- title generator, text tool, sticker tool
- magnetic timeline with auto-reflow (FCPX style); we do classic layered timeline first

## Layout Impact

V2 layout stays:

```
File  Edit  View  Window
┌───────────────┬───────────────────┬──────────────────┐
│ Source/Tools  │ Stage / Preview   │ Inspector        │
│               ├───────────────────┤                  │
│               │ Node Editor       │                  │
├───────────────┴───────────────────┴──────────────────┤
│ Player Card: scrub, play, step, FPS, compare         │
└───────────────────────────────────────────────────────┘
```

V3 promotes the bottom Player Card area into a resizable Timeline Panel that contains both:

- the transport row (existing scrubber, play, step, FPS, compare — unchanged controls)
- the new tracks area (Media Tracks above, Parameter Tracks collapsed beneath the same time axis)

```
┌───────────────────────────────────────────────────────┐
│ Stage / Preview                                       │
├───────────────────────────────────────────────────────┤
│ Node Editor                                           │
├───────────────────────────────────────────────────────┤
│ Timeline Panel  ── ruler ── playhead ── snap ──       │
│ V1  ▭▭▭▭▭▭▭▭───▭▭▭▭▭▭▭▭▭▭▭▭▭▭                      │
│ V2  ─────▭▭▭▭▭▭▭▭───────────────────                  │
│ A1  ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭                          │
│ ───── Parameter Tracks (collapsible) ─────            │
│ ▶ dither.threshold  ◆──────◆────────◆                 │
└───────────────────────────────────────────────────────┘
```

Rules:
- ruler, zoom, and playhead are shared by both Media and Parameter tracks
- Media Tracks are always visible when the panel is open; Parameter Tracks collapse
- the panel keeps the user's height across sessions
- the existing minimised state (F22 backlog) still applies

## Data Model

New state slice: `state.composition`. Serialized inside the project file under a new top-level
`composition` key, version-bumped.

```jsonc
{
  "composition": {
    "version": 1,
    "duration": 0,                  // computed from clip extents
    "fps": 30,                      // composition fps; clips can have their own source fps
    "tracks": [
      {
        "id": "vt-1",
        "kind": "video",            // "video" | "audio"
        "name": "V1",
        "enabled": true,
        "muted": false,
        "locked": false,
        "clips": [
          {
            "id": "clip-1",
            "sourceId": "src-1",    // reference into composition.sources
            "start": 0.0,           // timeline position, seconds
            "duration": 3.5,        // visible duration
            "in": 1.2,              // in-point within source
            "out": 4.7,             // out-point within source
            "enabled": true
          }
        ]
      }
    ],
    "sources": [
      {
        "id": "src-1",
        "path": "/abs/path/clip.mp4",
        "kind": "video",
        "duration": 12.0,
        "fps": 29.97,
        "width": 1920,
        "height": 1080,
        "hasAudio": true
      }
    ]
  }
}
```

Invariants:
- `in + (duration adjusted by speed) <= source.duration` — out-points clamp to source extents
- clips on a track may not overlap; gaps are allowed
- `composition.duration` = max(clip.start + clip.duration) across all tracks
- source records are reference-counted; orphan sources are pruned on save

## Edit Operations

All operations route through a single `composition` reducer for undoability and consistency.

| Operation     | Trigger                  | Behavior                                                                 |
|---------------|--------------------------|--------------------------------------------------------------------------|
| Add clip      | drag media → track       | inserts clip; snaps to nearest edge; refuses overlap                      |
| Trim head     | drag clip left edge      | adjusts `start` and `in`; clamps to source.in floor and neighbor edge     |
| Trim tail     | drag clip right edge     | adjusts `duration` and `out`; clamps to source.out ceiling                |
| Split         | razor tool / `S` at head | replaces clip with two clips sharing source; sets `in/out` at split point |
| Move          | drag clip body           | adjusts `start`; refuses overlap; snaps                                    |
| Ripple delete | `Shift+Delete`           | removes clip; downstream clips on same track shift left by deleted span   |
| Ripple trim   | `Alt+drag` edge          | trims and shifts downstream clips by the trim delta                       |
| Slip          | `Alt+drag` body          | changes `in/out` without moving `start` or `duration`                      |
| Slide         | `Cmd+drag` body          | moves clip and adjusts neighbors so the timeline length is unchanged       |
| Enable        | per-clip checkbox        | clip is skipped during playback/export but its slot is preserved          |

Snapping targets, in order of priority:
1. playhead
2. neighbor clip edges (within same track)
3. clip edges on adjacent tracks
4. ruler ticks at current zoom

Snap threshold scales inversely with zoom so it stays ~6 px on screen.

## Integration With Node Graph

The graph stays unchanged structurally. The `Source` node becomes **composition-aware**:

- At any time `t`, the source resolver asks the composition: "which video clip is active on which
  Media Track at `t`, and what is its in-point?"
- For each active video clip, the resolver provides a decoded frame to the graph as
  `Source.image`.
- The graph evaluates as today; `Viewer Output` collects the result.

First-ship rule: **one active video track at a time**. If multiple video Media Tracks are present,
the top-most enabled track wins. Layering / blending across video tracks is deferred until we have
transitions, because both need the same compositing pass.

The Parameter Track system (`state.timeline`) keeps animating node parameters by absolute
composition time. Parameter keyframes are not clip-relative in V3 — they live on the same timeline
as clips. Per-clip parameter automation can be added later if needed.

## Audio

Audio Media Tracks are independent of the node graph. The graph processes video only.

- Preview: mix the active audio clips through Web Audio API at the playhead. Per-track mute/solo,
  per-clip enable. No per-clip gain in MVP.
- Export: ffmpeg sidecar receives the timeline plan and assembles audio with `-filter_complex`
  using `concat` + `amix`. If a video clip has embedded audio and the user has not added a separate
  audio track, the embedded audio plays through. If both exist, the explicit audio track wins on
  that range (no auto-mix).

## Preview/Export Parity

The non-negotiable from CLAUDE.md still holds: **export must match preview**.

For V3 this means:
- the export pipeline walks `composition.duration * fps` frames; for each, it resolves the active
  clip exactly as preview does, seeks the underlying `<video>` to `in + (t - clip.start)`, and runs
  the graph
- the existing `seekForExport` and frame-cache rules apply per source element; the export pipeline
  may need to keep multiple `<video>` elements warm if clips reference different sources back to
  back
- if a clip is disabled or a track is muted in preview, it must be absent from export

The existing F22 export sheet gets a new Range option:
- "Full Composition" (replaces "Full Video" when a composition exists)
- "In/Out range" (uses composition-level in/out markers; trim handles move into ruler)
- "Selected clip" (exports just the selected clip's timeline span)

## Performance Notes

- Multiple `<video>` elements increase memory and decoder pressure. Pool them: keep at most N=2-3
  warmed elements, recycle by LRU based on which source is most likely to be needed next (current
  and next clip on each active track).
- Frame cache key already includes `sourceFrameKey` per element; extend it with source id so caches
  do not collide when two clips reuse the same source at different in-points.
- Drag operations on clips must not rebuild the node graph; clip edits dirty only the composition
  state. Re-evaluation of the current frame is enough.

## Rollout

Phased, mirroring V2's pattern. Each phase ships independently.

### Phase A — Composition State

- add `state.composition` slice with the data model above
- read/write composition in project save/load (`project.js`)
- backward compat: projects without `composition` get a single video Media Track with the existing
  source as one clip spanning its full duration

### Phase B — Single-Track Read-Only Timeline

- render a Media Track lane in the timeline panel with clip rectangles
- ruler and playhead drive composition time, not source time
- preview pulls the active clip's source frame into the existing graph
- export uses the composition's frame count; no edit operations yet

### Phase C — Core Edit Operations

- add clip from source browser (drag-drop onto track)
- trim head/tail
- split at playhead
- move clip with snap
- ripple delete
- undo/redo via existing F17 pattern

### Phase D — Multi-Track + Audio

- add a second video track and the top-wins resolver
- add audio Media Tracks with Web Audio preview
- ffmpeg `-filter_complex` plan for audio export
- per-track mute/solo

### Phase E — Polish

- slip, slide, ripple trim
- zoomable ruler with mouse-wheel + pinch
- magnet toggle (`N`)
- marker support (deferred from F-backlog)

Transitions, per-clip graphs, and nested compositions are out of scope for V3 entirely and would
become V4 work.

## Open Questions

These should be resolved during Phase A design, not now:

- How does the inspector show clip parameters vs node parameters when a clip is selected?
- Do we surface a "Composition" node in the graph (representing the resolved frame at time t) or
  keep composition resolution implicit in the `Source` node?
- What is the minimum project schema bump number, and how do we migrate F23/F24 projects?
- Should the timeline panel's height persist per project or globally?
