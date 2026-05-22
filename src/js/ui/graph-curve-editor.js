// RGB curve editor for the inspector — canvas + handles render,
// drag (drop-new-point + handle drag), channel strip, and the
// commit/sync helpers. Shared by RGB Curves, Scene Grade, and
// Tone Map nodes; their node-specific renderers compose against
// `renderCurveField` / `renderCurveChannelStrip` from here.
//
// The pointer-drag handler lives behind `startCurveDrag` so
// graph-shell's onInspectorPointerDown can dispatch into it
// without owning the curve drag state machine itself.

import { escapeHtml, setInnerHtml } from "./utils.js";
import { getSelectedNode, updateNodeParams } from "../graph.js";
import { pushHistory } from "../state.js";
import {
  commitParamValueToTimeline,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import {
  buildCurveLut,
  getMonotoneCurveTangents,
  identityCurvePoints as createIdentityCurvePoints,
  MIN_CURVE_POINT_GAP,
  readRgbCurvePoints,
  sanitizeCurvePoints,
} from "../curve-lut.js";

const CURVE_CANVAS_SIZE = 240;
const CURVE_HANDLE_RADIUS = 6;
const CURVE_CHANNELS = ["master", "red", "green", "blue"];

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

const callbacks = {
  renderInspector: () => {},
  setInspectorEditing: () => {},
};

export function initCurveEditor(refs) {
  callbacks.renderInspector = refs.renderInspector ?? (() => {});
  callbacks.setInspectorEditing = refs.setInspectorEditing ?? (() => {});
}

// --- Channel helpers --------------------------------------------------

export function normalizeCurveChannel(value) {
  return ["master", "red", "green", "blue"].includes(value) ? value : "master";
}

export function curveChannelLabel(channel) {
  switch (normalizeCurveChannel(channel)) {
    case "red":
      return "Red";
    case "green":
      return "Green";
    case "blue":
      return "Blue";
    case "master":
    default:
      return "Master";
  }
}

function normalizeCurveTone(value) {
  return ["master", "red", "green", "blue"].includes(value) ? value : "master";
}

function curveStrokeColor(channel) {
  switch (channel) {
    case "red":
      return "#ff5b5b";
    case "green":
      return "#69d27a";
    case "blue":
      return "#6aa6ff";
    case "master":
    default:
      return "#e5e7eb";
  }
}

// --- Point readers ---------------------------------------------------

export function readCurvePoints(node, channel) {
  return readRgbCurvePoints(node?.params, channel);
}

export function readCurveParamPoints(node, paramKey, legacyChannel = null) {
  const raw = node?.params?.[paramKey];
  if (Array.isArray(raw) && raw.length >= 2) return raw;
  if (legacyChannel) return readCurvePoints(node, legacyChannel);
  return createIdentityCurvePoints();
}

// --- Render ----------------------------------------------------------

export function renderCurveChannelStrip(node, activeChannel) {
  const active = normalizeCurveChannel(activeChannel);
  return `
    <div class="curve-channel-strip" role="group" aria-label="Curve channels">
      ${CURVE_CHANNELS.map((channel) => renderCurveChannelButton(node, channel, active)).join("")}
    </div>
  `;
}

function renderCurveChannelButton(node, channel, activeChannel) {
  const tone = normalizeCurveChannel(channel);
  const isActive = tone === activeChannel;
  const label = curveChannelLabel(tone);
  const shortLabel = tone === "master" ? "M" : tone.slice(0, 1).toUpperCase();
  const points = readCurveParamPoints(node, `points_${tone}`, tone);
  const path = buildCurvePath(points, 64);
  const color = curveStrokeColor(tone);
  return `
    <button
      type="button"
      class="curve-channel-button${isActive ? " is-active" : ""}"
      data-curve-channel="${escapeHtml(tone)}"
      aria-label="Select ${escapeHtml(label)} curve"
      aria-pressed="${isActive ? "true" : "false"}"
      title="${escapeHtml(label)}"
    >
      <span class="curve-channel-button-header">
        <span class="curve-channel-dot" style="background:${escapeHtml(color)}"></span>
        <span class="curve-channel-label">${escapeHtml(shortLabel)}</span>
      </span>
      <svg class="curve-channel-preview" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <line x1="0" y1="64" x2="64" y2="0" class="curve-channel-preview-diagonal"/>
        <path d="${escapeHtml(path)}" class="curve-channel-preview-path" stroke="${escapeHtml(color)}"/>
      </svg>
    </button>
  `;
}

export function renderCurveField(label, paramKey, points, options = {}) {
  const safeKey = escapeHtml(paramKey);
  const tone = normalizeCurveTone(options.tone);
  const legacyAttr = options.legacyChannel
    ? ` data-curve-legacy-channel="${escapeHtml(options.legacyChannel)}"`
    : "";
  const hint = options.hint ? `<p class="hint">${escapeHtml(options.hint)}</p>` : "";
  const resetLabel = options.resetLabel ?? "Reset Curve";
  return `
    <div class="field curve-field" data-curve-field="${safeKey}">
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      <div class="curves-editor">
        ${renderCurveCanvas(points, {
          paramKey,
          tone,
          lut: options.lut,
          overlays: options.overlays,
          label,
          legacyChannel: options.legacyChannel,
        })}
      </div>
      <div class="curves-actions">
        <button type="button" data-curve-action="reset" data-curve-param="${safeKey}"${legacyAttr}>${escapeHtml(resetLabel)}</button>
      </div>
      ${hint}
    </div>
  `;
}

function renderCurveCanvas(points, options = {}) {
  const size = CURVE_CANVAS_SIZE;
  const paramKey = options.paramKey ?? "curve";
  const tone = normalizeCurveTone(options.tone);
  const safeKey = escapeHtml(paramKey);
  const safeTone = escapeHtml(tone);
  const legacyAttr = options.legacyChannel
    ? ` data-curve-legacy-channel="${escapeHtml(options.legacyChannel)}"`
    : "";
  const stroke = curveStrokeColor(tone);
  const path = buildCurvePath(points, size);
  const overlays = (Array.isArray(options.overlays) ? options.overlays : [])
    .map((overlay) => {
      const overlayTone = normalizeCurveTone(overlay.tone);
      const overlayPath = buildCurvePath(overlay.points ?? createIdentityCurvePoints(), size, overlay.lut);
      return `<path class="curve-overlay" d="${overlayPath}" fill="none" stroke="${curveStrokeColor(overlayTone)}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join("");
  const handles = renderCurveHandles(points, size);
  return `
    <svg
      class="curves-svg"
      viewBox="0 0 ${size} ${size}"
      data-curve-svg
      data-curve-param="${safeKey}"
      data-curve-tone="${safeTone}"
      ${legacyAttr}
      preserveAspectRatio="none"
      role="img"
      aria-label="${escapeHtml(options.label ?? "Curve")}"
    >
      <defs>
        <pattern id="curveGrid-${safeKey}" width="${size / 4}" height="${size / 4}" patternUnits="userSpaceOnUse">
          <path d="M ${size / 4} 0 L 0 0 0 ${size / 4}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="${size}" height="${size}" fill="rgba(0,0,0,0.34)"/>
      <rect width="${size}" height="${size}" fill="url(#curveGrid-${safeKey})"/>
      <line x1="0" y1="${size}" x2="${size}" y2="0" stroke="rgba(255,255,255,0.1)" stroke-dasharray="3 4"/>
      ${overlays}
      <path data-curve-main d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <g data-curve-handles>${handles}</g>
    </svg>
  `;
}

function renderCurveHandles(points, size) {
  return sanitizeCurvePoints(points)
    .map((point, index) => {
      const x = (Number(point.x) / 255) * size;
      const y = size - (Number(point.y) / 255) * size;
      return `
        <circle
          class="curve-handle"
          data-curve-handle="${index}"
          cx="${x}"
          cy="${y}"
          r="${CURVE_HANDLE_RADIUS}"
          role="button"
          tabindex="0"
          aria-label="Curve point ${index + 1}"
        />
      `;
    })
    .join("");
}

// --- Path builders ---------------------------------------------------

export function buildCurvePolyline(rawPoints, size, curveLut = null) {
  const lut = curveLut ?? buildCurveLut(rawPoints);
  const out = [];
  for (let x = 0; x <= 255; x += 4) {
    const y = lut[x];
    out.push(`${(x / 255) * size},${size - (y / 255) * size}`);
  }
  out.push(`${size},${size - (lut[255] / 255) * size}`);
  return out.join(" ");
}

export function buildCurvePath(rawPoints, size, curveLut = null) {
  if (curveLut) return polylineToPath(buildCurvePolyline(rawPoints, size, curveLut));

  const points = sanitizeCurvePoints(rawPoints);
  if (points.length === 0) return "";
  if (points.length === 1) {
    const [x, y] = curvePointToSvg(points[0], size);
    return `M ${x} ${y}`;
  }

  const tangents = getMonotoneCurveTangents(points);
  const [startX, startY] = curvePointToSvg(points[0], size);
  const segments = [`M ${startX} ${startY}`];

  for (let index = 0; index < points.length - 1; index++) {
    const pointA = points[index];
    const pointB = points[index + 1];
    const width = pointB.x - pointA.x;
    const controlPointA = {
      x: pointA.x + width / 3,
      y: pointA.y + (width * (tangents[index] ?? 0)) / 3,
    };
    const controlPointB = {
      x: pointB.x - width / 3,
      y: pointB.y - (width * (tangents[index + 1] ?? 0)) / 3,
    };
    const [cp1x, cp1y] = curvePointToSvg(controlPointA, size);
    const [cp2x, cp2y] = curvePointToSvg(controlPointB, size);
    const [x, y] = curvePointToSvg(pointB, size);
    segments.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x} ${y}`);
  }

  return segments.join(" ");
}

function curvePointToSvg(point, size) {
  return [
    (Number(point.x) / 255) * size,
    size - (Number(point.y) / 255) * size,
  ];
}

function polylineToPath(polyline) {
  const points = String(polyline)
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length === 0) return "";
  const [startX, startY] = points[0];
  return [`M ${startX} ${startY}`, ...points.slice(1).map(([x, y]) => `L ${x} ${y}`)].join(" ");
}

