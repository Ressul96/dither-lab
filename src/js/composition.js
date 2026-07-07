// Composition model — the multi-track clip timeline (v3).
//
// This is the data layer only: pure, DOM-free functions that normalize,
// serialize, and query a composition. It is the structural sibling of
// timeline.js (parameter keyframes) — the two coexist on the same time axis
// but model different things:
//   * timeline.js  → WHAT a node parameter is at time t (keyframes)
//   * composition  → WHAT source content exists at time t (media clips)
//
// Ship 1 is read-only at the UI level; this module already returns a multi-clip
// active set (getActiveClips) and carries per-track blend/opacity + per-clip
// graphId so the later compositing / per-clip-graph phases extend rather than
// rewrite it. The renderer in Ship 1 only consumes the top-most active clip.
//
// Determinism: every query here is a pure function of (composition, time).
// No wall-clock, no DOM, no module state — preview and export call the same
// resolver and therefore stay in parity.

import { timeToFrame, frameToTime } from "./timeline.js";

export const COMPOSITION_VERSION = 1;

const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 120;

// Local copy of timeline.js's (non-exported) fps clamp, kept byte-identical to
// that one (same constants + round-then-clamp order) so clips snap to the exact
// same frame grid the keyframe timeline uses — required for preview/export parity.
function clampFps(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return DEFAULT_FPS;
  return Math.max(MIN_FPS, Math.min(MAX_FPS, numeric));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampMin(value, min, fallback) {
  const n = num(value, fallback);
  return n < min ? min : n;
}

// ---------- id generation ----------

// Deterministic, collision-checked id within a set of existing ids. Mirrors
// graph.js nextNodeId so saved compositions keep stable, readable ids.
function nextId(prefix, existing) {
  let i = 1;
  while (existing.has(`${prefix}-${i}`)) i++;
  const id = `${prefix}-${i}`;
  existing.add(id);
  return id;
}

// ---------- normalize ----------

export function normalizeComposition(raw, options = {}) {
  const fps = clampFps(raw?.fps ?? options.fps ?? DEFAULT_FPS);

  const sources = normalizeSources(raw?.sources);
  const sourceIds = new Set(sources.map((s) => s.id));

  const tracks = Array.isArray(raw?.tracks)
    ? raw.tracks.map((track, index) => normalizeTrack(track, index, sourceIds, fps))
    : [];

  const composition = {
    version: COMPOSITION_VERSION,
    fps,
    tracks,
    sources,
    duration: 0,
  };
  composition.duration = compositionDuration(composition);
  return composition;
}

function normalizeSources(rawSources) {
  if (!Array.isArray(rawSources)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawSources) {
    if (!raw || typeof raw.id !== "string" || seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push({
      id: raw.id,
      path: typeof raw.path === "string" ? raw.path : "",
      kind: raw.kind === "audio" ? "audio" : "video",
      duration: clampMin(raw.duration, 0, 0),
      fps: clampFps(raw.fps ?? DEFAULT_FPS),
      width: Math.max(0, Math.round(num(raw.width, 0))),
      height: Math.max(0, Math.round(num(raw.height, 0))),
      hasAudio: Boolean(raw.hasAudio),
    });
  }
  return out;
}

function normalizeTrack(raw, index, sourceIds, fps) {
  const kind = raw?.kind === "audio" ? "audio" : "video";
  return {
    id: typeof raw?.id === "string" ? raw.id : `${kind === "audio" ? "at" : "vt"}-${index + 1}`,
    kind,
    name: typeof raw?.name === "string" && raw.name.trim()
      ? raw.name
      : `${kind === "audio" ? "A" : "V"}${index + 1}`,
    enabled: raw?.enabled !== false,
    muted: Boolean(raw?.muted),
    locked: Boolean(raw?.locked),
    // Compositing-ready (Ship 1 writes/persists but does not render these).
    blendMode: typeof raw?.blendMode === "string" ? raw.blendMode : "normal",
    opacity: clampOpacity(raw?.opacity),
    clips: Array.isArray(raw?.clips)
      ? raw.clips
          .map((clip) => normalizeClip(clip, sourceIds, fps))
          .filter(Boolean)
          .sort((a, b) => a.start - b.start)
      : [],
  };
}

function clampOpacity(value) {
  const n = num(value, 100);
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

function normalizeClip(raw, sourceIds, fps) {
  if (!raw || typeof raw.sourceId !== "string") return null;
  // Drop clips whose source is not present (orphan prune). A clip with no valid
  // source can never resolve to pixels, so it is dropped even when the source
  // list is empty.
  if (!sourceIds.has(raw.sourceId)) return null;

  const start = clampMin(raw.start, 0, 0);
  const duration = clampMin(raw.duration, 0, 0);
  const inPoint = clampMin(raw.in, 0, 0);
  // out defaults to in + duration when absent so a freshly-made clip is valid.
  const outPoint = raw.out === undefined || raw.out === null
    ? inPoint + duration
    : clampMin(raw.out, inPoint, inPoint + duration);

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    sourceId: raw.sourceId,
    start: snapToFrame(start, fps),
    duration: snapToFrame(duration, fps),
    in: snapToFrame(inPoint, fps),
    out: snapToFrame(outPoint, fps),
    enabled: raw.enabled !== false,
    // Per-clip effect chain (later phase). null = use the shared global graph.
    graphId: typeof raw.graphId === "string" ? raw.graphId : null,
  };
}

function snapToFrame(seconds, fps) {
  return frameToTime(timeToFrame(seconds, fps), fps);
}

// ---------- queries (pure) ----------

// composition.duration = max(clip.start + clip.duration) across all tracks.
export function compositionDuration(composition) {
  let max = 0;
  for (const track of composition?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const end = clip.start + clip.duration;
      if (end > max) max = end;
    }
  }
  return max;
}

// Resolve which clips are active at composition time `t`. Returns an array
// ordered top-most first (later tracks paint over earlier ones, so the last
// track in the array is visually on top → we reverse to put it first). Each
// entry carries the in-source time so the renderer can seek.
//
// Ship 1 renders only result[0] (the top-most enabled video clip). The full
// list is returned so the compositing phase consumes it without an API change.
export function getActiveClips(composition, timeSeconds) {
  if (!composition?.tracks?.length) return [];
  const t = num(timeSeconds, 0);
  const active = [];

  for (const track of composition.tracks) {
    if (!track.enabled) continue;
    const clip = clipAtTime(track, t);
    if (!clip) continue;
    active.push({
      track,
      clip,
      // Time inside the source file: in-point + offset into the clip.
      sourceTime: clip.in + (t - clip.start),
    });
  }

  // Top-most first: tracks later in the array sit on top in a layer stack.
  active.reverse();
  return active;
}

function clipAtTime(track, t) {
  for (const clip of track.clips ?? []) {
    if (!clip.enabled) continue;
    if (t >= clip.start && t < clip.start + clip.duration) return clip;
  }
  return null;
}

// Convenience for the renderer: the single clip Ship 1 shows at time t.
export function getActiveVideoClip(composition, timeSeconds) {
  const active = getActiveClips(composition, timeSeconds);
  for (const entry of active) {
    if (entry.track.kind === "video") return entry;
  }
  return null;
}

export function getSourceById(composition, sourceId) {
  return composition?.sources?.find((s) => s.id === sourceId) ?? null;
}

// Active video clips at time t in BOTTOM-to-top paint order, for compositing.
// getActiveClips returns top-most first; compositing paints the base first and
// upper layers over it, so reverse. Each entry is { track, clip, sourceTime } —
// the track carries blendMode/opacity, the clip's sourceTime says where to seek.
export function getCompositingLayers(composition, timeSeconds) {
  return getActiveClips(composition, timeSeconds)
    .filter((entry) => entry.track.kind === "video")
    .reverse();
}

// Playback helpers (pure) — the source.js play tick crosses clip boundaries with
// these. They return { track, clip, sourceTime } shaped like getActiveClips so
// the caller can seek the right element to the clip's in-point.

// The first enabled video clip on the timeline (smallest start). Where playback
// begins / loops back to. Null when there are no video clips.
export function firstVideoClip(composition) {
  let best = null;
  for (const track of composition?.tracks ?? []) {
    if (track.kind !== "video" || !track.enabled) continue;
    for (const clip of track.clips ?? []) {
      if (!clip.enabled) continue;
      if (!best || clip.start < best.clip.start) best = { track, clip, sourceTime: clip.in };
    }
  }
  return best;
}

// The next enabled video clip to roll to after `clipId`: the one with the
// smallest start strictly greater than the current clip's start. Null at the end
// of the timeline. Sequential, non-overlapping clips advance in order; gaps are
// skipped (the playhead jumps to the next clip's start).
export function nextVideoClipAfter(composition, clipId) {
  let currentStart = null;
  for (const track of composition?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.id === clipId) currentStart = clip.start;
    }
  }
  if (currentStart == null) return null;
  let best = null;
  for (const track of composition?.tracks ?? []) {
    if (track.kind !== "video" || !track.enabled) continue;
    for (const clip of track.clips ?? []) {
      if (!clip.enabled) continue;
      if (clip.start > currentStart && (!best || clip.start < best.clip.start)) {
        best = { track, clip, sourceTime: clip.in };
      }
    }
  }
  return best;
}

