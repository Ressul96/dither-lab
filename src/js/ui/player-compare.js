import { dispatch, getState, pushHistory } from "../state.js";
import {
  cachePlayerEls,
  getPlayerEls,
} from "./player-elements.js";

const COMPARE_MODES = new Set(["processed", "split", "side-by-side"]);
const playerEls = getPlayerEls();

export function initPlayerCompare(deps = {}) {
  wireCompare();
  deps.subscribe?.("view", onPlayerViewChange);
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

export function onPlayerViewChange(view) {
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

function formatCompareMode(value) {
  return normalizeCompareMode(value)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeCompareMode(value) {
  return COMPARE_MODES.has(value) ? value : "processed";
}
