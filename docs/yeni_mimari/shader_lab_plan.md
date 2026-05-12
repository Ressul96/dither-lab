# Shader Lab Port Plan (F9+ track)

> Karşılaştırma kaynağı: https://github.com/basementstudio/shader-lab
> (2026-05-12 itibarıyla shallow clone üzerinde survey.)
>
> F8 tamamlandı; bu doküman, shader-lab'den taşıyacağımız yapıtaşlarını ve
> önerilen sırayı F9–F14 olarak organize ediyor. Her fazın altındaki PR
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
| Easing | 18 preset + per-keyframe cubic-bezier (CSS) + step | Linear + her keyframe için bazı tek-tip easing değerleri |
| Mask sources | luminance / alpha / R / G / B (+ invert, multiply/stencil) | mask node'ları image kanalına göre |
| Effects only theirs | 17 (edge-detect, fluid, ink, slice, smear, voxel, plotter, magnify-lens, particle-grid, displacement-map, directional-blur, circuit-bent, fluted-glass, pixel-trail, gradient-source, text, custom-shader…) | — |
| Effects only ours | 7 (depth-of-field, gradient-map, halation, led-screen, modulation, star-glow, vhs) | — |
| Custom shaders | `custom-shader` layer: kullanıcı GLSL/TSL yazıp pipeline'a ekliyor | Yok |
| Export | WebCodecs `VideoEncoder` + `mp4-muxer`/`webm-muxer`; preset'li quality/aspect | FFmpeg sidecar via Rust/Tauri |
| Dithering | 4 pattern (bayer-2/4/8 + noise) | 27 algoritma + tam palette sistemi + error-diffusion ✅ önde |
| Project file | Versioned JSON; Zustand store snapshot | Versioned JSON; merkezi state store |

**Stratejik karar (önceliklendirme öncesi okunmalı):** TSL/WebGPU'ya tam göç
yapmıyoruz. Tauri WebView'ında WebGPU desteği henüz tutarsız ve mevcut node
graph paradigmamız (layer stack yerine DAG) zaten farklı bir tasarım. Bu
plandaki ports renderer altyapımız WebGL2 GLSL üzerinde kalarak alınacak;
sadece konseptler ve algoritmalar taşınıyor.

---

## 1. F9 — Renderer altyapı (ping-pong + mip + HDR)

Bloom ring artifact'i, blur perf sorunu, glow türevleri (DoF, halation) — hepsi
aynı altyapı eksikliğine bağlı: tek-pass shader + LDR canvas. Bu faz, motoru
multi-pass etkin renderer haline getirir.

| PR | Kapsam | Notlar |
|---|---|---|
| F9.0 | `gpu-effects.js`'e ping-pong FBO altyapısı (`createFramebuffer`, swap A/B) | Mevcut tek-pass `applyShaderPass` üstüne, opt-in `applyShaderChain(passes)` ekle |
| F9.1 | Mip pyramid downsample/upsample helper (RGBA8 önce; HDR sonra) | `gl.generateMipmap` + manuel level FBO'ları |
| F9.2 | Bloom multi-pass (threshold → downsample N kez → upsample bilinear → add back) | Single-pass disk shader'ı fallback olarak kalsın |
| F9.3 | Halation aynı multi-pass altyapısı üzerine taşınsın | Tint hâlâ luma-only sample'lar üstünde uygulanır |
| F9.4 | Glare / star-glow streaks: directional downsample chain | Streak iterasyonları mip seviyelerine bindirilir |
| F9.5 | Blur node (Gauss): separable two-pass (H, V) — F9.0 altyapısı kullanır | Mevcut CPU box blur'a göre 5-10× hızlanma |
| F9.6 | HDR RT desteği (RGBA16F) — opsiyonel, capability detect ile | Saturate'i geciktirmek, bloom highlight korumak için |

Kabul kriterleri: bloom artifact'siz çıkar, blur node 1080p'de < 8ms/frame,
DoF / halation tek pass yerine multi-pass'ten faydalanır.

---

## 2. F10 — Effect ports (kolaydan zora)

