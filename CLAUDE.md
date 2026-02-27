# Local Arena — локальная альтернатива Are.na для визуального букмаркинга

Десктопное приложение для визуального букмаркинга. Файлы хранятся локально (плоская структура, Markdown + frontmatter), каналы — это теги. Интерфейс — окно в файловую систему. Никакого облака, никакого Electron.

## Required reading

- `PRINCIPLES.md` — **читать первым.** Инженерные принципы, антипаттерны, чеклист
- `ARCHITECTURE.md` — архитектура, компоненты, ключевые решения
- `PLAN.md` — план реализации по фазам
- `DEVLOG.md` — история изменений и принятые решения
- `SPEC_PRD.md` — PRD: модель данных, типы блоков, интерфейс
- `SPEC_USECASES.md` — юзкейсы и сценарии использования
- `SPEC_BLOCK.md` — спецификация domain/block (эталонный модуль)
- `SPEC_DOMAIN.md` — спецификации domain/tag, channel, vault, search
- `SPEC_STORAGE.md` — спецификации storage/db, index, files, thumbnails
- `SPEC_INTEGRATION.md` — спецификации watcher/events, handler, commands
- `SPEC_FRONTEND.md` — спецификация фронтенда: компоненты, типы, IPC, роутинг
- `SPEC_CLIPPER.md` — спецификация веб-клиппера: типы клипов, popup, native messaging

## Stack

| Technology | Purpose |
|---|---|
| Tauri v2 | Десктопная оболочка, системные API, файловый доступ |
| Rust | Бэкенд: файловые операции, индексирование, thumbnails |
| rusqlite | SQLite + FTS5 — поисковый индекс и связи между блоками |
| notify | File watcher — отслеживание изменений в vault |
| image | Генерация thumbnails |
| ureq | Синхронный HTTP-клиент (импорт Are.na) |
| React 19 | UI-фреймворк |
| Vite | Сборка фронтенда, HMR |
| TypeScript | Язык фронтенда |
| TailwindCSS | Стилизация |

## Structure

```
local-arena/
├── src-tauri/                  # Rust-бэкенд (Tauri)
│   ├── src/
│   │   ├── main.rs             # Только инициализация Tauri
│   │   ├── domain/             # Чистая бизнес-логика (без Tauri, без SQLite)
│   │   │   ├── mod.rs
│   │   │   ├── block.rs        # Block, BlockType, frontmatter parsing
│   │   │   ├── channel.rs      # Channel (promoted tag)
│   │   │   ├── tag.rs          # Tag operations
│   │   │   ├── vault.rs        # Vault path resolution, file naming
│   │   │   └── search.rs       # Search query parsing
│   │   ├── storage/            # Персистентность (SQLite, FS)
│   │   │   ├── mod.rs
│   │   │   ├── db.rs           # Connection pool, migrations
│   │   │   ├── index.rs        # Frontmatter → SQLite indexing
│   │   │   ├── files.rs        # File operations (copy, move, delete)
│   │   │   └── thumbnails.rs   # Thumbnail generation + cache
│   │   ├── watcher/            # File system watcher
│   │   │   ├── mod.rs
│   │   │   ├── events.rs       # Event types, debouncing
│   │   │   ├── handler.rs      # React to FS changes
│   │   │   └── watch.rs        # notify watcher в фоновом потоке
│   │   ├── import/             # Импорт из внешних сервисов
│   │   │   ├── mod.rs
│   │   │   ├── arena_api.rs    # Are.na HTTP-клиент (ureq)
│   │   │   └── importer.rs     # Маппинг Are.na → local blocks
│   │   └── commands/           # Tauri commands (тонкий слой, без логики)
│   │       ├── mod.rs
│   │       ├── state.rs        # AppState, VaultState, CommandError
│   │       ├── blocks.rs       # → вызывает domain + storage
│   │       ├── tags.rs
│   │       ├── search.rs
│   │       ├── vault.rs        # select_vault, get_vault_path, rebuild_index
│   │       └── import.rs       # list_arena_channels, import_arena_channels
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # React-фронтенд
│   ├── main.tsx                # Точка входа React
│   ├── App.tsx                 # Корневой компонент + роутинг
│   ├── components/
│   │   ├── Grid.tsx            # Masonry-сетка с чанковым рендерингом (IntersectionObserver)
│   │   ├── Card.tsx            # Адаптивная карточка по типу блока (5 типов)
│   │   ├── Sidebar.tsx         # Каналы, счётчики, навигация, кнопка импорта
│   │   ├── Detail.tsx          # Lightbox: просмотр, теги, навигация стрелками
│   │   ├── Search.tsx          # Cmd+K поиск (command palette)
│   │   ├── VaultPicker.tsx     # Выбор vault через нативный диалог
│   │   ├── DropZone.tsx        # Drag-and-drop файлов для создания блоков
│   │   └── ImportDialog.tsx    # 4-шаговый импорт из Are.na
│   ├── types/                  # TypeScript-типы (ручные, без specta)
│   ├── lib/                    # commands.ts (IPC), assets.ts (URL-хелперы)
│   └── styles/                 # Глобальные стили
├── public/                     # Статические ассеты
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── CLAUDE.md
├── PRINCIPLES.md
├── ARCHITECTURE.md
├── PLAN.md
├── DEVLOG.md
├── SPEC_PRD.md
└── SPEC_USECASES.md
```

