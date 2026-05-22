// Tiny WebGL2 fullscreen-quad runtime for shader-based effects.
// Each pass is just (fragmentSource, uniformBuilder) — applyShaderPass picks
// the registry entry, uploads the input texture, and copies the output back to
// a 2D canvas so the rest of the graph can stay agnostic about WebGL.

import { hexToRgb01 } from "./color.js";
import { buildGradientLut } from "./gl/gradient-lut.js";
import { createProcessingCanvas } from "./canvas.js";

const FULLSCREEN_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const MESH_GRADIENT_MAX_STOPS = 8;
const MESH_GRADIENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

const int MAX_STOPS = ${MESH_GRADIENT_MAX_STOPS};

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_complexity;
uniform float u_warp;
uniform float u_zoom;
uniform float u_stopCount;
uniform vec4 u_meshStops[MAX_STOPS];      // (x, y, radius, _)
uniform vec3 u_meshStopColors[MAX_STOPS];

in vec2 v_uv;
out vec4 out_color;

float wave(vec2 p, float f, float t) {
  return sin(p.x * f + t * 0.73) + cos(p.y * f * 1.19 - t * 0.51);
}

void main() {
  vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  vec2 centered = (v_uv - 0.5) * aspect / max(u_zoom, 0.001);
  float f = max(u_complexity, 0.5);
  float t = u_time;

  vec2 warpVec = vec2(
    wave(centered.yx + vec2(0.17, 0.31), f * 3.1, t),
    wave(centered.xy + vec2(0.43, 0.11), f * 2.7, t * 1.13)
  );
  vec2 uv = v_uv + warpVec * (0.035 + 0.055 * u_warp) * u_warp;

  // Each stop contributes a Gaussian-weighted colour by distance. Normalising
  // by total weight keeps the mix bounded — no individual stop can blow out
  // even if multiple radii overlap.
  vec3 acc = vec3(0.0);
  float totalW = 0.0;
  for (int i = 0; i < MAX_STOPS; i++) {
    if (float(i) >= u_stopCount) break;
    vec4 stop = u_meshStops[i];
    vec2 diff = uv - stop.xy;
    // Aspect-correct so a "radius" reads as a fraction of the short side
    // and the spot stays circular on landscape/portrait canvases.
    diff.x *= aspect.x;
    float dist = length(diff);
    float r = max(stop.z, 0.001);
    float w = exp(-(dist * dist) / (r * r));
    acc += u_meshStopColors[i] * w;
    totalW += w;
  }

  vec3 color = acc / max(totalW, 0.0001);
  out_color = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

const GRADIENT_SOURCE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_gradientLut;
uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_mode;      // 0 linear, 1 radial, 2 conic
uniform float u_angle;     // radians
uniform float u_radius;    // fraction of short side
uniform float u_repeat;
uniform float u_shift;

in vec2 v_uv;
out vec4 out_color;

const float TAU = 6.28318530718;

float gradientCoordinate(vec2 p) {
  vec2 delta = p - u_center;
  if (u_mode < 0.5) {
    vec2 dir = vec2(cos(u_angle), sin(u_angle));
    return 0.5 + dot(delta, dir);
  }
  if (u_mode < 1.5) {
    float shortSide = max(min(u_resolution.x, u_resolution.y), 1.0);
    vec2 aspect = vec2(u_resolution.x / shortSide, u_resolution.y / shortSide);
    return length(delta * aspect) / max(u_radius, 0.001);
  }
  return fract((atan(delta.y, delta.x) - u_angle) / TAU);
}

float repeatCoordinate(float t) {
  float raw = t * u_repeat + u_shift;
  if (abs(u_shift) < 0.00001 && abs(u_repeat - 1.0) < 0.00001) {
    return clamp(raw, 0.0, 1.0);
  }
  return fract(raw);
}

void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);
  float t = repeatCoordinate(gradientCoordinate(p));
  vec3 color = texture(u_gradientLut, vec2(t, 0.5)).rgb;
  out_color = vec4(color, 1.0);
}
`;

const CHROMATIC_ABERRATION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_strength;
uniform float u_angle;
uniform float u_radial;
uniform vec2 u_center;

in vec2 v_uv;
out vec4 out_color;

void main() {
  vec2 center_dir = v_uv - u_center;
  vec2 radial_dir = normalize(center_dir + vec2(0.00001));
  vec2 linear_dir = vec2(cos(u_angle), sin(u_angle));
  vec2 dir = normalize(mix(linear_dir, radial_dir, u_radial));
  vec2 offset = dir * u_strength / max(u_resolution, vec2(1.0));

  vec4 base = texture(u_image, v_uv);
  float r = texture(u_image, v_uv + offset).r;
  float b = texture(u_image, v_uv - offset).b;
  out_color = vec4(r, base.g, b, base.a);
}
`;

const LED_SCREEN_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_cellSize;
uniform float u_gap;
uniform float u_subpixelMode;
uniform float u_shape;
uniform float u_softness;
uniform float u_glow;
uniform float u_brightness;
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

float diodeMask(vec2 local, float shape, float activeArea, float softness, float cellSize) {
  vec2 centered = (local - 0.5) / max(activeArea * 0.5, 0.001);
  float edge;
  if (shape < 0.5) {
    edge = length(centered);
  } else if (shape < 1.5) {
    vec2 d = abs(centered);
    edge = max(d.x, d.y);
  } else {
    vec2 d = abs(vec2(centered.x, centered.y * 0.55));
    edge = max(d.x, d.y);
  }
  float aa = max(1.0 / max(cellSize, 1.0), 0.01);
  float soft = aa + softness * 0.32;
  return 1.0 - smoothstep(1.0 - soft, 1.0 + aa, edge);
}

vec3 subpixelColor(vec3 color, float band, float mode) {
  if (mode < 0.5) return color;
  if (mode < 1.5 || mode > 2.5) {
    if (band < 1.0) return vec3(color.r, 0.0, 0.0);
    if (band < 2.0) return vec3(0.0, color.g, 0.0);
    return vec3(0.0, 0.0, color.b);
  }
  if (band < 1.0) return vec3(0.0, 0.0, color.b);
  if (band < 2.0) return vec3(0.0, color.g, 0.0);
  return vec3(color.r, 0.0, 0.0);
}

void main() {
  vec2 pixel = v_uv * u_resolution;
  float cellSize = max(u_cellSize, 2.0);
  vec2 cell = floor(pixel / cellSize);
  vec2 local = fract(pixel / cellSize);
  vec2 centerUv = clamp((cell + 0.5) * cellSize / max(u_resolution, vec2(1.0)), 0.0, 1.0);

  vec3 src = texture(u_image, v_uv).rgb;
  vec3 cellColor = texture(u_image, centerUv).rgb * u_brightness;

  vec2 diodeLocal = local;
  float band = 0.0;
  if (u_subpixelMode > 0.5) {
    if (u_subpixelMode > 2.5) {
      float row = step(0.5, local.y);
      float triadX = local.x * 3.0 + row * 1.5;
      band = floor(mod(triadX, 3.0));
      diodeLocal = vec2(fract(triadX), fract(local.y * 2.0));
    } else {
      float subX = local.x * 3.0;
      band = floor(subX);
      diodeLocal = vec2(fract(subX), local.y);
    }
  }

  float activeArea = max(0.08, 1.0 - u_gap);
  float mask = diodeMask(diodeLocal, u_shape, activeArea, u_softness, cellSize);
  vec2 centered = (diodeLocal - 0.5) / max(activeArea * 0.5, 0.001);
  float glowFalloff = exp(-dot(centered, centered) * mix(5.5, 1.6, u_glow));
  float glowMask = glowFalloff * u_glow;

  vec3 emitted = subpixelColor(cellColor, band, u_subpixelMode);
  vec3 panel = emitted * mask + emitted * glowMask * 0.36;
  panel = clamp(panel, 0.0, 1.0);

  vec3 result = mix(src, panel, clamp(u_opacity, 0.0, 1.0));
  out_color = vec4(result, 1.0);
}
`;

const MODULATION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_frequency;
uniform float u_sensitivity;
uniform float u_thickness;
uniform float u_angle;
uniform float u_channelMode;
uniform float u_sourceMix;
uniform float u_invert;
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.28318530718;

float lineMask(float phase) {
  float wave = sin(phase) * 0.5 + 0.5;
  float threshold = 1.0 - clamp(u_thickness, 0.001, 1.0);
  float aa = max(fwidth(wave) * 1.5, 0.001);
  return smoothstep(threshold - aa, threshold + aa, wave);
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  vec2 dir = vec2(cos(u_angle), sin(u_angle));
  float t = dot(v_uv, dir);
  float base = t * u_frequency * TAU;

  vec3 signal;
  if (u_channelMode < 0.5) {
    float luma = dot(src, LUMA_W);
    signal = vec3(lineMask(base + luma * u_sensitivity));
  } else {
    signal = vec3(
      lineMask(base + src.r * u_sensitivity),
      lineMask(base + src.g * u_sensitivity),
      lineMask(base + src.b * u_sensitivity)
    );
  }

  if (u_invert > 0.5) signal = 1.0 - signal;
  vec3 mixed = mix(signal, src, clamp(u_sourceMix, 0.0, 1.0));
  vec3 result = mix(src, mixed, clamp(u_opacity, 0.0, 1.0));
  out_color = vec4(result, 1.0);
}
`;

const PIXEL_SORTING_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_threshold;
uniform float u_softness;
uniform float u_angle;
uniform float u_lengthPx;
uniform float u_iterations;
uniform float u_channel;
uniform float u_direction;
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

const int MAX_ITERATIONS = 32;
const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

float channelKey(vec3 color) {
  if (u_channel < 0.5) return dot(color, LUMA_W);
  if (u_channel < 1.5) return color.r;
  if (u_channel < 2.5) return color.g;
  if (u_channel < 3.5) return color.b;
  return max(max(color.r, color.g), color.b);
}

float thresholdMask(float key) {
  float low = max(u_threshold - u_softness, 0.0);
  float high = u_threshold + u_softness + 0.001;
  float bright = smoothstep(low, high, key);
  return u_direction < 0.5 ? bright : 1.0 - bright;
}

bool isBetter(float candidateKey, float bestKey) {
  return u_direction < 0.5 ? candidateKey > bestKey : candidateKey < bestKey;
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  float srcKey = channelKey(src);
  float mask = thresholdMask(srcKey);
  if (mask <= 0.001 || u_opacity <= 0.001) {
    out_color = vec4(src, 1.0);
    return;
  }

  vec2 dir = vec2(cos(u_angle), sin(u_angle));
  vec2 stepUv = dir * (u_lengthPx / max(u_iterations, 1.0)) / max(u_resolution, vec2(1.0));
  vec3 best = src;
  float bestKey = srcKey;
  float bestMask = mask;

  for (int i = 1; i <= MAX_ITERATIONS; i++) {
    if (float(i) > u_iterations) break;
    vec2 sampleUv = clamp(v_uv - stepUv * float(i), 0.0, 1.0);
    vec3 candidate = texture(u_image, sampleUv).rgb;
    float candidateKey = channelKey(candidate);
    float candidateMask = thresholdMask(candidateKey);
    if (candidateMask > 0.001 && isBetter(candidateKey, bestKey)) {
      best = candidate;
      bestKey = candidateKey;
      bestMask = candidateMask;
    }
  }

  float mixAmount = mask * bestMask * clamp(u_opacity, 0.0, 1.0);
  out_color = vec4(mix(src, best, mixAmount), 1.0);
}
`;

const HALFTONE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_spacing;     // cell size in pixels
uniform float u_angle;       // base plate rotation in radians
uniform float u_dotScale;    // 0.1 - 2.5 (multiplies dot radius)
uniform float u_shape;       // 0 circle, 1 square, 2 diamond
uniform float u_colorMode;   // 0 mono, 1 cmy, 2 cmyk
uniform float u_opacity;     // 0 - 1 mix between source and halftone
uniform float u_hue;         // pre-process hue shift in radians
uniform float u_saturation;  // pre-process saturation 0 - 2

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

float shapeMask(vec2 cellPos, float radius, float aa, float shape) {
  if (shape < 0.5) {
    return smoothstep(radius + aa, radius - aa, length(cellPos));
  } else if (shape < 1.5) {
    vec2 d = abs(cellPos);
    return smoothstep(radius + aa, radius - aa, max(d.x, d.y));
  }
  return smoothstep(radius + aa, radius - aa, abs(cellPos.x) + abs(cellPos.y));
}

float plateCoverage(vec2 uv, float plateAngle, float intensity) {
  float c = cos(plateAngle);
  float s = sin(plateAngle);
  vec2 pixel = uv * u_resolution;
  vec2 rotated = vec2(c * pixel.x - s * pixel.y, s * pixel.x + c * pixel.y);
  vec2 cell = rotated / max(u_spacing, 1.0);
  vec2 cellPos = fract(cell) - 0.5;
  float radius = clamp(intensity * 0.5 * u_dotScale, 0.0, 0.7);
  float aa = max(1.0 / max(u_spacing, 1.0), 0.04);
  return shapeMask(cellPos, radius, aa, u_shape);
}

vec3 hueShift(vec3 color, float hue) {
  // YIQ rotation — cheap, reasonably perceptual, and matches what Shader Lab
  // does inside its Hue / Saturation block before the halftone stage.
  const mat3 toYiq = mat3(
    0.299,  0.587,  0.114,
    0.596, -0.274, -0.322,
    0.211, -0.523,  0.312
  );
  const mat3 fromYiq = mat3(
    1.0,  0.956,  0.621,
    1.0, -0.272, -0.647,
    1.0, -1.106,  1.703
  );
  vec3 yiq = color * toYiq;
  float cs = cos(hue);
  float ss = sin(hue);
  vec2 rotated = mat2(cs, -ss, ss, cs) * yiq.yz;
  yiq.yz = rotated;
  return yiq * fromYiq;
}

void main() {
  vec3 base = texture(u_image, v_uv).rgb;
  base = hueShift(base, u_hue);
  float luma = dot(base, LUMA_W);
  base = clamp(mix(vec3(luma), base, u_saturation), 0.0, 1.0);

  vec3 result;
  if (u_colorMode < 0.5) {
    float intensity = 1.0 - dot(base, LUMA_W);
    float coverage = plateCoverage(v_uv, u_angle, intensity);
    result = vec3(1.0 - coverage);
  } else if (u_colorMode < 1.5) {
    // CMY: each plate inks where the corresponding channel is dark.
    float pc = plateCoverage(v_uv, u_angle + radians(15.0), 1.0 - base.r);
    float pm = plateCoverage(v_uv, u_angle + radians(75.0), 1.0 - base.g);
    float py = plateCoverage(v_uv, u_angle + radians(0.0),  1.0 - base.b);
    vec3 paper = vec3(1.0);
    vec3 col = paper;
    col = mix(col, vec3(0.0, 1.0, 1.0), pc); // cyan ink
    col = mix(col, vec3(1.0, 0.0, 1.0), pm); // magenta ink
    col = mix(col, vec3(1.0, 1.0, 0.0), py); // yellow ink
    result = col;
  } else {
    // CMYK: subtractive separation with K plate. Standard print angles.
    float k = 1.0 - max(max(base.r, base.g), base.b);
    float oneMinusK = max(1e-3, 1.0 - k);
    float c = (1.0 - base.r - k) / oneMinusK;
    float m = (1.0 - base.g - k) / oneMinusK;
    float y = (1.0 - base.b - k) / oneMinusK;
    float pc = plateCoverage(v_uv, u_angle + radians(15.0), c);
    float pm = plateCoverage(v_uv, u_angle + radians(75.0), m);
    float py = plateCoverage(v_uv, u_angle + radians(0.0),  y);
    float pk = plateCoverage(v_uv, u_angle + radians(45.0), k);
    vec3 col = vec3(1.0);
    col = mix(col, vec3(0.0, 1.0, 1.0), pc);
    col = mix(col, vec3(1.0, 0.0, 1.0), pm);
    col = mix(col, vec3(1.0, 1.0, 0.0), py);
    col = mix(col, vec3(0.0),           pk);
    result = col;
  }

  vec3 finalColor = mix(base, result, clamp(u_opacity, 0.0, 1.0));
  out_color = vec4(finalColor, 1.0);
}
`;

