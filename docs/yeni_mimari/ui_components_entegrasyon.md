# Dither Lab UI Components: Mevcut Sistemle Hizalanmış Entegrasyon Notları

> Durum: 2026-05-06 tarihinde `src/index.html`, `src/styles/main.css`,
> `src/styles/controls.css`, `src/js/ui/shell.js`, `src/js/ui/player.js` ve
> `src/js/ui/graph-shell.js` üzerinden yeniden doğrulandı.
> Bu belge yeni bir prototip sistemi önermek yerine mevcut UI primitive'lerini
> standartlaştırır.

## 1. Mevcut UI Gerçeği
Dither Lab'de panel, toggle ve form primitive'leri zaten oluşmuş durumda:

* **Panel hide/show:** `panel-toggle`, `workspace-edge-toggle`,
  `data-panel-toggle`, `panel-hidden-left/right`.
* **Panel resize:** `.resize-handle` ve `shell.js` pointer capture akışı.
* **Form kontrolleri:** `.field`, `.range-field`, `.number-field`, `.dropdown`,
  `.checkbox`, `.btn`, `.icon-btn`, `.segmented`.
* **Node param UI:** `param-socket-toggle`, `param-keyframe-toggle`.
* **Player toggle'ları:** `autokey-pill`, loop/autokey active dot.
* **Preview toggle'ları:** `zoom-pill`, `quality-pill`, `scopes-toggle`.

Bu nedenle yeni bileşenler inline HTML/JS ile değil, bu mevcut primitive ailesini
genişleterek eklenmelidir.

## 2. Panel Notch / Edge Toggle Kararı
Eski Micro Notch önerisi kavramsal olarak doğruydu: panel açma/kapama aksiyonu
kenara yakın, minimal ve geniş hit-area'lı olmalı. Mevcut uygulamada bu davranış
şu şekilde zaten var:

* Panel içindeyken: `.panel-toggle`
* Panel kapalıyken workspace kenarında: `.workspace-edge-toggle`
* Durum sınıfları: `#app.panel-hidden-left`, `#app.panel-hidden-right`
* Event binding: `src/js/ui/shell.js` içinde `[data-panel-toggle]`

Karar:

* Yeni `tab-notch` sistemi eklenmemeli.
* Mevcut `.panel-toggle` / `.workspace-edge-toggle` görsel olarak daha "micro
  notch" hissine yaklaştırılabilir.
* Toggle butonları panelin kardeşi ve workspace overlay'i olarak kalmalı; panel
  içinde `overflow` tarafından yutulmamalıdır.
* Inline `onclick` kullanılmamalıdır.

İyileştirme önerileri:

* Hit area korunmalı; görsel handle küçük olabilir ama tıklama alanı en az 20px olmalı.
* Kapalı panel edge toggle'ları keyboard focus ile de erişilebilir kalmalı.
* `aria-label` ve `title` senkronizasyonu mevcut `syncPanelToggleLabels` üzerinden sürmeli.
* Motion 120-180ms aralığında tutulmalı; panel açma/kapama uzun animasyonla
  workspace'i geciktirmemeli.

## 3. Toggle Primitive Kararı
UI'da üç farklı toggle türü kullanılmalıdır; her boolean için aynı görsel
kullanılmamalıdır.

### 3.1 Checkbox
Kullanım:

* Inspector içindeki klasik boolean parametreler.
* `invert`, `fit`, `clamp`, `serpentine` gibi form alanları.

Neden:

* Form içinde okunabilir.
* Native input davranışı, focus ve keyboard erişimi korunur.
* `controls.css` içinde zaten style edilmiş durumda.

### 3.2 Pill Toggle
Kullanım:

* Player veya toolbar üzerindeki modlar.
* `Loop`, `Auto-Key`, `FX Auto/Full`, `Scopes`.

Neden:

* Sık kullanılan global/mod durumlarını görünür yapar.
* Dot veya compact status metni ile state okunur.

Mevcut sınıflar:

* `.autokey-pill`
* `.quality-pill`
* `.scopes-toggle`

Yeni `.toggle-pill` sınıfı eklenmeden önce bu sınıflar ortak bir primitive'e
çekilmelidir:

```css
.state-pill { ... }
.state-pill.is-active { ... }
.state-pill__dot { ... }
```

Ancak refactor yapılana kadar mevcut sınıflar korunmalıdır.

### 3.3 Micro Dot / Icon Toggle
Kullanım:

* Param keyframe durumu.
* Param socket expose durumu.
* Node bypass/visibility.
* Palette swatch lock gibi çok yoğun UI noktaları.

Mevcut örnekler:

* `.param-keyframe-toggle`
* `.param-socket-toggle`
* `.graph-node-action--visibility`

Karar:

* Yoğun inspector satırlarında büyük pill kullanılmamalı.
* Micro toggle'lar mutlaka `title` / `aria-label` taşımalı.
* Aktif, hover ve disabled state'leri aynı token ailesinden beslenmeli.

## 4. Event Binding Kuralları
Kod örneklerinde inline `onclick` kullanılmamalıdır. Mevcut mimari:

