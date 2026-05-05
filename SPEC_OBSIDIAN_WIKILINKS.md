# Obsidian Wikilinks Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md)

## Goal

Зафиксировать контракт использования Obsidian-style wikilink syntax
`![[name]]` / `![[name|alt]]` в теле markdown-файлов vault'а для
локально-сохранённых медиа, and `file: "[[name]]"` in frontmatter for primary
media files. Canonical форма на write path, backward compatible на read path,
опциональная migration для legacy блоков.

## Motivation

Markdown spec `![alt](url)` использует круглые скобки как URL
delimiters. Имена файлов с пробелами и круглыми скобками
(`Title (image 1).jpg`) ломают эту форму: парсер CommonMark
обрывает URL на первом `)` внутри имени, остаток текста утекает в
rendered контент.

Phase 18.F.1 ввёл percent-encoding (`Title%20%28image%201%29.jpg`)
как обходное решение. Но encoding создаёт архитектурный разрыв:

```
URL_in_markdown_body ≠ filename_on_disk
```

Каждый consumer body markdown должен был декодировать URL перед
использованием его как filesystem path. Этот invariant
неформализован — легко пропустить при любом изменении body-parsing
кода. Подтвердили на практике: 18.F.2 и 18.F.3 — две hotfix cascade
для одной и той же проблемы.

Obsidian wikilink `![[name]]` использует `]]` как closing delimiter,
который не встречается в filenames на supported platforms. Внутри
`[[...]]` разрешены пробелы, круглые скобки, Unicode, все `[` и `|`
(с conventional значением). Parser однозначно находит `]]`, URL
извлекается как есть, совпадает с filename. Invariant `URL ≡ filename`
восстановлен.

Плюс Obsidian использует этот же syntax как canonical, поэтому raw
markdown source идеально читается в Obsidian preview и Obsidian
source view.

## Syntax

### Embed (inline media)

```
![[name]]
![[name|alt text]]
```

- `name` — relative filesystem path от vault root. Для flat Mine
  vault это просто имя файла, без ведущего слэша.
- `alt` опциональный alt/caption, separator `|`.

### Plain link (non-embed text link)

```
[[name]]
[[name|display]]
[[name#^block-id]]
[[name#^block-id|display]]
```

- Рендерится как ссылка (не embed) на другой блок.
- Mine в текущей версии не создаёт plain wikilinks сам; они
  распознаются для совместимости с user-authored markdown и Obsidian.
- `#^block-id` is an Obsidian block-reference fragment. It identifies a
  Markdown block inside the target note and must be preserved by parsing,
  rendering, related-note metadata, and rename rewrites.

### Frontmatter primary media

```yaml
file: "[[name.ext]]"
```

- Canonical write form for new primary media references.
- The value is a quoted Obsidian wikilink string.
- Legacy raw form remains valid on read:

```yaml
file: name.ext
```

Parser normalizes both forms to the same resolved media reference in the
indexed read model.

### Reserved characters

- `]]` — forbidden внутри `name` или `alt`. Writer делает fallback
  на percent-encoded markdown form при появлении `]]` в имени.
- `|` в `alt` экранируется как `&#124;` чтобы не split wikilink.
- `\n` в `alt` collapse'ится в пробел.

## Contract

### Write path (backend canonical)

**`src-tauri/src/bin/native_host.rs :: build_inline_wikilink`** —
единственная функция, которая генерирует wikilink syntax при
сохранении блока. Используется в `localize_body_images` при записи
downloaded inline media в body.

Правила:

1. Новые клипы всегда используют wikilink для local downloaded media.
2. Internal URLs (http://, https://), которые не download'ятся (fail
   или skipped), остаются в `![alt](url)` форме.
3. Alt text preserved через pipe separator; пустой alt даёт `![[name]]`.
4. Pathological filenames с `]]` внутри — fallback на
   `![alt](encoded-url)` через `encode_markdown_url_component`.

Primary media writes use the same Obsidian filename identity in frontmatter:

- native host and app write paths serialize `frontmatter.file` as
  `file: "[[name.ext]]"`;
- `thumbnail` remains a normal derived/metadata filename field unless a
  specific thumbnail wikilink migration is introduced later;
- writer must not mirror a primary media file into body just to make a media
  card render.

### Read path (oba syntax)

Любая функция, извлекающая media references из body, обязана
поддерживать оба syntax:

1. `![[name]]` / `![[name|alt]]` — canonical wikilink
2. `![alt](url)` — legacy markdown (и для remote URLs)

Поддержка реализована через:

- `storage::index::iter_inline_media_sources(body)` — основной
  iterator, возвращает sources в document order в filesystem form
  (decoded).
- `storage::index::parse_inline_media_src(line)` — line-level parse
  для `extract_social_preview_tiles`.
- `storage::media_dimensions::collect_body_media(body)` — собирает
  имена для чтения размеров файлов.

Каждая из них обрабатывает оба syntax независимо, возвращает
filesystem-form строку (wikilink name as-is, markdown URL percent-decoded
если local, remote URL как есть).

Frontmatter `file` read path must likewise support both canonical
`[[name.ext]]` and legacy `name.ext` through the shared media resolver.

### Render path (frontend)

**`src/lib/markdownWikilinks.ts :: preprocessWikilinks(body)`** —
единственная функция, преобразующая wikilinks в стандартный markdown
для react-markdown + remark-gfm.

Правила:

