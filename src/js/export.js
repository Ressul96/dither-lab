import { getState, subscribe } from "./state.js";
import {
  beginExportSession,
  endExportSession,
  getCurrentExportFrameCanvas,
  hasCurrentDitherFrame,
  seekForExport,
} from "./source.js";

const STILL_FORMATS = Object.freeze([
  { id: "png", label: "PNG", extension: "png", mime: "image/png" },
  { id: "jpeg", label: "JPEG", extension: "jpg", mime: "image/jpeg" },
]);

const JPEG_QUALITY_MIN = 1;
const JPEG_QUALITY_MAX = 100;
const JPEG_QUALITY_DEFAULT = 92;

const SEQUENCE_FORMATS = STILL_FORMATS;
const MIN_PADDING = 1;
const MAX_PADDING = 8;
const MIN_START_INDEX = 0;
const MAX_START_INDEX = 9_999_999;

const EXPORT_QUALITY_LONG_EDGE = Object.freeze([
  { id: "draft", label: "Draft (1280)", longEdge: 1280 },
  { id: "standard", label: "Standard (1920)", longEdge: 1920 },
  { id: "high", label: "High (3840)", longEdge: 3840 },
  { id: "ultra", label: "Ultra (7680)", longEdge: 7680 },
]);

const EXPORT_ASPECT_RATIOS = Object.freeze([
  { id: "original", label: "Original" },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
]);

const VIDEO_CODECS = Object.freeze([
  { id: "libx264", label: "H.264 (libx264)", extension: "mp4", mime: "video/mp4" },
]);
const VIDEO_PRESETS = Object.freeze([
  { id: "ultrafast", label: "Ultrafast" },
  { id: "veryfast", label: "Very Fast" },
  { id: "fast", label: "Fast" },
  { id: "medium", label: "Medium" },
  { id: "slow", label: "Slow" },
]);
const MIN_CRF = 0;
const MAX_CRF = 51;
const EXPORT_PHASE_LABELS = Object.freeze({
  preparing: "Preparing",
  rendering: "Rendering",
  writing: "Writing",
  encoding: "Encoding",
  finalizing: "Finalizing",
  cancelling: "Cancelling",
});

let exportInFlight = false;
let exportAbortController = null;
let exportSheetEl = null;
let exportSheetState = createDefaultExportState();

export function initExport() {
  ensureExportSheet();
  syncExportActions(getState().source);
  subscribe("source", (source) => {
    syncExportActions(source);
    syncExportStateFromSource(source);
  });
  subscribe("graph", () => {
    if (exportSheetState.open) renderExportSheet();
  });
  subscribe("playback", () => {
    if (exportSheetState.open) renderExportSheet();
  });
}

export async function openExport(options = {}) {
  if (exportInFlight || !getState().source.loaded) return null;

  ensureExportSheet();
  exportSheetState.open = true;
  exportSheetState.mode = options.mode ?? exportSheetState.mode ?? "still";
  exportSheetState.error = "";
  syncExportStateFromSource(getState().source);
  renderExportSheet();
  exportSheetEl.classList.remove("hidden");
  exportSheetEl.setAttribute("aria-hidden", "false");
  if (exportSheetState.mode === "video" && !exportSheetState.ffmpeg.checked) {
    ensureFfmpegAvailability().catch(() => {});
  }
  return true;
}

function closeExportSheet(options = {}) {
  if (!exportSheetEl || (exportInFlight && !options.force)) return;
  exportSheetState.open = false;
  exportSheetState.error = "";
  exportSheetEl.classList.add("hidden");
  exportSheetEl.setAttribute("aria-hidden", "true");
}

function ensureExportSheet() {
  if (exportSheetEl) return exportSheetEl;

  exportSheetEl = document.createElement("div");
  exportSheetEl.className = "export-sheet-backdrop hidden";
  exportSheetEl.id = "exportSheet";
  exportSheetEl.setAttribute("aria-hidden", "true");
  exportSheetEl.innerHTML = `<div class="export-sheet floating-card" role="dialog" aria-modal="true" aria-labelledby="exportSheetTitle"></div>`;

  exportSheetEl.addEventListener("click", async (event) => {
    if (event.target === exportSheetEl) {
      closeExportSheet();
      return;
    }

    const modeButton = event.target.closest("[data-export-mode]");
    if (modeButton) {
      exportSheetState.mode = modeButton.dataset.exportMode || "still";
      exportSheetState.error = "";
      renderExportSheet();
      if (exportSheetState.mode === "video" && !exportSheetState.ffmpeg.checked) {
        ensureFfmpegAvailability().catch(() => {});
      }
      return;
    }

    const actionButton = event.target.closest("[data-export-action]");
    if (!actionButton) return;

    switch (actionButton.dataset.exportAction) {
      case "close":
        closeExportSheet();
        break;
      case "choose-path":
        await chooseExportPath();
        break;
      case "choose-directory":
        await chooseExportDirectory();
        break;
      case "choose-video-path":
        await chooseVideoExportPath();
        break;
      case "recheck-ffmpeg":
        await ensureFfmpegAvailability({ force: true });
        break;
      case "cancel-progress":
        cancelInFlightExport();
        break;
      case "submit":
        await submitExport();
        break;
      default:
        break;
    }
  });

  exportSheetEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (!target.dataset.exportField) return;

    switch (target.dataset.exportField) {
      case "target":
        exportSheetState.target = target.value;
        break;
      case "still-format": {
        const format = getStillFormat(target.value);
        exportSheetState.stillFormat = format.id;
        if (exportSheetState.destinationChosen && exportSheetState.destinationPath) {
          exportSheetState.destinationPath = replacePathExtension(
            exportSheetState.destinationPath,
            format.extension
          );
        } else {
          exportSheetState.destinationPath = "";
        }
        break;
      }
      case "resolution-mode":
        exportSheetState.resolutionMode = target.value;
        break;
      case "aspect-mode":
        exportSheetState.aspectMode = getAspectPreset(target.value)?.id ?? "original";
        break;
      case "jpeg-quality":
        exportSheetState.jpegQuality = clampJpegQuality(target.value);
        break;
      case "custom-width":
        exportSheetState.customWidth = clampDimension(target.value, exportSheetState.customWidth);
        break;
      case "custom-height":
        exportSheetState.customHeight = clampDimension(target.value, exportSheetState.customHeight);
        break;
      case "seq-format":
        exportSheetState.sequence.format = getSequenceFormat(target.value).id;
        break;
      case "seq-name":
        exportSheetState.sequence.namePrefix = sanitizeFilePrefix(target.value);
        break;
      case "seq-padding":
        exportSheetState.sequence.padding = clampPadding(target.value);
        break;
      case "seq-start":
        exportSheetState.sequence.startIndex = clampStartIndex(target.value);
        break;
      case "seq-range":
        exportSheetState.sequence.range = target.value === "full" ? "full" : "trimmed";
        break;
      case "seq-fps-mode":
        exportSheetState.sequence.fpsMode = target.value === "custom" ? "custom" : "source";
        break;
      case "seq-custom-fps":
        exportSheetState.sequence.customFps = clampFps(target.value);
        break;
      case "video-codec":
        exportSheetState.video.codec = getVideoCodec(target.value).id;
        if (exportSheetState.video.destinationChosen && exportSheetState.video.outputPath) {
          exportSheetState.video.outputPath = replacePathExtension(
            exportSheetState.video.outputPath,
            getVideoCodec(exportSheetState.video.codec).extension
          );
        }
        break;
      case "video-preset":
        exportSheetState.video.preset = getVideoPreset(target.value).id;
        break;
      case "video-crf":
        exportSheetState.video.crf = clampCrf(target.value);
        break;
      case "video-range":
        exportSheetState.video.range = target.value === "full" ? "full" : "trimmed";
        break;
      case "video-fps-mode":
        exportSheetState.video.fpsMode = target.value === "custom" ? "custom" : "source";
        break;
      case "video-custom-fps":
        exportSheetState.video.customFps = clampFps(target.value);
        break;
      default:
        break;
    }

    exportSheetState.error = "";
    renderExportSheet();
  });

  exportSheetEl.addEventListener("input", (event) => {
    const target = event.target;
    if (target?.dataset?.exportField !== "jpeg-quality") return;
    const value = clampJpegQuality(target.value);
    exportSheetState.jpegQuality = value;
    const readout = exportSheetEl.querySelector("[data-jpeg-quality-readout]");
    if (readout) readout.textContent = String(value);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!exportSheetState.open) return;
    event.preventDefault();
    closeExportSheet();
  });

  document.body.appendChild(exportSheetEl);
  renderExportSheet();
  return exportSheetEl;
}