const VHS_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_opacity;
uniform float u_chroma;       // RGB shift in pixels
uniform float u_noise;        // 0-1 static intensity
uniform float u_scanlines;    // 0-1 scanline strength
uniform float u_tracking;     // 0-1 tracking-band strength
uniform float u_wave;         // horizontal jitter in pixels (low-freq wobble)
uniform float u_vignette;     // 0-1
uniform float u_saturation;   // 0-2 pre-process saturation
uniform float u_bleed;        // 0-1 chroma blur (Y/C separation)
// Tape realism (md §4 P2). All identity at the defaults so old projects
// look unchanged.
uniform float u_tapeResolution; // 25-200 (% of source horizontal resolution)
uniform float u_jitter;         // 0-1 high-frequency per-row x jitter
uniform float u_flicker;        // 0-1 frame brightness flutter
uniform float u_dropouts;       // 0-1 sparse white/black streaks
uniform float u_crease;         // 0-1 fixed horizontal band warp

in vec2 v_uv;
out vec4 out_color;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 sampleSoft(vec2 uv, float bleedPx) {
  // Cheap horizontal box blur on the chroma channels only — that's the
  // hallmark of VHS Y/C separation: luminance stays sharp, chroma smears
  // sideways across a few pixels.
  vec3 base = texture(u_image, uv).rgb;
  if (bleedPx <= 0.001) return base;
  float dx = bleedPx / u_resolution.x;
  vec3 a = texture(u_image, uv + vec2(dx, 0.0)).rgb;
  vec3 b = texture(u_image, uv - vec2(dx, 0.0)).rgb;
  vec3 c = texture(u_image, uv + vec2(2.0 * dx, 0.0)).rgb;
  vec3 d = texture(u_image, uv - vec2(2.0 * dx, 0.0)).rgb;
  vec3 blurred = (base + a + b + c + d) / 5.0;
  float lumaBase = dot(base, vec3(0.2126, 0.7152, 0.0722));
  float lumaBlur = dot(blurred, vec3(0.2126, 0.7152, 0.0722));
  vec3 chroma = blurred - vec3(lumaBlur);
  return vec3(lumaBase) + chroma;
}

