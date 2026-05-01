# SPEC: Frontend

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md)

## Overview

React 19 + TypeScript + TailwindCSS v4 фронтенд для Mine. Работает внутри Tauri v2 WebView (Safari/WebKit). Взаимодействует с Rust-бэкендом через `@tauri-apps/api/core` (invoke). Ассеты (thumbnails, медиафайлы) отображаются через `convertFileSrc`.

## TypeScript types

Типы определяются вручную и соответствуют `Serialize`-выводу Rust-структур.

### IndexedBlock

```typescript
interface IndexedBlock {
  id: number;
  slug: string;
  block_type: "image" | "article" | "link" | "video" | "file";
  title: string | null;
  description: string | null;
  url: string | null;
  media_file: string | null;
  thumbnail: string | null;
  saved_at: string;
  source: string | null;
  width: number | null;
  height: number | null;
  author: string | null;
  body: string;
  related_notes: string[];
  tags: string[]; // legacy physical name; semantic meaning: CollectionRef[]
}
```

### TagCount

```typescript
interface TagCount {
  tag: string; // legacy physical name; semantic meaning: CollectionRef
  count: number;
}
```

### ChannelDto

```typescript
interface ChannelDto {
  tag: string; // legacy physical name; semantic meaning: CollectionRef
  title: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  position: number;
  created_at: string;
  block_count: number;
}
```

### ScanResult

```typescript
interface ScanResult {
  indexed: number;
  errors: number;
}
```

### RenameBlockResult / RenameBlockError

```typescript
interface RenameBlockResult {
  old_slug: string;
  new_slug: string;
}

type RenameBlockError =
  | { kind: "no_vault" }
  | { kind: "block_not_found"; slug: string }
  | { kind: "invalid_filename"; reason: string }
  | { kind: "name_taken"; requested: string }
  | { kind: "internal"; message: string };
```

## IPC layer — `lib/commands.ts`

Тонкая обёртка над `invoke()`. Каждая функция строго типизирована:

```typescript
selectVault(path: string): Promise<ScanResult>
getVaultPath(): Promise<string | null>
listBlocks(): Promise<IndexedBlock[]>
getBlock(slug: string): Promise<IndexedBlock | null>
createBlock(params: CreateBlockParams): Promise<IndexedBlock>
extractTextSelection(params: ExtractTextSelectionParams): Promise<IndexedBlock>
prepareDeleteBlock(slug: string): Promise<DeleteBlockPlan>
deleteBlock(slug: string, deleteUnusedMedia?: boolean): Promise<boolean>
renameBlockFile(oldSlug: string, newStem: string): Promise<RenameBlockResult>
listTags(): Promise<TagCount[]>
addTag(slug: string, tag: string): Promise<void>
removeTag(slug: string, tag: string): Promise<void>
search(query: string): Promise<IndexedBlock[]>
listChannels(): Promise<ChannelDto[]>
createChannel(tag: string, title?: string): Promise<ChannelDto>
deleteChannel(tag: string): Promise<boolean>
```

## Delete confirmation

- Grid and Detail delete entry points open the same App-level delete dialog through `prepareDeleteBlock` before committing.
- If the plan has `unused_media`, the dialog shows compact previews, uses the card thumbnail/poster for video previews, and offers both `Keep media` and `Delete`.
- `Keep media` commits with `deleteUnusedMedia=false`: only the `.md` card and derived artifacts are removed.
- Media referenced by other cards is never offered for deletion and remains on disk.

## File drop overlay

The global file `DropZone` listens to Tauri webview drag/drop events and should
show the import overlay only for real file drags. It must gate overlay state on
the Tauri `enter` event carrying at least one path. Plain native drags inside
the WebView, including selected text extraction drags, must not show the `Drop
files to add` overlay. While the overlay is visible, `Escape` cancels the
overlay state without importing anything.

## Text selection extraction

Detail article body supports dragging an already selected text range to a
concrete sidebar collection. Normal selection creation, system highlighting,
`Cmd+C`, and the browser/WebView context menu remain native; the article body
must not become a `dnd-kit` draggable while the user is selecting text.

Inside the Tauri/WKWebView runtime, selected-text extraction uses a manual
Pointer Events drag as the primary path. HTML5/native selected-text drag is not
architecturally reliable in this app because WKWebView can hand the gesture to
the native drag session before the DOM sees a useful drag lifecycle. The manual
path starts only from a primary-button pointerdown inside an already existing
text selection, calls `preventDefault()` for that gesture to suppress the
native drag session, captures the pointer, and activates only after a small
movement threshold. It then highlights sidebar channel rows by
`document.elementFromPoint()` and calls the same extraction command on
pointerup.

