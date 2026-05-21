import {
  createFreeNode,
  getNodeDefinition,
  insertNodeOnEdge,
} from "../graph.js";
import { getState } from "../state.js";
import { NODE_HEIGHT, NODE_WIDTH } from "./graph-geometry.js";
import {
  getCurrentGraphParentId,
  getVisibleGraphNodeIds,
} from "./graph-view-scope.js";
import { getViewportCenterWorld } from "./graph-view-transform.js";

export function insertPaletteNodeAtDefault(type) {
  const definition = getNodeDefinition(type);
  const viewerEdgeId = getViewerInputEdgeId();
  if (definition?.chainable !== false && viewerEdgeId) {
    return insertNodeOnEdge(viewerEdgeId, type);
  }
  return createNodeFromPalette(type, getViewportCenterWorld());
}

export function createNodeFromPalette(type, point) {
  if (!type || !point) return null;
  return createFreeNode(type, nodePositionFromPoint(point), getCurrentGraphParentId());
}

export function nodePositionFromPoint(point) {
  return {
    x: point.x - NODE_WIDTH / 2,
    y: point.y - NODE_HEIGHT / 2,
  };
}

function getViewerInputEdgeId() {
  const { graph } = getState();
  const visibleNodeIds = getVisibleGraphNodeIds(graph);
  const viewer = graph.nodes.find((node) => node.type === "viewer-output" && visibleNodeIds.has(node.id));
  const primarySocket = viewer?.inputs?.[0]?.name;
  if (!viewer || !primarySocket) return null;
  return graph.edges.find(
    (edge) =>
      edge.toNode === viewer.id &&
      edge.toSocket === primarySocket &&
      visibleNodeIds.has(edge.fromNode)
  )?.id ?? null;
}
