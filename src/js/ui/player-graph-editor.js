import {
  getTimelineTrackValue,
  timeToFrame,
} from "../timeline.js";
import { escapeHtml } from "./utils.js";
import { formatPropertyValue } from "./player-format.js";
import { isKeyframeSelected } from "./player-selection.js";
import {
  getTimelineBindingColor,
  getTrackDisplayMeta,
  safeCssColor,
} from "./player-timeline-targets.js";

const GRAPH_EDITOR_WIDTH = 1000;
export const GRAPH_EDITOR_HEIGHT = 136;
const GRAPH_EDITOR_PADDING = 18;
const GRAPH_MIN_VALUE_RANGE = 1;

export function initPlayerGraphEditor(_deps = {}) {}

function renderGraphPlaceholder(tracks) {
  const keyframeCount = tracks.reduce((total, track) => total + track.keyframes.length, 0);
  return `
    <div class="timeline-graph-placeholder">
      <span class="timeline-graph-title">Graph</span>
      <span>${tracks.length} properties · ${keyframeCount} keyframes</span>
    </div>
  `;
}

export function pickGraphTrack(activeTrack, visibleTracks) {
  if (activeTrack && isNumericTimelineTrack(activeTrack)) return activeTrack;
  return visibleTracks.find(isNumericTimelineTrack) ?? activeTrack ?? visibleTracks[0] ?? null;
}

export function renderGraphEditor(track, duration, fps, selected, graph, playback, visibleTracks = []) {
  const meta = getTrackDisplayMeta(track, graph);
  const overlayTracks = visibleTracks
    .filter((item) => item.id !== track.id && isNumericTimelineTrack(item))
    .slice(0, 4);
  const model = createGraphCurveModel([track, ...overlayTracks], duration);
  if (!model) {
    return `
      <div class="timeline-graph-placeholder">
        <span class="timeline-graph-title">${escapeHtml(meta.paramLabel)}</span>
        <span>Graph mode supports numeric keyframes first.</span>
      </div>
    `;
  }

  const currentTime = clamp(playback.currentTime, 0, duration);
  const currentValue = sampleGraphTrackValue(track, currentTime);
  const currentPoint = graphPoint(model, currentTime, currentValue);

  return `
    <div class="timeline-graph-editor" data-graph-track-id="${escapeHtml(track.id)}">
      <div class="timeline-graph-meta">
        <span>${escapeHtml(meta.nodeLabel)} · ${escapeHtml(meta.paramLabel)}</span>
        ${renderCurvePresetBar(track)}
        <span>${escapeHtml(formatPropertyValue(model.min))} – ${escapeHtml(formatPropertyValue(model.max))}</span>
      </div>
      ${renderGraphOverlayLegend(overlayTracks, graph)}
      <div class="animation-track-lane animation-graph-lane" data-timeline-lane="${escapeHtml(track.id)}">
        <svg
          class="timeline-graph-svg"
          viewBox="0 0 ${GRAPH_EDITOR_WIDTH} ${GRAPH_EDITOR_HEIGHT}"
          preserveAspectRatio="none"
          data-graph-track-id="${escapeHtml(track.id)}"
          data-graph-min="${model.min}"
          data-graph-max="${model.max}"
          data-graph-duration="${duration}"
          aria-label="${escapeHtml(meta.label)} curve"
        >
          ${renderGraphGrid(model)}
          ${overlayTracks
            .map((overlayTrack, index) => renderGraphPath(overlayTrack, model, {
              overlay: true,
              color: graphCurveColor(overlayTrack, graph, index),
            }))
            .join("")}
          ${renderGraphPath(track, model, { color: graphCurveColor(track, graph, 0) })}
          <line class="timeline-graph-playhead" x1="${currentPoint.x}" x2="${currentPoint.x}" y1="0" y2="${GRAPH_EDITOR_HEIGHT}" />
          ${renderGraphTangents(track, model, selected)}
          ${renderGraphKeyframes(track, model, fps)}
        </svg>
      </div>
    </div>
  `;
}

function renderGraphGrid(model) {
  const rows = [0.25, 0.5, 0.75];
  const cols = [0.25, 0.5, 0.75];
  return `
    <g class="timeline-graph-grid" aria-hidden="true">
      ${rows.map((ratio) => `<line x1="0" x2="${GRAPH_EDITOR_WIDTH}" y1="${ratio * GRAPH_EDITOR_HEIGHT}" y2="${ratio * GRAPH_EDITOR_HEIGHT}" />`).join("")}
      ${cols.map((ratio) => `<line x1="${ratio * GRAPH_EDITOR_WIDTH}" x2="${ratio * GRAPH_EDITOR_WIDTH}" y1="0" y2="${GRAPH_EDITOR_HEIGHT}" />`).join("")}
      <line x1="0" x2="${GRAPH_EDITOR_WIDTH}" y1="${model.zeroY}" y2="${model.zeroY}" class="timeline-graph-zero" />
    </g>
  `;
}