Native `dragstart`/`drop` support remains only as an opportunistic browser
compatibility path: when a real native `dragstart` reaches the article body, it
writes Mine extraction metadata into `dataTransfer`.

The drop creates a new article card through `extractTextSelection`; it does not
connect the source card itself and does not enter the inline-media extraction
path.

The new card body is a creation-time snapshot of the selected text. It is not a
live embed and must not auto-update when the source paragraph changes.

Source provenance is stored in `Mine Related Notes` as an Obsidian block
reference:

```yaml
Mine Related Notes:
  - "[[Source Article#^attention-is-selection]]"
```

If the user selects text across multiple paragraphs, the card body includes the
selected text across paragraphs, but the related-note link anchors only the
first selected paragraph. This is the intended v1 reverse-navigation behavior:
the anchor brings the user back to the start/context of the source passage.

Frontend drag payload:

```ts
type TextSelectionDragPayload = {
  type: "text_selection";
  sourceSlug: string;
  selectedText: string;
  firstBlockStart: number;
  firstBlockEnd: number;
  sourceBodyHash: string;
  title: string | null;
};
```

The native compatibility payload is serialized under MIME type
`application/x-mine-text-selection`. Sidebar channel rows accept native drops
with this MIME type and call `extractTextSelection` for the target collection.
Because WebKit can hide custom MIME types during intermediate `dragover`
events, Mine also keeps the active selected-text payload in memory between
`dragstart` and `drop`/`dragend` as a same-WebView native-drag fallback.
Existing `dnd-kit` paths remain responsible for card/tag drag and inline-media
extraction.

After successful extraction:

1. Detail remains open on the source article.
2. The command emits normal `block:added` / `thumb:updated` events for the new
   card, and App schedules grid/taxonomy/preview refresh immediately after the
   successful drop.
3. Metadata renders the related note as provenance/source context, not as a
   synced body.
4. Clicking a related note that includes `#^block-id` opens the source article
   by base slug and scrolls the Detail body to the visible block-id marker when
   the marker is still present.

## Routing

| Путь | Компонент | Описание |
|---|---|---|
| `/` | AllBlocks | Все блоки (по умолчанию после выбора vault) |
| `/channel/:tag` | ChannelView | Blocks filtered by percent-encoded `CollectionRef` |
| `/search?q=...` | SearchResults | Результаты поиска |

Route params encode `CollectionRef`, derived from the Obsidian wikilink target,
not a normalized tag. The URL currently keeps `/channel/:tag` for compatibility,
but the value is a percent-encoded page ref such as `Красивый веб`, not
`красивый-веб`.

Vault-пикер — не маршрут, а состояние: если `vaultPath === null`, показываем пикер поверх.

## Components

### AppShell (`App.tsx`)

Корневой компонент. Управляет:
- Состояние vault (путь или null)
- При старте вызывает `getVaultPath()` — если null, показывает VaultPicker
- После выбора vault — Layout с sidebar + router
- Подписывается на `block:renamed` и ретаргетит открытый Detail / scroll target на `new_slug` без закрытия текущего контекста

### VaultPicker

Полноэкранный экран первого запуска:
- Кнопка «Select Vault» — вызывает `open()` из `@tauri-apps/plugin-dialog` (directory mode)
- После выбора вызывает `selectVault(path)`
- Показывает ScanResult (сколько блоков проиндексировано)

### Layout

Двухколоночная раскладка:
- Sidebar (фиксированная, 240px)
- Main area (flex-1, содержит Outlet роутера)

### Sidebar

Обычный режим:
1. Пункт `Everything` — навигация на `/`
2. Список каналов (из `listChannels()`) — навигация на `/channel/:tag`
3. Каждый канал: название + счётчик блоков + до 20 превью-карточек
   (thumbnails)

Активный пункт подсвечивается. Каналы отсортированы по `channels.position`.
`channels` является source of truth для порядка; legacy `tags` используется
только как физическое имя текущего индекса. Runtime использует `CollectionRef`
из `Mine Collections` wikilinks. Изменение количества карточек в канале не
должно менять порядок каналов в sidebar.
Если локальный индекс был создан старой версией, `block_tags` может временно
содержать user-owned Obsidian `tags`; backend обязан очистить это через
versioned collection-index backfill до формирования стабильного списка каналов.

