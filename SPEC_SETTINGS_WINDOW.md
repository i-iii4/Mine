# Settings Window — отдельное окно настроек

Related documents: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_IDENTITY_ROBUSTNESS.md](SPEC_IDENTITY_ROBUSTNESS.md) | [ARCHITECTURE.md](ARCHITECTURE.md)

## Goal

Отдельное компактное окно настроек с системным заголовком и перетаскиванием.
Слева — список разделов, справа — контент раздела. Три раздела:

1. **Appearance** — отображение контента (тема и режимы интерфейса; сюда
   переезжают пункты нынешнего Settings-дропдауна).
2. **Spaces** — список пространств: добавить новое, забыть старое.
3. **Orphans** — все медиа-файлы vault, на которые не ссылается ни один
   элемент, с групповыми действиями: безвозвратное удаление или превращение
   в элементы.

## Non-Goals

- Переключение активного пространства из окна настроек (это задача
  `VaultSwitcher` в главном окне); Spaces управляет только списком.
- Никакого поиска/фильтра/сортировок в Orphans в этой итерации.
- Настройки article audio voices (живут в config.json) — UI не строим.
- Undo для удаления сирот (удаление идёт в системную корзину — отмена
  средствами ОС).
- Windows/Linux-специфика окна — целимся в macOS.

## Окно

| Параметр | Значение |
|---|---|
| label | `settings` |
| Хром | **консистентен с main-окном**: `titleBarStyle: Overlay`, `hiddenTitle`, наш верхний бар `h-8 bg-chrome border-b border-border` с резервом traffic lights (`80px`), заголовком `Settings` (`font-mono text-sm text-muted-foreground`) и `data-tauri-drag-region` для перетаскивания; native window background синхронизируется с chrome-токеном, как в main |
| Размер | 760×560 по умолчанию; `minWidth 640`, `minHeight 460`; resizable |
| Открытие | единственный экземпляр: повторное открытие фокусирует существующее окно |

Точки входа:

- кнопка `Settings` (`⌘,`) в нижнем баре главного окна — вместо нынешнего
  дропдауна `ThemeMenuButton` (дропдаун удаляется, его пункты переезжают в
  Appearance);
- нативный пункт меню приложения `Settings…` с акселератором `Cmd+,`
  (стандарт macOS) — работает из любого окна.

Реализация открытия — Rust-команда `open_settings_window`
(`WebviewWindowBuilder`): создаёт окно с url `settings.html` или фокусирует
существующее. `src-tauri/capabilities/default.json` → `windows: ["main",
"settings"]`.

Фронтенд окна — **отдельный Vite-entry** (`settings.html` +
`src/settings/main.tsx` + `SettingsApp.tsx`): не тянет App/Grid/Detail,
импортирует `global.css` (те же токены/тема) и `@/lib/commands`.

## Лэйаут

```
┌─ Settings ────────────────────────────────┐  ← системный titlebar
│ ┌──────────┐ ┌──────────────────────────┐ │
│ │ Appearance│ │  <заголовок раздела>     │ │
│ │ Spaces    │ │                          │ │
│ │ Orphans   │ │  …контент раздела…       │ │
│ │          │ │                          │ │
│ └──────────┘ └──────────────────────────┘ │
└────────────────────────────────────────────┘
```

- Навигация слева: ширина `176px`, `border-r border-border`, строки
  `h-8 rounded-1 px-2 font-mono text-sm` (язык сайдбара), активная —
  `bg-active text-foreground`, остальные `text-muted-foreground`,
  hover поднимает текст до foreground. Один источник active state.
- Контент: `p-s4` (24px), заголовок раздела `text-lg font-semibold`,
  секции с зазором `gap-s3`.
- Фон окна `bg-background`; всё из существующих токенов, никаких новых.

## Appearance

Контролы (persist — те же localStorage-ключи, что сейчас):

| Настройка | Контрол | Ключ |
|---|---|---|
| Theme: System / Light / Dark | `SegmentedControl` (size default) | `theme` |
| Compact Detail top menu | `Checkbox` + подпись | `mine.compactDetailTopMenu` |
| Hide bottom menu | `Checkbox` + подпись | `mine.bottomActionBarHidden` |

