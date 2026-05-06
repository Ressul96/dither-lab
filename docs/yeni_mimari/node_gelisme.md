# Düğüm Geliştirme: Çoklu Seçim, Group Nodes ve Profiling

> Durum: 2026-05-06 tarihinde mevcut `graph.js`, `graph-runtime.js`,
> `state.js` ve `ui/graph-shell.js` yapısı üzerinden yeniden doğrulandı.
> Bu belge, node editor'ın karmaşık graph'ları yönetebilmesi için üç ana hedefi
> tanımlar: çoklu seçim, group/macro node'lar ve node bazlı gecikme göstergesi.

## 1. Hedefler

Bu geliştirme tek bir "group node" işinden ibaret değildir. Kullanıcının graph
üzerinde profesyonelce çalışabilmesi için şu üç davranış birlikte tasarlanmalıdır:

1. **Çoklu seçim:** Birden fazla node ve edge seçilebilmeli.
2. **Node gruplama:** Seçili node'lar tek bir group/macro altında toplanabilmeli.
3. **Node latency göstergesi:** Her node'un son değerlendirmede ne kadar süre
   harcadığı graph üstünde görülebilmeli.

Bu üç başlık birbirini besler. Çoklu seçim olmadan ergonomik group oluşturmak
zordur; latency göstergesi olmadan da büyük graph'larda hangi grubun veya node'un
preview'i yavaşlattığı anlaşılmaz.

## 2. Mevcut Durum

* Graph modeli şu an flat `nodes` ve `edges` listesi tutar.
* State içinde sadece `selectedNodeId` vardır; çoklu seçim modeli yoktur.
* Graph editor render kodu `src/js/ui/graph-shell.js` içindedir; ayrı
  `node-editor.js` dosyası yoktur.
* `serializeGraph` şu an `parentId`, `selectedNodeIds`, group metadata veya
  profiling verisi saklamaz.
* `graph-runtime.js` flat graph üzerinde topological sort yapar ve node output
  cache'i kullanır.

Bu nedenle group özelliği doğrudan runtime'a gömülmeden önce selection ve
serialization modeli güncellenmelidir.

## 3. Faz 1 - Çoklu Seçim

Önce graph state şu yapıya genişletilmelidir:

```javascript
graph: {
  nodes: [],
  edges: [],
  selectedNodeId: null,      // geriye uyumluluk / inspector primary selection
  selectedNodeIds: [],       // çoklu seçim
  selectedEdgeIds: [],
  activeParentId: "root"
}
```

Davranışlar:

* Click: tek node seçer, `selectedNodeId` primary selection olur.
* Shift/Cmd click: seçime node ekler veya çıkarır.
* Marquee selection: bir rectangle içinde kalan node'ları seçer.
* Drag: çoklu seçim varsa seçili node'ların tamamını birlikte taşır.
* Delete: seçili node ve edge'leri siler; `source` ve `viewer-output` korunur.
* Inspector: primary selection tek node ise mevcut inspector çalışır; çoklu seçim
  varsa toplu aksiyon paneli gösterilir.

Kabul kriterleri:

* En az iki node seçilip birlikte taşınabilir.
* Seçili node'lar delete ile tek aksiyonda silinebilir.
* Undo/redo çoklu seçimle yapılan taşıma ve silme işlemlerini geri alabilir.

## 4. Faz 2 - Macro Preset Olarak Basit Gruplama

Gerçek nested runtime'a geçmeden önce düşük riskli bir ara adım önerilir:
seçili node zinciri "macro preset" olarak kaydedilir ve daha sonra graph'a tekrar
eklenebilir.

Bu MVP gerçek group boundary çözmez; amacı kullanıcıya hızlı tekrar kullanılabilir
efekt blokları vermektir.

Kapsam:

* Seçili node ve aralarındaki internal edge'ler serialize edilir.
* Source/viewer gibi global node'lar preset'e alınmaz.
* Preset graph'a eklendiğinde yeni node id'leri üretilir.
* Dış bağlantılar otomatik çözülmez; kullanıcı preset bloğunu elle bağlar.

Bu faz, gerçek group node'a gitmeden önce selection, serialization ve paste/insert
akışlarını test eder.

## 5. Faz 3 - Gerçek Group Node

Gerçek group node için veri modeline `parentId` ve group metadata eklenmelidir:

```javascript
nodes: [
  { id: "adjust-1", type: "adjust", parentId: "root" },
  {
    id: "group-1",
    type: "group",
    parentId: "root",
    label: "Retro CRT",
    group: {
      inputBindings: [],
      outputBindings: []
    }
  },
  { id: "vhs-1", type: "vhs", parentId: "group-1" },
  { id: "crt-1", type: "crt", parentId: "group-1" }
]
```

