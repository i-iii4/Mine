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
  include_collections: boolean;
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
- `linkColor` stays stable during hover; hover must not recolor or dim the
  graph.
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

**Статус: реализовано 21.08.2026.** Размер считает `graphNodeScreenSize`
(`src/components/graph/nodeSize.ts`) — единственный источник для отрисовки,
области попадания курсора, позиции меню и предпросмотра.

**Размер считается от заполнения кадра, а не от масштаба.** Кадру доступна
площадь; она делится между узлами, которые сейчас в нём находятся, и от доли
каждого берётся `GRAPH_NODE_FILL_RATIO` — остальное остаётся воздухом между
соседями.

Привязка к масштабу была ошибкой, исправленной в тот же день. При
`size = base × zoom` расстояния между узлами умножаются на тот же масштаб, и
доля экрана, занятая картинками, не меняется вовсе: сколько ни приближайся,
картинка и промежуток рядом с ней растут одинаково. Потолок при этом
достигался только на масштабе выше трёх, когда в кадре оставалась одна
карточка.

| Узлов в кадре | Размер узла при окне 1280×800 |
|---|---|
| 550 | 32 px, нижняя граница |
| 300 | 44 px |
| 150 | 62 px |
| 100 | 76 px |
| 58 и меньше | потолок, 100 px |

**Долю выбирает нижняя граница, а не вкус.** При `GRAPH_NODE_FILL_RATIO = 0.55`
полный обзор давал расчётные 24 пикселя — ниже границы в 32, поэтому первая
половина приближения не меняла ничего: карточки лежали на границе от 550 узлов
в кадре до 194. При `0.75` полный обзор даёт 34, и рост идёт с первого
движения.

Пересчёт идёт на шагах зума и при **остановке** движка, но не пока раскладка
движется. Пересчёт по ходу оседания заставлял карточки то уменьшаться, то
возвращаться к прежнему размеру — соседи входили в кадр и выходили из него, а
размер следовал за каждым таким движением. Заметнее всего это было при
перетаскивании узла.

Дополнительно действует гистерезис `GRAPH_NODE_SIZE_HYSTERESIS`: новое
измерение принимается, только если отличается от текущего больше чем на
двенадцать процентов. Ниже этого порога обычный дрейф раскладки продолжал бы
менять размер всех карточек без видимой причины.

**Предел масштаба вычисляется, а не задаётся.** Приближать имеет смысл до
момента, когда в кадре остаётся столько узлов, что размер уже упёрся в потолок;
дальше прокрутка уходит в пустое поле с одной картинкой. Этот момент зависит от
плотности конкретной раскладки, поэтому предел считается как
`(потолок / доля) × √плотность` с запасом `GRAPH_ZOOM_HEADROOM` на возможность
рассмотреть отдельную карточку, и не опускается ниже `GRAPH_MAX_ZOOM_FLOOR`.
Пересчёт — при остановке движка.

**Возврат фокуса не перестраивает раскладку.** Приложение обновляет хранилище,
когда окно снова получает фокус, и граф получает равный снимок новым объектом.

Ограничить этим зависимости эффекта, устанавливающего силы, недостаточно:
Canvas перезапускает симуляцию **всякий раз, когда ему передают новый массив
узлов**, независимо от того, что делает наш эффект. Поэтому от состава снимка
зависит и сам массив: пока маршрут, связи, идентификаторы и подписи узлов те
же, `graphData` не пересобирается, и Canvas получает тот же объект. Иначе
каждое переключение окна давало заметный рывок.

**Перетаскивание разогревает симуляцию.** У осевшего графа силы почти не
действуют, поэтому потянутый узел уходил один: соседи оставались на месте, а
связи растягивались через весь экран. `onNodeDrag` вызывает
`d3ReheatSimulation`, и связанные карточки следуют за узлом.

**Потолок — 100 логических пикселей.** Он выведен из раскладки, а не выбран.
Коллизия удерживает центры карточек не ближе `2 × CARD_COLLISION_RADIUS` = 44
единиц графа, что на экране даёт `44 × zoom` пикселей; на масштабе, где
карточка достигла бы 120, соседи стоят ровно вплотную. 100 оставляет пятую
часть размера на воздух.

**Порог считается по факту, а не по константе.** Коллизия — мягкая сила
(`strength 0.75`), поэтому часть пар в реальной раскладке стоит ближе
номинальных 44 единиц. Ограничение роста обязано опираться на фактическое
минимальное расстояние между соседями в текущей раскладке — один проход по
узлам, — иначе на плотных участках картинки наложатся раньше расчётного
потолка.

**Размер обязан иметь один источник.** Сегодня `CARD_THUMBNAIL_SIZE` читают
четыре независимых места: отрисовка (`src/components/graph/canvas.ts`), область
попадания курсора и позиция меню карточки (`src/components/GraphView.tsx`),
позиция предпросмотра (`src/components/graph/interaction.ts`). Пока размер был
постоянным, расхождение было невозможно; с переменным размером любое
разъехавшееся место означает курсор, попадающий не туда, куда смотрит глаз.
Свести к одному источнику — предусловие работы, а не её часть.

**Отвергнуто: заморозка расхождения.** Рассматривался вариант, где после
порогового масштаба камера перестаёт масштабировать, а зум переключается на
рост картинок. Отклонено по двум причинам: он требует перехватывать жест и
возвращать камеру на место, то есть бороться с собственным обработчиком зума —
это тот самый механизм, который уже дважды порождал рывки в графе; и один жест
менял бы смысл на середине хода, в обе стороны. Возврат к варианту возможен
после того, как насыщение поработает.

