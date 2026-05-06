# LED Screen Node Entegrasyon Planı

> **Karar:** `led-screen` yeni bir node olarak eklenebilir, ama Pixelate,
> CRT ve Halftone'un alanına girmemeli. Bu node'un kimliği fiziksel ekran
> simülasyonudur: RGB/BGR subpixel dizilimi, LED diode matrisi, siyah panel
> aralığı ve hafif ışık yayılımı.

Bu belge, `effect.app` tarafındaki LED Screen fikrini Dither Lab'in mevcut GPU
efekt mimarisine uyarlama planıdır. Hedef; dev ekran / jumbotron / LCD
subpixel yakın plan hissini video playback sırasında akıcı çalışacak şekilde
üretmektir.

---

## 1. Mevcut Sistemle İlişki

Dither Lab'de LED Screen'e yakın ama aynı olmayan node'lar var:

- `pixelate`: Görüntüyü hücrelere böler ve hücre merkezinden örnekler.
- `crt` / `analog`: Curvature, scanline, aperture/slot mask ve phosphor hissi
  verir.
- `halftone`: Baskı tramı / CMY-CMYK dot ekranı üretir.

`led-screen` bunların yerini almamalı:

- Pixelate gibi bloklaştırır, ama amacı düşük çözünürlük değil fiziksel panel
  dokusudur.
- CRT gibi RGB mask kullanır, ama curvature, rolling sync ve scanline alanına
  girmez.
- Halftone gibi dot şekilleri çizer, ama baskı değil emissive ekran hissi
  hedefler.

Bu yüzden ayrı bir node olarak anlamlıdır.

---

## 2. Node Tanımı

Proje standardı `name` tabanlı input/output kullanır:

```javascript
"led-screen": {
  label: "LED Screen",
  family: "Effect",
  description: "Simulates physical LED/LCD subpixels with panel gaps and diode glow.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    cellSize: 6,
    gap: 18,
    subpixelMode: "rgb", // "off" | "rgb" | "bgr" | "triad"
    shape: "round",      // "round" | "square" | "slot"
    softness: 35,
    glow: 18,
    brightness: 110,
    opacity: 100,
  },
}
```

Önerilen bounds:

```javascript
"led-screen": {
  cellSize: { min: 2, max: 48 },
  gap: { min: 0, max: 80 },
  softness: { min: 0, max: 100 },
  glow: { min: 0, max: 100 },
  brightness: { min: 25, max: 300 },
  opacity: { min: 0, max: 100 },
}
```

Notlar:

- `transparent` P1'e alınmamalı. Mevcut preview/export hattı RGB ağırlıklı;
  gap alanlarını siyah panel olarak çizmek daha güvenli.
- `rgbMode: true/false` yerine `subpixelMode` kullanılmalı. RGB/BGR ayrımı
  gerçek panel hissi için önemlidir.
- `cellSize` piksel cinsindedir ve input resolution üzerinden hesaplanır.

---

## 3. Inspector UI

Özel canvas UI gerekmez. Mevcut field/select primitive'leri yeterlidir.

Alanlar:

- `Cell Size`: range, piksel.
- `Gap`: range, yüzde.
- `Subpixel`: select veya segmented control (`Off`, `RGB`, `BGR`, `Triad`).
- `Shape`: select (`Round`, `Square`, `Slot`).
- `Softness`: range.
- `Glow`: range.
- `Brightness`: range.
- `Opacity`: range.

UI metni kısa kalmalı; node'un işi parametre adlarından anlaşılmalı.

---

## 4. Shader Davranışı

Shader, Pixelate GPU shader'ındaki cell grid fikrini ödünç alabilir, ama kendi
mask ve subpixel mantığına sahip olmalıdır.

Temel akış:

1. Output pikselinin hangi hücreye düştüğü bulunur.
2. Kaynak renk hücre merkezinden örneklenir.
3. Hücre içi lokal koordinata göre diode / subpixel mask üretilir.
4. `subpixelMode` açıksa lokal X konumuna göre R/G/B veya B/G/R kanal seçilir.
5. Gap alanları siyah panel olarak kalır.
6. Glow ve brightness emissive ekran hissi verir.
7. Sonuç opacity ile source'a karıştırılır.

Shader taslağı:

