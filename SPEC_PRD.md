# PRD: Mine

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_USECASES.md](SPEC_USECASES.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md)

## Продукт

Десктопное приложение для визуального букмаркинга. Локальная альтернатива Are.na без облака, подписки и социальных функций. Файлы на диске пользователя, интерфейс — окно в них.

### Референсы

| Приложение | Что берём | Что не берём |
|---|---|---|
| **Are.na** | Каналы, блоки, связи, блок в нескольких каналах | Социальное: подписки, лента, чужие каналы |
| **Mymind** | Мгновенное сохранение, умные карточки | Облачное хранение |
| **Cosmos** | Визуальный поиск (позже, через эмбеддинги) | Облачное хранение |

### Принципы

1. **Файлы — источник правды.** Удалил приложение — файлы остались
2. **Коллекции — это Obsidian-страницы.** Один файл, много `Mine Collections` wikilinks = блок в нескольких коллекциях
3. **Всё — Markdown.** Каждый блок = `.md` с frontmatter + опциональный медиафайл рядом
4. **Плоская структура.** Все файлы в корне vault, никаких вложенных папок
5. **Индекс восстановим.** SQLite — кэш, не хранилище. Пересобирается из файлов

---

## Модель данных

### Блок

Блок — единица контента. На диске: `.md` файл с YAML frontmatter + опциональный медиафайл.

**Обязательные атрибуты frontmatter:**

| Атрибут | Тип | Описание |
|---|---|---|
| `type` | string | `link` / `article` / `image` / `video` / `file` |
| `Mine Collections` | string[] | Quoted Obsidian wikilinks на collection pages |
| `saved_at` | datetime | Когда сохранён |

**Опциональные атрибуты:**

| Атрибут | Тип | Когда используется |
|---|---|---|
| `url` | string | link, article, image (из веба) |
| `file` | string | Имя связанного медиафайла |
| `thumbnail` | string | Имя файла-миниатюры |
| `description` | string | Описание |
| `author` | string | Автор (для статей) |
| `width` | number | Размеры (для изображений, видео) |
| `height` | number | Размеры |
| `source` | string | Откуда сохранён (`browser-extension`, `drag-drop`, `manual`) |

Visible title is content, not required metadata. New Mine-authored blocks write
real page/article headings as the first Markdown H1 in body. Existing
`frontmatter.title` remains a legacy read fallback only. See
`SPEC_DISPLAY_TITLE.md`.

### Коллекция

Коллекция — это Obsidian-страница (`.md` с `type: channel`), которая отображается в боковой панели как постоянный пункт навигации.

Открыть коллекцию = показать все блоки, у которых есть wikilink на эту collection page в `Mine Collections`.

Метаданные коллекций (название, цвет, иконка, порядок) хранятся в collection page frontmatter. SQLite — local derived cache и восстанавливается из файлов.

### Wikilinks

Связи между блоками — через `[[wikilinks]]` в теле `.md` файла (Obsidian-формат). Изображения встраиваются через `![[filename.png]]`.

---

## Типы блоков и сценарии сохранения

### 1. Ссылка (link)

**Пользователь:** сохраняет URL страницы.

**На диске:**
```
stripe-homepage.md          ← frontmatter: type=link, url, Mine Collections; body H1
stripe-og.png               ← миниатюра (og:image или скриншот)
```

**На фронте:** карточка с миниатюрой страницы, заголовком и доменом.

**Frontmatter:**
```yaml
type: link
url: https://stripe.com
description: Financial infrastructure for the internet
thumbnail: stripe-og.png
Mine Collections:
  - "[[Web Design]]"
  - "[[Fintech]]"
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
```

**Тело:**
```markdown
# Stripe — Financial Infrastructure
```

### 2. Статья / фрагмент текста (article)

**Пользователь:** сохраняет статью целиком или выделенный фрагмент текста на странице.

**На диске:**
```
crdt-article.md             ← frontmatter + текст статьи в теле
crdt-diagram.png            ← изображение из статьи (скачано отдельно)
crdt-article-og.png         ← миниатюра
```

**На фронте:** готовая статья для чтения. Изображения встроены через wikilinks.

**Frontmatter:**
```yaml
type: article
url: https://example.com/crdt-explained
author: Wim Cools
thumbnail: crdt-article-og.png
Mine Collections:
  - "[[Programming]]"
  - "[[Distributed Systems]]"
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
```

**Тело:**
```markdown
# Как устроен CRDT

Текст статьи или выделенный фрагмент.
Может содержать форматирование.

![[crdt-diagram.png]]
```

### 3. Изображение (image)

**Пользователь:** сохраняет картинку из интернета или перетаскивает с диска.

**На диске:**
```
sunset-tokyo.md             ← frontmatter: type=image, file, Mine Collections
sunset-tokyo.jpg            ← само изображение
```

**На фронте:** только картинка. Клик открывает детальный вид с атрибутами: откуда сохранена, когда, в каких коллекциях, связанные блоки через wikilinks.

