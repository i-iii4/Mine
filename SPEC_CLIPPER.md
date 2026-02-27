# Specification: Web Clipper (Browser Extension)

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md)

## Overview

Браузерное расширение для сохранения контента из веба в Local Arena vault. Работает автономно через native messaging — не требует запущенного приложения.

Поддерживаемые браузеры: Chrome (Manifest V3), Safari (через xcrun safari-web-extension-converter).

## Architecture

```
┌──────────────────────────────────────────┐
│            Browser Extension             │
│                                          │
│  ┌────────────┐  ┌────────────────────┐  │
│  │  Popup UI  │  │  Content Script    │  │
│  │            │  │                    │  │
│  │ Type picker│  │ Meta extraction    │  │
│  │ Tag picker │  │ Readability.js     │  │
│  │ Preview    │  │ Selection capture  │  │
│  │ Save btn   │  │ Image src capture  │  │
│  └─────┬──────┘  └────────┬───────────┘  │
│        │                  │              │
│        └────────┬─────────┘              │
│                 │                        │
│        ┌────────▼─────────┐              │
│        │  Background SW   │              │
│        │  (service worker) │              │
│        │                  │              │
│        │ Context menus    │              │
│        │ Native messaging │              │
│        └────────┬─────────┘              │
└─────────────────┼────────────────────────┘
                  │ stdin/stdout (JSON, 4-byte length header)
                  │
         ┌────────▼─────────┐
         │  Native Host     │
         │  (Rust binary)   │
         │                  │
         │ Read vault path  │
         │ Write .md files  │
         │ Download media   │
         │ Gen thumbnails   │
         │ Update SQLite    │
         │ List channels    │
         └────────┬─────────┘
                  │
         ┌────────▼─────────┐
         │  Vault (FS)      │
         │  .arena/index.db │
         └──────────────────┘
```

## Clip Types

### 1. Link (ссылка)

Сохраняет текущую страницу как закладку.

| Field | Source |
|---|---|
| type | `link` |
| url | `canonical URL` > `og:url` > `window.location.href` |
| title | `og:title` > `twitter:title` > `<title>` |
| description | `og:description` > `twitter:description` > `meta[name=description]` |
| thumbnail | Скачивается: `og:image` > `twitter:image` |
| source | `web-clipper` |

Результат: `.md` (type: link) + миниатюра (если есть og:image).

### 2. Article (полная статья)

Извлекает текст статьи через Readability.js.

| Field | Source |
|---|---|
| type | `article` |
| url | Canonical URL страницы |
| title | Readability.title > og:title > `<title>` |
| author | Readability.byline > `meta[name=author]` |
| body | Readability.textContent (очищенный текст) |
| thumbnail | `og:image` |
| source | `web-clipper` |

Результат: `.md` (type: article, body = очищенный текст) + миниатюра.

### 3. Selection (выделенный текст)

Сохраняет выделенный фрагмент текста.

| Field | Source |
|---|---|
| type | `article` |
| url | URL страницы |
| title | Первые 60 символов выделения > `<title>` |
| body | `window.getSelection().toString()` |
| source | `web-clipper` |

Результат: `.md` (type: article, body = выделенный текст).

### 4. Image (изображение)

Сохраняет конкретное изображение.

| Field | Source |
|---|---|
| type | `image` |
| url | URL страницы (источник) |
| title | `alt` > `title` > имя файла |
| file | Скачивается по `img.src` |
| width/height | `img.naturalWidth` / `img.naturalHeight` |
| source | `web-clipper` |

Результат: `.md` (type: image) + скачанный файл + thumbnail.

### 5. Video (видеоссылка)

Сохраняет ссылку на видео (YouTube, Vimeo и т.д.).

| Field | Source |
|---|---|
| type | `video` |
| url | URL видео |
| title | `og:title` > `<title>` |
| thumbnail | `og:image` |
| source | `web-clipper` |

Результат: `.md` (type: video) + миниатюра.

### 6. File (файл по прямой ссылке)

