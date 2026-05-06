import { dispatch, getState } from "./state.js";

export const TIMELINE_VERSION = 1;
export const TIMELINE_BINDING_NODE_PARAM = "node-param";
export const TIMELINE_BINDING_NODE_PROPERTY = "node-property";

const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 120;
const KEYFRAME_TIME_EPSILON = 1 / 1200;

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

export function hasTimelineTrackForParam(nodeId, paramKey, timeline = getState().timeline) {
  return Boolean(findParamTrack(normalizeTimeline(timeline), nodeId, paramKey));
}

export function hasParamKeyframeAtCurrentTime(nodeId, paramKey) {
  const state = getState();
  const timeline = normalizeTimeline(state.timeline, {
    duration: state.source.duration,
    fps: state.source.fps,
  });
  const track = findParamTrack(timeline, nodeId, paramKey);
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
  const normalized = normalizeTimeline(timeline);
  const nextTracks = normalized.tracks.map((track) => clone(track));
  let track = nextTracks.find(
    (item) =>
      item.nodeId === nodeId &&
      item.binding.type === TIMELINE_BINDING_NODE_PARAM &&
      item.binding.key === paramKey
  );

  if (!track) {
    track = {
      id: createTrackId(nodeId, paramKey),
      enabled: true,
      nodeId,
      binding: { type: TIMELINE_BINDING_NODE_PARAM, key: paramKey },
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
    easing: "linear",
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
  const normalized = normalizeTimeline(timeline);
  const nextTracks = [];

  for (const track of normalized.tracks) {
    if (
      track.nodeId !== nodeId ||
      track.binding.type !== TIMELINE_BINDING_NODE_PARAM ||
      track.binding.key !== paramKey
    ) {
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

  const keyframes = (Array.isArray(raw.keyframes) ? raw.keyframes : [])
    .map((keyframe, index) => normalizeKeyframe(keyframe, index, context, raw.interpolation))
    .filter(Boolean);
  if (keyframes.length === 0) return null;

  return {
    id: String(raw.id ?? createTrackId(nodeId, binding.key)),
    enabled: raw.enabled !== false,
    collapsed: raw.collapsed === true,
    nodeId,
    binding,
    interpolation: normalizeEasing(raw.interpolation ?? "linear"),
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
  return {
    id: String(raw.id ?? `kf-${index}`),
    time,
    value: clone(raw.value),
    easing: normalizeEasing(raw.easing ?? raw.interpolation ?? fallbackEasing ?? "linear"),
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
    const easing = normalizeEasing(from.easing ?? track.interpolation);
    if (easing === "hold") return clone(from.value);
    return interpolateValues(from.value, to.value, ease(rawT, easing));
  }

  return clone(last.value);
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
  if (Object.prototype.hasOwnProperty.call(patch, "time")) {
    out.time = normalizeDuration(patch.time);
  }
  return out;
}

function normalizeEasing(raw) {
  if (raw && typeof raw === "object" && raw.mode) return normalizeEasing(raw.mode);
  const value = String(raw ?? "linear").toLowerCase().replace(/_/g, "-");
  if (value === "easein") return "ease-in";
  if (value === "easeout") return "ease-out";
  if (value === "easeinout" || value === "smooth") return "ease-in-out";
  if (value === "hold" || value === "step") return "hold";
  if (value === "ease-in" || value === "ease-out" || value === "ease-in-out") return value;
  return "linear";
}

function ease(t, easing) {
  switch (easing) {
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - (1 - t) * (1 - t);
    case "ease-in-out":
      return t * t * (3 - 2 * t);
    case "linear":
    default:
      return t;
  }
}

function createTrackId(nodeId, paramKey) {
  return `track:${nodeId}:param:${paramKey}`;
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
