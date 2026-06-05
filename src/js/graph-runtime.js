import {
  applyAdjustNode,
  applyAnalogNode,
  applyAsciiNode,
  applyBloomNode,
  applyBlurNode,
  applyChromaticAberrationNode,
  applyCropNode,
  applyCrtNode,
  applyDepthOfFieldNode,
  applyDitherNode,
  applyDisplaceNode,
  applyDuotoneNode,
  applyFlipNode,
  applyGlareNode,
  applyGradientNode,
  applyGradientMapNode,
  applyHalationNode,
  applyHalftoneNode,
  applyPatternDitherNode,
  applyThresholdNode,
  applyVhsNode,
  applyHsvNode,
  applyInvertNode,
  applyLayerAdjustmentsNode,
  applyLensDistortNode,
  applyLevelsNode,
  applyLedScreenNode,
  applyMaskApplyNode,
  applyMaskCombineNode,
  applyMeshGradientNode,
  applyModulationNode,
  applyMixNode,
  applyNoiseNode,
  applyPixelateNode,
  applyPixelSortingNode,
  applyPosterizeNode,
  applyRgbCurvesNode,
  applySceneGradeNode,
  applyRgbToBwNode,
  applyScaleNode,
  applySourceNode,
  applyToneMapNode,
  applyTransformNode,
  releaseBuffer,
} from "./image-ops.js";
import { getNodeParamBounds } from "./graph.js";
import { applyTimelineToGraph } from "./timeline.js";
import { getAudioLevel } from "./audio-analysis.js";

// Per-node memoization. Each entry pins its output canvas — buffer pool must
// not reclaim it until the cache invalidates (params/inputs/source change or
// the node leaves the graph). Without this, paused-frame param tweaks would
// re-evaluate the entire effect chain even when only one node actually moved.
const nodeCache = new Map();
let versionCounter = 0;

// F8.0 measurement. Populated once per evaluateGraphOutputs call so devtools
// or future timing overlays can read per-node durations without hooking the
// runtime itself. Module-level rather than dispatched into state on purpose:
// we'd otherwise wake every state subscriber every frame.
let lastEvaluationProfile = null;

export function getLastEvaluationProfile() {
  return lastEvaluationProfile;
}

// Node types whose output depends on the current playhead time even when no
// param is animated (procedural noise, scrolling tracking lines, etc.). The
// runtime salts the cache key with the current frame so they re-evaluate per
// frame instead of returning a stale cached canvas.
const TIME_AWARE_TYPES = new Set(["mesh-gradient", "analog", "vhs", "crt", "audio-level"]);

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

// GPU stylize nodes (vhs, crt, bloom, ascii, …) have no CPU fallback: when the
// renderer is unavailable, stylize-gpu.js passes the input straight through and
// the effect silently vanishes — a worker frame that wouldn't match a main-
// thread export. render-worker.js uses this to decide whether to fall back to
// the main thread (paired with isGpuRendererAvailable in gpu-effects.js). glare
// is intentionally absent: every glare type runs on the CPU or has a CPU
// fallback, so it stays worker-safe.
const WORKER_UNSAFE_GPU_TYPES = new Set([
  "halftone",
  "led-screen",
  "modulation",
  "pixel-sorting",
  "depth-of-field",
  "vhs",
  "crt",
  "analog",
  "bloom",
  "halation",
  "ascii",
  "pattern-dither",
]);

const MAIN_THREAD_ONLY_TYPES = new Set([
  "ascii",
]);

export function graphContainsGpuEffect(graph) {
  if (!graph?.nodes?.length) return false;
  for (const node of graph.nodes) {
    if (!node || node.bypassed || isNodeHidden(node)) continue;
    if (WORKER_UNSAFE_GPU_TYPES.has(node.type)) return true;
  }
  return false;
}

