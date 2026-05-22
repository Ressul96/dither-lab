// Graph DOM render — extracted from graph-shell.js as part of the
// M.1 split. Owns the per-frame string-template build for the node
// cards and the SVG edge paths, plus the group-input/output proxy
// cards that appear when the user descends into a group.
//
// State kept private here:
//   * nodesEl / edgesEl — DOM refs the renderer writes into
//   * getGraphRenameNodeId — callback into graph-shell so the rename
//     input swap happens without leaking the mutable state across modules
//   * lastRenderedParentId — the parent the renderer last wrote out, so
//     graph-shell's `graphView` subscriber can skip a full rebuild when
//     the parent hasn't changed
//
// The renderer is intentionally HTML-string + innerHTML. M.4 (the
// replaceChildren migration) is a separate ticket; this commit only
// moves the existing strings into a new file without changing the
// render strategy.
//
// `renderSocketRows` is exported because palette-ui's drop handler
// needs to splice a freshly-created node's socket rows into the DOM
// before the next full render — see initPaletteDragAndDrop in
// palette-ui.js.

import { getState } from "../state.js";
import {
  ROOT_PARENT_ID,
  getNodeById,
  getNodeDefinition,
  getNodeParentId,
  getSelectedNodeIds,
  getSoloNodeId,
} from "../graph.js";
import { escapeHtml, setInnerHtml } from "./utils.js";
import { syncGraphBreadcrumb } from "./graph-breadcrumb.js";
import { syncInsertHighlight } from "./graph-edge-insert.js";
import {
  getCurrentGraphParentId,
  getVisibleGraphNodeIds,
  getVisibleGraphNodes,
} from "./graph-view-scope.js";
import { canBypassGraphNode } from "./graph-node-policy.js";
import {
  GRAPH_WORLD_SIZE,
  computeChildrenBbox,
  getSocketPoint,
  toSceneX,
  toSceneY,
} from "./graph-geometry.js";

let nodesEl = null;
let edgesEl = null;
let getGraphRenameNodeId = () => null;
let lastRenderedParentId = "";

export function initGraphRender(refs) {
  nodesEl = refs.nodesEl;
  edgesEl = refs.edgesEl;
  getGraphRenameNodeId = typeof refs.getGraphRenameNodeId === "function"
    ? refs.getGraphRenameNodeId
    : () => null;
}

// Exposed so graph-shell's `graphView` subscriber can avoid a full
// renderGraph when only the viewport (pan/zoom) changed.
export function getLastRenderedGraphParentId() {
  return lastRenderedParentId;
}

export function renderGraph() {
  if (!nodesEl || !edgesEl) return;
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
  setInnerHtml(nodesEl, nodesHtml + proxiesHtml);
  lastRenderedParentId = parentId;
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

export function renderEdges(parentId = getCurrentGraphParentId()) {
  if (!edgesEl) return;
  const { graph } = getState();
  const visibleNodeIds = getVisibleGraphNodeIds(graph, parentId);
  edgesEl.setAttribute("viewBox", `0 0 ${GRAPH_WORLD_SIZE} ${GRAPH_WORLD_SIZE}`);
  edgesEl.setAttribute("width", String(GRAPH_WORLD_SIZE));
  edgesEl.setAttribute("height", String(GRAPH_WORLD_SIZE));
  setInnerHtml(
    edgesEl,
    graph.edges
      .filter((edge) => visibleNodeIds.has(edge.fromNode) && visibleNodeIds.has(edge.toNode))
      .map((edge) => renderEdge(edge, graph))
      .join("")
  );
  syncInsertHighlight();
}

function renderNode(node, selectedNodeIds, soloNodeId = null) {
  const definition = getNodeDefinition(node.type);
  const selected = selectedNodeIds.has(node.id) ? " selected" : "";
  const bypassed = node.bypassed ? " is-bypassed" : "";
  const solo = soloNodeId === node.id ? " is-solo" : "";
  const family = familySlug(definition?.family);
  const canBypass = canBypassGraphNode(node);
  const bypassIcon = node.bypassed ? eyeClosedSvg() : eyeOpenSvg();
  const renameId = getGraphRenameNodeId();
  const title = renameId === node.id
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

export function renderSocketRows(node) {
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
