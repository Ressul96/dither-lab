import { DEFAULT_GRAPH_VIEW, dispatch, getState } from "./state.js";
import {
  createBootGraph,
  getViewerOutputFps,
  replaceGraph,
  resolveGraphParentId,
  serializeGraph,
} from "./graph.js";
import { clearSource, openSourcePath, pausePlayback, seek, setFps } from "./source.js";
import { applyCustomPalettes, serializeCustomPalettes } from "./palettes.js";
import { createDefaultTimeline, serializeTimeline } from "./timeline.js";
import { selectedPath, tauriRemoveFile, tauriRenameFn } from "./tauri-compat.js";

let currentProjectPath = "";
const SUPPORTED_PROJECT_VERSIONS = new Set([1]);
const RECENT_PROJECTS_KEY = "dither-lab:recent-projects";
const MAX_RECENT_PROJECTS = 8;

export function newProject() {
  currentProjectPath = "";
  clearSource();
  applyCustomPalettes([]);
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
  return project;
}

export async function openRecentProject(path) {
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

async function writeProjectFile(path) {
  const tauri = window.__TAURI__;
  if (!tauri?.fs?.writeTextFile) {
    console.warn("[project] fs write support is unavailable");
    return null;
  }

  const project = buildProjectPayload();
  const payload = JSON.stringify(project, null, 2);
  const tmpPath = `${path}.tmp`;
  const rename = tauriRenameFn();
  if (typeof rename !== "function") {
    throw new Error("Project save requires filesystem rename support for atomic writes.");
  }

  await tauri.fs.writeTextFile(tmpPath, payload);

  try {
    await rename(tmpPath, path);
  } catch (error) {
    // Some targets reject rename-over-existing; fall back to remove + rename.
    // The remove is best-effort — if the target file doesn't exist (first
    // save) or remove fails for another reason, the second rename either
    // succeeds anyway or surfaces the original error.
    await tauriRemoveFile(path);
    await rename(tmpPath, path);
  }

  rememberRecentProject(path);
  return project;
}

function buildProjectPayload() {
  const state = getState();
  return {
    version: 1,
    source: {
      path: state.source.path || "",
      fps: getViewerOutputFps(state.graph) ?? state.source.fps,
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
      currentParentId: resolveGraphParentId(state.graph, state.graphView.currentParentId),
    },
    graph: serializeGraph(state.graph),
    timeline: serializeTimeline(state.timeline),
    customPalettes: serializeCustomPalettes(),
  };
}

async function applyProject(project) {
  validateProject(project);
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
  dispatch(
    "timeline",
    createDefaultTimeline(project?.timeline ?? {
      duration: getState().source.duration,
      fps: getState().source.fps,
    })
  );
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
