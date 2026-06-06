// Clip edit interactions for the Clips timeline view (V3, Ship 2).
//
// Move (drag clip body), trim (drag either edge handle), and split (S key at
// playhead). Mirrors the keyframe-drag lifecycle in player.js and the atomic
// history pattern from graph-node-drag.js: snapshot the composition on
// pointerdown, mutate via the pure reducers in composition.js on each move, and
// push exactly ONE history entry on pointerup.
//
// State/DOM live here; the geometry (pure reducers + snap) lives in
// composition.js so it stays unit-testable.

import { getState, dispatch, pushHistory } from "../state.js";
import {
  moveClip,
  trimClipStart,
  trimClipEnd,
  splitClip,
  removeClip,
  rippleDeleteClip,
  addClip,
  addVideoTrack,
  updateTrack,
  setClipGraphId,
  snapClipTime,
  serializeComposition,
  normalizeComposition,
  compositionDuration,
} from "../composition.js";
import { hasClipGraph, makeClipGraphId, setClipGraph } from "../clip-graphs.js";
import { enterClipGraphScope } from "../graph.js";
import { timelineFrameRate, normalizeTimeline } from "../timeline.js";

// Selection: a single clip id, mirroring the keyframe selection module. Used by
// the renderer (is-selected class) and by split (operates on the selected clip).
let selectedClipId = null;

export function getSelectedClipId() {
  return selectedClipId;
}

export function setSelectedClipId(id) {
  selectedClipId = id ?? null;
}

// Deps injected from player.js to avoid an import cycle and to reuse the
// player's exact time→pixel mapping and seek.
let seekFn = () => {};
let rerender = () => {};

export function initPlayerMediaClipDrag(deps = {}) {
  if (typeof deps.seek === "function") seekFn = deps.seek;
  if (typeof deps.rerender === "function") rerender = deps.rerender;
}

// ---------- history (atomic, one entry per drag) ----------
// Snapshot/restore here rather than in composition.js so that module stays
// state-free. Restore dispatches the whole slice (immutable dispatch friendly).

function snapshotComposition() {
  return serializeComposition(getState().composition);
}

function restoreComposition(snapshot) {
  dispatch("composition", serializeComposition(normalizeComposition(snapshot)));
}

function pushCompositionHistory(before, label) {
  const after = snapshotComposition();
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  pushHistory({
    label,
    undo: () => restoreComposition(before),
    redo: () => restoreComposition(after),
  });
}

// ---------- shared drag plumbing ----------

const DRAG_THRESHOLD_PX = 3;
let drag = null;

function timelineFps() {
  const { timeline, source } = getState();
  return timelineFrameRate(normalizeTimeline(timeline, { fps: source.fps }), source.fps);
}

// Total timeline length in seconds, used to map pointer ratio → time. Prefer
// the composition extent so dragging near the end maps correctly.
function timelineDuration() {
  const { composition, source, timeline } = getState();
  return Math.max(
    compositionDuration(composition) || 0,
    Number(source.duration) || 0,
    Number(timeline?.duration) || 0
  );
}

// Pointer X → composition time, using the lane element's on-screen rect (which
// already reflects ruler zoom/scroll).
function pointerTime(clientX) {
  const rect = drag.laneRect;
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return clamped * drag.duration;
}

// ~6px-at-current-zoom snap threshold, expressed in seconds.
function snapThresholdSeconds() {
  const rect = drag.laneRect;
  if (!(rect.width > 0) || !(drag.duration > 0)) return 0;
  return (6 / rect.width) * drag.duration;
}

function beginDrag(state) {
  drag = state;
  document.body.classList.add("dragging-clip");
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerUp);
}

