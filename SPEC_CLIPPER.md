# Specification: Web Clipper (Browser Extension)

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md)

## Overview

Браузерное расширение для сохранения контента из веба в Mine vault. Работает автономно через native messaging — не требует запущенного приложения.

Поддерживаемые браузеры: Chromium/Manifest V3 (Chrome, Dia), Safari (через
`xcrun safari-web-extension-converter`).

Popup UI and native messaging request names still use the existing clip-type
vocabulary (`link`, `article`, `image`, `video`, `file`, `screenshot`) because
those are creation modes. Native host may persist `type` as compatibility
metadata, but feed/detail/search runtime kind is derived by the storage
contract: non-empty body → `article`, empty body → `media`, `type: channel` →
`channel`. New native-host media writes serialize `file` as
`file: "[[name.ext]]"` while accepting legacy `file: name.ext` on read.

## Architecture

```
┌──────────────────────────────────────────┐
│            Browser Extension             │
│                                          │
│  ┌────────────┐  ┌────────────────────┐  │
│  │  Popup UI  │  │  Content Script    │  │
│  │            │  │                    │  │
│  │ Type picker│  │ Meta extraction    │  │
│  │ Channels   │  │ Defuddle (lazy)    │  │
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
         │ Update SQLite    │
         │ Gen thumbnails   │
         │ Sync thumb meta  │
         │ List channels    │
         └────────┬─────────┘
                  │
         ┌────────▼─────────┐
         │ Source vault     │
         │ .mine/vault-id   │
         │ .md + media      │
         └────────┬─────────┘
                  │
         ┌────────▼─────────┐
         │ Local derived    │
         │ index.db + cache │
         └──────────────────┘
```

## Clip Types

### 1. Link (ссылка)

Сохраняет текущую страницу как закладку.

| Field | Source |
|---|---|
| type | `link` |
| url | `canonical URL` > `og:url` > `window.location.href` |
| body H1 | `og:title` > `twitter:title` > `<title>` |
| description | `og:description` > `twitter:description` > `meta[name=description]` |
| thumbnail | Скачивается: `og:image` > `twitter:image` |
| source | `web-clipper` |

Результат: `.md` (compat `type: link`, body starts with H1 when a real page title exists) + миниатюра (если есть og:image). Runtime card kind derives `article` because body is non-empty. New link clips do not write `title:` frontmatter.

### 2. Article (полная статья)

Извлекает статью через Defuddle.

| Field | Source |
|---|---|
| type | `article` |
| url | Canonical URL страницы |
| body H1 | Defuddle title > og:title > `<title>` |
| author | Defuddle author/byline > `meta[name=author]` |
| body | Defuddle markdown/text content |
| thumbnail | `og:image` |
| source | `web-clipper` |

Результат: `.md` (compat `type: article`, body starts with H1 when a real article title exists, then cleaned article text) + миниатюра. Runtime card kind derives `article`. New article clips do not write `title:` frontmatter.

### 3. Selection (выделенный текст)

Сохраняет выделенный фрагмент текста. **Selection — не отдельный UI-тип**, а вариант внутри `Content`: если на момент открытия popup есть непустое выделение, Content-превью и save() приоритизируют его над полной статьёй.

| Field | Source |
|---|---|
| type | `article` |
| url | URL страницы |
| body | `window.getSelection().toString()` |
| source | `web-clipper` |

Результат: `.md` (type: article, body = выделенный текст).
Selection clips do not generate H1 or `title:` from selected text. A one-word
selection remains a one-word body.

Визуально в popup: блок Content рендерит выделение как `<blockquote>` с подписью `Selected text · N characters` — пользователь видит ровно то, что попадёт в body. См. раздел «Content body resolution» ниже.

### 3a. Content body resolution

Popup и save() используют одну чистую функцию — `resolveContentBody(metadata, articleData)` (`extension/popup/lib/resolveContentBody.ts`) — которая возвращает `{ text, source, byline }`. Одна функция, один приоритет, невозможна рассинхронизация превью и сохранения.

Правила (в порядке проверки):

1. **`detectedType === "video"`** → `articleData.content`, source=`"video"`. Selection игнорируется: video-клип представляет транскрипт YouTube / длинные субтитры, и выделение на странице видео почти всегда не то, что нужно.
2. **`metadata.selection` непусто** (и не video) → `metadata.selection`, source=`"selection"`.
3. **`articleData.content` присутствует** (и нет selection) → `articleData.content`, source=`"article"`, `byline` пропагируется как `author` блока.
4. **Иначе** → `text=""`, source=`"empty"`.

Контракт этой функции зафиксирован unit-тестом `extension/popup/lib/resolveContentBody.test.ts` (7 кейсов). Любое изменение приоритетов обязано обновить тест в том же коммите.

### 3b. Content extraction lifecycle

`detectedType` — это только стартовая рекомендация для UI, а не доказательство,
что Content недоступен. Popup хранит отдельное состояние article extraction:
`idle | loading | ready | empty | failed`.

Единый gateway `ensureArticleLoaded()` используется в трёх местах:

1. после первого paint для страниц, которые сразу открылись в Content и требуют body;
2. при ручном переключении пользователя в Content, даже если страница была
   auto-detected как `link`;
3. перед Save, если выбран Content и нет non-video selection.

Selection остаётся мгновенным body source и не требует article extraction.
Video игнорирует selection и всегда требует transcript/body extraction.

Save-инварианты:

- Content не может сохранить `article` / video-content с пустым body.
- `idle` перед Save обязан перейти через `ensureArticleLoaded()`, а не
  сохраняться как empty article.
- `loading` не создаёт `.md`: Save ждёт текущий extraction promise.
- `empty` / `failed` показывают inline error и оставляют popup открытым.
- Native host дополнительно отказывает `block_type=article` с пустым body, чтобы
  future frontend regression не мог записать media-looking article в vault.

Контракт состояния зафиксирован unit-тестом
`extension/popup/lib/articleExtractionState.test.ts`.

### 3c. Source-specific content extractor chain

`ArticleData` остаётся единственным контрактом результата для Content preview и
Save path: `title`, `byline/author`, `content`, `excerpt`,
`embeddedVideos`. Preview и сохранение не имеют права использовать разные body
sources. `resolveContentBody()` сохраняет текущий приоритет: video body →
selection → `articleData.content` → Twitter/X media-only markdown fallback →
empty. Новые source-specific extractors добавляются только до формирования
`ArticleData`, а не отдельным UI-путём.

Для `x.com` / `twitter.com` status URL используется typed chain, а не единая
ветка "Twitter":

1. `extractXLongformArticle()` — строгий extractor длинной статьи X.
2. `extractTwitterThread()` — fallback для обычного tweet/thread/media tweet.

Generic Defuddle не запускается на полной X timeline DOM без target scoping:
страница X содержит рекомендации, ответы, сайдбар и чужие tweets, поэтому
readability без якоря может собрать неправильный документ.

#### X tweet/thread and quote tweet extraction

`extractTwitterThread()` состоит из двух независимых шагов:

1. `MineTwitterThreadSelection.selectTwitterThreadArticles()` выбирает только
   top-level timeline cells вокруг target tweet: contiguous tweets того же
   автора. Nested/quoted tweets не становятся thread items. Replies,
   recommendations и чужие tweets остаются за пределами selected window.
2. `MineTwitterTweetContent.extractTweetContentParts()` разбирает каждый
   выбранный tweet article на `mainText`, top-level `media` и `quotes`.

Quote tweet является частью родительского tweet body, а не отдельным элементом
треда. Контракт сохранения:

- основной `tweetText` сохраняется как обычный Markdown;
- media основного post остаётся в top-level media списка;
- quote text/media добавляются в body как Markdown blockquote;
- если syndication API для target tweet возвращает `quoted_tweet`, он
  авторитетнее DOM-preview для quote body, потому что DOM X может обрезать
  quote text;
- media short URL (`t.co`) от quoted media удаляется из quote text, если это
  же media сохраняется как Markdown image/video;
- при fallback на DOM quote определяется структурно: nested tweet article или
  quote card clickable shell с permalink на другой status id внутри target
  tweet article.

Запрещено исправлять quote extraction расширением selector'ов на весь
`document`: комментарии ниже, recommendations и sidebar остаются отдельными
timeline articles и не должны попадать в body.

#### X long-form article extractor

Extractor применяется только к status URL и обязан якориться на target status:
`tweetId` из URL, видимый article/modal/page root, автор/перmalink целевого
поста. Он не читает recommendations, replies, profile bio, action labels или
sidebars как body.

Положительная детекция должна быть явной:

- найден видимый long-form article surface, связанный с target status;
- есть текстовый body, а не только cover/preview image;
- body содержит осмысленную prose-структуру: минимум два paragraph-like блока
  или нормализованный body text достаточной длины для long-form content;
