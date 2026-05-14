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
**Durum (2026-05-12): ✅ İndi.** `src/js/timeline.js` timeline v2'ye
çıktı; keyframe `easing` alanı `{ type: "bezier", controlPoints }` /
`{ type: "step" }` şemasına normalize ediliyor. Eski string
`interpolation` / `easing` değerleri migration yoluyla korunuyor; legacy
tangent tabanlı bezier segmentleri explicit tangent varsa hala çalışıyor.

| Kapsam | Notlar |
|---|---|
| `KeyframeEasing = { type: "bezier"; controlPoints: [x1,y1,x2,y2] } \| { type: "step" }` | Mevcut `interpolation` string'ini bezier'a migrate eden `migrateInterpolationToEasing` |
| 18 preset (Linear, Smooth, Quick Out, Anticipate, Back In/Out, …) | Shader-lab'in `EASING_PRESETS` listesini aynen al |
| `evaluateTrack` cubic-bezier sampler (Newton iteration) | shader-lab'in `easings.ts` örneği baz alınır |

### F10.2 — Unified floating overlay (transport şeridi)
**Durum (2026-05-12): ✅ İlk geçiş indi.** `#playerCard` artık
workspace içinde alt-merkezde yüzen tek overlay. Transport tek satıra indi
(Play/Pause, Stop, Loop, Auto-Key, duration, readout, more, expand/collapse)
ve `timeline.panelOpen` ile collapsed / expanded state save-load hattına
bağlandı. Eski frame-step butonları transporttan çıktı; Home/End ve ok
tuşu kısayolları korunuyor.

