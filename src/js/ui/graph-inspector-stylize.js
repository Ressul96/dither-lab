// Stylize node inspector renderers — Analog (VHS/CRT/combined),
// LED Screen, Modulation, Pixel Sorting, Depth of Field, the
// standalone VHS and CRT nodes, ASCII, and Halftone. All but
// Depth of Field are pure field stacks; Depth of Field reaches
// into the xy-pad module for its focus center pad.

import {
  renderRangeField,
  renderSelectField,
} from "./graph-inspector-fields.js";
import { renderXyPadField } from "./graph-xy-pad.js";

export function renderAnalogNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "vhs");
  const opacity = Number(params.opacity ?? 100);
  const brightness = Number(params.brightness ?? 110);
  const saturation = Number(params.saturation ?? 110);
  const chroma = Number(params.chroma ?? 6);
  const bleed = Number(params.bleed ?? 50);
  const noise = Number(params.noise ?? 35);
  const scanlines = Number(params.scanlines ?? 60);
  const tracking = Number(params.tracking ?? 35);
  const wave = Number(params.wave ?? 4);
  const curvature = Number(params.curvature ?? 25);
  const mask = String(params.mask ?? "aperture");
  const maskStrength = Number(params.maskStrength ?? 35);
  const glow = Number(params.glow ?? 25);
  const vignette = Number(params.vignette ?? 40);
  const rolling = Number(params.rolling ?? 0);
  const tapeResolution = Number(params.tapeResolution ?? 100);
  const jitter = Number(params.jitter ?? 0);
  const flicker = Number(params.flicker ?? 0);
  const dropouts = Number(params.dropouts ?? 0);
  const crease = Number(params.crease ?? 0);
  const showTape = mode === "vhs" || mode === "vhs-crt";
  const showTube = mode === "crt" || mode === "vhs-crt";
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["vhs", "VHS"],
        ["crt", "CRT"],
        ["vhs-crt", "VHS into CRT"],
      ])}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${showTube ? renderRangeField("Brightness", "brightness", brightness, 0, 300, `${brightness}%`) : ""}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    ${
      showTape
        ? `
          <section class="node-panel-section node-panel-section--titled">
            <header class="node-panel-section-title">Tape</header>
            ${renderRangeField("Chroma Shift", "chroma", chroma, 0, 32, `${chroma}px`)}
            ${renderRangeField("Color Bleed", "bleed", bleed, 0, 100, `${bleed}%`)}
            ${renderRangeField("Wave", "wave", wave, 0, 32, `${wave}px`)}
            ${renderRangeField("Tracking", "tracking", tracking, 0, 100, `${tracking}%`)}
            ${renderRangeField("Noise", "noise", noise, 0, 100, `${noise}%`)}
            ${renderRangeField("Tape Resolution", "tapeResolution", tapeResolution, 25, 200, `${tapeResolution}%`)}
            ${renderRangeField("Jitter", "jitter", jitter, 0, 100, `${jitter}%`)}
            ${renderRangeField("Flicker", "flicker", flicker, 0, 100, `${flicker}%`)}
            ${renderRangeField("Dropouts", "dropouts", dropouts, 0, 100, `${dropouts}%`)}
            ${renderRangeField("Crease", "crease", crease, 0, 100, `${crease}%`)}
          </section>
        `
        : ""
    }
    ${
      showTube
        ? `
          <section class="node-panel-section node-panel-section--titled">
            <header class="node-panel-section-title">Tube</header>
            ${renderRangeField("Curvature", "curvature", curvature, 0, 100, `${curvature}%`)}
            ${renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`)}
            ${renderRangeField("Glow", "glow", glow, 0, 100, `${glow}%`)}
            ${renderSelectField("Mask", "mask", mask, [
              ["none", "None"],
              ["aperture", "Aperture Grille"],
              ["slot", "Slot Mask"],
            ])}
            ${renderRangeField("Mask Strength", "maskStrength", maskStrength, 0, 100, `${maskStrength}%`)}
            ${renderRangeField("Rolling Bar", "rolling", rolling, 0, 100, `${rolling}%`)}
          </section>
        `
        : ""
    }
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Frame</header>
      ${!showTube ? renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`) : ""}
      ${renderRangeField("Vignette", "vignette", vignette, 0, 100, `${vignette}%`)}
    </section>
  `;
}

export function renderLedScreenNode(node) {
  const params = node.params;
  const cellSize = Number(params.cellSize ?? 6);
  const gap = Number(params.gap ?? 18);
  const subpixelMode = String(params.subpixelMode ?? "rgb");
  const shape = String(params.shape ?? "round");
  const softness = Number(params.softness ?? 35);
  const glow = Number(params.glow ?? 18);
  const brightness = Number(params.brightness ?? 110);
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section">
      ${renderRangeField("Cell Size", "cellSize", cellSize, 2, 48, `${cellSize}px`)}
      ${renderRangeField("Gap", "gap", gap, 0, 80, `${gap}%`)}
      ${renderSelectField("Subpixel", "subpixelMode", subpixelMode, [
        ["off", "Off"],
        ["rgb", "RGB"],
        ["bgr", "BGR"],
        ["triad", "Triad"],
      ])}
      ${renderSelectField("Shape", "shape", shape, [
        ["round", "Round"],
        ["square", "Square"],
        ["slot", "Slot"],
      ])}
      ${renderRangeField("Softness", "softness", softness, 0, 100, `${softness}%`)}
      ${renderRangeField("Glow", "glow", glow, 0, 100, `${glow}%`)}
      ${renderRangeField("Brightness", "brightness", brightness, 25, 300, `${brightness}%`)}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
  `;
}