`group` node tipinin socket'leri statik `NODE_DEFINITIONS` ile yetinemez. Mevcut
runtime `inputSocketsFor(node)` içinde node type'a göre statik socket listesi
kullanır; group için boundary socket'leri node metadata'sından okunmalıdır.

Önerilen boundary modeli:

* `Group Input` sanal node'u içerideki graph'a dış kaynakları taşır.
* `Group Output` sanal node'u içerideki sonucu dışarı verir.
* Group node dışarıdan normal tek node gibi görünür.
* İçeri girildiğinde breadcrumb görünür: `Root / Retro CRT`.

## 6. Faz 4 - Runtime Flattening

Runtime'a doğrudan nested graph öğretmek yerine, değerlendirme öncesi graph
flatten edilmelidir.

Adımlar:

1. `activeParentId` sadece editor görünümünü etkiler; runtime her zaman bütün
   graph snapshot'ını alır.
2. `flattenGraphForRuntime(graph)` group node'ları boundary mapping'e göre düz
   sanal node/edge listesine açar.
3. Flattened graph içindeki node id'leri stabil kalmalıdır. Aksi halde
   `nodeCache` her frame boşa düşer.
4. Group içindeki node cache'i normal node cache'i gibi çalışmalıdır.
5. Group collapse edilmiş olsa bile içerideki node'lar preview/export sonucuna
   katılmalıdır.

Riskler:

* Dynamic socket değişince edge sanitize akışı kırılabilir.
* Group içine girip çıkmak selected node state'ini bozabilir.
* Kaydedilmiş projelerde `parentId` eksikse bütün node'lar `root` altında
  normalize edilmelidir.
* Bypass/visibility davranışı group ve child node'lar için ayrı tanımlanmalıdır.

## 7. Node Latency / Profiling Göstergesi

Graph editor'da her node'un son render değerlendirmesindeki gecikmesini göstermek
çok değerli olur. Bu özellik group node'larla birleştiğinde yavaşlığı hangi blok
yaratıyor sorusunu cevaplar.

### Runtime Ölçümü
`graph-runtime.js` içinde her node için ölçüm yapılabilir:

```javascript
const start = performance.now();
const output = computeNodeOutput(node, index, results, context);
const durationMs = performance.now() - start;
```

Ancak cache hit durumunda ayrı ölçüm tutulmalıdır:

```javascript
profile[node.id] = {
  durationMs,
  cacheHit: false,
  outputSize: output ? [output.width, output.height] : null
};
```

Cache hit için:

```javascript
profile[node.id] = {
  durationMs: 0,
  cacheHit: true,
  outputSize: cached.output ? [cached.output.width, cached.output.height] : null
};
```

### State Modeli
Profiling verisi project save içine girmemelidir; runtime/readout state'i olarak
tutulmalıdır.

Önerilen alan:

```javascript
view: {
  showNodeTimings: false,
  nodeTimings: {
    "dither-1": { durationMs: 4.8, cacheHit: false, outputSize: [1920, 1080] }
  }
}
```

### UI Gösterimi

* Node üzerinde küçük badge: `4.8 ms`, cache hit ise `cached`.
* Ağır node'lar için renk eşiği:
  * `< 2 ms`: nötr
  * `2-8 ms`: sarı
  * `> 8 ms`: kırmızı
* Group node üzerinde child node sürelerinin toplamı gösterilir.
* Toolbar'da "Show timings" toggle'ı olmalıdır.
* Export sırasında ayrı timing modu düşünülmelidir; preview downscale süreleri
  export maliyetini bire bir temsil etmez.

### Kabul Kriterleri

* Kullanıcı timing overlay'i açıp kapatabilir.
* Cache hit olan node ile gerçekten yeniden hesaplanan node ayırt edilir.
* Group node collapsed durumdayken toplam group süresi görülebilir.
* Timing verisi projeye kaydedilmez.

## 8. Önerilen Geliştirme Sırası

1. Graph state'e `selectedNodeIds` ve `selectedEdgeIds` ekle.
2. Graph-shell'de multi-select, marquee ve toplu drag davranışını kur.
3. Çoklu seçim delete/undo/redo davranışını tamamla.
4. Runtime profiling verisini opsiyonel olarak üret.
5. Node timing overlay UI'ını ekle.
6. Macro preset MVP'sini ekle.
7. `parentId`, breadcrumb ve nested editor görünümünü ekle.
8. Group boundary socket modelini ve runtime flattening'i ekle.
9. Group node üstünde child timing toplamını göster.

Bu sıralama, kullanıcıya erken aşamada hissedilir fayda verirken gerçek nested
group runtime'ın risklerini kontrollü biçimde açar.