- title/cover/media разрешены только как дополнение к body, не как замена body.

Если long-form surface не найден, extractor возвращает `null`, и управление
переходит в обычный tweet/thread extractor. Если long-form surface найден, но
body не извлечён, результатом является `empty/failed` extraction state; клиппер
не имеет права сохранять cover-only / image-only карточку как статью. Это не
запрещает обычные media-only tweets: они остаются валидным fallback только
когда long-form article surface не был обнаружен.

Markdown output:

- сохраняет порядок media/body по DOM-позиции внутри article surface: cover,
  который находится над текстом, остаётся над текстом; inline media ниже body
  остаётся ниже body;
- сохраняет ссылки как Markdown-ссылки;
- не синтезирует `title:` frontmatter;
- не добавляет текст UI X (`Follow`, `Subscribe`, `Show more`, counters,
  actions);
- использует тот же `ArticleData` для preview и Save.

Startup performance invariant сохраняется: long-form extraction запускается
через `ensureArticleLoaded()` после первого usable paint или перед Save, но не
блокирует открытие popup.

Минимальный тестовый контракт:

- X long-form article fixture возвращает полный body и не превращается в
  image-only Content;
- X long-form article + user selection сохраняет selection как body source;
- обычный tweet остаётся в `extractTwitterThread()` path;
- thread сохраняет только contiguous target thread;
- media-only tweet без long-form surface остаётся валидным media tweet:
  `embeddedVideos` превращаются в markdown body через `resolveContentBody()`,
  а не в отдельный UI-only preview;
- detected long-form shell без body даёт `empty/failed`, а не cover-only save;
- preview body и saved body совпадают через `resolveContentBody()`.

### 3d. Видео из постов X с возрастным ограничением

Такие посты недоступны обоим обычным путям извлечения: публичный
syndication API отвечает анонимному вызову заглушкой `TweetTombstone`, а в
разметке страницы видео живёт под `blob:`-адресом, действительным только внутри
вкладки. В результате заметка сохранялась с текстом и без медиа.

Третий путь включается только когда первые два не дали видео:

1. Content script видит в целевом посте элемент плеера, но ни API, ни разметка
   ссылку не дали, и помечает результат `needsAuthenticatedVideo`.

   «Ссылку не дали» проверяется по наличию непустого `src` среди найденных
   превью, а не по их количеству: `blob:`-источники отбрасываются выше по
   потоку, и запись остаётся в списке с одним постером. Ровно так выглядит
   пост с возрастным ограничением — счёт по длине списка счёл бы его
   разрешённым.
2. Popup при гидратации превью уже спрашивает хост о медиа твита. Если
   публичный ответ пришёл без видео, а пост помечен флагом, тот же запрос
   повторяется через background script — куки доступны только ему.

   Именно при гидратации, а не при сохранении: тогда реальное видео попадает и
   в предпросмотр, и в заметку, и обе поверхности остаются на одном источнике.

   Разрешённые ссылки дописываются в тело как `![](url)`. Одного списка превью
   недостаточно: хост скачивает медиа, читая markdown тела. Для обычных твитов
   эти ссылки складывает ветка публичного API, но пост с ограничением до неё не
   доходит, и без явной дописки видео показалось бы в предпросмотре и пропало
   при сохранении.
3. Background собирает куки `x.com` и `twitter.com` и передаёт их нативному
   хосту вместе со ссылкой на пост.
4. Хост пишет их во временный cookie jar с правами `0600`, вызывает `yt-dlp`
   и удаляет файл сразу после — гарантированно, включая пути с ошибкой.

Вместе со ссылкой запрашивается постер (`--print "%(url)s\t%(thumbnail)s"`).
Без него превью откатывается на `og:image` страницы, а у поста с ограничением
там лежит рекламная карточка X, а не кадр видео.

`yt-dlp` ищется по известным префиксам установки, а не по имени команды.
Браузер запускает хост с минимальным `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`),
куда ни один пакетный менеджер не ставит, поэтому голое имя команды не
разрешается даже на машине, где инструмент прекрасно работает в терминале.
Запись из `PATH` при этом имеет приоритет над догадками.

Работа делегирована `yt-dlp` намеренно. Доставка видео у X — приватный
недокументированный интерфейс, который меняется по их расписанию; отслеживание
этих изменений составляет смысл существования `yt-dlp`, поэтому поломка
чинится его обновлением, а не правкой Mine. Требование к окружению: `yt-dlp`
должен быть установлен, иначе шаг завершается понятной ошибкой, а остальное
сохранение проходит как прежде.

Куки читаются только для доменов X, только когда пост действительно содержит
неразрешённое видео, и нигде не сохраняются.

### 3e. Bluesky

Пост извлекается через публичный AT Protocol API `public.api.bsky.app`. В
отличие от остальных социальных источников здесь не нужны ни сессия, ни разбор
разметки: интерфейс документирован, работает без авторизации и отдаёт запись
поста с прямыми ссылками на медиа в CDN. Ломаться нечему — приватных точек
входа в этом пути нет.

Порядок: из URL берутся автор и ключ записи; handle разрешается в DID через
`com.atproto.identity.resolveHandle` (если в ссылке уже DID, шаг пропускается);
пост запрашивается через `app.bsky.feed.getPostThread`.

Медиа собирается из вложения и из вложения рядом с цитатой: когда пост
одновременно цитирует другой и несёт медиа, его собственное медиа переезжает в
поле `media`. Изображения берутся в размере `fullsize`.

Видео берётся оригинальным файлом, а не плейлистом. Плеер Bluesky получает HLS,
но это производная для потокового проигрывания; загруженный файл лежит блобом в
репозитории автора и отдаётся целиком через `com.atproto.sync.getBlob`. Адрес
блоба — пара «DID автора, хеш содержимого» — читается из ссылки на плейлист,
которая несёт обе половины. Сервер репозитория находится по DID-документу:
`did:plc` через каталог PLC, `did:web` через сам домен. Если адрес определить не
удалось, сохраняется постер — как и раньше.

Ссылка на блоб не содержит расширения, поэтому тип такого файла нигде не
выводится из имени: хост определяет его по `Content-Type` (см. «Article
inline-media pipeline» ниже), а превью — по тому, что извлекатель сам
зарегистрировал источник в `embeddedVideos`. Проверка карты `embeddedVideos`
идёт раньше проверки расширения: то, что извлекатель знает, старше догадки.
Видео попадает в `embeddedVideos` напрямую, минуя `pushVideoUrlPreview`, который
пропускает только ссылки с видео-расширением.

### 4. Image (изображение)

Сохраняет конкретное изображение.

| Field | Source |
|---|---|
| type | `image` |
| url | URL страницы (источник) |
| file | Скачивается по `img.src`; frontmatter writes canonical `[[file]]` |
| width/height | `img.naturalWidth` / `img.naturalHeight` |
| source | `web-clipper` |

Результат: `.md` (compat `type: image`, empty body, `file: "[[...]]"`) + скачанный файл + thumbnail. Runtime card kind derives `media`.
Image clips do not write generated `title:`. Alt/title attributes may be used
as filename seeds or future captions, but not as automatic frontmatter title.

### 5. Video (видеоссылка)

Сохраняет ссылку на видео (YouTube, Vimeo и т.д.).

| Field | Source |
|---|---|
| type | `video` |
| url | URL видео |
| body H1 | `og:title` > `<title>` when this is a real video page title |
| thumbnail | `og:image` |
| source | `web-clipper` |

Результат: `.md` (compat `type: video`, optional body H1 for a real page title) + миниатюра. Page-title videos with body derive `article`; local/anonymous videos with empty body derive `media` and do not get synthetic title.

### 6. File (файл по прямой ссылке)

Сохраняет файл по прямой ссылке (PDF, ZIP и т.д.).

| Field | Source |
|---|---|
| type | `file` |
| url | URL файла |
| file | Скачивается native host'ом; frontmatter writes canonical `[[file]]` |
| source | `web-clipper` |

Результат: `.md` (compat `type: file`, empty body, `file: "[[...]]"`) + скачанный файл. Runtime card kind derives `media`.
File clips use the downloaded filename as identity/fallback label, not as
generated `title:` frontmatter.

### 7. Screenshot (скриншот viewport)

Пользователь вручную переключается в режим Screenshot из TypeSwitcher. Расширение захватывает видимую область вкладки через background-owned `captureForCrop` pipeline, показывает превью в popup и загружает файл в vault через background-owned upload bridge к локальному HTTP-серверу native host (см. Upload Server).

