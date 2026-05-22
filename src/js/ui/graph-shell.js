import { dispatch, getState, pushHistory, subscribe } from "../state.js";
import {
  ensureBootGraph,
  getNodeById,
  getNodeParentId,
  getSelectedNode,
  getSelectedNodeIds,
  getValueNodeOutputBounds,
  insertNodeOnEdge,
  replacePaletteUsages,
  resolveGraphParentId,
  selectNode,
  toggleParamExposed,
  toggleNodeBypass,
  ungroupNode,
  updateNodeLayerProperties,
  updateNodeLabel,
  updateNodeParams,
} from "../graph.js";
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
import { listenWithDispose, registerDispose } from "./lifecycle.js";
import {
  TIMELINE_BINDING_NODE_PROPERTY,
  commitBindingValueToTimeline,
  commitParamValueToTimeline,
  toggleParamKeyframeAtCurrentTime,
  toggleTimelineKeyframeAtCurrentTime,
  updateBindingKeyframeAtCurrentTime,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import { normalizeHex } from "../color.js";
import {
  buildRgbCurveLut,
  identityCurvePoints as createIdentityCurvePoints,
  sanitizeCurvePoints,
} from "../curve-lut.js";
import { escapeHtml } from "./utils.js";
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
import { canBypassGraphNode } from "./graph-node-policy.js";
import { getNodeRenderHeight, modulo } from "./graph-geometry.js";
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
  isLayerAdjustableNode,
  renderCheckboxField,
  renderLayerPropertyKeyframeButton,
  renderLayerRangeField,
  renderNumberField,
  renderParamKeyframeButton,
  renderParamSocketDot,
  renderRangeField,
  renderSelectField,
  renderSelectFieldGrouped,
  syncTimelineButtons,
} from "./graph-inspector-fields.js";
import {
  hexToRgb,
  normalizeHexOrNull,
  rgbToHex,
} from "./graph-color-math.js";
import {
  initDitherInspector,
  renderDitherNode,
  renderPatternDitherNode,
  renderPaletteManager,
  renderThresholdNode,
} from "./graph-inspector-dither.js";
import {
  renderMaskApplyNode,
  renderMaskCombineNode,
  renderMixNode,
} from "./graph-inspector-mix.js";
import {
  handleXyPadKeyDown,
  initXyPad,
  renderXyPadField,
  startXyPadInteraction,
} from "./graph-xy-pad.js";
import {
  renderCropNode,
  renderFlipNode,
  renderPixelateNode,
  renderScaleNode,
  renderTransformNode,
} from "./graph-inspector-geometry.js";
import {
  commitMeshStopField,
  handleMeshAction,
  initGradientInspector,
  renderGradientMapNode,
  renderGradientNode,
  renderMeshGradientNode,
  renderNoiseNode,
} from "./graph-inspector-gradient.js";
import {
  clamp,
  clamp01,
  formatFpsReadout,
  formatSignedStops,
  formatSignedValue,
  getLayerPropertyDefaultValue,
  initInspectorUtils,
  readControlValue,
  syncLayerPropertySiblingControls,
  syncSiblingControls,
  updateInlineReadout,
} from "./graph-inspector-utils.js";
import {
  renderAdjustNode,
  renderHsvNode,
  renderInvertNode,
  renderRgbToBwNode,
  renderSourceNode,
} from "./graph-inspector-source.js";
import {
  renderBlurNode,
  renderEmptyInspector,
  renderMathNode,
  renderPosterizeNode,
  renderValueNode,
  renderViewerOutputNode,
} from "./graph-inspector-misc.js";
import {
  renderDuotoneNode,
  renderLevelsNode,
  renderRgbCurvesNode,
  renderSceneGradeNode,
  renderToneMapNode,
} from "./graph-inspector-color-grading.js";
import {
  renderBloomNode,
  renderChromaticAberrationNode,
  renderDisplaceNode,
  renderGlareNode,
  renderHalationNode,
  renderLensDistortNode,
} from "./graph-inspector-effects.js";
import {
  applyColorPickerHex,
  closeColorPicker,
  commitColorPickerValue,
  handleColorPickerEyedropper,
  initColorPicker,
  isAnyColorPickerOpen,
  popPickerHexSnapshot,
  readColorPickerCurrentHex,
  readPickerValueFromState,
  renderColorField,
  renderColorPickerControl,
  renderGradientStopColorField,
  resolveColorPickerTarget,
  snapshotPickerHexIfNew,
  startColorPickerDrag,
  syncColorPickerElements,
  toggleColorPicker,
} from "./graph-color-picker.js";
import {
  GRADIENT_RAMP_MAX_STOPS,
  commitGradientMapStopColor,
  commitGradientStopColorTarget,
  handleGradientRampClick,
  handleGradientRampKeyDown,
  initGradientRamp,
  isGradientRampNode,
  normalizeGradientMapInspectorStops,
  renderGradientRampField,
  startGradientRampStopDrag,
  syncGradientRampElements,
  syncGradientStopSiblingControls,
} from "./graph-gradient-ramp.js";
import {
  commitCurvePoints,
  curveChannelLabel,
  handleCurveChannelClick,
  handleCurveClick,
  initCurveEditor,
  normalizeCurveChannel,
  readCurveParamPoints,
  readCurvePoints,
  renderCurveChannelStrip,
  renderCurveField,
  startCurveDrag,
} from "./graph-curve-editor.js";

