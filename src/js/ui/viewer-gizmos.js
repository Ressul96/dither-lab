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

// Drag movement under this many pixels stays "ambient" and does not lock onto
// an axis even with Shift held — keeps a single-pixel jitter from picking the
// wrong axis before the user clearly commits to a direction.
const SHIFT_AXIS_THRESHOLD_PX = 2;

let pointGroup = null;
let pointHit = null;
let outputCanvas = null;
let activeNode = null;
let dragState = null;
let resyncQueued = false;

export function initViewerGizmos() {
  const overlay = getViewerOverlay();
  outputCanvas = document.getElementById("output");
  if (!overlay || !outputCanvas) return;

  pointGroup = createPointGizmo();
  overlay.appendChild(pointGroup);

  subscribe("graph", schedulePointSync);
  subscribe("view", schedulePointSync);
  subscribe("source", schedulePointSync);
  window.addEventListener("resize", schedulePointSync);

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(schedulePointSync).observe(outputCanvas);
  }

  schedulePointSync();
}

function createPointGizmo() {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("viewer-point-gizmo");
  group.style.display = "none";

  const hit = document.createElementNS(SVG_NS, "circle");
  hit.classList.add("gizmo-handle", "viewer-point-gizmo__hit");
  hit.setAttribute("r", "18");

  const ring = document.createElementNS(SVG_NS, "circle");
  ring.classList.add("viewer-point-gizmo__ring");
  ring.setAttribute("r", "8.5");

  const dot = document.createElementNS(SVG_NS, "circle");
  dot.classList.add("viewer-point-gizmo__dot");
  dot.setAttribute("r", "3.5");

  group.append(hit, ring, dot);
  hit.addEventListener("pointerdown", onPointerDown);
  hit.addEventListener("dblclick", onDoubleClick);
  pointHit = hit;
  return group;
}

function schedulePointSync() {
  if (resyncQueued) return;
  resyncQueued = true;
  requestAnimationFrame(() => {
    resyncQueued = false;
    syncPointGizmo();
  });
}

function syncPointGizmo() {
  if (!pointGroup || !outputCanvas) return;
  const node = resolveTargetNode();
  if (!node) {
    if (pointGroup.style.display !== "none") pointGroup.style.display = "none";
    activeNode = null;
    return;
  }
  activeNode = node;
  const centerX = Number(node.params?.centerX ?? 50);
  const centerY = Number(node.params?.centerY ?? 50);
  const srcX = (centerX / 100) * outputCanvas.width;
  const srcY = (centerY / 100) * outputCanvas.height;
  const overlayPt = sourceToOverlayPoint(srcX, srcY, outputCanvas);
  if (!overlayPt) {
    pointGroup.style.display = "none";
    return;
  }
  if (pointGroup.style.display === "none") pointGroup.style.display = "";
  pointGroup.setAttribute("transform", `translate(${overlayPt.x} ${overlayPt.y})`);
}

function resolveTargetNode() {
  if (!outputCanvas || outputCanvas.classList.contains("hidden")) return null;
  if (!outputCanvas.width || !outputCanvas.height) return null;
  // Side-by-side compare splits the viewer into two panes — duplicating the
  // gizmo in both pretends both halves are editable, so suppress entirely
  // until a future phase introduces an explicit "edit on processed" toggle.
  if (getState().view?.compare === "side-by-side") return null;

  const node = getSelectedNode();
  if (!node) return null;
  if (node.type === "lens-distort") return node;
  if (node.type === "chromatic-aberration" && node.params?.mode === "radial") return node;
  return null;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (!activeNode || !outputCanvas) return;
  e.preventDefault();
  e.stopPropagation();

  try {
    pointHit.setPointerCapture(e.pointerId);
  } catch (_) {}

  dragState = {
    nodeId: activeNode.id,
    pointerId: e.pointerId,
    startCenter: {
      x: Number(activeNode.params?.centerX ?? 50),
      y: Number(activeNode.params?.centerY ?? 50),
    },
    pointerOrigin: { x: e.clientX, y: e.clientY },
    shiftAxis: null,
    pending: null,
    flushQueued: false,
  };
  pointGroup.dataset.dragging = "true";
  document.body.classList.add("dragging-gizmo");

  pointHit.addEventListener("pointermove", onPointerMove);
  pointHit.addEventListener("pointerup", onPointerEnd);
  pointHit.addEventListener("pointercancel", onPointerEnd);
}

function onPointerMove(e) {
  if (!dragState || !outputCanvas) return;
  const point = clientToSourcePoint(e.clientX, e.clientY, outputCanvas);
  if (!point) return;

  let nx = point.nx;
  let ny = point.ny;

  if (e.shiftKey) {
    if (!dragState.shiftAxis) {
      const dx = Math.abs(e.clientX - dragState.pointerOrigin.x);
      const dy = Math.abs(e.clientY - dragState.pointerOrigin.y);
      if (dx > SHIFT_AXIS_THRESHOLD_PX || dy > SHIFT_AXIS_THRESHOLD_PX) {
        dragState.shiftAxis = dx > dy ? "x" : "y";
      }
    }
    if (dragState.shiftAxis === "x") ny = dragState.startCenter.y;
    else if (dragState.shiftAxis === "y") nx = dragState.startCenter.x;
  } else {
    dragState.shiftAxis = null;
  }

  dragState.pending = { centerX: nx, centerY: ny };
  scheduleDragFlush();
}

function scheduleDragFlush() {
  if (!dragState || dragState.flushQueued) return;
  const localState = dragState;
  localState.flushQueued = true;
  requestAnimationFrame(() => {
    if (dragState !== localState) return;
    localState.flushQueued = false;
    if (!localState.pending) return;
    const { centerX, centerY } = localState.pending;
    localState.pending = null;
    applyDragValue(localState.nodeId, centerX, centerY);
  });
}

function applyDragValue(nodeId, centerX, centerY) {
  updateNodeParams(nodeId, { centerX, centerY });
  commitOrUpdateKeyframe(nodeId, "centerX", centerX);
  commitOrUpdateKeyframe(nodeId, "centerY", centerY);
}

function commitOrUpdateKeyframe(nodeId, paramKey, value) {
  if (!commitParamValueToTimeline(nodeId, paramKey, value)) {
    updateParamKeyframeAtCurrentTime(nodeId, paramKey, value);
  }
}

function onPointerEnd(e) {
  if (!dragState) return;
  try {
    pointHit.releasePointerCapture(e.pointerId);
  } catch (_) {}
  pointHit.removeEventListener("pointermove", onPointerMove);
  pointHit.removeEventListener("pointerup", onPointerEnd);
  pointHit.removeEventListener("pointercancel", onPointerEnd);

  if (dragState.pending) {
    const { centerX, centerY } = dragState.pending;
    applyDragValue(dragState.nodeId, centerX, centerY);
  }

  delete pointGroup.dataset.dragging;
  document.body.classList.remove("dragging-gizmo");
  dragState = null;
}

function onDoubleClick(e) {
  if (!activeNode) return;
  e.preventDefault();
  e.stopPropagation();
  applyDragValue(activeNode.id, 50, 50);
}