function onPointerMove(event) {
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
  drag.moved = true;

  const rawTime = pointerTime(event.clientX);

  if (drag.kind === "move") {
    // Anchor: keep the grab offset within the clip constant.
    const desiredStart = rawTime - drag.grabOffset;
    const snapped = snapClipTime(getState().composition, desiredStart, {
      excludeClipId: drag.clipId,
      playheadTime: getState().playback.currentTime,
      threshold: snapThresholdSeconds(),
      fps: timelineFps(),
    });
    dispatch("composition", moveClip(getState().composition, {
      trackId: drag.trackId,
      clipId: drag.clipId,
      start: snapped,
    }));
  } else if (drag.kind === "trim-start") {
    const snapped = snapClipTime(getState().composition, rawTime, {
      excludeClipId: drag.clipId,
      playheadTime: getState().playback.currentTime,
      threshold: snapThresholdSeconds(),
      fps: timelineFps(),
    });
    dispatch("composition", trimClipStart(getState().composition, {
      trackId: drag.trackId,
      clipId: drag.clipId,
      start: snapped,
    }));
  } else if (drag.kind === "trim-end") {
    const snapped = snapClipTime(getState().composition, rawTime, {
      excludeClipId: drag.clipId,
      playheadTime: getState().playback.currentTime,
      threshold: snapThresholdSeconds(),
      fps: timelineFps(),
    });
    dispatch("composition", trimClipEnd(getState().composition, {
      trackId: drag.trackId,
      clipId: drag.clipId,
      end: snapped,
    }));
  }
}

function onPointerUp() {
  if (!drag) return;
  const { before, label } = drag;
  drag = null;
  document.body.classList.remove("dragging-clip");
  document.removeEventListener("pointermove", onPointerMove);
  document.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("pointercancel", onPointerUp);
  pushCompositionHistory(before, label);
}

// ---------- entry points (called from player.js pointerdown) ----------

export function startClipMove(clipEl, event) {
  const clipId = clipEl.dataset.mediaClipId;
  const trackId = clipEl.dataset.mediaClipTrack;
  const lane = clipEl.closest(".media-track-lane");
  if (!clipId || !trackId || !lane) return false;
  selectClip(clipId);
  const clip = findClip(trackId, clipId);
  if (!clip) return false;
  const laneRect = lane.getBoundingClientRect();
  const duration = timelineDuration();
  // Where inside the clip (in seconds) the grab landed, so the clip doesn't jump.
  const grabTime = duration > 0 && laneRect.width > 0
    ? ((event.clientX - laneRect.left) / laneRect.width) * duration
    : clip.start;
  beginDrag({
    kind: "move",
    clipId,
    trackId,
    laneRect,
    duration,
    startX: event.clientX,
    grabOffset: grabTime - clip.start,
    moved: false,
    before: snapshotComposition(),
    label: "Move clip",
  });
  return true;
}

export function startClipTrim(handleEl, event, edge) {
  const clipEl = handleEl.closest(".media-clip");
  if (!clipEl) return false;
  const clipId = clipEl.dataset.mediaClipId;
  const trackId = clipEl.dataset.mediaClipTrack;
  const lane = clipEl.closest(".media-track-lane");
  if (!clipId || !trackId || !lane) return false;
  selectClip(clipId);
  beginDrag({
    kind: edge === "start" ? "trim-start" : "trim-end",
    clipId,
    trackId,
    laneRect: lane.getBoundingClientRect(),
    duration: timelineDuration(),
    startX: event.clientX,
    moved: false,
    before: snapshotComposition(),
    label: "Trim clip",
  });
  return true;
}

// Split the selected clip at the current playhead. Returns true when it cut.
export function splitSelectedClipAtPlayhead() {
  if (!selectedClipId) return false;
  const composition = getState().composition;
  const located = locateClip(composition, selectedClipId);
  if (!located) return false;
  const time = getState().playback.currentTime;
  const before = snapshotComposition();
  const next = splitClip(composition, {
    trackId: located.trackId,
    clipId: selectedClipId,
    time,
  });
  if (next === composition) return false;
  dispatch("composition", next);
  pushCompositionHistory(before, "Split clip");
  return true;
}

// Delete the selected clip. `ripple` pulls later clips on the same track left
// to close the gap; otherwise the gap is left in place. Clears selection and
// pushes one history entry. Returns true when something was removed.
export function deleteSelectedClip({ ripple = false } = {}) {
  if (!selectedClipId) return false;
  const composition = getState().composition;
  const located = locateClip(composition, selectedClipId);
  if (!located) return false;
  const before = snapshotComposition();
  const edit = ripple ? rippleDeleteClip : removeClip;
  const next = edit(composition, { trackId: located.trackId, clipId: selectedClipId });
  if (next === composition) return false;
  dispatch("composition", next);
  selectedClipId = null;
  pushCompositionHistory(before, ripple ? "Ripple delete clip" : "Delete clip");
  rerender();
  return true;
}

