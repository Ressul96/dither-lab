import { getState, dispatch } from "./state.js";

const NODE_SPACING_X = 252;
const NODE_BASE_X = 88;
const NODE_BASE_Y = 84;
const NODE_WIDTH = 220;
const NODE_INSERT_GAP_X = Math.round(NODE_WIDTH * 0.2);

const NODE_DEFINITIONS = Object.freeze({
  source: {
    label: "Source",
    family: "Input",
    description: "Resolves the current frame from the active source provider.",
    inputs: [],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {},
  },
  adjust: {
    label: "Adjust",
    family: "Color",
    description: "Applies source-level corrections before downstream processing nodes.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      brightness: 0,
      contrast: 100,
      saturation: 100,
      gamma: 100,
      exposure: 0,
    },
  },
  posterize: {
    label: "Posterize",
    family: "Color",
    description: "Quantizes each channel into N discrete levels for hard tonal banding.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { steps: 8 },
  },
  invert: {
    label: "Invert",
    family: "Color",
    description: "Inverts the selected channels (RGB by default).",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { channels: "rgb" },
  },
  "rgb-to-bw": {
    label: "RGB to BW",
    family: "Color",
    description: "Collapses the image to luminance — useful before 1-bit dither.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { mode: "bt709" },
  },
  "tone-map": {
    label: "Tone Map",
    family: "Color",
    description: "Compresses bright highlights via Reinhard so dither has headroom.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { intensity: 100, whitepoint: 100 },
  },
  hsv: {
    label: "HSV",
    family: "Color",
    description: "Shifts hue, saturation, and value before downstream processing.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { hue: 0, saturation: 100, value: 100 },
  },
  "rgb-curves": {
    label: "RGB Curves",
    family: "Color",
    description: "Applies a simple three-point curve to master and RGB channels.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      activeChannel: "master",
      masterLow: 0,
      masterMid: 128,
      masterHigh: 255,
      redLow: 0,
      redMid: 128,
      redHigh: 255,
      greenLow: 0,
      greenMid: 128,
      greenHigh: 255,
      blueLow: 0,
      blueMid: 128,
      blueHigh: 255,
      points_master: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      points_blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    },
  },
  pixelate: {
    label: "Pixelate",
    family: "Process",
    description: "Collapses NxN blocks into single colors for chunky low-res looks.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { size: 8 },
  },
  scale: {
    label: "Scale",
    family: "Process",
    description: "Resizes the image. Pair with Pixelate for retro upscaled pixel art.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { x: 100, y: 100, filter: "linear" },
  },
  transform: {
    label: "Transform",
    family: "Process",
    description: "Translates, rotates, and scales the image inside the original frame.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { translateX: 0, translateY: 0, rotation: 0, scale: 100, filter: "linear" },
  },
  crop: {
    label: "Crop",
    family: "Process",
    description: "Masks or fits a cropped source rectangle inside the original frame.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { left: 0, right: 0, top: 0, bottom: 0, mode: "mask" },
  },
  flip: {
    label: "Flip",
    family: "Process",
    description: "Flips the image horizontally, vertically, or both.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { horizontal: true, vertical: false },
  },
  dither: {
    label: "Dither",
    family: "Process",
    description: "Converts the incoming image into a dithered monochrome result.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      algorithm: "floyd-steinberg",
      palette: "monochrome",
      threshold: 128,
      invert: false,
      scale: 100,
      blurRadius: 0,
      errorStrength: 100,
      serpentine: true,
    },
  },
  blur: {
    label: "Blur",
    family: "Process",
    description: "Softens the image with a Gaussian-style blur.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { radius: 4 },
  },
  glare: {
    label: "Glare",
    family: "Effect",
    description: "Bloom, anamorphic streaks, or fog glow around bright pixels.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      type: "streaks",
      threshold: 200,
      mix: 100,
      saturation: 100,
      blend: "screen",
      tintAmount: 0,
      tintHue: 30,
      size: 16,
      quality: 1,
      streaks: 4,
      angle: 45,
      iterations: 5,
      fade: 85,
    },
  },
  "lens-distort": {
    label: "Lens Distortion",
    family: "Effect",
    description: "Radial barrel/pincushion or horizontal chromatic split, with off-axis center, fit, and vignette.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      type: "radial",
      distortion: 0,
      dispersion: 0,
      centerX: 50,
      centerY: 50,
      vignette: 0,
      fit: false,
    },
  },
  mix: {
    label: "Mix",
    family: "Compose",
    description: "Blends the main chain with a branched image using composite modes.",
    inputs: [
      { name: "image_a", label: "Image A", type: "image" },
      { name: "image_b", label: "Image B", type: "image" },
    ],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: { factor: 50, mode: "normal" },
  },
  displace: {
    label: "Displace",
    family: "Effect",
    description: "Offsets pixels with an optional map input or a procedural wave.",
    inputs: [
      { name: "image", label: "Image", type: "image" },
      { name: "map", label: "Map", type: "image" },
    ],
    outputs: [{ name: "image", label: "Image", type: "image" }],
    defaultParams: {
      mode: "wave",
      xAmount: 16,
      yAmount: 0,
      strength: 100,
      frequency: 4,
      phase: 0,
      filter: "linear",
    },
  },
  value: {
    label: "Value",
    family: "Utility",
    description: "Outputs a scalar value for future parameter wiring.",
    chainable: false,
    inputs: [],
    outputs: [{ name: "value", label: "Value", type: "value" }],
    defaultParams: { value: 0 },
  },
  math: {
    label: "Math",
    family: "Utility",
    description: "Computes a scalar value from two numeric inputs.",
    chainable: false,
    inputs: [
      { name: "a", label: "A", type: "value" },
      { name: "b", label: "B", type: "value" },
    ],
    outputs: [{ name: "value", label: "Value", type: "value" }],
    defaultParams: { operation: "add", a: 0, b: 1, clamp: false },
  },
  "viewer-output": {
    label: "Viewer Output",
    family: "Output",
    description: "Terminal graph node used by preview and export.",
    inputs: [{ name: "image", label: "Image", type: "image" }],
    outputs: [],
    defaultParams: { target: "stage", fps: 30 },
  },
});

