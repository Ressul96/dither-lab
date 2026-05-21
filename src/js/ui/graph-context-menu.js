import { getState } from "../state.js";
import {
  duplicateNode,
  getNodeById,
  getNodeDefinition,
  getNodeParentId,
  getSelectedNodeIds,
  groupSelectedNodes,
  insertNodeOnEdge,
  removeNode,
  selectNode,
  toggleNodeBypass,
  ungroupNode,
} from "../graph.js";
import { setCurrentGraphParent } from "./graph-breadcrumb.js";
import { canBypassGraphNode } from "./graph-node-policy.js";
import { escapeHtml } from "./utils.js";

let graphMenuEl = null;
let graphMenuState = null;

export function initGraphContextMenu(deps) {
  const {
    editorEl,
    nodesEl,
    clearInsertHighlight,
    clientToWorld,
    createNodeFromPalette,
    findInsertableEdgeAt,
    getViewportCenterWorld,
    nodePositionFromPoint,
    setInsertHighlight,
  } = deps;

  if (graphMenuEl || !editorEl || !nodesEl) return;

  graphMenuEl = document.createElement("div");
  graphMenuEl.className = "context-menu graph-node-picker floating-card hidden";

  graphMenuEl.addEventListener("click", (event) => {
    const nodeAction = event.target.closest("[data-node-menu-action]");
    if (nodeAction) {
      handleGraphNodeMenuAction(nodeAction);
      hideGraphContextMenu(clearInsertHighlight);
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

    hideGraphContextMenu(clearInsertHighlight);
  });

  nodesEl.addEventListener("contextmenu", (event) => {
    onNodeContextMenu(event, {
      clientToWorld,
    });
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
    graphMenuEl.className = "context-menu graph-node-picker floating-card hidden";
    graphMenuEl.innerHTML = renderGraphContextMenuContent(Boolean(edge?.edgeId));
    positionGraphContextMenu(event.clientX, event.clientY);
  });

  document.body.appendChild(graphMenuEl);

  document.addEventListener("click", (event) => {
    if (!graphMenuEl.classList.contains("hidden") && !graphMenuEl.contains(event.target)) {
      hideGraphContextMenu(clearInsertHighlight);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideGraphContextMenu(clearInsertHighlight);
  });
}

function onNodeContextMenu(event, deps) {
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
    point: deps.clientToWorld(event.clientX, event.clientY),
  };
  graphMenuEl.className = "context-menu graph-node-context-menu floating-card hidden";
  graphMenuEl.innerHTML = renderGraphNodeMenuContent(node.id);
  positionGraphContextMenu(event.clientX, event.clientY);
}

function hideGraphContextMenu(clearInsertHighlight) {
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
      groupSelectedNodes();
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
  return canBypassGraphNode(node);
}

function canDeleteGraphNode(node) {
  return Boolean(node && node.type !== "source" && node.type !== "viewer-output");
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
