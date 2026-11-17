# SPEC: integration layer (watcher + commands)

**Состояние:** реализовано. Источник: строка «Status» ниже; PLAN.md, Phase 4. **Сверка с кодом:** 15.11.2026, существование названных файлов; имена команд держит тест `src/lib/commandArguments.test.ts`.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_SEARCH.md](SPEC_SEARCH.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md)

Связующий слой: file watcher отслеживает изменения в vault, Tauri commands предоставляют API для фронтенда. Оркестрация файл → парсинг → индексация → thumbnail.

Status: Phase A2 implemented. Watcher remains the low-latency invalidation
source; `VaultReconciler` is the correctness boundary, watcher recovery replaces
a failed native watcher, and compound source/index mutations use the
storage-owned staged commit/rollback contract from [SPEC_STORAGE.md](SPEC_STORAGE.md).

---

## watcher/events

Классификация событий файловой системы.

### Типы

```rust
enum VaultEvent {
    BlockChanged(PathBuf),   // .md создан или изменён
    BlockDeleted(PathBuf),   // .md удалён
    MediaChanged(PathBuf),   // медиафайл создан или изменён
    MediaDeleted(PathBuf),   // медиафайл удалён
}
```

### Функции

```rust
classify_notify_event(event: &notify::Event, vault: &VaultLayout) -> Vec<VaultEvent>
```

### Поведение classify_notify_event

- Принимает сырое событие `notify::Event`
- Игнорирует все hidden/service directories (`.mine`, `.obsidian`, `.git`,
  legacy `.arena`, `.mine-migration-backup`) и build/vendor directories such as
  `node_modules`, `target`, `__pycache__`
- Игнорирует директории
- Игнорирует файлы, которые ни одна заметка не называет (SPEC_DEEP_AUDIT.md,
  Е5.4): скрытый файл (`.DS_Store`, заглушка `.x.icloud`), кроме скрытой
  заметки `.md`, которую видит сканирование; временный файл Mine рядом с
  записываемым (`files::is_mine_temp_file_name`); расширение `md` в другом
  регистре (`.MD`), которое ни Mine, ни Obsidian не читают как заметку. До
  13.10.2026 каждый из них запускал полную сверку как изменение медиа.
- `.md` файлы → `BlockChanged` / `BlockDeleted`
- Остальные файлы → `MediaChanged` / `MediaDeleted`
- Create/Modify → `*Changed`, Remove → `*Deleted`
- Перед dispatch watcher может отбросить event, если path временно находится в `AppState.suppressed_paths` (in-app rename suppresses its own write/rename burst)

---

## watcher/handler

Оркестрация: файловое событие → обновление индекса.

### Типы

```rust
struct ScanResult {
    pub indexed: usize,
    pub errors: usize,
}
```

### Функции

```rust
full_scan(conn: &Connection, vault: &VaultLayout) -> Result<ScanResult>
index_md_file(conn: &Connection, vault: &VaultLayout, path: &Path) -> Result<()>
handle_batch(conn: &Connection, vault: &VaultLayout, events: &[SeenEvent], app: Option<&AppHandle>) -> BatchOutcome
```

### Поведение full_scan

- Production startup/route catch-up uses `VaultReconciler`; legacy
  `full_scan`/`incremental_scan` wrappers remain test-only compatibility helpers
  and delegate to the same reconciler rather than implementing a second scan.
- Reconciliation performs a metadata inventory, reads/parses only changed or
  missing-stamp Markdown, commits source-index changes transactionally and
  returns `ScanResult { indexed, errors }` from the typed report.
- Classic thumbnails and existence-backed derived previews are scheduled after
  the committed index generation; preview encoding is never part of the source
  transaction.
- Startup, background sync and focus recovery use the same thumbnail-sweep coordinator.
  Same-vault requests coalesce, the latest switched vault replaces obsolete
  pending work, and a running sweep checks active-vault identity between jobs.

### Поведение index_md_file

- Читает файл, парсит блок, индексирует
- Генерирует thumbnail через `generate_for_block` в очереди превью
  пространства: один поток на пространство берёт задания по порядку, новое
  задание карточки заменяет ждущее, а задание карточки или картинки,
  изменившейся после постановки в очередь (размер и время файла), пропускается,
  потому что изменение поставило своё (SPEC_DEEP_AUDIT.md, Е5.13). До
  13.10.2026 каждое событие делало превью в своём потоке, и медленное превью
  прежней версии ставило старую картинку поверх новой
- Ошибки пробрасываются (не логируются)
- Эмитит Tauri event `block:added { slug, tags, is_text }` после успешного `upsert_block`
- Если `generate_for_block` вернул `ThumbSource::Text` но block имеет embedded media → эмитит `thumb:upgrade-requested { slug, media_path, kind }` для Phase 2 WebView upgrade (см. [SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md))

### Поведение handle_event

С 16.11.2026 события обрабатывает `handle_batch`, пачками («Пачки событий и точное перечитывание» ниже); одно событие это пачка из одного события. Правила по видам событий:

- `BlockChanged` → `index_md_file`
- `BlockDeleted` → `storage::index::remove_block` (slug из имени файла) + Tauri event `block:removed { slug, tags }`
- `MediaChanged` → перечитываются заметки, которые называют файл («Пачки событий и точное перечитывание» ниже; до 16.11.2026 полная сверка пространства на каждое событие), затем превью карточек, чьим медиафайлом картинка является (`media_thumb_targets`), строится из неё в очереди превью пространства и эмитит `thumb:updated { slug }`. Владелец это карточка, у которой `media_file` в индексе равен пути файла от корня или ведёт к нему сейчас (SPEC_DEEP_AUDIT.md, Е5.3). Путь самого файла карточкой не считается: до 13.10.2026 картинка `x.jpg` в плоском пространстве становилась превью карточки `x`, что бы та ни показывала, а в раскладке по папкам владельца по голому имени не находилось. Превью остальных карточек, чья зависимость изменилась, пересобирает проход превью.
- `MediaDeleted` → перечитываются заметки, которые называли файл, и удаляются превью карточек, которые его показывали (по тому же правилу владельца и по изменённым зависимостям); пачка с таким событием дополнительно ставит фоновый проход сразу (ниже, «Переименование медиа снаружи»)
- External rename `.md` файла проходит через pending-remove queue + `body_hash` match (подробности в [SPEC_IDENTITY_ROBUSTNESS.md](SPEC_IDENTITY_ROBUSTNESS.md)): при match handler вызывает `storage::index::rename_slug`, переносит derived artifacts и эмитит `block:renamed { old_slug, new_slug }`. Другие `.md` файлы и source media не переписываются.
- Событие переименования (`Modify(Name)`) означает место, которое файл покинул или занял; какое из двух, решает диск: путь без файла становится `BlockDeleted`, путь с файлом `BlockChanged`. Так перемещение в Корзину или за пределы пространства доходит до индекса удалением (SPEC_AUDIT_FIXES.md, Ф7).
- Отложенное удаление исполняет таймер наблюдателя по окончании окна переименования (500 мс), без ожидания следующего события. Перед удалением из индекса проверяется, что заметки на диске нет: восстановленная заметка остаётся, а её событие появления отменяет отложенное удаление.
- Восстановление наблюдателя после серии ошибок ставит новый наблюдатель, только если его пространство всё ещё открыто.

Watcher is a low-latency invalidation source, not the correctness boundary.
Missing/coalesced platform events are repaired by `VaultReconciler` before final
route-facing snapshots.

### Пачки событий и точное перечитывание (решения 15.11.2026, сделано 16.11.2026)

