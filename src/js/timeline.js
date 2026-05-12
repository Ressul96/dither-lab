import { dispatch, getState } from "./state.js";

export const TIMELINE_VERSION = 2;
export const TIMELINE_BINDING_NODE_PARAM = "node-param";
export const TIMELINE_BINDING_NODE_PROPERTY = "node-property";
export const TIMELINE_LINEAR_EASING = Object.freeze({
  type: "bezier",
  controlPoints: Object.freeze([0, 0, 1, 1]),
});
export const TIMELINE_STEP_EASING = Object.freeze({ type: "step" });
export const TIMELINE_EASING_PRESETS = Object.freeze([
  { category: "basic", controlPoints: [0, 0, 1, 1], label: "Linear", name: "linear" },
  { category: "basic", controlPoints: [0.65, 0, 0.35, 1], label: "Smooth", name: "smooth" },
  { category: "expressive", controlPoints: [1, -0.4, 0.35, 0.95], label: "Anticipate", name: "anticipate" },
  { category: "expressive", controlPoints: [0.36, 0, 0.66, -0.56], label: "Back In", name: "backIn" },
  { category: "expressive", controlPoints: [0.34, 1.56, 0.64, 1], label: "Back Out", name: "backOut" },
  { category: "out", controlPoints: [0, 0, 0.2, 1], label: "Quick Out", name: "quickOut" },
  { category: "out", controlPoints: [0.175, 0.885, 0.32, 1.1], label: "Swift Out", name: "swiftOut" },
  { category: "out", controlPoints: [0.19, 1, 0.22, 1], label: "Snappy Out", name: "snappyOut" },
  { category: "out", controlPoints: [0.215, 0.61, 0.355, 1], label: "Out Cubic", name: "outCubic" },
  { category: "out", controlPoints: [0, 0, 0.58, 1], label: "Ease Out", name: "easeOut" },
  { category: "in", controlPoints: [0.42, 0, 1, 1], label: "Ease In", name: "easeIn" },
  { category: "in", controlPoints: [0.6, 0.04, 0.98, 0.335], label: "In Circ", name: "inCirc" },
  { category: "in", controlPoints: [0.755, 0.05, 0.855, 0.06], label: "In Quint", name: "inQuint" },
  { category: "inOut", controlPoints: [0.42, 0, 0.58, 1], label: "Ease In Out", name: "easeInOut" },
  { category: "inOut", controlPoints: [0.77, 0, 0.175, 1], label: "In Out Quart", name: "inOutQuart" },
  { category: "inOut", controlPoints: [0.86, 0, 0.07, 1], label: "In Out Quint", name: "inOutQuint" },
  { category: "inOut", controlPoints: [1, 0, 0, 1], label: "In Out Expo", name: "inOutExpo" },
  { category: "inOut", controlPoints: [0.785, 0.135, 0.15, 0.86], label: "In Out Circ", name: "inOutCirc" },
]);

const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 120;
const KEYFRAME_TIME_EPSILON = 1 / 1200;
const BEZIER_EPSILON = 1e-6;
const EASING_PRESET_BY_NAME = new Map(
  TIMELINE_EASING_PRESETS.map((preset) => [preset.name, preset])
);
const LEGACY_EASING_ALIASES = Object.freeze({
  ease: "easeInOut",
  easein: "easeIn",
  easeout: "easeOut",
  easeinout: "easeInOut",
  "ease-in": "easeIn",
  "ease-out": "easeOut",
  "ease-in-out": "easeInOut",
  smoothstep: "smooth",
  hold: "step",
  step: "step",
});

export function createDefaultTimeline(overrides = {}) {
  return normalizeTimeline({
    version: TIMELINE_VERSION,
    duration: 0,
    fps: DEFAULT_FPS,
    loop: true,
    tracks: [],
    ...overrides,
  });
}

export function normalizeTimeline(raw = {}, fallback = {}) {
  const duration = normalizeDuration(
    raw?.duration ?? fallback.duration ?? fallback.durationSeconds ?? 0
  );
  const fps = clampFps(raw?.fps ?? fallback.fps ?? DEFAULT_FPS);
  const tracks = (Array.isArray(raw?.tracks) ? raw.tracks : [])
    .map((track) => normalizeTrack(track, { duration, fps }))
    .filter(Boolean);

  return {
    version: TIMELINE_VERSION,
    duration,
    fps,
    loop: raw?.loop !== false,
    autokey: raw?.autokey === true,
    tracks,
    // UI state preserved through save/load. Defaults match state.js.
    viewMode: raw?.viewMode === "graph" ? "graph" : "layers",
    durationUnit: raw?.durationUnit === "second" ? "second" : "frame",
    zoom: clampZoom(raw?.zoom),
    panelOpen: raw?.panelOpen !== false,
    selectedPropertyId:
      typeof raw?.selectedPropertyId === "string" ? raw.selectedPropertyId : null,
    expandedTrackIds: Array.isArray(raw?.expandedTrackIds)
      ? raw.expandedTrackIds.filter((id) => typeof id === "string" && id.length > 0)
      : [],
  };
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, numeric));
}

export function serializeTimeline(timeline = getState().timeline) {
  return normalizeTimeline(timeline, {
    duration: getState().source.duration,
    fps: getState().source.fps,
  });
}

export function timelineFrameRate(timeline = getState().timeline, fallbackFps = getState().source.fps) {
  return clampFps(timeline?.fps ?? fallbackFps ?? DEFAULT_FPS);
}

export function timeToFrame(seconds, fps = DEFAULT_FPS) {
  const frameRate = clampFps(fps);
  const time = normalizeDuration(seconds);
  return Math.max(0, Math.round(time * frameRate));
}

export function frameToTime(frame, fps = DEFAULT_FPS) {
  const frameRate = clampFps(fps);
  const index = Math.max(0, Math.round(Number(frame) || 0));
  return index / frameRate;
}

export function snapTimeToFrame(seconds, fps = DEFAULT_FPS) {
  return frameToTime(timeToFrame(seconds, fps), fps);
}