// --- Target resolution + click handlers -----------------------------

export function resolveCurveTarget(element, node = getSelectedNode()) {
  const target = element?.closest?.("[data-curve-param]") ?? element;
  const paramKey = target?.dataset?.curveParam;
  if (paramKey) {
    return {
      paramKey,
      legacyChannel: target.dataset.curveLegacyChannel ?? null,
    };
  }
  if (node?.type === "rgb-curves") {
    const channel = normalizeCurveChannel(node.params?.activeChannel);
    return {
      paramKey: `points_${channel}`,
      legacyChannel: channel,
    };
  }
  return null;
}

export function handleCurveClick(action) {
  const node = getSelectedNode();
  if (!node) return;
  const target = resolveCurveTarget(action, node);
  if (!target) return;
  commitCurvePoints(node.id, target.paramKey, createIdentityCurvePoints());
  callbacks.renderInspector();
}

export function handleCurveChannelClick(control) {
  const node = getSelectedNode();
  if (!node || (node.type !== "rgb-curves" && node.type !== "scene-grade")) return;
  const channel = normalizeCurveChannel(control.dataset.curveChannel);
  if (normalizeCurveChannel(node.params?.activeChannel) === channel) return;
  updateNodeParams(node.id, { activeChannel: channel });
  callbacks.renderInspector();
}

