# Shader Lab Port Plan (F9+ track)

> Karşılaştırma kaynağı: https://github.com/basementstudio/shader-lab
> (2026-05-12 itibarıyla shallow clone üzerinde survey.)
>
> F8 tamamlandı; bu doküman, shader-lab'den taşıyacağımız yapıtaşlarını ve
> önerilen sırayı F9–F13 olarak organize ediyor. Her fazın altındaki PR
> kalemleri atomik tutulup `00_uygulama_plani.md` tablosuna işlenecektir.

## 0. Genel Karşılaştırma

| Alan | Shader Lab | Bizim mevcut |
|---|---|---|
| Renderer | WebGPU + Three.js TSL (node shader DSL) | WebGL2 + raw GLSL string'leri |
| Render target | HalfFloat (HDR) ping-pong RT'ler | Tek-pass 2D canvas; mip yok, ping-pong yok |
| Bloom | Three.js `BloomNode` (multi-pass mip-chain) | Tek-pass golden-spiral disk (F8 sonrası adaptive) |
| Blend modes | 16 (incl. hue/sat/color/luminosity) | Yok; mix node sınırlı |
| Layer composite | "filter" / "mask"; per-layer mask config | mask-combine + mask-apply node'ları |
| Color grading | Scene-wide post: color curves (M+RGB), clamp gamma, color-map LUT | rgb-curves node tek başına; scene-wide pass yok |
| Easing | 18 preset + per-keyframe cubic-bezier (CSS) + step | Linear + kısmi easing |
| Timeline/Player UI | Tek floating overlay panel — transport + adaptive ruler + per-property track + per-keyframe inline bezier editor + marquee multi-select + keyboard nudge + clipboard | Ayrı player card + properties paneli; transport satırı zayıf; per-keyframe easing UI yok |
| Mask sources | luminance / alpha / R / G / B (+ invert, multiply/stencil) | mask node'ları image kanalına göre |
| Export | WebCodecs `VideoEncoder` + `mp4-muxer`/`webm-muxer`; preset'li quality/aspect | FFmpeg sidecar via Rust/Tauri |
| Dithering | 4 pattern (bayer-2/4/8 + noise) | 27 algoritma + tam palette sistemi + error-diffusion ✅ önde |
| Project file | Versioned JSON; Zustand store snapshot | Versioned JSON; merkezi state store |

**Stratejik karar (önceliklendirme öncesi okunmalı):** TSL/WebGPU'ya tam göç
yapmıyoruz. Tauri WebView'ında WebGPU desteği henüz tutarsız ve mevcut node
graph paradigmamız (layer stack yerine DAG) zaten farklı bir tasarım. Bu
plandaki ports renderer altyapımız WebGL2 GLSL üzerinde kalarak alınacak;
sadece konseptler, algoritmalar ve UI/UX yaklaşımı taşınıyor.

**Kapsam dışı bırakılanlar (kullanıcı kararı 2026-05-12):**
- Effect catalog ports (edge-detect, smear, ink, slice, vs.): node setimiz
  farklı — kopya gereksiz. Kalite/performans odaklı kalıyoruz.
- Audio-reactive parametre bindings.
- Custom-shader user-API'si: araştırma fazına bırakıldı.

---

## 1. F9 — Renderer altyapı (ping-pong + mip + HDR)

Bloom ring artifact'i, blur perf sorunu, glow türevleri (DoF, halation) — hepsi
aynı altyapı eksikliğine bağlı: tek-pass shader + LDR canvas. Bu faz, motoru
multi-pass etkin renderer haline getirir. **Kullanıcının kalite/performans
önceliği bu fazda başlar.**

