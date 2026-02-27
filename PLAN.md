# Implementation Plan

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [DEVLOG.md](DEVLOG.md) | [CLAUDE.md](CLAUDE.md)

## Goal

Создать технически совершенное десктопное приложение для macOS — локальную альтернативу Are.na. Файлы на диске (Markdown + frontmatter), каналы — теги, плавный интерфейс на 10 000+ блоков.

**Это не MVP.** Каждый модуль реализуется в финальном качестве.

## Стратегия: вертикальные срезы с эталонным модулем

Каждый модуль проходит полный цикл:
```
SPEC → TEST (красные) → CODE (зелёные) → VERIFY → COMMIT
```

Фаза 1 создаёт **эталонный модуль** (`domain/block`) — образец качества для всех остальных. Уроки из каждого модуля влияют на спецификацию следующего.

## Phases

### Phase 0 — Архитектура и документация [COMPLETED]

Goal: полный каркас проекта — принципы, архитектура, PRD, юзкейсы.

| # | Task | Status |
|---|------|--------|
| 0.1 | CLAUDE.md, ARCHITECTURE.md, PLAN.md, DEVLOG.md | [x] |
| 0.2 | PRINCIPLES.md — инженерные принципы и антипаттерны | [x] |
| 0.3 | SPEC_PRD.md — модель данных, типы блоков, интерфейс | [x] |
| 0.4 | SPEC_USECASES.md — юзкейсы и сценарии | [x] |
| 0.5 | Git + GitHub репозиторий | [x] |

### Phase 1 — Эталонный модуль + инициализация [COMPLETED]

Goal: Tauri-проект инициализирован, `domain/block` реализован идеально — спецификация, тесты, код. Это образец для всех модулей.

| # | Task | Status |
|---|------|--------|
| 1.1 | Инициализация Tauri v2 + React + Vite + TypeScript + Tailwind | [x] |
| 1.2 | Структура директорий: domain/, storage/, watcher/, commands/ | [x] |
| 1.3 | Настройка specta для типогенерации Rust → TypeScript | отложено до Phase 5 |
| 1.4 | SPEC_BLOCK.md — спецификация domain/block | [x] |
| 1.5 | Тесты domain/block (59 тестов, все 20 edge cases) | [x] |
| 1.6 | Реализация domain/block (59/59 зелёных) | [x] |
| 1.7 | Ретроспектива | [x] |

### Phase 2 — Domain layer [COMPLETED]

Goal: вся бизнес-логика реализована и протестирована. Чистые типы и функции, без зависимостей от Tauri/SQLite.

| # | Task | Status |
|---|------|--------|
| 2.1 | SPEC + TEST + CODE: domain/tag (12 тестов) | [x] |
| 2.2 | SPEC + TEST + CODE: domain/channel (20 тестов) | [x] |
| 2.3 | SPEC + TEST + CODE: domain/vault (13 тестов) | [x] |
| 2.4 | SPEC + TEST + CODE: domain/search (15 тестов) | [x] |

### Phase 3 — Storage layer [PLANNED]

Goal: SQLite-индекс, файловые операции, thumbnail-пайплайн. Всё персистентное.

| # | Task | Status |
|---|------|--------|
| 3.1 | SPEC + TEST + CODE: storage/db (схема, миграции, pool) | [ ] |
| 3.2 | SPEC + TEST + CODE: storage/index (frontmatter → SQLite) | [ ] |
| 3.3 | SPEC + TEST + CODE: storage/files (copy, move, naming) | [ ] |
| 3.4 | SPEC + TEST + CODE: storage/thumbnails (генерация, кэш) | [ ] |
| 3.5 | SPEC + TEST + CODE: FTS5 поиск | [ ] |

### Phase 4 — Watcher + Commands (интеграция) [PLANNED]

Goal: file watcher отслеживает vault, Tauri commands связывают бэкенд с фронтендом. Полный сканер vault.

| # | Task | Status |
|---|------|--------|
| 4.1 | SPEC + TEST + CODE: watcher/events (типы, debouncing) | [ ] |
| 4.2 | SPEC + TEST + CODE: watcher/handler (FS → indexer) | [ ] |
| 4.3 | SPEC + TEST + CODE: commands/vault (выбор папки, сканирование) | [ ] |
| 4.4 | SPEC + TEST + CODE: commands/blocks (list, get, create, delete) | [ ] |
| 4.5 | SPEC + TEST + CODE: commands/tags (list, add, remove) | [ ] |
| 4.6 | SPEC + TEST + CODE: commands/search (FTS5 query) | [ ] |
| 4.7 | Интеграционные тесты: полный цикл файл → индекс → команда | [ ] |

### Phase 5 — Frontend [PLANNED]

Goal: полноценный UI — сетка, sidebar, детальный вид, поиск. 60 fps на 10 000 блоков.

| # | Task | Status |
|---|------|--------|
| 5.1 | SPEC: компоненты (Grid, Card, Sidebar, Detail, Search) | [ ] |
| 5.2 | Sidebar: каналы, счётчики, drag-reorder | [ ] |
| 5.3 | Grid: виртуальный скроллинг, режимы (сетка, masonry, список) | [ ] |
| 5.4 | Card: адаптивные карточки по типу блока | [ ] |
| 5.5 | Detail: lightbox, метаданные, теги, wikilinks | [ ] |
| 5.6 | Search: Cmd+K, command palette, мгновенные результаты | [ ] |
| 5.7 | Drag-and-drop файлов → создание блока | [ ] |
| 5.8 | CRUD тегов из UI: добавить/удалить тег, создать канал | [ ] |
| 5.9 | Тёмная/светлая тема (системная) | [ ] |
| 5.10 | Сортировка, горячие клавиши | [ ] |
| 5.11 | Real-time updates: Tauri events → React state | [ ] |
| 5.12 | Тесты компонентов | [ ] |

### Phase 6 — Импорт из Are.na [PLANNED]

Goal: пользователь переносит каналы из Are.na.

| # | Task | Status |
|---|------|--------|
| 6.1 | SPEC: импорт (API, маппинг, ошибки) | [ ] |
| 6.2 | Are.na API: авторизация, каналы, блоки | [ ] |
| 6.3 | Маппинг: Are.na block → .md + медиафайл, channel → тег | [ ] |
| 6.4 | UI импорта: выбор каналов, прогресс | [ ] |
| 6.5 | Тесты с моками API | [ ] |

### Phase 7 — Финализация [PLANNED]

Goal: продакшен-готовность. Профилирование, edge cases, сборка.

| # | Task | Status |
|---|------|--------|
| 7.1 | Профилирование: 10 000+ блоков (рендеринг, скроллинг, поиск) | [ ] |
| 7.2 | Edge cases: битый frontmatter, отсутствующий медиафайл, конфликты имён | [ ] |
| 7.3 | Пересборка индекса из файлов (recovery) | [ ] |
| 7.4 | Автообновление (Tauri updater) | [ ] |
| 7.5 | Иконка, About, меню | [ ] |
| 7.6 | Сборка .dmg, подпись, нотаризация | [ ] |
