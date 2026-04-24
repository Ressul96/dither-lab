import { getState, subscribe } from "./state.js";
import { getCurrentExportFrameCanvas, hasCurrentDitherFrame } from "./source.js";

const STILL_FORMATS = Object.freeze([
  { id: "png", label: "PNG", extension: "png", mime: "image/png", quality: undefined },
  { id: "jpeg", label: "JPEG", extension: "jpg", mime: "image/jpeg", quality: 0.92 },
]);

let exportInFlight = false;
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
      case "custom-width":
        exportSheetState.customWidth = clampDimension(target.value, exportSheetState.customWidth);
        break;
      case "custom-height":
        exportSheetState.customHeight = clampDimension(target.value, exportSheetState.customHeight);
        break;
      default:
        break;
    }

    exportSheetState.error = "";
    renderExportSheet();
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
  const stillDisabled = exportInFlight || (exportSheetState.target === "dither-only" && !ditherAvailable);
  const submitLabel =
    exportSheetState.mode === "still"
      ? `Export ${getStillFormat(exportSheetState.stillFormat).label}`
      : "Coming Soon";

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

      ${
        exportSheetState.mode === "still"
          ? renderStillExportFields(ditherAvailable)
          : renderComingSoonFields()
      }
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
        <button class="btn" type="button" data-export-action="close">Cancel</button>
        <button
          class="btn primary"
          type="button"
          data-export-action="submit"
          ${exportSheetState.mode !== "still" || stillDisabled ? "disabled" : ""}
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

    <div class="export-sheet__grid">
      <div class="field">
        <label>Resolution</label>
        <div class="dropdown">
          <select data-export-field="resolution-mode">
            <option value="source" ${exportSheetState.resolutionMode === "source" ? "selected" : ""}>Source</option>
            <option value="half" ${exportSheetState.resolutionMode === "half" ? "selected" : ""}>Half</option>
            <option value="custom" ${exportSheetState.resolutionMode === "custom" ? "selected" : ""}>Custom</option>
          </select>
        </div>
      </div>

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

function renderComingSoonFields() {
  return `
    <section class="export-sheet__placeholder">
      <p class="hint">
        This sheet scaffolds the upcoming export pipeline. Current-frame still export is wired now;
        video and sequence export land in the next implementation tick.
      </p>
      <div class="export-sheet__placeholder-grid">
        <div class="field">
          <label>Output Target</label>
          <div class="dropdown">
            <select disabled>
              <option>Viewer Output</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Range</label>
          <div class="dropdown">
            <select disabled>
              <option>Trimmed Range</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Resolution</label>
          <div class="dropdown">
            <select disabled>
              <option>Source</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>FPS</label>
          <div class="dropdown">
            <select disabled>
              <option>Source</option>
            </select>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderStatusText(ditherAvailable) {
  if (exportInFlight) return "Exporting current frame…";
  if (exportSheetState.mode !== "still") return "Video and sequence writers are scaffolded but not wired yet.";
  if (exportSheetState.target === "dither-only" && !ditherAvailable) {
    return "Dither-only export becomes available once the graph produces a dither output.";
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
  if (exportSheetState.mode !== "still" || exportInFlight) return null;

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
  context.drawImage(baseCanvas, 0, 0, width, height);
  return canvas;
}

function resolveStillSize(baseWidth = getState().source.videoWidth, baseHeight = getState().source.videoHeight) {
  switch (exportSheetState.resolutionMode) {
    case "half":
      return {
        width: Math.max(1, Math.round(baseWidth / 2)),
        height: Math.max(1, Math.round(baseHeight / 2)),
      };
    case "custom":
      return {
        width: clampDimension(exportSheetState.customWidth, baseWidth),
        height: clampDimension(exportSheetState.customHeight, baseHeight),
      };
    case "source":
    default:
      return { width: baseWidth, height: baseHeight };
  }
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
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) resolve(nextBlob);
      else reject(new Error("Canvas export returned an empty blob"));
    }, format.mime, format.quality);
  });

  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
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
    customWidth: 0,
    customHeight: 0,
    destinationPath: "",
    destinationChosen: false,
    error: "",
    lastSourceWidth: 0,
    lastSourceHeight: 0,
  };
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
