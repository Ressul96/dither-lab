# Player + Animation Timeline Reformu

> **Vizyon:** Bu artık bir "video player" değil. Video editing / motion design
> programlarındaki (After Effects, Cavalry, Premiere, SVGator) **frame-bazlı
> timeline** mantığını hedefliyoruz. İleride aynı bileşen üzerinden **curve
> editor (graph mode)** açılacak; yani mimari şimdiden bu genişlemeye uygun
> olacak şekilde kurulmalı.

Referans davranışlar:

* Timeline cetveli **frame numaralı**; FPS değiştikçe tick yoğunluğu değişir.
* Playhead **frame'e snap** olur. Ok tuşları 1 frame, Shift+ok 10 frame ilerletir.
* Keyframe'ler frame'e snap'li sürüklenir; multi-select ve marquee selection
  vardır.
* "Layers" görünümü (default) ve "Graph" görünümü (curve editor) arasında
  toggle yapılır — ikisi de aynı keyframe verisi üzerinde çalışır.
* Trim/scrubber/loop gibi klasik video player kontrolleri **ana hiyerarşide
  yer almaz**; varsa kebap menüsünde sekonder eylem olur.

---

## 1. Mevcut Yapı Neden Yetersiz

* `#playerCard` üç yatay row halinde: scrubber + animation-timeline +
  transport. Tasarım dili **video player**: trim handle'ları, scrubber bar,
  in/out kolları.
* `formatTime` `HH:MM:SS` + `F123` frame readout — frame ikincil bilgi.
* Animation timeline tracks listesi tek dock içinde; properties listesi
  ayrı bir kolon olarak yaşamıyor.
* Curve / graph editor için yer yok; keyframe edit'i sadece easing dropdown
  + value input ile yapılıyor. Bezier tangent handle'ları yok.
* `playback.currentTime` saniye, `timeline` zaten FPS-aware ama UI bunu
  ön plana çıkarmıyor.

---

