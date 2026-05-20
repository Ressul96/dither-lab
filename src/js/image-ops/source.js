// Source — composite node that wires together the four "always-on"
// adjustments the graph runtime applies right at the source node:
//
//   1. applyAdjustNode — exposure/gamma/brightness/contrast/saturation
//   2. applyHsvNode    — hue/saturation/value
//   3. applyRgbToBwNode (when bwMode != "off")
//   4. applyInvertNode  (when invert == "on")
//
// pushStep releases the previous intermediate canvas back to the
// buffer pool whenever the next step actually produces a new canvas
// (vs. an identity pass-through), so a long chain of identity ops
// doesn't accumulate orphan pool entries.

import { releaseBuffer } from "./buffer-pool.js";
import { applyAdjustNode } from "./adjust.js";
import { applyHsvNode } from "./hsv.js";
import { applyRgbToBwNode } from "./rgb-to-bw.js";
import { applyInvertNode } from "./geometry.js";

export function applySourceNode(input, params = {}) {
  if (!input?.width || !input?.height) return null;

  let output = input;
  const pushStep = (next) => {
    if (!next || next === output) return;
    if (output !== input) releaseBuffer(output);
    output = next;
  };

  pushStep(applyAdjustNode(output, params));
  pushStep(applyHsvNode(output, {
    hue: params.hue ?? 0,
    saturation: params.hsvSaturation ?? 100,
    value: params.value ?? 100,
  }));

  const bwMode = String(params.bwMode ?? "off");
  if (bwMode !== "off") {
    pushStep(applyRgbToBwNode(output, { mode: bwMode }));
  }

  const invert = String(params.invert ?? "off") === "on";
  if (invert) {
    pushStep(applyInvertNode(output, { channels: params.invertChannels ?? "rgb" }));
  }

  return output;
}
