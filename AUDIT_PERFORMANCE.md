# Performance Audit — 16.04.2026

## Status

| # | Проблема | Статус |
|---|---|---|
| 1 | Блокирующий startup: `select_vault` / `get_vault_path` ждали `full_scan()` | FIXED (snapshot-first open + background sync) |
| 2 | Переключение vault через `window.location.reload()` | FIXED |
| 3 | `list_channel_previews` делал полный `list_blocks_light()` + O(tags * blocks) фильтрацию | FIXED (SQL top-N previews + thumb metadata в SQLite) |
| 4 | Full data reload on every mutation | OPEN |
| 5 | `resolve_unique_slug` N queries | OPEN |
| 6 | Grid virtualization absent on desktop path | FIXED (custom windowed masonry) |
| 7 | Стартовый grid payload слишком тяжёлый (`body`, tags, media metadata на весь corpus) | PARTIALLY FIXED (route-scoped `list_grid_blocks`, no per-block tags) |
| 8 | `list_pending_thumb_upgrades()` делал file peek'и из IPC на UI thread | FIXED (SQLite planner + `spawn_blocking`) |
| 9 | Watcher и background `full_scan()` одновременно переиндексировали vault и ловили SQLite lock storm | FIXED (watcher suppressed while sync is active) |

## Latest wins

### 16.04.2026 — startup / vault switch / sidebar previews

- `commands/vault.rs`: открытие vault разделено на две фазы. SQLite + watcher + последний индексированный snapshot доступны сразу; `full_scan()` уходит в отдельный поток и репортит `vault-sync-started` / `vault-sync-finished`.
- `App.tsx`: смена vault больше не делает `window.location.reload()`. Компонент remount'ится по `vaultPath`, а stale async-ответы старого vault отфильтровываются через `vaultPathRef + requestId`.
- `commands/channels.rs` + `storage/index.rs`: sidebar previews теперь строятся через SQL top-N previews (`__all__` + `ROW_NUMBER() OVER (PARTITION BY tag)`), без полного `list_blocks_light()` и без O(tags * blocks) фильтрации в Rust.
- `storage/db.rs` + `storage/index.rs` + `watcher/handler.rs` + `commands/thumbnails.rs`: `blocks` хранит `thumb_format` / `thumb_mtime`; эти поля обновляются в точках записи thumb и позволяют `list_channel_previews` отвечать без `exists/open/metadata` на каждый preview.
- `commands/blocks.rs` + `storage/index.rs` + `App.tsx`: grid перешёл на `list_grid_blocks(current_tag)` — backend сразу отдаёт только текущий маршрут, убирает channel-документы из snapshot и больше не тащит per-block `tags`.
- `Grid.tsx`: первый paint больше не ждёт measurement всех карточек; hidden measurement идёт батчами, а layout уточняется поверх уже видимого контента.
- `cardLayout.ts` + `Card.tsx` + `cardHeight.ts`: начат переход на единый geometry contract. Variant карточки, preview text и media aspect ratio теперь вычисляются через общий descriptor и используются одновременно рендером и height calculation.
- `list_grid_blocks` стал paged: первый экран получает page window, а следующие блоки дозагружаются по мере приближения к хвосту visible range. Это снимает линейный payload на `Everything`.

### 17.04.2026 — startup thumb planner + legacy thumb metadata

- `commands/thumbnails.rs` + `storage/index.rs`: `list_pending_thumb_upgrades()` больше не читает thumbs с диска из IPC. Phase 2 planner переведён на `spawn_blocking`, открывает отдельный SQLite connection и выбирает только `thumb_format = 'png'` через `PendingThumbUpgradeBlock`.
- `commands/vault.rs` + `storage/index.rs`: при `open_vault()` запускается фоновый backfill `thumb_format/thumb_mtime` для legacy vault'ов, где `.jpg` уже есть в `.arena/cache/thumbs`, но metadata в БД ещё пустые. После backfill отправляется `vault-changed`, чтобы sidebar previews перечитались автоматически.
- Практический эффект на реальном vault `Mine`: beachball исчез, а левое меню начало подтягивать уже существующие preview cards без полного rebuild index.

