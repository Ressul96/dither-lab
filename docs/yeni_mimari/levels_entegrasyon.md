# Levels Node Entegrasyon Planı

> **Karar:** `levels` yeni bir Color node olarak eklenebilir, ama P1 hedefi
> özel XY Pad kontrolü değil doğru matematik, geriye dönük uyumlu node modeli
> ve mevcut inspector primitive'leriyle güvenilir bir arayüz olmalı.

Bu belge, `effect.app` tarafındaki Levels fikrini Dither Lab'in mevcut node
mimarisine uyarlama planıdır. Levels; `Adjust`, `Tone Map`, `Posterize` ve
`RGB Curves` ile çakışmadan siyah nokta, beyaz nokta, gamma ve output range
kontrolü sağlar.

---

## 1. Mevcut Sistemle İlişki

Kodda Levels node'u henüz yok. Yakın görevleri üstlenen node'lar:

- `adjust`: brightness, contrast, saturation, gamma, exposure.
- `tone-map`: Reinhard highlight compression; dither öncesi headroom sağlar.
- `posterize`: renk kanallarını basamaklandırır.
- `rgb-curves`: kanal bazlı eğri remap yapar.

`levels` bu node'ların yerine geçmez. Görevi daha tekniktir:

- Input siyah/beyaz noktasını kırpmak veya genişletmek.
- Midtone gamma'yı kontrollü değiştirmek.
- Output siyah/beyaz aralığını sıkıştırmak.
- İsteğe bağlı olarak sadece luma üstünden çalışmak.

---

## 2. Node Tanımı

Proje standardı `name` tabanlı input/output kullanır:

```javascript
levels: {
  label: "Levels",
  family: "Color",
  description: "Remaps input black/white points, gamma, and output range.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    inputBlack: 0,
    inputWhite: 255,
    gamma: 100,
    outputBlack: 0,
    outputWhite: 255,
    mode: "rgb", // "rgb" | "luma"
    opacity: 100,
  },
}
```

Önerilen bounds:

```javascript
levels: {
  inputBlack: { min: 0, max: 254 },
  inputWhite: { min: 1, max: 255 },
  gamma: { min: 10, max: 400 },
  outputBlack: { min: 0, max: 255 },
  outputWhite: { min: 0, max: 255 },
  opacity: { min: 0, max: 100 },
}
```

Kural:

- `inputBlack < inputWhite` korunmalı.
- Kullanıcı slider ile bu sınırı geçmeye çalışırsa değer clamp edilir.
- `mode: "luma"` RGB oranını mümkün olduğunca koruyarak sadece parlaklık
  remap eder.
- `opacity` source ile sonucu karıştırır; node'u bypass etmeden ince ayar
  yapmayı sağlar.

---

## 3. Inspector UI

P1'de özel `xypad` veya yeni canvas kontrolü yok. Gerçek inspector akışı
`src/js/ui/graph-shell.js` içindedir ve mevcut field primitive'leri yeterlidir.

Önerilen layout:

```text
Input
  Black   [range] 0-254
  White   [range] 1-255
  Gamma   [range] 0.10-4.00

Output
  Black   [range] 0-255
  White   [range] 0-255

Mode
  RGB / Luma
  Opacity
```

UI notları:

- `gamma` state'te yüzde olarak tutulur (`100 = 1.00`).
- Readout `1.00` formatında gösterilir.
- Input black/white için invalid range oluşursa UI otomatik clamp eder.
- P1'de histogram çizilmez.

---

## 4. XY Pad Kararı

Önceki taslak Levels'ı XY Pad etrafında kuruyordu. Bu P1 için riskli.

Neden:

- Levels iki adet 1D aralık kontrolüdür; XY Pad ilişkisi sezgisel değildir.
- Input black ve input white'ın birbirini geçmemesi gerekir.
- Output black/white ters range kullanabilir ama bu açık bir karar olmalı.
- Pointer drag sırasında iki parametreyi birden değiştirmek timeline/autokey
  ve history kalitesini zorlaştırır.

P2'de daha uygun özel kontrol:

- Dual-handle horizontal range:
  - Input Levels: black ve white handle.
  - Output Levels: black ve white handle.
- Histogram overlay:
  - Sadece preview amaçlı.
  - Source veya selected node input'undan örneklenir.
  - State'e kaydedilmez.

XY Pad, Levels için ana kontrol olarak önerilmez.

---

## 5. CPU Matematiği

Levels fonksiyonu:

```javascript
function applyLevelChannel(value, params) {
  const inBlack = params.inputBlack / 255;
  const inWhite = params.inputWhite / 255;
  const outBlack = params.outputBlack / 255;
  const outWhite = params.outputWhite / 255;
  const gamma = Math.max(0.1, params.gamma / 100);

  const normalized = clamp01((value - inBlack) / Math.max(0.0001, inWhite - inBlack));
  const corrected = Math.pow(normalized, 1 / gamma);
  return outBlack + (outWhite - outBlack) * corrected;
}
```

`mode === "rgb"`:

- R, G, B kanalları ayrı ayrı remap edilir.

`mode === "luma"`:

- Source luma hesaplanır.
- Luma levels fonksiyonundan geçirilir.
- RGB kanalları `newLuma / oldLuma` oranıyla ölçeklenir.
- `oldLuma` çok düşükse sonuç güvenli şekilde clamp edilir.

`opacity`:

- Final result source ile mix edilir.

---

## 6. GPU Yolu

Levels GPU için çok uygundur, ama P1'de CPU referans davranışı net olmalı.

Shader taslağı:

```glsl
float applyLevel(float value) {
  float normalized = (value - u_inputBlack) / max(u_inputWhite - u_inputBlack, 0.0001);
  float corrected = pow(clamp(normalized, 0.0, 1.0), 1.0 / max(u_gamma, 0.0001));
  return mix(u_outputBlack, u_outputWhite, corrected);
}

void main() {
  vec3 src = texture(u_image, v_uv).rgb;
  vec3 leveled;

  if (u_mode < 0.5) {
    leveled = vec3(applyLevel(src.r), applyLevel(src.g), applyLevel(src.b));
  } else {
    float oldLuma = dot(src, vec3(0.299, 0.587, 0.114));
    float newLuma = applyLevel(oldLuma);
    leveled = src * (newLuma / max(oldLuma, 0.0001));
  }

  out_color = vec4(mix(src, clamp(leveled, 0.0, 1.0), u_opacity), 1.0);
}
```

GPU kabul şartı:

- CPU ve GPU yolu aynı input için görsel olarak eşleşmeli.
- WebGL2 yoksa CPU fallback çalışmalı.

---

## 7. Uygulama Sırası

### P1 - Levels Node

- `graph.js` node tanımı ve bounds eklenir.
- Palette'e Color grubu altında `Levels` eklenir.
- `graph-runtime.js` route eklenir.
- `image-ops.js` CPU `applyLevelsNode` eklenir.
- `graph-shell.js` mevcut range/select/checkbox primitive'leriyle inspector
  render eder.

### P2 - Dual Range Kontrol

- Input Levels için dual-handle range bileşeni.
- Output Levels için dual-handle range bileşeni.
- Bu bileşen generic hale getirilecekse önce Levels'ta kanıtlanır.

### P3 - Histogram

- Histogram sadece görsel overlay.
- Her pointermove'da tekrar hesaplanmaz; rAF/throttle ile güncellenir.
- Project state'e kaydedilmez.

### P4 - GPU

- `gpu-effects.js` Levels shader pass eklenir.
- CPU/GPU parity test edilir.
- Playback preview'de GPU yolu tercih edilir.

---

## 8. Kabul Kriterleri

- `levels` node'u Color ailesinde görünür.
- Eski node'ların davranışı değişmez.
- Input black/white invalid range oluşturmaz.
- Gamma `100 = 1.00` olarak çalışır.
- `mode: rgb` ve `mode: luma` ayrımı nettir.
- `opacity` source mix yapar.
- CPU fallback tek başına doğru sonuç üretir.
- İleride dual range/histogram eklense bile P1 proje formatı bozulmaz.
