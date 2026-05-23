# Dither Lab — Sonraki Aşamalar Planı

**Tarih:** 2026-05-23 (M.1 + M.2 + M.4 phase 1+2+3+4 + player bonus + V.1 sonrası güncellendi)
**Önceki plan:** [audit.md](audit.md)
**Tip:** Faz A-G boyunca ertelenen + kararla bekletilen görevlerin güncel listesi. Uygulama sırası, durum ve somut iş tahminleri ile.

> Bu doküman audit.md'nin yerine geçmez; **kalan iş** dosyasıdır. Önceki audit.md'nin "Çözülenler" tablosu Faz A-G uygulamasından sonra büyüdü; gerektiğinde manuel olarak güncellenmeli.

---

## Bağlam

Faz A-G 7 görev paketi, **toplam 47 madde** içeriyordu. Uygulamadan sonra dağılım:

- **18 madde kapatıldı** (bu oturumun kod değişiklikleri).
- **14 madde zaten önceki commit'lerde halledilmişti** (audit yazıldığı tarihten sonra).
- **4 madde yanlış teşhis çıktı** veya kapsam zaten yeterliydi (B.1 panel resize, C cycle/Drop/stderr, F.7 capabilities).
- **11 madde açık kaldı veya kararla ertelendi** — bu doküman onları topluyor.

**2026-05-21 güncellemesi:** M.5, A.2 ve M.3 önceki oturumlarda tamamlandı; A.1 Codex çalışma ağacında tamamlandı ve doğrulandı.

**2026-05-23 güncellemesi:** Claude + Codex paralel iki-agent oturumunda **M.1, M.2, M.4 (phase 1+2+3+4 + player bonus), V.1, Faz D #2 ve Faz A kapanışı** işlendi:

- **M.1** graph-shell.js 7207 → 526 satır, 22 atomik commit, 13+ yeni UI modülü (graph-render, graph-color-picker, graph-curve-editor, graph-gradient-ramp, graph-inspector-*, graph-palette-actions, graph-inspector-events, …).
- **M.2** player.js 2930 → 1111 satır, 14 yeni player-* modülü (Codex).
- **M.4 phase 1+2+3+4 + player bonus** tamamlandı: 13 non-player `innerHTML` site `setInnerHtml` helper'a geçti (`812dc68`), graph-render per-node diff + inspector skip-when-unchanged geldi (`b1e4767`, `33b89b0`), edge render per-edge diff'e geçti (`1c4db76`), player tier `innerHTML` siteleri helper/`replaceChildren` pattern'ine taşındı (`a74b5c4`), hot path ölçümleri DevTools User Timing için eklendi (`6f10b3c`).
- **V.1** GPU + CPU her ikisi de BT.709'a hizalandı (commit `b465652`, `ea81f17`). YIQ hue rotation matrisi kapalı sistem olarak BT.601 bırakıldı.
- **Faz D #2** sync canvas reader'ların fire-and-forget render side effect'i kaldırıldı (`624f45a`).
- **Faz A** komple kapanış audit'e işlendi (`a6abe0d`).
- **Pre-existing dead import cleanup** import satırlarıyla sınırlı iki commit ile kapandı (`a8aa1b2`, `2771642`).

**Kalan açık işler:** S.1 EXR scope kararı + F22 group in/out node action.

**Toplam kalan iş:** ~1-2 gün + EXR scope kararına göre +1 hafta.

---

## Hızlı Görünüm — Açık İşler

| Kod | Görev | Tema | Tahmini iş | Öncelik | Bağımlılık |
|-----|-------|------|------------|---------|------------|
| **S.1** | EXR Sequence (4 alt faz) | Spec promise | ~1 hafta | Yüksek (scope) | — |
| **F22** | Group in/out node action | UI polish | 0.5-1 gün | Düşük | — |

## Hızlı Görünüm — Tamamlananlar