// ---------- edit reducers (pure) ----------
//
// Each reducer takes a composition + an edit and returns a NEW normalized
// composition (or the same object when the edit is a no-op). They never mutate
// input and never touch state/DOM — the UI layer (player-media-clip-drag.js)
// wraps them with dispatch + a single history entry. All times snap to the
// composition's frame grid so preview/export stay frame-exact.

// Smallest editable duration: one frame. Prevents zero/negative-length clips.
function frameStep(fps) {
  return 1 / clampFps(fps);
}

function findTrackAndClip(composition, trackId, clipId) {
  const track = composition?.tracks?.find((t) => t.id === trackId) ?? null;
  const clip = track?.clips?.find((c) => c.id === clipId) ?? null;
  return { track, clip };
}

// Map a track's clips, replacing the clip matching clipId via `fn`. `fn` returns
// a single clip or an array (split → two clips). Returns a fresh normalized
// composition. Re-normalization re-sorts clips by start and recomputes duration.
function mapClip(composition, trackId, clipId, fn) {
  if (!composition?.tracks?.length) return composition;
  let changed = false;
  const tracks = composition.tracks.map((track) => {
    if (track.id !== trackId) return track;
    const clips = [];
    for (const clip of track.clips ?? []) {
      if (clip.id !== clipId) {
        clips.push(clip);
        continue;
      }
      const result = fn(clip, track);
      changed = true;
      if (Array.isArray(result)) clips.push(...result);
      else if (result) clips.push(result);
    }
    return { ...track, clips };
  });
  if (!changed) return composition;
  return normalizeComposition({ ...composition, tracks });
}

