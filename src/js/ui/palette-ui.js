let nodePaletteSearchEl = null;
let nodePaletteEmptyEl = null;

export function initNodePaletteSearch() {
  nodePaletteSearchEl = document.querySelector("[data-node-palette-search]");
  nodePaletteEmptyEl = document.querySelector("[data-node-palette-empty]");
  if (!nodePaletteSearchEl) return;
  nodePaletteSearchEl.addEventListener("input", () => {
    filterNodePalette(nodePaletteSearchEl.value);
  });
  nodePaletteSearchEl.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!nodePaletteSearchEl.value) return;
    event.stopPropagation();
    nodePaletteSearchEl.value = "";
    filterNodePalette("");
  });
  filterNodePalette(nodePaletteSearchEl.value);
}

function filterNodePalette(value) {
  const query = normalizePaletteSearch(value);
  let visibleCount = 0;
  for (const group of document.querySelectorAll(".node-palette-group")) {
    const family = normalizePaletteSearch(group.dataset.nodeFamily ?? "");
    let groupVisible = false;
    for (const item of group.querySelectorAll("[data-palette-node]")) {
      const label = normalizePaletteSearch(item.textContent ?? "");
      const type = normalizePaletteSearch(item.dataset.paletteNode ?? "");
      const visible = !query || label.includes(query) || type.includes(query) || family.includes(query);
      item.classList.toggle("is-hidden", !visible);
      groupVisible = groupVisible || visible;
      if (visible) visibleCount += 1;
    }
    group.classList.toggle("is-hidden", !groupVisible);
  }
  nodePaletteEmptyEl?.classList.toggle("hidden", visibleCount > 0);
}

function normalizePaletteSearch(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
