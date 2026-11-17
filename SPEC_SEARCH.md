# Surface Search and Hybrid Retrieval

**Состояние:** реализовано. Источник: PLAN.md, Phase 27 и Phase 28. **Сверка с кодом:** 15.11.2026, существование названных файлов.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

## Goal

Search is hybrid retrieval over blocks plus scoped channel filtering. The
visible block-search UI is the Search Overlay
([SPEC_SEARCH_OVERLAY.md](SPEC_SEARCH_OVERLAY.md)); this document owns the
backend read model, ranking, match metadata and card rendering rules.

- `Cmd+F` opens/closes the Search Overlay — modal block-search navigation. The
  former invisible grid-filter mode is removed: the Grid is never filtered by a
  search query.
- `Shift+Cmd+F` focuses search in the left top chrome segment and filters the
  channel list.
- `Cmd+K` remains reserved for scoped card/Detail overflow actions and never
  opens search.
- "No command palette" stays in force: the overlay searches and navigates, it
  never executes commands. There is still no `/search` route.

The main Grid search must search titles, full card content and searchable
metadata (`author`, `url`) while keeping the current page model: the user stays
on Everything or the current collection, and the same masonry Grid rerenders
with filtered/ranked cards.

The target search experience is hybrid retrieval, not a single text matcher.
The user can type a query in a different language from the saved card content
and still get relevant results. Example: a Russian query such as `память`,
`память как стая птиц` or `майн` can surface English cards containing
`memory`, `memory is a flock of birds` or `Mine` when the semantic/alias signal
is strong enough.

The implementation must preserve exact-search trust: semantic matches improve
recall, but exact title/body matches remain explainable and must not be buried
under vague semantic-neighbor results.

## Non-Goals

- No modal command palette.
- No `/search` route.
- No client-side scan over DOM nodes or Markdown files.
- No OCR/PDF/video-content search in this phase.
- No cloud-only search dependency. Any cloud embedding provider must be an
  explicit opt-in backend and cannot be required for the default local app.
- No fake highlight for semantic-only matches. Highlight ranges exist only for
  lexical/alias/fuzzy matches with a real text range in the rendered excerpt.

## Search Scopes

### Main Block Search (`Cmd+F`) — Search Overlay

`Cmd+F` opens or closes the Search Overlay; the full visual/keyboard/data
contract lives in [SPEC_SEARCH_OVERLAY.md](SPEC_SEARCH_OVERLAY.md). Key points
owned here:

- the overlay calls the dedicated route-facing backend command
  (`search_grid_blocks`) vault-wide (`currentTag` is not passed) and
  renders `LightBlock` + `search_match` per the Match Metadata / Card Rendering
  rules below;
- the Grid is never filtered by a search query: overlay results live in
  overlay-owned state, the route snapshot underneath stays untouched, and
  closing the overlay restores exactly the surface the user started from;
- the bottom app bar exposes a right-side `Search elements` action with the `⌘F`
  shortcut label and the same toggle behavior. This action is a command
  trigger, not a selected-state control: it must not remain visually pressed
  while the overlay is open;
- the top chrome is split by the same `--sidebar-width` boundary as the body:
  the left segment contains the native traffic-light spacer, the space
  selector, sidebar channel search and a `border-r border-sidebar-border`, so
  the Sidebar/Main divider continues to the top edge of the window. The right
  segment starts with the name of the current place (`TopCollectionSwitcher`,
  «Название места в верхнем ряду» ниже) and leaves the remaining pixels as
  drag region;
- group selection and the overlay do not interact: the modal overlay owns the
  keyboard entirely while open.

When `query` is non-empty, overlay ordering is relevance-first. Normal route
order in the Grid is always `saved_at DESC`.

### Sidebar Search (`Shift+Cmd+F`)

Sidebar search is a permanent top-chrome control inside the left
`--sidebar-width` segment. The visual order is: native traffic-light spacer,
one vertical `bg-border` separator, the `VaultSwitcher`/space selector, a
second vertical `bg-border` separator, a no-icon `Input ghost` search field
with the design-system `h-8 px-3` geometry, then the existing
`border-r border-sidebar-border` Sidebar/Main divider. При свёрнутом меню
левого сегмента в ряду нет, ряд начинается с названия места или открытой
карточки (решение пользователя 11.11.2026, DESIGN_SYSTEM.md, «Верхние ряды»).
До 11.11.2026 свёрнутый сегмент оставался в ряду, сжатый по `VaultSwitcher`.

The space selector shows the current folder name, truncates before the search
field, and opens a searchable known-vault dropdown. It uses the same switch
path as the previous bottom-bar vault switcher; `Cmd+Shift+O` still opens the
native folder picker.
The selector width follows the current folder name but is capped at 50% of the
remaining left chrome width (`max-w-[50%]`). Folder names use end ellipsis.
The root trigger stays transparent; hover/open/focus state is drawn only by the
inner pill around the name (`h-6 rounded-1 px-2 bg-active`), with focus fill
restricted to keyboard focus. The space selector in the top chrome shows a
dropdown chevron inside the pill, right after the name (`showChevron` of
`MenuTextTrigger`): closed it points right and turns down as the menu opens.
Pointer-open closes prevent Radix trigger auto-focus and blur the trigger, so a
single pointer click cannot leave a sticky hover-colored pill. Pointer drag
also cannot open the dropdown: pointer activation is deferred to click and a
drag-threshold gesture suppresses that click. The search field takes the
remaining width and keeps native input scrolling so the latest typed characters
remain visible. The
search control is a wrapper surface with a transparent input, not a standalone
framed input. Empty hover/focus changes only placeholder color from tertiary to
muted. A non-empty trimmed query fills only that search surface with
`bg-accent`, matching the bottom action bar, and shows an icon-only
`Clear collection search` button (`X`, `h-6 w-6 rounded-1`) on the right. Clear
restores the full channel list and returns focus to the input.