| Kapsam | Notlar |
|---|---|
| Player card + timeline panel + properties bölmeleri kaldırılır; tek floating panel gelir | `editor-timeline-overlay.tsx` paterni — collapsed (~580×46) + expanded (~820×380) iki mod |
| Transport row: Play/Pause • Stop • Loop • Auto-Key • Dur [num] sec • time/total readout • expand/collapse caret | `IconButton` + vertical divider çubukları |
| Mevcut autokey/loop pill'leri elenir; minimal icon toggle'lar yerine geçer (kullanıcının "sevmedim" feedback'i) | Active state için subtle accent background |
| Klavye kısayolları: Space (play/pause), L (loop toggle), K (auto-key toggle), Home/End | shader-lab'da yok ama yapmamız mantıklı |

### F10.3 — Adaptive ruler + playhead
**Durum (2026-05-12): ✅ İndi.** Ruler artık timeline süresine ve zoom'a
göre major/minor saniye tick'leri üretir. Playhead handle pointer-capture ile
sürüklenebilir, frame grid'e snap eder, sürükleme sırasında playback'i pause
eder ve inline zaman/frame tooltip'i gösterir.

| Kapsam | Notlar |
|---|---|
| Major/minor tick step'leri duration'a bağlı (`getMajorTickStep(duration)`) | duration ≤ 6s → 1s, ≤ 12s → 2s, ≤ 30s → 5s, … |
| Major tick'lerde saniye etiketi, minor tick'lerde küçük dik çizgi | Mono font readout |
| Playhead drag (pointer capture; pause sırasında) | Drag esnasında numeric tooltip |

### F10.4 — Property tracks (otomatik liste)
**Durum (2026-05-12): ✅ İndi.** Timeline properties paneli artık seçili
node'dan otomatik target listesi üretir: layer-level opacity/hue/saturation
slot'ları en üste gelir, ardından numeric ve HEX color param'ları görünür.
Her satır color-coded diamond key toggle, geçici enable/disable göz toggle'ı
ve expand edilebilir lane ile aynı track id üzerinden çalışır.

| Kapsam | Notlar |
|---|---|
| Seçili node için: önce 3 layer-level property (opacity/hue/saturation) — color-coded; sonra `visible params` (parameter-schema'ya göre filtreli) | shader-lab'in `buildTimelineProperties` paterni |
| Color coding: opacity #8DB1FF, hue #A4E0A0, saturation #F7B365, color params #FF8CAB, diğer #B697FF | Direkt al |
| Per-track satır: solda label + diamond keyframe ikonu (toggle key at current time) + sağda track lane | `data-track-id` |
| Track enable/disable (göz ikonu) — track silmeden geçici devre dışı bırakma | Mevcut tek bayrak `enabled` |

### F10.5 — Keyframe operasyonları
**Durum (2026-05-12): ✅ İndi.** Single + multi keyframe drag, marquee
selection, shift/cmd multi-select, Delete, Cmd+D duplicate, ←/→ nudge
(1 frame; Shift = 10 frame), ve Cmd+C/Cmd+V clipboard tamam. Multi-drag
artık chord'u tek delta ile kaydırıyor; ok-tuşları seçim varsa keyframe'i
nudgler, yoksa playhead step'e düşer; clipboard module-level
`timelineKeyframeClipboard` üzerinden çalışır ve paste playhead'e en erken
zamanı koyar — gerisi göreli offset'leri korur.

| Kapsam | Notlar |
|---|---|
| Tek keyframe drag (pointer capture, snap-to-frame opsiyonu) | Mevcut `snapTimeToFrame` |
| Marquee selection (rectangle select) | shader-lab'in `DragState.type === "marquee"` paterni |
| Multi-select (Shift-click toggle, Cmd/Ctrl-click extend) | `selectedKeyframeIds` mevcut, UI bağla |
| Multi-select drag: chord tek delta ile birlikte hareket eder | `moveTimelineKeyframes` batch helper |
| Arrow nudge: ←/→ = 1 frame, Shift+←/→ = 10 frame (fps-tabanlı) | `nudgeSelectedKeyframes` — selection yokken playhead step'e düşer |
| Delete: seçili keyframe'ler tek aksiyonda silinir | Mevcut `deleteSelectedKeyframes` |
| Clipboard: Cmd/Ctrl+C kopyalar, Cmd/Ctrl+V playhead'e relative paste | Module-level `timelineKeyframeClipboard` + `pasteTimelineKeyframes` helper'ı; en erken zamanlı item playhead frame'ine düşer |

### F10.6 — Per-keyframe inline bezier editor (popover)
**Durum (2026-05-12): ✅ İndi.** Eski easing `<select>` kaldırıldı; yerine
keyframe panelinde mini-eğri thumbnaillı bir `bezier-trigger` butonu var.
Tıklayınca body-level `.bezier-popover` açılıyor: 100×100 viewBox üzerinde
cubic bezier eğri, iki sürüklenebilir P1/P2 handle (overshoot için y ekseni
[-1.5, 2.5] aralığında), 18 preset chip 3 sütunlu grid'de kategorik
sıralanmış, altta cubic-bezier(...) readout + Step easing toggle. Drag,
preset click ve step toggle anlık `updateTimelineKeyframe` dispatch'i ile
live preview yapıyor; timeline subscribe popover'ın SVG'sini ve readout'unu
yeniden render ediyor. Outside-click ve Esc kapatıyor.

| Kapsam | Notlar |
|---|---|
| Keyframe seçildiğinde bezier-trigger butonu (mini curve thumbnail + easing adı) | `renderBezierTriggerButton` |
| Popover: cubic bezier viz + 18 preset chip + 2 control point drag + Step toggle | Body'ye fixed-position eklenir; `.player-more-popover` tabanından `.bezier-popover` |
| Live preview drag esnasında | Pointermove sırasında `updateTimelineKeyframe` dispatch + subscribe re-render |
| Outside-click ve Esc ile kapanır; keyframe silinirse popover kendini kapatır | `getTimelineKeyframe` null dönerse closeBezierPopover |

### F10.7 — Color/vec interpolation parity
**Durum (2026-05-12): ✅ İndi.** `interpolateValues` artık hex string
çiftlerini `hexToRgb01` ile RGB'ye çevirip 0-1 aralığında component-wise
lerp yapıp `rgbToHex` ile geri yazıyor; 3-digit (`#fff`), 6-digit, ve
`#`-siz girdiler aynı path'tan geçiyor, karma format (3 vs 6) da
destekleniyor. Boolean keyframe'leri t<0.5 için `from`, ≥0.5 için `to`
döndürüyor — non-linear easing'ler eğri 0.5'i geçtiği anda flip ediyor.
vec2/vec3 array + `{x,y,z}` object lerp zaten vardı (regression test
geçti). Mesh-gradient stops karma tip içerdiği için ileri faza
bırakıldı.

| Kapsam | Notlar |
|---|---|
| Hex string'ler RGB'ye lerp + tekrar hex | `interpolateHexColor` + `isHexColorString`, `color.js`'in `hexToRgb01` + `rgbToHex` helper'larıyla |
| vec2/vec3 component-wise lerp | Array + tüm-numeric object branch zaten vardı |
| Boolean: step at eased >0.5 | Yeni branch; `t < 0.5 ? from : to` |
| Non-hex string fallback | Mevcut step-at-t=1 davranışı korundu |

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

## 3. F11 — Composite, scene grading + UI primitive parity

Onların `pass-node` mimarisi her layer'a 16 blend mode + mask config + per-layer
hue/saturation/opacity veriyor; bizim mix node'umuz sınırlı, scene-wide grading
yok. Plus, shader-lab'ın inspector UI primitive'leri (curves, xy-pad, color-
picker, gradient-ramp) bizimkilerden daha sağlam — kullanıcı feedback'i
(2026-05-12): "rgb curves, xy pad, renk seçici, color ramp gibi mevzuları
direkt shader-lab dosyasından öğren ona uygun yap".

### Composite parity (graph editor düğümleri)
| PR | Kapsam | Notlar |
|---|---|---|
| F11.1 | 16 blend mode katalogu (normal, multiply, screen, overlay, darken, lighten, color-dodge/burn, hard/soft-light, difference, exclusion, hue, saturation, color, luminosity) | **✅ İndi (2026-05-12).** `image-ops.js` `MIX_MODES` katalogunu export ediyor; `mapCompositeMode` switch'i 16 modu Canvas 2D `globalCompositeOperation` üzerine düşürüyor (browser zaten GPU-composite ediyor — ayrı bir WebGL shader pair'i yazılmadı). Legacy `add` modu `lighter` alias'ı olarak korundu. Mix inspector dropdown'u listeyi direkt katalogdan okuyor. `viewer-output` üstünde blend selector opsiyonel/atlandı. |
| F11.2 | Mask config zenginleştirme: source (luma/alpha/R/G/B), mode (multiply/stencil), invert | **✅ İndi (2026-05-12).** `image-ops.js` `MASK_SOURCES` + `MASK_MODES` katalogu export ediyor; `applyMaskApplyNode` artık 5 kanaldan birini sample edip (`sampleMaskChannel`), `stencil` mode'da 0.5 eşiğinde hard-clip yapıyor (`multiply` legacy continuous fade). Source buffer'ları artık alpha-transparent context'inde okunuyor — alpha source çalışsın diye. Inspector `MASK_SOURCES`/`MASK_MODES` listelerini direkt katalogdan okuyor. Invert toggle korundu. |
| F11.3 | Scene-wide post-process node: master color curves (R/G/B + master) + clamp gamma + opsiyonel color-map LUT | **✅ İndi (2026-05-13).** `scene-grade` color node'u eklendi; palette/context menu'den `viewer-output` öncesine takılabiliyor. Runtime `applySceneGradeNode` içinde F5.2 RGB curves LUT hattını, clamp min/max + gamma remap'i ve F1.2 `buildGradientLut` tabanlı opsiyonel color-map LUT'u tek final pass'te uyguluyor. Inspector, RGB/master curve editor'ı yeniden kullanıyor; LUT shadow/highlight stop'ları `colorMapStops` üzerinden normalize ediliyor. |
| F11.4 | Layer-level color adjustments (per-node hue/saturation/opacity bayrakları) | **✅ İndi (2026-05-13).** Node modeline `opacity`/`hue`/`saturation` layer bayrakları eklendi; save/load non-default değerleri saklıyor. Runtime non-source/output node'larda `applyLayerAdjustmentsNode` ile hue/saturation pass'i ve opacity blend'i uyguluyor; opacity image tabanlı node'larda primary input'a, procedural node'larda siyaha doğru karışıyor. Inspector `Layer` bölümü bu üç property'yi gösteriyor ve F10.4 `node-property` track/keyframe hattı artık gerçek render çıktısını sürüyor. |

### Inspector UI primitive parity (shader-lab'tan port)
| PR | Kapsam | Kaynak (shader-lab) | Notlar |
|---|---|---|---|
| F11.5 | **Color curves editor** — channel switcher (master/R/G/B), monotone curve tangents, MIN_POINT_GAP guard, smooth handle interaction | `src/components/ui/color-curves/index.tsx` (565 satır) | **✅ İndi (2026-05-13).** Mevcut JS inspector primitive'i shader-lab davranışına yaklaştırıldı: `curve-lut.js` monotone tangent helper + `MIN_CURVE_POINT_GAP` guard kullanıyor; curve SVG artık cubic path olarak çiziliyor, 6px handle'lar focus/drag state alıyor ve drag sırasında inspector yeniden render edilmeden path/handle katmanı yerinde güncelleniyor. Curve point değişimleri timeline autokey/bound-track hattına da yazılıyor. |
| F11.6 | **XY pad** — 2D vec parametreleri için (vec2 hedefler: center, offset, displace amount XY) | `src/components/ui/xy-pad/index.tsx` (217 satır) | **✅ İndi (2026-05-13).** Inspector'a native JS `renderXyPadField` primitive'i eklendi; min/max/step, pointer drag, Shift+arrow hızlandırmalı keyboard nudging ve drag sırasında rerender yapmadan live handle/readout sync destekleniyor. Transform translate, Lens/Chromatic/Depth center, Displace amount ve map offset çiftleri pad ile sürülüyor; her commit iki param track'ini F10.4 autokey/bound-track hattına yazıyor. |
| F11.7 | **Color picker** — HSV popover, hex input, eyedropper opsiyonel | `src/components/ui/color-picker/index.tsx` (423 satır) | **✅ İndi (2026-05-13).** Native color input yerine vanilla JS HSV picker primitive'i geldi: swatch+HEX trigger, saturation/value surface, hue rail, popover HEX input ve desteklenen browser'larda opsiyonel `EyeDropper`. `renderColorField`, gradient/scene color-map stopları ve mesh-gradient stop renkleri aynı primitive'i kullanıyor; node color param commit'leri timeline autokey/bound-track hattını da güncelliyor. |
| F11.8 | **Gradient ramp** — multi-stop gradient editor (drag stops, add/remove, color picker per stop) | `src/components/ui/gradient-ramp/index.tsx` (196 satır) | **✅ İndi (2026-05-13).** Gradient-map ve Scene Grade color-map LUT iki uç renk alanından çok-stop ramp primitive'ine taşındı: bar üstünden stop ekleme, seçili interior stop'u sürükleme, stop silme ve F11.7 HSV picker ile stop rengi düzenleme aynı inspector hattında çalışıyor. Mesh-gradient hâlâ spatial stop UI'ında kalıyor; renk stopları F11.7 picker primitive'ini kullanıyor. |
| F11.9 | **Channel curves** (alt-kategori) — RGB kanallarına ayrı curve | `src/components/ui/channel-curves/index.tsx` (255 satır) | **✅ İndi (2026-05-13).** RGB Curves ve Scene Grade inspector'larında channel dropdown yerine shader-lab ruhuna yakın renkli kanal strip'i geldi: Master/R/G/B ayrı mini curve preview olarak görünüyor, seçilen kanal büyük curve editor'a taşınıyor ve mevcut full-point LUT/overlay altyapısı korunuyor. |

---

---

## 4. F12 — Export polish

Mevcut FFmpeg sidecar'ı kalır (production-grade codec desteği güçlü); ancak
quality/aspect preset'leri ve UI polish UX'i ciddi iyileştirir.

| PR | Kapsam | Notlar |
|---|---|---|
| F12.1 | Quality preset'leri: draft 1280, standard 1920, high 3840, ultra 7680 long-edge | **✅ İndi (2026-05-13).** `export.js` `EXPORT_QUALITY_LONG_EDGE` katalogu export ediyor; `resolveStillSize` kaynak long-edge'i preset hedefine scale ederek aspect'i koruyor. Still/video/sequence üç export modunun resolution dropdown'u tek `renderResolutionOptions()` helper'ından besleniyor; `Source / Draft (1280) / Standard (1920) / High (3840) / Ultra (7680) / Half / Custom` sırası. |
| F12.2 | Aspect preset'leri: 16:9, 1:1, 4:5, 9:16, original (+ custom WxH) | **✅ İndi (2026-05-13).** `EXPORT_ASPECT_RATIOS` katalogu (`original`, `16:9`, `1:1`, `4:5`, `9:16`) ve state `aspectMode` eklendi; `resolveStillSize` quality preset long-edge'i seçili oran üzerinden W×H'ye böl-çarp ediyor. `computeCoverCrop` aspect mismatch'inde kaynak görüntüyü center-crop ediyor; `buildStillExportCanvas` 9-arg `drawImage` ile distortion bırakmıyor. Custom WxH modu existing custom resolution hattıyla karşılanıyor, o modda Aspect dropdown disable. |
| F12.3 | Still image export: PNG/JPG seçici + JPG quality slider | **✅ İndi (2026-05-13).** Still ve image-sequence JPEG modlarında `JPEG Quality` slider'ı görünür; state `jpegQuality` olarak 1-100 aralığında tutulur ve browser encoder'a `quality / 100` olarak geçer. PNG path'i hardcoded quality'den ayrıldı. |
| F12.4 | Export progress UI: phase ("preparing", "encoding"), ETA, cancel button | **✅ İndi (2026-05-13).** Progress state'i `phase`, `startedAt`, `updatedAt` alanlarıyla genişledi; sheet progress kartı faz label'ı, ETA ve mevcut frame/percent bilgilerini gösteriyor. Sequence export `preparing/rendering/writing`, video export `preparing/encoding/finalizing`, cancel ise `cancelling` fazını kullanıyor. |
| F12.5 | (Opsiyonel) WebCodecs preview-export hattı — küçük dosya / hızlı preview için, fallback FFmpeg | **✅ İndi (2026-05-13).** FFmpeg H.264 default production hattı korunuyor; video codec seçicisine `VP9 Preview (WebCodecs)` eklendi. WebCodecs availability ayrı check/status ile gösteriliyor, destek varsa aynı render/seek loop'u VP9 `VideoEncoder` üzerinden encode edilip IVF preview dosyası olarak yazılıyor veya browser download fallback'e düşüyor. |

---

## 5. F13 — Graph editor UX overhaul

Kullanıcı feedback'i (2026-05-12): mevcut node palette ayrı kartlar, search yok,
shortcut'lar dağınık, sol-tık-drag pan ama box select daha doğal. Bu faz
graph editor'ün interaction modelini ve palette UX'ini yeniden inşa eder.

### F13.1 — Node palette polish
| Kapsam | Notlar |
|---|---|
| **Arama kutusu** — palette başlığında lupe ikonu + inline filter input | Fuzzy/substring; kategori başlıkları match'e göre filtrelenir |
| **Kompakt liste** — her node ayrı kart yerine tek satır + sol kenar renk şeridi (mevcut color coding korunur) | Screenshot baz alınır; padding küçülür, kategoriler hâlâ üst başlık (INPUT / COLOR / PROCESS / …). **Renk yapımız onlardan daha iyi** — onlar tek renk; biz family color şeridini koruruz |
| **Drag handle ergonomisi** — node satırı tam highlight, sürüklenebilir whole row | Mevcut drag mevcut, sadece görsel polish |

**Durum:** F13.1a indi (2026-05-13). Palette başlığına inline search eklendi; kategori ve node satırları substring/family/type match'e göre filtreleniyor. Node satırları daha kompakt hale geldi, family color şeridi korunuyor.

### F13.2 — Canvas sağ-tık context menu
| Kapsam | Notlar |
|---|---|
| Boş canvas'a sağ-tık → kategorilere ayrılmış node picker (palette'in mini versiyonu) | Tıklanan konuma node free-place edilir |
| Node üstüne sağ-tık → mevcut context menu (delete, group, ungroup, duplicate, bypass) | Mevcut |
| Edge üstüne sağ-tık → edge insert picker (node araya sokulur) | Mevcut insert flow daha keşfedilebilir hale gelir |

