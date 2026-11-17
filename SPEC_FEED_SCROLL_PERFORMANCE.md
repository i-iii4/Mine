# SPEC: Feed Scroll Performance

**Состояние:** частично: Phase C7 реализована, правка картинок ленты идёт строкой 51.1. Источник: строка «Status» ниже; PLAN.md, Phase C7 и строка 51.1. **Сверка с кодом:** 15.11.2026, существование названных файлов.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_GRID.md](SPEC_GRID.md) | [SPEC_GRID_LAYOUT_READINESS.md](SPEC_GRID_LAYOUT_READINESS.md) | [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md) | [SPEC_FEED_VIDEO.md](SPEC_FEED_VIDEO.md) | [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

Status: implemented as Phase C7; insufficient alone for the final canvas-feel
target. Phase C8 continues the layout-readiness layer in
[SPEC_GRID_LAYOUT_READINESS.md](SPEC_GRID_LAYOUT_READINESS.md). С 15.11.2026
картинки ленты готовятся по разделу «Подготовка картинки карточки»:
отдельный предзагрузчик картинок снят по
[AUDIT_FEED_IMAGES.md](AUDIT_FEED_IMAGES.md).

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
- Картинка карточки это её превью: лента запрашивает только превью, оригинал
  не запрашивает.
- The solution must remain bounded in DOM nodes and memory pressure: a picture
  is loaded and decoded only for a mounted card.
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

**Картинка карточки готовится сразу после монтирования карточки.**

Отдельной загрузки и декодирования картинок вне карточек нет. Лента
запрашивает каждую картинку один раз за проход. Окно отрисовки решает, какие
карточки смонтированы; картинка смонтированной карточки загружается и
декодируется сразу, не дожидаясь входа карточки в видимую область (раздел
«Подготовка картинки карточки»).

## Architecture Overview

Feed scroll readiness is a pipeline, not a single component-level tweak:

```text
scroll container
  -> scroll visibility runtime
  -> RAF scroll signal sampler
  -> adaptive window calculator
  -> layout-position range query
  -> normal Card render path
  -> picture preparation of every mounted card
```

Each stage has one owner:

| Stage | Owner | Contract |
|---|---|---|
| Scroll visibility runtime | `useGridScroll` | Keep mounted `GridItem`s aligned with the real scrollport; use RAF for normal changes and a bounded sync commit only when the current viewport would otherwise be empty |
| Scroll sampling | Grid hook | Read `scrollTop`, direction and velocity at animation-frame cadence |
| Window calculation | Pure helper | Convert viewport + velocity into render and priority windows |
| Layout range query | Grid | Use existing `layout.positions`; do not query DOM rectangles |
| Visual rendering | Existing `Card` path | Render normally; the card owns its picture addresses and their fallback |
| Picture preparation | `usePreparedPicture` in the card's `<img>` | Ask the engine to decode the picture of a mounted card at once |

This keeps the responsibility split inspectable: Grid owns geometry, the card
owns its pictures.

## Non-negotiable Invariants

- No scroll handler may perform synchronous filesystem, IPC, database, image
  probing or React state fan-out.
- A scroll handler may perform a bounded synchronous React commit only for the
  anti-blank invariant: when the real viewport no longer intersects any
  currently mounted item. Ordinary scroll remains RAF-coalesced.
- No implementation may make the whole route visible in DOM to make scrolling
  feel smoother.
- No implementation may load original source media as part of the fast scroll
  path.
- No implementation may load or decode a picture outside the card that shows
  it: a second request for the same address is a defect
  (`bun run test:feed-images`).
- Picture preparation must never mutate layout, card order, selection state,
  hover ownership or keyboard focus.
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
renderForwardPx = clamp(Math.max(720, vh * 0.75 + quantizeVelocityContribution(v * 80)), 640, 1800)
renderBackwardPx = clamp(Math.max(360, vh * FEED_RENDER_RUNWAY_BACKWARD_VIEWPORT_RATIO), 320, 800)
```

`renderForwardPx` and `renderBackwardPx` are mirrored when scrolling backward.

Backward runway floor поднят с `vh * 0.35` до
`vh * FEED_RENDER_RUNWAY_BACKWARD_VIEWPORT_RATIO` (`= 0.5`), чтобы держать
linger-контракт: за курсором скролла остаётся не меньше `0.5 * vh` уже
смонтированных карточек, и разворот направления не приземляется на unmounted
(blank) регион. `800px` cap держит backward DOM bounded; при этом floor
`>= 0.5 * vh` выполняется для всех `vh <= 1600` — весь реалистичный desktop-диапазон.

Velocity-вклады (`v * 80` в render, `v * 350` в priority)
квантуются ВВЕРХ шагом `FEED_SCROLL_WINDOW_VELOCITY_QUANTUM_PX` (`= 200`) через
`quantizeVelocityContribution`. Округление вверх (никогда вниз) гарантирует, что
квантованное окно не уже неквантованного, а стабильная identity окна между
соседними кадрами не пересоздаёт `getVisibleItems` и не форсит лишний Grid-ререндер
при неизменном visible set, пока сглаженная velocity дрейфует.

Commit lookahead is block-based because it is a diagnostics/readiness frontier,
not a live-render gate:

```ts
commitLookaheadBlocks = Math.max(48, visibleItemCount * 2)
```

Rationale: render overscan is deliberately small. Grid mounts only the current
viewport plus a short runway, because deep jumps otherwise create large React
mount bursts and long tasks. A wider render window does not make pictures
arrive earlier either: with 1800–4500 px instead of 720–1800 px the share of
late pictures stayed the same (AUDIT_FEED_IMAGES.md, раздел 5.3). Blank geometry is
handled by the anti-blank commit below, not by keeping several screens of cards
mounted.

### Anti-blank Scroll Commit

Velocity-aware runway is not sufficient by itself because native scroll can move
the scrollport before React's next RAF commit. `useGridScroll` therefore owns a
separate anti-blank invariant:

```ts
if (!currentMountedItemsIntersect(realScrollTop, viewportHeight)) {
  flushSync(commitEmergencyViewportFor(realScrollTop))
  requestAnimationFrame(expandToRegularRenderWindow)
}
```

This path is allowed only when the current viewport would have zero mounted
items. Normal scroll still uses the cheap RAF diff and does not set React state
on every scroll pixel. The synchronous stage mounts only the real viewport plus
`128px` on each side. The next animation frame expands to regular adaptive
overscan after the screen is already populated; a deep jump therefore does not
synchronously mount dozens of offscreen cards or whole-route DOM.

`viewportHeight` comes from the real scroll element when available, but the
hook must fall back to Grid's ResizeObserver-measured viewport height. A
transient or test-environment `clientHeight === 0` must not disable the
anti-blank invariant.

### Paged Snapshot Runway

Grid pagination is part of scroll readiness, not a loader-at-the-bottom UX.
The first `200` rows paint immediately, then App warms exactly one additional
page for the active route in the background. Later pages are requested when the
remaining loaded runway reaches:

```ts
Math.max(96, visibleItemCount * 4)
```

Only one pagination request may be in flight. Vault/route generation guards
discard stale responses. This keeps page boundaries outside the visible scroll
path without reverting to an unbounded whole-vault payload.

### Scroll anchor at the feed head

Когда контент над viewport сдвигается (высота карточки уточнилась после preview
upgrade, вставка/удаление блока), Grid держит первую видимую карточку на месте,
пересчитывая `scrollTop` под новые позиции, — чтобы рост/сжатие выше по ленте не
дёргал viewport. Этот scroll-якорь подавляется у самого верха ленты: при
`scrollTop <= TOP_OF_FEED_SCROLL_EPSILON_PX` (`= 0.5px`) вставка блоков в начало
должна ПОКАЗАТЬ новый контент, а не зафиксировать старую первую карточку и спрятать
свежие ряды над viewport. Вдали от верха guard неактивен и якорь работает.

### 2. Image Priority Window

The priority window decides which mounted images use eager loading.

Target formula:

```ts
priorityForwardPx = clamp(vh * 3 + quantizeVelocityContribution(v * 350), 3200, 8000)
priorityBackwardPx = clamp(vh * 1.1, 800, 2400)
```

Rationale: the priority window is wider than the render window, so every
mounted picture loads eagerly. Eager loading starts the request; decoding is
the business of the next section.

## Подготовка картинки карточки

Картинка карточки готовится сразу после монтирования её элемента `<img>`:
карточка вызывает стандартный `HTMLImageElement.decode()`
(`src/hooks/usePreparedPicture.ts`). Движок загружает и декодирует картинку
вне главного потока и держит её готовой к первому рисованию.

Зачем. WebKit рисует слой карточки в первый раз у самого края видимой области
и в этом первом рисовании декодирует картинку, которую ещё не рисовал,
асинхронно: слой выходит без картинки и перерисовывается после декодирования.
Картинка, декодированная заранее, попадает в первое рисование. Причины и
замеры: [AUDIT_FEED_IMAGES.md](AUDIT_FEED_IMAGES.md), разделы 5 и 6.

Правила:

- Готовятся все три вида картинок карточки: превью карточки
  (`PreviewPicture`), плитка (`GalleryTileImage`) и постер видео
  (`FeedVideoPoster`). Все три это `<img>` в слое карточки, и первое рисование
  слоя идёт без каждой из них одинаково.
- Картинка готовится заново, когда тот же элемент получает другой адрес
  (новая версия превью).
- `decode()` загрузку не начинает: картинку с `loading="lazy"` движок
  декодирует после того, как сам её загрузит. В ленте таких нет: все
  смонтированные карточки лежат внутри окна приоритета.
- `decoding="async"`, слой композиции карточки, окно отрисовки и окно
  приоритета подготовка не меняет.
- Где метода `decode()` нет, подготовка ничего не делает. Так в jsdom: тесты
  подготовки ставят метод сами (`src/test/pictureDecode.ts`).
- Отказ `decode()` разбирается по состоянию элемента. Элемент убран или
  показывает другой адрес: карточка ушла или картинку заменили, делать нечего.
  Картинка не загрузилась: элемент сам сообщает событием `error` после отказа
  (проверено в WebKit 26.4 и Chromium 148 на отсутствующем файле и на файле не
  картинки), и карточка идёт своим путём повторной загрузки: следующий адрес,
  затем повторы через 250 и 1000 мс. Картинка загрузилась, но не декодируется:
  события `error` элемент не даёт, поэтому карточка отправляет её в тот же путь
  сама. Обрезанный JPEG к этому случаю не относится: оба движка декодируют его
  частично и отказа не дают.

Память. Декодированными держатся только картинки смонтированных карточек:
их число ограничено окном отрисовки.

## Grid Integration

Grid responsibilities:

- Keep the current virtualized render path as the only DOM owner.
- Compute render items from the render window.
- Mark the cards of the priority window, so their pictures load eagerly.
- Publish the diagnostics object (раздел «Diagnostics»).

Grid не загружает и не декодирует картинки сам: это делает карточка.

## Fast Scroll Mode

Fast scroll mode is a scheduling policy, not a visual state.

When `isFastScrolling` is true:

- the render and priority windows expand through the adaptive formulas;
- no new heavy `feed_playback` candidate should start if it is outside the real
  viewport;
- existing poster surfaces remain stable;
- hover affordances remain passive until real pointer movement resumes pointer
  ownership.

When scroll velocity drops below the hysteresis threshold, the windows return
to their normal sizes.

## Tuning Protocol

Window and queue constants are product-critical parameters. They must be changed
through evidence, not taste.

Before changing a constant:

1. Capture baseline diagnostics on a real `Everything` route:
   `mountedGridItems`, render and priority windows; and the numbers of
   `bun run test:feed-images`.
2. Identify the observed failure mode:
   blank geometry, late pictures, too much CPU, memory pressure or missing
   preview assets.
3. Change one budget family at a time: render window or priority window.
4. Re-run the same manual scroll pass and `bun run test:feed-images`, and
   compare.

Guardrails:

- Increasing render caps is allowed only for blank geometry, not late
  pictures: a wider render window does not make a picture arrive earlier
  (AUDIT_FEED_IMAGES.md, раздел 5.3).
- Missing preview assets must be fixed in the thumbnail/preview pipeline, not by
  loading original source media in the feed.
- Product fixes must preserve bounded DOM.

## Diagnostics

Development builds must expose lightweight diagnostics without user-facing UI.

Recommended surface:

```ts
window.__MINE_FEED_SCROLL_DEBUG__ = {
  layoutGenerationKey: string;
  scrollDirection: "forward" | "backward" | "idle";
  scrollVelocityPxMs: number;
  isFastScrolling: boolean;
  mountedGridItems: number;
  renderWindowPx: { forward: number; backward: number };
  priorityWindowPx: { forward: number; backward: number };
  layout?: GridLayoutReadinessDiagnostics;
  viewport?: GridViewportPaintDiagnostics;
  heightDrift?: CardHeightDriftReport;
};
```

Объект создаёт и убирает `Grid`. `layout` belongs to C8 layout readiness.
`viewport` belongs to the paint-layer blank detector and compares layout
positions with mounted `[data-feed-grid-item]` DOM wrappers in the active
scrollport. If `viewport.blankViewportRisk` is true, the defect is a
virtual-window/commit gap, not a late picture.

Diagnostics may also log compact console lines in development builds. They must
never render visible service text in the app.

The layout/paint layer has an automated browser gate:

```bash
bun run test:feed-scroll
```

It builds the `/__feed-scroll-audit` route for production and serves it
itself (since 15.11.2026, as `test:sidebar-strip` and `test:editing-perf`
do): the frames, settle times and long tasks are measured for the React the
app ships. On a dev server's page, React's development build (its checks,
StrictMode's second render of every component, its performance tracks) made
each deep jump several times longer: at 7363 px in the 1440 px window the
first frame after the jump came after 650 to 1500 ms with long tasks of 132
to 148 ms, against at most 57 ms and no long task in production.
`MINE_FEED_SCROLL_AUDIT_URL` still measures a page the caller serves. It
performs deterministic deep
scroll jumps in Playwright and samples the DOM synchronously in the native
scroll handler plus the first following animation frame before any settle wait.
It fails on blank viewport, skeleton-only viewport, browser asset errors,
near-blank screenshot samples, DOM-window inflation, slow viewport settle,
large frame gaps, long tasks or Phase 11 height-drift budget failures. The route
includes text-only and media-heavy synthetic cards
with deterministic local preview assets. It requests the height-drift audit only
after the scroll performance sample is recorded, so diagnostic measurement is
not counted as scroll settle time. This command verifies the Grid
virtual-window/readiness layer and the Card preview paint path. Real-vault
product acceptance remains a separate human-facing check because the synthetic
route intentionally avoids source media and Tauri IPC; the C8.16 `Everything`
check passed at the current product level.

## Проверка картинок при прокрутке

`bun run test:feed-images`: сценарий `scripts/feed-images-audit.mjs`, страница
`src/dev/FeedImagesAuditRoute.tsx`. Проверка входит в `bun run test:browser`.

- **Движок.** WebKit без окна (Playwright), сборка для продакшена, свой сервер.
  Chromium для этой проверки не годится: в нём картинки не опаздывают и при
  коде до 15.11.2026, поэтому `test:feed-scroll` дефекта не видит.
- **Страница.** Настоящий `Grid`, 800 карточек. В каждом десятке шесть
  карточек-картинок пяти форм, две статьи с картинкой, одна статья с плиткой
  из четырёх картинок и одна текстовая карточка. У каждой картинки свой адрес:
  движок хранит картинку по адресу, и лента из нескольких общих картинок
  готовит каждую один раз. Сервер отдаёт под каждым адресом один из шести
  светлых файлов JPEG из `scripts/fixtures/feed-images` (длинная сторона
  640 px, плитка 320 px). Окно 1440×900, плотность 2, тёмная тема: слот без
  картинки отличается от слота с картинкой по яркости.
- **Прокрутка.** События колеса каждые 8 мс без ожидания ответа страницы:
  прокрутку ведёт поток прокрутки движка, как от трекпада. Три сценария:
  «6 px/мс» (4 с с постоянной скоростью), «броски» (три броска с пиком
  14 px/мс и затуханием 450 мс), «с места» (шесть бросков по 0,7 с с пиком
  8 px/мс и паузой 1,8 с).
- **Первая величина.** Доля картинок, которые хотя бы в одном кадре записи
  экрана страницы стояли в видимой области тёмным прямоугольником. Запись
  ведёт Playwright, кадры достаёт `ffmpeg` из его же поставки. Снимки экрана
  не годятся: для снимка WebKit декодирует все картинки сразу и показывает
  ленту, которой на экране не было. В содержимое ленты добавлена линейка,
  которая двоичным узором кодирует позицию прокрутки: по ней каждый кадр
  записи знает, какие слоты картинок в нём видны. В каждом видимом слоте
  берутся девять точек; слот тёмный, если семь из девяти темнее порога
  яркости. Запись даёт 25 кадров в секунду, поэтому доля это оценка снизу.
- **Вторая величина.** Число адресов картинок, которые страница запросила у
  сервера больше одного раза за проход вперёд.
- **Без порога** проверка сообщает число запросов картинок, число кадров
  страницы дольше 25 и 50 мс и нагрузку машины.
- **Когда проверка не судит.** Если линейка читается меньше чем в 90 % кадров
  записи, сценарий измеряется заново, до трёх раз; после третьего раза
  проверка падает с сообщением, что машина слишком нагружена для записи.
  Так было при нагрузке машины 180–300 в аудите.
- **Чего проверка не ловит.** Поведение системного WebKit в приложении,
  настоящий трекпад и экран 120 Гц, время ответа протокола `asset`, постер
  видео (в ленте проверки видео нет).

Пороги выведены из замеров 15.11.2026 (WebKit 26.4, средняя нагрузка машины
за минуту от 3 до 15 на 14 ядрах, одновременно работали другие проверки):

| Сценарий | Порог | С подготовкой картинки | Без подготовки |
|---|---|---|---|
| 6 px/мс | 30 % | 12–25 %, 16 прогонов | 36–44 %, 11 прогонов |
| Броски | 30 % | 10–27 %, 17 прогонов | 32–47 %, 10 прогонов |
| С места | 19 % | 4–13 %, 16 прогонов | 25–35 %, 10 прогонов |

- «Без подготовки» это лента до 15.11.2026 и лента после удаления
  предзагрузчика: доля у них одна.
- Порог стоит посередине между худшим прогоном с подготовкой и лучшим
  прогоном без неё. Проверка падает и на ленте до 15.11.2026, и при потере
  подготовки картинки.
- Сценарий, превысивший порог, измеряется заново, до трёх раз, и падает,
  только если порог превышен во всех трёх. Основание: посторонняя работа на
  машине делает картинки позже, а не раньше. Худшие прогоны с подготовкой шли
  подряд: два соседних прогона дали 20 и 25 % при 6 px/мс и 22 и 23 % в
  бросках при нагрузке 6, два прогона при нагрузке 9–12 дали 18 и 19 % и
  25–27 %. Остальные 12 прогонов дали 12–15 % и 10–21 %.
- В бросках зазор между состояниями узкий: 27 против 32 %. Возврат дефекта
  надёжно ловят сценарии «6 px/мс» и «с места», где зазор 11 и 12 пунктов.
- Адреса, запрошенные дважды: порог 0. С предзагрузчиком их было от 97 до 344
  в каждом из 16 прогонов. Без него в 62 прогонах из 63 их нет, в одном
  прогоне «с места» дважды запрошены 2 адреса из 325; причина не выяснена.
  Поэтому превышение этого порога тоже измеряется заново по тому же правилу.
- Порог 2 % из раздела 11 [AUDIT_FEED_IMAGES.md](AUDIT_FEED_IMAGES.md)
  рассчитан на вариант с анимацией и к этой ленте не относится.

## Проверка роста ленты

`bun run test:feed-growth`: сценарий `scripts/feed-growth-audit.mjs`, страница
`src/dev/FeedGrowthAuditRoute.tsx`. Проверка входит в `bun run test:browser`.
Она закрывает замечание Пр2 [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md):
`test:feed-scroll` держит 720 карточек, загруженных сразу, и роста ленты не
видит.

- **Движки.** WebKit и Chromium без окна (Playwright), сборка для продакшена,
  свой сервер. Окно 1440×1000, плотность 1. Каждый ответ сервера изолирует
  страницу от других источников (`Cross-Origin-Opener-Policy`,
  `Cross-Origin-Embedder-Policy`): без этого WebKit округляет часы страницы
  до миллисекунды.
- **Страница.** Настоящий `Grid` над списком, который сценарий меняет через
  `window.__MINE_FEED_GROWTH_AUDIT__`. В каждых двадцати карточках десять
  картинок со своим файлом, пять сохранённых страниц, три статьи и два поста:
  состав пространств из раздела 2 аудита. Всё, что лента получает кроме
  списка, от рендера к рендеру остаётся тем же, как в приложении: список или
  функция, созданные заново, перерисовывают каждую карточку на странице, и
  это работа страницы проверки, а не ленты (аудит, З2).
- **Как меняется список.** Теми же двумя обновлениями, что в `App.tsx`:
  пришедшая страница дописывается к уже загруженным карточкам, а изменённая
  строка заменяет свою карточку через `reconcileBlocks`. Обновления
  повторены в странице проверки: при правке этих мест `App.tsx` страницу
  проверки нужно поправить вслед.
- **Что измеряется.** Время, которое страница работает без перерыва на одном
  изменении: обновление списка и работа ленты над ним до конца рендера и
  эффектов (`flushSync`). Затем самая долгая непрерывная работа после
  изменения, пока лента не придёт в покой: ширины слов новых карточек
  приходят позже и дают ещё рендеры. Её даёт самое долгое ожидание
  сообщения, которое страница шлёт сама себе. Следующее сообщение уходит
  через четверть миллисекунды после прихода прежнего: без паузы их десятки
  тысяч, каждое это объект, и движок собирает их как мусор посреди
  следующего замера.
- **Сценарии.** Лента держит 6 800 карточек и прокручена туда, где она
  запрашивает следующую страницу (`shouldPrefetchNextFeedPage`): пришедшая
  страница не добавляет карточек на экран, и мерится работа над списком, а
  не рисование новых карточек.
  1. Приходит страница из 200 карточек.
  2. При 7 000 карточек приходит изменённая строка картинки на экране: у
     карточки появилось или пропало превью, её высота меняется.
  3. То же для первой карточки ленты: за ней сдвигаются все карточки её
     колонки.
- **Порог.** 8 мс на изменение и 8 мс на самую долгую работу после него:
  половина кадра 16,7 мс (аудит, раздел 3). Судится медиана девяти замеров.
  Изменение сверх порога измеряется заново, до трёх раз: посторонняя работа
  на машине делает страницу медленнее, а не быстрее.
- **Кадры смены ширины, без порога.** Лента держит 1 000, 3 000 и 7 000
  карточек и стоит у верха. Ширина ленты уменьшается на 8 px в каждом из 40
  кадров. Проверка сообщает медиану и наибольший кадр, число кадров, не
  уложившихся в 16,7 мс, и нагрузку машины. Кадр не уложился, если следующий
  пришёл позже середины между 16,7 мс и следующим кадром, который движок
  может показать после них: 25 мс при собственном кадре движка 16,7 мс
  (WebKit) и 20,8 мс при кадре 8,3 мс (Chromium на экране 120 Гц). Уложившийся
  кадр начинается на несколько миллисекунд раньше или позже такта, поэтому
  граница 16,7 мс считала бы дрожание такта. По этим числам решается пункт 6
  плана аудита (раскладка частями).
- **Чего проверка не ловит.** Системный WebKit в приложении и его кадр на
  экране 120 Гц, чтение страницы из индекса (Л4), передачу ответа команды,
  рисование новых карточек при прокрутке.

Замеры 15.11.2026, медиана девяти замеров, мс работы страницы без перерыва
(в скобках самая долгая работа после изменения):

| Изменение | WebKit до | WebKit после | Chromium до | Chromium после |
|---|---|---|---|---|
| Страница из 200 карточек | 44,1 (9,6) | 3,9 (3,0) | 52,8 (8,1) | 2,7 (2,3) |
| Изменилась карточка на экране | 32,3 (0,7) | 3,5 (1,3) | 44,7 (0,2) | 3,0 (0,9) |
| Изменилась первая карточка | 61,4 (0,8) | 6,6 (2,1) | 62,0 (0,6) | 3,3 (1,2) |

- «До» это лента до кэша при карточке, один прогон при нагрузке машины
  1,8–2,7. В этом прогоне страница проверки ещё передавала ленте списки и
  функции, созданные заново, и карточки на странице перерисовывались при
  каждом изменении: по аудиту это 8–9 мс из числа «до». Аудит своим
  сценарием дал 47–52 мс на дозагрузку и 70–75 мс на изменение карточки.
- «После» это один прогон при нагрузке 2,4–3,0.
- Изменение первой карточки в WebKit стоит вдвое дороже остальных: сдвигаются
  все показанные карточки её колонки, и движок раскладывает страницу внутри
  измеряемого отрезка (лента читает высоту области прокрутки, когда
  удерживает видимую карточку на месте).
- Дозагрузка в WebKit до правки проверки выходила то 4–5 мс, то 9–10 мс в
  разных запусках и в разных попытках одного запуска. Разбор по функциям
  показал те же вызовы с временем в полтора раза больше у каждой функции,
  которая создаёт объекты. Долгий вариант ушёл, когда лента стала создавать
  меньше объектов на изменение, а замер перестал слать сообщения без паузы.
  Вывод: в долгом варианте движок собирал мусор во время измеряемого отрезка.
  Это вывод по косвенным признакам: прямого замера сборщика мусора нет.

Кадры смены ширины, четыре прогона после правки при нагрузке 2,1–4,6
(медиана кадра, наибольший кадр, кадров не уложилось в 16,7 мс из 40):

| Карточек | WebKit до | WebKit после | Chromium до | Chromium после |
|---|---|---|---|---|
| 1 000 | 17 мс, 21 мс | 16,7 мс, 17,5–18,7 мс, 0 | 8,3 мс, 9,6 мс | 8,3 мс, 9,2–11,6 мс, 0 |
| 3 000 | 16,5 мс, 26 мс | 16,7 мс, 17,3–18,4 мс, 0 | 16,7 мс, 17,3 мс | 8,3 мс, 11,5–14,5 мс, 0 |
| 7 000 | 27 мс, 46 мс | 16,7 мс, 17,6–18,5 мс, 0 | 33,3 мс, 34,7 мс | 8,3 мс, 9,2–14,7 мс, 0 |

- «До» это один прогон при нагрузке 1,9–2,6. Число не уложившихся кадров
  для него не посчитано: кадр тогда мерился временем самого кадра, которое
  WebKit округляет до миллисекунды. По медиане: в Chromium при 7 000
  карточек кадр занимал четыре такта по 8,3 мс, при 3 000 два; в WebKit при
  7 000 карточек больше полутора тактов по 16,7 мс. Аудит дал 35 и 38 мс
  при 7 000 карточек.
- После правки кадр при 7 000 карточек укладывается в 16,7 мс в обоих
  движках, а в Chromium и в 8,3 мс. По решению пользователя 15.11.2026
  раскладка частями (пункт 6 плана аудита) при таком результате не делается.

## Решение 15.11.2026

[AUDIT_FEED_IMAGES.md](AUDIT_FEED_IMAGES.md) рекомендовал держать слои
смонтированных карточек нарисованными: контейнер карточек несёт непрерывную
анимацию `transform` без видимого изменения, и WebKit рисует слой карточки при
монтировании. В стенде аудита это давало 0 % тёмных картинок.

Пользователь 15.11.2026 решил сначала пройти путь без этой анимации: она
опирается на внутреннее правило движка. Путь состоит из трёх шагов: проверка
`test:feed-images`, удаление предзагрузчика, подготовка картинки карточки
стандартным `decode()`. Вариант с анимацией отложен: пользователь решит о нём
отдельно, после оценки результата.

Доля картинок, бывших тёмными, по шагам (`bun run test:feed-images`):

| Сценарий | До правок | Без предзагрузчика | С подготовкой картинки |
|---|---|---|---|
| 6 px/мс | 36–44 %, 6 прогонов | 37–43 %, 5 прогонов | 12–25 %, 16 прогонов |
| Броски | 32–47 %, 5 прогонов | 39–46 %, 5 прогонов | 10–27 %, 17 прогонов |
| С места | 25–34 %, 5 прогонов | 29–35 %, 5 прогонов | 4–13 %, 16 прогонов |

- Запросы картинок за проход: 1008–1119 при 6 px/мс до правок, 577–581 без
  предзагрузчика; в бросках 804–886 и 438–440; с места 548–618 и 324–328.
  Запросов стало меньше на 40–50 %.
- Кадры страницы при 6 px/мс, пять пар прогонов друг за другом в стенде
  аудита при нагрузке машины 7–16: дольше 25 мс 18–42 из 345 без подготовки и
  25–61 с ней, дольше 50 мс 0–4 и 0–2. В прогонах проверки: дольше 25 мс
  15–57 до правок и 9–46 с подготовкой. Подготовка идёт вне главного потока,
  роста длительности кадров нет.
- Память, стенд аудита, по два прогона. В покое процесс страницы 147–149 МБ
  до правок и 138–151 МБ с подготовкой, процесс графики 118 и 114–121 МБ. При
  прокрутке 6 px/мс, один замер на прогон: страница 300–486 МБ до правок и
  433–504 МБ с подготовкой, графика 428 и 388–409 МБ. Различие не выходит за
  разброс между двумя прогонами одного состояния.
- Остаток. Картинка, опоздавшая к входу, темна один или два кадра записи, то
  есть 40–80 мс. Это причина П2 аудита: прокрутка идёт в отдельном потоке и
  обгоняет страницу, слой карточки не успевает нарисоваться к входу. Подготовка
  картинки готовит картинку, но не слой. Остаток убирает только вариант с
  анимацией.

## Acceptance Criteria

Functional:

- Fast scroll through `Everything` shows materially fewer blank/late media
  states.
- Pagination boundaries remain invisible: first paint is not blocked by page
  two, and fast scroll cannot catch the loaded tail before the next page starts.
- DOM node count remains bounded by the render window.
- Каждая картинка запрашивается один раз за проход вперёд, и доля картинок,
  опоздавших к входу в видимую область, не выше порогов раздела «Проверка
  картинок при прокрутке».
- A picture that does not load or cannot be decoded goes through the card's
  bounded retries and never loops.
- The feed never requests original source media.
- Existing keyboard focus, group selection, drag stack, context menu and
  feed-video poster behavior remain unchanged.

Performance:

- Scrolling inside the current render overscan window must not force a React
  re-render unless visible item identity changes.
- No work per scroll frame is spent on pictures outside the mounted cards.
- No synchronous filesystem or IPC call is allowed in the scroll handler.

Manual:

- On a real `Everything` route, perform rapid trackpad scroll down and up.
- Verify the feed reads as continuous material rather than blank cards that fill
  in after arrival.
- Verify memory and CPU do not grow unbounded during repeated scroll passes.

## Test Plan

- Unit tests for picture preparation (`usePreparedPicture`):
  - `decode()` once per mounted picture and again for a new address;
  - a rejection by the element's state: gone, replaced, not loaded, not
    decodable.
- Card tests: a picture, a tile and a video poster that cannot be decoded take
  the same failure path as one that does not load.
- Unit tests for adaptive window calculations:
  - slow scroll;
  - fast scroll;
  - minimum and maximum clamps;
  - backward direction mirroring.
- Focused Grid tests where practical:
  - the diagnostics object is published by Grid;
  - only the render window is mounted.
- `bun run test:feed-images`: late pictures and repeated requests in WebKit
  (раздел «Проверка картинок при прокрутке»).
- `bun run test:feed-growth`: the page's work on a page that arrives and on a
  changed card with 7 000 cards held, and the frames of a width change
  (раздел «Проверка роста ленты»).
- Product acceptance on the real `Everything` vault is required because the
  defect is perceptual; it passed after the C8.16 layout-readiness retune.

## Implementation Phases

1. Shared candidate resolver. Снят 15.11.2026 вместе с предзагрузчиком.
2. Adaptive window calculation helpers and tests.
3. Bounded preload queue and tests. Снята 15.11.2026.
4. Grid hook integration with diagnostics. Хук предзагрузчика снят
   15.11.2026, объект диагностики создаёт `Grid`.
5. Retune render/priority windows.
6. Manual acceptance on `Everything`.
7. 15.11.2026: проверка `test:feed-images`, удаление предзагрузчика,
   подготовка картинки карточки (раздел «Решение 15.11.2026»).

## Non-goals

- Do not replace the masonry renderer.
- Do not implement native CSS masonry in this phase.
- Do not remove all visible `Card` fallback behavior in this same change.
- Do not add visible loading spinners, service labels or debug text to the feed.
- Do not solve every mutation refresh cascade in this phase.

## Known trade-offs and residuals (audit 02.06.2026)

Two known deviations are intentionally accepted rather than refactored, because
the masonry/scroll path is the zero-jank hot path and lacks fine-grained scroll
regression tests; reworking it risks a perceptual regression the current test
suite would not catch.

- **Grid keeps a velocity `scrollTop` in `useState`.** Beyond `useGridScroll`
  (which keeps `scrollTop` in a ref and re-renders only when the visible set
  changes), `Grid` runs a second RAF-coalesced scroll listener that writes
  `scrollTop` into React state to drive velocity sampling, priority bounds
  and autoplay selection. This re-renders `Grid` once
  per scroll frame during active scrolling. It is RAF-coalesced (not per-pixel)
  and required by the velocity-aware windows, so it is accepted as a
  deliberate deviation from SPEC_GRID invariant #3 rather than reworked into the
  ref+tick path. Второй полный ререндер Grid на том же кадре скролла устранён:
  эффект `getVisibleItems` в `useGridScroll` байлаутит по `samePositions`, поэтому
  чистая velocity-рябь (идентичный visible set при дрейфе окна) больше не бампит
  `scrollTick` и не форсит лишний рендер.
- **`GRID_TOP_INSET_PX` coordinate frame.** Layout `positions` start at
  `top = 0` while the grid is rendered with a `marginTop` of
  `GRID_TOP_INSET_PX` (32px). Exact viewport checks add the inset to
  `position.top`, but `getVisibleItemsFromIndex` compares the raw `scrollTop`
  against un-inset positions, so the visible and priority windows are
  offset by 32px. The render window (≥640px) absorbs this, so no blank or
  missing card results; normalizing it risks shifting the visible window
  without scroll-edge test coverage, so it is left as a documented residual.
