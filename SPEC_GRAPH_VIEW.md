# SPEC: Graph View

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_DISPLAY_MODES.md](SPEC_DISPLAY_MODES.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

## Status

M1 implemented on 10.07.2026; the final minimal product surface and shared
Settings contract were verified on 25.07.2026. The technical solution is
extracted from the Graph View implementation in
`/Users/i_iii/Проекты/longevity-landscape` and adapted to Mine's
Obsidian-first data model.

The verified boundary includes:

- card and collection nodes;
- collection-membership, wikilink and related-note edges with provenance,
  direction, dedupe and duplicate counts;
- automatic `current_route` / `library` scope derived from the active route,
  plus explicit large-library materialization;
- Canvas rendering with screen-fixed thumbnails, collision-safe collection
  labels, stable hover/click/context-menu/drag contracts and resize-safe layout;
- persisted edge visibility in the common Settings window, selected-node
  synchronization, conditional centering, keyboard navigation and an
  `aria-live` status model;
- с 11.10.2026 панель графа на кнопке `Display` и в окне настроек включает и
  выключает только дополнительные связи между карточками (`Wikilinks`,
  `Related notes`), коллекции показываются всегда (раздел «Панель графа»);
- Rust/unit coverage and dark/light real-browser Canvas pixel, hover, resize,
  request-bound and interaction-performance acceptance.

Longevity remains architectural prior art. Mine's visual sizing, palette, label
thresholds, and physics constants are intentionally Mine-owned manual tuning
knobs, not a verbatim copy of Longevity's graph.

## Source Study

Longevity Landscape implements a production-ready force-directed knowledge graph
with the following files and decisions:

| Source | Extracted decision |
|---|---|
| `src/lib/actors.ts` | Build a graph-specific read model: typed `GraphNode`, `GraphLink`, `GraphData`, event-direction rules, dedupe keys, explicit missing nodes, and synthetic approach nodes. |
| `src/components/graph/graph-config.ts` | Keep Canvas colors in one config file because Canvas cannot read CSS variables; scale physics with `sqrt(nodeCount / 50)`; expose node sizing and label thresholds as pure functions. |
| `src/components/graph/actor-graph.tsx` | Use `react-force-graph-2d` over Canvas, `ResizeObserver`, custom `nodeCanvasObject`, `nodePointerAreaPaint` for non-circular nodes, 1-hop hover highlighting, selected state, search dimming, image cache, and imperative `centerOnNode`. |
| `src/components/graph/graph-with-filters.tsx` | Keep graph controls outside Canvas: search, toggle filters, Detail Panel integration, selected-node sync. |
| `src/components/graph/force-edge-repel.ts` + DEVLOG | The custom O(n^2) edge-repulsion force was kept as an experiment; the shipped approach is proportional many-body charge plus `forceCollide`, because it scales better. |
| `docs/ARCHITECTURE.md` | Chosen library: `react-force-graph-2d`. Rejected `@xyflow/react`, Sigma.js + Graphology, Reagraph, and handwritten D3-force + Canvas. |
| `docs/DEVLOG.md` | Critical lessons: no `key` remount around canvas; `overflow-hidden` on graph container; center only when Detail covers the node; no hover card on graph; labels/1-hop highlight are enough. |

This spec treats those decisions as prior art. Mine does not copy the domain
model of actors/events or the exact visual tuning. It uses the same broad
architecture and interaction lessons, while Mine's graph geometry and physics
are tuned manually in this project.

## Goal

Graph View gives a spatial map of a local Mine vault:

- collection membership as first-class structure;
- block-to-block wikilinks and related-note provenance;
- current route context, so a user can inspect the neighborhood of the
  collection they are already viewing;
- direct navigation into the existing Detail panel without opening a separate
  route or modal.

Graph View is a discovery and orientation surface, not a replacement for Grid,
Search Overlay, or Sidebar.

## Non-Goals

- No source Markdown rewrite. Graph data is derived from SQLite and can be
  rebuilt from files.
- No hidden UUIDs in frontmatter.
- No Electron/WebGL-only renderer.
- No graph editor in v1: nodes are navigable, not manually placed or connected.
- No full card wall by default. Card nodes use small square derived thumbnails;
  full card rendering remains owned by Grid and Detail.
- No semantic layout persistence in source files. User-authored content remains
  independent of visual coordinates.

## Product Model

Graph View is a special display surface for the main area. It participates in
the same app shell, Sidebar, top chrome, search affordances, and Detail panel as
the feed.

Unlike regular display modes in [SPEC_DISPLAY_MODES.md](SPEC_DISPLAY_MODES.md),
Graph View cannot be "render-only" over `LightBlock[]`: it needs edges from
`block_tags`, `wikilinks`, and `related_notes`. Therefore it has its own
route-facing read model:

```text
current route + persisted graph preferences
      |
      v
list_graph_snapshot(scope, options)
      |
      v
GraphView canvas + existing Detail
```

This is the same architectural pattern as `list_grid_blocks`: frontend asks for
one purpose-built snapshot, backend owns filtering, dedupe, and payload shape.

## Node Types

```typescript
type GraphNodeKind = "card" | "collection";

interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  slug: string | null;
  collection_ref: string | null;
  card_kind: "article" | "media" | "channel" | null;
  block_type: "image" | "article" | "link" | "video" | "file" | "channel" | null;
  thumbnail: string | null;
  preview_manifest: string | null;
  degree: number;
}
```

### Card Nodes

`kind = "card"` represents non-channel blocks (`card_kind != 'channel'`).
Card nodes render as small square thumbnails using the same derived
thumbnail source as sidebar micro-previews.

Identity:

```text
card:<slug>
```

Label priority follows [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md):

1. `display_title`
2. `fallback_label`
3. `slug`

### Collection Nodes

`kind = "collection"` represents collection pages (`type: channel`) and rows in
`channels`. Collection identity is the Obsidian `CollectionRef`, not a normalized
tag.

Identity:

```text
collection:<CollectionRef>
```

Collection nodes render as text pill nodes. They are always label-visible
because a collection node without text is not meaningful.

Graph View materializes only real objects. A plain note link whose target does
not resolve to an indexed card or collection is omitted together with its edge.
Missing targets are neither graph nodes nor a Graph filter.

Узел коллекции строится только из строки `channels`, то есть из страницы
коллекции. Значение `Mine Collections`, цель которого не совпадает ни с одной
страницей, не даёт ни узла, ни ребра членства (решение пользователя
10.10.2026, [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md),
К1, К2 и К9). `build_graph_snapshot` в
[graph.rs](src-tauri/src/storage/graph.rs) берёт членство через общее условие
индекса (`collection_membership_join_sql`); до 10.10.2026 он создавал узел и
по ссылке карточки (реализовано 10.10.2026, PLAN.md, Phase 44).

## Edge Types

```typescript
type GraphEdgeKind = "collection_membership" | "wikilink" | "related_note";

interface GraphLink {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  directed: boolean;
  count: number;
  target_ref: string | null;
}
```

### Collection Edges

Source data:

- `block_tags.tag` where semantic value is `CollectionRef`;
- `channels.tag` for collection metadata.

Ребро членства есть, только если у `block_tags.tag` есть пара в
`channels.tag` (членство по К9 в
[SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)).

Graph edge:

```text
collection:<CollectionRef> -> card:<slug>
```

`directed = false` for interaction. The source/target order is stable for
dedupe and rendering, but the visual meaning is membership.

### Wikilink Edges

Source data:

- `wikilinks.source_id`;
- `wikilinks.target_slug`.

Graph edge:

```text
card:<source_slug> -> card:<target_slug>
```

`directed = true`, because body wikilinks have a source note and a target note.
Only plain note links `[[note]]` are present in the `wikilinks` read model.
Media embeds `![[file]]` belong to the media pipeline and never become Graph
edges. If a note target does not resolve to a real card or collection, the edge
is omitted.

### Related-Note Edges

Source data:

- `blocks.related_notes`, including Obsidian block-reference fragments like
  `[[Source#^block-id]]`.

Graph edge:

```text
card:<source_slug> -> card:<base_related_note_slug>
```

`directed = true`. Related-note edges are provenance/source context, not
collection membership.

### Dedupe Rules

Deduplication key:

```text
<kind>|<source>|<target>
```

If duplicate edges are discovered, increment `count` instead of adding parallel
links. `count > 1` may affect hover tooltip or link opacity later, but v1 keeps
link width stable to avoid visual jumping.

## Graph Snapshot

```typescript
type GraphScopeKind = "current_route" | "library";

interface GraphScope {
  kind: GraphScopeKind;
  collection_ref: string | null;
}

interface GraphOptions {
  // No include_collections since 11.10.2026: collections are always built
  // («Панель графа», ГП5).
  include_wikilinks: boolean;
  include_related_notes: boolean;
  materialize_large_library: boolean;
}

interface GraphSnapshot {
  nodes: GraphNode[];
  links: GraphLink[];
  total_cards: number;
  total_collections: number;
  current_collection: string | null;
  truncated: boolean;
  truncation_reason: "large_library" | null;
  can_materialize_full: boolean;
  visible_nodes: number;
  visible_links: number;
  total_nodes: number;
  total_links: number;
}
```

The frontend derives `GraphScope` from the active route rather than exposing a
scope selector: collection routes use `current_route`; Everything uses
`library`. The backend owns scope, dedupe, real-target resolution and exact
visible/total counters.

### Scope Semantics

`current_route`:

- on a collection route: collection node, member blocks, their 1-hop wikilink
  and related-note neighbors, plus neighbor collections for those blocks.

`library`:

- used by Everything;
- for small vaults, full card + collection graph;
- for large vaults, collection-level graph first; `Show all` is the only
  explicit full-materialization action when the backend marks it safe.

### Large Vault Policy

> **Открытый вопрос, 21.08.2026.** Пороги ниже внесены коммитом `f101a86` от
> 25.07.2026 и владельцем продукта не согласовывались: он не видел ни одного из
> состояний, которые они порождают, и не знает, где находится `Show all`.
> Состояния существуют в продукте: кнопка живёт в самом графе и появляется
> только при обрезанном снимке, то есть свыше пяти тысяч узлов — на хранилище в
> 572 карточки её невозможно увидеть.
>
> Пороги подлежат пересмотру вместе с уровнями миниатюр: `micro` снимает
> ограничение по памяти, ради которого они, судя по всему, и вводились. До
> пересмотра числа ниже описывают действующий код, а не согласованное решение.

Mine targets 10,000+ blocks. A full 10,000-node force simulation is not the
default first paint.

Thresholds:

| Node count | Policy |
|---|---|
| `<= 1000` | Full graph allowed. Labels are progressive. |
| `1001..5000` | Full graph allowed only after explicit `Show all`; no thumbnails; finite cooldown; labels only on zoom/hover/selection. |
| `> 5000` | Library scope stays collection-level. Snapshot sets `truncated = true` with a reason and does not offer full materialization. |

Counters in the UI must distinguish exact snapshot counts from truncated
library counts:

- `visible_nodes` and `visible_links` are exact for the returned snapshot;
- `total_nodes` and `total_links` describe the pre-truncation graph when cheap to
  compute from SQL;
- never show `5000+` when exact `visible_nodes` is known.

## Backend Contract

### New Module

```text
src-tauri/src/storage/graph.rs
src-tauri/src/commands/graph.rs
```

`storage::graph` owns SQL projection and dedupe. `commands::graph` is a thin IPC
layer, matching the existing command boundary.

```rust
pub fn graph_snapshot(
    conn: &Connection,
    scope: &GraphScope,
    options: &GraphOptions,
) -> Result<GraphSnapshot>;
```

### Data Access Rules

- Use SQLite read model only; do not read Markdown files in the IPC hot path.
- Exclude `card_kind = 'channel'` from block nodes.
- Resolve collection identity through `CollectionRef` values in `block_tags`.
- Resolve wikilink targets through the same normalization rules used by the
  indexer.
- `wikilinks` contains only plain note links. Inline media embeds are indexed by
  the media pipeline and must not enter Graph projection.
- Omit a wikilink or related-note edge when its target does not resolve to a
  materialized card or collection.
- Strip `#^block-id` fragments for related-note node identity while preserving
  the full source target in `target_ref`.
- Open the database read-only unless a future graph maintenance pass needs a
  derived table.

### Suggested SQL Shape

Block nodes:

```sql
SELECT id, slug, card_kind, block_type, display_title,
       COALESCE(fallback_label, slug), thumbnail, saved_at
FROM blocks
WHERE card_kind != 'channel'
```

Collection edges:

```sql
SELECT b.slug, bt.tag
FROM block_tags bt
JOIN blocks b ON b.id = bt.block_id
JOIN channels c ON c.tag = bt.tag
WHERE b.card_kind != 'channel'
```

Wikilink edges:

```sql
SELECT source.slug AS source_slug, w.target_slug
FROM wikilinks w
JOIN blocks source ON source.id = w.source_id
WHERE source.card_kind != 'channel'
```

The implementation should adapt these to the existing normalized wikilink
helpers in `storage/index.rs`; the spec requires behavior, not this exact SQL.

## Frontend Contract

### Dependencies

Target dependencies for the Canvas/d3-force renderer:

```json
{
  "react-force-graph-2d": "^1.29.1",
  "d3-force": "^3.0.0",
  "@types/d3-force": "^3.0.10"
}
```

These dependencies are part of the M1 implementation.

### Components

```text
src/components/GraphView.tsx
src/components/GraphDisplayMenu.tsx
src/lib/graphPreferences.ts
src/lib/commands.ts
src-tauri/src/commands/graph.rs
src-tauri/src/storage/graph.rs
```

`GraphView` owns one coherent snapshot state for Canvas rendering, physics,
image cache, sidebar-style hover preview, shared card menu invocation,
collection navigation, route-derived scope, empty/truncated states, Detail
integration and selected-node sync. Persisted edge visibility is passed from the
main settings owner. There is no second `GraphWithControls` owner and no DOM
node layer over Canvas.

### Renderer

Use `react-force-graph-2d` with custom Canvas drawing:

- `nodeCanvasObject` draws all nodes.
- `nodePointerAreaPaint` defines hit areas for pill collection nodes and any
  non-circular shapes.
- `nodeLabel={() => ""}` disables browser tooltips; graph uses labels on canvas
  instead.
- `linkWidth` remains stable (`1`) to avoid hover-induced layout noise.
- Наведение на карточку не меняет цвет линий. Наведение на коллекцию
  приглушает линии вне её части графа: цвет остаётся `--border`, меняется
  только непрозрачность (раздел «Приглушение при наведении на коллекцию»,
  решение пользователя 16.10.2026; заменяет прежнее «hover must not recolor
  or dim the graph»).
- `collection_membership` uses a straight solid line: it is the structural
  collection skeleton.
- `wikilink` and `related_note` use stable curved dashed lines: they are
  semantic references between real objects. Wikilinks use curvature `0.14`;
  related notes use `0.20` so parallel relation kinds remain distinguishable.
  The curvature side is derived deterministically from the unordered endpoint
  pair, so reciprocal links occupy opposite visual lanes without changing
  after reload.
- Reference dashes use a `4px / 4px` screen-space pattern. Dash units are
  divided by the current graph scale so zoom never stretches or compresses the
  visible rhythm.
- `linkDirectionalArrowLength` is zero for undirected collection membership and
  non-zero for directed wikilink/related-note edges.

Curvature and dashing are renderer-only. They do not change d3 link distance,
charge, collision, adjacency or snapshot identity.

The graph container must be:

```tsx
<div className="relative flex-1 min-h-0 overflow-hidden" />
```

`overflow-hidden` is required. Longevity showed that `overflow-visible` lets the
canvas escape the resizable panel, breaks `ResizeObserver` dimensions, and makes
`centerAt` use stale viewport size.

### Canvas Palette And Labels

Graph View uses one renderer, one hit-testing layer and one d3-force simulation:
card thumbnails, collection labels, pointer hit areas, hover and drag all live in
the same Canvas/graph coordinate space. Collection labels must not be rendered as
a DOM overlay above the canvas; that creates a second clock and causes visible
parallax during pan/zoom.

The force graph mounts only after `ResizeObserver` reports the real main-surface
viewport. It must not render or run `zoomToFit` against a fallback `800x600`
canvas and then resize into the app shell; that produces the cold-open state
where the graph is fitted into the wrong rectangle and appears clipped into a
corner.

Initial fit is delayed until the measured graph has completed 18 engine ticks,
then runs once with a 250 ms transition. A later container resize updates Canvas
dimensions only: it must not recreate forces, reheat the simulation or refit the
camera.

### Размер узла

**Статус: эксперимент от 22.08.2026.** Предыдущая модель — размер от масштаба и
плотности раскладки — заменена; при неудаче откат одним коммитом.

**Карточка имеет размер в координатах графа** (`CARD_GRAPH_SIZE`), ровно как
связь имеет длину, и камера масштабирует обе. Отношение карточки к промежутку
между узлами постоянно **по построению**, а не поддерживается формулой.

Ничего не измеряется и не сглаживается: экранный размер есть размер в графе,
умноженный на масштаб. Жест отображается на размер точно, потому что между ними
нет ничего.

**История трёх предыдущих моделей** — они все вычисляли экранный размер из
свойств графа:

| Модель | Что сломалось |
|---|---|
| `32 × масштаб` | расстояния множатся тем же масштабом, доля экрана под картинками не менялась |
| от числа узлов в кадре | вход дискретный; сглаживание ступеней стало запаздыванием за трекпадом |
| от плотности раскладки | плотность отвечает «как тесно стоят», а нужен ответ «сколько на экране»: в библиотеке из 572 узлов карточки выходили крупнее, чем в коллекции из шести |

Вся машинерия вокруг третьей — измерение, сглаживание, порог смены, отмена
измерения, признак «уже измерено» — удалена: 371 строка против 60 добавленных.
Все дефекты трёх дней жили в ней.

**Верхний предел масштаба следует из карточки и из уровня миниатюры.** Потолок
размера — 100 логических пикселей, то есть 200 физических на удвоенной
плотности, ровно под уровень `zoom` в 256 px. Больший потолок не показывает
больше — он растягивает ту же картинку. **Отдаление намеренно не ограничено.**

Ниже масштаба `GRAPH_NODE_MIN_PX / CARD_GRAPH_SIZE` карточка перестаёт
уменьшаться, а расстояния вокруг продолжают, поэтому карточки начинают
накладываться. Это принятый размен: увидеть библиотеку целиком важнее, чем
сохранить разреженность на дальнем конце. Обратный выбор — ограничить отдаление
— означал бы, что большой граф можно только панорамировать, и он отвергнут.

Точка, где размен вступает в силу, названа явно (`overlapBeginsAtZoom`), чтобы
её можно было проверять и обсуждать, а не обнаруживать.

### Курсор

Граф подчиняется общей политике курсора (DESIGN_SYSTEM.md, «Курсор»), а не
конвенции своей библиотеки. Та помечает узлы классами `.clickable` и
`.grabbable`, давая указывающую руку при наведении и раскрытую ладонь до начала
перетаскивания; оба сняты в `global.css`.

Закрытая рука остаётся у обеих разновидностей перетаскивания: узла — по классу
библиотеки, вида — по атрибуту `data-graph-panning`, который ставится при
движении с зажатой кнопкой. Именно при движении: пометка по нажатию давала бы
вспышку курсора на каждом клике по карточке.

### Силы и перетаскивание

**Перетаскивание оживляет симуляцию только если та остановилась.**
`d3ReheatSimulation` ставит `alpha(1)` — тот же удар энергии, что и при первой
раскладке. Пока движок работает, библиотека уже держит нужный уровень
(`alphaTarget(0.3)` на старте перетаскивания, снятие в конце), и удар поверх
него — то, отчего раскладка металась, как в трёхмерном редакторе. Состояние
движка отслеживается по его собственным событиям такта и остановки.

**Под рукой симуляция вязче.** `DRAG_VELOCITY_DECAY` = 0,7 против рабочих 0,36:
узел сохраняет 30 процентов скорости за такт вместо 64, поэтому не проскакивает
мимо равновесия и не качается вокруг него. Выше поднимать нельзя — соседи
перестанут следовать за карточкой, и вернутся растянутые связи, ради которых
оживление вообще нужно.

**Изолированная карточка отталкивает слабее связанной**
(`UNLINKED_CHARGE_RATIO`). Карточку, привязанную к коллекции, притягивает
связь — этим и держатся плотные грозди. У карточки без связей притяжения нет
вовсе, только отталкивание и очень слабый центр, поэтому при равной силе она
уходила далеко, и свободная часть библиотеки читалась как пустая. Слипнуться
таким карточкам не даёт та же коллизия, что работает внутри грозди.

Отвергнуто как средство уплотнения: усиление центральной силы — оно действует
на все узлы и стянуло бы грозди внутрь; уменьшение радиуса отталкивания — оно
задело бы и связанные карточки.

### Углы и подсветка карточки

**Углы скругляются вместе с ростом карточки.** Радиус отсчитывается от нижней
границы размера, а не от нуля: карточка в 32 пикселя имеет строго прямые углы.
Доля от размера дала бы там полтора пикселя — на экране удвоенной плотности это
три физических, и выглядит как размытый край, а не как скругление.

Дальше радиус растёт непрерывно — `GRAPH_CARD_RADIUS_RATIO` на каждый пиксель
роста, и упирается в `--radius-1` = 3 px, радиус, который дизайн-система даёт
интерфейсу и скруглённым карточкам: 0 при 32, 1,35 при 50, 2,9 при 70, 3 при
потолке. Брать `--radius-2`
(5 px) нельзя: он принадлежит другим компонентам, и с ним полностью
приближённая карточка выглядит скруглённее любой карточки в остальном
интерфейсе.

Ни появления, ни исчезновения скачком нет ни в одной точке диапазона — это
проверяется тестом, который проходит весь диапазон по пикселю и требует, чтобы
наибольший шаг оставался малым.

**Карточка получает обводку по наведению** — ту же, что пилюли коллекций:
`hoverOutline` толщиной в один пиксель по тому же скруглённому контуру. Ховер и
выбор дают одну подсветку; своей толщины у выбора нет.

### Rearranging Around An Opened Collection

A snapshot moves the camera **once**, and the two moves are exclusive:

- a collection route glides to that collection's node with `centerAt(x, y, 400)`
  and sets the scale over the same 400 ms;
- `library` fits, on the 18-tick cycle above.

Which of the two runs is decided by the **route**, never by whether the snapshot
has arrived. Keying it on the node meant that during a load the plan was briefly
a fit, and the fit spent the tick budget before the collection's own move could
run.

Zoom is recomputed on every navigation and never inherited from the previous
screen — an inherited scale leaves one collection cramped and the next one lost
in empty space. The extent is read after the layout has taken shape, not on the
first tick, where every entrant still sits on the focus and the measured extent
would be a fraction of the real one; the scale then leaves room for the spread
still to come.

Running both on one navigation is the defect this rule exists to prevent. It was
measured on the audit route: the drawn content's width changed by 390, 264 and
216 px inside single 100 ms frames while the glide was still running, which
reads as the graph flying apart rather than settling.

Node positions carry across snapshots. d3 stores a node's position on the node
object, and every snapshot hands the Canvas fresh objects, so without a carried
map opening a collection restarts the entire layout from nothing — the graph is
replaced rather than rearranged. Positions are recorded on every engine tick and
reapplied by id.

The opened collection is pinned with `fx`/`fy` **at the position it already
holds**. A pin at any invented point — the origin, the viewport centre —
teleports the pill on click. When no position is remembered yet the node is left
free and the next snapshot pins it.

The centring force is aimed at the pinned collection, never at the origin. The
force pulls the graph's centre of mass toward a point; with the anchor somewhere
else that pull can never be satisfied, so every tick shifts all the free nodes
toward the point while the pinned one snaps back, and the mismatch repeats. The
result is a steady drift that carries a collection's cards off screen and
stretches its links — measured at 140 px of drift over four seconds against 18
px once the force follows the anchor.

Nodes the previous snapshot did not contain enter on a phyllotaxis spiral around
the focus: one golden-angle step per entrant. Sharing a point would explode the
repulsion between them, and a random scatter would lay the same click out
differently twice.

Decay and stop must agree. The simulation has to come to rest **on its own**,
with the cooldown timer acting as a backstop for a slow machine and never as the
reason the graph stops. At `alphaDecay: 0.02` against a 3.5 s timer it did the
opposite: rest needed 5.7 s, so every rearrangement was cut off with the motion
still 14 times above d3's resting threshold — read as the graph freezing
mid-stride, and only on the collections large enough not to settle in time.
`alphaDecay: 0.045` comes to rest in about 2.5 s, inside a timer of 8 s.

`warmupTicks` applies only before anything has been drawn. Once positions are
remembered the ticks run at 0, because a warmup runs the whole rearrangement
invisibly and the user sees a substituted picture instead of a graph moving.

Canvas-native collection labels follow the contract in DESIGN_SYSTEM.md,
«Подпись коллекции на графе». Runtime canvas paint resolves these tokens:
`border-border`, `bg-chrome`, `text-muted-foreground`, `rounded-pill`, `h-7`,
`px-3`, `font-sans`, `text-base`, `font-normal`, hover text
`text-foreground`, hover outline `outline-component-fill-hover`. The DOM
reference `GraphCollectionLabel` (Badge variant `graphLabel`) was shown only in
the design-system showcase and was removed with it on 07.10.2026 (user's
decision); the canvas paint never depended on it.

Rules:

- avoid category rainbow as the default visual language;
- use muted fills and ring/border strokes;
- hovered card nodes add the one-CSS-pixel `hoverOutline` on the existing
  rounded contour; opacity, label visibility, size and link styling stay fixed;
- hovered collection labels keep the same shape and fill but switch text to
  `text-foreground` and the outline to `--component-fill-hover`;
- the opened collection, the keyboard-selected one and the hovered one share
  that single highlight — same colour, same one-pixel weight. A heavier outline
  for the opened pill is a third look the interface does not have, and the
  highlight must not be the only sign a collection is open: the camera holds it
  and the graph settles around it;
- collection labels use a graph-space rectangular collision d3-force sized from
  screen-space typography (`h-7`, measured label width, `2px` gap divided by
  current zoom). It must resolve overlap inside the same simulation as the graph,
  so channel pills do not pass through each other or lag behind card nodes during
  pan/zoom;
- continuous zoom is camera-only: `onZoom` may update the current scale ref used
  by paint/hit/collision math, but it must not call `d3ReheatSimulation()` or add
  velocity to the graph. This keeps zoom from turning into a layout event;
- collection label text is painted in screen-space inside the canvas transform
  (`ctx.scale(1 / globalScale)` + normal `14px` font), not as a tiny
  `14 / globalScale` canvas font. This prevents text rasterization from
  disappearing at high zoom;
- collection nodes render after card nodes, so card thumbnails cannot cover the
  capsule text while the simulation is moving;
- collection label pointer interaction uses native ForceGraph node hit areas:
  click navigates to the collection, drag moves the collection node on canvas and
  suppresses the release click;
- search highlights use the same semantic color family as search marks where
  possible, but not the yellow text highlight itself on nodes.

### Node Shapes

| Kind | Shape | Label |
|---|---|---|
| `collection` | canvas-native capsule (DESIGN_SYSTEM.md, «Подпись коллекции на графе») | always visible |
| `card` | sidebar micro thumbnail: screen-fixed square `32 / globalScale`, no rounding, no stroke | search match or keyboard/pointer selection |

Card thumbnails use cover crop, clipped into the square. Collection hit areas
must match the capsule bounds closely enough that click/drag begin on the
visible pill, not on a hidden circle.

### Labels

Labels:

- collection labels: always visible as canvas-native capsules;
- card labels: none. A card node is never captioned. The rule used to name two
  cases and both were wrong: there are no search matches to label, because Graph
  View has no graph-local search, and the selected node already carries a
  selection outline — a caption said the same thing a second time. It was also
  unreadable: `fillText` with a `maxWidth` does not truncate, it compresses, so
  a card named after a page title was squeezed into 180 px of micro-type. A
  card's title and text belong to the hover preview, which has room for them;
- no graph-local label backgrounds, custom rgba fills, custom radii, custom
  typography or custom paddings outside the design-system label contract;
- collection labels preserve at least `2px` visual gap through the canvas/d3
  rectangular collision force.

### Image Use

M1 draws ready derived Mine thumbnails for materialized card nodes by default.
Explicit full materialization for a `1001..5000` card library suppresses
thumbnails to keep decode/request work bounded.

Allowed:

- cache and draw only derived thumbnails from the thumbnail store;
- use cover crop, clipped to the small square node shape;
- tint text-preview thumbnails with `--foreground` on a `--chrome` fill, the
  glyphs taken from the thumbnail's alpha, so article/text previews read as
  the interface's text in both themes (09.10.2026; until then the baked grey
  was inverted in the dark theme and read as a muted step). DESIGN_SYSTEM.md,
  «Карточка на графе».

