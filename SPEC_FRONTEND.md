# SPEC: Frontend

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md)

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
  title: string | null; // legacy frontmatter.title; not canonical for new writes
  content_heading: string | null; // first body H1, if present
  display_title: string | null; // first body H1, then legacy title; null for untitled cards
  fallback_label: string; // filename stem / media filename for non-title surfaces
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
  preview_text?: string | null; // same stripped preview buffer used by feed cards
  first_image: string | null; // indexed primary inline image candidate
  media_urls: string | null; // indexed JSON array of inline/local media refs
  related_notes: string[];
  tags: string[]; // legacy physical name; semantic meaning: CollectionRef[]
}
```

Frontend title rendering follows [SPEC_DISPLAY_TITLE.md](./SPEC_DISPLAY_TITLE.md):
card title slots use `display_title` and render it as one line with ellipsis.
If `display_title` is null, social/quote/media cards do not invent a title
slot; utility surfaces can still show `fallback_label`.

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

Detail article body supports sending a selected text range to a concrete
sidebar collection without turning article text itself into a draggable
surface. Normal selection creation, double-click word selection, triple-click
paragraph selection, system highlighting, `Cmd+C`, and the browser/WebView
context menu remain native.

The primary runtime path is a selection proxy handle. After a valid selection
inside the article body, Detail shows a small drag handle near the first
selected rendered Markdown block. The user drags that handle, not the text
range itself. The handle is a `dnd-kit` draggable with payload
`type: "text_selection"`, so it uses the same Pointer Events drag stack as
card, tag, and inline-media drags and does not depend on WebKit HTML5 selected
text drag behavior.

Native selected-text drag is not a Mine command. If WebKit/OS allows the user
to drag the highlighted text range itself, Mine does not write Mine metadata to
that native drag and sidebar rows must not create cards from it. Card creation
is deterministic and only happens through the visible selection handle.

Rendered Markdown block elements carry source offsets in
`data-mine-md-start` / `data-mine-md-end`. The extraction payload anchors to
the first selected rendered block by these offsets. The backend still treats
the selected text itself as the source of truth and resolves the source block
from exact text search first, then from whitespace-normalized text search with
byte offsets preserved. This is required because rendered Markdown selections
can collapse source newlines into spaces, including CJK paragraphs split across
multiple Markdown lines. Frontend block offsets are only a fallback hint when
the selected text cannot be located directly. This prevents duplicate text from
anchoring to the wrong paragraph without rejecting valid rendered selections.

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
};
```

The selection handle stores the active payload in same-WebView memory at
pointerdown so the payload survives selection changes or handle remounts during
the dnd-kit activation threshold. This store is internal to the handle path; it
is not exposed through native `DataTransfer`.
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

Display mode persists in local preferences via `channelDisplayMode`:
- `Rows` — default table-like sidebar
- `Cards` — alternative channel card layout for non-compact sidebar only

Обычный режим:
1. Пункт `Everything` — навигация на `/`
2. Список каналов (из `listChannels()`) — навигация на `/channel/:tag`
3. Каждый канал: название + счётчик блоков + до 20 превью-карточек
   (thumbnails)

Активный route сохраняется в router state, но sidebar navigation rows,
включая `Everything` и строки каналов, не получают визуальную hover/active
плашку: без `hover:bg-*`, `bg-sidebar-accent` и
`text-sidebar-accent-foreground`. Default label/count color — `text-muted-foreground`.
Текущий выбранный route (`Everything` или активный канал) всегда остаётся
`text-foreground`, даже без hover surface. На hover/focus конкретной строки
sidebar поднимает только текст focused row до `text-foreground`; все остальные
row labels/counts остаются `text-muted-foreground`. Выбранный route также
остаётся `text-foreground`, даже если hover/focus находится на другой строке.
Thumbnail strips и превью-карточки не участвуют в этом state и не меняют ни
opacity, ни layout. Вход/выход text-state анимируется
`180ms cubic-bezier(0.22, 1, 0.36, 1)`;
переключение между строками внутри уже активного focus-mode происходит
мгновенно через `data-sidebar-row-switching="true"` на один animation frame.
Каналы отсортированы по `channels.position`.
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
4a. Visual highlight в link-editor привязан только к membership: связанные
   каналы (`Connected`) используют `text-foreground`, все остальные остаются
   `text-muted-foreground`. Обычный sidebar route highlight и row focus-mode
   внутри link-editor не применяются для текста. Separator contract общий для
   всех режимов sidebar: у каждой строки есть только нижняя seam-owner line.
   По hover/focus accent получают seam текущей строки и seam предыдущей строки,
   так что визуально подсвечиваются обе направляющие hovered row без второй
   линии и без изменения толщины.
