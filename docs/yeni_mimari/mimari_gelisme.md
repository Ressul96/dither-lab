# Mimari Geliştirme: Web Worker ve OffscreenCanvas Entegrasyonu

> Durum: 2026-05-06 tarihinde kod tabanı üzerinden yeniden doğrulandı.
> Bu belge, render işlemini main thread'den izole etmek için uzun vadeli planı
> anlatır. Canvas'lar ortadan kaldırılmayacak; rollerine göre DOM canvas,
> OffscreenCanvas ve ImageBitmap sınırlarına ayrılacaktır.

## 1. Amaç
Dither Lab'de node graph değerlendirmesi şu an `src/js/source.js` içindeki
render akışından `graph-runtime.js`'e çağrılır. `image-ops.js` CPU tabanlı canvas
işlemlerini, `gpu-effects.js` ise WebGL2 shader pass'lerini yürütür.

Amaç, özellikle yüksek çözünürlükte ve ağır node zincirlerinde UI akıcılığını
korumaktır. Bunun için graph evaluation ayrı bir Dedicated Worker'a taşınabilir;
ancak bu taşıma canvas kullanımını bilinçsizce azaltmak değil, canvas rollerini
net ayırmak anlamına gelir.

## 2. Canvas Rolleri
Canvas bu mimaride gereklidir. Farklı canvas türleri farklı sorumluluk taşır:

* **Kaynak yakalama canvas'ı:** `sourceCanvas`, `<video>` elementindeki o anki
  frame'i sabit piksel buffer'ına kopyalar. Node cache, preview/export paritesi
  ve RGBA okuma için güvenli kaynak budur.
* **Sunum canvas'ları:** `processedCanvas`, `ditherCanvas`, stage/split overlay
  canvas'ları kullanıcıya gösterilen veya export tarafında okunan DOM yüzeyleridir.
  Bunlar main thread'de kalmalıdır.
* **Preview downscale scratch canvas'ı:** `previewSourceCanvas`, canlı playback'te
  düşük çözünürlüklü değerlendirme için kullanılan uzun ömürlü scratch yüzeydir.
  Mevcut preview davranışıyla birlikte ele alınmalıdır.
* **İşlem içi geçici buffer'lar:** `image-ops.js` içindeki `acquireBuffer` /
  `releaseBuffer` pool'u node işlemleri arasında geçici çıktı tutar. Worker
  uyumu için ilk aday bu katmandır.
* **GPU render yüzeyi ve atlaslar:** `gpu-effects.js` WebGL2 render canvas'ı,
  shader çıktısı ve ASCII glyph atlas'ı oluşturur. Bunlar Worker'a taşınmadan
  önce canvas factory üzerinden soyutlanmalıdır.

Sonuç: DOM'da kalması gereken canvas'lar vardır. Worker planı, sunum ve kaynak
yakalama yüzeylerini taşımadan işlem içi buffer'ları izole etmelidir.

## 3. Mevcut Durum

* **Klasör yapısı:** Proje `src/js/` altında flat bir yapıdadır; ayrıca `src/js/gl/`
  klasörü vardır. Yeni düşük seviye yardımcılar `src/js/` ya da `src/js/gl/`
  altında tutulabilir.
* **Buffer pool mevcut:** `src/js/image-ops.js` içinde `acquireBuffer` /
  `releaseBuffer` vardır. Yeni bir pool kurmak yerine bu pool'un canvas yaratımı
  soyutlanmalıdır.
* **Node cache mevcut:** `graph-runtime.js` içinde `nodeCache`, `paramsHash`,
  `inputVersions`, `paramVersions` ve `timeSalt` ile invalide olur.
* **Time-aware node'lar mevcut:** `analog`, `vhs`, `crt` çıktıları playhead
  zamanına bağlıdır. Worker context'i `timeSeconds`, `fps`, `durationSeconds` ve
  `timeline` bilgisini korumalıdır.
* **GPU helper henüz Worker-ready değil:** `gpu-effects.js` içinde doğrudan
  `document.createElement("canvas")` çağrıları vardır. WebGL2 teorik olarak
  `OffscreenCanvas` ile çalışabilir, fakat mevcut kod önce canvas factory'ye
  taşınmalıdır.
* **Render entegrasyonu `source.js` içindedir:** Ayrı bir `preview.js` dosyası yok.
  Worker adapter, `source.js` render döngüsüne veya onun yanında kurulacak küçük
  bir adapter modülüne bağlanmalıdır.

## 4. Önerilen Fazlar

### Faz 0 - Ölçüm ve Feature Flag
Worker hattı doğrudan varsayılan olmamalıdır. Önce mevcut render süresi ölçülmeli
ve deneysel yol bir flag arkasına alınmalıdır.

Öneriler:

