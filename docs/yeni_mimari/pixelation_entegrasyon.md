# Pixelate Node İyileştirme Planı

> **Karar:** `pixelate` node'u zaten güçlü bir tabana sahip. Yeni çalışma,
> parametreleri yeniden adlandırmak veya node'u sıfırdan kurmak değil, mevcut
> GPU-first Pixelate davranışını bozmadan küçük görsel seçenekler eklemek
> olmalı.

Bu belge, Basement Studio tarzı pixelation fikirlerini Dither Lab'in mevcut
`pixelate` node'una uyarlama planıdır.

---

## 1. Mevcut Durum

Mevcut node:

```javascript
pixelate: {
  label: "Pixelate",
  family: "Process",
  description: "Collapses NxN blocks into single colors for chunky low-res looks.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    size: 8,
    sizeY: 0,
    shape: "square",
    smoothing: 0,
    opacity: 100,
  },
}
```

Mevcut davranış:

- `size`: X hücre boyutu.
- `sizeY`: Y hücre boyutu; `0` sentinel değeri `size` ile link anlamına gelir.
- `shape`: `square` veya `circle`.
- `smoothing`: hücre kenarı yumuşatma.
- `opacity`: source ile pixelated sonuç karışımı.
- GPU yolu birincil, CPU fallback mevcuttur.

Bu model korunmalı. `size` alanını `sizeX` olarak yeniden adlandırmak proje
JSON'larını ve timeline keyframe'lerini gereksiz riske atar.

---

## 2. Pixelate'ın Sınırı

`pixelate` node'unun görevi düşük çözünürlük / bloklaştırma hissidir.

Şunlarla karıştırılmamalı:

- `led-screen`: fiziksel subpixel, diode glow, panel gap.
- `halftone`: baskı tramı / CMY-CMYK dot screen.
- `pattern-dither`: ordered/noise dither ve color-depth quantization.

Bu yüzden LCD panel çizgileri veya gerçek ekran subpixel simülasyonu Pixelate'a
gömülmemeli. Pixelate'ta kalabilecek şey yalnızca hafif cell grid darkening gibi
blok estetiğini destekleyen küçük bir opsiyondur.

---

## 3. Parametre Modeli

P1'de mevcut model yeterlidir:

```javascript
{
  size: 8,
  sizeY: 0,
  shape: "square", // "square" | "circle"
  smoothing: 0,
  opacity: 100,
}
```

P2 için eklenebilir:

```javascript
{
  gridOpacity: 0, // 0-100, hafif cell-edge darkening
}
```

P3 için dikkatli değerlendirilecek:

```javascript
{
  layout: "grid", // "grid" | "staggered"
}
```

`shape: "hex"` P1/P2 için önerilmez. Basit staggered grid gerçek hex mask
üretmez; kullanıcıya "hex" denirse görsel beklenti yanlış olur. Eğer istenirse
önce `layout: "staggered"` olarak daha dürüst bir adla denenmeli.

---

## 4. GPU Davranışı

Mevcut GPU shader mantığı doğru yönde:

- Hücre koordinatı hesaplanır.
- Hücre merkezinden renk örneklenir.
- `shape === "circle"` ise hücre maskesi uygulanır.
- `smoothing` hücre kenarlarını yumuşatır.
- `opacity` source ile sonucu karıştırır.

P2 `gridOpacity` eklenecekse shader içinde şu mantık yeterlidir:

```glsl
vec2 local = fract(pixel / cellSize);
float edge = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
float grid = 1.0 - smoothstep(0.0, 0.08, edge);
cellColor = mix(cellColor, cellColor * 0.55, grid * u_gridOpacity);
```

Bu `led-screen` gibi ayrı panel simülasyonu değildir; sadece hücre sınırını
okutmak için hafif koyulaştırmadır.

---

## 5. CPU Fallback

CPU fallback korunmalı:

- WebGL2 yoksa output üretir.
- Smoothing/circle davranışı yaklaşık da olsa çalışır.
- Yeni P2 seçenekleri CPU fallback'te uygulanamayacak kadar pahalıysa no-op
  kalabilir, ama bu dokümante edilmelidir.

Pixelate, native render listesinde de bulunduğu için parametre değişiklikleri
Rust/native yoluyla uyum açısından ayrıca kontrol edilmelidir.

---

## 6. Uygulama Sırası

### P1 - Dokümantasyon ve UI Netliği

- `size` adı korunur.
- UI label'ı "Block X", "Block Y" olarak kalabilir.
- `sizeY = 0` için "link" readout korunur.
- `smoothing` yeni özellik gibi anlatılmaz; mevcut davranış olarak kabul edilir.

### P2 - Grid Edge

- `gridOpacity` eklenir.
- GPU shader tek pass kalır.
- CPU fallback gerekiyorsa yaklaşık uygulanır veya no-op olarak bırakılır.

### P3 - Staggered Layout

- `layout: "staggered"` denenir.
- "Hex" adı kullanılmadan önce gerçek hex sampling/mask tasarımı yapılır.
- Pixelate ile Halftone/LED Screen sınırı tekrar kontrol edilir.

---

## 7. Kabul Kriterleri

- Eski `pixelate` projeleri aynı görünür.
- `size` parametresi yeniden adlandırılmaz.
- `sizeY = 0` link davranışı korunur.
- GPU path birincil kalır, CPU fallback çalışır.
- Yeni grid/staggered seçenekleri varsayılanda kapalıdır.
- Pixelate fiziksel ekran simülasyonuna dönüşmez; bu iş `led-screen` node'una
  bırakılır.
