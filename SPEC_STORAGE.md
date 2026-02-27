# SPEC: storage layer

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md)

Персистентный слой: SQLite-индекс, файловые операции, thumbnail-генерация.
Зависит от domain/ для типов. Не зависит от commands/ и watcher/.

---

## storage/db

Управление SQLite-соединением и схемой.

### Функции

```rust
open_or_create(path: &Path) -> Result<Connection>   // открыть или создать БД
open_memory() -> Result<Connection>                  // для тестов
```

### Схема

```sql
-- Блоки
CREATE TABLE blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    block_type TEXT NOT NULL,
    title TEXT,
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
    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
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
```

FTS5 синхронизируется через триггеры (INSERT/DELETE/UPDATE на blocks).

### Прагмы

- `PRAGMA journal_mode = WAL;` — параллельные чтения
- `PRAGMA foreign_keys = ON;` — каскадное удаление

---

## storage/index

Индексирование блоков в SQLite. Преобразование domain::Block в строки БД.

### Типы

```rust
struct IndexedBlock {
    id: i64,
    slug: String,
    block_type: BlockType,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    media_file: Option<String>,
    saved_at: String,
    tags: Vec<String>,
}

struct TagCount {
    tag: String,
    count: usize,
}
```

### Функции

```rust
upsert_block(conn: &Connection, block: &Block) -> Result<i64>
remove_block(conn: &Connection, slug: &str) -> Result<bool>
get_block(conn: &Connection, slug: &str) -> Result<Option<IndexedBlock>>
list_blocks(conn: &Connection) -> Result<Vec<IndexedBlock>>
list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<IndexedBlock>>
get_all_tags(conn: &Connection) -> Result<Vec<TagCount>>
search_blocks(conn: &Connection, query: &SearchQuery) -> Result<Vec<IndexedBlock>>
upsert_channel(conn: &Connection, channel: &Channel) -> Result<i64>
list_channels(conn: &Connection) -> Result<Vec<Channel>>
remove_channel(conn: &Connection, tag: &str) -> Result<bool>
```

### Поведение upsert_block

- Если блок с таким slug уже есть — обновляет все поля
- Обновляет block_tags: удаляет старые, вставляет новые
- Обновляет wikilinks: удаляет старые, вставляет новые (из extract_wikilinks)
- FTS5 обновляется автоматически через триггеры

### Поведение search_blocks

- Свободный текст: `WHERE blocks_fts MATCH ?`
- Фильтр type: `WHERE block_type = ?`
- Фильтр tag: `JOIN block_tags WHERE tag = ?`
- Комбинация: AND между фильтрами

---

## storage/files

Файловые операции: создание/чтение/удаление блоков и медиафайлов в vault.

### Функции

```rust
write_block_file(vault: &VaultLayout, block: &Block) -> Result<PathBuf>
read_block_file(path: &Path) -> Result<(String, String)>  // (slug, content)
scan_md_files(vault: &VaultLayout) -> Result<Vec<PathBuf>>
copy_media_file(source: &Path, vault: &VaultLayout, slug: &str) -> Result<PathBuf>
delete_block_files(vault: &VaultLayout, slug: &str, media_ext: Option<&str>) -> Result<()>
```

### Поведение write_block_file

- Сериализует Block через domain::block::serialize_block
- Записывает в `vault/slug.md`
- Создаёт директории при необходимости

### Поведение scan_md_files

- Возвращает пути всех `.md` файлов в корне vault (не рекурсивно)
- Игнорирует `.arena/` директорию
- Игнорирует файлы, не являющиеся `.md`

---

## storage/thumbnails

Генерация превью изображений.

### Функции

```rust
generate_thumbnail(source: &Path, dest: &Path, max_size: u32) -> Result<(u32, u32)>
```

### Поведение

- Читает исходное изображение (JPEG, PNG, WebP, GIF)
- Ресайз с сохранением пропорций: макс. сторона = `max_size` (по умолчанию 240px)
- Сохраняет как JPEG (quality 80)
- Возвращает (width, height) результата
- Если изображение меньше max_size — сохраняет как есть (без увеличения)
