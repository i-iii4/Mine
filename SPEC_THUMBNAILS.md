# SPEC: Thumbnail Pipeline

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [DEVLOG.md](DEVLOG.md)

## Status

Implemented contract. Thumbnail generation is centralized in
`src-tauri/src/storage/thumbnails.rs`, with native-host and watcher paths both
calling `generate_for_block`. SQLite `thumb_format` / `thumb_mtime` are the
hot-path preview metadata for sidebar queries.

## Context

Прошлый thumbnail pipeline был полностью Rust-based, с зависимостями на `image` crate (форматы), `openh264` + `mp4` (video frame extraction), `ab_glyph` + `imageproc` (text baking). Архитектура приводила к повторяющимся отказам:

1. **Ограниченная поддержка форматов Rust ecosystem'а.** `image = "0.25"` не декодирует VP8X Extended WebP (стандартный output Meduza, Cloudflare Images, Twitter), не декодирует HEIC/HEIF (iPhone photos), не декодирует AVIF (feature-flag drift). `openh264` не парсит HEVC и fragmented MP4.
2. **Дублирование cascade logic** между native host и watcher handler (устранено в `f726854`).
3. **Silent fail при decode error** → блок пропадает из sidebar (устранено fallback chain в `f726854`).
4. **Stale thumbs с неправильным content** проходили mtime check (устранено magic bytes check в `f726854`).

История отказов задокументирована в DEVLOG: `32d452e`, `f726854`, и последний инцидент с VP8X webp от Meduza (`sem-altman-...`) где Rust decode упал, hotfix pipeline свалился в text placeholder.

Фундаментальная причина всех этих инцидентов — **попытка поддержать в Rust полный набор форматов, который поддерживает browser**. Browser (WKWebView на macOS через ImageIO/AVFoundation) декодирует всё что нужно расширению по определению — если Detail view может показать media, значит codec доступен в системе. Цель этого spec'а — сделать WebView **единственным** decoder для thumbnail pipeline, устранив зависимость от Rust crate stack для форматов.

## Invariants (что должно быть true всегда)

Pipeline обязан удовлетворять **каждому** из этих требований без компромиссов. Нарушение любого — bug, не feature request.

**I1. Мгновенное появление.** С момента когда расширение сохранило блок до момента когда thumb виден в sidebar проходит не более **150ms**. Включает: native host write, file watcher, event dispatch, React re-render.

**I2. Корректность для всех форматов расширения.** Любой формат media который расширение сохраняет в vault через `localize_body_images` (текущие форматы: JPEG, PNG, GIF, WebP во всех вариантах, HEIC, AVIF, MP4 H.264/HEVC, WebM VP8/VP9) получает валидную визуальную миниатюру — либо сам кадр изображения/видео, либо baked text fallback для pure-text блоков.

**I3. Нет «пустых» sidebar карточек.** Блок, у которого есть preview в
`list_channel_previews`, **всегда** рендерится визуально непустым.
`list_channel_previews` возвращает только строки с подтверждённым
`thumb_format IS NOT NULL`; frontend дополнительно фильтрует `has_thumb=false`
как defense-in-depth. Нет case'ов «строка есть, а thumb не существует».

**I4. Плавный скролл при 100+ каналах × 10 thumbs.** Sidebar скроллится со скоростью display refresh rate (60Hz минимум, 120Hz на ProMotion). Frame budget 16ms не нарушается на машине с M-series chip.

**I5. Self-healing.** Любой corrupt или неправильный thumb на диске автоматически перегенерируется при следующем запуске app или при следующем изменении source файла. Нет manual cleanup требований.

**I6. Визуальная сохранность.** Работающие сейчас thumbs (JPEG image blocks, text article fallbacks) рендерятся после миграции pixel-identical. Pipeline меняет только **broken cases**.

**I7. Text articles показывают запечённый текст, articles с media показывают media.** `list_channel_previews` корректно различает text и media блоки через `is_text` флаг, frontend применяет `dark:invert` только для text.

**I8. Нет явного блокирующего I/O на hot path.** Save операция возвращает управление расширению не дольше чем за 150ms включая write thumb. Полноценная генерация image thumb (через WebView) может занимать больше, но не блокирует save response.

**I9. Генератор записывает геометрию того, что создал.** Каждая функция
генерации возвращает `PreviewDimensions` записанного файла, и эти размеры
доходят до `preview_manifest` (`preview_width`/`preview_height` у манифеста и у
каждого tile). Отбрасывать возвращаемое значение запрещено: лента раскладывает
карточку по артефакту, а не по источнику, и другого владельца у этого факта
нет. Размеры источника остаются отдельным полем и отдельным типом
(`SourceDimensions`) — они питают пиксельные бюджеты autoplay и строку
`Resolution`. Полный контракт:
[SPEC_CARD_MEDIA_GEOMETRY.md](SPEC_CARD_MEDIA_GEOMETRY.md).

Для composite-превью геометрия артефакта описывает готовый коллаж, а не его
источники: плитки собираются `resize_to_fill` в фиксированные слоты, поэтому
пропорция коллажа не равна пропорции ни одного исходника.

## Non-goals

Чего pipeline явно **не** делает:

- **N1.** Не поддерживает форматы media которых нет в расширении. Если расширение когда-то начнёт сохранять SVG — это расширение pipeline, не automatic.
- **N2.** Не пытается валидировать content thumb файла beyond magic bytes check (JPEG/PNG prefix). Глубокая валидация image integrity — out of scope.
- **N3.** Не делает reactive update thumbs если пользователь руками заменил media file в vault (watcher detects и перегенерирует — это отдельный flow через `VaultEvent::MediaChanged`, специфицирован в SPEC_INTEGRATION.md).
- **N4.** Не оптимизирует качество thumb (quality 85 JPEG, fixed 640×640 max). Tuning качества — отдельная задача.
- **N5.** Не делает real-media WebView upgrade для блоков, сохранённых из
  расширения **пока main app закрыт**. Native host всё равно создаёт `.md`,
  media-файл, Phase 1 thumb и синхронизирует thumb metadata; upgrade до real
  image/video preview происходит при следующем открытии main app.

## Уровни миниатюр

**Статус: решение принято 21.08.2026, не реализовано.** Ниже — целевой
контракт; действующий код держит один уровень 640 px.

### Почему одного уровня мало

Один файл обслуживает три поверхности, и они выводят его в размерах,
различающихся в двадцать раз:

| Поверхность | Размер вывода | Источник сегодня |
|---|---|---|
| Лента | от 220 px (ширина колонки) | 640 px |
| Граф, обзор | 32 px | 640 px |
| Боковая панель | 32 px (`size-8`) | 640 px |