function renderCurvePresetBar(track) {
  return `
    <span class="timeline-curve-presets" data-curve-track-id="${escapeHtml(track.id)}">
      <button type="button" data-curve-preset="linear" title="Linear">Lin</button>
      <button type="button" data-curve-preset="easeIn" title="Ease in">In</button>
      <button type="button" data-curve-preset="easeOut" title="Ease out">Out</button>
      <button type="button" data-curve-preset="easeInOut" title="Ease in/out">S</button>
      <button type="button" data-curve-preset="smooth" title="Smooth">Smooth</button>
    </span>
  `;
}

function renderGraphOverlayLegend(tracks, graph) {
  if (tracks.length === 0) return "";
  return `
    <div class="timeline-graph-overlay-legend">
      ${tracks.map((track, index) => {
        const meta = getTrackDisplayMeta(track, graph);
        return `
          <span>
            <i style="background:${escapeHtml(safeCssColor(graphCurveColor(track, graph, index)))}"></i>
            ${escapeHtml(meta.paramLabel)}
          </span>
        `;
      }).join("")}
    </div>
  `;
}

function renderGraphPath(track, model, options = {}) {
  const keyframes = track.keyframes.filter((keyframe) => typeof keyframe.value === "number");
  if (keyframes.length === 0) return "";
  let d = "";
  for (let index = 0; index < keyframes.length; index++) {
    const keyframe = keyframes[index];
    const point = graphPoint(model, keyframe.time, keyframe.value);
    if (index === 0) {
      d = `M ${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
      continue;
    }
    const previous = keyframes[index - 1];
    const interpolation = getSegmentInterpolation(previous, track);
    if (interpolation === "hold") {
      d += ` H ${point.x.toFixed(3)} V ${point.y.toFixed(3)}`;
    } else if (interpolation === "bezier") {
      const out = resolveGraphTangent(track, track.keyframes.indexOf(previous), "out");
      const inn = resolveGraphTangent(track, track.keyframes.indexOf(keyframe), "in");
      const c1 = graphPoint(model, previous.time + out.dt, previous.value + out.dv);
      const c2 = graphPoint(model, keyframe.time + inn.dt, keyframe.value + inn.dv);
      d += ` C ${c1.x.toFixed(3)} ${c1.y.toFixed(3)} ${c2.x.toFixed(3)} ${c2.y.toFixed(3)} ${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
    } else {
      d += ` L ${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
    }
  }
  const overlayClass = options.overlay ? " is-overlay" : "";
  const color = options.color ? ` style="--curve-color:${escapeHtml(safeCssColor(options.color))}"` : "";
  return `<path class="timeline-graph-curve${overlayClass}" d="${d}"${color} />`;
}

function renderGraphTangents(track, model, selected) {
  const pieces = [];
  for (let index = 0; index < track.keyframes.length; index++) {
    const keyframe = track.keyframes[index];
    if (typeof keyframe.value !== "number") continue;
    const keyPoint = graphPoint(model, keyframe.time, keyframe.value);
    const active = selected?.track.id === track.id && selected?.keyframe.id === keyframe.id;
    if (index > 0 && getSegmentInterpolation(track.keyframes[index - 1], track) === "bezier") {
      pieces.push(renderGraphTangentHandle(track, keyframe, index, "in", keyPoint, model, active));
    }
    if (index < track.keyframes.length - 1 && getSegmentInterpolation(keyframe, track) === "bezier") {
      pieces.push(renderGraphTangentHandle(track, keyframe, index, "out", keyPoint, model, active));
    }
  }
  return `<g class="timeline-graph-tangents">${pieces.join("")}</g>`;
}

function renderGraphTangentHandle(track, keyframe, index, side, keyPoint, model, active) {
  const tangent = resolveGraphTangent(track, index, side);
  const handlePoint = graphPoint(model, keyframe.time + tangent.dt, keyframe.value + tangent.dv);
  const isAuto = keyframe[side === "in" ? "inTangent" : "outTangent"] === null;
  return `
    <g class="timeline-tangent ${active ? "is-active" : ""} ${isAuto ? "is-auto" : ""}">
      <line class="timeline-tangent-line" x1="${keyPoint.x}" y1="${keyPoint.y}" x2="${handlePoint.x}" y2="${handlePoint.y}" />
      <circle
        class="timeline-tangent-handle"
        cx="${handlePoint.x}"
        cy="${handlePoint.y}"
        r="5"
        data-tangent-handle="${side}"
        data-timeline-track-id="${escapeHtml(track.id)}"
        data-timeline-keyframe-id="${escapeHtml(keyframe.id)}"
      />
    </g>
  `;
}

function renderGraphKeyframes(track, model, fps) {
  return track.keyframes
    .filter((keyframe) => typeof keyframe.value === "number")
    .map((keyframe) => {
      const point = graphPoint(model, keyframe.time, keyframe.value);
      const active = isKeyframeSelected(track.id, keyframe.id);
      return `
        <circle
          class="animation-graph-keyframe ${active ? "is-selected" : ""}"
          cx="${point.x}"
          cy="${point.y}"
          r="5.5"
          data-timeline-track-id="${escapeHtml(track.id)}"
          data-timeline-keyframe-id="${escapeHtml(keyframe.id)}"
          data-timeline-time="${Number(keyframe.time) || 0}"
        >
          <title>F${timeToFrame(keyframe.time, fps)} · ${escapeHtml(formatPropertyValue(keyframe.value))}</title>
        </circle>
      `;
    })
    .join("");
}

export function createGraphCurveModel(trackOrTracks, duration) {
  const tracks = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
  const numericKeyframes = tracks.flatMap((track) =>
    track.keyframes.filter((keyframe) => typeof keyframe.value === "number")
  );
  if (numericKeyframes.length === 0 || duration <= 0) return null;
  const values = [];
  for (const track of tracks) {
    for (let index = 0; index < track.keyframes.length; index++) {
      const keyframe = track.keyframes[index];
      if (typeof keyframe.value !== "number") continue;
      values.push(keyframe.value);
      if (index > 0 && getSegmentInterpolation(track.keyframes[index - 1], track) === "bezier") {
        const tangent = resolveGraphTangent(track, index, "in");
        values.push(keyframe.value + tangent.dv);
      }
      if (index < track.keyframes.length - 1 && getSegmentInterpolation(keyframe, track) === "bezier") {
        const tangent = resolveGraphTangent(track, index, "out");
        values.push(keyframe.value + tangent.dv);
      }
    }
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  const span = Math.max(GRAPH_MIN_VALUE_RANGE, max - min);
  if (max - min < GRAPH_MIN_VALUE_RANGE) {
    const center = (min + max) / 2;
    min = center - GRAPH_MIN_VALUE_RANGE / 2;
    max = center + GRAPH_MIN_VALUE_RANGE / 2;
  } else {
    min -= span * 0.12;
    max += span * 0.12;
  }
  return {
    duration,
    min,
    max,
    valueSpan: max - min,
    zeroY: graphPoint({ duration, min, max, valueSpan: max - min }, 0, 0).y,
  };
}

function graphPoint(model, time, value) {
  const safeDuration = Math.max(1 / 120, model.duration);
  const x = clamp(time / safeDuration, 0, 1) * GRAPH_EDITOR_WIDTH;
  const ratio = (value - model.min) / Math.max(GRAPH_MIN_VALUE_RANGE, model.valueSpan ?? model.max - model.min);
  const y = GRAPH_EDITOR_PADDING
    + (1 - clamp(ratio, 0, 1)) * (GRAPH_EDITOR_HEIGHT - GRAPH_EDITOR_PADDING * 2);
  return { x, y };
}

export function graphValueFromY(model, y) {
  const ratio = 1 - clamp((y - GRAPH_EDITOR_PADDING) / (GRAPH_EDITOR_HEIGHT - GRAPH_EDITOR_PADDING * 2), 0, 1);
  return model.min + ratio * model.valueSpan;
}

function sampleGraphTrackValue(track, time) {
  if (track.keyframes.length === 0) return 0;
  const cloneTrack = { ...track, keyframes: track.keyframes.map((keyframe) => ({ ...keyframe })) };
  const last = track.keyframes[track.keyframes.length - 1];
  const timeline = {
    duration: Math.max(time, last?.time ?? 0),
    fps: 30,
    loop: false,
    tracks: [cloneTrack],
  };
  return getTimelineTrackValue(timeline, track.id, time, track.keyframes[0].value);
}

function isNumericTimelineTrack(track) {
  return Boolean(track?.keyframes?.some((keyframe) => typeof keyframe.value === "number"));
}

export function getSegmentInterpolation(keyframe, track) {
  if (keyframe?.easing?.type === "step" || keyframe?.interpolation === "hold") return "hold";
  if (hasLegacyGraphTangent(keyframe)) return "bezier";
  if (keyframe?.easing?.type === "bezier" && !isLinearControlPoints(keyframe.easing.controlPoints)) return "bezier";
  if (track?.interpolation === "bezier" && hasAnyTrackTangent(track)) return "bezier";
  return "linear";
}

export function resolveGraphTangent(track, index, side) {
  const keyframe = track.keyframes[index];
  const key = side === "in" ? "inTangent" : "outTangent";
  const explicit = normalizeGraphTangent(keyframe?.[key]);
  if (explicit) return explicit;
  const easingTangent = resolveEasingGraphTangent(track, index, side);
  if (easingTangent) return easingTangent;
  return createAutoGraphTangent(track, index, side);
}

function resolveEasingGraphTangent(track, index, side) {
  const keyframe = track.keyframes[index];
  if (!keyframe || typeof keyframe.value !== "number") return null;

  if (side === "out") {
    const next = track.keyframes[index + 1];
    if (!next || typeof next.value !== "number" || keyframe.easing?.type !== "bezier") return null;
    const [x1, y1] = keyframe.easing.controlPoints;
    return {
      dt: x1 * Math.max(1 / 1200, next.time - keyframe.time),
      dv: y1 * (next.value - keyframe.value),
    };
  }

  const previous = track.keyframes[index - 1];
  if (!previous || typeof previous.value !== "number" || previous.easing?.type !== "bezier") return null;
  const [, , x2, y2] = previous.easing.controlPoints;
  return {
    dt: (x2 - 1) * Math.max(1 / 1200, keyframe.time - previous.time),
    dv: (y2 - 1) * (keyframe.value - previous.value),
  };
}

function createAutoGraphTangent(track, index, side) {
  const keyframe = track.keyframes[index];
  const previous = track.keyframes[index - 1];
  const next = track.keyframes[index + 1];
  const neighbor = side === "in" ? previous : next;
  if (!keyframe || !neighbor || typeof keyframe.value !== "number" || typeof neighbor.value !== "number") {
    return { dt: 0, dv: 0 };
  }
  const windowStart = previous ?? keyframe;
  const windowEnd = next ?? keyframe;
  const windowSpan = Math.max(1 / 1200, windowEnd.time - windowStart.time);
  const slope =
    typeof windowStart.value === "number" && typeof windowEnd.value === "number"
      ? (windowEnd.value - windowStart.value) / windowSpan
      : 0;
  const segmentSpan = Math.max(1 / 1200, Math.abs(neighbor.time - keyframe.time));
  const dt = (side === "in" ? -1 : 1) * segmentSpan * 0.33;
  return { dt, dv: slope * dt };
}

export function normalizeGraphTangent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dt = Number(raw.dt);
  const dv = Number(raw.dv);
  if (!Number.isFinite(dt) || !Number.isFinite(dv)) return null;
  return { dt, dv };
}

function hasLegacyGraphTangent(keyframe) {
  return Boolean(normalizeGraphTangent(keyframe?.inTangent) || normalizeGraphTangent(keyframe?.outTangent));
}

function hasAnyTrackTangent(track) {
  return Boolean(track?.keyframes?.some(hasLegacyGraphTangent));
}

function isLinearControlPoints(controlPoints) {
  if (!Array.isArray(controlPoints) || controlPoints.length !== 4) return true;
  const [x1, y1, x2, y2] = controlPoints.map(Number);
  return Math.abs(x1) < 0.0005 &&
    Math.abs(y1) < 0.0005 &&
    Math.abs(x2 - 1) < 0.0005 &&
    Math.abs(y2 - 1) < 0.0005;
}

function graphCurveColor(track, graph, index = 0) {
  const node = graph.nodes.find((item) => item.id === track.nodeId);
  const trackColor = getTimelineBindingColor(track.binding, node);
  if (trackColor) return trackColor;
  const meta = getTrackDisplayMeta(track, graph);
  const fallback = ["#f0b55f", "#6ab0ff", "#7ddf95", "#f07ab6", "#a78bfa"][index % 5];
  const familyMap = {
    color: "#40c7d8",
    process: "#7ddf95",
    dither: "#f07ab6",
    mask: "#68d6bd",
    effect: "#f0b55f",
    compose: "#a78bfa",
    utility: "#bac2d0",
    input: "#8b9bb3",
    output: "#6ab0ff",
  };
  return familyMap[meta.family] ?? fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
