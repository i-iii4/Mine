# Feed Video Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md)

## Goal

Зафиксировать финальный desktop feed-video contract так, чтобы autoplay в ленте больше не зависел от render-time эвристик и не смешивался с preview/layout pipeline.

## Surfaces

### 1. Feed gallery surface

- preview-only
- никогда не монтирует `<video>`
- multi-media cards показывают только preview assets / posters / play badge

### 2. Feed autoplay surface

- узкое исключение поверх preview-first feed
- разрешён только для:
  - dedicated `video` blocks
  - single-video `article` / `social` previews
- источник истины для eligibility — только `feed_playback`

### 3. Detail surface

- full-fidelity playback
- original media, controls, existing `VideoFromBlob` path
- не зависит от feed autoplay contract

### 4. Measurement surface

- никогда не монтирует `<video>`
- использует только preview/layout geometry

## Data contract

### `preview_manifest`

`preview_manifest` остаётся preview/layout source-of-truth:

- `primary_preview_path`
- `kind`
- `tiles`
- `overflow_count`
- preview geometry

`preview_manifest` не несёт autoplay semantics.

### `feed_playback`

Новый nullable internal field в indexed/light block:

```ts
type FeedPlaybackDescriptor = {
  kind: "single_video";
  source_path: string;
  poster_preview_path: string;
  width: number | null;
  height: number | null;
  container: "mp4" | "webm";
  profile: "standard" | "heavy";
};
```

Инварианты:

- `feed_playback != null` => feed autoplay разрешён
- `feed_playback == null` => feed обязан оставаться poster/preview-only
- render layer не принимает autoplay-решений по расширению файла или `preview_manifest`

## Backend derivation

`feed_playback` генерируется в indexer рядом с `preview_manifest`.

### Eligibility matrix v1

- разрешены только локальные `mp4`
- разрешены только локальные `webm`
- `mov`, `m4v`, remote video URLs, multi-media cases => `feed_playback = null`
- single-video clips делятся на два autoplay profile:
  - `standard`
  - `heavy`
- truly excessive single-video clips тоже получают `feed_playback = null`

### Autoplay profiles

- `standard`
  - compact single-video clips
  - feed surface использует `direct -> blob -> poster-only`
- `heavy`
  - larger, но всё ещё допустимые single-video clips
  - feed surface использует longer `direct -> poster-only`
  - blob fallback не используется, чтобы не тащить тяжёлый source целиком в память

### Policy thresholds v1

- `standard`
  - source bytes `<= 10 MiB`
  - longest side `<= 2560px`
  - pixel area `<= 4_000_000`
- `heavy`
  - source bytes `<= 64 MiB`
  - longest side `<= 5120px`
  - pixel area `<= 12_000_000`
- above hard limits => `feed_playback = null`

### Allowed block cases

- dedicated `video` block с локальным `media_file`
- `article` / `social` с `preview_manifest.kind = video_poster` и ровно одним video tile

### Poster requirement

- `poster_preview_path` обязан ссылаться на существующий preview asset
- без thumbnail metadata / poster preview `feed_playback` не создаётся

## Frontend render contract

### `CardLayoutDescriptor.mediaItems`

`mediaItems` остаётся layout-only:

- `sourcePath`
- `previewPath`
- `aspectRatio`
- `isVideo`
- `isVideoPoster`

Autoplay semantics в descriptor не кодируются.

### Gallery invariant

- `GalleryTiles` никогда не монтирует live video
- video tiles рендерятся как preview/poster image + play badge
- fallback к source media допустим только для image tiles, не для video tiles

### Dedicated / single-video cards

- autoplay возможен только через `FeedVideoSurface`
- при `feed_playback == null` карточка показывает poster-only preview
- `PlayBadge` показывается только для poster/preview states и не остаётся поверх уже autoplay-playing surface

## `FeedVideoSurface`

`FeedVideoSurface` — единственная feed autoplay surface.

### State machine

- `poster`
- `loading_direct`
- `playing_direct`
- `loading_blob`
- `playing_blob`
- `failed_poster_only`

### Visual policy

- poster рендерится сразу
- poster остаётся на экране, пока playback не подтверждён через `loadeddata` или `playing`
- `standard`: direct timeout/error => blob fallback
- `heavy`: direct timeout/error => permanent poster-only
- blob timeout/error => permanent poster-only
- пустой `<video>` без `src` запрещён

### Timeouts

- `FEED_VIDEO_DIRECT_TIMEOUT_MS = 1200`
- `FEED_VIDEO_BLOB_TIMEOUT_MS = 1800`
- `FEED_VIDEO_HEAVY_DIRECT_TIMEOUT_MS = 3500`

## Grid autoplay gating

### Global policy

- multiple `standard` videos may autoplay simultaneously on the grid route
- `heavy` videos stay conservative: максимум один `heavy` autoplay video одновременно

### Source of truth

- только committed visible cards текущего grid generation

### Selection rule

- карточка должна быть committed
- карточка должна иметь валидный `feed_playback`
- карточка должна быть видима минимум на `50%`
- `standard` cards autoplay'ят все, если проходят visibility threshold
- из `heavy` cards активна только top-most visible card
- если ни одна не проходит threshold, autoplay не запускается

### Loss of eligibility

- при потере active status autoplay surface unmount’ится
- карточка возвращается к poster-only preview

## Out of scope

- codec-aware backend eligibility beyond container whitelist
- transcoding / re-encoding pipeline
- любые изменения detail playback contract
- live video inside galleries
