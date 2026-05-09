# Спецификация извлечения inline-медиа

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_MEDIA_ASSET_ACTIONS.md](SPEC_MEDIA_ASSET_ACTIONS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)

## Status

This document describes the original inline-image extraction slice. The
canonical product contract for current media interactions is
[SPEC_MEDIA_ASSET_ACTIONS.md](SPEC_MEDIA_ASSET_ACTIONS.md): frontmatter media
and body-embedded media must behave identically, actions target the local media
file, and sidebar drag uses the generalized `media_asset` payload.

## Цель

Пользователь может открыть статью в `Detail`, взять конкретное inline-изображение из тела статьи и перетащить его на коллекцию в sidebar. Mine создаёт новый самостоятельный блок в этой коллекции, содержащий только выбранное изображение и метаданные происхождения. Исходная статья не меняется.

Это не перетаскивание целой карточки. Это отдельное содержимое drag-события для медиа внутри открытой заметки.

## Продуктовый контракт

### Пользовательский сценарий

1. Пользователь открывает article-блок в `Detail`.
2. В теле статьи есть локальное inline-изображение, отрендеренное из `![[name.jpg]]` или legacy `![alt](name.jpg)`.
3. Пользователь тянет именно изображение.
4. Пользователь бросает изображение на коллекцию в sidebar.
5. В целевой коллекции появляется новый image-блок.
6. Новый блок содержит только это изображение, URL источника из исходной статьи, если он есть, и одностороннюю связь на исходную заметку.
7. Исходная статья не получает обратную ссылку и не переписывается.

### Что не входит в v1

| Область | Решение |
|---|---|
| Удалять изображение из исходной статьи | Нет. Извлечение означает копирование ссылки на медиа, а не перенос |
| Добавлять backlink в исходную статью | Нет. Связь строго односторонняя |
| Remote images | Нет. v1 принимает только локальные медиа-ссылки внутри vault |
| Multi-select media drag | Нет. Одно перетаскивание создаёт один блок |
| Video/audio extraction | Не входит в первый срез реализации. Модель данных резервирует `media_kind`, но интерфейс включает только изображения |
| Drop на `Everything` | Нет. Создание требует конкретной коллекции |

## Формат файла

### Новый извлечённый блок

Пример результата для извлечения `Source Article (image 1).jpg` из статьи `Source Article.md` в коллекцию `Inspiration`:

```markdown
---
type: image
file: "[[Source Article (image 1).jpg]]"
url: https://example.com/source-article
Mine Collections:
  - "[[Inspiration]]"
Mine Related Notes:
  - "[[Source Article]]"
Mine Source Media: Source Article (image 1).jpg
saved_at: 2026-04-28T12:00:00Z
source: inline-media-extraction
---
```

### Поля

| Поле | Обязательно | Значение |
|---|---:|---|
| `type` | да | `image` для v1 |
| `file` | да | Та же локальная media-ссылка, которая была извлечена из исходной статьи |
| `url` | нет | URL источника, скопированный из исходного блока |
| `Mine Collections` | да | Целевая коллекция из drop на sidebar как quoted Obsidian wikilink |
| `Mine Related Notes` | да | Односторонняя связь на исходную заметку как Obsidian wikilink |
| `Mine Source Media` | да | Исходная media-ссылка внутри исходной заметки |
| `saved_at` | да | Время создания |
| `source` | да | Literal `inline-media-extraction` |

### Тело заметки

Тело содержит ровно один media embed, указывающий на тот же media-файл, что и исходная статья:

```markdown
![[<source-media-ref>]]
```

Без текста статьи, подписи и обратной ссылки отдельным абзацем. Связь с исходной заметкой живёт во frontmatter, поэтому тело остаётся самим извлечённым медиа.

`frontmatter.file` и body wikilink — живые ссылки на существующий media-файл в vault. `Mine Source Media` — строка происхождения: она фиксирует, какая media-ссылка была извлечена при создании блока. Если исходную статью позже переименовали и её собственное семейство медиафайлов получило новые имена, `frontmatter.file` и body wikilink обновляются через общий rename path, а `Mine Source Media` может остаться историческим исходным значением.