| PR | Effect | Kaynak (Shader Lab) | Notlar |
|---|---|---|---|
| F10.1 | `edge-detect` | `edge-detect-pass.ts` | Sobel / DoG; CPU/GPU pair |
| F10.2 | `directional-blur` | `directional-blur-pass.ts` | F9.5 sonrası yön + uzunluk param'ı |
| F10.3 | `smear` | `smear-pass.ts` | Trail benzeri; geçmiş frame buffer şart |
| F10.4 | `displacement-map` | `displacement-map-pass.ts` | Bizdeki `displace` node'unu zenginleştir (xy ayrı strength, channel select) |
| F10.5 | `slice` | `slice-pass.ts` | Yatay/dikey rastgele kaydırma; klasik glitch |
| F10.6 | `ink` | `ink-pass.ts` | Adaptive threshold + dilation; mürekkep efekti |
| F10.7 | `plotter` | `plotter-pass.ts` | Çizgi-temelli render; saturasyon zayıf alanlarda boş bırakır |
| F10.8 | `magnify-lens` | `magnify-lens-pass.ts` | Lens distortion + zoom region; bizim lens-distort üstüne genişletilebilir |
| F10.9 | `circuit-bent` | `circuit-bent-pass.ts` | Yarı rastgele renk swap + glitch; analog'un kuzeni |
| F10.10 | `pixel-trail` | `pixel-trail-pass.ts` | Smear ile aynı geçmiş buffer altyapısı |
| F10.11 | `voxel` | `voxel-pass.ts` | Quantize edilmiş 3D blok görünümü (heavy; opsiyonel) |
| F10.12 | `particle-grid` | `particle-grid-pass.ts` | Cell merkezleri parçacık konumları (depth gerekirse) |
| F10.13 | `text` (source layer) | `text-pass.ts` | Canvas2D ile yazı texture'ı; mesh-gradient gibi source |

Halftone enrichment ayrıca:

| PR | Kapsam | Notlar |
|---|---|---|
| F10.14 | `halftone` → `dotMin`, `softness` (AA), `contrast`, custom 4-color palette, subtractive/overprint CMYK toggle | Mevcut shader üstüne |

---

## 3. F11 — Timeline & easing parity

Onların animasyon hissi bizden daha "filmsel"; çünkü per-keyframe bezier
easing ve `step` (hold) seçeneği var. Mevcut sistemimizde easing alan var ama
preset/UI eksik.

| PR | Kapsam | Notlar |
|---|---|---|
| F11.1 | `KeyframeEasing` schema: `{ type: "bezier"; controlPoints: [x1,y1,x2,y2] }` veya `{ type: "step" }` | Eski `interpolation` string'i migrate (`linear → bezier [0,0,1,1]` vs.) |
| F11.2 | 18 preset (Linear, Smooth, Quick Out, Anticipate, Back In/Out, …) inspector dropdown'ı | `EASING_PRESETS` adapt edilir |
| F11.3 | Inspector'da per-keyframe easing düzenleyici (mini bezier curve picker) | F5.1'deki curve primitive yeniden kullanılabilir |
| F11.4 | Color value tweening (hex'i RGB'e çevirip lerp; vec2/vec3 component-wise) | `evaluateTrack` zaten parça parça çalışıyor, eksik branch'ları ekle |
| F11.5 | Property bindings: `visible`, `opacity`, `hue`, `saturation` per-layer animatable | Mesh-gradient stops dahil; F8.4 timeline ayrımı sürdürülür |
| F11.6 | Timeline clipboard: keyframe copy/paste (relative time preservation) | Multi-select keyframe operations |

---

## 4. F12 — Layer / composite system parity

Onların layer modeli bizim node graph'tan farklı (linear stack), ama bazı
konseptler graph'a uyarlanabilir:

| PR | Kapsam | Notlar |
|---|---|---|
| F12.1 | 16 blend mode katalogu (normal, multiply, screen, overlay, darken, lighten, color-dodge/burn, hard/soft-light, difference, exclusion, hue, saturation, color, luminosity) | `mix` node'unda + `viewer-output` üstünde blend selector |
| F12.2 | Mask config: source (luma/alpha/R/G/B), mode (multiply/stencil), invert | `mask-apply` node'una zenginleştirme |
| F12.3 | Layer compositeMode "filter" vs "mask" semantiği | Group node parite (F6.4 olarak ayrıca; bkz. node_gelisme.md) |
| F12.4 | Scene-wide post-process: master color curves (R/G/B + master) + clamp gamma + opsiyonel color map LUT | `viewer-output`'tan önce uygulanan global node |

---

## 5. F13 — Export pipeline (WebCodecs alternatifi)

Mevcut FFmpeg sidecar'ı kalır (gerçek codec desteği güçlü); ancak WebCodecs
yolu hızlı preview-quality export için cazip. İkili strateji önerilir:

| PR | Kapsam | Notlar |
|---|---|---|
| F13.1 | Export quality preset'leri: draft 1280, standard 1920, high 3840, ultra 7680 long-edge | UI dropdown + Tauri sidecar args |
| F13.2 | Aspect preset'leri: 16:9, 1:1, 4:5, 9:16, original | Crop math `composition.ts` örnek alınır |
| F13.3 | Still image export PNG/JPG quality slider | Mevcut snapshot path'i polish |
| F13.4 | (Opsiyonel) WebCodecs preview-export hattı (mp4/webm), fallback FFmpeg | F8.5 worker entegrasyonu ile uyumlu |
| F13.5 | Export progress UI parity: phase ("preparing", "encoding"), ETA, cancel | Mevcut export sheet üstüne |

---

## 6. F14 — Stretch (custom-shader + procedural sources + fluid)

| PR | Kapsam | Notlar |
|---|---|---|
| F14.1 | `custom-shader` node type: kullanıcı GLSL fragment'ı yapıştırır, uniform UI auto-generated | `parameter-schema.ts` paterni; safety: compile error inline gösterimi |
| F14.2 | `gradient` procedural source (mesh-gradient'in yanı sıra linear/radial/conic) | Üç ayrı shader |
| F14.3 | Fluid simulation source (`fluid-pass.ts` veya benzeri stable-fluid impl) | Heavy; opsiyonel |
| F14.4 | Audio-reactive parametre bindings | shader-lab'ın audio store/patches'ten ilham; param'a "audio amplitude" / "audio band" source ekle |

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

1. **F9 önce** — Bloom ring fix, blur perf, glow türevleri hep aynı altyapı
   eksikliğinden. Multi-pass FBO altyapısını yazdığımızda 5+ effect aynı anda
   düzelir.
2. **F10 sonra** — F9'un üstüne effect port'ları (yeni efektler ekstra
   altyapıyı zaten F9'da hazırlamış olacağız).
3. **F11 paralel** — Timeline parity F9/F10'a paralel ilerletilebilir; UI work
   ayrı dosyalarda, çakışma riski düşük.
4. **F12** — Blend modes + mask polish; graph editor üzerinde küçük PR'lar.
5. **F13** — Export polish.
6. **F14** — Stretch / araştırma fazı; product mature olunca.

Tahmin: F9 ≈ 2-3 hafta, F10 ≈ 3-4 hafta (effect başına ortalama 1-2 gün),
F11 ≈ 1 hafta, F12 ≈ 1 hafta, F13 ≈ 1 hafta, F14 ≈ açık uçlu. Total ≈ 8-10
hafta tek dev.

---

## 9. Açık kararlar (kullanıcı tarafında)

* **WebCodecs hattı kurulsun mu**, yoksa FFmpeg sidecar tek hat mı kalsın? (web
  preview yoksa WebCodecs gereksiz.)
* **Custom-shader node** kullanıcı API'sine girer mi? (advanced; ileri tarihe
  bırakılabilir.)
* **Fluid simulation** ihtiyacı var mı? (Effect Lab değiliz; opsiyonel.)
* **HDR (RGBA16F) RT** ne zaman? F9.6 opsiyonel olarak işaretli; bloom'u
  iyileştirmek için 8-bit RT'ler bile yeterli olabilir.