5. Правый action slot строки управляет membership через текстовую кнопку, не
   через checkbox. Нажатие на строку вне action slot не меняет membership.
6. Если канал уже связан с открытым блоком, action slot всегда показывает
   `Connected`; на hover/focus строки кнопка замещается действием
   `Disconnect`.
7. Если канал не связан с открытым блоком, без hover/focus виден счётчик; на
   hover/focus счётчик скрывается и появляется кнопка `Connect`.
8. Клик по `Connect`/`Disconnect` вызывает membership toggle и не должен
   вызывать навигацию строки.
9. Строки каналов должны сохранять stable row identity при переключении
   ordinary sidebar ↔ Detail link-editor. Нельзя менять весь row component tree
   только ради action slot: thumbnail strip остаётся тем же DOM-поддеревом, меняется
   только правый action slot. Это предотвращает remount `<img>` и blink превью
   при открытии карточки.

Geometry зависит от Detail top menu mode. В `classic` selector живёт в
полноширинном `h-8 bg-accent` баре с отдельной нижней hairline. В `island` selector живёт в
абсолютной top-пуле (`top-4`, `bg-accent/80`, `backdrop-blur-sm`,
`backdrop-saturate-150`, `rounded-1`, `border`) без фоновой защитной плашки;
список сохраняет top inset `pt-20`.

Sidebar link-editor chrome использует тот же motion contract, что и Detail top
chrome: мягкий `opacity + translateY` enter/exit (`220–280ms`,
`cubic-bezier(0.22, 1, 0.36, 1)`). Close detail не должен блокировать возврат
к grid: sidebar сразу возвращается в обычный interactive state, а exit sidebar
chrome доигрывается неблокирующим overlay-путём.

Row actions не являются частью closing snapshot. Когда `detailChromeClosing`
становится `true`, `Connect`/`Disconnect` overlay-кнопки и фильтр строк
link-editor выключаются сразу, даже если верхний link-editor chrome ещё
доигрывает exit-анимацию.

Count остаётся единственным участником правого row-action layout slot
(`h-8 w-8`). Link-editor action button не должен участвовать в flex layout:
он рисуется как absolute overlay строки (`right-0 top-1/2 -translate-y-1/2`,
`z-10`) с `h-6 w-[10ch]`, `rounded-1 bg-component-fill` и тем же hover
outline, что Button. Появление `Connect`/`Disconnect` не должно менять ширину
thumbnail strip, положение mask/fade или baseline count.
Когда linked action замещается на `Disconnect`, видимый текст получает
`text-destructive`; `Connected` и `Connect` остаются нейтральными.

В полном sidebar mode строки не имеют собственного горизонтального padding:
левое название канала, правый счётчик и правый link-editor action button
выравниваются по краям `data-sidebar-scroll` padding (`px-8`). Правые счётчики
используют `font-mono text-sm text-right`; названия каналов остаются в обычном
UI-шрифте. Освобождённая ширина должна доставаться центральной strip-зоне
preview-карточек. Из-за font side bearings применяется только визуальная
оптическая компенсация, не layout shift: label text получает `translate-x-px`,
а правый count text получает `-translate-x-px`.
Thumbnail strip использует один постоянный CSS mask на самом strip element.
В row-mode у списка есть две общие непрерывные вертикальные направляющие:
левая на `150px` от начала content area (граница `title` → `strip`) и правая
на `88px` от правого края content area: `80px` ширина `Connect/Connected` +
`8px` gap до кнопки. Это не per-row fragments. Между левой направляющей и
первой миниатюрой всегда `4px` воздуха.
Fade начинается от правого края и имеет фиксированную физическую ширину
`24px`, а не процент от ширины strip. Внутри этой зоны применяется eased
multi-stop alpha fade,
после которого у strip есть чистый прозрачный tail, чтобы суммарная
защищённая область от конца fade до правого края строки была `92px`
(`Connect/Connected` ширина `80px` + `8px` gap до линии + `4px` прозрачный
буфер у самой линии). Это не отдельный overlay
layer и не hover-gated state; ordinary sidebar и link-editor режим должны
видеть один и тот же strip fade и одинаковую защищённую область. В точке
правой направляющей preview уже должна быть полностью растворена; последние
`4px` перед линией — гарантированно прозрачный запас.
Hover navigation row не должен менять background. Обычный sidebar count slot не
должен заменяться hover-многоточием или другим action trigger; Rename/Delete
остаются в `ContextMenu` строки. Active route не должен иметь отдельный
selected background. Hover/selection меняют только яркость текста строки; ни
thumbnail strip, ни preview cards не должны участвовать в этом contract и не
могут менять ширину, opacity или layout.
Title text в row-mode не должен уходить в жёсткое ellipsis. Он использует тот
же right-fade contract, что и preview strip: fade `24px` + `4px` прозрачный
tail перед левой направляющей. Title slot остаётся responsive
`min-w-[100px] max-w-[150px] flex-1`: пока хватает места, сначала сужается
preview strip, и только после этого начинает ужиматься текстовая колонка.