void main() {
  vec2 uv = v_uv;

  // Horizontal jitter — sin-driven row offset
  float row = uv.y * u_resolution.y;
  float wave = sin(row * 0.42 + u_time * 4.7) * u_wave / max(u_resolution.x, 1.0);
  uv.x += wave;

  // Tracking bands scroll vertically
  float trackingY = fract(uv.y - u_time * 0.06);
  float trackingBand =
    smoothstep(0.0, 0.04, trackingY) - smoothstep(0.04, 0.10, trackingY);
  float trackingMask = trackingBand * u_tracking;
  uv.x += trackingMask * 0.006;

  // High-frequency per-row jitter — adds the "tape edge wobble" feel on top
  // of the low-freq wave. Time-quantised so preview/export agree.
  if (u_jitter > 0.001) {
    float jrow = floor(row);
    float jt = floor(u_time * 24.0);
    float jn = hash21(vec2(jrow, jt)) - 0.5;
    uv.x += jn * u_jitter * 0.012;
  }

  // Fixed horizontal creases — strong x distortion in two narrow bands.
  // Stays put on the screen rather than scrolling, so it reads as physical
  // tape damage instead of a moving glitch.
  if (u_crease > 0.001) {
    float c1 = smoothstep(0.005, 0.0, abs(v_uv.y - 0.32));
    float c2 = smoothstep(0.005, 0.0, abs(v_uv.y - 0.68));
    float creaseAmt = (c1 + c2) * u_crease;
    uv.x += creaseAmt * 0.025;
  }

  // Tape resolution — quantise the horizontal sample x. At identity (100)
  // we skip the snap; below that we collapse pixels into wider cells, which
  // gives the soft "low TVL" VHS look without touching vertical lines.
  if (u_tapeResolution < 99.5) {
    float cells = max(u_resolution.x * (u_tapeResolution / 100.0), 1.0);
    uv.x = (floor(uv.x * cells) + 0.5) / cells;
  }

  vec2 chromaPx = vec2(u_chroma / max(u_resolution.x, 1.0), 0.0);
  vec3 base = sampleSoft(uv, u_bleed * 4.0);
  float r = sampleSoft(uv + chromaPx, u_bleed * 4.0).r;
  float g = base.g;
  float b = sampleSoft(uv - chromaPx, u_bleed * 4.0).b;
  vec3 col = vec3(r, g, b);

  // Tracking lines lift brightness in their band
  col += trackingMask * 0.18;

  // Static / hiss noise
  float n = noise2(vec2(uv.x * 720.0, uv.y * 220.0 + u_time * 53.0));
  col += (n - 0.5) * 0.3 * u_noise;

  // Scanlines — soft horizontal lines at every pixel row
  float sl = sin(row * 3.14159) * 0.5 + 0.5;
  col *= mix(1.0, sl, u_scanlines * 0.45);

  // Saturation pre-process (matches the Shader Lab "General" block)
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, u_saturation);

  // Vignette darkens corners
  vec2 vp = uv - 0.5;
  float vignetteMask = smoothstep(0.85, 0.18, length(vp) * 1.45);
  col *= mix(1.0, vignetteMask, u_vignette);

  // Frame-locked brightness flutter — quantised time keeps it deterministic.
  if (u_flicker > 0.001) {
    float fseed = hash21(vec2(floor(u_time * 18.0), 0.0)) - 0.5;
    col *= 1.0 + fseed * u_flicker * 0.18;
  }

  // Sparse dropouts — each row independently has a small chance of flashing
  // bright or near-black for one tick. Probability scales with u_dropouts.
  if (u_dropouts > 0.001) {
    float drow = floor(uv.y * u_resolution.y);
    float dt = floor(u_time * 12.0);
    float dseed = hash21(vec2(drow, dt));
    if (dseed < u_dropouts * 0.04) {
      float bias = hash21(vec2(drow + 17.0, dt)) > 0.5 ? 1.0 : 0.05;
      col = mix(col, vec3(bias), 0.85);
    }
  }

  vec3 src = texture(u_image, v_uv).rgb;
  col = mix(src, clamp(col, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0));
  out_color = vec4(col, 1.0);
}
`;

const PIXELATE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_sizeX;
uniform float u_sizeY;
uniform float u_shape;       // 0 square, 1 circle
uniform float u_smoothing;   // 0-1 cell-edge softness
uniform float u_gridOpacity; // 0-1 cell-edge darkening (cosmetic only)
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

void main() {
  vec3 src = texture(u_image, v_uv).rgb;

  vec2 cellSize = vec2(max(u_sizeX, 1.0), max(u_sizeY, 1.0));
  vec2 pixel = v_uv * u_resolution;
  vec2 cell = floor(pixel / cellSize);
  vec2 cellCenter = (cell + 0.5) * cellSize / u_resolution;

  // Sample at cell center; the texture's LINEAR filter does the bilinear
  // 2x2 average for free. Not a true full-block mean (CPU node uses canvas
  // downscale for that), but visually the same at size >= 4 and runs at
  // GPU speed for live video.
  vec3 cellColor = texture(u_image, cellCenter).rgb;

  if (u_shape > 0.5) {
    // Circle: distance from cell center, fade-out at the cell radius.
    // Cells are ellipses when cellSize.x != cellSize.y, which is the
    // intended look for "rectangular dot pixels".
    vec2 cellLocal = (pixel - cell * cellSize) / cellSize - 0.5;
    float dist = length(cellLocal * 2.0); // [0, sqrt(2)] across cell diagonal
    float aa = max(u_smoothing * 0.6 + 0.05, 0.05);
    float mask = 1.0 - smoothstep(1.0 - aa, 1.0, dist);
    cellColor = mix(vec3(0.0), cellColor, mask);
  } else if (u_smoothing > 0.001) {
    // Square smoothing: dim the cell edges so the grid feels softer.
    vec2 cellLocal = (pixel - cell * cellSize) / cellSize;
    vec2 edge = min(cellLocal, 1.0 - cellLocal);
    float minEdge = min(edge.x, edge.y);
    float aa = u_smoothing * 0.5 + 0.001;
    float mask = smoothstep(0.0, aa, minEdge);
    cellColor = mix(cellColor * 0.6, cellColor, mask);
  }

  // Grid edge darkening — cosmetic only, never a real LCD/LED simulation
  // (that's led-screen's job). Square cells only — circle cells already
  // have transparent gaps so an additional grid would double-shade.
  if (u_gridOpacity > 0.001 && u_shape < 0.5) {
    vec2 cellLocal = (pixel - cell * cellSize) / cellSize;
    float edge = min(min(cellLocal.x, 1.0 - cellLocal.x),
                     min(cellLocal.y, 1.0 - cellLocal.y));
    float grid = 1.0 - smoothstep(0.0, 0.08, edge);
    cellColor = mix(cellColor, cellColor * 0.55, grid * u_gridOpacity);
  }

  out_color = vec4(mix(src, clamp(cellColor, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const POSTERIZE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform float u_stepsR;
uniform float u_stepsG;
uniform float u_stepsB;
uniform float u_gamma;       // 0 linear, 1 sRGB-aware
uniform float u_lumaMode;    // 0 RGB independent, 1 luma + chroma preserved
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }

void main() {
  vec3 src = texture(u_image, v_uv).rgb;

  // Optional sRGB roundtrip — same approach as Pattern Dither, the
  // perceptually-correct pipeline quantizes in linear-light space then
  // re-encodes back to display gamma.
  vec3 work = u_gamma > 0.5 ? toLinear(src) : src;
  vec3 result;

  if (u_lumaMode > 0.5) {
    // Luma mode: quantize the luminance, leave chroma offsets alone so
    // the dominant hue of every pixel survives. Uses the R-channel step
    // count as the canonical step count.
    float luma = dot(work, LUMA_W);
    float steps = max(u_stepsR, 2.0);
    float quantizedLuma = floor(luma * (steps - 1.0) + 0.5) / (steps - 1.0);
    vec3 chroma = work - vec3(luma);
    result = vec3(quantizedLuma) + chroma;
  } else {
    // RGB independent — each channel quantized to its own step count.
    vec3 levels = vec3(
      max(u_stepsR - 1.0, 1.0),
      max(u_stepsG - 1.0, 1.0),
      max(u_stepsB - 1.0, 1.0)
    );
    result = floor(clamp(work, 0.0, 1.0) * levels + 0.5) / levels;
  }

  vec3 finalColor = u_gamma > 0.5 ? toSrgb(clamp(result, 0.0, 1.0)) : result;
  out_color = vec4(mix(src, clamp(finalColor, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const GRADIENT_MAP_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform sampler2D u_gradientLut;
uniform float u_shift;       // -1..1, expressed as LUT-space offset
uniform float u_repeat;      // 1..20
uniform float u_mode;        // 0 luma, 1 red, 2 green, 3 blue
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

float sampleSignal(vec3 color, float mode) {
  if (mode < 0.5) return dot(color, LUMA_W);
  if (mode < 1.5) return color.r;
  if (mode < 2.5) return color.g;
  return color.b;
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  float signal = sampleSignal(src, u_mode);
  float raw = signal * max(u_repeat, 1.0) + u_shift;

  // Preserve the exact luma endpoint mapping for the default ramp:
  // black samples stop 0, white samples stop 1. Once repeat or shift is
  // active, wrap with fract() so the node behaves like a contour/scrolling LUT.
  float t = (abs(u_shift) < 0.00001 && abs(u_repeat - 1.0) < 0.00001)
    ? clamp(raw, 0.0, 1.0)
    : fract(raw);

  vec3 mapped = texture(u_gradientLut, vec2(t, 0.5)).rgb;
  out_color = vec4(mix(src, mapped, clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const THRESHOLD_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform float u_threshold;     // 0-1
uniform float u_softness;      // 0-0.5 knee half-width
uniform float u_channel;       // 0 luma, 1 R, 2 G, 3 B, 4 max
uniform float u_invert;        // 0 / 1
uniform float u_mode;          // 0 BW, 1 source-mask
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

float sampleChannel(vec3 c, float ch) {
  if (ch < 0.5) return dot(c, LUMA_W);
  if (ch < 1.5) return c.r;
  if (ch < 2.5) return c.g;
  if (ch < 3.5) return c.b;
  return max(max(c.r, c.g), c.b);
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  float value = sampleChannel(src, u_channel);

  float low = max(u_threshold - u_softness, 0.0);
  float high = u_threshold + u_softness + 0.001;
  float mask = smoothstep(low, high, value);
  if (u_invert > 0.5) mask = 1.0 - mask;

  vec3 result;
  if (u_mode < 0.5) {
    // BW: white where mask = 1, black where mask = 0.
    result = vec3(mask);
  } else {
    // Source-mask: keep source pixels where mask = 1, black elsewhere.
    result = src * mask;
  }

  out_color = vec4(mix(src, clamp(result, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const PATTERN_DITHER_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_opacity;
uniform float u_saturation;
uniform float u_pattern;     // 0 none, 1 bayer2, 2 bayer4, 3 bayer8, 4 blue, 5 white
uniform float u_scale;       // pixels per matrix cell (chunky dither)
uniform float u_strength;    // pattern bias multiplier
uniform float u_depth;       // bits per channel, 1-8
uniform float u_gamma;       // 0 linear, 1 sRGB-aware

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

// Hardcoded Bayer matrices in shader constant memory — much cheaper than
// uniform-array access on most GPUs and avoids any dynamic upload cost.
const float BAYER2[4] = float[4](0.0, 2.0, 3.0, 1.0);
const float BAYER4[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0
);
const float BAYER8[64] = float[64](
   0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
   3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

float patternBias(vec2 cellPos, float pattern) {
  // Returns a bias in [-0.5, 0.5] used as a sub-step jitter applied before
  // the channel quantizer. Each pattern keeps its own normalization so the
  // strength control behaves the same regardless of family.
  if (pattern < 0.5) return 0.0;
  if (pattern < 1.5) {
    int idx = int(mod(cellPos.y, 2.0)) * 2 + int(mod(cellPos.x, 2.0));
    return BAYER2[idx] / 4.0 - 0.5 + 0.5 / 4.0;
  }
  if (pattern < 2.5) {
    int idx = int(mod(cellPos.y, 4.0)) * 4 + int(mod(cellPos.x, 4.0));
    return BAYER4[idx] / 16.0 - 0.5 + 0.5 / 16.0;
  }
  if (pattern < 3.5) {
    int idx = int(mod(cellPos.y, 8.0)) * 8 + int(mod(cellPos.x, 8.0));
    return BAYER8[idx] / 64.0 - 0.5 + 0.5 / 64.0;
  }
  if (pattern < 4.5) {
    // Pseudo blue noise — golden-ratio low-discrepancy sequence (Roberts).
    // Cheap and visually close to true blue-noise for stochastic dither.
    float g = 1.32471795724474602596;
    float a1 = 1.0 / g;
    float a2 = 1.0 / (g * g);
    return fract(cellPos.x * a1 + cellPos.y * a2) - 0.5;
  }
  // White noise — classic sin-hash, still cheap and seedable per cell.
  return fract(sin(dot(cellPos, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

vec3 toLinear(vec3 c) {
  return pow(c, vec3(2.2));
}
vec3 toSrgb(vec3 c) {
  return pow(c, vec3(1.0 / 2.2));
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;

  // Saturation pre-process — applied in display-space before any gamma flip
  // so the user-facing slider keeps its perceptual meaning.
  float baseLuma = dot(src, LUMA_W);
  vec3 base = mix(vec3(baseLuma), src, u_saturation);

  // Optional sRGB → linear roundtrip for perceptually-correct quantization.
  vec3 work = u_gamma > 0.5 ? toLinear(base) : base;

  // Pattern bias — coarsened to scale-pixel cells, then shifted into the
  // channel quantization step so its visual weight stays constant whatever
  // depth the user picks. (Without the step scaling, low depths look
  // banded and high depths look noiseless.)
  vec2 cellPos = floor(v_uv * u_resolution / max(u_scale, 1.0));
  float bias = patternBias(cellPos, u_pattern);

  float levels = pow(2.0, max(u_depth, 1.0)) - 1.0;
  float step = 1.0 / levels;
  vec3 jittered = work + vec3(bias * step * u_strength);
  vec3 quantized = floor(clamp(jittered, 0.0, 1.0) * levels + 0.5) / levels;

  vec3 result = u_gamma > 0.5 ? toSrgb(quantized) : quantized;

  out_color = vec4(mix(src, clamp(result, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const ASCII_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform sampler2D u_atlas;
uniform vec2 u_resolution;
uniform float u_cellSize;
uniform float u_atlasCount;
uniform float u_opacity;
uniform float u_invert;
uniform float u_useImageColor;
uniform vec3 u_fg;
uniform vec3 u_bg;

// Signal shaping (md §2 P1) — applied AFTER invert, BEFORE glyph pick.
// Defaults (signalBlack=0, signalWhite=1, signalGamma=1, presence*=0)
// make this a no-op so old projects look identical.
uniform float u_signalBlack;       // 0..1
uniform float u_signalWhite;       // 0..1
uniform float u_signalGamma;       // 0.1..4
uniform float u_presenceThreshold; // 0..1
uniform float u_presenceSoftness;  // 0..1

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

void main() {
  // Snap each output pixel to its containing cell on the ASCII grid.
  // Cell size is in pixels of the input resolution.
  vec2 pixel = v_uv * u_resolution;
  vec2 cellPx = floor(pixel / u_cellSize) * u_cellSize;
  vec2 cellCenter = (cellPx + u_cellSize * 0.5) / u_resolution;

  vec3 src = texture(u_image, cellCenter).rgb;
  float luma = dot(src, LUMA_W);
  if (u_invert > 0.5) luma = 1.0 - luma;

  // Stretch luma into [signalBlack, signalWhite], then power by 1/gamma.
  float range = max(u_signalWhite - u_signalBlack, 0.001);
  float shaped = pow(
    clamp((luma - u_signalBlack) / range, 0.0, 1.0),
    1.0 / max(u_signalGamma, 0.0001)
  );

  // Pick glyph index from the shaped signal.
  float glyphIdx = floor(clamp(shaped, 0.0, 0.99999) * u_atlasCount);

  // UV within this cell, in [0, 1]. The glyph atlas is laid out as a single
  // row of square glyphs, so we just shift x by the glyph index and divide
  // by the total count.
  vec2 cellUv = (pixel - cellPx) / u_cellSize;
  vec2 atlasUv = vec2((glyphIdx + cellUv.x) / u_atlasCount, cellUv.y);
  float coverage = texture(u_atlas, atlasUv).r;

  // Presence cull — when the user enables a threshold, fade out cells whose
  // shaped signal sits below the soft floor (so dark areas can stay empty).
  // smoothstep(a, b, x) is undefined when a == b, so guard with a small
  // epsilon and short-circuit the no-op default (both presence params 0).
  if (u_presenceThreshold > 0.0001 || u_presenceSoftness > 0.0001) {
    float lo = u_presenceThreshold - u_presenceSoftness;
    float hi = u_presenceThreshold + u_presenceSoftness;
    if (hi - lo < 1e-4) hi = lo + 1e-4;
    float presence = smoothstep(lo, hi, shaped);
    coverage *= presence;
  }

  vec3 fg = u_useImageColor > 0.5 ? src : u_fg;
  vec3 col = mix(u_bg, fg, coverage);

  vec3 srcOrig = texture(u_image, v_uv).rgb;
  out_color = vec4(mix(srcOrig, col, clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const HALATION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_opacity;
uniform float u_threshold;
uniform float u_knee;
uniform float u_intensity;
uniform float u_radius;
uniform float u_saturation;
uniform vec3 u_tint;
uniform float u_taps;  // 24..96, scales with radius (set by uniform builder)

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
const int MAX_TAPS = 96;
const float GOLDEN = 2.39996323;
const float TAU = 6.28318530718;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  float baseLuma = dot(src, LUMA_W);
  vec3 base = mix(vec3(baseLuma), src, u_saturation);

  if (u_intensity <= 0.0001 || u_radius <= 0.0001) {
    out_color = vec4(mix(src, base, clamp(u_opacity, 0.0, 1.0)), 1.0);
    return;
  }

  vec2 px = vec2(u_radius) / max(u_resolution, vec2(1.0));
  float halo = 0.0;
  float weight = 0.0;

  float threshLow = max(u_threshold - u_knee, 0.0);
  float threshHigh = u_threshold + u_knee + 0.001;

  float taps = clamp(u_taps, 4.0, float(MAX_TAPS));
  float jitterAngle = hash21(v_uv * u_resolution) * TAU;

  // Same adaptive disk + per-pixel jitter as Bloom (see the longer note
  // there). Halation accumulates brightness only — the tint colour is
  // applied below to the monochrome halo.
  for (int i = 0; i < MAX_TAPS; i++) {
    if (float(i) >= taps) break;
    float fi = float(i);
    float angle = fi * GOLDEN + jitterAngle;
    float r = sqrt((fi + 0.5) / taps);
    vec2 offs = vec2(cos(angle), sin(angle)) * r;
    vec3 tap = texture(u_image, v_uv + offs * px).rgb;
    float lum = dot(tap, LUMA_W);
    float bright = smoothstep(threshLow, threshHigh, lum);
    float w = 1.0 - r;
    halo += bright * w;
    weight += w;
  }

  halo /= max(weight, 0.0001);
  vec3 tinted = vec3(halo) * u_tint;
  vec3 lit = base + tinted * u_intensity;
  out_color = vec4(mix(src, clamp(lit, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const BLOOM_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_opacity;
uniform float u_threshold;   // 0-1 luminance cutoff
uniform float u_knee;        // 0-0.5 soft transition width
uniform float u_intensity;   // 0-4 bloom multiplier
uniform float u_radius;      // pixels
uniform float u_saturation;  // 0-2 pre-process
uniform float u_taps;        // 24..96, scales with radius (set by uniform builder)

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
const int MAX_TAPS = 96;
// Golden ratio in radians (137.5°). Picks an "incommensurate" angle so
// successive samples in the spiral never line up — spreads tap energy
// uniformly across the disk and avoids visible banding from regular grids.
const float GOLDEN = 2.39996323;
const float TAU = 6.28318530718;

// Cheap hash for per-pixel angle jitter. Without it, neighbouring pixels
// share the same spiral pattern and the discrete sample positions show up
// as visible rings around bright clusters at large radii.
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;

  // Saturation pre-process — applied to the base layer that gets the bloom
  // additively mixed back in below.
  float baseLuma = dot(src, LUMA_W);
  vec3 base = mix(vec3(baseLuma), src, u_saturation);

  if (u_intensity <= 0.0001 || u_radius <= 0.0001) {
    // No bloom, just opacity-mix the saturation pre-pass back in.
    out_color = vec4(mix(src, base, clamp(u_opacity, 0.0, 1.0)), 1.0);
    return;
  }

  vec2 px = vec2(u_radius) / max(u_resolution, vec2(1.0));
  vec3 bloom = vec3(0.0);
  float weight = 0.0;

  // Soft-threshold bounds — a non-zero spread avoids smoothstep(t, t, x)
  // edge cases where t-knee == t+knee.
  float threshLow = max(u_threshold - u_knee, 0.0);
  float threshHigh = u_threshold + u_knee + 0.001;

  float taps = clamp(u_taps, 4.0, float(MAX_TAPS));
  float jitterAngle = hash21(v_uv * u_resolution) * TAU;

  // Golden-spiral sampling across the unit disk; closer taps weigh more so
  // the bloom feels like a proper Gaussian even though we're doing it in a
  // single pass. Adaptive tap count keeps the sample density roughly
  // constant as the radius grows — large-radius blooms got a halftone-style
  // ring pattern at the fixed 24-tap budget. The per-pixel jitter rotates
  // the whole spiral, decorrelating neighbouring pixels.
  for (int i = 0; i < MAX_TAPS; i++) {
    if (float(i) >= taps) break;
    float fi = float(i);
    float angle = fi * GOLDEN + jitterAngle;
    float r = sqrt((fi + 0.5) / taps);
    vec2 offs = vec2(cos(angle), sin(angle)) * r;
    vec3 tap = texture(u_image, v_uv + offs * px).rgb;
    float lum = dot(tap, LUMA_W);
    float bright = smoothstep(threshLow, threshHigh, lum);
    float w = 1.0 - r;
    bloom += tap * bright * w;
    weight += w;
  }

  bloom /= max(weight, 0.0001);

  vec3 lit = base + bloom * u_intensity;
  out_color = vec4(mix(src, clamp(lit, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

const STAR_GLOW_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_threshold;  // 0-1 luminance cutoff
uniform float u_knee;       // 0-0.5 soft transition width
uniform float u_intensity;  // 0-4 streak multiplier
uniform float u_saturation; // 0-2 highlight saturation pre-process
uniform float u_streaks;    // 1-8 star axes
uniform float u_angle;      // radians
uniform float u_lengthPx;   // pixels
uniform float u_falloff;    // 0.05-1, higher means longer tails
uniform float u_alternate;  // secondary-axis strength
uniform float u_colorize;   // lightweight spectral tint amount

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
const int MAX_STREAKS = 8;
const int STAR_TAPS = 8;

float highlightMask(vec3 color) {
  float lum = dot(color, LUMA_W);
  float threshLow = max(u_threshold - u_knee, 0.0);
  float threshHigh = u_threshold + u_knee + 0.001;
  return smoothstep(threshLow, threshHigh, lum);
}

vec3 saturateHighlight(vec3 color) {
  float lum = dot(color, LUMA_W);
  return mix(vec3(lum), color, u_saturation);
}

vec3 starTint(float t, float axisNorm) {
  float phase = t * 0.55 + axisNorm * 0.18;
  return 0.72 + 0.28 * cos(TAU * (vec3(0.0, 0.33, 0.67) + phase));
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  if (u_intensity <= 0.0001 || u_lengthPx <= 0.0001) {
    out_color = vec4(src, 1.0);
    return;
  }

  vec2 invResolution = 1.0 / max(u_resolution, vec2(1.0));
  float axisCount = max(u_streaks, 1.0);
  vec3 glow = vec3(0.0);

  for (int axis = 0; axis < MAX_STREAKS; axis++) {
    float axisIndex = float(axis);
    if (axisIndex >= u_streaks) break;

    float axisNorm = axisIndex / max(axisCount - 1.0, 1.0);
    float angle = u_angle + axisIndex * PI / axisCount;
    vec2 dir = vec2(cos(angle), sin(angle));
    float secondary = mix(1.0, u_alternate, step(0.5, mod(axisIndex, 2.0)));

    for (int tapIndex = 1; tapIndex <= STAR_TAPS; tapIndex++) {
      float tap = float(tapIndex) / float(STAR_TAPS);
      float distancePx = tap * u_lengthPx;
      float tail = pow(1.0 - tap, mix(6.0, 1.15, u_falloff)) * secondary;
      vec2 offset = dir * distancePx * invResolution;

      vec3 positive = saturateHighlight(texture(u_image, v_uv + offset).rgb);
      vec3 negative = saturateHighlight(texture(u_image, v_uv - offset).rgb);
      float positiveMask = highlightMask(positive);
      float negativeMask = highlightMask(negative);
      vec3 tint = starTint(tap, axisNorm);
      positive = mix(positive, positive * tint * 1.35, u_colorize);
      negative = mix(negative, negative * tint * 1.35, u_colorize);

      glow += positive * positiveMask * tail;
      glow += negative * negativeMask * tail;
    }
  }

  glow /= max(axisCount * 1.35, 1.0);
  vec3 lit = src + glow * u_intensity;
  out_color = vec4(clamp(lit, 0.0, 1.0), 1.0);
}
`;

