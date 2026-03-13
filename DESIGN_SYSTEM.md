# Дизайн-система Local Arena

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

Две независимые группы токенов: **поверхности** (фоновое наслоение) и **заливки компонентов** (кнопки, интерактивные элементы). Разные требования к контрасту — поверхности тонкие, кнопки считываемые.

### Поверхности

| Уровень | Токен | Светлая (L) | Тёмная (L) | Назначение |
|---|---|---|---|---|
| 0 | `--background` | 1.0 | 0.1567 | Фон страницы |
| +1 | `--accent` | 0.98 | 0.1815 | Hover фон, action bar |
| +2 | `--sidebar-accent`, `--active` | 0.965 | 0.2063 | Выделенный пункт сайдбара, нажатие |
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

Один цвет для всех разделителей: `--border`, `--input`, `--sidebar-border`. Уровень +3 шкалы поверхностей.

| Тема | oklch | Толщина |
|---|---|---|
| Светлая | oklch(0.95 0 0) | 1px |
| Тёмная | oklch(0.2311 0 0) | 1px |

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
| Кнопка default/destructive | Обводка 1px inset | `--component-fill-hover` | `--component-fill-hover` | `hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover` |
| Кнопка ghost/link | Цвет текста | #333 → #000 | #E4E4E4 → #FFF | `hover:text-hover-foreground` |
| Карточка | Inset border 2px (::after) | — | — | `after:... hover:after:shadow-[inset_0_0_0_2px_var(--primary-hover)]` |
| Пункт сайдбара | Цвет фона | transparent → #F5F5F5 | transparent → #1E1E1E | `hover:bg-accent` |

### Focus

| Состояние | Светлая | Тёмная |
|---|---|---|
| Обычный инпут | border: #EBEBEB | border: #222222 |
| Focused | border: #333333 | border: #E4E4E4 |

Утилита: `focus-visible:border-foreground`. Без box-shadow, outline, glow.

### Active (нажатие)

Не используется. Hover достаточен для обратной связи.

### Selected (активный пункт сайдбара)

| Свойство | Светлая (oklch L) | Тёмная (oklch L) |
|---|---|---|
| Фон (`--sidebar-accent`) | 0.965 | 0.2063 |
| Текст (`--sidebar-accent-foreground`) | 0.3211 | 0.9189 |

Утилиты: `bg-sidebar-accent text-sidebar-accent-foreground`. Без изменения веса шрифта — фонового выделения достаточно.

### Токены интерактивных состояний

Поверхности:

| Токен | Светлая (oklch L) | Тёмная (oklch L) | Назначение |
|---|---|---|---|
| `--accent` | 0.98 | 0.1815 | Ховер фон (поверхность +1) |
| `--sidebar-accent` | 0.965 | 0.2063 | Выделенный пункт (поверхность +2) |
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
| ⌘, | Settings | DropdownMenu переключения темы | слева |
| ⌘K | Search | Открытие Command palette | справа |

### Сайдбар

Табличный вид. Три колонки в каждой строке:

| Колонка | Содержимое | Ширина |
|---|---|---|
| Левая | Название канала | `flex-1 min-w-0 truncate` |
| Центральная | Превью-карточки | `flex-1 min-w-0`, `h-6 flex-wrap overflow-hidden` |
| Правая | Счётчик | `w-8 text-right` |

Шрифт: `font-mono text-base`. Строки разделены `border-b border-sidebar-border`. Паддинги навигации: `px-8 pt-16` (32px по бокам, 64px сверху).

Ширина по умолчанию: 300px. Диапазон ресайза: 220–600px. Порог сворачивания: 100px.

Ширина текста (название канала): 100–150px, `truncate`. Карточки занимают оставшееся пространство. Счётчик: 0 не отображается (пустое место).

Превью-карточки: `size-6 rounded-none object-cover`, `gap-1` (4px). Одна строка без переноса, лишние карточки уходят в градиентную маску (`mask-image: linear-gradient(to right, black 70%, transparent 100%)`).

### Сетка

Masonry с round-robin распределением по колонкам. Gap: 32px (`--spacing-s5`). Минимальная ширина колонки: 240px. Ленивая подгрузка через IntersectionObserver.

Паддинги сетки: 32px по бокам (при развёрнутом сайдбаре), 72px (при свёрнутом — компенсация ширины).

Карточки: `border border-border`, без скругления (`rounded-0`). Обводка = +1 уровень к фону. Hover — inset border 2px цветом `primary-hover` через `::after` псевдоэлемент (обходит `overflow-hidden`, перекрывает изображения).

## Архитектурные принципы

- **Монохром** — палитра строго чёрно-белая с оттенками серого. Цвет только для семантики: `destructive` (красный), `chart-*` (графики)
- **Тёмная тема по умолчанию** — светлая через `@media (prefers-color-scheme: light)`. Тёмно-серый фон (#0C0C0C, sRGB 0.049)
- **Без теней и градиентов** — исключения: hover-оверлей на карточках изображений (`bg-gradient-to-t from-black/60`), утилитарная тень всплывающих элементов (для отделения слоя от контента)
- **1px solid borders** — основной визуальный разделитель. Без двойных линий, пунктиров, инсетов
- **Нативное ощущение** — `-webkit-user-select: none` на кнопках и навигации, `overscroll-behavior: none`, скрытые скроллбары WebKit
- **Variable-шрифты** — один файл WOFF2 на все насыщенности (100–900), `font-display: swap`

## Рендеринг

- **Antialiased** — `body` задаёт `-webkit-font-smoothing: antialiased` и `-moz-osx-font-smoothing: grayscale` для соответствия нативному рендерингу macOS
- **Скрытые скроллбары** — `.overflow-y-auto::-webkit-scrollbar { display: none }` глобально
- **Мгновенная навигация** — без `scroll-behavior: smooth`, переходы между каналами происходят мгновенно

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
