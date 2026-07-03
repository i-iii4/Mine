# Search Overlay — поиск по блокам

Related documents: [SPEC_SEARCH.md](SPEC_SEARCH.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_GRID.md](SPEC_GRID.md) | [ARCHITECTURE.md](ARCHITECTURE.md)

## Goal

Видимый поиск по блокам: модальный overlay, открываемый по `Cmd+F`, со строкой
ввода, списком результатов слева и превью-карточкой справа. Это **первый
видимый UI** для main search — backend-контракт гибридного поиска
(`list_grid_blocks(query)` + `SearchMatch`, см. [SPEC_SEARCH.md](SPEC_SEARCH.md))
переиспользуется без изменений.

Поиск по каналам (`Shift+Cmd+F`, top-chrome sidebar search) не затрагивается
вовсе.

Роль overlay — **навигация**, не фильтрация: пользователь находит карточку и
открывает её в Detail. Грид под оверлеем не меняется; закрытие оверлея
возвращает ровно ту поверхность, с которой пользователь начал.

## Отношение к SPEC_SEARCH.md

SPEC_SEARCH.md проектировал main search как «scoped filter mode» с временно
скрытым визуальным компонентом. Фактическое состояние: query негде ввести,
невидимый фильтр функционально мёртв (`setMainSearchQuery` не вызывается ни из
одного UI-элемента). Настоящий документ **заменяет** концепцию невидимого
грид-фильтра видимым overlay. При этом:

- backend read model, ranking, match metadata, card rendering — действуют как
  специфицированы в SPEC_SEARCH.md; этот документ их не дублирует, а ссылается;
- Non-Goal SPEC_SEARCH «no modal command palette» уточняется: запрет остаётся
  на **палитру команд** (исполнение действий из строки). Search overlay команд
  не исполняет — это поиск с навигацией; запрет `'/search' route` остаётся в
  силе (overlay — state-driven, маршрут не меняется);
- грид-фильтрация по query демонтируется из App: `loadGridSnapshot` больше не
  получает query, ключи кэша маршрутов снова чисто route-based.

Правки SPEC_SEARCH.md при принятии этого документа: секция Main/Grid Search
(`Cmd+F` ведёт в overlay), Keyboard Contract, Frontend Data Flow
(`mainSearchQuery` становится overlay-owned), соответствующие пункты Test
Contract. Backend-разделы не меняются.

## Non-Goals

- Никаких фильтров (по типу, автору, каналу, дате) и переключателей сортировки:
  один вход, один релевантностный порядок.
- Никакой истории запросов / «recent searches» / «recently visited».
- Никакой палитры команд: строка не исполняет действий, `>`-синтаксисов нет.
- Никакой пагинации/infinite scroll в списке: один запрос, верхние 200
  результатов. Хвост за пределами 200 недостижим — уточнение запроса честнее
  бесконечной прокрутки.
- Не трогаем sidebar channel search и collection switcher search.
- Без изменений backend: ни новых команд, ни изменений `SearchMatch`.
- Mobile/iOS — вне объёма.

## Открытие и закрытие

| Триггер | Поведение |
|---|---|
| `Cmd+F` (native menu «Find Elements» → событие `surface-search-shortcut: "main"`) | Открыть overlay; если открыт — закрыть |
| Кнопка `Search elements` (`⌘F`) в нижнем баре | То же, что `Cmd+F`; кнопка остаётся command trigger без pressed-состояния |
| `Escape` | Закрыть overlay (целиком, независимо от query) |
| Клик в backdrop | Закрыть overlay |
| `Enter` / клик по результату / клик по превью | Открыть карточку в Detail, overlay закрыть |

Состояние `{ open, query }` — App-owned. `query` живёт в течение сессии: при
повторном открытии прежний запрос показан и **выделен целиком** (select all),
поэтому новый набор начинается одним нажатием, а `Enter` повторяет прежнюю
навигацию. Между сессиями не персистится.