## 2. Hedef Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ◀◀  ◀  ▶  ▶  ▶▶    ↻ Loop    ● Auto-Key    Dur [240] f      0024 / 0240 │ ← Top transport (frame)
├──────────────────────────┬──────────────────────────────────────────────┤
│ PROPERTIES       Layers│Graph                                           │ ← View mode toggle
│                          │  0    30    60    90   120   150   180  210 │ ← Frame ruler (FPS-aware)
│ ● Opacity     ◀ aktif    │       ┃                                       │
│   100              ▾     │  ◆────┃────◆────────◆                         │ ← Lane (layers mode)
│ ● Hue                    │       ┃                                       │
│   0                ▾     │       ┃                                       │
│ ● Saturation             │       ┃                                       │
│ ● Cell Size              │       ┃ Empty: select a property              │
│ ● Aspect Ratio           │       ┃                                       │
└──────────────────────────┴──────────────────────────────────────────────┘
```

İki kolonlu ana gövde + üstte tek satır transport. Glassmorphism / blur yok.
Düz yüzeyler, mevcut palette (`--bg-input`, `--border-subtle`, `--accent`,
`--family-*`).

### 2.1 Top Transport Bar

Soldan sağa:

| Konum | Eleman | Davranış |
|------|--------|----------|
| 1 | **◀◀ First frame** | playhead → 0 |
| 2 | **◀ Prev frame** | playhead -1 frame |
| 3 | **▶/⏸ Play** | togglePlay |
| 4 | **▶ Next frame** | playhead +1 frame |
| 5 | **▶▶ Last frame** | playhead → duration*fps |
| 6 | **↻ Loop** | `playback.loopEnabled` toggle |
| 7 | **● Auto-Key** | `timeline.autokey` toggle (pill, durum noktası ile) |
| 8 | **Dur [N] f** | duration input. Birim toggle: `f` (frame) / `s` (sec). State'te saniye tutulur, görünüm seçilebilir. |
| 9 | **`0024 / 0240`** | mevcut frame / total frame readout. Tabular sayı. |
| 10 | **▾ Kebap** | trim, snap, reset, FPS override gibi sekonder eylemler. |

**Estetik kuralları:**

* Frame stepping (◀◀ ◀ ▶ ▶ ▶▶) tek bir grup, butonlar aynı boyutta (28×28).
* Play butonu vurgulu (accent zemin, küçük büyütme — 32×32).
* Auto-Key ve Loop pill formunda, durum rengi içlerinde nokta.
* Time readout monospace (`tabular-nums`), frame numarası 4 hane padded.

### 2.2 Properties Panel (sol)

* Üstte küçük "PROPERTIES" başlığı.
* Her satır bir property kartı:
  * Sol başta **renkli daire** — kategori rengi (`--family-color`,
    `--family-process`, vb. mevcut paletten).
  * Property adı (örn. "Opacity").
  * Anlık değer (italic / muted; örn. "100").
  * Sağda chevron — keyframe panel açılır.
* Aktif/seçili kart **farklı arka plan** + sol kenarda hafif accent.
* Tıklama → o property'nin keyframe lane'i sağda çizilir.

**Çoklu property görünüm modu:** Şimdilik tek-property modu hedef.
Sonradan "tüm property'leri lane lane göster" modu eklenebilir (After Effects
default davranışı), ama curve editor uyarlaması açısından tek-seçili-property
ile başlamak daha temiz.

### 2.3 Timeline Pane (sağ)

**Üst şerit:** view mode toggle — `Layers` / `Graph`. (Şimdilik sadece
`Layers` çalışıyor, `Graph` placeholder.)

**Frame ruler:** FPS'e göre tick'ler:

* Major tick: her saniye (FPS=30 → 0, 30, 60, ...). Etiket frame numarası.
* Minor tick: her 5 veya 10 frame (zoom seviyesine göre).
* Cetvel zoom'lanabilir (fare tekerleği; ileride pinch).

**Playhead:**

* Beyaz dikey çizgi (1px).
* Üstünde küçük beyaz kare tutamak (drag-able).
* **Snap-to-frame**: pointermove sırasında değer en yakın frame'e yuvarlanır.

**Lane (Layers mode):**

* Tek satır, seçili property için.
* Keyframe'ler diamond (mevcut `.animation-keyframe` reused).
* Diamond drag = frame snap'li time değiştirme.
* Click = select. Shift+click = multi-select. Drag empty = marquee.
* Selected diamond accent renkte.

**Lane (Graph mode — Faz 4):**

* Y ekseni: property değeri. Auto-fit (min/max keyframe değerine göre) veya
  manuel range.
* X ekseni: frame.
* Keyframe'ler: nokta + iki Bezier tangent handle.
* Tangent handle drag → easing eğrisi düzenlenir.
* Multi-curve overlay (ileride): birden fazla property aynı grafikte (renk
  noktasıyla ayrılır).

---

## 3. Frame-Based Interaction Sözleşmesi

* **State birimi**: `playback.currentTime` saniye olarak kalır (mevcut
  davranış). Render katmanı `timeSeconds → frame` dönüşümünü her yerde
  yapar: `frame = round(timeSeconds * fps)`.
* **Snap**: `snapToFrame(timeSeconds, fps) = round(t*fps) / fps`. Tüm
  keyframe sürüklemeleri ve playhead drag'leri bu fonksiyondan geçer.
* **FPS değişimi**: timeline cetveli ve readout bir frame değiştiğinde
  zaten otomatik güncellenir. Var olan keyframe time'ları saniye olduğu için
  yeni FPS'te yeniden snap'lenmez (sanatçı kararı).
* **Keyboard**:
  * `←` / `→` — 1 frame
  * `Shift+←` / `Shift+→` — 10 frame
  * `Home` / `End` — ilk / son frame
  * `Space` — play/pause (mevcut)
  * `Delete` — seçili keyframe'leri sil
  * `Cmd/Ctrl+D` — duplicate seçili keyframe(ler)

---

## 4. State Genişlemeleri (`state.js`)

```javascript
timeline: {
  version: 1,
  duration: 0,
  fps: 30,
  loop: true,
  autokey: false,
  tracks: [],
  // Yeni:
  viewMode: "layers",        // "layers" | "graph"
  durationUnit: "frame",     // "frame" | "second" — sadece UI
  zoom: 1,                   // ruler zoom level
  selectedPropertyId: null,  // sol panelde aktif property
  selectedKeyframes: [],     // multi-select keyframe id listesi
}
```

`playback` ve `tracks` mevcut yapıyı korur. `timeline-adapter.js` ve
`timeline.js` zaten frame'e duyarlı; UI tarafında snap helper'ı ortak modüle
çıkar (`src/js/ui/timeline-frame.js` gibi).

---

## 5. Faz Planı

| Faz | Kapsam | Teslim |
|----|--------|--------|
| **1 — Layout sökümü** | `#playerCard` DOM'u sıfırdan yazılır. Top transport bar, properties panel, timeline pane (layers mode). Frame stepping butonları, frame readout, snap-to-frame playhead drag. Trim/scrubber kaldırılır. | Görsel olarak yeni; eski animation-timeline işlevleri (lane render, keyframe drag, easing seçimi) korunur. |
| **2 — Frame interaction** | Klavye kısayolları (frame stepping, delete, duplicate). Marquee selection, multi-select keyframes. Snap helper'ı ortak modüle çıkar. | Tam frame-bazlı edit deneyimi. |
| **3 — Properties panel zenginleşmesi** | Property card'lara anlık değer + chevron + ekspand. Tek-property görünüm modu netleşir; ileride çoklu lane için altyapı. View mode toggle UI'ı (henüz `Graph` placeholder). | Properties panel motion design tarzında çalışır. |
| **4 — Curve editor (Graph mode)** | Lane render'ı bezier eğri olarak çizilir. Tangent handle'lar drag-edilebilir. Y ekseni auto-fit. | Graph editor canlı. |
| **5 — İleri özellikler** | Zoom (fare tekerleği), work area (render range), curve preset'ler (ease-in-out-cubic vb.), multi-curve overlay. | Polish. |

