// Inspector form field builders, extracted from graph-shell.js.
// These are the small HTML-string helpers every node-specific
// inspector renderer composes from: number input, select dropdown,
// grouped select, checkbox, plus the side-channel decorations
// (param socket toggle, keyframe toggle button).
//
// `syncTimelineButtons` walks the live inspector DOM to refresh the
// animated/keyed CSS state on the keyframe toggle buttons after a
// timeline tick — it needs the inspector root, which graph-shell
// injects via `initInspectorFields` at boot time.
//
// renderColorField / renderGradientStopColorField / renderGradientRampField
// stay in graph-shell for now because they're tangled with the color
// picker popover and the gradient ramp UI; those move when those
// subsystems get their own modules.

import { escapeHtml } from "./utils.js";
import { getSelectedNode } from "../graph.js";
import {
  TIMELINE_BINDING_NODE_PROPERTY,
  hasParamKeyframeAtCurrentTime,
  hasTimelineKeyframeAtCurrentTime,
  hasTimelineTrackForBinding,
  hasTimelineTrackForParam,
} from "../timeline.js";
import { canBypassGraphNode } from "./graph-node-policy.js";

let inspectorEl = null;

export function initInspectorFields(refs) {
  inspectorEl = refs.inspectorEl ?? null;
}

export function isLayerAdjustableNode(node) {
  return canBypassGraphNode(node);
}

export function renderNumberField(label, key, value, bounds = null) {
  const safeKey = escapeHtml(key);
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  const minAttr = bounds && Number.isFinite(bounds.min) ? ` min="${bounds.min}"` : "";
  const maxAttr = bounds && Number.isFinite(bounds.max) ? ` max="${bounds.max}"` : "";
  return `
    <div class="field number-field">
      <label>
        <span class="field-label-row">
          ${renderParamSocketDot(safeKey, bounds?.min, bounds?.max)}
          ${renderParamKeyframeButton(key)}
          <span class="field-label-text">${escapeHtml(label)}</span>
        </span>
      </label>
      <input
        type="number"
        class="num-edit"
        value="${numericValue}"
        data-node-param="${safeKey}"
        data-input-kind="number"
        ${minAttr}${maxAttr}
      />
    </div>
  `;
}

export function renderParamKeyframeButton(paramKey) {
  const node = getSelectedNode();
  if (!node || node.type === "source" || node.type === "viewer-output") return "";
  const safeKey = escapeHtml(paramKey);
  const animated = hasTimelineTrackForParam(node.id, paramKey);
  const keyed = hasParamKeyframeAtCurrentTime(node.id, paramKey);
  return `<button
    type="button"
    class="param-keyframe-toggle${animated ? " is-animated" : ""}${keyed ? " is-keyed" : ""}"
    data-param-keyframe-toggle="${safeKey}"
    aria-label="${keyed ? "Remove keyframe" : "Set keyframe"}"
    title="${keyed ? "Remove keyframe" : "Set keyframe"}"
  ></button>`;
}

export function renderLayerPropertyKeyframeButton(paramKey) {
  const node = getSelectedNode();
  if (!isLayerAdjustableNode(node)) return "";
  const safeKey = escapeHtml(paramKey);
  const binding = {
    type: TIMELINE_BINDING_NODE_PROPERTY,
    key: paramKey,
  };
  const animated = hasTimelineTrackForBinding(node.id, binding);
  const keyed = hasTimelineKeyframeAtCurrentTime(node.id, binding);
  return `<button
    type="button"
    class="param-keyframe-toggle${animated ? " is-animated" : ""}${keyed ? " is-keyed" : ""}"
    data-node-property-keyframe-toggle="${safeKey}"
    aria-label="${keyed ? "Remove keyframe" : "Set keyframe"}"
    title="${keyed ? "Remove keyframe" : "Set keyframe"}"
  ></button>`;
}

