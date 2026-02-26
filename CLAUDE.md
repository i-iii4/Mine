# Local Arena — локальная альтернатива Are.na для визуального букмаркинга

Десктопное приложение для сбора, организации и связывания визуальных материалов. Файлы хранятся локально в папках (как Obsidian для заметок), интерфейс — окно в них. Никакого облака, никакого Electron.

## Required reading

- `ARCHITECTURE.md` — архитектура, компоненты, ключевые решения
- `PLAN.md` — план реализации по фазам
- `DEVLOG.md` — история изменений и принятые решения

## Stack

| Technology | Purpose |
|---|---|
| Tauri v2 | Десктопная оболочка, системные API, файловый доступ |
| Rust | Бэкенд: файловые операции, индексирование, thumbnails |
| rusqlite | SQLite + FTS5 — поисковый индекс и связи между блоками |
| notify | File watcher — отслеживание изменений в vault |
| image | Генерация thumbnails |
| React 19 | UI-фреймворк |
| Vite | Сборка фронтенда, HMR |
| TypeScript | Язык фронтенда |
| TailwindCSS | Стилизация |

## Structure

```
local-arena/
├── src-tauri/                  # Rust-бэкенд (Tauri)
│   ├── src/
│   │   ├── main.rs             # Точка входа Tauri
│   │   ├── commands/           # Tauri commands (API для фронтенда)
│   │   │   ├── mod.rs
│   │   │   ├── channels.rs     # CRUD каналов (папок)
│   │   │   ├── blocks.rs       # CRUD блоков (файлов)
│   │   │   ├── search.rs       # Полнотекстовый поиск
│   │   │   └── thumbnails.rs   # Генерация и отдача превью
│   │   ├── indexer/            # Индексирование файлов в SQLite
│   │   │   ├── mod.rs
│   │   │   ├── watcher.rs      # File watcher (notify)
│   │   │   └── scanner.rs      # Полное сканирование vault
│   │   ├── db/                 # Работа с SQLite
│   │   │   ├── mod.rs
│   │   │   ├── schema.rs       # Миграции и схема
│   │   │   └── queries.rs      # SQL-запросы
│   │   └── thumbnails/         # Пайплайн генерации превью
│   │       ├── mod.rs
│   │       └── generator.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # React-фронтенд
│   ├── main.tsx                # Точка входа React
│   ├── App.tsx                 # Корневой компонент + роутинг
│   ├── components/
│   │   ├── Grid/               # Сетка карточек (виртуализация)
│   │   ├── Card/               # Карточка блока
│   │   ├── Channel/            # Представление канала
│   │   ├── Sidebar/            # Навигация по каналам
│   │   └── Search/             # Поиск
│   ├── hooks/                  # React-хуки
│   ├── lib/                    # Утилиты, типы, Tauri API-обёртки
│   └── styles/                 # Глобальные стили
├── public/                     # Статические ассеты
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── CLAUDE.md
├── ARCHITECTURE.md
├── PLAN.md
└── DEVLOG.md
```

## Vault structure (пользовательские данные)

```
~/LocalArena/                       # Vault — выбирается пользователем
├── .arena/                         # Служебные данные (в .gitignore)
│   ├── index.db                    # SQLite: поисковый индекс, связи
│   └── cache/
│       └── thumbs/                 # Thumbnails 240px
├── channels/
│   ├── design-inspiration/
│   │   ├── channel.json            # Метаданные канала
│   │   ├── screenshot-2026.png
│   │   ├── article.md
│   │   └── figma-link.json         # { url, title, description }
│   └── brutalist-architecture/
│       ├── channel.json
│       └── ...
```

## Git

- `origin` — (будет настроен)
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

The project is built as a scalable product, not a prototype.

### Prohibited
- Workarounds, hacks, TODO stubs, "fix later"
- Copy-paste instead of abstraction
- Direct coupling between unrelated modules
- Swallowing errors (empty catch, silent failures)
- Hardcoded values that belong in configuration

### Required
- Every decision must be architecturally justified
- New component: define contract (interface) first, then implement
- Architecture change: update ARCHITECTURE.md first, then write code
- Non-obvious solution: comment explains "why", not "what"
- Errors are handled explicitly with clear messages

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
| CLAUDE.md | Structure, stack, commands, or git config changed |
| ARCHITECTURE.md | New component, architectural decision, dependency, or SPEC file created |
| PLAN.md | Task started/completed, new tasks discovered, scope changed, phase status changed |
| DEVLOG.md | After every git push. One entry = one work session |

When creating a feature specification, create `SPEC_<feature>.md` in the project root and add a link to "Required reading" section above and to "Related documents" line in ARCHITECTURE.md.
