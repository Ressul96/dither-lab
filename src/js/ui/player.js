import { getState, subscribe, dispatch, pushHistory } from "../state.js";
import {
  togglePlay,
  restart,
  stepFrame,
  seek,
  snapPlayhead,
  resetTrim,
  formatTime,
  pausePlayback,
  setPlaybackSpeed,
} from "../source.js";
import {
  durationToFrames,
  formatFrameReadout,
  formatSecondReadout,
  frameToTime,
  getTimelineKeyframe,
  moveTimelineKeyframe,
  normalizeTimeline,
  removeTimelineKeyframeById,
  setDurationUnit,
  setTimelineAutokey,
  snapTimeToFrame,
  timeToFrame,
  timelineFrameRate,
  updateTimelineKeyframe,
  updateTimelineTrack,
} from "../timeline.js";

const COMPARE_MODES = new Set(["processed", "split", "side-by-side"]);
const KEYFRAME_DRAG_THRESHOLD = 3;

let selectedTimelineKeyframe = null;
let keyframeDrag = null;

let selectedPropertyTrackId = null;

const playerEls = {
  playBtn: null,
  compareSeg: null,
  compareButtons: [],
  compareReadouts: [],
  autokeyPill: null,
  loopPill: null,
  durationInput: null,
  timeReadout: null,
  propertyList: null,
  laneHost: null,
  timeRuler: null,
  playhead: null,
  emptyState: null,
  playerCard: null,
  moreBtn: null,
};

export function initPlayer() {
  bindAction("restart", restart);
  bindAction("prev-frame", () => stepFrame(-1));
  bindAction("toggle-play", togglePlay, { pointerDown: true });
  bindAction("next-frame", () => stepFrame(1));
  bindAction("last-frame", () => {
    const { source, timeline } = getState();
    const duration = resolveTimelineDuration(timeline, source);
    if (duration <= 0) return;
    const fps = timelineFrameRate(timeline, source.fps);
    // Last addressable frame: duration*fps - 1, then back to seconds.
    const totalFrames = durationToFrames(duration, fps);
    seek(snapTimeToFrame((totalFrames - 1) / fps, fps));
  });
  bindAction("reset-trim", () => commitTrimAction(resetTrim, "Reset trim"));
  bindAction("snap-playhead", snapPlayhead);
  bindAction("stop", () => {
    pausePlayback();
    seek(0);
  });
  bindAction("toggle-loop", () => {
    const { playback } = getState();
    dispatch("playback", { loopEnabled: !playback.loopEnabled });
  });

  wireCompare();
  wireAnimationTimeline();
  wireMoreMenu();

  cachePlayerEls();
  subscribe("source", onSourceChange);
  subscribe("playback", onPlaybackChange);
  subscribe("view", onViewChange);
  subscribe("timeline", renderAnimationTimeline);
  subscribe("graph", renderAnimationTimeline);
}

function cachePlayerEls() {
  const root = document.getElementById("playerCard");
  playerEls.playerCard = root;
  if (!root) return;
  playerEls.playBtn = root.querySelector('[data-action="toggle-play"]');
  playerEls.autokeyPill = root.querySelector('[data-action="toggle-autokey"]');
  playerEls.loopPill = root.querySelector('[data-action="toggle-loop"]');
  playerEls.moreBtn = root.querySelector('[data-action="more"]');
  playerEls.durationInput = root.querySelector('[data-field="duration"]');
  playerEls.timeReadout = root.querySelector(".time-readout");
  playerEls.propertyList = root.querySelector(".property-list");
  playerEls.laneHost = root.querySelector(".lane-host");
  playerEls.timeRuler = root.querySelector(".time-ruler");
  playerEls.playhead = root.querySelector(".playhead-handle");
  playerEls.emptyState = root.querySelector(".empty-state");

  playerEls.compareSeg = document.querySelector(".compare-mode");
  playerEls.compareButtons = playerEls.compareSeg
    ? Array.from(playerEls.compareSeg.querySelectorAll("button"))
    : [];
  playerEls.compareReadouts = Array.from(document.querySelectorAll('[data-stage-readout="compare"]'));
}

