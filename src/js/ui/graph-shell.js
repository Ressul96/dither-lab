import { DEFAULT_GRAPH_VIEW, dispatch, getState, pushHistory, subscribe } from "../state.js";
import {
  MESH_GRADIENT_MAX_STOPS,
  ROOT_PARENT_ID,
  addEdge,
  createFreeNode,
  duplicateNode,
  duplicateNodes,
  ensureBootGraph,
  getNodeById,
  getNodeDefinition,
  getNodeParentId,
  getSelectedNode,
  getSelectedNodeIds,
  getSoloNodeId,
  getValueNodeOutputBounds,
  groupSelectedNodes,
  insertExistingNodeOnEdge,
  insertNodeOnEdge,
  mutateNodePosition,
  removeEdgesById,
  removeNode,
  replacePaletteUsages,
  resolveGraphParentId,
  selectNode,
  selectNodes,
  toggleParamExposed,
  toggleNodeBypass,
  toggleNodeSolo,
  ungroupNode,
  updateNodeLayerProperties,
  updateNodeLabel,
  updateNodeParams,
} from "../graph.js";
import { getAlgorithmOptions } from "../dither/index.js";
import { MASK_MODES, MASK_SOURCES, MIX_MODES } from "../image-ops.js";
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
  TIMELINE_BINDING_NODE_PROPERTY,
  commitBindingValueToTimeline,
  commitParamValueToTimeline,
  hasParamKeyframeAtCurrentTime,
  hasTimelineKeyframeAtCurrentTime,
  hasTimelineTrackForBinding,
  hasTimelineTrackForParam,
  toggleParamKeyframeAtCurrentTime,
  toggleTimelineKeyframeAtCurrentTime,
  updateBindingKeyframeAtCurrentTime,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import { normalizeHex } from "../color.js";
import {
  buildCurveLut,
  buildRgbCurveLut,
  getMonotoneCurveTangents,
  identityCurvePoints as createIdentityCurvePoints,
  MIN_CURVE_POINT_GAP,
  readRgbCurvePoints,
  sanitizeCurvePoints,
} from "../curve-lut.js";

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
const GRAPH_MARQUEE_THRESHOLD = 4;
const CURVE_CANVAS_SIZE = 240;
const CURVE_HANDLE_RADIUS = 6;
const CURVE_CHANNELS = ["master", "red", "green", "blue"];
const GRADIENT_RAMP_MAX_STOPS = 8;
const GRADIENT_RAMP_STOP_GAP = 0.005;

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
let graphBreadcrumbEl = null;
let renderedGraphParentId = "";
let insertHighlightEdgeId = "";
let graphAutoCentered = false;
let paletteDragPreviewEl = null;
let colorPickerState = null;
let gradientRampState = null;
let nodePaletteSearchEl = null;
let nodePaletteEmptyEl = null;
let graphSpacePanActive = false;
let graphCutCursorActive = false;
// Tracks Meta/Ctrl held above the editor — drives the marquee-ready cursor
// (crosshair) and lets the empty-area pointerdown branch route to marquee
// instead of the new default pan.
let graphMarqueeModifierActive = false;
let graphPointerInsideEditor = false;
let graphKeyboardActive = false;
let activeGraphMarquee = null;
let graphRenameNodeId = null;
const paletteSwatchLocks = new Map();
// F17.1 inspector undo: snapshot a control's pre-drag value the first time
// `input` fires for it, then turn the whole drag into a single history entry
// when `change` flushes. Key: "${nodeId}|param|${paramKey}".
const inspectorParamSnapshots = new Map();
// F17.3b/c picker hex input + eyedropper undo. Keyed by colorPickerState's
// targetId so a session of mid-typing inputs flushes a single entry once
// `change` fires on blur / Enter.
const pickerHexSnapshots = new Map();

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
  nodesEl.addEventListener("dblclick", onNodeDoubleClick);
  nodesEl.addEventListener("pointerdown", onGraphPointerDown);
  nodesEl.addEventListener("focusout", onGraphNodeFocusOut);
  nodesEl.addEventListener("keydown", onGraphNodeKeyDown);
  inspectorEl.addEventListener("input", onInspectorInput);
  inspectorEl.addEventListener("change", onInspectorChange);
  inspectorEl.addEventListener("click", onInspectorClick);
  inspectorEl.addEventListener("pointerdown", onInspectorPointerDown);
  inspectorEl.addEventListener("keydown", onInspectorKeyDown);
  inspectorEl.addEventListener("contextmenu", onInspectorContextMenu);
  subscribePalettes(onPaletteRegistryChange);
  initNodePaletteSearch();
  initPaletteDragAndDrop();
  initViewportInteractions();
  initGraphContextMenu();
  initGraphBreadcrumb();
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
    // Skip the full graph DOM rebuild while an inspector drag is live. The
    // node cards' visible content (label, position, selection, edges) does
    // not depend on the params being edited mid-drag, so rebuilding 220px-
    // wide cards on every XY-pad / slider pointermove tick is wasted work
    // that surfaced as visible lag on the focused control. The drag-end
    // path calls renderInspector explicitly, and the next non-edit graph
    // dispatch catches the shell up.
    if (inspectorEditing) return;
    renderShell();
  });
  subscribe("timeline", () => {
    if (!inspectorEditing) renderInspector();
  });
  subscribe("playback", () => {
    if (!inspectorEditing) syncTimelineButtons();
  });
  subscribe("graphView", () => {
    const parentId = getCurrentGraphParentId();
    if (parentId !== renderedGraphParentId) {
      renderGraph();
    } else {
      syncGraphBreadcrumb();
    }
    applyGraphViewport();
  });
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

function initNodePaletteSearch() {
  nodePaletteSearchEl = document.querySelector("[data-node-palette-search]");
  nodePaletteEmptyEl = document.querySelector("[data-node-palette-empty]");
  if (!nodePaletteSearchEl) return;
  nodePaletteSearchEl.addEventListener("input", () => {
    filterNodePalette(nodePaletteSearchEl.value);
  });
  nodePaletteSearchEl.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!nodePaletteSearchEl.value) return;
    event.stopPropagation();
    nodePaletteSearchEl.value = "";
    filterNodePalette("");
  });
  filterNodePalette(nodePaletteSearchEl.value);
}

function filterNodePalette(value) {
  const query = normalizePaletteSearch(value);
  let visibleCount = 0;
  for (const group of document.querySelectorAll(".node-palette-group")) {
    const family = normalizePaletteSearch(group.dataset.nodeFamily ?? "");
    let groupVisible = false;
    for (const item of group.querySelectorAll("[data-palette-node]")) {
      const label = normalizePaletteSearch(item.textContent ?? "");
      const type = normalizePaletteSearch(item.dataset.paletteNode ?? "");
      const visible = !query || label.includes(query) || type.includes(query) || family.includes(query);
      item.classList.toggle("is-hidden", !visible);
      groupVisible = groupVisible || visible;
      if (visible) visibleCount += 1;
    }
    group.classList.toggle("is-hidden", !groupVisible);
  }
  nodePaletteEmptyEl?.classList.toggle("hidden", visibleCount > 0);
}

function normalizePaletteSearch(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function initGraphBreadcrumb() {
  if (graphBreadcrumbEl || !editorEl) return;
  graphBreadcrumbEl = document.createElement("nav");
  graphBreadcrumbEl.className = "graph-breadcrumb";
  graphBreadcrumbEl.setAttribute("aria-label", "Graph path");
  graphBreadcrumbEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-graph-parent-id]");
    if (!button) return;
    setCurrentGraphParent(button.dataset.graphParentId);
  });
  editorEl.appendChild(graphBreadcrumbEl);
  syncGraphBreadcrumb();
}

function syncGraphBreadcrumb(parentId = getCurrentGraphParentId()) {
  if (!graphBreadcrumbEl) return;
  const chain = getGraphBreadcrumbChain(parentId);
  graphBreadcrumbEl.innerHTML = chain
    .map((item, index) => {
      const separator = index > 0 ? `<span class="graph-breadcrumb-separator">/</span>` : "";
      const active = index === chain.length - 1 ? " is-active" : "";
      return `
        ${separator}
        <button
          type="button"
          class="graph-breadcrumb-item${active}"
          data-graph-parent-id="${escapeHtml(item.id)}"
          aria-current="${index === chain.length - 1 ? "page" : "false"}"
        >${escapeHtml(item.label)}</button>
      `;
    })
    .join("");
}

function getGraphBreadcrumbChain(parentId = getCurrentGraphParentId()) {
  const { graph } = getState();
  const chain = [{ id: ROOT_PARENT_ID, label: "Root" }];
  const visited = new Set([ROOT_PARENT_ID]);
  let currentId = resolveGraphParentId(graph, parentId);
  const groups = [];

  while (currentId !== ROOT_PARENT_ID && !visited.has(currentId)) {
    visited.add(currentId);
    const group = getNodeById(currentId, graph);
    if (!group || group.type !== "group") break;
    groups.unshift({ id: group.id, label: group.label || group.id });
    currentId = getNodeParentId(group);
  }

  return chain.concat(groups);
}

