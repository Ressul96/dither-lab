import { dispatch, getState } from "../state.js";
import {
  ROOT_PARENT_ID,
  exitClipGraphScope,
  getNodeById,
  getNodeParentId,
  isEditingClipGraph,
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
    if (event.target.closest("[data-exit-clip-scope]")) {
      exitClipGraphScope();
      return;
    }
    const button = event.target.closest("[data-graph-parent-id]");
    if (!button) return;
    setCurrentGraphParent(button.dataset.graphParentId);
  });
  editorEl.appendChild(graphBreadcrumbEl);
  syncGraphBreadcrumb();
}

export function syncGraphBreadcrumb(parentId = getCurrentGraphParentId()) {
  if (!graphBreadcrumbEl) return;
  const inClipScope = isEditingClipGraph();
  const chain = getGraphBreadcrumbChain(parentId);
  // In a clip scope the graph's "Root" is the clip graph's root, so relabel it
  // with the clip name and prepend an exit crumb back to the composition graph.
  if (inClipScope && chain.length > 0) {
    chain[0] = { id: ROOT_PARENT_ID, label: clipScopeLabel() };
  }
  const separator = `<span class="graph-breadcrumb-separator">/</span>`;
  const items = [];
  if (inClipScope) {
    items.push(
      `<button type="button" class="graph-breadcrumb-item graph-breadcrumb-exit-clip" data-exit-clip-scope title="Back to the composition graph">⤺ Composition</button>`
    );
  }
  chain.forEach((item, index) => {
    const active = index === chain.length - 1 ? " is-active" : "";
    items.push(
      `<button type="button" class="graph-breadcrumb-item${active}" data-graph-parent-id="${escapeHtml(item.id)}" aria-current="${index === chain.length - 1 ? "page" : "false"}">${escapeHtml(item.label)}</button>`
    );
  });
  setInnerHtml(graphBreadcrumbEl, items.join(separator));
}

// Label for the clip currently being edited (its source filename), shown in the
// breadcrumb. Falls back to a generic label when the clip can't be resolved.
function clipScopeLabel() {
  const { graphView, composition } = getState();
  const clipId = graphView?.clipScopeClipId;
  for (const track of composition?.tracks ?? []) {
    const clip = track.clips?.find((c) => c.id === clipId);
    if (clip) {
      const source = composition.sources?.find((s) => s.id === clip.sourceId);
      const base = source?.path ? source.path.split(/[/\\]/).pop() : clip.sourceId;
      return `${base || "Clip"} (clip)`;
    }
  }
  return "Clip graph";
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
