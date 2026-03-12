# Devlog

## Rules

- Timestamp format: DD.MM.YYYY HH:MM
- New entries are always added at the top
- If a push was made — include commit hash
- Each entry must be self-contained and understandable
  without additional context by someone reading it for the first time

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
- Убран заголовок «Local Arena» — пустой спейсер `h-10` под светофор
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
