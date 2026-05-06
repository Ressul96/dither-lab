# Displace Node Entegrasyonu ve İyileştirme Planı

> **Karar:** Yeni bir `displacement` node tipi açılmayacak. Mevcut `displace`
> node'u korunacak ve genişletilecek. Böylece eski projeler, palette girdisi,
> graph runtime ve timeline bağları kırılmaz.

Bu belge, `effect.app` tarafındaki displacement fikirlerini Dither Lab'in
mevcut node mimarisine uyarlama planıdır. Hedef; mevcut wave/map davranışını
korurken map yerleşimi, curve shaping, debug görünümü ve GPU hızlandırmayı
aşamalı olarak eklemektir.

---

## 1. Mevcut Durum

Kodda `displace` node'u zaten vardır:

- Node tanımı: `src/js/graph.js`
- Runtime route: `src/js/graph-runtime.js`
- CPU uygulama: `src/js/image-ops.js`
- Inspector UI: `src/js/ui/graph-shell.js`

Mevcut node modeli:

```javascript
displace: {
  label: "Displace",
  family: "Effect",
  description: "Offsets pixels with an optional map input or a procedural wave.",
  inputs: [
    { name: "image", label: "Image", type: "image" },
    { name: "map", label: "Map", type: "image" },
  ],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    mode: "wave",
    xAmount: 16,
    yAmount: 0,
    strength: 100,
    frequency: 4,
    phase: 0,
    filter: "linear",
  },
}
```

Mevcut `mode === "map"` davranışı önemlidir:

- `map` girişi bağlıysa map görüntüsü input boyutuna çizilir.
- Kırmızı kanal X offset'i üretir.
- Yeşil kanal Y offset'i üretir.
- `xAmount`, `yAmount` ve `strength` bu offset'i ölçekler.

Bu RG vector-map davranışı kırılmamalı. Yeni luma tabanlı height-map davranışı
eklenecekse ayrı bir parametreyle seçilebilir olmalı.

---

## 2. Hedef Node Modeli

Node type aynı kalır:

```javascript
displace: {
  label: "Displace",
  family: "Effect",
  inputs: [
    { name: "image", label: "Image", type: "image" },
    { name: "map", label: "Map", type: "image" },
  ],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    mode: "wave",          // "wave" | "map"
    mapMode: "rg",         // "rg" | "luma" - sadece mode === "map"
    xAmount: 16,
    yAmount: 0,
    strength: 100,
    frequency: 4,
    phase: 0,
    filter: "linear",      // "linear" | "nearest"
    mapFit: "stretch",     // "stretch" | "fill" | "fit" | "tile"
    mapScale: 100,
    mapOffsetX: 0,
    mapOffsetY: 0,
    debugMap: "off",       // "off" | "map" | "vectors"
    mapCurve: null,
  },
}
```

Geriye dönük uyum:

- Eski projelerde `mapMode` yoksa `"rg"` varsayılır.
- Eski projelerde `mapFit` yoksa bugünkü davranışa denk gelen `"stretch"`
  varsayılır.
- `mapCurve: null` identity curve anlamına gelir.
- `xAmount/yAmount` korunur; `direction + amount` modeline geçmek P1 için
  önerilmez, çünkü mevcut davranışı ve timeline bağlarını gereksiz kırar.

---

## 3. Map Mode Kararı

Displacement için iki farklı map yorumu olmalı.

### RG Vector Map

Varsayılan davranış bu olmalı:

```text
dx = ((R - 128) / 128) * xAmount * strength
dy = ((G - 128) / 128) * yAmount * strength
```

Avantaj:

- Mevcut output korunur.
- Kullanıcı X ve Y yönlerini ayrı ayrı kontrol edebilir.
- Noise, gradient, mesh gradient veya özel map zincirleriyle daha güçlüdür.

### Luma Height Map

Yeni seçenek olarak eklenebilir:

```text
luma = dot(map.rgb, LUMA_W)
offset = curve(luma) * 2 - 1
dx = offset * xAmount * strength
dy = offset * yAmount * strength
```

Avantaj:

- Tek kanallı height map mantığı bekleyen kullanıcılar için anlaşılırdır.
- `mapCurve` ile kontrast / eşik / yumuşatma kolaydır.

Bu iki davranış aynı shader veya CPU fonksiyonu içinde ayrı branch olarak
yaşayabilir, ama dokümanda birbirinin yerine yazılmamalı.

---

## 4. Map Yerleşimi

Bugün map input boyutuna `drawImage(mapInput, 0, 0, width, height)` ile
stretch edilir. Bu pratik ama yaratıcı kontrolü sınırlıdır.

Eklenebilecek `mapFit` davranışları:

- `stretch`: Bugünkü davranış. Map input tam output boyutuna esnetilir.
- `fit`: Aspect korunur, tamamı görünür, boş alanlar clamp/edge davranışı alır.
- `fill`: Aspect korunur, output'u kaplar, taşan kısım kırpılır.
- `tile`: `mapScale`, `mapOffsetX`, `mapOffsetY` ile desen tekrar eder.