Каждая строка настройки: лейбл слева (`text-base`), контрол справа; подпись
вторичным текстом (`text-sm text-muted-foreground`) под лейблом, если нужна.

Логика темы выносится из `ThemeMenuButton` в общий модуль
`src/lib/themeMode.ts` (`getStoredTheme` / `applyTheme` c `setTauriTheme`) —
оба окна применяют тему сами при старте и при изменении.

**Межоконная синхронизация**: после каждого изменения settings-окно пишет
localStorage (общий для origin) и эмитит Tauri-событие `settings-changed`
(`{ key }`). Главное окно слушает событие и перечитывает значения (тема
применяется через `applyTheme`, compact/bottom — через существующие
state-сеттеры). Событие выбрано вместо DOM `storage` как гарантированный
канал в Tauri.

## Spaces

### Design decisions (зафиксированные решения)

| # | Решение | Отвергнутые варианты | Обоснование |
|---|---|---|---|
| Р-1 | Row-action — единственная команда `Remove Space` внутри `⋯`-меню (контракт `CardMoreMenu`: `Button size="icon"` + `MoreHorizontal size-4` + DropdownMenu) | (a) постоянная кнопка у каждой строки; (b) одиночная hover-кнопка без меню | (a) N повторяющихся деструктивных кнопок — постоянный шум ради действия с частотой «раз в месяц», нарушает «Weniger, aber besser»; (b) не переиспользует существующий ⋯-контракт проекта и не масштабируется. Команд, которых пользователь не запрашивал (Reveal in Finder и т. п.), в меню нет — сознательно |
| Р-2 | `⋯` скрыт в покое, появляется по `group-hover` / `group-focus-within`; при открытом меню закреплён видимым | всегда видимый `⋯` | Тот же канон, что у карточек (`CardHoverMenu`: `opacity-0` → `group-hover:opacity-100`, открытое меню пиннит видимость) и у right-slot сайдбара. Настройки — desktop-окно, тач-обнаружение не требуется; focus-within сохраняет клавиатурный доступ |
| Р-3 | Файловая статистика (`files/markdown/media/bytes`) — только `readdir` + `stat` top-level, содержимое файлов не читается. Элементы — из локального индекса пространства (`.arena/vault-id` → `app_data/vaults/<id>/index.db`, read-only, `count WHERE card_kind != 'channel'`); нет индекса → `—` | (a) парсить frontmatter всех `.md`; (b) `elements ≈ markdown`; (c) не показывать elements | (a) vault может лежать в iCloud (dataless-файлы): чтение содержимого триггерит массовое скачивание — реальный кейс пользователя; (b) ложь: коллекции тоже `.md`; (c) элементы — главная сущность продукта, пользователь запросил явно. Индекс даёт точное число без касания файлов |
| Р-4 | Статистика догружается per-row (`space_stats(path)`), список путей рендерится мгновенно из config | одна батч-команда со всей статистикой | Канон two-phase проекта (SPEC_THUMBNAILS: instant placeholder + async upgrade): медленный том (сетевой диск, спящий HDD) деградирует только свою строку, не весь раздел. Защита: `path` обязан быть в `known_vaults` — webview не может сканировать произвольные каталоги |
| Р-5 | Строка: имя (идентичность) → путь (адрес) → сводка `N elements · N markdown · N media · N files · size` (`text-sm muted`, голые числа — язык счётчиков); правый слот — только `⋯` (opacity-swap по hover), геометрия слота фиксирована | (a) MetadataRow-таблица на строку; (b) бейджи/иконки на метрику; (c) size в правом слоте | (a) 5 строк меты × N пространств раздувает список; (b) украшение без функции; (c) правый верхний угол перегружал строку вторым визуальным акцентом — все метрики читаются одной компактной строкой, размер замыкает её как итог. Порядок метрик — от сущности продукта к диску |
| Р-6 | `Remove Space` доступен и для активного пространства: UI сначала переключается на следующее в списке (`select_vault`), затем забывает старое (`forget_known_vault`) — инвариант «vault_path ∈ known_vaults» в config никогда не нарушается специальным порядком операций; единственное пространство просто забывается (приложение продолжает работать на нём до закрытия) | (a) блокировать Remove активного (disabled); (b) разрешить forget активного в Rust и чинить config постфактум | (a) искусственный барьер: пользовательская операция «забыть и уйти на следующее» — одна, незачем заставлять переключаться вручную; (b) ломает always-valid config ради того, что решается порядком вызовов |
| Р-9 | Клик по строке = переключение пространства (`select_vault`); backend эмитит `vault-selected { path }`, корневой App main-окна слушает и делает `setVaultPath` → `key={vaultPath}` ремонтирует приложение | (a) событие эмитит фронт settings-окна; (b) кнопка Switch в строке/меню | (a) Rust-эмит — единый источник истины: любое переключение из любого окна оповещает все окна, включая будущие; (b) строка-карточка и есть селектор — отдельная кнопка дублирует клик; двойная обработка в main исключена идемпотентностью `setState` |
| Р-10 | Порядок пространств — drag-and-drop строк (`reorder_known_vaults(paths)`, set-equality валидация с config); порядок массива в config — канонический порядок везде; `VaultSwitcher` перечитывает список при каждом открытии меню | (a) кнопки вверх/вниз; (b) сортировка по имени/дате | (a) чужой паттерн — каналы сайдбара уже тащатся dnd-kit (PointerSensor distance 8 отделяет клик от drag); (b) порядок — пользовательское решение, не вычислимое; канон проекта: порядок каналов = ручной |
| Р-12 | Активное пространство — `bg-active` фон строки; текстовой метки нет | (a) метка `Current` вторым размером шрифта в строке; (b) точка/чекмарк-индикатор | (a) два размера шрифта в одной строке — типографический мусор (источник правки); (b) новый индикаторный паттерн там, где у проекта есть фоновый канон выбранного (`CollectionPicker`, навигация настроек: `bg-active`) |
| Р-7 | `formatBytes` — общий модуль `src/lib/formatBytes.ts`, **десятичная база** (1 KB = 1000 B), ступени B/KB/MB/GB | (a) локальные копии форматтера; (b) двоичная база 1024 | (a) уже два потребителя (Orphans, Spaces) — правило дедупликации; (b) Finder на macOS считает десятично: иное основание даёт числа, расходящиеся с Finder — выглядит как ложь |
| Р-8 | `files` = все видимые top-level файлы (dot-файлы и директории исключены); `markdown` = `.md`; `media` = канон `preview_plan` (IMAGE_EXTS + VIDEO_EXTS); `bytes` = сумма размеров всех видимых файлов | рекурсивный обход; собственные списки расширений | Vault плоский по спецификации — рекурсия искажает метрику служебными поддеревьями; списки расширений уже канонизированы в `preview_plan` |