// Add a clip from an asset drop. `laneEl` is the .media-track-lane dropped onto,
// `sourceId` comes from the drag payload, `clientX` gives the drop position.
// Snaps the drop time to the frame grid, adds the clip via the reducer (which
// finds a free slot), and pushes one history entry. Returns true on success.
export function addClipFromDrop(laneEl, sourceId, clientX) {
  if (!laneEl || !sourceId) return false;
  const trackId = laneEl.dataset.mediaLane;
  if (!trackId) return false;
  const composition = getState().composition;
  const rect = laneEl.getBoundingClientRect();
  const duration = timelineDuration();
  const dropTime = rect.width > 0 && duration > 0
    ? Math.max(0, ((clientX - rect.left) / rect.width) * duration)
    : 0;
  const before = snapshotComposition();
  const next = addClip(composition, { trackId, sourceId, start: dropTime });
  if (next === composition) return false;
  dispatch("composition", next);
  pushCompositionHistory(before, "Add clip");
  rerender();
  return true;
}

// Add a new empty video track on top of the stack (for compositing). One
// history entry.
export function addVideoTrackAction() {
  const composition = getState().composition;
  const before = snapshotComposition();
  const next = addVideoTrack(composition);
  if (next === composition) return false;
  dispatch("composition", next);
  pushCompositionHistory(before, "Add track");
  rerender();
  return true;
}

// Update a track's compositing props (opacity / blendMode). One history entry
// per commit — the UI fires this on change (slider release, select change), so
// the snapshot taken here is the pre-change state.
export function setTrackProp(trackId, patch) {
  if (!trackId || !patch) return false;
  const composition = getState().composition;
  const before = snapshotComposition();
  const next = updateTrack(composition, { trackId, patch });
  if (next === composition) return false;
  dispatch("composition", next);
  pushCompositionHistory(before, "Update track");
  rerender();
  return true;
}

export function selectClip(clipId) {
  if (selectedClipId === clipId) return;
  selectedClipId = clipId ?? null;
  rerender();
}

// Toggle a clip's own effect graph. With no graph, clone the CURRENT global
// graph into the registry and point the clip at it — so the clip keeps the
// current look while the global graph can keep changing for other clips. With a
// graph, detach back to the shared global graph. One history entry; the registry
// clone is intentionally left in place on detach so undo/redo can restore the
// reference (orphans are pruned at project-save time).
export function toggleClipGraphById(trackId, clipId) {
  if (!trackId || !clipId) return false;
  const composition = getState().composition;
  const clip = findClip(trackId, clipId);
  if (!clip) return false;
  const before = snapshotComposition();
  let graphId;
  if (clip.graphId && hasClipGraph(clip.graphId)) {
    graphId = null;
  } else {
    graphId = setClipGraph(makeClipGraphId(), structuredClone(getState().graph));
  }
  const next = setClipGraphId(composition, { trackId, clipId, graphId });
  if (next === composition) return false;
  dispatch("composition", next);
  pushCompositionHistory(before, graphId ? "Add clip FX graph" : "Remove clip FX graph");
  rerender();
  return true;
}

// Open a clip's own effect graph in the node editor (double-click gesture).
// Ensures the clip has a graph first (clones the current global graph if the
// clip is still on the shared graph), then enters the editing scope so the node
// editor edits that clip's graph. Returns true when the scope opened.
export function editClipGraph(trackId, clipId) {
  if (!trackId || !clipId) return false;
  const clip = findClip(trackId, clipId);
  if (!clip) return false;
  let graphId = clip.graphId;
  if (!graphId || !hasClipGraph(graphId)) {
    const before = snapshotComposition();
    graphId = setClipGraph(makeClipGraphId(), structuredClone(getState().graph));
    const next = setClipGraphId(getState().composition, { trackId, clipId, graphId });
    dispatch("composition", next);
    pushCompositionHistory(before, "Add clip FX graph");
  }
  selectClip(clipId);
  return enterClipGraphScope(clipId, graphId);
}

// ---------- lookups ----------

function findClip(trackId, clipId) {
  const track = getState().composition?.tracks?.find((t) => t.id === trackId);
  return track?.clips?.find((c) => c.id === clipId) ?? null;
}

function locateClip(composition, clipId) {
  for (const track of composition?.tracks ?? []) {
    if (track.clips?.some((c) => c.id === clipId)) return { trackId: track.id };
  }
  return null;
}