export function syncTimelineButtons() {
  if (!inspectorEl) return;
  const node = getSelectedNode();
  if (!node) return;
  for (const button of inspectorEl.querySelectorAll("[data-param-keyframe-toggle]")) {
    const paramKey = button.dataset.paramKeyframeToggle;
    const animated = hasTimelineTrackForParam(node.id, paramKey);
    const keyed = hasParamKeyframeAtCurrentTime(node.id, paramKey);
    button.classList.toggle("is-animated", animated);
    button.classList.toggle("is-keyed", keyed);
    button.setAttribute("aria-label", keyed ? "Remove keyframe" : "Set keyframe");
    button.setAttribute("title", keyed ? "Remove keyframe" : "Set keyframe");
  }
  for (const button of inspectorEl.querySelectorAll("[data-node-property-keyframe-toggle]")) {
    const paramKey = button.dataset.nodePropertyKeyframeToggle;
    const binding = {
      type: TIMELINE_BINDING_NODE_PROPERTY,
      key: paramKey,
    };
    const animated = hasTimelineTrackForBinding(node.id, binding);
    const keyed = hasTimelineKeyframeAtCurrentTime(node.id, binding);
    button.classList.toggle("is-animated", animated);
    button.classList.toggle("is-keyed", keyed);
    button.setAttribute("aria-label", keyed ? "Remove keyframe" : "Set keyframe");
    button.setAttribute("title", keyed ? "Remove keyframe" : "Set keyframe");
  }
}

export function renderParamSocketDot(safeKey, min = null, max = null) {
  const node = getSelectedNode();
  if (!node || node.type === "source" || node.type === "viewer-output") return "";
  // If the node already has an explicit input socket with this name (e.g. math.a,
  // math.b), exposing it again as `param:a` would create a duplicate pin on the
  // canvas. The existing socket is the only way in.
  if (Array.isArray(node.inputs) && node.inputs.some((socket) => socket.name === safeKey)) {
    return `<span
      class="param-socket-toggle is-exposed is-fixed"
      aria-label="Already exposed as an input socket"
      title="Already exposed as an input socket"
    ></span>`;
  }
  const exposed = Array.isArray(node.exposedParams) && node.exposedParams.includes(safeKey);
  const minAttr = Number.isFinite(Number(min)) ? ` data-param-min="${Number(min)}"` : "";
  const maxAttr = Number.isFinite(Number(max)) ? ` data-param-max="${Number(max)}"` : "";
  return `<button
    type="button"
    class="param-socket-toggle${exposed ? " is-exposed" : ""}"
    data-param-socket-toggle="${safeKey}"
    ${minAttr}${maxAttr}
    aria-label="${exposed ? "Hide parameter socket" : "Expose parameter socket"}"
    title="${exposed ? "Remove input socket" : "Expose as input socket"}"
  ></button>`;
}

export function renderSelectField(label, key, value, options) {
  return `
    <div class="field">
      <label>${escapeHtml(label)}</label>
      <div class="dropdown">
        <select data-node-param="${escapeHtml(key)}">
          ${options
            .map(
              ([optionValue, optionLabel]) => `
                <option value="${escapeHtml(optionValue)}" ${
                  optionValue === value ? "selected" : ""
                }>${escapeHtml(optionLabel)}</option>
              `
            )
            .join("")}
        </select>
      </div>
    </div>
  `;
}

export function renderSelectFieldGrouped(label, key, value, groups) {
  return `
    <div class="field">
      <label>${escapeHtml(label)}</label>
      <div class="dropdown">
        <select data-node-param="${escapeHtml(key)}">
          ${groups
            .map(
              (group) => `
                <optgroup label="${escapeHtml(group.label)}">
                  ${group.options
                    .map(
                      ([optionValue, optionLabel]) => `
                        <option value="${escapeHtml(optionValue)}" ${
                          optionValue === value ? "selected" : ""
                        }>${escapeHtml(optionLabel)}</option>
                      `
                    )
                    .join("")}
                </optgroup>
              `
            )
            .join("")}
        </select>
      </div>
    </div>
  `;
}

export function renderCheckboxField(label, key, checked) {
  return `
    <div class="field">
      <label class="checkbox">
        <input type="checkbox" data-node-param="${escapeHtml(key)}" ${checked ? "checked" : ""} />
        ${escapeHtml(label)}
      </label>
    </div>
  `;
}