**Durum:** F13.2a indi (2026-05-13). Boş canvas ve edge sağ-tık menüsü palette'in mini kategorize versiyonunu kullanıyor; edge üstünde header `Insert Node / edge`, boş canvas'ta `Add Node / canvas` olarak ayrılıyor. Aile renk şeritleri context menu'de de korunuyor.

**Durum:** F13.2b indi (2026-05-13). Node üstüne sağ-tık menüsü eklendi: duplicate, bypass/enable, group selected, open group, ungroup ve delete aksiyonları tek menüden çalışıyor. Source/viewer/group için uygun olmayan aksiyonlar disabled kalıyor; duplicate regular node param/layer/exposed-param state'ini koruyarak offset'li kopya oluşturuyor.

### F13.3 — Interaction model rework (mouse + modifiers)
Kullanıcının istediği yeni model:

| Eylem | Tuş kombinasyonu |
|---|---|
| Box select (rectangle select) | **Sol-tık drag (boş alanda)** |
| Node seç / multi-select | **Cmd/Ctrl+sol-tık** node üstünde |
| Edge cut (kesme aracı) | **Option/Alt+sol-tık drag** (boş alanda) |
| Canvas pan | **Space+sol-tık drag** (Photoshop pattern) + mevcut trackpad 2-finger pan (F6) |
| Node move | Sol-tık node + drag (mevcut, değişmez) |

