import { getState, subscribe } from "../state.js";
import { getSelectedNode, updateNodeParams } from "../graph.js";
import {
  commitParamValueToTimeline,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import {
  getViewerOverlay,
  clientToSourcePoint,
  sourceToOverlayPoint,
} from "./viewer-overlay.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Sub-threshold pointer drift should not yank a Shift-locked drag onto an
// axis the user did not actually commit to. 2px tolerance keeps clicks and
// 1px nudges from accidentally locking.
const SHIFT_AXIS_THRESHOLD_PX = 2;
const ANGLE_SNAP_DEG = 15;

let outputCanvas = null;
let pointGroup = null;
let pointHit = null;
let angleGroup = null;
let angleShaft = null;
let angleTipHit = null;
let ringGroup = null;
let ringCenterHit = null;
let ringEllipse = null;
let ringRimHit = null;
let activeTarget = null;
let dragState = null;
let resyncQueued = false;

export function initViewerGizmos() {
  const overlay = getViewerOverlay();
  outputCanvas = document.getElementById("output");
  if (!overlay || !outputCanvas) return;

  pointGroup = createPointGroup();
  angleGroup = createAngleGroup();
  ringGroup = createRingGroup();
  overlay.append(pointGroup, angleGroup, ringGroup);

  subscribe("graph", scheduleGizmoSync);
  subscribe("view", scheduleGizmoSync);
  subscribe("source", scheduleGizmoSync);
  window.addEventListener("resize", scheduleGizmoSync);

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(scheduleGizmoSync).observe(outputCanvas);
  }

  scheduleGizmoSync();
}

// ---------------------------------------------------------------------------
// Gizmo group factories
// ---------------------------------------------------------------------------

function createPointGroup() {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("viewer-point-gizmo");
  group.style.display = "none";

  const hit = svgCircle(18, ["gizmo-handle", "viewer-point-gizmo__hit"]);
  const ring = svgCircle(8.5, ["viewer-point-gizmo__ring"]);
  const dot = svgCircle(3.5, ["viewer-point-gizmo__dot"]);

  group.append(hit, ring, dot);
  hit.addEventListener("pointerdown", onPointPointerDown);
  hit.addEventListener("dblclick", onPointDoubleClick);
  pointHit = hit;
  return group;
}

function createAngleGroup() {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("viewer-angle-gizmo");
  group.style.display = "none";

  const shaft = svgLine(["viewer-angle-gizmo__shaft"]);
  const anchor = svgCircle(3.5, ["viewer-angle-gizmo__anchor"]);
  const tipRing = svgCircle(7, ["viewer-angle-gizmo__tip-ring"]);
  const tipDot = svgCircle(2.5, ["viewer-angle-gizmo__tip-dot"]);
  const tipHit = svgCircle(18, ["gizmo-handle", "viewer-angle-gizmo__tip-hit"]);

  group.append(shaft, anchor, tipRing, tipDot, tipHit);
  tipHit.addEventListener("pointerdown", onAnglePointerDown);
  angleShaft = shaft;
  angleTipHit = tipHit;
  return group;
}

function createRingGroup() {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("viewer-ring-gizmo");
  group.style.display = "none";

  const ellipse = document.createElementNS(SVG_NS, "ellipse");
  ellipse.classList.add("viewer-ring-gizmo__ellipse");
  ellipse.setAttribute("cx", "0");
  ellipse.setAttribute("cy", "0");

  const centerRing = svgCircle(8.5, ["viewer-ring-gizmo__center-ring"]);
  const centerDot = svgCircle(3.5, ["viewer-ring-gizmo__center-dot"]);
  const centerHit = svgCircle(18, ["gizmo-handle", "viewer-ring-gizmo__center-hit"]);

  const rimDot = svgCircle(4, ["viewer-ring-gizmo__rim-dot"]);
  const rimHit = svgCircle(18, ["gizmo-handle", "viewer-ring-gizmo__rim-hit"]);

  group.append(ellipse, centerHit, centerRing, centerDot, rimHit, rimDot);
  centerHit.addEventListener("pointerdown", onRingCenterPointerDown);
  centerHit.addEventListener("dblclick", onRingCenterDoubleClick);
  rimHit.addEventListener("pointerdown", onRingRimPointerDown);
  ringEllipse = ellipse;
  ringCenterHit = centerHit;
  ringRimHit = rimHit;
  return group;
}

