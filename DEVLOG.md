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
