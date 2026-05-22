import { dispatch, getState } from "../state.js";
import {
  duplicateTimelineKeyframes,
  getTimelineKeyframe,
  moveTimelineKeyframes,
  normalizeTimeline,
  pasteTimelineKeyframes,
  removeTimelineKeyframeById,
  snapTimeToFrame,
  snapshotTimelineKeyframes,
} from "../timeline.js";
import {
  clearSelection,
  getSelectedKeyframes,
  parseSelectionKey,
  selectionKey,
  setSelectedTimelineKeyframeCursor,
} from "./player-selection.js";

const selectedKeyframes = getSelectedKeyframes();
let timelineKeyframeClipboard = [];

export function initPlayerKeyframeActions(_deps = {}) {}

export function getTimelineKeyframeClipboard() {
  return timelineKeyframeClipboard;
}

export function setTimelineKeyframeClipboard(value) {
  timelineKeyframeClipboard = Array.isArray(value) ? value : [];
}

export function deleteSelectedKeyframes() {
  if (selectedKeyframes.size === 0) return false;
  let next = getState().timeline;
  for (const key of selectedKeyframes) {
    const { trackId, keyframeId } = parseSelectionKey(key);
    if (!trackId || !keyframeId) continue;
    next = removeTimelineKeyframeById(next, { trackId, keyframeId });
  }
  dispatch("timeline", next);
  clearSelection();
  return true;
}

export function duplicateSelectedKeyframes() {
  if (selectedKeyframes.size === 0) return false;
  const items = [...selectedKeyframes].map(parseSelectionKey);
  const { timeline: next, newKeys } = duplicateTimelineKeyframes(getState().timeline, items);
  if (newKeys.length === 0) return false;
  selectedKeyframes.clear();
  for (const { trackId, keyframeId } of newKeys) {
    selectedKeyframes.add(selectionKey(trackId, keyframeId));
  }
  setSelectedTimelineKeyframeCursor(newKeys[newKeys.length - 1]);
  dispatch("timeline", next);
  return true;
}

export function nudgeSelectedKeyframes(direction, big = false) {
  if (selectedKeyframes.size === 0) return false;
  const sign = direction < 0 ? -1 : 1;
  const { timeline, source } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const fps = normalized.fps;
  const dt = (sign * (big ? 10 : 1)) / fps;
  const moves = [];
  for (const key of selectedKeyframes) {
    const { trackId, keyframeId } = parseSelectionKey(key);
    const found = getTimelineKeyframe(normalized, trackId, keyframeId);
    if (!found) continue;
    moves.push({
      trackId,
      keyframeId,
      time: Math.max(0, found.keyframe.time + dt),
    });
  }
  if (moves.length === 0) return false;
  dispatch("timeline", moveTimelineKeyframes(timeline, moves));
  return true;
}

export function copySelectedKeyframes() {
  if (selectedKeyframes.size === 0) return false;
  const items = [...selectedKeyframes].map(parseSelectionKey);
  const snapshot = snapshotTimelineKeyframes(getState().timeline, items);
  if (snapshot.length === 0) return false;
  setTimelineKeyframeClipboard(snapshot);
  return true;
}

export function pasteKeyframesAtPlayhead() {
  if (!Array.isArray(timelineKeyframeClipboard) || timelineKeyframeClipboard.length === 0) {
    return false;
  }
  const { timeline, playback, source } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const targetTime = snapTimeToFrame(
    Math.max(0, Number(playback.currentTime) || 0),
    normalized.fps
  );
  const { timeline: next, newKeys } = pasteTimelineKeyframes(
    timeline,
    timelineKeyframeClipboard,
    targetTime
  );
  if (newKeys.length === 0) return false;
  selectedKeyframes.clear();
  for (const { trackId, keyframeId } of newKeys) {
    selectedKeyframes.add(selectionKey(trackId, keyframeId));
  }
  setSelectedTimelineKeyframeCursor(newKeys[newKeys.length - 1]);
  dispatch("timeline", next);
  return true;
}