// The free interval a clip may occupy on its track without overlapping the
// neighbours that sit immediately before/after it (by start order). Used to
// clamp move and trim so clips never overlap. Returns { min, max } in seconds;
// max is Infinity when there is no following clip.
function neighbourBounds(track, clipId) {
  const clips = [...(track?.clips ?? [])].sort((a, b) => a.start - b.start);
  const index = clips.findIndex((c) => c.id === clipId);
  const prev = index > 0 ? clips[index - 1] : null;
  const next = index >= 0 && index < clips.length - 1 ? clips[index + 1] : null;
  return {
    prevEnd: prev ? prev.start + prev.duration : 0,
    nextStart: next ? next.start : Infinity,
  };
}

// Move a clip to a new absolute start. Clamps to >= prevEnd and so the clip's
// end stays <= nextStart (no overlap). Duration/in/out unchanged.
export function moveClip(composition, { trackId, clipId, start }) {
  const { track, clip } = findTrackAndClip(composition, trackId, clipId);
  if (!track || !clip) return composition;
  const fps = composition.fps;
  const { prevEnd, nextStart } = neighbourBounds(track, clipId);
  const maxStart = nextStart === Infinity ? Infinity : nextStart - clip.duration;
  let nextStartTime = snapToFrame(Math.max(0, start), fps);
  nextStartTime = Math.max(prevEnd, nextStartTime);
  if (maxStart !== Infinity) nextStartTime = Math.min(maxStart, nextStartTime);
  if (nextStartTime < prevEnd) nextStartTime = prevEnd; // degenerate guard
  if (nextStartTime === clip.start) return composition;
  return mapClip(composition, trackId, clipId, (c) => ({ ...c, start: nextStartTime }));
}

