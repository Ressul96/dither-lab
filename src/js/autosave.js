// Debounced crash-recovery draft. While the project is dirty, write a recovery
// copy to <appDataDir>/recovery/autosave.ditherlab at most once per interval.
// The draft is a normal project payload plus a `recovery` block. Explicit save /
// new / open deletes it (via the project "settled" signal). Desktop-only: a
// no-op in a plain browser (no appDataDir), so nothing here runs without Tauri.

import { subscribeHistory } from "./state.js";
import {
  applyProjectPayload,
  buildProjectPayload,
  getCurrentProjectPath,
  isProjectDirty,
  subscribeProjectSettled,
} from "./project.js";
import { isExportSessionActive } from "./source.js";
import { createThrottledScheduler } from "./scheduler.js";
import { showErrorToast } from "./ui/toast.js";

const AUTOSAVE_INTERVAL_MS = 30_000;
const RECOVERY_DIR = "recovery";
const RECOVERY_FILE = "autosave.ditherlab";

let warnedThisSession = false;

function fs() {
  return window.__TAURI__?.fs ?? null;
}

async function recoveryDir() {
  const path = window.__TAURI__?.path;
  if (!path?.appDataDir || !path?.join) return null;
  return path.join(await path.appDataDir(), RECOVERY_DIR);
}

async function recoveryPath() {
  const dir = await recoveryDir();
  if (!dir) return null;
  return window.__TAURI__.path.join(dir, RECOVERY_FILE);
}

async function writeDraft() {
  if (!isProjectDirty() || isExportSessionActive()) return;
  const f = fs();
  const dir = await recoveryDir();
  const path = await recoveryPath();
  if (!f?.writeTextFile || !dir || !path) return;
  try {
    if (f.mkdir) await f.mkdir(dir, { recursive: true });
    const payload = {
      ...buildProjectPayload(),
      recovery: { savedAt: Date.now(), projectPath: getCurrentProjectPath() },
    };
    await f.writeTextFile(path, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error("[autosave] write failed", error);
    if (!warnedThisSession) {
      warnedThisSession = true;
      showErrorToast("Autosave failed — your unsaved work may not be recoverable.");
    }
  }
}

const scheduler = createThrottledScheduler(() => void writeDraft(), AUTOSAVE_INTERVAL_MS);

export function initAutosave() {
  if (!window.__TAURI__) return; // desktop-only
  subscribeHistory(() => scheduler.request());
  subscribeProjectSettled(() => {
    scheduler.cancel();
    void clearRecoveryDraft();
  });
}

export async function readRecoveryDraft() {
  const f = fs();
  const path = await recoveryPath();
  if (!f?.readTextFile || !path) return null;
  try {
    if (f.exists && !(await f.exists(path))) return null;
    const draft = JSON.parse(await f.readTextFile(path));
    return draft?.recovery ? draft : null;
  } catch (error) {
    console.error("[autosave] could not read recovery draft", error);
    return null;
  }
}

export async function applyRecoveryDraft(draft) {
  // applyProjectPayload marks the project dirty (a recovered draft is not saved).
  await applyProjectPayload(draft);
}

export async function clearRecoveryDraft() {
  const f = fs();
  const path = await recoveryPath();
  if (!f || !path) return;
  try {
    if (f.exists && !(await f.exists(path))) return;
    if (f.remove) await f.remove(path);
    else if (f.removeFile) await f.removeFile(path);
  } catch (error) {
    console.error("[autosave] could not clear recovery draft", error);
  }
}
