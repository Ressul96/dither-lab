// Mix / Mask Combine / Mask Apply node inspector renderers.
// Three small, fully self-contained string builders — the only
// non-field dependencies are the MASK / MIX option catalogs
// from image-ops, which give the dropdowns their value/label
// pairs.

import {
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import { MASK_MODES, MASK_SOURCES, MIX_MODES } from "../image-ops.js";

export function renderMixNode(node) {
  const params = node.params;

  return `
    <section class="node-panel-section">
      ${renderSelectField(
        "Mode",
        "mode",
        params.mode,
        MIX_MODES.map((m) => [m.value, m.label])
      )}
      ${renderRangeField("Factor", "factor", params.factor, 0, 100, `${params.factor}%`)}
    </section>
  `;
}

export function renderMaskCombineNode(node) {
  const params = node.params;
  const operation = String(params.operation ?? "intersect");
  const invertA = String(params.invertA ?? "off");
  const invertB = String(params.invertB ?? "off");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Combine</header>
      ${renderSelectField("Operation", "operation", operation, [
        ["intersect", "Intersect (A AND B)"],
        ["union", "Union (A OR B)"],
        ["difference", "Difference (A XOR B)"],
        ["subtract", "Subtract (A minus B)"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Inputs</header>
      ${renderSelectField("Invert A", "invertA", invertA, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Invert B", "invertB", invertB, [
        ["off", "Off"],
        ["on", "On"],
      ])}
    </section>
  `;
}

export function renderMaskApplyNode(node) {
  const params = node.params;
  const invert = String(params.invert ?? "off");
  const feather = Number(params.feather ?? 0);
  const opacity = Number(params.opacity ?? 100);
  const source = String(params.source ?? "luma");
  const mode = String(params.mode ?? "multiply");
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Apply</header>
      ${renderSelectField(
        "Source",
        "source",
        source,
        MASK_SOURCES.map((s) => [s.value, s.label])
      )}
      ${renderSelectField(
        "Mode",
        "mode",
        mode,
        MASK_MODES.map((m) => [m.value, m.label])
      )}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Feather", "feather", feather, 0, 50, `${feather}px`)}
      ${renderSelectField("Invert Mask", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      <p class="hint">Source picks which mask channel reads. Stencil mode hard-clips at 50%; Multiply fades continuously.</p>
    </section>
  `;
}
