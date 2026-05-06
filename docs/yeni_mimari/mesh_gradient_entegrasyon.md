# Mesh Gradient Source Node Entegrasyon Planı

> **Karar:** `mesh-gradient` procedural `Input` node olarak eklenebilir. Bu
> node dış source görüntüsüne ihtiyaç duymaz; kendi canvas/GPU output'unu üretir
> ve graph içinde normal image output gibi akar.

Mesh Gradient, dither ve renk efektlerini test etmek için dosya yüklemeden
pürüzsüz, animasyonlu gradient kaynakları üretir.

---

## 1. Runtime Gerçeği

Mevcut `source` node dış dünyadan gelen `context.sourceImage` ile çalışır.
`mesh-gradient` ise context source istemez.

Bu yüzden runtime'a açık case eklenmeli:

```javascript
case "mesh-gradient":
  return applyMeshGradientNode(node.params, context);
```

Node animasyonlu olacaksa `TIME_AWARE_TYPES` set'ine eklenmelidir. Cache key
frame/time ile tuzlanmazsa aynı canvas stale kalır.

---

## 2. Node Tanımı

Family olarak mevcut listede `Source` yok; `Input` kullanılmalı.

```javascript
"mesh-gradient": {
  label: "Mesh Gradient",
  family: "Input",
  description: "Generates a procedural animated multi-color gradient.",
  inputs: [],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    colorA: "#ff0055",
    colorB: "#00ff99",
    colorC: "#0055ff",
    colorD: "#ffcc00",
    complexity: 50,
    warp: 35,
    speed: 25,
    zoom: 100,
    width: 1920,
    height: 1080,
  },
}
```

Bounds:

```javascript
"mesh-gradient": {
  complexity: { min: 0, max: 100 },
  warp: { min: 0, max: 100 },
  speed: { min: 0, max: 100 },
  zoom: { min: 25, max: 400 },
  width: { min: 256, max: 4096 },
  height: { min: 256, max: 4096 },
}
```

P1 için `width/height` source resolution yokken output boyutunu belirler.
İleride viewer/export resolution ile otomatik hizalama tartışılabilir.

---

## 3. UI

P1:

- 4 color field.
- Complexity.
- Warp.
- Speed.
- Zoom.
- Width / Height.

Color field primitive'i yoksa `duotone` ile birlikte reusable yapılmalı.

---

## 4. GPU/CPU Stratejisi

GPU-first uygundur:

- Fullscreen shader.
- `u_time` sadece `context.timeSeconds`.
- 4 renk bilinear karışım.
- Noise/warp pahalı olmayacak şekilde basit tutulur.

CPU fallback:

- WebGL2 yoksa basit Canvas 2D linear/radial gradient üretilebilir.
- Bu fallback animated olmak zorunda değildir; graph kırılmasın yeter.

---

## 5. Output Boyutu

Procedural source node'ların en önemli kararı boyuttur.

P1 önerisi:

- `width` / `height` node parametresi.
- Varsayılan 1920x1080.
- Export'ta bu canvas downstream chain'e normal image gibi girer.

Alternatifler:

- Viewer output resolution'a uyum.
- Project-level resolution.
- Source loaded ise source resolution'a uyum.

Bu alternatifler daha geniş output model kararına bağlıdır; P1'i bloke
etmemeli.

---

## 6. Uygulama Sırası

### P1 - Static/Animated Source

- Node tanımı.
- Runtime case.
- Time-aware cache.
- GPU shader.
- Color field UI.

### P2 - Presetler

- Aurora.
- Heat Map.
- Pastel Mesh.
- Dither Test Ramp.

### P3 - Source Model Entegrasyonu

- Project/output resolution ile hizalama.
- Multiple procedural source davranışı.

---

## 7. Kabul Kriterleri

- Source dosyası olmadan graph output üretebilir.
- `mesh-gradient -> viewer-output` zinciri çalışır.
- Animasyon preview/export'ta deterministiktir.
- Output boyutu açık ve kontrol edilebilir.
- `source` node davranışı değişmez.