---

## 6. Geçici Skin Hakkında Not

`main.css` içinde `body.timeline-overlay-skin` altında **geçici** bir
glassmorphism skin'i şu an default açık. Faz 1 başladığında:

* `main.js` içindeki flag init silinir.
* `main.css` içindeki `body.timeline-overlay-skin` blokları silinir.
* Yeni layout doğrudan `.player-card` (veya yeni `#timeline-shell`) üzerine
  yazılır.

Eski legacy görünüm de hedef değil; bu reform öncesinde sadece "az daha
toparlı görünsün" için bırakıldı.

---

## 7. Kararlar (2026-05-05)

### 7.1 Duration unit: **frame**
Üst bar'daki readout `0024 / 0240` formatında, default; saniye gösterimi
opsiyonel kebap toggle'ı olarak kalsın.

### 7.2 Layers görünümü: **çoklu lane, default kapalı**
Tüm property'ler properties panelinde listelenir, ama her satırın **lane'i
default kapalı (collapsed)**. Lane sağ tarafta yer kaplamaz; satır sadece
"property card" olarak görünür.

Lane açma yolları:

* Properties panelinde satırın **chevron**'una tıklamak.
* Inspector'da o parametreyi değiştirmek **otomatik** olarak ilgili lane'i
  açar (autokey aktifken zaten yeni keyframe yazılır; lane açık olmalı ki
  kullanıcı keyframe'i görsün).

Aktif (seçili) property card'ı + açılmış lane'i farklı arka plana sahip.
Birden fazla lane açık olabilir.

### 7.3 Render range
Eski trim in/out artık **work area / render range** olarak kebap menüsünde
yaşar. Üst transport bar'da yer almaz. State alanları (`playback.trimStart`,
`trimEnd`) korunur, isimlendirmesi `renderRangeStart` / `renderRangeEnd`
olarak yenilenir (geriye dönük uyum için adapter'da iki ada da yanıt verilir).

### 7.4 FPS modeli: source FPS = ground truth, output FPS = encode hedefi

**Bu kararın etki alanı geniş — sadece player değil, tüm pipeline.**

Mevcut state alanları:

* `source.sourceFps` — orijinal video FPS (donar)
* `source.fps` — şu an dolaylı olarak playback rate manipülasyonu için
  kullanılıyor; bu yaklaşım **kalkar**, alanın kendisi `sourceFps`'in
  alias'ı haline gelir veya silinir
* `timeline.fps` — şu an ayrı tutuluyor; **artık `source.sourceFps`'e
  pin'lenir** (otomatik), kullanıcı düzenleyemez
* `viewer-output.params.fps` — anlamı değişiyor (aşağıda)

Yeni model:

```
[source video @ sourceFps] ──► node graph (her zaman sourceFps'te
                                hesaplanır, keyframe'ler sourceFps frame
                                numaralarına snap'lenir)
                              ──► viewer-output (sourceFps preview;
                                   opsiyonel frame-skip simülasyon)
                              ──► export ──► output FPS düşürme
                                              (frame skip / blend)
```

Yani **timeline cetveli + keyframe drag + playhead drag → source FPS'in
frame'lerine snap olur**. Output node'da FPS düşürmek timeline'daki
keyframe'leri etkilemez; sadece export sırasında (veya istenirse preview
sırasında output FPS simülasyon modu olarak) frame atlama uygulanır.

**Source yokken** (procedural / pure-keyframe): kullanıcı tek bir global
"timeline FPS" girer (örn 30 veya 60). Source yüklendiğinde otomatik onun
sourceFps'ine geçer ve keyframe'ler saniye cinsinden zaten saklandığı için
yeni FPS'in frame'lerine yeniden hizalanır (re-snap görsel olarak).
Keyframe time'ları **saniye olarak donmuş kalır**, sadece görsel snap
güncellenir; bu kullanıcının istediği "FPS oynamak son çıktıyı etkilesin,
animasyonu bozmasın" davranışını verir.

