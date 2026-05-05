# SPEC: domain/block

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_PRD.md](SPEC_PRD.md) | [SPEC_OBSIDIAN_MARKDOWN_COMPAT.md](SPEC_OBSIDIAN_MARKDOWN_COMPAT.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md)

Эталонный модуль. Все последующие модули следуют его паттернам качества, тестирования и документирования.

---

## Назначение

`domain/block` — чистая бизнес-логика работы с блоками. Блок — центральная единица данных Mine: `.md` файл с YAML frontmatter + опциональный медиафайл.

**Зависимости:** нет. Модуль не знает о Tauri, SQLite, файловой системе.
**Зависят от него:** storage/index, storage/files, commands/blocks, watcher/handler.

---

## Типы

### Source type and runtime card kind

Persisted `type` remains in Mine-authored Markdown for compatibility and import
provenance, but it is not the source of truth for feed/detail/search card
selection. The only runtime-special `type` value is `channel`, used as a
temporary explicit marker for collection documents.

Persisted/source type:

```rust
enum BlockType {
    Image,    // Изображение (PNG, JPG, WEBP, GIF, SVG)
    Article,  // Статья или фрагмент текста
    Link,     // Ссылка (URL без текстового контента)
    Video,    // Видео (MP4, MOV)
    File,     // Произвольный файл (PDF, ZIP, etc.)
    Channel,  // Collection page marker
}
```

**Маппинг строк:**
- `"image"` → `Image`
- `"article"` → `Article`
- `"link"` → `Link`
- `"video"` → `Video`
- `"file"` → `File`
- `"channel"` → `Channel`

Любое другое значение — ошибка `InvalidBlockType`.

Runtime/card kind:

```rust
enum RuntimeCardKind {
    Article, // body после frontmatter непустой
    Media,   // body пустой
    Channel, // collection document (`type: channel`)
}
```

Derivation:

1. `frontmatter.type == channel` → `RuntimeCardKind::Channel`.
2. Otherwise non-empty body → `RuntimeCardKind::Article`.
3. Otherwise empty body → `RuntimeCardKind::Media`.

Legacy `type: image/link/video/file/article` may still guide import/write
validation and migration, but feed/detail/search must consume the derived
runtime/card kind.

### Frontmatter

Структура YAML frontmatter из `.md` файла.

```rust
struct Frontmatter {
    block_type: BlockType,       // обязательное
    title: Option<String>,       // legacy read fallback; new write paths do not synthesize it
    description: Option<String>,
    url: Option<String>,
    file: Option<String>,        // canonical write: Obsidian wikilink string
    thumbnail: Option<String>,   // имя файла-миниатюры
    tags: Vec<String>,           // legacy physical field; semantic value is CollectionRef
    saved_at: DateTime,          // обязательное
    source: Option<String>,      // "browser-extension", "drag-drop", "manual", etc.
    width: Option<u32>,
    height: Option<u32>,
    author: Option<String>,
    related_notes: Vec<String>,  // Mine Related Notes wikilink targets
    source_media: Option<String>, // Mine Source Media provenance string
}
```

**Обязательные поля:** `block_type`, `saved_at`.
**Поведение при отсутствии обязательного поля:** ошибка `MissingRequiredField`.

Status: this is the strict Mine-authored frontmatter model. Obsidian
compatibility layers add optional implicit articles, collection membership is
stored in `Mine Collections` wikilinks, visible titles live in body H1, and
runtime card kind is derived from body emptiness except for `type: channel`.
The in-memory field remains `tags` as a legacy physical/API name, but its
semantic value is `CollectionRef`. See `SPEC_OBSIDIAN_MARKDOWN_COMPAT.md`,
`SPEC_COLLECTIONS_OBSIDIAN_LINKS.md`, and `SPEC_DISPLAY_TITLE.md`.

### Block

Полная модель блока: frontmatter + тело + метаданные файла.

```rust
struct Block {
    /// Имя .md файла без расширения (slug).
    /// Используется как идентификатор: "sunset-tokyo" для "sunset-tokyo.md".
    slug: String,

    /// Разобранный frontmatter.
    frontmatter: Frontmatter,

    /// Тело .md файла (после frontmatter). Может быть пустым.
    /// Non-empty body derives article runtime kind; empty body derives media.
    body: String,
}
```

### DateTime

Обёртка над строкой ISO 8601. Валидируется при парсинге.

```rust
struct DateTime(String);
```

**Допустимые форматы:**
- `2026-02-26T14:30:00Z`
- `2026-02-26T14:30:00+03:00`
- `2026-02-26` (только дата, без времени)

Невалидная строка — ошибка `InvalidDateTime`.

---

## Функции

### parse_frontmatter

Парсит строку YAML frontmatter в структуру `Frontmatter`.

```rust
fn parse_frontmatter(yaml: &str) -> Result<Frontmatter, BlockError>
```

