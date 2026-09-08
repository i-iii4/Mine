# Startup Performance Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md) | [SPEC_DISTRIBUTION.md](SPEC_DISTRIBUTION.md)

## Статус

**Архитектура принята и реализована 08.09.2026. Автоматическая и release-
приёмка пройдены; остаётся ручная проверка после перезагрузки macOS.**

Этот документ задаёт один целевой startup-контракт. Release-сборка, уменьшение
бандла, неблокирующее обслуживание клиппера и первый paint из сохранённого
snapshot — части одного решения, а не альтернативные способы ускорения.

## Проблема и измеренный baseline

На исходном проверенном запуске development-сборки процесс Mine был создан в
`08:53:45.760`, а WebKit/window начали полезную работу около `08:53:53.9`.
До frontend bootstrap потеряно примерно **8,2 секунды**. После bootstrap:

- сохранённый путь прочитан сразу;
- local SQLite derived store открыт за **44 мс**;
- asset scope, SQLite и watcher подготовлены за **99 мс** суммарно;
- первые 200 из 604 карточек прочитаны в ту же секунду;
- фоновая сверка закончилась за **56 мс** и не была условием первого snapshot.

Следовательно, Markdown, iCloud vault и SQLite не объясняют наблюдаемое ожидание
больше 10 секунд. Основная пауза находится до WebView/frontend.

Исходный `.app` — `target/debug/bundle/macos/Mine.app`, 306 МБ. Основной
debug-бинарь занимает 114 МБ; рядом попали `mine-cli`, audit и migration
executables. Tauri `.setup` синхронно вызывал `refresh_installed_host`, который
до окна читал и хешировал bundled и installed копии `native-host`, `yt-dlp` и
extension payload. Реализация ниже убрала эту работу из critical path.

## Результат реализации

- release `.app` уменьшен с **306 МБ до 80 МБ**; в `Contents/MacOS` остались
  только `mine` и `native-host`;
- первый экран, snapshot и controls отделены от clipper/freshness maintenance;
- build manifest, installation marker, быстрый metadata-check, фоновая
  integrity-проверка и атомарная замена runtime реализованы;
- в последней серии из 10 запусков отдельного release-процесса shell имел
  p50 **163 мс**, p95 **216 мс**; первые карточки — p50 **472 мс**,
  p95 **584 мс**;
- blocking maintenance до карточек: **0 из 10 запусков**;
- финальная установленная сборка показала карточки за **632 мс**, затем выполнила
  полную установку runtime в фоне за **339 мс**; следующий запуск показал
  карточки за **456 мс** и использовал `fast_registration` за **0 мс**.

Серия выполнялась на реальном Apple Silicon Mac с новым процессом для каждого
запуска, но при текущем состоянии системных кэшей. Проверка после reboot и
полная ручная матрица состояний клиппера остаются отдельной приёмкой.

## Пользовательский контракт

**S1.** Нажатие Mine всегда сначала открывает приложение, а не запускает
обслуживание установленных компонентов.

**S2.** Window chrome и устойчивый каркас интерфейса появляются без белого или
прозрачного окна. Готовый local snapshot публикуется сразу после открытия.

**S3.** Проверка Markdown, watcher catch-up, thumbnails, clipper registration,
helper update, `yt-dlp` update и integrity audit не входят в критический путь
первого интерактивного кадра.

**S4.** Последний корректный snapshot остаётся доступным во время фоновой
сверки. Изменения появляются после новой committed projection revision.

**S5.** Если snapshot отсутствует, Mine всё равно сразу показывает рабочее
окно и честное состояние `Preparing library…` с прогрессом. Полный filesystem
walk не задерживает создание окна.

**S6.** Ошибка фонового обслуживания не закрывает библиотеку и не превращается
в блокирующий startup-dialog. Она показывается типизированным статусом в
Settings; пользовательское действие требуется только когда без него нельзя
восстановить конкретную возможность.

## Архитектура запуска

Запуск разделён на два независимых контура.

### Critical path

```text
process start
  -> single-instance decision
  -> create and show window shell
  -> frontend bootstrap
  -> resolve saved vault identity
  -> open local SQLite snapshot
  -> publish first route snapshot
  -> interactive
```

В critical path разрешены только операции, без которых нельзя показать
сохранённый интерфейс текущего пространства. Они имеют явные deadlines и не
могут неограниченно ждать сеть, iCloud inventory, хеширование больших файлов,
копирование runtime payload или запуск дочернего процесса.

### Maintenance path

После сигнала `first-route-committed` отдельный coordinator запускает:

1. watcher catch-up и bounded freshness pass;
2. проверку версии clipper runtime;
3. атомарное обновление helper, extension payload и `yt-dlp` при необходимости;
4. проверку browser manifests;
5. отложенные preview/thumbnail upgrades;
6. необязательную полную integrity-проверку.

Задачи имеют независимые состояния, таймауты и ошибки. Провал одной задачи не
отменяет остальные и не меняет состояние уже опубликованного snapshot.

## Clipper runtime

### Быстрая проверка версии

Сборка создаёт небольшой immutable manifest:

```text
schema_version
build_profile
app_version
native_host sha256 + bytes
extension tree digest + bytes
ytdlp sha256 + bytes
```

После успешной атомарной установки рядом хранится installation marker с теми же
значениями. Обычный запуск сравнивает manifest и marker, а не перечитывает
байты всех runtime-файлов. Marker не является доказательством целостности: это
решение о необходимости обновления.