| PR | Kapsam | Notlar |
|---|---|---|
| F9.0 | `gpu-effects.js`'e ping-pong FBO altyapısı (`createFramebuffer`, swap A/B) | Mevcut tek-pass `applyShaderPass` üstüne, opt-in `applyShaderChain(passes)` ekle |
| F9.1 | Mip pyramid downsample/upsample helper (RGBA8 önce; HDR sonra) | `gl.generateMipmap` + manuel level FBO'ları |
| F9.2 | Bloom multi-pass (threshold → downsample N kez → upsample bilinear → add back) | Single-pass disk shader'ı fallback olarak kalsın |
| F9.3 | Halation aynı multi-pass altyapısı üzerine taşınsın | Tint hâlâ luma-only sample'lar üstünde uygulanır |
| F9.4 | Glare / star-glow streaks: directional downsample chain | Streak iterasyonları mip seviyelerine bindirilir |
| F9.5 | Blur node (Gauss): separable two-pass (H, V) — F9.0 altyapısı kullanır | Mevcut CPU box blur'a göre 5-10× hızlanma; kullanıcının raporladığı blur kasması burada çözülür |
| F9.6 | HDR RT desteği (RGBA16F) — opsiyonel, capability detect ile | Saturate'i geciktirmek, bloom highlight korumak için |

Kabul kriterleri: bloom artifact'siz çıkar, blur node 1080p'de < 8ms/frame,
DoF / halation tek pass yerine multi-pass'ten faydalanır.

---

## 2. F10 — Timeline + Player UI yeniden tasarım (en geniş UX fazı)

Kullanıcı feedback'i (2026-05-12): "playerin baştan aşağı değişmesi lazım",
"timelineın tipini çok seviyorum, olabildiğince kopyalayabilir miyiz".
Shader-lab'in unified floating panel'i (transport + ruler + per-property
track + per-keyframe bezier editor + multi-select + clipboard) bizim ayrı
player card + properties paneli + zayıf transport satırı kombinasyonundan
çok daha sağlam. **Bu faz mevcut player.js + properties paneli + timeline
view'ını tek floating overlay altında yeniden inşa eder.**

### F10.1 — Schema: per-keyframe bezier easing + step
| Kapsam | Notlar |
|---|---|
| `KeyframeEasing = { type: "bezier"; controlPoints: [x1,y1,x2,y2] } \| { type: "step" }` | Mevcut `interpolation` string'ini bezier'a migrate eden `migrateInterpolationToEasing` |
| 18 preset (Linear, Smooth, Quick Out, Anticipate, Back In/Out, …) | Shader-lab'in `EASING_PRESETS` listesini aynen al |
| `evaluateTrack` cubic-bezier sampler (Newton iteration) | shader-lab'in `easings.ts` örneği baz alınır |

