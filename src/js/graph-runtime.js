import {
  applyAdjustNode,
  applyAnalogNode,
  applyAsciiNode,
  applyBloomNode,
  applyBlurNode,
  applyChromaticAberrationNode,
  applyCropNode,
  applyCrtNode,
  applyDitherNode,
  applyDisplaceNode,
  applyDuotoneNode,
  applyFlipNode,
  applyGlareNode,
  applyGradientMapNode,
  applyHalationNode,
  applyHalftoneNode,
  applyPatternDitherNode,
  applyThresholdNode,
  applyVhsNode,
  applyHsvNode,
  applyInvertNode,
  applyLensDistortNode,
  applyLevelsNode,
  applyLedScreenNode,
  applyMaskApplyNode,
  applyMaskCombineNode,
  applyMeshGradientNode,
  applyModulationNode,
  applyMixNode,
  applyPixelateNode,
  applyPosterizeNode,
  applyRgbCurvesNode,
  applyRgbToBwNode,
  applyScaleNode,
  applySourceNode,
  applyToneMapNode,
  applyTransformNode,
  releaseBuffer,
} from "./image-ops.js";
import { getNodeParamBounds } from "./graph.js";
import { applyTimelineToGraph } from "./timeline.js";

// Per-node memoization. Each entry pins its output canvas — buffer pool must
// not reclaim it until the cache invalidates (params/inputs/source change or
// the node leaves the graph). Without this, paused-frame param tweaks would
// re-evaluate the entire effect chain even when only one node actually moved.
const nodeCache = new Map();
let versionCounter = 0;

