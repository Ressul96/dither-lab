# Analog / VHS / CRT İyileştirme Planı

> **Karar:** Ana geliştirme hedefi birleşik `analog` node'u olmalı. Ayrı
> `vhs` ve `crt` node'ları geriye dönük uyum ve hızlı kullanım için korunabilir,
> ama yeni kalite yatırımı öncelikle `analog` üzerinden ilerlemeli.

Bu belge, mevcut VHS ve CRT shader'larını baştan yazma planı değildir. Amaç,
Dither Lab'deki time-aware GPU efekt altyapısını koruyarak analog video ve tüp
ekran simülasyonunu daha kaliteli, deterministik ve yönetilebilir hale
getirmektir.

---

## 1. Mevcut Durum

Kodda üç ilgili node vardır:

### `analog`

Birleşik node:

```javascript
analog: {
  label: "Analog",
  family: "Effect",
  defaultParams: {
    mode: "vhs", // "vhs" | "crt" | "vhs-crt"
    opacity: 100,
    brightness: 110,
    saturation: 110,
    chroma: 6,
    bleed: 50,
    noise: 35,
    scanlines: 60,
    tracking: 35,
    wave: 4,
    curvature: 25,
    mask: "aperture",
    maskStrength: 35,
    glow: 25,
    vignette: 40,
    rolling: 0,
  },
}
```

`mode` davranışı:

- `vhs`: sadece tape yüzeyi.
- `crt`: sadece tube yüzeyi.
- `vhs-crt`: önce VHS, sonra CRT.

### `vhs` ve `crt`

Ayrı node'lar hâlâ vardır. Bunlar eski proje uyumu ve hızlı palette erişimi
için korunabilir.

Uzun vadeli tercih:

- Yeni parametreler önce `analog` node'a eklenir.
- `vhs` ve `crt` aynı shader pass'larını kullanmayı sürdürür.
- Palette'te ayrı `VHS` / `CRT` node'ları kalacaksa bile davranış `analog`
  ile tutarlı olmalı.

---

## 2. Time-Aware Davranış Korunmalı

`analog`, `vhs` ve `crt` time-aware node'lardır. Runtime cache key'i playhead
frame'iyle tuzlanır, böylece noise, tracking ve rolling band aynı frame için
deterministik kalır.

Bu sözleşme değişmemeli:

- Preview ve export aynı frame'de aynı analog bozulmayı üretir.
- Shader `performance.now()` gibi serbest zaman kaynaklarına dayanmamalı.
- `context.timeSeconds` tercih edilmeli.
- FPS değişse bile frame-aligned playback tutarlılığı korunmalı.

Yeni noise, sparkle, dropout, tape crease gibi her zamanlı özellik bu kurala
uymalı.

---

## 3. Legacy Parametreleri Kırmama

Mevcut parametreler hemen silinmemeli:

- `wave`
- `chroma`
- `bleed`
- `tracking`
- `noise`
- `scanlines`

Yeni isimler gerekirse alias olarak eklenmeli:

```text
wave        -> wobble
chroma      -> chromaShift
bleed       -> colorBleed
tracking    -> trackingNoise
noise       -> grain
```

P1'de bu alanları yeniden adlandırmak yerine UI label'ları iyileştirmek daha
güvenlidir. Parametre adı değiştirmek project save/load ve timeline track'lerini
etkiler.

---

## 4. VHS Geliştirme Alanları

VHS tarafı `analog.mode === "vhs"` ve `analog.mode === "vhs-crt"` içinde
çalışır.

### P1 - Mevcut Kontrolleri Cilalama

- `wave` düşük frekanslı yatay wobble olarak netleştirilir.
- `tracking` ekran altı / kayan tracking band etkisi olarak kalır.
- `bleed` VHS color bleed davranışı olarak korunur.
- `chroma` chroma shift miktarı olarak korunur.
- UI section başlıkları Tape / Frame olarak sade kalır.

Bu fazda shader davranışı kırılmadan kalite ayarı yapılır.

### P2 - Gerçekçi Tape Parametreleri

Yeni parametreler:

```javascript
tapeResolution: 100, // 25-200, yatay çözünürlük hissi
jitter: 0,           // satır bazlı yüksek frekanslı x kayması
flicker: 0,          // frame brightness dalgalanması
dropouts: 0,         // kısa beyaz/siyah çizik ve sinyal kaybı
crease: 0,           // yatay bant kırışıklığı
```

Bu parametreler yüzde aralığında tutulmalı (`0-100`). Shader içinde gerçek
pixel/UV birimine dönüştürülür.

### P3 - YIQ/YUV Chroma Bleed

Mevcut RGB channel shift yerine daha doğru VHS renk davranışı:

- RGB YIQ veya YUV uzayına çevrilir.
- Luma daha keskin kalır.
- Chroma yatayda geciktirilir / bulanıklaştırılır.
- Sonuç tekrar RGB'ye döner.

Bu P3 olmalı, çünkü shader matematiği ve mevcut görüntü karakteri değişir.

---

## 5. CRT Geliştirme Alanları

CRT tarafı `analog.mode === "crt"` ve `analog.mode === "vhs-crt"` içinde
çalışır.

Mevcut güçlü taraflar:

- Curvature.
- Aperture / slot mask.
- Scanlines.
- Glow.
- Rolling sync band.
- Vignette.

Öncelikler:

### P1 - Mask ve Scanline Kalitesi

- `maskStrength` aşırı değerlerde rengi tamamen öldürmemeli.
- `scanlines` 1080p ve küçük preview ölçeklerinde okunaklı kalmalı.
- `glow` tek pass sınırında kalmalı.

### P2 - Mask Çeşitleri

Mevcut:

- `none`
- `aperture`
- `slot`

Eklenebilir:

- `shadow-mask`
- `trinitron`

Ama `led-screen` node ile çakışmamalı. CRT mask tüp estetiği için kalır;
LED/LCD subpixel simülasyonu `led-screen` node'unun alanıdır.

### P3 - Tube Calibration

Ek parametreler:

```javascript
phosphor: 0,       // renk yayılımı / glow tint
blackLevel: 0,     // lifted blacks
barrelFit: "crop", // "crop" | "fit"
```

Bu alanlar P1'e alınmamalı.

---

## 6. Analog Node UI

Mevcut UI modeli doğru:

- General
- Tape
- Tube
- Frame

Korunmalı. Yeni parametreler yalnızca ilgili mode açıkken görünmeli.

`mode === "vhs"`:

- General
- Tape
- Frame

`mode === "crt"`:

- General
- Tube
- Frame / Sync

`mode === "vhs-crt"`:

- General
- Tape
- Tube
- Frame

UI kuralı:

- Bir parametre görünmüyorsa yine state'te kalabilir, ama aktif mode'da
  etkisiz olduğu anlaşılır olmalı.
- Legacy `vhs` / `crt` inspector'ları mümkün olduğunca `analog` ile aynı label
  ve aralıkları kullanmalı.

---

## 7. Shader Stratejisi

Baştan yazmak yerine mevcut pass'lar büyütülmeli:

- `VHS_FRAGMENT_SHADER`: tape bozulmaları.
- `CRT_FRAGMENT_SHADER`: tube / mask / scanline.
- `analog.mode === "vhs-crt"`: önce VHS pass, sonra CRT pass.

Kabul edilebilir risk:

- `vhs-crt` iki pass olduğu için daha pahalıdır.
- Bu mode gerçekçi pipeline için kabul edilebilir.
- Preview kalite ayarı `auto` iken downscaled source üzerinden çalışabilir.

GPU fallback:

- VHS/CRT CPU fallback yapılmamalı.
- WebGL2 yoksa input pass-through doğru davranıştır.
- Kullanıcı graph'ın geri kalanını görmeye devam eder.

---

## 8. Uygulama Sırası

### P1 - Analog'u Kaynak Yap

- Doküman ve UI'da `analog` ana node olarak konumlanır.
- `vhs` / `crt` ayrı node'ları legacy shortcut olarak kalır.
- Legacy node'ların shader davranışı `analog` ile ayrışmamalı.
- Time-aware determinism test edilir.

### P2 - Tape Gerçekçiliği

- `jitter`, `flicker`, `dropouts`, `crease` eklenir.
- Hepsi `context.timeSeconds` ile deterministik çalışır.
- Varsayılan değerler `0` olmalı; eski projeler aynı görünür.

### P3 - Chroma Modeli

- YIQ/YUV chroma delay denenir.
- `bleed` ve `chroma` eski değerleri yeni modele map edilir.
- Görsel değişim kontrollü olmalı.

### P4 - CRT Kalitesi

- Mask çeşitleri ve black level gibi tube polish alanları eklenir.
- `led-screen` ile görev sınırı tekrar kontrol edilir.

---

## 9. Kabul Kriterleri

- Eski `analog`, `vhs`, `crt` projeleri aynı şekilde açılır.
- Yeni parametrelerin varsayılanı eski görünümü değiştirmez.
- Preview ve export aynı frame'de aynı noise/tracking/dropout sonucunu verir.
- `vhs-crt` önce tape, sonra tube uygular.
- CPU fallback zorlanmaz; WebGL2 yoksa pass-through çalışır.
- `led-screen`, `chromatic-aberration` ve `glare` node'larıyla görev çakışması
  oluşmaz.
