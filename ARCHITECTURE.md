# Architecture: Mine

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [PLAN.md](PLAN.md) | [DEVLOG.md](DEVLOG.md) | [CLAUDE.md](CLAUDE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_USECASES.md](SPEC_USECASES.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md) | [SPEC_MOBILE.md](SPEC_MOBILE.md) | [SPEC_GRID.md](SPEC_GRID.md) | [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md) | [SPEC_DISPLAY_MODES.md](SPEC_DISPLAY_MODES.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [DESIGN_SYSTEM_IOS.md](DESIGN_SYSTEM_IOS.md)

## Context

Are.na — платформа для визуального букмаркинга и организации идей. Проблемы: данные в облаке, зависимость от сервиса, ограниченный бесплатный план, нет контроля над файлами.

Mine решает это: визуальный букмаркинг с локальными файлами. Приложение — окно в файловую систему, не база данных. Если удалить приложение — файлы остаются. Если удалить индекс — он пересобирается.

### Ключевые принципы

1. **Файлы — источник правды.** SQLite — только индекс, как Spotlight для macOS
2. **Всё — Markdown.** Каждый блок — `.md` файл с frontmatter. Медиафайлы рядом
3. **Каналы — это теги.** Канал = сохранённый фильтр по тегу в frontmatter. Нет папок-каналов
4. **Плоская структура.** Все файлы в корне vault. Позже — изолированные проекты (отдельные vault'ы)
5. **Индекс восстановим.** Удаление `.arena/index.db` не приводит к потере данных
6. **Thumbnail-пайплайн.** На экране показываются превью 240px, не оригиналы
7. **Wikilinks.** Связи между блоками — через `[[wikilinks]]` в Obsidian-стиле

## Data model

### Блок = пара файлов: `.md` (метаданные) + медиафайл (опционально)

#### Ссылка (link)
```markdown
---
type: link
url: https://stripe.com
title: Stripe — Financial Infrastructure
description: Financial infrastructure for the internet
thumbnail: stripe-og.png
tags: [web-design, fintech]
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
---
```
Тело пустое. Рядом лежит `stripe-og.png` (og:image или скриншот).

#### Статья / текст (article)
```markdown
---
type: article
url: https://example.com/crdt-explained
title: Как устроен CRDT
author: Wim Cools
thumbnail: crdt-article-og.png
tags: [programming, distributed-systems]
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
---

Текст статьи или выделенный фрагмент.
Может содержать форматирование и ссылки на изображения.

![[crdt-diagram.png]]
```
Тело — текст. Изображения из статьи скачиваются отдельно.

#### Изображение (image)
```markdown
---
type: image
file: sunset-tokyo.jpg
url: https://unsplash.com/photo/abc
title: Sunset in Tokyo
width: 3840
height: 2160
tags: [photography, japan, inspiration]
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
---
```
Тело пустое. Рядом лежит `sunset-tokyo.jpg`. На фронте — только картинка. Детальный вид через клик показывает атрибуты.

#### Видео / PDF / файл
```markdown
---
type: video
file: demo-reel.mp4
url: https://youtube.com/watch?v=xxx
title: Demo Reel 2026
thumbnail: demo-reel-thumb.jpg
tags: [portfolio, motion]
saved_at: 2026-02-26T14:30:00Z
---
```
Аналогично: `.md` с метаданными + медиафайл рядом.

### Каналы = теги

Канал — это **динамический вид**, фильтрующий блоки по значению в `tags[]` frontmatter.

| Действие пользователя | Что происходит |
|---|---|
| Сохраняет блок с тегами | Теги записываются в frontmatter `.md` файла |
| Добавляет тег к блоку | Обновляется frontmatter + SQLite-индекс |
| Создаёт канал из тега | Канал = сохранённый фильтр по тегу |
| Открывает канал | Показываются все блоки с этим тегом |
| Блок в нескольких каналах | Несколько тегов в `tags[]` — никаких симлинков |

Список каналов (тегов, которые стали каналами) хранится в `.arena/index.db`, но восстановим из frontmatter.

### Vault — файловая структура

```
~/Mine/                        ← vault (выбирается пользователем)
├── .arena/                          ← служебные данные
│   ├── index.db                     ← SQLite: FTS5, кэш тегов, каналы
│   └── cache/
│       └── thumbs/                  ← thumbnails 240px
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
              │   Vault (filesystem)  │
              │                      │
              │  *.md + media files   │
              │  (flat structure)     │
              │                      │
              │  .arena/             │
              │  ├── index.db        │
              │  └── cache/thumbs/   │
              └──────────────────────┘
```

### iOS Architecture

```
┌───────────────────────────────────────────────┐
│              iOS App (SwiftUI)                 │
│                                                │
│  GridView ──► DetailView                       │
│  (@State навигация, без NavigationStack)       │
│  CardViews: Social, Image, Article, Link, Video│
│  LoopingVideoView (AVPlayerLooper — автоплей)  │
│       │                                        │
│  VaultViewModel (@MainActor)                   │
│       │                                        │
│  ┌────▼───────────────────┐                    │
│  │  UniFFI Swift Bindings  │                   │
│  │  ArenaVault.open()      │                   │
│  │  .scanVault()           │                   │
│  │  .listBlocks()          │                   │
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
| SwiftUI Views | Сетка, карточки, детальный просмотр | SwiftUI, AVKit |
| VaultViewModel | Мост SwiftUI → Rust FFI | Swift (@MainActor) |
| core-ffi | UniFFI bindings: ArenaVault Object, FfiLightBlock Record | Rust, uniffi |
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
| React Frontend | Сетка карточек, навигация по тегам, поиск | React 19 + Vite + TypeScript |
| Rust Commands | API для фронтенда: CRUD блоков, теги, поиск | Rust, `#[tauri::command]` |
| Indexer | Сканирование vault, парсинг frontmatter, file watcher | Rust, notify crate |
| Frontmatter Parser | Извлечение атрибутов из `.md` файлов | Rust (yaml parsing) |
| DB | Поисковый индекс, кэш тегов, список каналов | rusqlite + FTS5 |
| Thumbnail Generator | Превью 240px: изображения (resize), статьи (text-to-image) | Rust, image + ab_glyph + imageproc |
| Import | Импорт каналов из Are.na | Rust, ureq (sync HTTP) |
| Web Clipper | Chrome/Safari расширение: сохранение из браузера | Manifest V3, Readability.js, TurndownService |
| Native Host | Мост между расширением и vault (stdin/stdout JSON + локальный HTTP upload) | Rust (bin/native_host.rs), ureq, tiny_http |
| Vault | Пользовательские файлы на диске | Файловая система |

### Frontend rendering model

- `App.tsx` больше не хранит в памяти весь корпус `LightBlock` ради клиентской фильтрации. Горячий путь — `list_grid_blocks(current_tag)`: backend сразу отдаёт карточки текущего маршрута, исключает channel-документы и не передаёт per-block tag arrays. Полные теги блока догружаются через `get_block(slug)` только когда открыт hover/context menu или Detail.
- Открытие vault двухфазное: `select_vault` / `get_vault_path` поднимают SQLite, watcher и последний индексированный snapshot сразу, а `full_scan()` уходит в фоновый поток. Фронтенд слушает `vault-sync-started` / `vault-sync-finished` и обновляет snapshot после завершения синхронизации, не блокируя первый usable paint.
- Переключение vault не делает `window.location.reload()`. `App.tsx` remount'ит `AppWithVault` по `key={vaultPath}`, сбрасывает локальное состояние и игнорирует stale async-ответы через `vaultPathRef + requestId`.
- `Grid.tsx` использует собственный windowed masonry renderer: карточки позиционируются абсолютно, контейнер получает вычисленную `totalHeight`, в DOM остаются только видимые элементы плюс overscan.
- Геометрия карточки больше не должна выводиться из независимых эвристик в `Card.tsx` и `cardHeight.ts`. Введён общий descriptor-driven слой (`src/lib/cardLayout.ts`): variant карточки, preview text и media geometry вычисляются один раз и затем используются и для рендера, и для расчёта высоты.
- Layout вычисляется чистой функцией (`src/lib/masonryLayout.ts`): `containerWidth + estimatedHeights -> columnCount + positions + totalHeight`. Это снимает зависимость от browser masonry/layout для тысяч карточек и ускоряет resize.
- **Direction-aware overscan**: при скролле вниз forward-overscan 2200px, backward 600px. При скролле вверх — зеркально. Это предзагружает больше карточек по направлению scroll'а, уменьшая «пустые зоны» при быстром скролле.
- **Priority bounds**: зона ±1400px по направлению scroll'а, внутри которой карточки получают `priority=true`. ImageCard/LinkCard/ArticleCard используют `loading="eager"` вместо `"lazy"` — картинки начинают fetch до того как пользователь до них доскроллит.
- **CLS prevention**: ImageCard при наличии `block.width`/`block.height` рендерит контейнер с `aspectRatio: W/H` и `overflow:hidden bg-accent`, картинка через `absolute inset-0 object-cover`. Размер карточки стабилен до загрузки картинки — нет layout shift.
- Высоты карточек сначала оцениваются эвристикой по типу блока, затем уточняются через `ResizeObserver` и кэшируются по `slug`.

### Sidebar preview pipeline

- Sidebar previews больше не строятся через полный `list_blocks_light()` с фильтрацией по всем тегам в памяти. Бэкенд отдаёт top-N slug'и отдельными SQL-запросами: один для `__all__`, один window-function запрос для `top N per tag`.
- Frontend считает previews производным состоянием сервера: `useChannelPreviewsEvents` делает initial refresh и затем коалесцирует `block:added`, `block:removed`, `thumb:updated`, `vault-changed` в повторный `list_channel_previews`, вместо локального patch-state.
- Формирование preview item всё ещё читает thumb-файл с диска (`exists`, PNG magic, mtime) на горячем пути. Следующий шаг оптимизации — перенести `has_thumb` / `thumb_mtime` в SQLite, чтобы убрать filesystem syscalls из sidebar path.

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
    ├──► Создаёт .md файл с frontmatter (type, file, tags, saved_at)
    │
    ├──► Thumbnail Generator: превью → .arena/cache/thumbs/
    │
    └──► Indexer: парсит frontmatter → SQLite (блок, теги, FTS)
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
    ├──► .md файл создан: парсит frontmatter → индексирует
    ├──► .md файл изменён: перечитывает frontmatter → обновляет индекс
    ├──► медиафайл создан: генерирует thumbnail (ждёт .md для полной индексации)
    └──► файл удалён: удаляет из индекса + thumbnail
    │
    ▼
Tauri event → Frontend обновляет UI
```

### Тег → Канал

```
Пользователь видит список всех тегов в sidebar
    │
    ├──► Клик по тегу → фильтр: показать все блоки с этим тегом
    │
    └──► «Создать канал» → тег получает статус канала в index.db
         (отображается в sidebar как постоянный пункт навигации)
```

## SQLite schema (индекс)

```sql
-- Блоки (файлы)
CREATE TABLE blocks (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,           -- относительный путь .md от vault root
    block_type TEXT NOT NULL,            -- image, article, link, video, file
    title TEXT,
    description TEXT,
    url TEXT,                            -- source URL (для ссылок и статей)
    media_file TEXT,                     -- имя связанного медиафайла
    mime_type TEXT,
    size_bytes INTEGER,
    width INTEGER,                       -- для изображений/видео
    height INTEGER,
    saved_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    thumb_path TEXT
);

-- Теги (кэш из frontmatter)
CREATE TABLE block_tags (
    block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (block_id, tag)
);

-- Индекс для быстрого поиска по тегу
CREATE INDEX idx_block_tags_tag ON block_tags(tag);

-- Каналы (теги, которые стали каналами)
CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    tag TEXT UNIQUE NOT NULL,            -- тег, по которому фильтруем
    title TEXT NOT NULL,                 -- отображаемое имя (может отличаться от тега)
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
| Файлы + SQLite-индекс (chosen) | Нужен file watcher и синхронизация индекса, но данные всегда доступны |

Rationale: пользователь должен иметь возможность удалить приложение и сохранить все данные. Файлы — универсальный формат. SQLite пересобирается из файлов за секунды.

### 002: Tauri вместо Electron

| Approach | Problem |
|---|---|
| Electron | 150+ МБ, отдельный Chromium, избыточен для локального приложения |
| Tauri (chosen) | 3-6 МБ, нативный WebKit, Rust-бэкенд. Ограничения CSS (Safari-уровень) |

Rationale: приложение macOS-first, WebKit на macOS стабилен. Бэкенд на Rust идеален для файловых операций, thumbnail-генерации и SQLite. Thymer выбрал Electron из-за кросс-платформенности — у нас другие приоритеты.

### 003: Каналы — это теги, не папки

| Approach | Problem |
|---|---|
| Канал = папка на диске | Блок в нескольких каналах требует симлинков или дубликатов |
| Канал = тег в frontmatter (chosen) | Нужен парсер frontmatter, но один файл — много каналов без дублирования |

Rationale: теговая модель (как Mymind) проще и надёжнее папочной (как Are.na). Блок в 5 каналах — это 5 тегов в одном файле, а не 5 симлинков. Теги редактируются в любом текстовом редакторе.

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

### 008: Thumbnail-превью фильтруются на бэкенде

| Approach | Problem |
|---|---|
| Фронтенд генерирует URL из slug'а, `<img onError>` скрывает сломанные | Tauri `asset://` не всегда вызывает `onError` для несуществующих файлов. `<img>` показывает знак вопроса (macOS broken image). `display: none` блокирует `onLoad`. |
| Rust-команда `list_channel_previews` с `Path::exists()` (chosen) | Фронтенд получает только slug'и с реальными файлами. Ноль визуальных артефактов. |

Rationale: бэкенд знает, какие файлы реально есть на диске. Фронтенд не должен гадать — это нарушает разделение ответственности и приводит к визуальным хакам.

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

### 011: Собственный virtualized masonry renderer вместо browser layout для больших коллекций

| Approach | Problem |
|---|---|
| CSS masonry / `grid-lanes` с тысячами DOM-узлов | Resize и переключение каналов упираются в relayout всего дерева. `content-visibility` помогает paint, но не убирает стоимость layout |
| Собственный windowed masonry renderer (chosen) | Сложнее реализация: нужен layout engine, cache высот и absolute positioning |

Rationale: на больших коллекциях bottleneck смещается с IPC на main-thread layout. Когда в DOM находятся только видимые карточки, resize и route switch перестают зависеть от общего числа блоков в разделе.

### 012: Zero-jank masonry через Canvas measureText precomputation

| Approach | Problem |
|---|---|
| Estimate heights → render → measure → correct (классический virtualized masonry, предыдущая реализация) | Корректировки высот меняют `totalHeight` → браузер клампит `scrollTop` → видимый прыжок. Scroll anchoring в masonry не работает из-за non-uniform column shifts. Первое посещение канала с 10000 блоков всегда порождает прыжки |
| Rust cosmic-text precompute в SQLite | Font metrics не совпадают pixel-perfect с браузерным рендером (1-3px drift per line), не портируется на web-деплой без дублирования логики |
| **Canvas `measureText` в Web Worker + IndexedDB cache word_widths** (chosen) | Каждый браузер считает своим text engine → гарантированная pixel-perfect точность. Один code path для Tauri desktop и будущего web-деплоя. `useSyncExternalStore` избегает React ре-рендеров во время scroll |

Rationale: корневая причина прыжков — цикл measurement → correction. Устраняем цикл через precomputation word widths в Worker'е до первого layout pass. Высоты становятся чистой функцией `(block, columnWidth, wordWidths)` → корректировки физически не могут возникнуть. Cross-platform корректность бесплатно как побочный эффект архитектуры.

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
| Readability.js | 0.6.x | Извлечение статей (content script) | Apache-2.0 |
| TurndownService | 7.x | HTML → Markdown (content script) | MIT |
| eslint + typescript-eslint | 10.x | Линтинг фронтенда (TypeScript) | MIT |