// Node types whose output depends on the current playhead time even when no
// param is animated (procedural noise, scrolling tracking lines, etc.). The
// runtime salts the cache key with the current frame so they re-evaluate per
// frame instead of returning a stale cached canvas.
const TIME_AWARE_TYPES = new Set(["mesh-gradient", "analog", "vhs", "crt"]);

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
  const timelineGraph = applyTimelineToGraph(
    graph,
    context?.timeline,
    context?.timeSeconds ?? 0,
    {
      duration: context?.durationSeconds,
      fps: context?.fps,
    }
  );
  const scoped = pruneHiddenGraph(timelineGraph);
  if (!scoped?.nodes?.length) {
    return {
      viewerOutput: null,
      ditherOutput: null,
    };
  }

  const sourceVersion = context?.sourceVersion ?? "live";
  const index = createRuntimeIndex(scoped);
  const order = topologicalSort(scoped);
  const results = new Map();
  const versions = new Map();
  const reachableIds = new Set();

  for (const nodeId of order) {
    const node = index.nodesById.get(nodeId);
    if (!node) continue;
    reachableIds.add(node.id);

    if (node.type === "source") {
      const output = applySourceNode(context?.sourceImage ?? null, node.params);
      results.set(node.id, output);
      versions.set(node.id, `source@${sourceVersion};${hashParams(node.params)}`);
      continue;
    }

    if (node.type === "viewer-output") {
      const output = resolveInputImage(node, "image", index, results);
      results.set(node.id, output);
      versions.set(node.id, inputVersionKey(node, index, versions, "image"));
      continue;
    }

    const effectiveParams = applyParamEdges(node, index, results);
    const inputSockets = inputSocketsFor(node);
    const inputVersions = inputSockets.map((socket) =>
      inputVersionKey(node, index, versions, socket)
    );
    const paramVersions = paramSocketsFor(node).map((socket) =>
      inputVersionKey(node, index, versions, socket)
    );
    const timeSalt = TIME_AWARE_TYPES.has(node.type)
      ? `;t=${frameSalt(context?.timeSeconds, context?.fps)}`
      : "";
    const paramsHash = `${hashParams(effectiveParams)}bypass=${node.bypassed ? 1 : 0}${timeSalt};`;
    const cached = nodeCache.get(node.id);
    if (
      cached &&
      cached.type === node.type &&
      cached.paramsHash === paramsHash &&
      arraysEqual(cached.inputVersions, inputVersions) &&
      arraysEqual(cached.paramVersions ?? [], paramVersions)
    ) {
      results.set(node.id, cached.output);
      versions.set(node.id, cached.version);
      continue;
    }

    const output = computeNodeOutput({ ...node, params: effectiveParams }, index, results, context);
    if (output !== null && output !== undefined) {
      // A node may pass its input through unchanged (blur radius=0, lens-
      // distort with no effect, etc.). Caching that buffer would mean the
      // node "owns" a canvas it doesn't actually own — clearGraphCache or
      // eviction would then return the source/upstream canvas to the pool
      // while another node still holds it, and the next acquireBuffer
      // would clearRect it out from under them.
      const sourceImage = context?.sourceImage ?? null;
      const passthrough =
        output === sourceImage || (isCanvasLike(output) && sharesOutputWithCachedNode(output));
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
          paramVersions,
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

  const ditherNodeId = findNearestUpstreamNodeOfType(viewerNode.id, index, "dither");
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

function isCanvasLike(value) {
  return Boolean(value && typeof value === "object" && "width" in value && "height" in value);
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
    case "displace":
      return ["image", "map"];
    case "mask-combine":
      return ["mask_a", "mask_b"];
    case "mask-apply":
      return ["image", "mask"];
    case "math":
      return ["a", "b"];
    case "mesh-gradient":
    case "value":
      return [];
    default:
      return ["image"];
  }
}

function paramSocketsFor(node) {
  if (!Array.isArray(node.exposedParams) || node.exposedParams.length === 0) return [];
  return node.exposedParams.map((paramKey) => `param:${paramKey}`);
}

function createRuntimeIndex(graph) {
  const nodesById = new Map();
  const inputEdgesBySocket = new Map();
  const incomingEdgesByNode = new Map();

  for (const node of graph.nodes ?? []) {
    nodesById.set(node.id, node);
    incomingEdgesByNode.set(node.id, []);
  }

  for (const edge of graph.edges ?? []) {
    if (!nodesById.has(edge.fromNode) || !nodesById.has(edge.toNode)) continue;
    const socketKey = inputSocketKey(edge.toNode, edge.toSocket);
    if (!inputEdgesBySocket.has(socketKey)) inputEdgesBySocket.set(socketKey, edge);
    incomingEdgesByNode.get(edge.toNode)?.push(edge);
  }

  return { nodesById, inputEdgesBySocket, incomingEdgesByNode };
}

function inputSocketKey(nodeId, socket) {
  return `${nodeId}\u0000${socket}`;
}

function inputVersionKey(node, index, versions, socket) {
  const edge = index.inputEdgesBySocket.get(inputSocketKey(node.id, socket));
  if (!edge) return "none";
  const upstreamVersion = versions.get(edge.fromNode);
  return `${edge.fromNode}:${upstreamVersion ?? "?"}`;
}

function frameSalt(timeSeconds, fps) {
  const seconds = Number(timeSeconds);
  const frameRate = Number(fps);
  if (!Number.isFinite(seconds)) return "0";
  if (!Number.isFinite(frameRate) || frameRate <= 0) return seconds.toFixed(4);
  return String(Math.round(seconds * frameRate));
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

function computeNodeOutput(node, index, results, context) {
  if (node.bypassed) return computeBypassOutput(node, index, results);

  switch (node.type) {
    case "adjust":
      return applyAdjustNode(resolveInputImage(node, "image", index, results), node.params);
    case "posterize":
      return applyPosterizeNode(resolveInputImage(node, "image", index, results), node.params);
    case "invert":
      return applyInvertNode(resolveInputImage(node, "image", index, results), node.params);
    case "rgb-to-bw":
      return applyRgbToBwNode(resolveInputImage(node, "image", index, results), node.params);
    case "tone-map":
      return applyToneMapNode(resolveInputImage(node, "image", index, results), node.params);
    case "levels":
      return applyLevelsNode(resolveInputImage(node, "image", index, results), node.params);
    case "duotone":
      return applyDuotoneNode(resolveInputImage(node, "image", index, results), node.params);
    case "gradient-map":
      return applyGradientMapNode(resolveInputImage(node, "image", index, results), node.params);
    case "mesh-gradient":
      return applyMeshGradientNode(node.params, context);
    case "hsv":
      return applyHsvNode(resolveInputImage(node, "image", index, results), node.params);
    case "rgb-curves":
      return applyRgbCurvesNode(resolveInputImage(node, "image", index, results), node.params);
    case "blur":
      return applyBlurNode(resolveInputImage(node, "image", index, results), node.params);
    case "pixelate":
      return applyPixelateNode(resolveInputImage(node, "image", index, results), node.params);
    case "scale":
      return applyScaleNode(resolveInputImage(node, "image", index, results), node.params);
    case "transform":
      return applyTransformNode(resolveInputImage(node, "image", index, results), node.params);
    case "crop":
      return applyCropNode(resolveInputImage(node, "image", index, results), node.params);
    case "flip":
      return applyFlipNode(resolveInputImage(node, "image", index, results), node.params);
    case "dither":
      return applyDitherNode(resolveInputImage(node, "image", index, results), node.params);
    case "pattern-dither":
      return applyPatternDitherNode(resolveInputImage(node, "image", index, results), node.params);
    case "threshold":
      return applyThresholdNode(resolveInputImage(node, "image", index, results), node.params);
    case "mask-combine":
      return applyMaskCombineNode(
        resolveInputImage(node, "mask_a", index, results),
        resolveInputImage(node, "mask_b", index, results),
        node.params
      );
    case "mask-apply":
      return applyMaskApplyNode(
        resolveInputImage(node, "image", index, results),
        resolveInputImage(node, "mask", index, results),
        node.params
      );
    case "glare":
      return applyGlareNode(resolveInputImage(node, "image", index, results), node.params);
    case "analog":
      return applyAnalogNode(resolveInputImage(node, "image", index, results), node.params, context);
    case "led-screen":
      return applyLedScreenNode(resolveInputImage(node, "image", index, results), node.params);
    case "modulation":
      return applyModulationNode(resolveInputImage(node, "image", index, results), node.params);
    case "lens-distort":
      return applyLensDistortNode(resolveInputImage(node, "image", index, results), node.params);
    case "chromatic-aberration":
      return applyChromaticAberrationNode(resolveInputImage(node, "image", index, results), node.params);
    case "halftone":
      return applyHalftoneNode(resolveInputImage(node, "image", index, results), node.params);
    case "vhs":
      return applyVhsNode(resolveInputImage(node, "image", index, results), node.params, context);
    case "crt":
      return applyCrtNode(resolveInputImage(node, "image", index, results), node.params, context);
    case "bloom":
      return applyBloomNode(resolveInputImage(node, "image", index, results), node.params);
    case "halation":
      return applyHalationNode(resolveInputImage(node, "image", index, results), node.params);
    case "ascii":
      return applyAsciiNode(resolveInputImage(node, "image", index, results), node.params);
    case "displace":
      return applyDisplaceNode(
        resolveInputImage(node, "image", index, results),
        resolveInputImage(node, "map", index, results),
        node.params
      );
    case "mix":
      return applyMixNode(
        resolveInputImage(node, "image_a", index, results),
        resolveInputImage(node, "image_b", index, results),
        node.params
      );
    case "value":
      return Number(node.params?.value ?? 0);
    case "math":
      return applyMathNode(
        resolveInputValue(node, "a", index, results, node.params?.a ?? 0),
        resolveInputValue(node, "b", index, results, node.params?.b ?? 1),
        node.params
      );
    default:
      // Unknown nodes stay passthrough-friendly during the transition so the shell
      // can evolve without crashing the preview.
      return resolveFirstConnectedInput(node, index, results);
  }
}

function computeBypassOutput(node, index, results) {
  switch (node.type) {
    case "value":
      return Number(node.params?.value ?? 0);
    case "math":
      return resolveInputValue(node, "a", index, results, node.params?.a ?? 0);
    case "mix":
      return resolveInputImage(node, "image_a", index, results);
    case "mask-combine":
      // Bypass returns A so downstream still sees a mask.
      return resolveInputImage(node, "mask_a", index, results)
        ?? resolveInputImage(node, "mask_b", index, results);
    case "displace":
    default:
      return resolveInputImage(node, "image", index, results) ?? resolveFirstConnectedInput(node, index, results);
  }
}

function resolveInputImage(node, socketName, index, results) {
  const edge = index.inputEdgesBySocket.get(inputSocketKey(node.id, socketName));
  if (!edge) return null;
  return results.get(edge.fromNode) ?? null;
}

function resolveFirstConnectedInput(node, index, results) {
  const edge = index.incomingEdgesByNode.get(node.id)?.[0];
  if (!edge) return null;
  return results.get(edge.fromNode) ?? null;
}

function resolveInputValue(node, socketName, index, results, fallback = 0) {
  const edge = index.inputEdgesBySocket.get(inputSocketKey(node.id, socketName));
  if (!edge) return Number(fallback) || 0;
  const value = results.get(edge.fromNode);
  return Number.isFinite(Number(value)) ? Number(value) : Number(fallback) || 0;
}

function applyParamEdges(node, index, results) {
  if (!Array.isArray(node.exposedParams) || node.exposedParams.length === 0) {
    return node.params;
  }

  // Skip exposed entries whose key collides with an explicit input socket
  // (e.g. math.a, math.b). The explicit socket already drives the value via
  // resolveInputValue, and exposing it as `param:a` would create a duplicate
  // pin upstream — the inspector already hides the toggle for these.
  const explicitInputs = new Set((node.inputs ?? []).map((socket) => socket.name));

  let merged = null;
  for (const paramKey of node.exposedParams) {
    if (explicitInputs.has(paramKey)) continue;
    const edge = index.inputEdgesBySocket.get(inputSocketKey(node.id, `param:${paramKey}`));
    if (!edge) continue;
    const value = results.get(edge.fromNode);
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    if (!merged) merged = { ...node.params };
    merged[paramKey] = clampToBounds(numeric, getNodeParamBounds(node, paramKey));
  }

  return merged ?? node.params;
}

function clampToBounds(value, bounds) {
  if (!bounds) return value;
  return Math.max(bounds.min, Math.min(bounds.max, value));
}

function applyMathNode(a, b, params) {
  let value;
  switch (String(params?.operation ?? "add")) {
    case "subtract":
      value = a - b;
      break;
    case "multiply":
      value = a * b;
      break;
    case "divide":
      value = b === 0 ? 0 : a / b;
      break;
    case "power":
      value = Math.pow(a, b);
      break;
    case "min":
      value = Math.min(a, b);
      break;
    case "max":
      value = Math.max(a, b);
      break;
    case "modulo":
      value = b === 0 ? 0 : a % b;
      break;
    case "add":
    default:
      value = a + b;
      break;
  }
  if (params?.clamp) value = Math.max(0, Math.min(1, value));
  return Number.isFinite(value) ? value : 0;
}

function topologicalSort(graph) {
  const incomingCount = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));

  for (const edge of graph.edges ?? []) {
    if (!incomingCount.has(edge.toNode) || !outgoing.has(edge.fromNode)) continue;
    incomingCount.set(edge.toNode, incomingCount.get(edge.toNode) + 1);
    outgoing.get(edge.fromNode).push(edge.toNode);
  }

  const queue = graph.nodes
    .map((node) => node.id)
    .filter((nodeId) => (incomingCount.get(nodeId) ?? 0) === 0);
  const order = [];

  let cursor = 0;
  while (cursor < queue.length) {
    const nodeId = queue[cursor++];
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

function findNearestUpstreamNodeOfType(startNodeId, index, type) {
  const queue = [startNodeId];
  const visited = new Set();
  let cursor = 0;

  while (cursor < queue.length) {
    const nodeId = queue[cursor++];
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = index.nodesById.get(nodeId);
    if (node && node.id !== startNodeId && node.type === type) {
      return node.id;
    }

    for (const edge of index.incomingEdgesByNode.get(nodeId) ?? []) {
      queue.push(edge.fromNode);
    }
  }

  return null;
}
