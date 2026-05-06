# Dither Lab Kapsamlı Proje Analizi

> Durum: 2026-05-06 tarihinde kod tabanı, `ROADMAP.md` ve `TODO.md` ile yeniden
> doğrulandı. Bu belge genel proje fotoğrafı olarak tutulmalıdır; tickable
> ilerleme takibi için `ROADMAP.md`, uygulama sırası için `TODO.md`, detay
> kararlar için `docs/spec/` kaynak alınmalıdır.

## 1. Proje Özeti ve Amacı
**Dither Lab**, görsel içerik (fotoğraf ve video) üzerinde "dithering"
(noktasal/pikselli ton yayılımı) ve çeşitli görsel efektlerin uygulandığı
yerel (local-first) bir stüdyo uygulamasıdır. Klasik katmanlı (layer-based)
yapıdan ziyade, **Düğüm Tabanlı (Node-Graph)** bir düzenleme mantığına
(Nuke veya DaVinci Resolve Fusion gibi) dayanarak çalışır.

Uygulamanın ana hedefleri:
- Kapsamlı bir "dither" algoritma kataloğu sunmak.
- Gelişmiş palet yönetimi sağlamak (klasik konsol renkleri, özel palet oluşturma).
- Video dosyalarını işleyebilme, kare bazlı ilerleme ve dışa aktarım süreçlerini yönetebilme.

## 2. Mimari ve Teknoloji Yığını
Uygulama, masaüstü bir yazılım olarak **Tauri** çerçevesi üzerinde inşa edilmiştir.

* **Frontend (Arayüz ve İş Mantığı):** `Vanilla HTML / CSS / JS`
  kullanılmıştır; React/Vue gibi bir framework yoktur. Node editor kabuğu DOM
  ve SVG path'ler ile çizilirken, önizleme hattında 2D canvas ve WebGL2 tabanlı
  efekt yardımcıları (`src/js/gpu-effects.js`) birlikte kullanılır. Modüler yapı
  `src/js/` altında görülebilir (`graph.js`, `graph-runtime.js`,
  `image-ops.js`, `gpu-effects.js`, `export.js`, vb.).
* **Backend (Sistem İşlemleri):** Tauri ile **Rust** (`src-tauri`) dili
  kullanılmıştır. Dosya sistemi erişimi, native render sınırı, sistem FFmpeg
  süreciyle video dışa aktarım denemesi ve ileride planlanan wgpu hattı Rust
  tarafında tutulmaktadır.

## 3. Mevcut Durum ve Tamamlanan Özellikler (Mayıs 2026 İtibarıyla)
Proje planlama açısından disiplinli ilerliyor. `ROADMAP.md` ve `TODO.md`
dosyaları son olarak 2026-04-23'te yenilenmiş olsa da kod tabanında export ve
native render tarafında daha yeni ilerlemeler görülüyor. Bu nedenle bu bölüm
hem plan belgeleri hem de mevcut kodla birlikte okunmalıdır.

**Tamamlanan Kritik Modüller:**
1. **Node Graph Sistemi (Faz A-C):**
   - Kaynak videoyu alma, İşleme düğümleri (`Adjust`, `Dither`, `Blur`, `Glow`, `Distort`, `Mix`) üzerinden geçirme ve görüntüleme.
   - Sürükle-bırak desteği, döngü engelleme (cycle rejection) ve özellik denetçisi (inspector).
2. **Kapsamlı Dither Algoritmaları (Faz 6):**
   - Tam **27 farklı algoritma** uygulanmış durumda. Bunların arasında Floyd-Steinberg, Atkinson, Bayer matrisleri (2x2'den 16x16'ya), Halftone, Blue Noise ve desen (pattern) bazlı algoritmalar mevcut. `ROADMAP.md`'ye göre `smoke/algorithms.html` 2026-04-23 tarihinde 108/108 kombinasyonda başarıyla geçmiş.
3. **Gelişmiş Palet Sistemi (Faz 7):**
   - 14 adet hazır nostaljik/klasik palet (Gameboy DMG, C64, Mac Plus, NES vb.).
   - Kullanıcının videodaki/görseldeki mevcut kareden palet çıkarabilmesi
     (mevcut uygulama deterministik Median Cut yaklaşımı kullanıyor).
   - Özel palet oluşturma, düzenleme ve projeye kaydetme yetenekleri.

## 4. Karşılaştırma ve İnceleme Modları
Kullanıcı deneyimini güçlendirmek için güçlü karşılaştırma modları eklenmiş:
* **Processed:** İşlenmiş hali görme.
* **Original / Dither Only:** Sadece orijinali veya sadece dither uygulanmış katmanı görme.
* **Split / Side by Side:** Ekranı bölerek veya yan yana orijinal ile işlenmiş halini kıyaslama.

