# SPEC: domain/block

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_PRD.md](SPEC_PRD.md)

Эталонный модуль. Все последующие модули следуют его паттернам качества, тестирования и документирования.

---

## Назначение

`domain/block` — чистая бизнес-логика работы с блоками. Блок — центральная единица данных Mine: `.md` файл с YAML frontmatter + опциональный медиафайл.

**Зависимости:** нет. Модуль не знает о Tauri, SQLite, файловой системе.
**Зависят от него:** storage/index, storage/files, commands/blocks, watcher/handler.

---

## Типы

### BlockType

Перечисление типов блоков.

```rust
enum BlockType {
    Image,    // Изображение (PNG, JPG, WEBP, GIF, SVG)
    Article,  // Статья или фрагмент текста
    Link,     // Ссылка (URL без текстового контента)
    Video,    // Видео (MP4, MOV)
    File,     // Произвольный файл (PDF, ZIP, etc.)
}
```

**Определяется по:** полю `type` в frontmatter.

**Маппинг строк:**
- `"image"` → `Image`
- `"article"` → `Article`
- `"link"` → `Link`
- `"video"` → `Video`
- `"file"` → `File`

Любое другое значение — ошибка `InvalidBlockType`.

### Frontmatter

Структура YAML frontmatter из `.md` файла.

```rust
struct Frontmatter {
    block_type: BlockType,       // обязательное
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    file: Option<String>,        // имя связанного медиафайла
    thumbnail: Option<String>,   // имя файла-миниатюры
    tags: Vec<String>,           // теги (= каналы). Пустой vec допустим
    saved_at: DateTime,          // обязательное
    source: Option<String>,      // "browser-extension", "drag-drop", "manual", etc.
    width: Option<u32>,
    height: Option<u32>,
    author: Option<String>,
}
```

**Обязательные поля:** `block_type`, `saved_at`.
**Поведение при отсутствии обязательного поля:** ошибка `MissingRequiredField`.

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
    /// Для type=article содержит текст. Для type=image/link/video/file — пустое.
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
- `tags` отсутствует → `tags = vec![]` (не ошибка)
- `tags` содержит не-строки → `BlockError::InvalidTagValue`
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
- Body может быть пустым (нормально для image, link, video, file)
- Пустой slug → `BlockError::EmptySlug`

### serialize_frontmatter

Сериализует `Frontmatter` обратно в YAML-строку.

```rust
fn serialize_frontmatter(frontmatter: &Frontmatter) -> String
```

**Поведение:**
- Всегда включает `type` и `saved_at`
- `None` поля не включаются в вывод
- Пустой `tags` vec — поле `tags` не включается
- Порядок полей: type, title, description, url, file, thumbnail, tags, saved_at, source, width, height, author

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

Генерирует slug из заголовка или URL.

```rust
fn suggest_slug(title: Option<&str>, url: Option<&str>) -> String
```

**Поведение:**
- Из title: `"Как устроен CRDT"` → `"Как устроен CRDT"`
- Из URL (если title нет): `"https://stripe.com/blog/api"` → `"stripe.com blog api"`
- Нет ни title, ни URL → `"Untitled"`
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
4. `Block.frontmatter.tags` — может быть пустым, но каждый элемент — непустая строка
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
| E8 | Frontmatter без `tags` | `tags = vec![]`, не ошибка |
| E9 | Frontmatter с `tags: "single-string"` (не массив) | `BlockError::InvalidTagValue` |
| E10 | Frontmatter с неизвестными полями (`custom_field: value`) | Игнорируются, без ошибки |
| E11 | Body с `---` внутри текста (после frontmatter) | `---` внутри body — обычный текст, не маркер |
| E12 | Unicode в title и body | Корректная обработка, slug транслитерируется |
| E13 | Очень длинный title (>200 символов) | Slug обрезается до 80 символов |
| E14 | Wikilinks: `[[]]`, `[[ ]]` | Игнорируются (пустые) |
| E15 | Wikilinks: дубликаты `[[a]] text [[a]]` | Один элемент `["a"]` |
| E16 | Roundtrip: parse → serialize → parse | Результат идентичен |
| E17 | Файл только из frontmatter (нет body) | `body = ""`, не ошибка |
| E18 | Пустой slug | `BlockError::EmptySlug` |
| E19 | YAML с табами вместо пробелов | `BlockError::YamlParse` (YAML не допускает табы) |
| E20 | `saved_at` только дата без времени: `2026-02-26` | Валидно |