| Kod | Görev | Durum |
|-----|-------|-------|
| **M.1** | `graph-shell.js` bölme | Tamamlandı 2026-05-23 — son commit `6aa5552` (7207 → 526) |
| **M.2** | `player.js` bölme | Tamamlandı 2026-05-23 — Codex, son commit `1c3c3a5` (2930 → 1111) |
| **M.3** | `image-ops.js` bölme (2602) | Tamamlandı — son commit `e470021` |
| **M.4** | `innerHTML` → `replaceChildren` + hot render diff/measurement | Tamamlandı 2026-05-23 — phase 1+2+3+4 + player bonus (`812dc68`, `b1e4767`, `33b89b0`, `1c4db76`, `a74b5c4`, `6f10b3c`) |
| **M.4 phase 3** | Per-edge graph render diff | Tamamlandı 2026-05-23 — Codex `1c4db76` |
| **M.4 phase 4** | Perf instrumentation (`performance.mark` / User Timing) | Tamamlandı 2026-05-23 — Codex `6f10b3c` |
| **M.4 player bonus** | Player tier `innerHTML` migration | Tamamlandı 2026-05-23 — `a74b5c4` |
| **M.5** | Deep-clone azaltma (`graph.js`) | Tamamlandı — önceki oturumlar |
| **Faz A** | Export parity fazı komple closure | Tamamlandı 2026-05-23 — `a6abe0d` |
| **Faz D #2** | Sync canvas reader fire-and-forget render kaldırma | Tamamlandı 2026-05-23 — `624f45a` |
| **A.1** | Gizmo/playhead/bezier a11y | Tamamlandı — 2026-05-21 Codex çalışma ağacı |
| **A.2** | Dispose registry | Tamamlandı — önceki oturumlar |
| **V.1** | GPU + CPU BT.709 hizalama | Tamamlandı 2026-05-23 — `b465652` (GPU) + `ea81f17` (CPU) |
| **F22 (kısmi)** | Splash + timeline minimise + default pan + slider redesign | Tamamlandı 2026-05-23 — Codex `2a09cf9`, `a5b242d`, `6018fc5`, `bc14451`, `e43a75e` |
| **Import cleanup** | Pre-existing dead import cleanup | Tamamlandı 2026-05-23 — `a8aa1b2`, `2771642` |

---

## Tema 1: Mimari Borç (M)

Bu tema CLAUDE.md "Simplicity First" + audit.md P2 #12-14 maddeleriyle örtüşür: büyük modüllerin parçalanması, render stratejisinin diff-based hale gelmesi, gereksiz deep-clone'ların temizlenmesi.

### M.1 — `graph-shell.js` bölme (7202 satır)

