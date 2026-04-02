# Mine — локальная альтернатива Are.na для визуального букмаркинга

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
- `SPEC_MOBILE.md` — спецификация iOS-приложения: SwiftUI + Rust UniFFI, iCloud sync, Share Extension
- `DESIGN_SYSTEM_IOS.md` — дизайн-система iOS: цвета, типографика, компоненты, жесты
- `AUDIT_PERFORMANCE.md` — аудит производительности и план оптимизации
- `AUDIT.md` — результаты аудитов кодовой базы (01.03.2026 — первый, 03.03.2026 — повторный), план доработки — Phase 9 в PLAN.md
- `DESIGN_SYSTEM.md` — дизайн-система: токены скруглений, отступов, типографики, правила поведения

## Stack

| Technology | Purpose |
|---|---|
| Tauri v2 | Десктопная оболочка, системные API, файловый доступ |
| Rust | Бэкенд: файловые операции, индексирование, thumbnails |
| rusqlite | SQLite + FTS5 — поисковый индекс и связи между блоками |
| notify | File watcher — отслеживание изменений в vault |
| image + ab_glyph + imageproc | Генерация thumbnails (изображения — resize, статьи — text-to-image) |
| ureq | Синхронный HTTP-клиент (импорт Are.na) |
| React 19 | UI-фреймворк |
| Vite | Сборка фронтенда, HMR |
| TypeScript | Язык фронтенда |
| TailwindCSS v4 | Стилизация (CSS-first конфигурация) |
| shadcn/ui | Дизайн-система: OKLCH-токены, 14 Radix-примитивов (Button, Dialog, Command, ContextMenu и др.), glass-вариант, `cn()` |
| radix-ui + cmdk | Headless UI-примитивы (основа shadcn), command palette (Cmd+K поиск) |
| lucide-react | Иконки (замена ручных SVG) |
| class-variance-authority | Варианты компонентов (CVA) |
| tw-animate-css | CSS-анимации для Tailwind v4 (Dialog, DropdownMenu, ContextMenu) |
| @dnd-kit | Drag-and-drop: сортировка каналов, перетаскивание карточек на теги |
| react-markdown + remark-gfm | Рендеринг markdown в Detail.tsx и popup расширения |
| @tailwindcss/typography | Стилизация prose-контента (статьи) |
| Defuddle | Извлечение статей + Markdown-конвертация + YouTube-транскрипты (content script) |
| @virtuoso.dev/masonry | Виртуализированная masonry-сетка (Chrome/Firefox fallback) |
| ESLint 10 + typescript-eslint | Линтинг фронтенда (TypeScript) |
| SwiftUI | iOS UI-фреймворк (нативный, без WebView) |
| UniFFI (Mozilla) | FFI-генератор: Rust → Swift bindings |
| AVKit + AVFoundation | Видеовоспроизведение на iOS (LoopingVideoView, AutoplayVideo) |
| Xcode | Сборка iOS-приложения, xcframework |

## Structure

```
local-arena/
├── src-tauri/                  # Rust-бэкенд (Tauri)
│   ├── src/
│   │   ├── bin/
│   │   │   └── native_host.rs  # Native messaging host для веб-клиппера (stdin/stdout JSON)
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
│   │   ├── ImportDialog.tsx    # 4-шаговый импорт из Are.na
│   │   ├── CardContextMenu.tsx # Контекстное меню карточки: теги, удаление
│   │   └── SidebarResizeHandle.tsx # Ресайз-ручка сайдбара (pill-стиль)
│   ├── hooks/
│   │   └── useSidebarResize.ts # Хук ресайза сайдбара (pointer events + persist)
│   ├── types/                  # TypeScript-типы (ручные, без specta)
│   ├── lib/                    # commands.ts (IPC), assets.ts, utils.ts (cn()), recentTags.ts
│   └── styles/                 # Глобальные стили
├── extension/                  # Chrome/Safari веб-клиппер
│   ├── background.js           # Service worker: контекстное меню, native messaging
│   ├── content.js              # Content script: метаданные, Defuddle, Twitter/Instagram парсеры
│   ├── popup/                  # React popup (исходники, собирается Vite)
│   │   ├── index.html          # HTML entry point
│   │   ├── main.tsx            # React entry
│   │   ├── popup-layout.css    # Импорт global.css + popup-размеры
│   │   ├── PopupApp.tsx        # Корневой компонент
│   │   ├── components/         # PreviewCard, TypeSwitcher, ChannelList, SaveButton, StatusBar
│   │   ├── hooks/              # useClipperState.ts
│   │   └── lib/                # messaging.ts (типизированный native messaging)
│   ├── dist/                   # Собранный попап (output Vite)
│   ├── lib/                    # Вендорные библиотеки (Defuddle UMD)
│   ├── icons/                  # Иконки расширения
│   └── manifest.json           # Manifest V3
├── core-ffi/                   # Rust FFI-слой для iOS (UniFFI)
│   ├── Cargo.toml              # Зависимости: local-arena (без desktop), uniffi
│   ├── src/
│   │   └── lib.rs              # ArenaVault Object, FfiLightBlock Record, scanVault, listBlocks
│   └── uniffi-bindgen/
│       └── main.rs             # Генерация Swift bindings
├── ios/                        # iOS-приложение (SwiftUI)
│   ├── LocalArena.xcodeproj
│   ├── LocalArena/
│   │   ├── LocalArenaApp.swift # @main, WindowGroup, VaultViewModel
│   │   ├── ContentView.swift   # Корневой ZStack, сидинг тестовых данных
│   │   ├── GridView.swift      # Masonry 2 колонки, @State навигация (без NavigationStack)
│   │   ├── CardViews.swift     # BlockCard роутер, SocialCard, ImageCard, ArticleCard, LinkCard, VideoCard
│   │   ├── DetailView.swift    # Полный просмотр блока, AutoplayVideo, кастомная кнопка назад
│   │   ├── VaultViewModel.swift # Мост SwiftUI → Rust FFI (open, scan, listBlocks)
│   │   ├── Theme.swift         # Arena enum: цвета, отступы, типографика
│   │   ├── Info.plist          # UILaunchScreen (обязательно для полноэкранного режима)
│   │   └── TestData/           # Тестовые .md файлы (копируются в Documents при первом запуске)
│   └── LocalArenaCore.xcframework # Скомпилированный Rust core (device + simulator)
├── vite.extension.config.ts    # Vite-конфигурация для сборки расширения
├── public/                     # Статические ассеты
├── index.html
├── components.json             # Конфигурация shadcn/ui
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
~/Mine/                       # Vault — выбирается пользователем
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

Каналы = `.md` файлы с `type: channel` (метаданные в frontmatter: position, color, icon). Блок = `.md` файл + опциональный медиафайл. Принадлежность блока к каналу — через `tags` в frontmatter блока.

## Git

- `origin` — https://github.com/i-iii4/local-arena (private)
- Main branch: `main`

## Environment

- Rust toolchain: stable (rustup)
- Node.js: не требуется (используем Bun)
- Bun: >= 1.2
- Tauri CLI: `cargo install tauri-cli`

## Test data

Тестовый vault: `~/Desktop/Тест/` — сохранённые блоки из веб-клиппера (статьи, Twitter, Instagram, YouTube).

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
