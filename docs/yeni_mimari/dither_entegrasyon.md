# Dither Düğümleri Geliştirme Planı

> **Karar:** Dither mimarisi tek node'a sıkıştırılmayacak. Mevcut iki hat
> korunacak: `dither` kalite / algoritma / palette tarafının sahibi, `pattern-dither`
> ise GPU-first video performansı tarafının sahibi olacak.

Bu belge, Shader Lab / Basement Studio tarzı modern dither kontrollerini
Dither Lab'in mevcut iki node yapısına uyarlama planıdır. Amaç parametreleri
her yere eklemek değil, doğru özelliği doğru hatta yerleştirmektir.

---

## 1. Mevcut Durum

Kodda iki ayrı dither node'u var:

### `dither` - CPU / Palette / Algorithm

```javascript
dither: {
  label: "Dither",
  family: "Dither",
  description: "Converts the incoming image into a dithered monochrome result.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    algorithm: "floyd-steinberg",
    palette: "monochrome",
    threshold: 128,
    invert: false,
    scale: 100,
    blurRadius: 0,
    errorStrength: 100,
    serpentine: true,
  },
}
```

Bu node'un görevi:

- Floyd-Steinberg, Atkinson, Stucki, Riemersma gibi error diffusion ailesi.
- Bayer / threshold / pattern gibi CPU algoritma kataloğu.
- Built-in ve custom palette kullanımı.
- Palette extraction / palette manager ile entegrasyon.
- Export doğruluğu ve deterministik sonuç.

### `pattern-dither` - GPU / Video-Fast Pattern

```javascript
"pattern-dither": {
  label: "Pattern Dither",
  family: "Dither",
  description: "GPU-only ordered/noise dither with color-depth quantization.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    opacity: 100,
    saturation: 100,
    pattern: "bayer-4x4",
    scale: 1,
    strength: 100,
    depth: 4,
    gamma: "srgb",
  },
}
```

Bu node'un görevi:

- Bayer 2/4/8, blue noise, white noise gibi paralel GPU pattern'leri.
- Video playback sırasında hızlı ordered/noise dither.
- Palette-less color depth quantization.
- `opacity`, `saturation`, `gamma` gibi canlı preview dostu kontroller.

Bu sınır korunmalı. CPU `dither` ve GPU `pattern-dither` aynı kontrolleri
zorla paylaşmamalı.

---

## 2. Duotone Kararı

Duotone, dither node içine `colorMode: "duo-tone"` olarak gömülmemeli.

Neden:

- Dithering olmadan pürüzsüz duotone yapmak ayrı bir ihtiyaçtır.
- Dither sonrası duotone gerekiyorsa graph'ta `dither -> duotone` zinciri
  kurulabilir.
- Duotone renkleri dither node'a gömülürse palette manager ve bağımsız color
  grading akışı bulanıklaşır.

Bu yüzden duotone bağımsız node dokümanında ele alınmalı. Dither tarafında
renk modeli şu kadarla sınırlı kalmalı:

- CPU `dither`: `palette`
- GPU `pattern-dither`: source renklerini quantize eden `depth` / `gamma`

---

## 3. `scale` ve `pixelSize`

Mevcut `scale` parametresi silinmemeli. Eski projeler ve timeline keyframe'leri
bu alana bağlı olabilir.

Öneri:

- CPU `dither` için `scale` P1'de korunur.
- Tam sayı grid gerekiyorsa P2'de `pixelSize` eklenebilir, ama `scale` ile
  ilişkisi net tanımlanmalı.
- GPU `pattern-dither` tarafında bugünkü `scale` zaten pattern cell ölçeği gibi
  çalışır; burada `pixelSize` yerine mevcut isim korunabilir ya da UI label
  "Cell Scale" yapılabilir.

Kural:

```text
project data: scale
UI label: Scale / Cell Scale
future alias: pixelSize sadece gerekirse
```

Parametre adı değiştirmek son çare olmalı.

---

## 4. CPU `dither` İçin İyileştirmeler

CPU node için öncelik kalite ve kontrol olmalı.

### P1 - Mevcut Hattı Güçlendir

- Algorithm selector grupları daha anlaşılır hale getirilebilir:
  - Error Diffusion
  - Ordered
  - Threshold / Noise
  - Pattern / Path
- Palette manager korunur ve dither node'un ana avantajı olarak kalır.
- `scale`, `blurRadius`, `errorStrength`, `serpentine` davranışları geriye
  dönük uyumla sürdürülür.

### P2 - Preprocess Kontrolleri

Dither öncesi küçük kontroller eklenebilir:

```javascript
preLevels: 0,     // 0 = off, 2-16 = posterize steps
preGamma: 100,    // 100 = normal
```

