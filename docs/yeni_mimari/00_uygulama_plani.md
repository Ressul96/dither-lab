# `docs/yeni_mimari/` Uygulama Planı

> **Yöntem:** Her küçük faz (F1.1, F1.2, F2.1, …) tek atomik PR olarak iniyor.
> Bitirilen iş bu dosyada işaretleniyor ve aynı commit ile birlikte
> güncelleniyor — her zaman gerçek durumu yansıtsın.

Durum sembolleri:

* ⬜ Beklemede
* 🚧 Devam ediyor
* ✅ Tamamlandı (commit hash referanslı)

Plan dayanağı: bu klasördeki diğer `*_entegrasyon.md` ve `*_gelisme.md`
belgeleri. Tarihsel raporlar (`dither_lab_*.md`, `basement_ekstralar.md`,
`dither_lab_analysis.md`) action item kaynağı değildir; aksiyonlar her node /
sistem için kendi md'sinde.

---

## Genel Görünüm

| Faz | Başlık | Süre | Durum |
|---|---|---|---|
| F1 | Altyapı temel taşları | 1-2 hafta | ✅ |
| F2 | Mevcut node iyileştirmeleri | 1 hafta | ✅ |
| F3 | Yeni Color / Source node'ları | 1-2 hafta | 🚧 |
| F4 | Yeni Effect node'ları | 1-2 hafta | ⬜ |
| F5 | Curve editor + displace genişlemesi | 1 hafta | ⬜ |
| F6 | Editor scaling: Group nodes | 1-2 hafta | ⬜ |
| F7 | On-canvas Gizmos | 1 hafta | ⬜ |
| F8 | Web Worker / OffscreenCanvas | 2-4 hafta | ⬜ |

Player reformu (Faz 1-5) ayrı bir iş kalemidir, tamamlandı (`f754dcd`'ye
kadar Claude + `52c4269` / `0c77b8e` / `77e7e73` Codex).

---

## F1 — Altyapı temel taşları

| PR | Kapsam | Durum |
|---|---|---|
| F1.1 | **Color picker primitive** + halation pilot | ✅ `eccc750` |
| F1.2 | **Gradient LUT helper** (256×1 canvas → GL texture, paylaşılan) | ✅ `d1eda4f` |
| F1.3 | **UI components refactor** (`ui_components_entegrasyon.md` §8) | ✅ |
| F1.3.1 | aria-pressed sync (loop / autokey / quality) | ✅ `c32c458` |
| F1.3.2 | Panel toggle Micro Notch polish | ✅ `e01d2da` |

**F1.1 detay:**
* `src/js/color.js`: `normalizeHex`, `rgbToHex`, `hexToRgb01`
* `controls.css` `.color-field`
* `graph-shell.js` `renderColorField` + `readControlValue` color-aware +
  mid-typing skip
* `graph.js` halation `tintColor` + `normalizeNodeParams` legacy
  `tintR/G/B → tintColor` migration
* `gpu-effects.js` halation uniforms HEX parse

**F1.2 detay:**
* `src/js/gl/gradient-lut.js`: `buildGradientLut(stops, options)`,
  `uploadGradientLutTexture(gl, lut, existing?)`, `getGradientLutKey`
* Stop modeli: `[{ pos: 0..1, color: "#hex" }, …]`. Otomatik sort,
  endpoint extension, empty fallback (white).
* Default width 256, RGBA8. Wrap-S = REPEAT (shader shift için), wrap-T
  = CLAMP. Linear filter.
* Canvas = `OffscreenCanvas` veya `HTMLCanvasElement`; inspector swatch
  için doğrudan kullanılabilir.
* Tarayıcıda 7 senaryo doğrulandı (linear, three-stop, empty,
  out-of-order, partial range, key stability, custom width).

**F1.3.1 detay:**
* `player.js` loop + autokey pill'lerinde `aria-pressed` set ediliyor
  (mevcut `classList.toggle("is-active")` ile yan yana).
* `stage.js` `syncQualityToggle`'da `aria-pressed` (full = true).
* `index.html` başlangıç `aria-pressed` değerleri (loop=true,
  autokey=false, quality=false).
* compare-mode, timeline-view, scopes-toggle zaten doğruydu.
* Inline `onclick` yok — §9 kuralı zaten sağlanıyor.

**F1.3.2 detay:**
* `.panel-toggle` ve `.workspace-edge-toggle` için 150ms koordineli
  transition (border-color, color, background, box-shadow).
* `:focus-visible`: accent border + 2px accent ring (klavye
  navigasyonu için belirgin affordance).
* `::before` iç çizgi: rest %12 white → hover %32 white → focus accent
  + 28px height. Hit area değişmedi (20×64px).
* Salt CSS; DOM/JS/hit area değişmedi.

---

