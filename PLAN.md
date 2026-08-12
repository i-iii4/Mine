# Implementation Plan

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [DEVLOG.md](DEVLOG.md) | [CLAUDE.md](CLAUDE.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_GRAPH_VIEW.md](SPEC_GRAPH_VIEW.md) | [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md) | [SPEC_FEED_SCROLL_PERFORMANCE.md](SPEC_FEED_SCROLL_PERFORMANCE.md) | [SPEC_GRID_LAYOUT_READINESS.md](SPEC_GRID_LAYOUT_READINESS.md) | [SPEC_FEED_VIDEO.md](SPEC_FEED_VIDEO.md) | [SPEC_ARTICLE_AUDIO.md](SPEC_ARTICLE_AUDIO.md) | [SPEC_MEDIA_ASSET_ACTIONS.md](SPEC_MEDIA_ASSET_ACTIONS.md) | [SPEC_INLINE_MEDIA_EXTRACTION.md](SPEC_INLINE_MEDIA_EXTRACTION.md) | [SPEC_OBSIDIAN_MARKDOWN_COMPAT.md](SPEC_OBSIDIAN_MARKDOWN_COMPAT.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md) | [SPEC_SCROLL_EDGE_FADE.md](SPEC_SCROLL_EDGE_FADE.md)

## Goal

Создать технически совершенное десктопное приложение для macOS — локальную альтернативу Are.na. Файлы на диске (Markdown + frontmatter), коллекции — Obsidian-страницы, плавный интерфейс на 10 000+ блоков.

**Это не MVP.** Каждый модуль реализуется в финальном качестве.

## Canonical active plan — audited 11.07.2026

This section is the source of truth for unfinished desktop architecture. Older
phase tables below remain implementation history; their status cells use words
instead of unchecked boxes so historical/manual/deferred work cannot be mistaken
for the active critical path.

Status vocabulary:

- `ACTIVE` — missing contract or test is confirmed in the current code;
- `DONE` — current code/tests prove the old item was completed;
- `SUPERSEDED` — the old solution is invalid under the current architecture;
- `FEATURE BACKLOG` — product feature, not unfinished platform architecture;
- `MANUAL QA` — implementation exists; only real-vault/user acceptance remains;
- `DEFERRED` — explicitly outside the current Definition of Done.

### Active architecture sequence

| Phase | Status | Deliverable | Definition of Done |
|---|---|---|---|
| A0. Baseline reconciliation | DONE | Audited every former open marker and aligned `PLAN` plus core specs | Every residual has code/test evidence; Graph tests are described accurately; APIs, errors and budgets are specified |
| A1. Vault freshness | DONE | Last-good route reads, persistent clean/dirty state, non-blocking safety audit | One bad file never blocks Grid/Search/Detail; clean reads scan nothing; sequential search does not repeat inventory; missed events still converge |
| A2. Watcher/storage consistency | DONE | Watcher recovery, lock order, atomic source writes, rollback-safe compound mutations | Injected watcher/write failures recover without partial source/index state or deadlock |
| A3. Derived preview completion | DONE | Semantic `CardKind::Link`, recipe-backed readiness, one preview planner | Metadata-only links stay links; `ready` agrees with card semantics; watcher and commands cannot select different sources |
| A4. Graph View M1 | DONE | Wikilink/related edges, automatic route scope, shared Settings preferences, selection/a11y, truncation and Canvas acceptance | Full real-object edge model, minimal Graph surface, stable interactions, keyboard navigation and dark/light Playwright pixel/performance gates pass |
| A5. Cold-space semantic acceptance | MANUAL QA | Fresh-derived-store space switch, legacy card projection audit, semantic preview readiness | Automated source/projection, first-frame, rapid-switch, reopen and cache-reset contracts pass; only final desktop visual open/restart remains |
| A6. Verification gate hardening | DONE | Self-starting browser audit runner wired into `bun run verify` | A clean shell runs Feed, Graph and cold-space gates without a prestarted server and always tears the server down |
| A7. Structural decomposition | DONE | Split App/Grid/Graph, command-state orchestration and storage DB/index responsibilities at existing ownership boundaries | Composition roots retain orchestration; focused owners contain migrations, coordinators, interaction/physics/paint and secondary chrome; behavior gates stay green |
| A8. Persistence and read-model contracts | DONE | Versioned SQLite migrations, shared projection revisions, independent search revisions, generated IPC bindings, native-shell smoke and truthful MSRV | Upgrade tests, atomic snapshot tests, binding freshness, browser/native gates and Rust 1.88 locked-workspace CI all pass |

### Tooling maintenance checkpoint — 19.07.2026

- `shadcn` CLI обновлён до 4.13.1; `shadcn info` подтверждает текущий
  `base = radix` без перезаписи `components.json` и UI-компонентов.
- Официальный global skill из `shadcn/ui` установлен для агентов и обновляется
  еженедельно отдельной Codex automation.
- Dependabot с `package-ecosystem: bun` предлагает отдельные weekly PR только
  для CLI; source-owned `src/components/ui/` проверяется через `--diff` и не
  обновляется автоматически.

### Media consistency checkpoint — 24.07.2026

- Settings Orphans использует единый Rust-owned
  `OrphanMediaBatchRequest { file_names }` для promote/delete; generated IPC
  bindings исключают расхождение `fileNames` и `file_names`.
- Image-card geometry использует адаптивный minimum, зависящий от ширины
  колонки, а graphic surface заполняется через `object-cover`. При появлении
  deterministic dimensions событие `thumb:updated` один раз пересчитывает
  layout вместо сохранения чёрного остатка под широким изображением.
- Batch Merge проецирует committed Markdown и `source_index_state`, затем
  синхронно публикует preview через единый `derived_preview` pipeline.
  Multi-image result уже в первом Grid snapshot имеет ready composite manifest.
- Одновременный cold-open SQLite сериализует connection PRAGMAs и migration
  entry внутри процесса; stress-test из двадцати запусков по восемь соединений
  проходит без `database is locked`.

### Desktop Sidebar and card-frame checkpoint — 25.07.2026

- Native macOS `View` menu владеет accelerator `Control+Cmd+S` и эмитит одно
  событие toggle; browser/dev fallback использует physical `KeyS`, а Tauri
  WebView не обрабатывает тот же `keydown` повторно.
- `useSidebarResize.collapsed` остаётся единственным владельцем состояния.
  Native menu синхронно проецирует следующий action как `Hide Sidebar` или
  `Show Sidebar`, не создавая второй collapsed-state.
- Card hover больше не меняет общий frame. Hover-affordance принадлежит action
  controls, а keyboard/group-selection frame остаётся ответственностью
  `GridItem` по существующему design-system contract.
- Полный `bun run verify:release` проходит: generated bindings без drift,
  ESLint, frontend/Rust workspace tests, Feed/Graph/cold-space browser gates и
  packaged macOS WKWebView/Tauri IPC smoke.

### Graph real-object projection checkpoint — 25.07.2026

- Graph View больше не имеет типа, фильтра или визуального состояния
  `Unresolved`: отсутствующие WikiLink targets не становятся nodes или edges.
- `extract_note_wikilinks` индексирует только обычные WikiLinks. Media embeds
  `![[file]]` остаются в media pipeline и не участвуют в Graph projection.
- `GRAPH_LINK_INDEX_VERSION = 2` запускает автоматический backfill существующего
  SQLite index, удаляя ранее записанные media targets без изменения source
  Markdown.
- Алиасы и fragments обычных WikiLinks, mixed bodies и media filenames с `#`
  закрыты regression tests; полный `bun run verify:release` проходит.

### Minimal Graph View checkpoint — 25.07.2026

- Graph-local search, ручной `Route / Library / Ego` selector и локальная
  settings-иконка удалены из product surface и IPC contract.
- Scope определяется маршрутом: Everything использует `library`, коллекция —
  `current_route`. `Show all` остаётся только session-local действием для
  безопасно материализуемого truncated graph.
- `Collections`, `Wikilinks` и `Related notes` живут в отдельном разделе
  общего Settings и сохраняются одним `mine.graphPreferences` объектом.
- `Unresolved` отсутствует в Rust/TypeScript DTO, Graph UI и browser audit;
  старая видимая строка относилась к процессу Mine, запущенному до пересборки.

### Field checkpoint — 02.08.2026–11.08.2026

Полевые сессии после закрытия A0–A8; детали по датам — в `DEVLOG.md`. Статус
A5 не меняется: остаётся `MANUAL QA` (финальное визуальное открытие и полный
перезапуск на реальном пространстве).

- Растворение верхней кромки прокручиваемых поверхностей реализовано и
  зафиксировано в `SPEC_SCROLL_EDGE_FADE.md`; переключение каналов при
  открытой карточке починено (02.08.2026).
- Видео из постов X с возрастным ограничением забирает yt-dlp
  (решение 031 в `ARCHITECTURE.md`); без бинарника шаг завершается понятной
  ошибкой (04.08.2026).
- Переключатель пространств получил pinned `Reveal in Finder` / `Add space`;
  правый клик по групповому выделению открывает selection-scoped меню;
  сортировка коллекций в сайдбаре переписана по контракту дизайн-системы и
  закреплена browser gate `bun run test:sidebar-reorder`; фантомные записи
  каналов выметаются в `reconcile_vault` (09.08.2026).
- Клиппер: эластичный высотный каркас панели с жёстким save-футером, статусы
  на кнопке вместо StatusBar, слоистый Escape, host-команды `pick_vault_folder`
  / `reveal_vault` (10.08.2026).
- SIGABRT-гонка asset-протокола с WKWebView закрыта: `responder.respond`
  уходит через `run_on_main_thread`; release-профиль переведён на
  `panic = "unwind"` (10.08.2026).
- Резолв медиа по имени внутри хранилища добавлен в asset-протокол — починены
  все карточки после миграции раскладки `Cards/`/`Media/`; копирование в буфер
  переведено на `tauri-plugin-clipboard-manager` (11.08.2026).
- Документационный аудит: `AGENTS.md` пересобран как копия канонического
  `CLAUDE.md`, Required reading/Stack/Structure сверены с кодом, указатель
  канонического DDL исправлен на `storage/migrations.rs` (11.08.2026).
- Вертикальные зазоры в Detail приведены к одному токену: внешний отступ
  metadata row в stacked-раскладке взят из `--edge-rhythm`, хвостовой margin
  последнего блока статьи обнулён, инлайновое видео получило
  `h-auto max-w-full` вместо letterbox из intrinsic-высоты (11.08.2026).

Production distribution is `DEFERRED` by explicit product decision and is not
part of local desktop completion. Current acceptance ends at a locally built
debug `Mine.app`.

### Phase A5 — Cold-space semantic acceptance [MANUAL QA]

#### Automated acceptance closure — 11.07.2026

- Added a storage-owned cold-space audit plus CLI. It fingerprints source
  files, requires a disjoint empty derived base, builds two independent cache
  cycles and compares first, settled and read-only reopened snapshots.
- Sanitized coverage includes root/nested notes, collection pages,
  metadata-only link/video bookmarks, missing media and browser-owned decode.
- The untouched source `/Users/i_iii/Desktop/Тест` passed read-only audit:
  `294 Markdown = 256 content + 38 collections`, zero unsupported sources,
  `215 ready` previews and `41 browser_decode_required`; no invalid manifest or
  source mutation remained. Both cold cycles and reopen were identical.
- The first real run exposed four URL-only legacy `type: video` rows projected
  as media. URL-without-owned-file now derives `link`; media-index v5 repairs
  warmed derived stores without rewriting Markdown.
- The cold-space Playwright route passes first/settled/deep blankness and source
  request checks. Frontend rapid `A -> B -> A -> B` coverage proves obsolete
  open promises cannot publish into the final keyed vault subtree.
- All implementation/automation work is complete. A5 remains `MANUAL QA` only
  for one final visual open and full desktop restart against the real space.

#### Acceptance checkpoint — 11.07.2026

- После push `5a7daae` текущая desktop-сборка в целом принята как рабочая и
  визуально стабильная на уже прогретом пространстве.
- Новых frontend-блокеров в этом acceptance checkpoint не обнаружено.
- At this checkpoint A5 remained active: the positive warm-space result did not close
  воспроизведённые first-open blank cards и semantic preview failure в `Тест`.

#### Automated remediation checkpoint — 11.07.2026

- Implementation checkpoint: `db9beb6` on `audit-remediation`.
- Exact-shape regression coverage for `ai-2027-3.md` proves that a fresh source
  projection is `block_type = link`, `card_kind = link`, with an asset-free text
  manifest on both first and unchanged second reconciliation.
- Legacy backfill coverage proves that the former `card_kind = media`,
  `preview_state = ready`, schema-v1 row migrates to `link` and becomes `stale`
  until semantic validation republishes it.
- Media-index v5 extends that repair to metadata-only legacy
  `type: image | video | file` bookmarks with a URL and no owned local file;
  the URL wins and the runtime card remains `link`.
- Feed browser acceptance now mixes metadata-only links into deep fast scroll
  and asserts that their DOM contains title/domain but no graphic surface.
- At this checkpoint A5 still required full sanitized-space
  inventory/switch/restart automation and untouched real-space acceptance.

#### Confirmed boundary — 10.07.2026

- A warmed `Mine` space is visually stable in the current debug build.
- On first opening the separate `Тест` space, Grid can still expose intermittent
  blank cards while its local derived store is being prepared.
- Once settled, source/index inventory is complete: 294 Markdown files project
  to 256 content blocks and 38 collections. The remaining regression is not a
  silent inventory loss.
- `ai-2027-3.md` is a reproducible semantic failure: source frontmatter says
  `type: link` and contains a URL but no body/media; the index currently stores
  `block_type = link`, `card_kind = media`, and a `ready` text preview. This
  renders a large dark placeholder as if it were real media.

#### Work plan

| # | Task | Status |
|---|---|---|
| A5.1 | Build a sanitized cold-space fixture from `Тест`: root cards, nested library cards, collections, metadata-only links, missing assets and browser-decode fallback; assign a fresh vault id without modifying the user's source space | DONE |
| A5.2 | Add a source-to-projection audit: every `.md` must be classified exactly once as content, collection or typed unsupported input; report source/index/preview counts at first snapshot and settled state | DONE |
| A5.3 | Define and implement the compatibility rule for metadata-only links: `url` plus link metadata and no media must render as a link/text card, never as a media card | DONE |
| A5.4 | Tighten preview readiness: `ready` must mean the manifest and artifact are usable for the projected card semantics; an existence-backed text placeholder cannot satisfy a visual media preview | DONE |
| A5.5 | Make first-open publication coherent: every visible row has either its correct derived preview or a type-correct fallback; one persisted projection generation must cover SQLite rows, preview readiness and the IPC/Grid snapshot | DONE |
| A5.6 | Add automated cold-open and rapid `Mine -> Test -> Mine -> Test` acceptance, including current-vault worker cancellation, first-frame blank detection and settled-state equality; the browser gate must consume a Rust-produced cold-vault `GridSnapshot`, not handwritten `LightBlock` data | DONE |
| A5.7 | Untouched `Тест` read-only audit and disposable cache reset are complete; perform final visual desktop open and full app restart | MANUAL QA |

#### Definition of Done

- The fixture starts with no local derived store; no existing user cache is used
  to make the test pass.
- At first usable snapshot and after background completion, every source
  Markdown has one explicit classification and no stale extra projection exists.
- Grid never shows an empty card frame during first open or rapid scroll. A
  pending preview uses a deterministic fallback matching the card's real type.
- `ai-2027-3.md` appears as a link card, Detail reports link semantics, the
  source action remains available, and no faux media panel is mounted.
- A row cannot be `preview_state = ready` when its manifest/artifact contradicts
  the projected card kind or cannot be decoded by the receiving surface.
- Rapid space switching publishes no results from obsolete workers and causes no
  cross-space preview contamination.
- Two consecutive opens and a full app restart produce the same card count,
  ordering, card kinds and preview manifests.
- Automated frontend/Rust tests, `bun run test:feed-scroll`, the cold-space
  browser gate, and real-space manual acceptance all pass.

### Remediation sequence — 11.07.2026

| # | Slice | Status | Definition of Done |
|---|---|---|---|
| R0 | Contract/status correction | DONE | A1/A3/A6 reflect current evidence; integration/storage/graph specs define the target behavior |
| R1 | Last-good freshness state machine | DONE | Per-file errors are diagnostic, readable snapshots still serve, clean searches perform zero scans, dirty work coalesces |
| R2 | Runtime link semantics | DONE | `CardKind::Link` is end-to-end; metadata-only links never mount a media shell |
| R3 | Shared preview recipe | DONE | One pure source-selection planner drives watcher and thumbnail commands; readiness validates the resulting manifest semantics |
| R4 | Self-contained browser verification | DONE | `bun run verify` starts one audit server and runs Feed, Graph and Rust-produced cold-space gates |
| R5 | Cold-space acceptance and closure | MANUAL QA | Persisted projection generations and real vault -> SQLite -> Rust IPC DTO -> Grid browser gate pass; untouched `Тест` storage audit remains stable; only final desktop visual open/restart remains |

### Phase A7 — Structural decomposition [DONE, 12.07.2026]

This is a maintainability boundary, not a current product regression. It must
not be mixed into cold-space behavioral remediation.