const TYPE_ORDER = {
  source: 0,
  adjust: 1,
  posterize: 2,
  invert: 3,
  "rgb-to-bw": 4,
  "tone-map": 5,
  hsv: 6,
  "rgb-curves": 7,
  blur: 8,
  pixelate: 9,
  scale: 10,
  transform: 11,
  crop: 12,
  flip: 13,
  dither: 14,
  glare: 15,
  "lens-distort": 16,
  displace: 17,
  mix: 18,
  value: 19,
  math: 20,
  "viewer-output": 21,
};

export function getNodeDefinition(type) {
  return NODE_DEFINITIONS[type] ?? null;
}

export function createBootGraph() {
  const nodes = [
    createNode("source-1", "source"),
    createNode("viewer-output-1", "viewer-output"),
  ];

  layoutLinearNodes(nodes);

  return {
    nodes,
    edges: buildLinearEdges(nodes),
    selectedNodeId: "viewer-output-1",
  };
}

export function ensureBootGraph() {
  const graph = getState().graph;
  if (graph.nodes.length > 0) return graph;

  const bootGraph = createBootGraph();
  dispatch("graph", bootGraph);
  return bootGraph;
}

export function selectNode(nodeId) {
  const { graph } = getState();
  if (!nodeId || graph.selectedNodeId === nodeId) return;
  if (!graph.nodes.some((node) => node.id === nodeId)) return;
  dispatch("graph", { selectedNodeId: nodeId });
}

export function getViewerOutputNode(graph = getState().graph) {
  if (!graph?.nodes?.length) return null;
  return graph.nodes.find((node) => node.type === "viewer-output") ?? null;
}

export function getViewerOutputFps(graph = getState().graph) {
  const fps = Number(getViewerOutputNode(graph)?.params?.fps);
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps) : null;
}

export function setViewerOutputFps(fps) {
  const nextFps = Number.isFinite(Number(fps)) ? Math.max(1, Math.round(Number(fps))) : null;
  if (!nextFps) return false;

  const { graph } = getState();
  let changed = false;
  const nextNodes = graph.nodes.map((node) => {
    if (node.type !== "viewer-output" || node.params?.fps === nextFps) return node;
    changed = true;
    return {
      ...node,
      params: {
        ...node.params,
        fps: nextFps,
      },
    };
  });

  if (!changed) return false;
  dispatch("graph", { nodes: nextNodes });
  return true;
}

export function addLinearNode(type) {
  const definition = getNodeDefinition(type);
  if (!definition || definition.chainable === false) return null;
  if (type === "source" || type === "viewer-output") return null;
  if (type === "mix") return addMixNode();
  return insertNodeIntoChain(type);
}

export function addMixNode() {
  return insertNodeIntoChain("mix", (newNode, graph) => {
    const source = graph.nodes.find((node) => node.type === "source");
    if (!source) return [];
    return [
      {
        id: createEdgeId(source.id, "image", newNode.id, "image_b"),
        fromNode: source.id,
        fromSocket: "image",
        toNode: newNode.id,
        toSocket: "image_b",
      },
    ];
  });
}