const DEPTH_OF_FIELD_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_opacity;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_falloff;
uniform float u_aspect;
uniform float u_rotation;
uniform float u_invert;
uniform float u_blurPx;
uniform float u_samples;
uniform float u_bokehShape;
uniform float u_blades;
uniform float u_anamorphic;
uniform float u_debug;

in vec2 v_uv;
out vec4 out_color;

const float TAU = 6.283185307179586;
const float GOLDEN = 2.39996323;
const int MAX_DOF_SAMPLES = 64;

vec2 rotate2(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

float focusMask(vec2 uv) {
  vec2 p = uv - u_center;
  p.x *= u_resolution.x / max(u_resolution.y, 1.0);
  p = rotate2(p, -u_rotation);
  p.x /= max(u_aspect, 0.001);
  float dist = length(p);
  float feather = max(u_falloff, 0.001);
  float mask = smoothstep(u_radius, u_radius + feather, dist);
  return mix(mask, 1.0 - mask, u_invert);
}

float polygonWeight(vec2 p) {
  if (u_bokehShape < 0.5) return 1.0;
  float blades = max(u_blades, 3.0);
  float sector = TAU / blades;
  float angle = atan(p.y, p.x) + sector * 0.5;
  float local = mod(angle + TAU, sector) - sector * 0.5;
  float edge = cos(sector * 0.5) / max(cos(local), 0.05);
  float r = length(p);
  return 1.0 - smoothstep(edge - 0.03, edge + 0.03, r);
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  float mask = focusMask(v_uv);

  if (u_debug > 0.5) {
    out_color = vec4(vec3(mask), 1.0);
    return;
  }

  float blurRadius = u_blurPx * mask;
  if (blurRadius <= 0.01 || u_opacity <= 0.0001 || mask <= 0.0001) {
    out_color = vec4(src, 1.0);
    return;
  }

  vec2 invResolution = 1.0 / max(u_resolution, vec2(1.0));
  float sampleCount = max(u_samples, 1.0);
  vec3 blurred = vec3(0.0);
  float weightSum = 0.0;

  for (int i = 0; i < MAX_DOF_SAMPLES; i++) {
    float fi = float(i);
    if (fi >= u_samples) break;

    float r = sqrt((fi + 0.5) / sampleCount);
    float angle = fi * GOLDEN;
    vec2 disk = vec2(cos(angle), sin(angle)) * r;
    float weight = polygonWeight(disk);
    if (weight <= 0.0001) continue;

    vec2 aperture = vec2(disk.x * u_anamorphic, disk.y / max(u_anamorphic, 0.001));
    aperture = rotate2(aperture, u_rotation);
    vec2 sampleUv = v_uv + aperture * blurRadius * invResolution;
    blurred += texture(u_image, sampleUv).rgb * weight;
    weightSum += weight;
  }

  blurred /= max(weightSum, 0.0001);
  float blend = clamp(mask * u_opacity, 0.0, 1.0);
  out_color = vec4(mix(src, blurred, blend), 1.0);
}
`;

const CRT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_opacity;
uniform float u_brightness;
uniform float u_saturation;
uniform float u_curvature;     // 0-1 barrel distortion
uniform float u_scanlines;     // 0-1
uniform float u_mask;          // 0 none, 1 aperture, 2 slot
uniform float u_maskStrength;  // 0-1
uniform float u_glow;          // 0-1
uniform float u_vignette;      // 0-1
uniform float u_rolling;       // 0-1 rolling sync band

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);

vec2 curveUv(vec2 uv, float strength) {
  // Center origin, distort outward by squared distance — classic CRT bulge.
  vec2 c = uv * 2.0 - 1.0;
  vec2 offset = c.yx * c.yx * strength * 0.18;
  c += c * offset;
  return c * 0.5 + 0.5;
}

vec3 tapBlur(vec2 uv, float radiusPx) {
  vec2 px = vec2(radiusPx) / max(u_resolution, vec2(1.0));
  vec3 c = texture(u_image, uv).rgb;
  c += texture(u_image, uv + vec2(px.x, 0.0)).rgb;
  c += texture(u_image, uv - vec2(px.x, 0.0)).rgb;
  c += texture(u_image, uv + vec2(0.0, px.y)).rgb;
  c += texture(u_image, uv - vec2(0.0, px.y)).rgb;
  return c / 5.0;
}

vec3 applyMask(vec3 col, vec2 uv, float maskMode, float strength) {
  if (strength <= 0.001 || maskMode < 0.5) return col;
  float x = uv.x * u_resolution.x;
  vec3 tint = vec3(1.0);
  float phase;
  if (maskMode < 1.5) {
    // Aperture grille: vertical R G B stripes per pixel triad.
    phase = mod(x, 3.0);
  } else {
    // Slot mask: every other scan row offsets the triad.
    float y = uv.y * u_resolution.y;
    float rowOffset = mod(floor(y), 2.0) * 1.5;
    phase = mod(x + rowOffset, 3.0);
  }
  if (phase < 1.0) tint = vec3(1.25, 0.85, 0.85);
  else if (phase < 2.0) tint = vec3(0.85, 1.25, 0.85);
  else tint = vec3(0.85, 0.85, 1.25);
  return mix(col, col * tint, strength);
}

void main() {
  vec2 srcUv = v_uv;
  vec2 uv = curveUv(srcUv, u_curvature);

  // Outside the curved screen reads as black bezel.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    out_color = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 base = texture(u_image, uv).rgb;

  // Glow: cheap 5-tap blur added back as bloom-ish lift.
  if (u_glow > 0.001) {
    vec3 blurred = tapBlur(uv, 1.5 + u_glow * 4.0);
    base += blurred * u_glow * 0.6;
  }

  base *= u_brightness;

  float luma = dot(base, LUMA_W);
  base = mix(vec3(luma), base, u_saturation);

  base = applyMask(base, uv, u_mask, u_maskStrength);

  // Scanlines — soft horizontal lines at every pixel row.
  float row = uv.y * u_resolution.y;
  float sl = sin(row * 3.14159) * 0.5 + 0.5;
  base *= mix(1.0, sl, u_scanlines * 0.65);

  // Rolling sync band — slow vertical scroll, only when enabled.
  if (u_rolling > 0.001) {
    float rollY = fract(uv.y - u_time * 0.08);
    float band = smoothstep(0.0, 0.05, rollY) - smoothstep(0.05, 0.18, rollY);
    base += band * u_rolling * 0.22;
  }

  // Vignette darkens edges of the curved tube.
  vec2 vp = uv - 0.5;
  float vmask = smoothstep(0.85, 0.18, length(vp) * 1.45);
  base *= mix(1.0, vmask, u_vignette);

  vec3 src = texture(u_image, srcUv).rgb;
  base = mix(src, clamp(base, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0));
  out_color = vec4(base, 1.0);
}
`;

// Glyph ramp presets — dark→bright. Picked one character per "luminance
// bucket" via floor(luma * count) in the ASCII shader, so the order matters.
const ASCII_RAMPS = Object.freeze({
  standard: " .:-=+*#%@",
  dense: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  blocks: " ░▒▓█",
  binary: " #",
});

const ASCII_ATLAS_CACHE = new Map();

function getAsciiRamp(value) {
  const key = String(value ?? "standard").toLowerCase();
  return ASCII_RAMPS[key] ?? ASCII_RAMPS.standard;
}

function getAsciiAtlas(ramp, glyphSize) {
  const key = `${ramp}|${glyphSize}`;
  let atlas = ASCII_ATLAS_CACHE.get(key);
  if (atlas) return atlas;
  atlas = buildAsciiAtlas(ramp, glyphSize);
  ASCII_ATLAS_CACHE.set(key, atlas);
  return atlas;
}

function buildAsciiAtlas(ramp, glyphSize) {
  // Worker scopes still bail here — font availability + text rasterisation
  // aren't guaranteed inside a Worker (spec §Faz 3 open decision). When the
  // worker adapter lands the atlas will be built on the main thread and
  // shipped as an ImageBitmap; until then, ASCII renders main-thread only.
  if (typeof document === "undefined") return null;
  const size = Math.max(8, Math.round(glyphSize));
  const canvas = createProcessingCanvas(ramp.length * size, size);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.floor(size * 0.85)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (let i = 0; i < ramp.length; i++) {
    ctx.fillText(ramp[i], i * size + size / 2, size / 2);
  }
  return canvas;
}

function gradientMapStops(params) {
  if (Array.isArray(params?.stops) && params.stops.length > 0) {
    return params.stops;
  }
  return [
    { pos: 0, color: params?.shadowColor ?? "#111111" },
    { pos: 1, color: params?.highlightColor ?? "#ffffff" },
  ];
}

function gradientLutTextureSource(params) {
  const lut = buildGradientLut(gradientMapStops(params));
  if (lut.canvas) return lut.canvas;
  if (typeof ImageData !== "undefined") {
    return new ImageData(new Uint8ClampedArray(lut.data), lut.width, 1);
  }
  return null;
}

function meshGradientSize(params) {
  return {
    width: clamp(Math.round(Number(params?.width ?? 1920)), 256, 4096),
    height: clamp(Math.round(Number(params?.height ?? 1080)), 256, 4096),
  };
}

function meshGradientUniforms(params, context) {
  const timelineTime = Number(context?.timeSeconds);
  const time = Number.isFinite(timelineTime) ? timelineTime : 0;
  const speed = clamp(Number(params?.speed ?? 25) / 25, 0, 4);
  const rawStops = Array.isArray(params?.stops) ? params.stops : [];
  const stops = rawStops.slice(0, MESH_GRADIENT_MAX_STOPS);
  const posRadius = new Float32Array(MESH_GRADIENT_MAX_STOPS * 4);
  const colors = new Float32Array(MESH_GRADIENT_MAX_STOPS * 3);
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i] ?? {};
    posRadius[i * 4 + 0] = clamp(Number(s.x ?? 0.5), -0.5, 1.5);
    // Flip y so param y=0 reads as "top of image" (intuitive in inspector
    // and matches the gizmo's screen-space drag direction).
    posRadius[i * 4 + 1] = 1 - clamp(Number(s.y ?? 0.5), -0.5, 1.5);
    posRadius[i * 4 + 2] = Math.max(0.01, Math.min(2, Number(s.radius ?? 0.6)));
    posRadius[i * 4 + 3] = 0;
    const rgb = hexToRgb01(s.color ?? "#ffffff", [1, 1, 1]);
    colors[i * 3 + 0] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  return {
    u_time: time * speed,
    u_complexity: 0.5 + clamp(Number(params?.complexity ?? 50) / 100, 0, 1) * 5.5,
    u_warp: clamp(Number(params?.warp ?? 35) / 100, 0, 1),
    u_zoom: clamp(Number(params?.zoom ?? 100) / 100, 0.25, 4),
    u_stopCount: stops.length,
    u_meshStops: { type: "vec4[]", data: posRadius },
    u_meshStopColors: { type: "vec3[]", data: colors },
  };
}

function gradientSourceSize(params) {
  return {
    width: clamp(Math.round(Number(params?.width ?? 1920)), 256, 4096),
    height: clamp(Math.round(Number(params?.height ?? 1080)), 256, 4096),
  };
}

function gradientSourceUniforms(params) {
  return {
    u_center: [
      clamp(Number(params?.centerX ?? 50) / 100, 0, 1),
      clamp(Number(params?.centerY ?? 50) / 100, 0, 1),
    ],
    u_mode: gradientSourceModeIndex(params?.mode ?? "linear"),
    u_angle: (Number(params?.angle ?? 0) / 180) * Math.PI,
    u_radius: clamp(Number(params?.radius ?? 75) / 100, 0.01, 2),
    u_repeat: clamp(Number(params?.repeat ?? 1), 1, 20),
    u_shift: clamp(Number(params?.shift ?? 0) / 100, -1, 1),
  };
}

function gradientSourceModeIndex(value) {
  const mode = String(value ?? "linear").toLowerCase();
  if (mode === "radial") return 1;
  if (mode === "conic") return 2;
  return 0;
}

// F18.2 procedural noise source. Perlin / simplex are Ashima / Ian McEwan
// implementations (well-trodden, license-clean); value noise is a simple
// hash-based bilinear interpolation. FBM stacks octaves so users get
// turbulence / clouds with a single slider.
const NOISE_SOURCE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_seed;
uniform float u_mode;        // 0 perlin, 1 simplex, 2 value
uniform float u_octaves;
uniform float u_persistence;
uniform float u_time;
uniform float u_animSpeed;