Bu kontroller dikkatli eklenmeli. Dither öncesi ayrı `Posterize`, `Levels`,
`Tone Map` node'ları zaten graph'ta kurulabilir. Node içine preprocess eklemek
ancak sık kullanılan hızlı workflow ise mantıklı.

### P3 - Deterministik Animasyon

Animated CPU dither risklidir. Her frame rastgele seed kullanmak preview ile
export arasında fark yaratabilir.

Eklenirse şu sözleşmeyle eklenmeli:

```javascript
animate: "off" | "offset",
animationSpeed: 1,
seed: 1,
```

Kural:

- Random değil, time/frame tabanlı deterministik offset.
- Aynı proje aynı frame'de aynı sonucu üretir.
- Export ve preview aynı görünür.
- Error diffusion algoritmalarında P1 değildir; önce ordered/noise ailesinde
  denenmelidir.

---

## 5. GPU `pattern-dither` İçin İyileştirmeler

GPU node video-first olduğu için modern görsel kontrollerin ana hedefidir.

### P1 - Mevcut Shader'ı Cilalama

Bugünkü parametreler korunur:

- `pattern`
- `scale`
- `strength`
- `depth`
- `gamma`
- `opacity`
- `saturation`

Inspector'da `scale` etiketi "Cell Scale" olarak daha netleştirilebilir.

### P2 - Dot / Cell Shape

`dotScale` GPU için anlamlıdır:

```javascript
dotScale: 100, // 10-250
shape: "square", // "square" | "circle" | "diamond"
```

Bu CPU `dither` için P1 değildir. Error diffusion çıktısına hücre maskesi
basmak dither algoritmasının doğasını bozar; gerekiyorsa kullanıcı
`pattern-dither`, `halftone` veya `pixelate` kullanmalıdır.

### P3 - Animated Pattern

GPU tarafında animasyon daha güvenlidir, ama yine deterministik olmalı:

```javascript
animate: "off" | "scroll" | "jitter",
animationSpeed: 1,
seed: 1,
```

Shader uniform'u `timeSeconds` veya frame index ile beslenir. Aynı zaman aynı
sonucu üretmelidir.

### P4 - Chromatic Split

Chromatic split yalnızca GPU `pattern-dither` için düşünülmeli:

```javascript
chromaticSplit: 0, // 0-100
```

CPU error diffusion tarafında RGB kanallarını ayrı offsetlemek hem pahalı hem de
beklenmeyen palette eşleşmeleri doğurabilir. Bu yüzden CPU için kapsam dışı.

---

## 6. Threshold İle Sınır

Projede bağımsız `threshold` mask node'u da var. Dither dokümanı threshold
alanını ikiye ayırmalı:

- CPU `dither.threshold`: dither algoritmasının karar eşiği.
- `threshold` node: mask üretme / source-mask iş akışı.
- GPU `pattern-dither.strength/depth`: ordered/noise quantization kontrolü.

Bu üçü birbirinin yerine yazılmamalı.

---

## 7. Uygulama Sırası

### Faz 1 - Dokümantasyon ve UI Netliği

- CPU/GPU dither ayrımı UI açıklamalarına yansıtılır.
- `pattern-dither.scale` label'ı "Cell Scale" olarak değerlendirilebilir.
- Duotone'un ayrı node olduğu netleşir.

### Faz 2 - GPU Pattern Geliştirme

- `dotScale` ve `shape` eklenir.
- Shader cell mask hesabı tek pass içinde kalır.
- Opacity/source mix davranışı korunur.

### Faz 3 - Deterministik Animasyon

- Önce GPU `pattern-dither` için `animate`, `animationSpeed`, `seed`.
- Preview/export parity test edilir.
- Gerekirse ordered CPU algoritmalarına time-based offset eklenir.

### Faz 4 - CPU Preprocess

- `preLevels` ve `preGamma` yalnızca gerçek workflow ihtiyacı doğrulanırsa
  eklenir.
- Ayrı Posterize/Levels node'larıyla çakışma tekrar değerlendirilir.

---

## 8. Kabul Kriterleri

- Eski `dither` projeleri aynı şekilde açılır.
- `scale` alanı geriye dönük uyum için korunur.
- CPU `dither` palette ve error diffusion gücünü kaybetmez.
- GPU `pattern-dither` video playback sırasında hızlı kalır.
- Duotone dither içine gömülmez.
- Animasyon eklenirse deterministiktir; aynı frame aynı sonucu üretir.
- Preview ve export aynı parametrelerle aynı görünümü verir.
- Yeni kontroller hangi node'a aitse yalnızca orada görünür.