/**
 * "0024 / 0240" — current / total frame readout. Padding auto-sizes to the
 * total's digit count, with a 4-digit minimum so short clips still feel
 * professional (0001 / 0090). Used by the new transport bar.
 */
export function formatFrameReadout(timeSeconds, fps, durationSeconds, options = {}) {
  const frameRate = clampFps(fps);
  const total = durationToFrames(durationSeconds, frameRate);
  const current = Math.min(total, timeToFrame(timeSeconds, frameRate));
  const padWidth = options?.padWidth ?? Math.max(4, String(total).length);
  const pad = (n) => String(n).padStart(padWidth, "0");
  return `${pad(current)} / ${pad(total)}`;
}

/**
 * "1.67s / 8.00s" — fixed two-decimal seconds readout. Used when
 * timeline.durationUnit === "second".
 */
export function formatSecondReadout(timeSeconds, durationSeconds) {
  const fmt = (s) => (Number.isFinite(Number(s)) ? `${Number(s).toFixed(2)}s` : "—");
  return `${fmt(timeSeconds)} / ${fmt(durationSeconds)}`;
}

export function getTimelineEasingPreset(name) {
  const preset = EASING_PRESET_BY_NAME.get(String(name ?? ""));
  return preset ? { ...preset, controlPoints: [...preset.controlPoints] } : null;
}

export function createBezierEasing(controlPoints = TIMELINE_LINEAR_EASING.controlPoints) {
  return {
    type: "bezier",
    controlPoints: normalizeControlPoints(controlPoints),
  };
}

export function createStepEasing() {
  return { type: "step" };
}

export function cloneEasing(easing) {
  const normalized = normalizeEasing(easing);
  if (normalized.type === "step") return createStepEasing();
  return createBezierEasing(normalized.controlPoints);
}

export function migrateInterpolationToEasing(interpolation = "linear") {
  return normalizeEasing(interpolation);
}

export function findMatchingEasingPreset(easing) {
  const normalized = normalizeEasing(easing);
  if (normalized.type === "step") return null;

  const [x1, y1, x2, y2] = normalized.controlPoints;
  const tolerance = 0.005;
  for (const preset of TIMELINE_EASING_PRESETS) {
    const [px1, py1, px2, py2] = preset.controlPoints;
    if (
      Math.abs(x1 - px1) < tolerance &&
      Math.abs(y1 - py1) < tolerance &&
      Math.abs(x2 - px2) < tolerance &&
      Math.abs(y2 - py2) < tolerance
    ) {
      return preset.name;
    }
  }
  return null;
}

export function formatBezierForDisplay(controlPoints) {
  return normalizeControlPoints(controlPoints)
    .map((value) => Number(value.toFixed(3)))
    .join(", ");
}

export function evaluateCubicBezier(progress, controlPoints) {
  const p = clamp01(progress);
  if (p <= 0) return 0;
  if (p >= 1) return 1;

  const [x1, y1, x2, y2] = normalizeControlPoints(controlPoints);
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return p;

  let t = p;
  for (let i = 0; i < 8; i++) {
    const x = cubicBezierAxis(t, x1, x2) - p;
    if (Math.abs(x) < BEZIER_EPSILON) return cubicBezierAxis(t, y1, y2);

    const derivative = cubicBezierAxisDerivative(t, x1, x2);
    if (Math.abs(derivative) < BEZIER_EPSILON) break;

    const nextT = t - x / derivative;
    if (nextT < 0 || nextT > 1) break;
    t = nextT;
  }

  let lo = 0;
  let hi = 1;
  t = p;
  for (let i = 0; i < 18; i++) {
    const x = cubicBezierAxis(t, x1, x2);
    if (Math.abs(x - p) < BEZIER_EPSILON) break;
    if (x < p) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }

  return cubicBezierAxis(t, y1, y2);
}

export function resolveEasing(progress, easing) {
  const normalized = normalizeEasing(easing);
  if (normalized.type === "step") return 0;
  return evaluateCubicBezier(progress, normalized.controlPoints);
}

// ---------- 1B-i UI dispatch helpers (state mutations) ----------

export function setSelectedProperty(propertyId) {
  const next = typeof propertyId === "string" && propertyId.length > 0 ? propertyId : null;
  if (getState().timeline.selectedPropertyId === next) return;
  dispatch("timeline", { selectedPropertyId: next });
}

export function isTrackExpanded(trackId) {
  if (typeof trackId !== "string") return false;
  return (getState().timeline.expandedTrackIds ?? []).includes(trackId);
}

export function setTrackExpanded(trackId, expanded) {
  if (typeof trackId !== "string" || trackId.length === 0) return;
  const current = new Set(getState().timeline.expandedTrackIds ?? []);
  const has = current.has(trackId);
  const want = Boolean(expanded);
  if (has === want) return;
  if (want) current.add(trackId);
  else current.delete(trackId);
  dispatch("timeline", { expandedTrackIds: [...current] });
}

export function toggleTrackExpanded(trackId) {
  setTrackExpanded(trackId, !isTrackExpanded(trackId));
}

export function setViewMode(mode) {
  if (mode !== "layers" && mode !== "graph") return;
  if (getState().timeline.viewMode === mode) return;
  dispatch("timeline", { viewMode: mode });
}

export function setDurationUnit(unit) {
  if (unit !== "frame" && unit !== "second") return;
  if (getState().timeline.durationUnit === unit) return;
  dispatch("timeline", { durationUnit: unit });
}

export function setTimelineZoom(zoom) {
  const next = clampZoom(zoom);
  if (getState().timeline.zoom === next) return;
  dispatch("timeline", { zoom: next });
}

export function setTimelinePanelOpen(open) {
  const next = open !== false;
  if (getState().timeline.panelOpen === next) return;
  dispatch("timeline", { panelOpen: next });
}

// ---------- /1B-i helpers ----------