function setCurrentGraphParent(parentId) {
  const { graph } = getState();
  const currentParentId = resolveGraphParentId(graph, parentId);
  dispatch("graphView", { currentParentId });
  const selected = graph.nodes.find((node) => node.id === graph.selectedNodeId);
  if (selected && getNodeParentId(selected) !== currentParentId) {
    dispatch("graph", { selectedNodeId: null, selectedNodeIds: [] });
  }
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

  editorEl.addEventListener("pointerenter", (e) => {
    graphPointerInsideEditor = true;
    syncGraphCutCursorFromPointer(e);
    syncGraphInteractionModeClasses();
  });
  editorEl.addEventListener("pointermove", (e) => {
    syncGraphCutCursorFromPointer(e);
    syncGraphInteractionModeClasses();
  });
  editorEl.addEventListener("pointerleave", () => {
    graphPointerInsideEditor = false;
    syncGraphInteractionModeClasses();
  });

  editorEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    graphKeyboardActive = true;
    if (e.target.closest("[data-node-id]") || e.target.closest(".graph-socket-hit")) return;
    // The breadcrumb lives inside #nodeEditor so the pan handler would
    // otherwise capture the pointer on this same `pointerdown` and the
    // follow-up `click` never reaches the Root / group buttons — that's
    // why entering a group looked one-way.
    if (e.target.closest(".graph-breadcrumb")) return;
    if (e.altKey) {
      startEdgeCut(e);
      return;
    }
    // Cmd / Ctrl held over empty canvas opens the marquee box-select.
    // Plain left-drag is back to panning — that's the default users built
    // muscle memory around before F13.3 swapped them. Space-pan still
    // works as a redundant alternative.
    if (e.metaKey || e.ctrlKey) {
      startGraphBoxSelect(e);
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
  editorEl.classList.add("cutting");
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
    editorEl.classList.remove("cutting");
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
  e.preventDefault();
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

function startGraphBoxSelect(e) {
  e.preventDefault();

  const startClient = { x: e.clientX, y: e.clientY };
  const extendSelection = e.shiftKey || e.metaKey || e.ctrlKey;
  const initialSelectedIds = getSelectedNodeIds();
  let nextSelectedIds = extendSelection ? initialSelectedIds : [];
  let moved = false;

  const marqueeEl = document.createElement("div");
  marqueeEl.className = "graph-marquee hidden";
  editorEl.appendChild(marqueeEl);

  try {
    editorEl.setPointerCapture(e.pointerId);
  } catch {}

  const applySelection = (nodeIds) => {
    nextSelectedIds = nodeIds;
    selectNodesWithoutDispatch(nodeIds, nodeIds.at(-1) ?? null);
    syncRenderedNodeSelection(nodeIds);
    renderInspector();
    renderEdges();
  };

  const finish = (cancelled = false) => {
    editorEl.removeEventListener("pointermove", onMove);
    editorEl.removeEventListener("pointerup", onUp);
    editorEl.removeEventListener("pointercancel", onCancel);
    editorEl.classList.remove("box-selecting");
    marqueeEl.remove();
    if (activeGraphMarquee?.el === marqueeEl) activeGraphMarquee = null;
    try {
      editorEl.releasePointerCapture(e.pointerId);
    } catch {}

    const finalIds = cancelled ? initialSelectedIds : moved ? nextSelectedIds : [];
    dispatch("graph", {
      selectedNodeId: finalIds.at(-1) ?? null,
      selectedNodeIds: finalIds,
    });
  };

  const updateMarquee = (clientX, clientY) => {
    const rect = getMarqueeLocalRect(startClient, { x: clientX, y: clientY });
    marqueeEl.style.left = `${rect.left}px`;
    marqueeEl.style.top = `${rect.top}px`;
    marqueeEl.style.width = `${rect.width}px`;
    marqueeEl.style.height = `${rect.height}px`;
  };

  const onMove = (ev) => {
    const dx = ev.clientX - startClient.x;
    const dy = ev.clientY - startClient.y;
    if (!moved && Math.hypot(dx, dy) < GRAPH_MARQUEE_THRESHOLD) return;
    if (!moved) {
      moved = true;
      editorEl.classList.add("box-selecting");
      marqueeEl.classList.remove("hidden");
    }

    updateMarquee(ev.clientX, ev.clientY);
    const marqueeClientRect = getMarqueeClientRect(startClient, { x: ev.clientX, y: ev.clientY });
    const hitIds = getNodeIdsInClientRect(marqueeClientRect);
    const selectedIds = extendSelection ? mergeNodeSelection(initialSelectedIds, hitIds) : hitIds;
    applySelection(selectedIds);
  };

  const onUp = () => finish(false);
  const onCancel = () => finish(true);

  activeGraphMarquee = {
    el: marqueeEl,
    cancel: onCancel,
  };
  editorEl.addEventListener("pointermove", onMove);
  editorEl.addEventListener("pointerup", onUp);
  editorEl.addEventListener("pointercancel", onCancel);
}

function cancelActiveGraphMarquee() {
  if (!activeGraphMarquee) return false;
  activeGraphMarquee.cancel();
  return true;
}

function syncRenderedNodeSelection(nodeIds) {
  const selectedIds = new Set(nodeIds);
  for (const el of nodesEl.querySelectorAll("[data-node-id]")) {
    el.classList.toggle("selected", selectedIds.has(el.dataset.nodeId));
  }
}

function mergeNodeSelection(baseIds, addedIds) {
  return [...new Set([...(baseIds ?? []), ...(addedIds ?? [])])].filter(Boolean);
}

function getNodeIdsInClientRect(selectionRect) {
  return Array.from(nodesEl.querySelectorAll("[data-node-id]"))
    .filter((nodeEl) => rectsIntersect(selectionRect, nodeEl.getBoundingClientRect()))
    .map((nodeEl) => nodeEl.dataset.nodeId)
    .filter(Boolean);
}

function getMarqueeLocalRect(start, current) {
  const editorRect = editorEl.getBoundingClientRect();
  const clientRect = getMarqueeClientRect(start, current);
  const left = clamp(clientRect.left - editorRect.left, 0, editorRect.width);
  const top = clamp(clientRect.top - editorRect.top, 0, editorRect.height);
  const right = clamp(clientRect.right - editorRect.left, 0, editorRect.width);
  const bottom = clamp(clientRect.bottom - editorRect.top, 0, editorRect.height);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function getMarqueeClientRect(start, current) {
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const right = Math.max(start.x, current.x);
  const bottom = Math.max(start.y, current.y);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function rectsIntersect(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function onGraphPointerDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest("[data-node-rename-input]")) return;
  if (e.target.closest("[data-node-action]")) return;
  graphKeyboardActive = true;

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

    if (event.key === "Alt" && shouldUseGraphCutCursor()) {
      graphCutCursorActive = true;
      syncGraphInteractionModeClasses();
      return;
    }

    // Cmd / Ctrl: arm marquee-ready cursor when the pointer is over the
    // editor. Don't preventDefault — we still want regular Cmd shortcuts
    // (G, D, Z, etc.) to fire below.
    if ((event.key === "Meta" || event.key === "Control") && shouldUseGraphMarqueeCursor()) {
      graphMarqueeModifierActive = true;
      syncGraphInteractionModeClasses();
    }

    if (isSpaceKey(event) && shouldUseGraphSpacePan()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      graphSpacePanActive = true;
      syncGraphInteractionModeClasses();
      return;
    }

    if (event.key === "Escape") {
      const handled = cancelActiveGraphMarquee() || clearGraphSelection();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    const commandKey = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (commandKey && key === "d" && !event.shiftKey && !event.altKey) {
      if (duplicateSelectedGraphNodes()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (key === "g" && !event.altKey && shouldHandleGraphShortcut()) {
      const handled = event.shiftKey ? ungroupCurrentSelection() : groupCurrentSelection();
      if (handled) event.preventDefault();
      return;
    }

    if (key === "m" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (toggleBypassForSelectedNodes()) event.preventDefault();
      return;
    }

    if ((key === "x" || event.key === "Delete" || event.key === "Backspace") && shouldHandleGraphShortcut()) {
      if (removeSelectedGraphNodes()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (key === "a" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (selectAllVisibleGraphNodes()) event.preventDefault();
      return;
    }

    if (key === "f" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (frameSelectedGraphNodes()) event.preventDefault();
      return;
    }

    if (key === "t" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (toggleSoloForSelectedNode()) event.preventDefault();
      return;
    }

    if (key === "r" && !commandKey && !event.altKey && shouldHandleGraphShortcut()) {
      if (startRenamingSelectedNode()) event.preventDefault();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.key === "Alt" && graphCutCursorActive) {
      graphCutCursorActive = false;
      syncGraphInteractionModeClasses();
      return;
    }

    if ((event.key === "Meta" || event.key === "Control") && graphMarqueeModifierActive) {
      graphMarqueeModifierActive = false;
      syncGraphInteractionModeClasses();
    }

    if (isSpaceKey(event) && graphSpacePanActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      graphSpacePanActive = false;
      syncGraphInteractionModeClasses();
    }
  });

  window.addEventListener("blur", () => {
    graphSpacePanActive = false;
    graphCutCursorActive = false;
    syncGraphInteractionModeClasses();
    cancelActiveGraphMarquee();
  });
}

function isSpaceKey(event) {
  return event.key === " " || event.code === "Space";
}

function shouldUseGraphSpacePan() {
  return graphPointerInsideEditor || editorEl?.matches?.(":hover") || graphSpacePanActive;
}

function shouldUseGraphCutCursor() {
  return graphPointerInsideEditor || editorEl?.matches?.(":hover") || graphCutCursorActive;
}

function shouldUseGraphMarqueeCursor() {
  return graphPointerInsideEditor || editorEl?.matches?.(":hover") || graphMarqueeModifierActive;
}

function syncGraphCutCursorFromPointer(event) {
  const nextCutCursorActive = Boolean(event.altKey);
  if (graphCutCursorActive === nextCutCursorActive) return;
  graphCutCursorActive = nextCutCursorActive;
}

function shouldHandleGraphShortcut() {
  return (
    graphKeyboardActive ||
    graphPointerInsideEditor ||
    editorEl?.matches?.(":hover") ||
    getSelectedNodeIds().length > 0
  );
}

function syncGraphInteractionModeClasses() {
  editorEl?.classList.toggle("space-panning", graphSpacePanActive && shouldUseGraphSpacePan());
  editorEl?.classList.toggle("cut-ready", graphCutCursorActive && shouldUseGraphCutCursor());
  editorEl?.classList.toggle("marquee-ready", graphMarqueeModifierActive && shouldUseGraphMarqueeCursor());
}

function duplicateSelectedGraphNodes() {
  const selectedIds = getSelectedNodeIds();
  if (selectedIds.length === 0) return false;
  return duplicateNodes(selectedIds).length > 0;
}

function toggleBypassForSelectedNodes() {
  const ids = getSelectedNodeIds().filter((nodeId) => canBypassGraphNode(getNodeById(nodeId)));
  let changed = false;
  for (const id of ids) {
    changed = toggleNodeBypass(id) || changed;
  }
  return changed;
}

function removeSelectedGraphNodes() {
  const ids = getSelectedNodeIds();
  let removed = false;
  for (const id of ids) {
    removed = removeNode(id) || removed;
  }
  return removed;
}

function selectAllVisibleGraphNodes() {
  const { graph } = getState();
  const ids = getVisibleGraphNodes(graph).map((node) => node.id);
  if (ids.length === 0) return false;
  selectNodes(ids, ids.at(-1));
  return true;
}

function clearGraphSelection() {
  if (getSelectedNodeIds().length === 0) return false;
  selectNodes([]);
  return true;
}

function frameSelectedGraphNodes() {
  const { graph } = getState();
  const visibleNodeIds = getVisibleGraphNodeIds(graph);
  const nodes = getSelectedNodeIds(graph)
    .filter((nodeId) => visibleNodeIds.has(nodeId))
    .map((nodeId) => getNodeById(nodeId, graph))
    .filter(Boolean);
  if (nodes.length === 0) return false;

  const rect = editorEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const bounds = getGraphNodesBounds(nodes);
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const padding = Math.min(GRAPH_VIEW_PADDING, Math.max(48, Math.min(rect.width, rect.height) * 0.18));
  const zoom = clamp(
    Math.min((rect.width - padding * 2) / contentWidth, (rect.height - padding * 2) / contentHeight),
    0.35,
    1.65
  );
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  dispatch("graphView", {
    zoom,
    panX: rect.width / 2 - toSceneX(centerX) * zoom,
    panY: rect.height / 2 - toSceneY(centerY) * zoom,
  });
  return true;
}

function toggleSoloForSelectedNode() {
  const nodeId = getState().graph.selectedNodeId ?? getSelectedNodeIds().at(-1);
  if (!nodeId) return false;
  return toggleNodeSolo(nodeId);
}

function startRenamingSelectedNode() {
  const nodeId = getState().graph.selectedNodeId ?? getSelectedNodeIds().at(-1);
  const node = getNodeById(nodeId);
  if (!node) return false;

  graphRenameNodeId = node.id;
  renderGraph();
  requestAnimationFrame(() => {
    const input = nodesEl.querySelector(`[data-node-rename-input="${cssEscape(node.id)}"]`);
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    input.select();
  });
  return true;
}

function commitGraphNodeRename(input) {
  const nodeId = input?.dataset?.nodeRenameInput;
  if (!nodeId) return false;
  if (graphRenameNodeId !== nodeId) return false;
  graphRenameNodeId = null;
  updateNodeLabel(nodeId, input.value);
  renderGraph();
  return true;
}

function cancelGraphNodeRename(input) {
  const nodeId = input?.dataset?.nodeRenameInput;
  if (!nodeId) return false;
  graphRenameNodeId = null;
  renderGraph();
  return true;
}

function getGraphNodesBounds(nodes) {
  return nodes.reduce(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      maxX: Math.max(acc.maxX, node.x + NODE_WIDTH),
      minY: Math.min(acc.minY, node.y),
      maxY: Math.max(acc.maxY, node.y + getNodeRenderHeight(node)),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
}

function getNodeRenderHeight(node) {
  return Math.max(NODE_HEIGHT, node.outputs?.length * SOCKET_STEP + SOCKET_Y + 26);
}

function groupCurrentSelection() {
  const groupId = groupSelectedNodes();
  if (!groupId) return false;
  return true;
}

function ungroupCurrentSelection() {
  const { graph, graphView } = getState();
  const selected = getSelectedNode(graph);
  if (selected?.type === "group") {
    return ungroupNode(selected.id);
  }
  const currentParent = resolveGraphParentId(graph, graphView.currentParentId);
  return currentParent !== ROOT_PARENT_ID ? ungroupNode(currentParent) : false;
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
  const startZoom = getState().graphView.zoom || 1;
  const selectedAtStart = getSelectedNodeIds();
  const dragNodeIds = selectedAtStart.includes(nodeId) && selectedAtStart.length > 1
    ? selectedAtStart.filter((id) => getNodeById(id) && getNodeParentId(getNodeById(id)) === getCurrentGraphParentId())
    : [nodeId];
  const startPositions = new Map(
    dragNodeIds
      .map((id) => getNodeById(id))
      .filter(Boolean)
      .map((item) => [item.id, { x: item.x, y: item.y }])
  );
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
      selectNodesWithoutDispatch(dragNodeIds, nodeId);
    }
    for (const id of dragNodeIds) {
      const start = startPositions.get(id);
      if (!start) continue;
      const nextX = start.x + dx / startZoom;
      const nextY = start.y + dy / startZoom;
      mutateNodePosition(id, nextX, nextY);
      const itemEl = nodesEl.querySelector(`[data-node-id="${cssEscape(id)}"]`);
      if (itemEl) {
        itemEl.style.left = `${toSceneX(nextX)}px`;
        itemEl.style.top = `${toSceneY(nextY)}px`;
      }
    }
    if (!liveEl.isConnected) {
      liveEl = nodesEl.querySelector(`[data-node-id="${cssEscape(nodeId)}"]`) || liveEl;
    }
    const edge = dragNodeIds.length === 1 ? findInsertTargetForNodeAt(nodeId, ev.clientX, ev.clientY) : null;
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
    } else {
      const edge = dragNodeIds.length === 1 ? findInsertTargetForNodeAt(nodeId, ev.clientX, ev.clientY) : null;
      clearInsertHighlight();
      if (edge?.edgeId && insertExistingNodeOnEdge(nodeId, edge.edgeId)) {
        return;
      }

      for (const id of dragNodeIds) {
        nodesEl.querySelector(`[data-node-id="${cssEscape(id)}"]`)?.classList.add("selected");
      }
      selectNodesWithoutDispatch(dragNodeIds, nodeId);
      renderInspector();
      renderEdges();
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function selectNodesWithoutDispatch(nodeIds, primaryNodeId = null) {
  const { graph } = getState();
  const ids = [...new Set(Array.isArray(nodeIds) ? nodeIds : [])].filter((id) =>
    graph.nodes.some((node) => node.id === id)
  );
  graph.selectedNodeIds = ids;
  graph.selectedNodeId = primaryNodeId && ids.includes(primaryNodeId) ? primaryNodeId : ids.at(-1) ?? null;
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
    if (target) {
      if (target.kind === fromKind) return;
      if (fromKind === "output") {
        addEdge(fromNodeId, fromSocketName, target.nodeId, target.socketName);
      } else {
        addEdge(target.nodeId, target.socketName, fromNodeId, fromSocketName);
      }
      return;
    }

    // Fallback: pointer landed on a node body, not a specific socket. Try the
    // node's sockets in declaration order so dropping anywhere on the node
    // wires up to its first compatible pin — addEdge already validates type
    // compatibility, so we just walk until one sticks.
    const targetNodeId = findNodeAt(ev.clientX, ev.clientY);
    if (!targetNodeId || targetNodeId === fromNodeId) return;
    const targetNode = getNodeById(targetNodeId);
    if (!targetNode) return;
    const candidates = fromKind === "output" ? targetNode.inputs : targetNode.outputs;
    for (const socket of candidates ?? []) {
      const ok = fromKind === "output"
        ? addEdge(fromNodeId, fromSocketName, targetNodeId, socket.name)
        : addEdge(targetNodeId, socket.name, fromNodeId, fromSocketName);
      if (ok) return;
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function findNodeAt(clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const el of stack) {
    const node = el.closest?.("[data-node-id]");
    if (node && nodesEl?.contains(node)) return node.dataset.nodeId;
  }
  return null;
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
  if (event.target.closest("[data-node-rename-input]")) return;

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
  selectNode(node.dataset.nodeId, {
    toggle: event.shiftKey || event.metaKey || event.ctrlKey,
    extend: event.shiftKey || event.metaKey || event.ctrlKey,
  });
}

function onNodeDoubleClick(event) {
  if (event.target.closest("[data-node-rename-input]")) return;

  const nodeEl = event.target.closest("[data-node-id]");
  if (!nodeEl) return;
  const node = getNodeById(nodeEl.dataset.nodeId);
  if (node?.type !== "group") return;
  event.preventDefault();
  event.stopPropagation();
  setCurrentGraphParent(node.id);
}

function onGraphNodeFocusOut(event) {
  const input = event.target.closest("[data-node-rename-input]");
  if (!input) return;
  commitGraphNodeRename(input);
}

function onGraphNodeKeyDown(event) {
  const input = event.target.closest("[data-node-rename-input]");
  if (!input) return;

  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    commitGraphNodeRename(input);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelGraphNodeRename(input);
  }
}

function flushInspectorParamUndo(nodeId, key, kind = "param") {
  if (!nodeId || !key) return;
  const snapshotKey = `${nodeId}|${kind}|${key}`;
  if (!inspectorParamSnapshots.has(snapshotKey)) return;
  const oldValue = inspectorParamSnapshots.get(snapshotKey);
  inspectorParamSnapshots.delete(snapshotKey);
  const node = getNodeById(nodeId);
  const newValue = kind === "property" ? node?.[key] : node?.params?.[key];
  // No-op drags (click without movement, typing the same number) don't
  // deserve a history entry — keeps the undo stack focused on real edits.
  if (oldValue === newValue) return;
  const applyValue = (value) => {
    if (kind === "property") updateNodeLayerProperties(nodeId, { [key]: value });
    else updateNodeParams(nodeId, { [key]: value });
  };
  pushHistory({
    undo: () => applyValue(oldValue),
    redo: () => applyValue(newValue),
  });
}

function onInspectorInput(event) {
  const pickerHexInput = event.target.closest("[data-color-picker-hex-input]");
  if (pickerHexInput) {
    inspectorEditing = true;
    // F17.3c: snapshot the pre-edit color the first time `input` fires for
    // this picker, then flush a single history entry on the matching change.
    // Pull from node state rather than the DOM input — by the time `input`
    // fires, input.value already holds the in-progress value.
    const pickerTarget = resolveColorPickerTarget(pickerHexInput);
    if (pickerTarget && !pickerHexSnapshots.has(pickerTarget.targetId)) {
      pickerHexSnapshots.set(pickerTarget.targetId, readPickerValueFromState(pickerTarget));
    }
    const nextHex = normalizeHexOrNull(pickerHexInput.value);
    pickerHexInput.classList.toggle("is-invalid", !nextHex);
    if (nextHex) commitColorPickerValue(pickerHexInput, nextHex);
    return;
  }

  const meshStopControl = event.target.closest("[data-mesh-stop-field]");
  if (meshStopControl) {
    const node = getSelectedNode();
    if (!node || node.type !== "mesh-gradient") return;
    if (meshStopControl.dataset.inputKind === "mesh-stop-hex") {
      // Skip mid-typing commits — onInspectorChange fires on blur/Enter.
      inspectorEditing = true;
      return;
    }
    inspectorEditing = true;
    commitMeshStopField(node, meshStopControl);
    return;
  }

  const gradientStopControl = event.target.closest("[data-gradient-map-stop-color]");
  if (gradientStopControl) {
    const node = getSelectedNode();
    if (!isGradientRampNode(node)) return;
    if (gradientStopControl.dataset.inputKind === "gradient-stop-hex") {
      inspectorEditing = true;
      return;
    }
    inspectorEditing = true;
    commitGradientMapStopColor(node, gradientStopControl);
    syncGradientStopSiblingControls(gradientStopControl);
    return;
  }

  const propertyControl = event.target.closest("[data-node-property]");
  if (propertyControl) {
    const node = getSelectedNode();
    if (!isLayerAdjustableNode(node)) return;

    const nodeId = node.id;
    const propertyKey = propertyControl.dataset.nodeProperty;
    if (!propertyKey) return;
    inspectorEditing = true;
    // F17.1: capture the pre-drag value on the first input tick so the
    // matching change event can record a single history entry covering the
    // whole drag (parity with the data-node-param branch below).
    const undoSnapshotKey = `${nodeId}|property|${propertyKey}`;
    if (!inspectorParamSnapshots.has(undoSnapshotKey)) {
      inspectorParamSnapshots.set(undoSnapshotKey, getNodeById(nodeId)?.[propertyKey]);
    }
    const value = readControlValue(propertyControl);
    const binding = {
      type: TIMELINE_BINDING_NODE_PROPERTY,
      key: propertyKey,
    };
    updateNodeLayerProperties(nodeId, { [propertyKey]: value });
    if (!commitBindingValueToTimeline(nodeId, binding, value)) {
      updateBindingKeyframeAtCurrentTime(nodeId, binding, value);
    }
    const applied = getNodeById(nodeId)?.[propertyKey];
    if (
      applied !== undefined &&
      propertyControl.type !== "checkbox" &&
      propertyControl.value !== String(applied)
    ) {
      propertyControl.value = String(applied);
    }
    updateInlineReadout(propertyControl);
    syncLayerPropertySiblingControls(propertyControl);
    return;
  }

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
      // F17.3a: snapshot the pre-edit hex even though we skip the live
      // commit, so the matching change event can record a single undo
      // entry covering the whole typing session.
      const nodeId = node.id;
      const paramKey = control.dataset.nodeParam;
      const undoSnapshotKey = `${nodeId}|param|${paramKey}`;
      if (!inspectorParamSnapshots.has(undoSnapshotKey)) {
        inspectorParamSnapshots.set(undoSnapshotKey, getNodeById(nodeId)?.params?.[paramKey]);
      }
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
    // F17.1: capture the pre-drag value before the first update so the
    // matching change event can record a single history entry covering the
    // entire slider/typing session. Subsequent input ticks see the snapshot
    // is already set and skip.
    const undoSnapshotKey = `${nodeId}|param|${paramKey}`;
    if (!inspectorParamSnapshots.has(undoSnapshotKey)) {
      inspectorParamSnapshots.set(undoSnapshotKey, getNodeById(nodeId)?.params?.[paramKey]);
    }
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
  const pickerHexInput = event.target.closest("[data-color-picker-hex-input]");
  if (pickerHexInput) {
    inspectorEditing = false;
    const target = resolveColorPickerTarget(pickerHexInput);
    const nextHex = normalizeHexOrNull(pickerHexInput.value);
    if (nextHex) {
      commitColorPickerValue(pickerHexInput, nextHex);
    } else if (target) {
      syncColorPickerElements(target, readColorPickerCurrentHex(target));
    }
    // F17.3c flush: turn the typing session into a single undo entry. Read
    // the final from state so it matches the snapshot's source of truth.
    if (target && pickerHexSnapshots.has(target.targetId)) {
      const oldHex = pickerHexSnapshots.get(target.targetId);
      pickerHexSnapshots.delete(target.targetId);
      const finalHex = readPickerValueFromState(target);
      if (oldHex && finalHex && oldHex !== finalHex) {
        pushHistory({
          undo: () => applyColorPickerHex(target, oldHex),
          redo: () => applyColorPickerHex(target, finalHex),
        });
      }
    }
    return;
  }

  const meshStopControl = event.target.closest("[data-mesh-stop-field]");
  if (meshStopControl) {
    inspectorEditing = false;
    const node = getSelectedNode();
    if (
      node?.type === "mesh-gradient" &&
      (meshStopControl.dataset.inputKind === "mesh-stop-hex" ||
        meshStopControl.dataset.inputKind === "mesh-stop-swatch")
    ) {
      commitMeshStopField(node, meshStopControl);
    }
    renderInspector();
    return;
  }

  const gradientStopControl = event.target.closest("[data-gradient-map-stop-color]");
  if (gradientStopControl) {
    inspectorEditing = false;
    const node = getSelectedNode();
    if (isGradientRampNode(node)) {
      commitGradientMapStopColor(node, gradientStopControl);
      syncGradientStopSiblingControls(gradientStopControl);
    }
    renderInspector();
    return;
  }

  const propertyControl = event.target.closest("[data-node-property]");
  if (propertyControl) {
    inspectorEditing = false;
    const node = getSelectedNode();
    if (node) {
      flushInspectorParamUndo(node.id, propertyControl.dataset.nodeProperty, "property");
    }
    renderInspector();
    return;
  }

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
    // F17.1: flush the drag snapshot into a single history entry. The
    // pre-drag value was captured the first time onInspectorInput fired
    // for this control; if the drag actually moved the param, record one
    // undo entry covering the whole drag rather than one per slider tick.
    if (node) {
      flushInspectorParamUndo(node.id, control.dataset.nodeParam);
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
  const gradientRampControl = event.target.closest(
    "[data-gradient-ramp-action], [data-gradient-ramp-stop], [data-gradient-ramp-bar]"
  );
  if (gradientRampControl) {
    event.preventDefault();
    handleGradientRampClick(event, gradientRampControl);
    return;
  }

  const eyedropper = event.target.closest("[data-color-picker-eyedropper]");
  if (eyedropper) {
    event.preventDefault();
    handleColorPickerEyedropper(eyedropper);
    return;
  }

  const colorPickerTrigger = event.target.closest("[data-color-picker-trigger]");
  if (colorPickerTrigger) {
    event.preventDefault();
    toggleColorPicker(colorPickerTrigger);
    return;
  }

  const meshAction = event.target.closest("[data-mesh-action]");
  if (meshAction) {
    event.preventDefault();
    const node = getSelectedNode();
    if (node?.type === "mesh-gradient") handleMeshAction(node, meshAction);
    return;
  }

  const graphAction = event.target.closest("[data-graph-action]");
  if (graphAction) {
    handleGraphInspectorAction(graphAction);
    return;
  }

  const propertyKeyframeToggle = event.target.closest("[data-node-property-keyframe-toggle]");
  if (propertyKeyframeToggle) {
    event.preventDefault();
    const node = getSelectedNode();
    if (!isLayerAdjustableNode(node)) return;
    const key = propertyKeyframeToggle.dataset.nodePropertyKeyframeToggle;
    if (!key) return;
    const binding = {
      type: TIMELINE_BINDING_NODE_PROPERTY,
      key,
    };
    toggleTimelineKeyframeAtCurrentTime({
      nodeId: node.id,
      binding,
      value: node?.[key] ?? getLayerPropertyDefaultValue(key),
    });
    renderInspector();
    return;
  }

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

  const curveChannel = event.target.closest("[data-curve-channel]");
  if (curveChannel) {
    event.preventDefault();
    handleCurveChannelClick(curveChannel);
    return;
  }

  const paletteControl = event.target.closest("[data-palette-action]");
  if (!paletteControl) return;
  if (paletteControl.tagName === "INPUT") return;
  handlePaletteClick(paletteControl);
}

function handleGraphInspectorAction(control) {
  switch (control.dataset.graphAction) {
    case "group-selected":
      groupCurrentSelection();
      break;
    case "open-group":
      setCurrentGraphParent(control.dataset.groupId);
      break;
    case "ungroup":
      ungroupNode(control.dataset.groupId);
      break;
    default:
      break;
  }
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

  const selectionKey = getSelectedNodeIds().join(",");
  if (!inspectorEditing || renderedInspectorNodeId !== selectionKey) {
    renderInspector();
  }
}

function renderGraph() {
  const { graph } = getState();
  const parentId = getCurrentGraphParentId();
  const visibleNodes = getVisibleGraphNodes(graph, parentId);
  const selectedNodeIds = new Set(getSelectedNodeIds(graph));
  const soloNodeId = getSoloNodeId(graph);
  nodesEl.style.width = `${GRAPH_WORLD_SIZE}px`;
  nodesEl.style.height = `${GRAPH_WORLD_SIZE}px`;
  const nodesHtml = visibleNodes.map((node) => renderNode(node, selectedNodeIds, soloNodeId)).join("");
  // F24 group I/O proxies: when the user has descended into a group, render
  // virtual "Group Input" / "Group Output" cards on either side of the
  // children so the boundary connections are visible from inside. These are
  // DOM-only — not part of graph.nodes — and read straight from the parent
  // group's pre-computed `group.inputBindings` / `outputBindings` arrays.
  const proxiesHtml = parentId !== ROOT_PARENT_ID
    ? renderGroupProxies(graph, parentId, visibleNodes)
    : "";
  nodesEl.innerHTML = nodesHtml + proxiesHtml;
  renderedGraphParentId = parentId;
  renderEdges(parentId);
  syncGraphBreadcrumb(parentId);
}

function renderGroupProxies(graph, parentId, visibleNodes) {
  const groupNode = getNodeById(parentId, graph);
  if (!groupNode || groupNode.type !== "group") return "";

  const inputBindings = Array.isArray(groupNode.group?.inputBindings)
    ? groupNode.group.inputBindings
    : [];
  const outputBindings = Array.isArray(groupNode.group?.outputBindings)
    ? groupNode.group.outputBindings
    : [];

  // Place the proxies just to the left / right of the children's bounding
  // box so they read as bookends. An empty group falls back to the world
  // centre so the cards still appear somewhere sensible.
  const bbox = computeChildrenBbox(visibleNodes);
  const inputX = bbox.minX - 280;
  const outputX = bbox.maxX + 40;
  const y = bbox.centerY - 60;

  return [
    renderGroupProxy("input", inputX, y, inputBindings, graph),
    renderGroupProxy("output", outputX, y, outputBindings, graph),
  ].join("");
}

function computeChildrenBbox(nodes) {
  if (!nodes?.length) {
    return {
      minX: GRAPH_WORLD_ORIGIN,
      maxX: GRAPH_WORLD_ORIGIN + 220,
      minY: GRAPH_WORLD_ORIGIN,
      maxY: GRAPH_WORLD_ORIGIN + 120,
      centerY: GRAPH_WORLD_ORIGIN + 60,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + 220);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + 120);
  }
  return { minX, maxX, minY, maxY, centerY: (minY + maxY) / 2 };
}

function renderGroupProxy(kind, x, y, bindings, graph) {
  const title = kind === "input" ? "Group Input" : "Group Output";
  const emptyLabel = kind === "input" ? "No incoming connections" : "No outgoing connections";
  const body = bindings.length === 0
    ? `<div class="graph-proxy-empty">${emptyLabel}</div>`
    : bindings.map((binding) => renderGroupProxyBinding(kind, binding, graph)).join("");
  return `
    <div class="graph-proxy-node graph-proxy-node--${kind}"
         style="left:${toSceneX(x)}px;top:${toSceneY(y)}px"
         data-group-proxy="${kind}"
         aria-hidden="true">
      <div class="graph-proxy-head">${title}</div>
      <div class="graph-proxy-body">${body}</div>
    </div>
  `;
}

function renderGroupProxyBinding(kind, binding, graph) {
  // Input bindings flow outer → inner, output bindings flow inner → outer.
  // Either way we render the inner side prominently (that's what the user
  // is working with inside the group) and the outer side as the link target.
  const outerId = kind === "input" ? binding.fromNode : binding.toNode;
  const outerSocket = kind === "input" ? binding.fromSocket : binding.toSocket;
  const innerId = kind === "input" ? binding.toNode : binding.fromNode;
  const innerSocket = kind === "input" ? binding.toSocket : binding.fromSocket;
  const outer = getNodeById(outerId, graph);
  const inner = getNodeById(innerId, graph);
  const outerLabel = `${outer?.label ?? outerId}.${outerSocket}`;
  const innerLabel = `${inner?.label ?? innerId}.${innerSocket}`;
  const line = kind === "input"
    ? `${outerLabel} → ${innerLabel}`
    : `${innerLabel} → ${outerLabel}`;
  return `<div class="graph-proxy-binding">${escapeHtml(line)}</div>`;
}

function renderEdges(parentId = getCurrentGraphParentId()) {
  const { graph } = getState();
  const visibleNodeIds = getVisibleGraphNodeIds(graph, parentId);
  edgesEl.setAttribute("viewBox", `0 0 ${GRAPH_WORLD_SIZE} ${GRAPH_WORLD_SIZE}`);
  edgesEl.setAttribute("width", String(GRAPH_WORLD_SIZE));
  edgesEl.setAttribute("height", String(GRAPH_WORLD_SIZE));
  edgesEl.innerHTML = graph.edges
    .filter((edge) => visibleNodeIds.has(edge.fromNode) && visibleNodeIds.has(edge.toNode))
    .map((edge) => renderEdge(edge, graph))
    .join("");
  if (insertHighlightEdgeId) {
    edgesEl.querySelector(`[data-edge-id="${insertHighlightEdgeId}"]`)?.classList.add("insert-target");
  }
}

function getCurrentGraphParentId() {
  const { graph, graphView } = getState();
  return resolveGraphParentId(graph, graphView.currentParentId);
}

function getVisibleGraphNodes(graph, parentId = getCurrentGraphParentId()) {
  return graph.nodes.filter((node) => getNodeParentId(node) === parentId);
}

function getVisibleGraphNodeIds(graph, parentId = getCurrentGraphParentId()) {
  return new Set(getVisibleGraphNodes(graph, parentId).map((node) => node.id));
}

function renderNode(node, selectedNodeIds, soloNodeId = null) {
  const definition = getNodeDefinition(node.type);
  const selected = selectedNodeIds.has(node.id) ? " selected" : "";
  const bypassed = node.bypassed ? " is-bypassed" : "";
  const solo = soloNodeId === node.id ? " is-solo" : "";
  const family = familySlug(definition?.family);
  const canBypass = node.type !== "source" && node.type !== "viewer-output" && node.type !== "group";
  const bypassIcon = node.bypassed ? eyeClosedSvg() : eyeOpenSvg();
  const title = graphRenameNodeId === node.id
    ? `<input class="graph-node-title-input" data-node-rename-input="${escapeHtml(node.id)}" value="${escapeHtml(node.label)}" maxlength="48" spellcheck="false" />`
    : `<span class="graph-node-title">${escapeHtml(node.label)}</span>`;

  return `
    <div
      class="graph-node graph-node--${family}${selected}${bypassed}${solo}"
      role="button"
      tabindex="0"
      draggable="false"
      data-node-id="${escapeHtml(node.id)}"
      data-node-family="${escapeHtml(family)}"
      style="left:${toSceneX(node.x)}px;top:${toSceneY(node.y)}px"
      title="${escapeHtml(node.id)}"
    >
      <div class="graph-node-head">
        ${title}
        <span class="graph-node-head-actions">
          ${solo ? `<span class="graph-node-solo-badge">Solo</span>` : ""}
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
        ${renderGroupBoundarySummary(node)}
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

function renderGroupBoundarySummary(node) {
  if (node.type !== "group") return "";
  const childCount = getState().graph.nodes.filter((item) => getNodeParentId(item) === node.id).length;
  const inputs = node.group?.inputBindings?.length ?? 0;
  const outputs = node.group?.outputBindings?.length ?? 0;
  return `
    <div class="graph-node-row graph-node-row--group">
      <span>${childCount} node${childCount === 1 ? "" : "s"}</span>
      <span>${inputs} in / ${outputs} out</span>
    </div>
  `;
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
  const selectedNodeIds = new Set(getSelectedNodeIds(graph));
  const active =
    selectedNodeIds.has(fromNode.id) || selectedNodeIds.has(toNode.id) ? " active" : "";

  return `<path class="graph-edge${active}" data-edge-id="${escapeHtml(edge.id)}" d="${path}" />`;
}

function renderInspector() {
  const { graph } = getState();
  const selectedNodeIds = getSelectedNodeIds(graph);
  if (selectedNodeIds.length > 1) {
    renderedInspectorNodeId = selectedNodeIds.join(",");
    syncInspectorTitle(null, `${selectedNodeIds.length} nodes selected`);
    inspectorEl.innerHTML = renderMultiSelectionInspector(selectedNodeIds);
    return;
  }

  const node = getSelectedNode(graph);
  renderedInspectorNodeId = node?.id ?? null;

  if (!node) {
    syncInspectorTitle(null);
    inspectorEl.innerHTML = renderEmptyInspector();
    return;
  }

  syncInspectorTitle(node);

  inspectorEl.innerHTML = `
    ${renderNodeActions(node)}
    ${renderLayerControls(node)}
    ${renderNodeSpecifics(node)}
  `;
}

function syncInspectorTitle(node, fallback = "No node selected") {
  if (!inspectorTitleEl) return;
  inspectorTitleEl.textContent = node?.label ?? fallback;
}

function renderNodeSpecifics(node) {
  switch (node.type) {
    case "group":
      return renderGroupNode(node);
    case "source":
      return renderSourceNode();
    case "gradient":
      return renderGradientNode(node);
    case "mesh-gradient":
      return renderMeshGradientNode(node);
    case "noise":
      return renderNoiseNode(node);
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
    case "levels":
      return renderLevelsNode(node);
    case "duotone":
      return renderDuotoneNode(node);
    case "gradient-map":
      return renderGradientMapNode(node);
    case "hsv":
      return renderHsvNode(node);
    case "rgb-curves":
      return renderRgbCurvesNode(node);
    case "scene-grade":
      return renderSceneGradeNode(node);
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
    case "led-screen":
      return renderLedScreenNode(node);
    case "modulation":
      return renderModulationNode(node);
    case "pixel-sorting":
      return renderPixelSortingNode(node);
    case "depth-of-field":
      return renderDepthOfFieldNode(node);
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

function renderNodeActions(node) {
  if (!node || node.type === "source" || node.type === "viewer-output" || node.type === "group") {
    return "";
  }
  return `
    <section class="node-panel-section">
      <div class="node-panel-actions">
        <button type="button" data-graph-action="group-selected">Group Node</button>
      </div>
    </section>
  `;
}

function renderLayerControls(node) {
  if (!isLayerAdjustableNode(node)) return "";
  const opacity = Number(node.opacity ?? 100);
  const hue = Number(node.hue ?? 0);
  const saturation = Number(node.saturation ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Layer</header>
      ${renderLayerRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderLayerRangeField("Hue", "hue", hue, -180, 180, `${hue}°`)}
      ${renderLayerRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
  `;
}

function isLayerAdjustableNode(node) {
  return Boolean(node && node.type !== "source" && node.type !== "viewer-output" && node.type !== "group");
}

function renderMultiSelectionInspector(selectedNodeIds) {
  const { graph } = getState();
  const nodes = selectedNodeIds.map((nodeId) => getNodeById(nodeId, graph)).filter(Boolean);
  const groupable = nodes.filter((node) => node.type !== "source" && node.type !== "viewer-output");
  const parentIds = new Set(groupable.map((node) => getNodeParentId(node)));
  const canGroup = groupable.length > 0 && parentIds.size === 1;
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Selection</header>
      <p class="hint">${nodes.length} nodes selected · ${groupable.length} groupable</p>
      <div class="node-panel-actions">
        <button type="button" data-graph-action="group-selected" ${canGroup ? "" : "disabled"}>Group Selected</button>
      </div>
    </section>
  `;
}

function renderGroupNode(node) {
  const { graph } = getState();
  const children = graph.nodes.filter((item) => getNodeParentId(item) === node.id);
  const boundary = node.group ?? {};
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Group</header>
      <p class="hint">${children.length} child node${children.length === 1 ? "" : "s"} · ${boundary.internalEdgeIds?.length ?? 0} internal edge${(boundary.internalEdgeIds?.length ?? 0) === 1 ? "" : "s"}</p>
      <div class="node-panel-actions">
        <button type="button" data-graph-action="open-group" data-group-id="${escapeHtml(node.id)}">Open Group</button>
        <button type="button" data-graph-action="ungroup" data-group-id="${escapeHtml(node.id)}">Ungroup</button>
      </div>
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Boundary</header>
      ${renderGroupBoundaryList("Inputs", boundary.inputBindings ?? [], "input")}
      ${renderGroupBoundaryList("Outputs", boundary.outputBindings ?? [], "output")}
    </section>
  `;
}

function renderGroupBoundaryList(label, bindings, direction) {
  if (!bindings.length) {
    return `<p class="hint">${label}: none</p>`;
  }
  const rows = bindings
    .map((binding) => renderGroupBoundaryRow(binding, direction))
    .join("");
  return `
    <div class="group-boundary-list">
      <p class="hint">${label}: ${bindings.length}</p>
      ${rows}
    </div>
  `;
}

function renderGroupBoundaryRow(binding, direction) {
  const { graph } = getState();
  const fromNode = getNodeById(binding.fromNode, graph);
  const toNode = getNodeById(binding.toNode, graph);
  const from = `${fromNode?.label ?? binding.fromNode}.${binding.fromSocket}`;
  const to = `${toNode?.label ?? binding.toNode}.${binding.toSocket}`;
  return `
    <div class="group-boundary-row">
      ${escapeHtml(direction === "input" ? `${from} -> ${to}` : `${from} -> ${to}`)}
    </div>
  `;
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

function renderMeshGradientNode(node) {
  const params = node.params;
  const stops = Array.isArray(params.stops) ? params.stops : [];
  const canAdd = stops.length < MESH_GRADIENT_MAX_STOPS;
  const canRemove = stops.length > 1;
  const complexity = Number(params.complexity ?? 50);
  const warp = Number(params.warp ?? 35);
  const speed = Number(params.speed ?? 25);
  const zoom = Number(params.zoom ?? 100);
  const width = Number(params.width ?? 1920);
  const height = Number(params.height ?? 1080);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title mesh-stops-header">
        <span>Color Stops</span>
        ${
          canAdd
            ? `<button class="mesh-stops-add" type="button" data-mesh-action="add-stop" title="Add color stop">+ Add</button>`
            : ""
        }
      </header>
      ${stops.map((stop, i) => renderMeshStopRow(stop, i, canRemove)).join("")}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Shape</header>
      ${renderRangeField("Complexity", "complexity", complexity, 0, 100, `${complexity}%`)}
      ${renderRangeField("Warp", "warp", warp, 0, 100, `${warp}%`)}
      ${renderRangeField("Zoom", "zoom", zoom, 25, 400, `${zoom}%`)}
      ${renderRangeField("Speed", "speed", speed, 0, 100, `${speed}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Width", "width", width, 256, 4096, `${width}px`)}
      ${renderRangeField("Height", "height", height, 256, 4096, `${height}px`)}
    </section>
  `;
}

function renderNoiseNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "perlin");
  const scale = Number(params.scale ?? 4);
  const octaves = Number(params.octaves ?? 4);
  const persistence = Number(params.persistence ?? 50);
  const seed = Number(params.seed ?? 0);
  const animSpeed = Number(params.animSpeed ?? 0);
  const width = Number(params.width ?? 1920);
  const height = Number(params.height ?? 1080);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Noise</header>
      ${renderSelectField("Type", "mode", mode, [
        ["perlin", "Perlin"],
        ["simplex", "Simplex"],
        ["value", "Value"],
      ])}
      ${renderRangeField("Scale", "scale", scale, 0.1, 64, String(scale))}
      ${renderRangeField("Octaves", "octaves", octaves, 1, 8, String(octaves))}
      ${renderRangeField("Persistence", "persistence", persistence, 0, 100, `${persistence}%`)}
      ${renderRangeField("Seed", "seed", seed, 0, 999, String(seed))}
      ${renderRangeField("Anim Speed", "animSpeed", animSpeed, 0, 200, `${animSpeed}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Width", "width", width, 256, 4096, `${width}px`)}
      ${renderRangeField("Height", "height", height, 256, 4096, `${height}px`)}
    </section>
  `;
}

function renderGradientNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "linear");
  const angle = Number(params.angle ?? 0);
  const centerX = Number(params.centerX ?? 50);
  const centerY = Number(params.centerY ?? 50);
  const radius = Number(params.radius ?? 75);
  const repeat = Number(params.repeat ?? 1);
  const shift = Number(params.shift ?? 0);
  const width = Number(params.width ?? 1920);
  const height = Number(params.height ?? 1080);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Gradient</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["linear", "Linear"],
        ["radial", "Radial"],
        ["conic", "Conic"],
      ])}
      ${renderGradientRampField("Ramp", "stops", params.stops, { maxStops: GRADIENT_RAMP_MAX_STOPS })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Shape</header>
      ${renderXyPadField("Center", "centerX", "centerY", centerX, centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Angle", "angle", angle, -180, 180, `${angle}deg`)}
      ${mode === "radial" ? renderRangeField("Radius", "radius", radius, 1, 200, `${radius}%`) : ""}
      ${renderRangeField("Repeat", "repeat", repeat, 1, 20, String(repeat))}
      ${renderRangeField("Shift", "shift", shift, -100, 100, `${shift}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Width", "width", width, 256, 4096, `${width}px`)}
      ${renderRangeField("Height", "height", height, 256, 4096, `${height}px`)}
    </section>
  `;
}

function renderMeshStopRow(stop, index, canRemove) {
  const idx = String(index);
  const color = normalizeHex(stop?.color, "#ffffff");
  const x = Math.round(Math.max(0, Math.min(1, Number(stop?.x ?? 0.5))) * 100);
  const y = Math.round(Math.max(0, Math.min(1, Number(stop?.y ?? 0.5))) * 100);
  const radiusPct = Math.round(Math.max(0.02, Math.min(2, Number(stop?.radius ?? 0.6))) * 100);
  return `
    <div class="mesh-stop-row" data-mesh-stop-index="${escapeHtml(idx)}">
      <header class="mesh-stop-row-head">
        <span class="mesh-stop-row-title">
          <span class="mesh-stop-swatch-dot" style="background:${escapeHtml(color)};"></span>
          Stop ${index + 1}
        </span>
        ${
          canRemove
            ? `<button class="mesh-stop-row-remove" type="button" data-mesh-action="remove-stop" data-mesh-stop-index="${escapeHtml(idx)}" title="Remove stop" aria-label="Remove stop ${index + 1}">×</button>`
            : ""
        }
      </header>
      ${renderColorPickerControl({
        label: `Stop ${index + 1}`,
        value: color,
        fallback: "#ffffff",
        target: { kind: "mesh-stop", stopIndex: idx },
        inputAttrs: `data-mesh-stop-field="color" data-mesh-stop-index="${escapeHtml(idx)}" data-input-kind="mesh-stop-hex"`,
      })}
      ${renderMeshStopRange("X", "x", index, x, 0, 100, `${x}%`)}
      ${renderMeshStopRange("Y", "y", index, y, 0, 100, `${y}%`)}
      ${renderMeshStopRange("Radius", "radius", index, radiusPct, 1, 200, `${radiusPct}%`)}
    </div>
  `;
}

function renderMeshStopRange(label, field, index, value, min, max, readout) {
  const safeField = escapeHtml(field);
  const safeIdx = String(index);
  return `
    <div class="field range-field">
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
        <span class="field-suffix">${escapeHtml(readout)}</span>
      </label>
      <div class="range-row">
        <input type="range" min="${min}" max="${max}" value="${value}"
          data-mesh-stop-field="${safeField}"
          data-mesh-stop-index="${safeIdx}"
          data-input-kind="mesh-stop-range" />
        <input type="number" class="num-edit" min="${min}" max="${max}" value="${value}"
          data-mesh-stop-field="${safeField}"
          data-mesh-stop-index="${safeIdx}"
          data-input-kind="mesh-stop-number" />
      </div>
    </div>
  `;
}

function commitMeshStopField(node, control) {
  const index = Number(control.dataset.meshStopIndex);
  const field = control.dataset.meshStopField;
  if (!Number.isFinite(index) || !field) return;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  if (index < 0 || index >= stops.length) return;
  const kind = control.dataset.inputKind;
  let next;
  if (field === "color") {
    next = normalizeHex(control.value, stops[index].color ?? "#ffffff");
  } else if (field === "radius") {
    const raw = Number(control.value);
    if (!Number.isFinite(raw)) return;
    next = Math.max(1, Math.min(200, raw)) / 100;
  } else {
    const raw = Number(control.value);
    if (!Number.isFinite(raw)) return;
    next = Math.max(0, Math.min(100, raw)) / 100;
  }
  const nextStops = stops.map((s, i) => (i === index ? { ...s, [field]: next } : s));
  updateNodeParams(node.id, { stops: nextStops });
  // Sibling range/number share data-mesh-stop-field+index — keep them in sync
  // without a full re-render so the user's drag does not lose focus.
  if (inspectorEl && (kind === "mesh-stop-range" || kind === "mesh-stop-number")) {
    const siblings = inspectorEl.querySelectorAll(
      `[data-mesh-stop-field="${cssEscape(field)}"][data-mesh-stop-index="${cssEscape(String(index))}"]`
    );
    for (const sib of siblings) {
      if (sib !== control && sib.value !== control.value) sib.value = control.value;
    }
  }
}

function handleMeshAction(node, control) {
  const action = control.dataset.meshAction;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  if (action === "add-stop") {
    if (stops.length >= MESH_GRADIENT_MAX_STOPS) return;
    const palette = [
      "#ff77aa", "#88ddff", "#ffe066", "#a78bfa",
      "#34d399", "#fb923c", "#60a5fa", "#f472b6",
    ];
    const newStop = {
      x: 0.5,
      y: 0.5,
      radius: 0.45,
      color: palette[stops.length % palette.length],
    };
    updateNodeParams(node.id, { stops: [...stops, newStop] });
    renderInspector();
  } else if (action === "remove-stop") {
    if (stops.length <= 1) return;
    const index = Number(control.dataset.meshStopIndex);
    if (!Number.isFinite(index) || index < 0 || index >= stops.length) return;
    const next = stops.filter((_, i) => i !== index);
    updateNodeParams(node.id, { stops: next });
    renderInspector();
  }
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

function renderLevelsNode(node) {
  const params = node.params;
  const inputBlack = Number(params.inputBlack ?? 0);
  const inputWhite = Number(params.inputWhite ?? 255);
  const gamma = Number(params.gamma ?? 100);
  const outputBlack = Number(params.outputBlack ?? 0);
  const outputWhite = Number(params.outputWhite ?? 255);
  const mode = String(params.mode ?? "rgb");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Input</header>
      ${renderRangeField("Black", "inputBlack", inputBlack, 0, 254, String(inputBlack))}
      ${renderRangeField("White", "inputWhite", inputWhite, 1, 255, String(inputWhite))}
      ${renderRangeField("Gamma", "gamma", gamma, 10, 400, (gamma / 100).toFixed(2))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Output</header>
      ${renderRangeField("Black", "outputBlack", outputBlack, 0, 255, String(outputBlack))}
      ${renderRangeField("White", "outputWhite", outputWhite, 0, 255, String(outputWhite))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mode</header>
      ${renderSelectField("Apply", "mode", mode, [
        ["rgb", "RGB"],
        ["luma", "Luma only"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

function renderDuotoneNode(node) {
  const params = node.params;
  const shadowColor = params.shadowColor ?? "#101010";
  const highlightColor = params.highlightColor ?? "#f4b642";
  const redGamma = Number(params.redGamma ?? 100);
  const greenGamma = Number(params.greenGamma ?? 100);
  const blueGamma = Number(params.blueGamma ?? 100);
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Colors</header>
      ${renderColorField("Shadow", "shadowColor", shadowColor, { fallback: "#101010" })}
      ${renderColorField("Highlight", "highlightColor", highlightColor, { fallback: "#f4b642" })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Channel Gamma</header>
      ${renderRangeField("Red", "redGamma", redGamma, 10, 500, (redGamma / 100).toFixed(2))}
      ${renderRangeField("Green", "greenGamma", greenGamma, 10, 500, (greenGamma / 100).toFixed(2))}
      ${renderRangeField("Blue", "blueGamma", blueGamma, 10, 500, (blueGamma / 100).toFixed(2))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

function renderGradientMapNode(node) {
  const params = node.params;
  const stops = normalizeGradientMapInspectorStops(params.stops);
  const repeat = Number(params.repeat ?? 1);
  const shift = Number(params.shift ?? 0);
  const mode = String(params.mode ?? "luma");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Gradient</header>
      ${renderGradientRampField("Ramp", "stops", stops, { maxStops: GRADIENT_RAMP_MAX_STOPS })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mapping</header>
      ${renderSelectField("Signal", "mode", mode, [
        ["luma", "Luma"],
        ["r", "Red"],
        ["g", "Green"],
        ["b", "Blue"],
      ])}
      ${renderRangeField("Repeat", "repeat", repeat, 1, 20, String(repeat))}
      ${renderRangeField("Shift", "shift", shift, -100, 100, `${shift}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
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
  const lut = buildRgbCurveLut(params, prefix);
  const overlays = ["master", "red", "green", "blue"]
    .filter((channel) => channel !== prefix)
    .map((channel) => ({
      tone: channel,
      lut: buildRgbCurveLut(params, channel),
    }));
  const applyMode = String(params.applyMode ?? "normal");
  return `
    <section class="node-panel-section curves-panel">
      ${renderCurveChannelStrip(node, prefix)}
      ${renderSelectField("Apply Mode", "applyMode", applyMode, [
        ["normal", "Normal"],
        ["luma", "Luma"],
        ["color", "Color"],
      ])}
      ${renderCurveField(`${curveChannelLabel(prefix)} Curve`, `points_${prefix}`, points, {
        tone: prefix,
        lut,
        overlays,
        legacyChannel: prefix,
        hint: "Click curve to add a point. Drag points to remap tones. Right-click a point to delete.",
      })}
    </section>
  `;
}

function renderSceneGradeNode(node) {
  const params = node.params;
  const active = String(params.activeChannel ?? "master");
  const prefix = active === "red" || active === "green" || active === "blue" ? active : "master";
  const points = readCurvePoints(node, prefix);
  const lut = buildRgbCurveLut(params, prefix);
  const overlays = ["master", "red", "green", "blue"]
    .filter((channel) => channel !== prefix)
    .map((channel) => ({
      tone: channel,
      lut: buildRgbCurveLut(params, channel),
    }));
  const clampMin = Number(params.clampMin ?? 0);
  const clampMax = Number(params.clampMax ?? 100);
  const clampGamma = Number(params.clampGamma ?? 100);
  const colorMapFlag = String(params.colorMapEnabled ?? "off").toLowerCase();
  const colorMapEnabled =
    params.colorMapEnabled === true || colorMapFlag === "on" || colorMapFlag === "true";
  const stops = normalizeGradientMapInspectorStops(params.colorMapStops);

  return `
    <section class="node-panel-section curves-panel">
      ${renderCurveChannelStrip(node, prefix)}
      ${renderCurveField(`${curveChannelLabel(prefix)} Curve`, `points_${prefix}`, points, {
        tone: prefix,
        lut,
        overlays,
        legacyChannel: prefix,
        hint: "Scene-wide curve is applied after the graph chain and before export.",
      })}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Clamp Gamma</header>
      ${renderRangeField("Min", "clampMin", clampMin, 0, 99, `${clampMin}%`)}
      ${renderRangeField("Max", "clampMax", clampMax, 1, 100, `${clampMax}%`)}
      ${renderRangeField("Gamma", "clampGamma", clampGamma, 10, 400, (clampGamma / 100).toFixed(2))}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Color Map LUT</header>
      ${renderCheckboxField("Enable Color Map", "colorMapEnabled", colorMapEnabled)}
      ${colorMapEnabled ? `
        ${renderGradientRampField("Color Map", "colorMapStops", stops, {
          maxStops: GRADIENT_RAMP_MAX_STOPS,
        })}
      ` : ""}
    </section>
  `;
}

function readCurvePoints(node, channel) {
  return readRgbCurvePoints(node?.params, channel);
}

function renderCurveChannelStrip(node, activeChannel) {
  const active = normalizeCurveChannel(activeChannel);
  return `
    <div class="curve-channel-strip" role="group" aria-label="Curve channels">
      ${CURVE_CHANNELS.map((channel) => renderCurveChannelButton(node, channel, active)).join("")}
    </div>
  `;
}

function renderCurveChannelButton(node, channel, activeChannel) {
  const tone = normalizeCurveChannel(channel);
  const isActive = tone === activeChannel;
  const label = curveChannelLabel(tone);
  const shortLabel = tone === "master" ? "M" : tone.slice(0, 1).toUpperCase();
  const points = readCurveParamPoints(node, `points_${tone}`, tone);
  const path = buildCurvePath(points, 64);
  const color = curveStrokeColor(tone);
  return `
    <button
      type="button"
      class="curve-channel-button${isActive ? " is-active" : ""}"
      data-curve-channel="${escapeHtml(tone)}"
      aria-label="Select ${escapeHtml(label)} curve"
      aria-pressed="${isActive ? "true" : "false"}"
      title="${escapeHtml(label)}"
    >
      <span class="curve-channel-button-header">
        <span class="curve-channel-dot" style="background:${escapeHtml(color)}"></span>
        <span class="curve-channel-label">${escapeHtml(shortLabel)}</span>
      </span>
      <svg class="curve-channel-preview" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <line x1="0" y1="64" x2="64" y2="0" class="curve-channel-preview-diagonal"/>
        <path d="${escapeHtml(path)}" class="curve-channel-preview-path" stroke="${escapeHtml(color)}"/>
      </svg>
    </button>
  `;
}

function renderCurveField(label, paramKey, points, options = {}) {
  const safeKey = escapeHtml(paramKey);
  const tone = normalizeCurveTone(options.tone);
  const legacyAttr = options.legacyChannel
    ? ` data-curve-legacy-channel="${escapeHtml(options.legacyChannel)}"`
    : "";
  const hint = options.hint ? `<p class="hint">${escapeHtml(options.hint)}</p>` : "";
  const resetLabel = options.resetLabel ?? "Reset Curve";
  return `
    <div class="field curve-field" data-curve-field="${safeKey}">
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      <div class="curves-editor">
        ${renderCurveCanvas(points, {
          paramKey,
          tone,
          lut: options.lut,
          overlays: options.overlays,
          label,
          legacyChannel: options.legacyChannel,
        })}
      </div>
      <div class="curves-actions">
        <button type="button" data-curve-action="reset" data-curve-param="${safeKey}"${legacyAttr}>${escapeHtml(resetLabel)}</button>
      </div>
      ${hint}
    </div>
  `;
}

function renderCurveCanvas(points, options = {}) {
  const size = CURVE_CANVAS_SIZE;
  const paramKey = options.paramKey ?? "curve";
  const tone = normalizeCurveTone(options.tone);
  const safeKey = escapeHtml(paramKey);
  const safeTone = escapeHtml(tone);
  const legacyAttr = options.legacyChannel
    ? ` data-curve-legacy-channel="${escapeHtml(options.legacyChannel)}"`
    : "";
  const stroke = curveStrokeColor(tone);
  const path = buildCurvePath(points, size);
  const overlays = (Array.isArray(options.overlays) ? options.overlays : [])
    .map((overlay) => {
      const overlayTone = normalizeCurveTone(overlay.tone);
      const overlayPath = buildCurvePath(overlay.points ?? createIdentityCurvePoints(), size, overlay.lut);
      return `<path class="curve-overlay" d="${overlayPath}" fill="none" stroke="${curveStrokeColor(overlayTone)}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join("");
  const handles = renderCurveHandles(points, size);
  return `
    <svg
      class="curves-svg"
      viewBox="0 0 ${size} ${size}"
      data-curve-svg
      data-curve-param="${safeKey}"
      data-curve-tone="${safeTone}"
      ${legacyAttr}
      preserveAspectRatio="none"
      role="img"
      aria-label="${escapeHtml(options.label ?? "Curve")}"
    >
      <defs>
        <pattern id="curveGrid-${safeKey}" width="${size / 4}" height="${size / 4}" patternUnits="userSpaceOnUse">
          <path d="M ${size / 4} 0 L 0 0 0 ${size / 4}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="${size}" height="${size}" fill="rgba(0,0,0,0.34)"/>
      <rect width="${size}" height="${size}" fill="url(#curveGrid-${safeKey})"/>
      <line x1="0" y1="${size}" x2="${size}" y2="0" stroke="rgba(255,255,255,0.1)" stroke-dasharray="3 4"/>
      ${overlays}
      <path data-curve-main d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <g data-curve-handles>${handles}</g>
    </svg>
  `;
}

function renderCurveHandles(points, size) {
  return sanitizeCurvePoints(points)
    .map((point, index) => {
      const x = (Number(point.x) / 255) * size;
      const y = size - (Number(point.y) / 255) * size;
      return `
        <circle
          class="curve-handle"
          data-curve-handle="${index}"
          cx="${x}"
          cy="${y}"
          r="${CURVE_HANDLE_RADIUS}"
          role="button"
          tabindex="0"
          aria-label="Curve point ${index + 1}"
        />
      `;
    })
    .join("");
}

function normalizeCurveTone(value) {
  return ["master", "red", "green", "blue"].includes(value) ? value : "master";
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

function buildCurvePolyline(rawPoints, size, curveLut = null) {
  const lut = curveLut ?? buildCurveLut(rawPoints);
  const out = [];
  for (let x = 0; x <= 255; x += 4) {
    const y = lut[x];
    out.push(`${(x / 255) * size},${size - (y / 255) * size}`);
  }
  out.push(`${size},${size - (lut[255] / 255) * size}`);
  return out.join(" ");
}

function buildCurvePath(rawPoints, size, curveLut = null) {
  if (curveLut) return polylineToPath(buildCurvePolyline(rawPoints, size, curveLut));

  const points = sanitizeCurvePoints(rawPoints);
  if (points.length === 0) return "";
  if (points.length === 1) {
    const [x, y] = curvePointToSvg(points[0], size);
    return `M ${x} ${y}`;
  }

  const tangents = getMonotoneCurveTangents(points);
  const [startX, startY] = curvePointToSvg(points[0], size);
  const segments = [`M ${startX} ${startY}`];

  for (let index = 0; index < points.length - 1; index++) {
    const pointA = points[index];
    const pointB = points[index + 1];
    const width = pointB.x - pointA.x;
    const controlPointA = {
      x: pointA.x + width / 3,
      y: pointA.y + (width * (tangents[index] ?? 0)) / 3,
    };
    const controlPointB = {
      x: pointB.x - width / 3,
      y: pointB.y - (width * (tangents[index + 1] ?? 0)) / 3,
    };
    const [cp1x, cp1y] = curvePointToSvg(controlPointA, size);
    const [cp2x, cp2y] = curvePointToSvg(controlPointB, size);
    const [x, y] = curvePointToSvg(pointB, size);
    segments.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x} ${y}`);
  }

  return segments.join(" ");
}

function curvePointToSvg(point, size) {
  return [
    (Number(point.x) / 255) * size,
    size - (Number(point.y) / 255) * size,
  ];
}

function polylineToPath(polyline) {
  const points = String(polyline)
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length === 0) return "";
  const [startX, startY] = points[0];
  return [`M ${startX} ${startY}`, ...points.slice(1).map(([x, y]) => `L ${x} ${y}`)].join(" ");
}

function readCurveParamPoints(node, paramKey, legacyChannel = null) {
  const raw = node?.params?.[paramKey];
  if (Array.isArray(raw) && raw.length >= 2) return raw;
  if (legacyChannel) return readCurvePoints(node, legacyChannel);
  return createIdentityCurvePoints();
}

function resolveCurveTarget(element, node = getSelectedNode()) {
  const target = element?.closest?.("[data-curve-param]") ?? element;
  const paramKey = target?.dataset?.curveParam;
  if (paramKey) {
    return {
      paramKey,
      legacyChannel: target.dataset.curveLegacyChannel ?? null,
    };
  }
  if (node?.type === "rgb-curves") {
    const channel = normalizeCurveChannel(node.params?.activeChannel);
    return {
      paramKey: `points_${channel}`,
      legacyChannel: channel,
    };
  }
  return null;
}

function handleCurveClick(_action) {
  const node = getSelectedNode();
  if (!node) return;
  const target = resolveCurveTarget(_action, node);
  if (!target) return;
  commitCurvePoints(node.id, target.paramKey, createIdentityCurvePoints());
  renderInspector();
}

function handleCurveChannelClick(control) {
  const node = getSelectedNode();
  if (!node || (node.type !== "rgb-curves" && node.type !== "scene-grade")) return;
  const channel = normalizeCurveChannel(control.dataset.curveChannel);
  if (normalizeCurveChannel(node.params?.activeChannel) === channel) return;
  updateNodeParams(node.id, { activeChannel: channel });
  renderInspector();
}

function onInspectorPointerDown(event) {
  // AE-style scrubbable number input: drag horizontally to change the value
  // by step per pixel. Skip when the input already has focus so typing into
  // it still works normally.
  const numEdit = event.target.closest(".range-field .range-row .num-edit");
  if (numEdit && document.activeElement !== numEdit) {
    startNumEditScrub(event, numEdit);
    return;
  }

  const gradientRampStop = event.target.closest("[data-gradient-ramp-stop]");
  if (gradientRampStop) {
    startGradientRampStopDrag(event, gradientRampStop);
    return;
  }

  const colorSurface = event.target.closest("[data-color-picker-surface]");
  if (colorSurface) {
    startColorPickerDrag(event, colorSurface, "surface");
    return;
  }

  const colorHue = event.target.closest("[data-color-picker-hue]");
  if (colorHue) {
    startColorPickerDrag(event, colorHue, "hue");
    return;
  }

  const xyPad = event.target.closest("[data-xy-pad]");
  if (xyPad) {
    startXyPadInteraction(event, xyPad);
    return;
  }

  const svg = event.target.closest("[data-curve-svg]");
  if (!svg) return;
  const node = getSelectedNode();
  const target = resolveCurveTarget(svg, node);
  if (!node || !target) return;
  event.preventDefault();

  const handle = event.target.closest("[data-curve-handle]");
  const rect = svg.getBoundingClientRect();
  const toCurve = (clientX, clientY) => {
    const u = clamp((clientX - rect.left) / rect.width, 0, 1);
    const v = clamp((clientY - rect.top) / rect.height, 0, 1);
    return {
      x: clamp(Math.round(u * 255), 0, 255),
      y: clamp(Math.round((1 - v) * 255), 0, 255),
    };
  };

  inspectorEditing = true;
  let points = sanitizeCurvePoints(readCurveParamPoints(node, target.paramKey, target.legacyChannel));
  // F17.3e: snapshot the pre-drag points before any commit (including the
  // empty-area "drop a new point" branch below) so onUp can record one
  // history entry covering the drop + adjust as a single user action.
  const undoCurvePointsBefore = points.map((p) => ({ ...p }));
  let activeIndex;
  if (handle) {
    activeIndex = Number(handle.dataset.curveHandle);
  } else {
    // Empty-area click: drop a new point and keep the pointer "live" so the
    // user can fine-tune it without releasing. indexOf works because the
    // pushed cursor object survives the sort by reference, and the runtime
    // preserves x-order through sanitizeCurvePoints on later reads.
    const cursor = toCurve(event.clientX, event.clientY);
    points = commitCurvePoints(node.id, target.paramKey, [...points, cursor]);
    activeIndex = findClosestCurvePointIndex(points, cursor.x, cursor.y);
    syncCurveSvg(svg, points);
  }

  if (!Number.isFinite(activeIndex) || activeIndex < 0) return;

  document.body.classList.add("dragging-curve");
  try {
    svg.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    const selected = getSelectedNode() ?? node;
    const updated = sanitizeCurvePoints(readCurveParamPoints(selected, target.paramKey, target.legacyChannel));
    if (activeIndex < 0 || activeIndex >= updated.length) return;

    const next = toCurve(ev.clientX, ev.clientY);
    const isFirst = activeIndex === 0;
    const isLast = activeIndex === updated.length - 1;
    if (isFirst) next.x = 0;
    if (isLast) next.x = 255;
    if (!isFirst && !isLast) {
      next.x = clamp(
        next.x,
        updated[activeIndex - 1].x + MIN_CURVE_POINT_GAP,
        updated[activeIndex + 1].x - MIN_CURVE_POINT_GAP
      );
    }
    updated[activeIndex] = next;
    const normalized = commitCurvePoints(node.id, target.paramKey, updated);
    activeIndex = findClosestCurvePointIndex(normalized, next.x, next.y);
    syncCurveSvg(svg, normalized);
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    inspectorEditing = false;
    document.body.classList.remove("dragging-curve");
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {}
    // F17.3e flush: compare against the pre-drag snapshot and record one
    // history entry covering the whole drop + drag.
    const finalNode = getSelectedNode() ?? node;
    const finalPoints = sanitizeCurvePoints(
      readCurveParamPoints(finalNode, target.paramKey, target.legacyChannel),
    );
    if (!curvePointsEqual(undoCurvePointsBefore, finalPoints)) {
      const beforeCopy = undoCurvePointsBefore.map((p) => ({ ...p }));
      const afterCopy = finalPoints.map((p) => ({ ...p }));
      pushHistory({
        undo: () => commitCurvePoints(node.id, target.paramKey, beforeCopy),
        redo: () => commitCurvePoints(node.id, target.paramKey, afterCopy),
      });
    }
    renderInspector();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function curvePointsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
  }
  return true;
}

function startNumEditScrub(event, input) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();

  const min = Number(input.min);
  const max = Number(input.max);
  const startValue = Number(input.value);
  const range = Math.max(1, Math.abs(max - min));
  // One pixel of horizontal drag moves the value by 1/200th of the range,
  // with Shift = 10x for big-step scrubbing. For 0..100 sliders that's
  // ~0.5 / px, fine for ~70px of travel covering the full range; users who
  // need finer control can still type directly into the field.
  const baseStep = range / 200;

  if (!Number.isFinite(startValue)) return;

  let pointerLocked = false;
  try {
    input.requestPointerLock?.();
    pointerLocked = true;
  } catch {
    pointerLocked = false;
  }

  document.body.classList.add("scrubbing-num-edit");
  let accumulated = 0;

  const onMove = (ev) => {
    const deltaPx = pointerLocked ? ev.movementX : ev.clientX - event.clientX;
    accumulated = pointerLocked ? accumulated + deltaPx : deltaPx;
    const stepMultiplier = ev.shiftKey ? 10 : 1;
    const nextRaw = startValue + accumulated * baseStep * stepMultiplier;
    const next = Math.max(min, Math.min(max, nextRaw));
    if (input.value !== String(next)) {
      input.value = String(next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("scrubbing-num-edit");
    if (pointerLocked) {
      try {
        document.exitPointerLock?.();
      } catch {}
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function startXyPadInteraction(event, pad) {
  if (event.button !== 0) return;
  const node = getSelectedNode();
  if (!node || !resolveXyPadKeys(pad)) return;
  event.preventDefault();
  event.stopPropagation();

  inspectorEditing = true;
  document.body.classList.add("dragging-xy-pad");
  pad.focus?.();

  const commitFromPointer = (ev) => {
    const next = readXyPadPointerValue(pad, ev.clientX, ev.clientY);
    commitXyPadValue(pad, next.x, next.y);
  };

  commitFromPointer(event);

  try {
    pad.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    if (ev.buttons !== undefined && !(ev.buttons & 1)) return;
    commitFromPointer(ev);
  };

  const onUp = () => {
    pad.removeEventListener("pointermove", onMove);
    pad.removeEventListener("pointerup", onUp);
    pad.removeEventListener("pointercancel", onUp);
    inspectorEditing = false;
    document.body.classList.remove("dragging-xy-pad");
    try {
      pad.releasePointerCapture(event.pointerId);
    } catch {}
    renderInspector();
  };

  pad.addEventListener("pointermove", onMove);
  pad.addEventListener("pointerup", onUp);
  pad.addEventListener("pointercancel", onUp);
}

function onInspectorKeyDown(event) {
  if (event.key === "Escape" && colorPickerState) {
    colorPickerState = null;
    inspectorEditing = false;
    renderInspector();
    return;
  }

  const rampStop = event.target.closest?.("[data-gradient-ramp-stop]");
  if (rampStop && handleGradientRampKeyDown(event, rampStop)) {
    return;
  }

  const pad = event.target.closest?.("[data-xy-pad]");
  if (!pad) return;

  let dx = 0;
  let dy = 0;
  switch (event.key) {
    case "ArrowLeft":
      dx = -1;
      break;
    case "ArrowRight":
      dx = 1;
      break;
    case "ArrowUp":
      dy = resolveXyPadYAxis(pad) === "down" ? -1 : 1;
      break;
    case "ArrowDown":
      dy = resolveXyPadYAxis(pad) === "down" ? 1 : -1;
      break;
    default:
      return;
  }

  event.preventDefault();
  event.stopPropagation();

  const step = resolveXyPadStep(pad) * (event.shiftKey ? 10 : 1);
  const current = readXyPadCurrentValue(pad);
  inspectorEditing = true;
  commitXyPadValue(pad, current.x + dx * step, current.y + dy * step);
  inspectorEditing = false;
}

function resolveXyPadKeys(pad) {
  const xKey = pad?.dataset?.xyPadX;
  const yKey = pad?.dataset?.xyPadY;
  if (!xKey || !yKey) return null;
  return { xKey, yKey };
}

function resolveXyPadBounds(pad) {
  const min = Number(pad?.dataset?.xyPadMin ?? -1);
  const max = Number(pad?.dataset?.xyPadMax ?? 1);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { min: -1, max: 1 };
  }
  return min < max ? { min, max } : { min: max, max: min };
}

function resolveXyPadStep(pad) {
  const step = Number(pad?.dataset?.xyPadStep ?? 1);
  return Number.isFinite(step) && step > 0 ? step : 1;
}

function resolveXyPadYAxis(pad) {
  return pad?.dataset?.xyPadYAxis === "up" ? "up" : "down";
}

function readXyPadPointerValue(pad, clientX, clientY) {
  const rect = pad.getBoundingClientRect();
  const { min, max } = resolveXyPadBounds(pad);
  const range = Math.max(max - min, Number.EPSILON);
  const normalizedX = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const normalizedY = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  return {
    x: min + normalizedX * range,
    y: resolveXyPadYAxis(pad) === "down"
      ? min + normalizedY * range
      : min + (1 - normalizedY) * range,
  };
}

function readXyPadCurrentValue(pad) {
  return {
    x: Number(pad?.dataset?.xyPadValueX ?? 0),
    y: Number(pad?.dataset?.xyPadValueY ?? 0),
  };
}

function commitXyPadValue(pad, x, y) {
  const node = getSelectedNode();
  const keys = resolveXyPadKeys(pad);
  if (!node || !keys) return null;

  const next = normalizeXyPadValue(pad, x, y);
  updateNodeParams(node.id, {
    [keys.xKey]: next.x,
    [keys.yKey]: next.y,
  });
  commitParamPairToTimeline(node.id, keys.xKey, keys.yKey, next.x, next.y);
  syncXyPadSurface(pad, next.x, next.y);
  syncParamControlsByKey(keys.xKey, next.x);
  syncParamControlsByKey(keys.yKey, next.y);
  syncTimelineButtons();
  return next;
}

function normalizeXyPadValue(pad, x, y) {
  const { min, max } = resolveXyPadBounds(pad);
  const step = resolveXyPadStep(pad);
  return {
    x: clamp(roundToStep(x, step, min), min, max),
    y: clamp(roundToStep(y, step, min), min, max),
  };
}

function commitParamPairToTimeline(nodeId, xKey, yKey, xValue, yValue) {
  if (!commitParamValueToTimeline(nodeId, xKey, xValue)) {
    updateParamKeyframeAtCurrentTime(nodeId, xKey, xValue);
  }
  if (!commitParamValueToTimeline(nodeId, yKey, yValue)) {
    updateParamKeyframeAtCurrentTime(nodeId, yKey, yValue);
  }
}

function syncXyPadSurface(pad, x, y) {
  if (!pad) return;
  const { min, max } = resolveXyPadBounds(pad);
  const range = Math.max(max - min, Number.EPSILON);
  const clampedX = clamp(Number(x), min, max);
  const clampedY = clamp(Number(y), min, max);
  const xPct = ((clampedX - min) / range) * 100;
  const yPct = resolveXyPadYAxis(pad) === "down"
    ? ((clampedY - min) / range) * 100
    : (1 - (clampedY - min) / range) * 100;
  pad.dataset.xyPadValueX = String(clampedX);
  pad.dataset.xyPadValueY = String(clampedY);
  pad.style.setProperty("--xy-pad-x", `${xPct}%`);
  pad.style.setProperty("--xy-pad-y", `${yPct}%`);
  const field = pad.closest("[data-xy-pad-field]");
  const readout = field?.querySelector("[data-xy-pad-readout]");
  if (readout) readout.textContent = formatXyPadReadout(clampedX, clampedY, pad.dataset.xyPadUnit);
}

function syncParamControlsByKey(paramKey, value) {
  if (!paramKey || !inspectorEl) return;
  const normalized = String(value);
  const controls = inspectorEl.querySelectorAll(`[data-node-param="${cssEscape(paramKey)}"]`);
  for (const control of controls) {
    if (control.type === "checkbox") continue;
    if (control.value !== normalized) control.value = normalized;
  }
}

function roundToStep(value, step, min = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  if (!Number.isFinite(step) || step <= 0) return numeric;
  const rounded = Math.round((numeric - min) / step) * step + min;
  const decimals = stepDecimals(step);
  return Number(rounded.toFixed(decimals));
}

function stepDecimals(step) {
  const text = String(step);
  if (!text.includes(".")) return 0;
  return Math.min(6, text.split(".")[1].length);
}

function onInspectorContextMenu(event) {
  const handle = event.target.closest("[data-curve-handle]");
  if (!handle) return;
  const node = getSelectedNode();
  const target = resolveCurveTarget(handle, node);
  if (!node || !target) return;
  event.preventDefault();

  const points = sanitizeCurvePoints(readCurveParamPoints(node, target.paramKey, target.legacyChannel));
  const index = Number(handle.dataset.curveHandle);
  if (!Number.isFinite(index) || index <= 0 || index >= points.length - 1) return;
  points.splice(index, 1);
  commitCurvePoints(node.id, target.paramKey, points);
  renderInspector();
}

function commitCurvePoints(nodeId, paramKey, points) {
  const normalized = sanitizeCurvePoints(points);
  updateNodeParams(nodeId, { [paramKey]: normalized });
  if (!commitParamValueToTimeline(nodeId, paramKey, normalized)) {
    updateParamKeyframeAtCurrentTime(nodeId, paramKey, normalized);
  }
  return normalized;
}

function syncCurveSvg(svg, points) {
  if (!svg) return;
  const size = CURVE_CANVAS_SIZE;
  const mainPath = svg.querySelector("[data-curve-main]");
  if (mainPath) mainPath.setAttribute("d", buildCurvePath(points, size));
  const handleLayer = svg.querySelector("[data-curve-handles]");
  if (handleLayer) handleLayer.innerHTML = renderCurveHandles(points, size);
}

function handleGradientRampClick(event, control) {
  const target = resolveGradientRampTarget(control);
  if (!target) return;

  if (control.matches("[data-gradient-ramp-stop]")) {
    selectGradientRampStop(target, Number(control.dataset.gradientRampStop));
    return;
  }

  const action = control.dataset.gradientRampAction;
  if (action === "add") {
    addGradientRampStop(target, findGradientRampInsertPosition(readGradientRampStops(target)));
    return;
  }
  if (action === "delete") {
    removeSelectedGradientRampStop(target);
    return;
  }

  if (control.matches("[data-gradient-ramp-bar]")) {
    addGradientRampStop(target, gradientRampPositionFromEvent(control, event.clientX));
  }
}

function handleGradientRampKeyDown(event, stop) {
  const target = resolveGradientRampTarget(stop);
  if (!target) return false;
  const index = Number(stop.dataset.gradientRampStop);
  if (!Number.isFinite(index)) return false;

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectGradientRampStop(target, index);
    return true;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    selectGradientRampStop(target, index, { render: false });
    removeSelectedGradientRampStop(target);
    return true;
  }

  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;

  event.preventDefault();
  const stops = readGradientRampStops(target);
  if (index <= 0 || index >= stops.length - 1) {
    selectGradientRampStop(target, index);
    return true;
  }

  const direction = event.key === "ArrowLeft" ? -1 : 1;
  const step = event.shiftKey ? 0.05 : 0.01;
  gradientRampState = { targetId: target.targetId, selectedIndex: index };
  colorPickerState = null;
  commitGradientRampStopPosition(target, index, stops[index].pos + direction * step);
  renderInspector();
  return true;
}

function startGradientRampStopDrag(event, stop) {
  if (event.button !== 0) return;
  const target = resolveGradientRampTarget(stop);
  if (!target) return;
  const root = stop.closest("[data-gradient-ramp-target]");
  const index = Number(stop.dataset.gradientRampStop);
  const stops = readGradientRampStops(target);
  if (!Number.isFinite(index) || index < 0 || index >= stops.length) return;

  gradientRampState = { targetId: target.targetId, selectedIndex: index };
  colorPickerState = null;
  if (index === 0 || index === stops.length - 1) return;

  event.preventDefault();
  event.stopPropagation();
  inspectorEditing = true;
  document.body.classList.add("dragging-gradient-ramp");

  // F17.3d: snapshot the pre-drag stops so onUp can record a single history
  // entry covering the whole drag rather than one per pointermove commit.
  const undoStopsBefore = stops.map((s) => ({ ...s }));

  const bar = root?.querySelector("[data-gradient-ramp-bar]");
  const commitFromPointer = (ev) => {
    if (!bar) return;
    const nextPosition = gradientRampPositionFromEvent(bar, ev.clientX);
    const nextStops = commitGradientRampStopPosition(target, index, nextPosition);
    if (nextStops) syncGradientRampRoot(root, nextStops, index);
  };

  commitFromPointer(event);

  const onMove = (ev) => {
    if (ev.buttons !== undefined && !(ev.buttons & 1)) return;
    commitFromPointer(ev);
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    inspectorEditing = false;
    document.body.classList.remove("dragging-gradient-ramp");
    // F17.3d flush
    pushGradientRampUndoEntry(target, undoStopsBefore);
    renderInspector();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function pushGradientRampUndoEntry(target, stopsBefore) {
  const stopsAfter = readGradientRampStops(target);
  if (gradientRampStopsEqual(stopsBefore, stopsAfter)) return;
  const beforeCopy = stopsBefore.map((s) => ({ ...s }));
  const afterCopy = stopsAfter.map((s) => ({ ...s }));
  pushHistory({
    undo: () => commitGradientRampStops(target.nodeId, target.paramKey, beforeCopy),
    redo: () => commitGradientRampStops(target.nodeId, target.paramKey, afterCopy),
  });
}

function gradientRampStopsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pos !== b[i].pos || a[i].color !== b[i].color) return false;
  }
  return true;
}

function resolveGradientRampTarget(element) {
  const root = element?.closest?.("[data-gradient-ramp-target]");
  if (!root) return null;
  const paramKey = root.dataset.gradientRampParam || "stops";
  const targetId = root.dataset.gradientRampTarget || gradientRampTargetId(root.dataset.gradientRampNode, paramKey);
  return {
    nodeId: root.dataset.gradientRampNode || getSelectedNode()?.id || "",
    paramKey,
    targetId,
    maxStops: Math.max(
      2,
      Math.round(Number(root.dataset.gradientRampMaxStops) || GRADIENT_RAMP_MAX_STOPS)
    ),
  };
}

function gradientRampTargetId(nodeId, paramKey) {
  return `gradient-ramp:${nodeId || "none"}:${paramKey || "stops"}`;
}

function getGradientRampSelectedIndex(targetId, stops) {
  const rawIndex = gradientRampState?.targetId === targetId
    ? Number(gradientRampState.selectedIndex)
    : 0;
  const index = Number.isFinite(rawIndex) ? Math.round(rawIndex) : 0;
  return Math.max(0, Math.min(Math.max(0, stops.length - 1), index));
}

function selectGradientRampStop(target, index, options = {}) {
  const stops = readGradientRampStops(target);
  const selectedIndex = Math.max(0, Math.min(Math.max(0, stops.length - 1), Math.round(index)));
  gradientRampState = { targetId: target.targetId, selectedIndex };
  colorPickerState = null;
  if (options.render === false) return;
  renderInspector();
}

function addGradientRampStop(target, position) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return;
  const stops = readGradientRampStops(target);
  if (stops.length >= target.maxStops) return;
  // F17.3d: snapshot before so undo restores the pre-add state.
  const stopsBefore = stops.map((s) => ({ ...s }));
  const pos = clamp(Number(position), GRADIENT_RAMP_STOP_GAP, 1 - GRADIENT_RAMP_STOP_GAP);
  const color = sampleGradientRampColor(stops, pos);
  const nextStops = normalizeGradientRampEditableStops([...stops, { pos, color }]);
  const selectedIndex = findClosestGradientRampStopIndex(nextStops, pos, color);
  gradientRampState = { targetId: target.targetId, selectedIndex };
  colorPickerState = null;
  commitGradientRampStops(node.id, target.paramKey, nextStops);
  pushGradientRampUndoEntry(target, stopsBefore);
  renderInspector();
}

function removeSelectedGradientRampStop(target) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return;
  const stops = readGradientRampStops(target);
  const selectedIndex = getGradientRampSelectedIndex(target.targetId, stops);
  if (selectedIndex <= 0 || selectedIndex >= stops.length - 1 || stops.length <= 2) return;
  // F17.3d: snapshot before remove so undo brings the stop back.
  const stopsBefore = stops.map((s) => ({ ...s }));
  const nextStops = stops.filter((_, index) => index !== selectedIndex);
  const nextSelectedIndex = Math.max(0, selectedIndex - 1);
  gradientRampState = { targetId: target.targetId, selectedIndex: nextSelectedIndex };
  colorPickerState = null;
  commitGradientRampStops(node.id, target.paramKey, nextStops);
  pushGradientRampUndoEntry(target, stopsBefore);
  renderInspector();
}

function commitGradientRampStopPosition(target, index, position) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return null;
  const stops = readGradientRampStops(target);
  if (index <= 0 || index >= stops.length - 1) return stops;
  const nextStops = stops.map((stop) => ({ ...stop }));
  nextStops[index].pos = constrainGradientRampStopPosition(nextStops, index, position);
  return commitGradientRampStops(node.id, target.paramKey, nextStops);
}

function commitGradientRampStops(nodeId, paramKey, stops) {
  const normalized = normalizeGradientRampEditableStops(stops);
  updateNodeParams(nodeId, { [paramKey]: normalized });
  if (!commitParamValueToTimeline(nodeId, paramKey, normalized)) {
    updateParamKeyframeAtCurrentTime(nodeId, paramKey, normalized);
  }
  return normalized;
}

function syncGradientRampRoot(root, stops, selectedIndex = null) {
  if (!root) return;
  const normalized = normalizeGradientRampEditableStops(stops);
  const activeIndex = selectedIndex === null
    ? getGradientRampSelectedIndex(root.dataset.gradientRampTarget, normalized)
    : Math.max(0, Math.min(normalized.length - 1, Math.round(selectedIndex)));
  const bar = root.querySelector("[data-gradient-ramp-bar]");
  if (bar) bar.style.background = buildGradientRampCss(normalized);
  const buttons = Array.from(root.querySelectorAll("[data-gradient-ramp-stop]"));
  buttons.forEach((button, index) => {
    const stop = normalized[index];
    if (!stop) return;
    const color = normalizeHex(stop.color, "#ffffff");
    const position = clamp01(stop.pos) * 100;
    button.dataset.gradientRampStop = String(index);
    button.style.left = `${position}%`;
    button.style.setProperty("--gradient-stop-color", color);
    button.classList.toggle("is-selected", index === activeIndex);
    button.classList.toggle("is-endpoint", index === 0 || index === normalized.length - 1);
    button.setAttribute("aria-pressed", index === activeIndex ? "true" : "false");
    button.setAttribute("title", `${Math.round(position)}%`);
  });
  const readout = root.querySelector("[data-gradient-ramp-readout]");
  const selectedStop = normalized[activeIndex];
  if (readout && selectedStop) readout.textContent = `${Math.round(clamp01(selectedStop.pos) * 100)}%`;
}

function syncGradientRampElements(target) {
  if (!inspectorEl || target?.kind !== "gradient-stop") return;
  const node = getSelectedNode();
  const paramKey = target.paramKey || "stops";
  if (!node) return;
  const root = inspectorEl.querySelector(
    `[data-gradient-ramp-node="${cssEscape(node.id)}"][data-gradient-ramp-param="${cssEscape(paramKey)}"]`
  );
  if (!root) return;
  const stops = normalizeGradientRampEditableStops(node.params?.[paramKey]);
  syncGradientRampRoot(root, stops, target.stopIndex);
}

function readGradientRampStops(target) {
  const node = getSelectedNode();
  if (!node || node.id !== target.nodeId) return [];
  return normalizeGradientRampEditableStops(node.params?.[target.paramKey]);
}

function normalizeGradientRampEditableStops(value) {
  const stops = normalizeGradientMapInspectorStops(value).map((stop) => ({
    pos: clamp01(Number(stop.pos)),
    color: normalizeHex(stop.color, "#ffffff"),
  }));
  if (stops.length <= 1) return stops;

  stops.sort((a, b) => a.pos - b.pos);
  stops[0].pos = 0;
  stops[stops.length - 1].pos = 1;
  for (let index = 1; index < stops.length - 1; index++) {
    stops[index].pos = clamp(stops[index].pos, GRADIENT_RAMP_STOP_GAP, 1 - GRADIENT_RAMP_STOP_GAP);
  }
  for (let index = 1; index < stops.length - 1; index++) {
    stops[index].pos = Math.max(stops[index].pos, stops[index - 1].pos + GRADIENT_RAMP_STOP_GAP);
  }
  for (let index = stops.length - 2; index > 0; index--) {
    stops[index].pos = Math.min(stops[index].pos, stops[index + 1].pos - GRADIENT_RAMP_STOP_GAP);
  }
  return stops;
}

function constrainGradientRampStopPosition(stops, index, position) {
  const min = stops[index - 1].pos + GRADIENT_RAMP_STOP_GAP;
  const max = stops[index + 1].pos - GRADIENT_RAMP_STOP_GAP;
  return clamp(Number(position), min, max);
}

function findGradientRampInsertPosition(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return 0.5;
  let bestPosition = 0.5;
  let bestGap = 0;
  for (let index = 0; index < stops.length - 1; index++) {
    const start = clamp01(stops[index].pos);
    const end = clamp01(stops[index + 1].pos);
    const gap = end - start;
    if (gap > bestGap) {
      bestGap = gap;
      bestPosition = start + gap / 2;
    }
  }
  return clamp(bestPosition, GRADIENT_RAMP_STOP_GAP, 1 - GRADIENT_RAMP_STOP_GAP);
}

function gradientRampPositionFromEvent(bar, clientX) {
  const rect = bar.getBoundingClientRect();
  return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
}

function findClosestGradientRampStopIndex(stops, position, color) {
  const targetColor = normalizeHex(color, "#ffffff");
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  stops.forEach((stop, index) => {
    const colorDistance = normalizeHex(stop.color, "#ffffff") === targetColor ? 0 : 1;
    const distance = Math.abs(clamp01(stop.pos) - clamp01(position)) + colorDistance;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function sampleGradientRampColor(stops, position) {
  const normalized = normalizeGradientRampEditableStops(stops);
  const pos = clamp01(position);
  if (normalized.length === 0) return "#808080";
  if (pos <= normalized[0].pos) return normalized[0].color;
  for (let index = 0; index < normalized.length - 1; index++) {
    const left = normalized[index];
    const right = normalized[index + 1];
    if (pos > right.pos) continue;
    const span = Math.max(0.0001, right.pos - left.pos);
    const amount = clamp01((pos - left.pos) / span);
    const [lr, lg, lb] = hexToRgb255(left.color);
    const [rr, rg, rb] = hexToRgb255(right.color);
    return rgbChannelsToHex(
      lr + (rr - lr) * amount,
      lg + (rg - lg) * amount,
      lb + (rb - lb) * amount
    );
  }
  return normalized.at(-1).color;
}

function buildGradientRampCss(stops) {
  const normalized = normalizeGradientRampEditableStops(stops);
  const stopsCss = normalized
    .map((stop) => `${normalizeHex(stop.color, "#ffffff")} ${Math.round(clamp01(stop.pos) * 10000) / 100}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stopsCss})`;
}

function findClosestCurvePointIndex(points, x, y) {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const dx = point.x - x;
    const dy = point.y - y;
    const distance = dx * dx + dy * dy;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function normalizeCurveChannel(value) {
  return ["master", "red", "green", "blue"].includes(value) ? value : "master";
}

function curveChannelLabel(channel) {
  switch (normalizeCurveChannel(channel)) {
    case "red":
      return "Red";
    case "green":
      return "Green";
    case "blue":
      return "Blue";
    case "master":
    default:
      return "Master";
  }
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
  const source = String(params.source ?? "luma");
  const mode = String(params.mode ?? "multiply");
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Apply</header>
      ${renderSelectField(
        "Source",
        "source",
        source,
        MASK_SOURCES.map((s) => [s.value, s.label])
      )}
      ${renderSelectField(
        "Mode",
        "mode",
        mode,
        MASK_MODES.map((m) => [m.value, m.label])
      )}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Feather", "feather", feather, 0, 50, `${feather}px`)}
      ${renderSelectField("Invert Mask", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      <p class="hint">Source picks which mask channel reads. Stencil mode hard-clips at 50%; Multiply fades continuously.</p>
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
      ${renderXyPadField("Translate", "translateX", "translateY", params.translateX, params.translateY, {
        min: -100,
        max: 100,
        step: 1,
        unit: "%",
      })}
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
  // Glow merges the old Bloom node into Glare: GPU variants are the fast
  // modern paths; CPU types remain for back-compat and WebGL fallback.
  const typeOptions = [
    ["bloom-gpu", "Bloom (GPU, fast)"],
    ["star-gpu", "Star Glow (GPU)"],
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
  // GPU types composite inside their shaders; CPU legacy types still expose
  // the blend selector used by the canvas compositor below.
  const isGpu = type === "bloom-gpu" || type === "star-gpu";
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
  } else if (type === "star-gpu") {
    const knee = Number(params.knee ?? 20);
    const streaks = Number(params.streaks ?? 4);
    const angle = Number(params.angle ?? 0);
    const length = Number(params.length ?? 64);
    const falloff = Number(params.falloff ?? 80);
    const alternate = Number(params.alternate ?? 100);
    const colorize = Number(params.colorize ?? 0);
    typeFields = `
      ${renderRangeField("Knee", "knee", knee, 0, 50, `${knee}%`)}
      ${renderRangeField("Streaks", "streaks", streaks, 1, 8, String(streaks))}
      ${renderRangeField("Angle", "angle", angle, 0, 180, `${angle}°`)}
      ${renderRangeField("Length", "length", length, 1, 192, `${length}px`)}
      ${renderRangeField("Falloff", "falloff", falloff, 1, 100, `${falloff}%`)}
      ${renderRangeField("Alternate", "alternate", alternate, 0, 100, `${alternate}%`)}
      ${renderRangeField("Colorize", "colorize", colorize, 0, 100, `${colorize}%`)}
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
      ${renderXyPadField("Center", "centerX", "centerY", params.centerX, params.centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Center X", "centerX", params.centerX, 0, 100, `${params.centerX}%`)}
      ${renderRangeField("Center Y", "centerY", params.centerY, 0, 100, `${params.centerY}%`)}
      ${renderRangeField("Vignette", "vignette", params.vignette, 0, 100, `${params.vignette}%`)}
    </section>
  `;
}

function renderDisplaceNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "wave");
  const mapMode = String(params.mapMode ?? "rg");
  const mapFit = String(params.mapFit ?? "stretch");
  const debugMap = String(params.debugMap ?? "off");
  const filter = params.filter ?? "linear";
  const xAmount = Number(params.xAmount ?? 16);
  const yAmount = Number(params.yAmount ?? 0);
  const strength = Number(params.strength ?? 100);
  const frequency = Number(params.frequency ?? 4);
  const phase = Number(params.phase ?? 0);
  const mapScale = Number(params.mapScale ?? 100);
  const mapOffsetX = Number(params.mapOffsetX ?? 0);
  const mapOffsetY = Number(params.mapOffsetY ?? 0);
  const hasMapInput = (getState().graph?.edges ?? []).some(
    (edge) => edge.toNode === node.id && edge.toSocket === "map"
  );
  const waveFields = mode === "wave"
    ? `
      <section class="node-panel-section node-panel-section--titled">
        <header class="node-panel-section-title">Wave</header>
        ${renderRangeField("Frequency", "frequency", frequency, 1, 32, `${frequency}x`)}
        ${renderRangeField("Phase", "phase", phase, 0, 360, `${phase}°`)}
      </section>
    `
    : `
      <section class="node-panel-section node-panel-section--titled">
        <header class="node-panel-section-title">Map</header>
        ${renderSelectField("Map Mode", "mapMode", mapMode, [
          ["rg", "RG Vector"],
          ["luma", "Luma Height"],
        ])}
        ${renderSelectField("Map Fit", "mapFit", mapFit, [
          ["stretch", "Stretch"],
          ["fit", "Fit"],
          ["fill", "Fill"],
          ["tile", "Tile"],
        ])}
        ${mapFit === "tile" ? renderRangeField("Texture Scale", "mapScale", mapScale, 10, 800, `${mapScale}%`) : ""}
        ${mapFit === "stretch" ? "" : renderXyPadField("Offset", "mapOffsetX", "mapOffsetY", mapOffsetX, mapOffsetY, {
          min: -100,
          max: 100,
          step: 1,
          unit: "%",
        })}
        ${mapFit === "stretch" ? "" : renderRangeField("Offset X", "mapOffsetX", mapOffsetX, -100, 100, `${mapOffsetX}%`)}
        ${mapFit === "stretch" ? "" : renderRangeField("Offset Y", "mapOffsetY", mapOffsetY, -100, 100, `${mapOffsetY}%`)}
        ${renderSelectField("Debug", "debugMap", debugMap, [
          ["off", "Off"],
          ["map", "Map"],
          ["vectors", "Vectors"],
        ])}
        ${mapMode === "luma"
          ? renderCurveField("Map Curve", "mapCurve", params.mapCurve ?? createIdentityCurvePoints(), {
              tone: "master",
              hint: "Shape luma before it becomes displacement height.",
            })
          : ""}
        ${hasMapInput ? "" : `<p class="hint">Connect an image to the Map input.</p>`}
      </section>
    `;
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["wave", "Wave"],
        ["map", "Map input"],
      ])}
      ${renderXyPadField("Amount", "xAmount", "yAmount", xAmount, yAmount, {
        min: -200,
        max: 200,
        step: 1,
        unit: "px",
      })}
      ${renderRangeField("X Amount", "xAmount", xAmount, -200, 200, `${xAmount}px`)}
      ${renderRangeField("Y Amount", "yAmount", yAmount, -200, 200, `${yAmount}px`)}
      ${renderRangeField("Strength", "strength", strength, 0, 400, `${strength}%`)}
      ${renderSelectField("Filter", "filter", filter, [
        ["linear", "Linear"],
        ["nearest", "Nearest"],
      ])}
    </section>
    ${waveFields}
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
      ${renderXyPadField("Center", "centerX", "centerY", params.centerX, params.centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
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
  const tapeResolution = Number(params.tapeResolution ?? 100);
  const jitter = Number(params.jitter ?? 0);
  const flicker = Number(params.flicker ?? 0);
  const dropouts = Number(params.dropouts ?? 0);
  const crease = Number(params.crease ?? 0);
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
            ${renderRangeField("Tape Resolution", "tapeResolution", tapeResolution, 25, 200, `${tapeResolution}%`)}
            ${renderRangeField("Jitter", "jitter", jitter, 0, 100, `${jitter}%`)}
            ${renderRangeField("Flicker", "flicker", flicker, 0, 100, `${flicker}%`)}
            ${renderRangeField("Dropouts", "dropouts", dropouts, 0, 100, `${dropouts}%`)}
            ${renderRangeField("Crease", "crease", crease, 0, 100, `${crease}%`)}
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

function renderLedScreenNode(node) {
  const params = node.params;
  const cellSize = Number(params.cellSize ?? 6);
  const gap = Number(params.gap ?? 18);
  const subpixelMode = String(params.subpixelMode ?? "rgb");
  const shape = String(params.shape ?? "round");
  const softness = Number(params.softness ?? 35);
  const glow = Number(params.glow ?? 18);
  const brightness = Number(params.brightness ?? 110);
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section">
      ${renderRangeField("Cell Size", "cellSize", cellSize, 2, 48, `${cellSize}px`)}
      ${renderRangeField("Gap", "gap", gap, 0, 80, `${gap}%`)}
      ${renderSelectField("Subpixel", "subpixelMode", subpixelMode, [
        ["off", "Off"],
        ["rgb", "RGB"],
        ["bgr", "BGR"],
        ["triad", "Triad"],
      ])}
      ${renderSelectField("Shape", "shape", shape, [
        ["round", "Round"],
        ["square", "Square"],
        ["slot", "Slot"],
      ])}
      ${renderRangeField("Softness", "softness", softness, 0, 100, `${softness}%`)}
      ${renderRangeField("Glow", "glow", glow, 0, 100, `${glow}%`)}
      ${renderRangeField("Brightness", "brightness", brightness, 25, 300, `${brightness}%`)}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

function renderModulationNode(node) {
  const params = node.params;
  const frequency = Number(params.frequency ?? 80);
  const sensitivity = Number(params.sensitivity ?? 35);
  const thickness = Number(params.thickness ?? 18);
  const angle = Number(params.angle ?? 0);
  const channelMode = String(params.channelMode ?? "rgb");
  const sourceMix = Number(params.sourceMix ?? 0);
  const invert = String(params.invert ?? "off");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Frequency", "frequency", frequency, 4, 320, String(frequency))}
      ${renderRangeField("Angle", "angle", angle, -180, 180, `${angle}deg`)}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Signal</header>
      ${renderSelectField("Channel", "channelMode", channelMode, [
        ["luma", "Luma"],
        ["rgb", "RGB"],
      ])}
      ${renderRangeField("Sensitivity", "sensitivity", sensitivity, 0, 200, `${sensitivity}%`)}
      ${renderRangeField("Thickness", "thickness", thickness, 1, 100, `${thickness}%`)}
      ${renderRangeField("Source Mix", "sourceMix", sourceMix, 0, 100, `${sourceMix}%`)}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
    </section>
  `;
}

function renderPixelSortingNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "glitch");
  const threshold = Number(params.threshold ?? 50);
  const softness = Number(params.softness ?? 10);
  const angle = Number(params.angle ?? 0);
  const length = Number(params.length ?? 24);
  const iterations = Number(params.iterations ?? 8);
  const channel = String(params.channel ?? "luma");
  const direction = String(params.direction ?? "bright");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["glitch", "Glitch Sort"],
      ])}
      ${renderRangeField("Angle", "angle", angle, -180, 180, `${angle}deg`)}
      ${renderRangeField("Length", "length", length, 1, 256, `${length}px`)}
      ${renderRangeField("Samples", "iterations", iterations, 1, 32, String(iterations))}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mask</header>
      ${renderRangeField("Threshold", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Softness", "softness", softness, 0, 50, `${softness}%`)}
      ${renderSelectField("Channel", "channel", channel, [
        ["luma", "Luma"],
        ["r", "Red"],
        ["g", "Green"],
        ["b", "Blue"],
        ["max", "Max RGB"],
      ])}
      ${renderSelectField("Direction", "direction", direction, [
        ["bright", "Bright"],
        ["dark", "Dark"],
      ])}
    </section>
  `;
}

function renderDepthOfFieldNode(node) {
  const params = node.params;
  const centerX = Number(params.centerX ?? 50);
  const centerY = Number(params.centerY ?? 50);
  const radius = Number(params.radius ?? 35);
  const falloff = Number(params.falloff ?? 25);
  const aspect = Number(params.aspect ?? 100);
  const rotation = Number(params.rotation ?? 0);
  const invert = String(params.invert ?? "off");
  const blur = Number(params.blur ?? 16);
  const samples = Number(params.samples ?? 32);
  const bokehShape = String(params.bokehShape ?? "round");
  const blades = Number(params.blades ?? 6);
  const anamorphic = Number(params.anamorphic ?? 100);
  const debug = String(params.debug ?? "off");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Focus</header>
      ${renderXyPadField("Center", "centerX", "centerY", centerX, centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Center X", "centerX", centerX, 0, 100, `${centerX}%`)}
      ${renderRangeField("Center Y", "centerY", centerY, 0, 100, `${centerY}%`)}
      ${renderRangeField("Radius", "radius", radius, 0, 100, `${radius}%`)}
      ${renderRangeField("Falloff", "falloff", falloff, 0, 100, `${falloff}%`)}
      ${renderRangeField("Aspect", "aspect", aspect, 25, 400, `${(aspect / 100).toFixed(2)}x`)}
      ${renderRangeField("Rotation", "rotation", rotation, -180, 180, `${rotation}deg`)}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Blur</header>
      ${renderRangeField("Blur", "blur", blur, 0, 80, `${blur}px`)}
      ${renderRangeField("Samples", "samples", samples, 8, 64, String(samples))}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Bokeh</header>
      ${renderSelectField("Shape", "bokehShape", bokehShape, [
        ["round", "Round"],
        ["polygon", "Polygon"],
      ])}
      ${renderRangeField("Blades", "blades", blades, 3, 12, String(blades))}
      ${renderRangeField("Anamorphic", "anamorphic", anamorphic, 25, 400, `${(anamorphic / 100).toFixed(2)}x`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Debug</header>
      ${renderSelectField("Debug", "debug", debug, [
        ["off", "Off"],
        ["mask", "Mask"],
      ])}
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
  const tapeResolution = Number(params.tapeResolution ?? 100);
  const jitter = Number(params.jitter ?? 0);
  const flicker = Number(params.flicker ?? 0);
  const dropouts = Number(params.dropouts ?? 0);
  const crease = Number(params.crease ?? 0);
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
      ${renderRangeField("Tape Resolution", "tapeResolution", tapeResolution, 25, 200, `${tapeResolution}%`)}
      ${renderRangeField("Jitter", "jitter", jitter, 0, 100, `${jitter}%`)}
      ${renderRangeField("Flicker", "flicker", flicker, 0, 100, `${flicker}%`)}
      ${renderRangeField("Dropouts", "dropouts", dropouts, 0, 100, `${dropouts}%`)}
      ${renderRangeField("Crease", "crease", crease, 0, 100, `${crease}%`)}
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
  const signalBlack = Number(params.signalBlack ?? 0);
  const signalWhite = Number(params.signalWhite ?? 100);
  const signalGamma = Number(params.signalGamma ?? 100);
  const presenceThreshold = Number(params.presenceThreshold ?? 0);
  const presenceSoftness = Number(params.presenceSoftness ?? 0);
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
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Signal</header>
      ${renderRangeField("Black Point", "signalBlack", signalBlack, 0, 100, `${signalBlack}%`)}
      ${renderRangeField("White Point", "signalWhite", signalWhite, 0, 100, `${signalWhite}%`)}
      ${renderRangeField("Gamma", "signalGamma", signalGamma, 10, 400, (signalGamma / 100).toFixed(2))}
      ${renderRangeField("Presence Threshold", "presenceThreshold", presenceThreshold, 0, 100, `${presenceThreshold}%`)}
      ${renderRangeField("Presence Softness", "presenceSoftness", presenceSoftness, 0, 100, `${presenceSoftness}%`)}
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
      ${renderSelectField(
        "Mode",
        "mode",
        params.mode,
        MIX_MODES.map((m) => [m.value, m.label])
      )}
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
  const fillPct = sliderFillPercent(numericValue, min, max);
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
          style="--slider-fill: ${fillPct}%"
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

function sliderFillPercent(value, min, max) {
  const numericMin = Number(min);
  const numericMax = Number(max);
  const numericValue = Number(value);
  if (!Number.isFinite(numericMin) || !Number.isFinite(numericMax) || numericMax === numericMin) {
    return 50;
  }
  const pct = ((numericValue - numericMin) / (numericMax - numericMin)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function renderLayerRangeField(label, key, value, min, max, _readout) {
  const safeKey = escapeHtml(key);
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `
    <div class="field range-field">
      <label>
        <span class="field-label-row">
          ${renderLayerPropertyKeyframeButton(key)}
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
        <span class="field-suffix" data-property-readout="${safeKey}"></span>
      </label>
      <div class="range-row">
        <input
          type="range"
          min="${min}"
          max="${max}"
          value="${numericValue}"
          data-node-property="${safeKey}"
          data-input-kind="range"
        />
        <input
          type="number"
          class="num-edit"
          min="${min}"
          max="${max}"
          value="${numericValue}"
          data-node-property="${safeKey}"
          data-input-kind="number"
        />
      </div>
    </div>
  `;
}

function renderXyPadField(label, xKey, yKey, xValue, yValue, options = {}) {
  const min = Number.isFinite(Number(options.min)) ? Number(options.min) : -1;
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : 1;
  const step = Number.isFinite(Number(options.step)) && Number(options.step) > 0
    ? Number(options.step)
    : 1;
  const unit = options.unit ?? "";
  const yAxis = options.yAxis === "up" ? "up" : "down";
  const range = Math.max(max - min, Number.EPSILON);
  const x = clamp(roundToStep(Number(xValue), step, min), min, max);
  const y = clamp(roundToStep(Number(yValue), step, min), min, max);
  const xPct = ((x - min) / range) * 100;
  const yPct = yAxis === "down"
    ? ((y - min) / range) * 100
    : (1 - (y - min) / range) * 100;
  return `
    <div class="field xy-pad-field" data-xy-pad-field="${escapeHtml(`${xKey}:${yKey}`)}">
      <div class="xy-pad-header">
        <div class="xy-pad-title">
          <span class="field-label-text">${escapeHtml(label)}</span>
          <span class="xy-pad-chip">X/Y</span>
        </div>
        <span class="xy-pad-readout" data-xy-pad-readout>${escapeHtml(formatXyPadReadout(x, y, unit))}</span>
      </div>
      <button
        type="button"
        class="xy-pad-surface"
        data-xy-pad
        data-xy-pad-x="${escapeHtml(xKey)}"
        data-xy-pad-y="${escapeHtml(yKey)}"
        data-xy-pad-value-x="${x}"
        data-xy-pad-value-y="${y}"
        data-xy-pad-min="${min}"
        data-xy-pad-max="${max}"
        data-xy-pad-step="${step}"
        data-xy-pad-y-axis="${escapeHtml(yAxis)}"
        data-xy-pad-unit="${escapeHtml(unit)}"
        style="--xy-pad-x:${xPct}%; --xy-pad-y:${yPct}%"
        aria-label="${escapeHtml(label)} XY pad"
      >
        <span class="xy-pad-grid"></span>
        <span class="xy-pad-guide xy-pad-guide--x"></span>
        <span class="xy-pad-guide xy-pad-guide--y"></span>
        <span class="xy-pad-handle" aria-hidden="true"><span></span></span>
      </button>
    </div>
  `;
}

function formatXyPadReadout(x, y, unit = "") {
  return `${formatXyPadNumber(x)}${unit}, ${formatXyPadNumber(y)}${unit}`;
}

function formatXyPadNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, "");
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

function renderLayerPropertyKeyframeButton(paramKey) {
  const node = getSelectedNode();
  if (!isLayerAdjustableNode(node)) return "";
  const safeKey = escapeHtml(paramKey);
  const binding = {
    type: TIMELINE_BINDING_NODE_PROPERTY,
    key: paramKey,
  };
  const animated = hasTimelineTrackForBinding(node.id, binding);
  const keyed = hasTimelineKeyframeAtCurrentTime(node.id, binding);
  return `<button
    type="button"
    class="param-keyframe-toggle${animated ? " is-animated" : ""}${keyed ? " is-keyed" : ""}"
    data-node-property-keyframe-toggle="${safeKey}"
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
  for (const button of inspectorEl.querySelectorAll("[data-node-property-keyframe-toggle]")) {
    const paramKey = button.dataset.nodePropertyKeyframeToggle;
    const binding = {
      type: TIMELINE_BINDING_NODE_PROPERTY,
      key: paramKey,
    };
    const animated = hasTimelineTrackForBinding(node.id, binding);
    const keyed = hasTimelineKeyframeAtCurrentTime(node.id, binding);
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
      ${renderColorPickerControl({
        label,
        value: hex,
        fallback,
        target: { kind: "node-param", paramKey: key },
        inputAttrs: `data-node-param="${safeKey}" data-input-kind="color-hex"`,
      })}
    </div>
  `;
}

function renderGradientStopColorField(label, stopIndex, value, options = {}) {
  const safeIndex = String(Math.max(0, Number(stopIndex) || 0));
  const fallback = options.fallback ?? "#000000";
  const hex = normalizeHex(value, fallback);
  const stopParamAttr = options.paramKey
    ? ` data-gradient-stop-param="${escapeHtml(options.paramKey)}"`
    : "";
  return `
    <div class="field color-field">
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      ${renderColorPickerControl({
        label,
        value: hex,
        fallback,
        target: {
          kind: "gradient-stop",
          stopIndex: safeIndex,
          paramKey: options.paramKey || "stops",
        },
        inputAttrs: `data-gradient-map-stop-color="${safeIndex}" ${stopParamAttr} data-input-kind="gradient-stop-hex"`,
      })}
    </div>
  `;
}

function renderGradientRampField(label, paramKey, value, options = {}) {
  const node = getSelectedNode();
  const safeKey = escapeHtml(paramKey);
  const stops = normalizeGradientRampEditableStops(value);
  const maxStops = Math.max(2, Math.round(Number(options.maxStops) || GRADIENT_RAMP_MAX_STOPS));
  const targetId = gradientRampTargetId(node?.id, paramKey);
  const selectedIndex = getGradientRampSelectedIndex(targetId, stops);
  const selectedStop = stops[selectedIndex] ?? stops[0] ?? { pos: 0, color: "#111111" };
  const canAdd = stops.length < maxStops;
  const canDelete = selectedIndex > 0 && selectedIndex < stops.length - 1 && stops.length > 2;
  const readout = `${Math.round(clamp01(selectedStop.pos) * 100)}%`;

  return `
    <div
      class="field gradient-ramp-field"
      data-gradient-ramp-target="${escapeHtml(targetId)}"
      data-gradient-ramp-node="${escapeHtml(node?.id ?? "")}"
      data-gradient-ramp-param="${safeKey}"
      data-gradient-ramp-max-stops="${maxStops}"
    >
      <label>
        <span class="field-label-row">
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      <div class="gradient-ramp-shell">
        <div
          class="gradient-ramp-bar"
          data-gradient-ramp-bar
          style="background:${escapeHtml(buildGradientRampCss(stops))}"
        >
          ${stops.map((stop, index) => renderGradientRampStop(stop, index, selectedIndex)).join("")}
        </div>
        <div class="gradient-ramp-actions">
          <button
            type="button"
            class="btn gradient-ramp-button"
            data-gradient-ramp-action="add"
            ${canAdd ? "" : "disabled"}
          >Add</button>
          <button
            type="button"
            class="btn gradient-ramp-button"
            data-gradient-ramp-action="delete"
            ${canDelete ? "" : "disabled"}
          >Remove</button>
          <span class="gradient-ramp-readout" data-gradient-ramp-readout>${escapeHtml(readout)}</span>
        </div>
        <div class="gradient-ramp-selected color-field">
          ${renderColorPickerControl({
            label: `${label} stop`,
            value: selectedStop.color,
            fallback: selectedIndex === 0 ? "#111111" : "#ffffff",
            target: {
              kind: "gradient-stop",
              stopIndex: selectedIndex,
              paramKey,
            },
            inputAttrs: `data-gradient-map-stop-color="${selectedIndex}" data-gradient-stop-param="${safeKey}" data-input-kind="gradient-stop-hex"`,
          })}
        </div>
      </div>
    </div>
  `;
}

function renderGradientRampStop(stop, index, selectedIndex) {
  const color = normalizeHex(stop?.color, "#ffffff");
  const position = clamp01(Number(stop?.pos)) * 100;
  const isSelected = index === selectedIndex;
  return `
    <button
      type="button"
      class="gradient-ramp-stop${isSelected ? " is-selected" : ""}${index === 0 || position >= 100 ? " is-endpoint" : ""}"
      data-gradient-ramp-stop="${index}"
      style="left:${position}%; --gradient-stop-color:${escapeHtml(color)}"
      aria-label="Gradient stop ${index + 1}"
      aria-pressed="${isSelected ? "true" : "false"}"
      title="${Math.round(position)}%"
    ></button>
  `;
}

function renderColorPickerControl({ label, value, fallback, target, inputAttrs }) {
  const hex = normalizeHex(value, fallback ?? "#000000");
  const targetId = colorPickerTargetId(target);
  const open = colorPickerState?.targetId === targetId;
  const attrs = renderColorPickerTargetAttrs(target, targetId, fallback ?? "#000000");
  return `
    <div class="color-row color-picker-root" ${attrs}>
      <button
        type="button"
        class="color-picker-trigger"
        data-color-picker-trigger
        aria-label="${escapeHtml(label)} color"
        aria-expanded="${open ? "true" : "false"}"
      >
        <span class="color-picker-trigger-swatch" style="background:${escapeHtml(hex)}"></span>
        <span class="color-picker-trigger-value">${escapeHtml(hex.toUpperCase())}</span>
      </button>
      <input
        type="text"
        class="color-hex"
        value="${escapeHtml(hex)}"
        ${inputAttrs}
        maxlength="7"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
      />
      ${open ? renderColorPickerPopover(hex, target, fallback ?? "#000000") : ""}
    </div>
  `;
}

function renderColorPickerPopover(hex, target, fallback = "#000000") {
  const safeHex = normalizeHex(hex, fallback);
  const hsv = hexToHsvColor(safeHex);
  const hueColor = hsvColorToHex({ h: hsv.h, s: 1, v: 1 });
  const targetId = colorPickerTargetId(target);
  return `
    <div class="color-picker-popover" data-color-picker-popover data-color-current="${escapeHtml(safeHex)}" data-color-picker-target-id="${escapeHtml(targetId)}" style="--color-picker-hue:${escapeHtml(hueColor)}; --color-picker-s:${hsv.s * 100}%; --color-picker-v:${(1 - hsv.v) * 100}%; --color-picker-h:${(hsv.h / 360) * 100}%">
      <div class="color-picker-surface" data-color-picker-surface>
        <span class="color-picker-surface-white"></span>
        <span class="color-picker-surface-black"></span>
        <span class="color-picker-surface-handle"></span>
      </div>
      <div class="color-picker-hue" data-color-picker-hue>
        <span class="color-picker-hue-handle"></span>
      </div>
      <div class="color-picker-popover-row">
        <input
          type="text"
          class="color-hex"
          value="${escapeHtml(safeHex)}"
          data-color-picker-hex-input
          maxlength="7"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
        />
        <button type="button" class="color-picker-eyedropper" data-color-picker-eyedropper title="Pick color from screen" aria-label="Pick color from screen">Pick</button>
      </div>
    </div>
  `;
}

function renderColorPickerTargetAttrs(target, targetId, fallback) {
  const attrs = [
    `data-color-picker-target="${escapeHtml(targetId)}"`,
    `data-color-picker-kind="${escapeHtml(target.kind)}"`,
    `data-color-picker-fallback="${escapeHtml(fallback)}"`,
  ];
  if (target.kind === "node-param") {
    attrs.push(`data-color-picker-param="${escapeHtml(target.paramKey)}"`);
  } else if (target.kind === "gradient-stop") {
    attrs.push(`data-color-picker-stop-index="${escapeHtml(String(target.stopIndex))}"`);
    attrs.push(`data-color-picker-param="${escapeHtml(target.paramKey || "stops")}"`);
  } else if (target.kind === "mesh-stop") {
    attrs.push(`data-color-picker-stop-index="${escapeHtml(String(target.stopIndex))}"`);
  }
  return attrs.join(" ");
}

function colorPickerTargetId(target) {
  if (!target) return "";
  switch (target.kind) {
    case "node-param":
      return `node:${target.paramKey}`;
    case "gradient-stop":
      return `gradient:${target.paramKey || "stops"}:${target.stopIndex}`;
    case "mesh-stop":
      return `mesh:${target.stopIndex}`;
    default:
      return "";
  }
}

function resolveColorPickerTarget(element) {
  const root = element?.closest?.("[data-color-picker-target]");
  if (!root) return null;
  const kind = root.dataset.colorPickerKind;
  const target = {
    kind,
    targetId: root.dataset.colorPickerTarget,
    fallback: root.dataset.colorPickerFallback || "#000000",
  };
  if (kind === "node-param") {
    target.paramKey = root.dataset.colorPickerParam;
  } else if (kind === "gradient-stop") {
    target.paramKey = root.dataset.colorPickerParam || "stops";
    target.stopIndex = Number(root.dataset.colorPickerStopIndex);
  } else if (kind === "mesh-stop") {
    target.stopIndex = Number(root.dataset.colorPickerStopIndex);
  }
  if (!target.targetId || !target.kind) return null;
  return target;
}

function toggleColorPicker(trigger) {
  const target = resolveColorPickerTarget(trigger);
  if (!target) return;
  colorPickerState = colorPickerState?.targetId === target.targetId
    ? null
    : { targetId: target.targetId };
  renderInspector();
}

function startColorPickerDrag(event, control, mode) {
  if (event.button !== 0) return;
  const target = resolveColorPickerTarget(control);
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();

  inspectorEditing = true;
  document.body.classList.add("dragging-color-picker");

  // F17.3b: snapshot the pre-drag color so onUp can record a single undo
  // entry covering the whole SV-surface / hue-rail drag instead of one per
  // pointermove commit.
  const pickerUndoSnapshot = readColorPickerCurrentHex(target);

  const commitFromPointer = (ev) => {
    const current = hexToHsvColor(readColorPickerCurrentHex(target));
    const next = mode === "hue"
      ? hsvFromHuePointer(control, current, ev.clientX)
      : hsvFromSurfacePointer(control, current, ev.clientX, ev.clientY);
    commitColorPickerValue(control, hsvColorToHex(next));
  };

  commitFromPointer(event);

  try {
    control.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    if (ev.buttons !== undefined && !(ev.buttons & 1)) return;
    commitFromPointer(ev);
  };

  const onUp = () => {
    control.removeEventListener("pointermove", onMove);
    control.removeEventListener("pointerup", onUp);
    control.removeEventListener("pointercancel", onUp);
    inspectorEditing = false;
    document.body.classList.remove("dragging-color-picker");
    try {
      control.releasePointerCapture(event.pointerId);
    } catch {}
    // F17.3b flush: if the drag changed the color, record one history entry.
    const finalHex = readColorPickerCurrentHex(target);
    if (finalHex && pickerUndoSnapshot && finalHex !== pickerUndoSnapshot) {
      pushHistory({
        undo: () => applyColorPickerHex(target, pickerUndoSnapshot),
        redo: () => applyColorPickerHex(target, finalHex),
      });
    }
  };

  control.addEventListener("pointermove", onMove);
  control.addEventListener("pointerup", onUp);
  control.addEventListener("pointercancel", onUp);
}

function applyColorPickerHex(target, hex) {
  // Same dispatcher commitColorPickerValue uses, but takes a target object
  // directly so undo callbacks don't need to look one up from a DOM element
  // that may have been re-rendered since the history entry was pushed.
  switch (target.kind) {
    case "node-param":
      commitNodeColorParam(target.paramKey, hex);
      return;
    case "gradient-stop":
      commitGradientStopColorTarget(target, hex);
      return;
    case "mesh-stop":
      commitMeshStopColorTarget(target, hex);
      return;
  }
}

// Read the picker's value from node state rather than the DOM input. The DOM
// can be a beat ahead during typing (input event fires after the user pressed
// a key, so input.value already reflects the in-progress edit), but the node
// state still holds the pre-edit color until commitColorPickerValue runs.
// Drag handlers can keep using readColorPickerCurrentHex since their
// snapshots happen at pointerdown, before any DOM mutation.
function readPickerValueFromState(target) {
  if (!target) return null;
  const node = getSelectedNode();
  if (!node) return null;
  switch (target.kind) {
    case "node-param":
      return node.params?.[target.paramKey];
    case "gradient-stop": {
      const stops = node.params?.[target.paramKey || "stops"];
      return Array.isArray(stops) ? stops[target.stopIndex]?.color : null;
    }
    case "mesh-stop":
      return node.params?.stops?.[target.stopIndex]?.color;
  }
  return null;
}

function hsvFromSurfacePointer(surface, current, clientX, clientY) {
  const rect = surface.getBoundingClientRect();
  return {
    h: current.h,
    s: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    v: 1 - clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1),
  };
}

function hsvFromHuePointer(hueControl, current, clientX) {
  const rect = hueControl.getBoundingClientRect();
  return {
    ...current,
    h: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * 360,
  };
}

function commitColorPickerValue(element, rawHex) {
  const target = resolveColorPickerTarget(element);
  if (!target) return null;
  const hex = normalizeHex(rawHex, target.fallback);

  switch (target.kind) {
    case "node-param":
      commitNodeColorParam(target.paramKey, hex);
      break;
    case "gradient-stop":
      commitGradientStopColorTarget(target, hex);
      break;
    case "mesh-stop":
      commitMeshStopColorTarget(target, hex);
      break;
    default:
      return null;
  }

  syncColorPickerElements(target, hex);
  return hex;
}

function commitNodeColorParam(paramKey, hex) {
  const node = getSelectedNode();
  if (!node || !paramKey) return;
  updateNodeParams(node.id, { [paramKey]: hex });
  if (!commitParamValueToTimeline(node.id, paramKey, hex)) {
    updateParamKeyframeAtCurrentTime(node.id, paramKey, hex);
  }
}

function commitGradientStopColorTarget(target, hex) {
  const node = getSelectedNode();
  if (!isGradientRampNode(node)) return;
  const paramKey = target.paramKey || "stops";
  const stops = normalizeGradientMapInspectorStops(node.params?.[paramKey]);
  const index = Math.max(
    0,
    Math.min(stops.length - 1, Number.isFinite(target.stopIndex) ? target.stopIndex : 0)
  );
  const nextStops = stops.map((stop) => ({ ...stop }));
  nextStops[index] = {
    ...nextStops[index],
    pos: index === 0 ? 0 : index === nextStops.length - 1 ? 1 : nextStops[index].pos,
    color: hex,
  };
  commitGradientRampStops(node.id, paramKey, nextStops);
}

function isGradientRampNode(node) {
  return Boolean(node && (node.type === "gradient" || node.type === "gradient-map" || node.type === "scene-grade"));
}

function commitMeshStopColorTarget(target, hex) {
  const node = getSelectedNode();
  if (!node || node.type !== "mesh-gradient") return;
  const stops = Array.isArray(node.params?.stops) ? node.params.stops : [];
  const index = Number(target.stopIndex);
  if (!Number.isFinite(index) || index < 0 || index >= stops.length) return;
  const nextStops = stops.map((stop, stopIndex) =>
    stopIndex === index ? { ...stop, color: hex } : stop
  );
  updateNodeParams(node.id, { stops: nextStops });
}

async function handleColorPickerEyedropper(control) {
  if (typeof window === "undefined" || typeof window.EyeDropper !== "function") return;
  try {
    const result = await new window.EyeDropper().open();
    if (!result?.sRGBHex) return;
    // F17.3b eyedropper: single commit, snapshot before / push after.
    const target = resolveColorPickerTarget(control);
    const before = target ? readColorPickerCurrentHex(target) : null;
    commitColorPickerValue(control, result.sRGBHex);
    if (target && before) {
      const after = readColorPickerCurrentHex(target);
      if (after && before !== after) {
        pushHistory({
          undo: () => applyColorPickerHex(target, before),
          redo: () => applyColorPickerHex(target, after),
        });
      }
    }
  } catch {
    // User cancelled the picker; keep the current color.
  }
}

function readColorPickerCurrentHex(target) {
  if (!target?.targetId || !inspectorEl) return normalizeHex(target?.fallback, "#000000");
  const row = inspectorEl.querySelector(`[data-color-picker-target="${cssEscape(target.targetId)}"]`);
  const hexInput = row?.querySelector(".color-hex");
  return normalizeHex(hexInput?.value, target.fallback || "#000000");
}

function syncColorPickerElements(target, hex) {
  if (!target?.targetId || !inspectorEl) return;
  const safeHex = normalizeHex(hex, target.fallback || "#000000");
  const hsv = hexToHsvColor(safeHex);
  const hueColor = hsvColorToHex({ h: hsv.h, s: 1, v: 1 });
  const rows = inspectorEl.querySelectorAll(`[data-color-picker-target="${cssEscape(target.targetId)}"]`);
  for (const row of rows) {
    const triggerSwatch = row.querySelector(".color-picker-trigger-swatch");
    const triggerValue = row.querySelector(".color-picker-trigger-value");
    const hexInputs = row.querySelectorAll(".color-hex");
    if (triggerSwatch) triggerSwatch.style.background = safeHex;
    if (triggerValue) triggerValue.textContent = safeHex.toUpperCase();
    for (const input of hexInputs) {
      input.classList.remove("is-invalid");
      if (input.value !== safeHex) input.value = safeHex;
    }
    const meshDot = row.closest(".mesh-stop-row")?.querySelector(".mesh-stop-swatch-dot");
    if (meshDot) meshDot.style.background = safeHex;
    const popover = row.querySelector("[data-color-picker-popover]");
    if (popover) {
      popover.dataset.colorCurrent = safeHex;
      popover.style.setProperty("--color-picker-hue", hueColor);
      popover.style.setProperty("--color-picker-s", `${hsv.s * 100}%`);
      popover.style.setProperty("--color-picker-v", `${(1 - hsv.v) * 100}%`);
      popover.style.setProperty("--color-picker-h", `${(hsv.h / 360) * 100}%`);
    }
  }
  if (target.kind === "gradient-stop") {
    syncGradientRampElements(target);
  }
  syncTimelineButtons();
}

function normalizeHexOrNull(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return normalizeHex(`#${raw}`, "#000000");
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return normalizeHex(`#${raw}`, "#000000");
  }
  return null;
}

function hexToHsvColor(hex) {
  const [r, g, b] = hexToRgb255(normalizeHex(hex, "#ffffff"));
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
  }
  return {
    h: (h * 60 + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvColorToHex(color) {
  const hue = (((Number(color.h) || 0) % 360) + 360) % 360;
  const saturation = clamp(Number(color.s), 0, 1);
  const value = clamp(Number(color.v), 0, 1);
  const chroma = value * saturation;
  const huePrime = hue / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (huePrime < 1) {
    r = chroma;
    g = x;
  } else if (huePrime < 2) {
    r = x;
    g = chroma;
  } else if (huePrime < 3) {
    g = chroma;
    b = x;
  } else if (huePrime < 4) {
    g = x;
    b = chroma;
  } else if (huePrime < 5) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }
  const match = value - chroma;
  return rgbChannelsToHex((r + match) * 255, (g + match) * 255, (b + match) * 255);
}

function rgbChannelsToHex(r, g, b) {
  const toHex = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
    .toString(16)
    .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb255(hex) {
  const safe = normalizeHex(hex, "#ffffff").slice(1);
  return [
    parseInt(safe.slice(0, 2), 16),
    parseInt(safe.slice(2, 4), 16),
    parseInt(safe.slice(4, 6), 16),
  ];
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

function syncLayerPropertySiblingControls(control) {
  const key = control.dataset.nodeProperty;
  if (!key || !inspectorEl) return;
  const value = control.value;
  const siblings = inspectorEl.querySelectorAll(`[data-node-property="${cssEscape(key)}"]`);
  for (const el of siblings) {
    if (el === control) continue;
    if (el.value !== value) el.value = value;
  }
}

function getLayerPropertyDefaultValue(key) {
  switch (key) {
    case "opacity":
      return 100;
    case "hue":
      return 0;
    case "saturation":
      return 100;
    default:
      return 0;
  }
}

function commitGradientMapStopColor(node, control) {
  const paramKey = control.dataset.gradientStopParam || "stops";
  const stops = normalizeGradientMapInspectorStops(node.params?.[paramKey]);
  const rawIndex = Number(control.dataset.gradientMapStopColor);
  const index = Math.max(0, Math.min(stops.length - 1, Number.isFinite(rawIndex) ? rawIndex : 0));
  const fallback = index === 0 ? "#111111" : "#ffffff";
  const color = normalizeHex(control.value, fallback);
  const nextStops = stops.map((stop) => ({ ...stop }));
  nextStops[index] = {
    ...nextStops[index],
    pos: index === 0 ? 0 : index === nextStops.length - 1 ? 1 : nextStops[index].pos,
    color,
  };
  control.value = color;
  commitGradientRampStops(node.id, paramKey, nextStops);
  return color;
}

function syncGradientStopSiblingControls(control) {
  const key = control.dataset.gradientMapStopColor;
  if (!key || !inspectorEl) return;
  const value = normalizeHex(control.value, "#000000");
  const paramKey = control.dataset.gradientStopParam || "";
  const siblings = inspectorEl.querySelectorAll(
    `[data-gradient-map-stop-color="${cssEscape(key)}"]`
  );
  for (const el of siblings) {
    if (el === control) continue;
    if ((el.dataset.gradientStopParam || "") !== paramKey) continue;
    if (el.value !== value) el.value = value;
  }
}

function normalizeGradientMapInspectorStops(value) {
  const fallback = [
    { pos: 0, color: "#111111" },
    { pos: 1, color: "#ffffff" },
  ];
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const stops = source
    .map((stop) => ({
      pos: clamp01(Number(stop?.pos)),
      color: normalizeHex(stop?.color, "#ffffff"),
    }))
    .sort((a, b) => a.pos - b.pos);

  if (!stops.length) return fallback;
  if (stops.length === 1) {
    return [
      { pos: 0, color: stops[0].color },
      { pos: 1, color: stops[0].color },
    ];
  }
  if (stops[0].pos > 0) {
    stops.unshift({ pos: 0, color: stops[0].color });
  }
  if (stops.at(-1).pos < 1) {
    stops.push({ pos: 1, color: stops.at(-1).color });
  }
  return stops;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function updateInlineReadout(control) {
  // F23 AE-style fill: write --slider-fill on the range input so the CSS
  // `linear-gradient` track shows the filled portion up to the thumb.
  if (!control || control.type !== "range") return;
  const min = Number(control.min);
  const max = Number(control.max);
  const value = Number(control.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(value) || max === min) return;
  const pct = clamp((value - min) / (max - min), 0, 1) * 100;
  control.style.setProperty("--slider-fill", `${pct}%`);
}

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
  return createFreeNode(type, nodePositionFromPoint(point), getCurrentGraphParentId());
}

function nodePositionFromPoint(point) {
  return {
    x: point.x - NODE_WIDTH / 2,
    y: point.y - NODE_HEIGHT / 2,
  };
}

function getViewerInputEdgeId() {
  const { graph } = getState();
  const visibleNodeIds = getVisibleGraphNodeIds(graph);
  const viewer = graph.nodes.find((node) => node.type === "viewer-output" && visibleNodeIds.has(node.id));
  const primarySocket = viewer?.inputs?.[0]?.name;
  if (!viewer || !primarySocket) return null;
  return graph.edges.find(
    (edge) =>
      edge.toNode === viewer.id &&
      edge.toSocket === primarySocket &&
      visibleNodeIds.has(edge.fromNode)
  )?.id ?? null;
}

function initGraphContextMenu() {
  if (graphMenuEl) return;

  graphMenuEl = document.createElement("div");
  graphMenuEl.className = "context-menu graph-node-picker floating-card hidden";

  graphMenuEl.addEventListener("click", (event) => {
    const nodeAction = event.target.closest("[data-node-menu-action]");
    if (nodeAction) {
      handleGraphNodeMenuAction(nodeAction);
      hideGraphContextMenu();
      return;
    }

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

  nodesEl.addEventListener("contextmenu", onNodeContextMenu);

  editorEl.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-node-id]")) return;
    event.preventDefault();
    const edge = findInsertableEdgeAt(event.clientX, event.clientY);
    graphMenuState = {
      point: clientToWorld(event.clientX, event.clientY),
      edgeId: edge?.edgeId ?? "",
    };
    setInsertHighlight(edge?.edgeId ?? "");
    graphMenuEl.className = "context-menu graph-node-picker floating-card hidden";
    graphMenuEl.innerHTML = renderGraphContextMenuContent(Boolean(edge?.edgeId));
    positionGraphContextMenu(event.clientX, event.clientY);
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

function onNodeContextMenu(event) {
  const nodeEl = event.target.closest("[data-node-id]");
  if (!nodeEl) return;

  const node = getNodeById(nodeEl.dataset.nodeId);
  if (!node) return;

  event.preventDefault();
  event.stopPropagation();

  if (!getSelectedNodeIds().includes(node.id)) {
    selectNode(node.id);
  }

  graphMenuState = {
    mode: "node",
    nodeId: node.id,
    point: clientToWorld(event.clientX, event.clientY),
  };
  graphMenuEl.className = "context-menu graph-node-context-menu floating-card hidden";
  graphMenuEl.innerHTML = renderGraphNodeMenuContent(node.id);
  positionGraphContextMenu(event.clientX, event.clientY);
}

function hideGraphContextMenu() {
  graphMenuEl?.classList.add("hidden");
  graphMenuState = null;
  clearInsertHighlight();
}

function positionGraphContextMenu(clientX, clientY) {
  if (!graphMenuEl) return;

  const padding = 12;
  graphMenuEl.style.left = `${clientX}px`;
  graphMenuEl.style.top = `${clientY}px`;
  graphMenuEl.classList.remove("hidden");

  const rect = graphMenuEl.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - padding;
  const maxTop = window.innerHeight - rect.height - padding;
  const left = Math.max(padding, Math.min(clientX, maxLeft));
  const top = Math.max(padding, Math.min(clientY, maxTop));

  graphMenuEl.style.left = `${left}px`;
  graphMenuEl.style.top = `${top}px`;
}

function renderGraphContextMenuContent(insertOnEdge) {
  const groups = getNodePaletteMenuGroups();
  return `
    <div class="graph-node-picker__header">
      <span>${insertOnEdge ? "Insert Node" : "Add Node"}</span>
      <span class="mono">${insertOnEdge ? "edge" : "canvas"}</span>
    </div>
    <div class="graph-node-picker__body">
      ${groups.map(renderGraphContextMenuGroup).join("")}
    </div>
  `;
}

function renderGraphContextMenuGroup(group) {
  return `
    <section class="graph-node-picker__group" data-node-family="${escapeHtml(group.family)}">
      <p class="graph-node-picker__label">${escapeHtml(group.label)}</p>
      ${group.items.map(renderGraphContextMenuItem).join("")}
    </section>
  `;
}

function renderGraphContextMenuItem(item) {
  return `
    <button type="button" data-add-node="${escapeHtml(item.type)}">
      <span class="graph-node-picker__swatch" aria-hidden="true"></span>
      <span>${escapeHtml(item.label)}</span>
    </button>
  `;
}

function getNodePaletteMenuGroups() {
  return Array.from(document.querySelectorAll(".node-palette-group"))
    .map((group) => {
      const family = group.dataset.nodeFamily ?? "utility";
      const label = group.querySelector(".node-palette-label")?.textContent?.trim() || family;
      const items = Array.from(group.querySelectorAll("[data-palette-node]"))
        .map((item) => {
          const type = item.dataset.paletteNode;
          if (!type) return null;
          const definition = getNodeDefinition(type);
          return {
            type,
            label: normalizeMenuLabel(item.textContent) || definition?.label || type,
          };
        })
        .filter(Boolean);
      return { family, label, items };
    })
    .filter((group) => group.items.length > 0);
}

function normalizeMenuLabel(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function renderGraphNodeMenuContent(nodeId) {
  const node = getNodeById(nodeId);
  if (!node) return "";

  const selectedIds = getSelectedNodeIds();
  const contextCount = selectedIds.includes(node.id) ? selectedIds.length : 1;
  const selectionLabel = contextCount > 1 ? `${contextCount} Selected` : node.label;
  const canDuplicate = canDuplicateGraphNode(node);
  const canDelete = canDeleteGraphNode(node);
  const canBypass = canBypassGraphNode(node);
  const canGroup = getGroupSelectionInfo(selectedIds).canGroup;
  const canUngroup = node.type === "group";
  const bypassLabel = node.bypassed ? "Enable Node" : "Bypass Node";

  return `
    <div class="graph-node-context-menu__header">
      <span>${escapeHtml(selectionLabel)}</span>
      <span class="mono">${escapeHtml(node.type)}</span>
    </div>
    <div class="graph-node-context-menu__body">
      ${renderGraphNodeMenuButton("duplicate", "Duplicate Node", canDuplicate)}
      ${renderGraphNodeMenuButton("toggle-bypass", bypassLabel, canBypass)}
      ${renderGraphNodeMenuButton("group-selected", "Group Selected", canGroup)}
      ${
        node.type === "group"
          ? renderGraphNodeMenuButton("open-group", "Open Group", true)
          : ""
      }
      ${renderGraphNodeMenuButton("ungroup", "Ungroup", canUngroup)}
      ${renderGraphNodeMenuButton("delete", "Delete Node", canDelete, "is-danger")}
    </div>
  `;
}

function renderGraphNodeMenuButton(action, label, enabled = true, className = "") {
  return `
    <button
      type="button"
      class="${escapeHtml(className)}"
      data-node-menu-action="${escapeHtml(action)}"
      ${enabled ? "" : "disabled"}
    >${escapeHtml(label)}</button>
  `;
}

function handleGraphNodeMenuAction(control) {
  const nodeId = graphMenuState?.nodeId;
  const node = getNodeById(nodeId);
  if (!node) return;

  switch (control.dataset.nodeMenuAction) {
    case "duplicate":
      duplicateNode(node.id);
      break;
    case "toggle-bypass":
      toggleNodeBypass(node.id);
      break;
    case "group-selected":
      groupCurrentSelection();
      break;
    case "open-group":
      if (node.type === "group") setCurrentGraphParent(node.id);
      break;
    case "ungroup":
      if (node.type === "group") ungroupNode(node.id);
      break;
    case "delete":
      removeNode(node.id);
      break;
    default:
      break;
  }
}

function canDuplicateGraphNode(node) {
  return Boolean(node && node.type !== "source" && node.type !== "viewer-output" && node.type !== "group");
}

function canDeleteGraphNode(node) {
  return Boolean(node && node.type !== "source" && node.type !== "viewer-output");
}

function canBypassGraphNode(node) {
  return Boolean(node && node.type !== "source" && node.type !== "viewer-output" && node.type !== "group");
}

function getGroupSelectionInfo(selectedNodeIds = getSelectedNodeIds()) {
  const { graph } = getState();
  const nodes = selectedNodeIds.map((nodeId) => getNodeById(nodeId, graph)).filter(Boolean);
  const groupable = nodes.filter((node) => node.type !== "source" && node.type !== "viewer-output");
  const parentIds = new Set(groupable.map((node) => getNodeParentId(node)));

  return {
    nodes,
    groupable,
    canGroup: groupable.length > 0 && parentIds.size === 1,
  };
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
  const visibleNodes = getVisibleGraphNodes(graph);
  if (!rect.width || !rect.height || visibleNodes.length === 0) return;

  const bounds = visibleNodes.reduce(
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