### Поведение

- Список — `known_vaults` из config (`list_known_vaults`), порядок как в
  config; рендерится мгновенно. Строка: имя папки (`basename`, `text-base`),
  под ним полный путь (`text-sm text-muted-foreground truncate`), под ним
  сводка `N elements · N markdown · N media · N files · size`; справа по
  hover/focus-within — `⋯` (слот фиксированной геометрии, opacity-канон
  карточек).
- Активное пространство — `bg-active`; остальные строки `bg-accent` +
  `hover:bg-active` (кликабельны). Клик по строке переключает пространство
  (`select_vault`), клик по активной — no-op. Backend эмитит
  `vault-selected { path }`; main-окно слушает в корневом App и ремонтирует
  `AppWithVault` через `setVaultPath` (`key={vaultPath}`).
- Строки перетаскиваются (dnd-kit, PointerSensor `distance: 8` — клик не
  начинает drag): optimistic `arrayMove` → `reorder_known_vaults(paths)`.
  Порядок в config — канонический: `VaultSwitcher` main-окна перечитывает
  `list_known_vaults` при каждом открытии меню.
- Статистика: `space_stats(path) -> SpaceStats { file_count, markdown_count,
  media_count, total_bytes, element_count: Option }`, вызывается per-row после
  рендера списка. До ответа сводка — `…`; `element_count: null` → `—`;
  ошибка команды → сводка `—`.