Альтернативный `Cards`-mode применяется только в non-compact sidebar. В этом
режиме и `Everything`, и каналы используют один и тот же card shell:
`border border-border bg-accent p-2 mb-2`, без shared seam separators и без
row focus-mode seam accent. Внутри карточки:
1. верхняя строка — stacked thumbnail strip (`w-full`) без row-mode mask;
2. нижняя строка — `title + count` слева и отдельный trailing action slot
   `w-[10ch]` справа;
3. `Connect/Connected/Disconnect` живёт в том же trailing slot, не меняя
   геометрию карточки при открытии Detail.
В card-mode hover preview на миниатюрах включён: trigger'ом является сама
миниатюра, а не вся строка.

**Виртуализация.** CSS-native подход: `content-visibility: auto` + `contain-intrinsic-size: auto 42px` на каждом `TagNavItem`. WKWebView на macOS 14.4+ пропускает layout/paint для offscreen channel rows автоматически. Отключается во время любого drag-to-channel (`isDropDragging || isDragging`), чтобы `getBoundingClientRect` в dnd-kit возвращал реальную геометрию и hover-ring работал одинаково для карточек и inline-media. `SortableContext` получает полный список channels IDs независимо от видимости.

**Event-driven previews.** Превью карточек в sidebar обновляются через Tauri events (`block:added`, `block:removed`, `thumb:updated`), а не через polling `listChannelPreviews`. Initial state грузится один раз при mount через `listChannelPreviews(20)`, потом инкрементально патчится `useChannelPreviewsEvents` hook'ом. Latency add block → visible in sidebar: ~110ms (native host write + watcher debounce + IPC event + React update). Cache-bust: initial load использует `?m=<mtime>` (unix timestamp thumb-файла из Rust `stat()`), real-time updates используют `?v=<counter>` (per-slug version counter, инкрементируется на `thumb:updated`). Два механизма дополняют друг друга: `?m=` покрывает межсессионные изменения (Phase 2 worker перезаписал PNG→JPEG), `?v=` покрывает live-обновления внутри сессии.

**Sidebar thumbnail hover preview.** Миниатюры внутри thumbnail strip в левой
части экрана являются отдельными preview triggers. Это не markdown inline
images и не `RELATED NOTES`. Hover применяется к конкретной `size-8`
миниатюре: `outline-component-fill-hover`, `outline-1`, `-outline-offset-1`,
без изменения layout. Preview показывается только если `PreviewCard` содержит
реальный `slug`; frontend загружает `IndexedBlock` через `getBlock(slug)` и
рендерит существующий `InteractiveCardPreview`. Фальшивая карточка из одного
thumbnail URL недопустима. Outline появляется сразу, а сам popup открывается
только после hover-intent delay `160ms`; уход курсора с миниатюры отменяет
pending open. Popup использует тот же interactive feed-card contract, что и
другие hover previews: `rounded-1`, hover overlay, actions `Source`,
`Connect`, `More`, и click по preview открывает block detail. Surface sidebar
popup использует лёгкую серую заливку `dark:bg-accent` только в тёмной теме; в
светлой теме остаётся `bg-background`, потому что shadow уже отделяет popup от
canvas. Между thumbnail и popup есть hover bridge;
interaction с actions закрепляет popup до outside click. Popup привязан к
DOM-геометрии конкретной миниатюры: раскрывается вниз, если хватает
вертикального места, иначе вверх, с viewport margin. Click по миниатюре
открывает Detail именно этого block slug, а не навигацию строки канала.
Placeholder thumbnail без `slug` может получать обычный визуальный thumbnail
slot, но не interactive preview.