// --- Pointer drag ----------------------------------------------------

// Called from graph-shell's onInspectorPointerDown when a pointerdown
// lands on a curve SVG. Handles both the drop-new-point branch (empty
// area click) and dragging an existing handle, then records a single
// undo entry covering the whole interaction on pointerup.
export function startCurveDrag(event, svg) {
  const node = getSelectedNode();
  const target = resolveCurveTarget(svg, node);
  if (!node || !target) return;
  event.preventDefault();

  const handle = event.target.closest("[data-curve-handle]");
  const rect = svg.getBoundingClientRect();
  const toCurve = (clientX, clientY) => {
    const u = clamp((clientX - rect.left) / rect.width, 0, 1);
    const v = clamp((clientY - rect.top) / rect.height, 0, 1);
    return {
      x: clamp(Math.round(u * 255), 0, 255),
      y: clamp(Math.round((1 - v) * 255), 0, 255),
    };
  };

  callbacks.setInspectorEditing(true);
  let points = sanitizeCurvePoints(readCurveParamPoints(node, target.paramKey, target.legacyChannel));
  // F17.3e: snapshot the pre-drag points before any commit (including the
  // empty-area "drop a new point" branch below) so onUp can record one
  // history entry covering the drop + adjust as a single user action.
  const undoCurvePointsBefore = points.map((p) => ({ ...p }));
  let activeIndex;
  if (handle) {
    activeIndex = Number(handle.dataset.curveHandle);
  } else {
    // Empty-area click: drop a new point and keep the pointer "live" so the
    // user can fine-tune it without releasing. indexOf works because the
    // pushed cursor object survives the sort by reference, and the runtime
    // preserves x-order through sanitizeCurvePoints on later reads.
    const cursor = toCurve(event.clientX, event.clientY);
    points = commitCurvePoints(node.id, target.paramKey, [...points, cursor]);
    activeIndex = findClosestCurvePointIndex(points, cursor.x, cursor.y);
    syncCurveSvg(svg, points);
  }

  if (!Number.isFinite(activeIndex) || activeIndex < 0) return;

  document.body.classList.add("dragging-curve");
  try {
    svg.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    const selected = getSelectedNode() ?? node;
    const updated = sanitizeCurvePoints(readCurveParamPoints(selected, target.paramKey, target.legacyChannel));
    if (activeIndex < 0 || activeIndex >= updated.length) return;

    const next = toCurve(ev.clientX, ev.clientY);
    const isFirst = activeIndex === 0;
    const isLast = activeIndex === updated.length - 1;
    if (isFirst) next.x = 0;
    if (isLast) next.x = 255;
    if (!isFirst && !isLast) {
      next.x = clamp(
        next.x,
        updated[activeIndex - 1].x + MIN_CURVE_POINT_GAP,
        updated[activeIndex + 1].x - MIN_CURVE_POINT_GAP
      );
    }
    updated[activeIndex] = next;
    const normalized = commitCurvePoints(node.id, target.paramKey, updated);
    activeIndex = findClosestCurvePointIndex(normalized, next.x, next.y);
    syncCurveSvg(svg, normalized);
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    callbacks.setInspectorEditing(false);
    document.body.classList.remove("dragging-curve");
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {}
    // F17.3e flush: compare against the pre-drag snapshot and record one
    // history entry covering the whole drop + drag.
    const finalNode = getSelectedNode() ?? node;
    const finalPoints = sanitizeCurvePoints(
      readCurveParamPoints(finalNode, target.paramKey, target.legacyChannel),
    );
    if (!curvePointsEqual(undoCurvePointsBefore, finalPoints)) {
      const beforeCopy = undoCurvePointsBefore.map((p) => ({ ...p }));
      const afterCopy = finalPoints.map((p) => ({ ...p }));
      pushHistory({
        undo: () => commitCurvePoints(node.id, target.paramKey, beforeCopy),
        redo: () => commitCurvePoints(node.id, target.paramKey, afterCopy),
      });
    }
    callbacks.renderInspector();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

// --- Commit / sync helpers ------------------------------------------

export function commitCurvePoints(nodeId, paramKey, points) {
  const normalized = sanitizeCurvePoints(points);
  updateNodeParams(nodeId, { [paramKey]: normalized });
  if (!commitParamValueToTimeline(nodeId, paramKey, normalized)) {
    updateParamKeyframeAtCurrentTime(nodeId, paramKey, normalized);
  }
  return normalized;
}

function syncCurveSvg(svg, points) {
  if (!svg) return;
  const size = CURVE_CANVAS_SIZE;
  const mainPath = svg.querySelector("[data-curve-main]");
  if (mainPath) mainPath.setAttribute("d", buildCurvePath(points, size));
  const handleLayer = svg.querySelector("[data-curve-handles]");
  if (handleLayer) setInnerHtml(handleLayer, renderCurveHandles(points, size));
}

function findClosestCurvePointIndex(points, x, y) {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const dx = point.x - x;
    const dy = point.y - y;
    const distance = dx * dx + dy * dy;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function curvePointsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
  }
  return true;
}
