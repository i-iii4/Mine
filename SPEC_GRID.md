# SPEC: components/Grid — Zero-Jank Masonry

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PRINCIPLES.md](PRINCIPLES.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [DEVLOG.md](DEVLOG.md)

---

## Назначение

Новая архитектура masonry-сетки карточек, заменяющая текущую реализацию основанную на measurement + correction + scroll anchoring. Цель — удовлетворить четыре продуктовых требования без компромиссов:

1. **120 fps scroll**, без прыжков scroll position, без визуальных перестроек во время прокрутки
2. **Мгновенный reflow** при изменении ширины viewport (resize окна, drag сайдбара)
3. **Равная производительность** на коллекциях 1000 и 10000 блоков
4. **Мгновенное переключение** между каналами

Архитектура должна работать одинаково на Tauri desktop (WebKit 26.x на macOS) и на будущем web-деплое (Chrome, Firefox, Safari, mobile browsers).

---

## Корневой принцип

**Все высоты карточек известны до вставки в layout.** Никаких измерений через DOM во время scroll, никаких корректировок, никакого scroll anchoring. Если высота — чистая функция от данных блока, columnWidth и предрассчитанных font metrics, то прыжки физически невозможны — их нечего генерировать.

Предыдущая архитектура (estimate → render → measure → correct) фундаментально порождала прыжки: корректировки меняли `totalHeight`, браузер клампил `scrollTop`, пользователь видел перестройку. Новая архитектура устраняет этот цикл целиком, убирая причину существования прыжков.

## Текущий статус rollout

Phase 11 закрыта как доказуемая миграция, а не как одномоментная замена
`Grid.tsx`. Production-код содержит весь целевой deterministic stack:

- `src/workers/fontMetrics.worker.ts` и `src/lib/fontMetrics.ts`;
- `src/lib/wordWrap.ts` и `src/lib/cardHeight.ts`;
- bucket visibility index в `src/lib/masonryLayout.ts`;
- generation-aware `src/lib/layoutCache.ts`;
- `src/hooks/useGridScroll.ts` с RAF path и bounded anti-blank sync commit.

Production Grid больше не использует DOM-measured heights как источник layout.
`computeCardHeight()` является source of truth для masonry geometry; media
dimensions дают точные media envelopes, word metrics дают deterministic text
envelopes, а отсутствие worker metrics деградирует в conservative fallback
после завершения попытки загрузки metrics. DOM measurement сохранён только как
explicit dev-аудит height drift через `window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__()`
и не участвует в user-facing scroll/render path.

**Кэшируемость ≠ settled.** Conservative fallback (worst-clamped строки текста)
держит ленту живой, пока метрики грузятся, но такой layout — временный.
В module-level `layoutCache` генерация записывается только когда **каждый**
non-media блок имеет exact word widths (предикат
`generationHasExactDeterministicHeights`, `src/lib/gridLayoutReadiness.ts`).
Гейт по одному лишь `wordMetricsSettled` (промис завершился) запрещён: при
частичной доставке метрик он закреплял fallback-высоты в кэше — под короткими
social/article карточками оставался серый хвост в 2 резервные строки, и он
переживал приход точных метрик.

Route switching is snapshot-driven. `App.tsx` owns route/query identity for the
latest applied `GridSnapshot` and passes an explicit readiness bit to Grid.
Grid may show the empty-channel placeholder only when that snapshot identity
matches the current route and search query. A pending uncached route with
`blocks.length === 0` is not an empty channel.

Grid layout width is measured from the scrollport content box. Initial mount
and `ResizeObserver` updates must use the same width source; horizontal padding
is chrome spacing and must not participate in `columnWidth` or masonry position
calculation.

---

## Dual-path стратегия

### Path A — Native CSS Grid Lanes (primary, future-proof)

Feature detect:

```ts
const supportsGridLanes = typeof CSS !== "undefined"
  && CSS.supports("display", "grid-lanes");
```

Когда поддерживается (Safari 26.4+ сейчас, Chrome/Firefox ожидаются позже в 2026) — используется нативный CSS путь:

```css
.grid {
  display: grid-lanes;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 32px;
}

.grid > .card-wrapper {
  content-visibility: auto;
  contain-intrinsic-size: auto var(--card-height);
}
```

Браузер делает всё сам в C++. Ноль JS-работы. Виртуализация через `content-visibility: auto` с точным `contain-intrinsic-size`, значение которого — detemrinistically вычисленная высота (подставляется inline через `--card-height` CSS variable). Точные размеры нужны чтобы `content-visibility` не вызывал layout thrashing при scroll.

На текущей macOS 26.1 этот путь неактивен. Feature detect автоматически переключится когда пользователь обновит OS до 26.4+.

### Path B — Virtualized JS masonry (universal fallback)

Используется когда `supportsGridLanes === false`. Pure-JS virtualized masonry с тремя ключевыми свойствами:

1. **Детерминистические высоты** — никакого DOM measurement. Высота каждой карточки — чистая функция от `(block, columnWidth, wordWidthsCache)`.
2. **Scroll не триггерит React render на каждый pixel** — scroll state живёт в ref, видимые items пересчитываются в RAF loop, React ре-рендерится только при изменении набора видимых карточек. Native jump/fast scroll имеет bounded anti-blank sync commit.
3. **Web Worker pre-computation** — `OffscreenCanvas.measureText` вычисляет word widths в воркере, результат кэшируется в IndexedDB. Main thread не блокируется.

---

## Структура модулей

```
src/
├── workers/
│   └── fontMetrics.worker.ts       # OffscreenCanvas measureText в Worker
├── lib/
│   ├── fontMetrics.ts              # Worker client: postMessage protocol, IndexedDB cache
│   ├── wordWrap.ts                 # Чистая функция word-wrap: (widths, maxWidth) → lineCount
│   ├── cardHeight.ts               # computeCardHeight(block, columnWidth, metrics) → height
│   ├── cardHeightDrift.ts          # Shadow-validation measured vs deterministic height report
│   ├── masonryLayout.ts            # Extended: + bucket visibility index
│   └── layoutCache.ts              # LRU cache для layout'ов каналов
├── hooks/
│   └── useGridScroll.ts            # RAF-coalesced scroll state + anti-blank sync commit
├── components/
│   ├── Grid.tsx                    # Переписан: dual-path, без measurement
│   └── Card.tsx                    # Минорные правки: will-change, фикс line-heights
└── types/
    └── fontMetrics.ts              # WordWidths, FontHash, WorkerMessage protocol
```

Большая часть supporting-файлов уже создана. Текущий workstream не удаляет
старый Grid path; он сначала укрепляет cache identity и добавляет proof gates.
Старый generation-aware `heightCache` удалён. Единственный bucket helper живёт
в `src/lib/heightBucket.ts`; `layoutCache` кэширует уже deterministic layouts.

---

## Типы и API контракты

### `src/types/fontMetrics.ts`

```ts
/** Font identity — hash шрифтов + размеров + стилей, влияющих на metrics */
export type FontHash = string;

/** Maximum preview prefix measured by the worker and hashed by the cache key */
export const FONT_METRICS_PREVIEW_MAX_CHARS = 480;

/** Ширина отдельных слов в тексте, в пикселях */
export interface WordWidths {
  /** Ширины слов title/display title */
  title: number[];
  /** Ширины слов preview (обрезанного до FONT_METRICS_PREVIEW_MAX_CHARS) */
  preview: number[];
  /** Ширина пробела title font */
  titleSpace: number;
  /** Ширина пробела preview font */
  previewSpace: number;
}

/** Кэшированные word widths для блока, версии шрифта и measured text fingerprint */
export interface CachedWordWidths {
  cacheKey: string;
  blockId: number;
  fontHash: FontHash;
  textHash: string;
  widths: WordWidths;
}

/** Main-thread cache identity; IndexedDB keyed by cacheKey, worker keyed by id */
export interface FontMetricsCacheIdentity {
  blockId: number;
  fontHash: FontHash;
  textHash: string;
  cacheKey: string;
  title: string;
  preview: string;
}

/** Protocol сообщений с worker'ом */
export type WorkerMessage =
  | { type: "compute"; blocks: Array<{ id: number; title: string; body: string }>; fontHash: FontHash }
  | { type: "result"; results: Array<{ id: number; widths: WordWidths }>; fontHash: FontHash }
  | { type: "progress"; done: number; total: number }
  | { type: "ready" };
```

### `src/lib/wordWrap.ts`

```ts
/**
 * Сколько строк займёт текст при данной ширине колонки.
 * Чистая функция, детерминистична, работает только с числами — нет DOM.
 */
export function countLines(
  wordWidths: number[],
  spaceWidth: number,
  maxWidth: number,
): number;
```

Реализация: greedy word-wrap loop. Для каждого слова проверяется влезает ли `currentLineWidth + spaceWidth + wordWidth <= maxWidth`. Если нет — инкремент lineCount, начать новую строку. O(word_count).

### `src/lib/cardHeight.ts`

```ts
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";

export const COLUMN_MIN_WIDTH = 220;
export const GAP = 32;

/**
 * Детерминистическая высота карточки. Чистая функция.
 * Возвращает точную высоту в пикселях, совпадающую с будущим CSS-рендером.
 *
 * @param block        — данные блока из LightBlock
 * @param columnWidth  — ширина колонки в px (известна из layout engine)
 * @param wordWidths   — pre-computed word metrics из Canvas measureText,
 *                       или null если ещё не вычислены (использует fallback)
 */
export function computeCardHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
): number;
```

Для каждого `card_kind`:

- **media** — presentation variant выводится из `media_file`, `thumbnail`,
  `preview_manifest`, URL и file extension:
  - image: `max(columnWidth / aspectRatio, adaptiveImageMinimum)` при наличии
    metadata; `adaptiveImageMinimum = clamp(interactiveFloor, columnWidth * 0.4,
    120px)`; без metadata используется conservative fallback.
    `aspectRatio` берётся строго в порядке per-file `media_dimensions` →
    `preview_manifest` → `block.width/height`. Тот же порядок обязан
    использовать render-время (`primaryAspectRatio` в `cardLayout.ts`):
    зарезервированная высота и нарисованная пропорция — одна и та же карточка,
    и расхождение источников уводит графику из отведённого ей слота.
    Целевой контракт заменяет эту цепочку одним источником — размерами
    сгенерированного превью — и вводит кламп пропорции как единственную точку
    решения об обрезке: [SPEC_CARD_MEDIA_GEOMETRY.md](SPEC_CARD_MEDIA_GEOMETRY.md)
  - video: `columnWidth * 9 / 16` (fixed 16:9 + play overlay)
  - link: `columnWidth * 9 / 16 + 76` (16:9 thumbnail + 76px text)
  - file: fixed compact height
- **article** — используется `wordWidths`:
  - `titleLines = min(2, countLines(wordWidths.title, wordWidths.titleSpace, contentWidth))`
  - `previewLines = min(block.first_image ? 3 : 8, countLines(wordWidths.preview, wordWidths.previewSpace, contentWidth))`
  - `imageH = block.first_image ? columnWidth * 0.5 : 0`
  - `authorH = block.author ? 24 : 0`
  - `height = 32 + titleLines * 20 + 6 + previewLines * 18 + imageH + authorH + 28`

Если `wordWidths === null` для article/social card (кэш ещё не готов),
функция возвращает conservative reservation: худшую clamped-геометрию текущего
template. Это overlap-safe envelope для loading state и fallback для среды,
где worker metrics недоступны. Production switch уже выполнен после
shadow-validation; дальнейшие изменения шаблонов Card обязаны заново проходить
height-drift audit.

### `src/lib/masonryLayout.ts` — расширение

`computeMasonryLayout` считает количество колонок от минимального контракта, а
фактическая максимальная ширина карточки определяется алгоритмически как
ширина колонки непосредственно перед добавлением следующей колонки. Layout
использует всю ширину контейнера, чтобы свободный остаток не накапливался
только справа. Также добавляются:

```ts
/** Bucket-based visibility index для O(log N + k) visibility queries */
export interface VisibilityIndex {
  bucketHeight: number;
  buckets: MasonryPosition[][];
  totalHeight: number;
}

/** Построение индекса из готового layout */
export function createVisibilityIndex(layout: MasonryLayout, bucketHeight?: number): VisibilityIndex;

/**
 * Выборка видимых items в заданном scroll window.
 * Эффективно: сканирует только bucket'ы, перекрывающие окно.
 */
export function getVisibleItemsFromIndex(
  index: VisibilityIndex,
  scrollTop: number,
  viewportHeight: number,
  overscanBefore: number,
  overscanAfter: number,
): MasonryPosition[];
```

Реализация: делим y-диапазон на bucket'ы фиксированной высоты (дефолт 600px). Каждый bucket содержит массив позиций, чей `[top, bottom]` пересекается с диапазоном bucket'а. На lookup — вычисляется `startBucket` и `endBucket` из scroll window, перебираются только эти bucket'ы.

Стоимость: O(k + B) где k — количество видимых items, B — количество bucket'ов в overscan range (обычно 3-5). Существенно дешевле O(N) filter для больших коллекций.

### `src/lib/fontMetrics.ts`

```ts
/**
 * Получить word widths для набора блоков.
 * Сначала читает из IndexedDB, недостающее вычисляет в Worker.
 * Возвращает Map<blockId, WordWidths>.
 *
 * Ожидает что document.fonts.ready уже resolved перед первым вызовом.
 */
export async function fetchWordWidths(
  blocks: LightBlock[],
): Promise<Map<number, WordWidths>>;

/** Текущий хэш шрифтов (Geist Sans file hash + font-size + line-height) */
export function getFontHash(): FontHash;

/** Инвалидация кэша при смене font version */
export async function invalidateFontCache(): Promise<void>;
```

Алгоритм `fetchWordWidths`:

1. Проверить `document.fonts.ready` (если первый вызов)
2. Вычислить `fontHash` (кэширован после первого вычисления)
3. Открыть IndexedDB database `arena-font-metrics`, object store `wordWidths`
4. Для каждого блока построить `FontMetricsCacheIdentity`: `(blockId, fontHash, textHash, cacheKey)`
5. Проверить наличие в кэше по `cacheKey`, дополнительно сверяя `blockId`, `fontHash` и `textHash`
6. Собрать список `missing` блоков
7. Если `missing.length === 0` → вернуть Map из кэша
8. Иначе — отправить `missing` в worker через `postMessage`
9. Worker возвращает `WorkerResult`, записать в IndexedDB, добавить в Map
10. Вернуть объединённый Map

`textHash` считается по тому же title и preview prefix, который реально
измеряет worker. Same-id content edit не может reuse stale metrics; изменения
за пределами `FONT_METRICS_PREVIEW_MAX_CHARS` не инвалидируют кэш, потому что
они не меняют measured widths. Worker вычисляет в chunks по 500 блоков,
отправляет `progress` сообщения для UI.

**Grid-состояние `wordWidthsMap` инкрементально.** Эффект метрик в `Grid` не
очищает `wordWidthsMap` при смене identity массива `blocks` (как было раньше);
дозапрашиваются только блоки со сменившейся `FontMetricsCacheIdentity`
(новые/отредактированные), результат мержится в существующую Map. При этом Map
и параллельный `wordWidthsIdentityRef` прунятся до живого множества: удаляются
записи блоков, которых нет в текущем `blocks`, и записи с несовпавшим
`cacheKey`. Последнее важно для корректности — отредактированный блок теряет
render-ready-статус и идёт через скелетон до прихода новых метрик, а не
рисуется старой высотой.

Grid передаёт в `fetchWordWidths` только блоки со сменившейся font-metrics cache
identity (`createFontMetricsCacheIdentity`, `src/components/Grid.tsx`) — новые или
отредактированные, а не весь массив. `wordWidthsMap` и `wordWidthsIdentityRef`
мержатся инкрементально по мере ответов worker'а: no-op refresh (`reconcileBlocks`
вернул тот же контент в новом массиве) не роняет уже вычисленные метрики и не
заставляет worker пересчитывать весь корпус. Обе структуры прунятся до живого
множества блоков — удаляются id вне текущего `blocks` и записи с несовпавшим
`cacheKey`, — чтобы за долгую сессию память не росла неограниченно;
отредактированный блок при этом уходит через скелетон до переизмерения.

