import { dispatch, getState } from "../state.js";
import {
  ROOT_PARENT_ID,
  duplicateNodes,
  getNodeById,
  getNodeParentId,
  getSelectedNode,
  getSelectedNodeIds,
  groupSelectedNodes,
  removeNode,
  resolveGraphParentId,
  selectNodes,
  toggleNodeBypass,
  toggleNodeSolo,
  ungroupNode,
} from "../graph.js";
import {
  GRAPH_VIEW_PADDING,
  getGraphNodesBounds,
  toSceneX,
  toSceneY,
} from "./graph-geometry.js";

let editorEl = null;

export function initGraphActions(deps) {
  editorEl = deps.editorEl;
}

export function duplicateSelectedGraphNodes() {
  const selectedIds = getSelectedNodeIds();
  if (selectedIds.length === 0) return false;
  return duplicateNodes(selectedIds).length > 0;
}

export function toggleBypassForSelectedNodes() {
  const ids = getSelectedNodeIds().filter((nodeId) => canBypassGraphNode(getNodeById(nodeId)));
  let changed = false;
  for (const id of ids) {
    changed = toggleNodeBypass(id) || changed;
  }
  return changed;
}

export function removeSelectedGraphNodes() {
  const ids = getSelectedNodeIds();
  let removed = false;
  for (const id of ids) {
    removed = removeNode(id) || removed;
  }
  return removed;
}

export function selectAllVisibleGraphNodes() {
  const { graph } = getState();
  const ids = getVisibleGraphNodes(graph).map((node) => node.id);
  if (ids.length === 0) return false;
  selectNodes(ids, ids.at(-1));
  return true;
}

export function clearGraphSelection() {
  if (getSelectedNodeIds().length === 0) return false;
  selectNodes([]);
  return true;
}

export function frameSelectedGraphNodes() {
  const { graph } = getState();
  const visibleNodeIds = getVisibleGraphNodeIds(graph);
  const nodes = getSelectedNodeIds(graph)
    .filter((nodeId) => visibleNodeIds.has(nodeId))
    .map((nodeId) => getNodeById(nodeId, graph))
    .filter(Boolean);
  if (nodes.length === 0) return false;

  const rect = editorEl?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return false;

  const bounds = getGraphNodesBounds(nodes);
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const padding = Math.min(GRAPH_VIEW_PADDING, Math.max(48, Math.min(rect.width, rect.height) * 0.18));
  const zoom = clamp(
    Math.min((rect.width - padding * 2) / contentWidth, (rect.height - padding * 2) / contentHeight),
    0.35,
    1.65
  );
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  dispatch("graphView", {
    zoom,
    panX: rect.width / 2 - toSceneX(centerX) * zoom,
    panY: rect.height / 2 - toSceneY(centerY) * zoom,
  });
  return true;
}

export function toggleSoloForSelectedNode() {
  const nodeId = getState().graph.selectedNodeId ?? getSelectedNodeIds().at(-1);
  if (!nodeId) return false;
  return toggleNodeSolo(nodeId);
}

export function groupCurrentSelection() {
  const groupId = groupSelectedNodes();
  if (!groupId) return false;
  return true;
}

export function ungroupCurrentSelection() {
  const { graph, graphView } = getState();
  const selected = getSelectedNode(graph);
  if (selected?.type === "group") {
    return ungroupNode(selected.id);
  }
  const currentParent = resolveGraphParentId(graph, graphView.currentParentId);
  return currentParent !== ROOT_PARENT_ID ? ungroupNode(currentParent) : false;
}

function canBypassGraphNode(node) {
  return Boolean(node && node.type !== "source" && node.type !== "viewer-output" && node.type !== "group");
}

function getCurrentGraphParentId() {
  const { graph, graphView } = getState();
  return resolveGraphParentId(graph, graphView.currentParentId);
}

function getVisibleGraphNodes(graph, parentId = getCurrentGraphParentId()) {
  return graph.nodes.filter((node) => getNodeParentId(node) === parentId);
}

function getVisibleGraphNodeIds(graph, parentId = getCurrentGraphParentId()) {
  return new Set(getVisibleGraphNodes(graph, parentId).map((node) => node.id));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
