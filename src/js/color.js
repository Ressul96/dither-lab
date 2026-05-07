// Shared color helpers used by the inspector color field, the graph param
// migration code, and any GPU node that needs an RGB triplet from a HEX
// string. Centralised so the parsing rules stay consistent — partial input
// from a user typing into a hex field follows the same fallback as a
// shader uniform reading a saved param.

const HEX_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

export function normalizeHex(value, fallback = "#000000") {
  if (typeof value !== "string") return normalizeHex(fallback, "#000000");
  const match = HEX_RE.exec(value.trim());
  if (!match) return fallback;
  let body = match[1];
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  return `#${body.toLowerCase()}`;
}

export function rgbToHex(r, g, b) {
  const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const toHex = (v) => clamp255(v).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Returns RGB as 0-1 floats (suitable for shader uniforms). Falls back to
// `fallback` (also 0-1 floats) when the input is malformed.
export function hexToRgb01(hex, fallback = [0, 0, 0]) {
  if (typeof hex !== "string") return fallback.slice();
  const match = HEX_RE.exec(hex.trim());
  if (!match) return fallback.slice();
  let body = match[1];
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  return [
    parseInt(body.slice(0, 2), 16) / 255,
    parseInt(body.slice(2, 4), 16) / 255,
    parseInt(body.slice(4, 6), 16) / 255,
  ];
}