#### 7.4.1 Playback Speed (slow / fast motion)

FPS ve hız **bağımsız iki kavram** olarak ayrılır:

* `playback.speed` — yeni state alanı. Default `1.0`. Range `0.1` – `4.0`.
* Transport bar'ın **kebap menüsünde** "Speed: 0.25x / 0.5x / 1x / 2x / 4x"
  toggle'ı (veya doğrudan input). Pop-up ile inceltilmiş varyant.
* `<video>.playbackRate = playback.speed` (sourceFps ↔ targetFps oranı
  yerine).
* Timeline FPS, keyframe snap'i ve `viewer-output.fps` ile **alakasız**;
  yalnızca preview oynatma temposu üzerine etki eder.

#### 7.4.2 viewer-output.fps semantiği

* **Export'ta**: hedef FPS. Kaynaktan düşükse encoder frame skip / blend
  uygular. Mevcut davranış (`export.js fpsMode === "custom"`) bunu zaten
  yapıyor; değişmez.
* **Preview'de**: default olarak görmezden gelinir (preview daima
  sourceFps'te koşar). İleride bir toggle ile "preview frame-skip
  simülasyon" açılabilir; bu Faz 5 scope'unda.

### 7.5 Curve editor tangent modeli: **After Effects**

Her keyframe'in iki tangent'ı vardır:

* **In tangent** — önceki keyframe'e doğru olan eğri ucu (eğrinin bu
  keyframe'e nasıl girdiğini belirler).
* **Out tangent** — sonraki keyframe'e doğru olan eğri ucu (eğrinin bu
  keyframe'den nasıl çıktığını belirler).

Tangent'lar Bezier kontrol noktalarıdır; her birinin **açısı** ve
**uzunluğu** drag ile düzenlenir. İki tangent bağımsız çalışır → asimetrik
eğri yapılabilir (yumuşak giriş + sert çıkış vb.).

#### Veri modeli

Mevcut keyframe modeli:

```javascript
{ id, time, value, easing }   // easing: "linear" | "ease-in" | ...
```

Yeni model (Faz 4):

```javascript
{
  id,
  time,
  value,
  // Tangentler keyframe-yerel (relative) koordinatta:
  //  - inTangent / outTangent: { dt, dv }
  //  - dt: zaman ofseti (saniye, negatif = geri, pozitif = ileri)
  //  - dv: değer ofseti (property birimi cinsinden)
  //  - null = "auto" (otomatik smooth tangent — komşu keyframe'lere göre
  //    hesaplanır, kullanıcı dokunmadıkça)
  inTangent: { dt: -0.2, dv: 0 } | null,
  outTangent: { dt: 0.2, dv: 0 } | null,
  // İleride: lineer/bezier mod toggle, hold mode
  interpolation: "bezier" | "linear" | "hold",
}
```

Eski `easing: "linear"` / `"ease-in"` / `"ease-out"` / `"ease-in-out"` /
`"hold"` değerleri Faz 4 sırasında bu modele migrate edilir:

* `linear` → `interpolation: "linear"`
* `hold` → `interpolation: "hold"`
* `ease-in` / `ease-out` / `ease-in-out` → `interpolation: "bezier"` +
  uygun tangent ön ayarları (örn 30%/0% / 0%/30% / 30%/30% Bezier).

#### UI

* **Layers mode**: tangent'lar görünmez. Sadece keyframe diamond.
* **Graph mode**: keyframe noktası + iki Bezier handle çizgisi.
  * Handle ucu drag → tangent açısı + uzunluğu.
  * Shift+drag → sadece zaman (dt) sabit, değer (dv) değişir → asimetrik
    edit kolaylığı.
  * Cmd/Ctrl+click handle → "auto smooth" moduna geri dön (`null` set).
* **Inspector keyframe paneli** (mevcut animation-keyframe-panel
  kullanılıyor): `easing` dropdown'u kalır ama "Custom Bezier" seçeneği
  eklenir; bu seçildiğinde 4 sayı input'u (in.dt, in.dv, out.dt, out.dv)
  görünür ve graph editor'da düzenlemek için CTA eklenir.

#### Faz katkısı
Faz 1-3'te mevcut `easing` dropdown'u korunur. Faz 4'te tangent veri
modeli + Graph mode UI birlikte eklenir. Migration script bir kerelik
çalışıp eski `easing` alanlarını yeni interpolation+tangent yapısına
dönüştürür.

---

Faz 1, yukarıdaki §7.1 - §7.4 kararlarıyla başlanabilir. §7.5 (After Effects
tangent modeli) yalnızca Faz 4'te belirleyici; oraya kadar mevcut easing
dropdown'ı korunur.
