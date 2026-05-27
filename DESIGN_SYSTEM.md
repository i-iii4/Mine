# Дизайн-система Mine

Токены определены в `src/styles/global.css` → `@theme inline`.
Tailwind v4 генерирует утилиты автоматически из `--radius-*`, `--spacing-*`, `--text-*`.

## Скругления

| Токен | Значение | Утилита | Где |
|---|---|---|---|
| `--radius-0` | 0 | `rounded-0` | Карточки контента, изображения, текстовые блоки |
| `--radius-1` | 3px | `rounded-1` | Все элементы интерфейса: кнопки, инпуты, бейджи, попапы, меню, тултипы, диалоги |
| — | 2px | `rounded-[2px]` | Чекбоксы (16px, компенсация масштаба) |
| `--radius-pill` | 9999px | `rounded-pill` | Переключатели, тоглы, прогресс-бар |
| `--radius-round` | 50% | `rounded-round` | Аватары, индикаторы статуса |

**Правило:** содержимое — без скругления (`rounded-0`), интерфейс — 3px (`rounded-1`), чекбоксы — 2px.

## Отступы

| Токен | Значение | Утилита | Где |
|---|---|---|---|
| `--spacing-s1` | 4px | `p-s1`, `gap-s1` | Внутренний отступ мелких элементов (теги, бейджи) |
| `--spacing-s2` | 8px | `p-s2`, `gap-s2` | Отступ внутри кнопки, инпута |
| `--spacing-s3` | 16px | `p-s3`, `gap-s3` | Отступ между элементами внутри карточки |
| `--spacing-s4` | 24px | `p-s4`, `gap-s4` | Padding внутри карточки от края |
| `--spacing-s5` | 32px | `p-s5`, `gap-s5` | Расстояние между карточками (gap сетки) |
| `--spacing-s6` | 48px | `p-s6`, `gap-s6` | Отступ между секциями |
| `--spacing-s7` | 64px | `p-s7`, `gap-s7` | Верхний/нижний отступ страницы |

**Примечание:** токены spacing определяют разрешённую шкалу. Числовые утилиты Tailwind (`p-2`, `gap-8`) допустимы, если их значение совпадает со шкалой. Недопустимые значения: 20px (`p-5`), 28px (`gap-7`), 40px — их нет в шкале.

Grid gap (32px) задан JS-константой `GAP` в `Grid.tsx`, потому что участвует в расчёте колонок. Соответствует `--spacing-s5`.

## Типографика

### Размеры

| Токен | Значение | line-height | Утилита | Где |
|---|---|---|---|---|
| `--text-sm` | 12px | 16px | `text-sm` | Мета: даты, счётчики, подписи. Карточки контента |
| `--text-base` | 14px | 20px | `text-base` | Основной текст интерфейса |
| `--text-lg` | 18px | 24px | `text-lg` | Заголовки |

**Только три размера.** `text-xs`, `text-xl`, `text-2xl` и т.д. не используются.

### Markdown headings in articles

Article prose does not inherit heading sizes from `@tailwindcss/typography`
defaults. Mine maps Markdown headings onto the same three-token typography
scale used by the rest of the product:

| Element | Typography | Где |
|---|---|---|
| Article body `h1` | `text-lg leading-6 font-semibold` | Видимый заголовок статьи / link clip body H1 |
| Article body `h2-h6` | `text-base leading-5 font-semibold` | Внутренние секции markdown |
| Article body paragraphs | `text-base` via prose body | Основной текст статьи |

`30px/36px` prose-default `h1` is not allowed in Mine; article heading
typography must stay inside the 12/14/18px design-system scale.

### Веса

| Вес | Утилита | Где |
|---|---|---|
| 400 | по умолчанию | Основной текст |
| 600 | `font-semibold` | Заголовки, активный элемент сайдбара, кнопки, бейджи, метки |

**Только два веса.** `font-medium` (500), `font-bold` (700) и прочие не используются.

### Шрифты

| Шрифт | Переменная | Утилита | Где |
|---|---|---|---|
| Geist | `--font-sans` | по умолчанию | Карточки, кнопки, меню, диалоги |
| Geist Mono | `--font-mono` | `font-mono` | Сайдбар (навигация каналов), панель метаданных в Detail |

## Цветовой принцип

Все серые — чисто нейтральные (R=G=B), chroma 0, hue 0. Никаких тёплых или холодных оттенков. Цвет допустим только в акцентах: ссылки, ошибки (destructive), графики (chart-*).

**Правило:** при добавлении нового серого — `oklch(L 0 0)`. Не вводить hue.

## Цвет текста

Три уровня иерархии через яркость.

| Роль | Токен | Светлая | Тёмная | Утилита |
|---|---|---|---|---|
| Основной | `--foreground` | #0A0A0A | #FAFAFA | `text-foreground` |
| Вторичный | `--muted-foreground` | #777777 | #9A9A9A | `text-muted-foreground` |
| Третичный | `--tertiary-foreground` | #B0B0B0 | #666666 | `text-tertiary-foreground` |

**Правило:** иерархия через яркость, не через размер или цвет. Плейсхолдеры — tertiary, мета-информация — muted.

## Фоны

Две независимые группы токенов: **поверхности** (фоновое наслоение) и **заливки компонентов** (кнопки, интерактивные элементы). Разные требования к контрасту — поверхности тонкие, кнопки считываемые.

### Поверхности

| Уровень | Токен | Светлая (L) | Тёмная (L) | Назначение |
|---|---|---|---|---|
| 0 | `--background` | 1.0 | 0.1567 | Фон страницы |
| +0.5 | `--chrome` | 0.99 | 0.1691 | App/top chrome между фоном и action bar |
| +1 | `--accent` | 0.98 | 0.1815 | Hover фон, action bar |
| +2 | `--sidebar-accent`, `--active` | 0.965 | 0.2063 | Legacy/sidebar surface, нажатие |
| +3 | `--border` | 0.95 | 0.2311 | Границы, разделители |

**Шаг от accent:** светлая тема — 0.015, тёмная — 0.0248.

**Примечание:** `--chrome` — отдельная роль app shell, не sidebar state.
Токены `--muted`, `--secondary` имеют то же значение, что и `--accent` (для
совместимости с shadcn). Для нижней панели и активных search surfaces
используем `bg-accent`, для верхнего chrome — `bg-chrome`.

### Заливки компонентов (component fills)

Изолированный набор токенов для кнопок. Изменение поверхностей не затрагивает кнопки и наоборот.

| Токен | Светлая (L) | Тёмная (L) | Назначение |
|---|---|---|---|
| `--component-fill` | 0.9702 | 0.22 | Фон Button (default, destructive). ActionButton внешняя пуля |
| `--component-fill-inner` | 0.94 | 0.28 | ActionButton внутренняя пуля |
| `--component-fill-hover` | 0.91 | 0.34 | Hover/selected ActionButton. Hover-обводка Button |

