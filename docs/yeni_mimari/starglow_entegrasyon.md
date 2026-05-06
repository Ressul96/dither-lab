# Star Glow Entegrasyon Planı

> **Karar:** `star-glow` yeni bir node olarak eklenmeden önce mevcut `glare`
> node'u ile sınırı netleşmeli. Star Glow'un farkı genel bloom değil,
> parlak alanlardan çıkan yönlü, yıldız biçimli streak'ler ve opsiyonel
> gradient renklendirmedir.

Dither Lab'de `glare` node'u zaten Bloom / Streaks / Fog Glow türlerini
barındırır. Bu yüzden Star Glow iki şekilde ilerleyebilir:

1. `glare.type = "star"` olarak mevcut node'a eklenir.
2. Ayrı `star-glow` node'u açılır.

P1 için öneri: `glare` içinde yeni type olarak başlamak. Ayrı node yalnızca UI
ve preset deneyimi bunu gerektirirse açılmalı.

---

## 1. Mevcut Sistemle İlişki

Mevcut `glare`:

- `bloom-gpu`: hızlı single-pass glow.
- `streaks`: CPU directional streaks.
- `bloom` / `fog-glow`: legacy CPU yollar.

Star Glow hedefi:

- GPU-first directional streak.
- Birden fazla star axis.
- Threshold/knee ile highlight isolation.
- Opsiyonel gradient colorization.

CPU `streaks` yolu korunur; Star Glow video playback için GPU hedefidir.

---

## 2. Parametre Modeli

Eğer `glare` içine eklenirse:

```javascript
glare: {
  defaultParams: {
    type: "star-gpu",
    threshold: 180,
    knee: 20,
    mix: 100,
    streaks: 4,
    angle: 0,
    length: 64,
    falloff: 80,
    alternate: 100,
    colorize: 0,
    gradientShift: 0,
  },
}
```

Eğer ayrı node olursa:

```javascript
"star-glow": {
  label: "Star Glow",
  family: "Effect",
  inputs: [{ name: "image", label: "Image", type: "image" }],
  outputs: [{ name: "image", label: "Image", type: "image" }],
  defaultParams: {
    threshold: 70,
    knee: 20,
    intensity: 120,
    streaks: 4,
    angle: 0,
    length: 64,
    falloff: 80,
    alternate: 100,
    colorize: 0,
    opacity: 100,
  },
}
```

P1'de gradient map zorunlu değildir. Önce beyaz/source renkli streak doğru
çalışmalı.

---

## 3. Gradient İlişkisi

Star Glow gradient renklendirme istiyorsa `gradient_map_entegrasyon.md` içinde
önerilen ortak `gradient-lut.js` altyapısını kullanmalıdır.

P1:

- `colorize: 0` varsayılan.
- Gradient yok veya iki renkli basit tint.

P2:

- Shared gradient editor.
- Distance along streak (`t`) üzerinden LUT sample.
- `gradientShift`.

Her efekt kendi gradient editor'ünü yazmamalı.

---

## 4. Shader Stratejisi

Star Glow pahalı olabilir. `streaks * samples` çarpımı sınırlandırılmalı.

Öneri:

- P1 max `streaks = 8`.
- P1 max sample count shader içinde sabit veya düşük tutulur.
- `length` piksel cinsinden bağlanır.
- Threshold/knee mevcut Bloom shader matematiğiyle uyumlu olur.

Akış:

1. Source renk okunur.
2. Highlight mask hesaplanır.
3. Her streak axis boyunca ileri/geri sample alınır.
4. Falloff ile ağırlık verilir.
5. Glow source üzerine additive/screen benzeri eklenir.

---

## 5. Uygulama Sırası

### P1 - Glare Type Olarak GPU Star

- `glare.type` seçeneklerine `star-gpu` eklenir.
- `gpu-effects.js` star shader pass eklenir.
- Inspector sadece ilgili type seçiliyken star parametrelerini gösterir.
- WebGL2 yoksa CPU `streaks` fallback veya input pass-through stratejisi net olur.

### P2 - Gradient Colorization

- Ortak gradient LUT kullanılır.
- `colorize`, `gradientShift` eklenir.

### P3 - Ayrı Node Kararı

- Eğer kullanıcılar Star Glow'u Glare içinden bulmakta zorlanırsa ayrı
  `star-glow` node palette'e eklenebilir.
- Ayrı node açılırsa shader ve helper kodu duplicate edilmez.

---

## 6. Kabul Kriterleri

- Mevcut `glare` presetleri bozulmaz.
- Star Glow varsayılanı aşırı pahalı değildir.
- GPU path video preview'de kullanılabilir kalır.
- Gradient editor tek ortak altyapıdan gelir.
- Bloom, Halation ve LED Screen ile görev sınırı korunur.
