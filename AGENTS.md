# Mine — локальная альтернатива Are.na для визуального букмаркинга

> Канонический источник инструкций для агентов — `CLAUDE.md`. Этот файл
> (`AGENTS.md`) предназначен для агентов, читающих `AGENTS.md`, и может
> отставать; при расхождении полагайтесь на `CLAUDE.md`.

Десктопное приложение для визуального букмаркинга. Файлы хранятся локально (плоская структура, Markdown + frontmatter), коллекции — это Obsidian-страницы, а membership хранится в `Mine Collections` как wikilinks. Интерфейс — окно в файловую систему. Никакого облака, никакого Electron.

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
- `SPEC_SEARCH.md` — спецификация Surface Search и целевой Hybrid Search: `Cmd+F` Grid filter, `Shift+Cmd+F` Sidebar filter, lexical/alias/semantic retrieval, fusion ranking, excerpts/highlights
- `SPEC_GROUP_SELECTION.md` — спецификация Grid group selection и batch card actions
- `SPEC_CARD_MERGE.md` — спецификация batch Merge: reorder dialog, one backend command, Markdown section composition, media reuse, many-to-one relationship preservation
- `SPEC_FEED_SCROLL_PERFORMANCE.md` — C7-контракт бесконечного canvas-feel для ленты: render window, media preload/decode window, лимиты, диагностика
- `SPEC_GRID_LAYOUT_READINESS.md` — C8-контракт viewport-first measurement: live measured islands, layout diagnostics, deep fast-scroll acceptance
- `SPEC_THUMBNAILS.md` — полная спецификация preview/thumbnail pipeline
- `SPEC_GRAPH_VIEW.md` — спецификация Graph View: Canvas force-directed graph на базе решения Longevity Landscape, graph snapshot read model, коллекции/wikilinks/related notes, физика, UX и проверки
- `SPEC_FEED_VIDEO.md` — спецификация desktop feed video contract: surfaces, `feed_playback`, autoplay gating
- `SPEC_ARTICLE_AUDIO.md` — спецификация manual article audio renditions: speech prep, derived audio state, desktop/iOS controls
- `SPEC_MEDIA_ASSET_ACTIONS.md` — спецификация media-level hover/drag/actions: Create Card, Reveal, Copy Path, Copy Media, Rename Media, Remove from Card, Delete для конкретного local media asset
- `SPEC_INLINE_MEDIA_EXTRACTION.md` — спецификация перетаскивания inline-изображений из статьи в отдельный блок с односторонней связью на исходную заметку
- `SPEC_IDENTITY_ROBUSTNESS.md` — спецификация filename-first identity: rename, conflicts, NFC
- `SPEC_OBSIDIAN_WIKILINKS.md` — спецификация inline media через Obsidian wikilinks
- `SPEC_OBSIDIAN_MARKDOWN_COMPAT.md` — обычные Obsidian `.md` без Mine frontmatter как implicit articles, optional metadata overlay, no rewrite on read
- `SPEC_COLLECTIONS_OBSIDIAN_LINKS.md` — implemented migration: collections as Obsidian pages, `Mine Collections` values as quoted wikilinks, legacy formats handled by CLI migration
- `SPEC_CLIPPER.md` — спецификация веб-клиппера: типы клипов, popup, native messaging
- `SPEC_MOBILE.md` — спецификация iOS-приложения: SwiftUI + Rust UniFFI, iCloud sync, Share Extension
- `SPEC_DISTRIBUTION.md` — production-контракт подписи, доставки, обновлений, диагностики и продуктовой телеметрии
- `DESIGN_SYSTEM_IOS.md` — дизайн-система iOS: цвета, типографика, компоненты, жесты
- `AUDIT_PERFORMANCE.md` — аудит производительности и план оптимизации
- `AUDIT.md` — результаты аудитов кодовой базы (01.03.2026 — первый, 03.03.2026 — повторный), план доработки — Phase 9 в PLAN.md
- `DESIGN_SYSTEM.md` — дизайн-система: токены скруглений, отступов, типографики, правила поведения
- `SPEC_SCROLL_EDGE_FADE.md` — растворение верхней кромки прокручиваемых поверхностей: общая кривая маски, порог активации, настройка `mine.scrollEdgeFade`

## Stack

