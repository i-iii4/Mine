# Distribution, Updates, and Telemetry Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md)

## Status

**Deferred by product decision on 10.07.2026.** Signing, notarization, updater,
release hosting and telemetry are not part of the active architecture plan or
its Definition of Done because the required external capability is currently
unavailable. This document remains the target production contract and must not
be partially implemented with weaker substitutes.

Current development acceptance ends at a locally built debug `Mine.app`.
Distribution work may resume only after an explicit product decision; until
then it is neither a release blocker for the active local-first architecture
phases nor an implied background task.

## Контекст

Mine распространяется как локальное desktop-приложение для macOS. Пользовательские данные находятся в source vault и не зависят от сервера Mine. Сетевая инфраструктура нужна только для доставки приложения, проверки обновлений, приема диагностических отчетов и агрегированной продуктовой телеметрии.

Этот документ задает финальную production-модель, а не временный релизный процесс. Ручная загрузка `.dmg` допустима только как fallback-доставка, но не как основная модель обновлений.

## Стоимостной контракт

Все проектные решения по доставке, обновлениям, диагностике и продуктовой аналитике должны использовать бесплатное программное обеспечение и self-hosted инфраструктуру. Платные SaaS-сервисы не являются частью целевого решения.

Единственное обязательное внешнее платное ограничение — Apple Developer Program. Для нормального публичного распространения macOS-приложения вне Mac App Store требуется Developer ID certificate и notarization. Это не заменяется бесплатным техническим решением без ухудшения пользовательского запуска через Gatekeeper.

Если в конкретный момент нет собственного сервера для telemetry backend, сбор диагностики и продуктовой информации отключается. Отсутствие telemetry backend не должно ухудшать core-функциональность приложения.

## Цели

- Пользователь скачивает приложение один раз, после этого Mine безопасно обновляется автоматически.
- Приложение запускается на стандартном macOS без инструкций по обходу Gatekeeper.
- Release pipeline воспроизводим, проверяем и не зависит от ручного изменения артефактов.
- Обновление не может повредить source vault.
- Диагностика помогает исправлять ошибки без доступа к содержимому vault.
- Продуктовая аналитика отвечает на вопросы развития продукта без сбора пользовательского контента.
- Все сетевые действия прозрачны пользователю и управляются настройками.

## Non-goals

- Mac App Store как основной канал распространения.
- Платные update servers, paid crash reporting, paid analytics, paid CDN.
- Сбор session replay, screen recording, heatmaps, full logs, raw queries или контента vault.
- Использование telemetry как зависимости для core-функций приложения.

## Канонические решения

### D1. Канал распространения

Mine распространяется напрямую: публичная download page плюс versioned release artifacts. Mac App Store не является целевым production-каналом, потому что он меняет модель контроля, review, sandboxing и обновлений.

Целевое бесплатное решение:

- публичный repository `mine-releases` только для релизных артефактов, manifests и download page;
- GitHub Releases для immutable versioned artifacts;
- GitHub Pages для static download page, updater manifests и release policy;
- основной исходный repository может оставаться private.

Каждый публичный релиз получает immutable tag. Уже опубликованный artifact не заменяется новым файлом с тем же version. Исправление публикуется только как новая версия.

### D2. Подпись macOS

Каждая public macOS-сборка подписывается Developer ID Application certificate и отправляется на Apple notarization.

Обязательные шаги:

1. Build `.app`.
2. Подписать все nested binaries, helpers, frameworks и main app bundle.
3. Включить Hardened Runtime.
4. Использовать минимальный набор entitlements.
5. Собрать `.dmg`.
6. Подписать `.dmg`, если выбран signed disk image contract.
7. Отправить artifact в Apple notary service через `xcrun notarytool`.
8. Выполнить stapling через `xcrun stapler`.
9. Проверить подпись, notarization ticket и запуск на Gatekeeper-enabled macOS.

Acceptance checks:

```bash
codesign --verify --deep --strict --verbose=2 Mine.app
spctl --assess --type execute --verbose Mine.app
xcrun stapler validate Mine.app
spctl --assess --type open --context context:primary-signature --verbose Mine.dmg
```

