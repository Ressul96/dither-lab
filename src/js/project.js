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

let currentProjectPath = "";

export async function newProject() {
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

  const path = await tauri.dialog.save({
    title: "Save Project",
    defaultPath: currentProjectPath || suggestedProjectPath(),
    filters: [{ name: "Dither Lab Project", extensions: ["ditherlab"] }],
  });

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

  const path = typeof selected === "string" ? selected : selected.path;
  const raw = await tauri.fs.readTextFile(path);
  let project;
  try {
    project = JSON.parse(raw);
  } catch (error) {
    console.error("[project] project file is not valid JSON", error);
    throw new Error("Project file is corrupt or not valid JSON.");
  }
  await applyProject(project);
  currentProjectPath = path;
  return project;
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

  await tauri.fs.writeTextFile(tmpPath, payload);

  const rename = tauri.fs.rename ?? tauri.fs.renameFile;
  if (typeof rename === "function") {
    try {
      await rename(tmpPath, path);
    } catch (error) {
      // Some targets reject rename-over-existing; fall back to remove + rename.
      if (typeof tauri.fs.remove === "function") {
        try {
          await tauri.fs.remove(path);
        } catch {}
        await rename(tmpPath, path);
      } else {
        throw error;
      }
    }
  } else {
    // No rename available; do the safest single write we can.
    console.warn("[project] fs.rename unavailable; falling back to direct write");
    await tauri.fs.writeTextFile(path, payload);
    if (typeof tauri.fs.remove === "function") {
      try {
        await tauri.fs.remove(tmpPath);
      } catch {}
    }
  }

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
  dispatch("graphView", requestedGraphView);

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
