# Surface Search and Hybrid Retrieval

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

## Goal

Search is a scoped filter mode for existing surfaces, not a command palette and
not a separate results route.

- `Cmd+F` toggles App-owned main search state; the visual main search component
  is temporarily hidden.
- `Shift+Cmd+F` focuses search in the left top chrome segment and filters the
  channel list.
- `Cmd+K` remains reserved for scoped card/Detail overflow actions and never
  opens search.

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

### Main/Grid Search (`Cmd+F`)

`Cmd+F` opens or closes the App-owned Grid search state. The visual main search
component is temporarily not rendered; the route-facing search mechanism,
state, shortcuts and backend query path remain in place.
The top chrome is split by the same `--sidebar-width` boundary as the body: the
left segment contains the native traffic-light spacer, the space selector,
sidebar channel search and a `border-r border-sidebar-border`, so the
Sidebar/Main divider continues to the top edge of the window. The right segment
starts with a current collection switcher and leaves the remaining pixels as
drag region until the next visual search surface is introduced. The
bottom app bar also exposes a right-side `Search cards` action with the `⌘F`
shortcut label and the same toggle behavior. This action is a command trigger,
not a selected-state control: it must not remain visually pressed while search
is active.
Opening from either `Cmd+F` or `Search cards` updates App-owned search state but
does not render an input while the visual component is disabled.
The temporary hidden state must not participate in Grid layout, animate over the
content, or change the Grid scroll viewport.
Opening Detail or another full-surface mode disables/hides the top-chrome search
slot. The active route remains unchanged:

- on Everything, search covers all non-channel cards;
- inside a collection, search covers only cards connected to that collection;
- clearing the query restores the normal route snapshot and normal ordering.

When Grid group selection starts, empty main search state becomes inactive. If
the query is non-empty, the filtered result set remains active, but keyboard
ownership moves to Grid selection so the next `Escape` clears selection first.

When `query` is non-empty, Grid ordering is relevance-first. Normal route order
is still `saved_at DESC`.

Grid search state is App-owned:

```ts
interface MainSearchState {
  open: boolean;
  query: string;
  sequence: number;
}
```

Grid receives `searchQuery` and `searchActive` as rendering context. Grid does
not own IPC and does not run local filtering over stale blocks.

### Sidebar Search (`Shift+Cmd+F`)

Sidebar search is a permanent top-chrome control inside the left
`--sidebar-width` segment. The visual order is: native traffic-light spacer,
one vertical `bg-border` separator, the `VaultSwitcher`/space selector, a
second vertical `bg-border` separator, a no-icon `Input ghost` search field
with the design-system `h-8 px-3` geometry, then the existing
`border-r border-sidebar-border` Sidebar/Main divider. Collapsed sidebar does
not collapse the top chrome safety zone to zero and does not reserve an empty
search slot: the left segment uses CSS intrinsic sizing (`w-auto`) with an
`80px` traffic-light reserve, a `1px` separator and a `VaultSwitcher` capped at
`159px`, so the whole collapsed segment cannot exceed `240px`. It hides only
the channel search input and lets the right collection switcher start
immediately after that compact collapsed segment. There is no JS measurement or
hidden probe in this path; short folder names must never be truncated by the
collapsed container.

The space selector shows the current folder name, truncates before the search
field, and opens the existing known-vault dropdown. It uses the same switch
path as the previous bottom-bar vault switcher; `Cmd+Shift+O` still opens the
native folder picker.
The selector width follows the current folder name but is capped at 50% of the
remaining left chrome width (`max-w-[50%]`). Folder names use end ellipsis.
The root trigger stays transparent; hover/open/focus state is drawn only by the
inner pill around the name (`h-6 rounded-1 px-2 bg-active`), with focus fill
restricted to keyboard focus. Top-chrome triggers do not show dropdown
chevrons.
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
`Clear channel search` button (`X`, `h-6 w-6 rounded-1`) on the right. Clear
restores the full channel list and returns focus to the input.