### `src/workers/fontMetrics.worker.ts`

```ts
// OffscreenCanvas context init
const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d");

function measureWord(word: string): number {
  return ctx.measureText(word).width;
}

function computeWordWidths(title: string, body: string): WordWidths {
  const preview = body.slice(0, FONT_METRICS_PREVIEW_MAX_CHARS);
  ctx.font = titleFontSpec;
  const titleWords = splitWords(title).map(measureWord);
  const titleSpace = ctx.measureText(" ").width;
  ctx.font = previewFontSpec;
  const previewWords = splitWords(preview).map(measureWord);
  const previewSpace = ctx.measureText(" ").width;
  return {
    title: titleWords,
    preview: previewWords,
    titleSpace,
    previewSpace,
  };
}

self.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === "compute") {
    const results = event.data.blocks.map((b) => ({
      id: b.id,
      widths: computeWordWidths(b.title ?? "", b.body ?? ""),
    }));
    self.postMessage({ type: "result", results, fontHash: event.data.fontHash });
  }
});
```

`splitWords` использует `Intl.Segmenter` для корректного word-breaking в CJK и emoji контексте, fallback на `str.split(/\s+/)` для латиницы.

### `src/lib/layoutCache.ts`

```ts
/**
 * LRU cache для committed exact layouts. Caller передаёт generation-aware key,
 * который уже включает route, точную геометрию колонок (cw, cc) и ordered
 * layout fingerprint.
 */
export class LayoutCache {
  private map = new Map<string, MasonryLayout>();
  private maxSize = 10;

  get(generationKey: LayoutGenerationKey): MasonryLayout | null;
  set(generationKey: LayoutGenerationKey, layout: MasonryLayout): void;
  clear(): void;
}
```

