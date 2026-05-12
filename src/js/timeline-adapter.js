// Translates between Shader Lab's published timeline JSON and our internal
// timeline shape. We keep the import surface tiny on purpose: Shader Lab uses
// `layerId` while our graph uses `nodeId`, and its keyframes are addressed by
// `at` rather than `time`. normalizeTimeline already tolerates most of that
// drift, but layer<->node mapping is a Dither Lab concern that the timeline
// core has no business knowing about — that lives here.

import {
  TIMELINE_BINDING_NODE_PARAM,
  TIMELINE_BINDING_NODE_PROPERTY,
  TIMELINE_VERSION,
  normalizeTimeline,
} from "./timeline.js";

const SHADER_LAB_EASING_MAP = Object.freeze({
  linear: "linear",
  ease: "easeInOut",
  easein: "easeIn",
  easeout: "easeOut",
  easeinout: "easeInOut",
  smooth: "smooth",
  smoothstep: "smooth",
  step: "step",
  hold: "step",
});

/**
 * Convert a Shader Lab timeline payload into our internal timeline shape.
 *
 * @param {object} raw - Shader Lab JSON ({ duration, loop, tracks: [...] })
 * @param {object} [options]
 * @param {Record<string, string>} [options.layerToNode] - layerId → nodeId map
 * @param {(layerId: string) => string} [options.resolveNodeId] - fallback resolver when no mapping is provided
 * @param {number} [options.fps=30]
 * @returns {object} normalized internal timeline
 */
export function shaderLabToTimeline(raw, options = {}) {
  if (!raw || typeof raw !== "object") {
    return normalizeTimeline({ version: TIMELINE_VERSION, duration: 0, fps: options.fps ?? 30, loop: true, tracks: [] });
  }

  const layerToNode = options.layerToNode ?? {};
  const resolve = typeof options.resolveNodeId === "function" ? options.resolveNodeId : null;
  const fps = Number.isFinite(Number(raw.fps)) ? Number(raw.fps) : options.fps ?? 30;

  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
    .map((track) => translateTrack(track, layerToNode, resolve))
    .filter(Boolean);

  return normalizeTimeline({
    version: TIMELINE_VERSION,
    duration: Number(raw.duration) || 0,
    fps,
    loop: raw.loop !== false,
    tracks,
  });
}

/**
 * Project an internal timeline back into Shader Lab's JSON shape. Useful for
 * round-tripping presets out to the Shader Lab format.
 *
 * @param {object} timeline - our internal timeline
 * @param {object} [options]
 * @param {Record<string, string>} [options.nodeToLayer] - nodeId → layerId map (defaults to identity)
 */
export function timelineToShaderLab(timeline, options = {}) {
  const normalized = normalizeTimeline(timeline);
  const nodeToLayer = options.nodeToLayer ?? {};

  return {
    duration: normalized.duration,
    fps: normalized.fps,
    loop: normalized.loop !== false,
    tracks: normalized.tracks.map((track) => ({
      layerId: nodeToLayer[track.nodeId] ?? track.nodeId,
      enabled: track.enabled,
      collapsed: track.collapsed === true ? true : undefined,
      binding: serializeShaderLabBinding(track.binding),
      interpolation: track.interpolation,
      keyframes: track.keyframes.map((keyframe) => ({
        at: keyframe.time,
        value: keyframe.value,
        easing: keyframe.easing,
      })),
    })),
  };
}

function translateTrack(rawTrack, layerToNode, resolve) {
  if (!rawTrack || typeof rawTrack !== "object") return null;

  const layerId = String(rawTrack.layerId ?? rawTrack.nodeId ?? rawTrack.targetId ?? "").trim();
  if (!layerId) return null;

  const nodeId = layerToNode[layerId] ?? (resolve ? resolve(layerId) : layerId);
  if (!nodeId) return null;

  return {
    id: rawTrack.id,
    enabled: rawTrack.enabled !== false,
    collapsed: rawTrack.collapsed === true,
    nodeId,
    // normalizeBinding inside timeline.js handles strings, {key, type, ...} and
    // {param, property} variants. We just map Shader Lab's type tokens to ours.
    binding: translateBinding(rawTrack.binding ?? rawTrack.target ?? rawTrack.property ?? rawTrack.param),
    interpolation: translateEasing(rawTrack.interpolation ?? rawTrack.easing ?? "linear"),
    keyframes: (Array.isArray(rawTrack.keyframes) ? rawTrack.keyframes : []).map(translateKeyframe),
  };
}

function translateBinding(raw) {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return null;

  const type = String(raw.type ?? raw.kind ?? "").toLowerCase();
  const target = type.includes("property") || type === "prop"
    ? TIMELINE_BINDING_NODE_PROPERTY
    : TIMELINE_BINDING_NODE_PARAM;

  return {
    type: target,
    key: raw.key ?? raw.path ?? raw.name ?? raw.param ?? raw.property ?? "",
  };
}

function translateKeyframe(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    id: raw.id,
    time: Number.isFinite(Number(raw.time)) ? Number(raw.time) : Number(raw.at) || 0,
    value: raw.value,
    easing: translateEasing(raw.easing ?? raw.interpolation ?? "linear"),
  };
}

function translateEasing(raw) {
  if (raw && typeof raw === "object") return raw;
  if (!raw) return "linear";
  const value = String(raw).toLowerCase().replace(/[-_\s]/g, "");
  return SHADER_LAB_EASING_MAP[value] ?? "linear";
}

function serializeShaderLabBinding(binding) {
  if (!binding) return null;
  return {
    type: binding.type === TIMELINE_BINDING_NODE_PROPERTY ? "property" : "param",
    key: binding.key,
  };
}
