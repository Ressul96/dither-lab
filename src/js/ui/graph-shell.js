import { DEFAULT_GRAPH_VIEW, dispatch, getState, subscribe } from "../state.js";
import {
  addEdge,
  createFreeNode,
  ensureBootGraph,
  getNodeById,
  getNodeDefinition,
  getSelectedNode,
  getValueNodeOutputBounds,
  insertExistingNodeOnEdge,
  insertNodeOnEdge,
  mutateNodePosition,
  removeEdgesById,
  removeNode,
  replacePaletteUsages,
  selectNode,
  toggleParamExposed,
  toggleNodeBypass,
  updateNodeParams,
} from "../graph.js";
import { getAlgorithmOptions } from "../dither/index.js";
import {
  extractPaletteFromImageData,
  mergePaletteExtraction,
  normalizeExtractionSize,
  PALETTE_EXTRACTION_SIZES,
} from "../palette-extraction.js";
import {
  createCustomPalette,
  duplicatePalette,
  getPalette,
  getPaletteOptionsGrouped,
  isBuiltInPalette,
  listCustomPalettes,
  removePalette,
  subscribePalettes,
  updateCustomPalette,
} from "../palettes.js";
import { getCurrentSourceFrameCanvas, setFps } from "../source.js";
import {
  commitParamValueToTimeline,
  hasParamKeyframeAtCurrentTime,
  hasTimelineTrackForParam,
  toggleParamKeyframeAtCurrentTime,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import { normalizeHex } from "../color.js";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 108;
const SOCKET_Y = 58;
const SOCKET_STEP = 28;
const GRAPH_WORLD_SIZE = 16000;
const GRAPH_WORLD_ORIGIN = GRAPH_WORLD_SIZE / 2;
const GRAPH_GRID_STEP = 24;
const SOCKET_HIT_RADIUS = 28;
// Generous radius around an edge counts as a drop-on-edge target. The user
// rarely lands the ghost preview exactly on the SVG path, so a wide tolerance
// trades a tiny bit of "free placement" precision for the much more useful
// "drop here, snap into the chain" behaviour. The fallback radius is even
// wider and is only consulted when the precise path-distance check fails.
const EDGE_INSERT_RADIUS = 140;
const EDGE_INSERT_FALLBACK_RADIUS = 240;
const GRAPH_VIEW_PADDING = 120;
const EDGE_CUT_RADIUS = 10;

let nodesEl;
let edgesEl;
let editorEl;
let inspectorEl;
let inspectorTitleEl;
let stageEl;
let resizeObserver;
let renderedInspectorNodeId = null;
let inspectorEditing = false;
let keyboardWired = false;
let draggedPaletteType = "";
let paletteExtractionSize = 4;
let graphMenuEl = null;
let graphMenuState = null;
let insertHighlightEdgeId = "";
let graphAutoCentered = false;
let paletteDragPreviewEl = null;
const paletteSwatchLocks = new Map();

export function initGraphShell() {
  ensureBootGraph();

  nodesEl = document.getElementById("graphNodes");
  edgesEl = document.getElementById("graphEdges");
  editorEl = document.getElementById("nodeEditor");
  inspectorEl = document.getElementById("nodeInspector");
  inspectorTitleEl = document.getElementById("nodeInspectorTitle");
  stageEl = document.getElementById("stage");

  if (!nodesEl || !edgesEl || !editorEl || !inspectorEl) return;

  nodesEl.addEventListener("click", onNodeClick);
  nodesEl.addEventListener("pointerdown", onGraphPointerDown);
  inspectorEl.addEventListener("input", onInspectorInput);
  inspectorEl.addEventListener("change", onInspectorChange);
  inspectorEl.addEventListener("click", onInspectorClick);
  inspectorEl.addEventListener("pointerdown", onInspectorPointerDown);
  inspectorEl.addEventListener("contextmenu", onInspectorContextMenu);
  subscribePalettes(onPaletteRegistryChange);
  initPaletteDragAndDrop();
  initViewportInteractions();
  initGraphContextMenu();
  wireKeyboard();

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => applyGraphViewport());
    resizeObserver.observe(editorEl);
  }

  window.addEventListener("resize", applyGraphViewport);

  subscribe("graph", () => {
    const { graphView } = getState();
    if (
      graphView.zoom === DEFAULT_GRAPH_VIEW.zoom &&
      graphView.panX === DEFAULT_GRAPH_VIEW.panX &&
      graphView.panY === DEFAULT_GRAPH_VIEW.panY
    ) {
      graphAutoCentered = false;
    }
    renderShell();
  });
  subscribe("timeline", () => {
    if (!inspectorEditing) renderInspector();
  });
  subscribe("playback", () => {
    if (!inspectorEditing) syncTimelineButtons();
  });
  subscribe("graphView", applyGraphViewport);
  subscribe("source", () => {
    const selected = getSelectedNode();
    if (selected?.type === "viewer-output" && !inspectorEditing) {
      renderInspector();
    }
  });

  requestAnimationFrame(() => {
    maybeAutoCenterGraph();
  });
}

function initPaletteDragAndDrop() {
  for (const item of document.querySelectorAll("[data-palette-node]")) {
    item.setAttribute("draggable", "false");
    item.addEventListener("pointerdown", (event) => {
      startPalettePointerDrag(event, item);
    });

    item.addEventListener("dragstart", (e) => {
      const type = item.dataset.paletteNode;
      if (!type) return;
      draggedPaletteType = type;
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("application/x-node-type", type);
      e.dataTransfer.setData("text/plain", `ditherlab-node:${type}`);
    });

    item.addEventListener("dragend", () => {
      draggedPaletteType = "";
      removePaletteDragPreview();
      clearInsertHighlight();
    });
  }

  editorEl.addEventListener("dragover", (e) => {
    const type = resolvePaletteNodeType(e.dataTransfer);
    if (!type) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    updatePaletteDragPreview(type, e.clientX, e.clientY);
    const edge = findInsertableEdgeAt(e.clientX, e.clientY);
    setInsertHighlight(edge?.edgeId ?? "");
  });

  editorEl.addEventListener("drop", (e) => {
    const type = resolvePaletteNodeType(e.dataTransfer);
    draggedPaletteType = "";
    const edge = findInsertTargetAt(e.clientX, e.clientY);
    removePaletteDragPreview();
    clearInsertHighlight();
    if (!type) return;
    e.preventDefault();
    if (edge?.edgeId) {
      const inserted = insertNodeOnEdge(edge.edgeId, type, {
        position: nodePositionFromPoint(clientToWorld(e.clientX, e.clientY)),
      });
      if (!inserted) createNodeFromPalette(type, clientToWorld(e.clientX, e.clientY));
      return;
    }
    createNodeFromPalette(type, clientToWorld(e.clientX, e.clientY));
  });

  editorEl.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && editorEl.contains(event.relatedTarget)) return;
    removePaletteDragPreview();
    clearInsertHighlight();
  });

  stageEl?.addEventListener("dragover", (e) => {
    if (!resolvePaletteNodeType(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    removePaletteDragPreview();
    clearInsertHighlight();
  });

  stageEl?.addEventListener("drop", (e) => {
    const type = resolvePaletteNodeType(e.dataTransfer);
    draggedPaletteType = "";
    removePaletteDragPreview();
    clearInsertHighlight();
    if (!type) return;
    e.preventDefault();
    insertPaletteNodeAtDefault(type);
  });
}

function startPalettePointerDrag(event, item) {
  if (event.button !== 0) return;
  const type = item.dataset.paletteNode;
  if (!type) return;

  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;

  try {
    item.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY);
    if (!dragging && moved < 6) return;

    if (!dragging) {
      dragging = true;
      item.classList.add("is-dragging");
    }

    if (isPointOverEditor(ev.clientX, ev.clientY)) {
      updatePaletteDragPreview(type, ev.clientX, ev.clientY);
      const edge = findInsertableEdgeAt(ev.clientX, ev.clientY);
      setInsertHighlight(edge?.edgeId ?? "");
    } else {
      removePaletteDragPreview();
      clearInsertHighlight();
    }
  };

  const onUp = (ev) => {
    item.removeEventListener("pointermove", onMove);
    item.removeEventListener("pointerup", onUp);
    item.removeEventListener("pointercancel", onUp);

    item.classList.remove("is-dragging");
    removePaletteDragPreview();

    try {
      item.releasePointerCapture(event.pointerId);
    } catch {}

    const droppedOnEditor = isPointOverEditor(ev.clientX, ev.clientY);
    const droppedOnStage = isPointOverStage(ev.clientX, ev.clientY);

    if (!dragging) {
      clearInsertHighlight();
      insertPaletteNodeAtDefault(type);
      return;
    }

    if (droppedOnEditor) {
      const edge = findInsertTargetAt(ev.clientX, ev.clientY);
      clearInsertHighlight();
      if (edge?.edgeId) {
        const inserted = insertNodeOnEdge(edge.edgeId, type, {
          position: nodePositionFromPoint(clientToWorld(ev.clientX, ev.clientY)),
        });
        if (!inserted) createNodeFromPalette(type, clientToWorld(ev.clientX, ev.clientY));
      } else {
        createNodeFromPalette(type, clientToWorld(ev.clientX, ev.clientY));
      }
      return;
    }

    clearInsertHighlight();
    if (droppedOnStage) {
      insertPaletteNodeAtDefault(type);
    }
  };

  item.addEventListener("pointermove", onMove);
  item.addEventListener("pointerup", onUp);
  item.addEventListener("pointercancel", onUp);
}

function updatePaletteDragPreview(type, clientX, clientY) {
  if (!nodesEl || !isPointOverEditor(clientX, clientY)) {
    removePaletteDragPreview();
    return;
  }

  if (!paletteDragPreviewEl || paletteDragPreviewEl.dataset.previewType !== type) {
    removePaletteDragPreview();
    paletteDragPreviewEl = createPaletteDragPreview(type);
    if (!paletteDragPreviewEl) return;
    nodesEl.appendChild(paletteDragPreviewEl);
  }

  const point = clientToWorld(clientX, clientY);
  paletteDragPreviewEl.style.left = `${toSceneX(point.x - NODE_WIDTH / 2)}px`;
  paletteDragPreviewEl.style.top = `${toSceneY(point.y - NODE_HEIGHT / 2)}px`;
}

function createPaletteDragPreview(type) {
  const definition = getNodeDefinition(type);
  if (!definition) return null;
  const previewNode = {
    id: "drag-preview",
    type,
    label: definition.label,
    inputs: definition.inputs,
    outputs: definition.outputs,
  };

  const preview = document.createElement("div");
  preview.className = "graph-node graph-node--drag-preview";
  preview.dataset.previewType = type;
  preview.innerHTML = `
    <div class="graph-node-head">
      <span class="graph-node-title">${escapeHtml(definition.label)}</span>
      <span class="graph-node-family">${escapeHtml(definition.family ?? "Node")}</span>
    </div>
    <div class="graph-node-rows">
      ${renderSocketRows(previewNode)}
    </div>
  `;
  return preview;
}

function removePaletteDragPreview() {
  paletteDragPreviewEl?.remove();
  paletteDragPreviewEl = null;
}

function initViewportInteractions() {
  editorEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomGraphAtPointer(e);
        return;
      }

      const { graphView } = getState();
      dispatch("graphView", {
        panX: graphView.panX - e.deltaX,
        panY: graphView.panY - e.deltaY,
      });
    },
    { passive: false }
  );

  editorEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("[data-node-id]") || e.target.closest(".graph-socket-hit")) return;
    if (e.metaKey || e.ctrlKey) {
      startEdgeCut(e);
      return;
    }
    startEditorPan(e);
  });
}