* Shell davranışları: `src/js/ui/shell.js`
* Player davranışları: `src/js/ui/player.js`
* Stage davranışları: `src/js/ui/stage.js`
* Graph / inspector davranışları: `src/js/ui/graph-shell.js`

Yeni bileşen eklenirken:

1. HTML `data-*` attribute ile davranış niyetini işaretler.
2. İlgili UI modülü event listener bağlar.
3. State değişimi `dispatch(...)` ile yapılır.
4. Görsel state `subscribe(...)` ile sync edilir.

Bu düzen, undo/redo, project state, persistence ve test edilebilirlik için
korunmalıdır.

## 5. Token ve Stil Kuralları
Mevcut token set'i `src/styles/main.css` içinde tanımlıdır:

* Renk: `--bg-*`, `--border-*`, `--text-*`, `--accent`, semantic colors.
* Radius: `--radius-xs` ile `--radius-pill`.
* Tipografi: `--text-base`, `--text-label`, `--text-heading`.
* Node family colors: `--family-*`.

Yeni component CSS'i şu kurallara uymalıdır:

* Yeni renk hex'i eklemek yerine token kullanılmalı.
* Border radius mevcut token'lardan seçilmeli.
* Geçiş süreleri 120-180ms aralığında tutulmalı.
* Inspector gibi yoğun alanlarda büyük gölge/glow kullanılmamalı.
* Toggle glow yalnızca önemli aktif durumlarda ve düşük opaklıkla kullanılmalı.

## 6. Erişilebilirlik ve Etkileşim

Minimum gereksinimler:

* Tüm butonlar gerçek `<button>` olmalı.
* Toggle state için `aria-pressed` kullanılmalı.
* Expand/collapse için `aria-expanded` korunmalı.
* Panel visibility için label/title sync edilmeli.
* Keyboard focus ring görünür olmalı.
* Disabled state sadece opacity değil, pointer/keyboard davranışıyla da uyumlu olmalı.

Mevcut iyi örnekler:

* `section-toggle` içinde `aria-expanded`.
* `scopesToggle` içinde `aria-pressed`.
* `panel-toggle` label/title sync.

İyileştirilecek alanlar:

* `autokey-pill` ve `loop` için `aria-pressed` state'i sync edilebilir.
* `quality-pill` için mevcut `data-quality` yanında `aria-pressed` veya net label
  güncellemesi kullanılabilir.
* Micro icon toggle'larda tooltip/aria metni standartlaştırılmalıdır.

## 7. Component Envanteri

### Panel Controls

* `.panel-toggle`: panel açıkken kapatma.
* `.workspace-edge-toggle`: panel kapalıyken tekrar açma.
* `.resize-handle`: panel veya workspace bölücü resize.

Kabul:

* Panel gizlenince içerik pointer-event almaz.
* Toggle workspace kenarında erişilebilir kalır.
* Genişlik restore edilir.

### Form Controls

* `.field`
* `.range-field`
* `.number-field`
* `.dropdown`
* `.checkbox`

Kabul:

* Label uzunluğu taşmamalı.
* Range + number input aynı paramı sync etmeli.
* Focus state belirgin olmalı.

### Mode Controls

* `.segmented`
* `.zoom-pill`
* `.quality-pill`
* `.scopes-toggle`
* `.autokey-pill`

Kabul:

* Aktif mod görsel olarak açık.
* `aria-pressed` veya active class state ile senkron.
* Kısa metin dar alanda taşmıyor.

### Node Micro Controls

* `.param-keyframe-toggle`
* `.param-socket-toggle`
* `.graph-node-action--visibility`

Kabul:

* Hit target görsel noktadan daha büyük veya yeterli.
* Tooltip/aria label açık.
* Aktif state renkleri semantic olarak tutarlı.

## 8. Önerilen Refactor Sırası

1. `ui_components_entegrasyon.md` içindeki eski inline prototype yaklaşımı terk edildi.
2. `autokey-pill`, `quality-pill`, `scopes-toggle` için ortak `state-pill`
   kararını tasarla; hemen geniş refactor yapmadan yeni bileşenlerde aynı görsel
   dili kullan.
3. Panel toggle'ların Micro Notch hissini iyileştir: daha ince görsel çizgi,
   korunmuş hit area, net focus state.
4. `aria-pressed` sync eksiklerini tamamla.
5. Micro toggle tooltip/aria metinlerini standartlaştır.
6. Yeni gizmo/timing/group toolbar kontrolleri eklenirken bu primitive set'i kullan.

## 9. Yapılmaması Gerekenler

* Inline `onclick` ekleme.
* Yeni `.toggle-pill` ailesiyle mevcut `autokey-pill` / `quality-pill` dilini
  çoğaltma.
* Her boolean'ı pill toggle yapma.
* Inspector satırlarında glow-heavy aktif state kullanma.
* Panel toggle'larını panel overflow'u içinde kaybolacak şekilde konumlandırma.
* Project save'e geçici UI hover/active state yazma.
