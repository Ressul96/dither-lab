import { dispatch, getState } from "../state.js";
import {
  ROOT_PARENT_ID,
  getNodeById,
  getNodeParentId,
  resolveGraphParentId,
} from "../graph.js";
import { getCurrentGraphParentId } from "./graph-view-scope.js";
import { escapeHtml, setInnerHtml } from "./utils.js";

let graphBreadcrumbEl = null;

export function initGraphBreadcrumb(editorEl) {
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

export function syncGraphBreadcrumb(parentId = getCurrentGraphParentId()) {
  if (!graphBreadcrumbEl) return;
  const chain = getGraphBreadcrumbChain(parentId);
  setInnerHtml(
    graphBreadcrumbEl,
    chain
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
      .join("")
  );
}

export function setCurrentGraphParent(parentId) {
  const { graph } = getState();
  const currentParentId = resolveGraphParentId(graph, parentId);
  dispatch("graphView", { currentParentId });
  const selected = graph.nodes.find((node) => node.id === graph.selectedNodeId);
  if (selected && getNodeParentId(selected) !== currentParentId) {
    dispatch("graph", { selectedNodeId: null, selectedNodeIds: [] });
  }
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
