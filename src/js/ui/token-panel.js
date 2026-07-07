// Color tokens panel: create / edit / delete named colors. Read-model from the
// tokens registry (tokens.js); edits flow straight to the registry, which
// notifies subscribers — the renderer re-runs and this panel re-renders. Mirrors
// the assets panel.

import {
  createToken,
  listTokens,
  removeToken,
  subscribeTokens,
  updateToken,
} from "../tokens.js";
import { escapeHtml } from "./utils.js";

let listEl = null;
let addBtn = null;

export function initTokenPanel() {
  const panel = document.querySelector("[data-token-panel]");
  if (!panel) return;
  listEl = panel.querySelector("[data-token-list]");
  addBtn = panel.querySelector("[data-token-add]");

  if (addBtn) {
    addBtn.addEventListener("click", () => createToken("New token", randomHex()));
  }

  if (listEl) {
    // Color drag fires `input` continuously — update live so the preview tracks.
    listEl.addEventListener("input", (event) => {
      const id = event.target.closest("[data-token-id]")?.dataset.tokenId;
      if (id && event.target.matches("[data-token-color]")) {
        updateToken(id, { value: event.target.value });
      }
    });
    // Commit the name on `change` (blur/Enter) so the list isn't re-rendered
    // mid-typing.
    listEl.addEventListener("change", (event) => {
      const id = event.target.closest("[data-token-id]")?.dataset.tokenId;
      if (id && event.target.matches("[data-token-name]")) {
        updateToken(id, { name: event.target.value });
      }
    });
    listEl.addEventListener("click", (event) => {
      const row = event.target.closest("[data-token-del]")?.closest("[data-token-id]");
      if (row) removeToken(row.dataset.tokenId);
    });
  }

  subscribeTokens(renderTokenPanel);
  renderTokenPanel();
}

function renderTokenPanel() {
  if (!listEl) return;
  // Don't blow away an input the user is mid-edit (focus loss); buttons re-render.
  const active = document.activeElement;
  if (active && active.tagName === "INPUT" && listEl.contains(active)) return;

  const tokens = listTokens();
  listEl.innerHTML = tokens.length === 0
    ? `<li class="token-empty">No tokens yet</li>`
    : tokens.map(renderTokenRow).join("");
}

function renderTokenRow(token) {
  return `
    <li class="token-row" data-token-id="${escapeHtml(token.id)}">
      <input type="color" class="token-swatch" data-token-color value="${escapeHtml(token.value)}" title="${escapeHtml(token.value)}">
      <input type="text" class="token-name" data-token-name value="${escapeHtml(token.name)}" aria-label="Token name">
      <button type="button" class="token-del" data-token-del aria-label="Delete token" title="Delete token">×</button>
    </li>
  `;
}

function randomHex() {
  const n = Math.floor(Math.random() * 0xffffff);
  return `#${n.toString(16).padStart(6, "0")}`;
}