Решение по [AUDIT_PERFORMANCE.md](AUDIT_PERFORMANCE.md), Б1, пункты 3 и 9 плана, с поправками пользователя 15.11.2026. До этого каждое событие о медиа отдельно запускало полный проход по пространству: 0,37 с на 7 000 карточек, сто файлов из iCloud давали 37 с непрерывной работы.

**Пачки.** Наблюдатель складывает события в очередь (`watch.rs`, `EventBatches`), а обрабатывает их отдельный поток пачками (`handler::handle_batch`).

- Первое событие после тишины обрабатывается сразу: одиночное изменение снаружи (сохранение клиппером, правка в Obsidian) доходит до ленты без ожидания окна, как прежде.
- События, которые пришли во время обработки пачки и в окне 300 мс после неё, собираются в следующую пачку. Она обрабатывается, когда окно закрылось. Сто событий подряд дают не больше двух пачек.
- Окно 300 мс (`BATCH_WINDOW`) это прежнее окно наблюдателя: до 16.11.2026 постоянная `DEBOUNCE_MS = 300` в `watch.rs` ограничивала известие `vault-changed` одним на 300 мс. Теперь оно же отделяет пачки, и новое число не вводится.
- Известие `vault-changed` уходит после пачки, одно на пачку, если пачка изменила индекс или превью. До 16.11.2026 известие уходило после первого события, а изменения следующих 300 мс оставались без известия до другого события.
- Сессии правки узнают о внешнем изменении своей заметки сразу, при приходе события, мимо очереди ([SPEC_EDITING.md](SPEC_EDITING.md), Л4.1), как прежде.
- Если в момент обработки пачки идёт полный проход (координатор свежести или синхронизация), пачка помечает его устаревшим и сама ничего не делает: проход пройдёт заново и увидит всё.

**Порядок в пачке.** Повторы одного события о том же пути схлопываются. Сначала обрабатываются события о заметках (`BlockChanged`, `BlockDeleted`) в порядке прихода, затем события о медиа. Заметку, проиндексированную в этой пачке, событие о медиа не перечитывает: она уже прочитана с файлом на месте. Сверка идентичности файлов (`file_identity::reconcile`) для событий о заметках идёт один раз на пачку, а не на каждое событие.

**Точное перечитывание.** Все события о файлах медиа одной пачки дают один проход `reconcile::reread_notes_naming`. Он не обходит пространство и не читает заметки, которые файл не называют.

1. Заметки, которые называют файл, ищутся по имени файла, а не по записанному пути (поправка пользователя 15.11.2026). Имя сравнивается с последней частью каждой записанной зависимости заметки (`source_index_state`), без различия регистра и формы Unicode, с учётом процентной записи. Причина: для файла, которого ещё нет, зависимость записана путём рядом с заметкой (`resolve_local_reference`, `collect_dependency_paths`), а файл приходит в папку `Media`, и пути не совпадают. Лишняя заметка с тем же именем файла в другой папке перечитывается зря, пропущенной быть не может.
2. Поиск держит одна функция, `reconcile::notes_naming_files`. Она ищет каждое имя по ключу в таблице имён зависимостей `source_dependency_names` (схема 9, [SPEC_STORAGE.md](SPEC_STORAGE.md)), поэтому цена события не растёт с числом заметок. До схемы 9 это был один просмотр всех отпечатков `source_index_state` на пачку, около 0,9 мс на тысячу заметок.
3. Каждая найденная заметка читается и проецируется заново, как в проходе: строка, отпечаток источника и зависимости в одной транзакции на пачку. Ссылки распознаются по индексу имён файлов пространства, который процесс держит между проходами (ниже).
4. Заметка, чьё содержимое в iCloud, не читается: пачка просит фоновый проход, который её скачает (Х12, Х24).
5. Дальше, как прежде: превью карточек, которые показывали файл, сбрасываются и ставятся в проход превью; картинка, которая является медиафайлом карточки, сразу становится её миниатюрой.

**Индекс имён файлов.** Перечитать заметку значит распознать её ссылки, а для этого нужны имена всех файлов пространства. Обход всех файлов на каждое событие стоил бы больше самого перечитывания. Процесс держит индекс имён последнего полного прохода (`reconcile::keep_files`, [SPEC_STORAGE.md](SPEC_STORAGE.md), «Проход без изменений»), а наблюдатель ведёт его по каждому своему событию: появившийся файл добавляется, пропавший убирается (`LinkIndex::insert`, `LinkIndex::remove`), в том числе по событиям, которые наблюдатель дальше не обрабатывает (свои записи Mine).

Индекс не может молча разойтись с диском:

- Каждый полный проход сверяет свой обход с индексом и, если файлы другие, строит индекс заново из своего обхода и заменяет им прежний. Это проход безопасности раз в 30 с, проход перед действием, проход после потерянных событий и после события о папке.
- Событие о папке (папка появилась, переименована или удалена) и сообщение системы о потерянных событиях (`need_rescan`, ошибка наблюдателя) сбрасывают индекс и ставят полный фоновый проход сразу. Папкой считается путь, по которому лежит папка, и пропавший путь, под которым индекс знал файлы. Пропавший путь, которого индекс не знал вовсе, это файл, который появился и исчез; пока индекса нет, любой пропавший путь считается папкой.
- Пока индекса нет (первый проход пространства ещё не прошёл), перечитывание строит его своим обходом.

**Переименование медиа снаружи.** Переименование файла в Finder чинит сверка идентичности файлов: она правит ссылки в заметках. Сверка идентичности обходит всё пространство, поэтому в точное перечитывание не входит. Пачка, в которой есть удаление файла медиа (половина переименования), перечитывает заметки сразу и дополнительно ставит фоновый проход немедленно (`freshness::request_pass`): ссылки чинятся в ту же секунду, а не через 30 с. Приход файлов (iCloud, клиппер) удалений не содержит и прохода не ставит.

**Проход безопасности** раз в 30 с остаётся для событий, которые наблюдатель потерял. Файл, пришедший позже заметки, подхватывает точное перечитывание, а не он.

Пределы и проверки. Событие о медиа не дольше 20 мс в сборке, оптимизированной как приложение, и на пространстве из 10 000 заметок, и на пространстве из 30 000: цена события не растёт с пространством. Тест `a_media_event_in_a_space_of_10_000_notes_answers_within_its_limit` (`watcher/handler.rs`, `bun run test:rust-speed`) утверждает один предел на обоих пространствах. Таблица имён: `the_names_of_a_notes_dependencies_follow_its_stamp` (`storage/reconcile.rs`), `version_nine_drops_stamps_without_names_and_keeps_names_with_their_stamp` (`storage/migrations.rs`). `watcher/handler.rs`: `a_hundred_media_events_of_one_batch_make_one_pass`, `a_file_that_lands_in_media_after_its_note_finds_the_note_by_name`, `notes_of_a_batch_are_handled_before_its_media`, `a_media_move_outside_is_repaired_by_the_pass_its_batch_asks_for`, `a_folder_event_asks_for_a_full_pass_and_drops_the_kept_names`, `a_full_pass_replaces_names_the_watcher_lost`. `storage/reconcile.rs`: `reading_again_for_a_file_reads_only_the_notes_that_name_it`, `reading_again_leaves_a_note_in_icloud_to_the_background_pass`, `the_kept_names_follow_the_paths_a_watcher_reports`. `watcher/watch.rs`: `the_first_event_after_quiet_is_handled_at_once`, `a_hundred_events_in_a_row_make_two_batches`, `the_queue_hands_out_a_waiting_batch_and_ends_when_stopped`. `mine-core/src/links.rs`: `an_index_grown_file_by_file_is_the_index_built_at_once`, `an_index_without_a_file_is_the_index_built_of_the_others`.

