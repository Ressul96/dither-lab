export function selectedPath(selected) {
  if (typeof selected === "string") return selected;
  if (Array.isArray(selected)) return selectedPath(selected[0]);
  if (selected && typeof selected.path === "string") return selected.path;
  return "";
}