function startEdgeCut(e) {
  e.preventDefault();
  const points = [{
    scene: clientToScene(e.clientX, e.clientY),
    client: { x: e.clientX, y: e.clientY },
  }];

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "graph-cut-path");
  edgesEl.appendChild(path);

  const updatePath = () => {
    const d = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.scene.x} ${point.scene.y}`)
      .join(" ");
    path.setAttribute("d", d);
  };
  updatePath();

  document.body.classList.add("cutting-edges");
  try {
    editorEl.setPointerCapture(e.pointerId);
  } catch {}

  const onMove = (ev) => {
    const last = points[points.length - 1].client;
    if (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) < 4) return;
    points.push({
      scene: clientToScene(ev.clientX, ev.clientY),
      client: { x: ev.clientX, y: ev.clientY },
    });
    updatePath();
  };

  const onUp = () => {
    editorEl.removeEventListener("pointermove", onMove);
    editorEl.removeEventListener("pointerup", onUp);
    editorEl.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("cutting-edges");
    try {
      editorEl.releasePointerCapture(e.pointerId);
    } catch {}

    const cuts = findEdgesIntersectingStroke(points.map((point) => point.scene));
    path.remove();
    if (cuts.length > 0) removeEdgesById(cuts);
  };

  editorEl.addEventListener("pointermove", onMove);
  editorEl.addEventListener("pointerup", onUp);
  editorEl.addEventListener("pointercancel", onUp);
}

function findEdgesIntersectingStroke(strokeScenePoints) {
  if (!strokeScenePoints || strokeScenePoints.length < 2) return [];
  const cut = [];
  for (const path of edgesEl.querySelectorAll(".graph-edge[data-edge-id]")) {
    if (edgeCrossesStroke(path, strokeScenePoints)) {
      cut.push(path.dataset.edgeId);
    }
  }
  return cut;
}

function edgeCrossesStroke(path, strokeScenePoints) {
  const total = path.getTotalLength?.() ?? 0;
  if (!Number.isFinite(total) || total <= 0) return false;
  const sampleCount = Math.max(16, Math.min(96, Math.round(total / 6)));
  const edgePoints = [];
  for (let i = 0; i <= sampleCount; i++) {
    edgePoints.push(path.getPointAtLength((total * i) / sampleCount));
  }

  for (let i = 0; i < edgePoints.length - 1; i++) {
    for (let j = 0; j < strokeScenePoints.length - 1; j++) {
      const edgeA = edgePoints[i];
      const edgeB = edgePoints[i + 1];
      const cutA = strokeScenePoints[j];
      const cutB = strokeScenePoints[j + 1];
      if (
        segmentsIntersect(edgeA, edgeB, cutA, cutB) ||
        segmentDistance(edgeA, edgeB, cutA, cutB) <= EDGE_CUT_RADIUS
      ) {
        return true;
      }
    }
  }
  return false;
}

function segmentsIntersect(a, b, c, d) {
  const denom = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (denom === 0) return false;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denom;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function segmentDistance(a, b, c, d) {
  return Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b)
  );
}

function pointToSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq, 0, 1);
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return Math.hypot(point.x - x, point.y - y);
}

function zoomGraphAtPointer(e) {
  const { graphView } = getState();
  const point = clientToWorld(e.clientX, e.clientY);
  const local = getLocalPoint(e.clientX, e.clientY);
  const nextZoom = clamp(graphView.zoom * Math.exp(-e.deltaY * 0.0015), 0.35, 2.25);

  dispatch("graphView", {
    zoom: nextZoom,
    panX: local.x - toSceneX(point.x) * nextZoom,
    panY: local.y - toSceneY(point.y) * nextZoom,
  });
}

function startEditorPan(e) {
  const { graphView } = getState();
  const startX = e.clientX;
  const startY = e.clientY;
  const startPanX = graphView.panX;
  const startPanY = graphView.panY;

  editorEl.classList.add("panning");
  try {
    editorEl.setPointerCapture(e.pointerId);
  } catch {}

  const onMove = (ev) => {
    dispatch("graphView", {
      panX: startPanX + (ev.clientX - startX),
      panY: startPanY + (ev.clientY - startY),
    });
  };

  const onUp = () => {
    editorEl.removeEventListener("pointermove", onMove);
    editorEl.removeEventListener("pointerup", onUp);
    editorEl.removeEventListener("pointercancel", onUp);
    editorEl.classList.remove("panning");
    try {
      editorEl.releasePointerCapture(e.pointerId);
    } catch {}
  };

  editorEl.addEventListener("pointermove", onMove);
  editorEl.addEventListener("pointerup", onUp);
  editorEl.addEventListener("pointercancel", onUp);
}

function onGraphPointerDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest("[data-node-action]")) return;

  const socket = e.target.closest(".graph-socket-hit");
  if (socket) {
    startSocketDrag(e, socket);
    return;
  }

  const nodeBtn = e.target.closest("[data-node-id]");
  if (nodeBtn) {
    startNodeDrag(e, nodeBtn);
  }
}

function wireKeyboard() {
  if (keyboardWired) return;
  keyboardWired = true;

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }

    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const selectedNodeId = getState().graph.selectedNodeId;
    if (!selectedNodeId) return;
    if (!removeNode(selectedNodeId)) return;
    event.preventDefault();
  });
}

function startNodeDrag(e, nodeEl) {
  const nodeId = nodeEl.dataset.nodeId;
  const node = getNodeById(nodeId);
  if (!node) return;

  e.preventDefault();
  // Lock pointer to this node so the browser cannot start its own drag (e.g. button
  // native dragstart, focus-driven cancel) before we cross the move threshold.
  try {
    nodeEl.setPointerCapture(e.pointerId);
  } catch (_) {}

  const originX = e.clientX;
  const originY = e.clientY;
  const startX = node.x;
  const startY = node.y;
  const startZoom = getState().graphView.zoom || 1;
  let moved = false;
  let liveEl = nodeEl;
  let edgeRenderQueued = false;
  document.body.classList.add("dragging-node");

  const scheduleEdgeRender = () => {
    if (edgeRenderQueued) return;
    edgeRenderQueued = true;
    requestAnimationFrame(() => {
      edgeRenderQueued = false;
      renderEdges();
    });
  };

  const onMove = (ev) => {
    const dx = ev.clientX - originX;
    const dy = ev.clientY - originY;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) {
      moved = true;
      selectNodeWithoutDispatch(nodeId);
    }
    const nextX = startX + dx / startZoom;
    const nextY = startY + dy / startZoom;
    mutateNodePosition(nodeId, nextX, nextY);
    if (!liveEl.isConnected) {
      liveEl = nodesEl.querySelector(`[data-node-id="${cssEscape(nodeId)}"]`) || liveEl;
    }
    liveEl.style.left = `${toSceneX(nextX)}px`;
    liveEl.style.top = `${toSceneY(nextY)}px`;
    const edge = findInsertTargetForNodeAt(nodeId, ev.clientX, ev.clientY);
    setInsertHighlight(edge?.edgeId ?? "");
    scheduleEdgeRender();
  };

  const onUp = (ev) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    try {
      if (nodeEl.hasPointerCapture?.(e.pointerId)) {
        nodeEl.releasePointerCapture(e.pointerId);
      }
    } catch (_) {}
    document.body.classList.remove("dragging-node");
    if (!moved) {
      clearInsertHighlight();
      selectNode(nodeId);
    } else {
      const edge = findInsertTargetForNodeAt(nodeId, ev.clientX, ev.clientY);
      clearInsertHighlight();
      if (edge?.edgeId && insertExistingNodeOnEdge(nodeId, edge.edgeId)) {
        return;
      }

      const liveSelected = nodesEl.querySelector(`[data-node-id="${cssEscape(nodeId)}"]`);
      liveSelected?.classList.add("selected");
      const previouslySelected = getState().graph.selectedNodeId;
      if (previouslySelected && previouslySelected !== nodeId) {
        const prev = nodesEl.querySelector(`[data-node-id="${cssEscape(previouslySelected)}"]`);
        prev?.classList.remove("selected");
      }
      selectNodeWithoutDispatch(nodeId);
      renderInspector();
      renderEdges();
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function selectNodeWithoutDispatch(nodeId) {
  const { graph } = getState();
  if (graph.selectedNodeId === nodeId) return;
  graph.selectedNodeId = nodeId;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/(["\\])/g, "\\$1");
}

function startSocketDrag(e, socketEl) {
  e.preventDefault();
  e.stopPropagation();

  const fromNodeId = socketEl.dataset.socketNode;
  const fromSocketName = socketEl.dataset.socketName;
  const fromKind = socketEl.dataset.socketKind;
  const fromNode = getNodeById(fromNodeId);
  if (!fromNode) return;

  const start = getSocketPoint(fromNode, fromKind, fromSocketName);

  const ghost = document.createElementNS("http://www.w3.org/2000/svg", "path");
  ghost.setAttribute("class", "graph-edge graph-edge--ghost");
  edgesEl.appendChild(ghost);

  const updateGhost = (clientX, clientY) => {
    const pointer = clientToScene(clientX, clientY);
    const pointerX = pointer.x;
    const pointerY = pointer.y;
    const controlOffset = Math.max(72, Math.abs(pointerX - start.x) * 0.4);
    const p1 = fromKind === "output"
      ? [start.x + controlOffset, start.y]
      : [start.x - controlOffset, start.y];
    const p2 = fromKind === "output"
      ? [pointerX - controlOffset, pointerY]
      : [pointerX + controlOffset, pointerY];
    ghost.setAttribute(
      "d",
      `M ${start.x} ${start.y} C ${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${pointerX} ${pointerY}`
    );
  };

  updateGhost(e.clientX, e.clientY);

  const onMove = (ev) => {
    updateGhost(ev.clientX, ev.clientY);
    const hovered = findSocketAt(ev.clientX, ev.clientY, fromKind);
    highlightTarget(hovered, fromKind);
  };

  const onUp = (ev) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    clearHighlight();
    ghost.remove();

    const target = findSocketAt(ev.clientX, ev.clientY, fromKind);
    if (!target) return;
    if (target.kind === fromKind) return;

    if (fromKind === "output") {
      addEdge(fromNodeId, fromSocketName, target.nodeId, target.socketName);
    } else {
      addEdge(target.nodeId, target.socketName, fromNodeId, fromSocketName);
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function findSocketAt(clientX, clientY, fromKind = "") {
  let best = null;
  const zoom = getState().graphView.zoom || 1;
  const hitRadius = SOCKET_HIT_RADIUS * Math.max(1, 1 / Math.max(zoom, 0.35));

  for (const hit of nodesEl.querySelectorAll(".graph-socket-hit")) {
    const dot = hit.querySelector(".graph-socket-dot") ?? hit;
    const rect = dot.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > hitRadius) continue;

    const kind = hit.dataset.socketKind;
    const compatibleBoost = kind && fromKind && kind !== fromKind ? -4 : 0;
    const score = distance + compatibleBoost;
    if (best && best.score <= score) continue;

    best = {
      nodeId: hit.dataset.socketNode,
      socketName: hit.dataset.socketName,
      kind,
      el: hit,
      score,
    };
  }

  return best;
}

let lastHighlighted = null;
function highlightTarget(target, fromKind) {
  if (lastHighlighted && lastHighlighted !== target?.el) {
    lastHighlighted.classList.remove("drop-target", "drop-reject");
    lastHighlighted = null;
  }
  if (!target) return;
  const reject = target.kind === fromKind;
  target.el.classList.add(reject ? "drop-reject" : "drop-target");
  lastHighlighted = target.el;
}
function clearHighlight() {
  if (lastHighlighted) {
    lastHighlighted.classList.remove("drop-target", "drop-reject");
    lastHighlighted = null;
  }
}

function findInsertableEdgeAt(clientX, clientY) {
  let best = null;

  for (const path of edgesEl.querySelectorAll(".graph-edge[data-edge-id]")) {
    const distance = distanceToEdgePath(path, clientX, clientY);
    if (!Number.isFinite(distance) || distance > EDGE_INSERT_RADIUS) continue;
    if (best && best.distance <= distance) continue;
    best = {
      edgeId: path.dataset.edgeId,
      distance,
      el: path,
    };
  }

  return best;
}

// Last-resort lookup: when path sampling didn't snap to anything (often
// because the user dropped a bit far from the line), accept the closest
// edge whose midpoint is within the fallback radius.
function findClosestEdgeByMidpoint(clientX, clientY) {
  let best = null;
  for (const path of edgesEl.querySelectorAll(".graph-edge[data-edge-id]")) {
    if (!path?.getBoundingClientRect) continue;
    const rect = path.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const mx = rect.left + rect.width / 2;
    const my = rect.top + rect.height / 2;
    const distance = Math.hypot(clientX - mx, clientY - my);
    if (distance > EDGE_INSERT_FALLBACK_RADIUS) continue;
    if (best && best.distance <= distance) continue;
    best = { edgeId: path.dataset.edgeId, distance, el: path };
  }
  return best;
}

function findInsertTargetAt(clientX, clientY) {
  return (
    findInsertableEdgeAt(clientX, clientY) ??
    getHighlightedInsertEdge() ??
    findClosestEdgeByMidpoint(clientX, clientY)
  );
}

function findInsertTargetForNodeAt(nodeId, clientX, clientY) {
  const target = findInsertTargetAt(clientX, clientY);
  if (!target?.edgeId || edgeTouchesNode(target.edgeId, nodeId)) return null;
  return target;
}

function edgeTouchesNode(edgeId, nodeId) {
  const { graph } = getState();
  const edge = graph.edges.find((item) => item.id === edgeId);
  return Boolean(edge && (edge.fromNode === nodeId || edge.toNode === nodeId));
}

function getHighlightedInsertEdge() {
  if (!insertHighlightEdgeId) return null;
  const el = edgesEl.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`);
  if (!el) return null;
  return {
    edgeId: insertHighlightEdgeId,
    distance: 0,
    el,
  };
}

function distanceToEdgePath(path, clientX, clientY) {
  if (!path?.getTotalLength) return Infinity;
  const total = path.getTotalLength();
  if (!Number.isFinite(total) || total <= 0) return Infinity;
  if (!isNearClientRect(path.getBoundingClientRect(), clientX, clientY, EDGE_INSERT_RADIUS)) {
    return Infinity;
  }

  let best = Infinity;
  const matrix = path.getScreenCTM?.() ?? null;
  const step = Math.max(4, total / 64);
  for (let length = 0; length <= total; length += step) {
    const point = path.getPointAtLength(length);
    const screenPoint = toScreenPoint(point, matrix);
    best = Math.min(best, Math.hypot(clientX - screenPoint.x, clientY - screenPoint.y));
  }

  const endPoint = path.getPointAtLength(total);
  const screenEndPoint = toScreenPoint(endPoint, matrix);
  best = Math.min(best, Math.hypot(clientX - screenEndPoint.x, clientY - screenEndPoint.y));
  return best;
}

function toScreenPoint(point, matrix) {
  if (!matrix || typeof DOMPoint !== "function") return point;
  return new DOMPoint(point.x, point.y).matrixTransform(matrix);
}

function isNearClientRect(rect, clientX, clientY, padding) {
  if (!rect?.width && !rect?.height) return true;
  return (
    clientX >= rect.left - padding &&
    clientX <= rect.right + padding &&
    clientY >= rect.top - padding &&
    clientY <= rect.bottom + padding
  );
}