in vec2 v_uv;
out vec4 out_color;

vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }
vec3 permute3(vec3 x) { return mod289v3(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade2(vec2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float perlinNoise2D(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0, 0.0, 1.0, 1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0, 0.0, 1.0, 1.0);
  Pi = mod289v4(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute4(permute4(ix) + iy);
  vec4 gx = 2.0 * fract(i / 41.0) - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt4(vec4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11)));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 f = fade2(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), f.x);
  return 2.3 * mix(n_x.x, n_x.y, f.y);
}

float simplexNoise2D(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289v2(i);
  vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m * m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

float singleNoise(vec2 p) {
  if (u_mode < 0.5) return perlinNoise2D(p);
  if (u_mode < 1.5) return simplexNoise2D(p);
  return valueNoise2D(p);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxSum = 0.0;
  int oct = int(clamp(u_octaves, 1.0, 8.0));
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * singleNoise(p * freq);
    maxSum += amp;
    amp *= u_persistence;
    freq *= 2.0;
  }
  return sum / max(maxSum, 0.0001);
}

void main() {
  vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  vec2 p = (v_uv - 0.5) * aspect * max(u_scale, 0.01);
  // Seed offsets the sample plane so the same shape recurs deterministically;
  // animSpeed advances time across the plane so the field flows over u_time.
  p += vec2(u_seed * 12.34, u_seed * 56.78);
  p += vec2(u_time * u_animSpeed * 0.5, u_time * u_animSpeed * 0.3);
  float n = fbm(p);
  float v = clamp(n * 0.5 + 0.5, 0.0, 1.0);
  out_color = vec4(vec3(v), 1.0);
}
`;

function noiseSourceSize(params) {
  return {
    width: clamp(Math.round(Number(params?.width ?? 1920)), 256, 4096),
    height: clamp(Math.round(Number(params?.height ?? 1080)), 256, 4096),
  };
}

function noiseModeIndex(value) {
  const mode = String(value ?? "perlin").toLowerCase();
  if (mode === "simplex") return 1;
  if (mode === "value") return 2;
  return 0;
}

function noiseSourceUniforms(params, context) {
  return {
    u_scale: clamp(Number(params?.scale ?? 4), 0.1, 64),
    u_seed: clamp(Number(params?.seed ?? 0), 0, 999),
    u_mode: noiseModeIndex(params?.mode),
    u_octaves: clamp(Math.round(Number(params?.octaves ?? 4)), 1, 8),
    u_persistence: clamp(Number(params?.persistence ?? 50) / 100, 0, 1),
    u_time: Number(context?.timeSeconds) || 0,
    u_animSpeed: clamp(Number(params?.animSpeed ?? 0) / 100, 0, 2),
  };
}

export function applyNoiseSourceGpu(params, context) {
  const activeRenderer = getRenderer();
  if (!activeRenderer) return null;
  const { width, height } = noiseSourceSize(params);
  return activeRenderer.renderSource(
    NOISE_SOURCE_FRAGMENT_SHADER,
    width,
    height,
    noiseSourceUniforms(params, context),
  );
}

const SHADER_PASSES = Object.freeze({
  "chromatic-aberration": {
    fragment: CHROMATIC_ABERRATION_FRAGMENT_SHADER,
    uniforms(params) {
      const strength = Math.max(0, Number(params?.strength ?? 0));
      if (strength <= 0) return null; // pass-through
      return {
        u_strength: strength,
        u_angle: ((Number(params?.angle ?? 0) / 180) * Math.PI),
        u_radial: params?.mode === "radial" ? 1 : 0,
        u_center: [
          clamp(Number(params?.centerX ?? 50) / 100, 0, 1),
          1 - clamp(Number(params?.centerY ?? 50) / 100, 0, 1),
        ],
      };
    },
  },
  "led-screen": {
    fragment: LED_SCREEN_FRAGMENT_SHADER,
    uniforms(params) {
      return {
        u_cellSize: clamp(Math.round(Number(params?.cellSize ?? 6)), 2, 48),
        u_gap: clamp(Number(params?.gap ?? 18) / 100, 0, 0.8),
        u_subpixelMode: ledSubpixelModeIndex(params?.subpixelMode ?? "rgb"),
        u_shape: ledShapeIndex(params?.shape ?? "round"),
        u_softness: clamp(Number(params?.softness ?? 35) / 100, 0, 1),
        u_glow: clamp(Number(params?.glow ?? 18) / 100, 0, 1),
        u_brightness: clamp(Number(params?.brightness ?? 110) / 100, 0.25, 3),
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
      };
    },
  },
  modulation: {
    fragment: MODULATION_FRAGMENT_SHADER,
    uniforms(params) {
      return {
        u_frequency: clamp(Number(params?.frequency ?? 80), 4, 320),
        u_sensitivity: clamp(Number(params?.sensitivity ?? 35) / 100, 0, 2) * Math.PI * 2,
        u_thickness: clamp(Number(params?.thickness ?? 18) / 100, 0.01, 1),
        u_angle: ((Number(params?.angle ?? 0) / 180) * Math.PI),
        u_channelMode: modulationChannelModeIndex(params?.channelMode ?? "rgb"),
        u_sourceMix: clamp(Number(params?.sourceMix ?? 0) / 100, 0, 1),
        u_invert: String(params?.invert ?? "off").toLowerCase() === "on" ? 1 : 0,
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
      };
    },
  },
  "pixel-sorting": {
    fragment: PIXEL_SORTING_FRAGMENT_SHADER,
    uniforms(params) {
      const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
      if (opacity <= 0) return null;
      return {
        u_threshold: clamp(Number(params?.threshold ?? 50) / 100, 0, 1),
        u_softness: clamp(Number(params?.softness ?? 10) / 100, 0, 0.5),
        u_angle: ((Number(params?.angle ?? 0) / 180) * Math.PI),
        u_lengthPx: clamp(Number(params?.length ?? 24), 1, 256),
        u_iterations: clamp(Math.round(Number(params?.iterations ?? 8)), 1, 32),
        u_channel: thresholdChannelIndex(params?.channel ?? "luma"),
        u_direction: String(params?.direction ?? "bright").toLowerCase() === "dark" ? 1 : 0,
        u_opacity: opacity,
      };
    },
  },
  "depth-of-field": {
    fragment: DEPTH_OF_FIELD_FRAGMENT_SHADER,
    uniforms(params) {
      const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
      const blurPx = clamp(Number(params?.blur ?? 16), 0, 80);
      const debug = String(params?.debug ?? "off").toLowerCase() === "mask" ? 1 : 0;
      if (debug <= 0 && (opacity <= 0 || blurPx <= 0)) return null;
      return {
        u_opacity: opacity,
        u_center: [
          clamp(Number(params?.centerX ?? 50) / 100, 0, 1),
          1 - clamp(Number(params?.centerY ?? 50) / 100, 0, 1),
        ],
        u_radius: clamp(Number(params?.radius ?? 35) / 100, 0, 1),
        u_falloff: clamp(Number(params?.falloff ?? 25) / 100, 0, 1),
        u_aspect: clamp(Number(params?.aspect ?? 100) / 100, 0.25, 4),
        u_rotation: ((Number(params?.rotation ?? 0) / 180) * Math.PI),
        u_invert: String(params?.invert ?? "off").toLowerCase() === "on" ? 1 : 0,
        u_blurPx: blurPx,
        u_samples: clamp(Math.round(Number(params?.samples ?? 32)), 8, 64),
        u_bokehShape: String(params?.bokehShape ?? "round").toLowerCase() === "polygon" ? 1 : 0,
        u_blades: clamp(Math.round(Number(params?.blades ?? 6)), 3, 12),
        u_anamorphic: clamp(Number(params?.anamorphic ?? 100) / 100, 0.25, 4),
        u_debug: debug,
      };
    },
  },
  bloom: {
    fragment: BLOOM_FRAGMENT_SHADER,
    uniforms(params) {
      const radius = clamp(Number(params?.radius ?? 16), 0, 64);
      return {
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
        u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
        u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
        u_intensity: clamp(Number(params?.intensity ?? 100) / 100, 0, 4),
        u_radius: radius,
        u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
        u_taps: bloomDiskTapCount(radius),
      };
    },
  },
  "star-glow": {
    fragment: STAR_GLOW_FRAGMENT_SHADER,
    uniforms(params) {
      const intensity = clamp(Number(params?.intensity ?? 100) / 100, 0, 4);
      const lengthPx = clamp(Number(params?.length ?? 64), 1, 192);
      if (intensity <= 0 || lengthPx <= 0) return null;
      return {
        u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
        u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
        u_intensity: intensity,
        u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
        u_streaks: clamp(Math.round(Number(params?.streaks ?? 4)), 1, 8),
        u_angle: ((Number(params?.angle ?? 0) / 180) * Math.PI),
        u_lengthPx: lengthPx,
        u_falloff: clamp(Number(params?.falloff ?? 80) / 100, 0.05, 1),
        u_alternate: clamp(Number(params?.alternate ?? 100) / 100, 0, 1),
        u_colorize: clamp(Number(params?.colorize ?? 0) / 100, 0, 1),
      };
    },
  },
  halation: {
    fragment: HALATION_FRAGMENT_SHADER,
    uniforms(params) {
      // tintColor is the canonical store; tintR/G/B fall through as a
      // last-resort fallback in case any path hands us an un-normalised
      // params object (shouldn't happen — graph.js migrates on load).
      const tint = params?.tintColor
        ? hexToRgb01(params.tintColor, [1, 0.47, 0.24])
        : [
            clamp(Number(params?.tintR ?? 255) / 255, 0, 1),
            clamp(Number(params?.tintG ?? 120) / 255, 0, 1),
            clamp(Number(params?.tintB ?? 60) / 255, 0, 1),
          ];
      const radius = clamp(Number(params?.radius ?? 24), 0, 96);
      return {
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
        u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
        u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
        u_intensity: clamp(Number(params?.intensity ?? 120) / 100, 0, 4),
        u_radius: radius,
        u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
        u_tint: tint,
        u_taps: bloomDiskTapCount(radius),
      };
    },
  },
  pixelate: {
    fragment: PIXELATE_FRAGMENT_SHADER,
    uniforms(params) {
      const sizeX = Math.max(1, Math.round(Number(params?.size ?? 8)));
      // sizeY = 0 is the legacy "follow size" sentinel — old saves stored
      // only `size`, so this preserves their square-pixel behavior.
      const rawY = Number(params?.sizeY ?? 0);
      const sizeY = rawY > 0 ? Math.max(1, Math.round(rawY)) : sizeX;
      return {
        u_sizeX: sizeX,
        u_sizeY: sizeY,
        u_shape: String(params?.shape ?? "square").toLowerCase() === "circle" ? 1 : 0,
        u_smoothing: clamp(Number(params?.smoothing ?? 0) / 100, 0, 1),
        u_gridOpacity: clamp(Number(params?.gridOpacity ?? 0) / 100, 0, 1),
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
      };
    },
  },
  posterize: {
    fragment: POSTERIZE_FRAGMENT_SHADER,
    uniforms(params) {
      const stepsR = clamp(Math.round(Number(params?.steps ?? 8)), 2, 64);
      // 0 sentinel on stepsG / stepsB means "link to R" — old saves only
      // had `steps`, this preserves them as evenly-quantized RGB.
      const rawG = Number(params?.stepsG ?? 0);
      const rawB = Number(params?.stepsB ?? 0);
      const stepsG = rawG > 0 ? clamp(Math.round(rawG), 2, 64) : stepsR;
      const stepsB = rawB > 0 ? clamp(Math.round(rawB), 2, 64) : stepsR;
      return {
        u_stepsR: stepsR,
        u_stepsG: stepsG,
        u_stepsB: stepsB,
        u_gamma: String(params?.gamma ?? "linear").toLowerCase() === "srgb" ? 1 : 0,
        u_lumaMode: String(params?.lumaMode ?? "rgb").toLowerCase() === "luma" ? 1 : 0,
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
      };
    },
  },
  "gradient-map": {
    fragment: GRADIENT_MAP_FRAGMENT_SHADER,
    uniforms(params) {
      const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
      if (opacity <= 0) return null;
      return {
        u_shift: clamp(Number(params?.shift ?? 0) / 100, -1, 1),
        u_repeat: clamp(Number(params?.repeat ?? 1), 1, 20),
        u_mode: gradientMapModeIndex(params?.mode ?? "luma"),
        u_opacity: opacity,
      };
    },
    textures(params) {
      return { u_gradientLut: gradientLutTextureSource(params) };
    },
  },
  threshold: {
    fragment: THRESHOLD_FRAGMENT_SHADER,
    uniforms(params) {
      return {
        u_threshold: clamp(Number(params?.threshold ?? 50) / 100, 0, 1),
        u_softness: clamp(Number(params?.softness ?? 0) / 100, 0, 0.5),
        u_channel: thresholdChannelIndex(params?.channel ?? "luma"),
        u_invert: String(params?.invert ?? "off").toLowerCase() === "on" ? 1 : 0,
        u_mode: String(params?.mode ?? "bw").toLowerCase() === "source" ? 1 : 0,
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
      };
    },
  },
  "pattern-dither": {
    fragment: PATTERN_DITHER_FRAGMENT_SHADER,
    uniforms(params) {
      return {
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
        u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
        u_pattern: patternIndex(params?.pattern ?? "bayer-4x4"),
        u_scale: Math.max(1, Math.round(Number(params?.scale ?? 1))),
        u_strength: clamp(Number(params?.strength ?? 100) / 100, 0, 2),
        u_depth: clamp(Number(params?.depth ?? 4), 1, 8),
        u_gamma: String(params?.gamma ?? "srgb").toLowerCase() === "srgb" ? 1 : 0,
      };
    },
  },
  ascii: {
    fragment: ASCII_FRAGMENT_SHADER,
    uniforms(params) {
      const ramp = getAsciiRamp(params?.ramp);
      // Glyph size matches the cell size 1:1 so each cell maps to exactly
      // one glyph in the atlas with no scaling artifacts.
      const cellSize = Math.max(4, Math.round(Number(params?.cellSize ?? 8)));
      const useImageColor = String(params?.colorMode ?? "source").toLowerCase() === "source";
      return {
        u_cellSize: cellSize,
        u_atlasCount: ramp.length,
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
        u_invert: String(params?.invert ?? "off").toLowerCase() === "on" ? 1 : 0,
        u_useImageColor: useImageColor ? 1 : 0,
        u_fg: [1, 1, 1], // mono mode default — extend later when color picker UI lands
        u_bg: [0, 0, 0],
        // Signal shaping (md §2 P1). Defaults are the identity transform.
        u_signalBlack: clamp(Number(params?.signalBlack ?? 0) / 100, 0, 1),
        u_signalWhite: clamp(Number(params?.signalWhite ?? 100) / 100, 0, 1),
        u_signalGamma: clamp(Number(params?.signalGamma ?? 100) / 100, 0.1, 4),
        u_presenceThreshold: clamp(Number(params?.presenceThreshold ?? 0) / 100, 0, 1),
        u_presenceSoftness: clamp(Number(params?.presenceSoftness ?? 0) / 100, 0, 1),
      };
    },
    textures(params) {
      const ramp = getAsciiRamp(params?.ramp);
      const cellSize = Math.max(4, Math.round(Number(params?.cellSize ?? 8)));
      // Atlas glyph size matches cell size so the in-cell UV maps 1:1 to
      // glyph pixels — no resampling between the cell grid and the atlas.
      return { u_atlas: getAsciiAtlas(ramp, cellSize) };
    },
  },
  crt: {
    fragment: CRT_FRAGMENT_SHADER,
    uniforms(params, context) {
      const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
      // Same time-source policy as VHS: prefer the timeline playhead so the
      // rolling sync band scrolls deterministically with the frame, but fall
      // back to a monotonic clock for the smoke harness / detached previews.
      const time = Number.isFinite(Number(context?.timeSeconds))
        ? Number(context.timeSeconds)
        : (typeof performance !== "undefined" ? performance.now() / 1000 : 0);
      return {
        u_time: time,
        u_opacity: opacity,
        u_brightness: clamp(Number(params?.brightness ?? 110) / 100, 0, 3),
        u_saturation: clamp(Number(params?.saturation ?? 110) / 100, 0, 2),
        u_curvature: clamp(Number(params?.curvature ?? 25) / 100, 0, 1),
        u_scanlines: clamp(Number(params?.scanlines ?? 60) / 100, 0, 1),
        u_mask: maskIndex(params?.mask ?? "aperture"),
        u_maskStrength: clamp(Number(params?.maskStrength ?? 35) / 100, 0, 1),
        u_glow: clamp(Number(params?.glow ?? 25) / 100, 0, 1),
        u_vignette: clamp(Number(params?.vignette ?? 35) / 100, 0, 1),
        u_rolling: clamp(Number(params?.rolling ?? 0) / 100, 0, 1),
      };
    },
  },
  vhs: {
    fragment: VHS_FRAGMENT_SHADER,
    uniforms(params, context) {
      const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
      // Animation seed: prefer the timeline playhead so preview and export
      // produce identical noise/tracking for the same frame. Fallback to a
      // monotonic clock only when no context is supplied (smoke harness etc.).
      const time = Number.isFinite(Number(context?.timeSeconds))
        ? Number(context.timeSeconds)
        : (typeof performance !== "undefined" ? performance.now() / 1000 : 0);
      return {
        u_time: time,
        u_opacity: opacity,
        u_chroma: clamp(Number(params?.chroma ?? 6), 0, 32),
        u_noise: clamp(Number(params?.noise ?? 35) / 100, 0, 1),
        u_scanlines: clamp(Number(params?.scanlines ?? 60) / 100, 0, 1),
        u_tracking: clamp(Number(params?.tracking ?? 35) / 100, 0, 1),
        u_wave: clamp(Number(params?.wave ?? 4), 0, 32),
        u_vignette: clamp(Number(params?.vignette ?? 40) / 100, 0, 1),
        u_saturation: clamp(Number(params?.saturation ?? 110) / 100, 0, 2),
        u_bleed: clamp(Number(params?.bleed ?? 50) / 100, 0, 1),
        // Tape realism (md §4 P2). All identity at the defaults.
        u_tapeResolution: clamp(Number(params?.tapeResolution ?? 100), 25, 200),
        u_jitter: clamp(Number(params?.jitter ?? 0) / 100, 0, 1),
        u_flicker: clamp(Number(params?.flicker ?? 0) / 100, 0, 1),
        u_dropouts: clamp(Number(params?.dropouts ?? 0) / 100, 0, 1),
        u_crease: clamp(Number(params?.crease ?? 0) / 100, 0, 1),
      };
    },
  },
  halftone: {
    fragment: HALFTONE_FRAGMENT_SHADER,
    uniforms(params) {
      const spacing = Math.max(2, Number(params?.spacing ?? params?.cellSize ?? 5));
      const dotScale = clamp(Number(params?.dotScale ?? 100) / 100, 0.1, 2.5);
      const angle = ((Number(params?.angle ?? 15) / 180) * Math.PI);
      const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
      const hue = ((Number(params?.hue ?? 0) / 180) * Math.PI);
      const saturation = clamp(Number(params?.saturation ?? 100) / 100, 0, 2);
      const colorMode = colorModeIndex(params?.colorMode ?? params?.mode ?? "mono");
      const shape = shapeIndex(params?.shape ?? "circle");
      return {
        u_spacing: spacing,
        u_angle: angle,
        u_dotScale: dotScale,
        u_shape: shape,
        u_colorMode: colorMode,
        u_opacity: opacity,
        u_hue: hue,
        u_saturation: saturation,
      };
    },
  },
});

let renderer = null;

export function disposeGpuEffects() {
  const activeRenderer = renderer;
  renderer = null;
  activeRenderer?.dispose?.();
}

export function applyShaderPass(passId, input, params, context) {
  if (!input?.width || !input?.height) return null;
  const pass = SHADER_PASSES[passId];
  if (!pass) return null;

  const uniforms = pass.uniforms(params, context);
  if (uniforms === null) return input; // pass-through

  const activeRenderer = getRenderer();
  if (!activeRenderer) return null;
  // Passes that need extra samplers (atlas / LUT / displacement map) declare
  // a `textures(params, context)` builder that returns a `{ uniformName: source }`
  // map. Sources are bound to TEXTURE1+ and the matching sampler uniforms get
  // wired automatically.
  const textures = pass.textures ? pass.textures(params, context) : null;
  return activeRenderer.render(pass.fragment, input, uniforms, textures);
}

export function applyMeshGradientGpu(params, context) {
  const activeRenderer = getRenderer();
  if (!activeRenderer) return null;
  const { width, height } = meshGradientSize(params);
  return activeRenderer.renderSource(
    MESH_GRADIENT_FRAGMENT_SHADER,
    width,
    height,
    meshGradientUniforms(params, context)
  );
}

export function applyGradientSourceGpu(params, context) {
  const activeRenderer = getRenderer();
  if (!activeRenderer) return null;
  const { width, height } = gradientSourceSize(params);
  return activeRenderer.renderSource(
    GRADIENT_SOURCE_FRAGMENT_SHADER,
    width,
    height,
    gradientSourceUniforms(params, context),
    { u_gradientLut: gradientLutTextureSource(params) }
  );
}

export function applyChromaticAberrationGpu(input, params) {
  return applyShaderPass("chromatic-aberration", input, params);
}

export function applyLedScreenGpu(input, params) {
  return applyShaderPass("led-screen", input, params);
}

export function applyModulationGpu(input, params) {
  return applyShaderPass("modulation", input, params);
}

export function applyPixelSortingGpu(input, params) {
  return applyShaderPass("pixel-sorting", input, params);
}

export function applyDepthOfFieldGpu(input, params) {
  return applyShaderPass("depth-of-field", input, params);
}

export function applyHalftoneGpu(input, params) {
  return applyShaderPass("halftone", input, params);
}

export function applyVhsGpu(input, params, context) {
  return applyShaderPass("vhs", input, params, context);
}

export function applyCrtGpu(input, params, context) {
  return applyShaderPass("crt", input, params, context);
}

export function applyBloomGpu(input, params) {
  // F9.2: prefer the mip-pyramid path; the legacy single-pass disk stays as
  // a fallback for the rare case where mip allocation or extra-texture
  // binding fails (e.g. driver running out of FBO color attachments).
  const multi = applyBloomMultiPass(input, params);
  if (multi) return multi;
  return applyShaderPass("bloom", input, params);
}

export function applyStarGlowGpu(input, params) {
  // F9.4: prefer the bright-extract + refined-streak multi-pass; legacy
  // single-pass shader stays as the fallback for the rare WebGL setup
  // failure.
  const multi = applyStarGlowMultiPass(input, params);
  if (multi) return multi;
  return applyShaderPass("star-glow", input, params);
}

export function applyHalationGpu(input, params) {
  // F9.3: prefer the shared mip-pyramid path; legacy single-pass disk stays
  // as the fallback for the rare case where mip allocation fails.
  const multi = applyHalationMultiPass(input, params);
  if (multi) return multi;
  return applyShaderPass("halation", input, params);
}

export function applyAsciiGpu(input, params) {
  return applyShaderPass("ascii", input, params);
}

export function applyPatternDitherGpu(input, params) {
  return applyShaderPass("pattern-dither", input, params);
}

export function applyPixelateGpu(input, params) {
  return applyShaderPass("pixelate", input, params);
}

export function applyPosterizeGpu(input, params) {
  return applyShaderPass("posterize", input, params);
}

export function applyGradientMapGpu(input, params) {
  return applyShaderPass("gradient-map", input, params);
}

export function applyThresholdGpu(input, params) {
  return applyShaderPass("threshold", input, params);
}

function getRenderer() {
  if (renderer !== null) {
    if (!renderer.isDisposed?.()) return renderer;
    renderer = null;
  }
  renderer = createRenderer();
  return renderer;
}

function createRenderer() {
  // Same worker bail as the ASCII atlas: WebGL2 inside a Worker requires the
  // factory's OffscreenCanvas branch, but the rest of the renderer wiring
  // (createTexture / drawArrays) isn't wired through yet. F8.4 removes this
  // guard once the worker adapter lands.
  if (typeof document === "undefined") return null;

  const canvas = createProcessingCanvas(1, 1);
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);
  if (!vertexShader) return null;

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );

  const vao = gl.createVertexArray();
  const texture = gl.createTexture();
  const extraTextures = new Map(); // uniformName -> WebGLTexture, reused per pass
  const programs = new Map();
  // F9.0 ping-pong: two RGBA8 framebuffers re-used across multi-pass chains.
  // Allocated lazily on the first renderChain call so single-pass effects
  // pay nothing.
  let pingPongA = null;
  let pingPongB = null;
  // F9.1 mip chain: array of decreasing-resolution framebuffers shared
  // across multi-pass mip effects (bloom, halation, glow). Lazily grown
  // by ensureMipChain on demand.
  const mipChain = [];

  let disposed = false;

  function dispose(options = {}) {
    if (disposed) return;
    disposed = true;

    if (renderer === api) renderer = null;
    if (typeof canvas.removeEventListener === "function") {
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
    }

    const contextLost = Boolean(options.contextLost)
      || (typeof gl.isContextLost === "function" && gl.isContextLost());
    if (!contextLost) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(null);
      gl.useProgram(null);

      deleteFramebuffer(gl, pingPongA);
      deleteFramebuffer(gl, pingPongB);
      for (const fb of mipChain) deleteFramebuffer(gl, fb);
      for (const tex of extraTextures.values()) gl.deleteTexture(tex);
      for (const program of programs.values()) gl.deleteProgram(program.handle);
      gl.deleteTexture(texture);
      gl.deleteBuffer(positionBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteShader(vertexShader);
    }

    pingPongA = null;
    pingPongB = null;
    mipChain.length = 0;
    extraTextures.clear();
    programs.clear();
  }

  function isRendererUnavailable() {
    if (disposed) return true;
    if (typeof gl.isContextLost === "function" && gl.isContextLost()) {
      dispose({ contextLost: true });
      return true;
    }
    return false;
  }

  function handleContextLost(event) {
    event.preventDefault();
    dispose({ contextLost: true });
  }

  function handleContextRestored() {
    if (renderer === api) renderer = null;
  }

  const api = {
    render(fragmentSource, input, uniforms, textures) {
      if (!input?.width || !input?.height) return null;
      if (isRendererUnavailable()) return null;
      const program = getProgram(gl, programs, vertexShader, fragmentSource);
      if (!program) return null;

      if (canvas.width !== input.width || canvas.height !== input.height) {
        canvas.width = input.width;
        canvas.height = input.height;
      }

      gl.viewport(0, 0, input.width, input.height);
      gl.useProgram(program.handle);
      gl.bindVertexArray(vao);

      const positionLocation = gl.getAttribLocation(program.handle, "a_position");
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);

      gl.uniform1i(getUniformLocation(gl, program, "u_image"), 0);
      gl.uniform2f(getUniformLocation(gl, program, "u_resolution"), input.width, input.height);

      // Bind extra samplers (ASCII glyph atlas, future LUTs, etc.) starting
      // at TEXTURE1. UNPACK_FLIP_Y_WEBGL is still set from the input upload,
      // so extras get the same flip — pass shaders should sample with the
      // same UV convention as u_image to stay consistent.
      let unit = 1;
      if (textures) {
        for (const [name, source] of Object.entries(textures)) {
          if (!source) continue;
          let extraTex = extraTextures.get(name);
          if (!extraTex) {
            extraTex = gl.createTexture();
            extraTextures.set(name, extraTex);
          }
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, extraTex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          gl.uniform1i(getUniformLocation(gl, program, name), unit);
          unit++;
        }
      }

      applyUniforms(gl, program, uniforms);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const output = createProcessingCanvas(input.width, input.height);
      const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      return output;
    },
    renderSource(fragmentSource, width, height, uniforms, textures) {
      const w = Math.max(1, Math.round(Number(width) || 0));
      const h = Math.max(1, Math.round(Number(height) || 0));
      if (!w || !h) return null;
      if (isRendererUnavailable()) return null;

      const program = getProgram(gl, programs, vertexShader, fragmentSource);
      if (!program) return null;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      gl.useProgram(program.handle);
      gl.bindVertexArray(vao);

      const positionLocation = gl.getAttribLocation(program.handle, "a_position");
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(getUniformLocation(gl, program, "u_resolution"), w, h);

      let unit = 0;
      if (textures) {
        for (const [name, source] of Object.entries(textures)) {
          if (!source) continue;
          let extraTex = extraTextures.get(name);
          if (!extraTex) {
            extraTex = gl.createTexture();
            extraTextures.set(name, extraTex);
          }
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, extraTex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          gl.uniform1i(getUniformLocation(gl, program, name), unit);
          unit++;
        }
      }

      applyUniforms(gl, program, uniforms);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const output = createProcessingCanvas(w, h);
      const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      return output;
    },
    renderChain(passes, input) {
      if (!input?.width || !input?.height) return null;
      if (!Array.isArray(passes) || passes.length === 0) return null;
      if (isRendererUnavailable()) return null;

      const width = input.width;
      const height = input.height;

      pingPongA = pingPongA
        ? resizeFramebuffer(gl, pingPongA, width, height)
        : createFramebuffer(gl, width, height);
      pingPongB = pingPongB
        ? resizeFramebuffer(gl, pingPongB, width, height)
        : createFramebuffer(gl, width, height);
      if (!pingPongA || !pingPongB) return null;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      // Upload the source image once into the main input texture; subsequent
      // passes sample the previous FBO's color attachment instead.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);

      let readTex = texture; // input texture for the first pass
      let writeFb = pingPongA;
      let otherFb = pingPongB;

      for (let i = 0; i < passes.length; i++) {
        const pass = passes[i];
        const isLast = i === passes.length - 1;
        const program = getProgram(gl, programs, vertexShader, pass.fragmentSource);
        if (!program) return null;

        // Final pass writes to the default framebuffer (canvas backing store)
        // so the existing 2D copy path can pick it up. Intermediate passes
        // write into the alternating FBO so the next iteration can sample it.
        gl.bindFramebuffer(gl.FRAMEBUFFER, isLast ? null : writeFb.fbo);
        gl.viewport(0, 0, width, height);

        gl.useProgram(program.handle);
        gl.bindVertexArray(vao);
        const positionLocation = gl.getAttribLocation(program.handle, "a_position");
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTex);
        gl.uniform1i(getUniformLocation(gl, program, "u_image"), 0);
        gl.uniform2f(getUniformLocation(gl, program, "u_resolution"), width, height);

        applyUniforms(gl, program, pass.uniforms ?? {});

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        if (!isLast) {
          readTex = writeFb.texture;
          const next = otherFb;
          otherFb = writeFb;
          writeFb = next;
        }
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const output = createProcessingCanvas(width, height);
      const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      return output;
    },
    // Low-level single-pass: read from sourceTexture (already uploaded) and
    // write into targetFb (or canvas if null). Internal helper for the mip
    // pipeline — `options.extraTextures` binds additional samplers starting
    // at TEXTURE1, and `options.additive` enables ONE/ONE blending so the
    // mip upsample-and-accumulate step can reuse this entry point.
    renderPass(fragmentSource, sourceTexture, targetWidth, targetHeight, targetFb, options = {}) {
      if (isRendererUnavailable()) return false;
      const program = getProgram(gl, programs, vertexShader, fragmentSource);
      if (!program) return false;

      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb ? targetFb.fbo : null);
      if (!targetFb) {
        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
        }
      }
      gl.viewport(0, 0, targetWidth, targetHeight);

      if (options.additive) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
      } else {
        gl.disable(gl.BLEND);
      }

      gl.useProgram(program.handle);
      gl.bindVertexArray(vao);
      const positionLocation = gl.getAttribLocation(program.handle, "a_position");
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      gl.uniform1i(getUniformLocation(gl, program, "u_image"), 0);
      // Source resolution helps box-downsample compute the correct texel
      // offsets; when omitted, fall back to target so single-resolution
      // chains keep their existing behaviour.
      gl.uniform2f(
        getUniformLocation(gl, program, "u_resolution"),
        options.sourceWidth ?? targetWidth,
        options.sourceHeight ?? targetHeight,
      );

      let unit = 1;
      if (options.extraTextures) {
        for (const [name, tex] of Object.entries(options.extraTextures)) {
          if (!tex) continue;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(getUniformLocation(gl, program, name), unit);
          unit++;
        }
      }

      applyUniforms(gl, program, options.uniforms ?? {});

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (options.additive) gl.disable(gl.BLEND);
      return true;
    },
    clearFramebuffer(targetFb, color = [0, 0, 0, 0]) {
      if (isRendererUnavailable()) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb ? targetFb.fbo : null);
      if (targetFb) gl.viewport(0, 0, targetFb.width, targetFb.height);
      gl.clearColor(color[0], color[1], color[2], color[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    // Lazily grow / resize the shared mip chain so it has at least `levels`
    // entries sized as base, base/2, base/4, ... Re-uses framebuffers across
    // calls; failed entries return null so the caller can bail.
    ensureMipChain(baseWidth, baseHeight, levels) {
      if (isRendererUnavailable()) return null;
      for (let i = 0; i < levels; i++) {
        const w = Math.max(1, baseWidth >> i);
        const h = Math.max(1, baseHeight >> i);
        if (!mipChain[i]) {
          mipChain[i] = createFramebuffer(gl, w, h);
        } else {
          mipChain[i] = resizeFramebuffer(gl, mipChain[i], w, h);
        }
        if (!mipChain[i]) return null;
      }
      return mipChain;
    },
    // Upload an input source image into the renderer's main input texture,
    // returning the WebGLTexture handle so callers (mip pipelines, etc.)
    // can read from it before any draw call. UNPACK_FLIP_Y matches the rest
    // of the renderer so shaders keep a single UV convention.
    uploadInput(input) {
      if (!input?.width || !input?.height) return null;
      if (isRendererUnavailable()) return null;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
      return texture;
    },
    // Copy the canvas backing store into a fresh 2D output canvas so the
    // rest of the graph runtime keeps working with HTMLCanvasElements.
    captureOutput(width, height) {
      if (isRendererUnavailable()) return null;
      const output = createProcessingCanvas(width, height);
      const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      return output;
    },
    resizeBackingCanvas(width, height) {
      if (isRendererUnavailable()) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    },
    dispose,
    isDisposed() {
      return disposed;
    },
  };

  if (typeof canvas.addEventListener === "function") {
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
  }

  return api;
}

function createFramebuffer(gl, width, height) {
  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  // Without a complete attachment subsequent draws no-op silently; fail loud
  // so a broken extension or driver state surfaces here, not later.
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex, width, height };
}

function resizeFramebuffer(gl, fb, width, height) {
  if (!fb) return null;
  if (fb.width === width && fb.height === height) return fb;
  gl.bindTexture(gl.TEXTURE_2D, fb.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  fb.width = width;
  fb.height = height;
  return fb;
}

function deleteFramebuffer(gl, fb) {
  if (!fb) return;
  gl.deleteTexture(fb.texture);
  gl.deleteFramebuffer(fb.fbo);
}

// Opt-in multi-pass chain runner. Each pass is `{ fragmentSource, uniforms }`;
// passes sample the prior step from `u_image` and `u_resolution` is set to the
// input image size for every step. Single-pass arrays behave identically to
// the canvas the legacy `render` path produces.
export function applyShaderChain(passes, input) {
  if (!input?.width || !input?.height) return null;
  if (!Array.isArray(passes) || passes.length === 0) return null;
  const activeRenderer = getRenderer();
  if (!activeRenderer) return null;
  return activeRenderer.renderChain(passes, input);
}

// F9.5 Separable Gaussian blur. The same shader is run twice — once
// horizontally, once vertically — so a 1D weight kernel covers a 2D Gaussian
// at O(2N) cost per pixel instead of O(N^2). KERNEL is sized for radii up to
// ~16px; the inspector caller should fall back to a wider path (mip pyramid
// or ctx.filter) when the radius exceeds GAUSSIAN_BLUR_MAX_RADIUS.
const GAUSSIAN_BLUR_KERNEL_SIZE = 33;
const GAUSSIAN_BLUR_HALF = (GAUSSIAN_BLUR_KERNEL_SIZE - 1) / 2;
export const GAUSSIAN_BLUR_MAX_RADIUS = GAUSSIAN_BLUR_HALF;

const GAUSSIAN_BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;

const int KERNEL = ${GAUSSIAN_BLUR_KERNEL_SIZE};
const int HALF = ${GAUSSIAN_BLUR_HALF};

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform vec2 u_direction;
uniform float u_weights[KERNEL];

in vec2 v_uv;
out vec4 out_color;

void main() {
  vec2 step = u_direction / u_resolution;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < KERNEL; i++) {
    float offset = float(i - HALF);
    sum += texture(u_image, v_uv + step * offset) * u_weights[i];
  }
  out_color = sum;
}
`;

