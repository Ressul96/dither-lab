import { getState, pushHistory, subscribe } from "../state.js";
import { getNodeById, getSelectedNode, updateNodeParams } from "../graph.js";
import {
  commitParamValueToTimeline,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import {
  getViewerOverlay,
  clientToSourcePoint,
  sourceToOverlayPoint,
} from "./viewer-overlay.js";
import { listenWithDispose, registerDispose } from "./lifecycle.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Sub-threshold pointer drift should not yank a Shift-locked drag onto an
// axis the user did not actually commit to. 2px tolerance keeps clicks and
// 1px nudges from accidentally locking.
const SHIFT_AXIS_THRESHOLD_PX = 2;
const ANGLE_SNAP_DEG = 15;
const GIZMO_KEYBOARD_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

let outputCanvas = null;
let pointGroup = null;
let pointHit = null;
let angleGroup = null;
let angleShaft = null;
let angleTipHit = null;
let ringGroup = null;
let ringCenterHit = null;
let ringEllipse = null;
let ringFalloffEllipse = null;
let ringRimHit = null;
let meshStopsContainer = null;
let cropBoxGroup = null;
let cropBoxOutline = null;
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
  meshStopsContainer = document.createElementNS(SVG_NS, "g");
  meshStopsContainer.classList.add("viewer-mesh-stops-gizmo");
  meshStopsContainer.style.display = "none";
  cropBoxGroup = createCropBoxGroup();
  overlay.append(pointGroup, angleGroup, ringGroup, meshStopsContainer, cropBoxGroup);

  subscribe("graph", scheduleGizmoSync);
  subscribe("view", scheduleGizmoSync);
  subscribe("source", scheduleGizmoSync);

  // Window resize + canvas resize need explicit teardown so re-initialising
  // the gizmo layer (multi-window, hot reload, test harness) doesn't pile
  // up duplicate handlers that fire on every legacy registration.
  listenWithDispose(window, "resize", scheduleGizmoSync);

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleGizmoSync);
    observer.observe(outputCanvas);
    registerDispose(() => observer.disconnect());
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
  configureGizmoHandle(hit, "Move point", onPointKeyDown);
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
  configureGizmoHandle(tipHit, "Adjust angle handle", onAngleKeyDown);

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

  // Outer dashed ring shows where falloff fully takes effect (radius + falloff)
  // — gives users immediate visual feedback when tuning DoF's soft edge.
  const falloff = document.createElementNS(SVG_NS, "ellipse");
  falloff.classList.add("viewer-ring-gizmo__falloff");
  falloff.setAttribute("cx", "0");
  falloff.setAttribute("cy", "0");
  falloff.style.display = "none";

  const centerRing = svgCircle(8.5, ["viewer-ring-gizmo__center-ring"]);
  const centerDot = svgCircle(3.5, ["viewer-ring-gizmo__center-dot"]);
  const centerHit = svgCircle(18, ["gizmo-handle", "viewer-ring-gizmo__center-hit"]);
  configureGizmoHandle(centerHit, "Move ring center", onRingCenterKeyDown);

  const rimDot = svgCircle(4, ["viewer-ring-gizmo__rim-dot"]);
  const rimHit = svgCircle(18, ["gizmo-handle", "viewer-ring-gizmo__rim-hit"]);
  configureGizmoHandle(rimHit, "Adjust ring radius", onRingRimKeyDown);

  group.append(ellipse, falloff, centerHit, centerRing, centerDot, rimHit, rimDot);
  centerHit.addEventListener("pointerdown", onRingCenterPointerDown);
  centerHit.addEventListener("dblclick", onRingCenterDoubleClick);
  rimHit.addEventListener("pointerdown", onRingRimPointerDown);
  ringEllipse = ellipse;
  ringFalloffEllipse = falloff;
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

function configureGizmoHandle(el, label, onKeyDown) {
  el.setAttribute("tabindex", "0");
  el.setAttribute("focusable", "true");
  el.setAttribute("role", "slider");
  el.setAttribute("aria-label", label);
  el.addEventListener("keydown", onKeyDown);
}

function setGizmoValueText(el, text) {
  if (!el) return;
  el.setAttribute("aria-valuetext", text);
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
  else if (target.kind === "mesh-stops") syncMeshStops(node);
  else if (target.kind === "crop-box") syncCropBox(node);
}

function syncMeshStops(node) {
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  if (stops.length === 0) return;

  // Reconcile the SVG children with the stop count — cheap diff so we don't
  // rebuild the DOM each time the user nudges a slider.
  while (meshStopsContainer.children.length < stops.length) {
    meshStopsContainer.append(createMeshStopGroup());
  }
  while (meshStopsContainer.children.length > stops.length) {
    meshStopsContainer.lastChild.remove();
  }

  meshStopsContainer.style.display = "";
  for (let i = 0; i < stops.length; i++) {
    const stopGroup = meshStopsContainer.children[i];
    stopGroup.dataset.meshStopIndex = String(i);
    positionMeshStopGroup(stopGroup, stops[i]);
  }
}

