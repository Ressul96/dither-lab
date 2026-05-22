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
} from "../source.js";
import {
  TIMELINE_BINDING_NODE_PARAM,
  TIMELINE_BINDING_NODE_PROPERTY,
  TIMELINE_EASING_PRESETS,
  createTimelineTrackId,
  duplicateTimelineKeyframes,
  durationToFrames,
  findMatchingEasingPreset,
  formatFrameReadout,
  formatSecondReadout,
  getTimelineKeyframe,
  getTimelineEasingPreset,
  moveTimelineKeyframe,
  moveTimelineKeyframes,
  normalizeTimeline,
  pasteTimelineKeyframes,
  removeTimelineKeyframeById,
  setSelectedProperty,
  setTimelinePanelOpen,
  setTimelineZoom,
  setTrackExpanded,
  setTimelineAutokey,
  setViewMode,
  snapTimeToFrame,
  snapshotTimelineKeyframes,
  timeToFrame,
  timelineFrameRate,
  toggleTimelineKeyframeAtCurrentTime,
  toggleTrackExpanded,
  updateTimelineKeyframe,
  updateTimelineTrack,
} from "../timeline.js";
import { escapeHtml } from "./utils.js";
import { listenWithDispose } from "./lifecycle.js";
import {
  cachePlayerEls,
  getPlayerEls,
  initPlayerElements,
} from "./player-elements.js";
import { initPlayerCompare } from "./player-compare.js";
import { initPlayerMoreMenu } from "./player-more-menu.js";
import {
  buildTimelineProperties,
  getTimelineBindingColor,
  getTimelineTargetBaseValue,
  getTrackDisplayMeta,
  initPlayerTimelineTargets,
  safeCssColor,
} from "./player-timeline-targets.js";
import {
  GRAPH_EDITOR_HEIGHT,
  createGraphCurveModel,
  getSegmentInterpolation,
  graphValueFromY,
  initPlayerGraphEditor,
  normalizeGraphTangent,
  pickGraphTrack,
  renderGraphEditor,
  resolveGraphTangent,
} from "./player-graph-editor.js";
import {
  clampBezierControlValue,
  formatBezierControlValue,
  formatKeyframeValue,
  formatNumericInputValue,
  formatPropertyValue,
  formatRulerSecond,
  formatSeconds,
  getMajorTickStep,
  getMinorTickStep,
} from "./player-format.js";
import {
  clearSelection,
  getSelectedKeyframes,
  getSelectedPropertyTrackId,
  getSelectedTimelineKeyframeCursor,
  initPlayerSelection,
  isKeyframeSelected,
  parseSelectionKey,
  pickKeyframeWithModifier,
  replaceSelectedKeyframes,
  selectionKey,
  setSelectedPropertyTrackId,
  setSelectedTimelineKeyframeCursor,
  setSoleSelection,
  toggleKeyframeSelection,
} from "./player-selection.js";

const KEYFRAME_DRAG_THRESHOLD = 3;
const selectedKeyframes = getSelectedKeyframes();
let keyframeDrag = null;
let tangentDrag = null;
let playheadDrag = null;

const playerEls = getPlayerEls();

export function initPlayer() {
  initPlayerElements();
  initPlayerSelection();
  initPlayerTimelineTargets();
  initPlayerGraphEditor();
  bindAction("restart", restart);
  bindAction("prev-frame", () => stepFrame(-1));
  bindAction("toggle-play", togglePlay, { pointerDown: true });
  bindAction("next-frame", () => stepFrame(1));
  bindAction("last-frame", goToLastFrame);
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

  initPlayerCompare({ subscribe });
  wireAnimationTimeline();
  initPlayerMoreMenu({
    clamp,
    commitTrimAction,
    resolveTimelineDuration,
  });

  cachePlayerEls();
  wireTimelineDragHandle();
  subscribe("source", onSourceChange);
  subscribe("playback", onPlaybackChange);
  subscribe("timeline", (slot) => {
    renderAnimationTimeline(slot);
    // Keep the bezier popover SVG in sync with handle drags / undo / preset
    // clicks while it's open. `renderBezierPopoverContent` no-ops when there
    // is no open popover and gracefully closes itself if the underlying
    // keyframe has been deleted out from under it.
    if (bezierPopover.el) renderBezierPopoverContent();
  });
  subscribe("graph", renderAnimationTimeline);
}

function wireTimelineDragHandle() {
  const card = document.getElementById("playerCard");
  if (!card) return;

  // Inject a thin strip across the top edge. We do this from JS so the HTML
  // template stays unchanged; the handle isn't useful without the JS that
  // backs it, so coupling them keeps the markup honest.
  const handle = document.createElement("div");
  handle.className = "player-card-drag-handle";
  handle.setAttribute("aria-hidden", "true");
  handle.title = "Drag to move timeline";
  card.appendChild(handle);

  let dragOriginX = 0;
  let dragOriginY = 0;
  let cardOriginX = 0;
  let cardOriginY = 0;

  const onPointerMove = (event) => {
    const dx = event.clientX - dragOriginX;
    const dy = event.clientY - dragOriginY;
    card.style.setProperty("--drag-x", `${cardOriginX + dx}px`);
    card.style.setProperty("--drag-y", `${cardOriginY + dy}px`);
  };

  const onPointerUp = (event) => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    card.classList.remove("is-dragging");
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {}
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragOriginX = event.clientX;
    dragOriginY = event.clientY;
    // Read current drag offsets from CSS custom properties so successive
    // drags accumulate instead of snapping back to centre each time.
    const styles = getComputedStyle(card);
    cardOriginX = parseFloat(styles.getPropertyValue("--drag-x")) || 0;
    cardOriginY = parseFloat(styles.getPropertyValue("--drag-y")) || 0;
    card.classList.add("is-dragging");
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {}
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  });
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


function wireAnimationTimeline() {
  const timelineEl = document.getElementById("playerCard");
  if (!timelineEl) return;
  timelineEl.addEventListener("pointerdown", onAnimationTimelinePointerDown);
  listenWithDispose(timelineEl, "keydown", onAnimationTimelineKeyDown);
  timelineEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-tangent-handle]")) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const autokey = event.target.closest('[data-action="toggle-autokey"]');
    if (autokey) {
      event.preventDefault();
      event.stopPropagation();
      const next = getState().timeline.autokey !== true;
      setTimelineAutokey(next);
      return;
    }

    const panelToggle = event.target.closest('[data-action="toggle-timeline-panel"]');
    if (panelToggle) {
      event.preventDefault();
      event.stopPropagation();
      setTimelinePanelOpen(getState().timeline.panelOpen === false);
      return;
    }

    const viewButton = event.target.closest("[data-timeline-view]");
    if (viewButton) {
      event.preventDefault();
      event.stopPropagation();
      setViewMode(viewButton.dataset.timelineView);
      return;
    }

    const zoomButton = event.target.closest("[data-timeline-zoom]");
    if (zoomButton) {
      event.preventDefault();
      event.stopPropagation();
      adjustTimelineZoom(zoomButton.dataset.timelineZoom);
      return;
    }

    const curvePreset = event.target.closest("[data-curve-preset]");
    if (curvePreset) {
      event.preventDefault();
      event.stopPropagation();
      applyCurvePreset(curvePreset);
      return;
    }

    const keyToggle = event.target.closest("[data-track-key-toggle]");
    if (keyToggle) {
      event.preventDefault();
      event.stopPropagation();
      togglePropertyKeyframe(keyToggle);
      return;
    }

    const enableToggle = event.target.closest("[data-track-enable-toggle]");
    if (enableToggle) {
      event.preventDefault();
      event.stopPropagation();
      togglePropertyTrackEnabled(enableToggle);
      return;
    }

    const bezierTrigger = event.target.closest("[data-bezier-trigger]");
    if (bezierTrigger) {
      event.preventDefault();
      event.stopPropagation();
      openBezierPopover(
        bezierTrigger,
        bezierTrigger.dataset.keyframeTrackId,
        bezierTrigger.dataset.keyframeId
      );
      return;
    }

    const trackToggle = event.target.closest("[data-track-toggle]");
    if (trackToggle) {
      event.preventDefault();
      event.stopPropagation();
      const trackId = trackToggle.dataset.trackToggle;
      setSelectedPropertyTrackId(trackId);
      setSelectedProperty(trackId);
      toggleTrackExpanded(trackId);
      return;
    }

    const propCard = event.target.closest(".property-card");
    if (propCard) {
      event.preventDefault();
      event.stopPropagation();
      const trackId = propCard.dataset.trackId;
      setSelectedPropertyTrackId(trackId);
      setSelectedProperty(trackId);
      setTrackExpanded(trackId, true);
      return;
    }

    const deleteButton = event.target.closest("[data-keyframe-action='delete']");
    if (deleteButton) {
      deleteSelectedKeyframe();
      return;
    }

    const resetTangentsButton = event.target.closest("[data-keyframe-action='reset-tangents']");
    if (resetTangentsButton) {
      resetSelectedKeyframeTangents(resetTangentsButton);
      return;
    }

    const timeTarget = event.target.closest("[data-timeline-time]");
    if (timeTarget) {
      const picked = pickTimelineKeyframe(timeTarget);
      pickKeyframeWithModifier(picked.trackId, picked.keyframeId, event);
      renderAnimationTimeline();
      // Only chase the playhead on a plain click — keeping it pinned during
      // multi-select avoids re-seeking every additional shift-click.
      if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
        seek(Number(timeTarget.dataset.timelineTime));
      }
      return;
    }

    const lane = event.target.closest(".animation-track-lane");
    if (!lane) return;
    // A marquee drag just ended on this lane — the user did not intend to
    // click-seek; their selection is the result they want.
    if (marqueeJustEnded) return;
    // Clicking the lane background (not a keyframe) clears multi-selection
    // and seeks the playhead — matches After Effects style.
    clearSelection();
    const { source, timeline } = getState();
    const duration = resolveTimelineDuration(timeline, source);
    if (duration <= 0) {
      renderAnimationTimeline();
      return;
    }
    const fps = timelineFrameRate(timeline, source.fps);
    const rect = lane.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    seek(snapTimeToFrame(ratio * duration, fps));
    renderAnimationTimeline();
  });
  timelineEl.addEventListener("change", onAnimationTimelineChange);
  const body = timelineEl.querySelector(".timeline-pane-body");
  if (body) {
    body.addEventListener("wheel", onTimelineWheel, { passive: false });
    body.addEventListener("scroll", syncTimelineRulerScroll, { passive: true });
  }

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

