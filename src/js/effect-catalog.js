export const SHADER_LAB_EFFECT_TARGETS = Object.freeze([
  target("shader-lab", "crt", "CRT", "effect", 1),
  target("shader-lab", "halftone", "Halftone", "effect", 1),
  target("shader-lab", "ascii", "ASCII", "effect", 1),
  target("shader-lab", "chromatic-aberration", "Chromatic Aberration", "effect", 1),
  target("shader-lab", "bloom", "Bloom", "effect", 1),
  target("shader-lab", "dithering", "Dithering", "effect", 1),
  target("shader-lab", "pixelation", "Pixelation", "effect", 2),
  target("shader-lab", "posterize", "Posterize", "effect", 2),
  target("shader-lab", "threshold", "Threshold", "effect", 2),
  target("shader-lab", "displacement-map", "Displacement Map", "effect", 2),
  target("shader-lab", "fluted-glass", "Fluted Glass", "effect", 2),
  target("shader-lab", "pixel-sorting", "Pixel Sorting", "effect", 3),
  target("shader-lab", "particle-grid", "Particle Grid", "effect", 3),
  target("shader-lab", "fluid", "Fluid", "source", 3),
]);

export const EFFECT_APP_EFFECT_TARGETS = Object.freeze([
  target("effect-app", "vhs", "VHS", "effects", 1),
  target("effect-app", "ntsc", "NTSC", "effects", 1),
  target("effect-app", "crt-screen", "CRT Screen", "effects", 1),
  target("effect-app", "star-glow", "Star Glow", "effects", 1),
  target("effect-app", "led-screen", "LED Screen", "effects", 1),
  target("effect-app", "rgb-shift", "RGB Shift", "effects", 1),
  target("effect-app", "modulation", "Modulation", "effects", 2),
  target("effect-app", "threshold", "Threshold", "effects", 2),
  target("effect-app", "vignette", "Vignette", "effects", 2),
  target("effect-app", "stripe", "Stripe", "effects", 2),
  target("effect-app", "reeded-glass", "Reeded Glass", "distort", 1),
  target("effect-app", "elastic-grid", "Elastic Grid", "distort", 1),
  target("effect-app", "ripple", "Ripple", "distort", 1),
  target("effect-app", "swirl", "Swirl", "distort", 1),
  target("effect-app", "pinch", "Pinch", "distort", 1),
  target("effect-app", "glitch", "Glitch", "distort", 1),
  target("effect-app", "perspective", "Perspective", "distort", 2),
  target("effect-app", "cubify", "Cubify", "distort", 2),
  target("effect-app", "polar-to-rectangular", "Polar to Rectangular", "distort", 2),
  target("effect-app", "rectangular-to-polar", "Rectangular to Polar", "distort", 2),
]);

export const REQUIRED_EFFECT_APP_CATEGORIES = Object.freeze(["effects", "distort"]);

export function listEffectTargets() {
  return [...SHADER_LAB_EFFECT_TARGETS, ...EFFECT_APP_EFFECT_TARGETS].sort(
    (a, b) => a.priority - b.priority || a.label.localeCompare(b.label)
  );
}

export function listEffectTargetsBySource(source) {
  return listEffectTargets().filter((effect) => effect.source === source);
}

export function listRequiredEffectAppTargets() {
  return EFFECT_APP_EFFECT_TARGETS.filter((effect) =>
    REQUIRED_EFFECT_APP_CATEGORIES.includes(effect.category)
  );
}

function target(source, id, label, category, priority) {
  return Object.freeze({ source, id, label, category, priority });
}