Режим открытого Detail:
1. `Everything` остаётся обычным пунктом навигации на `/` с общим счётчиком и
   без checkbox.
2. Верхняя surface sidebar показывает `Channels:` и selector `All / Connected`.
3. `All` показывает все каналы; `Connected` показывает только каналы, связанные
   с открытым блоком.
4. Строка канала продолжает работать как навигация на `/channel/:tag`.
5. Checkbox справа — единственный control, который добавляет/удаляет открытый
   блок из канала. Нажатие на строку без checkbox не меняет membership.
6. Правый слот строки повторяет обычный sidebar: без hover виден счётчик.
   Если канал уже связан с открытым блоком, checkbox виден всегда и замещает
   счётчик. Если канал не связан, checkbox появляется только на hover/focus.
7. Визуальный checkbox остаётся 16×16, но кликабельная область равна правому
   row-action slot: 32×32. Клик по этой области не должен вызывать навигацию.
8. Строки каналов должны сохранять stable row identity при переключении
   ordinary sidebar ↔ Detail link-editor. Нельзя менять весь row component tree
   только ради checkbox: thumbnail strip остаётся тем же DOM-поддеревом, меняется
   только правый action slot. Это предотвращает remount `<img>` и blink превью
   при открытии карточки.

Geometry зависит от Detail top menu mode. В `classic` selector живёт в
полноширинном `h-8 bg-accent border-b` баре. В `island` selector живёт в
абсолютной top-пуле (`top-4`, `bg-accent/80`, `backdrop-blur-sm`,
`backdrop-saturate-150`, `rounded-1`, `border`) без фоновой защитной плашки;
список сохраняет top inset `pt-20`.

**Виртуализация.** CSS-native подход: `content-visibility: auto` + `contain-intrinsic-size: auto 42px` на каждом `TagNavItem`. WKWebView на macOS 14.4+ пропускает layout/paint для offscreen channel rows автоматически. Отключается во время любого drag-to-channel (`isDropDragging || isDragging`), чтобы `getBoundingClientRect` в dnd-kit возвращал реальную геометрию и hover-ring работал одинаково для карточек и inline-media. `SortableContext` получает полный список channels IDs независимо от видимости.

**Event-driven previews.** Превью карточек в sidebar обновляются через Tauri events (`block:added`, `block:removed`, `thumb:updated`), а не через polling `listChannelPreviews`. Initial state грузится один раз при mount через `listChannelPreviews(20)`, потом инкрементально патчится `useChannelPreviewsEvents` hook'ом. Latency add block → visible in sidebar: ~110ms (native host write + watcher debounce + IPC event + React update). Cache-bust: initial load использует `?m=<mtime>` (unix timestamp thumb-файла из Rust `stat()`), real-time updates используют `?v=<counter>` (per-slug version counter, инкрементируется на `thumb:updated`). Два механизма дополняют друг друга: `?m=` покрывает межсессионные изменения (Phase 2 worker перезаписал PNG→JPEG), `?v=` покрывает live-обновления внутри сессии.

**Main sidebar top inset.** На главной sidebar использует `pt-20` прямо на
`data-sidebar-scroll`. Не создавать отдельную пустую header surface для
опциональных баннеров: если banner component возвращает `null`, над списком не
должно оставаться фиксированной белой плашки, которая обрезает scroll-content.

**Thumbnail upgrade.** Для блоков с inline media которое Rust не умеет декодировать (WebP VP8X, HEIC, AVIF, HEVC), Rust Phase 1 пишет text placeholder на диск. Main app через `useThumbnailUpgrade` hook подписан на `thumb:upgrade-requested` event и отправляет работу в Web Worker (`src/workers/thumbWorker.ts`). Worker декодирует через `createImageBitmap` (native browser decoder, поддерживает все форматы которые WebView рендерит) → `OffscreenCanvas.convertToBlob('image/jpeg', 0.85)` → IPC `save_thumb` → Rust пишет поверх placeholder. После `thumb:updated` event sidebar cache-bust'ит `<img>` URL. Полная архитектура: [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md).

### Grid

