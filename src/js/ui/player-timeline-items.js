import { getState } from "../state.js";
import { formatTime } from "../source.js";
import {
  timeToFrame,
  timelineFrameRate,
} from "../timeline.js";
import { escapeHtml } from "./utils.js";
import { renderBezierTriggerButton } from "./player-bezier-popover.js";
import {
  getSegmentInterpolation,
  resolveGraphTangent,
} from "./player-graph-editor.js";
import {
  formatKeyframeValue,
  formatNumericInputValue,
  formatPropertyValue,
} from "./player-format.js";
import { isKeyframeSelected } from "./player-selection.js";
import {
  getTimelineBindingColor,
  getTrackDisplayMeta,
  safeCssColor,
} from "./player-timeline-targets.js";

let timeToTimelinePercent = () => 0;

export function initPlayerTimelineItems(deps = {}) {
  timeToTimelinePercent = deps.timeToTimelinePercent ?? timeToTimelinePercent;
}

export function renderPropertyCard(target, context) {
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

export function renderAnimationLane(target, duration, fps, selected, graph) {
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
