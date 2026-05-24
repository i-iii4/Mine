# SPEC: Grid Layout Readiness

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_GRID.md](SPEC_GRID.md) | [SPEC_FEED_SCROLL_PERFORMANCE.md](SPEC_FEED_SCROLL_PERFORMANCE.md) | [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md)

Status: implemented as Phase C8; synthetic browser acceptance is automated and
real-vault product acceptance on `Everything` passed after the C8.16 retune.

## Goal

The feed must not show white or empty viewport states during fast scroll or
deep scroll jumps just because Grid is still measuring skipped cards above the
current viewport.

C7 solved media readiness: previews can be fetched and decoded ahead of DOM.
C8 solves the adjacent layout-readiness layer: cards in the current viewport
must be measured before prefix catch-up work, and exact-measured viewport cards
must be allowed to render live even when earlier prefix gaps still exist.

This is a bridge toward Phase 11 zero-jank masonry. It does not replace the
masonry renderer and does not remove measurement infrastructure in this phase.

## Problem

Generation-safe masonry introduced a strict contiguous commit prefix:

```text
live cards = blocks[0..committedEndIndex]
everything after that = skeleton-only
```

That was correct for preventing stale-generation clipping bugs, but it produced
a new fast-scroll failure mode. If the user jumps to index 800 while cards
20..799 are still unmeasured, the current viewport can remain skeleton/blank
even if its own cards could be measured immediately. Increasing media preload
cannot fix this: decoded media is useless while Grid refuses to render the live
card.

## Product Contract

- Fast scroll and deep jumps prioritize the current viewport before historical
  prefix catch-up.
- A card can render live when it has an exact height for the current
  `layoutGenerationKey`, even if earlier cards are still provisional.
- The contiguous `committedEndIndex` remains useful diagnostics, but it is no
  longer the only live-render gate.
- Grid must still keep bounded DOM. The solution must not mount the whole route
  to make a jump look smooth.
- The measurement path must remain media-safe: no source-media preload, no
  filesystem or IPC work from scroll handlers, no visible service text.
- Native scroll must not be able to expose an empty viewport while React waits
  for a RAF visibility update. `useGridScroll` may synchronously commit the new
  visible window only when the current viewport has zero mounted items.
- Keyboard focus, marquee selection and feed video autoplay can target only
  live cards, never unmeasured skeletons.
- Diagnostics must be developer-only through `window.__MINE_FEED_SCROLL_DEBUG__`.

## Definitions

| Term | Meaning |
|---|---|
| `layoutGenerationKey` | Route + width bucket + ordered layout fingerprint. Exact heights are valid only inside the current generation. |
| `measuredBlockIds` | Non-contiguous set of block ids with exact height in the current generation. |
| `liveBlockIds` | Frontend render gate derived from `measuredBlockIds`; live `Card` is allowed only for these ids. |
| `committedEndIndex` | Largest contiguous measured prefix. Diagnostic/background frontier, not the sole live gate. |
| `targetCommittedEndIndex` | Background catch-up target derived from visible max index and adaptive lookahead. |
| viewport backlog | Mounted positions that intersect the real viewport and do not yet have exact height. |
| overscan backlog | Mounted positions outside the real viewport but inside the render window and not yet measured. |

## Architecture

The new module boundary is pure and testable:

```ts
// src/lib/gridLayoutReadiness.ts
export function computeCommittedEndIndex(
  blocks: readonly LightBlock[],
  measuredBlockIds: ReadonlySet<number>,
  warmedUp: boolean,
): number;

export function collectViewportFirstMeasurementBatch(input: {
  blocks: readonly LightBlock[];
  positions: readonly MasonryPosition[];
  visibleItems: readonly MasonryPosition[];
  measuredBlockIds: ReadonlySet<number>;
  scrollTop: number;
  viewportHeight: number;
  targetEndIndex: number;
  batchSize: number;
}): LightBlock[];

export function createGridLayoutReadinessDiagnostics(input: ...):
  GridLayoutReadinessDiagnostics;
```

Grid remains the owner of runtime geometry:

1. Build `heightsMap` from generation-aware `heightCache`.
2. Derive `liveBlockIds` from `heightsMap`.
3. Compute `committedEndIndex` from `liveBlockIds` only for diagnostics and
   background catch-up.
4. Build `layout.positions` from current-generation exact heights where known
   and deterministic provisional heights elsewhere.
5. Compute `visibleItems` through the existing visibility index and adaptive C7
   render window.
6. Build a hidden measurement batch through viewport-first scheduling.
7. Render each `GridItem` as live when `liveBlockIds.has(block.id)`; otherwise
   render the existing skeleton/provisional surface.

The `visibleItems` runtime has two update paths:

- ordinary scroll uses a RAF-coalesced diff and updates React only when the
  mounted item set actually changes;
- deep/flick scroll that jumps outside the currently mounted item set uses a
  bounded synchronous commit before paint, so the scrollport cannot display a
  fully empty viewport.

The anti-blank path must use Grid's measured `viewportHeight` from
ResizeObserver as the authoritative fallback when `scrollElement.clientHeight`
is `0` or not ready yet. A zero `clientHeight` must not silently disable
blank-viewport detection.

The hidden measurement pass waits for fonts only. It must not wait for image
load/error events: feed media slots reserve deterministic aspect-ratio
envelopes, and blocking layout readiness on media I/O would recreate the same
blank-viewport failure through a different path.

## Measurement Scheduling

`collectViewportFirstMeasurementBatch` has one bounded batch size and this
strict order:

1. mounted items intersecting the real viewport;
2. mounted overscan items nearest to the viewport;
3. missing prefix/background items up to `targetCommittedEndIndex`;
4. remaining layout positions only if the batch still has room.

This keeps visible readines ahead of historical catch-up without discarding the
generation-safe prefix model entirely.

## Integration With C7

C7 media readiness remains a separate system:

- render/priority/preload windows are still computed from viewport and scroll
  velocity;
- media preload remains preview-only and bounded;
- C8 publishes layout diagnostics into the same
  `window.__MINE_FEED_SCROLL_DEBUG__` object, so real runs can distinguish
  layout backlog from media backlog.

C7 cannot mask C8 failures. If `viewportUnmeasuredCount > 0`, the problem is
layout readiness even when media preload stats look healthy.

## Interaction Contracts

- Arrow-key focus starts from the first visible live card.
- If manual scroll leaves previous keyboard focus outside the viewport, the next
  arrow press resyncs to the first visible live card.
- `Enter` in selection mode and marquee selection target live cards only.
- Feed video autoplay targets live cards only.
- Detail-close focus restore waits until the restored block is live for the
  current generation.
- Unmeasured skeletons remain inert for selection, focus and autoplay.

## Diagnostics

Development builds expose:

```ts
window.__MINE_FEED_SCROLL_DEBUG__ = {
  enabled: boolean;
  layoutGenerationKey: string;
  scrollDirection: "forward" | "backward" | "idle";
  scrollVelocityPxMs: number;
  isFastScrolling: boolean;
  stats: FeedMediaPreloadStats;
  mountedGridItems: number;
  renderWindowPx: { forward: number; backward: number };
  priorityWindowPx: { forward: number; backward: number };
  preloadWindowPx: { forward: number; backward: number };
  layout: {
    layoutGenerationKey: string;
    committedEndIndex: number;
    targetCommittedEndIndex: number;
    maxVisibleIndex: number;
    mountedGridItems: number;
    visibleUnmeasuredCount: number;
    viewportUnmeasuredCount: number;
    measurementBatchSize: number;
    measuredBlockCount: number;
    totalBlockCount: number;
  };
  viewport: {
    checkedAtMs: number;
    layoutGenerationKey: string;
    scrollTop: number;
    viewportHeight: number;
    layoutTotalHeight: number;
    layoutViewportPositionCount: number;
    visibleItemCount: number;
    mountedDomItemCount: number;
    domViewportItemCount: number;
    liveDomViewportItemCount: number;
    skeletonDomViewportItemCount: number;
    scrollBeyondLayout: boolean;
    blankViewportRisk: boolean;
    reason:
      | "ok"
      | "empty-route"
      | "zero-viewport"
      | "no-layout-positions"
      | "no-mounted-dom-in-viewport";
  };
};
```