**Связь с миниатюрами.** Потолок 100 логических пикселей означает 200
физических на удвоенной плотности, поэтому графу нужен уровень `zoom` (256 px)
для узлов в кадре и `micro` (64 px) для обзора — см. SPEC_THUMBNAILS.md,
раздел «Уровни миниатюр».

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

Canvas-native collection labels still follow the design-system
`GraphCollectionLabel` contract from `src/components/GraphCollectionLabel.tsx`
and `src/components/ui/badge.tsx`. Runtime canvas paint resolves the same tokens:
`border-border`, `bg-chrome`, `text-muted-foreground`, `rounded-pill`, `h-7`,
`px-3`, `font-sans`, `text-base`, `font-normal`, hover text
`text-foreground`, hover outline `outline-component-fill-hover`.

Rules:

- avoid category rainbow as the default visual language;
- use muted fills and ring/border strokes;
- hovered card nodes do not change stroke, opacity, label visibility, size, or
  link styling;
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
| `collection` | canvas-native capsule matching `GraphCollectionLabel` | always visible |
| `card` | sidebar micro thumbnail: screen-fixed square `32 / globalScale`, no rounding, no stroke | search match or keyboard/pointer selection |

Card thumbnails use cover crop, clipped into the square. Collection hit areas
must match the capsule bounds closely enough that click/drag begin on the
visible pill, not on a hidden circle.

### Labels

Labels:

- collection labels: always visible as canvas-native `GraphCollectionLabel`
  equivalents;
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
- invert text-preview thumbnails in dark theme so article/text previews remain
  legible on the dark canvas.

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

Card hover opens a sidebar-compatible preview. It must use the same timing
contract as Sidebar thumbnail hover:

- cold open delay: `HOVER_PREVIEW_COLD_OPEN_DELAY_MS = 500`;
- warm open delay: `HOVER_PREVIEW_WARM_OPEN_DELAY_MS = 0`;
- warm window: `HOVER_PREVIEW_WARM_WINDOW_MS = 800`.

Rules:

- do not dim nodes or links;
- do not change card size, opacity, border, outline, label visibility, or link
  color on hover;
- after the configured delay, fetch the full block with `get_block`;
- render `ReadOnlyCardPreview` with `previewMode="micro"` and width `240`;
  its `CardFrame` keeps the same `bg-card` surface as feed cards and sidebar
  hover previews;
- position the preview from `graph2ScreenCoords(node.x, node.y)`, clamped to the
  viewport with the same gap/margin model as Sidebar;
- close immediately on pointer leave;
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

The point menu must install a transparent dismiss layer below
`DropdownMenuContent` and above the graph canvas. The first click or context
click outside the dropdown closes the menu only; it must not reach the canvas,
open another card, navigate a collection, or replace the frozen hover preview.

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

The common Settings window owns the persisted `Collections`, `Wikilinks`, and
`Related notes` switches under a dedicated `Graph` section. Defaults are `true`.
Settings writes one versionless local preference object and emits the existing
`settings-changed` event; the main window re-reads it and passes one immutable
preference value into Graph View. The Canvas does not read or persist settings.

`Show all` remains a contextual action, shown only for a truncated library
snapshot with `can_materialize_full = true`. It is session-local and resets when
Graph View remounts; it is not a general preference.

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

Canvas is not inherently accessible. Graph View must provide a parallel keyboard
model:

- `Tab` reaches `Show all` when present, otherwise the canvas.
- Arrow keys move selection among currently visible graph nodes using screen
  coordinates after layout has settled.
- `Enter` activates the selected node.
- `Escape` clears the selected node before closing higher-level UI.
- A textual status region announces selected node label and neighbor count.

Keyboard and pointer navigation share one selected node id. The implemented
`aria-live` status announces the selected label and neighbor count.

## Tests

### Rust

- `build_graph_snapshot` returns collection nodes and membership edges from
  `Mine Collections` / `block_tags`.
- Wikilinks become directed block edges.
- Missing wikilink and related-note targets are omitted together with their
  edges.
- Media embeds are absent from `wikilinks` after runtime indexing and
  graph-link-index backfill.
- Related-note block references resolve by base slug while preserving fragments
  outside graph identity.
- Duplicate links increment `count`.
- `current_route` scope includes collection members and 1-hop related neighbors.
- Large vault thresholds set `truncated` and exact `visible_nodes`.
- Renamed blocks do not leave stale edge targets after reindex.

### Frontend Unit

- card node paint uses a screen-fixed 32px square with no corner radius.
- card hover uses `getHoverPreviewOpenDelay` from shared sidebar timing.
- card hover open/close does not change node opacity, link color, card size, or
  card labels.
- Graph View renders no graph-local search, scope selector, or settings trigger.
- persisted graph preferences are forwarded unchanged to the graph snapshot
  request and a settings change reloads the projection.
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
  does not visually mutate the graph canvas.
- Large snapshot does not create thousands of image requests.
- Mobile/narrow window keeps the contextual `Show all` action inside the graph
  viewport when present.

Canvas pixel checks must verify that the graph has non-background pixels after
render and after route switches.

The executable acceptance is `bun run test:graph` against the dev-only
`/__graph-audit` route. It runs both dark and light themes and verifies settled
first paint, raw Canvas pixels, automatic route switching, resize without
remount, absence of removed Graph controls, bounded image requests, real delayed
hover without Canvas mutation, and pan/zoom timing.

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
- Keyboard selection and pointer selection share one selected node id.

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