function setInsertHighlight(edgeId) {
  if (insertHighlightEdgeId === edgeId) return;

  if (insertHighlightEdgeId) {
    edgesEl.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`)?.classList.remove("insert-target");
  }

  insertHighlightEdgeId = edgeId || "";
  if (insertHighlightEdgeId) {
    edgesEl.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`)?.classList.add("insert-target");
  }
}

function clearInsertHighlight() {
  setInsertHighlight("");
}

function onNodeClick(event) {
  const action = event.target.closest("[data-node-action]");
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    const node = action.closest("[data-node-id]");
    if (!node) return;
    if (action.dataset.nodeAction === "toggle-bypass") {
      toggleNodeBypass(node.dataset.nodeId);
    }
    return;
  }

  const node = event.target.closest("[data-node-id]");
  if (!node) return;
  selectNode(node.dataset.nodeId);
}

function onInspectorInput(event) {
  const control = event.target.closest("[data-node-param]");
  if (control) {
    const node = getSelectedNode();
    if (!node) return;

    // The HEX text input fires `input` on every keystroke; while the user
    // is mid-way through "#fa" we don't want to commit "#000000" through
    // the normaliser. The matching `change` event (on blur or Enter) will
    // pick up the final value and commit through this same path.
    if (control.dataset.inputKind === "color-hex") {
      inspectorEditing = true;
      return;
    }

    inspectorEditing = true;
    if (node.type === "viewer-output" && control.dataset.nodeParam === "viewer-fps") {
      setFps(readControlValue(control));
      updateInlineReadout(control);
      syncSiblingControls(control);
      return;
    }

    const nodeId = node.id;
    const paramKey = control.dataset.nodeParam;
    const value = readControlValue(control);
    updateNodeParams(nodeId, {
      [paramKey]: value,
    });
    // Autokey: when a track already exists OR the global autokey switch is on,
    // record this slider tick as a keyframe. Falls back to the legacy
    // "update existing keyframe only" behaviour for tracks that exist with
    // autokey off, which is identical to the old call.
    if (!commitParamValueToTimeline(nodeId, paramKey, value)) {
      updateParamKeyframeAtCurrentTime(nodeId, paramKey, value);
    }
    const applied = getNodeById(nodeId)?.params?.[paramKey];
    if (applied !== undefined && control.type !== "checkbox" && control.value !== String(applied)) {
      control.value = String(applied);
    }
    updateInlineReadout(control);
    syncSiblingControls(control);
    return;
  }

  const paletteControl = event.target.closest("[data-palette-action]");
  if (paletteControl) {
    handlePaletteInput(paletteControl);
  }
}

function onInspectorChange(event) {
  const control = event.target.closest("[data-node-param]");
  if (control) {
    inspectorEditing = false;
    const node = getSelectedNode();
    if (node?.type === "viewer-output" && control.dataset.nodeParam === "viewer-fps") {
      renderInspector();
      return;
    }
    // HEX text input doesn't commit on `input` (would normalise mid-typing
    // back to fallback); commit happens here on blur / Enter instead. The
    // swatch already committed on `input`, so this branch is a no-op for
    // it — but running it twice is cheap and keeps the dataflow uniform.
    if (
      node &&
      (control.dataset.inputKind === "color-hex" ||
        control.dataset.inputKind === "color-swatch")
    ) {
      const nodeId = node.id;
      const paramKey = control.dataset.nodeParam;
      const value = readControlValue(control);
      updateNodeParams(nodeId, { [paramKey]: value });
      if (!commitParamValueToTimeline(nodeId, paramKey, value)) {
        updateParamKeyframeAtCurrentTime(nodeId, paramKey, value);
      }
      syncSiblingControls(control);
    }
    renderInspector();
    return;
  }

  const paletteControl = event.target.closest("[data-palette-action]");
  if (paletteControl) {
    handlePaletteChange(paletteControl);
  }
}

function onInspectorClick(event) {
  const keyframeToggle = event.target.closest("[data-param-keyframe-toggle]");
  if (keyframeToggle) {
    event.preventDefault();
    const node = getSelectedNode();
    if (!node) return;
    toggleParamKeyframeAtCurrentTime(node.id, keyframeToggle.dataset.paramKeyframeToggle);
    renderInspector();
    return;
  }

  const socketToggle = event.target.closest("[data-param-socket-toggle]");
  if (socketToggle) {
    event.preventDefault();
    const node = getSelectedNode();
    if (!node) return;
    toggleParamExposed(node.id, socketToggle.dataset.paramSocketToggle, {
      min: socketToggle.dataset.paramMin,
      max: socketToggle.dataset.paramMax,
    });
    return;
  }

  const curveAction = event.target.closest("[data-curve-action]");
  if (curveAction) {
    handleCurveClick(curveAction);
    return;
  }

  const paletteControl = event.target.closest("[data-palette-action]");
  if (!paletteControl) return;
  if (paletteControl.tagName === "INPUT") return;
  handlePaletteClick(paletteControl);
}

function handlePaletteClick(control) {
  const action = control.dataset.paletteAction;
  const node = getSelectedDitherNode();
  const selectedId = node?.params?.palette ?? "monochrome";

  switch (action) {
    case "new": {
      const palette = createCustomPalette("Custom Palette", [
        [0, 0, 0],
        [128, 128, 128],
        [255, 255, 255],
      ]);
      if (node) updateNodeParams(node.id, { palette: palette.id });
      renderInspector();
      break;
    }
    case "duplicate": {
      const palette = duplicatePalette(selectedId);
      if (palette && node) updateNodeParams(node.id, { palette: palette.id });
      renderInspector();
      break;
    }
    case "delete": {
      if (isBuiltInPalette(selectedId)) return;
      const fallback = pickFallbackPaletteId(selectedId);
      if (!removePalette(selectedId)) return;
      paletteSwatchLocks.delete(selectedId);
      replacePaletteUsages(selectedId, fallback);
      renderInspector();
      break;
    }
    case "add-swatch": {
      if (isBuiltInPalette(selectedId)) return;
      const palette = getPalette(selectedId);
      if (!palette) return;
      const next = [...palette.colors, [128, 128, 128]];
      updateCustomPalette(selectedId, { colors: next });
      syncPaletteLocks(selectedId, next.length);
      renderInspector();
      break;
    }
    case "remove-swatch": {
      if (isBuiltInPalette(selectedId)) return;
      const palette = getPalette(selectedId);
      if (!palette || palette.colors.length <= 1) return;
      const index = Number(control.dataset.swatchIndex);
      if (Number.isNaN(index)) return;
      const next = palette.colors.filter((_, i) => i !== index);
      updateCustomPalette(selectedId, { colors: next });
      removeLockedSwatchIndex(selectedId, index, next.length);
      renderInspector();
      break;
    }
    case "toggle-lock": {
      if (isBuiltInPalette(selectedId)) return;
      const palette = getPalette(selectedId);
      if (!palette) return;
      const index = Number(control.dataset.swatchIndex);
      if (Number.isNaN(index)) return;
      toggleLockedSwatchIndex(selectedId, index, palette.colors.length);
      renderInspector();
      break;
    }
    case "extract": {
      const imageData = readCurrentSourceFrame();
      if (!imageData) return;
      const palette = getPalette(selectedId);
      if (!palette) return;

      if (isBuiltInPalette(selectedId)) {
        const colors = extractPaletteFromImageData(imageData, { size: paletteExtractionSize });
        if (colors.length === 0) return;
        const extracted = createCustomPalette(`${palette.name} Extracted`, colors);
        paletteSwatchLocks.delete(extracted.id);
        if (node) updateNodeParams(node.id, { palette: extracted.id });
        renderInspector();
        break;
      }

      const size = paletteExtractionSize;
      const lockedIndexes = getLockedSwatchIndexes(selectedId, palette.colors.length)
        .filter((index) => index < size);
      const lockedColors = lockedIndexes.map((index) => palette.colors[index]);
      const extractedColors = extractPaletteFromImageData(imageData, {
        size: Math.max(0, size - lockedColors.length),
        avoidColors: lockedColors,
      });
      const next = mergePaletteExtraction({
        size,
        currentColors: palette.colors,
        lockedIndexes,
        extractedColors,
      });
      if (next.length === 0) return;
      updateCustomPalette(selectedId, { colors: next });
      syncPaletteLocks(selectedId, next.length);
      renderInspector();
      break;
    }
    default:
      break;
  }
}

function handlePaletteInput(control) {
  const action = control.dataset.paletteAction;
  const node = getSelectedDitherNode();
  const selectedId = node?.params?.palette ?? "monochrome";

  if (action === "edit-swatch") {
    if (isBuiltInPalette(selectedId)) return;
    const palette = getPalette(selectedId);
    if (!palette) return;
    const index = Number(control.dataset.swatchIndex);
    if (Number.isNaN(index)) return;
    const next = palette.colors.map((c, i) => (i === index ? hexToRgb(control.value) : c));
    inspectorEditing = true;
    updateCustomPalette(selectedId, { colors: next });
  }
}

function handlePaletteChange(control) {
  const action = control.dataset.paletteAction;
  const node = getSelectedDitherNode();
  const selectedId = node?.params?.palette ?? "monochrome";

  if (action === "rename") {
    if (isBuiltInPalette(selectedId)) return;
    inspectorEditing = false;
    updateCustomPalette(selectedId, { name: control.value });
    renderInspector();
    return;
  }

  if (action === "edit-swatch") {
    inspectorEditing = false;
    renderInspector();
    return;
  }

  if (action === "extract-size") {
    paletteExtractionSize = normalizeExtractionSize(control.value, paletteExtractionSize);
  }
}

function onPaletteRegistryChange() {
  if (!inspectorEl) return;
  prunePaletteLocks();
  if (!inspectorEditing) {
    renderInspector();
  }
  dispatch("graph", {});
}

function getSelectedDitherNode() {
  const { graph } = getState();
  const node = graph.nodes.find((n) => n.id === graph.selectedNodeId);
  return node?.type === "dither" ? node : null;
}

function pickFallbackPaletteId(removingId) {
  const custom = listCustomPalettes().filter((p) => p.id !== removingId);
  if (custom.length > 0) return custom[0].id;
  return "monochrome";
}

