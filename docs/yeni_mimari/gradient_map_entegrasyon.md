# Gradient Map Node Entegrasyon Planı

> **Karar:** `gradient-map` yeni bir `Color` node olarak eklenebilir. Temel
> yatırım, renk duraklarını tek bir ortak gradient LUT altyapısına dönüştürmek
> olmalı; bu altyapı ileride `star-glow` gibi efektlerle paylaşılabilir.

Gradient Map, source luminance değerini kullanıcı tanımlı renk geçişine map
eder. Termal kamera, topografik contour, poster color grading ve psikedelik
renk akışları için uygundur.

---

## 1. Node Tanımı

```javascript
"gradient-map": {
  label: "Gradient Map",
  family: "Color",
  description: "Maps image luminance to a custom color gradient.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    stops: [
      { color: "#111111", pos: 0 },
      { color: "#ffffff", pos: 1 },
    ],
    shift: 0,
    repeat: 1,
    mode: "luma", // future: "luma" | "r" | "g" | "b"
    opacity: 100,
  },
}
```

Önerilen bounds:

```javascript
"gradient-map": {
  shift: { min: -100, max: 100 },
  repeat: { min: 1, max: 20 },
  opacity: { min: 0, max: 100 },
}
```

Eski taslaklardaki `gradientMap` adı yerine `stops` daha genel ve okunabilir
bir project formatı sağlar.

---

## 2. Ortak Gradient LUT

`gradient-map` ve `star-glow` aynı gradient altyapısını paylaşmalı.

Önerilen modül:

```text
src/js/gradient-lut.js
```

Önerilen API:

```javascript
export function normalizeGradientStops(stops) {}
export function sampleGradient(stops, t) {}
export function buildGradientLut(stops, options = {}) {} // 256x1 canvas veya Uint8Array
```

P1'de midpoint/easing zorunlu değildir. Önce durak pozisyonu + lineer
interpolation doğru çalışmalı.

P2:

- Midpoint diamond.
- Segment easing.
- Stop duplicate/delete.
- Presets.

---

## 3. Inspector UI

Mevcut `graph-shell.js` içinde generic gradient editor yok. Bu yüzden ilk
uygulama kontrollü başlamalı:

P1 seçenekleri:

- Basit iki renkli gradient: `shadowColor`, `highlightColor`.
- Veya özel `renderGradientMapNode` içinde sınırlı multi-stop editor.

Tercih:

- Eğer genel gradient editor hemen yapılmayacaksa, `gradient-map` P1'i iki renk
  + repeat/shift ile başlatmak daha güvenlidir.
- Multi-stop editor yazılacaksa aynı bileşen `star-glow` tarafından da
  kullanılmalıdır.

---

## 4. Shader Davranışı

Gradient map GPU için çok uygundur:

```glsl
vec3 src = texture(u_image, v_uv).rgb;
float luma = dot(src, vec3(0.299, 0.587, 0.114));
float t = fract(luma * u_repeat + u_shift);
vec3 mapped = texture(u_gradientLut, vec2(t, 0.5)).rgb;
out_color = vec4(mix(src, mapped, u_opacity), 1.0);
```

Notlar:

- `repeat` contour/topographic görünümü üretir.
- `shift` animasyon için uygundur ama P1 statik kalabilir.
- Animasyon eklenirse node time-aware yapılmalı ve `context.timeSeconds`
  kullanılmalıdır.

---

## 5. Uygulama Sırası

### P1 - İki Renk / LUT Temeli

- Node tanımı.
- `gradient-lut.js` helper.
- GPU shader pass ve extra sampler.
- Inspector iki renk + repeat/shift/opacity.

### P2 - Multi-Stop Editor

- Stop ekleme/silme/sürükleme.
- Midpoint/easing desteği.
- `star-glow` ile ortak kullanım.

### P3 - Animasyon

- `animate: "off" | "shift"`.
- Deterministik time kullanımı.

---

## 6. Kabul Kriterleri

- Node `Color` ailesinde görünür.
- `inputs/outputs` `name` standardını kullanır.
- GPU yoksa CPU fallback veya pass-through stratejisi net olur.
- Gradient LUT tek helper'dan üretilir.
- Multi-stop editor gelmeden de P1 kullanılabilir bir renk map üretir.