function svgCircle(r, classes) {
  const el = document.createElementNS(SVG_NS, "circle");
  el.setAttribute("r", String(r));
  for (const c of classes) el.classList.add(c);
  return el;
}

function svgLine(classes) {
  const el = document.createElementNS(SVG_NS, "line");
  for (const c of classes) el.classList.add(c);
  return el;
}

// ---------------------------------------------------------------------------
// Sync — decide which gizmo applies to the current selection and place it
// ---------------------------------------------------------------------------

function scheduleGizmoSync() {
  if (resyncQueued) return;
  resyncQueued = true;
  requestAnimationFrame(() => {
    resyncQueued = false;
    syncGizmos();
  });
}

function syncGizmos() {
  hideAll();
  activeTarget = null;
  if (!canDisplayGizmos()) return;
  const node = getSelectedNode();
  if (!node) return;
  const target = resolveGizmoTarget(node);
  if (!target) return;
  activeTarget = { node, ...target };

  if (target.kind === "point") syncPoint(node);
  else if (target.kind === "angle") syncAngle(node, target);
  else if (target.kind === "ring") syncRing(node, target);
}

function hideAll() {
  if (pointGroup) pointGroup.style.display = "none";
  if (angleGroup) angleGroup.style.display = "none";
  if (ringGroup) ringGroup.style.display = "none";
}

function canDisplayGizmos() {
  if (!outputCanvas || outputCanvas.classList.contains("hidden")) return false;
  if (!outputCanvas.width || !outputCanvas.height) return false;
  // Side-by-side compare splits the viewer into two panes — duplicating the
  // gizmo in both pretends both halves are editable, so suppress entirely.
  if (getState().view?.compare === "side-by-side") return false;
  return true;
}

function resolveGizmoTarget(node) {
  switch (node.type) {
    case "lens-distort":
      return { kind: "point", paramX: "centerX", paramY: "centerY" };
    case "chromatic-aberration":
      if (node.params?.mode === "radial") {
        return { kind: "point", paramX: "centerX", paramY: "centerY" };
      }
      return {
        kind: "angle",
        paramAngle: "angle",
        paramLength: "strength",
        angleMin: -180,
        angleMax: 180,
        lengthMin: 0,
        lengthMax: 96,
        anchor: "center",
      };
    case "halftone":
      return {
        kind: "angle",
        paramAngle: "angle",
        paramLength: "spacing",
        angleMin: -90,
        angleMax: 90,
        lengthMin: 2,
        lengthMax: 64,
        anchor: "center",
        wrap180: true,
      };
    case "depth-of-field":
      return {
        kind: "ring",
        paramX: "centerX",
        paramY: "centerY",
        paramRadius: "radius",
        paramAspect: "aspect",
        paramRotation: "rotation",
      };
    default:
      return null;
  }
}

function syncPoint(node) {
  const centerX = Number(node.params?.centerX ?? 50);
  const centerY = Number(node.params?.centerY ?? 50);
  const srcX = (centerX / 100) * outputCanvas.width;
  const srcY = (centerY / 100) * outputCanvas.height;
  const pt = sourceToOverlayPoint(srcX, srcY, outputCanvas);
  if (!pt) return;
  pointGroup.style.display = "";
  pointGroup.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
}

