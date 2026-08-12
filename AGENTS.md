# Mine — локальная альтернатива Are.na для визуального букмаркинга

> Канонический источник инструкций для агентов — `CLAUDE.md`. Этот файл
> (`AGENTS.md`) — его копия для агентов, читающих `AGENTS.md`; при
> расхождении полагайтесь на `CLAUDE.md`.

Десктопное приложение для визуального букмаркинга. Файлы хранятся локально (плоская структура, Markdown + frontmatter), коллекции — это Obsidian-страницы, а membership хранится в `Mine Collections` как wikilinks. Интерфейс — окно в файловую систему. Никакого облака, никакого Electron.

## Required reading

- `PRINCIPLES.md` — **читать первым.** Инженерные принципы, антипаттерны, чеклист
- `ARCHITECTURE.md` — архитектура, компоненты, ключевые решения
- `PLAN.md` — план реализации по фазам
- `DEVLOG.md` — история изменений и принятые решения
- `SPEC_PRD.md` — PRD: модель данных, типы блоков, интерфейс
- `SPEC_USECASES.md` — юзкейсы и сценарии использования
- `SPEC_BLOCK.md` — спецификация domain/block (эталонный модуль)
- `SPEC_DISPLAY_TITLE.md` — видимый заголовок карточки: body H1 как контент, `frontmatter.title` только как legacy fallback
- `SPEC_DOMAIN.md` — спецификации domain/tag, channel, vault, search
- `SPEC_STORAGE.md` — спецификации storage/db, index, files, thumbnails
- `SPEC_INTEGRATION.md` — спецификации watcher/events, handler, commands
- `SPEC_FRONTEND.md` — спецификация фронтенда: компоненты, типы, IPC, роутинг
- `SPEC_CLIPPER.md` — спецификация веб-клиппера: типы клипов, popup, native messaging
- `SPEC_MOBILE.md` — спецификация iOS-приложения: SwiftUI + Rust UniFFI, iCloud sync, Share Extension
- `SPEC_GRID.md` — спецификация zero-jank masonry grid: Canvas measureText precomputation, dual-path (native grid-lanes + virtualized JS), детерминистические высоты
- `SPEC_THUMBNAILS.md` — спецификация thumbnail pipeline: two-phase (Rust instant placeholder + WebView async upgrade), event-driven sidebar, виртуализация, поддержка всех форматов клиппера через native decoder
- `SPEC_DISPLAY_MODES.md` — спецификация display modes: архитектура переключения между masonry/grid/table/columns, принцип изоляции (display mode = только рендеринг), единый интерфейс `DisplayModeProps`
- `SPEC_FEED_SCROLL_PERFORMANCE.md` — контракт canvas-feel бесконечной ленты: velocity-aware render runway, media preload/decode windows, лимиты, диагностика
- `SPEC_GRID_LAYOUT_READINESS.md` — deterministic live geometry: render-ready gate, committed prefix, skeleton envelope, deep fast-scroll acceptance
- `SPEC_CARD_MEDIA_GEOMETRY.md` — геометрия медиа-карточки: размеры артефакта пишет генератор превью, размеры источника остаются у autoplay/Resolution, кламп пропорции как единственная точка обрезки
- `SPEC_FEED_VIDEO.md` — desktop feed video contract: четыре surfaces, `feed_playback` descriptor, autoplay gating standard/heavy
- `SPEC_GRAPH_VIEW.md` — спецификация Graph View: Canvas force-directed graph на базе решения Longevity Landscape, graph snapshot read model, коллекции/wikilinks/related notes, физика, UX и проверки
- `SPEC_GROUP_SELECTION.md` — групповое выделение в Grid: marquee/keyboard selection, batch card actions, selection-scoped меню
- `SPEC_ARTICLE_AUDIO.md` — manual article audio renditions: speech prep, derived audio state, desktop/iOS controls
- `SPEC_TEXT_SELECTION_EXTRACTION.md` — извлечение выделенного текста статьи в отдельный article-блок и удаление фрагмента из source `.md`
- `SPEC_MEDIA_ASSET_ACTIONS.md` — media-level hover/drag/actions для конкретного local media asset, независимо от frontmatter/body source
- `SPEC_INLINE_MEDIA_EXTRACTION.md` — спецификация перетаскивания inline-изображений из статьи в отдельный блок с односторонней связью на исходную заметку
- `SPEC_CARD_MERGE.md` — batch Merge для выбранных карточек: reorder dialog, Markdown composition, media reuse, relationship preservation
- `SPEC_IDENTITY_ROBUSTNESS.md` — спецификация укрепления filename-based identity: rename detection через content hash, iCloud conflict UX, NFC normalization, semantic filename collision suffix — без служебных id во frontmatter
- `SPEC_OBSIDIAN_WIKILINKS.md` — inline media в body как Obsidian wikilink `![[name|alt]]`; один canonical syntax на write, оба syntax на read, render preprocessor в frontend, опциональная migration CLI для legacy блоков
- `SPEC_OBSIDIAN_MARKDOWN_COMPAT.md` — совместимость с обычными Obsidian `.md` без Mine frontmatter: implicit article read-model, optional metadata overlay, no rewrite on read
- `SPEC_COLLECTIONS_OBSIDIAN_LINKS.md` — implemented migration: collections as Obsidian pages, `Mine Collections` values as quoted wikilinks, legacy formats handled by CLI migration
- `SPEC_SEARCH.md` — Hybrid Search: FTS5 lexical/alias retrieval, searchable metadata chunks, chunk fuzzy matching, локальные multilingual semantic embeddings (fastembed), deterministic fusion/rerank
- `SPEC_SEARCH_OVERLAY.md` — поиск по блокам: модальный overlay (`Cmd+F`), список результатов с подсветкой первого совпадения, превью-карточка справа; заменяет невидимый грид-фильтр main search
- `SPEC_SETTINGS_WINDOW.md` — отдельное окно настроек: Appearance / Spaces / Orphans (сироты-медиа с batch delete/convert), межоконная синхронизация
- `SPEC_SCROLL_EDGE_FADE.md` — растворение верхней кромки прокручиваемых поверхностей: общая кривая маски, порог активации, настройка `mine.scrollEdgeFade`
- `SPEC_DISTRIBUTION.md` — production-контракт подписи, доставки, обновлений, диагностики; статус DEFERRED по явному продуктовому решению
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
| mp4 + openh264 | Извлечение видеокадра для thumbnails (H.264 MP4, native decoder) |
| fastembed | Локальные multilingual semantic embeddings для Hybrid Search |
| whatlang | Определение языка текста (article speech prep) |
| ureq | Синхронный HTTP-клиент (импорт Are.na) |
| tiny_http + http-range + url + getrandom | Native host: локальный upload-сервер для бинарных файлов, валидация URL, upload-токены |
| React 19 | UI-фреймворк |
| react-router | Роутинг main-окна |
| Vite | Сборка фронтенда, HMR |
| react-force-graph-2d + d3-force | Canvas Graph View: force-directed layout, zoom/pan, custom node paint |
| TypeScript | Язык фронтенда |
| TailwindCSS v4 | Стилизация (CSS-first конфигурация) |
| shadcn/ui CLI 4.x | Source-owned дизайн-система: OKLCH-токены, Radix-base компоненты, glass-вариант, `cn()` |
| radix-ui | Текущая headless-основа компонентов Mine (`shadcn info`: `base = radix`) |
| tauri-plugin-clipboard-manager | Системный буфер обмена (веб-API отказывает при потере фокуса) |
| lucide-react | Иконки (замена ручных SVG) |
| class-variance-authority | Варианты компонентов (CVA) |
| tw-animate-css | CSS-анимации для Tailwind v4 (Dialog, DropdownMenu, ContextMenu) |
| @dnd-kit | Drag-and-drop: сортировка каналов, перетаскивание карточек на теги |
| react-markdown + remark-gfm | Рендеринг markdown в Detail.tsx и popup расширения |
| @tailwindcss/typography | Стилизация prose-контента (статьи) |
| Defuddle | Извлечение статей + Markdown-конвертация + YouTube-транскрипты (content script) |
| src/lib/masonryLayout.ts | Кастомный virtualized masonry layout engine |
| src/lib/cardAspect.ts | Политика кадрирования: кламп пропорции карточки `1:2 … 2:1` |
| ESLint 10 + typescript-eslint | Линтинг фронтенда (TypeScript) |
| Vitest + Testing Library | Frontend-тесты (`bun run test:frontend`) |
| Playwright + pngjs | Browser acceptance gates: Feed, Graph, cold-space, sidebar reorder |
| AVFoundation + native Swift helper | Desktop article audio: генерация через `AVSpeechSynthesizer.write` |
| SwiftUI | iOS UI-фреймворк (нативный, без WebView) |
| UniFFI (Mozilla) | FFI-генератор: Rust → Swift bindings |
| AVKit + AVFoundation + AVSpeechSynthesizer | Видео и article audio на iOS (LoopingVideoView, AutoplayVideo, AudioSection) |
| Xcode | Сборка iOS-приложения, xcframework |