function insertNodeIntoChain(type, extraEdgeFactory = null) {
  const definition = getNodeDefinition(type);
  if (!definition || definition.chainable === false) return null;

  const graph = ensureBootGraph();
  const chain = getMainChain(graph);
  const insertIndex = getInsertionIndex(chain, type);
  const prevNode = chain[insertIndex - 1];
  const nextNode = chain[insertIndex];
  if (!prevNode || !nextNode) return null;

  const nodeId = nextNodeId(type, graph);
  const newNode = createNode(nodeId, type);
  const nextPrimarySocket = getPrimaryInputSocket(nextNode);
  const inputSocket = getPrimaryInputSocket(newNode);
  const outputSocket = getPrimaryOutputSocket(newNode);
  if (!isImageSocket(newNode, "input", inputSocket) || !isImageSocket(newNode, "output", outputSocket)) {
    return null;
  }

  const nextEdges = graph.edges
    .filter(
      (edge) =>
        !(
          edge.fromNode === prevNode.id &&
          edge.toNode === nextNode.id &&
          edge.toSocket === nextPrimarySocket
        )
    )
    .map((edge) => ({ ...edge }));

  nextEdges.push({
    id: createEdgeId(prevNode.id, "image", nodeId, inputSocket),
    fromNode: prevNode.id,
    fromSocket: "image",
    toNode: nodeId,
    toSocket: inputSocket,
  });
  nextEdges.push({
    id: createEdgeId(nodeId, outputSocket, nextNode.id, nextPrimarySocket),
    fromNode: nodeId,
    fromSocket: outputSocket,
    toNode: nextNode.id,
    toSocket: nextPrimarySocket,
  });

  if (extraEdgeFactory) {
    const extras = extraEdgeFactory(newNode, graph);
    if (Array.isArray(extras)) nextEdges.push(...extras);
  }

  const nextNodes = [...graph.nodes.map((node) => clone(node)), newNode];
  layoutMainChain(nextNodes, nextEdges);

  dispatch("graph", {
    nodes: nextNodes,
    edges: nextEdges,
    selectedNodeId: nodeId,
  });

  return nodeId;
}

export function createFreeNode(type, position) {
  const definition = getNodeDefinition(type);
  if (!definition || type === "source" || type === "viewer-output") return null;

  const graph = ensureBootGraph();
  const nodeId = nextNodeId(type, graph);
  const newNode = createNode(nodeId, type, {
    x: position?.x ?? NODE_BASE_X,
    y: position?.y ?? NODE_BASE_Y,
  });

  dispatch("graph", {
    nodes: [...graph.nodes.map((node) => clone(node)), newNode],
    selectedNodeId: nodeId,
  });

  return nodeId;
}

export function insertNodeOnEdge(edgeId, type, options = {}) {
  const definition = getNodeDefinition(type);
  if (!definition || definition.chainable === false || type === "source" || type === "viewer-output") return null;

  const graph = ensureBootGraph();
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) return null;

  const fromNode = getNodeById(edge.fromNode, graph);
  const toNode = getNodeById(edge.toNode, graph);
  if (!fromNode || !toNode) return null;

  const nodeId = nextNodeId(type, graph);
  const hasExplicitPosition = Boolean(options.position);
  const newNode = createNode(nodeId, type, {
    x: options.position?.x ?? midpoint(fromNode.x, toNode.x),
    y: options.position?.y ?? midpoint(fromNode.y, toNode.y),
  });
  const inputSocket = getPrimaryInputSocket(newNode);
  const outputSocket = newNode.outputs?.[0]?.name;
  if (!inputSocket || !outputSocket) return null;
  if (!socketsCompatible(fromNode, edge.fromSocket, newNode, inputSocket)) return null;
  if (!socketsCompatible(newNode, outputSocket, toNode, edge.toSocket)) return null;

  const nextEdges = graph.edges
    .filter((item) => item.id !== edgeId)
    .map((item) => ({ ...item }));

  nextEdges.push({
    id: createEdgeId(edge.fromNode, edge.fromSocket, nodeId, inputSocket),
    fromNode: edge.fromNode,
    fromSocket: edge.fromSocket,
    toNode: nodeId,
    toSocket: inputSocket,
  });
  nextEdges.push({
    id: createEdgeId(nodeId, outputSocket, edge.toNode, edge.toSocket),
    fromNode: nodeId,
    fromSocket: outputSocket,
    toNode: edge.toNode,
    toSocket: edge.toSocket,
  });

  if (type === "mix") {
    const source = graph.nodes.find((node) => node.type === "source");
    if (source) {
      nextEdges.push({
        id: createEdgeId(source.id, "image", nodeId, "image_b"),
        fromNode: source.id,
        fromSocket: "image",
        toNode: nodeId,
        toSocket: "image_b",
      });
    }
  }

  const nextNodes = [...graph.nodes.map((node) => clone(node)), newNode];
  if (isPrimaryChainEdge(edge, graph)) {
    spacePrimaryChainAroundNode(nextNodes, nextEdges, edge.fromNode, nodeId, edge.toNode, {
      preserveInserted: hasExplicitPosition,
    });
  }
  dispatch("graph", {
    nodes: nextNodes,
    edges: nextEdges,
    selectedNodeId: nodeId,
  });

  return nodeId;
}

