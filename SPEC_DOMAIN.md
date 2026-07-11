# SPEC: domain layer (collection, tag, channel, vault, search)

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)

Модули domain layer, кроме эталонного domain/block. Все чистые — нет зависимостей от Tauri, SQLite, файловой системы.

---

## domain/collection

`domain/collection` is the current Mine collection identity module.

Collection membership is stored in `Mine Collections` as quoted Obsidian
wikilinks. Runtime identity is the wikilink target (`CollectionRef`), not a
normalized tag.

### Constants and functions

```rust
const MINE_COLLECTIONS_FIELD: &str = "Mine Collections";

normalize_collection_ref(raw: &str) -> String
collection_ref_from_canonical_value(raw: &str) -> Option<String>
collection_wikilink_value(collection_ref: &str) -> String
render_collections(collections: &[String]) -> String
patch_collections_frontmatter(content: &str, collections: &[String]) -> Result<String, String>
```

### Behavior

- `normalize_collection_ref` trims whitespace, unwraps `[[target]]`, and drops
  an optional wikilink alias after `|`.
- It must not lowercase, kebab-case, collapse spaces, or treat
  `Красивый веб` and `красивый-веб` as the same identity.
- `collection_ref_from_canonical_value` accepts only canonical wikilink string
  values such as `[[Красивый веб]]` or `[[Research|Board]]`.
- `render_collections` writes quoted wikilinks:

```yaml
Mine Collections:
  - "[[Красивый веб]]"
```

- `patch_collections_frontmatter` preserves user-owned `tags` and unknown YAML
  fields while surgically replacing only `Mine Collections`.

## domain/tag

Legacy tag helper retained for one-time migration from old normalized Mine
collection values. Normal runtime collection identity must not use
`normalize_tag`.

Тег — old normalized string wrapper. It is no longer the canonical collection
model.

### Тип

```rust
struct Tag(String);
```

Обёртка над нормализованной строкой. Гарантирует: непустая, нормализованная, <= 60 символов.

### Нормализация

```
normalize_tag(raw: &str) -> String
```

1. Обрезать пробелы по краям (trim)
2. Перевести в нижний регистр (Unicode-aware)
3. Заменить пробелы и `_` на `-`
4. Заменить последовательные `-` на один
5. Убрать `-` с краёв

Примеры:
- `"Web Design"` -> `"web-design"`
- `"  ВЕРСТКА "` -> `"верстка"`
- `"distributed_systems"` -> `"distributed-systems"`
- `"---foo---"` -> `"foo"`
- `"already-valid"` -> `"already-valid"`

### Функции

```rust
Tag::new(raw: &str) -> Result<Tag, TagError>  // normalize + validate
Tag::as_str(&self) -> &str
normalize_tag(raw: &str) -> String
```

### Ошибки

```rust
enum TagError {
    Empty,                    // пустая строка после нормализации
    TooLong { len: usize },  // больше 60 символов после нормализации
}
```

### Edge cases

| # | Случай | Ожидание |
|---|---|---|
| T1 | `""` | TagError::Empty |
| T2 | `"   "` | TagError::Empty |
| T3 | `"---"` | TagError::Empty (после нормализации — пусто) |
| T4 | `"Web Design"` | `"web-design"` |
| T5 | `"ВЕРСТКА"` | `"верстка"` |
| T6 | Строка 100 символов | TagError::TooLong |
| T7 | `"already-valid"` | `"already-valid"` |
| T8 | `"  multiple   spaces  "` | `"multiple-spaces"` |

---

## domain/channel

Канал — promoted collection page, отображаемая в боковой панели как постоянный
пункт навигации.

### Типы

```rust
struct Channel {
    tag: String,               // CollectionRef; physical name kept for API/DB compatibility
    description: Option<String>,
    color: Option<String>,     // hex-цвет, например "#FF5733"
    icon: Option<String>,      // имя иконки
    position: u32,             // порядок в sidebar (0 = верх)
    created_at: DateTime,      // из domain::block::DateTime
}
```

### Функции

```rust
Channel::new(tag: &str, created_at: DateTime) -> Result<Channel, ChannelError>
Channel::update_position(&mut self, position: u32)
validate_color(color: &str) -> bool   // hex: #RGB или #RRGGBB
```

### Ошибки

```rust
enum ChannelError {
    EmptyTag,
    InvalidColor { value: String },
}
```

### Поведение

- `Channel::new` derives `tag` via `normalize_collection_ref`, not `normalize_tag`.
- Channel has no separate display title. UI display text is derived from the
  Markdown collection ref / filename target.
- `color` валидируется: `#RGB` или `#RRGGBB` (hex)
- Human filenames such as `Красивый веб.md` remain valid collection pages.
- Collection refs may be URL-encoded for routes, but must not be lowercased or
  kebab-cased as domain identity.

### Edge cases

| # | Случай | Ожидание |
|---|---|---|
| C1 | Пустой тег | ChannelError::EmptyTag |
| C2 | Title не указан | title = collection ref label with first character uppercased |
| C3 | `color: "#FF5733"` | Валидно |
| C4 | `color: "#FFF"` | Валидно (shorthand) |
| C5 | `color: "red"` | ChannelError::InvalidColor |
| C6 | `color: "#GGGGGG"` | ChannelError::InvalidColor |