Ключ строится не внутри `LayoutCache`, а в `layoutGenerationKey`: route, точная
геометрия колонок (`cw` = columnWidth, `cc` = columnCount) и ordered layout
fingerprint. Сырой `parentWidth` намеренно исключён — masonry это чистая функция
от `(columnWidth, columnCount, gap, heights)`, поэтому ключ меняется только при
реальной смене раскладки, а sub-column resize держит кэш живым. Fingerprint
включает layout-relevant content (`preview_manifest`, display title, preview text
и media geometry), так что same-id content changes не могут reuse stale layout.

### `src/hooks/useGridScroll.ts`

```ts
/**
 * Scroll state hook: scrollTop живёт в ref, обычный путь coalesced через RAF,
 * React обновляется только когда меняется visible set. Если native scroll jump
 * оставил текущий viewport без mounted item, hook делает bounded sync commit.
 */
export function useGridScroll(
  scrollElementRef: RefObject<HTMLDivElement>,
  options: UseGridScrollOptions,
): MasonryPosition[];
```

Реализация:
- Подписывается на `scroll` event через `addEventListener`
- В handler'е обновляет `scrollTopRef.current` и планирует RAF
- В RAF callback вычисляет `newVisible = getVisibleItems(scrollTopRef.current)`
- Сравнивает с предыдущим snapshot (reference equality ok если используем мемоизацию)
- Если отличается — bump'ит opaque tick state, `useMemo` пересчитывает visible set
- Если одинаковый — ничего не делает, React спит
- Если реальный viewport больше не пересекается с mounted items — применяется
  bounded `flushSync`, чтобы браузер не успел нарисовать blank frame.

