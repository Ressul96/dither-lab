import { getState, subscribe, dispatch, pushHistory } from "../state.js";
import { replaceGraph, serializeGraph } from "../graph.js";
import { applyCustomPalettes, serializeCustomPalettes } from "../palettes.js";
import {
  togglePlay,
  restart,
  stepFrame,
  seek,
  snapPlayhead,
  setIn,
  setOut,
  resetTrim,
  formatTime,
} from "../source.js";

export function initPlayer() {
  bindAction("restart", restart);
  bindAction("prev-frame", () => stepFrame(-1));
  bindAction("toggle-play", togglePlay, { pointerDown: true });
  bindAction("next-frame", () => stepFrame(1));
  bindAction("set-in", () => commitTrimAction(setIn, "Set trim in"));
  bindAction("set-out", () => commitTrimAction(setOut, "Set trim out"));
  bindAction("reset-trim", () => commitTrimAction(resetTrim, "Reset trim"));
  bindAction("snap-playhead", snapPlayhead);

  wireScrubber();
  wireCompare();
  wireTrim();
  wireAB();

  subscribe("source", onSourceChange);
  subscribe("playback", onPlaybackChange);
  subscribe("view", onViewChange);
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
    const prev = getState().view.compare;
    const next = btn.dataset.mode;
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

// A/B snapshots: capture compare mode + graph state.

function wireAB() {
  bindAction("capture-a", () => capture("a"));
  bindAction("capture-b", () => capture("b"));
  bindAction("swap-ab", swap);
  const hold = document.querySelector('[data-action="ab-hold"]');
  if (hold) {
    hold.addEventListener("pointerdown", () => preview(true));
    hold.addEventListener("pointerup", () => preview(false));
    hold.addEventListener("pointerleave", () => preview(false));
  }
}

function snapshot() {
  const { view, graph } = getState();
  return {
    view: { compare: view.compare },
    graph: serializeGraph(graph),
    customPalettes: serializeCustomPalettes(),
  };
}

function apply(snap) {
  if (!snap) return;
  dispatch("view", { compare: snap.view.compare });
  applyCustomPalettes(snap.customPalettes ?? []);
  replaceGraph(snap.graph);
}

function capture(slot) {
  dispatch("ab", { [slot]: snapshot() });
  const btn = document.querySelector(`[data-action="capture-${slot}"]`);
  if (btn) btn.classList.add("captured");
}

function swap() {
  const { a, b } = getState().ab;
  dispatch("ab", { a: b, b: a });
  if (a) apply(a);
}

let heldPrev = null;
function preview(on) {
  const ab = getState().ab;
  if (on) {
    if (!ab.a) return;
    heldPrev = snapshot();
    apply(ab.a);
  } else if (heldPrev) {
    apply(heldPrev);
    heldPrev = null;
  }
}

// Subscribers ------------------------------------------------------

function onSourceChange(source) {
  if (!source.loaded) return;
}

function onPlaybackChange(playback) {
  const { source } = getState();
  const duration = source.duration || 0;

  const playBtn = document.querySelector('[data-action="toggle-play"]');
  if (playBtn) playBtn.textContent = playback.playing ? "⏸" : "▶";

  const scrub = document.querySelector(".scrubber");
  if (scrub && duration > 0 && document.activeElement !== scrub) {
    scrub.value = String(Math.round((playback.currentTime / duration) * 1000));
  } else if (scrub && duration <= 0 && document.activeElement !== scrub) {
    scrub.value = "0";
  }

  const labels = document.querySelectorAll(".player-timeline .time-label");
  if (labels.length >= 2) {
    labels[0].textContent = formatTime(playback.currentTime);
    labels[1].textContent = formatTime(duration);
  }

  updateTrimHandles(playback, duration);
}

function onViewChange(view) {
  const seg = document.querySelector(".compare-mode");
  if (!seg) return;
  for (const btn of seg.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.mode === view.compare);
  }

  for (const el of document.querySelectorAll('[data-stage-readout="compare"]')) {
    el.textContent = formatCompareMode(view.compare);
  }
}

function updateTrimHandles(playback, duration) {
  const inH = document.querySelector(".trim-handle.trim-in");
  const outH = document.querySelector(".trim-handle.trim-out");
  const leftDim = document.querySelector(".trim-dim--left");
  const rightDim = document.querySelector(".trim-dim--right");
  const selection = document.querySelector(".trim-selection");
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
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