Сохраняет файл по прямой ссылке (PDF, ZIP и т.д.).

| Field | Source |
|---|---|
| type | `file` |
| url | URL файла |
| title | Имя файла из URL |
| file | Скачивается native host'ом |
| source | `web-clipper` |

Результат: `.md` (type: file) + скачанный файл.

## Auto-detection Heuristic

При открытии popup расширение определяет тип страницы:

```
1. Если есть выделенный текст → Selection
2. Если URL содержит youtube.com/watch, vimeo.com, youtu.be → Video
3. Если URL оканчивается на .pdf, .zip, .dmg, .exe → File
4. Если выполняется ≥2 из:
   - <article> элемент существует
   - og:type === "article"
   - Readability.isProbablyReaderable() === true
   - Текстовый контент > 500 символов
   → Article
5. Иначе → Link
```

Пользователь всегда может переключить тип через сегментированный контрол.

## Popup UI

### Layout

```
┌──────────────────────────────────────┐
│ ┌──────┐ ┌───────┐ ┌─────┐ ┌─────┐  │
│ │Ссылка│ │Статья │ │Видео│ │Файл │  │ ← сегментированный контрол
│ └──────┘ └───────┘ └─────┘ └─────┘  │
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Preview area                   │  │
│  │ (thumbnail / text excerpt)     │  │
│  └────────────────────────────────┘  │
│                                      │
│  Title: [_________________________]  │
│                                      │
│  Description: [___________________]  │
│                                      │
│  Channels: [search / select tags__]  │
│    ┌─────────────────────────────┐   │
│    │ ☐ design                    │   │
│    │ ☐ inspiration               │   │
│    │ ☐ programming               │   │
│    │ + Create "new-tag"          │   │
│    └─────────────────────────────┘   │
│                                      │
│  [Cancel]              [Save ⌘⏎]    │
│                                      │
│  ─ Status: Ready / Saving... / ✓ ─  │
└──────────────────────────────────────┘
```

### Popup Components

| Component | Description |
|---|---|
| TypeSwitcher | Сегментированный контрол: Link / Article / Video / File. Предвыбран эвристикой |
| Preview | Адаптивный блок: для link/video — og:image, для article — первые строки текста, для image — само изображение |
| TitleField | Автозаполнение из метаданных, редактируемое |
| DescriptionField | Автозаполнение из og:description, редактируемое. Скрыто для image |
| ChannelPicker | Поиск по существующим каналам (тегам) из vault. Множественный выбор. Возможность создать новый канал прямо в поле |
| SaveButton | Cmd+Enter. Отправляет данные в native host |
| StatusBar | Состояние: Ready → Saving... → Saved / Error message |

### Popup States

| State | UI |
|---|---|
| Loading | Spinner, пока content script извлекает метаданные |
| Ready | Все поля заполнены, кнопка Save активна |
| Saving | Spinner на кнопке Save, поля заблокированы |
| Saved | Зелёная галочка, автозакрытие через 1.5с |
| Error | Красное сообщение, кнопка Save снова активна |
| No Vault | Сообщение «Vault not configured. Open Local Arena to select a vault» |
| No Host | Сообщение «Native host not installed. Reinstall Local Arena» |

## Context Menu

Background service worker регистрирует 4 пункта:

| ID | Title | Context | Visible when |
|---|---|---|---|
| `save-page` | Save page to Local Arena | `page` | Всегда |
| `save-image` | Save image to Local Arena | `image` | Правый клик по `<img>` |
| `save-selection` | Save selection to Local Arena | `selection` | Есть выделенный текст |
| `save-link` | Save link to Local Arena | `link` | Правый клик по `<a>` |

При выборе пункта открывается popup с предвыбранным типом и заполненными полями.

## Keyboard Shortcuts

