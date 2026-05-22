import { getNodeDefinition } from "../graph.js";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  toSceneX,
  toSceneY,
} from "./graph-geometry.js";
import { escapeHtml, setInnerHtml } from "./utils.js";

let nodePaletteSearchEl = null;
let nodePaletteEmptyEl = null;
let draggedPaletteType = "";
let paletteDragPreviewEl = null;

export function initNodePaletteSearch() {
  nodePaletteSearchEl = document.querySelector("[data-node-palette-search]");
  nodePaletteEmptyEl = document.querySelector("[data-node-palette-empty]");
  if (!nodePaletteSearchEl) return;
  nodePaletteSearchEl.addEventListener("input", () => {
    filterNodePalette(nodePaletteSearchEl.value);
  });
  nodePaletteSearchEl.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!nodePaletteSearchEl.value) return;
    event.stopPropagation();
    nodePaletteSearchEl.value = "";
    filterNodePalette("");
  });
  filterNodePalette(nodePaletteSearchEl.value);
}

function filterNodePalette(value) {
  const query = normalizePaletteSearch(value);
  let visibleCount = 0;
  for (const group of document.querySelectorAll(".node-palette-group")) {
    const family = normalizePaletteSearch(group.dataset.nodeFamily ?? "");
    let groupVisible = false;
    for (const item of group.querySelectorAll("[data-palette-node]")) {
      const label = normalizePaletteSearch(item.textContent ?? "");
      const type = normalizePaletteSearch(item.dataset.paletteNode ?? "");
      const visible = !query || label.includes(query) || type.includes(query) || family.includes(query);
      item.classList.toggle("is-hidden", !visible);
      groupVisible = groupVisible || visible;
      if (visible) visibleCount += 1;
    }
    group.classList.toggle("is-hidden", !groupVisible);
  }
  nodePaletteEmptyEl?.classList.toggle("hidden", visibleCount > 0);
}

function normalizePaletteSearch(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function initPaletteDragAndDrop(deps) {
  const { editorEl, stageEl } = deps;
  for (const item of document.querySelectorAll("[data-palette-node]")) {
    item.setAttribute("draggable", "false");
    item.addEventListener("pointerdown", (event) => {
      startPalettePointerDrag(event, item, deps);
    });

    item.addEventListener("dragstart", (e) => {
      const type = item.dataset.paletteNode;
      if (!type) return;
      draggedPaletteType = type;
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("application/x-node-type", type);
      e.dataTransfer.setData("text/plain", `ditherlab-node:${type}`);
    });

    item.addEventListener("dragend", () => {
      draggedPaletteType = "";
      removePaletteDragPreview();
      deps.clearInsertHighlight();
    });
  }

  editorEl.addEventListener("dragover", (e) => {
    const type = resolvePaletteNodeType(e.dataTransfer);
    if (!type) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    updatePaletteDragPreview(type, e.clientX, e.clientY, deps);
    const edge = deps.findInsertableEdgeAt(e.clientX, e.clientY);
    deps.setInsertHighlight(edge?.edgeId ?? "");
  });

  editorEl.addEventListener("drop", (e) => {
    const type = resolvePaletteNodeType(e.dataTransfer);
    draggedPaletteType = "";
    const edge = deps.findInsertTargetAt(e.clientX, e.clientY);
    removePaletteDragPreview();
    deps.clearInsertHighlight();
    if (!type) return;
    e.preventDefault();
    if (edge?.edgeId) {
      const inserted = deps.insertNodeOnEdge(edge.edgeId, type, {
        position: deps.nodePositionFromPoint(deps.clientToWorld(e.clientX, e.clientY)),
      });
      if (!inserted) deps.createNodeFromPalette(type, deps.clientToWorld(e.clientX, e.clientY));
      return;
    }
    deps.createNodeFromPalette(type, deps.clientToWorld(e.clientX, e.clientY));
  });

  editorEl.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && editorEl.contains(event.relatedTarget)) return;
    removePaletteDragPreview();
    deps.clearInsertHighlight();
  });

  stageEl?.addEventListener("dragover", (e) => {
    if (!resolvePaletteNodeType(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    removePaletteDragPreview();
    deps.clearInsertHighlight();
  });

  stageEl?.addEventListener("drop", (e) => {
    const type = resolvePaletteNodeType(e.dataTransfer);
    draggedPaletteType = "";
    removePaletteDragPreview();
    deps.clearInsertHighlight();
    if (!type) return;
    e.preventDefault();
    deps.insertPaletteNodeAtDefault(type);
  });
}

function startPalettePointerDrag(event, item, deps) {
  if (event.button !== 0) return;
  const type = item.dataset.paletteNode;
  if (!type) return;

  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;

  try {
    item.setPointerCapture(event.pointerId);
  } catch {}

  const onMove = (ev) => {
    const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY);
    if (!dragging && moved < 6) return;

    if (!dragging) {
      dragging = true;
      item.classList.add("is-dragging");
    }

    if (isPointOverEditor(ev.clientX, ev.clientY)) {
      updatePaletteDragPreview(type, ev.clientX, ev.clientY, deps);
      const edge = deps.findInsertableEdgeAt(ev.clientX, ev.clientY);
      deps.setInsertHighlight(edge?.edgeId ?? "");
    } else {
      removePaletteDragPreview();
      deps.clearInsertHighlight();
    }
  };

  const onUp = (ev) => {
    item.removeEventListener("pointermove", onMove);
    item.removeEventListener("pointerup", onUp);
    item.removeEventListener("pointercancel", onUp);

    item.classList.remove("is-dragging");
    removePaletteDragPreview();

    try {
      item.releasePointerCapture(event.pointerId);
    } catch {}

    const droppedOnEditor = isPointOverEditor(ev.clientX, ev.clientY);
    const droppedOnStage = isPointOverStage(ev.clientX, ev.clientY);

    if (!dragging) {
      deps.clearInsertHighlight();
      deps.insertPaletteNodeAtDefault(type);
      return;
    }

    if (droppedOnEditor) {
      const edge = deps.findInsertTargetAt(ev.clientX, ev.clientY);
      deps.clearInsertHighlight();
      if (edge?.edgeId) {
        const inserted = deps.insertNodeOnEdge(edge.edgeId, type, {
          position: deps.nodePositionFromPoint(deps.clientToWorld(ev.clientX, ev.clientY)),
        });
        if (!inserted) deps.createNodeFromPalette(type, deps.clientToWorld(ev.clientX, ev.clientY));
      } else {
        deps.createNodeFromPalette(type, deps.clientToWorld(ev.clientX, ev.clientY));
      }
      return;
    }

    deps.clearInsertHighlight();
    if (droppedOnStage) {
      deps.insertPaletteNodeAtDefault(type);
    }
  };

  item.addEventListener("pointermove", onMove);
  item.addEventListener("pointerup", onUp);
  item.addEventListener("pointercancel", onUp);
}