Inline-media extraction follows [SPEC_DISPLAY_TITLE.md](./SPEC_DISPLAY_TITLE.md):
it does not synthesize `title:` frontmatter from alt text or media stem. Alt
text may be used later as an explicit caption, and the media stem may seed the
filename, but neither becomes a generated metadata title.

## Модель владения

Извлечение копирует ссылку на исходный media-файл, а не сам бинарный файл. Новый блок является самостоятельным `.md`, но не становится владельцем media-файла исходной статьи.

Причины:

| Подход | Проблема |
|---|---|
| Copy media into new block-owned filename | Создаёт лишний бинарник и ломает пользовательское ожидание: это выглядит как перенос/дубликат медиа, а не извлечение карточки из существующей статьи |
| Reuse source media file | Требует явного lifecycle-контракта, но сохраняет Obsidian-readable структуру и не плодит невидимые копии |

Выбранное поведение:

1. Source file stays in place.
2. No new media file is copied.
3. New block `frontmatter.file` and body wikilink both point to the original `media_ref`.
4. Deleting the new image block deletes only its `.md` and derived artifacts; it must not delete the shared media file.
5. New block slug generation must avoid `<shared-media-stem>.<ext>` ownership collisions, because legacy primary-media cleanup is slug-based.
6. Renaming the new image block does not rename the shared media file unless the media is rewritten by a separate source-note rename map.

## Контракт связи

### Односторонняя связь

Извлечённый media-блок указывает на исходную статью. Исходная статья не указывает обратно.

```yaml
Mine Related Notes:
  - "[[Source Article]]"
```

Правила:

1. Values are Obsidian wikilinks, not raw file paths.
2. Parser normalizes each value to a target slug by stripping `[[...]]` and optional alias.
3. Indexer inserts these targets into the existing `wikilinks` relation table in addition to body wikilinks.
4. `IndexedBlock` exposes `related_notes: string[]` for Detail metadata rendering.
5. In-app rename of the source note must rewrite `Mine Related Notes` in every parseable `.md` file, exactly like body wikilinks.
6. External rename keeps the current resilience contract: no silent vault-wide rewrite.

### Метка в интерфейсе

Метаданные `Detail` показывают это поле как `RELATED NOTES`. Каждая цель открывает связанную заметку, если она существует. Отсутствующие цели рендерятся как неактивный текст.

## Контракт команды

### Tauri command

```rust
#[tauri::command(rename_all = "snake_case")]
async extract_inline_media(
    state: State<'_, AppState>,
    source_slug: String,
    media_ref: String,
    target_collection_ref: String,
) -> Result<IndexedBlock, InlineMediaExtractError>
```

### Параметры

| Параметр | Значение |
|---|---|
| `source_slug` | Filename stem of the open source article |
| `media_ref` | Local media reference as it appears after render-boundary decode, for example `Source Article (image 1).jpg` |
| `target_collection_ref` | Obsidian collection ref from sidebar drop |

### Валидация

1. `source_slug` must pass existing filename validation.
2. Source block must exist and be parseable.
3. Source block must be `article` or an implicit article. Other source types are rejected in v1.
4. `media_ref` must be a local leaf filename, not absolute, not remote, not containing path separators.
5. `media_ref` must be present in the source block body according to the same dual-syntax parser used by `SPEC_OBSIDIAN_WIKILINKS.md`.
6. Resolved source media path must exist under the vault root.
7. File extension must be an image extension supported by Mine's image block contract.
8. `target_collection_ref` must be a valid collection ref and must not be
   lowercase/kebab-normalized as a tag.

### Алгоритм создания

1. Read and parse source block.
2. Verify `media_ref` belongs to source body.
3. Resolve source media file under vault root.
4. Generate a readable unique slug from media stem/source context through
   `suggest_slug` and `resolve_unique_slug`, while rejecting candidates whose
   `<slug>.<ext>` path already exists as the shared media file.