## 5. Gelecek Yol Haritası ve Eksikler (Sıradaki İşler)
Projede temel node graph, preview, palette ve efekt yetenekleri oturtulmuş
durumda. Sıradaki işlerin odağı stabilizasyon, preview/export paritesi ve export
akışının ürünleşmesidir.

**Öncelikli Yapılacaklar Listesi:**
1. **Faz C Stabilizasyonu (Smoke Testleri):** Tauri dev ortamında gerçek zamanlı oynatma, kırpma (trim) ve karmaşık grafik ağaçlarında stabilite testleri.
2. **Faz 11 - Dışa Aktarım (Export) Ürünleştirme:**
   - Mevcut akışta current-frame still export, image sequence export ve sistemde
     bulunan FFmpeg'e frame stream ederek video export denemesi vardır.
   - Hala netleştirilmesi gerekenler: FFmpeg'in gerçek Tauri sidecar olarak
     paketlenmesi, preview/export pixel paritesi, seed determinism testleri,
     progress/cancel davranışının smoke edilmesi ve başarılı export sonrası
     klasörde gösterme (Reveal) deneyimi.
   - Image sequence tarafında mevcut kodda PNG/JPEG hedefleri ve frame naming
     akışı vardır; TIFF ve EXR sequence export ayrı karar/implementasyon
     gerektirir.
3. **Ertelenen Özellikler (Deferred):**
   - **Native Render Track:** Gelecekte performansı artırmak adına işlemleri tamamen Rust/wgpu tabanlı motorla yapma planı.
   - **Lens Flare (Mercek Parlaması):** Gelişmiş optik efekt düğümlerinin eklenmesi.
4. **Plan Belgelerini Güncelleme:**
   - `ROADMAP.md` ve `TODO.md`, export kodundaki son ilerlemeleri yansıtacak
     şekilde yeniden tazelenmelidir.
   - Bu klasördeki entegrasyon dokümanları ile `docs/spec/` arasındaki çakışan
     kavramlar tek bir karar kaynağına bağlanmalıdır.

## 6. Kod ve Dizin Yapısı İncelemesi
* `src/js/dither/`: Dither algoritmalarının barındığı bölüm.
* `src/js/graph.js` & `src/js/graph-runtime.js`: Uygulamanın kalbi olan düğüm ağacı (node tree) mantığı ve çalışma zamanı (runtime) değerlendirmesi.
* `src/js/palettes.js` & `src/js/palette-extraction.js`: Renk paletleri ve videodan renk çıkarma logiği.
* `src/js/gpu-effects.js`: Blur, Glow, Distort gibi GPU hızlandırması gerektiren görsel efektler.
* `src/js/export.js`: Still, sequence ve video export sheet akışını yöneten frontend modülü.
* `src-tauri/src/engine/video_export.rs`: Sistem FFmpeg sürecini başlatıp raw RGBA frame stream eden Rust export yöneticisi.
* `src-tauri/src/engine/`: Rust tabanlı native işleme motorunun başlangıç altyapısı.

## 7. Kabul Kriteri Olarak Netleştirilecek Noktalar
Bu belge genel bir analiz olduğu için aşağıdaki maddeler ayrı task veya roadmap
kalemi olarak netleştirilmelidir:

1. Tauri dev smoke: playback, trim, compare, split/side-by-side ve branched graph senaryoları.
2. Export parity: preview ile still, sequence ve video çıktısının aynı frame için piksel düzeyinde karşılaştırılması.
3. FFmpeg paketleme kararı: sistem `ffmpeg` bağımlılığı mı, Tauri sidecar mı, yoksa iki aşamalı fallback mi?
4. Determinism: Random/Blue Noise gibi zamana veya seed'e duyarlı algoritmaların preview/export davranışı.
5. Dokümantasyon hijyeni: `ROADMAP.md`, `TODO.md`, `docs/spec/` ve `docs/yeni_mimari/` arasında kaynak-of-truth hiyerarşisi.

## Sonuç
Dither Lab, sadece basit bir filtre uygulamasının ötesinde, profesyonel bir
"compositing" (birleştirme) mantığına sahip, node tabanlı ve nostaljik estetiği
teknik derinlikle ele alan olgunlaşan bir projedir. Mevcut kod tabanı modüllere
ayrılmıştır; bundan sonraki ana riskler özellik eksikliğinden çok doğrulama,
export ürünleşmesi ve dokümanların güncel mimariyle hizalanmasıdır.
