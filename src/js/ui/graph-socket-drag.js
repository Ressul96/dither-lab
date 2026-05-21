import { getState } from "../state.js";
import { addEdge, getNodeById } from "../graph.js";
import { SOCKET_HIT_RADIUS, getSocketPoint } from "./graph-geometry.js";

let edgesEl = null;
let nodesEl = null;
let clientToScene = null;
let lastHighlighted = null;

export function initGraphSocketDrag(deps) {
  edgesEl = deps.edgesEl;
  nodesEl = deps.nodesEl;
  clientToScene = deps.clientToScene;
}

export function startSocketDrag(e, socketEl) {
  e.preventDefault();
  e.stopPropagation();

  const fromNodeId = socketEl.dataset.socketNode;
  const fromSocketName = socketEl.dataset.socketName;
  const fromKind = socketEl.dataset.socketKind;
  const fromNode = getNodeById(fromNodeId);
  if (!fromNode || !edgesEl || !clientToScene) return;

  const start = getSocketPoint(fromNode, fromKind, fromSocketName);

  const ghost = document.createElementNS("http://www.w3.org/2000/svg", "path");
  ghost.setAttribute("class", "graph-edge graph-edge--ghost");
  edgesEl.appendChild(ghost);

  const updateGhost = (clientX, clientY) => {
    const pointer = clientToScene(clientX, clientY);
    const pointerX = pointer.x;
    const pointerY = pointer.y;
    const controlOffset = Math.max(72, Math.abs(pointerX - start.x) * 0.4);
    const p1 = fromKind === "output"
      ? [start.x + controlOffset, start.y]
      : [start.x - controlOffset, start.y];
    const p2 = fromKind === "output"
      ? [pointerX - controlOffset, pointerY]
      : [pointerX + controlOffset, pointerY];
    ghost.setAttribute(
      "d",
      `M ${start.x} ${start.y} C ${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${pointerX} ${pointerY}`
    );
  };

  updateGhost(e.clientX, e.clientY);

  const onMove = (ev) => {
    updateGhost(ev.clientX, ev.clientY);
    const hovered = findSocketAt(ev.clientX, ev.clientY, fromKind);
    highlightTarget(hovered, fromKind);
  };

  const onUp = (ev) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    clearHighlight();
    ghost.remove();

    const target = findSocketAt(ev.clientX, ev.clientY, fromKind);
    if (target) {
      if (target.kind === fromKind) return;
      if (fromKind === "output") {
        addEdge(fromNodeId, fromSocketName, target.nodeId, target.socketName);
      } else {
        addEdge(target.nodeId, target.socketName, fromNodeId, fromSocketName);
      }
      return;
    }

    // Fallback: pointer landed on a node body, not a specific socket. Try the
    // node's sockets in declaration order so dropping anywhere on the node
    // wires up to its first compatible pin -- addEdge already validates type
    // compatibility, so we just walk until one sticks.
    const targetNodeId = findNodeAt(ev.clientX, ev.clientY);
    if (!targetNodeId || targetNodeId === fromNodeId) return;
    const targetNode = getNodeById(targetNodeId);
    if (!targetNode) return;
    const candidates = fromKind === "output" ? targetNode.inputs : targetNode.outputs;
    for (const socket of candidates ?? []) {
      const ok = fromKind === "output"
        ? addEdge(fromNodeId, fromSocketName, targetNodeId, socket.name)
        : addEdge(targetNodeId, socket.name, fromNodeId, fromSocketName);
      if (ok) return;
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function findNodeAt(clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const el of stack) {
    const node = el.closest?.("[data-node-id]");
    if (node && nodesEl?.contains(node)) return node.dataset.nodeId;
  }
  return null;
}

function findSocketAt(clientX, clientY, fromKind = "") {
  let best = null;
  const zoom = getState().graphView.zoom || 1;
  const hitRadius = SOCKET_HIT_RADIUS * Math.max(1, 1 / Math.max(zoom, 0.35));

  for (const hit of nodesEl?.querySelectorAll(".graph-socket-hit") ?? []) {
    const dot = hit.querySelector(".graph-socket-dot") ?? hit;
    const rect = dot.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > hitRadius) continue;

    const kind = hit.dataset.socketKind;
    const compatibleBoost = kind && fromKind && kind !== fromKind ? -4 : 0;
    const score = distance + compatibleBoost;
    if (best && best.score <= score) continue;

    best = {
      nodeId: hit.dataset.socketNode,
      socketName: hit.dataset.socketName,
      kind,
      el: hit,
      score,
    };
  }

  return best;
}

function highlightTarget(target, fromKind) {
  if (lastHighlighted && lastHighlighted !== target?.el) {
    lastHighlighted.classList.remove("drop-target", "drop-reject");
    lastHighlighted = null;
  }
  if (!target) return;
  const reject = target.kind === fromKind;
  target.el.classList.add(reject ? "drop-reject" : "drop-target");
  lastHighlighted = target.el;
}

function clearHighlight() {
  if (lastHighlighted) {
    lastHighlighted.classList.remove("drop-target", "drop-reject");
    lastHighlighted = null;
  }
}
