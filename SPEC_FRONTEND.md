# SPEC: Frontend

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md) | [SPEC_FEED_SCROLL_PERFORMANCE.md](SPEC_FEED_SCROLL_PERFORMANCE.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md)

## Overview

React 19 + TypeScript + TailwindCSS v4 фронтенд для Mine. Работает внутри Tauri v2 WebView (Safari/WebKit). Взаимодействует с Rust-бэкендом через `@tauri-apps/api/core` (invoke). Ассеты (thumbnails, медиафайлы) отображаются через `convertFileSrc`.

## TypeScript types

Backend DTO и типизированные ошибки генерируются из Rust/Specta в committed
`src/types/generated.ts`. `src/types/index.ts` только реэкспортирует generated
контракт и объявляет действительно frontend-owned interaction/view types.
`bun run bindings:generate` обновляет файл, а `bun run bindings:check` и
`verify:core` запрещают drift между Rust и TypeScript. Примеры ниже описывают
форму generated типов, но не являются вторым ручным источником правды.
Generic `CommandError` сериализуется tagged union и нормализуется единым IPC
adapter в читаемый JavaScript `Error`; feature-specific tagged errors проходят
без потери `kind` к соответствующим UI handlers.

### IndexedBlock

```typescript
interface IndexedBlock {
  id: number;
  slug: string;
  block_type: "image" | "article" | "link" | "video" | "file" | "channel"; // legacy frontmatter.type
  card_kind: "article" | "media" | "link" | "channel"; // derived runtime/card kind
  title: string | null; // legacy frontmatter.title; not canonical for new writes
  content_heading: string | null; // first body H1, if present
  display_title: string | null; // first body H1, then legacy title; null for untitled cards
  fallback_label: string; // filename stem / media filename for non-title surfaces
  description: string | null;
  url: string | null;
  media_file: string | null; // normalized from canonical file wikilink/raw legacy frontmatter
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

`LightBlock` mirrors the feed-safe subset of `IndexedBlock`. In active Surface
Search mode it may include search-only metadata. The Hybrid Search metadata
shape is:

```typescript
interface SearchMatch {
  field: "title" | "description" | "author" | "body" | "url" | "semantic";
  kind: "exact" | "prefix" | "fuzzy" | "alias" | "semantic";
  excerpt: string;
  ranges: Array<{ start: number; end: number }>;
  score: number;
  explanation?: string;
}
```

`search_match` is search-only metadata. It must be absent or `null` in normal
route snapshots. `ranges` are backend character offsets, so Card rendering
slices excerpts by Unicode characters rather than JavaScript UTF-16 code units.

Frontend title rendering follows [SPEC_DISPLAY_TITLE.md](./SPEC_DISPLAY_TITLE.md):
card title slots use `display_title` and render it as one line with ellipsis.
If `display_title` is null, social/quote/media cards do not invent a title
slot; utility surfaces can still show `fallback_label`.

`card_kind` is the source of truth for card/detail rendering. `block_type`
is still delivered for compatibility and diagnostics, but the frontend must
not branch on legacy source types such as `image`, `link`, `video`, or `file`.
Media presentation is resolved from `card_kind`, `media_file`, `thumbnail`,
`preview_manifest`, dimensions, URL, and file extension.

### TagCount

```typescript
interface TagCount {
  tag: string; // legacy physical name; semantic meaning: CollectionRef
  count: number;
}
```

### VaultStats

```typescript
interface VaultStats {
  totalFileCount: number;
  markdownFileCount: number;
  mediaFileCount: number;
  sourceBytes: number;
  currentCollectionCardCount: number;
  currentCollection: string | null; // null means Everything
  updatedAtMs: number;
}
```

### ChannelDto

```typescript
interface ChannelDto {
  tag: string; // legacy physical name; semantic meaning: CollectionRef
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

### MergeBlocksResult

```typescript
interface MergeBlocksResult {
  block: IndexedBlock;
  merged_slug: string;
  removed_slugs: string[];
}
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
prepareDeleteBlocks(slugs: string[]): Promise<DeleteBlocksPlan>
deleteBlocks(slugs: string[], deleteUnusedMedia: boolean): Promise<boolean>
mergeBlocks(orderedSlugs: string[]): Promise<MergeBlocksResult>
renameBlockFile(oldSlug: string, newStem: string): Promise<RenameBlockResult>
listTags(): Promise<TagCount[]>
addTag(slug: string, tag: string): Promise<void>
removeTag(slug: string, tag: string): Promise<void>
listChannels(): Promise<ChannelDto[]>
createChannel(tag: string): Promise<ChannelDto>
deleteChannel(tag: string): Promise<boolean>
getVaultStats(currentCollection?: string | null): Promise<VaultStats>
```

## Delete confirmation

- Grid and Detail delete entry points open the same App-level delete dialog through `prepareDeleteBlock` before committing.
- If the plan has `unused_media`, the dialog shows compact previews, uses the card thumbnail/poster for video previews, and offers both `Keep media` and `Delete`.
- `Keep media` commits with `deleteUnusedMedia=false`: only the `.md` card and derived artifacts are removed.
- Media referenced by other cards is never offered for deletion and remains on disk.
- Batch delete uses the same plan-first contract through
  `prepareDeleteBlocks(slugs)`. The returned `DeleteBlocksPlan` is computed
  against the whole selected set, so media shared only among selected cards can
  be offered as `unused_media` once. Commit uses one `deleteBlocks(slugs,
  deleteUnusedMedia)` backend command instead of looping over `deleteBlock`.

## File drop overlay

The global file `DropZone` listens to Tauri webview drag/drop events and should
show the import overlay only for real file drags. It must gate overlay state on
the Tauri `enter` event carrying at least one path. Plain native drags inside
the WebView, including selected text extraction drags, must not show the `Drop
files to add` overlay. While the overlay is visible, `Escape` cancels the
overlay state without importing anything.

## Native selection policy

Mine runs as a native-feeling WebKit app, so app chrome must not expose random
blue system selection rectangles while the user drags across the toolbar,
sidebar, feed cards, metadata rail, hover previews, or media surfaces.
`global.css` disables `user-select` at the app level and disables native
image/video drag. Only editable controls (`input`, `textarea`, `select`,
`contenteditable`) and Detail article prose (`[data-article-body]`) opt back
into text selection.

Detail article text remains the only non-editable reading surface where native
selection is expected. Inline media extraction surfaces inside that prose opt
back out while they are draggable, so image extraction uses Mine's pointer
drag path rather than WebKit's native image drag.

## Text selection extraction

Detail article body supports sending a selected text range to a concrete
sidebar collection without turning article text itself into a draggable
surface. Normal selection creation, double-click word selection, triple-click
paragraph selection, system highlighting, `Cmd+C`, and the browser/WebView
context menu remain native.

The primary runtime path is a compact selection action bar. After a valid
selection inside the article body, Detail shows one horizontal floating menu
near the first selected rendered Markdown block:

- left: drag grip. The user drags this grip, not the native highlighted text.
  It is a `dnd-kit` draggable with payload `type: "text_selection"`, so it uses
  the same Pointer Events drag stack as card, tag, and inline-media drags and
  does not depend on WebKit HTML5 selected text drag behavior. Visually it uses
  the same ghost icon button contract as close: no independent border or fill.
- right: `Create Element`, `Delete Text`, and close.

`Create Element` opens the same searchable channel picker contract as media asset
`Create Element`: `Everything` plus channels, shared `SearchMenuInput`, shared
`QuantizedMenuScrollArea`, and optional channel creation when the filtered list
is empty. It uses the same `Plus` icon convention as the main grid group-action
bar. Selecting `Everything` creates the text card without collection membership.

`Delete Text` removes the selected text from the source article. It uses the
`Trash2` icon and patches only the selected text range; it does not delete the
source card and does not create a new card. Close clears the transient native
selection/action bar without creating, deleting, or modifying content.

Placement is calculated by the shared text-selection action-bar placement
helper. The action bar is rendered through a `document.body` portal and is
measured from its real DOM size; width constants are only first-frame fallback.
It is horizontally centered over the first valid `selection.getClientRects()`
rect, then clamped to the visible article safe area. It prefers the area above
the selected range; when there is not enough top room it flips below the
selected range. Top-right and top-left selections therefore stay visible by
applying flip first and horizontal clamp second.

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

Drag/drop or `Create Element` creates a new article card through
`extractTextSelection`; it does not connect the source card itself and does not
enter the inline-media extraction path.

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

The action bar grip stores the active payload in same-WebView memory at
pointerdown so the payload survives selection changes or action-bar remounts
during the dnd-kit activation threshold. This store is internal to the Mine
selection-action path; it is not exposed through native `DataTransfer`.
Existing `dnd-kit` paths remain responsible for card/tag drag and inline-media
extraction.

After successful extraction:

1. Detail remains open on the source article.
2. The command emits normal `block:added` / `thumb:updated` events for the new
   card, and App schedules grid/taxonomy/preview refresh immediately after the
   successful drop.
3. Metadata renders the related note as provenance/source context, not as a
   synced body.

After successful deletion:

1. Detail remains open on the source article.
2. Backend validates source hash and selected source block range before writing.
3. Backend patches the source `.md`, re-indexes that same source block and emits
   `thumb:updated` for it.
4. App refreshes grid/taxonomy/previews immediately and updates the open Detail
   block if it is the patched source.
4. Clicking a related note that includes `#^block-id` opens the source article
   by base slug and scrolls the Detail body to the visible block-id marker when
   the marker is still present.

## Routing

| Путь | Компонент | Описание |
|---|---|---|
| `/` | AllBlocks | Все блоки (по умолчанию после выбора vault) |
| `/channel/:tag` | ChannelView | Blocks filtered by percent-encoded `CollectionRef` |

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
- Sidebar (resizable `220–600px`, может быть collapsed)
- Main area (flex-1, содержит Outlet роутера) имеет минимум `304px`: `240px`
  минимальной metadata card + два боковых inset по `32px`.
- Минимальная ширина desktop window: `904px` = `600px` максимального sidebar +
  `304px` минимальной правой/main области. Значения фронтенда живут в
  `src/lib/appLayout.ts`, нативный window guard — в `src-tauri/tauri.conf.json`.

### Sidebar

Sidebar uses one table-like row contract in both compact and non-compact
layouts. The earlier experimental `Cards` display mode was removed; Settings
must not expose a channel display-mode selector.

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

Geometry не добавляет ad-hoc пустой header над списком. Основной shell имеет
второй top-bar level: `h-8 border-b border-border bg-background`, split на
sidebar segment и main/content segment, с тем же sidebar width contract
(`var(--sidebar-width)`) и `border-r border-sidebar-border`. Сам список sidebar
держит только `pt-8` (`32px`) на `data-sidebar-scroll`; суммарный visual top
offset expanded главной = второй bar `32px` + list inset `32px` = `64px`.
Link-editor selector живёт в полноширинном
`bg-accent` second-level shell row, а не как дополнительная flow-плашка или body
overlay. Открытие Detail не должно добавлять случайный flow-элемент над списком.

Sidebar link-editor chrome использует тот же motion contract, что и Detail top
chrome: мягкий `opacity + translateY` enter/exit (`220–280ms`,
`cubic-bezier(0.22, 1, 0.36, 1)`). Close detail не должен блокировать возврат
к grid: sidebar сразу возвращается в обычный interactive state, а exit sidebar
chrome доигрывается неблокирующим overlay-путём.
Переключение между открытыми карточками не является lifecycle-событием для
этой плашки: изменение `linkedBlockSlug` не должно сбрасывать `data-entered` и
не должно повторно запускать enter transition.

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
Hover на thumbnail открывает только read-only card preview. Preview не
интерактивен (`pointer-events: none`), не содержит `Source` / `Connect` /
`More`, не имеет hover bridge и закрывается сразу, когда pointer уходит с
thumbnail. Выделение строки и outline thumbnail остаются локальными состояниями
trigger'а и не переносятся на popup. Cold open delay — `500ms`; если предыдущий
preview был открыт в течение `800ms` warm window, следующий thumbnail открывает
preview с `0ms` delay.
Right/context click на thumbnail открывает app-level карточное меню
(`CardPointMenu`) для конкретного блока из preview strip. Thumbnail обязан
`preventDefault()` и `stopPropagation()` для `contextmenu`, чтобы событие не
попало в `ContextMenuTrigger` строки канала. Right/context click по любой другой
области строки канала продолжает открывать только меню управления каналом
(`Rename` / `Delete`). Пока карточное меню открыто, sidebar thumbnail hover
updates frozen так же, как в Graph View: текущий hover preview не заменяется
другой карточкой и pending preview timers отменяются. Когда карточное меню
закрывается, frozen preview сохраняется только если последняя позиция pointer
всё ещё внутри исходного thumbnail trigger. Если pointer ушёл, preview
закрывается на том же unfreeze transition; freeze не должен превращать hover
preview в sticky card.
Title text в row-mode не должен уходить в жёсткое ellipsis. Он использует тот
же right-fade contract, что и preview strip: fade `24px` + `4px` прозрачный
tail перед левой направляющей. Title slot остаётся responsive
`min-w-[100px] max-w-[150px] flex-1`: пока хватает места, сначала сужается
preview strip, и только после этого начинает ужиматься текстовая колонка.

**Виртуализация.** CSS-native подход: `content-visibility: auto` + `contain-intrinsic-size: auto 42px` на каждом `TagNavItem`. WKWebView на macOS 14.4+ пропускает layout/paint для offscreen channel rows автоматически. Отключается во время любого drag-to-channel (`isDropDragging || isDragging`), чтобы `getBoundingClientRect` в dnd-kit возвращал реальную геометрию. Для sidebar drop-target применяется `sidebarPointerWithin`: фактический row под курсором берётся через `document.elementsFromPoint()` и `[data-sidebar-row]`, после чего fallback идёт в `pointerWithin`. Это защищает drop/hover от stale droppable rects при sidebar scroll/перерисовке и привязывает цель к реальному положению курсора. Drag-over карточки, inline-media или выделенного фрагмента над channel row визуально равен обычному sidebar row hover/focus-mode: `data-sidebar-row-focus-mode`, `data-sidebar-row-focused` и seam accent; отдельный `ring-2 ring-ring ring-inset` для sidebar drop target запрещён. `SortableContext` получает полный список channels IDs независимо от видимости.

**Event-driven previews.** Превью карточек в sidebar обновляются через Tauri events (`block:added`, `block:removed`, `thumb:updated`, `vault-changed`), а не через polling. Initial state и event refresh идут через `listChannelPreviews(20)`; `useChannelPreviewsEvents` коалесцирует события и фильтрует `has_thumb=false` как defense-in-depth. Cache-bust: initial load использует `?m=<mtime>` из SQLite `thumb_mtime`, real-time updates используют `?v=<counter>` (per-slug version counter, инкрементируется на `thumb:updated`). Два механизма дополняют друг друга: `?m=` покрывает межсессионные изменения (Phase 2 worker перезаписал PNG→JPEG), `?v=` покрывает live-обновления внутри сессии.

**Sidebar hover quick look.** The left sidebar hover popup is micro-preview
only: it renders one confirmed `<slug>.jpg` asset plus compact text metadata
and deliberately ignores `preview_manifest.tiles`. This keeps the left menu
aligned with the thumbnail strip contract even when the full feed card is a
multi-image composite/gallery. Related Notes keeps its richer hover preview.

**Main secondary top bar + sidebar inset.** На главной под permanent top chrome
есть второй structural bar `h-8`, split на sidebar/content segments. Sidebar
scroll-content использует `pt-8` (32px), поэтому вместе с bar получается
визуальный offset 64px без пустой плашки внутри scroll container. Не создавать
отдельную пустую header surface для
опциональных баннеров: если banner component возвращает `null`, над списком не
должно оставаться фиксированной белой плашки, которая обрезает scroll-content.
Когда Detail открыт в non-compact режиме, этот же второй bar становится
App-level Detail chrome: sidebar segment показывает `Channels:` + `All /
Connected`, content segment показывает title/filename, `CardMoreMenu` и close.
Sidebar и Detail body не должны рендерить свои дополнительные top overlays в
этот момент; иначе получается третий слой chrome под вторым bar.

В main browsing state этот второй bar рендерит `MainSecondaryStatsBar`, а не
общий toolbar. Левый segment (`data-main-secondary-top-bar-sidebar-segment`)
получает space-level stats из `VaultStats`: total source content file count,
Markdown file count, media file count и source vault byte size.
`totalFileCount` — счётчик пользовательского content layer внутри source vault:
он равен `markdownFileCount + mediaFileCount` и исключает hidden/service
директории вроде `.mine/`, `.obsidian/`, `.git/` и legacy `.arena/`. Правый
segment (`data-main-secondary-top-bar-content-segment`) получает
`currentCollectionCardCount`: в `Everything` это все non-channel карточки, в
канале — карточки, прикреплённые к этому каналу. Active Grid search не меняет
этот счётчик.

Тот же правый segment держит единственный main view-mode switcher:
`View:` + shared compact `SegmentedControl` с options `Grid / Graph`.
Переключатель стоит сразу после route count по левой оси content segment через
`gap-5`, использует тот же UI-контракт, что `Collections: All / Connected` в
expanded card chrome, и пишет выбранный режим в `mine.mainViewMode`. Старые
`ActionButton`-переключатели `Graph/Grid` в bottom action bar или top fallback
не рендерятся.

Форматирование принадлежит frontend helper layer, а не JSX inline logic:

- `formatFileCount(totalFileCount)` returns `1 file`, otherwise `files`
- `formatMarkdownCount(markdownFileCount)` returns compact `.md`
- `formatMediaCount(mediaFileCount)` returns compact `media`
- `formatCardCount(currentCollectionCardCount, inChannel)` returns `1 element` /
  `elements` in `Everything`, and `1 element in collection` /
  `elements in collection` in concrete collection routes
- `formatStorageBytes(sourceBytes)` with decimal units `B`, `KB`, `MB`, `GB`,
  `TB`

Числа форматируются через `Intl.NumberFormat("ru-RU")`; storage size показывает
один десятичный знак только для значений меньше `10` в выбранной единице.
Строка левого segment: `1 464 files    260 .md    1 204 media    4,8 GB`.
Dot не является отдельным separator atom: она является частью label `.md`,
как расширение файла. Разделение между группами делается layout gap, а не
серией символов-разделителей. Строка element count внутри правого segment:
`260 elements` в `Everything` или `260 elements in collection` в коллекции;
`View: Grid / Graph` стоит сразу после неё по той же левой оси.

Realtime behavior: `MainSecondaryStatsBar` resolves all data through
`getVaultStats(currentCollection)`. It loads once after vault open, refreshes on
route changes that alter `currentCollection`, and reuses existing
grid/taxonomy/vault invalidation paths as stats invalidation signals. The
frontend may coalesce multiple invalidations into one animation frame, but must
not poll, debounce for visible delay, or show transient service text. If a
future backend path emits `vault:stats-updated`, the payload must be a complete
`VaultStats` snapshot, not a delta. Until the first snapshot is available, the
bar keeps its fixed geometry and renders empty text slots.

Responsive behavior: stats never wrap and never increase the `h-8` bar height.
The left cluster hides whole atoms from right to left when space is tight:
storage size, then media count, then Markdown count. The right card count has
higher priority than the left cluster and remains visible while any meaningful
content width exists. When Sidebar is collapsed, the left stats cluster is not
rendered; its segment remains an inert drag region.

**Thumbnail upgrade.** Для блоков с inline media которое Rust не умеет декодировать (WebP VP8X, HEIC, AVIF, HEVC), Rust Phase 1 пишет text placeholder на диск. Main app через `useThumbnailUpgrade` hook подписан на `thumb:upgrade-requested` event и отправляет работу в Web Worker (`src/workers/thumbWorker.ts`). Worker декодирует через `createImageBitmap` (native browser decoder, поддерживает все форматы которые WebView рендерит) → `OffscreenCanvas.convertToBlob('image/jpeg', 0.85)` → IPC `save_thumb` → Rust пишет поверх placeholder. После `thumb:updated` event sidebar cache-bust'ит `<img>` URL. Полная архитектура: [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md).

### Grid

Сетка карточек с собственным virtualized masonry renderer:
- Источник данных: `LightBlock[]`
- Количество столбцов: адаптивное, на основе content-box ширины scrollport
  Grid. Initial mount и последующие `ResizeObserver` updates должны читать один
  и тот же width source; padding scrollport не входит в masonry layout width.
- Layout считается чистой функцией: `containerWidth + estimatedHeights -> positions[]`
- **Карточка с открытым меню остаётся на месте.** Пока у карточки открыто любое
  её меню — «…» или `Connect`, — она не покидает ленту, даже если правка вывела
  её из текущей коллекции. Запись уже произошла, ждёт только перестроение
  списка: иначе снятие текущего канала выдёргивало бы карточку вместе с
  открытым меню прямо из-под курсора, посреди жеста. Карточка возвращается на
  свой прежний индекс, поэтому соседи не сдвигаются. Как только меню
  закрывается, лента перезагружается и карточка уходит.
  Механика: `Card` сообщает наверх через `onMenuOpenChange` (покрывает оба меню
  и мышь, в отличие от `onKeyboardMoreMenuOpenChange`, который срабатывает
  только на клавиатурное открытие «…»), `Grid` пробрасывает как
  `onCardMenuOpenChange`, `App` держит множество слагов и передаёт его в
  `reconcileBlocks`.
- `columnWidth` и `left` позиций снапятся к целым CSS-пикселям. Скрытая
  measurement pass использует тот же pixel-snapped width, что и visible render,
  чтобы hover controls внутри `translate3d`-позиционированных карточек не
  переснапливались при opacity/focus transitions.
- Карточки позиционируются абсолютно (`translate(x, y)`), контейнер имеет вычисленную `totalHeight`
- Top inset ленты — `32px` через `marginTop` на `data-grid-layout`, не через padding scrollport.
- Empty channel state: when a real channel route has an authoritative loaded
  route snapshot with zero cards and Grid search is inactive, Grid renders a
  centered italic text placeholder instead of an empty masonry layout:
  `Cards connected to this channel will appear here.` The placeholder is
  centered in the visible Grid viewport, uses a plain `p`, and has no quote
  marker, border, card surface, icon, or CTA. It is not shown for Everything,
  empty search results, or while a route switch/search request is still pending.
- В DOM находятся только видимые карточки + direction-aware overscan: forward 2200px / backward 600px (зависит от направления scroll'а). Предзагружает больше карточек по направлению движения.
- **Priority bounds**: зона ±1400px по направлению scroll'а. Карточки внутри зоны получают `priority=true` → `<img loading="eager">` для image/link/article карточек. Карточки вне зоны — `loading="lazy"`.
- Planned feed scroll readiness is specified separately in
  [SPEC_FEED_SCROLL_PERFORMANCE.md](SPEC_FEED_SCROLL_PERFORMANCE.md). The
  target contract keeps render overscan bounded, computes render/priority/
  preload windows from viewport height and scroll velocity, and adds a separate
  preview-only media preload/decode window (`Image.decode()` + queue + LRU +
  concurrency limits). Implementations must not solve canvas feel by mounting
  the whole route or by preloading original source media.
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

Диспатчер по derived runtime/card kind (`card_kind` API field):

| Тип | Отображение |
|---|---|
| `article` | Body preview, optional body-derived media preview, display title if present |
| `media` | Resolved `media_file` / thumbnail / extension-specific affordance; no synthetic title |
| `link` | Compact title/domain card without a graphic shell unless a ready image preview exists |
| `channel` | Not rendered in feed/grid as a normal card |

Thumbnail отображается через `convertFileSrc(thumbsRootPath + "/" + slug + ".jpg")`,
где `thumbsRootPath` приходит из `open_vault()` и указывает на local derived
store, а не на source vault.

Медиафайлы (для media-карточек без thumbnail): `convertFileSrc(vaultPath + "/" + media_file)`.

Feed card frame is a persistent `border border-border bg-card` surface.
In light theme `--card` uses the same half-step surface as top chrome
(`--chrome`, `oklch(0.99 0 0)`), so cards sit slightly above the page without
becoming a stronger component fill. In dark theme `--card` uses the same
one-step surface as top chrome (`--chrome`, `oklch(0.17 0 0)`), so cards,
hover previews and floating menu shells are visibly filled above the page
background.
Read-only hover previews in Sidebar, Search Overlay and Graph View reuse
`ReadOnlyCardPreview` / `CardFrame`, so their outer fill remains the same
surface as feed cards: base `bg-card`, plus the same `feed-article-card`
class for runtime article cards.
Hover does not change the card frame: no border recolor, outline, inset border,
shadow, glow, transition, or extra overlay. The feed hover affordance is the
card action controls. Feed keyboard focus is not Card state: Grid owns
`focusedSlug` and marks the focused masonry item with
`data-feed-grid-item-focused="true"`. The visual treatment reuses the left
sidebar focus token: the existing Card frame border changes to
`var(--border-accent)` with the same 180ms transition. No card-frame overlay,
extra line, ring, glow, or `foreground` border is rendered. Real graphic slots
inside the focused GridItem are marked by Card as `data-card-graphic-surface`
and receive a visible media wash only in focus mode: light theme darkens with
`oklch(0 0 0 / 14%)`, dark theme brightens with `oklch(1 0 0 / 18%)`. Text-only
cards do not get a graphic surface state.
Article feed cards additionally get `feed-article-card`;
that class applies `background: var(--accent)` only in dark theme
(`data-theme="dark"` or system dark unless `data-theme="light"`). Light theme
article cards stay on the default `bg-card` background.

Article inline media renders from backend-derived paths. For bare Obsidian
embeds such as `![[01.jpg]]`, Detail first asks `preview_manifest.tiles` for a
resolved `source_path` and then loads `convertFileSrc(vaultPath + "/" +
source_path)`. The frontend must not reimplement vault-wide attachment search;
that belongs to `storage::media_refs`.

Markdown paragraphs that contain only embedded media and whitespace are rendered
as a vertical media stack (`data-article-media-stack`), even if the source file
stores several embeds on one physical line. This preserves Obsidian-readable
markdown while preventing inline image wrapping/overlap in Detail. Mixed
text+media paragraphs remain block `<div>` wrappers to avoid invalid
`<p><div /></p>` markup.

### CardHoverMenu

- Hover overlay содержит `Source` и `Connect`; `Connect` открывает
  `CollectionPicker` для связи карточки с каналами.
- Overflow `…` menu содержит `Connect` submenu, `Source`, `Reveal in Finder`,
  `Copy Path`, `Rename…`, collection-scoped `Disconnect from “…”` и `Delete`.
  Правый клик (`CardTagMenu`) зеркалит этот контракт.
- Overflow `…` menu uses the shared `DropdownMenu` focus surface: item
  hover/focus and open submenu trigger render `bg-active`, not `bg-accent`.
- Overflow `…` dropdown and right-click context menu shells use the feed card
  surface (`bg-card text-card-foreground`), not `bg-popover`, so floating lists
  and hover preview cards sit on the same fill.
- Overflow `…` menu uses floating width role `command`: content-sized with
  `12rem` minimum and `18.75rem` maximum. Its `Connect` submenu and the
  bottom-row standalone `Connect` dropdown use width role `picker` (`20rem`)
  because they host `CollectionPicker`.
- Overflow/right-click menu icon policy is conservative: only `Connect` and
  `Source` render icons. `Reveal in Finder`, `Copy Path`, `Rename…`,
  `Disconnect…` and `Delete` reserve the same leading icon slot but render it
  empty, so labels stay aligned. Card membership removal is always named
  `Disconnect`, never `Remove`.
- Programmatic `Cmd+K` requests toggle this overflow menu: first request opens,
  repeated request closes, including when focus is already inside the menu or
  its `Connect` submenu. Keyboard-opened card menus pin only top-right `…`;
  bottom hover actions remain hidden.
- Открывает единый rename dialog для выбранного блока
- Rename не делает silent auto-fix: занятое имя и invalid stem показываются как явные ошибки

### MediaAssetActionMenu

Media asset actions are defined by
[SPEC_MEDIA_ASSET_ACTIONS.md](SPEC_MEDIA_ASSET_ACTIONS.md). This is not a
variant of `CardHoverMenu`: the action target is the local media file rendered
inside Detail/article content, not the block/card that contains it.

Frontend rules:

- render the same wrapper for local media from `frontmatter.file` and body
  embeds;
- show one `Button variant="default" size="icon"` ellipsis trigger in the
  media's top-right corner;
- menu items are `Create Element`, `Reveal in Finder`, `Copy Path`, `Copy Media`,
  `Rename Media...`, `Remove from Element`, `Delete`;
- media action menu icon policy matches card menus: only `Create Element` renders
  the `Plus` icon; all other media commands reserve the leading icon slot but
  render it empty so text aligns without decorative per-command icons;
- the `Create Element` submenu is part of the same searchable floating-menu
  contract as `CollectionPicker`: search stays fixed, the channel list scrolls
  through `QuantizedMenuScrollArea`, rows use the shared `default` 32px token,
  and no raw `max-h-*`/ad hoc scroll cap is allowed;
- `Delete` opens a media-level confirmation that shows the exact media preview
  and all cards/notes returned by `prepare_delete_media_asset`;
- the media-level delete confirmation must not grow or overflow horizontally:
  connected-card rows use the related-note row component, but every wrapper in
  the dialog/list chain is `min-w-0` and long titles truncate inside the fixed
  AlertDialog width;
- image drag uses `type: "media_asset"` and drops on sidebar collections call
  the media materialization command;
- video gets the hover menu but no drag payload;
- remote images and generated thumbnails do not get media-asset controls.

Image media expansion:

- local images expose a top-right `Expand` icon button; left click on the image
  surface is inert and reserved for drag/pan behavior;
- expanded image preview is an app-level overlay below the top bar. It covers
  the main body and bottom action bar, but leaves the top app bar available;
- the secondary plane uses a solid/minimal scrim:
  `background: rgb(0 0 0 / 0.56)` plus `backdrop-filter: saturate(0.55)`.
  It intentionally avoids blur;
- the foreground image is the primary plane and uses
  `box-shadow: 0 24px 96px rgb(0 0 0 / 0.45)` plus
  `outline: 1px solid rgb(255 255 255 / 0.08)`;
- the bottom floating control island contains zoom out, current zoom, zoom in,
  Copy Media, and `Collapse image preview` (`Minimize2`, inward arrows). There
  is no top-right X close button.

### CollectionPicker

`CollectionPicker` используется в hover menu, context menu и Detail action row
для связи карточки с каналами. Он не использует checkbox UI. Строка канала сама
по себе не toggles membership; toggle делает только правая action button.

- Host dropdown/submenu content uses floating width role `picker`:
  `width: min(20rem, available-width)`. The width is intentionally wider than a
  command menu because rows contain a search field, collection label and fixed
  `10ch` action slot. The scrollable list height is owned by
  `QuantizedMenuScrollArea`, not by raw `max-h-*` classes: visible height is
  `list padding + N × rowHeight` after subtracting the fixed search header and
  footer/create action from `--floating-menu-available-height`. This is the
  invariant that prevents partial clipped channel rows in dropdown, context
  submenu and Clipper surfaces.
- Inline picker shells use the same feed card surface as floating menu content:
  `COLLECTION_PICKER_INLINE_SURFACE_CLASS` must include
  `bg-card text-card-foreground`.
- Порядок каналов всегда равен порядку `tags`, полученному из taxonomy/sidebar.
  `selectedTags`, recent tags, current route и optimistic membership changes не
  пересортировывают список; connected-канал после действия не прыгает наверх.
- Search uses the shared `SearchMenuInput` menu-header contract: a flat
  `Input variant="ghost"` row behind the menu's top divider, without its own
  rounded input frame/pill. This must match `Search spaces` and
  `Search collections`; Connect menus do not get a separate form-field surface.
- Rows use shared menu row tokens: `default` = 32px for app dropdown/search
  rows, `clipper` = 40px for clipper-sized rows. Any future token change must
  update the row renderer and the quantized scroll calculation together.
- Printable key из любого места внутри picker фокусирует search input и
  добавляет символ в search query; parent DropdownMenu typeahead не перехватывает
  эти клавиши.
- `ArrowUp` / `ArrowDown` перемещают active item внутри отфильтрованного списка
  и условной строки `Create collection`, когда она показана. Active row/action
  использует `bg-active`, показывает правую action button и скрывает count.
  Pointer hover и keyboard navigation не являются двумя независимыми visual
  states: pointer move и ArrowUp/ArrowDown обновляют один общий
  `activeIndex`. Pointer enter не меняет active row: keyboard-triggered scroll
  не должен отдавать выделение неподвижному курсору, а первый post-keyboard
  pointermove с теми же координатами игнорируется.
- Автоподскролл active row разрешён только для keyboard ownership. Pointer
  hover по частично видимому row не вызывает `scrollIntoView`, чтобы menu не
  дёргался под курсором.
- `Enter` на active row выполняет `Connect`/`Disconnect`, оставляя меню
  пригодным для дальнейшей навигации. `Enter` на active `Create collection`
  создаёт канал и присоединяет текущую карточку.
- `Escape` внутри submenu закрывает только Connect submenu и возвращает фокус
  на parent `Connect` item в overflow menu. В standalone DropdownMenu content
  `Escape` отдаётся родительскому меню.
  Directional back arrow также закрывает Connect submenu по реальному
  `data-side`: `right -> ArrowLeft`, `left -> ArrowRight`,
  `bottom -> ArrowUp`, `top -> ArrowDown`.
- Connected channel: action button видна всегда и показывает `Connected`; на
  active row текст замещается на `Disconnect`.
- Unconnected channel: без active row справа остаётся count; на active row
  count скрывается и появляется `Connect`.
- `Connect`/`Disconnect` используют absolute overlay внутри фиксированного
  right slot `relative h-6 w-[10ch]`: action button —
  `absolute right-0 h-6 w-[10ch] rounded-1 bg-component-fill px-[1ch]
  font-semibold`, button hover outline —
  `outline-1 -outline-offset-1 outline-component-fill-hover`.
  Count/action visibility переключается мгновенно, без `transition-opacity`.
- Batch Connect использует `BatchCollectionPicker` из того же
  `CollectionPicker.tsx`, а не отдельную самодельную menu-разметку. Отличается
  только membership adapter: `all -> Disconnect`, `not-all -> Connect`, без
  partial labels вроде `1/3`.
- Overlay-кнопка не является flex item и не меняет ширину thumbnail strip или
  положение gradient mask.
- Видимый `Disconnect` использует destructive button semantics:
  `text-destructive` без изменения серой заливки и outline-hover.
- Клик по action button должен останавливать propagation/default, чтобы событие
  не уходило в parent card, dropdown/context menu trigger или sidebar row.
- UI оптимистически обновляет selected membership внутри открытого picker после
  клика и не откатывается от stale `selectedTags`, пока backend mutation и
  snapshot reload догоняют состояние.

### RenameBlockDialog

- Один modal для всех entry points (`CardHoverMenu`, `Detail`)
- Поля:
  - текущее имя файла
  - input `Filename`
  - preview финального `<stem>.md`
- При success закрывается и UI уже работает с `new_slug`
- Ошибки `name_taken` / `invalid_filename` показываются inline

### Search

Новый поиск — surface filter, а не command palette. Полный контракт:
[SPEC_SEARCH.md](SPEC_SEARCH.md).

- `Cmd+F` сейчас переключает App-owned main search state без rendered main
  search component. Route-facing механизм поиска не удалён: `searchQuery`
  остаётся входом для фильтрации Grid route: Everything или текущей коллекции.
  Permanent top chrome uses `bg-chrome`, the app-shell surface midway between
  `bg-background` and the bottom/action/search `bg-accent` surface.
  Settings exposes `Hide bottom menu`, persisted in `localStorage` as
  `mine.bottomActionBarHidden`. When enabled, the bottom app bar is not
  rendered at all, no placeholder row remains, and the same Settings control
  is rendered in permanent top chrome with `side="bottom"` so the user can
  restore the bar. `Cmd+,` targets whichever Settings control is mounted.
  The `80px` traffic-light reserve is not a transparent spacer: it receives
  the same surface class as permanent top chrome and is marked with
  `data-traffic-light-reserve`. App also syncs the native Tauri window
  background via `getCurrentWindow().setBackgroundColor()` to the same resolved
  surface (`--chrome`), so the AppKit
  titlebar area never shows a mismatched fill behind overlay controls. Native
  macOS traffic lights remain AppKit controls, not DOM. Desktop Rust must not
  hide, recolor, alpha-toggle, or install a custom tracking state machine over
  the real `Close` / `Miniaturize` / `Zoom` standard window buttons. Inactive
  gray circles, hover color, native outline, disabled/active states and click
  behavior are owned by macOS. The frontend only reserves the `80px` zone and
  syncs the native titlebar background to the same resolved top-chrome surface.
  The frontend must not draw fake traffic lights or outline the native buttons.
  Theme selection also syncs native appearance through Tauri `setTheme()`:
  explicit `Light` calls `setTheme("light")`, explicit `Dark` calls
  `setTheme("dark")`, and `System` calls `setTheme(null)` so AppKit follows the
  OS. This is the only allowed way to align traffic-light light/dark rendering
  with Mine's theme; arbitrary button colors remain unsupported and forbidden.
  Top chrome делится той же границей `--sidebar-width`, что и body: слева
  traffic-light spacer, space selector, sidebar channel search и
  `border-r border-sidebar-border`, справа current collection switcher и
  оставшийся drag region. Так разделитель Sidebar/Main продолжается до
  верхнего края окна, а search не является overlay над Grid.
- В правой части bottom app bar есть `Search elements` action с shortcut label
  `⌘F`. Это command trigger, не selected/toggle visual state: кнопка не
  остаётся визуально нажатой при активном search state. Кнопка и повторное
  `Cmd+F` закрывают main search state и очищают query. Закрытие не анимирует
  страницу и не меняет scroll viewport.
- Bottom app bar actions use `ActionButton`: outer `h-6 p-[2px]`, inner text
  boxes `h-5 inline-flex items-center leading-none`. Vertical centering is
  owned by fixed 20px inner boxes, not by vertical padding.
- Пока visual component скрыт, `Cmd+F`/`Search elements` не создают input и не
  переносят caret.
- Если пользователь начинает Grid group selection при активном main search,
  пустой search становится inactive; непустой
  query/filter остаётся активным, но следующий `Escape` принадлежит selection.
- `Shift+Cmd+F` фокусирует search в левом top chrome segment и фильтрует
  только список каналов. Визуальный порядок в сегменте: traffic-light spacer,
  separator `w-px bg-border`, top-chrome `VaultSwitcher`/space selector,
  separator `w-px bg-border`, no-icon `Input ghost` (`h-8 px-3 py-0
  rounded-0`), затем штатный `border-r border-sidebar-border`.
- При свернутом Sidebar левый top chrome segment не следует за
  `--sidebar-width: 0px` и не держит пустой слот под скрытый search. Он
  shrink-wrap'ится через CSS intrinsic sizing: `80px` traffic-light reserve +
  `1px` separator + `VaultSwitcher` в collapsed mode с `max-w-[159px]`; весь
  segment capped by `max-w-[240px]`. Space selector остаётся видимым, channel
  search скрывается, а правая часть top chrome начинается сразу после compact
  collapsed segment. Hidden measurement/probe и вычисление ширины по visible
  `[data-vault-switcher]` запрещены. Короткие имена пространства не получают
  ellipsis; truncation допустим только для длинных имён, превышающих cap.
- Space selector показывает текущую папку, открывает searchable dropdown
  известных vaults и заменяет старый bottom-bar vault switcher.
  `Cmd+Shift+O` продолжает открывать native folder picker.
- Каждая строка списка несёт два действия над самой папкой: `Reveal in Finder`
  (`FolderOpen`) и удаление из списка (`X`). Иконки появляются при наведении
  или когда строка активна, и живут рядом со строкой, а не внутри неё: строка —
  `button`, вложенный в неё контрол был бы невалидной разметкой. Оверфлоу-меню
  здесь сознательно не используется — меню внутри открытого меню борется с
  внешним за указатель и фокус, а два действия не нуждаются в контейнере.
- Иконка удаления — `X`, а не `Unlink`. `Unlink` в дизайн-системе закреплён за
  `Disconnect`, то есть за разрывом связи карточки с коллекцией; здесь речь о
  другом действии, и одна иконка на два смысла делает оба менее читаемыми.
- Оформление действий строки: `Button variant="ghost" size="icon-xs"` с
  `text-muted-foreground` в покое и `bg-component-fill-hover` +
  `text-foreground` при наведении/фокусе — тот же контракт, что у кнопки
  очистки поиска. Размер глифа задаёт контракт `icon-xs`; локально его не
  переопределять, иначе иконки расходятся по размеру с остальным приложением.
  `--detach` появляется только при наведении на удаление: постоянно окрашенная
  иконка читается как предупреждение о самой папке, а не как доступное
  действие.
- Удаление из списка требует подтверждения, и текст диалога обязан снимать
  главное заблуждение: файлы на диске не трогаются, папка просто перестаёт
  числиться в списке. Кнопка подтверждения — обычная, не `destructive`:
  красный сообщал бы о потере данных, то есть ровно то, что диалог опровергает.
- Every `vault-selected` event replaces the mounted vault subtree by source
  path identity. During rapid `A -> B -> A -> B` switching, promises and events
  from an unmounted subtree cannot publish cards, taxonomy, preview updates or
  readiness into the final subtree. The final visible Grid must contain only
  the latest selected space even when earlier IPC responses resolve later.
- Space selector подстраивается под имя текущей папки, но ограничен половиной
  доступной ширины после traffic-light зоны (`max-w-[50%]`). Имя папки режется
  end ellipsis. Root trigger остаётся прозрачным, использует `px-3` и не
  содержит dropdown chevron. Текст использует тот же typography mode, что
  Detail top bar: `font-mono text-sm text-muted-foreground`, regular weight.
  Hover/open/focus рисует только inner pill вокруг имени (`h-6 rounded-1 px-2
  bg-active text-foreground`), тем же state token, что `DropdownMenuItem`
  hover/focus. Space selector уже идёт после traffic-light reserve, поэтому
  root `px-3` плюс inner pill `px-2` ставят текст на compact `20px` axis после
  separator, а не на правую `32px` content axis. Focus fill разрешён только для keyboard focus. Pointer-open не
  восстанавливает focus на trigger после закрытия dropdown, чтобы click не
  оставлял sticky hover-colored state. Pointer drag не открывает dropdown:
  Radix pointer-open отложен до click, а click подавляется, если gesture
  перешёл в window drag. В collapsed sidebar state selector использует
  `max-w-full`, потому что search input скрыт. Search input занимает остаток и полагается на native
  input scrolling, чтобы при вводе были видны последние символы.
- Space dropdown renders a `Search spaces` input, only destination spaces and a
  pinned `Add space` action. The current space is omitted entirely, with no
  checkmark/selected/disabled duplicate row. `Add space` is plain and iconless.
  The dropdown uses floating width role `selector`:
  `width: min(18rem, available-width)`. The dropdown is anchored to the visible
  inner selector pill, not to the invisible root layout slot: top-chrome space
  selector uses Radix `align="start"` with `alignOffset=12`.
- Sidebar search renders as a `data-sidebar-top-search-surface` wrapper with a
  transparent `Input ghost` and an optional clear action. Empty hover/focus
  changes only placeholder text from tertiary to muted; it does not add a
  background. Search input text uses the same permanent top-chrome typography
  as Detail top bar: `font-mono text-sm text-muted-foreground`, regular
  weight. When the trimmed query is non-empty, only the search surface is filled
  with `bg-accent`, matching the bottom action bar surface. The top header,
  space selector and separator lines remain on `bg-chrome`.
- The clear action appears only when the input value is non-empty. It is an
  icon-only `X` button (`h-6 w-6 rounded-1`, `aria-label="Clear channel
  search"`). Clicking it clears the query, restores the full channel list and
  returns focus to the input. `Escape` with a non-empty value clears the field;
  `Escape` with an empty value blurs the input.
- While Sidebar channel search is focused, unmodified `ArrowUp`/`ArrowDown`
  navigate visible Sidebar rows through `aria-activedescendant`; DOM focus
  stays in the input, so typing can continue without re-focusing the field.
  `Enter` activates the active row, including the create-channel row.
- All search inputs suppress native browser/WebKit typing suggestions through
  shared `SEARCH_INPUT_SUPPRESSION_PROPS`: `autoComplete="off"`,
  `autoCorrect="off"`, `autoCapitalize="none"`, `spellCheck={false}`. This
  applies to top chrome search, `Search spaces`, `Search collections` and
  channel connect pickers, without changing normal text-entry dialogs.
- Right top chrome contains a current collection switcher. The trigger shows
  the active Grid route label (`Everything` or current channel name), uses the
  same transparent root + inner `bg-active` hover/open/keyboard-focus pill
  contract as the space selector. Trigger typography matches Detail top bar:
  `font-mono text-sm text-muted-foreground`, regular weight; hover/open/focus
  raises only the inner pill text to `text-foreground`. Expanded mode keeps the
  right-side `32px` content axis (`px-6` root + `px-2` pill);
  compact/collapsed sidebar mode uses `px-3` root padding to align with the
  space selector and remove the extra gap. It contains no dropdown chevron and opens a
  `DropdownMenu` with a `Search collections` input. Dropdown rows are ordered
  exactly like Sidebar collections and use the shared
  `filterAndRankChannelSearch` matcher. The active collection is not rendered
  in the dropdown at all: no duplicated current label, no checkmark, no radio
  marker, no selected/current row. Selecting an item immediately navigates to
  `/` or `/channel/:tag`; the switcher derives current state only from route.
  The search input remains the only focus owner while the dropdown is open:
  pointer hover over destination rows must not blur or move focus out of the
  input. Destination rows and the pinned create action are menu-styled buttons
  with `role="menuitem"`, not roving-focus `DropdownMenuItem`. A fixed pinned
  bottom `Create collection` action is always available and never appears as an
  inline search result; it opens a separate create-channel dialog, which may
  prefill from the search query, validates empty/duplicate names, refreshes
  snapshots and navigates to the new channel after creation.
  `Search collections` and `Search spaces` use the same input-owned keyboard
  model as Sidebar search: `ArrowUp`/`ArrowDown` change
  `aria-activedescendant`, while the input remains focused.
  The dropdown uses the same floating width role `selector` as Space dropdown:
  `width: min(18rem, available-width)`. The dropdown is anchored to the visible
  inner collection pill, not to the invisible root layout slot: expanded mode
  uses Radix `alignOffset=24`, compact/collapsed mode uses `alignOffset=12`.
- Top chrome controls must remain usable as window drag handles. Interactive
  chrome controls use the shared `4px` pointer threshold: movement below the
  threshold is handled as normal click/focus/editing, movement at or above it
  calls `getCurrentWindow().startDragging()` and suppresses the click generated
  at the end of that drag gesture. Empty chrome regions still use
  `data-tauri-drag-region`. Plain clickable controls use
  `useChromeDragGesture()`. Dropdown triggers use
  `useTopChromeTriggerInteraction()` so pointer drag never opens the dropdown
  and pointer-close does not leave a sticky focus-colored trigger.
- Compact Detail top menu is an optional Settings flag, persisted in
  `localStorage` as `mine.compactDetailTopMenu`. The setting changes top-chrome
  geometry before Detail opens: the right collection switcher uses compact
  geometry (`px-3`) even on the main Grid screen, so `Everything` and channel
  names keep the same horizontal position before, during and after Detail.
  Opening Detail must not remount or shift that collection switcher; Detail only
  adds animated sibling controls. When the flag is on and Detail is open, the
  global top chrome still remains on `bg-chrome` and owns the Detail controls. The
  internal Detail top bar is not rendered, and the Sidebar `Channels:`
  link-editor top bar is not rendered.
- In Compact Detail mode the `All / Connected` segmented control is part of
  the left Sidebar/search segment, not the right Detail title segment. In
  expanded Sidebar state it sits inside the same search surface as
  `Search collections...`, to the right of the input and to the left of the
  vertical Sidebar divider. In collapsed Sidebar state channel search remains
  hidden and the segmented control is omitted; there is no useful row list to
  filter in the collapsed rail, and adding the control creates unnecessary
  chrome. The `Channels:` label is omitted. The segmented control is the same
  App-owned `linkMode` state that filters Sidebar rows (`all` vs linked
  channels), so there is no second filtering state.
- Compact Detail right top chrome layout after the Sidebar/search divider:
  persistent clickable `TopCollectionSwitcher`, opened-card title, card
  overflow button, close button. The collection control must keep the normal
  dropdown behavior and stable DOM/layout identity across Detail open/close;
  plain text collection labels are forbidden.
- Compact Detail controls inherit the same top-chrome drag contract. The
  expanded `All / Connected` control is inside the Sidebar search surface and
  delegates dragging to that parent surface. The collapsed `All / Connected`
  surface, the close button and the compact card overflow trigger are directly
  draggable via the shared threshold. `CardMoreMenu` uses this behavior only
  when explicitly rendered with top-chrome interaction enabled; regular card
  menus keep ordinary card/menu pointer behavior.
- Compact Detail top chrome uses compact control spacing only: `px-3` root
  slots and `h-6 p-[2px]` segmented controls/buttons. The right-side `32px`
  content axis (`px-6` / `px-8`) is forbidden throughout this setting, including
  the main Grid state before any Detail is open. The far right edge still keeps
  compact inset (`pr-3`) so the close button never touches the window edge.
- The gap between the visible collection pill and the card title is a single
  compact slot. `TopCollectionSwitcher` owns the right-side `px-3`; the card
  title starts with `pl-0` and does not add a second left padding layer.
- Compact Detail motion uses the existing Detail chrome animation language.
  Detail-only controls (`All / Connected`, card title, overflow, close and
  their collapsed-sidebar separator) enter and exit with `opacity + translateY`
  using `detail-top-bar-enter` / `detail-top-bar-line-enter`. The top chrome
  background is not animated and remains `bg-chrome`; Detail-only controls use the
  same `cubic-bezier(0.22, 1, 0.36, 1)` motion. Route/collection labels that
  already existed on the main Grid screen must not animate, remount or move.
  Close starts the exit state synchronously in the close handler, before
  selected Detail state is cleared, so exit uses the same animated path as
  enter and does not jump to the normal top chrome.
- Responsive priority in Compact Detail top chrome: card title shrinks first
  (`min-w-0 flex-1 truncate`), current collection switcher shrinks second
  through its own compact trigger constraints, Sidebar search shrinks third
  through its existing flex slot. `All / Connected`, overflow and close stay
  non-shrinking and visible.
- `Cmd+K` while Compact Detail top menu is active opens/toggles the compact
  top overflow menu. `Cmd+L` keeps copying the opened card path. Closing Detail
  returns the global top chrome to the normal main-page layout.
- Desktop shortcut delivery идёт через native Tauri menu accelerators:
  `Cmd+F`/`Shift+Cmd+F` emit `surface-search-shortcut` (`main`/`sidebar`).
  DOM `keydown` остаётся browser/dev fallback и принимает physical
  `KeyboardEvent.code === "KeyF"` плюс Latin `key === "f"`.
- `Cmd+K` не участвует в поиске; он остаётся scoped shortcut для card/Detail
  overflow menus.
- Search Overlay вызывает `search_grid_blocks` для непустого query и получает
  `SearchSnapshot`; обычный Grid и recent-режим используют `list_grid_blocks`
  без query-параметра, поэтому поиск не может изменить route snapshot под ним.
- `GridSnapshot.generation` is the persisted SQLite projection generation, not
  a request counter or layout key. `App` accepts generations monotonically for
  the mounted vault. An older route/cache response cannot replace a newer one.
- Pagination may append only when its generation equals the currently rendered
  route generation. A newer page response invalidates the old route snapshot
  and restarts from offset zero; an older page response is discarded.
- Grid receives `blocks`, `total_blocks`, `has_more` and `generation` as one
  atomic IPC envelope. Preview batches update Grid only through a newer full
  snapshot; UI code never patches a ready manifest into rows from another
  generation.
- Taxonomy, sidebar previews and Graph carry the same `ProjectionRevision`.
  `useProjectionRevisionOwner` is the single mounted-vault owner for all four
  surfaces: it accepts revisions monotonically per surface and resets only
  when vault identity changes. Components do not implement independent stale
  response rules.
- `SearchSnapshot` additionally carries `SearchRevision` and an opaque next
  cursor. The cursor binds projection revision, search revision and query
  fingerprint; a reset response replaces results from offset zero instead of
  appending incompatible ranking generations.
  Frontend не знает, какой backend дал результат: FTS5, alias/transliteration,
  fuzzy или semantic. Разница видна только через `search_match.kind`.
- Article-derived feed cards в search mode получают optional `search_match`,
  включая social cards с media preview: title matches подсвечиваются в title,
  body matches заменяют обычный preview на 2-3 строки excerpt вокруг первого
  совпадения. Author/URL matches являются searchable metadata: карточка
  попадает в выдачу и ранжируется, но preview не заменяется, URL не
  раскрывается, `<mark>` не рисуется. Semantic-only matches заменяют preview
  на excerpt, но не рисуют fake `<mark>`, потому что `ranges` пустой.
- Semantic-only matches заменяют обычный preview на semantic excerpt, но не
  рисуют `mark`, если backend не вернул реальный текстовый range.
- Глобальная Search route, нижняя Search-кнопка, `Search.tsx`, `cmdk` UI и
  `Cmd+K` Search fallback остаются удалёнными.

### Detail (fullscreen overlay)

Полноэкранный detail layer при клике на карточку:
- Занимает app content area: `absolute inset-0 z-10`
- Не использует отдельный dim/blur overlay; это полноценный режим просмотра внутри приложения
- Верхнее меню detail имеет фиксированную высоту `h-8`.
- В App shell Detail chrome всегда внешний: в non-compact режиме он живёт во
  втором top-bar level, в Compact Detail top menu — в permanent top chrome.
  Detail body получает `topChromeMode="external"` и не рендерит внутренний
  top menu.
- Внешний non-compact Detail chrome показывает filename/title в
  `font-mono text-sm text-muted-foreground`; справа находятся shared overflow
  menu (`CardMoreMenu`) и close button.
- Внешний non-compact Detail chrome закрывается как единый top-bar transition,
  а не как серия независимых переключений. `MainSecondaryTopBar` держит main
  statistics layer и Detail/link-editor layer в одних и тех же sidebar/content
  segments. При close `detailEntered` сразу становится `false`, surface второго
  bar возвращается в main state, Detail controls получают
  `data-entered="false"`, statistics layer получает `data-entered="true"`.
  Closing snapshot может оставаться смонтированным до конца exit-анимации, но
  он не имеет права удерживать `bg-accent` или откладывать возврат статистики.
  Non-compact close budget — `190ms`; compact Detail top chrome использует
  отдельный `260ms` budget.
- Если Detail получает `topChromeMode="external"`, внутреннее верхнее меню не
  рендерится, а `Cmd+K`/overflow/close принадлежат App-level chrome.
- Верхний chrome Detail входит и выходит через мягкий `opacity + translateY`
  transition; нижняя hairline живёт отдельным visual layer и анимируется
  отдельно от fill
- Верхний chrome Detail анимируется по lifecycle самого Detail (`open` /
  `closing`), но не по смене активного `block.slug`. При переходе между
  открытыми карточками верхний chrome остаётся тем же DOM
  subtree; меняются только filename/action data.
- Sidebar link-editor chrome следует тому же правилу: при переходе между
  открытыми карточками меняются linked channel rows, но `Channels: All /
  Connected` не сбрасывает entered-state и не переанимируется.
- Двухслойный layout: scroll-слой (article content + невидимый rail spacer)
  и fixed-слой (метаданные). Оба слоя используют один Detail grid contract,
  чтобы article column, fixed metadata rail и invisible spacer сохраняли одну
  горизонтальную систему.
- Detail grid: `grid w-full
  grid-cols-[minmax(2rem,1fr)_minmax(400px,48rem)_minmax(2rem,1fr)_20rem_2rem]`.
  Правая колонка `2rem` фиксирует `32px` inset от правого края viewport;
  metadata rail занимает fixed `20rem` inspector column before it.
- Metadata rail width is fixed at `20rem` (`320px`) for articles, images and
  videos. Detail does not resize the rail from viewport thresholds or media
  dimensions.
- Article/media column has a comfortable minimum of `400px`. When the measured
  Detail container width drops below `816px` (`400px` article minimum +
  `20rem` rail + three `2rem` grid insets), Detail switches to stacked layout
  instead of shrinking article text further.
- Stacked layout uses `grid-cols-[2rem_minmax(240px,1fr)_2rem]`: the
  article/media column remains centered with `max-w-[48rem]`, and
  metadata/Connected Cards render as a full-width scroll-flow row below the
  primary content. The fixed metadata overlay layer is not rendered in stacked
  mode.
- Metadata card itself has `min-width: 240px`, so the `Source` / `Connect`
  action row cannot squeeze below its content minimum.
- Article column lives in column 2 (`col-start-2`) and is centered inside the
  remaining space to the left of the metadata rail by the two matching flexible
  tracks around it. На широких экранах воздух растёт между article и right rail,
  а не прижимает metadata к тексту.
- Article column не добавляет внутренний left guard: article body starts at
  the left edge of its bounded article column. Горизонтальную дистанцию до rail
  задаёт grid, not a local padding/margin on article content.
- Fixed rail допускает только vertical scroll (`overflow-y-auto`) и запрещает
  horizontal scroll (`overflow-x-hidden`); metadata/actions/related notes не
  должны создавать внутреннюю горизонтальную прокрутку.
- Scroll/content top padding: `pt-8`; вместе с in-flow верхним `h-8` меню это
  сохраняет общий visual top offset `64px`. Article column, invisible
  right-rail spacer and fixed metadata rail must use the same compensated
  layout classes, so left sidebar rows, article body and right rail start on
  the same horizontal line.
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
  The thumbnail is the shared `MicroPreviewThumbnail` component: it renders only
  when `IndexedBlock.thumb_format` confirms a real micro-preview, appends
  `?m=<thumb_mtime>` for cache busting, and applies the same PNG `dark:invert`
  contract as sidebar thumbnails.
  Hover can show a read-only feed-style card preview. The preview uses
  `rounded-1`, is keyed by row identity rather than base slug so repeated
  backlinks position independently, opens right when viewport space allows and
  left otherwise, flips upward when it would overflow below, and closes when
  the pointer leaves the row trigger. It is non-interactive
  (`pointer-events: none`), has no hover bridge, and does not show
  `Source` / `Connect` / `More`. Timing matches sidebar thumbnails: `500ms`
  cold open delay, `0ms` warm delay inside an `800ms` warm window.
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

#### Sidebar
- `Control+Cmd+S` — свернуть/развернуть Sidebar.
- Desktop delivery принадлежит native
  `View -> Hide Sidebar` / `View -> Show Sidebar` menu accelerator, который эмитит
  `sidebar-toggle-shortcut`. Frontend `keydown` остаётся только browser/dev
  fallback: при `isTauri() === true` он не меняет состояние, чтобы один жест не
  вызывал native event и второй toggle из WKWebView. Browser fallback проверяет
  physical `KeyboardEvent.code === "KeyS"`, чтобы команда работала на
  нелатинских раскладках.
- React `useSidebarResize.collapsed` остаётся источником состояния. При каждом
  изменении frontend синхронизирует native menu title через
  `set_sidebar_menu_collapsed`: раскрытая панель показывает `Hide Sidebar`,
  свёрнутая — `Show Sidebar`. Поэтому shortcut, toolbar action и resize-collapse
  имеют один menu contract, а native menu не хранит независимое состояние.
- Одно сочетание toggles оба состояния и вызывает существующий
  `useSidebarResize.toggleCollapsed`; отдельного shortcut для expand нет.

#### История страниц
- `Cmd+[` / `Cmd+]` — перейти назад/вперёд по router/browser history.
- Shortcut не срабатывает из input/textarea/select/contenteditable и вложенных
  overlay/menu/listbox/dialog. Из корня Detail shortcut разрешён: route change
  закрывает Detail тем же путём, что обычная навигация.
- Dropdown/menu triggers не открываются от modified shortcut keys:
  `Cmd`/`Ctrl`/`Alt` + `ArrowDown`/`ArrowUp`/`Enter`/`Space` считаются
  глобальными/системными shortcut candidates, а не keyboard-командой trigger.
  Поэтому `Cmd+ArrowDown` на главной странице не может открыть случайное
  card overflow menu, даже если DOM focus остался на скрытой кнопке `…`.

#### Grid (экран коллекции)
- Стрелки (4 направления) — перемещение фокуса между карточками
- Grid владеет `focusedSlug`; App только передаёт `keyboardNavigationDisabled`
  и restore-сигнал `restoreFocusSlug` + `restoreFocusSequence` после закрытия Detail.
- Визуальная навигация идёт по `layout.positions`, а не по DOM. Ближайшая
  карточка в направлении стрелки выбирается по функции
  `primaryAxis + 3 × crossAxis`.
- Первое нажатие стрелки выбирает первую реально видимую committed-card в
  текущем viewport, не первый элемент коллекции.
- Если пользователь вручную проскроллил ленту и текущий `focusedSlug` оказался
  вне текущего viewport, следующее нажатие стрелки сначала ресинхронизирует
  фокус на первую видимую committed-card текущего viewport и не продолжает
  навигацию от старой offscreen-позиции.
- У ленты один interaction owner: `keyboard` или `pointer`. Arrow navigation
  переводит Grid в `keyboard` mode: keyboard focus/badge/media wash включены,
  а CardHoverMenu получает `hoverEnabled=false`, поэтому CSS `group-hover` от
  неподвижного курсора не может параллельно показать hover controls. Реальное
  движение pointer с новыми координатами переводит Grid обратно в `pointer`
  mode. Pointer events с теми же координатами, включая первый stationary
  `pointermove` после keyboard-scroll, игнорируются.
- Меню `…`, открытое через focused-card `Cmd+K`, создаёт отдельный pinned
  anchor visual state: пока menu open, исходная карточка сохраняет
  `data-feed-grid-item-focused`, `⌘K` badge, frame focus и graphic wash даже
  если pointer уже вернул Grid в `pointer` mode. Это не второй interaction
  owner: pointer hover продолжает работать на других карточках. На pinned
  anchor `CardHoverMenu.hoverEnabled=false`, поэтому bottom hover actions не
  появляются и под открытым menu ничего не меняет layout/opacity. Pin снимается
  при закрытии этого keyboard-opened menu.
- Enter — открыть выделенную карточку в Detail
- Esc — сбросить фокус
- Выделение: GridItem получает `data-feed-grid-item-focused="true"`, а
  существующий Card frame меняет border color на тот же token, что sidebar
  focus seam — `var(--border-accent)` — с тем же `180ms cubic-bezier(0.22, 1,
  0.36, 1)` transition. Это не card-frame overlay, не extra line, не ring/glow
  и не `foreground` border. Card не получает focus props/classes.
- Графические surface внутри focused GridItem получают дополнительный
  `data-card-graphic-surface::after` wash: в light theme `oklch(0 0 0 / 14%)`,
  в dark theme `oklch(1 0 0 / 18%)`. Состояние применяется только к реальным
  media/preview slots; текстовые карточки не меняются.
- Focused GridItem показывает top-left shortcut badge `data-feed-grid-action-badge`
  с текстом `⌘K`. Badge рендерится только в Grid keyboard focus mode, не от
  pointer hover, не участвует в layout и не перехватывает pointer events.
  Badge находится внутри `data-feed-grid-action-layer` (`absolute inset-px`),
  чтобы компенсировать 1px Card frame и считать offsets из той же внутренней
  плоскости карточки, что и Card Hover Menu. Сам badge использует
  `absolute left-2 top-2` и interface radius `rounded-1` (3px): `top-2`
  зеркалит `More` (`top-2 right-2`), `left-2` зеркалит bottom action row
  (`left-2 right-2 bottom-2`).
- `Cmd+K` — scoped Grid shortcut: если Grid keyboard focus активен и focused
  committed-card видна в текущем viewport, Grid показывает/pin-ит top-right
  `…` action button и toggles overflow menu этой карточки: первое нажатие
  открывает, повторное закрывает. Нижний hover action row (`Source` /
  `Connect`) при этом не появляется и не pin-ится; он остаётся только pointer
  hover / interactive hover-action affordance. Если Grid focus отсутствует,
  focused card невалидна/offscreen или открыт Detail/dialog/menu, `Cmd+K` не
  открывает глобальный Search, потому что такого surface больше нет.
- Автоподскрол идёт по `layout.positions` и scroll container, без
  `scrollIntoView`/DOM lookup.
- При закрытии Detail фокус возвращается на последнюю просмотренную карточку
  по slug.

#### Grid Group Selection

Полный контракт группового выделения и batch actions живёт в
[SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md). Кратко:

- `Cmd+click` and `Shift+click` both toggle only the clicked committed card
  without opening Detail.
- While group selection is active, plain card click also toggles the clicked
  card and does not open Detail.
- Empty-area pointer drag renders a marquee rectangle and selects every
  committed card whose `layout.positions` rectangle intersects it.
- Grid owns `selectedSlugs` and transient `marqueeSelection`; Card receives
  only derived visual state.
- Starting group selection deactivates empty main search state; non-empty
  query/filter remains active.
- Marquee visual uses design-system tokens: fill from `--active`, border from
  `--border`, no radius.
- Selected GridItem renders `data-feed-grid-item-selected="true"` and an
  individual monochrome external selection frame: `2px` black/white frame with
  a `1px` gap outside the card and no corner radius.
- While one or more cards are selected, Grid suppresses CardHoverMenu hover
  affordances for every feed card. Hidden hover action layers stay
  non-interactive.
- Keyboard batch selection is fully usable from Grid focus: `Shift+Enter`
  toggles the focused card, and once selection exists plain `Enter` toggles the
  focused card instead of opening Detail. Keyboard mode uses Grid `focusedSlug`
  as the source of truth and ignores stale DOM focus on another card. Pointer
  mode can still toggle a committed pointer-hovered or DOM-focused feed card.
  `Enter` must not fall through to Card activation. `Cmd+K` opens a contextual
  batch menu anchored to the focused card's top-right overflow action; the menu
  contains a muted selected-count header plus `Connect`, collection-scoped
  `Disconnect` outside Everything, `Merge` when at least two cards are
  selected, and `Delete`. Its icon policy matches the card menu: icon only for
  `Connect`, empty leading slots for `Disconnect`, `Merge` and `Delete`. The
  menu shell uses floating width role `command`; its `Connect`
  submenu uses role `picker`.
- When at least one card is selected, Grid renders a bottom floating action
  island centered inside the main/right content pane at `bottom-s3` (`16px`
  above the `h-8` app bottom bar), fixed
  `h-8`, opaque theme-surface `bg-accent text-foreground`, no internal
  separators, horizontal overflow when needed, gray Russian count text using
  Detail-top-bar typography
  (`font-mono text-sm text-muted-foreground`, regular weight) and direct
  standard Button actions: `Connect`, text-only collection-scoped
  `Disconnect`, text-only `Merge` for two or more selected cards, text-only
  destructive `Delete`; the icon-only `X` clear button is the rightmost
  control.
- `Merge` opens the reorder-first dialog from
  [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md). The dialog reuses the same
  card-reference row visual as Detail `RELATED NOTES`, lets the user reorder
  selected cards by a drag handle, and commits through one backend
  `mergeBlocks(orderedSlugs)` command. Frontend must not implement merge as
  create-plus-N-deletes.
- Batch Delete opens a plan-first destructive dialog equivalent to single-card
  deletion. It calls `prepareDeleteBlocks(selectedSlugs)`, shows eligible
  unused media when present, offers `Keep media` and `Delete media`, and commits
  through one backend `deleteBlocks` command. Media still referenced by
  non-selected cards/notes is never offered for deletion.
- Selection clears on plain empty-Grid click, route/channel change, plain card
  opening and any App-level Detail open from Sidebar/related surfaces.
- After single-card or batch card deletion, Grid preserves the approximate
  viewport by anchoring to a surviving card from the previous
  `layout.positions` and restoring that card's viewport offset after the new
  masonry generation is committed. Delete reflow must not be driven by the old
  absolute `scrollTop`, and stale keyboard focus must not autoscroll over the
  pending delete anchor.
- Dragging a selected card creates a group block drag: draggable data carries
  every selected slug, App applies channel drops to all dragged slugs, and
  DragOverlay renders a macOS-style `data-feed-drag-stack` preview capped at
  four visible real frozen card-preview layers. The front layer is not
  transformed; back layers use only integer `translate3d(...)` and small
  `rotate(...)`; `scale(...)` is forbidden. If selected count exceeds the
  visible cap, the preview shows a count badge while the payload still carries
  every slug. Dragging a non-selected card while selection exists is a
  single-card drag and clears the old selection on drag start.

#### Detail
- Escape закрывает Detail, кроме случаев, когда keyboard event уже
  defaultPrevented или пришёл из вложенного menu/listbox/input/contenteditable.
- Стрелки не перехватываются: чтение статьи не должно случайно переключать
  карточки.
- `Cmd+L` при открытом Detail копирует абсолютный путь к текущему `.md` файлу
  карточки (`<vault>/<slug>.md`).
- `Cmd+K` внутри открытого Detail toggles верхнее `…` меню classic top bar:
  первое нажатие открывает card overflow menu, повторное закрывает. Shortcut
  не срабатывает внутри nested dialog / image preview overlay.
- Остальные модификаторы (Cmd/Alt/Ctrl) пропускаются — Detail не перехватывает
  системные/browser shortcuts.

#### Переключение каналов
- Opt+Cmd+Up/Down — навигация по `orderedTags` (All → каналы по порядку). При
  открытой карточке она закрывается, и канал переключается: карточка
  принадлежит покидаемому каналу. Detail — полноэкранный просмотрщик внутри того
  же маршрута, а не модальное окно, владеющее клавиатурой, и стрелки он не
  перехватывает. Шорткат по-прежнему молчит в полях ввода, меню, списках и
  прочих диалогах (`isDetailShortcutBlockedTarget`)
- Shortcut не срабатывает, когда открыт Detail, overlay/dialog/menu, или
  фокус находится в input/textarea/select/contenteditable.
- Автоподскрол сайдбара к активному каналу (`[aria-current="page"]`)
- При переключении Detail закрывается (`useEffect` на `location.pathname`)

## Путь к ассетам

Tauri WebView не может загружать файлы напрямую по file:// пути. Используем `convertFileSrc()` из `@tauri-apps/api/core`:

```typescript
import { convertFileSrc } from "@tauri-apps/api/core";

const thumbUrl = convertFileSrc(thumbsRootPath + "/" + slug + ".jpg");
const mediaUrl = convertFileSrc(vaultPath + "/" + mediaFile);
```

## Slug-sensitive DOM lookups

После перехода на human-readable filenames `slug` может содержать пробелы, Unicode и пунктуацию. Поэтому любые DOM selector interpolation по `data-block-slug` должны идти через helper (`src/lib/domSelectors.ts`), который использует `CSS.escape`, а не через raw `querySelector(\`[data-block-slug="${slug}"]\`)`.

## Тема

Системная тема (dark/light) через `prefers-color-scheme`. Tailwind v4 автоматически поддерживает `dark:` варианты при наличии `@media (prefers-color-scheme: dark)`.

Цветовая палитра — `neutral` (Tailwind). Минималистичный, чистый интерфейс.

## Ограничения WebKit (Tauri на macOS)

- `backdrop-filter` использовать только на маленьких fixed-height floating
  surfaces (`h-8`); для больших оверлеев и полноширинных баров использовать
  сплошной фон
- `scrollbar-width: none` не поддерживается — использовать `::-webkit-scrollbar { display: none }`
- `gap` в flexbox/grid — поддерживается с Safari 14.1+, безопасно

## Порядок реализации

1. TypeScript types (`src/types/index.ts`)
2. IPC layer (`src/lib/commands.ts`)
3. VaultPicker — экран выбора vault
4. Layout + Sidebar — навигация
5. Grid + Card — сетка карточек
6. Detail — lightbox
7. Доработки: drag-and-drop, горячие клавиши, анимации
