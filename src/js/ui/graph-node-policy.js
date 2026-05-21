export function canBypassGraphNode(node) {
  return Boolean(node && node.type !== "source" && node.type !== "viewer-output" && node.type !== "group");
}
