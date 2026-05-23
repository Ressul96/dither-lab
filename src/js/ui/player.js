import { getState, subscribe, dispatch, pushHistory } from "../state.js";
import {
  togglePlay,
  restart,
  stepFrame,
  seek,
  snapPlayhead,
  resetTrim,
  pausePlayback,
} from "../source.js";
import {
  TIMELINE_BINDING_NODE_PARAM,
  TIMELINE_BINDING_NODE_PROPERTY,
  createTimelineTrackId,
  durationToFrames,
  formatFrameReadout,
  formatSecondReadout,
  getTimelineKeyframe,
  moveTimelineKeyframe,
  moveTimelineKeyframes,
  normalizeTimeline,
  setSelectedProperty,
  setTimelinePanelOpen,
  setTimelineZoom,
  setTrackExpanded,
  setTimelineAutokey,
  setViewMode,
  snapTimeToFrame,
  timeToFrame,
  timelineFrameRate,
  toggleTimelineKeyframeAtCurrentTime,
  toggleTrackExpanded,
  updateTimelineKeyframe,
  updateTimelineTrack,
} from "../timeline.js";
import { listenWithDispose } from "./lifecycle.js";
import { setInnerHtml } from "./utils.js";
import {
  cachePlayerEls,
  getPlayerEls,
  initPlayerElements,
} from "./player-elements.js";
import { initPlayerCompare } from "./player-compare.js";
import { initPlayerMoreMenu } from "./player-more-menu.js";
import {
  initPlayerBezierPopover,
  openBezierPopover,
  syncBezierPopover,
} from "./player-bezier-popover.js";
import {
  initPlayerTimelineItems,
  renderAnimationLane,
  renderPropertyCard,
} from "./player-timeline-items.js";
import {
  buildTimelineProperties,
  getTimelineTargetBaseValue,
  initPlayerTimelineTargets,
} from "./player-timeline-targets.js";
import {
  GRAPH_EDITOR_HEIGHT,
  createGraphCurveModel,
  graphValueFromY,
  initPlayerGraphEditor,
  normalizeGraphTangent,
  pickGraphTrack,
  renderGraphEditor,
  resolveGraphTangent,
} from "./player-graph-editor.js";
import { createEasingPatch } from "./player-easing.js";
import {
  copySelectedKeyframes,
  deleteSelectedKeyframes,
  duplicateSelectedKeyframes,
  initPlayerKeyframeActions,
  nudgeSelectedKeyframes,
  pasteKeyframesAtPlayhead,
} from "./player-keyframe-actions.js";
import {
  clearSelection,
  getSelectedKeyframes,
  getSelectedPropertyTrackId,
  getSelectedTimelineKeyframeCursor,
  initPlayerSelection,
  isKeyframeSelected,
  parseSelectionKey,
  pickKeyframeWithModifier,
  selectionKey,
  setSelectedPropertyTrackId,
  setSelectedTimelineKeyframeCursor,
  setSoleSelection,
  toggleKeyframeSelection,
} from "./player-selection.js";
import {
  getMarqueeJustEnded,
  initPlayerMarquee,
  startMarqueeDrag,
} from "./player-marquee.js";
import {
  handlePlayheadKeyDown,
  initPlayerPlayhead,
  startPlayheadDrag,
  updateAnimationPlayhead,
} from "./player-playhead.js";
import {
  initPlayerTimelineChrome,
  renderRenderRangeOverlay,
  renderTimeRuler,
  syncTimelineRulerScroll,
  updateTimelineChrome,
} from "./player-timeline-chrome.js";

export {
  copySelectedKeyframes,
  deleteSelectedKeyframes,
  duplicateSelectedKeyframes,
  nudgeSelectedKeyframes,
  pasteKeyframesAtPlayhead,
};

const KEYFRAME_DRAG_THRESHOLD = 3;
const selectedKeyframes = getSelectedKeyframes();
let keyframeDrag = null;
let tangentDrag = null;

const playerEls = getPlayerEls();

export function initPlayer() {
  initPlayerElements();
  initPlayerSelection();
  initPlayerTimelineTargets();
  initPlayerGraphEditor();
  initPlayerBezierPopover();
  initPlayerKeyframeActions();
  initPlayerTimelineItems({ timeToTimelinePercent });
  initPlayerMarquee({ renderAnimationTimeline });
  initPlayerPlayhead({
    clamp,
    getEffectiveTimelineZoom,
    resolveTimelineDuration,
    timeToTimelinePercent,
  });
  initPlayerTimelineChrome({
    clamp,
    getEffectiveTimelineZoom,
  });
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
    // clicks while it's open. `syncBezierPopover` no-ops when there
    // is no open popover and gracefully closes itself if the underlying
    // keyframe has been deleted out from under it.
    syncBezierPopover();
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
      deleteSelectedKeyframes();
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
    if (getMarqueeJustEnded()) return;
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

  setInnerHtml(
    playerEls.propertyList,
    targets.length === 0
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
          .join("")
  );

  if (!playerEls.laneHost || !playerEls.emptyState) return;
  renderTimeRuler(duration, fps, normalized.durationUnit, normalized.zoom);
  const selected = getSelectedTimelineKeyframe(normalized);

  if (targets.length === 0) {
    playerEls.laneHost.replaceChildren();
    playerEls.emptyState.textContent = graph.selectedNodeId ? "No animatable properties" : "Select a node";
    playerEls.emptyState.classList.remove("hidden");
  } else if (normalized.viewMode === "graph") {
    const graphTrack = pickGraphTrack(activeTrack, visibleTracks);
    if (!graphTrack) {
      playerEls.laneHost.replaceChildren();
      playerEls.emptyState.textContent = "Select a track";
      playerEls.emptyState.classList.remove("hidden");
    } else {
      setInnerHtml(
        playerEls.laneHost,
        renderRenderRangeOverlay(duration, playback) +
          renderGraphEditor(graphTrack, duration, fps, selected, graph, playback, visibleTracks)
      );
      playerEls.emptyState.classList.add("hidden");
    }
  } else if (visibleTracks.length === 0) {
    playerEls.laneHost.replaceChildren();
    playerEls.emptyState.textContent = "No lanes open";
    playerEls.emptyState.classList.remove("hidden");
  } else {
    playerEls.emptyState.classList.add("hidden");
    setInnerHtml(
      playerEls.laneHost,
      renderRenderRangeOverlay(duration, playback) +
        visibleTargets
          .map((target) => renderAnimationLane(target, duration, fps, selected, graph))
          .join("")
    );
  }

  updateAnimationPlayhead(playback, duration);
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

function getEffectiveTimelineZoom(timeline) {
  const zoom = Number(timeline?.zoom);
  return Math.max(0.25, Number.isFinite(zoom) ? zoom : 1);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