function renderExportSheet() {
  if (!exportSheetEl) return;
  const panel = exportSheetEl.querySelector(".export-sheet");
  if (!panel) return;

  const ditherAvailable = exportSheetState.open ? hasCurrentDitherFrame() : false;
  const mode = exportSheetState.mode;
  const dirty = exportSheetState.target === "dither-only" && !ditherAvailable;
  const progress = exportSheetState.progress;

  let bodyHtml = "";
  if (mode === "still") bodyHtml = renderStillExportFields(ditherAvailable);
  else if (mode === "sequence") bodyHtml = renderSequenceExportFields(ditherAvailable);
  else bodyHtml = renderVideoExportFields(ditherAvailable);

  let submitLabel = "Coming Soon";
  let submitDisabled = true;
  if (mode === "still") {
    submitLabel = `Export ${getStillFormat(exportSheetState.stillFormat).label}`;
    submitDisabled = exportInFlight || dirty;
  } else if (mode === "sequence") {
    submitLabel = progress.active
      ? `Exporting ${progress.frame} / ${progress.total}`
      : `Export ${getSequenceFormat(exportSheetState.sequence.format).label} Sequence`;
    submitDisabled = exportInFlight || dirty;
  } else if (mode === "video") {
    submitLabel = progress.active
      ? `Encoding ${progress.frame} / ${progress.total}`
      : `Export ${getVideoCodec(exportSheetState.video.codec).label.split(" ")[0]} Video`;
    submitDisabled = exportInFlight || dirty || !exportSheetState.ffmpeg.available;
  }

  panel.innerHTML = `
    <div class="export-sheet__header">
      <div>
        <p class="eyebrow">Export</p>
        <h2 id="exportSheetTitle">Export Viewer Output</h2>
      </div>
      <button
        class="icon-btn"
        type="button"
        data-export-action="close"
        aria-label="Close export sheet"
        title="Close export sheet"
      >×</button>
    </div>

    <div class="export-sheet__body">
      <div class="field">
        <label>Mode</label>
        <div class="segmented export-sheet__modes">
          ${renderModeButton("still", "Current Frame")}
          ${renderModeButton("video", "Video File")}
          ${renderModeButton("sequence", "Image Sequence")}
        </div>
      </div>

      ${bodyHtml}

      ${progress.active ? renderProgressBlock(progress) : ""}
    </div>

    <div class="export-sheet__footer">
      <p class="hint export-sheet__status${exportSheetState.error ? " is-error" : ""}">
        ${
          exportSheetState.error
            ? escapeHtml(exportSheetState.error)
            : renderStatusText(ditherAvailable)
        }
      </p>
      <div class="export-sheet__actions">
        ${
          progress.active
            ? `<button class="btn" type="button" data-export-action="cancel-progress">Cancel Export</button>`
            : `<button class="btn" type="button" data-export-action="close">Cancel</button>`
        }
        <button
          class="btn primary"
          type="button"
          data-export-action="submit"
          ${submitDisabled ? "disabled" : ""}
        >${escapeHtml(submitLabel)}</button>
      </div>
    </div>
  `;
}

function renderModeButton(mode, label) {
  const active = exportSheetState.mode === mode ? " active" : "";
  return `
    <button
      type="button"
      class="${active.trim()}"
      data-export-mode="${mode}"
    >${escapeHtml(label)}</button>
  `;
}

function renderResolutionOptions() {
  const mode = exportSheetState.resolutionMode;
  const presetOptions = EXPORT_QUALITY_LONG_EDGE.map((preset) => `
    <option value="${preset.id}" ${preset.id === mode ? "selected" : ""}>${escapeHtml(preset.label)}</option>
  `).join("");
  return `
    <option value="source" ${mode === "source" ? "selected" : ""}>Source</option>
    ${presetOptions}
    <option value="half" ${mode === "half" ? "selected" : ""}>Half</option>
    <option value="custom" ${mode === "custom" ? "selected" : ""}>Custom</option>
  `;
}

function renderAspectOptions() {
  const mode = exportSheetState.aspectMode;
  return EXPORT_ASPECT_RATIOS.map((preset) => `
    <option value="${preset.id}" ${preset.id === mode ? "selected" : ""}>${escapeHtml(preset.label)}</option>
  `).join("");
}

function renderAspectField() {
  const disabled = exportSheetState.resolutionMode === "custom";
  return `
    <div class="field">
      <label>Aspect</label>
      <div class="dropdown">
        <select data-export-field="aspect-mode" ${disabled ? "disabled" : ""}>
          ${renderAspectOptions()}
        </select>
      </div>
    </div>
  `;
}

function renderJpegQualityField() {
  const quality = clampJpegQuality(exportSheetState.jpegQuality);
  return `
    <div class="field">
      <label>JPEG Quality</label>
      <div class="row export-sheet__slider-row">
        <input
          type="range"
          min="${JPEG_QUALITY_MIN}"
          max="${JPEG_QUALITY_MAX}"
          step="1"
          value="${quality}"
          data-export-field="jpeg-quality"
          aria-label="JPEG quality"
        />
        <span class="value mono" data-jpeg-quality-readout>${quality}</span>
      </div>
    </div>
  `;
}