- `Remove Space` в `⋯`-меню — **detach-семантика** (`variant="detach"`,
  иконка `Unlink`): забыть из списка, данные на диске не трогаются
  (подпись-пояснение в разделе). Для активного пространства: UI сначала
  `select_vault(следующее в списке)`, затем `forget_known_vault(старое)` —
  Rust-инвариант «активное нельзя забыть» сохраняется. Единственное
  пространство забывается без переключения.
- `Add Space` внизу (`Button default`): нативный directory-picker
  (plugin-dialog `open`) → `add_known_vault(path)` — добавляет в
  `known_vaults` **без переключения** активного пространства.
- Команды `add_known_vault(path)`, `forget_known_vault(path)` (валидация:
  forget активного — ошибка), `reorder_known_vaults(paths)` (set-equality с
  config) мутируют только config.json.

## Orphans

**Определение сироты**: файл верхнего уровня vault с медиа-расширением
(канон `preview_plan`: image + video; `.md` и служебные файлы исключены), на
который не ссылается ни один блок ни одним способом учёта媒иа — frontmatter
`file`/`thumbnail` и inline-ссылки тела (wikilinks/markdown) через тот же
`MediaResolver`, что использует delete-план (`collect_delete_media_for_block`).

Команда `list_orphan_media() -> Vec<OrphanMedia { file_name, size_bytes,
modified_at }>`: один проход по всем блокам индекса собирает referenced-set,
затем `readdir` vault; **никаких O(n²)**. Запускается при входе в раздел и по
кнопке Refresh; не на keypress.

UI:

- Заголовок раздела + счётчик (`N files`, голое число — язык счётчиков).
- Список строк: `Checkbox` · превью `size-8` (для изображений —
  `asset://`-миниатюра самого файла `object-cover`; для видео/прочего —
  placeholder-слот `bg-component-fill`) · имя файла (`truncate`) · размер
  (`text-sm text-muted-foreground`, right).
- Шапка списка: `Checkbox` «select all» (indeterminate при частичном выборе)
  + счётчик выбранного.
- Панель действий под списком (видна при выборе ≥1):
  - `Convert to Elements` — `Button default`: батч-команда
    `promote_orphan_media(file_names) -> Vec<IndexedBlock>`;
  - `Delete` — `Button destructive`: `AlertDialog` подтверждение
    («Delete N files? Files are moved to the system Trash.»), затем
    `delete_orphan_media(file_names)` (crate `trash`).
- Пустое состояние: центрированное `No orphan media`
  (`text-sm text-muted-foreground`).
- После любой операции список перезагружается; прогресс батча — кнопка в
  disabled с «Working…», без отдельного прогресс-UI в этой итерации.

**Promote-семантика** (`promote_orphan_media`): для каждого файла создаётся
`.md` **рядом, без копирования медиа** (файл уже в vault — этим отличается от
`create_block(file_path)`, который копирует внешний источник):

- slug = stem имени файла; коллизии — по существующим правилам identity
  (semantic collision suffix, SPEC_IDENTITY_ROBUSTNESS);
- `type`: image/video по расширению, иначе file; frontmatter `file:` указывает
  на медиа; body пустое; `saved_at` = now;
- индексация штатной цепочкой; main-окно подхватывает новые элементы через
  существующие события (`block:added`) — без специальной синхронизации.

Защиты: команды валидируют, что каждый `file_name` — top-level файл vault
(никаких путей с разделителями), существует и действительно сирота на момент
операции (revalidation внутри команды; устаревшие имена возвращаются в
ответе как skipped, UI показывает итог «Converted N, skipped M»).

## Новые IPC-команды (сводно)

