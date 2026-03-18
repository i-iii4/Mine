# Performance Audit — 17.03.2026

## Status

| # | Проблема | Статус |
|---|---|---|
| 1 | Card parsing without memoization | FIXED (useMemo) |
| 2 | Full data reload on every mutation | OPEN |
| 3 | memo(Card) ineffective | PARTIALLY FIXED (SocialCard, ArticleCard — done; ImageCard, LinkCard, VideoCard, FileCard — open) |
| 4 | Synchronous thumbnail generation | FIXED (background threads) |
| 5 | resolve_unique_slug N queries | OPEN |

## Render Cycle Analysis

### Scenario: user tags a card

```
addTag IPC → loadData() → setBlocks(new array from Rust)
  → App re-renders
    → activeBlocks memo recalculates (new blocks reference)
    → Sidebar re-renders (orderedTags changed)
      → ALL TagNavItems re-render (not memoized)
    → Grid re-renders (blocks prop changed)
      → visibleBlocks.slice() creates new array
      → columns memo recalculates
      → ALL 80 visible Cards re-render
        → SocialCard/ArticleCard: useMemo skips parsing (block.body unchanged) ✓
        → ImageCard/LinkCard/VideoCard/FileCard: NOT memoized, re-render fully ✗
```

**Total per tag operation: ~160 component renders, 2 Sidebar passes, 80 Card renders**

### Root cause

Rust IPC returns new array reference every time → `setBlocks(new_array)` always triggers cascade. No diff, no stable identity.

## Open Issues (Priority Order)

### HIGH — Render cascade

**H1. Blocks array identity not stable**
- `App.tsx:314`: `listBlocks()` returns new array from Rust even if data unchanged
- Every `loadData()` → `setBlocks()` → full cascade
- Fix: diff blocks before setBlocks, skip if unchanged

**H2. ImageCard, LinkCard, VideoCard, FileCard not memoized**
- `Card.tsx`: 4 components re-render on every parent render
- Fix: wrap in `memo()`

**H3. TagNavItem not memoized**
- `Sidebar.tsx:114-130`: ALL tag items re-render when any count changes
- Fix: wrap in `memo()`

**H4. onNavClick inline function**
- `App.tsx:640`: `onNavClick={() => setSelectedBlock(null)}` — new reference each render
- Breaks Sidebar memoization
- Fix: `useCallback`

### MEDIUM — SQL and IPC

**M1. N+1 tag inserts**
- `index.rs:186-190`: loop `INSERT INTO block_tags` per tag
- Fix: batch INSERT

**M2. N+1 wikilink inserts**
- `index.rs:198-202`: loop `INSERT INTO wikilinks`
- Fix: batch INSERT

**M3. rename_tag/delete_tag read+write every .md file**
- `tags.rs:108-124,145-157`: N filesystem operations
- Fix: update only SQLite, defer .md file writes

**M4. resolve_unique_slug sequential queries**
- `index.rs:231-237`: up to 999 `slug_exists()` calls
- Fix: `SELECT slug FROM blocks WHERE slug LIKE ?` + compute next in Rust

**M5. rebuild_index blocks UI**
- `vault.rs:74-102`: synchronous full_scan on main thread
- Fix: background thread + progress events

### LOW — Optimization

**L1. 300+ vault-refreshed listeners**
- `Card.tsx:96-101,152-160`: each ImageCard/LinkCard registers listener
- Fix: single app-level listener

**L2. No Grid virtualization**
- `Grid.tsx`: all rendered cards stay in DOM
- Fix: react-window (when vault exceeds 500+ blocks)

**L3. Missing index on channels(position, title)**
- `db.rs`: `list_channels()` does full scan
- Fix: composite index

**L4. IntersectionObserver recreated on blocks change**
- `Grid.tsx:101-114`: loadMore dependency on `blocks.length`
- Fix: stable ref

## IPC Payload Estimates (1000 blocks)

| Command | Payload | Frequency |
|---|---|---|
| list_blocks | 900 KB | Every mutation |
| list_tags | 50 KB | Every mutation |
| list_channels | 5 KB | Every mutation |
| search | 900 KB—1.5 MB | On keystroke (debounced) |
| get_block | 2—5 KB | On Detail open |

## Implementation Plan

### Phase 1 — Remove cascade (days)
- [ ] H2: memo() on ImageCard, LinkCard, VideoCard, FileCard
- [ ] H3: memo() on TagNavItem
- [ ] H4: useCallback for onNavClick
- [ ] H1: diff blocks in App before setBlocks

### Phase 2 — SQL optimization (week)
- [ ] M1: batch tag inserts
- [ ] M2: batch wikilink inserts
- [ ] M4: batch resolve_unique_slug

### Phase 3 — Architecture (later)
- [ ] M3: tag operations without .md rewrite
- [ ] M5: async rebuild_index
- [ ] L2: Grid virtualization
