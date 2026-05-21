// Per-palette swatch lock state, extracted from graph-shell.js.
// A user can "lock" individual swatches on a custom palette so a
// re-extraction from the current source frame keeps those entries
// intact and only fills the other slots. State here is the Map
// keyed by paletteId → Set<lockedSwatchIndex>; the helpers below
// are all pure ops over that one Map.
//
// `clearPaletteSwatchLocks` replaces the two `paletteSwatchLocks.delete(id)`
// callsites that previously poked at the Map directly — keeping the
// state private to this module means nothing else needs to know the
// container is a Map.

import { getPalette, isBuiltInPalette, listCustomPalettes } from "../palettes.js";

const paletteSwatchLocks = new Map();

export function getLockedSwatchIndexes(paletteId, colorCount) {
  const locked = paletteSwatchLocks.get(paletteId);
  if (!locked || locked.size === 0) return [];
  return [...locked].filter((index) => index >= 0 && index < colorCount).sort((a, b) => a - b);
}

export function isSwatchLocked(paletteId, index, colorCount) {
  return getLockedSwatchIndexes(paletteId, colorCount).includes(index);
}

export function toggleLockedSwatchIndex(paletteId, index, colorCount) {
  const next = new Set(getLockedSwatchIndexes(paletteId, colorCount));
  if (next.has(index)) next.delete(index);
  else next.add(index);
  if (next.size === 0) paletteSwatchLocks.delete(paletteId);
  else paletteSwatchLocks.set(paletteId, next);
}

export function removeLockedSwatchIndex(paletteId, removedIndex, colorCount) {
  const next = getLockedSwatchIndexes(paletteId, colorCount + 1)
    .filter((index) => index !== removedIndex)
    .map((index) => (index > removedIndex ? index - 1 : index));
  if (next.length === 0) paletteSwatchLocks.delete(paletteId);
  else paletteSwatchLocks.set(paletteId, new Set(next));
}

export function syncPaletteLocks(paletteId, colorCount) {
  const next = getLockedSwatchIndexes(paletteId, colorCount);
  if (next.length === 0) paletteSwatchLocks.delete(paletteId);
  else paletteSwatchLocks.set(paletteId, new Set(next));
}

export function clearPaletteSwatchLocks(paletteId) {
  paletteSwatchLocks.delete(paletteId);
}

export function prunePaletteLocks() {
  for (const palette of listCustomPalettes()) {
    syncPaletteLocks(palette.id, palette.colors.length);
  }
  for (const paletteId of [...paletteSwatchLocks.keys()]) {
    if (!getPalette(paletteId) || isBuiltInPalette(paletteId)) {
      paletteSwatchLocks.delete(paletteId);
    }
  }
}
