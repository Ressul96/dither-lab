// Media-clip lane renderer for the "Clips" timeline view (V3, Ship 1).
//
// Read-only for now: it paints one row per Media Track and one rectangle per
// clip, positioned on the SAME time axis the parameter-keyframe lanes and the
// ruler/playhead already use (timeToTimelinePercent from player.js). No edit
// interactions yet — add/move/trim/split land in a later ship. The markup
// mirrors renderAnimationLane (player-timeline-items.js) so the existing CSS
// and the setInnerHtml render seam apply unchanged.

import { escapeHtml } from "./utils.js";

// `timeToPercent` is injected from player.js (its timeToTimelinePercent) so the
// clip rectangles share the exact ruler mapping — no second source of truth.
let timeToPercent = (time, duration, fps) => {
  if (!(duration > 0)) return 0;
  return Math.max(0, Math.min(100, (time / duration) * 100));
};

export function initPlayerMediaClips(deps = {}) {
  if (typeof deps.timeToTimelinePercent === "function") {
    timeToPercent = deps.timeToTimelinePercent;
  }
}

// Render every media track as a lane of clip rectangles. `composition` is the
// state.composition slice; `duration`/`fps` come from the shared timeline so
// the axis matches the ruler exactly.
export function renderMediaClipLanes(composition, duration, fps, selectedClipId = null) {
  const tracks = composition?.tracks ?? [];
  if (tracks.length === 0) return "";

  // Top-most track on top visually — composition stores bottom-first, so the
  // UI reverses to match the resolver's "later track paints over earlier" rule.
  return [...tracks]
    .reverse()
    .map((track) => renderTrackRow(track, composition, duration, fps, selectedClipId))
    .join("");
}

function renderTrackRow(track, composition, duration, fps, selectedClipId) {
  const clips = (track.clips ?? [])
    .map((clip) => renderClip(clip, track.id, composition, duration, fps, selectedClipId))
    .join("");
  const kindClass = track.kind === "audio" ? "media-track-row--audio" : "media-track-row--video";
  const disabled = track.enabled === false ? " is-disabled" : "";
  return `
    <div class="media-track-row ${kindClass}${disabled}" data-media-track-id="${escapeHtml(track.id)}">
      <div class="media-track-label">
        <span class="media-track-name">${escapeHtml(track.name ?? track.id)}</span>
      </div>
      <div class="media-track-lane" data-media-lane="${escapeHtml(track.id)}">
        ${clips}
      </div>
    </div>
  `;
}

function renderClip(clip, trackId, composition, duration, fps, selectedClipId) {
  const left = timeToPercent(clip.start, duration, fps);
  const right = timeToPercent(clip.start + clip.duration, duration, fps);
  const width = Math.max(0, right - left);
  const disabled = clip.enabled === false ? " is-disabled" : "";
  const selected = clip.id === selectedClipId ? " is-selected" : "";
  const source = composition?.sources?.find((s) => s.id === clip.sourceId);
  const label = clipLabel(source, clip);
  // Trim handles sit on each edge; the drag layer hit-tests data-media-clip-handle
  // before the clip body so grabbing an edge trims instead of moving.
  return `
    <div
      class="media-clip${disabled}${selected}"
      data-media-clip-id="${escapeHtml(clip.id)}"
      data-media-clip-track="${escapeHtml(trackId ?? "")}"
      data-media-clip-source="${escapeHtml(clip.sourceId)}"
      style="left:${left}%;width:${width}%"
      title="${escapeHtml(label)}"
    >
      <span class="media-clip-handle media-clip-handle--start" data-media-clip-handle="start" aria-hidden="true"></span>
      <span class="media-clip-label">${escapeHtml(label)}</span>
      <span class="media-clip-handle media-clip-handle--end" data-media-clip-handle="end" aria-hidden="true"></span>
    </div>
  `;
}

function clipLabel(source, clip) {
  const base = source?.path ? source.path.split(/[/\\]/).pop() : clip.sourceId;
  return base || clip.id;
}
