const ALGORITHMS = new Map();
const warnedMissingAlgorithms = new Set();
const FAMILY_ORDER = ["error-diffusion", "ordered", "threshold-noise", "pattern"];
const FAMILY_LABELS = {
  "error-diffusion": "Error Diffusion",
  // The Ordered family covers Bayer + Halftone + Clustered Dot + Dispersed
  // Dot. The earlier "Ordered / Bayer" label undersold the non-Bayer
  // members; "Ordered" is the standard catch-all. (dither_entegrasyon §4.P1)
  ordered: "Ordered",
  "threshold-noise": "Threshold / Noise",
  pattern: "Pattern",
};

export function registerAlgorithm(algo) {
  if (!algo?.id || typeof algo.run !== "function") return;
  if (ALGORITHMS.has(algo.id)) {
    console.warn(`[dither] duplicate algorithm id registered: ${algo.id}`);
  }
  ALGORITHMS.set(algo.id, algo);
}

export function getAlgorithm(id) {
  return ALGORITHMS.get(id) ?? null;
}

export function listAlgorithms() {
  return [...ALGORITHMS.values()];
}

export function runAlgorithm(id, imageData, params, palette) {
  const algo = ALGORITHMS.get(id);
  if (!algo) {
    const key = String(id ?? "");
    if (!warnedMissingAlgorithms.has(key)) {
      warnedMissingAlgorithms.add(key);
      console.warn(`[dither] unknown algorithm id: ${key || "(empty)"}`);
    }
    return imageData;
  }
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