// Trim the head (left edge). Moving the edge right shortens the clip and pulls
// its in-point forward; left lengthens it. start + in move together so the same
// source frame stays under the edge. Clamps: in >= 0, start >= prevEnd, and at
// least one frame of duration remains.
export function trimClipStart(composition, { trackId, clipId, start }) {
  const { track, clip } = findTrackAndClip(composition, trackId, clipId);
  if (!track || !clip) return composition;
  const fps = composition.fps;
  const step = frameStep(fps);
  const { prevEnd } = neighbourBounds(track, clipId);
  const clipEnd = clip.start + clip.duration;
  let nextStart = snapToFrame(start, fps);
  // Can't pull in-point below 0: limit how far left the edge can travel.
  const minStartFromIn = clip.start - clip.in;
  nextStart = Math.max(nextStart, prevEnd, minStartFromIn);
  // Keep at least one frame.
  nextStart = Math.min(nextStart, clipEnd - step);
  const delta = nextStart - clip.start;
  if (delta === 0) return composition;
  return mapClip(composition, trackId, clipId, (c) => ({
    ...c,
    start: nextStart,
    in: snapToFrame(c.in + delta, fps),
    duration: snapToFrame(c.duration - delta, fps),
  }));
}

// Trim the tail (right edge). Adjusts duration + out together. Clamps: out <=
// source.duration, end <= nextStart (no overlap), at least one frame remains.
export function trimClipEnd(composition, { trackId, clipId, end }) {
  const { track, clip } = findTrackAndClip(composition, trackId, clipId);
  if (!track || !clip) return composition;
  const fps = composition.fps;
  const step = frameStep(fps);
  const { nextStart } = neighbourBounds(track, clipId);
  const source = getSourceById(composition, clip.sourceId);
  let nextEnd = snapToFrame(end, fps);
  // out can't exceed the source length.
  if (source && source.duration > 0) {
    const maxEnd = clip.start + (source.duration - clip.in);
    nextEnd = Math.min(nextEnd, maxEnd);
  }
  if (nextStart !== Infinity) nextEnd = Math.min(nextEnd, nextStart);
  nextEnd = Math.max(nextEnd, clip.start + step);
  const nextDuration = snapToFrame(nextEnd - clip.start, fps);
  if (nextDuration === clip.duration) return composition;
  return mapClip(composition, trackId, clipId, (c) => ({
    ...c,
    duration: nextDuration,
    out: snapToFrame(c.in + nextDuration, fps),
  }));
}

// Split a clip at absolute time `time`. Produces two clips sharing the source:
// left [start..time], right [time..end]. The right clip's in-point advances by
// the left clip's duration so the same frames play across the cut. No-op when
// the time is outside the clip interior.
export function splitClip(composition, { trackId, clipId, time }) {
  const { track, clip } = findTrackAndClip(composition, trackId, clipId);
  if (!track || !clip) return composition;
  const fps = composition.fps;
  const step = frameStep(fps);
  const splitTime = snapToFrame(time, fps);
  // Must leave at least one frame on each side.
  if (splitTime <= clip.start + step / 2) return composition;
  if (splitTime >= clip.start + clip.duration - step / 2) return composition;

  const leftDuration = snapToFrame(splitTime - clip.start, fps);
  const existingIds = new Set();
  for (const t of composition.tracks ?? []) {
    for (const c of t.clips ?? []) existingIds.add(c.id);
  }
  const rightId = nextId("clip", existingIds);

  return mapClip(composition, trackId, clipId, (c) => {
    const left = {
      ...c,
      duration: leftDuration,
      out: snapToFrame(c.in + leftDuration, fps),
    };
    const right = {
      ...c,
      id: rightId,
      start: splitTime,
      duration: snapToFrame(c.duration - leftDuration, fps),
      in: snapToFrame(c.in + leftDuration, fps),
      out: c.out,
    };
    return [left, right];
  });
}

// Register a new source (a loaded media file) in the composition. Returns
// { composition, sourceId }. No clips are created — addClip places them.
export function addSource(composition, source) {
  const base = composition ?? createDefaultComposition();
  const existing = new Set((base.sources ?? []).map((s) => s.id));
  const id = typeof source?.id === "string" && !existing.has(source.id)
    ? source.id
    : nextId("src", existing);
  const sources = [...(base.sources ?? []), { ...source, id }];
  const next = normalizeComposition({ ...base, sources });
  return { composition: next, sourceId: id };
}