export function insertExistingNodeOnEdge(nodeId, edgeId, options = {}) {
  if (!nodeId || !edgeId) return false;

  const graph = ensureBootGraph();
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge || edge.fromNode === nodeId || edge.toNode === nodeId) return false;

  const node = getNodeById(nodeId, graph);
  const fromNode = getNodeById(edge.fromNode, graph);
  const toNode = getNodeById(edge.toNode, graph);
  if (!node || !fromNode || !toNode) return false;
  if (node.type === "source" || node.type === "viewer-output") return false;

  const definition = getNodeDefinition(node.type);
  if (!definition || definition.chainable === false) return false;

  const inputSocket = getPrimaryInputSocket(node);
  const outputSocket = getPrimaryOutputSocket(node);
  if (!inputSocket || !outputSocket) return false;
  if (!socketsCompatible(fromNode, edge.fromSocket, node, inputSocket)) return false;
  if (!socketsCompatible(node, outputSocket, toNode, edge.toSocket)) return false;

  const nextNodes = graph.nodes.map((item) => clone(item));
  const inserted = nextNodes.find((item) => item.id === nodeId);
  if (!inserted) return false;
  if (options.position) {
    inserted.x = options.position.x;
    inserted.y = options.position.y;
  }

  const nextEdges = graph.edges
    .filter((item) => item.id !== edgeId)
    .filter((item) => !(item.toNode === nodeId && item.toSocket === inputSocket))
    .filter((item) => !(item.fromNode === nodeId && item.fromSocket === outputSocket))
    .map((item) => ({ ...item }));

  if (wouldCreateCycle(edge.fromNode, nodeId, nextEdges)) return false;
  nextEdges.push({
    id: createEdgeId(edge.fromNode, edge.fromSocket, nodeId, inputSocket),
    fromNode: edge.fromNode,
    fromSocket: edge.fromSocket,
    toNode: nodeId,
    toSocket: inputSocket,
  });

  if (wouldCreateCycle(nodeId, edge.toNode, nextEdges)) return false;
  nextEdges.push({
    id: createEdgeId(nodeId, outputSocket, edge.toNode, edge.toSocket),
    fromNode: nodeId,
    fromSocket: outputSocket,
    toNode: edge.toNode,
    toSocket: edge.toSocket,
  });

  if (node.type === "mix" && !nextEdges.some((item) => item.toNode === nodeId && item.toSocket === "image_b")) {
    const source = graph.nodes.find((item) => item.type === "source");
    if (source && socketsCompatible(source, "image", node, "image_b")) {
      nextEdges.push({
        id: createEdgeId(source.id, "image", nodeId, "image_b"),
        fromNode: source.id,
        fromSocket: "image",
        toNode: nodeId,
        toSocket: "image_b",
      });
    }
  }

  if (isPrimaryChainEdge(edge, graph)) {
    spacePrimaryChainAroundNode(nextNodes, nextEdges, edge.fromNode, nodeId, edge.toNode, {
      preserveInserted: true,
    });
  }

  dispatch("graph", {
    nodes: nextNodes,
    edges: nextEdges,
    selectedNodeId: nodeId,
  });

  return true;
}

export function mutateNodePosition(nodeId, x, y) {
  const { graph } = getState();
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  node.x = x;
  node.y = y;
  return true;
}

export function commitLayout() {
  dispatch("graph", {});
}

export function addEdge(fromNode, fromSocket, toNode, toSocket) {
  if (!fromNode || !toNode || fromNode === toNode) return false;

  const graph = getState().graph;
  const fromDef = graph.nodes.find((node) => node.id === fromNode);
  const toDef = graph.nodes.find((node) => node.id === toNode);
  if (!fromDef || !toDef) return false;

  const hasOutput = fromDef.outputs.some((socket) => socket.name === fromSocket);
  const hasInput = hasInputSocket(toDef, toSocket);
  if (!hasOutput || !hasInput) return false;
  if (!socketsCompatible(fromDef, fromSocket, toDef, toSocket)) return false;

  const duplicate = graph.edges.some(
    (edge) =>
      edge.fromNode === fromNode &&
      edge.fromSocket === fromSocket &&
      edge.toNode === toNode &&
      edge.toSocket === toSocket
  );
  if (duplicate) return false;

  const nextEdges = graph.edges
    .filter((edge) => !(edge.toNode === toNode && edge.toSocket === toSocket))
    .map((edge) => ({ ...edge }));

  if (wouldCreateCycle(fromNode, toNode, nextEdges)) return false;

  nextEdges.push({
    id: createEdgeId(fromNode, fromSocket, toNode, toSocket),
    fromNode,
    fromSocket,
    toNode,
    toSocket,
  });

  dispatch("graph", { edges: nextEdges });
  return true;
}

