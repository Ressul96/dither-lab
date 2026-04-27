import { getNodeById } from "./graph.js";
import {
  applyAdjustNode,
  applyBlurNode,
  applyDitherNode,
  applyGlowNode,
  applyInvertNode,
  applyLensDistortNode,
  applyMixNode,
  applyPixelateNode,
  applyPosterizeNode,
  applyRgbToBwNode,
  applyScaleNode,
  applyToneMapNode,
  releaseBuffer,
} from "./image-ops.js";

// Per-node memoization. Each entry pins its output canvas — buffer pool must
// not reclaim it until the cache invalidates (params/inputs/source change or
// the node leaves the graph). Without this, paused-frame param tweaks would
// re-evaluate the entire effect chain even when only one node actually moved.
const nodeCache = new Map();
let versionCounter = 0;

export function isOutputCached(canvas) {
  if (!canvas) return false;
  for (const entry of nodeCache.values()) {
    if (entry?.output === canvas) return true;
  }
  return false;
}

export function clearGraphCache() {
  for (const entry of nodeCache.values()) {
    if (entry?.output) releaseBuffer(entry.output);
  }
  nodeCache.clear();
}

export function evaluateViewerOutput(graph, context) {
  return evaluateGraphOutputs(graph, context).viewerOutput;
}

export function isNodeHidden(node) {
  return Boolean(node && node.visible === false);
}

export function pruneHiddenGraph(graph) {
  if (!graph?.nodes?.length) return graph ?? { nodes: [], edges: [] };
  const visibleNodes = graph.nodes.filter((node) => !isNodeHidden(node));
  if (visibleNodes.length === graph.nodes.length) return graph;

  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = (graph.edges ?? []).filter(
    (edge) => visibleIds.has(edge.fromNode) && visibleIds.has(edge.toNode)
  );
  return { ...graph, nodes: visibleNodes, edges: visibleEdges };
}

export function evaluateGraphOutputs(graph, context) {
  const scoped = pruneHiddenGraph(graph);
  if (!scoped?.nodes?.length) {
    return {
      viewerOutput: null,
      ditherOutput: null,
    };
  }

  const sourceVersion = context?.sourceVersion ?? "live";
  const order = topologicalSort(scoped);
  const results = new Map();
  const versions = new Map();
  const reachableIds = new Set();

  for (const nodeId of order) {
    const node = getNodeById(nodeId, scoped);
    if (!node) continue;
    reachableIds.add(node.id);

    if (node.type === "source") {
      const output = context?.sourceImage ?? null;
      results.set(node.id, output);
      versions.set(node.id, `source@${sourceVersion}`);
      continue;
    }

    if (node.type === "viewer-output") {
      const output = resolveInputImage(node, "image", scoped, results);
      results.set(node.id, output);
      versions.set(node.id, inputVersionKey(node, scoped, versions, "image"));
      continue;
    }

    const inputSockets = inputSocketsFor(node);
    const inputVersions = inputSockets.map((socket) =>
      inputVersionKey(node, scoped, versions, socket)
    );
    const paramsHash = hashParams(node.params);
    const cached = nodeCache.get(node.id);
    if (
      cached &&
      cached.type === node.type &&
      cached.paramsHash === paramsHash &&
      arraysEqual(cached.inputVersions, inputVersions)
    ) {
      results.set(node.id, cached.output);
      versions.set(node.id, cached.version);
      continue;
    }

    const output = computeNodeOutput(node, scoped, results);
    if (output) {
      // A node may pass its input through unchanged (blur radius=0, lens-
      // distort with no effect, etc.). Caching that buffer would mean the
      // node "owns" a canvas it doesn't actually own — clearGraphCache or
      // eviction would then return the source/upstream canvas to the pool
      // while another node still holds it, and the next acquireBuffer
      // would clearRect it out from under them.
      const sourceImage = context?.sourceImage ?? null;
      const passthrough = output === sourceImage || sharesOutputWithCachedNode(output);
      if (passthrough) {
        if (cached) {
          if (cached.output) releaseBuffer(cached.output);
          nodeCache.delete(node.id);
        }
        results.set(node.id, output);
        versions.set(node.id, `pass@${inputVersions.join("|")}`);
      } else {
        const version = `n${++versionCounter}`;
        if (cached?.output && cached.output !== output) {
          releaseBuffer(cached.output);
        }
        nodeCache.set(node.id, {
          type: node.type,
          paramsHash,
          inputVersions,
          output,
          version,
        });
        results.set(node.id, output);
        versions.set(node.id, version);
      }
    } else {
      if (cached) {
        if (cached.output) releaseBuffer(cached.output);
        nodeCache.delete(node.id);
      }
      results.set(node.id, null);
      versions.set(node.id, "null");
    }
  }

  pruneCache(reachableIds);

  const viewerNode = scoped.nodes.find((node) => node.type === "viewer-output");
  if (!viewerNode) {
    releaseIntermediateBuffers(results, gatherCachedOutputs(), context);
    return {
      viewerOutput: null,
      ditherOutput: null,
    };
  }

  const ditherNodeId = findNearestUpstreamNodeOfType(viewerNode.id, scoped, "dither");
  const viewerOutput = results.get(viewerNode.id) ?? null;
  const ditherOutput = ditherNodeId ? results.get(ditherNodeId) ?? null : null;

  const keep = gatherCachedOutputs();
  if (viewerOutput) keep.add(viewerOutput);
  if (ditherOutput) keep.add(ditherOutput);
  releaseIntermediateBuffers(results, keep, context);

  return { viewerOutput, ditherOutput };
}