Сетка карточек с собственным virtualized masonry renderer:
- Источник данных: `LightBlock[]`
- Количество столбцов: адаптивное, на основе ширины контейнера (`ResizeObserver`, минимум 240px на столбец)
- Layout считается чистой функцией: `containerWidth + estimatedHeights -> positions[]`
- Карточки позиционируются абсолютно (`translate(x, y)`), контейнер имеет вычисленную `totalHeight`
- В DOM находятся только видимые карточки + direction-aware overscan: forward 2200px / backward 600px (зависит от направления scroll'а). Предзагружает больше карточек по направлению движения.
- **Priority bounds**: зона ±1400px по направлению scroll'а. Карточки внутри зоны получают `priority=true` → `<img loading="eager">` для image/link/article карточек. Карточки вне зоны — `loading="lazy"`.
- Порядок: по `saved_at` descending (новые вверху)

Оценка высоты:
- `image` — по aspect ratio из `width/height` (если frontmatter содержит размеры)
- `video` / `link` / `file` — по фиксированным эвристикам
- `article` — по длине заголовка, indexed `preview_text` и наличию `first_image`
- После первого paint реальная высота уточняется через `ResizeObserver` и кешируется по `slug`

`preview_text` не является визуальным лимитом карточки. Backend отдаёт
очищенный buffer до 768 символов, рассчитанный из максимальной геометрии
article-card без media (8 lines × widest single-column inner width). Frontend
сохраняет финальное решение за CSS line-clamp/реальной измеренной высотой, так
что текст не обрезается заранее на уровне SQLite payload.

**CLS prevention**: ImageCard при наличии `block.width`/`block.height` рендерит контейнер с `aspectRatio: W/H` и `overflow:hidden bg-accent`. Картинка через `absolute inset-0 object-cover`. Размер карточки стабилен до загрузки — нет layout shift.

Это даёт быстрый resize и мгновенное переключение между разделами при тысячах блоков, потому что browser layout работает только с окном видимых карточек, а не со всей коллекцией.

### Card

Диспатчер по `block_type`:

| Тип | Отображение |
|---|---|
| `image` | Thumbnail с сохранением пропорций. Заголовок при наведении |
| `link` | Thumbnail (или заглушка) + заголовок + домен из url |
| `article` | Первые ~3 строки текста из body. Заголовок сверху |
| `video` | Thumbnail + иконка play. Заголовок внизу |
| `file` | Иконка типа файла + имя + расширение |

Thumbnail отображается через `convertFileSrc(vaultPath + "/.arena/cache/thumbs/" + slug + ".jpg")`.

Медиафайлы (для image-карточек без thumbnail): `convertFileSrc(vaultPath + "/" + media_file)`.

Article inline media renders from backend-derived paths. For bare Obsidian
embeds such as `![[01.jpg]]`, Detail first asks `preview_manifest.tiles` for a
resolved `source_path` and then loads `convertFileSrc(vaultPath + "/" +
source_path)`. The frontend must not reimplement vault-wide attachment search;
that belongs to `storage::media_refs`.

### CardHoverMenu

- Hover overlay содержит `Source` и `Connect`; `Connect` открывает
  `CollectionPicker` для связи карточки с каналами.
- Overflow `…` menu содержит action `Rename…` и тот же `Connect` submenu.
- Открывает единый rename dialog для выбранного блока
- Rename не делает silent auto-fix: занятое имя и invalid stem показываются как явные ошибки

### RenameBlockDialog

- Один modal для всех entry points (`CardHoverMenu`, `Detail`)
- Поля:
  - текущее имя файла
  - input `Filename`
  - preview финального `<stem>.md`
- При success закрывается и UI уже работает с `new_slug`
- Ошибки `name_taken` / `invalid_filename` показываются inline

### Search (Cmd+K)

Модальное окно command palette:
- Слушает глобальный `Cmd+K`
- Текстовое поле с автофокусом
- Debounce 200ms перед вызовом `search(query)`
- Результаты: список карточек с иконкой типа + заголовок + теги
- Enter / клик — навигация к блоку (scroll-to в grid)
- Esc — закрытие

### Detail (fullscreen overlay)

Полноэкранный detail layer при клике на карточку:
- Занимает app content area: `absolute inset-0 z-10`
- Не использует отдельный dim/blur overlay; это полноценный режим просмотра внутри приложения
- Верхнее меню detail имеет фиксированную высоту `h-8`
- В верхнем меню показывается filename (`media_file`, иначе `${slug}.md`) в `font-mono text-sm text-muted-foreground`
- Справа в верхнем меню находятся shared overflow menu (`CardMoreMenu`) и close button
- Разделительная линия верхнего меню прозрачна в начале и становится видимой только когда scroll content доезжает до её зоны
- Двухслойный layout: scroll-слой (контент + невидимый спейсер) и fixed-слой (метаданные)
- Оба слоя используют общий `LAYOUT_CLASSES` для идентичного позиционирования
- Контент центрирован горизонтально (`mx-auto max-w-[58rem]`)
- Scroll/content top padding: classic `pt-12`, island `pt-20`; вместе с верхним меню это сохраняет общий visual top offset
- Scroll/content bottom safe space: `pb-20` lives on the inner content layer, not on `[data-detail-scroll]`, so the final article line does not press against the bottom edge while scrollbar geometry stays unchanged
- Метаданные справа (Geist Mono): AUDIO, WARNING, RESOLUTION, DATE, TYPE, SOURCE, AUTHOR
- Metadata labels используют `text-sm text-muted-foreground`; значения — `text-sm text-foreground`
- `FILENAME`, `Rename…` и `TAGS` не рендерятся в metadata panel; rename/delete/source/channel actions живут в shared overflow menu
- После успешного rename Detail продолжает показывать тот же блок уже под новым slug и новым visible title
- Кнопка X справа вверху, Esc для закрытия
- Стрелки влево/вправо — линейная навигация между блоками
- Detail — plain div с `absolute inset-0 z-10` (не Radix Dialog)

### Клавиатурная навигация

#### Grid (экран коллекции)
- Стрелки (4 направления) — перемещение фокуса между карточками
- Визуальная навигация по координатам (`getBoundingClientRect`): ближайшая карточка в направлении стрелки с весовой функцией `primaryAxis + 3 × crossAxis`
- Enter — открыть выделенную карточку в Detail
- Esc — сбросить фокус
- Выделение: `ring-2 ring-ring` на карточке
- `focusedBlockId` (state) + автоподскрол (`scrollIntoView({ block: "nearest" })`)
- При закрытии Detail фокус возвращается на последнюю просмотренную карточку

#### Detail
- Стрелки влево/вправо — линейная навигация (prev/next по массиву `activeBlocks`)
- Capture phase + `stopPropagation` — не даёт стрелкам дойти до dnd-kit и браузера
- Модификаторы (Cmd/Alt/Ctrl) пропускаются — не перехватывают Opt+Cmd+Arrow

#### Переключение каналов
- Opt+Cmd+Up/Down — навигация по `orderedTags` (All → каналы по порядку)
- Автоподскрол сайдбара к активному каналу (`[aria-current="page"]`)
- При переключении Detail закрывается (`useEffect` на `location.pathname`)

## Путь к ассетам

Tauri WebView не может загружать файлы напрямую по file:// пути. Используем `convertFileSrc()` из `@tauri-apps/api/core`:

```typescript
import { convertFileSrc } from "@tauri-apps/api/core";

const thumbUrl = convertFileSrc(vaultPath + "/.arena/cache/thumbs/" + slug + ".jpg");
const mediaUrl = convertFileSrc(vaultPath + "/" + mediaFile);
```

## Slug-sensitive DOM lookups

После перехода на human-readable filenames `slug` может содержать пробелы, Unicode и пунктуацию. Поэтому любые DOM selector interpolation по `data-block-slug` должны идти через helper (`src/lib/domSelectors.ts`), который использует `CSS.escape`, а не через raw `querySelector(\`[data-block-slug="${slug}"]\`)`.

## Тема

Системная тема (dark/light) через `prefers-color-scheme`. Tailwind v4 автоматически поддерживает `dark:` варианты при наличии `@media (prefers-color-scheme: dark)`.

Цветовая палитра — `neutral` (Tailwind). Минималистичный, чистый интерфейс.

## Ограничения WebKit (Tauri на macOS)

- `backdrop-filter` использовать только на маленьких fixed-height island surfaces (`h-8`); для больших оверлеев и полноширинных баров использовать сплошной фон
- `scrollbar-width: none` не поддерживается — использовать `::-webkit-scrollbar { display: none }`
- `gap` в flexbox/grid — поддерживается с Safari 14.1+, безопасно

## Порядок реализации

1. TypeScript types (`src/types/index.ts`)
2. IPC layer (`src/lib/commands.ts`)
3. VaultPicker — экран выбора vault
4. Layout + Sidebar — навигация
5. Grid + Card — сетка карточек
6. Search — Cmd+K палитра
7. Detail — lightbox
8. Доработки: drag-and-drop, горячие клавиши, анимации
