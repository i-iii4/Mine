# Дизайн-система Local Arena

Токены определены в `src/styles/global.css` → `@theme inline`.
Tailwind v4 генерирует утилиты автоматически из `--radius-*`, `--spacing-*`, `--text-*`.

## Скругления

| Токен | Значение | Утилита | Где |
|---|---|---|---|
| `--radius-0` | 0 | `rounded-0` | Карточки контента, изображения, текстовые блоки |
| `--radius-1` | 3px | `rounded-1` | Кнопки, инпуты, попапы, меню, тултипы, диалоги |
| `--radius-2` | 5px | `rounded-2` | Микро-элементы (16-24px): мини-карточки, бейджи, чекбоксы |
| `--radius-pill` | 9999px | `rounded-pill` | Переключатели, тоглы |
| `--radius-round` | 50% | `rounded-round` | Аватары, индикаторы статуса |

**Правило:** содержимое — без скругления, интерфейс — 3px, мелкие элементы — 5px (компенсация масштаба).

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
| Основной | `--foreground` | #333333 | #E4E4E4 | `text-foreground` |
| Вторичный | `--muted-foreground` | #777777 | #888888 | `text-muted-foreground` |
| Третичный | `--tertiary-foreground` | #999999 | #555555 | `text-tertiary-foreground` |

**Правило:** иерархия через яркость, не через размер или цвет. Плейсхолдеры — tertiary, мета-информация — muted.

## Фоны

| Роль | Токен | Светлая | Тёмная |
|---|---|---|---|
| Страница | `--background` | #FFFFFF | #000000 |
| Hover | `--accent` | #F5F5F5 | #1E1E1E |
| Active | `--active` | #EBEBEB | #222222 |
| Selected (сайдбар) | `--sidebar-accent` | #F0F0F0 | #1E1E1E |

