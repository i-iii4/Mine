# Связи карточек: автор, сайт, адрес

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_SEARCH_OVERLAY.md](SPEC_SEARCH_OVERLAY.md) | [SPEC_TABS.md](SPEC_TABS.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INLINE_MEDIA_EXTRACTION.md](SPEC_INLINE_MEDIA_EXTRACTION.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md) | [SPEC_MEDIA_ASSET_ACTIONS.md](SPEC_MEDIA_ASSET_ACTIONS.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md) | [SPEC_CARD_STATES.md](SPEC_CARD_STATES.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

Статус: правила утверждены пользователем 07.10.2026; реализация не начата,
Phase 41 в [PLAN.md](PLAN.md).

## Цель

Открытая карточка показывает другие карточки, связанные с ней её же данными:
тот же автор, тот же сайт, тот же адрес. Связи вычисляются из полей `author`
и `url` и в файлы пространства не пишутся. Нажатие на автора открывает ленту
только его карточек.

## Не цели

- Никаких новых полей frontmatter и никаких записей в файлы ради связей.
- Связи не смешиваются с Related notes. Related notes это связи, поставленные
  пользователем вручную (`Mine Related Notes` и ссылки в тексте); связи этой
  спецификации вычисляются и живут в отдельных блоках.
- Лента есть только у автора. Ленты сайта и адреса нет.
- Строка `Author` в сведениях открытой карточки не меняется: она показывает
  поле самой карточки. Унаследованный автор виден заголовком блока.
- Связи не участвуют в поиске, графе, CLI `mine`, MCP и iOS.
- Никаких сетевых запросов при индексации: сайт и адрес читаются из текста
  адреса.
- Правила не расширяются: `@name` и `name` разные авторы, пробелы внутри имени
  значимы, `http` и `https` разные адреса.
- Существующие файлы не переписываются: карточки YouTube, сохранённые без
  автора, остаются без автора.

## Правила

Утверждены пользователем 07.10.2026, применяются без дополнений.

| Связь | Правило |
|---|---|
| Тот же автор | Поле `author` совпадает без учёта регистра (пробелы по краям не важны). Сайт не важен. Вытащенная карточка (извлечённая из другой: inline media extraction, text selection extraction, карточки с `Mine Source Media`) без своего автора берёт автора исходной. У YouTube автор это канал: клиппер начинает сохранять канал в `author` |
| Тот же сайт | Только у карточек без автора (после наследования). Сайт это хост адреса без `www.`. Не действует на площадках, где публикуют разные люди: X, Instagram, YouTube, cosmos.so, are.na (закрытый список, пополняется; включает их домены и поддомены, например twitter.com, pbs.twimg.com, youtu.be, cdn.cosmos.so). Не действует, если адрес ведёт прямо на файл картинки или видео |
| Тот же адрес | Адрес (`url`) совпадает без учёта `www.`, якоря `#…` и параметров `utm_*` |

Общие правила:

1. Связи вычисляются в индексе и не пишутся в файлы. Индекс пересоздаётся из
   `.md`, вместе с ним пересоздаются связи (PRINCIPLES.md, 10 и 11).
2. Карточка не связывается сама с собой.
3. Коллекции (`type: channel`) не участвуют: у них нет связей, в строки они не
   попадают.
4. Карточка без адреса и без автора связей не получает.
5. Связь симметрична: если A связана с B, то B связана с A по тому же правилу.
   Поэтому «Тот же сайт» связывает только две карточки без автора: у карточки
   с автором блока сайта нет, и в чужой блок сайта она не попадает.
6. Автор и сайт исключают друг друга. Открытая карточка показывает не больше
   двух блоков связей: «Тот же адрес» и один из двух других.

## Данные пространства пользователя 07.10.2026

687 карточек. Числа нужны для выбора пределов, а не как контракт.

- Авторов 216; у 46 по две карточки и больше, это 230 карточек; больше всех
  у `@kotecinho` (31) и `@michaelmicasso` (30). Только два автора встречаются
  на двух хостах, оба это один человек на `x.com` и `pbs.twimg.com`.
  Вариантов одного имени в разном регистре нет. Часть авторов записана
  простым именем: короткое имя (`marco`) может объединить разных людей,
  пользователь это принял.
- Происхождение: посты X с автором 343; страницы сайтов без автора 211;
  Instagram с автором 34; страницы сайтов с автором 23; прямые адреса файлов
  20; без адреса (брошенный файл, снимок экрана, слияние) 11; cosmos.so 11,
  cdn.cosmos.so 5 и are.na 3 без автора; страницы X без автора (лента,
  профиль) 9; вытащенные карточки без автора 13 (8 из X, 3 из Instagram, 2 с
  сайтов); YouTube без автора 3; история Instagram без автора 1.
- Групп одного адреса 52 (один пост X дал 7 карточек извлечением; `door.link`
  сохранён 5 раз).
- Пробный расчёт по этим правилам на файлах пространства (скрипт только
  читал файлы): наследование даёт автора 10 из 13 вытащенных карточек, одной
  из них через цепочку из двух шагов (`MUCU Grey Notebook (image 3) (2)`
  вытащена из вытащенной); у трёх автора нет (у двух исходная не находится,
  у одной исходная без автора). После наследования у `@kotecinho` 37
  карточек. Групп сайта 34 на 101 карточку, самая большая `niklasrosen.se`
  (9). Хотя бы одну связь получают 355 карточек из 687. У 9 авторов больше 6
  карточек, в этих группах 140 карточек.

## Нормализация

Правила это чистые функции общего ядра: модуль
`mine-core/src/domain/card_association.rs`, путь совместимости
`src-tauri/src/domain/card_association.rs` (`pub use
mine_core::domain::card_association::*;`, как у `domain/block.rs`). Модуль не
знает о SQLite, файлах и сети. Каждая функция возвращает `None`, когда
связи по этому правилу нет.

### Автор

```rust
/// The author as written on the card: trimmed, `None` when empty.
pub fn author_label(author: &str) -> Option<String>;

/// The comparison key of an author: the label in NFC, lowercased.
pub fn author_key(author: &str) -> Option<String>;
```

- Пробелы по краям (`str::trim`, пробелы Unicode) отбрасываются; пустая
  строка или одни пробелы дают `None`.
- Регистр не учитывается: `str::to_lowercase` (полное отображение Unicode,
  без привязки к языку).
- Текст приводится к NFC: одно и то же имя, набранное составными и готовыми
  буквами (`é` как `e` плюс знак и как одна буква), даёт один ключ. Это не
  новое правило, а одинаковый видимый текст.
- Пробелы внутри имени, `@` в начале и знаки не меняются: `Jane  Doe` и
  `Jane Doe`, `@marco` и `marco` разные авторы.
- `author` списком YAML или не строкой парсер и сейчас не читает
  (`get_opt_string`): у такой карточки автора нет.

### Адрес

```rust
/// The comparison key of an address, or `None` for an address that cannot
/// carry the association.
pub fn address_key(url: &str) -> Option<String>;
```

1. Адрес обрезается по краям и разбирается `url::Url::parse` (стандарт
   WHATWG; крейт `url` уже есть в `mine-core`). Разбор не удался, схема не
   `http` и не `https` или нет хоста: `None`.
2. Хост берётся разобранным (`host_str`): регистр букв хоста, порт по
   умолчанию и пустой путь против `/` по стандарту адресов не различаются.
   Один ведущий ярлык `www.` отбрасывается; `www2.`, `m.` и другие остаются.
3. Якорь (`#…`) отбрасывается.
4. Из строки параметров убираются пары, имя которых начинается с `utm_`
   (без учёта регистра букв ASCII). Остальные пары остаются в исходном
   порядке и в исходной записи. Если пар не осталось, `?` не пишется.
5. Ключ: `схема://хост[:порт]путь[?параметры]`.

Схема входит в ключ: `http://a.com/x` и `https://a.com/x` разные адреса. Косая
черта в конце непустого пути значима: `/about` и `/about/` разные адреса.

### Сайт

```rust
/// Domains where different people publish. A host equal to one of them or
/// ending in `.` plus one of them has no site association.
pub const SHARED_PLATFORM_DOMAINS: &[&str] = &[
    "x.com", "twitter.com", "twimg.com", "t.co",            // X
    "instagram.com", "cdninstagram.com",                     // Instagram
    "youtube.com", "youtu.be", "ytimg.com", "youtube-nocookie.com", // YouTube
    "cosmos.so",                                             // cosmos.so
    "are.na",                                                // Are.na
];

/// The site of an address: its host without `www.`, or `None`.
pub fn site_key(url: &str) -> Option<String>;
```

1. Разбор и хост как у адреса (шаги 1 и 2): хост в нижнем регистре без
   ведущего `www.`.
2. Хост совпадает с доменом из `SHARED_PLATFORM_DOMAINS` или кончается на
   `.домен`: `None`. Совпадение по целым ярлыкам: `notx.com` и
   `cosmos.so.example.com` остаются сайтами.
3. Последний сегмент пути кончается расширением из `IMAGE_MEDIA_EXTS` или
   `VIDEO_MEDIA_EXTS` (`mine-core/src/domain/block.rs`, единый список «это
   картинка, это видео», без учёта регистра): `None`, адрес ведёт прямо на
   файл. Расширение определяется только по тексту адреса, без запросов в
   сеть.
4. Иначе сайт это хост. Поддомены значимы: `eng.basement.studio` и
   `basement.studio` разные сайты.

Список пополняется добавлением домена в константу и строки в тест; других
мест, где он записан, нет. Файловый хост Are.na
(`d2w9rnfcy7mm78.cloudfront.net`, 5 карточек) в список не входит: все его
адреса в пространстве ведут на файлы и исключаются шагом 3.

### Вытащенная карточка

```rust
pub const INLINE_MEDIA_EXTRACTION_SOURCE: &str = "inline-media-extraction";
pub const TEXT_SELECTION_EXTRACTION_SOURCE: &str = "text-selection-extraction";

/// The link to the card this one was extracted from: the first entry of
/// `Mine Related Notes` of an extracted card, `None` for any other card.
pub fn extraction_source_target(frontmatter: &Frontmatter) -> Option<&str>;
```

- Карточка вытащена, если `source` равно одной из двух констант или у неё
  есть `Mine Source Media` (`Frontmatter::source_media`, в том числе карточка
  медиа из открытой карточки, SPEC_MEDIA_ASSET_ACTIONS.md, у которой
  `source` пуст).
- Исходная записана первой ссылкой `Mine Related Notes`: оба пути извлечения
  пишут ровно одну ссылку на исходную при создании, позже пользователь может
  дописать другие, первая остаётся происхождением. Нет ссылок: исходной нет.
- Обе константы заменяют строки в `commands/blocks.rs`, где извлечения
  пишут `source`: писатель и читатель берут одно значение.
- Слияние (`source: card-merge`) вытащенной карточкой не считается: у него
  свой автор (SPEC_CARD_MERGE.md).

### Имена для поиска исходной

Поиск исходной идёт теми же правилами Obsidian, что Related notes
(`LinkIndex::resolve`, `LinkSyntax::Obsidian`). Чтобы не строить индекс всех
путей на каждую запись, ядро ссылок (`mine-core/src/links.rs`) даёт ключи
кандидатов:

```rust
/// The name a note answers to: the NFC last segment of its path without
/// `.md` (`Cards/Foo` gives `Foo`).
pub fn note_name_key(note_path_without_ext: &str) -> Option<String>;

/// The note names an Obsidian link target can resolve to: its NFC last
/// segment and, when that ends in `.md`, the segment without it. Fragment
/// and alias are dropped as `parse_target` drops them.
pub fn obsidian_target_name_keys(raw_target: &str) -> Vec<String>;
```

Инвариант (доказывается тестом): `LinkIndex`, построенный только из заметок с
`note_name_key` из `obsidian_target_name_keys(target)`, разрешает `target`
так же, как `LinkIndex` из всех путей. Это следует из `resolve_inner`:
точный путь, совпадение по хвосту и восстановление по имени сравнивают
последний сегмент пути с последним сегментом цели, с `.md` или без.

### Ключи строки

```rust
/// Everything the index keeps for associations, read from one card alone.
pub struct CardAssociationKeys {
    /// `author_label` of the card's own `author`.
    pub own_author: Option<String>,
    pub site: Option<String>,
    pub address: Option<String>,
    /// `note_name_key` of the card's slug.
    pub note_name: Option<String>,
    /// The first name key of `extraction_source_target`, for finding the
    /// cards extracted from a note by its name.
    pub extraction_source_name: Option<String>,
}

pub fn card_association_keys(block: &Block) -> CardAssociationKeys;
```

Для коллекции все поля, кроме `note_name`, пусты: имя нужно, чтобы поиск
исходной видел те же пути, что Related notes.

## Наследование автора

Автор карточки для связей (`association_author`) определяется так:

1. Есть свой `author` (после `author_label`): он.
2. Карточка не вытащена или у неё нет ссылки на исходную: автора нет.
3. Исходная ищется по первой ссылке `Mine Related Notes`: кандидаты это строки
   `blocks` с `note_name` из `obsidian_target_name_keys`, решает
   `LinkIndex::resolve`. Не нашлась, неоднозначна, совпала с самой карточкой
   или это коллекция: автора нет.
4. У исходной есть свой автор: он. Иначе шаг 2 повторяется для исходной.
   Цепочка проходит не больше `ASSOCIATION_SOURCE_CHAIN_MAX_STEPS = 8` шагов;
   повтор карточки в цепочке (цикл) или конец шагов дают «автора нет».

Решение «цепочка, а не один шаг»: исходная, сама вытащенная без автора,
показывает автора своей исходной, и правило «берёт автора исходной» для её
производной даёт того же автора. В пространстве такая карточка уже есть.

Автор всегда считается проходом цепочки до карточки со своим полем, а не
чтением сохранённого унаследованного значения промежуточной карточки. Иначе в
цикле A из B, B из A автор, удалённый у A, остался бы у обеих навсегда
(найдено при проверке по PRINCIPLES.md).

Карточки одного автора: все карточки, у которых `association_author_key`
совпадает, своё поле или унаследованное.

## Модель данных

Миграция `CURRENT_SCHEMA_VERSION` с 5 на 6 (`storage/migrations.rs`), одна
транзакция, как остальные шаги. Столбцы добавляются в `blocks`: связи
описывают одну карточку, а изменение строки `blocks` уже продвигает
поколение проекции триггерами `projection_blocks_*`.

| Столбец | Тип | Значение |
|---|---|---|
| `note_name` | `TEXT` | `note_name_key(slug)`; ключ кандидатов для поиска исходной |
| `extraction_source_name` | `TEXT` | `extraction_source_name` ключей; у невытащенной карточки `NULL` |
| `association_author` | `TEXT` | автор как написан: свой или унаследованный |
| `association_author_key` | `TEXT` | `author_key(association_author)` |
| `association_site` | `TEXT` | `site_key(url)`; хранится независимо от автора, условие «без автора» ставит запрос |
| `association_address` | `TEXT` | `address_key(url)` |
| `association_index_version` | `INTEGER` | версия правил, по которой посчитаны столбцы |

Сырая ссылка на исходную не дублируется: она первая в уже существующем
`related_notes` (JSON).

Индексы (частичные, чтобы карточки без связи не занимали места):

```sql
CREATE INDEX idx_blocks_note_name ON blocks(note_name);
CREATE INDEX idx_blocks_extraction_source_name ON blocks(extraction_source_name)
  WHERE extraction_source_name IS NOT NULL;
CREATE INDEX idx_blocks_association_author ON blocks(association_author_key, saved_at)
  WHERE association_author_key IS NOT NULL;
CREATE INDEX idx_blocks_association_site ON blocks(association_site, saved_at)
  WHERE association_site IS NOT NULL;
CREATE INDEX idx_blocks_association_address ON blocks(association_address, saved_at)
  WHERE association_address IS NOT NULL;
```

Столбцы входят в `BLOCK_COLUMNS`, индексы в `REQUIRED_INDEXES`:
`validate_schema` отвергает неполную схему, как сейчас.

`ASSOCIATION_INDEX_VERSION = 1` (`storage/card_associations.rs`) поднимается
при каждом изменении правил нормализации, списка площадок или наследования.
`backfill_association_index(conn, vault)` пересчитывает строки старой версии:
читает их `.md` (только файл знает `Mine Source Media`), пишет ключи, затем
пересчитывает наследование всех вытащенных карточек без своего автора и
ставит версию. Запускается в общем проходе дозаполнения индекса после
первого кадра (`commands/vault.rs`, рядом с `backfill_collection_index`),
идемпотентна. До её конца у старых строк столбцы пусты: блоков связей нет,
ничего неверного не показывается.

## Поддержание при изменениях

Все записи строк `blocks` уже идут через три функции `storage/index.rs`:
`upsert_block_inner`, `remove_block`, `rename_slug`. Связи поддерживаются
только в них, в той же точке сохранения (`SAVEPOINT`), что сама запись; новых
путей записи нет. Наблюдатель, полный и частичный обход (`reconcile`),
команды приложения, клиппер и дозаполнение получают связи без отдельного
кода.

```rust
// storage/card_associations.rs
/// Write the association columns of one row from its card; returns the
/// row's association author key before and after.
pub(crate) fn write_row_keys(conn: &Connection, block_id: i64, block: &Block)
    -> Result<AuthorKeyChange>;

/// Recompute the inherited author of every extracted card without its own
/// author whose source may be one of the notes named `names`, and of the
/// cards extracted from those whose author changed.
pub(crate) fn refresh_inherited_authors(conn: &Connection, names: &[String])
    -> Result<usize>;
```

| Событие | Что пересчитывается |
|---|---|
| Запись карточки (`upsert_block_inner`) | Её столбцы; её автор (свой или по цепочке). Если ключ автора изменился: `refresh_inherited_authors([note_name])` |
| Новая карточка | То же; плюс `refresh_inherited_authors([note_name])` всегда: новое имя может сделать ссылку чужой вытащенной карточки найденной или неоднозначной |
| Удаление (`remove_block`) | `note_name` читается до удаления; после: `refresh_inherited_authors([note_name])` |
| Переименование (`rename_slug`) | Новый `note_name`; `refresh_inherited_authors([старое имя, новое имя])`. Переименование в приложении переписывает `Mine Related Notes` вытащенных карточек, их записи приходят обычным путём |
| Изменение `url` | Только столбцы своей строки: сайт и адрес не зависят от других карточек |

`refresh_inherited_authors` идёт по списку имён: для каждого имени выбирает
по `idx_blocks_extraction_source_name` вытащенные карточки без своего автора,
пересчитывает их автора проходом цепочки и пишет только изменившиеся строки;
имя изменившейся карточки добавляется в список. Множество посещённых строк
не даёт обойти карточку дважды. Порядок записи файлов при полном обходе не
важен: вытащенная карточка, записанная раньше исходной, получает автора,
когда приходит исходная.

Как об этом узнаёт открытая карточка. Любая запись строки продвигает
`projection_state.generation` триггерами. Существующий путь
`vault-changed` → новый снимок ленты → событие страницы `vault-refreshed`
доводит изменение до открытой карточки, и она перечитывает связи (раздел
«Открытая карточка»). Ответ несёт поколение проекции; ответ старше
принятого для той же карточки отбрасывается.

## Чтение и команды

### Связи открытой карточки

```rust
// storage/card_associations.rs, exported through Specta (bindings.rs)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CardAssociationKind { Address, Author, Site }

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct CardAssociationGroup {
    pub kind: CardAssociationKind,
    /// The author as written on the open card (own or inherited), the site
    /// key, or the address key.
    pub label: String,
    /// Cards of the group after every exclusion.
    pub total: usize,
    /// Newest first: at most CARD_ASSOCIATION_PREVIEW_ROWS, or
    /// CARD_ASSOCIATION_EXPANDED_ROWS for an expanded kind.
    pub blocks: Vec<LightBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct CardAssociations {
    pub generation: ProjectionRevision,
    pub slug: String,
    /// Address, then author or site; a group with no cards is left out.
    pub groups: Vec<CardAssociationGroup>,
}

pub const CARD_ASSOCIATION_PREVIEW_ROWS: usize = 5;
pub const CARD_ASSOCIATION_EXPANDED_ROWS: usize = 200;

pub fn read_card_associations(
    conn: &Connection,
    slug: &str,
    exclude_slugs: &[String],
    expanded: &[CardAssociationKind],
) -> Result<CardAssociations>;
```

Чтение идёт под одним снимком SQLite (`read_projection_snapshot`): поколение,
строки и счётчики согласованы.

1. Строка открытой карточки читается по `slug`. Нет строки или это
   коллекция: `groups` пуст.
2. Из всех групп исключаются: сама карточка, коллекции
   (`card_kind != 'channel'`), `exclude_slugs` (Related notes открытой
   карточки, их передаёт страница).
3. «Тот же адрес» (`Address`): `association_address = ?`.
4. «Тот же автор» (`Author`), если у открытой карточки есть
   `association_author_key`: `association_author_key = ?`; если у открытой
   карточки есть адрес, ещё `association_address IS NOT <её адрес>`
   (карточки блока адреса не повторяются). Без адреса условия на адрес нет:
   `IS NOT NULL` отбросил бы все карточки без адреса.
5. «Тот же сайт» (`Site`), если у открытой карточки нет автора и есть сайт:
   `association_site = ?`, `association_author_key IS NULL` и то же условие
   на адрес, что у автора.
6. Порядок строк: `saved_at DESC`, затем имя, как `FeedOrder::Newest`. Для
   каждой группы один `COUNT` и одна страница по своему индексу.
7. Строки читаются тем же `light_block_from_row` и теми же правилами
   видимости превью, что лента (`list_grid_blocks_filtered`): одна модель
   строки для ленты, поиска и связей.

Команда (`src-tauri/src/commands/card_associations.rs`, тонкий слой, путь
чтения как у `get_block`: `tab_layout`, `ensure_vault_fresh`,
`spawn_blocking`, `read_owned_projection`):

```rust
#[tauri::command]
#[specta::specta]
pub async fn list_card_associations(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    exclude_slugs: Vec<String>,
    expanded: Vec<CardAssociationKind>,
) -> Result<CardAssociations, CommandError>;
```

`slug` проверяется `validate_slug`, как в `get_block`. Ошибки базы приходят
существующим `CommandError`; отсутствие исходной, пустые группы и карточка
без связей не ошибки.

### Лента по месту

`TabLocation` (`src-tauri/src/domain/windows.rs`) это уже тип «где в
пространстве вкладка». Он получает третий вариант и становится единственным
типом места ленты от Rust до TypeScript:

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TabLocation {
    Everything,
    Collection { tag: String },
    /// Cards whose association author is `author`, compared by `author_key`.
    Author { author: String },
}
```

- `list_grid_blocks` принимает `location: TabLocation` вместо
  `current_tag: Option<String>`; `projection::read_grid_snapshot` и
  `block_queries::list_grid_blocks_in_order` тоже. Для `Author` запрос
  ставит `association_author_key = author_key(author)` по индексу
  `idx_blocks_association_author`; порядок и страницы те же, что у ленты.
  Пустое имя после `author_key` даёт пустую ленту.
- `SAVED_WINDOWS_VERSION` поднимается с 1 до 2. Файл версии 1 читается как
  есть (он не знает третьего варианта); прежняя сборка по правилу «файл
  новее» откладывает файл версии 2 как `windows.v2.json`, а не считает его
  испорченным.
- Привязки TypeScript перегенерируются (`bun run bindings:generate`);
  `fetchGridBlocks` в `src/lib/commands.ts` принимает `TabLocation`.

## Открытая карточка

### Место и порядок

Блоки связей стоят под Related notes в той же колонке сведений, в обоих видах
открытой карточки: рядом с содержимым (`data-detail-layout-mode="rail"`,
закреплённая колонка `20rem`) и в мобильном виде (`stacked`, сведения под
содержимым шириной `W`). Оба вида рисуют один `MetadataPanel`, поэтому блоки
появляются в них одинаково; отдельной вёрстки для мобильного вида нет.

Порядок сверху вниз: сведения с кнопками, Related notes, «Тот же адрес»,
«Тот же автор» или «Тот же сайт». Зазор между карточками панели прежний
(`gap-6`). Блок без строк не рисуется; без связей открытая карточка выглядит
как сейчас.

Каждая карточка показывается в панели один раз, в первом сверху блоке, где
она есть: Related notes, затем адрес, затем автор или сайт. Причина: один
пост X дал 7 карточек, и без этого правила они заняли бы и блок адреса, и
первые строки блока автора.

### Оформление блока

Решение пользователя 07.10.2026: Related notes упакованы в коробку точно как
сведения (Resolution, Date, Source и кнопки `Source`, `Connect`): та же
рамка, радиус, фон и внутренние отступы, подпись внутри коробки, строки
выровнены по подписям. Блоки связей используют ту же коробку, новой
поверхности нет:

- одна коробка на связь: отдельные `DetailPanelCard` для `Same URL`, автора
  или сайта, каждая следующей карточкой панели под Related notes;
- подпись внутри коробки сверху, тем же классом и с теми же отступами, что
  подпись `Related notes`;
- строки стоят так же, как строки Related notes (`CardRow` с `framed`):
  миниатюра и правая кнопка выровнены по подписям сведений, свет строки не
  касается рамки;
- оболочка, подпись и отступы берутся из общего кода коробки и списка строк
  панели, а не копируются: изменение коробки Related notes меняет и блоки
  связей.

| Блок | Подпись | Поведение подписи |
|---|---|---|
| Тот же адрес | `Same URL` | текст |
| Тот же автор | автор, как написан на открытой карточке (`label` группы; у вытащенной карточки это автор исходной) | кнопка: открывает ленту автора |
| Тот же сайт | хост без `www.` (`label` группы) | текст |

Подписи на английском, как весь интерфейс (`Related notes`). Кнопка автора
выглядит как подпись, при наведении подчёркивается (как `MetadataLinkValue`),
курсор стрелка: действие внутри Mine, не уход в браузер. Подсказка
`All cards by <автор>`. Длинная подпись обрезается многоточием, полный текст
в `title`.

### Строки

Строки это общий `CardRow` один в один, как в Related notes и поиске
(SPEC_SEARCH_OVERLAY.md, «Строка результата» и «Команды строки»): миниатюра,
имя файла, тусклым начало текста; под указателем команды `More`, `Source`
(при безопасном адресе), `Connect`; нажатие вне команд открывает карточку тем
же обработчиком, что строка Related notes; превью карточки при наведении с
теми же задержками и правилами положения, в мобильном виде под строкой или
над ней. Открытое меню держит свою строку.

Машинерия строк (указатель, меню, превью при наведении) выносится из
`RelatedNotesSection` в общий список строк панели и используется Related
notes и блоками связей; копия запрещена. Ключ строки содержит блок
(`related:3:slug`, `author:0:slug`), поэтому превью и меню различают одну
карточку в разных списках.

### Большие группы

- Блок показывает не больше `CARD_ASSOCIATION_PREVIEW_ROWS = 5` строк, самые
  новые сверху. Пять это предел уже принятого списка связанных карточек в
  подтверждении удаления медиа (`DELETE_MEDIA_CONNECTED_CARDS_VISIBLE_COUNT`);
  без открытой карточки он покрывает все группы адреса и сайта, кроме одной в
  каждом виде (пост X на 7 карточек, `niklasrosen.se`), а два блока связей по
  пять строк помещаются в колонку сведений с прокруткой.
- Больше строк у автора: под строками кнопка `Show all`, она делает то же,
  что подпись: открывает ленту автора. Лента это место для 37 карточек:
  сетка, порядок и вид ленты, групповое выделение.
- Больше строк у адреса или сайта (ленты у них нет): кнопка `Show N more`,
  где `N` это `total` минус показанные строки. Она перечитывает связи с этим
  видом в `expanded` и раскрывает блок на месте, до
  `CARD_ASSOCIATION_EXPANDED_ROWS = 200` строк (предел поиска, «Хвост за
  пределами 200 недостижим»). Раскрытие держится, пока открыта эта карточка,
  и переживает обновления; другая карточка начинает с пяти строк.
- Кнопки нижней строки стоят внутри той же коробки под строками, оформлены
  как подпись блока (`METADATA_LABEL_CLASSES`) с её отступом слева и нижним
  отступом коробки, подчёркивание при наведении.

### Загрузка и обновление

Хук `useCardAssociations(slug, excludeSlugs, expanded)`
(`src/hooks/useCardAssociations.ts`):

- запрашивает `listCardAssociations`, когда загружена полная карточка
  (`IndexedBlock` с `related_notes`): исключения известны до первого ответа,
  строки не появляются и не исчезают повторно;
- перечитывает при смене карточки, исключений, раскрытия и на событие
  `vault-refreshed`, как `refreshFullBlock`;
- принимает ответ, только если он для текущей карточки и его `generation` не
  меньше принятого (два обновления подряд не возвращают старые строки);
- пока ответа нет, блоков нет (без скелетов: блоки идут последними и ничего
  ниже себя не сдвигают);
- при ошибке блоков нет, ошибка пишется в журнал с карточкой и текстом;
  следующее `vault-refreshed` запрашивает снова. Сведения и Related notes от
  ошибки не зависят.

### Клавиатура и доступность

- Блок это `section` с доступным именем по подписи.
- Кнопка автора и нижние кнопки достижимы `Tab`, срабатывают `Enter` и
  пробелом.
- `⌘K` открывает меню самой открытой карточки, как сейчас; подсказка `More` в
  строках его не называет (как в Related notes).

## Лента автора

### Вход

Нажатие на подпись автора или на `Show all` открывает место
`TabLocation::Author { author: label }`: путь `/author/<encodeURIComponent(label)>`.
Смена места закрывает открытую карточку, как любая смена маршрута; шаг назад
возвращает прежнее место с открытой карточкой (SPEC_TABS.md, В81). Если лента
этого автора уже открыта (карточку открыли из неё), нажатие только закрывает
карточку.

### Как лента показывает своё место

- Путь в верхнем ряду: `Mine › @kotecinho`. Звено коллекции
  (`TopCollectionSwitcher`) показывает автора вместо `Everything` или имени
  коллекции; его меню прежнее (Everything и коллекции), отмеченного пункта в
  нём нет.
- Вкладка подписана автором. `TabBarTab.collection` становится
  `TabBarTab.place: Option<String>`: коллекция или автор; `tabLabel` берёт
  `card ?? place ?? space_name`.
- В боковом меню не выделена ни одна строка: лента автора не коллекция и не
  Everything.
- Сетка, порядок и вид (`Display`), групповое выделение работают как в
  Everything. Команды выделения без `Disconnect`: место не коллекция.
- Граф для автора не строится: в ленте автора переключатель `Grid / Graph`
  скрыт и всегда показана сетка. Режим вкладки при этом не меняется: после
  выхода из ленты автора вкладка снова в своём режиме.
- Пустая лента автора (карточки удалены или автор переписан) показывает ту же
  заглушку, что пустая коллекция; онбординг пустого пространства в ней не
  появляется. Автоматического перехода нет: место честно пусто, пока
  пользователь не уйдёт.
- Бросить файлы в ленту автора нельзя: зона сброса там не включается. Новый
  файл автора не получает и в этой ленте не появился бы.

### Как выйти

Выбрать Everything или коллекцию в звене пути или в боковом меню; шаг назад
(кнопка полосы вкладок, `⌘[`). Отдельной кнопки выхода нет: так же уходят из
коллекции.

### Изменения в странице вкладки

`currentTag` в `src/App.tsx` заменяется местом `currentLocation:
TabLocation`, выведенным из маршрута; все места, где сейчас стоит тег
маршрута, получают место:

| Где | Правило |
|---|---|
| Маршруты | `<Route path="author/:author">` рядом с `channel/:tag`; `tabLocationPath` и разбор пути знают третий вариант |
| Снимок ленты, кэш маршрутов | `loadGridSnapshot` и `routeKeyFor` по месту: `__all__`, `collection:<tag>`, `author:<author>` |
| Память вкладки и восстановление | `TabView.location` пишет `Author`; восстановление ведёт на путь автора |
| Шаги назад и вперёд | `Place` это `{ location, card }` вместо `{ tag, card }`; `samePlace` сравнивает места |
| Обновление после `vault-changed` | лента автора перечитывается на каждое изменение, как Everything: событие не говорит об авторах |
| Оптимистичные правки ленты | карточка в ленте автора остаётся при смене коллекций; членство в ней меняется только записью файла, которая приходит новым снимком |
| Сводка пространства | `getVaultStats` для автора как для Everything |
| `Grid` | получает место вместо `currentTag`: заглушка пустой коллекции для автора, онбординг только для Everything |

## Клиппер: канал YouTube

Сейчас карточки YouTube сохраняются без автора. Defuddle читает канал из
разметки страницы и отдаёт его как `byline`, но `resolveContentBody` для
видео возвращает `byline: null`, а `PageMetadata.author` берётся из
`<meta name="author">`, которого у YouTube нет. Разметка страницы для автора
к тому же ненадёжна: после перехода внутри YouTube она может ещё показывать
прежнее видео, а правило 1 SPEC_CLIPPER.md требует, чтобы всё сохранённое
относилось к видео текущего адреса.

Решение:

1. Канал берётся по идентификатору видео из текущего адреса
   (`MineYoutubeSource.parse`), а не из разметки: запрос oEmbed
   `https://www.youtube.com/oembed?format=json&url=<sourceUrl>`. Ответ
   относится ровно к этому видео.
2. Запрос делает фоновый скрипт расширения (`background.js`, сообщение
   `resolveYoutubeChannel { sourceUrl }`): у него есть доступ к адресам
   (`host_permissions: <all_urls>`), и ответ не зависит от того, открыта ли
   страница на `www.youtube.com`, `m.youtube.com` или пришла с `youtu.be`.
   Без куки (`credentials: "omit"`), срок `YOUTUBE_CHANNEL_TIMEOUT_MS = 3000`.
3. Автор это канал в виде `@handle` из `author_url` ответа
   (`https://www.youtube.com/@handle`), как авторы X и Instagram в
   пространстве записаны через `@`; если `author_url` не такого вида, берётся
   `author_name`. Чистая функция
   `youtubeChannelFromOEmbed(payload: unknown): string | null` в
   `extension/lib/youtubeSource.js` рядом с разбором адреса.
4. Клиппер запрашивает канал один раз на захват (поколение захвата, правило 1)
   параллельно с извлечением статьи. Для захвата адреса YouTube `author`
   запроса `save_block` это канал при любом виде сохранения (содержимое,
   ссылка, снимок экрана, картинка). Если ответа ещё нет, сохранение ждёт его
   не дольше срока; нет ответа или ошибка: карточка сохраняется без автора,
   сохранение не останавливается. Выбор автора это чистая функция
   `resolveCaptureAuthor(kind, metadata, article, youtubeChannel)` в
   `extension/popup/lib/captureResult.ts`; для остальных адресов правила
   прежние.
5. Помощник, общее ядро сохранения и браузерный исполнитель пишут `author` во
   frontmatter как сейчас; их код не меняется.

Существующие карточки YouTube (в пространстве 3) остаются без автора: Mine
не переписывает файлы при чтении (PRINCIPLES.md, 10). Автора получает
карточка, сохранённая заново, или карточка, которой пользователь впишет
`author` сам. Связь по сайту у них не действует (YouTube в списке
площадок), связь по адресу действует.

## Краевые случаи

| Случай | Поведение |
|---|---|
| Нет `url` и нет `author` | Связей нет, блоков нет |
| Есть `url`, нет автора, хост площадки | Только «Тот же адрес» |
| Адрес прямо на файл (`.jpg`, `.mp4`, с параметрами или без) | Сайта нет; адрес действует |
| Адрес не `http(s)` или не разбирается | Ни сайта, ни адреса |
| `author` пуст, из пробелов, списком YAML | Автора нет |
| Один автор в разном регистре | Одна группа; подпись как на открытой карточке, лента по ключу |
| Один человек на `x.com` и `pbs.twimg.com` | Один автор: сайт для автора не важен |
| Короткое имя (`marco`) у разных людей | Одна группа (принято пользователем) |
| Коллекция | Не участвует и не попадает в строки |
| Сама карточка | Не попадает в свои блоки |
| Заметка Obsidian без полей Mine | Связей нет; с `url` или `author` строкой участвует как любая карточка (правила читают поля, а не происхождение) |
| Вытащенная без `Mine Related Notes` | Не наследует |
| Исходная не найдена, неоднозначна, это она сама или коллекция | Не наследует |
| Цепочка длиннее 8 шагов или цикл | Не наследует |
| Вытащенная со своим автором | Свой автор, исходная не важна |
| Исходной удалили автора | Вытащенные теряют автора в той же записи |
| Исходную удалили | Вытащенные теряют автора; если ссылка теперь находит другую заметку, берут её автора |
| Карточка уже в Related notes | В блоках связей не повторяется |
| Карточка уже в «Тот же адрес» | В блоке автора или сайта не повторяется |
| Группа пуста после исключений | Блок не рисуется |
| `http` и `https` одного пути, `/about` и `/about/` | Разные адреса |
| `www.example.com` и `example.com` | Один сайт и один адрес |
| `eng.basement.studio` и `basement.studio` | Разные сайты |
| Конфликт iCloud (`name 2.md`) | Обычная карточка: те же поля, те же связи, что у копии |
| Лента автора без карточек | Заглушка пустой коллекции |

## Производительность

Рассчитано на десятки тысяч карточек; ни одного полного прохода на открытие
карточки.

- Открытие карточки: один IPC; под одним снимком чтение строки по `slug`
  (уникальный индекс) и не больше двух групп по `COUNT` плюс страница, каждая
  по своему частичному индексу. Ответ не больше двух групп по 5 лёгких строк;
  раскрытие до 200 строк по нажатию.
- Лента автора: фильтр по `idx_blocks_association_author`, страницы и порядок
  как у ленты.
- Запись карточки: столбцы своей строки; для новой карточки, смены автора,
  удаления и переименования один поиск по `idx_blocks_extraction_source_name`
  (обычно пусто); для вытащенной без автора цепочка до 8 поисков по
  `idx_blocks_note_name` с разрешением ссылки среди нескольких кандидатов.
  Индекс всех путей не строится.
- Дозаполнение: один раз на версию правил, чтение `.md` каждой строки, как
  у дозаполнения коллекций; после первого кадра, не на пути запуска.
- Тест закрепляет план запроса: `EXPLAIN QUERY PLAN` групп и ленты автора
  называет свой индекс, без `SCAN blocks`.

Найдено при изучении кода, вне объёма: Related notes
(`load_bidirectional_related_notes`) на каждое открытие карточки читает все
строки `blocks` и все ссылки. Связи этой спецификации так не делают.

## Контракт тестов

Проверки соразмерны задаче: модульные тесты правил и запросов, тесты
компонентов в обоих видах открытой карточки, одна живая приёмка. Без листов
снимков, одна тема, одна ширина окна на каждый вид.

### Правила (`mine-core`, `domain/card_association.rs`, `links.rs`)

- `author_label` и `author_key`: пробелы по краям; регистр; NFC против NFD
  дают один ключ; пустая строка и одни пробелы дают `None`; `Jane  Doe` и
  `Jane Doe` разные; `@marco` и `marco` разные.
- `address_key`: `www.` снимается, `www2.` и `m.` нет; якорь снимается;
  `utm_source`, `utm_medium`, `UTM_Campaign` снимаются, прочие параметры
  остаются в своём порядке; без пар нет `?`; регистр хоста и порт по
  умолчанию не различаются; `http` и `https` различаются; `/about` и
  `/about/` различаются; `mailto:`, `file:` и мусор дают `None`.
- `site_key`: каждый домен списка и его поддомены (`x.com`,
  `mobile.twitter.com`, `pbs.twimg.com`, `t.co`, `www.instagram.com`,
  `scontent.cdninstagram.com`, `youtu.be`, `m.youtube.com`, `i.ytimg.com`,
  `cdn.cosmos.so`, `www.are.na`) дают `None`; похожие имена (`notx.com`,
  `cosmos.so.example.com`) остаются сайтами; `.jpg`, `.JPG`, `.webp`, `.mp4`
  с параметрами и без дают `None`; `.html` и `.pdf` нет; адрес Are.na вида
  `…/original_x.gif?1618434716?bc=0` даёт `None`; поддомен значим.
- `extraction_source_target`: оба литерала `source`; `Mine Source Media` при
  пустом `source`; первая из нескольких ссылок; без ссылок `None`;
  `card-merge` и `web-clipper` не вытащенные.
- `note_name_key` и `obsidian_target_name_keys`: папка, `#^id`, псевдоним,
  `.md` в цели, NFD.
- Инвариант кандидатов: на наборах путей с одинаковыми именами в разных
  папках, целью с папкой, устаревшей папкой и неоднозначной целью
  разрешение среди кандидатов совпадает с разрешением среди всех путей.

### Индекс (`storage/card_associations.rs`, `storage/migrations.rs`)

- Миграция 5 на 6 добавляет столбцы и индексы, `validate_schema` проходит;
  новая база сразу версии 6; неполная схема отвергается.
- Запись карточки заполняет столбцы; у коллекции заполнен только
  `note_name`.
- Наследование: свой автор важнее исходной; исходная найдена; не найдена;
  неоднозначна; это она сама; цепочка из двух шагов даёт автора корня; цикл
  и цепочка длиннее 8 дают «нет»; смена автора исходной меняет вытащенные и
  их производные в той же записи; удаление исходной; исходная записана после
  вытащенной (порядок полного обхода); переименование; новая заметка того же
  имени делает ссылку неоднозначной; после цикла с удалённым автором автор
  не остаётся.
- Поколение проекции растёт, когда меняется автор только у производной.
- Дозаполнение: строки версии 5 получают столбцы, карточка медиа узнаётся по
  `Mine Source Media` из файла, версия ставится, повторный запуск ничего не
  меняет.

### Чтение

- `read_card_associations`: сама карточка исключена; коллекции исключены;
  `exclude_slugs` исключены; блок автора без карточек блока адреса; у
  открытой карточки без адреса блок автора включает карточки без адреса; сайт
  только у открытой карточки без автора и только среди карточек без автора;
  пустые группы опущены; порядок групп; 5 строк и верный `total`; раскрытие
  до 200; порядок строк от новых; карточка без адреса и автора без групп;
  неизвестный `slug` без групп.
- `list_grid_blocks` с `TabLocation::Author`: регистр не важен,
  унаследованные карточки входят, страницы и `has_more`, оба порядка ленты.
- План запросов групп и ленты автора по индексам.
- `windows.json`: `Author` записывается и читается; файл версии 1 читается;
  версия 3 даёт «новее».

### Открытая карточка (`Detail.test.tsx`)

- В обоих видах (`rail` и `stacked`) блоки стоят под Related notes в порядке
  адрес, затем автор или сайт.
- Каждый блок это своя коробка `data-detail-panel-card` с подписью внутри,
  та же, что у Related notes; строки с `framed`.
- Подписи: `Same URL`; автор как написан и как кнопка, нажатие вызывает
  открытие ленты с этим автором; хост сайта текстом.
- Строки это `CardRow` с командами под указателем и открытием карточки;
  превью при наведении различает одну карточку в двух списках.
- Больше пяти строк: у автора `Show all` открывает ленту; у сайта и адреса
  `Show N more` запрашивает раскрытие и показывает все строки.
- Карточка из Related notes не повторяется; пустые группы не рисуются.
- `vault-refreshed` перечитывает связи; ответ с меньшим поколением
  отбрасывается; ошибка не рисует блоков и не трогает Related notes.

### Лента автора (`App.test.tsx`, `tabLabel.test.ts`, `tabPage.test.ts`)

- Путь `/author/@x` читает ленту с `{ kind: "author", author: "@x" }`.
- Звено пути показывает `@x`; в боковом меню ничего не выделено; вкладка
  подписана `@x`.
- Переключатель `Grid / Graph` скрыт, показана сетка и при режиме вкладки
  Graph; после выхода режим прежний.
- Шаг назад возвращает прежнее место с открытой карточкой; память вкладки
  пишет место автора, восстановление ведёт на него.
- Пустая лента автора показывает заглушку пустой коллекции, не онбординг.

### Клиппер

- `youtubeChannelFromOEmbed`: `@handle` из `author_url`; `author_name`, когда
  ссылка не того вида; пустой и неверный ответ дают `null`.
- `resolveCaptureAuthor`: адрес YouTube при каждом виде сохранения берёт
  канал; без ответа автор пуст; остальные адреса как раньше.
- Ожидание канала при сохранении ограничено сроком; ошибка запроса не
  останавливает сохранение.

### Живая приёмка (за пользователем)

Одна проверка в установленном приложении: открыть карточку `@kotecinho` из
поста с извлечениями, увидеть `Same URL` и блок автора, нажать автора,
увидеть ленту, вернуться шагом назад; сохранить видео YouTube и увидеть
канал в `Author`.

## Этапы

Совпадают с Phase 41 в [PLAN.md](PLAN.md).

| # | Этап | Содержание |
|---|---|---|
| 41.1 | Правила в ядре | `domain/card_association.rs`, ключи имён в `links.rs`, константы источников извлечения, тесты правил и инварианта кандидатов |
| 41.2 | Индекс | миграция 6, столбцы и индексы, запись, удаление и переименование, наследование, дозаполнение, тесты |
| 41.3 | Чтение и команды | `read_card_associations`, `list_card_associations`, `TabLocation::Author` и `list_grid_blocks` по месту, `windows.json` версии 2, привязки, тесты |
| 41.4 | Открытая карточка | общий список строк панели, блоки связей в обоих видах, `useCardAssociations`, тесты |
| 41.5 | Лента автора | место в странице вкладки, путь, подпись вкладки, боковое меню, сетка без графа, заглушка, тесты |
| 41.6 | Канал YouTube | oEmbed в фоновом скрипте, автор в запросе сохранения, тесты |
| 41.7 | Документы | SPEC_FRONTEND (Detail), SPEC_TABS (место автора, В47, В81), SPEC_STORAGE (столбцы), SPEC_CLIPPER (автор YouTube), DESIGN_SYSTEM (блоки), ARCHITECTURE |
| 41.8 | Живая приёмка | за пользователем |

## Проверка по PRINCIPLES.md

| Принцип | Как выполнен |
|---|---|
| 1. Контракт первичен | Этот документ: функции, столбцы, команды, поведение, краевые случаи, тесты |
| 2. Нулевой долг | Ни одного «потом»: дозаполнение, версия правил и выход из ленты описаны сразу |
| 3. Границы модулей | Правила в `domain` без SQLite и файлов; столбцы, наследование и запросы в `storage`; команда только читает |
| 4. Сквозные типы | `CardAssociations`, `CardAssociationKind`, `TabLocation::Author` из Rust через Specta; ручных типов TypeScript нет |
| 5. Ошибки | Ошибки базы через существующий `CommandError` с контекстом; «связи нет» не ошибка, а пустая группа |
| 6. Тесты | На каждое правило, исключение, событие индекса и оба вида открытой карточки |
| 8. Производительность | Частичные индексы, ни одного полного прохода на открытие и на запись |
| 9. Константы | `SHARED_PLATFORM_DOMAINS`, `CARD_ASSOCIATION_PREVIEW_ROWS`, `CARD_ASSOCIATION_EXPANDED_ROWS`, `ASSOCIATION_SOURCE_CHAIN_MAX_STEPS`, `ASSOCIATION_INDEX_VERSION`, `YOUTUBE_CHANNEL_TIMEOUT_MS`, литералы источников извлечения |
| 10. Markdown первичен | Ничего не пишется в файлы; всё выводится из `.md` и пересоздаётся с индексом |
| 11. Идемпотентность | Запись строки и пересчёт наследования дают тот же результат при повторе; дозаполнение по версии |

Исправлено при проверке:

- Унаследованный автор считался по сохранённому значению промежуточной
  карточки; в цикле удалённый автор застревал. Теперь цепочка проходится
  заново до карточки со своим автором.
- Сайт сначала хранился только у карточек без автора, и смена автора
  исходной требовала переписать сайт у чужих строк. Теперь сайт хранится у
  каждой строки, условие «без автора» ставит запрос.
- Поиск исходной строил индекс всех путей на каждую запись (полный проход
  при записи). Теперь кандидаты выбираются по имени, равенство результата
  закреплено тестом.
- Отдельный тип места ленты дублировал `TabLocation`. Теперь место одно.
- Исключение карточек блока адреса через `association_address IS NOT ?` при
  открытой карточке без адреса отбрасывало все карточки без адреса. Теперь
  условие ставится только при адресе.
