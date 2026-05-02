# Identity Robustness Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md)

## Goal

Укрепить текущую filename-based модель идентичности блоков против реальных сценариев, при которых она сейчас теряет identity:

- in-app rename внутри Mine;
- rename `.md` файла в Obsidian или Finder;
- iCloud sync conflict files;
- Unicode normalization mismatch (NFC vs NFD) между устройствами;
- slug collision при clip'е второго блока с тем же H1/readable seed.

**Не меняется:**

- идентичность блока остаётся производной от имени `.md` файла (`file_stem`);
- никаких служебных UUID, `id`, `slug` полей не добавляется во frontmatter;
- `.md` файл остаётся чистым, human-readable markdown — принцип Markdown First сохраняется строго;
- Obsidian wikilink compatibility без изменений.

## Problem statement

Текущий контракт (`src-tauri/src/storage/files.rs:38`):

```rust
pub fn read_block_file(path: &Path) -> Result<(String, String)> {
    let slug = path.file_stem()...;
    ...
}
```

`slug = file_stem` делает identity:

- **mutable**: rename файла = смена identity;
- **collision-prone**: два блока с одинаковым заголовком получают суффикс `-2` в имени файла;
- **normalization-sensitive**: `закат-в-токио.md` на HFS+ (NFD) и APFS (NFC) могут не совпадать byte-level;
- **duplicate-prone**: iCloud conflict `sunset-tokyo (conflict).md` создаёт второй блок с тем же контентом.

Последствия для пользователя:

- rename `sunset-tokyo.md` → `закат-токио.md`: thumb cache orphan, audio position потерян, wikilinks в других `.md` ломаются;
- iCloud conflict: в vault появляется дубликат блока, пользователь не понимает, что это тот же контент;
- clip того же Twitter поста дважды: файлы `spotted-in-prod.md`, `spotted-in-prod-2.md`, `spotted-in-prod-3.md` засоряют vault.

## Scope

Входит в scope:

- явная in-app команда `rename_block_file(old_slug, new_stem)`;
- rename detection через content hash сопоставление в watcher;
- iCloud conflict detection и явный UX разрешения;
- NFC нормализация на всех boundary (watcher, scan, clipper);
- slug collision UX: semantic suffix вместо `-N`.

Не входит в scope:

- `id` / `uuid` / `slug` поле во frontmatter;
- sidecar `.meta.json` файлы;
- extended attributes (xattr) для идентификации;
- move в subfolder vault (остаётся flat-structure требованием);
- migration существующих `-2`, `-3` файлов (backfill tool — отдельный follow-up).

## Invariants

### Identity invariants

1. Identity блока выводится только из `file_stem` `.md` файла.
2. Identity stable для immutable контента: если `.md` файл не менялся и не был перемещён, slug гарантированно тот же при каждом scan.
3. Rename файла без изменения body содержимого **не создаёт** новый блок в DB — существующая запись обновляется.
4. iCloud conflict file (`<name> (conflict).md`) **не создаёт** второй блок автоматически — требуется user decision.
5. In-app rename через Mine — канонический smart path: `.md` файл переименовывается, Mine-owned media rename-family переименовывается, wikilinks и file references переписываются по vault.
6. External rename через Finder / Obsidian сохраняет identity и derived artifacts, но **не** переписывает другие `.md` файлы и не переименовывает source media.

### Markdown First invariants

7. `.md` файл не содержит служебных полей идентификации.
8. Obsidian может открыть любой блок Mine, увидеть только человекочитаемые поля (`Mine Collections`, `saved_at`, `url`, body H1, и т.д.); `frontmatter.title` остаётся legacy metadata, а не обязательным новым полем.
9. Wikilinks `[[sunset-tokyo]]` работают в Obsidian без Mine-specific processing.
10. In-app rename меняет filename stem only: it must not synthesize or rewrite
    `frontmatter.title`, and it must not edit body H1. External rename через
    Finder / Obsidian также не меняет title/H1.

### Watcher invariants