Полная проверка фактических байтов допустима:

- в фоне по bounded расписанию;
- по `Repair registration`;
- после повреждённого marker;
- после ошибки запуска helper;
- как release/diagnostic acceptance.

### Атомарное обновление

Каждый изменившийся компонент сначала пишется во временный путь того же
каталога, проверяется по build manifest, получает нужные permissions и только
затем заменяет текущий файл atomic rename. До успешного переключения браузер
продолжает использовать прежнюю совместимую версию.

Неудачное обновление:

- не удаляет рабочую предыдущую версию;
- не блокирует Mine;
- сохраняет typed diagnostic;
- предлагает repair только для затронутого компонента.

Первичная установка также начинается после первого интерактивного кадра.
Отложить `yt-dlp` до первого пользовательского сохранения нельзя: это перенесёт
startup-задержку в критический момент Save. Он устанавливается фоновым
maintenance-pass после запуска или обновления Mine.

## Packaging contract

Обычный пользовательский и performance-acceptance запуск использует production
profile и стабильный установленный `.app`, а не bundle внутри `target/debug`.

GUI bundle содержит только:

- Mine GUI executable;
- обязательные framework/resources;
- versioned clipper runtime payload, необходимый для фоновой установки.

CLI, MCP entrypoint, audit binaries, migration utilities и export tools не
должны попадать рядом с GUI executable автоматически. Если Tauri/Cargo требует
отдельной доставки sidecar, она задаётся явным allowlist. Само уменьшение
бандла не заменяет разделение critical и maintenance paths.

Подпись/notarization остаются production-контрактом `SPEC_DISTRIBUTION.md`.
До публичного распространения внутренний release candidate всё равно должен
проходить startup acceptance; debug build не является эталоном скорости.

## Performance budgets

Все значения относятся к Apple Silicon Mac целевого минимального класса и
проверяются отдельно для cold и warm launch.

| Milestone | Cold p50 | Cold p95 | Warm p95 |
|---|---:|---:|---:|
| Process request → visible window shell | 300 мс | 500 мс | 250 мс |
| Process request → first saved cards | 800 мс | 1 000 мс | 500 мс |
| First saved cards → interactive controls | 100 мс | 200 мс | 100 мс |
| Blocking clipper/scan/thumbnail work before first cards | 0 мс | 0 мс | 0 мс |

Literal zero-time launch не является требованием: macOS должен создать процесс
и WebKit. Требование — устойчиво воспринимаемый мгновенный запуск без пустого
окна и без ожидания фонового обслуживания.

Если target hardware будет определён иначе, числа меняются отдельным решением;
порядок этапов и нулевой blocking-maintenance budget не меняются.

## Observability

Один `launch_id` связывает монотонные timestamps:

- `process_started`;
- `setup_started` / `setup_finished`;
- `window_created` / `window_visible`;
- `frontend_entry`;
- `saved_vault_resolved`;
- `local_snapshot_opened`;
- `first_route_committed`;
- `first_cards_painted`;
- `interactive`;
- начало/конец каждой maintenance-задачи.

Метрики используют monotonic clock для длительностей и wall clock только для
читаемого журнала. Production logging не содержит путь vault, названия карточек
или пользовательский контент. Отсутствующий timestamp считается провалом, а не
нулевой длительностью.

## Acceptance

### Автоматическая

- [x] startup coordinator ждёт два animation frame после первой committed route;
- [x] зависший maintenance promise не задерживает Grid и `interactive`;
- [x] существующий snapshot читается до filesystem freshness work;
- [x] одинаковые build/installation manifests используют быстрый metadata path;
- [x] изменившийся manifest запускает атомарную background update;
- [x] failed replacement не оставляет частично записанный helper;
- [x] production bundle inventory не содержит неразрешённых executables;
- [x] startup trace проверяет порядок milestones и нулевой blocking maintenance.

### Реальная

1. Собрать один release candidate.
2. Установить его в стабильный путь.
3. Выполнить не менее 10 cold launches после прекращения предыдущего процесса;
   отдельно выполнить 10 warm launches.
4. Проверить p50/p95 по instrumentation, а не секундомером или появлению
   process entry.
5. Повторить с установленным и отсутствующим клиппером, outdated helper,
   недоступным браузером, 604-card snapshot и новым пустым пространством.
6. Подтвердить, что ни один clipper/freshness failure не меняет время первого
   сохранённого кадра и доступность Grid.

## План перехода

1. [x] Добавить сквозную instrumentation и снять baseline.
2. [x] Вынести clipper refresh из synchronous Tauri `.setup` за первый paint;
   сохранить ручной `Repair registration`.
3. [x] Ввести build manifest, installation marker и атомарный versioned updater;
   убрать полное хеширование из обычного запуска.
4. [x] Ограничить состав GUI bundle и получить внутренний release artifact.
5. [x] Закрыть автоматическую матрицу и clean-process release acceptance.
6. [ ] Выполнить reboot-cold и оставшуюся ручную clipper-state матрицу.

## Non-goals

- смена Tauri, React, SQLite или Markdown storage;
- отказ от автономного клиппера;
- сохранение скрытого долгоживущего Mine-процесса ради видимости быстрого старта;
- перенос задержки на первое сохранение, первый переход или открытие Settings;
- объявление debug launch эталоном production UX;
- оптимизация frontend без измеренного вклада в critical path.
