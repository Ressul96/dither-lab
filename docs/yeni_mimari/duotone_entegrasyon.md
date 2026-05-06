# Duotone Node Entegrasyon Planı

> **Karar:** Duotone bağımsız bir `Color` node olmalı. Dither node içine
> gömülmemeli; dither sonrası duotone gerekiyorsa graph zinciriyle kurulmalı.

Duotone, görüntünün luminance/sinyal değerini iki renk arasında remap eder.
Dithering yapmaz, pürüzsüz color grading aracıdır.

---

## 1. Node Tanımı

```javascript
duotone: {
  label: "Duotone",
  family: "Color",
  description: "Maps image luminance to a two-color gradient.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    shadowColor: "#101010",
    highlightColor: "#f4b642",
    redGamma: 100,
    greenGamma: 100,
    blueGamma: 100,
    opacity: 100,
  },
}
```

Önerilen bounds:

```javascript
duotone: {
  redGamma: { min: 10, max: 500 },
  greenGamma: { min: 10, max: 500 },
  blueGamma: { min: 10, max: 500 },
  opacity: { min: 0, max: 100 },
}
```

Gamma state'te yüzde olarak tutulur. `100 = 1.00`.

---

## 2. UI

P1 için iki renk kontrolü yeterlidir:

- Shadow color.
- Highlight color.
- Red/Green/Blue gamma.
- Opacity.

Mevcut inspector'da genel color field primitive'i yoksa önce küçük, reusable
bir color field eklenmeli:

- `<input type="color">`
- yanında HEX text input veya readout.
- state değeri `#rrggbb`.

Bu kontrol ileride `gradient-map`, `halation` tint ve diğer color node'lar için
de kullanılabilir.

---

## 3. CPU/GPU Davranışı

Duotone GPU için ucuzdur; CPU fallback de kolaydır.

Matematik:

```javascript
const adjusted = {
  r: Math.pow(src.r, 1 / redGamma),
  g: Math.pow(src.g, 1 / greenGamma),
  b: Math.pow(src.b, 1 / blueGamma),
};
const luma = dot(adjusted, LUMA_W);
const mapped = mix(shadowColor, highlightColor, luma);
const out = mix(src, mapped, opacity);
```

Not:

- Gamma kontrolleri kanal duyarlılığı verir.
- Bu maskeleme değildir; yalnızca luma hesaplamasına kanal ağırlığı etkisi
  kazandırır.
- `opacity` source ile sonucu karıştırır.

---

## 4. Gradient Map İlişkisi

Duotone aslında iki stop'lu Gradient Map olarak görülebilir. Yine de ayrı node
olarak anlamlıdır:

- Daha hızlı ve sade UI.
- Albüm kapağı / poster workflow'u.
- Dither içine gömülmeden kullanılabilir.

İleride `gradient-map` altyapısı geldiğinde Duotone aynı helper'ı kullanabilir,
ama P1'de iki renkli doğrudan implementasyon yeterlidir.

---

## 5. Uygulama Sırası

### P1 - Bağımsız Node

- `graph.js` node tanımı ve bounds.
- `graph-runtime.js` route.
- `image-ops.js` CPU implementation.
- İstenirse `gpu-effects.js` shader pass.
- `graph-shell.js` color field + gamma/opacity inspector.

### P2 - Presetler

- Warm Poster.
- Cyan/Red.
- Noir Gold.
- Midnight Blue.

### P3 - Shared Gradient Helper

- `gradient-map` ile LUT/helper ortaklaştırma.

---

## 6. Kabul Kriterleri

- Duotone, Dither node parametresi değildir.
- `dither -> duotone` zinciri doğal çalışır.
- Renkler project JSON içinde HEX olarak saklanır.
- `opacity: 0` source'u değiştirmez.
- CPU/GPU yolları aynı görünüme yakın sonuç üretir.