11. `notify` события `Remove` и `Create` в одном debounce окне с совпадающим content hash трактуются как rename, не как delete + create.
12. Rename detection работает только в пределах одного vault root — не корректирует cross-vault moves.
13. Content hash считается по **body после frontmatter**, чтобы rename с одновременной правкой тела не давал false positive.
14. In-app rename suppress'ит собственные watcher path events на короткое TTL-окно, чтобы source rewrite + file rename не re-enter'или watcher как внешние мутации.

## Architecture

### In-app rename

**Компоненты:**

1. **Tauri command** `src-tauri/src/commands/blocks.rs`:
   - `rename_block_file(old_slug, new_stem) -> RenameBlockResult { old_slug, new_slug }`;
   - `new_stem` трактуется как новое имя файла, не как `title` or body H1;
   - boundary normalizes stem в NFC, запрещает path traversal и пустое имя через общий `validate_slug`;
   - при занятом target возвращает typed error `NameTaken`, без silent suffix.

2. **Vault rewrite policy** в `src-tauri/src/commands/blocks.rs`:
   - `.md` файл блока переименовывается;
   - по всем parseable `.md` в vault переписываются `[[old_slug]]` / `![[old_slug]]` → `[[new_slug]]` / `![[new_slug]]`;
   - `frontmatter.file` / `thumbnail` и inline media references переписываются только для Mine-owned rename-family:
     - primary media `old_slug.ext` → `new_slug.ext`;
     - generated inline assets `old_slug (image N).*` / `old_slug (video N).*` → `new_slug ...`;
     - custom media filenames, не совпадающие с этими паттернами, остаются нетронутыми.

3. **Shared markdown rewrite helpers** в `src-tauri/src/domain/markdown.rs`:
   - `rename_wikilink_targets(body, old_slug, new_slug)` — pure rewrite text/link wikilinks;
   - `rename_inline_media_references(body, renames)` — pure rewrite для `![[...]]` и legacy `![](local_file)`;
   - remote URLs не меняются.

4. **Derived artifact migration**:
   - `src-tauri/src/storage/files.rs::rename_derived_artifacts(vault, old_slug, new_slug)` — переименовывает block-level thumb;
   - `src-tauri/src/storage/article_audio.rs::rename_all_artifacts(vault, old_slug, new_slug)` — переименовывает slug-bound audio `.wav` и sidecar, сохраняя `position_ms` и корректируя `audio_file_name` внутри sidecar;
   - если in-app rename меняет speakable article text, higher-level command инвалидирует перенесённый article-audio state вместо silent stale migration.

5. **Watcher suppression**:
   - `src-tauri/src/commands/state.rs` держит short-lived `suppressed_paths`;
   - `src-tauri/src/watcher/watch.rs` отфильтровывает эти события до `handle_event`;
   - это делает in-app rename атомарной для runtime: команды сами выполняют rewrite + rename, watcher не дублирует ту же работу.

### Rename detection

**Компоненты:**

1. **Pending remove queue** в `src-tauri/src/watcher/handler.rs`:
   - при `notify::Event::Remove` для `.md` файла — читаем content hash из DB (добавляется новая колонка `body_hash TEXT`);
   - помещаем `{ slug, body_hash, deadline: now + 500ms }` в in-memory `PendingRemoves`;
   - через 500ms без `Create` match — commit как реальное удаление, orphan cleanup запускается.

2. **Rename match** при `notify::Event::Create` для `.md` файла:
   - читаем новый файл, парсим frontmatter + body, считаем body hash;
   - ищем в `PendingRemoves` запись с тем же hash;
   - если найдена — выполняем `rename_slug(old_slug, new_slug)`, переименовываем derived artifacts в app data;
   - эмитим событие `block:renamed { old_slug, new_slug }`;
   - Pending remove помечается как consumed, не обрабатывается дальше.

3. **Cache file rename helpers** в `src-tauri/src/storage/files.rs`:
   - `rename_derived_artifacts(vault, old_slug, new_slug)` — переименовывает block-level `.jpg`;
   - `storage::article_audio::rename_all_artifacts(vault, old_slug, new_slug)` — переименовывает `.wav`, sidecar `.json`, сохраняет `position_ms`;
   - rename в app data derived store, не в vault.