`Shift+Cmd+F` focuses/selects that top-chrome input. It filters only sidebar
channel rows and does not change the route or Grid dataset.
`Everything` is part of the filtered row set: it remains visible only when the
query is empty or matches `Everything` / `__all__`.
While that input is focused, unmodified `ArrowUp`/`ArrowDown` move a persistent
active descendant across visible Sidebar rows, including the bottom create row,
without moving DOM focus out of the input; the user can keep typing after arrow
navigation. `Enter` activates the active row. `Escape` clears a non-empty
sidebar search value; with an empty value it blurs the input and clears the
active descendant.

### Название места в верхнем ряду

Правый сегмент верхнего ряда начинается с названия места
(`TopCollectionSwitcher.tsx`): `Everything`, название открытой коллекции или
автор в его ленте. Это не область поиска и не переход: с 31.10.2026 у названия
нет выпадающего списка, поля `Search collections`, пункта `Create collection`
и стрелки (решение пользователя 31.10.2026; SPEC_FRONTEND.md, пункт о
`TopCollectionSwitcher`; DESIGN_SYSTEM.md, «Верхние ряды»). Место меняют
боковое меню и ⌘⌥↑↓, коллекцию создают боковое меню, ⇧⌘N и меню карточки.
Щелчок по названию коллекции открывает поле переименования (`ChromeNameField`),
`Everything` и автор это простой текст. Отступ названия от линии сегмента или
от края окна задаёт `--top-collection-pad-x`, он равен `--chrome-edge-pad`. При
свёрнутом меню сегмента пространства перед названием нет, и оно стоит от края
окна (решение пользователя 11.11.2026, DESIGN_SYSTEM.md, «Верхние ряды»).
Название занимает ряд до `Grid / Graph` и кончается многоточием, только когда
упирается в них, в 4 px перед ними; пока в ряду стоят команды выделения, оно
занимает половину ряда (решение пользователя 15.11.2026, DESIGN_SYSTEM.md,
«Верхние ряды»; до него предел был половина ряда всегда).

The space switcher dropdown does not list the current space, marks no row as
current with a check and puts no icon on space rows. It has its own `Search
spaces` input, lists only destination spaces and keeps pinned `Reveal in
Finder` and `Add space` actions. `Search spaces` and Sidebar channel search use
the same input-owned keyboard model (the collection switcher's
`Search collections` went with its menu on 31.10.2026):
`ArrowUp`/`ArrowDown` change `aria-activedescendant`, pointer hover may update
the active row, but focus remains in the search input.

Sidebar search is client-side because taxonomy/channel rows are already a small
App-owned read model. Matching is centralized in `src/lib/channelSearch.ts`:
case-insensitive exact/prefix/word-prefix/substring ranking first, then bounded
Damerau-Levenshtein typo tolerance for queries of at least 3 characters. Ties
keep the current channel order, so the sidebar remains deterministic.

## Keyboard Contract

| Shortcut | Scope | Behavior |
|---|---|---|
| `Cmd+F` | Search Overlay | Open/close the modal block-search overlay (keyboard contract inside: SPEC_SEARCH_OVERLAY.md) |
| `Shift+Cmd+F` | Sidebar | Focus/select the top-chrome channel search input |
| `Escape` in sidebar search input | Sidebar | Clear the query; if empty, blur the input |
| `Escape` in the search overlay | Search Overlay | Close the overlay regardless of query |

Shortcut handlers must ignore editable/nested overlay targets using the shared
keyboard target helpers. `Cmd+F` and `Shift+Cmd+F` must call `preventDefault()`
only when Mine owns the shortcut; they must not leak into any browser/webview
find behavior.

Desktop shortcut delivery must not depend on DOM `keydown`: Tauri registers
native menu accelerators for `Cmd+F` and `Shift+Cmd+F` and emits
`surface-search-shortcut` with `main` or `sidebar`. The frontend `keydown`
handler remains a browser/dev fallback and must be keyboard-layout independent:
use the physical `KeyboardEvent.code === "KeyF"` path in addition to the Latin
`key === "f"` so `Cmd+F` works on non-Latin macOS layouts.

## Backend Read Model

Main search uses a dedicated route-facing `search_grid_blocks` snapshot, not
the normal Grid command and not the removed global `search()` frontend surface.

```ts
interface SearchGridBlocksParams {
  currentTag?: string;
  limit: number;
  query: string;
  cursor?: SearchPageToken;
}

interface SearchSnapshot {
  generation: ProjectionRevision;
  search_generation: SearchRevision;
  blocks: LightBlock[];
  has_more: boolean;
  next_cursor: SearchPageToken | null;
  cursor_reset: boolean;
}
```

If `query` is empty, Search Overlay recent mode uses vault-wide
`list_grid_blocks` and keeps the normal SQL path:

- filter out channel documents;
- optional `block_tags` filter for `currentTag`;
- `ORDER BY saved_at DESC`;
- `LIMIT limit + 1 OFFSET offset`.

If `query` is non-empty, `search_grid_blocks` uses the backend `SearchEngine`
path:

- sync normalized derived `search_chunks` for changed indexed blocks, found
  by their stamps without reading any text («Отметка документа» below);
- run lexical FTS5 over `blocks_fts`;
- run alias/transliteration-expanded FTS5 groups;
- match authors and addresses through their own FTS index («Авторы и адреса»
  below);
- run typo-tolerant fuzzy matching through the word dictionary of
  `search_chunks` («Словарь слов» below);
- run semantic vector retrieval over persisted `search_embeddings` when local
  model vectors are available;
- fuse candidates into one deterministic relevance order;
- return the same lightweight `LightBlock` projection and optional
  `search_match` metadata.

The FTS column weights are:

| FTS column | Indexed source | Weight |
|---|---|---:|
| `title` | `display_title`, legacy `title`, `fallback_label` | `8.0` |
| `description` | frontmatter/link description | `3.0` |
| `body` | full Markdown body after frontmatter | `1.0` |