> Mevcut model: sol-tık-drag = pan, Cmd+sol-tık-drag = edge cut. Yeni model
> pan'i Space modifier'a alıyor; box select doğal sol-tık'a düşüyor. Bu
> önemli bir kassel kıran değişiklik — eski kullanıcı kasları bozulur, ama
> standart 2D editör paterniyle (Figma, Blender 2.8+) uyumlu hale geliyor.

**Durum:** F13.3a indi (2026-05-14). Boş canvas sol-drag artık marquee box select; boş canvas tek tık selection clear. Edge cut `Option/Alt + sol-drag` oldu; canvas pan `Space + sol-drag` moduna taşındı ve trackpad/wheel pan korunuyor. Marquee selection live inspector/edge highlight sync ediyor, Escape ile drag iptal edilebiliyor.

### F13.4 — Klavye kısayolları (genişletilmiş)
| Tuş | Eylem |
|---|---|
| **G** | Seçili node'ları grupla (mevcut Cmd+G ile yan yana; Shift+G ungroup) |
| **M** | Seçili node'lar için bypass toggle |
| **X** veya **Delete/Backspace** | Seçili node'ları sil |
| **T** | Solo: seçili node'u tek başına `viewer-output`'a route et (önceki bağlantı saklanır; T tekrar basılınca geri yüklenir) |
| **F** | Selected node(s)'a frame (graph editor zoom + pan) |
| **A** | Select all (current parent scope) |
| **Escape** | Selection clear, drag iptal, popover kapat |
| **Cmd/Ctrl+D** | Duplicate selected |
| **R** | Rename selected node (label inline edit) |
| **Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z** | Undo / Redo (mevcut) |