function renderStillExportFields(ditherAvailable) {
  const previewPath = exportSheetState.destinationChosen
    ? exportSheetState.destinationPath
    : suggestedExportPath();
  const customSize = resolveStillSize();

  return `
    <div class="export-sheet__grid">
      <div class="field">
        <label>Output Target</label>
        <div class="dropdown">
          <select data-export-field="target">
            <option value="viewer-output" ${exportSheetState.target === "viewer-output" ? "selected" : ""}>
              Viewer Output
            </option>
            <option
              value="dither-only"
              ${exportSheetState.target === "dither-only" ? "selected" : ""}
              ${ditherAvailable ? "" : "disabled"}
            >
              Dither Only${ditherAvailable ? "" : " (Unavailable)"}
            </option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Format</label>
        <div class="dropdown">
          <select data-export-field="still-format">
            ${STILL_FORMATS.map((format) => `
              <option value="${format.id}" ${format.id === exportSheetState.stillFormat ? "selected" : ""}>
                ${escapeHtml(format.label)}
              </option>
            `).join("")}
          </select>
        </div>
      </div>
    </div>

    ${exportSheetState.stillFormat === "jpeg" ? `
      <div class="export-sheet__grid">
        ${renderJpegQualityField()}
      </div>
    ` : ""}

    <div class="export-sheet__grid">
      <div class="field">
        <label>Resolution</label>
        <div class="dropdown">
          <select data-export-field="resolution-mode">
            ${renderResolutionOptions()}
          </select>
        </div>
      </div>

      ${renderAspectField()}
    </div>

    <div class="export-sheet__grid">
      <div class="field">
        <label>Size Preview</label>
        <div class="row export-sheet__size-preview">
          <span class="value mono">${customSize.width} × ${customSize.height}</span>
        </div>
      </div>
    </div>

    ${
      exportSheetState.resolutionMode === "custom"
        ? `
          <div class="export-sheet__grid">
            <div class="field">
              <label>Width</label>
              <input type="number" min="1" max="8192" step="1" value="${exportSheetState.customWidth}" data-export-field="custom-width" />
            </div>
            <div class="field">
              <label>Height</label>
              <input type="number" min="1" max="8192" step="1" value="${exportSheetState.customHeight}" data-export-field="custom-height" />
            </div>
          </div>
        `
        : ""
    }

    <div class="field">
      <label>Destination</label>
      <div class="export-sheet__path-row">
        <input
          type="text"
          readonly
          value="${escapeHtml(previewPath)}"
          aria-label="Export destination preview"
        />
        <button class="btn" type="button" data-export-action="choose-path">Choose…</button>
      </div>
    </div>
  `;
}

function renderVideoExportFields(ditherAvailable) {
  const video = exportSheetState.video;
  const codec = getVideoCodec(video.codec);
  const sourceFps = getActiveSourceFps();
  const effectiveFps = video.fpsMode === "custom" ? video.customFps : sourceFps;
  const rangeSeconds = getVideoRangeSeconds(video.range);
  const totalFrames = estimateSequenceFrames(effectiveFps, rangeSeconds);
  const customSize = resolveStillSize();
  const ffmpeg = exportSheetState.ffmpeg;
  const destinationLabel = video.destinationChosen && video.outputPath
    ? video.outputPath
    : `Choose an output ${codec.extension.toUpperCase()} file…`;

  return `
    <div class="export-sheet__grid">
      <div class="field">
        <label>Output Target</label>
        <div class="dropdown">
          <select data-export-field="target">
            <option value="viewer-output" ${exportSheetState.target === "viewer-output" ? "selected" : ""}>
              Viewer Output
            </option>
            <option
              value="dither-only"
              ${exportSheetState.target === "dither-only" ? "selected" : ""}
              ${ditherAvailable ? "" : "disabled"}
            >
              Dither Only${ditherAvailable ? "" : " (Unavailable)"}
            </option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Codec</label>
        <div class="dropdown">
          <select data-export-field="video-codec">
            ${VIDEO_CODECS.map((item) => `
              <option value="${item.id}" ${item.id === video.codec ? "selected" : ""}>
                ${escapeHtml(item.label)}
              </option>
            `).join("")}
          </select>
        </div>
      </div>
    </div>

    <div class="export-sheet__grid">
      <div class="field">
        <label>Range</label>
        <div class="dropdown">
          <select data-export-field="video-range">
            <option value="trimmed" ${video.range === "trimmed" ? "selected" : ""}>Trimmed Range</option>
            <option value="full" ${video.range === "full" ? "selected" : ""}>Full Video</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>FPS</label>
        <div class="dropdown">
          <select data-export-field="video-fps-mode">
            <option value="source" ${video.fpsMode === "source" ? "selected" : ""}>Source (${sourceFps})</option>
            <option value="custom" ${video.fpsMode === "custom" ? "selected" : ""}>Custom</option>
          </select>
        </div>
      </div>
    </div>

    ${
      video.fpsMode === "custom"
        ? `
          <div class="export-sheet__grid">
            <div class="field">
              <label>Custom FPS</label>
              <input type="number" min="1" max="120" step="1" value="${video.customFps}" data-export-field="video-custom-fps" />
            </div>
            <div class="field">
              <label>Estimated Frames</label>
              <div class="row export-sheet__size-preview">
                <span class="value mono">${totalFrames}</span>
              </div>
            </div>
          </div>
        `
        : ""
    }

    <div class="export-sheet__grid">
      <div class="field">
        <label>Resolution</label>
        <div class="dropdown">
          <select data-export-field="resolution-mode">
            ${renderResolutionOptions()}
          </select>
        </div>
      </div>
      ${renderAspectField()}
    </div>

    <div class="export-sheet__grid">
      <div class="field">
        <label>${video.fpsMode === "custom" ? "Size" : "Estimated Frames"}</label>
        <div class="row export-sheet__size-preview">
          <span class="value mono">${
            video.fpsMode === "custom"
              ? `${customSize.width} × ${customSize.height}`
              : totalFrames
          }</span>
        </div>
      </div>
    </div>

    ${
      exportSheetState.resolutionMode === "custom"
        ? `
          <div class="export-sheet__grid">
            <div class="field">
              <label>Width</label>
              <input type="number" min="1" max="8192" step="1" value="${exportSheetState.customWidth}" data-export-field="custom-width" />
            </div>
            <div class="field">
              <label>Height</label>
              <input type="number" min="1" max="8192" step="1" value="${exportSheetState.customHeight}" data-export-field="custom-height" />
            </div>
          </div>
        `
        : ""
    }

    <div class="export-sheet__grid">
      <div class="field">
        <label>Preset</label>
        <div class="dropdown">
          <select data-export-field="video-preset">
            ${VIDEO_PRESETS.map((item) => `
              <option value="${item.id}" ${item.id === video.preset ? "selected" : ""}>
                ${escapeHtml(item.label)}
              </option>
            `).join("")}
          </select>
        </div>
      </div>
      <div class="field">
        <label>Quality (CRF ${video.crf})</label>
        <input type="number" min="${MIN_CRF}" max="${MAX_CRF}" step="1" value="${video.crf}" data-export-field="video-crf" />
      </div>
    </div>

    <div class="field">
      <label>Destination</label>
      <div class="export-sheet__path-row">
        <input
          type="text"
          readonly
          value="${escapeHtml(destinationLabel)}"
          aria-label="Output video file"
        />
        <button class="btn" type="button" data-export-action="choose-video-path">Choose…</button>
      </div>
    </div>

    <div class="export-sheet__ffmpeg ${ffmpeg.available ? "is-ok" : ffmpeg.checked ? "is-error" : ""}">
      <div class="export-sheet__ffmpeg-status">
        <span class="dot" aria-hidden="true"></span>
        <span class="hint">${escapeHtml(renderFfmpegStatusText(ffmpeg))}</span>
      </div>
      <button class="btn" type="button" data-export-action="recheck-ffmpeg" ${ffmpeg.checking ? "disabled" : ""}>
        ${ffmpeg.checking ? "Checking…" : ffmpeg.checked ? "Re-check" : "Check FFmpeg"}
      </button>
    </div>
  `;
}