function syncAngle(node, target) {
  const sourceCenterX = outputCanvas.width / 2;
  const sourceCenterY = outputCanvas.height / 2;
  const angleDeg = Number(node.params?.[target.paramAngle] ?? 0);
  const length = Number(node.params?.[target.paramLength] ?? target.lengthMin);
  const rad = (angleDeg * Math.PI) / 180;
  const tipSrcX = sourceCenterX + Math.cos(rad) * length;
  const tipSrcY = sourceCenterY + Math.sin(rad) * length;
  const anchorPt = sourceToOverlayPoint(sourceCenterX, sourceCenterY, outputCanvas);
  const tipPt = sourceToOverlayPoint(tipSrcX, tipSrcY, outputCanvas);
  if (!anchorPt || !tipPt) return;
  angleGroup.style.display = "";
  angleGroup.setAttribute("transform", `translate(${anchorPt.x} ${anchorPt.y})`);
  const dx = tipPt.x - anchorPt.x;
  const dy = tipPt.y - anchorPt.y;
  angleShaft.setAttribute("x1", "0");
  angleShaft.setAttribute("y1", "0");
  angleShaft.setAttribute("x2", String(dx));
  angleShaft.setAttribute("y2", String(dy));
  // Tip handles share a parent transform so we move them together via attrs.
  for (const el of [angleTipHit, ...angleGroup.querySelectorAll(".viewer-angle-gizmo__tip-ring, .viewer-angle-gizmo__tip-dot")]) {
    el.setAttribute("cx", String(dx));
    el.setAttribute("cy", String(dy));
  }
}

function syncRing(node, target) {
  const centerX = Number(node.params?.centerX ?? 50);
  const centerY = Number(node.params?.centerY ?? 50);
  const radiusPct = Number(node.params?.[target.paramRadius] ?? 35);
  const aspectPct = Number(node.params?.[target.paramAspect] ?? 100);
  const rotationDeg = Number(node.params?.[target.paramRotation] ?? 0);

  // Mirror the shader math: y-axis radius = radius% * H, x-axis radius scales
  // by aspect. The decorative ellipse therefore matches the actual focus
  // mask shape, so what users drag is what they see in the preview.
  const yPxRadius = (radiusPct / 100) * outputCanvas.height;
  const xPxRadius = yPxRadius * (aspectPct / 100);

  const centerSrcX = (centerX / 100) * outputCanvas.width;
  const centerSrcY = (centerY / 100) * outputCanvas.height;
  const centerPt = sourceToOverlayPoint(centerSrcX, centerSrcY, outputCanvas);
  if (!centerPt) return;

  // Convert source-px radii to overlay-px by sampling one extra point along
  // each axis through sourceToOverlayPoint, so the ellipse stays correct
  // under stage zoom/pan without us reaching into transforms manually.
  const rxRefPt = sourceToOverlayPoint(centerSrcX + xPxRadius, centerSrcY, outputCanvas);
  const ryRefPt = sourceToOverlayPoint(centerSrcX, centerSrcY + yPxRadius, outputCanvas);
  if (!rxRefPt || !ryRefPt) return;
  const rxOverlay = Math.abs(rxRefPt.x - centerPt.x);
  const ryOverlay = Math.abs(ryRefPt.y - centerPt.y);

  ringGroup.style.display = "";
  ringGroup.setAttribute("transform", `translate(${centerPt.x} ${centerPt.y}) rotate(${rotationDeg})`);
  ringEllipse.setAttribute("rx", String(rxOverlay));
  ringEllipse.setAttribute("ry", String(ryOverlay));
  // Rim handle sits on the major axis tip (the +x side after rotation).
  for (const el of [ringRimHit, ringGroup.querySelector(".viewer-ring-gizmo__rim-dot")]) {
    el.setAttribute("cx", String(rxOverlay));
    el.setAttribute("cy", "0");
  }
}

// ---------------------------------------------------------------------------
// Shared drag plumbing — one captured pointer, one rAF flush
// ---------------------------------------------------------------------------

