import { DEFAULT_GRAPH_VIEW, dispatch, getState, subscribeHistory } from "./state.js";
import {
  createBootGraph,
  flushEditableClipGraph,
  getGlobalGraph,
  getViewerOutputFps,
  replaceGraph,
  resetClipGraphScope,
  resolveGraphParentId,
  serializeGraph,
} from "./graph.js";
import { clearSource, openSourcePath, pausePlayback, seek, setFps } from "./source.js";
import { applyCustomPalettes, serializeCustomPalettes } from "./palettes.js";
import { applyTokens, serializeTokens } from "./tokens.js";
import { applyClipGraphs, serializeClipGraphs } from "./clip-graphs.js";
import { createDefaultTimeline, serializeTimeline } from "./timeline.js";
import { isEmptyComposition, normalizeComposition, serializeComposition } from "./composition.js";
import { selectedPath, tauriRemoveFile, tauriRenameFn } from "./tauri-compat.js";

let currentProjectPath = "";
const SUPPORTED_PROJECT_VERSIONS = new Set([1]);
const RECENT_PROJECTS_KEY = "dither-lab:recent-projects";
const MAX_RECENT_PROJECTS = 8;

// Unsaved-changes tracking. Any undoable edit (history push/undo/redo) marks
// the project dirty; explicit save, project load, and New Project clear it.
let dirty = false;

export function isProjectDirty() {
  return dirty;
}

export function initDirtyTracking() {
  subscribeHistory(() => {
    dirty = true;
  });
}

// "Project settled" fires after an explicit save / new / open — the points that
// legitimately invalidate a recovery draft. autosave.js subscribes to clear the
// draft. Deliberately NOT fired from applyProject, which recovery also uses.
const settledListeners = new Set();

export function subscribeProjectSettled(fn) {
  settledListeners.add(fn);
  return () => settledListeners.delete(fn);
}

function notifyProjectSettled() {
  for (const fn of [...settledListeners]) {
    try {
      fn();
    } catch (error) {
      console.error("[project] settled listener failed", error);
    }
  }
}

export function getCurrentProjectPath() {
  return currentProjectPath;
}

export function markProjectDirty() {
  dirty = true;
}

async function confirmDiscardIfDirty() {
  if (!dirty) return true;
  const ask = window.__TAURI__?.dialog?.ask;
  if (typeof ask !== "function") {
    return window.confirm("You have unsaved changes. Discard them?");
  }
  return ask("You have unsaved changes. Discard them?", {
    title: "Unsaved Changes",
    kind: "warning",
  });
}

export async function newProject() {
  if (!(await confirmDiscardIfDirty())) return;
  currentProjectPath = "";
  resetClipGraphScope();
  clearSource();
  applyCustomPalettes([]);
  applyTokens([]);
  applyClipGraphs([]);
  replaceGraph(createBootGraph());
  dispatch("view", { compare: "processed", splitPosition: 0.5 });
  dispatch("playback", {
    playing: false,
    currentTime: 0,
    trimStart: 0,
    trimEnd: 0,
    loopEnabled: true,
  });
  dispatch("timeline", createDefaultTimeline());
  dispatch("graphView", { ...DEFAULT_GRAPH_VIEW });
  dirty = false;
  notifyProjectSettled();
}

export async function saveProject() {
  if (!currentProjectPath) {
    return saveProjectAs();
  }

  return writeProjectFile(currentProjectPath);
}

export async function saveProjectAs() {
  const tauri = window.__TAURI__;
  if (!tauri?.dialog?.save) {
    console.warn("[project] save dialog is unavailable");
    return null;
  }

  const selected = await tauri.dialog.save({
    title: "Save Project",
    defaultPath: currentProjectPath || suggestedProjectPath(),
    filters: [{ name: "Dither Lab Project", extensions: ["ditherlab"] }],
  });

  const path = selectedPath(selected);
  if (!path) return null;
  currentProjectPath = path;
  return writeProjectFile(path);
}