function gaussianBlurWeights(sigma) {
  const weights = new Float32Array(GAUSSIAN_BLUR_KERNEL_SIZE);
  const safeSigma = Math.max(sigma, 0.01);
  const twoSigmaSquared = 2 * safeSigma * safeSigma;
  let sum = 0;
  for (let i = 0; i < GAUSSIAN_BLUR_KERNEL_SIZE; i++) {
    const x = i - GAUSSIAN_BLUR_HALF;
    const w = Math.exp(-(x * x) / twoSigmaSquared);
    weights[i] = w;
    sum += w;
  }
  for (let i = 0; i < GAUSSIAN_BLUR_KERNEL_SIZE; i++) weights[i] /= sum;
  return weights;
}

export function applyBlurGpu(input, params) {
  if (!input?.width || !input?.height) return null;
  const radius = Math.max(0, Number(params?.radius ?? 0));
  if (radius === 0) return input;
  if (radius > GAUSSIAN_BLUR_MAX_RADIUS) return null;

  // Map radius (visible blur span in pixels) onto a Gaussian sigma. Half the
  // radius is the standard rule — at 3*sigma the contribution falls below 1%,
  // so a 33-tap kernel comfortably covers radius up to 16.
  const sigma = Math.max(radius / 2, 0.5);
  const weights = { type: "float[]", data: gaussianBlurWeights(sigma) };
  return applyShaderChain(
    [
      {
        fragmentSource: GAUSSIAN_BLUR_FRAGMENT_SHADER,
        uniforms: { u_direction: [1, 0], u_weights: weights },
      },
      {
        fragmentSource: GAUSSIAN_BLUR_FRAGMENT_SHADER,
        uniforms: { u_direction: [0, 1], u_weights: weights },
      },
    ],
    input,
  );
}

