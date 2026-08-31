# Общее ядро сохранения: реализация и приёмка

Дата: 31.08.2026. База переноса: `a7a4d61`.
Контракт: [SPEC_SAVE_CORE](../SPEC_SAVE_CORE.md). План: [SC0–SC7](../PLAN.md#save-core-plan).

Код перенесён; отсутствие реальной приёмки Dia/Chrome не скрыто статусом DONE.
Системный диалог не автоматизируется и не блокирует программирование по
указанию пользователя. Проверки записи используют одноразовые vault.
Native-shell smoke читает настроенный путь через IPC, не сохраняет туда данные
и не меняет регистрацию браузера.

## Реализовано

| Срез | Владелец / результат |
|---|---|
| SC1 | `mine-core/src/domain` — единственные pure document rules; прежний Rust domain переэкспортирует их |
| SC1 | `mine-core/src/save.rs` — capture, input intent, имена, layout facts, типизированные переходы публикации и recovery; native и настоящий WASM |
| SC2 | Native journal вне derived cache: `parent(derived_root)/operations/v1/<binding>`; межпроцессная блокировка, durable receipt, конфликт fingerprint, неизвестный исход без удаления данных |
| SC2 | Source commit без обязательного SQLite; точные относительные media refs, layout marker и pinned time; прежние media/security ограничения |
| SC2 | Подготовка медиа и Markdown в journal-owned staging; полный план с target/hash/size фиксируется до публикации в source. Prepared plan продолжается без повторной загрузки |
| SC2 | Раскладка входит в durable plan; marker закрепляется до первого артефакта. Повторное подключение не превращает новую стандартную папку в плоскую |
| SC3 | WASM в worker; в JS только browser IO, очередь, IndexedDB и отображение результатов; удалены JS serializer/slug/collection copies |
| SC3 | IndexedDB `mine-standalone`, версия 2: `vault`, `bindings`, `operations`; Blob и подготовленный Markdown переживают worker restart, receipt не удаляется по возрасту |
| SC4 | Setup в extension-origin окне, возврат к черновику, regrant исходной папки, отдельные связь/совместимость/папка, стабильный dev ID |
| SC4 | Pin до отправки; потеря ответа вызывает lookup того же ID. Восстановление старого клипа не выдаётся за сохранение нового с тем же URL |
| SC4 | Необязательный ACK успешного handshake сохраняет одну историческую отметку вне vault; Settings показывает время/версию, не выдавая историю за текущую связь |
| SC5 | Desktop/CLI конструируют через `build_capture`; прежние rollback, dry-run и ограничения доступа сохранены. FFI использует shared parser без новых iOS API |
| SC7 | WASM включён в сборку/архив расширения и генерируемые Safari resources; CI сравнивает фактические native/WASM ответы; документы обновлены |

`CaptureIntent` сохраняет различия существующего ввода: web clip требует
извлечённый текст/медиа; desktop сохраняет вставленное тело; явный CLI title
становится заголовком текстовой заметки. Это вход общего правила, не три
форматтера. Capture с operation ID и desktop mutation-транзакция — разные
границы над одними правилами; rollback desktop/CLI не отменён ради унификации.

Удалён устаревший дублирующий `Resources/install-native-host.sh` из Safari;
его прежняя версия остаётся в Git. Сборка очищает только генерируемый
`extension/dist`, поэтому архив не накапливает старые JS-пакеты.

## Автоматические доказательства

| Проверка | Команда / результат |
|---|---|
| Совпадение Rust/WASM | `bun run test:save-core`: 19 одинаковых fixtures, точные JSON/Markdown/ошибки |
| Чистое ядро | `cargo +1.88.0 test -p mine-core --locked`: 197 тестов; native/no-default/WASM не зависят от Tauri/SQLite |
| Browser adapter | `standaloneVault.test.ts` + `standaloneVault.recovery.test.ts`: 26 тестов с actual WASM; подменён только IO |
| Worker bootstrap | `mineCore.test.ts`: 3 теста настоящих generated JS/WASM; lexical binding, единая загрузка, повтор после сбоя |
| Собранное расширение | `bun run test:clipper-worker`: настоящий classic worker, CSP и 19 fixtures в отдельном headless Chromium |
| Настоящая кнопка Save | Тот же smoke открывает packaged React popup, передаёт extracted article через существующий preloaded entry point и нажимает Save; проверяет Markdown и очистку pending pin. Генерация запроса, время, messaging, WASM и запись — настоящие |
| Browser persistence | Тот же worker smoke: настоящий IDB хранит directory handle/Blob, два полных перезапуска Chromium, resume без повторной загрузки медиа, один файл и прежний committed receipt после второго перезапуска. Использован OPFS, не выбранная системная папка |
| Native SC2 | 37 targeted tests: no-clobber, полный план до media, каждый media intent, partial publication, restart, fsync-warning, cleanup, journal/index separation, canonical layout/refs, binding, terminal name conflict и два Save с повторным resolver |
| Native host | 82 теста |
| Native storage | 364 теста |
| Регистрация helper | 10 тестов; exact allowlist, checksum, atomic binary replacement, реальная структура `Resources/binaries/yt-dlp` и legacy fallback |
| Подтверждение связи | 6 Rust-тестов app-local записи, 6 тестов browser ACK и 3 теста Settings; read-only проверки не пишут |
| Клиенты | Desktop blocks 44, CLI 29, MCP 6, FFI parser 2 — проходят без изменения действующих guards |
| Общий frontend | `bun run test:frontend` — 1062 теста в 128 файлах, все проходят |
| Общий Rust | `cargo test --workspace --all-targets --locked` — проходит: 639 main lib, 82 native host, 197 core, 2 FFI и тесты вспомогательных binaries |
| MSRV | `cargo +1.88.0 check --workspace --all-targets --locked` — проходит |
| iOS bridge | `cargo check -p mine-ffi --lib --target aarch64-apple-ios --locked` — проходит |
| Release gate | `bun run verify:release` — exit 0: parity, bindings, lint, build, все unit tests, пять browser audits, реальный extension worker с двумя перезапусками и собранная `.app` через WKWebView/Tauri IPC |

Browser adapter tests не являются испытанием настоящего OS-directory handle.
Fixtures проверяют настоящий WASM в Node runtime, не имитацию Rust в JS.
Нативные аварии проверяются точками отказа и реконструкцией состояния, не
выключением питания. GitHub Actions добавлен; запуск на GitHub отдельно от
локальной проверки.

### Настоящий native-messaging процесс — 31.08.2026

`bun run test:native-capture` — **PASS, 3/3 сценария**. Скрипт использует
уже собранные `native-host` и `cold-space-audit` из `.app`, без окна Mine.

| Состояние индекса | Материал | Проверенный результат |
|---|---|---|
| Отсутствует | Статья | Markdown записан; lookup и replay новыми процессами возвращают прежний commit |
| Настоящий SQLite `BEGIN IMMEDIATE` в другом процессе | Ссылка | Чтение индекса отвергнуто из-за lock, но source save и повтор проходят; контрольная строка индекса сохранена |
| `user_version = 2147483647` | Изображение | Несовместимость индекса подтверждена; Markdown и точные PNG-байты записаны; версия индекса не понижена |

Для каждого сценария обычный scanner дважды строит свежие производные данные:
ровно одна карточка нужного типа, стабильное повторное чтение и неизменные
исходники. Это проверка проекции, не видимого интерфейса; потеря ответа или
выключение питания здесь не инжектируются.

Стенд создаёт только новые тестовые vault в `output/playwright/` и уникальные
каталоги индекса/журнала в штатном Mine app-data: production helper не имеет
переопределения этого корня. `HOME`, config, установленный helper, регистрация
и существующие vault не меняются. Поэтому это отдельная явная команда,
не скрытое дополнение `verify:release`. Проверен Node 22.23.1 с `node:sqlite`
и готовой macOS debug `.app`; JSON-отчёты и тестовые материалы сохраняются.
Проверенный запуск: `output/playwright/native-capture-oX8Grj/report.json`.

## Границы, которые нельзя выдать за исправленные

| Граница | Реальное поведение |
|---|---|
| Browser external writer | FSA не даёт atomic create-if-absent; очередь защищает записи расширения, не Finder/Obsidian/другие процессы. `atomic_no_clobber:false`, `durable_flush:false` |
| Browser до source effects | Известный конфликт даёт durable terminal rejection; явный следующий Save выбирает свободное имя. Материал rejected операции сохранён |
| Browser после intent | Пропажа/изменение опубликованного media/Markdown даёт unknown; нет слепой перезаписи или автоматического второго сохранения |
| Native layout initialization | Marker из durable plan создаётся no-clobber до media/Markdown; повреждённый, изменённый или symlink marker не перезаписывается. Resume использует snapshot, не повторное угадывание раскладки |
| Native legacy preparation | Старый `Preparing` мог уже изменить source; recovery оставляет unknown. Новая подготовка `StagingV2` идёт вне source; её прерывание даёт terminal not_committed, сохраняя request и материал |
| Native planned publication | `PlannedV2` хранит весь план до первого media effect; подтверждённый подготовленный план можно продолжить. Частичная/неподтверждённая публикация остаётся unknown, без перезаписи файлов |
| Native до source effects | Занятый target в Prepared даёт durable terminal not_committed; lookup/replay сохраняют этот исход, request и staging остаются. Только явный новый Save выбирает другое имя |
| Native post-publication fsync | При известных полных MD/media и доступном journal возвращается committed с durability warning; staging/request/pending upload не удаляются. Если байты или receipt подтвердить нельзя, результат unknown |
| Native legacy staging | Manifest без проверенной folder binding не объявляется мусором/успехом. Legacy bare upload копируется create-new; оригинал не удаляется без доказательства владения |
| FSA layout initialization | Marker фиксируется до создания role directories; битый marker не скрывается fallback-раскладкой |
| Позднее изменение карточки | Durable committed receipt остаётся фактом завершения; replay не отменяет пользовательские правки и не восстанавливает удалённую карточку |

## Открытая реальная приёмка SC6

Проверить в отдельных профилях Chrome и Dia с собранной папкой `extension/`
и `.app`; каждую строку подтверждают реальные файлы и карточки, не только UI.

1. Без host: из оверлея открыть setup, выбрать одноразовую папку, сохранить
   ссылку, статью, изображение и screenshot. Отменить выбор и повторить.
2. Отозвать разрешение после начала операции; восстановить именно исходную
   папку. Сменить текущую папку — незавершённая операция не переезжает.
3. Оба порядка установки: расширение → Mine и Mine → расширение; после
   первого запуска приложение регистрирует helper без ручного ID.
4. Закрыть Mine и сохранить; отключить/сломать host — сообщение о связи,
   не утверждение об отсутствии приложения и не скрытый fallback.
5. Потерять ответ/остановить worker в живом расширении, проверить повтор по
   тому же ID. Выполнить B1–B3 из [SC0-проб](sc0-save-safety.md).
6. Открыть ту же папку в Mine, проверить реальные Markdown/медиа и отображение;
   повторить с удалённым/занятым/несовместимым индексом. Запись и последующая
   scanner-проекция уже проверены `test:native-capture`; видимый интерфейс
   и связка с браузером остаются отдельной приёмкой.

Без этих результатов SC6 и весь SC0–SC7 не закрываются. Публичный Web Store
ID, подпись/notarization и Safari rollout остаются вне текущего решения.

## Установка текущей сборки

`bun run build:extension` собирает JS и WASM; `bun run pack:extension`
создаёт `build/mine-clipper.zip`. Dev ID — `eioalidaccoahofcggkbinalibpajokh`.
Приложение регистрирует bundled host при обычном запуске;
`bun run clipper:install-host` предназначен для developer-установки.

Старый unpacked ID означает другой browser origin. Его IDB/незавершённые
операции не мигрируют автоматически. **Не удалять старое расширение с
неизвестным исходом**, пока исход и сохранённый материал не установлены.
Граница стоит **до первого запуска новой `.app`, Repair registration или
`clipper:install-host`**: они заменяют allowlist и закрывают новые подключения
старого origin. При unknown сохранить также прежние host и регистрацию.
Существующий открытый порт не гарантирует восстановление. Это контролируемый
dev-переход, не автоматическая миграция реальных пользователей.
Обычный reload не является доказательством смены ID или прохождения приёмки.

Native-shell smoke не регистрирует диагностический helper в пользовательском
браузере. Сборка и тестирование не означают обновление `/Applications/Mine.app`
или установленного расширения.

### Проверка установленного helper — 31.08.2026

Прямой `get_status` через настоящий native-messaging процесс подтверждает:
установленный helper объявляет только `pending_uploads_v1`, собранный — также
`save_operation_v1`, `operation_lookup_v1`, `open_app_v1` и
`connection_check_v1`. У обоих `version: 0.1.0` и `host_api_version: 2`,
поэтому совпадение номера версии не доказывает актуальность возможностей.
Проверка использовала отсутствующий тестовый путь, без сохранений.

Регистрация Dia пока разрешает только старый origin
`mphibgcoipknogccbbjoolkjfglmillm`. Состояние его незавершённых сохранений
ещё не установлено; helper и регистрация не переключены. Доступный Browser
инструмент не подключён к Dia и блокирует управление расширениями Chrome.
Этот барьер не обходится другим UI-инструментом или прямой правкой профиля.
Для финального переключения нужна проверка старых сохранений пользователем
и ручное подключение подготовленной папки `extension/` в Dia.
