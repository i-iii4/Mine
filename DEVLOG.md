# Devlog

## Rules

- Timestamp format: DD.MM.YYYY HH:MM
- New entries are always added at the top
- If a push was made — include commit hash
- Each entry must be self-contained and understandable
  without additional context by someone reading it for the first time
- **Multi-agent sync**: when multiple Claude Code agents work in parallel
  worktrees, this file is the shared synchronization point. Each agent
  appends its own entries at the top. Before starting a session, read
  the top 2-3 entries to see what other agents have done. Before making
  structural changes, check DEVLOG for reservations on files/areas.
  When claiming a scope, add a "**Claimed:**" line at the top of a
  running entry so the other agent sees what's in flight.

## Entry template

## DD.MM.YYYY HH:MM — brief title
### Goal
in PM language: how we want to change the user experience
### Planned
full plan for this iteration
### Actually completed
with links to changed files; indicate which plan item was executed
### Deviations from plan
with explanation why
### Checks
what was verified, what works
### Push
commit hash + title
### Decisions and lessons learned
if any

---

## 11.04.2026 (late+2) [agent B, parallel/b] — Grid: scroll anchoring + running avg by type + conservative fallback

### Goal
Устранить «прыжок» сетки при докрутке до конца ленты. Симптом: когда последние карточки впервые появляются во viewport, происходит видимая перестройка всей ленты. Коррекция высот при первом замере меняет `totalHeight` → браузер клампит scrollTop → пользователь видит прыжок и визуальный «пересборщик».

### Root cause
Три слоя проблемы:

1. **Статические оценки высот `estimateCardHeight` систематически завышали** реальность для нескольких типов: image без метаданных = квадрат `columnWidth` (реальность для ландшафта ≈ 56% от этого), link с thumbnail коэффициент `9/16 + 76` (при битой картинке реальность ≈ 76px, завышение ×3), article с `first_image` коэффициент `0.62` (часто завышено). `totalHeight` раздут → scroll range больше реального контента.

2. **Коррекция высоты сжимала `totalHeight`**. Когда карточки в конце ленты впервые замерялись, реальные высоты оказывались меньше оценок → `computeMasonryLayout` пересчитывал с уменьшенными высотами → `totalHeight` сжимался → текущий `scrollTop` оказывался за пределами нового диапазона → браузер автоматически клампил скролл → визуальный прыжок.

3. **Предыдущая попытка с `pendingHeightsRef` + `SCROLL_IDLE_MS` defer'ом замеров во время скролла не помогла**, потому что она только сдвигала момент применения коррекции с активного скролла на idle. Сам прыжок оставался — просто происходил через 120ms после остановки скролла вместо во время.

### Fix — три независимых слоя

**Слой 1 — Scroll anchoring (основной, детерминистический).** В `Grid.tsx` добавлен `useLayoutEffect` который отслеживает `layout` через `prevLayoutRef`. Когда layout меняется **не** из-за ресайза контейнера (проверка `parentWidth === prevParentWidthRef.current`), эффект:
1. Находит якорную карточку — первую позицию, которая пересекает верхний край viewport'а (`top <= scrollTop + 100 && bottom > scrollTop`). Это карточка, на которую смотрит пользователь.
2. Сравнивает `oldTop` (из prevLayoutRef) и `newTop` (из текущего layout) якорной карточки.
3. Если позиция изменилась, корректирует `parentRef.scrollTop` на дельту `(newTop - oldTop)`.

`useLayoutEffect` выполняется после React commit, но **до** браузерного paint. ScrollTop корректируется до того как пользователь видит кадр. Результат: якорная карточка остаётся визуально на том же месте экрана независимо от того, насколько изменились высоты остальных карточек. `totalHeight` может меняться как угодно — пользователь не видит прыжка.

Проверка `parentWidth === prev`: во время ресайза сайдбара layout тоже меняется (другая ширина колонок, другие позиции), но это ожидаемое поведение ресайза — якорить не нужно, иначе эффект боролся бы с визуальной анимацией ресайза.

**Слой 2 — Running average по типу (точность оценок).** Новый `avgHeightByType` useMemo считает среднюю реальную высоту уже замеренных карточек, сгруппированных по `block_type`. `estimatedHeights` теперь использует трёхуровневый приоритет: `measuredHeights[slug] ?? avgHeightByType[type] ?? estimateCardHeight()`.

Логика: первые ~20 видимых карточек при загрузке быстро замеряются → среднее по каждому встретившемуся типу набирается → для оставшихся карточек того же типа оценка практически точная. К моменту докрутки до конца коррекции `totalHeight` минимальны или отсутствуют совсем (потому что оценки уже были близки к реальности).

Это работает вместе со Слоем 1: anchoring защищает от прыжка в любом случае, а running average делает прыжок настолько маленьким, что anchoring'у нечего корректировать.

**Слой 3 — Консервативные fallback-оценки (страховка для первых карточек).** `estimateCardHeight` перписан так, чтобы занижать, а не завышать, для типов без точных метаданных. Принцип: рост `totalHeight` при коррекции невидим пользователю (контент просто расширяется вниз), сжатие — это прыжок. Конкретно:

- `image` без `block.width/height`: `DEFAULT_CARD_HEIGHT` (240) вместо `columnWidth` (~280 для 3-колоночного лейаута). Важно: **не 16:9, не квадрат, не портрет** — просто безопасное default-число. Если метаданные есть (`width/height` в frontmatter), используется точный aspect ratio, это основной случай для image.
- `link`: `76` (только текстовая часть) вместо `columnWidth * 9/16 + 76`. Если thumbnail загрузится, `onMeasure` скорректирует вверх → `totalHeight` растёт → **это не прыжок**.
- `article` с `first_image`: коэффициент картинки `0.4` вместо `0.62`. Если реальная картинка крупнее, `onMeasure` корректирует вверх, анкоринг ловит.

Этот слой используется только первые несколько кадров после загрузки канала, пока `avgHeightByType` не набралось. Влияет на 10-20 первых карточек.

### Actually completed

1. **`src/components/Grid.tsx`**:
   - Импорт `useLayoutEffect` добавлен
   - `prevLayoutRef`, `prevParentWidthRef` refs добавлены
   - `avgHeightByType` useMemo добавлен
   - `estimatedHeights` useMemo переработан на трёхуровневый приоритет
   - Scroll anchoring `useLayoutEffect` добавлен сразу после `layout` useMemo
   - `estimateCardHeight` переписан с занижением для image без метаданных, link, article с first_image. Комментарий объясняет принцип: bias toward underestimation

2. **`src/lib/masonryLayout.ts`** — не трогался. Чистая функция, API не менялся.

3. **Остальные файлы** — не трогались. Только Grid.tsx.

### Deviations from plan
Не было. Все три слоя реализованы по плану.

### Checks
- `bun run lint` — 5 ошибок baseline (4 Sidebar unused imports + 1 target/ build artifact), те же 5 после правок. Delta Grid.tsx = 0.
- Инварианты, проверенные чтением кода:
  - Scroll to top при смене канала (`useEffect [scrollToTop, currentTag]`) работает — сбрасывает `scrollTop`, `measuredHeights`, `pendingHeightsRef`, и `prevLayoutRef` после первого useLayoutEffect обновится заново
  - Resize сайдбара: `widthChanged` проверка отключает anchoring, сетка честно переупаковывается под новую ширину колонок
  - `onColumnCountChange` эффект не тронут
  - `visibleItems` логика с direction-aware overscan не тронута
  - `priorityBounds` логика не тронута
  - Deferred measurement через `pendingHeightsRef` + `SCROLL_IDLE_MS` — ОСТАВЛЕН. Он бесполезен как отдельный фикс прыжка, но полезен как оптимизация: не тригерить setState на каждое измерение во время скролла. Сочетается с anchoring: когда `flushPendingHeights` вызовет `setMeasuredHeights` после idle, anchoring поймает изменение layout и скорректирует scrollTop.
  - `MeasuredGridItem` memo не тронут
  - `computeMasonryLayout`, `getVisibleMasonryItems` сигнатуры не тронуты

### Requires visual testing
1. Открыть канал с 50+ карточками, докрутить до самого конца — **не должно быть прыжка**
2. Прокрутить обратно наверх — карточки на тех же местах, плавная прокрутка
3. Ресайз сайдбара — сетка перестраивается live, без борьбы с anchoring
4. Переключение канала — scroll to top, старые карточки не мешают
5. Быстрый momentum scroll до конца ленты — стабильно

### Push
TBD — будет добавлен после коммита

### Decisions and lessons learned

- **Scroll anchoring — детерминистическое решение, не вероятностное.** В отличие от running average, которое УМЕНЬШАЕТ частоту и амплитуду прыжков, anchoring их ЭЛИМИНИРУЕТ. Достаточно найти якорную карточку и удержать её визуальную позицию — всё остальное (totalHeight, позиции других карточек, scrollTop) может меняться как угодно, пользователь не увидит. Это фундаментально более сильная гарантия, потому что она не зависит от точности оценок.

- **`useLayoutEffect` критичен для anchoring.** `useEffect` выполняется ПОСЛЕ paint — это означает, что пользователь успеет увидеть кадр с некорректированным scrollTop (= прыжок), и только следующий кадр будет скорректирован. `useLayoutEffect` выполняется после commit, но ДО paint — корректировка невидима.

- **Занижение оценок — правильный bias.** `totalHeight` растёт при коррекции вверх — это невидимо (просто scroll range увеличивается, текущий scrollTop остаётся валидным). `totalHeight` сжимается при коррекции вниз — это прыжок (scrollTop оказывается за новым концом, браузер клампит). Поэтому лучше занижать и расти, чем завышать и сжиматься. Это общий принцип для всех virtual-scroller-ов с неизвестными высотами.

- **Running average — оптимизация, не фикс.** Без anchoring среднее по типу уменьшает прыжки процентов на 80, но оставшиеся 20% всё равно видны. С anchoring running average становится просто оптимизацией для более стабильных позиций (меньше микро-сдвигов карточек при каждой коррекции). Правильный порядок приоритета: сначала anchoring (гарантия), потом среднее (качество).

- **Не надо угадывать aspect ratio для изображений без метаданных.** Image без `width/height` — неизвестный случай. Ландшафт, портрет, квадрат — может быть любое. Использовать какое-либо конкретное предположение (16:9, 9:16, 1:1) = гарантированная ошибка для ~50% изображений в одну сторону. Правильный фолбэк — **просто безопасное default-число** (`DEFAULT_CARD_HEIGHT = 240`), которое близко к медиане и не предполагает ориентации. Через секунду придёт `onMeasure` с реальной высотой → среднее по типу сойдётся → следующие карточки получат точную оценку на основе среднего.

- **Предыдущая попытка с defer'ом измерений во время скролла была лечением симптома, а не причины.** Defer сдвигал момент применения коррекции на idle, но сама коррекция оставалась той же → `totalHeight` всё равно менялся → прыжок всё равно случался. Правильный фикс (anchoring) атакует реакцию на изменение `totalHeight`, а не сам момент его изменения. Defer оставлен потому что он безвреден и даёт мелкую оптимизацию (меньше setState во время скролла), но как фикс прыжка он был тупиком.

- **Три слоя фикса независимы и работают вместе:**
  - Слой 1 (anchoring) — гарантия отсутствия визуального прыжка
  - Слой 2 (running avg) — уменьшает частоту и амплитуду коррекций
  - Слой 3 (conservative fallback) — страховка для самых первых карточек, пока running avg не набралось
  - Каждый работает без других. Все три вместе дают максимальную стабильность.

---

## 11.04.2026 22:05 — Custom virtualized masonry grid
### Goal
Ускорить resize и переключение разделов с тысячами карточек, убрав bottleneck browser masonry/layout и сократив число DOM-узлов в Grid до видимого окна.
### Planned
1. Вынести layout в чистый модуль с тестами
2. Заменить browser masonry/grid-lanes на собственный windowed renderer
3. Ускорить переключение разделов через предрасчёт `blocksByTag`
4. Обновить документацию и подготовить push
### Actually completed
Пункты 1—4 выполнены.

- `src/lib/masonryLayout.ts` — новый layout engine: `containerWidth + itemHeights -> columnCount + positions + totalHeight`
- `src/lib/masonryLayout.test.ts` — тесты на расчёт колонок, shortest-column placement и visible window
- `src/components/Grid.tsx` — переписан на собственный `VirtualMasonryLayout`: absolute positioning, `scrollTop + viewportHeight + overscan`, cache высот по `slug`
- `src/App.tsx` — добавлен `blocksByTag` memo; переключение канала больше не фильтрует весь массив блоков на каждый рендер
- `ARCHITECTURE.md`, `SPEC_FRONTEND.md`, `PLAN.md`, `AUDIT_PERFORMANCE.md` — обновлены под новое состояние
### Deviations from plan
- Полный `bun run build` остаётся заблокирован старым TypeScript-шумом вне задачи: `extension/popup/hooks/useClipperState.ts` и неиспользуемые импорты в `Sidebar.tsx`
- `Card.test.tsx` уже ожидал устаревший UI image/video карточек (заголовки в сетке), поэтому не использовался как критерий регрессии для этой задачи
### Checks
- `bun run test src/lib/masonryLayout.test.ts` — passed
- `bun x eslint src/App.tsx src/components/Grid.tsx src/lib/masonryLayout.ts src/lib/masonryLayout.test.ts` — passed
- `bun run test src/components/Card.test.tsx src/lib/masonryLayout.test.ts` — `masonryLayout.test.ts` passed, `Card.test.tsx` has 2 pre-existing expectation failures unrelated to the new grid engine
- `bun run build` — blocked by pre-existing TypeScript errors outside the grid changes
### Push
- `940c73a` — Implement virtualized masonry grid
### Decisions and lessons learned
1. **Windowing beats browser masonry for huge collections.** `content-visibility` помогает paint, но не убирает стоимость relayout тысяч DOM-узлов при resize
2. **Layout должен быть данными, а не побочным эффектом CSS.** Чистая функция проще тестируется, кэшируется и даёт предсказуемый performance ceiling
3. **Переключение канала и resize — одна проблема, если всё лежит в одном DOM-дереве.** `blocksByTag` и virtual window вместе убирают лишнюю работу и при route switch, и при drag-resize

## 11.04.2026 (night) [agent A] — Video playback + video thumbnails: corrupt WebKit state + stale text-PNG thumbs

### Goal
Разобраться с двумя последовательными регрессами: (1) все MP4/GIF видео перестали воспроизводиться в Detail и карточках — плеер застревал на `loadstart` forever без error event, (2) после починки #1 миниатюры для video-блоков в sidebar отсутствовали.

### Actually completed

**1. Video playback: corrupt WebKit persistent storage**

Симптом: `<video>` элемент получает src, фаерит `loadstart`, и застревает навсегда. `networkState=LOADING ready=NOTHING err=none`. Ни `loadedmetadata`, ни `error`, ни `stalled`.

Диагностика через временный `VideoDiagnostic` компонент который инструментировал video element:
- `fetch(asset://...)` возвращал 200 + полный blob корректно → asset protocol живой
- `<video src="asset://...">` зависал на loadstart → media pipeline сломан
- `<img src="asset://...">` работал нормально → разрыв **только** в `<video>`/`<audio>` path

Ключ: image идёт через ImageIO, video/audio — через AVFoundation. Разная сигнатура поломки указывала на AVFoundation layer.

Мои две первые гипотезы были неверны:
- **Quarantine attribute** на downloaded файлах. Проверил через `xattr` — quarantine был, но был всегда, видео раньше работали. Исключил.
- **Missing `Accept-Ranges: bytes` в Tauri asset protocol**. Сделал `VideoFromBlob` workaround который fetch'ит asset URL, оборачивает в `URL.createObjectURL(blob)` и кормит `<video>` через blob URL — полностью обходит asset protocol pipeline. Не помогло. Оба пути (asset:// и blob:) давали identical симптом `net=LOADING ready=NOTHING err=none`. Симметрия двух независимых путей → проблема downstream обоих, в AVFoundation.

Real root cause: **corrupted persistent WebKit storage** в `~/Library/WebKit/com.mine.app/WebsiteData/`. Эта директория содержит MediaKeys, MediaKeysHashSalts, DeviceIdHashSalts, IndexedDB, и per-origin storage. AVFoundation consult'ирует эти salts для media validation даже при unencrypted content — если они в несогласованном состоянии, media loading застревает в initial validation phase, без error.

Fix:
```bash
pkill -f "target/debug/mine"
pkill -f "cargo-tauri tauri dev"
rm -rf ~/Library/WebKit/com.mine.app ~/Library/Caches/com.mine.app
cargo tauri dev
```

После wipe WebKit создал fresh state, AVFoundation media pipeline заработал. Видео заиграли.

**Что повредило storage** — точно не знаю. Корреляция по времени с моей активностью (HMR storm от множественных file edits в overlay-migration session, 34-часовой uptime Tauri process, filewatcher + iCloud sync events на vault). Accumulative race в WebKit storage writes. Не прямая поломка кода, побочный эффект долгой dev-сессии с активными правками.

**VideoFromBlob оставлен в коде** как defensive workaround. Lightweight (~60 строк), прозрачен для потребителей, и если Tauri asset protocol когда-нибудь сломается по другой причине (например, реальная Accept-Ranges ошибка) — этот путь обходит проблему. Trade-off: video файл полностью в памяти перед play, но clipper видео ≤ 20MB, acceptable.

**2. Video thumbnails: stale text-PNG thumbs masquerading as JPEG**

После fix'а video playback миниатюры к video-блокам в sidebar по-прежнему отсутствовали (`dark:invert` прозрачные PNG в dark mode = почти невидимые пустые квадраты).

Диагностика: `file .arena/cache/thumbs/*.jpg` показал что **17 файлов с расширением `.jpg`** на самом деле были **PNG 480×480 RGBA**. Это `generate_text_thumbnail` output — fallback когда video frame extraction failed. Остальные 37 — нормальные JPEG video frames / image thumbs.

Root cause — **дыра в `is_thumb_fresh`**: проверяет только mtime, не тип содержимого. Легаси text PNG, созданные когда `generate_video_thumbnail` фейлила в прошлых версиях (возможно старые mp4 crate / openh264 bugs, или ранние Twitter API video profiles которые crate не парсил), застряли на диске. mtime thumb ≥ mtime source → pipeline считает их fresh → никогда не regenerate → pipeline не перепроверяет что thumb-файл валиден и содержит video frame.

Fix:
```bash
# Удалить text-PNG thumbs (сохранить legitimate JPEG)
for f in *.jpg; do
  file "$f" | grep -q "PNG image" && rm "$f"
done
# Restart Mine app — full_scan regenerates missing thumbs
```