function createMeshStopGroup() {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("viewer-mesh-stop");

  const ellipse = document.createElementNS(SVG_NS, "ellipse");
  ellipse.classList.add("viewer-mesh-stop__ring");
  ellipse.setAttribute("cx", "0");
  ellipse.setAttribute("cy", "0");

  const centerHit = svgCircle(16, ["gizmo-handle", "viewer-mesh-stop__center-hit"]);
  configureGizmoHandle(centerHit, "Move mesh stop", onMeshStopCenterKeyDown);
  const centerDot = svgCircle(4.5, ["viewer-mesh-stop__center-dot"]);
  const rimHit = svgCircle(16, ["gizmo-handle", "viewer-mesh-stop__rim-hit"]);
  configureGizmoHandle(rimHit, "Adjust mesh stop radius", onMeshStopRimKeyDown);
  const rimDot = svgCircle(3.5, ["viewer-mesh-stop__rim-dot"]);

  centerHit.addEventListener("pointerdown", onMeshStopCenterDown);
  rimHit.addEventListener("pointerdown", onMeshStopRimDown);

  group.append(ellipse, centerHit, centerDot, rimHit, rimDot);
  return group;
}

function positionMeshStopGroup(group, stop) {
  if (!outputCanvas || !outputCanvas.width || !outputCanvas.height) {
    group.style.display = "none";
    return;
  }
  const stopX = clamp(Number(stop.x ?? 0.5), 0, 1);
  const stopY = clamp(Number(stop.y ?? 0.5), 0, 1);
  const srcX = stopX * outputCanvas.width;
  const srcY = stopY * outputCanvas.height;
  const centerPt = sourceToOverlayPoint(srcX, srcY, outputCanvas);
  if (!centerPt) {
    group.style.display = "none";
    return;
  }
  // Shader treats `radius` as a fraction of canvas height with aspect
  // correction so spots stay circular. Match that exactly in the gizmo so
  // the ring outlines the actual mask shape.
  const radius = Math.max(0.02, Math.min(2, Number(stop.radius ?? 0.6)));
  const srcRadius = radius * outputCanvas.height;
  const refXPt = sourceToOverlayPoint(srcX + srcRadius, srcY, outputCanvas);
  const refYPt = sourceToOverlayPoint(srcX, srcY + srcRadius, outputCanvas);
  if (!refXPt || !refYPt) {
    group.style.display = "none";
    return;
  }
  const rxOverlay = Math.abs(refXPt.x - centerPt.x);
  const ryOverlay = Math.abs(refYPt.y - centerPt.y);

  group.style.display = "";
  group.setAttribute("transform", `translate(${centerPt.x} ${centerPt.y})`);
  const ellipse = group.querySelector(".viewer-mesh-stop__ring");
  ellipse.setAttribute("rx", String(rxOverlay));
  ellipse.setAttribute("ry", String(ryOverlay));

  const centerDot = group.querySelector(".viewer-mesh-stop__center-dot");
  centerDot.style.fill = String(stop.color ?? "#ffffff");
  centerDot.style.stroke = "rgba(0, 0, 0, 0.7)";
  const centerHit = group.querySelector(".viewer-mesh-stop__center-hit");
  setGizmoValueText(
    centerHit,
    `x ${formatGizmoNumber(stopX * 100)}%, y ${formatGizmoNumber(stopY * 100)}%`,
  );

  // Rim handle: at the +x rim. Drag uses absolute distance from centre, so
  // any direction works for the user — visual placement is just affordance.
  const rimDot = group.querySelector(".viewer-mesh-stop__rim-dot");
  const rimHit = group.querySelector(".viewer-mesh-stop__rim-hit");
  setGizmoValueText(rimHit, `radius ${formatGizmoNumber(radius * 100)}%`);
  for (const el of [rimDot, rimHit]) {
    el.setAttribute("cx", String(rxOverlay));
    el.setAttribute("cy", "0");
  }
}