**Boundary:** external rename **не** переписывает другие `.md` файлы и **не** переименовывает source media. Это deliberate отличие от in-app rename.

### iCloud conflict detection

**Компоненты:**

1. **Conflict filename pattern** в `src-tauri/src/watcher/handler.rs`:
   - regex `(?i)\s*\(conflicted? copy[^)]*\)\.md$|\s*\(conflict\)\.md$` на filename;
   - iCloud Drive использует варианты `(conflicted copy)`, `(conflict)`, `(user's MacBook Pro conflicted copy)`.

2. **Conflict surface в DB:**
   - новая таблица `vault_conflicts`:
     ```sql
     CREATE TABLE vault_conflicts (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         base_slug TEXT NOT NULL,
         conflict_slug TEXT NOT NULL,
         detected_at TEXT NOT NULL,
         UNIQUE(base_slug, conflict_slug)
     )
     ```
   - при scan conflict file — записываем в таблицу вместо создания блока.

3. **Frontend UX** в `src/components/Sidebar.tsx` через `VaultConflictsBanner`:
   - badge `N conflicts detected` в sidebar header slot;
   - клик открывает диалог `ConflictResolutionDialog`;
   - для каждого конфликта три варианта (соответствуют `ResolveAction` enum в [`src-tauri/src/commands/conflicts.rs`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/commands/conflicts.rs)):
     - `Keep original` (`keep_original`) — удалить conflict file;
     - `Keep conflict version` (`keep_conflict`) — архивировать base в `.arena/conflicts-archive/<slug> (archived <timestamp>).md` и переименовать conflict file поверх base slug;
     - `Dismiss for manual merge` (`dismiss_for_manual_merge`) — закрыть запись в `vault_conflicts` без изменений на диске; пользователь мержит файлы вручную в Obsidian.

