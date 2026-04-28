import { getState, subscribe, dispatch, pushHistory } from "../state.js";
import {
  togglePlay,
  restart,
  stepFrame,
  seek,
  snapPlayhead,
  resetTrim,
  formatTime,
} from "../source.js";

const COMPARE_MODES = new Set(["processed", "split", "side-by-side"]);

const playerEls = {
  playBtn: null,
  scrub: null,
  timeLabels: [],
  compareSeg: null,
  compareButtons: [],
  compareReadouts: [],
  trimIn: null,
  trimOut: null,
  trimLeftDim: null,
  trimRightDim: null,
  trimSelection: null,
};

export function initPlayer() {
  bindAction("restart", restart);
  bindAction("prev-frame", () => stepFrame(-1));
  bindAction("toggle-play", togglePlay, { pointerDown: true });
  bindAction("next-frame", () => stepFrame(1));
  bindAction("reset-trim", () => commitTrimAction(resetTrim, "Reset trim"));
  bindAction("snap-playhead", snapPlayhead);

  wireScrubber();
  wireCompare();
  wireTrim();

  cachePlayerEls();
  subscribe("source", onSourceChange);
  subscribe("playback", onPlaybackChange);
  subscribe("view", onViewChange);
}

function cachePlayerEls() {
  playerEls.playBtn = document.querySelector('[data-action="toggle-play"]');
  playerEls.scrub = document.querySelector(".scrubber");
  playerEls.timeLabels = Array.from(document.querySelectorAll(".player-timeline .time-label"));
  playerEls.compareSeg = document.querySelector(".compare-mode");
  playerEls.compareButtons = playerEls.compareSeg
    ? Array.from(playerEls.compareSeg.querySelectorAll("button"))
    : [];
  playerEls.compareReadouts = Array.from(document.querySelectorAll('[data-stage-readout="compare"]'));
  playerEls.trimIn = document.querySelector(".trim-handle.trim-in");
  playerEls.trimOut = document.querySelector(".trim-handle.trim-out");
  playerEls.trimLeftDim = document.querySelector(".trim-dim--left");
  playerEls.trimRightDim = document.querySelector(".trim-dim--right");
  playerEls.trimSelection = document.querySelector(".trim-selection");
}

function bindAction(action, handler, options = {}) {
  const el = document.querySelector(`[data-action="${action}"]`);
  if (!el) return;
  let lastPointerInvokeAt = -Infinity;

  const invoke = (event) => {
    if (el.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    void handler(event);
  };

  if (options.pointerDown) {
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      lastPointerInvokeAt = event.timeStamp;
      invoke(event);
    });
  }

  el.addEventListener("click", (event) => {
    if (event.detail > 0 && event.timeStamp - lastPointerInvokeAt < 500) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    invoke(event);
  });
}

function wireScrubber() {
  const scrub = document.querySelector(".scrubber");
  if (!scrub) return;
  scrub.addEventListener("input", () => {
    const { source } = getState();
    const duration = source.duration || 0;
    if (duration <= 0) return;
    seek((Number(scrub.value) / 1000) * duration);
  });
}

function wireCompare() {
  const seg = document.querySelector(".compare-mode");
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    const prev = normalizeCompareMode(getState().view.compare);
    const requested = normalizeCompareMode(btn.dataset.mode);
    const next = prev === requested ? "processed" : requested;
    if (prev === next) return;
    dispatch("view", { compare: next });
    pushHistory({
      label: "Change compare mode",
      undo: () => dispatch("view", { compare: prev }),
      redo: () => dispatch("view", { compare: next }),
    });
  });
}

function wireTrim() {
  wireTrimHandle(".trim-handle.trim-in", "trimStart");
  wireTrimHandle(".trim-handle.trim-out", "trimEnd");
}