function beginDrag(handle, e, descriptor) {
  if (e.button !== 0 || !outputCanvas) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    handle.setPointerCapture(e.pointerId);
  } catch (_) {}
  dragState = {
    handle,
    pointerId: e.pointerId,
    pointerOrigin: { x: e.clientX, y: e.clientY },
    pending: null,
    flushQueued: false,
    shiftAxis: null,
    ...descriptor,
  };
  if (descriptor.groupEl) descriptor.groupEl.dataset.dragging = "true";
  document.body.classList.add("dragging-gizmo");
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", onDragEnd);
  handle.addEventListener("pointercancel", onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;
  const next = dragState.compute(e, dragState);
  if (!next) return;
  dragState.pending = next;
  scheduleDragFlush();
}

function scheduleDragFlush() {
  if (!dragState || dragState.flushQueued) return;
  const local = dragState;
  local.flushQueued = true;
  requestAnimationFrame(() => {
    if (dragState !== local) return;
    local.flushQueued = false;
    if (!local.pending) return;
    const patch = local.pending;
    local.pending = null;
    commitParamPatch(local.nodeId, patch);
  });
}

function onDragEnd(e) {
  if (!dragState) return;
  try {
    dragState.handle.releasePointerCapture(e.pointerId);
  } catch (_) {}
  dragState.handle.removeEventListener("pointermove", onDragMove);
  dragState.handle.removeEventListener("pointerup", onDragEnd);
  dragState.handle.removeEventListener("pointercancel", onDragEnd);
  if (dragState.pending) commitParamPatch(dragState.nodeId, dragState.pending);
  if (dragState.groupEl) delete dragState.groupEl.dataset.dragging;
  document.body.classList.remove("dragging-gizmo");
  dragState = null;
}

function commitParamPatch(nodeId, patch) {
  updateNodeParams(nodeId, patch);
  for (const key of Object.keys(patch)) {
    if (!commitParamValueToTimeline(nodeId, key, patch[key])) {
      updateParamKeyframeAtCurrentTime(nodeId, key, patch[key]);
    }
  }
}

// ---------------------------------------------------------------------------
// Point gizmo handlers
// ---------------------------------------------------------------------------

function onPointPointerDown(e) {
  if (!activeTarget || activeTarget.kind !== "point") return;
  beginDrag(pointHit, e, {
    nodeId: activeTarget.node.id,
    groupEl: pointGroup,
    startCenter: {
      x: Number(activeTarget.node.params?.[activeTarget.paramX] ?? 50),
      y: Number(activeTarget.node.params?.[activeTarget.paramY] ?? 50),
    },
    paramX: activeTarget.paramX,
    paramY: activeTarget.paramY,
    compute: computePointDrag,
  });
}

function computePointDrag(e, state) {
  const point = clientToSourcePoint(e.clientX, e.clientY, outputCanvas);
  if (!point) return null;
  let nx = point.nx;
  let ny = point.ny;
  if (e.shiftKey) {
    if (!state.shiftAxis) {
      const dx = Math.abs(e.clientX - state.pointerOrigin.x);
      const dy = Math.abs(e.clientY - state.pointerOrigin.y);
      if (dx > SHIFT_AXIS_THRESHOLD_PX || dy > SHIFT_AXIS_THRESHOLD_PX) {
        state.shiftAxis = dx > dy ? "x" : "y";
      }
    }
    if (state.shiftAxis === "x") ny = state.startCenter.y;
    else if (state.shiftAxis === "y") nx = state.startCenter.x;
  } else {
    state.shiftAxis = null;
  }
  return { [state.paramX]: nx, [state.paramY]: ny };
}

function onPointDoubleClick(e) {
  if (!activeTarget || activeTarget.kind !== "point") return;
  e.preventDefault();
  e.stopPropagation();
  commitParamPatch(activeTarget.node.id, {
    [activeTarget.paramX]: 50,
    [activeTarget.paramY]: 50,
  });
}

// ---------------------------------------------------------------------------
// Angle gizmo handlers
// ---------------------------------------------------------------------------

