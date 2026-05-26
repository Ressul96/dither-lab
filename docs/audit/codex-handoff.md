# Codex Devir Notu — Dither Lab

**Tarih:** 2026-05-21
**Önceki ajan:** Claude Opus 4.7 (Claude Code CLI)
**Devam edilen plan:** [next-phases.md](next-phases.md)
**Repo:** https://github.com/Ressul96/dither-lab — `main` branch

Bu dosya, oturumlar arası geçişte Codex'in (veya başka bir ajanın) işi sıfırdan bağlam toplamadan devralabilmesi için yazıldı. Detay için [next-phases.md](next-phases.md) ve [audit.md](audit.md)'ye bak; bu dosya yalnızca yön + kural + sıradaki iş özeti.

---

## 1. Proje Hızlı Bakış

- **Ne:** Tauri 2.x masaüstü uygulaması — video / image-sequence / EXR-sequence dithering
- **Stack:** Tauri 2 + Rust (`src-tauri/`), vanilla HTML/CSS/JS frontend (build step yok), WebGL2 GPU efektleri, FFmpeg sidecar export
- **Hedef:** macOS, Windows, Linux (local-first; account/cloud/telemetri yok)
- **Bağlayıcı kurallar:** [CLAUDE.md](../../CLAUDE.md)
- **Spec haritası:** [docs/spec/](../spec/)

---

## 2. Konvansiyonlar (mutlaka okuy)

### Dil
- **Kod yorumları:** English-only
- **Commit mesajları:** English-only
- **Kullanıcı arayüzü metni:** English-only
- **Çalışma dökümanları (audit/plan):** Türkçe (mevcut audit.md, next-phases.md ile tutarlılık)
- **Kullanıcı sohbet metni:** Türkçe

### Commit formatı
Trailer ile son satır:
```
Co-Authored-By: Codex <noreply@openai.com>
```
- **Asla** `--amend` kullanma (kullanıcı açıkça istemediği sürece)
- **Asla** `--no-verify` ile hook atlamayı yapma
- HEREDOC ile çok satırlı mesaj geç
- Atomik commit'ler tercih edilir (M.3'te 24 küçük commit gibi)

### Kod stili (CLAUDE.md "Simplicity First")
- Spekülatif kod yok
- Tek-kullanımlık fonksiyonlar için soyutlama yok
- Yorum yazma alışkanlığı düşük tutulur — sadece **niye** açıklayan satırlar
- Mevcut dosya stilini taklit et, refactor için gelmedin
- Cerrahi değişiklikler: sadece istenen iş, komşu temizlik yok

### Lifecycle pattern
Yeni init fonksiyonları kullanmak için bu API var (zaten yerleşik):
```js
import { registerDispose, listenWithDispose } from "./ui/lifecycle.js";

registerDispose(() => { /* teardown */ });
listenWithDispose(target, "event", handler, options); // auto-registered
```

### Tauri SDK shim
SDK sürüm değişikliklerini absorbe etmek için `src/js/tauri-compat.js` kullan — doğrudan `@tauri-apps/api`'den import etme.
```js
import { tauriInvoke, hasTauri, tauriWriteBinary } from "./tauri-compat.js";
```

### Smoke harness
Dither veya palette etkileyen değişikliklerden sonra:
```bash
npm run smoke  # port 5177, smoke/algorithms.html
```

### Hızlı doğrulama
```bash
node --check src/js/<dosya>.js  # syntax kontrol
```
JS test framework yok; doğrulama smoke harness + manuel preview ile yapılır.

---

## 3. Son Tamamlananlar (bu oturumda)

| Görev | Durum | Son commit |
|---|---|---|
| Faz A-G (audit.md ana planı) | ✅ | (önceki oturumlar) |
| **M.5** — `graph.js` deep-clone azaltma | ✅ | (önceki oturumlar) |
| **A.2** — Dispose registry (`lifecycle.js`) | ✅ | (önceki oturumlar) |
| **M.3** — `image-ops.js` parçalama (2602 → 72 satır barrel + 29 modül) | ✅ | `e470021` |