// Append a new empty video track on top of the stack. Returns the new
// composition (normalized). The track has no clips — drag a source onto its
// lane to populate it.
export function addVideoTrack(composition) {
  const base = composition ?? createDefaultComposition();
  const tracks = base.tracks ?? [];
  const id = nextId("vt", new Set(tracks.map((t) => t.id)));
  const videoCount = tracks.filter((t) => t.kind === "video").length;
  const track = {
    id,
    kind: "video",
    name: `V${videoCount + 1}`,
    enabled: true,
    blendMode: "normal",
    opacity: 100,
    clips: [],
  };
  return normalizeComposition({ ...base, tracks: [...tracks, track] });
}

// Update a track's compositing props (opacity, blendMode, enabled, name).
// Returns a new normalized composition, or the same one when the track is
// missing. normalizeTrack clamps the values.
export function updateTrack(composition, { trackId, patch } = {}) {
  const tracks = composition?.tracks ?? [];
  if (!patch || !tracks.some((t) => t.id === trackId)) return composition;
  const nextTracks = tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t));
  return normalizeComposition({ ...composition, tracks: nextTracks });
}

// Set (or clear) a clip's per-clip effect graph reference. `graphId` null means
// the clip uses the shared global graph (the default). Pure; returns the same
// composition object when nothing changes. The actual graph clone lives in the
// clip-graph registry — this reducer only flips the reference on the clip.
export function setClipGraphId(composition, { trackId, clipId, graphId = null } = {}) {
  const tracks = composition?.tracks ?? [];
  const track = tracks.find((t) => t.id === trackId);
  const clip = track?.clips?.find((c) => c.id === clipId);
  if (!clip || (clip.graphId ?? null) === (graphId ?? null)) return composition;
  const nextTracks = tracks.map((t) =>
    t.id !== trackId
      ? t
      : {
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, graphId: graphId ?? null } : c
          ),
        }
  );
  return normalizeComposition({ ...composition, tracks: nextTracks });
}

// Add a clip for `sourceId` to a track. `start` defaults to the end of the
// track (append). Duration defaults to the source's full length. If the chosen
// start would overlap an existing clip, the clip is pushed to the first free
// slot at/after that start so clips never overlap (matches moveClip's rule).
export function addClip(composition, { trackId, sourceId, start, duration } = {}) {
  const base = composition ?? createDefaultComposition();
  const track = base.tracks?.find((t) => t.id === trackId);
  const source = getSourceById(base, sourceId);
  if (!track || !source) return composition;

  const fps = base.fps;
  const clipDuration = snapToFrame(
    duration != null ? Math.max(frameStep(fps), duration) : Math.max(frameStep(fps), source.duration || 0),
    fps
  );
  if (!(clipDuration > 0)) return composition;

  // Desired start: explicit, else append after the last clip on the track.
  const trackEnd = track.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
  let desired = snapToFrame(start != null ? Math.max(0, start) : trackEnd, fps);
  desired = findFreeSlot(track, desired, clipDuration, fps);

  const existingIds = new Set();
  for (const t of base.tracks ?? []) for (const c of t.clips ?? []) existingIds.add(c.id);
  const clipId = nextId("clip", existingIds);

  const newClip = {
    id: clipId,
    sourceId,
    start: desired,
    duration: clipDuration,
    in: 0,
    out: clipDuration,
    enabled: true,
    graphId: null,
  };
  const tracks = base.tracks.map((t) =>
    t.id === trackId ? { ...t, clips: [...t.clips, newClip] } : t
  );
  return normalizeComposition({ ...base, tracks });
}

// First start >= desired where a clip of `duration` fits without overlapping an
// existing clip on the track. Walks the sorted clips, jumping past each one the
// candidate would collide with.
function findFreeSlot(track, desired, duration, fps) {
  const clips = [...(track.clips ?? [])].sort((a, b) => a.start - b.start);
  let start = desired;
  for (const c of clips) {
    const cEnd = c.start + c.duration;
    // Overlap if the candidate interval [start, start+duration) intersects [c.start, cEnd).
    if (start < cEnd && c.start < start + duration) {
      start = snapToFrame(cEnd, fps);
    }
  }
  return start;
}

// Remove a clip, leaving a gap where it sat (other clips keep their start).
export function removeClip(composition, { trackId, clipId }) {
  const { track, clip } = findTrackAndClip(composition, trackId, clipId);
  if (!track || !clip) return composition;
  const tracks = composition.tracks.map((t) => {
    if (t.id !== trackId) return t;
    return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
  });
  return normalizeComposition({ ...composition, tracks });
}

