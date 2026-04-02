# Полный аудит проекта Mine

**Дата:** 01.03.2026
**Роль:** Технический лид
**Область:** вся кодовая база (Rust-бэкенд, React-фронтенд, веб-клиппер, конфигурация, документация)
**Агентов:** 11 параллельных аудиторов

Связанные документы: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md)

---

## Оценка по направлениям

| Направление | Оценка | Критических | Высоких | Средних | Низких |
|---|---|---|---|---|---|
| Архитектурные границы | A+ | 0 | 0 | 0 | 0 |
| Соответствие принципам (Rust) | B+ | 1 | 3 | 1 | 2 |
| Обработка ошибок | B | 1 | 5 | 1 | 2 |
| Фронтенд | A− | 0 | 4 | 3 | 3 |
| SQLite / storage | B− | 2 | 4 | 4 | 2 |
| Безопасность | C+ | 1 | 3 | 4 | 5 |
| Производительность | B | 0 | 2 | 3 | 3 |
| Тестовое покрытие | C+ | — | — | — | — |
| Документация | A | 0 | 0 | 2 | 1 |
| Дизайн-система | A− | 0 | 3 | 2 | 2 |
| Tauri / сборка | B− | 2 | 1 | 3 | 6 |
| Веб-клиппер | C | 2 | 2 | 4 | 5 |

**Общая оценка: B (хорошо, но есть блокеры для продакшена)**

---

## Часть I. Критические проблемы (блокеры релиза)

### CRIT-1. `panic!()` в продакшен-коде
- **Файл:** `src-tauri/src/domain/vault.rs:82—85`
- **Суть:** `resolve_slug_conflict()` вызывает `panic!()` вместо возврата `Result`
- **Принцип:** #2 — «Паника в продакшене запрещена»
- **Исправление:** заменить на `Err(VaultError::SlugConflictUnresolvable { slug })`

### CRIT-2. Отсутствие транзакций в `upsert_block()`
- **Файл:** `src-tauri/src/storage/index.rs:51—120`
- **Суть:** 4 SQL-операции (INSERT block, SELECT id, DELETE/INSERT tags, DELETE/INSERT wikilinks) выполняются без `BEGIN TRANSACTION`. При сбое — неконсистентные данные
- **Принцип:** #5 — «Ошибки обрабатываются явно»
- **Исправление:** обернуть в `conn.transaction()? ... tx.commit()?`

### CRIT-3. N+1 запросы при выборке тегов
- **Файл:** `src-tauri/src/storage/index.rs:366—388`
- **Суть:** `collect_blocks()` вызывает `get_tags_for_block()` для каждого блока. 10 000 блоков = 10 001 SQL-запрос
- **Принцип:** #8 — «Производительность — архитектурное решение»
- **Исправление:** один запрос с `GROUP_CONCAT` или батч-выборка через `WHERE block_id IN (...)`

### CRIT-4. CSP отключена в Tauri
- **Файл:** `src-tauri/tauri.conf.json:28`
- **Суть:** `"csp": null` — полностью отключает Content Security Policy
- **Принцип:** безопасность — defence in depth
- **Исправление:** `"csp": "default-src 'self'; img-src 'self' asset: https:; script-src 'self'; style-src 'self' 'unsafe-inline';"`

### CRIT-5. XSS через innerHTML в popup клиппера
- **Файл:** `extension/popup/popup.js:339, 349, 357`
- **Суть:** `ch.title` вставляется в `innerHTML` без экранирования. Имя канала `<img onerror=alert(1)>` выполнит код в контексте расширения
- **Принцип:** OWASP XSS
- **Исправление:** переписать `renderChannelList()` на DOM API (`textContent` вместо `innerHTML`)

### CRIT-6. ESLint не установлен
- **Файл:** `package.json:11`
- **Суть:** `"lint": "eslint ."` в scripts, но `eslint` отсутствует в devDependencies. Линтинг фронтенда не работает
- **Исправление:** установить ESLint 9+, создать `eslint.config.js`

---

## Часть II. Высокие проблемы (требуют исправления до релиза)

### HIGH-1. Отсутствие индексов на часто используемых столбцах
- **Файл:** `src-tauri/src/storage/db.rs`
- **Суть:** нет индекса на `blocks(saved_at)` (сортировка каждого запроса) и `block_tags(block_id)` (обратный поиск тегов)
- **Исправление:** добавить `CREATE INDEX idx_blocks_saved_at ON blocks(saved_at DESC)` и `CREATE INDEX idx_block_tags_block_id ON block_tags(block_id, tag)`

### HIGH-2. Тихое проглатывание ошибки типа блока
- **Файл:** `src-tauri/src/storage/index.rs:350`
- **Суть:** `BlockType::from_str(...).unwrap_or(BlockType::File)` — если в БД невалидный тип, блок молча становится File
- **Исправление:** возвращать ошибку: `.context("invalid block_type in database")?`

### HIGH-3. `unwrap()` на Mutex в commands
- **Файл:** `src-tauri/src/commands/blocks.rs:131` и аналогичные
- **Суть:** `state.vault_state.lock().unwrap()` — если мьютекс отравлен, приложение падает
- **Исправление:** `.map_err(|_| CommandError::Internal("vault state poisoned"))?`