### F10.2 — Unified floating overlay (transport şeridi)
| Kapsam | Notlar |
|---|---|
| Player card + timeline panel + properties bölmeleri kaldırılır; tek floating panel gelir | `editor-timeline-overlay.tsx` paterni — collapsed (~580×46) + expanded (~820×380) iki mod |
| Transport row: Play/Pause • Stop • Loop • Auto-Key • Dur [num] sec • time/total readout • expand/collapse caret | `IconButton` + vertical divider çubukları |
| Mevcut autokey/loop pill'leri elenir; minimal icon toggle'lar yerine geçer (kullanıcının "sevmedim" feedback'i) | Active state için subtle accent background |
| Klavye kısayolları: Space (play/pause), L (loop toggle), K (auto-key toggle), Home/End | shader-lab'da yok ama yapmamız mantıklı |

### F10.3 — Adaptive ruler + playhead
| Kapsam | Notlar |
|---|---|
| Major/minor tick step'leri duration'a bağlı (`getMajorTickStep(duration)`) | duration ≤ 6s → 1s, ≤ 12s → 2s, ≤ 30s → 5s, … |
| Major tick'lerde saniye etiketi, minor tick'lerde küçük dik çizgi | Mono font readout |
| Playhead drag (pointer capture; pause sırasında) | Drag esnasında numeric tooltip |

### F10.4 — Property tracks (otomatik liste)
| Kapsam | Notlar |
|---|---|
| Seçili node için: önce 3 layer-level property (opacity/hue/saturation) — color-coded; sonra `visible params` (parameter-schema'ya göre filtreli) | shader-lab'in `buildTimelineProperties` paterni |
| Color coding: opacity #8DB1FF, hue #A4E0A0, saturation #F7B365, color params #FF8CAB, diğer #B697FF | Direkt al |
| Per-track satır: solda label + diamond keyframe ikonu (toggle key at current time) + sağda track lane | `data-track-id` |
| Track enable/disable (göz ikonu) — track silmeden geçici devre dışı bırakma | Mevcut tek bayrak `enabled` |

### F10.5 — Keyframe operasyonları
| Kapsam | Notlar |
|---|---|
| Tek keyframe drag (pointer capture, snap-to-frame opsiyonu) | Mevcut `snapTimeToFrame` |
| Marquee selection (rectangle select) | shader-lab'in `DragState.type === "marquee"` paterni |
| Multi-select (Shift-click toggle, Cmd/Ctrl-click extend) | `selectedKeyframeIds` mevcut, UI bağla |
| Arrow nudge: ←/→ = 1/60s, Shift+←/→ = 10/60s | `SMALL_NUDGE_TIME` / `LARGE_NUDGE_TIME` |
| Delete: seçili keyframe'ler tek aksiyonda silinir | Undo entry tek olur |
| Clipboard: Cmd/Ctrl+C kopyalar, Cmd/Ctrl+V playhead'e relative paste | `TimelineKeyframeClipboard` module-level var pattern'i — basit ama yeterli |

### F10.6 — Per-keyframe inline bezier editor (popover)
| Kapsam | Notlar |
|---|---|
| Keyframe seçildiğinde sağ-alt köşede curve editor popover butonu | `CurveEditorPopover` |
| Popover içinde: cubic bezier görselleştirme + preset listesi + manuel control point drag (4 nokta) + Step toggle | F5.1 curve primitive yeniden kullanılabilir |
| Easing değişikliği tek undo entry'sine düşer | Live preview drag esnasında |

### F10.7 — Color/vec interpolation parity
| Kapsam | Notlar |
|---|---|
| Hex string'ler RGB'ye lerp + tekrar hex (`parseHexColor` + `rgbToHex`) | shader-lab'in `interpolateValue` switch'i |
| vec2/vec3 component-wise lerp | Mesh-gradient stops dahil (ileri faz) |
| Boolean: step (cross >0.5 noktasında flip) | Mevcut |

### F10.8 — Mobile-friendly layout (opsiyonel)
| Kapsam | Notlar |
|---|---|
| Dar viewport'ta (≤ 720px) timeline overlay tam-genişlik dock'a düşer | shader-lab'in `mobile-editor-dock.tsx` paterni; Tauri dev mode için low-priority |

**Kabul kriterleri:**
1. Mevcut player card + properties + ayrı timeline panel kalkar; tek floating overlay'e iner.
2. Collapsed mod tek satır transport + readout; expanded mod tam timeline.
3. Per-keyframe bezier easing düzenlenebilir; 18 preset listesi var.
4. Multi-select keyframe drag + delete + clipboard tek-aksiyon undo.
5. Klavye nudge çalışır.
6. Color/vec animasyonu doğru lerp eder.

---

## 3. F11 — Composite & scene grading parity

Onların `pass-node` mimarisi her layer'a 16 blend mode + mask config + per-layer
hue/saturation/opacity veriyor; bizim mix node'umuz sınırlı, scene-wide grading
yok. Bu faz graph editor üzerinde küçük PR'larla parite alır.

| PR | Kapsam | Notlar |
|---|---|---|
| F11.1 | 16 blend mode katalogu (normal, multiply, screen, overlay, darken, lighten, color-dodge/burn, hard/soft-light, difference, exclusion, hue, saturation, color, luminosity) | `mix` node'unda + opsiyonel olarak `viewer-output` üstünde blend selector. CPU + GPU pair |
| F11.2 | Mask config zenginleştirme: source (luma/alpha/R/G/B), mode (multiply/stencil), invert | `mask-apply` node'una param ekleme |
| F11.3 | Scene-wide post-process node: master color curves (R/G/B + master) + clamp gamma + opsiyonel color-map LUT | `viewer-output`'tan önce uygulanan global node; F5.2 rgb-curves altyapısı + F1.2 gradient LUT helper'ı yeniden kullanılır |
| F11.4 | Layer-level color adjustments (per-node hue/saturation/opacity bayrakları) | Property tracks'in (F10.4) animasyon hedefi olur |

---

## 4. F12 — Export polish

Mevcut FFmpeg sidecar'ı kalır (production-grade codec desteği güçlü); ancak
quality/aspect preset'leri ve UI polish UX'i ciddi iyileştirir.

| PR | Kapsam | Notlar |
|---|---|---|
| F12.1 | Quality preset'leri: draft 1280, standard 1920, high 3840, ultra 7680 long-edge | shader-lab'in `EXPORT_QUALITY_LONG_EDGE` listesi |
| F12.2 | Aspect preset'leri: 16:9, 1:1, 4:5, 9:16, original (+ custom WxH) | Crop math `composition.ts` örnek alınır |
| F12.3 | Still image export: PNG/JPG seçici + JPG quality slider | Mevcut snapshot path'i polish |
| F12.4 | Export progress UI: phase ("preparing", "encoding"), ETA, cancel button | Mevcut export sheet üstüne |
| F12.5 | (Opsiyonel) WebCodecs preview-export hattı — küçük dosya / hızlı preview için, fallback FFmpeg | F8.5 worker entegrasyonu uyumlu; production export için FFmpeg sidecar kalır |

---

## 5. F13 — Stretch (custom-shader + procedural sources)

| PR | Kapsam | Notlar |
|---|---|---|
| F13.1 | `gradient` procedural source (mesh-gradient'in yanı sıra linear/radial/conic) | Üç ayrı shader; param schema benzer |
| F13.2 | (Opsiyonel) `custom-shader` node type: kullanıcı GLSL fragment'ı yapıştırır, uniform UI auto-generated | `parameter-schema.ts` paterni; safety: compile error inline gösterimi. Advanced — son sırada |
| F13.3 | (Opsiyonel) Fluid simulation source | Heavy; gerçekten ihtiyaç olursa |

**Kapsam dışı bırakılanlar (kullanıcı kararı):** audio-reactive bindings.

---

## 6. Bizim öne çıktığımız alanlar (regression yapmadan koruyalım)

* **Dithering catalog (27 algoritma + palette sistemi)** — shader-lab'da yok.
* **Image-sequence + EXR workflow** — shader-lab pure web; bizde local-first Tauri.
* **Tauri native render path + FFmpeg sidecar** — production-grade export.
* **Node graph (DAG)** — onların linear layer stack'inden daha esnek.
* **Group nodes (F6) + on-canvas gizmos (F7)** — kendi yolumuz.

Bu plan, "shader-lab gibi olmak" değil; "onların iyi yaptıklarını alıp kendi
yolumuzu güçlendirmek" üzerinedir.

---

## 7. Önerilen sıra ve neden

1. **F9 önce — kalite/performans** (kullanıcı önceliği): Bloom ring fix, blur
   perf, glow türevleri hep aynı altyapı eksikliğinden. Multi-pass FBO
   altyapısını yazdığımızda 5+ effect aynı anda düzelir.
2. **F10 hemen sonra — UX**: Player+timeline yeniden tasarım. Kullanıcının
   günlük temasına en görünür etkisi olan iş.
3. **F11** — Composite/grading parite; graph editor üzerinde küçük PR'lar.
4. **F12** — Export polish.
5. **F13** — Stretch, opsiyonel.

Tahmin: F9 ≈ 2-3 hafta, F10 ≈ 2-3 hafta (UX-ağırlıklı), F11 ≈ 1 hafta,
F12 ≈ 1 hafta, F13 açık uçlu. Total ≈ 6-8 hafta tek dev.

---

## 8. Açık kararlar (kullanıcı tarafında)

* **WebCodecs hattı kurulsun mu** (F12.5), yoksa FFmpeg sidecar tek hat mı
  kalsın? Bizim hedef Tauri desktop olduğu için FFmpeg yeterli olabilir;
  WebCodecs daha çok web ön-izleme için anlamlı.
* **HDR (RGBA16F) RT** (F9.6) ne zaman? F9'un içinde opsiyonel; bloom'u
  iyileştirmek için 8-bit RT'ler bile yeterli olabilir.
* **Custom-shader user-API'si** (F13.2) güvenlik + compile error UX'i nedeniyle
  ileri tarihe bırakılabilir.