### Watcher recovery

- Native watcher errors emit `watcher-error` with vault path, consecutive error
  count and a stable error kind; errors are never log-only.
- Three consecutive callback/handler errors within 30 seconds schedule one
  coalesced reconciliation pass.
- A successful watcher event or reconciliation resets the consecutive counter.
  A reconciliation that finished with errors in some notes is a finished one
  (SPEC_DEEP_AUDIT.md, Н6): the index is ready without them.
- Recovery first completes one coalesced reconciliation, then starts a
  replacement native watcher and atomically swaps the single `AppState.watcher`
  slot. Dropping the previous handle stops it; no two watcher slots remain
  active.
- `watcher-error` and recovery events never contain source content.

### Tauri events (frontend subscribers)

Все события эмитятся через `tauri::Manager::emit`. Frontend subscribers в `src/hooks/useChannelPreviewsEvents.ts` и `src/hooks/useThumbnailUpgrade.ts`.

| Event | Payload | Emitted by |
|---|---|---|
| `block:added` | `{ slug: string, tags: string[], is_text: boolean }` | `index_md_file` после `upsert_block` |
| `block:removed` | `{ slug: string, tags: string[] }` | `handle_event::BlockDeleted` |
| `block:renamed` | `{ old_slug: string, new_slug: string }` | watcher external rename path и `rename_block_file` |
| `thumb:updated` | `{ slug: string }` | `save_thumb` command и фоновая генерация |
| `thumb:upgrade-requested` | `{ slug: string, media_path: string, kind: "image" \| "video" }` | `index_md_file` когда Rust cascade дал text placeholder для block с embedded media |
| `vault-conflicts-changed` | `{ count: number }` (`VaultConflictsChanged`) | вкладкам пространства: проход проверки конфликтов iCloud, изменивший множество путей; `list_vault_conflicts`, убравший путь; каждый `resolve_vault_conflict` (раздел «Конфликты iCloud»). Сбой проверки пишется в журнал, поля сбоя в событии нет (решение пользователя 14.10.2026, SPEC_ICLOUD_CONFLICTS.md) |
| `vault-freshness-changed` | `{ vault_path, generation, state, …, error_count, error_files }` | координатор свежести после прохода: `error_files` перечисляет заметки, которые проход не прочитал или не спроецировал, с видом ошибки и причиной; индекс готов без них (SPEC_DEEP_AUDIT.md, Н6, Е5.1). Уведомление в интерфейсе входит в Е6.17 |

## commands/freshness coordinator

Status: implemented in Phase A1. The coordinator preserves a readable last-good
snapshot, coalesces dirty work and avoids inventory on clean sequential reads.

```rust
enum FreshnessRouteAction {
    AwaitFirstGeneration,
    SpawnBackground,
    ReadCommitted,
}

struct FreshnessEntry {
    running: bool,
    scheduled: bool,
    dirty: bool,
    generation: u64,
    last_completed_at: Option<Instant>,
    last_result: Option<Result<ReconcileReport, String>>,
}
```

The coordinator owns one in-flight `VaultReconciler` pass per vault. `dirty`
persists even while no pass is running. Concurrent callers join one generation;
sequential callers on a clean generation take a lock-only fast path and perform
no filesystem inventory. A bounded periodic safety audit exists only to catch a
missed watcher event and never blocks a readable route snapshot.

**Ход первого прохода (с 08.10.2026, SPEC_CLOUD_STORAGE.md, Х28).** Ход
`(обработано, всего)` принадлежит самому первому проходу пространства, а не
тому, кто его позвал. Проход, начатый, пока у пространства нет прочитанного
снимка (`AwaitFirstGeneration`), шлёт `vault-sync-progress` при любом
зачинщике: чтении ленты, фоновом дозаполнении при открытии
(`start_index_metadata_backfill`) или синхронизации. Присоединившиеся к нему
чтения ленты ничего не шлют сами: они ждут проход, который уже считает вслух.
Раньше первый проход почти всегда начинало дозаполнение, без счётчика, и
уведомление О13 не получало ни одного события. Проходы при готовом снимке
(фоновая сверка, аудит) молчат, как прежде.

### Route-facing read sequence

The following commands use one shared helper before their final query:
`list_grid_blocks`, `list_taxonomy_snapshot`, `list_channel_previews`,
`search_grid_blocks`, `get_block`, and `list_graph_snapshot`.

1. Capture vault identity/path without retaining `vault_state` mutex ownership.
2. If no committed local snapshot exists, join the first reconciliation until a
   readable snapshot is committed.
3. If a snapshot exists, read it immediately. `dirty` and expired-safety-audit
   states start or join one background generation; a degraded report remains
   readable until that bounded retry opportunity.
4. A per-file error publishes `degraded` diagnostics but does not turn Grid,
   Search, Detail, Sidebar or Graph into command errors. The affected changed
   file keeps its last-good row; a new unreadable file is omitted until fixed.
5. A fatal reconciliation error still permits a read attempt against the last
   committed SQLite snapshot. Only failure to open/query that snapshot blocks
   the route command.

The frontend paints the committed route snapshot immediately during
`reconciling`. Completion emits `vault-freshness-changed`; Grid, Search, Detail,
Sidebar and Graph rerun their current read once for the new generation. After
the first committed generation, search keystrokes never wait for an inventory
walk.

### Lock order

- Never wait for reconciliation while holding `vault_state`, `watcher`,
  `sync_tracker`, `suppressed_paths` or thumbnail sweep locks.
- Coordinator state is acquired only to join/start/finish a generation; no
  filesystem or SQLite work runs while that mutex is held.
- Reconciliation uses a dedicated DB connection and owns its SQLite transaction
  only after all AppState locks are released.
- Command-driven source writes finish/roll back before publishing dirty state;
  watcher suppression is registered before the first filesystem mutation.

### Performance and observability

- One dirty period maps to one reconciliation generation.
- A clean route read performs zero filesystem calls and zero SQLite writes.
- One hundred sequential searches within a clean generation trigger zero new
  inventory passes.
- Safety-audit expiry schedules background work; it is not a blocking TTL gate.
- Last-good snapshot paint is not delayed by reconciliation.
- Final refresh emits once per generation, not once per changed file.
- Development diagnostics expose generation, joined callers, inventory count,
  parsed count, write count, errors, fast-path hits and elapsed time.

---

## Перечень команд

Зарегистрированные команды перечисляет `generate_handler!` в
[lib.rs](src-tauri/src/lib.rs). Типы их запросов, ответов и ошибок выводятся
из Rust в [generated.ts](src/types/generated.ts) (раздел «Generated IPC
contract»). Страница вызывает команды только через
[commands.ts](src/lib/commands.ts). Своего перечня команд и их сигнатур этот
документ не держит: разделы ниже описывают поведение отдельных команд.

Тест «the commands SPEC_INTEGRATION.md names» в
[commandArguments.test.ts](src/lib/commandArguments.test.ts) роняется, если
документ называет команду, которая не зарегистрирована, или имя бэкенда,
которого нет в коде.

## Команды вне главного потока

Синхронная команда Tauri (`pub fn` с `#[tauri::command]`) выполняется в
главном потоке. Команда записи ждёт замок пространства и запись в индекс, а
фоновая работа (дозаливка метаданных, проверка превью, сверка) держит их
секундами. Пока команда ждёт, замирают все окна: 03.10.2026 удаление карточки
и коллекции висело почти минуту во время дозаливки 645 текстов превью.
13.10.2026 подготовка удаления медиа (`prepare_delete_media_asset`) около 30
секунд читала каждую заметку пространства iCloud больше чем на 700 карточек,
и приложение крутило «радугу».

