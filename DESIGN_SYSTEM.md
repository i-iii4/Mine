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
| +1 | `--accent` | 0.98 | 0.1815 | Hover фон, action bar |
| +2 | `--sidebar-accent`, `--active` | 0.965 | 0.2063 | Legacy/sidebar surface, нажатие |
| +3 | `--border` | 0.95 | 0.2311 | Границы, разделители |

**Шаг от accent:** светлая тема — 0.015, тёмная — 0.0248.

**Примечание:** токены `--muted`, `--secondary` имеют то же значение, что и `--accent` (для совместимости с shadcn). В коде используем только `bg-accent`.

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

Локальное исключение для hover/focus separator state в sidebar:

| Токен | Светлая | Тёмная | Где |
|---|---|---|---|
| `--border-accent` | oklch(0.145 0 0 / 12%) | oklch(0.985 0 0 / 16%) | Hover/focus color для sidebar row separator |

**Правило:** по умолчанию все линии используют `--border`. `--border-accent`
разрешён только для состояния hover/focus у sidebar row separator, где линия
должна слегка поддержать bright text, но не спорить с ним. Реализация должна
идти через один и тот же separator system: каждая строка владеет только своей
нижней seam line, а hover/focus перекрашивает seam текущей и предыдущей
строки. Так визуально подсвечиваются обе направляющие hovered row без второй
линии и без изменения толщины.

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
| Карточка | Inset border 2px (::after) | — | — | `after:... hover:after:shadow-[inset_0_0_0_2px_var(--primary-hover)]` |

### Focus

| Состояние | Светлая | Тёмная |
|---|---|---|
| Обычный инпут | border: #EBEBEB | border: #1D1D1D |
| Focused | border: #333333 | border: #E4E4E4 |

Утилита: `focus-visible:border-foreground`. Без box-shadow, outline, glow.

### Active (нажатие)

Не используется. Hover достаточен для обратной связи.

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

Размеры (`size`) — только два:

| Размер | Высота | Паддинги | Шрифт |
|---|---|---|---|
| `default` | `h-8` (32px) | `px-3` | `text-base` (14px) |
| `xs` | `h-6` (24px) | `px-2` | `text-sm` (12px) |
| `icon` | `size-8` (32px) | — | — |
| `icon-xs` | `size-6` (24px) | — | — |

Input и Command — тоже 32px (`h-8`).

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

Фокус (default): `border-foreground`. Плейсхолдер: `text-tertiary-foreground`.

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

### DropdownMenu

`DropdownMenuTrigger > DropdownMenuContent > DropdownMenuItem`.

Content: `rounded-1 border bg-popover p-1 text-popover-foreground`, тень — единая для всплывающих элементов (см. «Всплывающие элементы»).
Item: `rounded-1 px-2 py-1.5 text-base cursor-default`.
Item `variant="destructive"`: красный текст (`text-destructive`), стандартный ховер-фон (`focus:bg-accent`).

### Tooltip

`TooltipTrigger > TooltipContent`.

Content: `rounded-1 bg-foreground text-background px-3 py-1.5 text-sm`. Стрелка: `bg-foreground fill-foreground`. Анимация: fade + zoom при появлении/скрытии.

### Dialog (Detail)

Полноэкранная страница: `absolute inset-0 bg-background`. Занимает весь контейнер поверх сетки, без оверлея. Закрытие: ESC или кнопка.

### Separator

`bg-border`. Горизонтальный: `h-px w-full`. Вертикальный: `h-full w-px`.

### ScrollArea

Кастомный скроллбар: `w-2.5 rounded-full bg-border`. Скроллбары WebKit скрыты глобально.

### Command (Cmd+K)

Палитра команд. `CommandDialog > CommandInput > CommandList > CommandGroup > CommandItem`.

Input: иконка поиска + `text-base`, без бордера. List: `max-h-[300px] overflow-auto`. Item: `rounded-1 px-2 py-1.5`, выделенный — `bg-accent text-accent-foreground`. Separator: `bg-border`. Shortcut (подсказка клавиши): `text-sm text-muted-foreground ml-auto`.

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

