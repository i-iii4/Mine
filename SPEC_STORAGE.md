# SPEC: storage layer

**Состояние:** реализовано. Источник: PLAN.md, Phase 3; абзац «Перечисленные правила реализованы в Rust» ниже. **Сверка с кодом:** 15.11.2026, существование названных файлов.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md) | [SPEC_SAVE_CORE.md](SPEC_SAVE_CORE.md)

Персистентный слой: SQLite-индекс, файловые операции, thumbnail-генерация.
Зависит от domain/ для типов. Не зависит от commands/ и watcher/.

Общие правила находятся в `mine-core`; `domain/` переэкспортирует их.
Native capture использует `storage/save_operations`: отдельный durable
журнал и блокировку по binding, без обязательного SQLite до source commit.
Desktop/CLI mutation rollback остаётся прежним. Нативные гарантии публикации
не распространяются на browser; [приёмка](docs/save-core-acceptance.md).

---

## storage/db

Управление SQLite-соединением и схемой.

### Функции

```rust
open_or_create(path: &Path) -> Result<Connection>   // открыть или создать БД
open_memory() -> Result<Connection>                  // для тестов
```

### Поколения и восстановление индекса

Общий выбор производной базы реализован в [db.rs](/Users/i_iii/Проекты/Личные проекты/local-arena/src-tauri/src/storage/db.rs). Приложение, CLI, нативный обработчик и FFI выбирают индекс через `resolve_vault_index` или `open_vault_index`, а не копируют прежнюю базу. Номер схемы принадлежит [migrations.rs](/Users/i_iii/Проекты/Личные проекты/local-arena/src-tauri/src/storage/migrations.rs). Чистый контракт `INDEX_GENERATION` находится в [vault.rs](/Users/i_iii/Проекты/Личные проекты/local-arena/src-tauri/src/domain/vault.rs): `schema-7-semantics-1` (с 11.10.2026: схема 7, таблица `vault_conflicts` по полному пути, SPEC_ICLOUD_CONFLICTS.md; до неё `schema-6-semantics-1`, столбцы связей карточек, SPEC_CARD_ASSOCIATIONS.md). Его совместимость определяется схемой и смыслом проекции, а не версией приложения. База другой версии схемы в выбранном поколении не мигрирует, а откладывается, и строится новая; поэтому каждое изменение схемы меняет и этот ключ: сборки разных схем не делят одно поколение и не откладывают базы друг друга.

```text
<derived_root>/indexes/schema-7-semantics-1/index.db
<derived_root>/indexes/schema-7-semantics-1/recovery-<slot>/index.db
```

После того как `open_vault_index` открыл текущее поколение, остальные поколения пространства (`indexes/<другое поколение>/`) удаляются целиком (SPEC_DEEP_AUDIT.md, Н14, Е5.14). Поколение остаётся, если им пользуется другой процесс: процесс, который выбирает или строит там базу, держит её `selection.lock` или `build.lock`, а процесс с открытой базой держит блокировку SQLite на байте 128 её файла общей памяти `-shm` (`UNIX_SHM_DMS`), и `fcntl(F_GETLK)` её видит. Сбой удаления пишется в журнал и оставляет поколение до следующего открытия. До 13.10.2026 каждое изменение схемы оставляло прежнее поколение навсегда, 150 МБ у одного пространства.

`active-slot` хранит номер выбранной базы. Межпроцессная `selection.lock` защищает выбор. База неподдерживаемой версии, несовместимой структуры или с обнаруженным повреждением остаётся на месте вместе с WAL и SHM. Общая старая база в корне производного хранилища и база внутри `.arena` не открываются ради миграции или копирования. Повреждённый указатель сохраняется отдельно, затем выбирается новый свободный номер. При выборе проверяются метаданные схемы, без полного `quick_check`. Проверка существующих отвергнутых баз ограничена 16 попытками.

`open_vault_index` проверяет фактическое чтение количества блоков. Последующие запросы используют `read_vault_projection`, `read_vault_projection_from` или `read_search_projection`. Только SQLite `CORRUPT` и `NOTADB` разрешают один повтор после чистой пересборки выбранной базы. Повторная ошибка возвращается вызывающему коду. Ошибки доступа, ввода и вывода, занятой базы и заполненного диска не запускают восстановление. Повтор чтения не повторяет сохранение, удаление, изменение исходных файлов или запись журналов. Поиск может обновлять только свои производные таблицы.

Владельцем активного соединения и наблюдателя остаётся [state.rs](/Users/i_iii/Проекты/Личные проекты/local-arena/src-tauri/src/commands/state.rs). Результат принимается только для того же корня пространства и актуальной базы. Подготовка нового соединения и наблюдателя происходит до короткой публикации состояния. Завершившийся запрос прежнего пространства не заменяет уже выбранное пространство. CLI и нативный обработчик владеют соединением отдельного запроса, FFI хранит выбранную базу вместе с соединением в одной сессии.

### Готовность пересборки

`index_build_state.ready` из схемы версии 5 становится `false` перед первой записью прохода в индекс: проход, которому нечего записывать, признак не трогает («Проход без изменений» ниже). Межпроцессная `build.lock` сериализует пересборку поколения. `ready=true` публикуется после прохода и повторной проверки метаданных и зависимостей исходных файлов; проход, который ничего не записал, сам и есть такая проверка. Готовность не зависит от одной заметки (SPEC_DEEP_AUDIT.md, Н6, Е5.1): проход, который не смог прочитать или спроецировать отдельные файлы, тоже публикует `ready=true`, отчёт перечисляет эти файлы (`errors`), а повторная проверка их не ждёт. До 13.10.2026 одна нечитаемая заметка держала `ready=false` навсегда: каждый следующий проход встречал её снова, и CLI с помощником клиппера видели неготовый индекс. Заметки, которые сверка в действии оставила непрочитанными, потому что их содержимое в iCloud, повторная проверка тоже не ждёт; такой проход публикует `ready=true`, только если индекс был готов до него (SPEC_CLOUD_STORAGE.md, Х12). Изменение исходников во время прохода требует нового прохода, максимум 3; затем возвращается `SourcesChanging`, и готовность становится такой, какой была до прохода. Прерванная работа остаётся незавершённой и продолжает использовать те же сохранённые состояния исходников после повторного открытия. Блокировки освобождаются ядром при завершении процесса, постоянные флаги блокировки не создаются.

Координатор свежести шлёт вкладкам пространства событие `vault-freshness-changed` (тип `VaultFreshnessChanged` в привязках Specta) со списком файлов с ошибкой (`error_files`: путь, вид ошибки, причина) и пишет их в журнал. Ведущая вкладка пространства называет эти файлы уведомлением `IndexErrorsNotice` (SPEC_DEEP_AUDIT.md, Е6.17, 13.10.2026): заголовок `Could not read 1 note` или `Could not read {N} notes`, строка `Mine shows the space without them.`, первые пять файлов строками `“{имя}”: {причина}` и `And {K} more.` за ними. Проход без ошибок убирает уведомление, проход, который не удался целиком, его не трогает, крестик прячет его до другого набора файлов.

### Проход без изменений (15.11.2026)

Решение по [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md), Б2 и Б3. Перед каждым действием пользователя и раз в 30 с в фоне идёт проход по всему пространству, и почти всегда он ничего не находит. Такой проход обходит дерево пространства один раз, сверяет метаданные каждой заметки и каждого файла, от которого она зависит, один раз и ничего не пишет в индекс. Правило Н5 ([SPEC_DEEP_AUDIT.md](SPEC_DEEP_AUDIT.md)) остаётся: проход перед действием идёт всегда, пропуска прохода нет. Период фонового прохода 30 с не меняется.

Что делает проход, которому нечего записывать:

1. Один обход дерева (`reconcile::inventory`) даёт оба списка: заметки и все файлы, которые заметка может назвать.
2. Для каждой заметки: отпечаток файла и отпечатки её зависимостей против сохранённых (`source_index_state`), вид строки индекса против сохранённого вида.
3. Имена страниц коллекций по списку файлов и сравнение с ними строк коллекций (`sweep_channels_without_documents` убирает строку без страницы, как прежде, на каждом проходе).
4. Если записывать нечего, проход кончается: без транзакции, без записи признака готовности, без проверки после прохода.

Чего такой проход больше не делает:

- **Проверка после прохода** (`source_inventory_matches`: второй обход дерева и второе чтение всех метаданных). Она отвечает на вопрос, совпадает ли сохранённое состояние с диском после записи прохода. Проход, который ничего не записал, только что ответил на тот же вопрос сам. Проверка идёт только после прохода, который записал в индекс. Это относится и к проходу, который не записал ничего, но оставил заметки с ошибкой или выгруженные заметки: остальные заметки он сверил сам, а эти проверка и раньше не ждала.
- **Признак готовности.** До 15.11.2026 каждый проход писал `ready=false` в начале и `ready=true` в конце. Теперь `ready=false` пишется перед первой записью прохода в индекс, а в конце признак пишется, только если он должен измениться. Проход, прерванный до первой записи (ошибка обхода, папка пространства пропала), оставляет признак таким, каким он был: индекс он не менял. Следствие: CLI и помощник клиппера, которые читают индекс только при `ready=true`, больше не получают «индекс не построен» на время каждого прохода без изменений.
- **Второй обход ради имён файлов.** До 15.11.2026 список заметок давал один обход, а список всех файлов для распознавания ссылок и имён коллекций второй; оба пропускали одни и те же папки. Теперь оба списка даёт один обход. Обход отказывает там же, где отказывал обход заметок: папка, которую не удалось прочитать, не должна читаться как удалённые заметки.
- **Построение индекса имён на каждом проходе.** Индекс имён всех файлов (`LinkIndex`) строится из списка за время, сравнимое с самим обходом. Процесс держит индекс последнего прохода по пространству (`reconcile::keep_files`) и берёт его снова, только если новый обход дал ровно те же файлы; иначе индекс строится из нового списка и заменяет прежний. Индекс, с которым проход распознаёт ссылки, и индекс, который остаётся после прохода, всегда построены из обхода этого прохода.
- **Отдельный обход ради заметок в iCloud.** Заметки, которые проходу надо прочитать и чьё содержимое в iCloud, проход находит в своём обходе: признак выгрузки читается только у новых и изменившихся заметок. Если такие есть у готового индекса, проход отпускает индекс, скачивает их и начинает заново (Х12, Х24). До 15.11.2026 их искал отдельный обход с чтением признака у каждой заметки перед каждым фоновым проходом.

Проход, который записывает, дальше идёт по-прежнему: одна транзакция, проверка после прохода со своим обходом заметок, не больше трёх проходов.

Предел: проход перед действием и фоновый проход по пространству из 10 000 заметок без изменений не дольше 100 мс в сборке, оптимизированной как приложение. Проверки: `a_pass_over_10_000_unchanged_notes_answers_within_its_limit` (`storage/reconcile.rs`, запускает `bun run test:rust-speed`); `a_pass_that_finds_nothing_walks_the_space_once_and_writes_nothing`, `the_walk_of_a_pass_lists_what_the_two_walks_listed`, `a_pass_keeps_the_index_of_names_only_of_the_files_it_listed`, `a_pass_walks_the_space_once_however_many_notes_it_indexes`, `a_pass_that_finds_nothing_makes_an_unready_index_ready`, `a_pass_that_finds_nothing_is_not_checked_against_the_files_again`, `a_pass_that_writes_is_checked_against_the_files_again`, `a_failed_inventory_leaves_readiness_as_it_was`, `a_collection_row_without_a_page_is_swept_by_a_pass_that_reads_no_note`, `a_background_pass_brings_a_note_in_icloud_down_and_reads_it` (`storage/reconcile.rs`); распознаватель от готового индекса отвечает так же, как от собственного обхода: `a_resolver_over_a_ready_index_answers_as_one_that_walked` (`storage/media_refs.rs`); действие не ждёт за загрузкой фонового прохода: `an_action_does_not_wait_behind_a_pass_waiting_for_a_download` (`commands/blocks.rs`).

Перечисленные правила реализованы в Rust. Они не подтверждают приёмку интерфейса, установленных версий, холодного запуска или принудительного завершения на каждой фазе. Критерии остаются в [SPEC_SYSTEM_RELIABILITY.md](/Users/i_iii/Проекты/Личные проекты/local-arena/SPEC_SYSTEM_RELIABILITY.md). Журналы и история не считаются кэшем.

### Схема