| Technology | Purpose |
|---|---|
| Tauri v2 | Десктопная оболочка, системные API, файловый доступ |
| Rust | Бэкенд: файловые операции, индексирование, thumbnails |
| rusqlite | SQLite + FTS5 — поисковый индекс и связи между блоками |
| fastembed | Local multilingual semantic embeddings for Hybrid Search |
| notify | File watcher — отслеживание изменений в vault |
| image + ab_glyph + imageproc | Генерация thumbnails (изображения — resize, статьи — text-to-image) |
| ureq | Синхронный HTTP-клиент (импорт Are.na) |
| url + getrandom + tiny_http | Native-host URL validation, upload token generation, local binary upload server |
| React 19 | UI-фреймворк |
| Vite | Сборка фронтенда, HMR |
| react-force-graph-2d + d3-force | Canvas Graph View: force-directed layout, zoom/pan, custom node paint |
| TypeScript | Язык фронтенда |
| TailwindCSS v4 | Стилизация (CSS-first конфигурация) |
| shadcn/ui CLI 4.x | Source-owned дизайн-система: OKLCH-токены, Radix-base компоненты, glass-вариант, `cn()` |
| radix-ui | Текущая headless-основа компонентов Mine (`shadcn info`: `base = radix`) |
| lucide-react | Иконки (замена ручных SVG) |
| class-variance-authority | Варианты компонентов (CVA) |
| tw-animate-css | CSS-анимации для Tailwind v4 (Dialog, DropdownMenu, ContextMenu) |
| @dnd-kit | Drag-and-drop: сортировка каналов, перетаскивание карточек на теги |
| react-markdown + remark-gfm | Рендеринг markdown в Detail.tsx и popup расширения |
| @tailwindcss/typography | Стилизация prose-контента (статьи) |
| Defuddle | Извлечение статей + Markdown-конвертация + YouTube-транскрипты (content script) |
| @virtuoso.dev/masonry | Виртуализированная masonry-сетка (Chrome/Firefox fallback) |
| ESLint 10 + typescript-eslint | Линтинг фронтенда (TypeScript) |
| Playwright + pngjs | Browser-level Feed, Graph и cold-space acceptance: DOM/Canvas diagnostics + screenshot blankness/performance checks |
| AVFoundation + native Swift helper | Генерация article audio renditions на desktop |
| SwiftUI | iOS UI-фреймворк (нативный, без WebView) |
| UniFFI (Mozilla) | FFI-генератор: Rust → Swift bindings |
| AVKit + AVFoundation + AVSpeechSynthesizer | Видео и article audio на iOS |
| Xcode | Сборка iOS-приложения, xcframework |

## Structure

