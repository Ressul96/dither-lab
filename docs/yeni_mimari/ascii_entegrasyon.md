# ASCII Node İyileştirme Planı

> **Karar:** `ascii` node'u zaten GPU tabanlı ve glyph atlas cache kullanıyor.
> Yeni çalışma shader'ı baştan yazmak değil, mevcut atlas/shader yolunu
> kademeli olarak daha kontrollü hale getirmek olmalı.

Bu belge, Shader Lab tarzı glyph dither özelliklerini Dither Lab'in mevcut
ASCII node'una ekleme planıdır.

---

## 1. Mevcut Durum

Mevcut node:

```javascript
ascii: {
  label: "ASCII",
  family: "Effect",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    opacity: 100,
    cellSize: 8,
    ramp: "standard",
    invert: "off",
    colorMode: "source",
  },
}
```

Mevcut GPU yolu:

- `ASCII_FRAGMENT_SHADER`.
- Glyph atlas texture.
- `cellSize` ile birebir atlas glyph boyutu.
- `ramp` presetleri.
- `colorMode: source | mono`.

Bu temel korunmalı.

---

## 2. P1 İyileştirmeleri

P1 için düşük riskli parametreler:

```javascript
signalBlack: 0,
signalWhite: 100,
signalGamma: 100,
presenceThreshold: 0,
presenceSoftness: 0,
```

Amaç:

- Luma sinyalini glyph seçmeden önce şekillendirmek.
- Çok karanlık alanlarda glyph basmayı azaltmak.
- Mevcut ramp/atlas davranışını bozmadan kontrast kontrolü vermek.

Shader mantığı:

```glsl
float range = max(u_signalWhite - u_signalBlack, 0.001);
float shaped = pow(clamp((luma - u_signalBlack) / range, 0.0, 1.0), 1.0 / u_signalGamma);
float presence = smoothstep(u_presenceThreshold - u_presenceSoftness,
                            u_presenceThreshold + u_presenceSoftness,
                            shaped);
```

`invert` davranışı bu sinyal shaping ile çakışmayacak şekilde sıralanmalıdır.

---

## 3. P2 Direction Bias

Kenar algılama faydalı ama pahalıdır; her hücre için ekstra texture sample
gerektirir.

Parametre:

```javascript
directionBias: 0, // 0-100
```

Uygulama:

- Hücre merkezinin sağ/sol/üst/alt komşuları okunur.
- Gradient magnitude hesaplanır.
- Glyph seçim sinyali luma ile gradient arasında mix edilir.

Bu özellik varsayılanda kapalı kalmalı.

---

## 4. P3 Shimmer

Animasyon eklenecekse deterministik olmalı.

Parametreler:

```javascript
shimmerAmount: 0,
shimmerSpeed: 100,
seed: 1,
```

Kurallar:

- Node `TIME_AWARE_TYPES` set'ine eklenir.
- Shader yalnızca `context.timeSeconds` kullanır.
- Aynı frame preview/export'ta aynı shimmer sonucunu üretir.
- Varsayılan değer `0`, eski projeleri değiştirmez.

Serbest `performance.now()` fallback'i export parity için kullanılmamalı.

---

## 5. Atlas Keskinliği

Atlas'ı 1-bit hale getirmek her durumda iyi değildir. Anti-aliasing küçük
cell size'larda okunabilirliği artırır.

P2/P3 seçeneği olarak eklenebilir:

```javascript
atlasMode: "smooth" | "crisp"
```

`crisp`:

- Atlas rasterize edildikten sonra threshold uygulanır.
- Küçük cell size'larda karakterler kopabilir; test gerekir.

Varsayılan `smooth` kalmalı.

---

## 6. Uygulama Sırası

### P1 - Signal Shaping

- Node params ve bounds.
- Shader uniforms.
- Inspector section: Signal.
- Eski görünüm varsayılanda değişmez.

### P2 - Direction Bias ve Atlas Mode

- Ek sample maliyeti ölçülür.
- `directionBias` default 0.
- `atlasMode` cache key'e dahil edilir.

### P3 - Shimmer

- Time-aware cache.
- Deterministik shader noise.
- Export parity testi.

---

## 7. Kabul Kriterleri

- Mevcut ASCII projeleri aynı görünür.
- Atlas cache yeni parametrelerle yanlış paylaşılmaz.
- Signal shaping glyph seçimini kontrol eder ama ramp sistemini bozmaz.
- Shimmer eklendiğinde preview/export deterministiktir.
- WebGL2 yoksa mevcut pass-through davranışı korunur.