Not allowed:

- decode original media files for graph nodes;
- use full card rendering inside graph nodes.

## Physics

Use Mine-owned manual physics constants, scaled by graph size:

```typescript
function graphPhysics(nodeCount: number) {
  const scale = Math.max(1, Math.sqrt(nodeCount / 90));
  return {
    alphaDecay: 0.02,
    velocityDecay: 0.36,
    warmupTicks: 80,
    cooldownTime: 3500,
    chargeDistanceMax: 220 * scale,
    centerStrength: 0.035 / scale,
    cardCharge: -72 * scale,
    collectionCharge: -115 * scale,
    cardLinkDistance: 56 * scale,
    collectionLinkDistance: 76 * scale,
  };
}
```

Apply d3 forces after graph initialization:

- `charge`: separate card and collection charge constants;
- `center`: weaker as node count grows;
- `link.distance`: separate card-card and collection-involved distances;
- `forceCollide`: collection radius `48`, card radius `22`, strength `0.75`,
  iterations `2`.

The custom `forceEdgeRepel` from Longevity is not part of the initial contract.
It is an optional diagnostic experiment if proportional charge + collision
cannot resolve overlaps in Mine's real vaults.

## Interaction

### Hover

Card hover opens a sidebar-compatible preview. Its timing is the shared card
preview rule (SPEC_CARD_STATES.md, С7.10, user's decision 08.10.2026), owned
by `HoverPreviewOpener` in `src/lib/hoverPreviewTiming.ts` and wired through
`useHoverPreviewOpener`, the same as the sidebar and the open card's rows:

- cold open delay: `HOVER_PREVIEW_COLD_OPEN_DELAY_MS = 500`;
- then a resting pointer: the graph container feeds its own hover-intent
  engine (`useHoverIntent`), and the preview waits while its `isSlow` is
  false, so a pointer passing over nodes opens nothing;
- warm open delay: `HOVER_PREVIEW_WARM_OPEN_DELAY_MS = 0`;
- warm window: `HOVER_PREVIEW_WARM_WINDOW_MS = 800`, counted from when a
  preview was last on screen, not from when it opened: a preview read for a
  while still hands over to the next node at once.

Приглушение при наведении на коллекцию отвечает тому же правилу намерения,
что карточки ленты и строки бокового меню (решение пользователя 16.10.2026,
SPEC_CARD_STATES.md, С7.1 по С7.8): один движок `HoverIntent`
(`src/lib/hoverIntent.ts`) через `useHoverIntent`, тот же, что даёт превью
скорость указателя; своих таймеров у графа нет. Как граф кормит движок:

- force-graph сообщает узел под указателем через `onNodeHover`, когда узел
  под ним сменился (проверка идёт в кадре отрисовки). Граф запоминает
  коллекцию под указателем (карточка и пустой холст это не цель) и сообщает
  её движку в последней точке указателя: та же точка для движка не
  движение, он только узнаёт, над чем указатель теперь;
- каждое `pointermove` контейнера графа передаёт движку точку и эту
  коллекцию, по ним движок меряет скорость (С7.2);
- приглушение читает ответ движка `chosen`: коллекция приглушает остальное
  после задержки `dwellMs` (300 мс) у медленного или стоящего указателя
  (С7.1); быстрый пролёт через подпись коллекции не приглушает ничего;
  после первого ответа соседняя коллекция отвечает сразу, пока длится тёплое
  окно `warmMs` (400 мс, С7.3); уход на пустое место или на карточку гасит
  ответ через `leaveGraceMs` (150 мс), быстрое движение держит его до конца
  тёплого окна (С7.4);
- уход указателя с графа и открытая карточка сообщают движку уход (С7.4);
  перетаскивание узла и открытое контекстное меню (меню карточки
  `CardPointMenu` отмечается как контекстное) останавливают движок, и
  приглушение гаснет сразу (С7.8);
- обводка подписи коллекции под указателем остаётся мгновенной, как у
  карточки: это отклик того, что под указателем, а не ответ намерения.

Rules:

- наведение на карточку ничего не приглушает; коллекция, на которой
  указатель задержался по правилу намерения выше, приглушает остальной граф
  по разделу «Приглушение при наведении на коллекцию» (решение пользователя
  16.10.2026, заменяет прежнее «do not dim nodes or links»);
- do not change card size, opacity, border, label visibility or link color on
  card hover; the only canvas change is the shared one-CSS-pixel `hoverOutline`;
- after the configured delay, fetch the full block with `get_block`;
- render `ReadOnlyCardPreview` with width `240`: the feed's own card unfolded,
  everything its lift brings up shown without the lift, nothing to press (SPEC_CARD_STATES.md, С10, since
  06.10.2026), the same card as the sidebar and search previews;
- position the preview from `graph2ScreenCoords(node.x, node.y)`, clamped to the
  viewport with the same gap/margin model as Sidebar;
- close immediately on pointer leave;
- граф отвечает наведению, только пока указатель над его поверхностью и её
  не закрывает открытая карточка (решение 16.10.2026, причина живой ошибки
  того же дня). Уход указателя с контейнера графа (`pointerleave`) и
  открытая карточка (`detailOpen`) снимают наведённые карточку и коллекцию
  (а с ними обводку и приглушение коллекции), закрывают превью и выключают
  `enablePointerInteraction` у `ForceGraph2D`; вход указателя включает его
  обратно. Причина: force-graph запоминает последнюю точку указателя только
  по `pointermove` и `pointerdown` своего контейнера, при уходе её не
  сбрасывает и каждый кадр спрашивает узел под ней. Узел, который сдвиг
  раскладки (остывание после щелчка, новый снимок после `Connect`) приносил
  под старую точку, считался наведённым и открывал превью (`fixed z-50`)
  поверх открытой карточки (`z-10`). Выключение `enablePointerInteraction`
  забывает узел, о котором библиотека сообщила последним, поэтому возврат на
  тот же узел снова его наводит. Один владелец: поток указателя контейнера
  графа; фокус окна не нужен (SPEC_CARD_STATES.md, С7.8, 14.10.2026).
  Открытое меню карточки по-прежнему замораживает наведение, а после его
  закрытия то же правило снимает наведение, если указатель уже не над
  графом;
- collection hover has no card preview;
- when an app-level card actions menu is open, `App` passes
  `hoverPreviewFrozen=true`; Graph View must keep the current hover preview and
  collection hover state unchanged, cancel pending preview timers, and ignore
  new `onNodeHover` enter/leave updates until the menu closes;
- when `hoverPreviewFrozen` transitions from `true` back to `false`, Graph View
  must call `d3ReheatSimulation()` on the next animation frame. Menu freeze is a
  temporary interaction pause, not a new resting layout state; label collision,
  charge, and link forces must resume immediately after the dropdown closes,
  without requiring the user to drag a node;
- freeze preserves the current card hover preview only while the menu is open.
  On unfreeze, Graph View compares the latest pointer position to the original
  card-node square. If the pointer is no longer inside that node, the preview
  closes immediately; if it is still inside, normal hover state resumes.

### Приглушение при наведении на коллекцию

Решение пользователя 16.10.2026: наведение на коллекцию приглушает карточки
и рёбра вне её собственной части; коллекции не приглушаются никогда. Заменяет прежнее правило «hover must
not recolor or dim the graph». Код:
[hoverDim.ts](src/components/graph/hoverDim.ts) (состав части, переход,
цвет линии), [canvas.ts](src/components/graph/canvas.ts) (рисование узла),
[GraphView.tsx](src/components/GraphView.tsx) (наведение и кадры).

**ПН1. Что остаётся обычным.** При наведении на узел коллекции обычными
остаются этот узел, карточки, с которыми он соединён ребром членства
(`collection_membership`), и сами эти рёбра. Приглушены все прочие
карточки и все прочие рёбра. Другие коллекции остаются обычными. Правило строгое:
ссылки `wikilink` и `related_note` между карточками этой коллекции, рёбра
членства этих карточек в других коллекциях и ссылка `[[…]]` карточки на
страницу самой коллекции приглушены, потому что членством не являются.
Коллекция без карточек оставляет обычной только себя.

**ПН2. Карточка ничего не приглушает.** Наведение на карточку не меняет
граф, кроме обводки наведения (раздел «Hover»). Без ответа намерения граф
обычный: уход указателя с коллекции, в том числе на карточку или на пустое
место, возвращает его по правилу движка (раздел «Hover», С7.4).

**ПН3. Величина.** Приглушение одно для карточек и рёбер в обеих темах:
непрозрачность 25 %, постоянная закона цвета `GRAPH_CONTEXT_OPACITY` в
[colorLaw.ts](</Users/i_iii/Проекты/Личные проекты/local-arena/.claude/worktrees/youtube-referer/src/lib/colorLaw.ts>)
(К13 и закон 3.9.4 в
[SPEC_COLOR_RULES.md](</Users/i_iii/Проекты/Личные проекты/local-arena/.claude/worktrees/youtube-referer/SPEC_COLOR_RULES.md>)).
Коллекции не приглушаются никогда. Решение пользователя 16.10.2026: при
доле 0.6 приглушение карточек не было видно, а коллекции приглушать не
нужно. Эталоны делятся на три яруса:

| Ярус | Доля | Эталоны |
|---|---|---|
| Вторичное, читаемое | от 0.5 до 0.62 | iOS `secondaryLabel` 0.6; macOS `secondaryLabelColor` 0.498 при `labelColor` 0.847, то есть 0.59 от основного; Material, средний уровень выделения 0.6; Windows 11 вторичный текст 0.62; GNOME 0.55 |
| Третичное | от 0.25 до 0.42 | Apple `tertiaryLabel` от 0.26 до 0.3; Material, недоступное 0.38; Windows 0.36 |
| Почти скрытое, фон | от 0.1 до 0.25 | Apple `quaternaryLabel` от 0.1 до 0.18; графовые библиотеки: Cytoscape.js `.faded` 0.25, AntV G6 0.25, plotly 0.2, ECharts 0.1 |

Выбрана точка 0.25 на стыке третичного яруса и графовых библиотек: macOS
`tertiaryLabelColor` 0.26 (ступень К8), Cytoscape.js и AntV G6 0.25.
Вторичный ярус (0.6) взят первым и снят: он рассчитан на текст, а
миниатюра карточки несёт свой контраст, и при 0.6 она почти не менялась.
Прежние 68 % (1 минус доля подложки `--scrim-color`) сняты раньше:
подложка значит другой слой над страницей. Одна доля на обе темы. Ни
Obsidian, ни Gephi эталоном не взяты.

Источники: [WebKit, цвета меток macOS](https://github.com/WebKit/WebKit/blob/main/LayoutTests/platform/mac/fast/css/apple-system-control-colors-expected.txt),
[WebKit, цвета меток iOS](https://github.com/WebKit/WebKit/blob/main/LayoutTests/fast/css/apple-system-control-colors-expected.txt),
[Apple, tertiaryLabelColor](https://developer.apple.com/documentation/appkit/nscolor/tertiarylabelcolor),
[Material, ContentAlpha](https://github.com/androidx/androidx/blob/androidx-main/compose/material/material/src/commonMain/kotlin/androidx/compose/material/ContentAlpha.kt),
[Material Components, уровни текста](https://github.com/material-components/material-components-web/blob/master/packages/mdc-theme/_theme-color.scss),
[Material 3, недоступное](https://github.com/material-components/material-web/blob/main/tokens/versions/v0_192/_md-comp-filled-button.scss),
[WinUI, уровни текста](https://github.com/microsoft/microsoft-ui-xaml/blob/main/controls/dev/CommonStyles/Common_themeresources_any.xaml),
[libadwaita](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/css-variables.html),
[Cytoscape.js](https://github.com/cytoscape/cytoscape.js/blob/master/documentation/demos/pie-style/code.js),
[AntV G6](https://github.com/antvis/G6/blob/v5/packages/g6/src/themes/base.ts),
[plotly.js](https://github.com/plotly/plotly.js/blob/master/src/constants/interactions.ts),
[ECharts](https://github.com/apache/echarts/blob/master/src/util/states.ts).

Подписи коллекций не приглушаются и сохраняют свой контраст. Приглушённая
карточка остаётся контекстом, а не текстом для чтения: основной цвет под
ней даёт 1.79:1 в светлой теме и 2.09:1 в тёмной.

**ПН4. Как рисуется.** Карточка сначала заливает свой контур холстом
`--background`, затем рисуется весь (миниатюра, заливка, рамка, подпись) с
этой непрозрачностью. Так приглушённая карточка выглядит карточкой под подложкой,
а не прозрачной: линии под ней сквозь неё не проступают. Ребро и его стрелка рисуются тем же цветом `--border` с этой
непрозрачностью. Толщина линий, пунктир, изгиб, размер узлов, обводки,
области попадания и физика не меняются: симуляция не разогревается,
раскладка и камера не трогаются.

**ПН5. Переход.** Приглушение включается ответом движка намерения (раздел
«Hover»: задержка 300 мс у медленного указателя, сразу у соседней коллекции
в тёплом окне), затем следует таймингу ответов на указатель
(SPEC_CARD_STATES.md, С7.6): появляется за `HOVER_INTENT.fadeInMs` (150 мс),
уходит за `fadeOutMs` (100 мс); переход с одной коллекции на другую идёт за
150 мс, и каждый элемент движется от своей прежней непрозрачности к новой.
Смена посреди перехода (указатель пересёк подпись и ушёл) начинается оттуда,
где элементы стоят, без скачка.
Кривая та же, что у движения камеры графа (`easeOutCubic`). При «Уменьшить
движение» смена мгновенная. Только пока идёт переход, холст перерисовывается
каждый кадр (`autoPauseRedraw` выключен), после последнего кадра снова
останавливается.

**ПН6. Цена кадра.** Часть графа (множества узлов и рёбер) считается один
раз при смене наведения или снимка (`graphHoverHighlight`). Кадр в покое
делает на каждый узел и каждое ребро одну проверку множества, во время
перехода ещё по одной на каждый прерванный переход за ним (не больше 8);
строка цвета линии строится один раз на значение непрозрачности.

**ПН7. Выделение и открытая коллекция.** Приглушение читает только
наведение. Выбранная карточка сохраняет свою обводку и приглушается вместе
с остальными, если лежит вне части наведённой коллекции. Открытая коллекция
не приглушается, как и любая коллекция. Наведение на открытую коллекцию
приглушает соседей, попавших в граф только по связям.

**ПН8. Поиск.** Поиска на графе нет (раздел «Controls And Settings»), и
приглушения поиском тоже нет, поэтому сочетать не с чем. Если оно появится,
действует одна ступень: элемент либо обычный, либо приглушён этой же
непрозрачностью, и источники приглушения не перемножаются.

**ПН9. Перетаскивание и меню.** Пока узел тащат, движок намерения
остановлен (С7.8): приглушение гаснет сразу и не включается; отпустили над
коллекцией, оно возвращается после задержки движка. Открытое меню карточки
замораживает наведение (обводку и превью, раздел «Hover»), а движок на это
время останавливает общая подписка на контекстные меню (С7.8), поэтому
приглушение гаснет сразу.

Проверки: `hoverDim.test.ts` (состав части, карточка без приглушения,
переход, цвет линии), `paintCardNode.test.ts` (холст под приглушённой
карточкой), `colorLaw.test.ts` (доля `GRAPH_CONTEXT_OPACITY` закреплена,
коллекции не приглушаются, граф не читает подложку), `GraphView.test.tsx` (быстрый пролёт через коллекцию не
приглушает, коллекции остаются обычными, остановка приглушает после задержки движка и не раньше, соседняя
коллекция после ответа отвечает сразу, перетаскивание гасит сразу, уход
гасит после `leaveGraceMs`; узлы и линии, выбранная карточка, карточка без
приглушения, без разогрева симуляции), `test:graph` (тёмная тема: указатель
остановился на Design, и пиксель карточки чужой коллекции дошёл до
`GRAPH_CONTEXT_OPACITY` над холстом; переход на Research вернул его, после
ухода граф обычный).

### Click And Context Menu

Block node left click:

1. close any open hover preview;
2. resolve the `LightBlock` from the current route cache, falling back to
   `get_block` only when the graph node is outside the loaded route window;
3. call the existing app-level `onOpenBlock(block)` path, so Graph View opens
   the same Detail surface as Grid, Sidebar, and Search Overlay.

Block node right/context click:

1. prevent the native WebView context menu on the graph surface;
2. keep any currently open hover preview visible;
3. resolve the block the same way as left click;
4. call `onOpenCardMenu(block, { x, y })`;
5. let `App` render `CardPointMenu`, a point-anchored wrapper over the shared
   `CardMenuDropdownContent`/`CardMoreMenu` action contract.
6. while that menu is open, freeze Graph View hover updates so moving across
   other nodes does not replace or close the visible hover preview.

Graph View must never dispatch synthetic `contextmenu` events from card nodes:
cards are painted on Canvas, and WebView can route synthetic context menus to
the system/page menu instead of Mine's app menu.

The first click or context click outside the point menu closes the menu only;
it must not reach the canvas, open another card, navigate a collection, or
replace the frozen hover preview. Every menu does this through the shared
outside-press guard (`src/lib/openMenus.ts`, DESIGN_SYSTEM.md «Открытое меню»),
so the point menu installs no layer of its own over the window: hover keeps
working everywhere outside the graph, while the graph itself stays frozen as
above. The point menu counts as a context menu for SPEC_CARD_STATES.md С7.8.

Collection node click:

1. switch current route to that collection;
2. keep Graph View active;
3. request a new `current_route` graph snapshot.

### Centering With Detail

The graph exposes an imperative handle:

```typescript
export type GraphViewHandle = {
  centerOnNode: (nodeId: string) => void;
};
```

Centering uses `graph2ScreenCoords`:

1. find node coordinates;
2. convert graph coordinates to screen coordinates;
3. if node is inside visible graph area, do nothing;
4. if node is under/behind the Detail panel, call `centerAt(node.x, node.y, 400)`;
5. retry on graph container resize while a pending center request exists.

Never center unconditionally on every click; it makes graph navigation feel
unstable.

### Controls And Settings

Graph View has no graph-local search, scope selector, or settings icon. The
active route determines the snapshot automatically:

- Everything → `library`;
- collection route → `current_route`.

Видимость связей меняют два места с одним значением: панель графа на кнопке
`Display` во втором ряду хрома и раздел `Graph` окна настроек (раздел
«Панель графа», 11.10.2026). Обе поверхности снаружи холста; страница
вкладки передаёт в Graph View одно неизменяемое значение. Холст настройки не
читает и не сохраняет. До 11.10.2026 переключатели были только в окне
настроек, и среди них был `Collections`.

`Show all` remains a contextual action, shown only for a truncated library
snapshot with `can_materialize_full = true`. It is session-local and resets when
Graph View remounts; it is not a general preference.

## Панель графа

Требование пользователя 11.10.2026: «в граф добавь панель настроек. Сделай
возможность включать и выключать дополнительные связи между карточками.
Коллекции скрывать нельзя». Пользователь показал кнопку настроек справа от
переключателя `Grid | Graph` во втором ряду. Реализовано 11.10.2026, доведено
16.10.2026 (линии без перезапуска симуляции, ГП4; ГП9), живая приёмка за
пользователем.

Где живёт: панель в [GraphDisplayMenu.tsx](src/components/GraphDisplayMenu.tsx)
на общей кнопке и панели [DisplayMenu.tsx](src/components/DisplayMenu.tsx);
значение в [graphPreferences.ts](src/lib/graphPreferences.ts); раздел Graph
окна настроек в [GraphSection.tsx](src/settings/GraphSection.tsx) и его
слушатель в [SettingsApp.tsx](src/settings/SettingsApp.tsx); запрос в
`GraphOptions` ([graph.rs](src-tauri/src/storage/graph.rs)).

**ГП1.** Кнопка. В режиме Graph кнопка `Display` (иконка Lucide `Settings2`,
имя для чтения с экрана «Display options») стоит там же, где в режиме Grid: во
втором ряду хрома справа от `Grid | Graph`, на оси кнопки Mine. Это одна и та
же кнопка ([SPEC_FEED_DISPLAY.md](SPEC_FEED_DISPLAY.md), Д1 и Д4): в Grid она
открывает панель ленты, в Graph панель графа. В Graph панель ленты не
открывается, в Grid панель графа не открывается. Смена вида закрывает
открытую панель. В ленте автора графа нет, и кнопка там всегда открывает
панель ленты.

**ГП2.** Вид. Панель графа собрана из тех же компонентов, что панель ленты, и
выглядит так же: штатное меню `DropdownMenu` ширины по содержимому (от 128 до
300px), выровненное по правому краю кнопки, подпись группы как у групп ленты
(`px-plate py-1.5 font-mono text-sm text-muted-foreground`). Новых размеров,
цветов и токенов нет.

**ГП3.** Состав. Одна группа `Links` с двумя переключателями: `Wikilinks`
(ссылки `[[…]]` из текста заметки на другую карточку или на страницу
коллекции) и `Related notes` (связи происхождения, которые записывает Mine).
Переключатель это пункт-флажок меню (`DropdownMenuCheckboxItem`): у
включённого галочка `Check` 13px в обычном слоте иконки, у выключенного слот
пуст, текст стоит на общей колонке меню, как у пунктов выбора ленты.

**ГП4.** Действие. Переключатель срабатывает сразу, без подтверждения,
панель остаётся открытой. Граф запрашивает новый снимок без перезагрузки
страницы и без пересоздания холста: позиции узлов переносятся между снимками
(раздел «Rearranging Around An Opened Collection»), линии выключенного вида
уходят, включённого появляются. В Everything все карточки и коллекции
остаются на месте. В коллекции соседи, попавшие в граф только по связи
выключенного вида, уходят вместе с ней (раздел «Scope Semantics»). Escape и
щелчок снаружи закрывают панель, клавиатура работает как в остальных меню,
фокус после закрытия клавиатурой возвращается на кнопку.

«На месте» значит буквально (доведено 16.10.2026): когда новый снимок
меняет только линии, а узлы те же, симуляция не перезапускается и камера не
двигается. Холст графа (`ForceGraph2D`) на любые новые данные сам
разогревает симуляцию, поэтому Graph View отдаёт ему новые линии вместе с
`cooldownTicks = 0`, и движок останавливается до первого шага; после
остановки значение возвращается к `Infinity`, и следующее перетаскивание
запускает симуляцию как обычно. Силы и план камеры заново не ставятся: их
эффект зависит от состава узлов (`nodeIdentity`: место и узлы с
подписями), а не от линий. Новые линии получают силы связи в той же
передаче, и раскладка подстроится под них при следующем пробуждении
симуляции (перетаскивание). Раскладка, которая ещё оседает, не
останавливается: она продолжает движение с новыми линиями. Если меняется
состав узлов (сосед коллекции ушёл вместе со связью), это перестройка по
разделу «Rearranging Around An Opened Collection». Линии сравниваются по
идентификаторам (`linkIdentity`), а не по числу: столько же других линий
(заметка теперь ссылается на другую карточку) тоже доходят до холста; до
16.10.2026 холст сравнивал только число и оставлял прежние линии.

**ГП5.** Коллекции. Узлы коллекций и рёбра членства показываются всегда.
Переключателя для них нет ни в панели, ни в окне настроек. Поле
`include_collections` удалено из сохранённых настроек и из запроса графа
(`GraphOptions`): ядро строит коллекции безусловно, а это поле в запросе от
старой страницы пропускается как неизвестное. Сохранённое до 11.10.2026
значение `include_collections: false` не читается и ни на что не влияет;
чтение хранилище не переписывает, поле пропадает при следующей записи.
Ссылка `[[…]]` на страницу коллекции остаётся связью вида `Wikilinks` и
выключается вместе с ним: скрывается линия, а не коллекция.

**ГП6.** Хранение. Одно значение на всё приложение: объект
`mine.graphPreferences` в `localStorage` с полями `include_wikilinks` и
`include_related_notes`, по умолчанию оба `true`. Повреждённое или неполное
значение читается как значение по умолчанию для того, чего в нём нет. Выбор
переживает перезапуск и общий для всех вкладок, окон и пространств.

**ГП7.** Синхронизация. Панель и раздел Graph окна настроек меняют одно
значение одной функцией `setGraphPreference`: запись в хранилище, применение
на своей странице сразу и событие `settings-changed` с ключом и значением.
Страница вкладки и окно настроек, получив событие, принимают переданное
значение и перечитывают его (`reloadGraphPreferences`). Поэтому открытая
панель, граф в другой вкладке и раздел Graph показывают изменение сразу, в
какую бы сторону оно ни шло. Равное значение не публикуется: собственное
событие страницы, вернувшись к ней, не запрашивает снимок повторно.

**ГП8.** Внутри холста графа своих элементов управления по-прежнему нет
(раздел «Controls And Settings»): панель живёт в хроме, как панель ленты.

**ГП9.** Выключенный вид нигде не учитывается: ядро не строит его рёбра,
поэтому их нет ни в снимке, ни в числе соседей узла (`degree`, строка
выбранного узла для чтения с экрана), ни в `visible_links` и `total_links`,
ни в приглушении при наведении на коллекцию. Легенды и поиска на графе нет.
Пунктиром рисуются ровно два вида, `wikilink` и `related_note`, и у обоих
есть переключатель; рёбра членства сплошные и всегда видны (ГП5). Новых
видов связей нет.

Проверки: `GraphView.test.tsx` (новые линии без перезапуска симуляции и без
движения камеры; оседающая раскладка не останавливается; столько же других
линий доходят до холста; запрос по переключателю панели),
`GraphDisplayMenu.test.tsx`, `GraphSection.test.tsx`,
`GraphAuditRoute.test.tsx`, `test:graph` (тёмная тема: выключение обоих
видов убирает пунктир, включение возвращает, картинки узлов остаются на тех
же местах, кадров не больше 5 на переключение).

### Решения сверх требования

Требование их не называло; приняты 11.10.2026 как самые консервативные.

1. Та же кнопка `Display` с тем же именем «Display options» и той же иконкой
   в обоих видах; меняется только содержимое панели.
2. Подпись группы `Links`; порядок пунктов как в окне настроек: `Wikilinks`,
   затем `Related notes`.
3. Переключатель это пункт-флажок меню с галочкой в слоте иконки.
   `DropdownMenuCheckboxItem` приведён к виду `DropdownMenuRadioItem`: до
   11.10.2026 он нигде не использовался и сдвигал текст на `pl-8`.
4. Раздел Graph окна настроек остаётся с двумя флажками, строка
   `Collections` убрана.
5. Ссылка на страницу коллекции считается связью `Wikilinks`, а не частью
   коллекций (ГП5).
6. Смена вида закрывает открытую панель (ГП1).

## Display Mode Integration

Graph View extends layout mode values:

```typescript
type LayoutMode = "gallery" | "grid" | "table" | "columns" | "graph";
```

Because the current app may not yet have all modes from
[SPEC_DISPLAY_MODES.md](SPEC_DISPLAY_MODES.md), implementation must integrate
with the actual current display-mode code rather than mechanically following the
old future-state names.

Required user-facing behavior:

- the canonical `Grid / Graph` segmented control lives in the secondary stats
  bar immediately after the route item count and follows the same typography,
  spacing and surface-aware interaction tokens as the collection filter;
- The selected layout persists in `localStorage`.
- Route changes preserve Graph mode.
- Detail open/close must not remount the Canvas graph.
- Switching away from Graph releases graph-specific event handlers and image
  cache.

### Возврат из графа

Решение пользователя 16.10.2026: лента, переключённая на граф и обратно, возвращается на ту же позицию прокрутки, а не в начало.

- В графе лента снимается со страницы, поэтому позиция хранится не в ней, а тем же якорем по карточке, по которому вкладка возвращает прокрутку при восстановлении (SPEC_TABS.md, В40): карточка в верху ленты и её сдвиг (`ScrollAnchor`), ключ места (`placeKey`). Второго хранилища нет: это `pendingScroll` в `App.tsx`, и память вкладки (`TabView.scroll_anchor`) в графе сообщает только его. Ленту, снятую со страницы, о прокрутке не спрашивают: её последний ответ относится к месту, где она стояла.
- При переключении `Grid → Graph` вкладка берёт якорь у ленты (`readScrollPosition`). Лента в самом верху якоря не даёт и возвращается в начало.
- Пока граф показывает то же место, якорь ждёт, страницы ленты ради него не читаются. Другое место (коллекция, Everything) якорь сбрасывает: якорь принадлежит месту, где его дала лента, и своей вкладке.
- При возврате в `Grid` лента получает якорь (`restoreScrollAnchor`) и прокручивается к карточке, как восстановленная вкладка: когда у карточки и всех выше неё есть высота. Карточки нет среди прочитанных: лента дочитывает страницы, как восстановленная вкладка, и предел (`SCROLL_RESTORE_PAGE_LIMIT`) свой у каждого возврата. Карточки уже нет: лента остаётся в начале.
- Лента при появлении на странице сама в начало не прокручивается: в начало её ведут только смена места при той же ленте и явный сигнал (`scrollToTop`), поэтому появление ленты не отменяет возврат к карточке.
- Вкладка, сохранённая в режиме графа, хранит якорь ленты и возвращает его при переходе в `Grid`.
- В ленте автора графа нет: переключатель её не снимает, якорь не берётся.

Проверки: `src/App.graphScroll.test.tsx` (граф и обратно возвращают ту же карточку в Everything и в коллекции, лента в начале остаётся в начале, другое место в графе сбрасывает якорь, память вкладки в графе хранит ждущий якорь и не хранит якорь другого места, вкладка, сохранённая в графе, возвращает карточку при переходе в `Grid`), `Grid.wordMetrics.test.tsx` (лента при появлении не прокручивается в начало, смена места и сигнал прокручивают).

## Events And Refresh

Graph snapshots refresh on the same invalidation classes as Grid:

- `block:added`;
- `block:removed`;
- `block:renamed`;
- `vault-changed`;
- collection membership changes;
- watcher-driven index refresh completion.

Optimization:

- v1 may refetch the snapshot after these events;
- future slices can patch node/link deltas if full refetch becomes visible.

Correctness rule:

If `block:renamed` retargets an open Detail, selected graph node id must retarget
from `block:<old_slug>` to `block:<new_slug>` without closing Detail.

## Accessibility And Keyboard

**The graph is a pointer surface — decided 23.08.2026.** Selection, opening,
panning and zoom are cursor gestures; the graph installs no keyboard handlers
and its canvas is not focusable. The earlier parallel keyboard model (arrow
selection, Enter activation, Escape deselection) is removed: it required DOM
focus on the canvas, was dead until a click, and duplicated a navigation the
feed already owns. Global shortcuts (collection switching, view toggle, search)
keep working over the graph because they are window-level.

A textual `aria-live` status region still announces the selected node label and
neighbor count for assistive technology.

## Tests

### Rust

- `build_graph_snapshot` returns collection nodes and membership edges from
  `Mine Collections` / `block_tags`.
- Ссылка `Mine Collections` на имя без страницы не даёт ни узла коллекции, ни
  ребра; появление страницы с этим именем добавляет и узел, и ребро.
- Wikilinks become directed block edges.
- Missing wikilink and related-note targets are omitted together with their
  edges.
- Media embeds are absent from `wikilinks` after runtime indexing and
  graph-link-index backfill.
- Related-note block references resolve by base slug while preserving fragments
  outside graph identity.
- Запрос от старой страницы с `include_collections: false` читается без этого
  поля и получает узлы коллекций и рёбра членства (ГП5).
- Выключение `Wikilinks`, `Related notes` или обоих убирает только рёбра
  своего вида: все карточки, коллекции и рёбра членства остаются (ГП4, ГП5).
- Duplicate links increment `count`.
- `current_route` scope includes collection members and 1-hop related neighbors.
- Large vault thresholds set `truncated` and exact `visible_nodes`.
- Renamed blocks do not leave stale edge targets after reindex.

### Frontend Unit

- card node paint uses a screen-fixed 32px square with no corner radius.
- card hover uses the shared `HoverPreviewOpener`: a moving pointer opens
  nothing past the delay, and a preview read past the warm window hands over
  to the next node at once.
- card hover open/close does not change node opacity, link color, card size, or
  card labels.
- наведение на коллекцию оставляет обычными её узел, карточки её членства и
  рёбра членства, приглушает всё остальное и не разогревает симуляцию;
  наведение на карточку не приглушает ничего (раздел «Приглушение при
  наведении на коллекцию»).
- уход указателя с графа и открытая карточка закрывают превью, снимают
  наведение и выключают `enablePointerInteraction`; узел, оказавшийся под
  старой точкой указателя при открытой карточке, превью не открывает
  (раздел «Hover»).
- новые линии над теми же узлами не перезапускают симуляцию и камеру,
  столько же других линий доходят до холста (ГП4).
- Graph View renders no graph-local search, scope selector, or settings trigger.
- persisted graph preferences are forwarded unchanged to the graph snapshot
  request and a settings change reloads the projection.
- Панель графа (от ГП1 до ГП7): в Graph кнопка `Display` открывает панель графа,
  в Grid панель ленты; одна группа `Links` с флажками `Wikilinks` и
  `Related notes`, без `Collections`; флажок срабатывает сразу, панель
  остаётся открытой, граф запрашивает снимок с новыми связями; значение
  сохраняется; старое `include_collections: false` не доходит до запроса;
  изменение в панели видно в окне настроек и наоборот.
- collection-membership links are straight and solid; wikilink/related-note
  links are curved and dashed with deterministic pair-stable curvature.
- reference dash segments preserve the `4px / 4px` visual rhythm across zoom.
- collection node hit-area metrics match pill width/height.
- graph hover preview uses `ReadOnlyCardPreview` with `previewMode="micro"` and
  width `240`.
- graph first mount passes the measured container width/height into
  `ForceGraph2D`, not the old `800x600` fallback.
- Graph View does not render a persistent node/link count badge over the canvas;
  counts belong in diagnostics/devtools, not in the product surface.

### Browser Acceptance

Use Playwright for real Canvas verification:

- Graph View first paint is nonblank in dark and light themes.
- Resizing Sidebar/Detail changes canvas dimensions without remounting.
- Hovering a card for the cold delay shows the sidebar-style micro preview and
  changes only the card's one-CSS-pixel outline, not any other canvas pixels.
- Наведение на коллекцию (тёмная тема): пиксель карточки другой коллекции
  приглушается до карточки под долей подложки холста, пиксель карточки этой
  коллекции не меняется, после ухода указателя пиксель прежний.
- Переключение дополнительных связей (тёмная тема): выключение убирает
  пунктир, включение возвращает, картинки узлов остаются на тех же местах,
  на переключение не больше 5 кадров (ГП4).
- Large snapshot does not create thousands of image requests.
- Mobile/narrow window keeps the contextual `Show all` action inside the graph
  viewport when present.

Canvas pixel checks must verify that the graph has non-background pixels after
render and after route switches.

The executable acceptance is `bun run test:graph` against the dev-only
`/__graph-audit` route. It runs both dark and light themes and verifies settled
first paint, raw Canvas pixels, automatic route switching, resize without
remount, absence of removed Graph controls, bounded image requests, real delayed
hover with a one-CSS-pixel outline and zero pixel changes outside its mask,
collection hover dimming (ПН1, ПН3) and pan/zoom timing. Hover comparison waits for a settled canvas rather than
assuming the force simulation has stopped after a fixed delay.

`bun run verify` must include this gate through a self-contained browser-audit
runner. The runner starts one Vite server on a free localhost port, waits for
readiness, runs both Feed and Graph audits against that server, and tears it down
on success, failure and process signal. A prestarted development server is not a
verification prerequisite.

### M1 performance budgets

- Backend snapshot for a returned graph of at most 1,000 nodes and 5,000 links:
  at most 250 ms in release mode on the reference Apple Silicon machine.
- First non-background Canvas paint: at most 1,000 ms after a fresh snapshot.
- Selection centering: at most 250 ms from selection to centered node when the
  node is already materialized.
- Pan/zoom/drag interaction: p95 frame interval below 32 ms and no main-thread
  task above 100 ms during the Playwright interaction trace.
- Settled collection labels keep at least 2 CSS pixels between pill bounds at
  every tested zoom; text never disappears while the node is visible.
- Image requests are bounded by materialized card nodes and deduplicated by
  preview URL.

### M1 interaction state machine

- `idle -> hovered` is delayed by the shared sidebar timing and never mutates
  graph geometry.
- A left click without crossing the drag threshold opens Detail.
- A right click opens the shared card menu and freezes hover replacement.
- Pointer movement across the drag threshold cancels click activation and pins
  the dragged node until release.
- Closing menu or Detail restores simulation state without a synthetic drag or
  remount.
- The graph exposes no keyboard surface: no `data-graph-keyboard-surface`, no focusable canvas wrapper.

## Implementation Slices

1. **DONE: Graph spec and docs** — this file, architecture links, plan entry.
2. **DONE: Dependencies and frontend types** — `react-force-graph-2d`,
   `d3-force`, `@types/d3-force`, TS/Rust graph DTOs.
3. **DONE: Backend snapshot** — `storage::graph`, `commands::graph`, provenance,
   dedupe and scope/threshold tests.
4. **DONE: Canvas renderer** — `GraphView`, measured mount, tick-delayed initial
   fit, resize-stable physics, custom paint/hit areas and shared hover preview.
5. **DONE: Minimal controls and Detail integration** — automatic route scope,
   persisted Graph preferences in common Settings, selected-node sync and
   conditional centering; graph-local search/settings controls removed.
6. **DONE: Display mode wiring** — persisted secondary-bar switch, route
   preservation and refresh events.
7. **DONE: Performance and accessibility** — large-vault policy, keyboard
   navigation, status announcements and real-browser Canvas acceptance.

Each slice must land with tests appropriate to its risk. Do not merge a visual
Graph View implementation based only on unit tests; Canvas must be verified in a
real browser/WebView-like environment.