```
local-arena/
├── src-tauri/                  # Rust-бэкенд (Tauri)
│   ├── src/
│   │   ├── bin/
│   │   │   ├── native_host.rs  # Native messaging host для веб-клиппера (stdin/stdout JSON)
│   │   │   ├── cold_space_audit.rs # Read-only source + disposable derived acceptance CLI
│   │   │   └── export_bindings.rs # Rust/Specta → committed TypeScript bindings
│   │   ├── main.rs             # Только инициализация Tauri
│   │   ├── domain/             # Чистая бизнес-логика (без Tauri, без SQLite)
│   │   │   ├── mod.rs
│   │   │   ├── block.rs        # Block, BlockType, frontmatter parsing
│   │   │   ├── markdown.rs     # Wikilinks, inline media, markdown rewrite helpers
│   │   │   ├── article_audio.rs # Speakable article text prep + text_hash
│   │   │   ├── channel.rs      # Channel (promoted tag)
│   │   │   ├── tag.rs          # Tag operations
│   │   │   ├── vault.rs        # Vault path resolution, file naming
│   │   │   └── search.rs       # Search query parsing
│   │   ├── storage/            # Персистентность (SQLite, FS)
│   │   │   ├── mod.rs
│   │   │   ├── article_audio.rs # Local derived audio state + sidecar persistence
│   │   │   ├── cold_space_audit.rs # Cold/reopen/cache-reset projection acceptance
│   │   │   ├── db.rs           # Connection pragmas/opening
│   │   │   ├── migrations.rs   # Versioned PRAGMA user_version migrations + validation
│   │   │   ├── index.rs        # Frontmatter → SQLite indexing
│   │   │   ├── block_queries.rs # Block read models + row hydration
│   │   │   ├── channel_index.rs # Collection persistence owner
│   │   │   ├── vault_conflicts.rs # Vault filename conflict queries
│   │   │   ├── projection.rs   # ProjectionRevision + atomic route snapshots
│   │   │   ├── search_projection.rs # SearchRevision + revision-safe cursor
│   │   │   ├── files.rs        # File operations (copy, move, delete, derived artifact rename)
│   │   │   ├── graph.rs        # GraphSnapshot projection for Graph View
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
│   │       ├── article_audio.rs # get/generate/delete/set_position commands
│   │       ├── article_audio_desktop.rs # Native macOS helper orchestration + voice defaults
│   │       ├── state.rs        # AppState, VaultState, CommandError
│   │       ├── freshness.rs     # Reconciliation coordinator
│   │       ├── preview_reconcile.rs # Derived preview queue
│   │       ├── thumbnail_sweeps.rs # Thumbnail sweep coordinator
│   │       ├── native_shell_smoke.rs # Packaged WKWebView IPC smoke report
│   │       ├── window_chrome.rs # Native View-menu projection for Sidebar state
│   │       ├── blocks.rs       # create/delete/rename block commands → вызывает domain + storage
│   │       ├── graph.rs        # list_graph_snapshot command
│   │       ├── tags.rs
│   │       ├── search.rs
│   │       ├── vault.rs        # select_vault, get_vault_path, rebuild_index
│   │       └── import.rs       # list_arena_channels, import_arena_channels
│   ├── native/
│   │   └── article_audio_helper.swift # macOS helper: AVSpeechSynthesizer.write -> .wav
│   ├── Cargo.toml
│   ├── build.rs                # Builds bundled article-audio helper on macOS desktop
│   └── tauri.conf.json
├── src/                        # React-фронтенд
│   ├── main.tsx                # Точка входа React
│   ├── App.tsx                 # Корневой компонент + роутинг
│   ├── components/
│   │   ├── Grid.tsx            # Masonry-сетка с чанковым рендерингом (IntersectionObserver)
│   │   ├── GraphView.tsx       # Graph M1: Canvas nodes/edges, route-derived scope, selection/a11y
│   │   ├── graph/              # Canvas paint, physics, contracts, interactions
│   │   ├── grid/               # Grid interaction geometry/controllers
│   │   ├── MainSecondaryChrome.tsx # Main route secondary chrome
│   │   ├── Card.tsx            # Адаптивная карточка по типу блока (5 типов)
│   │   ├── Sidebar.tsx         # Каналы, счётчики, навигация, кнопка импорта
│   │   ├── Detail.tsx          # Lightbox: просмотр, коллекции, навигация стрелками
│   │   ├── RenameBlockDialog.tsx # Unified filename rename modal
│   │   ├── ArticleAudioControls.tsx # Desktop AUDIO rail: create/remove/play/persist progress
│   │   ├── VaultPicker.tsx     # Выбор vault через нативный диалог
│   │   ├── DropZone.tsx        # Drag-and-drop файлов для создания блоков
│   │   ├── ImportDialog.tsx    # 4-шаговый импорт из Are.na
│   │   ├── CardContextMenu.tsx # Контекстное меню карточки: коллекции, удаление
│   │   └── SidebarResizeHandle.tsx # Ресайз-ручка сайдбара (pill-стиль)
│   ├── hooks/
│   │   └── useSidebarResize.ts # Хук ресайза сайдбара (pointer events + persist)
│   ├── types/                  # generated.ts from Rust/Specta + frontend-owned index.ts
│   ├── lib/                    # commands.ts (IPC), articleAudioGateway.tsx (UI transport contract), articleAudioDesktopGateway.ts (desktop adapter), domSelectors.ts, assets.ts, utils.ts (cn()), recentTags.ts
│   ├── dev/                    # Dev-only routes/harnesses: FeedScrollAuditRoute, GraphAuditRoute
│   └── styles/                 # Глобальные стили
├── scripts/
│   ├── feed-scroll-audit.mjs   # Playwright Grid scroll/source-request acceptance
│   ├── graph-view-audit.mjs    # Dark/light Canvas pixel/interaction/performance acceptance
│   └── native-shell-smoke.mjs  # Packaged macOS WKWebView + Tauri IPC smoke
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
│   │   └── lib.rs              # ArenaVault Object, FfiLightBlock Record, scanVault, listBlocks, prepareArticleSpeech
│   └── uniffi-bindgen/
│       └── main.rs             # Генерация Swift bindings
├── ios/                        # iOS-приложение (SwiftUI)
│   ├── Mine.xcodeproj
│   ├── LocalArena/
│   │   ├── MineApp.swift # @main, WindowGroup, VaultViewModel
│   │   ├── ContentView.swift   # Корневой ZStack, сидинг тестовых данных
│   │   ├── GridView.swift      # Masonry 2 колонки, @State навигация (без NavigationStack)
│   │   ├── CardViews.swift     # BlockCard роутер, SocialCard, ImageCard, ArticleCard, LinkCard, VideoCard
│   │   ├── DetailView.swift    # Полный просмотр блока, AutoplayVideo, AudioSection, ArticleAudioService
│   │   ├── VaultViewModel.swift # Мост SwiftUI → Rust FFI (open, scan, listBlocks)
│   │   ├── Theme.swift         # Arena enum: цвета, отступы, типографика
│   │   ├── Info.plist          # UILaunchScreen (обязательно для полноэкранного режима)
│   │   └── TestData/           # Тестовые .md файлы (копируются в Documents при первом запуске)
│   └── MineCore.xcframework # Скомпилированный Rust core (device + simulator)
├── vite.extension.config.ts    # Vite-конфигурация для сборки расширения
├── public/                     # Статические ассеты
├── index.html
├── components.json             # Конфигурация shadcn/ui
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── AGENTS.md
├── PRINCIPLES.md
├── ARCHITECTURE.md
├── PLAN.md
├── DEVLOG.md
├── SPEC_PRD.md
└── SPEC_USECASES.md
```