function hideAll() {
  if (pointGroup) pointGroup.style.display = "none";
  if (angleGroup) angleGroup.style.display = "none";
  if (ringGroup) ringGroup.style.display = "none";
  if (meshStopsContainer) meshStopsContainer.style.display = "none";
  if (cropBoxGroup) cropBoxGroup.style.display = "none";
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
        paramFalloff: "falloff",
      };
    case "mesh-gradient":
      return { kind: "mesh-stops" };
    case "crop":
    case "transform":
      // Transform shares left/right/top/bottom with crop. Rotate / translate /
      // scale handles are deferred — F7.3 P2 only ships crop edges + corners.
      return { kind: "crop-box" };
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
  setGizmoValueText(pointHit, `x ${formatGizmoNumber(centerX)}%, y ${formatGizmoNumber(centerY)}%`);
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
  setGizmoValueText(
    angleTipHit,
    `angle ${formatGizmoNumber(angleDeg)} degrees, length ${formatGizmoNumber(length)}`,
  );
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
  const falloffPct = target.paramFalloff
    ? Number(node.params?.[target.paramFalloff] ?? 0)
    : 0;

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
  setGizmoValueText(
    ringCenterHit,
    `x ${formatGizmoNumber(centerX)}%, y ${formatGizmoNumber(centerY)}%`,
  );
  setGizmoValueText(ringRimHit, `radius ${formatGizmoNumber(radiusPct)}%`);
  ringEllipse.setAttribute("rx", String(rxOverlay));
  ringEllipse.setAttribute("ry", String(ryOverlay));

  // Falloff outline at (radius + falloff). Shader uses smoothstep(radius,
  // radius+feather, dist) so the outer ring is where the mask is fully
  // applied. Hide when falloff is effectively zero — keeps a clean look
  // for nodes that don't expose falloff at all.
  if (ringFalloffEllipse) {
    if (falloffPct > 0.5) {
      const outerYPxRadius = ((radiusPct + falloffPct) / 100) * outputCanvas.height;
      const outerXPxRadius = outerYPxRadius * (aspectPct / 100);
      const outerRxRefPt = sourceToOverlayPoint(
        centerSrcX + outerXPxRadius,
        centerSrcY,
        outputCanvas,
      );
      const outerRyRefPt = sourceToOverlayPoint(
        centerSrcX,
        centerSrcY + outerYPxRadius,
        outputCanvas,
      );
      if (outerRxRefPt && outerRyRefPt) {
        ringFalloffEllipse.setAttribute(
          "rx",
          String(Math.abs(outerRxRefPt.x - centerPt.x)),
        );
        ringFalloffEllipse.setAttribute(
          "ry",
          String(Math.abs(outerRyRefPt.y - centerPt.y)),
        );
        ringFalloffEllipse.style.display = "";
      } else {
        ringFalloffEllipse.style.display = "none";
      }
    } else {
      ringFalloffEllipse.style.display = "none";
    }
  }
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
    // F17.2: snapshot the params we're about to move so onDragEnd can record
    // a single history entry covering the whole drag rather than one per
    // raf-flushed param patch. Mesh-stops carry a stops array, so we deep-
    // copy it instead of relying on the shallow params clone.
    undoSnapshot: descriptor.nodeId ? snapshotGizmoParams(descriptor.nodeId) : null,
    ...descriptor,
  };
  if (descriptor.groupEl) descriptor.groupEl.dataset.dragging = "true";
  document.body.classList.add("dragging-gizmo");
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", onDragEnd);
  handle.addEventListener("pointercancel", onDragEnd);
}

function snapshotGizmoParams(nodeId) {
  const node = getNodeById(nodeId);
  if (!node?.params) return null;
  const params = { ...node.params };
  if (Array.isArray(params.stops)) {
    params.stops = params.stops.map((s) => ({ ...s }));
  }
  return params;
}

function gizmoParamsEqual(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
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
    flushPendingPatch(local);
  });
}

function flushPendingPatch(local) {
  if (!local || !local.pending) return;
  const patch = local.pending;
  local.pending = null;
  // Gizmos that touch derived state (an array entry, a nested object) pass a
  // custom `commit` callback; everything else updates a flat param patch.
  if (typeof local.commit === "function") {
    local.commit(local, patch);
  } else {
    commitParamPatch(local.nodeId, patch);
  }
}

