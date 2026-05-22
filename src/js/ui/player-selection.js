// Multi-select keyframe state. `selectedKeyframes` is the full set of
// "trackId|keyframeId" keys; `selectedTimelineKeyframe` always points at the
// most recently picked one. The inspector panel only edits a single keyframe
// at a time, so it follows that "last clicked" cursor.
const selectedKeyframes = new Set();
let selectedTimelineKeyframe = null;
let selectedPropertyTrackId = null;

export function initPlayerSelection(_deps = {}) {}

export function getSelectedKeyframes() {
  return selectedKeyframes;
}

export function getSelectedTimelineKeyframeCursor() {
  return selectedTimelineKeyframe;
}

export function setSelectedTimelineKeyframeCursor(value) {
  selectedTimelineKeyframe = value;
}

export function getSelectedPropertyTrackId() {
  return selectedPropertyTrackId;
}

export function setSelectedPropertyTrackId(trackId) {
  selectedPropertyTrackId = trackId;
}

export function selectionKey(trackId, keyframeId) {
  return `${trackId}|${keyframeId}`;
}

export function isKeyframeSelected(trackId, keyframeId) {
  return selectedKeyframes.has(selectionKey(trackId, keyframeId));
}

export function setSoleSelection(trackId, keyframeId) {
  selectedKeyframes.clear();
  selectedKeyframes.add(selectionKey(trackId, keyframeId));
  selectedTimelineKeyframe = { trackId, keyframeId };
}

export function toggleKeyframeSelection(trackId, keyframeId) {
  const key = selectionKey(trackId, keyframeId);
  if (selectedKeyframes.has(key)) {
    selectedKeyframes.delete(key);
    if (
      selectedTimelineKeyframe?.trackId === trackId &&
      selectedTimelineKeyframe?.keyframeId === keyframeId
    ) {
      const next = selectedKeyframes.values().next().value;
      selectedTimelineKeyframe = next ? parseSelectionKey(next) : null;
    }
  } else {
    selectedKeyframes.add(key);
    selectedTimelineKeyframe = { trackId, keyframeId };
  }
}

export function parseSelectionKey(key) {
  const [trackId, keyframeId] = key.split("|");
  return { trackId, keyframeId };
}

export function clearSelection() {
  selectedKeyframes.clear();
  selectedTimelineKeyframe = null;
}

export function pickKeyframeWithModifier(trackId, keyframeId, event) {
  if (event && (event.shiftKey || event.metaKey || event.ctrlKey)) {
    toggleKeyframeSelection(trackId, keyframeId);
  } else {
    setSoleSelection(trackId, keyframeId);
  }
}

export function replaceSelectedKeyframes(next) {
  selectedKeyframes.clear();
  for (const key of next) selectedKeyframes.add(key);
  if (
    selectedTimelineKeyframe &&
    !selectedKeyframes.has(
      selectionKey(selectedTimelineKeyframe.trackId, selectedTimelineKeyframe.keyframeId)
    )
  ) {
    const last = selectedKeyframes.size ? [...selectedKeyframes].pop() : null;
    selectedTimelineKeyframe = last ? parseSelectionKey(last) : null;
  } else if (!selectedTimelineKeyframe && selectedKeyframes.size) {
    selectedTimelineKeyframe = parseSelectionKey([...selectedKeyframes].pop());
  }
}
