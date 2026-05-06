# Dither Lab: Revize Edilmiş Öneri ve Geliştirme Raporu

> Durum: 2026-05-06 tarihinde kod tabanı üzerinden yeniden doğrulandı.
> Bu belge, güncel olmayan [dither_lab_suggestions.md](dither_lab_suggestions.md)
> yerine kısa ve önceliklendirilmiş fırsat listesi olarak kullanılmalıdır.

## 1. Zaten Mevcut Olanlar
İlk öneri raporunda eksik sanılan bazı temel parçalar artık kodda mevcut:

* **Undo/Redo:** `src/js/state.js` içinde `pushHistory`, `undo`, `redo`.
* **Node cache:** `src/js/graph-runtime.js` içinde düğüm bazlı `nodeCache`.
* **Timeline / keyframe:** `src/js/timeline.js`, `src/js/timeline-adapter.js` ve player UI içinde aktif.
* **Retro efektler:** `crt`, `vhs`, `analog`, `posterize`, `halftone`, `ascii`, `pixelate`, `rgb-curves` gibi düğümler shipped durumda.
* **Maske temeli:** `threshold`, `mask-combine`, `mask-apply` ile temel maskeleme hattı var.

## 2. Geçerli Ürün Fırsatları

### P1 - Export Ürünleşmesi ve Audio
`src/js/export.js` ve `src-tauri/src/engine/video_export.rs` mevcut durumda işlenmiş
RGBA kareleri FFmpeg'e vererek video üretir; orijinal kaynağın sesi henüz export
hattına bağlanmış görünmüyor.

Eksik kararlar:

* Audio pass-through mı, yeniden encode (`aac`) mı?
* Trim başlangıcı ve frame range audio ile nasıl hizalanacak?
* Kaynak audio yoksa UI nasıl davranacak?
* Sistem `ffmpeg` bağımlılığı mı, Tauri sidecar mı, fallback'li hibrit yaklaşım mı?

Bu başlık, GIF/WebP'ten önce ele alınmalı; çünkü export mimarisinin temel
sözleşmesini belirler.

### P1 - Preview / Export Paritesi
Still, sequence ve video export aynı `Viewer Output` sonucuna dayanmalı. Ancak
random/noise, time-aware VHS/CRT ve timeline keyframe'leri için piksel paritesi
ayrı smoke test ister.

Kabul kriteri:

* Aynı frame için preview, still PNG, sequence frame ve video frame karşılaştırılabilir olmalı.
* Random/noise algoritmaları seed veya zaman kaynağı açısından deterministik olmalı.

### P2 - Animated GIF ve WebP Export
GIF ve animated WebP, dither estetiği için değerli paylaşım formatlarıdır. Bunlar
still export formatı gibi değil, video export ailesinin ayrı hedefleri olarak
tasarlanmalıdır.

Notlar:

* GIF için FFmpeg `palettegen` / `paletteuse` tabanlı iki geçişli kalite yolu düşünülmeli.
* Animated WebP için kalite, FPS, loop ve alpha desteği kararı gerekir.
* Büyük dosya boyutu ve renk kaybı UI'da açıkça gösterilmelidir.

### P2 - Chroma Key / Color Key Node
Mevcut maske düğümleri temel hattı kuruyor; eksik olan belirli bir rengi veya renk
aralığını maskeye dönüştüren özel bir keying düğümüdür.

Önerilen kapsam:

* `chroma-key` ya da `color-key` düğümü.
* Key color, tolerance, softness, spill suppression ve invert parametreleri.
* Çıktı modu: BW mask veya source-alpha benzeri maske.

### P2 - Text ve Generator Node'ları
Harici görsel olmadan içerik üretmek için source-like düğümlere ihtiyaç var.
Bu başlık, ileride `mesh-gradient` ve diğer procedural source planlarıyla birlikte
ele alınmalı.

Önerilen ilk kapsam:

* `text` node: font, size, color, align, stroke/shadow, pixel font seçenekleri.
* `solid` node: tek renk/alpha üretimi.
* `gradient` veya `mesh-gradient` node: ayrı entegrasyon dokümanıyla hizalanmalı.

### P3 - Sub-graphs / Macros
Grafik modeli şu an düz `nodes` ve `edges` listesine dayanıyor. Büyük efekt
zincirleri için grup/macro desteği değerli olur, fakat runtime, serialize/load,
selection, viewport ve inspector davranışlarını etkilediği için geniş kapsamlıdır.

Bu başlık için ana referans: [node_gelisme.md](node_gelisme.md).

### P3 - Preset Paylaşımı
Base64 ya da sıkıştırılmış JSON ile graph/preset paylaşımı topluluk açısından
değerli olabilir. Önce lokal preset formatı ve güvenli import davranışı
netleşmelidir.

Önerilen sıra:

1. Stabil preset JSON şeması.
2. Import preview ve uyumluluk kontrolü.
3. Kopyala/yapıştır paylaşım formatı.

## 3. Mimari Fırsat: Worker / OffscreenCanvas
`graph-runtime.js` şu an main thread üzerinde çalışır. CPU dither, yüksek çözünürlük
ve bazı canvas okuma/yazma akışları UI akıcılığını etkileyebilir. Worker +
OffscreenCanvas hattı önemli bir performans fırsatıdır, fakat platform desteği ve
WebGL2 fallback davranışı netleştirilmeden ana yol haline getirilmemelidir.

Bu başlık için ana referans: [mimari_gelisme.md](mimari_gelisme.md).

## Önerilen Sıra

1. Export paritesi + audio sözleşmesi.
2. GIF / animated WebP export.
3. Chroma Key node.
4. Text / generator node'ları.
5. Preset paylaşımı.
6. Worker / OffscreenCanvas performans hattı.
7. Sub-graphs / Macros.