export function durationToFrames(durationSeconds, fps = DEFAULT_FPS) {
  const frameRate = clampFps(fps);
  const duration = normalizeDuration(durationSeconds);
  return Math.max(1, Math.ceil(duration * frameRate));
}

export function applyTimelineToGraph(graph, timeline, timeSeconds = 0, options = {}) {
  if (!graph?.nodes?.length) return graph;
  const normalized = normalizeTimeline(timeline, options);
  if (normalized.tracks.length === 0) return graph;

  const targetTime = snapTimeToFrame(resolveTimelineTime(normalized, timeSeconds), normalized.fps);
  const paramPatches = new Map();
  const propertyPatches = new Map();
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  for (const track of normalized.tracks) {
    if (!track.enabled || !nodeIds.has(track.nodeId)) continue;
    const value = evaluateTrack(track, targetTime, normalized);
    if (value === undefined) continue;

    if (track.binding.type === TIMELINE_BINDING_NODE_PARAM) {
      if (!paramPatches.has(track.nodeId)) paramPatches.set(track.nodeId, {});
      paramPatches.get(track.nodeId)[track.binding.key] = value;
    } else if (track.binding.type === TIMELINE_BINDING_NODE_PROPERTY) {
      if (!propertyPatches.has(track.nodeId)) propertyPatches.set(track.nodeId, {});
      propertyPatches.get(track.nodeId)[track.binding.key] = value;
    }
  }

  if (paramPatches.size === 0 && propertyPatches.size === 0) return graph;

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const paramPatch = paramPatches.get(node.id);
      const propertyPatch = propertyPatches.get(node.id);
      if (!paramPatch && !propertyPatch) return node;
      return {
        ...node,
        ...propertyPatch,
        params: paramPatch ? { ...node.params, ...paramPatch } : node.params,
      };
    }),
  };
}

export function getTimelineParamValue(
  timeline,
  nodeId,
  paramKey,
  timeSeconds,
  baseValue,
  options = {}
) {
  const normalized = normalizeTimeline(timeline, options);
  const track = findParamTrack(normalized, nodeId, paramKey);
  if (!track || !track.enabled) return baseValue;
  const value = evaluateTrack(track, snapTimeToFrame(timeSeconds, normalized.fps), normalized);
  return value === undefined ? baseValue : value;
}

export function getTimelineTrackValue(
  timeline,
  trackId,
  timeSeconds,
  baseValue,
  options = {}
) {
  const normalized = normalizeTimeline(timeline, options);
  const track = normalized.tracks.find((item) => item.id === trackId);
  if (!track || !track.enabled) return baseValue;
  const value = evaluateTrack(track, snapTimeToFrame(timeSeconds, normalized.fps), normalized);
  return value === undefined ? baseValue : value;
}

export function hasTimelineTrackForParam(nodeId, paramKey, timeline = getState().timeline) {
  return Boolean(findParamTrack(normalizeTimeline(timeline), nodeId, paramKey));
}

export function hasTimelineTrackForBinding(nodeId, binding, timeline = getState().timeline) {
  return Boolean(findTrackForBinding(normalizeTimeline(timeline), nodeId, binding));
}

export function hasParamKeyframeAtCurrentTime(nodeId, paramKey) {
  return hasTimelineKeyframeAtCurrentTime(nodeId, {
    type: TIMELINE_BINDING_NODE_PARAM,
    key: paramKey,
  });
}

export function hasTimelineKeyframeAtCurrentTime(nodeId, binding) {
  const state = getState();
  const timeline = normalizeTimeline(state.timeline, {
    duration: state.source.duration,
    fps: state.source.fps,
  });
  const track = findTrackForBinding(timeline, nodeId, binding);
  if (!track) return false;
  return findKeyframeIndexAtTime(
    track,
    snapTimeToFrame(resolveTimelineTime(timeline, state.playback.currentTime), timeline.fps),
    timeline.fps
  ) >= 0;
}

export function toggleParamKeyframeAtCurrentTime(nodeId, paramKey) {
  if (!nodeId || !paramKey) return false;
  const state = getState();
  const timeline = normalizeTimeline(state.timeline, {
    duration: state.source.duration,
    fps: state.source.fps,
  });
  const time = snapTimeToFrame(resolveTimelineTime(timeline, state.playback.currentTime), timeline.fps);
  const track = findParamTrack(timeline, nodeId, paramKey);

  if (track && findKeyframeIndexAtTime(track, time, timeline.fps) >= 0) {
    dispatch("timeline", removeParamKeyframe(timeline, { nodeId, paramKey, time }));
    return true;
  }

  // Always commit the live param value the user is currently looking at — not
  // the timeline's evaluated value at this time. Without this, a second
  // keyframe added after dragging the slider would inherit the *first*
  // keyframe's value and the slider drag would silently disappear, which is
  // exactly the "keyframe has no effect" symptom users were hitting.
  const node = state.graph.nodes.find((item) => item.id === nodeId);
  const value = node?.params?.[paramKey];

  dispatch("timeline", setParamKeyframe(timeline, { nodeId, paramKey, time, value }));
  return true;
}

export function toggleTimelineKeyframeAtCurrentTime({ nodeId, binding, value }) {
  if (!nodeId) return false;
  const normalizedBinding = normalizeBinding(binding);
  if (!normalizedBinding?.key) return false;

  const state = getState();
  const timeline = normalizeTimeline(state.timeline, {
    duration: state.source.duration,
    fps: state.source.fps,
  });
  const time = snapTimeToFrame(resolveTimelineTime(timeline, state.playback.currentTime), timeline.fps);
  const track = findTrackForBinding(timeline, nodeId, normalizedBinding);

  if (track && findKeyframeIndexAtTime(track, time, timeline.fps) >= 0) {
    dispatch("timeline", removeTimelineKeyframe(timeline, { nodeId, binding: normalizedBinding, time }));
    return true;
  }

  dispatch(
    "timeline",
    setTimelineKeyframe(timeline, {
      nodeId,
      binding: normalizedBinding,
      time,
      value,
    })
  );
  const touched = findTrackForBinding(getState().timeline, nodeId, normalizedBinding);
  if (touched) setTrackExpanded(touched.id, true);
  return true;
}

