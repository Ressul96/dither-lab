import { DEFAULT_GRAPH_VIEW, dispatch, getState, subscribe } from "../state.js";
import {
  addEdge,
  createFreeNode,
  ensureBootGraph,
  getNodeById,
  getNodeDefinition,
  getSelectedNode,
  insertNodeOnEdge,
  mutateNodePosition,
  removeNode,
  replacePaletteUsages,
  selectNode,
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

let nodesEl;
let edgesEl;
let editorEl;
let inspectorEl;
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
  stageEl = document.getElementById("stage");

  if (!nodesEl || !edgesEl || !editorEl || !inspectorEl) return;

  nodesEl.addEventListener("click", onNodeClick);
  nodesEl.addEventListener("pointerdown", onGraphPointerDown);
  inspectorEl.addEventListener("input", onInspectorInput);
  inspectorEl.addEventListener("change", onInspectorChange);
  inspectorEl.addEventListener("click", onInspectorClick);
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
      insertNodeOnEdge(edge.edgeId, type, {
        position: clientToWorld(e.clientX, e.clientY),
      });
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
        insertNodeOnEdge(edge.edgeId, type, {
          position: clientToWorld(ev.clientX, ev.clientY),
        });
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
    startEditorPan(e);
  });
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
    scheduleEdgeRender();
  };

  const onUp = () => {
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
      selectNode(nodeId);
    } else {
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
  const node = event.target.closest("[data-node-id]");
  if (!node) return;
  selectNode(node.dataset.nodeId);
}

function onInspectorInput(event) {
  const control = event.target.closest("[data-node-param]");
  if (control) {
    const node = getSelectedNode();
    if (!node) return;

    inspectorEditing = true;
    if (node.type === "viewer-output" && control.dataset.nodeParam === "viewer-fps") {
      setFps(readControlValue(control));
      updateInlineReadout(control);
      syncSiblingControls(control);
      return;
    }

    const nodeId = node.id;
    updateNodeParams(nodeId, {
      [control.dataset.nodeParam]: readControlValue(control),
    });
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
    renderInspector();
    return;
  }

  const paletteControl = event.target.closest("[data-palette-action]");
  if (paletteControl) {
    handlePaletteChange(paletteControl);
  }
}