function gatherCachedOutputs() {
  const set = new Set();
  for (const entry of nodeCache.values()) {
    if (entry?.output) set.add(entry.output);
  }
  return set;
}

function sharesOutputWithCachedNode(output) {
  for (const entry of nodeCache.values()) {
    if (entry?.output === output) return true;
  }
  return false;
}

function pruneCache(reachableIds) {
  for (const [id, entry] of nodeCache) {
    if (reachableIds.has(id)) continue;
    if (entry?.output) releaseBuffer(entry.output);
    nodeCache.delete(id);
  }
}

function inputSocketsFor(node) {
  switch (node.type) {
    case "mix":
      return ["image_a", "image_b"];
    default:
      return ["image"];
  }
}

function inputVersionKey(node, graph, versions, socket) {
  const edge = graph.edges.find(
    (item) => item.toNode === node.id && item.toSocket === socket
  );
  if (!edge) return "none";
  const upstreamVersion = versions.get(edge.fromNode);
  return `${edge.fromNode}:${upstreamVersion ?? "?"}`;
}

function hashParams(params) {
  if (!params || typeof params !== "object") return "";
  const keys = Object.keys(params).sort();
  let out = "";
  for (const key of keys) {
    const value = params[key];
    if (value === null || value === undefined) {
      out += `${key}=∅;`;
    } else if (typeof value === "object") {
      out += `${key}=${JSON.stringify(value)};`;
    } else {
      out += `${key}=${value};`;
    }
  }
  return out;
}

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function releaseIntermediateBuffers(results, keep, context) {
  const sourceImage = context?.sourceImage ?? null;
  const seen = new Set();
  for (const output of results.values()) {
    if (!output) continue;
    if (output === sourceImage) continue;
    if (keep.has(output)) continue;
    if (seen.has(output)) continue;
    seen.add(output);
    releaseBuffer(output);
  }
}

function computeNodeOutput(node, graph, results) {
  switch (node.type) {
    case "adjust":
      return applyAdjustNode(resolveInputImage(node, "image", graph, results), node.params);
    case "posterize":
      return applyPosterizeNode(resolveInputImage(node, "image", graph, results), node.params);
    case "invert":
      return applyInvertNode(resolveInputImage(node, "image", graph, results), node.params);
    case "rgb-to-bw":
      return applyRgbToBwNode(resolveInputImage(node, "image", graph, results), node.params);
    case "tone-map":
      return applyToneMapNode(resolveInputImage(node, "image", graph, results), node.params);
    case "blur":
      return applyBlurNode(resolveInputImage(node, "image", graph, results), node.params);
    case "pixelate":
      return applyPixelateNode(resolveInputImage(node, "image", graph, results), node.params);
    case "scale":
      return applyScaleNode(resolveInputImage(node, "image", graph, results), node.params);
    case "dither":
      return applyDitherNode(resolveInputImage(node, "image", graph, results), node.params);
    case "glow":
      return applyGlowNode(resolveInputImage(node, "image", graph, results), node.params);
    case "lens-distort":
      return applyLensDistortNode(resolveInputImage(node, "image", graph, results), node.params);
    case "mix":
      return applyMixNode(
        resolveInputImage(node, "image_a", graph, results),
        resolveInputImage(node, "image_b", graph, results),
        node.params
      );
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
