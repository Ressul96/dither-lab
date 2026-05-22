import { timeToFrame } from "../timeline.js";
import { escapeHtml } from "./utils.js";
import { getPlayerEls } from "./player-elements.js";
import {
  formatRulerSecond,
  formatSeconds,
  getMajorTickStep,
  getMinorTickStep,
} from "./player-format.js";

let clampValue = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
let getEffectiveTimelineZoomValue = () => 1;

const playerEls = getPlayerEls();

export function initPlayerTimelineChrome({ clamp, getEffectiveTimelineZoom } = {}) {
  if (typeof clamp === "function") clampValue = clamp;
  if (typeof getEffectiveTimelineZoom === "function") {
    getEffectiveTimelineZoomValue = getEffectiveTimelineZoom;
  }
}

export function syncTimelineRulerScroll() {
  if (!playerEls.timeRuler || !playerEls.timelineBody) return;
  playerEls.timeRuler.style.transform = `translateX(${-playerEls.timelineBody.scrollLeft}px)`;
}

export function updateTimelineChrome(timeline) {
  const effectiveZoom = getEffectiveTimelineZoomValue(timeline);
  const contentWidth = `${effectiveZoom * 100}%`;
  const timelinePane = playerEls.timelinePane ?? playerEls.playerCard;
  if (timelinePane) {
    timelinePane.style.setProperty("--timeline-content-width", contentWidth);
    timelinePane.style.setProperty("--timeline-zoom", String(effectiveZoom));
    timelinePane.classList.toggle("is-graph-mode", timeline.viewMode === "graph");
  }
  if (playerEls.playerCard) {
    const panelOpen = timeline.panelOpen !== false;
    playerEls.playerCard.classList.toggle("is-collapsed", !panelOpen);
    playerEls.playerCard.setAttribute("aria-expanded", panelOpen ? "true" : "false");
  }
  if (playerEls.panelToggles?.length) {
    const panelOpen = timeline.panelOpen !== false;
    const label = panelOpen ? "Collapse timeline" : "Expand timeline";
    for (const toggle of playerEls.panelToggles) {
      if (toggle.classList.contains("timeline-panel-toggle")) {
        toggle.textContent = panelOpen ? "▾" : "▴";
      }
      toggle.setAttribute("aria-expanded", panelOpen ? "true" : "false");
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
    }
  }
  for (const button of playerEls.viewButtons ?? []) {
    const active = button.dataset.timelineView === timeline.viewMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (playerEls.zoomReadout) {
    playerEls.zoomReadout.textContent = `${Math.round(timeline.zoom * 100)}%`;
  }
}

export function renderTimeRuler(duration, fps, unit, zoom) {
  if (!playerEls.timeRuler) return;
  if (duration <= 0) {
    playerEls.timeRuler.innerHTML = "";
    return;
  }
  const majorStep = getMajorTickStep(duration / getEffectiveTimelineZoomValue({ zoom }));
  const minorStep = getMinorTickStep(majorStep);
  const safeDuration = Math.max(1 / Math.max(1, fps), duration);
  const ticks = [];
  const maxTickCount = 260;
  const pushTick = (time, major) => {
    const clampedTime = clampValue(time, 0, safeDuration);
    const duplicate = ticks.some((tick) => Math.abs(tick.time - clampedTime) < 0.0005);
    if (duplicate) {
      const existing = ticks.find((tick) => Math.abs(tick.time - clampedTime) < 0.0005);
      if (existing) existing.major = existing.major || major;
      return;
    }
    ticks.push({ time: clampedTime, major });
  };

  for (let time = 0, index = 0; time <= safeDuration + 0.0005 && index < maxTickCount; time += minorStep, index++) {
    const major = Math.abs(time / majorStep - Math.round(time / majorStep)) < 0.0005;
    pushTick(time, major);
  }
  pushTick(safeDuration, true);
  ticks.sort((a, b) => a.time - b.time);

  let html = "";
  for (const tick of ticks) {
    const pct = (tick.time / safeDuration) * 100;
    const frame = timeToFrame(tick.time, fps);
    const label = formatRulerSecond(tick.time);
    const className = tick.major ? "time-tick time-tick--major" : "time-tick time-tick--minor";
    html += `
      <div class="${className}" style="left: ${pct}%" title="F${frame} · ${escapeHtml(formatSeconds(tick.time))}">
        ${tick.major ? `<span class="time-tick-label">${escapeHtml(label)}</span>` : ""}
      </div>
    `;
  }
  playerEls.timeRuler.innerHTML = html;
  syncTimelineRulerScroll();
}

export function renderRenderRangeOverlay(duration, playback) {
  if (!(duration > 0)) return "";
  const start = clampValue(playback.trimStart || 0, 0, duration);
  const end = clampValue(playback.trimEnd || duration, start, duration);
  const left = (start / duration) * 100;
  const width = Math.max(0, ((end - start) / duration) * 100);
  return `
    <div class="render-range-overlay" aria-hidden="true">
      <div class="render-range-muted render-range-muted--before" style="width:${left}%"></div>
      <div class="render-range-band" style="left:${left}%; width:${width}%">
        <span class="render-range-handle render-range-handle--start"></span>
        <span class="render-range-handle render-range-handle--end"></span>
      </div>
      <div class="render-range-muted render-range-muted--after" style="left:${left + width}%; width:${100 - left - width}%"></div>
    </div>
  `;
}
