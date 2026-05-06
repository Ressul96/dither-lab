# Arayüz Geliştirme: Kaliteli ve Performanslı On-Canvas Gizmos

> Durum: 2026-05-06 tarihinde mevcut `src/index.html`, `src/js/ui/stage.js`,
> `src/js/graph.js` ve inspector parametreleri üzerinden yeniden doğrulandı.
> Hedef basit bir overlay değil; stage koordinatlarına sadık, düşük gecikmeli,
> undo/redo ile temiz çalışan ve profesyonel his veren bir gizmo sistemidir.

## 1. Hedef
Gizmo sistemi, kullanıcının seçili node parametrelerini doğrudan Viewer üstünde
manipüle etmesini sağlar. Inspector sayısal doğruluk için kalır; gizmo hızlı,
görsel ve sezgisel ayar için kullanılır.

Kalite hedefleri:

* Drag sırasında görsel tepki akıcı olmalı.
* Stage pan/zoom, fit, split ve side-by-side modlarında koordinat doğru kalmalı.
* Undo/redo tek drag hareketini tek history aksiyonu olarak görmeli.
* Gizmo UI dither preview'i kapatmamalı, okunaklı ama hafif olmalı.
* DOM/SVG yeniden çizimi minimumda tutulmalı.

## 2. Mevcut Stage Gerçeği
Viewer yapısı `src/index.html` içinde `#stage > .stage-canvas` altında kuruludur:

* `#output`: işlenmiş Viewer Output canvas'ı.
* `#outputSplitOverlay`: split / compare overlay canvas'ı.
* `#splitOverlay` ve `#splitDivider`: compare UI katmanları.
* `previewStatusOverlay`, empty/dropzone ve context menu davranışları.

Stage etkileşimleri `src/js/ui/stage.js` içinde toplanmıştır:

* Zoom: `#stage` wheel handler.
* Pan: `.stage-canvas` pointer handler.
* Split divider: `#splitDivider` pointer handler.
* Pixel inspector, context menu ve drag/drop import.

Bu yüzden gizmo sistemi ayrı bir modül olabilir, ama kurulumu `initStage()` içinden
yapılmalıdır. Önerilen dosya:

* `src/js/ui/gizmo-overlay.js`

## 3. Katman Yapısı
Gizmo overlay, `.stage-canvas` içine eklenen tek bir SVG katmanı olmalıdır:

```html
<svg id="gizmoOverlay" class="gizmo-overlay" aria-hidden="true"></svg>
```

Önerilen yer:

* `#outputClip` ve `#splitOverlay` üstünde,
* `#splitDivider` altında veya divider ile aynı z-index seviyesinde ama pointer
  önceliği kontrollü,
* preview toolbar ve context menu davranışlarını kapatmayacak şekilde.

CSS ilkeleri:

```css
.gizmo-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
}

.gizmo-handle {
  pointer-events: auto;
  vector-effect: non-scaling-stroke;
}
```

Handle hit target'ları görsel noktadan daha büyük olmalıdır. Örneğin görünen
daire 7px, invisible hit circle 18px olabilir.

## 4. Koordinat Modeli
Koordinat dönüşümü elle `panX`, `panY`, `zoom` hesaplarına dayanmak yerine mümkün
olduğunca gerçek canvas rect'inden türetilmelidir. CSS transform'lar
`getBoundingClientRect()` sonucuna dahil olduğu için bu yaklaşım fit/pan/zoom
modlarında daha güvenlidir.

```javascript
function clientToSourcePoint(clientX, clientY, outputCanvas) {
  const rect = outputCanvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * outputCanvas.width;
  const y = ((clientY - rect.top) / rect.height) * outputCanvas.height;
  return {
    x: clamp(x, 0, outputCanvas.width),
    y: clamp(y, 0, outputCanvas.height),
    nx: clamp((x / outputCanvas.width) * 100, 0, 100),
    ny: clamp((y / outputCanvas.height) * 100, 0, 100),
  };
}
```

Compare mode notları:

* `processed`: gizmo normal çalışır.
* `split`: gizmo processed canvas koordinatına göre çizilir; split divider drag'i
  aktifken gizmo pointer yakalamamalıdır.
