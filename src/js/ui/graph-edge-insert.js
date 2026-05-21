import { getState } from "../state.js";
import {
  EDGE_INSERT_FALLBACK_RADIUS,
  EDGE_INSERT_RADIUS,
} from "./graph-geometry.js";

let edgesEl = null;
let insertHighlightEdgeId = "";

export function initGraphEdgeInsertTargets(deps) {
  edgesEl = deps.edgesEl;
}

export function findInsertableEdgeAt(clientX, clientY) {
  let best = null;

  for (const path of edgesEl?.querySelectorAll(".graph-edge[data-edge-id]") ?? []) {
    const distance = distanceToEdgePath(path, clientX, clientY);
    if (!Number.isFinite(distance) || distance > EDGE_INSERT_RADIUS) continue;
    if (best && best.distance <= distance) continue;
    best = {
      edgeId: path.dataset.edgeId,
      distance,
      el: path,
    };
  }

  return best;
}

// Last-resort lookup: when path sampling didn't snap to anything (often
// because the user dropped a bit far from the line), accept the closest
// edge whose midpoint is within the fallback radius.
function findClosestEdgeByMidpoint(clientX, clientY) {
  let best = null;
  for (const path of edgesEl?.querySelectorAll(".graph-edge[data-edge-id]") ?? []) {
    if (!path?.getBoundingClientRect) continue;
    const rect = path.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const mx = rect.left + rect.width / 2;
    const my = rect.top + rect.height / 2;
    const distance = Math.hypot(clientX - mx, clientY - my);
    if (distance > EDGE_INSERT_FALLBACK_RADIUS) continue;
    if (best && best.distance <= distance) continue;
    best = { edgeId: path.dataset.edgeId, distance, el: path };
  }
  return best;
}

export function findInsertTargetAt(clientX, clientY) {
  return (
    findInsertableEdgeAt(clientX, clientY) ??
    getHighlightedInsertEdge() ??
    findClosestEdgeByMidpoint(clientX, clientY)
  );
}

export function findInsertTargetForNodeAt(nodeId, clientX, clientY) {
  const target = findInsertTargetAt(clientX, clientY);
  if (!target?.edgeId || edgeTouchesNode(target.edgeId, nodeId)) return null;
  return target;
}

function edgeTouchesNode(edgeId, nodeId) {
  const { graph } = getState();
  const edge = graph.edges.find((item) => item.id === edgeId);
  return Boolean(edge && (edge.fromNode === nodeId || edge.toNode === nodeId));
}

function getHighlightedInsertEdge() {
  if (!insertHighlightEdgeId) return null;
  const el = edgesEl?.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`);
  if (!el) return null;
  return {
    edgeId: insertHighlightEdgeId,
    distance: 0,
    el,
  };
}

function distanceToEdgePath(path, clientX, clientY) {
  if (!path?.getTotalLength) return Infinity;
  const total = path.getTotalLength();
  if (!Number.isFinite(total) || total <= 0) return Infinity;
  if (!isNearClientRect(path.getBoundingClientRect(), clientX, clientY, EDGE_INSERT_RADIUS)) {
    return Infinity;
  }

  let best = Infinity;
  const matrix = path.getScreenCTM?.() ?? null;
  const step = Math.max(4, total / 64);
  for (let length = 0; length <= total; length += step) {
    const point = path.getPointAtLength(length);
    const screenPoint = toScreenPoint(point, matrix);
    best = Math.min(best, Math.hypot(clientX - screenPoint.x, clientY - screenPoint.y));
  }

  const endPoint = path.getPointAtLength(total);
  const screenEndPoint = toScreenPoint(endPoint, matrix);
  best = Math.min(best, Math.hypot(clientX - screenEndPoint.x, clientY - screenEndPoint.y));
  return best;
}

function toScreenPoint(point, matrix) {
  if (!matrix || typeof DOMPoint !== "function") return point;
  return new DOMPoint(point.x, point.y).matrixTransform(matrix);
}

function isNearClientRect(rect, clientX, clientY, padding) {
  if (!rect?.width && !rect?.height) return true;
  return (
    clientX >= rect.left - padding &&
    clientX <= rect.right + padding &&
    clientY >= rect.top - padding &&
    clientY <= rect.bottom + padding
  );
}

export function setInsertHighlight(edgeId) {
  if (insertHighlightEdgeId === edgeId) return;

  if (insertHighlightEdgeId) {
    edgesEl?.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`)?.classList.remove("insert-target");
  }

  insertHighlightEdgeId = edgeId || "";
  syncInsertHighlight();
}

export function clearInsertHighlight() {
  setInsertHighlight("");
}

export function syncInsertHighlight() {
  if (insertHighlightEdgeId) {
    edgesEl?.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`)?.classList.add("insert-target");
  }
}