* Frame başına JS graph evaluation süresi.
* CPU node süresi ile GPU node süresinin ayrılması.
* Preview ve export render sürelerinin ayrı ölçülmesi.
* `workerRender: "off" | "auto" | "on"` benzeri bir internal flag.

### Faz 1 - Canvas Factory
İlk teknik adım canvas yaratımını tek noktadan yönetmektir.

Önerilen yardımcı:

```javascript
export function createProcessingCanvas(width, height) {
  if (isWorkerScope() && typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
```

Dikkat:

* Bu helper işlem içi buffer'lar içindir; stage/source DOM canvas'larının yerine
  körlemesine kullanılmamalıdır.
* `transferToImageBitmap()` sadece `OffscreenCanvas` için güvenlidir. DOM canvas
  fallback'inde sonuç `ImageBitmap`, canvas veya copied bitmap olarak normalize
  edilmelidir.
* `getContext("2d", { willReadFrequently })` seçenekleri korunmalıdır.

### Faz 2 - `image-ops.js` Pool'unu Taşımak
`acquireBuffer` yeni factory'yi kullanmalı; pool hem DOM canvas hem OffscreenCanvas
döndürebilecek şekilde canvas-like davranışa odaklanmalıdır.

Kontrol edilmesi gerekenler:

* `drawImage` kaynak/çıktı tipleri.
* `getImageData` / `putImageData` desteği.
* `releaseBuffer` içinde OffscreenCanvas temizliği.
* Cached output'ların pool'a yanlış iade edilmemesi.

### Faz 3 - `gpu-effects.js` Uyumluluğu
`gpu-effects.js` şu an DOM'a bağlıdır. Worker uyumu için:

* Renderer canvas'ı factory üzerinden oluşturulmalı.
* Shader output canvas'ı factory üzerinden oluşturulmalı.
* ASCII atlas üretimi DOM font davranışına bağlı olduğu için ayrıca test edilmeli.
* WebGL2 yoksa mevcut pass-through fallback korunmalı.

ASCII özel riski: Worker içinde font availability ve text rasterization her
platformda aynı sonucu vermeyebilir. ASCII node için fallback veya atlas cache
stratejisi ayrı doğrulanmalıdır.

### Faz 4 - Worker Adapter
Worker doğrudan global state'e erişmemelidir. Main thread yalnızca serileştirilebilir
graph snapshot, timeline context ve source bitmap göndermelidir.

Gerekli davranışlar:

* Her request için `requestId`.
* Stale frame discard: daha yeni render geldiyse eski Worker sonucu commit edilmemeli.
* Backpressure: Worker meşgulse her animation frame'de yeni iş kuyruğu şişmemeli.
* Cache clear mesajı: kaynak değişimi, graph reset, proje yükleme.
* Hata durumunda main-thread render fallback.

Mevcut native preview hattındaki `renderVersion` / source token kontrolü bu adapter
için iyi bir örnektir.

### Faz 5 - Preview / Export Ayrımı
Preview worker hattı ile export worker hattı aynı öncelikte değildir.

* Preview düşük gecikme ve stale discard ister.
* Export deterministik, frame frame tamamlanan ve iptal edilebilir bir iş ister.
* Export sırasında `sourceCanvas` tam çözünürlükte kalmalı; playback downscale
  path'i export'a sızmamalıdır.

Bu yüzden ilk MVP sadece preview evaluation için denenebilir. Export'a taşımadan
önce preview/export parity testleri yazılmalıdır.

## 5. MVP Kabul Kriterleri

1. Worker kapalıyken mevcut davranış değişmemeli.
2. Worker açıkken basit zincir (`Source -> Adjust -> Dither -> Viewer`) aynı frame
   için main-thread çıktısıyla eşleşmeli.
3. `analog`, `vhs`, `crt` gibi time-aware node'lar playhead zamanıyla doğru
   invalidate olmalı.
4. Worker sonucu stale kaldığında ekrana commit edilmemeli.
5. WebGL2 veya OffscreenCanvas desteklenmiyorsa main-thread fallback sorunsuz çalışmalı.

## 6. Açık Kararlar

* Canvas factory `src/js/canvas.js` içinde mi, `src/js/gl/` altında mı duracak?
* Worker sadece preview için mi başlayacak, yoksa export için ikinci bir worker
  hattı mı kurulacak?
* ASCII atlas Worker içinde mi üretilecek, yoksa main thread'de üretilip bitmap
  olarak mı aktarılacak?
* Source capture main thread'de `sourceCanvas` üzerinden mi kalacak, yoksa bazı
  durumlarda doğrudan `createImageBitmap(videoElement)` kullanılacak mı?
* Native render track ile Worker render track aynı UI durum göstergesini mi
  paylaşacak?
