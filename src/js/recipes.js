// Recipes: save / load a selection of effect nodes as a portable
// `.recipe.json` file. The pure graph operations (serialize a sub-slice,
// re-id + splice on import) live in graph.js; this module is the file-I/O
// layer, mirroring project.js — Tauri dialog + fs when available, with a
// browser download / file-input fallback so it also works in a plain browser.

import { getSelectedNodeIds, importRecipe, isRecipe, serializeRecipe } from "./graph.js";
import { selectedPath } from "./tauri-compat.js";

const RECIPE_FILE = "untitled.recipe.json";

// Serialize the current node selection to a recipe file. Returns false when the
// selection has nothing recipable or the user cancels the dialog.
export async function exportSelectedRecipe() {
  const recipe = serializeRecipe(getSelectedNodeIds());
  if (!recipe) return false;
  const json = JSON.stringify(recipe, null, 2);

  const tauri = window.__TAURI__;
  if (tauri?.dialog?.save && tauri?.fs?.writeTextFile) {
    const selected = await tauri.dialog.save({
      defaultPath: RECIPE_FILE,
      filters: [{ name: "Recipe", extensions: ["json"] }],
    });
    const path = selectedPath(selected);
    if (!path) return false;
    await tauri.fs.writeTextFile(path, json);
    return true;
  }

  downloadTextFile(json, RECIPE_FILE);
  return true;
}

// Read a recipe file and splice it into the current graph at `options.position`
// (world coords) under `options.parentId`. Returns the new node ids (or []).
export async function importRecipeFromFile(options = {}) {
  const tauri = window.__TAURI__;
  let json = null;
  if (tauri?.dialog?.open && tauri?.fs?.readTextFile) {
    const selected = await tauri.dialog.open({
      multiple: false,
      filters: [{ name: "Recipe", extensions: ["json"] }],
    });
    const path = selectedPath(selected);
    if (!path) return [];
    json = await tauri.fs.readTextFile(path);
  } else {
    json = await pickTextFileViaInput(".json,application/json");
  }
  if (json == null) return [];

  let recipe;
  try {
    recipe = JSON.parse(json);
  } catch {
    console.warn("[recipes] file is not valid JSON");
    return [];
  }
  if (!isRecipe(recipe)) {
    console.warn("[recipes] file is not a recipe");
    return [];
  }
  return importRecipe(recipe, options);
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickTextFileViaInput(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      },
      { once: true }
    );
    document.body.appendChild(input);
    input.click();
  });
}