Developer ID certificate и Tauri updater signing key — разные ключи с разными назначениями. Apple certificate отвечает за доверие macOS. Updater key отвечает за доверие клиента к downloaded update bundle.

### D3. Release pipeline

Release pipeline должен быть автоматизирован одной командой или одним CI workflow. Допустимые бесплатные исполнители:

- локальный Mac с Xcode и Tauri CLI;
- self-hosted runner на собственном Mac;
- public GitHub Actions runner только если repository и условия usage позволяют бесплатное выполнение.

Pipeline:

1. Проверить clean git state release branch.
2. Проверить version bump и changelog.
3. Выполнить `bun install --frozen-lockfile`.
4. Выполнить `bun run verify`.
5. Выполнить Rust checks, включая `cargo clippy`.
6. Собрать app через Tauri.
7. Подписать macOS artifacts.
8. Выполнить notarization и stapling.
9. Сгенерировать updater artifacts и `.sig`.
10. Сгенерировать `checksums.txt`.
11. Сгенерировать `latest.json` для каждого канала.
12. Сгенерировать release notes.
13. Загрузить artifacts в GitHub Releases.
14. Опубликовать static manifests через GitHub Pages.
15. Выполнить post-publish smoke checks.

Secrets никогда не хранятся в repository. Developer ID private key хранится в macOS Keychain или CI secret store. Tauri updater private key хранится отдельно от Apple signing identity.

### D4. Packaging contract

Public macOS artifacts:

- `.dmg` для ручной установки;
- updater bundle для `tauri-plugin-updater`;
- detached updater signature `.sig`;
- `checksums.txt` с SHA-256 для всех downloadable artifacts;
- `latest.json` per channel;
- release notes в Markdown.

Архитектуры:

- `darwin-aarch64` обязателен;
- `darwin-x86_64` обязателен до явного снятия поддержки Intel Mac;
- universal build допустим только если verification доказывает корректную подпись, notarization и updater compatibility.

### D5. Обновления

Mine использует `tauri-plugin-updater` как единственный production-updater.

Обязательные свойства:

- update endpoints работают только по HTTPS;
- updater artifacts создаются сборщиком Tauri;
- каждый update bundle подписан updater private key;
- app содержит только updater public key;
- manifest содержит version, pub_date, notes, platform URL и signature;
- app проверяет signature до установки;
- app поддерживает manual `Check for Updates`;
- app поддерживает automatic update check, если пользователь не отключил его в настройках;
- update UI показывает release notes, progress, failure state и restart-to-install action.

Static manifest layout:

```text
https://releases.example/mine/stable/latest.json
https://releases.example/mine/beta/latest.json
https://releases.example/mine/policy.json
```

Dynamic update server не требуется для production. Staged rollout, blocked versions и kill switches задаются static `policy.json`.

### D6. Release channels

Обязательные каналы:

- `stable` — публичный канал по умолчанию;
- `beta` — публичный канал для пользователей, явно выбравших ранние релизы;
- `internal` — канал для локальной проверки release candidates до public publish.

Переход между каналами — явное пользовательское действие. Приложение не переводит пользователя с `stable` на `beta` автоматически.

### D7. Release policy

`policy.json` — static control plane для updater и telemetry.

