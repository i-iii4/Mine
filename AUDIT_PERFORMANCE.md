# Performance Audit — 17.03.2026

## Critical

### 1. Card parsing without memoization
- **File**: `src/components/Card.tsx:267,342`
- `extractTweetData()` and `stripMarkdown()` called on every render without `useMemo`
- 100 visible cards = 100 parsing operations per re-render
- **Fix**: wrap in `useMemo` keyed to `block.body`

### 2. Full data reload on every mutation
- **File**: `src/App.tsx:312-328`
- Every tag/delete/channel operation calls `loadData()` → 3 IPC calls → entire grid re-renders
- **Fix**: optimistic local state updates, refetch only affected data

### 3. memo(Card) ineffective
- **File**: `src/components/Card.tsx:15,44`
- `Card` wrapped in `memo()` but `CardContent`, `SocialCard`, `ArticleCard` are not
- Inner components re-render and re-parse on every parent render
- **Fix**: memoize sub-components or move parsing to `useMemo`

### 4. Synchronous thumbnail generation in event handler
- **File**: `src-tauri/src/watcher/handler.rs:137-164,245`
- `index_md_file()` and `MediaChanged` handler generate thumbnails synchronously
- Blocks file watcher for 100-500ms per image
- **Fix**: move to background thread with debounce

### 5. resolve_unique_slug N queries
- **File**: `src-tauri/src/storage/index.rs:228-241`
- Loops N times calling `slug_exists()` (one SQL query per iteration)
- **Fix**: single batch query `SELECT slug FROM blocks WHERE slug LIKE ?`

## Moderate

### 6. full_scan: sequential thumbnail generation
- **File**: `src-tauri/src/watcher/handler.rs:74-128`
- 1000 thumbnails processed sequentially in one thread
- **Fix**: use rayon or thread pool for parallel generation

### 7. ReactMarkdown re-parses on navigation
- **File**: `src/components/Detail.tsx:396-436`
- Large articles re-parsed on every Detail open
- **Fix**: ensure body is stable prop, consider lazy loading

### 8. Sidebar re-renders all tags
- **File**: `src/components/Sidebar.tsx:56-154`
- No memoization on tag items
- **Fix**: wrap TagNavItem in memo()

### 9. 300+ vault-refreshed listeners
- **File**: `src/components/Card.tsx:96-101,152-160`
- Every ImageCard and LinkCard registers a global event listener
- **Fix**: single app-level listener

### 10. No Grid virtualization
- **File**: `src/components/Grid.tsx`
- Chunk loading (80 initial + 60 per scroll) but no virtualization
- All rendered cards stay in DOM
- **Fix**: react-window or similar for 500+ cards

### 11. No debounce on handler level
- **File**: `src-tauri/src/watcher/watch.rs:54`
- 100 file events = 100 handle_event calls (debounce only on emit to frontend)
- **Fix**: batch file events before processing

### 12. Dynamic SQL without statement cache
- **File**: `src-tauri/src/storage/index.rs:384-442`
- `search_blocks()` builds SQL dynamically on each call
- **Fix**: cache prepared statements for common filter patterns

## Priority

### Week 1 (removes beach ball)
1. useMemo for extractTweetData/stripMarkdown
2. Memoize SocialCard/ArticleCard
3. Async thumbnail generation in event handler

### Week 2 (scaling)
4. Optimistic updates instead of loadData()
5. Batch resolve_unique_slug
6. Handler-level debounce
