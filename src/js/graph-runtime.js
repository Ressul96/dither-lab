import { getNodeById } from "./graph.js";
import {
  applyAdjustNode,
  applyBlurNode,
  applyDistortNode,
  applyDitherNode,
  applyGlowNode,
  applyMixNode,
} from "./image-ops.js";

export function evaluateViewerOutput(graph, context) {
  return evaluateGraphOutputs(graph, context).viewerOutput;
}

export function evaluateGraphOutputs(graph, context) {
  if (!graph?.nodes?.length) {
    return {
      viewerOutput: null,
      ditherOutput: null,
    };
  }

  const order = topologicalSort(graph);
  const results = new Map();

  for (const nodeId of order) {
    const node = getNodeById(nodeId, graph);
    if (!node) continue;

    const output = evaluateNode(node, graph, results, context);
    results.set(node.id, output ?? null);
  }

  const viewerNode = graph.nodes.find((node) => node.type === "viewer-output");
  if (!viewerNode) {
    return {
      viewerOutput: null,
      ditherOutput: null,
    };
  }

  const ditherNodeId = findNearestUpstreamNodeOfType(viewerNode.id, graph, "dither");
  return {
    viewerOutput: results.get(viewerNode.id) ?? null,
    ditherOutput: ditherNodeId ? results.get(ditherNodeId) ?? null : null,
  };
}

function evaluateNode(node, graph, results, context) {
  switch (node.type) {
    case "source":
      return context.sourceImage ?? null;
    case "adjust":
      return applyAdjustNode(resolveInputImage(node, "image", graph, results), node.params);
    case "blur":
      return applyBlurNode(resolveInputImage(node, "image", graph, results), node.params);
    case "dither":
      return applyDitherNode(resolveInputImage(node, "image", graph, results), node.params);
    case "glow":
      return applyGlowNode(resolveInputImage(node, "image", graph, results), node.params);
    case "distort":
      return applyDistortNode(resolveInputImage(node, "image", graph, results), node.params);
    case "mix":
      return applyMixNode(
        resolveInputImage(node, "image_a", graph, results),
        resolveInputImage(node, "image_b", graph, results),
        node.params
      );
    case "viewer-output":
      return resolveInputImage(node, "image", graph, results);
    default:
      // Unknown nodes stay passthrough-friendly during the transition so the shell
      // can evolve without crashing the preview.
      return resolveFirstConnectedInput(node, graph, results);
  }
}

function resolveInputImage(node, socketName, graph, results) {
  const edge = graph.edges.find(
    (item) => item.toNode === node.id && item.toSocket === socketName
  );
  if (!edge) return null;
  return results.get(edge.fromNode) ?? null;
}

function resolveFirstConnectedInput(node, graph, results) {
  const edge = graph.edges.find((item) => item.toNode === node.id);
  if (!edge) return null;
  return results.get(edge.fromNode) ?? null;
}

function topologicalSort(graph) {
  const incomingCount = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));

  for (const edge of graph.edges) {
    if (!incomingCount.has(edge.toNode) || !outgoing.has(edge.fromNode)) continue;
    incomingCount.set(edge.toNode, incomingCount.get(edge.toNode) + 1);
    outgoing.get(edge.fromNode).push(edge.toNode);
  }

  const queue = graph.nodes
    .map((node) => node.id)
    .filter((nodeId) => (incomingCount.get(nodeId) ?? 0) === 0);
  const order = [];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    order.push(nodeId);

    for (const nextNodeId of outgoing.get(nodeId) ?? []) {
      const nextCount = (incomingCount.get(nextNodeId) ?? 0) - 1;
      incomingCount.set(nextNodeId, nextCount);
      if (nextCount === 0) queue.push(nextNodeId);
    }
  }

  if (order.length === graph.nodes.length) return order;

  // Invalid cyclic sections intentionally remain unevaluated so graph problems
  // surface as missing output instead of producing a misleading frame.
  return order;
}

function findNearestUpstreamNodeOfType(startNodeId, graph, type) {
  const queue = [startNodeId];
  const visited = new Set();

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = getNodeById(nodeId, graph);
    if (node && node.id !== startNodeId && node.type === type) {
      return node.id;
    }

    for (const edge of graph.edges) {
      if (edge.toNode === nodeId) {
        queue.push(edge.fromNode);
      }
    }
  }

  return null;
}