## Vault structure (пользовательские данные)

```
~/Mine/                            # Source vault — выбирается пользователем
├── .mine/
│   └── vault-id                   # Sync'ed идентификатор vault
├── sunset-tokyo.md                 # Метаданные (frontmatter + wikilinks)
├── sunset-tokyo.jpg                # Медиафайл
├── stripe-homepage.md              # Ссылка (frontmatter, тело пустое)
├── stripe-og.png                   # Миниатюра ссылки
├── crdt-article.md                 # Статья (frontmatter + текст)
└── ...                             # Всё плоско в корне vault
```

```
~/Library/Application Support/com.mine.app/vaults/<vault-id>/  # Local derived store
├── index.db
└── cache/
    ├── thumbs/
    └── audio/                     # Article audio sidecars + .wav artifacts

~/Library/Application Support/com.mine.app/cache/fastembed/  # Local semantic model cache
```

Коллекции = `.md` файлы с `type: channel` (метаданные в frontmatter: position, color, icon). Блок = `.md` файл + опциональный медиафайл. Collection membership — через `Mine Collections` с quoted Obsidian wikilinks, например `- "[[Красивый веб]]"`; `tags` остаётся пользовательским Obsidian-полем.

## Git

- `origin` — https://github.com/i-iii4/Mine.git (private)
- Main branch: `main`

## Environment

- Rust toolchain: stable (rustup)
- Node.js: не требуется (используем Bun)
- Bun: >= 1.2
- Tauri CLI: `cargo install tauri-cli`
- yt-dlp: `brew install yt-dlp` — нужен клипперу, чтобы забирать видео из постов
  X с возрастным ограничением. Без него остальное сохранение работает как
  прежде, а этот шаг завершается понятной ошибкой

## Test data

Тестовый vault: `~/Desktop/Тест/` — сохранённые блоки из веб-клиппера (статьи, Twitter, Instagram, YouTube).

## Development

```bash
bun install                    # Установка JS-зависимостей
cargo tauri dev                # Запуск в режиме разработки (Rust + Vite)
cargo tauri build              # Сборка .dmg/.app
bun run build:extension        # Обязательная отдельная сборка Mine Clipper → extension/dist
bun run lint                   # Линтинг фронтенда
bun run test                   # Полная проверка: Vitest + Rust workspace tests
bun run test:feed-scroll       # Browser-level Grid scroll blank/performance acceptance (requires running dev server)
bun run test:graph             # Browser-level Graph Canvas acceptance (requires running dev server)
bun run test:cold-space        # Browser cold first/settled/deep Grid acceptance (requires running dev server)
bun run test:browser           # Сам поднимает Vite и запускает все browser gates
bun run test:native-shell      # Packaged macOS WKWebView + real Tauri invoke smoke
bun run bindings:generate      # Обновить committed Rust/Specta TypeScript bindings
bun run bindings:check         # Проверить bindings на drift
bun run verify:core            # Bindings + lint + frontend/Rust tests
bun run verify                 # Полный contract, включая Feed, Graph и cold-space browser gates
bun run verify:release         # Полный contract + native-shell smoke
bunx shadcn info               # Проверить CLI/config/base без изменения файлов
bunx shadcn add button --diff  # Read-only upstream diff; не перезаписывает компонент
cargo run -p mine --bin cold-space-audit -- <source> <empty-derived-dir> 2
cargo +1.88.0 check --workspace --all-targets --locked # MSRV gate
cargo clippy                   # Линтинг Rust
```

`extension/dist/` не хранится в Git. Desktop-команды не собирают клиппер:
перед `Load unpacked` в Chrome/Dia и после очистки build outputs всегда
запускайте `bun run build:extension`.

Native host — отдельный установленный бинарник, а не часть приложения. Любая
правка в `src-tauri/`, которая на него влияет, требует `bun run
clipper:install-host`; сборка приложения его не обновляет. Особенно при
изменении `CURRENT_SCHEMA_VERSION`: приложение поднимет базу до новой версии, а
старый хост откажется её открывать с ошибкой «database schema version N is newer
than supported version M», и сохранение из клиппера перестанет работать целиком.

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
| AGENTS.md | Structure, stack, commands, or git config changed |
| ARCHITECTURE.md | New component, architectural decision, dependency, or SPEC file created |
| PLAN.md | Task started/completed, new tasks discovered, scope changed, phase status changed |
| DEVLOG.md | After every git push. One entry = one work session |

When creating a feature specification, create `SPEC_<feature>.md` in the project root and add a link to "Required reading" section above and to "Related documents" line in ARCHITECTURE.md.
