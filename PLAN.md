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

### Phase 3 — Storage layer [COMPLETED]

Goal: SQLite-индекс, файловые операции, thumbnail-пайплайн. Всё персистентное.

| # | Task | Status |
|---|------|--------|
| 3.1 | SPEC + TEST + CODE: storage/db (схема, FTS5 триггеры, WAL) | [x] |
| 3.2 | SPEC + TEST + CODE: storage/index (CRUD блоков/каналов/тегов, поиск) | [x] |
| 3.3 | SPEC + TEST + CODE: storage/files (write, read, scan, copy, delete) | [x] |
| 3.4 | SPEC + TEST + CODE: storage/thumbnails (Lanczos3 ресайз, JPEG) | [x] |
| 3.5 | SPEC + TEST + CODE: FTS5 поиск (встроен в storage/index) | [x] |

### Phase 4 — Watcher + Commands (интеграция) [COMPLETED]

Goal: file watcher отслеживает vault, Tauri commands связывают бэкенд с фронтендом. Полный сканер vault.

| # | Task | Status |
|---|------|--------|
| 4.1 | SPEC + TEST + CODE: watcher/events (классификация notify событий, 9 тестов) | [x] |
| 4.2 | SPEC + TEST + CODE: watcher/handler (full_scan, index_md_file, handle_event, 10 тестов) | [x] |
| 4.3 | SPEC + TEST + CODE: commands/vault (select_vault, get_vault_path) | [x] |
| 4.4 | SPEC + TEST + CODE: commands/blocks (list, get, create, delete) | [x] |
| 4.5 | SPEC + TEST + CODE: commands/tags (list, add, remove) | [x] |
| 4.6 | SPEC + TEST + CODE: commands/search (FTS5 query) | [x] |
| 4.7 | commands/channels (list, create, delete) + AppState + lib.rs wiring | [x] |

### Phase 5 — Frontend [COMPLETED]

Goal: полноценный UI — сетка, sidebar, детальный вид, поиск. 60 fps на 10 000 блоков.

| # | Task | Status |
|---|------|--------|
| 5.1 | SPEC_FRONTEND.md: компоненты, типы, IPC, роутинг | [x] |
| 5.2 | TypeScript types + IPC layer (18 команд) | [x] |
| 5.3 | VaultPicker: выбор папки через системный диалог | [x] |
| 5.4 | Sidebar: каналы, счётчики, навигация, кнопка импорта | [x] |
| 5.5 | Grid: чанковый рендеринг (IntersectionObserver, 80+60 батчи) | [x] |
| 5.6 | Card: адаптивные карточки по типу блока (5 типов) + фолбэк для сломанных изображений | [x] |
| 5.7 | Search: Cmd+K, command palette, debounced FTS5 | [x] |
| 5.8 | Detail: lightbox, теги (добавить/удалить), навигация стрелками | [x] |
| 5.9 | App: роутинг (react-router), состояние vault, загрузка данных | [x] |
| 5.10 | Drag-and-drop файлов → создание блока (DropZone) | [x] |
| 5.11 | Sidebar drag-reorder каналов (HTML5 DnD, reorder_channels команда) | [x] |
| 5.12 | Real-time updates: Tauri events → React state (vault-changed) | [x] |
| 5.13 | Тёмная/светлая тема (системная) — базовая поддержка через dark: | [x] |
| 5.14 | Тесты компонентов (vitest + testing-library, 43 теста, 5 файлов) | [x] |

### Phase 6 — Импорт из Are.na [COMPLETED]

Goal: пользователь переносит каналы из Are.na.

| # | Task | Status |
|---|------|--------|
| 6.1 | Are.na API клиент: пагинация, rate-limiting, десериализация (ureq) | [x] |
| 6.2 | Маппинг: Are.na block → .md + медиафайл, channel → тег | [x] |
| 6.3 | Загрузка медиафайлов и генерация thumbnails | [x] |
| 6.4 | Tauri-команды: list_arena_channels, import_arena_channels | [x] |
| 6.5 | UI импорта: ImportDialog (ввод username, выбор каналов, прогресс-бар) | [x] |
| 6.6 | Тестирование с реальными данными | отложено |

### Phase 7 — Финализация [IN PROGRESS]

Goal: продакшен-готовность. Профилирование, edge cases, сборка.