Overlay модален (Radix Dialog): открывается над любой поверхностью, включая
открытый Detail; выбор результата заменяет содержимое Detail. Конфликт с group
selection невозможен — модальность забирает клавиатуру целиком.

`Escape` закрывает overlay сразу — без промежуточного «сначала очистить query»:
у транзиентной модальной поверхности один уровень выхода. Очистка query —
кнопка clear (см. ниже) или выделенный текст + набор.

## Анатомия

```
┌─────────────────────────────────────────────────────────────┐
│ [input: Search elements…]                            312    ✕  │  ← header
├──────────────────────────────────────────┬──────────────────┤
│ Title of the card                        │                  │
│ …snippet with the first ▮match▮ around…  │   ReadOnlyCard   │
│ ──────────────────────────────────────   │   Preview        │
│ Another card title                       │   (активный      │
│ …another snippet…                        │    результат)    │
│ …                                        │                  │
└──────────────────────────────────────────┴──────────────────┘
```

### Поверхность

- Radix `Dialog` (существующий `src/components/ui/dialog.tsx`): портал,
  backdrop `bg-black/50` (канон Dialog/AlertDialog), без крестика Dialog
  (`showCloseButton={false}` — закрытие через Esc/backdrop, у поиска свой
  clear).
- Панель: `rounded-1 border border-border bg-popover`, тень единая для
  floating UI (`shadow-[0_4px_24px_rgba(0,0,0,0.12)]
  dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]`).
- Геометрия: ширина `min(960px, calc(100vw - 4rem))`; высота **фиксированная**
  `min(640px, 76vh)` — панель не дышит при наборе и смене числа результатов.
  Вертикально панель прижата к верхней зоне внимания: `top: 12vh` (не центр —
  строка ввода и первые результаты должны быть на уровне глаз).
- Внутренняя структура: header, затем тело из двух колонок
  (`flex`, список `flex-1 min-w-0`, превью `w-80 shrink-0 border-l
  border-border`).

### Header (строка поиска)

Канон `SearchMenuInput` («menu header», DESIGN_SYSTEM → CollectionPicker):

- контейнер `border-b border-border p-1`;
- `Input variant="ghost"` `h-8 rounded-0 px-2 text-base`, без иконки лупы
  (правило системы: search input не использует иконку), placeholder
  `Search elements…` цветом tertiary;
- `SEARCH_INPUT_SUPPRESSION_PROPS` (autoComplete/autoCorrect/autoCapitalize
  off, spellCheck false);
- фокус всегда в инпуте; автофокус при открытии; DOM-фокус из инпута не
  уходит (input-owned keyboard model);
- справа в header: счётчик текущей выдачи — количество реально показанных
  search rows (`blocks.length`, с суффиксом `+`, если backend вернул
  `has_more`), `text-sm text-tertiary-foreground`, как счётчики каналов в
  сайдбаре; отображается только при непустом query и завершённом запросе для
  текущей строки ввода. `GridSnapshot.total_blocks` не используется здесь: в
  `list_grid_blocks` это общий non-channel размер vault для `Everything`, а не
  количество совпадений поиска;
- правее счётчика clear-кнопка `✕` (`h-6 w-6 rounded-1`, hover/focus
  `bg-component-fill-hover text-foreground`, `aria-label="Clear search"`),
  видна только при непустом query; клик очищает query и возвращает фокус в
  инпут — тот же контракт, что clear в top-chrome channel search.

### Список результатов (слева)

