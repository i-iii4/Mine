# Identity Robustness Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md)

## Goal

Укрепить текущую filename-based модель идентичности блоков против реальных сценариев, при которых она сейчас теряет identity:

- rename `.md` файла в Obsidian или Finder;
- iCloud sync conflict files;
- Unicode normalization mismatch (NFC vs NFD) между устройствами;
- slug collision при clip'е второго блока с тем же заголовком.

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

### Markdown First invariants

5. `.md` файл не содержит служебных полей идентификации.
6. Obsidian может открыть любой блок Mine, увидеть только человекочитаемые поля (`title`, `tags`, `saved_at`, `url`, и т.д.).
7. Wikilinks `[[sunset-tokyo]]` работают в Obsidian без Mine-specific processing.

### Watcher invariants

8. `notify` события `Remove` и `Create` в одном debounce окне с совпадающим content hash трактуются как rename, не как delete + create.
9. Rename detection работает только в пределах одного vault root — не корректирует cross-vault moves.
10. Content hash считается по **body после frontmatter**, чтобы rename с одновременной правкой тела не давал false positive.

## Architecture

### Rename detection

**Компоненты:**

1. **Pending remove queue** в `src-tauri/src/watcher/handler.rs`:
   - при `notify::Event::Remove` для `.md` файла — читаем content hash из DB (добавляется новая колонка `body_hash TEXT`);
   - помещаем `{ slug, body_hash, deadline: now + 500ms }` в in-memory `PendingRemoves`;
   - через 500ms без `Create` match — commit как реальное удаление, orphan cleanup запускается.

2. **Rename match** при `notify::Event::Create` для `.md` файла:
   - читаем новый файл, парсим frontmatter + body, считаем body hash;
   - ищем в `PendingRemoves` запись с тем же hash;
   - если найдена — выполняем `UPDATE blocks SET slug = ? WHERE slug = ?`, переименовываем thumb cache, preview cache, audio cache файлы в app data;
   - эмитим событие `block:renamed { old_slug, new_slug }`;
   - Pending remove помечается как consumed, не обрабатывается дальше.

3. **Cache file rename helpers** в `src-tauri/src/storage/files.rs`:
   - `rename_thumb_artifacts(vault, old_slug, new_slug)` — переименовывает `.jpg`, sidecar `.json`, preview tiles;
   - `rename_audio_artifacts(vault, old_slug, new_slug)` — переименовывает `.wav`, sidecar `.json`;
   - rename в app data derived store, не в vault.

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

3. **Frontend UX** в `src/components/Sidebar.tsx` или новом `ConflictBanner`:
   - badge `N conflicts detected` в sidebar footer;
   - клик открывает диалог `ConflictResolutionDialog`;
   - для каждого конфликта два варианта:
     - `Keep original` — удалить conflict file;
     - `Keep conflict version` — переместить conflict file поверх base, старый backup в `.arena/conflicts-archive/`;
     - `Merge manually` — показать diff, пользователь редактирует вручную в Obsidian.

### NFC normalization

**Правило:** все входящие filename паттерны нормализуются в NFC **на boundary**.

**Точки применения:**

1. `src-tauri/src/storage/files.rs:scan_md_files` — NFC при чтении `DirEntry::file_name()`.
2. `src-tauri/src/watcher/handler.rs` — NFC при чтении path из `notify::Event`.
3. `src-tauri/src/bin/native_host.rs` — NFC при save_block перед записью на диск.
4. `src-tauri/src/domain/vault.rs:validate_slug` — NFC при слаг-валидации.

**Зависимость:** `unicode-normalization` crate (уже есть в Cargo.lock как transitive, возможно потребуется explicit dependency).

### Slug collision UX

**Текущее поведение** (после Phase 16 human-readable filenames): при collision `sunset-tokyo.md` → генерится `sunset-tokyo (2).md`.

**Новое поведение:**

