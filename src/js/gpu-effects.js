// Tiny WebGL2 fullscreen-quad runtime for shader-based effects.
// Each pass is just (fragmentSource, uniformBuilder) — applyShaderPass picks
// the registry entry, uploads the input texture, and copies the output back to
// a 2D canvas so the rest of the graph can stay agnostic about WebGL.

import { hexToRgb01 } from "./color.js";

const FULLSCREEN_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
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

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

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
uniform float u_wave;         // horizontal jitter in pixels
uniform float u_vignette;     // 0-1
uniform float u_saturation;   // 0-2 pre-process saturation
uniform float u_bleed;        // 0-1 chroma blur (Y/C separation)

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
  float lumaBase = dot(base, vec3(0.299, 0.587, 0.114));
  float lumaBlur = dot(blurred, vec3(0.299, 0.587, 0.114));
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
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, u_saturation);

  // Vignette darkens corners
  vec2 vp = uv - 0.5;
  float vignetteMask = smoothstep(0.85, 0.18, length(vp) * 1.45);
  col *= mix(1.0, vignetteMask, u_vignette);

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

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

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

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

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

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

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

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

void main() {
  // Snap each output pixel to its containing cell on the ASCII grid.
  // Cell size is in pixels of the input resolution.
  vec2 pixel = v_uv * u_resolution;
  vec2 cellPx = floor(pixel / u_cellSize) * u_cellSize;
  vec2 cellCenter = (cellPx + u_cellSize * 0.5) / u_resolution;

  vec3 src = texture(u_image, cellCenter).rgb;
  float luma = dot(src, LUMA_W);
  if (u_invert > 0.5) luma = 1.0 - luma;

  // Pick glyph index from the ramp [0, count-1] based on luminance buckets.
  float glyphIdx = floor(clamp(luma, 0.0, 0.99999) * u_atlasCount);

  // UV within this cell, in [0, 1]. The glyph atlas is laid out as a single
  // row of square glyphs, so we just shift x by the glyph index and divide
  // by the total count.
  vec2 cellUv = (pixel - cellPx) / u_cellSize;
  vec2 atlasUv = vec2((glyphIdx + cellUv.x) / u_atlasCount, cellUv.y);
  float coverage = texture(u_atlas, atlasUv).r;

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

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);
const int TAPS = 24;
const float GOLDEN = 2.39996323;

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

  // Same golden-spiral disk as Bloom, but we accumulate brightness only —
  // not the source color. Halation is defined by a uniform tint over the
  // bloom mass (film backing red glow / CRT phosphor red leak), so the
  // per-tap source color must be discarded.
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i);
    float angle = fi * GOLDEN;
    float r = sqrt((fi + 0.5) / float(TAPS));
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

in vec2 v_uv;
out vec4 out_color;

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);
const int TAPS = 24;
// Golden ratio in radians (137.5°). Picks an "incommensurate" angle so
// successive samples in the spiral never line up — spreads tap energy
// uniformly across the disk and avoids visible banding from regular grids.
const float GOLDEN = 2.39996323;

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

  // Golden-spiral sampling across the unit disk; closer taps weigh more
  // so the bloom feels like a proper Gaussian even though we're doing it
  // in a single pass.
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i);
    float angle = fi * GOLDEN;
    float r = sqrt((fi + 0.5) / float(TAPS));
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

const vec3 LUMA_W = vec3(0.299, 0.587, 0.114);

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
  if (typeof document === "undefined") return null;
  const size = Math.max(8, Math.round(glyphSize));
  const canvas = document.createElement("canvas");
  canvas.width = ramp.length * size;
  canvas.height = size;
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
  bloom: {
    fragment: BLOOM_FRAGMENT_SHADER,
    uniforms(params) {
      return {
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
        u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
        u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
        u_intensity: clamp(Number(params?.intensity ?? 100) / 100, 0, 4),
        u_radius: clamp(Number(params?.radius ?? 16), 0, 64),
        u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
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
      return {
        u_opacity: clamp(Number(params?.opacity ?? 100) / 100, 0, 1),
        u_threshold: clamp(Number(params?.threshold ?? 70) / 100, 0, 1),
        u_knee: clamp(Number(params?.knee ?? 20) / 100, 0, 0.5),
        u_intensity: clamp(Number(params?.intensity ?? 120) / 100, 0, 4),
        u_radius: clamp(Number(params?.radius ?? 24), 0, 96),
        u_saturation: clamp(Number(params?.saturation ?? 100) / 100, 0, 2),
        u_tint: tint,
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

export function applyChromaticAberrationGpu(input, params) {
  return applyShaderPass("chromatic-aberration", input, params);
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
  return applyShaderPass("bloom", input, params);
}

export function applyHalationGpu(input, params) {
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

export function applyThresholdGpu(input, params) {
  return applyShaderPass("threshold", input, params);
}

function getRenderer() {
  if (renderer !== null) return renderer;
  renderer = createRenderer();
  return renderer;
}

function createRenderer() {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
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

  return {
    render(fragmentSource, input, uniforms, textures) {
      if (!input?.width || !input?.height) return null;
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

      const output = document.createElement("canvas");
      output.width = input.width;
      output.height = input.height;
      const ctx = output.getContext("2d", { alpha: false, willReadFrequently: false });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      return output;
    },
  };
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