- Контейнер: `overflow-y-auto p-1` (паддинг как у menu content).
- Строка результата (геометрия пункта меню, расширенная до двух текстовых
  строк):
  - контейнер `rounded-1 px-2 py-1.5 cursor-default`, flex `items-center
    gap-2`;
  - **миниатюра**: слот `size-8 shrink-0 overflow-hidden bg-component-fill` со
    стандартным `MicroPreviewThumbnail` — тот же компонент и паттерн, что
    related-notes reference row. Модель — `microPreviewFromLightBlock`:
    thumb по slug (пайплайн миниатюр гарантирует файл), text-миниатюры
    определяются по `preview_manifest.kind === "text"` и получают
    `dark:invert`; ошибка загрузки скрывает `img`, остаётся placeholder-слот;
  - **заголовок**: `text-base font-semibold text-foreground truncate`
    (одна строка). Текст — display title блока (display_title → fallback
    label, существующие хелперы `getDisplayTitle`/`getFallbackLabel`). При
    `search_match.field === "title"` — подсветка диапазонов через
    `renderSearchHighlightedText`;
  - **сниппет**: `text-sm text-muted-foreground line-clamp-1 mt-0.5` — одна строка, заголовок остаётся главным; строка либо двухэтажная (title + snippet), либо одноэтажная (title).
    Источник текста и подсветки — по правилам Card Rendering из
    SPEC_SEARCH.md, в точности как в карточках:
    - `field ∈ {description, body}` → `excerpt` бэкенда с `mark`-подсветкой
      диапазонов;
    - `field === "semantic"` → `excerpt` без подсветки (никаких фальшивых
      mark);
    - `field ∈ {title, author, url}` → обычный `preview_text` блока без
      подсветки (author/url объясняют ранжирование, но не отображаются);
    - сниппет отсутствует, если нечего показать (медиа-карточка без текста) —
      строка остаётся однострочной.
- `mark`: системный поисковый маркер — `bg-search-mark p-0
  text-search-mark-foreground` (DESIGN_SYSTEM → Search match mark). Это
  хроматический акцент (жёлтый текстовыделитель с фиксированными тёмными
  чернилами в обеих темах): индикатор совпадения обязан контрастировать с
  любым фоном строки, включая `bg-active` активной. Серый маркер из
  поверхностного ладдера запрещён — он неотличим от фона активной строки.
- Активная строка: `bg-active` (фон фокуса пунктов меню).
- Один источник active state: общий `activeIndex`, который обновляют
  `ArrowUp`/`ArrowDown` и pointer move. Pointer ownership включается только
  после реального `pointermove` с новыми координатами (контракт
  CollectionPicker — синтетический hover при прокрутке не отбирает выделение
  у стрелок). CSS `:hover` собственного выделения не рисует.
- При новых результатах `activeIndex` сбрасывается на первый результат.
- Прокрутка следует за keyboard-навигацией (`scrollIntoView` ближайшего края).

### Превью (справа): карточка + блок метаданных

Панель `w-80 border-l border-border p-4`, `flex flex-col gap-4`,
`overflow-y-auto`. Две зоны — карточка (единственная выделенная рамкой) и
плоский блок метаданных:

**Зона 1 — карточка.** `ReadOnlyCardPreview previewMode="micro"`
(`width = 288`, `shadow="none"`) — единый превью-шаблон для **всех** типов
блоков: медиа рендерится `GraphicSurface` с аспектом из манифеста **внутри
карточного поля `p-4`** (никакого full-bleed — image-карточка получает те же
отступы, что текстовые), затем title (clamp 2) / превью-текст (clamp 3) /
автор. Собственная рамка `CardFrame` (`border rounded-1`, фон переопределён на
`bg-accent`) и есть выделение зоны; от `border-l` панели её отделяет поле
`p-4`.

При активном `search_match` micro-превью использует тот же row-model, что
список (`deriveSearchResultRow`): подсветка title, excerpt первого совпадения
вместо превью-текста, маркер `bg-search-mark`. Никакой второй логики подсветки.