let nodesEl;
let edgesEl;
let editorEl;
let inspectorEl;
let inspectorTitleEl;
let stageEl;
let resizeObserver;
let renderedInspectorNodeId = null;
let inspectorEditing = false;
let paletteExtractionSize = 4;
let graphRenameNodeId = null;
// F17.1 inspector undo: snapshot a control's pre-drag value the first time
// `input` fires for it, then turn the whole drag into a single history entry
// when `change` flushes. Key: "${nodeId}|param|${paramKey}".
const inspectorParamSnapshots = new Map();

function setInspectorEditingFlag(value) {
  inspectorEditing = Boolean(value);
}

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
  initDitherInspector({
    getPaletteExtractionSize: () => paletteExtractionSize,
  });
  initCurveEditor({
    renderInspector,
    setInspectorEditing: setInspectorEditingFlag,
  });
  initXyPad({
    inspectorEl,
    cssEscape,
    renderInspector,
    setInspectorEditing: setInspectorEditingFlag,
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
    setInspectorEditing: setInspectorEditingFlag,
  });
  initColorPicker({
    inspectorEl,
    cssEscape,
    renderInspector,
    setInspectorEditing: setInspectorEditingFlag,
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
    if (parentId !== getLastRenderedGraphParentId()) {
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
    if (pickerTarget) {
      snapshotPickerHexIfNew(pickerTarget.targetId, readPickerValueFromState(pickerTarget));
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
    const oldHex = popPickerHexSnapshot(target?.targetId);
    if (oldHex !== null) {
      const finalHex = readPickerValueFromState(target);
      if (finalHex && oldHex !== finalHex) {
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
      clearPaletteSwatchLocks(selectedId);
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
        clearPaletteSwatchLocks(extracted.id);
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
  if (!canBypassGraphNode(node)) {
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
  startCurveDrag(event, svg);
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


function onInspectorKeyDown(event) {
  if (event.key === "Escape" && isAnyColorPickerOpen()) {
    closeColorPicker();
    inspectorEditing = false;
    renderInspector();
    return;
  }

  const rampStop = event.target.closest?.("[data-gradient-ramp-stop]");
  if (rampStop && handleGradientRampKeyDown(event, rampStop)) {
    return;
  }

  const pad = event.target.closest?.("[data-xy-pad]");
  if (pad) handleXyPadKeyDown(event, pad);
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