function readCurrentSourceFrame() {
  const canvas = getCurrentSourceFrameCanvas();
  if (!canvas?.width || !canvas?.height) return null;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return null;
  try {
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch (error) {
    console.error("[palette-extract] failed to read current source frame", error);
    return null;
  }
}

function getLockedSwatchIndexes(paletteId, colorCount) {
  const locked = paletteSwatchLocks.get(paletteId);
  if (!locked || locked.size === 0) return [];
  return [...locked].filter((index) => index >= 0 && index < colorCount).sort((a, b) => a - b);
}

function isSwatchLocked(paletteId, index, colorCount) {
  return getLockedSwatchIndexes(paletteId, colorCount).includes(index);
}

function toggleLockedSwatchIndex(paletteId, index, colorCount) {
  const next = new Set(getLockedSwatchIndexes(paletteId, colorCount));
  if (next.has(index)) next.delete(index);
  else next.add(index);
  if (next.size === 0) paletteSwatchLocks.delete(paletteId);
  else paletteSwatchLocks.set(paletteId, next);
}

function removeLockedSwatchIndex(paletteId, removedIndex, colorCount) {
  const next = getLockedSwatchIndexes(paletteId, colorCount + 1)
    .filter((index) => index !== removedIndex)
    .map((index) => (index > removedIndex ? index - 1 : index));
  if (next.length === 0) paletteSwatchLocks.delete(paletteId);
  else paletteSwatchLocks.set(paletteId, new Set(next));
}

function syncPaletteLocks(paletteId, colorCount) {
  const next = getLockedSwatchIndexes(paletteId, colorCount);
  if (next.length === 0) paletteSwatchLocks.delete(paletteId);
  else paletteSwatchLocks.set(paletteId, new Set(next));
}

function prunePaletteLocks() {
  for (const palette of listCustomPalettes()) {
    syncPaletteLocks(palette.id, palette.colors.length);
  }
  for (const paletteId of [...paletteSwatchLocks.keys()]) {
    if (!getPalette(paletteId) || isBuiltInPalette(paletteId)) {
      paletteSwatchLocks.delete(paletteId);
    }
  }
}

function rgbToHex(rgb) {
  const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function rgbToCss(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function hexToRgb(hex) {
  const clean = String(hex || "#000000").replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return [r, g, b];
}

function renderShell() {
  if (!nodesEl || !edgesEl || !editorEl || !inspectorEl) return;
  ensureBootGraph();
  renderGraph();
  applyGraphViewport();
  maybeAutoCenterGraph();

  const selected = getSelectedNode();
  if (!inspectorEditing || renderedInspectorNodeId !== selected?.id) {
    renderInspector();
  }
}

function renderGraph() {
  const { graph } = getState();
  nodesEl.style.width = `${GRAPH_WORLD_SIZE}px`;
  nodesEl.style.height = `${GRAPH_WORLD_SIZE}px`;
  nodesEl.innerHTML = graph.nodes.map((node) => renderNode(node, graph.selectedNodeId)).join("");
  renderEdges();
}

function renderEdges() {
  const { graph } = getState();
  edgesEl.setAttribute("viewBox", `0 0 ${GRAPH_WORLD_SIZE} ${GRAPH_WORLD_SIZE}`);
  edgesEl.setAttribute("width", String(GRAPH_WORLD_SIZE));
  edgesEl.setAttribute("height", String(GRAPH_WORLD_SIZE));
  edgesEl.innerHTML = graph.edges.map((edge) => renderEdge(edge, graph)).join("");
  if (insertHighlightEdgeId) {
    edgesEl.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`)?.classList.add("insert-target");
  }
}

function renderNode(node, selectedNodeId) {
  const definition = getNodeDefinition(node.type);
  const selected = node.id === selectedNodeId ? " selected" : "";
  const bypassed = node.bypassed ? " is-bypassed" : "";
  const family = familySlug(definition?.family);
  const canBypass = node.type !== "source" && node.type !== "viewer-output";
  const bypassIcon = node.bypassed ? eyeClosedSvg() : eyeOpenSvg();

  return `
    <div
      class="graph-node graph-node--${family}${selected}${bypassed}"
      role="button"
      tabindex="0"
      draggable="false"
      data-node-id="${escapeHtml(node.id)}"
      data-node-family="${escapeHtml(family)}"
      style="left:${toSceneX(node.x)}px;top:${toSceneY(node.y)}px"
      title="${escapeHtml(node.id)}"
    >
      <div class="graph-node-head">
        <span class="graph-node-title">${escapeHtml(node.label)}</span>
        <span class="graph-node-head-actions">
          ${
            canBypass
              ? `<button class="graph-node-action graph-node-action--visibility" type="button" data-node-action="toggle-bypass" title="${node.bypassed ? "Enable node" : "Bypass node"}" aria-label="${node.bypassed ? "Enable node" : "Bypass node"}">${bypassIcon}</button>`
              : ""
          }
          <span class="graph-node-family">${escapeHtml(definition?.family ?? "Node")}</span>
        </span>
      </div>
      <div class="graph-node-rows">
        ${renderSocketRows(node)}
        ${renderExposedParamRows(node)}
      </div>
    </div>
  `;
}

function eyeOpenSvg() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
      d="M1.5 8C3 4.6 5.4 3 8 3s5 1.6 6.5 5C13 11.4 10.6 13 8 13S3 11.4 1.5 8Z"/>
    <circle cx="8" cy="8" r="2.1" fill="currentColor"/>
  </svg>`;
}

function eyeClosedSvg() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
      d="M1.5 5.5C3.4 8 5.4 9.5 8 9.5s4.6-1.5 6.5-4M3 9.5l-1 1.7M13 9.5l1 1.7M6.4 10.4l-.5 2M9.6 10.4l.5 2"/>
  </svg>`;
}

function renderSocketRows(node) {
  const rowCount = Math.max(node.inputs.length, node.outputs.length, 1);
  return Array.from({ length: rowCount }, (_, index) => `
    <div class="graph-node-row">
      <div class="graph-node-col graph-node-col--input">
        ${renderSocket(node.inputs[index], "input", node.id)}
      </div>
      <div class="graph-node-col graph-node-col--output">
        ${renderSocket(node.outputs[index], "output", node.id)}
      </div>
    </div>
  `).join("");
}

function renderExposedParamRows(node) {
  const exposed = Array.isArray(node.exposedParams) ? node.exposedParams : [];
  if (exposed.length === 0) return "";
  // Same guard as the inspector: skip exposed entries that collide with an
  // explicit input socket so legacy saves don't keep their duplicate pins.
  const explicitInputs = new Set((node.inputs ?? []).map((socket) => socket.name));
  return exposed
    .filter((paramKey) => !explicitInputs.has(paramKey))
    .map((paramKey) => {
      const socket = { name: `param:${paramKey}`, label: paramKey, type: "value" };
      return `
        <div class="graph-node-row graph-node-row--param">
          <div class="graph-node-col graph-node-col--input">
            ${renderSocket(socket, "input", node.id)}
          </div>
          <div class="graph-node-col graph-node-col--output">
            <span class="graph-socket-placeholder"></span>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderSocket(socket, kind, nodeId) {
  if (!socket) {
    return `<span class="graph-socket-placeholder"></span>`;
  }

  const hit = `
    <span
      class="graph-socket-hit"
      data-socket-node="${escapeHtml(nodeId)}"
      data-socket-name="${escapeHtml(socket.name)}"
      data-socket-kind="${kind}"
      data-socket-type="${escapeHtml(socket.type ?? "image")}"
    ><span class="graph-socket-dot"></span></span>
  `;
  const label = `<span class="graph-socket-label">${escapeHtml(socket.label)}</span>`;

  return `
    <span class="graph-socket graph-socket--${kind}">
      ${kind === "input" ? `${hit}${label}` : `${label}${hit}`}
    </span>
  `;
}

function familySlug(value) {
  return String(value ?? "node").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "node";
}

function renderEdge(edge, graph) {
  const fromNode = getNodeById(edge.fromNode, graph);
  const toNode = getNodeById(edge.toNode, graph);
  if (!fromNode || !toNode) return "";

  const start = getSocketPoint(fromNode, "output", edge.fromSocket);
  const end = getSocketPoint(toNode, "input", edge.toSocket);
  const controlOffset = Math.max(72, (end.x - start.x) * 0.4);
  const path = [
    `M ${start.x} ${start.y}`,
    `C ${start.x + controlOffset} ${start.y}`,
    `${end.x - controlOffset} ${end.y}`,
    `${end.x} ${end.y}`,
  ].join(" ");
  const active =
    graph.selectedNodeId === fromNode.id || graph.selectedNodeId === toNode.id ? " active" : "";

  return `<path class="graph-edge${active}" data-edge-id="${escapeHtml(edge.id)}" d="${path}" />`;
}

function renderInspector() {
  const { graph } = getState();
  const node = getSelectedNode(graph);
  renderedInspectorNodeId = node?.id ?? null;

  if (!node) {
    syncInspectorTitle(null);
    inspectorEl.innerHTML = renderEmptyInspector();
    return;
  }

  syncInspectorTitle(node);

  inspectorEl.innerHTML = `
    ${renderNodeSpecifics(node)}
  `;
}

function syncInspectorTitle(node) {
  if (!inspectorTitleEl) return;
  inspectorTitleEl.textContent = node?.label ?? "No node selected";
}

function renderNodeSpecifics(node) {
  switch (node.type) {
    case "source":
      return renderSourceNode();
    case "adjust":
      return renderAdjustNode(node);
    case "posterize":
      return renderPosterizeNode(node);
    case "invert":
      return renderInvertNode(node);
    case "rgb-to-bw":
      return renderRgbToBwNode(node);
    case "tone-map":
      return renderToneMapNode(node);
    case "hsv":
      return renderHsvNode(node);
    case "rgb-curves":
      return renderRgbCurvesNode(node);
    case "blur":
      return renderBlurNode(node);
    case "pixelate":
      return renderPixelateNode(node);
    case "scale":
      return renderScaleNode(node);
    case "transform":
      return renderTransformNode(node);
    case "crop":
      return renderCropNode(node);
    case "flip":
      return renderFlipNode(node);
    case "dither":
      return renderDitherNode(node);
    case "pattern-dither":
      return renderPatternDitherNode(node);
    case "threshold":
      return renderThresholdNode(node);
    case "mask-combine":
      return renderMaskCombineNode(node);
    case "mask-apply":
      return renderMaskApplyNode(node);
    case "glare":
      return renderGlareNode(node);
    case "analog":
      return renderAnalogNode(node);
    case "lens-distort":
      return renderLensDistortNode(node);
    case "chromatic-aberration":
      return renderChromaticAberrationNode(node);
    case "vhs":
      return renderVhsNode(node);
    case "crt":
      return renderCrtNode(node);
    case "bloom":
      return renderBloomNode(node);
    case "halation":
      return renderHalationNode(node);
    case "ascii":
      return renderAsciiNode(node);
    case "halftone":
      return renderHalftoneNode(node);
    case "displace":
      return renderDisplaceNode(node);
    case "mix":
      return renderMixNode(node);
    case "value":
      return renderValueNode(node);
    case "math":
      return renderMathNode(node);
    case "viewer-output":
      return renderViewerOutputNode(node);
    default:
      return `
        <section class="node-panel-section">
          <p class="hint">No editable parameters yet.</p>
        </section>
      `;
  }
}

function renderSourceNode() {
  const node = getSelectedNode();
  const params = node?.params ?? {};
  const bwMode = String(params.bwMode ?? "off");
  const invert = String(params.invert ?? "off");
  const invertChannels = String(params.invertChannels ?? "rgb");
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Adjust</header>
      ${renderRangeField("Brightness", "brightness", params.brightness ?? 0, -100, 100, formatSignedValue(params.brightness ?? 0))}
      ${renderRangeField("Contrast", "contrast", params.contrast ?? 100, 0, 200, `${params.contrast ?? 100}%`)}
      ${renderRangeField("Saturation", "saturation", params.saturation ?? 100, 0, 200, `${params.saturation ?? 100}%`)}
      ${renderRangeField("Gamma", "gamma", params.gamma ?? 100, 10, 400, `${((params.gamma ?? 100) / 100).toFixed(2)}`)}
      ${renderRangeField("Exposure", "exposure", params.exposure ?? 0, -400, 400, formatSignedStops(params.exposure ?? 0))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">HSV</header>
      ${renderRangeField("Hue", "hue", params.hue ?? 0, -180, 180, `${params.hue ?? 0}°`)}
      ${renderRangeField("Saturation", "hsvSaturation", params.hsvSaturation ?? 100, 0, 400, `${params.hsvSaturation ?? 100}%`)}
      ${renderRangeField("Value", "value", params.value ?? 100, 0, 400, `${params.value ?? 100}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Conversion</header>
      ${renderSelectField("Black & White", "bwMode", bwMode, [
        ["off", "Off"],
        ["bt709", "Bt.709 (HD)"],
        ["bt601", "Bt.601 (SD)"],
        ["average", "Average"],
      ])}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Invert Channels", "invertChannels", invertChannels, [
        ["rgb", "RGB"],
        ["r", "Red only"],
        ["g", "Green only"],
        ["b", "Blue only"],
        ["rg", "Red + Green"],
        ["gb", "Green + Blue"],
        ["rb", "Red + Blue"],
      ])}
    </section>
  `;
}

function renderAdjustNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Brightness", "brightness", params.brightness, -100, 100, formatSignedValue(params.brightness))}
      ${renderRangeField("Contrast", "contrast", params.contrast, 0, 200, `${params.contrast}%`)}
      ${renderRangeField("Saturation", "saturation", params.saturation, 0, 200, `${params.saturation}%`)}
      ${renderRangeField("Gamma", "gamma", params.gamma, 10, 400, `${(params.gamma / 100).toFixed(2)}`)}
      ${renderRangeField("Exposure", "exposure", params.exposure, -400, 400, formatSignedStops(params.exposure))}
    </section>
  `;
}

function renderDitherNode(node) {
  const params = node.params;
  const paletteId = params.palette ?? "monochrome";
  return `
    <section class="node-panel-section">
      ${renderSelectFieldGrouped("Algorithm", "algorithm", params.algorithm, getAlgorithmOptions())}
      ${renderSelectFieldGrouped("Palette", "palette", paletteId, getPaletteOptionsGrouped())}
      ${renderRangeField("Threshold", "threshold", params.threshold, 0, 255, String(params.threshold))}
      ${renderCheckboxField("Invert", "invert", params.invert)}
      ${renderRangeField("Scale", "scale", params.scale, 10, 100, `${params.scale}%`)}
      ${renderRangeField("Blur Radius", "blurRadius", params.blurRadius, 0, 20, `${params.blurRadius}px`)}
      ${renderRangeField(
        "Error Strength",
        "errorStrength",
        params.errorStrength,
        0,
        100,
        `${params.errorStrength}%`
      )}
      ${renderCheckboxField("Serpentine", "serpentine", params.serpentine)}
    </section>
    ${renderPaletteManager(paletteId)}
  `;
}

function renderPatternDitherNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 100);
  const pattern = String(params.pattern ?? "bayer-4x4");
  const scale = Number(params.scale ?? 1);
  const strength = Number(params.strength ?? 100);
  const depth = Number(params.depth ?? 4);
  const gamma = String(params.gamma ?? "srgb");
  const colorCount = 2 ** Math.round(depth);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Pattern</header>
      ${renderSelectField("Type", "pattern", pattern, [
        ["none", "None"],
        ["bayer-2x2", "Bayer 2x2"],
        ["bayer-4x4", "Bayer 4x4"],
        ["bayer-8x8", "Bayer 8x8"],
        ["blue-noise", "Blue Noise"],
        ["white-noise", "White Noise"],
      ])}
      ${renderRangeField("Cell Scale", "scale", scale, 1, 8, `${scale}px`)}
      ${renderRangeField("Strength", "strength", strength, 0, 200, `${strength}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Quantization</header>
      ${renderRangeField("Color Depth", "depth", depth, 1, 8, `${depth}-bit · ${colorCount}/ch`)}
      ${renderSelectField("Gamma", "gamma", gamma, [
        ["linear", "Linear"],
        ["srgb", "sRGB-aware"],
      ])}
    </section>
  `;
}

function renderPaletteManager(selectedId) {
  const palette = getPalette(selectedId);
  if (!palette) return "";
  const isCustom = !isBuiltInPalette(palette.id);
  return `
    <section class="node-panel-section palette-manager">
      <header class="palette-manager__header">
        <h4>Palette Manager</h4>
        <div class="palette-manager__actions">
          <button type="button" data-palette-action="new">New</button>
          <button type="button" data-palette-action="duplicate">Duplicate</button>
          ${
            isCustom
              ? `<button type="button" data-palette-action="delete" class="palette-manager__danger">Delete</button>`
              : ""
          }
        </div>
      </header>
      ${renderPaletteManagerBody(palette, isCustom)}
    </section>
  `;
}

function renderPaletteManagerBody(palette, isCustom) {
  const extractButtonLabel = isCustom ? "Extract" : "Extract to New";
  if (!isCustom) {
    return `
      ${renderPaletteExtractionControls(extractButtonLabel)}
      <p class="hint">Built-in palette · ${palette.colors.length} colors · duplicate to edit.</p>
      <div class="palette-manager__swatches palette-manager__swatches--readonly">
        ${palette.colors
          .map(
            (c) => `<span class="palette-manager__swatch-chip" style="background:${rgbToCss(c)}"></span>`
          )
          .join("")}
      </div>
    `;
  }
  const swatches = palette.colors
    .map((color, index) =>
      renderPaletteSwatch(color, index, palette.id, palette.colors.length)
    )
    .join("");
  return `
    ${renderPaletteExtractionControls(extractButtonLabel)}
    <div class="field">
      <label>Name</label>
      <input
        type="text"
        class="palette-manager__name"
        data-palette-action="rename"
        value="${escapeHtml(palette.name)}"
      />
    </div>
    <div class="palette-manager__swatches">
      ${swatches}
      <button
        type="button"
        data-palette-action="add-swatch"
        class="palette-manager__add"
        aria-label="Add swatch"
      >+</button>
    </div>
    <p class="hint">${palette.colors.length} color${palette.colors.length === 1 ? "" : "s"}</p>
  `;
}

function renderPaletteExtractionControls(buttonLabel) {
  return `
    <div class="field">
      <label>Extract From Current Frame</label>
      <div class="palette-manager__extract-controls">
        <div class="dropdown palette-manager__extract-size">
          <select data-palette-action="extract-size">
            ${PALETTE_EXTRACTION_SIZES
              .map(
                (size) => `
                  <option value="${size}" ${size === paletteExtractionSize ? "selected" : ""}>${size} colors</option>
                `
              )
              .join("")}
          </select>
        </div>
        <button type="button" data-palette-action="extract">${buttonLabel}</button>
      </div>
      <p class="hint">Uses the current source frame. Locked swatches stay fixed during re-extract.</p>
    </div>
  `;
}

function renderPaletteSwatch(color, index, paletteId, total) {
  const hex = rgbToHex(color);
  const canRemove = total > 1;
  const locked = isSwatchLocked(paletteId, index, total);
  return `
    <div class="palette-manager__swatch">
      <input
        type="color"
        value="${hex}"
        data-palette-action="edit-swatch"
        data-swatch-index="${index}"
        aria-label="Swatch ${index + 1}"
      />
      <button
        type="button"
        class="palette-manager__swatch-lock${locked ? " is-locked" : ""}"
        data-palette-action="toggle-lock"
        data-swatch-index="${index}"
        aria-label="${locked ? "Unlock" : "Lock"} swatch ${index + 1}"
        title="${locked ? "Unlock" : "Lock"} swatch"
      >L</button>
      ${
        canRemove
          ? `<button type="button" class="palette-manager__swatch-remove" data-palette-action="remove-swatch" data-swatch-index="${index}" aria-label="Remove swatch">×</button>`
          : ""
      }
    </div>
  `;
}

function renderBlurNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Radius", "radius", params.radius, 0, 40, `${params.radius}px`)}
    </section>
  `;
}

function renderPosterizeNode(node) {
  const params = node.params;
  const steps = Number(params.steps ?? 8);
  const stepsG = Number(params.stepsG ?? 0);
  const stepsB = Number(params.stepsB ?? 0);
  const gamma = String(params.gamma ?? "linear");
  const lumaMode = String(params.lumaMode ?? "rgb");
  const opacity = Number(params.opacity ?? 100);
  // 0-step labels surface the "link to R" sentinel so the slider's intent
  // is obvious without a separate toggle.
  const gLabel = stepsG > 0 ? `${stepsG}` : `link (${steps})`;
  const bLabel = stepsB > 0 ? `${stepsB}` : `link (${steps})`;
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Steps</header>
      ${renderRangeField("R", "steps", steps, 2, 64, `${steps}`)}
      ${renderRangeField("G", "stepsG", stepsG, 0, 64, gLabel)}
      ${renderRangeField("B", "stepsB", stepsB, 0, 64, bLabel)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mode</header>
      ${renderSelectField("Color Mode", "lumaMode", lumaMode, [
        ["rgb", "RGB Independent"],
        ["luma", "Luma + Chroma"],
      ])}
      ${renderSelectField("Gamma", "gamma", gamma, [
        ["linear", "Linear"],
        ["srgb", "sRGB-aware"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

function renderInvertNode(node) {
  const params = node.params;
  const channels = String(params.channels ?? "rgb").toLowerCase();
  const options = [
    ["rgb", "RGB"],
    ["r", "Red only"],
    ["g", "Green only"],
    ["b", "Blue only"],
    ["rg", "Red + Green"],
    ["gb", "Green + Blue"],
    ["rb", "Red + Blue"],
  ];
  return `
    <section class="node-panel-section">
      ${renderSelectField("Channels", "channels", channels, options)}
    </section>
  `;
}

function renderRgbToBwNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "bt709");
  const options = [
    ["bt709", "Bt.709 (HD)"],
    ["bt601", "Bt.601 (SD)"],
    ["average", "Average"],
  ];
  return `
    <section class="node-panel-section">
      ${renderSelectField("Coefficients", "mode", mode, options)}
    </section>
  `;
}

function renderToneMapNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Intensity", "intensity", params.intensity, 10, 1000, `${(params.intensity / 100).toFixed(2)}x`)}
      ${renderRangeField("Whitepoint", "whitepoint", params.whitepoint, 10, 1000, `${(params.whitepoint / 100).toFixed(2)}`)}
    </section>
  `;
}

function renderHsvNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Hue", "hue", params.hue, -180, 180, `${params.hue}°`)}
      ${renderRangeField("Saturation", "saturation", params.saturation, 0, 400, `${params.saturation}%`)}
      ${renderRangeField("Value", "value", params.value, 0, 400, `${params.value}%`)}
    </section>
  `;
}

function renderRgbCurvesNode(node) {
  const params = node.params;
  const active = String(params.activeChannel ?? "master");
  const prefix = active === "red" || active === "green" || active === "blue" ? active : "master";
  const points = readCurvePoints(node, prefix);
  return `
    <section class="node-panel-section curves-panel">
      ${renderSelectField("Channel", "activeChannel", prefix, [
        ["master", "Master"],
        ["red", "Red"],
        ["green", "Green"],
        ["blue", "Blue"],
      ])}
      <div class="curves-editor">
        ${renderCurveCanvas(points, prefix)}
      </div>
      <div class="curves-actions">
        <button type="button" data-curve-action="reset">Reset Curve</button>
      </div>
      <p class="hint">Click curve to add a point. Drag points to remap tones. Right-click a point to delete.</p>
    </section>
  `;
}

function readCurvePoints(node, channel) {
  const key = `points_${channel}`;
  const raw = node?.params?.[key];
  if (Array.isArray(raw) && raw.length >= 2) return raw;
  const low = Number(node?.params?.[`${channel}Low`] ?? 0);
  const mid = Number(node?.params?.[`${channel}Mid`] ?? 128);
  const high = Number(node?.params?.[`${channel}High`] ?? 255);
  return [
    { x: 0, y: clamp(Math.round(low), 0, 255) },
    { x: 128, y: clamp(Math.round(mid), 0, 255) },
    { x: 255, y: clamp(Math.round(high), 0, 255) },
  ];
}

function renderCurveCanvas(points, channel) {
  const size = 240;
  const stroke = curveStrokeColor(channel);
  const polyline = buildCurvePolyline(points, size);
  const handles = points
    .map(
      (point, index) => `
        <circle
          class="curve-handle"
          data-curve-handle="${index}"
          cx="${(Number(point.x) / 255) * size}"
          cy="${size - (Number(point.y) / 255) * size}"
          r="6"
        />
      `
    )
    .join("");
  return `
    <svg class="curves-svg" viewBox="0 0 ${size} ${size}" data-curve-svg preserveAspectRatio="none">
      <defs>
        <pattern id="curveGrid-${escapeHtml(channel)}" width="${size / 4}" height="${size / 4}" patternUnits="userSpaceOnUse">
          <path d="M ${size / 4} 0 L 0 0 0 ${size / 4}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="${size}" height="${size}" fill="rgba(0,0,0,0.34)"/>
      <rect width="${size}" height="${size}" fill="url(#curveGrid-${escapeHtml(channel)})"/>
      <line x1="0" y1="${size}" x2="${size}" y2="0" stroke="rgba(255,255,255,0.1)" stroke-dasharray="3 4"/>
      <polyline points="${polyline}" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linejoin="round"/>
      ${handles}
    </svg>
  `;
}

function curveStrokeColor(channel) {
  switch (channel) {
    case "red":
      return "#ff5b5b";
    case "green":
      return "#69d27a";
    case "blue":
      return "#6aa6ff";
    case "master":
    default:
      return "#e5e7eb";
  }
}

function buildCurvePolyline(rawPoints, size) {
  const lut = buildCurveLutLocal(rawPoints);
  const out = [];
  for (let x = 0; x <= 255; x += 4) {
    const y = lut[x];
    out.push(`${(x / 255) * size},${size - (y / 255) * size}`);
  }
  out.push(`${size},${size - (lut[255] / 255) * size}`);
  return out.join(" ");
}

function buildCurveLutLocal(rawPoints) {
  const points = normalizeCurvePoints(rawPoints);
  const lut = new Array(256);
  if (points.length < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  for (let x = 0; x < 256; x++) {
    if (x <= points[0].x) {
      lut[x] = points[0].y;
      continue;
    }
    if (x >= points[points.length - 1].x) {
      lut[x] = points[points.length - 1].y;
      continue;
    }
    let index = 0;
    while (index < points.length - 1 && x > points[index + 1].x) index++;
    const a = points[index];
    const b = points[index + 1];
    const t = (x - a.x) / Math.max(1, b.x - a.x);
    const smooth = t * t * (3 - 2 * t);
    lut[x] = clamp(Math.round(a.y + (b.y - a.y) * smooth), 0, 255);
  }
  return lut;
}

function normalizeCurvePoints(rawPoints) {
  return (Array.isArray(rawPoints) ? rawPoints : [])
    .map((point) => ({
      x: clamp(Math.round(Number(point?.x)), 0, 255),
      y: clamp(Math.round(Number(point?.y)), 0, 255),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
}

function handleCurveClick(_action) {
  const node = getSelectedNode();
  if (!node || node.type !== "rgb-curves") return;
  const channel = normalizeCurveChannel(node.params?.activeChannel);
  updateNodeParams(node.id, {
    [`points_${channel}`]: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  });
  renderInspector();
}

function onInspectorPointerDown(event) {
  const svg = event.target.closest("[data-curve-svg]");
  if (!svg) return;
  const node = getSelectedNode();
  if (!node || node.type !== "rgb-curves") return;
  event.preventDefault();

  const handle = event.target.closest("[data-curve-handle]");
  const channel = normalizeCurveChannel(node.params?.activeChannel);
  const key = `points_${channel}`;
  const rect = svg.getBoundingClientRect();
  const toCurve = (clientX, clientY) => {
    const u = clamp((clientX - rect.left) / rect.width, 0, 1);
    const v = clamp((clientY - rect.top) / rect.height, 0, 1);
    return {
      x: clamp(Math.round(u * 255), 0, 255),
      y: clamp(Math.round((1 - v) * 255), 0, 255),
    };
  };

  let points = normalizeCurvePoints(readCurvePoints(node, channel));
  let activeIndex;
  if (handle) {
    activeIndex = Number(handle.dataset.curveHandle);
  } else {
    const cursor = toCurve(event.clientX, event.clientY);
    points.push(cursor);
    points.sort((a, b) => a.x - b.x);
    updateNodeParams(node.id, { [key]: points });
    renderInspector();
    return;
  }

  inspectorEditing = true;
  try {
    svg.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    const selected = getSelectedNode() ?? node;
    const updated = normalizeCurvePoints(readCurvePoints(selected, channel));
    if (activeIndex < 0 || activeIndex >= updated.length) return;

    const next = toCurve(ev.clientX, ev.clientY);
    const isFirst = activeIndex === 0;
    const isLast = activeIndex === updated.length - 1;
    if (isFirst) next.x = 0;
    if (isLast) next.x = 255;
    if (!isFirst && !isLast) {
      next.x = clamp(next.x, updated[activeIndex - 1].x + 1, updated[activeIndex + 1].x - 1);
    }
    updated[activeIndex] = next;
    updateNodeParams(node.id, { [key]: updated });
    renderInspector();
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    inspectorEditing = false;
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {}
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function onInspectorContextMenu(event) {
  const handle = event.target.closest("[data-curve-handle]");
  if (!handle) return;
  const node = getSelectedNode();
  if (!node || node.type !== "rgb-curves") return;
  event.preventDefault();

  const channel = normalizeCurveChannel(node.params?.activeChannel);
  const key = `points_${channel}`;
  const points = normalizeCurvePoints(readCurvePoints(node, channel));
  const index = Number(handle.dataset.curveHandle);
  if (!Number.isFinite(index) || index <= 0 || index >= points.length - 1) return;
  points.splice(index, 1);
  updateNodeParams(node.id, { [key]: points });
  renderInspector();
}

function normalizeCurveChannel(value) {
  return ["master", "red", "green", "blue"].includes(value) ? value : "master";
}

function renderPixelateNode(node) {
  const params = node.params;
  const size = Number(params.size ?? 8);
  const sizeY = Number(params.sizeY ?? 0);
  const shape = String(params.shape ?? "square");
  const smoothing = Number(params.smoothing ?? 0);
  const gridOpacity = Number(params.gridOpacity ?? 0);
  const opacity = Number(params.opacity ?? 100);
  const sizeYLabel = sizeY > 0 ? `${sizeY}px` : `link (${size}px)`;
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Cell</header>
      ${renderRangeField("Block X", "size", size, 1, 64, `${size}px`)}
      ${renderRangeField("Block Y", "sizeY", sizeY, 0, 64, sizeYLabel)}
      ${renderSelectField("Shape", "shape", shape, [
        ["square", "Square"],
        ["circle", "Circle"],
      ])}
      ${renderRangeField("Smoothing", "smoothing", smoothing, 0, 100, `${smoothing}%`)}
      ${renderRangeField("Grid Opacity", "gridOpacity", gridOpacity, 0, 100, `${gridOpacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

function renderThresholdNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const threshold = Number(params.threshold ?? 50);
  const softness = Number(params.softness ?? 0);
  const channel = String(params.channel ?? "luma");
  const invert = String(params.invert ?? "off");
  const mode = String(params.mode ?? "bw");
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Threshold</header>
      ${renderRangeField("Cutoff", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Softness", "softness", softness, 0, 50, `${softness}%`)}
      ${renderSelectField("Channel", "channel", channel, [
        ["luma", "Luma"],
        ["r", "Red"],
        ["g", "Green"],
        ["b", "Blue"],
        ["max", "Max RGB"],
      ])}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Output", "mode", mode, [
        ["bw", "Black / White"],
        ["source", "Source Mask"],
      ])}
    </section>
  `;
}

function renderMaskCombineNode(node) {
  const params = node.params;
  const operation = String(params.operation ?? "intersect");
  const invertA = String(params.invertA ?? "off");
  const invertB = String(params.invertB ?? "off");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Combine</header>
      ${renderSelectField("Operation", "operation", operation, [
        ["intersect", "Intersect (A AND B)"],
        ["union", "Union (A OR B)"],
        ["difference", "Difference (A XOR B)"],
        ["subtract", "Subtract (A minus B)"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Inputs</header>
      ${renderSelectField("Invert A", "invertA", invertA, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Invert B", "invertB", invertB, [
        ["off", "Off"],
        ["on", "On"],
      ])}
    </section>
  `;
}

function renderMaskApplyNode(node) {
  const params = node.params;
  const invert = String(params.invert ?? "off");
  const feather = Number(params.feather ?? 0);
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Apply</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Feather", "feather", feather, 0, 50, `${feather}px`)}
      ${renderSelectField("Invert Mask", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      <p class="hint">Wire any image into the Mask input — its luminance gates the main image.</p>
    </section>
  `;
}

function renderScaleNode(node) {
  const params = node.params;
  const filter = params.filter ?? "linear";
  return `
    <section class="node-panel-section">
      ${renderRangeField("Width", "x", params.x, 10, 400, `${params.x}%`)}
      ${renderRangeField("Height", "y", params.y, 10, 400, `${params.y}%`)}
      ${renderSelectField("Filter", "filter", filter, [
        ["linear", "Linear (smooth)"],
        ["nearest", "Nearest (pixelated)"],
      ])}
    </section>
  `;
}

function renderTransformNode(node) {
  const params = node.params;
  const filter = params.filter ?? "linear";
  const x = Number(params.x ?? params.scale ?? 100);
  const y = Number(params.y ?? params.scale ?? 100);
  const cropMode = String(params.cropMode ?? params.mode ?? "mask");
  const left = Number(params.left ?? 0);
  const right = Number(params.right ?? 0);
  const top = Number(params.top ?? 0);
  const bottom = Number(params.bottom ?? 0);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Position</header>
      ${renderRangeField("Translate X", "translateX", params.translateX, -100, 100, `${params.translateX}%`)}
      ${renderRangeField("Translate Y", "translateY", params.translateY, -100, 100, `${params.translateY}%`)}
      ${renderRangeField("Rotation", "rotation", params.rotation, -180, 180, `${params.rotation}°`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Scale</header>
      ${renderRangeField("Width", "x", x, 10, 400, `${x}%`)}
      ${renderRangeField("Height", "y", y, 10, 400, `${y}%`)}
      ${renderSelectField("Filter", "filter", filter, [
        ["linear", "Linear (smooth)"],
        ["nearest", "Nearest (pixelated)"],
      ])}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Flip</header>
      ${renderCheckboxField("Horizontal", "horizontal", params.horizontal)}
      ${renderCheckboxField("Vertical", "vertical", params.vertical)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Crop</header>
      ${renderSelectField("Mode", "cropMode", cropMode, [
        ["mask", "Mask outside crop"],
        ["fit", "Fit crop to frame"],
      ])}
      ${renderRangeField("Left", "left", left, 0, 95, `${left}%`)}
      ${renderRangeField("Right", "right", right, 0, 95, `${right}%`)}
      ${renderRangeField("Top", "top", top, 0, 95, `${top}%`)}
      ${renderRangeField("Bottom", "bottom", bottom, 0, 95, `${bottom}%`)}
    </section>
  `;
}

function renderCropNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "mask");
  return `
    <section class="node-panel-section">
      ${renderSelectField("Mode", "mode", mode, [
        ["mask", "Mask outside crop"],
        ["fit", "Fit crop to frame"],
      ])}
      ${renderRangeField("Left", "left", params.left, 0, 95, `${params.left}%`)}
      ${renderRangeField("Right", "right", params.right, 0, 95, `${params.right}%`)}
      ${renderRangeField("Top", "top", params.top, 0, 95, `${params.top}%`)}
      ${renderRangeField("Bottom", "bottom", params.bottom, 0, 95, `${params.bottom}%`)}
    </section>
  `;
}

function renderFlipNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderCheckboxField("Horizontal", "horizontal", params.horizontal)}
      ${renderCheckboxField("Vertical", "vertical", params.vertical)}
    </section>
  `;
}

function renderGlareNode(node) {
  const params = node.params;
  const type = String(params.type ?? "bloom-gpu");
  // Glow merges the old Bloom node into Glare: bloom-gpu is the fast modern
  // single-pass path, the rest are the legacy CPU types kept for back-compat.
  const typeOptions = [
    ["bloom-gpu", "Bloom (GPU, fast)"],
    ["streaks", "Streaks (CPU)"],
    ["bloom", "Bloom (CPU, legacy)"],
    ["fog-glow", "Fog Glow (CPU)"],
  ];
  const blend = String(params.blend ?? "screen");
  const blendOptions = [
    ["screen", "Screen (default)"],
    ["add", "Add (lighter)"],
    ["lighten", "Lighten"],
    ["overlay", "Overlay"],
  ];

  // Common knobs first so the most-tweaked sliders sit at the top, then
  // per-type extras, then tint at the bottom (most users keep tint at zero).
  // bloom-gpu skips Blend / saturation sat range parity since it composites
  // additively inside the shader; the rest of the types still expose Blend.
  const isGpu = type === "bloom-gpu";
  const common = `
    ${renderSelectField("Type", "type", type, typeOptions)}
    ${isGpu ? "" : renderSelectField("Blend", "blend", blend, blendOptions)}
    ${renderRangeField("Threshold", "threshold", params.threshold, 0, 255, String(params.threshold))}
    ${renderRangeField("Mix", "mix", params.mix, 0, 400, `${params.mix}%`)}
    ${renderRangeField("Saturation", "saturation", params.saturation, 0, 400, `${(params.saturation / 100).toFixed(2)}x`)}
  `;

  let typeFields = "";
  if (type === "bloom-gpu") {
    const knee = Number(params.knee ?? 20);
    typeFields = `
      ${renderRangeField("Size", "size", params.size, 1, 80, `${params.size}px`)}
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
    `;
  } else if (type === "streaks") {
    typeFields = `
      ${renderRangeField("Streaks", "streaks", params.streaks, 1, 16, String(params.streaks))}
      ${renderRangeField("Angle", "angle", params.angle, 0, 180, `${params.angle}°`)}
      ${renderRangeField("Reach", "iterations", params.iterations, 1, 8, `${Math.pow(2, params.iterations)}px`)}
      ${renderRangeField("Fade", "fade", params.fade, 0, 99, `${params.fade}%`)}
    `;
  } else {
    typeFields = `
      ${renderRangeField("Size", "size", params.size, 1, 80, `${params.size}px`)}
      ${renderRangeField("Quality", "quality", params.quality, 1, 4, `${params.quality} octave${params.quality === 1 ? "" : "s"}`)}
    `;
  }

  // Tint params are CPU-only — the GPU bloom path doesn't sample per-pixel
  // hue, so hiding them avoids a slider that does nothing.
  const tintFields = isGpu
    ? ""
    : `
      ${renderRangeField("Tint Amount", "tintAmount", params.tintAmount, 0, 100, `${params.tintAmount}%`)}
      ${renderRangeField("Tint Hue", "tintHue", params.tintHue, 0, 360, `${params.tintHue}°`)}
    `;

  return `
    <section class="node-panel-section">
      ${common}
      ${typeFields}
      ${tintFields}
    </section>
  `;
}

function renderLensDistortNode(node) {
  const params = node.params;
  const type = String(params.type ?? "radial");
  const distortLabel =
    params.distortion === 0
      ? "0 (none)"
      : params.distortion > 0
        ? `${params.distortion}% barrel`
        : `${Math.abs(params.distortion)}% pincushion`;
  const radialFields =
    type === "radial"
      ? `
        ${renderRangeField("Distortion", "distortion", params.distortion, -100, 100, distortLabel)}
        ${renderCheckboxField("Fit to frame", "fit", params.fit)}
      `
      : "";
  return `
    <section class="node-panel-section">
      ${renderSelectField("Type", "type", type, [
        ["radial", "Radial (barrel / pincushion)"],
        ["horizontal", "Horizontal (chromatic shift)"],
      ])}
      ${radialFields}
      ${renderRangeField("Dispersion", "dispersion", params.dispersion, 0, 100, `${params.dispersion}%`)}
      ${renderRangeField("Center X", "centerX", params.centerX, 0, 100, `${params.centerX}%`)}
      ${renderRangeField("Center Y", "centerY", params.centerY, 0, 100, `${params.centerY}%`)}
      ${renderRangeField("Vignette", "vignette", params.vignette, 0, 100, `${params.vignette}%`)}
    </section>
  `;
}

function renderDisplaceNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "wave");
  const filter = params.filter ?? "linear";
  const waveFields = mode === "wave"
    ? `
      ${renderRangeField("Frequency", "frequency", params.frequency, 1, 32, `${params.frequency}x`)}
      ${renderRangeField("Phase", "phase", params.phase, 0, 360, `${params.phase}°`)}
    `
    : `<p class="hint">Connect an image to the Map input. Red offsets X, green offsets Y.</p>`;
  return `
    <section class="node-panel-section">
      ${renderSelectField("Mode", "mode", mode, [
        ["wave", "Wave"],
        ["map", "Map input"],
      ])}
      ${renderRangeField("X Amount", "xAmount", params.xAmount, -200, 200, `${params.xAmount}px`)}
      ${renderRangeField("Y Amount", "yAmount", params.yAmount, -200, 200, `${params.yAmount}px`)}
      ${renderRangeField("Strength", "strength", params.strength, 0, 400, `${params.strength}%`)}
      ${waveFields}
      ${renderSelectField("Filter", "filter", filter, [
        ["linear", "Linear"],
        ["nearest", "Nearest"],
      ])}
    </section>
  `;
}

function renderChromaticAberrationNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderSelectField("Mode", "mode", params.mode, [
        ["directional", "Directional"],
        ["radial", "Radial"],
      ])}
      ${renderRangeField("Strength", "strength", params.strength, 0, 96, `${params.strength}px`)}
      ${renderRangeField("Angle", "angle", params.angle, -180, 180, `${params.angle}deg`)}
      ${renderRangeField("Center X", "centerX", params.centerX, 0, 100, `${params.centerX}%`)}
      ${renderRangeField("Center Y", "centerY", params.centerY, 0, 100, `${params.centerY}%`)}
    </section>
  `;
}

function renderAnalogNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "vhs");
  const opacity = Number(params.opacity ?? 100);
  const brightness = Number(params.brightness ?? 110);
  const saturation = Number(params.saturation ?? 110);
  const chroma = Number(params.chroma ?? 6);
  const bleed = Number(params.bleed ?? 50);
  const noise = Number(params.noise ?? 35);
  const scanlines = Number(params.scanlines ?? 60);
  const tracking = Number(params.tracking ?? 35);
  const wave = Number(params.wave ?? 4);
  const curvature = Number(params.curvature ?? 25);
  const mask = String(params.mask ?? "aperture");
  const maskStrength = Number(params.maskStrength ?? 35);
  const glow = Number(params.glow ?? 25);
  const vignette = Number(params.vignette ?? 40);
  const rolling = Number(params.rolling ?? 0);
  const showTape = mode === "vhs" || mode === "vhs-crt";
  const showTube = mode === "crt" || mode === "vhs-crt";
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["vhs", "VHS"],
        ["crt", "CRT"],
        ["vhs-crt", "VHS into CRT"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${showTube ? renderRangeField("Brightness", "brightness", brightness, 0, 300, `${brightness}%`) : ""}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    ${
      showTape
        ? `
          <section class="node-panel-section node-panel-section--titled">
            <header class="node-panel-section-title">Tape</header>
            ${renderRangeField("Chroma Shift", "chroma", chroma, 0, 32, `${chroma}px`)}
            ${renderRangeField("Color Bleed", "bleed", bleed, 0, 100, `${bleed}%`)}
            ${renderRangeField("Wave", "wave", wave, 0, 32, `${wave}px`)}
            ${renderRangeField("Tracking", "tracking", tracking, 0, 100, `${tracking}%`)}
            ${renderRangeField("Noise", "noise", noise, 0, 100, `${noise}%`)}
          </section>
        `
        : ""
    }
    ${
      showTube
        ? `
          <section class="node-panel-section node-panel-section--titled">
            <header class="node-panel-section-title">Tube</header>
            ${renderRangeField("Curvature", "curvature", curvature, 0, 100, `${curvature}%`)}
            ${renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`)}
            ${renderRangeField("Glow", "glow", glow, 0, 100, `${glow}%`)}
            ${renderSelectField("Mask", "mask", mask, [
              ["none", "None"],
              ["aperture", "Aperture Grille"],
              ["slot", "Slot Mask"],
            ])}
            ${renderRangeField("Mask Strength", "maskStrength", maskStrength, 0, 100, `${maskStrength}%`)}
            ${renderRangeField("Rolling Bar", "rolling", rolling, 0, 100, `${rolling}%`)}
          </section>
        `
        : ""
    }
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Frame</header>
      ${!showTube ? renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`) : ""}
      ${renderRangeField("Vignette", "vignette", vignette, 0, 100, `${vignette}%`)}
    </section>
  `;
}

function renderVhsNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 110);
  const chroma = Number(params.chroma ?? 6);
  const bleed = Number(params.bleed ?? 50);
  const noise = Number(params.noise ?? 35);
  const scanlines = Number(params.scanlines ?? 60);
  const tracking = Number(params.tracking ?? 35);
  const wave = Number(params.wave ?? 4);
  const vignette = Number(params.vignette ?? 40);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tape</header>
      ${renderRangeField("Chroma Shift", "chroma", chroma, 0, 32, `${chroma}px`)}
      ${renderRangeField("Color Bleed", "bleed", bleed, 0, 100, `${bleed}%`)}
      ${renderRangeField("Wave", "wave", wave, 0, 32, `${wave}px`)}
      ${renderRangeField("Tracking", "tracking", tracking, 0, 100, `${tracking}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tube</header>
      ${renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`)}
      ${renderRangeField("Noise", "noise", noise, 0, 100, `${noise}%`)}
      ${renderRangeField("Vignette", "vignette", vignette, 0, 100, `${vignette}%`)}
    </section>
  `;
}

function renderCrtNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const brightness = Number(params.brightness ?? 110);
  const saturation = Number(params.saturation ?? 110);
  const curvature = Number(params.curvature ?? 25);
  const scanlines = Number(params.scanlines ?? 60);
  const glow = Number(params.glow ?? 25);
  const mask = String(params.mask ?? "aperture");
  const maskStrength = Number(params.maskStrength ?? 35);
  const vignette = Number(params.vignette ?? 35);
  const rolling = Number(params.rolling ?? 0);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Brightness", "brightness", brightness, 0, 300, `${brightness}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tube</header>
      ${renderRangeField("Curvature", "curvature", curvature, 0, 100, `${curvature}%`)}
      ${renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`)}
      ${renderRangeField("Glow", "glow", glow, 0, 100, `${glow}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mask</header>
      ${renderSelectField("Mode", "mask", mask, [
        ["none", "None"],
        ["aperture", "Aperture Grille"],
        ["slot", "Slot Mask"],
      ])}
      ${renderRangeField("Strength", "maskStrength", maskStrength, 0, 100, `${maskStrength}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Sync</header>
      ${renderRangeField("Vignette", "vignette", vignette, 0, 100, `${vignette}%`)}
      ${renderRangeField("Rolling Bar", "rolling", rolling, 0, 100, `${rolling}%`)}
    </section>
  `;
}

function renderBloomNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 100);
  const threshold = Number(params.threshold ?? 70);
  const knee = Number(params.knee ?? 20);
  const intensity = Number(params.intensity ?? 100);
  const radius = Number(params.radius ?? 16);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Bloom</header>
      ${renderRangeField("Threshold", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
      ${renderRangeField("Intensity", "intensity", intensity, 0, 400, `${intensity}%`)}
      ${renderRangeField("Radius", "radius", radius, 0, 64, `${radius}px`)}
    </section>
  `;
}

function renderHalationNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 100);
  const threshold = Number(params.threshold ?? 70);
  const knee = Number(params.knee ?? 20);
  const intensity = Number(params.intensity ?? 120);
  const radius = Number(params.radius ?? 24);
  const tintColor = params.tintColor ?? "#ff783c";
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Halation</header>
      ${renderRangeField("Threshold", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
      ${renderRangeField("Intensity", "intensity", intensity, 0, 400, `${intensity}%`)}
      ${renderRangeField("Radius", "radius", radius, 0, 96, `${radius}px`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tint</header>
      ${renderColorField("Tint Color", "tintColor", tintColor, { fallback: "#ff783c" })}
    </section>
  `;
}

function renderAsciiNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const cellSize = Number(params.cellSize ?? 8);
  const ramp = String(params.ramp ?? "standard");
  const invert = String(params.invert ?? "off");
  const colorMode = String(params.colorMode ?? "source");
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">ASCII</header>
      ${renderRangeField("Cell Size", "cellSize", cellSize, 4, 32, `${cellSize}px`)}
      ${renderSelectField("Ramp", "ramp", ramp, [
        ["standard", "Standard"],
        ["dense", "Dense"],
        ["blocks", "Blocks"],
        ["binary", "Binary"],
      ])}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Color", "colorMode", colorMode, [
        ["source", "From Image"],
        ["mono", "Monochrome"],
      ])}
    </section>
  `;
}

function renderHalftoneNode(node) {
  const params = node.params;
  // Migrate legacy projects: the early build called this `cellSize` and
  // accepted `mode = mono | color`. Fall back so existing keyframes/saved
  // projects still render their values into the new sliders.
  const spacing = Number(params.spacing ?? params.cellSize ?? 5);
  const angle = Number(params.angle ?? 15);
  const dotScale = Number(params.dotScale ?? 100);
  const opacity = Number(params.opacity ?? 100);
  const hue = Number(params.hue ?? 0);
  const saturation = Number(params.saturation ?? 100);
  const colorMode = String(params.colorMode ?? (params.mode === "color" ? "cmy" : params.mode ?? "cmyk"));
  const shape = String(params.shape ?? "circle");

  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Hue", "hue", hue, -180, 180, `${hue}deg`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Halftone</header>
      ${renderSelectField("Color Mode", "colorMode", colorMode, [
        ["mono", "Monochrome"],
        ["cmy", "CMY"],
        ["cmyk", "CMYK"],
      ])}
      ${renderSelectField("Shape", "shape", shape, [
        ["circle", "Circle"],
        ["square", "Square"],
        ["diamond", "Diamond"],
      ])}
      ${renderRangeField("Spacing", "spacing", spacing, 2, 64, `${spacing}px`)}
      ${renderRangeField("Angle", "angle", angle, -90, 90, `${angle}deg`)}
      ${renderRangeField("Dot Scale", "dotScale", dotScale, 10, 250, `${dotScale}%`)}
    </section>
  `;
}

function renderMixNode(node) {
  const params = node.params;

  return `
    <section class="node-panel-section">
      ${renderSelectField("Mode", "mode", params.mode, [
        ["normal", "Normal"],
        ["add", "Add"],
        ["multiply", "Multiply"],
        ["screen", "Screen"],
        ["overlay", "Overlay"],
        ["difference", "Difference"],
      ])}
      ${renderRangeField("Factor", "factor", params.factor, 0, 100, `${params.factor}%`)}
    </section>
  `;
}

function renderValueNode(node) {
  const params = node.params;
  const bounds = getValueNodeOutputBounds(node.id);
  return `
    <section class="node-panel-section">
      ${renderNumberField("Value", "value", params.value, bounds)}
    </section>
  `;
}

function renderMathNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderSelectField("Operation", "operation", params.operation, [
        ["add", "Add"],
        ["subtract", "Subtract"],
        ["multiply", "Multiply"],
        ["divide", "Divide"],
        ["power", "Power"],
        ["min", "Minimum"],
        ["max", "Maximum"],
        ["modulo", "Modulo"],
      ])}
      ${renderRangeField("A", "a", params.a, -1000, 1000, String(params.a))}
      ${renderRangeField("B", "b", params.b, -1000, 1000, String(params.b))}
      ${renderCheckboxField("Clamp 0..1", "clamp", params.clamp)}
      <p class="hint">Math nodes compute scalar values; parameter wiring comes next.</p>
    </section>
  `;
}

function renderViewerOutputNode(node) {
  const { source } = getState();
  const currentFps = Math.max(
    1,
    Math.round(Number(source.loaded ? source.fps : node?.params?.fps ?? source.fps) || 30)
  );
  const sourceFps = Math.max(
    1,
    Math.round(Number(source.loaded ? source.sourceFps : node?.params?.fps ?? source.sourceFps) || 30)
  );
  const maxFps = Math.max(1, source.loaded ? sourceFps : 120);
  return `
    <section class="node-panel-section">
      ${renderRangeField("Export FPS", "viewer-fps", currentFps, 1, maxFps, formatFpsReadout(currentFps, sourceFps))}
      <p class="hint">Target frame rate for export. Lower than source drops/blends frames in the encode. Preview keeps running at the source frame rate; slow / fast motion is a separate playback control.</p>
    </section>
  `;
}

function renderEmptyInspector() {
  return `
    <section class="node-panel-section">
      <h3>No node selected</h3>
      <p class="hint">Select a node to edit its parameters.</p>
    </section>
  `;
}

function renderRangeField(label, key, value, min, max, _readout) {
  const safeKey = escapeHtml(key);
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `
    <div class="field range-field">
      <label>
        <span class="field-label-row">
          ${renderParamSocketDot(safeKey, min, max)}
          ${renderParamKeyframeButton(key)}
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
        <span class="field-suffix" data-param-readout="${safeKey}"></span>
      </label>
      <div class="range-row">
        <input
          type="range"
          min="${min}"
          max="${max}"
          value="${numericValue}"
          data-node-param="${safeKey}"
          data-input-kind="range"
        />
        <input
          type="number"
          class="num-edit"
          min="${min}"
          max="${max}"
          value="${numericValue}"
          data-node-param="${safeKey}"
          data-input-kind="number"
        />
      </div>
    </div>
  `;
}

function renderNumberField(label, key, value, bounds = null) {
  const safeKey = escapeHtml(key);
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  const minAttr = bounds && Number.isFinite(bounds.min) ? ` min="${bounds.min}"` : "";
  const maxAttr = bounds && Number.isFinite(bounds.max) ? ` max="${bounds.max}"` : "";
  return `
    <div class="field number-field">
      <label>
        <span class="field-label-row">
          ${renderParamSocketDot(safeKey, bounds?.min, bounds?.max)}
          ${renderParamKeyframeButton(key)}
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      <input
        type="number"
        class="num-edit"
        value="${numericValue}"
        data-node-param="${safeKey}"
        data-input-kind="number"
        ${minAttr}${maxAttr}
      />
    </div>
  `;
}

function renderParamKeyframeButton(paramKey) {
  const node = getSelectedNode();
  if (!node || node.type === "source" || node.type === "viewer-output") return "";
  const safeKey = escapeHtml(paramKey);
  const animated = hasTimelineTrackForParam(node.id, paramKey);
  const keyed = hasParamKeyframeAtCurrentTime(node.id, paramKey);
  return `<button
    type="button"
    class="param-keyframe-toggle${animated ? " is-animated" : ""}${keyed ? " is-keyed" : ""}"
    data-param-keyframe-toggle="${safeKey}"
    aria-label="${keyed ? "Remove keyframe" : "Set keyframe"}"
    title="${keyed ? "Remove keyframe" : "Set keyframe"}"
  ></button>`;
}

function syncTimelineButtons() {
  if (!inspectorEl) return;
  const node = getSelectedNode();
  if (!node) return;
  for (const button of inspectorEl.querySelectorAll("[data-param-keyframe-toggle]")) {
    const paramKey = button.dataset.paramKeyframeToggle;
    const animated = hasTimelineTrackForParam(node.id, paramKey);
    const keyed = hasParamKeyframeAtCurrentTime(node.id, paramKey);
    button.classList.toggle("is-animated", animated);
    button.classList.toggle("is-keyed", keyed);
    button.setAttribute("aria-label", keyed ? "Remove keyframe" : "Set keyframe");
    button.setAttribute("title", keyed ? "Remove keyframe" : "Set keyframe");
  }
}

function renderParamSocketDot(safeKey, min = null, max = null) {
  const node = getSelectedNode();
  if (!node || node.type === "source" || node.type === "viewer-output") return "";
  // If the node already has an explicit input socket with this name (e.g. math.a,
  // math.b), exposing it again as `param:a` would create a duplicate pin on the
  // canvas. The existing socket is the only way in.
  if (Array.isArray(node.inputs) && node.inputs.some((socket) => socket.name === safeKey)) {
    return `<span
      class="param-socket-toggle is-exposed is-fixed"
      aria-label="Already exposed as an input socket"
      title="Already exposed as an input socket"
    ></span>`;
  }
  const exposed = Array.isArray(node.exposedParams) && node.exposedParams.includes(safeKey);
  const minAttr = Number.isFinite(Number(min)) ? ` data-param-min="${Number(min)}"` : "";
  const maxAttr = Number.isFinite(Number(max)) ? ` data-param-max="${Number(max)}"` : "";
  return `<button
    type="button"
    class="param-socket-toggle${exposed ? " is-exposed" : ""}"
    data-param-socket-toggle="${safeKey}"
    ${minAttr}${maxAttr}
    aria-label="${exposed ? "Hide parameter socket" : "Expose parameter socket"}"
    title="${exposed ? "Remove input socket" : "Expose as input socket"}"
  ></button>`;
}

function renderSelectField(label, key, value, options) {
  return `
    <div class="field">
      <label>${escapeHtml(label)}</label>
      <div class="dropdown">
        <select data-node-param="${escapeHtml(key)}">
          ${options
            .map(
              ([optionValue, optionLabel]) => `
                <option value="${escapeHtml(optionValue)}" ${
                  optionValue === value ? "selected" : ""
                }>${escapeHtml(optionLabel)}</option>
              `
            )
            .join("")}
        </select>
      </div>
    </div>
  `;
}

function renderSelectFieldGrouped(label, key, value, groups) {
  return `
    <div class="field">
      <label>${escapeHtml(label)}</label>
      <div class="dropdown">
        <select data-node-param="${escapeHtml(key)}">
          ${groups
            .map(
              (group) => `
                <optgroup label="${escapeHtml(group.label)}">
                  ${group.options
                    .map(
                      ([optionValue, optionLabel]) => `
                        <option value="${escapeHtml(optionValue)}" ${
                          optionValue === value ? "selected" : ""
                        }>${escapeHtml(optionLabel)}</option>
                      `
                    )
                    .join("")}
                </optgroup>
              `
            )
            .join("")}
        </select>
      </div>
    </div>
  `;
}

function renderCheckboxField(label, key, checked) {
  return `
    <div class="field">
      <label class="checkbox">
        <input type="checkbox" data-node-param="${escapeHtml(key)}" ${checked ? "checked" : ""} />
        ${escapeHtml(label)}
      </label>
    </div>
  `;
}

// HEX color field — native <input type="color"> swatch + uppercase HEX
// text input. The two siblings share the same data-node-param key so the
// existing syncSiblingControls keeps them in lockstep. The text input
// commits on `change` (blur) only; mid-typing input events would normalise
// "#FF" back to "#000000" and overwrite the user's value.
function renderColorField(label, key, value, options = {}) {
  const safeKey = escapeHtml(key);
  const fallback = options.fallback ?? "#000000";
  const hex = normalizeHex(value, fallback);
  return `
    <div class="field color-field">
      <label>
        <span class="field-label-row">
          ${renderParamSocketDot(safeKey)}
          ${renderParamKeyframeButton(key)}
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      <div class="color-row">
        <input
          type="color"
          class="color-swatch"
          value="${escapeHtml(hex)}"
          data-node-param="${safeKey}"
          data-input-kind="color-swatch"
          aria-label="${escapeHtml(label)} color"
        />
        <input
          type="text"
          class="color-hex"
          value="${escapeHtml(hex)}"
          data-node-param="${safeKey}"
          data-input-kind="color-hex"
          maxlength="7"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
        />
      </div>
    </div>
  `;
}

function readControlValue(control) {
  if (control.type === "checkbox") return control.checked;
  if (control.tagName === "SELECT") return control.value;
  if (
    control.dataset.inputKind === "color-swatch" ||
    control.dataset.inputKind === "color-hex"
  ) {
    return normalizeHex(control.value, "#000000");
  }
  return Number(control.value);
}

// Slider and number input share the same data-node-param key — when one
// moves the other has to follow without going through a full re-render
// (re-render would steal focus / blow away the user's typed digits).
function syncSiblingControls(control) {
  const key = control.dataset.nodeParam;
  if (!key || !inspectorEl) return;
  const value = control.value;
  const siblings = inspectorEl.querySelectorAll(`[data-node-param="${cssEscape(key)}"]`);
  for (const el of siblings) {
    if (el === control) continue;
    if (el.value !== value) el.value = value;
  }
}

function updateInlineReadout(_control) {}

function getSocketPoint(node, kind, socketName) {
  if (kind === "input" && typeof socketName === "string" && socketName.startsWith("param:")) {
    const baseRowCount = Math.max(node.inputs.length, node.outputs.length, 1);
    const exposed = Array.isArray(node.exposedParams) ? node.exposedParams : [];
    const paramKey = socketName.slice("param:".length);
    const paramIndex = exposed.indexOf(paramKey);
    const rowIndex = baseRowCount + Math.max(0, paramIndex);
    return {
      x: toSceneX(node.x + 14),
      y: toSceneY(node.y + SOCKET_Y + rowIndex * SOCKET_STEP),
    };
  }

  const sockets = kind === "output" ? node.outputs : node.inputs;
  const index = Math.max(0, sockets.findIndex((socket) => socket.name === socketName));

  return {
    x: kind === "output" ? toSceneX(node.x + NODE_WIDTH - 14) : toSceneX(node.x + 14),
    y: toSceneY(node.y + SOCKET_Y + index * SOCKET_STEP),
  };
}

function applyGraphViewport() {
  if (!editorEl || !nodesEl || !edgesEl) return;

  const { graphView } = getState();
  const transform = `translate(${graphView.panX}px, ${graphView.panY}px) scale(${graphView.zoom})`;
  nodesEl.style.transform = transform;
  edgesEl.style.transform = transform;
  edgesEl.style.transformOrigin = "0 0";
  nodesEl.style.transformOrigin = "0 0";

  const gridSize = GRAPH_GRID_STEP * graphView.zoom;
  const offsetX = modulo(graphView.panX + GRAPH_WORLD_ORIGIN * graphView.zoom, gridSize);
  const offsetY = modulo(graphView.panY + GRAPH_WORLD_ORIGIN * graphView.zoom, gridSize);
  editorEl.style.setProperty("--graph-grid-size", String(gridSize));
  editorEl.style.setProperty("--graph-grid-offset-x", String(offsetX));
  editorEl.style.setProperty("--graph-grid-offset-y", String(offsetY));
  editorEl.style.setProperty("--graph-zoom", String(graphView.zoom));
}

function clientToWorld(clientX, clientY) {
  const { graphView } = getState();
  const local = getLocalPoint(clientX, clientY);
  return {
    x: local.x / graphView.zoom - graphView.panX / graphView.zoom - GRAPH_WORLD_ORIGIN,
    y: local.y / graphView.zoom - graphView.panY / graphView.zoom - GRAPH_WORLD_ORIGIN,
  };
}

function getViewportCenterWorld() {
  const rect = editorEl.getBoundingClientRect();
  return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function insertPaletteNodeAtDefault(type) {
  const definition = getNodeDefinition(type);
  const viewerEdgeId = getViewerInputEdgeId();
  if (definition?.chainable !== false && viewerEdgeId) {
    return insertNodeOnEdge(viewerEdgeId, type);
  }
  return createNodeFromPalette(type, getViewportCenterWorld());
}

function createNodeFromPalette(type, point) {
  if (!type || !point) return null;
  return createFreeNode(type, nodePositionFromPoint(point));
}

function nodePositionFromPoint(point) {
  return {
    x: point.x - NODE_WIDTH / 2,
    y: point.y - NODE_HEIGHT / 2,
  };
}

function getViewerInputEdgeId() {
  const { graph } = getState();
  const viewer = graph.nodes.find((node) => node.type === "viewer-output");
  const primarySocket = viewer?.inputs?.[0]?.name;
  if (!viewer || !primarySocket) return null;
  return graph.edges.find((edge) => edge.toNode === viewer.id && edge.toSocket === primarySocket)?.id ?? null;
}

function initGraphContextMenu() {
  if (graphMenuEl) return;

  graphMenuEl = document.createElement("div");
  graphMenuEl.className = "context-menu floating-card hidden";
  graphMenuEl.innerHTML = `
    <button data-add-node="posterize">Add Posterize</button>
    <button data-add-node="tone-map">Add Tone Map</button>
    <button data-add-node="rgb-curves">Add RGB Curves</button>
    <button data-add-node="blur">Add Blur</button>
    <button data-add-node="pixelate">Add Pixelate</button>
    <button data-add-node="transform">Add Transform</button>
    <button data-add-node="dither">Add Dither</button>
    <button data-add-node="pattern-dither">Add Pattern Dither</button>
    <button data-add-node="threshold">Add Threshold</button>
    <button data-add-node="mask-combine">Add Mask Combine</button>
    <button data-add-node="mask-apply">Add Mask Apply</button>
    <button data-add-node="glare">Add Bloom / Glare</button>
    <button data-add-node="analog">Add Analog</button>
    <button data-add-node="lens-distort">Add Lens Distortion</button>
    <button data-add-node="chromatic-aberration">Add Chromatic Aberration</button>
    <button data-add-node="halation">Add Halation</button>
    <button data-add-node="ascii">Add ASCII</button>
    <button data-add-node="halftone">Add Halftone</button>
    <button data-add-node="displace">Add Displace</button>
    <button data-add-node="mix">Add Mix</button>
    <button data-add-node="value">Add Value</button>
    <button data-add-node="math">Add Math</button>
  `;

  graphMenuEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-node]");
    if (!button) return;

    const type = button.dataset.addNode;
    if (graphMenuState?.edgeId) {
      const inserted = insertNodeOnEdge(graphMenuState.edgeId, type, {
        position: nodePositionFromPoint(graphMenuState.point),
      });
      if (!inserted) createNodeFromPalette(type, graphMenuState.point);
    } else {
      createNodeFromPalette(type, graphMenuState?.point ?? getViewportCenterWorld());
    }

    hideGraphContextMenu();
  });

  editorEl.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-node-id]")) return;
    event.preventDefault();
    const edge = findInsertableEdgeAt(event.clientX, event.clientY);
    graphMenuState = {
      point: clientToWorld(event.clientX, event.clientY),
      edgeId: edge?.edgeId ?? "",
    };
    setInsertHighlight(edge?.edgeId ?? "");
    graphMenuEl.style.left = `${event.clientX}px`;
    graphMenuEl.style.top = `${event.clientY}px`;
    graphMenuEl.classList.remove("hidden");
  });

  document.body.appendChild(graphMenuEl);

  document.addEventListener("click", (event) => {
    if (!graphMenuEl.classList.contains("hidden") && !graphMenuEl.contains(event.target)) {
      hideGraphContextMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideGraphContextMenu();
  });
}

function hideGraphContextMenu() {
  graphMenuEl?.classList.add("hidden");
  graphMenuState = null;
  clearInsertHighlight();
}

function maybeAutoCenterGraph() {
  if (graphAutoCentered || !editorEl) return;
  const { graph, graphView } = getState();
  if (
    graphView.zoom !== DEFAULT_GRAPH_VIEW.zoom ||
    graphView.panX !== DEFAULT_GRAPH_VIEW.panX ||
    graphView.panY !== DEFAULT_GRAPH_VIEW.panY
  ) {
    return;
  }

  const rect = editorEl.getBoundingClientRect();
  if (!rect.width || !rect.height || graph.nodes.length === 0) return;

  const bounds = graph.nodes.reduce(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      maxX: Math.max(acc.maxX, node.x + NODE_WIDTH),
      minY: Math.min(acc.minY, node.y),
      maxY: Math.max(acc.maxY, node.y + NODE_HEIGHT),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );

  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const fitZoom = Math.min(
    (rect.width - GRAPH_VIEW_PADDING * 2) / contentWidth,
    (rect.height - GRAPH_VIEW_PADDING * 2) / contentHeight
  );
  const zoom = clamp(Math.min(0.92, fitZoom), 0.45, 1.2);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  graphAutoCentered = true;
  dispatch("graphView", {
    zoom,
    panX: rect.width / 2 - toSceneX(centerX) * zoom,
    panY: rect.height / 2 - toSceneY(centerY) * zoom,
  });
}

function resolvePaletteNodeType(dataTransfer) {
  const customType = dataTransfer?.getData?.("application/x-node-type");
  if (customType) return customType;

  const textType = dataTransfer?.getData?.("text/plain");
  if (typeof textType === "string" && textType.startsWith("ditherlab-node:")) {
    return textType.slice("ditherlab-node:".length);
  }

  return draggedPaletteType || "";
}

function isPointOverEditor(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return Boolean(target?.closest?.("#nodeEditor"));
}

function isPointOverStage(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return Boolean(target?.closest?.("#stage"));
}

function clientToScene(clientX, clientY) {
  const point = clientToWorld(clientX, clientY);
  return {
    x: toSceneX(point.x),
    y: toSceneY(point.y),
  };
}

function getLocalPoint(clientX, clientY) {
  const rect = editorEl.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function toSceneX(worldX) {
  return GRAPH_WORLD_ORIGIN + worldX;
}

function toSceneY(worldY) {
  return GRAPH_WORLD_ORIGIN + worldY;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function modulo(value, divisor) {
  if (!divisor) return 0;
  return ((value % divisor) + divisor) % divisor;
}

function formatSignedValue(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function formatSignedStops(value) {
  const stops = (value / 100).toFixed(2);
  return value > 0 ? `+${stops}` : stops;
}

function formatFpsReadout(value, sourceFps) {
  const numeric = Math.max(1, Math.round(Number(value) || 0));
  const sourceNumeric = Math.max(1, Math.round(Number(sourceFps) || 0));
  return numeric === sourceNumeric ? `Source (${sourceNumeric})` : String(numeric);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
