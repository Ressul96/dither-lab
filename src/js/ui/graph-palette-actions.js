// Palette action handlers — the click/input/change branches the
// Dither node's palette manager (graph-inspector-dither.js)
// dispatches into when the user creates/duplicates/deletes a
// palette, edits swatches, toggles locks, or extracts a new
// palette from the current source frame.
//
// Owns the `paletteExtractionSize` state. The dither inspector
// reads it through `getPaletteExtractionSize` so the extract
// <select> paints the right option as selected on every render;
// the palette `extract-size` change handler updates it here.
//
// `onPaletteRegistryChange` is the subscribePalettes callback —
// pruning stale locks + nudging the inspector + dispatching a
// graph tick so node previews refresh.

import { dispatch, getState } from "../state.js";
import { replacePaletteUsages, updateNodeParams } from "../graph.js";
import {
  createCustomPalette,
  duplicatePalette,
  getPalette,
  isBuiltInPalette,
  listCustomPalettes,
  removePalette,
  updateCustomPalette,
} from "../palettes.js";
import {
  extractPaletteFromImageData,
  mergePaletteExtraction,
  normalizeExtractionSize,
} from "../palette-extraction.js";
import { getCurrentSourceFrameCanvas } from "../source.js";
import { hexToRgb } from "./graph-color-math.js";
import {
  clearPaletteSwatchLocks,
  getLockedSwatchIndexes,
  prunePaletteLocks,
  removeLockedSwatchIndex,
  syncPaletteLocks,
  toggleLockedSwatchIndex,
} from "./palette-swatch-locks.js";
import { renderInspector } from "./graph-inspector-core.js";

let paletteExtractionSize = 4;
let inspectorEl = null;
const callbacks = {
  setInspectorEditing: () => {},
  isInspectorEditing: () => false,
};

export function initPaletteActions(refs) {
  inspectorEl = refs.inspectorEl ?? null;
  callbacks.setInspectorEditing = refs.setInspectorEditing ?? (() => {});
  callbacks.isInspectorEditing = refs.isInspectorEditing ?? (() => false);
}

export function getPaletteExtractionSize() {
  return paletteExtractionSize;
}

export function handlePaletteClick(control) {
  const action = control.dataset.paletteAction;
  const node = getSelectedDitherNode();
  const selectedId = node?.params?.palette ?? "monochrome";

  switch (action) {
    case "new": {
      const palette = createCustomPalette("Custom Palette", [
        [0, 0, 0],
        [128, 128, 128],
        [255, 255, 255],
      ]);
      if (node) updateNodeParams(node.id, { palette: palette.id });
      renderInspector();
      break;
    }
    case "duplicate": {
      const palette = duplicatePalette(selectedId);
      if (palette && node) updateNodeParams(node.id, { palette: palette.id });
      renderInspector();
      break;
    }
    case "delete": {
      if (isBuiltInPalette(selectedId)) return;
      const fallback = pickFallbackPaletteId(selectedId);
      if (!removePalette(selectedId)) return;
      clearPaletteSwatchLocks(selectedId);
      replacePaletteUsages(selectedId, fallback);
      renderInspector();
      break;
    }
    case "add-swatch": {
      if (isBuiltInPalette(selectedId)) return;
      const palette = getPalette(selectedId);
      if (!palette) return;
      const next = [...palette.colors, [128, 128, 128]];
      updateCustomPalette(selectedId, { colors: next });
      syncPaletteLocks(selectedId, next.length);
      renderInspector();
      break;
    }
    case "remove-swatch": {
      if (isBuiltInPalette(selectedId)) return;
      const palette = getPalette(selectedId);
      if (!palette || palette.colors.length <= 1) return;
      const index = Number(control.dataset.swatchIndex);
      if (Number.isNaN(index)) return;
      const next = palette.colors.filter((_, i) => i !== index);
      updateCustomPalette(selectedId, { colors: next });
      removeLockedSwatchIndex(selectedId, index, next.length);
      renderInspector();
      break;
    }
    case "toggle-lock": {
      if (isBuiltInPalette(selectedId)) return;
      const palette = getPalette(selectedId);
      if (!palette) return;
      const index = Number(control.dataset.swatchIndex);
      if (Number.isNaN(index)) return;
      toggleLockedSwatchIndex(selectedId, index, palette.colors.length);
      renderInspector();
      break;
    }
    case "extract": {
      const imageData = readCurrentSourceFrame();
      if (!imageData) return;
      const palette = getPalette(selectedId);
      if (!palette) return;

      if (isBuiltInPalette(selectedId)) {
        const colors = extractPaletteFromImageData(imageData, { size: paletteExtractionSize });
        if (colors.length === 0) return;
        const extracted = createCustomPalette(`${palette.name} Extracted`, colors);
        clearPaletteSwatchLocks(extracted.id);
        if (node) updateNodeParams(node.id, { palette: extracted.id });
        renderInspector();
        break;
      }

      const size = paletteExtractionSize;
      const lockedIndexes = getLockedSwatchIndexes(selectedId, palette.colors.length)
        .filter((index) => index < size);
      const lockedColors = lockedIndexes.map((index) => palette.colors[index]);
      const extractedColors = extractPaletteFromImageData(imageData, {
        size: Math.max(0, size - lockedColors.length),
        avoidColors: lockedColors,
      });
      const next = mergePaletteExtraction({
        size,
        currentColors: palette.colors,
        lockedIndexes,
        extractedColors,
      });
      if (next.length === 0) return;
      updateCustomPalette(selectedId, { colors: next });
      syncPaletteLocks(selectedId, next.length);
      renderInspector();
      break;
    }
    default:
      break;
  }
}