function adjustTimelineZoom(action) {
  const { source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  if (action === "reset") {
    setTimelineZoom(1);
    return;
  }
  const factor = action === "out" ? 0.8 : 1.25;
  setTimelineZoom(normalized.zoom * factor);
}

function onTimelineWheel(event) {
  if (!(event.altKey || event.metaKey || event.ctrlKey)) return;
  if (event.target.closest("input, select, textarea")) return;
  event.preventDefault();
  const { source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  setTimelineZoom(normalized.zoom * factor);
}

function applyCurvePreset(button) {
  const preset = button.dataset.curvePreset;
  const trackId = button.closest("[data-curve-track-id]")?.dataset.curveTrackId
    ?? button.closest("[data-graph-track-id]")?.dataset.graphTrackId;
  if (!trackId) return;

  const { source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const track = normalized.tracks.find((item) => item.id === trackId);
  if (!track) return;

  const selectedTimelineKeyframe = getSelectedTimelineKeyframeCursor();
  const selectedOnTrack = selectedTimelineKeyframe?.trackId === trackId
    ? track.keyframes.find((keyframe) => keyframe.id === selectedTimelineKeyframe.keyframeId)
    : null;
  const target = selectedOnTrack ?? track.keyframes.find((keyframe, index) =>
    typeof keyframe.value === "number" && index < track.keyframes.length - 1
  );
  if (!target) return;

  const index = track.keyframes.findIndex((keyframe) => keyframe.id === target.id);
  let next = getState().timeline;
  const patches = createCurvePresetPatches(track, index, preset);
  for (const patch of patches) {
    next = updateTimelineKeyframe(next, patch);
  }
  dispatch("timeline", next);
}

function createCurvePresetPatches(track, index, preset) {
  const from = track.keyframes[index];
  if (!from || typeof from.value !== "number") return [];
  return [{
    trackId: track.id,
    keyframeId: from.id,
    patch: createEasingPatch(preset),
  }];
}

function togglePropertyKeyframe(button) {
  const nodeId = button.dataset.nodeId;
  const binding = {
    type: button.dataset.bindingType === TIMELINE_BINDING_NODE_PROPERTY
      ? TIMELINE_BINDING_NODE_PROPERTY
      : TIMELINE_BINDING_NODE_PARAM,
    key: button.dataset.bindingKey,
  };
  const { graph } = getState();
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node || !binding.key) return;

  const value = getTimelineTargetBaseValue(node, binding);
  const changed = toggleTimelineKeyframeAtCurrentTime({ nodeId, binding, value });
  if (!changed) return;
  const trackId = createTimelineTrackId(nodeId, binding);
  setSelectedPropertyTrackId(trackId);
  setSelectedProperty(trackId);
  setTrackExpanded(trackId, true);
}

function togglePropertyTrackEnabled(button) {
  const trackId = button.dataset.trackEnableToggle;
  if (!trackId) return;
  const track = getState().timeline.tracks.find((item) => item.id === trackId);
  if (!track) return;
  dispatch(
    "timeline",
    updateTimelineTrack(getState().timeline, {
      trackId,
      patch: { enabled: track.enabled === false },
    })
  );
  setSelectedPropertyTrackId(trackId);
  setSelectedProperty(trackId);
}

function syncTimelineRulerScroll() {
  if (!playerEls.timeRuler || !playerEls.timelineBody) return;
  playerEls.timeRuler.style.transform = `translateX(${-playerEls.timelineBody.scrollLeft}px)`;
}

// Jump the playhead to the last addressable frame (durationFrames - 1). The
// transport bar's End-frame button and the End keyboard shortcut both call
// through here.
export function goToLastFrame() {
  const { source, timeline } = getState();
  const duration = resolveTimelineDuration(timeline, source);
  if (duration <= 0) return;
  const fps = timelineFrameRate(timeline, source.fps);
  const totalFrames = durationToFrames(duration, fps);
  seek(snapTimeToFrame((totalFrames - 1) / fps, fps));
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

function onPlaybackChange(playback) {
  const { source, timeline } = getState();
  const duration = resolveTimelineDuration(timeline, source);
  const fps = timelineFrameRate(timeline, source.fps);
  const unit = timeline?.durationUnit === "second" ? "second" : "frame";

  if (!playerEls.playBtn) cachePlayerEls();

  if (playerEls.playBtn) playerEls.playBtn.textContent = playback.playing ? "⏸" : "▶";
  if (playerEls.loopPill) {
    const on = !!playback.loopEnabled;
    playerEls.loopPill.classList.toggle("is-active", on);
    playerEls.loopPill.setAttribute("aria-pressed", on ? "true" : "false");
  }

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
  const targets = buildTimelineProperties(graph, normalized, playback, source);

  const autokey = normalized.autokey === true;
  if (playerEls.autokeyPill) {
    playerEls.autokeyPill.classList.toggle("is-active", autokey);
    playerEls.autokeyPill.setAttribute("aria-pressed", autokey ? "true" : "false");
  }

  updateTimelineChrome(normalized);

  const selectedPropertyTrackId = getSelectedPropertyTrackId();
  const selectedId = targets.some((target) => target.id === normalized.selectedPropertyId)
    ? normalized.selectedPropertyId
    : selectedPropertyTrackId;
  const activeTarget = targets.find((target) => target.id === selectedId) || (targets.length > 0 ? targets[0] : null);
  if (activeTarget && selectedPropertyTrackId !== activeTarget.id) {
    setSelectedPropertyTrackId(activeTarget.id);
  }
  const activeTrack = activeTarget?.track ?? null;
  const activeId = activeTarget?.id ?? null;
  const expandedIds = new Set(normalized.expandedTrackIds ?? []);
  const visibleTargets = targets.filter((target) => expandedIds.has(target.id));
  const visibleTracks = visibleTargets.map((target) => target.track);

  playerEls.propertyList.innerHTML = targets.length === 0
    ? `<li class="animation-timeline-empty">${graph.selectedNodeId ? "No animatable properties" : "Select a node"}</li>`
    : targets
        .map((target) =>
          renderPropertyCard(target, {
            graph,
            timeline: normalized,
            playback,
            source,
            activeId,
            expandedIds,
          })
        )
        .join("");

  if (!playerEls.laneHost || !playerEls.emptyState) return;
  renderTimeRuler(duration, fps, normalized.durationUnit, normalized.zoom);
  const selected = getSelectedTimelineKeyframe(normalized);

  if (targets.length === 0) {
    playerEls.laneHost.innerHTML = "";
    playerEls.emptyState.textContent = graph.selectedNodeId ? "No animatable properties" : "Select a node";
    playerEls.emptyState.classList.remove("hidden");
  } else if (normalized.viewMode === "graph") {
    const graphTrack = pickGraphTrack(activeTrack, visibleTracks);
    if (!graphTrack) {
      playerEls.laneHost.innerHTML = "";
      playerEls.emptyState.textContent = "Select a track";
      playerEls.emptyState.classList.remove("hidden");
    } else {
      playerEls.laneHost.innerHTML =
        renderRenderRangeOverlay(duration, playback) +
        renderGraphEditor(graphTrack, duration, fps, selected, graph, playback, visibleTracks);
      playerEls.emptyState.classList.add("hidden");
    }
  } else if (visibleTracks.length === 0) {
    playerEls.laneHost.innerHTML = "";
    playerEls.emptyState.textContent = "No lanes open";
    playerEls.emptyState.classList.remove("hidden");
  } else {
    playerEls.emptyState.classList.add("hidden");
    playerEls.laneHost.innerHTML =
      renderRenderRangeOverlay(duration, playback) +
      visibleTargets
        .map((target) => renderAnimationLane(target, duration, fps, selected, graph))
        .join("");
  }

  updateAnimationPlayhead(playback, duration);
}

function updateTimelineChrome(timeline) {
  const effectiveZoom = getEffectiveTimelineZoom(timeline);
  const contentWidth = `${effectiveZoom * 100}%`;
  const timelinePane = playerEls.timelinePane ?? playerEls.playerCard;
  if (timelinePane) {
    timelinePane.style.setProperty("--timeline-content-width", contentWidth);
    timelinePane.style.setProperty("--timeline-zoom", String(effectiveZoom));
    timelinePane.classList.toggle("is-graph-mode", timeline.viewMode === "graph");
  }
  if (playerEls.playerCard) {
    const panelOpen = timeline.panelOpen !== false;
    playerEls.playerCard.classList.toggle("is-collapsed", !panelOpen);
    playerEls.playerCard.setAttribute("aria-expanded", panelOpen ? "true" : "false");
  }
  if (playerEls.panelToggle) {
    const panelOpen = timeline.panelOpen !== false;
    playerEls.panelToggle.textContent = panelOpen ? "▾" : "▴";
    playerEls.panelToggle.setAttribute("aria-expanded", panelOpen ? "true" : "false");
    playerEls.panelToggle.setAttribute("aria-label", panelOpen ? "Collapse timeline" : "Expand timeline");
    playerEls.panelToggle.setAttribute("title", panelOpen ? "Collapse timeline" : "Expand timeline");
  }
  for (const button of playerEls.viewButtons ?? []) {
    const active = button.dataset.timelineView === timeline.viewMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (playerEls.zoomReadout) {
    playerEls.zoomReadout.textContent = `${Math.round(timeline.zoom * 100)}%`;
  }
}

function renderPropertyCard(target, context) {
  const { activeId, expandedIds } = context;
  const track = target.track;
  const meta = target.meta;
  const valueLabel = formatPropertyValue(target.currentValue);
  const isActive = target.id === activeId;
  const isExpanded = expandedIds.has(target.id);
  const isDisabled = target.hasTrack && track.enabled === false;
  const keyLabel = target.keyed ? "Remove keyframe" : "Set keyframe";
  const enableLabel = track.enabled === false ? "Enable track" : "Disable track";

  return `
    <li
      class="property-card ${isActive ? "is-active" : ""} ${isExpanded ? "is-expanded" : ""} ${isDisabled ? "is-disabled" : ""} ${target.hasTrack ? "" : "is-virtual"}"
      style="--track-color:${escapeHtml(safeCssColor(target.color))}"
      data-track-id="${escapeHtml(target.id)}"
      aria-selected="${isActive ? "true" : "false"}"
    >
      <button
        class="property-chevron"
        type="button"
        data-track-toggle="${escapeHtml(target.id)}"
        aria-label="Toggle ${escapeHtml(meta.label)} lane"
        aria-expanded="${isExpanded ? "true" : "false"}"
      >
        <span aria-hidden="true">›</span>
      </button>
      <button
        class="property-key-toggle${target.hasTrack ? " is-animated" : ""}${target.keyed ? " is-keyed" : ""}"
        type="button"
        data-track-key-toggle="${escapeHtml(target.id)}"
        data-node-id="${escapeHtml(target.nodeId)}"
        data-binding-type="${escapeHtml(target.binding.type)}"
        data-binding-key="${escapeHtml(target.binding.key)}"
        aria-label="${keyLabel}"
        title="${keyLabel}"
      ></button>
      <div class="property-color"></div>
      <span class="property-copy" title="${escapeHtml(meta.nodeLabel)} · ${escapeHtml(meta.paramLabel)}">
        <span class="property-name">${escapeHtml(meta.paramLabel)}</span>
        <span class="property-node">${escapeHtml(meta.nodeLabel)} · ${escapeHtml(target.group)}</span>
      </span>
      <button
        class="property-enable-toggle"
        type="button"
        data-track-enable-toggle="${escapeHtml(track.id)}"
        aria-label="${enableLabel}"
        title="${enableLabel}"
        ${target.hasTrack ? "" : "disabled"}
      >
        <span aria-hidden="true"></span>
      </button>
      <span class="property-value" title="${escapeHtml(valueLabel)}">${escapeHtml(valueLabel)}</span>
    </li>
  `;
}

function renderTimeRuler(duration, fps, unit, zoom) {
  if (!playerEls.timeRuler) return;
  if (duration <= 0) {
    playerEls.timeRuler.innerHTML = "";
    return;
  }
  const majorStep = getMajorTickStep(duration / getEffectiveTimelineZoom({ zoom }));
  const minorStep = getMinorTickStep(majorStep);
  const safeDuration = Math.max(1 / Math.max(1, fps), duration);
  const ticks = [];
  const maxTickCount = 260;
  const pushTick = (time, major) => {
    const clampedTime = clamp(time, 0, safeDuration);
    const duplicate = ticks.some((tick) => Math.abs(tick.time - clampedTime) < 0.0005);
    if (duplicate) {
      const existing = ticks.find((tick) => Math.abs(tick.time - clampedTime) < 0.0005);
      if (existing) existing.major = existing.major || major;
      return;
    }
    ticks.push({ time: clampedTime, major });
  };

  for (let time = 0, index = 0; time <= safeDuration + 0.0005 && index < maxTickCount; time += minorStep, index++) {
    const major = Math.abs(time / majorStep - Math.round(time / majorStep)) < 0.0005;
    pushTick(time, major);
  }
  pushTick(safeDuration, true);
  ticks.sort((a, b) => a.time - b.time);

  let html = "";
  for (const tick of ticks) {
    const pct = (tick.time / safeDuration) * 100;
    const frame = timeToFrame(tick.time, fps);
    const label = formatRulerSecond(tick.time);
    const className = tick.major ? "time-tick time-tick--major" : "time-tick time-tick--minor";
    html += `
      <div class="${className}" style="left: ${pct}%" title="F${frame} · ${escapeHtml(formatSeconds(tick.time))}">
        ${tick.major ? `<span class="time-tick-label">${escapeHtml(label)}</span>` : ""}
      </div>
    `;
  }
  playerEls.timeRuler.innerHTML = html;
  syncTimelineRulerScroll();
}

function renderAnimationLane(target, duration, fps, selected, graph) {
  const track = target.track ?? target;
  const meta = target.meta ?? getTrackDisplayMeta(track, graph);
  const selectedHere = selected && selected.track.id === track.id;
  const laneHtml = `
    <div
      class="animation-lane-row ${selectedHere ? "is-active" : ""} ${track.enabled === false ? "is-disabled" : ""}"
      style="--track-color:${escapeHtml(safeCssColor(target.color ?? getTimelineBindingColor(track.binding, meta.node)))}"
    >
      <div
        class="animation-track-lane"
        data-timeline-lane="${escapeHtml(track.id)}"
        title="${escapeHtml(meta.nodeLabel)} · ${escapeHtml(meta.paramLabel)}"
      >
        ${track.keyframes
            .map((keyframe) => renderKeyframe(keyframe, track, duration, fps, selected))
            .join("")}
      </div>
    </div>
  `;
  const panelHtml = selected && selected.track.id === track.id ? renderSelectedKeyframePanel(selected) : "";
  return laneHtml + panelHtml;
}

function renderRenderRangeOverlay(duration, playback) {
  if (!(duration > 0)) return "";
  const start = clamp(playback.trimStart || 0, 0, duration);
  const end = clamp(playback.trimEnd || duration, start, duration);
  const left = (start / duration) * 100;
  const width = Math.max(0, ((end - start) / duration) * 100);
  return `
    <div class="render-range-overlay" aria-hidden="true">
      <div class="render-range-muted render-range-muted--before" style="width:${left}%"></div>
      <div class="render-range-band" style="left:${left}%; width:${width}%">
        <span class="render-range-handle render-range-handle--start"></span>
        <span class="render-range-handle render-range-handle--end"></span>
      </div>
      <div class="render-range-muted render-range-muted--after" style="left:${left + width}%; width:${100 - left - width}%"></div>
    </div>
  `;
}

function getTrackBaseValue(track, node) {
  const key = track.binding?.key;
  if (!key || !node) return undefined;
  if (track.binding?.type === TIMELINE_BINDING_NODE_PROPERTY) return getTimelineTargetBaseValue(node, track.binding);
  if (track.binding?.type === TIMELINE_BINDING_NODE_PARAM) return getTimelineTargetBaseValue(node, track.binding);
  return node.params?.[key] ?? node[key];
}

function renderKeyframe(keyframe, track, duration, fps, _selected) {
  const time = Number(keyframe.time) || 0;
  const left = timeToTimelinePercent(time, duration, fps);
  const active = isKeyframeSelected(track.id, keyframe.id);
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
      <label class="bezier-trigger-field">
        <span>Easing</span>
        ${renderBezierTriggerButton(track, keyframe)}
      </label>
      <button class="btn animation-keyframe-delete" type="button" data-keyframe-action="delete">Delete</button>
    </div>
    ${renderTangentInputs(track, keyframe)}
  `;
}

// Compact preview button that replaces the legacy easing <select>. Shows a
// thumbnail curve and the current preset name; clicking it opens the bezier
// popover so the user can drag control points or pick a preset.
function renderBezierTriggerButton(track, keyframe) {
  const easing = keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const isStep = easing.type === "step";
  const cp = isStep ? [0, 0, 1, 1] : (easing.controlPoints ?? [0, 0, 1, 1]);
  const presetMatch = isStep ? "step" : findMatchingEasingPreset(easing);
  const presetMeta = presetMatch === "step"
    ? { label: "Step" }
    : (presetMatch ? getTimelineEasingPreset(presetMatch) : null);
  const label = presetMeta?.label ?? "Custom";
  const x1 = cp[0] * 100, y1 = (1 - cp[1]) * 100;
  const x2 = cp[2] * 100, y2 = (1 - cp[3]) * 100;
  const curveD = isStep
    ? "M 0 100 L 100 100 L 100 0"
    : `M 0 100 C ${x1.toFixed(2)} ${y1.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}, 100 0`;
  return `
    <button
      type="button"
      class="bezier-trigger"
      data-bezier-trigger
      data-keyframe-track-id="${escapeHtml(track.id)}"
      data-keyframe-id="${escapeHtml(keyframe.id)}"
      aria-haspopup="dialog"
    >
      <svg viewBox="-10 -10 120 120" aria-hidden="true">
        <path d="${curveD}" />
      </svg>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function renderTangentInputs(track, keyframe) {
  const index = track.keyframes.findIndex((item) => item.id === keyframe.id);
  const isBezier =
    getSegmentInterpolation(keyframe, track) === "bezier" ||
    getSegmentInterpolation(track.keyframes[index - 1], track) === "bezier";
  if (!isBezier || typeof keyframe.value !== "number") return "";
  const inn = resolveGraphTangent(track, index, "in");
  const out = resolveGraphTangent(track, index, "out");
  return `
    <div class="animation-tangent-panel">
      ${renderTangentInput("inTangent.dt", "In dt", inn.dt, track.id, keyframe.id)}
      ${renderTangentInput("inTangent.dv", "In dv", inn.dv, track.id, keyframe.id)}
      ${renderTangentInput("outTangent.dt", "Out dt", out.dt, track.id, keyframe.id)}
      ${renderTangentInput("outTangent.dv", "Out dv", out.dv, track.id, keyframe.id)}
      <button class="btn animation-tangent-reset" type="button" data-keyframe-action="reset-tangents">Auto</button>
    </div>
  `;
}

function renderTangentInput(field, label, value, trackId, keyframeId) {
  return `
    <label>
      <span>${label}</span>
      <input
        type="number"
        step="0.01"
        value="${formatNumericInputValue(value)}"
        data-keyframe-field="${field}"
        data-keyframe-track-id="${escapeHtml(trackId)}"
        data-keyframe-id="${escapeHtml(keyframeId)}"
      />
    </label>
  `;
}

function onAnimationTimelinePointerDown(event) {
  const playheadHandle = event.target.closest(".playhead-handle");
  if (playheadHandle) {
    startPlayheadDrag(playheadHandle, event);
    return;
  }

  const tangentHandle = event.target.closest("[data-tangent-handle]");
  if (tangentHandle) {
    if (event.metaKey || event.ctrlKey) {
      resetTangentHandle(tangentHandle, event);
    } else {
      startTangentDrag(tangentHandle, event);
    }
    return;
  }

  const keyframe = event.target.closest(
    ".animation-keyframe[data-timeline-keyframe-id], .animation-graph-keyframe[data-timeline-keyframe-id]"
  );
  if (!keyframe) {
    // No keyframe under the pointer — try starting a marquee selection if
    // the pointer is on a lane background.
    const laneBg = event.target.closest(".animation-track-lane");
    if (laneBg) startMarqueeDrag(laneBg, event);
    return;
  }

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

  const picked = pickTimelineKeyframe(keyframe);
  // Pointerdown selection rules:
  //   - shift / cmd / ctrl: toggle this keyframe in/out of the set
  //   - otherwise, if it's already selected (multi-drag scenario), keep
  //     the existing set so the whole selection drags as a chord
  //   - plain click on an unselected keyframe: replace selection with it
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    toggleKeyframeSelection(picked.trackId, picked.keyframeId);
  } else if (!isKeyframeSelected(picked.trackId, picked.keyframeId)) {
    setSoleSelection(picked.trackId, picked.keyframeId);
  } else {
    setSelectedTimelineKeyframeCursor(picked);
  }

  const selected = getSelectedTimelineKeyframe(normalized);
  if (!selected) return;

  // Snapshot every selected keyframe's starting time so the drag can apply a
  // single delta across the chord. Falls back to just the picked one when the
  // multi-set is empty (defensive — shouldn't happen because we just selected
  // it, but keeps the single-drag path identical to before).
  const selectionSnapshot = [];
  for (const key of selectedKeyframes) {
    const { trackId: sTrackId, keyframeId: sKeyframeId } = parseSelectionKey(key);
    const found = getTimelineKeyframe(normalized, sTrackId, sKeyframeId);
    if (!found) continue;
    selectionSnapshot.push({
      trackId: sTrackId,
      keyframeId: sKeyframeId,
      originalTime: found.keyframe.time,
    });
  }
  if (selectionSnapshot.length === 0) {
    selectionSnapshot.push({
      trackId: selected.track.id,
      keyframeId: selected.keyframe.id,
      originalTime: selected.keyframe.time,
    });
  }

  keyframeDrag = {
    trackId: selected.track.id,
    keyframeId: selected.keyframe.id,
    startX: event.clientX,
    duration,
    fps,
    laneRect: lane.getBoundingClientRect(),
    moved: false,
    pickedOriginalTime: selected.keyframe.time,
    selectionSnapshot,
  };

  document.body.classList.add("dragging-keyframe");
  document.addEventListener("pointermove", onAnimationTimelinePointerMove);
  document.addEventListener("pointerup", onAnimationTimelinePointerUp);
  document.addEventListener("pointercancel", onAnimationTimelinePointerUp);
  renderAnimationTimeline();
}

function onAnimationTimelineKeyDown(event) {
  const playheadHandle = event.target.closest(".playhead-handle");
  if (playheadHandle && handlePlayheadKeyDown(event)) return;
}

function handlePlayheadKeyDown(event) {
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
  const duration = resolveTimelineDuration(normalized, source);
  if (duration <= 0) return true;

  const fps = timelineFrameRate(normalized, source.fps);
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
  const trimStart = clamp(Number(playback.trimStart) || 0, 0, duration);
  const trimEnd = clamp(Number(playback.trimEnd) || duration, trimStart, duration);
  const maxTime = Math.max(trimStart, trimEnd - 1 / Math.max(1, fps));
  const currentTime = Number.isFinite(Number(playback.currentTime)) ? Number(playback.currentTime) : 0;
  pausePlayback();
  seek(clamp(currentTime + (direction * multiplier) / Math.max(1, fps), trimStart, maxTime));
  return true;
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
  const delta = time - keyframeDrag.pickedOriginalTime;
  const { timeline } = getState();
  if (keyframeDrag.selectionSnapshot.length > 1) {
    const moves = keyframeDrag.selectionSnapshot.map((item) => ({
      trackId: item.trackId,
      keyframeId: item.keyframeId,
      time: Math.max(0, item.originalTime + delta),
    }));
    dispatch("timeline", moveTimelineKeyframes(timeline, moves));
  } else {
    dispatch(
      "timeline",
      moveTimelineKeyframe(timeline, {
        trackId: keyframeDrag.trackId,
        keyframeId: keyframeDrag.keyframeId,
        time,
      })
    );
  }
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

function startPlayheadDrag(handle, event) {
  if (event.button !== 0 && event.button !== undefined) return;
  event.preventDefault();
  event.stopPropagation();

  const { source, timeline, playback } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const duration = resolveTimelineDuration(normalized, source);
  if (duration <= 0) return;

  const body = handle.closest(".timeline-pane-body");
  if (!body) return;

  playheadDrag = {
    body,
    duration,
    fps: timelineFrameRate(normalized, source.fps),
    handle,
    pointerId: event.pointerId,
    wasPlaying: playback.playing === true,
  };
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
  playheadDrag = null;
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
  const x = clamp(event.clientX - rect.left + drag.body.scrollLeft, 0, contentWidth);
  const ratio = clamp(x / contentWidth, 0, 1);
  const time = snapTimeToFrame(ratio * drag.duration, drag.fps);
  seek(time);
  updatePlayheadTooltip(time, drag.fps);
}

function startTangentDrag(handle, event) {
  event.preventDefault();
  event.stopPropagation();

  const trackId = handle.dataset.timelineTrackId;
  const keyframeId = handle.dataset.timelineKeyframeId;
  const side = handle.dataset.tangentHandle === "in" ? "in" : "out";
  const { source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const found = getTimelineKeyframe(normalized, trackId, keyframeId);
  if (!found || typeof found.keyframe.value !== "number") return;

  const graphSvg = handle.closest(".timeline-graph-svg");
  const model = createGraphCurveModel(found.track, resolveTimelineDuration(normalized, source));
  if (!graphSvg || !model) return;

  const index = found.track.keyframes.findIndex((keyframe) => keyframe.id === keyframeId);
  tangentDrag = {
    trackId,
    keyframeId,
    side,
    keyframeTime: found.keyframe.time,
    keyframeValue: found.keyframe.value,
    initial: resolveGraphTangent(found.track, index, side),
    bounds: getTangentDtBounds(found.track, index, side, normalized.fps, model.duration),
    model,
    rect: graphSvg.getBoundingClientRect(),
  };
  setSoleSelection(trackId, keyframeId);

  document.body.classList.add("dragging-tangent");
  document.addEventListener("pointermove", onTangentPointerMove);
  document.addEventListener("pointerup", onTangentPointerUp);
  document.addEventListener("pointercancel", onTangentPointerUp);
  renderAnimationTimeline();
}

function onTangentPointerMove(event) {
  if (!tangentDrag) return;
  const ratioX = clamp((event.clientX - tangentDrag.rect.left) / tangentDrag.rect.width, 0, 1);
  const svgY = clamp((event.clientY - tangentDrag.rect.top) / tangentDrag.rect.height, 0, 1) * GRAPH_EDITOR_HEIGHT;
  const handleTime = ratioX * tangentDrag.model.duration;
  const handleValue = graphValueFromY(tangentDrag.model, svgY);
  const rawDt = event.shiftKey ? tangentDrag.initial.dt : handleTime - tangentDrag.keyframeTime;
  const dt = clamp(rawDt, tangentDrag.bounds.min, tangentDrag.bounds.max);
  const dv = handleValue - tangentDrag.keyframeValue;
  const tangentKey = tangentDrag.side === "in" ? "inTangent" : "outTangent";

  dispatch(
    "timeline",
    updateTimelineKeyframe(getState().timeline, {
      trackId: tangentDrag.trackId,
      keyframeId: tangentDrag.keyframeId,
      patch: {
        easing: "custom-bezier",
        interpolation: "bezier",
        [tangentKey]: { dt, dv },
      },
    })
  );
}

function onTangentPointerUp() {
  if (!tangentDrag) return;
  tangentDrag = null;
  document.body.classList.remove("dragging-tangent");
  document.removeEventListener("pointermove", onTangentPointerMove);
  document.removeEventListener("pointerup", onTangentPointerUp);
  document.removeEventListener("pointercancel", onTangentPointerUp);
}

function resetTangentHandle(handle, event) {
  event.preventDefault();
  event.stopPropagation();
  const trackId = handle.dataset.timelineTrackId;
  const keyframeId = handle.dataset.timelineKeyframeId;
  const side = handle.dataset.tangentHandle === "in" ? "in" : "out";
  const tangentKey = side === "in" ? "inTangent" : "outTangent";
  dispatch(
    "timeline",
    updateTimelineKeyframe(getState().timeline, {
      trackId,
      keyframeId,
      patch: {
        easing: "custom-bezier",
        interpolation: "bezier",
        [tangentKey]: null,
      },
    })
  );
}

function getTangentDtBounds(track, index, side, fps, duration) {
  const oneFrame = 1 / Math.max(1, fps);
  const keyframe = track.keyframes[index];
  if (!keyframe) return { min: -duration, max: duration };
  if (side === "in") {
    const previous = track.keyframes[index - 1];
    const min = previous ? previous.time - keyframe.time : -duration;
    return { min: Math.min(-oneFrame, min), max: -oneFrame };
  }
  const next = track.keyframes[index + 1];
  const max = next ? next.time - keyframe.time : duration;
  return { min: oneFrame, max: Math.max(oneFrame, max) };
}

// ---------- Marquee selection (Faz 2.c) ----------
//
// Drag-select on a lane's empty area. The marquee element lives inside the
// lane so it follows scroll/zoom; selection is updated on every pointermove
// without re-rendering the whole timeline (we toggle is-selected classes
// directly to keep the marquee element alive).
//
// `marqueeJustEnded` is a one-tick flag the click handler reads to swallow
// the seek that would otherwise fire when pointerup lands on the lane.

const MARQUEE_THRESHOLD = 4;
let marqueeDrag = null;
let marqueeJustEnded = false;

function startMarqueeDrag(lane, event) {
  // Right-click and middle-click should not start a marquee.
  if (event.button !== 0 && event.button !== undefined) return;
  event.preventDefault();
  const additive = event.shiftKey || event.metaKey || event.ctrlKey;
  marqueeDrag = {
    lane,
    rect: lane.getBoundingClientRect(),
    startX: event.clientX,
    additive,
    initial: additive ? new Set(selectedKeyframes) : new Set(),
    moved: false,
    el: null,
  };
  document.addEventListener("pointermove", onMarqueePointerMove);
  document.addEventListener("pointerup", onMarqueePointerUp);
  document.addEventListener("pointercancel", onMarqueePointerUp);
}

function onMarqueePointerMove(event) {
  if (!marqueeDrag) return;
  const dx = event.clientX - marqueeDrag.startX;
  if (!marqueeDrag.moved && Math.abs(dx) < MARQUEE_THRESHOLD) return;
  marqueeDrag.moved = true;

  // Refresh the lane rect each frame in case the layout shifted (e.g. a
  // scroll or a panel resize while dragging).
  const rect = marqueeDrag.lane.getBoundingClientRect();
  const x1 = Math.min(event.clientX, marqueeDrag.startX);
  const x2 = Math.max(event.clientX, marqueeDrag.startX);

  if (!marqueeDrag.el) {
    const el = document.createElement("div");
    el.className = "marquee-rect";
    marqueeDrag.lane.appendChild(el);
    marqueeDrag.el = el;
  }
  marqueeDrag.el.style.left = `${x1 - rect.left}px`;
  marqueeDrag.el.style.width = `${x2 - x1}px`;

  // Recompute selection: initial set + every keyframe whose centre falls
  // inside the marquee horizontal span. Keyframes are rendered as 12px
  // diamonds centred on their time, so `center.x` between [x1, x2] is the
  // intuitive hit test.
  const next = new Set(marqueeDrag.initial);
  for (const k of marqueeDrag.lane.querySelectorAll(".animation-keyframe, .animation-graph-keyframe")) {
    const kr = k.getBoundingClientRect();
    const cx = kr.left + kr.width / 2;
    if (cx >= x1 && cx <= x2) {
      next.add(selectionKey(k.dataset.timelineTrackId, k.dataset.timelineKeyframeId));
    }
  }
  applySelectionSet(next);
}

function onMarqueePointerUp() {
  if (!marqueeDrag) return;
  const moved = marqueeDrag.moved;
  if (marqueeDrag.el) marqueeDrag.el.remove();
  marqueeDrag = null;
  document.removeEventListener("pointermove", onMarqueePointerMove);
  document.removeEventListener("pointerup", onMarqueePointerUp);
  document.removeEventListener("pointercancel", onMarqueePointerUp);

  if (moved) {
    // Suppress the lane-background click handler that would otherwise seek
    // the playhead. The flag clears on the next tick so a real subsequent
    // click still works.
    marqueeJustEnded = true;
    setTimeout(() => {
      marqueeJustEnded = false;
    }, 0);
    // Render once at the end so the inspector cursor + final selection are
    // committed through the normal path.
    renderAnimationTimeline();
  }
}

// Replace the multi-select set with `next` and update the DOM in place,
// without going through the full renderAnimationTimeline pass. The marquee
// element is parented to a lane that renderAnimationTimeline rebuilds, so
// we deliberately avoid re-rendering during the drag.
function applySelectionSet(next) {
  replaceSelectedKeyframes(next);
  for (const k of document.querySelectorAll(".animation-keyframe, .animation-graph-keyframe")) {
    const key = selectionKey(k.dataset.timelineTrackId, k.dataset.timelineKeyframeId);
    k.classList.toggle("is-selected", selectedKeyframes.has(key));
  }
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

  if (field.startsWith("inTangent.") || field.startsWith("outTangent.")) {
    const [sideKey, axis] = field.split(".");
    const normalized = normalizeTimeline(timeline, {
      duration: getState().source.duration,
      fps: getState().source.fps,
    });
    const found = getTimelineKeyframe(normalized, trackId, keyframeId);
    if (!found) return;
    const index = found.track.keyframes.findIndex((item) => item.id === keyframeId);
    const side = sideKey === "inTangent" ? "in" : "out";
    const current = normalizeGraphTangent(found.keyframe[sideKey])
      ?? resolveGraphTangent(found.track, index, side);
    const next = {
      ...current,
      [axis]: Number(control.value) || 0,
    };
    dispatch(
      "timeline",
      updateTimelineKeyframe(timeline, {
        trackId,
        keyframeId,
        patch: {
          easing: "custom-bezier",
          interpolation: "bezier",
          [sideKey]: next,
        },
      })
    );
    return;
  }

}

function createEasingPatch(easing) {
  if (easing === "step" || easing === "hold") {
    return { easing: { type: "step" }, interpolation: "hold", inTangent: null, outTangent: null };
  }

  const preset = getTimelineEasingPreset(easing === "custom-bezier" ? "smooth" : easing);
  const controlPoints = preset?.controlPoints ?? [0, 0, 1, 1];
  return {
    easing: { type: "bezier", controlPoints },
    interpolation: "linear",
    inTangent: null,
    outTangent: null,
  };
}

function resetSelectedKeyframeTangents(button) {
  const panel = button.closest(".animation-tangent-panel");
  const anyInput = panel?.querySelector("[data-keyframe-track-id][data-keyframe-id]");
  const trackId = anyInput?.dataset.keyframeTrackId;
  const keyframeId = anyInput?.dataset.keyframeId;
  if (!trackId || !keyframeId) return;
  dispatch(
    "timeline",
    updateTimelineKeyframe(getState().timeline, {
      trackId,
      keyframeId,
      patch: {
        easing: "custom-bezier",
        interpolation: "bezier",
        inTangent: null,
        outTangent: null,
      },
    })
  );
}

// Public form, used by the Inspector "Delete" button and by the Faz 2.b
// keyboard shortcut. Removes every keyframe currently in the multi-select
// set in a single timeline pass, then clears selection.
// Returns true if anything was removed — the keyboard handler uses this to
// decide whether to swallow the Delete/Backspace key.
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

// Backwards-compat alias — older callers (and the inline Inspector button)
// expect a singular name; both routes go through the multi-select path.
function deleteSelectedKeyframe() {
  deleteSelectedKeyframes();
}

// Duplicate every selected keyframe one frame later. The resulting newly
// created keyframes become the new selection so the user can immediately
// drag or delete them. Returns true when at least one keyframe was made;
// the keyboard handler uses that to decide whether to swallow Cmd+D.
export function duplicateSelectedKeyframes() {
  if (selectedKeyframes.size === 0) return false;
  const items = [...selectedKeyframes].map(parseSelectionKey);
  const { timeline: next, newKeys } = duplicateTimelineKeyframes(getState().timeline, items);
  if (newKeys.length === 0) return false;
  // Reroute the multi-select to the new keyframes BEFORE dispatching, since
  // dispatch synchronously triggers renderAnimationTimeline which reads
  // isKeyframeSelected.
  selectedKeyframes.clear();
  for (const { trackId, keyframeId } of newKeys) {
    selectedKeyframes.add(selectionKey(trackId, keyframeId));
  }
  setSelectedTimelineKeyframeCursor(newKeys[newKeys.length - 1]);
  dispatch("timeline", next);
  return true;
}

// Module-level clipboard (shader-lab pattern). Holds the last copied snapshot
// so paste can repeat across multiple presses without re-copying. Persists for
// the session — cleared only when overwritten by another copy.
let timelineKeyframeClipboard = [];

// Nudge every selected keyframe by `direction` (+1 or -1) frame units. With
// `big`, the step jumps to 10 frames — same scale shader-lab's SMALL/LARGE
// nudge uses, anchored to the timeline's fps so the result is always a clean
// integer-frame shift. Returns true when something moved so the caller can
// fall back to playhead-step when no selection exists.
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

// Capture the current multi-selection into the module-level clipboard. Stores
// the keyframes' full value/easing/tangent payload so paste survives even if
// the originals get moved or deleted between Cmd+C and Cmd+V. Returns true
// when at least one keyframe was captured.
export function copySelectedKeyframes() {
  if (selectedKeyframes.size === 0) return false;
  const items = [...selectedKeyframes].map(parseSelectionKey);
  const snapshot = snapshotTimelineKeyframes(getState().timeline, items);
  if (snapshot.length === 0) return false;
  timelineKeyframeClipboard = snapshot;
  return true;
}

// ---------- Bezier easing popover (F10.6) ------------------------------
//
// Lightweight per-keyframe editor that replaces the legacy easing <select>.
// Holds module-level state for the open popover, draggable control-point
// handles, and the timeline subscription that keeps the SVG in sync as the
// underlying keyframe changes (drag, undo, preset clicks).
//
// Anchor pattern matches the existing more-menu popover: rendered into <body>
// in fixed coords so the keyframe panel scrollbar can't clip it.

const BEZIER_SVG_WIDTH = 100;
const BEZIER_SVG_HEIGHT = 100;
const BEZIER_HANDLE_Y_MIN = -1.5;
const BEZIER_HANDLE_Y_MAX = 2.5;

const bezierPopover = {
  el: null,
  anchor: null,
  trackId: null,
  keyframeId: null,
  drag: null,
  outsideHandler: null,
  keyHandler: null,
};

function openBezierPopover(anchor, trackId, keyframeId) {
  if (bezierPopover.el && bezierPopover.trackId === trackId && bezierPopover.keyframeId === keyframeId) {
    // Toggle off when re-clicking the same trigger.
    closeBezierPopover();
    return;
  }
  closeBezierPopover();
  const popover = document.createElement("div");
  popover.className = "player-more-popover bezier-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Easing curve editor");
  popover.addEventListener("pointerdown", onBezierPopoverPointerDown);
  popover.addEventListener("keydown", onBezierPopoverControlKeyDown);
  popover.addEventListener("click", onBezierPopoverClick);

  bezierPopover.el = popover;
  bezierPopover.anchor = anchor;
  bezierPopover.trackId = trackId;
  bezierPopover.keyframeId = keyframeId;
  document.body.appendChild(popover);
  renderBezierPopoverContent();
  positionBezierPopover();

  // Defer attaching the outside-click listener so the originating click
  // doesn't immediately close the freshly opened popover.
  setTimeout(() => {
    bezierPopover.outsideHandler = onBezierPopoverOutsidePointer;
    bezierPopover.keyHandler = onBezierPopoverKey;
    document.addEventListener("pointerdown", bezierPopover.outsideHandler, true);
    document.addEventListener("keydown", bezierPopover.keyHandler);
  }, 0);
}

function closeBezierPopover() {
  if (!bezierPopover.el) return;
  bezierPopover.el.remove();
  bezierPopover.el = null;
  bezierPopover.anchor = null;
  bezierPopover.trackId = null;
  bezierPopover.keyframeId = null;
  if (bezierPopover.outsideHandler) {
    document.removeEventListener("pointerdown", bezierPopover.outsideHandler, true);
    bezierPopover.outsideHandler = null;
  }
  if (bezierPopover.keyHandler) {
    document.removeEventListener("keydown", bezierPopover.keyHandler);
    bezierPopover.keyHandler = null;
  }
  if (bezierPopover.drag) {
    document.removeEventListener("pointermove", onBezierHandlePointerMove);
    document.removeEventListener("pointerup", onBezierHandlePointerUp);
    document.removeEventListener("pointercancel", onBezierHandlePointerUp);
    bezierPopover.drag = null;
  }
}

function renderBezierPopoverContent() {
  if (!bezierPopover.el) return;
  const { trackId, keyframeId } = bezierPopover;
  const { timeline, source } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: source.duration,
    fps: source.fps,
  });
  const found = getTimelineKeyframe(normalized, trackId, keyframeId);
  if (!found) {
    closeBezierPopover();
    return;
  }
  const focusedHandle = bezierPopover.el.contains(document.activeElement)
    ? document.activeElement?.dataset?.bezierHandle
    : null;
  bezierPopover.el.innerHTML = renderBezierPopoverHTML(found.track, found.keyframe);
  if (focusedHandle) {
    bezierPopover.el.querySelector(`[data-bezier-handle="${focusedHandle}"]`)?.focus();
  }
}

function renderBezierPopoverHTML(track, keyframe) {
  const easing = keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const isStep = easing.type === "step";
  const cp = isStep ? [0, 0, 1, 1] : (easing.controlPoints ?? [0, 0, 1, 1]);
  const x1 = cp[0] * 100, y1 = (1 - cp[1]) * 100;
  const x2 = cp[2] * 100, y2 = (1 - cp[3]) * 100;
  const presetMatch = isStep ? "step" : findMatchingEasingPreset(easing);
  const curveD = isStep
    ? "M 0 100 L 100 100 L 100 0"
    : `M 0 100 C ${x1.toFixed(2)} ${y1.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}, 100 0`;
  const presetChips = TIMELINE_EASING_PRESETS.map((preset) => `
    <button
      type="button"
      class="bezier-preset-chip${preset.name === presetMatch ? " is-active" : ""}"
      data-bezier-preset="${escapeHtml(preset.name)}"
      title="${escapeHtml(preset.label)}"
    >${escapeHtml(preset.label)}</button>
  `).join("");
  return `
    <div class="popover-section bezier-curve-section">
      <svg
        class="bezier-curve"
        viewBox="-15 -65 130 220"
        preserveAspectRatio="xMidYMid meet"
        data-bezier-svg
      >
        <rect x="0" y="0" width="100" height="100" class="bezier-curve-frame" />
        ${!isStep ? `<line x1="0" y1="100" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}" class="bezier-curve-tangent" />` : ""}
        ${!isStep ? `<line x1="100" y1="0" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" class="bezier-curve-tangent" />` : ""}
        <path d="${curveD}" class="bezier-curve-path" />
        <circle cx="0" cy="100" r="3" class="bezier-curve-anchor" />
        <circle cx="100" cy="0" r="3" class="bezier-curve-anchor" />
        ${!isStep ? `<circle cx="${x1.toFixed(2)}" cy="${y1.toFixed(2)}" r="7" class="bezier-curve-handle" data-bezier-handle="p1" tabindex="0" focusable="true" role="slider" aria-label="Bezier control point 1" aria-valuetext="x ${formatBezierControlValue(cp[0])}, y ${formatBezierControlValue(cp[1])}" />` : ""}
        ${!isStep ? `<circle cx="${x2.toFixed(2)}" cy="${y2.toFixed(2)}" r="7" class="bezier-curve-handle" data-bezier-handle="p2" tabindex="0" focusable="true" role="slider" aria-label="Bezier control point 2" aria-valuetext="x ${formatBezierControlValue(cp[2])}, y ${formatBezierControlValue(cp[3])}" />` : ""}
      </svg>
      <div class="bezier-curve-readout">
        ${isStep ? "step" : `cubic-bezier(${cp.map((v) => Number(v).toFixed(2)).join(", ")})`}
      </div>
    </div>
    <div class="popover-section">
      <div class="popover-label">Presets</div>
      <div class="bezier-preset-grid">${presetChips}</div>
    </div>
    <div class="popover-section">
      <button
        type="button"
        class="popover-row bezier-step-toggle${isStep ? " is-active" : ""}"
        data-bezier-step
      >${isStep ? "Step easing · on" : "Step easing · off"}</button>
    </div>
  `;
}

function positionBezierPopover() {
  if (!bezierPopover.el || !bezierPopover.anchor) return;
  const rect = bezierPopover.anchor.getBoundingClientRect();
  const popover = bezierPopover.el;
  const margin = 6;
  popover.style.position = "fixed";
  // Open above the trigger, right edges aligned. Falls back to the viewport
  // bound when the anchor is near the right edge so the curve never clips.
  popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  popover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + margin)}px`;
}

function onBezierPopoverControlKeyDown(event) {
  const handle = event.target.closest("[data-bezier-handle]");
  if (!handle || !bezierPopover.el?.contains(handle)) return;
  if (!handleBezierPopoverKeyDown(event, handle.dataset.bezierHandle)) return;
}

function handleBezierPopoverKeyDown(event, handleName) {
  if (
    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) ||
    event.metaKey ||
    event.ctrlKey
  ) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();

  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId) return true;
  const { timeline } = getState();
  const found = getTimelineKeyframe(timeline, trackId, keyframeId);
  if (!found) return true;

  const easing = found.keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const cp = easing.type === "step"
    ? [0, 0, 1, 1]
    : [...(easing.controlPoints ?? [0, 0, 1, 1])];
  const step = event.shiftKey ? 0.1 : event.altKey ? 0.001 : 0.01;
  const index = handleName === "p2" ? 2 : 0;
  if (event.key === "ArrowLeft") cp[index] = clampBezierControlValue(cp[index] - step, 0, 1);
  else if (event.key === "ArrowRight") cp[index] = clampBezierControlValue(cp[index] + step, 0, 1);
  else if (event.key === "ArrowUp") cp[index + 1] = clampBezierControlValue(cp[index + 1] + step, BEZIER_HANDLE_Y_MIN, BEZIER_HANDLE_Y_MAX);
  else if (event.key === "ArrowDown") cp[index + 1] = clampBezierControlValue(cp[index + 1] - step, BEZIER_HANDLE_Y_MIN, BEZIER_HANDLE_Y_MAX);

  dispatch(
    "timeline",
    updateTimelineKeyframe(timeline, {
      trackId,
      keyframeId,
      patch: {
        easing: { type: "bezier", controlPoints: cp },
        interpolation: "linear",
        inTangent: null,
        outTangent: null,
      },
    })
  );
  return true;
}

