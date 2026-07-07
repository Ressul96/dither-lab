// Assets panel (Ship 4) — lists the media sources in the composition and lets
// the user add more. Each row is draggable onto a Clips-view track lane to drop
// a new clip (handled by player-media-clip-drag.js). "Add media" opens the file
// picker via addSourceViaPicker, which registers a new source WITHOUT replacing
// the current composition.
//
// Read-model only: the panel renders from state.composition.sources and the
// drag payload is just the sourceId; all mutation goes through the composition
// reducers so history/parity rules hold.

import { getState, subscribe } from "../state.js";
import { addSourceViaPicker } from "../source.js";
import { escapeHtml } from "./utils.js";

let listEl = null;
let addBtn = null;

export function initAssetPanel() {
  const panel = document.querySelector("[data-asset-panel]");
  if (!panel) return;
  listEl = panel.querySelector("[data-asset-list]");
  addBtn = panel.querySelector("[data-asset-add]");

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      addSourceViaPicker().catch((err) => console.error("[asset-panel] add failed", err));
    });
  }

  // Drag a source row onto a Clips-view lane to add a clip. The payload is the
  // sourceId; the drop handler (player-media-clip-drag.js) does the addClip.
  if (listEl) {
    listEl.addEventListener("dragstart", (event) => {
      const row = event.target.closest?.("[data-asset-source-id]");
      if (!row || !event.dataTransfer) return;
      event.dataTransfer.setData("application/x-dither-source-id", row.dataset.assetSourceId);
      event.dataTransfer.setData("text/plain", row.dataset.assetSourceId);
      event.dataTransfer.effectAllowed = "copy";
    });
  }

  // Re-render whenever the composition changes (source added/removed, project load).
  subscribe("composition", renderAssetPanel);
  renderAssetPanel();
}

function renderAssetPanel() {
  if (!listEl) return;
  const sources = getState().composition?.sources ?? [];
  if (sources.length === 0) {
    listEl.innerHTML = `<li class="asset-empty">No media yet</li>`;
    return;
  }
  listEl.innerHTML = sources.map(renderAssetRow).join("");
}

function renderAssetRow(source) {
  const name = source.path ? source.path.split(/[/\\]/).pop() : source.id;
  const meta = formatMeta(source);
  return `
    <li class="asset-row" draggable="true" data-asset-source-id="${escapeHtml(source.id)}" title="${escapeHtml(source.path || name)}">
      <span class="asset-name">${escapeHtml(name)}</span>
      <span class="asset-meta">${escapeHtml(meta)}</span>
    </li>
  `;
}

function formatMeta(source) {
  const parts = [];
  if (source.width && source.height) parts.push(`${source.width}×${source.height}`);
  if (source.duration > 0) parts.push(`${source.duration.toFixed(1)}s`);
  return parts.join(" · ");
}
