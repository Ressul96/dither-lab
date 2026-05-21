import { removeEdgesById } from "../graph.js";
import {
  EDGE_CUT_RADIUS,
  segmentDistance,
  segmentsIntersect,
} from "./graph-geometry.js";

let edgesEl = null;
let editorEl = null;
let clientToScene = null;

export function initGraphEdgeCut(deps) {
  edgesEl = deps.edgesEl;
  editorEl = deps.editorEl;
  clientToScene = deps.clientToScene;
}

export function startEdgeCut(e) {
  if (!edgesEl || !editorEl || !clientToScene) return;

  e.preventDefault();
  const points = [{
    scene: clientToScene(e.clientX, e.clientY),
    client: { x: e.clientX, y: e.clientY },
  }];

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "graph-cut-path");
  edgesEl.appendChild(path);

  const updatePath = () => {
    const d = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.scene.x} ${point.scene.y}`)
      .join(" ");
    path.setAttribute("d", d);
  };
  updatePath();

  document.body.classList.add("cutting-edges");
  editorEl.classList.add("cutting");
  try {
    editorEl.setPointerCapture(e.pointerId);
  } catch {}

  const onMove = (ev) => {
    const last = points[points.length - 1].client;
    if (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) < 4) return;
    points.push({
      scene: clientToScene(ev.clientX, ev.clientY),
      client: { x: ev.clientX, y: ev.clientY },
    });
    updatePath();
  };

  const onUp = () => {
    editorEl.removeEventListener("pointermove", onMove);
    editorEl.removeEventListener("pointerup", onUp);
    editorEl.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("cutting-edges");
    editorEl.classList.remove("cutting");
    try {
      editorEl.releasePointerCapture(e.pointerId);
    } catch {}

    const cuts = findEdgesIntersectingStroke(points.map((point) => point.scene));
    path.remove();
    if (cuts.length > 0) removeEdgesById(cuts);
  };

  editorEl.addEventListener("pointermove", onMove);
  editorEl.addEventListener("pointerup", onUp);
  editorEl.addEventListener("pointercancel", onUp);
}

function findEdgesIntersectingStroke(strokeScenePoints) {
  if (!strokeScenePoints || strokeScenePoints.length < 2) return [];
  const cut = [];
  for (const path of edgesEl.querySelectorAll(".graph-edge[data-edge-id]")) {
    if (edgeCrossesStroke(path, strokeScenePoints)) {
      cut.push(path.dataset.edgeId);
    }
  }
  return cut;
}

function edgeCrossesStroke(path, strokeScenePoints) {
  const total = path.getTotalLength?.() ?? 0;
  if (!Number.isFinite(total) || total <= 0) return false;
  const sampleCount = Math.max(16, Math.min(96, Math.round(total / 6)));
  const edgePoints = [];
  for (let i = 0; i <= sampleCount; i++) {
    edgePoints.push(path.getPointAtLength((total * i) / sampleCount));
  }

  for (let i = 0; i < edgePoints.length - 1; i++) {
    for (let j = 0; j < strokeScenePoints.length - 1; j++) {
      const edgeA = edgePoints[i];
      const edgeB = edgePoints[i + 1];
      const cutA = strokeScenePoints[j];
      const cutB = strokeScenePoints[j + 1];
      if (
        segmentsIntersect(edgeA, edgeB, cutA, cutB) ||
        segmentDistance(edgeA, edgeB, cutA, cutB) <= EDGE_CUT_RADIUS
      ) {
        return true;
      }
    }
  }
  return false;
}