1. `![[name]]` → `![](encoded-name)` — embed без alt
2. `![[name|alt]]` → `![alt](encoded-name)` — embed с alt
3. `[[name]]` → `[name](encoded-name)` — text link без display
4. `[[name|display]]` → `[display](encoded-name)` — text link с display
5. Пустые wikilinks (`![[]]`, `[[]]`) отбрасываются silent
6. Обычный markdown проходит без изменений
7. Block-reference fragments preserve the target string before render
   encoding: `[[note#^id]]` becomes a normal link whose href still carries
   `#^id`.

Percent-encoding применяется **только** на render boundary, не в
source файле. Пользователь, смотрящий raw `.md` в Obsidian или Finder,
всегда видит read-friendly wikilink форму.

Вызывается в `Detail.tsx` перед `<ReactMarkdown>`, memoized per body.
Card preview (`stripMarkdown` в `cardLayout.ts`) отдельно
обрабатывает wikilinks — embed strip'ается полностью (не prose),
text link collapse'ится в display text.

### Migration path

**`src-tauri/src/bin/migrate_body_to_wikilinks.rs`** — opt-in CLI tool.

```
migrate-body-to-wikilinks --dry-run <vault-path>
migrate-body-to-wikilinks --apply   <vault-path>
```

Rewrites legacy `![alt](percent-encoded-local-url)` в `![[decoded-name|alt]]`
для каждого `.md` файла в vault root.

- Remote URLs (http://, https://) не трогаются.
- Already-wikilink entries не трогаются (idempotent).
- Frontmatter не трогается.
- Pathological filenames с `]]` — fallback, оставляют markdown form.
- `--dry-run` показывает changes без записи; `--apply` commits.
- Backup responsibility — на пользователе (git, iCloud, Time Machine).

Transformation — pure function `domain::markdown::convert_markdown_images_to_wikilinks`.
Stable: applying дважды даёт тот же результат (idempotent).

### Frontmatter `file` migration

The media-contract migration for existing content rewrites only the
frontmatter `file` field:

```diff
- file: image.png
+ file: "[[image.png]]"
```

It must not rewrite body bytes. Existing singleton embed bodies such as
`![[image.png]]` remain body content and therefore derive `article` runtime
kind. New inline-media extraction creates an empty-body media-card with
`file: "[[image.png]]"` instead of writing a singleton embed body.

## Invariants

1. **URL ≡ filename**: в body файл ссылается внутри `[[...]]`
   по своему on-disk имени, без encoding. Consumer может делать
   `vault_root.join(name)` напрямую.
2. **Obsidian compat**: raw `.md` читается в Obsidian source view
   без артефактов encoding.
3. **Render invariance**: после `preprocessWikilinks` парсер видит
   standard markdown. Никаких custom extensions в рендер pipeline.
4. **Backward compat**: existing блоки с `![alt](url)` читаются без
   миграции. Mix двух форм в одном vault — supported forever.
5. **Idempotent migration**: `migrate-body-to-wikilinks --apply`
   дважды подряд — второй раз no-op.
6. **Block-reference preservation**: `#^block-id` fragments are part of the
   human-readable link target and must survive parse/render/rename. In-app
   rename rewrites only the note target: `[[Old#^id]]` → `[[New#^id]]`.
7. **Primary media canonicalization**: new `file` writes use quoted Obsidian
   wikilinks; legacy raw `file` values continue to read without migration.

## Testing plan

### Backend unit tests

- `native_host::tests::wikilink_*` (7 tests) — build_inline_wikilink
- `storage::index::tests::extract_*_wikilink*` (7 tests) — dual-syntax
  extraction, mixed bodies, malformed input
- `domain::markdown::tests` (15 tests) — migration transformation,
  idempotency, remote preservation, pathological fallback

### Backend integration

- `migrate_body_to_wikilinks::tests` (3 tests) — frontmatter split
- End-to-end `cargo test --bin native-host` — 29/29 including H.1
- End-to-end `cargo test --lib` — 372/372

### Frontend

- `markdownWikilinks.test.ts` (11 tests) — preprocessWikilinks
  covers: all syntax variants, encoding, Unicode, multi-link body,
  ordinary markdown passthrough

### Manual QA

1. Новый twitter-клип с видео — `.md` содержит `![[name (video 1).mp4]]`,
   видео рендерится в Detail.
2. Новая статья с embedded images — wikilinks для всех embed'ов.
3. Existing block (pre-18.H.1) — продолжает рендериться корректно.
4. `migrate-body-to-wikilinks --dry-run` на realistic Mine vault —
   показывает список ожидаемых изменений.
5. `migrate-body-to-wikilinks --apply` + reload — блоки отображаются
   идентично до migration, raw source в Obsidian выглядит чисто.

## Acceptance criteria

- [x] Backend writer на wikilink syntax (18.H.1)
- [x] Backend extractors dual-syntax (18.H.1)
- [x] Frontend preprocessor (18.H.2)
- [x] Detail integration (18.H.2)
- [x] Migration CLI (18.H.3)
- [x] SPEC document (18.H.4)
- [ ] Manual QA на realistic Mine vault (user action после deploy)

## Known residuals

- Mine CLI не делает автоматическую миграцию при open vault.
  Пользователь запускает `migrate-body-to-wikilinks` explicit когда
  хочет унифицировать vault.
- Pathological filenames с `]]` (практически невозможно на APFS/HFS+)
  остаются в markdown form — edge case принят.

## Assumptions

- `.md` файлы имеют frontmatter `---\n...\n---\n` fence пос всем
  pre-existing convention.
- Vault flat — inline media лежат в vault root, без вложенных папок.
- wikilink parser в Mine совпадает с subset Obsidian parser:
  double brackets для wikilink, pipe separator для alt/display,
  leading `!` для embed.