| Команда | Назначение |
|---|---|
| `open_settings_window` | создать/сфокусировать окно настроек |
| `add_known_vault(path)` | добавить пространство в список (без переключения) |
| `forget_known_vault(path)` | убрать из списка; активное — ошибка (UI переключается до забывания) |
| `reorder_known_vaults(paths)` | переписать порядок `known_vaults`; set-equality валидация |
| `space_stats(path)` | статистика пространства: files/markdown/media/bytes (stat-only) + elements из локального индекса; path обязан быть в `known_vaults` |
| `list_orphan_media()` | сироты: имя, размер, mtime |
| `promote_orphan_media(file_names)` | батч: медиа → элементы (без копирования) |
| `delete_orphan_media(file_names)` | батч: в системную корзину |

## Объём реализации

| Слой | Файлы |
|---|---|
| Rust | `commands/settings.rs` (окно + spaces + orphans) или расширение `vault.rs`/`blocks.rs`; регистрация в `lib.rs`; `capabilities/default.json` (+`settings` window); меню `Settings…` `Cmd+,` |
| Фронт | `settings.html`, `src/settings/main.tsx`, `src/settings/SettingsApp.tsx`, разделы (`AppearanceSection`, `SpacesSection`, `OrphansSection`); `src/lib/themeMode.ts` (вынос из `ThemeMenuButton`); `vite.config.ts` (multi-entry input) |
| Main-окно | кнопка `Settings` → `invoke("open_settings_window")`; удаление `ThemeMenuButton`-дропдауна; слушатель `settings-changed` (тема/compact/bottom) |
| Доки | DESIGN_SYSTEM (Settings window: лэйаут, навигация, строки настроек), CLAUDE/ARCHITECTURE ссылки |

## Test Contract

Rust (`cargo test`):

- `add_known_vault` добавляет без дублей; `forget_known_vault` убирает;
  forget активного при наличии других — ошибка, единственного — успех;
- `reorder_known_vaults` принимает только перестановку известных путей
  (потеря/добавление/дубликат — ошибка);
- `space_stats`: счёт files/markdown/media/bytes по top-level (dot-файлы и
  директории не считаются); `element_count` из существующего индекса
  (каналы исключены), без индекса — `None`; неизвестный config'у путь —
  ошибка;
- `list_orphan_media`: media без блока находится; media, на которое ссылается
  frontmatter `file` или inline wikilink тела — не сирота; `.md` и
  не-медиа-расширения игнорируются;
- `promote_orphan_media`: создаёт `.md` рядом без копирования файла,
  правильный `type` по расширению, slug-коллизия получает suffix; повторный
  promote того же файла — skipped;
- `delete_orphan_media`: файл уходит из vault; не-сирота на момент вызова —
  skipped, не удаляется.

Frontend (vitest):

- `SettingsApp`: рендер трёх разделов, переключение навигацией, активная
  строка `bg-active`;
- Appearance: смена темы вызывает `applyTheme` + emit `settings-changed`;
  чекбоксы пишут свои ключи;
- Spaces: список рендерится мгновенно, статистика догружается per-row
  (`N elements · … · N files · size`); `element_count: null` → `—`; активная
  строка `bg-active` + `aria-current`, текстовой метки нет; клик по строке —
  `select_vault`, по активной — no-op; событие `vault-selected` извне двигает
  отметку; `Remove Space` неактивного зовёт `forget_known_vault`, активного —
  сначала `select_vault(следующего)`, затем forget (порядок проверяется);
  единственное пространство забывается без переключения; reorder-хелпер
  (`reorderedPaths`) — чистые юнит-тесты (dnd-жесты в jsdom не
  воспроизводятся, сами жесты — ручная приёмка); `Add Space` вызывает picker
  и `add_known_vault` без переключения;
- Orphans: select all/частичный indeterminate; `Delete` открывает confirm и
  зовёт команду с выбранными; `Convert` зовёт promote и перезагружает список;
  пустое состояние.
- App (main): кнопка `Settings` вызывает `open_settings_window`; событие
  `settings-changed` с темой применяет тему.