/**
 * Commit a parameter change to the timeline. This is the autokey + bound-track
 * write path: if a track already exists for this param, the change updates the
 * keyframe at the current playhead; if no track exists and `autokey` is on,
 * the first keyframe is created. Returns true when a timeline write actually
 * happened.
 */
export function commitParamValueToTimeline(nodeId, paramKey, value) {
  if (!nodeId || !paramKey) return false;
  const state = getState();
  const timeline = normalizeTimeline(state.timeline, {
    duration: state.source.duration,
    fps: state.source.fps,
  });
  const track = findParamTrack(timeline, nodeId, paramKey);
  const autokey = state.timeline.autokey === true;
  if (!track && !autokey) return false;

  const time = snapTimeToFrame(
    resolveTimelineTime(timeline, state.playback.currentTime),
    timeline.fps
  );
  dispatch("timeline", setParamKeyframe(timeline, { nodeId, paramKey, time, value }));
  // Auto-expand the lane the user just touched. The track id is stable —
  // setParamKeyframe reuses an existing track or creates one with the
  // deterministic node-param id pair, so a fresh lookup finds it.
  const writtenTrack = findParamTrack(getState().timeline, nodeId, paramKey);
  if (writtenTrack) setTrackExpanded(writtenTrack.id, true);
  return true;
}

export function setTimelineAutokey(enabled) {
  dispatch("timeline", { autokey: enabled === true });
}

export function updateParamKeyframeAtCurrentTime(nodeId, paramKey, value) {
  if (!hasParamKeyframeAtCurrentTime(nodeId, paramKey)) return false;
  const state = getState();
  const timeline = normalizeTimeline(state.timeline, {
    duration: state.source.duration,
    fps: state.source.fps,
  });
  dispatch(
    "timeline",
    setParamKeyframe(timeline, {
      nodeId,
      paramKey,
      time: snapTimeToFrame(resolveTimelineTime(timeline, state.playback.currentTime), timeline.fps),
      value,
    })
  );
  const touched = findParamTrack(getState().timeline, nodeId, paramKey);
  if (touched) setTrackExpanded(touched.id, true);
  return true;
}

export function setParamKeyframe(timeline, { nodeId, paramKey, time, value }) {
  return setTimelineKeyframe(timeline, {
    nodeId,
    binding: { type: TIMELINE_BINDING_NODE_PARAM, key: paramKey },
    time,
    value,
  });
}

export function setTimelineKeyframe(timeline, { nodeId, binding, time, value }) {
  const normalized = normalizeTimeline(timeline);
  const nextTracks = normalized.tracks.map((track) => clone(track));
  const normalizedBinding = normalizeBinding(binding);
  if (!nodeId || !normalizedBinding?.key) return normalized;
  let track = nextTracks.find((item) => isSameBinding(item, nodeId, normalizedBinding));

  if (!track) {
    track = {
      id: createTrackId(nodeId, normalizedBinding),
      enabled: true,
      nodeId,
      binding: normalizedBinding,
      interpolation: "linear",
      keyframes: [],
    };
    nextTracks.push(track);
  }

  const keyframeTime = snapTimeToFrame(time, normalized.fps);
  const keyframe = {
    id: createKeyframeId(track.id, keyframeTime),
    time: keyframeTime,
    value: clone(value),
    easing: createBezierEasing(),
    interpolation: "linear",
    inTangent: null,
    outTangent: null,
  };
  const existingIndex = findKeyframeIndexAtTime(track, keyframe.time, normalized.fps);
  if (existingIndex >= 0) {
    track.keyframes[existingIndex] = {
      ...track.keyframes[existingIndex],
      value: keyframe.value,
      time: keyframe.time,
    };
  } else {
    track.keyframes.push(keyframe);
  }
  track.keyframes = sortKeyframes(track.keyframes);

  return { ...normalized, tracks: nextTracks };
}

export function removeParamKeyframe(timeline, { nodeId, paramKey, time }) {
  return removeTimelineKeyframe(timeline, {
    nodeId,
    binding: { type: TIMELINE_BINDING_NODE_PARAM, key: paramKey },
    time,
  });
}

export function removeTimelineKeyframe(timeline, { nodeId, binding, time }) {
  const normalized = normalizeTimeline(timeline);
  const nextTracks = [];
  const normalizedBinding = normalizeBinding(binding);
  if (!nodeId || !normalizedBinding?.key) return normalized;

  for (const track of normalized.tracks) {
    if (!isSameBinding(track, nodeId, normalizedBinding)) {
      nextTracks.push(track);
      continue;
    }

    const index = findKeyframeIndexAtTime(track, time, normalized.fps);
    if (index < 0) {
      nextTracks.push(track);
      continue;
    }

    const keyframes = track.keyframes.filter((_, itemIndex) => itemIndex !== index);
    if (keyframes.length > 0) nextTracks.push({ ...track, keyframes });
  }

  return { ...normalized, tracks: nextTracks };
}

export function moveTimelineKeyframe(timeline, { trackId, keyframeId, time }) {
  const normalized = normalizeTimeline(timeline);
  const duration = normalized.duration > 0 ? normalized.duration : Infinity;
  const nextTime = snapTimeToFrame(time, normalized.fps);
  let changed = false;
  const nextTracks = normalized.tracks.map((track) => {
    if (track.id !== trackId) return track;
    const keyframes = track.keyframes.map((keyframe) => {
      if (keyframe.id !== keyframeId) return keyframe;
      changed = true;
      return {
        ...keyframe,
        time: Math.min(duration, nextTime),
      };
    });
    return { ...track, keyframes: sortKeyframes(keyframes) };
  });

  return changed ? normalizeTimeline({ ...normalized, tracks: nextTracks }) : normalized;
}

