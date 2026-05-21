export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 108;
export const SOCKET_Y = 58;
export const SOCKET_STEP = 28;
export const GRAPH_WORLD_SIZE = 16000;
export const GRAPH_WORLD_ORIGIN = GRAPH_WORLD_SIZE / 2;
export const GRAPH_GRID_STEP = 24;
export const SOCKET_HIT_RADIUS = 28;
// Generous radius around an edge counts as a drop-on-edge target. The user
// rarely lands the ghost preview exactly on the SVG path, so a wide tolerance
// trades a tiny bit of "free placement" precision for the much more useful
// "drop here, snap into the chain" behaviour. The fallback radius is even
// wider and is only consulted when the precise path-distance check fails.
export const EDGE_INSERT_RADIUS = 140;
export const EDGE_INSERT_FALLBACK_RADIUS = 240;
export const GRAPH_VIEW_PADDING = 120;
export const EDGE_CUT_RADIUS = 10;
export const GRAPH_MARQUEE_THRESHOLD = 4;

const GROUP_PROXY_BBOX_HEIGHT = 120;

export function getNodeRenderHeight(node) {
  return Math.max(NODE_HEIGHT, node.outputs?.length * SOCKET_STEP + SOCKET_Y + 26);
}

export function getGraphNodesBounds(nodes) {
  return nodes.reduce(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      maxX: Math.max(acc.maxX, node.x + NODE_WIDTH),
      minY: Math.min(acc.minY, node.y),
      maxY: Math.max(acc.maxY, node.y + getNodeRenderHeight(node)),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
}

export function computeChildrenBbox(nodes) {
  if (!nodes?.length) {
    return {
      minX: GRAPH_WORLD_ORIGIN,
      maxX: GRAPH_WORLD_ORIGIN + NODE_WIDTH,
      minY: GRAPH_WORLD_ORIGIN,
      maxY: GRAPH_WORLD_ORIGIN + GROUP_PROXY_BBOX_HEIGHT,
      centerY: GRAPH_WORLD_ORIGIN + GROUP_PROXY_BBOX_HEIGHT / 2,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + NODE_WIDTH);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + GROUP_PROXY_BBOX_HEIGHT);
  }
  return { minX, maxX, minY, maxY, centerY: (minY + maxY) / 2 };
}

export function getSocketPoint(node, kind, socketName) {
  if (kind === "input" && typeof socketName === "string" && socketName.startsWith("param:")) {
    const baseRowCount = Math.max(node.inputs.length, node.outputs.length, 1);
    const exposed = Array.isArray(node.exposedParams) ? node.exposedParams : [];
    const paramKey = socketName.slice("param:".length);
    const paramIndex = exposed.indexOf(paramKey);
    const rowIndex = baseRowCount + Math.max(0, paramIndex);
    return {
      x: toSceneX(node.x + 14),
      y: toSceneY(node.y + SOCKET_Y + rowIndex * SOCKET_STEP),
    };
  }

  const sockets = kind === "output" ? node.outputs : node.inputs;
  const index = Math.max(0, sockets.findIndex((socket) => socket.name === socketName));

  return {
    x: kind === "output" ? toSceneX(node.x + NODE_WIDTH - 14) : toSceneX(node.x + 14),
    y: toSceneY(node.y + SOCKET_Y + index * SOCKET_STEP),
  };
}

export function segmentsIntersect(a, b, c, d) {
  const denom = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (denom === 0) return false;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denom;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function segmentDistance(a, b, c, d) {
  return Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b),
  );
}

export function rectsIntersect(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function toSceneX(worldX) {
  return GRAPH_WORLD_ORIGIN + worldX;
}

export function toSceneY(worldY) {
  return GRAPH_WORLD_ORIGIN + worldY;
}

export function modulo(value, divisor) {
  if (!divisor) return 0;
  return ((value % divisor) + divisor) % divisor;
}

function pointToSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq, 0, 1);
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return Math.hypot(point.x - x, point.y - y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
