import { registerAlgorithm } from "./registry.js";
import { ALGORITHMS as ERROR_DIFFUSION_ALGORITHMS } from "./error-diffusion.js";
import { ALGORITHMS as ORDERED_ALGORITHMS } from "./bayer.js";
import { ALGORITHMS as THRESHOLD_ALGORITHMS } from "./threshold.js";
import { ALGORITHMS as NOISE_ALGORITHMS } from "./noise.js";
import { ALGORITHMS as PATTERN_ALGORITHMS } from "./pattern.js";

const ALL = [
  ...ERROR_DIFFUSION_ALGORITHMS,
  ...ORDERED_ALGORITHMS,
  ...THRESHOLD_ALGORITHMS,
  ...NOISE_ALGORITHMS,
  ...PATTERN_ALGORITHMS,
];

for (const algo of ALL) {
  registerAlgorithm(algo);
}

export {
  getAlgorithm,
  listAlgorithms,
  runAlgorithm,
  getAlgorithmOptions,
  registerAlgorithm,
} from "./registry.js";