| Shortcut | Context | Action |
|---|---|---|
| `Option+A` | Глобальный (настраиваемый через chrome://extensions/shortcuts) | Открыть popup |
| `Cmd+Enter` | Popup | Сохранить |
| `Escape` | Popup | Закрыть без сохранения |
| `Up/Down` | Popup, фокус на ChannelPicker | Навигация по каналам |
| `Enter` | Popup, фокус на ChannelPicker | Выбрать/снять канал |

## Metadata Extraction (Content Script)

Content script извлекает метаданные из DOM текущей страницы.

### Приоритет источников

| Field | Priority |
|---|---|
| url | `link[rel=canonical]` > `og:url` > `window.location.href` |
| title | `og:title` > `twitter:title` > `<title>` |
| description | `og:description` > `twitter:description` > `meta[name=description]` |
| image | `og:image` > `twitter:image` |
| author | `meta[name=author]` > `article:author` |
| type | `og:type` (для эвристики) |
| favicon | `link[rel=icon]` (отображение в popup, не сохраняется) |

### Readability.js

Используется только для типа Article. Библиотека включена в расширение (bundled, не CDN).

Извлекает:
- `title` — заголовок статьи
- `byline` — автор
- `textContent` — очищенный текст (без HTML)
- `excerpt` — краткое описание

`Readability.isProbablyReaderable()` используется для эвристики автоопределения.

## Native Messaging Protocol

### Transport

- Формат: JSON
- Кодировка: UTF-8
- Каждое сообщение предваряется 4-байтовым заголовком длины (little-endian, uint32)
- Направление: popup → background SW → stdin native host → stdout → background SW → popup

### Request Messages

#### `get_status`

Проверка: vault выбран, host работает.

```json
{
  "action": "get_status"
}
```

Response:
```json
{
  "ok": true,
  "vault_path": "/Users/user/LocalArena",
  "version": "0.1.0"
}
```

#### `list_channels`

Список каналов (тегов) из vault.

```json
{
  "action": "list_channels"
}
```

Response:
```json
{
  "ok": true,
  "channels": [
    { "tag": "design", "title": "Design", "block_count": 42 },
    { "tag": "programming", "title": "Programming", "block_count": 15 }
  ]
}
```

#### `save_block`

Сохранение блока в vault.

```json
{
  "action": "save_block",
  "block_type": "link",
  "title": "Stripe — Financial Infrastructure",
  "description": "Financial infrastructure for the internet",
  "url": "https://stripe.com",
  "body": "",
  "tags": ["design", "fintech"],
  "image_url": "https://stripe.com/img/v3/home/twitter.png",
  "author": null
}
```

Response:
```json
{
  "ok": true,
  "slug": "stripe-financial-infrastructure",
  "block_type": "link"
}
```

Для типа `image`:
```json
{
  "action": "save_block",
  "block_type": "image",
  "title": "Sunset in Tokyo",
  "url": "https://unsplash.com/photo/abc",
  "body": "",
  "tags": ["photography"],
  "image_url": "https://images.unsplash.com/photo-abc?w=3840",
  "width": 3840,
  "height": 2160
}
```

Native host скачивает `image_url`, сохраняет файл, генерирует thumbnail.

#### `create_channel`

Создание нового канала.

```json
{
  "action": "create_channel",
  "tag": "new-topic",
  "title": "New Topic"
}
```

Response:
```json
{
  "ok": true,
  "tag": "new-topic"
}
```

### Error Response

```json
{
  "ok": false,
  "error": "Vault not configured"
}
```

## Native Host Binary

### Расположение

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/LocalArena/native-host` |

### Manifest (Chrome)

Файл: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.localarena.clipper.json`

```json
{
  "name": "com.localarena.clipper",
  "description": "Local Arena Web Clipper",
  "path": "~/Library/Application Support/LocalArena/native-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<extension-id>/"
  ]
}
```

### Manifest (Safari)

Safari использует `SFSafariExtensionHandler` + App Group для native messaging. Бинарник тот же, но вызывается через XPC-обёртку внутри Safari App Extension.

### Реализация

Native host — отдельный Rust-бинарник (не Tauri). Переиспользует крейты из основного приложения:

| Crate/Module | Purpose |
|---|---|
| `domain::block` | Генерация slug, валидация |
| `domain::vault` | Чтение vault path из конфигурации |
| `storage::db` | Открытие SQLite-соединения |
| `storage::index` | upsert_block, list_channels |
| `storage::files` | write_block_file |
| `storage::thumbnails` | generate_thumbnail |
| `ureq` | Скачивание медиафайлов и og:image |

### Vault Path Discovery

Native host читает путь к vault из файла конфигурации основного приложения:

```
~/Library/Application Support/com.localarena.app/vault_path.txt
```

Этот файл создаётся основным приложением при select_vault. Содержит абсолютный путь к vault.

### Конкурентный доступ к SQLite

- WAL-режим позволяет несколько reader-ов и одного writer-а
- Native host открывает собственное соединение (как и watcher)
- Если основное приложение запущено, watcher обнаружит новые файлы и обновит UI автоматически
- Если приложение не запущено — блоки появятся при следующем запуске (full_scan при инициализации)

## Error Handling

| Situation | Behavior |
|---|---|
| Vault not configured | Response: `{"ok": false, "error": "Vault not configured"}`. Popup показывает сообщение |
| Native host not found | Chrome показывает ошибку подключения. Popup показывает «Native host not installed» |
| Media download failed | Блок создаётся без медиафайла (type остаётся, media_file = null). Предупреждение в response |
| SQLite locked | Retry через 100мс, до 3 попыток. Затем ошибка |
| Disk full | Ошибка записи файла. Response: `{"ok": false, "error": "Failed to write file: ..."}` |
| Invalid URL | Блок создаётся, URL сохраняется as-is |

## File Structure

```
extension/
├── manifest.json           # Manifest V3
├── background.js           # Service worker: context menus, native messaging
├── content.js              # Content script: metadata extraction, Readability
├── popup/
│   ├── popup.html
│   ├── popup.js            # React или vanilla JS
│   └── popup.css
├── lib/
│   └── readability.js      # Bundled Readability.js
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png

src-tauri/src/bin/
└── native_host.rs          # Native messaging host (Rust binary)
```

## Manifest V3

```json
{
  "manifest_version": 3,
  "name": "Local Arena Clipper",
  "version": "0.1.0",
  "description": "Save links, articles, and images to Local Arena",
  "permissions": [
    "contextMenus",
    "activeTab",
    "nativeMessaging"
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "commands": {
    "_execute_action": {
      "suggested_key": {
        "default": "Alt+A",
        "mac": "Alt+A"
      },
      "description": "Open Local Arena Clipper"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

## Testing

### Native Host

| # | Test | Description |
|---|---|---|
| 1 | get_status без vault | Ответ ok=false, error message |
| 2 | get_status с vault | Ответ ok=true, путь к vault |
| 3 | save_block link | Создаёт .md + загружает thumbnail |
| 4 | save_block article | Создаёт .md с body |
| 5 | save_block image | Загружает файл, генерирует thumbnail |
| 6 | save_block с новыми тегами | Теги добавляются в frontmatter |
| 7 | list_channels | Возвращает каналы из индекса |
| 8 | create_channel | Создаёт канал, возвращает tag |
| 9 | concurrent access | Блок создаётся при запущенном приложении |
| 10 | message framing | 4-byte length header, UTF-8 JSON |

### Extension (manual)

| # | Test | Description |
|---|---|---|
| 1 | Popup open | Option+A открывает popup |
| 2 | Auto-detect link | На обычной странице предвыбран Link |
| 3 | Auto-detect article | На Medium/блоге предвыбрана Article |
| 4 | Auto-detect video | На YouTube предвыбрано Video |
| 5 | Selection clip | Выделенный текст → тип Selection |
| 6 | Context menu image | ПКМ по изображению → popup с Image |
| 7 | Channel picker | Каналы загружаются из vault |
| 8 | Create channel | Ввод нового имени → создание канала |
| 9 | Save + auto-close | Сохранение → зелёная галочка → закрытие |
| 10 | Error state | Нет vault → сообщение об ошибке |