function bindAction(action, handler, options = {}) {
  const el = document.querySelector(`[data-action="${action}"]`);
  if (!el) return;
  let lastPointerInvokeAt = -Infinity;

  const invoke = (event) => {
    if (el.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    void handler(event);
  };

  if (options.pointerDown) {
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      lastPointerInvokeAt = event.timeStamp;
      invoke(event);
    });
  }

  el.addEventListener("click", (event) => {
    if (event.detail > 0 && event.timeStamp - lastPointerInvokeAt < 500) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    invoke(event);
  });
}


function wireCompare() {
  const seg = document.querySelector(".compare-mode");
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    const prev = normalizeCompareMode(getState().view.compare);
    const requested = normalizeCompareMode(btn.dataset.mode);
    const next = prev === requested ? "processed" : requested;
    if (prev === next) return;
    dispatch("view", { compare: next });
    pushHistory({
      label: "Change compare mode",
      undo: () => dispatch("view", { compare: prev }),
      redo: () => dispatch("view", { compare: next }),
    });
  });
}


function wireAnimationTimeline() {
  const timelineEl = document.getElementById("playerCard");
  if (!timelineEl) return;
  timelineEl.addEventListener("pointerdown", onAnimationTimelinePointerDown);
  timelineEl.addEventListener("click", (event) => {
    const autokey = event.target.closest('[data-action="toggle-autokey"]');
    if (autokey) {
      event.preventDefault();
      event.stopPropagation();
      const next = getState().timeline.autokey !== true;
      setTimelineAutokey(next);
      return;
    }

    const propCard = event.target.closest(".property-card");
    if (propCard) {
      event.preventDefault();
      event.stopPropagation();
      selectedPropertyTrackId = propCard.dataset.trackId;
      renderAnimationTimeline();
      return;
    }

    const deleteButton = event.target.closest("[data-keyframe-action='delete']");
    if (deleteButton) {
      deleteSelectedKeyframe();
      return;
    }

    const timeTarget = event.target.closest("[data-timeline-time]");
    if (timeTarget) {
      selectedTimelineKeyframe = pickTimelineKeyframe(timeTarget);
      renderAnimationTimeline();
      seek(Number(timeTarget.dataset.timelineTime));
      return;
    }

    const lane = event.target.closest(".animation-track-lane");
    if (!lane) return;
    const { source, timeline } = getState();
    const duration = resolveTimelineDuration(timeline, source);
    if (duration <= 0) return;
    const fps = timelineFrameRate(timeline, source.fps);
    const rect = lane.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    seek(snapTimeToFrame(ratio * duration, fps));
  });
  timelineEl.addEventListener("change", onAnimationTimelineChange);

  const durationInput = document.querySelector('[data-field="duration"]');
  if (durationInput) {
    durationInput.addEventListener("change", (e) => {
      const val = Number(e.target.value);
      if (!(val > 0)) return;
      const { source, timeline } = getState();
      const fps = timelineFrameRate(timeline, source.fps);
      const unit = timeline?.durationUnit === "second" ? "second" : "frame";
      const seconds = unit === "second" ? val : val / fps;
      dispatch("timeline", { duration: seconds });
    });
  }
}

// More-menu (kebab) ------------------------------------------------------
//
// A small popover anchored to the right side of the transport bar. Holds
// secondary controls that don't deserve top-level real estate: playback
// speed, trim/snap, and the duration unit toggle.

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];

function wireMoreMenu() {
  const moreBtn = document.querySelector('[data-action="more"]');
  if (!moreBtn) return;
  let popover = null;

  const close = () => {
    if (!popover) return;
    popover.remove();
    popover = null;
    moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
  };

  const onOutside = (event) => {
    if (!popover) return;
    if (popover.contains(event.target) || moreBtn.contains(event.target)) return;
    close();
  };

  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  moreBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (popover) {
      close();
      return;
    }
    popover = renderMorePopover();
    document.body.appendChild(popover);
    positionMorePopover(popover, moreBtn);
    moreBtn.setAttribute("aria-expanded", "true");

    popover.addEventListener("click", (e) => {
      const speedBtn = e.target.closest("[data-speed]");
      if (speedBtn) {
        e.preventDefault();
        setPlaybackSpeed(Number(speedBtn.dataset.speed));
        renderPopoverState(popover);
        return;
      }
      const unitBtn = e.target.closest("[data-unit]");
      if (unitBtn) {
        e.preventDefault();
        setDurationUnit(unitBtn.dataset.unit);
        renderPopoverState(popover);
        // duration input value re-renders via subscriber
        return;
      }
      const action = e.target.closest("[data-popover-action]");
      if (!action) return;
      e.preventDefault();
      switch (action.dataset.popoverAction) {
        case "reset-trim":
          commitTrimAction(resetTrim, "Reset trim");
          break;
        case "snap-playhead":
          snapPlayhead();
          break;
      }
      close();
    });

    setTimeout(() => {
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onKey);
    }, 0);
  });
}