---

## domain/vault

Чистая логика путей vault. Вычисление путей к файлам, директориям, разрешение конфликтов slug. Без доступа к файловой системе.

### Типы

```rust
struct VaultLayout {
    root: PathBuf,
}
```

### Функции

```rust
VaultLayout::new(root: PathBuf) -> Self
VaultLayout::root(&self) -> &Path
VaultLayout::block_path(&self, slug: &str) -> PathBuf       // root/slug.md
VaultLayout::media_path(&self, slug: &str, ext: &str) -> PathBuf  // root/slug.ext
VaultLayout::arena_dir(&self) -> PathBuf                     // root/.arena/
VaultLayout::index_db_path(&self) -> PathBuf                 // root/.arena/index.db
VaultLayout::thumbs_dir(&self) -> PathBuf                    // root/.arena/cache/thumbs/
VaultLayout::thumb_path(&self, slug: &str) -> PathBuf        // root/.arena/cache/thumbs/slug.webp

// Валидация slug для безопасного использования в путях
validate_slug(slug: &str) -> Result<(), VaultError>

// Чистое разрешение конфликтов slug (без FS)
resolve_slug_conflict(slug: &str, existing: &HashSet<String>) -> String
```

### Поведение resolve_slug_conflict

- Если `slug` нет в `existing` -> `slug`
- Если есть -> `slug-2`, если и он есть -> `slug-3`, и так далее
- Максимум 1000 попыток, затем паника (невозможная ситуация)

### Edge cases

| # | Случай | Ожидание |
|---|---|---|
| V1 | `block_path("sunset-tokyo")` | `root/sunset-tokyo.md` |
| V2 | `media_path("sunset-tokyo", "jpg")` | `root/sunset-tokyo.jpg` |
| V3 | `arena_dir()` | `root/.arena/` |
| V4 | `thumb_path("sunset-tokyo")` | `root/.arena/cache/thumbs/sunset-tokyo.webp` |
| V5 | `resolve_slug_conflict("slug", {})` | `"slug"` |
| V6 | `resolve_slug_conflict("slug", {"slug"})` | `"slug-2"` |
| V7 | `resolve_slug_conflict("slug", {"slug", "slug-2"})` | `"slug-3"` |
| V8 | `resolve_slug_conflict("slug", {"slug", "slug-3"})` | `"slug-2"` (пропуск дыр) |

---

## domain/search

Парсинг поисковых запросов в структурированную форму для route filtering,
lexical search, alias/transliteration expansion и semantic retrieval.

### Типы

```rust
struct SearchQuery {
    text: String,                    // исходный пользовательский текст
    literal_terms: Vec<String>,      // токены для lexical/prefix search
    normalized_terms: Vec<String>,   // lowercase/diacritic-normalized terms
    alias_terms: Vec<String>,        // aliases/transliteration/localized terms
    semantic_text: Option<String>,   // полный запрос для embedding search
    language_hint: Option<String>,   // best-effort script/language hint
    filters: Vec<SearchFilter>,
}

enum SearchMatchKind {
    Exact,
    Prefix,
    Fuzzy,
    Alias,
    Semantic,
}

enum SearchFilter {
    Type(CardKind),                  // type:media / type:article / type:link / type:channel
    Tag(String),                     // tag:design
}
```

### Функции

```rust
parse_search_query(input: &str) -> SearchQuery
SearchQuery::is_empty(&self) -> bool
SearchQuery::has_filters(&self) -> bool
```

### Синтаксис запроса

```
type:image tag:design sunset tokyo
```

- `type:X` — фильтр по derived card kind. X = media, article, channel; legacy
  aliases image/link/video/file map to media
- `tag:X` — фильтр по тегу
- Всё остальное — свободный текст для lexical + semantic search
- Несколько фильтров одного типа: AND (все должны совпасть)
- Неизвестные фильтры (например `foo:bar`) — трактуются как текст
- Пустой запрос — `SearchQuery { text: "", filters: [] }`
- `language_hint` и alias expansion не являются фильтрами: они влияют на recall
  и ranking, но не должны исключать результаты.
- Semantic query сохраняет исходную фразу целиком, чтобы русский запрос мог
  найти английский контент по смыслу.

### Edge cases

| # | Случай | Ожидание |
|---|---|---|
| S1 | `""` | text="", filters=[] |
| S2 | `"sunset tokyo"` | text="sunset tokyo", filters=[] |
| S3 | `"type:image"` | text="", filters=[Type(Image)] |
| S4 | `"type:image sunset"` | text="sunset", filters=[Type(Image)] |
| S5 | `"tag:design tag:web"` | text="", filters=[Tag("design"), Tag("web")] |
| S6 | `"type:image tag:design sunset tokyo"` | text="sunset tokyo", filters=[Type(Image), Tag("design")] |
| S7 | `"type:unknown"` | text="type:unknown", filters=[] (неизвестный тип — текст) |
| S8 | `"foo:bar"` | text="foo:bar", filters=[] (неизвестный фильтр — текст) |
| S9 | `"  type:image  sunset  "` | text="sunset", filters=[Type(Image)] (пробелы нормализованы) |