`Shift+Cmd+F` focuses/selects that top-chrome input. It filters only sidebar
channel rows and does not change the route or Grid dataset.
`Everything` is part of the filtered row set: it remains visible only when the
query is empty or matches `Everything` / `__all__`.
`Escape` clears a non-empty sidebar search value; with an empty value it blurs
the input.

### Collection Switcher Search

The right top chrome collection switcher is route navigation, not a second
Grid search scope. Its trigger displays the current route collection
(`Everything` or the active channel). Its dropdown contains a small search
field that filters only destination collections using the same
case-insensitive exact/prefix/substring/fuzzy channel matcher as Sidebar
search and the same Sidebar ordering before ranking. The trigger keeps the
right-side top-chrome spacing in expanded mode: transparent root `px-6` plus an
inner `px-2` hover/open pill, placing text on a `32px` content axis from the
segment edge. In compact/collapsed sidebar mode that wide right-side inset is
removed: the collection trigger switches to `px-3`, matching the space selector
root padding so the current collection starts immediately after the compact
space segment without an extra 32px gap.

The current collection is excluded from the dropdown result set entirely. It is
not duplicated as a disabled row, not marked with a check/radio icon and not
styled as selected. Choosing any visible item immediately navigates to that
collection route and closes the menu.

The collection switcher dropdown has a pinned bottom create action. Empty query
shows disabled `Create New Channel`; a non-empty query without an exact
existing channel match enables `Create "{query}"`. Creation uses the normal
channel create command, refreshes App snapshots and navigates to the created
channel. Space switcher dropdown follows the same no-current/no-check/no-icon
menu language and lists only destination spaces plus a plain `Add space`
action.

Sidebar search is client-side because taxonomy/channel rows are already a small
App-owned read model. Matching is centralized in `src/lib/channelSearch.ts`:
case-insensitive exact/prefix/word-prefix/substring ranking first, then bounded
Damerau-Levenshtein typo tolerance for queries of at least 3 characters. Ties
keep the current channel order, so the sidebar remains deterministic.

## Keyboard Contract

| Shortcut | Scope | Behavior |
|---|---|---|
| `Cmd+F` | Main/Grid | Toggle App-owned main search state; visual input is temporarily hidden |
| `Shift+Cmd+F` | Sidebar | Focus/select the top-chrome channel search input |
| `Escape` in sidebar search input | Sidebar | Clear the query; if empty, blur the input |
| Arrow keys after focus returns to Grid | Main/Grid | Use existing Grid keyboard navigation over filtered `layout.positions` |
| Group selection starts while main search is active | Main/Grid | Deactivate empty search, preserve non-empty query/filter |

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

Main search is implemented by extending the existing route-facing Grid read
command, not by restoring the removed global `search()` frontend surface.

```ts
interface ListGridBlocksParams {
  currentTag?: string;
  offset: number;
  limit: number;
  query?: string;
}

interface GridSnapshot {
  blocks: LightBlock[];
  total_blocks: number;
  has_more: boolean;
}
```

If `query` is empty, `list_grid_blocks` keeps the current SQL path:

- filter out channel documents;
- optional `block_tags` filter for `currentTag`;
- `ORDER BY saved_at DESC`;
- `LIMIT limit + 1 OFFSET offset`.

If `query` is non-empty, `list_grid_blocks` switches to the backend
`SearchEngine` path:

- sync normalized derived `search_chunks` for changed indexed blocks;
- run lexical FTS5 over `blocks_fts`;
- run alias/transliteration-expanded FTS5 groups;
- run typo-tolerant fuzzy matching over `search_chunks`;
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

The lexical layer still uses SQLite FTS5. The route-facing backend is a local
`SearchEngine` layer with four sources of evidence:

| Layer | Purpose | Required behavior |
|---|---|---|
| Lexical index | Exact, prefix and phrase-like matches | Fast route-filtered matching over title/description/body with stable snippets |
| Alias index | Human aliases, transliteration, localized names | `майн`/`mine`, `память`/`memory`, domain/source aliases and curated synonym sets |
| Semantic vector index | Cross-language and meaning-based recall | Russian query can retrieve English content by meaning without literal overlap |
| Fusion/rerank | Combine evidence into one ordered Grid | Exact lexical trust is preserved while semantic recall improves discovery |