Temporary state: this block remains implemented but disabled behind
`SIDEBAR_THUMBNAIL_HOVER_PREVIEW_ENABLED = false`. While disabled, thumbnails
remain visible in the strip but do not show trigger outline, do not open popup
preview cards, and do not open Detail on thumbnail click. Do not delete the
implementation; it is intentionally gated for later return.

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

### Sidebar Resize

Resize handle должен блокировать нативное WebKit text selection с первого
`pointerdown`, а не только после преодоления drag threshold. На `pointerdown`
handle ставит `body.sidebar-resizing`, вызывает `preventDefault()`, очищает
`document.getSelection()` и захватывает pointer. `startResize()` может
оставаться threshold-gated, чтобы click по handle продолжал toggle collapsed,
но selection suppression не должна ждать этого порога.

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

### CollectionPicker

`CollectionPicker` используется в hover menu, context menu и Detail action row
для связи карточки с каналами. Он не использует checkbox UI. Строка канала сама
по себе не toggles membership; toggle делает только правая action button.

- Connected channel: action button видна всегда и показывает `Connected`; на
  hover/focus строки текст замещается на `Disconnect`.
- Unconnected channel: без hover/focus справа остаётся count; на hover/focus
  count скрывается и появляется `Connect`.
- `Connect`/`Disconnect` используют absolute overlay поверх строки:
  `right-0 top-1/2 -translate-y-1/2 z-10 h-6 w-[10ch] rounded-1
  bg-component-fill px-[1ch] font-semibold` и button hover outline
  `outline-1 -outline-offset-1 outline-component-fill-hover`.
- Overlay-кнопка не является flex item и не меняет ширину thumbnail strip или
  положение gradient mask.
- Видимый `Disconnect` использует destructive button semantics:
  `text-destructive` без изменения серой заливки и outline-hover.
- Клик по action button должен останавливать propagation/default, чтобы событие
  не уходило в parent card, dropdown/context menu trigger или sidebar row.
- UI оптимистически обновляет selected membership внутри открытого picker после
  клика, пока backend mutation и snapshot reload догоняют состояние.

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
- Верхний chrome Detail входит и выходит через мягкий `opacity + translateY`
  transition; нижняя hairline у `classic` живёт отдельным visual layer и
  анимируется отдельно от fill
- Двухслойный layout: scroll-слой (article content + невидимый rail spacer)
  и fixed-слой (метаданные). Оба слоя используют один Detail canvas/grid
  contract, чтобы article column, right rail и top pill подчинялись одной
  горизонтальной системе.
- Detail canvas: `mx-auto w-[calc(100%-4rem)] max-w-[70rem]`. `4rem` keeps
  the article Detail canvas on the same 32px side inset contract as the feed.
  `70rem` — это
  сумма article column `48rem`, gap `2rem` и right rail `20rem`; на широких
  экранах растут внешние поля, а не пустота между article и rail.
- Detail body grid: `grid grid-cols-[minmax(0,48rem)_20rem] gap-8`. Article
  column занимает левую bounded колонку, right rail занимает фиксированную
  20rem колонку и доходит до правого края общего Detail canvas.
- Article column adds `pl-2` inside the left grid column, so article body text
  has an extra 8px guard inset from the top chrome/canvas outer edge instead of sitting flush
  against the framed top pill.
- Fixed rail допускает только vertical scroll (`overflow-y-auto`) и запрещает
  horizontal scroll (`overflow-x-hidden`); metadata/actions/related notes не
  должны создавать внутреннюю горизонтальную прокрутку.
- Scroll/content top padding: classic `pt-12`, island `pt-20`; вместе с верхним меню это сохраняет общий visual top offset
- Scroll/content bottom safe space: `pb-20` lives on the inner content layer, not on `[data-detail-scroll]`, so the final article line does not press against the bottom edge while scrollbar geometry stays unchanged
- Article content keeps a stable top inset (`pt-4`) even when duplicate
  author/title chrome is removed. The inset belongs to the article content
  wrapper; `ArticleBody` itself does not carry a compensating `mt-*` margin.
- Метаданные справа (Geist Mono): AUDIO, WARNING, RESOLUTION, DATE, TYPE, SOURCE, AUTHOR
- Metadata labels используют `text-sm leading-4 text-muted-foreground`;
  значения — `text-sm leading-4 text-foreground`, matching feed-card text scale.
