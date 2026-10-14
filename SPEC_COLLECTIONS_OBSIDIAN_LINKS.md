# SPEC: Obsidian-First Collections

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_OBSIDIAN_MARKDOWN_COMPAT.md](SPEC_OBSIDIAN_MARKDOWN_COMPAT.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md)

## Status

Implemented for normal runtime writes and reads. The source migration is handled
by the reviewable CLI:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin migrate-collections-to-wikilinks --features tooling -- --dry-run <vault>
cargo run --manifest-path src-tauri/Cargo.toml --bin migrate-collections-to-wikilinks --features tooling -- --apply <vault>
```

The SQLite schema still contains legacy physical names (`channels.tag`,
`block_tags.tag`), but their semantic value is now `CollectionRef`. Legacy
normalized values and raw `Mine Collections` values are migration inputs only,
not normal runtime formats.

`blocks.collection_index_version` protects the derived SQLite read model from
older parser rules. On upgrade, Mine may rebuild `block_tags` from source
Markdown in the local index only; this is not a source-file migration and must
not rewrite user files.

Решение пользователя 10.10.2026: коллекция существует только как файл `.md`
с `type: channel`. Контракт записан в разделе «Коллекция существует только
как страница (решение 10.10.2026)» в конце документа; реализовано 10.10.2026
([PLAN.md](PLAN.md), Phase 44, этапы с 44.2 по 44.10), живая приёмка за
пользователем.

Контракт Н2 из [SPEC_DEEP_AUDIT.md](SPEC_DEEP_AUDIT.md), одна операция на
каждое действие с коллекцией: раздел «Одна операция на каждое действие с
коллекцией (13.10.2026)» в конце документа, правила с К12 по К15;
реализовано 13.10.2026.

## Decision

Mine collections are Obsidian pages.

Membership is stored as quoted Obsidian wikilinks in the Mine-owned
`Mine Collections` property:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
  - "[[Design References]]"
```

The collection page itself is a normal Markdown file with a human-readable
filename:

```markdown
---
type: channel
saved_at: 2026-04-29T12:00:00Z
position: 0
---
```

File:

```text
Красивый веб.md
```

Not:

```text
красивый-веб.md
```

## Goals

- Make Mine collection membership visible in Obsidian as ordinary note links.
- Keep `tags` fully user-owned; Mine must not use Obsidian `tags` as its
  canonical collection field.
- Keep files human-readable: collection names in source files should be the
  names users see in Mine and Obsidian.
- Stop using kebab/lowercase normalized filenames as collection identity.
- Preserve collection order and collection metadata in collection pages.
- Use a one-time, reviewable migration instead of indefinite legacy support.

## Non-Goals

- No metadata is embedded into binary image/video files.
- No hidden UUID is written to cards or collection pages.
- No central SQLite-only source of truth for collection membership.
- No automatic rewrite of source Markdown on ordinary read/index/open.
- No use of `tags` as Mine collections after migration.

## Source Format

### Card Membership

Canonical post-migration format:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
```

Rules:

- The YAML value is a string containing an Obsidian wikilink.
- The string must be quoted because `[` and `]` are YAML flow-collection
  characters.
- The wikilink target is the collection page target.
- Mine writes the target without alias by default.
- Aliases may be read for compatibility, but Mine should not create aliases
  unless a future explicit UX requires them.

Accepted read examples for the canonical parser:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
  - "[[Design/References]]"
  - "[[Research|Research board]]"
```

For `[[target|alias]]`, Mine collection identity is `target`, not `alias`.

### Collection Page

Collection pages are ordinary `.md` files in the vault:

```yaml
---
type: channel
position: 12
saved_at: 2026-04-29T12:00:00Z
---
```

Rules:

- The filename is the primary human-readable Obsidian page target.
- Mine does not write or read a separate collection `title`; display text comes
  from the filename / wikilink target.
- `position` stores sidebar order.
- Future collection metadata such as color, icon, or description belongs on
  the collection page.

## Identity

Runtime identity is `CollectionRef`, derived from the Obsidian wikilink target.

Normalization is intentionally minimal:

- Unicode normalization at filesystem boundaries is allowed.
- Path separator handling follows the same rules as Obsidian link targets.
- URL routes percent-encode the ref.
- Mine must not lowercase, kebab-case, collapse spaces, or otherwise normalize
  different page names into one identity.

Examples that must remain distinct when the filesystem can represent them:

```text
Красивый веб
красивый-веб
Красивый-Веб
```

On default macOS case-insensitive filesystems, case-only duplicates may not be
representable. That is a filesystem limitation, not a Mine normalization rule.

## Write Contract

After migration, every Mine write path writes only the canonical wikilink
format:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
```

Affected paths:

- web clipper save;
- app create/save;
- drag card to collection;
- checkbox connect/disconnect in Detail sidebar;
- inline media extraction;
- collection rename;
- перестановка коллекций: пишет `position` только в существующие страницы
  коллекций и страниц не создаёт (раздел «Коллекция существует только как
  страница», К6).

Mine must not create or update `frontmatter.tags` for collection membership.

## Legacy Policy

Legacy support is migration-only, not a permanent runtime contract.

The migration tool reads old collection encodings:

```yaml
tags:
  - красивый-веб