| # | Task | Status |
|---|---|---|
| A7.1 | Map responsibilities and dependency rules for `App.tsx`, `Grid.tsx`, `GraphView.tsx`, `commands/state.rs`, `storage/index.rs` and `storage/db.rs` | DONE |
| A7.2 | Extract `FreshnessCoordinator`, preview-work queue and thumbnail-sweep coordinator from `commands/state.rs`; keep `AppState` as composition and shared ownership only | DONE |
| A7.3 | Split Graph force configuration, Canvas painter/hit geometry, contracts and interaction state without changing `GraphSnapshot` or UX | DONE |
| A7.4 | Split Grid selection/keyboard/marquee/viewport-anchor geometry into a focused interaction owner, reusing existing layout modules | DONE |
| A7.5 | Move main secondary chrome out of `App.tsx`; keep App as route/IPC/DnD composition root | DONE |
| A7.6 | Move transactional migrations out of `storage/db.rs`; split block query hydration, channel-index and vault-conflict ownership out of `storage/index.rs` | DONE |

Definition of Done:

- extraction commits are behavior-preserving and independently reviewable;
- no cyclic frontend/backend module dependencies are introduced;
- composition roots describe ownership at a glance and do not retain
  duplicated helper/state-machine implementations;
- focused unit tests move with each owner; Feed/Graph/cold-space browser gates
  and full Rust/frontend verification remain green after every slice;
- success is judged by responsibility boundaries, not an arbitrary line-count
  target.

### Phase A8 — Persistence and read-model contracts [DONE, 12.07.2026]

| # | Task | Status |
|---|---|---|
| A8.1 | Replace best-effort schema changes with sequential `PRAGMA user_version` migrations under `BEGIN IMMEDIATE`, schema validation and rollback-safe upgrade tests | DONE |
| A8.2 | Introduce typed `ProjectionRevision` for Grid, taxonomy, sidebar previews and Graph; read every DTO under one SQLite snapshot and reject stale frontend publication centrally | DONE |
| A8.3 | Generate shared DTO/error bindings from Rust with Specta, commit `src/types/generated.ts` and fail verification when it is stale | DONE |
| A8.4 | Add independent `SearchRevision` and an opaque cursor bound to projection revision, search revision and query fingerprint | DONE |
| A8.5 | Add a real packaged macOS WKWebView smoke that executes Tauri `invoke` and reports completion through a second IPC command | DONE |
| A8.6 | Set workspace MSRV to the lowest version that builds the locked dependency graph (`1.88`) and enforce it in CI | DONE |

Definition of Done:

- old unversioned and version-1 databases upgrade without data loss; malformed
  or future schemas fail atomically and concurrent opens cannot interleave;
- no route-facing multi-query snapshot can combine projection revisions;
- search pagination resets instead of combining a changed projection, changed
  search index or different query;
- generated bindings are the only backend DTO source in TypeScript;
- `bun run verify:release` covers core, Feed, Graph, cold-space and native IPC;
- `cargo +1.88.0 check --workspace --all-targets --locked` passes.

### Audited disposition of former open markers

This table accounts for every unchecked/partial marker that existed before the
10.07.2026 audit. `ACTIVE` entries name the concrete missing boundary; manual
checks and feature requests are kept separate from architecture.

| Former items | Disposition | Current evidence or missing boundary |
|---|---|---|
| `C2`, `C3`, `C4`, `24.1–24.5` | DONE A1–A3 | Route catch-up, watcher recovery, persisted dependency stamps and existence-backed preview manifests are implemented |
| `C5` | MANUAL QA | `feed_playback` state machine and automated coverage exist; real-vault autoplay/failure acceptance remains |
| `C7`, `C8.6`, `C8.7` | DONE / SUPERSEDED | C8 and production Phase 11 replaced hidden DOM measurement with deterministic layout; browser feed-scroll gate exists |
| `MC6` | MANUAL QA | Migration CLI/tests and canonical writers exist; only before/after real-vault inspection remains |
| `MC7` | DONE | Parser/index membership uses canonical `Mine Collections`; legacy `tags` is migration input only |
| `7.6` | DEFERRED | Signing/notarization capability unavailable; see `SPEC_DISTRIBUTION.md` status |
| `7.26` | FEATURE BACKLOG | Inline media has action frame/full preview, but not the old delayed extracted-card hover-preview contract |
| `7.27` | FEATURE BACKLOG (partial) | TCP guard suppresses a second process; focus/raise of the primary window is absent |
| `9.4.1` | DONE | Listed async App handlers have explicit `try/catch` paths |
| `9.4.3` | SUPERSEDED | `ChannelPage` consumes server-filtered route snapshots; no client filter remains |
| `9.4.4` | CODE CLEANUP | `snapToCursor` still casts the dnd activator event without a client-coordinate guard |
| `9.5.1–9.5.4` | DONE | `isSafeUrl`, `safeMarkdownUrl`, React rendering and scoped manifest matches replace the audited unsafe paths |
| `9.6.1–9.6.3` | DONE | Collection rewrites back up/restore source bytes; channel rename also owns a DB transaction |
| `9.6.4` | DONE A2 | `rebuild_index` delegates to the non-destructive reconciler and preserves last-good rows on injected per-file failure |
| `9.6.5` | SUPERSEDED | Are.na import intentionally commits independent blocks and reports per-block recoverable errors |
| `9.7.1`, `9.7.5`, `9.7.7`, `9.7.8`, `9.7.10–9.7.12` | DONE | SQL slug lookup, missing-delete tolerance, file-first delete, transactional full scan, memoized cards, busy timeout and type index exist |
| `9.7.3`, `9.7.4` | SUPERSEDED | Route-specific projections and Hybrid Search replaced the audited channel/FTS hot paths |
| `9.7.6` | ACTIVE hardening | Local source image decode has no explicit byte/pixel admission limit before `image::open` |
| `9.7.9` | ACTIVE performance | `collect_blocks` still creates one unbounded SQL `IN` list instead of bounded batches |
| `9.8.1–9.8.3` | DONE | Native callback timers are cleared; popup/content/native requests have bounded timeouts |
| `9.8.4` | DONE A2 | Create and replacement paths use staged same-directory writes, fsync and atomic rename through `source_mutation` |
| `9.8.5` | DONE for audited paths | Old request-path unwraps were removed; remaining constant-header parses and poisoned-lock expectations require separate cleanup policy |
| `9.8.6`, `9.8.8` | SUPERSEDED | URL safety is enforced at render/fetch boundaries; current clipper uses overlay/Vite entries rather than legacy popup paths |
| `9.8.7` | FEATURE BACKLOG | MIME-derived extension refinement is not required for current identity/storage correctness |
| `9.8.9`, `9.8.10` | DONE | Every redirect hop uses `net::validate_fetch_url`; native channel input uses `validate_collection_ref` |
| `9.8.11` | SECURITY BACKLOG | Clipper still installs broad http/https content scripts instead of pure on-demand injection |
| `9.9.1` | ACTIVE hardening | Tauri runner still ends with `.expect(...)` instead of returning/reporting startup failure |
| `9.9.2`, `9.9.3`, `9.9.9` | DONE | Listener cleanup and atomic thumbnail temp/fsync/rename paths exist |
| `9.9.4`, `9.9.6`, `9.9.7` | DONE A2 | Watcher errors are typed/recoverable, lock order is documented/tested, and import releases the vault mutex before network/file work |
| `9.9.5` | FEATURE BACKLOG | Import error taxonomy is independent of A1–A4 |
| `9.10.1–9.10.3`, `9.10.5`, `9.10.10`, `9.10.11` | DONE / SUPERSEDED | Old helpers/legacy popup are gone or intentionally split by semantic role; ImportDialog is mounted by App |
| `9.10.4`, `9.10.12` | CODE CLEANUP | No correctness contract depends on these dedup/removal tasks |
| `9.10.6` | SECURITY BACKLOG | `style-src 'unsafe-inline'` remains required by current styling/runtime and needs a dedicated CSP migration |
| `9.10.7`, `9.10.8` | DONE A2 boundary | Compound source/index writes use `storage::source_mutation`; commands retain only validation, orchestration and event publication |
| `9.11.1`, `9.11.2`, `9.11.4`, `9.11.7` | DONE | Blocks/tags/files/thumbnails contain direct unit and failure coverage |
| `9.11.3`, `9.11.5`, `9.11.6` | ACTIVE test gaps | Channel command internals, mocked Are.na pagination/errors and watcher lifecycle/debounce lack direct tests |
| `9.12.1–9.12.6` | DONE by A0 | Core specs/schema/IPC/docs are reconciled in this audit pass |
| `9.13.13` | ACTIVE test gaps | Channel internals, bulk collection rollback and redirect integration still need focused tests |
| `11.7` | SUPERSEDED | Current top chrome/action surfaces are governed by `DESIGN_SYSTEM.md`, not the old toolbar placeholder |
| `11.8`, `12.7.1`, `12.7.2`, `12.11`, `21.7`, `22.7`, `23.7`, `25.8`, `26.12`, `27.8` | MANUAL QA | Implementations/automated checks exist; these rows are real-vault or visual acceptance only |
| `12.5.4` | DEFERRED | iOS/Safari work is outside the active desktop scope |
| `26.6.1–26.6.4` | FEATURE BACKLOG | Atomic batch delete parity is a product feature, not a prerequisite for A1–A4 |
| `30.3–30.7` | DONE A4 | M1 edge/scoping/search/a11y contracts and real-browser dark/light Canvas budgets pass |

## Стратегия: вертикальные срезы с эталонным модулем

Каждый модуль проходит полный цикл:
```
SPEC → TEST (красные) → CODE (зелёные) → VERIFY → COMMIT
```

Фаза 1 создаёт **эталонный модуль** (`domain/block`) — образец качества для всех остальных. Уроки из каждого модуля влияют на спецификацию следующего.

## Critical Path Reset v1 [COMPLETED]

Goal: устранить две подтверждённые архитектурные причины текущей неработоспособности:
1. derived state (`index.db`, thumbs, preview cache) живёт внутри iCloud vault;
2. feed рендерит оригинальные assets и real media вместо локальных preview-артефактов.

Это **не rewrite проекта**, а **частичный reset двух корневых контрактов**:
- derived state больше не хранится в iCloud vault;
- feed больше не рендерит оригинальные assets и real media.

До завершения `Critical Path Reset v1` локальные perf-оптимизации считаются вторичными. Исключение — явные correctness/security блокеры.

### Summary

- Вводится sync'ed идентификатор vault: `.mine/vault-id`.
- Все derived данные переезжают в per-device app data store, keyed by `vault-id`.
- Feed, sidebar и measurement-path используют только preview assets из local derived store.
- `Detail` остаётся full-fidelity path и может открывать оригиналы.
- Legacy `.arena/vault-id`, `.arena/index.db` и `.arena/cache/thumbs`
  используются только как migration source и очищаются из source vault после
  переноса в `.mine` / local derived store.

### Architecture Changes To Record

#### 1. Vault identity + derived store

- `vault-id` хранится в `.mine/vault-id` и синхронизируется через iCloud вместе с vault.
- `index.db`, preview cache, thumbnail cache, manifests и migration markers живут только в app data.
- Перемещение vault не ломает identity.
- Второй Mac открывает тот же vault через локальный rebuild derived store по тому же `vault-id`.
- Multi-device sync derived state больше не является feature; синхронизируются только пользовательские файлы и `vault-id`.

#### 2. Migration semantics

- При первом открытии legacy vault `.arena/vault-id` мигрирует в `.mine/vault-id`;
  если id отсутствует, файл создаётся автоматически.
- Если локальный derived store уже существует, UI открывается из snapshot, а sync идёт в фоне.
- Если локальный derived store отсутствует, создаётся пустой local store и запускается rebuild в фоне.
- Legacy `.arena/index.db` и `.arena/cache/thumbs` не участвуют в runtime path.
- Известные legacy artifacts удаляются из source vault после bootstrap.

#### 3. UX первой миграции

- Shell рисуется сразу.
- Если snapshot уже есть — UI открывается из него и показывает фоновый статус синхронизации.
- Если snapshot отсутствует — показывается `Preparing library…` с прогрессом и счётчиками.
- Этапы прогресса:
  - `Creating local index`
  - `Scanning markdown`
  - `Generating previews`
- UI становится usable после первого committed snapshot, не после полного rebuild.
- Если rebuild прерван, partial local store сохраняется и следующий запуск продолжает incremental pass, а не начинает с нуля.

#### 4. Feed preview-only contract

- Feed, grid и sidebar используют только preview assets из local derived store.
- Оригинальные `mediaUrl(...)` и real media запрещены в feed path.
- `FeedPreviewManifest` — новый internal контракт для feed:
  - `primary_preview_path`
  - `kind`
  - `tiles[]` до 4
  - `overflow_count`
  - `source_stamp`
- Feed всегда рендерит только `primary_preview_path`.
- Multi-image/social/article-with-many-images не собираются на клиенте.
- Composite preview в v1 генерируется в Rust как один local JPEG.
- Для 4+ изображений feed использует composite preview + `overflow_count`, а не дополнительные asset reads.
- Autoplay video в feed не входит в `Critical Path Reset v1`; базовый feed contract остаётся preview-first.
- Follow-up phase после стабилизации feed contract:
  - dedicated `video` blocks autoplay в feed;
  - single-video previews (`article` / `social` с одним видео) autoplay в feed;
  - multi-media grids и composite/article-with-many-media остаются preview-only.

#### 5. Preview invalidation

- `source_stamp = markdown(mtime_ns + size) + media deps(mtime_ns + size)`.
- Content hashing в v1 не используется.
- Это расширение текущего `is_thumb_fresh` pattern, а не новая независимая invalidation-система.
- Изменение `.md`, embedded image или любого media dependency инвалидирует preview для соответствующего slug.

#### 6. Measurement/layout contract

- `MeasureCard` не монтирует real media.
- Hidden measurement не делает file reads.
- Layout живёт от descriptor + preview geometry.
- Width-bucket change и route switch должны работать поверх media-free measurement path.

#### 7. Safety net

- После preview-only migration обязателен `sample` на scroll `Everything`.
- Если `tauri::protocol::asset::get_response` остаётся main-thread hotspot в feed scenario, async/custom asset handling автоматически становится **release blocker этой же фазы**, а не Phase 2 convenience optimization.

### Critical Path Reset v1 Phases

| # | Phase | Status | Deliverables |
|---|-------|--------|--------------|
| C1 | Derived Store Migration | [x] | `vault-id`, local app-data store, startup/open against local index, first-run migration UX |
| C2 | Feed Preview Pipeline | DONE | Existence-backed `FeedPreviewManifest`, unique derived tiles, feed/detail split and zero original-source requests in Grid acceptance |
| C3 | Measurement + Invalidation Hardening | DONE | Media-free deterministic measurement, persisted dependency stamps and derived-preview invalidation |
| C4 | Residual Risks / Follow-up | DONE for A1–A3 | Filesystem catch-up, watcher recovery, rollback-safe source writes and browser profiling gates are complete; optional Detail asset optimization remains backlog |
| C5 | Feed Video Phase | MANUAL QA | explicit `feed_playback` contract, tiered `standard/heavy` autoplay policy, poster-first `FeedVideoSurface`, single-active autoplay, preview-only galleries |
| C6 | Identity Assets | [x] | Redaction 100 Italic `m`, platform-specific app icons, toolbar circle icon, Instagram overlay glyph/button contract |
| C7 | Feed Scroll Readiness | DONE / SUPERSEDED BY C8 | adaptive render/priority/preload windows, preview-only decode scheduler, bounded concurrency/LRU, development diagnostics; implemented but insufficient for perfect fast scroll |
| C8 | Grid Layout Readiness / Viewport-first Measurement | [x] | viewport-first measurement scheduler, non-contiguous live measured islands, layout diagnostics, automated browser scroll audit; real Everything acceptance passed |

### Current progress snapshot

- `C1` завершён:
  - `vault-id` живёт в source vault;
  - `index.db` и thumbs cache переехали в per-device app data store;
  - startup/open работает против local derived store, а не против SQLite внутри iCloud vault;
  - первый migration UX path заложен.
- `C2` завершён:
  - Grid/Card/preloader принимают только `preview_state = ready` и derived cache paths;
  - каждый tile имеет собственный preview artifact, а missing/stale cache переводит
    manifest в regeneration, не в source fallback;
  - Detail использует отдельный full-fidelity parser и по-прежнему может открывать
    оригиналы;
  - `bun run test:feed-scroll` подтверждает ноль source-vault media requests.
- `C3` завершён:
  - deterministic descriptor/layout path не монтирует media для измерения;
  - `source_stamp` покрывает Markdown и media dependencies;
  - stale worker не может опубликовать manifest после изменения stamp;
  - cache deletion/dependency changes планируют resumable preview regeneration.
- `C5` выполнен частично:
  - введён explicit backend-derived `feed_playback` contract для desktop feed autoplay;
  - galleries больше не монтируют live video вообще и остаются preview-only;
  - dedicated `video` blocks и single-video `article` / `social` autoplay'ят только через `FeedVideoSurface`;
  - `FeedVideoSurface` получил poster-first fail-safe state machine (`direct -> blob -> poster-only`) без blank video box;
  - single-video poster contract унифицирован на frontend feed path:
    - `FeedVideoSurface` и poster-only branches теперь используют один candidate chain;
    - poster source выбирается в порядке `feed_playback.poster_preview_path -> preview_manifest.primary_preview_path -> tile preview -> block thumb`;
  - autoplay policy стала двухступенчатой вместо жёсткого compact-only gate (пороги подняты в feed-оптимизации 02.07.2026, см. ниже):
    - `standard` — clips до `24 MiB` идут через `direct -> blob -> poster-only`; зависший `fetch` ограничен `FEED_VIDEO_FETCH_TIMEOUT_MS` и уходит в retry;
    - `heavy` — clips до `512 MiB` (или с неизвлечёнными габаритами) идут строго `direct -> poster-only` без blob-буфера; `failed_poster_only` не терминальна (memory-free retry);
    - descriptor не создаётся только выше hard limits (пиксельные лимиты или source bytes > `512 MiB`);
  - grid autoplay policy смягчена под feed UX:
    - все committed `standard` clips autoplay'ят одновременно, если их playback surface покрыта expanded autoplay window (`viewport ± 50%` высоты экрана) минимум на `50%`;
    - `heavy` clips autoplay'ят пулом `FEED_HEAVY_MAX_ACTIVE` (= 2) с детерминированным tie-break и гистерезисом `0.1`, который не переносится через границу `inViewport`;
    - autoplay больше не сбрасывается на всём `measuring`; уже committed prefix может продолжать и начинать playback, пока нижняя часть grid ещё догоняет layout;
  - `C5` имеет статус `MANUAL QA`: autoplay dedicated video, autoplay
    single-video previews, preview-only multi-media и отсутствие blank square
    при failures требуют ручной приёмки пользователем.