```sql
-- Блоки
CREATE TABLE blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    block_type TEXT NOT NULL, -- legacy frontmatter.type
    card_kind TEXT NOT NULL DEFAULT 'media', -- derived runtime kind: article/media/link/channel
    title TEXT, -- legacy frontmatter.title only; new writes do not synthesize it
    description TEXT,
    url TEXT,
    media_file TEXT,
    thumbnail TEXT,
    saved_at TEXT NOT NULL,
    source TEXT,
    width INTEGER,
    height INTEGER,
    author TEXT,
    body TEXT DEFAULT '',
    preview_text TEXT,
    preview_text_cap INTEGER,
    preview_manifest TEXT,
    feed_playback TEXT,
    related_notes TEXT,
    thumb_format TEXT, -- derived thumb content: jpeg/png, NULL means no confirmed thumb
    thumb_mtime INTEGER, -- derived thumb mtime, NULL means no confirmed thumb
    media_index_version INTEGER,
    body_hash TEXT,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Связи карточек, схема 6 (SPEC_CARD_ASSOCIATIONS.md, «Модель данных»):
    -- выводятся из строки и её исходной, в файлы не пишутся.
    note_name TEXT,                  -- последний сегмент пути, ключ поиска исходной
    extraction_source_name TEXT,     -- имя исходной у вытащенной карточки
    association_author TEXT,         -- автор как написан: свой или унаследованный
    association_author_key TEXT,     -- ключ автора (NFC, нижний регистр)
    association_site TEXT,           -- хост без www., не площадка и не прямой файл
    association_address TEXT,        -- адрес без www., якоря и utm_*
    association_index_version INTEGER
);

-- Теги
CREATE TABLE block_tags (
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (block_id, tag)
);
CREATE INDEX idx_block_tags_tag ON block_tags(tag);

-- Каналы
CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    color TEXT,
    icon TEXT,
    position INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

-- FTS5
CREATE VIRTUAL TABLE blocks_fts USING fts5(title, description, body);

-- Wikilinks
CREATE TABLE wikilinks (
    source_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_slug TEXT NOT NULL,
    PRIMARY KEY (source_id, target_slug)
);

-- Filesystem freshness state shared by cards and collection pages.
CREATE TABLE source_index_state (
    slug TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL, -- block | channel
    source_stamp TEXT NOT NULL, -- JSON SourceStamp
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- schema 9: the names of the files each note depends on.
CREATE TABLE source_dependency_names (
    name TEXT NOT NULL, -- last part of a recorded dependency: Unicode composed, lower case
    slug TEXT NOT NULL, -- the note, as in source_index_state
    PRIMARY KEY (name, slug)
) WITHOUT ROWID;
CREATE INDEX idx_source_dependency_names_slug ON source_dependency_names(slug);

-- schema 10: the feed's order, one index for each direction («Страница ленты по ключу»).
CREATE INDEX idx_blocks_feed_newest ON blocks(saved_at DESC, slug COLLATE NOCASE, slug)
    WHERE card_kind != 'channel';
CREATE INDEX idx_blocks_feed_oldest ON blocks(saved_at, slug COLLATE NOCASE, slug)
    WHERE card_kind != 'channel';
CREATE INDEX idx_blocks_author_feed_newest
    ON blocks(association_author_key, saved_at DESC, slug COLLATE NOCASE, slug)
    WHERE card_kind != 'channel' AND association_author_key IS NOT NULL;
CREATE INDEX idx_blocks_author_feed_oldest
    ON blocks(association_author_key, saved_at, slug COLLATE NOCASE, slug)
    WHERE card_kind != 'channel' AND association_author_key IS NOT NULL;
-- schema 10: a collection's page found by the path a link may name it by.
CREATE INDEX idx_channels_source_slug ON channels(source_slug);
```

Таблица `source_dependency_names` (схема 9, 16.11.2026) отвечает на вопрос «какие заметки называют файл с таким именем» одним поиском по ключу, без чтения всех отпечатков: это поиск точного перечитывания ([SPEC_INTEGRATION.md](SPEC_INTEGRATION.md), «Точное перечитывание»), и его цена не растёт с числом заметок. Правила:

- Имя это последняя часть пути записанной зависимости, приведённая к составной форме Unicode и нижнему регистру (`reconcile::name_key`). Если в последней части есть процентная запись, записывается и раскодированное имя: ссылка `![](my%20photo.jpg)` называет файл `my photo.jpg`.
- Строки заметки пишет тот же код, что пишет её отпечаток (`reconcile::write_source_state`), в той же транзакции. Другого писателя нет.
- Таблица не может пережить отпечаток: триггеры `source_dependency_names_ad` и `source_dependency_names_au` убирают имена заметки, когда строка `source_index_state` удалена или её отпечаток либо путь изменён. После изменения отпечатка имена пишутся заново.
- Миграция на схему 9 очищает `source_index_state`: в отпечатках прежних версий имён нет, и следующий проход читает каждую заметку заново, как при постройке нового поколения индекса. Приложение при смене версии схемы и так строит индекс заново в новом поколении (`compatible_slot`), поэтому очистка касается только базы, открытой по пути напрямую.

FTS5 синхронизируется через триггеры (INSERT/DELETE/UPDATE на blocks) и
остаётся текущим lexical backend. Целевой Search contract добавляет
rebuildable derived stores для alias/transliteration и semantic chunks/
embeddings в local app data store; пользовательские `.md` файлы не
переписываются ради поиска.
Every read-write `open_or_create` runs schema/trigger migration inside one
`BEGIN IMMEDIATE` transaction. Concurrent startup workers or native-host/app
connections wait on SQLite's busy timeout instead of interleaving
`DROP TRIGGER` / `CREATE TRIGGER`; a failed migration rolls back before the
connection is returned.

### Versioned migration contract

- `PRAGMA user_version` is the only authoritative schema version. The current
  version is owned by `storage/migrations.rs`; `storage/db.rs` owns connection
  pragmas and delegates all schema evolution to that module.
- An unversioned legacy database is version `0`. Migrations run strictly in
  sequence (`V0 -> V1 -> V2`) under one `BEGIN IMMEDIATE` transaction and
  persist `user_version` after every successful step.
- Every open validates required tables, typed columns, indexes, triggers and
  singleton rows after migration. A future version or incompatible drift is an
  explicit error; it is never interpreted as an already-applied migration.
- No `ALTER TABLE` error may be discarded. On any migration or validation
  failure the transaction rolls back, including the schema version update.
- Upgrade tests cover fresh creation, representative unversioned data, V1
  search data, malformed legacy schema, future versions and concurrent opens.
`title` in the physical schema is legacy metadata. The body column carries
Markdown H1 text, so search still sees new content headings without storing a
generated `frontmatter.title`.

Surface Search query terms are escaped and sent to FTS5 as prefix tokens, e.g.
`mem` becomes `"mem"*`, so incremental typing finds `memory` without requiring
the full token.

Target hybrid search derived tables/indexes:

```sql
CREATE TABLE search_document_state (
    block_id INTEGER PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    source_stamp TEXT                 -- schema 8: the card fields the document was built from
);

CREATE TABLE search_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    field TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(block_id, field, chunk_index)
);

CREATE TABLE search_embeddings (
    chunk_id INTEGER NOT NULL REFERENCES search_chunks(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(chunk_id, model_id)
);

-- Schema 8 (15.11.2026, SPEC_SEARCH.md, «Устройство поиска на большом
-- пространстве»): the dictionary of the words the chunks hold, the chunks of
-- each word, and the words of the author and address chunks. Both FTS5
-- tables keep no content; their rowid is the chunk's id.
CREATE TABLE search_words (
    chars INTEGER NOT NULL,
    word TEXT NOT NULL,
    PRIMARY KEY (chars, word)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE search_word_chunks USING fts5(
    words, content='', contentless_delete=1, detail=none, tokenize='ascii'
);
CREATE VIRTUAL TABLE search_metadata_terms USING fts5(
    terms, content='', contentless_delete=1, detail=none, tokenize='ascii'
);
```

Schema 8 also adds `search_state.source_revision` and
`search_state.synced_source_revision` and the triggers `search_chunk_terms_ad`,
`search_source_ai` and `search_source_au`; what they mean is said in
[SPEC_SEARCH.md](SPEC_SEARCH.md), «Отметка документа» and «Словарь слов».

### Прагмы

- `PRAGMA journal_mode = WAL;` — параллельные чтения
- `PRAGMA foreign_keys = ON;` — каскадное удаление
- `PRAGMA busy_timeout = 5000;` — bounded wait вместо immediate SQLITE_BUSY

---

## storage/index

Индексирование блоков в SQLite. Преобразование domain::Block в строки БД.

### Типы

```rust
struct IndexedBlock {
    id: i64,
    slug: String,
    block_type: BlockType, // legacy frontmatter.type
    card_kind: CardKind, // derived source of truth for feed/detail/search
    title: Option<String>, // legacy frontmatter.title
    content_heading: Option<String>, // first body H1
    display_title: Option<String>, // content_heading, then legacy title
    fallback_label: String, // filename stem/media filename for utility surfaces
    description: Option<String>,
    url: Option<String>,
    media_file: Option<String>, // normalized from frontmatter.file wikilink/raw value
    thumbnail: Option<String>,
    saved_at: String,
    source: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    author: Option<String>,
    body: String,
    tags: Vec<String>,
}

/// Облегчённый блок для списков — без description и source.
/// `preview_text` — indexed read-model for feed cards: Markdown stripped,
/// whitespace normalized, and truncated on a word boundary to a backend
/// buffer, not to the final visual card height. `preview_text_cap` stores the
/// buffer version used to build it, so startup backfill can rebuild stale
/// rows exactly once after the cap changes. `body` remains a small legacy
/// excerpt for media fallback/detail lazy-load heuristics.
struct LightBlock {
    id: i64,
    slug: String,
    block_type: BlockType, // legacy frontmatter.type
    card_kind: CardKind, // derived source of truth for feed/detail/search
    title: Option<String>, // legacy frontmatter.title
    content_heading: Option<String>,
    display_title: Option<String>,
    fallback_label: String,
    url: Option<String>,
    media_file: Option<String>, // normalized from frontmatter.file wikilink/raw value
    thumbnail: Option<String>,
    saved_at: String,
    width: Option<u32>,
    height: Option<u32>,
    author: Option<String>,
    body: String,
    preview_text: Option<String>,
    first_image: Option<String>,
    media_urls: Option<String>,
    media_dimensions: Option<String>,
    preview_manifest: Option<String>,
    feed_playback: Option<String>,
    content_in_cloud: bool,   // SPEC_CLOUD_STORAGE.md, Х5 и Х6
    preview_unreadable: bool, // SPEC_CARD_MEDIA_GEOMETRY.md
    collections: Vec<String>, // membership refs in sidebar order
    search_match: Option<SearchMatch>,
}

struct TagCount {
    tag: String,
    count: usize,
}
```

`collections` несёт коллекции карточки так, как их хранит таблица связей
(`block_tags.tag`, те же ссылки, что `TagCount::tag` и текущая коллекция
маршрута), в порядке бокового меню: по `channels.position`, затем по имени в
байтовом порядке SQLite. В список входят только коллекции со страницей:
ссылка на имя без страницы в строку ленты не попадает (решение пользователя
10.10.2026, [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md),
К9; реализовано 10.10.2026, Phase 44). Каждый
запрос `LightBlock` собирает их одним коррелированным подзапросом
`json_group_array` (`collections_column_sql` в
[block_queries.rs](src-tauri/src/storage/block_queries.rs)), поэтому страница
ленты остаётся одним запросом, без запроса на карточку. Колонка читается по
имени `collections`, не по позиции. Значение, которое не разбирается как
массив JSON, это ошибка запроса, а не карточка без коллекций. Строка ленты
несёт коллекции, потому что ряд коллекций входит в карточку
([SPEC_CARD_STATES.md](SPEC_CARD_STATES.md), С8.9). Фронтенд сравнивает
строки ленты с учётом `collections`, `content_in_cloud` и
`preview_unreadable` (`lightBlockContentEqual` в `src/lib/blockIdentity.ts`),
поэтому присоединение карточки сразу обновляет её ряд.

`preview_text_cap` is currently `768` characters. The number is derived from
the frontend's widest single-column article card: 8 preview lines × ~478px
inner text width ÷ conservative ~5px average glyph width. The indexed value is
a bounded buffer for layout and IPC, while CSS line-clamp remains the final
visual cutoff.

`media_index_version` is the version marker for media-derived read-model
columns (`first_image`, `media_urls`, `media_dimensions`, `preview_manifest`,
`feed_playback`). When Obsidian embed resolution changes, startup backfill
rebuilds those cached columns from `body` and `media_file` without rewriting
source Markdown. Bulk backfill uses a cached basename resolver so vault-wide
attachment lookup is built once per pass, not once per note.

## storage/cloud_files: файл в iCloud

Одно правило (SPEC_DEEP_AUDIT.md, Н7, Е5.2) для всех, кто спрашивает о файле
iCloud: сверка, проход превью, метка `In iCloud`, процент загрузки, страж
корня, проверка конфликтов.

- `is_content_offloaded(path)`: содержимого файла нет на этом Маке. Признак
  это флаг `SF_DATALESS` (`0x40000000` в `st_flags`), который ядро ставит на
  файл-заглушку (`ls -lO` показывает `dataless`). Чтение флага это `stat`, файл
  не скачивается. Разреженный локальный файл (полный размер, ноль блоков)
  флага не несёт и выгруженным не считается.
- `is_icloud_item(path)`: файл или папку хранит iCloud
  (`NSFileManager isUbiquitousItemAtURL`): iCloud Drive и синхронизируемые им
  папки Desktop и Documents.

