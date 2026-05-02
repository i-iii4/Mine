# Дизайн-система Mine iOS

Related documents: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [SPEC_MOBILE.md](SPEC_MOBILE.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md)

## Принцип

Та же визуальная идентичность, нативные iOS-паттерны. Пользователь узнаёт Mine по палитре и типографике, но чувствует нативное iOS-приложение. Не порт WebView.

Референсы:
- **Things 3** — macOS и iOS одна визуальная система, но iOS полностью нативный
- **Bear** — та же палитра, нативная навигация
- **Are.na iOS** — узнаваемый стиль, iOS-паттерны

## Цвета

Палитра из десктопа, конвертированная в SwiftUI. Все серые нейтральные (chroma 0).

### Поверхности

```swift
extension Color {
    // Фоны — шаг 0.0248 (тёмная тема)
    static let arenaBackground = Color(white: 0.049)    // oklch(0.1567) — #0C0C0C
    static let arenaAccent = Color(white: 0.065)        // oklch(0.1815) — hover, secondary bg
    static let arenaSidebarAccent = Color(white: 0.082)  // oklch(0.2063) — selected
    static let arenaBorder = Color(white: 0.10)          // oklch(0.2311) — borders

    // Светлая тема
    static let arenaBackgroundLight = Color.white
    static let arenaAccentLight = Color(white: 0.96)
    static let arenaBorderLight = Color(white: 0.93)
}
```

### Текст

```swift
extension Color {
    // Тёмная тема
    static let arenaForeground = Color(white: 0.894)          // #E4E4E4
    static let arenaMutedForeground = Color(white: 0.533)     // #888888
    static let arenaTertiaryForeground = Color(white: 0.333)  // #555555

    // Светлая тема
    static let arenaForegroundLight = Color(white: 0.2)       // #333333
    static let arenaMutedForegroundLight = Color(white: 0.467) // #777777
}
```

### Семантические

```swift
extension Color {
    static let arenaDestructive = Color.red
    static let arenaPrimaryHover = Color(white: 0.8)  // oklch(0.8)
}
```

**Правило:** при добавлении нового серого — `Color(white: X)`. Без hue, без saturation.

## Типографика

System font (SF Pro) — не кастомные шрифты. Размеры адаптированы для мобильного масштаба.

| Десктоп | iOS | SwiftUI | Где |
|---|---|---|---|
| `text-sm` (12px) | 10pt | `Arena.fontRegular()` | Карточки, подписи (адаптировано для ~190px колонки) |
| `text-base` (14px) | 13pt | `Arena.fontRegular(13)` | Detail body |
| `text-lg` (18px) | 16pt | `Arena.fontSemibold(16)` | Заголовки Detail |

### Веса

| Десктоп | iOS | SwiftUI |
|---|---|---|
| 400 (default) | Regular | `.regular` |
| 600 (semibold) | Semibold | `.semibold` |

**Только два веса** — как на десктопе.

### Monospace

Десктоп: Geist Mono в сайдбаре. iOS: SF Mono (`.monospaced()`) для channel list и метаданных.

## Spacing

Базовая единица: 8pt (вместо 4px на десктопе). iOS touch targets — минимум 44pt.

| Токен | Значение | Где |
|---|---|---|
| `xs` | 4pt | Внутренние отступы мелких элементов |
| `sm` | 8pt | Зазоры, мелкие паддинги |
| `md` | 16pt | Стандартный паддинг секций |
| `lg` | 24pt | Паддинг карточки |
| `xl` | 32pt | Grid gap |

## Скругления

На десктопе контент без скругления (`rounded-0`), интерфейс 3px. На iOS — адаптация под платформу:

| Элемент | Десктоп | iOS | Обоснование |
|---|---|---|---|
| Карточки контента | 0 | 0 | Единый стиль — без скругления |
| Кнопки, бейджи | 3px | 8pt | Нативный iOS-радиус |
| Модальные окна | 3px | 12pt | `.sheet` стандарт |
| Аватары | 50% | 50% | Одинаково |

## Иконки