export function removeNode(nodeId) {
  if (!nodeId) return false;

  const graph = getState().graph;
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node || node.type === "source" || node.type === "viewer-output") return false;

  const primaryInput = getPrimaryInputSocket(node);
  const primaryOutput = getPrimaryOutputSocket(node);
  const incomingPrimary = primaryInput
    ? graph.edges.find((edge) => edge.toNode === nodeId && edge.toSocket === primaryInput)
    : null;
  const outgoingPrimary = primaryOutput
    ? graph.edges.find((edge) => edge.fromNode === nodeId && edge.fromSocket === primaryOutput)
    : null;

  const nextNodes = graph.nodes.filter((item) => item.id !== nodeId).map((item) => clone(item));
  const nextEdges = graph.edges
    .filter((edge) => edge.fromNode !== nodeId && edge.toNode !== nodeId)
    .map((edge) => ({ ...edge }));

  if (incomingPrimary && outgoingPrimary) {
    const targetNode = nextNodes.find((item) => item.id === outgoingPrimary.toNode);
    const targetSocket = outgoingPrimary.toSocket;
    const targetSocketStillFree = !nextEdges.some(
      (edge) => edge.toNode === outgoingPrimary.toNode && edge.toSocket === targetSocket
    );
    const selfEdge = incomingPrimary.fromNode === outgoingPrimary.toNode;
    const socketExists = targetNode?.inputs?.some((socket) => socket.name === targetSocket);

    if (
      targetSocketStillFree &&
      !selfEdge &&
      socketExists &&
      !wouldCreateCycle(incomingPrimary.fromNode, outgoingPrimary.toNode, nextEdges)
    ) {
      nextEdges.push({
        id: createEdgeId(
          incomingPrimary.fromNode,
          incomingPrimary.fromSocket,
          outgoingPrimary.toNode,
          targetSocket
        ),
        fromNode: incomingPrimary.fromNode,
        fromSocket: incomingPrimary.fromSocket,
        toNode: outgoingPrimary.toNode,
        toSocket: targetSocket,
      });
    }
  }

  const fallbackSelection =
    graph.selectedNodeId === nodeId
      ? nextNodes.find((item) => item.type === "viewer-output")?.id ?? nextNodes.at(-1)?.id ?? null
      : graph.selectedNodeId;

  dispatch("graph", {
    nodes: nextNodes,
    edges: nextEdges,
    selectedNodeId: fallbackSelection,
  });
  return true;
}

export function updateNodeParams(nodeId, patch) {
  const { graph } = getState();
  const nextNodes = graph.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    return {
      ...node,
      params: {
        ...node.params,
        ...patch,
      },
    };
  });

  dispatch("graph", { nodes: nextNodes });
}

export function toggleNodeBypass(nodeId) {
  const { graph } = getState();
  let changed = false;
  const nextNodes = graph.nodes.map((node) => {
    if (node.id !== nodeId || node.type === "source" || node.type === "viewer-output") return node;
    changed = true;
    return {
      ...node,
      bypassed: !node.bypassed,
    };
  });

  if (!changed) return false;
  dispatch("graph", { nodes: nextNodes });
  return true;
}

export function setParamExposed(nodeId, paramKey, exposed) {
  if (!nodeId || !paramKey) return false;
  const { graph } = getState();
  let changed = false;
  let removedSocket = false;

  const nextNodes = graph.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const list = Array.isArray(node.exposedParams) ? [...node.exposedParams] : [];
    const has = list.includes(paramKey);
    if (exposed && !has) {
      list.push(paramKey);
      changed = true;
    } else if (!exposed && has) {
      list.splice(list.indexOf(paramKey), 1);
      changed = true;
      removedSocket = true;
    } else {
      return node;
    }
    return { ...node, exposedParams: list };
  });

  if (!changed) return false;

  const nextEdges = removedSocket
    ? graph.edges.filter(
        (edge) => !(edge.toNode === nodeId && edge.toSocket === paramSocketName(paramKey))
      )
    : graph.edges;

  dispatch("graph", { nodes: nextNodes, edges: nextEdges });
  return true;
}

export function toggleParamExposed(nodeId, paramKey) {
  const node = getNodeById(nodeId);
  if (!node) return false;
  const exposed = Array.isArray(node.exposedParams) && node.exposedParams.includes(paramKey);
  return setParamExposed(nodeId, paramKey, !exposed);
}

export function removeEdgesById(edgeIds) {
  if (!Array.isArray(edgeIds) || edgeIds.length === 0) return false;
  const ids = new Set(edgeIds);
  const { graph } = getState();
  const nextEdges = graph.edges.filter((edge) => !ids.has(edge.id));
  if (nextEdges.length === graph.edges.length) return false;
  dispatch("graph", { edges: nextEdges });
  return true;
}