## Structure

```
local-arena/
├── src-tauri/                  # Rust-бэкенд (Tauri)
│   ├── src/
│   │   ├── bin/
│   │   │   ├── native_host.rs  # Native messaging host для веб-клиппера (stdin/stdout JSON)
│   │   │   ├── cold_space_audit.rs # Read-only source + disposable derived acceptance CLI
│   │   │   ├── export_bindings.rs # Rust/Specta → committed TypeScript bindings
│   │   │   ├── localize_remote_media.rs # CLI: найти медиа, оставшееся удалённой ссылкой
│   │   │   ├── migrate_vault_layout.rs # CLI: разложить плоское хранилище по Collections/Cards/Media
│   │   │   ├── migrate_body_to_wikilinks.rs      # Legacy-миграция inline media → wikilinks
│   │   │   ├── migrate_collections_to_wikilinks.rs # Legacy-миграция membership → quoted wikilinks
│   │   │   └── migrate_primary_file_to_wikilinks.rs # Legacy-миграция frontmatter file → wikilink
│   │   ├── main.rs             # Только инициализация Tauri
│   │   ├── lib.rs              # Crate root: модули, feature gate `desktop`
│   │   ├── asset_protocol.rs   # Custom asset:// protocol: async body, respond на main thread, basename fallback
│   │   ├── bindings.rs         # Rust-owned IPC DTO contract для Specta-экспорта
│   │   ├── net.rs              # validate_fetch_url и сетевые утилиты (native host, импорт)
│   │   ├── util.rs             # Общие утилиты приложения и native host
│   │   ├── domain/             # Чистая бизнес-логика (без Tauri, без SQLite)
│   │   │   ├── mod.rs
│   │   │   ├── block.rs        # Block, BlockType, frontmatter parsing
│   │   │   ├── channel.rs      # Channel (promoted tag)
│   │   │   ├── collection.rs   # Collection helpers
│   │   │   ├── markdown.rs     # Чистые Markdown-трансформации body
│   │   │   ├── article_audio.rs # PreparedArticleSpeech: speakable text, text_hash
│   │   │   ├── tag.rs          # Tag operations
│   │   │   ├── vault.rs        # Vault path resolution, derived store layout, file naming
│   │   │   └── search.rs       # Search query parsing
│   │   ├── storage/            # Персистентность (SQLite, FS)
│   │   │   ├── mod.rs
│   │   │   ├── db.rs           # Connection pragmas/opening
│   │   │   ├── migrations.rs   # Versioned PRAGMA user_version migrations + validation (канонический DDL)
│   │   │   ├── cold_space_audit.rs # Cold/reopen/cache-reset projection acceptance
│   │   │   ├── index.rs        # Frontmatter → SQLite indexing
│   │   │   ├── reconcile.rs    # Filesystem-first реконсиляция source vault ↔ индекс
│   │   │   ├── source_mutation.rs # Атомарные multi-file мутации source с rollback
│   │   │   ├── block_queries.rs # Block read models + row hydration
│   │   │   ├── channel_index.rs # Collection persistence owner
│   │   │   ├── vault_conflicts.rs # Vault filename conflict queries
│   │   │   ├── projection.rs   # ProjectionRevision + atomic route snapshots
│   │   │   ├── search_projection.rs # SearchRevision + revision-safe cursor
│   │   │   ├── search_engine.rs # Hybrid Search: FTS5 + chunks + fastembed + fusion
│   │   │   ├── derived_preview.rs # Existence-backed preview reconciliation
│   │   │   ├── preview_plan.rs # Общий contract preview_manifest + thumbnail pipeline
│   │   │   ├── media_refs.rs   # Резолв media-ссылок (wikilinks, basename lookup)
│   │   │   ├── media_dimensions.rs # Извлечение размеров медиа
│   │   │   ├── clipper_uploads.rs # Pending clipper uploads
│   │   │   ├── article_audio.rs # Article audio sidecar persistence
│   │   │   ├── vault_stats.rs  # Read model статистики хранилища
│   │   │   ├── files.rs        # File operations (copy, move, delete)
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
│   │       ├── state.rs        # AppState, VaultState, CommandError (composition root)
│   │       ├── freshness.rs     # Reconciliation coordinator
│   │       ├── preview_reconcile.rs # Derived preview queue
│   │       ├── thumbnail_sweeps.rs # Thumbnail sweep coordinator
│   │       ├── thumbnails.rs   # Thumbnail commands (Phase 2 upgrades)
│   │       ├── native_shell_smoke.rs # Packaged WKWebView IPC smoke report
│   │       ├── window_chrome.rs # Native View-menu projection for Sidebar state
│   │       ├── blocks.rs       # → вызывает domain + storage
│   │       ├── channels.rs     # list/create/delete/reorder channels
│   │       ├── conflicts.rs    # Vault conflict resolution
│   │       ├── clipper_recovery.rs # Recovery pending clipper uploads
│   │       ├── article_audio.rs # Article audio state/generate/delete
│   │       ├── article_audio_desktop.rs # Desktop synthesis через Swift helper
│   │       ├── vault_stats.rs  # Statistics bar read model
│   │       ├── graph.rs        # list_graph_snapshot command
│   │       ├── tags.rs
│   │       ├── search.rs
│   │       ├── vault.rs        # select_vault, get_vault_path, rebuild_index
│   │       ├── settings.rs     # Окно настроек: spaces list, orphan media (scan/promote/delete)
│   │       └── import.rs       # list_arena_channels, import_arena_channels
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # React-фронтенд
│   ├── main.tsx                # Точка входа React (main-окно)
│   ├── App.tsx                 # Корневой компонент + роутинг
│   ├── settings/               # Окно настроек (второй Vite-entry: settings.html)
│   │   ├── main.tsx            # Bootstrap: тема до первого рендера
│   │   ├── SettingsApp.tsx     # Хром + навигация разделов
│   │   └── *Section.tsx        # AppearanceSection, GraphSection, SpacesSection, OrphansSection
│   ├── components/
│   │   ├── Grid.tsx            # Virtualized masonry grid — scroll-based windowing, direction-aware overscan, priority loading
│   │   ├── GraphView.tsx       # Graph M1: Canvas nodes/edges, route-derived scope, selection/a11y
│   │   ├── graph/              # Canvas paint, physics, contracts, interactions
│   │   ├── grid/               # Grid interaction geometry/controllers
│   │   ├── MainSecondaryChrome.tsx # Main route secondary chrome
│   │   ├── Card.tsx            # Адаптивная карточка по типу блока (5 типов)
│   │   ├── Sidebar.tsx         # Каналы, счётчики, навигация, кнопка импорта
│   │   ├── Detail.tsx          # Lightbox: просмотр, коллекции, навигация стрелками
│   │   ├── VaultPicker.tsx     # Выбор vault через нативный диалог
│   │   ├── DropZone.tsx        # Drag-and-drop файлов для создания блоков
│   │   ├── ImportDialog.tsx    # 4-шаговый импорт из Are.na
│   │   ├── CardContextMenu.tsx # Контекстное меню карточки: коллекции, удаление
│   │   └── SidebarResizeHandle.tsx # Ресайз-ручка сайдбара (pill-стиль)
│   ├── hooks/                  # useSidebarResize, useGridScroll, useChannelPreviewsEvents, useProjectionRevisionOwner, useThumbnailUpgrade и др.
│   ├── types/                  # generated.ts from Rust/Specta + frontend-owned index.ts
│   ├── lib/                    # commands.ts (IPC), masonryLayout.ts, cardLayout.ts, cardHeight.ts, cardAspect.ts (политика обрезки), assets.ts, clipboard.ts, utils.ts (cn()) и др.
│   ├── workers/                # fontMetrics.worker.ts (Canvas measureText), thumbWorker.ts
│   ├── dev/                    # Dev-only Feed, Graph, ColdSpace and SidebarReorder acceptance routes
│   ├── test/                   # Vitest setup
│   └── styles/                 # Глобальные стили (global.css)
├── scripts/
│   ├── browser-audits.mjs      # Оркестратор browser gates: свой Vite, все аудиты, teardown
│   ├── feed-scroll-audit.mjs   # Playwright Grid scroll/source-request acceptance
│   ├── sidebar-reorder-audit.mjs # Playwright sidebar collection reorder gesture acceptance
│   ├── graph-view-audit.mjs    # Dark/light Canvas pixel/interaction/performance acceptance
│   ├── cold-space-browser-audit.mjs # First/settled/deep cold Grid acceptance
│   ├── native-shell-smoke.mjs  # Packaged macOS WKWebView + Tauri IPC smoke
│   ├── build-ios.sh            # Сборка Rust core + xcframework для iOS
│   └── seed-vault.ts, import-arena.ts, fetch-link-thumbs.ts # Утилиты наполнения vault
├── extension/                  # Chrome/Safari веб-клиппер
│   ├── background.js           # Service worker: контекстное меню, native messaging
│   ├── content.js              # Content script: метаданные, Defuddle, Twitter/Instagram парсеры
│   ├── popup/                  # React popup (исходники, собирается Vite)
│   │   ├── index.html          # HTML entry point
│   │   ├── main.tsx            # React entry
│   │   ├── overlay-entry.tsx / OverlayShell.tsx # Overlay-вариант клиппера
│   │   ├── popup-layout.css    # Импорт global.css + popup-размеры
│   │   ├── PopupApp.tsx        # Корневой компонент
│   │   ├── components/         # VaultSelect, TypeSwitcher, ChannelList, SaveButton, ScreenshotPreview
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
│   ├── Mine.xcodeproj
│   ├── LocalArena/
│   │   ├── MineApp.swift # @main, WindowGroup, VaultViewModel
│   │   ├── ContentView.swift   # Корневой ZStack, сидинг тестовых данных
│   │   ├── GridView.swift      # Masonry 2 колонки, @State навигация (без NavigationStack)
│   │   ├── CardViews.swift     # BlockCard роутер, SocialCard, ImageCard, ArticleCard, LinkCard, VideoCard
│   │   ├── DetailView.swift    # Полный просмотр блока, AutoplayVideo, кастомная кнопка назад
│   │   ├── VaultViewModel.swift # Мост SwiftUI → Rust FFI (open, scan, listBlocks)
│   │   ├── Theme.swift         # Arena enum: цвета, отступы, типографика
│   │   ├── Info.plist          # UILaunchScreen (обязательно для полноэкранного режима)
│   │   └── TestData/           # Тестовые .md файлы (копируются в Documents при первом запуске)
│   └── MineCore.xcframework # Скомпилированный Rust core (device + simulator)
├── vite.extension.config.ts    # Vite-конфигурация для сборки расширения
├── vite.overlay.config.ts      # Vite-конфигурация overlay-варианта клиппера
├── public/                     # Статические ассеты
├── index.html
├── components.json             # Конфигурация shadcn/ui
├── vite.config.ts
├── settings.html               # Второй Vite-entry: окно настроек
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
├── .mine/
│   └── vault-id                    # Sync'ed идентификатор vault
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
    └── audio/
```