// Ripple-delete a clip: remove it and pull every later clip on the SAME track
// left by the removed clip's duration, closing the gap. Clips on other tracks
// are untouched (classic layered ripple, not a global timeline ripple).
export function rippleDeleteClip(composition, { trackId, clipId }) {
  const { track, clip } = findTrackAndClip(composition, trackId, clipId);
  if (!track || !clip) return composition;
  const fps = composition.fps;
  const gap = clip.duration;
  const removedStart = clip.start;
  const tracks = composition.tracks.map((t) => {
    if (t.id !== trackId) return t;
    const clips = t.clips
      .filter((c) => c.id !== clipId)
      .map((c) =>
        c.start > removedStart
          ? { ...c, start: snapToFrame(Math.max(0, c.start - gap), fps) }
          : c
      );
    return { ...t, clips };
  });
  return normalizeComposition({ ...composition, tracks });
}

// ---------- snap ----------
//
// Snap a candidate time to the nearest interesting target within `threshold`
// seconds (the caller converts ~6px-at-current-zoom into seconds). Priority:
// playhead, then neighbouring clip edges on every track (excluding the dragged
// clip), then the frame grid. Pure.
export function snapClipTime(composition, time, options = {}) {
  const { excludeClipId = null, playheadTime = null, threshold = 0, fps } = options;
  const candidate = num(time, 0);
  const grid = snapToFrame(candidate, fps ?? composition?.fps ?? DEFAULT_FPS);
  if (!(threshold > 0)) return grid;

  let best = grid;
  let bestDist = Math.abs(candidate - grid);

  const consider = (target) => {
    if (target === null || target === undefined) return;
    const dist = Math.abs(candidate - target);
    if (dist <= threshold && dist < bestDist) {
      best = target;
      bestDist = dist;
    }
  };

  if (playheadTime !== null) consider(playheadTime);
  for (const track of composition?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.id === excludeClipId) continue;
      consider(clip.start);
      consider(clip.start + clip.duration);
    }
  }
  return best;
}

// ---------- factory + migration ----------

export function createDefaultComposition(overrides = {}) {
  return normalizeComposition({
    version: COMPOSITION_VERSION,
    fps: overrides.fps ?? DEFAULT_FPS,
    tracks: [],
    sources: [],
    ...overrides,
  });
}

// Backward-compat: turn a single loaded source (the pre-v3 model) into a
// one-track / one-clip composition spanning the source's full duration. Called
// on source load and on opening a project that predates the composition slice.
export function compositionFromSource(source) {
  if (!source || !source.loaded || !(source.duration > 0)) {
    return createDefaultComposition({ fps: source?.fps });
  }
  const fps = clampFps(source.fps ?? source.sourceFps ?? DEFAULT_FPS);
  const sourceId = "src-1";
  return normalizeComposition({
    version: COMPOSITION_VERSION,
    fps,
    sources: [
      {
        id: sourceId,
        path: source.path ?? "",
        kind: "video",
        duration: source.duration,
        fps: source.sourceFps ?? fps,
        width: source.videoWidth ?? 0,
        height: source.videoHeight ?? 0,
        hasAudio: false,
      },
    ],
    tracks: [
      {
        id: "vt-1",
        kind: "video",
        name: "V1",
        enabled: true,
        clips: [
          {
            id: "clip-1",
            sourceId,
            start: 0,
            duration: source.duration,
            in: 0,
            out: source.duration,
            enabled: true,
          },
        ],
      },
    ],
  });
}

export function isEmptyComposition(composition) {
  if (!composition?.tracks?.length) return true;
  return composition.tracks.every((track) => (track.clips?.length ?? 0) === 0);
}

// ---------- serialize ----------

export function serializeComposition(composition) {
  const normalized = normalizeComposition(composition);
  return {
    version: COMPOSITION_VERSION,
    fps: normalized.fps,
    duration: normalized.duration,
    sources: normalized.sources.map((s) => ({ ...s })),
    tracks: normalized.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      name: track.name,
      enabled: track.enabled,
      muted: track.muted,
      locked: track.locked,
      blendMode: track.blendMode,
      opacity: track.opacity,
      clips: track.clips.map((clip) => ({ ...clip })),
    })),
  };
}

export { nextId };
