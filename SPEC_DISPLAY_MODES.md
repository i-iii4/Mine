# SPEC: Display Modes

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_GRID.md](SPEC_GRID.md) | [PRINCIPLES.md](PRINCIPLES.md)

## Overview

Mine поддерживает несколько способов отображения блоков в главной области. Каждый способ — отдельный компонент с единым интерфейсом. Пользователь переключает их через Settings → Layout. Выбор сохраняется между запусками в `localStorage`.

## Принципы

### Display mode = только рендеринг

Изменения в display modes касаются **только** визуального слоя:

**Трогаем:**
- `src/components/MasonryGrid.tsx` (бывший Grid.tsx)
- `src/components/DenseGrid.tsx`, `TableView.tsx`, `ColumnView.tsx` и т.д.
- `src/components/GridSwitch.tsx` (диспатчер)
- `src/components/Card.tsx` (варианты отображения карточки, если mode требует)
- `src/App.tsx` (подключение GridSwitch)
- `src/components/ThemeMenuButton.tsx` (Settings UI)
- `src/hooks/useLayoutMode.ts`

**НЕ трогаем (при добавлении display mode):**
- Sidebar (`Sidebar.tsx`, `useChannelPreviewsEvents.ts`)
- Thumbnail pipeline (`storage/thumbnails.rs`, `commands/thumbnails.rs`)
- Index/storage (`storage/index.rs`, `storage/files.rs`)
- Watcher (`watcher/handler.rs`, `watcher/watch.rs`, `watcher/events.rs`)
- Tauri events и IPC commands
- Types (`types/index.ts`) — только если нужен новый тип для нового mode

### Один mode = один компонент

Каждый display mode — самостоятельный компонент. Нет `Grid.tsx` с параметром `mode="masonry|dense|table"`. Причина: режимы фундаментально различаются по архитектуре рендеринга (masonry = absolute positioning + JS height calculation, dense grid = CSS grid, table = `<table>` или CSS grid с фиксированными строками). Параметризация одного компонента привела бы к ветвлению внутри каждой функции.

### Единый интерфейс

Все display mode компоненты принимают `DisplayModeProps`:

```typescript
interface DisplayModeProps {
  blocks: LightBlock[];
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  scrollToTop: number;
  sidebarCollapsed?: boolean;
  focusedBlockId?: number | null;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onDeleteBlock: (slug: string) => void;
  onColumnCountChange?: (count: number) => void;
}
```

Это тот же интерфейс, что у текущего `Grid`. Каждый mode получает одни и те же данные и обратные вызовы. Разница — только в рендеринге.

## Компоненты

### GridSwitch

Диспатчер. Читает `useLayoutMode()`, рендерит нужный компонент:

```typescript
function GridSwitch(props: DisplayModeProps) {
  const [mode] = useLayoutMode();
  switch (mode) {
    case "gallery":  return <MasonryGrid {...props} />;
    case "grid":     return <DenseGrid {...props} />;
    case "table":    return <TableView {...props} />;
    case "columns":  return <ColumnView {...props} />;
  }
}
```

Используется в `AllBlocksPage` и `ChannelPage` вместо прямого `<Grid />`.

### MasonryGrid (текущий Grid.tsx)

Файл: `src/components/MasonryGrid.tsx` (переименование из `Grid.tsx`)

Masonry layout с virtualized rendering. Сохраняет всю существующую логику: `computeMasonryLayout`, `cardHeight.ts`, `heightCache`, word-width worker, `useGridScroll`.

Это дефолтный режим (`gallery`).

### DenseGrid (сетка с направляющими)

Файл: `src/components/DenseGrid.tsx`

Режим `grid`. Визуальные характеристики:

- **Направляющие** — тонкие линии `border-border` между всеми ячейками. Направляющие — часть дизайна, не невидимая разметка
- **Карточка = набор ячеек**, не обёрнутая в Card с border/shadow. Картинка занимает ячейку целиком
- **Нет отступов** между карточками — только линии
- **Картинки разной высоты**, ширина строго по колонке
- **CSS grid** для layout: `grid-template-columns: repeat(auto-fill, minmax(Xpx, 1fr))`
- **Виртуализация** через `content-visibility: auto` (нативная, без JS windowing)
- **Нет `cardHeight.ts`**, нет `heightCache`, нет word-width worker — высота определяется CSS/browser

Карточки в DenseGrid рендерятся без `<Card>` обёртки. Каждая ячейка:

```
┌─────────────────────┐
│      [image]        │ ← img object-cover, высота по aspect ratio
├─────────────────────┤
│ Display title       │ ← text-sm, 1-2 строки, first body H1 or legacy title
│ domain.com          │ ← text-xs, muted
└─────────────────────┘
```

Линии между ячейками — через `border-bottom border-right` на каждой, контейнер имеет `border-top border-left`.

### TableView

Файл: `src/components/TableView.tsx`

Режим `table`. Табличное представление (как Notion database view или Finder list view).

Колонки: thumbnail (48px) | display title | type | tags | saved_at | author | source

Сортировка по клику на заголовок. Фиксированная высота строки. Virtual scroll через `content-visibility: auto`.

### ColumnView (будущее)

Режим `columns`. Фиксированные колонки (как Kanban или Trello), группировка по тегу/типу. Отложен до востребования.

## Хранение выбора

`src/hooks/useLayoutMode.ts`:

```typescript
type LayoutMode = "gallery" | "grid" | "table" | "columns";
```

Значение в `localStorage` под ключом `layoutMode`. Дефолт: `"gallery"`.

Переключение: Settings → Layout → выбор. Мгновенное применение через CustomEvent `mine-layout-mode` (синхронизация между компонентами без prop drilling).

## Порядок реализации

1. **Rename** `Grid.tsx` → `MasonryGrid.tsx` (чистый rename, export сохраняется)
2. **GridSwitch** — новый компонент-диспатчер. App.tsx использует `<GridSwitch>` вместо `<Grid>`
3. **Settings UI** — Layout секция в ThemeMenuButton (уже частично готова в `useLayoutMode`)
4. **DenseGrid** — первый альтернативный mode
5. **TableView** — второй mode
6. Каждый шаг = отдельный PR с проверкой: sidebar не тронут, gallery mode не сломан

## Pre-flight проверка перед каждым PR

Перед merge любого PR, связанного с display modes:

1. `grep -r "setChannelPreviews\|listChannelPreviews\|useChannelPreviewsEvents" src/` — убедиться что sidebar hooks не в diff'е
2. `git diff --stat` — убедиться что `src-tauri/` не в diff'е (display modes не трогают Rust)
3. Переключиться на gallery mode → sidebar отображается корректно
4. Переключиться на новый mode → sidebar не изменился
5. Перезагрузка → выбранный mode сохранился

## Что НЕ входит в scope display modes

- Изменения в thumbnail pipeline
- Изменения в sidebar preview logic
- Изменения в индексации, парсинге frontmatter, watcher
- Изменения в типах `LightBlock`, `IndexedBlock`, `PreviewItem`
- Drag-and-drop между modes (каждый mode реализует свой DnD если нужно)
