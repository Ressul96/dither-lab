// Inspector orchestration — owns `renderInspector` and the
// per-type dispatcher (`renderNodeSpecifics`) that fans out to
// every node-specific renderer module. Also carries the small
// shared chrome the inspector wraps around node panels: actions
// strip, layer adjust strip, multi-selection summary, and the
// group node + group-boundary lists.
//
// State kept private here is `renderedInspectorNodeId` — the
// selection key the last full render painted. graph-shell's
// `renderShell` reads it through `getRenderedInspectorNodeId`
// to decide whether to skip a no-op re-render while an
// inspector drag is live.

import { getState } from "../state.js";
import {
  getNodeById,
  getNodeParentId,
  getSelectedNode,
  getSelectedNodeIds,
} from "../graph.js";
import { escapeHtml, setInnerHtml } from "./utils.js";
import { canBypassGraphNode } from "./graph-node-policy.js";
import {
  isLayerAdjustableNode,
  renderLayerRangeField,
} from "./graph-inspector-fields.js";
import { renderEmptyInspector } from "./graph-inspector-misc.js";
import {
  renderBlurNode,
  renderMathNode,
  renderPosterizeNode,
  renderValueNode,
  renderViewerOutputNode,
} from "./graph-inspector-misc.js";
import {
  renderAdjustNode,
  renderHsvNode,
  renderInvertNode,
  renderRgbToBwNode,
  renderSourceNode,
} from "./graph-inspector-source.js";
import {
  renderDuotoneNode,
  renderLevelsNode,
  renderRgbCurvesNode,
  renderSceneGradeNode,
  renderToneMapNode,
} from "./graph-inspector-color-grading.js";
import {
  renderCropNode,
  renderFlipNode,
  renderPixelateNode,
  renderScaleNode,
  renderTransformNode,
} from "./graph-inspector-geometry.js";
import {
  renderGradientMapNode,
  renderGradientNode,
  renderMeshGradientNode,
  renderNoiseNode,
} from "./graph-inspector-gradient.js";
import {
  renderDitherNode,
  renderPatternDitherNode,
  renderThresholdNode,
} from "./graph-inspector-dither.js";
import {
  renderMaskApplyNode,
  renderMaskCombineNode,
  renderMixNode,
} from "./graph-inspector-mix.js";
import {
  renderBloomNode,
  renderChromaticAberrationNode,
  renderDisplaceNode,
  renderGlareNode,
  renderHalationNode,
  renderLensDistortNode,
} from "./graph-inspector-effects.js";
import {
  renderAnalogNode,
  renderAsciiNode,
  renderCrtNode,
  renderDepthOfFieldNode,
  renderHalftoneNode,
  renderLedScreenNode,
  renderModulationNode,
  renderPixelSortingNode,
  renderVhsNode,
} from "./graph-inspector-stylize.js";

let inspectorEl = null;
let inspectorTitleEl = null;
let renderedInspectorNodeId = null;

export function initInspectorCore(refs) {
  inspectorEl = refs.inspectorEl ?? null;
  inspectorTitleEl = refs.inspectorTitleEl ?? null;
}

export function getRenderedInspectorNodeId() {
  return renderedInspectorNodeId;
}

export function renderInspector() {
  if (!inspectorEl) return;
  const { graph } = getState();
  const selectedNodeIds = getSelectedNodeIds(graph);
  if (selectedNodeIds.length > 1) {
    renderedInspectorNodeId = selectedNodeIds.join(",");
    syncInspectorTitle(null, `${selectedNodeIds.length} nodes selected`);
    setInnerHtml(inspectorEl, renderMultiSelectionInspector(selectedNodeIds));
    return;
  }

  const node = getSelectedNode(graph);
  renderedInspectorNodeId = node?.id ?? null;

  if (!node) {
    syncInspectorTitle(null);
    setInnerHtml(inspectorEl, renderEmptyInspector());
    return;
  }

  syncInspectorTitle(node);

  setInnerHtml(inspectorEl, `
    ${renderNodeActions(node)}
    ${renderLayerControls(node)}
    ${renderNodeSpecifics(node)}
  `);
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