Контекстные действия — **настоящий `CardHoverMenu`** поверх превью-карточки
(никаких lookalike-сборок): тот же компонент, что на карточках главной
страницы, целиком — `More` (`⋯`, верх-право: Connect-подменю, Source, Reveal
in Finder, Copy Path, Rename…, Disconnect, Delete), `Source` (низ-лево, только
при валидном url) и `Connect` (низ-право, `CollectionPicker`). Появление по
ховеру, пиннинг при открытых меню, `stopPropagation` — всё поведение наследуется
от компонента. Обёртка превью даёт `group relative`; `Rename…`/`Delete`
переиспользуют App-диалоги (`onRequestRename`/`onRequestDelete` — те же
обработчики, что у грида). `onToggleTag` оборачивается оптимистичным
обновлением строки `Collections` (локальный кэш по slug); фактическое членство
меняет существующий App-обработчик. Внутри metadata-card кнопок нет.

**Зона 2 — метаданные.** Без собственного карточного контейнера (никакой
рамки, фона и скругления): строки — общий `MetadataRow`
(`src/components/MetadataRow.tsx`, вынесен из Detail: mono muted label слева,
sans value справа, hairline-разделители) — рендерятся плоским списком прямо в
панели.

| Строка | Источник | Кейс отсутствия |
|---|---|---|
| `Date` | `saved_at`, формат `ru-RU` как в Detail | есть всегда |
| `Type` | `card_kind` через общий `formatMetadataCardKind` | есть всегда |
| `Source` | домен из `url` (`domainFromUrl`), **кликабельный** — общий `MetadataLinkValue` (hover underline), `openUrl` за `isSafeUrl` | строка скрыта |
| `Author` | `author` | строка скрыта |
| `Collections` | lazy: существующая батч-команда тегов (`loadBlockTags`), кэш по slug на сессию оверлея; обновляется оптимистично при `Connect`-тоггле | скрыта, пока не загружено или пусто |

Пустые строки скрываются целиком — блок не показывает прочерков.

- Клик по карточке = открыть Detail (то же, что `Enter`).
- Нет результатов → панель пуста (никаких заглушек).

### Состояния тела

| Состояние | Список | Превью |
|---|---|---|
| Пустой query (recent-режим) | 20 последних добавленных, сгруппированных в динамические датные секции | карточка активной строки |
| Запрос в полёте, результатов ещё нет | прежние результаты (если были) | прежнее превью |
| Нет результатов | центрированная строка `No results` `text-sm text-muted-foreground` | пусто |
| Есть результаты | строки результатов | карточка активного результата |

### Recent-режим (пустой query)

Зафиксированные решения (Р-13…Р-16):

- **Содержимое — последние добавленные** (`saved_at DESC`): тот же
  `list_grid_blocks` без запроса — первая страница главной ленты. «Недавно
  просмотренные» отвергнуты (требуют трекинга просмотров, которого нет в
  модели данных), «недавно изменённые» — watcher-правки засоряют список
  техническими изменениями.
- **Лимит 20** (`SEARCH_OVERLAY_RECENT_LIMIT`): трамплин к свежему, не браузер
  истории. Счётчик в шапке скрыт (он осмыслен только как «сколько найдено по
  запросу»).
- **Динамические датные секции** (`src/lib/recencyBuckets.ts`, канон
  Notion/Apple Mail): `Today` · `Yesterday` · `Past 7 days` · `Past 30 days` ·
  имена месяцев текущего года (`May`) · голые годы (`2025`). Граница дня —
  локальная полночь (календарный день, не скользящие 24 часа). Заголовок
  секции — `text-sm text-muted-foreground`, выводятся только непустые секции
  в порядке убывания свежести. Сломанный `saved_at` не пересортирует список —
  такой элемент остаётся в последней открытой секции. Поисковая выдача не
  группируется никогда: там порядок — релевантность, не время; клавиатурная
  навигация плоская, секции для стрелок невидимы.
- **Тот же контракт строк**: навигация, превью, метаданные, hover-действия;
  строки рендерятся существующим `deriveSearchResultRow` (без `search_match`
  → title + `preview_text`, без подсветки). `vault-refreshed` /
  `block-deleted` инвалидируют и recent-список.