Поэтому вне главного потока выполняется каждая команда, которая читает или
пишет файлы пространства, ходит в индекс или ждёт замок пространства, в том
числе через `tab_layout`: `pub async fn` или `#[tauri::command(async)]`, во
втором случае тело выполняется в пуле потоков Tauri. Так же вынесены чтения,
которые ждут сеть или процесс-помощник: `list_arena_channels`,
`icloud_download_progress`, `start_vault_sync`. 13.10.2026 вынесены
`prepare_delete_media_asset`, `copy_media_asset_to_clipboard`,
`get_article_audio_state`, `set_article_audio_position`,
`cloud_recommendation_state`, `dismiss_cloud_recommendation`,
`add_known_vault`, `get_unavailable_vault`, `get_vault_path`,
`get_vault_write_layout`, `first_card_marker_pending` и
`complete_first_card_marker`.

В главном потоке остаются только команды из `MAIN_THREAD_COMMANDS` в
`commands/effects.rs`, каждая с причиной: окна и вкладки (`commands/tabs.rs`),
меню приложения, системный буфер обмена (`read_clipboard_payload`), настройки
приложения, счётчики в памяти. Исключение до работ над загрузками и выходом
([SPEC_DEEP_AUDIT.md](SPEC_DEEP_AUDIT.md), Е2): команды Download Media
(`start_source_video_download`, `cancel_source_video_download`,
`source_video_download_status`) ждут замок пространства через `tab_layout` и
помечены в списке как ожидающие переноса.

Тест `no_command_runs_on_the_main_thread_unless_listed` в `effects.rs` берёт
каждую зарегистрированную команду и роняется, если синхронная команда не
названа в списке или названная уже выполняется вне главного потока. Тест
`no_command_that_writes_runs_on_the_main_thread` дополнительно не пускает в
список команды записи.

## Список изменённых карточек

Решение 15.11.2026 (`AUDIT_PERFORMANCE.md`, Л3 и В2, пункт 10 плана). До него
вкладка после своего изменения и каждая другая вкладка пространства после
известия читали ленту целиком с первой карточки: 167–195 мс и 9,2 МБ при
7 000 загруженных карточек. Теперь команда изменения называет карточки,
которые она изменила, создала или убрала, и вкладки читают только их строки
(SPEC_FRONTEND.md, «Обновление ленты»; чтение описано в SPEC_STORAGE.md,
«Частичное чтение ленты»).

**Откуда список.** Список собирает не команда, а индекс. Каждое соединение,
открытое через `storage/db.rs` (`init_connection`), сообщает слушателю
(`storage/feed_changes.rs`, update hook SQLite) о каждой вставленной,
изменённой и удалённой строке таблиц, из которых читается строка ленты.
Команда изменения открывает запись (`ChangeNews::before`) до своей работы и
закрывает её после; в список попадает каждая карточка, чью строку за это
время записало любое соединение процесса. Так список не зависит от того,
верно ли команда перечислила свои записи. Запись другой работы, попавшая в
то же время (сверка, превью, команда другой вкладки), делает список шире;
лишняя карточка в списке стоит одного лишнего чтения её строки и ничего не
ломает.

Таблицы, которые слушает слушатель. Это все таблицы, из которых собирается
строка ленты (`grid_row_columns_sql`) и её принадлежность ленте места
(`feed_place_sql`):

| Таблица | Что из неё читает лента | Что называет запись строки |
|---|---|---|
| `blocks` | все поля карточки, в том числе манифест и состояние превью, размеры, автора, ключ автора для ленты автора, дату и имя для порядка | карточку по номеру строки (`blocks.id`), при вставке, изменении и удалении |
| `block_tags` | ссылки карточки на коллекции: поле `collections` и принадлежность ленте коллекции | при вставке и изменении ссылки её карточку (`block_id` читается из индекса по номеру строки). Удалённую ссылку SQLite называет только номером строки; ссылки удаляют два места кода (`index::upsert_block` и дозаполнение членства) и каскад при удалении карточки, и все три в том же шаге пишут строку `blocks` этой карточки |
| `channels` | страницу коллекции: только ссылка на имя со страницей есть членство; порядок коллекций в поле `collections` | при вставке страницы карточки, которые ссылаются на её имя или путь: они становятся участниками без записи своих строк ([SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md), К3). Изменение и удаление строки делают список неизвестным |

Строка `channels` изменена или удалена (переименование, удаление,
перестановка коллекций): слушатель получает от SQLite только номер строки,
без прежних значений, поэтому не знает ни прежнего имени, ни того,
сменилось ли место коллекции. Такое изменение читается целиком, как
изменение снаружи.

Счётчики коллекций (`list_taxonomy_snapshot`) и превью бокового меню
(`list_channel_previews`) от списка не зависят: после своего изменения и
после любого известия вкладка читает их целиком, как прежде.

**Когда SQLite слушателя не вызывает** (sqlite.org/c3ref/update_hook.html,
sqlite.org/lang_delete.html). Каждый случай закрыт устройством схемы или
проверкой исходников; тесты в `feed_changes.rs`:

- `DELETE` без `WHERE` на таблице без триггеров: SQLite очищает таблицу, не
  проходя строк. У всех трёх таблиц есть триггеры удаления (ревизия снимка),
  поэтому строки проходятся и слушатель слышит каждую
  (`a_delete_of_every_row_is_heard_row_by_row`: и поведение, и наличие
  триггеров).
- Строка, удалённая при разрешении конфликта заменой (`REPLACE`,
  `INSERT OR REPLACE`, `UPDATE OR REPLACE`). Ни один запрос приложения не
  заменяет строки этих таблиц: карточки и коллекции пишутся через
  `INSERT … ON CONFLICT DO UPDATE`, что слушатель слышит как изменение
  (`no_statement_replaces_a_row_of_the_feed_tables` читает исходники).
- Таблицы `WITHOUT ROWID`. Среди трёх таблиц таких нет
  (`the_feed_tables_have_row_numbers`).
- Записи другого процесса (CLI, MCP, помощник клиппера) в тот же файл
  индекса. Это изменения снаружи: вкладки узнают о них от наблюдателя и
  читают ленту целиком.
- Удалённая ссылка `block_tags` называется только номером строки (таблица
  выше): `links_are_deleted_only_where_the_card_row_is_written` держит
  перечень мест, удаляющих и меняющих ссылки, и падает на новом.

**Предел списка.** Команда называет не больше `FEED_CHANGE_LIMIT` карточек.
Когда записано больше строк, запись перестаёт их хранить, и список
неизвестен: команда и известие говорят «читать целиком». Массовая запись,
которая идёт рядом с командой (первый индекс пространства, проход сверки по
тысячам заметок), поэтому не копит список без предела. Предел 500 карточек;
основание числа в [SPEC_STORAGE.md](SPEC_STORAGE.md), «Замер частичного
чтения».

**Ответ команды.** Команды изменения из `commands/tags.rs`,
`commands/blocks.rs` и `commands/channels.rs` отвечают обёрткой:

```rust
/// What a command answers with, and the cards it changed.
struct Changed<T> {
    value: T,
    /// `blocks.id` of every card row the command wrote, added or removed.
    /// `None`: the cards are not known, the feed is read in full.
    cards: Option<Vec<i64>>,
}
```

Команда, которая ответила ошибкой, списка не называет: часть её записей могла
состояться, и страница после ошибки читает ленту целиком.