### `src/components/Grid.tsx` — обновления

```tsx
const supportsGridLanes = useMemo(
  () => typeof CSS !== "undefined" && CSS.supports("display", "grid-lanes"),
  [],
);

export function Grid({ blocks, parentWidth, ... }: GridProps) {
  const wordWidths = useWordWidths(blocks);  // через fontMetrics.ts
  const layout = useMemoizedLayout(blocks, parentWidth, wordWidths, layoutCacheRef.current);
  const visibilityIndex = useMemo(() => createVisibilityIndex(layout), [layout]);

  if (supportsGridLanes) {
    return <GridLanesLayout layout={layout} blocks={blocks} />;
  }
  return <VirtualizedJSLayout layout={layout} visibilityIndex={visibilityIndex} blocks={blocks} />;
}
```

Никакого `measuredHeights`, `pendingHeightsRef`, `isScrolling`, `flushPendingHeights`, `useLayoutEffect` для anchoring — всё удалено. Единственное состояние связанное со scroll — через `useGridScroll` hook, который использует `useSyncExternalStore` для минимизации ре-рендеров.

### `src/components/Card.tsx` — правки

- Каждая card-wrapper `div` получает `className="will-change-transform"` (через Tailwind)
- Inline стиль: `transform: translate3d(${x}px, ${y}px, 0)` (force 3d для GPU layer)
- Фиксация line-height и font-size на `cardHeight.ts` константы (20px для display title, 18px для preview, 14px base)
- Контейнеры с текстом получают `line-clamp-N` с фиксированным N соответствующим `computeCardHeight` максимальным значениям