/**
 * Batch counterpart of `moveTimelineKeyframe`. Applies every `(trackId,
 * keyframeId) -> time` move against a single normalized timeline so callers
 * can shift the entire multi-selection in one pass without re-normalising per
 * keyframe. Each new time is clamped to duration and snapped to the frame
 * grid, matching the single-move behaviour.
 */
export function moveTimelineKeyframes(timeline, items) {
  const normalized = normalizeTimeline(timeline);
  if (!Array.isArray(items) || items.length === 0) return normalized;
  const duration = normalized.duration > 0 ? normalized.duration : Infinity;
  const targets = new Map();
  for (const item of items) {
    if (!item?.trackId || !item?.keyframeId) continue;
    const nextTime = Math.min(duration, snapTimeToFrame(item.time, normalized.fps));
    if (!targets.has(item.trackId)) targets.set(item.trackId, new Map());
    targets.get(item.trackId).set(item.keyframeId, nextTime);
  }
  if (targets.size === 0) return normalized;
  let changed = false;
  const nextTracks = normalized.tracks.map((track) => {
    const updates = targets.get(track.id);
    if (!updates) return track;
    const keyframes = track.keyframes.map((keyframe) => {
      if (!updates.has(keyframe.id)) return keyframe;
      changed = true;
      return { ...keyframe, time: updates.get(keyframe.id) };
    });
    return { ...track, keyframes: sortKeyframes(keyframes) };
  });
  return changed ? normalizeTimeline({ ...normalized, tracks: nextTracks }) : normalized;
}

export function updateTimelineKeyframe(timeline, { trackId, keyframeId, patch }) {
  const normalized = normalizeTimeline(timeline);
  let changed = false;
  const nextTracks = normalized.tracks.map((track) => {
    if (track.id !== trackId) return track;
    const keyframes = track.keyframes.map((keyframe) => {
      if (keyframe.id !== keyframeId) return keyframe;
      changed = true;
      return {
        ...keyframe,
        ...sanitizeKeyframePatch(patch),
      };
    });
    return { ...track, keyframes: sortKeyframes(keyframes) };
  });

  return changed ? normalizeTimeline({ ...normalized, tracks: nextTracks }) : normalized;
}

export function removeTimelineKeyframeById(timeline, { trackId, keyframeId }) {
  const normalized = normalizeTimeline(timeline);
  let changed = false;
  const nextTracks = [];

  for (const track of normalized.tracks) {
    if (track.id !== trackId) {
      nextTracks.push(track);
      continue;
    }

    const keyframes = track.keyframes.filter((keyframe) => keyframe.id !== keyframeId);
    changed = changed || keyframes.length !== track.keyframes.length;
    if (keyframes.length > 0) nextTracks.push({ ...track, keyframes });
  }

  return changed ? normalizeTimeline({ ...normalized, tracks: nextTracks }) : normalized;
}

/**
 * Duplicate a list of keyframes by one frame each. Returns the new timeline
 * along with the ids of the freshly-created keyframes so the UI can reroute
 * the multi-select to them. Items pointing at non-existent keyframes or
 * missing keyframes are skipped silently.
 *
 * If the +1 frame slot is already occupied, that occupant is overwritten —
 * matches the setParamKeyframe semantics. Future improvement: shift to the
 * next free frame instead of clobbering.
 */
export function duplicateTimelineKeyframes(timeline, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { timeline, newKeys: [] };
  }
  let next = normalizeTimeline(timeline);
  const fps = next.fps;
  const oneFrame = 1 / fps;
  const newKeys = [];

  for (const item of items) {
    const found = getTimelineKeyframe(next, item.trackId, item.keyframeId);
    if (!found) continue;
    const { track, keyframe } = found;
    const newTime = snapTimeToFrame(keyframe.time + oneFrame, fps);

    next = setTimelineKeyframe(next, {
      nodeId: track.nodeId,
      binding: track.binding,
      time: newTime,
      value: keyframe.value,
    });
    const keyframeId = createKeyframeId(track.id, newTime);
    next = updateTimelineKeyframe(next, {
      trackId: track.id,
      keyframeId,
      patch: {
        easing: keyframe.easing,
        interpolation: keyframe.interpolation,
        inTangent: keyframe.inTangent,
        outTangent: keyframe.outTangent,
      },
    });
    newKeys.push({ trackId: track.id, keyframeId });
  }

  return { timeline: next, newKeys };
}

/**
 * Snapshot a list of timeline keyframes for the clipboard. Returns plain
 * value objects (binding clones, deep-cloned values, easing copies) that are
 * decoupled from the live timeline, so the original keyframes can be moved
 * or deleted without disturbing the captured set. `items` is the same
 * `{ trackId, keyframeId }` shape the multi-selection state uses.
 */
export function snapshotTimelineKeyframes(timeline, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const normalized = normalizeTimeline(timeline);
  const snapshots = [];
  for (const item of items) {
    const found = getTimelineKeyframe(normalized, item?.trackId, item?.keyframeId);
    if (!found) continue;
    snapshots.push({
      nodeId: found.track.nodeId,
      binding: { ...found.track.binding },
      time: found.keyframe.time,
      value: clone(found.keyframe.value),
      easing: cloneEasing(found.keyframe.easing),
      interpolation: found.keyframe.interpolation,
      inTangent: found.keyframe.inTangent ? { ...found.keyframe.inTangent } : null,
      outTangent: found.keyframe.outTangent ? { ...found.keyframe.outTangent } : null,
    });
  }
  return snapshots;
}

/**
 * Paste a clipboard snapshot at `targetTime`. The earliest item lands on
 * `targetTime`; the rest preserve their relative offsets — so copying a chord
 * of keyframes around frame 90 and pasting at frame 30 keeps their spacing.
 * Reuses `setTimelineKeyframe` + `updateTimelineKeyframe` so easing/tangents
 * survive the round-trip identically to `duplicateTimelineKeyframes`.
 */