function onInspectorClick(event) {
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

  return `
    <button
      class="graph-node${selected}"
      type="button"
      draggable="false"
      data-node-id="${escapeHtml(node.id)}"
      style="left:${toSceneX(node.x)}px;top:${toSceneY(node.y)}px"
      title="${escapeHtml(node.id)}"
    >
      <div class="graph-node-head">
        <span class="graph-node-title">${escapeHtml(node.label)}</span>
        <span class="graph-node-family">${escapeHtml(definition?.family ?? "Node")}</span>
      </div>
      <div class="graph-node-rows">
        ${renderSocketRows(node)}
      </div>
    </button>
  `;
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
    ><span class="graph-socket-dot"></span></span>
  `;
  const label = `<span class="graph-socket-label">${escapeHtml(socket.label)}</span>`;

  return `
    <span class="graph-socket graph-socket--${kind}">
      ${kind === "input" ? `${hit}${label}` : `${label}${hit}`}
    </span>
  `;
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
    inspectorEl.innerHTML = renderEmptyInspector();
    return;
  }

  const definition = getNodeDefinition(node.type);

  inspectorEl.innerHTML = `
    <section class="node-panel-section">
      <p class="eyebrow">Selected Node</p>
      <h3>${escapeHtml(node.label)}</h3>
      <p class="hint">${escapeHtml(definition?.family ?? "Node")}</p>
    </section>

    ${renderNodeSpecifics(node)}
  `;
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
    case "blur":
      return renderBlurNode(node);
    case "pixelate":
      return renderPixelateNode(node);
    case "scale":
      return renderScaleNode(node);
    case "dither":
      return renderDitherNode(node);
    case "glare":
      return renderGlareNode(node);
    case "lens-distort":
      return renderLensDistortNode(node);
    case "mix":
      return renderMixNode(node);
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
  return `
    <section class="node-panel-section">
      <p class="hint">Source node has no editable parameters yet.</p>
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
  return `
    <section class="node-panel-section">
      ${renderRangeField("Steps", "steps", params.steps, 2, 64, `${params.steps}`)}
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

function renderPixelateNode(node) {
  const params = node.params;
  return `
    <section class="node-panel-section">
      ${renderRangeField("Block size", "size", params.size, 1, 64, `${params.size}px`)}
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

function renderGlareNode(node) {
  const params = node.params;
  const type = String(params.type ?? "streaks");
  const typeOptions = [
    ["streaks", "Streaks"],
    ["bloom", "Bloom"],
    ["fog-glow", "Fog Glow"],
  ];
  const blend = String(params.blend ?? "screen");
  const blendOptions = [
    ["screen", "Screen (default)"],
    ["add", "Add (lighter)"],
    ["lighten", "Lighten"],
    ["overlay", "Overlay"],
  ];

  // Common knobs first so the most-tweaked sliders sit at the top, then
  // per-type extras (streaks vs bloom/fog have different shapes), then
  // tint at the bottom — most users keep tint at zero.
  const common = `
    ${renderSelectField("Type", "type", type, typeOptions)}
    ${renderSelectField("Blend", "blend", blend, blendOptions)}
    ${renderRangeField("Threshold", "threshold", params.threshold, 0, 255, String(params.threshold))}
    ${renderRangeField("Mix", "mix", params.mix, 0, 400, `${params.mix}%`)}
    ${renderRangeField("Saturation", "saturation", params.saturation, 0, 400, `${(params.saturation / 100).toFixed(2)}x`)}
  `;

  let typeFields = "";
  if (type === "streaks") {
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

  const tintFields = `
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
      ${renderRangeField("Playback FPS", "viewer-fps", currentFps, 1, maxFps, formatFpsReadout(currentFps, sourceFps))}
      <p class="hint">Controls step size and preview playback rate relative to the source frame rate.</p>
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

// `readout` is the formatted hint (e.g. "100% barrel"); it stays on the
// label as a unit suffix while the editable number input takes the right
// edge of the row, paired with the slider on the same line.
function renderRangeField(label, key, value, min, max, readout) {
  const safeKey = escapeHtml(key);
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  const suffix = readout && readout !== String(numericValue)
    ? `<span class="field-suffix" data-param-readout="${safeKey}">${escapeHtml(readout)}</span>`
    : `<span class="field-suffix" data-param-readout="${safeKey}"></span>`;
  return `
    <div class="field range-field">
      <label>${escapeHtml(label)}${suffix}</label>
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

function readControlValue(control) {
  if (control.type === "checkbox") return control.checked;
  if (control.tagName === "SELECT") return control.value;
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

function updateInlineReadout(control) {
  const readout = inspectorEl.querySelector(
    `[data-param-readout="${control.dataset.nodeParam}"]`
  );
  if (!readout) return;

  const value = readControlValue(control);
  switch (control.dataset.nodeParam) {
    case "brightness":
      readout.textContent = formatSignedValue(value);
      break;
    case "contrast":
    case "saturation":
    case "scale":
    case "errorStrength":
    case "strength":
    case "factor":
      readout.textContent = `${value}%`;
      break;
    case "gamma":
      readout.textContent = (value / 100).toFixed(2);
      break;
    case "exposure":
      readout.textContent = formatSignedStops(value);
      break;
    case "blurRadius":
    case "radius":
    case "amplitude":
      readout.textContent = `${value}px`;
      break;
    case "frequency":
      readout.textContent = `${value}x`;
      break;
    case "phase":
      readout.textContent = `${value}°`;
      break;
    case "viewer-fps":
      readout.textContent = formatFpsReadout(value, getState().source.sourceFps);
      break;
    default:
      readout.textContent = String(value);
      break;
  }
}

function getSocketPoint(node, kind, socketName) {
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
  const viewerEdgeId = getViewerInputEdgeId();
  if (viewerEdgeId) {
    return insertNodeOnEdge(viewerEdgeId, type);
  }
  return createNodeFromPalette(type, getViewportCenterWorld());
}

function createNodeFromPalette(type, point) {
  if (!type || !point) return null;
  return createFreeNode(type, {
    x: point.x - NODE_WIDTH / 2,
    y: point.y - 24,
  });
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
    <button data-add-node="adjust">Add Adjust</button>
    <button data-add-node="posterize">Add Posterize</button>
    <button data-add-node="invert">Add Invert</button>
    <button data-add-node="rgb-to-bw">Add RGB to BW</button>
    <button data-add-node="tone-map">Add Tone Map</button>
    <button data-add-node="blur">Add Blur</button>
    <button data-add-node="pixelate">Add Pixelate</button>
    <button data-add-node="scale">Add Scale</button>
    <button data-add-node="dither">Add Dither</button>
    <button data-add-node="glare">Add Glare</button>
    <button data-add-node="lens-distort">Add Lens Distortion</button>
    <button data-add-node="mix">Add Mix</button>
  `;

  graphMenuEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-node]");
    if (!button) return;

    const type = button.dataset.addNode;
    if (graphMenuState?.edgeId) {
      insertNodeOnEdge(graphMenuState.edgeId, type, {
        position: graphMenuState.point,
      });
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
