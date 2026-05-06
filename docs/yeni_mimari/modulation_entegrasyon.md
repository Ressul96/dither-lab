# Modulation Node Entegrasyon Planı

> **Karar:** `modulation` yeni bir GPU-first `Effect` node olabilir. Görevi,
> kaynak görüntünün luma/RGB sinyalini çizgi dalgalarının fazına bindirerek
> engraving, scanline ve rainbow moire benzeri grafik efektler üretmektir.

Bu node mevcut `pattern-dither`, `halftone`, `vhs` veya `led-screen` yerine
geçmez. Daha çok sinyal tabanlı çizgi üretimi alanında durur.

---

## 1. Node Tanımı

Proje standardı `name` tabanlı input/output kullanır:

```javascript
modulation: {
  label: "Modulation",
  family: "Effect",
  description: "Draws phase-modulated line signals from image luminance or RGB channels.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    frequency: 80,
    sensitivity: 35,
    thickness: 18,
    angle: 0,
    channelMode: "rgb", // "luma" | "rgb"
    sourceMix: 0,
    invert: "off",
    opacity: 100,
  },
}
```

Önerilen bounds:

```javascript
modulation: {
  frequency: { min: 4, max: 320 },
  sensitivity: { min: 0, max: 200 },
  thickness: { min: 1, max: 100 },
  angle: { min: -180, max: 180 },
  sourceMix: { min: 0, max: 100 },
  opacity: { min: 0, max: 100 },
}
```

`family: "Stylize"` kullanılmamalı; mevcut aileler içinde `Effect` doğru yer.

---

## 2. Shader Davranışı

Temel fikir:

- UV, `angle` ile 1D çizgi eksenine projekte edilir.
- Base sine wave üretilir.
- Source luma veya RGB kanal değeri phase offset olarak eklenir.
- Sinyal `thickness` ile çizgi maskesine dönüşür.
- Sonuç source ile karıştırılır.

`channelMode === "luma"`:

- Tek monokrom sinyal üretir.
- Engraving / woodcut hissi için daha okunaklıdır.

`channelMode === "rgb"`:

- R/G/B kanalları ayrı phase offset alır.
- Rainbow moire / RGB separation üretir.

---

## 3. GLSL Taslağı

```glsl
vec3 src = texture(u_image, v_uv).rgb;
float rad = u_angle;
vec2 dir = vec2(cos(rad), sin(rad));
float t = dot(v_uv, dir);
float base = t * u_frequency * 6.2831853;

float lineMask(float phase) {
  float wave = sin(phase) * 0.5 + 0.5;
  float edge = max(u_thickness, 0.001);
  return smoothstep(1.0 - edge, 1.0, wave);
}

vec3 signal;
if (u_channelMode < 0.5) {
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  float m = lineMask(base + luma * u_sensitivity);
  signal = vec3(m);
} else {
  signal = vec3(
    lineMask(base + src.r * u_sensitivity),
    lineMask(base + src.g * u_sensitivity),
    lineMask(base + src.b * u_sensitivity)
  );
}

if (u_invert > 0.5) signal = 1.0 - signal;
vec3 mixed = mix(signal, src, u_sourceMix);
out_color = vec4(mix(src, mixed, u_opacity), 1.0);
```

---

## 4. Time Kullanımı

P1 statik olmalı. Animasyon P2'ye bırakılmalı:

```javascript
animate: "off" | "phase",
speed: 100,
```

Animasyon eklenirse node `TIME_AWARE_TYPES` set'ine alınmalı ve yalnızca
`context.timeSeconds` kullanılmalıdır. Preview/export determinism korunmalıdır.

---

## 5. Uygulama Sırası

### P1 - Statik Modulation

- `graph.js` node tanımı ve bounds.
- `gpu-effects.js` shader pass.
- `image-ops.js` wrapper: GPU output, yoksa pass-through.
- `graph-runtime.js` switch case.
- Inspector: General / Signal section'ları.

### P2 - Animasyon

- Phase scroll.
- Deterministik time salt.
- Export parity testi.

### P3 - Advanced Modes

- Radial modulation.
- Dual-axis cross modulation.
- Blend modes.

---

## 6. Kabul Kriterleri

- Tek pass shader olarak çalışır.
- `luma` ve `rgb` modları ayrıdır.
- Varsayılan değerler aşırı moire üretmez.
- WebGL2 yoksa input pass-through olur.
- Animasyon eklenirse deterministic frame davranışı korunur.