- `C6` завершён:
  - product mark зафиксирован как строчная `m` из Redaction 100 Italic;
  - iOS app icon использует square white source под системную mask;
  - macOS/Tauri app icon использует transparent canvas + inset white rounded tile, чтобы Dock не показывал oversized квадрат;
  - extension toolbar icon — белый круг с чёрной `m`;
  - Instagram overlay отделён от toolbar icon: content script рисует круглую белую кнопку и вставляет glyph-only `clipper-overlay-32.png`.
- `C7` реализован:
  - целевой контракт описан в [SPEC_FEED_SCROLL_PERFORMANCE.md](SPEC_FEED_SCROLL_PERFORMANCE.md);
  - render window, image priority window и media preload/decode window имеют разные адаптивные бюджеты;
  - media preload hot path использует только derived preview/poster/thumbnail assets, не оригинальные source media;
  - Grid подключает bounded `Image.decode()` queue без дополнительных preload-only `GridItem`;
  - diagnostics доступны через `window.__MINE_FEED_SCROLL_DEBUG__`;
  - manual acceptance на реальном fast scroll показал, что C7 решает только media-readiness слой и не устраняет белые/пустые состояния полностью.
- `C8` реализован как baseline:
  - current-viewport measurement имеет приоритет над prefix catch-up;
  - live-render больше не зависит только от strict contiguous `committedEndIndex`;
  - `useGridScroll` имеет anti-blank sync commit для native scroll jumps;
  - `window.__MINE_FEED_SCROLL_DEBUG__.viewport` классифицирует paint-layer blank risk;
  - `bun run test:feed-scroll` добавлен как browser-level gate для blank viewport, skeleton-only viewport, near-blank screenshot, DOM-window inflation, slow settle, frame gaps и long tasks;
  - manual acceptance на реальном `Everything` после C8.16 показал значимое улучшение: белый viewport практически не воспроизводится в обычном aggressive scroll;
  - Phase 11 позже закрыл strategic scope и убрал production DOM measurement class полностью.

### Phase C7 — Feed Scroll Readiness [IMPLEMENTED, INSUFFICIENT]

Goal: сделать быстрый, но архитектурно правильный слой подготовки ленты, чтобы
при быстром scroll медиа не догоняли viewport рывками.

| # | Task | Status |
|---|------|--------|
| C7.1 | SPEC + docs: зафиксировать canvas-feel как adaptive media readiness architecture, а не overscan tweak | [x] |
| C7.2 | Extract shared `feedMediaCandidatesForBlock`: one derived-preview URL chain for Card/preloader, source media excluded from preload | [x] |
| C7.3 | Add `feedScrollReadiness` pure helpers: RAF-sampled velocity model, adaptive render/priority/preload windows, hysteresis, clamps and tests | [x] |
| C7.4 | Add bounded `FeedMediaPreloadQueue`: max concurrency `4`, queue `160`, LRU `400`, decode timeout `3000ms`, failed URL suppression | [x] |
| C7.5 | Integrate `useFeedMediaPreloader` into Grid without adding preload-only GridItems or scroll-pixel React state | [x] |
| C7.6 | Retune render/priority windows according to the adaptive formulas, not fixed magic constants | [x] |
| C7.7 | Add development diagnostics and tuning protocol evidence: mounted count, window sizes, queue length, active decodes, decoded/failed/skipped counters | [x] |
| C7.8 | Validate fast scroll on real `Everything`: C7 reduces one media-readiness layer but does not satisfy the “infinite canvas” contract under aggressive scroll | [x] |
| C7.9 | Stop treating this as an overscan/preload tuning problem; promote layout readiness to C8 | [x] |

### Phase C8 — Grid Layout Readiness / Viewport-first Measurement [IMPLEMENTED]

Goal: устранить белые/пустые состояния и рывки при fast/random-access scroll,
которые остаются после C7, за счёт архитектуры готовности layout, а не за счёт
ещё более широкого media preload.

Root cause hypothesis:

- C7 готовит preview media ahead-of-viewport, но не может сделать карточку
  видимой, если Grid ещё не разрешил её live-render.
- Текущий `committedEndIndex` — это strict contiguous prefix: карточка с index
  `N` не считается committed, пока все карточки `0...N-1` не получили exact
  height.
- `measurementBatch` набирает missing blocks из prefix до
  `targetCommittedEndIndex`, поэтому при резком прыжке вниз viewport может
  ждать измерение большого числа карточек выше себя.
- Значит, remaining defect находится в layout readiness / measurement
  scheduling, а не в яркости placeholder, preload window или image decode
  concurrency.

Non-goals:

- Не увеличивать DOM до whole-route render.
- Не возвращать scroll anchoring как универсальный фикс; предыдущий masonry
  anchoring уже был reverted из-за feedback loop.
- Не загружать source media в feed path.
- Не добавлять visible debug/service text в UI.

| # | Task | Status |
|---|------|--------|
| C8.1 | SPEC: formalize viewport-first layout readiness, exact viewport islands, telemetry, acceptance criteria and relation to Phase 11 Zero-Jank Masonry | [x] |
| C8.2 | Dev-only diagnostics: expose `committedEndIndex`, `targetCommittedEndIndex`, `maxVisibleIndex`, viewport/visible unmeasured counts, `measurementBatch.length`, layout generation, scroll velocity and media preload stats | [x] |
| C8.3 | Regression harness: simulate deep fast-scroll / scroll jump into an initially unmeasured area and assert the viewport is prioritized before prefix catch-up | [x] |
| C8.4 | Measurement scheduler: prioritize missing visible items, then near-forward window, then backward/prefix background, with bounded batch size and no scroll-pixel React fan-out | [x] |
| C8.5 | Live-render gate rewrite: decouple “has exact measured height” from strict contiguous prefix so exact-measured viewport items can render as live cards even when earlier gaps remain provisional | [x] |
| C8.6 | Layout stability contract: keep provisional positions deterministic and apply any exact-height corrections without visible scroll feedback loops during active scroll | DONE — superseded by Phase 11 deterministic layout |
| C8.7 | Height-readiness hardening: reduce hidden DOM dependency by deriving deterministic preview/text heights where possible and persisting reusable measurements by generation bucket | DONE — production hidden DOM measurement removed |
| C8.8 | Integrate with C7: media preloader remains preview-only and bounded, with shared diagnostics so layout backlog is not masked as media backlog | [x] |
| C8.9 | Acceptance on real `Everything`: aggressive trackpad scroll down/up and deep jump cannot produce a blank/white viewport; no whole-route DOM inflation; diagnostics confirm viewport-first measurement | [x] |
| C8.10 | Documentation + verification: update SPEC/ARCHITECTURE/AUDIT/DEVLOG/PLAN and run focused Grid/readiness tests plus full frontend suite | [x] |
| C8.11 | Follow-up after real UI feedback: make render runway velocity-aware and keep hidden layout measurement independent from image load/error timing | [x] |
| C8.12 | Follow-up after complete white-screen feedback: add `useGridScroll` anti-blank sync commit for native scroll jumps that outrun the RAF visible-window update | [x] |
| C8.13 | Diagnostic follow-up after repeated white-screen feedback: add paint-layer viewport diagnostics that compare `layout.positions` to mounted `GridItem` DOM and classify blank risk before the next scroll fix | [x] |
| C8.14 | Convert blank-risk warning into a failing deep-scroll regression and fix `useGridScroll` so anti-blank detection falls back to measured ResizeObserver viewport height when `clientHeight` is unavailable | [x] |
| C8.15 | Browser acceptance harness: dev-only `/__feed-scroll-audit` route plus `bun run test:feed-scroll` Playwright gate for blank viewport, skeleton-only viewport and near-blank screenshot samples | [x] |
| C8.16 | Performance hardening: extend browser scroll gate with DOM/settle/frame/long-task budgets and retune Grid to a viewport-near render window while keeping wider media preload | [x] |
| C8.17 | Regression hardening: cancel obsolete preview/thumb workers, serialize concurrent SQLite schema init, publish preview readiness in 24-row batches, warm one pagination page ahead, and split anti-blank into emergency first-frame commit plus deferred overscan expansion | [x] |

### Phase 24 — Filesystem-first visibility [COMPLETED]

Goal: любой `.md` файл в source vault отображается в приложении как карточка без
ручного rebuild, независимо от того, как он появился: Obsidian/Finder,
web-clipper при закрытом desktop UI, iCloud sync или внешний editor.

| # | Task | Status |
|---|------|--------|
| 24.1 | Backend catch-up primitive: compare source-vault `.md` inventory with local SQLite and upsert missing/changed files | DONE |
| 24.2 | Delete stale index rows when the corresponding source `.md` no longer exists | DONE |
| 24.3 | Call catch-up before final route-facing reads: `list_grid_blocks`, `list_tags`, `list_channels`, `list_channel_previews`, `search_blocks`, `get_block` | DONE |
| 24.4 | Preserve fast startup by allowing provisional cached snapshots only until catch-up completes | DONE |
| 24.5 | Tests: create `.md` directly on disk and assert grid/list/search/detail visibility without restart/rebuild; include missed-watcher regression | DONE |

### Feed & video optimization — 02.07.2026 [COMPLETED]

Многоагентный аудит рендера ленты и видео → две волны оптимизаций → адверсариальное
ревью диффа → закрытие 12 подтверждённых регрессий. Диагноз главной жалобы «видео
во viewport статично»: корень не в постер-пайплайне (постеры на месте, все видео
h264), а в гейтинге воспроизведения (heavy-лимит 1) и индексном слое (тайлы только
из первой секции). Детали — [DEVLOG.md](DEVLOG.md) 02.07.2026.

- Рендер: убран `key={generationKey}` remount, generation key по геометрии колонок
  (`cw|cc`), `reconcileBlocks` сохраняет identity, инкрементальные+прунящиеся
  word-метрики, второй ререндер на кадр скролла устранён, refresh загруженного
  диапазона вместо первой страницы.
- Видео: heavy-пул `= 2` (было `1`) с гистерезисом; порог standard `24 MiB`,
  hard-cut заменён потолком `512 MiB`; mov/m4v в автоплее; ретраи из
  `failed_poster_only`; heavy строго direct-only; тайлы social/article из всех
  `---`-секций (вернуло видео merged-блоков).
- Постеры: `DecodeQueue` concurrency 2, двухэтапные таймауты, дедуп, `640px`,
  per-slug feed thumb-версия (`?v=N`) вместо full refetch, `MEDIA_INDEX_VERSION` 3.
- Проверки: vitest `611/611`, cargo test `638/638`, tsc/eslint/clippy чисто; smoke
  на реальном iCloud Mine vault пройден (тайл-постеры merged-блоков генерируются).
- Известное наблюдение: binary IPC (`save_thumb`/`save_tile_poster`) на текущей
  Tauri-конфигурации идёт через `InvokeBody::Json` fallback (custom-protocol
  недоступен) — корректно, но заявленный raw-выигрыш не реализуется; кандидат на
  перевод в base64 отдельной задачей.

### Current thumbnail / hover hardening — 08.05.2026 [COMPLETED]

- Native host save path now writes source-vault files, upserts SQLite, generates
  Phase 1 thumb, and syncs `thumb_format` / `thumb_mtime` before returning.
- Empty-body media clips with non-Rust-decodable media (AVIF/HEIC/VP8X WebP)
  get a PNG fallback-label placeholder instead of an empty sidebar slot.
- Sidebar preview queries return only confirmed thumb rows
  (`thumb_format IS NOT NULL`); frontend filters `has_thumb=false`
  defensively.
- Watcher/full-scan emits thumb events for fresh PNG placeholders so Phase 2
  WebView upgrade is still requested even when the file was already fresh.
- Sidebar thumbnails and Related Notes use the shared hover-preview timing:
  `500ms` cold delay, `0ms` warm delay inside an `800ms` warm window.
- Hover previews in sidebar and Related Notes are read-only quick-look cards:
  no action buttons, no hover bridge, no popup pinning.

### Current audit hardening — 03.05.2026 [COMPLETED]

- Frontend async route guards:
  - initial route load and pagination ignore stale responses;
  - legacy Cmd+K Search palette has been removed from the frontend;
  - global channel shortcuts do not fire inside Detail, overlays,
    editable fields, or defaultPrevented events.
- Frontend interaction/a11y:
  - Detail keeps arrow keys native to the reading surface and only Escape closes
    the overlay;
  - Detail has an accessible dialog name;
  - Escape from nested menu/listbox/input surfaces does not close Detail;
  - card hover action buttons do not keyboard-bubble into parent card open;
  - All/Connected link mode buttons expose `aria-pressed`.
- Storage/native-host hardening:
  - block creation and native-host saves check disk-only slug/media collisions;
  - new `.md` and media writes use create-new semantics;
  - media copied before a failed final block write is rolled back;
  - collection refs are validated at IPC/native-host boundaries;
  - vault conflict resolution requires valid slugs and an existing pending
    `vault_conflicts` pair;
  - incremental scan diverts iCloud-style conflict files like full scan.
- Clipper/native-host security:
  - Content saves use explicit `idle/loading/ready/empty/failed` extraction state;
  - manual switch to Content starts extraction even when auto-detected as `link`;
  - article saves cannot persist empty body in popup or native host;
  - Link saves write body H1 from real page title instead of empty runtime-media body;
  - save-link context menu path is registered;
  - background upload has `AbortController` timeout;
  - upload tokens use OS randomness, body size is capped at `25 MiB`;
  - remote media fetch rejects private/loopback/link-local/multicast targets.
- Verification contract:
  - `bun run test` now runs Vitest and Rust workspace tests with `--locked`;
  - `bun.lock` and `Cargo.lock` are tracked inputs.

Remaining gap: Safari App Extension native bridge is still a scaffold/stub and
requires a separate implementation before Safari save path can be considered
production-ready.

### Current known product compatibility gap

- **Obsidian Markdown compatibility.**
  - Plain Obsidian `.md` files without Mine frontmatter should be indexed as implicit articles instead of parse errors.
  - Read path must be non-invasive: opening/rebuilding Mine must not write frontmatter into user-authored notes.
  - Mine frontmatter becomes an optional metadata overlay for explicit Mine fields (`Mine Collections`, `type`, `url`, `file`) rather than a hard requirement for displaying Markdown.
  - `tags` is user/Obsidian-owned metadata, not the canonical Mine collection field.
  - Collection writes use `Mine Collections` as quoted Obsidian wikilinks, for example `- "[[Красивый веб]]"`.
  - Legacy `tags` / raw `Mine Collections` are migration inputs, not a permanent runtime format.
  - Scope and migration workflow are specified in `SPEC_OBSIDIAN_MARKDOWN_COMPAT.md` and `SPEC_COLLECTIONS_OBSIDIAN_LINKS.md`.

### Current migration — legacy collections → Obsidian wikilink collections

This migration is deliberate and manually reviewable because existing Obsidian
users often use `tags` for their own systems. The target is not dual support.
The target is one canonical post-migration format documented in
[SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md).

| # | Step | Status | Deliverables |
|---|------|--------|--------------|
| MC1 | Target spec | [x] | `Mine Collections` values are quoted Obsidian wikilinks; collection pages use human filenames |
| MC2 | Dry-run scanner | [x] | `migrate-collections-to-wikilinks --dry-run` reports legacy `tags`, raw `Mine Collections`, normalized channel pages, proposed rewrites and conflicts |
| MC3 | Backup + apply migration | [x] | `--apply` creates timestamped byte backups, rewrites card membership, and safely renames root collection pages |
| MC4 | Runtime write-path switch | [x] | Clipper/app/drag/checkbox/inline extraction write only canonical wikilinks |
| MC5 | Storage/frontend semantic switch | [x] | `CollectionRef` replaces normalized tag semantics while legacy physical names remain in DB/API |
| MC6 | Rebuild + verification | MANUAL QA | Compare counts/order before/after, inspect Obsidian graph, verify no write path emits legacy format |
| MC7 | Legacy fallback removal | DONE | Runtime membership uses canonical wikilinks; legacy fields remain migration diagnostics only |

### Current known blocker before phase completion

- **Existence-backed tile preview contract.**
  - Intended result for multi-image article/social cards: feed получает либо готовый composite preview, либо подтверждённые per-tile preview assets.
  - Current runtime no longer duplicates one `slug.jpg` across all tiles: при missing tile preview asset UI падает в distinct per-source media fallback и сохраняет правильную галерею.
  - Legacy article rows без `preview_manifest` теперь тоже не должны падать в пустой `bg-accent` wrapper: fallback строится из `media_urls` / `first_image` и даёт реальный tile set.
  - Но storage pipeline всё ещё не гарантирует полный set per-tile preview files и backfill `preview_manifest` для legacy rows. Это остаётся незавершённым куском `C2`.
- **Manual validation of unified feed-video runtime.**
  - Poster/autoplay split на frontend feed path закрыт:
    - single-video poster contract теперь общий для `FeedVideoSurface` и poster-only branches;
    - autoplay activation больше не обнуляется на всём `measuring`, если committed prefix уже известен.
  - `C5` всё ещё требует ручной проверки на живых карточках:
    - half-visible long cards;
    - autoplay-ineligible / delayed video cards;
    - стабильность poster surface без black void на реальных clips.

