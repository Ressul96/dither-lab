import {
  getSelectedKeyframes,
  replaceSelectedKeyframes,
  selectionKey,
} from "./player-selection.js";

const MARQUEE_THRESHOLD = 4;
let marqueeDrag = null;
let marqueeJustEnded = false;
let renderAnimationTimelineCallback = () => {};

export function initPlayerMarquee({ renderAnimationTimeline } = {}) {
  if (typeof renderAnimationTimeline === "function") {
    renderAnimationTimelineCallback = renderAnimationTimeline;
  }
}

export function getMarqueeDrag() {
  return marqueeDrag;
}

export function getMarqueeJustEnded() {
  return marqueeJustEnded;
}

export function setMarqueeJustEnded(value) {
  marqueeJustEnded = Boolean(value);
}

export function startMarqueeDrag(lane, event) {
  // Right-click and middle-click should not start a marquee.
  if (event.button !== 0 && event.button !== undefined) return;
  event.preventDefault();
  const additive = event.shiftKey || event.metaKey || event.ctrlKey;
  marqueeDrag = {
    lane,
    rect: lane.getBoundingClientRect(),
    startX: event.clientX,
    additive,
    initial: additive ? new Set(getSelectedKeyframes()) : new Set(),
    moved: false,
    el: null,
  };
  document.addEventListener("pointermove", onMarqueePointerMove);
  document.addEventListener("pointerup", onMarqueePointerUp);
  document.addEventListener("pointercancel", onMarqueePointerUp);
}

function onMarqueePointerMove(event) {
  if (!marqueeDrag) return;
  const dx = event.clientX - marqueeDrag.startX;
  if (!marqueeDrag.moved && Math.abs(dx) < MARQUEE_THRESHOLD) return;
  marqueeDrag.moved = true;

  // Refresh the lane rect each frame in case the layout shifted.
  const rect = marqueeDrag.lane.getBoundingClientRect();
  const x1 = Math.min(event.clientX, marqueeDrag.startX);
  const x2 = Math.max(event.clientX, marqueeDrag.startX);

  if (!marqueeDrag.el) {
    const el = document.createElement("div");
    el.className = "marquee-rect";
    marqueeDrag.lane.appendChild(el);
    marqueeDrag.el = el;
  }
  marqueeDrag.el.style.left = `${x1 - rect.left}px`;
  marqueeDrag.el.style.width = `${x2 - x1}px`;

  const next = new Set(marqueeDrag.initial);
  for (const k of marqueeDrag.lane.querySelectorAll(".animation-keyframe, .animation-graph-keyframe")) {
    const kr = k.getBoundingClientRect();
    const cx = kr.left + kr.width / 2;
    if (cx >= x1 && cx <= x2) {
      next.add(selectionKey(k.dataset.timelineTrackId, k.dataset.timelineKeyframeId));
    }
  }
  applySelectionSet(next);
}

function onMarqueePointerUp() {
  if (!marqueeDrag) return;
  const moved = marqueeDrag.moved;
  if (marqueeDrag.el) marqueeDrag.el.remove();
  marqueeDrag = null;
  document.removeEventListener("pointermove", onMarqueePointerMove);
  document.removeEventListener("pointerup", onMarqueePointerUp);
  document.removeEventListener("pointercancel", onMarqueePointerUp);

  if (moved) {
    setMarqueeJustEnded(true);
    setTimeout(() => {
      setMarqueeJustEnded(false);
    }, 0);
    renderAnimationTimelineCallback();
  }
}

function applySelectionSet(next) {
  replaceSelectedKeyframes(next);
  const selectedKeyframes = getSelectedKeyframes();
  for (const k of document.querySelectorAll(".animation-keyframe, .animation-graph-keyframe")) {
    const key = selectionKey(k.dataset.timelineTrackId, k.dataset.timelineKeyframeId);
    k.classList.toggle("is-selected", selectedKeyframes.has(key));
  }
}