**Durum:** Tamamlandı 2026-05-23 — 22 atomik commit, son commit `6aa5552`. graph-shell.js 7207 → 526 satır (orchestrator + commitNodeColorParam / commitMeshStopColorTarget color picker callback target'leri kaldı). 13+ yeni UI modülü: graph-render, palette-swatch-locks, graph-inspector-fields, graph-color-math, graph-color-picker, graph-gradient-ramp, graph-curve-editor, graph-xy-pad, graph-inspector-{core,dither,gradient,geometry,source,color-grading,effects,stylize,misc,utils,mix}, graph-palette-actions, graph-inspector-events.

**Amaç:** Tek dosyaya sıkışmış 150+ fonksiyonu (graph viewport + node/edge render + inspector + palette UI + keyboard) sürdürülebilir parçalara ayırmak.

**Hedef bölümler:**
1. `graph-viewport.js` — pan/zoom/marquee/cut state + pointer handlers
2. `graph-render.js` — node/edge DOM oluşturma + diff render
3. `graph-inspector.js` — her node tipinin inspector field render'ı
4. `palette-ui.js` — node palette drag-drop
5. `graph-keyboard.js` — shortcuts (Cmd+G group, Cmd+D duplicate, vs.)
6. `graph-shell.js` — ince orchestrator (init, dispose, public API)

**Dokunulacak dosyalar:**
- [src/js/ui/graph-shell.js](../../src/js/ui/graph-shell.js) (split)
- [src/index.html](../../src/index.html) (gerekirse import map)
- Tüm caller'lar (`graph-shell`'in export'ları)

**Başarı kriteri:**
- Hiçbir görsel/işlevsel regresyon
- Her yeni dosya <1500 satır
- Smoke harness + manuel preview pass
- `node --check` her dosyada OK

**Tahmini iş:** 1-2 hafta
**Öncelik:** Yüksek (en büyük tek modül; modülerleşmenin en yüksek getirisi)
**Notlar:** M.4 (replaceChildren) ile birlikte yapılması mantıklı — split sırasında DOM render stratejisi de düzelir.

### M.2 — `player.js` bölme (2930 satır)

**Durum:** Tamamlandı 2026-05-23 — Codex, 14+ atomik commit, son commit `1c3c3a5`. player.js 2930 → 1111 satır. Yeni player-* modülleri: player-elements, player-compare, player-selection, player-more-menu, player-timeline-targets, player-format, player-graph-editor, player-easing, player-bezier-popover, player-keyframe-actions, player-timeline-items, player-marquee, player-playhead, player-timeline-chrome, player-track-base.

**Amaç:** Timeline player'ın 40+ render helper'ı ve 6 ayrı drag state singleton'ını ayrı modüllere taşımak.

**Hedef bölümler:**
1. `player-transport.js` — play/pause/seek/trim/loop kontrolları
2. `player-timeline-render.js` — ruler + lane DOM
3. `player-keyframe-drag.js` — keyframe pick/drag/marquee + tek "active drag controller"
4. `player-bezier-popover.js` — tangent SVG + bezier handle drag

**Dokunulacak dosyalar:**
- [src/js/ui/player.js](../../src/js/ui/player.js) (split)
- Caller'lar (sadece `player.js`'in export'ları)

**Başarı kriteri:**
- Drag interleaving bug'ları kapanmış (mevcut 6 ayrı drag state'in pointercancel cleanup'ları paylaşılan controller'a taşınınca)
- `formatSeconds` / `formatTime` çoğaltması temizlenmiş
- Her yeni dosya <1000 satır