export async function openProject() {
  if (!(await confirmDiscardIfDirty())) return null;
  const tauri = window.__TAURI__;
  if (!tauri?.dialog?.open || !tauri?.fs?.readTextFile) {
    console.warn("[project] open dialog or fs plugin is unavailable");
    return null;
  }

  const selected = await tauri.dialog.open({
    title: "Open Project",
    multiple: false,
    directory: false,
    filters: [{ name: "Dither Lab Project", extensions: ["ditherlab", "json"] }],
  });

  if (!selected) return null;

  const path = selectedPath(selected);
  if (!path) return null;
  const raw = await tauri.fs.readTextFile(path);
  let project;
  try {
    project = JSON.parse(raw);
  } catch (error) {
    console.error("[project] project file is not valid JSON", error);
    throw new Error("Project file is corrupt or not valid JSON.");
  }
  validateProject(project);
  await applyProject(project);
  currentProjectPath = path;
  rememberRecentProject(path);
  notifyProjectSettled();
  return project;
}

export async function openRecentProject(path) {
  if (!(await confirmDiscardIfDirty())) return null;
  const tauri = window.__TAURI__;
  if (!path || !tauri?.fs?.readTextFile) {
    console.warn("[project] recent project support is unavailable");
    return null;
  }

  const raw = await tauri.fs.readTextFile(path);
  let project;
  try {
    project = JSON.parse(raw);
  } catch (error) {
    console.error("[project] recent project file is not valid JSON", error);
    throw new Error("Project file is corrupt or not valid JSON.");
  }
  validateProject(project);
  await applyProject(project);
  currentProjectPath = path;
  rememberRecentProject(path);
  notifyProjectSettled();
  return project;
}

export function getRecentProjects() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((path) => typeof path === "string" && path.trim())
      .slice(0, MAX_RECENT_PROJECTS)
      .map((path) => ({
        path,
        name: path.split(/[/\\]/).pop() || path,
      }));
  } catch {
    return [];
  }
}

// Atomic text write: write to a sibling .tmp then rename over the target, with a
// remove-then-rename fallback for targets that reject rename-over-existing.
// Shared by explicit save and autosave so both are crash-safe.
async function atomicWriteText(path, text) {
  const tauri = window.__TAURI__;
  const rename = tauriRenameFn();
  if (!tauri?.fs?.writeTextFile || typeof rename !== "function") {
    throw new Error("Atomic write requires filesystem write + rename support.");
  }
  const tmpPath = `${path}.tmp`;
  await tauri.fs.writeTextFile(tmpPath, text);
  try {
    await rename(tmpPath, path);
  } catch (error) {
    // Some targets reject rename-over-existing; fall back to remove + rename.
    await tauriRemoveFile(path);
    await rename(tmpPath, path);
  }
}

async function writeProjectFile(path) {
  const tauri = window.__TAURI__;
  if (!tauri?.fs?.writeTextFile) {
    console.warn("[project] fs write support is unavailable");
    return null;
  }
  const project = buildProjectPayload();
  await atomicWriteText(path, JSON.stringify(project, null, 2));
  rememberRecentProject(path);
  dirty = false;
  notifyProjectSettled();
  return project;
}

export function buildProjectPayload() {
  const state = getState();
  // If a clip graph is open in the editor, flush its live edits to the registry
  // so the save captures them (and getGlobalGraph below serialises the GLOBAL
  // graph, not the clip-edit buffer in state.graph).
  flushEditableClipGraph();
  // Only persist clip graphs still referenced by a clip. Repeated pin/unpin
  // leaves orphaned registry entries in memory (kept so undo/redo can restore a
  // reference), but they shouldn't bloat the saved project.
  const referencedClipGraphIds = new Set(
    (state.composition?.tracks ?? [])
      .flatMap((track) => track.clips ?? [])
      .map((clip) => clip.graphId)
      .filter(Boolean)
  );
  return {
    version: 1,
    source: {
      path: state.source.path || "",
      fps: getViewerOutputFps(getGlobalGraph()) ?? state.source.fps,
      trimStart: state.playback.trimStart,
      trimEnd: state.playback.trimEnd,
      currentTime: state.playback.currentTime,
      loopEnabled: state.playback.loopEnabled !== false,
    },
    view: {
      compare: state.view.compare,
      splitPosition: state.view.splitPosition,
    },
    graphView: {
      zoom: state.graphView.zoom,
      panX: state.graphView.panX,
      panY: state.graphView.panY,
      currentParentId: resolveGraphParentId(getGlobalGraph(), state.graphView.currentParentId),
    },
    graph: serializeGraph(getGlobalGraph()),
    timeline: serializeTimeline(state.timeline),
    composition: serializeComposition(state.composition),
    customPalettes: serializeCustomPalettes(),
    tokens: serializeTokens(),
    clipGraphs: serializeClipGraphs().filter((entry) => referencedClipGraphIds.has(entry.id)),
  };
}