* `side-by-side`: MVP'de gizmo sadece processed panel üstünde aktif olmalı veya
  açıkça disabled gösterilmelidir. İki panelde aynı handle'ı göstermek kafa
  karıştırır.
* `original` / `dither-only` gibi ilerideki modlarda gizmo seçili node'un etkisini
  temsil etmiyorsa gizmo gizlenmelidir.

## 5. Gizmo Registry
Gizmo tanımları `NODE_DEFINITIONS` içine gömülmek yerine ayrı bir registry'de
tutulmalıdır. Böylece UI davranışı graph modelini şişirmez.

Önerilen yapı:

```javascript
const GIZMO_DEFINITIONS = {
  "lens-distort": [
    pointGizmo({ x: "centerX", y: "centerY" })
  ],
  "chromatic-aberration": [
    pointGizmo({ x: "centerX", y: "centerY", when: { mode: "radial" } }),
    vectorGizmo({ angle: "angle", length: "strength", when: { mode: "directional" } })
  ],
  transform: [
    transformBoxGizmo()
  ],
  crop: [
    cropBoxGizmo()
  ],
  halftone: [
    angleGizmo({ angle: "angle", radius: "spacing" })
  ]
};
```

Önemli: Her node'a gizmo yakıştırılmamalıdır. `blur`, `bloom`, `pixelate` gibi
node'larda merkez parametresi yoksa ring gizmo yanıltıcı olur. Sadece gerçek
spatial parametreleri olan node'lara başlanmalıdır.

## 6. İlk Desteklenecek Gizmo'lar

### P1 - Point Gizmo
Kullanım:

* `lens-distort.centerX/centerY`
* `chromatic-aberration.centerX/centerY` yalnızca `mode === "radial"`

Davranış:

* Drag: normalized `%0-100` merkez günceller.
* Shift: yatay/dikey eksene kilitleme.
* Double click: merkeze sıfırla (`50, 50`).

### P1 - Vector / Angle Gizmo
Kullanım:

* `chromatic-aberration.angle/strength` directional modda.
* `halftone.angle`, opsiyonel olarak `spacing`.

Davranış:

* Merkezden çıkan çizgi ve uç handle.
* Drag angle günceller; uzunluk ilgili parametreye map edilir.
* Shift: 15 derece snap.

### P2 - Crop / Transform Box
Kullanım:

* `crop.left/right/top/bottom`
* `transform.left/right/top/bottom`, `translateX/Y`, `rotation`, `x/y`

Davranış:

* Köşe/kenar handle'ları crop değerlerini günceller.
* Box içi drag `translateX/Y` günceller.
* Rotate handle `rotation` günceller.
* Alt/Option drag center-based scale; Shift aspect lock.

Bu gizmo P1'e göre daha risklidir; çünkü crop mode, transform scale ve source
aspect ratio birlikte ele alınmalıdır.

## 7. Performans Tasarımı

Gizmo overlay'in kendisi render pipeline'ı yavaşlatmamalıdır.

Kurallar:

* Overlay tek SVG olarak yaratılır; her pointermove'da `innerHTML` komple
  yenilenmez.
* Handle elementleri mümkün olduğunca reuse edilir, sadece `cx`, `cy`, `d`,
  `transform` gibi attribute'lar güncellenir.
* Pointermove param update'i `requestAnimationFrame` ile coalesce edilir.
* Graph param güncellemesi drag sırasında throttle edilir; preview render queue
  zaten coalesce olsa bile gereksiz dispatch yağmuru yapılmaz.
* Drag başlangıcındaki param snapshot saklanır, drag bitişinde tek undo entry
  yazılır.
* Drag sırasında text label gerekiyorsa DOM text update'i de rAF ile yapılır.
* Overlay kapalıyken hiçbir stage listener pahalı hesap yapmamalıdır.

Frame budget:

* Gizmo hit-test + attribute update hedefi `< 1 ms`.
* Param dispatch + preview invalidation hedefi tek rAF başına en fazla bir kez.
* Ağır node drag'lerinde optional "preview while dragging: auto/full/off" kararı
  ileride eklenebilir.

## 8. Pointer ve History Davranışı

Gizmo drag akışı:

1. `pointerdown`: event hedefi gizmo handle ise stage pan engellenir.
2. `setPointerCapture(pointerId)` çağrılır.
3. Başlangıç node params snapshot alınır.
4. `pointermove`: sadece pending pointer state yazılır; rAF flush param update yapar.
5. `pointerup/cancel`: final params commit edilir, tek history entry yazılır.

Stage çakışma kuralları:

* Split divider aktifken gizmo drag başlamaz.
* Stage pan, gizmo handle üstünde başlamaz.
* Context menu gizmo drag sırasında açılmaz.
* Drag/drop import overlay'i aktifken gizmo gizlenir.
* Pixel inspector açıkken gizmo handle'ları öncelikli; boş alanda pixel inspector
  davranışı korunur.

Undo/redo:

* Drag sırasında history stack'e her frame yazılmaz.
* Başlangıç ve bitiş paramları aynıysa history entry oluşturulmaz.
* Auto-key açıksa timeline param write davranışı ayrıca belirlenmelidir; gizmo
  drag'i inspector slider ile aynı keyframe politikasını izlemelidir.

## 9. Kalite Ayrıntıları

Gizmo'nun pahalı görünmesi için küçük detaylar önemlidir:

* Strokes `vector-effect: non-scaling-stroke` ile zoomdan bağımsız kalmalı.
* Handle boyutu ekran pikseli olarak sabit kalmalı.
* Hover, active ve disabled durumları net olmalı.
* Renkler preview üstünde hem açık hem koyu görüntüde okunmalı; ince stroke yanında
  düşük opaklıklı dış stroke kullanılabilir.
* Cursor doğru olmalı (`grab`, `grabbing`, `nesw-resize`, `crosshair` vb.).
* Numeric tooltip kısa ve canlı olmalı: `X 42.1 / Y 61.4`, `Angle 45°`.
* Keyboard nudge desteklenmeli: ok tuşları 1 birim, Shift+ok 10 birim.
* Accessibility için handle'lar focusable olabilir; ancak MVP'de overlay
  `aria-hidden` bırakılıp inspector sayısal erişilebilir yol olarak korunabilir.

## 10. State ve Kaydetme

Gizmo UI state'i projeye yazılmamalıdır.

Kaydedilen şey yalnızca node parametreleridir:

* `centerX`, `centerY`
* `angle`, `strength`
* `left`, `right`, `top`, `bottom`
* `translateX`, `translateY`, `rotation`, `x`, `y`

Kaydedilmeyen şeyler:

* Hover state
* Active handle id
* Tooltip pozisyonu
* Drag snapshot
* Overlay visibility cache

## 11. Kabul Kriterleri

P1 kabul kriterleri:

1. `lens-distort` seçilince center gizmo doğru konumda görünür.
2. Gizmo drag'i `centerX/centerY` değerlerini günceller ve preview'i değiştirir.
3. Tek drag hareketi undo/redo'da tek aksiyondur.
4. Fit, zoom ve pan modlarında handle görüntüdeki aynı piksele denk gelir.
5. Split divider, stage pan, context menu ve drag/drop import ile çakışmaz.
6. Drag sırasında overlay DOM'u komple rebuild edilmez.

P2 kabul kriterleri:

1. Directional `chromatic-aberration` angle/strength gizmo doğru çalışır.
2. `crop` box gizmo crop parametrelerini doğru yazar.
3. `transform` box/rotate gizmo aspect ratio ve rotation durumlarında kararlı kalır.
4. Side-by-side compare modunda davranış bilinçli şekilde disable veya processed-only olur.

## 12. Önerilen Geliştirme Sırası

1. `stage.js` içine `initGizmoOverlay(stageCanvas, outputCanvas)` kurulum hook'u ekle.
2. `src/js/ui/gizmo-overlay.js` modülünü oluştur.
3. Tek SVG overlay ve element reuse altyapısını kur.
4. `clientToSourcePoint` / `sourceToClientPoint` koordinat helper'larını yaz.
5. `lens-distort` point gizmo MVP'sini ekle.
6. Pointer capture + rAF throttle + tek history entry davranışını tamamla.
7. `chromatic-aberration` point/vector gizmo'larını ekle.
8. Timing/profile overlay ile çakışmayacak z-index ve toolbar toggle kararını ver.
9. `crop` ve `transform` box gizmo'larını ekle.
10. Compare mode, playback quality ve export parity smoke testlerini yaz.