**Solo (T) implementasyon notu:** seçili node'un primary output'u temporary
olarak `viewer-output`'un primary input'una bağlanır. Mevcut bağlantı bir
"solo stash"e kaydedilir. T'ye tekrar basıldığında stash geri yüklenir,
solo edge silinir. Solo aktifken bir badge gösterilir.

**Durum:** F13.4a indi (2026-05-14). İlk klavye paketi eklendi: `G` / `Shift+G` group-ungroup, `M` bypass toggle, `X`/Delete/Backspace delete, `A` current scope select-all, `Escape` selection clear, `Cmd/Ctrl+D` duplicate selected, `F` selected node'lara frame. `T` solo ve `R` inline rename ayrı dilimde kalıyor.

**Durum:** F13.4b indi (2026-05-14). `T` solo toggle eklendi: seçili node primary output'u geçici olarak `viewer-output` primary input'una bağlanıyor; tekrar `T` eski viewer edge'ini stash'ten geri yüklüyor. Solo aktif node üzerinde `Solo` badge görünüyor; proje serialize ederken temporary solo edge'i değil stash'teki gerçek edge yazılıyor.

**Durum:** F13.4c indi (2026-05-14). `R` inline rename eklendi: seçili node title'ı input'a dönüşüyor; Enter ve blur commit, Escape cancel. Label graph state'e yazılıyor ve inspector/timeline track label'ları yeni adı izliyor.