Двадцать раз по стороне — это четыреста раз по площади распакованного
изображения. На хранилище пользователя (572 карточки, 2050 файлов, 416 МБ)
это измерялось как 613 МБ распакованных превью в веб-процессе.

### Целевые уровни

| Уровень | Длинная сторона | Кто использует |
|---|---|---|
| `full` | 640 px | лента |
| `micro` | 64 px | обзор графа, полоска в боковой панели |
| `zoom` | 256 px | граф при приближении, только узлы в кадре |

`micro` покрывает вывод в 32 логических пикселя с запасом на удвоенную
плотность экрана. `zoom` покрывает потолок увеличения узла в графе — 100
логических пикселей, то есть 200 физических (см. SPEC_GRAPH_VIEW.md, раздел
«Размер узла»).

### Правила

**П1. Мелкие уровни производятся из `full`, а не из оригинала.** Уменьшение
готовой миниатюры дешевле повторной распаковки исходника, который может
весить десятки мегабайт.

**П2. `zoom` загружается только для узлов, попавших в кадр.** Уровень тяжёлый —
262 КБ распакованных против 16 КБ у `micro`. При приближении в кадре
оказываются десятки узлов, а не тысячи, поэтому суммарный вес остаётся
единицами мегабайт. Загружать `zoom` для всего снимка запрещено.

**П3. Один адрес — одна копия в памяти.** Движок кэширует распакованное
изображение по URL: пока лента и граф читают один файл, вторая копия не
создаётся. Введение отдельных уровней означает отдельные копии, и это
осознанная плата: без них граф вынужден распаковывать 640 px ради вывода в 32.

**П4. Уровни не заменяют друг друга при промахе.** Если `micro` ещё не
сгенерирован, поверхность показывает своё состояние ожидания, а не подставляет
`full`. Подстановка тяжёлого уровня свела бы экономию на нет ровно в момент
первого показа, когда она нужнее всего.

### Что известно о поведении памяти