export function pasteTimelineKeyframes(timeline, items, targetTime) {
  if (!Array.isArray(items) || items.length === 0) {
    return { timeline: normalizeTimeline(timeline), newKeys: [] };
  }
  let next = normalizeTimeline(timeline);
  let earliest = Infinity;
  for (const item of items) {
    if (Number.isFinite(item?.time)) earliest = Math.min(earliest, item.time);
  }
  if (!Number.isFinite(earliest)) {
    return { timeline: next, newKeys: [] };
  }
  const base = snapTimeToFrame(Math.max(0, Number(targetTime) || 0), next.fps);
  const newKeys = [];
  for (const item of items) {
    if (!item?.nodeId || !item?.binding?.key) continue;
    const offset = Number.isFinite(item.time) ? item.time - earliest : 0;
    const nextTime = snapTimeToFrame(base + offset, next.fps);
    next = setTimelineKeyframe(next, {
      nodeId: item.nodeId,
      binding: item.binding,
      time: nextTime,
      value: item.value,
    });
    const trackId = createTimelineTrackId(item.nodeId, item.binding);
    const keyframeId = createKeyframeId(trackId, nextTime);
    next = updateTimelineKeyframe(next, {
      trackId,
      keyframeId,
      patch: {
        easing: item.easing,
        interpolation: item.interpolation,
        inTangent: item.inTangent,
        outTangent: item.outTangent,
      },
    });
    newKeys.push({ trackId, keyframeId });
  }
  return { timeline: next, newKeys };
}

export function getTimelineKeyframe(timeline, trackId, keyframeId) {
  const normalized = normalizeTimeline(timeline);
  const track = normalized.tracks.find((item) => item.id === trackId);
  if (!track) return null;
  const keyframe = track.keyframes.find((item) => item.id === keyframeId);
  if (!keyframe) return null;
  return { track, keyframe };
}

export function timelineTrackCount(timeline = getState().timeline) {
  return normalizeTimeline(timeline).tracks.length;
}

function normalizeTrack(raw, context) {
  if (!raw || typeof raw !== "object") return null;
  const nodeId = String(raw.nodeId ?? raw.layerId ?? raw.targetId ?? "").trim();
  const binding = normalizeBinding(raw.binding ?? raw.target ?? raw.param ?? raw.property);
  if (!nodeId || !binding?.key) return null;
  const fallbackEasing = raw.easing ?? raw.interpolation ?? "linear";

  const keyframes = (Array.isArray(raw.keyframes) ? raw.keyframes : [])
    .map((keyframe, index) => normalizeKeyframe(keyframe, index, context, fallbackEasing))
    .filter(Boolean);
  if (keyframes.length === 0) return null;

  return {
    id: String(raw.id ?? createTrackId(nodeId, binding)),
    enabled: raw.enabled !== false,
    collapsed: raw.collapsed === true,
    nodeId,
    binding,
    interpolation: normalizeInterpolation(raw.interpolation, fallbackEasing),
    keyframes: dedupeKeyframes(sortKeyframes(keyframes)),
  };
}

export function updateTimelineTrack(timeline, { trackId, patch }) {
  const normalized = normalizeTimeline(timeline);
  if (!trackId || !patch || typeof patch !== "object") return normalized;
  let changed = false;
  const nextTracks = normalized.tracks.map((track) => {
    if (track.id !== trackId) return track;
    const next = { ...track };
    if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
      next.enabled = patch.enabled !== false;
      if (next.enabled !== track.enabled) changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "collapsed")) {
      next.collapsed = patch.collapsed === true;
      if (next.collapsed !== track.collapsed) changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "interpolation")) {
      next.interpolation = normalizeInterpolation(patch.interpolation, next.interpolation);
      if (next.interpolation !== track.interpolation) changed = true;
    }
    return next;
  });
  return changed ? normalizeTimeline({ ...normalized, tracks: nextTracks }) : normalized;
}

function normalizeBinding(raw) {
  if (typeof raw === "string") {
    const key = normalizeBindingKey(raw);
    return { type: TIMELINE_BINDING_NODE_PARAM, key };
  }
  if (!raw || typeof raw !== "object") return null;

  const rawKey =
    raw.key ??
    raw.path ??
    raw.name ??
    raw.param ??
    raw.paramKey ??
    raw.property ??
    raw.propertyKey;
  const key = normalizeBindingKey(rawKey);
  if (!key) return null;

  const rawType = String(raw.type ?? raw.kind ?? "").toLowerCase();
  const type =
    rawType.includes("property") || rawType === "prop"
      ? TIMELINE_BINDING_NODE_PROPERTY
      : TIMELINE_BINDING_NODE_PARAM;

  return { type, key };
}

function normalizeBindingKey(rawKey) {
  if (rawKey === null || rawKey === undefined) return "";
  return String(rawKey).replace(/^params\./, "").replace(/^param:/, "").trim();
}

function normalizeKeyframe(raw, index, context, fallbackEasing) {
  if (!raw || typeof raw !== "object") return null;
  const time = snapTimeToFrame(normalizeKeyframeTime(raw, context), context.fps);
  if (!Number.isFinite(time)) return null;
  const easingSource = raw.easing ?? raw.interpolation ?? fallbackEasing ?? "linear";
  const easing = normalizeEasing(easingSource, fallbackEasing);
  return {
    id: String(raw.id ?? `kf-${index}`),
    time,
    value: clone(raw.value),
    easing,
    interpolation: normalizeInterpolation(raw.interpolation, easingSource),
    inTangent: normalizeTangent(raw.inTangent),
    outTangent: normalizeTangent(raw.outTangent),
  };
}

function normalizeKeyframeTime(raw, context) {
  if (Number.isFinite(Number(raw.time))) return normalizeDuration(Number(raw.time));
  if (Number.isFinite(Number(raw.at))) return normalizeDuration(Number(raw.at));
  if (!raw.at || typeof raw.at !== "object") return NaN;

  const value = Number(raw.at.value);
  if (!Number.isFinite(value)) return NaN;

  const domain = String(raw.at.domain ?? "seconds").toLowerCase();
  if (domain.includes("frame")) return normalizeDuration(value / Math.max(MIN_FPS, context.fps));
  if (domain.includes("normalized")) return normalizeDuration(value * context.duration);
  return normalizeDuration(value);
}