**Поведение:**
- Пустая строка → `BlockError::EmptyFrontmatter`
- Невалидный YAML → `BlockError::YamlParse { source }`
- Отсутствует `type` → `BlockError::MissingRequiredField { field: "type" }`
- Неизвестный `type` → `BlockError::InvalidBlockType { value }`
- Отсутствует `saved_at` → `BlockError::MissingRequiredField { field: "saved_at" }`
- Невалидный `saved_at` → `BlockError::InvalidDateTime { value }`
- `file` accepts canonical `[[name.ext]]` and legacy raw `name.ext`; parser
  normalizes the in-memory value to the referenced filename/path
- `Mine Collections` отсутствует → `tags = vec![]` (не ошибка)
- `Mine Collections` содержит не-строки → `BlockError::InvalidTagValue`
- `Mine Related Notes` accepts string list values, normalizes Obsidian
  wikilinks to targets, and preserves block-reference fragments such as
  `Source#^block-id`
- `Mine Source Media` is optional provenance metadata
- `tags` in YAML is user-owned Obsidian metadata and is ignored by the strict
  Mine collection parser
- Неизвестные поля в YAML → игнорируются (forward compatibility)

### parse_block

Парсит полное содержимое `.md` файла в `Block`.

```rust
fn parse_block(slug: &str, content: &str) -> Result<Block, BlockError>
```

**Поведение:**
- Разделяет content на frontmatter и body по `---` маркерам
- Формат: `---\n<yaml>\n---\n<body>`
- Нет `---` маркеров → `BlockError::NoFrontmatter`
- Один `---` (нет закрывающего) → `BlockError::UnclosedFrontmatter`
- Frontmatter парсится через `parse_frontmatter`
- Body: всё после второго `---`, с удалением одного ведущего `\n`
- Body может быть пустым; empty body derives `media`, non-empty body derives
  `article`
- Пустой slug → `BlockError::EmptySlug`

### serialize_frontmatter

Сериализует `Frontmatter` обратно в YAML-строку.

```rust
fn serialize_frontmatter(frontmatter: &Frontmatter) -> String
```

**Поведение:**
- Всегда включает `type` и `saved_at`
- `None` поля не включаются в вывод
- `file` writes canonical Obsidian wikilink syntax, for example
  `file: "[[image.png]]"`; legacy raw filename input is not re-emitted on new
  writes
- Пустой `tags` vec — поле `Mine Collections` не включается
- Непустой `tags` vec serializes as quoted wikilinks under `Mine Collections`
- Непустой `related_notes` serializes as quoted wikilinks under
  `Mine Related Notes`
- `source_media` serializes as `Mine Source Media`
- Legacy `title` serializes only when already present in `Frontmatter`; new
  write paths must not synthesize it from filename, selected text, tweet text,
  alt text, or URL metadata
- Порядок полей: type, legacy title (only when present), description, url, file, thumbnail, Mine Collections, Mine Related Notes, Mine Source Media, saved_at, source, width, height, author

### derive_runtime_card_kind

Derives the read-model card kind used by feed/detail/search.

```rust
fn derive_runtime_card_kind(frontmatter: &Frontmatter, body: &str) -> RuntimeCardKind
```

Rules:

- `type: channel` always derives `channel`.
- Any non-empty body derives `article`, even if legacy/source `type` says
  `image`, `video`, `file`, or `link`.
- Empty body derives `media`.
- The function does not rewrite frontmatter.

### Display title

`frontmatter.title` is not the canonical display-title source for new data.
Mine derives visible title from content:

1. First H1 in body.
2. Existing `frontmatter.title` as legacy fallback.
3. Filename stem as final fallback label.

New Mine-authored blocks write real page/article titles as body H1, not as
`title:`. Social clips, text-selection quote cards, image/video/file imports,
and inline-media extraction media-cards must not generate artificial titles.
See
`SPEC_DISPLAY_TITLE.md`.

### serialize_block

Сериализует `Block` в полное содержимое `.md` файла.

```rust
fn serialize_block(block: &Block) -> String
```

**Поведение:**
- Формат: `---\n<yaml>\n---\n<body>` (если body непустое) или `---\n<yaml>\n---\n` (если пустое)
- Гарантия: `parse_block(slug, &serialize_block(block)) == Ok(block)` (roundtrip)

### extract_wikilinks

Извлекает `[[wikilinks]]` из тела блока.

```rust
fn extract_wikilinks(body: &str) -> Vec<String>
```

**Поведение:**
- `"text [[foo]] more [[bar]]"` → `["foo", "bar"]`
- `"![[image.png]]"` → `["image.png"]` (embed — тоже wikilink)
- `"[[]]"` → пустой vec (пустой wikilink игнорируется)
- `"[[ spaces ]]"` → `["spaces"]` (пробелы по краям обрезаются)
- `"no links here"` → `[]`
- Дубликаты удаляются: `"[[a]] [[a]]"` → `["a"]`
- Вложенные `[[foo [[bar]]]]` — парсится первый закрывающий: `["foo [[bar"]` — нет, такие конструкции невалидны. Берём первое `]]` после `[[`: результат `["bar"]`