**Frontmatter:**
```yaml
type: image
file: "[[sunset-tokyo.jpg]]"
url: https://unsplash.com/photo/abc
width: 3840
height: 2160
Mine Collections:
  - "[[Photography]]"
  - "[[Japan]]"
  - "[[Inspiration]]"
saved_at: 2026-02-26T14:30:00Z
source: browser-extension
```

Тело `.md` пустое.

### 4. Видео (video)

**На диске:**
```
demo-reel.md                ← frontmatter: type=video, file, Mine Collections
demo-reel.mp4               ← видеофайл
demo-reel-thumb.jpg         ← кадр для миниатюры
```

**На фронте:** миниатюра с иконкой воспроизведения. Клик — встроенный плеер или открытие в системном.

### 5. PDF / произвольный файл (file)

**На диске:**
```
design-systems-book.md      ← frontmatter: type=file, file, Mine Collections
design-systems-book.pdf     ← файл
```

**На фронте:** иконка типа файла + название + размер. Клик — открытие в системном приложении или встроенный просмотр PDF.

---

## Интерфейс

### Общая раскладка

```
┌──────────┬──────────────────────────────────┐
│          │                                  │
│ Sidebar  │         Основная область          │
│          │                                  │
│ Коллекции│   Сетка карточек / Детальный вид  │
│          │                                  │
│          │                                  │
│ Все      │                                  │
│ design   │  ┌─────┐ ┌─────┐ ┌─────┐        │
│ photo    │  │     │ │     │ │     │        │
│ code     │  │ img │ │link │ │ txt │        │
│ ...      │  │     │ │     │ │     │        │
│          │  └─────┘ └─────┘ └─────┘        │
│ + канал  │  ┌─────┐ ┌─────┐ ┌─────┐        │
│          │  │     │ │     │ │     │        │
│──────────│  │ vid │ │ img │ │ pdf │        │
│ Cmd+K    │  │     │ │     │ │     │        │
│ поиск    │  └─────┘ └─────┘ └─────┘        │
└──────────┴──────────────────────────────────┘
```

### Sidebar (боковая панель)

- **«Все»** — все блоки в vault
- **Коллекции** — Obsidian pages с `type: channel`, упорядочены пользователем
- **«+ канал»** — создать новую collection page
- Счётчик блоков рядом с каждой коллекцией
- Перетаскивание для изменения порядка

### Сетка карточек

- Виртуальный скроллинг: на экране ~50-200 карточек, в DOM ~40-60 элементов
- Карточки адаптируются по типу блока:
  - **image** — thumbnail с соотношением сторон оригинала
- **link** — миниатюра страницы + H1 из body + домен
- **article** — первые строки текста (или og:image + H1 из body)
  - **video** — кадр с иконкой воспроизведения
  - **file** — иконка типа + имя + размер
- Режимы: сетка (равномерные столбцы), masonry (разная высота), список

### Детальный вид (lightbox)

Клик по карточке:
- **image** — полноразмерное изображение с зумом
- **article** — рендеринг Markdown, режим чтения
- **link** — миниатюра + метаданные + кнопка «Открыть в браузере»
- **video** — встроенный плеер
- **file** — системный просмотр (Quick Look)

Под контентом — атрибуты: коллекции, дата, источник, связанные блоки (wikilinks), «Открыть в Finder».

### Поиск (Cmd+K)

- Глобальный поиск по всему vault
- Мгновенные результаты (FTS5)
- Поиск по: H1/display heading, legacy title, описанию, тексту статей, именам файлов
- Результаты: блоки и коллекции вперемешку с иконками типа

---

## Взаимодействие с файловой системой

### Vault

Vault — корневая папка, выбираемая пользователем при первом запуске. Все файлы лежат плоско в корне vault. Служебные данные — в `.arena/`.

### File watcher

Приложение отслеживает изменения в vault через FSEvents (macOS):
- Файл добавлен → индексирование + thumbnail
- Файл изменён → переиндексация frontmatter
- Файл удалён → удаление из индекса

**Принцип:** любое действие в Finder = действие в приложении. Перетащил картинку в vault через Finder — она появилась в приложении.

### Именование файлов

При сохранении из браузера: `<slug-из-H1-или-readable-seed>.<ext>`. При конфликте имён: `<slug>-2.md`, `<slug>-3.md`.

При сохранении через drag-and-drop: сохраняется оригинальное имя файла. `.md` файл метаданных создаётся с тем же именем: `photo.jpg` → `photo.md` + `photo.jpg`.

---

## Что не входит в MVP

| Функция | Когда |
|---|---|
| Расширение для браузера | После MVP |
| Импорт из Are.na | Phase 5 |
| Визуальный поиск (эмбеддинги, поиск по цвету) | Позже |
| OCR (текст на изображениях) | Позже |
| Несколько vault'ов (проекты) | Позже |
| Синхронизация между устройствами | Позже |
| Мобильный доступ | Позже |

---

## Метрики успеха

| Метрика | Цель |
|---|---|
| Время запуска приложения | < 1 сек |
| Время индексации 10 000 файлов | < 30 сек |
| FPS прокрутки при 200+ карточках на экране | 60 fps |
| Время поиска по 10 000 блоков | < 10 мс |
| Время генерации thumbnail | < 100 мс на файл |
| Размер приложения (.dmg) | < 10 МБ |
