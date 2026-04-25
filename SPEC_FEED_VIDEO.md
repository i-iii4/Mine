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
- embedded article videos autoplay muted + loop with controls; this is Detail-only behavior and does not affect feed autoplay eligibility
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
  - feed surface использует `direct -> poster-only on media/playback error`
  - blob fallback не используется, чтобы не тащить тяжёлый source целиком в память
  - direct-loading не обрывается по короткому таймеру: активным может быть
    только один `heavy` clip, поэтому он может дождаться первого playable
    frame, пока карточка остаётся active playback candidate

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
- mounted `<video>` остаётся визуально прозрачным и ниже poster layer до
  `playing_*`; loading video frame не должен перекрывать poster чёрным
  прямоугольником
- `FeedVideoSurface` принимает optional `posterCandidates`; если они переданы, poster branch использует общий candidate chain вместо single hardcoded poster URL
- `standard`: direct timeout/error => blob fallback
- `heavy`: direct error / play rejection => permanent poster-only; no blob fallback
- blob timeout/error => permanent poster-only
- пустой `<video>` без `src` запрещён

### Timeouts

- `FEED_VIDEO_DIRECT_TIMEOUT_MS = 1200`
- `FEED_VIDEO_BLOB_TIMEOUT_MS = 1800`
- `heavy` direct-loading does not use a short self-timeout

## Poster contract

Single-video feed cards используют единый poster contract независимо от autoplay state.

### Poster candidate order

Poster source резолвится в таком порядке:

1. `feed_playback.poster_preview_path`
2. `preview_manifest.primary_preview_path`
3. tile-level `previewPath` у primary video tile
4. block-level thumb `<slug>.jpg`

### Runtime behavior

- `FeedVideoSurface` и poster-only branches обязаны использовать один и тот же candidate chain
- dedicated `video`, single-video `article` и single-video `social` не имеют отдельных poster source-of-truth
- autoplay ineligible / delayed / disabled card остаётся visual-video-card с постером и `PlayBadge`
- при `img` load failure runtime пробует следующий candidate, а не схлопывается сразу в blank/black card
- inline video tiles не должны полагаться на derived `video-stem.jpg`, если
  backend не создал такой asset; tile UI обязан fallback'иться на block-level
  poster
- если article/social body начинается с local video, а позже содержит images,
  block-level poster и Phase 2 upgrade source выбираются из первого video, а
  не из более поздней картинки

## Remaining architectural direction

Текущий runtime уже закрыл главный frontend split между poster-only и autoplay branches.

- poster availability отделена от autoplay activation на runtime-уровне
- widened autoplay window больше не считается единственным рычагом для video UX
- отсутствие autoplay descriptor по-прежнему **не** означает отсутствие poster surface

Следующий шаг, если останутся сложные edge cases, уже не про новый threshold tweak, а про возможное поднятие текущего frontend poster resolver в явный backend-derived video descriptor. Это future hardening, а не незакрытый базовый contract bug.

## Grid autoplay gating

### Global policy

- multiple `standard` videos may autoplay simultaneously on the grid route
- `heavy` videos stay conservative: максимум один `heavy` autoplay video одновременно

### Source of truth

- committed prefix текущего grid generation
- autoplay disabled только в `provisional`; `measuring` не обнуляет already-committed active set
- видимость считается не по strict viewport, а по expanded autoplay window: `viewport ± 50%` его текущей высоты

### Selection rule

- карточка должна быть committed
- карточка должна иметь валидный `feed_playback`
- playback surface карточки должна быть покрыта expanded autoplay window минимум на `50%`
- `standard` cards autoplay'ят все, если проходят visibility threshold
- из `heavy` cards активна только одна:
  - heavy clip с фактическим viewport overlap имеет приоритет над off-screen clip, который ещё linger'ит внутри expanded autoplay window
  - если несколько heavy clip'ов реально видимы, активна top-most candidate
  - если ни один heavy clip не видим в strict viewport, остаётся top-most candidate внутри expanded autoplay window
- если ни одна не проходит threshold, autoplay не запускается

### Prewarm / linger policy

- autoplay может стартовать до фактического входа playback surface в viewport
- autoplay может продолжаться после фактического выхода playback surface из viewport
- симметричное expanded autoplay window в `50%` высоты экрана даёт poster→video transition заранее и убирает визуальный скачок в момент появления карточки на экране

### Loss of eligibility

- при потере active status за пределами expanded autoplay window autoplay surface unmount’ится
- карточка возвращается к poster-only preview

## Out of scope

- codec-aware backend eligibility beyond container whitelist
- transcoding / re-encoding pipeline
- любые изменения detail playback contract
- live video inside galleries