**Известие другим вкладкам.** `vault-changed` несёт тот же список:
`VaultChangedPayload.cards: Option<Vec<i64>>`. Известие команды несёт список
у каждой команды изменения, в том числе у тех, чей ответ обёрткой не стал
(`save_note_body`, `import_arena_channels`, `resolve_vault_conflict`): его
прикладывает `ChangeNews::send`. У известий наблюдателя, сверки, прохода
превью и окна настроек списка нет (`None`): такие изменения вкладка читает
целиком.

**Вызвавшая вкладка получает только ответ.** Второго чтения после своей
команды у неё быть не должно. До 15.11.2026 оно было, по трём причинам:

- Команды членства (`add_tag`, `remove_tag`, `set_blocks_membership`) не
  следовали правилу своих записей ([SPEC_THUMBNAILS.md](SPEC_THUMBNAILS.md),
  «Свои записи Mine»): писали строку индекса без отпечатка источника и
  оставляли остальное наблюдателю. Наблюдатель индексировал записанную
  заметку заново и слал `vault-changed` всем вкладкам пространства, включая
  вызвавшую. Теперь команда делает его часть сама: в транзакции публикации
  проецирует заметку как проход по пространству, строку и отпечаток вместе
  (`reconcile::project_source_path`), а после неё ставит проверку превью
  карточки в очередь превью пространства (`schedule_preview_reconcile`).
  Свою запись команда называет наблюдателю по содержимому
  (`note_write::expect_own_write`, [SPEC_EDITING.md](SPEC_EDITING.md),
  Л3.6), а не по пути на время: наблюдатель пропускает заметку, только пока
  в ней ровно записанные командой байты, и слышит любую другую правку
  заметки, пришедшую следом. Отметка пути на время (`suppress_paths`)
  спрятала бы такую правку до следующего прохода по пространству.
  `create_block` пока пишет по-прежнему и второе чтение после него остаётся:
  его запись (`files::persist_new_block`) общая с CLI и окном настроек, а
  событие о файле медиа новой карточки обрабатывает наблюдатель.
- Команды медиа, слияния, переименования и извлечения текста сами слали
  `vault-changed`, `block:added`, `block:removed` и `block:renamed` всем
  вкладкам пространства вместе с вызвавшей, хотя остальным вкладкам то же
  сообщает `ChangeNews`. Теперь команда вкладки этих событий не шлёт:
  остальные вкладки узнают об изменении из `vault-changed` со списком и
  переименованиями, вызвавшая из ответа. `thumb:updated` команды шлют как
  прежде: по нему страница обновляет картинку карточки и превью бокового
  меню. Работа без вызвавшей вкладки (доставка скачанного видео) шлёт
  `vault-changed` всем вкладкам, как прежде.
- Закрытие меню карточки читало ленту целиком (SPEC_FRONTEND.md, «Обновление
  ленты»).

Тесты: `feed_changes` (слушатель называет вставку, изменение, удаление и
переименование строки; страница коллекции называет своих участников;
изменение и удаление строки `channels` делают список неизвестным); для
каждого вида изменения частичное чтение даёт ту же ленту, что полное
(SPEC_STORAGE.md, «Частичное чтение ленты»); запись членства пропускается
наблюдателем по содержимому, правка следом слышна, и проход по пространству
после неё ничего не пишет (`commands/tags.rs`).

## Замер чтений ленты

Решение 15.11.2026 (`AUDIT_PERFORMANCE.md`, раздел 7): сколько чтений ленты
делает вкладка после одного изменения и сколько они весят, видно только в
работающем приложении. Каждое чтение ленты страницей пишет в журнал
приложения `Mine.log` одну строку уровня info
(`src-tauri/src/commands/feed_read_log.rs`):

```
feed read: command=read_feed_changes reason=own_command rows=1 bytes=1412 backend_ms=0
```

- `command`: `list_grid_blocks` (страница ленты или вся загруженная лента) или
  `read_feed_changes` (частичное чтение).
- `reason`: зачем страница читает; его передаёт страница аргументом `reason`.
  `route` (место, порядок или пространство открыты или сменились), `page`
  (следующая страница), `own_command` (своя команда), `news` (известие
  пространства), `preview` (готово превью карточки), `card_menu` (закрылось
  меню удержанной карточки), `retry` (повтор после сбоя чтения), `search`
  (недавние карточки окна поиска до набора запроса).
- `rows`: число строк карточек в ответе; `bytes`: размер ответа в JSON;
  `backend_ms`: время чтения индекса и сборки ответа, без ожидания первого
  индекса пространства.

В строке только числа и имена: ни путей, ни названий, ни текста. Это только
замер: поведение чтений он не меняет. Размер ответа известен без второго
прохода по строкам: команда сама сериализует ответ один раз и отдаёт
готовый JSON (`tauri::ipc::Response`), страница получает тот же JSON, что от
типизированного ответа.

---

## commands/state

Разделяемое состояние приложения.

### Типы

```rust
struct VaultState {
    conn: Connection,
    vault: VaultLayout,
}

struct AppState {
    vault_state: Mutex<Option<VaultState>>,
    suppressed_paths: Mutex<...>,
}

#[derive(Debug, Error, Serialize)]
enum CommandError {
    NoVault,
    Internal(String),
}
```

### Поведение AppState

- `suppressed_paths` — short-lived path suppression map для command-initiated file rewrites
- `suppress_paths(paths, ttl)` — регистрирует paths, которые watcher должен игнорировать в ближайшее TTL-окно
- Используется in-app rename, чтобы `.md` rewrite + source file rename не race'или с watcher external-rename logic

---

## commands/vault

### Поведение select_vault

1. Resolve `.mine/vault-id`, migrate known legacy `.arena` identity once and
   remove known legacy derived artifacts from the source vault.
2. Create/open the per-device derived store under Application Support
   (`index.db`, `cache/thumbs`, `cache/audio`), never inside the source vault.
3. Expand asset scope, open the local SQLite snapshot and start exactly one
   native watcher.
4. Publish `VaultState` and return `VaultOpenResult` immediately with cached
   counts plus `sync_in_progress`/migration state.
5. Schedule background reconciliation, classic thumbnail sweep and derived
   preview work through their shared app-level coordinators. Dirty events
   arriving during sync coalesce into another pass; switching vaults cancels
   the previous vault between jobs and suppresses its stale completion events.
6. Emit `vault-sync-started` / `vault-sync-finished`; route-facing commands also
   join `ensure_vault_fresh`, so a missed startup event cannot leave stale final
   reads.

---

## commands/blocks

### commands/note_edit, commands/edit_sessions, commands/edit_menu

События: `note-changed { slug, body_hash }`, `flush-edits { request_id }` (ответ `report_edits_flushed` в пределах 3000 мс), `edit-menu-command`. Контракт: [SPEC_EDITING.md](SPEC_EDITING.md), Л2, Л3, Л4, Л10, Л12. Точные типы в `src/types/generated.ts`.

`toggle_task_item` переключает флажок задачи из режима чтения: меняется ровно один знак исходника, логика записи в `storage::task_toggle`, отказы типизированы (`stale_body`, `changed`, `state_changed`, `in_cloud`, `read_only`, `source_not_found`, `no_vault`, `internal`). Контракт: [SPEC_READING_MODE.md](SPEC_READING_MODE.md), Ч12.3.

### Поведение create_block

1. Сгенерировать slug из first body H1 / readable seed / url, without
   synthesizing `frontmatter.title`
2. Разрешить конфликт slug по SQLite и фактическим файлам vault (`.md` и
   optional media target); disk-only collisions не перезаписываются
3. Создать `Block` с frontmatter
4. Проверить и нормализовать collection refs на IPC-границе
5. Скопировать медиафайл create-new semantics (если есть)
6. Записать `.md` файл create-new semantics; если запись падает после media
   copy, удалить только что скопированный media файл
