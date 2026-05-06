# Depth of Field Node Entegrasyon Planı

> **Karar:** `depth-of-field` yeni bir `Effect` node olabilir, ancak P1
> hedefi fiziksel lens simülasyonunun tamamı değil; kontrollü, performanslı ve
> debug edilebilir bir odak maskesi + blur/bokeh temelidir.

Bu belge, Effect App tarafındaki Depth of Field fikrini Dither Lab'in mevcut
GPU-first efekt mimarisine uyarlama planıdır.

---

## 1. Mevcut Sistemle İlişki

Yakın node'lar:

- `blur`: Basit tüm görüntü blur.
- `glare` / `halation`: Parlak alan glow/bloom.
- `lens-distort`: Optik distortion ve center parametreleri.

`depth-of-field` bunların yerine geçmez. Görevi, odak alanı dışını seçici
şekilde blur etmek ve ileride bokeh karakteri eklemektir.

Family değeri `Effect` olmalı. Yeni `Blur` familyası açılmamalı.

---

## 2. Node Tanımı

Proje standardı `name` tabanlı input/output kullanır:

```javascript
"depth-of-field": {
  label: "Depth of Field",
  family: "Effect",
  description: "Blurs areas outside a focus region with optional bokeh shaping.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    centerX: 50,
    centerY: 50,
    radius: 35,
    falloff: 25,
    aspect: 100,
    rotation: 0,
    invert: "off",
    blur: 16,
    samples: 32,
    bokehShape: "round", // "round" | "polygon"
    blades: 6,
    anamorphic: 100,
    debug: "off", // "off" | "mask"
    opacity: 100,
  },
}
```

Önerilen bounds:

```javascript
"depth-of-field": {
  centerX: { min: 0, max: 100 },
  centerY: { min: 0, max: 100 },
  radius: { min: 0, max: 100 },
  falloff: { min: 0, max: 100 },
  aspect: { min: 25, max: 400 },
  rotation: { min: -180, max: 180 },
  blur: { min: 0, max: 80 },
  samples: { min: 8, max: 64 },
  blades: { min: 3, max: 12 },
  anamorphic: { min: 25, max: 400 },
  opacity: { min: 0, max: 100 },
}
```

---

## 3. UI Kararı

P1'de özel XY Pad zorunlu değildir.

Kullanılacak mevcut kontroller:

- Range fields: `centerX`, `centerY`, `radius`, `falloff`, `blur`, `samples`.
- Select: `invert`, `bokehShape`, `debug`.
- Range: `aspect`, `rotation`, `anamorphic`.

İleride daha iyi kontrol:

- On-canvas point gizmo: `centerX/centerY`.
- On-canvas ellipse gizmo: `radius/aspect/rotation`.

Bu, `gizmo_gelisme.md` ile hizalanmalı. `levels` için tartışılan XY Pad bu
node'un ön koşulu değildir.

---

## 4. Shader Stratejisi

DoF pahalıdır. `samples: 100` gibi değerler P1 için önerilmez. Başlangıçta
32 örnek civarı, tek pass ve erken çıkış mantığı hedeflenmelidir.

Akış:

1. Focus mask hesaplanır.
2. Debug açıksa mask output edilir.
3. Mask çok düşükse source okunup çıkılır.
4. Vogel spiral veya disk sample ile blur hesaplanır.
5. Sonuç source ile `opacity` kadar karıştırılır.

P1 bokeh:

- Round disk sampling.
- Optional polygon shape yalnızca sample weight/mask düzeyinde.

P2/P3:

- Catadioptric/donut bokeh.
- Highlight weighting.
- Separate near/far mask.

---

## 5. Performans Kuralları

- GPU-first olmalı.
- WebGL2 yoksa pass-through kabul edilir.
- `samples` üst sınırı UI'da sıkı tutulmalı.
- Playback quality `auto` iken downscaled preview zaten yardımcı olur, ama
  paused/export full-res davranışı maliyetli kalabilir.
- Shader'da loop count mümkün olduğunca compile-time friendly sınırlarla
  çalışmalı.

---

## 6. Uygulama Sırası

### P1 - Focus Blur

- Node tanımı, bounds ve palette girişi.
- GPU wrapper ve runtime route.
- Radial/elliptical focus mask.
- Debug mask.
- Round sample blur.

### P2 - Gizmo ve UI Polish

- `centerX/centerY` point gizmo.
- Focus ellipse overlay.
- Inspector section'ları: Focus / Blur / Debug.

### P3 - Fiziksel Bokeh

- Blade count / polygon aperture.
- Anamorphic stretch.
- Highlight weighting.
- Catadioptric donut yalnızca performans kabul edilirse.

---

## 7. Kabul Kriterleri

- Node `Effect` ailesinde görünür.
- Eski node'ların davranışı değişmez.
- `debug: "mask"` focus mask'i anlaşılır gösterir.
- `samples` düşük değerlerde akıcı preview verir.
- WebGL2 yoksa graph kırılmaz.
- Gizmo gelmeden de inspector ile tüm parametreler kontrol edilir.
