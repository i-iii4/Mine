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

- разрешены только локальные `mp4`, `m4v`, `mov`, `webm`
- `m4v` и `mov` — mp4-family контейнеры (mov = QuickTime, играет нативно в
  WKWebView), поэтому маппятся на `container: "mp4"` в дескрипторе; playback
  резолвит реальное расширение `source_path`
- remote video URLs и multi-media cases => `feed_playback = null`
- single-video clips делятся на два autoplay profile:
  - `standard`
  - `heavy`
- single-video clip получает `feed_playback = null` только при выходе за
  пиксельные hard-лимиты (longest side > `5120px` или площадь > `12_000_000`);
  размер файла из дисквалификации исключён — файлы крупнее standard-порога
  получают профиль `heavy` при любом размере

### Autoplay profiles

- `standard`
  - compact single-video clips
  - feed surface использует `direct -> blob -> poster-only`
- `heavy`
  - larger, но всё ещё допустимые single-video clips
  - feed surface использует только `direct -> poster-only`; blob-фолбэк запрещён
    полностью, потому что heavy-файлы крупные (до 512 MiB), а активных heavy
    может быть до двух — буферизация всего файла в памяти дала бы до ~1 GiB
  - любая ошибка direct у heavy => сразу `failed_poster_only`; восстановление
    идёт через memory-free retry (переигрывание с `loading_direct`), не через blob
  - direct-loading не обрывается по короткому таймеру: heavy clip может дождаться
    первого playable frame, пока карточка остаётся active playback candidate

### Policy thresholds v1

- `standard`
  - source bytes `<= 24 MiB`
  - longest side `<= 2560px`
  - pixel area `<= 4_000_000`
- `heavy`
  - всё локально играбельное сверх standard-порогов, в пределах пиксельных и
    байтового hard-лимитов
  - longest side `<= 5120px`
  - pixel area `<= 12_000_000`
  - source bytes `<= 512 MiB` (`FEED_AUTOPLAY_HARD_MAX_SOURCE_BYTES`); heavy
    стримит с диска, поэтому память bounded даже на больших файлах, но байтовый
    потолок нужен, чтобы `<video src>` к dataless multi-gigabyte iCloud-файлу не
    форсил полную загрузку ради проскролла
- above hard limits (пиксельные лимиты или source bytes > 512 MiB) =>
  `feed_playback = null`: клип остаётся poster-only в ленте, играбелен только в
  Detail

Правило выбора профиля: `standard` требует полностью известных габаритов
(`width` и `height` оба заданы) в пределах standard-лимитов. Видео с
неизвлечёнными габаритами (`dims = None` — любой не-MP4 контейнер `mov`/`webm`
или MP4 с нечитаемым заголовком) не декодируется вслепую по standard-цене
(браузер декодирует standard в ленте, а размер кадра мог бы оказаться 4K/8K) и
падает в `heavy` — прямой стрим с диска с bounded memory, а не standard.

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
- `heavy`: direct error / play rejection => `failed_poster_only` напрямую
  (blob-фолбэк запрещён); восстановление — через memory-free retry
- `failed_poster_only` (blob timeout/error у standard или direct-ошибка у heavy)
  не терминален: пока surface смонтирована и `allowPlayback = true`,
  воспроизведение переигрывается с `loading_direct` через
  `FEED_VIDEO_RETRY_DELAY_MS`, максимум `FEED_VIDEO_MAX_RETRIES` раз на маунт;
  после исчерпания — poster-only до сброса `allowPlayback` / `src`
- пустой `<video>` без `src` запрещён

### Timeouts

- `FEED_VIDEO_DIRECT_TIMEOUT_MS = 1200`
- `FEED_VIDEO_BLOB_TIMEOUT_MS = 1800` — покрывает только decode + play: таймер
  стартует с момента получения blob (после `fetch`, перед decode/play), чтобы
  крупный, но валидный клип не был прерван мид-download бюджетом, предназначенным
  для декодирования
- `FEED_VIDEO_FETCH_TIMEOUT_MS = 20000` — отдельный таймаут на сам `fetch` стадии
  `loading_blob` (только standard, у heavy blob-пути нет): по истечении fetch
  abort'ится и фаза уходит в `failed_poster_only`, откуда работает существующий
  retry. Без него зависший fetch пинил бы `loading_blob` бесконечно
- `FEED_VIDEO_RETRY_DELAY_MS = 4000` — задержка перед повторной попыткой из
  `failed_poster_only`
- `FEED_VIDEO_MAX_RETRIES = 2` — число повторов на маунт (сбрасывается при
  сбросе `allowPlayback` / `src`)
- `heavy` direct-loading does not use a short self-timeout
- `heavy` не использует blob-путь вовсе, поэтому blob- и fetch-таймеры к нему
  неприменимы

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
- `FeedVideoSurface` сам рендерит `PlayBadge` во всех фазах с видимым постером
  (`poster`, `loading_direct`, `loading_blob`, `failed_poster_only`) и убирает
  его только над реально играющей поверхностью; разрыв, при котором
  `failed_poster_only` оставался без бейджа, закрыт
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
- `heavy` videos stay conservative: не более `FEED_HEAVY_MAX_ACTIVE` (= 2) `heavy` autoplay video одновременно

### Source of truth

- committed prefix текущего grid generation
- autoplay disabled только в `provisional`; `measuring` не обнуляет already-committed active set
- видимость считается не по strict viewport, а по expanded autoplay window: `viewport ± 50%` его текущей высоты

### Selection rule

- карточка должна быть committed
- карточка должна иметь валидный `feed_playback`
- playback surface карточки должна быть покрыта expanded autoplay window минимум на `50%`
- `standard` cards autoplay'ят все, если проходят visibility threshold
- из `heavy` cards активны до `FEED_HEAVY_MAX_ACTIVE` (= 2):
  - отбор по видимой доле поверхности с детерминированным total tie-break:
    `inViewport` → viewport-доля → window-доля → верхний раньше (меньший `top`) →
    расстояние до центра → `slug`; финальный slug-tie-break делает порядок
    независимым от порядка обхода `visibleItems`
  - гистерезис `FEED_HEAVY_HYSTERESIS_FRACTION` (= 0.1): инкумбент держит слот,
    пока претендент не превосходит его viewport-долю более чем на 0.1, — так
    маргинальное дрожание видимости не выбивает уже играющий clip
  - гистерезис НЕ переносится через границу `inViewport`: инкумбент, ушедший из
    strict viewport, не удерживает слот против претендента, который уже внутри
    viewport, какой бы малой ни была его видимая доля; margin-защита по доле
    работает только когда оба кандидата по одну сторону границы
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