function renderMorePopover() {
  const popover = document.createElement("div");
  popover.className = "player-more-popover";
  popover.setAttribute("role", "menu");
  popover.innerHTML = `
    <div class="popover-section">
      <div class="popover-label">Playback Speed</div>
      <div class="popover-segmented" data-popover-segmented="speed">
        ${SPEED_PRESETS.map(
          (s) => `<button data-speed="${s}">${s === 1 ? "1×" : `${s}×`}</button>`
        ).join("")}
      </div>
    </div>
    <div class="popover-section">
      <div class="popover-label">Duration Unit</div>
      <div class="popover-segmented" data-popover-segmented="unit">
        <button data-unit="frame">Frame</button>
        <button data-unit="second">Second</button>
      </div>
    </div>
    <div class="popover-section">
      <button class="popover-row" data-popover-action="reset-trim">Reset render range</button>
      <button class="popover-row" data-popover-action="snap-playhead">Snap playhead</button>
    </div>
  `;
  renderPopoverState(popover);
  return popover;
}

function renderPopoverState(popover) {
  const { playback, timeline } = getState();
  const speed = Number(playback.speed) || 1;
  const unit = timeline?.durationUnit === "second" ? "second" : "frame";
  for (const btn of popover.querySelectorAll("[data-speed]")) {
    btn.classList.toggle("is-active", Number(btn.dataset.speed) === speed);
  }
  for (const btn of popover.querySelectorAll("[data-unit]")) {
    btn.classList.toggle("is-active", btn.dataset.unit === unit);
  }
}

function positionMorePopover(popover, anchor) {
  const a = anchor.getBoundingClientRect();
  const margin = 6;
  // Render in viewport coords (popover is appended to body).
  popover.style.position = "fixed";
  popover.style.right = `${Math.max(8, window.innerWidth - a.right)}px`;
  popover.style.bottom = `${Math.max(8, window.innerHeight - a.top + margin)}px`;
}


function commitTrimAction(action, label) {
  const before = pickTrimState();
  action();
  const after = pickTrimState();
  if (before.trimStart === after.trimStart && before.trimEnd === after.trimEnd) return;

  pushHistory({
    label,
    undo: () => dispatch("playback", before),
    redo: () => dispatch("playback", after),
  });
}

function pickTrimState() {
  const { trimStart, trimEnd } = getState().playback;
  return { trimStart, trimEnd };
}

// Subscribers ------------------------------------------------------

function onSourceChange(source) {
  renderAnimationTimeline();
  onPlaybackChange(getState().playback);
  if (!source.loaded) return;
}

function formatSeconds(t) {
  if (!Number.isFinite(t)) return "0.00s";
  return t.toFixed(2) + "s";
}

function onPlaybackChange(playback) {
  const { source, timeline } = getState();
  const duration = resolveTimelineDuration(timeline, source);
  const fps = timelineFrameRate(timeline, source.fps);
  const unit = timeline?.durationUnit === "second" ? "second" : "frame";

  if (!playerEls.playBtn) cachePlayerEls();

  if (playerEls.playBtn) playerEls.playBtn.textContent = playback.playing ? "⏸" : "▶";
  if (playerEls.loopPill) playerEls.loopPill.classList.toggle("is-active", !!playback.loopEnabled);

  if (playerEls.timeReadout) {
    playerEls.timeReadout.textContent =
      unit === "second"
        ? formatSecondReadout(playback.currentTime, duration)
        : formatFrameReadout(playback.currentTime, fps, duration);
  }

  if (playerEls.durationInput && document.activeElement !== playerEls.durationInput) {
    if (duration > 0) {
      playerEls.durationInput.value =
        unit === "second" ? duration.toFixed(2) : String(durationToFrames(duration, fps));
    } else {
      playerEls.durationInput.value = "";
    }
  }

  updateAnimationPlayhead(playback, duration);
}