### Acceptance Criteria

- `db_open` на старте больше не зависит от SQLite внутри iCloud vault.
- `Everything` и channel feed не читают оригинальные assets из vault.
- `sample` на scroll feed не показывает `asset::get_response` как dominant hotspot.
- Первая миграция не выглядит как “пустое сломанное приложение”.
- Move vault сохраняет continuity через `vault-id`.
- Второй Mac открывает тот же vault через rebuild local derived store.
- Feed не использует real media в measurement path.
- Initial visible window, route switch и resize не рендерят live cards внутри stale envelope; системной bottom clip / white tail underflow больше нет.
- Multi-image article/social cards no longer collapse to a repeated block-level thumb; feed shows either composite preview or distinct gallery tiles.
- `Detail` продолжает открывать оригиналы.
- Single-video cards never degrade to a black void when autoplay is disabled, delayed, or ineligible; they always keep a stable poster surface.

### Known Residuals

- Этот план **не обещает** мгновенно убрать вообще все лаги.
- После него осознанно могут остаться:
  - filesystem-first route catch-up;
  - watcher correctness improvements beyond route catch-up;
  - frontend boot / per-first-paint optimization;
  - отдельная оптимизация Detail/original asset path;
  - отдельные windowing bugs, если они сохранятся после перевода feed на previews.
- Эти пункты считаются ожидаемым остатком, а не неожиданным новым регрессом.

### Assumptions

- `vault-id` — sync'ed файл внутри vault.
- Derived store — всегда per-device local.
- Известные legacy `.arena/*` artifacts удаляются автоматически после bootstrap;
  неизвестные legacy подпапки не трогаются.
- Composite preview в v1 генерируется серверно в Rust.
- Preview invalidation в v1 основан на `mtime_ns + size`.
- Autoplay video в feed не входит в `Critical Path Reset v1`; он возвращается отдельной фазой только для dedicated `video` blocks и single-video previews.

## Phases

### Phase 0 — Архитектура и документация [COMPLETED]

Goal: полный каркас проекта — принципы, архитектура, PRD, юзкейсы.

| # | Task | Status |
|---|------|--------|
| 0.1 | CLAUDE.md, ARCHITECTURE.md, PLAN.md, DEVLOG.md | [x] |
| 0.2 | PRINCIPLES.md — инженерные принципы и антипаттерны | [x] |
| 0.3 | SPEC_PRD.md — модель данных, типы блоков, интерфейс | [x] |
| 0.4 | SPEC_USECASES.md — юзкейсы и сценарии | [x] |
| 0.5 | Git + GitHub репозиторий | [x] |

### Phase 1 — Эталонный модуль + инициализация [COMPLETED]

Goal: Tauri-проект инициализирован, `domain/block` реализован идеально — спецификация, тесты, код. Это образец для всех модулей.

| # | Task | Status |
|---|------|--------|
| 1.1 | Инициализация Tauri v2 + React + Vite + TypeScript + Tailwind | [x] |
| 1.2 | Структура директорий: domain/, storage/, watcher/, commands/ | [x] |
| 1.3 | Настройка specta для типогенерации Rust → TypeScript | отложено до Phase 5 |
| 1.4 | SPEC_BLOCK.md — спецификация domain/block | [x] |
| 1.5 | Тесты domain/block (59 тестов, все 20 edge cases) | [x] |
| 1.6 | Реализация domain/block (59/59 зелёных) | [x] |
| 1.7 | Ретроспектива | [x] |

### Phase 2 — Domain layer [COMPLETED]

Goal: вся бизнес-логика реализована и протестирована. Чистые типы и функции, без зависимостей от Tauri/SQLite.

| # | Task | Status |
|---|------|--------|
| 2.1 | SPEC + TEST + CODE: domain/tag (12 тестов) | [x] |
| 2.2 | SPEC + TEST + CODE: domain/channel (20 тестов) | [x] |
| 2.3 | SPEC + TEST + CODE: domain/vault (13 тестов) | [x] |
| 2.4 | SPEC + TEST + CODE: domain/search (15 тестов) | [x] |

### Phase 3 — Storage layer [COMPLETED]

Goal: SQLite-индекс, файловые операции, thumbnail-пайплайн. Всё персистентное.

| # | Task | Status |
|---|------|--------|
| 3.1 | SPEC + TEST + CODE: storage/db (схема, FTS5 триггеры, WAL) | [x] |
| 3.2 | SPEC + TEST + CODE: storage/index (CRUD блоков/каналов/тегов, поиск) | [x] |
| 3.3 | SPEC + TEST + CODE: storage/files (write, read, scan, copy, delete) | [x] |
| 3.4 | SPEC + TEST + CODE: storage/thumbnails (Lanczos3 ресайз, JPEG) | [x] |
| 3.5 | SPEC + TEST + CODE: FTS5 поиск (встроен в storage/index) | [x] |

### Phase 4 — Watcher + Commands (интеграция) [COMPLETED]

Goal: file watcher отслеживает vault, Tauri commands связывают бэкенд с фронтендом. Полный сканер vault.

| # | Task | Status |
|---|------|--------|
| 4.1 | SPEC + TEST + CODE: watcher/events (классификация notify событий, 9 тестов) | [x] |
| 4.2 | SPEC + TEST + CODE: watcher/handler (full_scan, index_md_file, handle_event, 10 тестов) | [x] |
| 4.3 | SPEC + TEST + CODE: commands/vault (select_vault, get_vault_path) | [x] |
| 4.4 | SPEC + TEST + CODE: commands/blocks (list, get, create, delete) | [x] |
| 4.5 | SPEC + TEST + CODE: commands/tags (list, add, remove) | [x] |
| 4.6 | SPEC + TEST + CODE: commands/search (FTS5 query) | [x] |
| 4.7 | commands/channels (list, create, delete) + AppState + lib.rs wiring | [x] |

### Phase 5 — Frontend [COMPLETED]

Goal: полноценный UI — сетка, sidebar, детальный вид, поиск. 60 fps на 10 000 блоков.

| # | Task | Status |
|---|------|--------|
| 5.1 | SPEC_FRONTEND.md: компоненты, типы, IPC, роутинг | [x] |
| 5.2 | TypeScript types + IPC layer (18 команд) | [x] |
| 5.3 | VaultPicker: выбор папки через системный диалог | [x] |
| 5.4 | Sidebar: каналы, счётчики, навигация, кнопка импорта | [x] |
| 5.5 | Grid: чанковый рендеринг (IntersectionObserver, 80+60 батчи) | [x] |
| 5.6 | Card: адаптивные карточки по типу блока (5 типов) + фолбэк для сломанных изображений | [x] |
| 5.7 | Legacy Search: Cmd+K command palette removed from frontend; backend FTS remains index infrastructure | [x] |
| 5.8 | Detail: lightbox, теги (добавить/удалить), навигация стрелками | [x] |
| 5.9 | App: роутинг (react-router), состояние vault, загрузка данных | [x] |
| 5.10 | Drag-and-drop файлов → создание блока (DropZone) | [x] |
| 5.11 | Sidebar drag-reorder каналов (HTML5 DnD, reorder_channels команда) | [x] |
| 5.12 | Real-time updates: Tauri events → React state (vault-changed) | [x] |
| 5.13 | Тёмная/светлая тема (системная) — базовая поддержка через dark: | [x] |
| 5.14 | Тесты компонентов (vitest + testing-library, 43 теста, 5 файлов) | [x] |

### Phase 6 — Импорт из Are.na [COMPLETED]

Goal: пользователь переносит каналы из Are.na.

| # | Task | Status |
|---|------|--------|
| 6.1 | Are.na API клиент: пагинация, rate-limiting, десериализация (ureq) | [x] |
| 6.2 | Маппинг: Are.na block → .md + медиафайл, channel → тег | [x] |
| 6.3 | Загрузка медиафайлов и генерация thumbnails | [x] |
| 6.4 | Tauri-команды: list_arena_channels, import_arena_channels | [x] |
| 6.5 | UI импорта: ImportDialog (ввод username, выбор каналов, прогресс-бар) | [x] |
| 6.6 | Тестирование с реальными данными | отложено |

### Phase 7 — Финализация [IN PROGRESS]

Goal: продакшен-готовность. Профилирование, edge cases, сборка.

| # | Task | Status |
|---|------|--------|
| 7.1 | Чанковый рендеринг Grid (IntersectionObserver, 80+60 батчи) | [x] |
| 7.2 | Edge cases: фолбэк при сломанных изображениях, missing media | [x] |
| 7.3 | Пересборка индекса из файлов (rebuild_index команда) | [x] |
| 7.4 | Автообновление (Tauri updater) | отложено — требует ручной генерации ключей |
| 7.5 | Иконка (SVG → icns/ico/png), нативное macOS-меню, About | [x] |
| 7.6 | Сборка .dmg, подпись, нотаризация | DEFERRED — outside current DoD |
| 7.7 | Исправление drag-and-drop: rename_all = "snake_case" для create_block (Tauri v2 camelCase по умолчанию) | [x] |
| 7.8 | Исправление сброса прокрутки Grid: blocksFingerprint вместо ссылки на массив + отображение ошибок в DropZone | [x] |
| 7.9 | Бэкенд: команда rename_channel (обновление тега во всех .md + индексе) | [x] |
| 7.10 | Теги в сайдбаре: отображение всех уникальных тегов из frontmatter, контекстное меню (переименовать/удалить), inline-редактирование | [x] |
| 7.11 | Drag-and-drop карточки / открытого Detail на тег (dnd-kit + PointerSensor): sidebarPointerWithin row-under-cursor collision, autoScroll сайдбара, shared block payload | [x] |
| 7.12 | Контекстное меню карточки (правый клик): теги с чекбоксами, поиск, создание нового тега, удаление с подтверждением | [x] |
| 7.13 | Drag-and-drop каналов: @dnd-kit/sortable, SortableContext, reorder_channels с автосозданием записей, кнопка «New channel» | [x] |
| 7.14 | Багфиксы drop-зоны: тег текущего канала при file drop, защита от дублирования, isCardDragging для синего кольца, удаление канала при удалении тега, Unicode в slugifyTag | [x] |
| 7.15 | Качество thumbnail: 240→480px (Retina 2x), JPEG quality 80→85, единая константа DEFAULT_MAX_SIZE | [x] |
| 7.16 | DragOverlay: курсор «держит» карточку за левый верхний угол вместо центра; block overlay рендерит feed-card preview, а не текстовую плашку | [x] |
| 7.17 | Меню каналов: скрытие Delete при поиске, создание канала при отсутствии совпадений, MRU-ранжирование (localStorage), единообразие с клиппером | [x] |
| 7.18 | Дизайн-система: shadcn/ui (токены, `cn()`, ThemeProvider, миграция оболочки App+Sidebar на семантические токены) | [x] |
| 7.19 | Миграция всех компонентов на семантические токены: замена neutral-*/dark: на bg-card/text-foreground/border-border/bg-muted и т.д. | [x] |
| 7.20 | shadcn/ui компонентная миграция: 14 примитивов (Button, Input, Badge, Checkbox, Progress, Separator, Dialog, Command, ContextMenu, DropdownMenu, AlertDialog, ScrollArea, Tooltip), glass-токены, lucide-react иконки | [x] |
| 7.21 | Grid: делегирование ContextMenu (O(N)→O(1)) + синхронный сброс visibleCount + исправление скролла контекстного меню + hover сайдбара | [x] |
| 7.22 | Визуальная стилизация: overlay titlebar + drag region, Geist Sans (UI) + Geist Mono (карточки, метаданные), острые карточки без заливки, GAP 32px, sidebar без заголовка с градиентным fade | [x] |
| 7.23 | Иконки каналов в sidebar: стопка из 1–3 мини-карточек с реальными превью, веерная анимация при ховере | [x] |
| 7.23.1 | Sidebar thumbnail hover preview restored as read-only quick-look: no action buttons, no hover bridge, closes on thumbnail leave | [x] |
| 7.24 | Fullscreen Detail: двухслойный layout (scroll + fixed metadata), Geist Mono, top menu modes (`Classic` / `Island`), filename drag handle в sidebar | [x] |
| 7.24.1 | Membership actions: sidebar link-editor + CollectionPicker use `Connected` always, hover `Connect`/`Disconnect`, no checkbox | [x] |
| 7.24.2 | Sidebar row edge alignment: no inner horizontal row padding, right counts monospace, action buttons flush to row edge, 1px optical text compensation | [x] |
| 7.24.3 | Sidebar navigation rows: remove hover and active-route background/text highlight from `Everything` and channel rows | [x] |
| 7.24.4 | Membership actions: visible `Disconnect` state uses destructive red text | [x] |
| 7.24.5 | Sidebar thumbnail strip fade: replace abrupt linear mask with one always-on fixed-width 72px eased alpha mask, without hover-state overlay changes | [x] |
| 7.24.6 | Sidebar link-editor actions: render `Connect`/`Disconnect` as absolute row overlay, not a flex item, so buttons never shift thumbnail strip mask | [x] |
| 7.24.7 | Sidebar link-editor close: remove row actions immediately on `detailChromeClosing`; only top chrome uses closing snapshot | [x] |
| 7.24.8 | Sidebar row focus-mode: default `text-foreground`, hover/focus dims non-focused labels/counts to `muted-foreground` and thumbnail strips to `0.9`, with animated enter/exit and instant row switching | [x] |
| 7.25 | Detail related-notes hover preview: row-key positioning, 3px preview radius, viewport-aware side/up placement, read-only quick-look card, shared hover timing | [x] |
| 7.26 | Detail inline-image hover preview: image wrapper hover outline + resolver `image src/mediaRef -> extracted media block` + below/above interactive preview | FEATURE BACKLOG |
| 7.27 | Single-instance guard для desktop app: повторный запуск должен фокусировать существующее окно, а не создавать вторую инстанцию | FEATURE BACKLOG — duplicate suppressed, focus/raise missing |
| 7.28 | Sidebar resize handle: suppress native WebKit text selection from `pointerdown`, before drag threshold | [x] |
| 7.29 | Sidebar ordinary rows: remove hover ellipsis action that replaced counts; keep Rename/Delete in row ContextMenu | [x] |

### Phase 8 — Веб-клиппер (браузерное расширение) [COMPLETED]

Goal: расширение для Chrome и Safari — сохранение ссылок, статей, изображений и видео прямо из браузера в vault.

| # | Task | Status |
|---|------|--------|
| 8.1 | SPEC_CLIPPER.md — спецификация: типы клипов, popup UI, native messaging, извлечение метаданных | [x] |
| 8.2 | Native messaging host (Rust-бинарник): чтение vault, запись блоков, индексация, thumbnails | [x] |
| 8.3 | WebExtension: content script (метаданные, Readability.js), popup UI (сегментированный контрол типа, каналы, предпросмотр) | [x] |
| 8.4 | Контекстное меню: Save page / Save image / Save selection / Save link | [x] |
| 8.5 | Автоопределение типа контента (эвристика: article/link/video) + ручное переключение | [x] |
| 8.6 | Safari-обёртка: xcrun safari-web-extension-converter → Xcode-проект | [x] |
| 8.7 | Тестирование с реальными данными (native host дымовой тест пройден) | [x] |
| 8.8 | Ремонт форматирования (tweetTextToMarkdown, убран .textContent) и логики типов (переключатель всегда виден, жадная загрузка статьи, перезапрос выделения) | [x] |
| 8.9 | Переделка UX клиппера: Content/Link, недавние каналы, встроенный список, HTTP-заголовки для загрузки картинок, async контекстное меню | [x] |
| 8.10 | Багфикс: Referer на URL страницы (не картинки), реалистичный User-Agent, windows.create() вместо openPopup(), адаптивный размер окна | [x] |

### Phase 9 — Аудит и укрепление кодовой базы [PARTIAL]

Goal: довести проект до продакшен-качества по результатам аудитов ([AUDIT.md](AUDIT.md)). Устранить все критические и высокие проблемы, закрыть пробелы в тестовом покрытии, укрепить безопасность.

**Аудиты:**
- 01.03.2026 — первый аудит (11 агентов): 6 критических, 10 высоких, 12 средних
- 03.03.2026 — повторный аудит (10 агентов): 3 новых критических, 10 новых высоких, 8 новых средних
- 07.03.2026 — третий аудит (10 агентов): 5 новых критических, 11 новых высоких, 20 новых средних. Системные проблемы: масштабируемость O(N), безопасность IPC, устаревшая документация

#### 9.1 — Критические исправления первого аудита (блокеры релиза) [COMPLETED]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.1.1 | `panic!()` → `Result` в `resolve_slug_conflict()` | CRIT-1 | [x] |
| 9.1.2 | Обернуть `upsert_block()` в `conn.unchecked_transaction()` | CRIT-2 | [x] |
| 9.1.3 | Исправить N+1: батч-запрос в `collect_blocks()` | CRIT-3 | [x] |
| 9.1.4 | Включить CSP в `tauri.conf.json` | CRIT-4 | [x] |
| 9.1.5 | Исправить XSS в `popup.js` (DOM API) | CRIT-5 | [x] |
| 9.1.6 | Установить ESLint 10 + typescript-eslint | CRIT-6 | [x] |