5. Do not copy source media.
6. Create a new compatibility `type: image` block with fields from `Source
   Format`, without generated `title:` frontmatter.
7. Write `.md` with canonical `file: "[[<media_ref>]]"` and empty body, so the
   derived runtime card kind is `media`.
8. Generate thumbnail from the existing referenced media file.
9. Index block, including `Mine Collections`, `Mine Related Notes`, media dimensions and preview manifest.
10. Emit `block:added` and `thumb:updated` through existing event paths.
11. Return `IndexedBlock` for immediate UI update.

### Ошибки

```rust
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum InlineMediaExtractError {
    NoVault,
    SourceNotFound { source_slug: String },
    SourceNotArticle { source_slug: String, block_type: String },
    InvalidMediaRef { reason: String },
    MediaNotReferenced { media_ref: String, source_slug: String },
    MediaNotFound { media_ref: String },
    UnsupportedMediaType { media_ref: String },
    Internal { message: String },
}
```

Фронтенд должен показать неразрушающую inline-ошибку или toast. Ошибка не закрывает `Detail`.

## Контракт фронтенда

### Drag payload

Существующее перетаскивание карточек использует `type: "block"`. Извлечение inline-медиа добавляет отдельный payload:

```ts
type InlineMediaDragPayload = {
  type: "inline_media";
  sourceSlug: string;
  mediaRef: string;
  mediaKind: "image";
};
```

Правила:

1. `type: "inline_media"` never falls through to `handleCardDrop`.
2. `id` uses a stable prefix, for example `inline-media:<sourceSlug>:<mediaRef>`.
3. Drag overlay previews the image itself, not the source article card.
4. Native browser image drag must be disabled on the rendered `<img>` to avoid conflicting drag ghosts.
5. Keyboard navigation in Detail remains unchanged.

### Поверхность активации

В v1 перетаскиваются только локальные изображения, отрендеренные в `ArticleBody`.

`DetailImage` receives optional extraction metadata:

```ts
type DetailInlineMediaExtraction = {
  sourceSlug: string;
  mediaRef: string;
};
```

Remote-изображения рендерятся как обычно, но не перетаскиваются для извлечения.

### Обработка drop

`App.tsx` handles `DragEndEvent` by payload type:

| Active payload | Drop target | Поведение |
|---|---|---|
| `block` | `collection:<ref>` | Existing connect-to-collection path |
| `inline_media` | `collection:<ref>` | New `extract_inline_media` command |
| `inline_media` | anything else | No-op |
| `collection:<ref>` | `collection:<ref>` | Existing reorder path |

После успешного извлечения:

1. Backend emits `block:added` and `thumb:updated`.
2. Frontend relies on the existing event-driven refresh path for grid, sidebar counts and previews; it must not force a full `reloadAllSnapshots()` from the drop handler.
3. If current route equals target collection, the new block appears in the current grid after the immediate event refresh.
4. Detail remains open on the source article.
5. The source article's selected collections and body are unchanged.
6. User-initiated extraction clears the default debounce and schedules this refresh immediately. The 2-second coalescing window is for watcher/background events, not for a direct drop interaction.

## Изменения бэкенда

### domain/block

Extend `Frontmatter` with Mine-owned related-note fields:

```rust
related_notes: Vec<String>,
source_media: Option<String>,
```

Имена при сериализации:

| Rust field | YAML field |
|---|---|
| `related_notes` | `Mine Related Notes` |
| `source_media` | `Mine Source Media` |

Правила парсинга:

1. Missing fields parse as empty / none.
2. `Mine Related Notes` accepts list of strings.
3. Each value may be raw slug or `[[slug]]`; serializer always writes wikilink form.
4. Invalid non-string list entries are ignored with index warning, not fatal.

### storage/index

Связанные заметки индексируются явно:

1. Add `related_notes TEXT` JSON column to `blocks`.
2. Populate `IndexedBlock.related_notes` from this JSON.
3. Insert related-note targets into `wikilinks` together with body wikilinks.
4. `list_grid_blocks` does not need `related_notes` in `LightBlock`.

