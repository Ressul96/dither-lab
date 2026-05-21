import { getState } from "../state.js";
import {
  getNodeById,
  getNodeParentId,
  getSelectedNodeIds,
  insertExistingNodeOnEdge,
  mutateNodePosition,
} from "../graph.js";
import { toSceneX, toSceneY } from "./graph-geometry.js";

let nodesEl = null;
let deps = {};

export function initGraphNodeDrag(nextDeps) {
  deps = nextDeps;
  nodesEl = nextDeps.nodesEl;
}

export function startNodeDrag(e, nodeEl) {
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
    ? selectedAtStart.filter((id) => {
        const item = getNodeById(id);
        return item && getNodeParentId(item) === deps.getCurrentGraphParentId();
      })
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
      deps.renderEdges();
    });
  };

  const onMove = (ev) => {
    const dx = ev.clientX - originX;
    const dy = ev.clientY - originY;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) {
      moved = true;
      deps.selectNodesWithoutDispatch(dragNodeIds, nodeId);
    }
    for (const id of dragNodeIds) {
      const start = startPositions.get(id);
      if (!start) continue;
      const nextX = start.x + dx / startZoom;
      const nextY = start.y + dy / startZoom;
      mutateNodePosition(id, nextX, nextY);
      const itemEl = nodesEl?.querySelector(`[data-node-id="${deps.cssEscape(id)}"]`);
      if (itemEl) {
        itemEl.style.left = `${toSceneX(nextX)}px`;
        itemEl.style.top = `${toSceneY(nextY)}px`;
      }
    }
    if (!liveEl.isConnected) {
      liveEl = nodesEl?.querySelector(`[data-node-id="${deps.cssEscape(nodeId)}"]`) || liveEl;
    }
    const edge = dragNodeIds.length === 1 ? deps.findInsertTargetForNodeAt(nodeId, ev.clientX, ev.clientY) : null;
    deps.setInsertHighlight(edge?.edgeId ?? "");
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
      deps.clearInsertHighlight();
    } else {
      const edge = dragNodeIds.length === 1 ? deps.findInsertTargetForNodeAt(nodeId, ev.clientX, ev.clientY) : null;
      deps.clearInsertHighlight();
      if (edge?.edgeId && insertExistingNodeOnEdge(nodeId, edge.edgeId)) {
        return;
      }

      for (const id of dragNodeIds) {
        nodesEl?.querySelector(`[data-node-id="${deps.cssEscape(id)}"]`)?.classList.add("selected");
      }
      deps.selectNodesWithoutDispatch(dragNodeIds, nodeId);
      deps.renderInspector();
      deps.renderEdges();
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}