7. Сгенерировать thumbnail (если изображение)
8. Проиндексировать
9. Вернуть `IndexedBlock`

### Конфликты iCloud (commands/conflicts)

Реализовано 11.10.2026 (PLAN.md, этапы от 45.3 до 45.6); полный контракт в
[SPEC_ICLOUD_CONFLICTS.md](SPEC_ICLOUD_CONFLICTS.md). Конфликт это заметка с
неразрешёнными версиями `NSFileVersion`, а не имя файла: угадывания по имени
нет, файл с любым именем индексируется как обычная заметка (ВК1).

1. `list_vault_conflict_paths` отдаёт пути пространства вкладки из таблицы
   `vault_conflicts`, новые первыми, без запуска помощника: по ним считает
   уведомление (ВК7, ВК10).
2. `list_vault_conflicts` одним запуском `scan` помощника
   `icloud-conflicts-helper` читает версии этих путей заново. Путь, у
   которого версий больше нет (конфликт решили на другом устройстве), уходит
   из таблицы, и вкладки получают новое число (ВК7).
3. `resolve_vault_conflict` принимает путь от корня с папками
   (`Cards/Note.md`), выбор `ConflictChoice` (`keep_version` с `token`, где
   `null` значит версия в папке, или `keep_all`) и версии, которые показало
   окно. Другой набор версий отказывает `versions_changed`, изменённый на
   диске файл `source_changed`; в обоих случаях ничего не меняется. Запись
   идёт одной `StagedSourceMutation` с подавлением наблюдателя, отвергнутые
   версии при `keep_version` уходят в Корзину из папки заметки; если Корзина
   отказала, они остаются отдельными заметками и команда возвращает
   `trash_failed { paths }` (ВК8, ВК9, ВК12). После решения пространство
   ставит проверку этого пути, а другие вкладки узнают об изменении
   (SPEC_TABS.md, В15).
4. Проверка идёт в фоне и только для пространства в iCloud (ВК3, ВК4): после
   каждого прохода сверки и после пачки событий наблюдателя по `.md`, одна на
   пространство, запрос во время неё ставит один повтор. Число путей
   пространство сообщает своим вкладкам событием
   `vault-conflicts-changed { count }` (`VaultConflictsChanged`): после
   прохода, изменившего множество путей, после `list_vault_conflicts`,
   убравшего путь, и после каждого `resolve_vault_conflict`; прежних
   событий `vault-conflict-detected` и `vault-conflict-resolved` нет.
5. Отказы типизированы `VaultConflictError`: `no_vault`, `invalid_path`,
   `not_pending`, `versions_changed`, `source_changed`, `helper_failed`,
   `trash_failed`, `internal`.

### Поведение extract_text_selection

`extract_text_selection` создаёт новую article-карточку из выделенного текста в
открытой статье. Новая карточка хранит snapshot выделения; постоянной
синхронизации с исходным параграфом нет.

1. Проверить vault state, `source_slug`, optional `target_tag`, non-empty
   `selected_text`, body hash and selected source block range.
2. Перечитать source `.md` с диска; если `source_body_hash` устарел, вернуть
   typed stale-selection error без записи.
3. Найти первый Markdown block выбранного диапазона.
4. Если у блока уже есть Obsidian block id, использовать его; иначе вставить
   readable `^block-id` в конец этого блока, сохранив остальные байты файла.
5. Если patch source unsafe (code fence, table, raw HTML, ambiguous range),
   вернуть recoverable error без создания новой карточки.
6. Создать новый `article` block с body snapshot, `Mine Collections` целевой
   коллекции и `Mine Related Notes: [[Source#^block-id]]`. Empty `target_tag`
   means Everything and writes no collection membership.
7. Persist/index через reference-block path: media copy не выполняется.
8. Re-index source block после patch, чтобы body hash и wikilinks были свежими.
9. Эмитить `block:added` и `thumb:updated` для нового блока; source Detail
   остаётся открытым.

### Поведение delete_text_selection

`delete_text_selection` удаляет выделенный текст из source article без создания
нового блока.

1. Проверить vault state, `source_slug`, non-empty `selected_text`, body hash
   and selected source block range.
2. Перечитать source `.md` с диска; если `source_body_hash` устарел, вернуть
   typed stale-selection error без записи.
3. Найти selected text exact match; если rendered selection collapsed whitespace,
   использовать whitespace-normalized search с сохранением source byte span.
4. Проверить, что начало найденного span принадлежит первому selected Markdown
   block range. Это защищает повторяющиеся фрагменты от удаления не из того
   параграфа.
5. Patch source body range in place, сохранить остальные байты файла, re-index
   source block и вернуть обновлённый `IndexedBlock`.
6. Если patch/reindex unsafe или падает, восстановить original source content и
   вернуть typed error.
7. Эмитить `thumb:updated` для source block; `block:added` не эмитится.

### Поведение merge_blocks

`merge_blocks(ordered_slugs)` объединяет две и более выбранные карточки в одну
новую article-карточку. Детальный продуктовый и файловый контракт описан в
[SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md).

Интеграционный инвариант: frontend не собирает Merge из `createBlock` и N
`deleteBlock` вызовов. Это один command, потому что операция одновременно
создаёт новый Markdown, удаляет source `.md`, переписывает внешние ссылки и
обновляет индекс.

1. Проверить vault state, количество slugs, уникальность slugs, существование
   и parseability каждого source block.
2. Отклонить `channel`/collection source blocks.
3. Построить pure merge plan: frontmatter output, body sections, output slug,
   deleted source files, external many-to-one wikilink rewrites.
4. Записать новый `.md` create-new semantics.
5. Применить external rewrites для parseable non-selected `.md` files that
   reference selected source slugs. Индекс сначала приводится к файлам, и с
   диска читаются только кандидаты, которые он называет как возможно
   ссылающиеся на выбранные карточки, и страницы коллекций
   (`notes_that_may_link`, SPEC_DEEP_AUDIT.md, Н5, Е5.5).
6. Только после успешной записи и rewrites удалить selected source `.md` files.
7. Не копировать, не переименовывать и не удалять media binaries.
8. Проиндексировать новый блок и rewritten files, удалить index rows source
   blocks, обновить thumbnail/preview для нового блока.
9. Если apply падает после первой записи, выполнить best-effort rollback:
   удалить merged `.md`, восстановить исходные bytes rewritten files/source
   files и восстановить index rows из восстановленного Markdown.
10. Эмитить `block:added` для merged block, `block:removed` для source slugs,
   `thumb:updated` для merged slug и `vault-changed` для route/index refresh.
11. Вернуть `MergeBlocksResult` с новым `IndexedBlock`, `merged_slug` and
    `removed_slugs`.

In-app rename must preserve block-reference anchors when rewriting source
targets:

```diff
- [[Old Source#^attention-is-selection]]
+ [[New Source#^attention-is-selection]]
```

### Поведение delete_block

Решение пользователя 11.10.2026: окно удаления открывается сразу и сразу нужного размера, без ожидания и без скачка ширины. Окну хватает индекса, диск проверяется в момент удаления.

