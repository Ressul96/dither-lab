// Shared frozen catalogs consumed by both the image-ops pipeline and
// the inspector UI (graph-shell.js). Splitting them out of image-ops.js
// lets the UI import a tiny module instead of pulling the entire effect
// catalog when it only needs the dropdown options.

// Channels that mask-related nodes can pull from. Order matches the
// inspector dropdown.
export const MASK_SOURCES = Object.freeze([
  { value: "luma", label: "Luma" },
  { value: "alpha", label: "Alpha" },
  { value: "r", label: "Red" },
  { value: "g", label: "Green" },
  { value: "b", label: "Blue" },
]);

// Mask blend modes. `multiply` keeps the legacy luma-fade behaviour
// (continuous mask gradient); `stencil` is a hard binary cutoff at 0.5
// that makes the mask read like a clip path — useful for crisp shapes
// from procedural inputs (text, halftone) where smooth fading isn't
// desired.
export const MASK_MODES = Object.freeze([
  { value: "multiply", label: "Multiply" },
  { value: "stencil", label: "Stencil" },
]);

// Mix node blend modes. Order mirrors common compositor UI so users
// scanning the dropdown can land on the mode they expect without hunting.
export const MIX_MODES = Object.freeze([
  { value: "normal", label: "Normal" },
  { value: "darken", label: "Darken" },
  { value: "multiply", label: "Multiply" },
  { value: "color-burn", label: "Color Burn" },
  { value: "lighten", label: "Lighten" },
  { value: "screen", label: "Screen" },
  { value: "color-dodge", label: "Color Dodge" },
  { value: "add", label: "Add (lighter)" },
  { value: "overlay", label: "Overlay" },
  { value: "soft-light", label: "Soft Light" },
  { value: "hard-light", label: "Hard Light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
  { value: "hue", label: "Hue" },
  { value: "saturation", label: "Saturation" },
  { value: "color", label: "Color" },
  { value: "luminosity", label: "Luminosity" },
]);
