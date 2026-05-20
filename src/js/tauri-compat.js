// Tauri 2.x SDK adapters. Every callsite that touches `window.__TAURI__`
// goes through here, so a future Tauri upgrade (renamed plugin commands,
// shifted API surface) becomes a single-file change instead of a hunt
// across export.js/project.js/source.js/native-render.js.

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

// Tauri 2.x moved invoke under `core`; older 2.x builds still expose it
// at the top level. Callers should treat a null return as "not running
// inside Tauri" (browser preview or test harness).
export function tauriInvoke() {
  const tauri = window.__TAURI__;
  return tauri?.core?.invoke || tauri?.invoke || null;
}

// True when the renderer is hosted inside a Tauri webview. Cheaper than
// asking for `tauriInvoke()` and discarding the function reference.
export function hasTauri() {
  return Boolean(window.__TAURI__);
}

// fs.writeFile is the modern 2.x API; older builds used writeBinaryFile.
// Returns true on success, false when neither variant exists or the call
// throws — callers fall back to a browser download in that case.
export async function tauriWriteBinary(path, bytes) {
  const tauri = window.__TAURI__;
  try {
    if (tauri?.fs?.writeFile) {
      await tauri.fs.writeFile(path, bytes);
      return true;
    }
    if (tauri?.fs?.writeBinaryFile) {
      await tauri.fs.writeBinaryFile(path, bytes);
      return true;
    }
  } catch (error) {
    console.warn("[tauri-compat] writeBinary failed", { path, error });
  }
  return false;
}

// fs.remove (2.x) ↔ fs.removeFile (legacy). Non-fatal failure: callers
// log + carry on (e.g. cleanup of partial files is best-effort).
export async function tauriRemoveFile(path) {
  const tauri = window.__TAURI__;
  try {
    if (tauri?.fs?.remove) {
      await tauri.fs.remove(path);
      return true;
    }
    if (tauri?.fs?.removeFile) {
      await tauri.fs.removeFile(path);
      return true;
    }
  } catch (error) {
    console.warn("[tauri-compat] removeFile failed", { path, error });
  }
  return false;
}

// fs.rename (2.x) ↔ fs.renameFile (legacy). Throws if neither exists so
// callers can surface a clear "atomic save unavailable" error instead of
// silently corrupting files via writeTextFile-over-existing.
export function tauriRenameFn() {
  const tauri = window.__TAURI__;
  return tauri?.fs?.rename ?? tauri?.fs?.renameFile ?? null;
}