> Diff-view как опциональное расширение перед dismiss — backlog ([PLAN.md](file:///Users/i_iii/Проекты/local-arena/PLAN.md) § Backlog → «Conflict diff view»).

### NFC normalization

**Правило:** все входящие filename паттерны нормализуются в NFC **на boundary**.

**Канонический helper:** [`domain/vault.rs::normalize_filename_stem`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/domain/vault.rs) — предпочтительная точка вызова `.nfc().collect()` для всех path→slug преобразований. При добавлении новой path boundary — переиспользовать helper, не дублировать `.nfc().collect()`. Для slug-генерации из произвольной user-строки (body H1, readable seed, url) доступен второй канал — `domain::block::sanitize_for_filename` (вызывает `.nfc()` внутри и дополнительно фильтрует fs-unsafe символы).

**Точки применения** (boundary, где path/slug впервые попадает в runtime):

1. [`watcher/handler.rs::path_to_slug`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/watcher/handler.rs) — превращение path в slug в watcher events и `full_scan` (включая iCloud conflict detection через `detect_icloud_conflict`). Покрывает результат `scan_md_files` и notify-события.
2. [`storage/files.rs::read_block_file`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/storage/files.rs) — NFC при извлечении slug из `file_stem()` перед возвратом содержимого.
3. [`commands/blocks.rs`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/commands/blocks.rs) rename target — NFC при rename операции.
4. [`domain/vault.rs::validate_slug`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/domain/vault.rs) — NFC при валидации slug перед записью.
5. [`domain/block.rs::sanitize_for_filename`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/domain/block.rs) — NFC внутри `suggest_slug`. Покрывает весь slug-generation path: clipper native host (`bin/native_host.rs`), Are.na import, IPC команды создания блоков.
6. [`asset_protocol::decode_request_path`](file:///Users/i_iii/Проекты/local-arena/src-tauri/src/asset_protocol.rs) — NFC при декодировании WebView asset URL (защита от NFD путей с HFS+ или wikilink с кириллицей до нормализации).

**Верификация** полноты списка:

```
Grep "normalize_filename_stem|\.nfc\(\)" src-tauri/src/
```

Каждое срабатывание соответствует одной из точек выше, тесту этого helper'а, или внутренним вызовам внутри `normalize_filename_stem` / `sanitize_for_filename`.

**Зависимость:** `unicode-normalization = "0.1"` объявлена в `src-tauri/Cargo.toml` как explicit dependency.

### Slug collision UX

**Текущее поведение** (после Phase 16 human-readable filenames): при collision `sunset-tokyo.md` → генерится `sunset-tokyo (2).md`.

**Новое поведение:**

1. Клиппер при повторном сохранении того же URL (detected via `block.url` DB match) **не создаёт** новый блок, показывает: `Already saved: [Open in Mine]`.
2. Клиппер при разных URL but identical H1/readable slug seed — суффикс ` — YYYY-MM-DD` вместо `(2)`:
   - `sunset-tokyo.md` (первый)
   - `sunset-tokyo — 2026-04-22.md` (второй)
   - filename остаётся осмысленным, пользователь видит дату сохранения как differentiator.
3. Manual create в UI — при collision модаль `Name taken`: пользователь вводит своё имя, нет автоматического `-2`.

## Failure modes

| Situation | Behaviour |
|---|---|
| Rename + edit в одном debounce окне | Content hash не совпадает → rename не детектится → treated as delete + create. Acceptable: rare case, user может вручную восстановить |
| Два одинаковых блока с одинаковым body (clipboard duplicate) | Content hashes совпадают, rename detection может ошибочно link'нуть. Mitigation: require `file_stem` также не совпадающим в pending queue — true rename всегда меняет stem |
| In-app rename на уже занятое имя | Команда не делает silent ` (2)`, а возвращает typed `NameTaken`; UI просит ввести другое имя |
| External rename оставил старые wikilinks в других заметках | Acceptable boundary: identity и derived state сохраняются, но другие `.md` не переписываются автоматически |
| Conflict file detected но user ignored | Badge остаётся в sidebar, блок не создаётся. На следующем open — re-detection, badge не исчезает до явного решения |
| Rename в subfolder | Create в subfolder не обнаруживается (scan non-recursive), pending remove висит 500ms и commit как delete. Acceptable: subfolder move документирован как unsupported |
| NFC/NFD двойная запись | Первый scan нормализует, блок видится одним. Second device с другой normalization — при следующем iCloud sync filename переписывается, watcher видит как rename, content hash сохраняет identity |
| Clipper native host в stale state | Compatibility gate Phase 17 уже блокирует — этот spec не добавляет новых failure paths |

## Migration

**Существующие `-2`, `-3` файлы:** остаются как есть. Это валидные имена, collision уже разрешён. Backfill tool для массового переименования — отдельный follow-up в backlog.

**Существующие iCloud conflict files:** при первом scan после deploy этой фазы — записываются в `vault_conflicts`, пользователь видит badge. Ранее созданные дубликаты остаются в DB как отдельные блоки до явного разрешения.

**DB schema migration:**

1. `ALTER TABLE blocks ADD COLUMN body_hash TEXT` — nullable, backfill при первом scan через `UPDATE blocks SET body_hash = ? WHERE slug = ?` для каждого existing блока.
2. `CREATE TABLE vault_conflicts` — idempotent `IF NOT EXISTS`.

**Legacy frontmatter:** никаких изменений. Файлы vault не трогаются.

## Testing plan

### Unit tests

- `src-tauri/src/commands/blocks.rs`:
  - `rename_block_file_rewrites_links_and_inline_media`
  - `rename_block_file_does_not_rewrite_frontmatter_title_or_body_h1`
  - `rename_block_file_leaves_custom_media_filenames_untouched`
  - `rename_block_file_rejects_taken_name`
- `src-tauri/src/watcher/handler.rs`:
  - `rename_detection_preserves_identity_on_matching_hash`
  - `rename_detection_ignores_unmatched_removes_after_timeout`
  - `rename_detection_ignores_content_change_without_rename`
  - `rename_detection_works_with_unicode_filenames`
  - `external_rename_does_not_rewrite_other_markdown_files`

- `src-tauri/src/storage/files.rs`:
  - `rename_derived_artifacts_moves_thumb`
  - `conflict_filename_detection_matches_icloud_variants`

- `src-tauri/src/storage/article_audio.rs`:
  - `rename_all_artifacts_updates_sidecar_and_audio_file_name`

- `src-tauri/src/domain/vault.rs`:
  - `nfc_normalization_idempotent`
  - `nfc_normalization_canonicalizes_cyrillic_stems`

- `src-tauri/src/domain/markdown.rs`:
  - `rename_wikilink_targets_updates_text_and_embed_forms`
  - `rename_inline_media_references_updates_wikilinks_and_legacy_markdown`

### Integration tests

- end-to-end in-app rename в test vault: create block, rename via command, verify `.md` renamed, DB slug updated, Mine-owned media rewritten, `frontmatter.title` and body H1 unchanged, thumb moved, stale article-audio unchanged unless speakable body text changed by a separate edit;
- external rename в test vault: rename `.md` вручную, verify DB slug updated, derived artifacts preserved, no duplicate block;
- iCloud conflict simulation: create `foo.md` + `foo (conflict).md` with different bodies, verify `vault_conflicts` entry, verify second block NOT created in `blocks`;
- NFC roundtrip: write filename в NFD, read back, verify matched как NFC в DB.

### Manual QA

- реальный Mine vault: переименовать 3-5 блоков внутри Mine и убедиться что `.md`, Mine-owned media, wikilinks и derived artifacts обновились;
- реальный Mine vault: переименовать 3-5 блоков в Obsidian/Finder, убедиться что thumb и audio переносятся, но другие заметки не переписываются;
- реальный iCloud Drive конфликт: синхронизировать vault между двумя Mac, спровоцировать sync conflict, убедиться что Mine показывает banner, не создаёт дубликат блока.

## Acceptance criteria

1. In-app rename внутри Mine: `.md` файл переименован, Mine-owned rename-family переименован, wikilinks и file references обновлены, `frontmatter.title` and body H1 are not rewritten, thumb перенесён; если отдельный body/H1 edit меняет speakable article text, stale article-audio инвалидируется.
2. Rename `.md` файла в Obsidian/Finder: identity сохраняется, thumb cache не становится orphan, audio position сохраняется, другие `.md` файлы не переписываются silently.
3. iCloud conflict file: появляется в `vault_conflicts`, не создаёт второй блок в `blocks`, UI показывает banner с вариантами разрешения.
4. Rename с одновременным edit body (same debounce window): content hash не совпадает, treated как delete + create — documented edge case, acceptable.
5. NFC/NFD mismatch между устройствами: при первом scan после sync filename нормализуется в NFC, identity сохраняется.
6. Повторный clip того же URL: клиппер детектит via DB match, показывает `Already saved`, не создаёт дубликат.
7. Повторный clip разных URL с одинаковым H1/readable slug seed: filename получает `— YYYY-MM-DD` suffix вместо `-2`.

## Known residuals

- `move в subfolder` остаётся unsupported. Acceptable: Mine контракт — flat vault structure.
- `rename + edit в одном debounce окне` теряет identity. Acceptable: rare, documented.
- External rename не переписывает wikilinks и custom file references в других заметках. Acceptable: canonical smart path — in-app rename.
- Existing `-2`, `-3` файлы остаются как есть. Migration опциональна, не входит в scope.
- Cross-vault move (из одного Mine vault в другой) остаётся unsupported. Acceptable: Mine работает с одним active vault одновременно.

## Assumptions

- `notify` crate debounce 500ms достаточно для типичного rename через Obsidian / Finder: оба инструмента emit delete+create в пределах 50-200ms.
- Content hash SHA-256 первых 8 bytes достаточен для практической уникальности — коллизия требует либо identical body (legitimate duplicate), либо deliberate collision attack (out of scope).
- User, обнаруживший `vault_conflicts` banner, разрешает его в течение сессии — длительное игнорирование приемлемо, блоки не создаются.
- Obsidian не пишет служебные поля в frontmatter существующих `.md` файлов Mine — это уже предположение Markdown First, не ослабляется.