---

## Data flow

### На mount / channel switch

```
1. blocks prop updates
2. Grid.tsx: fetchWordWidths(blocks) — async
3.   fontMetrics.ts читает IndexedDB для блоков из blocks
4.   Недостающие блоки отправляются в Worker
5.   Worker вычисляет word widths через OffscreenCanvas.measureText
6.   Результаты записываются в IndexedDB
7.   Возврат Map<blockId, WordWidths>
8. Grid.tsx: computeMasonryLayout(blocks, parentWidth, wordWidthsMap)
9.   LayoutCache.get(blocks, parentWidth) — если hit, возврат
10.  Иначе вычисление через computeCardHeight для каждого блока
11.  LayoutCache.set(...)
12. Grid.tsx: createVisibilityIndex(layout)
13. Первый render: visibleItems = items в initial viewport
14. React render только visible items в DOM
```

Если блоки уже в IndexedDB cache (повторный визит, same font) — шаги 4-6 пропускаются, всё мгновенно.

### На scroll

```
1. Browser scroll event
2. useGridScroll: scrollTopRef.current = el.scrollTop
3. RAF scheduled (если ещё не запланирован)
4. В RAF: newVisible = getVisibleItemsFromIndex(index, scrollTop, ...)
5. Если newVisible.length === prevVisible.length И все items совпадают по id:
      ничего не делать
6. Иначе: onStoreChange() → useSyncExternalStore → React re-render
7. React обновляет только DOM для changed items
```

Ключевой момент: между пунктами 3 и 4 **нет React render'а**. React рендерится только когда реально меняется набор видимых карточек — это happens раз в 200-500ms при нормальном scroll, не на каждый кадр.

### На resize parentWidth

```
1. ResizeObserver fires на Grid scrollport
2. Grid.tsx reads the scrollport content-box width and updates `parentWidth`
3. useMemoizedLayout: LayoutCache miss только если resize пересёк границу
   columnWidth/columnCount; sub-column resize (тот же columnWidth и columnCount)
   даёт cache HIT и пропускает пересчёт
4. Пересчёт heights (pure JS, wordWidths из cache) — O(N) ~10ms для 10000
5. Пересчёт layout — O(N) ~3ms
6. createVisibilityIndex — O(N) ~1ms
7. Render visible items с новыми позициями
```

Общий cost: ~15-20ms для 10000 блоков. Fit в один кадр 60Hz. Никаких worker вызовов — wordWidths уже в memory с момента первой загрузки канала.

### На channel switch

```
1. blocks prop changes (новый канал)
2. fetchWordWidths(newBlocks) — почти все в IndexedDB уже
3. LayoutCache.get(newBlocks, parentWidth)
4.   Если hit (канал посещался последние 10 раз) → instant
5.   Если miss → вычисление ~15ms, сохранение в cache
6. Render
```

Первое посещение нового канала — ~15ms. Повторное — instant.

---

## Инварианты

Инварианты, которые **обязательно** должны соблюдаться в любой реализации:

1. **Никакого DOM measurement на hot path.** `getBoundingClientRect`, `clientHeight`, `offsetHeight` запрещены в Grid.tsx и всех его descendant'ах после mount'а. Исключение — `ResizeObserver` на parentRef для измерения width/height scrollport.

2. **Pure functions для layout computation.** `computeCardHeight`, `computeMasonryLayout`, `createVisibilityIndex`, `getVisibleItemsFromIndex` — все pure, без side effects, без DOM зависимостей. Тестируемы без jsdom.

3. **Scroll не триггерит React state change на каждый pixel.** `scrollTop`
живёт в ref; ordinary scroll coalesced через RAF и обновляет React только при
смене visible set. Anti-blank sync commit разрешён только как bounded safety
path, когда native scroll jump иначе показал бы полностью пустой viewport.

4. **Font loaded before first measureText.** Worker проверяет `document.fonts.ready` (через `self.fonts` в worker context если доступно, иначе через main thread signal).

5. **Word widths deterministic.** Для одной и той же пары `(text, fontHash)` `measureText` возвращает одно и то же значение (свойство браузера).

6. **LayoutCache invalidated on font change.** Если font hash меняется (обновление Geist Sans), весь `LayoutCache` + IndexedDB word widths инвалидируются.

7. **Grid-lanes path и JS path взаимозаменяемы.** Оба пути принимают одни и те же данные `(blocks, layout)` и производят визуально эквивалентный рендер. Пользователь не должен замечать переключения между ними.

8. **Empty state follows route snapshot identity, not raw array length.** `[]`
может означать pending route, pending search, настоящую пустую коллекцию или
пустой результат поиска. Placeholder разрешён только для подтверждённого
пустого snapshot текущего channel route.

9. **`parentWidth` is content-box only.** Initial mount, `ResizeObserver`,
layout cache keys, visible render and hidden audit must agree on one width
source. Mixing `clientWidth` padding-box and `ResizeObserver.contentRect`
content-box is forbidden because it produces column-width shrink on route
remounts.