export function handlePaletteInput(control) {
  const action = control.dataset.paletteAction;
  const node = getSelectedDitherNode();
  const selectedId = node?.params?.palette ?? "monochrome";

  if (action === "edit-swatch") {
    if (isBuiltInPalette(selectedId)) return;
    const palette = getPalette(selectedId);
    if (!palette) return;
    const index = Number(control.dataset.swatchIndex);
    if (Number.isNaN(index)) return;
    const next = palette.colors.map((c, i) => (i === index ? hexToRgb(control.value) : c));
    callbacks.setInspectorEditing(true);
    updateCustomPalette(selectedId, { colors: next });
  }
}

export function handlePaletteChange(control) {
  const action = control.dataset.paletteAction;
  const node = getSelectedDitherNode();
  const selectedId = node?.params?.palette ?? "monochrome";

  if (action === "rename") {
    if (isBuiltInPalette(selectedId)) return;
    callbacks.setInspectorEditing(false);
    updateCustomPalette(selectedId, { name: control.value });
    renderInspector();
    return;
  }

  if (action === "edit-swatch") {
    callbacks.setInspectorEditing(false);
    renderInspector();
    return;
  }

  if (action === "extract-size") {
    paletteExtractionSize = normalizeExtractionSize(control.value, paletteExtractionSize);
  }
}

export function onPaletteRegistryChange() {
  if (!inspectorEl) return;
  prunePaletteLocks();
  if (!callbacks.isInspectorEditing()) {
    renderInspector();
  }
  dispatch("graph", {});
}

export function getSelectedDitherNode() {
  const { graph } = getState();
  const node = graph.nodes.find((n) => n.id === graph.selectedNodeId);
  return node?.type === "dither" ? node : null;
}

function pickFallbackPaletteId(removingId) {
  const custom = listCustomPalettes().filter((p) => p.id !== removingId);
  if (custom.length > 0) return custom[0].id;
  return "monochrome";
}

function readCurrentSourceFrame() {
  const canvas = getCurrentSourceFrameCanvas();
  if (!canvas?.width || !canvas?.height) return null;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return null;
  try {
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch (error) {
    console.error("[palette-extract] failed to read current source frame", error);
    return null;
  }
}