- **Без debounce**: recent статичен — грузится мгновенно при открытии и при
  очистке запроса; debounce остаётся только у живого набора (100ms).
  `No results` в recent-режиме не показывается.

Никаких спиннеров: при 100ms debounce и sub-100ms lexical-ответах (perf-контракт
SPEC_SEARCH) промежуточное состояние не успевает стать заметным; устаревшие
результаты заменяются атомарно.

## Клавиатура

| Клавиша | Поведение |
|---|---|
| `Cmd+F` | Toggle overlay (см. «Открытие и закрытие») |
| Печать | Ввод query; фокус всегда в инпуте |
| `ArrowDown` / `ArrowUp` | Сдвиг `activeIndex` по списку; без цикла (на краях останавливается); DOM-фокус остаётся в инпуте, `aria-activedescendant` обновляется |
| `Enter` | Открыть активный результат в Detail, закрыть overlay |
| `Escape` | Закрыть overlay |
| `Cmd+K` | Не участвует: остаётся за card/Detail-меню (контракт SPEC_SEARCH) |

Модифицированные `ArrowUp/Down/Enter` (`Cmd`/`Ctrl`/`Alt`) списком
игнорируются — кандидаты глобальных шорткатов (системное правило триггеров).

## Данные и поток

```
ввод → normalizeSurfaceSearchQuery → debounce 100ms
     → fetchGridBlocks(undefined, 0, 200, query)      // vault-wide
     → { blocks, total_blocks } → state оверлея
```

- **Scope: всегда весь vault** (`currentTag` не передаётся). Overlay — поиск
  «где угодно», а не фильтр текущей поверхности; пользователь в канале обязан
  находить карточки вне канала. Это сознательное отличие от грид-фильтра из
  SPEC_SEARCH (тот наследовал маршрут).
- Команда: существующая `list_grid_blocks` с `query`, `limit = 200`
  (дефолтный, перф-проверенный). Результаты — `LightBlock[]` c
  `search_match`; никаких чтений `.md`, никаких новых IPC.
- Гонки: счётчик последовательности запросов; ответ применяется только если
  query не изменился и оверлей открыт (паттерн существующего snapshot-пайплайна).
- Результаты живут в состоянии оверлея и не трогают `blocks` грида, кэш
  маршрутов и `generationKey`.
- **Инвалидация по мутациям vault** — двухфазная:
  1. **Optimistic**: при подтверждении удаления App диспатчит window-событие
     `block-deleted` (`detail.slug`) ещё до IPC — строка исчезает из выдачи
     мгновенно (счётчик −1, активная строка следует за своим slug либо
     клампится). Без этого между подтверждением и полным рефрешем висела
     ~секунда «кнопка не сработала».
  2. **Truth**: оверлей слушает `vault-refreshed` (App диспатчит после каждого
     свежего grid-снапшота — удаление, rename, клипер, watcher) и молча
     переисполняет активный запрос без debounce; это же самовосстанавливает
     список, если оптимистичное удаление не подтвердилось. Кэш lazy-коллекций
     сбрасывается тем же сигналом.
- `Enter`/клик: `openDetailBlock(block)` — `LightBlock` из поиска уже
  совместим с Detail-потоком (`handleBlockClick`). Стрелочная навигация
  внутри Detail работает по текущему гриду; для карточки вне текущего грида
  соседей нет — допустимая мягкая деградация.
- Демонтаж старого пути: эффект `mainSearchQuery → loadGridSnapshot(query)`
  и query-составляющая ключей маршрутного кэша удаляются; `toggleMainSearch`
  переименовывается в открытие оверлея. Параметр `query` в
  `fetchGridBlocks`/`list_grid_blocks` остаётся — это контракт бэкенда,
  теперь его единственный потребитель — overlay.

## Производительность