function updatePaletteDragPreview(type, clientX, clientY, deps) {
  if (!deps.nodesEl || !isPointOverEditor(clientX, clientY)) {
    removePaletteDragPreview();
    return;
  }

  if (!paletteDragPreviewEl || paletteDragPreviewEl.dataset.previewType !== type) {
    removePaletteDragPreview();
    paletteDragPreviewEl = createPaletteDragPreview(type, deps.renderSocketRows);
    if (!paletteDragPreviewEl) return;
    deps.nodesEl.appendChild(paletteDragPreviewEl);
  }

  const point = deps.clientToWorld(clientX, clientY);
  paletteDragPreviewEl.style.left = `${toSceneX(point.x - NODE_WIDTH / 2)}px`;
  paletteDragPreviewEl.style.top = `${toSceneY(point.y - NODE_HEIGHT / 2)}px`;
}

function createPaletteDragPreview(type, renderSocketRows) {
  const definition = getNodeDefinition(type);
  if (!definition) return null;
  const previewNode = {
    id: "drag-preview",
    type,
    label: definition.label,
    inputs: definition.inputs,
    outputs: definition.outputs,
  };

  const preview = document.createElement("div");
  preview.className = "graph-node graph-node--drag-preview";
  preview.dataset.previewType = type;
  setInnerHtml(preview, `
    <div class="graph-node-head">
      <span class="graph-node-title">${escapeHtml(definition.label)}</span>
      <span class="graph-node-family">${escapeHtml(definition.family ?? "Node")}</span>
    </div>
    <div class="graph-node-rows">
      ${renderSocketRows(previewNode)}
    </div>
  `);
  return preview;
}

function removePaletteDragPreview() {
  paletteDragPreviewEl?.remove();
  paletteDragPreviewEl = null;
}

function resolvePaletteNodeType(dataTransfer) {
  const customType = dataTransfer?.getData?.("application/x-node-type");
  if (customType) return customType;

  const textType = dataTransfer?.getData?.("text/plain");
  if (typeof textType === "string" && textType.startsWith("ditherlab-node:")) {
    return textType.slice("ditherlab-node:".length);
  }

  return draggedPaletteType || "";
}

function isPointOverEditor(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return Boolean(target?.closest?.("#nodeEditor"));
}

function isPointOverStage(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return Boolean(target?.closest?.("#stage"));
}
