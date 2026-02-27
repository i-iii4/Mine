# Architecture: Local Arena

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [PLAN.md](PLAN.md) | [DEVLOG.md](DEVLOG.md) | [CLAUDE.md](CLAUDE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_USECASES.md](SPEC_USECASES.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md)

## Context

Are.na — платформа для визуального букмаркинга и организации идей. Проблемы: данные в облаке, зависимость от сервиса, ограниченный бесплатный план, нет контроля над файлами.

Local Arena решает это: визуальный букмаркинг с локальными файлами. Приложение — окно в файловую систему, не база данных. Если удалить приложение — файлы остаются. Если удалить индекс — он пересобирается.

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
~/LocalArena/                        ← vault (выбирается пользователем)
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

| Component | Purpose | Technology |
|---|---|---|
| Tauri Shell | Нативное окно, IPC между фронтом и бэком | Tauri v2 |
| React Frontend | Сетка карточек, навигация по тегам, поиск | React 19 + Vite + TypeScript |
| Rust Commands | API для фронтенда: CRUD блоков, теги, поиск | Rust, `#[tauri::command]` |
| Indexer | Сканирование vault, парсинг frontmatter, file watcher | Rust, notify crate |
| Frontmatter Parser | Извлечение атрибутов из `.md` файлов | Rust (yaml parsing) |
| DB | Поисковый индекс, кэш тегов, список каналов | rusqlite + FTS5 |
| Thumbnail Generator | Превью изображений 240px | Rust, image crate |
| Vault | Пользовательские файлы на диске | Файловая система |

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

## Dependencies

| Package | Version | Purpose | License |
|---|---|---|---|
| tauri | 2.x | Десктопная оболочка | MIT/Apache-2.0 |
| rusqlite | latest | SQLite из Rust | MIT |
| notify | latest | File system watcher | CC0/Artistic-2.0 |
| image | latest | Обработка изображений | MIT/Apache-2.0 |
| serde | latest | Сериализация | MIT/Apache-2.0 |
| serde_yaml | latest | Парсинг YAML frontmatter | MIT/Apache-2.0 |
| thiserror | latest | Типизированные ошибки | MIT/Apache-2.0 |
| react | 19.x | UI-фреймворк | MIT |
| vite | latest | Сборщик | MIT |
| @tanstack/react-virtual | latest | Виртуальный скроллинг | MIT |
| tailwindcss | 4.x | Стилизация | MIT |
| react-router | 7.x | Роутинг | MIT |