- Один IPC на debounce-тик; ответ ≤ 200 лёгких строк.
- Список без виртуализации: ≤ 200 строк по две текстовые строки — дёшево;
  карточек в списке нет, тяжёлый рендер один — превью активного результата.
- Превью перерисовывается при смене `activeIndex` — один `ReadOnlyCardPreview`,
  сопоставимо с одной карточкой грида.
- Закрытие оверлея размонтирует список и превью; состояние `{query}`
  остаётся в App.

## Доступность

- Radix Dialog: focus trap, `role="dialog"`, `aria-modal`, возврат фокуса.
- Инпут: `role="combobox"`, `aria-expanded`, `aria-controls` на список,
  `aria-activedescendant` на активную строку.
- Список: `role="listbox"`, строки `role="option"` со стабильными DOM id,
  `aria-selected` на активной.
- Подсветка — семантический `<mark>`.

## Объём реализации

| Файл | Изменение |
|---|---|
| `src/components/SearchOverlay.tsx` | Новый компонент: Dialog-поверхность, header, список, превью, клавиатура |
| `src/lib/searchResultRow.ts` | Новый чистый маппер `deriveSearchResultRow(block)` → `{ title, titleMatch, snippet, snippetMatch }` по правилам Match Metadata (тестируемое ядро строк списка) |
| `src/App.tsx` | Состояние `{open, query}`; `surface-search-shortcut: "main"` и `Search elements` открывают overlay; демонтаж эффекта грид-фильтрации; `openDetailBlock` из результата |
| `SPEC_SEARCH.md` | Правки секций Main/Grid Search, Keyboard Contract, Frontend Data Flow, Test Contract (см. «Отношение к SPEC_SEARCH.md») |
| `DESIGN_SYSTEM.md` | Раздел Search Overlay: геометрия панели, строка результата, счётчик, превью |
| `CLAUDE.md`, `ARCHITECTURE.md` | Ссылки на этот SPEC |

Бэкенд: изменений нет.

## Test Contract

`src/lib/searchResultRow.test.ts` (чистая логика):

- title-match → заголовок с диапазонами, сниппет = preview_text без mark;
- body/description-match → сниппет = excerpt с диапазонами;
- semantic-match → сниппет = excerpt, диапазоны пустые;
- author/url-match → сниппет = preview_text, диапазонов нет, excerpt
  метаданных не утекает в рендер;
- медиа-блок без текста → snippet отсутствует;
- display title → fallback label, когда title пуст.

`src/components/SearchOverlay.test.tsx` (компонент):

- открытие рендерит инпут с автофокусом; прежний query выделен целиком;
- ввод → debounce → `fetchGridBlocks(undefined, 0, 200, query)` вызван;
  устаревший ответ (query успел смениться) отброшен;
- счётчик показывает количество текущих search rows (`0`, `N`, `N+` при
  `has_more`), не старый `total_blocks` vault-а; clear очищает query и
  возвращает фокус;
- `ArrowDown/Up` двигают `activeIndex` и `aria-activedescendant`, фокус
  остаётся в инпуте; первый результат активен по умолчанию;
- `Enter` вызывает open-callback активного блока и закрывает overlay;
- клик по строке и по превью — то же;
- `Escape` закрывает overlay при любом query;
- `No results` отображается при пустом ответе на непустой query;
- сниппеты: mark для body-match, отсутствие mark для semantic, preview_text
  для author-match (регрессия «не светить метаданные»).

`src/App.test.tsx` (интеграция):

- событие `surface-search-shortcut: "main"` открывает overlay; повторное —
  закрывает;
- кнопка `Search elements` открывает overlay и не остаётся pressed;
- выбор результата открывает Detail этой карточки, overlay закрыт;
- открытие/закрытие оверлея не меняет `blocks` грида и не инвалидирует
  кэш маршрутов;
- `Shift+Cmd+F` (sidebar) не затронут: продолжает фокусировать channel search.