### HIGH-4. `unwrap()` на SystemTime
- **Файл:** `src-tauri/src/util.rs:7`
- **Суть:** `duration_since(UNIX_EPOCH).unwrap()` — теоретически может упасть при сбое системных часов
- **Исправление:** `.context("system clock before Unix epoch")?`

### HIGH-5. Path traversal при загрузке файлов
- **Файл:** `src-tauri/src/commands/blocks.rs:102`, `storage/files.rs:77—88`
- **Суть:** `file_path` от клиента преобразуется в `PathBuf` без проверки на symlink и выход за vault
- **Исправление:** `canonicalize()` + проверка `starts_with(vault_root)`

### HIGH-6. Утечка слушателя в ImportDialog
- **Файл:** `src/components/ImportDialog.tsx:57—69`
- **Суть:** если компонент размонтируется до resolve промиса `listen()`, cleanup не вызовется
- **Исправление:** паттерн `isMounted` + проверка в `.then()`

### HIGH-7. Проглатывание ошибок в Detail и App
- **Файлы:** `src/components/Detail.tsx:46—48`, `src/App.tsx:201`
- **Суть:** `catch {}` без логирования и `deleteChannel(tag).catch(() => {})` — ошибки молча игнорируются
- **Принцип:** #5 — «Ошибки обрабатываются явно, не проглатываются»
- **Исправление:** как минимум `console.error()`, в идеале — уведомление пользователя

### HIGH-8. FIFO-очередь в background.js клиппера
- **Файл:** `extension/background.js:62—91`
- **Суть:** `pendingCallbacks.shift()` — если ответы native host приходят не в порядке отправки, callback получит чужой ответ
- **Исправление:** `Map<messageId, callback>` с ID в каждом сообщении

### HIGH-9. Хардкод-цвета вне дизайн-системы
- **Файлы:** `Card.tsx:111—114` (`bg-blue-900`, `bg-emerald-900`...), `ImportDialog.tsx:355` (`bg-green-50`), `VaultPicker.tsx:54` (`text-amber-600`)
- **Принцип:** семантические токены, единая палитра
- **Исправление:** заменить на `bg-primary/80`, `bg-muted`, `text-destructive`

### HIGH-10. `.expect()` в lib.rs вместо обработки ошибки
- **Файл:** `src-tauri/src/lib.rs:95—96`
- **Суть:** `.expect("error while running tauri application")` — паника при ошибке запуска
- **Исправление:** возвращать `Result` и обрабатывать в `main()`

---

## Часть III. Средние проблемы

### MED-1. Дублирование `is_image_ext()`
- **Файлы:** `watcher/handler.rs:126—130`, `commands/blocks.rs:154—159`
- **Исправление:** вынести в `util.rs` как общую функцию

### MED-2. FTS5 без указания токенизатора
- **Файл:** `storage/db.rs:89—93`
- **Суть:** по умолчанию Porter (английский). Кириллица ищется неоптимально
- **Исправление:** `tokenize='unicode61 remove_diacritics 0'`

### MED-3. `list_blocks()` без LIMIT
- **Файл:** `storage/index.rs:151—158`
- **Суть:** загружает все блоки в память. При 10 000+ блоков — замедление
- **Исправление:** добавить LIMIT/OFFSET или пагинацию

### MED-4. TOCTOU в `delete_block_files()`
- **Файл:** `storage/files.rs:99—116`
- **Суть:** `if path.exists()` → `remove_file()` — файл может исчезнуть между проверкой и удалением
- **Исправление:** ловить `ErrorKind::NotFound` и игнорировать

### MED-5. Нет лимита на размер изображения при генерации thumbnail
- **Файл:** `storage/thumbnails.rs:28—56`
- **Суть:** 10 000×10 000 PNG = ~400 МБ в памяти. OOM при обработке
- **Исправление:** проверка `if w > 8192 || h > 8192 { return Err(...) }`

### MED-6. Нет таймаутов в native_host HTTP
- **Файл:** `src-tauri/src/bin/native_host.rs:251—266`
- **Суть:** загрузка файла без таймаута — может зависнуть
- **Исправление:** `.timeout(Duration::from_secs(30))`

### MED-7. Неатомарная запись файлов в native_host
- **Файл:** `src-tauri/src/bin/native_host.rs:312—314`
- **Суть:** если процесс упадёт при записи — файл повреждён
- **Исправление:** write-to-temp + rename (атомарная замена)

### MED-8. Open redirect в Detail.tsx
- **Файл:** `src/components/Detail.tsx:170—177`
- **Суть:** `block.url` может быть `javascript:alert()` — нет валидации протокола
- **Исправление:** проверка `['http:', 'https:'].includes(parsed.protocol)`

### MED-9. Markdown-ссылки без валидации URL
- **Файлы:** `Detail.tsx:356—365`, `extension/content.js:168—174`
- **Суть:** `href` в markdown ссылках не проверяется на `javascript:` протокол
- **Исправление:** валидация URL перед рендерингом

### MED-10. Ошибки watcher проглатываются
- **Файл:** `watcher/watch.rs:54—56`
- **Суть:** `if let Err(e) = handle_event(...)` — только `log::warn`, индекс рассинхронизируется
- **Исправление:** эмитить Tauri-событие `watcher-error`, счётчик ошибок → full_scan при накоплении