Минимальный контракт:

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-22T00:00:00Z",
  "channels": {
    "stable": {
      "manifest_url": "https://releases.example/mine/stable/latest.json",
      "min_supported_version": "1.0.0",
      "rollout_percent": 100,
      "blocked_versions": []
    },
    "beta": {
      "manifest_url": "https://releases.example/mine/beta/latest.json",
      "min_supported_version": "1.0.0",
      "rollout_percent": 100,
      "blocked_versions": []
    }
  },
  "telemetry": {
    "enabled": true,
    "ingest_url": "https://telemetry.example/v1/events"
  },
  "crash_reporting": {
    "enabled": true,
    "dsn": "https://glitchtip.example/api/0/projects/mine"
  }
}
```

Policy parser должен быть strict по schema version и tolerant к неизвестным future fields. Если policy недоступен или невалиден, app продолжает работать и использует последний валидный cached policy только для non-dangerous settings. Невалидный policy не может включить сбор данных, если пользователь не давал согласие.

### D8. Update recovery

Update failure не должен повреждать source vault и не должен блокировать запуск текущей установленной версии.

Требования:

- update download хранится во временной директории до полной проверки signature;
- partial download удаляется или перезаписывается при следующей попытке;
- failed install показывает typed error и recovery action;
- corrupt manifest, invalid signature и network failure тестируются отдельно;
- app умеет пересобрать derived state после update;
- schema migration не изменяет source vault без отдельного idempotent migration contract;
- downgrade не выполняется автоматически, если текущая версия уже применяла несовместимую migration.

## Диагностика

### D9. Crash and error reporting

Целевое бесплатное решение — self-hosted GlitchTip с Sentry-compatible SDK endpoint. Допустима собственная реализация ingest endpoint, если она сохраняет тот же privacy contract и grouping quality.

Собирается:

- app version;
- release channel;
- OS family and major version;
- CPU architecture;
- typed error code;
- stack trace после scrubbing;
- Tauri command name;
- component name;
- timestamp;
- random resettable install ID, если пользователь включил diagnostics.

Запрещено собирать:

- absolute или relative file paths;
- filenames;
- vault path;
- note titles;
- Markdown body;
- media metadata, раскрывающую пользовательский контент;
- URLs из сохраненных блоков;
- collection names;
- tag names;
- search queries;
- clipboard contents;
- screenshots или screen recordings.

Frontend source maps и native debug symbols могут загружаться только в private diagnostics backend. Они не публикуются в release artifacts.

### D10. Local diagnostics

Mine ведет локальные rotating logs в derived app data, а не в source vault.

Логируются:

- lifecycle events;
- version and build;
- command names;
- typed error codes;
- duration buckets;
- update check result;
- index rebuild status;
- thumbnail/audio pipeline status.

Не логируются пользовательские пути, имена файлов, URL, текст, query strings и collection/tag names.

UI обязан иметь:

- `Export Diagnostics`;
- `Send Diagnostics`;
- preview payload перед отправкой;
- `Delete Local Diagnostic Logs`.

Manual diagnostic export должен работать без telemetry consent, потому что пользователь сам инициирует экспорт.

## Продуктовая информация

### D11. Product analytics backend

Целевое бесплатное решение — собственный typed telemetry endpoint и open-source analytical store.

Рекомендуемый стек:

- Rust HTTP ingest service;
- ClickHouse для event storage;
- Grafana или Metabase для dashboards;
- OpenTelemetry Collector только для технических traces/metrics backend-side, не как канал сбора пользовательского контента.

Допустим self-hosted PostHog только как replaceable dashboard layer. Канонический контракт событий находится в коде Mine, а не в UI внешнего analytics-продукта.

### D12. Telemetry consent

Product telemetry выключена до явного согласия пользователя. Crash reports могут отправляться автоматически только после включения `Send crash reports`.

Настройки:

- `Check for updates automatically`;
- `Send crash reports`;
- `Share anonymous product diagnostics`;
- `Reset telemetry ID`;
- `Show last telemetry payload`;
- `Delete queued telemetry`.

Автоматическая проверка обновлений не является product analytics. Она отправляет только данные, необходимые updater contract: current version, target, architecture и channel.

### D13. Event contract

Все telemetry events определяются как typed enum. Свободные string events запрещены.

Разрешенные поля:

- event schema version;
- event name из enum;
- event ID;
- timestamp;
- app version;
- release channel;
- OS major version;
- architecture;
- locale language code без региона, если нужна локализация продукта;
- install ID, если пользователь включил telemetry;
- coarse duration bucket;
- count bucket;
- boolean flags из allowlist.

Разрешенные события первой версии:

- `app_opened`;
- `vault_selected`;
- `vault_index_started`;
- `vault_index_completed`;
- `vault_index_failed`;
- `block_created`;
- `block_deleted`;
- `clip_saved`;
- `search_performed`;
- `detail_opened`;
- `audio_generated`;
- `update_check_completed`;
- `update_install_completed`;
- `update_install_failed`;
- `diagnostics_exported`;
- `telemetry_consent_changed`.

`search_performed` не содержит query. Допустимые поля: route kind, result count bucket, latency bucket, retrieval mode и failure code.

`clip_saved` не содержит URL, domain, title, page text или source app. Допустимые поля: clip type, success/failure code, duration bucket.

### D14. Telemetry queue

Telemetry queue хранится локально в derived app data.

Требования:

- bounded size;
- exponential backoff;
- batch upload;
- retry только для transient network errors;
- deletion при выключении telemetry;
- no blocking UI;
- no writes to source vault;
- no payload upload after kill switch.

### D15. Retention

Server-side retention:

- raw product events — 90 дней максимум;
- crash/error reports — 90 дней максимум;
- aggregated metrics — допускаются дольше, если из них нельзя восстановить user-level event stream;
- install ID deletion supported через reset/delete request.

Local retention:

- local logs — bounded rotating files;
- queued telemetry — удаляется после успешной отправки или истечения retention window;
- local diagnostic export — создается только по запросу пользователя.

## Privacy and Network Contract

Mine должен работать offline. Отсутствие сети влияет только на update checks, release policy fetch, telemetry upload и crash report upload.

Network surfaces:

- updater manifest fetch;
- update artifact download;
- release policy fetch;
- crash report upload;
- telemetry batch upload;
- manual diagnostics upload.

Никакой network surface не может читать source vault напрямую. Перед отправкой payload проходит scrubber и allowlist validator. Validator должен быть покрыт тестами на запрещенные поля.

## Security Contract

- Release artifacts подписаны Apple Developer ID и Tauri updater key.
- Release artifacts имеют SHA-256 checksums.
- Private keys не хранятся в repository.
- GitHub release repository имеет минимальный набор maintainers.
- Release publishing требует protected branch/tag rules.
- `latest.json` и `policy.json` обновляются только release pipeline.
- Client rejects invalid signatures.
- Client rejects unsupported schema versions.
- Client treats network JSON as untrusted input.

## Verification Matrix

Перед public release обязательно проверить:

- clean install на Gatekeeper-enabled macOS;
- launch after first download from browser;
- `spctl` assessment для `.app` и `.dmg`;
- stapler validation;
- update from previous stable;
- update from previous beta;
- invalid updater signature;
- corrupt `latest.json`;
- unavailable release policy;
- blocked version policy;
- telemetry disabled;
- telemetry enabled;
- telemetry kill switch;
- local diagnostic export;
- crash report scrubbing;
- no forbidden payload fields;
- index rebuild after update;
- no source vault mutation during update.

## Rejected Alternatives

| Alternative | Decision | Reason |
|---|---|---|
| Unsigned `.app` or unsigned `.dmg` | Rejected | Breaks normal Gatekeeper UX and violates production distribution contract. |
| Manual download as primary updates | Rejected | User has to track versions and reinstall manually. |
| Mac App Store as primary channel | Rejected | Adds App Review, sandboxing and store policy as core distribution dependencies. |
| Paid update service | Rejected | Violates free-solution constraint. |
| Paid crash reporting SaaS | Rejected | Violates free-solution constraint and moves diagnostic data to third party by default. |
| Paid product analytics SaaS | Rejected | Violates free-solution constraint and weakens local-first trust. |
| Session replay or screen recording | Rejected | Incompatible with local-first privacy posture. |
| Sparkle updater | Rejected for current stack | Good macOS updater, but Tauri already provides a native updater contract integrated with app bundling and cross-platform manifests. |

## Source References

- Apple Developer Program: <https://developer.apple.com/programs/enroll/>
- Apple Developer ID: <https://developer.apple.com/support/developer-id/>
- Apple distribution outside Mac App Store: <https://help.apple.com/xcode/mac/current/en.lproj/dev033e997ca.html>
- Apple notarization and stapling: <https://developer.apple.com/developer-id/>
- Tauri updater: <https://v2.tauri.app/plugin/updater/>
- GitHub Releases: <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>
- GitHub Pages: <https://docs.github.com/en/pages>
- GlitchTip: <https://glitchtip.com/>
- OpenTelemetry Collector: <https://opentelemetry.io/docs/collector/>