async function applyProject(project) {
  validateProject(project);
  // Drop any in-editor clip-edit scope before loading — the incoming project
  // replaces the graph + clip registry wholesale.
  resetClipGraphScope();
  if (project?.source?.path) {
    try {
      await openSourcePath(project.source.path, { autoplay: false });
      const currentTime = project.source.currentTime ?? project.source.trimStart ?? 0;
      dispatch("playback", {
        trimStart: project.source.trimStart ?? 0,
        trimEnd: project.source.trimEnd ?? getState().source.duration,
        currentTime,
        playing: false,
        loopEnabled: project.source.loopEnabled ?? true,
      });
      seek(currentTime);
      pausePlayback();
    } catch (error) {
      console.error("[project] failed to reopen source", error);
    }
  } else {
    clearSource();
  }

  if (project?.view) {
    dispatch("view", {
      compare: project.view.compare ?? "processed",
      splitPosition: project.view.splitPosition ?? 0.5,
    });
  }

  const requestedGraphView = {
    zoom: project?.graphView?.zoom ?? DEFAULT_GRAPH_VIEW.zoom,
    panX: project?.graphView?.panX ?? DEFAULT_GRAPH_VIEW.panX,
    panY: project?.graphView?.panY ?? DEFAULT_GRAPH_VIEW.panY,
    currentParentId: project?.graphView?.currentParentId ?? DEFAULT_GRAPH_VIEW.currentParentId,
  };
  applyCustomPalettes(project?.customPalettes ?? []);
  applyTokens(project?.tokens ?? []);
  applyClipGraphs(project?.clipGraphs ?? []);
  dispatch(
    "timeline",
    createDefaultTimeline(project?.timeline ?? {
      duration: getState().source.duration,
      fps: getState().source.fps,
    })
  );
  // Restore the saved composition AFTER openSourcePath — that call ran the
  // single-clip migration, so a richer saved composition (multi-clip, later
  // phases) must overwrite it here. An empty/absent saved composition leaves
  // the migration result in place (backward compat for pre-v3 projects).
  if (project?.composition && !isEmptyComposition(project.composition)) {
    dispatch("composition", serializeComposition(normalizeComposition(project.composition)));
  }
  const graph = replaceGraph(project?.graph);
  dispatch("graphView", {
    zoom: requestedGraphView.zoom,
    panX: requestedGraphView.panX,
    panY: requestedGraphView.panY,
    currentParentId: resolveGraphParentId(graph, requestedGraphView.currentParentId),
  });
  if (getState().source.loaded) {
    setFps(
      getViewerOutputFps(project?.graph ?? null) ??
        project?.source?.fps ??
        getState().source.fps
    );
  }
  dirty = false;
}

// Recovery entry point: apply a draft payload, then mark dirty (a recovered
// draft is not a saved project). Does not emit the settled signal, so the draft
// it just restored is left in place for a second crash.
export async function applyProjectPayload(project) {
  await applyProject(project);
  markProjectDirty();
}

function suggestedProjectPath() {
  const sourceName = getState().source.path.split(/[/\\]/).pop() || "untitled";
  return `${sourceName.replace(/\.[^.]+$/, "")}.ditherlab`;
}

function validateProject(project) {
  if (!project || typeof project !== "object") {
    throw new Error("Project file is corrupt or not a Dither Lab project.");
  }
  if (!SUPPORTED_PROJECT_VERSIONS.has(project.version)) {
    throw new Error(`Unsupported Dither Lab project version: ${project.version ?? "missing"}.`);
  }
}

function rememberRecentProject(path) {
  if (!path) return;
  const current = getRecentProjects().map((item) => item.path);
  const next = [path, ...current.filter((item) => item !== path)].slice(0, MAX_RECENT_PROJECTS);
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
  } catch {}
}
