import { pruneHiddenGraph } from "./graph-runtime.js";

const NATIVE_SUPPORTED_TYPES = new Set([
  "source",
  "adjust",
  "posterize",
  "blur",
  "pixelate",
  "threshold",
  "mix",
  "viewer-output",
]);

const PASS_THROUGH_TYPES = new Set(["source", "viewer-output"]);

let nativeRenderAvailable = null;
let nativeRenderWarningShown = false;
let nativeRenderInfoShown = false;

export function canUseNativeRender(graph) {
  if (!window.__TAURI__?.core?.invoke) return false;
  const scoped = pruneHiddenGraph(graph);
  if (!scoped?.nodes?.length) return false;
  if (scoped.edges?.some((edge) => String(edge.toSocket ?? "").startsWith("param:"))) return false;
  if (scoped.nodes.some((node) => node.type === "source" && !isIdentitySourceParams(node.params))) {
    return false;
  }
  if (!scoped.nodes.every((node) => NATIVE_SUPPORTED_TYPES.has(node.type))) return false;
  return scoped.nodes.some((node) => !PASS_THROUGH_TYPES.has(node.type));
}

function isIdentitySourceParams(params = {}) {
  return (
    Number(params.brightness ?? 0) === 0 &&
    Number(params.contrast ?? 100) === 100 &&
    Number(params.saturation ?? 100) === 100 &&
    Number(params.gamma ?? 100) === 100 &&
    Number(params.exposure ?? 0) === 0 &&
    Number(params.hue ?? 0) === 0 &&
    Number(params.hsvSaturation ?? 100) === 100 &&
    Number(params.value ?? 100) === 100 &&
    String(params.bwMode ?? "off") === "off" &&
    String(params.invert ?? "off") === "off"
  );
}

export async function evaluateNativeGraphOutputs(graph, sourceCanvas) {
  if (!canUseNativeRender(graph) || !sourceCanvas?.width || !sourceCanvas?.height) return null;
  if (nativeRenderAvailable === false) return null;

  const scoped = pruneHiddenGraph(graph);
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
    if (!nativeRenderInfoShown) {
      nativeRenderInfoShown = true;
      console.info("[native-render] Rust GPU preview enabled", {
        nodes: scoped.nodes.map((node) => node.type),
      });
    }
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