export function replacePaletteUsages(removingId, fallbackId) {
  if (!removingId || !fallbackId || removingId === fallbackId) return false;

  const { graph } = getState();
  let changed = false;
  const nextNodes = graph.nodes.map((node) => {
    if (node.type !== "dither" || node.params?.palette !== removingId) return node;
    changed = true;
    return {
      ...node,
      params: {
        ...node.params,
        palette: fallbackId,
      },
    };
  });

  if (!changed) return false;
  dispatch("graph", { nodes: nextNodes });
  return true;
}

export function replaceGraph(nextGraph) {
  const normalized = normalizeGraph(nextGraph);
  dispatch("graph", normalized);
  return normalized;
}

export function serializeGraph(graph = getState().graph) {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      params: clone(node.params),
      exposedParams: Array.isArray(node.exposedParams) ? [...node.exposedParams] : [],
      bypassed: Boolean(node.bypassed),
    })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    selectedNodeId: graph.selectedNodeId,
  };
}

export function getNodeById(nodeId, graph = getState().graph) {
  return graph.nodes.find((node) => node.id === nodeId) ?? null;
}

export function getSelectedNode(graph = getState().graph) {
  if (!graph.selectedNodeId) return null;
  return getNodeById(graph.selectedNodeId, graph);
}

export function getNodeConnections(nodeId, graph = getState().graph) {
  const inputs = graph.edges
    .filter((edge) => edge.toNode === nodeId)
    .map((edge) => {
      const fromNode = getNodeById(edge.fromNode, graph);
      return {
        edgeId: edge.id,
        socket: edge.toSocket,
        fromNodeId: edge.fromNode,
        fromNodeLabel: fromNode?.label ?? edge.fromNode,
        fromSocket: edge.fromSocket,
      };
    });

  const outputs = graph.edges
    .filter((edge) => edge.fromNode === nodeId)
    .map((edge) => {
      const toNode = getNodeById(edge.toNode, graph);
      return {
        edgeId: edge.id,
        socket: edge.fromSocket,
        toNodeId: edge.toNode,
        toNodeLabel: toNode?.label ?? edge.toNode,
        toSocket: edge.toSocket,
      };
    });

  return { inputs, outputs };
}

function normalizeGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return createBootGraph();
  }

  const nextNodes = graph.nodes
    .map((node) => {
      const definition = getNodeDefinition(node.type);
      if (!definition) return null;
      return createNode(node.id, node.type, {
        x: node.x,
        y: node.y,
        params: node.params,
        exposedParams: node.exposedParams,
        bypassed: node.bypassed,
      });
    })
    .filter(Boolean);

  if (!nextNodes.some((node) => node.type === "source")) {
    nextNodes.unshift(createNode("source-1", "source"));
  }
  if (!nextNodes.some((node) => node.type === "viewer-output")) {
    nextNodes.push(createNode("viewer-output-1", "viewer-output"));
  }

  const hasSerializedEdges = Array.isArray(graph.edges);
  const nextEdges = sanitizeEdges(graph.edges, nextNodes);

  if (nextEdges.length === 0 && !hasSerializedEdges) {
    const chain = getLinearChain({ nodes: nextNodes, edges: [] });
    layoutLinearNodes(chain);
    return {
      nodes: chain,
      edges: buildLinearEdges(chain),
      selectedNodeId: graph.selectedNodeId ?? chain.at(-1)?.id ?? null,
    };
  }

  return {
    nodes: nextNodes,
    edges: nextEdges,
    selectedNodeId:
      nextNodes.some((node) => node.id === graph.selectedNodeId)
        ? graph.selectedNodeId
        : nextNodes.at(-1)?.id ?? null,
  };
}

function createNode(id, type, options = {}) {
  const definition = getNodeDefinition(type);
  if (!definition) throw new Error(`Unknown node type: ${type}`);

  return {
    id,
    type,
    label: definition.label,
    x: options.x ?? NODE_BASE_X,
    y: options.y ?? NODE_BASE_Y,
    inputs: definition.inputs.map((socket) => ({ ...socket })),
    outputs: definition.outputs.map((socket) => ({ ...socket })),
    params: {
      ...clone(definition.defaultParams),
      ...clone(options.params),
    },
    exposedParams: Array.isArray(options.exposedParams) ? [...options.exposedParams] : [],
    bypassed: Boolean(options.bypassed),
  };
}

function getLinearChain(graph) {
  const source = graph.nodes.find((node) => node.type === "source");
  if (!source) return graph.nodes.map((node) => clone(node));

  const outgoing = new Map();
  for (const edge of graph.edges) {
    outgoing.set(edge.fromNode, edge.toNode);
  }

  const ordered = [];
  const visited = new Set();
  let current = source;

  while (current && !visited.has(current.id)) {
    ordered.push(clone(current));
    visited.add(current.id);
    const nextNodeId = outgoing.get(current.id);
    current = nextNodeId ? getNodeById(nextNodeId, graph) : null;
  }

  for (const node of graph.nodes) {
    if (!visited.has(node.id)) ordered.push(clone(node));
  }

  return ordered;
}