10. **`VirtualMasonryLayout` не пересоздаётся при смене поколения.** Компонент не
имеет `key={generationKey}`; смена generation обновляет только позиции через
React reconciliation по `block.id`, без remount карточек. Это сохраняет уже
смонтированные `<img>` и играющие видео при resize и re-layout вместо их
пересоздания.

---

## Performance targets

Бенчмарки для подтверждения удовлетворения требований. Измеряются через `performance.now()` в dev build на reference vault (vault пользователя, ~1000 блоков реальных данных).

| Операция | 1000 блоков | 10000 блоков | Frame budget |
|---|---|---|---|
| Initial load (first visit, no cache) | < 800ms | < 2000ms | N/A (async) |
| Initial load (cache hit) | < 100ms | < 200ms | N/A (async) |
| `computeMasonryLayout` | < 2ms | < 10ms | 16.6ms |
| `createVisibilityIndex` | < 1ms | < 3ms | 16.6ms |
| `getVisibleItemsFromIndex` | < 0.1ms | < 0.2ms | 8.3ms |
| Scroll frame (no set change) | 0 React work | 0 React work | 8.3ms |
| Scroll frame (with set change) | < 5ms | < 8ms | 8.3ms |
| Resize reflow | < 15ms | < 20ms | 16.6ms |
| Channel switch (cache hit) | < 2ms | < 5ms | 16.6ms |
| Channel switch (cache miss) | < 15ms | < 25ms | 16.6ms |

Если любой из таргетов нарушен при тестировании — фикс обязателен до merge.

---

## Rollout plan from current state

Phase 11 закрыта через доказуемые вертикальные срезы:

### Шаг 1: Cache correctness hardening

- `fontMetrics` cache key включает `blockId`, `fontHash` и measured text
  fingerprint.
- IndexedDB store мигрирует на `cacheKey`; старый `blockId`-only кэш
  пересоздаётся, потому что это derived artifact.
- Unit tests доказывают: same-id text edit меняет cache key; изменения вне
  measured preview prefix не инвалидируют кэш.

### Шаг 2: Deterministic geometry proof gate

- Добавить shadow-validation между `computeCardHeight()` и фактической высотой
  `MeasureCard` для текущего generation.
- Собирать drift по типам карточек: max, p95, mean, count.
- Публиковать отчёт в `window.__MINE_FEED_SCROLL_DEBUG__.heightDrift`:
  `status`, `softBudgetPx`, `hardBudgetPx`, `exactSampleCount`,
  `fallbackSampleCount`, grouped summaries by `card_kind` и `block_type`.
- Browser audit запрашивает drift явно через dev-only
  `window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__()`. Request происходит после
  scroll performance sample, поэтому hidden measurement и drift aggregation не
  загрязняют `settleMs`, frame-gap и long-task budgets.
- Budget: soft `2px`, hard `8px`. Production switch невозможен, если есть
  fallback samples, hard exceedances или p95 выше soft budget.
- Production switch запрещён, пока drift не укладывается в budget и не покрыт
  тестами на media, article, social и channel cards.

### Шаг 3: Scheduling-only integration — done

- Использовать deterministic heights только там, где drift доказан: priority,
  prefetch, placeholder/skeleton envelope.
- Если block может быть безопасно отрендерен из deterministic height (`media`,
  готовые text metrics или conservative fallback после завершения metrics
  attempt), GridItem рендерит live `Card` сразу.
- Browser audit route использует explicit drift request после scroll sample, so
  hidden diagnostic work cannot race the scroll sample.
- Real-vault product acceptance and synthetic browser gate completed before the
  production switch.

### Шаг 4: Production Grid switch — done

- Live layout переключён на fully deterministic path.
- Production measurement infrastructure removed: no `heightCache`, no
  production `MeasurementPass`, no cached measured height authority.
- `MeasureCard` remains only for explicit height-drift audit.
- Browser acceptance: `bun run test:feed-scroll` passes with no blank viewport,
  no skeleton-only viewport and `p95/max heightDrift = 0`.

### Шаг 5: Cleanup — done

- Obsolete measured-island cache code removed.
- Benchmark / acceptance numbers are recorded in DEVLOG and
  [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md).

---

## Edge cases

1. **Block без `width/height` метаданных (image)** — используется
   `DEFAULT_CARD_HEIGHT = 240` как conservative fallback, а image surface
   заполняет весь зарезервированный envelope через `object-cover`, поэтому
   fallback не создаёт пустую полосу. Graphic surface обязана занимать полную
   ширину (`w-full`), а не выводить ширину из выданной ей высоты: при
   `aspect-ratio` с одной лишь заданной высотой любое расхождение между
   committed height и render ratio сжимает графику от края карточки. Полная
   ширина плюс `object-cover` поглощают расхождение по той оси, которой владеет
   layout. Браузерный feed-аудит меряет это: ширина
   `[data-card-graphic-surface]` не может быть меньше контентной ширины своего
   контейнера. Если загруженная image-карточка ещё не
   имела детерминированной геометрии, первое `thumb:updated` немедленно
   обновляет текущий Grid snapshot; карточки с уже известными размерами
   сохраняют дешёвый pixel-only cache-buster path.