### 17.04.2026 — watcher / sync contention + route cache polish

- `watcher/watch.rs` + `commands/state.rs`: notify-watcher теперь пропускает события для vault, который уже находится в `syncing_vaults`. Это убрало реальную гонку `watcher + full_scan`, из-за которой early startup ловил пачки `database is locked` и терял отзывчивость до завершения фоновой синхронизации.
- `watcher/handler.rs`: `handle_event` и `index_md_file` теперь возвращают `bool changed`, а `watcher` шлёт `vault-changed` только когда операция реально изменила индекс/thumbnail state. Это срезает лишние refresh циклы на пустых и служебных событиях.
- `App.tsx`: route switch использует per-route `GridSnapshot` cache и на чистой навигации больше не рефетчит `list_tags` / `list_channels`. Дополнительно убран дублирующий стартовый `list_grid_blocks`, который раньше повторно запускался после `setTags/setChannels` из-за новой identity `loadData`.
- Практический эффект: startup на реальном `Mine` перестал деградировать в lock storm, а повторные переходы между уже посещёнными каналами стали мгновенными без лишнего IPC.

### 18.04.2026 — generation-safe masonry height correctness rewrite

- `src/lib/layoutGeneration.ts` + `src/lib/heightCache.ts` + `src/lib/layoutCache.ts`: введён `layoutGenerationKey`, который учитывает route, width bucket и layout-relevant fingerprint блока, включая `preview_manifest`. Exact heights и exact layouts теперь кэшируются generation-aware, а не по слабому `(slug, bucket)` identity.
- `src/components/Grid.tsx`: visible render path больше не использует stale generation. Layout всегда строится только для current generation, live cards разрешены только внутри contiguous `committed` prefix, а остальная лента остаётся skeleton-only до exact measurement.
- Measurement scheduling теперь идёт по contiguous prefix `0..targetCommittedEndIndex`, а не по разрозненным видимым блокам. Это устраняет смешивание stale envelope и current live card — корневую причину системной bottom clipping / white-tail underflow.
- Практический эффект на реальном `Mine`: пользователь подтвердил, что высота карточек отображается корректно; системная обрезка низа и пустые хвосты больше не воспроизводятся.

Эти изменения устранили два самых тяжёлых path'а первого экрана:
- полный reindex перед открытием UI;
- полный проход по всем блокам ради sidebar previews.

Не устранено:
- duplicate window problem при повторном `cargo tauri dev`: в desktop app пока нет single-instance guard, поэтому повторный запуск может открыть второе окно вместо фокуса существующего

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

**H5. Grid snapshot всё ещё тяжёлый для `Everything`**
- `list_grid_blocks(current_tag)` уже убрал per-block tags, channel docs и пустой body у non-article блоков
- Но на маршруте `Everything` frontend всё ещё получает весь corpus одним IPC snapshot при cache miss
- `first_image`, `media_urls`, `media_dimensions` всё ещё прилетают заранее для всех карточек
- Fix: порционная догрузка grid snapshot по viewport / page window или ещё более лёгкий first-screen DTO

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

### LOW — Optimization

**L1. 300+ vault-refreshed listeners**
- `Card.tsx:96-101,152-160`: each ImageCard/LinkCard registers listener
- Fix: single app-level listener

**L2. Grid virtualization**
- Status: FIXED
- `Grid.tsx` now renders only visible cards + overscan via a custom masonry layout engine and absolute positioning

**L3. Missing index on channels(position, title)**
- `db.rs`: `list_channels()` does full scan
- Fix: composite index

**L4. IntersectionObserver recreated on blocks change**
- `Grid.tsx:101-114`: loadMore dependency on `blocks.length`
- Fix: stable ref

## IPC Payload Estimates (1000 blocks)

| Command | Payload | Frequency |
|---|---|---|
| list_grid_blocks(all) | 900 KB | Every mutation |
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
- [x] Startup snapshot + background sync
- [x] Vault switch without reload
- [x] SQL top-N previews
- [~] H5: split GridBlock / BlockDetail payload
- [x] M5: thumb metadata in SQLite
- [x] Startup planner на SQLite + `spawn_blocking`
- [x] L2: Grid virtualization