Коллекции = `.md` файлы с `type: channel` (метаданные в frontmatter: position, color, icon). Блок = `.md` файл + опциональный медиафайл. Collection membership — через `Mine Collections` с quoted Obsidian wikilinks, например `- "[[Красивый веб]]"`; `tags` остаётся пользовательским Obsidian-полем.

## Git

- `origin` — https://github.com/i-iii4/Mine.git (private)
- Main branch: `main`
- Аккаунт репозитория — `i-iii4`, привязан локально:
  `git config credential.username i-iii4` в `.git/config`. Он покрывает и все
  worktree, потому что конфиг общий. Привязка нужна, когда в связке ключей
  живёт несколько GitHub-аккаунтов: helper `gh` игнорирует запрошенное имя и
  отдаёт токен активного аккаунта, поэтому push падает с
  `Permission to i-iii4/Mine.git denied to <другой аккаунт>`. Имя выбирает
  нужную запись из osxkeychain, который стоит в глобальной цепочке следом за
  `gh`. Не переключайте активный аккаунт `gh` ради пуша и не изобретайте
  локальные credential-helper'ы: при этой ошибке проверьте
  `git config --local --get-regexp credential`.

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
bun run pack:extension         # Упаковка расширения в архив
bun run clipper:install-host   # Установка/обновление native host бинарника
bun run lint                   # Линтинг фронтенда
bun run test                   # Полная проверка: Vitest + Rust workspace tests
bun run test:frontend          # Только Vitest
bun run test:rust              # Только Rust workspace tests
bun run test:feed-scroll       # Browser Grid acceptance (requires running dev server)
bun run test:graph             # Browser Graph Canvas acceptance (requires running dev server)
bun run test:cold-space        # Browser cold first/settled/deep Grid acceptance (requires running dev server)
bun run test:sidebar-reorder   # Browser sidebar collection reorder gesture acceptance (requires running dev server)
bun run test:browser           # Сам поднимает Vite и запускает все browser gates
bun run test:native-shell      # Packaged macOS WKWebView + real Tauri invoke smoke
bun run bindings:generate      # Обновить committed Rust/Specta TypeScript bindings
bun run bindings:check         # Проверить bindings на drift
bun run verify:core            # Bindings + lint + frontend/Rust tests
bun run verify                 # Полный contract, включая Feed, Graph и cold-space browser gates
bun run verify:release         # Полный contract + native-shell smoke
bunx shadcn info               # Проверить CLI/config/base без изменения файлов
bunx shadcn add button --diff  # Read-only upstream diff; не перезаписывает компонент
cargo run -p mine --bin localize-remote-media -- --dry-run <vault> # Найти медиа, оставшееся удалённой ссылкой
cargo run -p mine --bin migrate-vault-layout -- --dry-run <vault>   # Разложить плоское хранилище по Collections/Cards/Media
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

## Operational launch rule

- Do not start localhost/Vite/browser dev server for routine app launch unless
  the user explicitly asks for a browser/dev-server workflow.
- When the user asks to launch the app, open the macOS `.app` bundle with
  `open` so no extra terminal window remains attached to the app.
- Use `cargo tauri dev` only when the task explicitly needs live frontend
  development or a localhost-backed dev session.

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
