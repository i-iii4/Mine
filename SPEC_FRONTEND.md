# SPEC: Frontend

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md)

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
  tags: string[];
}
```

### TagCount

```typescript
interface TagCount {
  tag: string;
  count: number;
}
```

### ChannelDto

```typescript
interface ChannelDto {
  tag: string;
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

## IPC layer — `lib/commands.ts`

Тонкая обёртка над `invoke()`. Каждая функция строго типизирована:

```typescript
selectVault(path: string): Promise<ScanResult>
getVaultPath(): Promise<string | null>
listBlocks(): Promise<IndexedBlock[]>
getBlock(slug: string): Promise<IndexedBlock | null>
createBlock(params: CreateBlockParams): Promise<IndexedBlock>
deleteBlock(slug: string): Promise<boolean>
listTags(): Promise<TagCount[]>
addTag(slug: string, tag: string): Promise<void>
removeTag(slug: string, tag: string): Promise<void>
search(query: string): Promise<IndexedBlock[]>
listChannels(): Promise<ChannelDto[]>
createChannel(tag: string, title?: string): Promise<ChannelDto>
deleteChannel(tag: string): Promise<boolean>
```

## Routing

| Путь | Компонент | Описание |
|---|---|---|
| `/` | AllBlocks | Все блоки (по умолчанию после выбора vault) |
| `/channel/:tag` | ChannelView | Блоки, отфильтрованные по тегу канала |
| `/search?q=...` | SearchResults | Результаты поиска |

Vault-пикер — не маршрут, а состояние: если `vaultPath === null`, показываем пикер поверх.

## Components

### AppShell (`App.tsx`)

Корневой компонент. Управляет:
- Состояние vault (путь или null)
- При старте вызывает `getVaultPath()` — если null, показывает VaultPicker
- После выбора vault — Layout с sidebar + router

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

Содержимое:
1. Заголовок «Mine»
2. Пункт «All» — навигация на `/`
3. Список каналов (из `listChannels()`) — навигация на `/channel/:tag`
4. Каждый канал: название + счётчик блоков + до 10 превью-карточек (thumbnails)
5. Разделитель
6. Кнопка «Cmd+K» — открытие поиска

Активный пункт подсвечивается. Каналы отсортированы по `position`.

**Виртуализация.** CSS-native подход: `content-visibility: auto` + `contain-intrinsic-size: auto 42px` на каждом `TagNavItem`. WKWebView на macOS 14.4+ пропускает layout/paint для offscreen channel rows автоматически. Отключается во время drag (`isCardDragging || isDragging`), чтобы `getBoundingClientRect` в dnd-kit возвращал реальную геометрию. `SortableContext` получает полный список channels IDs независимо от видимости.

**Event-driven previews.** Превью карточек в sidebar обновляются через Tauri events (`block:added`, `block:removed`, `thumb:updated`), а не через polling `listChannelPreviews`. Initial state грузится один раз при mount через `listChannelPreviews(20)`, потом инкрементально патчится `useChannelPreviewsEvents` hook'ом. Latency add block → visible in sidebar: ~110ms (native host write + watcher debounce + IPC event + React update). Cache-bust: initial load использует `?m=<mtime>` (unix timestamp thumb-файла из Rust `stat()`), real-time updates используют `?v=<counter>` (per-slug version counter, инкрементируется на `thumb:updated`). Два механизма дополняют друг друга: `?m=` покрывает межсессионные изменения (Phase 2 worker перезаписал PNG→JPEG), `?v=` покрывает live-обновления внутри сессии.

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
- `article` — по длине заголовка, body preview и наличию `first_image`
- После первого paint реальная высота уточняется через `ResizeObserver` и кешируется по `slug`

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

### Search (Cmd+K)

Модальное окно command palette:
- Слушает глобальный `Cmd+K`
- Текстовое поле с автофокусом
- Debounce 200ms перед вызовом `search(query)`
- Результаты: список карточек с иконкой типа + заголовок + теги
- Enter / клик — навигация к блоку (scroll-to в grid)
- Esc — закрытие

### Detail (fullscreen overlay)

Полноэкранный оверлей (справа от sidebar) при клике на карточку:
- Занимает всю область: `fixed inset-y-0 right-0 left-[240px]`
- Overlay затемняет только область справа от sidebar
- Анимация: zoom-in-95 / zoom-out-95
- Двухслойный layout: scroll-слой (контент + невидимый спейсер) и fixed-слой (метаданные)
- Оба слоя используют общий `LAYOUT_CLASSES` для идентичного позиционирования
- Контент центрирован горизонтально (`mx-auto max-w-[58rem]`)
- Метаданные (Geist Mono): RESOLUTION, FILENAME, DATE, TYPE, SOURCE, AUTHOR, TAGS
- Кнопка X справа вверху (ниже 32px drag region), Esc для закрытия
- Стрелки влево/вправо — линейная навигация между блоками
- Detail — plain div с `absolute inset-0 z-10` (не Radix Dialog), внутри `<main>` со стекинг-контекстом `isolation: isolate`

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

## Тема

Системная тема (dark/light) через `prefers-color-scheme`. Tailwind v4 автоматически поддерживает `dark:` варианты при наличии `@media (prefers-color-scheme: dark)`.

Цветовая палитра — `neutral` (Tailwind). Минималистичный, чистый интерфейс.

## Ограничения WebKit (Tauri на macOS)

- Нет `backdrop-filter: blur()` с хорошей производительностью на старых macOS — использовать сплошной фон для оверлеев
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