`bm25(...) ASC` is required: in SQLite FTS5 lower scores are better.

Колонка `title` в FTS хранит все имена карточки и только отбирает и
упорядочивает кандидатов: карточка с совпавшим H1 не выпадает из окна
кандидатов. Поле совпадения и ранг задаёт `build_search_match`, где `title`
означает только имя файла (см. Match Metadata).

The lexical layer still uses SQLite FTS5. The route-facing backend is a local
`SearchEngine` layer with four sources of evidence:

| Layer | Purpose | Required behavior |
|---|---|---|
| Lexical index | Exact, prefix and phrase-like matches | Fast route-filtered matching over title/description/body with stable snippets |
| Alias index | Human aliases, transliteration, localized names | `майн`/`mine`, `память`/`memory`, domain/source aliases and curated synonym sets |
| Semantic vector index | Cross-language and meaning-based recall | Russian query can retrieve English content by meaning without literal overlap |
| Fusion/rerank | Combine evidence into one ordered Grid | Exact lexical trust is preserved while semantic recall improves discovery |

The frontend calls one route-facing search command for non-empty queries. It must not know
whether a result came from FTS5, Tantivy, aliases or vector search except through
explicit match metadata.

Implemented behavior:

- `search_grid_blocks(...)` delegates non-empty queries to the backend
  `SearchEngine` boundary;
- lexical retrieval still uses SQLite FTS5 with prefix terms;
- query planning refuses stopword-filtered queries shorter than 2 alphanumeric
  characters, so one-letter fragments never reach the full text/alias/semantic
  retrieval; a query of exactly one letter or digit goes the separate name
  path instead («Запрос из одного символа» below);
- query planning expands stopword-filtered token groups with deterministic
  aliases/transliteration;
- each token group is route-filtered as an OR group internally, while different
  meaningful groups remain AND requirements;
- Russian aliases such as `память`, `стая`, `птиц`, `майн` can retrieve English
  terms such as `memory`, `flock`, `birds`, `mine`;
- fuzzy candidates are produced from normalized chunks and return real ranges;
- semantic retrieval uses local `fastembed` + `intfloat/multilingual-e5-small`;
- semantic vectors are persisted in SQLite with model id, dimension and chunk
  hash;
- `fastembed` model files are cached outside the repo under
  `~/Library/Application Support/com.mine.app/cache/fastembed` unless
  `FASTEMBED_CACHE_DIR` is explicitly set;
- single-token Latin queries stay strict and bypass semantic embedding work:
  semantic-only cards are not injected into the visible result set;
- semantic-only cards are allowed for cross-language Cyrillic queries and
  multi-token semantic queries where literal matching alone is insufficient,
  but only after the normalized meaningful query has at least 3 alphanumeric
  characters. One- and two-character queries stay lexical/alias/fuzzy only so
  `в`, `ав` or mixed-layout fragments cannot pull a 200-row semantic tail;
- background metadata backfill warms chunks/vectors after vault open; keypress
  search never downloads a model or generates missing embeddings in the
  foreground;
- when the local semantic model is still warming or vectors are unavailable,
  search degrades to lexical/alias/fuzzy results for the same input;
- fusion collapses duplicate chunk hits to one card and keeps exact title/body
  evidence above weaker semantic-only evidence.

## Search Documents And Chunks

Search operates on derived search documents, not directly on rendered cards.
The `.md` file remains the source of truth; every search artifact is rebuildable
from Markdown + frontmatter + media metadata.

```rust
struct SearchDocument {
    block_id: i64,
    slug: String,
    title: Option<String>,
    description: Option<String>,
    body: String,
    document_hash: String,
}

struct SearchChunk {
    block_id: i64,
    slug: String,
    chunk_index: usize,
    field: SearchField,
    text: String,
    start_char: usize,
    end_char: usize,
    text_hash: String,
}
```

Chunking rules:

- title and description are single chunks;
- article/social body chunks use a bounded token window with overlap;
- chunks must keep offsets back to normalized plain text so snippets can map to
  rendered excerpts;
- chunks include enough surrounding text for cards to show a useful 2-3 line
  preview without loading the full `.md` during keypress search.

## Query Semantics

Search input is tokenized by whitespace. Each token is escaped for FTS5 and
sent as a prefix token (`"mem"*`, not `"mem"`), because Surface Search filters
while the user is still typing. The implementation must not expose raw FTS
syntax to the user.

Rules:

- multi-token text is an AND query;
- matching is case-insensitive according to the SQLite FTS tokenizer;
- empty or whitespace-only query is the normal Grid route;
- after stopword filtering, a query with fewer than 2 alphanumeric characters
  is treated as not ready and returns no search plan, except a query of one
  letter or digit, which searches names («Запрос из одного символа»);
- semantic-only retrieval is gated until the stopword-filtered query contains
  at least 3 alphanumeric characters;
- invalid punctuation must not throw user-visible SQL/FTS errors.

Hybrid query normalization additionally produces:

- `literal_terms`: original lexical tokens;
- `normalized_terms`: lowercase/diacritic-normalized terms;
- `alias_terms`: curated aliases, transliterations and localized labels;
- `semantic_query`: the full user query for embedding;
- `language_hint`: best-effort language/script classification for ranking and
  diagnostics, never a hard filter.

### Запрос из одного символа

