# Article Audio Specification

Related documents: [PRINCIPLES.md](PRINCIPLES.md) | [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_DISPLAY_TITLE.md](SPEC_DISPLAY_TITLE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_MOBILE.md](SPEC_MOBILE.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md)

## Goal

Добавить production-grade `Listen` pipeline для статей без авто-генерации по умолчанию:

- аудио создаётся только по явному действию пользователя;
- аудио хранится как local derived artifact per device;
- desktop и iOS используют один и тот же Rust speech-prep contract;
- повторное действие пользователя удаляет локальную аудиоверсию;
- playback ведёт себя как обычный компактный article control, а не как accessibility debug-tool.

## Scope

v1 поддерживает только `article` blocks.

Не входят в scope:

- `video`, `social`, `link`, playlists;
- batch generation;
- speed chooser;
- seek bar;
- voice picker;
- auto-delete прослушанных статей;
- общий cross-device sync audio assets.

## Product contract

### Manual lifecycle

- `article` по умолчанию не имеет audio artifact.
- Первое нажатие `Create Audio` создаёт локальную аудиоверсию.
- После успешной генерации появляются:
  - `Remove Audio`
  - `Play / Pause`
- `Remove Audio` удаляет локальный audio artifact и local playback state.

### Placement

#### Desktop

- блок `AUDIO` рендерится в fixed metadata rail в `Detail`
- секция стоит выше `RESOLUTION / FILENAME / DATE`

#### iOS

- compact `AudioSection` рендерится сразу под body H1/display title + author
- секция стоит перед body статьи

### Playback expectations

- закрытие `Detail` или уход на другой block останавливает playback;
- текущая позиция сохраняется локально;
- повторное открытие статьи продолжает playback с `last_position_ms`;
- завершённое playback сохраняет `completed_at` и сбрасывает позицию на начало.

## Shared data contract

### `PreparedArticleSpeech`

Единый Rust-side preparation result для desktop и iOS:

```rust
pub struct PreparedArticleSpeech {
    pub speakable_text: String,
    pub text_hash: String,
    pub language_tag: Option<String>,
}
```

Инварианты:

- `speakable_text` уже очищен от markdown noise;
- `text_hash` вычисляется по уже очищенному speech text;
- `language_tag` best-effort и используется для выбора системного голоса.

### `ArticleAudioState`

Shared product state:

```ts
type ArticleAudioState = {
  status: "absent" | "ready";
  audio_path: string | null;
  duration_ms: number | null;
  last_position_ms: number;
  completed_at: string | null;
};
```

Инварианты:

- `absent` не имеет `audio_path`
- `ready` обязан иметь существующий local audio file
- missing file при existing sidecar self-heals обратно в `absent`

### `ArticleAudioUpdateEvent`

Desktop event contract:

```ts
type ArticleAudioUpdateEvent = {
  slug: string;
};
```

Событие эмитится после:

- generate
- delete
- source edit invalidation
- block deletion cleanup

Событие не эмитится на каждый playback position update.

### `ArticleAudioGateway`

React UI работает через injected gateway contract, а не через прямые platform APIs:

```ts
type ArticleAudioGateway = {
  getState(slug: string): Promise<ArticleAudioState>;
  generate(slug: string): Promise<ArticleAudioState>;
  remove(slug: string): Promise<void>;
  setPosition(
    slug: string,
    positionMs: number,
    durationMs: number | null,
    completed: boolean,
  ): Promise<void>;
  resolvePlaybackSource(
    state: ArticleAudioState,
  ): { url: string } | null;
  subscribe(
    onUpdated: (event: ArticleAudioUpdateEvent) => void,
  ): Promise<() => void>;
};
```

Инварианты:

- UI не знает о Tauri IPC, asset protocol или native helper lifecycle;
- adapter layer отвечает за transport-specific state refresh и playback source resolution;
- смена platform adapter не требует переписывания `ArticleAudioControls`.

## Speech preparation rules

`PreparedArticleSpeech` готовится только в Rust.

### Inputs

- first body H1/display title (legacy `frontmatter.title` is fallback only)
- `author`
- prose body статьи

### Exclusions

Из speech text вырезаются:

- изображения
- markdown links URL-part
- raw URLs
- code fences
- inline code
- markdown tables
- horizontal rules
- лишняя markdown punctuation

### Unsupported article kinds

Даже если block type формально `article`, v1 не synthesizes article-audio для article-like social clips:

- X / Twitter status URLs
- Instagram post / reel / story URLs

Они считаются unsupported article kinds и возвращают typed error.

## Storage contract

### Desktop derived artifacts

Desktop хранит audio artifacts в per-vault local derived store:

```text
~/Library/Application Support/com.mine.app/vaults/<vault-id>/cache/audio/
  <slug>.json
  <slug>.wav
```

`<slug>.json` хранит:

- `format_version`
- `generation_backend`
- `voice_id`
- `voice_name`
- `text_hash`
- `audio_file_name`
- `duration_ms`
- `last_position_ms`
- `completed_at`

### iOS local artifacts

iOS хранит audio artifacts в app-local storage, keyed by hashed vault path:

```text
Application Support/Mine/ArticleAudio/<vault-hash>/
  <slug>.json
  <slug>.caf
```

### Freshness

Audio freshness определяется только через `text_hash`.

Если `PreparedArticleSpeech.text_hash` больше не совпадает с sidecar state:

- audio artifact invalidates;
- audio file удаляется;
- sidecar удаляется;
- state становится `absent`.

## Desktop contract

### Tauri commands

```ts
get_article_audio_state(slug)
generate_article_audio(slug)
delete_article_audio(slug)
set_article_audio_position(slug, position_ms, duration_ms, completed)
```

### Generation backend

- generation живёт в backend command layer;
- synthesis использует native macOS speech helper на `AVSpeechSynthesizer.write`;
- helper пишет финальный `.wav` (`44.1 kHz`, mono PCM);
- helper не ресэмплит speech callbacks по одному; он сначала буферизует непрерывный source PCM и затем делает single-pass conversion в финальный `.wav`, чтобы избежать audible distortion на границах чанков;
- UI не знает о native helper lifecycle и получает только typed state/result.

Internal helper contract:

```ts
type DesktopArticleAudioHelperRequest = {
  text: string;
  language_tag: string | null;
  preferred_voice_id: string | null;
  output_path: string;
};

type DesktopArticleAudioHelperResponse = {
  duration_ms: number;
  resolved_voice_id: string;
  resolved_voice_name: string;
};
```

### Desktop voice defaults

Desktop backend хранит persisted voice defaults в app config:

```json
{
  "article_audio": {
    "apple_voice_overrides": {
      "en-US": "com.apple.voice.compact.en-US.Samantha",
      "en-GB": "com.apple.voice.compact.en-GB.Daniel",
      "ru-RU": "com.apple.voice.compact.ru-RU.Milena"
    }
  }
}
```

Resolution order:

1. exact `apple_voice_overrides[language_tag]`
2. curated defaults for `en-US`, `en-GB`, `ru-RU`
3. first installed Apple voice for exact language
4. first installed Apple voice for language prefix
5. system default voice

Изменение config не инвалидирует уже сгенерированные audio artifacts. Новая voice policy применяется только к новым/regenerated artifacts.

### Detail UI states

- `absent` -> `Create Audio`
- `generating` -> disabled `Creating Audio…`
- `ready` -> `Remove Audio`, `Play/Pause`, slim progress row
- `failed` -> `Retry` + error text

### Playback persistence

Desktop playback state хранится через `ArticleAudioControls` Web Audio path:

- active transport приходит через `ArticleAudioGatewayProvider`;
- decode/update path работает для `.wav` без специальных UI-веток;
- `pause`, `ended`, `unmount` сохраняют позицию;
- `ended` пишет `completed_at` и сбрасывает позицию на `0`.

### Legacy invalidation

Desktop artifacts, созданные старым backend contract, считаются disposable derived data:

- любой `format_version < 2` invalidates on read;
- cleanup удаляет legacy `.m4a`, `.aiff`, `.caf` alongside current `.wav`;
- stale `say` artifacts не переиспользуются после regenerate.

## iOS contract

### Rust FFI

`core-ffi` экспортирует:

```swift
prepareArticleSpeech(slug: String) -> FfiPreparedArticleSpeech
```

Swift не дублирует markdown-to-speech pipeline.

### Native services

iOS использует два локальных объекта:

- `ArticleAudioService`
  - resolve state
  - generate audio file
  - persist sidecar
  - delete artifacts
- `ArticleAudioController`
  - drive UI state
  - play / pause / resume
  - persist progress / completion

### Synthesis backend

- generation использует `AVSpeechSynthesizer.write`
- playback использует `AVAudioPlayer`
- voice выбирается best-effort по `language_tag`, fallback — system default

## Invalidation and cleanup

Audio artifacts удаляются при:

- source article edit, если изменился speech-relevant text;
- block deletion;
- explicit `Remove Audio`;
- stale sidecar, указывающем на отсутствующий audio file.

## Acceptance

- статья без аудио показывает только `Create Audio`
- после генерации появляются `Remove Audio` и `Play / Pause`
- `Remove Audio` удаляет локальное аудио и возвращает статью в `absent`
- reopening `Detail` resumes from saved position
- edit speech-relevant article content invalidates stale audio automatically