- `FILENAME`, `Rename…` и `TAGS` не рендерятся в metadata panel. Metadata
  table и action row живут в одном framed rail card:
  `overflow-hidden rounded-1 border border-border bg-accent`. Радиус 3px
  следует interface-surface contract; surface использует тот же `bg-accent`,
  что нижний action bar.
  Metadata content использует `px-2 pb-4 pt-4`: horizontal inset matches the
  action row inset, while top/bottom spacing preserves the compact table rhythm.
  Action row использует card-hover action inset contract `px-2 pb-2` и `gap-2`,
  matching `CardHoverMenu` `left-2 right-2 bottom-2 gap-2`; поэтому кнопки не
  выровнены по текстовому padding, как и в оригинальной карточке на главной.
  Кнопки на `bg-accent` surface используют более тёмный component fill
  `bg-component-fill-inner`. В row остаются только `Source` и `Connect`;
  обе кнопки `flex-1` и занимают всю ширину карточки. Overflow menu остаётся в
  верхнем chrome Detail, а не внутри metadata card.
  `RELATED NOTES` остаётся отдельной sibling section ниже; внешний vertical
  rhythm между framed block и `RELATED NOTES` остаётся `gap-6`.
- Для `article` author не дублируется над body; в открытой странице author
  показывается только в metadata panel
- `RELATED NOTES` is a derived note-graph view, not raw `Mine Related Notes`
  frontmatter. It shows the union of direct note links from the current note
  and backlinks from other notes, excludes `channel` docs and self-links, and
  deduplicates by base slug.
- `RELATED NOTES` rows use a compact button-shell with persistent fill/border,
  `8x8` thumbnail on the left, and filename fallback label on the right.
  Hover/focus can show an interactive feed-style card preview. The preview:
  uses `rounded-1`, is keyed by row identity rather than base slug so repeated
  backlinks position independently, opens right when viewport space allows and
  left otherwise, flips upward when it would overflow below, and keeps a hover
  bridge between trigger row and preview. Preview actions reuse `CardHoverMenu`
  (`Source`, `Connect`, `More`). Opening any action pins the preview until an
  outside pointer-down.
- Article inline image hover preview is a separate, not-yet-implemented feature.
  It must not be added by copying the related-notes implementation. The required
  contract is: image wrapper gets the same button-like hover/focus outline
  (`outline-component-fill-hover`, `outline-1`, `-outline-offset-1`), preview
  opens below or above the image depending on available vertical space, and a
  resolver maps `image src/mediaRef` to an existing extracted media block before
  interactive card actions are shown. If no media block exists, only the image
  hover outline is allowed; a fake card preview is not valid.
- Open Detail must refresh its hydrated `IndexedBlock` snapshot on
  `vault-refreshed`, so a newly added connector/link updates `RELATED NOTES`
  in-place without closing and reopening the page.
- После успешного rename Detail продолжает показывать тот же блок уже под новым slug; visible title меняется только если изменился body H1 or legacy `frontmatter.title`, а filename-only surfaces используют новый `fallback_label`
- Markdown body H1 не полагается на prose-default sizes; Detail задаёт `text-lg leading-6 font-semibold` для `h1` и `text-base leading-5 font-semibold` для `h2-h6`, чтобы article typography не выходила за рамки дизайн-системы
- Кнопка X справа вверху, Esc для закрытия. Escape не должен закрывать Detail,
  если событие принадлежит вложенному menu/listbox/input/contenteditable
  surface.
- Стрелки внутри Detail остаются нативными для reading surface и не делают
  линейную навигацию между блоками.
- Detail — plain div с `absolute inset-0 z-10` (не Radix Dialog), но с
  `role="dialog"` и accessible name по текущему filename.
- Close Detail должен быть мгновенным для navigation state: `selectedBlock`
  сбрасывается сразу, grid/sidebar становятся interactive immediately, а exit
  верхнего chrome доигрывается через отдельный closing snapshot без ожидания
  таймера пользователем

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
- Escape закрывает Detail, кроме случаев, когда keyboard event уже
  defaultPrevented или пришёл из вложенного menu/listbox/input/contenteditable.
- Стрелки не перехватываются: чтение статьи не должно случайно переключать
  карточки.
- Модификаторы (Cmd/Alt/Ctrl) пропускаются — Detail не перехватывает
  системные/browser shortcuts.

#### Переключение каналов
- Opt+Cmd+Up/Down — навигация по `orderedTags` (All → каналы по порядку)
- Shortcut не срабатывает, когда открыт Detail, Search, overlay/dialog/menu, или
  фокус находится в input/textarea/select/contenteditable.
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
