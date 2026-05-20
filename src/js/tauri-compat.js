export function selectedPath(selected) {
  if (typeof selected === "string") return selected;
  if (Array.isArray(selected)) return selectedPath(selected[0]);
  if (selected && typeof selected.path === "string") return selected.path;
  return "";
}

export function tauriErrorKind(error) {
  return error && typeof error === "object" && typeof error.kind === "string"
    ? error.kind
    : "";
}

export function tauriErrorMessage(error, fallback = "Operation failed.") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  if (typeof error.error === "string" && error.error) return error.error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return String(error);
  }
}