**Önemli:** `next-phases.md` dosyası bu güncellemeleri henüz yansıtmıyor; M.5, A.2, M.3 hâlâ "açık" gösteriliyor. Plan dosyasını güncelleyecek zaman bulamadık; gerçek durum bu dosyada.

---

## 4. Kalan İşler

| Kod | Görev | Tahmini iş | Öncelik | Bağımlılık |
|---|---|---|---|---|
| **M.1** | `graph-shell.js` (7202 satır) bölme | 1-2 hafta | Yüksek | — |
| **M.2** | `player.js` (2930 satır) bölme | 1 hafta | Orta | — |
| **M.4** | `innerHTML` → `replaceChildren` migrasyonu | 1 hafta + ölçüm | Orta | M.1, M.2 |
| **S.1** | EXR Sequence desteği (4 alt faz) | ~1 hafta | Yüksek (scope) | — |
| **A.1** | Gizmo/playhead/bezier keyboard a11y | 2-3 gün | Orta | — |
| **V.1** | GPU shader BT.709 yükseltme | 1 saat + test | Karar bekliyor | Görsel test |
| **F22** | Splash screen | 2-3 gün | UI polish | — |

### En kısa ve düşük riskli (hızlı kazanım)
- **V.1** (1 saat + test) — Karar verilirse tek shader pass. Kullanıcı "kararsızım, sonra konuşuruz" demişti — Codex bu kararı tetiklemeden başlama.
- **A.1** (2-3 gün) — Atomik, hazır F23 pattern var. Aşağıda detay.
- **F22** (2-3 gün) — Bağımsız, UI polish.

### Büyük mimari iş
- **M.1** ve **M.2**: M.3 (image-ops) ile aynı pattern — atomik commit'ler, barrel re-export ile geriye dönük uyumluluk. M.3 örnek alınabilir.
- **M.4**: M.1 ve M.2 split sırasında birlikte yapmak en mantıklı (DOM render stratejisi de düzelir).

### Karar gerektirenler
- **V.1:** BT.709 luma yükseltme. Pro: modern sRGB doğrusu. Con: kullanıcının kaydettiği bloom/glare/halftone hafifçe değişir → "regresyon" algısı. Önce kullanıcıdan onay al.
- **S.1 (EXR):** Scope içinde mi? Spec ([product.md](../spec/product.md), [CLAUDE.md](../../CLAUDE.md)) EXR vaat ediyor ama kod hiç hazır değil — `exr` crate yok, dosya filtresinde `.exr` yok. Kullanıcıya scope onayı sor.

---

## 5. Sıradaki İş için Hazır Paket — A.1 (Keyboard A11y)

En kısa, atomik, bağımsız iş. F23 scrubbable-number pattern'ı zaten kodda mevcut — örnek olarak `src/js/ui/scrubbable.js` (veya benzeri) bakılabilir.

### Adımlar
1. **Hedef dosyalar:**
   - [src/js/ui/viewer-gizmos.js](../../src/js/ui/viewer-gizmos.js) — point, angle, ring, mesh-stops, crop-box handle'ları
   - [src/js/ui/player.js](../../src/js/ui/player.js) — playhead handle
   - [src/js/ui/player.js](../../src/js/ui/player.js) — bezier popover SVG handle'ları

2. **Her handle için:**
   - `tabindex="0"` ekle
   - Uygun `role` ve `aria-label`
   - `keydown` handler:
     - `←/→` → 1 unit nudge
     - `Shift+←/→` → 10x nudge
     - `Alt+←/→` → 0.1x nudge
   - Focus ring CSS (gizmo özelinde belki disable-on-pointer-hover)

3. **Başarı kriteri:**
   - Mouse olmadan tüm gizmo değerleri keyboard ile değiştirilebiliyor
   - Mevcut pointer drag davranışı bozulmuyor
   - Tab order mantıklı sırada

4. **Doğrulama:**
   - Manuel preview (Tauri dev shell)
   - `node --check` etkilenen dosyalarda
   - Smoke harness regresyon yok