export function renderModulationNode(node) {
  const params = node.params;
  const frequency = Number(params.frequency ?? 80);
  const sensitivity = Number(params.sensitivity ?? 35);
  const thickness = Number(params.thickness ?? 18);
  const angle = Number(params.angle ?? 0);
  const channelMode = String(params.channelMode ?? "rgb");
  const sourceMix = Number(params.sourceMix ?? 0);
  const invert = String(params.invert ?? "off");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Frequency", "frequency", frequency, 4, 320, String(frequency))}
      ${renderRangeField("Angle", "angle", angle, -180, 180, `${angle}deg`)}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Signal</header>
      ${renderSelectField("Channel", "channelMode", channelMode, [
        ["luma", "Luma"],
        ["rgb", "RGB"],
      ])}
      ${renderRangeField("Sensitivity", "sensitivity", sensitivity, 0, 200, `${sensitivity}%`)}
      ${renderRangeField("Thickness", "thickness", thickness, 1, 100, `${thickness}%`)}
      ${renderRangeField("Source Mix", "sourceMix", sourceMix, 0, 100, `${sourceMix}%`)}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
    </section>
  `;
}

export function renderPixelSortingNode(node) {
  const params = node.params;
  const mode = String(params.mode ?? "glitch");
  const threshold = Number(params.threshold ?? 50);
  const softness = Number(params.softness ?? 10);
  const angle = Number(params.angle ?? 0);
  const length = Number(params.length ?? 24);
  const iterations = Number(params.iterations ?? 8);
  const channel = String(params.channel ?? "luma");
  const direction = String(params.direction ?? "bright");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderSelectField("Mode", "mode", mode, [
        ["glitch", "Glitch Sort"],
      ])}
      ${renderRangeField("Angle", "angle", angle, -180, 180, `${angle}deg`)}
      ${renderRangeField("Length", "length", length, 1, 256, `${length}px`)}
      ${renderRangeField("Samples", "iterations", iterations, 1, 32, String(iterations))}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mask</header>
      ${renderRangeField("Threshold", "threshold", threshold, 0, 100, `${threshold}%`)}
      ${renderRangeField("Softness", "softness", softness, 0, 50, `${softness}%`)}
      ${renderSelectField("Channel", "channel", channel, [
        ["luma", "Luma"],
        ["r", "Red"],
        ["g", "Green"],
        ["b", "Blue"],
        ["max", "Max RGB"],
      ])}
      ${renderSelectField("Direction", "direction", direction, [
        ["bright", "Bright"],
        ["dark", "Dark"],
      ])}
    </section>
  `;
}