Тёмная тема — тёмно-серый фон (#0C0C0C, sRGB 0.049). Изображения «парят» на почти-чёрном фоне.

## Границы

Базовый цвет для разделителей: `--border`, `--input`, `--sidebar-border`.
Уровень +3 шкалы поверхностей.

| Тема | oklch | Толщина |
|---|---|---|
| Светлая | oklch(0.95 0 0) | 1px |
| Тёмная | oklch(0.2311 0 0) | 1px |

Локальные исключения для hover/focus state в sidebar и feed:

| Токен | Светлая | Тёмная | Где |
|---|---|---|---|
| `--border-accent` | oklch(0.145 0 0 / 12%) | oklch(0.985 0 0 / 16%) | Hover/focus color для sidebar row separator и focused feed card frame |
| `--graphic-card-focus-overlay` | oklch(0 0 0 / 14%) | oklch(1 0 0 / 18%) | Focus wash для graphic card surface |

**Правило:** по умолчанию все линии используют `--border`. `--border-accent`
разрешён только для состояния hover/focus у sidebar row separator и keyboard
focus у feed card frame, где 1px линия должна слегка поддержать active state,
но не спорить с контентом. В sidebar реализация идёт через один и тот же
separator system: каждая строка владеет только своей нижней seam line, а
hover/focus перекрашивает seam текущей и предыдущей строки. В feed меняется
только цвет существующего 1px Card frame. Без второй линии и без изменения
толщины.

## Оверлеи

| Роль | Светлая | Тёмная |
|---|---|---|
| Backdrop (`--glass-bg`) | rgba(255,255,255,0.8) | rgba(12,12,12,0.6) |
| Shadow overlay | 0 4px 24px rgba(0,0,0,0.12) | 0 4px 24px rgba(0,0,0,0.4) |

## Интерактивные состояния

Состояние элемента меняется одним свойством за раз. Без transition. Мгновенно.

### Hover

| Элемент | Что меняется | Светлая | Тёмная | Утилита |
|---|---|---|---|---|
| Кнопка default/destructive | Обводка 1px inset | `--component-fill-hover` | `--component-fill-hover` | `hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover` |
| Кнопка ghost/link | Цвет текста | #333 → #000 | #E4E4E4 → #FFF | `hover:text-hover-foreground` |
| Карточка | Frame не меняется | — | — | Hover actions only |

### Focus

| Состояние | Светлая | Тёмная |
|---|---|---|
| Обычный инпут | border: #EBEBEB | border: #1D1D1D |
| Focused | border: #333333 | border: #E4E4E4 |

Утилита: `focus-visible:border-foreground`. Без box-shadow, outline, glow.

### Active (нажатие)

Не используется. Hover достаточен для обратной связи.

### Native selection

Mine chrome is non-selectable by default: toolbar, sidebar, feed cards,
metadata rail, hover previews, buttons, images, and videos must not show the
blue WebKit selection overlay during pointer drags. The only non-editable
surface that opts back into native text selection is Detail article prose
(`[data-article-body]`), because text-selection extraction and `Cmd+C` depend
on the system selection.

### Selected (активный пункт сайдбара)

Sidebar navigation rows do not render a selected background. The active route
lives in router state; the table-like sidebar keeps one visual row model for
default, hover and active route states.

Default row text and right counts use `text-muted-foreground`. The selected
route row (`Everything` or the current channel) always stays
`text-foreground`. On row hover/focus the sidebar only brightens the focused
row text to `text-foreground`; all other row labels/counts stay
`text-muted-foreground`. The selected route also remains `text-foreground` if
another row is currently focused. Thumbnail strips do not participate in this
state and stay visually unchanged. The row separator is a single owned seam per
row; hover/focus changes the color of the hovered row seam and the previous row
seam to `border-accent`, never their thickness. Enter/exit uses `180ms
cubic-bezier(0.22, 1, 0.36, 1)`; switching directly between rows inside focus
mode disables transition for that switch frame.

### Токены интерактивных состояний

Поверхности:

| Токен | Светлая (oklch L) | Тёмная (oklch L) | Назначение |
|---|---|---|---|
| `--accent` | 0.98 | 0.1815 | Ховер фон (поверхность +1) |
| `--sidebar-accent` | 0.965 | 0.2063 | Legacy/sidebar surface (+2), не для текущих row states |
| `--active` | 0.965 | 0.2063 | Нажатие (поверхность +2) |

Заливки компонентов:

| Токен | Светлая (oklch L) | Тёмная (oklch L) | Назначение |
|---|---|---|---|
| `--component-fill` | 0.9702 | 0.22 | Фон кнопки |
| `--component-fill-inner` | 0.94 | 0.28 | Внутренняя пуля ActionButton |
| `--component-fill-hover` | 0.91 | 0.34 | Hover/selected, обводка hover |

Прочие:

| Токен | Светлая (oklch L) | Тёмная (oklch L) | Назначение |
|---|---|---|---|
| `--hover-foreground` | 0.0 | 1.0 | Ховер текста (ghost/link кнопки) |
| `--primary-hover` | 0.4495 | 0.8 | Hover обводки карточек |

## Компоненты (shadcn/ui + CVA)

Все компоненты — обёртки над Radix UI примитивами, стилизованные через CVA (Class Variance Authority). Радиусы, цвета, размеры — из токенов выше.

### Button

Базовые свойства всех кнопок: `rounded-1` (3px), `font-semibold`, `cursor-pointer`, `select-none`.

Кнопки используют изолированный набор токенов `--component-fill-*`, не зависящий от поверхностей.

Варианты (`variant`):

| Вариант | Фон | Hover | Отличие |
|---|---|---|---|
| `default` | `bg-component-fill` | обводка 1px inset `--component-fill-hover` | — |
| `destructive` | `bg-component-fill` | обводка 1px inset `--component-fill-hover` | `text-destructive` (красный текст) |
| `ghost` | `bg-transparent` | `text-hover-foreground` (текст ярчеет) | Невидимая до взаимодействия |
| `link` | `bg-transparent` | `text-hover-foreground` (текст ярчеет) | `underline` |

Размеры (`size`):

| Размер | Высота | Паддинги | Шрифт |
|---|---|---|---|
| `default` | `h-8` (32px) | `px-3` | `text-base` (14px) |
| `clipper` | `h-10` (40px) | `px-3` | `text-base` (14px) |
| `sm` | `h-7` (28px) | `px-2.5` | `text-base` (14px) |
| `xs` | `h-6` (24px) | `px-2` | `text-sm` (12px) |
| `icon` | `size-8` (32px) | — | — |
| `icon-xs` | `size-6` (24px) | — | — |

Input и Command по умолчанию — 32px (`h-8`). Clipper использует
`Input controlSize="clipper"` (`h-10`) только внутри popup/overlay строк.

**Скругление всех элементов интерфейса — 3px (`rounded-1`).** Без исключений: Button, ActionButton (обе пули), Badge, DropdownMenu, Tooltip, Input.

**Семантические токены скругления** (управляются из `global.css`):
- `--radius-card` → скругление карточек (по умолчанию `var(--radius-1)` = 3px)
- `--radius-media` → скругление медиа внутри карточек (по умолчанию `var(--radius-0)` = 0px)

Карточки: `rounded-[var(--radius-card)]` на обёртке `[data-block-slug]`.
Медиа: глобальное CSS-правило `[data-block-slug] img, [data-block-slug] video { border-radius: var(--radius-media) }`.

### Input

Два варианта:

| Вариант | Стиль |
|---|---|
| `default` | `h-8 rounded-1 border border-input bg-background px-3 text-base` |
| `ghost` | `h-8 rounded-1 bg-transparent border-none px-3 text-base` — только текст и курсор |
| `controlSize="clipper"` | `h-10` поверх `default`/`ghost`, только для Web Clipper 40px rows |

Фокус (default): `border-foreground`. Плейсхолдер: `text-tertiary-foreground`.

### Surface Search

Surface Search описан в [SPEC_SEARCH.md](SPEC_SEARCH.md). Это inline state
существующих поверхностей, не modal и не command palette.

Main/Grid search (`Cmd+F`) сохраняет backend/query механизм, но visual search
component сейчас временно не rendered. Top chrome всё равно делится тем же
`--sidebar-width`, что и body: левая часть держит traffic-light spacer, space
selector, sidebar channel search и `border-r border-sidebar-border`, поэтому
разделитель Sidebar/Main продолжается до верхнего края окна. Правая часть top
chrome начинается с current collection switcher, а оставшаяся область остаётся
drag region до нового search surface. Поиск не участвует в layout Grid, не
анимирует страницу и не меняет scroll viewport.
Bottom app bar справа содержит `ActionButton` `Search cards` с `hotkey="⌘F"`.
Это command trigger, а не selected/toggle visual state: кнопка не получает
`isSelected` и не остаётся зажатой, даже когда search state активен. Button и
повторный shortcut переключают App-owned main search state без показа input.
При входе в Grid group selection пустой search state перестаёт быть active,
непустой query/filter остаётся активным.

Settings содержит persisted переключатель `Hide bottom menu`
(`localStorage` key `mine.bottomActionBarHidden`). Он скрывает весь bottom app
bar без placeholder-строки и без изменения высоты top chrome/body. Чтобы не
создавать тупик в UI, Settings в этом состоянии переезжает в permanent top
chrome и открывает меню вниз; shortcut `Cmd+,` продолжает открывать тот же
контрол.

Sidebar search (`Shift+Cmd+F`) живёт в левом сегменте top chrome. Порядок:
traffic-light spacer, separator `w-px bg-border`, space selector, separator
`w-px bg-border`, search input, затем штатный `border-r border-sidebar-border`
между Sidebar и Main.

Permanent top chrome использует `bg-chrome`, промежуточный surface между
`bg-background` и `bg-accent`. Это оставляет активному search surface следующий
видимый уровень заливки: когда query непустой, search wrapper получает
`bg-accent`, а остальной header остаётся `bg-chrome`.
Traffic-light reserve (`80px`) не остаётся прозрачным spacer'ом: он получает
тот же surface class, что и permanent top chrome (`bg-chrome` или, в variant
2, `bg-accent`). Дополнительно App синхронизирует native window background
через `getCurrentWindow().setBackgroundColor()` с тем же surface, чтобы
AppKit titlebar area не просвечивала чужим цветом поверх overlay titlebar.
Сами native traffic lights не стилизуются CSS, не перекрашиваются через webview
и не получают custom alpha/state machine из Rust. На macOS desktop это всегда
настоящие AppKit standard window buttons, а inactive gray, hover color,
обводка, disabled/active state и click behavior полностью остаются системными.
Frontend только резервирует `80px` зоны и синхронизирует фон native titlebar
area с top chrome, чтобы системные кнопки лежали на корректной поверхности.
Fake traffic lights, outline/обводка кружков, ручная отрисовка кнопок и
programmatic hide/show настоящих кнопок запрещены.

Theme selector обязан синхронизировать не только web theme (`data-theme` +
`color-scheme`), но и native AppKit appearance через Tauri `setTheme()`:
`Light` → `setTheme("light")`, `Dark` → `setTheme("dark")`, `System` →
`setTheme(null)`. Это не перекрашивает traffic lights вручную, а переводит
системные кнопки, меню и native chrome в ту же light/dark appearance, что и
приложение. Произвольный цвет traffic lights по-прежнему запрещён.

Settings содержит persisted переключатель `Chrome surfaces variant 2`
(`localStorage` key `mine.chromeSurfaceVariant`). По умолчанию используется
variant 1, описанный выше. Variant 2 меняет только surface mapping:
permanent top chrome становится `bg-accent` как нижняя action bar, второй
top-bar layer становится `bg-chrome` и в main/Grid state, и в Detail/link-editor
state, classic Detail/Sidebar title bars также становятся `bg-chrome`, а
непустой Sidebar search получает `bg-active`, чтобы оставаться видимым на
`bg-accent` top chrome. Геометрия, typography, spacing и motion не меняются.

Когда sidebar collapsed, top chrome не схлопывается до `0px` и не держит
пустой слот под исчезнувший поиск. Левый segment сжимается до реального
содержимого: `80px` traffic-light safety area + `1px` separator + intrinsic
width space selector. Channel search скрывается, а правая часть top chrome с
current collection switcher начинается сразу после compact collapsed segment.
Collapsed layout строится только CSS intrinsic sizing: левый segment получает
`w-auto max-w-[240px]`, а `VaultSwitcher` в collapsed mode получает
`max-w-[159px]` (`240 - 80 - 1`). JS measurement, hidden probe и вычисление
ширины по уже обрезанному visible trigger запрещены.

Space selector — это top-chrome вариант `VaultSwitcher`: `h-full`,
`max-w-[50%]`, `flex-none`, `min-w-0`, `px-3`, `rounded-0`,
`font-mono text-sm text-muted-foreground`, `truncate`; без folder icon и без
dropdown chevron. Root trigger не заливается и не рисует отдельную обводку: он
только задаёт layout slot. Ширина
подстраивается под имя текущей папки, но не может занять больше половины
доступной search/space зоны. В collapsed sidebar state, когда search скрыт,
ограничение меняется на `max-w-[159px]`, а сам segment shrink-wrap'ится по
intrinsic width selector, чтобы справа не оставалось пустой ячейки. Короткое
имя (`Mine`, `Тест`) обязано отображаться полностью; ellipsis допустим только
для длинных названий, которые превышают collapsed selector cap.

Визуальный hover/open/keyboard-focus state принадлежит внутренней пуле вокруг
имени: `h-6 rounded-1 px-2 bg-active text-foreground`. В покое текст пули
остаётся `text-muted-foreground`, как в Detail top bar; hover/open/keyboard
focus поднимает только эту интерактивную плашку до `text-foreground`. Это тот
же system hover/active token, что используется для row hover/focus в
`DropdownMenu`. Текст выровнен по левому краю через `justify-start` +
`text-left`. Space selector уже стоит после
traffic-light reserve, поэтому использует компактный root inset `px-3`, а не
правую content axis. Вместе с внутренним `px-2` пули текст начинается на `20px`
после separator. Если имя папки не помещается, оно режется обычным end ellipsis.
Pointer-click не должен оставлять trigger в focus-colored состоянии после
закрытия dropdown: top chrome triggers используют общий interaction hook,
который различает pointer и keyboard open. После pointer-close Radix
auto-focus на trigger отменяется и trigger blur'ится; после keyboard-close
focus возвращается на trigger и сохраняет keyboard-focus fill.
Pointer-drag не открывает dropdown: trigger defers Radix pointer-open до
обычного click. Если жест пересёк drag threshold, click подавляется и меню не
появляется.

Space dropdown не показывает текущий space повторно и не использует checkmark
или другие selected markers. Внутри есть `Search spaces` input, список только
destination spaces и pinned `Add space` action без иконки. Rows ниже input —
menu-styled buttons с `role="menuitem"`; hover может менять active row, но не
забирает DOM focus из input. Ширина dropdown — floating width role `selector`
(`18rem` с available-width cap), а не ширина trigger и не content-fit.
Позиционирование dropdown привязано к видимой внутренней пуле selector, а не к
невидимому root slot: Radix `align="start"` использует `alignOffset=12`, равный
root inset `px-3`.

Search input не использует иконку. Search surface — wrapper `h-8 min-w-0
flex-1`, внутри прозрачный `Input ghost` (`rounded-0 px-3 py-0 border-none`)
и опциональный clear action справа. Текст permanent top-chrome search также
использует Detail top bar typography: `font-mono text-sm
text-muted-foreground`. Search занимает весь остаток ширины после selector. При
вводе длинного query используется нативное поведение `input`: caret остаётся
видимым, поэтому пользователь видит последние вводимые символы. Пустое поле на
hover/focus не получает фон: реагирует только placeholder,
`text-tertiary-foreground` → `text-muted-foreground`. Когда trimmed query
непустой, только search surface получает `bg-accent`, тот же surface token, что
нижняя action bar; весь header, space selector и separator lines остаются на
`bg-chrome`. В `Chrome surfaces variant 2` этот filled state становится
`bg-active`, потому что сам permanent top chrome уже использует `bg-accent`.

Clear action появляется только когда value непустой: `button h-6 w-6
rounded-1`, иконка `X` из `lucide-react`, `aria-label="Clear channel search"`.
Hover/focus clear action использует `bg-component-fill-hover text-foreground`.
Click очищает query, восстанавливает полный список каналов и возвращает focus
в input. `Escape` с непустым value очищает поле; `Escape` с пустым value
снимает focus.

Top-chrome search inputs use input-owned keyboard navigation. `ArrowUp` /
`ArrowDown` change `aria-activedescendant` and the visual active row; DOM focus
stays in the input so the user can keep typing. This applies to Sidebar channel
search, `Search spaces` and `Search collections`. `Enter` activates the active
row. Pointer hover can update the active row but must not blur the input. Все
search inputs отключают нативные подсказки ввода через общий
`SEARCH_INPUT_SUPPRESSION_PROPS`: `autoComplete="off"`, `autoCorrect="off"`,
`autoCapitalize="none"`, `spellCheck={false}`. Это относится к top chrome,
space/collection dropdowns и channel connect pickers; обычные поля ввода вроде
rename/create остаются самостоятельными.

Right collection switcher живёт в правом top chrome segment и показывает
текущую Grid route collection: `Everything` или имя текущего канала. Геометрия
повторяет space selector: root slot `h-full min-w-0 max-w-[50%] flex-none
rounded-0 bg-transparent font-mono text-sm text-muted-foreground`, без dropdown
chevron; root padding `px-6` в expanded mode и `px-3` в compact/collapsed mode,
чтобы после collapsed space selector не оставалось лишнего 32px inset.
Hover/open/keyboard-focus рисует только inner pill
`h-6 rounded-1 px-2 bg-active text-foreground` вокруг имени. При клике
открывается обычный `DropdownMenu` со search field `Input ghost` и пунктами
коллекций в том же порядке, что Sidebar. Текущая коллекция не дублируется в
списке вообще: нет checkbox/radio/check icon, нет selected row, нет disabled
current item. Search input остаётся единственным focus owner внутри dropdown:
hover по destination rows не переводит фокус с input на строку. Строки ниже
input — menu-styled action buttons с `role="menuitem"`, а не roving-focus
`DropdownMenuItem`. Внизу всегда закреплена строка `Create channel`; она не
является search result и не меняет текст на `Create "{query}"`. Нажатие
закрывает dropdown и открывает отдельный create-channel dialog; dialog может
prefill'иться текущим query, валидирует пустые/дублирующиеся имена, вызывает
штатный channel create command, обновляет taxonomy/grid snapshots и переводит
route в новый канал. Ширина dropdown — floating width role `selector` (`18rem`),
такая же как у Space dropdown.
Позиционирование dropdown привязано к видимой внутренней пуле collection
trigger. В expanded mode Radix `alignOffset=24` компенсирует root `px-6`; в
compact/collapsed mode `alignOffset=12` компенсирует root `px-3`. Dropdown не
может выпадать от невидимого layout slot, даже если slot шире видимой пули.

Compact Detail top menu — экспериментальная настройка Settings
`Compact Detail top menu`. Настройка заранее переводит right top chrome в
compact geometry: collection switcher использует `px-3` уже на главной
странице, поэтому `Everything`/название текущего канала не меняет X-position
при открытии и закрытии Detail. Permanent top chrome всегда остаётся
`bg-chrome`; открытие Detail не меняет его surface. Внутренний Detail top bar и sidebar
`Channels:` bar не рендерятся. Segmented control `All / Connected`
принадлежит левому Sidebar/search segment: в expanded state он стоит внутри
search surface справа от `Search channels...` и слева от вертикального sidebar
divider; в collapsed state search скрыт и `All / Connected` не рендерится,
потому что в compact rail нет списка строк, который нужно фильтровать. Правая
часть top chrome начинается с того же кликабельного collection switcher, затем
показывает название карточки, overflow `…`, close `X`.

Геометрия Compact Detail top menu:

- Height: `h-8`, как permanent top chrome.
- Surface: всегда `bg-chrome`. Это жёсткий permanent app chrome surface; он не
  переходит в `bg-accent` при открытии Detail. Активный search по-прежнему
  получает `bg-accent`, поэтому остаётся следующим уровнем заливки над ordinary
  chrome.
- Spacing: только compact axis `px-3`; правые `px-6`, `px-8` и любые 32px
  content-axis insets запрещены во всём режиме настройки, включая main/Grid
  state до открытия Detail.
- Segmented control: `h-6 p-[2px] rounded-1 font-mono text-sm`, segments
  `h-5 px-[1ch] rounded-[2px]`; active segment
  `bg-component-fill-inner text-foreground`, inactive
  `text-muted-foreground`.
- `Channels:` label в этом режиме запрещён.
- Текущая коллекция: штатный `TopCollectionSwitcher` в compact geometry
  (`px-3`, inner pill `h-6 px-2`). Это постоянный элемент right top chrome, а
  не часть условного Detail-блока: trigger остаётся тем же DOM/layout control
  до открытия Detail, во время Detail и после закрытия. Trigger остаётся
  кликабельным и открывает тот же dropdown коллекций; plain text label здесь
  запрещён.
- Название карточки: `font-mono text-sm text-muted-foreground`,
  `min-w-0 flex-1 truncate pl-0 pr-3`; это первый элемент, который отдаёт
  ширину. Левый padding запрещён: зазор между видимой collection pill и title
  задаёт только правый `px-3` slot самого `TopCollectionSwitcher`, иначе
  получается двойной неартикулированный отступ.
- Overflow и close: icon buttons `size-8 shrink-0`, всегда видимы. Правая
  сторона получает compact inset `pr-3`, чтобы close не упирался в край окна.

Responsive order: сначала режется название карточки, затем текущая коллекция,
затем сжимается Sidebar search в своём существующем flex slot. Segmented
control, overflow и close не сжимаются. В collapsed Sidebar state channel
search скрыт как обычно, а `All / Connected` отсутствует.

Motion: Detail-only элементы в compact top chrome входят и выходят тем же
языком, что classic Detail chrome: `opacity + translateY` через
`detail-top-bar-enter`, а separator line — через `detail-top-bar-line-enter`.
Collection switcher, space selector, channel search и Sidebar divider не
анимируются при открытии Detail и не меняют позицию. Цвет permanent top chrome
никогда не анимируется и остаётся `bg-chrome`; Detail-only controls анимируются
через `220ms cubic-bezier(0.22, 1, 0.36, 1)`. Exit state выставляется синхронно в
close handler до очистки selected Detail state; выход должен идти тем же
motion path, что появление, без промежуточного скачка в normal top chrome.

Top chrome controls are dual-purpose. A short pointer gesture keeps the native
control action: click opens the space selector, click/focus enters channel
search. Movement beyond `4px` starts native window drag through
`useChromeDragGesture()` / `getCurrentWindow().startDragging()` and suppresses
the following click. This keeps the Zed-like behavior where even filled chrome
can be used to move the window without turning controls into dead drag-only
areas.

Dropdown triggers inside top chrome use `useTopChromeTriggerInteraction()`
instead of raw Radix pointer-open. Short pointer click opens the dropdown;
drag beyond `4px` starts native window drag and suppresses the trailing click,
so the menu does not flash open after the drag. Pointer-close blurs the trigger
to avoid sticky hover/focus fill, while keyboard-close restores focus for
keyboard accessibility. Reusable controls such as `CardMoreMenu` must opt into
this mode only when rendered inside top chrome; card-local menus keep their
normal card interaction contract.

Search match mark внутри карточек:

- element: `mark` или inline `span`;
- typography наследуется от родительского title/excerpt;
- background: `bg-active`;
- text: `text-foreground`;
- radius: none;
- horizontal padding: `p-0`;
- no border, no underline, no color accent.

Prefix search подсвечивает только введённый префикс: `memo` в слове `memory`
даёт mark вокруг `memo`, а не вокруг всего токена. Чтобы после mark не
появлялся ложный визуальный пробел, frontend режет excerpt по Unicode-символам
и не вставляет дополнительных separator nodes, padding или rounded caps вокруг
подсветки. Search mark не должен менять метрики текста.

Article/social-card body match excerpt uses normal card preview typography and
clamps to the same 2-3 line footprint as the regular article/social preview.
Search mode may replace preview text only while the query is active; clearing search restores
normal preview rendering.

Semantic-only search excerpts use the same preview typography but do not use
`mark`: highlight is reserved for real lexical/alias/fuzzy text ranges.
Author and URL matches are searchable metadata only: they can return a card
from search, but they do not replace card preview text, do not reveal hidden
URL text and never render `mark`.

### Badge

| Вариант | Стиль |
|---|---|
| `default` | `bg-primary text-primary-foreground` |
| `secondary` | `bg-secondary text-secondary-foreground` |
| `destructive` | `bg-destructive text-white` |
| `outline` | `border text-foreground` |
| `ghost` | `hover:bg-accent hover:text-accent-foreground` |
| `link` | `text-primary underline-offset-4 hover:underline` |

Все бейджи: `rounded-1 px-2 py-0.5 text-sm font-semibold`.

### AlertDialog

Структура: `AlertDialogContent > Header(Title + Description) > Footer(Cancel + Action)`.

| Размер content | Ширина |
|---|---|
| `default` | `max-w-lg` |
| `sm` | `max-w-sm` |

Оверлей: `bg-black/50`. Action с `variant="destructive"` — красная кнопка.

AlertDialog content is a fixed-width surface, not content-sized chrome. Any
body section that contains lists, rows, filenames, card titles or other
untrusted text must keep a complete `min-w-0` chain from content → section →
scroll area/list → row label. Long labels truncate or wrap inside the dialog;
they must never widen the dialog or overlap footer actions.

### DropdownMenu

`DropdownMenuTrigger > DropdownMenuContent > DropdownMenuItem`.

Content: `rounded-1 border bg-popover p-1 text-popover-foreground`, тень — единая для всплывающих элементов (см. «Всплывающие элементы»).
Item: `rounded-1 px-2 py-1.5 text-base cursor-default`.
Item hover/focus uses the active surface swatch: `focus:bg-active focus:text-accent-foreground`. Submenu trigger open state uses the same `bg-active`. Item `variant="destructive"`: красный текст (`text-destructive`), тот же hover/focus фон (`focus:bg-active`).
Width is semantic, not local/ad-hoc. Product components must choose one of the
floating width roles from «Всплывающие элементы» through
`DropdownMenuContent` / `DropdownMenuSubContent` `widthRole`: `command`,
`selector`, `picker`. Raw `w-64` / `w-72` in feature components is invalid
unless it is the implementation of a named role inside the shared menu
primitive.
Trigger ignores modified opening keys: `Cmd`/`Ctrl`/`Alt` +
`ArrowDown`/`ArrowUp`/`Enter`/`Space` must not open a dropdown. Those
combinations remain app/global shortcut candidates even when DOM focus is on a
hidden or hover-only trigger.

### Tooltip

`TooltipTrigger > TooltipContent`.

Content: `rounded-1 bg-foreground text-background px-3 py-1.5 text-sm`. Стрелка: `bg-foreground fill-foreground`. Анимация: fade + zoom при появлении/скрытии.

### Dialog (Detail)

Полноэкранная страница: `absolute inset-0 bg-background`. Занимает весь контейнер поверх сетки, без оверлея. Закрытие: ESC или кнопка.

### Separator

`bg-border`. Горизонтальный: `h-px w-full`. Вертикальный: `h-full w-px`.

### ScrollArea

Кастомный скроллбар: `w-2.5 rounded-full bg-border`. Скроллбары WebKit скрыты глобально.

### ContextMenu

`ContextMenuTrigger > ContextMenuContent > ContextMenuItem`.

Content: `rounded-1 border bg-popover p-1`, тень — единая для всплывающих элементов (см. «Всплывающие элементы»). Item: `rounded-1 px-2 py-1.5 text-base`. Item `variant="destructive"`: красный текст (`text-destructive`), стандартный ховер-фон (`focus:bg-accent`). Поддерживает: CheckboxItem, RadioItem, Sub (подменю), Label, Separator, Shortcut.

### Card Hover Menu

При hover на карточку появляются overlay-затенение и три кнопки.

**Overlay:** `bg-black/40` на всю карточку. Одинаков в обеих темах — затенение контрастирует с любым контентом.

**Кнопки:** стандартные `Button variant="default"` из дизайн-системы (`bg-component-fill`, `rounded-1`). Адаптируются к теме автоматически.

**Расположение:**
- **More** (`MoreHorizontal`, `size="icon"` 32px) — верхний правый угол (`absolute right-2 top-2`)
- **Source** (`ExternalLink`, `size="default"` 32px, текст «Source») — нижний левый угол
- **Connect** (`Plus`, `size="default"` 32px, текст «Connect») — нижний правый угол

**Появление:** `opacity-0 group-hover:opacity-100 transition-opacity`, только
когда текущий interaction owner — pointer. В Grid keyboard mode карточка
получает `hoverEnabled=false`: `group-hover:opacity-100` снимается с overlay,
top `More` и bottom action row, но программное открытие `Cmd+K` всё равно
может показать top `More`/overflow menu.

**Поведение:**
- Parent card открывается по keyboard только когда `keydown` пришёл с самой
  card surface (`event.target === event.currentTarget`); вложенные action
  buttons не должны keyboard-bubble в open Detail.
- `stopPropagation` на контейнере — клик по кнопкам не открывает Detail
- Source: `window.open(url)`. Disabled если `block.url` нет
- Connect: `DropdownMenu` со списком каналов (`CollectionPicker`)
- More / right-click menu: `DropdownMenu` / `ContextMenu` — Connect
  (подменю), Source, Reveal in Finder, Copy Path, Rename…, Disconnect from
  current collection, Delete. Иконки используются только у `Connect` и
  `Source`; остальные строки получают пустой leading-slot той же ширины, чтобы
  текстовая колонка была выровнена по одному уровню. Термин `Remove from
  collection` запрещён для card membership actions — в UI используется только
  `Disconnect`.

### Media Asset Hover Menu

Media Asset Hover Menu — отдельный contract от Card Hover Menu. Он появляется
на конкретном локальном media asset (frontmatter `file` или body embed), а не
на карточке.

**Кнопка:** стандартный `Button variant="default" size="icon"` с
`MoreHorizontal size-4`. Фон непрозрачный `bg-component-fill`; hover-состояние
идёт из базового Button: inset outline `hover:outline-component-fill-hover`.

**Расположение:** `absolute right-2 top-2` относительно прямоугольника самого
media asset.

**Меню:** одно overflow-меню под многоточием. Команды: `Create Card`, `Reveal
in Finder`, `Copy Path`, `Copy Media`, `Rename Media...`, `Remove from Card`,
`Delete`.

Icon economy mirrors card menus: only `Create Card` shows a real icon (`Plus`).
Every other media command keeps the same leading slot empty. Do not render
folder/copy/pencil/trash icons in this menu.

`Create Card` открывает searchable submenu для `Everything` и каналов. Этот
submenu не имеет собственного ограничения высоты: список обязан использовать
общий `QuantizedMenuScrollArea` с `default` row token, как обычный Connect
picker.

**Граница ответственности:** все команды target'ят media file. В этом меню нет
card-level `Source`, card rename, card delete или collection `Disconnect`.

**Видео:** кнопка занимает только top-right corner и не создаёт full-surface
overlay, чтобы не блокировать native video controls.

Article media-only paragraphs:
- A paragraph whose meaningful children are only image/video embeds renders as
  `data-article-media-stack`.
- Stack children are direct `data-detail-media-action-frame` blocks with
  `display: flex`, `width: fit-content` and `1rem` vertical spacing except the
  last item.
- This prevents several Obsidian embeds on one physical markdown line from
  behaving as inline media and wrapping into accidental rows.

CollectionPicker membership rows:
- Search uses the shared `SearchMenuInput` contract: `border-b border-border
  p-1` wrapper plus `Input variant="ghost"` with `rounded-0 px-2 py-0`.
  It is a menu header, not a standalone input pill. This matches
  `Search spaces` and `Search collections`.
- Checkbox не используется.
- Название канала слева остаётся обычным UI-шрифтом.
- Правый slot имеет `w-[10ch]`; connected row всегда показывает кнопку
  `Connected`, а на active row текст замещается на `Disconnect`.
- Unconnected row показывает count по умолчанию; на active row count скрывается
  и появляется `Connect`.
- Active row имеет один source of truth: общий `activeIndex`, который обновляют
  pointer move и ArrowUp/ArrowDown. CSS `:hover` не должен создавать
  второй независимый selected state.
- `Create channel`, когда он показан в Connect picker, считается таким же
  navigable item: `ArrowDown`/`ArrowUp` могут поставить на него active state, а
  `Enter` запускает create-and-assign.
- Pointer enter не меняет `activeIndex`: после keyboard navigation список может
  прокручиваться под неподвижной мышью, и такой synthetic hover не должен
  отбирать выделение у стрелок. Pointer ownership включается только после
  реального `pointermove` с новыми координатами.
- Action button: `h-6 w-[10ch] rounded-1 bg-component-fill px-[1ch]
  font-semibold`, hover/focus outline `outline-1 -outline-offset-1
  outline-component-fill-hover`. Count/action visibility переключается без
  opacity transition, чтобы keyboard navigation не оставляла fade-tail на
  предыдущей строке.
- Видимое состояние `Disconnect` использует destructive button semantics:
  `text-destructive` при той же серой заливке и той же hover/focus outline.
- Клик по action button не должен всплывать в parent row/menu surface.

### Text Selection Action Bar

Detail article prose is the only non-editable surface that supports native text
selection. A valid selection shows one compact horizontal floating action bar
near the first selected rendered Markdown block.

- Left grip: `GripVertical`, 32px hit area, `Button variant="ghost" size="icon"`
  like the close button: no own border, no own fill, muted icon by default,
  foreground only on hover/active. It carries the `dnd-kit` draggable payload
  `type: "text_selection"`. The native highlighted text itself is never a Mine
  drag source.
- `Create Card`: standard `Button size="xs"` with `Plus size-3` inside the bar;
  opens the same searchable channel picker contract as media asset `Create Card`
  (`Everything`, channels, shared `SearchMenuInput`, `QuantizedMenuScrollArea`,
  optional create channel).
- `Delete Text`: destructive `Button size="xs"` with `Trash2 size-3`; removes
  the selected text fragment from the source article, not the source card.
- `Clear text selection`: ghost icon button with `X`, same close affordance
  family as the main grid group-selection bar.
- The bar uses `h-8 rounded-1 border border-border bg-popover px-1 shadow-sm`.
  It is rendered as a `document.body` portal and measured with its real DOM
  size; fixed width constants are fallback only, never the source of truth.
  Its position is centered over the first valid selection rect. If the centered
  position would leave the article safe area, it is clamped by that safe area;
  if there is not enough top room, it flips below the selection.
  It must not appear as a left gutter tab, a vertical rail, or a native
  selection-toolbar clone.

### Feed Card Surfaces

Ordinary feed cards use `bg-card`, not direct `bg-background`. In light theme
`--card = --chrome = oklch(0.99 0 0)`: a half-step surface that matches the top
chrome level and separates cards from the white page quietly. In dark theme
`--card` remains the page background (`oklch(0.1567 0 0)`), so existing dark
card contrast does not change. Do not hardcode one-off card background classes;
change the semantic token if the surface level changes.

### Hover Preview Surfaces

Всплывающие preview-карточки используют ту же визуальную модель, что feed card
preview при drag: `rounded-1` (3px), `border border-border`, `bg-background`,
утилитарная `shadow-lg`. Ordinary feed cards остаются на `--radius-card`.

Related notes preview:
- Trigger row остаётся compact button-shell с `rounded-1 border border-border bg-component-fill`.
- Hover/focus outline trigger row: `outline-1 -outline-offset-1 outline-component-fill-hover`.
- Preview открывается справа от trigger, если хватает места; иначе слева.
- Если preview не помещается вниз, он раскрывается вверх, сохраняя связь с trigger.
- Между trigger и preview есть невидимое hover-поле, чтобы курсор можно было
  перевести без схлопывания.
- При наведении на preview появляются стандартные `Source`, `Connect`, `More`;
  interaction с ними закрепляет preview до outside click.

Article inline image hover preview:
- Это отдельный функциональный блок, не часть текущего Related notes preview.
- Hover/focus outline применяется к wrapper изображения, не к самому `<img>`:
  `outline-1 -outline-offset-1 outline-component-fill-hover`.
- Preview можно показывать только если frontend может сопоставить image
  `src/mediaRef` с реальным extracted media block. Без такого block показывается
  только hover outline, без фальшивой карточки.

### Checkbox

Radix-обёртка: `size-4 rounded-[2px] border border-primary`. Checked: `bg-primary text-primary-foreground` с иконкой галочки. Фокус: `border-foreground`.

### Progress

`h-2 rounded-pill bg-primary/20`. Индикатор: `h-full bg-primary rounded-pill`.

## Всплывающие элементы (floating UI)

ContextMenu, DropdownMenu, Command — три всплывающих компонента с единым
container/radius/spacing standard. Focus surface может отличаться по типу
компонента.

### Контейнер (Content)

`rounded-1 border border-border bg-popover p-1`. Тень единая:

```
shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]
```

SubContent (подменю) — та же тень.

### Ширина

Ширина всплывающих меню задаётся по роли поверхности, а не по месту вызова.
Один общий размер для всех меню запрещён: command menu, navigation selector и
searchable picker решают разные задачи и должны оставаться визуально разными,
но предсказуемыми.

| Role | Surface | Width contract |
|---|---|---|
| `command` | Card overflow, ContextMenu, Theme menu, простые списки команд | `width: max-content; min-width: 12rem; max-width: min(18.75rem, available-width)` |
| `selector` | Top-chrome Space selector, Current collection selector | `width: min(18rem, available-width)` |
| `picker` | `CollectionPicker` / `BatchCollectionPicker` с search input и правым action slot | `width: min(20rem, available-width)` |

`available-width` берётся из Radix collision variables
(`--radix-dropdown-menu-content-available-width` /
`--radix-context-menu-content-available-width`) с viewport fallback
`calc(100vw - 1rem)`. `available-height` берётся из тех же Radix collision
variables и пробрасывается как `--floating-menu-available-height`.

### Высота Scrollable Menu

Scrollable dropdown/search lists не используют произвольный `max-height`
вроде `max-h-72`, `max-h-80` или `20rem`. Высота scroll-зоны должна быть
квантована по строкам:

```
fixed header/footer + list padding + N × rowHeight
```

Скролл живёт внутри списка, а не на всём menu content: search header, pinned
footer/create action и save action остаются fixed siblings. Список рендерится
через `QuantizedMenuScrollArea`, который читает
`--floating-menu-available-height`, вычитает fixed siblings и выставляет
`max-height` как целое число строк. Это запрещает полувидимые/обрезанные rows
в `CollectionPicker`, top-chrome space/collection dropdowns и Clipper menus.

Row tokens:

| Token | Value | Surface |
|---|---:|---|
| `default` | 32px | app dropdown/search rows, `SearchMenuAction`, `CollectionPicker` menu layout |
| `clipper` | 40px | Clipper header/list rows and clipper-sized menu actions |

Визуальная строка и расчёт высоты обязаны брать один и тот же token. При смене
row-height токена нельзя менять только CSS-класс строки или только расчёт
scroll area.

Trigger width не является шириной menu по умолчанию. Его можно использовать
только для select-like surfaces, где popup является прямым продолжением input
или combobox. Для `…`/icon triggers trigger width запрещён: маленькая кнопка не
должна диктовать ширину command menu.

### Shadow DOM portal contract

`DropdownMenu` поддерживает `DropdownMenuPortalContainerProvider`. В обычном
приложении content порталится в `document.body`; в browser clipper overlay
provider обязан передавать shadow-local floating root. Это не отдельная
реализация меню для клиппера, а тот же Radix/shadcn primitive с другим portal
container. Запрещено писать shadow-local самодельные dropdown'ы ради
избежания portal issue.

### Пункты (Item)

`rounded-1 px-2 py-1.5 text-base`. `DropdownMenu` использует
`focus:bg-active`; `DropdownMenuSubTrigger[data-state=open]` использует тот же
`bg-active`. `ContextMenu` и `Command` сохраняют `bg-accent`/selected
поведение.

### Деструктивные пункты

Текст красный (`text-destructive`), фон при фокусе — стандартный DropdownMenu/ContextMenu focus surface (`focus:bg-active` для DropdownMenu, `focus:bg-accent` для ContextMenu). Без красного фона при наведении.

## Web Clipper UI parity

Web Clipper не имеет отдельной визуальной системы. Он использует те же app
primitives и те же состояния, что desktop UI:

- space selector: `MenuTextTrigger` with the top-chrome inner pill state —
  bright plain text trigger, no root button-frame border/fill beyond the row
  surface. In the clipper popup the row is `h-10 bg-accent px-2`; the actual
  Radix trigger is the inner `MenuTextTrigger surface="clipperHeader"` pill
  (`h-6 rounded-1 px-2`), so row padding plus pill padding places the `Mine`
  text at 16px. Chevron sits inside the pill immediately after the space name,
  starts as right-facing, and rotates down on open. The dropdown uses
  `widthRole="selector"`, `align="start"`, and `bg-accent`. The same row owns
  the top-right close action through shared `ChromeCloseButton`, the same
  primitive used by expanded-card chrome;
- clip type switcher: shared `SegmentedControl`; the app uses compact
  `All / Connected`, the clipper uses `size="clipper"` inside a 40px Type row
  (`Type:` on the left, switcher on the right). The row uses `bg-chrome`; the
  switcher uses `h-8`, inner `h-7`, `p-[2px]`, `text-base`, and
  shrink-to-content width, never stretched full-width;
- lower body: after the two top rows, the clipper keeps the legacy simple body:
  `.mine-clipper-body` owns the spacing tokens in `popup-layout.css`.
  `--mine-clipper-after-type-gap` is 16px only between Type row and the first
  preview card; `--mine-clipper-section-gap` is 8px for every lower separation:
  preview -> channel picker -> save/status stack and screenshot media ->
  screenshot actions. If Type row is hidden, the top body inset also falls back
  to the 8px section gap.
  Do not convert this lower body into edge-to-edge bars unless the full
  clipper contract is redesigned again;
- screenshot preview: legacy local card, `rounded-1 border border-border
  bg-accent`, image `max-h-[220px] w-auto max-w-full rounded-1 object-contain`;
- screenshot actions: `Button size="sm"` (28px), not `clipper`;
- channel picker: no clipper-only checkbox/search implementation. The clipper
  renders the same desktop `CollectionPicker` default menu layout inside an
  inline picker surface with the same visual tokens as floating picker content:
  `bg-popover text-popover-foreground flex max-h-80 flex-col overflow-hidden
  rounded-1 border p-0 shadow-md`. Use
  `COLLECTION_PICKER_CONTENT_CLASS` / `COLLECTION_PICKER_INLINE_SURFACE_CLASS`
  from `CollectionPicker`; do not restate picker geometry in clipper code.

Any clipper-only component that duplicates an app primitive visually is design
debt. The permitted form is a thin adapter over the app primitive when the
desktop component itself depends on Tauri-only APIs. Current shared primitives
that exist specifically to prevent drift: `MenuTextTrigger` and
`SegmentedControl`.

## Состояния Drag-and-Drop

| Состояние | Стиль | Утилита |
|---|---|---|
| Перетаскивание | Полупрозрачный элемент | `opacity-30` |
| Sidebar channel drop target | Тот же row focus-mode, что обычный hover строки | `data-sidebar-row-focus-mode` + `data-sidebar-row-focused` |
| Изолированная drop target surface | Подсветка рамкой | `ring-2 ring-ring ring-inset` |

### DropZone (внешний file drop)

Оверлей при перетаскивании файлов из Finder. Не перекрывает тулбар и action bar — живёт между ними (`top-8 bottom-8`).

| Элемент | Светлая | Тёмная | Утилита |
|---|---|---|---|
| Бэкдроп | `--glass-bg` (белый 80%) | `--glass-bg` (тёмный 60%) | `bg-glass` |
| Пунктирная рамка | `--border` (oklch 0.95) | `--muted-foreground` (#888) | `border-border dark:border-muted-foreground` |
| Карточка | Как AlertDialogContent | Как AlertDialogContent | `bg-background border border-border rounded-1 p-6 shadow-lg` |
| Ошибка | `--destructive` + белый текст | `--destructive` + белый текст | `bg-destructive text-white` |

Пунктирная рамка: `border border-dashed`, отступ 8px от краёв оверлея (`inset-2`), скругление 4px (`rounded-[4px]`). Показывается только при drag over, не при importing/error.

## Disabled

Все отключённые элементы: `opacity-50 cursor-not-allowed pointer-events-none`.

## Макет

### Тулбар

`<header>`: `h-8 border-b border-border bg-chrome`, `data-tauri-drag-region` для
пустых зон перетаскивания окна. Высота строго 32px. Интерактивные элементы
внутри top chrome не выключают drag целиком: они используют общий threshold
gesture (`4px`) — короткий жест остаётся click/focus, движение за порог
запускает native window drag и гасит последующий click.
Traffic-light reserve размечается как `data-traffic-light-reserve`, имеет
ширину `80px`, наследует тот же surface, что и top chrome, и не содержит
интерактивных DOM-кнопок. Видимость inactive native traffic lights управляется
только AppKit-слоем, не CSS.

### Нижняя панель действий (Action Bar)

`h-8 bg-accent border-t border-border px-8`. Отступы 32px с обеих сторон.
Правая часть остаётся свободной для transient status text вроде `Syncing…`;
глобальной Search-кнопки в нижней панели нет.

Компонент `ActionButton` — двуслойная кнопка (две «пули»). Использует токены `--component-fill-*`, изолированные от поверхностей.

- Структура: `<div role="button">` (внешняя пуля) → `<span hotkey>` + `<span label>` (внутренняя пуля)
- Внешняя пуля: `rounded-1` (3px), `h-6` (24px), `p-[2px]`, `overflow-hidden`
- Внутренняя пуля: `rounded-[2px]`, `bg-component-fill-inner`, `h-5`, `inline-flex items-center`, `px-[1ch]`, `leading-none`
- Hotkey: текст на фоне внешней пули, `h-5`, `inline-flex items-center`, `px-[1ch]`, `leading-none`
- Зазор между внешней и внутренней пулей: 2px (все стороны, через `p-[2px]` на внешней)
- Шрифт: `font-mono text-sm`
- `forwardRef<HTMLDivElement>` для программного управления

Размеры: внешняя — 24px (`h-6`), внутренняя — 20px (`h-5`, 24 - 2×2px зазора).
Вертикальное центрирование фиксируется высотой inner text boxes, а не `py`, чтобы
метрики monospace-шрифта не давали оптический сдвиг в 1px.

Состояния:

| Состояние | Внешняя пуля | Хоткей | Внутренняя пуля |
|---|---|---|---|
| Покой | `bg-transparent` | `text-foreground` | `bg-component-fill-inner text-foreground` |
| Hover | `bg-component-fill-hover` | `text-foreground` | без изменений |
| Selected | `bg-component-fill-hover` | `text-foreground` | без изменений |

Кнопки:

| Hotkey | Label | Действие | Положение |
|---|---|---|---|
| ⌘⇧O | Space selector | Выбор папки через нативный диалог | top chrome |
| ⌘⇧N | New Channel | Инлайн-инпут в сайдбаре | слева |
| ⌘, | Settings | DropdownMenu переключения темы, compact Detail, chrome surface variant и bottom menu visibility | слева |
| ⌘[ / ⌘] | History | Назад / вперёд по истории страниц | глобально |

### Сайдбар

Есть один layout width mode: compact/non-compact по ширине сайдбара (порог
320px). Экспериментальный channel card display mode удалён; Settings не
содержит переключатель `Rows` / `Cards`.

#### Полный режим (width >= 320px)

Три колонки в каждой строке.

| Колонка | Содержимое | Ширина |
|---|---|---|
| Левая | Название канала | `min-w-[100px] max-w-[150px] flex-1` |
| Центральная | Превью-карточки | `flex-1 min-w-0`, `h-8 overflow-hidden` |
| Правая | Счётчик + действия | `w-8 text-right` |

Шрифт названий: `font-sans text-base` (14px). Счётчики справа:
`font-mono text-sm text-right`. Строки разделены
`border-b border-sidebar-border`. Паддинги навигации: `px-8 pt-8`;
строки в полном режиме не имеют собственного горизонтального padding, чтобы
названия каналов, правые счётчики и link-editor action buttons стояли
заподлицо с краями navigation column. Это отдаёт свободную ширину центральной
полосе preview-карточек. Для визуальной компенсации glyph side bearings label
text получает `translate-x-px`, а правый count text получает `-translate-x-px`;
это не меняет layout box и не влияет на preview-strip ширину.
Top inset 32px должен жить на scroll-container (`data-sidebar-scroll`), а не в
отдельной фиксированной header-плашке: если header slot (например iCloud
conflict banner) ничего не рендерит, он не должен оставлять пустой блок над
списком.

Превью-карточки: `size-8 object-cover`, `gap-1` (4px). Strip использует
одну постоянную CSS mask, без дополнительных overlay-слоёв. Fade имеет
физическую ширину `24px` от правого края. Это не процент от ширины strip, поэтому
защитная область одинаковая на главной и в Detail. После fade у strip есть
чистый прозрачный tail, чтобы суммарная protected area от конца fade до
правого края строки была `92px` (`Connect/Connected` ширина `80px` +
`8px` gap до линии + `4px` прозрачный буфер). Внутри самих `24px`
используется multi-stop alpha-кривая,
чтобы справа не было визуального «разгона» градиента и чтобы контент
полностью растворялся перед зоной абсолютной action button. В row-mode у
sidebar list есть две общие continuous vertical guide lines: левая на
`150px` от начала content area и правая на `88px` от правого края content
area: `80px` ширина `Connect/Connected` + `8px` gap до кнопки. Это не
обрывки по строкам. Между левой направляющей и первой миниатюрой обязателен
`4px` inset. В точке правой направляющей превью уже должно быть полностью
растворено; последние `4px` перед этой линией — прозрачный запас. Текстовые
thumbnail (PNG с прозрачным фоном) обёрнуты в
`bg-accent` + `dark:invert`. Видео-блоки показывают первый кадр (H.264
декодирование через OpenH264).
Title text использует тот же right-fade mask contract, что и preview strip:
`24px` fade + `4px` прозрачный tail перед левой направляющей. Это не
`text-overflow: ellipsis`. Responsive contract двуступенчатый: пока ширина
сжимается, сначала деградирует central preview rail; только когда rail
упирается в минимум, начинает сужаться title slot в диапазоне `100–150px`.

#### Compact-режим (width < 320px)

Две колонки: название + счётчик. Без карточек-превью.

| Колонка | Содержимое | Ширина |
|---|---|---|
| Левая | Название канала | `flex-1 truncate` |
| Правая | Счётчик + действия | `w-8 text-right` |

Шрифт названий: `text-base` (14px), без `font-mono`. Правый счётчик:
`font-mono text-sm text-right`. Стиль shadcn SidebarMenuButton: `rounded-1
p-2`. Без разделительных линий. Channel rows не получают фонового выделения на
hover/active; текст участвует в общем sidebar row focus-mode contract.

#### Общее

Ширина по умолчанию: 300px. Диапазон ресайза: 220–600px. Порог сворачивания: 100px. Паддинг строки в полном режиме: `py-1` (4px), без `px-*`.
App shell keeps the right/main pane at a minimum of `304px`: `240px` metadata
card minimum plus two `32px` side insets. Desktop `minWidth` is `904px`
(`600px` max sidebar + `304px` min right pane).

Обычные строки sidebar не заменяют счётчик hover-действиями: правый `w-8`
slot всегда показывает count в `font-mono`. Rename/Delete доступны через
`ContextMenu` строки, а не через hover-многоточие.
Sidebar navigation rows, включая `Everything` и каналы, не используют
`hover:bg-*`, `bg-sidebar-accent` или `text-sidebar-accent-foreground`: выбор
маршрута отражается состоянием приложения, но не визуальной плашкой строки.
Обычный count slot не меняется по hover.

Row focus-mode:
- Без hover/focus все row labels и counts используют `text-muted-foreground`.
- Текущий выбранный route (`Everything` или активный канал) всегда использует
  `text-foreground`.
- Когда курсор или keyboard focus находится внутри строки, sidebar получает
  `data-sidebar-row-focus-mode="true"`.
- Focused row становится `text-foreground`, остальные row labels/counts
  остаются `text-muted-foreground`.
- Активный route остаётся `text-foreground`, даже если focus находится на
  другой строке.
- Thumbnail strips и preview cards вообще не участвуют в этом state и
  остаются визуально неизменными.
- Drag-over карточки, inline-media или выделенного фрагмента над channel row
  использует тот же row focus-mode, что hover: без отдельной ring-рамки,
  outline, inset или legacy drop-highlight.
- Вход/выход из focus-mode анимируется `180ms cubic-bezier(0.22, 1, 0.36, 1)`.
  Переключение между строками внутри уже активного focus-mode идёт мгновенно
  через `data-sidebar-row-switching="true"` на один animation frame.

#### Link-editor режим (Detail открыт)

Когда открыта карточка, sidebar превращается в редактор связей этой карточки с
каналами. `Everything` остаётся обычным пунктом навигации с общим счётчиком и
без checkbox. Список строк каналов использует ту же геометрию, что обычный
sidebar.

Top inset списка в раскрытой карточке не меняет геометрию обычного sidebar.
Основной shell использует второй top-bar level (`h-8 border-b border-border`)
с отдельными sidebar/content сегментами; сам sidebar scroll-content всегда
использует `pt-8` (32px). В expanded главной это даёт общий visual top offset
64px: второй bar 32px + content inset 32px. Когда Detail открыт в
non-compact shell, второй bar становится Detail/link-editor chrome: в sidebar
segment живёт `Channels:` + `All / Connected`, в content segment — filename,
overflow и close. Body-level `absolute inset-x-0 top-0 h-8` overlays для
Sidebar/Detail в App shell запрещены: они создают третий слой под вторым bar.

Верхняя surface:

| Surface | Geometry |
|---|---|
| Main secondary top bar | `h-8 border-b border-border bg-background`, split sidebar/content |
| Detail/link-editor secondary bar | тот же second-level bar, `bg-accent`; sidebar segment `px-8 gap-2`, content segment `px-8 gap-3` |

Если включён `Chrome surfaces variant 2`, эта таблица меняется только по
surface: permanent top chrome остаётся `bg-accent`, а оба second-level bar
состояния используют `bg-chrome`.

Non-compact Detail close не должен распадаться на несколько визуальных шагов.
Второй top-bar level держит два абсолютных слоя внутри тех же sidebar/content
segments: main statistics layer (`data-main-secondary-main-layer`) и
Detail/link-editor layer (`data-secondary-sidebar-link-mode-bar`,
`data-secondary-detail-top-menu`). Surface bar привязан к entered-state
Detail-layer, а не к наличию closing snapshot: как только close начинается,
bar сразу переходит в main surface, Detail controls уходят через
`opacity + translateY(-8px)`, а statistics layer возвращается через
`opacity + translateY(6px)`. Snapshot открытой карточки остаётся только для
анимации текста/кнопок; он не удерживает `bg-accent` после начала закрытия.
Обычный non-compact close использует короткий shell-exit budget около `190ms`;
compact Detail top chrome сохраняет отдельный `260ms` budget, потому что там
анимируются элементы permanent top chrome.

В main/Grid state второй top-bar level — тихая информационная строка, а не
навигация и не toolbar. Она показывает статистику текущего пространства и
текущего канала без кнопок, иконок, плашек, hover-состояний и внутренних
вертикальных разделителей.

Левая часть использует компактный англоязычный metadata contract:
`1 466 files    260 .md    1 204 media    4,8 GB`. `files` — полный
физический счётчик файлов в source vault, включая Markdown, media, остальные
файлы, скрытые и служебные файлы. Точка не рисуется отдельным separator:
она является частью label `.md`, как расширение файла; промежутки задаются
layout gap. Правая часть пишет `cards` только для `Everything`; в конкретном
канале строка получает уточнение `cards in channel`.

Art direction: это ambient metadata, а не dashboard. Строка должна считываться
как часть системного chrome: ровная, низкоконтрастная, без KPI-акцента и без
визуального соревнования с карточками. Запрещены icons, badges, bold numbers,
colored deltas, cards, pills, uppercase labels и отдельные hover/focus states.

Левый segment (`data-main-secondary-top-bar-sidebar-segment`) показывает
статистику пространства и выравнивается с колонкой Sidebar: `px-8`, `h-full`,
`items-center`, `overflow-hidden`. Текстовый режим:
`font-mono text-sm text-tertiary-foreground leading-none`, regular weight.
Строка собирается как spacing-only inline cluster:
`260 .md    1 204 media    4,8 GB`. Между показателями нет отдельной пунктуации,
иконок или вертикальных разделителей; группы разделяет только стабильный
`gap-5`. Названия показателей не выделяются жирным; числа и слова находятся в
самом слабом текстовом уровне, потому что это secondary metadata, а не KPI.

Текстовый контракт левого segment:

- Markdown files: compact label `.md`, пример `260 .md`
- Media files: compact label `media`, пример `1 204 media`
- storage size без дополнительного слова `used`: `4,8 GB`, не `used 4,8 GB`

Числа форматируются по `ru-RU`: группировка пробелами, десятичная запятая.
Storage units — compact decimal units: `B`, `KB`, `MB`, `GB`, `TB`.
Для значений меньше `10` в текущей единице показывается один десятичный знак
(`4,8 GB`), дальше целое значение (`18 GB`).

Правый segment (`data-main-secondary-top-bar-content-segment`) показывает
количество карточек в текущем route scope и выравнивается по левой оси
контентной области: `px-8`, `justify-start`, `font-mono text-sm
text-tertiary-foreground leading-none`. Текст: `260 cards`. В `Everything`
это количество всех карточек, в канале — количество карточек, прикреплённых к
этому каналу. Search/filter state не меняет этот счётчик: это статистика
канала, а не количество видимых результатов.

Текстовый контракт правого segment:

- `1 card`, otherwise `cards`
- `0 cards` для пустого канала
- никаких labels вроде `Cards:` или имени канала; контекст уже задан route
  title в permanent top chrome

Responsive contract: строка не переносится и не меняет высоту. Если левому
segment не хватает ширины, показатели скрываются справа налево по приоритету:
сначала storage size, затем media count; Markdown count остаётся последним.
Нельзя частично обрезать число или слово внутри одного показателя. В collapsed
Sidebar state левый statistics cluster скрывается целиком, segment остаётся
пустой drag region. Правый count остаётся на левой оси content segment; на
экстремально узкой ширине он может truncate только как единый текстовый блок.

Realtime contract: обновление статистики не анимирует числа и не показывает
loading/skeleton text. Пока snapshot не загружен, segment рендерит пустое место
на той же геометрии. После backend event строка меняется атомарно в следующий
React commit; запрещены промежуточные `calculating`, `rendering layout` и
прочие служебные сообщения в chrome.

Содержимое surface: `Channels:` + selector `All / Connected`. `Channels:`
использует `font-mono text-sm text-muted-foreground`. Selector повторяет
ActionButton geometry: outer `h-6 p-[2px] rounded-1`, segments `h-5
px-[1ch] rounded-[2px] text-muted-foreground`. Hover заливает только outer
control через стандартный `hover:bg-component-fill-hover`; активный segment
использует `bg-component-fill-inner text-foreground`.

Если включён Compact Detail top menu, эта link-editor surface не рендерится:
тот же `All / Connected` state показывается внутри permanent top chrome
Sidebar/search segment, без подписи `Channels:`.

Detail article/metadata layout использует right-anchored fixed-rail contract:
`grid w-full
grid-cols-[minmax(2rem,1fr)_minmax(400px,48rem)_minmax(2rem,1fr)_20rem_2rem]`.
Metadata/Connected Cards rail стоит перед правой колонкой `2rem`, то есть
имеет фиксированный `32px` inset от правого края. Ширина rail фиксирована:
`20rem` (`320px`) для статей, фото и видео. Article/media column стоит в
`col-start-2`, имеет минимальную комфортную ширину `400px`, ограничен `48rem`
и центрируется в оставшемся пространстве слева от rail. Тело карточки не
добавляет локальный `pl-*` guard; дистанцию между текстом и metadata задаёт
grid.

Если реальная ширина Detail-контейнера становится меньше `816px`
(`400px` article minimum + `320px` rail + три grid inset по `32px`), layout
переключается в stacked mode: grid становится
`grid-cols-[2rem_minmax(240px,1fr)_2rem]`, article/media column остаётся
центрированной с `max-w-[48rem]`, а metadata/Connected Cards больше не fixed
rail и рендерятся отдельным full-width row под основным контентом в scroll
flow.

Metadata card keeps `min-width: 240px`, so the bottom `Source` / `Connect`
button row cannot compress below the buttons' intrinsic content.

Motion contract: верхний chrome в Detail и sidebar link-editor surface входят и
выходят через мягкий `opacity + translateY` transition с тем же темпом
(`220–280ms`, `cubic-bezier(0.22, 1, 0.36, 1)`). Close не должен блокировать
возврат к grid: страница закрывается мгновенно, а exit дочёркивается отдельным
неблокирующим chrome overlay.

`Connect`/`Disconnect` row actions не ждут closing-анимацию верхнего chrome:
при `detailChromeClosing` строки сразу возвращаются в обычный sidebar mode, а
closing snapshot остаётся только у верхнего link-editor chrome.

Membership action behaviour: checkbox в link-editor не используется. Клик по
строке канала навигирует как обычный sidebar item; только прямой click/key по
правой action button меняет membership. Count остаётся в обычном правом
layout slot `h-8 w-8`; action button рисуется абсолютным overlay поверх строки
и не участвует во flex-раскладке preview strip. В link-editor яркость sidebar
rows больше не следует route/hover contract: `text-foreground` получают только
уже связанные каналы, все остальные строки остаются `text-muted-foreground`.
Для уже связанного канала
overlay всегда показывает серую кнопку `Connected`; на hover/focus строки текст
замещается на `Disconnect`. Для несвязанного канала slot по умолчанию
показывает count; на hover/focus count скрывается и появляется `Connect`.
Action button: `absolute right-0 top-1/2 -translate-y-1/2 z-10 h-6 w-[10ch]
rounded-1 bg-component-fill px-[1ch] font-semibold`, hover/focus outline
`outline-1 -outline-offset-1 outline-component-fill-hover`.
Видимый текст `Disconnect` использует `text-destructive`; `Connected` и
`Connect` остаются `text-foreground`.

CollectionPicker inside card/Detail menus follows the same row action visual
model but keeps sidebar taxonomy order exactly as provided. Connected/recent
state never reorders rows while the menu is open. Search uses shared
`SearchMenuInput`: a flat ghost menu-header row behind `border-b`, without a
separate rounded input frame. Active keyboard item uses `bg-active`, hides the
row count, and reveals the right action button. `ArrowUp` /
`ArrowDown` move across rows and the conditional create action, `Enter` runs
the visible `Connect`/`Disconnect` or create action, and `Escape` from a
submenu returns to the parent `Connect` item instead of closing the whole
overflow menu.
Pointer and keyboard navigation share the same `activeIndex`: moving the mouse
selects that row, pressing arrows transfers ownership back to keyboard, and
there is never a simultaneous pointer hover and keyboard hover. Right-slot
visibility changes are immediate, without opacity transition.
CollectionPicker menu content uses floating width role `picker` (`20rem` with
available-width cap). Its scrollable list is not capped by a raw rem value:
`QuantizedMenuScrollArea` computes the visible list height as whole `default`
rows after subtracting the search header and any fixed footer from the Radix
available height. The `20rem` role width is required because the right action
slot is fixed at `10ch`; narrower menus leave too little scan width for Russian
collection names. The ordinary Card overflow menu around it remains role
`command`.
Keyboard-triggered scroll cannot transfer ownership to a stationary pointer:
rows ignore `pointerenter` and ignore the first post-keyboard `pointermove` if
its coordinates match the last known pointer position. Pointer hover never
calls `scrollIntoView`; only keyboard-owned active row may auto-scroll.
Slot сохраняет `h-8` vertical centering. Count не должен прыгать при появлении
action button.

Batch Connect must reuse the same CollectionPicker row/search/action language
through `BatchCollectionPicker`, not a separate hand-styled list. Batch changes
only membership semantics: all selected cards connected -> `Disconnect`;
otherwise -> `Connect`; no partial selected-card counters like `1/3`.

Stable preview invariant: обычный sidebar и link-editor используют один и тот
же row component и один thumbnail strip. При открытии карточки нельзя
размонтировать строки каналов или `<img>` thumbnail'ы; меняется только правый
row-action slot (`count/menu` ↔ `Connected/Connect/Disconnect`). Это убирает blink превью при
переключении в Detail.

### Сетка

Masonry с round-robin распределением по колонкам. Gap: 32px (`--spacing-s5`). Минимальная ширина карточки: 220px; максимальная ширина не фиксируется токеном и определяется алгоритмически перед переходом к следующему числу колонок. Лента должна ощущаться как бесконечный canvas: scroll может быть быстрым, но медиа не должны появляться заметными рывками после входа карточки во viewport.

Performance contract не сводится к увеличению DOM window. Grid использует
отдельные адаптивные бюджеты для render window, image priority window и planned
media preload/decode window. Целевой scroll-readiness контракт описан в
[SPEC_FEED_SCROLL_PERFORMANCE.md](SPEC_FEED_SCROLL_PERFORMANCE.md): bounded
DOM window, eager-зона для ближайших картинок и более широкий preview-only
`Image.decode()` preloader без дополнительных mounted cards и без original
source media в hot scroll path.

Top inset ленты на главной: 64px от permanent top chrome до верхнего края
masonry layout складываются из второго shell top-bar level `h-8` и внутреннего
virtual layout inset `32px` через `marginTop`. Inset живёт на внутреннем
virtual layout, а не на scrollport.

Паддинги сетки: 32px по бокам (при развёрнутом сайдбаре), 72px (при свёрнутом — компенсация ширины).

Пустой канал показывает только текстовый placeholder, без card surface, quote
marker, border, иконок или CTA-кнопок. Placeholder центрируется в видимом
viewport Grid и оформляется как plain italic text: `p`, `text-center`,
`text-base italic text-muted-foreground`. Текст: `Cards connected to this
channel will appear here.` Для `Everything` и пустой search выдачи этот
placeholder не показывается.

Карточки: `border border-border`, без скругления (`rounded-0`). Обводка = +1 уровень к фону. Hover не меняет frame карточки: без смены цвета рамки, второй линии, тени, glow, inset overlay или transition. Hover-affordance карточки — только action controls. Keyboard/focused state принадлежит GridItem, не Card: focused item получает `data-feed-grid-item-focused="true"`, а существующий Card frame меняет border color на тот же token, что left sidebar row focus seam — `var(--border-accent)` — с тем же `180ms cubic-bezier(0.22, 1, 0.36, 1)` transition. Без card-frame overlay, extra line, ring/glow или `foreground` border; Card не получает focus props/classes.

Grid поддерживает один interaction owner: `keyboard` или `pointer`.
Arrow-навигация переводит ленту в keyboard mode и отключает CSS-hover affordance
карточек (`hoverEnabled=false` у CardHoverMenu), поэтому неподвижный курсор не
может одновременно подсветить другую карточку. Реальное движение pointer с
новыми координатами возвращает pointer mode; stationary pointermove после
keyboard-scroll игнорируется.

Overflow menu, opened from focused-card `Cmd+K`, pins its anchor visuals while
the menu is open: the anchor keeps `data-feed-grid-item-focused`, `⌘K` badge,
frame focus and graphic wash even after pointer movement switches Grid back to
pointer mode. This pin is visual only; pointer hover works on other cards. The
pinned anchor keeps `CardHoverMenu.hoverEnabled=false`, so bottom hover actions
do not appear under an open keyboard menu.

Графические поверхности карточек помечаются единым `GraphicSurface`/`data-card-graphic-surface` контрактом. При keyboard focus GridItem применяет только к этим surfaces дополнительный wash: light theme `oklch(0 0 0 / 14%)` затемняет, dark theme `oklch(1 0 0 / 18%)` высветляет. Текстовые карточки и текстовые области mixed cards не получают этот state.

Focused GridItem дополнительно показывает shortcut badge в левом верхнем углу: `data-feed-grid-action-badge`, внутри `data-feed-grid-action-layer` (`absolute inset-px`), затем `absolute left-2 top-2`, `h-6`, `px-[1ch]`, `rounded-1` (3px), `bg-component-fill`, `text-sm font-semibold text-foreground`, `pointer-events-none`. Action layer компенсирует 1px Card frame, поэтому offsets badge считаются из той же внутренней плоскости карточки, что и Card Hover Menu controls: `top-2` как у верхнего `More`, `left-2` как у нижнего action row. Текст badge — `⌘K`; он сообщает scoped action shortcut для открытия card overflow menu и не является hover affordance. `Cmd+K` toggles top-right `More`/overflow menu; нижние `Source`/`Connect` не появляются.

Group-selected GridItem показывает индивидуальный selected frame, не цветной
system-selection outline. Contract: `data-feed-grid-item-selected="true"` на
GridItem, sibling overlay `pointer-events-none` вне clipped card layer,
external frame `inset: -3px` — это 2px frame + 1px gap снаружи карточки,
`box-shadow: inset 0 0 0 2px var(--feed-selection-frame)`. Token:
`--feed-selection-frame: oklch(0.145 0 0)` в light theme и
`oklch(0.985 0 0)` в dark theme. Рамка
рисуется без скруглений вокруг каждой выбранной карточки, а не вокруг всей
selection area, не меняет masonry layout и должна быть сильнее hover/focus.

Marquee selection rectangle принадлежит Grid и рисуется только во время
empty-area drag внутри `data-grid-layout`: `data-feed-grid-marquee-selection`,
`border-radius: 0`, `pointer-events: none`, fill из design-system surface +2
`--active` (`color-mix(in oklch, var(--active) 72%, transparent)` для
читаемости поверх контента), border из surface +3 `--border`. Без glow, blur,
gradient, shadow или цветных selection-токенов.

Group selection bottom action island появляется при `selectedSlugs.size >= 1`:
absolute внутри main/content pane, центрирован по правой рабочей области
(`bottom-s3 left-1/2 -translate-x-1/2`), `h-8`, `rounded-1 border border-border
bg-accent text-foreground px-1`, compact horizontal layout, horizontal
overflow when content does not fit, без внутренних разделителей, прозрачности,
blur, glow/gradient. Островок не зеркалит тему, а остаётся в обычной
surface-иерархии приложения. Secondary text внутри островка использует
Detail-top-bar typography: `font-mono text-sm`, regular weight, no
`font-semibold`, with `text-muted-foreground`. Прямые Button actions используют
стандартные design-system `Button` variants: `Connect`/`Disconnect` —
`default`, `Delete` — `destructive` (`bg-component-fill text-destructive`).
Порядок внутри островка: серое русское количество
(`1 карточка`, `2 карточки`, `5 карточек`, `25 карточек`), прямые Button
actions `Connect`, text-only `Disconnect` только внутри collection route,
text-only red `Delete`, затем rightmost icon-only `X` clear button. Полный
контракт:
[SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md).

Focused-card batch `Cmd+K` menu следует тому же icon economy: иконка есть у
`Connect`, у `Disconnect` и `Delete` иконок нет, но сохраняется пустой
leading-slot для выравнивания текста.

Group drag preview использует macOS-style drag flocking: каждый видимый слой —
реальный frozen card preview из selected set, не пустая plate и не interactive
`Card`. До четырёх слоёв видимы; полный payload остаётся в `dragSlugs`, а при
переполнении показывается count badge. Front card не трансформируется; back
cards используют только integer `translate3d` + малые углы:
`-6/-6/-0.9deg`, `7/-11/0.75deg`, `-2/-16/-0.45deg`. `scale(...)` запрещён.
Stack не вводит новые радиусы и не двигает реальные masonry cards; bottom
action island скрыт во время block drag.

Article-карточки в ленте используют дополнительную surface-заливку только в тёмной теме: `feed-article-card` применяет `background: var(--accent)` при `data-theme="dark"` или системной dark theme, если не выбран `data-theme="light"`. В светлой теме article-карточка остаётся на стандартном `bg-background`.

Expanded image preview использует минималистичное разделение primary/secondary plane: фон страницы становится вторичным через `background: rgb(0 0 0 / 0.56)` и `backdrop-filter: saturate(0.55)` без blur; foreground image получает только утилитарное отделение `box-shadow: 0 24px 96px rgb(0 0 0 / 0.45)` и `outline: 1px solid rgb(255 255 255 / 0.08)`. Кнопка выхода из preview — не `X`, а inward-arrows `Minimize2` с действием `Collapse image preview`.

## Архитектурные принципы

- **Монохром** — палитра строго чёрно-белая с оттенками серого. Цвет только для семантики: `destructive` (красный), `chart-*` (графики)
- **Тёмная тема по умолчанию** — светлая через `@media (prefers-color-scheme: light)`. Тёмно-серый фон (#0C0C0C, sRGB 0.049)
- **Без теней и градиентов** — исключения: hover-оверлей на карточках изображений (`bg-gradient-to-t from-black/60`), утилитарная тень всплывающих элементов (для отделения слоя от контента)
- **1px solid borders** — основной визуальный разделитель. Без двойных линий, пунктиров, инсетов
- **Нативное ощущение** — `-webkit-user-select: none` на кнопках и навигации, `overscroll-behavior: none`, скрытые скроллбары WebKit
- **Resize handle без выделения** — sidebar resize gesture блокирует WebKit
  text selection уже на `pointerdown`: `body.sidebar-resizing`,
  `preventDefault()`, clear `document.getSelection()`, transparent
  `::selection`.
- **Variable-шрифты** — один файл WOFF2 на все насыщенности (100–900), `font-display: swap`

## Рендеринг

- **Antialiased** — `body` задаёт `-webkit-font-smoothing: antialiased` и `-moz-osx-font-smoothing: grayscale` для соответствия нативному рендерингу macOS
- **Скрытые скроллбары** — `.overflow-y-auto::-webkit-scrollbar { display: none }` глобально
- **Мгновенная навигация** — без `scroll-behavior: smooth`, переходы между каналами происходят мгновенно

## Brand Identity

Текущий знак Mine — строчная `m` из Redaction 100 Italic. Это единственный
актуальный logo/glyph variant в системе; сравнительные матрицы и альтернативные
wordmark-пробы не являются частью продукта.

Иконки не масштабируются одним bitmap'ом на все поверхности. У каждой поверхности
свой контракт:

| Поверхность | Asset contract |
|---|---|
| iOS app icon | Белый квадратный source asset; скругление и mask применяет iOS. В source-файле не рисуется собственная рамка или тень |
| macOS/Tauri app icon | Прозрачный canvas с inset white rounded tile и чёрной `m`, чтобы Dock не показывал oversized белый квадрат |
| Browser extension toolbar | Transparent square PNGs `16/24/32/48/128`; внутри inset white circle и чёрная `m`, без оранжевого фона и без app-like squircle |
| Instagram feed overlay | Белая круглая кнопка поверх поста; внутри отдельный glyph-only asset `clipper-overlay-32.png`, а не toolbar/app icon |

## Расширение (браузерный попап)

Попап расширения — проекция основного приложения в браузер. Собирается через Vite (`vite.extension.config.ts`), импортирует те же компоненты и токены через алиас `@/`.

### Что общее

- **CSS-токены** — `@import "@/styles/global.css"` в `popup-layout.css`
- **Шрифты** — Geist и Geist Mono (WOFF2 копируются в `dist/fonts/`)
- **Компоненты** — `<Button>`, `<Input>`, `<ScrollArea>` из `@/components/ui/*`
- **Утилиты** — `cn()` из `@/lib/utils`
- **Цвета** — все семантические токены (`--foreground`, `--muted-foreground`, `--border`, `--accent`)
- **Скругления, отступы, типографика** — из общей шкалы

### Что отличается

| Аспект | Основное приложение | Расширение |
|---|---|---|
| Размер окна | Полноэкранное | 360x600px (popup) |
| Layout | Sidebar + Grid + Detail | Компактная форма (preview + channels + save) |
| Навигация | react-router, стрелки, scoped card/Detail Cmd+K | Нет — одно состояние |
| IPC | Tauri commands | Native messaging (`chrome.runtime.sendNativeMessage`) |
| CSS entry | `global.css` | `popup-layout.css` (импортирует `global.css` + добавляет popup-размеры) |

### Popup-специфичные стили

```css
/* popup-layout.css */
@import "@/styles/global.css";
body { width: 360px; min-height: 200px; max-height: 600px; overflow-y: auto; }
```

Никаких собственных токенов, цветов, шрифтов или компонентов. Дрейф дизайна невозможен — единственный источник правды в `global.css`.