#### 9.2 — Высокие исправления первого аудита (частично) [COMPLETED]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.2.1 | Убрать `unwrap_or(BlockType::File)` в `row_to_block()` | HIGH-2 | [x] |
| 9.2.2 | Заменить 20x `lock().unwrap()` на `map_err` во всех commands | HIGH-3 | [x] |
| 9.2.3 | `unwrap()` → `.expect()` на `duration_since(UNIX_EPOCH)` | HIGH-4 | [x] |
| 9.2.4 | Path traversal: `canonicalize()` + `is_file()` | HIGH-5 | [x] |
| 9.2.5 | Добавить `console.error()` в пустые `catch {}` | HIGH-7 | [x] |
| 9.2.6 | Добавить индекс `idx_blocks_saved_at` | HIGH-1 | [x] |
| 9.2.7 | Добавить индекс `idx_block_tags_block_id` | HIGH-1 | [x] |

#### 9.3 — Критические исправления повторного и третьего аудитов [DONE]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.3.1 | Native messaging matching: хост эхо-возвращает `_messageId`, background.js матчит по нему (FIFO остаётся fallback для старых хостов) | CRIT-7 | [x] |
| 9.3.2 | Откат медиафайлов при ошибке записи .md в native_host (primary media + inline-картинки статьи через `cleanup_inline_files`) | CRIT-8 | [x] |
| 9.3.3 | `lock().unwrap()` → `into_inner()` в watcher/watch.rs | CRIT-9 | [x] |
| 9.3.4 | Валидатор slug на IPC-границе через `validate_slug` (traversal/NUL/`\`/абсолютные/`..`); устаревший критерий `^[a-z0-9-]+$` неприменим после Unicode-NFC identity (Phase 18) | CRIT-10 | [x] |
| 9.3.5 | Route-scoped `list_grid_blocks(current_tag)` без per-block tags; следующая цель — ещё более лёгкий first-screen DTO | CRIT-11 | [x] |
| 9.3.6 | SQL-проверка slug вместо загрузки всех блоков в create_block | CRIT-12 | [x] |
| 9.3.7 | `has_thumbnail` / `thumb_format` / `thumb_mtime` в SQLite вместо N syscall-ов в `list_channel_previews` | CRIT-13 | [x] |
| 9.3.8 | `catch_unwind` в потоке thumb-gen | CRIT-14 | [x] |
| 9.3.9 | `list_channel_previews` без полного `list_blocks_light()`: SQL top-N slugs для `__all__` и per-tag | PERF-1 | [x] |
| 9.3.10 | Подавление watcher-событий во время `start_vault_sync` для того же vault, чтобы убрать `database is locked` storm | PERF-4 | [x] |

#### 9.4 — App.tsx: надёжность и производительность [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.4.1 | try/catch на все 9 async-функций (loadData, handleRenameTag, handleDeleteTagFromAll, handleCreateChannel, handleReorderTag, handleCardDrop, handleToggleTag, handleCreateTagFromMenu, handleDeleteBlock) | HIGH-11 | DONE |
| 9.4.2 | `useMemo` на channelPreviews — убрать двойной O(N) цикл | HIGH-12 | [x] решено сменой архитектуры: server-derived previews + SQL top-N |
| 9.4.3 | `useMemo` на фильтрацию ChannelPage | HIGH-13 | SUPERSEDED — backend route projection |
| 9.4.4 | `instanceof PointerEvent` вместо `as` cast | MED-12 | CODE CLEANUP |
| 9.4.5 | Открытие vault по snapshot без блокирующего `full_scan()`, фоновые `vault-sync-*` events, switch без `window.location.reload()` | PERF-2 | [x] |
| 9.4.6 | Guard против stale async-ответов при switch vault (`vaultPathRef` + request id) | PERF-3 | [x] |
| 9.4.7 | Per-route `GridSnapshot` cache + skip duplicate startup fetch на route effect | PERF-5 | [x] |

#### 9.5 — Безопасность: валидация URL [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.5.1 | Проверка протокола (http/https) перед `href` в Detail.tsx:171 | MED-8 | DONE — `isSafeUrl` |
| 9.5.2 | Валидация URL в markdown-ссылках Detail.tsx:356—365 | MED-9 | DONE — `safeMarkdownUrl` |
| 9.5.3 | Валидация og:image в popup.js:276 | MED-17 | DONE — React/render boundary, no HTML injection |
| 9.5.4 | `<all_urls>` → `["https://*", "http://*"]` в manifest.json | — | DONE — scoped manifest matches |

#### 9.6 — Транзакции в составных операциях [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.6.1 | Обернуть rename_tag в транзакцию | HIGH-16 | DONE — source backup/restore rollback |
| 9.6.2 | Обернуть delete_tag_from_all в транзакцию | HIGH-16 | DONE — source backup/restore rollback |
| 9.6.3 | Обернуть rename_channel (3 шага) в транзакцию | HIGH-17 | DONE — DB transaction + source rollback |
| 9.6.4 | Обернуть rebuild_index в транзакцию | HIGH-18 | DONE — non-destructive reconciler preserves last-good projection |
| 9.6.5 | Обернуть import_channel в транзакцию | — | SUPERSEDED — per-block recoverable import contract |

#### 9.7 — Производительность бэкенда [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.7.1 | SQL-запрос для проверки slug вместо загрузки всех блоков | HIGH-14, CRIT-12 | DONE |
| 9.7.2 | HashMap вместо линейного поиска в list_channels | HIGH-15 | [x] |
| 9.7.3 | Убрать дублирующие вызовы get_all_tags в channels.rs | HIGH-15 | SUPERSEDED — route-specific projections |
| 9.7.4 | FTS5: `tokenize='unicode61 remove_diacritics 0'` для кириллицы | MED-2 | SUPERSEDED — Hybrid Search contract |
| 9.7.5 | TOCTOU в `delete_block_files()`: ловить `ErrorKind::NotFound` | MED-4 | DONE — missing delete is idempotent |
| 9.7.6 | Лимит на размер изображения перед `image::open()` | MED-5 | ACTIVE hardening |
| 9.7.7 | Исправить порядок удаления в delete_block (файлы → индекс) | MED-18 | DONE |
| 9.7.8 | Одна транзакция на весь `full_scan` вместо 10K отдельных | HIGH-27 | DONE |
| 9.7.9 | Батчинг IN-запроса тегов по 500-900 | HIGH-28 | ACTIVE performance |
| 9.7.10 | `React.memo` на Card + `useCallback` на обработчики | HIGH-26 | DONE |
| 9.7.11 | `PRAGMA busy_timeout = 5000` в apply_pragmas | MED-31 | DONE |
| 9.7.12 | Индекс на `block_type` | MED-37 | DONE |

#### 9.8 — Веб-клиппер: надёжность [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.8.1 | Очистка таймеров при onDisconnect в background.js | CRIT-7 | DONE |
| 9.8.2 | Таймауты на промисы в popup.js (getContextMenuData, extractMetadata, articlePromise) | — | DONE |
| 9.8.3 | HTTP-таймауты `.timeout(Duration::from_secs(30))` в native_host | MED-6, HIGH-24 | DONE |
| 9.8.4 | Атомарная запись файлов (write-to-temp → rename) в native_host | MED-7 | DONE — staged source mutation contract |
| 9.8.5 | `unwrap()` → Result в native_host.rs:384, 441 | — | DONE for audited request paths |
| 9.8.6 | Валидация URL в content.js перед формированием markdown-ссылок | MED-9 | SUPERSEDED — render/fetch boundary validation |
| 9.8.7 | ext_from_url(): определять MIME из Content-Type заголовков | MED-19 | FEATURE BACKLOG |
| 9.8.8 | Сломанная ссылка popup в контекстном меню: `popup.html` → `dist/index.html` | HIGH-29 | SUPERSEDED — overlay/Vite entry |
| 9.8.9 | SSRF: валидация схемы (https only) + запрет приватных IP в download_file | HIGH-21 | DONE — every redirect hop validated |
| 9.8.10 | Валидация тега в native host create_channel | MED-35 | DONE |
| 9.8.11 | `<all_urls>` → `chrome.scripting.executeScript()` по требованию | MED-34 | SECURITY BACKLOG |
| 9.8.12 | X long-form article extraction: typed `extractXLongformArticle()` before tweet/thread fallback, strict no image-only article save, fixtures for article/tweet/thread/media/selection paths | — | [x] |
| 9.8.13 | X quote tweet extraction: separate top-level thread selection from per-tweet content parsing, keep quoted text/media inside parent tweet body, add lazy Defuddle injection to avoid always-on Temml warnings | — | [x] |

#### 9.9 — Обработка ошибок (оставшиеся) [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.9.1 | `.expect()` → `Result` в `lib.rs:95` — ошибка запуска Tauri | HIGH-10 | ACTIVE hardening |
| 9.9.2 | Утечка слушателя в ImportDialog: паттерн `isMounted` | HIGH-6 | DONE — effect cleanup |
| 9.9.3 | Неочищенные промис-хэндлеры в DropZone.tsx | HIGH-19 | DONE — unlisten cleanup |
| 9.9.4 | Восстановление watcher: `watcher-error` событие, full_scan при накоплении | MED-10 | DONE — coalesced reconcile + watcher replacement |
| 9.9.5 | Разделить ошибки импорта: recoverable vs fatal | MED-11 | FEATURE BACKLOG |
| 9.9.6 | Deadlock risk: задокументировать порядок блокировки мьютексов или объединить state | HIGH-22 | DONE |
| 9.9.7 | Mutex на время импорта: разбить на короткие блокировки | HIGH-23 | DONE |
| 9.9.8 | Утечка таймера в legacy Search.tsx: obsolete after removing frontend Search surface | MED-27 | [x] |
| 9.9.9 | Гонка записи thumbnail: атомарная запись (temp + rename) | MED-32 | DONE |

#### 9.10 — Рефакторинг [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.10.1 | Вынести `titleFromTag()` в `lib/utils.ts` — убрать дублирование из 3 файлов | MED-13 | DONE — helper removed with old UI |
| 9.10.2 | Вынести `is_image_ext()` в `util.rs` — убрать дублирование Rust | MED-1 | SUPERSEDED — predicates intentionally have different semantic scopes |
| 9.10.3 | Заменить хардкод-цвета на семантические токены | HIGH-9 | DONE — design-system tokens |
| 9.10.4 | Извлечь повторяющийся CSS-класс метаданных в `@layer components` | — | CODE CLEANUP |
| 9.10.5 | Убрать dead code в arena_api.rs | — | SUPERSEDED — importer module remains live |
| 9.10.6 | `unsafe-inline` убрать из CSP (если не сломает shadcn) | MED-15 | SECURITY BACKLOG |
| 9.10.7 | Вынести бизнес-логику из commands/ в domain-сервисы | MED-21 | DONE for compound source/index mutation boundary |
| 9.10.8 | Прямой `std::fs::write` в commands/ → storage::files | MED-22 | DONE for production command paths |
| 9.10.9 | Удалить закомментированный DropZone или включить | MED-26 | [x] |
| 9.10.10 | Подключить ImportDialog (добавить триггер) или убрать | MED-25 | DONE — mounted by App |
| 9.10.11 | Удалить `popup/_legacy/` | MED-38 | DONE |
| 9.10.12 | Удалить неиспользуемые экспорты из commands.ts | MED-39 | CODE CLEANUP |

#### 9.11 — Тесты: критические пробелы [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.11.1 | Тесты commands/blocks.rs: create, delete, list, error paths | — | DONE — 35 direct tests |
| 9.11.2 | Тесты commands/tags.rs: add, remove, rename, delete_from_all | — | DONE — 8 direct tests |
| 9.11.3 | Тесты commands/channels.rs: list, create, delete, reorder, rename | — | ACTIVE test gap |
| 9.11.4 | Тесты storage/files.rs: delete (orphaned media), copy (конфликты) | — | DONE — 10 direct tests |
| 9.11.5 | Тесты arena_api.rs: мок HTTP, пагинация, ошибки | — | ACTIVE test gap |
| 9.11.6 | Тесты watcher/watch.rs: запуск/остановка, debounce | — | ACTIVE test gap |
| 9.11.7 | Тесты storage/thumbnails.rs: повреждённые/большие изображения | — | DONE — 32 direct tests |

#### 9.12 — Документация [PENDING]

| # | Task | Ref | Status |
|---|------|-----|--------|
| 9.12.1 | Обновить SPEC_INTEGRATION.md: добавить 6 недокументированных команд | DOC-1, HIGH-30 | DONE by A0 audit |
| 9.12.2 | Обновить DEVLOG.md: запись о повторном аудите и исправлениях | — | DONE by A0 audit |
| 9.12.3 | ARCHITECTURE.md: SQLite-схема (8+ расхождений с кодом) | HIGH-30 | DONE by later schema documentation; A0 adds freshness delta |
| 9.12.4 | SPEC_DOMAIN.md: thumb_path `.webp` → `.jpg` | MED-36 | DONE |
| 9.12.5 | SPEC_STORAGE.md: IndexedBlock — добавить поля source, width, height, author, body | — | DONE |
| 9.12.6 | SPEC_FRONTEND.md: обновить IPC layer (13 → 20 команд), Grid (virtual → chunked) | — | DONE / superseded by current route contracts |

#### Порядок выполнения

```
9.3 (критические — повторный аудит)
     |
9.4 (App.tsx)  ←→  9.5 (URL-безопасность)     — параллельно
     |
9.6 (транзакции)  ←→  9.7 (производительность) — параллельно
     |
9.8 (клиппер)  ←→  9.9 (ошибки)               — параллельно
     |
9.10 (рефакторинг)
     |
9.11 (тесты)  — после всех исправлений
     |
9.12 (документация)  — финальный шаг
```

#### 9.13 — Ремедиация аудита 02.06.2026 [PARTIAL]

Полный аудит кодовой базы (6 параллельных агентов + ручная верификация по `file:line`). Закрытые пункты:

| # | Task | Status |
|---|------|--------|
| 9.13.1 | SSRF: `validate_fetch_url` вынесен в `src-tauri/src/net.rs`, ревалидация каждого redirect-hop через `fetch_validated_get`; применён в native_host + arena_api | [x] |
| 9.13.2 | Лимит размера скачивания (`MAX_MEDIA_BYTES`) в `net::download_validated_to_file` | [x] |
| 9.13.3 | CRIT-7 echo `_messageId` (см. 9.3.1); CRIT-8 inline rollback `cleanup_inline_files` (см. 9.3.2) | [x] |
| 9.13.4 | Сужение `<all_urls>` → http/https/file в manifest content_scripts; http/https в web_accessible_resources | [x] |
| 9.13.5 | `safeMarkdownUrl` `urlTransform` в Detail + popup ReactMarkdown; `isSafeUrl` на card-меню | [x] |
| 9.13.6 | Транзакционный откат bulk-tag (`rewrite_collection_membership`) и rename_channel block-file rollback | [x] |
| 9.13.7 | Cancellation-guard + `.catch` на всех 6 `getBlock().then()` | [x] |
| 9.13.8 | Атомарная запись `.md` (`files::write_atomically`) для write_block_file + всех прямых `fs::write` в командах | [x] |
| 9.13.9 | Импорт Are.na off-thread (release `vault_state` mutex, отдельное соединение) | [x] |
| 9.13.10 | FTS-триггер `blocks_au` с `UPDATE OF`-гардом (нет лишнего FTS-rebuild при sync thumb-метаданных) | [x] |
| 9.13.11 | Гигиена: удалены debug-логи, мёртвый код (`transliterate`/`normalize_slug`), обоснованы prod `unwrap`, закрыты пустые `catch`, удалены мёртвые npm-deps | [x] |
| 9.13.12 | Grid per-frame re-render и `GRID_TOP_INSET_PX` coord — задокументированы как осознанные residuals в SPEC_FEED_SCROLL_PERFORMANCE | [x] |
| 9.13.13 | Тесты: preview_plan.rs (6 unit), `serialize_response` echo `_messageId` (CRIT-7 proof) — сделано. Остаются: channels.rs commands (нужен extract-internal рефактор под State), bulk-tag rollback, SSRF redirect integration (нужен mock HTTP-сервер) | ACTIVE test gaps |

### Phase 10 — UX: навигация, сайдбар, устойчивость [COMPLETED]

Goal: полноценная клавиатурная навигация, ресайз сайдбара, исправление взаимодействия Detail с Tauri drag region, устойчивость к iCloud-оптимизации.

| # | Task | Status |
|---|------|--------|
| 10.1 | Ресайз сайдбара: pill-хэндл (Things-стиль), `useSidebarResize` хук, двойной клик для сворачивания/разворачивания | [x] |
| 10.2 | Detail: рефакторинг с Radix Dialog на plain div (`absolute inset-0 z-10` внутри `<main isolation: isolate>`) | [x] |
| 10.3 | Исправление кнопки X в Detail: перенос ниже 32px Tauri drag region (`top-10 right-4`) | [x] |
| 10.4 | Исправление навигации сайдбара при открытом Detail: `useEffect` на `location.pathname` сбрасывает `selectedBlock` | [x] |
| 10.5 | Клавиатурная навигация в Grid: Grid-owned `focusedSlug`, визуальная навигация по `layout.positions` (4 стрелки + Enter + Esc), viewport resync после ручного scroll, автоподскрол по layout position, restore по slug после закрытия Detail | [x] |
| 10.6 | Клавиатурная навигация в Detail: влево/вправо (линейная), capture phase + stopPropagation, пропуск модификаторов | [x] |
| 10.7 | Переключение каналов Opt+Cmd+Up/Down: навигация по `orderedTags`, автоподскрол сайдбара к `[aria-current="page"]` | [x] |
| 10.8 | Устойчивость к iCloud: сброс ошибки загрузки карточек через событие `vault-refreshed` при `loadData` | [x] |
| 10.9 | `activeBlocks` memo: фильтрация по текущему каналу на уровне App, исправление бага навигации Detail за пределы канала | [x] |

### Phase 11 — Редизайн сайдбара и тулбара [IN PROGRESS]

Goal: табличный вид сайдбара (название + превью + счётчик), кастомный тулбар, Rust-команда для проверенных превью.

| # | Task | Status |
|---|------|--------|
| 11.1 | Табличный вид сайдбара: строка = название (flex-1) + карточки в ряд (flex-1) + счётчик (w-8) | [x] |
| 11.2 | Rust-команда `list_channel_previews`: `thumb_path.exists()`, возврат только реальных slug'ов | [x] |
| 11.3 | Кастомный `<header>` тулбар (h-8, 32px) вместо overlay drag region | [x] |
| 11.4 | Направляющие между строками (`border-b`) | [x] |
| 11.5 | Сохранение классического вида Sidebar/ChannelIcon как `.classic.tsx` | [x] |
| 11.6 | Убрана нижняя панель сайдбара (Import, Search) | [x] |
| 11.7 | Наполнение тулбара (действия без глобального Search) | SUPERSEDED — current top-chrome contract |
| 11.8 | Финальная калибровка отступов и типографики | MANUAL QA |
| 11.9 | Текстовые миниатюры статей: `generate_text_thumbnail()` (ab_glyph + imageproc, Noto Sans 28KB embedded) | [x] |
| 11.10 | Оптимизация миниатюр: O1 — пропуск свежих (mtime), O2 — LazyLock для шрифта, O3 — фоновая генерация в full_scan | [x] |
| 11.11 | Снятие фильтра BlockType в `list_channel_previews` — статьи появляются в сайдбаре | [x] |

### Phase 12 — Редизайн расширения: Vite-сборка + единая дизайн-система [COMPLETED]

Goal: расширение собирается через Vite, использует те же React-компоненты и CSS-токены, что и основное приложение. Один источник правды — дрейф дизайна невозможен.

**Принцип:** расширение — проекция основного приложения в браузер. Те же шрифты (Geist, Geist Mono), те же токены (`global.css`), те же компоненты (`@/components/ui/*`). Различия только в адаптере (native messaging vs Tauri IPC) и в layout (popup vs fullscreen).

#### 12.1 — Инфраструктура сборки

| # | Task | Status |
|---|------|--------|
| 12.1.1 | `vite.extension.config.ts`: отдельная Vite-конфигурация, entry point `extension/popup/main.tsx`, output в `extension/dist/` | [x] |
| 12.1.2 | Скрипт `bun run build:extension` в `package.json` | [x] |
| 12.1.3 | Алиас `@/` → `src/` в конфигурации расширения (общие компоненты) | [x] |
| 12.1.4 | Исключить Tauri-специфичный код из сборки расширения (tree-shaking или условный импорт) | [x] |
| 12.1.5 | Шрифты: копировать `public/fonts/*.woff2` в `extension/dist/fonts/`, обновить `@font-face` пути | [x] |
| 12.1.6 | `manifest.json`: указать `popup: "dist/popup.html"` | [x] |

#### 12.2 — React-попап

| # | Task | Status |
|---|------|--------|
| 12.2.1 | `extension/popup/main.tsx`: React entry point, рендер `<PopupApp />` | [x] |
| 12.2.2 | `extension/popup/PopupApp.tsx`: корневой компонент, состояния (loading → error → main) | [x] |
| 12.2.3 | Адаптер `extension/popup/lib/messaging.ts`: типизированный native messaging с таймаутами (исправление CRIT-7 из аудита) | [x] |
| 12.2.4 | Хук `useClipperState()`: вся бизнес-логика попапа (init, каналы, save, недавние) | [x] |
| 12.2.5 | — (объединено с 12.2.4) | [x] |

#### 12.3 — Компоненты попапа (на базе shadcn/ui)

| # | Task | Status |
|---|------|--------|
| 12.3.1 | `PreviewCard`: thumbnail + display heading/body H1 input where applicable + domain. Использует `<Input>` из shadcn | [x] |
| 12.3.2 | `TypeSwitcher`: Content / Screenshot / Link. Использует shared `<SegmentedControl size="clipper">` в отдельной 40px Type row, без локального дублирования visual state | [x] |
| 12.3.3 | `ChannelList`: thin adapter over shared desktop `CollectionPicker` default menu layout; checkbox UI удалён, surface geometry берётся из exported picker constants | [x] |
| 12.3.4 | `SaveButton`: кнопка сохранения. `<Button variant="default">` полной ширины, без видимого `<kbd>` | [x] |
| 12.3.5 | `StatusBar`: legacy visible status component в нижнем `space-y-2` stack | [x] |
| 12.3.6 | Состояние загрузки: спиннер (существующий CSS-паттерн) | [x] |
| 12.3.7 | Состояние ошибки: иконка + сообщение | [x] |

#### 12.4 — Стилизация

| # | Task | Status |
|---|------|--------|
| 12.4.1 | Импорт `src/styles/global.css` — все токены, шрифты, base-стили наследуются автоматически | [x] |
| 12.4.2 | `extension/popup/popup-layout.css`: только popup-размеры (360x600), импортирует global.css | [x] |
| 12.4.3 | Старый `popup.css` перемещён в `_legacy/` | [x] |
| 12.4.4 | Проверка: все размеры текста строго 12/14/18px, веса 400/600, отступы из шкалы | [x] |
| 12.4.5 | Clipper design-system parity: space selector через shared `MenuTextTrigger`, shadow-local DropdownMenu portal, Type row через shared `SegmentedControl`, channel picker через shared `CollectionPicker`; нижний body остаётся legacy stack | [x] |

#### 12.5 — Safari extension

| # | Task | Status |
|---|------|--------|
| 12.5.1 | Safari manifest обновлён: `dist/index.html` | [x] |
| 12.5.2 | Собранный dist копируется в Safari Resources через `build:extension` скрипт | [x] |
| 12.5.3 | Старый popup Safari перемещён в `_legacy/` | [x] |
| 12.5.4 | Пересборка Xcode-проекта с новым попапом | DEFERRED — iOS/Safari outside active scope |

#### 12.6 — Миграция логики

| # | Task | Status |
|---|------|--------|
| 12.6.1 | Перенести логику из `popup.js` в React-хуки и компоненты | [x] |
| 12.6.2 | Типизировать native messaging протокол (TypeScript интерфейсы запросов/ответов) | [x] |
| 12.6.3 | Старый `popup.js` перемещён в `_legacy/` — вся логика в React | [x] |
| 12.6.4 | `background.js` и `content.js` — оставлены как есть (не зависят от UI) | [x] |

#### 12.7 — Проверка и очистка

| # | Task | Status |
|---|------|--------|
| 12.7.1 | Визуальное сравнение: попап расширения vs основное приложение (шрифты, цвета, отступы) | MANUAL QA |
| 12.7.2 | Проверка на `about:blank`, PDF, `chrome://` — popup должен работать | MANUAL QA |
| 12.7.3 | Проверка размера расширения: ~270 КБ gzip (React + шрифты + Tailwind) | [x] |
| 12.7.4 | `bun run lint` — расширение проходит те же правила ESLint | [x] |
| 12.7.5 | Обновить SPEC_CLIPPER.md: новая архитектура сборки | [x] |
| 12.7.6 | Обновить DESIGN_SYSTEM.md: раздел «Расширение» | [x] |

#### Порядок выполнения

```
12.1 (инфраструктура сборки)
  ↓
12.2 (React entry + хуки)  →  12.3 (компоненты)
  ↓
12.4 (стилизация)
  ↓
12.6 (миграция логики из popup.js)
  ↓
12.5 (Safari)  ←→  12.7 (проверка)  — параллельно
```

### Phase 13 — Видео-блоки: YouTube embed + транскрипт [IN PROGRESS]

Goal: полноценная поддержка видео-страниц в клиппере и основном приложении. YouTube iframe в Detail, транскрипт через Defuddle.

| # | Task | Status |
|---|------|--------|
| 13.1 | Клиппер: TypeSwitcher на видео-страницах, play-кнопка в превью | [x] |
| 13.2 | Клиппер: видео-Content сохраняется как block_type=video с URL | [x] |
| 13.3 | Detail.tsx: YouTube iframe embed для видео-блоков с URL | [x] |
| 13.4 | Detail.tsx: body ниже видео (подготовка к транскрипту) | [x] |
| 13.5 | Замена Readability+Turndown на Defuddle в content.js | [x] |
| 13.6 | Извлечение транскрипта YouTube через Defuddle или API | [x] |

### Phase M1 — Rust core UniFFI bindings [COMPLETED]

| # | Task | Status |
|---|------|--------|
| M1.1 | Cargo workspace (root + core-ffi) | [x] |
| M1.2 | Feature gate `desktop` для Tauri-зависимостей | [x] |
| M1.3 | core-ffi crate: ArenaVault, FfiLightBlock, ArenaError | [x] |
| M1.4 | iOS targets (aarch64-apple-ios, aarch64-apple-ios-sim) | [x] |
| M1.5 | Swift bindings (uniffi-bindgen) | [x] |
| M1.6 | xcframework для device + simulator | [x] |

### Phase M2 — iOS приложение [IN PROGRESS]

| # | Task | Status |
|---|------|--------|
| M2.1 | Xcode project (xcodegen), SwiftUI scaffold | [x] |
| M2.2 | scanVault() — индексация .md файлов | [x] |
| M2.3 | GridView с карточками (smoke test) | [x] |
| M2.4 | Дизайн-система: тёмная тема, цвета, типографика | [x] |
| M2.5 | Thumbnails и медиа в карточках | [x] |
| M2.5a | Полноэкранный режим (UILaunchScreen) | [x] |
| M2.5b | Видео-автоплей в ленте и Detail (AVPlayerLooper) | [x] |
| M2.6 | Channel list / навигация | [x] |
| M2.7 | Detail view (просмотр блока) | [x] |

### Phase 14 — Article Audio Renditions v1 [COMPLETED]

Goal: manual local audio renditions для `article` blocks на desktop и iOS с общим Rust speech-prep contract, compact controls и local playback persistence.

SPEC: [SPEC_ARTICLE_AUDIO.md](SPEC_ARTICLE_AUDIO.md)

| # | Task | Status |
|---|------|--------|
| 14.1 | Shared Rust speech-prep: `PreparedArticleSpeech`, `text_hash`, language detection, prose-only cleanup | [x] |
| 14.2 | Desktop derived audio store + Tauri commands (`get/generate/delete/set_position`) | [x] |
| 14.3 | Desktop Detail audio rail: `Create Audio`, `Remove Audio`, `Play/Pause`, compact progress | [x] |
| 14.4 | Watcher / block deletion invalidation of stale audio artifacts | [x] |
| 14.5 | `core-ffi` export `prepare_article_speech(slug)` for iOS | [x] |
| 14.6 | iOS `AudioSection`, `ArticleAudioService`, `ArticleAudioController`, local CAF cache | [x] |
| 14.7 | Verification: Rust tests, frontend tests, `cargo check -p mine-ffi`, arm64 iOS simulator build | [x] |

### Phase 15 — Apple TTS Stabilization v2 [COMPLETED]

Goal: стабилизировать desktop article-audio backend без UI-изменений: убрать нестабильный `/usr/bin/say -o`, перевести desktop generation на native macOS helper, ввести persisted Apple voice defaults и перестать переиспользовать legacy audio artifacts.

SPEC: [SPEC_ARTICLE_AUDIO.md](SPEC_ARTICLE_AUDIO.md)

| # | Task | Status |
|---|------|--------|
| 15.1 | Native desktop helper on `AVSpeechSynthesizer.write` + `.wav` output (`44.1 kHz`, mono PCM) | [x] |
| 15.2 | Persisted desktop `article_audio.apple_voice_overrides` contract in app config | [x] |
| 15.3 | Voice resolution order: override → curated default → exact language → prefix → system default | [x] |
| 15.4 | Desktop sidecar v2 metadata: `format_version`, `generation_backend`, `voice_id`, `voice_name` | [x] |
| 15.5 | Legacy desktop artifact invalidation (`format_version < 2`, `.m4a/.aiff/.caf`) | [x] |
| 15.6 | Helper timeout/kill path so generation cannot hang indefinitely | [x] |
| 15.7 | Verification: native helper tests, full Rust lib tests, frontend controls tests, production build | [x] |
| 15.8 | Frontend `ArticleAudioGateway`: desktop adapter + provider injection, без прямых Tauri imports в `ArticleAudioControls` | [x] |

### Phase 10 — Виртуализированная masonry-сетка [IN PROGRESS]

Goal: настоящая виртуализация для 10000+ блоков. Два пути через feature detection.

| # | Task | Status |
|---|------|--------|
| 10.1 | CSS Grid Lanes + content-visibility: auto (WebKit path) | [x] |
| 10.2 | `@virtuoso.dev/masonry` fallback (Chrome/Firefox) | [x] |
| 10.3 | Feature detection `CSS.supports("display", "grid-lanes")` | [x] |
| 10.4 | Собственный `VirtualMasonryGrid`: absolute positioning + visible window + overscan | [x] |
| 10.5 | Layout engine + cache высот карточек для быстрого resize и больших разделов | [x] |
| 10.6 | Scroll anchoring при ресайзе окна и сайдбара | [REVERTED] См. DEVLOG 11.04.2026 (late+3): anchoring не работает в masonry с non-uniform shifts, feedback loop через программный scrollTop |

### Phase 11 — Zero-Jank Masonry [DONE]

Goal: доказуемая переработка grid-архитектуры под четыре продуктовых требования (120fps scroll без прыжков, мгновенный resize, 1000 ≈ 10000, мгновенный channel switch) без компромиссов. Работает одинаково на desktop Tauri и на будущем web-деплое.

SPEC: [SPEC_GRID.md](SPEC_GRID.md) — детальное описание архитектуры, модулей, API контрактов, performance targets, migration plan.

Корневой принцип: **все высоты карточек известны до вставки в layout через Canvas `measureText` в Web Worker'е**. Production Grid больше не строит layout из DOM-measured height cache: masonry geometry считается детерминистически из `computeCardHeight()`, media dimensions и word metrics. DOM measurement сохранён только как explicit dev-аудит height drift.

| # | Task | Status |
|---|------|--------|
| 11.1 | SPEC_GRID.md — полная спецификация архитектуры | [x] |
| 11.2 | `src/workers/fontMetrics.worker.ts` + `src/lib/fontMetrics.ts` — OffscreenCanvas measureText в Worker, IndexedDB cache word_widths | [x] |
| 11.2a | Harden font metrics cache identity: `blockId + fontHash + measured textHash`, IndexedDB v2 `cacheKey`, tests | [x] |
| 11.3 | `src/lib/wordWrap.ts` + `src/lib/cardHeight.ts` — pure функции для детерминистической высоты | [x] |
| 11.3a | Shadow-validation: compare `computeCardHeight()` against measured `MeasureCard` heights and publish drift budget before production switch | [x] |
| 11.3b | Deterministic-ready live render: render `media` cards and text cards with ready word metrics without waiting for hidden DOM measurement | [x] |
| 11.4 | `src/lib/masonryLayout.ts` — bucket-based visibility index (расширение существующего модуля) | [x] |
| 11.5 | `src/lib/layoutCache.ts` — LRU cache для layouts каналов | [x] |
| 11.6 | `src/hooks/useGridScroll.ts` — RAF-coalesced scroll state + bounded anti-blank sync commit | [x] |
| 11.7 | `src/components/Grid.tsx` — production switch to deterministic dual-path after proof gate; удаление measurement infrastructure | [x] |
| 11.8 | `src/components/Card.tsx` — paint containment, `translateZ(0)`, async image decode, фиксация line-height | [x] |
| 11.9 | Визуальная проверка на реальном vault'е + browser acceptance (`bun run test:feed-scroll`) и замеры FPS | [x] |

### Phase 12 — Thumbnail pipeline: two-phase through WebView decoder [IN PROGRESS]

Goal: удовлетворить четыре продуктовых инварианта для sidebar thumbs (мгновенное появление, корректность для всех форматов клиппера, baked text для pure-text / real image для articles с media, плавный скролл 100+ каналов × 10 thumbs) без компромиссов. Устранить зависимость от Rust crate stack для decode экзотических форматов (VP8X WebP, HEIC, AVIF, HEVC, fragmented MP4).

SPEC: [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md) — полная архитектура, протоколы событий, worker contract, failure modes, testing plan.

Корневое решение: two-phase pipeline. **Phase 1** — Rust синхронно пишет thumb при save (JPEG/PNG через content sniff → real thumb; всё остальное → text placeholder, всегда успешно, <150ms latency). **Phase 2** — main app в фоне upgradeит placeholders через Web Worker (`createImageBitmap` + `OffscreenCanvas.convertToBlob`), WebView native decoder покрывает весь набор форматов которые клиппер может сохранить. Sidebar обновляется через Tauri events (block:added, thumb:updated) вместо polling.

| # | Task | Status |
|---|------|--------|
| 12.1 | SPEC_THUMBNAILS.md — полная спецификация архитектуры | [x] |
| 12.2 | Phase A: content sniff в `generate_for_block` (`is_rust_decodable` — first 6 bytes → JPEG/PNG/GIF direct, else text placeholder). Rebuild + install native host | [x] |
| 12.3 | Phase B.1: `src-tauri/src/commands/thumbnails.rs` — `save_thumb`, `list_pending_thumb_upgrades` | [x] |
| 12.4 | Phase B.2: Tauri events в `watcher::handler::index_md_file` — `block:added`, `block:removed`, `thumb:updated`, `thumb:upgrade-requested` | [x] |
| 12.5 | Phase B.3: `src/workers/thumbWorker.ts` — image через `createImageBitmap` + `OffscreenCanvas.convertToBlob`, video stub (VideoDecoder API не реализован) | [x] |
| 12.6 | Phase B.4: `src/hooks/useThumbnailUpgrade.ts` + `src/hooks/useChannelPreviewsEvents.ts` — event subscribers, worker queue coordination | [x] |
| 12.7 | Phase B.5: wire up в `App.tsx`, startup call `list_pending_thumb_upgrades` | [x] |
| 12.8 | Phase C: виртуализация Sidebar — CSS `content-visibility: auto` + `contain-intrinsic-size` на TagNavItem, отключение при drag | [x] |
| 12.9 | Phase D (deferred): удаление `openh264`, `mp4` crates — заблокировано, worker video decode stub'нут | [-] |
| 12.10 | Cache-bust fix: `list_channel_previews` возвращает `mtime` per thumb, frontend использует `?m=<mtime>` вместо raw URL | [x] |
| 12.11 | Manual QA: visual regression на representative vault | MANUAL QA |
| 12.12 | Startup safety: `list_pending_thumb_upgrades` через SQLite + `spawn_blocking`, без file peek'ов на UI thread | [x] |
| 12.13 | Legacy vault compatibility: backfill `thumb_format/thumb_mtime` из существующих `.jpg` при `open_vault()` | [x] |

### Phase 18 — Filename Identity Refactor [COMPLETE]

Goal: перейти на human-readable filenames без повторения регрессии монолитного Phase 16 + 17. Каждая sub-phase — изолированный коммит с обязательным end-to-end Chrome clipper test перед следующей. Existing vault файлы продолжают читаться в любом из стилей (kebab legacy + Unicode new).

Корневая архитектурная установка: identity блока остаётся filename-derived (`.md` stem). Никаких служебных `id` / `uuid` во frontmatter — это нарушение Markdown First. Стабильность identity против rename/conflict обеспечивается через runtime mitigations (content hash rename detection, iCloud conflict UX), не через добавление мусора в source of truth.

Контекст: предыдущая попытка (`stash@{0}: WIP 21-22.04 Phase 16+17 clipper work`) объединила 7 разных slice'ов в один refactor без промежуточных коммитов, что привело к полной неработоспособности клиппера и невозможности локализовать регрессию. Эта Phase разбивает ту же работу на изолированные шаги.

| # | Sub-phase | Status | Scope |
|---|-----------|--------|-------|
| 18.A | NFC normalization infrastructure | [x] | `unicode-normalization` crate, helper `normalize_filename_stem`, применение на boundary (`read_block_file`, watcher, `live_slugs`). ASCII pass-through. — `ac103c61` |
| 18.B | DB uniqueness safe для non-ASCII | [x] | Escape-aware `LIKE` с `%`, `_`, `\` экранированием в `resolve_unique_slug` + `ESCAPE '\\'`. — `fa462729` |
| 18.C | `suggest_slug` human-readable | [x] | Unicode, пробелы, NFC, фильтр filesystem-unsafe чаров, 100-char truncation, fallback `Untitled`. Existing kebab files читаются без migration. — `7c48d33a` |
| 18.D | Collision resolution UX | [x] | `resolve_slug_conflict` и `resolve_unique_slug` перешли на суффикс ` (N)` (совпадает с Obsidian). Legacy `-N` files не интерферируют. — `e136c69c` |
| 18.E | Backend finalizes uploaded media filename | [x] | `handle_save_block` переименовывает staged file в `<slug>.<ext>`. IPC contract не меняется — минимальный scope. `finalize_uploaded_filename` с guard'ом против overwrite. — `c40b858b` |
| 18.F | Inline article media naming | [x] | Embedded images/videos в article body → `Название (image N).ext` / `Название (video N).mp4`. Per-kind 1-based counters, rollback at failure/dedup. — `26a19d00` |
| 18.G.1 | Identity robustness infrastructure | [x] | DB migration: `body_hash` column, `vault_conflicts` table. `compute_body_hash`, `detect_icloud_conflict`, `lookup_body_hash`, `rename_slug`, `record/list/clear_vault_conflict`. — `3ea8c8fd` |
| 18.G.2 | Watcher rename detection | [x] | Pending-remove queue с 500ms deadline. BlockDeleted → defer. BlockChanged → body-hash match → `rename_slug` + derived-store migration. `block:renamed` event. — `a957e338` |
| 18.G.3 | iCloud conflict runtime | [x] | `index_md_file` и `full_scan` диверсифицируют conflict файлы в `vault_conflicts`. `vault-conflict-detected` event. Orphan cleanup не считает conflict stems. — `489e9e4a` |
| 18.G.4 | Frontend conflict UI | [x] | IPC commands `list_vault_conflicts` / `resolve_vault_conflict` (keep_original / keep_conflict / dismiss_for_manual_merge), `VaultConflictsBanner` в Sidebar header slot, resolution dialog. — `09d8eb63` |
| 18.F.1 | Hotfix: URL-encode parens in body markdown | [x] | Внутренние parens в inline media name ломали markdown parser. Percent-encoding `space`/`(`/`)`/`%` в body URL. — `38901e75` |
| 18.F.2 | Decode local URLs in extract functions | [x] | `extract_first_image`, `extract_media_urls` теперь decode URLs перед сохранением в DB. Remote URLs не трогаются. — `03f63deb` |
| 18.F.3 | Decode in social tiles + media_dimensions | [x] | `extract_social_preview_tiles` (ломало видео в Twitter) + `collect_body_media`. Каскадная коррекция той же проблемы. — `42a7eeec` |

### Phase 18.H — Inline media via Obsidian wikilinks [COMPLETE]

Goal: устранить **class of bugs** `URL-in-body ≠ filename-on-disk`, который возник в Phase 18.F после перехода на `{slug} (image N).ext` naming. Вместо percent-encoding cascade (F.1 → F.2 → F.3 → ...), перейти на Obsidian-native wikilink syntax `![[name]]` для inline media, где delimiter `]]` не конфликтует с filename characters.

SPEC: [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md).

### Architectural rationale

**Root cause F-series каскада:** markdown `![alt](url)` использует `(` и `)` как URL boundary, что несовместимо с именами файлов содержащими parens. Percent-encoding в body решает parsing, но создаёт системный разрыв: `URL_in_body != filename_on_disk`. Каждый consumer body markdown, использующий URL как path, должен декодировать. Это неформализованный invariant, легко упустить при следующем изменении.

**Wikilink `![[name]]` делает delimiter `]]`, который практически не встречается в именах файлов.** Внутри `[[...]]` разрешены пробелы, parens, unicode, almost everything. Parser находит закрывающий `]]` однозначно, URL извлекается как есть, совпадает с filename.

### Scope

**Backend:**
- `localize_body_images` пишет `![[name]]` для inline media (вместо `![](encoded_url)`)
- `extract_first_image`, `extract_media_urls`, `extract_social_preview_tiles`, `collect_body_media` расширены на оба syntax (`![alt](url)` + `![[name]]`)
- Alt-text supported через Obsidian pipe: `![[name|alt text]]`
- Backward compat: existing блоки с `![](...)` продолжают работать

**Frontend:**
- `remark-wiki-link` plugin или custom remark transformer
- Detail renderer handle wikilink embed
- Card preview pipeline уже использует `preview_manifest`, который backend generates из both syntaxes — изменений там минимум

**Migration:**
- One-time script проходит по всем `.md` файлам vault, преобразует `![](percent-encoded)` → `![[decoded-name]]`
- Opt-in (команда `migrate_to_wikilinks`), не автомат
- Documented как recovery для блоков, склипанных между 18.F и 18.H

### Sub-phases

| # | Slice | Status | Scope |
|---|-------|--------|-------|
| 18.H.1 | Backend writer on wikilinks | [x] | `localize_body_images` → `![[name\|alt]]`, extract functions parse оба syntax. — `d0f6aaca` |
| 18.H.2 | Frontend wikilink rendering | [x] | `preprocessWikilinks` helper + integration в `Detail.tsx`, updates для `stripMarkdown` в card preview. — `ba02e09c` |
| 18.H.3 | Migration CLI | [x] | `migrate-body-to-wikilinks` binary с `--dry-run`/`--apply`, `domain::markdown::convert_markdown_images_to_wikilinks` pure function. — `baf438e8` |
| 18.H.4 | SPEC document | [x] | [SPEC_OBSIDIAN_WIKILINKS.md](SPEC_OBSIDIAN_WIKILINKS.md) — canonical write syntax, dual-syntax read, migration contract. — `baf438e8` |

Status: Phase 18 complete. Human-readable filenames, rename/conflict runtime robustness, iCloud conflict UI, and inline media wikilinks are all shipped. Existing vault files continue to read in both legacy and new styles.

#### Discipline requirements

Каждая sub-phase обязана пройти **все** шаги до перехода к следующей:

1. **Один коммит на sub-phase** с clear scope statement в message (что меняется, что НЕ меняется)
2. **Rust unit tests** для изменённой логики
3. **`cargo test -p mine --lib --quiet`** зелёный
4. **`bun run build:extension`** проходит без warnings
5. **Manual Chrome smoke test**: reload extension → clip reaal tweet или article → проверить что `.md` появился в vault и открывается в Obsidian
6. **Revertable независимо**: каждый коммит имеет чистый `git revert` path без cascading failures

#### Post-Phase 18 residuals

- `-2`, `-3`, `-7.md` существующие файлы остаются как есть. Migration tool опциональна, в scope `pathological_filename_repair`
- external rename сохраняет identity и derived state, но не переписывает другие `.md` файлы
- in-app rename нужен как отдельный smart path поверх уже завершённой filename-first модели

#### Stash usage

`stash@{0}` содержит реализации:
- `suggest_slug` Unicode + NFC (применимо к 18.C)
- `resolve_slug_conflict` с ` (n)` (применимо к 18.D)
- DB escaping в `resolve_unique_slug` (применимо к 18.B)
- Clipper staged upload pipeline (применимо к 18.E)
- Inline article media naming (применимо к 18.F)
- `SPEC_IDENTITY_ROBUSTNESS.md` (применимо к 18.G)
- `pathological_filename_repair` CLI tool (follow-up utility)

Рекомендация: не делать `git stash pop` целиком. Извлекать по одному файлу через `git checkout stash@{0} -- <path>` или `git show stash@{0}:<path>` для reference реализации в каждой sub-phase. После успешного Phase G можно `git stash drop stash@{0}`.

### Phase 19 — Rename Functionality Completion [COMPLETE]

Goal: довести filename-first rename до законченного продуктового состояния без hidden IDs. In-app rename становится каноническим smart path, external rename через Finder / Obsidian сохраняет identity и derived state, но не делает скрытых rewrite'ов по vault.

| # | Slice | Status | Scope |
|---|-------|--------|-------|
| 19.1 | Backend rename command | [x] | `rename_block_file(old_slug, new_stem)` с NFC normalization, safe filename validation и typed errors (`NameTaken`, `InvalidFilename`, ...). |
| 19.2 | Source-vault rewrite policy | [x] | In-app rename переименовывает `.md`, Mine-owned rename-family (`old_slug.ext`, `old_slug (image N).*`, `old_slug (video N).*`) и переписывает wikilinks / file references по parseable `.md` в vault. Legacy behavior синхронизировал `title`; Phase 22 заменяет это на filename-only rename без title/H1 rewrite. |
| 19.3 | Derived artifacts + watcher suppression | [x] | `rename_derived_artifacts` + `article_audio::rename_all_artifacts`, `AppState.suppressed_paths`, watcher filter против re-entry во время command-driven rename. |
| 19.4 | Frontend rename UX | [x] | `Rename…` в overflow `…` menu и `Detail`, единый `RenameBlockDialog`, typed error rendering, `block:renamed` retargeting для open detail/grid state. |
| 19.5 | Specs + tests | [x] | Rust tests на rewrite/media/audio/name collisions, frontend tests на dialog и `block:renamed` state sync, обновление SPEC/PLAN/DEVLOG. |

### Phase 20 — Clipper inline-media parallelization [COMPLETE]

Goal: убрать `Native host timeout` на статьях с многими inline-картинками (apple.com/ipad-mini etc.). Сохранить инвариант синхронного клиппера — `.md` записывается одним атомарным write с уже локализованной body, Obsidian видит готовое состояние, Mine-приложение не требуется.

| # | Slice | Status | Scope |
|---|-------|--------|-------|
| 20.1 | Three-phase localize_body_images | [x] | `scan_inline_tasks` (Phase A) → `run_parallel_downloads` (Phase B, pool из 3 thread'ов + `DomainLimiter` 2/host) → `apply_rewrites` (Phase C, dedup + reverse-offset). Cap `MAX_INLINE_IMAGES = 30` сохранён. |
| 20.2 | Per-request ureq timeout | [x] | `INLINE_REQUEST_TIMEOUT = 15s` на каждый `ureq.call()` в `download_file` — один зависший CDN не монополизирует worker slot. |
| 20.3 | Action-aware native-messaging timeout | [x] | `timeoutForAction(action)` в [extension/background.js](file:///Users/i_iii/Проекты/local-arena/extension/background.js) и [popup/lib/messaging.ts](file:///Users/i_iii/Проекты/local-arena/extension/popup/lib/messaging.ts): `save_block` → 180s, остальное как было. |
| 20.4 | Unit tests | [x] | 9 новых тестов: `host_from_url_*`, `scan_*` (skip data/relative, indices, cap, malformed), `apply_rewrites_*` (success/failed/dedup/zero/reverse), `domain_limiter_*` (cap/release/per-host). 42/42 зелёных. |
| 20.5 | Docs | [x] | [SPEC_CLIPPER.md](file:///Users/i_iii/Проекты/local-arena/SPEC_CLIPPER.md) § Article inline-media pipeline, [DEVLOG.md](file:///Users/i_iii/Проекты/local-arena/DEVLOG.md) entry с rejected alternatives (heartbeat / daemon / Tauri-worker). |

### Phase 21 — Inline Media Extraction

Цель: позволить пользователю вытащить конкретное inline-изображение из открытой статьи в отдельный image-блок через перетаскивание на коллекцию в sidebar. Новый блок копирует ссылку на тот же media-файл, содержит URL источника и одностороннюю связь на исходную заметку. Исходная статья не переписывается.

Спецификация: [SPEC_INLINE_MEDIA_EXTRACTION.md](SPEC_INLINE_MEDIA_EXTRACTION.md).

| # | Slice | Status | Scope |
|---|-------|--------|-------|
| 21.1 | Related-note frontmatter | [x] | `Mine Related Notes`, `Mine Source Media`, parse/serialize, rename rewrite |
| 21.2 | Storage/index support | [x] | `related_notes` column, wikilinks insertion, `IndexedBlock.related_notes` |
| 21.3 | Backend extract command | [x] | `extract_inline_media`, local media validation, shared-media-reference semantics, thumbnail generation |
| 21.4 | Detail drag payload | [x] | `type: "inline_media"`, local image-only activation, media drag overlay |
| 21.5 | Sidebar drop routing | [x] | Drop `inline_media` on collection target calls extraction command, not the card connect path |
| 21.6 | Metadata UI | [x] | `RELATED NOTES` in Detail metadata with links to source notes |
| 21.7 | Manual QA | MANUAL QA | Real vault extraction, Obsidian source check, source article unchanged, rename source note updates relation |

### Phase 22 — Display Title / Body H1 Contract

Goal: remove synthetic `frontmatter.title` from new Mine-authored data and make
visible titles fully Obsidian-compatible. A real heading lives in Markdown body
as first H1. Existing `frontmatter.title` remains a legacy read fallback.
Filename stem remains identity/fallback label, not visible content title.

Specification: [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 22.1 | Domain parser + derived fields | [x] | `content_heading`, `display_title`, `fallback_label` derived from body H1 → legacy title → filename |
| 22.2 | Backend read-model | [x] | `IndexedBlock` / `LightBlock` expose derived title fields while physical `blocks.title` stays legacy metadata |
| 22.3 | Frontend title rendering | [x] | Card/Detail consume `display_title`; Detail renders body H1 as normal Markdown content without duplicate metadata heading |
| 22.4 | Write-path switch | [x] | New link/article/video page clips write real page heading as body H1; tweet/selection/media/file paths do not synthesize `title:` or H1 |
| 22.5 | Rename and derived artifacts | [x] | Filename rename no longer rewrites `frontmatter.title` or body H1; text thumbnails and article-audio use derived display-title/speakable content |
| 22.6 | Compatibility and migration boundary | [x] | Existing `frontmatter.title` remains read fallback; no automatic vault-wide rewrite |
| 22.7 | Manual QA | MANUAL QA | Fresh clipper save paths + old vault fallback behavior on a real Obsidian vault |

### Phase 23 — Media Contract / Derived Card Kind [COMPLETE]

Goal: demote non-channel `type` to compatibility metadata and make feed/detail consume a derived runtime card kind. Preserve Markdown-first source files by writing primary media as Obsidian wikilinks in `file`, while keeping legacy raw `file` values readable.

| # | Slice | Status | Scope |
|---|---|---|---|
| 23.1 | Type demotion | [x] | `type` remains in Markdown as source/compat metadata; only `type: channel` is a runtime marker |
| 23.2 | Derived runtime kind | [x] | `channel` for collection docs, `article` for non-empty body, `media` for empty body; feed/detail use the derived kind |
| 23.3 | Canonical file wikilinks | [x] | New writes serialize `file: "[[name.ext]]"`; parser remains compatible with `file: name.ext` |
| 23.4 | Existing content migration boundary | [x] | Migration rewrites frontmatter `file` only; body bytes are unchanged, so singleton embed bodies become article |
| 23.5 | Inline-media extraction output | [x] | New extraction creates empty-body media-card with canonical `file` wikilink instead of singleton embed body |
| 23.6 | Clipper/native-host contract | [x] | Popup creation modes mostly unchanged; native-host writer is authoritative for canonical `file` wikilinks |
| 23.7 | Manual QA | MANUAL QA | Real-vault migration + fresh clipper media save + existing singleton embed body behavior |

### Phase 25 — Media Asset Actions

Goal: сделать все локальные media assets одинаковыми для взаимодействия,
независимо от того, пришли они из `frontmatter.file` или из body embed. Hover,
drag и меню должны target'ить конкретный media file, а не карточку.

Specification: [SPEC_MEDIA_ASSET_ACTIONS.md](SPEC_MEDIA_ASSET_ACTIONS.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 25.1 | MediaAssetRef resolver | [x] | Shared frontend/backend resolver for local vault media refs from frontmatter and body embeds; remote/derived assets excluded |
| 25.2 | Shared media action frame | [x] | One Detail/body wrapper with standard ellipsis Button, menu, focus/hover lifetime, video-safe overlay |
| 25.3 | Create Card/materialize command | [x] | `create_media_asset_card`: always create a new empty-body media card and optionally connect that card to a collection |
| 25.4 | Image drag routing | [x] | Replace inline-only payload with `media_asset`; sidebar drop calls media command, not card connect |
| 25.5 | Media rename command | [x] | Rename physical media file, rewrite media refs across parseable Markdown, keep card slugs/titles unchanged |
| 25.6 | Media delete command | [x] | Prepare referenced-card plan, show exact media preview in confirmation, delete media file, remove parseable refs, keep `.md` cards/notes |
| 25.7 | Reveal/Copy Path/Copy | [x] | Finder/path/native clipboard actions resolve the media file, not source card `.md` |
| 25.8 | Tests + manual QA | MANUAL QA | Automated Rust/frontend coverage is in place; real-vault manual QA for frontmatter media and inline media parity remains |

### Phase 26 — Grid Group Selection / Batch Card Actions

Goal: enable spatial multi-selection in the masonry feed and batch actions from
a bottom floating action island.

Specification: [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md). Batch merge
contract: [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 26.1 | Selection state | [x] | Grid-owned `selectedSlugs` + transient `marqueeSelection`, prune missing slugs, reset on route/channel changes, plain card open and empty-grid click |
| 26.2 | Modifier click handling | [x] | `Cmd+click` and `Shift+click` both toggle only clicked cards; plain click keeps Detail behavior |
| 26.2.1 | Marquee selection | [x] | Empty-area drag renders DS-token marquee rectangle and selects cards by `layout.positions` rectangle intersection |
| 26.3 | Selected visual | [x] | `data-feed-grid-item-selected`, external square-corner 2px monochrome frame with 1px outside gap, no layout shift, light/dark tokens |
| 26.4 | Bottom action island | [x] | Main-pane-centered `h-8` opaque island, `bottom-s3`, clear button, Detail-top-bar-style muted Russian selected-card count, direct Button actions `Connect`, text-only collection-scoped `Disconnect`, red text-only `Delete`, horizontal overflow |
| 26.5 | Batch Connect | [x] | `BatchCollectionPicker` reuses `CollectionPicker` row/input/action styling; binary all/not-all states, sidebar-order rows, optimistic state without row reordering or partial count labels |
| 26.6 | Batch Disconnect/Delete v1 | [x] | Disconnect selected cards from current collection; conservative batch destructive confirmation for Delete |
| 26.6.1 | Batch delete backend plan | FEATURE BACKLOG | Add `prepare_delete_blocks(slugs)` with aggregate `DeleteBlocksPlan`: selected `.md` files, deduped `unused_media` after deleting the whole selected set, and `shared_media` kept by non-selected refs |
| 26.6.2 | Batch delete backend commit | FEATURE BACKLOG | Add `delete_blocks(slugs, delete_unused_media)` as one command; validate/rebuild plan at commit, delete selected cards plus optional eligible unused media, never delete shared media |
| 26.6.3 | Batch delete dialog parity | FEATURE BACKLOG | Replace v1 copy with single-delete-equivalent dialog: card count, optional unused-media previews, `Keep media` and `Delete media` actions, shared media kept |
| 26.6.4 | Batch delete tests | FEATURE BACKLOG | Rust and frontend coverage for media shared only inside selection, media shared with unselected cards, stale plan validation, viewport preservation and selection clear |
| 26.7 | Group drag-to-channel | [x] | Dragging a selected card drags the selected slug set, renders a capped macOS-style flocking stack of real frozen card previews, and connects all dragged cards on channel/create-channel drop |
| 26.8 | Batch Merge SPEC | [x] | `SPEC_CARD_MERGE.md` defines the reorder dialog, shared card-reference rows, one backend `merge_blocks` command, Markdown section composition, media reuse and many-to-one relationship preservation |
| 26.9 | Batch Merge UI | [x] | Added `Merge` to the bottom action island and focused-card batch menu, extracted shared `CardReferenceRow` from Detail related notes, and built the reorder-first merge dialog |
| 26.10 | Batch Merge backend | [x] | Added `merge_blocks(ordered_slugs)` as one filesystem transaction-like command: compose new article `.md`, rewrite external refs to the merged slug, delete source `.md` files, preserve media binaries, refresh index/thumbs and rollback partial apply failures |
| 26.11 | Batch Merge tests | [x] | Rust/frontend coverage for ordering, mixed card kinds, collection/related-note union, incoming relation rewrite, media reuse, failure rollback, viewport preservation and dialog state |
| 26.12 | Tests + manual QA | MANUAL QA | Automated modifier selection, range geometry, action-bar, group drag payload and stack preview coverage is in place; real-vault manual QA for dark/light frame and batch actions remains |

### Phase 27 — Surface Search

Goal: add scoped search as filtering for existing surfaces: `Cmd+F` filters the
current Grid route from the top app chrome, `Shift+Cmd+F` filters the left
Sidebar channel list. Search is not a modal, not a route and not `Cmd+K`.

Specification: [SPEC_SEARCH.md](SPEC_SEARCH.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 27.1 | Search read model | [x] | Dedicated `search_grid_blocks` returns revision-safe paginated `SearchSnapshot`; normal `list_grid_blocks` remains the unfiltered route projection |
| 27.2 | Match excerpts | [x] | Add search-only match metadata: title/description/body visible fields plus author/url searchable metadata, plain-text excerpt and frontend-safe ranges |
| 27.3 | Main/Grid search UI | [x] | Main search mechanism remains App-owned and route-facing; visual search component temporarily removed, top chrome divider preserved |
| 27.4 | Sidebar search UI | [x] | Top chrome now contains traffic-light spacer, space selector, and no-icon channel search; `Shift+Cmd+F` focuses search while Sidebar consumes the query and filters/ranks channel rows without changing Grid route; interactive top-chrome controls support threshold native window drag |
| 27.5 | Card highlighting | [x] | Article title/body match rendering with design-system mark token and stable masonry measurement in search mode |
| 27.6 | Right collection switcher | [x] | Right top chrome shows the current Grid route collection and opens a searchable destination dropdown ordered like Sidebar; active/current rows are omitted; fixed `Create channel` opens a separate dialog; space/collection/sidebar search inputs keep focus while arrows move `aria-activedescendant`; floating menu widths are documented as semantic roles (`command`, `selector`, `picker`) |
| 27.7 | Optional Compact Detail top menu | [x] | Settings flag moves Detail controls into permanent top chrome when Detail is open: `All / Connected` lives only in expanded Sidebar/search segment, the right segment keeps a persistent clickable collection switcher plus animated card title, overflow and close; compact geometry is stable before/after Detail so collection labels do not jump; all compact chrome controls use the shared click-vs-window-drag threshold |
| 27.8 | Tests + manual QA | MANUAL QA | Automated backend/frontend coverage is in place; real-vault dark/light QA remains |
| 27.9 | Recent empty state | [x] | Пустой query в Search Overlay показывает 20 последних добавленных (`saved_at DESC`, тот же `list_grid_blocks` без запроса, без debounce), сгруппированных в динамические датные секции (`recencyBuckets.ts`: Today/Yesterday/Past 7 days/Past 30 days/месяцы/годы, локальная полночь); счётчик скрыт; плоская клавиатурная навигация поверх секций; решения Р-13…Р-16 в SPEC_SEARCH_OVERLAY § Recent-режим |

### Phase 28 — Hybrid Search

Goal: upgrade Surface Search from lexical-only retrieval to an architecturally
mature hybrid search experience. The user should be able to type a Russian
query and retrieve relevant English cards by meaning, while exact lexical
matches remain explainable and trusted.

Specification: [SPEC_SEARCH.md](SPEC_SEARCH.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 28.1 | Hybrid search SPEC | [x] | Document lexical + alias/transliteration + multilingual semantic retrieval, fusion ranking, semantic excerpts and no-fake-highlight behavior |
| 28.2 | SearchEngine boundary | [x] | Non-empty Grid queries delegate to `storage::search_engine`; frontend still calls one route-facing command independent of the internal backend |
| 28.3 | Search documents/chunks | [x] | Build normalized `SearchDocument`/`SearchChunk` derived model with offsets, hashes, route refs and hidden searchable metadata chunks |
| 28.4 | Alias/transliteration index | [x] | Add first deterministic query-planning slice for app/domain terms and Russian-English aliases (`память`/`memory`, `стая`/`flock`, `птиц`/`birds`, `майн`/`mine`) |
| 28.5 | Local semantic embeddings | [x] | Add local-first multilingual embedding generation, model metadata and background indexing lifecycle |
| 28.6 | Fusion/rerank | [x] | Merge lexical, alias, fuzzy and semantic candidates with deterministic ranking and tests preserving exact-match trust |
| 28.7 | Semantic UX | [x] | Render semantic-only excerpts without fake highlights and keep progressive result snapshots stable |
| 28.8 | Verification | [x] | Cross-language, typo, alias, stale-index, route-filter and performance tests on realistic vault data |

### Phase 29 — Settings Window [COMPLETE]

Goal: standalone compact settings window (chrome consistent with main), left
section nav, cross-window sync. Specification:
[SPEC_SETTINGS_WINDOW.md](SPEC_SETTINGS_WINDOW.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 29.1 | Rust commands | [x] | `commands/settings.rs`: `open_settings_window` (single instance, Overlay titlebar), `add_known_vault`/`forget_known_vault` (config-only, active not removable), orphan media scan/promote/delete (one-pass referenced-set через `collect_delete_media_for_block`, promote без копирования, revalidation + skipped) |
| 29.2 | Window wiring | [x] | Регистрация команд в `lib.rs`, нативный пункт меню `Settings…` (`Cmd+,`), `capabilities/default.json` windows += `settings` |
| 29.3 | Settings frontend | [x] | Второй Vite-entry `settings.html` + `src/settings/` (SettingsApp, Appearance/Graph/Spaces/Orphans), chrome bar h-8 bg-chrome + traffic-light reserve, nav 176px bg-active |
| 29.4 | Theme extraction | [x] | `src/lib/themeMode.ts` (вынос из ThemeMenuButton), оба окна применяют тему до первого рендера; ThemeMenuButton удалён |
| 29.5 | Cross-window sync | [x] | `settings-changed` Tauri event (`src/lib/settingsChanged.ts`), main-окно перечитывает тему/compact/bottom и единый `mine.graphPreferences` объект; кнопка Settings в нижней панели → `open_settings_window` |
| 29.6 | Tests | [x] | Rust: 8 тестов (spaces dedupe/forget-active, space stats scan/index/validation, orphan scan/promote/delete edge cases); frontend: themeMode, graphPreferences, formatBytes, SettingsApp nav, 4 секции, App интеграция |
| 29.7 | Spaces redesign | [x] | Строка пространства: per-row статистика `space_stats(path)` (stat-only top-level + elements из локального индекса `card_kind != 'channel'`, без чтения содержимого — iCloud dataless safe); сводка `N elements · N markdown · N media · N files · size`; `Remove Space` в `⋯`-меню (detach); зафиксированные решения Р-1…Р-12 в SPEC § Design decisions; `formatBytes` (десятичная база) и `MenuIconSlot` (ui/) дедуплицированы |
| 29.8 | Spaces interactions | [x] | Клик по строке = переключение (`select_vault` эмитит `vault-selected`, корневой App ремонтирует `AppWithVault`); активная строка `bg-active` без текстовой метки; dnd-kit reorder (`reorder_known_vaults`, set-equality; PointerSensor distance 8); `VaultSwitcher` перечитывает список при открытии меню; Remove активного → switch на следующее, затем forget (инвариант config); единственное пространство забывается без переключения |

### Phase 30 — Graph View

Goal: add an Obsidian-style spatial map for Mine collections, blocks, wikilinks,
and related-note provenance using the technical solution extracted from
Longevity Landscape.

Specification: [SPEC_GRAPH_VIEW.md](SPEC_GRAPH_VIEW.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 30.1 | Longevity extraction + SPEC | DONE A4 | Studied `/Users/i_iii/Проекты/longevity-landscape` Graph View and documented the transferable Canvas/d3-force renderer, backend graph snapshot, physics, UX, large-vault policy and tests |
| 30.2 | Dependencies + DTOs | DONE A4 | Added `react-force-graph-2d`, `d3-force`, `@types/d3-force`; M1 Rust/TS DTOs cover card/collection nodes, typed links, scopes, options and truncation state |
| 30.3 | Backend graph snapshot | DONE A4 | Typed card/collection nodes; real-target-only membership/wikilink/related edges with provenance, dedupe and adjacency; plain note-link indexing excludes media embeds; automatic route/library scopes and explicit safe large-vault materialization |
| 30.4 | Canvas renderer | DONE A4 | Screen-fixed derived thumbnails and labels, straight solid membership plus curved dashed semantic references, same-layer hit testing/physics, delayed stable fit, image-cache invalidation and camera-only resize/zoom |
| 30.5 | Minimal surface + Detail integration | DONE A4 | Removed graph-local search/scope/settings controls; common Settings owns three persisted graph layers; one selected-node state, conditional centering, shared hover/menu behavior and keyboard/a11y model |
| 30.6 | Display mode wiring | DONE A4 | Canonical secondary-bar Grid/Graph selector, persisted mode, route preservation and `vault-refreshed` projection reload |
| 30.7 | Verification | DONE A4 | Rust provenance/route/threshold tests, GraphView plus Settings contract tests and dark/light Playwright Canvas pixel/resize/hover/request/performance gates |

### Phase 31 — Scroll edge fade

Goal: optional band at the top edge of every scrollable surface, so scrolled
content reads as sliding under the chrome instead of being cut by it.

Specification: [SPEC_SCROLL_EDGE_FADE.md](SPEC_SCROLL_EDGE_FADE.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 31.1 | Curve and constants | [x] | `src/lib/edgeFade.ts`: `smootherstep` ramp with no gamma term, `TOP_FADE_HEIGHT = 24`, `TOP_FADE_MIN_ALPHA = 0.08`, stop density, scroll threshold, `isTopFadeSupported` |
| 31.2 | Overlay, not mask | [x] | `TopFadeScrim`: gradient in the surface colour via `color-mix`, per-surface token (`--background` / `--sidebar` / `--card`) |
| 31.3 | Dark theme only | [x] | Light-theme coverage bleaches photographs; the band does not render there |
| 31.4 | Placement | [x] | Sibling of each scroll container, constant height, `opacity`-only state change; sidebar wrapper matches the nav's frozen min-width |
| 31.5 | Activation | [x] | One `useTopFadeMask` for all four surfaces, callback ref for dialog-mounted nodes, boolean state |
| 31.6 | Preference | [x] | `mine.scrollEdgeFade` (off by default), Appearance row, `settings-changed` branch, prop through `RouteContext` |
| 31.7 | Tests | [x] | Curve, stop density, gradient shape, theme gate, hook lifecycle, feed/search/sidebar integration |

### Phase 32 — Video from restricted X posts

Goal: save video from age-restricted posts, which both existing extraction paths
are structurally unable to reach.

Specification: [SPEC_CLIPPER.md](SPEC_CLIPPER.md), decision 031 in
[ARCHITECTURE.md](ARCHITECTURE.md).

| # | Slice | Status | Scope |
|---|---|---|---|
| 32.1 | Detection | [x] | Content script flags a post whose player it sees but cannot resolve; the check tests for a usable `src`, not for the presence of preview entries — a `blob:` source leaves an entry carrying only a poster |
| 32.2 | Cookies | [x] | `cookies` permission plus X host permissions; background reads cookies for X domains only, only for flagged posts, and never stores them |
| 32.3 | Host resolution | [x] | `yt-dlp` located by install prefix (the browser hands the host a minimal `PATH`), progressive https mp4 only, poster requested in the same call, cookie jar written `0600` and removed on every exit path |
| 32.4 | Body write-through | [x] | Resolved links appended to the note body — the host downloads media by reading markdown embeds, so preview-only video is dropped at save |
| 32.5 | Host log | [x] | `~/Library/Logs/com.mine.app/native-host.log`; the host speaks over stdin/stdout, so printing there corrupts the protocol and stderr is lost |
| 32.6 | Tests | [x] | Flag decision table, cookie-jar refusal and cleanup, binary lookup under a stripped `PATH` |

### Backlog

| Task | Description |
|---|---|
| Validate vault | Команда проверки целостности vault: валидация frontmatter, осиротевшие медиа, консистентность индекса, автоисправление |
| Conflict diff view | Опциональный side-by-side diff base ↔ conflict перед `dismiss_for_manual_merge`. См. [SPEC_IDENTITY_ROBUSTNESS.md](SPEC_IDENTITY_ROBUSTNESS.md) § Conflict resolution. |
| Tight per-kind numbering после dedup/failed | После Phase C индексы могут содержать gap'ы (`image 1, image 3`). Renumber + rename файлов на диске для консистентности с пользовательским ожиданием. UX-only, не функционально. |
