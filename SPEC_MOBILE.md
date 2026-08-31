# Specification: iOS Mobile App

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md) | [SPEC_SAVE_CORE.md](SPEC_SAVE_CORE.md)

## Overview

iOS-приложение Mine — мобильный компаньон к десктопу. Просмотр, поиск, сохранение контента из Share Sheet. Данные синхронизируются через iCloud Drive + CloudKit push. Общее Rust-ядро с десктопом через UniFFI.

## Решения

| Решение | Выбор | Обоснование |
|---|---|---|
| UI-фреймворк | SwiftUI | Нативный iOS-опыт, лучшая производительность |
| Бэкенд | Rust core через UniFFI | Переиспользование domain + storage из десктопа |
| Sync | iCloud Drive + CloudKit push | Бесплатно, без серверов, ~1—3 сек |
| Репозиторий | Монорепо (`ios/` в корне) | Общий Rust-код, атомарные изменения |
| Мультиплатформа (позже) | Dropbox API как второй sync-бэкенд | Для Android-пользователей |

## Архитектура

Целевое разделение общего ядра и нативного исполнителя принято в
[SPEC_SAVE_CORE.md](SPEC_SAVE_CORE.md), но перенос ещё не начат. UniFFI
остаётся тонким мостом: правила и общий сценарий не копируются в Swift или
FFI-обёртку. SC5 переносит существующие возможности, не добавляя новые iOS-
функции и не объявляя отложенные этапы этой спецификации завершёнными.

```
┌─────────────────────────────────────────────────┐
│                  iOS App (SwiftUI)               │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │   Grid   │  │  Detail  │  │  Share Ext.   │  │
│  │  (cards) │  │  (view)  │  │  (save flow)  │  │
│  └────┬─────┘  └────┬─────┘  └──────┬────────┘  │
│       └──────────────┼───────────────┘           │
│                      │                           │
│              ┌───────▼────────┐                  │
│              │  Swift Bridge  │                  │
│              │  (UniFFI)      │                  │
│              └───────┬────────┘                  │
└──────────────────────┼───────────────────────────┘
                       │ FFI
              ┌────────▼────────┐
              │  mine_lib │ (Rust)
              │                 │
              │  domain/        │ — Block, Channel, Vault, Tag
              │  storage/       │ — SQLite, files, thumbnails
              └────────┬────────┘
                       │ файловая система
              ┌────────▼────────┐
              │  iCloud Drive   │
              │  (shared vault) │
              └─────────────────┘
```

## Rust-ядро: что переиспользуется

| Модуль | Переиспользование | Адаптация |
|---|---|---|
| `domain/block.rs` | 100% | — |
| `domain/channel.rs` | 100% | — |
| `domain/vault.rs` | 90% | Пути iCloud container вместо произвольной папки |
| `domain/tag.rs` | 100% | — |
| `domain/search.rs` | 100% | — |
| `storage/db.rs` | 100% | — |
| `storage/index.rs` | 100% | — |
| `storage/files.rs` | 95% | Trash API не через `trash` crate на iOS |
| `storage/thumbnails.rs` | 80% | iOS image APIs вместо `image` crate (опционально) |
| `watcher/` | 0% | iOS не использует fs watcher — sync через CloudKit push |
| `commands/` | 0% | Tauri-специфичный слой, на iOS — Swift вызовы через UniFFI |
| `bin/native_host.rs` | 0% | Десктоп-специфичный |

## UniFFI Bindings

Rust-ядро экспортирует API через UniFFI (Mozilla). Генерирует Swift-обёртки автоматически.

```rust
// Пример: uniffi-экспорт
#[uniffi::export]
fn list_blocks_light(db_path: String) -> Result<Vec<LightBlock>, ArenaError> {
    let conn = db::open_or_create(&PathBuf::from(db_path))?;
    let blocks = index::list_blocks_light(&conn)?;
    Ok(blocks)
}

#[uniffi::export]
fn parse_and_save_block(vault_path: String, slug: String, content: String) -> Result<(), ArenaError> {
    let vault = VaultLayout::new(PathBuf::from(vault_path));
    let block = parse_block(&slug, &content)?;
    files::write_block_file(&vault, &block)?;
    Ok(())
}
```

Swift вызывает:
```swift
let vault = try ArenaVault.open(vaultPath: vaultPath)
let blocks = try vault.listBlocks()
```

## Синхронизация: iCloud Drive + CloudKit Push

### iCloud Drive (файлы)

Vault = папка в iCloud Drive container. Оба приложения (macOS + iOS) работают с одной папкой.

```
macOS: ~/Library/Mobile Documents/iCloud~com~localarena~app/Documents/vault/
iOS:   FileManager.url(forUbiquityContainerIdentifier: "iCloud.com.localarena.app")
```

Файлы синхронизируются автоматически через iCloud. Скорость: 2—10 секунд.

### CloudKit Push (ускорение)

При сохранении блока приложение записывает маркер в CloudKit:

```swift
// После сохранения .md файла
let record = CKRecord(recordType: "SyncEvent")
record["timestamp"] = Date()
record["device"] = UIDevice.current.name
CKContainer.default().privateCloudDatabase.save(record) { ... }
```

Второе устройство получает push через `CKSubscription`:

```swift
// При получении push
let query = CKQuery(recordType: "SyncEvent", predicate: NSPredicate(value: true))
// → Trigger NSFileCoordinator.startDownloadingUbiquitousItem для vault
// → Watcher/re-index
```

Результат: ~1—3 секунды между сохранением и отображением на другом устройстве.

### Конфликты

iCloud Drive при конфликте создаёт копию: `note.md` → `note 2.md`. Приложение обнаруживает конфликт-файлы при re-index и предлагает пользователю выбрать версию.

## Сохранение контента (Share Extension)

### Поддерживаемые входы

| Вход | Что получаем | Обработка |
|---|---|---|
| URL из Safari | URL string | Fetch og:tags → создать link/article блок |
| URL из Twitter app | Tweet URL | Syndication API → текст + медиа |
| URL из Instagram app | Post URL | Ограничено (нет cookies) — og:image + page heading seed |
| URL из YouTube app | Video URL | oEmbed → page heading seed + thumbnail |
| Изображение | UIImage data | Сохранить как image блок |
| Текст | String | Сохранить как article блок |

### Share Extension Flow

```
1. Пользователь нажимает Share → Mine
2. Share Extension получает URL/image/text
3. Если URL:
   a. Показать spinner
   b. Fetch страницы → extract og:title as body H1 seed, og:image, og:description
   c. Для Twitter: вызвать syndication API → получить текст + медиа
   d. Показать preview: display heading + image + tag picker
4. Пользователь выбирает теги → Save
5. Rust core: создать .md файл + скачать медиа
6. CloudKit push → десктоп получает уведомление
7. Dismiss Share Extension
```

### Ограничения vs десктоп

| Функция | Десктоп | iOS |
|---|---|---|
| DOM-парсинг (Defuddle) | Да (content script) | Нет |
| Twitter полный парсинг | Syndication API + DOM | Syndication API only |
| Instagram с cookies | REST API v1 (cookies) | Нет cookies (только og:tags) |
| YouTube транскрипт | Defuddle + InnerTube | Нет |
| Кнопка в ленте Instagram | Content script injection | Нет |
| Статьи (Readability) | Defuddle в браузере | HTTP fetch + Swift-парсинг (SwiftSoup) |

## Экраны приложения

### 1. Grid (главный экран)

Masonry-сетка блоков, как на десктопе. Pull-to-refresh. Фильтр по каналам через tab bar или sidebar.

### 2. Detail

Полноэкранный просмотр блока. Кастомная кнопка «назад» (шеврон в полупрозрачном круге). Видео — автоплей через `AutoplayVideo` (AVPlayer). Теги, метаданные внизу. Свайп-навигация — не реализована.

### 3. Channel list

Список каналов с preview-картинками. Создание, переименование, удаление. **Статус: не начато (M2.6).**

### 4. Search

Поиск по FTS5 (тот же SQLite через Rust core). Cmd+K на десктопе → search bar на iOS.

### 5. Save (Share Extension)

Компактный UI: preview карточка + tag picker + save button. Аналог popup'а десктопного расширения.

## Структура проекта

```
ios/
├── LocalArena/                    # Main app target
│   ├── App.swift                  # @main, app lifecycle
│   ├── ContentView.swift          # Root ZStack, фон, сидинг тестовых данных
│   ├── GridView.swift             # Masonry 2 колонки, @State навигация
│   ├── CardViews.swift            # BlockCard роутер + SocialCard, ImageCard, ArticleCard, LinkCard, VideoCard
│   ├── DetailView.swift           # Полный просмотр, AutoplayVideo, custom back button
│   ├── VaultViewModel.swift       # Мост SwiftUI → Rust FFI
│   ├── Theme.swift                # Arena enum: цвета, отступы, типографика
│   └── Info.plist                 # UILaunchScreen (обязателен для полноэкранного режима)
├── LocalArenaShare/               # Share Extension target
│   ├── ShareViewController.swift  # Share sheet UI
│   └── ContentExtractor.swift     # URL → metadata extraction
├── LocalArenaCore/                # Rust UniFFI bindings (built by cargo)
│   └── mine_ffi.swift     # Auto-generated by UniFFI
└── Mine.xcodeproj
```

## Порядок реализации

### Phase M1 — Rust core UniFFI bindings
- Выделить `mine_lib` в workspace crate
- Добавить UniFFI экспорт для ключевых функций
- Собрать xcframework для iOS (arm64)
- Smoke test: Swift вызывает `parse_block()` и `list_blocks_light()`

### Phase M2 — Базовое iOS приложение
- Xcode project в `ios/`
- iCloud Drive container setup
- Grid view (SwiftUI LazyVGrid)
- Detail view (@State навигация, без NavigationStack)
- Channel list (M2.6 — не начато)

### Phase M3 — Sync
- iCloud Drive file monitoring (NSMetadataQuery)
- CloudKit push при сохранении
- Re-index при получении push
- Conflict detection

### Phase M4 — Share Extension
- Share Extension target
- URL extraction (og:tags)
- Twitter syndication API
- Tag picker UI
- Save через Rust core

### Phase M5 — Polish
- Offline mode (все данные локальны)
- Thumbnail generation на iOS
- Search (FTS5)
- Haptics, animations, gestures
