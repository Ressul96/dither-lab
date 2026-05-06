# Shader Lab / Effect App Ekstra Port Notları

> **Rol:** Bu dosya ayrıntılı entegrasyon planı değil, kalan port hedefleri
> için kısa indeks ve öncelik notudur. Her efektin gerçek planı kendi
> `*_entegrasyon.md` dosyasında tutulmalıdır.

`src/js/effect-catalog.js` dış kaynaklardan port edilecek hedeflerin listesidir;
node tanımı tutmaz. Yeni node'lar `src/js/graph.js`, runtime route'ları
`src/js/graph-runtime.js`, shader pass'ları ise `src/js/gpu-effects.js` içinde
yer almalıdır.

---

## 1. Mevcut ve Planlanan Alanlar

### Mevcut Node'lar

- `pixelate`: Zaten var. Geliştirme planı `pixelation_entegrasyon.md`.
- `ascii`: Zaten var. Geliştirme planı `ascii_entegrasyon.md`.
- `analog`, `vhs`, `crt`: Zaten var. Geliştirme planı
  `vhs_crt_entegrasyon.md`.
- `glare`, `halation`: Parlaklık/glow ailesi zaten var. Star Glow planı bu
  alanla çakışmadan ele alınmalı.
- `rgb-curves`: Zaten var. Geliştirme planı `curves_entegrasyon.md`.

### Yeni Node Adayları

- `pixel-sorting`: Glitch sıralama efekti. Plan:
  `pixel_sorting_entegrasyon.md`.
- `mesh-gradient`: Procedural source node. Plan:
  `mesh_gradient_entegrasyon.md`.
- `gradient-map`: Luma → gradient color remap. Plan:
  `gradient_map_entegrasyon.md`.
- `star-glow`: Directional highlight streaks. Plan:
  `starglow_entegrasyon.md`.
- `modulation`: FM/PM çizgi sinyal efekti. Plan:
  `modulation_entegrasyon.md`.
- `duotone`: Bağımsız iki renk remap. Plan:
  `duotone_entegrasyon.md`.
- `depth-of-field`: Bokeh/focus efekti. Plan:
  `depth_of_field_entegrasyon.md`.
- `led-screen`: Fiziksel ekran/subpixel simülasyonu. Plan:
  `led_screen_entegrasyon.md`.

---

## 2. Mimari Kurallar

- `inputs` / `outputs` alanlarında proje standardı `name` kullanılır, `id`
  kullanılmaz.
- Family değerleri mevcut ailelerden seçilir: `Input`, `Color`, `Process`,
  `Dither`, `Mask`, `Effect`, `Compose`, `Utility`, `Output`.
- Yeni shader efektleri mümkünse `gpu-effects.js` içinde tek pass olarak
  başlamalıdır.
- GPU-only efektlerde WebGL2 yoksa input pass-through kabul edilebilir.
- Time kullanan node'lar `TIME_AWARE_TYPES` set'ine eklenmeli ve
  `context.timeSeconds` ile deterministik çalışmalıdır.
- UI için gerçek dosya `src/js/ui/graph-shell.js`; eski taslaklardaki
  `inspector.js` referansları geçerli değildir.

---

## 3. Öncelik Önerisi

### P1 - Düşük Risk / Yüksek Değer

- `duotone`
- `gradient-map`
- `modulation`
- `pixelate` küçük grid polish

### P2 - Orta Risk

- `mesh-gradient`
- `star-glow`
- `led-screen`
- `ascii` signal shaping

### P3 - Yüksek Risk

- `depth-of-field`
- `pixel-sorting`

Yüksek risk nedenleri:

- DoF piksel başına çok örnekleme ister.
- Pixel sorting gerçek anlamıyla multi-pass veya compute benzeri yaklaşım
  ister; tek pass yaklaşım yalnızca görsel approximation olabilir.

---

## 4. Artık Geçerli Olmayan Notlar

- `#playerCard` silinip glassmorphism overlay yapılacak fikri güncel yön
  değildir. Player reformu ayrı dosyada ele alınır ve mevcut frame-based
  timeline yapısı korunur.
- Pixelate sıfırdan kurulmayacak; mevcut node genişletilecek.
- `effect-catalog.js` içine node implementasyonu yazılmayacak.
