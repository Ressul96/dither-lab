import { getTimelineEasingPreset } from "../timeline.js";

export function createEasingPatch(easing) {
  if (easing === "step" || easing === "hold") {
    return { easing: { type: "step" }, interpolation: "hold", inTangent: null, outTangent: null };
  }

  const preset = getTimelineEasingPreset(easing === "custom-bezier" ? "smooth" : easing);
  const controlPoints = preset?.controlPoints ?? [0, 0, 1, 1];
  return {
    easing: { type: "bezier", controlPoints },
    interpolation: "linear",
    inTangent: null,
    outTangent: null,
  };
}