function onBezierPopoverPointerDown(event) {
  const handle = event.target.closest("[data-bezier-handle]");
  if (!handle) return;
  const svg = handle.closest("[data-bezier-svg]");
  if (!svg) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  bezierPopover.drag = {
    handle: handle.dataset.bezierHandle === "p2" ? "p2" : "p1",
    rect,
    viewBox: { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height },
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch (_) {
    /* Some pointer types reject capture — drag still works via document listeners. */
  }
  document.addEventListener("pointermove", onBezierHandlePointerMove);
  document.addEventListener("pointerup", onBezierHandlePointerUp);
  document.addEventListener("pointercancel", onBezierHandlePointerUp);
}

function onBezierHandlePointerMove(event) {
  const drag = bezierPopover.drag;
  if (!drag) return;
  const { rect, viewBox, handle } = drag;
  // Convert client coords into the SVG viewBox space.
  const u = (event.clientX - rect.left) / rect.width;
  const v = (event.clientY - rect.top) / rect.height;
  const svgX = viewBox.x + u * viewBox.width;
  const svgY = viewBox.y + v * viewBox.height;
  // SVG 0..100 maps to cp 0..1 on x; SVG 100..0 maps to cp 0..1 on y so a
  // handle dragged above the frame yields cp.y > 1 (back-out / overshoot).
  const cpX = Math.max(0, Math.min(1, svgX / BEZIER_SVG_WIDTH));
  const cpY = Math.max(
    BEZIER_HANDLE_Y_MIN,
    Math.min(BEZIER_HANDLE_Y_MAX, (BEZIER_SVG_HEIGHT - svgY) / BEZIER_SVG_HEIGHT)
  );

  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId) return;
  const { timeline } = getState();
  const found = getTimelineKeyframe(timeline, trackId, keyframeId);
  if (!found) return;
  const easing = found.keyframe.easing ?? { type: "bezier", controlPoints: [0, 0, 1, 1] };
  const base = easing.type === "step"
    ? [0, 0, 1, 1]
    : [...(easing.controlPoints ?? [0, 0, 1, 1])];
  if (handle === "p2") {
    base[2] = cpX;
    base[3] = cpY;
  } else {
    base[0] = cpX;
    base[1] = cpY;
  }
  dispatch(
    "timeline",
    updateTimelineKeyframe(timeline, {
      trackId,
      keyframeId,
      patch: {
        easing: { type: "bezier", controlPoints: base },
        interpolation: "linear",
        inTangent: null,
        outTangent: null,
      },
    })
  );
}

