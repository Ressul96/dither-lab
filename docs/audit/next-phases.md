# Dither Lab — Sonraki Aşamalar Planı

**Tarih:** 2026-05-20 (Faz A-G uygulaması sonrası)
**Önceki plan:** [audit.md](audit.md)
**Tip:** Faz A-G boyunca ertelenen + kararla bekletilen 11 görevin tek listesi. Uygulama sırası ve somut iş tahminleri ile.

> Bu doküman audit.md'nin yerine geçmez; **kalan iş** dosyasıdır. Önceki audit.md'nin "Çözülenler" tablosu Faz A-G uygulamasından sonra büyüdü; gerektiğinde manuel olarak güncellenmeli.

---

## Bağlam

Faz A-G 7 görev paketi, **toplam 47 madde** içeriyordu. Uygulamadan sonra dağılım:

- **18 madde kapatıldı** (bu oturumun kod değişiklikleri).
- **14 madde zaten önceki commit'lerde halledilmişti** (audit yazıldığı tarihten sonra).
- **4 madde yanlış teşhis çıktı** veya kapsam zaten yeterliydi (B.1 panel resize, C cycle/Drop/stderr, F.7 capabilities).
- **11 madde açık kaldı veya kararla ertelendi** — bu doküman onları topluyor.

**Toplam kalan iş:** ~3-4 hafta tam çalışma + EXR scope kararına göre +1 hafta.

---

## Hızlı Görünüm

| Kod | Görev | Tema | Tahmini iş | Öncelik | Bağımlılık |
|-----|-------|------|------------|---------|------------|
| **M.1** | `graph-shell.js` bölme (7202) | Mimari | 1-2 hafta | Yüksek | — |
| **M.2** | `player.js` bölme (2930) | Mimari | 1 hafta | Orta | — |
| **M.3** | `image-ops.js` bölme (2602) | Mimari | 3-5 gün | Düşük | — |
| **M.4** | `innerHTML` → `replaceChildren` | Mimari | 1 hafta + ölçüm | Orta | M.1/M.2 |
| **M.5** | Deep-clone azaltma (`graph.js`) | Performans | 2-3 gün | Düşük | — |
| **S.1** | EXR Sequence (4 alt faz) | Spec promise | ~1 hafta | Yüksek (scope) | — |
| **A.1** | Gizmo/playhead/bezier a11y | A11y | 2-3 gün | Orta | — |
| **A.2** | Dispose registry | Hijyen | 2-3 gün | Düşük | — |
| **V.1** | GPU shader BT.709 yükseltme | Parity | 1 saat + test | Karar | Görsel test |

---

## Tema 1: Mimari Borç (M)

Bu tema CLAUDE.md "Simplicity First" + audit.md P2 #12-14 maddeleriyle örtüşür: büyük modüllerin parçalanması, render stratejisinin diff-based hale gelmesi, gereksiz deep-clone'ların temizlenmesi.

### M.1 — `graph-shell.js` bölme (7202 satır)

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

**Amaç:** `player.js` + `graph-shell.js` tam-rebuild render'larını DocumentFragment + replaceChildren ile değiştirmek. Mid-drag focus/scroll kaybını kapatır.

**Yapılacaklar:**
1. **Önce ölç:** Hangi subscribe'ler en sık tetikleniyor? `8c2439a` inspector drag'leri için zaten skip ediyor. Sıradaki adaylar: timeline scrub, node drag, edge drag.
2. Per-element diff render veya pre-built DocumentFragment swap.
3. Mevcut `escapeHtml` interpolation pattern'i string template'ten DOM API'sine taşı.

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

**Bağlam:** Faz D'de kullanıcı "şimdilik kapat, JS tarafı tutarlı yeter" kararı verdi. Buraya bilgi için kayda alındı — gelecek bir oturumda yeniden değerlendirme için.

**Yapılacaklar (eğer karar değişirse):**
1. [gpu-effects.js](../../src/js/gpu-effects.js)'in 18+ noktasında `vec3(0.299, 0.587, 0.114)` → `vec3(0.2126, 0.7152, 0.0722)`.
2. CPU posterize/curves "luma mode" path'lerini de BT.709'a yükselt ([image-ops.js:616](../../src/js/image-ops.js#L616), [1169](../../src/js/image-ops.js#L1169), [2140](../../src/js/image-ops.js#L2140)).
3. Bloom/glare/halftone/scene-grade saved project'leri test et — görsel değişiklik kaydet.

**Tradeoff:**
- **Pro:** Modern sRGB için doğru luma. Tam parity tutarlılık.
- **Con:** Mevcut bloom threshold farklı pixel seçer; glare ve halftone bir miktar farklı render. Kullanıcı save'leri "regresyon" olarak algılayabilir.

**Başarı kriteri:** Tüm GPU + CPU luma yollarında aynı (r=0.5, g=0.5, b=0.5) input aynı luma değeri üretiyor.

**Tahmini iş:** 1 saat kod + 2-3 saat görsel test
**Öncelik:** Karar gerekli
**Bağımlılık:** Görsel regresyon test plan'ı

---

## Önerilen Uygulama Sırası

Az risk + hızlı kazanım önce, büyük refactor sonra, karar gerektirenler en sonda:

1. **M.5** — deep-clone azaltma (analiz + 2-3 gün test). Hızlı kazanım, izole.
2. **A.2** — dispose registry (paralel yapılabilir, küçük). Düşük risk.
3. **M.3** — image-ops bölme (kategori-based, en az risk modül split).
4. **S.1.1 + S.1.2** — EXR Rust decoder + UI filtresi (sequence içeride decode olmadan da test edilebilir).
5. **M.1 + M.4 (paralel)** — graph-shell bölme + replaceChildren. Split sırasında DOM stratejisini de düzelt.
6. **M.2 + M.4 (devamı)** — player.js bölme. Drag controller refactor önemli.
7. **S.1.3 + S.1.4** — EXR multi-layer + tonemap. Major UX iş.
8. **A.1** — a11y polish. Diğerleri yerleştikten sonra.
9. **V.1** — GPU BT.709 (karar verilirse). Görsel test gerektirir, en son.

---

## Faz Dışı Notlar

- **Tamamlanan görevler** [audit.md](audit.md)'nin "0. Son Commit'lerle Kapatılanlar" bölümüne taşınmalı; bu doküman küçülmeli.
- **Bu doküman da tamamlanan görevleri kaydetmeli** — her görevin sonuna "Kapatan commit: ..." satırı eklemek mantıklı.
- **EXR scope dışı kararı varsa:** S.1 atla, [product.md](../spec/product.md) "EXR sequence" referanslarını sil, [CLAUDE.md](../../CLAUDE.md) target platforms açıklamasından çıkar.
- **Smoke harness ([smoke/algorithms.html](../../smoke/algorithms.html))** dither/palette etkileyen her M görevinden sonra rerun.
- **Manuel test gerektiren maddeler** (B.1 panel resize gibi) bu listede yok — Faz B sonrası gözlem yapılmadı; eğer manuel testte gerçek bir bug görülürse ayrı bir mini-task açılır.
