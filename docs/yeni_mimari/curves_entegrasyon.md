# RGB Curves Entegrasyonu ve İyileştirme Planı

> **Karar:** Yeni bir `curves` node tipi açılmayacak. Mevcut `rgb-curves`
> node'u korunacak ve profesyonel bir Curves aracına dönüştürülecek. Böylece
> eski projeler, node palette davranışı ve timeline bağları kırılmaz.

Bu belge, `rgb-curves` node'unun mevcut durumunu kaynak kabul eder. Amaç
Photoshop / DaVinci Resolve tarzı güvenilir bir renk eğrisi deneyimi sağlamak:
ekranda görülen eğri ile çıktı aynı olmalı, inspector hızlı kalmalı, GPU yolu
geldiğinde CPU sonucu ile birebir davranmalıdır.

---

## 1. Mevcut Durum

Kodda `rgb-curves` node'u zaten var:

- Node tanımı: `src/js/graph.js`
- Runtime route: `src/js/graph-runtime.js`
- CPU uygulama: `src/js/image-ops.js`
- Inspector UI: `src/js/ui/graph-shell.js`
- Stil: `src/styles/main.css`

Mevcut parametre modeli:

```javascript
{
  activeChannel: "master",
  masterLow: 0,
  masterMid: 128,
  masterHigh: 255,
  redLow: 0,
  redMid: 128,
  redHigh: 255,
  greenLow: 0,
  greenMid: 128,
  greenHigh: 255,
  blueLow: 0,
  blueMid: 128,
  blueHigh: 255,
  points_master: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  points_red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  points_green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  points_blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
}
```

Notlar:

- `masterLow/mid/high` ve kanal low/mid/high alanları legacy fallback olarak
  kalmalı.
- Gerçek ileri model `points_*` dizileridir.
- `inputs` / `outputs` alanlarında proje standardı `name: "image"` kullanır;
  örneklerde `id: "image"` kullanılmamalı.
- UI tarafında generic `type: "curve"` kontrolü yok; bugün `rgb-curves` için
  özel inspector render akışı vardır.

---

## 2. Hedef Deneyim

Curves node'u renk ailesinde kalır:

```javascript
"rgb-curves": {
  label: "RGB Curves", // UI'da ileride "Curves" olarak kısaltılabilir
  family: "Color",
  description: "Remaps master and RGB channels with editable tone curves.",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    activeChannel: "master",
    applyMode: "normal", // "normal" | "luma" | "color"
    points_master: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    points_red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    points_green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    points_blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  },
}
```

`applyMode` sonradan eklenebilir; P1 için zorunlu değildir. Parametre yoksa
`normal` varsayılır.

---

## 3. Inspector UI Kararı

Mevcut tek editör + aktif kanal modeli korunmalı:

- Üstte kanal seçimi: `Master`, `Red`, `Green`, `Blue`.
- Tek SVG curve editor.
- Seçili kanalın stroke rengi kanal rengiyle eşleşir.
- Master eğrisi beyaz / nötr çizilir.
- Reset sadece aktif kanalı sıfırlar.

4 editörü alt alta göstermek P1 için önerilmez. Inspector'da fazla yer kaplar,
pointer etkileşimini ağırlaştırır ve node param panelinin taranabilirliğini
düşürür.

P2 iyileştirme:

- Aktif kanal düzenlenirken diğer kanallar düşük opaklıkla overlay çizilebilir.
- Eğri alanında input/output değer tooltip'i gösterilebilir.
- Shift drag ile eksen kilidi eklenebilir.
- Cmd/Ctrl click ile nokta ekleme, sağ tık ile ara nokta silme davranışı
  korunabilir.

---

## 4. En Kritik Açık: UI Eğrisi ve Gerçek LUT Aynı Olmalı

Bugün UI çizimi ve gerçek işlem yolu farklı helper'lar kullanır:

- Inspector çizimi `graph-shell.js` içinde lokal LUT üretir.
- CPU output `image-ops.js` içinde ayrı LUT üretir.

Bu risklidir. Kullanıcı eğride gördüğü formun çıktıda birebir karşılığını
bekler. Bu yüzden P1 iş:

```text
src/js/curve-lut.js
```

gibi ortak bir modül çıkarmak.

Önerilen API:

```javascript
export function sanitizeCurvePoints(rawPoints) {}
export function buildCurveLut(points) {}          // Uint8ClampedArray(256)
export function buildRgbCurvesLuts(params) {}     // { master, red, green, blue }
export function isIdentityCurveLut(lut) {}
```

Kullanım:

- `image-ops.js` gerçek pixel dönüşümünde bu modülü kullanır.
- `graph-shell.js` SVG polyline çizimini aynı LUT üzerinden üretir.
- İleride `gpu-effects.js` aynı LUT verisini texture'a dönüştürür.

Bu ortaklık kurulmadan GPU yoluna geçilmemeli.

---

## 5. CPU Davranışı

