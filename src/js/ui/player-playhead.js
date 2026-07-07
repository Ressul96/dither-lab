import { getState } from "../state.js";
import { isSimpleSingleSource, pausePlayback, seek } from "../source.js";
import {
  durationToFrames,
  normalizeTimeline,
  snapTimeToFrame,
  timeToFrame,
  timelineFrameRate,
} from "../timeline.js";
import { getPlayerEls } from "./player-elements.js";
import { formatRulerSecond } from "./player-format.js";

let playheadDrag = null;
let clampTime = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
let getEffectiveTimelineZoomValue = () => 1;
let resolveTimelineDurationValue = () => 0;
let timeToTimelinePercentValue = () => 0;

const playerEls = getPlayerEls();

export function initPlayerPlayhead({
  clamp,
  getEffectiveTimelineZoom,
  resolveTimelineDuration,
  timeToTimelinePercent,
} = {}) {
  if (typeof clamp === "function") clampTime = clamp;
  if (typeof getEffectiveTimelineZoom === "function") {
    getEffectiveTimelineZoomValue = getEffectiveTimelineZoom;
  }
  if (typeof resolveTimelineDuration === "function") {
    resolveTimelineDurationValue = resolveTimelineDuration;
  }
  if (typeof timeToTimelinePercent === "function") {
    timeToTimelinePercentValue = timeToTimelinePercent;
  }
}

export function getPlayheadDrag() {
  return playheadDrag;
}

export function setPlayheadDrag(value) {
  playheadDrag = value;
}

export function handlePlayheadKeyDown(event) {
  if (
    (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
    event.metaKey ||
    event.ctrlKey
  ) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();

  const { source, timeline, playback } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const duration = resolveTimelineDurationValue(normalized, source);
  if (duration <= 0) return true;

  const fps = timelineFrameRate(normalized, source.fps);
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
  // Single-source nudges stay inside the trim range (unchanged). Multi-clip
  // nudges span the whole composition so arrow keys can reach clips past the
  // primary source's trim, matching stepFrame's composition-aware behaviour.
  const simple = isSimpleSingleSource();
  const trimStart = clampTime(Number(playback.trimStart) || 0, 0, duration);
  const trimEnd = clampTime(Number(playback.trimEnd) || duration, trimStart, duration);
  const lo = simple ? trimStart : 0;
  const hi = simple
    ? Math.max(trimStart, trimEnd - 1 / Math.max(1, fps))
    : Math.max(0, duration - 1 / Math.max(1, fps));
  const currentTime = Number.isFinite(Number(playback.currentTime)) ? Number(playback.currentTime) : 0;
  pausePlayback();
  seek(clampTime(currentTime + (direction * multiplier) / Math.max(1, fps), lo, hi));
  return true;
}

export function startPlayheadDrag(handle, event) {
  if (event.button !== 0 && event.button !== undefined) return;
  event.preventDefault();
  event.stopPropagation();

  const { source, timeline, playback } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const duration = resolveTimelineDurationValue(normalized, source);
  if (duration <= 0) return;

  const body = handle.closest(".timeline-pane-body");
  if (!body) return;

  setPlayheadDrag({
    body,
    duration,
    fps: timelineFrameRate(normalized, source.fps),
    handle,
    pointerId: event.pointerId,
    wasPlaying: playback.playing === true,
  });
  if (playheadDrag.wasPlaying) pausePlayback();
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {}
  document.body.classList.add("dragging-playhead");
  updatePlayheadDragFromPointer(event);
  document.addEventListener("pointermove", onPlayheadPointerMove);
  document.addEventListener("pointerup", onPlayheadPointerUp);
  document.addEventListener("pointercancel", onPlayheadPointerUp);
}

export function updateAnimationPlayhead(playback, sourceDuration) {
  if (!playerEls.playerCard) return;
  const { source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: sourceDuration,
    fps: source.fps,
  });
  const fps = timelineFrameRate(normalized, source.fps);
  const duration = resolveTimelineDurationValue(normalized, { duration: sourceDuration });
  const playhead = playerEls.playerCard.querySelector(".playhead");
  if (!playhead) return;
  const left = timeToTimelinePercentValue(playback.currentTime, duration, fps) * getEffectiveTimelineZoomValue(normalized);
  playhead.style.left = `${left}%`;
  syncPlayheadAccessibility(playhead, playback.currentTime, duration, fps);
}

function onPlayheadPointerMove(event) {
  if (!playheadDrag) return;
  event.preventDefault();
  updatePlayheadDragFromPointer(event);
}

function onPlayheadPointerUp() {
  if (!playheadDrag) return;
  try {
    playheadDrag.handle?.releasePointerCapture(playheadDrag.pointerId);
  } catch {}
  setPlayheadDrag(null);
  document.body.classList.remove("dragging-playhead");
  updatePlayheadTooltip(null);
  document.removeEventListener("pointermove", onPlayheadPointerMove);
  document.removeEventListener("pointerup", onPlayheadPointerUp);
  document.removeEventListener("pointercancel", onPlayheadPointerUp);
}

function updatePlayheadDragFromPointer(event) {
  const drag = playheadDrag;
  if (!drag) return;
  const rect = drag.body.getBoundingClientRect();
  const contentWidth = Math.max(drag.body.scrollWidth, drag.body.clientWidth, 1);
  const x = clampTime(event.clientX - rect.left + drag.body.scrollLeft, 0, contentWidth);
  const ratio = clampTime(x / contentWidth, 0, 1);
  const time = snapTimeToFrame(ratio * drag.duration, drag.fps);
  seek(time);
  updatePlayheadTooltip(time, drag.fps);
}

function syncPlayheadAccessibility(playhead, time, duration, fps) {
  const handle = playhead.querySelector(".playhead-handle");
  if (!handle) return;
  const totalFrames = durationToFrames(duration, fps);
  const frame = timeToFrame(time, fps);
  handle.setAttribute("aria-valuemin", "0");
  handle.setAttribute("aria-valuemax", String(Math.max(0, totalFrames - 1)));
  handle.setAttribute("aria-valuenow", String(clampTime(frame, 0, Math.max(0, totalFrames - 1))));
  handle.setAttribute("aria-valuetext", `F${frame} · ${formatRulerSecond(time)}`);
}

function updatePlayheadTooltip(time, fps = 30) {
  const playhead = playerEls.playerCard?.querySelector(".playhead");
  const tooltip = playhead?.querySelector(".playhead-tooltip");
  if (!playhead || !tooltip) return;
  const dragging = Number.isFinite(Number(time));
  playhead.classList.toggle("is-dragging", dragging);
  if (!dragging) return;
  tooltip.textContent = `${formatRulerSecond(time)} · F${timeToFrame(time, fps)}`;
}