1. Клиппер при повторном сохранении того же URL (detected via `block.url` DB match) **не создаёт** новый блок, показывает: `Already saved: [Open in Mine]`.
2. Клиппер при разных URL но identical title — суффикс ` — YYYY-MM-DD` вместо `(2)`:
   - `sunset-tokyo.md` (первый)
   - `sunset-tokyo — 2026-04-22.md` (второй)
   - filename остаётся осмысленным, пользователь видит дату сохранения как differentiator.
3. Manual create в UI — при collision модаль `Name taken`: пользователь вводит своё имя, нет автоматического `-2`.

## Failure modes

| Situation | Behaviour |
|---|---|
| Rename + edit в одном debounce окне | Content hash не совпадает → rename не детектится → treated as delete + create. Acceptable: rare case, user может вручную восстановить |
| Два одинаковых блока с одинаковым body (clipboard duplicate) | Content hashes совпадают, rename detection может ошибочно link'нуть. Mitigation: require `file_stem` также не совпадающим в pending queue — true rename всегда меняет stem |
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

- `src-tauri/src/watcher/handler.rs`:
  - `rename_detection_preserves_identity_on_matching_hash`
  - `rename_detection_ignores_unmatched_removes_after_timeout`
  - `rename_detection_ignores_content_change_without_rename`
  - `rename_detection_works_with_unicode_filenames`

- `src-tauri/src/storage/files.rs`:
  - `rename_thumb_artifacts_moves_jpg_and_sidecar`
  - `rename_audio_artifacts_preserves_position_ms`
  - `conflict_filename_detection_matches_icloud_variants`

- `src-tauri/src/domain/vault.rs`:
  - `nfc_normalization_idempotent`
  - `nfc_normalization_canonicalizes_cyrillic_stems`

### Integration tests

- end-to-end rename в test vault: create block, rename .md, verify DB slug updated, thumb moved, audio position preserved;
- iCloud conflict simulation: create `foo.md` + `foo (conflict).md` with different bodies, verify `vault_conflicts` entry, verify second block NOT created in `blocks`;
- NFC roundtrip: write filename в NFD, read back, verify matched как NFC в DB.

### Manual QA

- реальный Mine vault: переименовать 3-5 блоков в Obsidian, убедиться что thumb и audio переносятся;
- реальный iCloud Drive конфликт: синхронизировать vault между двумя Mac, спровоцировать sync conflict, убедиться что Mine показывает banner, не создаёт дубликат блока.

## Acceptance criteria

1. Rename `.md` файла в Obsidian: identity сохраняется, thumb cache не становится orphan, audio position сохраняется, wikilinks на этот блок продолжают работать.
2. iCloud conflict file: появляется в `vault_conflicts`, не создаёт второй блок в `blocks`, UI показывает banner с вариантами разрешения.
3. Rename с одновременным edit body (same debounce window): content hash не совпадает, treated как delete + create — documented edge case, acceptable.
4. NFC/NFD mismatch между устройствами: при первом scan после sync filename нормализуется в NFC, identity сохраняется.
5. Повторный clip того же URL: клиппер детектит via DB match, показывает `Already saved`, не создаёт дубликат.
6. Повторный clip разных URL с одинаковым title: filename получает `— YYYY-MM-DD` suffix вместо `-2`.

## Known residuals

- `move в subfolder` остаётся unsupported. Acceptable: Mine контракт — flat vault structure.
- `rename + edit в одном debounce окне` теряет identity. Acceptable: rare, documented.
- Existing `-2`, `-3` файлы остаются как есть. Migration опциональна, не входит в scope.
- Cross-vault move (из одного Mine vault в другой) остаётся unsupported. Acceptable: Mine работает с одним active vault одновременно.

## Assumptions

- `notify` crate debounce 500ms достаточно для типичного rename через Obsidian / Finder: оба инструмента emit delete+create в пределах 50-200ms.
- Content hash SHA-256 первых 8 bytes достаточен для практической уникальности — коллизия требует либо identical body (legitimate duplicate), либо deliberate collision attack (out of scope).
- User, обнаруживший `vault_conflicts` banner, разрешает его в течение сессии — длительное игнорирование приемлемо, блоки не создаются.
- Obsidian не пишет служебные поля в frontmatter существующих `.md` файлов Mine — это уже предположение Markdown First, не ослабляется.