Решение пользователя 15.11.2026: поиск начинается с первого символа, но на
одном символе ищет только по названиям. Запрос, который после обрезки пробелов
состоит из одной буквы или цифры (`char::is_alphanumeric`), ищет карточки, у
которых какое-то слово имени файла начинается с этого символа без учёта
регистра. Имя файла здесь то же поле `title`, что в Match Metadata: последний
сегмент `slug`, которое показывает строка результата. H1 и legacy
`frontmatter.title` на одном символе не ищутся, как они не дают совпадения
`title` и на длинном запросе. Текст, описание, автор, адрес, псевдонимы,
транслитерация и поиск по смыслу на одном символе не участвуют, служебные
слова не отбрасываются: символ это начало слова, а не слово. Порядок по
свежести, как у недавних карточек при пустом запросе (`FeedOrder::Newest`:
`saved_at DESC`, затем имя). Совпадение возвращается как `field: "title"`,
`kind: "prefix"` (`"exact"`, если слово из одной буквы латиницы), диапазон
покрывает первую букву совпавшего слова. Регистр сравнивается по правилу
подсветки: `to_lowercase` и начало слова после символа, который не буква и не
цифра. Знаки с диакритикой различаются (`e` не находит `école`), потому что
так же различает подсветка длинных запросов.

Путь использует индекс: префиксный запрос `title : "x"*` к колонке `title` в
`blocks_fts` даёт надмножество ответа, потому что эта колонка хранит все имена
карточки, имя файла среди них. Читаются и сортируются только `slug`
кандидатов, имя файла решает, и строки страницы читаются так же, как лента
(`grid_rows_by_slug`). Один знак, который не буква и не цифра, остаётся
ожиданием и плана не получает. Запросы от двух символов не меняются. Так же
отвечают `mine search` и MCP-инструмент `search`: они идут через тот же
`SearchEngine`.

For cross-language queries, semantic search is required. Transliteration and
alias expansion are useful recall helpers, but they are not a substitute for a
multilingual embedding model.

## Ranking And Fusion

The search engine returns one ordered result set with per-result evidence.
Ranking must be deterministic for a fixed index and query.

Evidence classes:

| Match kind | Meaning | UI treatment |
|---|---|---|
| `exact` | Literal token/phrase appears in rendered title/description/body | Highlight matched range |
| `prefix` | User typed a token prefix | Highlight only the typed prefix range |
| `fuzzy` | Typo-tolerant lexical match | Highlight corrected matched token and mark as fuzzy evidence |
| `alias` | Query matched an alias/transliteration/synonym | Highlight target token if present; otherwise show alias evidence |
| `semantic` | Vector similarity match without literal overlap | Show semantic excerpt, no fake text highlight |

Fusion contract:

- exact title matches outrank semantic-only body matches;
- exact/prefix body matches outrank weak semantic-only matches;
- semantic matches can outrank stale/weak lexical matches when the semantic
  score is high and lexical evidence is absent or low-value;
- collection route filtering is applied before final result return;
- recency is a tie-breaker, not the primary relevance signal;
- duplicates from multiple chunks collapse to one card result using the best
  evidence and best excerpt.

The implementation uses explicit, auditable boosts: title/description/body
field priority, exact/prefix/alias/fuzzy kind priority, semantic cosine score
and `saved_at` as a tie-breaker. The architecture keeps the formula inside
`storage::search_engine`, so it can be replaced by a learned/reranker model
without changing the frontend command contract.

## Match Metadata

`LightBlock` can carry optional search-only metadata:

```ts
interface SearchMatch {
  field: "title" | "description" | "author" | "body" | "url" | "semantic";
  kind: "exact" | "prefix" | "fuzzy" | "alias" | "semantic";
  excerpt: string;
  ranges: Array<{ start: number; end: number }>;
  score: number;
  explanation?: string;
}
```

The backend returns plain text plus character ranges. Prefix matches highlight
only the typed prefix: query `memo` over `memory` returns the `memo` range, not
the full `memory` token. It must not return HTML or SQLite snippet markup for
direct rendering.

Field priority for the visible first match:

1. `title`
2. `description`
3. `body`

`author` and `url` are searchable metadata fields, but they are not visible
highlight surfaces. An author-only or URL-only match can return and rank a card,
but the backend must return an empty `ranges` array for that match. The card
keeps its normal title/preview rendering; it must not replace the preview with
the author string, must not reveal the hidden URL, and must not draw a fake
mark.

Поиск называет результат именем файла (решение пользователя от 05.10.2026).
Поле `title` везде означает имя `.md` файла карточки без папки и без `.md`,
то есть последний сегмент `slug` (`Cards/Шуховская башня` даёт
`Шуховская башня`), то самое имя, которое меняет переименование. Из него
собран чанк `title`, по нему считаются совпадение `title`, его `excerpt` и
диапазоны, его же показывает строка списка в оверлее. H1 заметки и legacy
`frontmatter.title` в поле `title` не входят: H1 лежит в теле и находится как
совпадение `body` со сниппетом. Имя файла видно в строке у любой карточки,
поэтому у социальных карточек совпадение в имени тоже видимое совпадение
`title`. Так же называют результат `mine search` в терминале и
MCP-инструмент `search`: имя файла лежит в поле `name` их JSON, а поле
`title` там по контракту CLI остаётся видимым заголовком заметки
([SPEC_AI_ACCESS.md](SPEC_AI_ACCESS.md)).

For `description`, `excerpt`
is the description text around the first visible match. For `body`, `excerpt`
is a whitespace-normalized article slice around the first visible match.
For `author` and `url`, `excerpt` may contain the matched metadata for ranking
explanation/debugging, but the frontend treats it as non-rendered metadata.

Match metadata is built only for returned rows, never for the full result set.

Semantic-only matches return `kind: "semantic"`, `field: "semantic"` and an
empty `ranges` array unless the chosen excerpt also contains a literal/alias
range. The card renders the excerpt normally and may show subtle secondary
metadata later, but it must not invent highlight ranges.

## Card Rendering

Article-derived feed cards in active main search mode use search metadata,
including social/X/Instagram cards with media previews:

- if `field === "title"`, render the normal title with highlighted ranges and
  keep normal preview behavior;
- if `field === "description"` or `field === "body"`, replace the normal
  preview text with a 2-3 line excerpt around the first match;
- if `field === "author"` or `field === "url"`, keep the normal card preview
  and draw no highlight; those fields only explain why the card was returned;
- highlighted ranges render with the design-system search mark token;
- semantic-only excerpts render without highlighted text;
- clearing the query restores normal title/preview rendering.

