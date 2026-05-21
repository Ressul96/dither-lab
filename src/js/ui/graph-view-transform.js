import { DEFAULT_GRAPH_VIEW, dispatch, getState } from "../state.js";
import {
  GRAPH_GRID_STEP,
  GRAPH_VIEW_PADDING,
  GRAPH_WORLD_ORIGIN,
  NODE_HEIGHT,
  NODE_WIDTH,
  modulo,
  toSceneX,
  toSceneY,
} from "./graph-geometry.js";
import { getVisibleGraphNodes } from "./graph-view-scope.js";

let editorEl = null;
let nodesEl = null;
let edgesEl = null;
let graphAutoCentered = false;

export function initGraphViewTransform(deps) {
  editorEl = deps.editorEl;
  nodesEl = deps.nodesEl;
  edgesEl = deps.edgesEl;
  graphAutoCentered = false;
}

export function applyGraphViewport() {
  if (!editorEl || !nodesEl || !edgesEl) return;

  const { graphView } = getState();
  const transform = `translate(${graphView.panX}px, ${graphView.panY}px) scale(${graphView.zoom})`;
  nodesEl.style.transform = transform;
  edgesEl.style.transform = transform;
  edgesEl.style.transformOrigin = "0 0";
  nodesEl.style.transformOrigin = "0 0";

  const gridSize = GRAPH_GRID_STEP * graphView.zoom;
  const offsetX = modulo(graphView.panX + GRAPH_WORLD_ORIGIN * graphView.zoom, gridSize);
  const offsetY = modulo(graphView.panY + GRAPH_WORLD_ORIGIN * graphView.zoom, gridSize);
  editorEl.style.setProperty("--graph-grid-size", String(gridSize));
  editorEl.style.setProperty("--graph-grid-offset-x", String(offsetX));
  editorEl.style.setProperty("--graph-grid-offset-y", String(offsetY));
  editorEl.style.setProperty("--graph-zoom", String(graphView.zoom));
}

export function syncGraphAutoCenterReset() {
  const { graphView } = getState();
  if (
    graphView.zoom === DEFAULT_GRAPH_VIEW.zoom &&
    graphView.panX === DEFAULT_GRAPH_VIEW.panX &&
    graphView.panY === DEFAULT_GRAPH_VIEW.panY
  ) {
    graphAutoCentered = false;
  }
}

export function maybeAutoCenterGraph() {
  if (graphAutoCentered || !editorEl) return;
  const { graph, graphView } = getState();
  if (
    graphView.zoom !== DEFAULT_GRAPH_VIEW.zoom ||
    graphView.panX !== DEFAULT_GRAPH_VIEW.panX ||
    graphView.panY !== DEFAULT_GRAPH_VIEW.panY
  ) {
    return;
  }

  const rect = editorEl.getBoundingClientRect();
  const visibleNodes = getVisibleGraphNodes(graph);
  if (!rect.width || !rect.height || visibleNodes.length === 0) return;

  const bounds = visibleNodes.reduce(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      maxX: Math.max(acc.maxX, node.x + NODE_WIDTH),
      minY: Math.min(acc.minY, node.y),
      maxY: Math.max(acc.maxY, node.y + NODE_HEIGHT),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );

  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const fitZoom = Math.min(
    (rect.width - GRAPH_VIEW_PADDING * 2) / contentWidth,
    (rect.height - GRAPH_VIEW_PADDING * 2) / contentHeight
  );
  const zoom = clamp(Math.min(0.92, fitZoom), 0.45, 1.2);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  graphAutoCentered = true;
  dispatch("graphView", {
    zoom,
    panX: rect.width / 2 - toSceneX(centerX) * zoom,
    panY: rect.height / 2 - toSceneY(centerY) * zoom,
  });
}

export function clientToWorld(clientX, clientY) {
  const { graphView } = getState();
  const local = getLocalPoint(clientX, clientY);
  return {
    x: local.x / graphView.zoom - graphView.panX / graphView.zoom - GRAPH_WORLD_ORIGIN,
    y: local.y / graphView.zoom - graphView.panY / graphView.zoom - GRAPH_WORLD_ORIGIN,
  };
}

export function clientToScene(clientX, clientY) {
  const point = clientToWorld(clientX, clientY);
  return {
    x: toSceneX(point.x),
    y: toSceneY(point.y),
  };
}

export function getViewportCenterWorld() {
  const rect = editorEl.getBoundingClientRect();
  return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

export function getLocalPoint(clientX, clientY) {
  const rect = editorEl.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
