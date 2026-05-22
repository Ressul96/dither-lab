export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Replace a host element's children with the DOM tree parsed from `html`.
// Uses `Range.createContextualFragment` so the parser inherits the host's
// namespace — critical for SVG containers (edgesEl, curve handle layer)
// where `<template>.innerHTML` would parse `<path>` as HTMLUnknownElement
// and the SVG renderer would render nothing. The final swap is a single
// `replaceChildren` call — atomic vs. the old `innerHTML = html` pattern,
// and the seam where future per-element diff render can hook in.
//
// M.4 phase 1: pattern migration. Phase 2 (per-element diff render,
// preserving focus mid-drag) builds on top of this seam.
export function setInnerHtml(el, html) {
  const range = document.createRange();
  range.selectNodeContents(el);
  el.replaceChildren(range.createContextualFragment(html));
}
