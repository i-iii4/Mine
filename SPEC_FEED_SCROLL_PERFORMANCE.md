# SPEC: Feed Scroll Performance

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_GRID.md](SPEC_GRID.md) | [SPEC_GRID_LAYOUT_READINESS.md](SPEC_GRID_LAYOUT_READINESS.md) | [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md) | [SPEC_FEED_VIDEO.md](SPEC_FEED_VIDEO.md) | [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

Status: implemented as Phase C7; insufficient alone for the final canvas-feel
target. Phase C8 continues the layout-readiness layer in
[SPEC_GRID_LAYOUT_READINESS.md](SPEC_GRID_LAYOUT_READINESS.md).

## Goal

The main feed must feel like an infinite canvas: scrolling stays physically
smooth and nearby media is already fetched and decoded before it enters the
viewport. The user must not see cards arrive as blank, gray or late-decoding
fragments during fast scrolling.

This is not an overscan tweak. Rendering, layout commitment, image priority and
decoded-media readiness are separate concerns with separate budgets.

## Product Contract

- Fast trackpad scroll must preserve the feeling of continuous visual material.
- A card may be outside the viewport with a stable placeholder, but once it
  becomes inspectable, its preview media should already be ready whenever a
  local preview exists.
- The hot scroll path uses preview/poster/thumbnail assets only. Original source
  media is not part of feed readiness.
- The solution must remain bounded in DOM nodes, image decode concurrency and
  memory pressure.
- The feed must degrade predictably: if preview assets are missing, Grid keeps a
  stable placeholder and schedules preview-pipeline work elsewhere; it does not
  spin on broken URLs or pull heavy originals into fast scroll.

## Problem

Current Grid already has a virtualized masonry renderer, but visual smoothness
can still break down during fast scroll:

- the scroll container moves smoothly while visible media catches up later;
- mounted cards can enter the DOM before their preview image is fetched or
  decoded;
- exact layout commitment and media readiness are visually coupled, so
  skeleton/blank states can appear inside otherwise smooth motion;
- simply increasing overscan mounts more DOM and image elements, but still does
  not make decode timing a first-class system.

The defect is not only "not enough rendered cards"; it is the mismatch between
scroll physics and media readiness.

Phase C7 covers media readiness. If fast-scroll diagnostics show media work is
healthy but the viewport still contains unmeasured skeletons or blank geometry,
the defect belongs to the layout-readiness layer specified in
[SPEC_GRID_LAYOUT_READINESS.md](SPEC_GRID_LAYOUT_READINESS.md).

## Core Principle

**DOM readiness and media readiness must be independent.**

The render window is intentionally smaller than the media preparation window.
Grid should mount enough cards to avoid blank geometry, but should prepare media
farther ahead without adding DOM nodes.

## Architecture Overview

Feed scroll readiness is a pipeline, not a single component-level tweak:

```text
scroll container
  -> scroll visibility runtime
  -> RAF scroll signal sampler
  -> adaptive window calculator
  -> layout-position range query
  -> derived preview candidate resolver
  -> bounded decode queue
  -> browser image decode cache
  -> normal Card render path
```

Each stage has one owner:

| Stage | Owner | Contract |
|---|---|---|
| Scroll visibility runtime | `useGridScroll` | Keep mounted `GridItem`s aligned with the real scrollport; use RAF for normal changes and a bounded sync commit only when the current viewport would otherwise be empty |
| Scroll sampling | Grid hook | Read `scrollTop`, direction and velocity at animation-frame cadence |
| Window calculation | Pure helper | Convert viewport + velocity into render, priority and preload windows |
| Layout range query | Grid | Use existing `layout.positions`; do not query DOM rectangles |
| Candidate extraction | `feedMediaCandidatesForBlock` | Produce only derived preview/poster/thumbnail URLs |
| Decode scheduling | `FeedMediaPreloadQueue` | Decode with bounded concurrency, queue size, timeout and generation cancellation |
| Visual rendering | Existing `Card` path | Render normally; no preload-only DOM nodes |

This keeps the responsibility split inspectable: Grid owns geometry, the
candidate resolver owns media URL policy, and the queue owns backpressure.

## Non-negotiable Invariants

- No scroll handler may perform synchronous filesystem, IPC, database, image
  probing or React state fan-out.
- A scroll handler may perform a bounded synchronous React commit only for the
  anti-blank invariant: when the real viewport no longer intersects any
  currently mounted item. Ordinary scroll remains RAF-coalesced.
- No implementation may make the whole route visible in DOM to make scrolling
  feel smoother.
- No implementation may preload original source media as part of the fast scroll
  path.
- No implementation may duplicate `Card` media URL fallback logic inside the
  preloader.
- Preload completion must never mutate layout, card order, selection state,
  hover ownership or keyboard focus.
- A route/query/vault/layout generation change must make stale preload work
  harmless.
- Debug text must never be visible in the feed. Diagnostics are developer-only.

## Runtime Signals

Grid owns a scroll readiness model derived from the scroll container:

- `scrollTop`
- `viewportHeight`
- `scrollDirection`: `forward`, `backward`, `idle`
- `scrollVelocityPxMs`: exponential moving average of absolute scroll velocity
  in pixels per millisecond
- `isFastScrolling`: `scrollVelocityPxMs >= 2.4` for at least one animation
  frame, with hysteresis to leave fast mode below `1.2`
- `layoutGenerationKey`: current route + width + ordered layout fingerprint

Velocity must be sampled in `requestAnimationFrame`, not on every scroll event.
It is a scheduling signal only; visual layout must remain deterministic.

## Adaptive Windows

Let:

- `vh = viewportHeight`
- `v = scrollVelocityPxMs`
- `clamp(x, min, max)`

### 1. Render Window

The render window decides which `GridItem`s are mounted in DOM.

Target formula:

```ts
renderForwardPx = clamp(Math.max(720, vh * 0.75 + v * 80), 640, 1800)
renderBackwardPx = clamp(Math.max(360, vh * 0.35), 320, 800)
```

`renderForwardPx` and `renderBackwardPx` are mirrored when scrolling backward.

Commit lookahead is block-based because it is a diagnostics/readiness frontier,
not a live-render gate:

```ts
commitLookaheadBlocks = Math.max(48, visibleItemCount * 2)
```

Rationale: render overscan is deliberately small. Grid mounts only the current
viewport plus a short runway, because deep jumps otherwise create large React
mount bursts and long tasks. The wider forward preparation belongs to priority
loading and media preload, not to mounted `GridItem` DOM. Blank geometry is
handled by the anti-blank commit below, not by keeping several screens of cards
mounted.

### Anti-blank Scroll Commit

Velocity-aware runway is not sufficient by itself because native scroll can move
the scrollport before React's next RAF commit. `useGridScroll` therefore owns a
separate anti-blank invariant:

```ts
if (!currentMountedItemsIntersect(realScrollTop, viewportHeight)) {
  flushSync(commitVisibleItemsFor(realScrollTop))
}
```

This path is allowed only when the current viewport would have zero mounted
items. Normal scroll still uses the cheap RAF diff and does not set React state
on every scroll pixel. The sync commit is bounded by the current render window;
it must never expand into whole-route DOM mounting.

`viewportHeight` comes from the real scroll element when available, but the
hook must fall back to Grid's ResizeObserver-measured viewport height. A
transient or test-environment `clientHeight === 0` must not disable the
anti-blank invariant.

### 2. Image Priority Window

The priority window decides which mounted images use eager loading.

Target formula:

```ts
priorityForwardPx = clamp(vh * 3 + v * 350, 3200, 8000)
priorityBackwardPx = clamp(vh * 1.1, 800, 2400)
```

Rationale: eager loading is useful for near-future mounted cards, but it is not
the full media-readiness solution. The decode preloader below prepares farther
ahead without mounting cards.

### 3. Media Preload / Decode Window

The media readiness window prepares preview media ahead of the viewport without
mounting extra `GridItem`s.

Target formula:

```ts
mediaPreloadForwardPx = clamp(vh * 4 + v * 600, 4800, 14000)
mediaPreloadBackwardPx = clamp(vh * 1.5, 1600, 3600)
```

Operational limits:

```ts
MEDIA_PRELOAD_MAX_CONCURRENCY = 4
MEDIA_PRELOAD_CACHE_LIMIT = 400
MEDIA_PRELOAD_QUEUE_LIMIT = 160
MEDIA_PRELOAD_DECODE_TIMEOUT_MS = 3000
```

Rationale: fast flick-scroll needs a wider forward preparation window than slow
reading, but the window still has a hard upper bound. The correct architecture is
adaptive and capped, not a single fixed overscan/preload constant.

## Preview Candidate Ownership

Preview URL extraction must be centralized. The media preloader must not
reimplement a parallel version of `Card` rendering logic.

Expected module boundary:

```ts
// src/lib/feedMediaCandidates.ts
export interface FeedMediaCandidate {
  url: string;
  role: "primary-preview" | "tile-preview" | "poster-preview" | "thumbnail";
  source: "derived";
  width: number | null;
  height: number | null;
}

export function feedMediaCandidatesForBlock(args: {
  block: LightBlock;
  thumbsRootPath: string;
}): FeedMediaCandidate[];
```

Candidate order:

1. `feed_playback.poster_preview_path` for video poster surfaces;
2. `preview_manifest.primary_preview_path`;
3. tile-level `preview_path`;
4. block thumbnail `<slug>.jpg`.

Source media rule:

- The preloader must not schedule original `media_file`, raw inline
  `source_path`, remote URL or `vaultPath` media fallback.
- Existing `Card` fallback behavior may remain for visible correctness, but it
  is not considered feed readiness.
- If no derived preview candidate exists, the preloader records `no-preview`
  for diagnostics and does no work for that block.

This rule protects fast scroll from accidentally reading large originals or
remote resources.

## Preload Scheduler

Expected module boundary:

```ts
// src/lib/feedMediaPreloadQueue.ts
export interface FeedMediaPreloadStats {
  queued: number;
  active: number;
  decoded: number;
  failed: number;
  skippedLru: number;
  skippedNoPreview: number;
  generation: string;
}

export interface FeedMediaPreloadQueue {
  update(input: FeedMediaPreloadInput): FeedMediaPreloadStats;
  reset(generation: string): void;
  dispose(): void;
}
```

Scheduling rules:

- Queue keys are `(generation, url)`.
- A generation changes when route, query, vault, thumbs root or
  `layoutGenerationKey` changes.
- Stale decode work may finish, but its result is ignored if generation changed.
- Active decode count never exceeds `4`.
- Queue length never exceeds `160`; farthest candidates are dropped first.
- Successful URLs go into an LRU set capped at `400`.
- Failed URLs go into a per-generation failed set and are not retried in the
  same generation.
- Candidate priority is sorted by:
  1. direction-aware distance to viewport;
  2. candidate role priority (`primary/poster` before tile before thumbnail);
  3. visual item index for stable ordering.

Decode protocol:

```ts
const image = new Image();
image.decoding = "async";
image.src = candidate.url;
await Promise.race([
  image.decode?.() ?? imageLoadedOrErrored(image),
  timeout(MEDIA_PRELOAD_DECODE_TIMEOUT_MS),
]);
```

Decode failure is not surfaced to the user. It only affects diagnostics and
retry suppression.

## Readiness State Machine

The scheduler tracks URL state per generation:

```text
unknown -> queued -> active -> decoded
                   -> failed
                   -> timed-out
```

Rules:

- `decoded` URLs remain in the LRU until evicted.
- `failed` and `timed-out` URLs are not retried in the same generation.
- `queued` candidates can be dropped when the queue cap is exceeded.
- `active` work is not cancelled through browser APIs; completion is ignored when
  generation no longer matches.
- `no-preview` is a diagnostic skip state, not an error.

This avoids retry storms and prevents async decode completion from becoming a
source of UI mutation.

## Grid Integration

Expected hook boundary:

```ts
// src/hooks/useFeedMediaPreloader.ts
export function useFeedMediaPreloader(args: {
  enabled: boolean;
  blocks: readonly LightBlock[];
  layout: MasonryLayout;
  visibilityIndex: VisibilityIndex;
  scrollTop: number;
  viewportHeight: number;
  scrollDirection: ScrollDirection;
  scrollVelocityPxMs: number;
  generationKey: LayoutGenerationKey;
  thumbsRootPath: string | null;
}): FeedMediaPreloadStats;
```

Grid responsibilities:

- Keep the current virtualized render path as the only DOM owner.
- Compute render items from the render window.
- Compute preload items from the media preload window.
- Pass only derived preview candidates to the preloader.
- Reset preload work on generation changes.
- Keep the preloader disabled until `thumbsRootPath` and `viewportHeight` are
  known.

The hook must not set React state on every scroll pixel. It may store scheduler
state in refs and publish diagnostics at animation-frame cadence only when
values change.

## Fast Scroll Mode

Fast scroll mode is a scheduling policy, not a visual state.

When `isFastScrolling` is true:

- media preload window expands through the adaptive formula;
- no new heavy `feed_playback` candidate should start if it is outside the real
  viewport;
- existing poster surfaces remain stable;
- hover affordances remain passive until real pointer movement resumes pointer
  ownership;
- source-media fallback must not be promoted into preload work.

When scroll velocity drops below the hysteresis threshold, the scheduler returns
to normal window sizes without clearing already decoded LRU entries.

## Tuning Protocol

Window and queue constants are product-critical parameters. They must be changed
through evidence, not taste.

Before changing a constant:

1. Capture baseline diagnostics on a real `Everything` route:
   `mountedGridItems`, render/priority/preload windows, queue length, active
   decode count, decoded/failed/skipped counters.
2. Identify the observed failure mode:
   blank geometry, late preview decode, too much CPU, memory pressure, queue
   churn, or missing preview assets.
3. Change one budget family at a time:
   render window, priority window, media preload window or queue limits.
4. Re-run the same manual scroll pass and compare diagnostics.

Guardrails:

- Increasing render caps is allowed only for blank geometry, not late image
  decode.
- Increasing preload caps is allowed only when queue and decode limits remain
  stable.
- Increasing decode concurrency above `4` requires explicit CPU evidence.
- Missing preview assets must be fixed in the thumbnail/preview pipeline, not by
  loading original source media in the feed.
- Product fixes must preserve bounded DOM and bounded decode work.

## Diagnostics

Development builds must expose lightweight diagnostics without user-facing UI.

Recommended surface:

```ts
window.__MINE_FEED_SCROLL_DEBUG__ = {
  enabled: boolean;
  stats: FeedMediaPreloadStats;
  mountedGridItems: number;
  renderWindowPx: { forward: number; backward: number };
  priorityWindowPx: { forward: number; backward: number };
  preloadWindowPx: { forward: number; backward: number };
  layout?: GridLayoutReadinessDiagnostics;
  viewport?: GridViewportPaintDiagnostics;
};
```

`layout` belongs to C8 layout readiness. `viewport` belongs to the paint-layer
blank detector and compares layout positions with mounted `[data-feed-grid-item]`
DOM wrappers in the active scrollport. If `viewport.blankViewportRisk` is true,
the defect is a virtual-window/commit gap, not a media-preload miss.

Diagnostics may also log compact console lines in development builds. They must
never render visible service text in the app.

The layout/paint layer has an automated browser gate:

```bash
bun run test:feed-scroll
```

It opens the dev-only `/__feed-scroll-audit` route, performs deterministic deep
scroll jumps in Playwright and fails on blank viewport, skeleton-only viewport,
browser asset errors, near-blank screenshot samples, DOM-window inflation,
slow viewport settle, large frame gaps, long tasks or Phase 11 height-drift
budget failures. The route includes text-only and media-heavy synthetic cards
with deterministic local preview assets. It requests the height-drift audit only
after the scroll performance sample is recorded, so diagnostic measurement is
not counted as scroll settle time. This command verifies the Grid
virtual-window/readiness layer and the Card preview paint path. Real-vault
product acceptance remains a separate human-facing check because the synthetic
route intentionally avoids source media and Tauri IPC; the C8.16 `Everything`
check passed at the current product level.

## Acceptance Criteria

Functional:

- Fast scroll through `Everything` shows materially fewer blank/late media
  states.
- DOM node count remains bounded by the render window, not by the media preload
  window.
- Image decode concurrency never exceeds `4`.
- Queue length never exceeds `160`.
- Route switch, search query change, vault switch and layout generation change
  invalidate stale preload work.
- Missing preview assets do not cause repeated decode loops.
- Preloader never schedules original source media.
- Existing keyboard focus, group selection, drag stack, context menu and
  feed-video poster behavior remain unchanged.

Performance:

- Scrolling inside the current render overscan window must not force a React
  re-render unless visible item identity changes.
- Media preloader scheduling must be `requestAnimationFrame`-coalesced.
- No synchronous filesystem or IPC call is allowed in the scroll handler.
- The preloader must not increase route snapshot payload.

Manual:

- On a real `Everything` route, perform rapid trackpad scroll down and up.
- Verify the feed reads as continuous material rather than blank cards that fill
  in after arrival.
- Verify memory and CPU do not grow unbounded during repeated scroll passes.

## Test Plan

- Unit tests for `feedMediaCandidatesForBlock`:
  - candidate order;
  - preview-only rule;
  - video poster candidate;
  - no-preview result.
- Unit tests for adaptive window calculations:
  - slow scroll;
  - fast scroll;
  - minimum and maximum clamps;
  - backward direction mirroring.
- Unit tests for `FeedMediaPreloadQueue`:
  - concurrency cap;
  - queue cap and farthest-drop behavior;
  - LRU skip;
  - failed URL suppression;
  - generation reset.
- Focused Grid tests where practical:
  - preloader receives wider window than visible render;
  - no extra GridItems are mounted for preload-only items.
- Product acceptance on the real `Everything` vault is required because the
  defect is perceptual; it passed after the C8.16 layout-readiness retune.

## Implementation Phases

1. Shared candidate resolver.
2. Adaptive window calculation helpers and tests.
3. Bounded preload queue and tests.
4. Grid hook integration with diagnostics.
5. Retune render/priority windows.
6. Manual acceptance on `Everything`.

## Non-goals

- Do not replace the masonry renderer.
- Do not implement native CSS masonry in this phase.
- Do not remove all visible `Card` fallback behavior in this same change.
- Do not add visible loading spinners, service labels or debug text to the feed.
- Do not solve every mutation refresh cascade in this phase.
