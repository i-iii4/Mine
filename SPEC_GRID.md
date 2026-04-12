# SPEC: components/Grid — Zero-Jank Masonry

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PRINCIPLES.md](PRINCIPLES.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [DEVLOG.md](DEVLOG.md)

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
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
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
2. **Scroll не триггерит React render** — scroll state управляется через ref + `useSyncExternalStore`, видимые items пересчитываются в RAF loop, React ре-рендерится только при изменении набора видимых карточек (не на каждый pixel scroll'а).
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
│   ├── masonryLayout.ts            # Extended: + bucket visibility index
│   └── layoutCache.ts              # LRU cache для layout'ов каналов
├── hooks/
│   └── useGridScroll.ts            # useSyncExternalStore для scroll state без re-renders
├── components/
│   ├── Grid.tsx                    # Переписан: dual-path, без measurement
│   └── Card.tsx                    # Минорные правки: will-change, фикс line-heights
└── types/
    └── fontMetrics.ts              # WordWidths, FontHash, WorkerMessage protocol
```

Новые файлы: 8. Изменяемые: `Grid.tsx`, `Card.tsx`, `masonryLayout.ts`. Удаляемые: пока никакие (старый код остаётся до полной замены).

---

## Типы и API контракты

### `src/types/fontMetrics.ts`

```ts
/** Font identity — hash шрифтов + размеров + стилей, влияющих на metrics */
export type FontHash = string;

/** Ширина отдельных слов в тексте, в пикселях */
export interface WordWidths {
  /** Ширины слов title */
  title: number[];
  /** Ширины слов preview (обрезанного body до 400 символов) */
  preview: number[];
  /** Ширина пробела — для word-wrap calculation */
  space: number;
}

/** Кэшированные word widths для блока при данной версии шрифта */
export interface CachedWordWidths {
  blockId: number;
  fontHash: FontHash;
  widths: WordWidths;
}

/** Protocol сообщений с worker'ом */
export type WorkerMessage =
  | { type: "compute"; blocks: Array<{ id: number; title: string; body: string }>; fontHash: FontHash }
  | { type: "result"; widths: Array<{ id: number; widths: WordWidths }>; fontHash: FontHash }
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

export const COLUMN_MIN_WIDTH = 240;
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

Для каждого `block_type`:

- **image** — `columnWidth * (block.height / block.width)` если `block.width/height` задано; иначе `DEFAULT_CARD_HEIGHT` (240) как conservative fallback
- **video** — `columnWidth * 9 / 16` (фиксированный 16:9 + play overlay)
- **link** — `columnWidth * 9 / 16 + 76` (16:9 thumbnail + 76px text)
- **file** — `88` (фиксированная высота)
- **article** — используется `wordWidths`:
  - `titleLines = min(2, countLines(wordWidths.title, wordWidths.space, columnWidth - 32))`
  - `previewLines = min(block.first_image ? 3 : 8, countLines(wordWidths.preview, wordWidths.space, columnWidth - 32))`
  - `imageH = block.first_image ? columnWidth * 0.5 : 0`
  - `authorH = block.author ? 24 : 0`
  - `height = 32 + titleLines * 20 + 6 + previewLines * 18 + imageH + authorH + 28`

Если `wordWidths === null` для article (кэш ещё не готов), функция возвращает **conservative lower bound** — высоту при минимально возможном количестве строк (`titleLines=1, previewLines=3`). Это гарантирует что при последующем обновлении `wordWidths` реальная высота будет **не меньше** fallback'а → `totalHeight` может только расти → прыжков нет (scroll position остаётся валидным при росте контента).

### `src/lib/masonryLayout.ts` — расширение

Существующие функции `computeMasonryLayout`, `getMasonryColumnCount` остаются без изменений. Добавляются:

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
export async function getFontHash(): Promise<FontHash>;

/** Инвалидация кэша при смене font version */
export async function invalidateFontCache(): Promise<void>;
```

Алгоритм `fetchWordWidths`:

1. Проверить `document.fonts.ready` (если первый вызов)
2. Вычислить `fontHash` (кэширован после первого вычисления)
3. Открыть IndexedDB database `arena-font-metrics`, object store `wordWidths`
4. Для каждого блока проверить наличие в кэше по ключу `(blockId, fontHash)`
5. Собрать список `missing` блоков
6. Если `missing.length === 0` → вернуть Map из кэша
7. Иначе — отправить `missing` в worker через `postMessage`
8. Worker возвращает `WorkerResult`, записать в IndexedDB, добавить в Map
9. Вернуть объединённый Map

Worker вычисляет в chunks по 500 блоков, отправляет `progress` сообщения для UI.

### `src/workers/fontMetrics.worker.ts`

```ts
// OffscreenCanvas context init
const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d");
ctx.font = "14px 'Geist', system-ui, sans-serif";

function measureWord(word: string): number {
  return ctx.measureText(word).width;
}

function computeWordWidths(title: string, body: string): WordWidths {
  const preview = body.slice(0, 400);
  return {
    title: splitWords(title).map(measureWord),
    preview: splitWords(preview).map(measureWord),
    space: ctx.measureText(" ").width,
  };
}

self.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === "compute") {
    const results = event.data.blocks.map((b) => ({
      id: b.id,
      widths: computeWordWidths(b.title ?? "", b.body ?? ""),
    }));
    self.postMessage({ type: "result", widths: results, fontHash: event.data.fontHash });
  }
});
```

`splitWords` использует `Intl.Segmenter` для корректного word-breaking в CJK и emoji контексте, fallback на `str.split(/\s+/)` для латиницы.

### `src/lib/layoutCache.ts`

```ts
/**
 * LRU cache для layout каналов. Ключ — пара (blocks reference, parentWidth).
 * Инвалидация при изменении parentWidth или font version.
 */
