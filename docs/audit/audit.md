# Dither Lab — İyileştirme Yol Haritası

**Tarih:** 2026-05-20
**Girdiler:** [docs/audit/2026-05-18-code-audit.md](2026-05-18-code-audit.md) + [docs/antigravityauditreport.md](../antigravityauditreport.md)
**Tip:** Audit raporu değil, uygulanabilir faz planı. Her faz "amaç → görev → dokunulacak dosya → başarı kriteri" biçiminde.

> İki kaynak rapordaki bulgular kesişiyor. Bu doküman; Antigravity raporunun mantıklı maddelerini alır, 2026-05-18 auditindeki henüz kapatılmamış maddelerle birleştirir, son commit'lerde halledilenleri ayırır.

---

## 0. Son Commit'lerle Kapatılanlar

Eski audit'in aşağıdaki kalemleri artık kodda çözüldü; bu plana **eklemiyoruz**:

| Eski audit maddesi | Çözen commit |
|---|---|
| P0 #4 — Rust stringly-typed errors | `8c26cf7 Add structured engine errors` |
| P1 #9 — CSP + asset protocol scope | `8a9d9b0 Harden Tauri security config` |
| P1 #11 — `player.js` style interpolation kaçışı | `fb3c443 Sanitize timeline style colors` |
| P2 #15 — `image-ops.js` hot-loop allocations | `e1a4521 Reduce image ops hot-loop allocations` |
| P2 #16 — `escapeHtml` çoğaltması | `3af1abe Extract shared UI escaping helper` |
| P3 #19 — GPU renderer dispose | `affbb54 Add GPU renderer disposal hooks` |
| P2 #21 — `subscribe(full-render)` (kısmi) | `8c2439a perf(graph): skip graph rebuild during inspector drags` |
| F22 timeline minimise | `cf5f636 feat(timeline): collapsed by default + drag to reposition` |
| F23 slider redesign | `dccd19f feat(inspector): After Effects-style slider + scrubbable number` |
| F24 group I/O proxy | `bb61055 feat(group): virtual I/O proxy nodes inside groups` |
| Default pan davranışı | `6e7dee5 feat(graph): default left-drag back to pan` |

---

## Faz A — Export Parity Krizleri (Öncelik 1)

**Amaç:** Önizleme ↔ export eşleşmesini bozan ya da export'u sessizce yanlış üreten kritik mantık hatalarını kapatmak. CLAUDE.md'deki "Export must match preview" non-negotiable'ı doğrudan ilgilendirir.

### Görevler