function onBezierHandlePointerUp() {
  if (!bezierPopover.drag) return;
  bezierPopover.drag = null;
  document.removeEventListener("pointermove", onBezierHandlePointerMove);
  document.removeEventListener("pointerup", onBezierHandlePointerUp);
  document.removeEventListener("pointercancel", onBezierHandlePointerUp);
}

function onBezierPopoverClick(event) {
  const preset = event.target.closest("[data-bezier-preset]");
  if (preset) {
    event.preventDefault();
    event.stopPropagation();
    applyBezierPopoverPreset(preset.dataset.bezierPreset);
    return;
  }
  const step = event.target.closest("[data-bezier-step]");
  if (step) {
    event.preventDefault();
    event.stopPropagation();
    toggleBezierPopoverStep();
  }
}

function applyBezierPopoverPreset(name) {
  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId || !name) return;
  const patch = createEasingPatch(name);
  dispatch("timeline", updateTimelineKeyframe(getState().timeline, { trackId, keyframeId, patch }));
}

function toggleBezierPopoverStep() {
  const { trackId, keyframeId } = bezierPopover;
  if (!trackId || !keyframeId) return;
  const found = getTimelineKeyframe(getState().timeline, trackId, keyframeId);
  if (!found) return;
  const isStep = found.keyframe.easing?.type === "step";
  // Toggling step on/off restores the smooth preset when leaving step mode —
  // it's the closest in-spirit cubic-bezier and keeps the UI from snapping
  // back to a linear curve the user didn't ask for.
  const patch = isStep ? createEasingPatch("smooth") : createEasingPatch("step");
  dispatch("timeline", updateTimelineKeyframe(getState().timeline, { trackId, keyframeId, patch }));
}