function onViewChange(view) {
  if (!playerEls.compareSeg) cachePlayerEls();
  if (!playerEls.compareSeg) return;
  const compare = normalizeCompareMode(view.compare);
  if (compare !== view.compare) {
    dispatch("view", { compare });
    return;
  }
  for (const btn of playerEls.compareButtons) {
    const active = btn.dataset.mode === compare;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }

  for (const el of playerEls.compareReadouts) {
    el.textContent = formatCompareMode(compare);
  }
}


function renderAnimationTimeline() {
  if (!playerEls.propertyList) cachePlayerEls();
  if (!playerEls.propertyList) return;

  const { graph, playback, source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const duration = resolveTimelineDuration(normalized, source);
  const fps = timelineFrameRate(normalized, source.fps);
  const tracks = normalized.tracks;

  const autokey = normalized.autokey === true;
  if (playerEls.autokeyPill) {
    playerEls.autokeyPill.classList.toggle("is-active", autokey);
  }

  // Properties Panel
  playerEls.propertyList.innerHTML = tracks.length === 0 
    ? `<li class="animation-timeline-empty" style="padding:0 8px; font-size:10px; color:var(--text-muted)">No properties</li>`
    : tracks.map((track) => renderPropertyCard(track, graph, selectedPropertyTrackId)).join("");

  // Timeline Lane
  const activeTrack = tracks.find(t => t.id === selectedPropertyTrackId) || (tracks.length > 0 ? tracks[0] : null);
  if (activeTrack && selectedPropertyTrackId !== activeTrack.id) {
    selectedPropertyTrackId = activeTrack.id;
  }

  if (tracks.length === 0 || !activeTrack) {
    playerEls.laneHost.innerHTML = "";
    playerEls.emptyState.classList.remove("hidden");
    playerEls.timeRuler.innerHTML = "";
  } else {
    playerEls.emptyState.classList.add("hidden");
    const selected = getSelectedTimelineKeyframe(normalized);
    playerEls.laneHost.innerHTML = renderAnimationLane(activeTrack, duration, fps, selected);
    renderTimeRuler(duration);
  }
  
  updateAnimationPlayhead(playback, duration);
}

function renderPropertyCard(track, graph, selectedId) {
  const node = graph.nodes.find((item) => item.id === track.nodeId);
  const nodeLabel = node?.label ?? track.nodeId;
  const paramLabel = formatParamLabel(track.binding?.key ?? "value");
  const family = node?.type?.split('-')[0] || "utility";
  
  const isActive = track.id === selectedId;
  return `
    <li class="property-card ${isActive ? "is-active" : ""}" data-track-id="${escapeHtml(track.id)}">
      <div class="property-color" style="background: var(--family-${family}, var(--accent))"></div>
      <span class="property-name" title="${escapeHtml(nodeLabel)} · ${escapeHtml(paramLabel)}">
        ${escapeHtml(nodeLabel)} · ${escapeHtml(paramLabel)}
      </span>
    </li>
  `;
}

function renderTimeRuler(duration) {
  if (!playerEls.timeRuler) return;
  if (duration <= 0) {
    playerEls.timeRuler.innerHTML = "";
    return;
  }
  let html = "";
  let step = Math.max(1, Math.round(duration / 10)); // e.g. 10 ticks
  for(let t=0; t<=duration; t+=step) {
    const pct = (t / duration) * 100;
    html += `
      <div class="time-tick" style="left: ${pct}%">
        <span class="time-tick-label">${t.toFixed(1)}</span>
      </div>
    `;
  }
  playerEls.timeRuler.innerHTML = html;
}

function renderAnimationLane(track, duration, fps, selected) {
  const laneHtml = `
    <div class="animation-track-lane" data-timeline-lane="${escapeHtml(track.id)}">
      ${track.keyframes
          .map((keyframe) => renderKeyframe(keyframe, track, duration, fps, selected))
          .join("")}
    </div>
  `;
  const panelHtml = selected && selected.track.id === track.id ? renderSelectedKeyframePanel(selected) : "";
  return laneHtml + panelHtml;
}

function renderKeyframe(keyframe, track, duration, fps, selected) {
  const time = Number(keyframe.time) || 0;
  const left = timeToTimelinePercent(time, duration, fps);
  const active = selected?.track.id === track.id && selected?.keyframe.id === keyframe.id;
  return `
    <button
      class="animation-keyframe${active ? " is-selected" : ""}"
      type="button"
      style="left:${left}%"
      data-timeline-track-id="${escapeHtml(track.id)}"
      data-timeline-keyframe-id="${escapeHtml(keyframe.id)}"
      data-timeline-time="${time}"
      title="${formatTime(time)}"
      aria-label="Keyframe at ${formatTime(time)}"
    ></button>
  `;
}

function renderSelectedKeyframePanel(selected) {
  const { track, keyframe } = selected;
  const { source, timeline } = getState();
  const fps = timelineFrameRate(timeline, source.fps);
  const value = keyframe.value;
  const numericValue = typeof value === "number" && Number.isFinite(value);
  return `
    <div class="animation-keyframe-panel">
      <label>
        <span>Time · F${timeToFrame(keyframe.time, fps)}</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value="${Number(keyframe.time).toFixed(2)}"
          data-keyframe-field="time"
          data-keyframe-track-id="${escapeHtml(track.id)}"
          data-keyframe-id="${escapeHtml(keyframe.id)}"
        />
      </label>
      <label>
        <span>Value</span>
        ${
          numericValue
            ? `<input
                type="number"
                step="0.01"
                value="${formatNumericInputValue(value)}"
                data-keyframe-field="value"
                data-keyframe-track-id="${escapeHtml(track.id)}"
                data-keyframe-id="${escapeHtml(keyframe.id)}"
              />`
            : `<span class="animation-keyframe-value">${escapeHtml(formatKeyframeValue(value))}</span>`
        }
      </label>
      <label>
        <span>Easing</span>
        <select
          data-keyframe-field="easing"
          data-keyframe-track-id="${escapeHtml(track.id)}"
          data-keyframe-id="${escapeHtml(keyframe.id)}"
        >
          ${renderEasingOptions(keyframe.easing)}
        </select>
      </label>
      <button class="btn animation-keyframe-delete" type="button" data-keyframe-action="delete">Delete</button>
    </div>
  `;
}

function onAnimationTimelinePointerDown(event) {
  const keyframe = event.target.closest(".animation-keyframe[data-timeline-keyframe-id]");
  if (!keyframe) return;

  const lane = keyframe.closest(".animation-track-lane");
  if (!lane) return;

  event.preventDefault();
  event.stopPropagation();

  const { source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const duration = resolveTimelineDuration(normalized, source);
  const fps = timelineFrameRate(normalized, source.fps);
  if (duration <= 0) return;

  selectedTimelineKeyframe = pickTimelineKeyframe(keyframe);
  const selected = getSelectedTimelineKeyframe(normalized);
  if (!selected) return;

  keyframeDrag = {
    trackId: selected.track.id,
    keyframeId: selected.keyframe.id,
    startX: event.clientX,
    duration,
    fps,
    laneRect: lane.getBoundingClientRect(),
    moved: false,
  };

  document.body.classList.add("dragging-keyframe");
  document.addEventListener("pointermove", onAnimationTimelinePointerMove);
  document.addEventListener("pointerup", onAnimationTimelinePointerUp);
  document.addEventListener("pointercancel", onAnimationTimelinePointerUp);
  renderAnimationTimeline();
}

function onAnimationTimelinePointerMove(event) {
  if (!keyframeDrag) return;
  const dx = event.clientX - keyframeDrag.startX;
  if (!keyframeDrag.moved && Math.abs(dx) < KEYFRAME_DRAG_THRESHOLD) return;
  keyframeDrag.moved = true;

  const ratio = clamp(
    (event.clientX - keyframeDrag.laneRect.left) / keyframeDrag.laneRect.width,
    0,
    1
  );
  const time = snapTimeToFrame(ratio * keyframeDrag.duration, keyframeDrag.fps);
  const { timeline } = getState();
  dispatch(
    "timeline",
    moveTimelineKeyframe(timeline, {
      trackId: keyframeDrag.trackId,
      keyframeId: keyframeDrag.keyframeId,
      time,
    })
  );
  seek(time);
}

function onAnimationTimelinePointerUp() {
  if (!keyframeDrag) return;
  keyframeDrag = null;
  document.body.classList.remove("dragging-keyframe");
  document.removeEventListener("pointermove", onAnimationTimelinePointerMove);
  document.removeEventListener("pointerup", onAnimationTimelinePointerUp);
  document.removeEventListener("pointercancel", onAnimationTimelinePointerUp);
}

function onAnimationTimelineChange(event) {
  const control = event.target.closest("[data-keyframe-field]");
  if (!control) return;
  const trackId = control.dataset.keyframeTrackId;
  const keyframeId = control.dataset.keyframeId;
  const field = control.dataset.keyframeField;
  if (!trackId || !keyframeId || !field) return;

  const { timeline } = getState();
  if (field === "time") {
    const fps = timelineFrameRate(timeline, getState().source.fps);
    const nextTime = snapTimeToFrame(Math.max(0, Number(control.value) || 0), fps);
    dispatch("timeline", moveTimelineKeyframe(timeline, { trackId, keyframeId, time: nextTime }));
    seek(nextTime);
    return;
  }

  if (field === "value") {
    dispatch(
      "timeline",
      updateTimelineKeyframe(timeline, {
        trackId,
        keyframeId,
        patch: { value: Number(control.value) || 0 },
      })
    );
    return;
  }

  if (field === "easing") {
    dispatch(
      "timeline",
      updateTimelineKeyframe(timeline, {
        trackId,
        keyframeId,
        patch: { easing: control.value },
      })
    );
  }
}

function deleteSelectedKeyframe() {
  if (!selectedTimelineKeyframe) return;
  const { timeline } = getState();
  dispatch("timeline", removeTimelineKeyframeById(timeline, selectedTimelineKeyframe));
  selectedTimelineKeyframe = null;
}

function pickTimelineKeyframe(element) {
  return {
    trackId: element.dataset.timelineTrackId ?? element.dataset.keyframeTrackId ?? "",
    keyframeId: element.dataset.timelineKeyframeId ?? element.dataset.keyframeId ?? "",
  };
}

function getSelectedTimelineKeyframe(timeline = getState().timeline) {
  if (!selectedTimelineKeyframe?.trackId || !selectedTimelineKeyframe?.keyframeId) return null;
  const selected = getTimelineKeyframe(
    timeline,
    selectedTimelineKeyframe.trackId,
    selectedTimelineKeyframe.keyframeId
  );
  if (!selected) selectedTimelineKeyframe = null;
  return selected;
}

function renderEasingOptions(value) {
  const current = String(value ?? "linear");
  return [
    ["linear", "Linear"],
    ["ease-in", "Ease In"],
    ["ease-out", "Ease Out"],
    ["ease-in-out", "Ease In Out"],
    ["hold", "Hold"],
  ]
    .map(([optionValue, label]) => `
      <option value="${optionValue}" ${optionValue === current ? "selected" : ""}>${label}</option>
    `)
    .join("");
}

function updateAnimationPlayhead(playback, sourceDuration) {
  if (!playerEls.playerCard) return;
  const { source, timeline } = getState();
  const fps = timelineFrameRate(timeline, source.fps);
  const duration = resolveTimelineDuration(timeline, { duration: sourceDuration });
  const playhead = playerEls.playerCard.querySelector(".playhead");
  if (!playhead) return;
  const left = timeToTimelinePercent(playback.currentTime, duration, fps);
  playhead.style.left = `${left}%`;
}

function resolveTimelineDuration(timeline, source) {
  const timelineDuration = Number(timeline?.duration);
  if (Number.isFinite(timelineDuration) && timelineDuration > 0) return timelineDuration;
  const sourceDuration = Number(source?.duration);
  return Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : 0;
}

function formatTrackCount(count) {
  if (count === 0) return "0 tracks";
  if (count === 1) return "1 track";
  return `${count} tracks`;
}

function timeToTimelinePercent(time, duration, fps) {
  if (duration <= 0) return 0;
  const totalFrames = durationToFrames(duration, fps);
  const frame = Math.min(totalFrames, timeToFrame(time, fps));
  return clamp((frame / totalFrames) * 100, 0, 100);
}

function formatParamLabel(key) {
  return String(key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatNumericInputValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatKeyframeValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function formatCompareMode(value) {
  return normalizeCompareMode(value)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeCompareMode(value) {
  return COMPARE_MODES.has(value) ? value : "processed";
}