### suggest_slug

Генерирует slug из человекочитаемого seed или URL.

```rust
fn suggest_slug(seed: Option<&str>, url: Option<&str>) -> String
```

**Поведение:**
- Из content heading / explicit seed: `"Как устроен CRDT"` → `"Как устроен CRDT"`
- Из URL (если seed нет): `"https://stripe.com/blog/api"` → `"stripe.com blog api"`
- Нет ни seed, ни URL → `"Untitled"`
- Seed может приходить из H1, page title, selected text, media filename, or
  another filename source. Passing a seed to `suggest_slug` must not imply that
  the same value is persisted as `frontmatter.title`.
- Unicode сохраняется; NFC-normalization применяется на boundary.
- Filesystem-hostile символы (`/`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, `\`, NUL) заменяются пробелом, whitespace runs схлопываются.
- Максимальная длина filename stem: `100` Unicode scalar chars и `220` bytes в NFD-представлении. Byte budget важнее char budget для macOS/iCloud: длинные CJK/Japanese имена должны обрезаться до безопасного файлового компонента, чтобы `.md` и `frontmatter.file` не расходились с фактически созданным media-файлом.

---

## Ошибки

```rust
enum BlockError {
    /// Frontmatter пуст (только пробелы или ничего между ---)
    EmptyFrontmatter,

    /// Невалидный YAML
    YamlParse { source: serde_yaml::Error },

    /// Обязательное поле отсутствует
    MissingRequiredField { field: &'static str },

    /// Неизвестное значение поля type
    InvalidBlockType { value: String },

    /// Невалидный формат даты
    InvalidDateTime { value: String },

    /// Невалидное значение тега (не строка)
    InvalidTagValue,

    /// Нет маркеров --- в файле
    NoFrontmatter,

    /// Один маркер --- без закрывающего
    UnclosedFrontmatter,

    /// Пустой slug
    EmptySlug,
}
```

Все ошибки реализуют `std::error::Error` через `thiserror`.
Все ошибки содержат достаточно контекста для диагностики (какое поле, какое значение).

---

## Инварианты

1. `Block.slug` — непустая строка, содержит только `[a-z0-9-]`
2. `Block.frontmatter.block_type` — всегда валидный `BlockType`
3. `Block.frontmatter.saved_at` — всегда валидная дата ISO 8601
4. `Block.frontmatter.tags` — может быть пустым, но каждый элемент — непустой `CollectionRef`
5. `serialize_block(parse_block(slug, content).unwrap())` воспроизводит семантически эквивалентный content (roundtrip)

---

## Edge cases (должны быть покрыты тестами)

| # | Случай | Ожидаемое поведение |
|---|---|---|
| E1 | Файл без frontmatter (`no dashes here`) | `BlockError::NoFrontmatter` |
| E2 | Файл с одним `---` (`---\nyaml without closing`) | `BlockError::UnclosedFrontmatter` |
| E3 | Пустой frontmatter (`---\n---`) | `BlockError::EmptyFrontmatter` |
| E4 | Frontmatter без `type` | `BlockError::MissingRequiredField { field: "type" }` |
| E5 | Frontmatter с `type: unknown` | `BlockError::InvalidBlockType { value: "unknown" }` |
| E6 | Frontmatter без `saved_at` | `BlockError::MissingRequiredField { field: "saved_at" }` |
| E7 | Frontmatter с `saved_at: "not a date"` | `BlockError::InvalidDateTime` |
| E8 | Frontmatter без `Mine Collections` | `tags = vec![]`, не ошибка |
| E9 | `Mine Collections` с не-строковым элементом | `BlockError::InvalidTagValue` |
| E10 | Frontmatter с неизвестными полями (`custom_field: value`) | Игнорируются, без ошибки |
| E11 | Body с `---` внутри текста (после frontmatter) | `---` внутри body — обычный текст, не маркер |
| E12 | Unicode в seed и body | Корректная обработка, readable slug сохраняет Unicode |
| E13 | Очень длинный seed (>200 символов) | Slug обрезается до лимитов filename contract |
| E14 | Wikilinks: `[[]]`, `[[ ]]` | Игнорируются (пустые) |
| E15 | Wikilinks: дубликаты `[[a]] text [[a]]` | Один элемент `["a"]` |
| E16 | Roundtrip: parse → serialize → parse | Результат идентичен |
| E17 | Файл только из frontmatter (нет body) | `body = ""`, не ошибка |
| E18 | Пустой slug | `BlockError::EmptySlug` |
| E19 | YAML с табами вместо пробелов | `BlockError::YamlParse` (YAML не допускает табы) |
| E20 | `saved_at` только дата без времени: `2026-02-26` | Валидно |