function onDragEnd(e) {
  if (!dragState) return;
  try {
    dragState.handle.releasePointerCapture(e.pointerId);
  } catch (_) {}
  dragState.handle.removeEventListener("pointermove", onDragMove);
  dragState.handle.removeEventListener("pointerup", onDragEnd);
  dragState.handle.removeEventListener("pointercancel", onDragEnd);
  flushPendingPatch(dragState);
  // F17.2: now that the final patch has landed, compare against the pre-drag
  // snapshot. If the drag moved anything, record one history entry covering
  // the whole drag — undo restores the snapshot, redo replays the final
  // params. No-op drags (click without movement) produce nothing.
  const nodeId = dragState.nodeId;
  const before = dragState.undoSnapshot;
  if (nodeId && before) {
    const after = snapshotGizmoParams(nodeId);
    if (after && !gizmoParamsEqual(before, after)) {
      pushHistory({
        undo: () => updateNodeParams(nodeId, before),
        redo: () => updateNodeParams(nodeId, after),
      });
    }
  }
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

function onPointKeyDown(e) {
  if (!activeTarget || activeTarget.kind !== "point") return;
  if (!prepareGizmoKeyboardEvent(e)) return;
  nudgePointLikeTarget(activeTarget, e);
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

function onAngleKeyDown(e) {
  if (!activeTarget || activeTarget.kind !== "angle") return;
  if (!prepareGizmoKeyboardEvent(e)) return;

  const target = activeTarget;
  const node = getNodeById(target.node.id) ?? target.node;
  const step = keyboardNudgeStep(e);
  const patch = {};
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const direction = e.key === "ArrowLeft" ? -1 : 1;
    const current = readNumericParam(node, target.paramAngle, 0);
    patch[target.paramAngle] = roundKeyboardValue(
      clamp(current + direction * step, target.angleMin, target.angleMax),
    );
  } else {
    const direction = e.key === "ArrowDown" ? -1 : 1;
    const current = readNumericParam(node, target.paramLength, target.lengthMin);
    patch[target.paramLength] = roundKeyboardValue(
      clamp(current + direction * step, target.lengthMin, target.lengthMax),
    );
  }
  commitKeyboardParamPatch(node.id, patch);
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

function onRingCenterKeyDown(e) {
  if (!activeTarget || activeTarget.kind !== "ring") return;
  if (!prepareGizmoKeyboardEvent(e)) return;
  nudgePointLikeTarget(activeTarget, e);
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

function onRingRimKeyDown(e) {
  if (!activeTarget || activeTarget.kind !== "ring") return;
  if (!prepareGizmoKeyboardEvent(e)) return;
  const target = activeTarget;
  const node = getNodeById(target.node.id) ?? target.node;
  const direction = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1;
  const step = keyboardNudgeStep(e);
  const current = readNumericParam(node, target.paramRadius, 35);
  commitKeyboardParamPatch(node.id, {
    [target.paramRadius]: roundKeyboardValue(clamp(current + direction * step, 0, 100)),
  });
}

// ---------------------------------------------------------------------------
// Mesh-gradient stops gizmo handlers
// ---------------------------------------------------------------------------

function onMeshStopCenterDown(e) {
  if (!activeTarget || activeTarget.kind !== "mesh-stops") return;
  const handle = e.currentTarget;
  const stopGroup = handle.closest(".viewer-mesh-stop");
  if (!stopGroup) return;
  const stopIndex = Number(stopGroup.dataset.meshStopIndex);
  if (!Number.isFinite(stopIndex)) return;
  beginDrag(handle, e, {
    nodeId: activeTarget.node.id,
    groupEl: stopGroup,
    stopIndex,
    compute: computeMeshStopCenter,
    commit: commitMeshStopPatch,
  });
}

function computeMeshStopCenter(e, _state) {
  const point = clientToSourcePoint(e.clientX, e.clientY, outputCanvas);
  if (!point) return null;
  return { x: point.nx / 100, y: point.ny / 100 };
}

function onMeshStopRimDown(e) {
  if (!activeTarget || activeTarget.kind !== "mesh-stops") return;
  const handle = e.currentTarget;
  const stopGroup = handle.closest(".viewer-mesh-stop");
  if (!stopGroup) return;
  const stopIndex = Number(stopGroup.dataset.meshStopIndex);
  if (!Number.isFinite(stopIndex)) return;
  beginDrag(handle, e, {
    nodeId: activeTarget.node.id,
    groupEl: stopGroup,
    stopIndex,
    compute: computeMeshStopRadius,
    commit: commitMeshStopPatch,
  });
}

function computeMeshStopRadius(e, state) {
  const point = clientToSourcePoint(e.clientX, e.clientY, outputCanvas);
  if (!point || !outputCanvas) return null;
  // Read the live stop so the centre stays pinned even if the user nudged it
  // via the inspector mid-drag (rare but cheap to defend).
  const stops = activeTarget?.node?.params?.stops ?? [];
  const stop = stops[state.stopIndex];
  if (!stop) return null;
  const centerSrcX = clamp(Number(stop.x ?? 0.5), 0, 1) * outputCanvas.width;
  const centerSrcY = clamp(Number(stop.y ?? 0.5), 0, 1) * outputCanvas.height;
  const dx = point.x - centerSrcX;
  const dy = point.y - centerSrcY;
  const dist = Math.hypot(dx, dy);
  // Shader treats radius as a fraction of canvas height, so back-solve from
  // source-pixel distance / H.
  const radius = clamp(dist / Math.max(outputCanvas.height, 1), 0.02, 2);
  return { radius };
}

function commitMeshStopPatch(state, patch) {
  const node = activeTarget?.node;
  if (!node || node.id !== state.nodeId) return;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  if (state.stopIndex < 0 || state.stopIndex >= stops.length) return;
  const nextStops = stops.map((s, i) => (i === state.stopIndex ? { ...s, ...patch } : s));
  updateNodeParams(state.nodeId, { stops: nextStops });
  // Skip timeline autokey: stops is an array, individual fields aren't
  // tracked by the current timeline schema. Whole-array snapshots only.
}

function onMeshStopCenterKeyDown(e) {
  if (!activeTarget || activeTarget.kind !== "mesh-stops") return;
  if (!prepareGizmoKeyboardEvent(e)) return;
  const stopIndex = resolveMeshStopIndex(e.currentTarget);
  if (!Number.isFinite(stopIndex)) return;
  const node = getNodeById(activeTarget.node.id) ?? activeTarget.node;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  const stop = stops[stopIndex];
  if (!stop) return;
  const step = keyboardNudgeStep(e, 0.01);
  const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
  const patch = {};
  if (dx !== 0) patch.x = roundKeyboardValue(clamp(Number(stop.x ?? 0.5) + dx * step, 0, 1));
  if (dy !== 0) patch.y = roundKeyboardValue(clamp(Number(stop.y ?? 0.5) + dy * step, 0, 1));
  commitKeyboardMeshStopPatch(node.id, stopIndex, patch);
}

function onMeshStopRimKeyDown(e) {
  if (!activeTarget || activeTarget.kind !== "mesh-stops") return;
  if (!prepareGizmoKeyboardEvent(e)) return;
  const stopIndex = resolveMeshStopIndex(e.currentTarget);
  if (!Number.isFinite(stopIndex)) return;
  const node = getNodeById(activeTarget.node.id) ?? activeTarget.node;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  const stop = stops[stopIndex];
  if (!stop) return;
  const direction = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1;
  const step = keyboardNudgeStep(e, 0.01);
  commitKeyboardMeshStopPatch(node.id, stopIndex, {
    radius: roundKeyboardValue(clamp(Number(stop.radius ?? 0.6) + direction * step, 0.02, 2)),
  });
}

function resolveMeshStopIndex(handle) {
  const stopGroup = handle?.closest(".viewer-mesh-stop");
  if (!stopGroup) return NaN;
  return Number(stopGroup.dataset.meshStopIndex);
}

// ---------------------------------------------------------------------------
// Crop / transform box gizmo (F7.3 P2)
// ---------------------------------------------------------------------------
//
// One rect outline for the cropped window, four corner hits and four edge
// hits. Drag a corner to update two adjacent edges; drag an edge to update
// one. Inspector keeps body-drag (translate the whole window) for now —
// rotation / scale handles live on a future transform-box gizmo.

const CROP_HANDLE_BOUNDS = { min: 0, max: 95 };

function createCropBoxGroup() {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("viewer-crop-box-gizmo");
  group.style.display = "none";

  const outline = document.createElementNS(SVG_NS, "rect");
  outline.classList.add("viewer-crop-box-gizmo__outline");
  outline.setAttribute("rx", "0");
  outline.setAttribute("ry", "0");

  group.appendChild(outline);
  cropBoxOutline = outline;

  for (const edge of ["t", "r", "b", "l"]) {
    const hit = document.createElementNS(SVG_NS, "rect");
    hit.classList.add(
      "gizmo-handle",
      "viewer-crop-box-gizmo__edge-hit",
      `viewer-crop-box-gizmo__edge-hit--${edge}`,
    );
    hit.dataset.cropEdge = edge;
    configureGizmoHandle(hit, `Adjust crop ${cropEdgeLabel(edge)} edge`, onCropHandleKeyDown);
    hit.addEventListener("pointerdown", onCropEdgePointerDown);
    group.appendChild(hit);

    const dot = document.createElementNS(SVG_NS, "rect");
    dot.classList.add(
      "viewer-crop-box-gizmo__edge-dot",
      `viewer-crop-box-gizmo__edge-dot--${edge}`,
    );
    dot.dataset.cropEdge = edge;
    group.appendChild(dot);
  }

  for (const corner of ["tl", "tr", "bl", "br"]) {
    const hit = document.createElementNS(SVG_NS, "rect");
    hit.classList.add(
      "gizmo-handle",
      "viewer-crop-box-gizmo__corner-hit",
      `viewer-crop-box-gizmo__corner-hit--${corner}`,
    );
    hit.dataset.cropCorner = corner;
    configureGizmoHandle(hit, `Adjust crop ${cropCornerLabel(corner)} corner`, onCropHandleKeyDown);
    hit.addEventListener("pointerdown", onCropCornerPointerDown);
    group.appendChild(hit);

    const dot = document.createElementNS(SVG_NS, "rect");
    dot.classList.add(
      "viewer-crop-box-gizmo__corner-dot",
      `viewer-crop-box-gizmo__corner-dot--${corner}`,
    );
    dot.dataset.cropCorner = corner;
    group.appendChild(dot);
  }

  return group;
}

function syncCropBox(node) {
  if (!outputCanvas || !cropBoxGroup || !cropBoxOutline) return;
  const left = clamp(Number(node.params?.left ?? 0), 0, 99);
  const right = clamp(Number(node.params?.right ?? 0), 0, 99);
  const top = clamp(Number(node.params?.top ?? 0), 0, 99);
  const bottom = clamp(Number(node.params?.bottom ?? 0), 0, 99);

  // Corners of the crop window in source pixels.
  const x0Src = (left / 100) * outputCanvas.width;
  const y0Src = (top / 100) * outputCanvas.height;
  const x1Src = (1 - right / 100) * outputCanvas.width;
  const y1Src = (1 - bottom / 100) * outputCanvas.height;

  const tlPt = sourceToOverlayPoint(x0Src, y0Src, outputCanvas);
  const brPt = sourceToOverlayPoint(x1Src, y1Src, outputCanvas);
  if (!tlPt || !brPt) return;

  const width = brPt.x - tlPt.x;
  const height = brPt.y - tlPt.y;
  // Negative width/height happen when the inspector winds left+right > 100;
  // surface an empty box so the user sees the degenerate state rather than
  // a flipped rect with confusing handles.
  if (width <= 0 || height <= 0) {
    cropBoxGroup.style.display = "none";
    return;
  }

  cropBoxGroup.style.display = "";
  cropBoxOutline.setAttribute("x", String(tlPt.x));
  cropBoxOutline.setAttribute("y", String(tlPt.y));
  cropBoxOutline.setAttribute("width", String(width));
  cropBoxOutline.setAttribute("height", String(height));

  const EDGE_HIT_THICKNESS = 16;
  const DOT_SIZE = 6;
  const halfDot = DOT_SIZE / 2;
  const cx = tlPt.x + width / 2;
  const cy = tlPt.y + height / 2;

  // Edge hits: thin rect along each side, centred on the edge line. Edge
  // dots: tiny square at midpoint for visual affordance.
  const edges = {
    t: { x: tlPt.x, y: tlPt.y - EDGE_HIT_THICKNESS / 2, w: width, h: EDGE_HIT_THICKNESS, dotX: cx - halfDot, dotY: tlPt.y - halfDot },
    r: { x: brPt.x - EDGE_HIT_THICKNESS / 2, y: tlPt.y, w: EDGE_HIT_THICKNESS, h: height, dotX: brPt.x - halfDot, dotY: cy - halfDot },
    b: { x: tlPt.x, y: brPt.y - EDGE_HIT_THICKNESS / 2, w: width, h: EDGE_HIT_THICKNESS, dotX: cx - halfDot, dotY: brPt.y - halfDot },
    l: { x: tlPt.x - EDGE_HIT_THICKNESS / 2, y: tlPt.y, w: EDGE_HIT_THICKNESS, h: height, dotX: tlPt.x - halfDot, dotY: cy - halfDot },
  };
  for (const [edge, geo] of Object.entries(edges)) {
    const hit = cropBoxGroup.querySelector(`.viewer-crop-box-gizmo__edge-hit--${edge}`);
    const dot = cropBoxGroup.querySelector(`.viewer-crop-box-gizmo__edge-dot--${edge}`);
    if (hit) {
      hit.setAttribute("x", String(geo.x));
      hit.setAttribute("y", String(geo.y));
      hit.setAttribute("width", String(geo.w));
      hit.setAttribute("height", String(geo.h));
      const paramKey = edge === "t" ? "top" : edge === "r" ? "right" : edge === "b" ? "bottom" : "left";
      setGizmoValueText(hit, `${paramKey} ${formatGizmoNumber(Number(node.params?.[paramKey] ?? 0))}%`);
    }
    if (dot) {
      dot.setAttribute("x", String(geo.dotX));
      dot.setAttribute("y", String(geo.dotY));
      dot.setAttribute("width", String(DOT_SIZE));
      dot.setAttribute("height", String(DOT_SIZE));
    }
  }

  // Corner hits / dots
  const CORNER_HIT_SIZE = 18;
  const halfHit = CORNER_HIT_SIZE / 2;
  const CORNER_DOT_SIZE = 8;
  const halfCornerDot = CORNER_DOT_SIZE / 2;
  const corners = {
    tl: { x: tlPt.x, y: tlPt.y },
    tr: { x: brPt.x, y: tlPt.y },
    bl: { x: tlPt.x, y: brPt.y },
    br: { x: brPt.x, y: brPt.y },
  };
  for (const [corner, pt] of Object.entries(corners)) {
    const hit = cropBoxGroup.querySelector(`.viewer-crop-box-gizmo__corner-hit--${corner}`);
    const dot = cropBoxGroup.querySelector(`.viewer-crop-box-gizmo__corner-dot--${corner}`);
    if (hit) {
      hit.setAttribute("x", String(pt.x - halfHit));
      hit.setAttribute("y", String(pt.y - halfHit));
      hit.setAttribute("width", String(CORNER_HIT_SIZE));
      hit.setAttribute("height", String(CORNER_HIT_SIZE));
      setGizmoValueText(
        hit,
        `left ${formatGizmoNumber(left)}%, right ${formatGizmoNumber(right)}%, top ${formatGizmoNumber(top)}%, bottom ${formatGizmoNumber(bottom)}%`,
      );
    }
    if (dot) {
      dot.setAttribute("x", String(pt.x - halfCornerDot));
      dot.setAttribute("y", String(pt.y - halfCornerDot));
      dot.setAttribute("width", String(CORNER_DOT_SIZE));
      dot.setAttribute("height", String(CORNER_DOT_SIZE));
    }
  }
}

function onCropEdgePointerDown(e) {
  if (!activeTarget || activeTarget.kind !== "crop-box") return;
  const edge = e.currentTarget.dataset.cropEdge;
  if (!edge) return;
  beginDrag(e.currentTarget, e, {
    nodeId: activeTarget.node.id,
    groupEl: cropBoxGroup,
    cropEdges: [edge],
    compute: computeCropDrag,
    commit: commitCropPatch,
  });
}

function onCropCornerPointerDown(e) {
  if (!activeTarget || activeTarget.kind !== "crop-box") return;
  const corner = e.currentTarget.dataset.cropCorner;
  if (!corner) return;
  // Two edges per corner. e.g. "tl" → top + left.
  const edges = cropCornerEdges(corner);
  beginDrag(e.currentTarget, e, {
    nodeId: activeTarget.node.id,
    groupEl: cropBoxGroup,
    cropEdges: edges,
    compute: computeCropDrag,
    commit: commitCropPatch,
  });
}

function computeCropDrag(e, state) {
  if (!outputCanvas) return null;
  const point = clientToSourcePoint(e.clientX, e.clientY, outputCanvas);
  if (!point) return null;
  const patch = {};
  const node = activeTarget?.node;
  if (!node) return null;
  const params = node.params ?? {};

  // For each edge being moved, derive the new inset % from the cursor's
  // source-px coordinate, then clamp so opposing edges can't overlap.
  for (const edge of state.cropEdges) {
    if (edge === "l") {
      const next = clamp(point.nx, 0, 100 - Number(params.right ?? 0) - 1);
      patch.left = clamp(next, CROP_HANDLE_BOUNDS.min, CROP_HANDLE_BOUNDS.max);
    } else if (edge === "r") {
      const next = clamp(100 - point.nx, 0, 100 - Number(params.left ?? 0) - 1);
      patch.right = clamp(next, CROP_HANDLE_BOUNDS.min, CROP_HANDLE_BOUNDS.max);
    } else if (edge === "t") {
      const next = clamp(point.ny, 0, 100 - Number(params.bottom ?? 0) - 1);
      patch.top = clamp(next, CROP_HANDLE_BOUNDS.min, CROP_HANDLE_BOUNDS.max);
    } else if (edge === "b") {
      const next = clamp(100 - point.ny, 0, 100 - Number(params.top ?? 0) - 1);
      patch.bottom = clamp(next, CROP_HANDLE_BOUNDS.min, CROP_HANDLE_BOUNDS.max);
    }
  }
  return patch;
}

function commitCropPatch(state, patch) {
  commitParamPatch(state.nodeId, patch);
}

function onCropHandleKeyDown(e) {
  if (!activeTarget || activeTarget.kind !== "crop-box") return;
  if (!prepareGizmoKeyboardEvent(e)) return;

  const edge = e.currentTarget.dataset.cropEdge;
  const corner = e.currentTarget.dataset.cropCorner;
  const edges = edge ? [edge] : cropCornerEdges(corner);
  if (edges.length === 0) return;

  const node = getNodeById(activeTarget.node.id) ?? activeTarget.node;
  const params = node.params ?? {};
  const step = keyboardNudgeStep(e);
  const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
  const patch = {};

  for (const cropEdge of edges) {
    if (cropEdge === "l" && dx !== 0) {
      patch.left = clampCropKeyboardInset("left", readNumericParam(node, "left", 0) + dx * step, params, patch);
    } else if (cropEdge === "r" && dx !== 0) {
      patch.right = clampCropKeyboardInset("right", readNumericParam(node, "right", 0) - dx * step, params, patch);
    } else if (cropEdge === "t" && dy !== 0) {
      patch.top = clampCropKeyboardInset("top", readNumericParam(node, "top", 0) + dy * step, params, patch);
    } else if (cropEdge === "b" && dy !== 0) {
      patch.bottom = clampCropKeyboardInset("bottom", readNumericParam(node, "bottom", 0) - dy * step, params, patch);
    }
  }

  commitKeyboardParamPatch(node.id, patch);
}

function cropCornerEdges(corner) {
  const edges = [];
  if (!corner) return edges;
  if (corner.includes("t")) edges.push("t");
  if (corner.includes("b")) edges.push("b");
  if (corner.includes("l")) edges.push("l");
  if (corner.includes("r")) edges.push("r");
  return edges;
}

function clampCropKeyboardInset(key, value, params, patch) {
  const left = Number(patch.left ?? params.left ?? 0);
  const right = Number(patch.right ?? params.right ?? 0);
  const top = Number(patch.top ?? params.top ?? 0);
  const bottom = Number(patch.bottom ?? params.bottom ?? 0);
  let max = CROP_HANDLE_BOUNDS.max;
  if (key === "left") max = Math.min(max, 100 - right - 1);
  else if (key === "right") max = Math.min(max, 100 - left - 1);
  else if (key === "top") max = Math.min(max, 100 - bottom - 1);
  else if (key === "bottom") max = Math.min(max, 100 - top - 1);
  return roundKeyboardValue(clamp(value, CROP_HANDLE_BOUNDS.min, max));
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function prepareGizmoKeyboardEvent(e) {
  if (!GIZMO_KEYBOARD_KEYS.has(e.key) || e.metaKey || e.ctrlKey) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function keyboardNudgeStep(e, base = 1) {
  if (e.shiftKey) return base * 10;
  if (e.altKey) return base * 0.1;
  return base;
}

function nudgePointLikeTarget(target, e) {
  const node = getNodeById(target.node.id) ?? target.node;
  const step = keyboardNudgeStep(e);
  const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
  const patch = {};
  if (dx !== 0) {
    patch[target.paramX] = roundKeyboardValue(
      clamp(readNumericParam(node, target.paramX, 50) + dx * step, 0, 100),
    );
  }
  if (dy !== 0) {
    patch[target.paramY] = roundKeyboardValue(
      clamp(readNumericParam(node, target.paramY, 50) + dy * step, 0, 100),
    );
  }
  commitKeyboardParamPatch(node.id, patch);
}

function commitKeyboardParamPatch(nodeId, patch) {
  const node = getNodeById(nodeId);
  if (!node || !patch) return;
  const filtered = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Number.isFinite(value)) continue;
    if (Number(node.params?.[key]) !== value) filtered[key] = value;
  }
  if (Object.keys(filtered).length === 0) return;

  const before = snapshotGizmoParams(nodeId);
  commitParamPatch(nodeId, filtered);
  const after = snapshotGizmoParams(nodeId);
  if (before && after && !gizmoParamsEqual(before, after)) {
    pushHistory({
      undo: () => updateNodeParams(nodeId, before),
      redo: () => updateNodeParams(nodeId, after),
    });
  }
}

function commitKeyboardMeshStopPatch(nodeId, stopIndex, patch) {
  const node = getNodeById(nodeId);
  const stops = Array.isArray(node?.params?.stops) ? node.params.stops : [];
  if (stopIndex < 0 || stopIndex >= stops.length) return;
  const stop = stops[stopIndex];
  const filtered = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Number.isFinite(value)) continue;
    if (Number(stop?.[key]) !== value) filtered[key] = value;
  }
  if (Object.keys(filtered).length === 0) return;

  const before = snapshotGizmoParams(nodeId);
  const nextStops = stops.map((s, i) => (i === stopIndex ? { ...s, ...filtered } : s));
  updateNodeParams(nodeId, { stops: nextStops });
  const after = snapshotGizmoParams(nodeId);
  if (before && after && !gizmoParamsEqual(before, after)) {
    pushHistory({
      undo: () => updateNodeParams(nodeId, before),
      redo: () => updateNodeParams(nodeId, after),
    });
  }
}

function readNumericParam(node, key, fallback) {
  const value = Number(node?.params?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function roundKeyboardValue(value) {
  return Number(value.toFixed(4));
}

function formatGizmoNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return Number.isInteger(numeric)
    ? String(numeric)
    : numeric.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function cropEdgeLabel(edge) {
  if (edge === "t") return "top";
  if (edge === "r") return "right";
  if (edge === "b") return "bottom";
  return "left";
}

function cropCornerLabel(corner) {
  if (corner === "tl") return "top left";
  if (corner === "tr") return "top right";
  if (corner === "bl") return "bottom left";
  return "bottom right";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