function renderFfmpegStatusText(ffmpeg) {
  if (!ffmpeg.checked) return "FFmpeg availability has not been checked yet.";
  if (ffmpeg.available) return `FFmpeg detected${ffmpeg.version ? ` — ${ffmpeg.version}` : ""}.`;
  return ffmpeg.error
    ? `FFmpeg not available: ${ffmpeg.error}`
    : "FFmpeg not available on this system.";
}

function renderSequenceExportFields(ditherAvailable) {
  const seq = exportSheetState.sequence;
  const format = getSequenceFormat(seq.format);
  const sourceFps = getActiveSourceFps();
  const effectiveFps = seq.fpsMode === "custom" ? seq.customFps : sourceFps;
  const rangeSeconds = getSequenceRangeSeconds(seq.range);
  const totalFrames = estimateSequenceFrames(effectiveFps, rangeSeconds);
  const previewName = buildFrameFilename(seq, format, seq.startIndex);
  const destinationLabel = seq.directoryChosen && seq.directory
    ? seq.directory
    : "Choose an output folder…";
  const customSize = resolveStillSize();

  return `
    <div class="export-sheet__grid">
      <div class="field">
        <label>Output Target</label>
        <div class="dropdown">
          <select data-export-field="target">
            <option value="viewer-output" ${exportSheetState.target === "viewer-output" ? "selected" : ""}>
              Viewer Output
            </option>
            <option
              value="dither-only"
              ${exportSheetState.target === "dither-only" ? "selected" : ""}
              ${ditherAvailable ? "" : "disabled"}
            >
              Dither Only${ditherAvailable ? "" : " (Unavailable)"}
            </option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Format</label>
        <div class="dropdown">
          <select data-export-field="seq-format">
            ${SEQUENCE_FORMATS.map((item) => `
              <option value="${item.id}" ${item.id === seq.format ? "selected" : ""}>
                ${escapeHtml(item.label)}
              </option>
            `).join("")}
          </select>
        </div>
      </div>
    </div>

    ${seq.format === "jpeg" ? `
      <div class="export-sheet__grid">
        ${renderJpegQualityField()}
      </div>
    ` : ""}

    <div class="export-sheet__grid">
      <div class="field">
        <label>Range</label>
        <div class="dropdown">
          <select data-export-field="seq-range">
            <option value="trimmed" ${seq.range === "trimmed" ? "selected" : ""}>Trimmed Range</option>
            <option value="full" ${seq.range === "full" ? "selected" : ""}>Full Video</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>FPS</label>
        <div class="dropdown">
          <select data-export-field="seq-fps-mode">
            <option value="source" ${seq.fpsMode === "source" ? "selected" : ""}>Source (${sourceFps})</option>
            <option value="custom" ${seq.fpsMode === "custom" ? "selected" : ""}>Custom</option>
          </select>
        </div>
      </div>
    </div>

    ${
      seq.fpsMode === "custom"
        ? `
          <div class="export-sheet__grid">
            <div class="field">
              <label>Custom FPS</label>
              <input type="number" min="1" max="120" step="1" value="${seq.customFps}" data-export-field="seq-custom-fps" />
            </div>
            <div class="field">
              <label>Estimated Frames</label>
              <div class="row export-sheet__size-preview">
                <span class="value mono">${totalFrames}</span>
              </div>
            </div>
          </div>
        `
        : ""
    }

    <div class="export-sheet__grid">
      <div class="field">
        <label>Resolution</label>
        <div class="dropdown">
          <select data-export-field="resolution-mode">
            ${renderResolutionOptions()}
          </select>
        </div>
      </div>
      ${renderAspectField()}
    </div>

    <div class="export-sheet__grid">
      <div class="field">
        <label>${seq.fpsMode === "custom" ? "Size" : "Estimated Frames"}</label>
        <div class="row export-sheet__size-preview">
          <span class="value mono">${
            seq.fpsMode === "custom"
              ? `${customSize.width} × ${customSize.height}`
              : totalFrames
          }</span>
        </div>
      </div>
    </div>

    ${
      exportSheetState.resolutionMode === "custom"
        ? `
          <div class="export-sheet__grid">
            <div class="field">
              <label>Width</label>
              <input type="number" min="1" max="8192" step="1" value="${exportSheetState.customWidth}" data-export-field="custom-width" />
            </div>
            <div class="field">
              <label>Height</label>
              <input type="number" min="1" max="8192" step="1" value="${exportSheetState.customHeight}" data-export-field="custom-height" />
            </div>
          </div>
        `
        : ""
    }

    <div class="export-sheet__grid">
      <div class="field">
        <label>Filename Prefix</label>
        <input
          type="text"
          value="${escapeHtml(seq.namePrefix)}"
          maxlength="120"
          data-export-field="seq-name"
          aria-label="Filename prefix"
        />
      </div>
      <div class="field">
        <label>Preview</label>
        <div class="row export-sheet__size-preview">
          <span class="value mono">${escapeHtml(previewName)}</span>
        </div>
      </div>
    </div>

    <div class="export-sheet__grid">
      <div class="field">
        <label>Padding (digits)</label>
        <input type="number" min="${MIN_PADDING}" max="${MAX_PADDING}" step="1" value="${seq.padding}" data-export-field="seq-padding" />
      </div>
      <div class="field">
        <label>Start Index</label>
        <input type="number" min="${MIN_START_INDEX}" max="${MAX_START_INDEX}" step="1" value="${seq.startIndex}" data-export-field="seq-start" />
      </div>
    </div>

    <div class="field">
      <label>Output Folder</label>
      <div class="export-sheet__path-row">
        <input
          type="text"
          readonly
          value="${escapeHtml(destinationLabel)}"
          aria-label="Output folder"
        />
        <button class="btn" type="button" data-export-action="choose-directory">Choose…</button>
      </div>
    </div>
  `;
}

function renderProgressBlock(progress) {
  const ratio = progress.total > 0 ? Math.min(1, progress.frame / progress.total) : 0;
  const percent = Math.round(ratio * 100);
  const phase = formatExportPhase(progress);
  const eta = formatExportEta(progress);
  return `
    <div class="export-sheet__progress">
      <div class="export-sheet__progress-head">
        <span class="export-sheet__progress-phase">${escapeHtml(phase)}</span>
        <span class="mono">${escapeHtml(eta)}</span>
      </div>
      <div class="export-sheet__progress-meta">
        <span class="mono">${progress.frame} / ${progress.total}</span>
        <span class="mono">${percent}%</span>
      </div>
      <div class="export-sheet__progress-bar">
        <div class="export-sheet__progress-fill" style="width:${percent}%"></div>
      </div>
    </div>
  `;
}

