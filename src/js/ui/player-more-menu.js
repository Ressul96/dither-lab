import { getState } from "../state.js";
import {
  resetTrim,
  setIn,
  setOut,
  setPlaybackSpeed,
  snapPlayhead,
} from "../source.js";
import {
  setDurationUnit,
  timeToFrame,
  timelineFrameRate,
} from "../timeline.js";
import { escapeHtml, setInnerHtml } from "./utils.js";

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];

let commitTrimAction = null;
let resolveTimelineDuration = null;
let clamp = null;

export function initPlayerMoreMenu(deps = {}) {
  commitTrimAction = deps.commitTrimAction;
  resolveTimelineDuration = deps.resolveTimelineDuration;
  clamp = deps.clamp;
  wireMoreMenu();
}

function wireMoreMenu() {
  const moreBtn = document.querySelector('[data-action="more"]');
  if (!moreBtn) return;
  let popover = null;

  const close = () => {
    if (!popover) return;
    popover.remove();
    popover = null;
    moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
  };

  const onOutside = (event) => {
    if (!popover) return;
    if (popover.contains(event.target) || moreBtn.contains(event.target)) return;
    close();
  };

  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  moreBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (popover) {
      close();
      return;
    }
    popover = renderMorePopover();
    document.body.appendChild(popover);
    positionMorePopover(popover, moreBtn);
    moreBtn.setAttribute("aria-expanded", "true");

    popover.addEventListener("click", (e) => {
      const speedBtn = e.target.closest("[data-speed]");
      if (speedBtn) {
        e.preventDefault();
        setPlaybackSpeed(Number(speedBtn.dataset.speed));
        renderPopoverState(popover);
        return;
      }
      const unitBtn = e.target.closest("[data-unit]");
      if (unitBtn) {
        e.preventDefault();
        setDurationUnit(unitBtn.dataset.unit);
        renderPopoverState(popover);
        // duration input value re-renders via subscriber
        return;
      }
      const action = e.target.closest("[data-popover-action]");
      if (!action) return;
      e.preventDefault();
      switch (action.dataset.popoverAction) {
        case "set-range-start":
          commitTrimAction?.(setIn, "Set render range start");
          break;
        case "set-range-end":
          commitTrimAction?.(setOut, "Set render range end");
          break;
        case "reset-trim":
          commitTrimAction?.(resetTrim, "Reset trim");
          break;
        case "snap-playhead":
          snapPlayhead();
          break;
      }
      close();
    });

    setTimeout(() => {
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onKey);
    }, 0);
  });
}

function renderMorePopover() {
  const popover = document.createElement("div");
  popover.className = "player-more-popover";
  popover.setAttribute("role", "menu");
  setInnerHtml(popover, `
    <div class="popover-section">
      <div class="popover-label">Playback Speed</div>
      <div class="popover-segmented" data-popover-segmented="speed">
        ${SPEED_PRESETS.map(
          (s) => `<button data-speed="${s}">${s === 1 ? "1×" : `${s}×`}</button>`
        ).join("")}
      </div>
    </div>
    <div class="popover-section">
      <div class="popover-label">Duration Unit</div>
      <div class="popover-segmented" data-popover-segmented="unit">
        <button data-unit="frame">Frame</button>
        <button data-unit="second">Second</button>
      </div>
    </div>
    <div class="popover-section">
      <div class="popover-label">Render Range</div>
      <div class="popover-range-readout">${escapeHtml(formatRenderRangeReadout())}</div>
      <button class="popover-row" data-popover-action="set-range-start">Set start at playhead</button>
      <button class="popover-row" data-popover-action="set-range-end">Set end at playhead</button>
    </div>
    <div class="popover-section">
      <button class="popover-row" data-popover-action="reset-trim">Reset render range</button>
      <button class="popover-row" data-popover-action="snap-playhead">Snap playhead</button>
    </div>
  `);
  renderPopoverState(popover);
  return popover;
}

function renderPopoverState(popover) {
  const { playback, timeline } = getState();
  const speed = Number(playback.speed) || 1;
  const unit = timeline?.durationUnit === "second" ? "second" : "frame";
  for (const btn of popover.querySelectorAll("[data-speed]")) {
    btn.classList.toggle("is-active", Number(btn.dataset.speed) === speed);
  }
  for (const btn of popover.querySelectorAll("[data-unit]")) {
    btn.classList.toggle("is-active", btn.dataset.unit === unit);
  }
}

function positionMorePopover(popover, anchor) {
  const a = anchor.getBoundingClientRect();
  const margin = 6;
  popover.style.position = "fixed";
  popover.style.right = `${Math.max(8, window.innerWidth - a.right)}px`;
  popover.style.bottom = `${Math.max(8, window.innerHeight - a.top + margin)}px`;
}

function formatRenderRangeReadout() {
  const { playback, source, timeline } = getState();
  const fps = timelineFrameRate(timeline, source.fps);
  const duration = resolveTimelineDuration?.(timeline, source) ?? 0;
  const start = clamp?.(playback.trimStart || 0, 0, duration) ?? 0;
  const end = clamp?.(playback.trimEnd || duration, start, duration) ?? duration;
  return `F${timeToFrame(start, fps)} – F${timeToFrame(end, fps)}`;
}