## F2 — Mevcut node iyileştirmeleri (quick wins)

| PR | Kapsam | Md | Durum |
|---|---|---|---|
| F2.1 | Dither algorithm grouping; "Cell Scale" label | `dither_entegrasyon.md` | ✅ `d16cdad` |
| F2.2 | Pixelate `gridOpacity` (md §3 P2; hex/staggered P3'e parked) | `pixelation_entegrasyon.md` | ✅ `0b0a9ad` |
| F2.3 | ASCII signal shaping (md §2 P1; atlas binarization P2'ye parked) | `ascii_entegrasyon.md` | ✅ `f5dd2b0` |
| F2.4 | VHS/Analog tape realism (md §4 P2: tapeResolution, jitter, flicker, dropouts, crease) | `vhs_crt_entegrasyon.md` | ✅ `131db4e` |

---

## F3 — Yeni Color / Source node'ları

| PR | Node | Bağımlılık | Durum |
|---|---|---|---|
| F3.1 | `levels` (CPU; GPU pass parked at md P4) | F1.1 (range fields) | ✅ `0df89c6` |
| F3.2 | `duotone` (CPU) | F1.1 (color picker) | ✅ `d4bb173` |
| F3.3 | `gradient-map` | F1.1 + F1.2 | ✅ `3db745c` |
| F3.4 | `mesh-gradient` (procedural source) | F1.1 + F1.2 + runtime case | ✅ `cf6f61f` |

---

## F4 — Yeni Effect node'ları

| PR | Node | Notlar | Durum |
|---|---|---|---|
| F4.1 | `led-screen` | GPU shader, RGB sub-pixel | ⬜ |
| F4.2 | `modulation` | GPU phase modulation | ⬜ |
| F4.3 | `pixel-sorting` | GPU heuristic single-pass | ⬜ |
| F4.4 | `star-glow` | F1.2 gerekir | ⬜ |
| F4.5 | `depth-of-field` | P1 focus mask + circular blur | ⬜ |

---

## F5 — Curve editor + `displace` genişlemesi

| PR | Kapsam | Md | Durum |
|---|---|---|---|
| F5.1 | 2D Curve editor inspector kontrolü (paylaşılan primitive) | yeni | ⬜ |
| F5.2 | `rgb-curves` 4-eğri (master+RGB), applyMode, 256×1 LUT | `curves_entegrasyon.md` | ⬜ |
| F5.3 | `displace` map modu için `mapCurve` + `fitType` + `textureScale` + `direction` | `displacement_entegrasyon.md` | ⬜ |

---

## F6 — Editor scaling: Group nodes

| PR | Kapsam | Md | Durum |
|---|---|---|---|
| F6.1 | `parentId` + `state.graphView.currentParentId` + breadcrumb | `node_gelisme.md` | ⬜ |
| F6.2 | Group / Ungroup eylemleri, dış-iç bağlantı analizi | `node_gelisme.md` | ⬜ |
| F6.3 | Runtime flattening (`graph-runtime.js`) | `node_gelisme.md` | ⬜ |

---

## F7 — On-canvas Gizmos

| PR | Kapsam | Md | Durum |
|---|---|---|---|
| F7.1 | `viewer-overlay.js` SVG layer + screen ↔ stage koordinat dönüşümü | `gizmo_gelisme.md` | ⬜ |
| F7.2 | Point gizmo (chromatic-aberration, lens-distort) | `gizmo_gelisme.md` | ⬜ |
| F7.3 | Ring / angle / box gizmo'lar (bloom, halftone, depth-of-field, crop) | `gizmo_gelisme.md` | ⬜ |

---

## F8 — Web Worker / OffscreenCanvas

İzole; diğer fazlardan bağımsız ilerletilebilir. `mimari_gelisme.md` Faz 0-5
sırasıyla.

| PR | Kapsam | Durum |
|---|---|---|
| F8.0 | Ölçüm + feature flag (`workerRender: off / auto / on`) | ⬜ |
| F8.1 | Canvas factory | ⬜ |
| F8.2 | `image-ops.js` pool taşıma | ⬜ |
| F8.3 | `gpu-effects.js` Worker uyumu (ASCII atlas dahil) | ⬜ |
| F8.4 | Worker adapter (preview only, request token, stale discard) | ⬜ |
| F8.5 | Export ayrımı | ⬜ |

---

## Kritik Yol

```
F1 ─┬──> F2  (paralel, mevcut node'lar)
    ├──> F3  (F1.1 + F1.2 sonrası)
    ├──> F5  (F5.1 paylaşılan curve editor)
    └──> F4  (F4.4 star-glow için F1.2)

F6, F7, F8  ──> bağımsız, herhangi bir zamanda paralel
```

**Toplam tahmin:** ~10-14 hafta tek geliştirici (paralel ilerletilirse
yarı yarıya iner).
