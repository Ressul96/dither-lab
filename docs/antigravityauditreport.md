# DITHER LAB - DETAYLI TEKNİK ANALİZ VE SORUN TESPİT RAPORU

Bu rapor, Dither Lab uygulamasındaki **export (dışa aktarım) hattının dayanıklılığı**, **önizleme/dışa aktarım eşleşme kalitesi (preview/export parity)** ve **arka plan performans darboğazları** üzerine gerçekleştirilen detaylı kod analizini ve tespit edilen sorunları içermektedir.

---

## 1. Kritik Hatalar ve Performans Darboğazları

### A. Video Framerate ve Oynatma Hızı Bozulması (WebCodecs IVF Export)
WebCodecs video dışa aktarımında kullanılan IVF kapsayıcısı (container) oluşturma mantığında kritik bir zamanlama hatası bulunmaktadır.
* **Sorun:** [export.js](file:///Users/resulercan/Desktop/dither-lab/src/js/export.js#L2187-L2188) dosyası içindeki `createIvfFile` fonksiyonu, IVF zaman tabanı paydasını (timebase denominator) `Math.round(fps)` olarak yuvarlamakta ve payı (numerator) `1` olarak sabit kodlamaktadır.
* **Etki:** Küsuratlı standart video kare hızlarında (örneğin `23.976` fps, `29.97` fps veya `59.94` fps) kare hızları sırasıyla `24`, `30` ve `60` değerlerine yuvarlanacaktır. Ancak dışa aktarım döngüsü [export.js](file:///Users/resulercan/Desktop/dither-lab/src/js/export.js#L2101-L2104) satırlarında kareleri milisaniye bazında `i / fps` formülü ile oluşturup paketlemektedir. Bu durum dışa aktarılan IVF dosyasının orijinal videodan daha hızlı oynamasına, video süresinin kısalmasına ve sonradan eklenecek seslerle ciddi senkronizasyon kaymalarına (Audio Desync) neden olacaktır.
* **Kaynak Kod Referansı:** [export.js L2187-L2188](file:///Users/resulercan/Desktop/dither-lab/src/js/export.js#L2187-L2188) ve [export.js L2101-L2104](file:///Users/resulercan/Desktop/dither-lab/src/js/export.js#L2101-L2104)

### B. Dışa Aktarım Sırasında Yarış Durumu (Race Condition) ve Kanvas Bozulması
Dışa aktarım işlemi sürerken önizleme döngüsü (preview loop) veya kullanıcı arayüzü tetiklemeleri nedeniyle arka planda çalışan kanvas güncellemeleri dışa aktarılan görüntüyü bozabilmektedir.
* **Sorun:** Dışa aktarım başladığında `exportSessionActive` bayrağı `true` yapılmakta ve video oynatıcı duraklatılmaktadır. Ancak [source.js](file:///Users/resulercan/Desktop/dither-lab/src/js/source.js#L974-L1050) içindeki ana çizim fonksiyonu `renderCurrentFrame`, bu bayrak aktifken çalışmasını engelleyecek bir kontrole sahip değildir. Dışa aktarım döngüsü `seekForExport` ile asenkron video arama (seek) işlemlerini beklerken [source.js L826-L835](file:///Users/resulercan/Desktop/dither-lab/src/js/source.js#L826-L835) satırlarındaki asenkron bekleme (macro-task) anlarında ana JavaScript thread'i boşa çıkar. Bu sırada gelebilecek herhangi bir parametre değişikliği, pencere boyutu ayarlanması veya zaman çizgisi tetiklemesi `scheduleRender` üzerinden `renderCurrentFrame` fonksiyonunu çalıştırabilir.
* **Etki:** Çalışan bu paralel çizim, dışa aktarımın o an okumaya hazırlandığı `processedCanvas` ve `ditherCanvas` küresel değişkenlerinin içeriğini ezerek dışa aktarılan videoda rastgele karelerde önizleme görüntüsünün çıkmasına (frame corruption) neden olacaktır.
* **Kaynak Kod Referansı:** [source.js L974-L982](file:///Users/resulercan/Desktop/dither-lab/src/js/source.js#L974-L982) ve [source.js L856](file:///Users/resulercan/Desktop/dither-lab/src/js/source.js#L856)

### C. Tauri IPC Veri İletim Yükü ve CPU-GPU Kopyalama Darboğazı (Native Preview)
* **Sorun:** Rust tarafında GPU hızlandırmalı çalıştırılan `native_render_graph` altyapısı, WebView ile Rust arasında raw piksel dizilerinin kopyalanmasına dayanmaktadır. [native-render.js](file:///Users/resulercan/Desktop/dither-lab/src/js/native-render.js#L68-L76) dosyası her karede kanvas piksellerini belleğe çekip Tauri IPC kanalı üzerinden Rust tarafına göndermekte, Rust ise işlediği piksel dizisini tekrar IPC üzerinden JS tarafına geri yollamaktadır.
* **Etki:** 1080p bir kare için her yönde yaklaşık `8.3 MB` ham piksel verisi serileştirilerek taşınmaktadır. Bu durum büyük bir işlemci ve bellek kopyalama darboğazı yaratır. Ayrıca piksel okumak için kanvas bağlamı `willReadFrequently: true` ile oluşturulduğundan tarayıcının donanım ivmeli çizim avantajı tamamen devre dışı kalmaktadır.
* **Kaynak Kod Referansı:** [native-render.js L68-L76](file:///Users/resulercan/Desktop/dither-lab/src/js/native-render.js#L68-L76)

### D. Rust Tarafında Mutex Kilitlenme Riski
* **Sorun:** [video_export.rs](file:///Users/resulercan/Desktop/dither-lab/src-tauri/src/engine/video_export.rs) dosyası içindeki `ActiveSession` yapısı, FFmpeg alt sürecine (sidecar) veri besleyen kanalları tek bir `Mutex` arkasında korumaktadır. Dışa aktarımın iptal edilmesi (`abort_export`) veya hata durumlarında bu kilidin uzun süre tutulması durumunda Tauri IPC çağrısı yapan ana iş parçacığı (main thread) kilitlenebilir.
* **Kaynak Kod Referansı:** [video_export.rs L40-L80](file:///Users/resulercan/Desktop/dither-lab/src-tauri/src/engine/video_export.rs#L40-L80)

---

## 2. Önizleme (Preview) ve Dışa Aktarım (Export) Arasındaki Uyumsuzluklar (Parity Gaps)

### A. Blur Algoritması Mismatch (Kutu Tipi Bulanıklaştırma vs. Gauss Tipi Bulanıklaştırma)
* **Sorun:** Native önizleme devredeyken blur düğümü Rust tarafında iki geçişli bir **Box Blur** (`box_blur` iki kere çalıştırılarak) algoritması ile hesaplanır: [frame.rs L329-L337](file:///Users/resulercan/Desktop/dither-lab/src-tauri/src/engine/frame.rs#L329-L337). Ancak dışa aktarım sırasında native motor pasif olduğundan sistem JS CPU/GPU fallback yolunu kullanır. JS tarafındaki blur algoritması ise [image-ops.js L301-L312](file:///Users/resulercan/Desktop/dither-lab/src/js/image-ops.js#L301-L312) satırlarında görüldüğü üzere tarayıcının yerleşik **Gaussian Blur** motorunu (`ctx.filter = "blur(...)"`) veya WebGL tabanlı Gauss shader'ını çalıştırmaktadır.
* **Etki:** Box Blur ve Gaussian Blur algoritmalarının görsel çıktıları ve ışık dağılım eğrileri farklıdır. Kullanıcının önizlemede gördüğü yumuşama etkisi dışa aktarılan nihai videoda daha farklı görünecektir. Bu durum projenin en temel kurallarından biri olan "Önizleme ve Dışa Aktarım Eşleşmesi" prensibine aykırıdır.
* **Kaynak Kod Referansı:** [frame.rs L329-L337](file:///Users/resulercan/Desktop/dither-lab/src-tauri/src/engine/frame.rs#L329-L337) ve [image-ops.js L301-L312](file:///Users/resulercan/Desktop/dither-lab/src/js/image-ops.js#L301-L312)

### B. Native Render Sırasında Dither Çıktısının Aktarılmaması
* **Sorun:** Rust tarafındaki native işleme motorunun yanıt yapısını kuran [frame.rs L102-L105](file:///Users/resulercan/Desktop/dither-lab/src-tauri/src/engine/frame.rs#L102-L105) kod bloğunda, dither çıktısını taşıması gereken `dither_output` alanı doğrudan `None` olarak hardcode edilmiştir.
* **Etki:** Eğer dither düğümü içeren veya dither-only çıktı modunda olan bir grafik native işleme motoruna girerse önizlemede dither katmanı görüntülenemeyecek veya hatalı bir şekilde boş kalacaktır.
* **Kaynak Kod Referansı:** [frame.rs L102-L105](file:///Users/resulercan/Desktop/dither-lab/src-tauri/src/engine/frame.rs#L102-L105)

---

## 3. Ürün Spesifikasyonlarında Tanımlı Ancak Kod Tabanında Eksik Kalan Özellikler

### A. EXR Dizi (EXR Sequence) Desteği Eksikliği
* **Sorun:** `CLAUDE.md` ve `Cargo.toml` açıklamalarında projenin "EXR sequence" formatını desteklediği yazılmış olsa da, Rust bağımlılıklarını belirleyen [Cargo.toml](file:///Users/resulercan/Desktop/dither-lab/src-tauri/Cargo.toml) dosyasında OpenEXR formatlarını işleyecek hiçbir kütüphane (`exr`, `image` vb.) tanımlanmamıştır. Ayrıca arayüz dosya yükleme filtrelerinde [source.js L25-L27](file:///Users/resulercan/Desktop/dither-lab/src/js/source.js#L25-L27) EXR formatı yer almamaktadır.
* **Etki:** Spesifikasyonda belirtilen çok katmanlı EXR kanalları ve pass seçimi özellikleri tamamen işlevsiz ve eksiktir.

### B. Ses Desteğinin (Audio Support) Olmaması
* **Sorun:** Ürün özelliklerinde belirtilen "Orijinal sesi koruma", "AAC" veya "Opus" kodlama seçenekleri ne dışa aktarım arayüzünde mevcuttur ne de Rust tarafındaki FFmpeg komut yapısında yer almaktadır. Dışa aktarılan tüm videolar sessiz (silent) olarak üretilir.

### C. Sıralı Görüntü (Image Sequence) İptal Temizliği Eksikliği
* **Sorun:** Kullanıcı sıralı PNG/JPG dışa aktarımı yaparken işlemi iptal ettiğinde, o ana kadar diske yazılmış olan yarım kareler silinmemekte ve hedef klasörde dağınık bir şekilde kalmaktadır.

---

## 4. Öneriler ve Çözüm Planı (Kod Değişikliği İzninden Sonra)

1. **Zaman Tabanı Düzeltmesi:** `createIvfFile` fonksiyonuna küsuratlı kare hızları için payda ve pay hesaplayıcı (örneğin `23.976` için `24000/1001` oranlaması) entegre edilmelidir.
2. **Yarış Durumu Engeli:** `renderCurrentFrame` fonksiyonunun başına `if (exportSessionActive && !calledFromExportPath) return;` kontrolü eklenerek dışa aktarım sırasında arayüzün kanvasları bozması önlenmelidir.
3. **Blur Algoritması Eşitlemesi:** Rust backend'indeki iki geçişli box-blur, JS tarafındaki Gaussian katsayılarıyla birebir eşleşecek şekilde gerçek Gaussian filtresine yükseltilmeli ya da önizleme için de tutarlı bir Box-Blur seçeneği sunulmalıdır.
4. **IPC Optimizasyonu:** Native önizleme performansı için raw piksel transferi yerine WebGL dokularının (textures) doğrudan GPU üzerinde paylaşılması veya native render özelliğinin yalnızca tamamen headless dışa aktarımlarda kullanılması değerlendirilmelidir.

---

## 5. UI Arayüzündeki Tasarım ve Düzen Bozuklukları (UI Layout & Design Defects)

Aşağıda, uygulamanın kullanıcı arayüzünde (UI) ve yerleşim yapısında (layout) tespit edilen görsel ve işlevsel bozukluklar listelenmiştir:

### A. Yan Panel Boyutlandırma Yönlerinin Ters Olması (Inverted Panel Resizing)
* **Açıklama:** Sol (`inspector`) ve Sağ (`rightPanel`) panelleri genişletip daraltmak için kullanılan `.resize-handle` öğelerinin sürükleme yönleri ile panellerin boyut değişim yönleri birbiriyle çelişmektedir.
* **Detay:** [shell.js](file:///Users/resulercan/Desktop/dither-lab/src/js/ui/shell.js#L56-L70) dosyasındaki boyutlandırma mantığında `growRight` değişkeni aşağıdaki gibi atanmıştır:
  ```javascript
  const growRight = handle.dataset.side === "right";
  ```
  - Sol panel (`side === "left"`) için `growRight` değeri `false` olur ve genişlik `startW - dx` formülüyle güncellenir. Bu yüzden imleci sağa doğru (dx > 0) çektiğimizde sol panel daralır, sola çektiğimizde (dx < 0) ise genişler.
  - Sağ panel (`side === "right"`) için `growRight` değeri `true` olur ve genişlik `startW + dx` formülüyle güncellenir. Panel ekranın en sağında yer aldığı için imleç sola çekildiğinde (dx < 0) panelin genişlemesi gerekirken, kod `dx` değerini eklediği için panel daralmaktadır.
* **Etki:** Kullanıcı arayüzünde panelleri sürükleyerek boyutlandırmak istendiğinde, paneller farenin hareket yönünün tam tersine hareket eder. Bu durum son derece kafa karıştırıcı ve hatalı bir deneyim oluşturur.
* **Kaynak Kod Referansı:** [shell.js L56-L70](file:///Users/resulercan/Desktop/dither-lab/src/js/ui/shell.js#L56-L70)

### B. Zaman Çizelgesi Cetveli ve Playhead Hizalama Hatası (Timeline Ruler & Playhead Misalignment)
* **Açıklama:** Zaman çizelgesindeki anahtar kareler (keyframes) ile zaman cetveli (time-ruler) üzerindeki saniye çizgileri ve oynatma kafası (playhead) dikey düzlemde birbiriyle hizasızdır.
* **Detay:** [main.css](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2667) dosyasında anahtar kareleri barındıran `.lane-host` bileşenine `padding: 0 12px;` verilmiştir. Aynı şekilde `.render-range-overlay` bileşeni de `inset: 0 12px;` değerine sahiptir.
  - Ancak zaman cetveli (`.time-ruler`) [main.css L2554](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2554) ve oynatma kafası (`.playhead`) [main.css L2601](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2601) doğrudan `.timeline-pane-body` / `.timeline-pane-head` genişliğine göre (`0%` - `100%`) hizalanmaktadır ve herhangi bir sol/sağ dolguya (padding/margin) sahip değildir.
* **Etki:** Zaman çizelgesinde `0s` konumunda duran bir keyframe daima `12px` içeriden başlarken, oynatma kafası (playhead) ve zaman cetvelinin sıfır noktası en soldan (`0px` hizasından) başlar. Bu nedenle, oynatma kafası keyframe çizgilerinin yaklaşık 12 piksel gerisinde/hizasız görünür.
* **Kaynak Kod Referansı:** [main.css L2667](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2667), [main.css L2554](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2554) ve [main.css L2601](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2601)

### C. Node Editörü Minimum Yükseklik Taşıma Hatası (Node Editor Minimum Height Overflow)
* **Açıklama:** Node editörü paneli minimum yükseklik sınırı olan `220px` değerine getirildiğinde, içindeki çalışma alanı kabuğun dışına taşmaktadır.
* **Detay:** `.node-editor-shell` bileşenine [main.css L1043](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L1043) altında `padding: 16px;` tanımlanmıştır. Grid yapısı row 3'ü `minmax(220px, var(--node-editor-h))` olarak belirler.
  - Ancak çalışma alanı olan `.node-editor-surface` bileşeni [main.css L1053](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L1053) altında `min-height: 220px;` olarak tanımlanmıştır.
  - Kutu modeli (`border-box`) altında, `220px` yükseklikteki shell bileşeninin içeriğe kalan net alanı `220px - 32px = 188px` olmaktadır. İçerideki surface `220px` yükseklik talep ettiği için alt kısımdan `32px` taşarak scrollbar oluşmasına veya görsel kırpılmalara neden olur.
* **Etki:** Panel en küçük boyuta getirildiğinde gereksiz kaydırma çubukları ortaya çıkar ve düzen estetiği bozulur.
* **Kaynak Kod Referansı:** [main.css L1043](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L1043) ve [main.css L1053](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L1053)

### D. Zaman Cetvelinin Üstten/Alttan Kesilmesi (Time Ruler Clipping)
* **Açıklama:** Zaman cetvelindeki saniye etiketleri ve çizgileri başlık panelinin dışına taşarak kesilmektedir.
* **Detay:** [main.css L2495](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2495) altında `.timeline-pane-head` yüksekliği `48px` olarak sabitlenmiş ve `overflow: hidden` tanımlanmıştır.
  - İçerideki araç çubuğu `.timeline-pane-toolbar` (`min-height: 26px`, dolgular ve border ile birlikte yaklaşık `33px` yer kaplar) ve `.time-ruler` (`height: 21px`) elemanlarının toplam yüksekliği `54px` bulmaktadır.
* **Etki:** `54px` toplam yüksekliğin `48px` alana sıkıştırılıp kırpılması sonucunda, `.time-ruler` bileşeninin altındaki saniye çizgilerinin ve etiketlerin yaklaşık 6 piksellik kısmı görsel olarak kaybolmaktadır.
* **Kaynak Kod Referansı:** [main.css L2495](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2495) ve [main.css L2553](file:///Users/resulercan/Desktop/dither-lab/src/styles/main.css#L2553)

### E. Katman Özellik Sürgülerinin (Opacity, Hue, Saturation) Başlangıçta Yarı Yarıya Dolu Görünmesi (Layer Property Sliders 50% Fill Bug)
* **Açıklama:** Inspector panelinde, varsayılan değeri 100 (ya da farklı başlangıç değerleri) olan Opacity gibi katman özelliklerinin mavi ilerleme çizgisi sürgünün tam ortasına kadar (yarıya kadar) dolu görünmektedir.
* **Detay:** Sürgülerin görsel dolgusu (mavi renkli ilerleme çizgisi), CSS içinde tanımlanmış olan `--slider-fill` özel değişkeni (custom property) ile çizilmektedir:
  ```css
  input[type="range"] {
    ...
    --slider-fill: 50%; /* CSS Varsayılanı */
  }
  ```
  - Grafik düğüm parametreleri için kullanılan `renderRangeField` fonksiyonu, ilk render sırasında `style="--slider-fill: ${fillPct}%"` niteliğini HTML'e yazmaktadır.
  - Ancak katman (layer) özellikleri için kullanılan [renderLayerRangeField](file:///Users/resulercan/Desktop/dither-lab/src/js/ui/graph-shell.js#L5745-L5778) fonksiyonunda, sürgünün başlangıç dolgu yüzdesini (`fillPct`) hesaplayan ve bunu `style` niteliği olarak range input'a yazan mantık **tamamen unutulmuştur**. 
  - Bu yüzden sürgü ilk oluşturulduğunda HTML üzerinde inline bir style tanımlanmadığından, CSS varsayılanı olan `--slider-fill: 50%` değeri devreye girmekte ve sürgü mavi dolgusu tam yarıda (50%) çizilmektedir. Kullanıcı sürgüyü ilk kez sürüklediğinde ise JS olayı tetiklenip değişkeni güncellediği için çizgi normale dönmektedir.
* **Etki:** Opacity varsayılan olarak %100 seçilmiş olmasına rağmen, sürgünün mavi ilerleme çizgisi %50'de görünerek arayüzde yanıltıcı ve kusurlu bir görsel duruma yol açar.
* **Kaynak Kod Referansı:** [graph-shell.js L5745-L5778](file:///Users/resulercan/Desktop/dither-lab/src/js/ui/graph-shell.js#L5745-L5778) ve [controls.css L673-L681](file:///Users/resulercan/Desktop/dither-lab/src/styles/controls.css#L673-L681)