Тёмная тема — абсолютный чёрный (#000000). OLED-пиксели выключены, изображения «парят» на пустоте.

## Границы

Один цвет для всех разделителей: `--border`, `--input`, `--sidebar-border`.

| Тема | oklch | Hex | Толщина |
|---|---|---|---|
| Светлая | oklch(0.9401 0 0) | #EBEBEB | 1px |
| Тёмная | oklch(0.252 0 0) | #222222 | 1px |

**Правило:** все линии — один цвет. `--border`, `--input`, `--sidebar-border` указывают на одно значение.

## Оверлеи

| Роль | Светлая | Тёмная |
|---|---|---|
| Backdrop (`--glass-bg`) | rgba(255,255,255,0.8) | rgba(0,0,0,0.6) |
| Shadow overlay | 0 4px 24px rgba(0,0,0,0.12) | 0 4px 24px rgba(0,0,0,0.4) |

## Интерактивные состояния

Состояние элемента меняется одним свойством за раз. Без transition. Мгновенно.

### Hover

| Элемент | Что меняется | Светлая | Тёмная | Утилита |
|---|---|---|---|---|
| Текстовая кнопка | Цвет текста | #333 → #000 | #E4E4E4 → #FFF | `hover:text-hover-foreground` |
| Кнопка с заливкой | Цвет фона | #333 → #555 | #E4E4E4 → #CCC | `hover:bg-primary-hover` |
| Кнопка с бордером | Цвет фона | transparent → #F5F5F5 | transparent → #1E1E1E | `hover:bg-accent` |
| Карточка | Цвет бордера | #EBEBEB → #333 | #222 → #E4E4E4 | `hover:border-foreground` |
| Пункт сайдбара | Цвет фона | transparent → #F5F5F5 | transparent → #1E1E1E | `hover:bg-accent` |

### Focus

| Состояние | Светлая | Тёмная |
|---|---|---|
| Обычный инпут | border: #EBEBEB | border: #222222 |
| Focused | border: #333333 | border: #E4E4E4 |

Утилита: `focus-visible:border-foreground`. Без box-shadow, outline, glow.

### Active (нажатие)

| Элемент | Светлая | Тёмная | Утилита |
|---|---|---|---|
| Кнопка с заливкой | #333 → #1A1A1A | #E4E4E4 → #B3B3B3 | `active:bg-primary-active` |
| Кнопка с бордером | transparent → #EBEBEB | transparent → #222222 | `active:bg-active` |

### Selected (активный пункт сайдбара)

| Свойство | Светлая | Тёмная |
|---|---|---|
| Фон | #F0F0F0 | #1E1E1E |
| Текст | #333333 | #FFFFFF |

Утилиты: `bg-sidebar-accent text-sidebar-accent-foreground`. Без изменения веса шрифта — фонового выделения достаточно.

### Токены интерактивных состояний

| Токен | Светлая (hex) | Тёмная (hex) | Назначение |
|---|---|---|---|
| `--accent` | #F5F5F5 | #1E1E1E | Ховер фон (subtle) |
| `--active` | #EBEBEB | #222222 | Нажатие фон (subtle) |
| `--hover-foreground` | #000000 | #FFFFFF | Ховер текста |
| `--primary-hover` | #555555 | ~#C5C5C5 | Залитая кнопка ховер |
| `--primary-active` | #1A1A1A | ~#B0B0B0 | Залитая кнопка нажатие |
| `--sidebar-accent` | #F0F0F0 | #1E1E1E | Выделенный пункт фон |
| `--sidebar-accent-fg` | #333333 | #FFFFFF | Выделенный пункт текст |

## Компоненты (shadcn/ui + CVA)

Все компоненты — обёртки над Radix UI примитивами, стилизованные через CVA (Class Variance Authority). Радиусы, цвета, размеры — из токенов выше.

### Button

Варианты (`variant`):

| Вариант | Фон | Текст | Ховер |
|---|---|---|---|
| `default` | `bg-foreground` | `text-background` | `bg-primary-hover` |
| `destructive` | `bg-destructive` | `text-white` | `bg-destructive/80` |
| `outline` | `border border-foreground bg-transparent` | `text-foreground` | `bg-accent` |
| `ghost` | прозрачный | наследует | `hover:text-hover-foreground` |
| `link` | прозрачный | `text-foreground underline` | `hover:text-hover-foreground` |

Размеры (`size`):

| Размер | Высота | Паддинги |
|---|---|---|
| `default` | `h-9` | `px-4 py-2` |
| `xs` | `h-6` | `px-2`, `text-sm` |
| `sm` | `h-8` | `px-3` |
| `lg` | `h-10` | `px-6` |
| `icon` | `size-9` | — |
| `icon-xs` | `size-6` | — |
| `icon-sm` | `size-8` | — |
| `icon-lg` | `size-10` | — |

Все кнопки: `rounded-1`, `text-base`, `font-semibold`, `cursor-pointer`.

### Input

Один вариант: `h-9 rounded-1 border border-input bg-transparent px-3 text-base`. Фокус — `ring-ring`. Плейсхолдер — `text-muted-foreground`.

### Badge

| Вариант | Стиль |
|---|---|
| `default` | `bg-primary text-primary-foreground` |
| `secondary` | `bg-secondary text-secondary-foreground` |
| `destructive` | `bg-destructive text-white` |
| `outline` | `border text-foreground` |
| `ghost` | `hover:bg-accent hover:text-accent-foreground` |
| `link` | `text-primary underline-offset-4 hover:underline` |

Все бейджи: `rounded-2 px-2.5 py-0.5 text-sm font-semibold`.

### AlertDialog

Структура: `AlertDialogContent > Header(Title + Description) > Footer(Cancel + Action)`.

| Размер content | Ширина |
|---|---|
| `default` | `max-w-lg` |
| `sm` | `max-w-sm` |

Оверлей: `bg-black/80`. Action с `variant="destructive"` — красная кнопка.

### DropdownMenu

`DropdownMenuTrigger > DropdownMenuContent > DropdownMenuItem`.

Content: `rounded-1 border bg-popover p-1 text-popover-foreground shadow-md`.
Item: `rounded-1 px-2 py-1.5 text-base cursor-default`.
Item `variant="destructive"`: красный текст, красный ховер-фон.

### Tooltip

`TooltipTrigger > TooltipContent`.

Content: `rounded-1 bg-primary text-primary-foreground px-3 py-1.5 text-sm`. Анимация: fade + zoom при появлении/скрытии.

### Dialog (Detail)

Полноэкранный оверлей: `fixed inset-0 bg-glass backdrop-blur-sm`. Контент по центру: `max-w-3xl`. Закрытие: ESC или клик по оверлею.

### Select

Trigger: `h-9 rounded-1 border border-input bg-transparent px-3`. Content: `rounded-1 border bg-popover shadow-md`. Item: стиль как DropdownMenuItem.

### Textarea

`rounded-1 border border-input bg-transparent px-3 py-2 text-base`. Фокус и плейсхолдер — как Input.

### Separator

`bg-border`. Горизонтальный: `h-px w-full`. Вертикальный: `h-full w-px`.

### ScrollArea

Кастомный скроллбар: `w-2.5 rounded-full bg-border`. Скроллбары WebKit скрыты глобально.

### Command (Cmd+K)

Палитра команд. `CommandDialog > CommandInput > CommandList > CommandGroup > CommandItem`.

Input: иконка поиска + `text-base`, без бордера. List: `max-h-[300px] overflow-auto`. Item: `rounded-1 px-2 py-1.5`, выделенный — `bg-accent text-accent-foreground`. Separator: `bg-border`. Shortcut (подсказка клавиши): `text-sm text-muted-foreground ml-auto`.

### ContextMenu

`ContextMenuTrigger > ContextMenuContent > ContextMenuItem`.

Content: `rounded-1 border bg-popover p-1 shadow-md`. Item: `rounded-1 px-2 py-1.5 text-base`. Item `variant="destructive"`: красный текст, красный ховер-фон. Поддерживает: CheckboxItem, RadioItem, Sub (подменю), Label, Separator, Shortcut.

### Checkbox

Radix-обёртка: `size-4 rounded-[4px] border border-primary`. Checked: `bg-primary text-primary-foreground` с иконкой галочки. Фокус: `ring-ring`.

### Progress

`h-2 rounded-pill bg-primary/20`. Индикатор: `h-full bg-primary rounded-pill`.

## Состояния Drag-and-Drop

| Состояние | Стиль | Утилита |
|---|---|---|
| Перетаскивание | Полупрозрачный элемент | `opacity-30` |
| Цель (drop target) | Подсветка рамкой | `ring-2 ring-ring ring-inset` |

## Disabled

Все отключённые элементы: `opacity-50 cursor-not-allowed pointer-events-none`.

## Макет

### Тулбар

`<header>`: `h-8 border-b border-border`, `data-tauri-drag-region` для перетаскивания окна. Высота строго 32px.

### Сайдбар

Табличный вид. Три колонки в каждой строке:

| Колонка | Содержимое | Ширина |
|---|---|---|
| Левая | Название канала | `flex-1 min-w-0 truncate` |
| Центральная | Превью-карточки | `flex-1 min-w-0`, `h-6 flex-wrap overflow-hidden` |
| Правая | Счётчик | `w-8 text-right` |

Шрифт: `font-mono text-base`. Строки разделены `border-b border-sidebar-border`. Паддинги навигации: `px-8 pt-16` (32px по бокам, 64px сверху).

Ширина по умолчанию: 300px. Диапазон ресайза: 220–480px. Порог сворачивания: 100px.

Превью-карточки: `size-6 rounded-[2px] object-cover`. Показываются только те, для которых бэкенд подтвердил наличие файла thumbnail.

### Сетка

Masonry с round-robin распределением по колонкам. Gap: 32px (`--spacing-s5`). Минимальная ширина колонки: 240px. Ленивая подгрузка через IntersectionObserver.

Паддинги сетки: 32px по бокам (при развёрнутом сайдбаре), 72px (при свёрнутом — компенсация ширины).

Карточки: `border border-border hover:border-foreground`, без скругления (`rounded-0`).

## Архитектурные принципы

- **Монохром** — палитра строго чёрно-белая с оттенками серого. Цвет только для семантики: `destructive` (красный), `chart-*` (графики)
- **Тёмная тема по умолчанию** — светлая через `@media (prefers-color-scheme: light)`. Абсолютный чёрный (#000000) как фон
- **Без теней и градиентов** — единственное исключение: hover-оверлей на карточках изображений (`bg-gradient-to-t from-black/60`)
- **1px solid borders** — основной визуальный разделитель. Без двойных линий, пунктиров, инсетов
- **Нативное ощущение** — `-webkit-user-select: none` на кнопках и навигации, `overscroll-behavior: none`, скрытые скроллбары WebKit
- **Variable-шрифты** — один файл WOFF2 на все насыщенности (100–900), `font-display: swap`

## Рендеринг

- **Antialiased** — `body` задаёт `-webkit-font-smoothing: antialiased` и `-moz-osx-font-smoothing: grayscale` для соответствия нативному рендерингу macOS
- **Скрытые скроллбары** — `.overflow-y-auto::-webkit-scrollbar { display: none }` глобально
- **Мгновенная навигация** — без `scroll-behavior: smooth`, переходы между каналами происходят мгновенно