Mevcut CPU davranışı iyi bir tabandır:

```javascript
data[i] = red[master[data[i]]];
data[i + 1] = green[master[data[i + 1]]];
data[i + 2] = blue[master[data[i + 2]]];
```

Bu sıra korunmalı:

1. Her kanal önce master LUT'tan geçer.
2. Sonra ilgili kanal LUT'u uygulanır.
3. Alpha değiştirilmez.
4. Tüm LUT'lar identity ise input buffer geri döner.

Legacy low/mid/high alanları:

- Kaydedilmiş eski projeler için okunur.
- Yeni UI yazımları `points_*` alanlarına yapılır.
- Inspector açıldığında legacy değerlerden üç noktalı eğri üretilebilir.

---

## 6. Apply Mode

`applyMode` üç davranış sunar:

- `normal`: RGB değerleri doğrudan eğrilerden geçer.
- `luma`: eğri sonucu sadece parlaklık değişimi olarak uygulanır; renk kayması
  minimize edilir.
- `color`: renk karakteri eğrilerden gelir, orijinal luma korunmaya çalışılır.

P1'de `normal` yeterlidir. `luma` ve `color` P2 olarak eklenmeli; önce CPU
referans davranışı yazılmalı, sonra GPU shader aynı matematiği takip etmelidir.

CPU referansı netleşmeden shader yazmak doğru değil; aksi halde preview/export
ve JS/GPU yolları farklı görünebilir.

---

## 7. GPU Yolu

GPU hedefi doğru ama aşamalı olmalı.

P2/P3 hedef:

1. Ortak `curve-lut.js` dört kanal LUT'unu üretir.
2. Bu LUT tek bir `256x1` RGBA texture'a paketlenir:
   - R kanalı: final red LUT
   - G kanalı: final green LUT
   - B kanalı: final blue LUT
   - A kanalı: 255
3. Shader her piksel için sadece üç texture sample yapar:

```glsl
float newR = texture(u_curveLut, vec2(src.r, 0.5)).r;
float newG = texture(u_curveLut, vec2(src.g, 0.5)).g;
float newB = texture(u_curveLut, vec2(src.b, 0.5)).b;
```

Mevcut `gpu-effects.js` extra sampler yaklaşımı ASCII atlas / ileride LUT
kullanımı için uygun yönde duruyor. Curves GPU eklenirken bu mekanizma
genelleştirilmeli; her efekt kendi texture yönetimini ayrı ayrı icat etmemeli.

Kabul şartı:

- CPU ve GPU çıktısı aynı source üzerinde gözle ayırt edilemeyecek kadar yakın
  olmalı.
- Identity curve GPU yolunda da no-op gibi davranmalı.
- GPU yoksa CPU fallback kusursuz çalışmalı.

---

## 8. Timeline ve Param Binding

`points_*` dizileri slider gibi her pointermove'da timeline keyframe'e
yazılmamalı. Curves editor yüksek frekanslı ve dizi tabanlı bir kontroldür.

Öneri:

- Curve drag sırasında sadece node param güncellenir.
- Pointer up anında tek undo/history girdisi oluşur.
- Autokey davranışı P1 dışında tutulur.
- İleride curve keyframe gerekiyorsa bütün `points_master` dizisini keyframe
  value olarak saklamak yerine preset/state snapshot modeli ayrıca tasarlanır.

Bu ayrım performans ve history kalitesi için önemli.

---

## 9. Uygulama Sırası

### P1 - Doğruluk ve UX

- `curve-lut.js` ortak helper modülü çıkar.
- `image-ops.js` ve `graph-shell.js` aynı LUT'u kullanır.
- UI polyline, gerçek çıktı ile birebir hizalanır.
- Curve drag sırasında gereksiz full inspector rebuild azaltılır.
- Pointer up'ta tek history girdisi hedeflenir.
- Legacy low/mid/high fallback korunur.

### P2 - Profesyonel Kontroller

- `applyMode: normal/luma/color` CPU referansı eklenir.
- Diğer kanal overlay'leri düşük opaklıkla gösterilir.
- Input/output tooltip'i eklenir.
- Curve presetleri eklenir: invert, lift shadows, crush blacks, soft contrast.

### P3 - GPU Hızlandırma

- Dört kanal tek `256x1` LUT texture'a paketlenir.
- `gpu-effects.js` içinde Curves pass eklenir.
- CPU/GPU parity görsel test edilir.
- Büyük çözünürlük ve video playback sırasında performans ölçülür.

---

## 10. Kabul Kriterleri

- Eski `rgb-curves` projeleri açılır.
- Yeni kayıtlarda `points_*` modeli ana kaynak olur.
- Inspector eğrisi ile çıktı aynı LUT'u kullanır.
- Master + kanal uygulama sırası değişmez.
- Identity curve gereksiz buffer üretmez.
- Curve düzenlerken UI akıcı kalır.
- GPU yolu geldiğinde CPU fallback aynı görünümü üretir.