// F9.1 + F9.2 multi-pass mip bloom. Threshold the source into a bright
// pyramid, downsample N levels at 2x2 box average, then bilinear-upsample
// back up while additively accumulating each level into the next, and
// finally composite the pyramid's level 0 over the original. Replaces the
// single-pass golden-spiral disk for moderate radii where the ring artefact
// shows up; the legacy shader is kept as a fallback when WebGL2 setup fails.
const BLOOM_THRESHOLD_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform float u_threshold;
uniform float u_knee;
uniform float u_saturation;
in vec2 v_uv;
out vec4 out_color;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec3 c = texture(u_image, v_uv).rgb;
  float l = dot(c, LUMA);
  vec3 sat = mix(vec3(l), c, u_saturation);
  float lo = max(u_threshold - u_knee, 0.0);
  float hi = u_threshold + u_knee + 0.001;
  float w = smoothstep(lo, hi, l);
  out_color = vec4(sat * w, 1.0);
}
`;

const BLOOM_DOWNSAMPLE_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_resolution; // source resolution; offsets are 0.5 texels of it
in vec2 v_uv;
out vec4 out_color;
void main() {
  vec2 texel = 1.0 / u_resolution;
  vec2 o = texel * 0.5;
  vec4 c = texture(u_image, v_uv + vec2(-o.x, -o.y));
  c     += texture(u_image, v_uv + vec2( o.x, -o.y));
  c     += texture(u_image, v_uv + vec2(-o.x,  o.y));
  c     += texture(u_image, v_uv + vec2( o.x,  o.y));
  out_color = c * 0.25;
}
`;