export function renderDepthOfFieldNode(node) {
  const params = node.params;
  const centerX = Number(params.centerX ?? 50);
  const centerY = Number(params.centerY ?? 50);
  const radius = Number(params.radius ?? 35);
  const falloff = Number(params.falloff ?? 25);
  const aspect = Number(params.aspect ?? 100);
  const rotation = Number(params.rotation ?? 0);
  const invert = String(params.invert ?? "off");
  const blur = Number(params.blur ?? 16);
  const samples = Number(params.samples ?? 32);
  const bokehShape = String(params.bokehShape ?? "round");
  const blades = Number(params.blades ?? 6);
  const anamorphic = Number(params.anamorphic ?? 100);
  const debug = String(params.debug ?? "off");
  const opacity = Number(params.opacity ?? 100);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Focus</header>
      ${renderXyPadField("Center", "centerX", "centerY", centerX, centerY, {
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      })}
      ${renderRangeField("Center X", "centerX", centerX, 0, 100, `${centerX}%`)}
      ${renderRangeField("Center Y", "centerY", centerY, 0, 100, `${centerY}%`)}
      ${renderRangeField("Radius", "radius", radius, 0, 100, `${radius}%`)}
      ${renderRangeField("Falloff", "falloff", falloff, 0, 100, `${falloff}%`)}
      ${renderRangeField("Aspect", "aspect", aspect, 25, 400, `${(aspect / 100).toFixed(2)}x`)}
      ${renderRangeField("Rotation", "rotation", rotation, -180, 180, `${rotation}deg`)}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Blur</header>
      ${renderRangeField("Blur", "blur", blur, 0, 80, `${blur}px`)}
      ${renderRangeField("Samples", "samples", samples, 8, 64, String(samples))}
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Bokeh</header>
      ${renderSelectField("Shape", "bokehShape", bokehShape, [
        ["round", "Round"],
        ["polygon", "Polygon"],
      ])}
      ${renderRangeField("Blades", "blades", blades, 3, 12, String(blades))}
      ${renderRangeField("Anamorphic", "anamorphic", anamorphic, 25, 400, `${(anamorphic / 100).toFixed(2)}x`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Debug</header>
      ${renderSelectField("Debug", "debug", debug, [
        ["off", "Off"],
        ["mask", "Mask"],
      ])}
    </section>
  `;
}

export function renderVhsNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const saturation = Number(params.saturation ?? 110);
  const chroma = Number(params.chroma ?? 6);
  const bleed = Number(params.bleed ?? 50);
  const noise = Number(params.noise ?? 35);
  const scanlines = Number(params.scanlines ?? 60);
  const tracking = Number(params.tracking ?? 35);
  const wave = Number(params.wave ?? 4);
  const vignette = Number(params.vignette ?? 40);
  const tapeResolution = Number(params.tapeResolution ?? 100);
  const jitter = Number(params.jitter ?? 0);
  const flicker = Number(params.flicker ?? 0);
  const dropouts = Number(params.dropouts ?? 0);
  const crease = Number(params.crease ?? 0);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tape</header>
      ${renderRangeField("Chroma Shift", "chroma", chroma, 0, 32, `${chroma}px`)}
      ${renderRangeField("Color Bleed", "bleed", bleed, 0, 100, `${bleed}%`)}
      ${renderRangeField("Wave", "wave", wave, 0, 32, `${wave}px`)}
      ${renderRangeField("Tracking", "tracking", tracking, 0, 100, `${tracking}%`)}
      ${renderRangeField("Tape Resolution", "tapeResolution", tapeResolution, 25, 200, `${tapeResolution}%`)}
      ${renderRangeField("Jitter", "jitter", jitter, 0, 100, `${jitter}%`)}
      ${renderRangeField("Flicker", "flicker", flicker, 0, 100, `${flicker}%`)}
      ${renderRangeField("Dropouts", "dropouts", dropouts, 0, 100, `${dropouts}%`)}
      ${renderRangeField("Crease", "crease", crease, 0, 100, `${crease}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tube</header>
      ${renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`)}
      ${renderRangeField("Noise", "noise", noise, 0, 100, `${noise}%`)}
      ${renderRangeField("Vignette", "vignette", vignette, 0, 100, `${vignette}%`)}
    </section>
  `;
}

export function renderCrtNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const brightness = Number(params.brightness ?? 110);
  const saturation = Number(params.saturation ?? 110);
  const curvature = Number(params.curvature ?? 25);
  const scanlines = Number(params.scanlines ?? 60);
  const glow = Number(params.glow ?? 25);
  const mask = String(params.mask ?? "aperture");
  const maskStrength = Number(params.maskStrength ?? 35);
  const vignette = Number(params.vignette ?? 35);
  const rolling = Number(params.rolling ?? 0);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Brightness", "brightness", brightness, 0, 300, `${brightness}%`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Tube</header>
      ${renderRangeField("Curvature", "curvature", curvature, 0, 100, `${curvature}%`)}
      ${renderRangeField("Scanlines", "scanlines", scanlines, 0, 100, `${scanlines}%`)}
      ${renderRangeField("Glow", "glow", glow, 0, 100, `${glow}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Mask</header>
      ${renderSelectField("Mode", "mask", mask, [
        ["none", "None"],
        ["aperture", "Aperture Grille"],
        ["slot", "Slot Mask"],
      ])}
      ${renderRangeField("Strength", "maskStrength", maskStrength, 0, 100, `${maskStrength}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Sync</header>
      ${renderRangeField("Vignette", "vignette", vignette, 0, 100, `${vignette}%`)}
      ${renderRangeField("Rolling Bar", "rolling", rolling, 0, 100, `${rolling}%`)}
    </section>
  `;
}

export function renderAsciiNode(node) {
  const params = node.params;
  const opacity = Number(params.opacity ?? 100);
  const cellSize = Number(params.cellSize ?? 8);
  const ramp = String(params.ramp ?? "standard");
  const invert = String(params.invert ?? "off");
  const colorMode = String(params.colorMode ?? "source");
  const signalBlack = Number(params.signalBlack ?? 0);
  const signalWhite = Number(params.signalWhite ?? 100);
  const signalGamma = Number(params.signalGamma ?? 100);
  const presenceThreshold = Number(params.presenceThreshold ?? 0);
  const presenceSoftness = Number(params.presenceSoftness ?? 0);
  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">ASCII</header>
      ${renderRangeField("Cell Size", "cellSize", cellSize, 4, 32, `${cellSize}px`)}
      ${renderSelectField("Ramp", "ramp", ramp, [
        ["standard", "Standard"],
        ["dense", "Dense"],
        ["blocks", "Blocks"],
        ["binary", "Binary"],
      ])}
      ${renderSelectField("Invert", "invert", invert, [
        ["off", "Off"],
        ["on", "On"],
      ])}
      ${renderSelectField("Color", "colorMode", colorMode, [
        ["source", "From Image"],
        ["mono", "Monochrome"],
      ])}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Signal</header>
      ${renderRangeField("Black Point", "signalBlack", signalBlack, 0, 100, `${signalBlack}%`)}
      ${renderRangeField("White Point", "signalWhite", signalWhite, 0, 100, `${signalWhite}%`)}
      ${renderRangeField("Gamma", "signalGamma", signalGamma, 10, 400, (signalGamma / 100).toFixed(2))}
      ${renderRangeField("Presence Threshold", "presenceThreshold", presenceThreshold, 0, 100, `${presenceThreshold}%`)}
      ${renderRangeField("Presence Softness", "presenceSoftness", presenceSoftness, 0, 100, `${presenceSoftness}%`)}
    </section>
  `;
}

export function renderHalftoneNode(node) {
  const params = node.params;
  // Migrate legacy projects: the early build called this `cellSize` and
  // accepted `mode = mono | color`. Fall back so existing keyframes/saved
  // projects still render their values into the new sliders.
  const spacing = Number(params.spacing ?? params.cellSize ?? 5);
  const angle = Number(params.angle ?? 15);
  const dotScale = Number(params.dotScale ?? 100);
  const opacity = Number(params.opacity ?? 100);
  const hue = Number(params.hue ?? 0);
  const saturation = Number(params.saturation ?? 100);
  const colorMode = String(params.colorMode ?? (params.mode === "color" ? "cmy" : params.mode ?? "cmyk"));
  const shape = String(params.shape ?? "circle");

  return `
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">General</header>
      ${renderRangeField("Opacity", "opacity", opacity, 0, 100, `${opacity}%`)}
      ${renderRangeField("Hue", "hue", hue, -180, 180, `${hue}deg`)}
      ${renderRangeField("Saturation", "saturation", saturation, 0, 200, `${saturation}%`)}
    </section>
    <section class="node-panel-section node-panel-section--titled">
      <header class="node-panel-section-title">Halftone</header>
      ${renderSelectField("Color Mode", "colorMode", colorMode, [
        ["mono", "Monochrome"],
        ["cmy", "CMY"],
        ["cmyk", "CMYK"],
      ])}
      ${renderSelectField("Shape", "shape", shape, [
        ["circle", "Circle"],
        ["square", "Square"],
        ["diamond", "Diamond"],
      ])}
      ${renderRangeField("Spacing", "spacing", spacing, 2, 64, `${spacing}px`)}
      ${renderRangeField("Angle", "angle", angle, -90, 90, `${angle}deg`)}
      ${renderRangeField("Dot Scale", "dotScale", dotScale, 10, 250, `${dotScale}%`)}
    </section>
  `;
}