2. **Очень длинный display title/preview в article** — слова, которые не влезают в column width целиком, разбиваются на символы через `Intl.Segmenter` на grapheme boundaries. Fallback на CSS `word-break: break-word` если `Intl.Segmenter` недоступен.

3. **Emoji в тексте** — `Intl.Segmenter` корректно обрабатывает ZWJ sequences. `measureText` возвращает корректную ширину для font'ов с emoji support.

4. **CJK текст без пробелов** — worker сначала сохраняет whitespace-delimited
   tokens для языков с пробелами, включая punctuation attached to words. Для
   текста без пробелов используется `Intl.Segmenter` и non-whitespace segments,
   чтобы CJK/emoji не схлопывались и не теряли width.

5. **Font loading failure** — если Geist Sans не загружается, browser fallback на system UI font. `measureText` вернёт widths для fallback font, что даст корректное computation но не идеальное соответствие когда Geist наконец загрузится. Mitigation: перед первым `fetchWordWidths` ожидать `document.fonts.ready`, проверять что Geist Sans в `document.fonts.check("14px Geist")`.

6. **IndexedDB quota exceeded** — graceful fallback на in-memory Map, warn в консоль.

7. **Worker не доступен** (exotic browser) — synchronous main-thread fallback через `requestIdleCallback` chunks. Ухудшенный initial load UX, но функционально работает.

8. **Блок удалён, но есть в кэше** — при invalidation channel cache, stale entries в IndexedDB остаются. Периодический cleanup (раз в запуск) проходит по IndexedDB и удаляет entries, которых больше нет в `listBlocks()`.

9. **Resize во время initial load** — layout пересчитывается с текущим частичным `wordWidthsMap`. Блоки без ещё-не-вычисленных widths используют conservative reservation. Когда Worker возвращает результаты, layout пересчитывается ещё раз.

10. **Scroll position преодолевает конец ленты во время initial load** — если пользователь доскроллил до места где блоки ещё без точных wordWidths, current production Grid использует measured-island safety path. Fully deterministic path может заменить его только после drift gate; conservative reservation сам по себе не является доказательством отсутствия jump.

---

## Тесты

### Unit tests (vitest)

- `wordWrap.test.ts` — countLines для разных входов
- `cardHeight.test.ts` — computeCardHeight для каждого block_type, edge cases
- `cardHeightDrift.test.ts` — drift aggregation, p95/max, fallback gating
- `masonryLayout.test.ts` — уже существует, добавить тесты для visibility index
- `fontMetrics.test.ts` — cache identity и, отдельно, IndexedDB/Worker client mocks
- `layoutCache.test.ts` — LRU eviction, key hashing

### Integration tests

- `Grid.test.tsx` — рендер с фикстурными blocks, проверка DOM visible set через react-testing-library
- `Grid.perf.test.tsx` — performance targets (хотя бы sanity checks)

### Visual regression

- Через `cargo tauri dev` + screenshots из Playwright/webapp-testing skill
- Reference vault с 50+ блоков разных типов, sidebar в разных состояниях

---

## Decisions

### 001: Canvas `measureText` вместо Rust precomputation

| Approach | Problem |
|---|---|
| Rust `cosmic-text` в SQLite | Font metrics не совпадают pixel-perfect с браузерным рендером (1-3px drift), плохо портируется на веб-деплой |
| **Canvas `measureText` в Worker** (chosen) | Каждый браузер считает своим text engine → гарантированная точность. Работает одинаково в Tauri WebKit и любом web browser'е |

Rationale: приоритет на cross-platform корректность и future-proof web порт. Rust вариант давал бы small latency advantage на desktop но стоил сложности и потенциального layout mismatch между desktop и web.

### 002: External scroll ref + RAF diff вместо scroll state в `useState`

| Approach | Problem |
|---|---|
| `useState(scrollTop)` + setState в handler | Каждый scroll event триггерит React render, даже если видимые items те же. Лишняя работа, frame drops |
| **External scroll ref + RAF visible-set diff** (chosen) | React ре-рендерится только когда меняется visible set. Между changes React спит, а fast native jump имеет bounded anti-blank sync commit |

Rationale: текущий production hook уже держит `scrollTop` вне React state и
обновляет React только при смене visible set. Это сохраняет плавный ordinary
scroll и добавляет явную защиту от blank viewport при больших scroll jumps.

### 003: Bucket-based visibility index вместо Array.filter

| Approach | Problem |
|---|---|
| `positions.filter(p => p.intersects(window))` | O(N) на каждый scroll sample. 0.5ms для 10000 — терпимо, но суммируется. Не scale'ится на 100k |
| **Bucket index** (chosen) | O(k + B) где k = visible count, B = bucket count в range. ~0.1ms независимо от N |

Rationale: небольшой текущий gain, но архитектурная готовность к vault'ам размером >10k блоков. Реализация простая — одна функция.

### 004: LayoutCache LRU, ключ `layoutGenerationKey`

| Approach | Problem |
|---|---|
| `WeakMap<blocks, layout>` | WeakMap автоматически собирается GC, нет LRU semantics, нет control над size |
| LRU по `blocks.length + first/last id + width` | Same-id content/preview changes могут reuse stale layout |
| **LRU Map по generation-aware key** (chosen) | Явный size limit, предсказуемая eviction, key включает route, точную геометрию колонок (cw, cc) и layout-relevant fingerprint |