function formatExportPhase(progress) {
  if (progress.cancelled) return EXPORT_PHASE_LABELS.cancelling;
  return EXPORT_PHASE_LABELS[progress.phase] ?? EXPORT_PHASE_LABELS.preparing;
}

function formatExportEta(progress) {
  if (progress.cancelled) return "ETA --";
  if (!progress.active) return "ETA --";
  if (progress.total > 0 && progress.frame >= progress.total) return "ETA 0:00";
  if (!(progress.frame > 0 && progress.total > progress.frame)) return "ETA calculating";
  const startedAt = Number(progress.startedAt);
  if (!Number.isFinite(startedAt)) return "ETA calculating";
  const elapsedSeconds = Math.max(0, (currentExportTime() - startedAt) / 1000);
  const secondsPerFrame = elapsedSeconds / progress.frame;
  const remainingSeconds = secondsPerFrame * Math.max(0, progress.total - progress.frame);
  if (!Number.isFinite(remainingSeconds)) return "ETA calculating";
  return `ETA ${formatDuration(remainingSeconds)}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function renderStatusText(ditherAvailable) {
  const mode = exportSheetState.mode;
  if (exportSheetState.progress.active) {
    return exportSheetState.progress.cancelled
      ? "Cancelling export…"
      : `${formatExportPhase(exportSheetState.progress)} export…`;
  }
  if (exportInFlight && mode === "still") return "Exporting current frame…";
  if (exportSheetState.target === "dither-only" && !ditherAvailable) {
    return "Dither-only export becomes available once the graph produces a dither output.";
  }
  if (mode === "sequence") {
    return exportSheetState.sequence.directoryChosen
      ? "Sequence export renders each frame through the same graph as preview."
      : "Pick an output folder to render the numbered image sequence.";
  }
  if (mode === "video") {
    if (!exportSheetState.ffmpeg.checked) return "Checking whether FFmpeg is reachable on your system…";
    if (!exportSheetState.ffmpeg.available) return "Install FFmpeg or expose it on PATH to enable video export.";
    return exportSheetState.video.destinationChosen
      ? "Video export pipes RGBA frames straight to FFmpeg — preview parity is preserved."
      : "Pick a destination file to encode the trimmed range.";
  }
  return "Still export uses the same rendered frame buffers as preview.";
}

async function chooseExportPath() {
  const path = ensurePathExtension(await pickExportPath(), getStillFormat(exportSheetState.stillFormat).extension);
  if (!path) return null;
  exportSheetState.destinationPath = path;
  exportSheetState.destinationChosen = true;
  exportSheetState.error = "";
  renderExportSheet();
  return path;
}

async function submitExport() {
  if (exportInFlight) return null;
  if (exportSheetState.mode === "still") return submitStillExport();
  if (exportSheetState.mode === "sequence") return submitSequenceExport();
  if (exportSheetState.mode === "video") return submitVideoExport();
  return null;
}

async function submitStillExport() {
  const canvas = buildStillExportCanvas();
  if (!canvas?.width || !canvas?.height) {
    exportSheetState.error = "Nothing is available to export for the selected target.";
    renderExportSheet();
    return null;
  }

  exportInFlight = true;
  exportSheetState.error = "";
  renderExportSheet();
  syncExportActions(getState().source);

  let exportedPath = null;
  try {
    const path = exportSheetState.destinationChosen
      ? exportSheetState.destinationPath
      : await chooseExportPath();
    if (!path) return null;

    const format = getStillFormat(exportSheetState.stillFormat);
    const bytes = await canvasToImageBytes(canvas, format);
    const written = await writeImage(path, bytes);
    if (!written) {
      downloadFallback(bytes, path.split(/[/\\]/).pop() || suggestedExportName(), format.mime);
    }
    exportedPath = path;
  } catch (error) {
    exportSheetState.error = error?.message || "Export failed.";
    renderExportSheet();
  } finally {
    exportInFlight = false;
    syncExportActions(getState().source);
    if (exportedPath) {
      closeExportSheet({ force: true });
    } else if (exportSheetState.open) {
      renderExportSheet();
    }
  }

  return exportedPath;
}

async function submitSequenceExport() {
  const seq = exportSheetState.sequence;
  const source = getState().source;
  if (!source.loaded) {
    exportSheetState.error = "Load a source before exporting.";
    renderExportSheet();
    return null;
  }

  if (!seq.directoryChosen || !seq.directory) {
    const dir = await chooseExportDirectory();
    if (!dir) return null;
  }

  const format = getSequenceFormat(seq.format);
  const fps = seq.fpsMode === "custom" ? seq.customFps : getActiveSourceFps();
  const rangeSeconds = getSequenceRangeSeconds(seq.range);
  const totalFrames = estimateSequenceFrames(fps, rangeSeconds);
  if (totalFrames <= 0) {
    exportSheetState.error = "Range is empty — adjust trim handles or switch to Full Video.";
    renderExportSheet();
    return null;
  }

  const ditherAvailable = hasCurrentDitherFrame();
  if (exportSheetState.target === "dither-only" && !ditherAvailable) {
    exportSheetState.error = "Dither-only target requires a dither node in the graph.";
    renderExportSheet();
    return null;
  }

  exportInFlight = true;
  exportAbortController = new AbortController();
  exportSheetState.error = "";
  exportSheetState.progress = createExportProgress("sequence", totalFrames, "preparing");
  renderExportSheet();
  syncExportActions(source);

  const signal = exportAbortController.signal;
  const startTime = getSequenceStartTime(seq.range);
  let writtenCount = 0;
  let failure = null;

  beginExportSession();
  try {
    updateExportProgress({ phase: "rendering" });
    renderExportSheet();
    for (let i = 0; i < totalFrames; i++) {
      if (signal.aborted) break;
      const t = Math.min(startTime + i / fps, startTime + rangeSeconds);
      const ok = await seekForExport(t);
      if (!ok) throw new Error(`Frame seek failed at ${t.toFixed(3)}s (frame ${i + 1}).`);
      if (signal.aborted) break;

      const canvas = buildStillExportCanvas();
      if (!canvas?.width || !canvas?.height) {
        throw new Error(`Frame ${i + 1} produced an empty canvas.`);
      }

      const bytes = await canvasToImageBytes(canvas, format);
      if (signal.aborted) break;

      const fileName = buildFrameFilename(seq, format, seq.startIndex + i);
      const fullPath = joinPath(seq.directory, fileName);
      updateExportProgress({ phase: "writing" });
      renderExportSheet();
      const written = await writeImage(fullPath, bytes);
      if (!written) throw new Error(`Failed to write ${fileName}.`);
      writtenCount += 1;

      updateExportProgress({ frame: writtenCount, phase: "rendering" });
      renderExportSheet();
    }
  } catch (error) {
    failure = error;
  } finally {
    endExportSession();
    const cancelled = signal.aborted;
    exportAbortController = null;
    exportInFlight = false;
    exportSheetState.progress = {
      active: false,
      frame: writtenCount,
      total: totalFrames,
      cancelled,
      kind: "sequence",
      phase: cancelled ? "cancelling" : "finalizing",
    };

    if (failure && !cancelled) {
      exportSheetState.error = failure.message || "Sequence export failed.";
    } else if (cancelled) {
      exportSheetState.error = `Cancelled after ${writtenCount} / ${totalFrames} frames.`;
    } else {
      exportSheetState.error = "";
    }

    syncExportActions(getState().source);
    if (exportSheetState.open) renderExportSheet();
    if (!failure && !cancelled && writtenCount === totalFrames) {
      closeExportSheet({ force: true });
    }
  }

  return writtenCount === totalFrames && !failure ? seq.directory : null;
}

function cancelInFlightExport() {
  if (!exportAbortController || exportSheetState.progress.cancelled) return;
  updateExportProgress({ cancelled: true, phase: "cancelling" });
  exportAbortController.abort();
  renderExportSheet();
}

function buildStillExportCanvas() {
  const baseCanvas = getCurrentExportFrameCanvas(exportSheetState.target);
  if (!baseCanvas?.width || !baseCanvas?.height) return null;

  const { width, height } = resolveStillSize(baseCanvas.width, baseCanvas.height);
  if (width === baseCanvas.width && height === baseCanvas.height) {
    return baseCanvas;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = exportSheetState.target !== "dither-only";
  const crop = computeCoverCrop(baseCanvas.width, baseCanvas.height, width, height);
  context.drawImage(baseCanvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
  return canvas;
}

function resolveStillSize(baseWidth = getState().source.videoWidth, baseHeight = getState().source.videoHeight) {
  if (exportSheetState.resolutionMode === "custom") {
    return {
      width: clampDimension(exportSheetState.customWidth, baseWidth),
      height: clampDimension(exportSheetState.customHeight, baseHeight),
    };
  }

  const sourceLongEdge = Math.max(baseWidth, baseHeight);
  let targetLongEdge;
  switch (exportSheetState.resolutionMode) {
    case "half":
      targetLongEdge = sourceLongEdge / 2;
      break;
    case "source":
      targetLongEdge = sourceLongEdge;
      break;
    default: {
      const preset = getQualityPreset(exportSheetState.resolutionMode);
      targetLongEdge = preset ? preset.longEdge : sourceLongEdge;
    }
  }

  const aspect = resolveAspectRatio(baseWidth, baseHeight);
  if (aspect >= 1) {
    return {
      width: Math.max(1, Math.round(targetLongEdge)),
      height: Math.max(1, Math.round(targetLongEdge / aspect)),
    };
  }
  return {
    width: Math.max(1, Math.round(targetLongEdge * aspect)),
    height: Math.max(1, Math.round(targetLongEdge)),
  };
}

function getQualityPreset(id) {
  return EXPORT_QUALITY_LONG_EDGE.find((preset) => preset.id === id);
}

function getAspectPreset(id) {
  return EXPORT_ASPECT_RATIOS.find((preset) => preset.id === id);
}

function resolveAspectRatio(baseWidth, baseHeight) {
  const preset = getAspectPreset(exportSheetState.aspectMode);
  if (!preset || preset.id === "original" || typeof preset.ratio !== "number") {
    return baseHeight > 0 ? baseWidth / baseHeight : 1;
  }
  return preset.ratio;
}

function computeCoverCrop(sourceW, sourceH, targetW, targetH) {
  if (sourceW <= 0 || sourceH <= 0 || targetW <= 0 || targetH <= 0) {
    return { sx: 0, sy: 0, sw: sourceW, sh: sourceH };
  }
  const sourceAspect = sourceW / sourceH;
  const targetAspect = targetW / targetH;
  if (Math.abs(sourceAspect - targetAspect) < 1e-4) {
    return { sx: 0, sy: 0, sw: sourceW, sh: sourceH };
  }
  if (sourceAspect > targetAspect) {
    const sw = sourceH * targetAspect;
    return { sx: (sourceW - sw) / 2, sy: 0, sw, sh: sourceH };
  }
  const sh = sourceW / targetAspect;
  return { sx: 0, sy: (sourceH - sh) / 2, sw: sourceW, sh };
}

function syncExportActions(source) {
  const disabled = !source.loaded || exportInFlight;
  for (const el of document.querySelectorAll('[data-action="export"], [data-mitem="export-frame"]')) {
    el.disabled = disabled;
  }
}

function syncExportStateFromSource(source) {
  if (!source?.loaded) return;
  const nextWidth = Math.max(1, Math.round(source.videoWidth || 1));
  const nextHeight = Math.max(1, Math.round(source.videoHeight || 1));
  const sourceChanged =
    nextWidth !== exportSheetState.lastSourceWidth || nextHeight !== exportSheetState.lastSourceHeight;

  if (sourceChanged) {
    const widthWasAuto =
      !exportSheetState.customWidth || exportSheetState.customWidth === exportSheetState.lastSourceWidth;
    const heightWasAuto =
      !exportSheetState.customHeight || exportSheetState.customHeight === exportSheetState.lastSourceHeight;

    exportSheetState.customWidth = widthWasAuto
      ? nextWidth
      : clampDimension(exportSheetState.customWidth, nextWidth);
    exportSheetState.customHeight = heightWasAuto
      ? nextHeight
      : clampDimension(exportSheetState.customHeight, nextHeight);
    exportSheetState.lastSourceWidth = nextWidth;
    exportSheetState.lastSourceHeight = nextHeight;
  }

  if (exportSheetState.open) renderExportSheet();
}

async function pickExportPath() {
  const tauri = window.__TAURI__;
  const format = getStillFormat(exportSheetState.stillFormat);
  if (!tauri?.dialog?.save) {
    return suggestedExportPath();
  }

  return tauri.dialog.save({
    title: "Export Current Frame",
    defaultPath: exportSheetState.destinationChosen ? exportSheetState.destinationPath : suggestedExportPath(),
    filters: [{ name: format.label, extensions: [format.extension] }],
  });
}

function suggestedExportPath() {
  return suggestedExportName();
}

function suggestedExportName() {
  const { source, playback } = getState();
  const format = getStillFormat(exportSheetState.stillFormat);
  const baseName = (source.path.split(/[/\\]/).pop() || "frame").replace(/\.[^.]+$/, "");
  const timeCode = formatExportTime(playback.currentTime || 0);
  const targetSuffix = exportSheetState.target === "dither-only" ? "-dither" : "";
  return `${baseName}-${timeCode}${targetSuffix}.${format.extension}`;
}

function getStillFormat(id) {
  return STILL_FORMATS.find((format) => format.id === id) ?? STILL_FORMATS[0];
}

function formatExportTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = String(Math.floor(whole / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const secs = String(whole % 60).padStart(2, "0");
  return `${hours}-${minutes}-${secs}`;
}

async function canvasToImageBytes(canvas, format) {
  const quality = format.id === "jpeg" ? clampJpegQuality(exportSheetState.jpegQuality) / 100 : undefined;
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) resolve(nextBlob);
      else reject(new Error("Canvas export returned an empty blob"));
    }, format.mime, quality);
  });

  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

function clampJpegQuality(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return JPEG_QUALITY_DEFAULT;
  return Math.max(JPEG_QUALITY_MIN, Math.min(JPEG_QUALITY_MAX, numeric));
}

async function writeImage(path, bytes) {
  const tauri = window.__TAURI__;
  try {
    if (tauri?.fs?.writeFile) {
      await tauri.fs.writeFile(path, bytes);
      return true;
    }
    if (tauri?.fs?.writeBinaryFile) {
      await tauri.fs.writeBinaryFile(path, bytes);
      return true;
    }
  } catch (error) {
    console.warn("[export] native write failed, using browser download fallback", error);
  }
  return false;
}

function downloadFallback(bytes, fileName, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function createDefaultExportState() {
  return {
    open: false,
    mode: "still",
    stillFormat: "png",
    target: "viewer-output",
    resolutionMode: "source",
    aspectMode: "original",
    jpegQuality: JPEG_QUALITY_DEFAULT,
    customWidth: 0,
    customHeight: 0,
    destinationPath: "",
    destinationChosen: false,
    error: "",
    lastSourceWidth: 0,
    lastSourceHeight: 0,
    sequence: {
      format: "png",
      directory: "",
      directoryChosen: false,
      namePrefix: "frame",
      padding: 5,
      startIndex: 1,
      range: "trimmed",
      fpsMode: "source",
      customFps: 30,
    },
    video: {
      codec: "libx264",
      preset: "medium",
      crf: 18,
      outputPath: "",
      destinationChosen: false,
      range: "trimmed",
      fpsMode: "source",
      customFps: 30,
    },
    ffmpeg: {
      checked: false,
      available: false,
      error: "",
      version: "",
      checking: false,
    },
    progress: {
      active: false,
      frame: 0,
      total: 0,
      cancelled: false,
      kind: "",
      phase: "preparing",
      startedAt: 0,
      updatedAt: 0,
    },
  };
}

function createExportProgress(kind, total, phase = "preparing") {
  const now = currentExportTime();
  return {
    active: true,
    frame: 0,
    total,
    cancelled: false,
    kind,
    phase,
    startedAt: now,
    updatedAt: now,
  };
}

function updateExportProgress(patch) {
  exportSheetState.progress = {
    ...exportSheetState.progress,
    ...patch,
    updatedAt: currentExportTime(),
  };
}

function currentExportTime() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function clampDimension(value, fallback) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.max(1, Math.round(fallback || 1));
  return Math.max(1, Math.min(8192, numeric));
}

function ensurePathExtension(path, extension) {
  if (!path) return path;
  return replacePathExtension(path, extension);
}

function replacePathExtension(path, extension) {
  const normalized = String(path).trim();
  if (!normalized) return normalized;
  if (/\.[^./\\]+$/.test(normalized)) {
    return normalized.replace(/\.[^./\\]+$/, `.${extension}`);
  }
  return `${normalized}.${extension}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function chooseExportDirectory() {
  const tauri = window.__TAURI__;
  if (!tauri?.dialog?.open) {
    exportSheetState.error = "Folder picker is only available in the desktop app.";
    renderExportSheet();
    return null;
  }

  const seq = exportSheetState.sequence;
  let selected;
  try {
    selected = await tauri.dialog.open({
      title: "Choose Sequence Output Folder",
      directory: true,
      multiple: false,
      defaultPath: seq.directoryChosen ? seq.directory : undefined,
    });
  } catch (error) {
    exportSheetState.error = error?.message || "Folder picker failed.";
    renderExportSheet();
    return null;
  }

  if (!selected) return null;
  const dir = typeof selected === "string" ? selected : selected.path || "";
  if (!dir) return null;

  exportSheetState.sequence.directory = dir;
  exportSheetState.sequence.directoryChosen = true;
  exportSheetState.error = "";
  renderExportSheet();
  return dir;
}

function getSequenceFormat(id) {
  return SEQUENCE_FORMATS.find((format) => format.id === id) ?? SEQUENCE_FORMATS[0];
}

function getActiveSourceFps() {
  const { source } = getState();
  const fps = Math.round(Number(source.fps || source.sourceFps || 30));
  return Math.max(1, Math.min(120, Number.isFinite(fps) ? fps : 30));
}

function getSequenceRangeSeconds(range) {
  const { source, playback } = getState();
  const duration = Math.max(0, Number(source.duration) || 0);
  if (range === "full" || !playback) return duration;
  const start = clampTime(playback.trimStart, duration);
  const end = clampTime(playback.trimEnd, duration);
  return Math.max(0, end - start);
}

function getSequenceStartTime(range) {
  const { source, playback } = getState();
  const duration = Math.max(0, Number(source.duration) || 0);
  if (range === "full" || !playback) return 0;
  return clampTime(playback.trimStart, duration);
}

function clampTime(value, duration) {
  const t = Number(value);
  if (!Number.isFinite(t) || t < 0) return 0;
  if (duration > 0 && t > duration) return duration;
  return t;
}

function estimateSequenceFrames(fps, seconds) {
  if (!(fps > 0) || !(seconds > 0)) return 0;
  return Math.max(0, Math.floor(seconds * fps + 1e-6));
}

function buildFrameFilename(seq, format, index) {
  const prefix = seq.namePrefix || "frame";
  const padded = String(Math.max(0, Math.floor(index))).padStart(seq.padding, "0");
  return `${prefix}_${padded}.${format.extension}`;
}

function joinPath(dir, file) {
  if (!dir) return file;
  const normalized = String(dir).replace(/[\\/]+$/, "");
  const sep = normalized.includes("\\") ? "\\" : "/";
  return `${normalized}${sep}${file}`;
}

function clampPadding(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MIN_PADDING;
  return Math.max(MIN_PADDING, Math.min(MAX_PADDING, n));
}

function clampStartIndex(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN_START_INDEX, Math.min(MAX_START_INDEX, n));
}