**Появление:** `opacity-0 group-hover:opacity-100 transition-opacity`

**Поведение:**
- Parent card открывается по keyboard только когда `keydown` пришёл с самой
  card surface (`event.target === event.currentTarget`); вложенные action
  buttons не должны keyboard-bubble в open Detail.
- `stopPropagation` на контейнере — клик по кнопкам не открывает Detail
- Source: `window.open(url)`. Disabled если `block.url` нет
- Connect: `DropdownMenu` со списком каналов (`CollectionPicker`)
- More: `DropdownMenu` — Connect (подменю), Source, Remove from collection, Delete

CollectionPicker membership rows:
- Checkbox не используется.
- Название канала слева остаётся обычным UI-шрифтом.
- Правый slot имеет `w-[10ch]`; connected row всегда показывает кнопку
  `Connected`, а на hover/focus строки текст замещается на `Disconnect`.
- Unconnected row показывает count по умолчанию; на hover/focus count скрывается
  и появляется `Connect`.
- Action button: `h-6 w-[10ch] rounded-1 bg-component-fill px-[1ch]
  font-semibold`, hover/focus outline `outline-1 -outline-offset-1
  outline-component-fill-hover`.
- Видимое состояние `Disconnect` использует destructive button semantics:
  `text-destructive` при той же серой заливке и той же hover/focus outline.
- Клик по action button не должен всплывать в parent row/menu surface.

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

ContextMenu, DropdownMenu, Command — три всплывающих компонента с единым стандартом.

### Контейнер (Content)

`rounded-1 border border-border bg-popover p-1`. Тень единая:

```
shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]
```

SubContent (подменю) — та же тень.

### Пункты (Item)

`rounded-1 px-2 py-1.5 text-base focus:bg-accent`.

### Деструктивные пункты

Текст красный (`text-destructive`), фон при фокусе — стандартный (`focus:bg-accent`). Без красного фона при наведении.

## Состояния Drag-and-Drop

| Состояние | Стиль | Утилита |
|---|---|---|
| Перетаскивание | Полупрозрачный элемент | `opacity-30` |
| Цель (drop target) | Подсветка рамкой | `ring-2 ring-ring ring-inset` |

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

`<header>`: `h-8 border-b border-border`, `data-tauri-drag-region` для перетаскивания окна. Высота строго 32px.

### Нижняя панель действий (Action Bar)

`h-8 bg-accent border-t border-border px-8`. Отступы 32px с обеих сторон. Search прижат вправо через flex-spacer.

Компонент `ActionButton` — двуслойная кнопка (две «пули»). Использует токены `--component-fill-*`, изолированные от поверхностей.

- Структура: `<div role="button">` (внешняя пуля) → `<span hotkey>` + `<span label>` (внутренняя пуля)
- Внешняя пуля: `rounded-1` (3px), `h-6` (24px), `p-[2px]`, `overflow-hidden`
- Внутренняя пуля: `rounded-[2px]`, `bg-component-fill-inner`, `px-[1ch] py-[2px]`
- Hotkey: текст на фоне внешней пули, `px-[1ch] py-[2px]`
- Зазор между внешней и внутренней пулей: 2px (все стороны, через `p-[2px]` на внешней)
- Шрифт: `font-mono text-sm`
- `forwardRef<HTMLDivElement>` для программного управления

Размеры: внешняя — 24px (h-6), внутренняя — 20px (24 - 2×2px зазора).

Состояния:

| Состояние | Внешняя пуля | Хоткей | Внутренняя пуля |
|---|---|---|---|
| Покой | `bg-transparent` | `text-foreground` | `bg-component-fill-inner text-foreground` |
| Hover | `bg-component-fill-hover` | `text-foreground` | без изменений |
| Selected | `bg-component-fill-hover` | `text-foreground` | без изменений |

Кнопки:

| Hotkey | Label | Действие | Положение |
|---|---|---|---|
| ⌘⇧O | Имя vault | Выбор папки через нативный диалог | слева |
| ⌘⇧N | New Channel | Инлайн-инпут в сайдбаре | слева |
| ⌘, | Settings | DropdownMenu переключения темы и article menu mode | слева |
| ⌘K | Search | Открытие Command palette | справа |

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
`border-b border-sidebar-border`. Паддинги навигации: `px-8 pt-20`;
строки в полном режиме не имеют собственного горизонтального padding, чтобы
названия каналов, правые счётчики и link-editor action buttons стояли
заподлицо с краями navigation column. Это отдаёт свободную ширину центральной
полосе preview-карточек. Для визуальной компенсации glyph side bearings label
text получает `translate-x-px`, а правый count text получает `-translate-x-px`;
это не меняет layout box и не влияет на preview-strip ширину.
Top inset должен жить на scroll-container (`data-sidebar-scroll`), а не в
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
- Вход/выход из focus-mode анимируется `180ms cubic-bezier(0.22, 1, 0.36, 1)`.
  Переключение между строками внутри уже активного focus-mode идёт мгновенно
  через `data-sidebar-row-switching="true"` на один animation frame.

#### Link-editor режим (Detail открыт)

Когда открыта карточка, sidebar превращается в редактор связей этой карточки с
каналами. `Everything` остаётся обычным пунктом навигации с общим счётчиком и
без checkbox. Список строк каналов использует ту же геометрию, что обычный
sidebar.

Верхняя surface:

| Режим Detail menu | Geometry |
|---|---|
| `classic` | `h-8 bg-accent px-8 gap-2` + отдельная нижняя hairline |
| `island` | absolute `top-4`, centered, без фоновой плашки; pill `h-8 rounded-1 border border-border bg-accent/80 backdrop-blur-sm backdrop-saturate-150 pl-3 pr-[2px] gap-2` |

Содержимое surface: `Channels:` + selector `All / Connected`. `Channels:`
использует `font-mono text-sm text-muted-foreground`. Selector повторяет
ActionButton geometry: outer `h-6 p-[2px] rounded-1`, segments `h-5
px-[1ch] rounded-[2px] text-muted-foreground`. В `island` hover не заливает
outer control; меняется только яркость текста segment (`hover:text-foreground`).

Island surfaces используют только лёгкий glass effect: `bg-accent/80
backdrop-blur-sm backdrop-saturate-150`, без теней и градиентов. Эффект
разрешён только для маленьких fixed-height island surfaces (`h-8`), не для
полноширинных classic bars и не для больших overlay.

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
Slot сохраняет `h-8` vertical centering. Count не должен прыгать при появлении
action button.

Stable preview invariant: обычный sidebar и link-editor используют один и тот
же row component и один thumbnail strip. При открытии карточки нельзя
размонтировать строки каналов или `<img>` thumbnail'ы; меняется только правый
row-action slot (`count/menu` ↔ `Connected/Connect/Disconnect`). Это убирает blink превью при
переключении в Detail.

### Сетка

Masonry с round-robin распределением по колонкам. Gap: 32px (`--spacing-s5`). Минимальная ширина карточки: 220px; максимальная ширина не фиксируется токеном и определяется алгоритмически перед переходом к следующему числу колонок. Ленивая подгрузка через IntersectionObserver.

Паддинги сетки: 32px по бокам (при развёрнутом сайдбаре), 72px (при свёрнутом — компенсация ширины).

Карточки: `border border-border`, без скругления (`rounded-0`). Обводка = +1 уровень к фону. Hover — inset border 2px цветом `primary-hover` через `::after` псевдоэлемент (обходит `overflow-hidden`, перекрывает изображения).

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
| Навигация | react-router, стрелки, Cmd+K | Нет — одно состояние |
| IPC | Tauri commands | Native messaging (`chrome.runtime.sendNativeMessage`) |
| CSS entry | `global.css` | `popup-layout.css` (импортирует `global.css` + добавляет popup-размеры) |

### Popup-специфичные стили

```css
/* popup-layout.css */
@import "@/styles/global.css";
body { width: 360px; min-height: 200px; max-height: 600px; overflow-y: auto; }
```

Никаких собственных токенов, цветов, шрифтов или компонентов. Дрейф дизайна невозможен — единственный источник правды в `global.css`.