Rationale: channel switching — user-facing performance requirement, но
мгновенность не должна покупать stale layout. `LayoutCache` остаётся простым LRU,
а корректность ключа принадлежит `layoutGenerationKey`.

### 005: Native grid-lanes path via feature detect, не polyfill

| Approach | Problem |
|---|---|
| Polyfill `display: grid-lanes` через JS | Polyfill всегда медленнее native, тратим усилия на обёртку для feature которая скоро шипится |
| **Feature detect + dual path** (chosen) | Автоматическая активация native когда браузер отгрузит поддержку. Пока — JS fallback. Zero maintenance при переходе |

Rationale: `display: grid-lanes` уже существует в Safari 26.4+. Chrome/Firefox скоро. К тому времени когда большинство пользователей обновятся, JS path станет dead code который можно удалить. Polyfill не даст этот upgrade path.

### 006: Conservative reservation + shadow-validation for unresolved heights

| Approach | Problem |
|---|---|
| Ждать полного wordWidths load перед первым рендером | Пустой экран на 500-2000ms, плохой UX |
| Сразу заменить live Grid на deterministic fallback | Неверная height model даёт clip, overlap или jump; пользователь снова тестирует архитектурный риск руками |
| **Conservative reservation + measured-island production gate** (chosen) | Fallback безопасен как envelope для loading/scheduling, а production switch разрешён только после drift proof |

Rationale: после C8 мы знаем, что «больше DOM» и «быстрее измерять» не дают
идеального скролла сами по себе. Следующий слой должен доказать точность
геометрии до удаления measurement path. Это сохраняет текущие gains и не
перекладывает проверку drift на пользователя.

### 007: Drift diagnostics are observational until the production switch

| Approach | Problem |
|---|---|
| Use deterministic height immediately after adding `cardHeight.ts` | Any mismatch becomes a visual product regression: clip, overlap, white tail or scroll jump |
| **Publish `heightDrift` diagnostics while keeping measured cache authority** (chosen) | Adds a proof layer without changing the exact-height source of truth |

Rationale: `MeasureCard` remains the source of truth for exact cached heights
while `computeCardHeight()` is being proven. The drift report is a gate, not a
second unbounded layout engine. It must be cheap, request-based in browser
audit, low-priority and bounded to hidden measurement batches. Report
aggregation is scheduled outside the scroll performance sample so diagnostics
cannot add latency to the scroll-readiness path.

### 008: Deterministic-ready live render

| Approach | Problem |
|---|---|
| Keep live render blocked on DOM measurement | Fast/deep scroll can still show skeleton chunks while the viewport waits for hidden measurement, even when deterministic height is already proven |
| Remove measurement immediately | Too risky until the proof gate covers real-vault drift and more card variants |
| **Render deterministic-ready GridItems live** (chosen) | Current viewport becomes real content immediately; drift proof remains available through an explicit dev audit |

Rationale: once word metrics are ready, article/social/channel card envelopes are
deterministic enough to render the visible Card. Media cards do not need word
metrics. After the final production switch, hidden measurement no longer writes
an exact height cache and no longer participates in layout. `MeasureCard` exists
only as a requested dev audit for validating `computeCardHeight()` drift.

### 009: Production Grid uses deterministic layout only

| Approach | Problem |
|---|---|
| Keep exact measured heights as a background authority | Still preserves a second geometry source and can reintroduce stale/cache races |
| Increase overscan/preload to hide white states | Does not remove the root cause and inflates DOM work |
| **Use deterministic `computeCardHeight()` as the only production geometry source** (chosen) | One source of truth; scroll, resize, channel switch and layout cache all read the same pure geometry |

Rationale: Phase 11 drift audit showed `p95/max heightDrift = 0` on the
synthetic browser gate. Keeping measured heights after that point would be
architecture debt: two height authorities, IndexedDB invalidation rules and
background measurement scheduling. Production Grid now calculates layout from
`block + columnWidth + wordMetrics`, caches only full deterministic layouts and
uses DOM measurement only when a developer explicitly requests drift validation.

---

## Out of scope

Следующее **не входит** в этот SPEC, будет отдельными задачами:

- Извлечение image dimensions на Rust backend при индексации — отдельный PR, независим
- Оптимизация `listBlocks()` query для 10000+ блоков — возможно отдельная работа на SQLite индексы
- Drag-and-drop карточек на теги — текущая `useDraggable` интеграция сохраняется as-is
- Context menu, Detail view, CardHoverMenu — не трогаем
- Sidebar resize (уже починен в отдельном PR — CSS variable path)

---

## Definition of done

Реализация считается завершённой когда:

1. Все шаги rollout plan'а реализованы и merged в main
2. Старая measurement infrastructure полностью удалена из Grid.tsx только после successful shadow-validation и browser acceptance
3. Все unit-тесты, `bun run test:feed-scroll` и performance targets выполняются
4. Визуальная проверка пользователем на реальном vault'е подтверждает:
   - Scroll плавный без прыжков
   - Resize сайдбара / окна — instant
   - Переключение каналов — мгновенно
   - Никаких визуальных regression'ов по сравнению с текущим рендером
5. DEVLOG entry с результатами проверки и benchmark numbers
6. `ARCHITECTURE.md` обновлён: добавлено decision record про zero-jank masonry
7. `PLAN.md` обновлён: phase mark как completed