function clampFps(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.max(1, Math.min(120, n));
}

function sanitizeFilePrefix(value) {
  const trimmed = String(value ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "").slice(0, 120);
  return trimmed || "frame";
}

function getVideoCodec(id) {
  return VIDEO_CODECS.find((codec) => codec.id === id) ?? VIDEO_CODECS[0];
}

function getVideoPreset(id) {
  return VIDEO_PRESETS.find((preset) => preset.id === id) ?? VIDEO_PRESETS[0];
}

function clampCrf(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 18;
  return Math.max(MIN_CRF, Math.min(MAX_CRF, n));
}

function getVideoRangeSeconds(range) {
  return getSequenceRangeSeconds(range);
}

function getVideoStartTime(range) {
  return getSequenceStartTime(range);
}

function tauriInvoke() {
  const tauri = window.__TAURI__;
  return tauri?.core?.invoke || tauri?.invoke || null;
}

async function ensureFfmpegAvailability(options = {}) {
  const ffmpeg = exportSheetState.ffmpeg;
  if (!options.force && ffmpeg.checked) return ffmpeg.available;
  if (ffmpeg.checking) return ffmpeg.available;

  const invoke = tauriInvoke();
  if (!invoke) {
    exportSheetState.ffmpeg = {
      checked: true,
      available: false,
      version: "",
      error: "Video export requires the desktop app.",
      checking: false,
    };
    if (exportSheetState.open) renderExportSheet();
    return false;
  }

  exportSheetState.ffmpeg = { ...ffmpeg, checking: true };
  if (exportSheetState.open) renderExportSheet();

  try {
    const result = await invoke("ffmpeg_check_available");
    exportSheetState.ffmpeg = {
      checked: true,
      available: !!result?.available,
      version: result?.version || "",
      error: result?.error || "",
      checking: false,
    };
  } catch (error) {
    exportSheetState.ffmpeg = {
      checked: true,
      available: false,
      version: "",
      error: error?.message || String(error),
      checking: false,
    };
  }

  if (exportSheetState.open) renderExportSheet();
  return exportSheetState.ffmpeg.available;
}