```glsl
vec2 pixel = v_uv * u_resolution;
vec2 cellSize = vec2(max(u_cellSize, 1.0));
vec2 cell = floor(pixel / cellSize);
vec2 local = fract(pixel / cellSize);
vec2 centerUv = (cell + 0.5) * cellSize / u_resolution;

vec3 src = texture(u_image, v_uv).rgb;
vec3 cellColor = texture(u_image, centerUv).rgb * u_brightness;

float gap = clamp(u_gap, 0.0, 0.8);
float active = 1.0 - gap;
vec2 centered = (local - 0.5) / max(active * 0.5, 0.001);

float diodeMask;
if (u_shape < 0.5) {
  // round
  float d = length(centered);
  diodeMask = 1.0 - smoothstep(1.0 - u_softness, 1.0, d);
} else if (u_shape < 1.5) {
  // square
  float edge = max(abs(centered.x), abs(centered.y));
  diodeMask = 1.0 - smoothstep(1.0 - u_softness, 1.0, edge);
} else {
  // vertical slot
  float edgeX = abs(centered.x);
  float edgeY = abs(centered.y * 0.62);
  diodeMask = 1.0 - smoothstep(1.0 - u_softness, 1.0, max(edgeX, edgeY));
}

vec3 emitted = cellColor;
if (u_subpixelMode > 0.5) {
  float phase = fract(local.x * 3.0);
  float band = floor(local.x * 3.0);
  if (u_subpixelMode < 1.5) {
    // RGB
    emitted = band < 1.0 ? vec3(cellColor.r, 0.0, 0.0)
      : band < 2.0 ? vec3(0.0, cellColor.g, 0.0)
      : vec3(0.0, 0.0, cellColor.b);
  } else {
    // BGR
    emitted = band < 1.0 ? vec3(0.0, 0.0, cellColor.b)
      : band < 2.0 ? vec3(0.0, cellColor.g, 0.0)
      : vec3(cellColor.r, 0.0, 0.0);
  }
}

float glowMask = smoothstep(1.0, 0.0, length(centered)) * u_glow;
vec3 panel = emitted * diodeMask + emitted * glowMask * 0.35;
vec3 result = mix(src, panel, u_opacity);
```

Gerçek shader'da `u_shape` ve `u_subpixelMode` numeric enum olarak bağlanır.

---

## 5. Performans Kararı

`led-screen` GPU-first olmalı.

Neden:

- Hücre, subpixel, mask ve glow hesabı her output pikselinde yapılır.
- Video playback sırasında CPU fallback pahalı olur.
- Mevcut `gpu-effects.js` fullscreen pass mimarisi bu iş için uygundur.

Fallback:

- WebGL2 yoksa node input'u pass-through döndürebilir.
- İleride düşük kaliteli CPU fallback gerekirse sadece still export için
  ayrıca tasarlanır; P1 kapsamına alınmaz.

Performans hedefleri:

- 1080p preview'de playback sırasında stabil çalışmalı.
- `cellSize < 3` gibi yoğun durumlarda shader hâlâ tek pass kalmalı.
- Glow ekstra blur pass gerektirmemeli; P1 glow mask içi emissive lift olarak
  hesaplanmalı.

---

## 6. Uygulama Sırası

### P1 - Temel LED Screen

- `graph.js` node tanımı ve bounds eklenir.
- `index.html` node palette'e Effect grubu altında eklenir.
- `graph-runtime.js` route eklenir.
- `image-ops.js` içinde GPU-first wrapper eklenir.
- `gpu-effects.js` shader pass eklenir.
- Inspector render fonksiyonu mevcut field primitive'leriyle yazılır.

### P2 - Panel Kalitesi

- `triad` subpixel modu eklenir.
- `shape: slot` görünümü cilalanır.
- Brightness / glow aşırı değerlerde clamp edilir.
- Opacity source mix davranışı test edilir.

### P3 - Presetler

- `LCD Macro`
- `Jumbotron`
- `RGB Matrix`
- `Soft OLED`
- `Broken Panel` için ileride optional noise/failure parametreleri

---

## 7. Kabul Kriterleri

- Node type `led-screen` olarak kaydedilir ve eski node'larla çakışmaz.
- Pixelate, CRT ve Halftone davranışları değiştirilmez.
- `subpixelMode: off` hücre/diyot ekranı verir; `rgb/bgr` fiziksel subpixel
  ayrımını gösterir.
- Gap alanları P1'de siyah panel olarak görünür.
- Effect opacity source ile karışır.
- WebGL2 yoksa graph kırılmaz; node pass-through çalışır.
- 1080p video preview'de tek shader pass ile akıcı kalır.