function onAnglePointerDown(e) {
  if (!activeTarget || activeTarget.kind !== "angle") return;
  beginDrag(angleTipHit, e, {
    nodeId: activeTarget.node.id,
    groupEl: angleGroup,
    target: activeTarget,
    compute: computeAngleDrag,
  });
}

function computeAngleDrag(e, state) {
  const point = clientToSourcePoint(e.clientX, e.clientY, outputCanvas);
  if (!point) return null;
  const target = state.target;
  const sourceCenterX = outputCanvas.width / 2;
  const sourceCenterY = outputCanvas.height / 2;
  const dx = point.x - sourceCenterX;
  const dy = point.y - sourceCenterY;
  let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  if (target.wrap180) {
    // Halftone is periodic at 180° — fold the drag onto [-90, 90).
    angleDeg = ((((angleDeg + 90) % 180) + 180) % 180) - 90;
  }

  if (e.shiftKey) {
    angleDeg = Math.round(angleDeg / ANGLE_SNAP_DEG) * ANGLE_SNAP_DEG;
  }

  angleDeg = clamp(angleDeg, target.angleMin, target.angleMax);
  const length = clamp(Math.hypot(dx, dy), target.lengthMin, target.lengthMax);
  return { [target.paramAngle]: angleDeg, [target.paramLength]: length };
}

// ---------------------------------------------------------------------------
// Ring gizmo handlers
// ---------------------------------------------------------------------------

function onRingCenterPointerDown(e) {
  if (!activeTarget || activeTarget.kind !== "ring") return;
  beginDrag(ringCenterHit, e, {
    nodeId: activeTarget.node.id,
    groupEl: ringGroup,
    startCenter: {
      x: Number(activeTarget.node.params?.[activeTarget.paramX] ?? 50),
      y: Number(activeTarget.node.params?.[activeTarget.paramY] ?? 50),
    },
    paramX: activeTarget.paramX,
    paramY: activeTarget.paramY,
    compute: computePointDrag,
  });
}

function onRingCenterDoubleClick(e) {
  if (!activeTarget || activeTarget.kind !== "ring") return;
  e.preventDefault();
  e.stopPropagation();
  commitParamPatch(activeTarget.node.id, {
    [activeTarget.paramX]: 50,
    [activeTarget.paramY]: 50,
  });
}

function onRingRimPointerDown(e) {
  if (!activeTarget || activeTarget.kind !== "ring") return;
  beginDrag(ringRimHit, e, {
    nodeId: activeTarget.node.id,
    groupEl: ringGroup,
    target: activeTarget,
    compute: computeRingRimDrag,
  });
}

function computeRingRimDrag(e, state) {
  const point = clientToSourcePoint(e.clientX, e.clientY, outputCanvas);
  if (!point) return null;
  const target = state.target;
  const node = target.node;
  const centerX = Number(node.params?.[target.paramX] ?? 50);
  const centerY = Number(node.params?.[target.paramY] ?? 50);
  const aspectPct = Number(node.params?.[target.paramAspect] ?? 100);
  const rotationDeg = Number(node.params?.[target.paramRotation] ?? 0);

  const centerSrcX = (centerX / 100) * outputCanvas.width;
  const centerSrcY = (centerY / 100) * outputCanvas.height;
  // Project the drag onto the rotated major axis so radius changes only in
  // the direction the rim handle actually points. Otherwise off-axis motion
  // would silently bump the radius up by the wrong factor.
  const dx = point.x - centerSrcX;
  const dy = point.y - centerSrcY;
  const rad = (rotationDeg * Math.PI) / 180;
  const along = dx * Math.cos(rad) + dy * Math.sin(rad);
  // The shader's effective x-radius is radius% * H * aspect%/100 source-px,
  // so back out radius% from the projected distance.
  const denom = (outputCanvas.height * aspectPct) / 100;
  if (denom <= 0) return null;
  const radiusPct = clamp(Math.abs(along / denom) * 100, 0, 100);
  return { [target.paramRadius]: radiusPct };
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