**Tahmini iş:** 1 hafta
**Öncelik:** Orta
**Bağımlılık:** —
**Notlar:** M.4 ile birlikte. Drag state'in tek controller'a alınması (audit.md P2 #12 ekseninde) en yüksek katkı.

### M.3 — `image-ops.js` bölme (2602 satır)

**Durum:** Tamamlandı — son commit `e470021`.

**Amaç:** Tüm CPU node operasyonlarını (color, geometry, mix, dither, blur, buffer-pool) kategori bazlı modüllere ayırmak.

**Hedef bölümler:**
1. `image-ops/color.js` — adjust, HSV, curves, levels, duotone, gradient-map, scene-grade
2. `image-ops/geometry.js` — pixelate, scale, transform, crop, flip, lens-distort, displace
3. `image-ops/mix.js` — mix, mask-combine, mask-apply
4. `image-ops/dither.js` — applyDitherNode + applyPatternDitherNode + applyThresholdNode
5. `image-ops/buffer-pool.js` — canvas acquire/release
6. `image-ops/index.js` — barrel re-export (mevcut callsite'ları kırmamak için)

**Dokunulacak dosyalar:**
- [src/js/image-ops.js](../../src/js/image-ops.js) (split)
- Caller import yolları (`./image-ops.js` → `./image-ops/index.js`)

**Başarı kriteri:**
- Ortak `mapImageData(input, perPixelFn)` helper extract edildi
- ~600 satır kod tekrarı kaldırıldı (audit.md "Utilities" cross-cutting)
- Her yeni dosya <700 satır

**Tahmini iş:** 3-5 gün
**Öncelik:** Düşük (kategori bölmesi zaten yarı yarıya net; refactor risk az)
**Bağımlılık:** —
**Notlar:** En kolay split — fonksiyonlar zaten birbirinden büyük ölçüde bağımsız.

### M.4 — `innerHTML` → `replaceChildren` migrasyonu

**Durum:** Tamamlandı 2026-05-23 — phase 1+2+3+4 + player bonus tamamlandı.

- **Phase 1 (commit `812dc68`):** 13 non-player site `setInnerHtml` helper'a geçti. Helper `Range.createContextualFragment` ile parent-namespace-aware — SVG container'lar (graph-render edges, curve handle layer) için `<template>.innerHTML`'ın bozacağı namespace doğru oturdu.
- **Phase 2a (commit `b1e4767`):** `renderGraph` aynı-parent path'inde per-node diff — `lastRenderedNodeHtml` cache ile değişmemiş card'lar DOM kimliklerini korur, sadece değişen card replace edilir. Parent değişiminde full rebuild fast-path.
- **Phase 2b (commit `33b89b0`):** `renderInspector` skip-when-unchanged — selection değişmediği sürece HTML string compare ile dispatch'ler erken döner, mid-drag focus / picker open state korunur.
- **Phase 3 (commit `1c4db76`):** `renderEdges` per-edge diff'e geçti; parent değişiminde full rebuild, aynı parent dispatch'lerinde değişmeyen SVG path DOM kimliği korunur.
- **Player bonus (commit `a74b5c4`):** player tier'daki 10 `innerHTML` site `setInnerHtml` / `replaceChildren` pattern'ine taşındı.
- **Phase 4 (commit `6f10b3c`):** `renderGraph`, `renderEdges`, `renderInspector` `performance.mark()` + `performance.measure()` ile ölçümleniyor. DevTools Performance kaydı açıldığında süreler **User Timing** track altında `renderGraph`, `renderEdges`, `renderInspector` olarak okunur.

**Amaç:** `player.js` + `graph-shell.js` tam-rebuild render'larını DocumentFragment + replaceChildren ile değiştirmek. Mid-drag focus/scroll kaybını kapatır.

**Kapanış notları:**
1. Ölçüm yolu artık kodda: DevTools Performance tab → kayıt al → User Timing track altında `renderGraph`, `renderEdges`, `renderInspector`.
2. Per-node + per-edge diff, drag dışındaki dispatch'lerde DOM kimliğini korur; parent değişiminde full rebuild fast-path kalır.
3. Yeni takip işi ancak Performance kaydı yeni bir hot path gösterirse açılmalı.

**Dokunulacak dosyalar:**
- [src/js/ui/player.js](../../src/js/ui/player.js)
- [src/js/ui/graph-shell.js](../../src/js/ui/graph-shell.js)
- (M.1 ile birlikte yapılırsa: `graph-render.js`)

**Başarı kriteri:**
- Timeline scrub sırasında render time <2ms per frame
- Node drag sırasında full graph rebuild yok
- Inline range input focus mid-drag kaybedilmiyor

**Tahmini iş:** 1 hafta + 1-2 gün performance measurement
**Öncelik:** Orta
**Bağımlılık:** M.1 + M.2 (split aralarında en mantıklı)

### M.5 — Deep-clone azaltma (`graph.js`)

**Durum:** Tamamlandı — önceki oturumlar.

**Amaç:** 12+ noktada `graph.nodes.map((node) => clone(node))` pattern'i — sadece bir node mutate edilen yerlerde `[...graph.nodes]` ile değiştir. GC pressure'ı düşürür.

**Yapılacaklar:**
1. Her callsite'da mutation pattern'i analiz et:
   - Sadece bir node mutate ediyorsa → `[...graph.nodes].map(n => n.id === target ? {...n, ...changes} : n)`
   - Birden fazla node mutate ediyorsa → mevcut deep-clone kalsın
2. `getLinearChain` (graph.js:2713) ve `getMainChain` (graph.js:2749) caller'ları kontrol et — döndürdükleri array'i mutate ediyorlar mı? Eğer evet, clone gerekli.
3. Test: drag sırasında GC pause'ları azalmalı.

**Dokunulacak dosyalar:**
- [src/js/graph.js](../../src/js/graph.js)
- Caller'lar (test için)

**Başarı kriteri:**
- 100 node'luk graph'ta node drag sırasında allocation/frame %50 azalma
- Smoke harness + manuel test regresyon yok

**Tahmini iş:** 2-3 gün (analiz + dikkatli refactor + test)
**Öncelik:** Düşük (GC bir noktada darboğaz olunca ölçeklenir)
**Bağımlılık:** —
**Notlar:** Plan'da "tek satır" gibi görünüyordu ama her callsite'ın davranışı doğrulanmadan değiştirilmemeli. `getLinearChain`/`getMainChain` döndürdükleri array caller tarafından mutate ediliyorsa, clone kalkarsa `graph.nodes`'a sızıntı oluşur.

---

## Tema 2: Yeni Özellikler (S)

### S.1 — EXR Sequence Desteği

**Genel Bakış:** Spec promise ([product.md](../spec/product.md), [CLAUDE.md](../../CLAUDE.md))
karşılığı. Currently kodda hiç yok — `Cargo.toml`'da `exr` crate yok, dosya filtresinde `.exr` yok, multi-channel pass UI'ı yok. ~1 hafta toplam iş, 4 alt-faza bölündü.

**Karar noktası:** EXR scope içinde mi yoksa dışında mı? Eğer dışındaysa S.1 atla ve [product.md](../spec/product.md) ile [CLAUDE.md](../../CLAUDE.md)'den EXR satırlarını çıkar.

#### S.1.1 — Rust EXR Decoder + Tauri Command (2-3 gün)

**Yapılacaklar:**
1. `Cargo.toml`'a `exr = "1.x"` ekle.
2. `src-tauri/src/engine/exr.rs` modülü:
   - `decode_exr_frame(path: &str, channels: Option<Vec<String>>) -> Result<NativeExrFrame, EngineError>`
   - `NativeExrFrame { width, height, channels: HashMap<String, Vec<f32>> }`
3. Tauri command `decode_exr_frame` register et.
4. `FrameBuffer` half-float / f32 varyantı (`FrameBufferF32`) veya tonemap-before-return.
5. Smoke test: küçük bir EXR fixture dosyası ile basic decode.

**Başarı kriteri:** 16-bit half-float EXR sequence açılıyor, kanallar listeleniyor.

#### S.1.2 — UI Dosya Filtresi + Sequence Detector (1 gün)

**Yapılacaklar:**
1. [source.js:25-27](../../src/js/source.js#L25) dosya filtresine `exr` ekle.
2. Sequence detector pattern: `name.0001.exr` → numerik artırma tespiti.
3. EXR sequence opening — sequence içindeki ilk frame decode, dimensions cache.

**Başarı kriteri:** EXR sequence dosya picker'dan açılıyor, ilk frame preview'da görünüyor (basic, kanal seçimi olmadan).

#### S.1.3 — Inspector Multi-Layer Kanal/Pass Seçici (2-3 gün)

**Yapılacaklar:**
1. Multi-layer EXR detection: `diffuse.R`, `specular.G`, `depth.Z` gibi pass'ler.
2. Inspector'a "Channel/Pass" dropdown — kullanıcı R/G/B yanında pass seçebilsin.
3. Source node'a "exposedChannels" param: render time'da hangi 3 kanal R/G/B olarak ekrana çıkacak.
4. Default: R/G/B veya `diffuse.RGB` varsa o.

**Başarı kriteri:** Multi-layer EXR'da kullanıcı "depth" pass'i preview'da görebiliyor, başka pass'e geçebiliyor.

#### S.1.4 — HDR Tonemap Node (1-2 gün)

**Yapılacaklar:**
1. EXR'nin HDR float değerlerini display SDR range'e map etmek için yeni `tone-map` veya genişletilmiş `scene-grade` node.
2. Algoritma: Reinhard, ACES, veya basit `pow(x, 1/gamma)`. Reinhard en güvenli ilk versiyon.
3. EXR sequence açılınca otomatik tonemap node ekle (default'a inject) — kullanıcı `linear` görmek isterse bypass edebilir.

**Başarı kriteri:** EXR sequence ile tonemap node aktif iken preview SDR aralıkta düzgün gösteriliyor; export aynı tonemap'i uyguluyor.

---

## Tema 3: Erişilebilirlik ve Hijyen (A)

### A.1 — Gizmo/Playhead/Bezier Keyboard Alternatifleri

**Durum:** Tamamlandı — 2026-05-21 Codex çalışma ağacı.

**Doğrulama:** `node --check` hedef dosyalarda geçti; tüm `src/**/*.js` syntax check geçti; `npm run smoke` sonucu `OK — 27 algorithms × 4 palettes = 108 combos passed`; statik ana arayüz yükleme kontrolünde console error yok.

**Amaç:** F23 scrubbable-number pattern'ini diğer pointer-only kontrollere yaymak.

**Yapılacaklar:**
1. Her gizmo handle'a `tabindex="0"` + `role="slider"` (veya uygun ARIA role) + `aria-label`.
2. Focus + arrow key handler:
   - ←/→ nudge 1 unit
   - Shift+arrow 10x
   - Alt+arrow 0.1x
3. Hedefler:
   - [viewer-gizmos.js](../../src/js/ui/viewer-gizmos.js) — point, angle, ring, mesh-stops, crop-box
   - Playhead handle ([player.js](../../src/js/ui/player.js))
   - Bezier popover handles ([player.js](../../src/js/ui/player.js))

**Başarı kriteri:** Mouse olmadan tüm gizmo değerleri keyboard ile değiştirilebiliyor.

**Tahmini iş:** 2-3 gün
**Öncelik:** Orta
**Bağımlılık:** —

### A.2 — Dispose Registry (ResizeObserver/Keyboard Teardown)

**Durum:** Tamamlandı — önceki oturumlar.

**Amaç:** Multi-window / hot reload / test ortamlarında listener leak'lerini kapatmak.

**Yapılacaklar:**
1. Yeni `src/js/ui/lifecycle.js` veya benzer dispose registry:
   ```js
   export function registerDispose(fn) { disposables.push(fn); }
   export function disposeAll() { disposables.forEach(fn => fn()); }
   ```
2. Tüm `init*` fonksiyonlarını dispose callback'i döndürecek şekilde refactor et:
   - [graph-shell.js](../../src/js/ui/graph-shell.js) — ResizeObserver + global keyboard
   - [viewer-gizmos.js](../../src/js/ui/viewer-gizmos.js) — ResizeObserver + window resize
   - [stage.js](../../src/js/ui/stage.js) — global document listener'lar
3. Test path'i: `disposeAll()` çağrıldıktan sonra hiçbir listener tetiklenmemeli.

**Başarı kriteri:** Manuel test — `disposeAll()` sonrası DOM event'leri eski init'in handler'larını çağırmıyor.

**Tahmini iş:** 2-3 gün
**Öncelik:** Düşük (mevcut single-window kullanımda görünmez; multi-window/test için gerekli)
**Bağımlılık:** —

---

## Tema 4: Karar Beklenen (V)

### V.1 — GPU Shader BT.709 Yükseltme

**Durum:** Tamamlandı 2026-05-23 — iki commit (GPU `b465652`, CPU `ea81f17`).

- **GPU (`b465652`):** gpu-effects.js'in 18 luma site'si BT.709'a geçti. `LUMA_W`/`LUMA` const declaration'ları + bloom/halation chroma-isolate + CRT saturation inline `dot()` çağrıları. YIQ rotation matrisi (line 407) kasıtlı bırakıldı — NTSC Y'IQ kapalı sistem, sadece Y satırını değiştirmek round-trip'i bozar.
- **CPU (`ea81f17`):** 7 image-ops dosyasının `luminanceBt601` çağrıları `luminanceBt709`'a geçti (posterize, levels, duotone, rgb-curves, gradient-map, threshold, displace). Yorumlar + pixel-math.js header note güncellendi. `LUMA_BT601` ve `luminanceBt601` color.js'de korundu — rgb-to-bw'nin user-selectable BT.601 option'u için kullanılıyor.

**Sonuç:** Tüm preview/export luma path'leri BT.709'da hizalı; audit'in "single biggest correctness smell" tespiti kapandı. Visual change: bloom / glare / halation / VHS / CRT / halftone / ascii / led-screen + posterize-luma / levels-luma / duotone / gradient-map / threshold-luma / rgb-curves-luma+color hafifçe farklı render — yeşil hafifler, mavi yoğunlaşır.

**Eski plan (referans için):**
1. ~~[gpu-effects.js](../../src/js/gpu-effects.js)'in 18+ noktasında `vec3(0.299, 0.587, 0.114)` → `vec3(0.2126, 0.7152, 0.0722)`.~~ ✅
2. ~~CPU posterize/curves "luma mode" path'lerini de BT.709'a yükselt.~~ ✅
3. ~~Bloom/glare/halftone/scene-grade saved project'leri test et.~~ Smoke harness pending — kullanıcı manual repro.

---

## Tema 5: UI Polish (F)

### F22 — Splash Screen

**Durum:** Kısmi tamamlandı 2026-05-23 — Codex splash (`2a09cf9`, logo fix `a5b242d`), timeline minimise (`6018fc5`), default pan (`bc14451`) ve slider redesign (`e43a75e`) attı. Kalan F22 item: group in/out node action.

**Amaç:** Uygulama açılışında Tauri/WebView yüklenirken boş veya ham pencere yerine Dither Lab kimliğine uygun kompakt splash screen göstermek.

**Yapılacaklar:**
1. Splash screen davranışını Tauri 2 yapısına göre netleştir: pencere açılışı, ana UI hazır olunca kapanma, hata durumunda takılı kalmama.
2. Görsel yön: küçük marka işareti, kısa loading metni, koyu compact desktop estetiği; pazarlama hero'su değil.
3. Platform davranışı: macOS/Windows/Linux'ta pencere boyutu, merkezleme ve kapanış zamanlaması.
4. Manuel test: soğuk açılış, hızlı açılış, kaynak yüklenmemiş boş proje.

**Başarı kriteri:** Uygulama açılışında ham WebView görünmüyor; splash ana pencere hazır olduğunda güvenilir kapanıyor; mevcut app UI veya project restore akışı değişmiyor.

**Tahmini iş:** 2-3 gün
**Öncelik:** Düşük / polish
**Bağımlılık:** Görsel referans veya hızlı mockup kararı

---

## Önerilen Uygulama Sırası

2026-05-23 itibarıyla mimari borç (M.1/M.2/M.4) + parity riski (V.1) kapandı. Kalan iş listesi sade:

1. **F22 polish kalan item** — group in/out node action.
2. **S.1 scope kararı** — EXR sequence içeride mi? İçerideyse S.1.1 (Rust decoder) ile başla; dışarıdaysa product.md + CLAUDE.md güncellemesi.

---

## Faz Dışı Notlar

- **Tamamlanan görevler** [audit.md](audit.md)'nin "0. Son Commit'lerle Kapatılanlar" bölümüne taşınmalı; bu doküman küçülmeli.
- **Bu doküman da tamamlanan görevleri kaydetmeli** — her görevin sonuna "Kapatan commit: ..." satırı eklemek mantıklı.
- **EXR scope dışı kararı varsa:** S.1 atla, [product.md](../spec/product.md) "EXR sequence" referanslarını sil, [CLAUDE.md](../../CLAUDE.md) target platforms açıklamasından çıkar.
- **Smoke harness ([smoke/algorithms.html](../../smoke/algorithms.html))** dither/palette etkileyen her M görevinden sonra rerun.
- **Manuel test gerektiren maddeler** (B.1 panel resize gibi) bu listede yok — Faz B sonrası gözlem yapılmadı; eğer manuel testte gerçek bir bug görülürse ayrı bir mini-task açılır.
