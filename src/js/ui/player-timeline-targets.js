import { getNodeDefinition, getNodeParamBounds } from "../graph.js";
import {
  TIMELINE_BINDING_NODE_PARAM,
  TIMELINE_BINDING_NODE_PROPERTY,
  createTimelineTrackId,
  getTimelineTrackValue,
  hasTimelineKeyframeAtCurrentTime,
} from "../timeline.js";

const LAYER_TRACKS = Object.freeze([
  { key: "opacity", label: "Opacity", color: "#8DB1FF", defaultValue: 100, bounds: { min: 0, max: 100 } },
  { key: "hue", label: "Hue", color: "#A4E0A0", defaultValue: 0, bounds: { min: -180, max: 180 } },
  { key: "saturation", label: "Saturation", color: "#F7B365", defaultValue: 100, bounds: { min: 0, max: 200 } },
]);
const COLOR_PARAM_TRACK_COLOR = "#FF8CAB";
const DEFAULT_PARAM_TRACK_COLOR = "#B697FF";

export function initPlayerTimelineTargets(_deps = {}) {}

export function buildTimelineProperties(graph, timeline, playback, source) {
  const node = graph.nodes.find((item) => item.id === graph.selectedNodeId);
  if (!node || node.type === "source" || node.type === "viewer-output") return [];

  const definition = getNodeDefinition(node.type);
  const targets = [];
  const seenBindings = new Set();
  const pushTarget = (config) => {
    const binding = {
      type: config.bindingType ?? TIMELINE_BINDING_NODE_PARAM,
      key: config.key,
    };
    const bindingKey = `${binding.type}:${binding.key}`;
    if (!binding.key || seenBindings.has(bindingKey)) return;
    seenBindings.add(bindingKey);
    targets.push(createTimelinePropertyTarget({
      node,
      definition,
      binding,
      label: config.label ?? formatParamLabel(config.key),
      group: config.group ?? "Parameter",
      color: config.color ?? getTimelineBindingColor(binding, node),
      defaultValue: config.defaultValue,
      bounds: config.bounds,
      timeline,
      playback,
      source,
    }));
  };

  for (const layerTrack of LAYER_TRACKS) {
    pushTarget({
      ...layerTrack,
      bindingType: TIMELINE_BINDING_NODE_PROPERTY,
      group: "Layer",
      label: `Layer ${layerTrack.label}`,
    });
  }

  const paramKeys = [
    ...Object.keys(definition?.defaultParams ?? {}),
    ...Object.keys(node.params ?? {}),
  ];
  for (const key of [...new Set(paramKeys)]) {
    if (!isTimelineVisibleParam(node, key)) continue;
    pushTarget({
      key,
      group: "Param",
      color: getTimelineBindingColor({ type: TIMELINE_BINDING_NODE_PARAM, key }, node),
      bounds: getNodeParamBounds(node, key),
    });
  }

  return targets;
}

function createTimelinePropertyTarget(config) {
  const { node, definition, binding, timeline, playback, source } = config;
  const id = createTimelineTrackId(node.id, binding);
  const track = timeline.tracks.find((item) =>
    item.nodeId === node.id &&
    item.binding?.type === binding.type &&
    item.binding?.key === binding.key
  );
  const displayTrack = track ?? {
    id,
    enabled: true,
    nodeId: node.id,
    binding,
    interpolation: "linear",
    keyframes: [],
  };
  const baseValue = getTimelineTargetBaseValue(node, binding, config.defaultValue);
  const currentValue = track
    ? getTimelineTrackValue(timeline, track.id, playback.currentTime, baseValue, {
      duration: source.duration,
      fps: source.fps,
    })
    : baseValue;

  return {
    id,
    binding,
    bounds: config.bounds,
    color: config.color,
    currentValue,
    group: config.group,
    hasTrack: Boolean(track),
    keyed: hasTimelineKeyframeAtCurrentTime(node.id, binding),
    label: config.label,
    meta: {
      node,
      nodeLabel: node.label ?? definition?.label ?? node.id,
      paramLabel: config.label,
      label: `${node.label ?? definition?.label ?? node.id} · ${config.label}`,
      family: normalizeFamilyName(definition?.family ?? node.type),
    },
    nodeId: node.id,
    track: displayTrack,
  };
}

export function getTrackDisplayMeta(track, graph) {
  const node = graph.nodes.find((item) => item.id === track.nodeId);
  const definition = getNodeDefinition(node?.type);
  const nodeLabel = node?.label ?? definition?.label ?? track.nodeId;
  const bindingKey = track.binding?.key ?? "value";
  const paramLabel = track.binding?.type === TIMELINE_BINDING_NODE_PROPERTY
    ? `Layer ${formatParamLabel(bindingKey)}`
    : formatParamLabel(bindingKey);
  const family = normalizeFamilyName(definition?.family ?? node?.type);
  return {
    node,
    nodeLabel,
    paramLabel,
    label: `${nodeLabel} · ${paramLabel}`,
    family,
  };
}

export function getTimelineTargetBaseValue(node, binding, fallback) {
  const key = binding?.key;
  if (!key || !node) return fallback;
  if (binding?.type === TIMELINE_BINDING_NODE_PROPERTY) {
    return node[key] ?? getLayerTrackDefaultValue(key) ?? fallback;
  }
  const definition = getNodeDefinition(node.type);
  return node.params?.[key] ?? definition?.defaultParams?.[key] ?? fallback;
}

export function getTrackBaseValue(track, node) {
  const key = track.binding?.key;
  if (!key || !node) return undefined;
  if (track.binding?.type === TIMELINE_BINDING_NODE_PROPERTY) return getTimelineTargetBaseValue(node, track.binding);
  if (track.binding?.type === TIMELINE_BINDING_NODE_PARAM) return getTimelineTargetBaseValue(node, track.binding);
  return node.params?.[key] ?? node[key];
}

function isTimelineVisibleParam(node, key) {
  const value = getTimelineTargetBaseValue(node, {
    type: TIMELINE_BINDING_NODE_PARAM,
    key,
  });
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isColorParamValue(value);
  return false;
}

export function getTimelineBindingColor(binding, node = null) {
  const key = binding?.key;
  const layerTrack = LAYER_TRACKS.find((item) => item.key === key);
  if (binding?.type === TIMELINE_BINDING_NODE_PROPERTY && layerTrack) return layerTrack.color;
  if (binding?.type === TIMELINE_BINDING_NODE_PARAM) {
    const value = node ? getTimelineTargetBaseValue(node, binding) : undefined;
    if (isColorParamValue(value) || /color/i.test(key ?? "")) return COLOR_PARAM_TRACK_COLOR;
    if (layerTrack) return layerTrack.color;
  }
  return DEFAULT_PARAM_TRACK_COLOR;
}

function getLayerTrackDefaultValue(key) {
  return LAYER_TRACKS.find((item) => item.key === key)?.defaultValue;
}

function isColorParamValue(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

export function safeCssColor(value, fallback = DEFAULT_PARAM_TRACK_COLOR) {
  const text = String(value ?? "").trim();
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${[...text.slice(1)].map((char) => char + char).join("")}`.toUpperCase();
  }
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) return text.toUpperCase();
  return fallback;
}

function normalizeFamilyName(value) {
  const normalized = String(value ?? "utility").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return normalized || "utility";
}

function formatParamLabel(key) {
  return String(key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