1. `prepare_delete_block` строит `DeleteBlockPlan` только из индекса: строка карточки (`get_block`) и для каждой другой заметки её `media_file`, `thumbnail` и тело (`block_queries::list_note_file_mentions`). Заметки с диска не читаются (`build_delete_block_plan_from_index`); читаются только холсты Obsidian (`.canvas`), которых индекс не знает: файл, который показывает холст, используется и к удалению не предлагается, `referenced_by` называет холст его путём от корня (SPEC_DEEP_AUDIT.md, Е5.6; разбор холста в SPEC_MEDIA_ASSET_ACTIONS.md, «Холсты Obsidian»). Медиа карточки, ссылки других заметок и холстов разрешает один `MediaResolver`, поэтому список файлов пространства обходится не больше одного раза. Ссылки заметки разрешаются, только если среди них есть имя одного из файлов карточки (та же сверка имён, что у `media_users_on_disk`).
2. Media refs резолвятся через общий backend resolver (`frontmatter.file`, `thumbnail`, `![[...]]`, `![](...)`, nested/relative/Obsidian basename lookup). Заметка пользуется файлом, если на него указывает любая форма ссылки, которую читает Obsidian (`iter_file_references`, SPEC_AUDIT_FIXES.md, Г1.1).
3. Фронтенд открывает окно, когда пришёл план или ошибка; до этого окна нет. Ширина задаётся сразу: `content`, если в плане есть медиа к удалению, иначе `question`. Закрытое окно хранит свой план до следующего запроса и уходит в той же ширине.
4. `delete_block(..., delete_unused_media=true)` строит план заново (`build_delete_block_plan`): индекс сначала приводится к файлам (`bring_index_up_to_files`, сверка читает только заметки, изменившиеся после прошлой, и не читает заметку, содержимое которой в iCloud: она остаётся фоновому проходу, SPEC_CLOUD_STORAGE.md, Х12), затем план из индекса, затем каждый файл, который индекс считает неиспользуемым, сверяется с заметками на диске и холстами (`media_users_on_disk`). С диска читаются только кандидаты: заметки, у которых в индексе `media_file`, `thumbnail` или ссылка тела содержат имя одного из файлов, и страницы коллекций (`notes_that_may_name`, SPEC_DEEP_AUDIT.md, Н5, Е5.5). Заметка вне кандидатов не читается: выгруженная из iCloud не скачивается, нечитаемая ничего не останавливает. Живой случай 13.10.2026: `mine card delete … --delete-unused-media` на пространстве «Тест» минутами читал чужую выгруженную заметку. Файл, которым пользуется другая заметка (индекс отстал), не удаляется и переходит в shared media. Удаляются `.md` и только оставшиеся unused media. Окно передаёт `offered_media`, пути файлов, которые оно предложило удалить (`unused_media` своего плана), и удаление берёт ровно их (решение пользователя 13.10.2026, SPEC_DEEP_AUDIT.md, Е1.12). Файл, ставший ненужным, пока окно было открыто (заметка, которая им пользовалась, его отпустила), остаётся на месте, его покажет раздел Orphans. Показанный файл, которым за это время стала пользоваться другая заметка, остаётся и попадает в `kept_media`, окно говорит о нём уведомлением `Media kept`. Показанный файл, о котором свежий план уже не знает (карточка перестала на него ссылаться), тоже остаётся. Отказа при этом нет. Без `offered_media` (CLI) удаление идёт по свежему плану.
5. `delete_block` возвращает `DeleteBlockOutcome { removed, kept_media }`. `kept_media` перечисляет медиа карточки, которые остались, потому что ими пользуется другая заметка; список заполняется только при `delete_unused_media=true`.
6. Фронтенд сверяет `kept_media` с файлами, которые окно предлагало удалить (`unused_media` плана окна). Если такой файл остался, лента показывает уведомление `NotificationCard` в правом нижнем углу, как остальные уведомления ленты (DESIGN_SYSTEM.md, «Уведомления»): заголовок `Media kept`, текст `photo.jpg is used by another element and stayed in the space.` для одного файла и `N media files are used by other elements and stayed in the space.` для нескольких. Уведомление закрывается кнопкой и сбрасывается при новом запросе удаления или смене пространства. Файлы, о которых окно уже сказало, что они останутся, в уведомлении не упоминаются.
7. `delete_block(..., delete_unused_media=false)` удаляет только `.md` и derived artifacts.
8. Legacy-вызов без `delete_unused_media` сохраняет старый режим: удаляет `.md` и только slug-owned primary media.
9. Индекс удаляется только после успешного file cleanup; если удаление файлов упало, карточка не получает ложный successful delete.

Проверки: `the_delete_window_plan_comes_from_the_index_alone` и `delete_keeps_a_file_the_stale_index_called_unused_and_names_it` в `commands/blocks.rs`; открытие окна и уведомление в `DeleteBlockDialog.test.tsx` и `App.test.tsx`.

### Поведение batch delete

Решение пользователя 11.10.2026, реализовано 11.10.2026 (PLAN.md, этап 45.7):
групповое удаление ведёт себя как удаление одного элемента. Окно и точки
входа описаны в [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md), «Batch
Delete».

1. Обе команды сводят `slugs` в множество без повторов и проверяют каждое имя
   (`validated_slug_set`); план идёт по алфавиту.
2. `prepare_delete_blocks(slugs)` строит один `DeleteBlocksPlan` только из
   индекса, как `prepare_delete_block`: строки выбранных карточек
   (`indexed_blocks`) и для каждой невыбранной заметки её `media_file`,
   `thumbnail` и тело (`block_queries::list_note_file_mentions` с множеством
   исключаемых имён). Заметки с диска не читаются. Выбранной карточки нет в
   индексе: она не попадает в `slugs` плана, отказа нет.
3. Медиа каждой выбранной карточки собирает тот же сборщик, что у одного
   элемента (`collect_delete_media_for_block`), и они объединяются по пути;
   ссылки разрешает один `MediaResolver` на весь план, с теми же формами
   ссылок, что у одного элемента.
4. `unused_media`: файлы, которыми после удаления всего выделения не
   пользуется ни одна заметка; каждый файл один раз, даже если им пользуются
   несколько выбранных карточек; `referenced_by` называет выбранные карточки.
   `shared_media`: файлы, которыми пользуется хотя бы одна невыбранная
   заметка; `referenced_by` называет её; к удалению они не предлагаются
   никогда.
5. `delete_blocks(..., delete_unused_media=true)` строит план заново
   (`build_delete_blocks_plan`): план из индекса, затем каждый файл, который
   индекс считает неиспользуемым, сверяется с заметками на диске и холстами
   (`media_users_on_disk`, все выбранные `.md` пропускаются). Как у одного
   элемента, индекс сначала приводится к файлам и с диска читаются только
   кандидаты и страницы коллекций (SPEC_DEEP_AUDIT.md, Н5, Е5.5). Файл,
   которым пользуется заметка на диске или холст, переходит в shared media и
   остаётся. Как у
   одного элемента, окно передаёт `offered_media`, и удаление берёт ровно
   показанные окном файлы: файл, которого окно не предлагало, остаётся на
   месте (решение пользователя 13.10.2026, SPEC_DEEP_AUDIT.md, Е1.12).
6. `delete_blocks(..., delete_unused_media=false)` медиа не трогает: план не
   строится, ни одна заметка пространства не читается. Этим же путём
   (`delete_blocks_inner` с одним именем) идёт удаление одного элемента с
   `Keep media`.
7. `.md` выбранных карточек и подходящие медиа уходят в Корзину одной
   `StagedSourceMutation` с подавлением наблюдателя; строки индекса удаляются
   в той же фиксации (`commit_with_index`). Сбой откатывает пакет целиком: ни
   один файл не тронут. После фиксации убираются миниатюры и звук статей
   удалённых карточек.
8. Команда работает вне потока интерфейса (`spawn_blocking`) и отказывает, если
   пространство вкладки сменилось до удаления. После успеха другие вкладки
   пространства узнают об изменении (SPEC_TABS.md, В15).