function evaluateTrack(track, timeSeconds, timeline) {
  const keyframes = track.keyframes;
  if (!keyframes.length) return undefined;
  if (keyframes.length === 1) return clone(keyframes[0].value);

  const time = resolveTimelineTime(timeline, timeSeconds);
  if (time <= keyframes[0].time) return clone(keyframes[0].value);
  const last = keyframes[keyframes.length - 1];
  if (time >= last.time) return clone(last.value);

  for (let index = 0; index < keyframes.length - 1; index++) {
    const from = keyframes[index];
    const to = keyframes[index + 1];
    if (time < from.time || time > to.time) continue;
    const span = Math.max(KEYFRAME_TIME_EPSILON, to.time - from.time);
    const rawT = clamp01((time - from.time) / span);
    const interpolation = resolveSegmentInterpolation(from, track);
    if (interpolation === "hold") return clone(from.value);
    if (shouldEvaluateLegacyBezierSegment(track, index)) {
      const bezier = evaluateBezierSegment(track, index, time, timeline);
      if (bezier !== undefined) return bezier;
    }
    return interpolateValues(from.value, to.value, resolveEasing(rawT, resolveKeyframeEasing(from, track)));
  }

  return clone(last.value);
}

function evaluateBezierSegment(track, index, time, timeline) {
  const from = track.keyframes[index];
  const to = track.keyframes[index + 1];
  if (typeof from.value !== "number" || typeof to.value !== "number") return undefined;

  const out = resolveKeyframeTangent(track, index, "out");
  const inn = resolveKeyframeTangent(track, index + 1, "in");
  const p0 = { x: from.time, y: from.value };
  const p1 = { x: from.time + out.dt, y: from.value + out.dv };
  const p2 = { x: to.time + inn.dt, y: to.value + inn.dv };
  const p3 = { x: to.time, y: to.value };
  const u = solveCubicX(p0.x, p1.x, p2.x, p3.x, resolveTimelineTime(timeline, time));
  return cubicAt(p0.y, p1.y, p2.y, p3.y, u);
}

function resolveKeyframeTangent(track, index, side) {
  const keyframe = track.keyframes[index];
  const key = side === "in" ? "inTangent" : "outTangent";
  const explicit = normalizeTangent(keyframe?.[key]);
  if (explicit) return explicit;
  return createAutoTangent(track, index, side);
}

function createAutoTangent(track, index, side) {
  const keyframe = track.keyframes[index];
  const previous = track.keyframes[index - 1];
  const next = track.keyframes[index + 1];
  if (!keyframe || typeof keyframe.value !== "number") return { dt: 0, dv: 0 };

  const neighbor = side === "in" ? previous : next;
  if (!neighbor || typeof neighbor.value !== "number") return { dt: 0, dv: 0 };

  const windowStart = previous ?? keyframe;
  const windowEnd = next ?? keyframe;
  const windowSpan = Math.max(KEYFRAME_TIME_EPSILON, windowEnd.time - windowStart.time);
  const slope =
    typeof windowStart.value === "number" && typeof windowEnd.value === "number"
      ? (windowEnd.value - windowStart.value) / windowSpan
      : 0;
  const segmentSpan = Math.max(KEYFRAME_TIME_EPSILON, Math.abs(neighbor.time - keyframe.time));
  const dt = (side === "in" ? -1 : 1) * segmentSpan * 0.33;
  return { dt, dv: slope * dt };
}

function resolveSegmentInterpolation(keyframe, track) {
  if (normalizeEasing(keyframe?.easing ?? track?.interpolation).type === "step") return "hold";
  if (keyframe?.interpolation) return normalizeInterpolation(keyframe.interpolation, keyframe.easing);
  return normalizeInterpolation(track?.interpolation, keyframe?.easing);
}

function resolveKeyframeEasing(keyframe, track) {
  if (keyframe?.easing) return normalizeEasing(keyframe.easing, track?.interpolation);
  return migrateInterpolationToEasing(keyframe?.interpolation ?? track?.interpolation ?? "linear");
}

function shouldEvaluateLegacyBezierSegment(track, index) {
  const from = track.keyframes[index];
  const to = track.keyframes[index + 1];
  if (!from || !to) return false;
  if (resolveSegmentInterpolation(from, track) !== "bezier") return false;
  return Boolean(normalizeTangent(from.outTangent) || normalizeTangent(to.inTangent));
}

function interpolateValues(from, to, t) {
  if (typeof from === "number" && typeof to === "number") {
    return from + (to - from) * t;
  }
  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) {
    return from.map((value, index) => interpolateValues(value, to[index], t));
  }
  if (isPlainObject(from) && isPlainObject(to)) {
    const keys = Object.keys(from);
    if (!keys.every((key) => typeof from[key] === "number" && typeof to[key] === "number")) {
      return t < 1 ? clone(from) : clone(to);
    }
    const out = {};
    for (const key of keys) out[key] = interpolateValues(from[key], to[key], t);
    return out;
  }
  return t < 1 ? clone(from) : clone(to);
}

function resolveTimelineTime(timeline, timeSeconds) {
  const time = normalizeDuration(timeSeconds);
  if (timeline.duration <= 0) return time;
  if (!timeline.loop) return Math.min(timeline.duration, time);
  return ((time % timeline.duration) + timeline.duration) % timeline.duration;
}

function findParamTrack(timeline, nodeId, paramKey) {
  return timeline.tracks.find(
    (track) =>
      track.nodeId === nodeId &&
      track.binding.type === TIMELINE_BINDING_NODE_PARAM &&
      track.binding.key === paramKey
  ) ?? null;
}

function findTrackForBinding(timeline, nodeId, binding) {
  const normalizedBinding = normalizeBinding(binding);
  if (!nodeId || !normalizedBinding?.key) return null;
  return timeline.tracks.find((track) => isSameBinding(track, nodeId, normalizedBinding)) ?? null;
}

