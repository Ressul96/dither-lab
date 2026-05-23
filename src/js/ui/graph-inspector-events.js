// Inspector events — owns the inspector pane's `input` / `change` / `click`
// / `pointerdown` / `keydown` / `contextmenu` handlers, plus the two pieces
// of state that ride along with them:
//
//   - `inspectorEditing` flag: read across graph-shell's subscribe blocks
//     and renderShell so the graph DOM rebuild + inspector re-render skip
//     while a drag is live. Other modules (color picker, palette actions,
//     gradient ramp, curve editor, xy-pad) receive `setInspectorEditing`
//     as an init callback that points back here.
//   - `inspectorParamSnapshots` Map: F17.1 inspector undo. The first
//     `input` tick for a given control snapshots the pre-drag value, and
//     the matching `change` event flushes a single history entry covering
//     the whole drag. Key shape: `${nodeId}|${kind}|${paramKey}` where
//     kind ∈ "param" | "property".
//
// graph-shell wires the DOM listeners; this module owns the dispatching.
// `startNumEditScrub` and `handleGraphInspectorAction` are private helpers
// kept here because they're only used by the inspector handlers.

import { pushHistory } from "../state.js";
import {
  getNodeById,
  getSelectedNode,
  removeEdgesById,
  toggleParamExposed,
  ungroupNode,
  updateNodeLayerProperties,
  updateNodeParams,
} from "../graph.js";
import {
  TIMELINE_BINDING_NODE_PROPERTY,
  commitBindingValueToTimeline,
  commitParamValueToTimeline,
  toggleParamKeyframeAtCurrentTime,
  toggleTimelineKeyframeAtCurrentTime,
  updateBindingKeyframeAtCurrentTime,
  updateParamKeyframeAtCurrentTime,
} from "../timeline.js";
import { sanitizeCurvePoints } from "../curve-lut.js";
import { setFps } from "../source.js";
import { setCurrentGraphParent } from "./graph-breadcrumb.js";
import { groupCurrentSelection } from "./graph-actions.js";
import { isLayerAdjustableNode } from "./graph-inspector-fields.js";
import { normalizeHexOrNull } from "./graph-color-math.js";
import { renderInspector } from "./graph-inspector-core.js";
import {
  getLayerPropertyDefaultValue,
  readControlValue,
  syncLayerPropertySiblingControls,
  syncSiblingControls,
  updateInlineReadout,
} from "./graph-inspector-utils.js";
import {
  commitMeshStopField,
  handleMeshAction,
} from "./graph-inspector-gradient.js";
import {
  handlePaletteChange,
  handlePaletteClick,
  handlePaletteInput,
} from "./graph-palette-actions.js";
import {
  applyColorPickerHex,
  closeColorPicker,
  commitColorPickerValue,
  handleColorPickerEyedropper,
  isAnyColorPickerOpen,
  popPickerHexSnapshot,
  readColorPickerCurrentHex,
  readPickerValueFromState,
  resolveColorPickerTarget,
  snapshotPickerHexIfNew,
  startColorPickerDrag,
  syncColorPickerElements,
  toggleColorPicker,
} from "./graph-color-picker.js";
import {
  commitGradientMapStopColor,
  handleGradientRampClick,
  handleGradientRampKeyDown,
  isGradientRampNode,
  startGradientRampStopDrag,
  syncGradientStopSiblingControls,
} from "./graph-gradient-ramp.js";
import {
  commitCurvePoints,
  handleCurveChannelClick,
  handleCurveClick,
  readCurveParamPoints,
  resolveCurveTarget,
  startCurveDrag,
} from "./graph-curve-editor.js";
import {
  handleXyPadKeyDown,
  startXyPadInteraction,
} from "./graph-xy-pad.js";

let inspectorEditing = false;
// F17.1 inspector undo: snapshot a control's pre-drag value the first time
// `input` fires for it, then turn the whole drag into a single history entry
// when `change` flushes. Key: "${nodeId}|param|${paramKey}".
const inspectorParamSnapshots = new Map();

export function isInspectorEditing() {
  return inspectorEditing;
}

export function setInspectorEditing(value) {
  inspectorEditing = Boolean(value);
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

export function onInspectorInput(event) {
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

export function onInspectorChange(event) {
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

export function onInspectorClick(event) {
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
    case "remove-binding": {
      // Group boundary bindings are derived from the underlying edge — the
      // user-facing "Remove" action deletes that edge, and analyzeGroupBoundary
      // recomputes the binding list on the next dispatch.
      const edgeId = control.dataset.bindingEdgeId;
      if (edgeId) removeEdgesById([edgeId]);
      break;
    }
    default:
      break;
  }
}

export function onInspectorPointerDown(event) {
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

export function onInspectorKeyDown(event) {
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

export function onInspectorContextMenu(event) {
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