Путь файла ничего не доказывает. До 13.10.2026 оба признака брались из пути
через `Mobile Documents`, и у пространства на рабочем столе iCloud
(`~/Desktop/Тест`, заметки `compressed,dataless`) каждая выгруженная заметка
читалась с загрузкой.

- `read_contents(path)`: чтение служебного файла пространства (`.mine/layout.json`,
  `.mine/vault-id`). Кто не должен ждать, сначала спрашивает
  `is_content_offloaded`.
- `open(path)`, `read(path)`, `read_to_string(path)`: одна дверь каждого
  чтения файла пространства, то есть заметок (`files::read_block_file`,
  история переименований), медиа для превью и размеров (`thumbnails`,
  `media_dimensions`, `files::image_type`) и протокола `asset`
  (17.11.2026). В выпускной сборке это `std::fs`.
- `is_refusal(error)`: чтение отказано, потому что содержимое в iCloud и это
  чтение не может его скачать (`EDEADLK`). Это состояние файла, а не
  повреждение ([SPEC_CLOUD_STORAGE.md](SPEC_CLOUD_STORAGE.md), «Отказ
  чтения», О2).
- `let_reads_bring_contents_down()`: приложение при запуске разрешает своему
  процессу скачивать содержимое при чтении (`setiopolicy_np`, О1).

Флаг ставит только ядро, поэтому тесты не могут сделать выгруженный файл.
Сборка без оптимизаций (`debug_assertions`) несёт `cloud_files::test_seam`:
тест называет файлы, которые стоят за выгруженные, и каждое чтение такого
файла через дверь выше считается, так что файл, который нельзя было
скачивать, виден в счёте. Счётное чтение скачивает файл, как на Маке, где
процессу разрешено скачивание: дальше он локальный. Файл, отмеченный
`refuse_reads_of`, отвечает на каждое чтение тем же отказом, что macOS даёт
процессу без такого разрешения (`EDEADLK`), и остаётся выгруженным до
`mark_downloaded`. Тест может задержать чтения одного файла
(`hold_reads_of`), как их держит долгая загрузка. В выпускной сборке этого
кода нет.

## storage/reconcile: видимость файлов

Общий алгоритм находится в [reconcile.rs](/Users/i_iii/Проекты/Личные проекты/local-arena/src-tauri/src/storage/reconcile.rs). `reconcile_vault` и `reconcile_vault_with_progress` пересобирают только производный индекс. Они не записывают историю, не исправляют ссылки в Markdown и не изменяют медиа. Чистая пересборка используется при восстановлении повреждённой базы и первом чтении CLI или нативного обработчика.

`reconcile_runtime_vault_with_progress` сначала проверяет доступность исходников, затем отдельно согласует вспомогательную историю и подтверждённые внешние переименования. История лежит в производном хранилище этого Мака (`file-identity.json` рядом с `indexes/`), а не в пространстве (SPEC_IDENTITY_ROBUSTNESS.md, «История переименований на этом Маке»); её сбой пишется в журнал (`log::warn!`) и чтения не останавливает. Этот этап работает и для перемещения при выключенном приложении, независимо от поколения индекса. Повтор после повреждения SQLite выполняет только чистую пересборку, не повторяет исправление исходников. Неподдерживаемая или повреждённая история сохраняется без перезаписи; отсутствие пригодной истории не блокирует чтение документов.

Первое поколение приложения ожидает согласование исходников. При наличии готового снимка последующие чтения используют его сразу, а загрязнение или проверка по сроку запускают один фоновый проход через [freshness.rs](/Users/i_iii/Проекты/Личные проекты/local-arena/src-tauri/src/commands/freshness.rs). Те же сохранённые метаданные исходников определяют обновление производных превью.

`reconcile_vault_for_action` приводит индекс к файлам перед действием пользователя (удаление с медиа, переименование, склейка, действия с медиафайлом, сироты, переименование и удаление коллекции, те же команды CLI) и никогда не ждёт iCloud (SPEC_CLOUD_STORAGE.md, Х12; SPEC_DEEP_AUDIT.md, Е5.18). Заметку, которую проходу надо прочитать (новую для индекса, изменившуюся по штампу или по зависимости), но чьё содержимое в iCloud, он не читает: она остаётся в индексе такой, какой была, попадает в `ActionReconcile.deferred`, и iCloud просят её скачать. Её читает следующий фоновый проход: наблюдатель, проверка по сроку координатора свежести, открытие пространства. Остальные проходы (`reconcile_vault`, `reconcile_vault_with_progress`, `reconcile_runtime_vault_with_progress`) по уже готовому индексу скачивают такие заметки, не держа `build.lock`. Проход находит их в своём обходе по метаданным, ничего не читая и не записывая, отпускает индекс, просит iCloud о всех сразу и дожидается каждой, затем занимает индекс снова и читает их с этого Мака. Заметку, которую загрузка не принесла (чтение отказано, `EDEADLK`, или содержимое не приехало), этот проход оставляет в индексе такой, какой она была, без ошибки чтения, как сверка в действии (SPEC_CLOUD_STORAGE.md, «Отказ чтения», О3). Действие, пришедшее за это время, не ждёт загрузки за фоновым проходом. До 15.11.2026 такие заметки искал отдельный обход пространства перед каждым проходом, были они или нет («Проход без изменений» ниже). Первая сборка индекса (индекс не готов) читает заметки внутри прохода под своим ходом (SPEC_ONBOARDING.md, О13).

Страж корня (`root_guard::root_state`) не читает выгруженный `.mine/vault-id`: папку, которую производное хранилище обслуживало последней (`owner-path.json`), он считает пространством, другую папку с выгруженной идентичностью считает пропавшей.

