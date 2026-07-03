# SPEC: Graph View

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_DISPLAY_MODES.md](SPEC_DISPLAY_MODES.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

## Status

M0 implemented. The technical solution is extracted from the Graph View
implementation in `/Users/i_iii/Проекты/longevity-landscape` and adapted to
Mine's Obsidian-first data model. The first shipped slice includes `card` and
`collection` nodes, collection-membership links from `block_tags`, a backend
`GraphSnapshot`, and a Canvas renderer with thumbnail card nodes and label
collection nodes.

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
- block-to-block wikilinks and related-note provenance in a follow-up slice;
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
current route/search state
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
In M0, card nodes render as small square thumbnails using the same derived
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

### Future Unresolved Nodes

Future `kind = "unresolved"` represents a wikilink target that does not currently
resolve to an indexed block. This mirrors Obsidian red links without making them
editable in v1.

Identity:

```text
unresolved:<target>
```

Unresolved nodes are disabled by default in dense scopes and enabled by a Graph
View toggle. When enabled, they are small muted nodes with visible labels only on
hover/search/zoom.

## Edge Types

```typescript
type GraphEdgeKind = "collection_membership";

interface GraphLink {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
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

### Future Wikilink Edges

Source data:

- `wikilinks.source_id`;
- `wikilinks.target_slug`.

Graph edge:

```text
card:<source_slug> -> card:<target_slug>
```

If the target does not resolve and unresolved nodes are enabled:

```text
card:<source_slug> -> unresolved:<target>
```

`directed = true`, because body wikilinks have a source note and a target note.

### Future Related-Note Edges

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
<kind>|<source>|<target>|<label>
```

If duplicate edges are discovered, increment `count` instead of adding parallel
links. `count > 1` may affect hover tooltip or link opacity later, but v1 keeps
link width stable to avoid visual jumping.

## Graph Snapshot

```typescript
type GraphScopeKind = "current_route" | "library" | "ego";

interface GraphScope {
  kind: GraphScopeKind;
  collection_ref: string | null;
  center_slug: string | null;
  hops: 1 | 2;
}

interface GraphOptions {
  include_collections: boolean;
  include_wikilinks: boolean;
  include_related_notes: boolean;
  include_unresolved: boolean;
  query: string | null;
}

interface GraphSnapshot {
  nodes: GraphNode[];
  links: GraphLink[];
  total_cards: number;
  total_collections: number;
  current_collection: string | null;
}
```

The richer scope/truncation fields from the full target design remain future
work. M0 keeps the payload intentionally small and exact.

### Scope Semantics

`current_route`:

- on Everything: library graph policy below;
- on a collection route: collection node, member blocks, their 1-hop wikilink
  and related-note neighbors, plus neighbor collections for those blocks.

`library`:

- for small vaults, full card + collection graph;
- for large vaults, collection-level graph first, with cards materialized by
  search, current collection, or explicit ego expansion.

`ego`:

- center block plus 1-hop or 2-hop neighbors;
- used when opening graph from Detail or search result.

### Large Vault Policy

Mine targets 10,000+ blocks. A full 10,000-node force simulation is not the
default first paint.

Thresholds:

| Node count | Policy |
|---|---|
| `<= 1000` | Full graph allowed. Labels are progressive. |
| `1001..5000` | Full graph allowed only after explicit user action; no thumbnails; finite cooldown; labels only on zoom/hover/search/selection. |
| `> 5000` | Default library scope is collection-level plus query/ego materialization. Snapshot sets `truncated = true` with a reason. |

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
pub fn graph_snapshot(conn: &Connection, current_collection: Option<&str>)
    -> Result<GraphSnapshot>;
```

### Data Access Rules

- Use SQLite read model only; do not read Markdown files in the IPC hot path.
- Exclude `card_kind = 'channel'` from block nodes.
- Resolve collection identity through `CollectionRef` values in `block_tags`.
- Resolve wikilink targets through the same normalization rules used by the
  indexer in the future wikilink slice.
- Strip `#^block-id` fragments for node resolution in the future related-note
  slice, preserving the full target in diagnostics when useful.
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

These dependencies are part of the M0 implementation.

### Components

```text
src/components/GraphView.tsx
src/lib/commands.ts
src-tauri/src/commands/graph.rs
src-tauri/src/storage/graph.rs
```

`GraphView` owns Canvas rendering, physics, image cache, sidebar-style hover
preview, and existing Detail/collection navigation for M0.

Future `GraphWithControls` owns:

- scope controls;
- edge-type toggles;
- local graph search;
- empty/truncated states;
- Detail integration;
- selected node sync.

### Renderer

Use `react-force-graph-2d` with custom Canvas drawing:

- `nodeCanvasObject` draws all nodes.
- `nodePointerAreaPaint` defines hit areas for pill collection nodes and any
  non-circular shapes.
- `nodeLabel={() => ""}` disables browser tooltips; graph uses labels on canvas
  instead.
- `linkWidth` remains stable (`1`) to avoid hover-induced layout noise.
- `linkColor` stays stable during hover; M0 hover must not recolor or dim the
  graph.
- `linkDirectionalArrowLength={0}` because M0 collection-membership links are
  visually undirected.

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
  `text-foreground`;
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
- unresolved nodes use muted low-contrast styling;
- search highlights use the same semantic color family as search marks where
  possible, but not the yellow text highlight itself on nodes.

### Node Shapes

| Kind | Shape | Label |
|---|---|---|
| `collection` | canvas-native capsule matching `GraphCollectionLabel` | always visible |
| `card` | sidebar micro thumbnail: screen-fixed square `32 / globalScale`, no rounding, no stroke | none in M0 |
| `unresolved` | small muted circle | hover/search/zoom |

Card thumbnails use cover crop, clipped into the square. Collection hit areas
must match the capsule bounds closely enough that click/drag begin on the
visible pill, not on a hidden circle.

### Labels

Labels:

- collection labels: always visible as canvas-native `GraphCollectionLabel`
  equivalents;
- card labels: not rendered in M0; the hover preview carries card title/text;
- no graph-local label backgrounds, custom rgba fills, custom radii, custom
  typography or custom paddings outside the design-system label contract;
- collection labels preserve at least `2px` visual gap through the canvas/d3
  rectangular collision force.

### Image Use

M0 draws derived Mine thumbnails for every card node by default.

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
- position the preview from `graph2ScreenCoords(node.x, node.y)`, clamped to the
  viewport with the same gap/margin model as Sidebar;
- close immediately on pointer leave;
- collection hover has no preview in M0.

### Click

Block node click:

1. open existing Detail for `slug`;
2. close any open hover preview.

Collection node click:

1. switch current route to that collection;
2. keep Graph View active;
3. request a new `current_route` graph snapshot.

Unresolved node click:

- no action in v1;
- future action may create a note, but that requires its own spec.

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

### Search

Graph search is local to the loaded graph snapshot unless the current scope is
too truncated to answer locally.

Input rules mirror recent Search Overlay lessons:

- one normalized alphanumeric character is pending, not "no results";
- no IPC for local dimming when a snapshot is already loaded;
- for large truncated library graphs, query can request a backend materialized
  graph subset;
- labels show for matched nodes;
- non-matches dim to `0.15` alpha.

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

- M0 exposes Graph through the existing bottom action bar; when the bottom bar is
  hidden, the same toggle appears in the top chrome fallback area.
- Future display-mode work can move this into Settings -> Appearance -> Layout
  when the broader layout-mode system exists.
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

- `Tab` reaches graph controls before the canvas.
- Arrow keys move selection among currently visible graph nodes using screen
  coordinates after layout has settled.
- `Enter` activates the selected node.
- `Escape` clears graph search or selected node before closing higher-level UI.
- A textual status region announces selected node label and neighbor count.

This can be implemented incrementally, but Graph View is not considered complete
until keyboard selection and screen-reader status exist.

## Tests

### Rust

- `build_graph_snapshot` returns collection nodes and membership edges from
  `Mine Collections` / `block_tags`.
- Wikilinks become directed block edges.
- Unresolved wikilinks are omitted by default and included when requested.
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
- search pending state for one-character query does not show "No results".
- collection node hit-area metrics match pill width/height.
- graph hover preview uses `ReadOnlyCardPreview` with `previewMode="micro"` and
  width `240`.

### Browser Acceptance

Use Playwright for real Canvas verification:

- Graph View first paint is nonblank in dark and light themes.
- Resizing Sidebar/Detail changes canvas dimensions without remounting.
- Hovering a card for the cold delay shows the sidebar-style micro preview and
  does not visually mutate the graph canvas.
- Large snapshot does not create thousands of image requests.
- Mobile/narrow window does not overlap controls with the graph canvas.

Canvas pixel checks must verify that the graph has non-background pixels after
render and after route switches.

## Implementation Slices

1. **Graph spec and docs** — this file, architecture links, plan entry.
2. **Dependencies and frontend types** — add `react-force-graph-2d`, `d3-force`,
   `@types/d3-force`; add TS/Rust graph DTOs.
3. **Backend snapshot** — `storage::graph`, `commands::graph`, tests for
   collection/wikilink/related-note edges.
4. **Canvas renderer** — `GraphView`, ResizeObserver, physics, custom node
   paint, hit areas, sidebar-style hover preview.
5. **Controls and Detail integration** — scope toggles, edge toggles, search,
   selected-node sync, conditional centering.
6. **Display mode wiring** — Settings layout option, route preservation,
   refresh events.
7. **Performance and accessibility** — large vault policy, keyboard navigation,
   Playwright canvas acceptance.

Each slice must land with tests appropriate to its risk. Do not merge a visual
Graph View implementation based only on unit tests; Canvas must be verified in a
real browser/WebView-like environment.
