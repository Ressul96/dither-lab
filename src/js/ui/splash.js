import { showErrorToast } from "./toast.js";

const splashEls = {
  root: null,
  list: null,
  count: null,
};

let deps = {
  getRecentProjects: () => [],
  newProject: () => null,
  openProject: () => null,
  openRecentProject: () => null,
};

export function initSplash(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
  splashEls.root = document.getElementById("splashScreen");
  if (!splashEls.root) return;
  splashEls.list = splashEls.root.querySelector("[data-splash-recent-list]");
  splashEls.count = splashEls.root.querySelector("[data-splash-recent-count]");

  splashEls.root.addEventListener("click", onSplashClick);
  renderRecentProjects();
}

function onSplashClick(event) {
  const action = event.target.closest("[data-splash-action]");
  if (action) {
    event.preventDefault();
    handleSplashAction(action.dataset.splashAction);
    return;
  }

  const recent = event.target.closest("[data-splash-recent-path]");
  if (!recent) return;
  event.preventDefault();
  openRecent(recent.dataset.splashRecentPath);
}

async function handleSplashAction(action) {
  try {
    if (action === "new") {
      deps.newProject();
      hideSplash();
      return;
    }
    if (action === "open") {
      const project = await deps.openProject();
      renderRecentProjects();
      if (project) hideSplash();
    }
  } catch (error) {
    console.error("[splash] action failed", error);
    showErrorToast(error?.message || "Could not open the project.");
  }
}

async function openRecent(path) {
  try {
    const project = await deps.openRecentProject(path);
    renderRecentProjects();
    if (project) hideSplash();
  } catch (error) {
    console.error("[splash] failed to open recent project", error);
    showErrorToast(error?.message || "Could not open the recent project.");
  }
}

function renderRecentProjects() {
  if (!splashEls.list) return;
  const projects = deps.getRecentProjects();
  splashEls.list.replaceChildren(
    ...(projects.length ? projects.map(renderRecentProject) : [renderEmptyRecent()])
  );
  if (splashEls.count) splashEls.count.textContent = String(projects.length);
}

function renderRecentProject(project) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "splash-recent-item";
  button.dataset.splashRecentPath = project.path;

  const name = document.createElement("span");
  name.className = "splash-recent-name";
  name.textContent = project.name;
  const path = document.createElement("span");
  path.className = "splash-recent-path";
  path.textContent = project.path;

  button.append(name, path);
  item.append(button);
  return item;
}

function renderEmptyRecent() {
  const item = document.createElement("li");
  item.className = "splash-recent-empty";
  item.textContent = "No recent projects yet";
  return item;
}

function hideSplash() {
  splashEls.root?.setAttribute("hidden", "");
}