async function chooseVideoExportPath() {
  const tauri = window.__TAURI__;
  const codec = getVideoCodec(exportSheetState.video.codec);
  if (!tauri?.dialog?.save) {
    exportSheetState.error = "Video file picker is only available in the desktop app.";
    renderExportSheet();
    return null;
  }

  let selected;
  try {
    selected = await tauri.dialog.save({
      title: "Export Video",
      defaultPath: exportSheetState.video.destinationChosen ? exportSheetState.video.outputPath : suggestedVideoExportName(),
      filters: [{ name: codec.label, extensions: [codec.extension] }],
    });
  } catch (error) {
    exportSheetState.error = error?.message || "File picker failed.";
    renderExportSheet();
    return null;
  }

  if (!selected) return null;
  const path = ensurePathExtension(typeof selected === "string" ? selected : selected.path || "", codec.extension);
  if (!path) return null;
  exportSheetState.video.outputPath = path;
  exportSheetState.video.destinationChosen = true;
  exportSheetState.error = "";
  renderExportSheet();
  return path;
}

function suggestedVideoExportName() {
  const { source } = getState();
  const codec = getVideoCodec(exportSheetState.video.codec);
  const baseName = (source.path.split(/[/\\]/).pop() || "export").replace(/\.[^.]+$/, "");
  const targetSuffix = exportSheetState.target === "dither-only" ? "-dither" : "";
  return `${baseName}-export${targetSuffix}.${codec.extension}`;
}