P1'de sadece mevcut `stretch` korunur. P2'de `tile` ve `mapScale` özellikle
prosedürel map node'larıyla değerli olur.

---

## 5. Map Curve

`mapCurve`, Curves dokümanında önerilen ortak `curve-lut.js` altyapısını
kullanmalı. Ayrı bir curve matematiği veya ayrı bir inspector widget'ı
oluşturulmamalı.

Kullanım:

- `mapMode === "luma"` için luma değeri curve'den geçirilir.
- `mapMode === "rg"` için P1'de curve uygulanmaz.
- P2'de RG mode için curve seçenekleri ayrıca tartışılabilir:
  - Aynı curve hem R hem G kanalına uygulanır.
  - Ayrı `mapCurveX` / `mapCurveY` tutulur.

Önce tek `mapCurve` + luma mode yeterlidir.

---

## 6. Inspector UI

Mevcut sade UI korunur ve koşullu zenginleştirilir.

Ortak alanlar:

- `Mode`: Wave / Map input
- `X Amount`
- `Y Amount`
- `Strength`
- `Filter`: Linear / Nearest

`mode === "wave"`:

- `Frequency`
- `Phase`

`mode === "map"`:

- `Map Mode`: RG Vector / Luma Height
- `Map Fit`: Stretch / Fill / Fit / Tile
- `Map Scale`: sadece `tile` veya scale destekli fit modlarında
- `Debug`: Off / Map / Vectors
- `Map Curve`: sadece `mapMode === "luma"` olduğunda

UI kuralı:

- Bağlı map yoksa map mode alanında açık bir hint gösterilir.
- Built-in texture seçimi P1'e alınmaz; kullanıcı zaten graph üzerinden Noise,
  Mesh Gradient veya başka node'ları `map` girişine bağlayabilir.
- Eğer ileride `textureId` eklenecekse yalnızca `map` girişi boşken fallback
  kaynak olarak çalışmalıdır.

---

## 7. CPU ve GPU Sıralaması

### P1 - Mevcut Davranışı Sağlamlaştır

- `displace` node type korunur.
- `mapMode` eklenirse varsayılanı `"rg"` olur.
- Eski projeler aynı görünür.
- UI hintleri güncellenir: “Red offsets X, Green offsets Y.”
- Map bağlı değilken `mode === "map"` output'u bozmadan input'a yakın davranır
  veya net bir boş-state gösterir.

### P2 - Map Kontrolü

- `mapFit`, `mapScale`, `mapOffsetX`, `mapOffsetY` eklenir.
- `debugMap` eklenir.
- `mapMode === "luma"` ve `mapCurve` CPU referansı eklenir.
- `curve-lut.js` ortak helper'ı kullanılır.

### P3 - GPU Hızlandırma

- GPU pass CPU ile aynı davranışı üretir.
- RG vector-map ve luma height-map ayrı branch'lerle desteklenir.
- `filter` shader sampling moduna bağlanır.
- `mapFit/tile` UV hesapları CPU referansı ile aynı matematiği kullanır.
- WebGL2 yoksa CPU fallback korunur.

---

## 8. Shader Taslağı

Shader taslağı mevcut davranışı gözeterek düşünülmeli:

```glsl
vec3 mapCol = texture(u_displacementMap, mapUv).rgb;
vec2 offset;

if (u_mapMode < 0.5) {
  // RG vector map
  offset = vec2(mapCol.r - 0.5, mapCol.g - 0.5) * 2.0;
} else {
  // Luma height map
  float luma = dot(mapCol, vec3(0.299, 0.587, 0.114));
  float shaped = texture(u_curveLut, vec2(luma, 0.5)).r;
  offset = vec2((shaped - 0.5) * 2.0);
}

vec2 amountPx = vec2(u_xAmount, u_yAmount) * u_strength;
vec2 displacedUv = v_uv - (offset * amountPx / u_resolution);
out_color = texture(u_image, displacedUv);
```

Bu shader P3 içindir. P1/P2'de CPU referansı davranışın kaynağıdır.

---

## 9. Kabul Kriterleri

- Eski `displace` projeleri aynı görünür.
- `mode === "wave"` davranışı değişmez.
- `mode === "map"` varsayılan olarak mevcut RG vector-map davranışını korur.
- Map girişi bağlı değilken node kullanıcıyı yanıltmaz.
- `mapFit` eklendiğinde `stretch` bugünkü davranışa denk gelir.
- `mapCurve` ayrı matematik icat etmez; ortak curve LUT helper'ını kullanır.
- GPU yolu geldiğinde CPU fallback ile görsel olarak eşleşir.
- Inspector gereksiz rebuild veya çok sık history girdisi üretmez.
