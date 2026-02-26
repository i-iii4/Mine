# Architecture: Local Arena

Related documents: [PLAN.md](PLAN.md) | [DEVLOG.md](DEVLOG.md) | [CLAUDE.md](CLAUDE.md)

## Context

Are.na — платформа для визуального букмаркинга и организации идей. Проблемы: данные в облаке, зависимость от сервиса, ограниченный бесплатный план, нет контроля над файлами.

Local Arena решает это: те же концепции (каналы, блоки, связи), но файлы живут локально в папках пользователя. Приложение — окно в файловую систему, не база данных. Если удалить приложение — файлы остаются. Если удалить индекс — он пересобирается.

### Ключевые принципы

1. **Файлы — источник правды.** SQLite — только индекс, как Spotlight для macOS
2. **Канал = папка.** Блок = файл. Навигация в Finder эквивалентна навигации в приложении
3. **Индекс восстановим.** Удаление `.arena/index.db` не приводит к потере данных
4. **Thumbnail-пайплайн.** На экране показываются превью 240px, не оригиналы

## Components

```
┌─────────────────────────────────────────────────────┐
│                    Tauri Shell                        │
│  ┌──────────────────┐    ┌────────────────────────┐  │
│  │   React Frontend  │◄──►│     Rust Backend       │  │
│  │                    │    │                        │  │
│  │  Grid / Cards      │    │  Commands (IPC)        │  │
│  │  Sidebar           │    │  ├── channels.rs       │  │
│  │  Search            │    │  ├── blocks.rs         │  │
│  │  Channel View      │    │  ├── search.rs         │  │
│  │                    │    │  └── thumbnails.rs     │  │
│  └──────────────────┘    │                        │  │
│                           │  Indexer               │  │
│                           │  ├── watcher (notify)  │  │
│                           │  └── scanner           │  │
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
              │  channels/           │
              │  ├── channel-a/      │
              │  │   ├── channel.json│
              │  │   ├── image.png   │
              │  │   └── note.md     │
              │  └── channel-b/      │
              │                      │
              │  .arena/             │
              │  ├── index.db        │
              │  └── cache/thumbs/   │
              └──────────────────────┘
```

| Component | Purpose | Technology |
|---|---|---|
| Tauri Shell | Нативное окно, IPC между фронтом и бэком | Tauri v2 |
| React Frontend | Отображение сетки, навигация, поиск | React 19 + Vite + TypeScript |
| Rust Commands | API для фронтенда: CRUD каналов/блоков | Rust, `#[tauri::command]` |
| Indexer | Сканирование vault, отслеживание изменений | Rust, notify crate |
| DB | Поисковый индекс, связи блок-канал, метаданные | rusqlite + FTS5 |
| Thumbnail Generator | Превью изображений 240px | Rust, image crate |
| Vault | Пользовательские файлы на диске | Файловая система |

## Data flow

### Добавление блока (файла)

```
Пользователь перетаскивает файл в окно
    │
    ▼
Frontend: drop event → Tauri command `add_block`
    │
    ▼
Rust: копирует файл в channels/<channel>/
    │
    ├──► Thumbnail Generator: создаёт превью → .arena/cache/thumbs/
    │
    └──► Indexer: добавляет запись в SQLite (путь, тип, метаданные, FTS)
    │
    ▼
Frontend: получает событие → обновляет сетку
```

### Внешнее изменение (файл добавлен через Finder)

```
File watcher (notify) обнаруживает изменение
    │
    ▼
Indexer: определяет тип изменения (create/modify/delete)
    │
    ├──► create: индексирует + генерирует thumbnail
    ├──► modify: обновляет индекс + перегенерирует thumbnail
    └──► delete: удаляет из индекса + удаляет thumbnail
    │
    ▼
Tauri event → Frontend обновляет UI
```

## SQLite schema (индекс)

```sql
-- Блоки (файлы)
CREATE TABLE blocks (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,        -- относительный путь от vault root
    filename TEXT NOT NULL,
    block_type TEXT NOT NULL,          -- image, text, link, file
    title TEXT,
    description TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    thumb_path TEXT                    -- путь к thumbnail
);

-- Каналы (папки)
CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL
);

-- Связи блок ↔ канал (блок может быть в нескольких каналах через симлинки)
CREATE TABLE block_channels (
    block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    added_at TEXT NOT NULL,
    PRIMARY KEY (block_id, channel_id)
);

-- Полнотекстовый поиск
CREATE VIRTUAL TABLE blocks_fts USING fts5(
    title, description, filename,
    content='blocks',
    content_rowid='id'
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

Rationale: приложение macOS-first, WebKit на macOS стабилен. Бэкенд на Rust идеален для файловых операций, thumbnail-генерации и SQLite.

### 003: Блок в нескольких каналах — через симлинки

| Approach | Problem |
|---|---|
| Копирование файла | Дублирование данных, рассинхронизация |
| Только запись в БД | Файл физически в одной папке, путает при работе через Finder |
| Симлинки (chosen) | Не все ОС хорошо поддерживают, но macOS — поддерживает |

Rationale: симлинк — это «ссылка» на уровне файловой системы. Файл физически один, но виден в нескольких папках. macOS поддерживает симлинки полноценно.

## Dependencies

| Package | Version | Purpose | License |
|---|---|---|---|
| tauri | 2.x | Десктопная оболочка | MIT/Apache-2.0 |
| rusqlite | latest | SQLite из Rust | MIT |
| notify | latest | File system watcher | CC0/Artistic-2.0 |
| image | latest | Обработка изображений | MIT/Apache-2.0 |
| serde | latest | Сериализация | MIT/Apache-2.0 |
| thiserror | latest | Типизированные ошибки | MIT/Apache-2.0 |
| react | 19.x | UI-фреймворк | MIT |
| vite | latest | Сборщик | MIT |
| @tanstack/react-virtual | latest | Виртуальный скроллинг | MIT |
| tailwindcss | 4.x | Стилизация | MIT |
| react-router | 7.x | Роутинг | MIT |