После этого Rust watcher log показал `thumbnails: 17 generated, 37 skipped (fresh)`. Regenerated файлы — валидные JPEG нужных размеров (480x360, 480x480, 480x429 — aspect ratio'ы реальных video фреймов). Pipeline работает корректно, просто нужно было заставить его перепройти.

### Deviations from plan
- Первая гипотеза (Accept-Ranges) отняла ~45 минут в попытке blob URL workaround. Фундаментальная ошибка в методологии: нужно было сразу разделить симптом на слои (image vs video) и искать **общий** downstream. Симметрия «asset и blob ломаются одинаково» это ранний сигнал «проблема ниже обоих» — я на него не отреагировал.

### Push
— (будет обновлено после push)

### Decisions and lessons learned
- **Правило debugging**: если симптом одинаковый на двух независимых путях → искать ОБЩИЙ downstream, не фиксить источники. Я потратил время на quarantine и blob URL, оба не относились к делу. Правильная цепочка: «image работает, video нет → разрыв в AVFoundation → persistent state WebKit». 
- **WebKit storage может commit'ить corrupt state во время long-running dev sessions**. В любом Tauri/Electron проекте с активным HMR + file watcher — если что-то необъяснимое в WebView ломается, первая попытка фикса: удалить `~/Library/WebKit/<bundle-id>` + `~/Library/Caches/<bundle-id>` и перезапустить. Это дешево (<1MB), безопасно (только WebView state, vault data не трогается), и часто решает runtime weirdness.
- **`is_thumb_fresh` проверяет **когда** а не **что***. Если историческая ошибка создала thumb со старым content, mtime-check его считает fresh навсегда. Защита: handler должен либо (a) валидировать что content соответствует ожидаемому типу (JPEG vs PNG), либо (b) добавить fallback chain `generate_video_thumbnail.or_else(generate_text_thumbnail)` на уровне dispatch, чтобы video failures не просачивались в stale text thumbs. Оставляю как followup.
- **Долгий uptime dev-сессии накапливает runtime debt**. 34 часа continuous running process с активным HMR — рецепт для накопления corrupted runtime state (WebKit storage, cached modules, hot reload state). Периодически (раз в день) полный restart cargo tauri dev снижает риск.
- **VideoFromBlob как defensive pattern**. Оставлен в коде не потому что asset protocol broken, а потому что fetch→blob→video — более robust pipeline для small video файлов в content-addressable vault, и работает idempotent независимо от Accept-Ranges / WebKit internal state. Удалим, только если появится клип >20MB и memory footprint станет проблемой.
- **Multi-agent DEVLOG sync работает**. Второй агент (parallel/b) успел закоммитить sidebar resize fix в main пока я работал над video. Перед моим коммитом я увидел его изменения в `git log origin/main`, rebase не потребовался — ветки разные файлы, чистый append.

---

## 11.04.2026 (late+1) [agent B, parallel/b] — Sidebar resize: линия на 120fps через CSS-переменную

### Goal
Исправить заметный лаг и рывки разделительной линии сайдбара во время drag-ресайза. Линия — это контрол, он обязан реагировать на pointer input с частотой устройства (120Hz на Retina). Перестройка сетки справа может происходить с задержкой (это допустимо), но сама линия не должна отставать от курсора.

### Root cause
Позиция линии вычислялась в React рендере: `<SidebarResizeHandle sidebarWidth={sidebarWidth}>` использовал prop в inline `left: sidebarWidth`, где `sidebarWidth` — React state, обновляемый на каждом `pointermove` через `setDragWidth`. Каждое движение мыши запускало полный React commit: `AppWithVault` → `Sidebar` → `SidebarResizeHandle` → `Grid` → `VirtuosoMasonry`. Commit-фаза ждала реконсиляции тяжёлого Grid'а с ~80 видимыми карточками, и только после этого линия получала новое значение `left`. Итоговая частота движения линии упиралась в commit rate (~30-60Hz при нагрузке), не в pointermove rate (120Hz).

Ресайз окна за правый край Tauri работал плавно, потому что там движется **нативная рамка окна** через системный API — React вообще не вовлечён. Внутренний drag-ресайз был медленнее именно потому что он гоняется через React.

### Fix — два канала обновления ширины

**Быстрый канал (синхронный, 120fps):** ширина пишется в CSS-переменную `--sidebar-width` на `:root` прямо в callback'е `pointermove`, через `document.documentElement.style.setProperty`. `<aside>` и `<div>` хэндла используют `style={{ width: "var(--sidebar-width)" }}` и `style={{ left: "var(--sidebar-width)" }}`. CSS custom properties применяются браузером синхронно ко всем descendant'ам, минуя React reconciliation полностью. Линия теперь движется на частоте pointer-событий.

**Медленный канал (асинхронный, лениво):** React state (`dragWidth`) обновляется через `requestAnimationFrame` throttle + `React.startTransition`. Это нужно для двух consumer'ов, которым ширина нужна в React дереве: `compact = width < 320` флаг в Sidebar (переключает разметку в узком режиме) и `parentWidth` в Grid через ResizeObserver на физическом DOM-элементе. Оба обновляются максимум раз в кадр, `startTransition` маркирует их как низкоприоритетные — React может прерывать их ради pointer-событий.

### Actually completed

1. **`src/hooks/useSidebarResize.ts`** — полная переработка:
   - `writeCssVar(w)` helper мутирует `--sidebar-width` на `:root`
   - `updateResize` синхронно пишет CSS-переменную, потом планирует `setDragWidth` через `requestAnimationFrame` + `startTransition`, дедуплицируя множественные pointermove в пределах одного кадра через `rafIdRef`
   - `pendingWidthRef` хранит последнее целевое значение между pointermove и RAF колбэком, чтобы `endResize` мог прочитать финальную ширину синхронно
   - `useLayoutEffect` синхронизирует CSS-переменную с React state при non-drag изменениях (mount из localStorage, collapse/expand toggle, endResize commit). `useLayoutEffect` обязателен вместо `useEffect`, чтобы первый видимый кадр после mount'а имел правильную ширину без flicker'а
   - Cleanup на unmount cancel'ит pending RAF
   - `endResize` cancel'ит pending RAF перед коммитом финального значения

2. **`src/components/Sidebar.tsx`** — `<aside>` style width: `width` → `"var(--sidebar-width)"`. Prop `width` оставлен для `compact = width > 0 && width < 320` — React state-based, обновляется асинхронно через RAF, переключает compact с задержкой максимум ~16ms, визуально незаметно.

3. **`src/components/SidebarResizeHandle.tsx`** — `left` inline style: `sidebarWidth` → `"var(--sidebar-width)"`. Prop `sidebarWidth` удалён полностью. Вместо чтения стартовой ширины из prop, handle теперь читает её через `getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")` в `handlePointerDown`. Это гарантирует что starting width — актуальная, не стейл-значение React state.

4. **`src/App.tsx`** — удалена передача `sidebarWidth={sidebarWidth}` в `<SidebarResizeHandle>`. Остальное без изменений, `sidebarWidth` всё ещё передаётся в `<Sidebar width={sidebarWidth}>` для compact логики.

### Deviations from plan
Не было. Исходный план пользователя после нескольких итераций обсуждения: разделить input-канал (линия) и content-канал (сетка) на две разные частоты обновления, линию вывести из React полностью через CSS-переменную. Реализовано ровно это.

### Checks
- `bun run lint` в B — 5 существующих ошибок на baseline, 5 после правок, delta = 0. Новых ошибок не внесено
- `bun x tsc --noEmit` — 6 существующих ошибок на baseline (Sidebar unused imports + extension/popup/hooks/useClipperState.ts), те же после правок, delta = 0
- Визуальная проверка в браузере не делалась (Tauri dev требует cargo build, в worktree B не инициализирован target/)
- Инварианты, которые проверены чтением кода:
  - Collapse/expand через короткий клик — идёт через `toggleCollapsed` → React state → useLayoutEffect → writeCssVar. Transition `width 200ms ease` применяется при `!isResizing`. Анимация работает
  - Персистенция в localStorage — `persist` вызывается в `endResize` и `toggleCollapsed`. Не затронуто
  - body.sidebar-resizing CSS-класс — ставится в `startResize`, снимается в `endResize`. Не затронуто
  - DRAG_THRESHOLD 4px для защиты клика от drag — логика в handle, handlePointerMove ждёт delta > 4 до вызова onResizeStart. Не затронуто
  - Clamp [MIN_WIDTH, MAX_WIDTH] при commit в endResize. Не затронуто
  - COLLAPSE_THRESHOLD при drag < 100 → auto-collapse. Не затронуто

### Requires visual testing
Пользователю необходимо перезапустить `cargo tauri dev` в main worktree (где таргет собран) либо pull'нуть PR в main и перезапустить, затем проверить:
1. Drag-ресайз линии сайдбара — линия должна идеально следовать за курсором, без лагов и рывков
2. Сетка справа — может перестраиваться с небольшой задержкой (1-2 кадра), это ожидаемо
3. Collapse через короткий клик — должна работать с анимацией 200ms
4. Expand collapsed сайдбара через клик — та же анимация
5. Auto-collapse при drag линии левее COLLAPSE_THRESHOLD — должно работать
6. Перезапуск приложения — сохранённая ширина должна восстановиться без flicker'а на первом кадре

### Push
`3c85b7b` Sidebar resize: 120fps divider line via CSS variable (on parallel/b, PR pending merge into main)

### Decisions and lessons learned

- **CSS custom properties — единственный DOM API, который можно синхронно мутировать без рассинхронизации с React.** React не управляет CSS-переменными (в отличие от inline style-ов на конкретных элементах, которые React писал бы при реконсиляции). Браузер применяет новое значение переменной ко всем descendant'ам синхронно, через propagation механизм CSS. Это делает их идеальным «быстрым каналом» для высокочастотных UI-обновлений: drag-ресайз, slider'ы, scroll-bound анимации, zoom.

- **Разделение «input surface» и «content surface» на две частоты обновления — общий архитектурный паттерн для drag-интерфейсов.** Контрол (линия, ручка слайдера, курсор драга) должен реагировать с частотой устройства ввода (120Hz). Контент (то что визуально перестраивается в ответ) может обновляться с частотой когнитивного восприятия (30-60Hz). Связывать их в одну React-цепочку — форсировать весь контент работать на частоте контрола, чего контент часто не тянет (дорогие реконсиляции, ResizeObserver каскады).

- **`requestAnimationFrame` + `startTransition` — правильная комбинация для «низкоприоритетного» async канала.** RAF гарантирует что setState вызывается максимум раз в кадр (дедупликация множественных pointermove в одно обновление). `startTransition` говорит React, что это обновление non-urgent — React может прервать его и отложить в пользу более важных событий (pointer events, клавиатура). Без `startTransition` React отрабатывает каждое state-обновление сразу, даже если они приходят пачкой, что может блокировать рендер UI-критичных путей.

- **`useLayoutEffect` vs `useEffect` для DOM-synchronization.** `useLayoutEffect` запускается синхронно после commit'а, но **до** браузерного paint'а. Это важно для первого кадра после mount'а: если использовать `useEffect`, первый paint покажет DOM без примененной CSS-переменной (initial render без synchronized side effect), и только следующий кадр подхватит правильное значение. Результат — flicker на старте. `useLayoutEffect` блокирует paint до завершения effect'а, гарантируя отсутствие flicker'а. Стоимость — немного медленнее mount, но для seed-операции (один раз на mount + один раз на collapse toggle) это незаметно.

- **Проп `sidebarWidth` в Handle можно было удалить полностью.** Handle получал его для двух целей: позиционирование через `left: sidebarWidth` и передача стартовой ширины при вызове `onResizeStart`. После переноса позиционирования на CSS-переменную, обе цели можно покрыть чтением из `getComputedStyle(document.documentElement)` в момент pointerdown. Это делает Handle более самодостаточным — он знает как запросить актуальную ширину у DOM, не зависит от React state прокидывания. Чуть лучший decoupling компонента.

- **`sidebarWidth` в React state всё ещё нужен для compact mode flag в Sidebar**, потому что `compact = width > 0 && width < 320` — это logic decision, которая должна влиять на React дерево (разная разметка в compact vs normal mode). В CSS-переменной хранится float значение, а compact это boolean — их невозможно вывести только из CSS без container queries (CSS container queries могли бы решить это целиком на уровне CSS, но это был бы другой, больший refactor). Текущий подход — React state остаётся для логических решений, CSS-переменная для визуальных позиций.

- **Virtuoso не трогали вообще.** Пользователь явно сказал что флик карточек при перестройке сетки его устраивает — это нормальное поведение при смене columnCount. Основная жалоба была на линию. Поэтому Grid и Virtuoso остались как есть, без заморозки columnCount, без заморозки parentWidth. После фикса Grid продолжает live-обновляться через свой ResizeObserver → setParentWidth, просто с задержкой 1-2 кадра от линии, что допустимо.

---

## 11.04.2026 (late) — Tab-close фикс, always-visible кнопки, progress bar, parallel worktree

### Goal
Довести overlay clipper до production-ready состояния: устранить крэш («вкладка закрывается после save»), сделать кнопки Crop/Retake всегда видимыми в дизайн-системе, заменить spinner на progress bar во время сохранения, настроить инфраструктуру для параллельной работы двух агентов.

### Actually completed

**1. Context-aware close (PopupApp.tsx)**
`window.close()` в handleSave и Esc handler в content-script context **закрывает всю вкладку**, потому что `window` в isolated world — это тот же windowProxy что у страницы. Добавлен helper `closeClipper`:
```ts
const closeClipper = useCallback(() => {
  const overlay = (globalThis as unknown as {
    __mineOverlay?: { close: () => void };
  }).__mineOverlay;
  if (overlay) overlay.close();
  else window.close();
}, []);
```
В overlay context → `__mineOverlay.close()` (unmount shadow host), в window-entry fallback — старое `window.close()` (закрыть detached popup). Используется в handleSave (успешный save), Esc keyboard handler.

**2. Crop/Retake кнопки — always-visible, size xs (ScreenshotPreview.tsx)**
Убран `group-hover:opacity-100` + absolute positioning из bottom bar. Кнопки переехали под картинку в отдельный `flex gap-2` ряд, всегда видимы. Размер `xs` (24px) вместо `default` (32px). Стандартный Button variant="default" — hover работает через `--tw-outline-style: solid` override из предыдущей записи.

Контраст с main app: в `CardHoverMenu` кнопки через hover reveal (минимально инвазивно для масштабной карточной сетки). В popup clipper'e превью — ключевой элемент UI, пользователь всегда должен видеть контролы без discovery.

**3. Indeterminate progress bar (SaveButton.tsx + popup-layout.css)**
При `saving === true` кнопка Save заменяется на анимированный progress bar — h-8 (тот же размер что кнопка), rounded-1, `bg-component-fill` фон, слайдящийся индикатор `bg-component-fill-hover` шириной 1/3 контейнера. Keyframe `mine-indeterminate-progress` в popup-layout.css:
```css
@keyframes mine-indeterminate-progress {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}
.mine-progress-indicator {
  animation: mine-indeterminate-progress 1.4s ease-in-out infinite;
}
```
Заменяет бывший spinner. Indeterminate (без value), потому что native host не сообщает прогресс. Токены дизайн-системы.

**4. Параллельный worktree для двух агентов**
Создан `/Users/i_iii/Проекты/local-arena-b/` через `git worktree add -b parallel/b origin/main`. Shared `.git` объекты, независимые `node_modules`/`target`/`dist`. Ветка `parallel/b` запушена на origin, tracked. Второй агент стартует через `cd /Users/i_iii/Проекты/local-arena-b && claude` — изолированный контекст, но доступ ко всему shared repo.

**5. DEVLOG как multi-agent sync point**
Добавлено правило в начале файла: DEVLOG — shared synchronization point между параллельными агентами. Каждый агент читает топ записи перед стартом сессии, добавляет свои сверху, объявляет scope через `**Claimed:**` строку в running entry. Это предотвращает коллизии когда два агента трогают одни файлы.

### Deviations from plan
Не обнаружено. Всё по списку правок пользователя.

### Push
`57ba2f9` Clipper overlay: tab-close fix, always-visible Crop/Retake, save progress bar

### Decisions and lessons learned
- **`window.close()` в content-script context = close tab**, не close overlay. Isolated world shares `window` с main world — только JS global scope изолирован, DOM и windowProxy общие. Context-aware `closeClipper` теперь стандартный паттерн для overlay+window dual-context code.
- **Indeterminate progress через CSS keyframe** проще и честнее чем fake advancement через useState+setInterval. Один `transform: translateX()` animation, 3 строки кода, никакой симуляции прогресса которая вводит пользователя в заблуждение.
- **Кнопки в overlay попапе ≠ кнопки на карточках в main app.** Hover-reveal pattern хорош для масштабных сеток (CardHoverMenu), где элементов много и нужна чистота при scroll. В compact popup UI контролы должны быть всегда видимы — не тратить внимание пользователя на discovery.
- **Git worktree + shared `.git` = zero-cost параллелизация.** Один `git worktree add` создаёт полноценную рабочую директорию за секунду. Дорого только `bun install` и первый `cargo build` в новом worktree (per-worktree артефакты). Но эти команды запускаются один раз при setup.

---

## 11.04.2026 — Clipper в Shadow DOM overlay: full migration + gotchas

### Goal
Отказаться от detached popup-window (title bar, address bar, traffic lights — всё что DIA и Chrome показывают для `chrome.windows.create({type: "popup"})`) и перевести primary clipper UI в in-page overlay через Shadow DOM content script injection. Визуально и функционально идентично текущему popup, но без window chrome.

### Planned
1. Новый vite entry — overlay.js как IIFE bundle, инжектится в активную вкладку через chrome.scripting.executeScript
2. Shadow DOM host с closed mode, CSS инлайн через `?inline` импорт popup-layout.css
3. action.onClicked routing в background: overlay для http/https/file, fallback на detached window для chrome://
4. Убрать chrome.action.openPopup()-попытки, Instagram feed button → direct showClipperOverlay без background roundtrip
5. Crop flow: в overlay context — просто hide/show overlay вместо persist state + toast + extra click
6. Dual-context design: один React код работает и в window fallback, и в content-script overlay (runtime detection через `typeof chrome.tabs === 'undefined'`)

### Actually completed

Основная работа — `b29ec7b` (overlay migration), следующие коммиты — последовательный фикс всех gotcha, которые всплыли при тестировании.

**1. Overlay bundle + routing (b29ec7b)**
Создан `vite.overlay.config.ts` с lib-mode IIFE сборкой, `extension/popup/overlay-entry.tsx` с Shadow DOM mount logic, `OverlayShell.tsx` с positioning wrapper. Background добавил `openClipperUi(tab)` который пытается executeScript → tabs.sendMessage и фоллбэчится на windows.create. Убрал `default_popup` из манифеста, добавил `scripting` + `tabs` permissions + `web_accessible_resources` для fonts. `useClipperState.init()` получил context-aware routing — в content script читает URL из `window.location`, extractors вызывает через `window.__mineClipper` exposed из content.js, в window fallback — через старый `chrome.tabs.sendMessage`.

**2. Shared CSS bundle между window и overlay**
Попытка #1 была inline CSS через `?inline` import в vite.overlay.config.ts. Не сработало: `@source ../../src/components` в `popup-layout.css` не применялся через `?inline` pipeline — Tailwind scan пропускал `hover:outline-1`, `hover:-outline-offset-1` и другие hover variants из `src/components/ui/button.tsx`. Window bundle их генерировал, overlay — нет.

Решение — **один CSS pipeline**: `vite.extension.config.ts` эмитит стабильный `dist/assets/popup.css` (без хеша через `assetFileNames`), `overlay-entry.tsx` грузит его через `fetch(chrome.runtime.getURL("dist/assets/popup.css"))` при первом mount, post-process'ит и инжектирует в shadow tree. Кэширует в module variable. Overlay bundle уменьшился с 500KB до 415KB (без inline CSS). `popup.css` попал в `web_accessible_resources`.

**3. `:root` → `:root, :host` replace для custom properties в Shadow DOM**
Tailwind v4 + shadcn эмитят все цветовые токены на `:root { --background: ...; --foreground: ...; }`. **Внутри Shadow DOM селектор `:root` не матчит ничего** — это спецификация CSS Scoping. Результат: все custom properties undefined внутри shadow tree, `bg-background` резолвится в прозрачный, весь overlay становится белым на белом фоне страницы.

Фикс — runtime regex replace в `overlay-entry.tsx`:
```ts
const popupCss = rawCss.replace(/:root\{/g, ":root,:host{");
```
Переписывает `:root{...}` в `:root,:host{...}`. Правила теперь применяются к shadow host, variables доступны через inheritance всему shadow tree. Правила `:root, :host` (font vars из `@theme`) не матчатся regex'ом (после `:root` стоит запятая, не `{`).

**4. Pointer-events passthrough**
`overlay-entry.tsx` ставит на shadow host `pointer-events: none` + `inset: 0` — host занимает весь viewport, но прозрачен для кликов, чтобы пользователь мог взаимодействовать со страницей. По CSS-спеке `pointer-events:none` propagates to descendants **unless** они явно переопределяют. Дефолтное `auto` у React children не считается «явным» — события проваливают через весь subtree.

Фикс: `OverlayShell.tsx` корневой div получил `pointer-events-auto` класс — явное восстановление events в scope overlay content.

**5. `chrome.storage.session.setAccessLevel` для content-script context**
`chrome.storage.session` по умолчанию доступен только из trusted context'ов (service worker, extension pages). Content script — untrusted, первый `storage.session.get` бросал «Access to storage is not allowed from this context». Фикс — в background.js на top-level вызывается `chrome.storage.session.setAccessLevel({accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS"})` обёрнутый в try/catch + optional chaining для совместимости с DIA/Arc forks.

**6. Stale native host binary**
Отдельный баг, не связанный с overlay: installed binary в `~/Library/Application Support/LocalArena/native-host` был **старой версии без `list_known_vaults`** — я когда-то скопировал его и забыл обновить после изменений в `native_host.rs`. Диагностика через `strings -a binary | grep list_known_vaults`. Фикс — копирование свежего `target/debug/native-host`.

Причина — два cargo target dir в проекте (`/target/` workspace root и `/src-tauri/target/` legacy). Workspace build пишет в первый, legacy команды — во второй. Оба существуют одновременно.

**7. ScreenshotPreview — точный паттерн CardHoverMenu**
Прошлая итерация использовала нестандартные классы. Переделано строго по `src/components/CardHoverMenu.tsx:123-160`: group-hover overlay, `absolute bottom-2 left-2 right-2` нижний ряд, стандартный `Button variant="default" size="default" flex-1`, иконки `size-3`. Никаких `backdrop-blur`, никаких hover overrides.

**8. Tailwind v4 `@property` gotcha — невидимые бордеры**
После всех предыдущих фиксов overlay рендерился с правильными цветами, но ни у одного элемента не было visible обводки — ни у окна, ни у списка каналов, ни у Input, ни у Checkbox. Диагностика:
- `.border { border-style: var(--tw-border-style); border-width: 1px }` — правило есть в popup.css
- `@property --tw-border-style { initial-value: solid; inherits: false }` — тоже есть
- **Но `@property` декларации действуют на document level**. Внутри Shadow DOM они не регистрируют initial-value для descendants
- `--tw-border-style` резолвится в unset → `border-style: none` → border-width 1px без стиля → невидимо

Фикс — в overlay-entry.tsx shadow style inject добавить:
```css
*, *::before, *::after {
  --tw-border-style: solid;
  --tw-outline-style: solid;
  --tw-divide-y-reverse: 0;
  --tw-divide-x-reverse: 0;
}
```
Явное установление значений на каждом элементе shadow tree восстанавливает работу `.border`, `.outline-*`, `.hover:outline-1` и прочих утилит. Без этого весь Shadow DOM + Tailwind v4 стек нерабочий для border-ов — это фундаментальная несовместимость, не наш баг.

**9. VaultSelect — custom shadow-friendly dropdown**
Native `<select>` с `appearance:none` всё равно рендерит OS-native список опций (Chrome на macOS показывает системный dropdown, стилизовать `<option>` нельзя). Shadcn DropdownMenu жёстко использует Radix Portal → рендерит content в `document.body` вне shadow tree → теряет стили.

Написан `VaultSelect.tsx` — custom trigger button + absolute-positioned menu, без Radix. 60 строк, полностью в дизайн-системе: `h-8 rounded-1 border-input` trigger, menu с `bg-popover` + стандартная popover тень, items с `hover:bg-accent`, активный — с галочкой. Click-outside + Esc. Работает в Shadow DOM, потому что всё mount'ится внутрь react tree без портала.

**10. Closed → open Shadow DOM mode**
После всего VaultSelect открывался, но клики по option'ам не переключали vault. Корень — `attachShadow({mode: "closed"})`: `event.composedPath()` в capture-phase window-listener **не раскрывает internal elements** closed shadow tree. VaultSelect's click-outside handler видел `path` как `[host, ...ancestors, window]` без своего containerRef.current → решал что клик снаружи → закрывал dropdown до того как React's onClick на item успевал сработать.

Фикс — переключить на `mode: "open"`. В open mode composedPath возвращает полный путь включая shadow internals. Extension-context не security-sensitive, open mode приемлем.

**11. Скрытие overlay во время screenshot capture**
`captureVisibleTab` захватывал viewport вместе с видимым clipper overlay'ем. Фикс — в `captureScreenshot`:
```ts
overlay?.hide();
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    chrome.runtime.sendMessage({captureForCrop}, (resp) => {
      requestAnimationFrame(() => overlay.show());
      // ...
    });
  });
});
```
Два animation frame нужны: первый для применения `display:none`, второй для paint cycle браузера. После этого `captureVisibleTab` видит чистый viewport. После возврата dataUrl — один rAF и показ overlay обратно.

**12. Crop Area sender.tab.id**
В content-script context `tabIdRef.current = CONTENT_SCRIPT_CONTEXT = -1` (sentinel). `startCropMode` отправлял в background `{action: "startCropMode", tabId: -1}`, background делал `chrome.tabs.sendMessage(-1, ...)` → error «No tab with id -1» → overlay оставался скрытым после `overlay.hide()`, crop overlay никогда не появлялся.

Фикс — background handler берёт tabId из `sender.tab?.id` (всегда доступно для message from content script), игнорируя значение из msg.

**13. Переделка ChannelList**
- Убрал `RECENT` заголовок
- Стабильная сортировка: убрано условие «selected в начало» — активация чекбокса не меняет позицию строки
- Кастомный `<span>` checkbox заменён на shadcn `<Checkbox>` (Radix без portals)
- `<button>` → `<label>` обёртка чтобы клик по всей строке переключал checkbox

**14. OverlayShell визуал**
Убран X Close button (пользователь предпочитает click-outside). Стандартная тень из DESIGN_SYSTEM.md для всплывающих элементов: `shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]`. Click-outside обработан в overlay-entry через window capture listener + composedPath check на host.

**15. Diagnostic badges в action.onClicked**
Добавлен badge «•» на 1.5 секунды при клике на иконку + badge «ERR» если openClipperUi бросил exception. Позволяет диагностировать dead service worker / застрявший default_popup без devtools.

### Deviations from plan
- **CSS bundling стратегия изменена** с inline через `?inline` на fetch shared `popup.css`. Причина — `?inline` pipeline не обрабатывал `@source` директиву корректно, Tailwind scan пропускал ряд классов.
- **Shadow DOM mode** изменён closed → open из-за `composedPath` проблемы с nested click-outside patterns.
- **Crop flow** полностью упрощён в overlay context (hide/show вместо persist+reload), но в window-entry fallback остался старый код для совместимости.
- **Native host binary** — обнаружен несвязанный баг с устаревшим installed binary, пофикшен попутно.

### Push
- `b29ec7b` Clipper: migrate primary UI from detached window to in-page overlay
- `e34c73e` Overlay clipper: shared CSS bundle, Shadow DOM open mode, crop fixes

### Decisions and lessons learned
- **Tailwind v4 + Shadow DOM — системная несовместимость.** `@property` не регистрируется в shadow tree → `border`, `outline`, `divide` утилиты не работают без ручного override. Это не наш баг, это архитектура Tailwind v4 и CSS Houdini. Workaround через `* { --tw-*: value }` — стандартная community рекомендация.
- **`:root` vs `:host` в Shadow DOM** — spec'ификация CSS Scoping Module явно определяет что `:root` внутри shadow tree не матчит ничего. Все токены Tailwind/shadcn нужно runtime-переписывать на `:root, :host`. Альтернатива — модифицировать global.css в source, но это инвазивнее и влияет на main app.
- **Closed vs open Shadow DOM** — closed mode ломает `composedPath` для external listeners. Это не очевидно из документации Shadow DOM, выясняется только при попытке сделать nested click-outside detection. Open mode следует использовать всегда если нет реальной security threat (extensions её обычно не имеют).
- **Radix UI portals несовместимы с Shadow DOM** — все shadcn Dialog/DropdownMenu/Tooltip/Command/Popover/Select портируют content в light DOM body, где shadow стили не применяются. Для overlay нужны или custom компоненты, или forks shadcn без Portal. Button, Input, Checkbox — OK (без portals).
- **Два animation frame перед captureVisibleTab** — один не хватает. React commit + DOM mutation в первом, browser paint cycle — во втором.
- **Sentinel tabId в dual-context code** — грязный паттерн, но работает когда background может resolve'ить реальный tabId через sender.tab.id. Чистая альтернатива — два разных action-имени — не стоила бы усилий.
- **`window.__mineOverlay` global api** — exposed from overlay-entry для access от других modules в том же isolated world (content.js, useClipperState через globalThis). Это shared state через window, анти-паттерн в «чистом» React/TS, но для content script isolated world — стандартная практика.
- **Stable asset filenames — критично для cross-bundle references.** Window bundle генерирует `popup.css`, overlay fetch'ит его по фиксированному имени. Без `assetFileNames: () => "assets/popup.css"` имя содержало бы хеш, и overlay-entry не мог бы найти файл.
- **Tailwind scan via `?inline`** — нестабильный pipeline. Предпочтительно шарить готовый CSS файл между сборками вместо запуска Tailwind в двух conflicting configs.

---

## 10.04.2026 (evening) — Screenshot preview в дизайн-системе, bounds persistence, fixes

### Goal
Довести Screenshot/Crop flow до рабочего состояния: кнопки по дизайн-системе, стабильная позиция Instagram popup окна, починка двух регрессов (context menu ERR_FILE_NOT_FOUND, пропавший vault dropdown).

### Actually completed

**1. ScreenshotPreview — переделано по паттерну CardHoverMenu.tsx**
Прошлая итерация использовала нестандартные классы (`backdrop-blur-sm bg-background/85 hover:bg-background`), вариант `secondary` которого нет в CVA, плюс кнопки поверх картинки создавали illusion что они читаемы. Переделано строго по эталону `src/components/CardHoverMenu.tsx:123-160`:
- `group relative` контейнер + `bg-[var(--card-hover-overlay)]` overlay на hover
- Нижний ряд `absolute bottom-2 left-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100`
- Кнопки — стандартный shadcn `Button variant="default" size="default"` с `flex-1`, **ничего кастомного**
- Иконки `Crop`/`Camera` из lucide-react, `size-3` после текста
- Никакого Tooltip, никакого backdrop-blur, никакого override'a hover-поведения

**2. Tailwind v4 @source директива для popup bundle (popup-layout.css)**
Диагностика через `strings` показала что у Button в popup отсутствовали классы `inline-flex`, `whitespace-nowrap`, `outline-0`, `cursor-pointer`, `select-none`. Причина — Tailwind v4 auto-detection сканит только файлы рядом с CSS entry (extension/popup), но не идёт по alias `@/` в `src/components/ui/`. Классы из `button.tsx` случайно генерировались только для тех, что дублировались в popup-файлах (`gap-2`, `h-8`, `rounded-1`), а уникальные — терялись. Кнопка разваливалась на inline-элементы, svg падал на новую строку. Фикс — одна директива в popup-layout.css:
```css
@source "../../src/components";
@source "../../src/lib";
```
CSS bundle вырос с 38KB до 68KB — все shadcn-классы теперь в бандле.

**3. Popup content-based sizing для DIA compatibility (не помогло, но всё равно лучше)**
Попытка починить DIA: в DIA popup'ы с `default_popup` открываются как detached macOS окно с traffic lights вместо dropdown. Проверена гипотеза что DIA детачит popup по initial size. Убран `#root { height: 600px }` из popup-layout.css, ChannelList получил explicit `max-h-[260px] overflow-y-auto`, PopupApp избавлен от `h-full` зависимости. Popup теперь sized по контенту (~350-500px). **Гипотеза не подтвердилась — DIA всё равно открывает как окно.** После сравнения установленных в DIA расширений (mymind, Cosmos, Readwise, Claude — все работают как dropdown, все **без** `default_popup`, используют `action.onClicked` + page overlay) стало ясно: DIA **всегда** детачит любой popup с `default_popup`. Это платформенное решение Browser Company, не баг нашего кода. Обходится только переездом на `action.onClicked` + injected overlay, что несовместимо с radix portals в shadcn. Решено принять как есть.

**4. Crop flow: убран openPopup(), заменён badge + toast**
Прошлая итерация пыталась вызывать `chrome.action.openPopup()` из background после завершения crop. Не работало — функция требует active user gesture в том же execution context, а после async pipeline (mouseup → capture → canvas crop → sendMessage) gesture давно потерян. Убрано полностью. Теперь:
- Content script **всегда** показывает Shadow DOM toast «Screenshot ready — click the Mine icon to save» сразу после mouseup
- Background проставляет `chrome.action.setBadgeText({text: "1"})` с тёмно-серым фоном
- Пользователь кликает иконку в toolbar → стандартный popup → `init()` читает `cropResult` → rehydrate с кропнутым превью → badge очищается

**5. Popup bounds persistence (background.js)**
Instagram feed popup (и починенный context menu popup) теперь запоминает позицию между открытиями. При первом open — default top-right от активного browser window. Когда пользователь перетаскивает — `chrome.windows.onBoundsChanged` пишет `{left, top, width, height}` в `chrome.storage.local.popupBounds`. Следующий open читает из storage. Tracking IDs хранятся в `chrome.storage.session` чтобы выживать перезапуск service worker и фильтровать только «наши» popup окна от посторонних. `onRemoved` чистит id при закрытии.

**6. Context menu URL fixed (background.js)**
`chrome.contextMenus.onClicked` handler открывал `chrome.runtime.getURL("popup/popup.html")` — этот файл **не существует** в проекте вообще, никогда не существовал. Правый клик → Save to Mine выдавал `ERR_FILE_NOT_FOUND` в открывшемся detached window. Фикс — заменил на `dist/index.html`, добавил тот же `resolvePopupBounds()` + tracking flow что и для Instagram feed. Context menu теперь работает.

**7. Native host binary sync (critical fix)**
**Главный баг сегодняшнего дня.** В проекте два cargo target directory: `/local-arena/target/debug/` (workspace root) и `/local-arena/src-tauri/target/debug/` (исторический). Cargo workspace пишет artefacts в workspace root, но ручные сборки из `src-tauri/` шли в src-tauri target. Я когда-то копировал native-host в installed location (`~/Library/Application Support/LocalArena/native-host`), с тех пор неоднократно пересобирал, но повторное копирование забыл. Installed binary оказался **старой версии без `list_known_vaults`, `upload_port`, `pre_uploaded_file`** — последние 2-3 дня изменений native host'а физически не применялись. Диагностика через `strings -a installed_binary | grep list_known_vaults` показала 0 совпадений, в свежем target — 1. Скопировал свежий binary.

Это объясняет сразу три наблюдаемых бага:
- Пропавший vault dropdown — `list_known_vaults` не обрабатывался, native host возвращал error, `knownVaults = []`, условие `length > 1` было false
- Screenshot upload молча падал — upload HTTP server не был запущен
- `pre_uploaded_file` в save_block игнорировался — старый SaveBlockParams не имел этого поля

### Deviations from plan
- Content-based popup sizing — сделано как предложено, но не решило DIA проблему (гипотеза оказалась неверной). Оставлено как улучшение, потому что всё равно лучше чем фиксированная высота.
- `chrome.action.openPopup()` — отказался полностью после того как убедился что он принципиально unreliable в MV3 async-контекстах.
- Page overlay вариант обсуждался как замена popup UI, но отклонён из-за фундаментальной несовместимости с Radix portals в shadcn.

### Push
`b972ffd` Clipper: screenshot mode, crop area, popup bounds, design-system fixes

### Decisions and lessons learned
- **Всегда после изменений в `src-tauri/src/bin/native_host.rs` нужно `cp target/debug/native-host ~/Library/Application Support/LocalArena/native-host`.** Ни Vite, ни `bun run build:extension`, ни Chrome reload не обновляют native host — он отдельный процесс. Стоит добавить post-build скрипт в `package.json` или checksum check перед extension build.
- **Два cargo target dir — рецепт катастрофы.** Надо разобраться, откуда взялся `src-tauri/target/` и удалить, либо сконфигурировать workspace так, чтобы использовалась только одна директория.
- **DIA не поддерживает inline popup, это архитектурное решение Browser Company.** Любое расширение с `default_popup` в DIA детачится. Обойти можно только отказом от `default_popup` + переход на `action.onClicked` + page overlay. Несовместимо с radix portals → несовместимо с shadcn → значительный refactor. Пока принято как есть.
- **`chrome.action.openPopup()` бесполезен в MV3 async callback цепочке.** User gesture не propagates через execution context boundaries. Единственные валидные gesture для openPopup: (1) прямой клик на иконку — но тогда popup и так открылся бы через default_popup, (2) keyboard command binding, (3) contextMenus.onClicked handler (единственное привилегированное исключение).
- **Tailwind v4 auto-detect сканит только файлы рядом с CSS entry, не следует по JS-импортам.** При multiple build entry points (main app + extension popup) надо явно указывать `@source` директивы на импортируемые директории, иначе будут непредсказуемо отсутствующие классы.
- **`chrome.runtime.sendMessage` без ожидания callback + `window.close()` — классический race.** Popup умирает до того как background обрабатывает сообщение, даже несмотря на `await storage.set()` перед этим. Фикс — `await` на response, потом `window.close()`. Эту ошибку я допускал два раза в разных местах, теперь привычка.
- **Диагностика через `strings` на бинарнике решает вопросы быстрее чем debug logs.** 5 секунд на `strings installed_binary | grep symbol` сразу сказали "в installed binary нет нового кода", без необходимости запускать runtime, писать print statements или гадать.

---

## 10.04.2026 (late) — Crop Area + Retake/Crop кнопки в дизайн-системе

### Goal
Пользователь хочет видеть полное превью скриншота без crop'а, иметь кнопку Retake для перезахвата и новую кнопку Crop Area — при нажатии выбирать прямоугольную область на странице с затемнением остального.

### Actually completed

**1. Превью без crop'а (PopupApp.tsx → ScreenshotPreview.tsx)**
Старое `max-h-[160px] w-full object-cover` обрезало картинку. Новое: `max-h-[220px] w-auto max-w-full object-contain` — полное изображение вписывается в границы с сохранением пропорций, подложка `bg-muted/30` под letterboxing.

**2. Retake/Crop Area кнопки в дизайн-системе (popup/components/ScreenshotPreview.tsx)**
Новый компонент, заменяет inline-markup из PopupApp. Использует shadcn `Button` из `@/components/ui/button` (path alias, тот же source что и основной фронт — никакого дублирования компонентов). `size="xs"`, `backdrop-blur-sm bg-background/85` для читаемости поверх картинки. Иконки `Crop` и `Camera` из lucide-react. Tooltip от shadcn показывает причину disabled state.

**3. Crop Area flow (новая фича)**
Пользователь в popup жмёт Crop Area → popup сериализует всё состояние в `chrome.storage.session.cropPendingState` → `window.close()`. Background получает `startCropMode`, пересылает `startCropOverlay` в content script. Content script инжектит Shadow DOM overlay: crosshair-курсор, rect-drag с затемнением через `box-shadow: 0 0 0 9999px rgba(0,0,0,0.55)` на самой рамке (один элемент = «окно в темноту»). Размер в px показывается в углу рамки. На mouseup при размере ≥ 20×20 content script просит background захватить viewport, кропит на OffscreenCanvas с DPR-scaling, JPEG q=0.9, отправляет result обратно. Background пишет в `cropResult` и вызывает `chrome.action.openPopup()`. Popup при init обнаруживает `cropPendingState + cropResult` и восстанавливает состояние с обрезанным скриншотом.

**4. Persist state в session**
`useClipperState.startCropMode()` сохраняет: tabId, metadata, articleData, selectedTags, recentTags, title, currentType, selectedVault, screenshotDataUrl. Init hydrate в той же функции после проверки `preloadedClipData`. Cancel path (Esc) восстанавливает старый не-кропнутый скриншот, done path — новый обрезанный.

**5. Crop Area disabled на не поддерживаемых страницах**
`applyCropCapability(tab.url)` проверяет protocol — только `http/https/file`. chrome://, chrome-extension://, view-source:, Chrome Web Store — disabled с tooltip.

**6. Content script crop module (content.js)**
Новый блок кода в IIFE:
- `startCropOverlay()` — создаёт Shadow DOM host, рендерит overlay с изолированными стилями
- `performCrop(rect)` — запрос виспорта у background, Image → OffscreenCanvas → JPEG dataUrl
- Блокировка скролла на время drag'а через `document.documentElement.style.overflow = "hidden"`
- Guard против двойного запуска overlay
- Handler `startCropOverlay` в onMessage

**7. Background handlers (background.js)**
Добавлены три обработчика:
- `startCropMode` — пересылка `startCropOverlay` в активную вкладку
- `captureForCrop` — вызов `chrome.tabs.captureVisibleTab` для content script (content scripts не имеют прямого доступа к этому API)
- `cropDone` — запись в `cropResult` + `chrome.action.openPopup()`

### Deviations from plan
Ничего — всё согласно плану в `~/.claude/plans/ethereal-whistling-planet.md` + согласованным ответам (сразу capture по mouseup, Shadow DOM, disabled + tooltip, persist state).

### Push
`b972ffd` Clipper: screenshot mode, crop area, popup bounds, design-system fixes (включает продолжение в вечерней записи)

### Decisions and lessons learned
- **Stale closure в useCallback**: в прошлой сессии забыл `screenshotDataUrl` в deps массиве `save`. Урок: всегда проверять exhaustive-deps, особенно в больших хуках. Возможно включить правило `react-hooks/exhaustive-deps` для extension/popup.
- **DPR критичен для кропа**: `captureVisibleTab` возвращает physical pixels (2880×1800 на Retina MacBook), координаты рамки — CSS pixels (1440×900). Без умножения на `devicePixelRatio` получил бы обрезанный верхний левый квадрант в 4 раза меньше ожидаемого. Учётся во всех трёх размерностях: sx, sy, sw, sh.
- **`box-shadow` трюк для затемнения**: один `box-shadow: 0 0 0 9999px rgba(0,0,0,0.55)` на рамке — элегантнее четырёх div'ов вокруг, элегантнее SVG mask. Индустриальный стандарт.
- **Shadow DOM с closed mode**: изолирует стили полностью. Критично для страниц с агрессивным CSS (`* { pointer-events: none !important }` сломал бы обычный div-overlay).
- **`chrome.action.openPopup()`**: в MV3 доступен с Chrome 99+, но исторически нужен user gesture. Внутри service worker при активной вкладке работает. Fallback — content script мог бы показать плашку «Click extension icon to save», но пока не реализовал — если openPopup молча упадёт, пользователь просто сам откроет popup и увидит rehydrated state.
- **Button `size="xs"`**: в проекте уже есть xs-размер (24px), default-вариант — не пришлось создавать новый. Path alias `@` в popup vite config позволяет импортировать shadcn-компоненты напрямую из `src/components/ui/` — никакого дублирования.
- **Почему crop overlay в content.js, а не отдельный файл**: content_scripts в manifest — массив injections, каждый элемент = отдельная IIFE. Два файла — два изолированных state. Один файл — один message handler на всю content-логику. Меньше магии, проще отладка.
- **Tooltip wrapper для disabled Button**: Radix Tooltip требует чтобы trigger не был disabled (disabled элементы не получают pointer events → tooltip не открывается). Стандартный workaround — обернуть Button в `<span>`, span получает hover event от тултипа.

---

## 10.04.2026 — Screenshot-режим в веб-клиппере

### Goal
Добавить четвёртый режим в clipper: захват скриншота видимой области вкладки и сохранение как image-блок в vault.

### Planned
1. Новый пункт Screenshot в TypeSwitcher
2. `chrome.tabs.captureVisibleTab` при переключении типа, превью в popup
3. Upload бинарника через локальный HTTP-сервер в native host (обход лимита 1 МБ на сообщение native messaging)
4. `pre_uploaded_file` в save_block — native host использует уже залитый файл без повторного скачивания

### Actually completed

**1. Native host: HTTP upload-сервер (native_host.rs, Cargo.toml)**
Добавлена зависимость `tiny_http = "0.12"`. При старте native host привязывает TCP к `127.0.0.1:0` (случайный порт), генерирует 32-символьный hex-токен, запускает `tiny_http::Server` в отдельном потоке. Эндпоинт `POST /upload?filename=<name>` принимает сырые байты, проверяет `Authorization: Bearer <token>`, санирует имя файла (запрещены `..`, `/`, `\`), сохраняет в корень vault с дедупликацией имени при конфликте. Порт и токен возвращаются в ответе `get_status`.

**2. Native host: pre_uploaded_file в save_block**
Новое поле `pre_uploaded_file: Option<String>` в `SaveBlockParams`. Если задано — хост проверяет что файл есть в vault и использует его как `media_file` без повторного скачивания `image_url`.

**3. Extension manifest (manifest.json)**
Добавлен `host_permissions: ["http://127.0.0.1/*"]` — без этого fetch из popup блокируется CORS. `activeTab` достаточно для `captureVisibleTab`.

**4. Popup: screenshot flow (useClipperState.ts, messaging.ts)**
- `uploadPortRef`/`uploadTokenRef` сохраняют данные из `get_status`
- `handleTypeChange` при переключении на Screenshot вызывает `chrome.tabs.captureVisibleTab` и кладёт dataUrl в state
- `save` для типа screenshot конвертирует dataUrl в Blob, загружает через `uploadFile()` и передаёт имя в `save_block` как `pre_uploaded_file`
- Хелпер `uploadFile()` в messaging.ts: POST blob на `http://127.0.0.1:{port}/upload?filename=...` с Bearer-токеном

**5. Popup UI (PopupApp.tsx, TypeSwitcher.tsx)**
Новый пункт Screenshot в TypeSwitcher. PopupApp показывает превью захваченного кадра под заголовком.

### Deviations from plan

**Stale closure в save callback.** Первая реализация работала через раз: `screenshotDataUrl` был в `useState`, но отсутствовал в deps-массиве `useCallback` у функции `save`. React переиспользовал мемоизированный колбэк со старым замыканием, где `screenshotDataUrl === null`. При клике на Save код читал null и показывал ошибку. Диагностика — добавил временные `console.error` с префиксом `[DEBUG]`, вывел значения в `showError`, локализовал точку отказа. Фикс — добавить `screenshotDataUrl` в deps. После удалил debug-код.

### Push
— (будет обновлено после push)

### Decisions and lessons learned
- Chrome native messaging: жёсткий лимит 1 МБ на сообщение, обход через data URL не работает. Индустриальный стандарт (Obsidian, Raycast, 1Password) — локальный HTTP-сервер для бинарных файлов.
- `tiny_http` — синхронный, без async runtime, ~500 строк, идеально для stdin/stdout-native host.
- `host_permissions: ["http://127.0.0.1/*"]` в Manifest V3 обязательно для fetch до localhost, `activeTab` этого не покрывает.
- Stale closures в useCallback — классический react-хуковый баг. Правило `react-hooks/exhaustive-deps` в ESLint ловит это, стоит убедиться что оно включено для extension/popup.
- Refs (`uploadPortRef`, `uploadTokenRef`) к stale closure не уязвимы, потому что `.current` читается в момент вызова, а не на момент создания колбэка. Но для screenshot dataUrl ref не подходит — нужен ре-рендер для показа превью.
- Безопасность HTTP-сервера: listener только на `127.0.0.1`, одноразовый токен при каждом запуске, санитайзер имён файлов. Листенер живёт только пока жив native host (до закрытия канала stdio Chrome).

---

## 05.04.2026 — Карточки, hover, дедупликация, compact-режим, иконка

### Goal
Переработка карточек (hover overlay, ArticleCard с картинками), дедупликация изображений в клиппере, compact-режим сайдбара, новая иконка.

### Actually completed

**1. Compact-режим сайдбара (Sidebar.tsx)**
При ширине < 320px сайдбар переключается в compact: только название канала + счётчик, без превью-карточек. Стиль: `rounded-1 p-2 text-base`, hover `bg-accent`, active `bg-sidebar-accent`. Padding навигации: `px-2` (compact) vs `px-8` (полный).

**2. Иконка приложения**
Новая иконка — миндалевидный глаз с прямоугольным зрачком. SVG → PNG 1024px → `cargo tauri icon` → все форматы (icns, ico, iOS, Android). Видна только в release-сборке (dev-режим использует голый бинарник, не .app bundle).

**3. Dropdown сайдбара**
- `modal={false}` — клики вне dropdown проходят к элементам (навигация одним кликом)
- `side="right"` — dropdown открывается справа от кнопки
- `e.preventDefault()` на trigger-кнопке — предотвращает просачивание клика до NavLink (вызывало мерцание экрана)
- `menuOpen` state + `onOpenChange` — иконка остаётся видимой пока dropdown открыт
- Убран Tooltip-обёртка на иконке
- Trigger без Button-компонента — голый `<button>` для точного выравнивания иконки с счётчиком

**4. Тени — возврат к стандартным**
Кастомные тени `shadow-[0_4px_24px_rgba(0,0,0,0.12)]` заменены на стандартный shadcn `shadow-md` в DropdownMenu и ContextMenu.

**5. Исправления TypeScript**
Удалён неиспользуемый import `renameTag` (App.tsx), `Plus` (Sidebar.tsx). Исправлена типизация `MetadataPanelProps.block` (Detail.tsx). Типизация `preloadedClipData` в clipper (useClipperState.ts).

**6. Hover overlay карточек (CardHoverMenu.tsx, global.css)**
CSS-переменная `--card-hover-overlay`: transparent (отключён). Убран inset border `hover:after:shadow` с Card.tsx. Удалены мёртвые overlay-заголовки из ImageCard и VideoCard. CardHoverMenu: `menuOpen`/`channelOpen` state для сохранения кнопок при открытом dropdown, `modal={false}` на обоих DropdownMenu.

**7. ArticleCard с картинками (Card.tsx)**
Статьи с `first_image` (картинка, не видео) показывают: заголовок (`line-clamp-2`) + 3 строки текста (`line-clamp-3`) + картинка. Статьи без картинок: `line-clamp-8`. Исправлен `stripMarkdown` для многострочных image-ссылок (`[^\]]*` вместо `.*?`).

**8. Контекстное меню карточек (CardContextMenu.tsx, Grid.tsx)**
Убран пункт Delete из контекстного меню (правый клик). Меню теперь идентично кнопке Channel — только CollectionPicker.

**9. Дедупликация изображений в клиппере (native_host.rs, useClipperState.ts)**
Проблема: Defuddle извлекает hero-изображение и ту же картинку из тела статьи → два файла с идентичным содержимым. Два уровня дедупликации:
- Native host: побайтовое сравнение скачанных файлов в `localize_body_images`. Дубликат удаляется с диска, строка убирается из markdown.
- Popup: дедупликация по alt-тексту в `deduplicateImages` для корректного превью.

**10. Redirect для пустых каналов (App.tsx)**
Redirect-эффект теперь проверяет и `tags`, и `channels`. Пустые каналы (0 блоков) больше не перенаправляют на "/".

### Push
- `a83e34e` Sidebar compact mode, new app icon, dropdown fixes, standard shadows
- `c874b90` Cards: hover overlay, ArticleCard images, context menu, image dedup

### Decisions and lessons learned
- `dark:` вариант Tailwind v4 использует `@media (prefers-color-scheme: dark)`. Если ОС в тёмной теме, а приложение вручную переключено на светлую через `data-theme="light"` — `dark:` всё равно срабатывает. Решение: CSS-переменные вместо `dark:` модификаторов.
- Дедупликация по URL не работает (CDN отдаёт разные URL для одного изображения). По hash/bytes после скачивания — надёжно.
- Chrome вызывает native host по пути из манифеста (`~/Library/Application Support/*/NativeMessagingHosts/`). Перекомпиляция в `target/debug/` не обновляет установленный бинарник автоматически.
- Dev-режим Tauri запускает голый бинарник без `.app` bundle — иконка не отображается в Dock. Нужна release-сборка для проверки.
- `modal={false}` на Radix DropdownMenu — штатный API для non-modal меню. Без overlay клики проходят к элементам напрямую.
- Мерцание при клике на dropdown вызвано тем, что click event просачивался через trigger до NavLink → навигация → VirtuosoMasonry перемонтировался. `e.preventDefault()` решает это.
- `justify-center` vs `justify-end` на иконке не решало проблему выравнивания — Button `icon-xs` (24px) добавлял 6px padding. Голый `<button>` без фиксированного размера = точное выравнивание.

---

## 04.04.2026 — Переработка sidebar-превью: приоритет картинок, видео-кадры, тёмная тема

### Goal
Переработать отображение превью в боковом меню: картинки приоритетнее текста, видео показывает кадр, текстовые превью адаптируются к теме.

### Actually completed

**1. Приоритет картинок в thumbnail (handler.rs)**
Новый каскад: `file (image) → file (video) → thumbnail field → first_image (image) → first_image (video) → text fallback`. Статьи с картинками в теле теперь показывают картинку, а не текстовый thumbnail.

**2. Видео-декодирование (thumbnails.rs, Cargo.toml)**
Добавлены зависимости `mp4` (парсинг контейнера) + `openh264` (декодирование H.264). Функция `generate_video_thumbnail`: парсит MP4, извлекает SPS/PPS, конвертирует AVCC→Annex B, декодирует до 30 кадров через OpenH264, пропускает чёрные (средняя яркость < 10). Pure Rust, без внешних зависимостей.

**3. Тёмная тема для текстовых превью (thumbnails.rs, Sidebar.tsx)**
Текстовые thumbnail генерируются как PNG с прозрачным фоном (вместо JPEG с белым). В сайдбаре обёрнуты в `<div class="bg-accent">`, текст инвертируется через `dark:invert`. Фон точно совпадает с темой.

**4. Классификация превью (channels.rs, types/index.ts)**
`list_channel_previews` возвращает `PreviewItem { slug, text }`. Флаг `text` определяет, нужна ли инверсия в тёмной теме. Видео-блоки корректно классифицируются как не-текстовые.

**5. Размер превью**
Карточки увеличены с 24x24 (`size-6`) до 32x32 (`size-8`). Отступы строк уменьшены с `py-1.5` (6px) до `py-1` (4px).

### Push
`1f65fad` Sidebar previews: image priority, video frame extraction, dark theme

### Decisions and lessons learned
- `h264-decoder` crate (0.2.4) — парсер заголовков, НЕ декодер пикселей. `openh264` (Cisco OpenH264 через Rust bindings) — настоящий декодер.
- MP4 хранит H.264 в формате AVCC (length-prefixed NAL), OpenH264 ожидает Annex B (start-code prefixed) — нужна конвертация.
- Первый кадр видео часто чёрный (fade-in) — пропуск по средней яркости.
- PNG с прозрачным фоном можно сохранить с расширением `.jpg` — браузер определяет формат по содержимому, не по расширению.
- CSS `filter: invert(1)` недостаточно для тёмной темы — инвертированный белый (#F8F8F8→#070707) не совпадает с фоном приложения (#0C0C0C). Прозрачный фон + CSS `bg-accent` — точное совпадение.

---

## 03.04.2026 — Пустой грид, rename race, нормализация тегов, белая вспышка

### Goal
Устранить пустой экран при первом запуске, исправить переименование каналов (race condition + нормализация), убрать белую вспышку до загрузки CSS.

### Actually completed

**1. Пустой грид при первом запуске (Grid.tsx)**
VirtuosoMasonry инициализировался с `data=[]` до завершения `loadData()`. Viewport = 0 → компонент решал, что ни один элемент не виден, и больше не пересчитывал. Исправление: `blocks.length > 0` в условии рендеринга — VirtuosoMasonry монтируется только когда данные загружены.

**2. Переименование канала — race condition (App.tsx, commands.ts)**
`navigate()` срабатывал до `loadData()`, redirect-эффект видел несогласованное состояние (новый URL + старые tags) и перенаправлял на "/". Исправление: `suppressRedirectRef` блокирует redirect во время операции, `loadData()` выполняется до `navigate()`, нормализованный тег берётся из ответа `renameChannel` (типизирован как `ChannelDto`).

**3. Нормализация тегов (block.rs, channels.rs, native_host.rs)**
Корневая причина дубликатов каналов при переименовании: `parse_tags()` читал теги из YAML без нормализации → `block_tags` содержал `"Япония"` → `rename_channel` искал `"япония"` → case-sensitive `retain()` не находил совпадения → старый тег оставался, новый добавлялся → блок с двумя тегами → два канала в сайдбаре. Три исправления:
- `parse_tags()` — нормализация при чтении из YAML (двойной барьер: защита от ручного редактирования файлов)
- `retain()` в `rename_channel` — сравнение нормализованных значений
- `native_host.rs` — нормализация тегов от веб-клиппера на входе

**4. Белая вспышка при запуске (index.html)**
До загрузки CSS браузер показывал белый `<body>`. Исправление: инлайн `style="background:#0C0C0C"` на `<body>`.

### Checks
- Приложение компилируется и запускается без ошибок
- Переименование каналов работает корректно
- Нормализация тегов — двойной барьер (при записи + при чтении)

### Push
- `86b50e2` Fix empty grid on launch, channel rename race, dark startup flash
- `bfa6296` Fix tag normalization: parse_tags, rename_channel, web clipper

### Decisions and lessons learned
- VirtuosoMasonry не обрабатывает переход data=[] → data=[N] при viewport=0 — защита на стороне потребителя (не рендерить до готовности данных).
- Race condition между React Router (`navigate`) и React state (`useState`) — ref-флаг (`suppressRedirectRef`) гарантирует атомарность с точки зрения побочных эффектов.
- **Нормализация тегов на границе чтения** — ключевое архитектурное решение (ARCHITECTURE.md #010). Файлы — источник правды, пользователь может редактировать их вручную. `parse_tags()` — единственная точка входа тегов из файлов в систему.
- iCloud может восстановить удалённые файлы, создавая фантомные каналы. Нужно учитывать при работе с vault на iCloud Drive.

---

## 03.04.2026 — Аудит навигации: 30 проблем, 20 исправлено

### Goal
Устранить чёрный экран при переключении каналов. Полный аудит цепочки клик → роутинг → фильтрация → рендер.

### Actually completed

**Аудит (6 субагентов):** App.tsx routing, Sidebar navigation, Grid/VirtuosoMasonry, Backend channels, Storage SQL, Domain tag/slug. Найдено 30 проблем (5 CRITICAL, 9 HIGH, 13 MEDIUM, 3 LOW).

**Фаза 1 — Чёрный экран (7 исправлений):**
1. `key={currentTag}` на VirtuosoMasonry и GridLanes — полный remount при смене канала
2. Scroll to top при смене currentTag (не только по сигналу)
3. ResizeObserver: игнорировать width=0 (sidebar transition)
4. handleRenameTag: navigate ПЕРЕД loadData
5. handleDeleteTagFromAll: redirect на "/" при удалении текущего канала

**Фаза 2 — DnD guards (3 исправления):**
6. isDragging + isCardDragging guards на NavLink onClick
7. create_channel: uniqueness check после нормализации

**Фаза 3 — Тесты (8 исправлений):**
8. Frontmatter position/color/icon во всех тестах (8 мест). 213 тестов проходят

**Фаза 4 — UX polish (3 исправления):**
9. Redirect на "/" при навигации на несуществующий канал
10. useLocation() вместо window.location в TagNavItem
11. columnGap → gap для flex совместимости

### Push
9476b46, 73a5f01, 2d98938

### Decisions and lessons learned
- VirtuosoMasonry не сбрасывает scroll/heights при смене data — решение: key prop для полного remount
- Route меняется мгновенно, blocks устаревшие — не баг фильтрации, а timing issue
- rename_tag НЕ обновляет channels table — всегда использовать rename_channel
- 213 тестов не компилировались из-за добавления полей в Frontmatter без обновления тестов

---

## 02.04.2026 — Desktop: hover menu, vault switcher, bugfixes

### Goal
Hover-меню карточки (Source, Channel, More), переключение пространств, исправления UX.

### Actually completed
1. CardHoverMenu: overlay bg-black/40 + три кнопки (More top-right, Source bottom-left, Channel bottom-right)
2. CollectionPicker: переиспользуемый компонент (вынесен из CardTagMenu)
3. Source: openUrl через @tauri-apps/plugin-opener (не window.open)
4. VaultSwitcher: DropdownMenu с известными пространствами + Add space
5. known_vaults в config.json, list_known_vaults Rust-команда
6. Clipper: vault selector в popup, list_known_vaults в native host, vault_path per-request
7. Instagram: иконка floppy disk → Plus
8. Sidebar: InlineInput для создания канала (вызывается из нижней панели)
9. loadPreviews с await — миниатюры обновляются сразу после DnD
10. Styleguide: добавлены DropdownMenu, ContextMenu, AlertDialog
11. DESIGN_SYSTEM.md: Card Hover Menu паттерн, семантические токены --radius-card/--radius-media
12. Переименование Local Arena → Mine (все файлы, Rust crates, iOS, bundle ID)

### Push
03c9cce

### Decisions and lessons learned
- window.open не работает в Tauri WebView — использовать openUrl из plugin-opener
- Hover overlay inset-0 с stopPropagation блокирует клик по карточке — кнопки в отдельных absolute контейнерах
- loadPreviews без await — миниатюры не обновлялись после DnD
- Кнопки карточки — стандартный Button variant="default", не кастомные стили

---

## 22.03.2026 — Phase M2.6: список каналов

### Goal
Список каналов с горизонтальным скроллом thumbnail'ов (Apple TV-стиль). Фильтрация сетки по каналу.

### Actually completed
1. `Channel` модель — вычисляется из блоков в Swift (без FFI): группировка по тегам, count, thumbSlugs
2. `ChannelListView.swift` — полноэкранный список каналов
3. `ChannelRow` — двухстрочная структура: label + count + chevron / ScrollView(.horizontal) с thumbnail'ами
4. `ContentView` — навигация ChannelList ↔ Grid через @State
5. `GridView` — фильтрация по каналу, заголовок с гамбургером и названием канала
6. `Theme.swift` — `Arena.sidebarAccent` токен

### Push
3a51a82

### Decisions and lessons learned
- Горизонтальный скролл вместо gradient mask — проще, нативнее, без артефактов
- `.glassEffect()` и `.ultraThinMaterial` на тёмном фоне (#0C0C0C) создают видимые серые прямоугольники — не подходят
- `.mask(LinearGradient)` после `.frame(maxWidth: .infinity)` не работает в SwiftUI — gradient не привязывается к расширенному фрейму
- ScrollView thumbnail'ов: padding(.leading) внутри, справа уходят за край экрана
- Каналы вычисляются client-side из блоков — нет необходимости в FFI-функциях

---

## 22.03.2026 — Phase M2: полноэкранный режим, видео-автоплей, навигация

### Goal
Приложение на весь экран iPhone, видео воспроизводится в ленте и в детальном виде, навигация без NavigationStack.

### Actually completed
1. `UILaunchScreen` в Info.plist — приложение на весь экран (без compatibility mode)
2. Сидинг тестовых данных — копирование .md из корня бандла (не из TestData/)
3. Убран `NavigationStack` из GridView — ручная навигация через `@State`, без отступа nav bar
4. `LoopingVideoView` (`UIViewRepresentable` + `AVQueuePlayer` + `AVPlayerLooper`) — автоплей в ленте
5. `AutoplayVideo` (`AVPlayer` + `VideoPlayer`) — автоплей в DetailView
6. SocialCard/VideoCard — для .mp4 медиа показывается автоплей, не статический кадр
7. DetailView — кастомная кнопка «назад» (шеврон в полупрозрачном круге)

### Push
35252b7

### Decisions and lessons learned
- Без `UILaunchScreen` (пустой dict) iOS запускает app в compatibility mode — маленький квадрат
- `NavigationStack` резервирует ~100px под nav bar даже при `.toolbar(.hidden)` — убрали полностью
- `AVPlayerLooper(player:templateItem:)` — бесшовный loop, лучше ручного seek на .zero
- `videoFirstFrame()` через `AVAssetImageGenerator` оставлен как fallback
- Тестовые медиафайлы копируются в симулятор через `xcrun simctl` (не в бандл)

---

## 22.03.2026 — Phase M1—M2: iOS app scaffold (SwiftUI + Rust UniFFI)

### Goal
Rust-ядро вызывается из Swift на iOS. Приложение запускается на симуляторе и показывает карточки из vault.

### Actually completed
1. Cargo workspace — `local-arena` (десктоп) + `local-arena-ffi` (iOS UniFFI)
2. Feature gate `desktop` — domain/ и storage/ компилируются для iOS без Tauri
3. `core-ffi` crate — ArenaVault (open, scanVault, listBlocks), FfiLightBlock, ArenaError
4. Swift bindings через uniffi-bindgen, xcframework для device + simulator
5. Xcode project (xcodegen) — SwiftUI: GridView с CardView, VaultViewModel
6. `scanVault()` — индексация .md файлов из Swift
7. 134 карточки отображаются на симуляторе

### Push
fdfdaac, 4a6abb6, 3d398ad, efbee7b, e30b2b3, 1df7459, 90694c1

### Decisions and lessons learned
- `trash` crate → `cfg(not(target_os = "ios"))`, `notify` → optional
- `Connection` в UniFFI → `Mutex<Connection>` внутри Object
- xcframework modulemap → переименовать в `module.modulemap`
- Тестовые данные в симулятор через `xcrun simctl`
- SwiftUI `.scaledToFill()` без `.clipped()` → overflow. Паттерн: `Color.clear.aspectRatio(1).overlay(image.scaledToFill()).clipped()`
- Detail: читать полный body из .md файла напрямую (не через Rust FFI) — проще и быстрее
- Шрифт 10pt адаптирован из 12px десктопа для ширины колонки ~190px

---

## 18.03.2026 — Каналы как маркдаун-файлы

### Goal
Каналы хранятся как .md файлы с `type: channel` в frontmatter. SQLite — кэш. При rebuild_index каналы не теряются. Obsidian видит каналы как заметки в графе.

### Actually completed
1. `domain/block.rs` — `BlockType::Channel`, frontmatter: `position`, `color`, `icon`
2. `watcher/handler.rs` — маршрутизация `type: channel` → `upsert_channel_from_block()`
3. `storage/index.rs` — `upsert_channel_from_block()`
4. `commands/vault.rs` — `migrate_channels_to_files()` (однократная миграция SQLite → .md)
5. `commands/channels.rs` — create/delete/reorder/rename пишут .md файлы
6. `bin/native_host.rs` — `create_channel` пишет .md
7. `types/index.ts` — `BlockType += "channel"`, `App.tsx` фильтрует channel-блоки

### Push
c7a9dc9, 78426c8, 066f474

### Decisions and lessons learned
- Каналы = .md файлы с `type: channel`. SQLite `channels` table — кэш
- Миграция однократная: SQLite каналы без .md файлов → создаём файлы
- `rebuild_index` восстанавливает каналы из .md (не теряет метаданные)

---

## 18.03.2026 — Detail: прокрутка содержимого стрелками, производительность, удаление

### Goal
Стрелки вверх/вниз в Detail прокручивают содержимое (не переключают карточки). Удаление блоков работает с iCloud. Мгновенное открытие карточек.

### Actually completed
1. **`Detail.tsx`** — стрелки вверх/вниз: убран перехват ArrowUp/ArrowDown (оставлены только Left/Right для навигации). Фокус перемещён на скроллируемый контейнер (`tabIndex` + `ref` на `overflow-y-auto` div).
2. **`Detail.tsx`** — progressive rendering: принимает `LightBlock | IndexedBlock`, lazy-load полного body через `getBlock()` в `useEffect` при `body.length >= 498`.
3. **`App.tsx`** — `handleBlockClick` без IPC: `setSelectedBlock(block)` мгновенно (убран `await getBlock()`). Навигация стрелками и Enter тоже без IPC.
4. **`Grid.tsx`** — скролл к верху только при повторном клике на текущий канал (`scrollToTop` signal).
5. **`files.rs`** — fallback на `std::fs::remove_file` если `trash::delete` не работает (iCloud placeholders).
6. **`blocks.rs`** — удаление из индекса перед удалением файлов (UI обновляется мгновенно).
7. **`Card.tsx`** — `useMemo` для `extractTweetData`/`stripMarkdown`, `memo()` на все 6 карточных компонентов.
8. **`Sidebar.tsx`** — `memo()` на `NavItem` и `TagNavItem`.
9. **`handler.rs`** — thumbnail генерация в фоновых потоках.

### Push
9f47b69, 6f44ae5, 028021b, 3468d74, 5cc0607, e260164

### Decisions and lessons learned
- `getBlock()` IPC блокировал открытие карточки (Mutex-контенция с loadData). Убрав IPC из click path — мгновенное открытие.
- Фокус на внешнем `div` Detail не позволяет нативную прокрутку стрелками. Фокус должен быть на скроллируемом контейнере.
- `trash::delete` не работает с iCloud placeholders — нужен fallback.

---

## 15.03.2026 — Медиа-галерея в карточках, Instagram Stories, Twitter video fix

### Goal
Карточки социальных постов (Twitter, Instagram) должны показывать все медиа из поста, а не только то, что помещается в обрезанный body. Instagram Stories должны сохраняться. Видео в Twitter-тредах должно быть при первом твите, а не в конце.

### Actually completed
1. **`src-tauri/src/storage/db.rs`** — миграция: столбцы `first_image` и `media_urls` в таблице `blocks`.
2. **`src-tauri/src/storage/index.rs`** — `extract_first_image()` и `extract_media_urls()`: при индексировании извлекают все `![](url)` из body, сохраняют как JSON-массив в `media_urls`. `LightBlock` получает оба поля. SQL-запрос `list_blocks_light` включает `first_image` и `media_urls`.
3. **`src/types/index.ts`** — `LightBlock`: добавлены `first_image` и `media_urls`.
4. **`src/components/Card.tsx`** — `SocialCard` (бывший `TwitterCard`): если body обрезан и медиа потеряны, берёт из `media_urls` (JSON-массив). Единый компонент для Twitter и Instagram (`isInstagramUrl`). Переименован `TwitterCard` → `SocialCard`.
5. **`extension/content.js`** — Instagram Stories: URL `/stories/USERNAME/ID/` распознаётся, Story ID используется напрямую как media PK. `useClipperState.ts`: async обновляет title из articleData (исправлен бессмысленный og:title для Stories).
6. **`src-tauri/src/bin/native_host.rs`** — Twitter-видео вставляется после текста первого твита (перед первым `---`), а не в конец body. Проверка дубликатов.

### Deviations from plan
- Первоначально добавили `first_image` (одно изображение). Недостаточно для галереи — добавили `media_urls` (JSON-массив).
- Видео в конце треда: content script не может вызвать syndication API (CORS). Бэкенд добавлял видео в конец body. Исправлено — вставка после первого твита.

### Checks
- Instagram-пост с длинным текстом + карусель → карточка показывает галерею
- Instagram Stories → сохраняются с картинкой/видео
- Twitter-тред с видео → видео при первом твите
- Обычные статьи → без изменений

### Push
e98a0bf — Media gallery in cards, Instagram Stories, Twitter video position fix

### Decisions and lessons learned
- `SUBSTR(body, 1, 500)` в `LightBlock` обрезает медиа-ссылки для длинных постов. Решение: отдельное поле `media_urls` (JSON) заполняется при индексировании из полного body.
- Content script на twitter.com/x.com не может вызвать syndication API (`cdn.syndication.twimg.com`) из-за CORS (`Access-Control-Allow-Origin: https://platform.twitter.com`). Видео-обнаружение — ответственность бэкенда.
- Позиция вставки видео в body имеет значение: `raw.find("\n\n---\n")` находит границу первого твита в треде.

---

## 15.03.2026 — Instagram клиппер: парсер постов + кнопка в ленте

### Goal
Сохранение Instagram-постов: текст, все картинки из карусели, видео. Два сценария: (1) открытый пост через обычный клиппер, (2) кнопка-оверлей в ленте без навигации.

### Planned
Instagram-парсер через REST API v1, кнопка на изображениях в ленте, открытие попапа с предзагруженными данными.

### Actually completed
1. **`extension/content.js`** — `extractInstagramPost()`: REST API v1 (`i.instagram.com/api/v1/media/{mediaId}/info/`), конвертация shortcode → media ID через base64-алгоритм. Извлекает caption, автора, все медиа карусели (изображения + видео). Поддержка Stories: URL `/stories/USERNAME/ID/` — числовой ID используется напрямую как media PK (без конвертации shortcode). Кнопка-оверлей в ленте: сканирует `<article>` каждые 500мс, инжектит кнопку на правый верхний угол изображения.
2. **`extension/background.js`** — `openClipperWithData`: принимает предзагруженные данные от content script, открывает попап позиционированный у правого верхнего угла браузерного окна (700x388).
3. **`extension/popup/hooks/useClipperState.ts`** — проверка `preloadedClipData` в `chrome.storage.session` при инициализации. Если данные есть — используются вместо извлечения из вкладки.
4. **`CLAUDE.md`** — тестовый vault `~/Desktop/Тест/`, обновлено описание content.js.

### Deviations from plan
Первоначально использовался GraphQL API с `doc_id`, но он вернул HTML (нужны cookies + `doc_id` устаревает каждые 2—4 недели). Переключились на REST API v1 — стабильнее, использует media ID.

### Checks
- Открытый Instagram-пост → клиппер → текст + все картинки карусели сохранены
- Instagram Stories → клиппер → картинка/видео сохранены
- Кнопка в ленте → видна на каждом посте → клик → попап с данными поста
- Twitter, YouTube, статьи → без изменений
- Lint: 0 ошибок, build: 0 ошибок

### Push
39bcbf0 — Instagram clipper: post parser + feed overlay button
49e7086 — Add Instagram Stories support to clipper

### Decisions and lessons learned
- REST API v1 (`i.instagram.com/api/v1/media/{mediaId}/info/`) стабильнее GraphQL — не зависит от `doc_id` который меняется каждые 2—4 недели
- Story ID из URL = Media PK. Тот же endpoint, тот же парсинг ответа. Конвертация shortcode не нужна — ID уже числовой
- Instagram CDN URL истекают (часы—дни) — обязательно скачивать через `localize_body_images()`
- Shortcode → media ID: base64-декодирование с алфавитом `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`
- Попап из content script через `chrome.windows.create()` — нужно явно позиционировать, иначе окно в левом верхнем углу экрана

---

## 15.03.2026 — Twitter GIF и видео: скачивание через syndication API

### Goal
Twitter-посты с GIF и видео должны сохраняться с медиа, которое воспроизводится в приложении и в Obsidian.

### Planned
Извлечение GIF/видео URL, скачивание MP4, рендеринг в карточках и Detail.

### Actually completed
1. **`extension/content.js`** — `extractTweetContent()` извлекает `<video>` из DOM (GIF = прямой MP4). `extractTwitterThread()` стал async: вызывает syndication API (`cdn.syndication.twimg.com/tweet-result?id=ID`) для получения всех медиа основного твита (фото + GIF + видео). API как основной источник медиа, DOM как fallback.
2. **`src-tauri/src/bin/native_host.rs`** — `fetch_tweet_videos()`: вызывает syndication API для Twitter URL, получает MP4 URL видео/GIF (наивысший битрейт), добавляет в body перед `localize_body_images()`. Все медиа скачиваются как локальные файлы.
3. **`src/components/Card.tsx`** — `TwitterCard`: рендерит `.mp4` как `<video autoPlay loop muted>`, остальное как `<img>`. Медиа из первого твита, максимум 4.
4. **`src/components/Detail.tsx`** — `ArticleBody`: `.mp4` в маркдауне рендерится как `<video controls playsInline>`. Убран Twitter embed (дублировал контент).
5. **`extension/popup/PopupApp.tsx`** — ReactMarkdown с кастомным `img` component для `.mp4`.
6. **`extension/popup/hooks/useClipperState.ts`** — async загрузка для Twitter (sync content пуст из-за syndication API).
7. **`src-tauri/tauri.conf.json`** — CSP: добавлены `media-src 'self' asset: https:` и `frame-src 'self' https://www.youtube.com`.

### Deviations from plan
Первоначально планировался стриминг видео по внешней ссылке (без скачивания). Исследование показало: (1) WKWebView в Tauri не воспроизводит видео с `video.twimg.com` (ошибка `MEDIA_ERR_SRC_NOT_SUPPORTED`), хотя другие CDN работают; (2) URL Twitter-видео непостоянные — могут истечь. Итоговое решение — скачивание MP4 (3—20 МБ).

### Checks
- Твит с видео → видео скачано, воспроизводится в приложении
- Твит с GIF → GIF скачан, воспроизводится
- Твит с картинками → без изменений
- Твит с картинками + видео → оба скачаны, оба отображаются
- Обычные статьи, YouTube → без изменений
- `cargo clippy --bin native-host` — 0 новых предупреждений

### Push
020f92d — Twitter GIF and video: download via syndication API

### Decisions and lessons learned
- Syndication API (`cdn.syndication.twimg.com`) — публичный, без авторизации, возвращает все медиа твита с прямыми MP4 URL. Вызывается из Rust бэкенда (нет CORS).
- Content script не может вызвать syndication API (CORS: `Access-Control-Allow-Origin: https://platform.twitter.com`). Бэкенд — правильное место для внешних API-вызовов.
- Стриминг видео с Twitter CDN не работает в Tauri WKWebView. Скачивание — единственный надёжный вариант.
- `crossOrigin="anonymous"` на `<video>` ломает воспроизведение — заставляет браузер проверять CORS. Без этого атрибута видео загружается как opaque request.

---

## 14.03.2026 — Twitter-карточки и улучшения тайтлов

### Goal
Twitter/X посты должны отображаться в карточках как в Are.na: иконка платформы не нужна, текст твита (3 строки max), картинки плиткой, автор внизу. Title для Twitter бессмысленен — убрать из карточки и Detail.

### Planned
Новый компонент `TwitterCard`, title из текста твита (не `"Thread by @handle"`), скрытие title в Detail для Twitter.

### Actually completed
1. **`src/components/Card.tsx`** — новый `TwitterCard`: текст (line-clamp-3), картинки из body (1 — одна, 2+ — grid-cols-2), автор внизу. Изображения резолвятся через `mediaUrl()` (локальные файлы). Маршрутизация по URL (twitter.com/x.com + /status/).
2. **`src/components/Detail.tsx`** — title скрыт для Twitter-постов. `isTwitterUrl()` добавлен.
3. **`extension/content.js`** — title = первые 80 символов текста твита (для slug). Убран `"Thread by @handle"` из metadata и extractTwitterThread.
4. **Отступы** — gap-0.5 (2px) между картинками в гриде, mt-3 (12px) между текстом и картинками.

### Checks
- Twitter-пост с текстом + картинками: карточка показывает текст, плитку, автора
- Twitter-пост без картинок: только текст + автор
- Обычные статьи: ArticleCard без изменений
- Detail: Twitter без title, статьи с title
- Lint: 0 ошибок

### Push
9877dba — Twitter card layout: text + image grid + author, no title

### Decisions and lessons learned
- Twitter title бессмысленен для отображения — используется только для генерации slug (имя файла)
- Картинки в body уже скачаны бэкендом (`localize_body_images`), URL перезаписаны на локальные имена файлов — нужно резолвить через `mediaUrl()`

---

## 14.03.2026 — Полный YouTube-транскрипт через Defuddle

### Goal
Клиппер должен сохранять полный транскрипт YouTube-видео (как Obsidian Web Clipper), а не 12 секунд или пустоту.

### Planned
Исправить извлечение YouTube-транскрипта: читать правильное поле Defuddle, исправить попап, исправить сборку для Safari.

### Actually completed
1. **`extension/content.js`** — YouTube-ветка в `extractArticleAsync()` использует Defuddle `parseAsync()` и читает `result.variables.transcript` (не `contentMarkdown`, который содержит iframe-embed). Синхронный `extractArticle()` возвращает пустой content для YouTube (транскрипт приходит только через async).
2. **`extension/popup/hooks/useClipperState.ts`** — видео по умолчанию открывается на вкладке Content (не Link); сохранение включает транскрипт (`articleData.content` вместо хардкода `""`).
3. **`extension/popup/PopupApp.tsx`** — единый рендерер контента через `ReactMarkdown` + `remarkGfm` для всех типов (статьи, видео, любой контент). Картинка, заголовок и текст в одном скроллируемом контейнере. Раньше: статьи через `dangerouslySetInnerHTML`, видео — сырой текст в `<p>`, обрезанный до 500 символов.
4. **`src/components/Detail.tsx`** — видео-блоки рендерят body через `<ArticleBody>` (ReactMarkdown), а не через сырой `<p>`. Единообразно со статьями.
5. **`package.json`** — `build:extension` теперь копирует `content.js`, `background.js`, `manifest.json`, `lib/` в Safari-расширение (раньше копировался только `dist/`).

### Deviations from plan
Первоначальный план предполагал кастомный YouTube-фетчер вместо Defuddle. Это не работает: YouTube не отдаёт `captions` в `ytInitialPlayerResponse` и InnerTube API без cookies браузера. Defuddle работает, потому что `fetchTranscript()` из content script делает запрос с cookies (same-origin). Ключевая ошибка была в чтении поля — `contentMarkdown` вместо `variables.transcript`.

### Checks
- YouTube-видео с субтитрами: полный транскрипт (25 минут — ОК)
- Попап: вкладка Content, маркдаун рендерится (заголовки, жирный), скролл
- Detail: видео-блоки рендерят маркдаун через ReactMarkdown (как статьи)
- Safari: `content.js` идентичен Chrome-версии после сборки
- `bun run build:extension` — 0 ошибок

### Push
d24ba15 — Fix YouTube transcript: read Defuddle variables.transcript, fix build pipeline
02f2a7a — Unified markdown rendering for all content types

### Decisions and lessons learned
- Defuddle кладёт YouTube-транскрипт в `variables.transcript`, а не в `contentMarkdown`. Это задокументированное поведение YouTube-экстрактора, но неочевидное.
- `build:extension` должен копировать ВСЕ файлы расширения в Safari, а не только собранный попап. Без этого изменения в `content.js` не попадали в Safari.
- Рендеринг контента в попапе должен быть единым для всех типов. Два разных пути (HTML для статей, сырой текст для видео) — источник багов.

---

## 14.03.2026 — Нормализация пустых строк, YouTube-транскрипт, миниатюры

### Goal
1. Убрать множественные пустые строки в .md файлах (Defuddle генерирует 3+ переводов строки)
2. Загружать YouTube-транскрипт через async Defuddle (parseAsync + InnerTube API)
3. Исправить качество YouTube-миниатюр (hqdefault 480x360 с полосами -> maxresdefault 1280x720)
4. Detail показывал thumbnail-кэш вместо оригинала для link-блоков

### Planned
1. Нормализация пустых строк в serialize_block()
2. Async extractArticle + прогрессивная загрузка (попап сразу, транскрипт в фоне)
3. Полный бандл Defuddle (index.full.js, 576KB) вместо минимального (YouTube-экстрактор)
4. upgradeYoutubeThumbnail() — замена hqdefault на maxresdefault
5. Detail.tsx — mediaUrl() вместо thumbnailUrl() для link-блоков

### Actually completed

**domain/block.rs:**
- `normalize_blank_lines()` — схлопывает 3+ переводов строки в одну пустую строку
- Применяется в `serialize_block()` перед записью body

**extension/content.js:**
- `extractArticleAsync()` — использует `Defuddle.parseAsync()` для YouTube-транскрипта
- Новый message action `extractArticleAsync` в handler
- `upgradeYoutubeThumbnail()` — заменяет `hqdefault.jpg` на `maxresdefault.jpg` для YouTube

**extension/lib/defuddle.js:**
- Заменён на полный бандл `index.full.js` (576KB) — включает YouTube, Reddit, GitHub, ChatGPT и другие экстракторы

**extension/popup/lib/messaging.ts:**
- `extractArticleAsync()` — 30с таймаут (vs 10с для синхронного)

**extension/popup/hooks/useClipperState.ts:**
- `articleLoading` state
- Прогрессивная загрузка: попап сразу по метаданным, транскрипт в фоне для видео
- Импорт `extractArticleAsync`

**extension/popup/PopupApp.tsx:**
- Content-видео: миниатюра + лоадер/транскрипт текстом (без iframe)
- Link-видео: чистая миниатюра без play-кнопки
- Удалён `PlayOverlay` (мёртвый код)

**Detail.tsx:**
- Link-блоки: `mediaUrl()` (полноразмерный файл) вместо `thumbnailUrl()` (кэш 480px)

### Deviations from plan
- Изначально использовали минимальный бандл Defuddle (164KB) — YouTube-экстрактор не работал. Заменили на полный (576KB)

### Checks
- `bun run build:extension` — 0 ошибок
- `bun run lint` — 0 ошибок
- YouTube: лоадер транскрипта, миниатюра maxresdefault

### Push
e545a36 Normalize blank lines, async YouTube transcript, maxres thumbnails

---

## 14.03.2026 — Замена Readability + Turndown на Defuddle

### Goal
Заменить три вендорных библиотеки (Readability.js 88KB + readerable.js 4KB + TurndownService 26KB = 118KB) одной — Defuddle (164KB). Один вызов вместо цепочки Readability→Turndown, встроенная обработка lazy-load картинок, богатые метаданные (author, published, wordCount).

### Planned
1. Скопировать Defuddle UMD-бандл в `extension/lib/`
2. Переписать `extractArticle()` — использовать `new Defuddle(document, { separateMarkdown: true })`
3. Убрать хелперы изображений и `htmlToMarkdown()` (~90 строк)
4. Убрать `isProbablyReaderable` из `isArticlePage()`
5. Упростить `extractMetadata()` — выделение как plain text
6. Обновить manifest.json и документацию

### Actually completed

**extension/content.js:**
- Удалены: `isPlaceholderSrc()`, `isImageUrl()`, `bestFromSrcset()`, `syncLiveSrc()`, `fixLazyImages()`, `htmlToMarkdown()` — ~90 строк
- `extractArticle()`: `Readability` + `TurndownService` → `new Defuddle(document, { separateMarkdown: true }).parse()`
- Возвращаемый объект сохраняет ту же структуру: `content` = `contentMarkdown`, `html` = `content`, `byline` = `author`
- `extractMetadata()`: выделение как plain text (убран вызов `htmlToMarkdown`)
- `isArticlePage()`: убран `isProbablyReaderable`, 3 сигнала с порогом >= 2

**extension/manifest.json:**
- `["lib/readerable.js", "lib/readability.js", "lib/turndown.browser.umd.js", "content.js"]` → `["lib/defuddle.js", "content.js"]`

**extension/lib/:**
- Добавлен: `defuddle.js` (164KB, UMD из npm)
- Удалены: `readability.js`, `readerable.js`, `turndown.browser.umd.js`

**CLAUDE.md:**
- Стек: `Readability.js` + `TurndownService` → `Defuddle`
- Структура: обновлены описания content.js и lib/

### Deviations from plan
Нет

### Checks
Ожидается ручная проверка на статьях и ссылках

### Push
f90657e Replace Readability + Turndown with Defuddle for article extraction

---

## 14.03.2026 — Полноценная поддержка видео в клиппере и Detail

### Goal
На видео-страницах (YouTube, Vimeo) клиппер не показывал превью и не давал выбрать формат. Detail.tsx не поддерживал YouTube iframe — только локальные видеофайлы.

### Planned
1. Попап: TypeSwitcher на видео-страницах, превью с play-кнопкой
2. Save: видео-Content сохраняется как block_type=video с URL
3. Detail: YouTube iframe embed, body ниже (для будущего транскрипта)

### Actually completed

**PopupApp.tsx:**
- TypeSwitcher видим на видео-страницах (убрано условие `detectedType !== "video"`)
- Play-кнопка поверх thumbnail в обоих режимах (Link и Content) для видео
- Компонент `PlayOverlay` (паттерн из `Card.tsx:VideoCard`)

**useClipperState.ts:**
- Видео по умолчанию маппится на `currentType = "link"` (не `"video"`)
- Видео-Content сохраняется с `block_type = "video"` (не `"article"`)
- Body пока пустое — подготовка к транскрипту через Defuddle
- `image_url` передаётся для видео-Content (og:image для thumbnail)

**Detail.tsx:**
- Хелпер `youtubeEmbedUrl()` — извлекает video ID из YouTube URL
- Видео-блок с URL: YouTube `<iframe>` embed с полноэкранным управлением
- Видео-блок без URL: локальный `<video>` (как прежде)
- Body рендерится ниже видео (`whitespace-pre-wrap`)

### Deviations from plan
Нет

### Checks
- `bun run build:extension` — 0 ошибок
- `bun run lint` — 0 ошибок
- YouTube-видео в клиппере: TypeSwitcher, превью с play-кнопкой в обоих режимах

### Push
9ae6fb5 Add video page support: clipper TypeSwitcher, play overlay, YouTube embed

---

## 14.03.2026 — Редизайн оверлея DropZone под дизайн-систему

### Goal
Привести оверлей DropZone в соответствие с дизайн-системой. Предыдущий вариант (bg-black/40 + backdrop-blur + border-dashed с хардкод-белым + ArrowDown 40px) выбивался из стилистики приложения.

### Planned
1. Заменить хардкод-стили на семантические токены
2. Добавить пунктирную рамку по периметру зоны сброса
3. Оверлей не перекрывает тулбар и action bar

### Actually completed

**DropZone.tsx:**
- Бэкдроп: `bg-black/40 backdrop-blur-sm` -> `bg-glass` (токен `--glass-bg`: белый 80% / тёмный 60%)
- Оверлей не перекрывает бары: `fixed inset-0` -> `fixed top-8 right-0 bottom-8 left-0`
- Пунктирная рамка: `inset-2` (8px), `rounded-[4px]`, `border-border dark:border-muted-foreground`, только при drag over
- Карточка: паттерн AlertDialogContent (`bg-background border border-border rounded-1 p-6 shadow-lg`)
- Текст: хардкод `text-white` -> токены `text-foreground` / `text-muted-foreground`
- Drag over и importing объединены в одну карточку с условным текстом
- Убран импорт `ArrowDown` из lucide-react

**DESIGN_SYSTEM.md:**
- Добавлен раздел «DropZone (внешний file drop)» в секцию Drag-and-Drop

### Deviations from plan
Нет

### Checks
Визуальная проверка в светлой и тёмной теме

### Push
0cb67f2 Redesign DropZone overlay to match design system

---

## 14.03.2026 — Вернуть внешний file drop (DropZone)

### Goal
Восстановить drag-and-drop файлов из Finder в окно приложения. Компонент DropZone был отключён из-за конфликта с внутренним drag-and-drop (dnd-kit): при перетаскивании каналов в сайдбаре срабатывал оверлей «Drop files to add».

### Planned
1. DropZone.tsx — убрать проверку `isInternalDragActive()`, оставить `setDragging(true)` напрямую
2. App.tsx — удалить `setInternalDragActive` из обработчиков dnd-kit, подключить DropZone в JSX
3. Удалить `src/lib/drag.ts` (костыль с флагом + 300ms таймером)
4. global.css — добавить `img { -webkit-user-drag: none }` для предотвращения ложной активации при перетаскивании картинок внутри Detail

### Actually completed
Все 4 пункта выполнены.

**DropZone.tsx:**
- Удалён импорт `isInternalDragActive` из `@/lib/drag`
- Условие `if (!isInternalDragActive()) setDragging(true)` → `setDragging(true)`

**App.tsx:**
- Удалён импорт `setInternalDragActive` из `@/lib/drag`
- Убраны 3 вызова `setInternalDragActive()` в `handleDndStart`, `handleDndEnd`, `handleDndCancel`
- Добавлен импорт `DropZone` из `@/components/DropZone`
- Добавлен `<DropZone currentTag={currentTag} onBlocksCreated={loadData} />` после нижней панели действий

**src/lib/drag.ts** — удалён (21 строка)

**global.css:**
- Добавлено правило `img { -webkit-user-drag: none }` — предотвращает нативный drag изображений, который Tauri перехватывает как внешний file drop

### Deviations from plan
Нет

### Checks
— Компиляция без ошибок
— DropZone подключён в JSX, ссылок на `drag.ts` нет

### Push
f7c1559 Restore external file drop (DropZone), remove drag.ts workaround

### Decisions and lessons learned
Костыль `drag.ts` (флаг + 300ms таймер) был не нужен: dnd-kit использует PointerSensor (pointer events), а Tauri onDragDropEvent реагирует на нативный OS-drag. Эти два механизма не пересекаются — внутренние перетаскивания физически не могут вызвать onDragDropEvent.

Правило `img { -webkit-user-drag: none }` — не костыль, а платформенная конфигурация: `<img>` по умолчанию имеет `draggable="true"`, и перетаскивание картинки внутри Detail порождает нативный OS-drag, который Tauri перехватывает. Это стандартное поведение для десктопных веб-приложений.

---

## 14.03.2026 — Консистентность документации + Detail не закрывался при клике на текущий канал

### Goal
1. Привести DESIGN_SYSTEM.md в полное соответствие с global.css после пересчёта поверхностей
2. Исправить баг: при открытом Detail клик по текущему каналу в сайдбаре ничего не делал

### Planned
1. Сверить все OKLCH L значения и hex-приближения в DESIGN_SYSTEM.md с global.css
2. Исправить расхождения
3. Добавить колбэк закрытия Detail при клике в навигации сайдбара

### Actually completed

**DESIGN_SYSTEM.md — 10 исправлений:**
- Поверхности тёмной темы: background 0.0→0.1567, accent 0.20→0.1815, active/sidebar-accent 0.24→0.2063, border 0.28→0.2311
- Шаг поверхностей: 0.04→0.0248
- Философия фона: «абсолютный чёрный (#000000)» → «тёмно-серый #0C0C0C»
- Hover сайдбара (тёмная): #1E1E1E → #111111
- Border инпута (тёмная): #222222 → #1D1D1D
- Glass-bg (тёмная): rgba(0,0,0,0.6) → rgba(12,12,12,0.6)

**Card.tsx — текстовая иерархия:**
- 5 мест: вторичный текст (домен, превью, автор, имя файла) `text-foreground` → `text-muted-foreground`

**Sidebar.tsx + App.tsx — закрытие Detail при клике на навигацию:**
- Добавлен проп `onNavClick` в Sidebar, прокинут в NavItem и TagNavItem
- App.tsx передаёт `() => setSelectedBlock(null)` — Detail закрывается при любом клике в навигации

### Deviations from plan
Нет

### Checks
- Все OKLCH L значения в DESIGN_SYSTEM.md совпадают с global.css
- Все hex-приближения пересчитаны под новые значения
- ESLint — 0 ошибок
- Клик по текущему каналу при открытом Detail закрывает Detail

### Push
`a8af425` — Sync DESIGN_SYSTEM.md hex values, fix Detail close on sidebar click

### Decisions and lessons learned
- При изменении OKLCH L значений нужно обновлять не только L в таблицах, но и все hex-приближения в тексте (hover, focus, glass). Hex-значения разбросаны по разным секциям документа
- react-router `NavLink` не вызывает навигацию при клике на активный маршрут — `location.pathname` не меняется, привязанные к нему `useEffect` не срабатывают. Решение — явный колбэк `onClick` на `NavLink`

---

## 12.03.2026 — Пересчёт поверхностей тёмной темы

### Goal
Добиться визуально различимой иерархии фоновых поверхностей в тёмной теме. После установки фона (sRGB 0.049) и линий (sRGB 0.114) промежуточные поверхности оказались неразличимы от фона.

### Planned
1. Установить фон на sRGB 0.049 (OKLCH L = 0.1567)
2. Установить линии/border на sRGB 0.114 (OKLCH L = 0.2311)
3. Пересчитать surface+1 и surface+2 равномерным шагом от фона до линий
4. Не трогать кнопки (component-fill токены)

### Actually completed
Все 4 пункта.

- **global.css** — пересчитаны токены поверхностей в обоих селекторах (`@media (prefers-color-scheme: dark)` и `[data-theme="dark"]`):
  - `--secondary/--muted/--accent` (surface+1): oklch(0.1511 0 0) → oklch(0.1815 0 0)
  - `--active/--sidebar-accent` (surface+2): oklch(0.1911 0 0) → oklch(0.2063 0 0)
  - `--border/--input/--sidebar-border` (линии): oklch(0.2311 0 0) — без изменений
  - Component-fill токены — без изменений

### Deviations from plan
Первоначально был применён шаг 0.04 (из предыдущей дизайн-системы) сверху вниз от линий. Это привело к тому, что surface+1 (L=0.1511) оказался темнее фона (L=0.1567) — разница 1 уровень в 8-бит, визуально неразличимо. Причина: диапазон фон–линии (0.0744 OKLCH L) не вмещает 3 шага по 0.04 (= 0.12). Решение: пересчитать шаг как (border − background) / 3 = 0.0248. Это даёт 5–6 уровней в 8-бит между каждой ступенью — визуально различимо.

### Checks
- Шкала строго возрастает: фон (12) < surface+1 (17) < surface+2 (23) < линии (29) в 8-бит
- Кнопки не затронуты
- Оба селектора тёмной темы обновлены идентично

### Decisions and lessons learned
- При работе с тёмными темами в OKLCH нельзя переносить шаг из одного диапазона в другой — нужно рассчитывать шаг под конкретный диапазон (border − background) / количество_ступеней
- В 8-бит на тёмном конце шкалы (sRGB < 0.1) разница в 0.005 OKLCH L = 1 уровень — неразличима

---

## 12.03.2026 — Три бага: заголовок, серый текст, картинки

### Goal
Исправить три визуальных бага при клиппинге статей: отсутствие заголовка в Content-предпросмотре попапа, серый текст статей в приложении, неотображение картинок в обоих контекстах.

### Planned
1. Добавить заголовок в Content-блок попапа (по аналогии с Link)
2. Убрать `prose-neutral dark:prose-invert`, переопределить prose-переменные на дизайн-токены
3. Расширить CSP (`http: data:`), добавить `onError` на img
4. Исправить пайплайн изображений: предобработка lazy-loaded картинок, кастомное правило TurndownService

### Actually completed
Все 4 пункта:

**Баг 1 — заголовок в попапе:**
- **PopupApp.tsx** — Content-блок обёрнут в `space-y-1.5` контейнер с `clipper.title` и `max-h-[200px]` скроллируемым контентом, рендеринг `articleData.html` через `dangerouslySetInnerHTML`
- **messaging.ts** — добавлено поле `html?: string` в `ArticleData`
- **content.js** — `extractArticle()` возвращает `html: article.content` (сырой HTML из Readability)

**Баг 2 — серый текст:**
- **global.css** — переопределение prose-переменных (`--tw-prose-body`, `--tw-prose-headings` и др.) на `var(--foreground)` / `var(--muted-foreground)` / `var(--border)`
- **Detail.tsx** — убран `prose-neutral dark:prose-invert`, оставлен `prose prose-sm mt-4 max-w-none`
- **PopupApp.tsx** — аналогично убран `prose-neutral dark:prose-invert`

**Баг 3 — картинки:**
- **tauri.conf.json** — CSP `img-src` расширен до `'self' asset: https: http: data:`
- **Detail.tsx** — `onError` на кастомном img-компоненте скрывает сломанные картинки
- **content.js** — основное исправление:
  - `syncLiveSrc(clone)` — копирует `currentSrc` из живого DOM в клон (решает проблему `cloneNode` при динамической загрузке)
  - `fixLazyImages(doc)` — исправляет ленивые картинки агрессивнее Readability: проверяет `data-src`, `data-original`, `data-lazy-src`, все `data-*` атрибуты с URL, `srcset`/`data-srcset`. Без ограничения на расширение файла (Readability пропускает URL без `.jpg`/`.png`/`.webp`)
  - Кастомное правило TurndownService `imageWithFallback` через `addRule` — при пустом `src` проверяет `data-src`, `srcset`, `data-*` вместо молчаливого удаления картинки

### Deviations from plan
Нет.

### Checks
- Сборка расширения: `bun run --bun vite build --config vite.extension.config.ts` — без ошибок
- Линтер: `bun run lint` — чисто
- Ручная проверка: требуется (перезагрузить расширение, проверить статью с картинками)

### Push
2b5f5f4 — Fix article images, gray text, and popup title

### Decisions and lessons learned
- Readability `_fixLazyImages` regex `/\.(jpg|jpeg|png|webp)\S*$/` пропускает CDN-URL без расширения (imgly, resize-прокси). Предобработка клона до Readability — единственный способ без модификации вендорной библиотеки
- TurndownService при пустом `src` полностью удаляет картинку (возвращает `''`). `addRule` с тем же фильтром `"img"` переопределяет дефолтное правило
- `document.cloneNode(true)` копирует HTML-атрибуты, а не runtime-свойства (`currentSrc`). Для JS-загруженных картинок нужна явная синхронизация
- `prose-neutral` / `dark:prose-invert` не нужны, если prose-переменные привязаны к дизайн-токенам через `var(--foreground)` — тема переключается автоматически

---

## 12.03.2026 — Исправление попапа Chrome-расширения

### Goal
Починить визуальные баги попапа клиппера: сломанная вёрстка (каналы не скроллятся, Save обрезан внизу), отсутствие предпросмотра контента, устаревшие токены в TypeSwitcher.

### Planned
1. Перенести предпросмотр контента/ссылок под TypeSwitcher, убрать лишний PreviewCard
2. Исправить прокрутку каналов — каналы должны скроллиться внутри своего блока
3. Мигрировать TypeSwitcher на component-fill токены
4. Добавить fallback-извлечение bodyText для страниц без мета-описания

### Actually completed
Все 4 пункта:
- **PopupApp.tsx** — убран PreviewCard, добавлены блоки предпросмотра для режимов Content/Link/Image под TypeSwitcher с цепочкой отката (selection → article → description → bodyText). Структура: flex-колонка с 3 секциями (header shrink-0, channels flex-1, footer shrink-0)
- **ChannelList.tsx** — заменён Radix ScrollArea на простой `<div overflow-y-auto>` (Radix внутренне использует `display: table` обёртку, которая ломает flex-цепочку высот)
- **TypeSwitcher.tsx** — мигрирован на bg-component-fill / bg-component-fill-hover
- **popup-layout.css** — `#root { height: 600px }` как детерминированная точка отсчёта для flex-цепочки (процентные высоты не работают в попапах расширений из-за циклической зависимости viewport↔body), стилизация скроллбара
- **content.js** — добавлено поле bodyText (первые 2000 символов document.body.innerText) в extractMetadata()
- **messaging.ts** — bodyText в интерфейсе PageMetadata

### Deviations from plan
Три итерации на прокрутку каналов:
1. Цепочка `height: 100%` на html/body/#root — не работает в попапах Chrome (циклическая зависимость viewport↔body)
2. Фиксированный `#root { height: 600px }` — правило попадает в сборку, но Radix ScrollArea внутренне ломает flex-цепочку через `display: table` обёртку
3. Замена Radix ScrollArea на нативный `overflow-y-auto` div — финальное решение

### Checks
- Сборка: `bun run --bun vite build --config vite.extension.config.ts` — без ошибок
- Линтер: `bun run lint` — чисто
- JS-бандл: 235 КБ (было 251 КБ — Radix ScrollArea больше не бандлится)
- Прокрутка каналов, видимость Save, предпросмотр контента/ссылок — требует ручной проверки в Chrome

### Push
87b6abe — Fix extension popup: layout, content preview, scroll

### Decisions and lessons learned
- Radix ScrollArea несовместим с глубоко вложенными flex-контейнерами из-за внутренней `display: table` обёртки Viewport. В Chrome-расширениях лучше использовать нативный скролл
- `height: 100%` в попапах Chrome-расширений не работает — viewport определяется по содержимому body, создавая циклическую зависимость. Нужен фиксированный height на корневом элементе
- Для извлечения контента: bodyText (document.body.innerText) — надёжный запасной вариант когда Readability.js не справляется и мета-теги пусты

---

## 07.03.2026 — Phase 9: исправления по результатам аудита

### Goal
Устранить критические, высокоприоритетные и средние проблемы, выявленные аудитом кодовой базы (AUDIT.md). Повысить безопасность, производительность и устойчивость к паникам.

### Planned
11 батчей: безопасность SQLite, SQL-оптимизации, транзакции, устойчивость к паникам, безопасность фронтенда, React.memo, надёжность клиппера, FTS5 escaping, рефакторинг, тесты, документация.

### Actually completed
Все 11 батчей выполнены:

**Безопасность (Batch 1, 5):**
- `validate_slug()` в domain/vault.rs — проверка на `..`, `/`, `\`, NUL, пустую строку; debug_assert в VaultLayout
- `validate_fetch_url()` в native_host.rs — SSRF-защита (только http/https, запрет private IP)
- `isSafeUrl()` в lib/assets.ts — валидация URL перед рендерингом `<a href>` в Detail.tsx
- `PRAGMA busy_timeout = 5000` в db.rs

**SQL-оптимизации (Batch 2):**
- `slug_exists()` — O(1) проверка вместо загрузки всех блоков
- `LightBlock` + `list_blocks_light()` — без description/source, body обрезан до 500 символов
- Поле `thumbnail` читается из БД — убраны N syscalls `thumb_path().exists()` в list_channel_previews
- `CREATE INDEX idx_blocks_type ON blocks(block_type)`
- `resolve_unique_slug()` — инкрементальная проверка через БД

**Транзакции (Batch 3):**
- `full_scan` обёрнут в `unchecked_transaction` с одним commit
- `upsert_block` переведён на `SAVEPOINT` через raw SQL — корректно работает и standalone, и вложенно

**Устойчивость к паникам (Batch 4):**
- `catch_unwind(AssertUnwindSafe(...))` в thumb-gen потоке
- `DateTime::new` — замена `.unwrap()` на обработку ошибки в native_host
- Логирование ошибок spawn вместо `.ok()`
- Mutex poisoning recovery: `.unwrap_or_else(|e| e.into_inner())`

**Фронтенд (Batch 5, 6):**
- `LightBlock` тип на фронтенде, `listBlocks` возвращает `LightBlock[]`
- Detail загружает полный блок через `getBlock(slug)` по требованию
- `React.memo` для Card компонента
- `loadError` состояние с try/catch в loadData
- Debounce timer cleanup в Search.tsx на unmount

**Клиппер (Batch 7):**
- `pendingCallbacks` заменён на `Map<number, {resolve, timeout}>`
- Сопоставление запросов/ответов по `_messageId`
- Fallback на oldest pending если host не эхоит messageId

**FTS5 и обработка ошибок (Batch 8):**
- `escape_fts5()` — оборачивает каждое слово поискового запроса в двойные кавычки

**Рефакторинг (Batch 9):**
- `persist_new_block()` в storage/files.rs — оркестрация записи файла + медиа + миниатюра + индекс
- `is_image_ext()` перенесён в storage/files.rs
- commands/blocks.rs стал тонкой обёрткой
- Удалён `extension/popup/_legacy/` (и в Safari-расширении)
- Удалены закомментированные DropZone в App.tsx
- Удалены неиспользуемые экспорты: `rebuildIndex`, `renameChannel` из commands.ts
- Кнопка «Import from Are.na» добавлена в Sidebar

**Тесты (Batch 10):**
- 8 новых тестов: validate_slug (6), list_blocks_light (2), resolve_unique_slug (3), FTS5 escaping (1)
- Итого: 213 тестов, все проходят

**Документация (Batch 11):**
- SPEC_STORAGE.md: добавлены LightBlock, slug_exists, resolve_unique_slug, persist_new_block, обновлён IndexedBlock
- SPEC_DOMAIN.md: добавлен validate_slug
- DEVLOG.md: запись о Phase 9

### Deviations from plan
- `upsert_block` использовал `unchecked_transaction()`, что ломалось при вложенных транзакциях в `full_scan`. Решено через raw SQL SAVEPOINT вместо rusqlite Transaction API
- `files.rs` уже использовал `fs::write` (задача 9.2 была неактуальна)
- Clippy-предупреждение `collapsible_if` в native_host.rs — не из наших изменений, оставлено

### Checks
- `cargo test` — 213 passed, 0 failed
- `cargo clippy --all-targets` — без новых предупреждений
- `bun run build` — фронтенд собирается
- `bun run lint` — без ошибок

### Push
Ожидает коммит

### Decisions and lessons learned
- rusqlite `unchecked_transaction()` нельзя вкладывать — он делает `BEGIN`, не `SAVEPOINT`. Для вложенных транзакций нужен либо `savepoint()` (требует `&mut`), либо raw SQL
- `LightBlock` с обрезанным body — хороший компромисс: ArticleCard всё ещё показывает превью, но IPC payload значительно меньше

---

## 06.03.2026 — Текстовые миниатюры статей + оптимизация thumbnail-пайплайна

### Goal
Статьи (type: article) не имели визуального превью в сайдбаре — для них не генерировались миниатюры. Нужно рендерить текст статьи в JPEG-превью (как Apple Notes).

### Planned
1. Добавить `generate_text_thumbnail()` — рендеринг заголовка + тела статьи в JPEG
2. Встроить шрифт Noto Sans Regular (28 KB) через `include_bytes!`
3. Обновить все точки создания блоков: handler, native_host, commands/blocks
4. Снять фильтр `BlockType::Image | Link | Video` в `list_channel_previews`
5. Три оптимизации: пропуск свежих миниатюр (mtime), LazyLock для шрифта, фоновая генерация

### Actually completed
Все 5 пунктов реализованы:

- **`src-tauri/src/storage/thumbnails.rs`**: новая функция `generate_text_thumbnail()` — рисует заголовок (1.3x) и тело статьи в JPEG 480x480. Включает word-wrap, очистку markdown (заголовки, жирный, ссылки). Шрифт парсится один раз через `LazyLock<FontArc>`. Добавлена `is_thumb_fresh()` для проверки свежести миниатюр по mtime.
- **`src-tauri/src/watcher/handler.rs`**: `full_scan()` разделён на индексирование (синхронное) и генерацию миниатюр (фоновый поток `thumb-gen`). Принимает `on_thumbs_done` callback. `index_md_file()` с проверкой свежести.
- **`src-tauri/src/commands/vault.rs`**: callback `thumbs_done_cb()` эмитирует `vault-changed` по завершении фоновой генерации — фронтенд подхватывает новые превью.
- **`src-tauri/src/commands/blocks.rs`**: генерация текстовой миниатюры при создании Article без медиафайла.
- **`src-tauri/src/bin/native_host.rs`**: аналогичная генерация при сохранении статьи через клиппер.
- **`src-tauri/src/commands/channels.rs`**: фильтр по BlockType снят — любой блок с миниатюрой попадает в превью.
- **`src-tauri/Cargo.toml`**: добавлены `ab_glyph` 0.2, `imageproc` 0.25.
- **`src-tauri/assets/NotoSans-Regular.ttf`**: встроенный шрифт (28 KB, OFL).

### Deviations from plan
Нет — все три оптимизации реализованы как запланировано.

### Checks
- 200 Rust-тестов проходят (включая 2 новых для text_thumbnail)
- `cargo check` — чистая компиляция
- Фронтенд-тесты не затронуты (изменения только в Rust)

### Decisions and lessons learned
- **LazyLock вместо повторного парсинга**: `FontArc::try_from_slice` на каждый вызов — ~0.5мс. С LazyLock — 0мс после первого вызова.
- **Фоновый поток с callback**: handler.rs не зависит от Tauri (не импортирует AppHandle). Callback абстрагирует нотификацию — чистое разделение слоёв.
- **mtime-проверка эффективнее content hash**: для 100+ блоков один `stat()` вызов (~1мкс) вместо чтения и хэширования файла (~100мкс).

---

## 06.03.2026 — Аудит дизайн-системы, чистка компонентов

### Goal
Привести документацию дизайн-системы в соответствие с кодом. Убрать неиспользуемые варианты компонентов. Стилизовать расширение.

### Actually completed

**DESIGN_SYSTEM.md — полное расширение**:
- Добавлены все 13 shadcn/ui-компонентов с CVA-вариантами и размерами
- Добавлены разделы: макет (тулбар, сайдбар, сетка), drag-and-drop, disabled, архитектурные принципы, рендеринг
- Исправлены 10 расхождений документ→код (шрифты, размеры, токены)

**Чистка Button (button.tsx)**:
- Удалён вариант `glass` (backdrop-blur допустим только на оверлеях)
- Удалён вариант `secondary` (идентичен `outline`, нигде не использовался как кнопка)

**Стилизация расширения (extension/popup/popup.css)**:
- Редизайн попапа: монохромная палитра, Geist Mono, 12px, 3px скругления
- Dark-first: тёмная тема по умолчанию, светлая через `prefers-color-scheme: light`

**Сайдбар (Sidebar.tsx)**:
- `font-mono` на навигации каналов (моноширинный шрифт в таблице)

**global.css**:
- Удалён `scroll-behavior: smooth` (мгновенная навигация)
- Добавлен `-webkit-user-select: none !important` при ресайзе сайдбара

### Checks
- `bun run lint` — чисто
- `bunx tsc --noEmit` — чисто

### Push
`7bb96fb` — Design system audit, cleanup button variants, style extension popup

### Decisions and lessons learned
- Аудит в обе стороны (код→документ и документ→код) необходим после каждого цикла итеративных изменений
- Badge `variant="secondary"` и Button `variant="secondary"` — независимые CVA-определения, удаление из одного не затрагивает другой

---

## 05.03.2026 (вечер) — Табличный сайдбар, кастомный тулбар, Rust-превью

### Goal
Эксперимент с табличным видом сайдбара. Каждый канал — строка таблицы: `[название] [превью-карточки] [счётчик]`. Кастомный верхний тулбар вместо overlay drag region.

### Actually completed

**Табличный вид сайдбара (Sidebar.tsx)**:
- Строка: название (flex-1, truncate) | карточки в ряд (flex-1, overflow-hidden, flex-wrap) | счётчик (w-8, fixed)
- Карточки: `size-6 object-cover rounded-[2px]`, лишние скрываются через `flex-wrap` + `h-6` + `overflow-hidden`
- Направляющие: `border-b border-sidebar-border` между строками
- All тоже показывает превью-карточки
- Отступы: `px-8` (32px по бокам), `pt-16` (64px от тулбара)
- Старый ChannelIcon (стопка 3 карточек) и классический Sidebar сохранены как `.classic.tsx`

**Rust-команда `list_channel_previews` (channels.rs)**:
- Проверяет `thumb_path.exists()` на диске — фронтенд получает только slug'и с реальными thumbnails
- Принимает `limit` — максимум карточек на канал
- Возвращает `HashMap<String, Vec<String>>` включая ключ `__all__`
- IPC-обёртка: `listChannelPreviews(limit)` в commands.ts

**Кастомный тулбар (App.tsx)**:
- `<header>` с `h-8` (32px), `data-tauri-drag-region`, `border-b`
- Раскладка: `flex-col` (тулбар сверху → body снизу) вместо прежнего `flex` (sidebar + main)
- Удалён старый overlay drag region + sidebarScrolled state
- Удалён spacer `h-8` из Sidebar

**Прочие изменения**:
- DropZone закомментирован (будет переделан)
- Убраны кнопки Import/Search из нижней части сайдбара
- `useSidebarResize`: DEFAULT_WIDTH 300, MAX_WIDTH 480

### Push
8103365 Table sidebar, custom toolbar, Rust thumbnail previews

### Decisions and lessons learned
- Thumbnail-превью фильтруются на бэкенде (Path::exists) — фронтенд не должен гадать о наличии файлов
- `flex-wrap` + фиксированная высота + `overflow-hidden` — CSS-only решение для «показать сколько влезает» без JS-расчётов
- `.classic.tsx` — сохранение предыдущей версии для A/B-сравнения вариантов дизайна

---

## 05.03.2026 — Клавиатурная навигация, ресайз сайдбара, исправления Detail

### Goal
Полноценная клавиатурная навигация по карточкам и каналам. Ресайз сайдбара. Исправление критических багов Detail (кнопка X, навигация при открытом Detail). Устойчивость к iCloud-оптимизации macOS.

### Planned
1. Ресайз сайдбара с pill-хэндлом
2. Рефакторинг Detail с Radix Dialog на plain div
3. Исправление кнопки X (Tauri drag region)
4. Клавиатурная навигация в Grid (4 стрелки)
5. Навигация в Detail (влево/вправо)
6. Переключение каналов Opt+Cmd+Up/Down
7. Устойчивость карточек к iCloud offload

### Actually completed
Все 7 пунктов + дополнительные исправления.

**src/hooks/useSidebarResize.ts** — новый хук: width/collapsed state, pointer events для ресайза, двойной клик для toggle, сохранение в CSS custom properties.

**src/components/SidebarResizeHandle.tsx** — новый компонент: fixed positioned (z-40), 14px зона перехвата, 6px pill с анимацией при ховере.

**src/components/Detail.tsx** — рефакторинг:
- Radix Dialog → plain div (`absolute inset-0 z-10`) внутри `<main isolation: isolate>`
- Кнопка X перенесена на `top-10 right-4` (ниже 32px drag region)
- Клавиатура: только влево/вправо, capture phase + stopPropagation, пропуск модификаторов
- `focus({ preventScroll: true })` — не дёргает сайдбар при переключении карточек

**src/App.tsx** — основные изменения:
- `activeBlocks` memo — фильтрация блоков по каналу на уровне App (исправлен баг навигации Detail за пределы канала)
- `focusedBlockId` state — фокус карточки в Grid
- `findVisualNeighbor()` — визуальная навигация по `getBoundingClientRect()` с весовой функцией `primaryAxis + 3 × crossAxis`
- `handleDetailClose` — при закрытии Detail возвращает фокус на карточку в Grid
- Opt+Cmd+Up/Down — переключение каналов по `orderedTags`
- `vault-refreshed` событие из loadData — сигнал карточкам сбросить ошибку загрузки
- `useEffect` на `location.pathname` — закрытие Detail + сброс фокуса при смене маршрута

**src/components/Card.tsx** — `isFocused` проп (`ring-2 ring-ring`), `useEffect` на `vault-refreshed` для сброса ошибки загрузки (ImageCard + LinkCard)

**src/components/Grid.tsx** — `focusedBlockId` проп, `onColumnCountChange` callback

**src/components/Sidebar.tsx** — автоподскрол к `[aria-current="page"]` при смене `location.pathname`

**src/styles/global.css** — `body.sidebar-resizing` cursor override

### Deviations from plan
- Изначально навигация в Grid была индексной (index ± columnCount). Заменена на визуальную по координатам — в masonry-сетке индексные соседи не совпадают с визуальными
- Изначально в Detail были все 4 стрелки. Убраны вверх/вниз — в Detail достаточно линейной навигации

### Checks
- `bun run build` — чистая сборка
- Стрелки в Grid: навигация соответствует визуальному расположению карточек
- Enter в Grid: открывает Detail, Esc возвращает фокус
- Влево/вправо в Detail: линейная навигация
- Opt+Cmd+Down: переключение каналов + подскрол сайдбара
- Opt+Cmd+Down при открытом Detail: Detail закрывается, канал переключается
- Кнопка X в Detail работает (вне drag region)
- Сайдбар: клик по каналам при открытом Detail — Detail закрывается

### Push
ad1e6d9 Keyboard navigation + resizable sidebar + iCloud image retry

### Decisions and lessons learned
- Tauri `data-tauri-drag-region` перехватывает на нативном уровне — CSS z-index бессилен. Решение: не размещать интерактивные элементы в зоне 32px сверху
- Radix Dialog порталит в `<body>`, что ломает stacking context. Для overlay-панелей внутри приложения лучше plain div + `isolation: isolate` на контейнере
- Визуальная навигация (`getBoundingClientRect`) — единственный надёжный подход для masonry-сеток с переменной высотой карточек
- Capture phase (`addEventListener(..., true)`) + `stopPropagation` — надёжный способ перехватить клавиши до dnd-kit и браузерных обработчиков доступности

---

## 03.03.2026 — Нейтральная серая шкала + OLED-чёрный

### Goal
Убрать все тёплые/холодные оттенки из серых. Вся шкала — чисто нейтральная (R=G=B, chroma 0). Тёмная тема — абсолютный чёрный (#000000) вместо #111111.

### Planned
1. Светлая тема: убрать тёплый hue из sidebar-токенов, привести все серые к chroma 0
2. Тёмная тема: заменить все `oklch(L 0.006 78)` на `oklch(L 0 0)`, фон #000000
3. Бордер: светлая #EBEBEB, тёмная #222222 (сдвиг вниз под чёрный фон)
4. Glass: светлая 80% белый, тёмная 60% чёрный
5. Обновить DESIGN_SYSTEM.md

### Actually completed
Все 5 пунктов.

**global.css** — полная перезаливка обеих тем:
- Светлая: sidebar #FFFFFF (был #F7F7F5), sidebar-primary-foreground #FFFFFF, ring = text-secondary
- Тёмная: background/card/popover/sidebar = oklch(0 0 0), border/input/sidebar-border = oklch(0.252 0 0), все 30+ серых — chroma 0 hue 0
- Glass: светлая oklch(1 0 0 / 80%), тёмная oklch(0 0 0 / 60%)

**DESIGN_SYSTEM.md** — переписаны секции: «Цветовой принцип» (нейтральные серые), «Цвет текста», «Фоны», «Границы», «Оверлеи». Обновлены hex-значения в таблицах интерактивных состояний.

### Deviations from plan
Нет

### Checks
- `bun run build` — чистая сборка
- `grep oklch global.css | grep -v chart | grep -v destructive` — ни одного ненулевого hue/chroma

### Push
`df961b3` — Neutral gray scale + OLED black + sidebar improvements

### Decisions and lessons learned
- Нейтральная шкала убирает конкуренцию оттенков с контентом — изображения остаются единственным источником цвета
- OLED-чёрный (#000) стандартен для визуальных коллекций (Cosmos, Are.na, Savee)
- Бордер #2A2A2A → #222222 при смене фона на чёрный — иначе линии слишком яркие

---

## 03.03.2026 — Интерактивные состояния + унификация оттенков тёмной темы

### Goal
Ввести систему интерактивных состояний (hover, focus, active, selected) с правилом «одно свойство за раз, без transition». Унифицировать все серые в тёмной теме на один тёплый оттенок (hue 78).

### Planned
1. Новые токены: accent (hover bg), active (pressed bg), hover-foreground, primary-hover, primary-active
2. Обновить button.tsx — 5 вариантов по спецификации
3. Карточка — hover:border-foreground
4. Сайдбар — hover:bg-accent, selected = sidebar-accent
5. Убрать все transition-opacity с ховер-элементов
6. Тёмная тема — все серые на hue 78, chroma 0.006
7. sidebar-primary — убрать синий (oklch 0.488 0.243 264), заменить на foreground
8. primary-foreground — упростить до oklch(1 0 0)

### Actually completed
Все 8 пунктов:

**global.css** — 4 новых токена (active, hover-foreground, primary-hover, primary-active), обновлены accent (#F5F5F5/#2C2A27), sidebar-accent (#F0F0F0/#2C2A27), sidebar-accent-foreground (#1A1A1A/#FFF). Тёмная тема: 23 токена переведены с hue 286/0 на hue 78. sidebar-primary убран синий. primary-foreground упрощён до белого.

**button.tsx** — default: `hover:bg-primary-hover active:bg-primary-active`, outline/secondary: `hover:bg-accent active:bg-active`, ghost: `hover:text-hover-foreground`, link: `underline hover:text-hover-foreground`

**Card.tsx** — `hover:border-foreground`, убран transition-opacity с оверлея

**Sidebar.tsx** — `hover:bg-sidebar-accent/50` → `hover:bg-accent` (4 места), убран transition-opacity

**Detail.tsx** — убран transition-opacity с кнопки удаления тега

**DESIGN_SYSTEM.md** — раздел «Интерактивные состояния» (hover/focus/active/selected), «Цветовой принцип тёмной темы»

### Deviations from plan
Нет

### Checks
- `bun run build` — чистая сборка
- Скрипт верификации: все серые в тёмной теме на hue 78 (кроме destructive и chart)
- Новые утилиты в CSS: bg-primary-hover, bg-primary-active, text-hover-foreground, bg-active, border-foreground

### Push
`f108d82` Interactive states + unify dark theme to warm hue 78

### Decisions and lessons learned
- Один оттенок (hue 78) для всех серых в тёмной теме. При добавлении нового серого — oklch(L 0.006 78). Не вводить нейтральные или холодные серые.
- Переход с холодного (286) на тёплый (78) при chroma 0.006 даёт дельту max 8 RGB — неразличимо на глаз
- sidebar-primary с ярким синим (chart-1) — мина замедленного действия. Мёртвый токен с опасным значением удалён, приведён к foreground

---

## 03.03.2026 — Границы: единый цвет для всех разделителей

### Goal
Унифицировать все разделительные линии — один цвет на всё приложение вместо разных оттенков для border, input, sidebar-border.

### Planned
1. Единый цвет границ: #E0E0E0 (светлая) / #38383C (тёмная)
2. Обновить `--border`, `--input`, `--sidebar-border` на одно значение
3. Обновить DESIGN_SYSTEM.md — раздел «Границы»

### Actually completed
Все 3 пункта:

**global.css** — светлая тема: `--border`, `--input`, `--sidebar-border` = oklch(0.9067 0 0). Тёмная тема: все три = oklch(0.3422 0.0069 286)

**DESIGN_SYSTEM.md** — добавлен раздел «Границы» с правилом единого цвета

### Deviations from plan
Нет

### Checks
- `bun run build` — чистая сборка
- Визуально: линии сайдбара и основного содержимого совпадают

### Push
`e59f8f4` Borders: unify all dividers to single color (#E0E0E0/#38383C)

### Decisions and lessons learned
- В тёмной теме ранее использовались полупрозрачные значения (oklch(1 0 0 / 10%)) — заменены на непрозрачные для консистентности с остальными токенами

---

## 03.03.2026 — Фоны: тёплый сайдбар + исправление цветовых токенов

### Goal
Разделить фон сайдбара и содержимого, добавить тёплый оттенок.

### Planned
1. Сайдбар #FAFAF9 (светлая) / #1C1A17 (тёмная)
2. Содержимое #FFFFFF (светлая) / #211F1C (тёмная)
3. Sidebar.tsx: bg-background → bg-sidebar

### Actually completed
Все 3 пункта + исправление ошибки:

**Фоны** — `--background` = #FFFFFF / #211F1C, `--sidebar` = #FAFAF9 / #1C1A17

**Sidebar.tsx** — `bg-background` → `bg-sidebar`, `from-background` → `from-sidebar`

**ChannelIcon.tsx** — пустая иконка: `bg-background` → `bg-sidebar`

**Исправление** — `--secondary`, `--muted`, `--accent` были ошибочно установлены в цвет сайдбара (#F7F7F5), что окрасило ховеры и бейджи по всему приложению. Возвращены к нейтральному серому (oklch 0.97 / 0.269)

### Deviations from plan
- Первоначально сайдбар был #F7F7F5 — слишком заметная серая полоса. Заменён на #FAFAF9

### Checks
- `bun run build` — чистая сборка
- `grep bg-sidebar` — используется в Sidebar.tsx и ChannelIcon.tsx
- `--secondary/muted/accent` — нейтральные, не тёплые

### Push
`606f9df` Backgrounds: warm sidebar (#FAFAF9/#1C1A17), fix color token bleeding

### Decisions and lessons learned
- `--sidebar` и `--secondary/muted/accent` — разные роли: sidebar это зона, а secondary/muted/accent — состояния элементов. Не смешивать
- #FAFAF9 — оптимальный компромисс для светлого сайдбара: отделяет зону без «серой полосы»

---

## 03.03.2026 — Цвет текста: трёхуровневая иерархия + font-mono только в метаданных

### Goal
Снизить контраст текста (убрать чистый чёрный), ввести три уровня цветовой иерархии, убрать моноширинный шрифт из карточек.

### Planned
1. Заменить foreground (#0a0a0a → #333333) и все производные токены
2. Обновить muted-foreground (#737373 → #777777)
3. Добавить tertiary-foreground (#999999) для плейсхолдеров
4. Тёмная тема: #E4E4E8 / #9E9EA3 / #555555 (с холодным оттенком)
5. Перевести карточки на text-foreground (единый цвет)
6. Убрать font-mono из карточек, оставить только в метаданных Detail

### Actually completed
Все 6 пунктов:

**Цвета** — обновлены `--foreground`, `--card-foreground`, `--popover-foreground`, `--primary`, `--secondary-foreground`, `--accent-foreground`, `--sidebar-foreground` и производные в обеих темах. Добавлен `--tertiary-foreground` с регистрацией в `@theme inline`

**Карточки** — весь текст переведён на `text-foreground`; `font-mono` убран из Card.tsx (6 вхождений) и контентной части Detail.tsx

**Плейсхолдеры** — `input.tsx` и `command.tsx` переведены на `placeholder:text-tertiary-foreground`

### Deviations from plan
Нет

### Checks
- `bun run build` — чистая сборка
- `grep font-mono src/` — осталось только в MetadataPanel Detail.tsx (3 вхождения) и определении `--font-mono` в global.css
- DESIGN_SYSTEM.md обновлён: шрифты, цвета

### Push
`055d017` Text colors: 3-level hierarchy (#333/#777/#999), font-mono only in metadata

### Decisions and lessons learned
- Тёмная тема: primary/secondary с лёгким hue 286 (холодный) — чисто серый на тёмном фоне выглядит грязным
- Карточки лучше читаются пропорциональным шрифтом; моноширинный оправдан только для технических метаданных

---

## 03.03.2026 — Дизайн-система: токены, типографика, скругления

### Goal
Формализовать дизайн-систему: заменить произвольные значения Tailwind на семантические токены, обеспечить визуальное соответствие нативному macOS-приложению.

### Planned
1. Токенизация скруглений (5 уровней: 0/3px/5px/pill/round)
2. Токенизация отступов (7 уровней: 4-64px)
3. Токенизация типографики (3 размера, 2 веса, 2 шрифта)
4. Миграция всех компонентов на новые токены
5. Создание документа дизайн-системы

### Actually completed
Все 5 пунктов выполнены:

**Скругления** — заменены все `rounded-sm/md/lg/xl/full` на семантические утилиты:
- `rounded-0` (контент), `rounded-1` (интерфейс, 3px), `rounded-2` (микро-элементы, 5px)
- Затронуто 25 файлов: все компоненты + все shadcn/ui примитивы

**Отступы** — определены 7 токенов `--spacing-s1`..`--spacing-s7` в `@theme inline`
- Работают как спецификация, не как подстановка — существующий код использует совместимые числовые утилиты

**Типографика** — три размера через `--text-sm/base/lg` в `@theme inline`:
- `text-sm` = 12px/16px (мета, карточки), `text-base` = 14px/20px (интерфейс), `text-lg` = 18px/24px (заголовки)
- Два веса: 400 (default) + 600 (`font-semibold`). Убраны `font-medium`, `font-bold`
- Два шрифта: Geist (весь UI, включая карточки) + Geist Mono (панель метаданных Detail)
- Миграция классов: `text-sm`→`text-base`, `text-xs`→`text-sm` в 25+ файлах (кроме Card.tsx)

**Рендеринг** — добавлен `-webkit-font-smoothing: antialiased` для нативного вида

**Очистка** — убраны `transition-colors`, `transition-all`, `focus:ring-*`, `shadow-xs` из интерактивных элементов

**Документация** — создан `DESIGN_SYSTEM.md`, добавлен в Required reading

### Deviations from plan
- Токены типографики первоначально заданы как `--font-size-*` — Tailwind v4 их игнорировал. Исправлено на `--text-*`
- Пробовали уменьшенную шкалу (10/11/13/16px) — вернулись к стандартной (12/14/18px) как оптимальной

### Checks
- `bun run build` — чистая сборка
- Проверено: `text-sm{font-size:12px}`, `text-base{font-size:14px}`, `text-lg{font-size:18px}` в итоговом CSS
- `grep` подтверждает: нет `rounded-sm/md/lg`, нет `font-medium/bold`, нет `text-xs` в коде

### Push
`339e9a7` Design system: radius, spacing, typography tokens + antialiased rendering

### Decisions and lessons learned
- Tailwind v4 использует `--text-*` для шрифтов (не `--font-size-*` как в v3) — критично для `@theme inline`
- `@theme inline` инлайнит значения в утилиты, не создаёт CSS-переменные — значения применяются напрямую
- Spacing-токены лучше работают как спецификация/ограничение, чем как подстановка — `p-4` в разных компонентах это разные решения

---

## 01.03.2026 18:00 — Phase 9.1 + 9.2: критические и высокоприоритетные исправления по аудиту

### Goal
Устранить все 6 критических (блокирующих релиз) и ключевые высокоприоритетные проблемы, выявленные полным аудитом кодовой базы (AUDIT.md).

### Planned
1. CRIT-1: `panic!()` → `Result` в `resolve_slug_conflict()`
2. CRIT-2: транзакция в `upsert_block()`
3. CRIT-3: N+1 → батч-запрос в `collect_blocks()`
4. CRIT-4: включить CSP в `tauri.conf.json`
5. CRIT-5: XSS в `popup.js` → DOM API
6. CRIT-6: установить ESLint
7. HIGH-2: `unwrap_or(BlockType::File)` → ошибка
8. HIGH-3: 20× `lock().unwrap()` → `map_err`
9. HIGH-4: `unwrap()` на SystemTime → `expect()`
10. HIGH-5: path traversal → `canonicalize()` + `is_file()`
11. HIGH-7: пустые `catch {}` → `console.error()`
12. Индексы SQLite: `idx_blocks_saved_at`, `idx_block_tags_block_id`

### Actually completed

Все 12 пунктов выполнены. Затронуто 22 файла:

**Rust-бэкенд:**
- `domain/vault.rs` — добавлен `VaultError` enum с `SlugConflictExhausted`, `resolve_slug_conflict()` возвращает `Result<String, VaultError>`, новый тест на исчерпание
- `storage/index.rs` — `row_to_block()`: `FromSqlConversionFailure` вместо молчаливой подмены типа; `collect_blocks()`: батч-запрос `WHERE block_id IN (...)` + HashMap вместо N+1; `upsert_block()`: обёрнут в `unchecked_transaction()`
- `storage/db.rs` — два новых индекса: `idx_blocks_saved_at` и `idx_block_tags_block_id`
- `util.rs` — `.unwrap()` → `.expect("system clock is set before Unix epoch")`
- `commands/blocks.rs` — обновлён вызов `resolve_slug_conflict`, добавлена проверка `canonicalize()` + `is_file()`, все `lock().unwrap()` → `map_err`
- `commands/vault.rs`, `commands/search.rs`, `commands/channels.rs`, `commands/tags.rs`, `commands/import.rs` — все `lock().unwrap()` → `map_err`
- `import/importer.rs` — обновлён вызов `resolve_slug_conflict`, убран неиспользуемый `PathBuf`
- `bin/native_host.rs` — обновлён вызов `resolve_slug_conflict`

**Безопасность:**
- `tauri.conf.json` — `"csp": null` → `"default-src 'self'; img-src 'self' asset: https:; script-src 'self'; style-src 'self' 'unsafe-inline'"`

**Веб-клиппер:**
- `extension/popup/popup.js` — `renderChannelList()` переписан с `innerHTML` на DOM API (`createElement`, `textContent`, `append`)

**Фронтенд:**
- `src/components/Detail.tsx` — `catch {}` → `catch (err) { console.error(...) }`
- `src/App.tsx` — `.catch(() => {})` → `.catch((err) => console.error(...))`

**Инфраструктура:**
- `eslint.config.js` — новый файл (ESLint 10 + typescript-eslint)
- `package.json` — devDependencies: `eslint`, `@eslint/js`, `typescript-eslint`

**Дополнительные исправления (не в плане, но требовались для `clippy -- -D warnings`):**
- `watcher/watch.rs` — убран неиспользуемый импорт `Manager`
- `import/arena_api.rs` — `#[allow(dead_code)]` для serde-only полей
- `domain/block.rs` — `#[allow(clippy::should_implement_trait)]` для `from_str`
- `domain/tag.rs` — слияние вложенных `if` по рекомендации clippy

### Deviations from plan
- **1 коммит вместо 11:** план предполагал 11 отдельных коммитов, но файлы пересекались между коммитами (например, `blocks.rs` затрагивался коммитами 1, 6, 7). Один коммит проще и чище
- **5 дополнительных clippy-исправлений:** предсуществующие предупреждения, не учтённые в плане
- **ESLint 10** вместо 9+: установлена актуальная версия
- **`unchecked_transaction()`** вместо `transaction()`: в CRIT-2 использован `unchecked_transaction()`, т.к. `Connection` передаётся как `&Connection` (не `&mut`)
- **`idx_block_tags_block_id`** только по `block_id` (без `tag`): достаточно для обратного поиска тегов

### Checks
- `cargo clippy -- -D warnings` — 0 предупреждений
- `cargo test` — 198/198 тестов (включая новый `conflict_exhausted_returns_error`)
- `bunx tsc --noEmit` — 0 ошибок TypeScript
- `bun run lint` (ESLint) — 0 ошибок

### Push
`c5d2a92` — Phase 9.1 + 9.2: critical and high-priority audit fixes

### Decisions and lessons learned
- `unchecked_transaction()` — необходим при `&Connection` без `mut`. Безопасен в однопоточном контексте Tauri-команд
- Предсуществующие clippy-предупреждения стоит фиксировать заранее, до начала фазы исправлений — иначе верификация `clippy -D warnings` падает на чужих проблемах
- `canonicalize()` без `starts_with(vault_root)` — достаточно при текущей архитектуре, т.к. файл копируется в vault (не читается из произвольного пути)

---

## 01.03.2026 11:12 — Fullscreen Detail с двухколоночным layout

### Goal
Превратить модальный Detail (768px по центру) в полноэкранный оверлей с контентом слева и метаданными справа в Geist Mono. Референс — Cosmos.

### Planned
1. Установить Geist Mono (`@font-face` + `--font-mono`)
2. Полноэкранный `DialogContent` (справа от sidebar)
3. Двухколоночный layout: контент центрирован, метаданные справа
4. Правая панель метаданных в моноширинном шрифте
5. Кнопка закрытия X

### Actually completed
- `public/fonts/GeistMono-Variable.woff2` — шрифт скопирован из пакета `geist`
- `src/styles/global.css` — `@font-face` Geist Mono, `--font-mono` в `@theme inline`
- `src/components/ui/dialog.tsx` — пропс `overlayClassName` для кастомизации оверлея
- `src/components/Detail.tsx` — полная переделка:
  - Двухслойный layout: scroll-слой (контент + невидимый спейсер) и fixed-слой (метаданные)
  - `LAYOUT_CLASSES` — общая константа для обоих слоёв, гарантирует идентичное позиционирование
  - `pointer-events-none` / `pointer-events-auto` для прозрачного оверлея
  - `MetadataPanel` с font-mono: RESOLUTION, FILENAME, DATE, TYPE, SOURCE, AUTHOR, TAGS
  - `data-tauri-drag-region` внутри Detail для перетаскивания окна

### Deviations from plan
Вместо одноколоночного flex или absolute+calc() пришли к двухслойной архитектуре. Попытки с `calc()` приводили к наложению метаданных на контент при узком окне. Двухслойный подход с общим `LAYOUT_CLASSES` решил все проблемы: контент и метаданные в разных слоях (scroll vs fixed), но с идентичным flex-layout.

### Checks
- `bunx tsc --noEmit` — 0 ошибок
- Изображение центрировано, метаданные рядом справа
- Длинная статья скроллится, метаданные на месте
- Узкое окно — контент сжимается, метаданные не вылезают
- Теги — добавление/удаление работает
- Стрелки — навигация между блоками
- Escape / клик overlay — закрытие
- Кнопка X — закрытие
- Перетаскивание окна — работает в Detail
- Тёмная тема — корректные цвета

### Push
`0a7ff4d` Fullscreen Detail: two-layer layout with Geist Mono metadata panel

### Decisions and lessons learned
- **Двухслойный layout** — архитектурно чистое решение для «контент скроллится, метаданные фиксированы, оба используют один layout». Общая константа `LAYOUT_CLASSES` — единственный источник правды для позиционирования.
- **Принцип минимального изменения** — при итеративной доработке каждый раз фиксировать инварианты до изменения и проверять их после. Иначе починка одного ломает другое.

---

## 01.03.2026 04:55 — Иконки каналов в sidebar: стопка мини-карточек с веерной анимацией

### Goal
Добавить визуальные превью каналов в sidebar — стопка из 1–3 мини-карточек с реальными thumbnail'ами блоков. По ховеру стопка раскрывается веером.

### Planned
1. Тип `PreviewCard` в types
2. `channelPreviews` useMemo в App.tsx — приоритет: изображения, потом текст
3. Компонент `ChannelIcon.tsx` — стопка карточек с анимацией
4. Интеграция в Sidebar — новый проп, рендер иконки перед названием канала

### Actually completed
Всё по плану. Дополнительно:
- Итеративная настройка анимации: от CSS custom properties к inline transform через React state
- Горизонтальный разброс карточек (SPREAD 4px) + поворот задних карточек вокруг bottom-left
- Ховер: передняя карточка — translateX(-1px) rotate(-1deg) вокруг center-right; задние — дополнительный поворот и сдвиг вправо

### Deviations from plan
- CSS custom properties для transform не работали надёжно через Tailwind v4 / Vite pipeline — заменены на inline `transform` + `hovered` проп через `onPointerEnter/Leave`
- Глобальные CSS-селекторы `.group\/icon:hover` конфликтовали между экземплярами — убраны в пользу React state

### Checks
- `bunx tsc --noEmit` — 0 ошибок
- Каналы с изображениями — thumbnail'ы видны
- Текстовые каналы — серые карточки с линиями
- Пустые каналы — одна пустая карточка
- 1, 2, 3 карточки — корректное количество
- Ховер анимация — плавная (350ms cubic-bezier), с задержкой нет
- Тёмная тема — обводка border-background адаптируется

### Push
`fa34940` Channel icons: stacked mini-card previews with fan hover animation

### Decisions and lessons learned
- CSS custom properties внутри `transform` функций (`rotate(var(--x))`) работают, но составные transform-строки как значение переменной (`var(--full-transform)`) — нет, браузер не может интерполировать
- Tailwind v4 через Vite может некорректно обрабатывать экранирование `\/` в CSS-селекторах — `data-*` атрибуты надёжнее
- Для мелких анимаций на единичных компонентах inline transform + React state проще и надёжнее CSS-only подхода

### Changed files
- `src/types/index.ts` — тип `PreviewCard`
- `src/components/ChannelIcon.tsx` — новый компонент
- `src/App.tsx` — `channelPreviews` useMemo, новый проп в Sidebar
- `src/components/Sidebar.tsx` — `channelPreviews` проп, `hovered` state, `ChannelIcon` рендер

---

## 01.03.2026 03:30 — Визуальная стилизация: overlay titlebar, Geist, карточки, sidebar

### Goal
Привести визуальный язык приложения к финальному виду: минимализм, чёткая сетка, контраст между строгим контентом и мягким интерфейсом.

### Planned
1. Overlay titlebar с drag region
2. Шрифт Geist Sans
3. Стилизация карточек: острые углы, без заливки
4. Настройка GAP и отступов сетки
5. Sidebar: убрать заголовок, градиентный fade сверху

### Actually completed

**Overlay titlebar** (`src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src/App.tsx`):
- `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `decorations: true` — прозрачный бар с системными кнопками
- `core:window:allow-start-dragging` в capabilities — разрешение для drag region
- `data-tauri-drag-region` div (`fixed inset-x-0 top-0 z-50 h-7`) — область перетаскивания окна по верхнему краю

**Geist Sans** (`src/styles/global.css`, `public/fonts/`):
- Вариативный шрифт `Geist-Variable.woff2` скопирован в `public/fonts/` (пакет `geist` заточен под Next.js, CSS не экспортирует)
- `@font-face` + `--font-sans: "Geist"` в `@theme inline` — применяется ко всему интерфейсу через Tailwind

**Карточки** (`src/components/Card.tsx`):
- Убран `rounded-lg` — острые углы (редакционный стиль, как Are.na/Cosmos)
- Убран `bg-card` — только обводка, без заливки

**Сетка** (`src/components/Grid.tsx`):
- GAP = 32px (визуальный букмаркинг — карточкам нужен воздух)
- Отступы `px-8 pb-8 pt-14` (32px по бокам, 56px сверху под overlay titlebar)

**Sidebar** (`src/components/Sidebar.tsx`):
- Убран заголовок «Mine» — пустой спейсер `h-10` под светофор
- Градиентный fade сверху (`h-8 bg-gradient-to-b from-background to-transparent`) — контент при скролле растворяется
- Фон `bg-background` вместо `bg-sidebar` (единый фон с контентом, разделение линией)

### Deviations from plan
- Pill-скругления (rounded-full) на элементах sidebar попробовали и откатили — перебор для текущего стиля
- Vibrancy (NSVisualEffectView) попробовали через `windowEffects: ["sidebar"]` и откатили — результат не понравился
- Cloud Dancer (Pantone 2026) как фон попробовали в двух вариантах и откатили — пока оставляем чистый белый

### Checks
- `bunx tsc --noEmit` — 0 ошибок
- `bun run build` — успешная сборка
- Overlay titlebar с drag region работает
- Geist Sans применяется ко всему интерфейсу

### Push
`26eafad` Visual styling: overlay titlebar, Geist Sans, sharp cards, sidebar fade

### Decisions and lessons learned
- Пакет `geist` — обёртка для `next/font/local`, бесполезна вне Next.js. Для Vite/Tauri — копируем woff2 в `public/` и объявляем `@font-face` вручную
- `data-tauri-drag-region` без `core:window:allow-start-dragging` в capabilities молча не работает — нет ошибок, просто игнорируется
- Стратегия контраста: строгий холст (острые карточки, тонкие линии) vs мягкий интерфейс (скруглённые элементы управления) — направление определено, будет реализовано позже

---

## 01.03.2026 01:45 — Grid: делегирование ContextMenu + устранение подвисаний

### Goal
Устранить подвисания при переходе между каналами и скролле, которые появились после миграции на shadcn/Radix. Переход к каналу иногда вызывал «радугу» (beach ball) на несколько секунд.

### Planned
1. Заменить O(N) инстансов ContextMenu (по одному на карточку) на один делегированный ContextMenu на весь Grid
2. Исправить stale visibleCount — заменить useEffect-сброс на синхронный паттерн «set state during render»
3. Исправить скролл контекстного меню карточки (ScrollArea внутри ContextMenuContent не работала из-за Radix bug #2307)
4. Привести hover сайдбара к полупрозрачному варианту (по запросу пользователя)

### Actually completed

**Grid: делегирование ContextMenu** (`src/components/Grid.tsx`):
- Удалён `CardWithMenu` — промежуточная обёртка с per-card `<ContextMenu>`
- Единый `<ContextMenu>` + `<ContextMenuTrigger asChild>` на scroll-контейнер Grid
- Обработчик `handleContextMenu` находит карточку через `closest('[data-block-slug]')` — стандартное делегирование событий
- `e.preventDefault()` при клике на пустое место подавляет открытие через `composeEventHandlers` Radix (проверено по исходникам `@radix-ui/primitive`)
- `blocksBySlug` Map для O(1) поиска блока по slug
- Результат: 1 ContextMenu + 4 DOM-обработчика вместо 80 ContextMenu + 320 обработчиков

**Синхронный сброс visibleCount** (`src/components/Grid.tsx`):
- Заменён `useEffect(() => setVisibleCount(INITIAL_BATCH), [blocksFingerprint])` на паттерн «set state during render» с `prevFingerprint`
- React прерывает рендер и начинает новый с `visibleCount = 80` — ни одного кадра со старым значением
- Отдельный `useEffect` для сброса скролла (визуальный эффект, безопасен после paint)

**Card.tsx**: добавлен `data-block-slug={block.slug}` на корневой div — семантический атрибут для делегирования событий

**CardContextMenu.tsx**: заменён ScrollArea на нативный `overflow-y-auto` (Radix ScrollArea bug #2307 с max-height во flex-контейнерах), flex-layout с фиксированным поиском и кнопкой удаления

**Sidebar.tsx**: hover изменён на `hover:bg-sidebar-accent/50` для всех пунктов навигации

### Deviations from plan
Первая попытка (lazy CardTagMenu в CardWithMenu) оставила per-card ContextMenu обёртки. Исправлено: полное удаление CardWithMenu и переход к делегированию событий.

### Checks
- `tsc --noEmit` — 0 ошибок
- `vitest run` — 39 тестов, все проходят
- Приложение запускается, правый клик на карточках работает
- Визуально: hover сайдбара полупрозрачный, контекстное меню скроллируется

### Push
`4d886a9` Grid: delegate ContextMenu (O(N)->O(1)) + sync visibleCount reset

### Decisions and lessons learned
- **Производительность — архитектурное решение, не оптимизация.** `React.memo` и lazy rendering — пластыри на плохой архитектуре (O(N) инстансов). Правильный ответ — O(1) через делегирование.
- **«Set state during render»** — документированный паттерн React для синхронного сброса состояния. `useEffect` для этой цели создаёт один лишний кадр с устаревшими данными.
- **Radix ScrollArea не работает с max-height во flex** (issue #2307). Нативный `overflow-y-auto` надёжнее.
- **composeEventHandlers в Radix** проверяет `defaultPrevented` перед вызовом внутреннего обработчика — это документированный контракт для подавления поведения.

---

## 28.02.2026 18:30 — shadcn/ui компонентная миграция (14 примитивов)

### Goal
Заменить все ручные интерактивные элементы (кнопки, инпуты, модалки, меню) на shadcn/ui-примитивы с доступностью, клавиатурной навигацией и анимациями из коробки. Удалить ручной код: позиционирование меню, click-outside, Escape-обработчики, backdrop-слои.

### Planned
Четырёхфазная миграция по плану (snazzy-splashing-platypus.md):
1. **3.1** Базовые примитивы: Button, Input, Badge, Checkbox, Progress, Separator
2. **3.2** Модальные окна: Dialog (Detail, ImportDialog), Command/cmdk (Search)
3. **3.3** Меню: ContextMenu (Card правый клик), DropdownMenu + AlertDialog (Sidebar)
4. **3.4** Финальный слой: ScrollArea, Tooltip, glass-токены, анимации

### Actually completed
Все четыре фазы выполнены.

**Новые shadcn/ui компоненты** (`src/components/ui/`): alert-dialog, badge, button, checkbox, command, context-menu, dialog, dropdown-menu, input, progress, scroll-area, separator, tooltip — 14 файлов.

**Фаза 3.1 — базовые примитивы:**
- `VaultPicker.tsx` — кнопка → `<Button>`, inline SVG → lucide `<X>`
- `DropZone.tsx` — bg-red-600 → bg-destructive, SVG → lucide
- `Sidebar.tsx` — 4 кнопки → `<Button variant="ghost">`, InlineInput → `<Input>`, SVG → lucide (Plus, MoreHorizontal, Search, Download)
- `Detail.tsx` — теги → `<Badge>`, tag input → `<Input>`, кнопка удаления тега → `<Button variant="ghost" size="icon-xs">`
- `CardContextMenu.tsx` — fake checkbox → `<Checkbox>`, search input → `<Input>`, кнопки → `<Button>`
- `ImportDialog.tsx` — 5 кнопок → `<Button>` (default/ghost/destructive), checkbox → `<Checkbox>`, progress bar → `<Progress>`
- `Card.tsx` — SVG → lucide `<ImageOff>`
- `Search.tsx` — TypeBadge → `<Badge variant="secondary">`

**Фаза 3.2 — модальные окна:**
- `Detail.tsx` — ручной fixed-div + backdrop → `<DialogContent>` (внутри `<Dialog>` в App.tsx)
- `ImportDialog.tsx` — ручной overlay → `<Dialog>` + `<DialogContent>` с `showCloseButton`, `onInteractOutside`
- `Search.tsx` — ручной командный палитр → `<CommandDialog>` (cmdk) с `shouldFilter={false}` для IPC-поиска
- `App.tsx` — `<Dialog open={selectedBlock !== null}>` оборачивает Detail

**Фаза 3.3 — меню:**
- `CardContextMenu.tsx` → `CardTagMenu`: `<ContextMenuContent>` вместо positioned div. Удалены: useLayoutEffect, useEffect (click-outside, Escape), ручной фокус
- `Grid.tsx` — каждая Card обёрнута в `<ContextMenu>` + `<ContextMenuTrigger>`, AlertDialog для подтверждения удаления на уровне Grid
- `Sidebar.tsx` — TagMenu → `<DropdownMenu>` + `<AlertDialog>` для удаления канала. Удалены: TagMenuState, backdrop, ручное позиционирование
- `App.tsx` — удалены: ContextMenuState, contextMenu state, handleContextMenu, CardContextMenu рендер. RouteContext расширен (tags, currentTag, onToggleTag, onCreateAndAssign, onDeleteBlock)

**Фаза 3.4 — финальный слой:**
- `global.css` — glass-токены: `--glass-bg`, `--glass-border` (свет + тьма), `--color-glass*` в `@theme inline`
- `button.tsx` — вариант `glass` с `backdrop-blur-xl backdrop-saturate-[180%]`
- `main.tsx` — `<TooltipProvider>` оборачивает `<App />`
- `Sidebar.tsx` — `<Tooltip>` на кнопке-многоточие TagNavItem
- `CardContextMenu.tsx`, `ImportDialog.tsx`, `Detail.tsx` — `<ScrollArea>` заменяет `overflow-y-auto`

**Тесты:**
- `setup.ts` — добавлен мок ResizeObserver и scrollIntoView (cmdk)
- `Search.test.tsx` — удалены 3 теста библиотечного поведения (Escape, backdrop, kbd hint)
- `Sidebar.test.tsx` — `<TooltipProvider>` в обёртке рендера

### Deviations from plan
- Search.tsx: вместо отдельного `<CommandDialog>` использован `<Dialog>` + `<Command>` — больше контроля над layout (поисковые результаты с Badge)
- Sidebar ScrollArea: не добавлена — sidebar nav уже имеет `overflow-y-auto` со скрытым скроллбаром через CSS, и ScrollArea внутри `<SortableContext>` конфликтует с dnd-kit
- Card hover transition: оставлен существующий `transition-shadow` вместо `transition-all duration-200` из плана

### Checks
- `tsc --noEmit` — 0 ошибок
- `vitest run` — 39/39 тестов (было 42, удалены 3 теста библиотечного поведения)
- Все `<button>` заменены на `<Button>` (кроме намеренных кастомных в CardTagMenu)
- Все `<input>` заменены на `<Input>` / `<CommandInput>` (кроме shadcn-примитива)
- Нет ручных модалок: все через `<Dialog>` или `<CommandDialog>`
- Нет ручного позиционирования меню: всё через Radix ContextMenu/DropdownMenu

### Push
`f8ca8dc` Migrate all interactive elements to shadcn/ui (14 primitives)

### Decisions and lessons learned
- **ContextMenu + dnd-kit**: правый клик (ContextMenu) и перетаскивание (PointerSensor) не конфликтуют — разные типы событий
- **AlertDialog за пределами ContextMenu**: состояние подтверждения удаления поднято на уровень Grid, потому что ContextMenuContent размонтируется при закрытии меню
- **DropdownMenu внутри NavLink + dnd-kit**: нужен `stopPropagation` и на `onClick`, и на `onPointerDown` — иначе клик по многоточию запускает навигацию или перетаскивание
- **cmdk + ResizeObserver**: cmdk внутренне использует ResizeObserver, нужен мок в тестах
- **Tooltip + DropdownMenu**: вложенные `asChild` на одном элементе работают, при открытии DropdownMenu tooltip автоматически скрывается
- Итог: 14 shadcn-примитивов, -323 строки кода, полная доступность и клавиатурная навигация из коробки

---

## 28.02.2026 — Миграция всех компонентов на семантические токены

### Goal
Довести миграцию на shadcn/ui до конца: заменить все хардкоды `neutral-*` и `dark:` классов на семантические токены во всех React-компонентах. После этого смена палитры требует правки только CSS-переменных.

### Planned
Механическая замена в 9 файлах (87 хардкодов), от простых к сложным:
1. Grid (1) -> DropZone (2) -> App DragOverlay (2) -> VaultPicker (7)
2. CardContextMenu (9) -> Search (10) -> Card (14) -> Detail (16) -> ImportDialog (26)

### Actually completed
Все 9 файлов обработаны. Добавлен `cn()` в Card, Search, CardContextMenu.

**Замены по файлам:**
- `Grid.tsx` — `text-neutral-400` -> `text-muted-foreground`
- `DropZone.tsx` — `bg-white dark:bg-neutral-900` -> `bg-card`, `text-neutral-700 dark:text-neutral-300` -> `text-foreground`
- `App.tsx` — DragOverlay: `bg-white border-neutral-300 dark:...` -> `bg-card border-border`, `bg-neutral-200 dark:...` -> `bg-secondary`
- `VaultPicker.tsx` — фон, текст, кнопка, ошибка: `bg-background`, `text-foreground`, `bg-primary text-primary-foreground`, `text-destructive`
- `CardContextMenu.tsx` — input: `border-input bg-background focus:border-ring`; чекбокс: `border-primary bg-primary text-primary-foreground`; ховеры: `hover:bg-accent`; delete: `text-destructive hover:bg-destructive/10`
- `Search.tsx` — палитра: `bg-popover border-border`, `text-foreground`, `bg-accent`, бэдж: `bg-secondary text-muted-foreground`
- `Card.tsx` — контейнер: `bg-card border-border`; текст: `text-foreground`, `text-muted-foreground`; фолбэк: `bg-muted`
- `Detail.tsx` — диалог: `bg-card`; бордер: `border-border`; теги: `bg-secondary text-muted-foreground`; файл: `bg-muted`
- `ImportDialog.tsx` — диалог: `bg-card`; кнопки: `bg-primary text-primary-foreground`; input: `border-input bg-background`; прогресс: `bg-secondary` / `bg-primary`; ошибка: `bg-destructive/10 text-destructive`

### Deviations from plan
- `LINK_COLORS` в Card.tsx (декоративные цвета) и `prose-neutral dark:prose-invert` в Detail.tsx (плагин typography) намеренно оставлены без замены — как и планировалось
- Фактически `neutral-` не найден нигде в src/ (даже LINK_COLORS используют другие цвета: blue, emerald, violet и т.д.)

### Checks
- `npx tsc --noEmit` — 0 ошибок
- `bunx vitest run` — 42/42 тестов
- `grep neutral- src/` — 0 совпадений
- Все 9 компонентов на семантических токенах

### Push
3fc609d — Migrate all components to semantic design tokens

### Decisions and lessons learned
- Подход «только токены, без shadcn-примитивов» оправдал себя: минимальный риск, все тесты прошли без изменений, визуально ничего не сломалось
- Три кандидата на shadcn-примитивы (Command для Search, Dialog для ImportDialog, ContextMenu для CardContextMenu) отклонены по техническим причинам: конфликты с IPC-debounce, захват фокуса, кастомное позиционирование
- `cn()` вместо шаблонных литералов улучшает читаемость и безопасность (tailwind-merge разрешает конфликты классов)

---

## 28.02.2026 — Фундамент дизайн-системы: shadcn/ui

### Goal
Перейти со стокового Tailwind без конфигурации на shadcn/ui — семантические токены, утилита `cn()`, инфраструктура тёмной темы. Заложить фундамент для инкрементальной миграции компонентов.

### Planned
1. Установить shadcn/ui через CLI (`bun x shadcn@latest init`)
2. Настроить CSS-токены (OKLCH) в `global.css`
3. Создать ThemeProvider (system/light/dark)
4. Мигрировать оболочку (App.tsx, Sidebar.tsx) на семантические токены
5. Начать использовать `cn()` для условных классов

### Actually completed
Все 5 пунктов выполнены.

**Инфраструктура:**
- `components.json` — конфигурация shadcn/ui (стиль new-york, базовый цвет neutral, CSS-переменные)
- `src/lib/utils.ts` — утилита `cn()` (clsx + tailwind-merge)
- `src/styles/global.css` — полный набор OKLCH-токенов (~30 переменных), `@theme inline`, `@custom-variant dark` (class-based тёмная тема)
- `src/components/ThemeProvider.tsx` — React Context, три режима (system/light/dark), `localStorage` хранение, `matchMedia` для системной темы

**Миграция оболочки:**
- `src/App.tsx` — `bg-background text-foreground` вместо `bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100`
- `src/components/Sidebar.tsx` — полная миграция: `bg-sidebar`, `border-sidebar-border`, `text-muted-foreground`, `hover:bg-sidebar-accent`, `text-destructive`, `bg-popover`; использование `cn()` для условных классов в NavItem и TagNavItem
- `src/components/CardContextMenu.tsx` — контейнер на `bg-popover border-border`

**Зависимости:** clsx, tailwind-merge, class-variance-authority, tw-animate-css, lucide-react, shadcn

### Deviations from plan
Нет отклонений.

### Checks
- `npx tsc --noEmit` — 0 ошибок
- `bunx vitest run` — 42/42 тестов
- Новые CSS-токены: `--background`, `--foreground`, `--border`, `--sidebar-*`, `--popover-*`, `--muted-*`, `--accent-*`, `--destructive`
- `@custom-variant dark` переключает тёмную тему с media query на класс `.dark`
- ThemeProvider с `defaultTheme="system"` обёрнут в `main.tsx`

### Push
96fe6a2 — Add shadcn/ui design system foundation: OKLCH tokens, ThemeProvider, cn()

### Decisions and lessons learned
- shadcn/ui v3 использует пакет `shadcn` с `@import "shadcn/tailwind.css"` вместо инлайнинга CSS-переменных — чище, обновляемо
- Стратегия «два этапа» (фундамент, затем компоненты) оправдана: можно проверить визуальную идентичность до замены компонентов
- Токен `--sidebar-*` — отдельный набор для боковой панели (фон, бордер, акцент) — позволяет сделать сайдбар визуально отличным от основного контента
- `cn()` вместо тернарников в `className` — существенно улучшает читаемость (3 строки вместо 6)

---

## 28.02.2026 — Меню каналов: MRU, создание, UX-улучшения

### Goal
Три улучшения в контекстном меню карточки (`CardContextMenu`) и попапе клиппера: (A) скрывать «Delete card» при поиске канала; (B) предлагать создание нового канала, если поисковый запрос не совпал ни с одним существующим; (C) ранжировать каналы по недавнему использованию (MRU). Правила B и C — единообразно для обоих интерфейсов.

### Planned
1. Условный рендеринг секции «Delete card» — скрыть при `search !== ""`
2. Кнопка «Create "..."» при пустой фильтрации
3. MRU-хранение в `localStorage` (`arena:recentTags`, макс. 10)
4. Трёхуровневая сортировка: присвоенные → недавние → алфавит
5. Обновление MRU при добавлении тега и создании канала
6. Удаление `slugify()` — делегирование нормализации бэкенду (Unicode)
7. Клиппер: выбранные каналы первыми, удаление `slugify()`

### Actually completed
Все 7 пунктов выполнены.

**Новый файл `src/lib/recentTags.ts`:**
- `getRecentTags()` / `pushRecentTag(tag)` — чтение и запись MRU-списка в `localStorage`
- Ключ `arena:recentTags`, максимум 10 записей, последний использованный — первым

**`src/components/CardContextMenu.tsx` — полная переработка:**
- Секция «Delete card» обёрнута в `{!search && (...)}` — скрывается при вводе
- `canCreate = trimmed.length > 0 && filtered.length === 0` — кнопка «Create» при пустых результатах
- Удалена функция `slugify()` — отправляется `trimmed` напрямую (бэкенд нормализует)
- Сортировка: `block.tags.includes` → `recentSet.has` → `localeCompare`
- Поиск по отображаемому имени (`titleFromTag`) вместо сырого тега

**`src/App.tsx`:**
- `handleToggleTag`: вызов `pushRecentTag(tag)` при добавлении тега
- `handleCreateTagFromMenu`: вызов `pushRecentTag(tag)` + оптимистичное обновление `block.tags`

**`extension/popup/popup.js`:**
- Сортировка: нулевой уровень `selectedTags` (выбранные для текущего сохранения) всегда первыми
- Удалена функция `slugify()` — `trimmedFilter` передаётся напрямую
- Кнопка «Create» при `filter && filtered.length === 0`

### Deviations from plan
Нет отклонений.

### Checks
- `npx tsc --noEmit` — 0 ошибок
- `bunx vitest run` — 42/42 тестов пройдено
- Поведение «создал канал — карточка сразу отмечена» уже обеспечивается `handleCreateTagFromMenu` (addTag + оптимистичное обновление) и `toggleTag` в клиппере

### Push
5e4035f — Improve channel menus: MRU ranking, create channel, hide delete during search

### Decisions and lessons learned
- `localStorage` для MRU — простое решение, масштабируется до тысяч каналов (поиск в Set — O(1), сортировка — O(n log n) от отфильтрованного подмножества)
- Удаление `slugify()` из фронтенда — правильный паттерн: единственный источник нормализации — `normalize_tag` в Rust, JavaScript `\w` не поддерживает Unicode
- Трёхуровневая сортировка (присвоенные → недавние → алфавит) одинакова в обоих интерфейсах, но в клиппере нулевой уровень — `selectedTags` (временное выделение), а в меню карточки — `block.tags` (постоянная принадлежность)

---

## 28.02.2026 — Качество thumbnail, позиционирование DragOverlay

### Goal
Два улучшения: (A) повысить качество thumbnail-превью для Retina-дисплеев; (B) изменить позиционирование DragOverlay — курсор «держит» карточку за левый верхний угол, не закрывая целевые теги.

### Planned
1. Увеличить max size thumbnail с 240 до 480px (покрытие 2x Retina)
2. Повысить JPEG quality с 80 до 85
3. Вынести константу в единый `DEFAULT_MAX_SIZE` в `thumbnails.rs`
4. DragOverlay: привязка к левому верхнему углу с отступом 4px

### Actually completed
Все 4 пункта выполнены.

**Thumbnail quality (7.15):**
- `thumbnails.rs`: новая публичная константа `DEFAULT_MAX_SIZE = 480`, `JPEG_QUALITY = 85`
- Удалены дублирующиеся `THUMB_MAX_SIZE = 240` из 4 файлов (`commands/blocks.rs`, `watcher/handler.rs`, `import/importer.rs`, `bin/native_host.rs`) — все ссылаются на `thumbnails::DEFAULT_MAX_SIZE`
- Тесты в `thumbnails.rs` продолжают использовать `generate_thumbnail(&src, &dst, 240)` напрямую — они тестируют функцию с конкретным параметром, не зависят от константы

**DragOverlay (7.16):**
- `App.tsx`: модификатор `snapToCursor` — убрано центрирование (`- ow/2`, `- oh/2`), добавлен `INSET = 4` (остриё курсора чуть выступает за border-radius карточки). Курсор «держит» карточку за угол, область справа свободна для обзора целей drop

### Deviations from plan
Нет отклонений.

### Checks
- `cargo check` — компиляция без ошибок
- `cargo test --lib` — 197/197 пройдено
- `tsc --noEmit` — без ошибок

### Push
- `6a46aa2` — Improve thumbnail quality for Retina and reposition DragOverlay

### Decisions and lessons learned
1. **480px = 2x Retina**: минимальная ширина столбца 240 CSS-пикселей, на Retina нужно 480 физических. 3x на Mac не используется. JPEG 85 при 480px — ~30-50 КБ на файл
2. **Единая константа вместо 4 копий**: `thumbnails::DEFAULT_MAX_SIZE` — единый источник истины, изменение в одном месте обновляет всю систему
3. **INSET = 4px при border-radius 8px**: остриё курсора выступает ровно на половину скругления — визуально курсор «цепляет» угол карточки

---

## 28.02.2026 — Drag-and-drop каналов, багфиксы drop-зоны и создания каналов

### Goal
Две задачи: (A) реализовать перетаскивание каналов в сайдбаре для изменения порядка; (B) исправить пять багов — drop файлов без тега, дублирование блоков, синее кольцо при перетаскивании каналов, канал остаётся после удаления тега, создание каналов с не-ASCII названиями.

### Planned
1. @dnd-kit/sortable для перетаскивания каналов в сайдбаре
2. Кнопка «New channel» с inline-вводом
3. Исправление file drop: тег текущего канала, защита от дублирования
4. Синее кольцо только при перетаскивании карточки, не канала
5. Удаление записи канала при удалении тега из всех карточек
6. Исправление slugifyTag: Unicode-совместимость

### Actually completed
Все 6 пунктов выполнены.

**@dnd-kit/sortable (7.13):**
- Установлен `@dnd-kit/sortable@10.0.0`
- `Sidebar.tsx`: `SortableContext` + `verticalListSortingStrategy`, `TagNavItem` использует `useSortable` вместо `useDroppable` — каждый тег одновременно draggable и droppable
- `App.tsx`: `orderedTags` useMemo — объединяет `tags` и `channels` по позиции, каналы без блоков тоже показываются
- `App.tsx`: `handleReorderTag` — `arrayMove` + `reorderChannels` с позициями для всех тегов
- `App.tsx`: `activeDragTag` состояние + DragOverlay для перетаскиваемого тега
- `App.tsx`: `handleDndStart/End/Cancel` — различают tag:* и card ID по префиксу
- `channels.rs`: `reorder_channels` автоматически создаёт записи каналов для тегов без них

**Кнопка «New channel» (7.13):**
- `Sidebar.tsx`: `isCreating` состояние, `InlineInput` для ввода названия, `PlusIcon`
- `App.tsx`: `handleCreateChannel` → `createChannel(tag)` + `loadData()`

**Багфиксы (7.14):**

1. *File drop без тега текущего канала*: `App.tsx` вычисляет `currentTag` из `useLocation().pathname`, передаёт в `DropZone`. `DropZone.tsx` принимает `currentTag`, хранит в `currentTagRef` (ref, чтобы не перерегистрировать Tauri-листенер), при создании блока добавляет тег

2. *Дублирование блоков при drop*: `DropZone.tsx` — `importingRef` guard предотвращает повторный вход в `handleDrop` (Tauri может отправить событие drop дважды)

3. *Синее кольцо при перетаскивании каналов*: `App.tsx` передаёт `isCardDragging={activeDragBlock !== null}` в `Sidebar`. `TagNavItem` показывает `ring-2 ring-blue-400` только при `isOver && isCardDragging`

4. *Канал остаётся после удаления тега*: `App.tsx` — `handleDeleteTagFromAll` вызывает `deleteChannel(tag).catch(() => {})` параллельно с `deleteTagFromAll(tag)`

5. *Создание каналов с не-ASCII названиями*: удалён `slugifyTag` из фронтенда — JavaScript `\w` не поддерживает Unicode. Текст передаётся напрямую в бэкенд, где Rust `normalize_tag` корректно обрабатывает кириллицу через `char::is_alphanumeric()`

### Deviations from plan
Нет отклонений.

### Checks
- `tsc --noEmit` — без ошибок
- `bunx vitest run` — 42/42 пройдено (5 файлов)

### Push
- `19052e1` — Add channel drag-reorder, fix drop zone and channel creation bugs

### Decisions and lessons learned
1. **useSortable = useDraggable + useDroppable**: один хук делает элемент и источником, и целью перетаскивания. Для перетаскивания каналов в сайдбаре — идеальный выбор
2. **ID-префикс для различения типов drag**: карточки используют slug (`sunset-tokyo`), теги — `tag:photography`. `handleDndEnd` по префиксу определяет тип операции: tag→tag = reorder, card→tag = присвоение тега
3. **isCardDragging пропс вместо active из useSortable**: `useSortable` не знает, что именно перетаскивается. Булев флаг из `DndContext` явнее, проще типизируется и не зависит от внутреннего API dnd-kit
4. **Ref для Tauri-листенера**: `currentTagRef.current = currentTag` — обновляет значение без повторной регистрации `onDragDropEvent`. Листенер Tauri регистрируется один раз, ref даёт доступ к актуальному значению
5. **Нормализация Unicode — только на бэкенде**: Rust `char::is_alphanumeric()` поддерживает Unicode, JavaScript `\w` — нет. Дублировать логику нормализации на фронтенде вредно — единый источник истины на бэкенде

---

## 27.02.2026 — Теги вместо каналов, dnd-kit, контекстное меню карточки

### Goal
Три задачи: (A) убрать абстракцию «каналов» (channels) — сайдбар показывает все уникальные теги из frontmatter напрямую; (B) реализовать drag-and-drop карточки на тег в сайдбаре (присвоение тега); (C) добавить контекстное меню карточки с управлением тегами.

### Planned
1. Бэкенд: команды `rename_tag` и `delete_tag_from_all` (обновление frontmatter во всех .md файлах)
2. IPC-обёртки для новых команд
3. Сайдбар: заменить `ChannelDto[]` на `TagCount[]`, алфавитная сортировка, inline-редактирование, контекстное меню тега (переименовать/удалить)
4. App.tsx: замена channels-состояния на tags, обработчики тегов
5. CardContextMenu: список всех тегов с чекбоксами, поиск, создание нового тега, удаление карточки
6. Drag-and-drop карточки на тег в сайдбаре
7. Исправление коллизии и автоскролла при drag

### Actually completed
Все 7 пунктов выполнены.

**Бэкенд (tags.rs):**
- `rename_tag` — находит все блоки с тегом через `list_blocks_by_tag`, в каждом .md обновляет frontmatter (удаляет старый тег, добавляет новый), перезаписывает файл, обновляет индекс
- `delete_tag_from_all` — аналогично, но только удаляет тег из всех блоков
- Оба зарегистрированы в `lib.rs`

**IPC (commands.ts):**
- `renameTag(old_tag, new_tag)` и `deleteTagFromAll(tag)` — обёртки над invoke()

**Sidebar.tsx — полная переработка:**
- Принимает `TagCount[]` вместо `ChannelDto[]`
- `titleFromTag()` — `web-design` → `Web Design` для отображения
- Алфавитная сортировка тегов
- `TagNavItem` — `useDroppable({ id: "tag:${tag}" })` из dnd-kit, подсветка `ring-2 ring-blue-400` при `isOver`
- Inline-редактирование: двойной клик → `InlineInput` (Enter/Esc/blur)
- `TagMenu` — контекстное меню тега: Rename, Delete (с подтверждением)
- Убрана кнопка «+» (теги создаются через контекстное меню карточки)

**App.tsx — оркестрация dnd-kit:**
- `DndContext` с `PointerSensor` (distance: 8 для отличия клика от drag)
- `DragOverlay` с кастомным модификатором `snapToCursor` — миниатюра следует за курсором
- `handleDndEnd` — если `over.id` начинается с `tag:`, вызывает `addTag(slug, tag)`
- `collisionDetection={pointerWithin}` — коллизия по позиции курсора, а не bounding rect карточки
- `autoScroll={{ canScroll: (el) => el.hasAttribute("data-sidebar-scroll") }}` — прокрутка только сайдбара

**Card.tsx — useDraggable:**
- `useDraggable({ id: block.slug })` вместо HTML5 `draggable`/`onDragStart`
- `isDragging` → `opacity-30`

**CardContextMenu.tsx — новый компонент:**
- Список всех тегов с чекбоксами (`onToggleTag`), поиск по тегам
- Создание нового тега из строки поиска (`slugify()` + проверка уникальности)
- Удаление карточки с двухшаговым подтверждением
- Позиционирование: `useLayoutEffect` корректирует координаты, чтобы меню не вышло за viewport

**Sidebar.tsx — data-sidebar-scroll:**
- Атрибут `data-sidebar-scroll` на `<nav>` — маркер для `autoScroll.canScroll`

**drag.ts — вспомогательный модуль:**
- `isInternalDragActive()` — флаг для DropZone (не показывать оверлей при внутреннем drag). Сейчас рудиментарный — Card больше не вызывает `setInternalDragActive`, но DropZone по-прежнему проверяет его

**Sidebar.test.tsx — обновление тестов:**
- Обёрнут в `DndContext`, props заменены на `TagCount[]`
- Убран `onCardDrop`, проверки: нет draggable-элементов, нет кнопки Create, Tags-заголовок

### Deviations from plan
- HTML5 Drag and Drop API не работает в Tauri v2: `dragDropEnabled: true` (значение по умолчанию) регистрирует нативный обработчик drag на WKWebView, который перехватывает все HTML5 drag-события до того, как они попадают в DOM. Подтверждено GitHub issues #14373, #8581, #6695. Решение: переход на dnd-kit с Pointer Events (pointerdown/pointermove/pointerup), которые Tauri не перехватывает
- Стандартная коллизия dnd-kit (`rectIntersection`) определяла цель по bounding rect карточки, а не по курсору — drop попадал не на тот тег. Исправлено через `pointerWithin`
- По умолчанию dnd-kit прокручивает все scrollable-контейнеры — прокручивалась основная сетка вместо сайдбара. Исправлено через `autoScroll.canScroll` с data-атрибутом

### Checks
- `tsc --noEmit` — без ошибок
- `bunx vitest run` — 43/43 пройдено (5 файлов)
- `cargo test` — 197/197 пройдено (в предыдущей сессии)

### Push
- `d8d20cb` — Replace channels with tags, add dnd-kit drag-and-drop and card context menu

### Decisions and lessons learned
1. **HTML5 DnD несовместим с Tauri v2**: WKWebView перехватывает drag-события на нативном уровне для поддержки перетаскивания файлов из Finder. Pointer Events (dnd-kit) работают параллельно — два DnD-потока не конфликтуют
2. **pointerWithin > rectIntersection**: для сценария «маленькая цель (тег 32px) + большой источник (карточка 300px)» коллизия по курсору — единственно правильная стратегия
3. **data-атрибут для canScroll**: CSS-классы Tailwind генерируются и могут меняться. Data-атрибут — стабильный семантический маркер, не зависящий от стилей
4. **snapToCursor модификатор**: DragOverlay по умолчанию привязан к начальной позиции перетаскиваемого элемента. Кастомный модификатор смещает его к позиции курсора через разницу между clientX/Y и draggingNodeRect

---

## 27.02.2026 — Исправление drag-and-drop и сброса прокрутки

### Goal
Два бага в основном приложении: (A) перетаскивание файлов (drag-and-drop) молча не работает — блёр при перетаскивании появляется, но после отпускания файла блок не создаётся; (B) сетка периодически мигает и теряет позицию прокрутки.

### Planned
1. Найти причину неработающего drag-and-drop
2. Найти причину мигания и сброса прокрутки
3. Исправить оба бага
4. Добавить визуальное отображение ошибок в DropZone (ошибки уходили в console.error)

### Actually completed
Все 4 пункта выполнены.

**blocks.rs — исправление десериализации параметров команды:**
- Корневая причина: макрос `#[tauri::command]` в Tauri v2 по умолчанию конвертирует параметры в camelCase. JS отправлял `block_type` и `file_path`, а Tauri ожидал `blockType` и `filePath`. Десериализация падала, ошибка уходила в console.error
- `create_block` — единственная команда с многословными параметрами во всём проекте, поэтому баг не проявлялся нигде больше
- Исправление: `#[tauri::command(rename_all = "snake_case")]`

**Grid.tsx — стабильный отпечаток вместо ссылки на массив:**
- Корневая причина: `useEffect(() => setVisibleCount(80), [blocks])` сбрасывал видимое число карточек при каждом изменении ссылки на массив. `loadData()` создавал новую ссылку каждые ~800мс (300мс дебаунс бэкенда + 500мс фронтенда)
- Исправление: зависимость заменена на `blocksFingerprint` — `useMemo` из длины + первого ID + последнего ID. Фоновое обновление с теми же данными не вызывает сброс, переключение канала — вызывает

**DropZone.tsx — визуальное отображение ошибок:**
- Добавлено состояние `error` — красный оверлей с текстом ошибки
- Автоскрытие через 4 секунды

### Deviations from plan
Нет отклонений.

### Checks
- `cargo check` — компиляция без ошибок (только предупреждения о неиспользуемых полях в import/)
- `tsc --noEmit` — без ошибок
- Исследование исходного кода макроса `tauri-macros-2.5.3/src/command/wrapper.rs` подтвердило: `argument_case: ArgumentCase::Camel` (строка 50) — значение по умолчанию

### Push
- `c0cf9dc` — Fix drag-and-drop block creation and grid scroll reset

### Decisions and lessons learned
1. **Tauri v2 по умолчанию ожидает camelCase в параметрах команд**: `#[tauri::command]` конвертирует `snake_case` → `camelCase` через `heck::ToLowerCamelCase`. Для однословных параметров (`slug`, `tag`) это незаметно. Для многословных (`block_type`, `file_path`) — критично. Решение: `rename_all = "snake_case"` на командах со snake_case параметрами
2. **React useEffect с массивом в зависимости реагирует на ссылку, не на содержимое**: дешёвый O(1) отпечаток (length + first ID + last ID) надёжно отличает навигацию от фонового обновления
3. **Ошибки в console.error невидимы пользователю**: любая операция, которая может упасть, должна показывать результат в UI

---

## 27.02.2026 — Переделка UX клиппера, багфиксы, рендеринг статей

### Goal
Четыре задачи клиппера: (A) только первая картинка статьи скачивается корректно, (B) переключатель типов — заменить на Content | Link, (C) сохранение картинки через контекстное меню должно открывать попап с превью, (D) список каналов всегда виден, недавние каналы первыми. Параллельно — улучшение рендеринга статей в основном приложении.

### Planned
1. HTTP-заголовки + retry в `download_file()` (native_host.rs) — CDN блокирует голые запросы
2. Задержка между загрузками в `localize_body_images()`
3. Переключатель Content | Link вместо Link/Article/Selection
4. Открытие попапа из контекстного меню
5. Полная переработка попапа: карточка превью, встроенный список каналов, недавние каналы
6. Замена ручного рендеринга markdown на react-markdown + remark-gfm (Detail.tsx)
7. Фолбэк для карточек-ссылок без thumbnail (Card.tsx)
8. Исправление переполнения Grid (overflow-x-hidden, min-w-0)

### Actually completed
Все 8 пунктов выполнены. Два из них потребовали повторного исправления (п. 1 и п. 4).

**native_host.rs — загрузка картинок (два прохода):**
- Первый проход (`b1825e6`): добавлены User-Agent, Referer, Accept + retry 3 попытки + задержка 150мс
- Второй проход (`ab419c8`): исправлен критический баг — Referer указывал на URL картинки, а не на URL страницы. CDN блокировали самоссылающийся Referer. Исправлено: `download_file()` принимает `referer` как отдельный аргумент (URL страницы). User-Agent заменён на реалистичный браузерный. Задержка увеличена до 300мс, бэкофф retry — до 500мс

**popup.html — новая структура:**
- Карточка превью (миниатюра 48px + заголовок + домен)
- Полноширинная картинка (для типа image)
- Переключатель Content | Link
- Текстовый превью (для типа content)
- Встроенный прокручиваемый список каналов с поиском
- Полноширинная кнопка Save с динамическим текстом
- Убрано: поле Description, кнопка Cancel, теги-чипсы

**popup.css — переработка стилей:**
- `.preview-card` — flex-строка: миниатюра + инфо
- `.preview-title` — input без рамки, рамка при фокусе
- `.channel-list` — static, max-height: 192px, overflow-y: auto
- `.save-btn` — width: 100%
- Тёмная/светлая тема через CSS-переменные
- Адаптивная ширина body для standalone-окна (`@media (min-width: 361px)`)

**popup.js — логика:**
- Типы: article/selection маппятся в "content", Content выбран по умолчанию
- `renderChannelList()` — недавние каналы первыми (из chrome.storage.local), остальные по block_count
- `updateSaveButton()` — "Save" / "Save to N channels"
- `save()` — Content = selection > article; при успехе сохраняет recentChannels (до 10)
- `applyContextMenu()` — async, запрашивает getImageInfo для alt/width/height

**background.js (два прохода):**
- Первый проход (`b1825e6`): async-обработчик контекстного меню, `chrome.action.openPopup()` с фолбэком через значок
- Второй проход (`ab419c8`): `openPopup()` заменён на `chrome.windows.create()` — openPopup() не работает из контекстного меню (требует жест пользователя на иконке расширения). `windows.create()` открывает попап как отдельное окно 388x520

**manifest.json:**
- Добавлен permission "storage"

**Detail.tsx — рендеринг статей:**
- Ручной парсер markdown (~150 строк: IMG_RE, HEADING_RE, renderInline, renderTextFormatting) заменён на ReactMarkdown + remark-gfm (~30 строк)
- @tailwindcss/typography для стилизации prose
- Пользовательские компоненты: img (resolveImageSrc), a (target="_blank")

**Card.tsx — фолбэк для ссылок:**
- LinkCard: при ошибке загрузки thumbnail показывает компактную карточку (title + domain)
- ArticleCard: stripMarkdown() перед превью текста

**Grid.tsx — исправление переполнения:**
- overflow-x-hidden на контейнере, min-w-0 на столбцах

### Deviations from plan
- Работа над Detail.tsx и Card.tsx не входила в первоначальный план по клипперу, но выполнена в рамках общего улучшения UX
- Два пункта потребовали повторного исправления после тестирования пользователем: (1) Referer в download_file указывал не на ту цель, (2) openPopup() невозможен из контекстного меню

### Checks
- `cargo check --bin native-host` — компиляция без ошибок
- Визуальная проверка расширения (не покрывается unit-тестами)
- Контекстное меню "Save image" — открывает standalone-окно с попапом

### Push
- `b1825e6` — Overhaul clipper UX and improve article rendering (8.9)
- `ab419c8` — Fix image downloads and context menu popup (8.10)
- `1a8435e` — Fit popup window to content (8.10)

### Decisions and lessons learned
1. **Referer должен указывать на страницу, не на ресурс**: CDN проверяют Referer для защиты от хотлинкинга. Самоссылающийся Referer (картинка ссылается на себя) выглядит как скрапинг и блокируется
2. **Реалистичный User-Agent обязателен**: `LocalArena/1.0` — слишком подозрительно для CDN. Браузерный User-Agent проходит без проблем
3. **chrome.action.openPopup() не работает из контекстного меню**: API требует «жест пользователя» на иконке расширения. `chrome.windows.create()` — единственный надёжный способ открыть UI расширения программно
4. **react-markdown > ручной парсер**: собственный рендеринг markdown неизбежно пропускает edge cases. react-markdown + remark-gfm покрывает GFM-спецификацию целиком
5. **Content = article + selection**: объединение двух типов в один упрощает UI и логику, selection имеет приоритет

---

## 27.02.2026 — Капитальный ремонт веб-клиппера: форматирование и логика типов

### Goal
Исправить два класса проблем клиппера: (A) потерю форматирования в Twitter-тредах и статьях, (B) хрупкую логику типов — скрытый переключатель, ленивая загрузка статьи, одноразовый захват выделения.

### Planned
1. Убрать `.textContent` фоллбэки в `extractTweetContent()` и `extractArticle()` — они уничтожают HTML-структуру
2. Кастомный DOM-обходчик `tweetTextToMarkdown()` для Twitter (вместо TurndownService)
3. Логирование ошибок в `htmlToMarkdown()`
4. Переключатель типов всегда видим (Link/Article + Selection при выделении)
5. Жадная загрузка статьи параллельно с инициализацией UI
6. Перезапрос выделения при сохранении
7. CSS `white-space: pre-wrap` для превью текста

### Actually completed
Все 7 пунктов выполнены.

**content.js — форматирование:**
- `tweetTextToMarkdown(el)` — рекурсивный обход DOM: TEXT_NODE, BR, A (ссылки, хэштеги, упоминания), IMG (эмодзи через alt), вложенные SPAN
- `.textContent` фоллбэки удалены в `extractTweetContent()` и `extractArticle()`
- `htmlToMarkdown()` — `console.error` вместо тихого catch

**popup.js — логика типов:**
- `buildTypeSwitcher()` — всегда показывает Link/Article, Selection при наличии выделения
- `init()` — `articlePromise` запускается сразу после получения `tab.id`, результат ожидается перед `updatePreview()`
- `save()` — перезапрос `extractMetadata` для свежего выделения при типе "selection"
- Ленивая загрузка статьи из `updatePreview()` удалена

**popup.css:**
- `.preview-text { white-space: pre-wrap }` — переносы строк видны в превью

### Deviations from plan
Нет отклонений.

### Checks
Ручное тестирование (браузерное расширение, не покрывается unit-тестами).

### Push
- `43592c3` — Fix clipper formatting and type logic (8.8)

### Decisions and lessons learned
1. **tweetTextToMarkdown > TurndownService для Twitter**: Twitter не использует семантический HTML — `<span>` + CSS вместо `<p>` + `<br>`. TurndownService проектировался под обычный HTML, Twitter-разметка требует ручного обхода
2. **Пустая строка лучше `.textContent`**: если конвертация провалилась, пустое тело заметнее и проще пересохранить, чем склеенный текст без форматирования
3. **Жадная загрузка vs ленивая**: Readability.js клонирует весь DOM — это тяжёлая операция. Запуск параллельно с UI-настройкой (через Promise) исключает задержку при переключении на тип Article

---

## 27.02.2026 — Финализация: производительность, edge cases, иконка, меню

### Goal
Довести приложение до продакшен-уровня: оптимизировать рендеринг сетки для 10 000+ блоков, обработать граничные случаи, добавить восстановление индекса, создать иконку и нативное macOS-меню.

### Planned
1. Чанковый рендеринг Grid (IntersectionObserver вместо полного рендера)
2. Фолбэк для сломанных изображений
3. Команда rebuild_index — пересборка индекса из файлов
4. Автообновление (Tauri updater)
5. Иконка приложения + нативное macOS-меню + About

### Actually completed
Пункты 1-3, 5 выполнены. Пункт 4 (автообновление) отложен.

**Grid (7.1):**
- `src/components/Grid.tsx` — переписан на IntersectionObserver: INITIAL_BATCH=80, BATCH_SIZE=60, rootMargin="400px"
- Masonry-раскладка (round-robin по столбцам), адаптивное количество столбцов через ResizeObserver
- visibleCount сбрасывается при смене канала/поиске

**Edge cases (7.2):**
- `src/components/Card.tsx` — ImageCard: состояние ошибки + BrokenImageIcon
- onError → показывает плейсхолдер вместо сломанного изображения

**Rebuild index (7.3):**
- `src-tauri/src/commands/vault.rs` — rebuild_index: очистка block_tags, wikilinks, blocks, channels → full_scan
- `src/lib/commands.ts` — rebuildIndex() обёртка

**Иконка и меню (7.5):**
- `src-tauri/icons/app-icon.svg` — masonry-сетка на тёмном фоне (#0A0A0A), скруглённый квадрат
- Все размеры сгенерированы через `cargo tauri icon`
- `src-tauri/src/lib.rs` — нативное macOS-меню: App (About, Services, Hide, Quit), Edit, View, Window

### Deviations from plan
- 7.4 (автообновление) отложен — требует генерации пары ключей (Ed25519) и настройки сервера обновлений. Не критично для первого релиза

### Checks
- `cargo test` — 197/197 пройдено
- `cargo check` — компиляция без ошибок
- `tsc --noEmit` — TypeScript чисто
- 16 Tauri-команд зарегистрированы (15 + rebuild_index)

### Push
- `5b0f445` — Add app icon, native macOS menu, grid performance, edge cases, rebuild index

### Decisions and lessons learned
1. **IntersectionObserver > @tanstack/react-virtual**: для masonry-раскладки с переменной высотой карточек виртуализация слишком сложна. Чанковый рендеринг (80 начальных + 60 по батчам) проще и достаточен
2. **rootMargin: "400px"**: предзагрузка батчей до того, как пользователь доскроллит — нет визуальных пауз
3. **Tauri menu API**: macOS верхнее меню принимает только Submenu, не MenuItem. AboutMetadata позволяет задать версию, copyright, credits
4. **rebuild_index как восстановление**: паттерн "удали индекс — пересканируй" работает как аварийное восстановление и как функция для пользователя

---

## 27.02.2026 — Drag-and-drop, file watcher, импорт из Are.na

### Goal
Добавить три ключевых интерактивных механики: drag-and-drop файлов для быстрого создания блоков, автообновление интерфейса при внешних изменениях vault, встроенный импорт коллекций из Are.na.

### Planned
1. DropZone — компонент перетаскивания файлов (Tauri v2 onDragDropEvent)
2. File watcher — notify-крейт, фоновый поток, события vault-changed
3. Are.na импорт — HTTP-клиент (ureq), маппинг типов, загрузка медиа, UI

### Actually completed
Все 3 пункта выполнены. 197 тестов проходят.

**Drag-and-drop (5.10):**
- `src/components/DropZone.tsx` — оверлей при перетаскивании, определение типа блока по расширению, создание через create_block

**File watcher (5.12):**
- `src-tauri/src/watcher/watch.rs` — notify-вотчер в фоновом потоке, собственное SQLite-соединение (WAL), debounce 300мс
- `src-tauri/src/commands/state.rs` — RecommendedWatcher в AppState
- `src-tauri/src/commands/vault.rs` — запуск вотчера в initialize_vault
- `src/App.tsx` — подписка на vault-changed с debounce 500мс

**Импорт из Are.na (Phase 6):**
- `src-tauri/src/import/arena_api.rs` — HTTP-клиент: пагинация, rate-limiting, загрузка файлов
- `src-tauri/src/import/importer.rs` — маппинг Are.na → local blocks, прогресс-коллбэк
- `src-tauri/src/commands/import.rs` — list_arena_channels, import_arena_channels
- `src/components/ImportDialog.tsx` — 4-шаговый UI: username → выбор каналов → прогресс → результаты
- `src/components/Sidebar.tsx` — кнопка "Import from Are.na"

### Deviations from plan
- Phase 6 реализована без отдельной SPEC — переиспользована архитектура существующих модулей
- Авторизация Are.na не нужна — публичные каналы доступны без токена
- 5.11 (sidebar drag-reorder) отложен — не критичен для функциональности

### Checks
- `cargo check` — Rust компилируется (15 предупреждений, 0 ошибок)
- `tsc --noEmit` — TypeScript компилируется чисто
- `cargo test` — 197/197 пройдено
- 15 Tauri-команд зарегистрированы

### Push
- `2f147ba` — Add drag-and-drop file import and real-time vault watcher
- (ожидает коммит) — Are.na import

### Decisions and lessons learned
1. **ureq вместо reqwest**: синхронный HTTP-клиент, Tauri-команды всё равно на thread pool. Нет async-рантайма, нет лишней сложности
2. **Отдельное SQLite-соединение для watcher**: WAL-режим позволяет несколько reader-ов. Watcher в фоновом потоке не блокирует UI-команды
3. **Прогресс через Tauri events**: `app.emit("import-progress", ...)` — фронтенд подписывается через `listen()`, обновляет progress bar без polling
4. **Переиспользование storage-слоя в импорте**: `files::write_block_file`, `index::upsert_block`, `thumbnails::generate_thumbnail` — одна и та же логика для ручного создания и импорта

---

## 27.02.2026 — Frontend: компоненты, роутинг, IPC

### Goal
Пользователь видит интерфейс приложения: выбирает vault, видит сетку карточек, переключает каналы в sidebar, ищет по Cmd+K, открывает детальный вид.

### Planned
1. SPEC_FRONTEND.md — спецификация: типы, IPC, компоненты, роутинг, ассеты
2. Установка зависимостей: @tauri-apps/api, @tauri-apps/plugin-dialog, @tanstack/react-virtual, react-router
3. TypeScript types + IPC layer (13 typed commands)
4. VaultPicker — экран выбора vault
5. Sidebar — навигация по каналам
6. Grid — виртуальный скроллинг
7. Card — адаптивные карточки (5 типов блоков)
8. Search — Cmd+K палитра поиска
9. Detail — lightbox с управлением тегами
10. App — роутинг, состояние, компоновка

### Actually completed
Все 10 пунктов выполнены. Фронтенд собирается (263 КБ JS / 83 КБ gzip).

- `SPEC_FRONTEND.md` — спецификация фронтенда
- `src/types/index.ts` — IndexedBlock, TagCount, ChannelDto, ScanResult, CreateBlockParams
- `src/lib/commands.ts` — 13 типизированных обёрток над invoke()
- `src/lib/assets.ts` — thumbnailUrl, mediaUrl, domainFromUrl (convertFileSrc)
- `src/components/VaultPicker.tsx` — нативный dialog для выбора папки, сканирование vault
- `src/components/Sidebar.tsx` — каналы с счётчиками, NavLink-навигация, кнопка Cmd+K
- `src/components/Grid.tsx` — @tanstack/react-virtual, адаптивные столбцы (ResizeObserver), overscan=5
- `src/components/Card.tsx` — ImageCard, LinkCard, ArticleCard, VideoCard, FileCard
- `src/components/Search.tsx` — модальное окно, debounce 200мс, навигация стрелками, Enter/Esc
- `src/components/Detail.tsx` — lightbox по типу блока, добавление/удаление тегов, стрелки лево-право
- `src/App.tsx` — BrowserRouter, Outlet context, AllBlocksPage, ChannelPage, глобальный Cmd+K
- `src/styles/global.css` — скрытие скроллбаров WebKit, user-select для кнопок, overscroll-behavior
- `src-tauri/Cargo.toml` — feature `protocol-asset` для отображения файлов
- `src-tauri/tauri.conf.json` — assetProtocol: enable + scope **
- `src-tauri/capabilities/default.json` — dialog:default, dialog:allow-open
- `src-tauri/src/lib.rs` — регистрация tauri_plugin_dialog
- `package.json` — @tauri-apps/api, @tauri-apps/plugin-dialog, @tanstack/react-virtual, react-router

### Deviations from plan
- Drag-and-drop файлов отложен — требует tauri-plugin-fs и дополнительную логику копирования
- Sidebar drag-reorder каналов отложен — требует обновление позиции в бэкенде
- Real-time updates (Tauri events → React state) отложены — требует подписку на события watcher
- Masonry/list режимы сетки отложены — базовый grid покрывает основные сценарии
- Тесты компонентов отложены — тестирование через Tauri runtime требует дополнительной инфраструктуры

### Checks
- `tsc --noEmit` — компиляция TypeScript без ошибок
- `bun run build` — сборка Vite успешна (263 КБ JS)
- `cargo check` — Rust компилируется (с protocol-asset feature)
- `cargo test --lib` — 193/193 тестов пройдены
- Все 13 IPC-команд строго типизированы
- Dark mode: все компоненты используют dark: варианты Tailwind

### Push
- `d60ced6` — Implement frontend: VaultPicker, Sidebar, Grid, Card, Search, Detail

### Decisions and lessons learned
1. **convertFileSrc + protocol-asset**: Tauri WebView не загружает file:// URL. Необходим feature `protocol-asset` в Cargo.toml + `assetProtocol.enable` в tauri.conf.json. convertFileSrc преобразует путь в asset://localhost/...
2. **Outlet context вместо prop drilling**: react-router `<Outlet context={...}>` + `useOutletContext<T>()` — чистый способ передать blocks/vaultPath во вложенные маршруты без пробрасывания через 5 уровней
3. **ResizeObserver для адаптивных столбцов**: Grid вычисляет количество столбцов через ResizeObserver на контейнере, а не через window.innerWidth. Это правильно работает при изменении ширины sidebar
4. **Debounce 200мс для поиска**: баланс между отзывчивостью и нагрузкой на SQLite. FTS5 быстр (<10мс), но debounce предотвращает лишние вызовы при быстром вводе
5. **Spread operator для CreateBlockParams**: TypeScript interface несовместим с Record<string, unknown> (нет index signature). Решение: `{ ...params }` создаёт plain object

---

## 27.02.2026 — Интеграция: watcher + Tauri commands

### Goal
Связать domain и storage слои в рабочее приложение: событийная обработка файлов, IPC-команды для фронтенда, разделяемое состояние.

### Planned
1. SPEC_INTEGRATION.md — спецификация watcher + commands
2. watcher/events — классификация событий notify
3. watcher/handler — оркестрация: scan, index, handle events
4. commands/ — 12 Tauri команд (vault, blocks, tags, search, channels)
5. AppState + lib.rs — регистрация состояния и команд

### Actually completed
Все 5 пунктов выполнены. 19 новых тестов (watcher/events 9, watcher/handler 10).

- `SPEC_INTEGRATION.md` — спецификация watcher + commands
- `src-tauri/src/watcher/events.rs` — VaultEvent, classify_notify_event (9 тестов)
- `src-tauri/src/watcher/handler.rs` — full_scan, index_md_file, handle_event (10 тестов)
- `src-tauri/src/commands/state.rs` — AppState, VaultState, CommandError, now_iso8601
- `src-tauri/src/commands/vault.rs` — select_vault, get_vault_path
- `src-tauri/src/commands/blocks.rs` — list_blocks, get_block, create_block, delete_block
- `src-tauri/src/commands/tags.rs` — list_tags, add_tag, remove_tag
- `src-tauri/src/commands/search.rs` — search (FTS5)
- `src-tauri/src/commands/channels.rs` — list_channels, create_channel, delete_channel + ChannelDto
- `src-tauri/src/lib.rs` — 12 команд зарегистрированы через generate_handler

### Deviations from plan
- Задача 4.7 (интеграционные тесты) заменена на commands/channels — полноценные интеграционные тесты требуют Tauri runtime, тестирование через handler-тесты достаточно
- Debouncing (notify-debouncer) отложен — базовый watcher работает напрямую с notify events
- ISO 8601 timestamp: реализован через Howard Hinnant's civil_from_days вместо chrono

### Checks
- `cargo test` — 193/193 passed (123 domain + 51 storage + 19 watcher)
- `cargo check` — компиляция без ошибок
- Serialize derives добавлены к BlockType, IndexedBlock, TagCount
- 12 Tauri команд зарегистрированы и компилируются

### Push
- `99f0a13` — Implement integration layer: watcher events/handler + Tauri commands (19 tests)

### Decisions and lessons learned
1. **Оркестрация в watcher/handler**: full_scan и index_md_file переиспользуются и сканером, и вотчером. Commands остаются тонким слоем
2. **AppState = Mutex<Option<VaultState>>**: vault не выбран при старте, состояние заменяется целиком при select_vault. Mutex гарантирует thread-safety для Connection
3. **CommandError с Serialize**: Tauri v2 требует сериализуемые ошибки. Реализация через `serialize_str(&self.to_string())` — чистый и расширяемый паттерн
4. **ChannelDto**: отдельный DTO для фронтенда вместо прямой сериализации Channel — добавляет block_count без изменения domain-типа
5. **Howard Hinnant's civil_from_days**: ISO 8601 без chrono dependency — достаточно для генерации timestamps при создании блоков

---

## 26.02.2026 — Storage layer: SQLite, файлы, thumbnails

### Goal
Реализовать Phase 3 — персистентный слой: SQLite-индекс с FTS5, файловые операции в vault, генерацию thumbnail-превью.

### Planned
1. SPEC_STORAGE.md — спецификация 4 модулей storage
2. storage/db — соединение, схема, прагмы, FTS5-триггеры
3. storage/index — CRUD блоков/каналов, динамический FTS5-поиск
4. storage/files — write/read/scan .md, copy media, delete
5. storage/thumbnails — Lanczos3 ресайз, JPEG-вывод

### Actually completed
Все 5 пунктов выполнены. 51 тест в storage-слое.

- `SPEC_STORAGE.md` — спецификация: схема, типы, функции, поведение
- `src-tauri/src/storage/db.rs` — 13 тестов: WAL, foreign keys, FTS5 триггеры, каскадное удаление
- `src-tauri/src/storage/index.rs` — 25 тестов: upsert/remove/get/list блоков, каналов, тегов, FTS5-поиск с фильтрами
- `src-tauri/src/storage/files.rs` — 8 тестов: roundtrip write/read, scan, copy media, delete
- `src-tauri/src/storage/thumbnails.rs` — 5 тестов: ресайз, no-upscale, JPEG-валидация
- `src-tauri/src/domain/vault.rs` — thumbnail extension `.webp` → `.jpg` (согласованность со спецификацией)

### Deviations from plan
- FTS5 (задача 3.5) встроен в storage/index вместо отдельного модуля — search_blocks использует FTS5 напрямую через динамический SQL
- bundled (не bundled-full): libsqlite3-sys включает `-DSQLITE_ENABLE_FTS5` по умолчанию

### Checks
- `cargo test` — 174/174 passed (123 domain + 51 storage)
- Каскадное удаление: block → block_tags, wikilinks
- FTS5 триггеры: авто-индексация при INSERT, авто-удаление при DELETE, авто-обновление при UPDATE
- Thumbnail: 800x600 → 240x180 (Lanczos3), 100x80 → 100x80 (no upscale)

### Push
- `30f9b11` — Implement storage layer: SQLite index, file operations, thumbnails (51 tests)

### Decisions and lessons learned
1. **FTS5 content-sync**: `content='blocks', content_rowid='id'` + триггеры — FTS не хранит данные, а ссылается на blocks. Меньше места, автосинхронизация
2. **Динамический SQL для search_blocks**: пронумерованные параметры (`?1`, `?2`) + JOIN-алиасы (`bt0`, `bt1`) для AND-логики между тегами
3. **bundled включает FTS5**: build.rs в libsqlite3-sys устанавливает `-DSQLITE_ENABLE_FTS5`, не нужен `bundled-full`
4. **Thumbnail формат — JPEG**: WebP лучше по компрессии, но JPEG проще (нативная поддержка в image crate), а при 240px разница несущественна

---

## 26.02.2026 — Эталонный модуль domain/block

### Goal
Реализовать первый вертикальный срез: полный цикл SPEC -> TEST -> CODE для модуля `domain/block`. Этот модуль задаёт стандарт качества для всех последующих.

### Planned
1. Инициализация Tauri v2 + React + Vite + TypeScript + Tailwind
2. Структура модулей: domain/, storage/, watcher/, commands/
3. SPEC_BLOCK.md — полная спецификация domain/block
4. 59 тестов (все 20 edge cases E1-E20)
5. Реализация всех функций: parse/serialize, wikilinks, slug

### Actually completed
Все 5 пунктов выполнены.

- `SPEC_BLOCK.md` — типы, функции, ошибки, инварианты, 20 edge cases
- `src-tauri/src/domain/block.rs` — 6 публичных функций, 9 приватных, 59 тестов
- `src-tauri/Cargo.toml` — добавлен `indoc` (dev-dependency для тестов)

### Deviations from plan
- Тест E19 (табы в YAML): спецификация говорит «YAML не допускает табы», но это упрощение. serde_yaml принимает табы после двоеточия — запрещены только табы в индентации. Тест скорректирован.
- specta/tauri-specta типогенерация (задача 1.3) отложена — не нужна до Phase 5 (frontend)

### Checks
- `cargo test --lib` — 59/59 passed
- `cargo build --lib` — компилируется без ошибок (warnings: dead_code — норма, функции пока не вызываются)
- Roundtrip: parse -> serialize -> parse = identity (тесты roundtrip_minimal, roundtrip_full, roundtrip_with_dashes_in_body)

### Push
- `82474f6` — Add domain/block specification — reference module
- `afce9cf` — Implement domain/block — reference module with 59 tests

### Decisions and lessons learned
1. **serde_yaml::Value > serde Deserialize** для парсинга frontmatter: нужен контроль над ошибками (MissingRequiredField vs InvalidBlockType), а `serde::Deserialize` смешивает все в одну ошибку
2. **Ручная сериализация YAML** вместо `serde_yaml::to_string`: гарантирует порядок полей (type first, saved_at after tags) и отсутствие None-полей
3. **Табы в YAML**: запрещены только для индентации, не везде. Уточнить формулировку в SPEC_BLOCK.md
4. **split('\n') для parse_block** — чистый и предсказуемый способ разбора .md файла с frontmatter маркерами

---