### Önemli notlar
- Her gizmo türü için ayrı atomik commit (M.3 patern'i)
- `lifecycle.js` registerDispose pattern'ini kullan, leak olmasın
- Komşu CSS'i refactor etme — sadece focus ring için minimum eklenti

---

## 6. M.1 / M.2 için yöntem (büyük refactor)

M.3 (image-ops.js) ile aynı playbook:

1. **Foundation-first ordering:** Önce shared helper'ları (pixel-math, sampling, vs.) yeni modüle taşı. Sonra node'ları tek tek.
2. **Barrel re-export ile geriye dönük uyumluluk:** Orijinal dosya bir barrel'a dönsün; tüm caller'ın `from "./graph-shell.js"` import yolu çalışmaya devam etsin.
3. **Atomik commit'ler:** Her adım `node --check` ile doğrulanabilir olsun. M.3'te 24 commit oldu — bu fazla görünebilir ama her commit izole, bisect dostu.
4. **Test stratejisi:** Smoke harness + manuel preview her büyük adımdan sonra.
5. **Plan iletişimi:** Başlamadan kullanıcıya hedef bölme tablosunu göster (next-phases.md M.1 zaten 6 modüllük hedef veriyor).

---

## 7. Sık Kullanılan Komutlar

```bash
# Dev shell (Tauri)
npm run tauri dev

# Smoke harness (port 5177)
npm run smoke

# Tek dosya syntax check
node --check src/js/<dosya>.js

# Tüm JS dosyalarında syntax check
find src -name "*.js" -not -path "*/node_modules/*" -exec node --check {} \;

# Rust check
cargo check --manifest-path src-tauri/Cargo.toml

# Git stat
git status
git log --oneline -10
```

---

## 8. Dikkat Edilecekler

- **Preview/Export parity:** Her efekt değişikliği iki yolda da aynı görünmeli (CLAUDE.md non-negotiable).
- **Hidden layer in export:** Gizli katmanlar export'ta görünmemeli (CLAUDE.md non-negotiable).
- **Seed-locked determinism:** Preview ve export aynı seed'le aynı sonucu üretmeli.
- **No JS build step:** Webpack, Vite, esbuild yok — ES modules + import map yeterli.
- **No React/Vue/Svelte:** Vanilla DOM API.
- **Image-ops barrel:** `src/js/image-ops.js` sadece re-export — yeni kod buraya yazılmaz, ilgili `src/js/image-ops/*.js` modülüne gider.
- **Tauri capabilities:** Yeni Tauri komutu ekliyorsan `src-tauri/capabilities/*.json` permission güncelle.

---

## 9. İç durum referansları

- Auto-memory: `/Users/resulercan/.claude/projects/-Users-resulercan-Desktop-dither-lab/memory/MEMORY.md` (Claude'a özel; Codex için bilgi amaçlı)
- Phase progress takip: [project_phase_progress.md](../../../../.claude/projects/-Users-resulercan-Desktop-dither-lab/memory/project_phase_progress.md) (Claude memory; Codex bilgi için)
- Audit ana plan: [audit.md](audit.md) — Faz A-G uygulamasının çıkış noktası
- Kalan iş detayı: [next-phases.md](next-phases.md) — her görev için tam detay

---

## 10. Öneri: Codex'in ilk hamlesi

1. Bu dosyayı + [next-phases.md](next-phases.md)'yi okuyup mevcut durumu doğrula
2. Kullanıcıya hangi görevden başlamak istediğini sor (A.1 veya M.1 veya F22 en olası)
3. **A.1** seçilirse: yukarıdaki "Hazır Paket" maddesi yeterli — direkt başla
4. **M.1** seçilirse: önce hedef bölme tablosunu kullanıcıyla onayla, sonra foundation modülünden başla (M.3 playbook)
5. **F22** seçilirse: splash screen mockup'ı için kullanıcıdan görsel referans veya wireframe iste

İyi çalışmalar.
