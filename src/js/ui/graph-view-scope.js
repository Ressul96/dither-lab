import { getState } from "../state.js";
import {
  getNodeParentId,
  resolveGraphParentId,
} from "../graph.js";

export function getCurrentGraphParentId(graph = null, graphView = null) {
  const state = graph && graphView ? null : getState();
  const activeGraph = graph ?? state.graph;
  const activeView = graphView ?? state.graphView;
  return resolveGraphParentId(activeGraph, activeView.currentParentId);
}

export function getVisibleGraphNodes(graph, parentId = getCurrentGraphParentId(graph, getState().graphView)) {
  return graph.nodes.filter((node) => getNodeParentId(node) === parentId);
}

export function getVisibleGraphNodeIds(graph, parentId = getCurrentGraphParentId(graph, getState().graphView)) {
  return new Set(getVisibleGraphNodes(graph, parentId).map((node) => node.id));
}
