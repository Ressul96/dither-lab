const ALGORITHMS = new Map();
const FAMILY_ORDER = ["error-diffusion", "ordered", "threshold-noise", "pattern"];
const FAMILY_LABELS = {
  "error-diffusion": "Error Diffusion",
  ordered: "Ordered / Bayer",
  "threshold-noise": "Threshold / Noise",
  pattern: "Pattern",
};

export function registerAlgorithm(algo) {
  if (!algo?.id || typeof algo.run !== "function") return;
  ALGORITHMS.set(algo.id, algo);
}

export function getAlgorithm(id) {
  return ALGORITHMS.get(id) ?? null;
}

export function listAlgorithms() {
  return [...ALGORITHMS.values()];
}

export function runAlgorithm(id, imageData, params, palette) {
  const algo = ALGORITHMS.get(id) ?? ALGORITHMS.get("floyd-steinberg");
  if (!algo) return imageData;
  algo.run(imageData, params, palette);
  return imageData;
}

export function getAlgorithmOptions() {
  const byFamily = new Map();
  for (const algo of ALGORITHMS.values()) {
    const family = algo.family ?? "other";
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push([algo.id, algo.name]);
  }
  const ordered = [];
  for (const family of FAMILY_ORDER) {
    if (!byFamily.has(family)) continue;
    ordered.push({ label: FAMILY_LABELS[family] ?? family, options: byFamily.get(family) });
  }
  for (const [family, options] of byFamily.entries()) {
    if (FAMILY_ORDER.includes(family)) continue;
    ordered.push({ label: FAMILY_LABELS[family] ?? family, options });
  }
  return ordered;
}