Перед каждым реальным `chrome.tabs.captureVisibleTab(...)` background отправляет content script сообщение `prepareViewportCapture`. Content script скрывает все Mine-owned UI layers (`__mineOverlay`, crop overlay, crop toast) и отвечает только после clean-paint handshake (`requestAnimationFrame` ×2 + timeout fallback). Это обязательный инвариант: ни обычный Screenshot, ни Crop Area не должны вызывать `captureVisibleTab` сразу после `display:none` / DOM removal, потому что браузер может вернуть предыдущий compositor frame с видимым клиппером.

Повторный клик по extension icon при уже открытом overlay не должен заново инжектить `overlay.js`. Background сначала отправляет `showClipperOverlay` существующему listener'у и ждёт `{ok:true}`; новая инъекция разрешена только если listener не отвечает. Иначе в одной вкладке появляются два независимых module scope, и старый overlay host может остаться видимым во время capture.

Instagram feed button is an extension-owned control already running inside an
Instagram content script. It must open the in-page overlay only; detached-window
fallback is not a valid successful outcome for this path. Because clicking that
page-injected button does not grant Chrome/Safari `activeTab` permission,
`dist/overlay.js` is registered as a static content script for
`https://www.instagram.com/*`. The button writes `preloadedClipData` and asks
background for `showOverlayInThisTab`; background must first use the existing
overlay listener and must return failure rather than opening `windows.create`
when overlay is unavailable.

В overlay-context кнопка `Crop Area` запускает page-level crop overlay напрямую через `window.__mineCrop.start()`, который экспортируется из `content.js` в той же isolated world. Background `startCropMode` остаётся fallback для detached/window path. Основной overlay не должен зависеть от того, какой из нескольких `chrome.runtime.onMessage` listeners в вкладке первым обработает `startCropOverlay`.

| Field | Source |
|---|---|
| type | `image` |
| url | URL страницы (для ссылки на источник) |
| file | JPEG/PNG, залит через HTTP upload, pending id передаётся в save_block как `pre_uploaded_id`; frontmatter writes canonical `[[file]]` |
| source | `web-clipper` |

Screenshot clips do not write generated `title:`. If the user explicitly adds a
caption/heading in a future UI, it should be written to Markdown body. Current
empty-body screenshot clips derive runtime card kind `media`.

Почему отдельный HTTP-канал, а не native messaging: Chrome ограничивает native messaging-сообщения 1 МБ, а скриншот Retina-viewport легко выходит за этот порог.

#### Crop Area mode

Скриншот можно захватить не целиком, а выделенной областью. В превью скриншота есть кнопка `Crop Area` рядом с `Retake`. При клике:

1. Popup сериализует всё текущее состояние (метаданные, статью, выбранные коллекции, display heading/body H1 if present, vault, полный скриншот) в `chrome.storage.session` под ключом `cropPendingState` и вызывает `window.close()`.
2. Background получает сообщение `startCropMode` и пересылает `startCropOverlay` в content script активной вкладки.
3. Content script инжектит Shadow DOM overlay: полупрозрачное затемнение на всю страницу, crosshair-курсор, плавающая плашка `Click and drag to select area • Esc to cancel`.
4. Пользователь тянет мышью прямоугольник. Подсветка выделенной области — через трюк `box-shadow: 0 0 0 9999px rgba(0,0,0,0.55)` на самой рамке (одна рамка = «окно в темноту», без четырёх div'ов вокруг).
5. На mouseup при размере ≥ 20×20 px:
   - Content script скрывает selection rectangle и size label до capture request, чтобы UI самого crop-инструмента не попал в итоговый JPEG.
   - Content script просит background захватить viewport; background перед `captureVisibleTab({format:'jpeg',quality:95})` заново выполняет `prepareViewportCapture`.
   - Получает dataUrl, грузит его в `Image`, кропит на `OffscreenCanvas` размером `width × height × devicePixelRatio`, конвертирует результат в JPEG q=0.9.
   - Отправляет background сообщение `cropDone` с обрезанным dataUrl.
6. Background кладёт cropped dataUrl в screenshot upload cache, пишет `{status:"done", dataUrl, screenshotId}` в `chrome.storage.session.cropResult` и вызывает `chrome.action.openPopup()`.
7. Popup при init обнаруживает `cropPendingState + cropResult`, восстанавливает состояние и заменяет превью на обрезанный скриншот. Выбранные коллекции, display heading/body H1 if present, канал и `screenshotId` — всё на месте.

Отмена (Esc до или во время drag'а): content script убивает overlay, пишет `cropResult = {status:"cancelled"}`, background переоткрывает popup. Popup восстанавливает прежний (не кропнутый) скриншот из persisted state.

Условия доступности: кнопка `Crop Area` disabled на страницах, где content script не инжектится — `chrome://*`, `chrome-extension://*`, `view-source:*`, Chrome Web Store. Проверка по `tab.url.protocol` и `hostname`, tooltip показывает причину.

Ключевые инварианты:
- `devicePixelRatio` всегда учитывается при кропе: `captureVisibleTab` возвращает изображение в физических пикселях, координаты рамки — в CSS-пикселях.
- Shadow DOM с `mode: "closed"` изолирует overlay от CSS страницы и наоборот.
- Во время drag'а `document.documentElement.style.overflow = "hidden"` блокирует скролл страницы — иначе координаты рамки уехали бы.
- `z-index: 2147483647` (int32 max) гарантирует, что overlay поверх любого контента страницы.

## Auto-detection Heuristic

Popup выбирает таб по умолчанию в два шага: сначала content script вычисляет `detectedType` страницы, затем popup маппит его в таб TypeSwitcher'а.

### Шаг 1 — `detectedType` (content.js `detectType`)

```
1. Есть непустой selection (window.getSelection)  → "selection"
2. URL — YouTube / Vimeo / youtu.be               → "video"
3. URL — Twitter/X                                → "article"
4. URL — Instagram post                           → "article"
5. isArticlePage (≥2 сигналов: <article>, og:type=article, text>2000) → "article"
6. Иначе                                          → "link"
```

Context-menu клики переопределяют этот выбор в `applyContextMenu` (см. раздел «Context Menu»):
- `save-image`       → `detectedType = "image"`
- `save-selection`   → `detectedType = "selection"`
- `save-link` на твит → `detectedType = "article"`
- `save-link` иначе  → `detectedType = "link"`
- `save-page` + открытый Twitter lightbox → `detectedType = "image"`

**Twitter/X photo lightbox (любая активация).** URL вида
`/<handle>/status/<id>/photo/<n>` открывает одно изображение оверлеем над
твитом. `detectType` классифицирует его как `"article"` (это `/status/`-URL),
поэтому `useClipperState` init после context-menu переопределяет тип в
`"image"` для конкретного N-го фото — при **любом** способе активации
(иконка / попап / overlay), не только через `save-page` ПКМ. Tweet id и индекс
берутся из сырого `tabUrl`: `meta.url` канонизирован X до `/status/<id>` без
`/photo/<n>`. Источник изображения — точное N-е фото из syndication API
(`media_url_https + "?name=large"`, `ext_alt_text`, `original_info`), с фолбэком
на DOM-детектор лайтбокса (`detectTwitterLightboxImage`). Override не
применяется, если context menu уже дал `image`/`selection`. Чистая логика —
`extension/popup/lib/twitterPhotoLightbox.ts`, покрыта
`twitterPhotoLightbox.test.ts`.

### Шаг 2 — Default tab (useClipperState init)

| `detectedType` | Таб по умолчанию | Поведение |
|---|---|---|
| `selection` | **Content** | В превью цитата выделенного текста (см. § Selection) — не потерять этот сценарий |
| `article` | **Content** | Статья / твит / Instagram-пост |
| `video` | **Content** | Видеоблок, транскрипт в body |
| `content` | **Content** | Явный выбор из context menu |
| `image` | **(image-only)** | TypeSwitcher **скрыт**, показывается только превью картинки |
| `link` / всё остальное | **Screenshot** | Автоматически вызывается `captureScreenshot()` при открытии popup |

**Инварианты, которые нельзя потерять:**
1. Selection → Content с цитатой. Проверяется сценарием: выделить текст на странице → нажать иконку расширения → должен открыться Content-таб с цитатой в превью, а не Screenshot.
2. Image-режим (ПКМ на картинке) не показывает TypeSwitcher вообще — пользователь не переключает типы, только сохраняет.
3. Default для «всего остального» — именно Screenshot, не Link. При открытии popup без явного типа расширение сразу делает capture и показывает превью.

### Startup performance contract

Popup/overlay init не ждёт тяжёлый article extraction. Стартовый путь делает только дешёвые операции, необходимые для первого usable paint:

1. `get_status`
2. metadata extraction (`extractMetadata`)
3. context-menu override, если есть
4. выбор default tab + первый screenshot capture для default `Screenshot`
5. `setState("main")`

`extractArticleAsync` запускается только после первого paint и только для
сценариев, которым реально нужен body. Для обычных страниц, которые по эвристике
становятся `link` → default `Screenshot`, Defuddle/readability extraction не
запускается на старте. Это защищает overlay от долгого открытия на DOM-heavy
сайтах.

Если пользователь позже переключился в Content, popup обязан вызвать
`ensureArticleLoaded()` и перейти в явный `loading/ready/empty/failed` state.
Save не имеет права записывать пустую статью ни из `idle`, ни из `loading`, ни
из `empty/failed`.

### Content video preview

Content preview не воспроизводит видео. Content script передаёт в popup `articleData.embeddedVideos` с `src`, `poster`, `title`. Источники, по приоритету: social extractors, которые уже получают media candidates (Twitter/X syndication API, Instagram media API); DOM fallback (`<video>`, YouTube/Vimeo `<iframe>`); meta fallback (`og:video`, `twitter:player:stream`, poster из `og:image` / `twitter:image`). Для YouTube poster вычисляется из video id (`i.ytimg.com/vi/.../maxresdefault.jpg`); для `<video>` берётся `poster` attribute или, если сайт уже держит видимый video frame в памяти, preview-only canvas snapshot с ограниченным размером. DOM `<video>` с runtime-only source (`blob:` / `mediasource:`) не считается canonical video source: такой URL нельзя повторно скачать, сохранить или сопоставить с embed URL, поэтому он не seed'ит отдельный `embeddedVideos` preview и может дать только poster/frame fallback. Если extracted markdown содержит inline video URL (`.mp4`, `.webm`, `.m4v`, `.mov`) в image syntax, popup рендерит lightweight poster preview только если этот `src` ещё не представлен в `embeddedVideos`; одинаковый canonical video `src` должен давать один preview. Poster берётся из `embeddedVideos.poster`, а `metadata.image` / `og:image` используется только как последний fallback для inline video без structured preview. Сам video URL остаётся в markdown/save payload без изменений.

Twitter/X extractor должен считать syndication/API media более авторитетным источником, чем generic DOM video scan. Если API уже дал direct mp4 + `tweet_video_thumb` poster, DOM `<video>` fallback не добавляется в `embeddedVideos`, чтобы blob/player nodes и generic X cards не создавали лишние previews. Поскольку content scripts могут упереться в CORS при чтении syndication API, popup имеет native-host fallback `resolve_twitter_media`: он возвращает тот же direct mp4 / poster contract, который использует save path. Для `animated_gif` popup может заменить API thumbnail на preview-only кадр из direct mp4 с seek к текущему времени DOM video; если frame capture недоступен, используется `tweet_video_thumb`. Это не меняет saved markdown/body и не локализует дополнительный файл.

Twitter/X thread extraction выбирает состав треда до извлечения текста/медиа.
Selection layer обязан якориться на `tweetId` из URL, читать `tweetId` каждого
видимого tweet article из permalink/timestamp и собирать только contiguous
timeline cells вокруг target tweet. Сканирование останавливается на
структурной границе: cell без top-level tweet article, чужой tweet article,
reply composer/section heading, recommendation block вроде `More tweets`.
Текст heading не является source of truth, потому что X локализует UI. Если
target article не найден, extractor сохраняет не больше одного fallback tweet,
а не все твиты автора. Syndication media привязывается именно к target tweet,
не к первому сохранённому tweet в thread window.

`useClipperState` обязан применять async extraction result, если пришёл `content` **или** `embeddedVideos.length > 0`. Preview-only media не должна отбрасываться только потому, что body text пустой или уже был показан раньше.

Инвариант: предпросмотр видео в клиппере — чисто визуальный affordance, не playback surface. Он не должен запускать playback и не должен менять save payload. Любой frame capture должен быть bounded по времени/размеру, работать только как улучшение poster, и иметь fallback на metadata poster без ошибки для пользователя.

Пользователь переключает тип через TypeSwitcher кликом. Tab/Shift+Tab циклит Content → Screenshot → Link **только** когда keyboard focus уже внутри overlay (после клика по overlay) — это known limitation, см. DEVLOG `24.04.2026 — Clipper: Tab-cycling` и решение не дорабатывать. Основной сценарий переключения — клик по табам.

Click-outside close для in-page overlay не должен зависеть только от `click` и `composedPath()` вокруг full-viewport shadow host. `OverlayShell` обязан маркировать реальную панель `data-mine-clipper-panel`, а `overlay-entry` закрывает overlay на `pointerdown` / `mousedown` capture, если координаты события лежат вне `getBoundingClientRect()` панели. Outside-close handler не вызывает `preventDefault` и `stopPropagation`, чтобы клик оставался кликом страницы после закрытия overlay.

Исключение: если overlay временно скрыт через `hideClipperOverlay()` для screenshot capture или Crop Area, outside-close handler не должен закрывать / размонтировать React overlay. Crop drag происходит на странице и обязан вернуться в тот же live state, чтобы cropped `dataUrl` и новый `screenshotId` заменили прежний full-page screenshot перед Save.

In-page overlay должен быть визуально одинаковым на всех сайтах при одинаковом
browser zoom. Shadow DOM защищает от page CSS selectors, но не от `rem`-единиц:
`rem` внутри shadow tree всё равно считается от `document.documentElement`
страницы. Поэтому `overlay-entry.tsx` обязан переопределять Tailwind root tokens,
которые попали в popup bundle в `rem` (`--spacing`, `--container-*`,
`--text-xs/sm/base`) на px-значения внутри `:host`/`#root`. Иначе сайты с
`html { font-size: ... }` меняют размер `p-*`, `gap-*`, `h-*`, `top-*` и
типографику клиппера.

Dropdown/Popup primitives inside in-page overlay must portal into the overlay's
Shadow DOM, not into page `document.body`. `overlay-entry.tsx` creates a
shadow-local floating root and `OverlayShell` provides it through
`DropdownMenuPortalContainerProvider`. Any clipper dropdown that bypasses this
provider is a regression: page body does not contain the clipper stylesheet,
tokens or border fixes.

## Popup UI

### Сборка

Popup собирается через Vite (`vite.extension.config.ts`) как React-приложение, использующее те же компоненты и CSS-токены, что и основное Tauri-приложение. Один источник правды — дрейф дизайна невозможен.

```bash
bun run build:extension   # Собирает popup → extension/dist/ + копирует в Safari Resources
```

Entry point: `extension/popup/main.tsx` → output: `extension/dist/index.html` + бандл.

`extension/dist/` — обязательный runtime bundle, но не source artifact: он
исключён из Git общим правилом `dist/` и всегда воспроизводится из исходников.
Обычные `bun run build`, `cargo tauri dev` и `cargo tauri build` собирают
desktop-приложение и **не** создают bundle клиппера. Поэтому перед первым
`Load unpacked`, после clean checkout/clone или после удаления build outputs
обязательно выполнить `bun run build:extension`.

Минимальный loadable contract:

- `extension/dist/index.html` существует;
- `extension/dist/overlay.js` существует, потому что он указан в
  `content_scripts` manifest;
- `extension/dist/assets/popup.css` и Geist fonts существуют, потому что их
  загружает Shadow DOM overlay.

Если `extension/dist/` отсутствует, Chromium не может загрузить unpacked
extension: запись может перейти в broken state или исчезнуть из списка
расширений. Повторная сборка возвращает файлы, но не переустанавливает удалённое
расширение автоматически. Recovery contract:

1. `bun run build:extension`.
2. Открыть `chrome://extensions/` или `dia://extensions/`.
3. Включить Developer mode и выбрать `Load unpacked` → каталог `extension/`.
4. Проверить `Mine Clipper`, version `0.1.0`, enabled state и service worker.
5. В Dia закрепить Mine Clipper через `Extensions → Pin Extensions…`.

Алиас `@/` указывает на `src/` основного приложения — все компоненты `@/components/ui/*`, утилиты `@/lib/utils`, токены `@/styles/global.css` импортируются напрямую. Tauri-модули исключены через `optimizeDeps.exclude`.

Шрифты (Geist, Geist Mono) копируются в `extension/dist/fonts/` через механизм Vite `publicDir`.

### Layout

```
┌──────────────────────────────────────┐
│ Mine                              ˅  │ ← 40px bright text selector row
├──────────────────────────────────────┤
│ Type:       [Content|Screenshot|Link]│ ← 40px type row
├──────────────────────────────────────┤
│  ┌────────────────────────────────┐  │
│  │ Content / screenshot preview   │  │ ← legacy local rounded card
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │ Search collections...             │  │
│  ├────────────────────────────────┤  │ ← shared CollectionPicker surface
│  │ design                 Connect │  │
│  │ inspiration          Connected │  │
│  └────────────────────────────────┘  │
│  Save to Mine                         │ ← legacy save/status stack
└──────────────────────────────────────┘
```

### Popup Components (React)

Все компоненты используют shadcn/ui примитивы и семантические токены из `global.css`.
Clipper не имеет собственной визуальной компонентной системы: UI обязан
переиспользовать app primitives (`Button`, `Input`, `DropdownMenu`,
`SearchMenuAction`, `CollectionPicker`, `MenuTextTrigger`,
`SegmentedControl`, `QuantizedMenuScrollArea`) или тонкий adapter над ними.
Компонент, который существует только в клиппере и визуально не имеет аналога в
приложении, считается нарушением контракта.

Space selector в клиппере живёт на отдельной строке первого уровня:
`h-10 border-b border-border bg-accent px-2`. Это тот же surface, что нижнее
меню основного приложения. Реальный Radix trigger — не вся строка, а
`MenuTextTrigger surface="clipperHeader"` как compact pill `h-6 rounded-1 px-2`
внутри строки. Суммарно `px-2` строки + `px-2` trigger дают 16px до текста
`Mine`, как у `Type:` во втором уровне. Поэтому dropdown якорится к кнопке, из
которой выпадает, а не к 360px row. Chevron находится внутри этой пули сразу
после имени, стартует как right chevron и при `data-state=open` поворачивается
вниз (`rotate-90`). Текст
bright `text-foreground`; hover/open state пули использует `bg-active`.
Шрифт клиппера остаётся обычным sans `text-base` до отдельного решения о mono.
Справа в этой же строке находится close action через shared
`ChromeCloseButton`, тот же primitive, который используется в chrome
развернутой карточки. Нажатие закрывает текущий popup или in-page overlay тем
же `closeClipper` path, что Escape.

Space dropdown использует существующий `DropdownMenuContent widthRole="selector"`
(`width: min(18rem, available-width)`), `align="start"`, `side="bottom"` и
`sideOffset=4`. Surface dropdown — `bg-accent text-foreground`, то есть тот же
первый уровень, что строка space selector. Список destination spaces внутри
dropdown рендерится через `QuantizedMenuScrollArea` с clipper row token 40px:
высота scroll-зоны всегда равна `padding + N × 40px`, поэтому нижний элемент не
может обрезаться половиной строки.

Type row — отдельная строка `h-10 border-b border-border bg-chrome px-4`. Это
второй уровень клиппера и он использует тот же half-step surface, что верхний
chrome основного приложения. Слева текст
`Type:` (`text-base text-muted-foreground`), справа общий
`SegmentedControl size="clipper"`. Он использует тот же state model, что
`All/Connected`, но с клипперными значениями: outer shell `h-8 w-fit p-[2px]
rounded-1`, selected inner segment `h-7 rounded-[2px] bg-component-fill-inner
text-foreground`. Это даёт ровный 2px inset по вертикали и горизонтали.
Сегменты shrink-to-content: ширина контрола определяется текстом, а не
растягивается на всю ширину popup.

Ниже Type row клиппер сохраняет простой body через единый spacing contract в
`popup-layout.css`: `.mine-clipper-body` задаёт
`--mine-clipper-after-type-gap: 16px` и `--mine-clipper-section-gap: 8px`.
После Type row до первой preview-карточки остаётся 16px; все дальнейшие
разрывы между preview, shared channel picker и save/status stack идут по 8px.
Если Type row скрыт для image-only clip, верхний body inset также равен 8px.
Content preview — `max-h-[280px] overflow-y-auto rounded-1 border border-border
p-2`. Link/Image preview используют тот же локальный
`rounded-1 border border-border` язык, а не edge-to-edge bars. Screenshot
preview — локальная карточка `rounded-1 border border-border bg-accent`, image
`max-h-[220px] w-auto max-w-full rounded-1 object-contain`; внутренний отступ
между screenshot и action row также использует `.mine-clipper-section-stack`
и общий `--mine-clipper-section-gap: 8px`; actions используют `Button size="sm"`
(28px).

Channel picker не имеет собственной clipper-разметки. `ChannelList` является
только adapter `ChannelInfo[] -> TagCount[]` и рендерит общий
`CollectionPicker`. **Порядок коллекций канонический** — ровно тот, что отдал
backend (`list_channels`: sidebar positions, затем positionless-теги): клиппер
не пересортировывает список (бывшая recent/count-приоритезация удалена — во
всех списках коллекций приложения и клиппера один ручной порядок сайдбара).
Используется тот же `SearchMenuInput`
menu-header search row, row/action slot, active state, conditional create row
и keyboard/pointer arbitration, что card Connect menus в основном приложении:
printable keys stay routed to search, `ArrowDown`/`ArrowUp` can reach the
conditional create row, and pointer hover does not auto-scroll the list.
Внутренний список наследует общий `QuantizedMenuScrollArea`, поэтому inline
clipper surface и floating app picker используют один scroll-height contract.
Surface class живёт в `CollectionPicker`
как `COLLECTION_PICKER_CONTENT_CLASS` для Radix floating content и
`COLLECTION_PICKER_INLINE_SURFACE_CLASS` для inline clipper surface. Checkbox
list в клиппере запрещён. Save/status stack остаётся отдельным блоком
`.mine-clipper-section-stack` без separator line; видимый `StatusBar`
сохраняется.

Article preview в popup рендерит полноценный Markdown через `ReactMarkdown` +
`remark-gfm`, но использует отдельную compact preview scale. Это не обрезает
функциональность Markdown-компонентов, а стабилизирует их размер в 360px popup:
body `14/20`, `h1 16/22 600`, `h2 15/21 600`, `h3-h4 14/20 600`.
Content preview не рисует отдельную строку `title` / filename над body: для
коротких tweets и selection это дублирует первый абзац. `title` остаётся только
внутренним save/filename seed и не становится отдельным preview element.

Content extraction never runs on the live DOM with Mine UI attached. Before
Defuddle receives the page, `content.js` creates a sanitized document clone,
removes Mine-owned nodes (`[data-mine-clipper-overlay]`, `[data-la-clip]`) and
adds a `<base href=document.baseURI>` if needed. This clone is also used for
body-text heuristics. The overlay, channel list, Type row, crop UI and injected
Instagram save buttons are never valid article input.

| Component | File | shadcn/ui | Description |
|---|---|---|---|
| PopupApp | `PopupApp.tsx` | — | Корневой компонент, состояния (loading → error → main), Cmd+Enter / Esc |
| PreviewCard | `components/PreviewCard.tsx` | `<Input>` | Thumbnail + editable body H1/display heading when the clip type has a real page/article heading; media-only and selection clips do not synthesize title |
| VaultSelect | `components/VaultSelect.tsx` | `<MenuTextTrigger>`, `<DropdownMenu>`, `<Input>`, `<SearchMenuAction>`, `<QuantizedMenuScrollArea>`, `<ChromeCloseButton>` | Shadow-safe space selector; top-chrome inner pill state, clipper `h-10` row, chevron inside the pill, no current item in menu, row-quantized dropdown height, shared top-right close action |
| TypeSwitcher | `components/TypeSwitcher.tsx` | `<SegmentedControl size="clipper">` | Content / Screenshot / Link in the 40px Type row without height jumps |
| ChannelList | `components/ChannelList.tsx` | `<CollectionPicker>` adapter | Same picker surface and channel-selection component as desktop Connect menus, including quantized scroll list height |
| ScreenshotPreview | `components/ScreenshotPreview.tsx` | `<Button size="sm">` | Legacy rounded screenshot card with always-visible 28px Crop Area / Retake buttons |
| SaveButton | `components/SaveButton.tsx` | `<Button variant="default">` | Полная ширина, без kbd-подсказки (Cmd+Enter handler есть, но не всегда срабатывает из overlay — см. DEVLOG `24.04.2026 — Clipper: Tab-cycling`) |
| StatusBar | `components/StatusBar.tsx` | — | Legacy visible status component below Save |

### Хуки и адаптеры

| Module | File | Description |
|---|---|---|
| useClipperState | `hooks/useClipperState.ts` | Вся бизнес-логика попапа: init, метаданные, каналы, save, недавние каналы |
| messaging | `lib/messaging.ts` | Типизированный адаптер native messaging с таймаутами на все промисы |

### Popup States

| State | UI |
|---|---|
| Loading | Спиннер-анимация (CSS-паттерн основного приложения) |
| Error | Иконка + красное сообщение |
| Main | Все поля заполнены, кнопка Save активна |
| Saving | Disabled кнопка Save |
| Saved | Зелёная строка статуса, автозакрытие через 1.5с |

## Context Menu

Background service worker регистрирует 4 пункта:

| ID | Title | Context | Visible when |
|---|---|---|---|
| `save-page` | Save page to Mine | `page` | Всегда |
| `save-image` | Save image to Mine | `image` | Правый клик по `<img>` |
| `save-selection` | Save selection to Mine | `selection` | Есть выделенный текст |

При выборе пункта открывается popup с предвыбранным типом и заполненными полями.

## Keyboard Shortcuts

| Shortcut | Context | Action |
|---|---|---|
| `Option+A` | Глобальный (настраиваемый через chrome://extensions/shortcuts) | Открыть popup |
| `Cmd+Enter` | Popup | Сохранить (best-effort — из overlay срабатывает не всегда) |
| `Escape` | Popup | Закрыть без сохранения |
| `Up/Down` | Popup, фокус на ChannelPicker | Навигация по каналам |
| `Enter` | Popup, фокус на ChannelPicker | Выбрать/снять канал |

**Known limitation**: keyboard shortcuts работают только когда focus уже внутри overlay. В content-script overlay host (shadow DOM, isolated world) keyboard focus остаётся на странице до явного клика по overlay — это не фиксим, см. DEVLOG `24.04.2026 — Clipper: Tab-cycling в overlay не работает без предварительного клика — won't fix`. Поэтому kbd-подсказки в UI не показываем, чтобы не обещать того, что стабильно не работает.

## Metadata Extraction (Content Script)

Content script извлекает метаданные из DOM текущей страницы.

### Приоритет источников

| Field | Priority |
|---|---|
| url | `link[rel=canonical]` > `og:url` > `window.location.href` |
| page heading seed | `og:title` > `twitter:title` > `<title>`; written as body H1 for link/article clips, not as generated `title:` frontmatter |
| description | `og:description` > `twitter:description` > `meta[name=description]` |
| image | `og:image` > `twitter:image` |
| author | `meta[name=author]` > `article:author` |
| type | `og:type` (для эвристики) |
| favicon | `link[rel=icon]` (отображение в popup, не сохраняется) |

### Defuddle

Используется для Article/Content extraction. Библиотека включена в расширение
(bundled, не CDN), но не грузится как global content script на `<all_urls>`.
Content script запрашивает `ensureDefuddle` у background только перед реальным
Article/YouTube extraction. Это сохраняет быстрый старт popup и не создаёт
vendor warning/error noise на страницах, где пользователь клипер не открывал.

`background.js` инжектит `lib/defuddle.js` через `chrome.scripting` в frame,
из которого пришёл запрос. На время загрузки suppress'ится только известный
vendor warning Temml про quirks mode; остальные warnings/errors не
подавляются. Это loader/adapter concern, а не изменение Defuddle output.

Перед передачей DOM в Defuddle `content.js` создаёт cloned extraction document
и прогоняет его через `MineExtractionDocumentSanitizer`. Sanitizer работает
только с clone, не меняет живую страницу, screenshot/crop/image save и не
использует широкие blacklist-правила вроде "удалить все icon/pixel/logo".
Удаляются только high-confidence non-content images вне protected content
zones (`article`, `main`, `figure`, `picture`, article/content containers):
tracking/beacon/pixel/spacer assets, явно hidden/presentation images и
app-shell assets вроде `template-app-icon.png` без alt/title/caption/link
semantics. Изображения внутри content-zone сохраняются даже при пустом `alt`,
чтобы статьи про иконки, логотипы, pixel art и реальные иллюстрации не
терялись.

Извлекает:
- `title` — заголовок статьи; Mine writes it as first body H1, not as `title:` frontmatter
- `author` / `byline` — автор
- `markdown` / `content` — очищенный article body
- `excerpt` — краткое описание

Readerability эвристика может использоваться только как дешёвый signal для
автоопределения типа; сам extraction source of truth — Defuddle.

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
  "version": "0.1.0",
  "host_api_version": 2,
  "features": ["pending_uploads_v1"],
  "upload_port": 54231,
  "upload_token": "a1b2c3d4e5f6..."
}
```

`features` — capability contract между popup и native host. Screenshot-save
требует `pending_uploads_v1`: без него popup не начинает HTTP upload, чтобы не
создать root-media без recoverable commit state. `upload_port` и
`upload_token` выдаются попапу один раз при инициализации и используются для
заливки бинарных файлов через локальный HTTP-сервер native host (см. Upload
Server).

#### `list_channels`

Список коллекций из vault. Current API name remains `list_channels`.
Values are collection refs from Obsidian page targets, not normalized tags.

Ответ строится как union двух источников:

- promoted channel documents (`type: channel`) из таблицы `channels`;
- collection refs, которые уже используются non-channel блоками.

Пустой promoted channel обязан возвращаться с `block_count: 0`: channel document сам по себе является достаточным источником истины для списка коллекций, даже если watcher ещё не успел посчитать блоки.

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
    { "tag": "Design", "block_count": 42 },
    { "tag": "Красивый веб", "block_count": 15 }
  ]
}
```

Channel list refresh не является одноразовым init-state. Popup грузит список каналов асинхронно, не блокируя первый paint. Если любой открытый clipper context создаёт канал через `create_channel` или сохраняет блок с `Mine Collections` через `save_block`, background рассылает event `mineChannelsChanged`, и остальные открытые overlays повторно вызывают `list_channels`.

Доставка события идёт двумя путями:

- `chrome.runtime.sendMessage` — для detached extension windows;
- `chrome.tabs.sendMessage` — для in-page overlays, потому что overlay живёт как content script внутри вкладки.

`create_channel` returns the collection ref matching the Obsidian page target,
and popup must use that response ref instead of normalizing raw user input.
`create_channel("Красивый веб")` и
`save_block(Mine Collections: ["[[Красивый веб]]"])` должны сходиться на одном
collection ref.

Native host обязан открывать тот же local derived index, что и desktop app:
`~/Library/Application Support/com.mine.app/vaults/<vault-id>/index.db`.
`<vault-id>` читается из `<vault>/.arena/vault-id`; если local derived index
ещё не существует, host может один раз bootstrap'нуть его из legacy
`<vault>/.arena/index.db`. Runtime reads/writes не должны продолжать работать
с legacy `.arena/index.db`, иначе clipper видит stale channels по сравнению с
desktop app.

`list_channels` returns promoted channels + used collection refs from one
index. Legacy normalized tags are migration inputs only.

#### `save_block`

Сохранение блока в vault.

New clipper writes follow [SPEC_DISPLAY_TITLE.md](./SPEC_DISPLAY_TITLE.md):
the request may carry a real page/article heading in `body` as the first H1,
but it must not synthesize `title:` frontmatter for tweets, selections, files,
images, videos, or screenshots. Existing `title` fields in older extension
builds remain a legacy compatibility input only.

```json
{
  "action": "save_block",
  "block_type": "link",
  "description": "Financial infrastructure for the internet",
  "url": "https://stripe.com",
  "body": "# Stripe — Financial Infrastructure\n\nFinancial infrastructure for the internet",
  "tags": ["Design", "Fintech"],
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

Для creation mode `image`:
```json
{
  "action": "save_block",
  "block_type": "image",
  "url": "https://unsplash.com/photo/abc",
  "body": "",
  "tags": ["Photography"],
  "image_url": "https://images.unsplash.com/photo-abc?w=3840",
  "width": 3840,
  "height": 2160
}
```

Native host скачивает `image_url`, сохраняет файл, пишет canonical frontmatter
`file: "[[resolved-name.ext]]"`, upsert'ит local derived index, генерирует
Phase 1 thumbnail и синхронизирует `thumb_format` / `thumb_mtime`. Для AVIF,
HEIC, VP8X WebP и других форматов, которые Rust не декодирует, Phase 1 пишет
PNG placeholder из `fallback_label`; WebView upgrade выполнится при открытом
desktop app.

Инвариант для media creation modes: блок не может быть записан без
разрешённого media. Save считается успешным только если native host получил
`media_file` через `image_url` / data URL / `pre_uploaded_file` либо валидный
`thumbnail`. Если источник отсутствует или скачивание/финализация media не
удались, native host возвращает `ok:false`, а `.md` не создаётся. Это защищает
vault от битых media-карточек без `file:`.

Инвариант для article creation mode: `block_type=article` не может быть записан
с пустым body. Frontend обязан пройти через `ensureArticleLoaded()` и отправить
только non-empty body; native host повторно валидирует это условие и возвращает
`ok:false`, если body пустой. Link creation mode отдельно отправляет body H1 из
реального page title, чтобы новая link-карточка не превращалась в runtime media
только из-за пустого body.

##### Article inline-media pipeline

`block_type=article` со `body`, содержащим `![alt](https://...)` — тяжёлая операция: native host скачивает каждую inline-картинку и переписывает body на Obsidian-wikilink `![[name|alt]]`. Реализовано как **three-phase алгоритм** в `localize_body_images` ([src-tauri/src/bin/native_host.rs](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/bin/native_host.rs)):

1. **Phase A — scan_inline_tasks**: проход по body, парсинг каждого `![alt](url)`, расчёт детерминистичного per-kind индекса (image/video/file), формирование `Vec<InlineTask>`. Cap: `MAX_INLINE_IMAGES = 30`. Тип файла берётся из расширения в ссылке; если ссылка расширения не несёт (API-адреса вроде `com.atproto.sync.getBlob`), выполняется HEAD-запрос и тип определяется по `Content-Type`. Проба передаётся параметром, поэтому сама функция остаётся чистой, а сеть задействуется только на пути сохранения и только для таких ссылок. Если проба не дала ответа, действует прежнее допущение `jpg`.
2. **Phase B — run_parallel_downloads**: фиксированный пул из `MAX_PARALLEL_DOWNLOADS = 3` worker-thread'ов скачивает задачи через shared `VecDeque` queue. Per-domain ограничение `MAX_PER_DOMAIN = 2` через `DomainLimiter` (Mutex+Condvar) — защита от 429 при инлайне с одного CDN. Per-request `INLINE_REQUEST_TIMEOUT = 15s` на каждый `ureq.call()`.
3. **Phase C — apply_rewrites**: dedup через `files_identical` byte-comparison (оставляем самый ранний по порядку, второй удаляем с диска); rewrite-specs строятся против оригинального body (range + replacement) и применяются в **обратном порядке offset'ов**, чтобы не сбивать смещения. Failed downloads оставляют remote URL в body (рендерится через CSP `img-src https:`).

Архитектурный инвариант: `.md` записывается **одним атомарным write** после Phase C — Obsidian видит либо ничего, либо полностью локализованную статью. Промежуточного состояния «.md существует, но картинки ещё качаются» **нет**.

Потолок на размер файла — `MAX_MEDIA_BYTES = 500 МиБ`. Он рассчитан на то, что люди реально сохраняют: прежние 50 МиБ отсекали обычный ролик 1080p, и заметка молча оставалась со ссылкой на чужой сервер — то есть переставала быть самодостаточной и ломалась насовсем, стоило источнику удалить файл. Если видео всё же не помещается, клиппер передаёт в `video_posters` постер, хост сохраняет его как `thumbnail` блока, а лента строит карточку из постера (ветка `CardKind::Article` без локальных плиток). Видео при этом остаётся удалённой ссылкой и играет только при наличии сети — это осознанная деградация, а не норма.

Заметки, испорченные прежним потолком, чинятся разово: `cargo run -p mine --bin localize-remote-media -- --dry-run <vault>` показывает, что осталось удалённым, `--apply` докачивает и переписывает ссылки на wikilink. Перед загрузкой выполняется HEAD: тело статьи содержит и ссылки-сокращалки (`t.co`), которые ведут на страницу, а не на медиа, и скачивать их нельзя.

Native messaging timeout — action-aware: `save_block = 180_000ms`, остальные actions = `30_000ms` ([extension/background.js:285](file:///Users/i_iii/Проекты/local-arena/extension/background.js)). Зеркально в [popup/lib/messaging.ts:22](file:///Users/i_iii/Проекты/local-arena/extension/popup/lib/messaging.ts) (`save_block = 180_000`, остальное = `10_000`). Worst case: 30 inline × 15s × 3 retry / 3 параллели ≈ 150s, 180s — буфер.

Per-kind индексы могут содержать gap'ы при failed/dup (например, `image 1, image 3`) — функционально допустимо, UX-вопрос (tight numbering — backlog).

#### `create_channel`

Создание нового канала.

```json
{
  "action": "create_channel",
  "tag": "new-topic"
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

## Upload Server (HTTP)

Chrome ограничивает отдельное native messaging-сообщение 1 МБ. Скриншот Retina-viewport после JPEG-сжатия легко занимает 1-3 МБ, и данные не помещаются в протокол stdin/stdout. Поэтому native host при старте поднимает локальный HTTP-сервер для бинарных загрузок.

### Lifecycle

1. При старте native host привязывает TCP-listener к `127.0.0.1:0` (ОС выбирает свободный порт).
2. Генерирует случайный 64-символьный hex-токен из 32 байт OS entropy (`generate_token()` через `getrandom`).
3. Запускает `tiny_http::Server` в отдельном потоке.
4. Порт и токен возвращаются попапу в ответе `get_status`.
5. Сервер живёт до завершения процесса native host (завершается, когда Chrome закрывает канал stdio).

### Endpoint `POST /upload`

- `Authorization: Bearer {token}` — обязательный заголовок, несовпадение → `403`
- `Content-Type` — MIME-тип файла (`image/jpeg`, `image/png`, и т.д.)
- Query `?filename=<name.ext>` — имя файла (используется санитайзер на стороне хоста)
- Query `&vault_path=<absolute path>` — целевой vault для staging upload. Обязателен для новых extension builds: HTTP upload и последующий `save_block` должны работать с одним и тем же vault, даже если пользователь переключал пространство или native host был запущен до переключения.
- Body — сырые байты файла (не base64), максимум `25 MiB`; превышение возвращает `413`

Успешный ответ:
```json
{
  "ok": true,
  "filename": "pending:8f7e0a91d9b44d0cb1e6f52bb612ab8d",
  "upload_id": "8f7e0a91d9b44d0cb1e6f52bb612ab8d",
  "size": 1843231
}
```

Файл сохраняется не в source vault, а в local derived store:
`<derived_root>/pending_uploads/<upload_id>/`. Upload endpoint не создаёт
пользовательский media-файл до успешного `save_block`. Это закрывает отказ
между HTTP upload и native-message commit: если вторая фаза не дошла до
создания `.md`, Mine показывает pending upload в recovery surface.

Поле `filename: "pending:<id>"` оставлено как compatibility bridge для старых
popup build'ов, которые ещё передают только `pre_uploaded_file`.

### Интеграция с `save_block`

После успешного upload popup передаёт `upload_id` в `save_block` через
`pre_uploaded_id`. Native host копирует pending payload в source vault под
финальным именем `<slug>.<ext>` с create-new semantics, затем пишет `.md`.
Pending manifest помечается committed только после успешной записи блока.
Повторный `save_block` с тем же `pre_uploaded_id` после успешного commit
идемпотентно возвращает уже созданный slug.

После source-vault commit native host best-effort обновляет local derived index
тем же `upsert_block` контрактом, что и desktop watcher, затем создаёт Phase 1
thumbnail и пишет thumbnail metadata в SQLite. Если SQLite занят запущенным
приложением, сохранение не откатывается: `.md` и media уже являются source of
truth, а watcher/startup scan догонят индекс и thumb metadata. При выключенном
desktop app этот upsert должен проходить сразу, поэтому новый клип появляется
в ленте после запуска без ручного rebuild.

Legacy `pre_uploaded_file` продолжает поддерживаться: если значение начинается
с `pending:`, оно трактуется как pending upload id; иначе native host ожидает
старый root-staged файл и финализирует его прежним путём.

Если background service worker потерял in-memory cache и upload вернул `Screenshot upload expired`, popup ре-кэширует уже имеющийся `dataUrl` и один раз повторяет upload без нового screenshot capture. Остальные upload-ошибки (`timeout`, PNA/loopback отказ, сервер upload не настроен) показываются inline через `StatusBar`; popup остаётся в основном UI, а превью, выбранные коллекции, display heading/body H1 if present, vault и кнопки `Save` / `Retake` сохраняются. Такие ошибки не переводят popup в full-screen `ErrorState`, потому что пользователь должен иметь возможность повторить сохранение без повторного сбора контекста.

Если HTTP upload успешен, но `save_block` возвращает ошибку или теряет ответ,
popup один раз повторяет `save_block` с тем же `pre_uploaded_id`. Если retry
тоже падает, popup показывает inline notice: медиа уже recoverable в Mine, но
карточка не создана автоматически.

### Browser-origin boundary

В overlay-режиме UI клиппера выполняется внутри content-script context текущей страницы. Поэтому popup/overlay **не делает** `fetch("http://127.0.0.1:...")` напрямую: в Safari такой запрос считается loopback-доступом со стороны origin страницы (`store.epicgames.com`, `example.com`, и т.д.) и вызывает per-site prompt `Allow <site> to access your loopback network?`.

Правильный contract:

1. `background.js` владеет transient in-memory screenshot upload cache и выдаёт popup/overlay короткий `screenshotId`;
2. popup/overlay держит `dataUrl` для preview; happy-path save передаёт в background только `screenshotId`, имя файла, vault path, порт и token;
3. `background.js` как trusted extension context делает единственный HTTP `POST /upload` на `127.0.0.1` и указывает `vault_path` в query;
4. content/page origin не участвует в loopback request path;
5. пользователь не должен подтверждать loopback-доступ для каждого нового сайта при сохранении скриншотов;
6. большой screenshot не передаётся повторно из popup/overlay в background на happy path; исключение — один retry после `Screenshot upload expired`, потому что MV3 service worker может быть перезапущен браузером между capture и Save.

```json
{
  "action": "save_block",
  "block_type": "image",
  "pre_uploaded_id": "8f7e0a91d9b44d0cb1e6f52bb612ab8d",
  "tags": ["reference"]
}
```

### Recovery surface

Desktop app exposes unfinished clipper work through `list_clipper_recovery_items`.
The list contains:

- `pending_upload` — binary payload exists in derived store, no committed block.

`recover_clipper_pending_upload` creates an empty-body media card from the
pending payload. `discard_clipper_pending_upload` removes only a pending
derived-store payload. Recovery does not scan source-vault media files and does
not infer cards from user media that lacks Markdown.

### Безопасность

- Слушает только `127.0.0.1`, не доступен извне.
- Одноразовый токен, сгенерированный при каждом запуске, — защита от локальных процессов, которые не знают токен.
- Имена файлов санируются (запрещены `..`, `/`, `\`).
- Remote media fetch принимает только `http`/`https`, парсит URL через `url::Url`, отклоняет `localhost`, loopback/private/link-local/multicast/unspecified IPs и DNS-имена, которые резолвятся в такие адреса.
- Расширение получает `host_permissions: ["http://127.0.0.1/*"]` в manifest — этим правом пользуется background/service worker, а не content-script overlay.

## Native Host Binary

### Расположение

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/com.mine.app/clipper/native-host` |

`~/Library/Application Support/LocalArena/native-host` — legacy path. Chrome
manifest для актуального клиппера не должен ссылаться на него: при обновлении
native host source of truth — `com.mine.app/clipper/native-host`.

### Manifest (Chromium)

Файлы:

- Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.localarena.clipper.json`
- Dia: `~/Library/Application Support/Dia/User Data/NativeMessagingHosts/com.localarena.clipper.json`

Оба manifest используют один protocol name и один установленный native-host
binary. `allowed_origins` обязан содержать фактический ID unpacked extension;
для текущего checkout это `mfmocklgopobknfgeedgdlnchfohicii`.

```json
{
  "name": "com.localarena.clipper",
  "description": "Mine Web Clipper",
  "path": "~/Library/Application Support/com.mine.app/clipper/native-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<extension-id>/"
  ]
}
```

### Manifest (Safari)

Safari использует `SFSafariExtensionHandler` + App Group для native messaging. Бинарник тот же, но вызывается через XPC-обёртку внутри Safari App Extension.

Implementation status 03.05.2026: Xcode scaffold существует, но
`SafariWebExtensionHandler` ещё не прокидывает protocol messages в Rust native
host. До отдельной Safari bridge implementation production save path считается
Chrome/native-host only.

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
| `url` | Разбор и классификация remote media URL перед fetch |
| `getrandom` | Случайный upload token |
| `tiny_http` | Локальный HTTP-сервер для бинарных upload'ов (скриншоты, крупные файлы) |
| `base64` | Декодирование data URL |

### Vault Path Discovery

Native host читает путь к vault из файла конфигурации основного приложения:

```
~/Library/Application Support/com.mine.app/config.json
```

Этот файл создаётся основным приложением при select_vault. Поле `vault_path` содержит абсолютный путь к текущему vault; `known_vaults` используется для выбора vault из popup. Если конфиг отсутствует, standalone fallback — `~/Mine`.

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
| Media source missing | media creation request не создаётся. Popup показывает inline error, main UI остаётся открытым |
| Media download/finalize failed | Response: `{"ok": false, "error": "..."}`. `.md` не создаётся, чтобы не получить битую media card без `file:` |
| Link/video thumbnail download failed | Блок может быть создан без thumbnail; media failure для preview не ломает сохранение самой ссылки/видео |
| Screenshot upload failed | Popup показывает inline error в `StatusBar` и сохраняет preview/tags/display heading для retry |
| Screenshot upload succeeded but `save_block` failed | Popup делает один retry. Если retry не помог, pending upload остаётся в recovery surface; source vault не получает незакреплённый media-файл |
| SQLite locked | Retry через 100мс, до 3 попыток. Затем ошибка |
| Disk full | Ошибка записи файла. Response: `{"ok": false, "error": "Failed to write file: ..."}` |
| Invalid URL | Блок создаётся, URL сохраняется as-is |

## File Structure

```
extension/
├── manifest.json           # Manifest V3
├── background.js           # Service worker: context menus, native messaging
├── content.js              # Content script: metadata extraction, lazy Defuddle request
├── popup/                  # React popup (исходники, собирается Vite)
│   ├── index.html          # HTML entry point для Vite
│   ├── main.tsx            # React entry point
│   ├── popup-layout.css    # @import global.css + popup-размеры (360x600)
│   ├── PopupApp.tsx        # Корневой компонент (loading/error/main)
│   ├── components/
│   │   ├── PreviewCard.tsx  # Thumbnail + display heading input
│   │   ├── TypeSwitcher.tsx # Content / Link переключатель
│   │   ├── ChannelList.tsx  # Поиск + список каналов
│   │   ├── SaveButton.tsx   # Кнопка сохранения
│   │   └── StatusBar.tsx    # Статус (success/error)
│   ├── hooks/
│   │   └── useClipperState.ts  # Вся бизнес-логика попапа
│   └── lib/
│       └── messaging.ts    # Типизированный адаптер native messaging
├── dist/                   # Собранный попап (output Vite)
│   ├── index.html
│   ├── assets/             # JS + CSS бандлы
│   └── fonts/              # Geist, Geist Mono (WOFF2)
├── lib/
│   ├── defuddle.js         # Bundled Defuddle article extractor, injected on demand
│   ├── twitterThreadSelection.js
│   ├── twitterTweetContent.js
│   └── xLongformArticleExtraction.js
└── icons/
    ├── icon-16.png
    ├── icon-24.png
    ├── icon-32.png
    ├── icon-48.png
    ├── icon-128.png
    └── clipper-overlay-32.png

src-tauri/src/bin/
└── native_host.rs          # Native messaging host (Rust binary)
```

## Icon Contract

Toolbar icon и in-page overlay используют разные assets.

| Surface | Contract |
|---|---|
| Extension toolbar / manifest icons | Square PNG with transparent background. `action.default_icon` ships `16`, `24`, `32`, `48`, `128`; Chrome toolbar renders 16 DIP and chooses the best raster for device scale. The visible mark is an inset white circle with a centred black lowercase `m` from Redaction 100 Italic. This is not app icon and not squircle |
| Instagram feed overlay button | Content script рисует круглую белую кнопку `34x34px` с белой обводкой и вставляет внутрь `icons/clipper-overlay-32.png` как glyph `28x28px` |

Instagram-кнопка версионируется через `data-la-clip-version`. Если старый
content script уже вставил кнопку без текущей версии, новый scan обязан удалить
её и создать заново, иначе Safari/Chrome оставят устаревший визуальный asset до
перезагрузки страницы.

Клик по Instagram-кнопке не открывает detached popup window. Это overlay-only
surface: данные поста предзагружаются в `chrome.storage.session`, после чего
страница показывает тот же Shadow DOM overlay, что и toolbar/context-menu path.

## Manifest V3

```json
{
  "manifest_version": 3,
  "name": "Mine Clipper",
  "version": "0.1.0",
  "description": "Save links, articles, and images to Mine",
  "permissions": [
    "contextMenus",
    "activeTab",
    "nativeMessaging",
    "storage"
  ],
  "action": {
    "default_popup": "dist/index.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "24": "icons/icon-24.png",
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
      "js": ["lib/readerable.js", "lib/readability.js", "lib/turndown.browser.umd.js", "content.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": [
        "icons/icon-32.png",
        "icons/clipper-overlay-32.png"
      ],
      "matches": ["<all_urls>"]
    }
  ],
  "commands": {
    "_execute_action": {
      "suggested_key": {
        "default": "Alt+A",
        "mac": "Alt+A"
      },
      "description": "Open Mine Clipper"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
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
| 5 | save_block image | Загружает файл, генерирует thumbnail, синхронизирует thumb metadata |
| 6 | save_block с новыми коллекциями | `Mine Collections` wikilinks добавляются в frontmatter |
| 7 | list_channels | Возвращает каналы из индекса |
| 8 | create_channel | Создаёт канал, возвращает collection ref |
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
| 8 | Create collection | Ввод нового имени → создание канала |
| 9 | Save + auto-close | Сохранение → зелёная галочка → закрытие |
| 10 | Error state | Нет vault → сообщение об ошибке |