function readCanvasRGBA(canvas) {
  if (!canvas?.width || !canvas?.height) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
}

async function submitVideoExport() {
  const video = exportSheetState.video;
  const source = getState().source;
  if (!source.loaded) {
    exportSheetState.error = "Load a source before exporting.";
    renderExportSheet();
    return null;
  }

  const ok = await ensureFfmpegAvailability();
  if (!ok) {
    exportSheetState.error = exportSheetState.ffmpeg.error || "FFmpeg is not available on this system.";
    renderExportSheet();
    return null;
  }

  const invoke = tauriInvoke();
  if (!invoke) {
    exportSheetState.error = "Video export requires the desktop app.";
    renderExportSheet();
    return null;
  }

  if (!video.destinationChosen || !video.outputPath) {
    const path = await chooseVideoExportPath();
    if (!path) return null;
  }

  const fps = video.fpsMode === "custom" ? video.customFps : getActiveSourceFps();
  const rangeSeconds = getVideoRangeSeconds(video.range);
  const totalFrames = estimateSequenceFrames(fps, rangeSeconds);
  if (totalFrames <= 0) {
    exportSheetState.error = "Range is empty — adjust trim handles or switch to Full Video.";
    renderExportSheet();
    return null;
  }

  const ditherAvailable = hasCurrentDitherFrame();
  if (exportSheetState.target === "dither-only" && !ditherAvailable) {
    exportSheetState.error = "Dither-only target requires a dither node in the graph.";
    renderExportSheet();
    return null;
  }

  const probeCanvas = buildStillExportCanvas();
  if (!probeCanvas?.width || !probeCanvas?.height) {
    exportSheetState.error = "Nothing is available to export for the selected target.";
    renderExportSheet();
    return null;
  }
  const width = probeCanvas.width;
  const height = probeCanvas.height;

  exportInFlight = true;
  exportAbortController = new AbortController();
  exportSheetState.error = "";
  exportSheetState.progress = createExportProgress("video", totalFrames, "preparing");
  renderExportSheet();
  syncExportActions(source);

  const signal = exportAbortController.signal;
  const startTime = getVideoStartTime(video.range);
  let writtenCount = 0;
  let failure = null;
  let sessionStarted = false;

  beginExportSession();
  try {
    updateExportProgress({ phase: "preparing" });
    renderExportSheet();
    await invoke("ffmpeg_start_encode", {
      config: {
        outputPath: exportSheetState.video.outputPath,
        width,
        height,
        fps,
        codec: video.codec,
        quality: video.crf,
        preset: video.preset,
      },
    });
    sessionStarted = true;
    updateExportProgress({ phase: "encoding" });
    renderExportSheet();

    for (let i = 0; i < totalFrames; i++) {
      if (signal.aborted) break;
      const t = Math.min(startTime + i / fps, startTime + rangeSeconds);
      const seekOk = await seekForExport(t);
      if (!seekOk) throw new Error(`Frame seek failed at ${t.toFixed(3)}s (frame ${i + 1}).`);
      if (signal.aborted) break;

      const canvas = buildStillExportCanvas();
      if (!canvas?.width || !canvas?.height) {
        throw new Error(`Frame ${i + 1} produced an empty canvas.`);
      }
      if (canvas.width !== width || canvas.height !== height) {
        throw new Error(`Frame ${i + 1} dimensions changed mid-encode.`);
      }
      const pixels = readCanvasRGBA(canvas);
      if (!pixels) throw new Error(`Frame ${i + 1} could not be read as RGBA.`);

      await invoke("ffmpeg_write_frame", { pixels });
      writtenCount += 1;
      updateExportProgress({ frame: writtenCount, phase: "encoding" });
      renderExportSheet();
    }

    if (!signal.aborted) {
      updateExportProgress({ phase: "finalizing" });
      renderExportSheet();
      const finishResult = await invoke("ffmpeg_finish_encode");
      sessionStarted = false;
      console.info("[export] ffmpeg finished", finishResult);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (sessionStarted) {
      try {
        await invoke("ffmpeg_cancel_encode");
      } catch (cancelError) {
        console.warn("[export] ffmpeg cancel failed", cancelError);
      }
    }
    endExportSession();
    const cancelled = signal.aborted;
    exportAbortController = null;
    exportInFlight = false;
    exportSheetState.progress = {
      active: false,
      frame: writtenCount,
      total: totalFrames,
      cancelled,
      kind: "video",
      phase: cancelled ? "cancelling" : "finalizing",
    };

    if (failure && !cancelled) {
      exportSheetState.error = failure.message || "Video export failed.";
    } else if (cancelled) {
      exportSheetState.error = `Cancelled after ${writtenCount} / ${totalFrames} frames.`;
    } else {
      exportSheetState.error = "";
    }

    syncExportActions(getState().source);
    if (exportSheetState.open) renderExportSheet();
    if (!failure && !cancelled && writtenCount === totalFrames) {
      closeExportSheet({ force: true });
    }
  }

  return writtenCount === totalFrames && !failure ? exportSheetState.video.outputPath : null;
}