function onBezierPopoverOutsidePointer(event) {
  if (!bezierPopover.el) return;
  if (bezierPopover.el.contains(event.target)) return;
  // Clicking the same trigger should fall through to the click handler which
  // toggles the popover; don't double-close here.
  if (event.target.closest?.("[data-bezier-trigger]")) return;
  closeBezierPopover();
}

function onBezierPopoverKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeBezierPopover();
  }
}

// Paste the clipboard at the current playhead. Earliest clipboard time lands
// on the playhead frame; the remaining items preserve their relative offsets
// (so a 0.5s gap between two copied keyframes stays a 0.5s gap when pasted).
// Reroutes the multi-selection onto the freshly created keyframes — same UX
// as duplicate, so the user can immediately drag/nudge what they just pasted.
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

function pickTimelineKeyframe(element) {
  return {
    trackId: element.dataset.timelineTrackId ?? element.dataset.keyframeTrackId ?? "",
    keyframeId: element.dataset.timelineKeyframeId ?? element.dataset.keyframeId ?? "",
  };
}

function getSelectedTimelineKeyframe(timeline = getState().timeline) {
  let selectedTimelineKeyframe = getSelectedTimelineKeyframeCursor();
  if (!selectedTimelineKeyframe?.trackId || !selectedTimelineKeyframe?.keyframeId) return null;
  const selected = getTimelineKeyframe(
    timeline,
    selectedTimelineKeyframe.trackId,
    selectedTimelineKeyframe.keyframeId
  );
  if (!selected) {
    // Last-clicked keyframe was removed (delete, undo, etc.). Drop it from
    // both the cursor and the multi-select set, then promote any survivor.
    selectedKeyframes.delete(
      selectionKey(selectedTimelineKeyframe.trackId, selectedTimelineKeyframe.keyframeId)
    );
    const next = selectedKeyframes.values().next().value;
    selectedTimelineKeyframe = next ? parseSelectionKey(next) : null;
    setSelectedTimelineKeyframeCursor(selectedTimelineKeyframe);
    if (!selectedTimelineKeyframe) return null;
    return getTimelineKeyframe(
      timeline,
      selectedTimelineKeyframe.trackId,
      selectedTimelineKeyframe.keyframeId
    );
  }
  return selected;
}