export function graphRequiresMainThreadRender(graph) {
  if (!graph?.nodes?.length) return false;
  for (const node of graph.nodes) {
    if (!node || node.bypassed || isNodeHidden(node)) continue;
    if (MAIN_THREAD_ONLY_TYPES.has(node.type)) return true;
    // Bound source nodes read a per-source frame map only the main thread builds.
    if (node.type === "source" && node.params?.sourceId) return true;
    // Audio-level reads the RMS envelope, which lives on the main thread.
    if (node.type === "audio-level") return true;
  }
  return false;
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

// Group nodes are editor-only containers — children carry the actual compute
// and the edges between them already pierce the boundary (groupSelectedNodes
// preserves them as-is). Strip groups and any dangling edges that referenced
// the group node's own sockets so the runtime sees a pure compute graph.
//
// Compute-node ids are unchanged, so nodeCache hits survive group/ungroup
// without rebuild.
export function flattenGraphForRuntime(graph) {
  if (!graph?.nodes?.length) return graph ?? { nodes: [], edges: [] };
  let hasGroup = false;
  for (const node of graph.nodes) {
    if (node?.type === "group") {
      hasGroup = true;
      break;
    }
  }
  if (!hasGroup) return graph;

  const groupIds = new Set();
  for (const node of graph.nodes) {
    if (node?.type === "group") groupIds.add(node.id);
  }

  const nodes = graph.nodes.filter((node) => !groupIds.has(node.id));
  const edges = (graph.edges ?? []).filter(
    (edge) => !groupIds.has(edge.fromNode) && !groupIds.has(edge.toNode)
  );
  return { ...graph, nodes, edges };
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
  const flattened = flattenGraphForRuntime(timelineGraph);
  const scoped = pruneHiddenGraph(flattened);
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

  const evalStart = performance.now();
  const nodeTimings = {};

  for (const nodeId of order) {
    const node = index.nodesById.get(nodeId);
    if (!node) continue;
    reachableIds.add(node.id);

    const t0 = performance.now();
    let cacheHit = false;
    let producedOutput = null;

    if (node.type === "source") {
      // A source node bound to a media source (params.sourceId) reads that
      // source's frame from context.sourceFrames (built on the main thread);
      // unbound nodes use the clip composite (context.sourceImage).
      const boundId = node.params?.sourceId;
      const bound = boundId ? context?.sourceFrames?.[boundId] : null;
      producedOutput = applySourceNode(bound?.canvas ?? context?.sourceImage ?? null, node.params);
      results.set(node.id, producedOutput);
      const srcVer = bound ? `${boundId}:${bound.version}` : sourceVersion;
      versions.set(node.id, `source@${srcVer};${hashParams(node.params)}`);
    } else if (node.type === "viewer-output") {
      producedOutput = resolveInputImage(node, "image", index, results);
      results.set(node.id, producedOutput);
      versions.set(node.id, inputVersionKey(node, index, versions, "image"));
    } else {
      const effectiveParams = applyParamEdges(node, index, results);
      const inputSockets = inputSocketsFor(node);
      const inputVersions = inputSockets.map((socket) =>
        inputVersionKey(node, index, versions, socket)
      );
      const paramVersions = paramSocketsFor(node).map((socket) =>
        inputVersionKey(node, index, versions, socket)
      );
      const timeSalt = nodeNeedsTimeSalt(node, effectiveParams)
        ? `;t=${frameSalt(context?.timeSeconds, context?.fps)}`
        : "";
      const paramsHash = `${hashParams(effectiveParams)}${hashLayerAdjustments(node)}bypass=${node.bypassed ? 1 : 0}${timeSalt};`;
      const cached = nodeCache.get(node.id);
      if (
        cached &&
        cached.type === node.type &&
        cached.paramsHash === paramsHash &&
        arraysEqual(cached.inputVersions, inputVersions) &&
        arraysEqual(cached.paramVersions ?? [], paramVersions)
      ) {
        cacheHit = true;
        producedOutput = cached.output;
        results.set(node.id, cached.output);
        versions.set(node.id, cached.version);
      } else {
        const runtimeNode = { ...node, params: effectiveParams };
        const rawOutput = computeNodeOutput(runtimeNode, index, results, context);
        const output = applyLayerAdjustments(runtimeNode, rawOutput, index, results, context);
        if (output !== rawOutput && canReleaseComputedOutput(rawOutput, context)) {
          releaseBuffer(rawOutput);
        }
        producedOutput = output;
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
    }

    nodeTimings[node.id] = {
      durationMs: performance.now() - t0,
      cacheHit,
      type: node.type,
      outputSize: outputSizeOf(producedOutput),
    };
  }

  lastEvaluationProfile = {
    timestamp: evalStart,
    totalMs: performance.now() - evalStart,
    nodeCount: order.length,
    timings: nodeTimings,
  };

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

function outputSizeOf(output) {
  if (!output || typeof output !== "object") return null;
  if (typeof output.width !== "number" || typeof output.height !== "number") return null;
  return [output.width, output.height];
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
    case "gradient":
    case "noise":
    case "value":
    case "audio-level":
    case "field-probe":
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

function nodeNeedsTimeSalt(node, params) {
  if (TIME_AWARE_TYPES.has(node.type)) return true;
  if (node.type === "noise") return Number(params?.animSpeed ?? 0) > 0;
  return false;
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

function hashLayerAdjustments(node) {
  return `layerOpacity=${Number(node?.opacity ?? 100)};layerHue=${Number(node?.hue ?? 0)};layerSaturation=${Number(node?.saturation ?? 100)};`;
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

function applyLayerAdjustments(node, output, index, results, context) {
  if (!output || typeof output !== "object" || typeof output.width !== "number") return output;
  if (node.type === "source" || node.type === "viewer-output" || node.type === "group") return output;
  if (!hasLayerAdjustments(node)) return output;

  const baseInput = resolveLayerBaseInput(node, index, results);
  return applyLayerAdjustmentsNode(baseInput, output, {
    opacity: node.opacity,
    hue: node.hue,
    saturation: node.saturation,
  });
}

function hasLayerAdjustments(node) {
  const opacity = Number(node.opacity ?? 100);
  const hue = Number(node.hue ?? 0);
  const saturation = Number(node.saturation ?? 100);
  return opacity < 99.9 || hue !== 0 || saturation !== 100;
}

function resolveLayerBaseInput(node, index, results) {
  switch (node.type) {
    case "mix":
      return resolveInputImage(node, "image_a", index, results);
    case "mask-combine":
      return resolveInputImage(node, "mask_a", index, results);
    case "mask-apply":
    case "displace":
      return resolveInputImage(node, "image", index, results);
    default:
      return resolveInputImage(node, "image", index, results);
  }
}

function canReleaseComputedOutput(output, context) {
  if (!output || typeof output !== "object") return false;
  if (output === context?.sourceImage) return false;
  if (sharesOutputWithCachedNode(output)) return false;
  return true;
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
    case "gradient":
      return applyGradientNode(node.params, context);
    case "mesh-gradient":
      return applyMeshGradientNode(node.params, context);
    case "noise":
      return applyNoiseNode(node.params, context);
    case "hsv":
      return applyHsvNode(resolveInputImage(node, "image", index, results), node.params);
    case "rgb-curves":
      return applyRgbCurvesNode(resolveInputImage(node, "image", index, results), node.params);
    case "scene-grade":
      return applySceneGradeNode(resolveInputImage(node, "image", index, results), node.params);
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
    case "pixel-sorting":
      return applyPixelSortingNode(resolveInputImage(node, "image", index, results), node.params);
    case "depth-of-field":
      return applyDepthOfFieldNode(resolveInputImage(node, "image", index, results), node.params);
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
    case "audio-level":
      return getAudioLevel(context?.timeSeconds ?? 0, node.params);
    case "field-probe":
      return fieldProbeValue(node.params);
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
    case "audio-level":
      return 0;
    case "field-probe":
      return 0;
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

// Sample a spatial field at a point -> scalar in 0..gain. Pure function of the
// params (no time, no playback) so preview and export match. Radial: closeness
// of the sample to the center within `radius`. Linear: a ramp across an axis.
function fieldProbeValue(params) {
  // Center / sample / radius come from the inspector as 0..100 (and 0..200 for
  // radius) integer percentages, matching the gradient / chroma-aberration /
  // lens-distort center convention; normalise to 0..1 (radius 0..2) here.
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const shape = String(params?.shape ?? "radial");
  const cx = num(params?.centerX, 50) / 100;
  const cy = num(params?.centerY, 50) / 100;
  const sx = num(params?.sampleX, 50) / 100;
  const sy = num(params?.sampleY, 50) / 100;
  const radius = Math.max(1e-4, num(params?.radius, 50) / 100);
  let v;
  if (shape === "linear-x") v = (sx - cx) / radius + 0.5;
  else if (shape === "linear-y") v = (sy - cy) / radius + 0.5;
  else v = 1 - Math.hypot(sx - cx, sy - cy) / radius;
  v = Math.max(0, Math.min(1, v));
  if (String(params?.falloff ?? "linear") === "smooth") v = v * v * (3 - 2 * v);
  if (params?.invert) v = 1 - v;
  return v * num(params?.gain, 1);
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