9. `delete_blocks` возвращает `DeleteBlocksOutcome { removed, kept_media }`:
   `removed` это число удалённых строк индекса, `kept_media` это shared media
   свежего плана, то есть медиа выделения, которыми пользуется заметка вне
   него по индексу или по диску. Список заполняется только при
   `delete_unused_media=true`; окно само выбирает из него предложенные им
   файлы (`keptOfferedMedia`) для уведомления `Media kept`.
10. Фронтенд не выполняет групповое удаление как N вызовов `delete_block`: одна
    команда даёт единый план, медиа без повторов, одно перечитывание и один
    понятный сбой.

Проверки в `commands/blocks.rs`:
`group_plan_offers_media_used_only_inside_the_selection_once`,
`group_delete_with_media_takes_unused_files_and_keeps_shared_ones`,
`group_delete_keeping_media_leaves_every_file`,
`group_delete_keeps_a_file_the_stale_index_called_unused`,
`group_plan_skips_a_card_the_index_no_longer_holds`,
`group_delete_with_media_failure_restores_cards_and_media`; окно в
`DeleteSelectedCardsDialog.test.tsx`, точки входа в `Grid.test.tsx`,
уведомление в `App.test.tsx`.

### Поведение rename_block_file

1. NFC-normalize `new_stem`, удалить опциональное `.md`, провалидировать как safe filename stem
2. Если target имя уже занято — вернуть typed error `NameTaken`
3. Спланировать source-vault rewrite:
   - переименовать `.md` файл блока; без изменений внутри он переносится целиком
   - переименовать Mine-owned rename-family (`old_slug.ext`, `old_slug (image N).*`, `old_slug (video N).*`)
   - переписать ссылки, которые разрешаются в переименованную заметку, включая короткую форму `[[Foo]]` (`NoteMoves`), и file references; правки переносятся в исходный текст (`apply_block_changes`), остальное остаётся байт в байт
   - читать с диска только кандидатов: индекс, приведённый к файлам, называет заметки, в тексте, `Mine Related Notes`, коллекциях, `file` или `thumbnail` которых есть имя переименованной заметки или её медиафайла (`notes_that_may_link`), и все страницы коллекций (SPEC_DEEP_AUDIT.md, Н5, Е5.5); решение о ссылке принимает текст кандидата
4. Временно suppress'ить затрагиваемые paths в `AppState`
5. Записать переписанные `.md`, выполнить file renames, перенести derived artifacts
6. Обновить индекс и эмитить `block:renamed { old_slug, new_slug }`

Boundary:
- `new_stem` is a filename change, not a title edit; in-app rename must not
  synthesize or rewrite `frontmatter.title`, and it must not edit body H1
- если rename меняет speakable article text через отдельный body/H1 edit,
  article-audio invalidируется вместо silent stale migration
- custom media filenames, не совпадающие с Mine naming patterns, не переименовываются
- external rename и in-app rename разделены: rewrite других `.md` происходит только в explicit command path

---

## commands/tags

### Поведение set_blocks_membership

Групповое присоединение и отсоединение (SPEC_DEEP_AUDIT.md, Е6.1,
13.10.2026; SPEC_GROUP_SELECTION.md, «Batch Connect»): все карточки одной
мутацией источников со сверкой прочитанного (`StagedSourceMutation`), строки
индекса в той же фиксации. Повторы имён схлопываются. Карточка, которая уже
такая, как просят, не пишется; карточка, чьего файла нет, пропускается;
присоединение требует страницы коллекции (К7); карточка, которая не может
принять изменение (свойства, которые писатель сломал бы, правка извне после
чтения), отклоняет весь пакет, и ни один файл не записан.

### Поведение add_tag / remove_tag

1. Прочитать `.md` файл и разобрать блок.
2. `add_tag`: проверить, что у коллекции есть страница с `type: channel`
   (поиск `collection_document_for_mutation`, как у переименования и
   удаления). Страницы нет: `CommandError::CollectionNotFound { collection }`,
   ничего не записано. `remove_tag` страницу не проверяет. Решение
   пользователя 10.10.2026,
   [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md), К7
   и К8; реализовано 10.10.2026, PLAN.md, Phase 44.
3. Добавить или убрать одну ссылку в `Mine Collections`
   (`patch_collections_frontmatter`); остальные ссылки, в том числе на имена
   без страницы, остаются на своих местах.
4. Записать файл и переиндексировать блок.

Счётчики коллекций (`TagCount` в `list_taxonomy_snapshot`) есть только у коллекций со страницей (К9).

---

## commands/search

Поиск карточек идёт одной командой `search_grid_blocks`.
Пользовательский Surface Search не должен восстанавливать отдельный Search
frontend или `Cmd+K` command palette:
Search Overlay идёт через `search_grid_blocks` и возвращает `SearchSnapshot`,
не изменяя обычный Grid route. Snapshot содержит `ProjectionRevision`,
независимый `SearchRevision` и opaque pagination cursor. Hybrid Search остаётся
за тем же command boundary: lexical/alias/fuzzy/semantic retrieval и
fusion/rerank реализуются внутри backend SearchEngine, без нового frontend route
или отдельной command palette. Cursor, чей projection/search revision или
query fingerprint устарел, сбрасывается на offset zero.

## Generated IPC contract

- Сериализуемые request/response DTO и ошибки выводятся из Rust через Specta и
  генерируются в committed `src/types/generated.ts`.
- `src/types/index.ts` не дублирует backend shapes вручную; там остаются только
  frontend-owned view/interaction types.
- Generic `CommandError` является generated tagged union (`no_vault |
  internal`), а не строкой. Общий frontend invoke adapter сохраняет прежний
  readable `Error` UX; feature-specific errors bypass adapter normalization и
  сохраняют discriminant.
- `bun run bindings:check` входит в `verify:core` и падает при любом diff, так
  что изменение Rust DTO нельзя отправить без соответствующего TypeScript
  контракта.

---

## Пакетное удаление карточек

Контракт в разделе «Поведение batch delete» выше. До 11.10.2026 здесь была
временная версия: `delete_blocks(slugs: Vec<String>) -> Result<usize,
CommandError>` удаляла только `.md` выбранных карточек одной транзакцией
исходников и индекса и никогда не трогала медиа. Её быстрый путь остался
режимом `delete_unused_media=false`: медиа остаются, ссылки пространства не
разбираются, одиночное удаление с `Keep media` идёт тем же путём.

## commands/channels

`ChannelDto` — сериализуемая версия `Channel` для фронтенда. В DTO нет
отдельного `title`: отображаемое имя коллекции выводится из Markdown
collection ref / имени файла.

Новая коллекция создаётся по сохранённой раскладке `collections`, независимо
от расположения старых коллекций. При переименовании существующего документа
его папка сохраняется. Без страницы переименование отказывает
(`CommandError::CollectionNotFound`), страница побочным действием не
создаётся.

Коллекция существует только как страница (решение пользователя 10.10.2026,
[SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)).
`list_taxonomy_snapshot` отдаёт только страницы. `reorder_channels` пишет `position`
только в существующие страницы: элемент без страницы пропускается, файл не
создаётся (К6). Страницу создают только `create_channel` и явные команды
создания из К5.

`delete_channel` удаляет все найденные Markdown-документы соответствующей
коллекции, включая дубликаты в корне и вложенных папках. Перед удалением
проверяется тип `Channel`: одноимённые обычные карточки не затрагиваются.
Ошибка обхода папок возвращается вызывающему коду, а не скрывает часть файлов.
Фоновое индексирование не восстанавливает документы коллекций из SQLite.
Удаление связей карточек вызывается отдельно от `delete_channel`; эти два
вызова не являются общей атомарной операцией.
