import { dispatch, getState } from "../state.js";
import { getSelectedNodeIds } from "../graph.js";
import {
  GRAPH_MARQUEE_THRESHOLD,
  rectsIntersect,
  toSceneX,
  toSceneY,
} from "./graph-geometry.js";
import {
  markGraphKeyboardActive,
  setGraphPointerInsideEditor,
  syncGraphCutCursorFromPointer,
  syncGraphInteractionModeClasses,
} from "./graph-keyboard.js";
import { startEdgeCut } from "./graph-edge-cut.js";

let editorEl = null;
let nodesEl = null;
let deps = {};
let activeGraphMarquee = null;

export function initGraphViewportInteractions(nextDeps) {
  deps = nextDeps;
  editorEl = nextDeps.editorEl;
  nodesEl = nextDeps.nodesEl;
  if (!editorEl || !nodesEl) return;

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
    setGraphPointerInsideEditor(true, e);
  });
  editorEl.addEventListener("pointermove", (e) => {
    syncGraphCutCursorFromPointer(e);
    syncGraphInteractionModeClasses();
  });
  editorEl.addEventListener("pointerleave", () => {
    setGraphPointerInsideEditor(false);
  });

  editorEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    markGraphKeyboardActive();
    if (e.target.closest("[data-node-id]") || e.target.closest(".graph-socket-hit")) return;
    // The breadcrumb lives inside #nodeEditor, so pan capture would prevent
    // the follow-up click from reaching Root / group buttons.
    if (e.target.closest(".graph-breadcrumb")) return;
    if (e.altKey) {
      startEdgeCut(e);
      return;
    }
    // Cmd / Ctrl held over empty canvas opens marquee box-select.
    // Plain left-drag remains the default pan gesture.
    if (e.metaKey || e.ctrlKey) {
      startGraphBoxSelect(e);
      return;
    }
    startEditorPan(e);
  });
}

function zoomGraphAtPointer(e) {
  const { graphView } = getState();
  const point = deps.clientToWorld(e.clientX, e.clientY);
  const local = deps.getLocalPoint(e.clientX, e.clientY);
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
    deps.selectNodesWithoutDispatch(nodeIds, nodeIds.at(-1) ?? null);
    syncRenderedNodeSelection(nodeIds);
    deps.renderInspector();
    deps.renderEdges();
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

export function cancelActiveGraphMarquee() {
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
