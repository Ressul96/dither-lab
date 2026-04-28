import { pruneHiddenGraph } from "./graph-runtime.js";

const NATIVE_SUPPORTED_TYPES = new Set([
  "source",
  "adjust",
  "blur",
  "mix",
  "viewer-output",
]);

const PASS_THROUGH_TYPES = new Set(["source", "viewer-output"]);

let nativeRenderAvailable = null;
let nativeRenderWarningShown = false;

export function canUseNativeRender(graph) {
  if (!window.__TAURI__?.core?.invoke) return false;
  const scoped = viewerUpstreamGraph(pruneHiddenGraph(graph));
  if (!scoped?.nodes?.length) return false;
  if (scoped.nodes.some((node) => node.bypassed)) return false;
  if (!scoped.nodes.every((node) => NATIVE_SUPPORTED_TYPES.has(node.type))) return false;
  return scoped.nodes.some((node) => !PASS_THROUGH_TYPES.has(node.type));
}

export async function evaluateNativeGraphOutputs(graph, sourceCanvas) {
  if (!canUseNativeRender(graph) || !sourceCanvas?.width || !sourceCanvas?.height) return null;
  if (nativeRenderAvailable === false) return null;

  const scoped = viewerUpstreamGraph(pruneHiddenGraph(graph));
  const context = sourceCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return null;

  const sourceFrame = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const pixels = new Uint8Array(
    sourceFrame.data.buffer,
    sourceFrame.data.byteOffset,
    sourceFrame.data.byteLength
  );
  const request = {
    width: sourceCanvas.width,
    height: sourceCanvas.height,
    nodes: scoped.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      params: node.params ?? {},
    })),
    edges: scoped.edges.map((edge) => ({
      fromNode: edge.fromNode,
      fromSocket: edge.fromSocket,
      toNode: edge.toNode,
      toSocket: edge.toSocket,
    })),
  };

  try {
    const response = await window.__TAURI__.core.invoke("native_render_graph", {
      request,
      pixels,
    });
    nativeRenderAvailable = true;
    return {
      viewerOutput: frameToCanvas(response.viewerOutput),
      ditherOutput: response.ditherOutput ? frameToCanvas(response.ditherOutput) : null,
    };
  } catch (error) {
    nativeRenderAvailable = false;
    if (!nativeRenderWarningShown) {
      nativeRenderWarningShown = true;
      console.warn("[native-render] disabled after failed invoke", error);
    }
    return null;
  }
}

function viewerUpstreamGraph(graph) {
  if (!graph?.nodes?.length) return graph ?? { nodes: [], edges: [] };
  const viewer = graph.nodes.find((node) => node.type === "viewer-output");
  if (!viewer) return { nodes: [], edges: [] };

  const nodeIds = new Set();
  const queue = [viewer.id];
  let cursor = 0;
  while (cursor < queue.length) {
    const nodeId = queue[cursor++];
    if (!nodeId || nodeIds.has(nodeId)) continue;
    nodeIds.add(nodeId);
    for (const edge of graph.edges ?? []) {
      if (edge.toNode === nodeId) queue.push(edge.fromNode);
    }
  }

  return {
    ...graph,
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: (graph.edges ?? []).filter(
      (edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode)
    ),
  };
}

function frameToCanvas(frame) {
  if (!frame?.width || !frame?.height || !frame?.pixels) return null;
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return null;

  const pixels = new Uint8ClampedArray(frame.pixels);
  context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  return canvas;
}