Standalone media cards do not synthesize body excerpts. They may highlight
title or description matches, but empty-body media remains visually media-first.

Search metadata must not affect masonry measurement stability outside active
search mode. In active search mode, layout recomputes from the filtered blocks
and the excerpt text actually rendered by cards.

## Frontend Data Flow

App owns:

- `searchOverlayOpen` and `searchOverlayQuery` (session-lived, see
  SPEC_SEARCH_OVERLAY.md);
- `sidebarSearchQuery`;
- `sidebarSearchFocusSequence`;
- per-route normal snapshot cache (route-keyed only — search never touches it).

Overlay search requests are owned by the overlay component: a debounced
`search_grid_blocks(undefined, query, limit, cursor)` call with a request
sequence. A continued page uses only the opaque cursor returned by the previous
`SearchSnapshot`; it never invents an offset.
Search results are never applied if:

- the query changed after request start;
- a newer request sequence completed first;
- the overlay closed.

A newer search of the same tab stops the older one in the backend
(«Отмена устаревшего запроса» below). The older request is rejected with the
error `search_superseded`; the overlay has already dropped its sequence, so
the rejection is never shown.

Every search response carries both `ProjectionRevision` and `SearchRevision`.
If either changed, or the cursor query fingerprint differs, backend returns a
reset snapshot from offset zero; frontend replaces the result set and never
combines ranking pages from different revisions.

Debounce: `100ms`. It is short enough to feel live while avoiding one IPC
request per key repeat.

Hybrid search may return in two phases:

1. lexical/alias results, fast enough for live typing;
2. semantic fusion results when embeddings are available.

If the engine uses two phases, the frontend still receives monotonic snapshots
for the same query sequence. It must never flash unrelated results from an older
query. The first usable result set should appear quickly; semantic enrichment
must refine ordering without blocking typing or route switching.

## Derived Storage

Hybrid search adds rebuildable derived storage under the local app data store,
keyed by `vault-id`, never inside the synced vault:

| Store | Content | Rebuild source |
|---|---|---|
| `blocks_fts` or replacement lexical index | title/description/body terms | Markdown + frontmatter |
| `search_alias_terms` | aliases, transliterations, localized names | deterministic alias builder + curated config |
| `search_chunks` | normalized searchable chunks and offsets | Markdown + frontmatter |
| `search_words` | the dictionary: every word of four characters or more that a chunk holds | `search_chunks` |
| `search_word_chunks` | which chunks hold each dictionary word | `search_chunks` |
| `search_metadata_terms` | every word of the author and address chunks | `search_chunks` |
| `search_embeddings` | embedding vectors with model metadata | `search_chunks` + embedding model |

Схема 8 (15.11.2026, `migrate_v7_to_v8` в `storage/migrations.rs`) добавляет
к таблицам поиска:

```sql
ALTER TABLE search_document_state ADD COLUMN source_stamp TEXT;
ALTER TABLE search_state ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_state ADD COLUMN synced_source_revision INTEGER;

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

и триггеры `search_chunk_terms_ad` (удалённый фрагмент уходит из обоих
индексов слов), `search_source_ai` и `search_source_au` (счётчик
`source_revision`). Что они значат, сказано в разделе «Устройство поиска на
большом пространстве».

Embedding rows include `model_id`, vector `dim`, `text_hash` and `updated_at`.
Changing the model id, vector dimension or chunking contract invalidates only
derived embeddings; user files are never rewritten.

Default privacy contract:

- local-first search must work without network;
- lexical/alias search is always available;
- semantic search requires a local embedding model by default;
- optional remote embeddings require explicit user opt-in and must be replaceable
  by local embeddings without changing the search API.

## Indexing Lifecycle

Watcher/indexer responsibilities:

- update lexical and alias artifacts synchronously with block indexing;
- enqueue embedding jobs for changed chunks;
- mark semantic state as `ready`, `building`, `stale` or `unavailable`;
- keep stale embeddings searchable only when their `chunk_hash` still matches;
- never block Grid rendering on embedding generation.

Search behavior by semantic state:

| Semantic state | Behavior |
|---|---|
| `ready` | Full hybrid fusion |
| `building` | Lexical/alias results immediately; semantic results appear as chunks complete |
| `stale` | Lexical/alias only for changed chunks; unchanged ready chunks remain semantic-searchable |
| `unavailable` | Lexical/alias search only, with no degraded UI chrome |

## Interaction With Selection And Navigation

The overlay is modal: while open it owns the keyboard entirely, so it cannot
conflict with Grid group selection or Grid keyboard focus. The Grid dataset is
never filtered by search, so no focus pruning is needed.

Opening a result is normal card open behavior into Detail; the overlay closes.
For a card outside the current route's grid, Detail's sibling navigation has no
neighbors — an accepted soft degradation (SPEC_SEARCH_OVERLAY.md).

## Устройство поиска на большом пространстве

Решение 15.11.2026 ([AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md), П1–П5,
строки 2 и 12 плана). До него запрос от четырёх знаков читал текст всех
фрагментов пространства, первый поиск процесса заново читал и резал тексты
всех карточек, а каждый запрос открывал соединение с проверкой схемы. Правила
ниже меняют только объём работы. Состав выдачи, порядок, поля совпадения и
диапазоны подсветки остаются прежними.

### Словарь слов

Поиск с опечаткой сравнивает слова запроса не с текстом, а со словарём слов
пространства.

- Слово это непрерывный ряд букв и цифр (`char::is_alphanumeric`) в тексте
  фрагмента, приведённом к нижнему регистру (`to_lowercase`). Это то же
  правило, по которому поиск с опечаткой делил текст на слова до 15.11.2026
  (`token_ranges`). В словарь входят слова от четырёх знаков: короче поиск с
  опечаткой не рассматривает.
- Словарь хранит таблица `search_words` (`chars`, `word`): слово и его длина
  в знаках, ключ по длине и слову. В каких фрагментах встречается слово,
  хранит индекс `search_word_chunks`: таблица FTS5 без содержимого
  (`content=''`, `contentless_delete=1`, `detail=none`), её `rowid` это `id`
  фрагмента. Разбор `ascii` этой таблицы оставляет слова как есть: буквы
  ASCII в них уже строчные, а байты вне ASCII он считает частью слова и не
  меняет. Поэтому слова в индексе совпадают со словами правила побайтно.
- Слова пишет та же функция, что пишет фрагменты документа
  (`write_search_document`, слова фрагмента: `index_chunk_terms`), в той же
  транзакции. Удаление фрагмента убирает
  его строку из `search_word_chunks` триггером `search_chunk_terms_ad`, в том
  числе когда фрагменты уходят вместе с удалённой карточкой.
- Из `search_words` слова не удаляются. Слово, которого больше нет ни в одном
  фрагменте, остаётся в словаре и ничего не находит. Словарь строится заново
  вместе с индексом.
- Запрос берёт свои слова от четырёх знаков, состоящие только из букв и цифр.
  Для каждого он читает из словаря слова подходящей длины: длина слова
  запроса плюс-минус допустимое расстояние (1, а от шести знаков 2). Слово
  словаря подходит по прежнему правилу: расстояние Левенштейна до слова
  запроса от 1 до допустимого, и ни одно из двух слов не начинается с
  другого.
- По подошедшим словам `search_word_chunks` называет фрагменты. У каждого
  такого фрагмента читаются карточка, имя и поле, без текста. Карточка
  проверяется один раз: она не страница коллекции и входит в коллекцию
  маршрута, если поиск идёт внутри коллекции.
- Текст читается только у фрагмента, по которому карточка найдена. Это
  первый фрагмент карточки с опечаткой в прежнем порядке предпочтения: выше
  вес поля, затем меньший `id`. По его тексту `first_typo` находит первое
  слово с опечаткой и его диапазон: слово текста считается опечаткой, если
  оно входит в набор подошедших слов словаря. Диапазон берётся по строчному
  тексту и применяется к исходному, как раньше; слово, диапазон которого не
  попадает на границы знаков исходного текста, пропускается, как раньше.
- Слово длиннее 32 768 байт в словарь не входит: это предел слова в индексе
  FTS5. Поиск с опечаткой такое слово не находит.

Объём работы запроса зависит от размера словаря и от числа фрагментов с
подошедшими словами, а не от объёма текста пространства.

### Отметка документа

Какие документы поиска устарели, решает сравнение отметок запросом SQL. Тела
карточек читаются только у устаревших документов.

- Отметка карточки это её поля, от которых зависит документ: `slug`,
  `description`, `author`, `url` и `body_hash`, соединённые знаком `U+001F`.
  Отметку, с которой документ построен, хранит
  `search_document_state.source_stamp`. Сравнение идёт в SQL: документ
  устарел, если его строки нет или её `source_stamp` отличается от отметки
  карточки. В памяти процесса отметки больше не хранятся, поэтому первый
  поиск процесса не читает ни одного тела, если документы записаны.
- Сравнение не идёт на каждый запрос. `search_state.source_revision` растёт
  триггерами `search_source_ai` и `search_source_au`, когда карточка
  появляется в индексе или у неё меняется поле отметки или `card_kind`.
  Сверка записывает номер, на котором она прошла, в
  `search_state.synced_source_revision`. Пока оба номера равны, запрос
  читает одну строку `search_state` и больше ничего не сверяет. Запись
  превью, коллекций и остальных полей карточки номер не меняет.
- Сверка устаревшего документа: тело читается и режется на фрагменты. Если
  хэш документа прежний, фрагменты и их векторы остаются, меняется только
  отметка. Если хэш другой, фрагменты и слова документа пишутся заново.
- Документы, записанные до схемы 8, отметки не имеют
  (`source_stamp IS NULL`), и слов для них в словаре нет. Первая сверка после
  обновления читает их тела один раз: документ с прежним хэшем сохраняет
  фрагменты и векторы и получает слова и отметку. Эту работу делает прогрев
  после открытия пространства; поиск, пришедший раньше прогрева, делает её
  сам.
- Документ с отметкой карточки заново не строится. Поэтому изменение
  правила, по которому строится документ (другое поле, другой размер
  фрагмента), идёт вместе с миграцией, которая очищает `source_stamp` и
  `synced_source_revision`: тогда следующая сверка сравнит каждый документ.
- Сверка поиска, которая не может писать, потому что индекс в это время
  пишет другое соединение (прогрев перестраивает документы), оставляется
  следующему поиску. Этот поиск отвечает по документам как они есть, как
  поиск только для чтения, а не кончается ошибкой занятой базы.
- Сверка вне транзакции вызывающего (прогрев) пишет документы пачками по 200
  в своих транзакциях, чтобы не держать замок записи индекса всю перестройку.
  Номер сверки записывается после последней пачки: прерванная перестройка
  продолжается со следующей сверки с того документа, на котором остановилась.
  Сверка внутри снимка поиска идёт в его транзакции и откатывается вместе с
  ним, номер сверки в том числе.

### Авторы и адреса

Совпадения в авторе и адресе ищутся через индекс, а не проходом по всем
фрагментам этих полей.

- Все слова фрагментов `author` и `url` (любой длины, то же правило слова)
  хранит `search_metadata_terms`: таблица FTS5 того же устройства, что
  `search_word_chunks`, её `rowid` это `id` фрагмента.
- Совпадение по-прежнему решает `first_match_range` по тексту фрагмента:
  искомая строка должна стоять в тексте с начала слова. Индекс только
  отбирает фрагменты. Искомая строка делится на слова по тому же правилу;
  фрагмент отбирается, если в нём есть все её слова, кроме последнего,
  целиком и слово, которое начинается с последнего. Каждый фрагмент, где
  строка стоит с начала слова, этому условию отвечает.
- Исключение: текст, в котором приведение к нижнему регистру меняет длину
  знака в байтах (например, `İ` или знак кельвина `K`). `first_match_range`
  считает смещения по строчному тексту, а границу слова проверяет по
  исходному, и в таком тексте её ответ словами не предсказывается. Такой
  фрагмент получает в индексе служебное слово `§` и отбирается при любом
  запросе; решает по-прежнему `first_match_range`. Правило слова `§` не даёт:
  это не буква и не цифра.

### Поиск по словам в два шага

До 15.11.2026 запрос к `blocks_fts` упорядочивал все найденные карточки
вместе с их строками и для этого читал текст каждой найденной карточки
([AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md), П5). Теперь шагов два, порядок
карточек тот же.

- Первый запрос находит карточки и упорядочивает их (`bm25`, затем
  `saved_at DESC`), возвращая только `id` оставленных кандидатов. Число
  кандидатов прежнее: `offset + limit + 200`.
- Строки с описанием и текстом читаются по `id` только у оставленных
  кандидатов, и совпадение каждого строит прежняя `build_search_match`.
- Совпадение карточки, найденной по тексту, требует весь её текст без
  разметки и в нижнем регистре: около 0,2 мс на статью в 20 КБ, а кандидатов
  до 400. Поэтому совпадения строятся в четырёх потоках, когда текста
  кандидатов вместе больше 256 КБ. Совпадение строится только из своей
  строки, и потоки ответа не меняют.
- Карточка должна отвечать каждой группе слов запроса. Если группа одна или
  у групп нет общего слова, это одно выражение FTS5: группы через `AND`. Оно
  находит те же карточки, что прежнее выражение (все слова через `OR` и
  отдельное сужение по каждой группе), и `bm25` даёт им тот же счёт: счёт
  складывается по фразам выражения, а фразы те же и в том же порядке.
- Если у групп есть общее слово (запрос `memory память`: каждое слово
  псевдоним другого), остаётся прежнее выражение. В нём общее слово стоит
  один раз; в выражении через `AND` оно стояло бы дважды и дважды вошло бы
  в счёт.

### Строки только для страницы ответа

Кандидат, найденный через фрагмент (автор, адрес, опечатка), участвует в
порядке ответа без своей строки: порядку нужны только счёт, `saved_at` и
имя. Строка карточки читается после того, как из порядка вырезана страница
ответа, и только у карточек этой страницы. До 15.11.2026 строка читалась у
каждого кандидата.

Так идёт кандидат, чей документ записан под нынешним именем карточки. Если
документ отстал от переименования (такое видит только поиск без сверки:
`mine search` и MCP), карточка ищется по имени документа до порядка, как
раньше.

### Соединение поиска

У открытого пространства одно соединение поиска на файл индекса
(`SearchSessions` в `commands/search.rs`, поле `AppState.search`).

- Соединение открывается первым поиском пространства и проверяет схему один
  раз, при открытии. Следующие запросы схему не проверяют.
- Запросы вкладок одного пространства идут по соединению по очереди.
- Соединение закрывается, когда его файл индекса больше не обслуживает ни
  одно открытое пространство: пространство закрыто или индекс восстановлен в
  другом месте. Это проверяет следующий поиск любой вкладки.
- Повреждённый индекс: запрос с ошибкой повреждения закрывает соединение и
  повторяется прежним путём с восстановлением
  (`read_owned_search_projection`); следующий поиск открывает соединение к
  восстановленному индексу.
- `mine search` и MCP-инструмент `search` читают индекс своим соединением
  только для чтения и документы не сверяют, как раньше. Пока приложение не
  сверило документы после обновления схемы, они отвечают без совпадений по
  автору, адресу и слов с опечаткой: это отставание от приложения, о котором
  говорит [SPEC_AI_ACCESS.md](SPEC_AI_ACCESS.md).

### Отмена устаревшего запроса

Новый поиск вкладки останавливает её прежний поиск.

- У каждой вкладки свой счётчик запросов. Команда `search_grid_blocks`
  первым делом берёт следующий номер. Если по соединению сейчас идёт запрос
  той же вкладки с меньшим номером, его текущий запрос SQLite прерывается
  (`InterruptHandle`). Запрос другой вкладки не прерывается.
- Между шагами поиск сверяет свой номер со счётчиком вкладки и
  останавливается, если номер устарел. Шаги: ожидание соединения, сверка
  документов, поиск по словам, авторы и адреса, поиск с опечаткой, поиск по
  смыслу, слияние. Сверка документов и поиск с опечаткой сверяют номер и
  внутри своего цикла.
- Прерывание, которое пришло между двумя запросами SQLite одного поиска,
  ничего не прерывает: так его определяет SQLite. Такой поиск останавливается
  на следующей сверке номера.
- Остановленный запрос кончается ошибкой `search_superseded`. Его снимок
  откатывается: незаконченная сверка документов не остаётся в индексе.
- Запрос, после которого новый не пришёл (поле очищено, оверлей закрыт),
  дорабатывает до конца, и страница его ответ отбрасывает.

### Замер шагов

Каждый запрос команды `search_grid_blocks` пишет в журнал приложения
`Mine.log` одну строку уровня info, по образцу замера слияния
([SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md), «Замер слияния»). В строке только
числа и названия шагов: ни текста запроса, ни путей, ни названий.

```
search timing: done chars=5 terms=1 cards=10000 results=200 total_ms=41.3 steps: fresh=0.4 wait=0.0 sync=0.1 lexical=20.1 metadata=0.4 fuzzy=3.2 fuse=1.2
```

`chars` это число знаков запроса, `terms` число его значимых слов, `cards`
число карточек пространства, `results` число строк ответа, `total_ms` время
от вызова команды до её ответа. Вместо `done` стоит `superseded` у
остановленного запроса и `failed` у запроса с ошибкой; у них нет `cards` и
`results`, а шаги перечислены до того, на котором запрос кончился. В строке стоят только шаги, которые у запроса были, в порядке,
в котором они шли. Строку пишет команда (`search_timing_line` в
`commands/search.rs`); время шагов собирает `SearchRun` в
`storage/search_engine.rs`.

| Шаг | Что идёт |
|---|---|
| `fresh` | до поиска: проверка, что индекс не отстал от файлов (`ensure_vault_fresh`), и ожидание потока для поиска |
| `open` | открытие соединения с проверкой схемы; есть только у первого поиска пространства |
| `wait` | ожидание соединения поиска, пока по нему идёт другой запрос |
| `sync` | сверка документов поиска |
| `names` | запрос из одного знака: поиск по именам файлов |
| `lexical` | поиск по словам в `blocks_fts` и совпадения найденных карточек |
| `metadata` | авторы и адреса |
| `fuzzy` | поиск с опечаткой |
| `semantic` | поиск по смыслу; есть только у запроса, которому он разрешён |
| `fuse` | слияние кандидатов, порядок и строки страницы |

## Performance Contract

The search path must stay fast for large vaults:

- no Markdown file reads during keypress search;
- no DOM scanning;
- search runs on a blocking backend task off the UI thread;
- return `limit + 1` lightweight rows, not full `IndexedBlock` bodies;
- build excerpts only for returned rows;
- keep existing virtual masonry and pagination;
- semantic search uses chunk-level vector lookup and returns candidate slugs
  before card projection; the storage boundary can move this to ANN later
  without changing the frontend contract;
- embedding generation is background work and must not run on the UI thread.

Behavior target: typing in a 10k-card vault remains interactive. If profiling
shows IPC payload or excerpt generation as the bottleneck, reduce result payload
before changing the visual contract.

Semantic behavior:

- first lexical results should remain sub-100ms for warm local indexes;
- semantic refinement should feel progressive, not blocking;
- a vault without completed embeddings must still feel functional.

Пределы (15.11.2026, [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md), строки 2 и
12 плана). Набор: 10 000 карточек с 30 МБ текста, сборка с оптимизацией
приложения, слой поиска по смыслу не загружен.

| Запрос | Предел |
|---|---|
| один знак | 100 мс |
| два знака, слово, два слова, слово с опечаткой, отсутствующее слово: худший | 100 мс |
| первый поиск процесса, с открытием соединения | 150 мс |

Число кандидатов запроса из двух знаков не ограничивается: ограничение молча
меняет выдачу (решение пользователя 15.11.2026). Пределы утверждают тесты
скорости `…_within_its_limit` (`bun run test:rust-speed`, входит в `verify`).

## Test Contract

Backend:

- text search matches `display_title`, fallback label, description and body;
- cross-language query over a semantic-ready index can return a card with no
  literal token overlap;
- transliteration/alias query can return the canonical card;
- collection search combines FTS and `block_tags` filter;
- relevance order prefers title matches over body-only matches;
- author and URL matches return the matching card without visible highlight
  ranges;
- exact title matches outrank semantic-only body matches;
- punctuation in user query cannot break FTS SQL;
- one-character Cyrillic/Latin queries return no full search plan; one letter
  or digit finds file names with a word starting with it, case aside, newest
  first, never by text, H1, description, author, URL or meaning, with no stop
  words and no transliteration (`г` does not find `Gorod`); one character that
  is neither a letter nor a digit finds nothing; it pages by offset and limit;
  two characters keep the full search; on 10 000 cards it answers within the
  lexical limit (15.11.2026);
- short Cyrillic/mixed-layout queries bypass the semantic provider;
- pagination returns `has_more` correctly in search mode;
- snippets return plain text and valid ranges;
- prefix snippets return only the typed prefix range;
- совпадение `title` считается по имени файла у любой карточки, включая
  социальные; legacy `frontmatter.title` никогда не становится причиной
  совпадения, H1 заметки с другим именем файла находится как `body` со
  сниппетом;
- semantic-only results return no fake highlight ranges;
- stale embedding rows are ignored when their `chunk_hash` no longer matches;
- поиск с опечаткой и поиск по автору и адресу через индексы дают тех же
  кандидатов с теми же совпадениями, что полный проход по фрагментам до
  15.11.2026: тест сравнивает оба пути на наборе карточек, в том числе с
  текстом, где нижний регистр меняет длину знака;
- сверка читает тела только у документов с разошедшейся отметкой; новое
  соединение к индексу с записанными документами не читает ни одного тела;
  запись превью и коллекций номер `source_revision` не меняет;
- документ без отметки с прежним хэшем сохраняет фрагменты и векторы и
  получает слова;
- удаление карточки убирает её фрагменты из `search_word_chunks` и
  `search_metadata_terms`;
- поиск, чья сверка не может писать из-за другого соединения, отвечает по
  документам как они есть и сверяет их, когда индекс свободен;
- новый поиск вкладки останавливает её прежний поиск и не трогает поиск
  другой вкладки; остановленный поиск кончается `search_superseded`;
- строка замера содержит шаги по порядку и не содержит текста запроса;
- тесты скорости на 10 000 карточек с 30 МБ текста утверждают пределы из
  Performance Contract.

Frontend (overlay-specific contract: SPEC_SEARCH_OVERLAY.md → Test Contract):

- `Cmd+F` and the bottom app bar `Search elements` open/close the Search Overlay;
  the Grid is not refetched and its dataset is untouched;
- the top app chrome still renders the Sidebar/Main divider up to the window
  top edge;
- `Shift+Cmd+F` focuses/selects top-chrome sidebar search and does not change Grid;
- stale search responses are ignored;
- article body matches render the highlighted excerpt as the row snippet and in
  the preview card;
- title matches highlight the title without replacing the preview;
- author and URL matches do not replace preview text, do not reveal hidden URL
  text and render no `mark`;
- semantic-only matches show an excerpt without text highlight;
- `Cmd+K` remains scoped to card/Detail menus and never opens search.
