# Полный аудит проекта Local Arena

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
