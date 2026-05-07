# Architecture: Mine

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [PLAN.md](PLAN.md) | [DEVLOG.md](DEVLOG.md) | [CLAUDE.md](CLAUDE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_USECASES.md](SPEC_USECASES.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md) | [SPEC_MOBILE.md](SPEC_MOBILE.md) | [SPEC_GRID.md](SPEC_GRID.md) | [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md) | [SPEC_DISPLAY_MODES.md](SPEC_DISPLAY_MODES.md) | [SPEC_FEED_VIDEO.md](SPEC_FEED_VIDEO.md) | [SPEC_ARTICLE_AUDIO.md](SPEC_ARTICLE_AUDIO.md) | [SPEC_INLINE_MEDIA_EXTRACTION.md](SPEC_INLINE_MEDIA_EXTRACTION.md) | [SPEC_IDENTITY_ROBUSTNESS.md](SPEC_IDENTITY_ROBUSTNESS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_OBSIDIAN_MARKDOWN_COMPAT.md](SPEC_OBSIDIAN_MARKDOWN_COMPAT.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [DESIGN_SYSTEM_IOS.md](DESIGN_SYSTEM_IOS.md)

## Context

Are.na — платформа для визуального букмаркинга и организации идей. Проблемы: данные в облаке, зависимость от сервиса, ограниченный бесплатный план, нет контроля над файлами.

Mine решает это: визуальный букмаркинг с локальными файлами. Приложение — окно в файловую систему, не база данных. Если удалить приложение — файлы остаются. Если удалить индекс — он пересобирается.

### Ключевые принципы

1. **Файлы — источник правды.** SQLite — только индекс, как Spotlight для macOS
2. **Всё — Markdown.** Mine-authored blocks используют `.md` с frontmatter; обычные Obsidian `.md` без frontmatter читаются как implicit articles. Медиафайлы рядом. Runtime card kind выводится из Markdown body state и `type: channel`, а не из non-channel `type:` metadata
3. **Коллекции — это Obsidian-страницы.** Membership хранится в `Mine Collections` как quoted wikilinks на collection pages; `tags` остаётся пользовательским Obsidian-полем
4. **Плоская структура.** Все файлы в корне vault. Позже — изолированные проекты (отдельные vault'ы)
5. **Индекс восстановим.** Удаление `.arena/index.db` не приводит к потере данных
6. **Thumbnail / preview pipeline.** В feed/grid/sidebar показываются preview-артефакты из локального derived store, не оригиналы
7. **Wikilinks.** Связи между блоками — через `[[wikilinks]]` в Obsidian-стиле

## Data model

### Блок = `.md` source + медиафайл (опционально)

`type` пока остаётся в frontmatter как compatibility/source hint, но больше не
является source-of-truth для feed/detail/search. Исключение — collection page с
`type: channel`: это временный явный маркер коллекции. Для обычных карточек
runtime/card kind выводится так:

- `channel` — collection document (`type: channel`);
- `article` — body после frontmatter непустой;
- `media` — body пустой.

`file` на новых write path записывается в Obsidian form:
`file: "[[image.png]]"`. Read path остаётся backward-compatible с legacy
`file: image.png`.

#### Ссылка (link)
```markdown
---
type: link
url: https://stripe.com
description: Financial infrastructure for the internet
thumbnail: stripe-og.png
Mine Collections:
  - "[[Web Design]]"
  - "[[Fintech]]"
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
---

# Stripe — Financial Infrastructure

Financial infrastructure for the internet
```
Body H1 is the visible title. Рядом лежит `stripe-og.png` (og:image или скриншот).

#### Статья / текст (article)
```markdown
---
type: article
url: https://example.com/crdt-explained
author: Wim Cools
thumbnail: crdt-article-og.png
Mine Collections:
  - "[[Programming]]"
  - "[[Distributed Systems]]"
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
---

# Как устроен CRDT

Текст статьи или выделенный фрагмент.
Может содержать форматирование и ссылки на изображения.

![[crdt-diagram.png]]
```
Тело — текст. Изображения из статьи скачиваются отдельно.

#### Изображение (image)
```markdown
---
type: image
file: "[[sunset-tokyo.jpg]]"
url: https://unsplash.com/photo/abc
width: 3840
height: 2160
Mine Collections:
  - "[[Photography]]"
  - "[[Japan]]"
  - "[[Inspiration]]"
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
---
```
Тело пустое, поэтому runtime card kind — `media`. Рядом лежит
`sunset-tokyo.jpg`. На фронте — только картинка. Детальный вид через клик
показывает атрибуты.

#### Видео / PDF / файл
```markdown
---
type: video
file: "[[demo-reel.mp4]]"
url: https://youtube.com/watch?v=xxx
thumbnail: demo-reel-thumb.jpg
Mine Collections:
  - "[[Portfolio]]"
  - "[[Motion]]"
saved_at: 2026-02-26T14:30:00Z
---

# Demo Reel 2026
```
Аналогично: `.md` с метаданными + медиафайл рядом.

Visible block title is content, not identity metadata. Mine-authored link,
article, and real page/video clips write a visible heading as the first body H1.
Tweet/text-selection/media/file blocks do not synthesize a title from content,
alt text, or filename. Existing `frontmatter.title` is read as a legacy
fallback only; new write paths do not create it.

### Коллекции = Obsidian pages

Коллекция — это **динамический вид**, фильтрующий блоки по значениям
`Mine Collections`, где каждое значение является quoted Obsidian wikilink на
страницу коллекции.

| Действие пользователя | Что происходит |
|---|---|
| Сохраняет блок в коллекции | `Mine Collections` получает quoted wikilink, например `- "[[Красивый веб]]"` |
| Добавляет блок в коллекцию | Патчится `Mine Collections` + обновляется SQLite-индекс |
| Создаёт коллекцию | Создаётся `.md` page с `type: channel`; filename остаётся человекочитаемым |
| Открывает коллекцию | Показываются все блоки со ссылкой на эту collection page |
| Блок в нескольких коллекциях | Несколько wikilinks в `Mine Collections` — никаких симлинков |

Список коллекций и порядок восстанавливаются из collection pages и
`Mine Collections`. SQLite остаётся local derived index.

### Vault — файловая структура

```
~/Mine/                        ← source vault (выбирается пользователем)
├── .arena/
│   └── vault-id                     ← sync'ed идентификатор vault
├── sunset-tokyo.md                  ← метаданные изображения
├── sunset-tokyo.jpg                 ← само изображение
├── stripe-homepage.md               ← метаданные ссылки
├── stripe-og.png                    ← миниатюра ссылки
├── crdt-article.md                  ← статья (метаданные + текст)
├── crdt-diagram.png                 ← изображение из статьи
├── demo-reel.md                     ← метаданные видео
├── demo-reel.mp4                    ← видеофайл
└── ...                              ← всё плоско
```

```
~/Library/Application Support/com.mine.app/vaults/<vault-id>/
├── index.db                         ← local derived SQLite index
├── thumbs/                          ← local preview / thumb cache
└── ...                              ← manifests, migration state, derived artifacts
```

Source vault хранит только пользовательские файлы и `vault-id`. Все derived данные живут per-device в app data и могут быть rebuilt локально.

### Filesystem-first visibility contract

Наличие `.md` файла в source vault — единственный источник правды для видимости
карточки. Если Markdown существует на диске, приложение обязано показать его в
ленте/поиске/детале после route read, даже если SQLite snapshot устарел,
watcher пропустил событие или native host сохранял clip при закрытом desktop UI.

Практические инварианты:

- SQLite, FTS, preview manifests, thumbnails и channel previews — только
  derived read models. Они ускоряют UI, но не решают, существует ли карточка.
- Watcher — accelerator, а не гарантия correctness. Потерянное notify-событие
  не может делать `.md` невидимым.
- Route-facing read commands (`list_grid_blocks`, `list_tags`,
  `list_channels`, `list_channel_previews`, `search_blocks`, `get_block`) должны
  проходить read-time catch-up: upsert missing/changed `.md` files and remove
  rows whose source `.md` disappeared before returning a final snapshot.
- Startup may render a cached skeleton/snapshot provisionally, but any final
  empty state or final route data must be reconciled with the source vault.
- Clipper/native-host direct SQLite upsert is only an optimization for faster
  feedback. The main app must still recover visibility from Markdown files alone.

### Filename-first rename contract

- identity блока остаётся равной `file_stem` его `.md` файла
- hidden `id` / `uuid` во frontmatter не вводятся
- **in-app rename** — канонический smart path:
  - переименовывает `.md`
  - не синтезирует и не переписывает `frontmatter.title` or body H1
  - переименовывает Mine-owned source media (`slug.ext`, `slug (image N).*`, `slug (video N).*`)
  - переписывает wikilinks и Mine-owned file references по vault
  - переносит block-level thumb; article audio инвалидируется только если отдельный body/H1 edit меняет speakable text
- **external rename** через Finder / Obsidian — resilience path:
  - watcher через `body_hash` трактует `Remove + Create` как rename
  - DB slug и derived artifacts сохраняются
  - `block:renamed` эмитится во frontend
  - другие `.md` файлы и source media не переписываются silently

## Current Critical Path Reset

Текущий runtime contract после срезов `Critical Path Reset v1`:

- startup/open работает против local derived store, а не против SQLite внутри iCloud vault;
- local derived store остаётся cache: route read must catch up from source-vault
  `.md` inventory before returning final data, so a stale index cannot hide
  Markdown files;
- feed/grid/sidebar используют preview-first pipeline;
- `Detail` остаётся full-fidelity path и может открывать оригиналы;
- async asset protocol override убирает синхронный `asset://` hotspot с main thread WebView для оставшихся asset-paths;
- multi-image article/social preview должен приходить как один composite preview asset, а не как client-side gallery.
- grid больше не допускает mixed-generation layout: live cards рендерятся только внутри exact `committed` prefix текущего layout generation.
- feed video contract больше не определяется render-time эвристиками: autoplay разрешён только при наличии backend-derived `feed_playback`, galleries остаются preview-only, а failure mode feed-video всегда poster-safe.

## Feed Video Contract

Desktop feed-video после финализации живёт по четырём поверхностям:

- `gallery feed` — preview-only, без live `<video>`
- `feed autoplay` — узкое исключение только для dedicated `video` и single-video `article/social`
- `detail` — full-fidelity playback originals
- `measurement` — никогда не монтирует `<video>`

Ключевой data contract:

- `preview_manifest` остаётся layout/preview source-of-truth
- `feed_playback` — отдельный nullable descriptor autoplay eligibility
- `feed_playback.profile` делит одиночные feed-video на:
  - `standard` — compact clips с `direct -> blob -> poster-only`
  - `heavy` — larger but still acceptable clips с longer `direct -> poster-only`

Frontend больше не принимает autoplay-решения по regex от имени файла. Единственная feed autoplay surface — `FeedVideoSurface` с poster-first state machine:

- `poster`
- `loading_direct`
- `playing_direct`
- `loading_blob`
- `playing_blob`
- `failed_poster_only`

Backend derivation больше не режет любой non-compact single-video clip в `poster-only`.
Теперь политика двухступенчатая:

- `standard` до `10 MiB`, `2560px`, `4_000_000 px`
- `heavy` до `64 MiB`, `5120px`, `12_000_000 px`
- выше hard limits autoplay descriptor не создаётся вовсе

Grid держит дополнительный invariant:

- все видимые `standard` video cards могут autoplay'ить одновременно
- из `heavy` video cards одновременно autoplay'ит максимум одна
- autoplay разрешён только для committed prefix текущего generation; `measuring` больше не обнуляет already-committed autoplay path
- autoplay gating использует expanded autoplay window (`viewport ± 50%` его высоты): playback surface должна быть покрыта этим окном минимум на `50%`, чтобы video успевало стартовать до фактического входа в viewport и гасло только после выхода
- `heavy` active card выбирается с приоритетом для реального viewport overlap: in-viewport heavy clip beats off-screen lingering heavy clip; при прочих равных побеждает top-most candidate

Frontend feed-video runtime теперь использует единый poster contract для single-video cards:

- `FeedVideoSurface` и poster-only branches share one poster candidate chain
- candidate order такой:
  - `feed_playback.poster_preview_path`
  - `preview_manifest.primary_preview_path`
  - tile-level preview
  - block-level thumb
- autoplay ineligible или delayed card остаётся normal video card с постером и `PlayBadge`, а не отдельной “legacy thumb branch”

Оставшийся следующий шаг здесь уже не про закрытие базового split, а про возможное future hardening:

- если реальный runtime покажет ещё сложные video edge cases, текущий frontend poster resolver можно будет поднять в явный backend-derived feed-video descriptor
- widened autoplay window остаётся частью activation policy, но уже работает поверх unified poster contract

## Components

```
┌─────────────────────────────────────────────────────┐
│                    Tauri Shell                        │
│  ┌──────────────────┐    ┌────────────────────────┐  │
│  │   React Frontend  │◄──►│     Rust Backend       │  │
│  │                    │    │                        │  │
│  │  Grid / Cards      │    │  Commands (IPC)        │  │
│  │  Tag Sidebar       │    │  ├── blocks.rs         │  │
│  │  Search            │    │  ├── tags.rs           │  │
│  │  Channel View      │    │  ├── search.rs         │  │
│  │  Detail View       │    │  └── thumbnails.rs     │  │
│  └──────────────────┘    │                        │  │
│                           │  Indexer               │  │
│                           │  ├── watcher (notify)  │  │
│                           │  ├── scanner           │  │
│                           │  └── frontmatter       │  │
│                           │      parser            │  │
│                           │                        │  │
│                           │  DB (rusqlite)         │  │
│                           │  └── FTS5 search       │  │
│                           │                        │  │
│                           │  Thumbnail Generator   │  │
│                           │  └── image crate       │  │
│                           │                        │  │
│                           │  Import (Are.na)       │  │
│                           │  └── ureq HTTP client  │  │
│                           └────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌──────────────────────┐
              │ Source Vault (files)   │
│                      │
│  *.md + media files   │
│  (flat structure)     │
│                      │
│  .arena/vault-id     │
              └──────────────────────┘
                          │
                          ▼
              ┌──────────────────────┐
              │ Local Derived Store   │
              │ (per-device app data) │
              │                      │
              │  index.db            │
              │  thumbs/ previews/   │
              │  cache/audio/        │
              │  manifests/          │
              └──────────────────────┘
```

## Article Audio Contract

Article audio — отдельный manual pipeline поверх `article` blocks. Это не source-vault feature и не inline markdown mutation.

Ключевой контракт:

- audio не существует по умолчанию;
- пользователь явно создаёт local audio rendition кнопкой `Create Audio`;
- повторное действие удаляет local audio rendition;
- freshness определяется по `PreparedArticleSpeech.text_hash`, а не по существованию старого файла;
- desktop и iOS делят один Rust speech-prep contract, но хранят audio artifacts в своих local stores.

Shared data contract:

- `PreparedArticleSpeech`
  - `speakable_text`
  - `text_hash`
  - `language_tag`
- `ArticleAudioState`
  - `status`
  - `audio_path`
  - `duration_ms`
  - `last_position_ms`
  - `completed_at`

Desktop хранит audio artifacts в per-vault derived store:

```text
~/Library/Application Support/com.mine.app/vaults/<vault-id>/cache/audio/
  <slug>.json
  <slug>.wav
```

iOS хранит audio artifacts в app-local storage, keyed by hashed vault path:

```text
Application Support/Mine/ArticleAudio/<vault-hash>/
  <slug>.json
  <slug>.caf
```

Speech-prep живёт в чистом Rust domain module и исключает из озвучки non-prose markdown:

- изображения
- raw URLs
- code fences
- inline code
- tables

Desktop UI contract:

- `ArticleAudioControls` рендерится в fixed metadata rail `Detail`
- `ArticleAudioGatewayProvider` инжектит active platform adapter в React tree
- `ArticleAudioControls` не импортирует Tauri article-audio APIs напрямую
- `article-audio-updated` refreshes UI после generate/delete/invalidate
- playback position persists on pause/end/unmount
- desktop generation идёт через native macOS helper на `AVSpeechSynthesizer.write`
- helper буферизует source PCM и делает single-pass conversion в `.wav`, чтобы не вносить chunk-boundary distortion при desktop synthesis
- desktop sidecar хранит `format_version = 2`, `generation_backend = apple_avspeech_v2`, `voice_id`, `voice_name`
- legacy desktop artifacts (`format_version < 2`, `.m4a/.aiff/.caf`) invalidated on read и удаляются cleanup path'ом

iOS UI contract:

- `AudioSection` рендерится под body H1/display title + author и перед body
- `ArticleAudioService` отвечает за generate/delete/state resolution
- `ArticleAudioController` отвечает за play/pause/resume/persistence

### iOS Architecture

```
┌───────────────────────────────────────────────┐
│              iOS App (SwiftUI)                 │
│                                                │
│  GridView ──► DetailView                       │
│  (@State навигация, без NavigationStack)       │
│  CardViews: Social, Image, Article, Link, Video│
│  LoopingVideoView (AVPlayerLooper — автоплей)  │
│  AudioSection + ArticleAudioController         │
│       │                                        │
│  VaultViewModel (@MainActor)                   │
│       │                                        │
│  ┌────▼───────────────────┐                    │
│  │  UniFFI Swift Bindings  │                   │
│  │  ArenaVault.open()      │                   │
│  │  .scanVault()           │                   │
│  │  .listBlocks()          │                   │
│  │  .prepareArticleSpeech()│                   │
│  └────────┬───────────────┘                    │
└───────────┼────────────────────────────────────┘
            │ FFI (C ABI)
┌───────────▼───────────────┐
│  core-ffi crate (Rust)     │
│  ArenaVault — Object       │
│    Mutex<Connection>       │
│  FfiLightBlock — Record    │
│                            │
│  Зависимость: local-arena  │
│  (default-features = false │
│   → без desktop/Tauri)     │
└───────────┬───────────────┘
            │
┌───────────▼───────────────┐
│  local-arena (domain +     │
│  storage, без Tauri)       │
│  Feature gate: `desktop`   │
│  → notify, trash, tauri    │
│    опциональны             │
└───────────────────────────┘
```

| Компонент | Назначение | Технология |
|---|---|---|
| SwiftUI Views | Сетка, карточки, детальный просмотр, article audio controls | SwiftUI, AVKit, AVFoundation |
| VaultViewModel | Мост SwiftUI → Rust FFI | Swift (@MainActor) |
| ArticleAudioService | Local audio generation, sidecar persistence, cleanup | Swift, AVSpeechSynthesizer |
| core-ffi | UniFFI bindings: ArenaVault Object, FfiLightBlock Record, prepared article speech | Rust, uniffi |
| local-arena | Domain + storage (общий с десктопом) | Rust, rusqlite |
| xcframework | Скомпилированная библиотека для device + simulator | Xcode, lipo |

**Ключевые решения iOS:**
- `Mutex<Connection>` — UniFFI Object должен быть `Send + Sync`, rusqlite Connection — нет
- Feature gate `desktop` — Tauri, notify, trash опциональны; iOS использует только domain + storage
- Без `NavigationStack` — резервирует ~100px под nav bar даже при `.toolbar(.hidden)`; ручная навигация через `@State`
- `UILaunchScreen` (пустой dict в Info.plist) — обязательно, иначе iOS запускает app в compatibility mode

| Component | Purpose | Technology |
|---|---|---|
| Tauri Shell | Нативное окно, IPC между фронтом и бэком | Tauri v2 |
| React Frontend | Сетка карточек, навигация по коллекциям, поиск | React 19 + Vite + TypeScript |
| Rust Commands | API для фронтенда: CRUD блоков, коллекции, поиск | Rust, `#[tauri::command]` |
| Indexer | Сканирование vault, парсинг frontmatter, file watcher | Rust, notify crate |
| Frontmatter Parser | Извлечение атрибутов из `.md` файлов | Rust (yaml parsing) |
| DB | Поисковый индекс, collection-ref cache, список каналов | rusqlite + FTS5 |
| Thumbnail Generator | Превью 240px: изображения (resize), статьи (text-to-image) | Rust, image + ab_glyph + imageproc |
| Import | Импорт каналов из Are.na | Rust, ureq (sync HTTP) |
| Web Clipper | Chrome/Safari расширение: сохранение из браузера | Manifest V3, Defuddle, native messaging |
| Native Host | Мост между расширением и vault (stdin/stdout JSON + локальный HTTP upload) | Rust (bin/native_host.rs), ureq, tiny_http, url, getrandom |
| Vault | Пользовательские файлы на диске | Файловая система |

### Frontend rendering model

- `App.tsx` больше не хранит в памяти весь корпус `LightBlock` ради клиентской фильтрации. Горячий путь — `list_grid_blocks(current_tag)`: backend сразу отдаёт карточки текущего маршрута, исключает channel-документы и не передаёт per-block tag arrays. Полные теги блока догружаются через `get_block(slug)` только когда открыт hover/context menu или Detail.
- Открытие vault двухфазное: `select_vault` / `get_vault_path` поднимают SQLite, watcher и последний индексированный snapshot сразу, а `full_scan()` уходит в фоновый поток. Фронтенд слушает `vault-sync-started` / `vault-sync-finished` и обновляет snapshot после завершения синхронизации, не блокируя первый usable paint.
- Переключение vault не делает `window.location.reload()`. `App.tsx` remount'ит `AppWithVault` по `key={vaultPath}`, сбрасывает локальное состояние и игнорирует stale async-ответы через `vaultPathRef + requestId`.
- `App.tsx` держит per-route snapshot cache (`tag -> GridSnapshot`). Повторный переход в уже посещённый канал сначала применяет локальный snapshot синхронно, а taxonomy (`list_tags` / `list_channels`) не перезапрашивается на чистом route switch. Это убирает лишний IPC round-trip и второй `list_grid_blocks` на старте после `setTags/setChannels`.
- `Grid.tsx` использует собственный windowed masonry renderer: карточки позиционируются абсолютно, контейнер получает вычисленную `totalHeight`, в DOM остаются только видимые элементы плюс overscan.
- Геометрия карточки больше не должна выводиться из независимых эвристик в `Card.tsx` и `cardHeight.ts`. Введён общий descriptor-driven слой (`src/lib/cardLayout.ts`): variant карточки, preview text и media geometry вычисляются один раз и затем используются и для рендера, и для расчёта высоты.
- Контентные карточки больше не кодируют spacing через variant-specific `mt-*` ветки. Введён slot-based contract: frame карточки задаёт общий inset, media идёт первой, а текстовые слоты живут единым text-stack ниже (`media -> display title/preview -> author`). Внутренние gap'ы появляются только между реально существующими соседними слотами. Это устраняет phantom top gap и сохраняет системный отступ под media.
- Layout generation теперь keyed by `layoutGenerationKey = route + width bucket + ordered block layout fingerprint`. Fingerprint включает layout-relevant content блока, в том числе `preview_manifest`, поэтому same-id content/preview changes не могут reuse stale heights/layout.
- `heightCache` и `layoutCache` generation-aware: exact heights и exact layouts кэшируются только для текущего generation key, а не просто по `slug` или набору ids.
- Layout вычисляется чистой функцией (`src/lib/masonryLayout.ts`): `containerWidth + current-generation heights -> columnCount + positions + totalHeight`. Exact heights текущего generation используются там, где они уже есть; для остальных блоков provisional path использует heuristic only for skeleton geometry.
- Visible contract двуслойный:
  - `committed` prefix — contiguous range `0..committedEndIndex`, для которой exact heights уже получены и разрешён live `Card`;
  - provisional remainder — только skeleton cards в heuristic envelope текущего generation.
- Старый `stableLayoutSnapshot` больше не участвует в visible live render path. Это устраняет системные bottom clip / white-tail баги, которые возникали, когда live card попадала внутрь stale height envelope.
- **Direction-aware overscan**: при скролле вниз forward-overscan 2200px, backward 600px. При скролле вверх — зеркально. Это предзагружает больше карточек по направлению scroll'а, уменьшая «пустые зоны» при быстром скролле.
- **Priority bounds**: зона ±1400px по направлению scroll'а, внутри которой карточки получают `priority=true`. ImageCard/LinkCard/ArticleCard используют `loading="eager"` вместо `"lazy"` — картинки начинают fetch до того как пользователь до них доскроллит.
- **CLS prevention**: ImageCard при наличии `block.width`/`block.height` рендерит контейнер с `aspectRatio: W/H` и `overflow:hidden bg-accent`, картинка через `absolute inset-0 object-cover`. Размер карточки стабилен до загрузки картинки — нет layout shift.
- `computeCardHeight()` остаётся heuristic для scheduling / placeholder geometry, но не имеет права клампить live content. Hard clamp `height + overflow hidden` валиден только внутри exact committed prefix текущего generation.
- Gallery fallback contract: если у multi-image карточки нет подтверждённого tile preview asset, feed больше не размножает один block-level thumb на все tiles. Gallery tile падает в свой `source_path`, а block-level `slug.jpg` остаётся только single-preview fallback.
- Tile-level `preview_path` должен означать реально существующий derived asset
  в thumbs cache. Synthetic paths вида `<source-stem>.jpg` запрещены: если
  отдельный tile preview не создан, manifest оставляет `preview_path = null`,
  а frontend сразу рендерит `source_path` из vault. Legacy manifests с таким
  synthetic path frontend нормализует в `null`.
- Obsidian embeds use backend-resolved `source_path`: `![[name.jpg]]` may point
  to an attachment discovered by basename lookup in the vault, while
  `![alt](path)` remains strict note-relative Markdown. Detail rendering,
  feed previews, media dimensions, and thumb upgrades consume the same resolved
  vault-root-relative path from the index/manifest.
- Single-image social fallback contract: `social-single-media` больше не имеет права жёстко рендерить block-level `slug.jpg`. Для single-image X/Twitter/Instagram preview frontend сначала берёт tile-level `previewPath`, потом `source_path`, и использует `slug.jpg` только как последний fallback. Это выравнивает single-image path с `preview_manifest` contract и устраняет серый baked-text preview поверх валидной локальной картинки.
- Gallery aspect contract: composite/media-grid previews with `3+` items используют квадратный wrapper, а gallery ровно из `2` изображений использует `2:1` wrapper, чтобы две tiles оставались почти квадратными и не деградировали в узкий `1:2` crop.
- Legacy article fallback contract: если у article-карточки есть `media_urls` / `first_image`, но для строки ещё нет `preview_manifest`, feed всё равно обязан строить реальный tile set из source images. `imageCount > 1` без `mediaItems` больше не допускается, иначе карточка деградирует в пустой серый gallery wrapper.

### Sidebar preview pipeline

- Sidebar previews больше не строятся через полный `list_blocks_light()` с фильтрацией по всем тегам в памяти. Бэкенд отдаёт top-N preview rows отдельными SQL-запросами: один для `__all__`, один window-function запрос для `top N per tag`.
- Frontend считает previews производным состоянием сервера: `useChannelPreviewsEvents` делает initial refresh и затем коалесцирует `block:added`, `block:removed`, `thumb:updated`, `vault-changed` в повторный `list_channel_previews`, вместо локального patch-state.
- Таблица `blocks` хранит `thumb_format` (`jpeg` / `png`) и `thumb_mtime`. Эти поля синхронизируются в точках записи thumb (`generate_for_block`, `save_thumb`, direct create path) и позволяют `list_channel_previews` отвечать без filesystem syscall-ов на горячем пути.
- Thumbnail path остаётся стабильным `<slug>.jpg`, но content может быть JPEG
  или PNG. Custom `asset://` protocol обязан выставлять MIME по magic bytes,
  а не только по расширению, иначе transparent text thumbnails отдаются как
  `image/jpeg` и WKWebView показывает broken-image `?`.
- Legacy vault compatibility: если в `.arena/cache/thumbs/` уже лежат `.jpg`, а `thumb_format/thumb_mtime` в SQLite ещё не заполнены, `open_vault()` запускает фоновый backfill metadata и после него шлёт `vault-changed`. Это восстанавливает sidebar previews без полного rebuild index.
- Startup backlog planner для Phase 2 (`list_pending_thumb_upgrades`) тоже больше не читает thumb-файлы на main thread. Он работает через отдельный SQLite connection в `spawn_blocking`, выбирает только `thumb_format = 'png'` и восстанавливает media source из индексированных `media_file / thumbnail / first_image / media_urls`.
- Watcher больше не индексирует те же `.md` параллельно с `full_scan()` для того же vault. Пока `syncing_vaults` содержит текущий путь, `watcher/watch.rs` пропускает notify-события; это убирает `database is locked` storm и лишние `vault-changed` во время раннего startup sync.

## Data flow

### Добавление блока (drag-and-drop)

```
Пользователь перетаскивает файл в окно
    │
    ▼
Frontend: drop event → Tauri command `add_block`
    │
    ▼
Rust: копирует медиафайл в vault root
    │
    ├──► Создаёт .md файл с frontmatter (`type` hint, canonical `file` wikilink, Mine Collections, saved_at)
    │
    ├──► Thumbnail Generator: превью → .arena/cache/thumbs/
    │
    └──► Indexer: парсит Markdown/frontmatter → derives card kind → SQLite (блок, collection refs, FTS)
    │
    ▼
Frontend: получает событие → обновляет сетку
```

### Внешнее изменение (файл добавлен через Finder)

```
File watcher (notify) обнаруживает изменение
    │
    ▼
Indexer: определяет тип (create/modify/delete)
    │
    ├──► .md файл создан: парсит Markdown/frontmatter → derives card kind → индексирует
    ├──► .md файл изменён: перечитывает Markdown/frontmatter → обновляет индекс
    ├──► медиафайл создан: генерирует thumbnail (ждёт .md для полной индексации)
    └──► файл удалён: удаляет из индекса + thumbnail
    │
    ▼
Tauri event → Frontend обновляет UI
```

### Collection page → Channel

```
Пользователь видит список collection pages в sidebar
    │
    ├──► Клик по коллекции → фильтр: показать все блоки со ссылкой на эту collection page
    │
    └──► «Создать канал» → создаётся/patch'ится .md page с type: channel
         (отображается в sidebar как постоянный пункт навигации)
```

## SQLite schema (индекс)

```sql
-- Блоки (файлы)
CREATE TABLE blocks (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,           -- относительный путь .md от vault root
    block_type TEXT NOT NULL,            -- legacy frontmatter.type
    card_kind TEXT NOT NULL,             -- derived card kind: article, media, channel
    title TEXT,                          -- legacy frontmatter.title fallback
    description TEXT,
    url TEXT,                            -- source URL (для ссылок и статей)
    media_file TEXT,                     -- normalized from frontmatter file wikilink/raw value
    mime_type TEXT,
    size_bytes INTEGER,
    width INTEGER,                       -- для изображений/видео
    height INTEGER,
    saved_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    thumb_path TEXT
);

-- Collection refs (legacy physical table name)
CREATE TABLE block_tags (
    block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,                    -- semantic: CollectionRef
    PRIMARY KEY (block_id, tag)
);

-- Индекс для быстрого поиска по collection ref
CREATE INDEX idx_block_tags_tag ON block_tags(tag);

-- Collection pages (legacy physical column name)
CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    tag TEXT UNIQUE NOT NULL,            -- semantic: CollectionRef
    title TEXT NOT NULL,                 -- отображаемое имя коллекции
    description TEXT,
    color TEXT,                          -- цвет канала в UI
    icon TEXT,                           -- иконка
    position INTEGER DEFAULT 0,         -- порядок в sidebar
    created_at TEXT NOT NULL
);

-- Полнотекстовый поиск
CREATE VIRTUAL TABLE blocks_fts USING fts5(
    title, description, body,
    content='blocks',
    content_rowid='id'
);

-- Wikilinks между блоками
CREATE TABLE wikilinks (
    source_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
    target_path TEXT NOT NULL,            -- [[target]] — имя файла без .md
    PRIMARY KEY (source_id, target_path)
);
```

## Key decisions

### 001: Файлы как источник правды, SQLite как индекс

| Approach | Problem |
|---|---|
| SQLite как единственное хранилище | Данные заперты в приложении, нет доступа через Finder, сложный экспорт |
| Файлы + SQLite-индекс (chosen) | Нужен file watcher/read-time catch-up и синхронизация индекса, но данные всегда доступны |

Rationale: пользователь должен иметь возможность удалить приложение и сохранить все данные. Файлы — универсальный формат. SQLite пересобирается из файлов за секунды. Следствие этого решения: stale SQLite snapshot не имеет права скрывать существующие Markdown files; индекс должен догонять source vault на чтении, а не наоборот.

### 002: Tauri вместо Electron

| Approach | Problem |
|---|---|
| Electron | 150+ МБ, отдельный Chromium, избыточен для локального приложения |
| Tauri (chosen) | 3-6 МБ, нативный WebKit, Rust-бэкенд. Ограничения CSS (Safari-уровень) |

Rationale: приложение macOS-first, WebKit на macOS стабилен. Бэкенд на Rust идеален для файловых операций, thumbnail-генерации и SQLite. Thymer выбрал Electron из-за кросс-платформенности — у нас другие приоритеты.

### 003: Каналы — это теги, не папки [historical]

| Approach | Problem |
|---|---|
| Канал = папка на диске | Блок в нескольких каналах требует симлинков или дубликатов |
| Канал = тег в frontmatter (chosen) | Нужен парсер frontmatter, но один файл — много каналов без дублирования |

Rationale: теговая модель (как Mymind) проще и надёжнее папочной (как Are.na). Блок в 5 каналах — это 5 тегов в одном файле, а не 5 симлинков. Теги редактируются в любом текстовом редакторе.

Status: historical decision. Obsidian-first collection architecture keeps the
"not folders" part, but replaces tags with `Mine Collections`
wikilinks to collection pages.

### 004: Плоская структура vault

| Approach | Problem |
|---|---|
| Подпапки по типу/дате | Усложняет wikilinks, file watcher, перемещение файлов |
| Плоская структура (chosen) | Много файлов в одной папке, но Finder справляется, а приложение работает через индекс |

Rationale: минимальная сложность. Позже — изолированные vault'ы (проекты) для разделения контента.

### 005: Markdown + frontmatter — единый формат метаданных

| Approach | Problem |
|---|---|
| JSON-файлы для метаданных | Два формата: JSON для мета, MD для текста. Несовместим с Obsidian |
| Markdown + YAML frontmatter (chosen) | Один формат для всего. Совместим с Obsidian, любым текстовым редактором |

Rationale: пользователь может открыть любой `.md` файл в Obsidian, VS Code или текстовом редакторе и увидеть как метаданные, так и содержимое. Wikilinks работают в Obsidian нативно.

### 006: Визуальная навигация по координатам вместо индексной

| Approach | Problem |
|---|---|
| Навигация по индексу массива (index ± 1 / ± columnCount) | В masonry-сетке с разной высотой карточек визуальный сосед не совпадает с соседом по индексу — стрелка «вправо» перебрасывает в другой конец экрана |
| Навигация по `getBoundingClientRect()` (chosen) | Для каждого нажатия стрелки перебираются все карточки в DOM, фильтруются по направлению, оцениваются по расстоянию (`primaryAxis + 3 × crossAxis`). Выбирается ближайшая |

Rationale: masonry-раскладка с round-robin распределением и переменной высотой карточек делает индексную навигацию непредсказуемой. Визуальная навигация всегда соответствует тому, что видит пользователь. `getBoundingClientRect()` для ~80 видимых карточек — наносекунды.

### 007: Detail — plain div вместо Radix Dialog

| Approach | Problem |
|---|---|
| Radix Dialog (DialogOverlay + DialogContent) | Порталит в `<body>`, вне `<main>` — не участвует в stacking context приложения. Кнопка закрытия попадает под Tauri drag region (нативный перехват до CSS z-index) |
| Plain div с `absolute inset-0 z-10` внутри `<main isolation: isolate>` (chosen) | Контролируемый стекинг-контекст, кнопка X ниже 32px drag region, корректная фокусировка |

Rationale: Tauri `data-tauri-drag-region` перехватывает события указателя на нативном уровне (до CSS). Radix Dialog порталит контент за пределы `<main>`, что делает невозможным управление z-index относительно drag region. Plain div внутри `<main>` с `isolation: isolate` решает обе проблемы.

Detail top menu имеет два runtime режима: `classic` и `island`. Оба режима
используют тот же content baseline, что feed/sidebar. `classic` использует
постоянную divider line и solid `bg-accent` surface, matching нижний action
bar. `island` использует тот же border/radius contract, но поверх контента
получает лёгкий glass surface: `bg-accent/80 backdrop-blur-sm
backdrop-saturate-150`, без тени и градиента. `islands` был экспериментальным
split-variant и не является частью contract; если старое значение осталось в
`localStorage`, frontend должен fallback'иться в `island`.
Island surface компенсирует правый optical inset (`pl-3 pr-1`), потому что
иконки живут внутри `size-8` hit area: hit target остаётся 32px, а визуальный
край совпадает с текстовым краем filename.

Filename в Detail top menu является block drag handle. DnD payload всегда
передаёт `{ type: "block", slug, block }`; обычная feed card и Detail menu
попадают в один `handleCardDrop(slug, tag)` path. Drag overlay для block drag
рендерит feed-card preview фиксированной column width, а не строковый label,
чтобы размер и визуальная модель совпадали с лентой.

Когда Detail открыт, sidebar становится link-editor для открытого блока:
`App.tsx` передаёт `linkedBlockSlug`, текущие `linkedTags` и
`onToggleLinkedTag`. Если выбранный блок пришёл из лёгкого grid DTO без tags,
полные tags догружаются через `get_block(slug)`. Верхняя surface sidebar
показывает `Channels:` + selector `All / Connected`; `Connected` фильтрует
список до связанных каналов. Строка канала сохраняет обычную навигацию, а
membership меняется только прямым click/key на checkbox. Optimistic local update
синхронизирует открытую карточку сразу, затем `reloadAllSnapshots()` обновляет
grid/sidebar snapshots.

Sidebar rows не меняют identity при открытии Detail: обычный режим и
link-editor используют общий `TagNavItem`, а checkbox/more menu являются
вариантами только правого action slot. Thumbnail strip остаётся стабильным DOM,
поэтому WebKit не получает новую пачку `<img>` и не мигает при открытии
карточки.

### 008: Thumbnail-превью фильтруются на бэкенде

| Approach | Problem |
|---|---|
| Фронтенд генерирует URL из slug'а, `<img onError>` скрывает сломанные | Tauri `asset://` не всегда вызывает `onError` для несуществующих файлов. `<img>` показывает знак вопроса (macOS broken image). `display: none` блокирует `onLoad`. |
| Rust-команда `list_channel_previews` читает `thumb_format` / `thumb_mtime` из SQLite (chosen) | Горячий path sidebar не делает `exists/open/metadata` по каждому preview, но фронтенд всё равно получает только подтверждённые preview-метаданные с бэкенда. |

Rationale: бэкенд остаётся источником истины для preview-состояния, но хранит его в индексе рядом с блоком, а не вычисляет повторно через filesystem на каждый sidebar refresh. Это убирает линейный syscall-cost при старте и switch vault, не возвращая фронтенду угадывание состояния по `asset://`.

### 009: Расширение собирается через Vite (единая дизайн-система)

| Approach | Problem |
|---|---|
| Ручной CSS в расширении (`popup.css` с дублированными токенами) | Дрейф дизайна: 14 расхождений выявлено при аудите (размеры текста вне шкалы, веса 500/700, transitions, шрифт Geist Mono не подключён). Ручная синхронизация — технический долг. |
| Vite-сборка: `extension/popup/main.tsx` → React + shadcn + `global.css` (chosen) | Один источник правды. Компоненты, токены, шрифты наследуются из основного приложения. Дрейф невозможен. |

Rationale: расширение — проекция основного приложения в браузер. Различия только в адаптере (native messaging vs Tauri IPC) и layout (popup 360px vs fullscreen). Всё остальное — те же компоненты, те же токены, тот же шрифт. Стоимость: +200 КБ к размеру расширения (React + шрифты), ~100ms на hydration — незаметно для пользователя.

### 010: Нормализация тегов на границе чтения

| Approach | Problem |
|---|---|
| Нормализация при записи (clipper, create_block) | Ненормализованные теги из ручного редактирования .md или старых данных просачиваются в индекс, rename_channel не находит их (case-sensitive сравнение) |
| Нормализация при чтении из YAML (`parse_tags`) + при записи (chosen) | Двойной барьер: любой тег в любом файле нормализуется при индексации. Файл на диске может содержать `"Япония"` — в индексе будет `"япония"`. Rename сравнивает нормализованные значения. |

Rationale: файлы — источник правды (решение 001), и пользователь может редактировать их вручную. `parse_tags()` — единственная точка входа тегов из файлов в систему. Нормализация здесь гарантирует согласованность `block_tags ↔ channels` в SQLite.

Status: historical decision for the tag-based architecture. Obsidian-first
collections supersede this for Mine collection membership:
`tags` remains user-owned Obsidian metadata, while Mine collections use
`Mine Collections` wikilinks and `CollectionRef`.

### 011: Brand icon assets разделены по surface

| Approach | Problem |
|---|---|
| Один square/app icon asset для Dock, iOS, toolbar и in-page overlay | Dock показывает oversized квадрат, toolbar теряет форму reference-иконки, а in-page overlay получает слишком маленький glyph без нужной круглой кнопки |
| Surface-specific assets (chosen) | App icon, extension toolbar icon и Instagram overlay имеют разные host-маски, размеры и optical alignment, поэтому получают отдельные raster contracts |

Rationale: Apple app icon и browser toolbar icon — разные surfaces. iOS ожидает
square source и сама применяет mask. macOS Dock в Tauri получает уже готовый
app icon asset, поэтому source должен иметь transparent canvas + inset rounded
tile. Browser toolbar icon должен быть белым кругом с чёрной `m`; Instagram
overlay использует отдельный glyph-only `clipper-overlay-32.png`, который
вставляется внутрь круглой белой кнопки content script'ом. Общий glyph — строчная
`m` из Redaction 100 Italic, но bitmap assets не взаимозаменяемы.

### 012: Собственный virtualized masonry renderer вместо browser layout для больших коллекций

| Approach | Problem |
|---|---|
| CSS masonry / `grid-lanes` с тысячами DOM-узлов | Resize и переключение каналов упираются в relayout всего дерева. `content-visibility` помогает paint, но не убирает стоимость layout |
| Собственный windowed masonry renderer (chosen) | Сложнее реализация: нужен layout engine, cache высот и absolute positioning |

Rationale: на больших коллекциях bottleneck смещается с IPC на main-thread layout. Когда в DOM находятся только видимые карточки, resize и route switch перестают зависеть от общего числа блоков в разделе.

### 012: Generation-safe masonry через committed prefix

| Approach | Problem |
|---|---|
| Approximate / stale layout envelope + live card content | Live DOM может оказаться внутри height envelope другого generation → системные bottom clip и white tails |
| Full-route atomic commit | Корректно, но слишком дорого для больших vault: долгий skeleton-only first paint до измерения всей ленты |
| **Current-generation provisional layout + contiguous committed prefix** (chosen) | Сложнее state model: generation key, exact/provisional split, frontier management, generation-aware caches |

Rationale: masonry-позиция блока зависит от всех предшествующих блоков, поэтому безопасная единица commit — contiguous prefix. Grid строит provisional layout только для текущего generation, exact heights и exact layouts кэшируются по `layoutGenerationKey`, а live cards разрешены только внутри `committed` prefix текущего generation. Всё вне prefix остаётся skeleton-only. Это убирает mixed-generation envelope bugs без глобального full-route commit и делает resize / route switch deterministic.

Детальная спецификация: [SPEC_GRID.md](SPEC_GRID.md).

### 013: Two-phase thumbnail pipeline — WebView native decoder вместо Rust crate stack

| Approach | Problem |
|---|---|
| Pure Rust pipeline (`image` crate + `openh264` + `mp4`) — текущее состояние | Ограниченная поддержка форматов: `image 0.25` не декодирует VP8X WebP (Meduza, Cloudflare Images), HEIC (iPhone photos), AVIF, многие animated. `openh264` не парсит HEVC / fragmented MP4. Каждый новый формат клиппера — риск silent fallback в text placeholder |
| Upgrade Rust crates до bleeding edge, add libheif / custom webp / FFI wrappers | Dependency bloat (libheif = 40+ MB shared lib), крайне нестабильная dependency tree, всё равно отстаёт от браузерного набора форматов. Endless whack-a-mole |
| Shell out to system codecs (`sips`, `ffmpeg`, `magick`) | Platform-specific, process spawn overhead (~50ms × 1000 thumbs = неприемлемо для startup), не переносится |
| **Two-phase: Rust instant placeholder + WebView async upgrade** (chosen) | Две точки входа вместо одной, нужна координация через Tauri events. Но Phase 1 гарантирует мгновенное появление блока в sidebar (<150ms), Phase 2 upgrade'ит до правильного thumb через `createImageBitmap` + `OffscreenCanvas` в Web Worker (~300ms). WebView decoder покрывает **весь** набор форматов которые клиппер сохраняет в vault, по определению — если Detail view может отрендерить media, worker может сгенерировать thumb |

Rationale: thumbnail pipeline требует декодирование **того же** набора форматов что браузер умеет рендерить. Попытка дублировать этот набор в Rust — проигрышная битва, мы уже третий раз ловим один класс bugs на разных форматах. WebView native decoder (WKWebView → ImageIO/AVFoundation на macOS) получает поддержку форматов бесплатно от системы. Trade-off — 2-3 hops IPC (Rust event → worker → Rust write) и двухфазная асинхронность, компенсируется guaranteed instant UX через Phase 1 placeholder и self-healing через is_thumb_fresh.

Детальная спецификация: [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md).

### 014: Obsidian-first collections via wikilinks

| Approach | Problem |
|---|---|
| Continue normalized tag identity (`красивый-веб`) | Obsidian graph sees detached text metadata; human filenames are rewritten into machine-like filenames; `tags` conflicts with user-owned Obsidian tags |
| Dual runtime support for old and new collection formats | Permanent complexity in every write/read path and unclear source of truth |
| One-time migration + single canonical wikilink format (chosen) | Requires a careful dry-run/backup/apply migration, but leaves one clear long-term contract |

Rationale: Mine collections should be understandable in Obsidian without a Mine
runtime. A card should link to `[[Красивый веб]]`, and the collection page
should be `Красивый веб.md`. Legacy encodings are inputs to migration, not a
second permanent format.

### 015: Native-host write and fetch hardening

| Approach | Problem |
|---|---|
| Trust SQLite-only slug collision checks | Disk-only files can be overwritten when the index is stale or empty |
| Write markdown first, then media | Media-copy failures leave orphan `.md` files; later retries see inconsistent state |
| String-prefix URL checks for downloaded media | Private-network / localhost URLs and ambiguous host forms can bypass intent |
| **Disk-inclusive slug checks + create-new writes + parsed URL validation** (chosen) | Slightly more IO per save, but preserves the filesystem as source of truth and rejects unsafe native-host fetches before download |

Rationale: browser input is untrusted even when it comes from the extension UI.
The native host must be authoritative for slug uniqueness, collection refs,
new-file creation, upload limits, and media-fetch boundaries. New block writes
now avoid overwriting existing `.md` or media files, roll back copied media when
the final block write fails, and validate remote fetch hosts through parsed
HTTP(S) URLs plus DNS/IP checks before `ureq` runs.

Large clipper uploads use a two-phase commit. The HTTP `/upload` endpoint writes
binary payloads into the local derived store under `pending_uploads/<upload_id>`
and returns `pending_uploads_v1` capability data through `get_status`. Only
`save_block(pre_uploaded_id)` copies that payload into the source vault and
writes the markdown card. If that second phase fails or the browser loses the
native-message response, the pending payload remains recoverable in the desktop
recovery surface; the source vault is not polluted with unreferenced media by
the happy-path upload step.

### 016: Filesystem-first visibility over SQLite-only route reads

| Approach | Problem |
|---|---|
| Trust current SQLite snapshot and rely on watcher/background `full_scan` | A valid Markdown file can exist in the vault but remain invisible in the UI until a later scan, which breaks the Obsidian-like contract |
| Synchronous full vault scan before every route read | Correct but too expensive for large vaults and defeats the startup/performance reset |
| **Bounded read-time catch-up before route reads** (chosen) | Adds small filesystem IO to read paths, but preserves correctness: missing/changed/deleted `.md` files are reconciled before final route data is returned |

Rationale: Local Arena's primary contract is "the app is a window into the
Markdown vault". The derived index may be stale, absent, or rebuilt; user-visible
truth must still come from source-vault files. The watcher and native-host direct
upsert remain performance optimizations only.

## Dependencies

| Package | Version | Purpose | License |
|---|---|---|---|
| tauri | 2.x | Десктопная оболочка | MIT/Apache-2.0 |
| rusqlite | latest | SQLite из Rust | MIT |
| notify | latest | File system watcher | CC0/Artistic-2.0 |
| image | latest | Обработка изображений | MIT/Apache-2.0 |
| ab_glyph | latest | Парсинг TTF-шрифтов для текстовых миниатюр | Apache-2.0 |
| imageproc | latest | Растеризация текста на изображения | MIT |
| serde | latest | Сериализация | MIT/Apache-2.0 |
| serde_yaml | latest | Парсинг YAML frontmatter | MIT/Apache-2.0 |
| thiserror | latest | Типизированные ошибки | MIT/Apache-2.0 |
| url | 2.x | URL parsing and host classification in native host | MIT/Apache-2.0 |
| getrandom | 0.3.x | OS random bytes for native-host upload tokens | MIT/Apache-2.0 |
| tiny_http | latest | Local HTTP upload server for extension binary payloads | MIT/Apache-2.0 |
| react | 19.x | UI-фреймворк | MIT |
| vite | latest | Сборщик | MIT |
| ureq | 2.x | Синхронный HTTP-клиент (импорт Are.na) | MIT/Apache-2.0 |
| tailwindcss | 4.x | Стилизация | MIT |
| shadcn/ui | latest | Компонентная библиотека: 14 примитивов (Button, Dialog, Command и др.) | MIT |
| radix-ui | latest | Headless UI-примитивы (основа shadcn) | MIT |
| cmdk | latest | Command palette (поиск Cmd+K) | MIT |
| lucide-react | latest | Иконки (замена ручных SVG) | ISC |
| class-variance-authority | latest | Варианты компонентов (CVA) | Apache-2.0 |
| tw-animate-css | latest | CSS-анимации для Tailwind v4 | MIT |
| react-router | 7.x | Роутинг | MIT |
| @dnd-kit/core | 6.3.x | Drag-and-drop (Pointer Events вместо HTML5 DnD — обходит перехват Tauri WKWebView) | MIT |
| react-markdown | latest | Рендеринг markdown в Detail.tsx | MIT |
| remark-gfm | latest | GFM-расширение для react-markdown | MIT |
| @tailwindcss/typography | latest | Стилизация prose-контента | MIT |
| Defuddle | bundled | Извлечение статей и Markdown-конвертация в content script | MIT |
| eslint + typescript-eslint | 10.x | Линтинг фронтенда (TypeScript) | MIT |