## Vault structure (пользовательские данные)

```
~/LocalArena/                       # Vault — выбирается пользователем
├── .arena/                         # Служебные данные
│   ├── index.db                    # SQLite: FTS5, кэш тегов, каналы
│   └── cache/
│       └── thumbs/                 # Thumbnails 240px
├── sunset-tokyo.md                 # Метаданные (frontmatter + wikilinks)
├── sunset-tokyo.jpg                # Медиафайл
├── stripe-homepage.md              # Ссылка (frontmatter, тело пустое)
├── stripe-og.png                   # Миниатюра ссылки
├── crdt-article.md                 # Статья (frontmatter + текст)
└── ...                             # Всё плоско в корне vault
```

Каналы = теги в frontmatter. Блок = `.md` файл + опциональный медиафайл.

## Git

- `origin` — https://github.com/i-iii4/local-arena (private)
- Main branch: `main`

## Environment

- Rust toolchain: stable (rustup)
- Node.js: не требуется (используем Bun)
- Bun: >= 1.2
- Tauri CLI: `cargo install tauri-cli`

## Development

```bash
bun install                    # Установка JS-зависимостей
cargo tauri dev                # Запуск в режиме разработки (Rust + Vite)
cargo tauri build              # Сборка .dmg/.app
bun run lint                   # Линтинг фронтенда
cargo clippy                   # Линтинг Rust
```

## Code culture

**Мы не делаем MVP. Мы делаем финальный продукт.** Код бесплатен (пишет ИИ), время дорого (тратит человек на отладку). Оптимизируем корректность, не скорость написания.

Полный набор принципов, антипаттернов и чеклист — в `PRINCIPLES.md`.

### Рабочий цикл на каждый модуль

```
1. SPEC    — спецификация (типы, API, поведение, edge cases)
2. REVIEW  — проверка SPEC на соответствие PRINCIPLES.md
3. CODE    — реализация строго по спецификации
4. TEST    — тесты на все сценарии из SPEC
5. VERIFY  — нет отклонений от SPEC, нет антипаттернов
6. COMMIT  — коммит с ссылкой на SPEC
```

### Ключевые правила

- Контракт первичен: SPEC → реализация → тесты (не наоборот)
- Нулевой технический долг: нет TODO, FIXME, HACK, «потом»
- Типобезопасность сквозная: Rust → specta → TypeScript (автогенерация)
- domain/ не знает о storage/, commands/ не содержит логики
- Ошибки типизированы (enum, не строки), содержат контекст
- Производительность — архитектурное решение, не оптимизация «потом»

## Style conventions

### Rust
- `snake_case` для функций и переменных
- `PascalCase` для типов и структур
- `clippy::pedantic` — включён
- Ошибки через `thiserror` + `anyhow`

### TypeScript / React
- Функциональные компоненты, хуки
- `camelCase` для переменных и функций, `PascalCase` для компонентов
- Строгий TypeScript (`strict: true`)
- Без `any`, без `as` кастов без обоснования

### Общее
- Длинное тире (—) вместо двойного дефиса в текстах
- Комментарии на английском в коде, документация на русском

## Documentation maintenance

| Document | When to update |
|---|---|
| PRINCIPLES.md | Крайне редко — только если принцип доказал неверность |
| CLAUDE.md | Structure, stack, commands, or git config changed |
| ARCHITECTURE.md | New component, architectural decision, dependency, or SPEC file created |
| PLAN.md | Task started/completed, new tasks discovered, scope changed, phase status changed |
| DEVLOG.md | After every git push. One entry = one work session |

When creating a feature specification, create `SPEC_<feature>.md` in the project root and add a link to "Required reading" section above and to "Related documents" line in ARCHITECTURE.md.