Diagnostics must never render visible labels in the feed.

`viewport` is the paint-layer diagnostic. It compares `layout.positions` with
the actual mounted `[data-feed-grid-item]` wrappers in the current scrollport.
The fields are interpreted as follows:

- `blankViewportRisk === true` with `reason:
  "no-mounted-dom-in-viewport"` means the layout has cards for the current
  viewport but the virtual DOM window has not mounted any of them yet. This is a
  scroll-window/commit failure, not media decode.
- `layoutViewportPositionCount === 0` means the layout model itself has no
  cards at the current scroll position. That points at layout height, scroll
  range or route data.
- `domViewportItemCount > 0` with `liveDomViewportItemCount === 0` means the
  viewport is occupied by skeleton/provisional items. That points at layout
  readiness.
- `liveDomViewportItemCount > 0` while the user still sees blank media means
  the failure is below Grid layout: media paint, image decode, preview asset, or
  Card rendering.

In development builds Grid may emit `[Mine/Grid] blank viewport risk` only when
`blankViewportRisk` flips for a new scroll signature. This is a factual
diagnostic event, not a user-visible loading state.

## Browser Acceptance Harness

Development builds expose a dedicated route for deterministic scroll
acceptance:

```text
/__feed-scroll-audit
```

This route renders the real `Grid` component with a large synthetic mixed feed:
text cards plus media-heavy article cards backed by deterministic local preview
assets. It uses Tauri asset URL mocks and does not call vault IPC. Its purpose
is narrower and stricter than real-vault QA: prove that the virtual masonry
window, viewport-first measurement, Card paint path and paint diagnostics do not
allow an empty or skeleton-only viewport during aggressive scroll jumps.

The command is:

```bash
bun run test:feed-scroll
```

The test opens the route through Playwright, runs desktop and narrow viewport
profiles, performs deterministic deep scroll jumps, then fails if any sampled
viewport has:

- `viewport.blankViewportRisk === true`;
- zero mounted `[data-feed-grid-item]` elements intersecting the scrollport;
- zero live cards in the scrollport;
- a near-blank screenshot according to the pixel-dominance check;
- mounted `GridItem` count above the DOM budget;
- viewport settle, frame-gap or long-task samples above the scroll budget.

This harness is not a replacement for product acceptance on a real vault. It is
the non-negotiable automated guard for the layout/virtual-window layer.

## Acceptance Criteria

Automated:

- `computeCommittedEndIndex` reports contiguous prefix without hiding the fact
  that later exact islands are measured.
- Measurement scheduling prioritizes current viewport items before missing
  prefix items.
- Diagnostics separately report viewport and overscan unmeasured backlog.
- Paint diagnostics report blank risk when layout has current-viewport
  positions but no mounted DOM item intersects the current viewport.
- The deep-scroll Grid regression must assert that the final viewport diagnostic
  has `blankViewportRisk === false` and `domViewportItemCount > 0`; a console
  warning without a failing assertion is not an accepted regression harness.
- Grid can render a deep-viewport live card when that card has exact height in
  the current generation, even while earlier positions remain provisional.
- `bun run test:feed-scroll` must pass against a running Vite/Tauri dev server;
  it is the browser-level acceptance gate for blank viewport, skeleton-only
  viewport and visually blank screenshot failures.

Real-vault acceptance:

- On real `Everything`, aggressive trackpad scroll down/up should not produce a
  blank or white viewport.
- A deep jump must show current-viewport cards before background prefix
  catch-up completes.
- DOM remains bounded by the render window.
- `window.__MINE_FEED_SCROLL_DEBUG__.layout.viewportUnmeasuredCount` should
  quickly return to `0` after a jump.
- If a blank viewport is still observed, capture
  `window.__MINE_FEED_SCROLL_DEBUG__.viewport` at that moment before applying a
  new performance fix.

## Non-goals

- Do not remove all DOM measurement in this phase. That belongs to Phase 11.
- Do not reintroduce scroll anchoring; previous masonry anchoring created a
  feedback loop.
- Do not solve unrelated IPC payload or mutation cascade problems here.
- Do not increase media preload budgets to hide layout backlog.