| # | Task | Status |
|---|------|--------|
| 7.1 | Чанковый рендеринг Grid (IntersectionObserver, 80+60 батчи) | [x] |
| 7.2 | Edge cases: фолбэк при сломанных изображениях, missing media | [x] |
| 7.3 | Пересборка индекса из файлов (rebuild_index команда) | [x] |
| 7.4 | Автообновление (Tauri updater) | отложено — требует ручной генерации ключей |
| 7.5 | Иконка (SVG → icns/ico/png), нативное macOS-меню, About | [x] |
| 7.6 | Сборка .dmg, подпись, нотаризация | [ ] |
| 7.7 | Исправление drag-and-drop: rename_all = "snake_case" для create_block (Tauri v2 camelCase по умолчанию) | [x] |
| 7.8 | Исправление сброса прокрутки Grid: blocksFingerprint вместо ссылки на массив + отображение ошибок в DropZone | [x] |
| 7.9 | Бэкенд: команда rename_channel (обновление тега во всех .md + индексе) | [x] |
| 7.10 | Теги в сайдбаре: отображение всех уникальных тегов из frontmatter, контекстное меню (переименовать/удалить), inline-редактирование | [x] |
| 7.11 | Drag-and-drop карточки на тег (dnd-kit + PointerSensor): pointerWithin коллизия, autoScroll сайдбара, DragOverlay с snapToCursor | [x] |
| 7.12 | Контекстное меню карточки (правый клик): теги с чекбоксами, поиск, создание нового тега, удаление с подтверждением | [x] |
| 7.13 | Drag-and-drop каналов: @dnd-kit/sortable, SortableContext, reorder_channels с автосозданием записей, кнопка «New channel» | [x] |
| 7.14 | Багфиксы drop-зоны: тег текущего канала при file drop, защита от дублирования, isCardDragging для синего кольца, удаление канала при удалении тега, Unicode в slugifyTag | [x] |
| 7.15 | Качество thumbnail: 240→480px (Retina 2x), JPEG quality 80→85, единая константа DEFAULT_MAX_SIZE | [x] |
| 7.16 | DragOverlay: курсор «держит» карточку за левый верхний угол вместо центра | [x] |
| 7.17 | Меню каналов: скрытие Delete при поиске, создание канала при отсутствии совпадений, MRU-ранжирование (localStorage), единообразие с клиппером | [x] |
| 7.18 | Дизайн-система: shadcn/ui (токены, `cn()`, ThemeProvider, миграция оболочки App+Sidebar на семантические токены) | [x] |
| 7.19 | Миграция всех компонентов на семантические токены: замена neutral-*/dark: на bg-card/text-foreground/border-border/bg-muted и т.д. | [x] |
| 7.20 | shadcn/ui компонентная миграция: 14 примитивов (Button, Input, Badge, Checkbox, Progress, Separator, Dialog, Command, ContextMenu, DropdownMenu, AlertDialog, ScrollArea, Tooltip), glass-токены, lucide-react иконки | [x] |
| 7.21 | Grid: делегирование ContextMenu (O(N)→O(1)) + синхронный сброс visibleCount + исправление скролла контекстного меню + hover сайдбара | [x] |
| 7.22 | Визуальная стилизация: overlay titlebar + drag region, Geist Sans, острые карточки без заливки, GAP 32px, sidebar без заголовка с градиентным fade | [x] |
| 7.23 | Иконки каналов в sidebar: стопка из 1–3 мини-карточек с реальными превью, веерная анимация при ховере | [x] |
| 7.24 | Fullscreen Detail: двухслойный layout (scroll + fixed metadata), Geist Mono, drag region | [x] |

### Phase 8 — Веб-клиппер (браузерное расширение) [COMPLETED]

Goal: расширение для Chrome и Safari — сохранение ссылок, статей, изображений и видео прямо из браузера в vault.

| # | Task | Status |
|---|------|--------|
| 8.1 | SPEC_CLIPPER.md — спецификация: типы клипов, popup UI, native messaging, извлечение метаданных | [x] |
| 8.2 | Native messaging host (Rust-бинарник): чтение vault, запись блоков, индексация, thumbnails | [x] |
| 8.3 | WebExtension: content script (метаданные, Readability.js), popup UI (сегментированный контрол типа, каналы, предпросмотр) | [x] |
| 8.4 | Контекстное меню: Save page / Save image / Save selection / Save link | [x] |
| 8.5 | Автоопределение типа контента (эвристика: article/link/video) + ручное переключение | [x] |
| 8.6 | Safari-обёртка: xcrun safari-web-extension-converter → Xcode-проект | [x] |
| 8.7 | Тестирование с реальными данными (native host дымовой тест пройден) | [x] |
| 8.8 | Ремонт форматирования (tweetTextToMarkdown, убран .textContent) и логики типов (переключатель всегда виден, жадная загрузка статьи, перезапрос выделения) | [x] |
| 8.9 | Переделка UX клиппера: Content/Link, недавние каналы, встроенный список, HTTP-заголовки для загрузки картинок, async контекстное меню | [x] |
| 8.10 | Багфикс: Referer на URL страницы (не картинки), реалистичный User-Agent, windows.create() вместо openPopup(), адаптивный размер окна | [x] |
