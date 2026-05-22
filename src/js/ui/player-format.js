export function formatSeconds(t) {
  if (!Number.isFinite(t)) return "0.00s";
  return t.toFixed(2) + "s";
}

export function formatNumericInputValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatBezierControlValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function clampBezierControlValue(value, min, max) {
  return Number(Math.max(min, Math.min(max, value)).toFixed(3));
}

export function formatKeyframeValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatPropertyValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return Number.isInteger(value)
      ? String(value)
      : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return `[${value.map(formatPropertyValue).join(", ")}]`;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function formatRulerSecond(seconds) {
  const numeric = Math.max(0, Number(seconds) || 0);
  if (numeric >= 60) {
    const minutes = Math.floor(numeric / 60);
    const secs = Math.round(numeric % 60);
    return secs === 0 ? `${minutes}m` : `${minutes}m ${secs}s`;
  }
  if (Math.abs(numeric - Math.round(numeric)) < 0.001) return `${Math.round(numeric)}s`;
  return `${numeric.toFixed(1)}s`;
}

export function getMajorTickStep(duration) {
  const seconds = Math.max(0, Number(duration) || 0);
  if (seconds <= 6) return 1;
  if (seconds <= 12) return 2;
  if (seconds <= 30) return 5;
  if (seconds <= 60) return 10;
  if (seconds <= 120) return 15;
  if (seconds <= 300) return 30;
  if (seconds <= 900) return 60;
  if (seconds <= 1800) return 120;
  return 300;
}

export function getMinorTickStep(majorStep) {
  if (majorStep <= 2) return majorStep / 4;
  if (majorStep <= 10) return majorStep / 5;
  return majorStep / 3;
}