const BLOOM_UPSAMPLE_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
in vec2 v_uv;
out vec4 out_color;
void main() {
  // Bilinear filtering on the smaller mip handles the smooth upscale; the
  // host pass enables additive blending so this output stacks onto the
  // higher-resolution mip it is being written into.
  out_color = texture(u_image, v_uv);
}
`;

const BLOOM_COMPOSITE_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;   // original source
uniform sampler2D u_bloom;   // accumulated bloom mip0
uniform float u_intensity;
uniform float u_opacity;
in vec2 v_uv;
out vec4 out_color;
void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  vec3 bloom = texture(u_bloom, v_uv).rgb;
  vec3 lit = src + bloom * u_intensity;
  out_color = vec4(mix(src, clamp(lit, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

function bloomMipLevelsForRadius(radius) {
  // Each downsample halves the effective blur radius covered by the box
  // filter, so log2(radius)+1 levels comfortably reach a radius of `radius`
  // pixels in the original image. Capped at 6 to bound memory + GPU work.
  return Math.max(2, Math.min(6, Math.ceil(Math.log2(Math.max(2, radius))) + 1));
}

// Shared mip-bloom pipeline. The threshold step is parameterised so bloom and
// halation can drop in their own threshold shader + uniforms; everything after
// it (downsample chain → upsample-and-accumulate → composite) is identical.
function runBrightMipPipeline(input, thresholdShader, thresholdUniforms, radius, intensity, opacity) {
  const activeRenderer = getRenderer();
  if (!activeRenderer) return null;
  if (
    typeof activeRenderer.ensureMipChain !== "function" ||
    typeof activeRenderer.renderPass !== "function" ||
    typeof activeRenderer.uploadInput !== "function" ||
    typeof activeRenderer.captureOutput !== "function"
  ) {
    return null;
  }

  const levels = bloomMipLevelsForRadius(radius);
  const mip = activeRenderer.ensureMipChain(input.width, input.height, levels);
  if (!mip || mip.length < levels) return null;

  const sourceTex = activeRenderer.uploadInput(input);
  if (!sourceTex) return null;

  if (!activeRenderer.renderPass(thresholdShader, sourceTex, mip[0].width, mip[0].height, mip[0], {
    uniforms: thresholdUniforms,
  })) return null;

  for (let i = 0; i < levels - 1; i++) {
    const src = mip[i];
    const dst = mip[i + 1];
    if (!activeRenderer.renderPass(BLOOM_DOWNSAMPLE_SHADER, src.texture, dst.width, dst.height, dst, {
      sourceWidth: src.width,
      sourceHeight: src.height,
    })) return null;
  }

  for (let i = levels - 2; i >= 0; i--) {
    const src = mip[i + 1];
    const dst = mip[i];
    if (!activeRenderer.renderPass(BLOOM_UPSAMPLE_SHADER, src.texture, dst.width, dst.height, dst, {
      additive: true,
    })) return null;
  }

  activeRenderer.resizeBackingCanvas(input.width, input.height);
  if (!activeRenderer.renderPass(BLOOM_COMPOSITE_SHADER, sourceTex, input.width, input.height, null, {
    uniforms: { u_intensity: intensity, u_opacity: opacity },
    extraTextures: { u_bloom: mip[0].texture },
  })) return null;

  return activeRenderer.captureOutput(input.width, input.height);
}

export function applyBloomMultiPass(input, params) {
  if (!input?.width || !input?.height) return null;
  const radius = clamp(Number(params?.radius ?? 16), 0, 64);
  const intensity = clamp(Number(params?.intensity ?? 100) / 100, 0, 4);
  if (radius <= 0 || intensity <= 0) return input;
  const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
  return runBrightMipPipeline(input, BLOOM_THRESHOLD_SHADER, {
    u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
    u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
    u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
  }, radius, intensity, opacity);
}

// F9.3 Halation multi-pass. Identical mip pipeline to bloom, but the
// threshold pass tints luma-weighted bright pixels with u_tint so the
// classic red/orange halation rim falls out of the same FBO chain.
const HALATION_THRESHOLD_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform float u_threshold;
uniform float u_knee;
uniform float u_saturation;
uniform vec3 u_tint;
in vec2 v_uv;
out vec4 out_color;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec3 c = texture(u_image, v_uv).rgb;
  float l = dot(c, LUMA);
  // Saturation pre-mix: 0 collapses to pure luma * tint (classic film
  // halation), 1 keeps source colour and just multiplies by tint, > 1
  // supersaturates. Luma stays the threshold input either way so the
  // bright cutoff feels the same as bloom.
  vec3 sat = mix(vec3(l), c, u_saturation);
  vec3 weighted = sat * u_tint;
  float lo = max(u_threshold - u_knee, 0.0);
  float hi = u_threshold + u_knee + 0.001;
  float w = smoothstep(lo, hi, l);
  out_color = vec4(weighted * w, 1.0);
}
`;

// F9.4 Star-glow multi-pass. Pre-extract bright pixels once into mip[0] so
// the streak pass can sample them at every tap without re-running luma /
// threshold checks; this lets us bump the tap count from 8 to 16 (visibly
// smoother streaks) at roughly the same overall sample cost, and a single
// composite step folds the accumulated streaks back over the source.
const STAR_GLOW_BRIGHT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform float u_threshold;
uniform float u_knee;
uniform float u_saturation;
in vec2 v_uv;
out vec4 out_color;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec3 c = texture(u_image, v_uv).rgb;
  float l = dot(c, LUMA);
  vec3 sat = mix(vec3(l), c, u_saturation);
  float lo = max(u_threshold - u_knee, 0.0);
  float hi = u_threshold + u_knee + 0.001;
  float w = smoothstep(lo, hi, l);
  out_color = vec4(sat * w, 1.0);
}
`;

const STAR_GLOW_STREAK_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;       // pre-extracted bright pixels
uniform sampler2D u_source;      // original source for composite
uniform vec2 u_resolution;
uniform float u_intensity;
uniform float u_streaks;
uniform float u_angle;
uniform float u_lengthPx;
uniform float u_falloff;
uniform float u_alternate;
uniform float u_colorize;
uniform float u_opacity;

in vec2 v_uv;
out vec4 out_color;

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
const int MAX_STREAKS = 8;
const int STAR_TAPS = 16;

vec3 starTint(float t, float axisNorm) {
  float phase = t * 0.55 + axisNorm * 0.18;
  return 0.72 + 0.28 * cos(TAU * (vec3(0.0, 0.33, 0.67) + phase));
}

void main() {
  vec3 src = texture(u_source, v_uv).rgb;
  if (u_intensity <= 0.0001 || u_lengthPx <= 0.0001) {
    out_color = vec4(src, 1.0);
    return;
  }

  vec2 invResolution = 1.0 / max(u_resolution, vec2(1.0));
  float axisCount = max(u_streaks, 1.0);
  vec3 glow = vec3(0.0);

  for (int axis = 0; axis < MAX_STREAKS; axis++) {
    float axisIndex = float(axis);
    if (axisIndex >= u_streaks) break;
    float axisNorm = axisIndex / max(axisCount - 1.0, 1.0);
    float angle = u_angle + axisIndex * PI / axisCount;
    vec2 dir = vec2(cos(angle), sin(angle));
    float secondary = mix(1.0, u_alternate, step(0.5, mod(axisIndex, 2.0)));

    for (int tapIndex = 1; tapIndex <= STAR_TAPS; tapIndex++) {
      float tap = float(tapIndex) / float(STAR_TAPS);
      float distancePx = tap * u_lengthPx;
      float tail = pow(1.0 - tap, mix(6.0, 1.15, u_falloff)) * secondary;
      vec2 offset = dir * distancePx * invResolution;

      // Bright canvas is already threshold-masked, so each tap is a single
      // sample — no luma / smoothstep work inside the inner loop.
      vec3 positive = texture(u_image, v_uv + offset).rgb;
      vec3 negative = texture(u_image, v_uv - offset).rgb;
      vec3 tint = starTint(tap, axisNorm);
      positive = mix(positive, positive * tint * 1.35, u_colorize);
      negative = mix(negative, negative * tint * 1.35, u_colorize);

      glow += positive * tail;
      glow += negative * tail;
    }
  }

  glow /= max(axisCount * 1.35, 1.0);
  vec3 lit = src + glow * u_intensity;
  out_color = vec4(mix(src, clamp(lit, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0)), 1.0);
}
`;

export function applyStarGlowMultiPass(input, params) {
  if (!input?.width || !input?.height) return null;
  const intensity = clamp(Number(params?.intensity ?? 100) / 100, 0, 4);
  const lengthPx = clamp(Number(params?.length ?? 64), 1, 192);
  if (intensity <= 0 || lengthPx <= 0) return input;

  const activeRenderer = getRenderer();
  if (!activeRenderer) return null;
  if (
    typeof activeRenderer.ensureMipChain !== "function" ||
    typeof activeRenderer.renderPass !== "function" ||
    typeof activeRenderer.uploadInput !== "function" ||
    typeof activeRenderer.captureOutput !== "function"
  ) {
    return null;
  }

  // Star-glow only needs a single scratch FBO at full resolution, so we
  // borrow mip[0] from the shared mip chain. ensureMipChain re-sizes the
  // existing entry when bloom runs after with a deeper chain.
  const mip = activeRenderer.ensureMipChain(input.width, input.height, 1);
  if (!mip || mip.length < 1) return null;

  const sourceTex = activeRenderer.uploadInput(input);
  if (!sourceTex) return null;

  if (!activeRenderer.renderPass(STAR_GLOW_BRIGHT_SHADER, sourceTex, mip[0].width, mip[0].height, mip[0], {
    uniforms: {
      u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
      u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
      u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
    },
  })) return null;

  activeRenderer.resizeBackingCanvas(input.width, input.height);
  if (!activeRenderer.renderPass(STAR_GLOW_STREAK_SHADER, mip[0].texture, input.width, input.height, null, {
    uniforms: {
      u_intensity: intensity,
      u_streaks: clamp(Math.round(Number(params?.streaks ?? 4)), 1, 8),
      u_angle: ((Number(params?.angle ?? 0) / 180) * Math.PI),
      u_lengthPx: lengthPx,
      u_falloff: clamp(Number(params?.falloff ?? 80) / 100, 0.05, 1),
      u_alternate: clamp(Number(params?.alternate ?? 100) / 100, 0, 1),
      u_colorize: clamp(Number(params?.colorize ?? 0) / 100, 0, 1),
      u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
    },
    extraTextures: { u_source: sourceTex },
  })) return null;

  return activeRenderer.captureOutput(input.width, input.height);
}

export function applyHalationMultiPass(input, params) {
  if (!input?.width || !input?.height) return null;
  const radius = clamp(Number(params?.radius ?? 24), 0, 96);
  const intensity = clamp(Number(params?.intensity ?? 120) / 100, 0, 4);
  if (radius <= 0 || intensity <= 0) return input;
  const opacity = clamp(Number(params?.opacity ?? 100) / 100, 0, 1);
  const tint = params?.tintColor
    ? hexToRgb01(params.tintColor, [1, 0.47, 0.24])
    : [
        clamp(Number(params?.tintR ?? 255) / 255, 0, 1),
        clamp(Number(params?.tintG ?? 120) / 255, 0, 1),
        clamp(Number(params?.tintB ?? 60) / 255, 0, 1),
      ];
  return runBrightMipPipeline(input, HALATION_THRESHOLD_SHADER, {
    u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
    u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
    u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
    u_tint: tint,
  }, radius, intensity, opacity);
}

function getProgram(gl, programs, vertexShader, fragmentSource) {
  const cached = programs.get(fragmentSource);
  if (cached) return cached;

  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!fragmentShader) return null;

  const handle = gl.createProgram();
  gl.attachShader(handle, vertexShader);
  gl.attachShader(handle, fragmentShader);
  gl.linkProgram(handle);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
    console.warn("[gpu-effects] program link failed", gl.getProgramInfoLog(handle));
    gl.deleteProgram(handle);
    return null;
  }

  const program = { handle, uniforms: new Map() };
  programs.set(fragmentSource, program);
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[gpu-effects] shader compile failed", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function applyUniforms(gl, program, uniforms) {
  for (const [name, value] of Object.entries(uniforms ?? {})) {
    const location = getUniformLocation(gl, program, name);
    if (location === null) continue;
    // Typed array uniforms: a uniform builder can return
    // { type: "vec3[]" | "vec4[]" | "float[]", data: Float32Array }
    // to bind a uniform array in one call instead of per-element.
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.type === "string") {
      const data = value.data;
      if (!data) continue;
      if (value.type === "vec4[]") gl.uniform4fv(location, data);
      else if (value.type === "vec3[]") gl.uniform3fv(location, data);
      else if (value.type === "vec2[]") gl.uniform2fv(location, data);
      else if (value.type === "float[]") gl.uniform1fv(location, data);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
      else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3]);
    } else {
      gl.uniform1f(location, Number(value) || 0);
    }
  }
}

function getUniformLocation(gl, program, name) {
  if (!program.uniforms.has(name)) {
    program.uniforms.set(name, gl.getUniformLocation(program.handle, name));
  }
  return program.uniforms.get(name);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Adaptive tap budget for the bloom / halation disk. With a fixed 24-tap
// spiral the disk gets too sparse past ~radius 30, surfacing as a halftone
// ring pattern around bright clusters. Scale roughly with radius and cap at
// the shader's MAX_TAPS so the loop bound stays compile-time-bounded.
function bloomDiskTapCount(radius) {
  return clamp(Math.round(radius * 1.5 + 16), 24, 96);
}

function colorModeIndex(value) {
  // Accept legacy "color" alias from the early Halftone build so saved
  // projects don't lose their setting after this rename.
  const normalized = String(value ?? "mono").toLowerCase();
  if (normalized === "cmyk") return 2;
  if (normalized === "cmy" || normalized === "color") return 1;
  return 0;
}

function shapeIndex(value) {
  const normalized = String(value ?? "circle").toLowerCase();
  if (normalized === "square") return 1;
  if (normalized === "diamond") return 2;
  return 0;
}

function ledSubpixelModeIndex(value) {
  const normalized = String(value ?? "rgb").toLowerCase();
  if (normalized === "off" || normalized === "none") return 0;
  if (normalized === "bgr") return 2;
  if (normalized === "triad") return 3;
  return 1;
}

function ledShapeIndex(value) {
  const normalized = String(value ?? "round").toLowerCase();
  if (normalized === "square") return 1;
  if (normalized === "slot") return 2;
  return 0;
}

function modulationChannelModeIndex(value) {
  const normalized = String(value ?? "rgb").toLowerCase();
  return normalized === "luma" ? 0 : 1;
}

function maskIndex(value) {
  const normalized = String(value ?? "aperture").toLowerCase();
  if (normalized === "none") return 0;
  if (normalized === "slot") return 2;
  return 1; // aperture default
}

function patternIndex(value) {
  const normalized = String(value ?? "bayer-4x4").toLowerCase();
  if (normalized === "none") return 0;
  if (normalized === "bayer-2x2") return 1;
  if (normalized === "bayer-4x4") return 2;
  if (normalized === "bayer-8x8") return 3;
  if (normalized === "blue-noise") return 4;
  if (normalized === "white-noise") return 5;
  return 2; // bayer-4x4 fallback
}

function thresholdChannelIndex(value) {
  const normalized = String(value ?? "luma").toLowerCase();
  if (normalized === "r" || normalized === "red") return 1;
  if (normalized === "g" || normalized === "green") return 2;
  if (normalized === "b" || normalized === "blue") return 3;
  if (normalized === "max") return 4;
  return 0; // luma default
}

function gradientMapModeIndex(value) {
  const normalized = String(value ?? "luma").toLowerCase();
  if (normalized === "r" || normalized === "red") return 1;
  if (normalized === "g" || normalized === "green") return 2;
  if (normalized === "b" || normalized === "blue") return 3;
  return 0;
}