function updateAnimationPlayhead(playback, sourceDuration) {
  if (!playerEls.playerCard) return;
  const { source, timeline } = getState();
  const normalized = normalizeTimeline(timeline, {
    duration: sourceDuration,
    fps: source.fps,
  });
  const fps = timelineFrameRate(normalized, source.fps);
  const duration = resolveTimelineDuration(normalized, { duration: sourceDuration });
  const playhead = playerEls.playerCard.querySelector(".playhead");
  if (!playhead) return;
  const left = timeToTimelinePercent(playback.currentTime, duration, fps) * getEffectiveTimelineZoom(normalized);
  playhead.style.left = `${left}%`;
  syncPlayheadAccessibility(playhead, playback.currentTime, duration, fps);
}

function syncPlayheadAccessibility(playhead, time, duration, fps) {
  const handle = playhead.querySelector(".playhead-handle");
  if (!handle) return;
  const totalFrames = durationToFrames(duration, fps);
  const frame = timeToFrame(time, fps);
  handle.setAttribute("aria-valuemin", "0");
  handle.setAttribute("aria-valuemax", String(Math.max(0, totalFrames - 1)));
  handle.setAttribute("aria-valuenow", String(clamp(frame, 0, Math.max(0, totalFrames - 1))));
  handle.setAttribute("aria-valuetext", `F${frame} · ${formatRulerSecond(time)}`);
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

function updatePlayheadTooltip(time, fps = 30) {
  const playhead = playerEls.playerCard?.querySelector(".playhead");
  const tooltip = playhead?.querySelector(".playhead-tooltip");
  if (!playhead || !tooltip) return;
  const dragging = Number.isFinite(Number(time));
  playhead.classList.toggle("is-dragging", dragging);
  if (!dragging) return;
  tooltip.textContent = `${formatRulerSecond(time)} · F${timeToFrame(time, fps)}`;
}

function getEffectiveTimelineZoom(timeline) {
  const zoom = Number(timeline?.zoom);
  return Math.max(0.25, Number.isFinite(zoom) ? zoom : 1);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