### MED-11. Ошибки импорта не различают recoverable/fatal
- **Файл:** `import/importer.rs:80—93`
- **Суть:** ошибка парсинга блока и ошибка БД обрабатываются одинаково (скип)
- **Исправление:** разделить на `ImportError::BlockParseFailed` и `ImportError::DatabaseFailed`

### MED-12. `as PointerEvent` без проверки типа
- **Файл:** `src/App.tsx:37`
- **Исправление:** `if (!(activatorEvent instanceof PointerEvent)) return transform;`

---

## Часть IV. Тестовое покрытие

### Текущее состояние: 228 Rust-тестов + 49 фронтенд-тестов = 277 всего

| Модуль | Тестов | Оценка |
|---|---|---|
| domain/block | 87 | Отлично — эталонный модуль |
| domain/tag | 17 | Хорошо |
| domain/channel | 20 | Хорошо |
| domain/vault | 13 | Хорошо |
| domain/search | 14 | Хорошо |
| storage/index | 25 | Среднее — нет edge cases |
| storage/db | 13 | Среднее |
| storage/files | 8 | Слабо — нет тестов удаления |
| storage/thumbnails | 5 | Слабо — только happy path |
| watcher/handler | 10 | Среднее |
| watcher/events | 9 | Среднее |
| **watcher/watch** | **0** | **Нет тестов** |
| **commands/* (8 файлов)** | **0** | **Нет тестов** |
| **import/arena_api** | **0** | **Нет тестов** |
| import/importer | 4 | Очень слабо |
| Frontend (5 файлов) | 49 | Среднее |
| **Grid, Detail, App, DropZone** | **0** | **Нет тестов** |

### Критические пробелы (Tier 1)
1. `commands/*` — 0 тестов на весь IPC-слой
2. `arena_api.rs` — 0 тестов на HTTP-клиент
3. `files.rs` — нет тестов удаления и конфликтов
4. `watch.rs` — 0 тестов на основной цикл watcher

### Интеграционные тесты: 0
### E2E тесты: 0

---

## Часть V. Документация

Документация в превосходном состоянии (оценка A). Единственная проблема:

### DOC-1. 5 команд не задокументированы в SPEC_INTEGRATION.md
- `rename_tag`, `delete_tag_from_all` (commands/tags)
- `reorder_channels`, `rename_channel` (commands/channels)
- `rebuild_index` (commands/vault)

---

## Часть VI. План действий

### Этап 1 — Критические исправления (блокеры)

| # | Задача | Файлы | Время |
|---|---|---|---|
| 1 | Заменить `panic!()` на `Result` в vault.rs | domain/vault.rs | 15 мин |
| 2 | Обернуть `upsert_block()` в транзакцию | storage/index.rs | 30 мин |
| 3 | Исправить N+1: батч-выборка тегов | storage/index.rs | 1 час |
| 4 | Включить CSP в tauri.conf.json | tauri.conf.json | 15 мин |
| 5 | Исправить XSS в popup.js (DOM API) | extension/popup/popup.js | 1 час |
| 6 | Установить и настроить ESLint | package.json, eslint.config.js | 30 мин |

### Этап 2 — Высокие исправления

| # | Задача | Файлы | Время |
|---|---|---|---|
| 7 | Добавить индексы `saved_at` и `block_tags(block_id)` | storage/db.rs | 15 мин |
| 8 | Убрать `unwrap_or(BlockType::File)` | storage/index.rs | 10 мин |
| 9 | Заменить все `unwrap()` на Mutex | commands/*.rs | 30 мин |
| 10 | Path traversal: canonicalize + проверка vault | commands/blocks.rs, storage/files.rs | 30 мин |
| 11 | Исправить утечку слушателя в ImportDialog | ImportDialog.tsx | 15 мин |
| 12 | Добавить `console.error` в пустые catch | Detail.tsx, App.tsx | 10 мин |
| 13 | Заменить FIFO на Map в background.js | extension/background.js | 1 час |
| 14 | Заменить хардкод-цвета на токены | Card.tsx, ImportDialog.tsx, VaultPicker.tsx | 30 мин |
| 15 | `.expect()` → `Result` в lib.rs | lib.rs, main.rs | 15 мин |

### Этап 3 — Средние исправления

| # | Задача | Файлы | Время |
|---|---|---|---|
| 16 | Вынести `is_image_ext()` в shared util | util.rs, handler.rs, blocks.rs | 15 мин |
| 17 | FTS5 tokenizer `unicode61` | storage/db.rs | 10 мин |
| 18 | Лимит размера изображений | storage/thumbnails.rs | 10 мин |
| 19 | Таймауты HTTP в native_host | bin/native_host.rs | 15 мин |
| 20 | Атомарная запись файлов | bin/native_host.rs | 30 мин |
| 21 | Валидация URL в Detail и markdown | Detail.tsx | 15 мин |
| 22 | Восстановление watcher при ошибках | watcher/watch.rs | 30 мин |

### Этап 4 — Тесты (критические пробелы)

| # | Задача | Время |
|---|---|---|
| 23 | Тесты commands/blocks.rs (create, delete, list) | 2 часа |
| 24 | Тесты commands/tags.rs, channels.rs | 1.5 часа |
| 25 | Тесты storage/files.rs (delete, conflicts) | 1 час |
| 26 | Тесты arena_api.rs (мок HTTP) | 1.5 часа |
| 27 | Тесты watch.rs | 1 час |

### Этап 5 — Документация

| # | Задача | Время |
|---|---|---|
| 28 | Обновить SPEC_INTEGRATION.md (5 команд) | 30 мин |

---

## Что сделано отлично

Аудит выявил не только проблемы, но и образцовые решения:

1. **Архитектурные границы безупречны** — domain/ не знает о storage/, commands/ тонкие, DAG без циклов
2. **Эталонный модуль block.rs** — 87 тестов, все 20 edge cases, roundtrip тесты
3. **Типизация сквозная** — thiserror в domain, anyhow в storage, no `any` во фронтенде
4. **Нет TODO/FIXME/HACK** — нулевой технический долг в комментариях
5. **Документация** — 13 файлов, 99% покрытие модулей, перекрёстные ссылки целостны
6. **shadcn/ui миграция** — OKLCH-токены, 14 примитивов, последовательная кастомизация
7. **Двухслойный layout Detail** — элегантное архитектурное решение (shared LAYOUT_CLASSES)
8. **Параметризованные SQL-запросы** — ни одного случая SQL injection
9. **File watcher с debounce** — 300ms, пакетная обработка, корректная очистка
10. **Чанковый рендеринг Grid** — IntersectionObserver, 80+60 батчи, 60 fps

---

# Повторный аудит — 03.03.2026

**Агентов:** 10 параллельных аудиторов (panic/unwrap, фронтенд-ошибки, безопасность, SQL/storage, производительность, клиппер, качество кода, типы/IPC, конфигурация, тесты)

## Прогресс с первого аудита (01.03)

Все 6 критических проблем (CRIT-1—CRIT-6) и 7 высоких (HIGH-1—HIGH-5, HIGH-7, индексы) **исправлены** в коммите `c5d2a92`.

## Новые критические находки

### CRIT-7. Гонка состояний в FIFO-очереди клиппера
- **Файл:** `extension/background.js:75—76`
- **Суть:** `pendingCallbacks.shift()` при параллельных запросах доставляет ответ не тому вызывающему. Таймауты не очищаются при `onDisconnect` — срабатывают на стейловых замыканиях после переподключения
- **Исправление:** `Map<messageId, callback>` + очистка таймеров в `onDisconnect`

### CRIT-8. Осиротевшие медиафайлы при ошибке записи .md
- **Файл:** `src-tauri/src/bin/native_host.rs:314—317`
- **Суть:** если `write_block_file()` падает после скачивания медиа, медиафайлы остаются в vault без индексации. Нет отката
- **Исправление:** откатка — удалить скачанные файлы при ошибке записи .md

### CRIT-9. `lock().unwrap()` на Mutex в watcher
- **Файл:** `watcher/watch.rs:60`
- **Суть:** `last_emit.lock().unwrap()` — единственный оставшийся `unwrap()` на Mutex в продакшен-коде. При отравлении мьютекса — паника
- **Исправление:** `.lock().unwrap_or_else(|e| e.into_inner())` или `.map_err()`

## Новые высокие находки

### HIGH-11. Массовое отсутствие обработки ошибок в App.tsx
- **Файл:** `src/App.tsx`
- **Суть:** 9 async-функций не обёрнуты в try/catch — ошибки молча проглатываются:
  - `loadData()` (129—134) — Promise.all без catch
  - `handleRenameTag()` (186—195)
  - `handleDeleteTagFromAll()` (198—205) — частично
  - `handleCreateChannel()` (281—287)
  - `handleReorderTag()` (289—302)
  - `handleCardDrop()` (306—312)
  - `handleToggleTag()` (363—374)
  - `handleCreateTagFromMenu()` (376—383)
  - `handleDeleteBlock()` (385—391)
- **Исправление:** try/catch на каждую async-функцию + console.error

### HIGH-12. O(N) вычисления channelPreviews при каждом рендере
- **Файл:** `src/App.tsx:238—277`
- **Суть:** двойной цикл по всем блокам * все теги при каждом рендере, без `useMemo`. При 10K блоков — заметные тормоза
- **Исправление:** `useMemo` с зависимостью от blocks/channels

### HIGH-13. ChannelPage фильтрация без мемоизации
- **Файл:** `src/App.tsx:522—524`
- **Суть:** `blocks.filter(...)` на каждый рендер без `useMemo`
- **Исправление:** `useMemo` на фильтрацию

### HIGH-14. O(N) загрузка всех блоков для проверки slug
- **Файл:** `src-tauri/src/commands/blocks.rs:62—65`
- **Суть:** `list_blocks()` загружает все блоки для проверки существования slug. При 10K блоков — O(N) на каждое создание
- **Исправление:** SQL-запрос `SELECT 1 FROM blocks WHERE path = ? LIMIT 1`

### HIGH-15. O(N) линейный поиск в list_channels
- **Файл:** `src-tauri/src/commands/channels.rs:57—66`
- **Суть:** для каждого канала — линейный поиск по всем тегам. O(каналы * теги)
- **Исправление:** HashMap из тегов для O(1) поиска

### HIGH-16. Отсутствие транзакций в rename_tag / delete_tag_from_all
- **Файлы:** `commands/tags.rs:108—124`, `commands/tags.rs:145—157`
- **Суть:** запись в файлы + переиндексация без транзакции. При ошибке — рассинхронизация FS и DB
- **Исправление:** обернуть в транзакцию

### HIGH-17. Отсутствие транзакции в rename_channel
- **Файл:** `commands/channels.rs:186—204`
- **Суть:** 3 шага (переименование тегов → переиндексация → create/delete channel) без атомарности
- **Исправление:** обернуть в транзакцию

### HIGH-18. Отсутствие транзакции в rebuild_index
- **Файл:** `commands/vault.rs:82—89`
- **Суть:** каскадное `DELETE FROM` без транзакции — частичная очистка при ошибке
- **Исправление:** обернуть в транзакцию

### HIGH-19. Неочищенные промис-хэндлеры в DropZone
- **Файл:** `src/components/DropZone.tsx:60—78`
- **Суть:** `onDragDropEvent()` промис без .catch(), дублирование листенеров при переоткрытии
- **Исправление:** .catch() + cleanup в useEffect return

### HIGH-20. Хрупкий парсинг markdown-изображений в native_host
- **Файл:** `src-tauri/src/bin/native_host.rs:439—484`
- **Суть:** строковый поиск подстрок для замены `![alt](url)`. Не обрабатывает: экранированные скобки, пустой alt, пробелы в URL, фрагменты с `)`
- **Исправление:** regex или полноценный markdown-парсер для извлечения изображений

## Новые средние находки

### MED-13. Дублирование `titleFromTag()` в 3 файлах
- **Файлы:** `App.tsx:26`, `Sidebar.tsx:33`, `CardContextMenu.tsx:22`
- **Исправление:** вынести в `lib/utils.ts`

### MED-14. Отсутствие стратегии миграции БД
- **Файл:** `storage/db.rs`
- **Суть:** `CREATE TABLE IF NOT EXISTS` работает для v1, но при изменении схемы нет `PRAGMA user_version` и миграционных скриптов
- **Исправление:** добавить версионирование схемы

### MED-15. `unsafe-inline` в CSP для стилей
- **Файл:** `tauri.conf.json:28`
- **Суть:** ослабляет CSP; по возможности убрать
- **Исправление:** `style-src 'self'` (проверить, не сломает ли shadcn/ui)

### MED-16. Пустой scope в asset protocol
- **Файл:** `tauri.conf.json:32—33`
- **Суть:** `allow: [], deny: []` — нет ограничений путей для asset: протокола
- **Исправление:** ограничить scope vault-директорией

### MED-17. og:image без проверки протокола в popup клиппера
- **Файл:** `extension/popup/popup.js:276`
- **Суть:** `previewThumb.src = metadata.image` — data:image/svg+xml URL обходит CSP
- **Исправление:** проверка протокола (http/https)

### MED-18. Неправильный порядок удаления в delete_block
- **Файл:** `commands/blocks.rs:145`
- **Суть:** сначала удаляет из индекса, потом файлы. При ошибке удаления файлов — запись потеряна из индекса, но файлы остались
- **Исправление:** сначала файлы (идемпотентно), потом индекс

### MED-19. ext_from_url() не определяет MIME из заголовков
- **Файл:** `native_host.rs:388—396`
- **Суть:** хардкод `jpg` для URL без расширения. WebP, отдаваемый как `.jpg`, ломает изображение
- **Исправление:** проверять Content-Type из HTTP-ответа

### MED-20. Рассинхронизация версий specta/tauri-specta
- **Файл:** `Cargo.toml:50—51`
- **Суть:** specta rc.22 и tauri-specta rc.21
- **Исправление:** выровнять версии

## Обновлённое тестовое покрытие

### Текущее состояние: 198 Rust-тестов + 49 фронтенд-тестов = 247 всего

| Модуль | Тестов | Оценка |
|---|---|---|
| domain/block | 87 | Отлично |
| domain/tag | 17 | Хорошо |
| domain/channel | 20 | Хорошо |
| domain/vault | 13 + 1 (новый) | Хорошо |
| domain/search | 14 | Хорошо |
| storage/index | 25 | Среднее |
| storage/db | 13 | Среднее |
| storage/files | 8 | Слабо |
| storage/thumbnails | 5 | Слабо |
| watcher/handler | 10 | Среднее |
| watcher/events | 9 | Среднее |
| **watcher/watch** | **0** | **Нет тестов** |
| **commands/* (6 файлов)** | **0** | **Нет тестов** |
| **commands/state.rs** | **0** | **Нет тестов** |
| **import/arena_api** | **0** | **Нет тестов** |
| import/importer | 4 | Слабо |
| **bin/native_host** | **0** | **Нет тестов** |
| Frontend (Card, Sidebar, Search, VaultPicker, assets) | 49 | Среднее |
| **App.tsx, Detail.tsx, Grid.tsx, DropZone.tsx, ImportDialog.tsx, CardContextMenu.tsx** | **0** | **Нет тестов** |
| **lib/commands.ts** | **0** | **Нет тестов** |

### Критические пробелы (Tier 1 — без этих тестов релиз невозможен)
1. `commands/*` — 0 тестов на весь IPC-слой (6 файлов, ~30 команд)
2. `arena_api.rs` — 0 тестов на HTTP-клиент
3. `storage/files.rs` — нет тестов удаления и конфликтов
4. `watcher/watch.rs` — 0 тестов на основной цикл watcher
5. `bin/native_host.rs` — 0 тестов на native messaging

### Интеграционные тесты: 0
### E2E тесты: 0

---

# Третий аудит — 07.03.2026

**Агентов:** 10 параллельных аудиторов (commands layer, React frontend, native host + extension, CSS/design system, performance, test coverage, architecture compliance + 3 из предыдущей сессии: domain, storage, watcher/handler)

## Прогресс с повторного аудита (03.03)

CRIT-1—CRIT-6 (первый аудит) исправлены. Phase 9.1 и 9.2 полностью завершены. CRIT-7—CRIT-9 (повторный аудит) остаются открытыми. Phase 11 (сайдбар, текстовые миниатюры, фоновая генерация) реализована.

## Системные проблемы

Аудит выявил три системных проблемы, пронизывающих всю кодовую базу:

1. **Масштабируемость при росте коллекции.** Множество O(N) паттернов: загрузка всех блоков через IPC (включая body), создание slug через полный список, превью каналов через N syscall-ов, отсутствие пагинации. При 10K блоков приложение станет заметно медленным.

2. **Безопасность IPC-границы.** Slug от фронтенда принимается без валидации — path traversal. Бизнес-логика размазана по commands/ вместо domain/. Нет транзакций в составных операциях.

3. **Устаревшая документация.** ARCHITECTURE.md: SQLite-схема содержит 8+ расхождений с кодом. SPEC_INTEGRATION.md не покрывает 6 команд. SPEC_DOMAIN.md: `thumb_path` документирует `.webp`, код возвращает `.jpg`.

## Новые критические находки

### CRIT-10. Path traversal через slug
- **Файлы:** `commands/blocks.rs` (`get_block`, `delete_block`), `commands/tags.rs` (`add_tag`, `remove_tag`, `rename_tag`, `delete_tag_from_all`)
- **Суть:** slug от фронтенда передаётся в `VaultLayout::block_path()` (`root.join(format!("{}.md", slug))`) без валидации. Slug вида `../../etc/passwd` выведет операцию за пределы vault
- **Исправление:** валидатор `fn validate_slug(s: &str) -> Result<()>` — проверка `^[a-z0-9-]+$` на IPC-границе

### CRIT-11. Загрузка ВСЕХ блоков (включая body) через IPC
- **Файл:** `App.tsx:292`, `commands/blocks.rs`
- **Суть:** `listBlocks()` возвращает все блоки с полем `body: String`. При 10K блоков со статьями — 50-100 МБ JSON через IPC, хранящиеся в React-состоянии
- **Исправление:** `list_blocks` без `body`, отдельный `get_block` с `body` для Detail

### CRIT-12. `create_block` загружает ВСЕ блоки для проверки slug
- **Файл:** `commands/blocks.rs:62`
- **Суть:** `list_blocks()` → `HashSet<String>` вместо SQL-запроса
- **Исправление:** `SELECT slug FROM blocks WHERE slug LIKE ?1 || '%'`

### CRIT-13. `list_channel_previews` — O(N) блоков + O(N) syscall-ов
- **Файл:** `commands/channels.rs:237`
- **Суть:** загружает все блоки, затем `thumb_path.exists()` для каждого. 10K блоков = 10K syscall-ов на каждый `vault-changed`
- **Исправление:** `has_thumbnail BOOLEAN` в таблице `blocks`, запрос через SQL

### CRIT-14. Паника в потоке thumb-gen без catch_unwind
- **Файл:** `watcher/handler.rs`
- **Суть:** фоновый поток не обёрнут в `catch_unwind`. Паника теряет `on_thumbs_done` callback — фронтенд не получит `vault-changed`
- **Исправление:** `std::panic::catch_unwind` вокруг тела потока

## Новые высокие находки

### HIGH-21. SSRF — native host скачивает произвольные URL
- **Файл:** `bin/native_host.rs:270-284`
- **Суть:** `image_url` и inline-картинки из body передаются в `download_file()` без валидации схемы/IP. Можно обратиться к `169.254.169.254` (метаданные облака), `localhost` (локальные сервисы)
- **Исправление:** валидация схемы (только `https://`), запрет приватных IP

### HIGH-22. Deadlock risk — два мьютекса в initialize_vault
- **Файл:** `commands/vault.rs:133,143`
- **Суть:** `initialize_vault` блокирует `state.watcher` (строка 133), затем `state.vault_state` (строка 143). Обратный порядок в другом месте = deadlock
- **Исправление:** задокументировать порядок блокировки или объединить state

### HIGH-23. Mutex удерживается на время всего импорта
- **Файл:** `commands/import.rs:56`
- **Суть:** `vault_state.lock()` на протяжении HTTP-запросов + записи файлов + индексации. UI полностью заморожен на время импорта (минуты)
- **Исправление:** разбить на короткие блокировки, данные клонировать до релиза мьютекса

### HIGH-24. Нет тайм-аута чтения в ureq
- **Файл:** `bin/native_host.rs:426-435`
- **Суть:** `ureq::get(url).call()` без настройки тайм-аутов. Медленный сервер заблокирует native host навечно
- **Исправление:** `ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build()` + `take(MAX_SIZE)`

### HIGH-25. 9 IPC-вызовов без try/catch в App.tsx
- **Файл:** `App.tsx`
- **Суть:** `loadData`, `handleRenameTag`, `handleCreateChannel`, `handleReorderTag`, `handleCardDrop`, `handleToggleTag`, `handleCreateTagFromMenu`, `handleDeleteBlock` — ошибка бэкенда оставляет UI в неопределённом состоянии
- **Перекрытие:** подтверждает HIGH-11 из повторного аудита

### HIGH-26. Card не обёрнут в React.memo
- **Файл:** `Card.tsx`
- **Суть:** каждое изменение `focusedBlockId` перерисовывает все карточки в Grid
- **Исправление:** `React.memo` на `Card` + `useCallback` на `handleClick`/`handleKeyDown`

### HIGH-27. full_scan — 10K отдельных транзакций
- **Файл:** `watcher/handler.rs`
- **Суть:** каждый `upsert_block` создаёт свою транзакцию. 10K блоков = 10K fsync
- **Исправление:** одна транзакция на весь `full_scan`

### HIGH-28. IN-список с 10K параметров
- **Файл:** `storage/index.rs:403`
- **Суть:** `WHERE block_id IN (?,?,?,...,?)` с одним `?` на блок. При 10K может превысить `SQLITE_MAX_VARIABLE_NUMBER`
- **Исправление:** батчинг по 500-900 или временная таблица

### HIGH-29. Сломанная ссылка popup в контекстном меню
- **Файл:** `extension/background.js:49`
- **Суть:** `chrome.runtime.getURL("popup/popup.html")` — файл не существует (popup собран в `dist/index.html`)
- **Исправление:** `chrome.runtime.getURL("dist/index.html")`

### HIGH-30. ARCHITECTURE.md: SQLite-схема устарела
- **Файл:** `ARCHITECTURE.md`
- **Суть:** 8+ расхождений: `path` vs `slug`, отсутствуют `source`/`author`/`body`, `modified_at` vs `indexed_at`, `thumb_path` vs `thumbnail`, `target_path` vs `target_slug`, FTS5 без `content`/`content_rowid`
- **Исправление:** привести в соответствие с `db.rs`

### HIGH-31. Весь commands/ — 0 тестов (21 публичная функция)
- **Суть:** ни одна Tauri-команда не покрыта тестами. `create_block`, `rename_channel`, `rename_tag` содержат нетривиальную оркестрацию
- **Перекрытие:** подтверждает пробел из повторного аудита

## Новые средние находки

### MED-21. Бизнес-логика в commands/
- **Файлы:** `commands/blocks.rs` (`create_block`, `delete_block`), `commands/tags.rs` (все 4 функции), `commands/channels.rs` (`rename_channel`)
- **Суть:** полные workflows (read-modify-write-reindex) в тонком слое. PRINCIPLES.md: commands/ — только делегация
- **Исправление:** вынести в domain-сервисы

### MED-22. Прямой `std::fs::write` в commands/
- **Файлы:** `commands/tags.rs:52,79,121,155`, `commands/channels.rs:203`
- **Суть:** запись файлов напрямую, минуя `storage::files::write_block_file`
- **Исправление:** использовать `storage::files`

### MED-23. CommandError::Internal(String) — catch-all
- **Файл:** `commands/state.rs:47`
- **Суть:** все внутренние ошибки проходят через `format!("{:#}", e)` в строку. Теряется типизация
- **Перекрытие:** подтверждено архитектурным аудитом

### MED-24. ~~Дубликат `Sidebar.classic.tsx` + `ChannelIcon.classic.tsx`~~
- **Снято:** файлы намеренно сохранены для отдельного вида (альтернативный layout сайдбара)

### MED-25. ImportDialog никогда не открывается
- **Файл:** `App.tsx:169,649`
- **Суть:** `importOpen` инициализируется `false`, но `setImportOpen(true)` нигде не вызывается. Мёртвая функциональность
- **Исправление:** добавить триггер в UI или убрать

### MED-26. Закомментированный DropZone
- **Файл:** `App.tsx:71,644`
- **Суть:** импорт и использование закомментированы. PRINCIPLES.md запрещает закомментированный код
- **Исправление:** удалить или включить

### MED-27. Утечка таймера в Search.tsx
- **Файл:** `Search.tsx:31`
- **Суть:** debounce-таймер не очищается при unmount/закрытии компонента
- **Исправление:** cleanup `useEffect`

### MED-28. Оверлеи `bg-black/50` вместо токена `bg-glass`
- **Файлы:** `dialog.tsx:40`, `alert-dialog.tsx:37`
- **Суть:** DESIGN_SYSTEM.md определяет `--glass-bg`, но используется захардкоженный `bg-black/50`
- **Исправление:** заменить на `bg-glass`

### MED-29. LINK_COLORS нарушают монохром
- **Файл:** `Card.tsx:121-124`
- **Суть:** `bg-blue-900`, `bg-emerald-900` и т.д. — цветные фоны в монохромной палитре
- **Исправление:** заменить на оттенки серого или семантические токены

### MED-30. `cursor-pointer` отсутствует на Button
- **Файл:** `components/ui/button.tsx:8`
- **Суть:** DESIGN_SYSTEM.md: «Все кнопки: cursor-pointer»
- **Исправление:** добавить `cursor-pointer` в базовые стили

### MED-31. Нет busy_timeout в SQLite
- **Файл:** `storage/db.rs`
- **Суть:** watcher и основной поток используют отдельные соединения. Без `busy_timeout` запись может получить `SQLITE_BUSY`
- **Исправление:** `PRAGMA busy_timeout = 5000;`

### MED-32. Гонка: фоновый поток и watcher пишут один thumbnail
- **Файл:** `watcher/handler.rs`
- **Суть:** фоновый поток `thumb-gen` и watcher могут одновременно генерировать thumbnail для одного slug
- **Исправление:** атомарная запись (temp + rename) или проверка перед записью

### MED-33. 8 неиспользуемых CSS-токенов
- **Файл:** `styles/global.css`
- **Суть:** `chart-1..5`, `glass-bg`, `glass-border`, `sidebar-ring`, `sidebar-primary` и др. определены, но нигде не используются
- **Исправление:** удалить или начать использовать (glass-bg — см. MED-28)

### MED-34. `<all_urls>` загружает content scripts на каждой странице
- **Файл:** `extension/manifest.json:27`
- **Суть:** 4 скрипта (Readability, Turndown, content.js) внедряются на каждой вкладке
- **Исправление:** `chrome.scripting.executeScript()` по требованию

### MED-35. Нет валидации тега в native host create_channel
- **Файл:** `bin/native_host.rs:358`
- **Суть:** тег принимается без нормализации (пробелы, спецсимволы, пустая строка)
- **Исправление:** нормализация через `domain/tag.rs`

### MED-36. SPEC_DOMAIN.md: thumb_path `.webp` vs код `.jpg`
- **Файл:** `SPEC_DOMAIN.md`, `domain/vault.rs:68`
- **Суть:** документация говорит `.webp`, код возвращает `.jpg`
- **Исправление:** обновить SPEC_DOMAIN.md

### MED-37. Нет индекса на block_type
- **Файл:** `storage/db.rs`
- **Суть:** `search_blocks` фильтрует по `block_type` без индекса — full scan при 10K+
- **Исправление:** `CREATE INDEX idx_blocks_block_type ON blocks(block_type)`

### MED-38. `popup/_legacy/` — мёртвый код
- **Файлы:** `extension/popup/_legacy/popup.html`, `popup.js`, `popup.css`
- **Суть:** полная vanilla-JS реализация popup, не используется
- **Исправление:** удалить

### MED-39. Неиспользуемые экспорты в commands.ts
- **Файл:** `src/lib/commands.ts`
- **Суть:** `rebuildIndex`, `getBlock`, `createBlock`, `renameChannel` экспортируются, но не импортируются
- **Исправление:** удалить неиспользуемые или подключить

### MED-40. `dark:` модификаторы конфликтуют с dark-first стратегией
- **Файлы:** `badge.tsx`, `checkbox.tsx`, `context-menu.tsx`, `dropdown-menu.tsx`
- **Суть:** DESIGN_SYSTEM.md: «Тёмная тема по умолчанию — светлая через `prefers-color-scheme: light`». `dark:` классы работают в обратном направлении
- **Исправление:** проверить Tailwind-стратегию (`media` vs `class`) и привести в соответствие

## Обновлённое тестовое покрытие

### Текущее состояние: 200 Rust-тестов + 37 фронтенд-тестов = 237 всего

| Модуль | Тестов | Оценка |
|---|---|---|
| domain/block | 59 | Отлично |
| domain/tag | 17 | Хорошо |
| domain/channel | 20 | Хорошо |
| domain/vault | 14 | Хорошо |
| domain/search | 14 | Хорошо |
| storage/index | 25 | Среднее |
| storage/db | 13 | Среднее |
| storage/files | 8 | Слабо |
| storage/thumbnails | 7 | Слабо |
| watcher/handler | 10 | Среднее |
| watcher/events | 9 | Среднее |
| **watcher/watch** | **0** | **Нет тестов** |
| **commands/* (7 файлов)** | **0** | **Нет тестов** |
| **import/arena_api** | **0** | **Нет тестов** |
| import/importer | 4 | Слабо |
| **bin/native_host** | **0** | **Нет тестов** |
| **util.rs** | **0** | **Нет тестов** |
| Frontend (Card, Sidebar, Search, VaultPicker, assets) | 37 | Среднее |
| **App.tsx, Detail.tsx, Grid.tsx, DropZone.tsx, ImportDialog.tsx, CardContextMenu.tsx** | **0** | **Нет тестов** |

### Критические пробелы
1. `commands/*` — 0 тестов на 21 публичную функцию IPC-слоя
2. `import/arena_api.rs` — 0 тестов (4 pub fn)
3. `watcher/watch.rs` — 0 тестов
4. `util.rs` — 0 тестов (`days_to_ymd` — сложная математика)
5. Frontend: Detail.tsx, Grid.tsx, App.tsx, CardContextMenu.tsx — 0 тестов

## Что работает хорошо

1. **Границы слоёв безупречны** — domain/ не импортирует из storage/, commands/, watcher/. Подтверждено проверкой всех `use` в каждом .rs файле
2. **Ни одного TODO/FIXME/HACK** во всей кодовой базе
3. **Типизация через thiserror** — domain/ и storage/ используют типизированные ошибки
4. **Фоновая генерация миниатюр** с пропуском свежих (mtime check)
5. **Chunked rendering** в Grid.tsx — IntersectionObserver, 80+60 батчи
6. **Event delegation** — O(1) на ContextMenu вместо O(N)
7. **WAL-режим** + `foreign_keys = ON` в SQLite
8. **Параметризованные SQL-запросы** — ни одного SQL injection
9. **Нет `any`** в TypeScript-коде
10. **200 Rust-тестов** в domain/ и storage/ — эталонное покрытие бизнес-логики