Десктоп: Lucide React. iOS: **SF Symbols** — нативнее, лучшая интеграция с Dynamic Type, поддержка анимаций.

| Десктоп (Lucide) | iOS (SF Symbols) |
|---|---|
| `X` (close) | `xmark` |
| `Plus` | `plus` |
| `Search` | `magnifyingglass` |
| `MoreHorizontal` | `ellipsis` |
| `Pencil` | `pencil` |
| `Trash2` | `trash` |
| `ImageOff` | `photo.badge.exclamationmark` |

## Компоненты — маппинг десктоп → iOS

### Навигация

| Десктоп | iOS | SwiftUI |
|---|---|---|
| Sidebar (каналы) | Tab Bar + Channel sheet | `TabView` + `.sheet` |
| Detail lightbox | Custom push (@State + back button) | `@State` + `withAnimation` |
| Cmd+K search | Search bar | `.searchable()` |
| Context menu | Long press menu | `.contextMenu` |

### Grid

| Десктоп | iOS |
|---|---|
| Masonry (round-robin columns) | Фиксированные 2 колонки: `HStack` + 2 `LazyVStack` (round-robin) |
| Infinite scroll (IntersectionObserver) | SwiftUI `List` / `ScrollView` с lazy loading |
| Chunk loading (80 + 60) | Не нужно — SwiftUI LazyVGrid загружает по мере прокрутки |

### Карточки

Та же структура: тип определяет layout.

| Тип | Десктоп | iOS |
|---|---|---|
| Image | `<img>` full width | `AsyncImage` full width |
| Link | Thumbnail + display title + domain | Аналогично |
| Article | Display title + preview text | Аналогично |
| Video | Thumbnail + play icon | `LoopingVideoView` (AVPlayerLooper — muted autoplay loop) |
| Social (Twitter/IG) | Text + media grid | Аналогично + `LoopingVideoView` для .mp4 медиа |

### Detail

| Десктоп | iOS |
|---|---|
| Full-screen overlay | @State push с `withAnimation(.easeInOut)` |
| Left/right arrows | Не реализовано (будущее) |
| Metadata panel (right) | Scroll section внизу DetailView |
| ESC to close | Кастомная кнопка назад (шеврон в полупрозрачном круге) |
| ReactMarkdown body | `Text()` с plain text (markdown-рендер — будущее) |

### Share Extension (аналог popup клиппера)

| Popup (десктоп) | Share Extension (iOS) |
|---|---|
| Preview card | Compact card preview |
| Channel list + checkboxes | Tag picker (list с toggle) |
| Save button | Done button в navigation bar |
| 360x600px | Compact sheet (half-screen) |

## Жесты

| Жест | Действие |
|---|---|
| Tap | Открыть карточку (→ Detail) |
| Long press | Context menu (теги, удаление) |
| ~~Swipe left/right в Detail~~ | ~~Предыдущая/следующая карточка~~ (не реализовано) |
| Pull to refresh | Пере-сканировать vault |
| Pinch to zoom (images) | Увеличение изображения |

## Haptics

| Действие | Feedback |
|---|---|
| Сохранение через Share Extension | `.success` |
| Удаление карточки | `.warning` |
| Long press → context menu | `.medium` |
| Pull to refresh | `.light` |

## Dark/Light mode

Как на десктопе: тёмная тема по умолчанию, светлая через `@Environment(\.colorScheme)`. Все цвета через `Color` extension с условием:

```swift
extension Color {
    static func arena(_ dark: Color, light: Color) -> Color {
        // Resolved in view body via @Environment(\.colorScheme)
    }
}
```

Или через Asset Catalog с Dark/Light variants.

## Offline

Все данные локальны (iCloud Drive). Приложение полностью функционально без интернета. Thumbnail-кэш в `.arena/cache/thumbs/` — тот же путь что на десктопе.

## Accessibility

- Dynamic Type: все текстовые стили через SwiftUI `.font()` (масштабируются автоматически)
- VoiceOver: `.accessibilityLabel` на карточках, кнопках
- Reduce Motion: отключение анимаций через `@Environment(\.accessibilityReduceMotion)`
- Minimum touch target: 44×44pt