### commands/blocks

Добавить `extract_inline_media` рядом с `create_block`, потому что операции нужны валидация исходного блока и metadata связи. Не перегружать `create_block`: его текущий контракт — общий импорт файла.

Команда должна быть async на IPC boundary и выполнять parse/write/thumbnail/index в blocking worker с короткоживущим SQLite connection. Она не должна держать `AppState.vault_state` mutex во время filesystem/thumbnail работы: из shared state берётся только `VaultLayout`, затем работа продолжается вне UI-facing command path.

Sidebar drop targets use the same hover contract for card drags and inline-media drags: `TagNavItem` disables `content-visibility` during any collection-drop drag and shows the same `isOver` ring for both payload types.

## Совместимость с Obsidian

Извлечённый блок должен быть полезен как обычный Markdown-файл:

1. Obsidian properties show `file` as a wikilink to the extracted image.
2. Obsidian properties show `Mine Related Notes` as a link to the source note.
3. No hidden IDs or UUIDs are introduced.
4. Filename-first identity remains unchanged.
5. Read path remains non-invasive for source article.

## План тестирования

### Rust unit tests

| Область | Сценарии |
|---|---|
| `domain/block` | parse/serialize `Mine Related Notes`, raw slug input, wikilink input, malformed list |
| `storage/index` | related notes stored on block, inserted into `wikilinks`, returned by `get_block` |
| `commands/blocks` | successful image extraction, source article untouched, shared media reference, no copied media file, delete extracted block leaves shared media, related notes, unsupported remote media, missing media, non-referenced media |
| rename | in-app rename source note rewrites `Mine Related Notes` in extracted block |

### Frontend tests

| Область | Сценарии |
|---|---|
| `Detail` | local article image receives `inline_media` drag payload |
| `Detail` | remote image is not draggable for extraction |
| `App` drag end | `inline_media` dropped on collection calls `extractInlineMedia`, not the card connect path |
| `App` drag end | source Detail remains open after successful extraction |
| `MetadataPanel` | `RELATED NOTES` renders links for related slugs |

### Ручная проверка

1. Open article with local inline image.
2. Drag image to a sidebar collection.
3. Verify new card appears in that collection.
4. Open new card and verify it displays the same image file as the source article.
5. Open new `.md` in Obsidian and verify body is empty and `file` is a
   wikilink to the media.
6. Verify frontmatter contains `Mine Related Notes` with source wikilink.
7. Verify original article file is byte-for-byte unchanged.
8. Rename source article in Mine and verify extracted block's `Mine Related Notes` updates.

## Критерии приёмки

- [ ] Local inline image in Detail can be dragged independently from the source article block.
- [ ] Dropping on sidebar collection creates a new image block in that collection.
- [ ] New block references the same media file as the source article; no copied media file is created.
- [ ] New block body is empty.
- [ ] New block `file` frontmatter is `[[source-media-ref]]`.
- [ ] New block frontmatter contains source URL if available.
- [ ] New block frontmatter contains one-way `Mine Related Notes` link to source article.
- [ ] Source article `.md` is not modified.
- [ ] Existing block drag-to-collection still works unchanged.
- [ ] Existing collection reorder still works unchanged.
- [ ] Unsupported remote or missing media fails without closing Detail.

## План реализации

| Срез | Объём | Проверка |
|---|---|---|
| 21.1 | Domain/frontmatter support for related notes and source media | Rust unit tests |
| 21.2 | Storage/index schema and wikilink indexing for related notes | Rust storage tests |
| 21.3 | `extract_inline_media` command with shared-media-reference semantics | Rust command tests |
| 21.4 | Detail image drag payload and media drag overlay | Frontend component tests |
| 21.5 | App drop routing and snapshot refresh | Frontend integration tests |
| 21.6 | Metadata UI for `RELATED NOTES` | Frontend component tests |
| 21.7 | Manual QA on real vault | Checklist above |
