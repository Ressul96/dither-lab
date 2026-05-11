// SVG layer hosted inside .stage-canvas for on-canvas gizmos. F7.1 wires up
// the scaffolding only — no node-specific gizmos yet. Future phases (F7.2,
// F7.3) attach handles to this layer and use the coordinate helpers below
// to map between the viewport, the source canvas, and the overlay's own
// pixel frame.

let overlayEl = null;

export function initViewerOverlay(stageCanvas) {
  if (overlayEl) return overlayEl;
  if (!stageCanvas) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "viewerOverlay";
  svg.classList.add("viewer-overlay");
  svg.setAttribute("aria-hidden", "true");
  stageCanvas.appendChild(svg);
  overlayEl = svg;
  return overlayEl;
}

export function getViewerOverlay() {
  return overlayEl;
}

// Map a viewport (clientX/clientY) point into the source canvas frame.
// Returns:
//   x, y   — pixel coordinates inside sourceCanvas (0..width / 0..height),
//   nx, ny — same point as 0..100 percent for params like centerX/centerY.
// Coordinates are clamped so a drag past the canvas edge resolves to the edge
// rather than NaN. Returns null when the canvas has no layout box yet.
export function clientToSourcePoint(clientX, clientY, sourceCanvas) {
  if (!sourceCanvas) return null;
  const rect = sourceCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const px = (clientX - rect.left) / rect.width;
  const py = (clientY - rect.top) / rect.height;
  return {
    x: clamp(px * sourceCanvas.width, 0, sourceCanvas.width),
    y: clamp(py * sourceCanvas.height, 0, sourceCanvas.height),
    nx: clamp(px * 100, 0, 100),
    ny: clamp(py * 100, 0, 100),
  };
}

// Map a point inside the source canvas frame into the overlay's local pixel
// frame so SVG attributes (cx, cy, x, y, transform translate) can position
// handles directly without a viewBox transform.
export function sourceToOverlayPoint(srcX, srcY, sourceCanvas, overlay = overlayEl) {
  if (!sourceCanvas || !overlay) return null;
  if (sourceCanvas.width === 0 || sourceCanvas.height === 0) return null;
  const canvasRect = sourceCanvas.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const nx = srcX / sourceCanvas.width;
  const ny = srcY / sourceCanvas.height;
  return {
    x: canvasRect.left - overlayRect.left + nx * canvasRect.width,
    y: canvasRect.top - overlayRect.top + ny * canvasRect.height,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