Mine Collections:
  - Красивый веб

Mine Collections:
  - красивый-веб
```

The app's normal runtime does not treat these forms as collection membership.
If a legacy form appears after migration, the fix is to rerun the migration
tool rather than silently maintaining a second source format.

User-owned Obsidian `tags` are preserved. The migration must not delete or
rewrite `tags` unless the user explicitly chooses a cleanup mode for files that
are proven Mine-authored legacy files.

Local indexes created by older versions may still contain user-owned Obsidian
`tags` in `block_tags`. Runtime startup and native-host channel listing must
run the versioned collection-index backfill, replacing those stale rows with
memberships parsed only from `Mine Collections`.

## Migration Plan

### M1. Dry Run

Scan the vault and report:

- files with legacy Mine collections in `tags`;
- files with raw `Mine Collections` values;
- existing collection pages with normalized filenames;
- proposed canonical `Mine Collections` wikilink values;
- proposed collection page renames;
- conflicts and ambiguous mappings.

No source file changes in dry-run.

Implemented by `migrate-collections-to-wikilinks --dry-run`.

### M2. Backup

Before apply, create timestamped backups of every file that will be changed.
The backup must be enough to restore the exact previous bytes of each file.

Implemented by `migrate-collections-to-wikilinks --apply`, which writes
timestamped byte backups under `.mine-migration-backup/`.

### M3. Collection Page Rewrite

For each collection:

1. Choose the human page name from existing `title` if present, otherwise from
   the best available display name.
2. Rename normalized collection files to human filenames when safe.
3. If two collection pages are materially different, keep both as distinct
   pages instead of collapsing them.
4. If two files conflict at the same path, stop and report the conflict instead
   of overwriting.

Implemented for root collection pages. Nested Obsidian targets are reported as
conflicts by the migration CLI instead of being guessed.

### M4. Card Membership Rewrite

For each card:

1. Convert Mine-owned collection membership to quoted wikilinks.
2. Write only `Mine Collections`.
3. Preserve user-owned `tags`.
4. Preserve unrelated frontmatter fields, comments, ordering, and scalar style
   as far as the existing patcher can safely do so.

Implemented for normal runtime writes and the migration CLI.

### M5. Rebuild And Verify

After apply:

- rebuild the local index;
- compare collection counts before and after;
- verify sidebar order from collection page `position`;
- open sample files in Obsidian and confirm graph links from cards to
  collection pages;
- verify clipper/app writes produce only canonical wikilink values.

## Storage Migration Notes

The current schema names (`channels.tag`, `block_tags.tag`) are legacy names.
During implementation they may either be:

1. renamed to collection-oriented names, or
2. kept as physical column names while their semantic meaning changes to
   `collection_ref`.

Either way, the data stored after migration must be the Obsidian collection ref,
not a normalized tag.

`block_tags` is a derived read model. Its rows must be rebuilt from
`Mine Collections` when `blocks.collection_index_version` is absent or older
than the current parser version. Rebuilding this table must not mutate the
Markdown source.

## Frontend Migration Notes

Routes should encode collection refs instead of normalized tags. The UI label is
the collection page display name. Drag/drop, checkbox connect/disconnect, and
sidebar filtering all operate on `CollectionRef`.

## Acceptance Criteria

- A new saved card writes `Mine Collections: ["[[Name]]"]`.
- Obsidian graph links the card to the collection page.
- `tags` remains untouched by Mine collection operations.
- Human collection filenames are not auto-canonicalized to kebab/lowercase.
- Existing vault files can be migrated in one explicit apply step.
- After migration, no normal Mine write path emits raw collection strings or
  legacy `tags` membership.
- After upgrade, stale `block_tags` rows derived from Obsidian `tags` disappear
  after the background collection-index backfill.
- Проверки решения 10.10.2026 о коллекции только как странице: раздел
  «Коллекция существует только как страница», «Проверки».

## Коллекция существует только как страница (решение 10.10.2026)

Статус: решение пользователя 10.10.2026, контракт записан 10.10.2026,
реализовано 10.10.2026 (этапы с 44.2 по 44.10 в [PLAN.md](PLAN.md), Phase 44);
живая приёмка за пользователем. Решения реализации, которых не было в
контракте, записаны в подразделе «Уточнения реализации (10.10.2026)».
Архитектурное решение: [ARCHITECTURE.md](ARCHITECTURE.md), 055.

### Правила

**К1. Коллекция есть, только если есть её страница.** Страница коллекции это
файл `.md` с `type: channel`. Только такие коллекции знают боковое меню, выбор
коллекций (меню `Connect` карточки, открытая карточка, строки поиска и Related
notes, групповое выделение, переключатель коллекций верхней панели, клиппер),
счётчики, Graph View, CLI `mine` и MCP. Пустая страница тоже коллекция: она в
списке со счётчиком 0.

**К2. Ссылка на имя без страницы.** Значение `Mine Collections` карточки, цель
которого не совпадает ни с одной страницей коллекции (К4), Mine:

- не показывает нигде: ни в боковом меню, ни в ряду коллекций карточки
  ([SPEC_CARD_STATES.md](SPEC_CARD_STATES.md), С8.9), ни в выборе коллекций,
  ни в строке `Collections` поиска, ни в графе, ни в выводе CLI и MCP;
- не считает ни в одном счётчике;
- не трогает: не переписывает, не удаляет, не переносит. Любая запись
  `Mine Collections` (присоединение или отсоединение другой коллекции,
  переименование коллекции, слияние карточек) оставляет такую ссылку на её
  месте в списке. Запись строится из текста файла, а не из индекса, поэтому
  фильтр чтения (К9) не может потерять ссылку при записи.

В Obsidian такая ссылка видна как неразрешённая.

**К3. Страница появилась, членство вернулось.** Страницу с этим именем
создали (в Mine или в Obsidian) или вернули её файл (из Корзины, из
резервной копии, синхронизацией): карточки снова в коллекции без записи в
карточки и без их переиндексации. Наблюдатель индексирует страницу в
`channels`, и пара с уже записанными строками `block_tags` даёт членство (К9).
Удаление страницы вне Mine (Finder, Obsidian) прячет коллекцию из всех мест
К1; ссылки в карточках остаются.

**К4. Совпадение ссылки и страницы.** Правило прежнее: цель ссылки
(`CollectionRef`) равна `channels.tag` страницы. Если у двух страниц одно имя
файла, их `CollectionRef` содержат путь (`collection_ref_for_slug`), поэтому
короткая ссылка `[[Имя]]` не совпадает ни с одной из них и членством не
считается. Ссылка с папкой `[[Collections/Имя]]` совпадает со страницей по
этому пути (`channels.source_slug`), как её открывает Obsidian: коллекция
показывается под `channels.tag` страницы, запись пишет обычную форму, а ссылку
с папкой Mine не переписывает (13.10.2026). Отсоединение, удаление и
переименование коллекции находят обе формы одним правилом
(`link_names_collection`); переименование оставляет ссылку с папкой с папкой
и новым именем страницы (`renamed_collection_link`).

**К5. Mine не создаёт страницу побочным действием.** Страницу создают только
явные команды создания коллекции:

- боковое меню: `+`, ⇧⌘N, бросок карточки на строку создания, `Enter` в
  `Find or create...`; `Create collection` в переключателе коллекций верхней
  панели;
- `Create collection` в выборе коллекций карточки и группового выделения:
  сначала `create_channel`, затем присоединение к коллекции, которую дала
  страница (`handleCreateTagFromMenu` и `handleCreateTagFromBatchMenu` в
  [App.tsx](src/App.tsx)). До 10.10.2026 этот путь вызывал `addTag` без
  `createChannel` и сам порождал ссылки без страницы;
- новая карточка в новой коллекции из перетащенного медиа или выделенного
  текста (уже вызывает `createChannel`);
- новая коллекция в клиппере: `create_channel` помощника пишет файл первым
  (`handle_create_channel` в [native_host.rs](src-tauri/src/bin/native_host.rs)),
  папка браузера пишет страницу командой ядра `Collection`;
- импорт канала Are.na: до записи карточек импорт берёт страницу коллекции с
  этим именем, а если её нет, создаёт её так же, как `create_channel`. Имя
  проходит те же правила, что имя новой коллекции; отказ правил останавливает
  импорт этого канала до записи карточек, причина приходит в `errors`
  результата импорта (`import_channel` в
  [importer.rs](src-tauri/src/import/importer.rs); так требует и UC-09 в
  [SPEC_USECASES.md](SPEC_USECASES.md)). До 10.10.2026 импорт писал только
  ссылки;
- `mine collection create` и инструмент MCP `collection_create`.

**К6. Перестановка не создаёт страниц.** `reorder_channels` пишет `position`
только в существующие страницы. Элемент запроса, у которого страницы нет,
пропускается: файл не создаётся, остальные позиции записываются, а
перечитанный список показывает настоящее состояние. Так же уже пропускаются
строки индекса, чья страница принадлежит другой коллекции. Убраны ветка
`None if !tag.contains('/')`, которая выбирала путь новой страницы, ветка
`SourceFileWrite::create`, построение `Channel::new` для коллекции без строки
в `channels` и строка документации «Tags without channel entries are
auto-created» (`reorder_channels_unannounced` и `reorder_channels_blocking` в
[channels.rs](src-tauri/src/commands/channels.rs)).

**Место новой коллекции** (SPEC_DEEP_AUDIT.md, Е6.2, 13.10.2026). Новая
коллекция встаёт первой в ручном порядке по одному правилу mine-core
`new_collection_position` (`domain/channel.rs`): `position` на единицу меньше
самой малой позиции коллекций пространства, `0` в пространстве без коллекций,
страница без `position` считается за `0`. Правилом пользуются все пути
создания: `create_channel` приложения (все места интерфейса), `mine collection
create` и MCP `collection_create`, импорт Are.na (через `create_channel_inner`
и `index::new_channel_position`), `create_channel` помощника клиппера (та же
`index::new_channel_position`) и папка браузера (команда ядра `collection`
получает позиции страниц папки полем `positions`, `standaloneVault.js` берёт их
тем же чтением заметок, что список коллекций). Пишется только страница новой
коллекции, другие страницы не меняются. Поэтому `position` знаковая (`i64` в
`Channel`, `Frontmatter`, `CollectionPage`, `ChannelDto`): после нескольких
созданий страницы получают `position: -1`, `-2` и так далее; страницы с
позициями от нуля читаются, как читались. Перестановка нумерует порядок от
самой малой позиции и пишет только сдвинутые страницы (К6). До 13.10.2026
приложение после `createChannel` вызывало `reorderChannels`, ставило новую
коллекцию на `0` и переписывало позиции всех остальных страниц, а остальные
пути ставили коллекцию последней.

**К7. Присоединение требует страницы.** Отказывает каждый путь, который
пишет новую ссылку в `Mine Collections`:

- команда `add_tag`: бросок карточки на строку коллекции и в открытую
  коллекцию, `Connect` в выборе коллекций, групповое присоединение;
- создание карточки сразу в коллекции: `create_block` (поле `tags`),
  `create_media_asset_card`, `extract_text_selection` (поле `target_tag`);
  команды `extract_inline_media` нет с 13.10.2026 (срез 46.10);
- `mine connect` и инструмент MCP `connect` (`set_collection_membership` в
  [cli_mutations.rs](src-tauri/src/cli_mutations.rs); до 10.10.2026 он писал
  ссылку на любое имя без проверки);
- `mine card create --collection` и инструмент MCP `card_create` с
  `collection`;
- `save_block` клиппера у обоих исполнителей, для каждой выбранной коллекции.

Все пути вызывают один помощник проверки. Страница ищется тем же поиском, что
у переименования, удаления и Reveal in Finder (`collection_document_for_mutation`
в [channels.rs](src-tauri/src/commands/channels.rs)): по файлам на диске, а не
только по строке индекса. Неоднозначное имя отказывает той же ошибкой
неоднозначности, что у этих команд. Проверка идёт до записи; при отказе файл
карточки остаётся байт в байт прежним.

Ошибки типизированы и называют коллекцию:

- приложение: новый вариант `CommandError::CollectionNotFound { collection }`
  с текстом `collection "<имя>" has no page; nothing was written`; он
  попадает в сгенерированные привязки (`bun run bindings:generate`). Команды
  со своими типами ошибок (`InlineMediaExtractError`, `MediaAssetActionError`,
  `TextSelectionExtractError`) получают такой же вариант. В интерфейсе отказ
  идёт тем же путём, что прочие отказы присоединения: снимки перечитываются, и
  коллекция без страницы уходит из списков;
- CLI: новый вариант `MutationError::CollectionNotFound { collection }`, код
  возврата 4 (не найдено), в stderr `no collection "<имя>": its page does not
  exist; create it with mine collection create`. `mine cards --collection
  <имя>` по имени без страницы отвечает тем же кодом и текстом;
- MCP: `isError: true` с текстом stderr, как у прочих отказов инструмента;
- клиппер: новый код ядра `SaveErrorCode::CollectionNotFound`
  (`collection_not_found`) с именем коллекции, отказ до эффектов
  (`outcome: not_committed`, `terminal_rejected: true`). Факты о страницах
  собирает исполнитель, правило проверки одно, в ядре: помощник ищет файл
  страницы с `type: channel` (`<папка коллекций>/<имя>.md`, в плоском
  пространстве `<корень>/<имя>.md`, или там, где страницу видел готовый
  индекс; строка `channels` без файла страницей не считается, уточнение 16),
  папка браузера ищет тот же файл через свой доступ к папке. Попап
  показывает причину под списком коллекций и перечитывает `list_channels`;
  коллекция без страницы уходит из выбора, клип остаётся в открытом
  клиппере, повторный Save сохраняет без неё.

**К8. Отсоединение без проверки.** `disconnect` (`remove_tag`,
`mine disconnect`, инструмент MCP `disconnect`, групповое `Disconnect`)
снимает ссылку и тогда, когда страницы нет. В интерфейсе такая ссылка не
видна (К2), поэтому снять её можно из CLI, MCP или в Obsidian.

**К9. Чтение: членство это пара с `channels`.** `block_tags` по-прежнему
хранит каждую ссылку `Mine Collections`: это отражение файла, а не членство.
Членство это строка `block_tags`, для которой есть строка `channels` с тем же
`tag` или с этим путём страницы (К4); имя коллекции берётся из `channels.tag`. Все чтения, которые показывают или считают коллекции, берут только
членство через одно общее условие (общий фрагмент SQL в
[block_queries.rs](src-tauri/src/storage/block_queries.rs)), без своего
фильтра в каждом месте:

- `get_all_tags` (`TaxonomySnapshot.tags`, `TagCount`): счётчики коллекций;
- `collections_column_sql` (`LightBlock.collections`): ряд коллекций
  карточки, строки поиска и Related notes;
- `IndexedBlock.tags` у `get_block`: отметки в выборе коллекций, строка
  `Collections` в поиске, проверка членства при броске, вывод `mine card`;
- `list_block_collections` (`TaxonomySnapshot.memberships`): подсветка С3 и
  С4 ([SPEC_CARD_STATES.md](SPEC_CARD_STATES.md));
- `list_grid_blocks`, `count_current_collection_cards` и
  `list_preview_blocks_by_tag` для коллекции;
- фильтр `tag:` в поиске;
- `build_graph_snapshot` ([graph.rs](src-tauri/src/storage/graph.rs)): узлы
  коллекций только из `channels`, ребро членства только к такому узлу. До
  10.10.2026 узел создавался и по ссылке карточки.

Список коллекций:

- приложение: `orderedTags` в [App.tsx](src/App.tsx) строится только из
  `channels` по `position`; часть `noPos` (названия из карточек без страницы)
  убрана. Место вкладки `/channel/<имя>` существует, только если имя есть
  в `channels` (до 10.10.2026 хватало `tags`); иначе место становится
  Everything ([SPEC_TABS.md](SPEC_TABS.md), В18);
- ядро: `mine_core::domain::collection::list_collections` отдаёт только
  страницы в ручном порядке со счётчиками; часть `named_only` убрана. По
  нему строит список папка браузера в клиппере;
- помощник клиппера: `list_channels` отдаёт только страницы
  (`merge_channels_and_tags` в [native_host.rs](src-tauri/src/bin/native_host.rs)
  без названий из карточек);
- CLI `mine collections` и инструмент MCP `collections`: страницы коллекций со
  счётчиками карточек, пустая страница со счётчиком 0; порядок прежний (по
  числу карточек, затем по имени).

**К10. Reveal in Finder.** У каждой строки коллекции в боковом меню есть
страница, поэтому `collection_page_path` находит её всегда. Пункт недоступен,
только пока путь ищется (`pagePath === undefined` в
[Sidebar.tsx](src/components/Sidebar.tsx)). Неоднозначное имя (несколько
страниц с одним именем) обрабатывается как сейчас: команда отвечает ошибкой
неоднозначности, пункт недоступен. Ответ без пути бывает только в гонке,
когда страницу удалили вне Mine, пока открывалось меню: пункт недоступен, а
наблюдатель убирает строку.

**К11. Данные.** На 10.10.2026 коллекций без страницы во всех трёх
пространствах пользователя ноль (страниц коллекций 30, 4 и 3). Миграция
данных не нужна. Ссылки без страницы, которые появятся позже (страницу
удалили вне Mine, ссылку написали в Obsidian), остаются в файлах по К2.

### Что не меняется

- Формат `Mine Collections`, формат страницы коллекции, `CollectionRef`,
  порядок по `position`.
- Удаление коллекции в приложении снимает ссылки во всех карточках и
  отправляет страницу в Корзину. С 13.10.2026 это одна команда бэкенда и
  для CLI и MCP (К12).
- Переименование требует страницы и без неё уже отказывает; ошибка
  становится `CollectionNotFound`.
- Слияние карточек объединяет их `Mine Collections` вместе со ссылками без
  страницы ([SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md)).

### Проверки

Rust:

- индекс: ссылка без страницы не попадает в `get_all_tags`,
  `LightBlock.collections`, `IndexedBlock.tags`, `list_block_collections` и
  ленту коллекции; запись страницы с этим именем в `channels` возвращает
  членство без переиндексации карточки; удаление страницы снова его прячет;
- ядро: `list_collections` отдаёт только страницы, пустую со счётчиком 0,
  одинаково нативно и в WASM (общие примеры `save-fixtures.json`);
- перестановка: запрос с элементом без страницы не создаёт файлов (список
  файлов пространства до и после совпадает), позиции существующих страниц
  записаны;
- `add_tag` и команды создания карточки в коллекции к имени без страницы:
  `CollectionNotFound`, ничего не записано; `remove_tag` такой ссылки её
  снимает;
- присоединение и отсоединение другой коллекции у карточки со ссылкой без
  страницы сохраняют эту ссылку; слияние таких карточек тоже;
- граф: ссылка без страницы не даёт ни узла, ни ребра;
- CLI: фикстура в [cli.rs](src-tauri/src/cli.rs) получает страницу
  `Nature.md` с `type: channel`, и `lists_collections_with_counts`,
  `lists_cards_of_a_collection`, `connect_disconnect_and_restore_round_trip` и
  проверка «чтение не меняет индекс» идут против неё. Новый тест: `connect` к
  имени без страницы отвечает кодом 4 и не меняет файл, `disconnect` такой
  ссылки её снимает, `collections` и `card` её не показывают,
  `cards --collection` по имени без страницы отвечает кодом 4,
  `card create --collection` без страницы отказывает до записи;
- MCP: `connect` к имени без страницы возвращает `isError: true`;
- помощник клиппера: `list_channels` без названий из карточек; `save_block` с
  коллекцией без страницы отказывает до записи с `collection_not_found`;
- импорт Are.na: канал без страницы получает страницу до записи карточек,
  канал с существующей страницей её переиспользует.

Интерфейс (Vitest):

- боковое меню без коллекций-ссылок: при `tags` с именем без страницы
  `orderedTags` и счётчик коллекций верхней панели его не содержат;
- место `/channel/<имя без страницы>` становится Everything;
- `Create collection` в выборе коллекций карточки и группового выделения
  вызывает `createChannel`, затем присоединение;
- Reveal in Finder недоступен до ответа `collection_page_path` и доступен
  после ответа с путём.

Клиппер (`bun run test:clipper-worker`): папка браузера показывает только
страницы коллекций; Save с коллекцией, чью страницу удалили после открытия
клиппера, ничего не пишет и показывает причину.

Живая приёмка за пользователем:

- удалить страницу коллекции в Finder: коллекция уходит из бокового меню,
  выбора коллекций и графа, файлы карточек не меняются; вернуть файл из
  Корзины: коллекция возвращается со всеми карточками;
- переставить коллекции: в папке пространства не появляется новых файлов;
- Reveal in Finder у любой коллекции открывает её страницу.

### Уточнения реализации (10.10.2026)

Реализация упёрлась в вопросы, на которые контракт не отвечал. В каждом
выбрано самое осторожное решение.

1. **Общее условие членства.** Это фрагмент соединения
   `JOIN channels <страница> ON <страница>.tag = <ссылка>.tag`
   (`collection_membership_join_sql` в
   [block_queries.rs](src-tauri/src/storage/block_queries.rs)). Его берут все
   чтения из К9 и ещё поиск по месту коллекции в
   [search_engine.rs](src-tauri/src/storage/search_engine.rs) (лента коллекции
   с текстом поиска). `channels.tag` уникален, поэтому соединение строк не
   повторяет.
2. **Отражение файлов остаётся без условия.** `list_blocks_by_tag` ищет все
   карточки, чьи `Mine Collections` называют имя, есть страница или нет: по
   нему переименование и удаление коллекции находят файлы, которые
   переписывают, после сверки индекса с диском (К13). Переименование ещё и
   читает заметки, которые ссылаются на страницу (К14). Ничего не показывает
   и не считает.
3. **Перестановка пишет только найденные байты.** Страница, которую индекс
   знает, но файла которой уже нет, пропускается так же, как имя без
   страницы. Запись заменяет ровно те байты, с которыми страница найдена:
   страница, изменённая или удалённая после поиска, отказывает всей
   перестановке ошибкой `SourceChanged` и не создаётся заново.
4. **Переименование в гонке.** Если страница пропала между планом и записью,
   переименование отвечает `CollectionNotFound` и новой страницы не создаёт.
5. **Старая команда `rename_tag`.** Интерфейс её не вызывал; она удалена
   13.10.2026 (срез 46.10). Переименование коллекции идёт только через
   `rename_channel`.
6. **Присоединение к уже записанной ссылке.** `add_tag` и `mine connect`
   проверяют страницу до всего остального, поэтому имя без страницы
   отказывает, даже когда карточка уже его называет. Отказ один и тот же при
   любом состоянии карточки.
7. **CLI и индекс.** `mine connect` и `mine card create --collection` ищут
   страницу на диске тем же поиском, что `mine collection rename` и
   `delete`, с соединением с индексом только для чтения. `mine collections`
   и `mine cards --collection` читают страницы из `channels` готового
   индекса, как остальные чтения CLI. Имя, общее для нескольких страниц, в
   CLI отказывает той же ошибкой неоднозначности, что у этих команд (код 3).
8. **Ошибка ядра несёт имя.** У `SaveError` появилось поле `collection`: имя
   коллекции у `collection_not_found`, `null` у остальных кодов. Клиент не
   читает имя из текста. Правило проверки в ядре
   (`mine_core::save::require_collection_pages`), для папки браузера оно
   доступно командой ядра `collection_pages`. Ответ помощника и папки
   браузера при отказе несёт `code: collection_not_found` и `collection`.
9. **Факты исполнителей.** Помощник и папка браузера ищут файл
   `<папка коллекций>/<имя>.md` с `type: channel`, а у имени с путём ещё и
   `<корень>/<имя>.md`. Помощник смотрит ещё туда, где страницу видел
   готовый индекс (`source_slug` строки `channels`), но саму строку
   страницей не считает (уточнение 16); если индекс не читается, остаётся
   только диск (запись в журнал помощника).
10. **Попап клиппера.** Причина стоит под списком коллекций, в месте ошибки
    создания коллекции, словами `Collection “<имя>” has no page, so nothing
    was saved. Save again to save the clip without it.` Над кнопкой Save
    второй строки нет. Причина снимается при следующем Save.
11. **Импорт Are.na.** Страница ищется и имя проверяется до скачивания
    канала: отказ имени не тратит сеть. Новая страница создаётся после
    скачивания и до первой карточки: сбой скачивания не оставляет пустой
    страницы. `channel_title` результата называет коллекцию, в которую легли
    карточки; при занятом имени заметки она получает первое свободное имя,
    как у `create_channel`.
12. **Create collection в выборе коллекций.** Карточка присоединяется к
    коллекции, которую вернул `createChannel` (первое свободное имя, если имя
    занято заметкой). Имя проверяется по мере набора той же командой
    `check_collection_name`, что во всех местах создания, и отклонённое имя
    не даёт строки создания (SPEC_DEEP_AUDIT.md, Е6.2). Отказ создания ничего
    не присоединяет; у одной карточки и у группового выделения он одинаково
    уведомление вкладки `Could not create the collection` с причиной, затем
    снимки перечитываются (до 13.10.2026 у одной карточки отказ уходил в
    консоль). Выделение присоединяется одной командой `set_blocks_membership`.
13. **Отказ в интерфейсе.** Текст `CommandError` вида `collection_not_found`:
    `Collection “<имя>” has no page; nothing was written.` Команды со своим
    типом ошибки (бросок медиа, выделенного текста, создание карточки из
    медиа) при `collection_not_found` перечитывают снимки, как прочие отказы
    присоединения.
14. **Описания инструментов MCP.** `connect` и поле `collection` у
    `card_create` говорят, что коллекция без страницы отказывает и что
    страницу создаёт `collection_create`.
15. **Счётчик коллекций верхней панели.** Его нет: строку со счётчиком
    рисовала только раскладка `alt2`, удалённая 13.10.2026 (срез 46.10).
    Проверка идёт по строкам бокового меню и пунктам переключателя коллекций
    верхней панели, которые строятся из того же списка.
16. **Строка индекса не страница (живая приёмка 10.10.2026).** Случай: в
    клиппере создана коллекция в пространстве, которое не открыто в
    приложении, выбрана, её файл убран в Корзину, Save прошёл и записал
    ссылку на коллекцию без страницы. Помощник считал коллекцию со
    страницей, если у неё есть строка `channels` готового индекса, а без
    наблюдателя эта строка переживает файл. Правило: страница есть, только
    когда её файл с `type: channel` лежит на диске. Строка индекса только
    подсказывает, где искать файл (`source_slug`, у строки без него сам
    `tag`), и общий путь `index::channel_page_slugs` отдаёт только эту
    подсказку. Где правило теперь применено:
    - Save помощника (`collections_with_pages` в
      [native_host.rs](src-tauri/src/bin/native_host.rs)): файл ищется там,
      где его видел индекс, в папке коллекций и по пути имени; без файла
      отказ `collection_not_found` до записи;
    - список коллекций помощника (`read_indexed_channels`, перед
      `merge_channels_and_tags`): строка без файла в список не попадает,
      поэтому после отказа перечитанный список коллекцию больше не
      показывает. Файл, содержимое которого iCloud держит вне этого Mac,
      считается страницей без чтения. С 13.10.2026 это одно правило для
      списка, Save и `create_channel` помощника: ни один не ждёт загрузки
      (SPEC_DEEP_AUDIT.md, Н7, Е4.6); до этого Save такую страницу
      скачивал и читал;
    - `create_channel` помощника: «коллекция уже есть» решает файл на
      диске, а не строка. Коллекцию, чья страница ушла без наблюдателя, можно
      создать заново под тем же именем (раньше отказ `channel already
      exists`), а новая строка записывает путь страницы (раньше путь не
      записывался);
    - проверка имени новой и переименуемой коллекции в приложении, CLI
      `mine collection create` и `rename`, инструменте MCP `collection_create`
      и импорте Are.na (`refuse_collection_called` в
      [channels.rs](src-tauri/src/commands/channels.rs)): строка, у которой
      на диске нет страницы, имени не занимает. Диск проверяется только для
      строки с этим именем; страница, которую не удалось прочитать, имя
      занимает.

    Без изменений: присоединение в приложении, CLI и MCP уже искало
    страницу на диске (`require_collection_page`), папка браузера индекса не
    имеет. Переименование коллекции по-прежнему отказывает словами `A file
    named "<имя>.md" already exists.`, если в индексе осталась строка файла
    с путём новой страницы (`index::slug_exists`); это общая проверка
    свободного имени файла, она только отказывает и уходит при сверке
    пространства. Чтения CLI (`mine collections`, `mine cards --collection`)
    идут по готовому индексу (уточнение 7).

    Проверки: помощник (`a_collection_whose_page_left_unwatched_is_neither_saved_into_nor_listed`,
    `a_note_that_stopped_being_a_page_is_neither_saved_into_nor_listed`,
    `a_collection_whose_page_left_unwatched_can_be_created_again`,
    `a_save_finds_a_page_through_a_ready_index`), приложение
    (`a_collection_whose_page_left_unwatched_can_be_created_again` в
    [channels.rs](src-tauri/src/commands/channels.rs)), CLI
    (`a_collection_whose_page_left_with_the_app_closed_is_no_collection_for_writes`
    в [cli.rs](src-tauri/src/cli.rs)).

## Одна операция на каждое действие с коллекцией (13.10.2026)

Статус: контракт Н2 из [SPEC_DEEP_AUDIT.md](SPEC_DEEP_AUDIT.md) (находки
Е1.3, Е1.4, Е1.5, Е1.6), реализовано 13.10.2026 ([PLAN.md](PLAN.md), Phase 46,
срез 46.3). Интерфейс, CLI `mine` и MCP вызывают одни и те же функции бэкенда
в [channels.rs](src-tauri/src/commands/channels.rs).

### Правила

**К12. Удаление коллекции одной командой.** `delete_channel` (интерфейс),
`mine collection delete` и инструмент MCP `collection_delete` зовут
`delete_channel_inner`. Оно снимает ссылку `Mine Collections` у каждой
карточки, у которой она есть, и отправляет страницу в Корзину одной
мутацией вместе с индексом (`StagedSourceMutation::commit_with_index`).
Каждая карточка и страница пишутся только поверх байтов, с которыми их
прочитали ([SPEC_AUDIT_FIXES.md](SPEC_AUDIT_FIXES.md), Ф2): правка снаружи
между чтением и записью отказывает всей операции (`SourceChanged`), ни один
файл не меняется. Ответ `CollectionDeleted { deleted, kept_links }`.

- Карточку, которую нельзя прочитать (нет доступа, не UTF-8) или чьи
  свойства нельзя изменить на месте (`FrontmatterNotWritable`), удаление
  пропускает: её файл остаётся байт в байт, ссылка остаётся, имя карточки
  попадает в `kept_links`. Удаление коллекции она не останавливает. Такая
  ссылка дальше живёт по К2: Mine её не показывает; новая страница с этим
  именем вернёт эту карточку в коллекцию по К3.
- Интерфейс делает один вызов (`handleDeleteTagFromAll` в
  [App.tsx](src/App.tsx)). Сбой: уведомление `Could not delete the
  collection` со строкой `Nothing changed.` и текстом ошибки. Непустой
  `kept_links`: уведомление `Links kept` с текстом `“<имя файла>” could not
  be changed and still links to “<коллекция>”.` для одной карточки и `<N>
  elements could not be changed and still link to “<коллекция>”.` для
  нескольких (`src/lib/deleteFailure.ts`). Тексты выбраны при реализации,
  пользователь их не утверждал.
- Команда `delete_tag_from_all` удалена: после перехода интерфейса на одну
  команду её никто не вызывал.

**К13. Переименование видит участников, сверенных с диском.** Перед
переименованием и удалением коллекции индекс сверяется с файлами
(`reconcile_vault`, «Мутации коллекций ждут сверки так же, как чтения»).
Карточка, присоединённая в Obsidian, пока Mine был закрыт, участник
наравне с остальными.

**К14. Переименование переписывает всё, что ведёт к странице.** Страница
переезжает, а заметки, которые на неё ссылаются, переписываются планом
переименования карточки (`plan_note_move` в
[blocks.rs](src-tauri/src/commands/blocks.rs)): ссылки `[[Имя]]`,
`[[Имя|подпись]]` и Markdown-ссылки в тексте, `Mine Related Notes`. В том же
проходе у каждой прочитанной заметки имя коллекции меняется в
`Mine Collections` на своём месте в списке; участник из индекса, до которого
проход не дошёл, дописывается. Всё пишется одной мутацией поверх прочитанных
байтов, индекс отражает записанные файлы (`project_source_path`). Свойства,
которые нельзя изменить на месте, отказывают всему переименованию
(`FrontmatterNotWritable`), ни один файл не меняется.

**К15. Страница коллекции остаётся коллекцией.** Переименование страницы как
заметки (`rename_block_file`, `mine card rename`, инструмент MCP
`card_rename`) выполняет переименование коллекции по К13 и К14; имя с другой
папкой отказывает словами `A collection stays in its folder: type its name
without /.`. Правка полей, тела и членства страницы через CLI и MCP
индексирует её как коллекцию (`channels`), а не как карточку (`blocks`).

### Проверки

- CLI на настоящих файлах во временном пространстве
  (`source_fidelity_tests` в [cli.rs](src-tauri/src/cli.rs)):
  `deleting_a_collection_takes_its_links_off_and_a_new_page_starts_empty`,
  `renaming_a_collection_finds_members_the_index_missed_and_rewrites_links`,
  `card_rename_of_a_collection_page_renames_the_collection`,
  `card_set_on_a_collection_page_keeps_it_a_collection`;
- MCP: `collection_tools_keep_membership_whole` в
  [mcp.rs](src-tauri/src/mcp.rs);
- приложение: `deleting_a_collection_takes_its_links_off_past_a_card_it_cannot_read`
  и `renaming_a_collection_moves_a_member_the_index_had_not_seen` в
  [channels.rs](src-tauri/src/commands/channels.rs);
- интерфейс: `tells that the collection was not deleted and that nothing
  changed` и `names the elements that still link a deleted collection` в
  [App.test.tsx](src/App.test.tsx).
