# Pixel Sorting Entegrasyon Planı

> **Karar:** `pixel-sorting` yeni bir `Effect` node olabilir, ama gerçek pixel
> sorting ile tek pass glitch approximation ayrımı net yazılmalı. WebGL2
> fragment shader içinde tam sıralama beklenmemelidir.

Pixel sorting, luminance veya renk eşiklerine göre satır/sütun segmentlerini
sıralayan glitch estetiğidir. Gerçek algoritma segment bulma + sort gerektirir;
bu genellikle CPU veya multi-pass GPU işi olur.

---

## 1. Node Tanımı

```javascript
"pixel-sorting": {
  label: "Pixel Sorting",
  family: "Effect",
  description: "Creates threshold-based sorted/glitch streaks along an axis.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    mode: "glitch", // "glitch" | future "true-sort"
    threshold: 50,
    softness: 10,
    angle: 0,
    length: 24,
    iterations: 8,
    channel: "luma", // "luma" | "r" | "g" | "b" | "max"
    direction: "bright", // "bright" | "dark"
    opacity: 100,
  },
}
```

Bounds:

```javascript
"pixel-sorting": {
  threshold: { min: 0, max: 100 },
  softness: { min: 0, max: 50 },
  angle: { min: -180, max: 180 },
  length: { min: 1, max: 256 },
  iterations: { min: 1, max: 32 },
  opacity: { min: 0, max: 100 },
}
```

`family: "Stylize"` kullanılmamalı; mevcut aileler içinde `Effect` doğru yer.

---

## 2. İki Uygulama Seviyesi

### P1 - Glitch Approximation

Tek pass shader:

- Axis boyunca birkaç komşu sample alınır.
- Eşik maskesiyle parlak/koyu pikseller uzatılır.
- Tam sort değil, sort benzeri erime/glitch streak üretir.

Avantaj:

- Video preview için hızlı.
- WebGL2 fullscreen pass ile uygulanabilir.

Sınırlama:

- Segment içindeki pikseller gerçekten sıralanmaz.
- Dokümanda ve UI'da "true sort" diye sunulmamalı.

### P3 - True Sort

Gerçek pixel sorting:

- CPU still-image path veya worker.
- Ya da multi-pass GPU ping-pong yaklaşımı.
- Satır/sütun segment detection.
- Büyük görüntülerde pahalıdır.

Bu P1 kapsamı değildir.

---

## 3. Shader Approximation Taslağı

```glsl
vec3 src = texture(u_image, v_uv).rgb;
float srcKey = channelValue(src);
float mask = thresholdMask(srcKey);

vec3 best = src;
float bestKey = srcKey;
for (int i = 1; i <= MAX_ITER; i++) {
  if (i > u_iterations) break;
  vec2 uv = v_uv - u_dir * float(i) * u_lengthPx / u_resolution;
  vec3 candidate = texture(u_image, uv).rgb;
  float key = channelValue(candidate);
  float candidateMask = thresholdMask(key);
  if (candidateMask > 0.0 && key > bestKey) {
    best = candidate;
    bestKey = key;
  }
}

vec3 result = mix(src, best, mask * u_opacity);
```

Bu "bright pull" davranışı üretir. `direction: "dark"` için karşılaştırma ters
çevrilir.

---

## 4. CPU / Worker Notu

Gerçek sort istendiğinde CPU/Worker yolu daha doğru olabilir:

- Her satır veya sütun taranır.
- Threshold segmentleri bulunur.
- Segment içindeki pikseller luminance/channel key'e göre sıralanır.
- Sonuç ImageData olarak yazılır.

Bu işlem video playback için pahalıdır. Still export veya paused preview için
opsiyonel olabilir.

---

## 5. Uygulama Sırası

### P1 - GPU Glitch Sort

- Node tanımı ve bounds.
- GPU pass.
- Wrapper ve runtime route.
- UI'da mode adı "Glitch Sort" gibi dürüst olur.

### P2 - Direction ve Mask Kalitesi

- `channel`, `direction`, `softness`.
- Angle snapping opsiyonları.
- Source mix/opacity.

### P3 - True Sort Denemesi

- Worker CPU prototype.
- Sadece still/paused path.
- Büyük frame maliyeti ölçülür.

---

## 6. Kabul Kriterleri

- P1 tek pass ve hızlıdır.
- UI gerçek sort vadetmez.
- WebGL2 yoksa input pass-through olur.
- `opacity: 0` source'u değiştirmez.
- True sort ayrı faz olarak kalır.