The frontend continues to call one route-facing search command. It must not know
whether a result came from FTS5, Tantivy, aliases or vector search except through
explicit match metadata.

Implemented behavior:

- `list_grid_blocks(..., query)` delegates non-empty queries to the backend
  `SearchEngine` boundary;
- lexical retrieval still uses SQLite FTS5 with prefix terms;
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
  multi-token semantic queries where literal matching alone is insufficient;
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
- invalid punctuation must not throw user-visible SQL/FTS errors.

Hybrid query normalization additionally produces:

- `literal_terms`: original lexical tokens;
- `normalized_terms`: lowercase/diacritic-normalized terms;
- `alias_terms`: curated aliases, transliterations and localized labels;
- `semantic_query`: the full user query for embedding;
- `language_hint`: best-effort language/script classification for ranking and
  diagnostics, never a hard filter.

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

`title` is considered only when the Grid card actually renders a title. Social
cards (X/Twitter/Instagram layouts) render media plus preview/body text and do
not expose `title` on the card surface, so their match metadata must prefer
`description`/`body` over title/fallback-label matches.

For `title`, `excerpt` is the rendered title text. For `description`, `excerpt`
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

- `mainSearchOpen`;
- `mainSearchQuery`;
- `sidebarSearchQuery`;
- `sidebarSearchFocusSequence`;
- per-route normal snapshot cache;
- per-route+query search request sequence.

Main search reloads Grid through the same request pipeline as route changes.
The cache key includes both route and query:

```ts
routeKey = currentTag ?? "__all__";
searchKey = `${routeKey}::${normalizedQuery}`;
```

Search results are never applied if:

- the vault path changed;
- the route changed;
- the query changed after request start;
- a newer request sequence completed first.

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
| `search_embeddings` | embedding vectors with model metadata | `search_chunks` + embedding model |

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

Entering main search mode clears active group selection. Selection over a
dataset that is about to be filtered is ambiguous and can hide selected cards.
Entering group selection deactivates empty main search state so `Escape`
belongs to selection. Non-empty query remains active as the selected filtered
result set.

Grid keyboard focus is pruned to visible filtered results:

- if the focused slug remains in the filtered result set, preserve it;
- otherwise first arrow/Enter interaction starts from the first visible
  committed result in the current viewport.

Opening Detail from a filtered result is normal card open behavior. Closing
Detail restores focus by slug if the slug is still present in the filtered
result set.

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
- pagination returns `has_more` correctly in search mode;
- snippets return plain text and valid ranges;
- prefix snippets return only the typed prefix range;
- social-card metadata targets the rendered preview/body surface, not hidden title metadata;
- semantic-only results return no fake highlight ranges;
- stale embedding rows are ignored when their `chunk_hash` no longer matches.

Frontend:

- `Cmd+F` toggles App-owned main search state; route filtering remains wired
  through the same `searchQuery` mechanism;
- bottom app bar `Search cards` with `⌘F` toggles the same main search state;
- the visual main search component is temporarily absent; the top app chrome
  still renders the Sidebar/Main divider up to the window top edge;
- repeat `Cmd+F` and bottom app bar toggle clear/close search state without
  animating or shifting the Grid surface;
- starting Grid group selection clears empty active search state, while a
  non-empty query/filter remains active;
- `Shift+Cmd+F` focuses/selects top-chrome sidebar search and does not change Grid;
- stale search responses are ignored;
- clearing query restores normal route order;
- article body matches replace preview with highlighted excerpt;
- title matches highlight title without replacing the preview;
- author and URL matches do not replace preview text, do not reveal hidden URL
  text and render no `mark`;
- semantic-only matches show an excerpt without text highlight;
- selection clears on entering main search;
- `Cmd+K` remains scoped to card/Detail menus and never opens search.