function getInsertionIndex(chain, type) {
  const newOrder = TYPE_ORDER[type] ?? Infinity;
  for (let index = 0; index < chain.length; index++) {
    const existingOrder = TYPE_ORDER[chain[index].type] ?? Infinity;
    if (existingOrder > newOrder) return index;
  }
  return chain.length;
}

function getMainChain(graph) {
  const viewer = graph.nodes.find((node) => node.type === "viewer-output");
  if (!viewer) return graph.nodes.map((node) => clone(node));

  const chain = [clone(viewer)];
  const visited = new Set([viewer.id]);
  let current = viewer;

  while (current) {
    const primary = getPrimaryInputSocket(current);
    if (!primary) break;
    const edge = graph.edges.find(
      (item) => item.toNode === current.id && item.toSocket === primary
    );
    if (!edge) break;
    const prev = getNodeById(edge.fromNode, graph);
    if (!prev || visited.has(prev.id)) break;
    chain.unshift(clone(prev));
    visited.add(prev.id);
    current = prev;
  }

  return chain;
}

function getPrimaryInputSocket(node) {
  return node.inputs?.[0]?.name ?? null;
}

function getPrimaryOutputSocket(node) {
  return node.outputs?.[0]?.name ?? null;
}

function getSocket(node, kind, socketName) {
  if (kind === "input" && isParamSocketName(socketName)) {
    return hasParamSocket(node, socketName)
      ? { name: socketName, label: socketName.slice("param:".length), type: "value" }
      : null;
  }
  const sockets = kind === "output" ? node?.outputs : node?.inputs;
  return sockets?.find((socket) => socket.name === socketName) ?? null;
}

function hasInputSocket(node, socketName) {
  if (isParamSocketName(socketName)) return hasParamSocket(node, socketName);
  return node.inputs.some((socket) => socket.name === socketName);
}

function isParamSocketName(socketName) {
  return typeof socketName === "string" && socketName.startsWith("param:");
}

function hasParamSocket(node, socketName) {
  if (!node || !isParamSocketName(socketName)) return false;
  const paramKey = socketName.slice("param:".length);
  return Array.isArray(node.exposedParams) && node.exposedParams.includes(paramKey);
}

function paramSocketName(paramKey) {
  return `param:${paramKey}`;
}

function socketType(socket) {
  return socket?.type ?? "image";
}

function isImageSocket(node, kind, socketName) {
  const socket = getSocket(node, kind, socketName);
  return Boolean(socket) && socketType(socket) === "image";
}

function socketsCompatible(fromNode, fromSocket, toNode, toSocket) {
  const from = getSocket(fromNode, "output", fromSocket);
  const to = getSocket(toNode, "input", toSocket);
  if (!from || !to) return false;
  const fromType = socketType(from);
  const toType = socketType(to);
  return fromType === toType;
}