### F13.5 — Cursor + visual feedback
| Kapsam | Notlar |
|---|---|
| Mod-specific cursor: box select → crosshair, pan → grab/grabbing, cut → scissors | F6'da pan grabbing zaten var |
| Marquee rectangle: dashed outline + subtle fill | Cancel'lanabilir (Escape) |
| Cut path: dashed red stroke (mevcut görünüm korunur) | Mevcut |

**Durum:** F13.5 indi (2026-05-14). Box select, Space pan ve Alt/Option cut cursor state'leri ayrıldı; cut-ready/drag sırasında scissors cursor gösteriliyor, cut path kırmızı dashed stroke'a taşındı. Marquee dashed outline + subtle fill F13.3a selection modeliyle aktif.

**Kabul kriterleri:**
1. Boş canvas'a sağ-tık → kategorize node picker açılır.
2. Palette search box çalışır.
3. Sol-tık drag → box select; Option/Alt drag → cut; Space+drag → pan.
4. G grupla, M bypass, X delete, T solo — hepsi tek tuş.
5. F frame, A select-all, Esc cancel, R rename çalışır.

---

## 6. F14 — Stretch (procedural sources)

| PR | Kapsam | Notlar |
|---|---|---|
| F14.1 | `gradient` procedural source (mesh-gradient'in yanı sıra linear/radial/conic) | Üç ayrı shader; param schema benzer |

**Durum:** F14.1 indi (2026-05-14). `gradient` procedural source eklendi: Linear/Radial/Conic mode, ortak gradient ramp editörü, center/angle/repeat/shift/output size kontrolleri ve GPU source shader + CPU fallback aynı node üstünden çalışıyor.

**Faz durumu:** ✅ Tamamlandı (2026-05-14). F14.1 ile faz kapandı.

**Kapsam dışı bırakılanlar (kullanıcı kararı):**
- Audio-reactive bindings.
- F14.2 `custom-shader` node — gereksiz: node'lar kod yoluyla ekleniyor, son kullanıcının inline GLSL yazmasına ihtiyaç yok (2026-05-14).
- F14.3 fluid simulation source — gereksiz, ağır ve ihtiyaç yok (2026-05-14).

---

## 6b. F7 follow-up notları (küçük PR'lar)

| Kapsam | Durum |
|---|---|
| **Dashed gizmo for falloff** — ring gizmo'larda inner radius solid, outer (falloff) ring dashed | ✅ İndi (`4264cd8`). `viewer-ring-gizmo__falloff` CSS `stroke-dasharray: 4 3`; DoF falloff > 0 iken görünür |
| **Crop / transform box gizmo** (F7.3 P2'den deferred idi) | ✅ İndi (`e140583`). `viewer-crop-box-gizmo` 4 edge + 4 corner handle, opposing edge clamp; `crop` + `transform` node'ları paylaşıyor |

---

## 7. Bizim öne çıktığımız alanlar (regression yapmadan koruyalım)

* **Dithering catalog (27 algoritma + palette sistemi)** — shader-lab'da yok.
* **Image-sequence + EXR workflow** — shader-lab pure web; bizde local-first Tauri.
* **Tauri native render path + FFmpeg sidecar** — production-grade export.
* **Node graph (DAG)** — onların linear layer stack'inden daha esnek.
* **Group nodes (F6) + on-canvas gizmos (F7)** — kendi yolumuz.

Bu plan, "shader-lab gibi olmak" değil; "onların iyi yaptıklarını alıp kendi
yolumuzu güçlendirmek" üzerinedir.

---

## 8. Önerilen sıra ve neden

1. **F9 önce — kalite/performans** (kullanıcı önceliği): Bloom ring fix, blur
   perf, glow türevleri hep aynı altyapı eksikliğinden. Multi-pass FBO
   altyapısını yazdığımızda 5+ effect aynı anda düzelir.
2. **F10 — Timeline+Player UI**: Kullanıcının günlük temasına en görünür
   etkisi olan iş.
3. **F11 — Composite/grading + UI primitive parity**: 16 blend mode + scene
   grading + curves/xy-pad/color-picker/gradient-ramp upgrades.
4. **F12 — Export polish**.
5. **F13 — Graph editor UX overhaul**: search, sağ-tık menü, shortcut'lar
   (G/M/X/T), mouse mode rework (box select on plain left-click).
6. **F14 — Stretch** (procedural sources). ✅ F14.1 indi; F14.2 + F14.3 kullanıcı kararıyla düşürüldü.

F7 follow-up'ları (dashed gizmo, crop/transform box) ✅ indi (`4264cd8`,
`e140583`).

Tahmin: F9 ≈ 2-3 hafta, F10 ≈ 2-3 hafta, F11 ≈ 1-2 hafta (UI primitive port
yükü), F12 ≈ 1 hafta, F13 ≈ 1-2 hafta. Total ≈ 7-10 hafta tek dev.

---

## 9. Açık kararlar (kullanıcı tarafında)

* **WebCodecs hattı kurulsun mu** (F12.5), yoksa FFmpeg sidecar tek hat mı
  kalsın? Bizim hedef Tauri desktop olduğu için FFmpeg yeterli olabilir;
  WebCodecs daha çok web ön-izleme için anlamlı.
* **HDR (RGBA16F) RT** (F9.6) ne zaman? F9'un içinde opsiyonel; bloom'u
  iyileştirmek için 8-bit RT'ler bile yeterli olabilir.
* **Mouse mode rework (F13.3)** — sol-tık'ın pan'dan box-select'e geçmesi
  mevcut kullanıcının kas hafızasını kırar. Photoshop/Figma/Blender 2.8+
  paterniyle uyumlu ama "always-pan" sevenler için pan'i fallback olarak
  korumak isteyebilir misin? Settings flag opsiyonu sunulabilir.
* **Solo (T) davranışı** — başka node solo'da iken T'ye tekrar basınca
  diğeri unsolo olsun mu, yoksa yeni solo'ya mı geçsin? (Önerim: yeni
  solo'ya geç; tek aktif solo aynı anda.)