export class LayoutCache {
  private map = new Map<string, MasonryLayout>();
  private maxSize = 10;

  key(blocks: LightBlock[], parentWidth: number): string;
  get(blocks: LightBlock[], parentWidth: number): MasonryLayout | null;
  set(blocks: LightBlock[], parentWidth: number, layout: MasonryLayout): void;
  clear(): void;
}
```

Ключ — `${blocks_identity_hash}:${parentWidth_rounded}`. `blocks_identity_hash` = hash from first and last block ids + length (быстрый identity check вместо полного content hash). `parentWidth_rounded` — до 10px бакета, чтобы мелкие resize не создавали новые записи.

### `src/hooks/useGridScroll.ts`

```ts
/**
 * Scroll state hook основанный на useSyncExternalStore.
 * Избегает React re-renders при каждом scroll event — компонент
 * ре-рендерится только когда меняется набор видимых items (не на каждый пиксель).
 */
export function useGridScroll(
  scrollElementRef: RefObject<HTMLDivElement>,
  getVisibleItems: (scrollTop: number) => MasonryPosition[],
): MasonryPosition[];
```

Реализация:
- Подписывается на `scroll` event через `addEventListener`
- В handler'е обновляет `scrollTopRef.current` и планирует RAF
- В RAF callback вычисляет `newVisible = getVisibleItems(scrollTopRef.current)`
- Сравнивает с предыдущим snapshot (reference equality ok если используем мемоизацию)
- Если отличается — вызывает `onStoreChange` → `useSyncExternalStore` триггерит re-render
- Если одинаковый — ничего не делает, React спит

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
- Фиксация line-height и font-size на `cardHeight.ts` константы (20px для title, 18px для preview, 14px base)
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
1. ResizeObserver fires на Grid container
2. Grid.tsx: parentWidth state updated
3. useMemoizedLayout: LayoutCache miss (новый parentWidth bucket)
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

1. **Никакого DOM measurement на hot path.** `getBoundingClientRect`, `clientHeight`, `offsetHeight` запрещены в Grid.tsx и всех его descendant'ах после mount'а. Исключение — один раз в `ResizeObserver` на parentRef для измерения width/height контейнера.

2. **Pure functions для layout computation.** `computeCardHeight`, `computeMasonryLayout`, `createVisibilityIndex`, `getVisibleItemsFromIndex` — все pure, без side effects, без DOM зависимостей. Тестируемы без jsdom.

3. **Scroll не триггерит React state change.** `scrollTop` живёт в ref, обновления проходят через `useSyncExternalStore` с memoized snapshots.

4. **Font loaded before first measureText.** Worker проверяет `document.fonts.ready` (через `self.fonts` в worker context если доступно, иначе через main thread signal).

5. **Word widths deterministic.** Для одной и той же пары `(text, fontHash)` `measureText` возвращает одно и то же значение (свойство браузера).

6. **LayoutCache invalidated on font change.** Если font hash меняется (обновление Geist Sans), весь `LayoutCache` + IndexedDB word widths инвалидируются.

7. **Grid-lanes path и JS path взаимозаменяемы.** Оба пути принимают одни и те же данные `(blocks, layout)` и производят визуально эквивалентный рендер. Пользователь не должен замечать переключения между ними.

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

## Migration plan

Реализация в 7 последовательных шагов. Каждый шаг — отдельный коммит, тестируется изолированно. Старый код остаётся рабочим до финального cleanup'а.

### Шаг 1: Инфраструктура font metrics

- Создать `src/workers/fontMetrics.worker.ts`
- Создать `src/lib/fontMetrics.ts` (client API)
- Создать `src/types/fontMetrics.ts`
- Юнит-тесты на `fontMetrics` client (с mock IndexedDB)
- Проверка: `fetchWordWidths([mockBlock])` возвращает `WordWidths` за ≤ 100ms на холодном кэше

### Шаг 2: Pure libs

- Создать `src/lib/wordWrap.ts` с `countLines`
- Создать `src/lib/cardHeight.ts` с `computeCardHeight`
- Юнит-тесты на оба (без DOM, чистые функции)
- Snapshot тесты для каждого типа блока с эталонными данными

### Шаг 3: Visibility index

- Добавить `createVisibilityIndex` и `getVisibleItemsFromIndex` в `src/lib/masonryLayout.ts`
- Юнит-тесты на корректность (сравнение с brute-force filter)
- Перф-тест: 10000 items → index lookup ≤ 0.2ms

### Шаг 4: Layout cache

- Создать `src/lib/layoutCache.ts`
- LRU с max size 10
- Юнит-тесты на eviction policy, keying

### Шаг 5: Scroll hook

- Создать `src/hooks/useGridScroll.ts`
- Юнит-тест на отсутствие ре-рендеров при scroll внутри текущего visible set

### Шаг 6: Rewrite Grid.tsx

- Интегрировать все новые модули
- Удалить старую measurement infrastructure (`measuredHeights`, `pendingHeightsRef`, `MeasuredGridItem`, `handleMeasure`, `flushPendingHeights`, `isScrolling` state, `SCROLL_IDLE_MS`, scroll anchoring logic — **всё целиком**)
- Добавить Path A (native grid-lanes) и Path B (virtualized JS) с feature detect
- Интеграционные тесты на react-testing-library

### Шаг 7: Card.tsx polish

- Добавить `will-change: transform`, `translate3d`
- Фиксация font-size, line-height в соответствии с `cardHeight.ts`
- Visual regression test (скриншоты эталонных карточек)

После шага 7 — **визуальная проверка пользователем на реальном vault'е** с замерами FPS через DevTools Performance Monitor.

---

## Edge cases

1. **Block без `width/height` метаданных (image)** — используется `DEFAULT_CARD_HEIGHT = 240` как conservative fallback. Backend task (отдельный PR) должен извлекать dimensions из image file при индексации и записывать в SQLite.

2. **Очень длинный title/preview в article** — слова, которые не влезают в column width целиком, разбиваются на символы через `Intl.Segmenter` на grapheme boundaries. Fallback на CSS `word-break: break-word` если `Intl.Segmenter` недоступен.

3. **Emoji в тексте** — `Intl.Segmenter` корректно обрабатывает ZWJ sequences. `measureText` возвращает корректную ширину для font'ов с emoji support.

4. **CJK текст без пробелов** — `splitWords` в `Intl.Segmenter("zh", { granularity: "word" })` mode возвращает грамматические слова для китайского. Для корректной работы в любой локали Worker использует granularity `"grapheme"` и fallback `"word"`.

5. **Font loading failure** — если Geist Sans не загружается, browser fallback на system UI font. `measureText` вернёт widths для fallback font, что даст корректное computation но не идеальное соответствие когда Geist наконец загрузится. Mitigation: перед первым `fetchWordWidths` ожидать `document.fonts.ready`, проверять что Geist Sans в `document.fonts.check("14px Geist")`.

6. **IndexedDB quota exceeded** — graceful fallback на in-memory Map, warn в консоль.

7. **Worker не доступен** (exotic browser) — synchronous main-thread fallback через `requestIdleCallback` chunks. Ухудшенный initial load UX, но функционально работает.

8. **Блок удалён, но есть в кэше** — при invalidation channel cache, stale entries в IndexedDB остаются. Периодический cleanup (раз в запуск) проходит по IndexedDB и удаляет entries, которых больше нет в `listBlocks()`.

9. **Resize во время initial load** — layout пересчитывается с текущим частичным `wordWidthsMap`. Блоки без ещё-не-вычисленных widths используют conservative fallback. Когда Worker возвращает результаты, layout пересчитывается ещё раз.

10. **Scroll position преодолевает конец ленты во время initial load** — если пользователь доскроллил до места где блоки ещё без точных wordWidths, layout использует conservative heights → position корректен (нет clamp'а). Когда widths приходят, heights могут только увеличиться (conservative = underestimate), `totalHeight` растёт → scroll position остаётся валидным.

---

## Тесты

### Unit tests (vitest)

- `wordWrap.test.ts` — countLines для разных входов
- `cardHeight.test.ts` — computeCardHeight для каждого block_type, edge cases
- `masonryLayout.test.ts` — уже существует, добавить тесты для visibility index
- `fontMetrics.test.ts` — моки IndexedDB + Worker через MSW/vi.fn
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

### 002: `useSyncExternalStore` вместо scroll state в `useState`

| Approach | Problem |
|---|---|
| `useState(scrollTop)` + setState в handler | Каждый scroll event триггерит React render, даже если видимые items те же. Лишняя работа, frame drops |
| **`useSyncExternalStore`** (chosen) | React ре-рендерится только когда snapshot меняется. Между changes React спит |

Rationale: `useSyncExternalStore` — канонический React 18+ API для subscribe to external store с проверкой изменений. Даёт нужную оптимизацию без хаков.

### 003: Bucket-based visibility index вместо Array.filter

| Approach | Problem |
|---|---|
| `positions.filter(p => p.intersects(window))` | O(N) на каждый scroll sample. 0.5ms для 10000 — терпимо, но суммируется. Не scale'ится на 100k |
| **Bucket index** (chosen) | O(k + B) где k = visible count, B = bucket count в range. ~0.1ms независимо от N |

Rationale: небольшой текущий gain, но архитектурная готовность к vault'ам размером >10k блоков. Реализация простая — одна функция.

### 004: LayoutCache LRU, ключ `(blocks identity hash, parentWidth bucket)`

| Approach | Problem |
|---|---|
| `WeakMap<blocks, layout>` | WeakMap автоматически собирается GC, нет LRU semantics, нет control над size |
| **LRU Map** (chosen) | Явный size limit, предсказуемая eviction, hit rate можно логгировать |

Rationale: channel switching — user-facing performance requirement. Нужна явная guarantee что последние 10 каналов доступны мгновенно.

### 005: Native grid-lanes path via feature detect, не polyfill

| Approach | Problem |
|---|---|
| Polyfill `display: grid-lanes` через JS | Polyfill всегда медленнее native, тратим усилия на обёртку для feature которая скоро шипится |
| **Feature detect + dual path** (chosen) | Автоматическая активация native когда браузер отгрузит поддержку. Пока — JS fallback. Zero maintenance при переходе |

Rationale: `display: grid-lanes` уже существует в Safari 26.4+. Chrome/Firefox скоро. К тому времени когда большинство пользователей обновятся, JS path станет dead code который можно удалить. Polyfill не даст этот upgrade path.

### 006: Conservative lower-bound fallback для unresolved heights

| Approach | Problem |
|---|---|
| Ждать полного wordWidths load перед первым рендером | Пустой экран на 500-2000ms, плохой UX |
| Оптимистический fallback с завышенными оценками | `totalHeight` сжимается при коррекции → прыжок |
| **Conservative lower bound** (chosen) | `totalHeight` только растёт при коррекции → scroll position всегда валиден → прыжков нет |

Rationale: соблюдает корневой принцип (никаких scroll jumps) даже в переходный период пока worker ещё работает. Пользователь видит первый рендер сразу, далее layout уточняется без видимых скачков.

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

1. Все 7 шагов migration plan'а реализованы и merged в main
2. Старая measurement infrastructure полностью удалена из Grid.tsx
3. Все unit-тесты проходят, performance targets выполняются
4. Визуальная проверка пользователем на реальном vault'е подтверждает:
   - Scroll плавный без прыжков
   - Resize сайдбара / окна — instant
   - Переключение каналов — мгновенно
   - Никаких визуальных regression'ов по сравнению с текущим рендером
5. DEVLOG entry с результатами проверки и benchmark numbers
6. `ARCHITECTURE.md` обновлён: добавлено decision record про zero-jank masonry
7. `PLAN.md` обновлён: phase mark как completed