function layoutMainChain(nodes, edges) {
  const chain = getMainChain({ nodes, edges });
  const chainIds = new Set(chain.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  chain.forEach((chainNode, index) => {
    const real = nodeById.get(chainNode.id);
    if (real) {
      real.x = NODE_BASE_X + index * NODE_SPACING_X;
      real.y = NODE_BASE_Y;
    }
  });

  let offChainIndex = 0;
  for (const node of nodes) {
    if (chainIds.has(node.id)) continue;
    node.x = NODE_BASE_X + offChainIndex * NODE_SPACING_X;
    node.y = NODE_BASE_Y + 160;
    offChainIndex += 1;
  }
}

function buildLinearEdges(nodes) {
  const edges = [];

  for (let index = 0; index < nodes.length - 1; index++) {
    const fromNode = nodes[index];
    const toNode = nodes[index + 1];
    if (!fromNode.outputs[0] || !toNode.inputs[0]) continue;
    if (!socketsCompatible(fromNode, fromNode.outputs[0].name, toNode, toNode.inputs[0].name)) {
      continue;
    }

    edges.push({
      id: createEdgeId(fromNode.id, fromNode.outputs[0].name, toNode.id, toNode.inputs[0].name),
      fromNode: fromNode.id,
      fromSocket: fromNode.outputs[0].name,
      toNode: toNode.id,
      toSocket: toNode.inputs[0].name,
    });
  }

  return edges;
}

function sanitizeEdges(edges, nodes) {
  if (!Array.isArray(edges)) return [];

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nextEdges = [];
  const occupiedInputs = new Set();

  for (const edge of edges) {
    const fromNode = nodeById.get(edge?.fromNode);
    const toNode = nodeById.get(edge?.toNode);
    if (!fromNode || !toNode || fromNode.id === toNode.id) continue;

    const fromSocket = edge.fromSocket;
    const toSocket = edge.toSocket;
    const hasOutput = fromNode.outputs.some((socket) => socket.name === fromSocket);
    const hasInput = hasInputSocket(toNode, toSocket);
    if (!hasOutput || !hasInput) continue;
    if (!socketsCompatible(fromNode, fromSocket, toNode, toSocket)) continue;

    const inputKey = `${toNode.id}:${toSocket}`;
    if (occupiedInputs.has(inputKey)) continue;
    if (wouldCreateCycle(fromNode.id, toNode.id, nextEdges)) continue;

    occupiedInputs.add(inputKey);
    nextEdges.push({
      id: edge.id || createEdgeId(fromNode.id, fromSocket, toNode.id, toSocket),
      fromNode: fromNode.id,
      fromSocket,
      toNode: toNode.id,
      toSocket,
    });
  }

  return nextEdges;
}

function layoutLinearNodes(nodes) {
  nodes.forEach((node, index) => {
    node.x = NODE_BASE_X + index * NODE_SPACING_X;
    node.y = NODE_BASE_Y;
  });
}

function nextNodeId(type, graph) {
  const prefix = type;
  let index = 1;
  while (graph.nodes.some((node) => node.id === `${prefix}-${index}`)) {
    index++;
  }
  return `${prefix}-${index}`;
}

function createEdgeId(fromNode, fromSocket, toNode, toSocket) {
  return `edge-${fromNode}-${fromSocket}-${toNode}-${toSocket}`;
}

function wouldCreateCycle(fromNodeId, toNodeId, edges) {
  const visited = new Set();
  const stack = [toNodeId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === fromNodeId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    for (const edge of edges) {
      if (edge.fromNode === currentId) {
        stack.push(edge.toNode);
      }
    }
  }

  return false;
}

function isPrimaryChainEdge(edge, graph) {
  if (!edge) return false;
  const fromNode = getNodeById(edge.fromNode, graph);
  const toNode = getNodeById(edge.toNode, graph);
  if (!fromNode || !toNode) return false;
  return (
    edge.fromSocket === getPrimaryOutputSocket(fromNode) &&
    edge.toSocket === getPrimaryInputSocket(toNode)
  );
}

function shiftPrimaryChainFromNode(nodes, edges, startNodeId, deltaX) {
  if (!startNodeId || !deltaX) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set();
  let current = nodeById.get(startNodeId);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    current.x += deltaX;

    const primaryOutput = getPrimaryOutputSocket(current);
    if (!primaryOutput) break;

    const nextEdge = edges.find((edge) => {
      const target = nodeById.get(edge.toNode);
      return (
        edge.fromNode === current.id &&
        edge.fromSocket === primaryOutput &&
        edge.toSocket === getPrimaryInputSocket(target)
      );
    });

    current = nextEdge ? nodeById.get(nextEdge.toNode) : null;
  }
}

function shiftPrimaryChainToNode(nodes, edges, startNodeId, deltaX) {
  if (!startNodeId || !deltaX) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set();
  let current = nodeById.get(startNodeId);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    current.x += deltaX;

    const primaryInput = getPrimaryInputSocket(current);
    if (!primaryInput) break;

    const prevEdge = edges.find((edge) => {
      const source = nodeById.get(edge.fromNode);
      return (
        edge.toNode === current.id &&
        edge.toSocket === primaryInput &&
        edge.fromSocket === getPrimaryOutputSocket(source)
      );
    });

    current = prevEdge ? nodeById.get(prevEdge.fromNode) : null;
  }
}

function spacePrimaryChainAroundNode(nodes, edges, leftNodeId, insertedNodeId, rightNodeId, options = {}) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const leftNode = nodeById.get(leftNodeId);
  const insertedNode = nodeById.get(insertedNodeId);
  const rightNode = nodeById.get(rightNodeId);
  if (!leftNode || !insertedNode || !rightNode) return;

  if (!options.preserveInserted) {
    insertedNode.x = midpoint(leftNode.x, rightNode.x);
    insertedNode.y = midpoint(leftNode.y, rightNode.y);
  }

  const desiredLeftX = insertedNode.x - NODE_WIDTH - NODE_INSERT_GAP_X;
  const leftOverlap = leftNode.x - desiredLeftX;
  if (leftOverlap > 0) {
    shiftPrimaryChainToNode(nodes, edges, leftNode.id, -leftOverlap);
  }

  const desiredRightX = insertedNode.x + NODE_WIDTH + NODE_INSERT_GAP_X;
  const rightOverlap = desiredRightX - rightNode.x;
  if (rightOverlap > 0) {
    shiftPrimaryChainFromNode(nodes, edges, rightNode.id, rightOverlap);
  }
}

function midpoint(a, b) {
  return (Number(a) + Number(b)) / 2;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}