function wireTrimHandle(selector, key) {
  const handle = document.querySelector(selector);
  if (!handle) return;
  handle.addEventListener("pointerdown", (e) => {
    const rail = handle.closest(".timeline");
    if (!rail) return;
    const { source, playback } = getState();
    const duration = source.duration || 0;
    if (duration <= 0) return;
    const rect = rail.getBoundingClientRect();
    const before = { trimStart: playback.trimStart, trimEnd: playback.trimEnd };
    handle.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      const t = ratio * duration;
      const current = getState().playback;
      if (key === "trimStart") {
        const trimStart = Math.min(t, current.trimEnd - 0.01);
        dispatch("playback", { trimStart });
        if (current.currentTime < trimStart) seek(trimStart);
      } else {
        const trimEnd = Math.max(t, current.trimStart + 0.01);
        dispatch("playback", { trimEnd });
        if (current.currentTime > trimEnd) seek(trimEnd);
      }
    };
    const up = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      const after = { ...getState().playback };
      if (before.trimStart !== after.trimStart || before.trimEnd !== after.trimEnd) {
        const a = { trimStart: after.trimStart, trimEnd: after.trimEnd };
        pushHistory({
          label: "Trim",
          undo: () => dispatch("playback", before),
          redo: () => dispatch("playback", a),
        });
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function commitTrimAction(action, label) {
  const before = pickTrimState();
  action();
  const after = pickTrimState();
  if (before.trimStart === after.trimStart && before.trimEnd === after.trimEnd) return;

  pushHistory({
    label,
    undo: () => dispatch("playback", before),
    redo: () => dispatch("playback", after),
  });
}

function pickTrimState() {
  const { trimStart, trimEnd } = getState().playback;
  return { trimStart, trimEnd };
}

// Subscribers ------------------------------------------------------

function onSourceChange(source) {
  if (!source.loaded) return;
}

function onPlaybackChange(playback) {
  const { source } = getState();
  const duration = source.duration || 0;

  if (!playerEls.playBtn || !playerEls.scrub) cachePlayerEls();

  if (playerEls.playBtn) playerEls.playBtn.textContent = playback.playing ? "⏸" : "▶";

  const scrub = playerEls.scrub;
  if (scrub && duration > 0 && document.activeElement !== scrub) {
    scrub.value = String(Math.round((playback.currentTime / duration) * 1000));
  } else if (scrub && duration <= 0 && document.activeElement !== scrub) {
    scrub.value = "0";
  }

  const labels = playerEls.timeLabels;
  if (labels.length >= 2) {
    labels[0].textContent = formatTime(playback.currentTime);
    labels[1].textContent = formatTime(duration);
  }

  updateTrimHandles(playback, duration);
}

function onViewChange(view) {
  if (!playerEls.compareSeg) cachePlayerEls();
  if (!playerEls.compareSeg) return;
  const compare = normalizeCompareMode(view.compare);
  if (compare !== view.compare) {
    dispatch("view", { compare });
    return;
  }
  for (const btn of playerEls.compareButtons) {
    const active = btn.dataset.mode === compare;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }

  for (const el of playerEls.compareReadouts) {
    el.textContent = formatCompareMode(compare);
  }
}

function updateTrimHandles(playback, duration) {
  const inH = playerEls.trimIn;
  const outH = playerEls.trimOut;
  const leftDim = playerEls.trimLeftDim;
  const rightDim = playerEls.trimRightDim;
  const selection = playerEls.trimSelection;
  if (duration <= 0) {
    if (inH) inH.style.left = "0%";
    if (outH) outH.style.left = "100%";
    if (leftDim) leftDim.style.width = "0%";
    if (rightDim) rightDim.style.left = "100%";
    if (rightDim) rightDim.style.width = "0%";
    if (selection) {
      selection.style.left = "0%";
      selection.style.width = "100%";
    }
    return;
  }

  const trimStart = clamp((playback.trimStart / duration) * 100, 0, 100);
  const trimEnd = clamp((playback.trimEnd / duration) * 100, 0, 100);

  if (inH) inH.style.left = `${trimStart}%`;
  if (outH) outH.style.left = `${trimEnd}%`;
  if (leftDim) leftDim.style.width = `${trimStart}%`;
  if (rightDim) rightDim.style.left = `${trimEnd}%`;
  if (rightDim) rightDim.style.width = `${Math.max(0, 100 - trimEnd)}%`;
  if (selection) {
    selection.style.left = `${trimStart}%`;
    selection.style.width = `${Math.max(0, trimEnd - trimStart)}%`;
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function formatCompareMode(value) {
  return normalizeCompareMode(value)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeCompareMode(value) {
  return COMPARE_MODES.has(value) ? value : "processed";
}