`VaultReconciler` is the only storage primitive allowed to claim that the local
derived index reflects the current source vault. It compares a metadata-only
filesystem inventory with persisted `SourceStamp` values and performs an
incremental transaction. `full_scan` and route catch-up must delegate to this
primitive instead of maintaining two reconciliation algorithms.

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    mtime_ns: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DependencyStamp {
    vault_relative_path: String,
    file: Option<FileStamp>, // None means the referenced file is missing
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SourceStamp {
    markdown: FileStamp,
    dependencies: Vec<DependencyStamp>, // sorted, unique, vault-relative
}

struct ReconcileReport {
    inventory_markdown: usize,
    unchanged: usize,
    upserted: Vec<String>,
    removed: Vec<String>,
    dependency_changed: Vec<String>,
    errors: Vec<ReconcileFileError>,
    content_reads: usize,
    database_writes: usize,
    elapsed_ms: u64,
}

fn reconcile_vault(
    conn: &Connection,
    vault: &VaultLayout,
) -> Result<ReconcileReport, ReconcileError>;

struct ActionReconcile {
    report: ReconcileReport,
    deferred: Vec<PathBuf>, // notes left unread: their contents are in iCloud
}

fn reconcile_vault_for_action(
    conn: &Connection,
    vault: &VaultLayout,
) -> Result<ActionReconcile, ReconcileError>;
```

### Source stamp rules

- Markdown stamp is `mtime_ns + size`; content hashing is not part of the warm
  inventory path.
- Dependencies are every resolved local source asset that can affect card
  projection or derived previews: canonical `file`, thumbnail source, body
  embeds and ordered `media_urls` sources.
- Dependency paths are normalized vault-relative paths. Absolute paths,
  symlink escapes and service directories are rejected.
- An unchanged Markdown stamp permits dependency comparison without reading or
  parsing Markdown because the previous dependency list is persisted inside
  `source_stamp`.
- A changed/missing stamp reparses only that source file, recomputes its
  dependencies and updates index/search projection in the same transaction.
- A missing `.md` removes the corresponding block/channel row and rebuildable
  derived artifacts. User media is never deleted by reconciliation.
- A malformed file does not make the report `fresh`: the last-good row is
  retained for recovery, the report carries a typed file error and the
  coordinator publishes `degraded` with the list of such files
  (`error_files`). The index is still published ready (SPEC_DEEP_AUDIT.md,
  Н6): the report is diagnostic and must not prevent unrelated route rows from
  being returned or the CLI and the clipper helper from reading the index.

### Error contract

```rust
enum ReconcileError {
    Inventory { path: PathBuf, source: anyhow::Error },
    State(anyhow::Error),
    Commit(anyhow::Error),
    SourcesChanging { path: PathBuf },
}

enum ReconcileFileErrorKind {
    Metadata,
    Read,
    Parse,
    Index,
    DependencyOutsideVault,
}
```

Fatal inventory/database errors roll back the pass. Per-file errors are
collected, do not prevent unrelated valid files from being reconciled, and
prevent a false `fresh` state.

### Performance budgets

- Complexity: `O(N + D)` metadata calls for `N` Markdown files and persisted
  dependency entries, and `O(delta)` content reads/parses/upserts.
* Неизменившийся проход не читает содержимое Markdown или медиа и не обновляет строки проекции. Записи маркера готовности выполняются отдельно и не входят в счётчик `database_writes`.
- Eight concurrent route-facing reads for one vault produce one inventory pass,
  not eight passes.
- One hundred sequential route reads on a clean coordinator generation produce
  zero additional inventory passes. A safety audit may run in the background,
  but no search keystroke waits for it.
- Release benchmark on the reference Apple Silicon machine: 10,000 unchanged
  Markdown entries complete in at most 500 ms; 100 changed notes in at most
  2,000 ms, excluding asynchronous thumbnail encoding.
- The report exposes counters and elapsed time so these budgets are assertions,
  not comments.
- Один обход файлов пространства на проход (01.10.2026). Ссылки заметок на
  медиа и коллекции разрешаются через один `MediaResolver` на проход
  индексации и один на проход превью: список файлов строится один раз при
  первом поиске. Раньше каждая ссылка заново обходила всё пространство, и
  первая индексация 673 заметок с 1229 медиафайлами в iCloud шла минутами.
  Снимок списка верен в пределах прохода: проход сверяет инвентарь и
  повторяется до трёх раз, а файл, появившийся во время прохода, подхватывает
  наблюдатель следующим проходом. Тесты считают обходы.

## storage/projection — committed generation contract

`FreshnessCoordinator::generation` identifies reconciliation work. It is not a
read-model identity and must never be used by the frontend as one. SQLite owns a
separate persisted `projection_generation` that identifies the exact committed
state visible to route reads.

```rust
struct ProjectionRevision(u64);

struct GridSnapshot {
    generation: ProjectionRevision,
    blocks: Vec<LightBlock>,
    total_blocks: usize,
    has_more: bool,
}

fn read_grid_snapshot(
    conn: &Connection,
    location: &TabLocation,
    after: Option<&FeedPageToken>, // «Страница ленты по ключу»
    limit: usize,
    order: FeedOrder,
) -> Result<GridSnapshot>;
```

Rules:

- `blocks`, `channels`, `block_tags`, `source_index_state` and every
  preview/thumbnail column stored on a block are projection inputs.
  Insert/update/delete advances one monotonic SQLite generation inside the same
  transaction as that write. Multiple row writes in one source transaction may
  advance it more than once; only ordering and atomic visibility are semantic.
- Grid, taxonomy, sidebar previews and Graph expose the same typed
  `ProjectionRevision`. Each DTO reads its revision and all dependent queries
  through `read_projection_snapshot` inside one SQLite savepoint. A concurrent
  writer is therefore observed either entirely before or entirely after the
  snapshot, never between its fields.
- A preview manifest is route-visible when `preview_state = ready`, and also
  when it is `stale` with a non-null `preview_source_stamp`. The second case is
  a preview that exists on disk and is merely marked for recomputation: every
  write to a block marks it, including one that edited only frontmatter tags,
  and the source stamp covers the whole `.md`. Withholding it turned connecting
  a card to a collection into minutes of a missing video, because the card fell
  back to text until the preview queue reached it. The cost of serving it is a
  poster one generation behind until reconciliation replaces it.
- A `stale` preview with a null stamp was never generated, so nothing exists to
  draw; it stays withheld, as do `missing` and `failed`. The stamp is what tells
  "not built yet" apart from "built, worth rechecking".
- Progressive preview batches are separate committed generations. The UI may
  replace generation `N` with `N + 1` and must not apply an older response
  after a newer one. Since 15.11.2026 the feed list of a page is no longer one
  generation: it is a full read kept current by partial reads of named cards
  (see «Частичное чтение ленты» below), and its generation is the newest
  generation any applied read was made at.
- Generation zero is a valid empty/new database snapshot. Generation identity
  is scoped to one vault-derived database; changing vault remounts the frontend
  owner and resets its accepted generation.
- Search carries the same projection revision and preview publication
  predicate, but has its own snapshot and independent search revision below.

### Частичное чтение ленты

Решение 15.11.2026 (`AUDIT_PERFORMANCE.md`, Л3, пункт 10 плана). Вкладка,
которая знает, какие карточки изменились (SPEC_INTEGRATION.md, «Список
изменённых карточек»), читает только их строки и их места в ленте.

```rust
/// The named cards as the feed of a place holds them now.
struct FeedPatch {
    path: String,
    generation: ProjectionRevision,
    /// The named cards that stand in the feed within the page's range, in
    /// feed order.
    rows: Vec<FeedPatchRow>,
    total_blocks: usize,
    /// Whether the feed holds cards after the page's range.
    has_more: bool,
    /// The page's last card is not in the feed: the range cannot be told.
    range_lost: bool,
}

struct FeedPatchRow {
    block: LightBlock,
    /// `blocks.id` of the nearest card before this one in the feed that is
    /// not among the named cards; `None` when no such card stands before it.
    after: Option<i64>,
}

fn read_feed_patch(
    conn: &Connection,
    path: String,
    location: &TabLocation,
    order: FeedOrder,
    cards: &[i64],
    end: Option<i64>,
) -> Result<FeedPatch>;
```

Правила:

- `cards` это идентификаторы (`blocks.id`) названных карточек. Карточки,
  которой больше нет или которая в ленту места не входит, в `rows` нет:
  страница убирает её из списка.
- `end` задаёт, докуда страница держит ленту. `None`: страница держит ленту
  места целиком, и в `rows` входят все названные карточки ленты. Иначе `end`
  это последняя карточка списка страницы, не входящая в `cards`; в `rows`
  входят названные карточки, стоящие раньше первой карточки ленты после
  `end`, которая не названа. Названные карточки сразу за `end` поэтому
  остаются в списке, а не уходят до следующей страницы.
- `has_more`: есть ли в ленте неназванная карточка после `end`; при `end =
  None` всегда `false`.
- `range_lost`: `end` в ленте места нет (карточку убрало изменение, о котором
  страница ещё не знает). `rows` пуст, страница читает ленту целиком.
- Порядок и принадлежность ленте считает тот же SQL, что у полного чтения
  (`FeedOrder::order_by`, условие места из `grid_filter_sql`), а строки
  собирает та же модель (`grid_row_columns_sql`). Страница порядок не
  вычисляет: она ставит каждую строку после карточки `after`.
- Поколение, строки, счётчик и границы читаются под одним снимком
  (`read_projection_snapshot`).

**Частичное чтение равно полному.** Условие пользователя 15.11.2026. Для
списка страницы, который до изменения был началом ленты места, список после
частичного чтения равен началу ленты той же длины, которое вернуло бы полное
чтение в тот же момент: те же карточки в том же порядке с теми же полями,
тот же `has_more` и тот же `total_blocks`. Тест
`partial_read_gives_the_feed_a_full_read_gives` в `block_queries.rs`
проверяет это для каждого вида изменения: подключение и отключение коллекции
в Everything, в ленте этой коллекции и в ленте автора; создание карточки;
удаление одной и нескольких; переименование со сменой места среди карточек с
равной датой; слияние (исходные убраны, слитая создана); изменение даты
сохранения; появление страницы коллекции; оба порядка ленты; список, который
держит ленту целиком и только её начало; названная карточка на границе
списка.

**Замер частичного чтения.** 15.11.2026, сборка с оптимизацией, 10 000
карточек с текстом и 100 коллекций в памяти, страница держит 7 000 из них,
названные карточки разложены по всей загруженной части равномерно; время
чтения вместе с JSON для страницы, медиана из 9, нагрузка машины 5:

| Названо карточек | Время | Размер ответа |
|---|---|---|
| 1 | 0,29 мс | 1,7 КБ |
| 10 | 0,36 мс | 15 КБ |
| 100 | 1,7 мс | 155 КБ |
| 500 | 7,4 мс | 0,78 МБ |
| 2 000 | 30 мс | 3,1 МБ |

Полное чтение тех же 7 000 карточек в том же прогоне: 339 мс и 10,6 МБ
(один прогон, без прогрева).

Отсюда предел списка `FEED_CHANGE_LIMIT = 500`
([SPEC_INTEGRATION.md](SPEC_INTEGRATION.md), «Список изменённых карточек»):
500 названных карточек читаются за 7,4 мс, седьмая часть 50 мс, за которые
лента должна показать изменение (`AUDIT_PERFORMANCE.md`, пункт 10 плана);
2 000 карточек занимают 30 мс и оставляют странице меньше половины этого
времени. Тест скорости `a_partial_read_of_a_deep_feed_answers_within_its_limit`
(`#[ignore]`, `bun run test:rust-speed`): чтение одной карточки и 500 карточек
не дольше 20 мс; остальные 30 мс из 50 принадлежат странице.

### Страница ленты по ключу

Решение 15.11.2026 (`AUDIT_PERFORMANCE.md`, Л4, пункт 7 плана). До него
страница ленты читалась по смещению (`LIMIT ? OFFSET ?`): SQLite проходил всю
таблицу и сортировал её для каждой страницы, средняя страница при 7 000
карточек стоила 110–118 мс, при 30 000 больше секунды.

```rust
/// Where a feed page starts: after the card with this place in the order.
struct FeedPageToken {
    saved_at: String,
    slug: String,
}
```

- Страница читается после карточки, а не по её номеру: `list_grid_blocks`
  принимает `after: Option<FeedPageToken>` вместо `offset`. `None` читает
  ленту с первой карточки. Токен это место последней карточки списка
  страницы в порядке ленты: её `saved_at` и `slug`. Страница берёт оба поля
  из строки карточки и ничего не вычисляет.
- Токен называет место, а не строку: карточка токена может быть уже удалена,
  страница после её места читается так же.
- Условие «после токена» повторяет порядок ленты
  (`FeedOrder::order_by`): сначала `saved_at` в направлении порядка, затем
  `slug` без учёта регистра ASCII, затем `slug` побайтно.
- Порядок ленты обслуживают индексы схемы 10 (`migrate_v9_to_v10`), все
  частичные, для строк с `card_kind != 'channel'`:

  | Индекс | Столбцы | Чья страница |
  |---|---|---|
  | `idx_blocks_feed_newest` | `saved_at DESC, slug COLLATE NOCASE, slug` | Everything, сначала новые |
  | `idx_blocks_feed_oldest` | `saved_at, slug COLLATE NOCASE, slug` | Everything, сначала старые |
  | `idx_blocks_author_feed_newest` | `association_author_key, saved_at DESC, slug COLLATE NOCASE, slug` | лента автора, сначала новые |
  | `idx_blocks_author_feed_oldest` | `association_author_key, saved_at, slug COLLATE NOCASE, slug` | лента автора, сначала старые |

  На каждый порядок свой индекс: дата в двух порядках идёт в разные стороны,
  а имя в обоих по возрастанию, поэтому один индекс, прочитанный с конца,
  второй порядок не даёт. Индексы ленты автора держат только карточки с
  автором (`association_author_key IS NOT NULL`): без этого условия группа
  сайта у открытой карточки, которая читает карточки без автора в порядке
  ленты, шла бы через индекс автора по всем карточкам без автора подряд.
  План запроса страницы Everything и ленты автора не содержит прохода таблицы
  (`SCAN b`) и временной сортировки (`USE TEMP B-TREE FOR ORDER BY`): тест
  `a_feed_page_is_read_through_the_index_of_its_order`.
- Страница коллекции читается одним из двух путей; оба дают одну и ту же
  страницу (тест `both_ways_of_reading_a_collection_give_the_same_pages`):
  - **от участников:** запрос идёт от ссылок коллекции (`block_tags`),
    сортирует места её карточек в порядке ленты по узким строкам и читает
    полные строки только у карточек страницы. Посещает столько карточек,
    сколько в коллекции, где бы в ленте они ни стояли;
  - **по ленте:** запрос идёт по индексу порядка ленты и спрашивает каждую
    встреченную карточку, входит ли она в коллекцию, пока не наберёт
    страницу. В худшем случае посещает все карточки пространства вне
    коллекции.

  Выбирается путь с меньшим худшим случаем: от участников, пока в коллекции
  не больше половины карточек пространства, иначе по ленте
  (`CollectionRead::with_the_smaller_worst_case`). Так страница посещает не
  больше половины карточек пространства при любом расположении карточек
  коллекции в ленте. Размер коллекции считается по её ссылкам из индекса и не
  дальше половины пространства. До 16.11.2026 запрос сортировал полные строки
  всех карточек коллекции: страница коллекции из 5 000 карточек стоила как
  чтение их всех.
- Коллекции карточки (поле `collections` каждой строки ленты) ищутся по
  индексу с обеих сторон ссылки: ссылка называет страницу коллекции её именем
  (`channels.tag`, уникальный индекс) или её путём (`channels.source_slug`,
  индекс `idx_channels_source_slug` схемы 10). До схемы 10 у пути индекса не
  было, и каждая строка ленты на каждую свою ссылку проходила все страницы
  коллекций пространства: при 300 коллекциях страница Everything из 200 строк
  стоила 7,5 мс, с индексом 1,3 мс (замер ниже).
- Принадлежность карточки ленте коллекции во всех чтениях, кроме пути «от
  участников», записана как проверка самой карточки (`EXISTS` с
  `collection_membership_join_sql`, `feed_place_sql`). Поэтому частичное
  чтение находит ближайшую карточку перед названной рядом с ней, по индексу
  порядка, а не сортирует всю коллекцию на каждую названную карточку.
- Командная строка читает ленту по номеру карточки (`--offset`,
  [SPEC_AI_ACCESS.md](SPEC_AI_ACCESS.md)): `block_queries::list_grid_blocks`
  оставлен для неё, приложение его не вызывает.
- Страница с более новым поколением, чем у списка, принимается: смещения нет,
  поэтому вставки и удаления раньше токена страницу не сдвигают. Страница с
  поколением старше списка отбрасывается и запрашивается заново: её строки
  могли быть прочитаны до изменения, которое список уже показывает. До
  16.11.2026 страница любого другого поколения вела к полному чтению ленты с
  первой карточки, в том числе после каждого готового превью.
- Полное чтение загруженного (изменение снаружи) остаётся чтением с первой
  карточки на длину списка: с индексом оно идёт по порядку индекса без
  сортировки.

Тест скорости `a_feed_page_at_any_depth_answers_within_its_limit`
(`#[ignore]`, `bun run test:rust-speed`): каждая страница из 200 строк при
30 000 карточек, от первой до последней, не дольше 15 мс вместе с JSON для
страницы. Проверяются оба порядка для Everything, ленты автора (15 000
карточек) и четырёх коллекций: обычной (300 карточек), большой (5 000, каждая
шестая карточка пространства), из самой старой трети пространства (10 000,
худший случай для чтения по ленте) и из двух карточек из трёх (20 000, больше
половины пространства). Там же частичное чтение 100 карточек в большой
коллекции, не дольше 20 мс.

**Замер страниц ленты.** 16.11.2026, сборка с оптимизацией, 30 000 карточек
с текстом и 303 коллекции в памяти, каждая страница ленты от первой до
последней, время чтения вместе с JSON для страницы, нагрузка машины от 2,4
до 6,3:

| Лента | Страниц | Медиана | Худшая страница |
|---|---|---|---|
| Everything, сначала новые | 150 | 1,27 мс | 1,58 мс |
| Everything, сначала старые | 150 | 1,26 мс | 1,40 мс |
| Лента автора, 15 000 карточек, оба порядка | 75 | 1,26 мс | 1,38 мс |
| Коллекция из 5 000 карточек, сначала новые | 25 | 3,84 мс | 5,42 мс |
| Коллекция из 5 000 карточек, сначала старые | 25 | 3,07 мс | 3,66 мс |
| Коллекция из самой старой трети, сначала новые | 50 | 5,01 мс | 7,02 мс |
| Коллекция из самой старой трети, сначала старые | 50 | 3,90 мс | 4,15 мс |
| Коллекция из двух карточек из трёх, оба порядка | 100 | 1,69 мс | 1,96 мс |
| Коллекция из 300 карточек, оба порядка | 2 | 2,03 мс | 2,03 мс |

Цена страницы не растёт с глубиной: первая и последняя страница Everything
стоят одинаково. Прежний запрос страницы коллекции (сортировка полных строк
всех её карточек, страница по номеру) в том же прогоне на тех же индексах:
19,6 мс для первой страницы коллекции из 5 000 карточек, 76,9 мс для
страницы с 2 400-й карточки и 135,7 мс с 4 800-й. Частичное чтение 100
карточек в той же коллекции: 1,44 мс, худшее 1,75 мс.

### Search revision and cursor contract

```rust
struct SearchRevision(u64);

struct SearchPageToken {
    projection_revision: ProjectionRevision,
    search_revision: SearchRevision,
    offset: usize,
    query_fingerprint: String,
}

struct SearchSnapshot {
    generation: ProjectionRevision,
    search_generation: SearchRevision,
    blocks: Vec<LightBlock>,
    has_more: bool,
    next_cursor: Option<SearchPageToken>,
    cursor_reset: bool,
}
```

- `search_state.revision` advances on inserts, updates and deletes in
  `search_document_state`, `search_chunks` and `search_embeddings`; these
  derived writes do not pretend to be source projection changes.
- A page token is valid only when projection revision, search revision and the
  fingerprint of collection plus query all still match. Any mismatch resets to
  offset zero and returns `cursor_reset = true`.
- `SearchSnapshot` is read after search-document synchronization under the
  projection snapshot boundary, so ranking and pagination cannot silently mix
  two search-index states.

## storage/derived_preview — completion contract

Status: implemented in Phase A3. A single app-level background worker drains a
multi-vault coalescing queue; a full-vault request supersedes queued per-slug
work for that vault, while changes arriving during a pass are drained before the
worker exits.

The feed never infers readiness from a non-null `preview_manifest` alone. Every
manifest has an explicit derived state validated against the local cache.

```rust
enum DerivedPreviewState {
    Missing,
    Stale,
    Ready,
    Failed,
}

struct PreviewReconcileReport {
    checked: usize,
    ready: usize,
    regenerated: usize,
    changed_slugs: Vec<String>,
    failed: Vec<PreviewFailure>,
    cancelled: bool,
}

fn reconcile_preview_for_slug(
    conn: &Connection,
    vault: &VaultLayout,
    slug: &str,
) -> Result<Option<PreviewReconcileOutcome>>;

fn reconcile_all_previews(
    conn: &Connection,
    vault: &VaultLayout,
) -> Result<PreviewReconcileReport>;
```

Rules:

- `Ready` means the manifest is semantically valid for the current `card_kind`,
  every required `primary_preview_path`/tile preview exists, stays inside the
  derived cache, is decodable by the receiving surface and matches the current
  `source_stamp`.
- `text` is a valid asset-free feed recipe for `article`, `link` and nonvisual
  file cards. It does not mount a bitmap panel. Visual image/video media cannot
  become `Ready` from a text placeholder; it remains a typed missing/failed
  state until its image/video/composite artifact exists.
- Missing cache files and changed dependency stamps transition to `Stale` and
  schedule regeneration; they never leave a manifest that lies about files.
- Source reindex marks the row `Stale` but preserves the previous
  `preview_source_stamp` until the new preview publishes. This lets the worker
  distinguish an actual dependency change from a legacy row whose stamp was
  never recorded.
- A legacy row with `preview_source_stamp = NULL` may adopt already-valid JPEG
  artifacts and stamp them without source decoding. A missing first tile for a
  non-composite single-media manifest may be materialized atomically from its
  valid primary preview.
- Backfill is resumable and idempotent. It updates SQLite only after all files
  for one manifest are renamed into place. Files of the preview cache are
  not waited onto the disk; a file a power loss cut short is no preview and
  is built again (SPEC_THUMBNAILS.md, П10).
- Encoding failures preserve the last complete manifest when safe, publish a
  typed retryable/non-retryable error and never expose partial files.
- Grid/Card/measurement code consumes only `Ready` derived paths. Original
  source assets remain Detail-only.

Budgets:

- One app-level worker owns preview generation. It processes only the current
  vault, cancels obsolete work between blocks after a vault switch, and
  coalesces full-vault/per-slug requests rather than spawning competing
  decoders/writers.
- Full-pass batches are bounded to `24` blocks and yield between batches.
  Changed slugs are published to the frontend after each completed batch; UI
  readiness never waits for an entire large-vault pass.
- A warm validation pass performs metadata checks only and schedules zero
  decodes for `Ready` rows.
- Feed browser acceptance permits zero source-vault image/video requests during
  fast scroll; all requests must resolve inside the derived cache.
- A stale worker may publish `Ready` only if the persisted source stamp still
  equals the stamp it generated from; a compare-before-publish guard prevents an
  old encode from overwriting a newer invalidation.

### Публикация сверяет план, а не байты манифеста (15.11.2026)

Манифест превью несёт две разные вещи. План называет картинки: вид превью,
главное превью, источник и файл каждой плитки, число картинок сверх плиток.
Геометрия это размеры файлов превью (`preview_width` и `preview_height`
главного превью и каждой плитки). Геометрию измеряют по готовому файлу и
вписывают в манифест после записи файла.

Геометрию вписывают два писателя. Проход превью измеряет все файлы карточки
при каждой публикации. Каждый, кто переписал миниатюру `<slug>.jpg`, сразу
вписывает её размер через `index::sync_thumb_metadata`
([SPEC_CARD_MEDIA_GEOMETRY.md](SPEC_CARD_MEDIA_GEOMETRY.md), решение
02.10.2026): очередь превью наблюдателя, обход миниатюр, `save_thumb`. Эти
писатели работают в других потоках одновременно с проходом. Одно событие
наблюдателя о правке заметки ставит карточке и проход превью
(`schedule_preview_reconcile`), и задачу в очередь превью наблюдателя
(`preview_queue`).

Правило. Проход публикует состояние карточки, `ready` или любое неготовое,
если в индексе лежит тот же план, который проход прочитал, и тот же отпечаток
источника. Размер, вписанный другим писателем за время прохода, входом
прохода не считается и публикацию не отменяет. Смена плана или отпечатка
отменяет публикацию, как прежде: проход отказывает с «preview inputs changed
while publishing» и ничего не пишет, а публикует тот проход, который
поставила сама смена.

Как устроено. Публикация это одна пишущая транзакция индекса
(`BEGIN IMMEDIATE`, `derived_preview::publish_on_stored_manifest`). В ней
проход читает манифест, как он лежит сейчас, и сверяет его план с прочитанным
в начале (`index::picture_plans_differ`). Затем проход измеряет файлы,
вписывает размеры поверх лежащего манифеста и записывает состояние. Пока
транзакция открыта, другой писатель в индекс не пишет, поэтому между чтением
манифеста и записью он не меняется. Отказ откатывает транзакцию целиком.

Что получается при каждом порядке двух потоков, которые строят превью одной
версии карточки:

- Размер миниатюры вписан до того, как проход прочитал план. Проход читает
  манифест уже с размером и публикует `ready`.
- Размер миниатюры вписан после того, как проход построил картинки, и до
  публикации. Проход публикует `ready` поверх манифеста с этим размером.
- Размер миниатюры вписан после публикации. Писатель измеряет ту же
  миниатюру, размер в манифесте уже верный, и манифест не меняется.

Во всех трёх случаях карточка `ready`, а размер каждого файла в манифесте
равен размеру файла на диске.

До 15.11.2026 публикация сверяла манифест побайтно с прочитанным в начале
прохода. Во втором порядке проход отказывал, хотя картинки уже построил.
Строка оставалась `stale` с новым планом и без размеров плиток, без
`thumb:updated` от прохода. Лента рисовала по ней новые картинки, но
карточка, чья форма берётся из размера плитки, стояла во временной пропорции
16:9 до следующего прохода по пространству. Этот порядок обычен для правки
заметки с картинками снаружи Mine: наблюдатель строит одну миниатюру, проход
строит её же и плитки и кончает позже. Замер 15.11.2026 на карточке с двумя
плитками: наблюдатель вписал размер через 12,7 мс после начала прохода,
проход публиковал через 13,8 мс. Тот же отказ получала публикация неготового
состояния, например `browser_decode_required`.

Проверки. `storage/derived_preview.rs`:
`a_size_stamped_while_the_pass_made_its_pictures_does_not_refuse_the_publish`,
`a_size_stamped_meanwhile_does_not_refuse_the_publish_of_a_wait`,
`a_plan_changed_while_the_pass_made_its_pictures_refuses_the_publish`. Другой
писатель встаёт между картинками прохода и публикацией через тестовую точку
`publish_hooks`. `watcher/handler.rs`: правка заметки снаружи с настоящей
очередью наблюдателя в трёх порядках,
`an_outside_edit_that_drops_a_picture_redraws_the_card_at_once` (второй
порядок, падала до исправления),
`an_outside_edit_redraws_the_card_when_the_watchers_preview_lands_before_the_pass`
и
`an_outside_edit_redraws_the_card_when_the_watchers_preview_lands_after_the_pass`.
Порядок задают точки `preview_hooks` и `publish_hooks`, без таймеров.

## storage/cold_space_audit — disposable acceptance contract

Cold-space acceptance must exercise the same storage primitives as production
without writing to the source vault or trusting an existing local cache.

```rust
fn run_cold_space_audit(
    source_root: &Path,
    derived_base: &Path,
    cycles: usize,
) -> Result<ColdSpaceAuditReport>;
```

- `cycles >= 2`; one fresh store cannot prove cache-reset stability.
- `derived_base` must already exist, be empty and be neither inside
  `source_root` nor an ancestor of it. Each cycle owns a fresh
  `<derived_base>/cycle-N` store.
- Every source Markdown is classified exactly once as content, collection or a
  typed unsupported input. The audit rejects missing and stale extra
  projections instead of hiding them in aggregate counts.
- A cycle records three semantic snapshots: immediately after source
  reconciliation, after derived-preview completion, and after closing and
  reopening SQLite read-only.
- Each semantic snapshot also contains the exact production `GridSnapshot`
  DTO, including its persisted projection generation. This DTO is the fixture
  consumed by browser acceptance; tests must not recreate `LightBlock` rows in
  TypeScript.
- Snapshots include deterministic Grid order, source/projection counts,
  runtime card kinds, preview state/manifests and semantic/fallback violations;
  they exclude volatile row ids and timestamps.
- Grid pagination orders by `saved_at DESC`, then case-insensitive and binary
  slug ascending as deterministic tie-breakers. Rebuilds cannot depend on
  SQLite row insertion order when source timestamps are equal.
- Reopened state must equal settled state. Independent cold cycles must have
  equal first and settled snapshots, proving restart and derived-cache reset
  stability.
- Source file path, size and modification-time fingerprints are captured before
  and after every cycle. Any mutation fails the audit.
- Browser-decode-required and missing-source previews are typed non-ready
  outcomes, not audit infrastructure failures. Their cards still need a
  deterministic type-correct first-frame fallback.
- The browser gate creates a real temporary source vault, builds an empty
  derived SQLite store through Rust, serializes the production IPC DTO and
  renders that payload in Grid. This single path covers source files -> parser
  -> SQLite -> Rust serialization -> frontend DTO -> Grid.
- Холодное пространство браузерного гейта холодно и в iCloud, а не только на
  локальном диске (SPEC_DEEP_AUDIT.md, Е7.8, 13.10.2026). У образца своя
  картинка `cold-icloud-image.png` для каждой двенадцатой карточки;
  `run_cold_space_audit_with_icloud` (флаг `--icloud-media` у
  `cold-space-audit`) перед каждым циклом объявляет её содержимое лежащим в
  iCloud через `cloud_files::test_seam`, потому что выгруженный файл делает
  только ядро системы. Проход индекса, который её скачал, валит цикл; первая
  проекция показывает такие карточки без размеров, гейт проверяет это по
  снимку до запуска браузера. Сборка с оптимизациями выпуска шва не несёт и
  такой прогон отклоняет.

## storage/source_mutation — atomicity contract

This section describes the existing native storage boundary. It is not a
cross-platform guarantee for File System Access. The save-core migration must
preserve these mutation-specific rollback rules; capture/create source commits
and their derived-index catch-up are specified separately in
[SPEC_SAVE_CORE.md](SPEC_SAVE_CORE.md). The reliable operation-ID protocol
belongs to clipper transport; existing desktop/CLI create calls retain their
transactional index rollback while reusing the core's capture constructor.

Compound user mutations are planned and committed through one storage-owned
boundary. Commands validate IPC and emit events; they do not sequence raw file
and SQL writes themselves.

```rust
enum SourceMutationKind {
    Create,
    Rewrite,
    Rename,
    Delete,
    ImportBlock,
}

enum SourceMutationError {
    Validate { path: PathBuf, reason: String },
    Changed { path: PathBuf, preserved: Option<PathBuf> },
    Stage { path: PathBuf, source: anyhow::Error },
    CommitFile { path: PathBuf, source: anyhow::Error },
    CommitIndex { operation: &'static str, source: anyhow::Error },
    Rollback { original: String, failures: Vec<PathBuf> },
}
```

- Текст ошибки для человека строится форматом `{:#}`, как у `anyhow::Error`:
  шаг Mine (`delete <path>`) и под ним все причины до ответа системы.
  Обычный `{}` останавливается на шаге Mine и для сообщения пользователю не
  годится: 08.10.2026 диалог удаления показал путь без причины отказа.
  Причины остаются доступны через `source()`, поэтому код, который ищет в
  цепочке ошибку SQLite или `SourceChanged`, находит её как прежде.
  `CommandError::from` и помощники `internal_*_error` в `commands/blocks.rs`
  пишут сообщение в этом формате; `Rollback.original` хранит его же.

- New/replacement files use same-directory temp + file `fsync` + atomic rename;
  create-new additionally rejects an occupied destination before commit.
- Replacing an existing source document preserves its creation time, permissions,
  ACL and extended attributes on macOS. The replacement keeps its new modification
  time. Metadata is copied to the staged file before publication and fsynced;
  failure aborts publication, leaving the original intact. The same rule applies
  to direct writes, staged replacements and rename-with-content. New documents
  retain their own creation time. File inode identity is not preserved by rename.
- Multi-file operations stage every new byte sequence before the first visible
  rename and retain byte backups until the SQLite transaction commits.
- A failure restores old source bytes and the previous index generation. If
  rollback itself is incomplete, the operation returns `Rollback` and forces
  freshness state to `degraded` so reconciliation runs before further reads.
- Derived artifacts are never part of the source transaction and may be
  regenerated after commit.

### Выход (SPEC_DEEP_AUDIT.md, Н3, Е2.1)

Каждая запись источников идёт под арендой шлюза записей (`begin_write`).
Выход из Mine закрывает шлюз (`close_for_exit`): новая запись, не вложенная в
уже идущую на том же потоке, получает отказ «Mine is quitting; new writes are
not started», а выход ждёт окончания начатых записей до 30 с. Вложенная запись
на потоке, который уже держит аренду (мутация публикует файл через
`files::write_atomically`), проходит: отказ ей оставил бы внешнюю мутацию
наполовину. Шлюз помнит аренды по потоку, который их взял, поэтому аренда,
отпущенная на другом потоке, снимается со счёта своего потока. Шлюз после
выхода не открывается: процесс кончается.

Порядок выхода ([shutdown.rs](src-tauri/src/shutdown.rs)): первый запрос
выхода (`RunEvent::ExitRequested`) задерживается (`prevent_exit`), сохранённые
окна пишутся сразу (SPEC_TABS.md, В33), загрузки Download Media
останавливаются и оставляют готовые видео (SPEC_MEDIA_ASSET_ACTIONS.md,
«Download Media», пункт 8), шлюз закрывается и ждёт начатые записи, затем
приложение выходит само (`app.exit(0)`), и этот запрос уже проходит. Запросы
выхода во время ожидания тоже задерживаются. Окна прячутся сразу по первому
запросу, после записи сохранённых окон: выход ничего не показывает, его
отказы (шлюз записей, загрузка, запрошенная во время выхода) и итог пишутся
только в журнал (решение пользователя 14.10.2026). До 13.10.2026 выход не ждал
ничего: групповое удаление и переименование коллекции, шедшие в эту минуту,
оставались наполовину.

### Checked publication (SPEC_AUDIT_FIXES.md, Ф1, Ф2)

- A write never rebuilds an existing note from the `Block` model:
  `serialize_block` is for new notes only. Changes to an existing note go
  through `mine_core::domain::source_patch::apply_block_changes(source,
  before, after)`: only Mine fields whose rendering changed and a changed body
  are carried into the original text; unknown keys, their order, YAML
  comments, blank lines and CRLF stay byte for byte. A note without
  frontmatter gets one only with the changed fields, never `saved_at`. The
  result is read back and must match the intended model, otherwise the patch
  is refused. Frontmatter is found the way Obsidian finds it, with no line
  limit (`frontmatter_bounds`).
- `SourceFileWrite::replace(path, expected, bytes)` and
  `rename_with_bytes(source, destination, expected, bytes)` carry the bytes
  the caller read. Staging refuses with `Changed` when the file holds
  anything else. Publication of a replacement is an atomic exchange
  (`renamex_np` with `RENAME_SWAP`); the displaced bytes are compared with
  `expected`, and on a mismatch the outside version is made live again and
  the operation fails with `Changed`.
- `rename(source, destination)` moves the file in one step without replacing
  anything (`RENAME_EXCL`), so edits made meanwhile move with it; across
  volumes the file is copied to a new name and the source removed. A rename
  that also rewrites publishes the new file, then moves the source aside in
  one step and compares it with `expected`; a mismatch moves it back and
  withdraws the new file.
- Rollback restores only what this operation put in place: a replacement
  goes back through the same exchange, compared with the published bytes; a
  created or rewritten file is removed only while its identity (inode, size,
  modification time) is the published one. A destination edited after
  publication stays, and the rollback reports it as incomplete.
- A version displaced by a race with the restore itself is kept in
  `.mine/source-conflicts/` of the space.
- Удаление (`delete`, `delete_if_unchanged`) не создаёт второго имени файла
  (жёсткой ссылки): 13.10.2026 Корзина iCloud унесла вторую ссылку страницы
  коллекции и оставила саму страницу в скрытой папке, где её нет ни на
  месте, ни в Корзине (SPEC_DEEP_AUDIT.md, Е1.11). Сверяемое удаление
  проверяет, что на месте прочитанный файл с прочитанными байтами, и просит
  Корзину взять его с его места (`files::trash_user_file`, `NSFileManager
  trashItemAtURL` с местом в Корзине), поэтому Put Back в Finder возвращает
  файл туда, откуда он ушёл (Е5.9). До 13.10.2026 файл сначала уходил в
  скрытую папку рядом и попадал в Корзину оттуда: Put Back указывал на
  папку, которой уже нет. После ответа файл обязан уйти: файл, который
  Корзина оставила, остаётся на месте, операция отказывает `NotTrashed`
  («the Trash did not take …»), ничего не удалено. Файл в Корзине
  сравнивается с прочитанными байтами: чужая версия (правка, записанная в
  файл на месте во время переноса, или файл, которым редактор заменил
  заметку между проверкой и Корзиной) возвращается на место, отказ
  `Changed`. Удаление без сверки (медиа) тоже требует, чтобы файл ушёл с
  места. Откат возвращает файл из Корзины на его путь; в Корзине копии не
  остаётся.

### Runtime/card kind derivation

Storage derives a semantic presentation kind from document evidence. Legacy
`frontmatter.type` is a compatibility hint only when the document shape is
otherwise ambiguous. During indexing:

1. `type: channel` derives `card_kind = channel`.
2. Any other block with non-empty body derives `article`.
3. An empty-body block with canonical `file` derives `media` even when its
   source asset is temporarily missing.
4. An empty-body block with URL/link metadata and no owned media derives `link`.
   This URL evidence takes precedence over a legacy `type: image | video |
   file` hint: a remote video bookmark is still a link card unless Mine owns a
   local `file`.
5. Without body, owned file or URL, a legacy `type: image | video | file` hint
   derives `media` for compatibility.
6. Any remaining ordinary/foreign Markdown derives `article`, including an
   empty note; absence of body is not evidence of media ownership.

The physical `block_type` column keeps the parsed legacy/source type
(`image`, `link`, `video`, `file`, `article`, `channel`) for compatibility and
diagnostics. Normal UI read models use `card_kind = article | media | link |
channel`, not `block_type`.

`card_kind` and preview kind are orthogonal: a link may have an image preview,
but remains a link. A link without a derived image renders its textual card and
Detail metadata without a faux media panel.

### Функции

```rust
upsert_block(conn: &Connection, block: &Block) -> Result<i64>
remove_block(conn: &Connection, slug: &str) -> Result<bool>
get_block(conn: &Connection, slug: &str) -> Result<Option<IndexedBlock>>
list_blocks(conn: &Connection) -> Result<Vec<IndexedBlock>>
list_blocks_light(conn: &Connection) -> Result<Vec<LightBlock>>
list_grid_blocks(conn: &Connection, tag: Option<&str>, offset: usize, limit: usize) -> Result<(Vec<LightBlock>, bool)>
read_search_snapshot(conn: &Connection, tag: Option<&str>, query: &str, limit: usize, cursor: Option<&SearchPageToken>) -> Result<SearchSnapshot>
list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<IndexedBlock>>
get_all_tags(conn: &Connection) -> Result<Vec<TagCount>>
slug_exists(conn: &Connection, slug: &str) -> Result<bool>
resolve_unique_slug(conn: &Connection, raw_slug: &str) -> Result<String>
rename_slug(conn: &Connection, old_slug: &str, new_slug: &str) -> Result<bool>
sync_thumb_metadata(conn: &Connection, slug: &str, thumb_path: &Path, vault_root: Option<&Path>) -> Result<bool>
clear_thumb_metadata(conn: &Connection, slug: &str) -> Result<bool>
backfill_missing_thumb_metadata(conn: &Connection, vault: &VaultLayout) -> Result<usize>
list_preview_blocks(conn: &Connection, limit: usize) -> Result<Vec<PreviewBlock>>
list_preview_blocks_by_tag(conn: &Connection, limit: usize) -> Result<Vec<(String, Vec<PreviewBlock>)>>
list_pending_thumb_upgrade_blocks(conn: &Connection) -> Result<Vec<PendingThumbUpgradeBlock>>
search_blocks(conn: &Connection, query: &SearchQuery) -> Result<Vec<IndexedBlock>>
upsert_channel(conn: &Connection, channel: &Channel) -> Result<i64>
list_channels(conn: &Connection) -> Result<Vec<Channel>>
new_channel_position(conn: &Connection) -> Result<i64>
remove_channel(conn: &Connection, tag: &str) -> Result<bool>
```

### Поведение upsert_block

- Если блок с таким slug уже есть — обновляет все поля
- Пересчитывает и сохраняет `body_hash` (body после frontmatter) для external rename detection
- Обновляет block_tags: удаляет старые, вставляет новые
- Обновляет `wikilinks`: удаляет старые, вставляет только plain note links из
  `extract_note_wikilinks`. Media embeds `![[file]]` остаются в media pipeline
  и не попадают в block-to-block graph relation index.
- FTS5 обновляется автоматически через триггеры
- Не генерирует thumbnail и не угадывает `thumb_format` по slug. Thumbnail
  metadata синхронизируется отдельным `sync_thumb_metadata` после записи thumb.

### Поведение thumbnail metadata / preview queries

- `sync_thumb_metadata` читает on-disk thumb magic bytes и mtime, затем пишет
  `thumb_format = jpeg|png` и `thumb_mtime`; если файл отсутствует или не
  является валидным JPEG/PNG, поля очищаются.
- `list_preview_blocks` и `list_preview_blocks_by_tag` возвращают только
  non-channel rows с `thumb_format IS NOT NULL`. Отсутствующий thumb не должен
  превращаться в пустую sidebar preview-card.
- `backfill_missing_thumb_metadata` восстанавливает metadata для legacy rows,
  у которых thumb file уже лежит на диске, но SQLite columns ещё пустые.
- `list_pending_thumb_upgrade_blocks` отдаёт кандидатов для Phase 2 upgrade,
  включая PNG placeholder rows и rows с missing/NULL metadata; command layer
  обязан проверить реальный disk state перед возвратом upgrade request.

### Поведение rename_slug

- Меняет только `blocks.slug` в SQLite-индексе
- Не делает silent conflict resolution: target slug должен быть свободен
- Не переписывает другие `.md` файлы и не трогает source vault
- Используется как low-level primitive для watcher-based external rename; in-app rename поверх него дополнительно переписывает vault refs и source media

### Поведение list_channels / new_channel_position

- `list_channels` возвращает каналы в порядке `position ASC`, затем стабильный
  `CollectionRef` tie-breaker. Legacy DB column `channels.title` is not a
  display-title source.
- `new_channel_position` даёт место новой коллекции по правилу mine-core
  `new_collection_position`: на единицу меньше самой малой `position` строк
  `channels`, `0` для пустого списка. Новая коллекция встаёт первой, и пишется
  только её страница: позиции других страниц не меняются (SPEC_DEEP_AUDIT.md,
  Е6.2, 13.10.2026). Им пользуются `create_channel` приложения, CLI и MCP,
  импорт Are.na и `create_channel` помощника клиппера. До 13.10.2026 функция
  называлась `next_channel_position` и давала `max(position) + 1`, а
  приложение после создания переписывало позиции всех страниц.
- `position` знаковая (`i64`, в SQLite `INTEGER`): после созданий самая малая
  позиция уходит ниже нуля. Страница без `position` читается как `0`, как
  прежде; страницы с позициями от нуля читаются, как читались.

The implementation still uses `channels.tag` and `block_tags.tag` physical
column names for compatibility, but their semantic value is now
`CollectionRef`: the Obsidian wikilink target stored in `Mine Collections`, not
a normalized tag. Legacy normalized values are migration inputs only.

### Членство в коллекции (решение 10.10.2026)

Коллекция существует только как страница с `type: channel`
([SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md), К1,
К3 и К9). Реализовано 10.10.2026 (PLAN.md, Phase 44): общее условие это
`collection_membership_join_sql` в
[block_queries.rs](src-tauri/src/storage/block_queries.rs), соединение
`block_tags` со строкой `channels` того же `tag`; его же берёт поиск по месту
коллекции в `search_engine.rs`. `list_blocks_by_tag` остаётся отражением
файлов без условия: по нему переименование и удаление коллекции находят
файлы, которые переписывают.

- `block_tags` хранит каждую ссылку `Mine Collections` карточки, как сейчас:
  это отражение файла, а не членство. `upsert_block` не проверяет страницы.
- Членство это строка `block_tags`, для которой есть строка `channels` с тем
  же `tag`. Одно общее условие (общий фрагмент SQL в
  [block_queries.rs](src-tauri/src/storage/block_queries.rs)) применяют все
  чтения, которые показывают или считают коллекции: `get_all_tags`,
  `collections_column_sql`, `IndexedBlock.tags` у `get_block`,
  `list_block_collections`, `list_grid_blocks` и `list_preview_blocks_by_tag`
  для коллекции, `count_current_collection_cards`, фильтр `tag:` в
  `search_blocks`, `build_graph_snapshot`.
- Страница появилась в `channels` (создана, возвращена из Корзины, пришла
  синхронизацией): членство её карточек видно сразу, без переиндексации
  карточек. Строка `channels` удалена вместе со страницей: членство пропадает,
  `block_tags` не меняется.
- Ни одна запись `Mine Collections` не строится из индекса: она читает текст
  файла, поэтому ссылки без страницы при записи не теряются (К2).

### Collection filenames

- Collection pages are `.md` files with `type: channel`.
- Canonical source format uses human-readable filenames:
  `Красивый веб.md`, not `красивый-веб.md`.
- Channel `title` may mirror filename for display, but it is not a machine id.
- Watcher must not canonicalize collection filenames by lowercasing,
  kebab-casing, or tag-normalizing them.
- Legacy normalized channel files are migration inputs. The
  `migrate-collections-to-wikilinks` tool may rename them to human filenames
  after dry-run, backup, and conflict checks.
- If a target human filename already exists and differs materially, migration
  must stop and report the conflict instead of deleting or merging files.
- Ordinary Obsidian/article/image/link files with human filenames are never
  canonicalized.

### Поведение search_blocks

- Свободный текст: `WHERE blocks_fts MATCH ?`
- Фильтр type/card kind: against derived runtime card kind, not raw
  `frontmatter.type`
- Фильтр tag: `JOIN block_tags WHERE tag = ?`, только при паре в `channels`
  (членство по разделу «Членство в коллекции»)
- Комбинация: AND между фильтрами

### Поведение Grid search

Surface Search не возвращает отдельный `IndexedBlock` result set в frontend.
Он использует отдельный route-facing `search_grid_blocks`, а обычный Grid
остаётся на `list_grid_blocks` без query-параметра:

- пустой overlay использует обычный vault-wide `list_grid_blocks` для recent;
- непустой query идёт через `search_grid_blocks`, optional collection filter,
  `WHERE blocks_fts MATCH ?`;
- ranking: `ORDER BY bm25(blocks_fts, 8.0, 3.0, 1.0) ASC, b.saved_at DESC`;
- projection остаётся lightweight `LightBlock`, без полного body payload для
  media cards и без per-block tags;
- search excerpt/highlight metadata строится только для возвращаемых rows;
- pagination uses `SearchPageToken`; raw offsets are not accepted for a
  continued search page;
- FTS columns: `title` = `display_title` + legacy `title` + `fallback_label`,
  `description`, `body`.
- derived `search_chunks` дополнительно содержат searchable metadata fields:
  `author` и `url`. Эти chunks участвуют в lexical/fuzzy candidate generation
  и ranking, но не считаются visible highlight surfaces.

Hybrid behavior:

- lexical/alias candidates and semantic candidates are collected behind one
  storage-level `SearchEngine` boundary;
- non-empty Grid queries delegate to `storage::search_engine`;
- lexical and alias candidates use SQLite FTS5, with deterministic
  aliases/transliteration before matching;
- fuzzy candidates use normalized `search_chunks` and real text ranges;
- semantic candidates use persisted `search_embeddings` generated by local
  `fastembed` `intfloat/multilingual-e5-small`;
- model files are cached outside the project tree at
  `~/Library/Application Support/com.mine.app/cache/fastembed` by default, with
  `FASTEMBED_CACHE_DIR` as the explicit override;
- single-token Latin queries bypass semantic embedding work and do not admit
  semantic-only rows into Grid results; semantic-only rows are reserved for
  Cyrillic cross-language queries and multi-token semantic queries;
- collection route filtering is applied before final projection;
- candidate chunks collapse to one card result per slug;
- exact/prefix/alias matches carry real highlight ranges;
- author/url metadata matches carry empty highlight ranges; author can explain
  why a card matched, but URL remains hidden in card rendering;
- semantic-only matches carry an excerpt and empty highlight ranges;
- embedding generation is background derived work after vault open; non-empty
  search never downloads the model or generates missing vectors in the
  foreground, and falls back to lexical/alias/fuzzy while semantic state warms.

Полный surface contract: [SPEC_SEARCH.md](SPEC_SEARCH.md).

---

## storage/vault_stats

Число карточек места ленты: Everything или коллекция. До 13.10.2026 модуль
был источником статистики пространства для второго ряда хрома (`VaultStats`,
`get_vault_stats`, счёт файлов и объёма пространства); счётчик показывал
только ряд метаданных внизу окна (Alt 2), и срез 46.10 удалил его вместе с
командой. Осталась функция счёта карточек, ею пользуются тесты индекса
(сверка членства) и модуля.

### Функции

```rust
count_current_collection_cards(conn: &Connection, current_collection: Option<&str>) -> Result<u64>
```

### Поведение

- `current_collection = None` (`Everything`) считает все indexed rows, где
  `card_kind != channel`.
- `Some(collection_ref)` считает indexed non-channel rows, связанные с этим
  `CollectionRef` через `block_tags`, если у него есть страница в `channels`;
  без страницы маршрута коллекции нет.
- Count строится из SQLite read-model, а не из frontend массива карточек.

---

## storage/files

Файловые операции: создание/чтение/удаление блоков и медиафайлов в vault.

### Функции

```rust
write_block_file(vault: &VaultLayout, block: &Block) -> Result<PathBuf>
read_block_file(vault: &VaultLayout, path: &Path) -> Result<(String, String)>  // (vault-relative slug, content)
scan_md_files(vault: &VaultLayout) -> Result<Vec<PathBuf>>
copy_media_file(source: &Path, vault: &VaultLayout, slug: &str) -> Result<PathBuf>
delete_user_file(path: &Path) -> Result<()>
delete_block_files(vault: &VaultLayout, slug: &str, media_ext: Option<&str>) -> Result<()>
delete_block_files_with_media_paths(vault: &VaultLayout, slug: &str, media_paths: &[PathBuf]) -> Result<()>
persist_new_block(conn: &Connection, vault: &VaultLayout, block: &Block, source_file: Option<&Path>) -> Result<IndexedBlock>
persist_new_reference_block(conn: &Connection, vault: &VaultLayout, block: &Block) -> Result<IndexedBlock>
rename_derived_artifacts(vault: &VaultLayout, old_slug: &str, new_slug: &str) -> Result<()>
load_vault_write_layout(vault: &VaultLayout) -> Result<VaultWriteLayout>          // никогда не ждёт iCloud
load_vault_write_layout_waiting(vault: &VaultLayout) -> Result<VaultWriteLayout>  // открытие пространства
layout_for_new_files(vault: &VaultLayout) -> Result<VaultLayout>
ensure_vault_write_layout(vault: &VaultLayout, requested: &VaultWriteLayout) -> Result<()>
```

### Раскладка записи и копия этого Мака

`.mine/layout.json` синхронизируется вместе с пространством, и iCloud
выгружает его, как любой файл (SPEC_CLOUD_STORAGE.md, Х12; SPEC_DEEP_AUDIT.md,
Е5.18). Каждое чтение файла, пока его содержимое здесь, оставляет раскладку и
штамп файла (размер, время изменения) в производном хранилище этого Мака:
`<derived_root>/space-layout.json` ([layout_copy.rs](/Users/i_iii/Проекты/Личные проекты/local-arena/src-tauri/src/storage/layout_copy.rs)).
Производное хранилище внутри пространства (`.mine`) копии не держит.

- Файла нет: раскладка по умолчанию (корень), копия удаляется.
- Содержимое здесь: файл читается, копия обновляется. Некорректный файл
  отказывает, как раньше, и копию удаляет.
- Содержимое в iCloud, копия есть: раскладка из копии. Другой штамп (файл
  изменили на другом Маке): копия служит, пока новый файл не приедет, iCloud
  просят его скачать.
- Содержимое в iCloud, копии нет: `load_vault_write_layout` отвечает
  `LayoutInCloud` и просит iCloud скачать файл; `load_vault_write_layout_waiting`
  (только открытие пространства) ждёт файл и делает копию.

То, что не создаёт файлов (чтения CLI, удаление, переименование, список
коллекций помощника), на `LayoutInCloud` идёт с раскладкой по умолчанию:
она ему не нужна. Создание файла (`layout_for_new_files`, команды CLI
`card create`, `collection create`, `merge`, сохранение и новая коллекция
помощника) отказывает с причиной и не пишет в корень (SPEC_VAULT_LIFECYCLE.md,
П2). `ensure_vault_write_layout` сверяет план сохранения с копией, пока файл в
iCloud, и не скачивает его.

### Поведение write_block_file

- Сериализует Block через domain::block::serialize_block
- Записывает в `vault/slug.md`
- Создаёт директории при необходимости
- `slug` должен приходить из `domain::block::suggest_slug`: human-readable Unicode stem, NFC-normalized, bounded by `100` chars и `220` NFD bytes. Storage не должен повторно обрезать имя или строить media path из legacy title: source media references берутся из `frontmatter.file`.
- New writes serialize `frontmatter.file` as an Obsidian wikilink string
  (`file: "[[Media/name.ext]]"` for a configured Media folder; basename
  references are also valid). Legacy raw `file: name.ext` remains accepted on
  read and is normalized in the indexed read model.

### Временные файлы

Новые байты пишутся во временный файл рядом с целью,
`<имя>.tmp.<процесс>.<время>.<номер>` (`files::prepare_temp_file`), и затем
занимают место цели. Наблюдатель такие файлы не замечает
(`files::is_mine_temp_file_name`, SPEC_INTEGRATION.md, «Поведение
classify_notify_event»).

### Поведение scan_md_files

- Возвращает пути всех `.md` файлов в vault recursively.
- Игнорирует hidden/service/build директории: `.mine/`, `.obsidian/`,
  `.trash/`, `.git/`, `node_modules/`, `target/`, `__pycache__/`; legacy
  `.arena/` также игнорируется.
- Игнорирует файлы, не являющиеся `.md`
- NFC-normalizes filename boundary перед возвратом в indexing/watcher pipeline

### Поведение delete_block_files

- User-owned source files удаляются только в системную Корзину
  (`files::delete_user_files`). Отказ Корзины никогда не превращается в
  окончательное удаление: файл остаётся на месте, операция сообщает причину.
- На macOS файл переносит в Корзину `NSFileManager trashItemAtURL`
  (`DeleteMethod::NsFileManager` крейта `trash`), как Корзина любого
  приложения. Способ крейта по умолчанию, команда Finder через Apple Event
  (`osascript`), запрещён: он требует согласия человека на управление Finder,
  а сборке, которую macOS не может опознать (разработческая копия, CLI `mine`
  из терминала), Finder отказывает сразу (`errAEEventNotPermitted`, -1743), и
  каждый файл стоит отдельного процесса `osascript`. Случай 08.10.2026: в
  разработческой копии отказывало каждое удаление. Через `NSFileManager`
  файл в iCloud Drive уходит в Корзину за время от 10 до 30 мс.
- Ограничение: Finder может не предложить «Put Back» для файла, перенесённого
  `NSFileManager`; файл возвращается из Корзины перетаскиванием.
- Мутации источников переносят файл в Корзину по одному
  (`files::trash_user_file`) и получают место, куда Корзина его положила:
  по нему проверяется, что ушёл именно этот файл, и делается откат
  («Checked publication», SPEC_DEEP_AUDIT.md, Е1.11).
- Запасной перенос в Корзину iCloud (PLAN.md, 46.17, 15.10.2026).
  `trashItemAtURL` отказывает части файлов в iCloud Drive ошибкой
  `NSCocoaErrorDomain` 513 без вложенной ошибки: Foundation передаёт запрос
  `fileproviderd` (`-[FPDXPCServicer trashItemAtURL:completionHandler:]`), тот
  отвечает 513 примерно за 1 мс и причину в журнал не пишет. Так же отказывает
  Терминал с Full Disk Access, у файлов с обычными владельцем и правами, без
  ACL и флагов; обычное переименование того же файла проходит; какой файл
  откажет, предсказать нельзя (живые проверки 14.10.2026 и 15.10.2026).
  Apple DTS ([developer.apple.com/forums/thread/831369](https://developer.apple.com/forums/thread/831369),
  июнь 2026): `trashItem` может непредсказуемо отказывать в доменах File
  Provider, приложению нужен запасной путь. Причина отказа ещё выясняется
  (PLAN.md, 46.17).
  - Условие, все три сразу: ответ ровно `NSCocoaErrorDomain` 513
    (`NSFileWriteNoPermissionError`); файл в iCloud
    (`cloud_files::is_icloud_item`, `isUbiquitousItemAtURL`); система
    называет для файла папку Корзины, и эта папка уже есть:
    `URLForDirectory:NSTrashDirectory inDomain:NSUserDomainMask
    appropriateForURL:<файл> create:NO`. Папку Корзины Mine не создаёт и по
    пути не угадывает.
  - Ответы системы на этом Маке 15.10.2026: для файла в iCloud Drive
    (`~/Library/Mobile Documents/com~apple~CloudDocs/…` и папки приложений
    вроде `iCloud~md~obsidian`) это `~/Library/Mobile Documents/.Trash`,
    папка есть; туда же `fileproviderd` кладёт файл, который Корзина взяла
    (журнал: `FS snapshot mutation: update<… p:trash …>`). Для папки на
    Рабочем столе, который синхронизирует iCloud, система называет
    `~/Desktop/.Trash`, а такой папки нет: запасного переноса нет. Для самих
    `~/Desktop` и `~/Documents` система отвечает ошибкой 3328: тоже без
    запасного переноса.
  - Перенос: одно исключающее переименование (`util::rename_exclusive`,
    `RENAME_EXCL`) в эту папку, только в пределах тома; занятое имя не
    заменяется никогда. Имя то же, что даёт Корзина macOS при совпадении:
    полное имя, время по местным часам `ЧЧ-ММ-СС-ммм` и снова расширение,
    `Проба.md 19-33-38-545.md`, у файла без расширения `noext 19-33-38-595`
    (проверено `trashItemAtURL` на отдельном томе APFS 15.10.2026). Если в ту
    же миллисекунду занято и это имя, перед расширением встаёт номер:
    `Проба.md 19-33-38-545 2.md`.
  - Ответ тот же, что у `trashItemAtURL`: место файла в Корзине
    (`TrashedTo::Path`). Поэтому сверка байтов, проверка, что ушёл именно
    этот файл, и откат («Checked publication») работают без изменений. В
    журнал пишется строка WARN `trash fallback:` с путём файла, ответом
    системы и новым местом: по ней считаются случаи.
  - Любая другая ошибка, файл не в iCloud, нет папки Корзины или сбой
    переименования (строка WARN в журнал): прежний отказ `TrashRefused`,
    файл на месте, ничего не удалено.
  - Put Back: `trashItemAtURL` записывает место возврата в `.DS_Store`
    папки Корзины (записи `ptbL` и `ptbN`, проверено на отдельном томе APFS
    15.10.2026). Формат этого файла не документирован, открытого API для
    записи нет, поэтому запасной перенос места возврата не записывает. В
    `~/Library/Mobile Documents/.Trash` файла `.DS_Store` нет, место возврата
    там держит сам `fileproviderd`; предложит ли Finder Put Back для файла,
    перенесённого запасным путём, проверяется вживую. Без Put Back файл
    возвращается из Корзины перетаскиванием.
  - Пакетное удаление `files::delete_user_files` (Orphans, архив
    конфликтов) идёт через крейт `trash` и запасного переноса не имеет.
- Корзина модульных тестов (`files::test_trash`) ведёт себя как настоящие
  (13.10.2026): занятое имя не заменяется, файл получает имя вида
  `Проба 2.md 15-15-18-508.md`, как в Корзине тома APFS; у файла со второй
  жёсткой ссылкой рядом уходит вторая ссылка, как в Корзине iCloud (худший
  случай: Корзина iCloud сделала так один раз из двух).
- `delete_block_files` сохраняет legacy contract: удаляет `.md`, slug-owned primary media `<slug>.<ext>` и derived thumbnail.
- `delete_block_files_with_media_paths` получает уже проверенный higher-level deletion plan и удаляет `.md`, перечисленные media paths и derived thumbnail.
- Shared/orphan решение не принимается в storage layer; оно принадлежит `commands::blocks::prepare_delete_block`.

### Поведение media reference resolution

- `storage::media_refs` is the single backend resolver for local media
  references used by index, thumbnails, media dimensions, thumb upgrades, and
  inline-media extraction.
- `frontmatter.file` accepts canonical `[[name.ext]]` and legacy raw
  `name.ext`; both resolve through the same frontmatter media resolver.
- `![alt](path)` follows Markdown semantics: `path` is note-relative only.
- `![[name.ext]]` follows Obsidian attachment semantics: same-directory path
  first, then basename lookup through the vault, excluding hidden/service/build
  dirs.
- `![[folder/name.ext]]` uses the explicit path, checked note-relative and then
  vault-root-relative.
- Derived DB fields store resolved vault-root-relative paths when the file is
  found. Source Markdown is not rewritten on read.
- Запасной путь asset-протокола (`resolve_basename_under`: адрес
  `<пространство>/<имя>`, файла по нему нет) ищет имя по указателю имён
  пространства, который хранится в процессе: он отвечает, пока файл по
  найденному пути на месте, а имя, которого он не знает или знает по пути,
  где файла больше нет, обходит папку заново не чаще раза в 2 с на
  пространство (`NAME_INDEX_REFRESH`). До 13.10.2026 каждый запрос
  картинки этим путём обходил всё пространство (SPEC_DEEP_AUDIT.md, Е2.19,
  Н5).

### Поведение rename_derived_artifacts

- Переименовывает только local derived artifacts, не source vault:
  - block-level thumbnail `thumbs/<slug>.jpg`
    - stable path/key; file content may be JPEG or PNG
    - app `asset://` protocol must serve MIME by magic bytes, not extension
  - article audio artifacts и sidecar через `storage::article_audio::rename_all_artifacts`
- Используется и watcher external rename path, и explicit in-app rename command
- Если higher-level rename flow меняет speakable article text, audio может быть дополнительно инвалидирован поверх этого helper'а
- Генерация article audio выключена (см. `SPEC_ARTICLE_AUDIO.md`), но
  обслуживание уже существующих артефактов — переименование, инвалидация,
  удаление вместе с блоком — остаётся скомпилированным намеренно: иначе аудио,
  созданное до отключения, зависло бы в derived store навсегда

### Поведение persist_new_reference_block

- Записывает только новый `.md` файл.
- Не копирует media-файл и не объявляет новый блок владельцем `frontmatter.file`.
- Генерирует thumbnail через общий `generate_for_block`, то есть из уже существующего файла, на который указывает `frontmatter.file`.
- Индексирует блок и синхронизирует thumbnail metadata так же, как `persist_new_block`.
- Используется для inline-media extraction: новый media-card копирует ссылку
  на media из исходной статьи, а не бинарный файл, и пишет empty body. Source
  article body is not changed.
- Will be used for text-selection extraction: новый article-блок копирует
  selected text snapshot и related-note reference; media copy не выполняется.

### Text selection extraction storage contract

Text-selection extraction writes two source-vault files in the successful path:

1. Source article `.md`: patched only if the first selected Markdown block lacks
   a native Obsidian block id.
2. New excerpt card `.md`: normal Mine article block with `Mine Collections`,
   `Mine Related Notes: [[Source#^block-id]]`, and snapshot body.

Storage rules:

- Source patch must preserve every byte outside the inserted ` ^block-id`
  suffix.
- Source patch must not add frontmatter, sidecar metadata, hidden comments, or
  backlinks.
- New excerpt card does not own any media file and must not influence media
  cleanup planning.
- Thumbnail generation for the new excerpt uses the normal text-thumbnail path.
- Relationship indexing must preserve the full block-reference target for
  display/opening and expose the base note target for existence checks and
  rename rewrite.
- In-app rename of a source note must rewrite `[[Old#^id]]` to `[[New#^id]]`
  in body wikilinks and in `Mine Related Notes`.

---

## storage/thumbnails

Генерация превью: resize для изображений, text-to-image для статей, unified cascade через `generate_for_block`.

> **Note**: Этот раздел описывает Rust-side API модуля `storage/thumbnails`. Полная архитектура thumbnail pipeline (включая WebView upgrade path, event flow, Phase 1/Phase 2 разделение) — в [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md). Следующие функции — это building blocks, вызываемые из shared dispatch `generate_for_block`.

### Функции

```rust
generate_thumbnail(source: &Path, dest: &Path, max_size: u32) -> Result<(u32, u32)>
generate_text_thumbnail(display_title: Option<&str>, body: &str, dest: &Path) -> Result<(u32, u32)>
is_thumb_fresh(thumb_path: &Path, source_path: &Path) -> bool
generate_for_block(block: &Block, vault: &VaultLayout) -> ThumbSource
is_image_ext(ext: &str) -> bool
is_video_ext(ext: &str) -> bool
```

### Поведение — generate_thumbnail (изображения)

- Читает исходное изображение (JPEG, PNG, WebP, GIF)
- Ресайз с сохранением пропорций: макс. сторона = `max_size` (по умолчанию 480px, 2x Retina)
- Сохраняет как JPEG (quality 85)
- Возвращает (width, height) результата
- Если изображение меньше max_size — сохраняет как есть (без увеличения)

### Поведение — generate_text_thumbnail (micro previews and text content)

- Создаёт PNG 480x480 с прозрачным фоном для theme-adaptive rendering
- Рисует заголовок (шрифт 1.3x, цвет #333) и тело статьи (шрифт 24px, цвет #505050)
- Очищает markdown: заголовки, жирный/курсив, ссылки `[text](url)` → text
- Word-wrap по ширине с учётом метрик шрифта
- Шрифт: Geist Regular (Latin + Cyrillic), встроен через `include_bytes!`, парсится один раз через `LazyLock<FontArc>`

### Поведение — is_thumb_fresh (проверка свежести)

- Сравнивает mtime миниатюры и исходного файла
- **Дополнительно валидирует magic bytes** thumb-файла: первые 3 байта должны матчить `FF D8 FF` (JPEG) или `89 50 4E` (PNG), а конец файла должен быть концом целой картинки этого формата (`thumb_disk_state`; SPEC_THUMBNAILS.md, П10). Файлы с другим content считаются не fresh и force regenerate — защита от legacy state, где text PNG оставались под `.jpg` расширением forever
- Возвращает `true` если миниатюра существует, свежая по mtime, и имеет валидное image content
- Используется в `full_scan` и `index_md_file` для пропуска избыточной генерации

### Поведение — generate_for_block (unified cascade)

Единая точка входа для thumbnail generation. Вызывается и из native host (Phase 1 at save time), и из watcher handler (full_scan, index_md_file). Cascade с graceful fallback chain:

1. `frontmatter.file` указывает на existing image → `generate_thumbnail`
   (`file` may be canonical `[[...]]` or legacy raw syntax on read)
2. `frontmatter.file` указывает на existing video → `generate_video_thumbnail` (с fallback к text при ошибке)
3. `frontmatter.thumbnail` field указывает на existing image → `generate_thumbnail`
4. First existing local embedded media in body (`![[local_file]]`, `![[local_file|alt]]`, legacy `![](local_file)`) in markdown order:
   - если первым идёт video → `generate_video_thumbnail` (с fallback через дальнейший article media cascade)
   - если первым идёт image → multi-image composite / `generate_thumbnail`
5. Later body media fallback:
   - usable article images → composite или single-image thumbnail
   - first local video → `generate_video_thumbnail` (с fallback к text при ошибке)
6. Media-bearing blocks whose source cannot be decoded by Rust remain typed
   `browser_decode_required`/failed for the feed recipe. A text micro-preview may
   still exist for Sidebar diagnostics, but cannot satisfy media readiness.
7. Runtime card kind is `article` or `link` → text recipe; an optional micro
   thumbnail may be generated for compact Sidebar surfaces.

`storage::preview_plan::resolve_upgrade_media` owns browser-upgrade source
selection. Watcher and `list_pending_thumb_upgrades` pass the same indexed
`PreviewUpgradeInput` (`media_file`, `thumbnail`, ordered `media_urls`, then
legacy `first_image`) and cannot maintain independent cascades. Derived-preview
reconciliation separately validates `card_kind + block_type + media_file`
against the persisted manifest before it may publish `Ready`.

Для inline video `preview_manifest.tiles[].preview_path` не должен указывать
на derived `<video-stem>.jpg`, пока такой per-video thumbnail реально не
создаётся. Video tiles используют block-level `<slug>.jpg` poster fallback.

Возвращает `ThumbSource` enum (`Image | Video | Text | None`) для telemetry и определения необходимости WebView upgrade (см. SPEC_THUMBNAILS.md Phase 2).

### Поведение — is_image_ext / is_video_ext

Предикаты расширений для dispatching. Один список на всё пространство
(SPEC_DEEP_AUDIT.md, Е5.16): `IMAGE_MEDIA_EXTS` и `VIDEO_MEDIA_EXTS` в
`mine_core::domain::block`; `preview_plan`, `thumbnails`, размеры медиа
(`media_dimensions`), Orphans и вид карточки спрашивают его. До 13.10.2026
списков было пять, и в списке размеров не было TIFF.
- `is_image_ext`: `jpg | jpeg | png | gif | webp | bmp | tiff | tif | heic | heif | avif`
- `is_video_ext`: `mp4 | webm | m4v | mov`

Что Rust декодирует, решает не расширение, а первые байты файла
(`thumbnails::is_rust_decodable`): JPEG, PNG, GIF и неанимированный WebP.
Остальные картинки и видео ждут браузер (WebView upgrade). Размер видео
читается только из контейнеров MP4 (`mp4`, `m4v`), которые понимает читатель
`mp4`.

### Оптимизации

- **O1 — пропуск свежих**: `is_thumb_fresh()` перед каждой генерацией
- **O2 — LazyLock**: шрифт парсится один раз за время жизни процесса
- **O3 — фоновая генерация**: `full_scan()` индексирует синхронно, миниатюры генерирует в потоке `thumb-gen`, по завершении вызывает `on_thumbs_done` callback