Когда карточка покидает окно отрисовки ленты и её `<img>` удаляется, WebKit
переводит ресурс в разряд мёртвых, но **не освобождает сразу**: вытеснение
происходит при переходе порогов кэша или под давлением системы, а буферы
помечены как отдаваемые ОС ([WebKit MemoryCache](https://trac.webkit.org/wiki/MemoryCache)).

Практическое следствие: на маленьком хранилище граф успевает переиспользовать
то, что распаковала лента, и отдельный `micro` даёт небольшой перерасход. На
большом кэш переполняется, ранние картинки вытесняются, переиспользовать
нечего — и `micro` даёт экономию порядка гигабайта. Уровни вводятся ради
второго случая.

### Цена на диске

`micro` весит единицы килобайт, `zoom` — десятки. На хранилище в 57 000
карточек это порядка 200 МБ и 1,5 ГБ соответственно поверх примерно 41 ГБ
уровня `full`. То есть на диске уровни почти бесплатны; выигрыш — в памяти.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Chrome Extension (clipper)                                           │
│  │                                                                   │
│  │ stdin/stdout JSON                                                 │
│  ▼                                                                   │
│ Native host (Rust binary, child of browser)                          │
│  │                                                                   │
│  │ 1. localize_body_images — download inline media to vault          │
│  │ 2. write_block_file — .md frontmatter + body                      │
│  │ 3. upsert_block → SQLite                                          │
│  │ 4. PHASE 1: generate instant thumb                                │
│  │    ├─ sniff first 3 bytes of media file                           │
│  │    ├─ if JPEG/PNG magic → generate_thumbnail (Rust decode, fast)  │
│  │    └─ else → generate_text_thumbnail (fallback label, always works)│
│  │ 5. sync_thumb_metadata → SQLite                                   │
│  │ 6. Response OK                                                    │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                │ (file watcher via notify crate)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Main app (Tauri process, WebView host)                               │
│                                                                      │
│  Rust side:                                                          │
│   ├─ watcher::handle_event(BlockChanged)                             │
│   │   ├─ index_md_file → upsert to SQLite                            │
│   │   ├─ generate_for_block (Rust cascade, works for simple formats) │
│   │   └─ emit Tauri event "block:added" { tag, slug, is_text }       │
│   │                                                                  │
│   └─ For blocks where Rust cascade produced text placeholder BUT     │
│      block has embedded media → emit "thumb:upgrade-requested"       │
│      { slug, media_path, kind: Image | Video }                       │
│                                                                      │
│  Frontend (React + WebView):                                         │
│   ├─ useChannelPreviews hook                                         │
│   │   ├─ subscribes to "block:added" → insert into channelPreviews   │
│   │   └─ subscribes to "thumb:updated" → bust <img> cache            │
│   │                                                                  │
│   └─ useThumbnailUpgrade hook                                        │
│       ├─ subscribes to "thumb:upgrade-requested"                     │
│       ├─ enqueues into thumbWorker (Web Worker, 4 concurrent)        │
│       ├─ worker: fetch(asset://) → createImageBitmap → Canvas resize │
│       │   → OffscreenCanvas.convertToBlob('image/jpeg', 0.85)        │
│       ├─ invoke("save_thumb", { slug, bytes })                       │
│       └─ Rust writes vault.thumb_path(slug) → emit "thumb:updated"   │
│                                                                      │
│  Sidebar (virtualized, window of visible channels):                  │
│   └─ <img src={asset://<derived>/cache/thumbs/<slug>.jpg}>           │
└──────────────────────────────────────────────────────────────────────┘
```

Pipeline — two-phase:

- **Phase 1 (instant, Rust-synchronous)**: thumb файл **всегда** появляется на диске в пределах save response. Для simple formats (JPEG/PNG) это real image thumbnail. Для всего остального — text placeholder.
- **Phase 2 (async, WebView-decoded)**: для блоков с placeholder thumb, main app в фоне генерирует правильный thumb через browser native decoder, пишет на диск, шлёт event в sidebar для cache bust.

Для большинства image blocks (JPEG/PNG из 90% источников) Phase 2 **не требуется** — Phase 1 даёт финальный результат. Phase 2 нужен только для exotic forматов (webp VP8X, HEIC, AVIF) и video.

### Feed thumb-версия и height re-fit

`thumb:updated` больше **не** инвалидирует route-снапшоты и не рефетчит грид.
Хотя `save_thumb` / `save_tile_poster` переписывают файл (и иногда
`preview_manifest`), строка блока байт-идентична, поэтому grid-рефетч свёлся бы к
no-op по пикселям, одновременно прогоняя весь проскролленный диапазон через IPC —
storm во время Phase-2 backlog. Вместо этого введена per-slug feed thumb-версия
(`?v=N` в URL тумба/постера): `App.tsx` инкрементирует её в обработчике
`thumb:updated` только для slug, присутствующего в текущей ленте, и пробрасывает
`App → Grid → GridItem → Card` (`thumbVersions`). Это перезапрашивает WebView
только у затронутой карточки, не трогая остальные.

Полный рефетч ленты — и вместе с ним height re-fit по `preview_manifest` /
`media_dimensions` для свежей карточки, впервые проиндексированной до того, как его
изображение стало декодируемым (квадратный fallback-аспект даёт серый хвост под
`computeCardHeight`, см. `SPEC_GRID.md`), — остаётся только для реальных событий
изменения ленты: `vault-changed`, `block:added`, `block:removed` и навигации.
Покрыто `src/App.test.tsx` («bumps only the affected card's thumb version on
thumb:updated without reloading the feed», «does not bump the thumb version or
reload the feed for a card outside the current feed»).

## Data Model

### File layout

```
~/Library/Application Support/com.mine.app/vaults/<vault-id>/
└── cache/
    └── thumbs/
        └── <slug>.jpg         # Thumb file, always .jpg extension
```

Thumb file extension **всегда** `.jpg` независимо от actual content. App
`asset://` protocol sniff'ит response MIME по magic bytes, не по extension —
иначе WKWebView может получить PNG body как `image/jpeg` и показать
broken-image placeholder.

Actual content варианты:
- **JPEG** (magic `FF D8 FF`): image blocks (image thumbnail) или image upgrade от Phase 2
- **PNG** (magic `89 50 4E`): text-baked thumbnails для pure-text article fallback (PNG with RGBA transparency для dark-mode `invert` CSS trick)

Text-baked thumbnails use bundled Geist Regular with Latin and Cyrillic
coverage. Changing this font is a cache-format change: bump
`THUMB_FORMAT_VERSION` so stale baked text previews are regenerated instead of
showing old missing-glyph boxes.

Text-baked thumbnails are sidebar/list micro-preview assets, not source media.
Pure-text hover previews must render the card text directly instead of showing
the baked PNG as a large media area.

`is_thumb_fresh` валидирует оба формата через magic bytes check (см. SPEC_STORAGE.md `storage/thumbnails`).

Tile-level `preview_path` в `preview_manifest.tiles[]` разрешён только если
он указывает на реально существующий derived preview в thumbs cache. Если
отдельный tile preview не создавался, `preview_path = null`, а consumer
использует `source_path` из vault. Synthetic `<source-stem>.jpg` paths
запрещены: они создают 404 в `asset://.../cache/thumbs/` и broken-image flash.

### Persistent read model (Rust side)

SQLite stores thumbnail read-model metadata on `blocks`:

- `thumb_format`: `jpeg` or `png`, detected from actual file magic bytes.
- `thumb_mtime`: unix timestamp from the on-disk thumb file.

`list_channel_previews` and `list_channel_previews_by_tag` use these columns and
return only rows where `thumb_format IS NOT NULL`. Filesystem probing belongs to
write/repair paths (`generate_for_block`, `save_thumb`,
`sync_thumb_metadata`, metadata backfill), not to the hot sidebar read path.
Full `IndexedBlock` DTOs also carry `thumb_format` / `thumb_mtime`, so compact
previews outside the sidebar (currently Related Notes rows) use the same
confirmed read-model metadata instead of optimistic `<slug>.jpg` probing.

### In-memory state (Frontend side)

```typescript
// Worker queue state (useThumbnailUpgrade hook)
type ThumbUpgradeRequest = {
  slug: string;
  mediaPath: string;  // asset:// URL
  kind: "image" | "video";
};

type WorkerState = {
  queue: ThumbUpgradeRequest[];
  inflight: Set<string>;  // slugs currently being processed
  concurrency: 4;
};

// Channel preview state (App.tsx)
type PreviewCard = {
  url: string;  // asset:// URL with optional ?v=<timestamp> cache buster
  text: boolean;
};
type ChannelPreviews = Map<string, PreviewCard[]>;
```

`concurrency: 4` относится только к image-worker (`src/workers/thumbWorker.ts`,
`MAX_CONCURRENCY = 4`), декодирующему изображения off-main-thread через
`createImageBitmap`. Видео и tile-постеры декодируются на main-thread (у
Dedicated Worker нет `<video>`), поэтому идут через `DecodeQueue`
(`src/lib/decodeQueue.ts`) с `concurrency = 2`, дедупом по ключу и одним ретраем
на сессию: при неудаче — повтор через ~30 с backoff, после исчерпания —
`console.warn` и отложить до следующего запуска.

## Phase 1: Instant placeholder (Rust synchronous)

Runs inside native host `handle_save_block` **before** the response is sent to the clipper.

### Input

```rust
struct SaveBlockParams {
    block_type: BlockType,  // legacy compatibility input
    title: Option<String>,  // legacy compatibility input only
    body: String,
    image_url: Option<String>,  // main media URL for image-type blocks
    // ... other fields
}
```

### Content sniff

После download и localize_body_images, Phase 1 определяет **first media file** для thumb:

```
if frontmatter.file points to an existing image/video:
    candidate = downloaded main media path
elif block has frontmatter.thumbnail field pointing to local file:
    candidate = vault/<thumbnail field>
elif derived card_kind == Article:
    candidate = first local embedded media in body (`![[local_file]]`, `![[local_file|alt]]`, legacy `![](local_file)`) via `find_first_local_media`
else:
    candidate = None
```

### Decision tree

```
if candidate is None:
    # Pure text article or no media
    generate_text_thumbnail(display_title, body, thumb_path)  # always succeeds
    return ThumbSource::Text

read first 12 bytes of candidate file

if bytes[0..3] == [0xFF, 0xD8, 0xFF]:  # JPEG
    generate_thumbnail(candidate, thumb_path, 640)  # Rust decode, always works for JPEG
    return ThumbSource::Image

if bytes[0..4] == [0x89, 0x50, 0x4E, 0x47]:  # PNG
    generate_thumbnail(candidate, thumb_path, 640)  # Rust decode, always works for PNG
    return ThumbSource::Image

if bytes[0..3] == [0x47, 0x49, 0x46]:  # GIF
    generate_thumbnail(candidate, thumb_path, 640)  # Rust decode, first frame
    return ThumbSource::Image

# Anything else (WebP variants, HEIC, AVIF, TIFF, video, exotic formats):
# Rust может упасть — сразу пишем text placeholder from display_title or
# fallback_label. Empty-body media clips usually have no display title, so the
# filename/slug fallback label is required.
generate_text_thumbnail(display_title.or(fallback_label), body, thumb_path)
return ThumbSource::Text
```

### Failure handling

`generate_thumbnail` на sniffed JPEG/PNG/GIF не должна фейлиться в Phase 1 (content уже валидирован magic bytes). Если всё же фейл — graceful fallback на `generate_text_thumbnail`. Это edge case corrupted file, не ожидается в production.

`generate_text_thumbnail` не имеет пути к failure (no I/O dependencies, pure compute over `ab_glyph`/`imageproc`). Не может вернуть `Err` при non-disk-full условиях.

### Timing budget

- File open + 12-byte read: <1ms
- Magic byte check: <0.1ms
- `generate_thumbnail` для 500×500 JPEG: ~15-40ms
- `generate_text_thumbnail`: ~20-30ms
- Disk write: ~5-10ms

**Total Phase 1 budget**: 50ms для Image blocks, 30ms для text placeholder. Well within save response budget.

## Phase 2: WebView upgrade (async background)

Runs in main app, triggered either by:
1. `"block:added"` event from watcher for newly saved block, if Rust cascade produced placeholder
2. `full_scan` at app startup, enumerating blocks that need upgrade

### Enqueue logic (Rust side)

After `generate_for_block` completes, Rust checks: was result `ThumbSource::Text`,
**and** does the block have local media that could be decoded by WebView?

```rust
fn needs_upgrade(block: &Block, result: ThumbSource) -> Option<UpgradeRequest> {
    match result {
        ThumbSource::Image | ThumbSource::Video => None,  // already real
        ThumbSource::Text if block.first_media_is_pure_text() => None,  // correct final
        ThumbSource::Text => {
            // Block has embedded media that Rust couldn't decode — ask WebView
            let first_media = find_first_local_media_any(&block.body)?;
            Some(UpgradeRequest {
                slug: block.slug.clone(),
                media_path: vault.root().join(&first_media),
                kind: classify_media_kind(&first_media),  // Image or Video
            })
        }
    }
}
```

### Event emission

Rust emits Tauri event `"thumb:upgrade-requested"` with payload:
```typescript
type UpgradeRequest = {
  slug: string;
  mediaPath: string;   // absolute file path, will be converted to asset:// by frontend
  kind: "image" | "video";
};
```

Frontend `useThumbnailUpgrade` hook subscribes and enqueues.

### Dispatch, dedup and listen race

Стартовая энумерация `list_pending_thumb_upgrades` и live-события
`thumb:upgrade-requested` идут через один общий `dispatch` (`planThumbUpgrade`,
`src/lib/thumbUpgradePlan.ts`) с едиными дедуп-структурами: image-путь дедупится
по slug, video/tile — внутри `DecodeQueue` по ключу, поэтому один и тот же target
не обрабатывается дважды при пересечении startup backlog и live-событий.
Image-запросы, пришедшие до готовности worker'а, буферизуются и сливаются, как
только worker поднялся, — событие в этом окне не теряется. После установления
`listen`-подписки энумерация повторяется: событие, прилетевшее между стартовой
энумерацией и активной подпиской, иначе было бы потеряно, а дедуп отбрасывает
всё уже поставленное в очередь или in-flight, так что переживает только реально
пропущенная работа.

### Worker pipeline

Web Worker (`src/workers/thumbWorker.ts`) receives messages via `postMessage`:

```typescript
// Main → Worker
type WorkerInput = {
  slug: string;
  assetUrl: string;    // "asset://localhost/<encoded-path>"
  kind: "image" | "video";
};

// Worker → Main
type WorkerOutput =
  | { slug: string; ok: true; bytes: Uint8Array }
  | { slug: string; ok: false; error: string };
```

Worker processes one request:

**For `kind: "image"`:**
```typescript
const response = await fetch(assetUrl);
const blob = await response.blob();
const bitmap = await createImageBitmap(blob);  // native decode ANY format
const { targetW, targetH } = computeCoverSize(bitmap.width, bitmap.height, 640, 640);
const canvas = new OffscreenCanvas(targetW, targetH);
const ctx = canvas.getContext('2d')!;
ctx.drawImage(bitmap, 0, 0, targetW, targetH);
const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
postMessage({ slug, ok: true, bytes });
```

`createImageBitmap` работает на любом формате который поддерживает WebView — включая VP8X WebP, HEIC, AVIF, TIFF, animated GIF (первый frame).

**For `kind: "video"`:**
```typescript
// Worker can't use <video> element (no DOM).
// Option A: fetch first frame via OffscreenCanvas + VideoDecoder API (Chrome 94+, supported in Tauri WKWebView)
const response = await fetch(assetUrl);
const bytes = new Uint8Array(await response.arrayBuffer());
// Parse MP4 moov to find first keyframe, use VideoDecoder to decode
// Fall back: keep placeholder if decoder unsupported
// OR
// Option B: route video upgrade to main thread where <video> + drawImage works
```

Video support detail: current plan is Option B — main thread does video upgrade using `<video>` element (attach to hidden DOM, `seek(0.1)`, `drawImage` on canvas at `loadeddata` event). Worker handles images only. Video upgrade slower (~300ms per video due to buffering) but works unconditionally.

Video decode uses two separate timeouts: `VIDEO_METADATA_TIMEOUT_MS = 15_000`
waiting for `loadedmetadata` (covers time queued in the media-decoder pool) plus
`VIDEO_DECODE_TIMEOUT_MS = 10_000` for capturing a usable frame once metadata has
loaded. A single timer started at element creation would charge time spent merely
queued in the pool against the decode budget, timing out slow-to-start but valid
videos before they ever decode.

### Main-thread handling of result

```typescript
const { slug, bytes } = workerResult;
await invoke('save_thumb', { slug, bytes: Array.from(bytes) });
// Rust emits "thumb:updated" which triggers sidebar re-render
```

### Concurrency

Worker processes 4 requests in parallel (internal queue). Above that, requests wait. Prevents starving main thread on startup burst.

For 500 blocks needing upgrade at app startup: 500 × ~50ms / 4 = ~6 seconds of background work. UI responsive throughout because worker is off-main-thread.

### Failure handling

`createImageBitmap` throws on truly corrupted files → worker sends `{ok: false, error}`. Main thread logs and keeps text placeholder. User sees: blocks with broken media show text fallback instead of real image. Acceptable degradation.

`VideoDecoder` unsupported or fails → same fallback.

`fetch(asset://)` fails → network error, retry once, then keep placeholder.

`save_thumb` IPC fails → log, drop request.

No blocking errors. Pipeline is self-healing at next startup.

## Phase 3: Sidebar update (event-driven)

### Current behavior (to be replaced)

`App.tsx` calls `loadPreviews()` → `listChannelPreviews(20)` → rebuilds entire `channelPreviews` Map. Triggered by initial load and by `loadData` on various events. Full refetch, O(channels × 10) IPC.

### New behavior

Subscribe to three Tauri events:

**`block:added` `{ tag, slug, is_text }`**

Emitted by watcher after `upsert_block` completes. Frontend adds new `PreviewCard` to affected channel (and `__all__`) in `channelPreviews` Map without refetch:

```typescript
setChannelPreviews(prev => {
  const next = new Map(prev);
  const channel = next.get(tag) ?? [];
  next.set(tag, [
    { url: thumbnailUrl(vaultPath, slug), text: is_text },
    ...channel.slice(0, 9),  // keep top 10
  ]);
  // Same for "__all__"
  return next;
});
```

**`block:removed` `{ slug, tags }`**

Emitted when `.md` file deleted. Remove `slug` from all affected channels.

**`thumb:updated` `{ slug }`**

Emitted by Rust after `save_thumb` writes new thumb file. Frontend updates affected `PreviewCard.url` with cache-buster:

```typescript
setChannelPreviews(prev => {
  const next = new Map(prev);
  for (const [tag, cards] of next) {
    const updated = cards.map(c =>
      c.url.includes(`/${slug}.jpg`)
        ? { ...c, url: `${c.url.split('?')[0]}?v=${Date.now()}` }
        : c
    );
    next.set(tag, updated);
  }
  return next;
});
```

Cache-buster заставляет browser refetch thumb from disk (new JPEG content instead of old placeholder PNG). Asset protocol обслуживает файл со свежими bytes.

### Initial load

At app startup, frontend still calls `listChannelPreviews(20)` once to populate initial state. After that, updates happen via events. Initial call needed because startup may load a vault with existing blocks that have no pending events.

## Virtualized Sidebar

### Problem

100+ channels rendered as DOM = 1000+ `<img>` elements in tree. Scroll lag, layout thrash on resize, memory waste.

### Solution

Scroll-based windowing. After Phase 11 (Zero-Jank Grid), `Grid.tsx` использует `useGridScroll` hook (React 18 `useSyncExternalStore` без лишних ре-рендеров) + bucket-based visibility index из `src/lib/masonryLayout.ts`. Sidebar может применить **тот же** `useGridScroll` + тривиальный single-column layout (каждый channel row имеет фиксированную высоту из SPEC_FRONTEND.md, не нужен measurement pipeline). Альтернатива — реализация на базе `useSyncExternalStore` напрямую без использования Grid lib, так как sidebar не требует ни word-wrap precomputation, ни LayoutCache (channel order стабилен).

Выбор: **использовать `useGridScroll` + простой bucket index для channel rows** (reuse существующей infrastructure + гарантированно одинаковый scroll jank profile как у Grid).

### Component structure

```typescript
function Sidebar({ channels, channelPreviews, ... }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const OVERSCAN = 400;  // pixels above/below viewport
  const itemHeight = compact ? 32 : 40;  // fixed height per channel row

  const totalHeight = channels.length * itemHeight;

  const firstVisibleIdx = Math.max(0, Math.floor((scrollTop - OVERSCAN) / itemHeight));
  const lastVisibleIdx = Math.min(
    channels.length,
    Math.ceil((scrollTop + viewportHeight + OVERSCAN) / itemHeight)
  );

  return (
    <aside ref={scrollContainerRef} onScroll={handleScroll}>
      <div style={{ height: totalHeight, position: 'relative' }}>
        {channels.slice(firstVisibleIdx, lastVisibleIdx).map((channel, i) => {
          const absoluteIdx = firstVisibleIdx + i;
          return (
            <div key={channel.tag} style={{
              position: 'absolute',
              top: absoluteIdx * itemHeight,
              height: itemHeight,
              width: '100%',
            }}>
              <TagNavItem
                channel={channel}
                cards={channelPreviews.get(channel.tag) ?? []}
                ...
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
```

### Performance budget

- Visible channels at any moment: ~30 (viewport 600px ÷ 20px itemHeight = 30)
- DOM `<img>` elements: 30 × 10 preview cards = 300
- Memory per thumb: ~5KB disk + ~10KB decoded bitmap = 15KB
- Total DOM images memory: ~4.5MB
- Scroll FPS: browser compositor moves absolute-positioned elements at display refresh rate

### Drag-and-drop compatibility

Current sidebar supports `@dnd-kit` drag-and-drop для reordering channels. Virtualization must not break this — `SortableContext` wraps visible items, items outside window not in sortable registry. When dragged to unrendered position, fallback to scroll-to-position behavior.

Implementation detail: `SortableContext` needs `items: string[]` with **all** channel IDs, not just visible. React reconciliation handles DOM mount/unmount as items scroll into view. Reorder mutation updates channels array in App state, sidebar re-renders from new order.

## Contracts

### Tauri commands (Rust → registered as `#[tauri::command]`)

#### `save_thumb`

```rust
#[tauri::command]
fn save_thumb(
    state: State<'_, AppState>,
    slug: String,
    bytes: Vec<u8>,
) -> Result<(), CommandError>;
```

**Preconditions:**
- Vault open
- `bytes` first 3 match JPEG magic (`FF D8 FF`)
- `slug` is a safe filename stem (`validate_slug`): spaces, Unicode, скобки и пунктуация допустимы; path traversal, separators и NUL запрещены

**Behavior:**
- Validate magic bytes — reject with `CommandError::InvalidArgument` if not JPEG
- Write `bytes` to `vault.thumb_path(&slug)` atomically (write temp + rename)
- Emit `thumb:updated { slug }` Tauri event

**Postconditions:**
- File on disk contains `bytes`
- Frontend eventually receives `thumb:updated` event

**Failure modes:**
- Disk full → `CommandError::IoError`
- Invalid bytes → `CommandError::InvalidArgument`
- Path traversal attempt → `CommandError::InvalidArgument`

**Transport:** декодированный JPEG передаётся бинарным raw-IPC — `Uint8Array`
телом запроса (`invoke("save_thumb", bytes, { headers })`), а не как JSON-массив
чисел, чтобы избежать JSON-инфляции и парсинга сотен килобайт. Метаданные (`slug`;
для `save_tile_poster` — `posterName` и `slug`) едут в percent-encoded заголовках:
`encodeURIComponent` держит юникод-slug'и (кириллица, символы вроде ⊷) ASCII-safe
для HTTP-заголовков, Rust percent-декодирует. JSON-массив чисел остаётся только
как fallback-ветка.

#### `list_pending_thumb_upgrades`

```rust
#[tauri::command]
fn list_pending_thumb_upgrades(
    state: State<'_, AppState>,
) -> Result<Vec<ThumbUpgradeRequest>, CommandError>;
```

**Returns:** List of blocks whose thumb is text placeholder but which have embedded media that should be upgraded via WebView.

**Detection:**
- Query SQLite for rows that may need Phase 2: PNG placeholder metadata or
  missing/NULL thumb metadata.
- Command layer resolves indexed media (`media_file`, `thumbnail`, `first_image`,
  `media_urls`) through the shared media resolver.
- Command layer checks actual disk state before returning work. Rows with
  missing metadata are repair candidates, not guaranteed orphan media.

**Response shape:**
```typescript
type ThumbUpgradeRequest = {
  slug: string;
  mediaPath: string;       // absolute path to media file
  kind: 'image' | 'video';
};
```

**Called by:** Frontend at app startup after `listChannelPreviews`, before any scroll. Populates worker queue.

### Tauri events (Rust → Frontend)

#### `block:added`

Emitted after `watcher::index_md_file` completes `upsert_block`.

```typescript
type BlockAddedEvent = {
  slug: string;
  tags: string[];     // all tags this block belongs to
  is_text: boolean;   // true if list_channel_previews would classify as text
};
```

Frontend: add `PreviewCard` to `channelPreviews` for each tag and `__all__`.

#### `block:removed`

Emitted after `watcher::handle_event(BlockDeleted)`.

```typescript
type BlockRemovedEvent = {
  slug: string;
  tags: string[];
};
```

Frontend: remove `PreviewCard` with this slug from affected channels.

#### `thumb:updated`

Emitted after `save_thumb` writes to disk. Also emitted after `watcher::index_md_file` when Rust Phase 1 creates new thumb.

```typescript
type ThumbUpdatedEvent = {
  slug: string;
};
```

Frontend: cache-bust `<img>` elements referencing `<slug>.jpg`.

#### `thumb:upgrade-requested`

Emitted after `index_md_file` detects block has placeholder thumb but embedded media.

```typescript
type ThumbUpgradeRequestedEvent = {
  slug: string;
  mediaPath: string;
  kind: 'image' | 'video';
};
```

Frontend `useThumbnailUpgrade` hook enqueues into worker.

### Worker protocol (Frontend main thread ↔ Web Worker)

Messages are JSON-serializable objects sent via `worker.postMessage()`.

#### Request

```typescript
type WorkerRequest = {
  id: string;           // unique per request, for matching response
  slug: string;
  assetUrl: string;     // fetch-able URL
  kind: 'image' | 'video';
  targetSize: number;   // max side, default 640
};
```

#### Response

```typescript
type WorkerResponse =
  | { id: string; slug: string; ok: true; bytes: ArrayBuffer }
  | { id: string; slug: string; ok: false; error: string };
```

`bytes` — transferable `ArrayBuffer`, moved (not copied) between worker and main thread via `postMessage`'s transfer list.

#### Worker internal state

Worker holds a simple FIFO queue with `concurrency: 4` parallel slots. Main thread can cancel all inflight work by sending `{ type: 'cancel' }` — worker drops queue and rejects inflight fetches via `AbortController`.

## Freshness & Self-Healing

### is_thumb_fresh invariants (existing from `f726854`)

```rust
fn is_thumb_fresh(thumb_path: &Path, source_path: &Path) -> bool {
    thumb.mtime >= source.mtime
        && first_3_bytes_are(thumb, JPEG_MAGIC | PNG_MAGIC)
}
```

### Startup enumeration

At `full_scan` time, for each block:
1. `is_thumb_fresh` check — if fresh (valid magic, correct mtime) → skip
2. Otherwise → `generate_for_block` runs (Phase 1)
3. After full_scan, call `list_pending_thumb_upgrades` → enqueue Phase 2 work for text-placeholder blocks with embedded media

This guarantees: after startup, every block has a thumb file (text placeholder minimum). Over next few seconds, worker upgrades text placeholders with real media content.

### Self-healing scenarios

**Case 1: User manually deletes thumb file from the local derived `cache/thumbs/`**
- Next `full_scan` finds missing thumb → `is_thumb_fresh = false` → Phase 1 regenerates
- If still placeholder → Phase 2 upgrades

**Case 2: Media file corrupted on disk, WebView decode fails in Phase 2**
- Worker returns `ok: false`
- Text placeholder remains
- Next open: same state, enqueued again, same result
- Acceptable steady state (corruption elsewhere, not our fault)

**Case 3: WebView storage corruption (rare, see `f726854` history)**
- Rare scenario, user-visible symptom: videos don't play, images fail to decode
- Recovery: documented in DEVLOG — delete `~/Library/WebKit/com.mine.app` + `~/Library/Caches/com.mine.app`, restart
- This spec doesn't try to auto-recover from OS-level storage corruption

**Case 4: Block has image file that WebView can decode but Rust crate can't**
- This was the `sem-altman-...` VP8X webp case
- Phase 1: sniff bytes, magic is `RIFF....WEBP` — not in our JPEG/PNG/GIF whitelist → `generate_text_thumbnail`
- Phase 2: worker fetches, `createImageBitmap` succeeds natively → JPEG bytes back → `save_thumb`
- Result: correct thumb within ~300ms of save

## Implementation Plan

### Phase A — Instant fix for current regressions (1-2 hours)

Minimal change that solves 99% of current user-visible thumbnail issues without introducing new architecture components.

**Scope:**
1. Change `storage::thumbnails::generate_for_block` to sniff first 3 bytes of media file before calling `generate_thumbnail`. If not JPEG/PNG/GIF → immediately fall through to `generate_text_thumbnail`. Skip trying Rust decode on webp/video/etc.
2. Rebuild native host, copy to installed location (`~/Library/Application Support/LocalArena/native-host`)
3. Update DEVLOG with explanation

**Result:** blocks with webp/heic/video media save instantly with text placeholder. No more broken transparent PNG stuck in `<img>`. Not the final UX but unblocks current state.

**Trade-off:** text placeholders visible in sidebar until Phase B. Better than broken blocks.

### Phase B — WebView upgrade pipeline (2-3 hours)

Adds Phase 2 of the architecture: worker, events, command.

**Scope:**
1. Create `src/workers/thumbWorker.ts`
2. Add `src-tauri/src/commands/thumbnails.rs` with `save_thumb` and `list_pending_thumb_upgrades`
3. Register commands in `src-tauri/src/lib.rs` invoke handler
4. Modify `watcher::handler::index_md_file` to emit `block:added` and `thumb:upgrade-requested`
5. Create `src/hooks/useThumbnailUpgrade.ts` in frontend
6. Create `src/hooks/useChannelPreviewsEvents.ts` for event-driven preview updates
7. Wire up in `App.tsx`
8. At app startup, call `list_pending_thumb_upgrades` → enqueue

**Result:** real image thumbnails appear for webp/heic/video blocks within ~300ms of save. Sidebar updates instantly when blocks added/removed without polling.

**Visual change:** minimal flicker on new block save (text placeholder visible ~300ms before upgrade). For existing blocks at startup: progressive upgrade over ~few seconds, visible as sidebar thumbs getting more colorful/accurate.

### Phase C — Virtualized sidebar (1-2 hours)

**Scope:**
1. Measure current sidebar item height (with and without compact mode)
2. Rewrite `Sidebar.tsx` navigation section with scroll-based windowing
3. Ensure `@dnd-kit` SortableContext still works with virtualization (SortableContext over full channel list, items mount/unmount with scroll)
4. Preserve existing visual layout — no visible difference except scroll perf

**Result:** 60Hz+ scroll with hundreds of channels. Memory usage bounded.

**Deferred if user has fewer than ~50 channels** — not critical.

### Phase D — Rust crate cleanup (optional, 30 min)

Remove dead dependencies now that WebView handles exotic formats:

**Scope:**
1. `image` crate — keep, still used for JPEG/PNG thumbnail resize (Phase 1 simple path)
2. `openh264` crate — **remove**, video frame extraction now via WebView
3. `mp4` crate — **remove**, same reason
4. Clean up `storage::thumbnails::generate_video_thumbnail` — **remove entirely**

**Result:** native host binary ~5MB smaller, fewer dependencies, simpler Cargo.toml. No functional change.

## Performance Budget

### Latency targets

| Operation | Target | Current | After |
|---|---|---|---|
| Save block → visible in sidebar (Phase 1) | <150ms | ~500ms (polling) | ~110ms (event-driven) |
| Save block → real image in sidebar (Phase 2) | <400ms | N/A (broken for webp/video) | ~300ms |
| App startup with 10k blocks, initial paint | <1000ms | ~800ms | ~800ms (no regression) |
| App startup → all thumbs upgraded | <30s | N/A | ~12s for 500 placeholders |
| Sidebar scroll (100 channels) | 60 FPS minimum | ~30 FPS (DOM heavy) | 120 FPS on ProMotion |
| Add block → Sidebar scroll during work | 60 FPS | Drops to 40 FPS | 60 FPS (worker off-main) |

### Memory targets

| State | Budget |
|---|---|
| SQLite index (10k blocks) | ~2 MB |
| Sidebar DOM (virtualized, 30 visible × 10 thumbs) | ~5 MB |
| Worker decode buffers (peak during upgrade) | ~30 MB |
| Main thread heap during scroll | <100 MB |

### Scalability

Pipeline is O(1) per block operation. Startup is O(N) index scan + O(M) magic byte checks where M = total thumb files. Upgrade queue is O(K) where K = placeholder count — bounded by vault media count, processed in background.

## Failure Modes

### Rust Phase 1 failures

| Condition | Response |
|---|---|
| `generate_thumbnail` fails on sniffed JPEG | Fallback to `generate_text_thumbnail` |
| `generate_text_thumbnail` fails | `CommandError::IoError` — save_block fails, clipper shows error |
| Disk full | Same — save fails cleanly |
| Permission denied | Same — save fails cleanly |

### Phase 2 WebView failures

| Condition | Response |
|---|---|
| `createImageBitmap` throws (unsupported format despite WebView capability) | Worker returns `ok: false`, keep placeholder, log |
| `fetch(asset://)` fails | Retry once, then keep placeholder, log |
| `save_thumb` IPC fails | Log, drop upgrade, try again next startup |
| Worker crash | Main thread detects via `worker.onerror`, respawns worker, re-enqueues inflight work |
| Video decode unsupported | Keep placeholder, log |

### Recovery at next startup

Every startup re-enumerates pending upgrades. Any blocks that failed upgrade last session get another try. Transient failures self-heal.

## Testing Strategy

### Unit tests (Rust)

**`storage::thumbnails` module:**
- Magic byte sniff: correctly identifies JPEG/PNG/GIF vs other → correct cascade branch
- `generate_for_block` with webp/avif media → returns `Text` and writes PNG placeholder
- `generate_for_block` with jpg body → returns `Image`, JPEG content
- `generate_for_block` with pure text → returns `Text`
- `is_thumb_fresh` with corrupt content → `false`
- `list_pending_thumb_upgrades` enumerates correctly

**`commands::thumbnails` module:**
- `save_thumb` writes bytes correctly
- `save_thumb` rejects path traversal (slug with `..`)
- `save_thumb` rejects non-JPEG bytes

### Integration tests (TypeScript)

**Worker protocol:**
- Input → output for JPEG image
- Input → output for WebP VP8X image (mock fetch with real VP8X bytes)
- Cancel mid-processing
- Concurrency limit (5 requests, 4 inflight + 1 queued)

**Event flow:**
- Mock Tauri event emitter → `useChannelPreviewsEvents` updates Map correctly
- Cache-buster applied on `thumb:updated`

### End-to-end tests (manual QA)

Testing matrix:
- Save block with JPEG → Phase 1 thumb, no Phase 2
- Save block with VP8X WebP → Phase 1 placeholder, Phase 2 upgrade visible
- Save block with HEIC → same as webp
- Save block with MP4 H.264 → Phase 1 placeholder, Phase 2 video frame
- Save block with fragmented MP4 → same
- Save pure text article → Phase 1 text thumb, no Phase 2
- Open vault with 100 channels → sidebar scrolls at 60+ FPS
- Open vault with 10k blocks → initial paint < 1s
- Kill app during Phase 2 → restart, pending upgrades complete

### Visual regression

Before implementing Phase C (virtualization), snapshot sidebar with representative vault (5 channels × 10 thumbs of each type). After implementation, compare pixel-by-pixel. Allowed delta: zero for working thumbs, full correction for previously-broken thumbs.

## Open Questions

### Q1: Video frame extraction in worker

`VideoDecoder` API доступен в Chrome 94+, but Tauri uses WKWebView on macOS which may or may not expose it reliably. **Decision:** implement with fallback — attempt `VideoDecoder` first, fall back to main-thread `<video>` element if `typeof VideoDecoder === 'undefined'`. Main-thread path is slower (requires DOM) but always works in WKWebView.

### Q2: HEIC support on non-macOS

WKWebView on macOS decodes HEIC natively via system codec. On Windows WebView2 (future) HEIC may require additional codec pack. **Decision:** document as known limitation, monitor when Windows support becomes active. Current project is macOS-first.

### Q3: Cache-buster strategy

Two strategies, used in complementary roles:

- **`?m=<mtime>`** on `refresh()` (initial load, vault switch): Rust `list_channel_previews` returns each thumb file's `mtime` (unix seconds from `stat()`). Frontend appends it as a query param. Files that haven't changed keep the same URL → browser serves from HTTP cache. Files that changed between sessions (e.g. Phase 2 worker overwrote PNG → JPEG) get a new URL → browser refetches from disk. Cost: one `stat()` per thumb per refresh — negligible.

- **`?v=<counter>`** on `thumb:updated` event (real-time, same session): per-slug version counter in `useChannelPreviewsEvents`. Incremented on each `thumb:updated` event. No disk I/O, instant.

**Decision:** both. `?m=` covers cross-session changes (the primary failure mode — Phase 2 writes JPEG, user restarts, browser has stale PNG cached). `?v=` covers in-session updates (live clipper save → worker upgrade → sidebar refresh). Neither alone is sufficient: `?v=` starts at 0 every session (loses cross-session state), `?m=` requires IPC round-trip (too slow for real-time events).

### Q4: How to handle clipper saving block while main app is closed

Current behavior: native host writes source files, upserts the local derived
SQLite index, writes Phase 1 thumb (text placeholder для exotic formats) and
syncs `thumb_format` / `thumb_mtime`. Next time main app opens,
`list_pending_thumb_upgrades` enumerates repair/upgrade candidates and the
worker upgrades media placeholders.

**Edge case:** user saves 100 blocks via clipper with main app closed over a week. Next open: 100 upgrades queued. Takes ~30 seconds. User sees thumbs progressively upgrading.

**Decision:** acceptable. No SLA on this scenario. Alternative would be to run main app headless in background, not worth it.

### Q5: Worker JPEG quality vs file size

Current Rust pipeline uses JPEG quality 85, ~5-9KB per 640×640 thumbnail. WebView `convertToBlob({quality: 0.85})` produces similar size. **Decision:** keep quality 85 for consistency. Tuning is out-of-scope for this SPEC.

### Q6: Does `thumb:updated` event fire during Phase 1 as well?

Phase 1 writes thumb inside native host process (before main app sees block). Main app watcher eventually detects `.md` change, runs `index_md_file`, which currently also runs `generate_for_block` (second time). Second run sees fresh thumb via `is_thumb_fresh`, skips. So Phase 1 thumb is written by native host, visible to main app only via watcher notification.

**Decision:** `block:added` event encompasses "thumb now exists". Separate `thumb:updated` event fires only when Phase 2 upgrade completes. Frontend treats both events idempotently.

## Migration & Rollback

### Backward compatibility

Existing thumb files on disk (mix of JPEG and PNG, correct and corrupt) are handled by `is_thumb_fresh` magic bytes check. Corrupt files regenerate at next startup. No destructive migration step.

### Rollback plan

If Phase B has critical bug:
1. Revert `src-tauri/src/commands/thumbnails.rs` addition
2. Revert event emission from `watcher::handler`
3. Revert frontend hooks
4. Keep Phase A (native host sniff) since it's independently valuable
5. Users return to Phase A state: text placeholders for exotic formats, no upgrade

Phase A alone is a valid terminal state, just worse UX. Phase B is pure improvement on top.

If Phase C virtualization introduces rendering bugs:
1. Revert `Sidebar.tsx` windowing changes
2. Sidebar returns to rendering all channels — scroll perf degrades but functionality preserved

### Data migration

No source-vault file migration. Existing thumb files are used as-is. SQLite
schemas that predate `thumb_format` / `thumb_mtime` get additive columns and a
metadata backfill from the existing thumb cache.

Бамп `DEFAULT_MAX_SIZE` 480 → 640 применяется **forward-only**. `is_thumb_fresh`
остаётся stat-only (mtime + JPEG/PNG magic bytes), поэтому существующие 480px
тумбы **не** регенерируются массово — полный rebake на старте вызвал бы
focus-stall. Тумб апгрейдится до 640 лениво: когда mtime источника дрейфует
(re-clip, замена медиа) и отрабатывает штатный путь регенерации.
`THUMB_FORMAT_VERSION` намеренно не бампнут — 480px тумбы остаются валидным
контентом, просто меньшего разрешения; бамп версии форсировал бы ровно ту
массовую регенерацию, которой это избегает.

## Appendix A: Implemented pipeline state (08.05.2026)

- `generate_for_block` in `storage::thumbnails` contains the shared cascade:
  `frontmatter.file` → `frontmatter.thumbnail` → inline body media →
  fallback-label/text PNG.
- `storage::preview_plan` owns the common preview contract used by both
  `preview_manifest` and thumbnail generation: `primary_preview_path =
  <slug>.jpg`, shared media predicates, inline-media scan order,
  `PREVIEW_TILE_LIMIT = 4` for rich card manifests, and
  `MICRO_PREVIEW_IMAGE_LIMIT = 1` for the hot `<slug>.jpg` micro-preview.
  The micro-preview is always one representative media/poster, not a baked
  composite; multi-image richness belongs to `preview_manifest.tiles`.
- Native host calls `upsert_block`, `generate_for_block`, then
  `sync_thumb_metadata` after source-vault commit.
- Watcher handler calls the same `generate_for_block` during full scan and
  `index_md_file`, and emits thumb events for fresh PNG placeholders.
- `is_thumb_fresh` validates mtime + JPEG/PNG magic bytes.
- `list_channel_previews` reads SQLite `thumb_format` / `thumb_mtime` and
  returns only confirmed preview rows.
- `get_block`, `list_blocks`, `list_blocks_by_tag`, and `search_blocks` expose
  the same thumb metadata on `IndexedBlock`.
- `useChannelPreviewsEvents` coalesces preview refresh events and filters
  `has_thumb=false` defensively.
- `useChannelPreviewsEvents.refresh()` is generation-guarded: it captures the
  current `thumbsRootPath` and a monotonically increasing request id before
  `list_channel_previews`. If a vault/space switch changes the root or a newer
  refresh starts before the IPC resolves, the old response must be ignored and
  must not overwrite the current `channelPreviews` map.
- The hook also performs a throttled recovery refresh on window focus,
  `visibilitychange`, and the app-level `vault-refreshed` event. This is a
  self-healing path for a live window whose in-memory preview map was already
  stale before the current code loaded.
- Phase 2 WebView upgrade remains responsible for replacing PNG placeholders
  with real decoded JPEG previews when the desktop app is open.

## Appendix B: Glossary

- **Phase 1**: Rust synchronous thumb generation inside native host save flow
- **Phase 2**: WebView-based async upgrade for exotic formats
- **Phase 3**: Event-driven sidebar preview updates
- **Placeholder thumb**: Text-baked PNG used when Phase 1 can't decode media; replaced by Phase 2
- **Upgrade queue**: Frontend worker queue processing `thumb:upgrade-requested` events
- **Magic bytes check**: Freshness validation reading first 3 bytes of thumb file
- **Content sniff**: Magic bytes check on source media file to determine Phase 1 path
- **Cache buster**: URL query param added to `<img src>` to force browser refetch

## References

- Historical thumbnail regressions: DEVLOG entries `32d452e`, `f726854`
- Unified cascade implementation: commit `f726854`
- Magic bytes freshness check: commit `f726854`
- Canvas + VideoDecoder MDN: https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder
- createImageBitmap MDN: https://developer.mozilla.org/en-US/docs/Web/API/createImageBitmap
- WebP VP8X format spec: https://developers.google.com/speed/webp/docs/riff_container