1. **IVF zaman tabanı (timebase) küsuratlı fps düzeltmesi**
   - Sorun: `createIvfFile` paydayı `Math.round(fps)` ile tam sayıya yuvarlıyor (`23.976→24`, `29.97→30`, `59.94→60`); kare paketleme `i / fps` ile saniye tabanlı yapıldığı için dışa aktarılan dosya **orijinalden daha hızlı oynuyor** ve sonradan eklenecek ses kayıyor.
   - Yapılacak: NTSC tabanlı fps'ler için pay/payda hesabı (`23.976 → 24000/1001`, `29.97 → 30000/1001`, `59.94 → 60000/1001`); tam sayı fps'ler için mevcut `1/fps` korunsun. Kare paketleme zamanlamasını da pay/payda ile birebir kurun (`pts = i * num / den` cinsinden ölçek).
   - Dosyalar: [src/js/export.js:2187-2188](../../src/js/export.js#L2187), [src/js/export.js:2101-2104](../../src/js/export.js#L2101).
   - Başarı kriteri: 23.976 fps kaynaktan alınan 100 karelik IVF'in toplam süresi `100 * 1001/24000 = 4.171s` (±1 frame); ffprobe çıktısı `r_frame_rate=24000/1001`.

2. **Export sırasında preview render guard'ı (race condition)**
   - Sorun: `exportSessionActive` set edilse de `renderCurrentFrame` bunu kontrol etmiyor; `seekForExport`'un async beklediği `await` noktalarında gelen parametre/resize/timeline tetiklemesi `processedCanvas` ve `ditherCanvas`'ı paralel olarak ezerek **export'a rastgele preview karelerinin sızmasına** neden olabiliyor.
   - Yapılacak: `renderCurrentFrame`'in başına `if (exportSessionActive && !calledFromExport) return;` koruması; export pipeline'ı için ayrı bir entry (`renderFrameForExport({sourceToken, time})`) ya da `internal=true` flag'i. Bu, eski audit'teki P0 #8 "async sync-called" maddesinin de bir parçasını kapatır.
   - Dosyalar: [src/js/source.js:974-982](../../src/js/source.js#L974), [src/js/source.js:856](../../src/js/source.js#L856).
   - Başarı kriteri: Export sırasında inspector slider'larını oynatmak / pencereyi yeniden boyutlandırmak / timeline scrub'ı çıktıyı kirletmiyor; smoke test (`smoke/algorithms.html`) bir export sırasında param değiştirip kareleri yeniden okuduğunda hash sabit kalıyor.

3. **Blur algoritması preview/export uyumsuzluğu**
   - Sorun: Native preview Rust tarafında iki geçişli **box blur**, JS fallback (export yolu dahil) tarayıcının yerleşik **Gaussian blur**'unu (`ctx.filter = "blur(...)"`) ya da WebGL Gauss shader'ını çalıştırıyor. Aynı `radius` parametresi iki farklı PSF üretiyor → preview ile export'un kenar düşüşü farklı.
   - Yapılacak: Tek bir kanonik blur tanımı (tercih: gerçek Gaussian, σ = radius/2 yaklaşımı; sigma ve kernel boyutu açıkça parametrize). Rust tarafında box blur'ı separable Gaussian'a çevir (ya da kabul edilebilirse JS tarafında box blur'a düş — fakat tarayıcı `ctx.filter` zaten Gaussian olduğu için Rust'ı eşitlemek doğru yön). Aynı σ ile ölçülen birim impulse response'lar pixel-cinsinden eşleşmeli.
   - Dosyalar: [src-tauri/src/engine/frame.rs:329-337](../../src-tauri/src/engine/frame.rs#L329), [src/js/image-ops.js:301-312](../../src/js/image-ops.js#L301), GPU shader yolu için [src/js/gpu-effects.js](../../src/js/gpu-effects.js) blur passleri.
   - Başarı kriteri: Tek-piksel impulse (256x256, beyaz nokta merkezde) `radius=4` ile native ve JS yollarda ±1/255 farkla aynı çıktı.

4. **Native render dither çıktısı eksikliği**
   - Sorun: [src-tauri/src/engine/frame.rs:102-105](../../src-tauri/src/engine/frame.rs#L102) — `NativeRenderResponse.dither_output` hardcode `None`. Native motora giren dither-içeren bir graph önizlemede dither katmanını üretmiyor; UI ya boş ya hatalı katman gösteriyor.
   - Yapılacak: Ya native motora dither node desteğini ekle (Rust tarafında en az `floyd-steinberg` ve `bayer-8x8` portu), ya da `canUseNativeRender` içinde dither node varsa `false` döndür ve graph'ı tamamen JS yoluna düşür. **Önerilen kısa vade:** native render dither node içeren graph'larda devre dışı kalsın; uzun vadede Rust'a port.
   - Dosyalar: [src-tauri/src/engine/frame.rs:102-105](../../src-tauri/src/engine/frame.rs#L102), [src/js/native-render.js:20](../../src/js/native-render.js#L20).
   - Başarı kriteri: Dither node içeren bir graph load edildiğinde native path "unsupported" cevabı verip JS path'e dönüyor; preview dither katmanı doğru gösteriliyor.

5. **`registry.runAlgorithm` sessiz Floyd–Steinberg fallback'i**
   - Sorun: Bilinmeyen algoritma ID'sinde sessizce Floyd–Steinberg'e düşüyor. Eski bir proje dosyası kaldırılmış bir algoritmaya referans verirse preview yanlış görüntü gösteriyor ve hata yok.
   - Yapılacak: Bilinmeyen ID'de `console.warn` + UI'da bir kez gösterilen "Algorithm X missing, using Y" uyarısı; ya da fallback'i kaldırıp explicit `throw`.
   - Dosyalar: [src/js/dither/registry.js](../../src/js/dither/registry.js).
   - Başarı kriteri: Unknown ID ile bir proje açıldığında kullanıcı görünür uyarı alıyor; smoke harness algorithms listesine olmayan bir ID koyulduğunda test başarısız oluyor.

6. **`noise` source `TIME_AWARE_TYPES`'a eklenmemiş**
   - Sorun: [src/js/graph-runtime.js:71](../../src/js/graph-runtime.js#L71) `TIME_AWARE_TYPES` listesinde `noise` yok; `animSpeed > 0` iken playhead scrub aynı params + aynı input ile çalıştığında cache hit yapıyor → animasyonlu noise donuk kalıyor (parity bug).
   - Yapılacak: Liste içine `"noise"` eklemek; `animSpeed === 0` ise cache hit'ine devam için ek koşul (`params.animSpeed > 0 ? include_frame_salt : skip`).
   - Dosyalar: [src/js/graph-runtime.js:71](../../src/js/graph-runtime.js#L71), [src/js/graph-runtime.js:390](../../src/js/graph-runtime.js#L390).
   - Başarı kriteri: `animSpeed=1` noise kaynaklı bir timeline 0→1s scrub edildiğinde her frame farklı pattern üretiyor.

---

## Faz B — UI Layout ve Görsel Doğruluk

**Amaç:** Antigravity raporunun UI bölümündeki ölçülebilir layout/CSS bug'larını kapatmak. Bunlar fonksiyonel değil ama kullanıcı deneyimini kabaca bozuyor.

### Görevler

1. **Panel resize yön bug'ı (sol panel ters hareket ediyor)**
   - Sorun: [src/js/ui/shell.js:56-70](../../src/js/ui/shell.js#L56) — `growRight = handle.dataset.side === "right"`. Sol panel sağa sürüklendiğinde daralıyor (doğru), **fakat sol handle pencere içinde panelin sağ kenarında olduğu için** kullanıcı algısı "panelin kenarını sağa çek → genişlesin" şeklinde. Bu sezgisel olmayan yön panel kenarının pozisyonuna göre yanlış.
   - Doğrulanması gereken: Sol panelin resize handle'ı sol kenarda mı yoksa sağ kenarda mı? Eğer sağ kenardaysa formül `startW + dx` olmalı (kullanıcı handle'ı sağa çekince genişlemeli). Aynı şekilde sağ panelin handle'ı sol kenardaysa `startW - dx`.
   - Yapılacak: `growRight` kararını `side`'a değil, handle'ın panel içindeki konumuna (sol kenar vs sağ kenar) bağla. Tek pratik düzelti: `const growWithDx = handle.dataset.edge === "left" ? false : true` (yeni `data-edge` attr).
   - Dosyalar: [src/js/ui/shell.js:56-70](../../src/js/ui/shell.js#L56), [src/index.html](../../src/index.html) (handle'lara `data-edge` ekle).
   - Başarı kriteri: Hem sol hem sağ panel için handle'ı dışarı çekince genişliyor, içeri çekince daralıyor.

2. **Timeline ruler ↔ playhead ↔ keyframe 12px hizalama hatası**
   - Sorun: `.lane-host` ve `.render-range-overlay` `padding/inset 0 12px`'e sahip; `.time-ruler` ve `.playhead` ise pane'in tam genişliğine (`0%–100%`) hizalanıyor. `0s` pozisyonundaki keyframe 12px içeriden başlarken playhead en soldan başlıyor.
   - Yapılacak: Ruler ve playhead'i de aynı 12px iç dolgu zarfı içine al — `.time-ruler` ve `.playhead`'in parent'ı (`.timeline-pane-body`) `padding: 0 12px` alsın, ya da `.lane-host`'tan padding kalksın ve keyframe konumları zaten doğru olan ruler grid'ine göre yeniden hesaplansın. **Önerilen:** parent padding'i ortak hale getir; keyframe ve render-range overlay padding'lerini kaldır (DRY).
   - Dosyalar: [src/styles/main.css:2667](../../src/styles/main.css#L2667), [src/styles/main.css:2554](../../src/styles/main.css#L2554), [src/styles/main.css:2601](../../src/styles/main.css#L2601).
   - Başarı kriteri: Playhead `0s` pozisyonunda bir keyframe ile piksel mükemmel hizalı; pencere boyutu değiştikçe sapma yok.

3. **Node editor minimum yükseklik taşması**
   - Sorun: `.node-editor-shell` `padding: 16px`, `.node-editor-surface` `min-height: 220px`. Shell de `minmax(220px, ...)` ile sınırlı → border-box ile içerik 220px isteyince shell'in net alanı 188px, 32px taşma scrollbar üretiyor.
   - Yapılacak: `.node-editor-surface`'in `min-height`'ını `0` yap ve surface'i flex/grid ile shell'in iç alanına `100%` olarak sığdır (shell `display: grid` ise `min-height: 0` zaten yeterli). Alternatif: shell'in min satırını `minmax(252px, ...)` (220 + 32) yap — daha az tercih.
   - Dosyalar: [src/styles/main.css:1043](../../src/styles/main.css#L1043), [src/styles/main.css:1053](../../src/styles/main.css#L1053).
   - Başarı kriteri: Node editor en küçük boyutta scrollbar çıkmıyor, taşma yok.

4. **Time ruler üst/alt kırpılması (6px)**
   - Sorun: `.timeline-pane-head` `height: 48px`, `overflow: hidden`. Toolbar (~33px) + ruler (`21px`) = 54px. 6px alt kısım gizleniyor.
   - Yapılacak: `.timeline-pane-head` yüksekliğini `54px`'a çıkar (basit), ya da toolbar'ı `min-height: 22px`'e düşürüp ruler ile beraber `48px`'a sığacak şekilde toolbar paddings'lerini sıkıştır.
   - Dosyalar: [src/styles/main.css:2495](../../src/styles/main.css#L2495), [src/styles/main.css:2553](../../src/styles/main.css#L2553).
   - Başarı kriteri: Saniye etiketleri tam görünüyor; alt çizgi kesilmiyor.

5. **Layer property slider %50 fill bug'ı**
   - Sorun: `renderRangeField` ilk render'da `style="--slider-fill: ${fillPct}%"` ekliyor; ancak [renderLayerRangeField](../../src/js/ui/graph-shell.js#L5745) bu adımı atlamış. CSS varsayılanı `50%` devreye girip Opacity 100'de bile dolgu yarıda görünüyor.
   - Yapılacak: `renderLayerRangeField` içinde aynı `fillPct` hesabını yapıp inline style'a yaz; veya iki helper'ı tek `renderRangeField({mode: "node"|"layer"})` altında birleştir.
   - Dosyalar: [src/js/ui/graph-shell.js:5745-5778](../../src/js/ui/graph-shell.js#L5745), [src/styles/controls.css:673-681](../../src/styles/controls.css#L673).
   - Başarı kriteri: Bir katman seçildiğinde Opacity slider başlangıçta tam dolu; Hue/Saturation default değerine uygun konumda gösteriliyor.

---

## Faz C — Rust Engine Sertleştirme

**Amaç:** Antigravity raporundaki Rust kilitlenme/yarış riskleri ile eski audit'in çözülmemiş P0/Rust maddelerini birleştirip native motor dayanıklılığını çıkarmak.

### Görevler

1. **`ActiveSession` Mutex hold süresi ve kilitlenme riski**
   - Sorun: [src-tauri/src/engine/video_export.rs:40-80](../../src-tauri/src/engine/video_export.rs#L40) — FFmpeg sidecar kanalları tek `Mutex` arkasında. `abort_export` ya da panik durumlarında uzun lock hold edilirse Tauri command thread'i kilitlenir.
   - Yapılacak: Mutex'i sadece pointer/handle alıp çıkacak şekilde daralt (`let child = { let mut g = lock.lock()?; g.take() };` sonra lock dışında `child.kill()`). Kanal yazımı için `try_lock` ve timeout.
   - Başarı kriteri: 5GB+ video export sırasında abort tek tıkta dönüyor, UI donmuyor.

2. **`Stdio::piped` stderr drain thread'i (henüz kapatılmamış)**
   - Sorun: FFmpeg uzun encode'larda stderr ~64KB'ı doldurursa ffmpeg yazımda bloklanır → tüm pipeline hang.
   - Yapılacak: `Command::spawn` sonrası `child.stderr.take()` üzerinde bir drain thread (BufReader satır satır, debug log'a yaz; release'de discard).
   - Dosyalar: [src-tauri/src/engine/video_export.rs](../../src-tauri/src/engine/video_export.rs).
   - Başarı kriteri: 10dk+ encode'da hang yok; debug build'de stderr satırları logda görünüyor.

3. **`Drop` impl — ActiveSession + GpuRenderer**
   - Sorun: Tauri uygulaması kapanırken / panic'te child ffmpeg orphan kalıyor.
   - Yapılacak: `impl Drop for ActiveSession { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }`. `GpuRenderer` için `Drop`'ta `device.poll(Wait)` (idempotent).
   - Başarı kriteri: macOS Activity Monitor / Windows Task Manager — quit-during-export sonrası ffmpeg process listesi temiz.

4. **`topological_sort` cycle detection (eski audit'te açık)**
   - Sorun: Cyclic edge içeren bozuk save file partial render üretiyor; hata yok.
   - Yapılacak: Sort sırasında `seen` + recursion stack ile cycle yakala, `RenderError::CyclicGraph` döndür.
   - Dosyalar: [src-tauri/src/engine/frame.rs](../../src-tauri/src/engine/frame.rs).
   - Başarı kriteri: Test fixture: A→B→A graph'ı `RenderError::CyclicGraph` üretiyor, partial frame değil.

5. **GPU init'i Tauri command thread'inden çıkar**
   - Sorun: [src-tauri/src/engine/gpu/mod.rs](../../src-tauri/src/engine/gpu/mod.rs) — `pollster::block_on` ilk çağrıda multi-100ms latency, command thread'i bloklar.
   - Yapılacak: App start'ta arka plan thread'de eager init; `OnceLock<Result<GpuRenderer, _>>` sakla. Native render çağrıları sadece hazır olan instance'ı kullansın, init asla command thread'de olmasın.
   - Başarı kriteri: İlk native render çağrısı <5ms; uygulama açılışında GPU init başarısız olduysa loglanıyor ve native render kalıcı olarak unsupported.

6. **`native-render.js` one-shot disable yerine reset hook**
   - Sorun: [src/js/native-render.js:16](../../src/js/native-render.js#L16) — bir invoke reject'iyle `nativeRenderAvailable = false` ve reload'a kadar kapalı. Geçici GPU hıçkırığı kalıcı demote.
   - Yapılacak: Exponential backoff retry (30s sonra tekrar dene) veya basit kullanıcı eylemiyle reset hook (`window.resetNativeRender()`).
   - Başarı kriteri: GPU driver crash → recovery sonrası kullanıcı reload yapmadan native path geri geliyor.

---

## Faz D — Yarış Durumu ve Asenkron Disiplin (JS)

**Amaç:** `source.js` ve `export.js`'in async/sync kontratlarını sıkılaştırmak; Faz A #2 ile el ele.

### Görevler

1. **`renderCurrentFrame` consistent promise dönüşü**
   - Sorun: `async` ama bazı çağrılarda `await` edilmiyor → fire-and-forget'ler renderVersion'ı geçtikten sonra `processedCanvas`'ı ezebiliyor.
   - Yapılacak: Tüm çağrı yerlerini denetle, ya `await` ya da explicit `.catch(noop)` + token guard. Worker yolu için de `renderVersion`/`sourceToken` epoch'unu native yoldakiyle aynı şekilde kontrol et.
   - Dosyalar: [src/js/source.js:966](../../src/js/source.js#L966), [src/js/source.js:1046](../../src/js/source.js#L1046).

2. **`getCurrentExportFrameCanvas` / `hasCurrentDitherFrame` senkron read API**
   - Sorun: Şu an `renderCurrentFrame()`'i `await`siz çağırıyor; export session dışında stale canvas dönüş riski var.
   - Yapılacak: İki ayrı API: `getCommittedFrame()` (saf sync read, en son commit'lenen canvas), `renderFrame(opts)` (explicit render). Export pipeline `renderFrameForExport({await: true})` çağırır.
   - Başarı kriteri: Export session dışında still export 2x tıklanırsa ikinci tıklamada stale frame yok.

3. **BT.601 vs BT.709 luma drift (eski audit P0 #1, hâlâ açık)**
   - Sorun: `image-ops.js`'de bazı node'lar BT.601, bazıları BT.709 kullanıyor; aynı pixel iki node'dan farklı luminance dönüyor → preview/export parity riski.
   - Yapılacak: [src/js/color.js](../../src/js/color.js) içinde `LUMA_BT709 = [0.2126, 0.7152, 0.0722]` ve `LUMA_BT601 = [0.299, 0.587, 0.114]` constant'ları; her node hangisini kullandığını comment'le belirtsin. **Önerilen kanon: Tüm dither/posterize/threshold/levels/duotone/gradient-map için BT.709.** GPU shader'ları da bu konvansiyona uyacak şekilde eşitle.
   - Dosyalar: [src/js/image-ops.js](../../src/js/image-ops.js), [src/js/palettes.js](../../src/js/palettes.js), [src/js/palette-extraction.js](../../src/js/palette-extraction.js), [src/js/gpu-effects.js](../../src/js/gpu-effects.js) shader sabitleri.
   - Başarı kriteri: Tek-pixel test grid'i (#FF0000, #00FF00, #0000FF + grayscale ramp) tüm node'larda aynı luminance üretiyor.

---

## Faz E — Eksik Spec Özellikleri

**Amaç:** CLAUDE.md'de promise edilmiş ama kodda henüz olmayan üç büyük özelliği eklemek. Bunlar yeni geliştirme; küçük cleanup değil.

### Görevler

1. **EXR Sequence desteği**
   - Sorun: Spec'te "EXR sequence" desteği yazılı, [src-tauri/Cargo.toml](../../src-tauri/Cargo.toml) içinde `exr` veya `image` crate'i yok; UI dosya filtresinde ([src/js/source.js:25-27](../../src/js/source.js#L25)) `.exr` ekli değil.
   - Yapılacak (büyük iş — kendi içinde alt fazlara bölünebilir):
     - E1.1: `exr = "1.x"` crate'i ekle, Rust tarafında `decode_exr_frame(path) -> RgbaF32 + channels[]` Tauri command'ı.
     - E1.2: UI dosya filtresine `exr`; sequence detector'a EXR numerik pattern (`name.0001.exr`) ekle.
     - E1.3: Inspector'da kanal/pass seçici (multi-layer EXR'da R/G/B yanında diffuse/specular/depth pass'leri).
     - E1.4: HDR → display tonemap için scene-grade veya dedicated tonemap node'u (preview için).
   - Başarı kriteri: 16-bit half-float EXR sequence açılıyor, kanal seçilebiliyor, preview/export aynı kareyi üretiyor.
   - **Not:** Bu faz docs/spec/product.md'yi de güncellemeli; eğer EXR scope dışına çıkarılırsa CLAUDE.md de güncellenmeli.

2. **Ses (audio) desteği**
   - Sorun: Spec "AAC", "Opus", "orijinal sesi koruma" der; ne FFmpeg komutunda ne export sheet UI'da var. Tüm export'lar silent.
   - Yapılacak:
     - E2.1: FFmpeg encode komutuna `-i <source>` ekleyip `-c:a copy` (passthrough), düşüş yolu `-c:a aac -b:a 192k`.
     - E2.2: Export sheet UI'da "Audio: Original / AAC / Opus / None" radio.
     - E2.3: Trim noktaları varsa `-ss`/`-to` ses kanalına da uygulansın.
     - E2.4: Image sequence kaynağında "Add audio from file" opsiyonu (sonraki sürüm).
   - Başarı kriteri: Sesli MP4 export edilince çıkışta orijinal ses ya da seçili codec aynı offset'le mevcut; trim kırpmasında ses ile kare birebir hizalı.

3. **Image sequence iptal temizliği**
   - Sorun: PNG/JPG sequence export'u iptal edildiğinde o ana kadar yazılmış yarım kareler hedef klasörde kalıyor; tekrar export'ta isim çakışması/karışıklık riski.
   - Yapılacak: Sequence export başlamadan önce **çıkış dizini boş mu** kontrolü + opsiyonel "Cancelled: cleanup written N files?" diyaloğu. Cancel handler'ı bu session'da yazılan dosya path'lerini bir Set'te tutup iptal sonrası silsin (kullanıcı onayıyla).
   - Dosyalar: [src/js/export.js](../../src/js/export.js) — `submitSequenceExport` ve abort path'i.
   - Başarı kriteri: 200 karelik sequence'i 100. karede iptal et → onay diyaloğu → klasörde dosya kalmıyor (ya da kullanıcı "keep" derse hepsi kalıyor, partial state user-visible).

---

## Faz F — Mimari Bölme ve İnce Ayar (Eski Audit P2)

**Amaç:** Modül boyutu bombalarını parçalamak, render stratejilerini hafifletmek. Saldırgan refactor — küçük PR'lar halinde.

### Görevler

1. **`graph-shell.js` (7202 satır) bölünmesi**
   - Hedef parçalar: `graph-viewport.js` (pan/zoom/marquee), `graph-render.js` (node/edge DOM), `graph-inspector.js`, `palette-ui.js`, `graph-keyboard.js`. Faz F1'in tek başına bir PR olması doğru.
   - Başarı kriteri: Hiçbir görsel/işlevsel regresyon yok; smoke + manuel preview testi geçiyor; her yeni dosya <1500 satır.

2. **`player.js` (2930 satır) bölünmesi**
   - Hedef: `player-transport.js`, `player-timeline-render.js`, `player-keyframe-drag.js`, `player-bezier-popover.js`. Drag state'leri tek bir "active drag controller" altında topla (interleaving leak'i kapatır).

3. **`image-ops.js` (2602 satır) bölünmesi**
   - Hedef: `image-ops/color.js`, `image-ops/geometry.js`, `image-ops/mix.js`, `image-ops/dither.js`, `image-ops/buffer-pool.js`. Ortak `mapImageData(input, perPixelFn)` helper'ı çıkar.

4. **`innerHTML = ...` → `replaceChildren` migrasyonu**
   - Player timeline ve graph-shell'in tam rebuild'leri innerHTML kullanıyor — focus/scroll mid-drag kayıp. Per-element diff veya pre-built `DocumentFragment` ile değiştir.
   - **Önce ölç:** Hangi subscribe'ler en sık tetikleniyor? `8c2439a` inspector drag'leri için zaten skip ediyor; sıradaki adaylar timeline scrub ve node drag.

5. **Deep-clone graph mutation azaltma**
   - `graph.js`'de her mutation `graph.nodes.map(node => clone(node))` yapıyor. Sadece değişen node için clone, diğerleri için `[...graph.nodes]` (referans paylaşımı). Drag sırasındaki GC pressure'ı düşürür.

6. **`tauri-compat.js` extract**
   - `selected.path` normalizasyonu, `tauri.fs.rename ?? renameFile`, `tauri.core.invoke ?? tauri.invoke` paternleri 4-5 dosyaya dağılmış. Tek bir compat modülü → Tauri 2.x → 3.x geçişinde tek dosya değişir.

7. **Tauri capabilities least-privilege**
   - Eski audit P1 #10. Şu an `shell:default`, `fs:default`, `dialog:default`. Switch to: `shell:allow-execute` (sadece ffmpeg yolu için), `fs:allow-read-file` + `fs:allow-write-file` (sadece user-picked dizinler için runtime grant), `dialog:allow-open`/`allow-save`.

---

## Faz G — A11y, Hijyen ve Geleceğe Hazırlık

**Amaç:** Erişilebilirlik ve repo hijyen borçlarını kapatmak. Düşük öncelik ama biriktikçe lokal-first ürün kalitesini düşürür.

### Görevler

1. **A11y — gizmo / playhead / bezier keyboard alternatifleri**
   - Şu anda hepsi pointer-only. F23 scrubbable-number patern'ini bunlara da uygula: focus + ok tuşlarıyla nudge, Shift+ok 10x, Alt+ok 0.1x. `role` ve `aria-label` her handle'a.

2. **`webglcontextlost` / `webglcontextrestored` listener**
   - GPU sürücü swap'ında renderer ölü kalıyor. Listener ekle, context restore'da pipeline'ı yeniden kur.
   - Dosyalar: [src/js/gpu-effects.js](../../src/js/gpu-effects.js).

3. **ResizeObserver ve global keyboard listener teardown**
   - `graph-shell.js`, `viewer-gizmos.js`, `stage.js` global listener'larını init'te ekliyor, hiç sökmüyor. Multi-window veya hot reload başlarsa accumulate. Bir dispose registry kur (init → cleanup fn döndür).

4. **`pseudoBlueNoise` adlandırma honesty**
   - Aslında golden-ratio low-discrepancy sequence; UI "Blue Noise" diyor. Ya UI'da rename ("Golden Ratio") ya da küçük bir precomputed blue-noise tile (PNG, ~256x256) ship et ve gerçek blue noise olarak kullan.
   - Dosyalar: [src/js/dither/noise.js](../../src/js/dither/noise.js), UI dither algorithm registry.

5. **Tauri IPC piksel transferi darboğazı — native render kapsam daralt**
   - Antigravity raporu: 1080p kare için her yönde ~8.3 MB ham piksel; `willReadFrequently: true` GPU avantajını öldürüyor. Texture share Tauri'de pratik değil.
   - **Önerilen pratik çözüm:** Native render'ı sadece **headless export pipeline'da** kullan (preview için JS+WebGL kalsın). Bu Faz A #4'le örtüşür: dither node varsa zaten native devre dışı; mantığı genişletip preview yolunu tamamen JS'e bırakmak değerli mi tartışılsın.
   - Başarı kriteri: Preview FPS ölçümü native disabled vs enabled benzer; native sadece export sırasında headless çalışıyor.

6. **Deferred Rust groundwork temizliği**
   - [animation.rs](../../src-tauri/src/engine/animation.rs), [node.rs](../../src-tauri/src/engine/node.rs), [tracker.rs](../../src-tauri/src/engine/tracker.rs), [lens_flare.rs](../../src-tauri/src/engine/lens_flare.rs) — ~350 satır dead code. Ya `#[cfg(feature = "v2-native-engine")]` arkasına al, ya top-of-file `#![allow(dead_code)]` + `// TODO(v2-node-graph): wired in Phase ...` marker.

7. **`engines.node`, lint/format, smoke script**
   - `package.json` — `"engines": { "node": ">=18" }`, `"lint": "prettier --check src/**/*.{js,css,html}"`, `"smoke": "..."` (mevcut `smoke/algorithms.html` runner'ını wrap'le).
   - `repository`, `license`, `author` alanları.

---

## Önerilen Uygulama Sırası

1. **Faz A** (1-2 hafta) — Export parity kritik, kullanıcıyı doğrudan yanıltıyor.
2. **Faz B** (3-5 gün) — UI bug'ları görünür, küçük PR'lar, kolay kazanım.
3. **Faz C** (1-2 hafta) — Rust stability; uzun export'larda invisible failures.
4. **Faz D** (1 hafta) — Faz A #2'nin altyapısı; luma drift bağımsız bir PR.
5. **Faz E** (her görev kendi başına proje) — EXR ve audio ürün vaadi; iptal cleanup hızlı.
6. **Faz F** (refactor, sürekli) — Diğer fazlarda touch edilen dosyalar split fırsatı verir; ayrı PR'lar.
7. **Faz G** — Düşük öncelik, fırsat buldukça.

## Faz Dışı Yan Notlar

- Bu doküman bir audit raporu değildir; uygulama planıdır. Her görev tamamlandığında ya bu dosyayı kısalt (görev sil), ya da memory'deki `project_phase_progress` kaydını güncelle.
- Antigravity raporunun "Suggestions" bölümü (4. madde) bu plana doğrudan aktarıldı; rapor artık arşiv olarak `docs/antigravityauditreport.md`'de duruyor — yeni audit talep edildiğinde referans.
- Smoke harness ([smoke/algorithms.html](../../smoke/algorithms.html)) her Faz A görevinin yeşil kalması için "regression guard" rolünde — dither/palette etkilenen her görevde rerun zorunlu.