function isSameBinding(track, nodeId, binding) {
  return track?.nodeId === nodeId &&
    track?.binding?.type === binding.type &&
    track?.binding?.key === binding.key;
}

function findKeyframeIndexAtTime(track, time, fps = DEFAULT_FPS) {
  const tolerance = Math.max(KEYFRAME_TIME_EPSILON, 0.5 / clampFps(fps));
  const target = normalizeDuration(time);
  return track.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - target) <= tolerance);
}

function sortKeyframes(keyframes) {
  return [...keyframes].sort((a, b) => a.time - b.time);
}

function dedupeKeyframes(keyframes) {
  const out = [];
  for (const keyframe of keyframes) {
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous.time - keyframe.time) <= KEYFRAME_TIME_EPSILON) {
      out[out.length - 1] = keyframe;
    } else {
      out.push(keyframe);
    }
  }
  return out;
}

function sanitizeKeyframePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  if (Object.prototype.hasOwnProperty.call(patch, "value")) out.value = clone(patch.value);
  if (Object.prototype.hasOwnProperty.call(patch, "easing")) {
    out.easing = normalizeEasing(patch.easing);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "interpolation")) {
    out.interpolation = normalizeInterpolation(patch.interpolation, out.easing ?? patch.easing);
  } else if (Object.prototype.hasOwnProperty.call(patch, "easing")) {
    out.interpolation = normalizeInterpolation(undefined, out.easing);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "inTangent")) {
    out.inTangent = normalizeTangent(patch.inTangent);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "outTangent")) {
    out.outTangent = normalizeTangent(patch.outTangent);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "time")) {
    out.time = normalizeDuration(patch.time);
  }
  return out;
}

function normalizeInterpolation(raw, easingFallback = "linear") {
  const value = String(raw ?? "").toLowerCase().replace(/[_\s]+/g, "-");
  if (value === "bezier" || value === "custom-bezier") return "bezier";
  if (value === "hold") return "hold";
  if (value === "step") return "hold";
  if (value === "linear") return "linear";
  const easing = normalizeEasing(easingFallback);
  if (easing.type === "step") return "hold";
  return "linear";
}

function normalizeTangent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dt = Number(raw.dt);
  const dv = Number(raw.dv);
  if (!Number.isFinite(dt) || !Number.isFinite(dv)) return null;
  return { dt, dv };
}

function normalizeControlPoints(raw) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  const parts = values.map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return [...TIMELINE_LINEAR_EASING.controlPoints];
  }

  return [
    clamp01(parts[0]),
    parts[1],
    clamp01(parts[2]),
    parts[3],
  ];
}

function parseEasingString(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.toLowerCase() === "step") return createStepEasing();

  const bezierMatch = value.match(/^cubic-bezier\((.+)\)$/i);
  if (!bezierMatch) return null;
  return createBezierEasing(bezierMatch[1]);
}

function normalizeEasingToken(raw) {
  return String(raw ?? "linear")
    .trim()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    .replace(/^[A-Z]/, (char) => char.toLowerCase());
}

function normalizeEasing(raw, fallback = "linear") {
  if (raw && typeof raw === "object") {
    if (raw.type === "step") return createStepEasing();
    if (raw.type === "bezier") return createBezierEasing(raw.controlPoints);
    if (raw.mode !== undefined) return normalizeEasing(raw.mode, fallback);
    if (raw.name !== undefined) return normalizeEasing(raw.name, fallback);
    if (raw.controlPoints !== undefined) return createBezierEasing(raw.controlPoints);
  }

  const parsed = parseEasingString(raw);
  if (parsed) return parsed;

  const token = normalizeEasingToken(raw);
  const aliased = LEGACY_EASING_ALIASES[token] ?? token;
  if (aliased === "step") return createStepEasing();
  if (
    aliased === "custombezier" ||
    aliased === "customBezier" ||
    aliased === "custom-bezier" ||
    aliased === "bezier" ||
    aliased === "custom"
  ) {
    return createBezierEasing(EASING_PRESET_BY_NAME.get("smooth")?.controlPoints);
  }

  const preset = EASING_PRESET_BY_NAME.get(aliased);
  if (preset) return createBezierEasing(preset.controlPoints);

  if (fallback !== undefined && fallback !== raw) return normalizeEasing(fallback, "linear");
  return createBezierEasing();
}

export function createTimelineTrackId(nodeId, binding) {
  const normalizedBinding = normalizeBinding(binding);
  const type = normalizedBinding?.type === TIMELINE_BINDING_NODE_PROPERTY ? "property" : "param";
  const key = normalizedBinding?.key ?? "";
  return `track:${nodeId}:${type}:${key}`;
}

function createTrackId(nodeId, binding) {
  return createTimelineTrackId(nodeId, binding);
}

function createKeyframeId(trackId, time) {
  return `${trackId}:kf:${normalizeDuration(time).toFixed(4)}`;
}

function normalizeDuration(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function clampFps(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return DEFAULT_FPS;
  return Math.max(MIN_FPS, Math.min(MAX_FPS, numeric));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cubicBezierAxis(t, p1, p2) {
  const inv = 1 - t;
  return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
}

function cubicBezierAxisDerivative(t, p1, p2) {
  return 3 * (1 - t) * (1 - t) * p1
    + 6 * (1 - t) * t * (p2 - p1)
    + 3 * t * t * (1 - p2);
}

function solveCubicX(x0, x1, x2, x3, targetX) {
  let lo = 0;
  let hi = 1;
  let t = 0.5;
  for (let i = 0; i < 18; i++) {
    t = (lo + hi) / 2;
    const x = cubicAt(x0, x1, x2, x3, t);
    if (x < targetX) lo = t;
    else hi = t;
  }
  return t;
}

function cubicAt(p0, p1, p2, p3, t) {
  const inv = 1 - t;
  return inv * inv * inv * p0
    + 3 * inv * inv * t * p1
    + 3 * inv * t * t * p2
    + t * t * t * p3;
}
