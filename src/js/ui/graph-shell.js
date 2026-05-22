import { dispatch, getState, subscribe } from "../state.js";
import {
  ensureBootGraph,
  getNodeById,
  getNodeParentId,
  getSelectedNode,
  getSelectedNodeIds,
  insertNodeOnEdge,
  resolveGraphParentId,
  selectNode,
  toggleNodeBypass,
  updateNodeLabel,
  updateNodeParams,
} from "../graph.js";
import { subscribePalettes } from "../palettes.js";
import { listenWithDispose, registerDispose } from "./lifecycle.js";
import {
  commitParamValueToTimeline,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import {
  initGraphBreadcrumb,
  setCurrentGraphParent,
  syncGraphBreadcrumb,
} from "./graph-breadcrumb.js";
import {
  clearGraphSelection,
  duplicateSelectedGraphNodes,
  frameSelectedGraphNodes,
  groupCurrentSelection,
  initGraphActions,
  removeSelectedGraphNodes,
  selectAllVisibleGraphNodes,
  toggleBypassForSelectedNodes,
  toggleSoloForSelectedNode,
  ungroupCurrentSelection,
} from "./graph-actions.js";
import { initGraphContextMenu } from "./graph-context-menu.js";
import {
  initGraphKeyboard,
  markGraphKeyboardActive,
} from "./graph-keyboard.js";
import {
  clearInsertHighlight,
  findInsertableEdgeAt,
  findInsertTargetAt,
  findInsertTargetForNodeAt,
  initGraphEdgeInsertTargets,
  setInsertHighlight,
} from "./graph-edge-insert.js";
import {
  initGraphEdgeCut,
} from "./graph-edge-cut.js";
import {
  initGraphSocketDrag,
  startSocketDrag,
} from "./graph-socket-drag.js";
import {
  initGraphNodeDrag,
  startNodeDrag,
} from "./graph-node-drag.js";
import {
  cancelActiveGraphMarquee,
  initGraphViewportInteractions,
} from "./graph-viewport.js";
import { getCurrentGraphParentId } from "./graph-view-scope.js";
import {
  applyGraphViewport,
  clientToScene,
  clientToWorld,
  getLocalPoint,
  getViewportCenterWorld,
  initGraphViewTransform,
  maybeAutoCenterGraph,
  syncGraphAutoCenterReset,
} from "./graph-view-transform.js";
import {
  createNodeFromPalette,
  insertPaletteNodeAtDefault,
  nodePositionFromPoint,
} from "./graph-node-placement.js";
import { initNodePaletteSearch, initPaletteDragAndDrop } from "./palette-ui.js";
import {
  getLastRenderedGraphParentId,
  initGraphRender,
  renderEdges,
  renderGraph,
  renderSocketRows,
} from "./graph-render.js";
import {
  clearPaletteSwatchLocks,
  getLockedSwatchIndexes,
  isSwatchLocked,
  prunePaletteLocks,
  removeLockedSwatchIndex,
  syncPaletteLocks,
  toggleLockedSwatchIndex,
} from "./palette-swatch-locks.js";
import {
  initInspectorFields,
  syncTimelineButtons,
} from "./graph-inspector-fields.js";
import {
  initDitherInspector,
  renderPaletteManager,
} from "./graph-inspector-dither.js";
import { initXyPad } from "./graph-xy-pad.js";
import { initGradientInspector } from "./graph-inspector-gradient.js";
import {
  clamp,
  clamp01,
  formatFpsReadout,
  formatSignedStops,
  formatSignedValue,
  initInspectorUtils,
} from "./graph-inspector-utils.js";
import {
  getRenderedInspectorNodeId,
  initInspectorCore,
  renderInspector,
} from "./graph-inspector-core.js";
import {
  getPaletteExtractionSize,
  getSelectedDitherNode,
  initPaletteActions,
  onPaletteRegistryChange,
} from "./graph-palette-actions.js";
import {
  initColorPicker,
  renderColorField,
  renderColorPickerControl,
  renderGradientStopColorField,
} from "./graph-color-picker.js";
import {
  GRADIENT_RAMP_MAX_STOPS,
  commitGradientStopColorTarget,
  initGradientRamp,
  normalizeGradientMapInspectorStops,
  renderGradientRampField,
  syncGradientRampElements,
} from "./graph-gradient-ramp.js";
import {
  curveChannelLabel,
  initCurveEditor,
  normalizeCurveChannel,
  readCurvePoints,
  renderCurveChannelStrip,
  renderCurveField,
} from "./graph-curve-editor.js";
import {
  isInspectorEditing,
  onInspectorChange,
  onInspectorClick,
  onInspectorContextMenu,
  onInspectorInput,
  onInspectorKeyDown,
  onInspectorPointerDown,
  setInspectorEditing,
} from "./graph-inspector-events.js";

let nodesEl;
let edgesEl;
let editorEl;
let inspectorEl;
let inspectorTitleEl;
let stageEl;
let resizeObserver;
let graphRenameNodeId = null;

export function initGraphShell() {
  ensureBootGraph();

  nodesEl = document.getElementById("graphNodes");
  edgesEl = document.getElementById("graphEdges");
  editorEl = document.getElementById("nodeEditor");
  inspectorEl = document.getElementById("nodeInspector");
  inspectorTitleEl = document.getElementById("nodeInspectorTitle");
  stageEl = document.getElementById("stage");

  if (!nodesEl || !edgesEl || !editorEl || !inspectorEl) return;

  initGraphRender({
    nodesEl,
    edgesEl,
    getGraphRenameNodeId: () => graphRenameNodeId,
  });
  initInspectorFields({ inspectorEl });
  initInspectorCore({ inspectorEl, inspectorTitleEl });
  initPaletteActions({
    inspectorEl,
    setInspectorEditing,
    isInspectorEditing,
  });
  initDitherInspector({
    getPaletteExtractionSize,
  });
  initCurveEditor({
    renderInspector,
    setInspectorEditing,
  });
  initXyPad({
    inspectorEl,
    cssEscape,
    renderInspector,
    setInspectorEditing,
  });
  initGradientInspector({
    inspectorEl,
    cssEscape,
    renderInspector,
  });
  initInspectorUtils({
    inspectorEl,
    cssEscape,
  });
  initGradientRamp({
    inspectorEl,
    cssEscape,
    renderInspector,
    setInspectorEditing,
  });
  initColorPicker({
    inspectorEl,
    cssEscape,
    renderInspector,
    setInspectorEditing,
    commitNodeColorParam,
    commitGradientStopColor: commitGradientStopColorTarget,
    commitMeshStopColor: commitMeshStopColorTarget,
    syncGradientRampElements,
  });
  initGraphViewTransform({ editorEl, nodesEl, edgesEl });
  initGraphActions({ editorEl });
  initGraphEdgeInsertTargets({ edgesEl });
  initGraphEdgeCut({ edgesEl, editorEl, clientToScene });
  initGraphSocketDrag({ edgesEl, nodesEl, clientToScene });
  initGraphNodeDrag({
    nodesEl,
    clearInsertHighlight,
    cssEscape,
    findInsertTargetForNodeAt,
    getCurrentGraphParentId,
    renderEdges,
    renderInspector,
    selectNodesWithoutDispatch,
    setInsertHighlight,
  });

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
  initPaletteDragAndDrop({
    editorEl,
    stageEl,
    nodesEl,
    clearInsertHighlight,
    clientToWorld,
    createNodeFromPalette,
    findInsertableEdgeAt,
    findInsertTargetAt,
    insertNodeOnEdge,
    insertPaletteNodeAtDefault,
    nodePositionFromPoint,
    renderSocketRows,
    setInsertHighlight,
  });
  initGraphViewportInteractions({
    editorEl,
    nodesEl,
    clientToWorld,
    getLocalPoint,
    renderEdges,
    renderInspector,
    selectNodesWithoutDispatch,
  });
  initGraphContextMenu({
    editorEl,
    nodesEl,
    clearInsertHighlight,
    clientToWorld,
    createNodeFromPalette,
    findInsertableEdgeAt,
    getViewportCenterWorld,
    nodePositionFromPoint,
    setInsertHighlight,
  });
  initGraphBreadcrumb(editorEl);
  initGraphKeyboard({
    editorEl,
    cancelActiveGraphMarquee,
    clearGraphSelection,
    duplicateSelectedGraphNodes,
    frameSelectedGraphNodes,
    groupCurrentSelection,
    removeSelectedGraphNodes,
    selectAllVisibleGraphNodes,
    startRenamingSelectedNode,
    toggleBypassForSelectedNodes,
    toggleSoloForSelectedNode,
    ungroupCurrentSelection,
  });

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => applyGraphViewport());
    resizeObserver.observe(editorEl);
    registerDispose(() => resizeObserver?.disconnect());
  }

  listenWithDispose(window, "resize", applyGraphViewport);

  subscribe("graph", () => {
    syncGraphAutoCenterReset();
    // Skip the full graph DOM rebuild while an inspector drag is live. The
    // node cards' visible content (label, position, selection, edges) does
    // not depend on the params being edited mid-drag, so rebuilding 220px-
    // wide cards on every XY-pad / slider pointermove tick is wasted work
    // that surfaced as visible lag on the focused control. The drag-end
    // path calls renderInspector explicitly, and the next non-edit graph
    // dispatch catches the shell up.
    if (isInspectorEditing()) return;
    renderShell();
  });
  subscribe("timeline", () => {
    if (!isInspectorEditing()) renderInspector();
  });
  subscribe("playback", () => {
    if (!isInspectorEditing()) syncTimelineButtons();
  });
  subscribe("graphView", () => {
    syncGraphAutoCenterReset();
    const parentId = getCurrentGraphParentId();
    if (parentId !== getLastRenderedGraphParentId()) {
      renderGraph();
    } else {
      syncGraphBreadcrumb();
    }
    applyGraphViewport();
    maybeAutoCenterGraph();
  });
  subscribe("source", () => {
    const selected = getSelectedNode();
    if (selected?.type === "viewer-output" && !isInspectorEditing()) {
      renderInspector();
    }
  });

  requestAnimationFrame(() => {
    maybeAutoCenterGraph();
  });
}

function onGraphPointerDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest("[data-node-rename-input]")) return;
  if (e.target.closest("[data-node-action]")) return;
  markGraphKeyboardActive();

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

function renderShell() {
  if (!nodesEl || !edgesEl || !editorEl || !inspectorEl) return;
  ensureBootGraph();
  renderGraph();
  applyGraphViewport();
  maybeAutoCenterGraph();

  const selectionKey = getSelectedNodeIds().join(",");
  if (!isInspectorEditing() || getRenderedInspectorNodeId() !== selectionKey) {
    renderInspector();
  }
}

// Color picker target writers — injected into the color picker module via
// initColorPicker so the picker's commit dispatch ends up here. The
// gradient-stop write path lives in graph-gradient-ramp.js; only the
// node-param and mesh-stop writers stay here because both are tiny
// one-liners over updateNodeParams.

function commitNodeColorParam(paramKey, hex) {
  const node = getSelectedNode();
  if (!node || !paramKey) return;
  updateNodeParams(node.id, { [paramKey]: hex });
  if (!commitParamValueToTimeline(node.id, paramKey, hex)) {
    updateParamKeyframeAtCurrentTime(node.id, paramKey, hex);
  }
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
